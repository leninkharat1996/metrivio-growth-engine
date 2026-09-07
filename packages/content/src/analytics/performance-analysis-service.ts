import { eq } from 'drizzle-orm';
import { schema, type MetrivioDb } from '@metrivio/core';
import { OwnContentPerformanceService, type OwnPostMetricsSnapshot } from '../own-content/own-content-performance-service.js';
import { scoreContentValue, type ContentValueClassification } from './content-value-model.js';
import { derivePatternStrength, derivePerformanceDirection, type PatternStrength, type PerformanceDirection } from './pattern-detection.js';

/**
 * Stage 9, Section E — groups Metrivio's own post-performance snapshots
 * (Stage 7's `OwnContentPerformanceService`, reused unmodified as the
 * source of truth) by topic/pillar/hook/format/CTA, joining through
 * `content_drafts.idea_id -> content_ideas` (both existing tables) for
 * topic/pillar/format — never a second post-identity or a new table
 * (Section W/B: "do not create a second post identity").
 *
 * Every group carries an explicit sample size and, per Section T, a
 * `patternStrength` derived from `derivePatternStrength()` — no group's
 * conclusions are ever presented as more certain than that sample size
 * actually supports.
 */
export interface PerformanceGroupKey {
  dimension: 'topic' | 'pillar' | 'hookType' | 'format' | 'ctaType';
  value: string;
}

export interface PerformanceGroupSummary extends PerformanceGroupKey {
  sampleSize: number;
  postIds: string[];
  /** Average of each post's own overall content-value score (Section H) among posts in this group where a score could be computed — null if none could be. */
  averageContentValueScore: number | null;
  patternStrength: PatternStrength;
  performanceDirection: PerformanceDirection;
  /** Most common content-value classification among this group's scored posts, for a quick read — never a substitute for `averageContentValueScore`. */
  dominantClassification: ContentValueClassification | null;
}

interface EnrichedSnapshot {
  snapshot: OwnPostMetricsSnapshot;
  topic: string | null;
  pillar: string | null;
  format: string | null;
  contentValueScore: number | null;
  contentValueClassification: ContentValueClassification;
}

export class PerformanceAnalysisService {
  private readonly ownContent: OwnContentPerformanceService;

  constructor(private readonly db: MetrivioDb) {
    this.ownContent = new OwnContentPerformanceService(db);
  }

  /**
   * Computes a per-post content-value score from whatever data the
   * snapshot actually carries. Reach/engagement scores are normalized to
   * 0-100 via a fixed, documented saturation point (never compared to
   * other accounts' raw counts, per Section D) — ICP/business-intent
   * scores are simple presence-rate percentages of the counted engagers.
   * Every component stays `null` (never 0) when its underlying data is
   * absent, per `scoreContentValue()`'s own contract.
   */
  private scoreSnapshot(snapshot: OwnPostMetricsSnapshot): { score: number | null; classification: ContentValueClassification } {
    const REACH_SATURATION = 10000; // 10k+ impressions = full reach credit — a fixed, documented saturation point, never a cross-account comparison.
    const reachScore = snapshot.impressions != null ? Math.min(100, Math.round((snapshot.impressions / REACH_SATURATION) * 100)) : null;

    const engagementCount = [snapshot.likes, snapshot.replies, snapshot.reposts, snapshot.bookmarks].some((v) => v != null)
      ? [snapshot.likes, snapshot.replies, snapshot.reposts, snapshot.bookmarks].reduce((sum: number, v) => sum + (v ?? 0), 0)
      : null;
    // Section D: never compute a rate without its denominator (impressions).
    const engagementScore = engagementCount != null && snapshot.impressions ? Math.min(100, Math.round((engagementCount / snapshot.impressions) * 100 * 10)) : null;

    // icpEngagementCount is a count, not a rate against a known denominator of total engagers in this codebase's current data model — treated as a bounded presence signal (Section H's own icpScore doc comment: "e.g. share... or null").
    const icpScore = snapshot.icpEngagementCount != null ? Math.min(100, snapshot.icpEngagementCount * 25) : null;

    // No text-bearing engagement collection is wired into a snapshot itself (Section G collection happens via content_signals, not this snapshot) — businessIntentScore is left null here; PerformanceAnalysisService's own group-level rollup can layer it in from content_signals where available (see analyzeBusinessIntent below).
    const result = scoreContentValue({ reachScore, engagementScore, icpScore, businessIntentScore: null });
    return { score: result.overallScore, classification: result.classification };
  }

  private async enrichSnapshot(snapshot: OwnPostMetricsSnapshot): Promise<EnrichedSnapshot> {
    let topic: string | null = null;
    let pillar: string | null = null;
    let format: string | null = snapshot.format ?? null;

    if (snapshot.draftId) {
      const draftRows = await this.db.select().from(schema.contentDrafts).where(eq(schema.contentDrafts.id, snapshot.draftId)).limit(1);
      const draft = draftRows[0];
      if (draft) {
        const ideaRows = await this.db.select().from(schema.contentIdeas).where(eq(schema.contentIdeas.id, draft.ideaId)).limit(1);
        const idea = ideaRows[0];
        if (idea) {
          topic = idea.topic;
          pillar = idea.pillar;
          format = format ?? idea.recommendedFormat;
        }
      }
    }

    const { score, classification } = this.scoreSnapshot(snapshot);
    return { snapshot, topic, pillar, format, contentValueScore: score, contentValueClassification: classification };
  }

  private groupBy(enriched: EnrichedSnapshot[], dimension: PerformanceGroupKey['dimension'], overallBaseline: number | null): PerformanceGroupSummary[] {
    const buckets = new Map<string, EnrichedSnapshot[]>();
    for (const e of enriched) {
      const value = dimension === 'topic' ? e.topic : dimension === 'pillar' ? e.pillar : dimension === 'hookType' ? e.snapshot.hookType : dimension === 'format' ? e.format : e.snapshot.ctaType;
      if (value == null) continue;
      const bucket = buckets.get(value) ?? [];
      bucket.push(e);
      buckets.set(value, bucket);
    }

    return [...buckets.entries()]
      .map(([value, items]) => {
        const scored = items.filter((i) => i.contentValueScore != null);
        const averageContentValueScore = scored.length > 0 ? Math.round(scored.reduce((sum, i) => sum + (i.contentValueScore as number), 0) / scored.length) : null;

        const classificationCounts = new Map<ContentValueClassification, number>();
        for (const i of scored) classificationCounts.set(i.contentValueClassification, (classificationCounts.get(i.contentValueClassification) ?? 0) + 1);
        const dominantClassification = [...classificationCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

        return {
          dimension,
          value,
          sampleSize: items.length,
          postIds: items.map((i) => i.snapshot.postId),
          averageContentValueScore,
          patternStrength: derivePatternStrength(items.length),
          performanceDirection: derivePerformanceDirection(averageContentValueScore, overallBaseline, items.length),
          dominantClassification,
        };
      })
      .sort((a, b) => (b.averageContentValueScore ?? -1) - (a.averageContentValueScore ?? -1) || b.sampleSize - a.sampleSize);
  }

  /**
   * The full grouped analysis across all five dimensions Section E names.
   * `overallBaselineScore` (the account-wide average content-value score
   * across every scored post) is computed once and reused for every
   * group's `performanceDirection`, so "promising" always means "better
   * than Metrivio's own recent average," never an arbitrary absolute cutoff.
   */
  async analyze(): Promise<{ overallBaselineScore: number | null; totalPostsAnalyzed: number; byTopic: PerformanceGroupSummary[]; byPillar: PerformanceGroupSummary[]; byHookType: PerformanceGroupSummary[]; byFormat: PerformanceGroupSummary[]; byCtaType: PerformanceGroupSummary[] }> {
    const postIds = await this.ownContent.listIngestedPostIds();
    const snapshots: OwnPostMetricsSnapshot[] = [];
    for (const postId of postIds) {
      const snapshot = await this.ownContent.getLatestSnapshot(postId);
      if (snapshot) snapshots.push(snapshot);
    }

    const enriched = await Promise.all(snapshots.map((s) => this.enrichSnapshot(s)));
    const scored = enriched.filter((e) => e.contentValueScore != null);
    const overallBaselineScore = scored.length > 0 ? Math.round(scored.reduce((sum, e) => sum + (e.contentValueScore as number), 0) / scored.length) : null;

    return {
      overallBaselineScore,
      totalPostsAnalyzed: snapshots.length,
      byTopic: this.groupBy(enriched, 'topic', overallBaselineScore),
      byPillar: this.groupBy(enriched, 'pillar', overallBaselineScore),
      byHookType: this.groupBy(enriched, 'hookType', overallBaselineScore),
      byFormat: this.groupBy(enriched, 'format', overallBaselineScore),
      byCtaType: this.groupBy(enriched, 'ctaType', overallBaselineScore),
    };
  }
}
