import type { WebsiteReadAdapter, WebsiteReadOptions, WebsitePageResult } from '@metrivio/core';
import {
  KillSwitch,
  WebsiteReadTimeoutError,
  WebsiteReadNotFoundError,
  WebsiteReadBlockedError,
  WebsiteReadNetworkError,
  WebsiteReadUnexpectedError,
} from '@metrivio/core';
import { extractVisibleText } from './lib/html-text.js';
import { parseRobotsTxt, isPathDisallowed, type RobotsRules } from './lib/robots.js';

/**
 * `WebsiteReadAdapter` implementation using Node's built-in `fetch` — zero
 * new dependencies (BUILD_PLAN.md Stage 5 instruction: "no Scrapling, no
 * browser automation, prefer deterministic HTTP fetch/parse"). Mirrors
 * `XActionsReadAdapter`'s kill-switch-gated, error-mapped shape exactly, so
 * this is the second (not a differently-structured) example of the same
 * adapter discipline.
 *
 * Safety properties (instruction H):
 *  - Bounded: exactly one page per call, no following of in-page links.
 *  - Timeout-protected: every request is wrapped in an AbortController with
 *    a default, overridable timeout — never an unbounded wait.
 *  - Rate-limited: request budget is the caller's concern (the existing
 *    `daily_limit_scrapes` config, enforced by `WebsiteEvidenceService`),
 *    not duplicated here.
 *  - Deterministic: no randomness, no LLM calls — plain HTTP + regex-based
 *    text extraction.
 *  - Retry-limited: this adapter performs zero retries itself; a transient
 *    failure surfaces as one of the typed errors below rather than being
 *    silently retried into a different outcome.
 *  - Kill-switch-compatible: every call asserts the switch first, exactly
 *    like every write adapter and `XActionsReadAdapter`.
 *  - Logged: no credentials exist on this path to redact (this adapter
 *    takes no credentials at all — public pages only), so there is nothing
 *    to accidentally log.
 *  - robots.txt-respecting: fetched once per host and cached in-memory for
 *    the adapter instance's lifetime; a disallowed path is refused before
 *    any request to the page itself.
 */

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_USER_AGENT = 'MetrivioGrowthEngineBot/1.0 (+https://metrivio.example/bot)';

export interface WebsiteContentAdapterOptions {
  killSwitch: KillSwitch;
  defaultTimeoutMs?: number;
  /** Test-only escape hatch to inject a fetch implementation instead of the global one. Never used in production wiring. */
  fetchImpl?: typeof fetch;
}

export class WebsiteContentAdapter implements WebsiteReadAdapter {
  private static readonly NAME = 'WebsiteContentAdapter';
  private readonly killSwitch: KillSwitch;
  private readonly defaultTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly robotsCache = new Map<string, RobotsRules | null>();

  constructor(options: WebsiteContentAdapterOptions) {
    this.killSwitch = options.killSwitch;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetchPage(url: string, opts?: WebsiteReadOptions): Promise<WebsitePageResult> {
    await this.killSwitch.assertNotActive('website.read.fetchPage');

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      throw new WebsiteReadUnexpectedError(WebsiteContentAdapter.NAME, 'fetchPage', `invalid URL: ${err instanceof Error ? err.message : String(err)}`);
    }

    const robots = await this.getRobotsRules(parsed.origin);
    if (robots && isPathDisallowed(robots, parsed.pathname || '/')) {
      throw new WebsiteReadBlockedError(WebsiteContentAdapter.NAME, 'fetchPage', `${parsed.pathname} is disallowed by ${parsed.origin}/robots.txt`);
    }

    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    const response = await this.doFetch(url, timeoutMs, 'fetchPage');

    if (response.status === 404 || response.status === 410) {
      throw new WebsiteReadNotFoundError(WebsiteContentAdapter.NAME, 'fetchPage', `HTTP ${response.status} for ${url}`);
    }
    if (response.status === 403 || response.status === 429) {
      throw new WebsiteReadBlockedError(WebsiteContentAdapter.NAME, 'fetchPage', `HTTP ${response.status} for ${url}`);
    }
    if (!response.ok) {
      throw new WebsiteReadUnexpectedError(WebsiteContentAdapter.NAME, 'fetchPage', `HTTP ${response.status} for ${url}`);
    }

    const contentType = response.headers.get('content-type') ?? undefined;
    const html = await response.text();

    return {
      requestedUrl: url,
      finalUrl: response.url || url,
      statusCode: response.status,
      contentType,
      text: extractVisibleText(html),
    };
  }

  private async getRobotsRules(origin: string): Promise<RobotsRules | null> {
    if (this.robotsCache.has(origin)) {
      return this.robotsCache.get(origin) ?? null;
    }
    let rules: RobotsRules | null = null;
    try {
      const response = await this.doFetch(`${origin}/robots.txt`, this.defaultTimeoutMs, 'getRobotsRules');
      if (response.ok) {
        rules = parseRobotsTxt(await response.text());
      }
    } catch {
      // No reachable/parseable robots.txt is treated as "no restrictions
      // stated" — the same as most real crawlers' behavior — never as a
      // reason to fail the caller's actual page fetch.
      rules = null;
    }
    this.robotsCache.set(origin, rules);
    return rules;
  }

  private async doFetch(url: string, timeoutMs: number, method: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': DEFAULT_USER_AGENT },
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new WebsiteReadTimeoutError(WebsiteContentAdapter.NAME, method, `exceeded ${timeoutMs}ms for ${url}`);
      }
      throw new WebsiteReadNetworkError(WebsiteContentAdapter.NAME, method, err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }
}
