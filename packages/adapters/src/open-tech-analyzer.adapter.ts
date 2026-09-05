import type { TechAnalyzerAdapter, TechAnalyzeOptions, TechAnalyzerResult } from '@metrivio/core';
import { NotImplementedInStage1Error } from './not-implemented.js';

/**
 * OpenTechAnalyzer-backed implementation of TechAnalyzerAdapter — the
 * PRIMARY technology-detection layer (RESEARCH.md §2A, verified: MIT
 * license, `opentechalyzer` npm package, TypeScript library). Per explicit
 * instruction, OpenTechAnalyzer is not replaced by wappalyzergo or any other
 * detector — see WappalyzerGoAdapter for the fallback-only alternative.
 *
 * Stage 2 wires this class's methods to real `analyze()`/`analyzeMany()`
 * calls imported directly from the `opentechalyzer` npm package as an
 * in-process library dependency (ARCHITECTURE.md §6 — no subprocess needed,
 * both codebases are Node/TypeScript). The `opentechalyzer` package is
 * deliberately NOT added as a dependency yet in Stage 1 — this stub defines
 * the boundary and its intended integration shape without requiring the real
 * package to be installed/working before Stage 1 can be verified, per
 * instruction #5 ("create adapter boundaries, but do not yet implement
 * production API/browser automation").
 *
 * Every method throws in Stage 1. No network request or subprocess is
 * started.
 */
export class OpenTechAnalyzerAdapter implements TechAnalyzerAdapter {
  private static readonly NAME = 'OpenTechAnalyzerAdapter';

  async analyze(_domain: string, _opts?: TechAnalyzeOptions): Promise<TechAnalyzerResult> {
    throw new NotImplementedInStage1Error(OpenTechAnalyzerAdapter.NAME, 'analyze');
  }

  async analyzeMany(_domains: string[], _opts?: TechAnalyzeOptions): Promise<TechAnalyzerResult[]> {
    throw new NotImplementedInStage1Error(OpenTechAnalyzerAdapter.NAME, 'analyzeMany');
  }
}
