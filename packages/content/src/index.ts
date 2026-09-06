/**
 * @metrivio/content — Stage 7: ICP Research + Content Intelligence +
 * Personal Brand Engine.
 *
 * Research -> Collect -> Classify -> Analyze -> Identify Pain -> Identify
 * Patterns -> Find Gaps -> Generate Content Opportunities -> Draft ->
 * Validate -> Human Approval -> (Scheduling readiness only — publishing
 * transport remains unverified; see `publishing/scheduling-readiness.ts`
 * and RISK_REGISTER.md's Stage 7 section).
 *
 * Every research subsystem here is READ-ONLY against X (reuses the
 * existing `XReadAdapter` contract, never a write adapter) and bounded
 * against the web (reuses `WebsiteReadAdapter`, targeted fetches only,
 * never a crawler). No subsystem in this package can send a DM, publish a
 * post, or bypass the existing `KillSwitch`/`AutomationScheduler`.
 */
export const CONTENT_PACKAGE_STAGE = 'stage-7' as const;

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
export * from './automation/content-automation.js';
