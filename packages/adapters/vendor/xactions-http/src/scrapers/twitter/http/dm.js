// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * Twitter/X Direct Message — Send + Read-Only Conversation Lookup
 * (Stage 6B-R vendored `sendDM`; Stage 6C extends with `getInbox`/
 * `getConversation` for reply detection.)
 *
 * This is a TRIMMED EXCERPT of upstream `nirholas/xactions`'
 * `src/scrapers/twitter/http/dm.js` at the same pinned commit already used
 * for the rest of this vendored subtree (`52fbf89991668d58f7a9e7abbed4441734f87c01`,
 * see `../../../../VENDOR.md`). Every function below is byte-identical to
 * upstream (only the unused `GRAPHQL` import was removed). Verified
 * directly against upstream's own test suite
 * (`tests/http-scraper/dm.test.js`), which asserts each function's exact
 * request URL/body and response-parsing shape against a mocked client.
 *
 * Deliberately NOT vendored from upstream's `dm.js`:
 *   - `sendDMByUsername` / `resolveUserId` — Stage 6B's `XSendAdapter`
 *     contract requires a canonical X user ID already (never a username),
 *     so username resolution is out of scope, not merely unused.
 *   - `deleteMessage` — a second, distinct write capability (deleting a
 *     sent DM) with no corresponding contract anywhere in this codebase.
 *   - `markRead` — read-receipt state, unrelated to sending or reply
 *     detection.
 * None of these are reachable from any Metrivio code — only `sendDM`
 * (Stage 6B-R) and `getInbox`/`getConversation` (Stage 6C) are imported,
 * by `../../../../src/xactions-send.adapter.ts` and
 * `../../../../src/xactions-reply-detector.adapter.ts` respectively.
 *
 * @author nich (@nichxbt)
 * @license Apache-2.0
 */

import { REST, REST_BASE } from './endpoints.js';
import { AuthError, TwitterApiError } from './errors.js';

/** Default limit for inbox conversations. */
const DEFAULT_INBOX_LIMIT = 50;

/** Default limit for messages in a conversation. */
const DEFAULT_CONVERSATION_LIMIT = 100;

/**
 * Assert the client is authenticated; throw AuthError otherwise.
 * @param {import('./client.js').TwitterHttpClient} client
 */
function requireAuth(client) {
  if (!client.isAuthenticated()) {
    throw new AuthError('Authentication required for DM operations');
  }
}

/**
 * Build the JSON body for the DM send endpoint.
 *
 * @param {string} recipientId
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.mediaId] — media ID for image/video attachment
 * @returns {object}
 */
function buildDMBody(recipientId, text, options = {}) {
  const messageData = { text };

  if (options.mediaId) {
    messageData.attachment = {
      type: 'media',
      media: { id: options.mediaId },
    };
  }

  return {
    event: {
      type: 'message_create',
      message_create: {
        target: { recipient_id: String(recipientId) },
        message_data: messageData,
      },
    },
  };
}

/**
 * Parse inbox state into normalized conversation list.
 *
 * @param {object} inboxState — raw inbox_initial_state object
 * @param {object} [options]
 * @param {number} [options.limit]
 * @returns {{ conversations: object[], cursor: string|null }}
 */
function parseInboxState(inboxState, options = {}) {
  const entries = inboxState?.inbox_initial_state ?? inboxState ?? {};
  const conversations = entries.conversations ?? {};
  const entries_data = entries.entries ?? [];
  const users = entries.users ?? {};
  const limit = options.limit || DEFAULT_INBOX_LIMIT;

  const result = [];

  for (const [convId, conv] of Object.entries(conversations)) {
    if (result.length >= limit) break;

    // Participants
    const participantIds = (conv.participants ?? []).map(
      (p) => p.user_id || p,
    );
    const participants = participantIds.map((uid) => {
      const u = users[uid] ?? {};
      return {
        id: String(uid),
        username: u.screen_name || '',
        name: u.name || '',
        avatar: u.profile_image_url_https || '',
      };
    });

    // Last message from the entries matching this conversation
    const convEntries = entries_data.filter(
      (e) =>
        e?.message?.conversation_id === convId ||
        e?.conversation_id === convId,
    );
    const lastEntry = convEntries[0] ?? {};
    const lastMsg = lastEntry?.message?.message_data ?? {};

    result.push({
      conversationId: convId,
      participants,
      lastMessage: {
        text: lastMsg.text || '',
        createdAt: lastEntry?.message?.time
          ? new Date(Number(lastEntry.message.time)).toISOString()
          : '',
        senderId: lastEntry?.message?.message_data?.sender_id ||
          lastEntry?.message?.sender_id || '',
      },
      unreadCount: Number(conv.unread_count ?? 0),
      type: conv.type === 'GROUP_DM' ? 'group' : 'one_to_one',
    });
  }

  const cursor = entries.cursor || null;

  return { conversations: result, cursor };
}

/**
 * Parse a conversation response into normalized message array.
 *
 * @param {object} convData — raw conversation data
 * @param {object} [options]
 * @param {number} [options.limit]
 * @returns {{ messages: object[], cursor: string|null }}
 */
function parseConversationData(convData, options = {}) {
  const limit = options.limit || DEFAULT_CONVERSATION_LIMIT;
  const state = convData?.conversation_timeline ?? convData ?? {};
  const entries = state?.entries ?? [];
  const messages = [];

  for (const entry of entries) {
    if (messages.length >= limit) break;

    const msg = entry?.message ?? entry;
    if (!msg?.id && !msg?.message_data) continue;

    const msgData = msg.message_data ?? {};
    const media = [];
    const attachment = msgData.attachment;
    if (attachment?.media) {
      media.push({
        type: attachment.media.type || 'photo',
        url: attachment.media.media_url_https || attachment.media.url || '',
      });
    }

    messages.push({
      id: msg.id || entry.id || '',
      text: msgData.text || msg.text || '',
      senderId: msgData.sender_id || msg.sender_id || '',
      createdAt: msg.time
        ? new Date(Number(msg.time)).toISOString()
        : msg.created_timestamp
          ? new Date(Number(msg.created_timestamp)).toISOString()
          : '',
      media: media.length > 0 ? media : null,
      reactions: parseReactions(msg.reactions ?? entry.reactions),
    });
  }

  const cursor = state.min_entry_id || state.cursor || null;

  return { messages, cursor };
}

/**
 * Parse reaction data from a message.
 *
 * @param {Array} reactions — raw reaction data
 * @returns {Array<{ emoji: string, senderId: string }>}
 */
function parseReactions(reactions) {
  if (!Array.isArray(reactions)) return [];
  return reactions.map((r) => ({
    emoji: r.key || r.emoji || '',
    senderId: r.sender_id || '',
  }));
}

// ===========================================================================
// Public API
// ===========================================================================

/**
 * Send a direct message to a user by their user ID.
 *
 * REST: POST /1.1/dm/new2.json (upstream's own JSDoc names the legacy
 * `/1.1/direct_messages/events/new.json` path, but the code — and
 * `REST.dmNew`, which is what's actually requested — uses `dm/new2.json`;
 * the body shape matches X's documented legacy DM-events schema even
 * though it targets this newer endpoint path).
 *
 * @param {import('./client.js').TwitterHttpClient} client — authenticated client
 * @param {string} recipientId — recipient user ID
 * @param {string} text — message text
 * @param {object} [options]
 * @param {string} [options.mediaId] — media ID for image/video attachment
 * @returns {Promise<{ messageId: string, createdAt: string }>}
 */
export async function sendDM(client, recipientId, text, options = {}) {
  requireAuth(client);

  if (!recipientId) {
    throw new TwitterApiError('recipientId is required');
  }
  if (!text || typeof text !== 'string') {
    throw new TwitterApiError('DM text must be a non-empty string');
  }

  const body = buildDMBody(recipientId, text, options);
  const url = `${REST_BASE}${REST.dmNew}`;

  const response = await client.request(url, {
    method: 'POST',
    body,
  });

  // Parse the created event
  const event = response?.event ?? {};
  return {
    messageId: event.id || '',
    createdAt: event.created_timestamp
      ? new Date(Number(event.created_timestamp)).toISOString()
      : new Date().toISOString(),
  };
}

/**
 * Fetch the DM inbox (list of conversations).
 *
 * REST: GET /1.1/dm/inbox_initial_state.json
 *
 * @param {import('./client.js').TwitterHttpClient} client — authenticated client
 * @param {object} [options]
 * @param {number} [options.limit=50] — max conversations to return
 * @param {string} [options.cursor] — pagination cursor
 * @returns {Promise<{ conversations: object[], cursor: string|null }>}
 */
export async function getInbox(client, options = {}) {
  requireAuth(client);

  const params = new URLSearchParams();
  if (options.cursor) {
    params.set('cursor', options.cursor);
  }

  const queryString = params.toString();
  const path = REST.dmInbox + (queryString ? `?${queryString}` : '');
  const url = `${REST_BASE}${path}`;

  const response = await client.request(url, {
    method: 'GET',
  });

  return parseInboxState(response, { limit: options.limit });
}

/**
 * Fetch messages in a specific conversation.
 *
 * REST: GET /1.1/dm/conversation/{conversationId}.json
 *
 * @param {import('./client.js').TwitterHttpClient} client — authenticated client
 * @param {string} conversationId — conversation ID
 * @param {object} [options]
 * @param {number} [options.limit=100] — max messages to return
 * @param {string} [options.cursor] — pagination cursor (max_id)
 * @returns {Promise<{ messages: object[], cursor: string|null }>}
 */
export async function getConversation(client, conversationId, options = {}) {
  requireAuth(client);

  if (!conversationId) {
    throw new TwitterApiError('conversationId is required');
  }

  const params = new URLSearchParams();
  if (options.cursor) {
    params.set('max_id', options.cursor);
  }

  const queryString = params.toString();
  const path = `${REST.dmConversation}/${conversationId}.json${queryString ? `?${queryString}` : ''}`;
  const url = `${REST_BASE}${path}`;

  const response = await client.request(url, {
    method: 'GET',
  });

  return parseConversationData(response, { limit: options.limit });
}
