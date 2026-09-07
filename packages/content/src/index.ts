/**
 * @metrivio/content — Stage 7: ICP Research + Content Intelligence +
 * Personal Brand Engine; Stage 8: X Publishing + Distribution Boundary;
 * Stage 9: Performance Analytics + Learning Loop.
 *
 * Research -> Collect -> Classify -> Analyze -> Identify Pain -> Identify
 * Patterns -> Find Gaps -> Generate Content Opportunities -> Draft ->
 * Validate -> Human Approval -> Scheduling readiness -> (Stage 8)
 * `PublishApprovedContentService` -> `XPublishAdapter` -> X Post -> Audit
 * -> (Stage 9) Collect Performance -> Analyze -> Identify Patterns ->
 * Learn -> Recommend -> back to Content Opportunities, closing the loop.
 *
 * Every Stage 7 research subsystem here remains READ-ONLY against X (reuses
 * the existing `XReadAdapter` contract, never a write adapter) and bounded
 * against the web (reuses `WebsiteReadAdapter`, targeted fetches only,
 * never a crawler). No subsystem in this package can send a DM or bypass
 * the existing `KillSwitch`/`AutomationScheduler`. `PublishApprovedContentService`
 * is the ONLY code path in this package that can ever call `XPublishAdapter`
 * — see its own doc comment for the full approval/validation/kill-switch/
 * mode/limit boundary it enforces before doing so. Stage 9's analytics
 * subsystems (`packages/content/src/analytics`) are read/recommend-only:
 * none of them can approve, publish, mutate content, or contact a
 * prospect — see RISK_REGISTER.md §2M.
 */
export const CONTENT_PACKAGE_STAGE = 'stage-9' as const;

export * from './confidence.js';
export * from './pain-taxonomy/pain-taxonomy.js';
export * from './signals/content-signal.js';
export * from './signals/content-signal-store.js';
export * from './icp-research/icp-research-service.js';
export * from './accounts/tracked-account.js';
export * from './accounts/tracked-account-store.js';
export * from './accounts/account-discovery.js';
export * from './competitor/competitor-discovery-service.js';
export * from './competitor/competitor-intelligence-service.js';
export * from './hooks/hook-classifier.js';
export * from './accounts/tracked-account-research-service.js';
export * from './expert/expert-discovery-service.js';
export * from './expert/expert-performance-analysis-service.js';
export * from './web-research/web-research-service.js';
export * from './opportunities/content-scoring.js';
export * from './opportunities/opportunity-templates.js';
export * from './opportunities/content-opportunity-engine.js';
export * from './reports/weekly-intelligence-report.js';
export * from './drafts/content-validation.js';
export * from './drafts/content-draft-service.js';
export * from './own-content/own-content-performance-service.js';
export * from './growth-techniques/growth-technique-library.js';
export * from './personal-brand/personal-brand-analysis-service.js';
export * from './publishing/scheduling-readiness.js';
export * from './publishing/x-post-constraints.js';
export * from './publishing/publish-approved-content-service.js';
export * from './automation/job-types.js';
export * from './automation/icp-candidate-discovery.js';
export * from './automation/ingest-content-signals-handler.js';
export * from './automation/analyze-icp-conversations-handler.js';
export * from './automation/analyze-competitor-content-handler.js';
export * from './automation/analyze-expert-content-handler.js';
export * from './automation/generate-content-opportunities-handler.js';
export * from './automation/generate-content-drafts-handler.js';
export * from './automation/validate-content-drafts-handler.js';
export * from './automation/analyze-own-content-handler.js';
export * from './automation/publish-due-content-handler.js';
export * from './analytics/cta-classifier.js';
export * from './analytics/business-intent-classifier.js';
export * from './analytics/icp-engagement-classifier.js';
export * from './analytics/content-value-model.js';
export * from './analytics/pattern-detection.js';
export * from './analytics/performance-analysis-service.js';
export * from './analytics/benchmarking-service.js';
export * from './analytics/growth-technique-learning-service.js';
export * from './analytics/content-recommendation-engine.js';
export * from './analytics/weekly-content-plan-service.js';
export * from './automation/collect-post-performance-handler.js';
export * from './automation/analyze-content-performance-handler.js';
export * from './automation/update-growth-techniques-handler.js';
export * from './automation/generate-content-recommendations-handler.js';
export * from './automation/content-automation.js';
