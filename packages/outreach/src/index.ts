/**
 * @metrivio/outreach — Stage 6A: Outreach Foundation.
 *
 * Establishes the architecture and safety boundaries for
 *   Qualified Prospect -> Outreach Eligibility -> Personalization Evidence
 *   -> Message Draft -> Human Approval -> (future) Send
 * without implementing any X write/send capability. Nothing in this
 * package can send a DM, reply, follow, like, or repost — no method named
 * `send` (or similar) exists anywhere in this package, and the future send
 * boundary is `@metrivio/core`'s existing `XWriteAdapter` contract
 * (unmodified, still fully stubbed since Stage 1) — not a new interface
 * this package invents.
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
