import { and, desc, eq, inArray } from 'drizzle-orm';
import { schema, type MetrivioDb } from '@metrivio/core';

/**
 * Shared "which sequence step comes next" lookup (Stage 6D, Section F).
 *
 * This is a read-only helper against the exact same `sequences`/
 * `outreach_messages` schema Stage 6C's `FollowUpEligibilityService`
 * already read inline — it is extracted here so that Stage 6D's
 * `FollowUpDraftService` can also learn "what is the next step, and does
 * one even exist" without a second, drifting implementation of this
 * lookup. It deliberately does NOT decide eligibility or do any timing
 * math — that stays solely inside `evaluateFollowUpEligibility()`
 * (Stage 6C), never duplicated here. This module only ever answers "what
 * step comes next, per the schema" and "has it already been attempted."
 */
export interface SequenceStepInfo {
  lastSentStepOrder: number;
  lastSentAt: string;
  nextStepOrder: number;
  nextStepDayOffset: number;
  /** True when `nextStepOrder` is the highest `step_order` defined in this sequence — used by `FollowUpDraftService` to pick the "final close" message intent. */
  isLastStep: boolean;
}

export interface SequenceStepLookupResult {
  /** Non-null exactly when a prior sent step exists AND a next-step definition exists for it. */
  info: SequenceStepInfo | null;
  /** True when an `outreach_messages` row already exists (status queued/sent) at the next step. */
  nextStepAlreadySent: boolean;
  /** True when there is no prior *sent* message in this sequence for this prospect at all. */
  noPriorSentMessage: boolean;
  /** True specifically when a prior sent message exists, but `sequences.steps` defines no next step after it. */
  noNextStepDefined: boolean;
}

export async function findNextSequenceStep(db: MetrivioDb, prospectId: string, sequenceId: string): Promise<SequenceStepLookupResult> {
  const lastSentRows = await db
    .select()
    .from(schema.outreachMessages)
    .where(and(eq(schema.outreachMessages.prospectId, prospectId), eq(schema.outreachMessages.sequenceId, sequenceId), eq(schema.outreachMessages.status, 'sent')))
    .orderBy(desc(schema.outreachMessages.sequenceStepOrder))
    .limit(1);
  const lastSent = lastSentRows[0];

  if (!lastSent?.sentAt) {
    return { info: null, nextStepAlreadySent: false, noPriorSentMessage: true, noNextStepDefined: false };
  }

  const nextStepOrder = lastSent.sequenceStepOrder + 1;
  const sequenceRows = await db.select().from(schema.sequences).where(eq(schema.sequences.id, sequenceId)).limit(1);
  const sequenceRow = sequenceRows[0];
  const steps = sequenceRow ? (JSON.parse(sequenceRow.steps) as Array<{ step_order: number; day_offset: number }>) : [];
  const nextStep = steps.find((s) => s.step_order === nextStepOrder);

  if (!nextStep) {
    return { info: null, nextStepAlreadySent: false, noPriorSentMessage: false, noNextStepDefined: true };
  }

  const dedupRows = await db
    .select()
    .from(schema.outreachMessages)
    .where(
      and(
        eq(schema.outreachMessages.prospectId, prospectId),
        eq(schema.outreachMessages.sequenceId, sequenceId),
        eq(schema.outreachMessages.sequenceStepOrder, nextStepOrder),
        inArray(schema.outreachMessages.status, ['queued', 'sent'])
      )
    )
    .limit(1);

  const maxStepOrder = steps.reduce((max, s) => Math.max(max, s.step_order), nextStepOrder);

  return {
    info: {
      lastSentStepOrder: lastSent.sequenceStepOrder,
      lastSentAt: lastSent.sentAt,
      nextStepOrder,
      nextStepDayOffset: nextStep.day_offset,
      isLastStep: nextStepOrder >= maxStepOrder,
    },
    nextStepAlreadySent: dedupRows.length > 0,
    noPriorSentMessage: false,
    noNextStepDefined: false,
  };
}
