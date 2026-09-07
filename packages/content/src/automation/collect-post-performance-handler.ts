import { schema, writeAuditLog, type MetrivioDb, type XReadAdapter, type JobHandler, type JobHandlerContext, type JobHandlerResult, type SystemConfigService } from '@metrivio/core';
import { OwnContentPerformanceService } from '../own-content/own-content-performance-service.js';
import { ContentSignalStore } from '../signals/content-signal-store.js';
import { IcpEngagementClassifier } from '../analytics/icp-engagement-classifier.js';
import { classifyBusinessIntent } from '../analytics/business-intent-classifier.js';
import { COLLECT_POST_PERFORMANCE_JOB_TYPE } from './job-types.js';

/**
 * Stage 9, Section A/F/G — `COLLECT_POST_PERFORMANCE`. Refreshes what this
 * repository's verified `XReadAdapter` contract can ACTUALLY provide about
 * published posts — which, per the honest gap this stage documents (see
 * RISK_REGISTER.md §2M), is engager IDENTITY (`getEngagers()`) but never
 * reach/like/reply/repost/bookmark COUNTS (`TweetResult` carries none).
 * This handler therefore does two things, both identity-based, never
 * inventing a metric:
 *
 *   1. For each published draft, calls `getEngagers()` against the post's
 *      own (constructed) URL, classifies each engager via
 *      `IcpEngagementClassifier` (existing `prospects` identity only —
 *      never inferred from a bare username), and re-ingests a snapshot
 *      with an updated `icpEngagementCount` — every other metric field is
 *      carried forward unchanged from the prior snapshot, never
 *      overwritten with a guess.
 *   2. Once per run, searches for mentions of Metrivio's own handle
 *      (`searchTweets`) and stores any reply/mention classified as
 *      `GENUINE_INTENT` or matched to a known ICP prospect as a
 *      `content_signals` row (`signalType: 'own_post_engagement'`) —
 *      never a generic-engagement, non-ICP mention (keeps the signal
 *      table meaningful, mirrors `IcpResearchService`'s own "only signal
 *      when it clears a bar" discipline).
 *
 * Both steps require `content.publishing.own_x_handle` to be configured
 * (Section A: "do not assume metrics exist" extended to "do not assume an
 * identity exists either") — if unset, this handler processes zero items
 * and reports the exact gap in its result detail, rather than guessing a
 * handle or silently doing nothing unexplained.
 */
export class CollectPostPerformanceHandler implements JobHandler {
  readonly jobType = COLLECT_POST_PERFORMANCE_JOB_TYPE;

  constructor(
    private readonly db: MetrivioDb,
    private readonly xReadAdapter: XReadAdapter,
    private readonly config: SystemConfigService
  ) {}

  async run(ctx: JobHandlerContext): Promise<JobHandlerResult> {
    const ownHandle = await this.config.getContentPublishingOwnXHandle();
    if (!ownHandle) {
      return { itemsProcessed: 0, itemsSucceeded: 0, itemsFailed: 0, detail: { skipped: 'content.publishing.own_x_handle is not configured — cannot construct tweet URLs or a mention-search query' } };
    }

    const publishedDrafts = await this.db.select().from(schema.contentDrafts);
    const withPostId = publishedDrafts.filter((d) => !!d.xManagerPostId).slice(0, ctx.maxItems);

    const performance = new OwnContentPerformanceService(this.db);
    const icpClassifier = new IcpEngagementClassifier(this.db);
    const signals = new ContentSignalStore(this.db);

    let succeeded = 0;
    let failed = 0;

    for (const draft of withPostId) {
      try {
        const tweetUrl = `https://x.com/${ownHandle}/status/${draft.xManagerPostId}`;
        const engagers = await this.xReadAdapter.getEngagers(tweetUrl);

        let icpEngagementCount = 0;
        for (const engager of engagers) {
          const result = await icpClassifier.classifyEngager({ username: engager.username, userId: engager.userId });
          if (result.classification === 'ICP_ENGAGEMENT') icpEngagementCount += 1;
        }

        const previous = await performance.getLatestSnapshot(draft.xManagerPostId!);
        if (!ctx.dryRun) {
          await performance.ingestSnapshot({
            postId: draft.xManagerPostId!,
            draftId: draft.id,
            text: previous?.text ?? draft.body,
            format: previous?.format ?? null,
            impressions: previous?.impressions ?? null,
            likes: previous?.likes ?? null,
            replies: previous?.replies ?? null,
            reposts: previous?.reposts ?? null,
            bookmarks: previous?.bookmarks ?? null,
            profileVisits: previous?.profileVisits ?? null,
            icpEngagementCount,
          });
        }
        succeeded += 1;
      } catch (err) {
        failed += 1;
        await writeAuditLog(this.db, {
          actor: 'system',
          actionType: 'automation.collect_post_performance.failed',
          entityType: 'content_draft',
          entityId: draft.id,
          dryRun: ctx.dryRun,
          detail: { runId: ctx.runId, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    let newSignals = 0;
    try {
      const mentions = await this.xReadAdapter.searchTweets(`@${ownHandle}`, { limit: ctx.maxItems });
      for (const tweet of mentions) {
        const intent = classifyBusinessIntent(tweet.text);
        const icpResult = await icpClassifier.classifyEngager({ username: tweet.authorUsername });
        if (intent !== 'GENUINE_INTENT' && icpResult.classification !== 'ICP_ENGAGEMENT') continue;

        if (!ctx.dryRun) {
          await signals.create({
            signalType: 'own_post_engagement',
            sourceType: 'x_post',
            sourceUrl: tweet.url,
            authorUsername: tweet.authorUsername,
            prospectId: icpResult.matchedProspectId ?? null,
            confidence: 'OBSERVATION',
            excerpt: tweet.text,
            extraction: { businessIntent: intent },
            publishedAt: tweet.createdAt,
          });
          newSignals += 1;
        }
      }
    } catch (err) {
      failed += 1;
      await writeAuditLog(this.db, {
        actor: 'system',
        actionType: 'automation.collect_post_performance.mention_search_failed',
        entityType: 'content_signal',
        dryRun: ctx.dryRun,
        detail: { runId: ctx.runId, error: err instanceof Error ? err.message : String(err) },
      });
    }

    return { itemsProcessed: withPostId.length, itemsSucceeded: succeeded, itemsFailed: failed, detail: { newEngagementSignals: newSignals } };
  }
}
