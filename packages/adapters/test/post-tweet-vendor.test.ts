import { describe, it, expect, vi, afterEach } from 'vitest';
import { postTweetHttp, normalizeErrorResponse } from '../vendor/x-manager-http/post-tweet.js';

/**
 * Tests for the vendored `postTweetHttp` request/response logic itself
 * (Stage 8 Section AA — upstream transport tests). `global.fetch` is
 * mocked; no live X request is made or claimed (LIVE X TESTING: NOT
 * PERFORMED — see RISK_REGISTER.md §2L).
 */

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetchOnce(status: number, body: unknown, headers: Record<string, string> = {}) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null, entries: () => Object.entries(headers) },
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

describe('postTweetHttp — verified endpoint/method/payload', () => {
  it('POSTs to {baseUrl}/2/tweets with the exact Authorization header and a JSON {text} body', async () => {
    mockFetchOnce(201, { data: { id: '1', text: 'hi' } });
    await postTweetHttp('https://api.x.com', 'OAuth abc123', 'hi');
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://api.x.com/2/tweets');
    expect(call[1].method).toBe('POST');
    expect(call[1].headers.Authorization).toBe('OAuth abc123');
    expect(call[1].headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(call[1].body)).toEqual({ text: 'hi' });
  });

  it('never includes media/community_id/reply fields (text-only scope)', async () => {
    mockFetchOnce(201, { data: { id: '1', text: 'hi' } });
    await postTweetHttp('https://api.x.com', 'OAuth abc123', 'hi');
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body).not.toHaveProperty('media');
    expect(body).not.toHaveProperty('community_id');
    expect(body).not.toHaveProperty('reply');
  });
});

describe('postTweetHttp — response parsing', () => {
  it('returns data.id/data.text on a 201 success', async () => {
    mockFetchOnce(201, { data: { id: '42', text: 'hello' } });
    const result = await postTweetHttp('https://api.x.com', 'OAuth x', 'hello');
    expect(result.data).toEqual({ id: '42', text: 'hello' });
    expect(result.httpStatus).toBe(201);
  });

  it('normalizes a JSON:API-style {detail} error body on non-OK response', async () => {
    mockFetchOnce(401, { detail: 'Unauthorized' });
    const result = await postTweetHttp('https://api.x.com', 'OAuth x', 'hello');
    expect(result.errors?.[0]?.message).toContain('Unauthorized');
    expect(result.httpStatus).toBe(401);
  });

  it('normalizes an errors[] array on non-OK response', async () => {
    mockFetchOnce(400, { errors: [{ message: 'text is too long' }] });
    const result = await postTweetHttp('https://api.x.com', 'OAuth x', 'hello');
    expect(result.errors?.[0]?.message).toContain('text is too long');
  });

  it('appends the read-only-permissions hint when x-access-level header is "read"', async () => {
    mockFetchOnce(403, { detail: 'Forbidden' }, { 'x-access-level': 'read' });
    const result = await postTweetHttp('https://api.x.com', 'OAuth x', 'hello');
    expect(result.errors?.[0]?.message).toContain('read-only');
  });

  it('falls back to a generic message when the error body has no recognizable field', async () => {
    mockFetchOnce(500, {});
    const result = await postTweetHttp('https://api.x.com', 'OAuth x', 'hello');
    expect(result.errors?.[0]?.message).toContain('X API request failed with status 500');
  });

  it('handles a non-JSON error body by wrapping it as {detail: rawBody}', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      headers: { get: () => null, entries: () => [] },
      text: async () => 'Bad Gateway (plain text, not JSON)',
    } as unknown as Response);
    const result = await postTweetHttp('https://api.x.com', 'OAuth x', 'hello');
    expect(result.errors?.[0]?.message).toContain('Bad Gateway');
  });

  it('returns an invalid_response error when the success body is empty/unparseable', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null, entries: () => [] },
      text: async () => '',
    } as unknown as Response);
    const result = await postTweetHttp('https://api.x.com', 'OAuth x', 'hello');
    expect(result.errors?.[0]?.type).toBe('invalid_response');
  });

  it('returns a network_error-typed result (no httpStatus) when fetch itself rejects', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.x.com'));
    const result = await postTweetHttp('https://api.x.com', 'OAuth x', 'hello');
    expect(result.errors?.[0]?.type).toBe('network_error');
    expect(result.httpStatus).toBeUndefined();
  });
});

describe('normalizeErrorResponse — deduplicates repeated messages', () => {
  it('never emits the same message twice', () => {
    const response = { status: 400, headers: { get: () => null } } as unknown as Response;
    const normalized = normalizeErrorResponse(response, { errors: [{ message: 'dup' }, { message: 'dup' }] });
    const message = normalized.errors?.[0]?.message ?? '';
    expect(message.split('dup').length - 1).toBe(1);
  });
});
