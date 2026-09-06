import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { schema, type MetrivioDb, type TechAnalyzerAdapter, type TechAnalyzerResult } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { TechnologyEnrichmentService } from '../../src/enrichment/technology-enrichment.js';
import { EvidenceAssemblyService } from '../../src/evidence-assembly/evidence-assembly-service.js';

/** Mirrors Stage 2's own ScriptedTechAnalyzerAdapter test double — never opentechalyzer, never a real network call. */
class ScriptedTechAnalyzerAdapter implements TechAnalyzerAdapter {
  private readonly queues = new Map<string, TechAnalyzerResult[]>();
  public readonly calls: string[] = [];

  queue(domain: string, response: TechAnalyzerResult): void {
    const q = this.queues.get(domain) ?? [];
    q.push(response);
    this.queues.set(domain, q);
  }

  async analyze(domain: string): Promise<TechAnalyzerResult> {
    this.calls.push(domain);
    const q = this.queues.get(domain);
    const next = q?.shift();
    if (!next) throw new Error(`no queued response for ${domain}`);
    return next;
  }

  async analyzeMany(domains: string[]): Promise<TechAnalyzerResult[]> {
    return Promise.all(domains.map((d) => this.analyze(d)));
  }
}

function okScan(technologyNames: string[]): TechAnalyzerResult {
  return {
    scanStatus: 'OK',
    technologies: technologyNames.map((name) => ({ name, status: 'DETECTED', confidence: 90, evidence: [] })),
    detector: 'open_tech_analyzer',
    timestamp: new Date().toISOString(),
  };
}

let db: MetrivioDb;
let sqlite: Database.Database;
let techAdapter: ScriptedTechAnalyzerAdapter;
let technologyEnrichment: TechnologyEnrichmentService;
let service: EvidenceAssemblyService;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  techAdapter = new ScriptedTechAnalyzerAdapter();
  technologyEnrichment = new TechnologyEnrichmentService(db, techAdapter);
  service = new EvidenceAssemblyService(db, technologyEnrichment);
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

async function insertEvidence(prospectId: string, overrides: Partial<typeof schema.evidence.$inferInsert>): Promise<void> {
  await db.insert(schema.evidence).values({
    id: uuid(),
    prospectId,
    evidenceType: 'decision_maker_signal',
    signalCategory: 'role_founder_or_ceo',
    evidenceTier: 'LIKELY',
    rawValue: 'test',
    capturedAt: new Date().toISOString(),
    capturedBy: 'system',
    ...overrides,
  });
}

describe('EvidenceAssemblyService.assembleAndScore — X evidence', () => {
  it('founder evidence contributes decision-maker points via the real Stage 3 scorer', async () => {
    const prospectId = await insertProspect();
    await insertEvidence(prospectId, { evidenceType: 'decision_maker_signal', signalCategory: 'role_founder_or_ceo' });
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.decisionMaker.points).toBe(8);
  });

  it('CEO evidence (same fixed category) contributes the same decision-maker points', async () => {
    const prospectId = await insertProspect();
    await insertEvidence(prospectId, { evidenceType: 'decision_maker_signal', signalCategory: 'role_founder_or_ceo', rawValue: 'CEO' });
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.decisionMaker.points).toBe(8);
  });

  it('an ordinary employee (execution_only) contributes zero decision-maker points, no crash, no exclusion', async () => {
    const prospectId = await insertProspect();
    await insertEvidence(prospectId, { evidenceType: 'decision_maker_signal', signalCategory: 'role_execution_only' });
    // A paid-acquisition fact so this test isolates decision-maker behavior from the
    // separately-tested "zero paid-acquisition facts triggers the no-activity exclusion" case.
    await insertEvidence(prospectId, { evidenceType: 'paid_acquisition_signal', signalCategory: 'meta_ad_active_30d' });
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.decisionMaker.points).toBe(0);
    expect(result.scoreResult.exclusionTriggered).toBe(false);
  });

  it('no decision-maker evidence at all leaves decisionMaker at 0 (unknown, not assumed)', async () => {
    const prospectId = await insertProspect();
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.decisionMaker.points).toBe(0);
  });

  it('a website-derived company domain does not by itself add any scoring points (company_identification is not a scored evidence type)', async () => {
    const prospectId = await insertProspect({ companyDomain: 'store.com' });
    await insertEvidence(prospectId, { evidenceType: 'company_identification', signalCategory: 'website_domain', rawValue: 'store.com' });
    await insertEvidence(prospectId, { evidenceType: 'paid_acquisition_signal', signalCategory: 'meta_ad_active_30d' });
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.exclusionTriggered).toBe(false);
    expect(result.scoreResult.score).toBe(10); // only the paid_acquisition_signal fact (LIKELY, 25 x 0.40) scores anything
  });

  it('an unresolved domain (null) is handled without error — technology enrichment is simply skipped', async () => {
    const prospectId = await insertProspect({ companyDomain: null });
    const result = await service.assembleAndScore(prospectId);
    expect(result.technologyScanPerformed).toBe(false);
    expect(techAdapter.calls).toHaveLength(0);
  });

  it('a qualifying paid-media job posting (already written by Stage 4B as evidence) contributes paid-acquisition points', async () => {
    const prospectId = await insertProspect();
    await insertEvidence(prospectId, {
      evidenceType: 'paid_acquisition_signal',
      signalCategory: 'paid_media_job_posting_90d',
      sourceUrl: 'https://x.com/a/status/1',
      capturedAt: '2026-08-01T00:00:00.000Z',
    });
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.paidAcquisition.evidenceTier).toBe('LIKELY');
    expect(result.scoreResult.factorBreakdown.paidAcquisition.points).toBe(10); // 25 x 0.40, 1 category
  });

  it('a generic hiring observation never reaches this layer as paid-acquisition evidence (Stage 4B already filters it before persistence)', async () => {
    // No paid_acquisition_signal row inserted at all — simulating that Stage 4B's own
    // narrow matcher rejected a generic "we're hiring" tweet and wrote nothing.
    const prospectId = await insertProspect();
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.paidAcquisition.evidenceTier).toBe('UNKNOWN');
  });
});

describe('EvidenceAssemblyService.assembleAndScore — revenue', () => {
  it('an explicit revenue-statement evidence row (evidenceTier=CONFIRMED at the row level) is NOT enough on its own to reach CONFIRMED — only the confirmed_revenue_statement category does', async () => {
    const prospectId = await insertProspect();
    // A row of the WRONG category, even tagged CONFIRMED at the row level, must never confirm revenue.
    await insertEvidence(prospectId, { evidenceType: 'revenue_signal', signalCategory: 'employee_count_band', evidenceTier: 'CONFIRMED' });
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.revenueDisclosureStatus).not.toBe('CONFIRMED');
  });

  it('the confirmed_revenue_statement category does reach CONFIRMED, per Stage 3s own rule, when explicitly present', async () => {
    const prospectId = await insertProspect();
    await insertEvidence(prospectId, { evidenceType: 'revenue_signal', signalCategory: 'confirmed_revenue_statement' });
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.revenueDisclosureStatus).toBe('CONFIRMED');
    expect(result.scoreResult.factorBreakdown.revenueFit.points).toBe(25);
  });

  it('follower count never creates revenue evidence (ProfileResult data isnt even part of this layers input)', async () => {
    const prospectId = await insertProspect();
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.revenueFit.evidenceTier).toBe('UNKNOWN');
  });

  it('technology detection never creates revenue evidence (Shopify alone, even with Shopify Plus absent-vs-present ambiguity, stays out of revenue_signal)', async () => {
    const prospectId = await insertProspect({ companyDomain: 'store.com' });
    techAdapter.queue('store.com', okScan(['Shopify']));
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.revenueFit.evidenceTier).toBe('UNKNOWN');
  });

  it('ad activity (paid_acquisition_signal facts) never creates revenue evidence on its own', async () => {
    const prospectId = await insertProspect();
    await insertEvidence(prospectId, { evidenceType: 'paid_acquisition_signal', signalCategory: 'meta_ad_active_30d' });
    await insertEvidence(prospectId, { evidenceType: 'paid_acquisition_signal', signalCategory: 'google_ads_active' });
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.revenueFit.evidenceTier).toBe('UNKNOWN');
  });
});

describe('EvidenceAssemblyService.assembleAndScore — paid acquisition', () => {
  it('a Meta mention alone (no fixed-category evidence row) never equals paid acquisition', async () => {
    const prospectId = await insertProspect();
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.paidAcquisition.evidenceTier).toBe('UNKNOWN');
  });

  it('Meta Pixel technology detection never equals paid acquisition', async () => {
    const prospectId = await insertProspect({ companyDomain: 'store.com' });
    techAdapter.queue('store.com', okScan(['Meta Pixel']));
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.paidAcquisition.evidenceTier).toBe('UNKNOWN');
  });

  it('a Google mention alone never equals paid acquisition', async () => {
    const prospectId = await insertProspect();
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.paidAcquisition.points).toBe(0);
  });

  it('a qualifying paid-media job post evidence row does qualify as LIKELY paid-acquisition evidence', async () => {
    const prospectId = await insertProspect();
    await insertEvidence(prospectId, { evidenceType: 'paid_acquisition_signal', signalCategory: 'paid_media_job_posting_90d', sourceUrl: 'https://x.com/a/status/1' });
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.paidAcquisition.evidenceTier).toBe('LIKELY');
  });
});

describe('EvidenceAssemblyService.assembleAndScore — maturity (technology integration)', () => {
  it('Shopify Plus mapping: not currently derivable, evidenceTier stays UNKNOWN even with plain Shopify detected', async () => {
    const prospectId = await insertProspect({ companyDomain: 'store.com' });
    techAdapter.queue('store.com', okScan(['Shopify']));
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.revenueFit.evidenceTier).toBe('UNKNOWN');
  });

  it('2+ retention tools detected contributes 5 maturity points', async () => {
    const prospectId = await insertProspect({ companyDomain: 'store.com' });
    techAdapter.queue('store.com', okScan(['Klaviyo', 'Gorgias']));
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.maturity.points).toBeGreaterThanOrEqual(5);
  });

  it('an analytics tag detected contributes 3 maturity points', async () => {
    const prospectId = await insertProspect({ companyDomain: 'store.com' });
    techAdapter.queue('store.com', okScan(['GA4']));
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.maturity.points).toBe(3);
  });

  it('multiple retention tools + analytics tag together contribute 8 points (5+3)', async () => {
    const prospectId = await insertProspect({ companyDomain: 'store.com' });
    techAdapter.queue('store.com', okScan(['Klaviyo', 'Recharge', 'Meta Pixel']));
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.maturity.points).toBe(8);
  });

  it('a failed technology scan produces zero positive maturity evidence, not a false negative treated as absence', async () => {
    const prospectId = await insertProspect({ companyDomain: 'blocked-store.com' });
    techAdapter.queue('blocked-store.com', { scanStatus: 'BLOCKED', technologies: [], detector: 'open_tech_analyzer', timestamp: new Date().toISOString() });
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.maturity.points).toBe(0);
    // The scan itself is still recorded (Stage 2 behavior, unchanged) — just contributes no positive fact.
    const scans = await db.select().from(schema.technologyScans).where(eq(schema.technologyScans.companyDomain, 'blocked-store.com'));
    expect(scans[0]?.scanStatus).toBe('BLOCKED');
  });

  it('reuses an existing successful scan rather than rescanning the domain', async () => {
    const prospectId = await insertProspect({ companyDomain: 'store.com' });
    techAdapter.queue('store.com', okScan(['GA4']));
    await service.assembleAndScore(prospectId); // first call performs the scan

    const prospectId2 = await insertProspect({ companyDomain: 'store.com' });
    const result2 = await service.assembleAndScore(prospectId2); // second prospect, same domain
    expect(result2.technologyScanPerformed).toBe(false);
    expect(techAdapter.calls).toEqual(['store.com']); // only scanned once
    expect(result2.scoreResult.factorBreakdown.maturity.points).toBe(3); // still sees the GA4 fact from the shared scan
  });

  it('forceRescan performs a new scan even when a successful one already exists', async () => {
    const prospectId = await insertProspect({ companyDomain: 'store.com' });
    techAdapter.queue('store.com', okScan(['GA4']));
    await service.assembleAndScore(prospectId);
    techAdapter.queue('store.com', okScan(['GA4', 'Klaviyo', 'Gorgias']));
    const result2 = await service.assembleAndScore(prospectId, { forceRescan: true });
    expect(result2.technologyScanPerformed).toBe(true);
    expect(techAdapter.calls).toEqual(['store.com', 'store.com']);
  });
});

describe('EvidenceAssemblyService.assembleAndScore — DTC', () => {
  it('no dtc_signal evidence leaves DTC fit at 0 points (UNKNOWN), regardless of X/tech context', async () => {
    const prospectId = await insertProspect({ companyDomain: 'store.com' });
    techAdapter.queue('store.com', okScan(['Shopify', 'Klaviyo', 'Gorgias']));
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.dtcFit.points).toBe(0);
  });

  it('an explicit confirmed_dtc_with_owned_funnel evidence row (the only legitimate source) does contribute the full 5 points', async () => {
    const prospectId = await insertProspect();
    await insertEvidence(prospectId, { evidenceType: 'dtc_signal', signalCategory: 'confirmed_dtc_with_owned_funnel' });
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.dtcFit.points).toBe(5);
  });
});

describe('EvidenceAssemblyService.assembleAndScore — triggers', () => {
  it('a generic growth tweet observation (no trigger_signal evidence written) creates no trigger points', async () => {
    const prospectId = await insertProspect();
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.trigger.points).toBe(0);
  });

  it('a valid, sourced trigger_signal evidence row does create trigger points', async () => {
    const prospectId = await insertProspect();
    await insertEvidence(prospectId, { evidenceType: 'trigger_signal', signalCategory: 'funding_growth_announcement', sourceUrl: 'https://x.com/a/status/1' });
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.trigger.points).toBe(10);
  });

  it('an unsourced trigger_signal row never creates trigger points', async () => {
    const prospectId = await insertProspect();
    await insertEvidence(prospectId, { evidenceType: 'trigger_signal', signalCategory: 'funding_growth_announcement', sourceUrl: null });
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.trigger.points).toBe(0);
  });
});

describe('EvidenceAssemblyService.assembleAndScore — evidence-tier boundary regression (instruction: row tier must never alter Stage 3 arithmetic)', () => {
  it('a paid_acquisition_signal row stored with evidenceTier=CONFIRMED at the row level does not upgrade the factor past what the fixed category count actually earns', async () => {
    const prospectId = await insertProspect();
    // Only ONE real category present (meta_ad_active_30d) — should be LIKELY (10 pts),
    // even though this specific row is (incorrectly, for test purposes) tagged CONFIRMED at the row level.
    await insertEvidence(prospectId, { evidenceType: 'paid_acquisition_signal', signalCategory: 'meta_ad_active_30d', evidenceTier: 'CONFIRMED' });
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.paidAcquisition.evidenceTier).toBe('LIKELY');
    expect(result.scoreResult.factorBreakdown.paidAcquisition.points).toBe(10);
  });

  it('corroboration behavior is unchanged: 2 distinct categories reach STRONG_EVIDENCE regardless of each rows own stored tier', async () => {
    const prospectId = await insertProspect();
    await insertEvidence(prospectId, { evidenceType: 'paid_acquisition_signal', signalCategory: 'meta_ad_active_30d', evidenceTier: 'LIKELY' });
    await insertEvidence(prospectId, { evidenceType: 'paid_acquisition_signal', signalCategory: 'google_ads_active', evidenceTier: 'LIKELY' });
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.factorBreakdown.paidAcquisition.evidenceTier).toBe('STRONG_EVIDENCE');
    expect(result.scoreResult.factorBreakdown.paidAcquisition.points).toBe(20);
  });
});

describe('EvidenceAssemblyService.assembleAndScore — golden scoring reproduction (exact, not fixed)', () => {
  it('reproduces the documented C-tier total of 63 through the full assembly path', async () => {
    const prospectId = await insertProspect({ companyDomain: 'store.com' });
    // Revenue-Fit: Shopify Plus only = 1 category -> LIKELY -> 10.
    await insertEvidence(prospectId, { evidenceType: 'revenue_signal', signalCategory: 'shopify_plus_detected' });
    // Paid Acquisition: Meta + Google = 2 categories -> STRONG_EVIDENCE -> 20.
    await insertEvidence(prospectId, { evidenceType: 'paid_acquisition_signal', signalCategory: 'meta_ad_active_30d' });
    await insertEvidence(prospectId, { evidenceType: 'paid_acquisition_signal', signalCategory: 'google_ads_active' });
    // Maturity: 2+ channels(5) + 1 retention tool only, below threshold (0) + GA4(3) + single product line(0) = 8.
    techAdapter.queue('store.com', okScan(['GA4']));
    await insertEvidence(prospectId, { evidenceType: 'maturity_signal', signalCategory: 'two_or_more_paid_channels' });
    // Decision-maker: director, no corroborating authority signal (3) + public visibility (4) + correct profile (3) = 10.
    await insertEvidence(prospectId, { evidenceType: 'decision_maker_signal', signalCategory: 'role_other_marketing_adjacent' });
    await insertEvidence(prospectId, { evidenceType: 'decision_maker_signal', signalCategory: 'public_visibility' });
    await insertEvidence(prospectId, { evidenceType: 'decision_maker_signal', signalCategory: 'correct_profile_identified' });
    // Trigger: 1 verified = 10.
    await insertEvidence(prospectId, { evidenceType: 'trigger_signal', signalCategory: 'active_growth_hiring', sourceUrl: 'https://x.com/a/status/1' });
    // Business model: DTC confirmed = 5.
    await insertEvidence(prospectId, { evidenceType: 'dtc_signal', signalCategory: 'confirmed_dtc_with_owned_funnel' });

    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.score).toBe(63);
    expect(result.scoreResult.tier).toBe('C');
  });

  it('reproduces the documented Reject total of 24 through the full assembly path (0 categories -> UNKNOWN Revenue-Fit, no partial credit)', async () => {
    const prospectId = await insertProspect();
    // Revenue-Fit: 0 categories -> UNKNOWN -> 0.
    // Paid Acquisition: 1 category (Meta only) -> LIKELY -> 10.
    await insertEvidence(prospectId, { evidenceType: 'paid_acquisition_signal', signalCategory: 'meta_ad_active_30d' });
    // Maturity: GA4 detected (3), nothing else = 3.
    await insertEvidence(prospectId, { evidenceType: 'maturity_signal', signalCategory: 'analytics_tag_detected' });
    // Decision-maker: "Marketing Manager," no authority signal (3) + no public visibility (0) + correct profile (3) = 6.
    await insertEvidence(prospectId, { evidenceType: 'decision_maker_signal', signalCategory: 'role_other_marketing_adjacent' });
    await insertEvidence(prospectId, { evidenceType: 'decision_maker_signal', signalCategory: 'correct_profile_identified' });
    // Trigger: 0. Business model: DTC confirmed = 5.
    await insertEvidence(prospectId, { evidenceType: 'dtc_signal', signalCategory: 'confirmed_dtc_with_owned_funnel' });

    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.score).toBe(24);
    expect(result.scoreResult.tier).toBe('Reject');
  });

  it('a maximally-positive input caps at exactly 100 -> A through the full assembly path', async () => {
    const prospectId = await insertProspect({ companyDomain: 'topstore.com' });
    await insertEvidence(prospectId, { evidenceType: 'revenue_signal', signalCategory: 'confirmed_revenue_statement' });
    await insertEvidence(prospectId, { evidenceType: 'paid_acquisition_signal', signalCategory: 'confirmed_spend_statement' });
    techAdapter.queue('topstore.com', okScan(['Klaviyo', 'Recharge', 'GA4']));
    await insertEvidence(prospectId, { evidenceType: 'maturity_signal', signalCategory: 'two_or_more_paid_channels' });
    await insertEvidence(prospectId, { evidenceType: 'maturity_signal', signalCategory: 'two_or_more_product_lines' });
    await insertEvidence(prospectId, { evidenceType: 'decision_maker_signal', signalCategory: 'role_founder_or_ceo' });
    await insertEvidence(prospectId, { evidenceType: 'decision_maker_signal', signalCategory: 'public_visibility' });
    await insertEvidence(prospectId, { evidenceType: 'decision_maker_signal', signalCategory: 'correct_profile_identified' });
    await insertEvidence(prospectId, { evidenceType: 'trigger_signal', signalCategory: 'new_product_launch', sourceUrl: 'https://x.com/a/status/1' });
    await insertEvidence(prospectId, { evidenceType: 'trigger_signal', signalCategory: 'funding_growth_announcement', sourceUrl: 'https://x.com/a/status/2' });
    await insertEvidence(prospectId, { evidenceType: 'dtc_signal', signalCategory: 'confirmed_dtc_with_owned_funnel' });

    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.score).toBe(100);
    expect(result.scoreResult.tier).toBe('A');
  });
});

describe('EvidenceAssemblyService.assembleAndScore — exclusions', () => {
  it('zero paid-acquisition facts derives the existing no-paid-activity exclusion (Stage 3s own established behavior, unchanged)', async () => {
    const prospectId = await insertProspect();
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.exclusionTriggered).toBe(true);
    expect(result.scoreResult.score).toBeNull();
  });

  it('a single paid-acquisition fact clears the derived no-paid-activity exclusion', async () => {
    const prospectId = await insertProspect();
    await insertEvidence(prospectId, { evidenceType: 'paid_acquisition_signal', signalCategory: 'meta_ad_active_30d' });
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.exclusionTriggered).toBe(false);
  });

  it('the other three exclusions default to false (not excluded) absent any explicit override — UNKNOWN is not the same as excluded', async () => {
    const prospectId = await insertProspect();
    await insertEvidence(prospectId, { evidenceType: 'paid_acquisition_signal', signalCategory: 'meta_ad_active_30d' });
    const result = await service.assembleAndScore(prospectId);
    expect(result.scoreResult.exclusionTriggered).toBe(false);
  });

  it('an explicit exclusion override (a real, independently-verified determination) is respected and overrides positive evidence', async () => {
    const prospectId = await insertProspect();
    await insertEvidence(prospectId, { evidenceType: 'decision_maker_signal', signalCategory: 'role_founder_or_ceo' });
    await insertEvidence(prospectId, { evidenceType: 'paid_acquisition_signal', signalCategory: 'meta_ad_active_30d' });
    const result = await service.assembleAndScore(prospectId, { exclusionOverrides: { companyAppearsDefunct: true } });
    expect(result.scoreResult.exclusionTriggered).toBe(true);
    expect(result.scoreResult.score).toBeNull();
  });
});

describe('EvidenceAssemblyService — score persistence, idempotency, history', () => {
  it('persists an icp_scores row matching the Stage 3 result exactly', async () => {
    const prospectId = await insertProspect();
    await insertEvidence(prospectId, { evidenceType: 'paid_acquisition_signal', signalCategory: 'meta_ad_active_30d' });
    const result = await service.assembleAndScore(prospectId);

    const rows = await db.select().from(schema.icpScores).where(eq(schema.icpScores.id, result.icpScoreId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tier).toBe(result.scoreResult.tier);
    expect(rows[0]?.score).toBe(result.scoreResult.score);
    expect(JSON.parse(rows[0]?.factorBreakdown ?? '{}')).toEqual(result.scoreResult.factorBreakdown);
    expect(rows[0]?.scoringEngineVersion).toBe(result.scoreResult.scoringEngineVersion);
  });

  it('re-scoring the same prospect appends a new icp_scores row rather than overwriting history', async () => {
    const prospectId = await insertProspect();
    await insertEvidence(prospectId, { evidenceType: 'paid_acquisition_signal', signalCategory: 'meta_ad_active_30d' });
    await service.assembleAndScore(prospectId);
    await service.assembleAndScore(prospectId);

    const rows = await db.select().from(schema.icpScores).where(eq(schema.icpScores.prospectId, prospectId));
    expect(rows).toHaveLength(2);
  });

  it('re-scoring does not create a duplicate prospect or regress known prospect fields', async () => {
    const prospectId = await insertProspect({ companyName: 'Example Brand', companyDomain: 'example.com' });
    await service.assembleAndScore(prospectId);
    await service.assembleAndScore(prospectId);

    const prospects = await db.select().from(schema.prospects).where(eq(schema.prospects.id, prospectId));
    expect(prospects).toHaveLength(1);
    expect(prospects[0]?.companyName).toBe('Example Brand');
    expect(prospects[0]?.companyDomain).toBe('example.com');
  });

  it('throws a clear error for a prospect id that does not exist', async () => {
    await expect(service.assembleAndScore('does-not-exist')).rejects.toThrow(/no prospect found/);
  });
});

describe('EvidenceAssemblyService.scoreBatch — checkpoint/resume', () => {
  it('scores every prospect in the batch and persists one icp_scores row each', async () => {
    const p1 = await insertProspect();
    const p2 = await insertProspect();
    await insertEvidence(p1, { evidenceType: 'paid_acquisition_signal', signalCategory: 'meta_ad_active_30d' });
    await insertEvidence(p2, { evidenceType: 'paid_acquisition_signal', signalCategory: 'meta_ad_active_30d' });

    const outcome = await service.scoreBatch([p1, p2]);
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results.every((r) => r.icpScoreId)).toBe(true);
  });

  it('one prospects failure does not block the others, and is recorded distinctly', async () => {
    const p1 = await insertProspect();
    await insertEvidence(p1, { evidenceType: 'paid_acquisition_signal', signalCategory: 'meta_ad_active_30d' });

    const outcome = await service.scoreBatch([p1, 'does-not-exist']);
    const byId = Object.fromEntries(outcome.results.map((r) => [r.prospectId, r]));
    expect(byId[p1]?.icpScoreId).toBeDefined();
    expect(byId['does-not-exist']?.error).toMatch(/no prospect found/);
  });

  it('resuming a batch does not re-score an already-completed prospect', async () => {
    const p1 = await insertProspect();
    const p2 = await insertProspect();
    await insertEvidence(p1, { evidenceType: 'paid_acquisition_signal', signalCategory: 'meta_ad_active_30d' });
    await insertEvidence(p2, { evidenceType: 'paid_acquisition_signal', signalCategory: 'meta_ad_active_30d' });

    // Simulate a partial run by scoring p1 alone first under the same job, then resuming with both.
    const first = await service.scoreBatch([p1]);
    const resumed = await service.scoreBatch([p1, p2], { resumeJobId: first.jobId });

    const p1Scores = await db.select().from(schema.icpScores).where(eq(schema.icpScores.prospectId, p1));
    expect(p1Scores).toHaveLength(1); // not re-scored
    const p2Scores = await db.select().from(schema.icpScores).where(eq(schema.icpScores.prospectId, p2));
    expect(p2Scores).toHaveLength(1);
    expect(resumed.jobId).toBe(first.jobId);
  });
});

describe('EvidenceAssemblyService — determinism', () => {
  it('identical evidence state produces an identical Stage 3 result, repeated calls', async () => {
    const prospectId = await insertProspect();
    await insertEvidence(prospectId, { evidenceType: 'decision_maker_signal', signalCategory: 'role_founder_or_ceo' });
    await insertEvidence(prospectId, { evidenceType: 'paid_acquisition_signal', signalCategory: 'meta_ad_active_30d' });

    const r1 = await service.assembleAndScore(prospectId);
    const r2 = await service.assembleAndScore(prospectId);
    expect(r1.scoreResult.factorBreakdown).toEqual(r2.scoreResult.factorBreakdown);
    expect(r1.scoreResult.score).toBe(r2.scoreResult.score);
    expect(r1.scoreResult.tier).toBe(r2.scoreResult.tier);
  });
});
