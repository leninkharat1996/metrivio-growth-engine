import type { MetrivioDb } from '@metrivio/core';
import { GrowthTechniqueLibrary, deriveTechniqueStatus } from '../growth-techniques/growth-technique-library.js';
import { PerformanceAnalysisService } from './performance-analysis-service.js';

/**
 * Stage 9, Section L — updates the growth-technique library from OWN
 * performance evidence only. Deliberately does NOT run whenever an expert
 * account is merely observed using a hook shape (that remains
 * `PersonalBrandAnalysisService`'s Stage 7 job, unchanged) — this service
 * exists specifically so a technique's status can advance based on
 * Metrivio's own measured results, per Section L: "For Metrivio's own
 * content, use actual performance evidence."
 *
 * Reuses `deriveTechniqueStatus()` (Stage 7, unchanged) as the ONLY status
 * derivation — this service never invents its own promotion rule, so a
 * hook type used 3+ times is still never `OBSERVED` unless real
 * performance data (a content-value score) also backs it, exactly as
 * Stage 7 already required.
 */
export class GrowthTechniqueLearningService {
  private readonly library: GrowthTechniqueLibrary;
  private readonly performance: PerformanceAnalysisService;

  constructor(private readonly db: MetrivioDb) {
    this.library = new GrowthTechniqueLibrary(db);
    this.performance = new PerformanceAnalysisService(db);
  }

  /**
   * Reviews own-hook-type performance groups and records one growth
   * technique entry per hook type that has ANY observations at all
   * (fewer than the promotion threshold still gets recorded, at
   * `UNVERIFIED` — visibility into what's been tried, not just what
   * "won"). Returns the techniques recorded this run.
   */
  async learnFromOwnPerformance(): Promise<Array<Awaited<ReturnType<GrowthTechniqueLibrary['record']>>>> {
    const analysis = await this.performance.analyze();
    const recorded = [];

    for (const group of analysis.byHookType) {
      const hasPerformanceData = group.averageContentValueScore != null;
      const status = deriveTechniqueStatus(group.sampleSize, hasPerformanceData);

      const technique = await this.library.record({
        technique: `${group.value} (own content)`,
        category: 'hook',
        evidence: hasPerformanceData
          ? `${group.sampleSize} own post(s) used this hook shape; average content-value score ${group.averageContentValueScore}, performance direction ${group.performanceDirection}`
          : `${group.sampleSize} own post(s) used this hook shape; no scoreable performance data yet`,
        observedPerformance: hasPerformanceData ? `average content-value score ${group.averageContentValueScore} (${group.performanceDirection})` : null,
        applicability: 'mechanics-only: use this hook shape to open a post',
        status,
        exampleReference: "Metrivio's own published posts (aggregate, no individual attribution)",
      });
      recorded.push(technique);
    }

    return recorded;
  }
}
