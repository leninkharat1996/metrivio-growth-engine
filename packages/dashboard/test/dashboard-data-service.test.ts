import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { SystemConfigService, type MetrivioDb } from '@metrivio/core';
import { ContentSignalStore, OwnContentPerformanceService, GrowthTechniqueLibrary, ContentDraftService, SchedulingReadinessService, PublishApprovedContentService } from '@metrivio/content';
import { createTestDb } from './helpers/test-db.js';
import { DashboardDataService } from '../src/dashboard-data-service.js';
import { renderDashboardHtml } from '../src/dashboard-html-renderer.js';

let db: MetrivioDb;
let sqlite: Database.Database;
let service: DashboardDataService;

beforeEach(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  service = new DashboardDataService(db);
  const config = new SystemConfigService(db);
  await config.setKillSwitch(false, 'test');
  await config.setAutomationMode('content.publishing', 'approval_required', 'test');
  await config.setDailyLimit('posts', 25, 'test');
});

afterEach(() => sqlite.close());

describe('DashboardDataService.build — empty state', () => {
  it('never throws and returns empty-but-valid arrays when there is no data yet', async () => {
    const data = await service.build();
    expect(data.icpPainTrends).toEqual([]);
    expect(data.ownPostPerformance).toEqual([]);
    expect(data.growthTechniques).toEqual([]);
    expect(data.recommendedNextContent).toEqual([]);
  });
});

describe('DashboardDataService.build — correct aggregation', () => {
  it('surfaces ICP pain trends', async () => {
    const signals = new ContentSignalStore(db);
    await signals.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'CAC' });
    const data = await service.build();
    expect(data.icpPainTrends.some((t) => t.painCategory === 'CAC')).toBe(true);
  });

  it('derives best-performing topics/hooks from ranked own-post performance, never inventing a new metric', async () => {
    const performance = new OwnContentPerformanceService(db);
    await performance.ingestSnapshot({ postId: 'p1', text: 'why CAC keeps climbing', likes: 10, icpEngagementCount: 2 });
    const data = await service.build();
    expect(data.bestPerformingTopics).toContain('CAC');
  });

  it('includes growth techniques recorded in the library', async () => {
    const library = new GrowthTechniqueLibrary(db);
    await library.record({ technique: 'numbered hook', category: 'hook', evidence: 'e', applicability: 'a', status: 'LIKELY' });
    const data = await service.build();
    expect(data.growthTechniques).toHaveLength(1);
  });

  it('never invents a metric that was not ingested', async () => {
    const performance = new OwnContentPerformanceService(db);
    await performance.ingestSnapshot({ postId: 'p1' });
    const data = await service.build();
    expect(data.ownPostPerformance[0].reach).toBeNull();
  });
});

describe('renderDashboardHtml', () => {
  it('renders all 9 sections even with empty data', async () => {
    const data = await service.build();
    const html = renderDashboardHtml(data);
    for (let i = 1; i <= 9; i++) expect(html).toContain(`>${i}.`);
  });

  it('escapes HTML-unsafe characters in rendered content', async () => {
    const library = new GrowthTechniqueLibrary(db);
    await library.record({ technique: '<script>alert(1)</script>', category: 'hook', evidence: 'e', applicability: 'a', status: 'LIKELY' });
    const data = await service.build();
    const html = renderDashboardHtml(data);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('never renders a publishing/send control', async () => {
    const data = await service.build();
    const html = renderDashboardHtml(data);
    expect(html.toLowerCase()).not.toContain('<button');
    expect(html.toLowerCase()).not.toContain('<form');
  });

  it('renders the Stage 8 publishing status section', async () => {
    const data = await service.build();
    const html = renderDashboardHtml(data);
    expect(html).toContain('Publishing Status');
  });
});

describe('DashboardDataService.build — Stage 8 publishing status', () => {
  it('reports empty counts with no data', async () => {
    const data = await service.build();
    expect(data.publishingStatus).toEqual({ pendingApproval: 0, approved: 0, scheduled: 0, due: 0, published: 0, failed: 0, unknown: 0, recentActivity: [] });
  });

  it('counts pending-approval, approved, scheduled, due, and published buckets correctly', async () => {
    const drafts = new ContentDraftService(db);
    const scheduling = new SchedulingReadinessService(db);

    await drafts.generateDraft({ ideaId: uuid(), body: 'draft one, still pending' });

    const { draft: d2 } = await drafts.generateDraft({ ideaId: uuid(), body: 'draft two, approved but not scheduled' });
    await drafts.submitForApproval(d2.id);
    await drafts.approve(d2.id, 'lenin');

    const { draft: d3 } = await drafts.generateDraft({ ideaId: uuid(), body: 'draft three, scheduled and due' });
    await drafts.submitForApproval(d3.id);
    await drafts.approve(d3.id, 'lenin');
    await scheduling.markReadyForScheduling(d3.id);

    const { draft: d4 } = await drafts.generateDraft({ ideaId: uuid(), body: 'draft four, already published' });
    await drafts.submitForApproval(d4.id);
    await drafts.approve(d4.id, 'lenin');
    await scheduling.markReadyForScheduling(d4.id);
    const publisher = new PublishApprovedContentService(db, { publishPost: async (input) => ({ xPostId: 'p4', publishedAt: 't', publishedText: input.text }) });
    await publisher.publishDraft(d4.id);

    const data = await service.build();
    expect(data.publishingStatus.pendingApproval).toBe(1);
    expect(data.publishingStatus.approved).toBe(2); // d2 (not scheduled) + d3 (scheduled, not yet published)
    expect(data.publishingStatus.scheduled).toBe(1); // d3
    expect(data.publishingStatus.due).toBe(1); // d3
    expect(data.publishingStatus.published).toBe(1); // d4
  });

  it('surfaces recent publishing activity from the audit log', async () => {
    const drafts = new ContentDraftService(db);
    const scheduling = new SchedulingReadinessService(db);
    const { draft } = await drafts.generateDraft({ ideaId: uuid(), body: 'a post that will be published' });
    await drafts.submitForApproval(draft.id);
    await drafts.approve(draft.id, 'lenin');
    await scheduling.markReadyForScheduling(draft.id);
    const publisher = new PublishApprovedContentService(db, { publishPost: async (input) => ({ xPostId: 'real-id', publishedAt: 't', publishedText: input.text }) });
    await publisher.publishDraft(draft.id);

    const data = await service.build();
    expect(data.publishingStatus.recentActivity.length).toBeGreaterThan(0);
    const published = data.publishingStatus.recentActivity.find((a) => a.outcome === 'PUBLISHED');
    expect(published?.xPostId).toBe('real-id');
    expect(published?.draftId).toBe(draft.id);
  });
});
