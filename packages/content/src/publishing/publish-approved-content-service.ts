import { eq } from 'drizzle-orm';
import {
  schema,
  writeAuditLog,
  KillSwitch,
  SystemConfigService,
  type MetrivioDb,
  type XPublishAdapter,
  type createLogger,
} from '@metrivio/core';
import { ContentDraftService } from '../drafts/content-draft-service.js';
import { SchedulingReadinessService } from './scheduling-readiness.js';
import { ContentSignalStore } from '../signals/content-signal-store.js';
import { validateContentDraft } from '../drafts/content-validation.js';
import { checkXPostConstraints } from './x-post-constraints.js';
import { OwnContentPerformanceService } from '../own-content/own-content-performance-service.js';

/**
 * Stage 8, Sections C-J — the ONE narrow boundary through which an approved
 * content draft can ever become a real, public X post. This is deliberately
 * NOT a generic "publish this string" API: it only ever operates on a
 * `content_drafts.id` it loads itself (Section E.1: "load authoritative
 * draft" — never trusts a caller-supplied body), and every one of the 10
 * numbered responsibilities below runs, in order, on every call:
 *
 *   1. Load the authoritative draft (never trust an in-memory/caller copy).
 *   2. Verify draft state is APPROVED.
 *   3. Verify approval integrity (Section F — re-derived from the audit
 *      log, not a cached flag; blocks if content changed since approval).
 *   4. Verify scheduling readiness/due-ness (Section X).
 *   5. Idempotency check (Section L — content_drafts.x_manager_post_id).
 *   6. Revalidate content (Section G — Stage 7's validator + Stage 8's
 *      X-length constraint, re-run fresh, never trusting a stale
 *      quality_check_status).
 *   7. Check the kill switch (Section I — immediately before the boundary).
 *   8. Check the publishing mode (Section J — dry_run/approval_required/
 *      autonomous, autonomous fail-closed without explicit confirmation).
 *   9. Enforce publishing limits (Section K — reuses existing
 *      `content.automation_max_items_per_run`-style config, specifically
 *      `daily_limit_posts`, never a second rate-limit system).
 *  10. Call `XPublishAdapter.publishPost()` and persist/audit the result
 *      (Section M — `PublishResult` is always PUBLISHED/BLOCKED/FAILED/
 *      UNKNOWN, and a network-ambiguous outcome is UNKNOWN, never silently
 *      FAILED or PUBLISHED).
 *
 * Never called with an arbitrary string: the only entry point is
 * `publishDraft(draftId)`.
 */

export const PUBLISH_RESULT_OUTCOMES = ['PUBLISHED', 'BLOCKED', 'FAILED', 'UNKNOWN'] as const;
export type PublishResultOutcome = (typeof PUBLISH_RESULT_OUTCOMES)[number];

export interface PublishResult {
  outcome: PublishResultOutcome;
  reason: string;
  draftId: string;
  /** Only present on a genuinely successful publish, taken directly from the adapter's response — never fabricated. */
  xPostId?: string;
  publishedAt?: string;
  /** True whenever this call never reached `XPublishAdapter` (kill switch, dry-run mode, validation failure, not-due, already-published, limit reached, autonomous-not-confirmed, etc). */
  dryRun?: boolean;
}

const ACTION_TYPES = {
  published: 'content.publish.published',
  blocked: 'content.publish.blocked',
  failed: 'content.publish.failed',
  unknown: 'content.publish.unknown',
} as const;

function auditActionFor(outcome: PublishResultOutcome): string {
  switch (outcome) {
    case 'PUBLISHED':
      return ACTION_TYPES.published;
    case 'BLOCKED':
      return ACTION_TYPES.blocked;
    case 'FAILED':
      return ACTION_TYPES.failed;
    case 'UNKNOWN':
      return ACTION_TYPES.unknown;
  }
}

export class PublishApprovedContentService {
  private readonly drafts: ContentDraftService;
  private readonly scheduling: SchedulingReadinessService;
  private readonly signals: ContentSignalStore;
  private readonly config: SystemConfigService;
  private readonly killSwitch: KillSwitch;
  private readonly performance: OwnContentPerformanceService;

  constructor(
    private readonly db: MetrivioDb,
    private readonly adapter: XPublishAdapter,
    private readonly logger?: ReturnType<typeof createLogger>
  ) {
    this.drafts = new ContentDraftService(db, logger);
    this.scheduling = new SchedulingReadinessService(db);
    this.signals = new ContentSignalStore(db);
    this.config = new SystemConfigService(db);
    this.killSwitch = new KillSwitch(this.config);
    this.performance = new OwnContentPerformanceService(db, logger);
  }

  async publishDraft(draftId: string, options: { dryRun?: boolean } = {}): Promise<PublishResult> {
    // 1. Load the authoritative draft.
    const draft = await this.drafts.getDraft(draftId);
    if (!draft) {
      return this.finish({ outcome: 'BLOCKED', reason: `no content draft found with id ${draftId}`, draftId, dryRun: true });
    }

    // 2. Verify draft state is APPROVED.
    if (draft.status !== 'APPROVED') {
      return this.finish({ outcome: 'BLOCKED', reason: `draft is in state "${draft.status}", not APPROVED — publishing requires explicit prior approval`, draftId, dryRun: true });
    }

    // 3. Verify approval integrity — re-derived fresh from the audit log
    // every call, never a cached/in-memory flag (Section F).
    const integrity = await this.drafts.getApprovalIntegrity(draftId);
    if (!integrity.isApproved) {
      return this.finish({ outcome: 'BLOCKED', reason: 'draft has no recorded approval', draftId, dryRun: true });
    }
    if (integrity.contentChangedSinceApproval) {
      return this.finish({
        outcome: 'BLOCKED',
        reason: 'draft content changed after it was approved — the existing approval no longer covers the current body; re-approval is required before publishing',
        draftId,
        dryRun: true,
      });
    }

    // 4. Verify scheduling readiness and due-ness (Section X).
    const schedulingState = await this.scheduling.getSchedulingState(draftId);
    if (!schedulingState.readyForScheduling) {
      return this.finish({ outcome: 'BLOCKED', reason: 'draft has not been marked ready for scheduling', draftId, dryRun: true });
    }
    if (schedulingState.scheduledFor && new Date(schedulingState.scheduledFor).getTime() > Date.now()) {
      return this.finish({ outcome: 'BLOCKED', reason: `draft is scheduled for ${schedulingState.scheduledFor}, which is in the future — not yet due`, draftId, dryRun: true });
    }

    // 5. Idempotency check (Section L) — content_drafts.x_manager_post_id
    // is the existing, zero-migration column for exactly this purpose.
    const draftRow = await this.getDraftRow(draftId);
    if (draftRow?.xManagerPostId) {
      return this.finish({
        outcome: 'PUBLISHED',
        reason: 'already published previously (idempotent no-op — content_drafts.x_manager_post_id already set)',
        draftId,
        xPostId: draftRow.xManagerPostId,
      });
    }

    // 6. Revalidate content fresh (Section G) — never trust a stale
    // quality_check_status, and additionally enforce Stage 8's verified
    // X-length constraint (Stage 7's own validator has no length rule).
    const relatedExcerpts = (await this.signals.list({ limit: 500 })).map((s) => s.excerpt).filter((e): e is string => !!e);
    const revalidation = validateContentDraft(draft.body, relatedExcerpts);
    if (revalidation.status === 'flagged') {
      return this.finish({ outcome: 'BLOCKED', reason: `content revalidation failed: ${revalidation.notes.join('; ')}`, draftId, dryRun: true });
    }
    const lengthCheck = checkXPostConstraints(draft.body);
    if (!lengthCheck.withinLimit) {
      return this.finish({
        outcome: 'BLOCKED',
        reason: `content exceeds the verified X post length limit (${lengthCheck.weightedLength}/${lengthCheck.maxWeightedLength} weighted characters)`,
        draftId,
        dryRun: true,
      });
    }

    // 7. Kill switch — checked immediately before the publish boundary.
    if (await this.killSwitch.isActive()) {
      return this.finish({ outcome: 'BLOCKED', reason: 'the kill switch is active', draftId, dryRun: true });
    }

    // 8. Publishing mode (Section J).
    const mode = await this.config.getAutomationMode('content.publishing');
    let dryRun = options.dryRun ?? false;
    if (mode === 'dry_run') {
      dryRun = true; // mode always wins — a caller cannot force a real publish out of dry_run mode.
    } else if (mode === 'autonomous') {
      const confirmed = await this.config.isContentPublishingAutonomousEnabled();
      if (!confirmed && !dryRun) {
        return this.finish({
          outcome: 'BLOCKED',
          reason: 'automation mode is "autonomous" but content.publishing.autonomous_enabled is not explicitly set to true — failing closed',
          draftId,
          dryRun: true,
        });
      }
    }
    // mode === 'approval_required': proceeds — the draft already carries a real human approval (steps 2/3 above), which is exactly what this mode requires.

    // 9. Enforce publishing limits (Section K) — reuses the existing
    // daily_limit_posts config key (previously defined, never wired to
    // anything), never a second rate-limit system.
    if (!dryRun) {
      const dailyLimit = await this.config.getDailyLimit('posts');
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const publishedToday = await this.countPublishedSince(since);
      if (publishedToday >= dailyLimit) {
        return this.finish({ outcome: 'BLOCKED', reason: `the configured daily post limit (${dailyLimit}) has already been reached in the last 24 hours`, draftId, dryRun: true });
      }
    }

    if (dryRun) {
      return this.finish({
        outcome: 'BLOCKED',
        reason: `DRY_RUN: every validation/approval/scheduling/kill-switch/limit check passed — would publish ${lengthCheck.weightedLength}-weighted-character text; no network call was made`,
        draftId,
        dryRun: true,
      });
    }

    // 10. Call the adapter and persist/audit the result.
    return this.performRealPublish(draftId, draft.body);
  }

  private async performRealPublish(draftId: string, text: string): Promise<PublishResult> {
    try {
      const result = await this.adapter.publishPost({ text });

      await this.db
        .update(schema.contentDrafts)
        .set({ xManagerPostId: result.xPostId, updatedAt: new Date().toISOString() })
        .where(eq(schema.contentDrafts.id, draftId));

      await this.performance.ingestSnapshot({ postId: result.xPostId, draftId, text: result.publishedText });

      return this.finish({ outcome: 'PUBLISHED', reason: 'published successfully', draftId, xPostId: result.xPostId, publishedAt: result.publishedAt });
    } catch (err) {
      return this.finish({ outcome: this.classifyPublishError(err), reason: err instanceof Error ? err.message : String(err), draftId });
    }
  }

  /**
   * Maps the adapter's error taxonomy to a `PublishResult` outcome. A
   * network-level failure is UNKNOWN, never FAILED — Stage 8's core
   * requirement: whether X actually created the post cannot be determined
   * from a network error alone, so it must never be silently treated as a
   * definitive failure (which could cause an unsafe duplicate retry) or a
   * success. `XPublishUnexpectedError` (a malformed/unrecognized response)
   * is treated the same way, for the same reason — an unrecognized success
   * response could still mean X accepted the post.
   */
  private classifyPublishError(err: unknown): PublishResultOutcome {
    const name = err instanceof Error ? err.name : '';
    if (name === 'XPublishNetworkError' || name === 'XPublishUnexpectedError') {
      return 'UNKNOWN';
    }
    // Authentication/rate-limit/invalid-content are all definitive,
    // non-ambiguous rejections — X never created the post.
    return 'FAILED';
  }

  private async getDraftRow(draftId: string): Promise<typeof schema.contentDrafts.$inferSelect | undefined> {
    const rows = await this.db.select().from(schema.contentDrafts).where(eq(schema.contentDrafts.id, draftId)).limit(1);
    return rows[0];
  }

  private async countPublishedSince(sinceIso: string): Promise<number> {
    const rows = await this.db.select().from(schema.contentDrafts).where(eq(schema.contentDrafts.approvalStatus, 'approved'));
    return rows.filter((r) => r.xManagerPostId && r.updatedAt >= sinceIso).length;
  }

  private async finish(result: PublishResult): Promise<PublishResult> {
    await writeAuditLog(this.db, {
      actor: 'system',
      actionType: auditActionFor(result.outcome),
      entityType: 'content_draft',
      entityId: result.draftId,
      dryRun: result.dryRun ?? false,
      detail: {
        outcome: result.outcome,
        reason: result.reason,
        xPostId: result.xPostId,
        timestamp: new Date().toISOString(),
      },
    });
    this.logger?.info({ draftId: result.draftId, outcome: result.outcome }, 'content_publish.result');
    return result;
  }
}
