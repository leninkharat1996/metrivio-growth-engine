import type { MetrivioDb } from '@metrivio/core';
import { ContentSignalStore } from '../signals/content-signal-store.js';
import { CompetitorIntelligenceService } from '../competitor/competitor-intelligence-service.js';
import { classifyHookType, type HookType } from '../hooks/hook-classifier.js';
import { PerformanceAnalysisService } from './performance-analysis-service.js';

/**
 * Stage 9, Section K — compares Metrivio's OWN content patterns against
 * already-collected Stage 7 research (`content_signals` rows of
 * `signalType: 'competitor_post'`/`'expert_post'`) to surface gaps and
 * opportunities. This performs no new network I/O of its own — pure
 * aggregation over data Stage 7's own research subsystems already
 * collected, exactly like `CompetitorIntelligenceService`/
 * `ExpertPerformanceAnalysisService` themselves.
 *
 * Explicitly NOT a "copy them" engine (Section K: "do NOT optimize by
 * copying them") — every finding is framed as a GAP or an OPPORTUNITY
 * ("a topic/hook/format they use that we have not tried"), never an
 * instruction to imitate a specific account's voice, and every finding
 * carries its source attribution (which pain categories / how many
 * distinct accounts) so a human reviewer can trace the claim back to real
 * evidence.
 */
export interface TopicGap {
  painCategory: string;
  competitorSignalCount: number;
  competitorAccountCount: number;
}

export interface HookPatternGap {
  hookType: HookType;
  /** How many distinct expert-post signals used this hook shape. */
  expertUsageCount: number;
  /** How many times Metrivio's own posts have used this hook shape (0 means never tried). */
  ownUsageCount: number;
}

export interface BenchmarkReport {
  /** Pain categories with real competitor coverage that Metrivio's own content has not yet addressed at all. */
  topicGaps: TopicGap[];
  /** Hook shapes experts use noticeably more often than Metrivio does. */
  hookPatternGaps: HookPatternGap[];
  /** True differentiation opportunities: pain categories with ZERO competitor coverage (Stage 7's own gap detection), surfaced again here for the recommendation engine, not recomputed differently. */
  differentiationOpportunities: string[];
}

const HOOK_GAP_MIN_DELTA = 2; // an expert-usage count must exceed our own by at least this many to be worth surfacing as a gap — avoids noise from a 1-post difference.

export class BenchmarkingService {
  private readonly signals: ContentSignalStore;
  private readonly competitorIntelligence: CompetitorIntelligenceService;
  private readonly performance: PerformanceAnalysisService;

  constructor(private readonly db: MetrivioDb) {
    this.signals = new ContentSignalStore(db);
    this.competitorIntelligence = new CompetitorIntelligenceService(db);
    this.performance = new PerformanceAnalysisService(db);
  }

  async analyze(): Promise<BenchmarkReport> {
    const competitorReport = await this.competitorIntelligence.analyze();
    const ownPerformance = await this.performance.analyze();
    const ownTopics = new Set(ownPerformance.byTopic.map((g) => g.value));
    const ownPillars = new Set(ownPerformance.byPillar.map((g) => g.value));

    // A topic gap requires the competitor category to have real coverage
    // AND for it to be absent from BOTH our topic and pillar groupings —
    // topic/pillar vocabulary differs (pain-taxonomy category vs. a
    // content idea's own topic string), so checking both avoids a false
    // "gap" that's really just a naming mismatch.
    const topicGaps: TopicGap[] = competitorReport.themes
      .filter((theme) => !ownTopics.has(theme.painCategory) && !ownPillars.has(theme.painCategory))
      .map((theme) => ({ painCategory: theme.painCategory, competitorSignalCount: theme.signalCount, competitorAccountCount: theme.accountCount }));

    const expertSignals = await this.signals.list({ signalType: 'expert_post', limit: 2000 });
    const expertHookCounts = new Map<HookType, number>();
    for (const signal of expertSignals) {
      if (!signal.excerpt) continue;
      const hookType = classifyHookType(signal.excerpt);
      expertHookCounts.set(hookType, (expertHookCounts.get(hookType) ?? 0) + 1);
    }
    const ownHookCounts = new Map(ownPerformance.byHookType.map((g) => [g.value as HookType, g.sampleSize]));

    const hookPatternGaps: HookPatternGap[] = [...expertHookCounts.entries()]
      .map(([hookType, expertUsageCount]) => ({ hookType, expertUsageCount, ownUsageCount: ownHookCounts.get(hookType) ?? 0 }))
      .filter((g) => g.expertUsageCount - g.ownUsageCount >= HOOK_GAP_MIN_DELTA)
      .sort((a, b) => b.expertUsageCount - b.ownUsageCount - (a.expertUsageCount - a.ownUsageCount));

    return {
      topicGaps,
      hookPatternGaps,
      differentiationOpportunities: competitorReport.gaps,
    };
  }
}
