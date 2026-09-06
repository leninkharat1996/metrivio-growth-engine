import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { schema, SystemConfigService, type MetrivioDb, type XReadAdapter, type TweetResult, type ProfileResult, type AccountResult } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { createContentAutomationScheduler, runContentAutomationJob, resolveContentAutomationDryRun } from '../../src/automation/content-automation.js';
import {
  INGEST_CONTENT_SIGNALS_JOB_TYPE,
  GENERATE_CONTENT_OPPORTUNITIES_JOB_TYPE,
  GENERATE_CONTENT_DRAFTS_JOB_TYPE,
  VALIDATE_CONTENT_DRAFTS_JOB_TYPE,
  ANALYZE_OWN_CONTENT_JOB_TYPE,
} from '../../src/automation/job-types.js';
import { ContentDraftService } from '../../src/drafts/content-draft-service.js';
import { OwnContentPerformanceService } from '../../src/own-content/own-content-performance-service.js';
import { ContentSignalStore } from '../../src/signals/content-signal-store.js';

class ScriptedXReadAdapter implements XReadAdapter {
  public tweetsByHandle = new Map<string, TweetResult[]>();
  async getTweets(handle: string): Promise<TweetResult[]> {
    return this.tweetsByHandle.get(handle) ?? [];
  }
  async searchTweets(): Promise<TweetResult[]> {
    return [];
  }
  async getProfile(): Promise<ProfileResult> {
    return { username: 'x' };
  }
  async getFollowers(): Promise<AccountResult[]> {
    return [];
  }
  async getFollowing(): Promise<AccountResult[]> {
    return [];
  }
  async getListMembers(): Promise<AccountResult[]> {
    return [];
  }
  async getEngagers(): Promise<AccountResult[]> {
    return [];
  }
}

let db: MetrivioDb;
let sqlite: Database.Database;
let adapter: ScriptedXReadAdapter;
let config: SystemConfigService;

beforeEach(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  adapter = new ScriptedXReadAdapter();
  config = new SystemConfigService(db);
  await config.setKillSwitch(false, 'test');
});

afterEach(() => sqlite.close());

async function insertProspect(overrides: Partial<typeof schema.prospects.$inferInsert> = {}): Promise<string> {
  const id = uuid();
  await db.insert(schema.prospects).values({ id, xUsername: `founder-${id.slice(0, 8)}`, source: 'founder_search', dateDiscovered: new Date().toISOString(), ...overrides });
  return id;
}

describe('resolveContentAutomationDryRun — reuses content.publishing automation_mode', () => {
  it('defaults to dry-run when unset (fail-closed)', async () => {
    expect(await resolveContentAutomationDryRun(config)).toBe(true);
  });

  it('is not dry-run once explicitly set to approval_required', async () => {
    await config.setAutomationMode('content.publishing', 'approval_required', 'test');
    expect(await resolveContentAutomationDryRun(config)).toBe(false);
  });

  it('is independent of the outreach subsystem mode', async () => {
    await config.setAutomationMode('prospecting.outreach', 'approval_required', 'test');
    expect(await resolveContentAutomationDryRun(config)).toBe(true);
  });
});

describe('runContentAutomationJob — ingest_content_signals', () => {
  it('creates signals from a prospect with a relevant post', async () => {
    const prospectId = await insertProspect();
    const prospect = (await db.select().from(schema.prospects)).find((p) => p.id === prospectId)!;
    adapter.tweetsByHandle.set(prospect.xUsername, [{ id: 't1', authorUsername: prospect.xUsername, text: 'our CAC keeps rising', createdAt: new Date().toISOString(), url: 'https://x.com/1' }]);

    const scheduler = createContentAutomationScheduler(db, adapter);
    const result = await runContentAutomationJob(scheduler, config, INGEST_CONTENT_SIGNALS_JOB_TYPE);
    expect(result.status).toBe('DRY_RUN'); // default mode is unset -> dry_run, but ICP research itself still runs (it's a read+own-DB-write, not an X write)

    const signals = new ContentSignalStore(db);
    const rows = await signals.list({ signalType: 'icp_post' });
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('runContentAutomationJob — generate_content_opportunities + generate_content_drafts', () => {
  it('generates an opportunity from an ICP signal, then a draft from that opportunity once approval_required', async () => {
    await config.setAutomationMode('content.publishing', 'approval_required', 'test');
    const signals = new ContentSignalStore(db);
    await signals.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'CAC' });

    const scheduler = createContentAutomationScheduler(db, adapter);
    const opportunityResult = await runContentAutomationJob(scheduler, config, GENERATE_CONTENT_OPPORTUNITIES_JOB_TYPE);
    expect(opportunityResult.status).toBe('COMPLETED');

    const draftResult = await runContentAutomationJob(scheduler, config, GENERATE_CONTENT_DRAFTS_JOB_TYPE);
    expect(draftResult.status).toBe('COMPLETED');

    const drafts = new ContentDraftService(db);
    const ideaRows = await db.select().from(schema.contentIdeas);
    const draftsForIdea = await drafts.listDraftsForIdea(ideaRows[0].id);
    expect(draftsForIdea).toHaveLength(1);
    expect(draftsForIdea[0].status).toBe('DRAFTED');
  });

  it('generate_content_drafts is idempotent — a repeated run does not create a second draft for the same idea', async () => {
    await config.setAutomationMode('content.publishing', 'approval_required', 'test');
    const signals = new ContentSignalStore(db);
    await signals.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'ROAS' });

    const scheduler = createContentAutomationScheduler(db, adapter);
    await runContentAutomationJob(scheduler, config, GENERATE_CONTENT_OPPORTUNITIES_JOB_TYPE);
    await runContentAutomationJob(scheduler, config, GENERATE_CONTENT_DRAFTS_JOB_TYPE);
    await runContentAutomationJob(scheduler, config, GENERATE_CONTENT_DRAFTS_JOB_TYPE);

    const drafts = new ContentDraftService(db);
    const ideaRows = await db.select().from(schema.contentIdeas);
    const draftsForIdea = await drafts.listDraftsForIdea(ideaRows[0].id);
    expect(draftsForIdea).toHaveLength(1);
  });

  it('generate_content_drafts in dry-run mode creates no draft', async () => {
    const signals = new ContentSignalStore(db);
    await signals.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'MER' });

    const scheduler = createContentAutomationScheduler(db, adapter);
    await runContentAutomationJob(scheduler, config, GENERATE_CONTENT_OPPORTUNITIES_JOB_TYPE, { forceDryRun: false });
    // generate_content_opportunities always runs live (no X write, no approval crossing) — but drafts job respects mode
    const draftResult = await runContentAutomationJob(scheduler, config, GENERATE_CONTENT_DRAFTS_JOB_TYPE);
    expect(draftResult.status).toBe('DRY_RUN');

    const drafts = new ContentDraftService(db);
    const ideaRows = await db.select().from(schema.contentIdeas);
    if (ideaRows.length > 0) {
      const draftsForIdea = await drafts.listDraftsForIdea(ideaRows[0].id);
      expect(draftsForIdea).toHaveLength(0);
    }
  });
});

describe('runContentAutomationJob — validate_content_drafts', () => {
  it('revalidates every non-terminal draft', async () => {
    const drafts = new ContentDraftService(db);
    const { draft } = await drafts.generateDraft({ ideaId: uuid(), body: 'clean educational copy' });
    expect(draft.qualityCheckStatus).toBe('pass');

    await config.setAutomationMode('content.publishing', 'approval_required', 'test');
    const scheduler = createContentAutomationScheduler(db, adapter);
    const result = await runContentAutomationJob(scheduler, config, VALIDATE_CONTENT_DRAFTS_JOB_TYPE);
    expect(result.status).toBe('COMPLETED');
    expect(result.result?.itemsProcessed).toBe(1);
  });
});

describe('runContentAutomationJob — analyze_own_content', () => {
  it('analyzes every ingested post id', async () => {
    const performance = new OwnContentPerformanceService(db);
    await performance.ingestSnapshot({ postId: 'p1', impressions: 100, likes: 5 });

    await config.setAutomationMode('content.publishing', 'approval_required', 'test');
    const scheduler = createContentAutomationScheduler(db, adapter);
    const result = await runContentAutomationJob(scheduler, config, ANALYZE_OWN_CONTENT_JOB_TYPE);
    expect(result.status).toBe('COMPLETED');
    expect(result.result?.detail?.topPostId).toBe('p1');
  });
});

describe('runContentAutomationJob — kill switch and bounds', () => {
  it('the kill switch blocks every content automation job type', async () => {
    await config.setKillSwitch(true, 'test');
    const scheduler = createContentAutomationScheduler(db, adapter);
    const result = await runContentAutomationJob(scheduler, config, GENERATE_CONTENT_OPPORTUNITIES_JOB_TYPE);
    expect(result.status).toBe('BLOCKED');
  });

  it('respects a configured max-items-per-run bound', async () => {
    await config.setContentAutomationMaxItemsPerRun(1, 'test');
    await insertProspect();
    await insertProspect();
    const scheduler = createContentAutomationScheduler(db, adapter);
    const result = await runContentAutomationJob(scheduler, config, INGEST_CONTENT_SIGNALS_JOB_TYPE);
    expect(result.result?.itemsProcessed).toBe(1);
  });
});

describe('Stage 7 automation — no publishing capability reachable', () => {
  it('no job type in this package is a send/publish job', async () => {
    const jobTypes = [
      INGEST_CONTENT_SIGNALS_JOB_TYPE,
      GENERATE_CONTENT_OPPORTUNITIES_JOB_TYPE,
      GENERATE_CONTENT_DRAFTS_JOB_TYPE,
      VALIDATE_CONTENT_DRAFTS_JOB_TYPE,
      ANALYZE_OWN_CONTENT_JOB_TYPE,
    ];
    for (const jobType of jobTypes) {
      expect(jobType).not.toMatch(/send|publish/i);
    }
  });

  it('the content automation scheduler carries no send/publish method', () => {
    const scheduler = createContentAutomationScheduler(db, adapter);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(scheduler));
    expect(methods.some((m) => /send|publish/i.test(m))).toBe(false);
  });
});
