import type { MetrivioDb } from '@metrivio/core';
import { ContentSignalStore } from '../signals/content-signal-store.js';
import { CompetitorIntelligenceService, type CompetitorIntelligenceReport } from '../competitor/competitor-intelligence-service.js';
import { ContentOpportunityEngine, type ContentOpportunity } from '../opportunities/content-opportunity-engine.js';
import type { ContentSignal } from '../signals/content-signal.js';

/**
 * Stage 7, Section M — "THIS WEEK IN METRIVIO'S MARKET." Pure
 * orchestration/aggregation over already-collected data (no new network
 * I/O of its own — every subsystem it reads from has already done its own
 * kill-switch/bounds checks). Ranking throughout prioritizes ICP
 * relevance + evidence strength + recency + differentiation (Section V's
 * own scoring, reused here rather than a second ranking scheme) — never
 * raw engagement counts.
 */
export interface ThemeCount {
  painCategory: string;
  count: number;
}

export interface WeeklyIntelligenceReport {
  generatedAt: string;
  topIcpProblems: ThemeCount[];
  emergingPainPoints: ThemeCount[];
  topCompetitorThemes: CompetitorIntelligenceReport['themes'];
  competitorGaps: string[];
  topExpertThemes: ThemeCount[];
  externalResearch: ContentSignal[];
  contentOpportunities: ContentOpportunity[];
  recommendedPosts: ContentOpportunity[];
  whySelected: string[];
}

const EMERGING_WINDOW_DAYS = 14;

function countByPainCategory(signals: ContentSignal[]): ThemeCount[] {
  const counts = new Map<string, number>();
  for (const s of signals) {
    const category = s.painCategory ?? 'other';
    if (category === 'other') continue;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()].map(([painCategory, count]) => ({ painCategory, count })).sort((a, b) => b.count - a.count || a.painCategory.localeCompare(b.painCategory));
}

export class WeeklyIntelligenceReportService {
  private readonly signals: ContentSignalStore;
  private readonly competitorIntelligence: CompetitorIntelligenceService;
  private readonly opportunityEngine: ContentOpportunityEngine;

  constructor(private readonly db: MetrivioDb) {
    this.signals = new ContentSignalStore(db);
    this.competitorIntelligence = new CompetitorIntelligenceService(db);
    this.opportunityEngine = new ContentOpportunityEngine(db);
  }

  async generate(now: string = new Date().toISOString()): Promise<WeeklyIntelligenceReport> {
    const icpSignals = await this.signals.list({ signalType: 'icp_post' });
    const expertSignals = await this.signals.list({ signalType: 'expert_post' });
    const webSignals = await this.signals.list({ signalType: 'web_research', limit: 10 });

    const topIcpProblems = countByPainCategory(icpSignals).slice(0, 10);

    const cutoff = new Date(now).getTime() - EMERGING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const recentIcpSignals = icpSignals.filter((s) => {
      const date = s.publishedAt ?? s.capturedAt;
      return date ? new Date(date).getTime() >= cutoff : false;
    });
    const emergingPainPoints = countByPainCategory(recentIcpSignals).slice(0, 5);

    const competitorReport = await this.competitorIntelligence.analyze();
    const topExpertThemes = countByPainCategory(expertSignals).slice(0, 5);

    const opportunities = await this.opportunityEngine.generateOpportunities();
    const recommendedPosts = opportunities.slice(0, 5);
    const whySelected = recommendedPosts.map(
      (o) => `"${o.hook}" — score ${o.score}/100 (ICP relevance ${o.scoreBreakdown.icpRelevance}, differentiation ${o.scoreBreakdown.differentiation}, evidence strength ${o.scoreBreakdown.evidenceStrength}), backed by ${o.sourceSignalIds.length} signal(s).`
    );

    return {
      generatedAt: now,
      topIcpProblems,
      emergingPainPoints,
      topCompetitorThemes: competitorReport.themes.slice(0, 5),
      competitorGaps: competitorReport.gaps,
      topExpertThemes,
      externalResearch: webSignals,
      contentOpportunities: opportunities.slice(0, 15),
      recommendedPosts,
      whySelected,
    };
  }
}

/** Renders the report as simple markdown — the "weekly output" a human reads (Section M/U: "prefer simple tables/cards over complex UI"). */
export function renderWeeklyReportMarkdown(report: WeeklyIntelligenceReport): string {
  const lines: string[] = [];
  lines.push(`# This Week in Metrivio's Market`, '', `_Generated ${report.generatedAt}_`, '');

  lines.push('## 1. Top ICP Problems Discussed');
  for (const t of report.topIcpProblems) lines.push(`- ${t.painCategory}: ${t.count} signal(s)`);
  if (report.topIcpProblems.length === 0) lines.push('- No ICP signals collected yet.');

  lines.push('', '## 2. Emerging Pain Points (last 14 days)');
  for (const t of report.emergingPainPoints) lines.push(`- ${t.painCategory}: ${t.count} signal(s)`);
  if (report.emergingPainPoints.length === 0) lines.push('- Nothing new in the last 14 days.');

  lines.push('', '## 3. Top Competitor Themes');
  for (const t of report.topCompetitorThemes) lines.push(`- ${t.painCategory}: ${t.signalCount} signal(s) across ${t.accountCount} account(s)`);
  if (report.topCompetitorThemes.length === 0) lines.push('- No competitor signals collected yet.');

  lines.push('', '## 4. Competitor Content Gaps');
  for (const g of report.competitorGaps) lines.push(`- ${g}`);
  if (report.competitorGaps.length === 0) lines.push('- No gap data available yet.');

  lines.push('', '## 5. Top Expert Themes');
  for (const t of report.topExpertThemes) lines.push(`- ${t.painCategory}: ${t.count} signal(s)`);
  if (report.topExpertThemes.length === 0) lines.push('- No expert signals collected yet.');

  lines.push('', '## 6. Important External Research');
  for (const s of report.externalResearch) lines.push(`- [${s.sourceUrl ?? 'source'}] ${s.excerpt ?? ''}`);
  if (report.externalResearch.length === 0) lines.push('- No web research collected yet.');

  lines.push('', `## 7. Metrivio Content Opportunities (${report.contentOpportunities.length})`);
  for (const o of report.contentOpportunities) lines.push(`- [${o.score}] ${o.hook} (${o.recommendedFormat})`);

  lines.push('', '## 8. Top 5 Recommended Posts');
  for (const o of report.recommendedPosts) lines.push(`- ${o.hook} — score ${o.score}/100`);

  lines.push('', '## 9. Why Those 5 Were Selected');
  for (const why of report.whySelected) lines.push(`- ${why}`);

  return lines.join('\n');
}
