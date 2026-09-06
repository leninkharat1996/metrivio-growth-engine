import { eq } from 'drizzle-orm';
import { schema, KillSwitch, SystemConfigService, type MetrivioDb, type XReadAdapter, type TweetResult, type createLogger } from '@metrivio/core';
import { ContentSignalStore } from '../signals/content-signal-store.js';
import { classifyPainCategory } from '../pain-taxonomy/pain-taxonomy.js';
import type { ContentSignal, ContentSignalExtraction } from '../signals/content-signal.js';

/**
 * Stage 7, Section A/B — ICP research. Deliberately does NOT run a second
 * prospect-discovery pass: every account this service researches is an
 * EXISTING `prospects` row (Stage 4's own identity — `x_username`,
 * `x_user_id`, `company_name`, `company_domain`, and, when present, an
 * `icp_scores` row) reused as-is. This service only adds one new
 * capability on top of that identity: reading a prospect's own public
 * posts (`XReadAdapter.getTweets`, read-only, bounded to one known handle
 * per call — never a keyword sweep of the open platform) and extracting
 * structured content-intelligence signals from them.
 *
 * Known limitation, honestly documented rather than worked around:
 * `XReadAdapter.TweetResult` (Stage 4A's own contract) carries no
 * engagement fields (no likes/replies/reposts/views) — this codebase has
 * never verified a read path for those metrics. Every signal produced here
 * has `engagement` fields left `null`, never a fabricated number.
 */
export interface IcpResearchOptions {
  /** Bounded — Section AA/AH: never an unbounded pull of a prospect's history. */
  maxPosts?: number;
}

const DEFAULT_MAX_POSTS = 20;

/** A post is "relevant" (worth turning into a signal) when it names a known pain-taxonomy topic, or reads like a question/problem statement — a deterministic, documented filter, not a relevance-by-engagement heuristic (Section E: "a viral post from people outside the ICP should not outrank..."). */
function isRelevantIcpPost(text: string): boolean {
  if (classifyPainCategory(text) !== 'other') return true;
  const lower = text.toLowerCase();
  return lower.includes('?') || lower.includes('struggling') || lower.includes('frustrat') || lower.includes('anyone else') || lower.includes('how do you');
}

function extractFromTweet(text: string): ContentSignalExtraction {
  const category = classifyPainCategory(text);
  const extraction: ContentSignalExtraction = {};
  if (category !== 'other') extraction.problem = `mentions ${category.replace(/_/g, ' ')}`;
  if (text.includes('?')) extraction.question = text;
  return extraction;
}

export class IcpResearchService {
  private readonly killSwitch: KillSwitch;
  private readonly signals: ContentSignalStore;

  constructor(
    private readonly db: MetrivioDb,
    private readonly xReadAdapter: XReadAdapter,
    private readonly logger?: ReturnType<typeof createLogger>
  ) {
    this.killSwitch = new KillSwitch(new SystemConfigService(db));
    this.signals = new ContentSignalStore(db);
  }

  /**
   * Researches ONE existing prospect's public posts. Returns the newly
   * created signals (relevant posts only — Section B, "what is this ICP
   * actually struggling with," not a verbatim archive of every tweet).
   */
  async researchProspect(prospectId: string, options: IcpResearchOptions = {}): Promise<ContentSignal[]> {
    if (await this.killSwitch.isActive()) {
      return [];
    }

    const rows = await this.db.select().from(schema.prospects).where(eq(schema.prospects.id, prospectId)).limit(1);
    const prospect = rows[0];
    if (!prospect) {
      throw new Error(`Cannot research prospect: no prospect found with id ${prospectId}`);
    }

    const maxPosts = options.maxPosts && options.maxPosts > 0 ? options.maxPosts : DEFAULT_MAX_POSTS;
    let tweets: TweetResult[];
    try {
      tweets = await this.xReadAdapter.getTweets(prospect.xUsername, { limit: maxPosts });
    } catch (err) {
      this.logger?.error({ prospectId, err: err instanceof Error ? err.message : String(err) }, 'icp_research.read_failed');
      return [];
    }

    const created: ContentSignal[] = [];
    for (const tweet of tweets.slice(0, maxPosts)) {
      if (!isRelevantIcpPost(tweet.text)) continue;
      const signal = await this.signals.create({
        signalType: 'icp_post',
        sourceType: 'x_post',
        sourceUrl: tweet.url,
        prospectId: prospect.id,
        authorUsername: prospect.xUsername,
        companyName: prospect.companyName,
        painCategory: classifyPainCategory(tweet.text),
        confidence: 'OBSERVATION',
        excerpt: tweet.text,
        extraction: extractFromTweet(tweet.text),
        publishedAt: tweet.createdAt,
      });
      created.push(signal);
    }
    return created;
  }
}
