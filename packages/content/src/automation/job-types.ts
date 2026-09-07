/**
 * Stage 7, Section Z — the explicit, bounded set of content-intelligence
 * automation jobs, all run through Stage 6E's existing `AutomationScheduler`
 * (reused, not duplicated). Stage 7 itself deliberately stopped short of any
 * `PUBLISH_CONTENT`/`SEND_POSTS` job type — automation stopped at
 * `PENDING_APPROVAL`/`APPROVED`/scheduling-readiness, never a live publish,
 * because no verified X publishing transport existed yet.
 *
 * Stage 8 adds exactly one job beyond that boundary:
 * `PUBLISH_DUE_CONTENT_JOB_TYPE`. It is still bound by every rule the
 * comment above describes for the OTHER jobs — it never approves, never
 * rejects, never mutates content, and never calls `XPublishAdapter`
 * directly. It only ever calls `PublishApprovedContentService.publishDraft()`
 * for drafts that are ALREADY `APPROVED` by a human and already marked
 * ready-for-scheduling by a human (`markReadyForScheduling()`,
 * `SchedulingReadinessService`) — the automation job's only job is finding
 * which of those are now due and asking the service (which re-verifies
 * everything itself) to publish them.
 *
 * Stage 9 adds four more, all read/analysis-only except the identity-only
 * write `COLLECT_POST_PERFORMANCE` performs (Section S: the learning
 * engine "must NOT automatically rewrite approved content, delete posts,
 * change published posts, alter approval state, publish new content, or
 * contact prospects" — none of these four jobs ever does any of that;
 * `GENERATE_CONTENT_RECOMMENDATIONS` only ever records recommendations to
 * the audit log for a human to read).
 */
export const INGEST_CONTENT_SIGNALS_JOB_TYPE = 'ingest_content_signals';
export const ANALYZE_ICP_CONVERSATIONS_JOB_TYPE = 'analyze_icp_conversations';
export const ANALYZE_COMPETITOR_CONTENT_JOB_TYPE = 'analyze_competitor_content';
export const ANALYZE_EXPERT_CONTENT_JOB_TYPE = 'analyze_expert_content';
export const GENERATE_CONTENT_OPPORTUNITIES_JOB_TYPE = 'generate_content_opportunities';
export const GENERATE_CONTENT_DRAFTS_JOB_TYPE = 'generate_content_drafts';
export const VALIDATE_CONTENT_DRAFTS_JOB_TYPE = 'validate_content_drafts';
export const ANALYZE_OWN_CONTENT_JOB_TYPE = 'analyze_own_content';
export const PUBLISH_DUE_CONTENT_JOB_TYPE = 'publish_due_content';
export const COLLECT_POST_PERFORMANCE_JOB_TYPE = 'collect_post_performance';
export const ANALYZE_CONTENT_PERFORMANCE_JOB_TYPE = 'analyze_content_performance';
export const UPDATE_GROWTH_TECHNIQUES_JOB_TYPE = 'update_growth_techniques';
export const GENERATE_CONTENT_RECOMMENDATIONS_JOB_TYPE = 'generate_content_recommendations';

export const CONTENT_AUTOMATION_JOB_TYPES = [
  INGEST_CONTENT_SIGNALS_JOB_TYPE,
  ANALYZE_ICP_CONVERSATIONS_JOB_TYPE,
  ANALYZE_COMPETITOR_CONTENT_JOB_TYPE,
  ANALYZE_EXPERT_CONTENT_JOB_TYPE,
  GENERATE_CONTENT_OPPORTUNITIES_JOB_TYPE,
  GENERATE_CONTENT_DRAFTS_JOB_TYPE,
  VALIDATE_CONTENT_DRAFTS_JOB_TYPE,
  ANALYZE_OWN_CONTENT_JOB_TYPE,
  PUBLISH_DUE_CONTENT_JOB_TYPE,
  COLLECT_POST_PERFORMANCE_JOB_TYPE,
  ANALYZE_CONTENT_PERFORMANCE_JOB_TYPE,
  UPDATE_GROWTH_TECHNIQUES_JOB_TYPE,
  GENERATE_CONTENT_RECOMMENDATIONS_JOB_TYPE,
] as const;
export type ContentAutomationJobType = (typeof CONTENT_AUTOMATION_JOB_TYPES)[number];
