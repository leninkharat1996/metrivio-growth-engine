import { writeAuditLog, type MetrivioDb, type JobHandler, type JobHandlerContext, type JobHandlerResult } from '@metrivio/core';
import { FollowUpDraftService } from '../follow-up/follow-up-draft-service.js';
import type { OutreachDraftService } from '../drafts/draft-store.js';
import { DueWorkDiscoveryService } from './due-work-discovery-service.js';
import { findActiveSequenceCandidates } from './candidate-discovery.js';
import { PREPARE_FOLLOWUP_DRAFTS_JOB_TYPE } from './job-types.js';

/**
 * Stage 6E, Section J/K — the `PREPARE_FOLLOWUP_DRAFTS` job. Orchestrates
 * Stage 6D's `FollowUpDraftService` exactly as-is (no duplicated sequence
 * logic, personalization, templates, or evidence gathering — Section J) and
 * then, ONLY for a freshly created `DRAFTED` draft, advances it one step
 * through the existing Stage 6A state machine to `PENDING_APPROVAL` via
 * `OutreachDraftService.submitForApproval()` — never to `APPROVED`
 * (Section K: automation must never manufacture approval).
 *
 * Idempotency (Section G): `generateFollowUpDraft()` itself is idempotent
 * (reuses an existing non-terminal draft rather than creating a second
 * one). This handler additionally guards `submitForApproval()` behind
 * `draft.status === 'DRAFTED'` — submitting an already-`PENDING_APPROVAL`,
 * `APPROVED`, or `REJECTED` draft a second time is skipped rather than
 * attempted, which would otherwise throw `InvalidDraftTransitionError` and
 * (worse) risk being mistaken for a real per-item failure. A rejected
 * draft is never resurrected; an approved draft's approval is never reset
 * — both are simply left untouched on a repeated run.
 *
 * Dry-run (Section D): reports what WOULD be drafted (via
 * `DueWorkDiscoveryService`, reusing the exact same eligibility path) and
 * creates nothing — no draft, no audit_log `outreach.draft.created` row, no
 * approval-state change of any kind.
 */
export class PrepareFollowUpDraftsHandler implements JobHandler {
  readonly jobType = PREPARE_FOLLOWUP_DRAFTS_JOB_TYPE;

  constructor(
    private readonly db: MetrivioDb,
    private readonly followUpDraftService: FollowUpDraftService,
    private readonly draftService: OutreachDraftService,
    private readonly discovery: DueWorkDiscoveryService
  ) {}

  async run(ctx: JobHandlerContext): Promise<JobHandlerResult> {
    if (ctx.dryRun) {
      return this.runDryRun(ctx);
    }

    const candidates = await findActiveSequenceCandidates(this.db, ctx.maxItems);
    let succeeded = 0;
    let failed = 0;
    let draftsAdvancedToPendingApproval = 0;
    const byOutcome: Record<string, number> = {};

    for (const candidate of candidates) {
      try {
        const result = await this.followUpDraftService.generateFollowUpDraft(candidate.prospectId, candidate.sequenceId);
        byOutcome[result.outcome] = (byOutcome[result.outcome] ?? 0) + 1;

        if (result.outcome === 'DRAFTED' && result.draft && result.draft.status === 'DRAFTED') {
          await this.draftService.submitForApproval(result.draft.id);
          draftsAdvancedToPendingApproval += 1;
          await writeAuditLog(this.db, {
            actor: 'system',
            actionType: 'automation.followup_draft.submitted_for_approval',
            entityType: 'outreach_draft',
            entityId: result.draft.id,
            dryRun: false,
            detail: { runId: ctx.runId, prospectId: candidate.prospectId, sequenceId: candidate.sequenceId },
          });
        }
        succeeded += 1;
      } catch (err) {
        failed += 1;
        await writeAuditLog(this.db, {
          actor: 'system',
          actionType: 'automation.followup_draft.failed',
          entityType: 'prospect',
          entityId: candidate.prospectId,
          dryRun: false,
          detail: { runId: ctx.runId, sequenceId: candidate.sequenceId, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    await ctx.updateCheckpoint({ lastRunByOutcome: byOutcome });
    return { itemsProcessed: candidates.length, itemsSucceeded: succeeded, itemsFailed: failed, detail: { byOutcome, draftsAdvancedToPendingApproval } };
  }

  private async runDryRun(ctx: JobHandlerContext): Promise<JobHandlerResult> {
    const { results } = await this.discovery.findDueFollowUps({ maxCandidates: ctx.maxItems, maxReplyChecks: ctx.maxItems });
    const wouldDraft = results.filter((r) => r.status === 'ELIGIBLE');
    const byStatus: Record<string, number> = {};
    for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

    for (const candidate of wouldDraft) {
      await writeAuditLog(this.db, {
        actor: 'system',
        actionType: 'automation.followup_draft.would_create',
        entityType: 'prospect',
        entityId: candidate.prospectId,
        dryRun: true,
        detail: { runId: ctx.runId, sequenceId: candidate.sequenceId },
      });
    }

    const failed = results.filter((r) => r.status === 'ERROR').length;
    return {
      itemsProcessed: results.length,
      itemsSucceeded: results.length - failed,
      itemsFailed: failed,
      detail: { byStatus, wouldCreateDraftCount: wouldDraft.length },
    };
  }
}
