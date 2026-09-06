import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type Database from 'better-sqlite3';
import { schema, SystemConfigService, type MetrivioDb, type WebsiteReadAdapter, type WebsitePageResult, type WebsiteReadOptions } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { WebResearchService } from '../../src/web-research/web-research-service.js';

class ScriptedWebsiteReadAdapter implements WebsiteReadAdapter {
  private queue: Array<WebsitePageResult | Error> = [];
  public calls: string[] = [];
  queuePage(page: WebsitePageResult): void {
    this.queue.push(page);
  }
  queueError(err: Error): void {
    this.queue.push(err);
  }
  async fetchPage(url: string, _opts?: WebsiteReadOptions): Promise<WebsitePageResult> {
    this.calls.push(url);
    const next = this.queue.shift();
    if (next === undefined) throw new Error('no queued response');
    if (next instanceof Error) throw next;
    return next;
  }
}

function page(overrides: Partial<WebsitePageResult> = {}): WebsitePageResult {
  return { requestedUrl: 'https://example.com/report', finalUrl: 'https://example.com/report', statusCode: 200, text: 'industry report text', ...overrides };
}

let db: MetrivioDb;
let sqlite: Database.Database;
let adapter: ScriptedWebsiteReadAdapter;
let service: WebResearchService;
let config: SystemConfigService;

beforeEach(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  adapter = new ScriptedWebsiteReadAdapter();
  service = new WebResearchService(db, adapter);
  config = new SystemConfigService(db);
  await config.setKillSwitch(false, 'test');
  await config.setDailyLimit('scrapes', 10, 'test');
});

afterEach(() => sqlite.close());

describe('WebResearchService.researchUrl — provenance', () => {
  it('preserves URL, publisher, publication date, and claim supported', async () => {
    adapter.queuePage(page({ text: 'CAC is rising across the industry per this report' }));
    const signal = await service.researchUrl({ url: 'https://example.com/report', publisher: 'Industry Publication', publishedAt: '2026-01-01', claimSupported: 'CAC trends upward industry-wide' });

    expect(signal?.sourceUrl).toBe('https://example.com/report');
    expect(signal?.publishedAt).toBe('2026-01-01');
    expect(signal?.extraction?.publisher).toBe('Industry Publication');
    expect(signal?.extraction?.claimSupported).toBe('CAC trends upward industry-wide');
  });

  it('classifies the fetched text into a pain category', async () => {
    adapter.queuePage(page({ text: 'this report explains why ROAS is misleading' }));
    const signal = await service.researchUrl({ url: 'https://example.com/roas-report' });
    expect(signal?.painCategory).toBe('ROAS');
  });

  it('preserves capture date automatically', async () => {
    adapter.queuePage(page());
    const signal = await service.researchUrl({ url: 'https://example.com/report' });
    expect(signal?.capturedAt).toBeTruthy();
  });
});

describe('WebResearchService — bounded, never a crawler', () => {
  it('fetches exactly the one URL requested, never following links', async () => {
    adapter.queuePage(page());
    await service.researchUrl({ url: 'https://example.com/report' });
    expect(adapter.calls).toEqual(['https://example.com/report']);
  });

  it('researchTargets respects maxTargets', async () => {
    for (let i = 0; i < 5; i++) adapter.queuePage(page({ requestedUrl: `https://example.com/${i}` }));
    const signals = await service.researchTargets(
      Array.from({ length: 5 }, (_, i) => ({ url: `https://example.com/${i}` })),
      { maxTargets: 2 }
    );
    expect(signals).toHaveLength(2);
  });

  it('researchTargets respects the shared daily_limit_scrapes budget', async () => {
    await config.setDailyLimit('scrapes', 1, 'test');
    adapter.queuePage(page());
    adapter.queuePage(page());
    const signals = await service.researchTargets([{ url: 'https://example.com/1' }, { url: 'https://example.com/2' }]);
    expect(signals).toHaveLength(1);
  });

  it('one failing target does not stop the others', async () => {
    adapter.queueError(new Error('network down'));
    adapter.queuePage(page());
    const signals = await service.researchTargets([{ url: 'https://example.com/bad' }, { url: 'https://example.com/good' }]);
    expect(signals).toHaveLength(1);
  });
});

describe('WebResearchService — invalid/failed source handling', () => {
  it('returns null (never a fabricated signal) on a failed fetch', async () => {
    adapter.queueError(new Error('404 not found'));
    const signal = await service.researchUrl({ url: 'https://example.com/missing' });
    expect(signal).toBeNull();
  });

  it('respects the kill switch — no fetch is attempted', async () => {
    await config.setKillSwitch(true, 'test');
    const signal = await service.researchUrl({ url: 'https://example.com/report' });
    expect(signal).toBeNull();
    expect(adapter.calls).toHaveLength(0);
  });

  it('audits both a successful fetch and a failed one', async () => {
    adapter.queuePage(page());
    await service.researchUrl({ url: 'https://example.com/ok' });
    adapter.queueError(new Error('boom'));
    await service.researchUrl({ url: 'https://example.com/bad' });

    const successRows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.actionType, 'content.web_research.fetched'));
    const failRows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.actionType, 'content.web_research.failed'));
    expect(successRows.length).toBeGreaterThan(0);
    expect(failRows.length).toBeGreaterThan(0);
  });
});
