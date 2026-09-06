import { KillSwitch, SystemConfigService, type MetrivioDb, type XReadAdapter, type TweetResult, type createLogger } from '@metrivio/core';
import { ContentSignalStore } from '../signals/content-signal-store.js';
import { classifyPainCategory } from '../pain-taxonomy/pain-taxonomy.js';
import { classifyHookType } from '../hooks/hook-classifier.js';
import { TrackedAccountStore } from './tracked-account-store.js';
import type { ContentSignal } from '../signals/content-signal.js';

/**
 * Shared post-ingestion mechanics for a tracked competitor OR expert
 * account (Section G/I) — mechanically identical to how `IcpResearchService`
 * reads a prospect's posts, so it is built once here rather than copied
 * per account type. Unlike ICP research's relevance filter (only pain-
 * flagged/question posts become signals), EVERY fetched post becomes a
 * signal here, bounded only by `maxPosts` — Section G/I ask for the full
 * topic/hook/format picture of a tracked account, not a pain-only subset.
 */
export interface TrackedAccountResearchOptions {
  maxPosts?: number;
}

const DEFAULT_MAX_POSTS = 20;

export class TrackedAccountResearchService {
  private readonly killSwitch: KillSwitch;
  private readonly signals: ContentSignalStore;
  private readonly accounts: TrackedAccountStore;

  constructor(
    private readonly db: MetrivioDb,
    private readonly xReadAdapter: XReadAdapter,
    private readonly logger?: ReturnType<typeof createLogger>
  ) {
    this.killSwitch = new KillSwitch(new SystemConfigService(db));
    this.signals = new ContentSignalStore(db);
    this.accounts = new TrackedAccountStore(db);
  }

  async researchAccount(accountId: string, options: TrackedAccountResearchOptions = {}): Promise<ContentSignal[]> {
    if (await this.killSwitch.isActive()) {
      return [];
    }

    const account = await this.accounts.getById(accountId);
    if (!account) {
      throw new Error(`Cannot research account: no tracked account found with id ${accountId}`);
    }

    const maxPosts = options.maxPosts && options.maxPosts > 0 ? options.maxPosts : DEFAULT_MAX_POSTS;
    let tweets: TweetResult[];
    try {
      tweets = await this.xReadAdapter.getTweets(account.xUsername, { limit: maxPosts });
    } catch (err) {
      this.logger?.error({ accountId, err: err instanceof Error ? err.message : String(err) }, 'tracked_account_research.read_failed');
      return [];
    }

    const signalType = account.accountType === 'competitor' ? ('competitor_post' as const) : ('expert_post' as const);
    const created: ContentSignal[] = [];
    for (const tweet of tweets.slice(0, maxPosts)) {
      const signal = await this.signals.create({
        signalType,
        sourceType: 'x_post',
        sourceUrl: tweet.url,
        accountId: account.id,
        authorUsername: account.xUsername,
        companyName: account.companyName,
        painCategory: classifyPainCategory(tweet.text),
        confidence: 'OBSERVATION',
        excerpt: tweet.text,
        extraction: { hookType: classifyHookType(tweet.text) },
        publishedAt: tweet.createdAt,
      });
      created.push(signal);
    }
    return created;
  }
}
