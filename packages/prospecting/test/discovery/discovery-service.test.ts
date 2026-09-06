import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type Database from 'better-sqlite3';
import {
  schema,
  SystemConfigService,
  KillSwitchActiveError,
  XReadRateLimitedError,
  XReadAuthenticationRequiredError,
  XReadNotFoundError,
  XReadNetworkError,
  XReadUnexpectedError,
  type MetrivioDb,
  type XReadAdapter,
  type XReadOptions,
  type ProfileResult,
  type TweetResult,
  type AccountResult,
} from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { DiscoveryService } from '../../src/discovery/discovery-service.js';

/**
 * A scripted XReadAdapter double — never XActions or any real network call.
 * Queues a response (or an Error to throw) per exact query/handle string, so
 * a test can script the full search->profile chain deterministically.
 * Implements every XReadAdapter method — the five not used by discovery
 * (getFollowers/getFollowing/getTweets/getListMembers/getEngagers) record
 * that they were called and throw, so a test can assert discovery never
 * touches them.
 */
class ScriptedXReadAdapter implements XReadAdapter {
  private readonly searchResponses = new Map<string, TweetResult[] | Error>();
  private readonly profileResponses = new Map<string, ProfileResult | Error>();
  public readonly searchCalls: string[] = [];
  public readonly profileCalls: string[] = [];
  public unexpectedMethodCalls: string[] = [];

  queueSearch(query: string, response: TweetResult[] | Error): void {
    this.searchResponses.set(query, response);
  }
  queueProfile(username: string, response: ProfileResult | Error): void {
    this.profileResponses.set(username.toLowerCase(), response);
  }

  async searchTweets(query: string, _opts?: XReadOptions): Promise<TweetResult[]> {
    this.searchCalls.push(query);
    const r = this.searchResponses.get(query);
    if (r === undefined) return [];
    if (r instanceof Error) throw r;
    return r;
  }

  async getProfile(handle: string): Promise<ProfileResult> {
    this.profileCalls.push(handle);
    const r = this.profileResponses.get(handle.toLowerCase());
    if (r === undefined) throw new Error(`test setup error: no profile queued for ${handle}`);
    if (r instanceof Error) throw r;
    return r;
  }

  async getFollowers(): Promise<AccountResult[]> {
    this.unexpectedMethodCalls.push('getFollowers');
    throw new Error('not used by Stage 4B discovery');
  }
  async getFollowing(): Promise<AccountResult[]> {
    this.unexpectedMethodCalls.push('getFollowing');
    throw new Error('not used by Stage 4B discovery');
  }
  async getTweets(): Promise<TweetResult[]> {
    this.unexpectedMethodCalls.push('getTweets');
    throw new Error('not used by Stage 4B discovery');
  }
  async getListMembers(): Promise<AccountResult[]> {
    this.unexpectedMethodCalls.push('getListMembers');
    throw new Error('not used by Stage 4B discovery');
  }
  async getEngagers(): Promise<AccountResult[]> {
    this.unexpectedMethodCalls.push('getEngagers');
    throw new Error('not used by Stage 4B discovery');
  }
}

function tweet(overrides: Partial<TweetResult> = {}): TweetResult {
  return {
    id: '1000',
    authorUsername: 'janefounder',
    text: 'hello world',
    createdAt: '2026-08-15T00:00:00.000Z',
    url: 'https://x.com/janefounder/status/1000',
    ...overrides,
  };
}

function profile(overrides: Partial<ProfileResult> = {}): ProfileResult {
  return {
    username: 'janefounder',
    userId: 'u-1',
    displayName: 'Jane Founder',
    bio: 'Founder @ExampleStore. DTC skincare.',
    website: 'https://example-store.com',
    followerCount: 5000,
    followingCount: 300,
    postCount: 900,
    ...overrides,
  };
}

let db: MetrivioDb;
let sqlite: Database.Database;
let systemConfig: SystemConfigService;
let adapter: ScriptedXReadAdapter;

beforeEach(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  systemConfig = new SystemConfigService(db);
  await systemConfig.setDailyLimit('scrapes', 100, 'test');
  adapter = new ScriptedXReadAdapter();
});

afterEach(() => sqlite.close());

async function configureQueries(founder: string[], pain: string[]): Promise<void> {
  await systemConfig.setDiscoveryFounderQueries(founder, 'test');
  await systemConfig.setDiscoveryPainIntentQueries(pain, 'test');
}

describe('DiscoveryService — search', () => {
  it('a founder query returns candidates that become prospects', async () => {
    await configureQueries(['founder DTC'], []);
    adapter.queueSearch('founder DTC', [tweet()]);
    adapter.queueProfile('janefounder', profile());

    const service = new DiscoveryService(db, adapter);
    const summary = await service.run();

    expect(summary.candidatesFound).toBe(1);
    expect(summary.prospectsCreated).toBe(1);
    const rows = await db.select().from(schema.prospects);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.xUsername).toBe('janefounder');
  });

  it('a pain/intent query returns candidates that become prospects', async () => {
    await configureQueries([], ['CAC']);
    adapter.queueSearch('CAC', [tweet({ authorUsername: 'painfounder', text: 'our CAC is rough' })]);
    adapter.queueProfile('painfounder', profile({ username: 'painfounder', userId: 'u-2' }));

    const service = new DiscoveryService(db, adapter);
    const summary = await service.run();
    expect(summary.prospectsCreated).toBe(1);
  });

  it('empty search is a legitimate zero-candidate result, not an error', async () => {
    await configureQueries(['founder DTC'], []);
    adapter.queueSearch('founder DTC', []);

    const service = new DiscoveryService(db, adapter);
    const summary = await service.run();
    expect(summary.candidatesFound).toBe(0);
    expect(summary.errors).toHaveLength(0);
    expect(summary.stoppedReason).toBe('completed');
  });

  it('duplicate users across two queries resolve to one prospect with two prospect_sources rows', async () => {
    await configureQueries(['founder DTC'], ['CAC']);
    adapter.queueSearch('founder DTC', [tweet({ authorUsername: 'janefounder' })]);
    adapter.queueSearch('CAC', [tweet({ authorUsername: 'janefounder', text: 'our CAC is rough', url: 'https://x.com/janefounder/status/2000' })]);
    adapter.queueProfile('janefounder', profile());

    const service = new DiscoveryService(db, adapter);
    const summary = await service.run();

    expect(summary.prospectsCreated).toBe(1);
    expect(adapter.profileCalls).toEqual(['janefounder']); // profile fetched only once despite two matches
    const sources = await db.select().from(schema.prospectSources);
    expect(sources).toHaveLength(2);
    expect(sources.map((s) => s.source).sort()).toEqual(['founder_search', 'pain_intent_search']);
  });
});

describe('DiscoveryService — profile classification', () => {
  it('founder profile writes a founder_or_ceo decision_maker_signal evidence row', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet()]);
    adapter.queueProfile('janefounder', profile());
    await new DiscoveryService(db, adapter).run();

    const rows = await db.select().from(schema.evidence).where(eq(schema.evidence.evidenceType, 'decision_maker_signal'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.signalCategory).toBe('role_founder_or_ceo');
    expect(rows[0]?.evidenceTier).toBe('LIKELY');
  });

  it('CEO profile also classifies as founder_or_ceo', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet({ authorUsername: 'ceoperson' })]);
    adapter.queueProfile('ceoperson', profile({ username: 'ceoperson', userId: 'u-3', bio: 'CEO of Example Inc.' }));
    await new DiscoveryService(db, adapter).run();

    const rows = await db.select().from(schema.evidence).where(eq(schema.evidence.evidenceType, 'decision_maker_signal'));
    expect(rows[0]?.signalCategory).toBe('role_founder_or_ceo');
  });

  it('owner profile also classifies as founder_or_ceo', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet({ authorUsername: 'ownerperson' })]);
    adapter.queueProfile('ownerperson', profile({ username: 'ownerperson', userId: 'u-4', bio: 'Owner, Example Coffee Co.' }));
    await new DiscoveryService(db, adapter).run();

    const rows = await db.select().from(schema.evidence).where(eq(schema.evidence.evidenceType, 'decision_maker_signal'));
    expect(rows[0]?.signalCategory).toBe('role_founder_or_ceo');
  });

  it('an ordinary employee profile is still persisted as a prospect (not rejected for a missing/weak role)', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet({ authorUsername: 'employee1' })]);
    adapter.queueProfile('employee1', profile({ username: 'employee1', userId: 'u-5', bio: 'Marketing Coordinator at Example Brand' }));
    const summary = await new DiscoveryService(db, adapter).run();

    expect(summary.prospectsCreated).toBe(1);
    const rows = await db.select().from(schema.evidence).where(eq(schema.evidence.evidenceType, 'decision_maker_signal'));
    expect(rows[0]?.signalCategory).toBe('role_execution_only');
  });

  it('missing website: companyDomain stays null and no company_identification evidence is written', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet()]);
    adapter.queueProfile('janefounder', profile({ website: undefined }));
    await new DiscoveryService(db, adapter).run();

    const prospects = await db.select().from(schema.prospects);
    expect(prospects[0]?.companyDomain).toBeNull();
    const evidenceRows = await db.select().from(schema.evidence).where(eq(schema.evidence.evidenceType, 'company_identification'));
    expect(evidenceRows).toHaveLength(0);
  });

  it('website present: companyDomain is populated and a company_identification evidence row is written', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet()]);
    adapter.queueProfile('janefounder', profile());
    await new DiscoveryService(db, adapter).run();

    const prospects = await db.select().from(schema.prospects);
    expect(prospects[0]?.companyDomain).toBe('example-store.com');
    const evidenceRows = await db.select().from(schema.evidence).where(eq(schema.evidence.evidenceType, 'company_identification'));
    expect(evidenceRows).toHaveLength(1);
    expect(evidenceRows[0]?.rawValue).toBe('example-store.com');
  });

  it('a malformed/unsupported website does not crash the run and leaves companyDomain null', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet()]);
    adapter.queueProfile('janefounder', profile({ website: 'not a url !!!' }));
    const summary = await new DiscoveryService(db, adapter).run();

    expect(summary.errors).toHaveLength(0);
    const prospects = await db.select().from(schema.prospects);
    expect(prospects[0]?.companyDomain).toBeNull();
  });
});

describe('DiscoveryService — company/domain identification', () => {
  it('explicit company identity from bio populates companyName even with no website', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet()]);
    adapter.queueProfile('janefounder', profile({ website: undefined, bio: 'Founder of Example Brand.' }));
    await new DiscoveryService(db, adapter).run();

    const prospects = await db.select().from(schema.prospects);
    expect(prospects[0]?.companyName).toBe('Example Brand');
    expect(prospects[0]?.companyDomain).toBeNull();
  });

  it('unresolved company: no bio mention and no website leaves both fields null, prospect still created', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet()]);
    adapter.queueProfile('janefounder', profile({ website: undefined, bio: 'Just here for the coffee.' }));
    const summary = await new DiscoveryService(db, adapter).run();

    expect(summary.prospectsCreated).toBe(1);
    const prospects = await db.select().from(schema.prospects);
    expect(prospects[0]?.companyName).toBeNull();
    expect(prospects[0]?.companyDomain).toBeNull();
  });

  it('a social URL in the website field is rejected as a company domain, never invented as one', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet()]);
    adapter.queueProfile('janefounder', profile({ website: 'https://instagram.com/janefounder' }));
    await new DiscoveryService(db, adapter).run();

    const prospects = await db.select().from(schema.prospects);
    expect(prospects[0]?.companyDomain).toBeNull();
  });

  it('a company-name-only bio never produces a guessed domain (hard rule)', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet()]);
    adapter.queueProfile('janefounder', profile({ website: undefined, bio: 'Founder of Example Brand.' }));
    await new DiscoveryService(db, adapter).run();

    const prospects = await db.select().from(schema.prospects);
    expect(prospects[0]?.companyDomain).not.toBe('examplebrand.com');
    expect(prospects[0]?.companyDomain).toBeNull();
  });
});

describe('DiscoveryService — deduplication', () => {
  it('the same X user found via two different queries produces exactly one prospect row', async () => {
    await configureQueries(['founder DTC'], ['ROAS']);
    adapter.queueSearch('founder DTC', [tweet()]);
    adapter.queueSearch('ROAS', [tweet({ text: 'ROAS is down', url: 'https://x.com/janefounder/status/3' })]);
    adapter.queueProfile('janefounder', profile());
    await new DiscoveryService(db, adapter).run();

    const rows = await db.select().from(schema.prospects);
    expect(rows).toHaveLength(1);
  });

  it('running a second, independent job against the same fixture does not create a duplicate prospect row', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet()]);
    adapter.queueProfile('janefounder', profile());
    await new DiscoveryService(db, adapter).run();

    // A fresh, independent job (not a resume) processing the identical fixture again.
    adapter.queueSearch('q', [tweet()]);
    adapter.queueProfile('janefounder', profile());
    const summary2 = await new DiscoveryService(db, adapter).run();

    expect(summary2.prospectsCreated).toBe(0);
    expect(summary2.prospectsUpdated).toBe(1);
    const rows = await db.select().from(schema.prospects);
    expect(rows).toHaveLength(1);
  });

  it('X user ID takes precedence over username when re-resolving an existing prospect', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet()]);
    adapter.queueProfile('janefounder', profile({ userId: 'stable-id-1' }));
    await new DiscoveryService(db, adapter).run();

    // Same underlying account (same userId), profile now returns updated displayName —
    // dedup must resolve by userId, not create a second row.
    adapter.queueSearch('q', [tweet()]);
    adapter.queueProfile('janefounder', profile({ userId: 'stable-id-1', displayName: 'Jane Founder Updated' }));
    await new DiscoveryService(db, adapter).run();

    const rows = await db.select().from(schema.prospects).where(eq(schema.prospects.xUserId, 'stable-id-1'));
    expect(rows).toHaveLength(1);
  });

  it('a repeated observation does not create uncontrolled duplicate evidence rows', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet()]);
    adapter.queueProfile('janefounder', profile());
    await new DiscoveryService(db, adapter).run();

    adapter.queueSearch('q', [tweet()]);
    adapter.queueProfile('janefounder', profile());
    await new DiscoveryService(db, adapter).run();

    const evidenceRows = await db.select().from(schema.evidence);
    // decision_maker_signal + company_identification = 2 distinct facts, not 4.
    expect(evidenceRows).toHaveLength(2);
  });
});

describe('DiscoveryService — error states', () => {
  it('a rate-limited search is recorded distinctly, not as zero candidates found', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', new XReadRateLimitedError('XActionsReadAdapter', 'searchTweets'));
    const summary = await new DiscoveryService(db, adapter).run();

    expect(summary.candidatesFound).toBe(0);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]?.errorType).toBe('XReadRateLimitedError');
  });

  it('an authentication failure on search is recorded distinctly', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', new XReadAuthenticationRequiredError('XActionsReadAdapter', 'searchTweets'));
    const summary = await new DiscoveryService(db, adapter).run();
    expect(summary.errors[0]?.errorType).toBe('XReadAuthenticationRequiredError');
  });

  it('a not-found/private/suspended profile is recorded distinctly and does not create a prospect', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet()]);
    adapter.queueProfile('janefounder', new XReadNotFoundError('XActionsReadAdapter', 'getProfile'));
    const summary = await new DiscoveryService(db, adapter).run();

    expect(summary.errors[0]?.errorType).toBe('XReadNotFoundError');
    const rows = await db.select().from(schema.prospects);
    expect(rows).toHaveLength(0);
  });

  it('a network failure is recorded distinctly', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet()]);
    adapter.queueProfile('janefounder', new XReadNetworkError('XActionsReadAdapter', 'getProfile'));
    const summary = await new DiscoveryService(db, adapter).run();
    expect(summary.errors[0]?.errorType).toBe('XReadNetworkError');
  });

  it('an unexpected failure is recorded distinctly, never silently swallowed', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet()]);
    adapter.queueProfile('janefounder', new XReadUnexpectedError('XActionsReadAdapter', 'getProfile'));
    const summary = await new DiscoveryService(db, adapter).run();
    expect(summary.errors[0]?.errorType).toBe('XReadUnexpectedError');
  });

  it('one failed candidate does not block the others in the same run', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet({ authorUsername: 'baduser' }), tweet({ authorUsername: 'gooduser', url: 'https://x.com/gooduser/status/1' })]);
    adapter.queueProfile('baduser', new XReadNotFoundError('XActionsReadAdapter', 'getProfile'));
    adapter.queueProfile('gooduser', profile({ username: 'gooduser', userId: 'u-good' }));
    const summary = await new DiscoveryService(db, adapter).run();

    expect(summary.prospectsCreated).toBe(1);
    expect(summary.errors).toHaveLength(1);
  });
});

describe('DiscoveryService — safety', () => {
  it('an active kill switch (surfaced as KillSwitchActiveError by the injected adapter) is recorded distinctly, never silently swallowed as zero results', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', new KillSwitchActiveError('x.read.searchTweets'));
    const summary = await new DiscoveryService(db, adapter).run();

    expect(summary.candidatesFound).toBe(0);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]?.errorType).toBe('KillSwitchActiveError');
    // DiscoveryService itself never bypasses the adapter — it has no
    // kill-switch-specific handling at all, which is exactly the point:
    // whatever the injected XReadAdapter does (kill-switch-checked or not)
    // is respected as-is.
  });

  it('discovery never calls any of the five methods it does not use (no write-adjacent or unrelated adapter surface touched)', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet()]);
    adapter.queueProfile('janefounder', profile());
    await new DiscoveryService(db, adapter).run();
    expect(adapter.unexpectedMethodCalls).toHaveLength(0);
  });

  it('revenue is never inferred into evidence, even from a bio claiming a specific figure', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet()]);
    adapter.queueProfile('janefounder', profile({ bio: 'Founder of a $5M brand, DTC skincare.' }));
    await new DiscoveryService(db, adapter).run();

    const revenueRows = await db.select().from(schema.evidence).where(eq(schema.evidence.evidenceType, 'revenue_signal'));
    expect(revenueRows).toHaveLength(0);
  });

  it('follower count is never converted into revenue evidence', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet()]);
    adapter.queueProfile('janefounder', profile({ followerCount: 500_000 }));
    await new DiscoveryService(db, adapter).run();

    const revenueRows = await db.select().from(schema.evidence).where(eq(schema.evidence.evidenceType, 'revenue_signal'));
    expect(revenueRows).toHaveLength(0);
  });

  it('a Meta/Google mention in a tweet is never converted into paid-acquisition spend evidence', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet({ text: 'Running ads on Meta and Google, spending a lot lately.' })]);
    adapter.queueProfile('janefounder', profile());
    await new DiscoveryService(db, adapter).run();

    const paidRows = await db.select().from(schema.evidence).where(eq(schema.evidence.evidenceType, 'paid_acquisition_signal'));
    expect(paidRows).toHaveLength(0);
  });

  it('a generic hiring tweet is never converted into paid-media job evidence', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet({ text: "We're hiring! Join our team." })]);
    adapter.queueProfile('janefounder', profile());
    await new DiscoveryService(db, adapter).run();

    const paidRows = await db.select().from(schema.evidence).where(eq(schema.evidence.evidenceType, 'paid_acquisition_signal'));
    expect(paidRows).toHaveLength(0);
  });

  it('a genuine paid-media job posting within 90 days does create paid_acquisition_signal evidence, with tweet URL and date preserved', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [
      tweet({ text: 'Hiring a Media Buyer, apply now!', createdAt: '2026-08-20T00:00:00.000Z', url: 'https://x.com/janefounder/status/999' }),
    ]);
    adapter.queueProfile('janefounder', profile());
    await new DiscoveryService(db, adapter).run();

    const paidRows = await db.select().from(schema.evidence).where(eq(schema.evidence.evidenceType, 'paid_acquisition_signal'));
    expect(paidRows).toHaveLength(1);
    expect(paidRows[0]?.sourceUrl).toBe('https://x.com/janefounder/status/999');
    expect(paidRows[0]?.capturedAt).toBe('2026-08-20T00:00:00.000Z');
  });

  it('a "we are scaling" tweet is never converted into trigger evidence', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet({ text: 'We are scaling fast this year!' })]);
    adapter.queueProfile('janefounder', profile());
    await new DiscoveryService(db, adapter).run();

    const triggerRows = await db.select().from(schema.evidence).where(eq(schema.evidence.evidenceType, 'trigger_signal'));
    expect(triggerRows).toHaveLength(0);
  });

  it('Stage 4B never writes trigger_signal evidence at all, under any observed tweet content', async () => {
    await configureQueries(['q'], []);
    adapter.queueSearch('q', [tweet({ text: 'New product launch today! Also scaling Meta and Google ads, DTC is booming, $10M brand.' })]);
    adapter.queueProfile('janefounder', profile());
    await new DiscoveryService(db, adapter).run();

    const triggerRows = await db.select().from(schema.evidence).where(eq(schema.evidence.evidenceType, 'trigger_signal'));
    const dtcRows = await db.select().from(schema.evidence).where(eq(schema.evidence.evidenceType, 'dtc_signal'));
    expect(triggerRows).toHaveLength(0);
    expect(dtcRows).toHaveLength(0);
  });
});

describe('DiscoveryService — checkpoint/resume', () => {
  it('a run that exhausts its scrape budget mid-run can be resumed to completion without reprocessing done work', async () => {
    await configureQueries(['q1', 'q2'], []);
    await systemConfig.setDailyLimit('scrapes', 1, 'test'); // only 1 scrape allowed — search q1 uses it, q2 must wait
    adapter.queueSearch('q1', [tweet({ authorUsername: 'user1' })]);
    adapter.queueSearch('q2', [tweet({ authorUsername: 'user2', url: 'https://x.com/user2/status/1' })]);
    adapter.queueProfile('user1', profile({ username: 'user1', userId: 'u-1' }));
    adapter.queueProfile('user2', profile({ username: 'user2', userId: 'u-2' }));

    const service = new DiscoveryService(db, adapter);
    const first = await service.run();
    expect(first.stoppedReason).toBe('budget_exhausted');
    expect(adapter.searchCalls).toEqual(['q1']); // q2 never searched yet

    await systemConfig.setDailyLimit('scrapes', 100, 'test'); // raise the budget before resuming
    const second = await service.run({ resumeJobId: first.jobId });
    expect(second.stoppedReason).toBe('completed');
    expect(adapter.searchCalls).toEqual(['q1', 'q2']); // q1 not re-searched
    expect(adapter.profileCalls.sort()).toEqual(['user1', 'user2']);

    const rows = await db.select().from(schema.prospects);
    expect(rows).toHaveLength(2);
  });

  it('an already-processed candidate is never re-fetched on resume', async () => {
    await configureQueries(['q'], []);
    await systemConfig.setDailyLimit('scrapes', 2, 'test'); // 1 for search, 1 for the first profile
    adapter.queueSearch('q', [
      tweet({ authorUsername: 'user1' }),
      tweet({ authorUsername: 'user2', url: 'https://x.com/user2/status/1' }),
    ]);
    adapter.queueProfile('user1', profile({ username: 'user1', userId: 'u-1' }));
    adapter.queueProfile('user2', profile({ username: 'user2', userId: 'u-2' }));

    const service = new DiscoveryService(db, adapter);
    const first = await service.run();
    expect(first.stoppedReason).toBe('budget_exhausted');
    expect(adapter.profileCalls).toEqual(['user1']);

    await systemConfig.setDailyLimit('scrapes', 100, 'test');
    await service.run({ resumeJobId: first.jobId });
    expect(adapter.profileCalls).toEqual(['user1', 'user2']); // user1 not re-fetched
  });

  it('throws a clear error when asked to resume a job_run id that does not exist', async () => {
    const service = new DiscoveryService(db, adapter);
    await expect(service.run({ resumeJobId: 'does-not-exist' })).rejects.toThrow(/no job_run found/);
  });
});

describe('DiscoveryService — determinism', () => {
  it('identical mocked responses and identical starting DB state produce the same discovery classifications and persisted outcome', async () => {
    await configureQueries(['q'], []);

    async function runOnce(freshDb: MetrivioDb) {
      const localAdapter = new ScriptedXReadAdapter();
      localAdapter.queueSearch('q', [tweet()]);
      localAdapter.queueProfile('janefounder', profile());
      const localConfig = new SystemConfigService(freshDb);
      await localConfig.setDailyLimit('scrapes', 100, 'test');
      await localConfig.setDiscoveryFounderQueries(['q'], 'test');
      await localConfig.setDiscoveryPainIntentQueries([], 'test');
      const summary = await new DiscoveryService(freshDb, localAdapter).run();
      const prospects = await freshDb.select().from(schema.prospects);
      return { summary: { ...summary, jobId: 'x' }, prospect: { ...prospects[0], id: 'x', createdAt: 'x', updatedAt: 'x', dateDiscovered: 'x', lastEnrichedAt: 'x' } };
    }

    const { db: dbA, sqlite: sqliteA } = createTestDb();
    const { db: dbB, sqlite: sqliteB } = createTestDb();
    const resultA = await runOnce(dbA);
    const resultB = await runOnce(dbB);
    sqliteA.close();
    sqliteB.close();

    expect(resultA.summary).toEqual(resultB.summary);
    expect(resultA.prospect).toEqual(resultB.prospect);
  });
});
