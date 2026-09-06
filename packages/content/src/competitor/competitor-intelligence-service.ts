import type { MetrivioDb } from '@metrivio/core';
import { ContentSignalStore } from '../signals/content-signal-store.js';
import { PAIN_TAXONOMY_CATEGORIES } from '../pain-taxonomy/pain-taxonomy.js';

/**
 * Stage 7, Section G — competitor intelligence. Pure aggregation over
 * already-collected `content_signals` rows (`signalType: 'competitor_post'`)
 * — this class performs no network I/O and never re-reads X itself.
 * "Understand what works for them" and "identify where Metrivio can be
 * different" (Section G) map directly onto `themes` (what they talk about,
 * ranked by frequency) and `gaps` (pain-taxonomy categories NO tracked
 * competitor signal has touched at all — an explicit differentiation
 * opportunity, never inferred from engagement alone).
 */
export interface CompetitorThemeSummary {
  painCategory: string;
  signalCount: number;
  accountCount: number;
}

export interface CompetitorIntelligenceReport {
  totalSignals: number;
  themes: CompetitorThemeSummary[];
  /** Pain-taxonomy categories with zero observed competitor coverage — a candidate differentiation angle (Section G). */
  gaps: string[];
}

export class CompetitorIntelligenceService {
  private readonly signals: ContentSignalStore;

  constructor(db: MetrivioDb) {
    this.signals = new ContentSignalStore(db);
  }

  async analyze(): Promise<CompetitorIntelligenceReport> {
    const signals = await this.signals.list({ signalType: 'competitor_post' });

    const byCategory = new Map<string, { count: number; accounts: Set<string> }>();
    for (const signal of signals) {
      const category = signal.painCategory ?? 'other';
      const bucket = byCategory.get(category) ?? { count: 0, accounts: new Set<string>() };
      bucket.count += 1;
      if (signal.accountId) bucket.accounts.add(signal.accountId);
      byCategory.set(category, bucket);
    }

    const themes: CompetitorThemeSummary[] = [...byCategory.entries()]
      .map(([painCategory, bucket]) => ({ painCategory, signalCount: bucket.count, accountCount: bucket.accounts.size }))
      .sort((a, b) => b.signalCount - a.signalCount || a.painCategory.localeCompare(b.painCategory));

    const gaps = PAIN_TAXONOMY_CATEGORIES.filter((c) => c !== 'other' && !byCategory.has(c));

    return { totalSignals: signals.length, themes, gaps };
  }
}
