import { v4 as uuid } from 'uuid';
import { schema, writeAuditLog, type MetrivioDb } from '@metrivio/core';
import { ContentSignalStore } from '../signals/content-signal-store.js';
import { PAIN_TAXONOMY_CATEGORIES, type PainTaxonomyCategory } from '../pain-taxonomy/pain-taxonomy.js';
import { scoreContentOpportunity, type ContentOpportunityScoreBreakdown } from './content-scoring.js';
import { getOpportunityTemplate } from './opportunity-templates.js';
import type { ContentConfidenceLevel } from '../confidence.js';

/**
 * Stage 7, Section L — converts already-collected `content_signals` into
 * `content_ideas` rows (the exact existing table, reused as-is — Section
 * AD: "prefer existing structures"). Clusters signals by pain-taxonomy
 * category (Section C's fixed vocabulary), scores each cluster via the
 * pure `scoreContentOpportunity()` (Section V), and creates one
 * `content_ideas` row per cluster that clears the evidence bar — a
 * category with insufficient ICP evidence produces NO opportunity at all
 * (never a fabricated one with a guessed score).
 *
 * The full score breakdown and originating signal ids are recorded via
 * `audit_log` (`entity_type: 'content_opportunity'`) alongside the
 * `content_ideas` row itself — mirroring the same "public columns +
 * audit-log-backed extended metadata" split Stage 6A established for
 * `MessageDraft`, rather than widening `content_ideas`' own schema.
 */
export interface ContentOpportunity {
  id: string;
  painCategory: Exclude<PainTaxonomyCategory, 'other'>;
  topic: string;
  hook: string;
  angle: string;
  whyItMatters: string;
  recommendedFormat: string;
  pillar: string;
  score: number;
  scoreBreakdown: ContentOpportunityScoreBreakdown;
  sourceSignalIds: string[];
}

export interface GenerateOpportunitiesOptions {
  minScore?: number;
  /** Bounded scan of the signal table (Section AH) — a large but finite default, never an unbounded query. */
  maxSignalsScanned?: number;
}

const DEFAULT_MAX_SIGNALS_SCANNED = 2000;

export class ContentOpportunityEngine {
  private readonly signals: ContentSignalStore;

  constructor(private readonly db: MetrivioDb) {
    this.signals = new ContentSignalStore(db);
  }

  async generateOpportunities(options: GenerateOpportunitiesOptions = {}): Promise<ContentOpportunity[]> {
    const allSignals = await this.signals.list({ limit: options.maxSignalsScanned ?? DEFAULT_MAX_SIGNALS_SCANNED });

    const opportunities: ContentOpportunity[] = [];
    for (const category of PAIN_TAXONOMY_CATEGORIES) {
      if (category === 'other') continue;

      const cluster = allSignals.filter((s) => s.painCategory === category);
      const icpSignals = cluster.filter((s) => s.signalType === 'icp_post');
      const competitorAccountIds = new Set(cluster.filter((s) => s.signalType === 'competitor_post' && s.accountId).map((s) => s.accountId as string));

      const confidenceCounts: Partial<Record<ContentConfidenceLevel, number>> = {};
      let mostRecent: string | null = null;
      for (const s of cluster) {
        confidenceCounts[s.confidence] = (confidenceCounts[s.confidence] ?? 0) + 1;
        const date = s.publishedAt ?? s.capturedAt;
        if (date && (!mostRecent || date > mostRecent)) mostRecent = date;
      }

      const result = scoreContentOpportunity({
        icpSignalCount: icpSignals.length,
        totalSignalCount: cluster.length,
        competitorAccountCoverage: competitorAccountIds.size,
        mostRecentSignalAt: mostRecent,
        confidenceCounts,
        now: new Date().toISOString(),
      });

      if (result.score === null) continue; // insufficient evidence — never a fabricated opportunity (Section V)
      if (options.minScore !== undefined && result.score < options.minScore) continue;

      const template = getOpportunityTemplate(category);
      const id = uuid();
      await this.db.insert(schema.contentIdeas).values({
        id,
        topic: `${category.replace(/_/g, ' ')} — ${template.angle}`,
        source: `content-opportunity-engine: ${cluster.length} signal(s) across ICP/competitor/expert/web research`,
        whyItMatters: template.whyItMatters,
        targetAudience: 'DTC/ecommerce founders, CEOs, and growth/marketing leaders with meaningful paid acquisition spend',
        hook: template.hook,
        angle: template.angle,
        recommendedFormat: template.recommendedFormat,
        pillar: category,
        status: 'new',
      });

      await writeAuditLog(this.db, {
        actor: 'system',
        actionType: 'content.opportunity.created',
        entityType: 'content_opportunity',
        entityId: id,
        detail: { painCategory: category, score: result.score, scoreBreakdown: result.breakdown, sourceSignalIds: cluster.map((s) => s.id) },
      });

      opportunities.push({
        id,
        painCategory: category,
        topic: `${category.replace(/_/g, ' ')} — ${template.angle}`,
        hook: template.hook,
        angle: template.angle,
        whyItMatters: template.whyItMatters,
        recommendedFormat: template.recommendedFormat,
        pillar: category,
        score: result.score,
        scoreBreakdown: result.breakdown,
        sourceSignalIds: cluster.map((s) => s.id),
      });
    }

    return opportunities.sort((a, b) => b.score - a.score);
  }
}
