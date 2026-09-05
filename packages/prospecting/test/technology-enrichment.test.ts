import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type MetrivioDb, type TechAnalyzerAdapter, type TechAnalyzerResult } from '@metrivio/core';
import type Database from 'better-sqlite3';
import { createTestDb } from './helpers/test-db.js';
import { TechnologyEnrichmentService } from '../src/enrichment/technology-enrichment.js';

/**
 * A scripted TechAnalyzerAdapter double — never opentechalyzer or any real
 * network call. Each `.analyze()` call for a domain pops the next queued
 * response (or throw) for that domain, so a test can script an exact
 * sequence of scans (e.g. "first scan detects only Shopify, second scan
 * detects Shopify + Klaviyo") without depending on real detection logic,
 * which packages/adapters already tests independently.
 */
class ScriptedTechAnalyzerAdapter implements TechAnalyzerAdapter {
  private readonly queues = new Map<string, Array<TechAnalyzerResult | Error>>();
  public readonly calls: string[] = [];

  queue(domain: string, response: TechAnalyzerResult | Error): void {
    const q = this.queues.get(domain) ?? [];
    q.push(response);
    this.queues.set(domain, q);
  }

  async analyze(domain: string): Promise<TechAnalyzerResult> {
    this.calls.push(domain);
    const q = this.queues.get(domain);
    const next = q?.shift();
    if (!next) {
      throw new Error(`ScriptedTechAnalyzerAdapter: no queued response left for ${domain}`);
    }
    if (next instanceof Error) throw next;
    return next;
  }

  async analyzeMany(domains: string[]): Promise<TechAnalyzerResult[]> {
    return Promise.all(domains.map((d) => this.analyze(d)));
  }
}

function okResult(technologyNames: string[], overrides: Partial<TechAnalyzerResult> = {}): TechAnalyzerResult {
  return {
    scanStatus: 'OK',
    technologies: technologyNames.map((name) => ({
      name,
      status: 'DETECTED',
      confidence: 80,
      evidence: [{ source: 'header', subject: 'x-powered-by', match: name, reliability: 0.8 }],
    })),
    detector: 'open_tech_analyzer',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function failedResult(scanStatus: 'BLOCKED' | 'ERROR' | 'INCONCLUSIVE'): TechAnalyzerResult {
  return { scanStatus, technologies: [], detector: 'open_tech_analyzer', timestamp: new Date().toISOString() };
}

let db: MetrivioDb;
let sqlite: Database.Database;
let adapter: ScriptedTechAnalyzerAdapter;
let service: TechnologyEnrichmentService;

beforeEach(() => {
  ({ db, sqlite } = createTestDb());
  adapter = new ScriptedTechAnalyzerAdapter();
  service = new TechnologyEnrichmentService(db, adapter);
});

afterEach(() => {
  sqlite.close();
});

describe('TechnologyEnrichmentService.scanDomain — persistence (P) and scan/tech status distinction (G)', () => {
  it('persists a technology_scans row and matching technology_detections rows for a successful scan', async () => {
    adapter.queue('store.com', okResult(['Shopify', 'Klaviyo']));
    const record = await service.scanDomain('store.com');

    const scanRows = await db.select().from(schema.technologyScans).where(eq(schema.technologyScans.id, record.scanId));
    expect(scanRows).toHaveLength(1);
    expect(scanRows[0]?.scanStatus).toBe('OK');
    expect(scanRows[0]?.companyDomain).toBe('store.com');

    const detectionRows = await db
      .select()
      .from(schema.technologyDetections)
      .where(eq(schema.technologyDetections.scanId, record.scanId));
    expect(detectionRows).toHaveLength(2);
    expect(detectionRows.map((r) => r.technologyName).sort()).toEqual(['Klaviyo', 'Shopify']);
  });

  it('a BLOCKED scan persists a technology_scans row with zero technology_detections rows — never a NOT_DETECTED standing in for the failure', async () => {
    adapter.queue('blocked.com', failedResult('BLOCKED'));
    const record = await service.scanDomain('blocked.com');

    expect(record.scanStatus).toBe('BLOCKED');
    const scanRows = await db.select().from(schema.technologyScans).where(eq(schema.technologyScans.id, record.scanId));
    expect(scanRows[0]?.scanStatus).toBe('BLOCKED');
    const detectionRows = await db
      .select()
      .from(schema.technologyDetections)
      .where(eq(schema.technologyDetections.scanId, record.scanId));
    expect(detectionRows).toHaveLength(0);
  });

  it('an INCONCLUSIVE scan likewise persists zero technology_detections rows', async () => {
    adapter.queue('inconclusive.com', failedResult('INCONCLUSIVE'));
    const record = await service.scanDomain('inconclusive.com');
    expect(record.scanStatus).toBe('INCONCLUSIVE');
    const detectionRows = await db
      .select()
      .from(schema.technologyDetections)
      .where(eq(schema.technologyDetections.scanId, record.scanId));
    expect(detectionRows).toHaveLength(0);
  });

  it('associates a scan with a prospectId when provided, and leaves it null when not', async () => {
    adapter.queue('a.com', okResult([]));
    adapter.queue('b.com', okResult([]));
    const withProspect = await service.scanDomain('a.com', { prospectId: 'prospect-123' });
    const withoutProspect = await service.scanDomain('b.com');
    expect(withProspect.prospectId).toBe('prospect-123');
    expect(withoutProspect.prospectId).toBeNull();
  });
});

describe('TechnologyEnrichmentService.scanDomain — adapter error handling (Q)', () => {
  it('a scan that throws unexpectedly (rather than resolving with scanStatus ERROR, as a conforming adapter would) still persists a durable ERROR row instead of crashing the caller', async () => {
    adapter.queue('crashy.com', new Error('adapter blew up unexpectedly'));
    const record = await service.scanDomain('crashy.com');

    expect(record.scanStatus).toBe('ERROR');
    const scanRows = await db.select().from(schema.technologyScans).where(eq(schema.technologyScans.id, record.scanId));
    expect(scanRows[0]?.scanStatus).toBe('ERROR');
  });

  it('an ERROR scan (whether thrown or resolved) never produces a NOT_DETECTED technology row', async () => {
    adapter.queue('erroring.com', failedResult('ERROR'));
    const record = await service.scanDomain('erroring.com');
    expect(record.technologies).toHaveLength(0);
  });
});

describe('TechnologyEnrichmentService — technology change detection (O)', () => {
  it('the first successful scan for a domain produces no change events (nothing to diff against)', async () => {
    adapter.queue('new-domain.com', okResult(['Shopify']));
    await service.scanDomain('new-domain.com');
    const events = await service.getChangeEvents('new-domain.com');
    expect(events).toHaveLength(0);
  });

  it('a technology present in a later successful scan but absent from the prior one produces an "added" event', async () => {
    adapter.queue('growing.com', okResult(['Shopify']));
    adapter.queue('growing.com', okResult(['Shopify', 'Klaviyo']));
    await service.scanDomain('growing.com');
    await service.scanDomain('growing.com');

    const events = await service.getChangeEvents('growing.com');
    expect(events).toHaveLength(1);
    expect(events[0]?.technologyName).toBe('Klaviyo');
    expect(events[0]?.changeType).toBe('added');
  });

  it('a technology present in the prior scan but absent from the later one produces a "removed" event', async () => {
    adapter.queue('shrinking.com', okResult(['Shopify', 'Gorgias']));
    adapter.queue('shrinking.com', okResult(['Shopify']));
    await service.scanDomain('shrinking.com');
    await service.scanDomain('shrinking.com');

    const events = await service.getChangeEvents('shrinking.com');
    expect(events).toHaveLength(1);
    expect(events[0]?.technologyName).toBe('Gorgias');
    expect(events[0]?.changeType).toBe('removed');
  });

  it('an unchanged technology across two scans produces no event', async () => {
    adapter.queue('stable.com', okResult(['Shopify']));
    adapter.queue('stable.com', okResult(['Shopify']));
    await service.scanDomain('stable.com');
    await service.scanDomain('stable.com');
    expect(await service.getChangeEvents('stable.com')).toHaveLength(0);
  });

  it('a failed scan in between two successful ones is not used as the diff baseline (only scanStatus OK scans are compared)', async () => {
    adapter.queue('flaky.com', okResult(['Shopify']));
    adapter.queue('flaky.com', failedResult('BLOCKED'));
    adapter.queue('flaky.com', okResult(['Shopify', 'Yotpo']));
    await service.scanDomain('flaky.com');
    await service.scanDomain('flaky.com');
    await service.scanDomain('flaky.com');

    const events = await service.getChangeEvents('flaky.com');
    expect(events).toHaveLength(1);
    expect(events[0]?.technologyName).toBe('Yotpo');
    expect(events[0]?.changeType).toBe('added');
  });

  it('change events reference both the earlier and later scan ids (dated, sourced evidence per DATABASE.md)', async () => {
    adapter.queue('trace.com', okResult(['Shopify']));
    adapter.queue('trace.com', okResult(['Shopify', 'Klaviyo']));
    const first = await service.scanDomain('trace.com');
    const second = await service.scanDomain('trace.com');

    const events = await service.getChangeEvents('trace.com');
    expect(events[0]?.earlierScanId).toBe(first.scanId);
    expect(events[0]?.laterScanId).toBe(second.scanId);
  });
});

describe('TechnologyEnrichmentService.scanBatch — batch analysis (L), partial failure (M)', () => {
  it('scans every domain and persists a technology_scans row for each', async () => {
    adapter.queue('one.com', okResult(['Shopify']));
    adapter.queue('two.com', okResult(['Klaviyo']));
    adapter.queue('three.com', okResult([]));

    const outcome = await service.scanBatch(['one.com', 'two.com', 'three.com']);

    expect(outcome.results).toHaveLength(3);
    expect(outcome.results.every((r) => r.scanStatus === 'OK')).toBe(true);
    for (const r of outcome.results) {
      const rows = await db.select().from(schema.technologyScans).where(eq(schema.technologyScans.companyDomain, r.companyDomain));
      expect(rows).toHaveLength(1);
    }
  });

  it('one domain scanning as BLOCKED/ERROR does not lose or block the successful results for the others', async () => {
    adapter.queue('good-a.com', okResult(['Shopify']));
    adapter.queue('bad.com', failedResult('ERROR'));
    adapter.queue('good-b.com', okResult(['Klaviyo']));

    const outcome = await service.scanBatch(['good-a.com', 'bad.com', 'good-b.com']);

    const byDomain = Object.fromEntries(outcome.results.map((r) => [r.companyDomain, r]));
    expect(byDomain['good-a.com']?.scanStatus).toBe('OK');
    expect(byDomain['good-b.com']?.scanStatus).toBe('OK');
    expect(byDomain['bad.com']?.scanStatus).toBe('ERROR');
  });

  it('the batch job_run reaches status completed even when some domains failed at the scan level (a scan-level ERROR is not a batch-level failure)', async () => {
    adapter.queue('ok.com', okResult([]));
    adapter.queue('fails.com', failedResult('ERROR'));
    const outcome = await service.scanBatch(['ok.com', 'fails.com']);

    const jobRows = await db.select().from(schema.jobRuns).where(eq(schema.jobRuns.id, outcome.jobId));
    expect(jobRows[0]?.status).toBe('completed');
  });
});

describe('TechnologyEnrichmentService.scanBatch — job checkpoint/resume (N)', () => {
  it('resuming a job whose checkpoint already has some domains completed only re-scans the remaining domains', async () => {
    adapter.queue('already-done.com', okResult(['Shopify']));
    const firstRun = await service.scanBatch(['already-done.com', 'not-yet.com'].slice(0, 1));
    expect(firstRun.results).toHaveLength(1);
    expect(adapter.calls).toEqual(['already-done.com']);

    adapter.queue('not-yet.com', okResult(['Klaviyo']));
    const resumed = await service.scanBatch(['already-done.com', 'not-yet.com'], { resumeJobId: firstRun.jobId });

    // 'already-done.com' must not be scanned again — only 'not-yet.com' should trigger a new adapter call.
    expect(adapter.calls).toEqual(['already-done.com', 'not-yet.com']);
    expect(resumed.jobId).toBe(firstRun.jobId);
    const byDomain = Object.fromEntries(resumed.results.map((r) => [r.companyDomain, r]));
    expect(byDomain['already-done.com']?.scanStatus).toBe('OK');
    expect(byDomain['not-yet.com']?.scanStatus).toBe('OK');
  });

  it('throws a clear error when asked to resume a job_run id that does not exist', async () => {
    await expect(service.scanBatch(['x.com'], { resumeJobId: 'does-not-exist' })).rejects.toThrow(/no job_run found/);
  });

  it('the checkpoint is updated after every domain, not only at the end (so a crash mid-batch would lose nothing already scanned)', async () => {
    adapter.queue('first.com', okResult([]));
    adapter.queue('second.com', okResult([]));
    const outcome = await service.scanBatch(['first.com', 'second.com'], { concurrency: 1 });

    const jobRows = await db.select().from(schema.jobRuns).where(eq(schema.jobRuns.id, outcome.jobId));
    const checkpoint = JSON.parse(jobRows[0]?.checkpoint ?? '{}') as { completed: Record<string, unknown> };
    expect(Object.keys(checkpoint.completed).sort()).toEqual(['first.com', 'second.com']);
  });
});
