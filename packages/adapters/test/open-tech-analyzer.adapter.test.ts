import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AnalyzeResult } from 'opentechalyzer';

/**
 * All tests here are against a mocked `opentechalyzer` module (fixtures),
 * never a live network call — this environment's egress policy blocks
 * arbitrary outbound HTTP, and BUILD_PLAN.md Stage 2 itself requires unit
 * tests against mocked responses with any live integration path kept
 * separate and manually run. No live OpenTechAnalyzer scan is performed in
 * this suite.
 */
const otaAnalyze = vi.fn();
const otaAnalyzeMany = vi.fn();
vi.mock('opentechalyzer', () => ({
  analyze: (...args: unknown[]) => otaAnalyze(...args),
  analyzeMany: (...args: unknown[]) => otaAnalyzeMany(...args),
}));

const { OpenTechAnalyzerAdapter, WATCHED_TECHNOLOGIES } = await import('../src/open-tech-analyzer.adapter.js');

function fixtureResult(overrides: Partial<AnalyzeResult> = {}): AnalyzeResult {
  return {
    url: 'https://example-store.com',
    finalUrl: 'https://example-store.com',
    status: 200,
    detections: [],
    byCategory: {},
    warnings: [],
    timings: {},
    meta: {},
    databaseVersion: 'test-fixture',
    fingerprintCount: 588,
    analyzedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function fixtureDetection(overrides: Partial<AnalyzeResult['detections'][number]> = {}) {
  return {
    name: 'Shopify',
    categories: ['ecommerce' as const],
    confidence: 92,
    inferred: false,
    evidence: [{ source: 'header' as const, subject: 'x-shopify-stage', pattern: '.*', match: 'production', reliability: 0.9 }],
    ...overrides,
  };
}

beforeEach(() => {
  otaAnalyze.mockReset();
  otaAnalyzeMany.mockReset();
});

describe('OpenTechAnalyzerAdapter.analyze', () => {
  it('A/B: a successful scan with a detected technology maps to scanStatus OK and a DETECTED technology, preserving confidence/evidence/accountIds', async () => {
    otaAnalyze.mockResolvedValue(
      fixtureResult({
        detections: [fixtureDetection({ name: 'Shopify', confidence: 92, accountIds: ['GTM-M92FB6B'] })],
      })
    );
    const adapter = new OpenTechAnalyzerAdapter();
    const result = await adapter.analyze('example-store.com');

    expect(result.scanStatus).toBe('OK');
    expect(result.detector).toBe('open_tech_analyzer');
    const shopify = result.technologies.find((t) => t.name === 'Shopify');
    expect(shopify).toBeDefined();
    expect(shopify?.status).toBe('DETECTED');
    expect(shopify?.confidence).toBe(92);
    expect(shopify?.accountIds).toEqual(['GTM-M92FB6B']);
  });

  it('C: a successful scan with no matching technology is trusted as a real negative — watched technologies are NOT_DETECTED, not omitted or errored', async () => {
    otaAnalyze.mockResolvedValue(fixtureResult({ detections: [] }));
    const adapter = new OpenTechAnalyzerAdapter();
    const result = await adapter.analyze('no-tech-site.com');

    expect(result.scanStatus).toBe('OK');
    expect(result.technologies).toHaveLength(WATCHED_TECHNOLOGIES.length);
    for (const tech of result.technologies) {
      expect(tech.status).toBe('NOT_DETECTED');
      expect(tech.confidence).toBe(0);
    }
    expect(result.technologies.map((t) => t.name).sort()).toEqual([...WATCHED_TECHNOLOGIES].sort());
  });

  it('D: a resolved scan with an explicit-denial HTTP status (403) is BLOCKED, with zero technology entries', async () => {
    otaAnalyze.mockResolvedValue(fixtureResult({ status: 403, detections: [] }));
    const adapter = new OpenTechAnalyzerAdapter();
    const result = await adapter.analyze('blocked-site.com');

    expect(result.scanStatus).toBe('BLOCKED');
    expect(result.technologies).toHaveLength(0);
  });

  it('D2: a 429 rate-limit response is also classified BLOCKED', async () => {
    otaAnalyze.mockResolvedValue(fixtureResult({ status: 429, detections: [] }));
    const adapter = new OpenTechAnalyzerAdapter();
    const result = await adapter.analyze('rate-limited-site.com');
    expect(result.scanStatus).toBe('BLOCKED');
    expect(result.technologies).toHaveLength(0);
  });

  it('E: a thrown error (network failure/timeout — the only case OpenTechAnalyzer itself throws for) maps to scanStatus ERROR, never NOT_DETECTED', async () => {
    otaAnalyze.mockRejectedValue(new Error('fetch failed: getaddrinfo ENOTFOUND unreachable-domain.invalid'));
    const adapter = new OpenTechAnalyzerAdapter();
    const result = await adapter.analyze('unreachable-domain.invalid');

    expect(result.scanStatus).toBe('ERROR');
    expect(result.technologies).toHaveLength(0);
  });

  it('F: a resolved scan with an unexpected non-2xx/3xx, non-blocked status (500) is INCONCLUSIVE, with zero technology entries', async () => {
    otaAnalyze.mockResolvedValue(fixtureResult({ status: 500, detections: [] }));
    const adapter = new OpenTechAnalyzerAdapter();
    const result = await adapter.analyze('erroring-site.com');

    expect(result.scanStatus).toBe('INCONCLUSIVE');
    expect(result.technologies).toHaveLength(0);
  });

  it('G: scan-level status and technology-level status are structurally independent — a BLOCKED/ERROR/INCONCLUSIVE scan can never carry a NOT_DETECTED row', async () => {
    for (const status of [403, 500]) {
      otaAnalyze.mockResolvedValue(fixtureResult({ status, detections: [] }));
      const adapter = new OpenTechAnalyzerAdapter();
      const result = await adapter.analyze('site.com');
      expect(result.technologies.every((t) => t.status !== 'NOT_DETECTED')).toBe(true);
      expect(result.technologies).toHaveLength(0);
    }
    otaAnalyze.mockRejectedValue(new Error('timeout'));
    const adapter = new OpenTechAnalyzerAdapter();
    const errored = await adapter.analyze('site.com');
    expect(errored.technologies).toHaveLength(0);
  });

  it('H: evidence normalization preserves source/subject/match/reliability exactly', async () => {
    otaAnalyze.mockResolvedValue(
      fixtureResult({
        detections: [
          fixtureDetection({
            name: 'Klaviyo',
            evidence: [
              { source: 'script-src', subject: 'script[src]', pattern: 'klaviyo\\.com', match: 'https://a.klaviyo.com/x.js', reliability: 0.85 },
            ],
          }),
        ],
      })
    );
    const adapter = new OpenTechAnalyzerAdapter();
    const result = await adapter.analyze('store.com');
    const klaviyo = result.technologies.find((t) => t.name === 'Klaviyo');
    expect(klaviyo?.evidence).toEqual([
      { source: 'script-src', subject: 'script[src]', match: 'https://a.klaviyo.com/x.js', reliability: 0.85 },
    ]);
  });

  it('I: confidence and reliability values pass through unchanged (not re-derived)', async () => {
    otaAnalyze.mockResolvedValue(
      fixtureResult({
        detections: [fixtureDetection({ name: 'GTM', confidence: 63, evidence: [{ source: 'html', subject: 'html', pattern: 'x', match: 'GTM-XXXX', reliability: 0.42 }] })],
      })
    );
    const adapter = new OpenTechAnalyzerAdapter();
    const result = await adapter.analyze('site.com');
    const gtm = result.technologies.find((t) => t.name === 'GTM');
    expect(gtm?.confidence).toBe(63);
    expect(gtm?.evidence[0]?.reliability).toBe(0.42);
  });

  it('J: render defaults to true per RESEARCH.md §2A.6, and an explicit override is honored', async () => {
    otaAnalyze.mockResolvedValue(fixtureResult());
    const adapter = new OpenTechAnalyzerAdapter();

    await adapter.analyze('site.com');
    expect(otaAnalyze).toHaveBeenLastCalledWith('site.com', expect.objectContaining({ render: true }));

    await adapter.analyze('site.com', { render: false });
    expect(otaAnalyze).toHaveBeenLastCalledWith('site.com', expect.objectContaining({ render: false }));
  });

  it('K: crawl defaults to 5 per RESEARCH.md §2A.6, and an explicit override is honored', async () => {
    otaAnalyze.mockResolvedValue(fixtureResult());
    const adapter = new OpenTechAnalyzerAdapter();

    await adapter.analyze('site.com');
    expect(otaAnalyze).toHaveBeenLastCalledWith('site.com', expect.objectContaining({ crawl: 5 }));

    await adapter.analyze('site.com', { crawl: 2 });
    expect(otaAnalyze).toHaveBeenLastCalledWith('site.com', expect.objectContaining({ crawl: 2 }));
  });

  it('default first-scan fields per ARCHITECTURE.md §3.1 (contact/social/company) are passed through', async () => {
    otaAnalyze.mockResolvedValue(fixtureResult());
    const adapter = new OpenTechAnalyzerAdapter();
    await adapter.analyze('site.com');
    expect(otaAnalyze).toHaveBeenLastCalledWith('site.com', expect.objectContaining({ fields: ['contact', 'social', 'company'] }));
  });

  it('does not assert Shopify Plus as its own fingerprint, per RESEARCH.md §2A.7 (not independently confirmed)', async () => {
    otaAnalyze.mockResolvedValue(fixtureResult({ detections: [] }));
    const adapter = new OpenTechAnalyzerAdapter();
    const result = await adapter.analyze('site.com');
    expect(result.technologies.some((t) => t.name === 'Shopify Plus')).toBe(false);
  });
});

describe('OpenTechAnalyzerAdapter.analyzeMany (L: batch analysis)', () => {
  it('is index-aligned with the input domains and preserves per-domain success/failure independently', async () => {
    otaAnalyzeMany.mockResolvedValue([
      { url: 'good.com', result: fixtureResult({ detections: [fixtureDetection({ name: 'Shopify' })] }) },
      { url: 'dead.com', error: 'fetch failed' },
      { url: 'blocked.com', result: fixtureResult({ status: 403, detections: [] }) },
    ]);
    const adapter = new OpenTechAnalyzerAdapter();
    const results = await adapter.analyzeMany(['good.com', 'dead.com', 'blocked.com']);

    expect(results).toHaveLength(3);
    expect(results[0]?.scanStatus).toBe('OK');
    expect(results[0]?.technologies.some((t) => t.name === 'Shopify' && t.status === 'DETECTED')).toBe(true);
    expect(results[1]?.scanStatus).toBe('ERROR');
    expect(results[1]?.technologies).toHaveLength(0);
    expect(results[2]?.scanStatus).toBe('BLOCKED');
  });

  it('M: one dead domain does not affect the successful results for the others', async () => {
    otaAnalyzeMany.mockResolvedValue([
      { url: 'a.com', result: fixtureResult({ detections: [fixtureDetection({ name: 'Klaviyo' })] }) },
      { url: 'b.com', error: 'timeout' },
      { url: 'c.com', result: fixtureResult({ detections: [fixtureDetection({ name: 'Gorgias' })] }) },
    ]);
    const adapter = new OpenTechAnalyzerAdapter();
    const results = await adapter.analyzeMany(['a.com', 'b.com', 'c.com']);
    expect(results[0]?.scanStatus).toBe('OK');
    expect(results[2]?.scanStatus).toBe('OK');
    expect(results[1]?.scanStatus).toBe('ERROR');
  });

  it('does not pass a concurrency option — relies on opentechalyzer default, per instruction not to invent a larger limit', async () => {
    otaAnalyzeMany.mockResolvedValue([]);
    const adapter = new OpenTechAnalyzerAdapter();
    await adapter.analyzeMany([]);
    const [, calledOpts] = otaAnalyzeMany.mock.calls[0] as [string[], Record<string, unknown>];
    expect(calledOpts).not.toHaveProperty('concurrency');
  });
});
