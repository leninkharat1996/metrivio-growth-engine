import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import {
  JobRunner,
  SystemConfigService,
  schema,
  SIGNAL_CATEGORIES,
  WebsiteReadError,
  type MetrivioDb,
  type WebsiteReadAdapter,
  type createLogger,
} from '@metrivio/core';
import {
  classifyEmployeeCountBand,
  classifyWarehouseFulfillmentSignal,
  classifyConfirmedRevenueStatement,
  classifyPublicVisibilityPressQuote,
  classifyPressAnnouncementTriggers,
} from './classifiers.js';
import { mineCorrectProfileIdentifiedFromEnrichment } from './enrichment-mining.js';

/**
 * Website evidence collection + writing (BUILD_PLAN.md Stage 5). Mirrors
 * `TechnologyEnrichmentService`/`EvidenceAssemblyService`'s shape exactly:
 * a per-prospect method plus a `JobRunner`-driven batch method, writing
 * only to the existing general-purpose `evidence`/`trigger_signal` rows
 * using ONLY the fixed `SIGNAL_CATEGORIES`/`VALID_TRIGGER_TYPES` vocabulary
 * Stage 3 already defines — `EvidenceAssemblyService`'s readers
 * (`evidence-readers.ts`) pick these up automatically with zero changes,
 * because they read generically from the `evidence` table by category.
 *
 * Deliberately does NOT expand DTC or paid-acquisition evidence beyond
 * what Stage 4B already collects, and does NOT attempt
 * `new_paid_channel_appearing` from press pages — see RISK_REGISTER.md's
 * Stage 5 section for why these are deliberate non-expansion decisions,
 * not oversights.
 */

export interface WebsiteEvidenceProspectOutcome {
  prospectId: string;
  pagesFetched: number;
  pagesFailed: number;
  factsWritten: number;
  triggersWritten: number;
  error?: string;
}

export interface CollectWebsiteEvidenceOptions {
  /** Overrides `SystemConfig`'s configured per-domain page cap for this call only. */
  maxPages?: number;
  /** When provided, called before every page fetch; returning false stops fetching further pages for this prospect (used by `runBatch` to share the `daily_limit_scrapes` budget across prospects). Absent means "no shared budget" — bounded only by `maxPages`. */
  canFetchAnotherPage?: () => boolean;
  /** Called once per page actually fetched (success or failure) — lets a caller track budget usage. */
  onPageFetchAttempted?: () => void;
}

interface BatchCheckpointEntry {
  pagesFetched?: number;
  pagesFailed?: number;
  factsWritten?: number;
  triggersWritten?: number;
  error?: string;
}

interface BatchCheckpoint {
  completed: Record<string, BatchCheckpointEntry>;
  scrapesUsed: number;
  stoppedReason: 'in_progress' | 'completed' | 'budget_exhausted';
}

export interface WebsiteEvidenceBatchOptions {
  resumeJobId?: string;
}

export interface WebsiteEvidenceBatchOutcome {
  jobId: string;
  stoppedReason: BatchCheckpoint['stoppedReason'];
  results: WebsiteEvidenceProspectOutcome[];
}

export const WEBSITE_EVIDENCE_BATCH_JOB_TYPE = 'website_evidence_batch';

export class WebsiteEvidenceService {
  private readonly jobRunner: JobRunner;
  private readonly systemConfig: SystemConfigService;

  constructor(
    private readonly db: MetrivioDb,
    private readonly websiteAdapter: WebsiteReadAdapter,
    private readonly logger?: ReturnType<typeof createLogger>
  ) {
    this.jobRunner = new JobRunner(db, logger);
    this.systemConfig = new SystemConfigService(db);
  }

  /**
   * Collects and persists website-derived evidence for one prospect. Always
   * runs the zero-fetch `correct_profile_identified` check (it costs no
   * network request, so it is never gated by the page budget); page
   * fetching only happens when the prospect has a `companyDomain`.
   */
  async collectForProspect(prospectId: string, options: CollectWebsiteEvidenceOptions = {}): Promise<WebsiteEvidenceProspectOutcome> {
    const prospectRows = await this.db.select().from(schema.prospects).where(eq(schema.prospects.id, prospectId)).limit(1);
    const prospect = prospectRows[0];
    if (!prospect) {
      throw new Error(`Cannot collect website evidence: no prospect found with id ${prospectId}`);
    }

    let factsWritten = 0;
    let triggersWritten = 0;

    if (prospect.xUsername && prospect.companyDomain) {
      const profileMatch = await mineCorrectProfileIdentifiedFromEnrichment(this.db, prospect.companyDomain, prospect.xUsername);
      if (profileMatch.matched && profileMatch.matchedValue) {
        // Confirmed, not inferred: the website itself is observed to link
        // to this exact account — an objective fact, not a text-pattern
        // interpretation, so CONFIRMED is used here despite being a
        // single-source observation (unlike the LIKELY-only text-pattern
        // facts below).
        const wrote = await this.insertEvidenceIfNew(
          prospectId,
          'decision_maker_signal',
          SIGNAL_CATEGORIES.decision_maker_signal.correctProfileIdentified,
          profileMatch.matchedValue,
          `https://${prospect.companyDomain}`,
          'CONFIRMED'
        );
        if (wrote) factsWritten += 1;
      }
    }

    if (!prospect.companyDomain) {
      return { prospectId, pagesFetched: 0, pagesFailed: 0, factsWritten, triggersWritten };
    }

    const maxPages = options.maxPages ?? (await this.systemConfig.getWebsiteEvidenceMaxPagesPerDomain());
    const timeoutMs = await this.systemConfig.getWebsiteEvidenceFetchTimeoutMs();
    const pagePaths = await this.systemConfig.getWebsiteEvidencePagePaths();

    let pagesFetched = 0;
    let pagesFailed = 0;

    for (const path of pagePaths) {
      // Bounds total *attempts*, not just successes — a domain with several
      // broken/missing paths must never cause the whole fixed page-path
      // list to be exhausted (instruction H: "no unbounded crawling").
      if (pagesFetched + pagesFailed >= maxPages) break;
      if (options.canFetchAnotherPage && !options.canFetchAnotherPage()) break;

      const url = `https://${prospect.companyDomain}${path}`;
      options.onPageFetchAttempted?.();

      let text: string;
      let finalUrl: string;
      try {
        const page = await this.websiteAdapter.fetchPage(url, { timeoutMs });
        text = page.text;
        finalUrl = page.finalUrl;
        pagesFetched += 1;
      } catch (err) {
        pagesFailed += 1;
        this.logger?.info(
          { prospectId, url, err: err instanceof WebsiteReadError ? err.message : err instanceof Error ? err.message : String(err) },
          'website_evidence.page_fetch_failed'
        );
        continue;
      }

      const employeeCount = classifyEmployeeCountBand(text);
      if (employeeCount.matched) {
        const wrote = await this.insertEvidenceIfNew(
          prospectId,
          'revenue_signal',
          SIGNAL_CATEGORIES.revenue_signal.employeeCountBand,
          employeeCount.matchedPhrase ?? '',
          finalUrl,
          'LIKELY'
        );
        if (wrote) factsWritten += 1;
      }

      const warehouse = classifyWarehouseFulfillmentSignal(text);
      if (warehouse.matched) {
        const wrote = await this.insertEvidenceIfNew(
          prospectId,
          'revenue_signal',
          SIGNAL_CATEGORIES.revenue_signal.warehouseFulfillmentSignal,
          warehouse.matchedPhrase ?? '',
          finalUrl,
          'LIKELY'
        );
        if (wrote) factsWritten += 1;
      }

      const revenueStatement = classifyConfirmedRevenueStatement(text);
      if (revenueStatement.matched) {
        // CONFIRMED per ICP §22.A: this category is defined as "a primary
        // source explicitly states the actual figure" — the tier value
        // documents that this is exactly such a statement, though (per the
        // established rule) it is never the tier value itself that drives
        // scoring; the scorer treats confirmedRevenueStatement's presence
        // as its own independent CONFIRMED-tier Revenue-Fit signal.
        const wrote = await this.insertEvidenceIfNew(
          prospectId,
          'revenue_signal',
          SIGNAL_CATEGORIES.revenue_signal.confirmedRevenueStatement,
          revenueStatement.matchedPhrase ?? '',
          finalUrl,
          'CONFIRMED'
        );
        if (wrote) factsWritten += 1;
      }

      if (prospect.displayName) {
        const pressQuote = classifyPublicVisibilityPressQuote(text, prospect.displayName);
        if (pressQuote.matched) {
          const wrote = await this.insertEvidenceIfNew(
            prospectId,
            'decision_maker_signal',
            SIGNAL_CATEGORIES.decision_maker_signal.publicVisibility,
            pressQuote.matchedPhrase ?? '',
            finalUrl,
            'STRONG_EVIDENCE'
          );
          if (wrote) factsWritten += 1;
        }
      }

      const triggers = classifyPressAnnouncementTriggers(text);
      for (const trigger of triggers) {
        if (!trigger.triggerType) continue;
        const wrote = await this.insertEvidenceIfNew(
          prospectId,
          'trigger_signal',
          trigger.triggerType,
          trigger.matchedPhrase ?? '',
          finalUrl,
          'LIKELY'
        );
        if (wrote) triggersWritten += 1;
      }
    }

    return { prospectId, pagesFetched, pagesFailed, factsWritten, triggersWritten };
  }

  private async insertEvidenceIfNew(
    prospectId: string,
    evidenceType: (typeof schema.evidence.$inferInsert)['evidenceType'],
    signalCategory: string,
    rawValue: string,
    sourceUrl: string,
    evidenceTier: (typeof schema.evidence.$inferInsert)['evidenceTier']
  ): Promise<boolean> {
    const existing = await this.db
      .select()
      .from(schema.evidence)
      .where(
        and(
          eq(schema.evidence.prospectId, prospectId),
          eq(schema.evidence.evidenceType, evidenceType),
          eq(schema.evidence.signalCategory, signalCategory),
          eq(schema.evidence.rawValue, rawValue)
        )
      )
      .limit(1);
    if (existing.length > 0) return false; // idempotent: rerunning against an unchanged page never duplicates the same observed fact.

    await this.db.insert(schema.evidence).values({
      id: uuid(),
      prospectId,
      evidenceType,
      signalCategory,
      evidenceTier,
      rawValue,
      sourceUrl,
      capturedAt: new Date().toISOString(),
      capturedBy: 'system',
    });
    return true;
  }

  /**
   * Batch website-evidence collection over the existing `job_runs`
   * mechanism (same checkpoint-per-item, resumable design as
   * `TechnologyEnrichmentService.scanBatch`/`EvidenceAssemblyService.
   * scoreBatch` — no second job system). Shares the existing
   * `daily_limit_scrapes` budget across the whole batch, checked before
   * every page fetch, exactly like `DiscoveryService.run` — so this never
   * introduces a second, parallel rate-limit mechanism.
   */
  async runBatch(prospectIds: string[], options: WebsiteEvidenceBatchOptions = {}): Promise<WebsiteEvidenceBatchOutcome> {
    let jobId: string;
    let checkpoint: BatchCheckpoint;

    if (options.resumeJobId) {
      const existing = await this.jobRunner.get(options.resumeJobId);
      if (!existing) {
        throw new Error(`Cannot resume website-evidence batch: no job_run found with id ${options.resumeJobId}`);
      }
      jobId = existing.id;
      checkpoint = (existing.checkpoint as BatchCheckpoint | null) ?? { completed: {}, scrapesUsed: 0, stoppedReason: 'in_progress' };
      checkpoint.stoppedReason = 'in_progress';
      await this.jobRunner.markResumed(jobId);
    } else {
      checkpoint = { completed: {}, scrapesUsed: 0, stoppedReason: 'in_progress' };
      jobId = await this.jobRunner.start(WEBSITE_EVIDENCE_BATCH_JOB_TYPE, checkpoint);
    }

    const scrapeBudget = await this.systemConfig.getDailyLimit('scrapes');
    const pending = prospectIds.filter((id) => !(id in checkpoint.completed));

    for (const prospectId of pending) {
      if (checkpoint.scrapesUsed >= scrapeBudget) {
        checkpoint.stoppedReason = 'budget_exhausted';
        break;
      }
      try {
        const result = await this.collectForProspect(prospectId, {
          canFetchAnotherPage: () => checkpoint.scrapesUsed < scrapeBudget,
          onPageFetchAttempted: () => {
            checkpoint.scrapesUsed += 1;
          },
        });
        checkpoint.completed[prospectId] = {
          pagesFetched: result.pagesFetched,
          pagesFailed: result.pagesFailed,
          factsWritten: result.factsWritten,
          triggersWritten: result.triggersWritten,
        };
      } catch (err) {
        checkpoint.completed[prospectId] = { error: err instanceof Error ? err.message : String(err) };
      }
      await this.jobRunner.updateCheckpoint(jobId, checkpoint);
    }

    if (checkpoint.stoppedReason === 'in_progress') {
      checkpoint.stoppedReason = 'completed';
    }
    await this.jobRunner.updateCheckpoint(jobId, checkpoint);
    await this.jobRunner.complete(jobId);

    const results: WebsiteEvidenceProspectOutcome[] = prospectIds.map((prospectId) => {
      const entry = checkpoint.completed[prospectId];
      if (!entry) return { prospectId, pagesFetched: 0, pagesFailed: 0, factsWritten: 0, triggersWritten: 0, error: 'prospect was not processed by this batch run (budget exhausted before reaching it)' };
      return {
        prospectId,
        pagesFetched: entry.pagesFetched ?? 0,
        pagesFailed: entry.pagesFailed ?? 0,
        factsWritten: entry.factsWritten ?? 0,
        triggersWritten: entry.triggersWritten ?? 0,
        error: entry.error,
      };
    });

    return { jobId, stoppedReason: checkpoint.stoppedReason, results };
  }
}
