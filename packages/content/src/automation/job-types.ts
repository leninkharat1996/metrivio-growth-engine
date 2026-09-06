/**
 * Stage 7, Section Z — the explicit, bounded set of content-intelligence
 * automation jobs, all run through Stage 6E's existing `AutomationScheduler`
 * (reused, not duplicated). Deliberately no `PUBLISH_CONTENT`/`SEND_POSTS`
 * job type exists — Section U/W/X: automation stops at
 * `PENDING_APPROVAL`/`APPROVED`/scheduling-readiness, never a live publish.
 */
export const INGEST_CONTENT_SIGNALS_JOB_TYPE = 'ingest_content_signals';
export const ANALYZE_ICP_CONVERSATIONS_JOB_TYPE = 'analyze_icp_conversations';
export const ANALYZE_COMPETITOR_CONTENT_JOB_TYPE = 'analyze_competitor_content';
export const ANALYZE_EXPERT_CONTENT_JOB_TYPE = 'analyze_expert_content';
export const GENERATE_CONTENT_OPPORTUNITIES_JOB_TYPE = 'generate_content_opportunities';
export const GENERATE_CONTENT_DRAFTS_JOB_TYPE = 'generate_content_drafts';
export const VALIDATE_CONTENT_DRAFTS_JOB_TYPE = 'validate_content_drafts';
export const ANALYZE_OWN_CONTENT_JOB_TYPE = 'analyze_own_content';

export const CONTENT_AUTOMATION_JOB_TYPES = [
  INGEST_CONTENT_SIGNALS_JOB_TYPE,
  ANALYZE_ICP_CONVERSATIONS_JOB_TYPE,
  ANALYZE_COMPETITOR_CONTENT_JOB_TYPE,
  ANALYZE_EXPERT_CONTENT_JOB_TYPE,
  GENERATE_CONTENT_OPPORTUNITIES_JOB_TYPE,
  GENERATE_CONTENT_DRAFTS_JOB_TYPE,
  VALIDATE_CONTENT_DRAFTS_JOB_TYPE,
  ANALYZE_OWN_CONTENT_JOB_TYPE,
] as const;
export type ContentAutomationJobType = (typeof CONTENT_AUTOMATION_JOB_TYPES)[number];
