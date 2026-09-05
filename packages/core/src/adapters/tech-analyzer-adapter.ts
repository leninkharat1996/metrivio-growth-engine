/**
 * TechAnalyzerAdapter — ARCHITECTURE.md §6.
 *
 * Primary implementation: OpenTechAnalyzerAdapter, wrapping the `analyze`/
 * `analyzeMany` functions imported directly from the `opentechalyzer` npm
 * package (in-process library call, not a subprocess — RESEARCH.md §2A).
 * Fallback: WappalyzerGoAdapter (subprocess-based), kept in reserve per
 * RISK_REGISTER.md #3 (bus-factor diversification, not a capability or
 * license concern).
 *
 * The scan-level (`scanStatus`) / technology-level (`status`) split below is
 * deliberate: a failed scan can never produce a `NOT_DETECTED` row, because
 * `NOT_DETECTED` only exists as a value inside `technologies[]`, which is
 * only ever populated when `scanStatus === 'OK'`. See ARCHITECTURE.md §6 and
 * DATABASE.md's `technology_scans`/`technology_detections` split.
 *
 * This file defines the contract only. Stage 1 does not implement production
 * scans against it (see packages/adapters for the Stage 1 stub).
 */

export interface TechAnalyzeOptions {
  render?: boolean;
  crawl?: number;
  sourcemaps?: boolean;
  fields?: Array<'contact' | 'social' | 'company' | 'locale' | 'security' | 'signals' | 'meta' | 'keywords'>;
}

export interface TechEvidenceItem {
  source: string;
  subject: string;
  match: string;
  reliability: number;
}

export interface TechnologyResult {
  name: string;
  /** Only meaningful when the parent TechAnalyzerResult.scanStatus === 'OK'. */
  status: 'DETECTED' | 'NOT_DETECTED';
  confidence: number; // 0-100
  accountIds?: string[];
  evidence: TechEvidenceItem[];
  inferred?: boolean;
}

export interface TechAnalyzerResult {
  /** Did the scan itself succeed? A non-OK value means zero technologies were evaluated. */
  scanStatus: 'OK' | 'BLOCKED' | 'ERROR' | 'INCONCLUSIVE';
  technologies: TechnologyResult[];
  enrichment?: {
    company?: Record<string, unknown>;
    social?: Record<string, unknown>;
    contact?: Record<string, unknown>;
    locale?: Record<string, unknown>;
  };
  detector: 'open_tech_analyzer' | 'wappalyzergo';
  timestamp: string;
}

export interface TechAnalyzerAdapter {
  analyze(domain: string, opts?: TechAnalyzeOptions): Promise<TechAnalyzerResult>;
  analyzeMany(domains: string[], opts?: TechAnalyzeOptions): Promise<TechAnalyzerResult[]>;
}
