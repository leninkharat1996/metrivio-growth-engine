import { and, eq } from 'drizzle-orm';
import { schema, type MetrivioDb } from '@metrivio/core';
import { BenchmarkingService } from './benchmarking-service.js';
import { PerformanceAnalysisService } from './performance-analysis-service.js';
import { GrowthTechniqueLibrary } from '../growth-techniques/growth-technique-library.js';

/**
 * Stage 9, Section M — `ContentRecommendationEngine`. Reads already-
 * generated `content_ideas` rows (`status: 'new'`, created by Stage 7's
 * `ContentOpportunityEngine` — never re-generates or mutates them itself;
 * a recommendation engine is a read/ranking concern, not a content-
 * generation one) and layers evidence from own-performance analysis,
 * competitor/expert benchmarking, and the growth-technique library on top
 * of Stage 7's own deterministic opportunity score.
 *
 * Every recommendation names WHAT/WHY/EVIDENCE/FORMAT/HOOK
 * DIRECTION/ICP/EXPECTED PURPOSE (Section M's own required fields) and
 * carries `sourceIdeaId`/`sourceSignalIds` for full traceability back to
 * the originating ICP research (Section O's feedback-loop requirement).
 * Never produces "unsupported certainty" — a recommendation's `evidence`
 * array is empty only if truly nothing beyond the base opportunity score
 * was available, and the engine never fabricates a benchmark/technique
 * finding that wasn't actually computed.
 */
export interface ContentRecommendation {
  sourceIdeaId: string;
  what: string;
  why: string;
  evidence: string[];
  format: string;
  hookDirection: string;
  icp: string;
  expectedPurpose: string;
  score: number;
  sourceSignalIds: string[];
}

const TOPIC_GAP_BONUS = 10;
const OBSERVED_TECHNIQUE_BONUS = 5;

export class ContentRecommendationEngine {
  private readonly benchmarking: BenchmarkingService;
  private readonly performance: PerformanceAnalysisService;
  private readonly techniques: GrowthTechniqueLibrary;

  constructor(private readonly db: MetrivioDb) {
    this.benchmarking = new BenchmarkingService(db);
    this.performance = new PerformanceAnalysisService(db);
    this.techniques = new GrowthTechniqueLibrary(db);
  }

  async generateRecommendations(): Promise<ContentRecommendation[]> {
    const ideaRows = await this.db.select().from(schema.contentIdeas).where(eq(schema.contentIdeas.status, 'new'));
    if (ideaRows.length === 0) return [];

    const [benchmarkReport, performanceAnalysis, observedTechniques] = await Promise.all([
      this.benchmarking.analyze(),
      this.performance.analyze(),
      this.techniques.list({ category: 'hook', status: 'OBSERVED' }),
    ]);

    const topicGapCategories = new Set(benchmarkReport.topicGaps.map((g) => g.painCategory));
    const bestObservedHook = observedTechniques[0] ?? null;

    const recommendations: ContentRecommendation[] = [];
    for (const idea of ideaRows) {
      const opportunityAudit = await this.db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.entityType, 'content_opportunity'), eq(schema.auditLog.entityId, idea.id)))
        .limit(1);
      const detail = opportunityAudit[0]?.detail ? (JSON.parse(opportunityAudit[0].detail) as { score?: number; sourceSignalIds?: string[] }) : null;
      const baseScore = detail?.score ?? 0;
      const sourceSignalIds = detail?.sourceSignalIds ?? [];

      const evidence: string[] = [`Stage 7 content-opportunity score: ${baseScore}/100, from ${sourceSignalIds.length} source signal(s)`];
      let score = baseScore;

      if (topicGapCategories.has(idea.pillar)) {
        evidence.push(`Competitor benchmarking: "${idea.pillar}" is a topic gap — competitors cover it and Metrivio has not yet posted about it`);
        score += TOPIC_GAP_BONUS;
      }

      const ownGroupForPillar = performanceAnalysis.byPillar.find((g) => g.value === idea.pillar);
      if (ownGroupForPillar && ownGroupForPillar.performanceDirection === 'PROMISING') {
        evidence.push(`Own performance: prior posts on "${idea.pillar}" show a PROMISING performance direction (${ownGroupForPillar.patternStrength}, ${ownGroupForPillar.sampleSize} post(s))`);
      } else if (ownGroupForPillar && ownGroupForPillar.performanceDirection === 'UNDERPERFORMING') {
        evidence.push(`Own performance caution: prior posts on "${idea.pillar}" show an UNDERPERFORMING direction (${ownGroupForPillar.patternStrength}, ${ownGroupForPillar.sampleSize} post(s)) — worth a different angle`);
      }

      let hookDirection = `use the suggested hook: "${idea.hook ?? ''}"`;
      if (bestObservedHook) {
        hookDirection = `${bestObservedHook.technique} — ${bestObservedHook.evidence}`;
        evidence.push(`Growth-technique library: ${bestObservedHook.technique} is OBSERVED from Metrivio's own performance evidence`);
        score += OBSERVED_TECHNIQUE_BONUS;
      }

      recommendations.push({
        sourceIdeaId: idea.id,
        what: idea.topic,
        why: idea.whyItMatters ?? `Addresses the "${idea.pillar}" pain category with real ICP-sourced evidence`,
        evidence,
        format: idea.recommendedFormat,
        hookDirection,
        icp: 'DTC/ecommerce founders, CEOs, and growth/marketing leaders with meaningful paid acquisition spend',
        expectedPurpose: `Attract qualified engagement and business-intent signals from ICP accounts discussing "${idea.pillar}"`,
        score,
        sourceSignalIds,
      });
    }

    return recommendations.sort((a, b) => b.score - a.score);
  }
}
