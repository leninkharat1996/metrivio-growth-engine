/**
 * @metrivio/outreach — Stage 6A (Outreach Foundation) + Stage 6B (X Write /
 * Send Adapter).
 *
 * Stage 6A established:
 *   Qualified Prospect -> Outreach Eligibility -> Personalization Evidence
 *   -> Message Draft -> Human Approval
 * Stage 6B adds exactly one more step, and only for an already-APPROVED
 * draft:
 *   APPROVED DRAFT -> SAFE SINGLE X SEND -> AUDIT/RESULT
 * (`send/send-service.ts`'s `SendApprovedDraftService`). There is no batch
 * send, no scheduler, no autonomous queue, and no automatic retry anywhere
 * in this package — `send()` performs exactly one explicit, caller-
 * specified attempt. The concrete network-write adapter
 * (`XActionsSendAdapter`, `packages/adapters`) does not yet perform a real
 * X write at all — see RISK_REGISTER.md's Stage 6B section for the
 * verified research finding behind that (the vendored XActions subtree
 * deliberately excludes `dm.js`, so no request format is verified).
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
export * from './follow-up/contracts.js';
export * from './send/send-outcome.js';
export * from './send/send-service.js';
export * from './send/manual-sequence.js';
