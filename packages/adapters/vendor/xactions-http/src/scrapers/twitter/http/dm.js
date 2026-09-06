// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * Twitter/X Direct Message — Send Only (Stage 6B-R vendoring)
 *
 * This is a TRIMMED EXCERPT of upstream `nirholas/xactions`'
 * `src/scrapers/twitter/http/dm.js` at the same pinned commit already used
 * for the rest of this vendored subtree (`52fbf89991668d58f7a9e7abbed4441734f87c01`,
 * see `../../../../VENDOR.md`). The three functions below —
 * `requireAuth`, `buildDMBody`, `sendDM` — are byte-identical to upstream
 * (only the `GRAPHQL` import and every function upstream defines beyond
 * these three were removed). Verified directly against upstream's own test
 * suite (`tests/http-scraper/dm.test.js`, `describe('sendDM()', ...)`),
 * which asserts this exact request body shape and URL.
 *
 * Deliberately NOT vendored from upstream's `dm.js` (Stage 6B-R: "Implement
 * ONLY the minimal transport necessary. Do not expand scope."):
 *   - `sendDMByUsername` / `resolveUserId` — Stage 6B's `XSendAdapter`
 *     contract requires a canonical X user ID already (never a username),
 *     so username resolution is out of scope, not merely unused.
 *   - `getInbox` / `getConversation` — read-only, but conversation/inbox
 *     reading is a distinct capability (reply detection) this codebase's
 *     Stage 6A/6B instructions explicitly defer to a later stage.
 *   - `deleteMessage` — a second, distinct write capability (deleting a
 *     sent DM) with no corresponding contract anywhere in this codebase.
 *   - `markRead` — read-receipt state, unrelated to sending.
 *   - `parseInboxState` / `parseConversationData` / `parseReactions` —
 *     parsing helpers that exist only to support the omitted functions
 *     above.
 * None of these are reachable from any Metrivio code — only `sendDM` is
 * imported by `../../../../src/xactions-send.adapter.ts`.
 *
 * @author nich (@nichxbt)
 * @license Apache-2.0
 */

import { REST, REST_BASE } from './endpoints.js';
import { AuthError, TwitterApiError } from './errors.js';

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
