import type { TechAnalyzerAdapter, TechAnalyzeOptions, TechAnalyzerResult } from '@metrivio/core';
import { NotImplementedInStage1Error } from './not-implemented.js';

/**
 * wappalyzergo-backed implementation of TechAnalyzerAdapter — the FALLBACK
 * ONLY implementation, kept in reserve per RISK_REGISTER.md #3 (OpenTechAnalyzer
 * bus-factor diversification, since it is itself a small/new project) — not
 * because of any capability or license doubt about OpenTechAnalyzer.
 *
 * This class must never be wired as the default/primary TechAnalyzerAdapter
 * in any service configuration. OpenTechAnalyzerAdapter is primary
 * (RESEARCH.md §2A, ARCHITECTURE.md §6) and remains so per explicit
 * instruction.
 *
 * Stage 2 wires this class's methods to a pinned wappalyzergo binary/CLI via
 * subprocess (it is a Go binary, unlike OpenTechAnalyzer's in-process
 * TypeScript integration). Stage 1: every method throws, no subprocess is
 * started.
 */
export class WappalyzerGoAdapter implements TechAnalyzerAdapter {
  private static readonly NAME = 'WappalyzerGoAdapter';

  async analyze(_domain: string, _opts?: TechAnalyzeOptions): Promise<TechAnalyzerResult> {
    throw new NotImplementedInStage1Error(WappalyzerGoAdapter.NAME, 'analyze');
  }

  async analyzeMany(_domains: string[], _opts?: TechAnalyzeOptions): Promise<TechAnalyzerResult[]> {
    throw new NotImplementedInStage1Error(WappalyzerGoAdapter.NAME, 'analyzeMany');
  }
}
