/**
 * @metrivio/outreach — Stage 6A (Outreach Foundation) + Stage 6B (X Write /
 * Send Adapter) + Stage 6B-R (verified DM transport) + Stage 6C (Reply
 * Detection / Follow-Up Eligibility Foundation).
 *
 * Stage 6A established:
 *   Qualified Prospect -> Outreach Eligibility -> Personalization Evidence
 *   -> Message Draft -> Human Approval
 * Stage 6B/6B-R added exactly one more step, and only for an already-
 * APPROVED draft:
 *   APPROVED DRAFT -> SAFE SINGLE X SEND -> AUDIT/RESULT
 * (`send/send-service.ts`'s `SendApprovedDraftService`) — a verified,
 * real (though narrow) X write, per RISK_REGISTER.md's Stage 6B-R section.
 *
 * Stage 6C adds the machinery required for follow-ups WITHOUT sending
 * any: X conversation/reply detection -> outreach state update -> follow-
 * up eligibility calculation. `follow-up/reply-detection-service.ts`'s
 * `ReplyDetectionService` is entirely read-only (it never calls
 * `XSendAdapter` or anything write-capable); `follow-up/follow-up-
 * eligibility.ts`'s `evaluateFollowUpEligibility()` only ever answers
 * "would a follow-up be eligible right now" — nothing in this package
 * sends a follow-up, schedules one, or runs autonomously. See
 * RISK_REGISTER.md's Stage 6C section for the full design record.
 *
 * Scoring and outreach remain separate: this package reads `icp_scores`
 * rows (Stage 3's output) as one eligibility input, but never recomputes,
 * reinterprets, or overrides a score. `packages/core/src/scoring/` is not
 * imported, referenced, or modified anywhere in this package.
 */
export * from './eligibility/eligibility.js';
export * from './eligibility/eligibility-service.js';
export * from './state-machine/draft-state-machine.js';
export * from './personalization/personalization-candidates.js';
export * from './drafts/message-draft.js';
export * from './drafts/message-templates.js';
export * from './drafts/draft-store.js';
export * from './drafts/draft-generation-service.js';
export * from './send/send-outcome.js';
export * from './send/send-service.js';
export * from './send/manual-sequence.js';
export * from './follow-up/reply-direction.js';
export * from './follow-up/opt-out-classifier.js';
export * from './follow-up/reply-state.js';
export * from './follow-up/follow-up-eligibility.js';
export * from './follow-up/reply-detection-service.js';
export * from './follow-up/follow-up-eligibility-service.js';
