import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { KillSwitch, SystemConfigService, type MetrivioDb } from '@metrivio/core';
import {
  WebsiteReadTimeoutError,
  WebsiteReadNotFoundError,
  WebsiteReadBlockedError,
  WebsiteReadNetworkError,
  WebsiteReadUnexpectedError,
} from '@metrivio/core';
import { WebsiteContentAdapter } from '../src/website-content.adapter.js';
import { createTestDb } from './helpers/test-db.js';

/**
 * Every test here mocks `fetch` directly (via the adapter's `fetchImpl`
 * injection point) — never a live network call. This environment's egress
 * policy blocks arbitrary outbound HTTP anyway (verified in earlier stages
 * of this session), so no live website fetch is possible or claimed here.
 */

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

function jsonResponse(html: string, opts: { status?: number; contentType?: string } = {}): Response {
  return new Response(html, {
    status: opts.status ?? 200,
    headers: { 'content-type': opts.contentType ?? 'text/html' },
  });
}

function withUrl(response: Response, url: string): Response {
  Object.defineProperty(response, 'url', { value: url, configurable: true });
  return response;
}

describe('WebsiteContentAdapter.fetchPage', () => {
  it('fetches a page, strips HTML, and returns visible text plus status/url metadata', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const target = url.toString();
      if (target.endsWith('/robots.txt')) return jsonResponse('', { status: 404 });
      return withUrl(jsonResponse('<html><head><title>x</title></head><body><h1>Acme</h1><p>We are a DTC brand.</p></body></html>'), target);
    }) as unknown as typeof fetch;

    const adapter = new WebsiteContentAdapter({ killSwitch, fetchImpl });
    const result = await adapter.fetchPage('https://acme.example/about');
    expect(result.statusCode).toBe(200);
    expect(result.text).toContain('Acme');
    expect(result.text).toContain('We are a DTC brand.');
    expect(result.text).not.toContain('<h1>');
    expect(result.finalUrl).toBe('https://acme.example/about');
  });

  it('throws WebsiteReadNotFoundError on HTTP 404', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const target = url.toString();
      if (target.endsWith('/robots.txt')) return jsonResponse('', { status: 404 });
      return jsonResponse('not found', { status: 404 });
    }) as unknown as typeof fetch;
    const adapter = new WebsiteContentAdapter({ killSwitch, fetchImpl });
    await expect(adapter.fetchPage('https://acme.example/gone')).rejects.toBeInstanceOf(WebsiteReadNotFoundError);
  });

  it('throws WebsiteReadBlockedError on HTTP 403', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const target = url.toString();
      if (target.endsWith('/robots.txt')) return jsonResponse('', { status: 404 });
      return jsonResponse('forbidden', { status: 403 });
    }) as unknown as typeof fetch;
    const adapter = new WebsiteContentAdapter({ killSwitch, fetchImpl });
    await expect(adapter.fetchPage('https://acme.example/blocked')).rejects.toBeInstanceOf(WebsiteReadBlockedError);
  });

  it('throws WebsiteReadBlockedError when robots.txt disallows the path', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const target = url.toString();
      if (target.endsWith('/robots.txt')) return jsonResponse('User-agent: *\nDisallow: /careers\n', { status: 200 });
      return jsonResponse('<html><body>should never be reached</body></html>');
    }) as unknown as typeof fetch;
    const adapter = new WebsiteContentAdapter({ killSwitch, fetchImpl });
    await expect(adapter.fetchPage('https://acme.example/careers')).rejects.toBeInstanceOf(WebsiteReadBlockedError);
  });

  it('allows a path robots.txt does not disallow', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const target = url.toString();
      if (target.endsWith('/robots.txt')) return jsonResponse('User-agent: *\nDisallow: /careers\n', { status: 200 });
      return withUrl(jsonResponse('<html><body>about page</body></html>'), target);
    }) as unknown as typeof fetch;
    const adapter = new WebsiteContentAdapter({ killSwitch, fetchImpl });
    const result = await adapter.fetchPage('https://acme.example/about');
    expect(result.text).toContain('about page');
  });

  it('treats a missing/unreachable robots.txt as "no restrictions" rather than failing the page fetch', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const target = url.toString();
      if (target.endsWith('/robots.txt')) throw new TypeError('network down');
      return withUrl(jsonResponse('<html><body>fine</body></html>'), target);
    }) as unknown as typeof fetch;
    const adapter = new WebsiteContentAdapter({ killSwitch, fetchImpl });
    const result = await adapter.fetchPage('https://acme.example/about');
    expect(result.text).toContain('fine');
  });

  it('throws WebsiteReadTimeoutError when the request is aborted', async () => {
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as unknown as typeof fetch;
    const adapter = new WebsiteContentAdapter({ killSwitch, fetchImpl, defaultTimeoutMs: 5 });
    await expect(adapter.fetchPage('https://acme.example/slow')).rejects.toBeInstanceOf(WebsiteReadTimeoutError);
  });

  it('throws WebsiteReadNetworkError on a generic fetch failure', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const target = url.toString();
      if (target.endsWith('/robots.txt')) return jsonResponse('', { status: 404 });
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const adapter = new WebsiteContentAdapter({ killSwitch, fetchImpl });
    await expect(adapter.fetchPage('https://acme.example/down')).rejects.toBeInstanceOf(WebsiteReadNetworkError);
  });

  it('throws WebsiteReadUnexpectedError on an unrecognized non-2xx status', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const target = url.toString();
      if (target.endsWith('/robots.txt')) return jsonResponse('', { status: 404 });
      return jsonResponse('server error', { status: 500 });
    }) as unknown as typeof fetch;
    const adapter = new WebsiteContentAdapter({ killSwitch, fetchImpl });
    await expect(adapter.fetchPage('https://acme.example/error')).rejects.toBeInstanceOf(WebsiteReadUnexpectedError);
  });

  it('throws WebsiteReadUnexpectedError on an invalid URL', async () => {
    const fetchImpl = (async () => jsonResponse('')) as unknown as typeof fetch;
    const adapter = new WebsiteContentAdapter({ killSwitch, fetchImpl });
    await expect(adapter.fetchPage('not a url')).rejects.toBeInstanceOf(WebsiteReadUnexpectedError);
  });

  it('refuses to fetch when the kill switch is active', async () => {
    const config = new SystemConfigService(db);
    await config.setKillSwitch(true, 'test');
    const activeKillSwitch = new KillSwitch(config);
    const fetchImpl = (async () => jsonResponse('<html></html>')) as unknown as typeof fetch;
    const adapter = new WebsiteContentAdapter({ killSwitch: activeKillSwitch, fetchImpl });
    await expect(adapter.fetchPage('https://acme.example/')).rejects.toThrow(/Kill switch is active/);
  });

  it('caches robots.txt per origin — only fetches it once across multiple page fetches to the same domain', async () => {
    let robotsFetchCount = 0;
    const fetchImpl = (async (url: string | URL) => {
      const target = url.toString();
      if (target.endsWith('/robots.txt')) {
        robotsFetchCount += 1;
        return jsonResponse('User-agent: *\n', { status: 200 });
      }
      return withUrl(jsonResponse('<html><body>ok</body></html>'), target);
    }) as unknown as typeof fetch;
    const adapter = new WebsiteContentAdapter({ killSwitch, fetchImpl });
    await adapter.fetchPage('https://acme.example/');
    await adapter.fetchPage('https://acme.example/about');
    expect(robotsFetchCount).toBe(1);
  });
});
