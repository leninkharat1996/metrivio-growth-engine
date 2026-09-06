import type { PainTaxonomyCategory } from '../pain-taxonomy/pain-taxonomy.js';
import type { ContentConfidenceLevel } from '../confidence.js';

export const CONTENT_SIGNAL_TYPES = ['icp_post', 'competitor_post', 'expert_post', 'web_research', 'own_post'] as const;
export type ContentSignalType = (typeof CONTENT_SIGNAL_TYPES)[number];

export const CONTENT_SOURCE_TYPES = ['x_post', 'web_article'] as const;
export type ContentSourceType = (typeof CONTENT_SOURCE_TYPES)[number];

/** Bounded excerpt length (Section P/K: "preserve enough to reproduce the conclusion," never the full source verbatim). */
export const CONTENT_SIGNAL_EXCERPT_MAX_LENGTH = 280;

export interface ContentSignalEngagement {
  likes?: number | null;
  replies?: number | null;
  reposts?: number | null;
  bookmarks?: number | null;
  views?: number | null;
}

/** Section B's structured extraction fields — kept as one flexible object rather than one column each, so new fields never require a migration. */
export interface ContentSignalExtraction {
  problem?: string;
  desiredOutcome?: string;
  frustration?: string;
  attemptedSolution?: string;
  currentApproach?: string;
  objection?: string;
  misconception?: string;
  question?: string;
  buyingSignal?: string;
  trigger?: string;
  emotionalIntensity?: 'low' | 'medium' | 'high';
  claimSupported?: string;
  [key: string]: unknown;
}

export interface ContentSignalInput {
  signalType: ContentSignalType;
  sourceType: ContentSourceType;
  sourceUrl?: string | null;
  prospectId?: string | null;
  accountId?: string | null;
  authorUsername?: string | null;
  companyName?: string | null;
  topic?: string | null;
  painCategory?: PainTaxonomyCategory | null;
  confidence: ContentConfidenceLevel;
  /** Truncated to `CONTENT_SIGNAL_EXCERPT_MAX_LENGTH` at write time — never stored longer, regardless of input length. */
  excerpt?: string | null;
  extraction?: ContentSignalExtraction | null;
  engagement?: ContentSignalEngagement | null;
  relevanceScore?: number | null;
  publishedAt?: string | null;
}

export interface ContentSignal extends Omit<ContentSignalInput, 'engagement'> {
  id: string;
  engagement: ContentSignalEngagement;
  capturedAt: string;
}
