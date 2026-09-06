import type { MetrivioDb } from '@metrivio/core';
import {
  WeeklyIntelligenceReportService,
  OwnContentPerformanceService,
  GrowthTechniqueLibrary,
  type WeeklyIntelligenceReport,
  type PostPerformanceSummary,
  type GrowthTechnique,
} from '@metrivio/content';

/**
 * Stage 7, Section U — a SMALL, read-only dashboard data assembly. No new
 * frontend framework, no publishing controls (Section U: "read-only
 * initially. No publishing controls are required"). Every field here is a
 * direct projection of data already computed by `packages/content`'s own
 * services — this module adds no new analysis of its own, only assembly
 * for display.
 */
export interface DashboardData {
  generatedAt: string;
  icpPainTrends: WeeklyIntelligenceReport['topIcpProblems'];
  competitorThemes: WeeklyIntelligenceReport['topCompetitorThemes'];
  expertThemes: WeeklyIntelligenceReport['topExpertThemes'];
  contentOpportunities: WeeklyIntelligenceReport['contentOpportunities'];
  ownPostPerformance: PostPerformanceSummary[];
  /** Pain categories appearing among the top-ranked own posts, in ranked order — never a separately invented metric. */
  bestPerformingTopics: string[];
  /** Hook types appearing among the top-ranked own posts, in ranked order. */
  bestPerformingHooks: string[];
  growthTechniques: GrowthTechnique[];
  recommendedNextContent: WeeklyIntelligenceReport['recommendedPosts'];
}

export class DashboardDataService {
  private readonly weeklyReport: WeeklyIntelligenceReportService;
  private readonly ownContent: OwnContentPerformanceService;
  private readonly techniques: GrowthTechniqueLibrary;

  constructor(private readonly db: MetrivioDb) {
    this.weeklyReport = new WeeklyIntelligenceReportService(db);
    this.ownContent = new OwnContentPerformanceService(db);
    this.techniques = new GrowthTechniqueLibrary(db);
  }

  async build(now: string = new Date().toISOString()): Promise<DashboardData> {
    const report = await this.weeklyReport.generate(now);

    const postIds = await this.ownContent.listIngestedPostIds();
    const ownPostPerformance = await this.ownContent.analyzeTopPosts(postIds);

    const bestPerformingTopics: string[] = [...new Set(ownPostPerformance.map((p) => p.painCategory).filter((c) => c != null))];
    const bestPerformingHooks: string[] = [...new Set(ownPostPerformance.map((p) => p.hookType).filter((h) => h != null))];

    const growthTechniques = await this.techniques.list();

    return {
      generatedAt: now,
      icpPainTrends: report.topIcpProblems,
      competitorThemes: report.topCompetitorThemes,
      expertThemes: report.topExpertThemes,
      contentOpportunities: report.contentOpportunities,
      ownPostPerformance,
      bestPerformingTopics,
      bestPerformingHooks,
      growthTechniques,
      recommendedNextContent: report.recommendedPosts,
    };
  }
}
