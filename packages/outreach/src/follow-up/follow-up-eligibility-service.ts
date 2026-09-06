import { and, desc, eq, inArray } from 'drizzle-orm';
import { KillSwitch, SystemConfigService, schema, type MetrivioDb } from '@metrivio/core';
import { ReplyDetectionService } from './reply-detection-service.js';
import { evaluateFollowUpEligibility, type FollowUpEligibilityResult, type FollowUpTimingInput } from './follow-up-eligibility.js';
import type { ReplyState } from './reply-state.js';

/**
 * The I/O layer around `evaluateFollowUpEligibility()` (Stage 6C, Section
 * F/G) — always runs a fresh `ReplyDetectionService.detectReplies()` check
 * first (Section H's critical invariant: eligibility must never be
 * computed from stale reply data), then, only when that comes back
 * `NO_REPLY`, gathers sequence timing/dedup state from `sequences`/
 * `outreach_messages` — both read-only, reusing the exact schema/index
 * already established by Stage 6B, no new tables.
 *
 * This class never calls `XSendAdapter` and never writes an
 * `outreach_messages` row — it only ever answers the eligibility
 * question.
 */
export class FollowUpEligibilityService {
  private readonly killSwitch: KillSwitch;

  constructor(
    private readonly db: MetrivioDb,
    private readonly replyDetectionService: ReplyDetectionService
  ) {
    this.killSwitch = new KillSwitch(new SystemConfigService(this.db));
  }

  async evaluate(prospectId: string, sequenceId: string): Promise<FollowUpEligibilityResult> {
    const killSwitchActive = await this.killSwitch.isActive();

    let replyState: ReplyState = 'UNKNOWN';
    if (!killSwitchActive) {
      const detection = await this.replyDetectionService.detectReplies(prospectId);
      replyState = detection.replyState;
    }

    let nextStepAlreadySent = false;
    let timing: FollowUpTimingInput | null = null;

    if (!killSwitchActive && replyState === 'NO_REPLY') {
      const lastSentRows = await this.db
        .select()
        .from(schema.outreachMessages)
        .where(and(eq(schema.outreachMessages.prospectId, prospectId), eq(schema.outreachMessages.sequenceId, sequenceId), eq(schema.outreachMessages.status, 'sent')))
        .orderBy(desc(schema.outreachMessages.sequenceStepOrder))
        .limit(1);
      const lastSent = lastSentRows[0];

      if (lastSent?.sentAt) {
        const nextStepOrder = lastSent.sequenceStepOrder + 1;
        const sequenceRows = await this.db.select().from(schema.sequences).where(eq(schema.sequences.id, sequenceId)).limit(1);
        const sequenceRow = sequenceRows[0];
        const steps = sequenceRow ? (JSON.parse(sequenceRow.steps) as Array<{ step_order: number; day_offset: number }>) : [];
        const nextStep = steps.find((s) => s.step_order === nextStepOrder);

        if (nextStep) {
          const dedupRows = await this.db
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
          nextStepAlreadySent = dedupRows.length > 0;
          timing = { lastSentAt: lastSent.sentAt, nextStepDayOffset: nextStep.day_offset, now: new Date().toISOString() };
        }
      }
    }

    return evaluateFollowUpEligibility({ replyState, killSwitchActive, nextStepAlreadySent, timing });
  }
}
