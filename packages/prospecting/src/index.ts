/**
 * @metrivio/prospecting
 *
 * Implemented so far: technology enrichment (Stage 2, ARCHITECTURE.md §3.1
 * "Enrich" stage's domain-to-evidence path) and X prospect discovery
 * (Stage 4B, read-only — search/candidate/profile/founder-classification/
 * company-domain/persistence). ICP scoring integration, personalization,
 * verification, and outreach (BUILD_PLAN.md Stages 5, 7, 8+) are not
 * implemented here yet.
 */
export * from './enrichment/technology-enrichment.js';
export * from './discovery/discovery-service.js';
export * from './discovery/founder-classifier.js';
export * from './discovery/company-domain.js';
export * from './discovery/pain-intent-classifier.js';
export * from './discovery/paid-media-job-posting.js';
