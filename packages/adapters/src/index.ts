export * from './not-implemented.js';
export * from './xactions-read.adapter.js';
export * from './xmanager-write.adapter.js';
export * from './xactions-write.adapter.js';
export * from './open-tech-analyzer.adapter.js';
export * from './wappalyzergo.adapter.js';
export * from './website-content.adapter.js';

import type { TechAnalyzerAdapter } from '@metrivio/core';
import { OpenTechAnalyzerAdapter } from './open-tech-analyzer.adapter.js';

/**
 * The default TechAnalyzerAdapter factory. Deliberately explicit and
 * isolated in one place so it's trivially auditable that OpenTechAnalyzer,
 * not wappalyzergo, is the primary/default implementation — per explicit,
 * repeated instruction across the planning documents and this stage's
 * instructions ("OpenTechAnalyzer remains the primary technology analyzer").
 *
 * WappalyzerGoAdapter is intentionally not referenced here — call sites that
 * need the fallback must import and construct it explicitly, which keeps
 * "primary vs. fallback" a visible, deliberate choice at every call site
 * rather than something a default export could quietly flip.
 */
export function createDefaultTechAnalyzerAdapter(): TechAnalyzerAdapter {
  return new OpenTechAnalyzerAdapter();
}
