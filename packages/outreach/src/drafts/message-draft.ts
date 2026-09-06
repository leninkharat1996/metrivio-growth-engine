import type { MessageDraftState } from '../state-machine/draft-state-machine.js';
import type { PersonalizationCandidate } from '../personalization/personalization-candidates.js';

/**
 * The structured message-draft contract (Stage 6A, Section F). Note there
 * is a single `status` field, not a separate "draft status" and "approval
 * status" pair — the message-draft state machine (`MessageDraftState`)
 * already *is* the approval status (DRAFTED/PENDING_APPROVAL/APPROVED/
 * REJECTED covers exactly the same ground a separate approvalStatus field
 * would), so a second parallel field was deliberately not added: it would
 * only create a second source of truth that could drift out of sync with
 * the state machine. `rejectionReason` is populated only when `status`
 * is `REJECTED`.
 */
/** Stage 6D follow-up message strategies (Section E) — deterministic templates only, no LLM. */
export type FollowUpIntent = 'clarification' | 'reminder' | 'final_close';

export interface MessageDraft {
  id: string;
  prospectId: string;
  /** The candidate this draft's message text was generated from — `null` when no personalization evidence was available (a safe generic template was used instead; see message-templates.ts). */
  selectedHook: PersonalizationCandidate | null;
  messageText: string;
  /** Every candidate's `evidenceId` considered when this draft was generated (not just the selected one) — kept for audit visibility into what was available at generation time. */
  evidenceReferences: string[];
  generatedAt: string;
  status: MessageDraftState;
  rejectionReason?: string;
  approvedBy?: string;
  rejectedBy?: string;
  /**
   * Stage 6D additions (Section A) — present only for a follow-up draft.
   * `undefined` for an original Stage 6A/6B-shaped draft, preserving exact
   * backward compatibility for every existing caller/test that never sets
   * these fields.
   */
  sequenceId?: string;
  sequenceStepOrder?: number;
  /** The `outreach_messages.id` of the original message this follow-up responds to, where available. */
  parentOutreachMessageId?: string;
  followUpIntent?: FollowUpIntent;
}
