import type { MetrivioDb, XReadAdapter } from '@metrivio/core';
import { ContentSignalStore } from '../signals/content-signal-store.js';
import { TrackedAccountStore } from '../accounts/tracked-account-store.js';
import type { HookType } from '../hooks/hook-classifier.js';

/**
 * Stage 7, Section I — expert performance analysis. Normalizes engagement
 * to a RATE (engagement per post per follower), never comparing raw like
 * counts across accounts of different sizes (Section I: "avoid misleading
 * comparisons between accounts with dramatically different audience
 * sizes"). `engagementRate` is `null` — never a guessed number — whenever
 * either the underlying `content_signals` rows carry no engagement data
 * (the honest, expected case today: `XReadAdapter.TweetResult` has no
 * engagement fields at all, see `icp-research-service.ts`'s own doc
 * comment) or a live follower-count lookup fails.
 */
export interface FrequencyCount {
  key: string;
  count: number;
}

export interface ExpertPerformanceSummary {
  accountId: string;
  xUsername: string;
  postsAnalyzed: number;
  followerCount: number | null;
  /** `null` when no signal in this account's history carries engagement data, or follower count is unavailable — never fabricated. */
  engagementRate: number | null;
  topHookTypes: FrequencyCount[];
  topPainCategories: FrequencyCount[];
}

export class ExpertPerformanceAnalysisService {
  private readonly signals: ContentSignalStore;
  private readonly accounts: TrackedAccountStore;

  constructor(
    private readonly db: MetrivioDb,
    private readonly xReadAdapter: XReadAdapter
  ) {
    this.signals = new ContentSignalStore(db);
    this.accounts = new TrackedAccountStore(db);
  }

  async analyzeAccount(accountId: string): Promise<ExpertPerformanceSummary> {
    const account = await this.accounts.getById(accountId);
    if (!account) {
      throw new Error(`Cannot analyze performance: no tracked account found with id ${accountId}`);
    }

    const signals = await this.signals.list({ accountId, signalType: 'expert_post' });

    const hookCounts = new Map<string, number>();
    const painCounts = new Map<string, number>();
    let engagementPostCount = 0;
    let totalEngagement = 0;

    for (const signal of signals) {
      const hookType = (signal.extraction as { hookType?: HookType } | null)?.hookType;
      if (hookType) hookCounts.set(hookType, (hookCounts.get(hookType) ?? 0) + 1);
      if (signal.painCategory) painCounts.set(signal.painCategory, (painCounts.get(signal.painCategory) ?? 0) + 1);

      const { likes, replies, reposts } = signal.engagement;
      if (likes != null || replies != null || reposts != null) {
        engagementPostCount += 1;
        totalEngagement += (likes ?? 0) + (replies ?? 0) + (reposts ?? 0);
      }
    }

    let followerCount: number | null = null;
    try {
      const profile = await this.xReadAdapter.getProfile(account.xUsername);
      followerCount = profile.followerCount ?? null;
    } catch {
      followerCount = null;
    }

    const engagementRate =
      engagementPostCount > 0 && followerCount && followerCount > 0 ? totalEngagement / engagementPostCount / followerCount : null;

    const toFrequencyList = (m: Map<string, number>): FrequencyCount[] =>
      [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

    return {
      accountId,
      xUsername: account.xUsername,
      postsAnalyzed: signals.length,
      followerCount,
      engagementRate,
      topHookTypes: toFrequencyList(hookCounts),
      topPainCategories: toFrequencyList(painCounts),
    };
  }
}
