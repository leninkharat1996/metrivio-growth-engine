/**
 * Deterministic reply-state derivation (Stage 6C, Section D). Pure
 * function — no I/O. `ReplyDetectionService` gathers the inputs (stored
 * prospect/conversation state plus the outcome of a detection attempt)
 * and calls this to decide the single reply-state value.
 *
 * `UNKNOWN` is a first-class outcome, never collapsed into `NO_REPLY`: a
 * failed/blocked detection attempt means "we don't know," not "they
 * haven't replied" (Section D: "a failed API request is not 'no reply'").
 */
export const REPLY_STATES = ['NO_REPLY', 'REPLIED', 'UNKNOWN', 'STOPPED', 'OPTED_OUT'] as const;
export type ReplyState = (typeof REPLY_STATES)[number];

export interface ReplyStateInput {
  /** False when the detection attempt itself failed or was blocked (kill switch, network/auth error) — forces UNKNOWN regardless of any other input. */
  detectionSucceeded: boolean;
  /** True when at least one message has been positively attributed to the prospect (this run or a prior one) — see `reply-direction.ts`. */
  hasProspectMessage: boolean;
  /** True when any prospect message (this run or a prior one) matched `classifyOptOutIntent`. */
  optOutDetected: boolean;
  /** Mirrors `prospects.outreach_status`'s stopped_* values, or `conversations.state === 'stopped'` — a stop from any source, not just a reply. */
  prospectStopped: boolean;
}

export interface ReplyStateResult {
  state: ReplyState;
  reason: string;
}

export function deriveReplyState(input: ReplyStateInput): ReplyStateResult {
  if (!input.detectionSucceeded) {
    return { state: 'UNKNOWN', reason: 'the detection attempt did not succeed (blocked or failed) — this is never treated as "no reply"' };
  }
  if (input.optOutDetected) {
    return { state: 'OPTED_OUT', reason: 'an inbound message matched an explicit no-further-contact phrase' };
  }
  if (input.prospectStopped) {
    return { state: 'STOPPED', reason: 'the prospect is in a stopped state independent of any reply' };
  }
  if (input.hasProspectMessage) {
    return { state: 'REPLIED', reason: 'at least one message has been positively attributed to the prospect' };
  }
  return { state: 'NO_REPLY', reason: 'detection succeeded and found no message attributable to the prospect' };
}
