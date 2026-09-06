/**
 * Stage 6E, Section B — the small, explicit set of outreach automation job
 * types. Deliberately does NOT include a `SEND_DMS`/send-all job type: this
 * stage's architecture stops at `PENDING_APPROVAL` (Section K/U) — sending
 * remains a human-triggered call to `SendApprovedDraftService`, never a
 * scheduled job.
 */
export const DISCOVER_DUE_FOLLOWUPS_JOB_TYPE = 'discover_due_followups';
export const REFRESH_REPLY_STATE_JOB_TYPE = 'refresh_reply_state';
export const PREPARE_FOLLOWUP_DRAFTS_JOB_TYPE = 'prepare_followup_drafts';

export const OUTREACH_AUTOMATION_JOB_TYPES = [DISCOVER_DUE_FOLLOWUPS_JOB_TYPE, REFRESH_REPLY_STATE_JOB_TYPE, PREPARE_FOLLOWUP_DRAFTS_JOB_TYPE] as const;
export type OutreachAutomationJobType = (typeof OUTREACH_AUTOMATION_JOB_TYPES)[number];
