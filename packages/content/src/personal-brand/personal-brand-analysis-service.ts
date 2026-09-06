import type { MetrivioDb, XReadAdapter } from '@metrivio/core';
import { TrackedAccountStore } from '../accounts/tracked-account-store.js';
import { ExpertPerformanceAnalysisService } from '../expert/expert-performance-analysis-service.js';
import { GrowthTechniqueLibrary, deriveTechniqueStatus, type GrowthTechnique } from '../growth-techniques/growth-technique-library.js';
import type { HookType } from '../hooks/hook-classifier.js';

/**
 * Stage 7, Section Q — personal-brand growth mechanics analysis. Answers
 * "which personal-brand techniques can Metrivio ethically adapt," never
 * "which influencer should we copy": every technique this service records
 * describes a hook's SHAPE (question/numbered/contrarian/statement — the
 * same mechanics-only classifier `expert-performance-analysis-service.ts`
 * already uses), aggregated across ALL tracked expert accounts together —
 * never attributed to, or quoting, one specific person's voice. This is
 * the structural guarantee against "personal-brand analysis becoming
 * impersonation" the security/scope audit checks for.
 */
const HOOK_APPLICABILITY: Record<HookType, string> = {
  question_hook: 'Open with a specific, evidence-grounded question relevant to marketing efficiency — never a generic or rhetorical one.',
  numbered_hook: 'Lead with a specific count (e.g. "3 reasons...") only when each item is genuinely distinct and evidence-backed.',
  contrarian_hook: 'State a defensible, evidence-backed contrarian position — never contrarian purely for engagement.',
  statement_hook: 'Use a direct, specific claim as the opening line rather than a generic observation.',
};

export class PersonalBrandAnalysisService {
  private readonly accounts: TrackedAccountStore;
  private readonly performance: ExpertPerformanceAnalysisService;
  private readonly library: GrowthTechniqueLibrary;

  constructor(
    private readonly db: MetrivioDb,
    xReadAdapter: XReadAdapter
  ) {
    this.accounts = new TrackedAccountStore(db);
    this.performance = new ExpertPerformanceAnalysisService(db, xReadAdapter);
    this.library = new GrowthTechniqueLibrary(db);
  }

  /** Aggregates hook-type usage across every tracked expert account and records one technique entry per hook shape observed. */
  async analyzeAndRecordTechniques(): Promise<GrowthTechnique[]> {
    const experts = await this.accounts.listByType('expert');

    const stats = new Map<HookType, { observationCount: number; rateSum: number; rateSamples: number }>();
    for (const expert of experts) {
      const summary = await this.performance.analyzeAccount(expert.id);
      for (const hook of summary.topHookTypes) {
        const hookType = hook.key as HookType;
        const bucket = stats.get(hookType) ?? { observationCount: 0, rateSum: 0, rateSamples: 0 };
        bucket.observationCount += hook.count;
        if (summary.engagementRate != null) {
          bucket.rateSum += summary.engagementRate;
          bucket.rateSamples += 1;
        }
        stats.set(hookType, bucket);
      }
    }

    const recorded: GrowthTechnique[] = [];
    for (const [hookType, bucket] of stats.entries()) {
      const hasPerformanceData = bucket.rateSamples > 0;
      const status = deriveTechniqueStatus(bucket.observationCount, hasPerformanceData);
      const technique = await this.library.record({
        technique: `${hookType.replace(/_/g, ' ')}`,
        category: 'hook',
        evidence: `observed ${bucket.observationCount} time(s) across tracked expert accounts`,
        observedPerformance: hasPerformanceData ? `average engagement rate ${(bucket.rateSum / bucket.rateSamples).toFixed(4)} across ${bucket.rateSamples} account(s) with measurable data` : null,
        applicability: HOOK_APPLICABILITY[hookType],
        status,
        exampleReference: 'tracked expert accounts (aggregate, no individual attribution)',
      });
      recorded.push(technique);
    }

    return recorded;
  }
}
