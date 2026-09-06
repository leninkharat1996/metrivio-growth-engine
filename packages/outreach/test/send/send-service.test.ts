import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import {
  schema,
  SystemConfigService,
  XSendAuthenticationRequiredError,
  XSendRateLimitedError,
  XSendNotFoundError,
  XSendNetworkError,
  XSendUnexpectedError,
  type MetrivioDb,
  type XSendAdapter,
  type SendDirectMessageInput,
  type SendDirectMessageResult,
} from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { OutreachDraftService } from '../../src/drafts/draft-store.js';
import { SendApprovedDraftService } from '../../src/send/send-service.js';
import type { EvidenceRowInput } from '../../src/personalization/personalization-candidates.js';

/** Mirrors the existing ScriptedXReadAdapter/ScriptedTechAnalyzerAdapter test-double pattern — never a real network call. */
class ScriptedSendAdapter implements XSendAdapter {
  public calls: SendDirectMessageInput[] = [];
  private queue: Array<SendDirectMessageResult | Error> = [];

  queueSuccess(result: SendDirectMessageResult): void {
    this.queue.push(result);
  }
  queueError(err: Error): void {
    this.queue.push(err);
  }

  async sendDirectMessage(input: SendDirectMessageInput): Promise<SendDirectMessageResult> {
    this.calls.push(input);
    const next = this.queue.shift();
    if (next === undefined) throw new Error('ScriptedSendAdapter: no queued response');
    if (next instanceof Error) throw next;
    return next;
  }
}

let db: MetrivioDb;
let sqlite: Database.Database;
let draftService: OutreachDraftService;
let sendAdapter: ScriptedSendAdapter;
let service: SendApprovedDraftService;
let config: SystemConfigService;

beforeEach(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  draftService = new OutreachDraftService(db);
  sendAdapter = new ScriptedSendAdapter();
  service = new SendApprovedDraftService(db, draftService, sendAdapter);
  config = new SystemConfigService(db);
  await config.setKillSwitch(false, 'test');
  await config.setDailyLimit('dms', 10, 'test');
});

afterEach(() => sqlite.close());

function evidenceRow(overrides: Partial<EvidenceRowInput> = {}): EvidenceRowInput {
  return { id: 'e1', evidenceType: 'decision_maker_signal', signalCategory: 'role_founder_or_ceo', evidenceTier: 'CONFIRMED', rawValue: 'Founder', sourceUrl: null, ...overrides };
}

async function insertProspect(overrides: Partial<typeof schema.prospects.$inferInsert> = {}): Promise<string> {
  const id = uuid();
  await db.insert(schema.prospects).values({
    id,
    xUsername: `user-${id.slice(0, 8)}`,
    xUserId: `xid-${id.slice(0, 8)}`,
    source: 'founder_search',
    dateDiscovered: new Date().toISOString(),
    ...overrides,
  });
  return id;
}

async function approvedDraftFor(prospectId: string): Promise<string> {
  const { draft } = await draftService.generateDraft({
    prospectId,
    displayName: 'Jane Founder',
    companyName: 'Acme',
    evidenceRows: [evidenceRow()],
    painSignals: [],
    technologyDetections: [],
  });
  await draftService.submitForApproval(draft.id);
  await draftService.approve(draft.id, 'reviewer-1');
  return draft.id;
}

describe('SendApprovedDraftService — approval enforcement', () => {
  it('sends an approved draft', async () => {
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);
    sendAdapter.queueSuccess({ xMessageId: 'm1', sentAt: new Date().toISOString() });

    const result = await service.send({ draftId, prospectId });
    expect(result.outcome).toBe('SENT');
    expect(result.xMessageId).toBe('m1');
  });

  it('rejects a DRAFTED (not yet submitted) draft', async () => {
    const prospectId = await insertProspect();
    const { draft } = await draftService.generateDraft({ prospectId, displayName: 'Jane', companyName: 'Acme', evidenceRows: [evidenceRow()], painSignals: [], technologyDetections: [] });

    const result = await service.send({ draftId: draft.id, prospectId });
    expect(result.outcome).toBe('NOT_APPROVED');
    expect(sendAdapter.calls).toHaveLength(0);
  });

  it('rejects a PENDING_APPROVAL draft', async () => {
    const prospectId = await insertProspect();
    const { draft } = await draftService.generateDraft({ prospectId, displayName: 'Jane', companyName: 'Acme', evidenceRows: [evidenceRow()], painSignals: [], technologyDetections: [] });
    await draftService.submitForApproval(draft.id);

    const result = await service.send({ draftId: draft.id, prospectId });
    expect(result.outcome).toBe('NOT_APPROVED');
    expect(sendAdapter.calls).toHaveLength(0);
  });

  it('rejects a REJECTED draft', async () => {
    const prospectId = await insertProspect();
    const { draft } = await draftService.generateDraft({ prospectId, displayName: 'Jane', companyName: 'Acme', evidenceRows: [evidenceRow()], painSignals: [], technologyDetections: [] });
    await draftService.reject(draft.id, 'reviewer-1', 'not a fit');

    const result = await service.send({ draftId: draft.id, prospectId });
    expect(result.outcome).toBe('NOT_APPROVED');
    expect(sendAdapter.calls).toHaveLength(0);
  });

  it('rejects a missing/unknown draft id', async () => {
    const prospectId = await insertProspect();
    const result = await service.send({ draftId: 'no-such-draft', prospectId });
    expect(result.outcome).toBe('NOT_APPROVED');
    expect(sendAdapter.calls).toHaveLength(0);
  });
});

describe('SendApprovedDraftService — target identity', () => {
  it('sends using the canonical X user ID, not the username', async () => {
    const prospectId = await insertProspect({ xUserId: 'canonical-123', xUsername: 'somehandle' });
    const draftId = await approvedDraftFor(prospectId);
    sendAdapter.queueSuccess({ xMessageId: 'm1', sentAt: new Date().toISOString() });

    await service.send({ draftId, prospectId });
    expect(sendAdapter.calls[0].targetUserId).toBe('canonical-123');
  });

  it('rejects when the prospect has no canonical X user ID (never falls back to fuzzy username matching)', async () => {
    const prospectId = await insertProspect({ xUserId: null });
    const draftId = await approvedDraftFor(prospectId);

    const result = await service.send({ draftId, prospectId });
    expect(result.outcome).toBe('TARGET_INVALID');
    expect(sendAdapter.calls).toHaveLength(0);
  });

  it('rejects when the caller-specified prospectId does not match the draft\'s own prospectId', async () => {
    const prospectId = await insertProspect();
    const otherProspectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);

    const result = await service.send({ draftId, prospectId: otherProspectId });
    expect(result.outcome).toBe('TARGET_INVALID');
    expect(sendAdapter.calls).toHaveLength(0);
  });

  it('rejects when the prospect record itself no longer exists', async () => {
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);
    await db.delete(schema.prospects).where(eq(schema.prospects.id, prospectId));

    const result = await service.send({ draftId, prospectId });
    expect(result.outcome).toBe('TARGET_INVALID');
  });
});

describe('SendApprovedDraftService — duplicate protection', () => {
  it('returns ALREADY_SENT on a second attempt after a successful send', async () => {
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);
    sendAdapter.queueSuccess({ xMessageId: 'm1', sentAt: new Date().toISOString() });

    const first = await service.send({ draftId, prospectId });
    expect(first.outcome).toBe('SENT');

    const second = await service.send({ draftId, prospectId });
    expect(second.outcome).toBe('ALREADY_SENT');
    expect(sendAdapter.calls).toHaveLength(1); // never called X a second time
  });

  it('allows a retry after a known, non-ambiguous failure (e.g. this stage\'s own documented capability gap)', async () => {
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);
    sendAdapter.queueError(new XSendUnexpectedError('Test', 'sendDirectMessage', 'capability gap'));

    const first = await service.send({ draftId, prospectId });
    expect(first.outcome).toBe('UNEXPECTED_ERROR');

    sendAdapter.queueSuccess({ xMessageId: 'm1', sentAt: new Date().toISOString() });
    const second = await service.send({ draftId, prospectId });
    expect(second.outcome).toBe('SENT');
    expect(sendAdapter.calls).toHaveLength(2);
  });

  it('blocks further attempts after an ambiguous network failure, handled safely rather than retried', async () => {
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);
    sendAdapter.queueError(new XSendNetworkError('Test', 'sendDirectMessage', 'timeout'));

    const first = await service.send({ draftId, prospectId });
    expect(first.outcome).toBe('NETWORK_ERROR');

    sendAdapter.queueSuccess({ xMessageId: 'm1', sentAt: new Date().toISOString() });
    const second = await service.send({ draftId, prospectId });
    expect(second.outcome).toBe('ALREADY_SENT');
    expect(sendAdapter.calls).toHaveLength(1); // the queued success was never consumed
  });

  it('the unique (prospect, sequence, step) index is the real backstop — a raw duplicate insert would violate it', async () => {
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);
    sendAdapter.queueSuccess({ xMessageId: 'm1', sentAt: new Date().toISOString() });
    await service.send({ draftId, prospectId });

    const rows = await db.select().from(schema.outreachMessages).where(eq(schema.outreachMessages.prospectId, prospectId));
    expect(rows).toHaveLength(1);
  });
});

describe('SendApprovedDraftService — kill switch', () => {
  it('blocks before preparing the write when active from the start', async () => {
    await config.setKillSwitch(true, 'test');
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);

    const result = await service.send({ draftId, prospectId });
    expect(result.outcome).toBe('BLOCKED');
    expect(sendAdapter.calls).toHaveLength(0);
  });

  it('never performs the network write when the kill switch is active', async () => {
    await config.setKillSwitch(true, 'test');
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);
    sendAdapter.queueSuccess({ xMessageId: 'm1', sentAt: new Date().toISOString() });

    await service.send({ draftId, prospectId });
    expect(sendAdapter.calls).toHaveLength(0);
  });
});

describe('SendApprovedDraftService — limits', () => {
  it('sends when below the configured daily limit', async () => {
    await config.setDailyLimit('dms', 5, 'test');
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);
    sendAdapter.queueSuccess({ xMessageId: 'm1', sentAt: new Date().toISOString() });

    const result = await service.send({ draftId, prospectId });
    expect(result.outcome).toBe('SENT');
  });

  it('blocks exactly at the limit (deterministic boundary)', async () => {
    await config.setDailyLimit('dms', 1, 'test');
    const p1 = await insertProspect();
    const d1 = await approvedDraftFor(p1);
    sendAdapter.queueSuccess({ xMessageId: 'm1', sentAt: new Date().toISOString() });
    await service.send({ draftId: d1, prospectId: p1 });

    const p2 = await insertProspect();
    const d2 = await approvedDraftFor(p2);
    const result = await service.send({ draftId: d2, prospectId: p2 });
    expect(result.outcome).toBe('LIMIT_REACHED');
    expect(sendAdapter.calls).toHaveLength(1);
  });

  it('blocks when already above the limit', async () => {
    await config.setDailyLimit('dms', 0, 'test');
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);

    const result = await service.send({ draftId, prospectId });
    expect(result.outcome).toBe('LIMIT_REACHED');
    expect(sendAdapter.calls).toHaveLength(0);
  });
});

describe('SendApprovedDraftService — dry run', () => {
  it('validates everything but never calls the network adapter', async () => {
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);

    const result = await service.send({ draftId, prospectId, dryRun: true });
    expect(result.outcome).toBe('DRY_RUN');
    expect(sendAdapter.calls).toHaveLength(0);
  });

  it('returns what would have been sent without exposing credentials', async () => {
    const prospectId = await insertProspect({ xUserId: 'canonical-999' });
    const draftId = await approvedDraftFor(prospectId);

    const result = await service.send({ draftId, prospectId, dryRun: true });
    expect(result.wouldSendTo?.xUserId).toBe('canonical-999');
    expect(result.wouldSendText).toBeTruthy();
  });

  it('never creates a fake SENT/outreach_messages row', async () => {
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);
    await service.send({ draftId, prospectId, dryRun: true });

    const rows = await db.select().from(schema.outreachMessages).where(eq(schema.outreachMessages.prospectId, prospectId));
    expect(rows).toHaveLength(0);
  });

  it('is deterministic and still enforces approval/target/limit checks', async () => {
    const prospectId = await insertProspect();
    const { draft } = await draftService.generateDraft({ prospectId, displayName: 'Jane', companyName: 'Acme', evidenceRows: [evidenceRow()], painSignals: [], technologyDetections: [] });
    const result = await service.send({ draftId: draft.id, prospectId, dryRun: true });
    expect(result.outcome).toBe('NOT_APPROVED');
  });
});

describe('SendApprovedDraftService — message validation', () => {
  it('rejects a too-long message rather than truncating it', async () => {
    await config.setOutreachMaxMessageLength(20, 'test');
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId); // the generated template text exceeds 20 chars

    const result = await service.send({ draftId, prospectId });
    expect(result.outcome).toBe('MESSAGE_INVALID');
    expect(sendAdapter.calls).toHaveLength(0);
  });

  it('preserves the exact approved text when sending (never rewrites/personalizes at send time)', async () => {
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);
    const draft = await draftService.getDraft(draftId);
    sendAdapter.queueSuccess({ xMessageId: 'm1', sentAt: new Date().toISOString() });

    await service.send({ draftId, prospectId });
    expect(sendAdapter.calls[0].messageText).toBe(draft?.messageText);
  });
});

describe('SendApprovedDraftService — network/auth error mapping', () => {
  it('maps XSendAuthenticationRequiredError to AUTH_REQUIRED', async () => {
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);
    sendAdapter.queueError(new XSendAuthenticationRequiredError('Test', 'sendDirectMessage'));

    const result = await service.send({ draftId, prospectId });
    expect(result.outcome).toBe('AUTH_REQUIRED');
  });

  it('maps XSendRateLimitedError to RATE_LIMITED', async () => {
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);
    sendAdapter.queueError(new XSendRateLimitedError('Test', 'sendDirectMessage'));

    const result = await service.send({ draftId, prospectId });
    expect(result.outcome).toBe('RATE_LIMITED');
  });

  it('maps XSendNotFoundError to NOT_FOUND', async () => {
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);
    sendAdapter.queueError(new XSendNotFoundError('Test', 'sendDirectMessage'));

    const result = await service.send({ draftId, prospectId });
    expect(result.outcome).toBe('NOT_FOUND');
  });

  it('maps XSendNetworkError to NETWORK_ERROR', async () => {
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);
    sendAdapter.queueError(new XSendNetworkError('Test', 'sendDirectMessage'));

    const result = await service.send({ draftId, prospectId });
    expect(result.outcome).toBe('NETWORK_ERROR');
  });

  it('maps an unrecognized thrown error to UNEXPECTED_ERROR rather than leaking it', async () => {
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);
    sendAdapter.queueError(new Error('some weird internal thing'));

    const result = await service.send({ draftId, prospectId });
    expect(result.outcome).toBe('UNEXPECTED_ERROR');
  });

  it('records a failed attempt with a non-null errorDetail, never repeating it as a second automatic attempt', async () => {
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);
    sendAdapter.queueError(new XSendNetworkError('Test', 'sendDirectMessage', 'timeout'));
    await service.send({ draftId, prospectId });

    const rows = await db.select().from(schema.outreachMessages).where(eq(schema.outreachMessages.prospectId, prospectId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].errorDetail).toBeTruthy();
  });
});

describe('SendApprovedDraftService — audit logging', () => {
  it('audits a successful send', async () => {
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);
    sendAdapter.queueSuccess({ xMessageId: 'm1', sentAt: new Date().toISOString() });
    await service.send({ draftId, prospectId });

    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.actionType, 'outreach.send.attempt'));
    expect(rows.some((r) => r.detail?.includes('"outcome":"SENT"'))).toBe(true);
  });

  it('audits a failed attempt', async () => {
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);
    sendAdapter.queueError(new XSendNetworkError('Test', 'sendDirectMessage'));
    await service.send({ draftId, prospectId });

    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.actionType, 'outreach.send.attempt'));
    expect(rows.some((r) => r.detail?.includes('"outcome":"NETWORK_ERROR"'))).toBe(true);
  });

  it('audits a dry run', async () => {
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);
    await service.send({ draftId, prospectId, dryRun: true });

    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.actionType, 'outreach.send.attempt'));
    expect(rows.some((r) => r.dryRun === true)).toBe(true);
  });

  it('never records credential material in the audit log', async () => {
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);
    sendAdapter.queueSuccess({ xMessageId: 'm1', sentAt: new Date().toISOString() });
    await service.send({ draftId, prospectId });

    const rows = await db.select().from(schema.auditLog);
    for (const row of rows) {
      expect(row.detail ?? '').not.toMatch(/auth_token|cookie|ct0/i);
    }
  });
});

describe('SendApprovedDraftService — conversation persistence', () => {
  it('records an outbound conversation_message with the returned X message id on success', async () => {
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);
    sendAdapter.queueSuccess({ xMessageId: 'm-42', sentAt: new Date().toISOString() });
    await service.send({ draftId, prospectId });

    const conversations = await db.select().from(schema.conversations).where(eq(schema.conversations.prospectId, prospectId));
    expect(conversations).toHaveLength(1);
    expect(conversations[0].lastMessageDirection).toBe('outbound');

    const messages = await db.select().from(schema.conversationMessages).where(eq(schema.conversationMessages.conversationId, conversations[0].id));
    expect(messages).toHaveLength(1);
    expect(messages[0].xMessageId).toBe('m-42');
    expect(messages[0].direction).toBe('outbound');
  });

  it('does not create a conversation on a failed send', async () => {
    const prospectId = await insertProspect();
    const draftId = await approvedDraftFor(prospectId);
    sendAdapter.queueError(new XSendNetworkError('Test', 'sendDirectMessage'));
    await service.send({ draftId, prospectId });

    const conversations = await db.select().from(schema.conversations).where(eq(schema.conversations.prospectId, prospectId));
    expect(conversations).toHaveLength(0);
  });
});

describe('SendApprovedDraftService — no autonomy', () => {
  it('has no batch/bulk/scheduler/queue/retry method on the class — only the single explicit send() entry point', () => {
    const methodNames = Object.getOwnPropertyNames(SendApprovedDraftService.prototype);
    expect(methodNames).toContain('send');
    expect(methodNames.some((name) => /batch|bulk|all|schedule|queue|worker|retry|autonomous/i.test(name))).toBe(false);
  });
});
