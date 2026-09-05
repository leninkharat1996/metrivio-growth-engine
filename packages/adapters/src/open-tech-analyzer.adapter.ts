import { analyze as otaAnalyze, analyzeMany as otaAnalyzeMany } from 'opentechalyzer';
import type { AnalyzeOptions, AnalyzeResult, Detection } from 'opentechalyzer';
import type {
  TechAnalyzerAdapter,
  TechAnalyzeOptions,
  TechAnalyzerResult,
  TechnologyResult,
} from '@metrivio/core';

/**
 * OpenTechAnalyzer-backed implementation of TechAnalyzerAdapter — the
 * PRIMARY technology-detection layer (RESEARCH.md §2A, verified: MIT
 * license, `opentechalyzer` npm package v0.4.2, TypeScript library). Per
 * explicit instruction, OpenTechAnalyzer is not replaced by wappalyzergo or
 * any other detector — see WappalyzerGoAdapter for the fallback-only
 * alternative.
 *
 * `analyze`/`analyzeMany` are imported directly from the `opentechalyzer`
 * npm package and called in-process (ARCHITECTURE.md §6/§8 — no subprocess,
 * both codebases are Node/TypeScript).
 */

/**
 * Default first-scan configuration per RESEARCH.md §2A.6 / ARCHITECTURE.md
 * §3.1: render defaults on because Meta Pixel/GTM are frequently
 * tag-manager-injected and only observable after JS executes; crawl defaults
 * to 5 because contact/social/company fields "essentially never" appear on
 * the homepage per OpenTechAnalyzer's own README.
 */
const DEFAULT_ANALYZE_OPTIONS: Required<Pick<TechAnalyzeOptions, 'render' | 'crawl' | 'fields'>> = {
  render: true,
  crawl: 5,
  fields: ['contact', 'social', 'company'],
};

/**
 * HTTP statuses that mean the target explicitly refused/rate-limited the
 * request, as opposed to merely responding with an unexpected status.
 * OpenTechAnalyzer itself does not classify scans this way (RESEARCH.md
 * §2A.3 — its own `AnalyzeResult` only carries a raw numeric `status`); this
 * mapping is Metrivio's own normalization on top of the raw library output,
 * required by ARCHITECTURE.md §6's scan-status/technology-status contract.
 */
const BLOCKED_HTTP_STATUSES = new Set([401, 403, 407, 429, 451]);

/**
 * Named technologies Metrivio tracks a positive/negative distinction for,
 * drawn from RESEARCH.md §2A.7's confirmed-fingerprint list (the specific
 * technologies the ICP document's technology-signal evidence category cares
 * about). OpenTechAnalyzer's own `detections[]` only ever lists positive
 * matches — it has no concept of "checked and absent" for its full ~588
 * fingerprint database, nor should Metrivio synthesize one for all of them
 * (that would produce hundreds of NOT_DETECTED rows per scan for
 * technologies nobody is scoring against). For this fixed, documented
 * watchlist only, a successful scan that doesn't detect one is recorded as
 * an explicit NOT_DETECTED technology result — a trustworthy negative,
 * because it comes from a scan whose `scanStatus` is confirmed `OK`
 * (DATABASE.md `technology_detections`, BUILD_PLAN.md Stage 2).
 *
 * Deliberately excludes "Shopify Plus": RESEARCH.md §2A.7 flags this as not
 * independently confirmed as its own fingerprint, so asserting a
 * NOT_DETECTED (or DETECTED) row for it here would be exactly the kind of
 * unverified claim that document warns against.
 */
export const WATCHED_TECHNOLOGIES: readonly string[] = [
  'Shopify',
  'Klaviyo',
  'Gorgias',
  'Recharge',
  'Yotpo',
  'Meta Pixel',
  'GA4',
  'GTM',
];

function toOtaOptions(opts?: TechAnalyzeOptions): AnalyzeOptions {
  const merged = { ...DEFAULT_ANALYZE_OPTIONS, ...opts };
  return {
    render: merged.render,
    crawl: merged.crawl,
    sourcemaps: merged.sourcemaps,
    fields: merged.fields,
  };
}

/**
 * Maps OpenTechAnalyzer's raw numeric HTTP `status` to Metrivio's
 * `scanStatus` enum. Only reachable when `analyze()`/`analyzeMany()`
 * resolved at all — a thrown error (network failure, DNS failure, TLS
 * failure, timeout) is handled separately as `ERROR`, since OpenTechAnalyzer
 * only throws when "the initial page fetch" itself never got a response
 * (confirmed via direct source inspection of `analyze.js`: `fetchPage` does
 * not throw on non-2xx responses, only on a failed/aborted request).
 */
function classifyResolvedScanStatus(result: AnalyzeResult): 'OK' | 'BLOCKED' | 'INCONCLUSIVE' {
  const status = result.status;
  if (status >= 200 && status < 400) return 'OK';
  if (BLOCKED_HTTP_STATUSES.has(status)) return 'BLOCKED';
  return 'INCONCLUSIVE';
}

function mapDetection(detection: Detection): TechnologyResult {
  return {
    name: detection.name,
    status: 'DETECTED',
    confidence: detection.confidence,
    accountIds: detection.accountIds,
    evidence: detection.evidence.map((e) => ({
      source: e.source,
      subject: e.subject,
      match: e.match,
      reliability: e.reliability,
    })),
    inferred: detection.inferred,
  };
}

/**
 * Builds the final `technologies[]` array for a successful scan: every
 * positive detection OpenTechAnalyzer reported, plus an explicit
 * NOT_DETECTED entry for each `WATCHED_TECHNOLOGIES` name that was not
 * detected — never the reverse (a non-OK scan never reaches this function).
 */
function buildTechnologyResults(result: AnalyzeResult): TechnologyResult[] {
  const detected = result.detections.map(mapDetection);
  const detectedNames = new Set(detected.map((d) => d.name));
  const notDetected: TechnologyResult[] = WATCHED_TECHNOLOGIES.filter((name) => !detectedNames.has(name)).map(
    (name) => ({
      name,
      status: 'NOT_DETECTED',
      confidence: 0,
      evidence: [],
    })
  );
  return [...detected, ...notDetected];
}

function fromResolvedResult(result: AnalyzeResult): TechAnalyzerResult {
  const scanStatus = classifyResolvedScanStatus(result);
  return {
    scanStatus,
    // Per ARCHITECTURE.md §6 / DATABASE.md: a technology_detections row (and
    // therefore a `technologies[]` entry) only ever exists for scanStatus
    // === 'OK'. BLOCKED/INCONCLUSIVE resolve with zero technology entries,
    // never a NOT_DETECTED entry standing in for the failure.
    technologies: scanStatus === 'OK' ? buildTechnologyResults(result) : [],
    enrichment: result.enrichment as TechAnalyzerResult['enrichment'],
    detector: 'open_tech_analyzer',
    timestamp: result.analyzedAt,
  };
}

/**
 * A thrown `analyze()` error means the initial page fetch itself never
 * completed (network failure, DNS failure, TLS failure, or the per-request
 * timeout aborting) — this is always `ERROR`, never `BLOCKED`, because
 * `BLOCKED` is reserved for a target that responded and explicitly refused
 * the request (a distinguishable, resolved case handled above).
 */
function fromThrownError(): TechAnalyzerResult {
  return {
    scanStatus: 'ERROR',
    technologies: [],
    detector: 'open_tech_analyzer',
    timestamp: new Date().toISOString(),
  };
}

export class OpenTechAnalyzerAdapter implements TechAnalyzerAdapter {
  async analyze(domain: string, opts?: TechAnalyzeOptions): Promise<TechAnalyzerResult> {
    try {
      const result = await otaAnalyze(domain, toOtaOptions(opts));
      return fromResolvedResult(result);
    } catch {
      return fromThrownError();
    }
  }

  /**
   * Delegates to OpenTechAnalyzer's own `analyzeMany()`, which is
   * index-aligned with the input `domains` array and captures failures
   * per-URL rather than aborting the batch (confirmed via direct source
   * inspection of `analyze.js`: `out[index] = ...` is written directly by
   * index, so ordering always matches the input). No `concurrency` override
   * is passed — OpenTechAnalyzer's own default (5) is used, per instruction
   * not to invent a larger concurrency limit than the library itself
   * supports by default.
   */
  async analyzeMany(domains: string[], opts?: TechAnalyzeOptions): Promise<TechAnalyzerResult[]> {
    const otaOpts = toOtaOptions(opts);
    const results = await otaAnalyzeMany(domains, otaOpts);
    return results.map((entry) => (entry.result ? fromResolvedResult(entry.result) : fromThrownError()));
  }
}
