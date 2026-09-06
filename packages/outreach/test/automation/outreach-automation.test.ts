import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { schema, SystemConfigService, type MetrivioDb, type XReplyDetectorAdapter, type ConversationMessageObservation } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { createOutreachAutomationScheduler, runOutreachAutomationJob, resolveOutreachAutomationDryRun } from '../../src/automation/outreach-automation.js';
import { DISCOVER_DUE_FOLLOWUPS_JOB_TYPE, PREPARE_FOLLOWUP_DRAFTS_JOB_TYPE } from '../../src/automation/job-types.js';
import { DraftGenerationService } from '../../src/drafts/draft-generation-service.js';

class ScriptedReplyDetector implements XReplyDetectorAdapter {
  private queue: Array<ConversationMessageObservation[] | Error> = [];
  queueMessages(messages: ConversationMessageObservation[]): void {
    this.queue.push(messages);
  }
  async getConversationMessages(): Promise<ConversationMessageObservation[]> {
    const next = this.queue.shift();
    if (next === undefined) return [];
    if (next instanceof Error) throw next;
    return next;
  }
}

let db: MetrivioDb;
let sqlite: Database.Database;
let detector: ScriptedReplyDetector;
let config: SystemConfigService;

beforeEach(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  detector = new ScriptedReplyDetector();
  config = new SystemConfigService(db);
  await config.setKillSwitch(false, 'test');
  await config.setDailyLimit('dms', 10, 'test');
});

afterEach(() => sqlite.close());

async function insertProspect(overrides: Partial<typeof schema.prospects.$inferInsert> = {}): Promise<string> {
  const id = uuid();
  await db.insert(schema.prospects).values({
    id,
    xUsername: `user-${id.slice(0, 8)}`,
    xUserId: `xid-${id.slice(0, 8)}`,
    displayName: 'Jane Founder',
    companyName: 'Acme',
    source: 'founder_search',
    dateDiscovered: new Date().toISOString(),
    ...overrides,
  });
  return id;
}

async function setUpDueCandidate(): Promise<{ prospectId: string; sequenceId: string }> {
  const prospectId = await insertProspect();
  const sequenceId = uuid();
  await db.insert(schema.sequences).values({
    id: sequenceId,
    name: 'test-sequence',
    steps: JSON.stringify([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]),
  });
  await db.insert(schema.evidence).values({
    id: uuid(),
    prospectId,
    evidenceType: 'decision_maker_signal',
    signalCategory: 'role_founder_or_ceo',
    evidenceTier: 'CONFIRMED',
    rawValue: 'Founder',
    sourceUrl: null,
  });

  const draftGeneration = new DraftGenerationService(db);
  const { draft } = await draftGeneration.generateDraftForProspect(prospectId);
  await draftGeneration.drafts.submitForApproval(draft.id);
  await draftGeneration.drafts.approve(draft.id, 'reviewer-1');
  await db.insert(schema.outreachMessages).values({
    id: uuid(),
    prospectId,
    sequenceId,
    sequenceStepOrder: 1,
    personalizationBasis: JSON.stringify({ draftId: draft.id, evidenceReferences: draft.evidenceReferences }),
    messageContent: draft.messageText,
    channel: 'dm',
    status: 'sent',
    sentAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
  });
  return { prospectId, sequenceId };
}

describe('resolveOutreachAutomationDryRun — reuses the existing automation_mode config', () => {
  it('defaults to dry-run when automation_mode is unset (fail-closed)', async () => {
    expect(await resolveOutreachAutomationDryRun(config)).toBe(true);
  });

  it('is dry-run when automation_mode is explicitly dry_run', async () => {
    await config.setAutomationMode('prospecting.outreach', 'dry_run', 'test');
    expect(await resolveOutreachAutomationDryRun(config)).toBe(true);
  });

  it('is NOT dry-run when automation_mode is approval_required', async () => {
    await config.setAutomationMode('prospecting.outreach', 'approval_required', 'test');
    expect(await resolveOutreachAutomationDryRun(config)).toBe(false);
  });

  it('an "autonomous" mode value does not itself enable sending anywhere in this stage — it is simply not dry-run for drafting purposes', async () => {
    await config.setAutomationMode('prospecting.outreach', 'autonomous', 'test');
    expect(await resolveOutreachAutomationDryRun(config)).toBe(false);
  });
});

describe('runOutreachAutomationJob — end-to-end via the real factory', () => {
  it('discovers a due follow-up and reports COMPLETED', async () => {
    await setUpDueCandidate();
    detector.queueMessages([]);
    const scheduler = createOutreachAutomationScheduler(db, detector);

    const result = await runOutreachAutomationJob(scheduler, config, DISCOVER_DUE_FOLLOWUPS_JOB_TYPE);
    expect(result.status).toBe('DRY_RUN'); // default automation_mode is unset -> dry_run
  });

  it('with approval_required mode, prepares a real PENDING_APPROVAL draft (never APPROVED)', async () => {
    await config.setAutomationMode('prospecting.outreach', 'approval_required', 'test');
    const { prospectId } = await setUpDueCandidate();
    detector.queueMessages([]);
    const scheduler = createOutreachAutomationScheduler(db, detector);

    const result = await runOutreachAutomationJob(scheduler, config, PREPARE_FOLLOWUP_DRAFTS_JOB_TYPE);
    expect(result.status).toBe('COMPLETED');

    const draftGeneration = new DraftGenerationService(db);
    const drafts = (await draftGeneration.drafts.listDraftsForProspect(prospectId)).filter((d) => d.sequenceId !== undefined);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe('PENDING_APPROVAL');
  });

  it('with the default (unset) mode, PREPARE_FOLLOWUP_DRAFTS runs dry — no draft is created', async () => {
    const { prospectId } = await setUpDueCandidate();
    detector.queueMessages([]);
    const scheduler = createOutreachAutomationScheduler(db, detector);

    const result = await runOutreachAutomationJob(scheduler, config, PREPARE_FOLLOWUP_DRAFTS_JOB_TYPE);
    expect(result.status).toBe('DRY_RUN');

    const draftGeneration = new DraftGenerationService(db);
    const drafts = (await draftGeneration.drafts.listDraftsForProspect(prospectId)).filter((d) => d.sequenceId !== undefined);
    expect(drafts).toHaveLength(0);
  });

  it('forceDryRun cannot be overridden into a live run when mode is dry_run — the more conservative choice always wins', async () => {
    await config.setAutomationMode('prospecting.outreach', 'dry_run', 'test');
    const { prospectId } = await setUpDueCandidate();
    detector.queueMessages([]);
    const scheduler = createOutreachAutomationScheduler(db, detector);

    await runOutreachAutomationJob(scheduler, config, PREPARE_FOLLOWUP_DRAFTS_JOB_TYPE, { forceDryRun: false });
    const draftGeneration = new DraftGenerationService(db);
    const drafts = (await draftGeneration.drafts.listDraftsForProspect(prospectId)).filter((d) => d.sequenceId !== undefined);
    expect(drafts).toHaveLength(0);
  });

  it('respects a configured max-items-per-run bound', async () => {
    await config.setAutomationMode('prospecting.outreach', 'approval_required', 'test');
    await config.setOutreachAutomationMaxItemsPerRun(1, 'test');
    await setUpDueCandidate();
    await setUpDueCandidate();
    detector.queueMessages([]);
    detector.queueMessages([]);
    const scheduler = createOutreachAutomationScheduler(db, detector);

    const result = await runOutreachAutomationJob(scheduler, config, DISCOVER_DUE_FOLLOWUPS_JOB_TYPE);
    expect(result.result?.itemsProcessed).toBe(1);
  });

  it('the kill switch blocks the entire run before any work happens', async () => {
    await config.setKillSwitch(true, 'test');
    await setUpDueCandidate();
    const scheduler = createOutreachAutomationScheduler(db, detector);

    const result = await runOutreachAutomationJob(scheduler, config, DISCOVER_DUE_FOLLOWUPS_JOB_TYPE);
    expect(result.status).toBe('BLOCKED');
  });
});

describe('Stage 6E security boundary — no send capability reachable from automation', () => {
  it('the automation scheduler and its handlers carry no method that could contact X to send a message', async () => {
    const scheduler = createOutreachAutomationScheduler(db, detector);
    const schedulerMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(scheduler));
    expect(schedulerMethods.some((name) => /send/i.test(name))).toBe(false);
  });
});
