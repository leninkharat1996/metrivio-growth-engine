import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import {
  JobRunner,
  SystemConfigService,
  schema,
  SIGNAL_CATEGORIES,
  type MetrivioDb,
  type XReadAdapter,
  type TweetResult,
  type ProfileResult,
  type createLogger,
} from '@metrivio/core';
import { classifyFounderCandidate } from './founder-classifier.js';
import { resolveDomainFromWebsite, resolveCompanyNameFromBio } from './company-domain.js';
import { classifyPainIntent } from './pain-intent-classifier.js';
import { classifyPaidMediaJobPosting } from './paid-media-job-posting.js';

/**
 * X Prospect Discovery — BUILD_PLAN.md Stage 4B. Read-only: every X call
 * goes through the existing `XReadAdapter` (never XActions directly), and
 * this service persists to the local database only — no scoring
 * (`scoreProspect`), no LinkedIn/Apollo, no X write operations.
 *
 * Pipeline (per Stage 4B's instructions):
 *   configured search query -> tweet/search candidates -> dedup by username
 *   -> profile retrieval -> founder/CEO classification -> company/domain
 *   extraction -> prospect upsert -> discovery provenance -> job checkpoint
 *   -> deterministic summary.
 *
 * Two phases within one resumable job:
 *   Phase 1 (search) — run every not-yet-searched configured query,
 *   accumulating deduped candidates with their discovery provenance.
 *   Phase 2 (enrich) — profile-fetch and persist every not-yet-processed
 *   candidate, one at a time, checkpointing after each so a crash loses at
 *   most one in-flight candidate.
 */

export type DiscoverySourceType = 'founder_search' | 'pain_intent_search';

interface CandidateMatch {
  query: string;
  source: DiscoverySourceType;
  tweetUrl: string;
  tweetText: string;
  tweetCreatedAt: string;
}

interface DiscoveryCheckpoint {
  pendingQueries: Array<{ query: string; source: DiscoverySourceType }>;
  searchedQueries: string[];
  /** Deduped by lowercased username. */
  pendingCandidates: Record<string, CandidateMatch[]>;
  processedUsernames: string[];
  scrapesUsed: number;
  stoppedReason: 'in_progress' | 'completed' | 'budget_exhausted' | 'max_profiles_reached';
  totals: {
    candidatesFound: number;
    profilesRetrieved: number;
    prospectsCreated: number;
    prospectsUpdated: number;
    evidenceRowsWritten: number;
    painSignalsWritten: number;
  };
  errors: Array<{ stage: 'search' | 'profile'; target: string; errorType: string; message: string }>;
}

export interface DiscoveryRunOptions {
  resumeJobId?: string;
}

export interface DiscoveryRunSummary {
  jobId: string;
  stoppedReason: DiscoveryCheckpoint['stoppedReason'];
  candidatesFound: number;
  profilesRetrieved: number;
  prospectsCreated: number;
  prospectsUpdated: number;
  evidenceRowsWritten: number;
  painSignalsWritten: number;
  errors: DiscoveryCheckpoint['errors'];
}

export const DISCOVERY_JOB_TYPE = 'x_prospect_discovery';

function emptyCheckpoint(queries: Array<{ query: string; source: DiscoverySourceType }>): DiscoveryCheckpoint {
  return {
    pendingQueries: queries,
    searchedQueries: [],
    pendingCandidates: {},
    processedUsernames: [],
    scrapesUsed: 0,
    stoppedReason: 'in_progress',
    totals: {
      candidatesFound: 0,
      profilesRetrieved: 0,
      prospectsCreated: 0,
      prospectsUpdated: 0,
      evidenceRowsWritten: 0,
      painSignalsWritten: 0,
    },
    errors: [],
  };
}

function errorTypeOf(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError';
}

export class DiscoveryService {
  private readonly jobRunner: JobRunner;
  private readonly systemConfig: SystemConfigService;

  constructor(
    private readonly db: MetrivioDb,
    private readonly xReadAdapter: XReadAdapter,
    private readonly logger?: ReturnType<typeof createLogger>
  ) {
    this.jobRunner = new JobRunner(db, logger);
    this.systemConfig = new SystemConfigService(db);
  }

  async run(options: DiscoveryRunOptions = {}): Promise<DiscoveryRunSummary> {
    let jobId: string;
    let checkpoint: DiscoveryCheckpoint;

    if (options.resumeJobId) {
      const existing = await this.jobRunner.get(options.resumeJobId);
      if (!existing) {
        throw new Error(`Cannot resume discovery run: no job_run found with id ${options.resumeJobId}`);
      }
      jobId = existing.id;
      checkpoint = existing.checkpoint as DiscoveryCheckpoint;
      // Reset the stale stop reason from whatever previously halted this
      // job (e.g. a prior budget_exhausted) — otherwise phase 2 below would
      // never run again just because the loaded checkpoint still records
      // last run's stop condition.
      checkpoint.stoppedReason = 'in_progress';
      await this.jobRunner.markResumed(jobId);
    } else {
      const founderQueries = await this.systemConfig.getDiscoveryFounderQueries();
      const painQueries = await this.systemConfig.getDiscoveryPainIntentQueries();
      const queries: Array<{ query: string; source: DiscoverySourceType }> = [
        ...founderQueries.map((query) => ({ query, source: 'founder_search' as const })),
        ...painQueries.map((query) => ({ query, source: 'pain_intent_search' as const })),
      ];
      checkpoint = emptyCheckpoint(queries);
      jobId = await this.jobRunner.start(DISCOVERY_JOB_TYPE, checkpoint);
    }

    const maxCandidatesPerQuery = await this.systemConfig.getDiscoveryMaxCandidatesPerQuery();
    const maxProfilesPerRun = await this.systemConfig.getDiscoveryMaxProfilesPerRun();
    const scrapeBudget = await this.systemConfig.getDailyLimit('scrapes');

    // ---- Phase 1: search ---------------------------------------------------
    while (checkpoint.pendingQueries.length > 0) {
      if (checkpoint.scrapesUsed >= scrapeBudget) {
        checkpoint.stoppedReason = 'budget_exhausted';
        await this.jobRunner.updateCheckpoint(jobId, checkpoint);
        break;
      }
      const next = checkpoint.pendingQueries[0];
      if (!next) break;
      await this.searchOneQuery(next, maxCandidatesPerQuery, checkpoint);
      checkpoint.pendingQueries = checkpoint.pendingQueries.slice(1);
      checkpoint.searchedQueries.push(next.query);
      checkpoint.scrapesUsed += 1;
      await this.jobRunner.updateCheckpoint(jobId, checkpoint);
    }

    // ---- Phase 2: enrich ----------------------------------------------------
    if (checkpoint.stoppedReason === 'in_progress') {
      const pendingUsernames = Object.keys(checkpoint.pendingCandidates).filter(
        (u) => !checkpoint.processedUsernames.includes(u)
      );
      for (const username of pendingUsernames) {
        if (checkpoint.scrapesUsed >= scrapeBudget) {
          checkpoint.stoppedReason = 'budget_exhausted';
          break;
        }
        if (checkpoint.totals.profilesRetrieved >= maxProfilesPerRun) {
          checkpoint.stoppedReason = 'max_profiles_reached';
          break;
        }
        await this.enrichOneCandidate(username, checkpoint);
        checkpoint.processedUsernames.push(username);
        checkpoint.scrapesUsed += 1;
        await this.jobRunner.updateCheckpoint(jobId, checkpoint);
      }
    }

    if (checkpoint.stoppedReason === 'in_progress') {
      checkpoint.stoppedReason = 'completed';
    }
    await this.jobRunner.updateCheckpoint(jobId, checkpoint);
    await this.jobRunner.complete(jobId);

    return {
      jobId,
      stoppedReason: checkpoint.stoppedReason,
      ...checkpoint.totals,
      errors: checkpoint.errors,
    };
  }

  private async searchOneQuery(
    target: { query: string; source: DiscoverySourceType },
    maxCandidates: number,
    checkpoint: DiscoveryCheckpoint
  ): Promise<void> {
    let tweets: TweetResult[];
    try {
      tweets = await this.xReadAdapter.searchTweets(target.query, { limit: maxCandidates });
    } catch (err) {
      checkpoint.errors.push({
        stage: 'search',
        target: target.query,
        errorType: errorTypeOf(err),
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    checkpoint.totals.candidatesFound += tweets.length;

    for (const tweet of tweets) {
      const username = tweet.authorUsername?.toLowerCase();
      if (!username) continue;
      const match: CandidateMatch = {
        query: target.query,
        source: target.source,
        tweetUrl: tweet.url,
        tweetText: tweet.text,
        tweetCreatedAt: tweet.createdAt,
      };
      const existing = checkpoint.pendingCandidates[username];
      if (existing) {
        existing.push(match);
      } else {
        checkpoint.pendingCandidates[username] = [match];
      }
    }
  }

  private async enrichOneCandidate(username: string, checkpoint: DiscoveryCheckpoint): Promise<void> {
    const matches = checkpoint.pendingCandidates[username] ?? [];
    let profile: ProfileResult;
    try {
      profile = await this.xReadAdapter.getProfile(username);
    } catch (err) {
      checkpoint.errors.push({
        stage: 'profile',
        target: username,
        errorType: errorTypeOf(err),
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    checkpoint.totals.profilesRetrieved += 1;

    const founderClassification = classifyFounderCandidate(profile.bio);
    const domainResolution = resolveDomainFromWebsite(profile.website);
    const companyNameResolution = resolveCompanyNameFromBio(profile.bio);

    const prospectId = await this.upsertProspect(profile, username, matches, founderClassification, domainResolution, companyNameResolution, checkpoint);

    for (const match of matches) {
      await this.recordProspectSource(prospectId, match);
    }

    if (founderClassification.roleDetected && founderClassification.normalizedRole) {
      await this.writeDecisionMakerEvidence(prospectId, founderClassification);
      checkpoint.totals.evidenceRowsWritten += 1;
    }

    if (domainResolution.domain) {
      await this.writeCompanyIdentificationEvidence(prospectId, domainResolution.domain, profile.username);
      checkpoint.totals.evidenceRowsWritten += 1;
    }

    for (const match of matches) {
      const pain = classifyPainIntent(match.tweetText);
      if (pain.matched && pain.topic) {
        const wrote = await this.writePainSignal(prospectId, pain.topic, match);
        if (wrote) checkpoint.totals.painSignalsWritten += 1;
      }

      const jobPosting = classifyPaidMediaJobPosting(match.tweetText, match.tweetCreatedAt);
      if (jobPosting.qualifies) {
        const wrote = await this.writePaidAcquisitionEvidence(prospectId, match, jobPosting.matchedPhrase ?? '');
        if (wrote) checkpoint.totals.evidenceRowsWritten += 1;
      }
    }
  }

  private async upsertProspect(
    profile: ProfileResult,
    username: string,
    matches: CandidateMatch[],
    founder: ReturnType<typeof classifyFounderCandidate>,
    domain: ReturnType<typeof resolveDomainFromWebsite>,
    companyName: ReturnType<typeof resolveCompanyNameFromBio>,
    checkpoint: DiscoveryCheckpoint
  ): Promise<string> {
    const byUserId = profile.userId
      ? await this.db.select().from(schema.prospects).where(eq(schema.prospects.xUserId, profile.userId)).limit(1)
      : [];
    const byUsername = await this.db
      .select()
      .from(schema.prospects)
      .where(eq(schema.prospects.xUsername, username))
      .limit(1);
    const existing = byUserId[0] ?? byUsername[0];

    const now = new Date().toISOString();

    if (existing) {
      // Never regress previously-known information to unknown — only fill
      // in fields that were previously null/unset, per "unknown information
      // must remain unknown" applied symmetrically to updates.
      await this.db
        .update(schema.prospects)
        .set({
          xUserId: existing.xUserId ?? profile.userId ?? null,
          bio: profile.bio ?? existing.bio,
          displayName: profile.displayName ?? existing.displayName,
          companyName: existing.companyName ?? companyName.companyName ?? null,
          companyDomain: existing.companyDomain ?? domain.domain ?? null,
          roleTitle: existing.roleTitle ?? founder.matchedPhrase ?? null,
          lastEnrichedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.prospects.id, existing.id));
      checkpoint.totals.prospectsUpdated += 1;
      return existing.id;
    }

    const id = uuid();
    const primarySource: DiscoverySourceType = matches.find((m) => m.source === 'founder_search')?.source ?? matches[0]?.source ?? 'founder_search';
    await this.db.insert(schema.prospects).values({
      id,
      xUsername: username,
      xUserId: profile.userId ?? null,
      xUrl: `https://x.com/${username}`,
      displayName: profile.displayName ?? null,
      bio: profile.bio ?? null,
      companyName: companyName.companyName,
      companyDomain: domain.domain,
      roleTitle: founder.matchedPhrase,
      location: profile.location ?? null,
      source: primarySource,
      sourceDetail: matches[0]?.query ?? null,
      dateDiscovered: now,
      lastEnrichedAt: now,
    });
    checkpoint.totals.prospectsCreated += 1;
    return id;
  }

  private async recordProspectSource(prospectId: string, match: CandidateMatch): Promise<void> {
    const existing = await this.db
      .select()
      .from(schema.prospectSources)
      .where(
        and(
          eq(schema.prospectSources.prospectId, prospectId),
          eq(schema.prospectSources.source, match.source),
          eq(schema.prospectSources.sourceDetail, match.query)
        )
      )
      .limit(1);
    if (existing.length > 0) return; // idempotent: the same query surfacing the same prospect again doesn't re-insert.

    await this.db.insert(schema.prospectSources).values({
      id: uuid(),
      prospectId,
      source: match.source,
      sourceDetail: match.query,
      discoveredAt: match.tweetCreatedAt || new Date().toISOString(),
    });
  }

  private async writeDecisionMakerEvidence(
    prospectId: string,
    founder: ReturnType<typeof classifyFounderCandidate>
  ): Promise<void> {
    const categoryMap = SIGNAL_CATEGORIES.decision_maker_signal;
    const categoryByRole = {
      founder_or_ceo: categoryMap.roleFounderOrCeo,
      director_with_authority_signal: categoryMap.roleDirectorWithAuthoritySignal,
      other_marketing_adjacent: categoryMap.roleOtherMarketingAdjacent,
      execution_only: categoryMap.roleExecutionOnly,
    } as const;
    const signalCategory = founder.normalizedRole ? categoryByRole[founder.normalizedRole] : undefined;
    if (!signalCategory) return;

    await this.insertEvidenceIfNew(prospectId, 'decision_maker_signal', signalCategory, founder.matchedPhrase ?? '', null);
  }

  private async writeCompanyIdentificationEvidence(prospectId: string, domain: string, profileUsername: string): Promise<void> {
    await this.insertEvidenceIfNew(
      prospectId,
      'company_identification',
      'website_domain',
      domain,
      `https://x.com/${profileUsername}`
    );
  }

  private async writePaidAcquisitionEvidence(prospectId: string, match: CandidateMatch, matchedPhrase: string): Promise<boolean> {
    return this.insertEvidenceIfNew(
      prospectId,
      'paid_acquisition_signal',
      SIGNAL_CATEGORIES.paid_acquisition_signal.paidMediaJobPosting90d,
      matchedPhrase,
      match.tweetUrl,
      match.tweetCreatedAt
    );
  }

  private async insertEvidenceIfNew(
    prospectId: string,
    evidenceType: (typeof schema.evidence.$inferInsert)['evidenceType'],
    signalCategory: string,
    rawValue: string,
    sourceUrl: string | null,
    capturedAt?: string
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
    if (existing.length > 0) return false; // idempotent: the same observed fact is not re-appended every run.

    await this.db.insert(schema.evidence).values({
      id: uuid(),
      prospectId,
      evidenceType,
      signalCategory,
      // ICP §4: a single, uncorroborated discovery-time observation is
      // LIKELY — never CONFIRMED/STRONG_EVIDENCE from a single X source, and
      // never UNKNOWN (a real fact was in fact observed).
      evidenceTier: 'LIKELY',
      rawValue,
      sourceUrl: sourceUrl ?? undefined,
      capturedAt: capturedAt ?? new Date().toISOString(),
      capturedBy: 'system',
    });
    return true;
  }

  private async writePainSignal(prospectId: string, topic: string, match: CandidateMatch): Promise<boolean> {
    const existing = await this.db
      .select()
      .from(schema.painSignals)
      .where(and(eq(schema.painSignals.prospectId, prospectId), eq(schema.painSignals.sourceUrl, match.tweetUrl)))
      .limit(1);
    if (existing.length > 0) return false;

    await this.db.insert(schema.painSignals).values({
      id: uuid(),
      prospectId,
      signalText: match.tweetText,
      sourceUrl: match.tweetUrl,
      topic: topic as (typeof schema.painSignals.$inferInsert)['topic'],
      capturedAt: match.tweetCreatedAt || new Date().toISOString(),
    });
    return true;
  }
}
