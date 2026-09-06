import { and, eq } from 'drizzle-orm';
import { schema, type MetrivioDb, type createLogger } from '@metrivio/core';
import type { DraftGenerationService } from '../drafts/draft-generation-service.js';
import type { GenerateDraftResult } from '../drafts/draft-store.js';
import type { FollowUpIntent } from '../drafts/message-draft.js';
import { FollowUpEligibilityService } from './follow-up-eligibility-service.js';
import { findNextSequenceStep } from './sequence-step.js';

/**
 * Stage 6D orchestrator: Follow-up Eligibility -> Follow-up Personalization
 * -> Follow-up Draft. This is the only place Stage 6D decides "should a
 * follow-up draft be created" and "what intent should it use" — it never
 * recomputes reply state or timing itself (Section B: `FollowUpEligibilityService`,
 * Stage 6C, is the sole authority), and it never sends anything (drafting
 * only; sending remains `SendApprovedDraftService`'s job after human
 * approval).
 */
export const FOLLOW_UP_DRAFT_OUTCOMES = ['DRAFTED', 'NOT_DUE', 'REPLIED', 'STOPPED', 'OPTED_OUT', 'UNKNOWN', 'ALREADY_SENT', 'BLOCKED', 'NO_NEXT_STEP'] as const;
export type FollowUpDraftOutcome = (typeof FOLLOW_UP_DRAFT_OUTCOMES)[number];

export interface FollowUpDraftResult {
  outcome: FollowUpDraftOutcome;
  reason: string;
  draft?: GenerateDraftResult['draft'];
  created?: boolean;
}

interface OriginalMessageContext {
  outreachMessageId: string;
  excludeEvidenceId?: string;
}

export class FollowUpDraftService {
  constructor(
    private readonly db: MetrivioDb,
    private readonly draftGenerationService: DraftGenerationService,
    private readonly eligibilityService: FollowUpEligibilityService,
    private readonly logger?: ReturnType<typeof createLogger>
  ) {}

  async generateFollowUpDraft(prospectId: string, sequenceId: string): Promise<FollowUpDraftResult> {
    // B. Stage 6C is the sole authority on eligibility — no timing/reply
    // logic is duplicated here.
    const eligibility = await this.eligibilityService.evaluate(prospectId, sequenceId);

    if (eligibility.status !== 'ELIGIBLE') {
      // F. Distinguish "no next-step definition exists" (NO_NEXT_STEP) from
      // every other UNKNOWN cause (failed reply detection, no prior sent
      // message at all) — a Stage-6D-local distinction only, never a change
      // to Stage 6C's own UNKNOWN contract.
      if (eligibility.status === 'UNKNOWN') {
        const lookup = await findNextSequenceStep(this.db, prospectId, sequenceId);
        if (lookup.noNextStepDefined) {
          return { outcome: 'NO_NEXT_STEP', reason: 'no next-step definition exists in this sequence after the most recently sent step' };
        }
      }
      return { outcome: eligibility.status, reason: eligibility.reason };
    }

    const lookup = await findNextSequenceStep(this.db, prospectId, sequenceId);
    if (!lookup.info) {
      // Eligibility said ELIGIBLE but the step lookup can't locate the
      // step it was eligible for — should be unreachable, but fail closed
      // rather than draft against unknown step data.
      return { outcome: 'NO_NEXT_STEP', reason: 'eligibility was ELIGIBLE but no next-step definition could be resolved' };
    }

    const followUpIntent = this.pickIntent(lookup.info.nextStepOrder, lookup.info.isLastStep);
    const originalContext = await this.loadOriginalMessageContext(prospectId, sequenceId, lookup.info.lastSentStepOrder);

    const { prospect, evidenceRows, painSignals, technologyDetections } = await this.draftGenerationService.gatherPersonalizationInputs(prospectId);

    const result = await this.draftGenerationService.drafts.generateDraft({
      prospectId,
      displayName: prospect.displayName,
      companyName: prospect.companyName,
      evidenceRows,
      painSignals,
      technologyDetections,
      followUp: {
        sequenceId,
        sequenceStepOrder: lookup.info.nextStepOrder,
        followUpIntent,
        parentOutreachMessageId: originalContext?.outreachMessageId,
        excludeEvidenceId: originalContext?.excludeEvidenceId,
      },
    });

    this.logger?.info({ prospectId, sequenceId, followUpIntent, created: result.created }, 'follow_up_draft.generated');
    return { outcome: 'DRAFTED', reason: 'follow-up draft generated', draft: result.draft, created: result.created };
  }

  /** first follow-up -> clarification, subsequent -> reminder, the final defined step -> final_close (Section E/F). */
  private pickIntent(nextStepOrder: number, isLastStep: boolean): FollowUpIntent {
    if (isLastStep) return 'final_close';
    const followUpNumber = nextStepOrder - 1;
    return followUpNumber <= 1 ? 'clarification' : 'reminder';
  }

  /** Looks up the original sent message this follow-up responds to, so the new draft excludes its evidenceId (Section D: "a new verified observation") and carries `parentOutreachMessageId` (Section A). */
  private async loadOriginalMessageContext(prospectId: string, sequenceId: string, lastSentStepOrder: number): Promise<OriginalMessageContext | undefined> {
    const rows = await this.db
      .select()
      .from(schema.outreachMessages)
      .where(
        and(
          eq(schema.outreachMessages.prospectId, prospectId),
          eq(schema.outreachMessages.sequenceId, sequenceId),
          eq(schema.outreachMessages.sequenceStepOrder, lastSentStepOrder),
          eq(schema.outreachMessages.status, 'sent')
        )
      )
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;

    let draftId: string | undefined;
    if (row.personalizationBasis) {
      try {
        const parsed = JSON.parse(row.personalizationBasis) as { draftId?: string };
        draftId = parsed.draftId;
      } catch {
        draftId = undefined;
      }
    }

    let excludeEvidenceId: string | undefined;
    if (draftId) {
      const originalDraft = await this.draftGenerationService.drafts.getDraft(draftId);
      excludeEvidenceId = originalDraft?.selectedHook?.evidenceId;
    }

    return { outreachMessageId: row.id, excludeEvidenceId };
  }
}
