import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import {
  schema,
  SystemConfigService,
  type MetrivioDb,
  type WebsiteReadAdapter,
  type WebsitePageResult,
  type WebsiteReadOptions,
  WebsiteReadNotFoundError,
} from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { WebsiteEvidenceService } from '../../src/website-evidence/website-evidence-service.js';

/** Mirrors the existing ScriptedTechAnalyzerAdapter/ScriptedXReadAdapter test-double pattern — never a real fetch. */
class ScriptedWebsiteReadAdapter implements WebsiteReadAdapter {
  private readonly pages = new Map<string, WebsitePageResult>();
  private readonly errors = new Map<string, Error>();
  public readonly calls: string[] = [];

  page(url: string, text: string): void {
    this.pages.set(url, { requestedUrl: url, finalUrl: url, statusCode: 200, text });
  }

  fail(url: string, err: Error): void {
    this.errors.set(url, err);
  }

  async fetchPage(url: string, _opts?: WebsiteReadOptions): Promise<WebsitePageResult> {
    this.calls.push(url);
    if (this.errors.has(url)) throw this.errors.get(url);
    const page = this.pages.get(url);
    if (!page) throw new WebsiteReadNotFoundError('ScriptedWebsiteReadAdapter', 'fetchPage', url);
    return page;
  }
}

let db: MetrivioDb;
let sqlite: Database.Database;
let adapter: ScriptedWebsiteReadAdapter;
let service: WebsiteEvidenceService;

beforeEach(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  adapter = new ScriptedWebsiteReadAdapter();
  service = new WebsiteEvidenceService(db, adapter);
  // Mirrors discovery-service.test.ts's own convention: the shared scrape
  // budget defaults to 0 (fail-safe) when unset, so every test that
  // exercises network-consuming paths must set an explicit budget.
  await new SystemConfigService(db).setDailyLimit('scrapes', 100, 'test');
});

afterEach(() => sqlite.close());

async function insertProspect(overrides: Partial<typeof schema.prospects.$inferInsert> = {}): Promise<string> {
  const id = uuid();
  await db.insert(schema.prospects).values({
    id,
    xUsername: `user-${id.slice(0, 8)}`,
    source: 'founder_search',
    dateDiscovered: new Date().toISOString(),
    ...overrides,
  });
  return id;
}

async function seedScan(companyDomain: string, xHandles: string[]): Promise<void> {
  await db.insert(schema.technologyScans).values({
    id: uuid(),
    companyDomain,
    scanStatus: 'OK',
    detector: 'open_tech_analyzer',
    renderUsed: true,
    crawlUsed: 5,
    rawResponse: JSON.stringify({
      scanStatus: 'OK',
      technologies: [],
      detector: 'open_tech_analyzer',
      timestamp: new Date().toISOString(),
      enrichment: { social: { x: xHandles } },
    }),
    scannedAt: new Date().toISOString(),
  });
}

async function evidenceRows(prospectId: string, evidenceType: string, signalCategory?: string) {
  const rows = await db.select().from(schema.evidence).where(eq(schema.evidence.prospectId, prospectId));
  return rows.filter((r) => r.evidenceType === evidenceType && (signalCategory ? r.signalCategory === signalCategory : true));
}

describe('WebsiteEvidenceService.collectForProspect — correct_profile_identified (zero-fetch)', () => {
  it('writes correct_profile_identified when the domains own tech-scan enrichment lists this X handle', async () => {
    const prospectId = await insertProspect({ xUsername: 'janefounder', companyDomain: 'acme.com' });
    await seedScan('acme.com', ['https://x.com/JaneFounder']);
    adapter.page('https://acme.com/', 'plain homepage, nothing interesting');

    const result = await service.collectForProspect(prospectId);
    expect(result.factsWritten).toBeGreaterThanOrEqual(1);
    const rows = await evidenceRows(prospectId, 'decision_maker_signal', 'correct_profile_identified');
    expect(rows).toHaveLength(1);
    expect(rows[0].evidenceTier).toBe('CONFIRMED');
  });

  it('does not write correct_profile_identified when the enrichment lists a different handle', async () => {
    const prospectId = await insertProspect({ xUsername: 'janefounder', companyDomain: 'acme.com' });
    await seedScan('acme.com', ['https://x.com/someoneelse']);
    adapter.page('https://acme.com/', 'homepage');

    await service.collectForProspect(prospectId);
    const rows = await evidenceRows(prospectId, 'decision_maker_signal', 'correct_profile_identified');
    expect(rows).toHaveLength(0);
  });

  it('costs zero page fetches — it never calls the website adapter', async () => {
    const prospectId = await insertProspect({ xUsername: 'janefounder' });
    await service.collectForProspect(prospectId, { maxPages: 0 });
    expect(adapter.calls.filter((u) => u.includes('robots.txt') === false)).toHaveLength(0);
  });
});

describe('WebsiteEvidenceService.collectForProspect — page-derived evidence', () => {
  it('writes revenue_signal.employee_count_band from a fetched about page', async () => {
    const prospectId = await insertProspect({ companyDomain: 'acme.com' });
    adapter.page('https://acme.com/', 'homepage');
    adapter.page('https://acme.com/about', 'We are a team of 40 people building better skincare.');
    adapter.page('https://acme.com/about-us', '');
    adapter.page('https://acme.com/team', '');

    await service.collectForProspect(prospectId, { maxPages: 4 });
    const rows = await evidenceRows(prospectId, 'revenue_signal', 'employee_count_band');
    expect(rows).toHaveLength(1);
  });

  it('writes trigger_signal rows for a press-page announcement, sourced with that pages URL', async () => {
    const prospectId = await insertProspect({ companyDomain: 'acme.com' });
    adapter.page('https://acme.com/', 'homepage');
    adapter.page('https://acme.com/about', '');
    adapter.page('https://acme.com/about-us', '');
    adapter.page('https://acme.com/team', '');
    adapter.page('https://acme.com/our-team', '');
    adapter.page('https://acme.com/press', 'We just launched our new product line this week.');

    const result = await service.collectForProspect(prospectId, { maxPages: 6 });
    expect(result.triggersWritten).toBe(1);
    const rows = await evidenceRows(prospectId, 'trigger_signal', 'new_product_launch');
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceUrl).toBe('https://acme.com/press');
  });

  it('is idempotent — rerunning against the same page content never duplicates a fact', async () => {
    const prospectId = await insertProspect({ companyDomain: 'acme.com' });
    adapter.page('https://acme.com/', 'homepage');
    adapter.page('https://acme.com/about', 'We are a team of 40 people.');
    adapter.page('https://acme.com/about-us', '');
    adapter.page('https://acme.com/team', '');

    await service.collectForProspect(prospectId, { maxPages: 4 });
    await service.collectForProspect(prospectId, { maxPages: 4 });
    const rows = await evidenceRows(prospectId, 'revenue_signal', 'employee_count_band');
    expect(rows).toHaveLength(1);
  });

  it('skips a page that fails to fetch without failing the whole prospect', async () => {
    const prospectId = await insertProspect({ companyDomain: 'acme.com' });
    adapter.page('https://acme.com/', 'We are a team of 40 people.');
    adapter.fail('https://acme.com/about', new WebsiteReadNotFoundError('x', 'fetchPage'));
    adapter.page('https://acme.com/about-us', '');
    adapter.page('https://acme.com/team', '');

    const result = await service.collectForProspect(prospectId, { maxPages: 4 });
    expect(result.pagesFailed).toBe(1);
    expect(result.pagesFetched).toBe(3);
    const rows = await evidenceRows(prospectId, 'revenue_signal', 'employee_count_band');
    expect(rows).toHaveLength(1);
  });

  it('stops fetching once maxPages is reached, never fetching every configured path', async () => {
    const prospectId = await insertProspect({ companyDomain: 'acme.com' });
    for (const path of ['/', '/about', '/about-us', '/team', '/our-team', '/press', '/news', '/careers', '/jobs']) {
      adapter.page(`https://acme.com${path}`, 'text');
    }
    const result = await service.collectForProspect(prospectId, { maxPages: 2 });
    expect(result.pagesFetched).toBe(2);
  });

  it('never fetches any page when the prospect has no companyDomain', async () => {
    const prospectId = await insertProspect();
    const result = await service.collectForProspect(prospectId);
    expect(result.pagesFetched).toBe(0);
    expect(adapter.calls).toHaveLength(0);
  });

  it('throws for a prospect id that does not exist', async () => {
    await expect(service.collectForProspect('no-such-prospect')).rejects.toThrow(/no prospect found/);
  });
});

describe('WebsiteEvidenceService.runBatch', () => {
  it('processes multiple prospects and persists a resumable job checkpoint', async () => {
    const p1 = await insertProspect({ companyDomain: 'acme.com' });
    const p2 = await insertProspect({ companyDomain: 'other.com' });
    adapter.page('https://acme.com/', 'We are a team of 20 people.');
    for (const path of ['/about', '/about-us', '/team']) adapter.page(`https://acme.com${path}`, '');
    adapter.page('https://other.com/', 'We are a team of 60 people.');
    for (const path of ['/about', '/about-us', '/team']) adapter.page(`https://other.com${path}`, '');

    const outcome = await service.runBatch([p1, p2]);
    expect(outcome.stoppedReason).toBe('completed');
    expect(outcome.results).toHaveLength(2);
    const rows1 = await evidenceRows(p1, 'revenue_signal', 'employee_count_band');
    const rows2 = await evidenceRows(p2, 'revenue_signal', 'employee_count_band');
    expect(rows1).toHaveLength(1);
    expect(rows2).toHaveLength(1);
  });

  it('records a per-prospect error without losing progress on other prospects', async () => {
    const p1 = await insertProspect({ companyDomain: 'acme.com' });
    const p2 = 'no-such-prospect';
    adapter.page('https://acme.com/', 'We are a team of 20 people.');
    for (const path of ['/about', '/about-us', '/team']) adapter.page(`https://acme.com${path}`, '');

    const outcome = await service.runBatch([p1, p2]);
    const p1Result = outcome.results.find((r) => r.prospectId === p1);
    const p2Result = outcome.results.find((r) => r.prospectId === p2);
    expect(p1Result?.error).toBeUndefined();
    expect(p2Result?.error).toMatch(/no prospect found/);
  });

  it('resumes from a checkpoint without reprocessing an already-completed prospect', async () => {
    const p1 = await insertProspect({ companyDomain: 'acme.com' });
    const p2 = await insertProspect({ companyDomain: 'other.com' });
    adapter.page('https://acme.com/', 'We are a team of 20 people.');
    for (const path of ['/about', '/about-us', '/team']) adapter.page(`https://acme.com${path}`, '');

    // p2's pages are deliberately not registered yet — first pass only p1 succeeds.
    const first = await service.runBatch([p1, p2]);
    const p2FirstAttempt = first.results.find((r) => r.prospectId === p2);
    expect(p2FirstAttempt?.pagesFailed).toBeGreaterThan(0);

    adapter.calls.length = 0;
    const resumed = await service.runBatch([p1, p2], { resumeJobId: first.jobId });
    // p1 is already in the checkpoint from the first run — resuming must not re-fetch its pages.
    expect(adapter.calls.some((u) => u.startsWith('https://acme.com'))).toBe(false);
    expect(resumed.jobId).toBe(first.jobId);
  });

  it('stops once the shared daily scrape budget is exhausted', async () => {
    const config = new SystemConfigService(db);
    await config.setDailyLimit('scrapes', 1, 'test');

    const p1 = await insertProspect({ companyDomain: 'acme.com' });
    const p2 = await insertProspect({ companyDomain: 'other.com' });
    adapter.page('https://acme.com/', 'text');
    adapter.page('https://other.com/', 'text');

    const outcome = await service.runBatch([p1, p2]);
    expect(outcome.stoppedReason).toBe('budget_exhausted');
  });
});
