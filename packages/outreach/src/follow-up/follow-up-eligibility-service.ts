import { KillSwitch, SystemConfigService, type MetrivioDb } from '@metrivio/core';
import { ReplyDetectionService } from './reply-detection-service.js';
import { evaluateFollowUpEligibility, type FollowUpEligibilityResult, type FollowUpTimingInput } from './follow-up-eligibility.js';
import { findNextSequenceStep } from './sequence-step.js';
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
      const lookup = await findNextSequenceStep(this.db, prospectId, sequenceId);
      nextStepAlreadySent = lookup.nextStepAlreadySent;
      if (lookup.info) {
        timing = { lastSentAt: lookup.info.lastSentAt, nextStepDayOffset: lookup.info.nextStepDayOffset, now: new Date().toISOString() };
      }
    }

    return evaluateFollowUpEligibility({ replyState, killSwitchActive, nextStepAlreadySent, timing });
  }
}
