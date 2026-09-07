import { and, eq } from 'drizzle-orm';
import { schema, writeAuditLog, type MetrivioDb } from '@metrivio/core';
import { ContentDraftService } from '../drafts/content-draft-service.js';

/**
 * Stage 7, Section X/Y — scheduling readiness, and NOTHING beyond it.
 *
 * Publishing-transport verification status (researched this stage, see
 * RISK_REGISTER.md's Stage 7 section for the full record): NEITHER
 * `XManagerWriteAdapter` NOR `XActionsWriteAdapter` (`packages/adapters`)
 * has ever been wired to a real network call — both are still exactly the
 * Stage 1 boundary stubs (`postTweet`/`postThread`/`replyTo` all throw
 * `NotImplementedInStage1Error`). The vendored `xactions-http` subtree
 * (`packages/adapters/vendor/xactions-http/`) — the same one Stage 6B-R
 * verified and wired up for DM sending — was never extended with a
 * `tweet.js`/post-publishing module at all; only `dm.js` (send + inbox
 * read) exists. No commit, source path, payload format, or test suite for
 * public-post publishing has been inspected or verified by this
 * repository at the same standard Stage 6B-R applied to DMs. Per
 * instruction: this gap is documented, not silently substituted with a
 * claim of capability.
 *
 * Because of that, this module deliberately stops at marking an
 * ALREADY-APPROVED content draft as "ready to schedule" — a pure
 * audit-log marker, never a network call, never even a claim that
 * scheduling infrastructure (a queue, a cron) exists. `SendApprovedDraftService`
 * (Stage 6B) remains the only stage in this codebase that has ever been
 * verified to perform a real X write, and it is for DMs, not posts.
 */
export interface SchedulingReadinessResult {
  ready: boolean;
  reason: string;
}

/**
 * Stage 8, Section X — a draft's scheduling state, folded from its audit
 * log exactly like `ContentDraftService.getApprovalIntegrity()` folds
 * approval state. Deliberately a SEPARATE audit-event namespace
 * (`content.draft.scheduled_for`) from content mutation
 * (`content.draft.body_changed`) and approval (`content.draft.approved`):
 * changing when a draft is scheduled to publish must never, by itself,
 * invalidate its approval, and changing its approved content must never be
 * satisfied merely by rescheduling. See `PublishApprovedContentService` for
 * where both checks are combined.
 */
export interface SchedulingState {
  readyForScheduling: boolean;
  scheduledFor: string | null;
}

export class SchedulingReadinessService {
  private readonly drafts: ContentDraftService;

  constructor(private readonly db: MetrivioDb) {
    this.drafts = new ContentDraftService(db);
  }

  /**
   * Marks an APPROVED draft as scheduling-ready. Requires explicit human
   * approval to already exist (Section X: "only after explicit approval")
   * — never manufactures it. Never contacts X, never claims a post was
   * published or even queued in a real scheduler.
   */
  async markReadyForScheduling(draftId: string): Promise<SchedulingReadinessResult> {
    const draft = await this.drafts.getDraft(draftId);
    if (!draft) {
      return { ready: false, reason: `no content draft found with id ${draftId}` };
    }
    if (draft.status !== 'APPROVED') {
      return { ready: false, reason: `draft is in state "${draft.status}", not APPROVED — scheduling readiness requires explicit prior approval` };
    }

    await writeAuditLog(this.db, {
      actor: 'human',
      actionType: 'content.draft.scheduling_ready',
      entityType: 'content_draft',
      entityId: draftId,
      detail: { note: 'marked ready for scheduling — no verified X publishing transport exists; this is a readiness marker only, never a publish action' },
    });

    return { ready: true, reason: 'draft is APPROVED and marked ready for scheduling — actual publishing requires a future, separately verified transport' };
  }

  /**
   * Records (or updates) when a draft is due to be published. Requires
   * `markReadyForScheduling()` to have already succeeded for this draft.
   * Calling this again for the same draft (changing the timestamp) writes
   * a new audit event but is deliberately independent of approval state —
   * it never touches `content.draft.approved`/`content.draft.body_changed`,
   * so rescheduling a draft never silently re-approves or invalidates it.
   */
  async scheduleFor(draftId: string, scheduledForIso: string, scheduledBy?: string): Promise<SchedulingState> {
    const state = await this.getSchedulingState(draftId);
    if (!state.readyForScheduling) {
      throw new Error(`Cannot schedule content draft ${draftId}: not marked ready for scheduling — call markReadyForScheduling() first`);
    }

    await writeAuditLog(this.db, {
      actor: scheduledBy ? 'human' : 'system',
      actionType: 'content.draft.scheduled_for',
      entityType: 'content_draft',
      entityId: draftId,
      detail: { scheduledFor: scheduledForIso, scheduledBy },
    });

    return this.getSchedulingState(draftId);
  }

  /** Folds this draft's audit log into its current scheduling state — never trusts an in-memory cache. */
  async getSchedulingState(draftId: string): Promise<SchedulingState> {
    const rows = await this.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entityType, 'content_draft'), eq(schema.auditLog.entityId, draftId)));

    let readyForScheduling = false;
    let scheduledFor: string | null = null;
    for (const row of rows) {
      if (row.actionType === 'content.draft.scheduling_ready') {
        readyForScheduling = true;
      } else if (row.actionType === 'content.draft.scheduled_for' && row.detail) {
        const detail = JSON.parse(row.detail) as { scheduledFor?: string };
        if (detail.scheduledFor) scheduledFor = detail.scheduledFor;
      }
    }

    return { readyForScheduling, scheduledFor };
  }
}
