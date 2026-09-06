import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { KillSwitch, SystemConfigService, type MetrivioDb } from '@metrivio/core';
import {
  XReplyDetectorAuthenticationRequiredError,
  XReplyDetectorRateLimitedError,
  XReplyDetectorNotFoundError,
  XReplyDetectorNetworkError,
  XReplyDetectorUnexpectedError,
} from '@metrivio/core';
import { createTestDb } from './helpers/test-db.js';

/**
 * All tests here inject a fake `TwitterHttpClient`-shaped object — never a
 * real network call, for the same reason `xactions-send.adapter.test.ts`
 * does (this adapter's methods call through to real, verified vendored
 * `getInbox`/`getConversation`, which perform a real `client.request()`
 * HTTP call against a real `TwitterHttpClient`).
 */
const { XActionsReplyDetectorAdapter } = await import('../src/xactions-reply-detector.adapter.js');

function fakeClient(overrides: Partial<{ isAuthenticated: () => boolean; request: (url: string, opts: unknown) => Promise<unknown> }> = {}) {
  return {
    isAuthenticated: overrides.isAuthenticated ?? (() => true),
    request: overrides.request ?? vi.fn().mockResolvedValue({ inbox_initial_state: { conversations: {}, entries: [], users: {} } }),
  };
}

function inboxFixture(conversationId: string, participantIds: string[], type: 'ONE_TO_ONE' | 'GROUP_DM' = 'ONE_TO_ONE') {
  const users: Record<string, unknown> = {};
  for (const id of participantIds) users[id] = { screen_name: `user${id}` };
  return {
    inbox_initial_state: {
      conversations: {
        [conversationId]: { type, participants: participantIds.map((id) => ({ user_id: id })), unread_count: 0 },
      },
      entries: [],
      users,
      cursor: null,
    },
  };
}

function conversationFixture(messages: Array<{ id: string; senderId: string; text: string; time: string }>) {
  return {
    conversation_timeline: {
      entries: messages.map((m) => ({ message: { id: m.id, time: m.time, message_data: { text: m.text, sender_id: m.senderId } } })),
    },
  };
}

let db: MetrivioDb;
let sqlite: Database.Database;
let killSwitch: KillSwitch;

beforeEach(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  const config = new SystemConfigService(db);
  await config.setKillSwitch(false, 'test');
  killSwitch = new KillSwitch(config);
});

afterEach(() => sqlite.close());

describe('XActionsReplyDetectorAdapter.getConversationMessages — kill switch / auth', () => {
  it('refuses when the kill switch is active, before touching the client', async () => {
    const config = new SystemConfigService(db);
    await config.setKillSwitch(true, 'test');
    const activeKillSwitch = new KillSwitch(config);
    const request = vi.fn();
    const adapter = new XActionsReplyDetectorAdapter({ killSwitch: activeKillSwitch, client: fakeClient({ request }) as never });
    await expect(adapter.getConversationMessages('200')).rejects.toThrow(/Kill switch is active/);
    expect(request).not.toHaveBeenCalled();
  });

  it('throws XReplyDetectorAuthenticationRequiredError when unauthenticated', async () => {
    const request = vi.fn();
    const adapter = new XActionsReplyDetectorAdapter({ killSwitch, client: fakeClient({ isAuthenticated: () => false, request }) as never });
    await expect(adapter.getConversationMessages('200')).rejects.toBeInstanceOf(XReplyDetectorAuthenticationRequiredError);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('XActionsReplyDetectorAdapter.getConversationMessages — conversation resolution', () => {
  it('finds the one_to_one conversation containing the target canonical user id and returns its messages', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(inboxFixture('conv-1', ['100', '200']))
      .mockResolvedValueOnce(conversationFixture([{ id: 'm1', senderId: '200', text: 'hey', time: '1700000000000' }]));
    const adapter = new XActionsReplyDetectorAdapter({ killSwitch, client: fakeClient({ request }) as never });

    const result = await adapter.getConversationMessages('200');
    expect(result).toHaveLength(1);
    expect(result[0].xMessageId).toBe('m1');
    expect(result[0].senderXUserId).toBe('200');
    expect(result[0].text).toBe('hey');
  });

  it('returns an empty array when no conversation with the target exists yet (legitimate empty result, not an error)', async () => {
    const request = vi.fn().mockResolvedValueOnce(inboxFixture('conv-1', ['100', '999']));
    const adapter = new XActionsReplyDetectorAdapter({ killSwitch, client: fakeClient({ request }) as never });

    const result = await adapter.getConversationMessages('200');
    expect(result).toEqual([]);
  });

  it('ignores a group DM conversation even if the target is a participant', async () => {
    const request = vi.fn().mockResolvedValueOnce(inboxFixture('conv-1', ['100', '200', '300'], 'GROUP_DM'));
    const adapter = new XActionsReplyDetectorAdapter({ killSwitch, client: fakeClient({ request }) as never });

    const result = await adapter.getConversationMessages('200');
    expect(result).toEqual([]);
  });

  it('never fetches the conversation itself when none matches (bounded — no wasted call)', async () => {
    const request = vi.fn().mockResolvedValueOnce(inboxFixture('conv-1', ['100', '999']));
    const adapter = new XActionsReplyDetectorAdapter({ killSwitch, client: fakeClient({ request }) as never });

    await adapter.getConversationMessages('200');
    expect(request).toHaveBeenCalledOnce();
  });
});

describe('XActionsReplyDetectorAdapter.getConversationMessages — error mapping', () => {
  it('maps AuthError to XReplyDetectorAuthenticationRequiredError', async () => {
    const { AuthError } = await import('../vendor/xactions-http/src/scrapers/twitter/http/errors.js');
    const request = vi.fn().mockRejectedValue(new AuthError('nope'));
    const adapter = new XActionsReplyDetectorAdapter({ killSwitch, client: fakeClient({ request }) as never });
    await expect(adapter.getConversationMessages('200')).rejects.toBeInstanceOf(XReplyDetectorAuthenticationRequiredError);
  });

  it('maps RateLimitError to XReplyDetectorRateLimitedError', async () => {
    const { RateLimitError } = await import('../vendor/xactions-http/src/scrapers/twitter/http/errors.js');
    const request = vi.fn().mockRejectedValue(new RateLimitError('slow down'));
    const adapter = new XActionsReplyDetectorAdapter({ killSwitch, client: fakeClient({ request }) as never });
    await expect(adapter.getConversationMessages('200')).rejects.toBeInstanceOf(XReplyDetectorRateLimitedError);
  });

  it('maps NotFoundError to XReplyDetectorNotFoundError', async () => {
    const { NotFoundError } = await import('../vendor/xactions-http/src/scrapers/twitter/http/errors.js');
    const request = vi.fn().mockRejectedValue(new NotFoundError('nope'));
    const adapter = new XActionsReplyDetectorAdapter({ killSwitch, client: fakeClient({ request }) as never });
    await expect(adapter.getConversationMessages('200')).rejects.toBeInstanceOf(XReplyDetectorNotFoundError);
  });

  it('maps NetworkError to XReplyDetectorNetworkError', async () => {
    const { NetworkError } = await import('../vendor/xactions-http/src/scrapers/twitter/http/errors.js');
    const request = vi.fn().mockRejectedValue(new NetworkError('timeout'));
    const adapter = new XActionsReplyDetectorAdapter({ killSwitch, client: fakeClient({ request }) as never });
    await expect(adapter.getConversationMessages('200')).rejects.toBeInstanceOf(XReplyDetectorNetworkError);
  });

  it('maps a malformed response error to XReplyDetectorUnexpectedError', async () => {
    const { TwitterApiError } = await import('../vendor/xactions-http/src/scrapers/twitter/http/errors.js');
    const request = vi.fn().mockRejectedValue(new TwitterApiError('weird'));
    const adapter = new XActionsReplyDetectorAdapter({ killSwitch, client: fakeClient({ request }) as never });
    await expect(adapter.getConversationMessages('200')).rejects.toBeInstanceOf(XReplyDetectorUnexpectedError);
  });

  it('maps a totally unrecognized error to XReplyDetectorUnexpectedError rather than leaking it', async () => {
    const request = vi.fn().mockRejectedValue(new Error('surprise'));
    const adapter = new XActionsReplyDetectorAdapter({ killSwitch, client: fakeClient({ request }) as never });
    await expect(adapter.getConversationMessages('200')).rejects.toBeInstanceOf(XReplyDetectorUnexpectedError);
  });
});

describe('XActionsReplyDetectorAdapter.getConversationMessages — credential safety', () => {
  it('never includes cookie/credential material in a thrown error message', async () => {
    const { NetworkError } = await import('../vendor/xactions-http/src/scrapers/twitter/http/errors.js');
    const request = vi.fn().mockRejectedValue(new NetworkError('timeout while reading'));
    const adapter = new XActionsReplyDetectorAdapter({ killSwitch, client: fakeClient({ request }) as never });
    try {
      await adapter.getConversationMessages('200');
      expect.unreachable();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toMatch(/auth_token|ct0=|cookie:/i);
    }
  });
});
