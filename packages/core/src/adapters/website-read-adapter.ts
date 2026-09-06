/**
 * WebsiteReadAdapter — Stage 5 addition (BUILD_PLAN.md Stage 5, "Evidence
 * Coverage Expansion").
 *
 * Covers the single new external read this stage introduces: fetching a
 * company's own public website pages as first-party evidence for the ICP
 * scorer's Revenue-Fit, Decision-maker, and Trigger factors. Mirrors
 * `XReadAdapter`'s Stage 4A pattern exactly — a narrow interface plus a set
 * of generic, implementation-agnostic error classes an implementation
 * throws instead of ever silently returning an empty/successful result for
 * a genuine failure (timeout, blocked, not found, network error).
 *
 * Deliberately the smallest possible surface: one method, fetching one page
 * at a time. Orchestrating *which* pages to fetch for a domain (home, about,
 * team, press, careers, contact) and how many is a `WebsiteEvidenceService`
 * (packages/prospecting) concern, not this adapter's — this file only
 * defines "fetch this one URL and hand back its visible text," the same
 * division of responsibility `XReadAdapter` has from `DiscoveryService`.
 */

export interface WebsitePageResult {
  /** The URL actually requested. */
  requestedUrl: string;
  /** The URL the response was ultimately served from, after following redirects (fetch does this natively). Equal to requestedUrl when there was no redirect. */
  finalUrl: string;
  statusCode: number;
  contentType?: string;
  /**
   * Visible text extracted from the page's HTML (scripts/styles/head
   * content stripped, whitespace collapsed), bounded to a fixed maximum
   * length by the implementation so a single oversized page can never cause
   * unbounded memory growth. Never the raw HTML — every caller needs text
   * to run its classifiers against, and giving every classifier its own
   * HTML-parsing logic would duplicate that concern everywhere it's used.
   */
  text: string;
}

export interface WebsiteReadOptions {
  /** Per-request timeout override. Implementations must have a sane default even when this is omitted — never an unbounded wait. */
  timeoutMs?: number;
}

export interface WebsiteReadAdapter {
  fetchPage(url: string, opts?: WebsiteReadOptions): Promise<WebsitePageResult>;
}

// ---------------------------------------------------------------------------
// Read-status error classes (mirrors XReadAdapter's Stage 4A design exactly)
// ---------------------------------------------------------------------------

export class WebsiteReadError extends Error {
  constructor(adapterName: string, method: string, reason: string, detail?: string) {
    super(`${adapterName}.${method}() ${reason}${detail ? `: ${detail}` : ''}`);
    this.name = 'WebsiteReadError';
  }
}

/** The request exceeded its timeout budget. Distinct from a genuine network failure — the server may simply be slow, not down. */
export class WebsiteReadTimeoutError extends WebsiteReadError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'timed out', detail);
    this.name = 'WebsiteReadTimeoutError';
  }
}

/** The page does not exist (HTTP 404/410), or the domain has no DNS record at all. Distinct from a genuine "page exists but is empty" result. */
export class WebsiteReadNotFoundError extends WebsiteReadError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'found no such page (not found or no DNS record)', detail);
    this.name = 'WebsiteReadNotFoundError';
  }
}

/** The request was refused by the server (HTTP 403/429) or disallowed by the site's own robots.txt. Distinct from a genuine empty page. */
export class WebsiteReadBlockedError extends WebsiteReadError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'was blocked (robots.txt disallow, or an HTTP 403/429 refusal)', detail);
    this.name = 'WebsiteReadBlockedError';
  }
}

/** A network-level failure (DNS, TCP, TLS) prevented the request from completing at all. */
export class WebsiteReadNetworkError extends WebsiteReadError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'failed due to a network error', detail);
    this.name = 'WebsiteReadNetworkError';
  }
}

/** An unexpected failure not covered by the categories above. Never silently treated as an empty result. */
export class WebsiteReadUnexpectedError extends WebsiteReadError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'failed unexpectedly', detail);
    this.name = 'WebsiteReadUnexpectedError';
  }
}
