import type { XReplyDetectorAdapter, ConversationMessageObservation } from '@metrivio/core';
import {
  KillSwitch,
  XReplyDetectorAuthenticationRequiredError,
  XReplyDetectorRateLimitedError,
  XReplyDetectorNotFoundError,
  XReplyDetectorNetworkError,
  XReplyDetectorUnexpectedError,
} from '@metrivio/core';

import { TwitterHttpClient } from '../vendor/xactions-http/src/scrapers/twitter/http/client.js';
import { getInbox, getConversation } from '../vendor/xactions-http/src/scrapers/twitter/http/dm.js';
import {
  TwitterApiError,
  RateLimitError,
  AuthError,
  NotFoundError,
  NetworkError,
} from '../vendor/xactions-http/src/scrapers/twitter/http/errors.js';

/**
 * XActions-backed implementation of `XReplyDetectorAdapter` — Stage 6C.
 *
 * `getConversationMessages(targetUserId)` resolves the X-native
 * conversation for a canonical user ID *dynamically*, on every call, via
 * `getInbox()`'s participant list (`participants[].id`, X's own numeric
 * user ID) rather than persisting an `x_conversation_id` anywhere —
 * DATABASE.md's `conversations` table has no such column, and none was
 * added (see RISK_REGISTER.md Stage 6C's conversation-mapping finding:
 * this is a deliberate design choice, not a schema gap, since the
 * already-vendored `getInbox()` makes a persisted ID unnecessary). Only
 * the first page of the inbox is fetched (bounded, no pagination loop) —
 * a target whose conversation falls outside that page is a documented
 * limitation (see RISK_REGISTER.md), never silently treated as "no
 * conversation."
 *
 * Mirrors `XActionsSendAdapter`'s exact structure: kill switch checked
 * first, authentication precondition checked next (DM/conversation
 * reading requires the same authenticated session as sending — there is
 * no guest-mode equivalent), and every underlying XActions error mapped
 * to the generic `XReplyDetector*Error` taxonomy before it ever leaves
 * this file.
 */
export interface XActionsReplyDetectorAdapterOptions {
  killSwitch: KillSwitch;
  /** Cookie string (`auth_token=...; ct0=...`). Required — DM/conversation reading has no guest-mode equivalent. Must come from the existing credential/encryption storage (DATABASE.md `credentials` table), never a plain environment variable read inline at call time. */
  sessionCookie?: string;
  /** Test-only escape hatch to inject a pre-built client instead of constructing one. Never used in production wiring. */
  client?: TwitterHttpClient;
}

function mapError(adapterName: string, method: string, err: unknown): Error {
  if (err instanceof RateLimitError) {
    return new XReplyDetectorRateLimitedError(adapterName, method, err.message);
  }
  if (err instanceof AuthError) {
    return new XReplyDetectorAuthenticationRequiredError(adapterName, method, err.message);
  }
  if (err instanceof NotFoundError) {
    return new XReplyDetectorNotFoundError(adapterName, method, err.message);
  }
  if (err instanceof NetworkError) {
    return new XReplyDetectorNetworkError(adapterName, method, err.message);
  }
  if (err instanceof TwitterApiError) {
    return new XReplyDetectorUnexpectedError(adapterName, method, err.message);
  }
  return new XReplyDetectorUnexpectedError(adapterName, method, err instanceof Error ? err.message : String(err));
}

export class XActionsReplyDetectorAdapter implements XReplyDetectorAdapter {
  private static readonly NAME = 'XActionsReplyDetectorAdapter';
  private readonly killSwitch: KillSwitch;
  private readonly client: TwitterHttpClient;

  constructor(options: XActionsReplyDetectorAdapterOptions) {
    this.killSwitch = options.killSwitch;
    this.client =
      options.client ??
      new TwitterHttpClient({
        cookies: options.sessionCookie || undefined,
        rateLimitStrategy: 'error',
      });
  }

  async getConversationMessages(targetUserId: string): Promise<ConversationMessageObservation[]> {
    await this.killSwitch.assertNotActive('x.read.getConversationMessages');

    if (!this.client.isAuthenticated()) {
      throw new XReplyDetectorAuthenticationRequiredError(XActionsReplyDetectorAdapter.NAME, 'getConversationMessages', 'no session cookie configured');
    }

    try {
      const inbox = await getInbox(this.client);
      const conversation = inbox.conversations.find(
        (c) => c.type === 'one_to_one' && c.participants.some((p) => p.id === targetUserId)
      );
      if (!conversation) {
        // No X-side conversation with this user exists yet (or it falls
        // outside the first inbox page — see this class's doc comment) —
        // a legitimate empty result, not an error.
        return [];
      }

      const { messages } = await getConversation(this.client, conversation.conversationId);
      return messages.map((m) => ({
        xMessageId: m.id,
        senderXUserId: m.senderId,
        text: m.text,
        createdAt: m.createdAt,
      }));
    } catch (err) {
      throw mapError(XActionsReplyDetectorAdapter.NAME, 'getConversationMessages', err);
    }
  }
}
