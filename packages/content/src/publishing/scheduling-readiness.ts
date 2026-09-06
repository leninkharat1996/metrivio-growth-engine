import { writeAuditLog, type MetrivioDb } from '@metrivio/core';
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
}
