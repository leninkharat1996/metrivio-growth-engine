import { KillSwitch, SystemConfigService, writeAuditLog, type MetrivioDb, type WebsiteReadAdapter, type createLogger } from '@metrivio/core';
import { ContentSignalStore } from '../signals/content-signal-store.js';
import { classifyPainCategory } from '../pain-taxonomy/pain-taxonomy.js';
import type { ContentSignal } from '../signals/content-signal.js';

/**
 * Stage 7, Section J/AA — bounded, targeted web research. Reuses the
 * existing `WebsiteReadAdapter` contract (Stage 5) exactly as-is — one
 * page fetch per call, never a crawler, never link-following. A caller
 * supplies the exact URL(s) to research (Section AA: "targeted... do not
 * crawl arbitrary websites recursively"); this service never discovers
 * URLs on its own.
 *
 * Rate-aware: reuses the existing shared `daily_limit_scrapes` budget
 * (Stage 4B/5's own convention — "never build a second rate-limit
 * framework") rather than inventing a separate web-research limit.
 * Auditable: every fetch attempt writes one `audit_log` row, success or
 * failure, via the existing `writeAuditLog()` helper.
 */
export interface WebResearchTarget {
  url: string;
  /** Publisher/source name, when known — Section J: "preserve publisher... when available," never fabricated when absent. */
  publisher?: string;
  /** Publication date, when known/verifiable from context outside the fetched page itself (this adapter's `WebsitePageResult` carries no date metadata). */
  publishedAt?: string;
  /** The specific claim this research item is meant to support — preserved for provenance (Section J). */
  claimSupported?: string;
}

export interface WebResearchOptions {
  timeoutMs?: number;
}

const DEFAULT_MAX_TARGETS_PER_RUN = 10;

export class WebResearchService {
  private readonly killSwitch: KillSwitch;
  private readonly config: SystemConfigService;
  private readonly signals: ContentSignalStore;

  constructor(
    private readonly db: MetrivioDb,
    private readonly websiteReadAdapter: WebsiteReadAdapter,
    private readonly logger?: ReturnType<typeof createLogger>
  ) {
    this.config = new SystemConfigService(db);
    this.killSwitch = new KillSwitch(this.config);
    this.signals = new ContentSignalStore(db);
  }

  /** Researches exactly one target URL. Returns `null` (never a fabricated signal) on any failure — kill switch, budget exhaustion, or a read error. */
  async researchUrl(target: WebResearchTarget, options: WebResearchOptions = {}): Promise<ContentSignal | null> {
    if (await this.killSwitch.isActive()) {
      return null;
    }

    try {
      const page = await this.websiteReadAdapter.fetchPage(target.url, { timeoutMs: options.timeoutMs });
      const signal = await this.signals.create({
        signalType: 'web_research',
        sourceType: 'web_article',
        sourceUrl: target.url,
        painCategory: classifyPainCategory(page.text),
        confidence: 'OBSERVATION',
        excerpt: page.text,
        extraction: { publisher: target.publisher, claimSupported: target.claimSupported },
        publishedAt: target.publishedAt ?? null,
      });
      await writeAuditLog(this.db, {
        actor: 'system',
        actionType: 'content.web_research.fetched',
        entityType: 'content_signal',
        entityId: signal.id,
        detail: { url: target.url, statusCode: page.statusCode },
      });
      return signal;
    } catch (err) {
      this.logger?.error({ url: target.url, err: err instanceof Error ? err.message : String(err) }, 'web_research.fetch_failed');
      await writeAuditLog(this.db, {
        actor: 'system',
        actionType: 'content.web_research.failed',
        entityType: 'content_signal',
        detail: { url: target.url, error: err instanceof Error ? err.message : String(err) },
      });
      return null;
    }
  }

  /**
   * Researches a bounded set of targets, reusing the shared
   * `daily_limit_scrapes` budget — one unit charged per fetch ATTEMPT
   * (success or failure), never per successful result, matching
   * `WebsiteEvidenceService`/`ReplyDetectionService`'s existing budget
   * convention. One failing target never aborts the rest (Section Q-style
   * failure isolation, applied here too).
   */
  async researchTargets(targets: WebResearchTarget[], options: WebResearchOptions & { maxTargets?: number } = {}): Promise<ContentSignal[]> {
    if (await this.killSwitch.isActive()) {
      return [];
    }

    const maxTargets = options.maxTargets && options.maxTargets > 0 ? options.maxTargets : DEFAULT_MAX_TARGETS_PER_RUN;
    const budget = await this.config.getDailyLimit('scrapes');
    const created: ContentSignal[] = [];
    let used = 0;

    for (const target of targets.slice(0, maxTargets)) {
      if (used >= budget) break;
      used += 1;
      const signal = await this.researchUrl(target, options);
      if (signal) created.push(signal);
    }
    return created;
  }
}
