import { desc, inArray } from 'drizzle-orm';
import { schema, type MetrivioDb } from '@metrivio/core';
import {
  WeeklyIntelligenceReportService,
  OwnContentPerformanceService,
  GrowthTechniqueLibrary,
  SchedulingReadinessService,
  PerformanceAnalysisService,
  BenchmarkingService,
  type WeeklyIntelligenceReport,
  type PostPerformanceSummary,
  type GrowthTechnique,
  type PerformanceGroupSummary,
  type BenchmarkReport,
} from '@metrivio/content';

/**
 * Stage 7, Section U — a SMALL, read-only dashboard data assembly. No new
 * frontend framework, no publishing controls (Section U: "read-only
 * initially. No publishing controls are required"). Every field here is a
 * direct projection of data already computed by `packages/content`'s own
 * services — this module adds no new analysis of its own, only assembly
 * for display.
 *
 * Stage 8, Section Z extends this with one additional read-only section
 * (`publishingStatus`) — counts and recent activity for the publishing
 * pipeline. Still no publishing controls of any kind: this only ever reads
 * `content_drafts`/`audit_log`, never calls `PublishApprovedContentService`
 * or `XPublishAdapter`.
 *
 * Stage 9, Section P extends this further with `performanceAndLearning` —
 * grouped own-content performance, benchmarking gaps, and explicit
 * data-quality warnings (Section Q: dashboard/reports must distinguish
 * KNOWN/UNKNOWN/INSUFFICIENT_DATA, never silently convert missing to
 * zero). Purely a projection of `packages/content`'s Stage 9 analytics
 * services — no new analysis logic lives in this package.
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
  publishingStatus: PublishingStatusSummary;
  performanceAndLearning: PerformanceAndLearningSummary;
}

export interface DataQualityWarning {
  area: string;
  message: string;
}

export interface PerformanceAndLearningSummary {
  overallBaselineScore: number | null;
  totalPostsAnalyzed: number;
  byTopic: PerformanceGroupSummary[];
  byHookType: PerformanceGroupSummary[];
  byFormat: PerformanceGroupSummary[];
  underperformingThemes: PerformanceGroupSummary[];
  benchmarking: BenchmarkReport;
  dataQualityWarnings: DataQualityWarning[];
}

export interface PublishingStatusActivity {
  draftId: string;
  outcome: string;
  timestamp: string;
  xPostId?: string;
}

export interface PublishingStatusSummary {
  pendingApproval: number;
  approved: number;
  scheduled: number;
  due: number;
  published: number;
  failed: number;
  unknown: number;
  recentActivity: PublishingStatusActivity[];
}

const PUBLISH_ACTION_TYPES = ['content.publish.published', 'content.publish.blocked', 'content.publish.failed', 'content.publish.unknown'] as const;

export class DashboardDataService {
  private readonly weeklyReport: WeeklyIntelligenceReportService;
  private readonly ownContent: OwnContentPerformanceService;
  private readonly techniques: GrowthTechniqueLibrary;
  private readonly scheduling: SchedulingReadinessService;
  private readonly performanceAnalysis: PerformanceAnalysisService;
  private readonly benchmarking: BenchmarkingService;

  constructor(private readonly db: MetrivioDb) {
    this.weeklyReport = new WeeklyIntelligenceReportService(db);
    this.ownContent = new OwnContentPerformanceService(db);
    this.techniques = new GrowthTechniqueLibrary(db);
    this.scheduling = new SchedulingReadinessService(db);
    this.performanceAnalysis = new PerformanceAnalysisService(db);
    this.benchmarking = new BenchmarkingService(db);
  }

  async build(now: string = new Date().toISOString()): Promise<DashboardData> {
    const report = await this.weeklyReport.generate(now);

    const postIds = await this.ownContent.listIngestedPostIds();
    const ownPostPerformance = await this.ownContent.analyzeTopPosts(postIds);

    const bestPerformingTopics: string[] = [...new Set(ownPostPerformance.map((p) => p.painCategory).filter((c) => c != null))];
    const bestPerformingHooks: string[] = [...new Set(ownPostPerformance.map((p) => p.hookType).filter((h) => h != null))];

    const growthTechniques = await this.techniques.list();
    const publishingStatus = await this.buildPublishingStatus();
    const performanceAndLearning = await this.buildPerformanceAndLearning();

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
      publishingStatus,
      performanceAndLearning,
    };
  }

  private async buildPerformanceAndLearning(): Promise<PerformanceAndLearningSummary> {
    const analysis = await this.performanceAnalysis.analyze();
    const benchmarking = await this.benchmarking.analyze();

    const underperformingThemes = [...analysis.byTopic, ...analysis.byPillar, ...analysis.byHookType, ...analysis.byFormat, ...analysis.byCtaType].filter(
      (g) => g.performanceDirection === 'UNDERPERFORMING'
    );

    const dataQualityWarnings: DataQualityWarning[] = [];
    if (analysis.totalPostsAnalyzed === 0) {
      dataQualityWarnings.push({ area: 'performance', message: 'no own-content performance snapshots have been ingested yet — every performance figure below is INSUFFICIENT_DATA' });
    }
    if (analysis.overallBaselineScore === null && analysis.totalPostsAnalyzed > 0) {
      dataQualityWarnings.push({ area: 'performance', message: 'no post has enough reach/engagement/ICP/business-intent data to compute a content-value score yet' });
    }
    const insufficientGroups = [...analysis.byTopic, ...analysis.byHookType].filter((g) => g.patternStrength === 'INSUFFICIENT_DATA');
    if (insufficientGroups.length > 0) {
      dataQualityWarnings.push({ area: 'patterns', message: `${insufficientGroups.length} topic/hook group(s) have fewer than 3 posts — treated as INSUFFICIENT_DATA, not a confirmed pattern` });
    }

    return {
      overallBaselineScore: analysis.overallBaselineScore,
      totalPostsAnalyzed: analysis.totalPostsAnalyzed,
      byTopic: analysis.byTopic,
      byHookType: analysis.byHookType,
      byFormat: analysis.byFormat,
      underperformingThemes,
      benchmarking,
      dataQualityWarnings,
    };
  }

  private async buildPublishingStatus(): Promise<PublishingStatusSummary> {
    const allDrafts = await this.db.select().from(schema.contentDrafts);
    const pendingApproval = allDrafts.filter((d) => d.approvalStatus === 'pending').length;
    const approvedNotPublished = allDrafts.filter((d) => d.approvalStatus === 'approved' && !d.xManagerPostId);
    const published = allDrafts.filter((d) => !!d.xManagerPostId).length;

    let scheduled = 0;
    let due = 0;
    for (const draft of approvedNotPublished) {
      const state = await this.scheduling.getSchedulingState(draft.id);
      if (state.readyForScheduling) {
        scheduled += 1;
        if (!state.scheduledFor || new Date(state.scheduledFor).getTime() <= Date.now()) {
          due += 1;
        }
      }
    }
    const approved = approvedNotPublished.length;

    const allActivityRows = await this.db.select().from(schema.auditLog).where(inArray(schema.auditLog.actionType, [...PUBLISH_ACTION_TYPES]));
    const failed = allActivityRows.filter((r) => r.actionType === 'content.publish.failed').length;
    const unknown = allActivityRows.filter((r) => r.actionType === 'content.publish.unknown').length;

    const recentActivityRows = await this.db
      .select()
      .from(schema.auditLog)
      .where(inArray(schema.auditLog.actionType, [...PUBLISH_ACTION_TYPES]))
      .orderBy(desc(schema.auditLog.timestamp))
      .limit(10);

    const recentActivity: PublishingStatusActivity[] = recentActivityRows.map((row) => {
      const detail = row.detail ? (JSON.parse(row.detail) as { outcome?: string; xPostId?: string }) : {};
      return {
        draftId: row.entityId ?? 'unknown',
        outcome: detail.outcome ?? row.actionType,
        timestamp: row.timestamp,
        xPostId: detail.xPostId,
      };
    });

    return { pendingApproval, approved, scheduled, due, published, failed, unknown, recentActivity };
  }
}
