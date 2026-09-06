/**
 * @metrivio/prospecting
 *
 * Implemented so far: technology enrichment (Stage 2, ARCHITECTURE.md §3.1
 * "Enrich" stage's domain-to-evidence path), X prospect discovery (Stage
 * 4B, read-only), and evidence assembly + Stage 3 scoring integration
 * (Stage 4C — turns Stage 4B/Stage 2 outputs into Stage 3's scoring input
 * and persists `icp_scores`). Personalization, verification/exclusion
 * capture, and outreach (BUILD_PLAN.md Stages 5, 7, 8+) are not implemented
 * here yet.
 */
export * from './enrichment/technology-enrichment.js';
export * from './discovery/discovery-service.js';
export * from './discovery/founder-classifier.js';
export * from './discovery/company-domain.js';
export * from './discovery/pain-intent-classifier.js';
export * from './discovery/paid-media-job-posting.js';
export * from './evidence-assembly/evidence-assembly-service.js';
export * from './evidence-assembly/evidence-readers.js';
