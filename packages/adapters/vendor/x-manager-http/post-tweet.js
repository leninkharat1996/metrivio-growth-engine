// Vendored (trimmed, adapted) from tylerbuilds/x-manager at pinned commit
// a3534ba953fc88beac79fc12ca5ebbcd4f3bed2d, `src/lib/twitter-api-client.ts`.
// See VENDOR.md in this directory for the full provenance record, the exact
// diff against upstream, and why this is an adapted excerpt rather than a
// byte-identical copy (unlike most of packages/content/vendor/x-manager,
// which is a whole-repo plain snapshot).
//
// What is preserved byte-for-byte in logic (only converted from TS to plain
// JS, and renamed per this file's own scope): `asRecord`, `asString`,
// `uniqueMessages`, `normalizeErrorResponse`, and the `POST /2/tweets`
// request/response handling body of `postTweet` (endpoint construction,
// payload shape, response parsing, error paths).
//
// What was CHANGED at the injection seam (documented in VENDOR.md):
//   - OAuth header generation (`createOAuthClient`/`generateOAuthHeaders`,
//     which upstream implements via the `oauth-1.0a` + `crypto-js` npm
//     packages) is NOT reproduced here. This module accepts an
//     already-built `Authorization` header string as a parameter instead.
//     Metrivio's own OAuth1 signer (`packages/adapters/src/oauth1-signer.ts`)
//     produces that header — see that file's doc comment for why it is a
//     from-scratch reimplementation of the OAuth 1.0a spec rather than a
//     vendored copy, and why it deliberately follows the exact same
//     documented "do NOT include the request body in the OAuth signature
//     for v2 endpoints" rule as upstream's `generateOAuthHeaders`.
//   - Config resolution (`resolveConfig`/`getResolvedXConfig`, which reads
//     upstream's own separate Next.js/Drizzle-backed app settings) is NOT
//     reproduced here. This module accepts the base URL as a parameter.
//   - `media`/`community_id`/`reply` payload fields are removed — Stage 8's
//     scope is TEXT-ONLY public posts (see RISK_REGISTER.md §2L).
//   - The `console.error` diagnostic logging upstream performs on non-OK
//     responses is removed (never log request/response bodies here, since a
//     future caller could accidentally pass a header/body containing a
//     credential; this excerpt takes only the pre-built Authorization
//     header string and text, and never receives raw credentials itself).

export function asRecord(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  return null;
}

export function asString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function uniqueMessages(messages) {
  return [...new Set(messages.map((message) => message.trim()).filter(Boolean))];
}

// Byte-for-byte logic match with upstream `normalizeErrorResponse` (TS -> JS only).
export function normalizeErrorResponse(response, payload) {
  const record = asRecord(payload);
  const messages = [];

  const nestedErrors = Array.isArray(record?.errors) ? record.errors : [];
  for (const nestedError of nestedErrors) {
    const errorRecord = asRecord(nestedError);
    const message = asString(errorRecord?.message);
    if (message) {
      messages.push(message);
    }
  }

  const detail = asString(record?.detail);
  if (detail) {
    messages.push(detail);
  }

  const title = asString(record?.title);
  if (title) {
    messages.push(title);
  }

  const problemType = asString(record?.type);
  const accessLevel = response.headers.get('x-access-level');
  const isPermissionScopeError =
    accessLevel === 'read' || (problemType ? problemType.includes('oauth1-permissions') : false);

  if (isPermissionScopeError) {
    messages.push(
      'X app permissions are read-only. In X Developer Portal set User authentication permissions to "Read and write", then disconnect and reconnect this slot.',
    );
  }

  const normalizedMessages = uniqueMessages(messages);
  if (normalizedMessages.length === 0) {
    normalizedMessages.push(`X API request failed with status ${response.status}.`);
  }

  return {
    errors: [
      {
        message: normalizedMessages.join(' '),
        type: problemType || `http_${response.status}`,
      },
    ],
  };
}

/**
 * Publish a single text-only post via the verified `POST /2/tweets` endpoint.
 * Never throws for an HTTP-level or content-level rejection — those come
 * back as `{errors: [...]}`, exactly like upstream. Only a genuine
 * network-level failure (fetch itself rejecting) is returned as
 * `{errors: [{type: 'network_error', ...}]}` too, mirroring upstream's own
 * try/catch — the caller (XManagerPublishAdapter) is responsible for
 * mapping both cases to the appropriate `XPublish*Error`.
 *
 * @param {string} baseUrl - e.g. "https://api.x.com" (injected, never hardcoded here).
 * @param {string} authorizationHeader - full pre-built "OAuth ..." header value.
 * @param {string} text
 * @returns {Promise<{data?: {id: string, text: string}, errors?: Array<{message: string, type?: string}>}>}
 */
export async function postTweetHttp(baseUrl, authorizationHeader, text) {
  const url = `${baseUrl}/2/tweets`;
  const payload = { text };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: authorizationHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const rawBody = await response.text();
    let parsedBody = null;
    if (rawBody.trim().length > 0) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = { detail: rawBody };
      }
    }

    if (!response.ok) {
      return { httpStatus: response.status, ...normalizeErrorResponse(response, parsedBody) };
    }

    const result = asRecord(parsedBody);
    if (!result) {
      return {
        httpStatus: response.status,
        errors: [{ message: 'X API returned an empty or invalid response body.', type: 'invalid_response' }],
      };
    }

    return { httpStatus: response.status, ...result };
  } catch (error) {
    return {
      errors: [{ message: error instanceof Error ? error.message : 'Unknown error', type: 'network_error' }],
    };
  }
}
