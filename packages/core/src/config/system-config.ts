import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { MetrivioDb } from '../db/client.js';
import { systemConfig } from '../db/schema.js';
import type { AutomationMode, AutomationSubsystem } from '../automation/types.js';
import { isAutomationMode } from '../automation/types.js';
import type { Env } from './env.js';

/**
 * The full set of keys ARCHITECTURE.md §7 documents as configurable at
 * runtime through Settings, with no redeploy required. This module is the
 * single place that reads/writes them — pipeline code should never read
 * process.env directly for anything in this list, since the whole point is
 * that these are changeable after boot.
 */
export const SYSTEM_CONFIG_KEYS = {
  automationMode: (subsystem: AutomationSubsystem) => `${subsystem}.automation_mode`,
  killSwitch: 'kill_switch',
  dailyLimitDms: 'daily_limit_dms',
  dailyLimitFollows: 'daily_limit_follows',
  dailyLimitPosts: 'daily_limit_posts',
  dailyLimitScrapes: 'daily_limit_scrapes',
  retryMaxAttempts: 'retry_max_attempts',
  sessionHealthAutoDowngrade: 'session_health_auto_downgrade',
  geographyFilter: 'geography_filter',
  verticalInclusionRules: 'vertical_inclusion_rules',
  verticalExclusionRules: 'vertical_exclusion_rules',
  /**
   * Stage 4B discovery configuration — kept to the smallest set genuinely
   * needed (query lists + two bounds), reusing this same generic
   * `system_config` key-value mechanism rather than a new subsystem.
   * Deliberately does NOT duplicate `dailyLimitScrapes` — a discovery run's
   * request budget reuses that existing key (see
   * `packages/prospecting/src/discovery`), per instruction not to build a
   * second rate-limit framework.
   */
  discoveryFounderQueries: 'discovery.founder_queries',
  discoveryPainIntentQueries: 'discovery.pain_intent_queries',
  discoveryMaxCandidatesPerQuery: 'discovery.max_candidates_per_query',
  discoveryMaxProfilesPerRun: 'discovery.max_profiles_per_run',
  /**
   * Stage 5 website-evidence configuration — same pattern as the Stage 4B
   * discovery keys above: the smallest bound set genuinely needed (a page
   * path list, a per-domain page cap, and a per-request timeout), reusing
   * this same generic `system_config` mechanism. Deliberately does not
   * duplicate `dailyLimitScrapes` — a website-evidence run's request budget
   * reuses that existing key (see
   * `packages/prospecting/src/website-evidence`), per instruction not to
   * build a second rate-limit framework.
   */
  websiteEvidencePagePaths: 'website_evidence.page_paths',
  websiteEvidenceMaxPagesPerDomain: 'website_evidence.max_pages_per_domain',
  websiteEvidenceFetchTimeoutMs: 'website_evidence.fetch_timeout_ms',
  /**
   * Stage 6A — the minimum ICP tier a prospect must have to be outreach-
   * eligible. Deliberately has NO default value seeded by
   * `seedDefaultsFromEnv` and no fallback in its getter: neither
   * docs/02-metrivio-icp.md nor docs/01-metrivio-offer.md defines an
   * outreach score/tier threshold anywhere (the ICP score bands in §22.C
   * are fit bands, not an outreach-contact policy) — per instruction, this
   * must not be invented silently. Until a human sets this key explicitly,
   * `getOutreachMinimumTier()` returns `null`, and
   * `packages/outreach`'s eligibility evaluator treats that as INELIGIBLE
   * for every prospect (fail-closed — the same "unset = safest state"
   * convention every other config default in this file already follows).
   */
  outreachMinimumTier: 'outreach.minimum_tier',
  /**
   * Stage 6B — the maximum character length a single outreach DM's message
   * text may have. Not X's own real DM character limit (that value is not
   * verifiable from this codebase's vendored XActions source — `dm.js`,
   * which would carry it, was deliberately excluded; see RISK_REGISTER.md's
   * Stage 6B section) — a deliberately conservative, documented internal
   * safety default for a cold-outreach message, not a re-derivation of a
   * platform limit this codebase has never confirmed. The daily outreach
   * DM cap deliberately reuses the existing `dailyLimitDms` key above
   * rather than a new one — Stage 1 already defined it for exactly this
   * purpose (`daily_limit_dms`), per instruction not to build a second
   * rate-limit framework.
   */
  outreachMaxMessageLength: 'outreach.max_message_length',
  /**
   * Stage 6E — the maximum number of candidates a single scheduled
   * automation run (due-work discovery, reply refresh, or follow-up-draft
   * preparation) may process. Deliberately the ONLY new configuration key
   * this stage introduces — automation on/off and automation "mode" are not
   * new concepts: `automationMode('prospecting.outreach')` (Stage 1, above)
   * already exists, already fail-closes to `dry_run` when unset, and is
   * reused as-is rather than inventing a second `automation.enabled`/
   * `automation.mode` pair.
   */
  outreachAutomationMaxItemsPerRun: 'outreach.automation_max_items_per_run',
  /**
   * Stage 7 — the content-intelligence-automation analog of
   * `outreachAutomationMaxItemsPerRun` above. Automation on/off and mode
   * are NOT new concepts here either: `automationMode('content.publishing')`
   * (Stage 1, above) already exists and already fail-closes to `dry_run`
   * when unset — reused as-is, exactly like Stage 6E reused
   * `automationMode('prospecting.outreach')`.
   */
  contentAutomationMaxItemsPerRun: 'content.automation_max_items_per_run',
  /**
   * Stage 8 — a SECOND, explicit confirmation gate on top of
   * `automationMode('content.publishing') === 'autonomous'`. Per Stage 8's
   * own instruction ("AUTONOMOUS explicitly disabled unless all required
   * conditions satisfied, fail closed if config missing"): setting the mode
   * to `autonomous` alone is not sufficient for `PublishApprovedContentService`
   * to actually call `XPublishAdapter` for automation-discovered work —
   * this additional boolean must also be explicitly set to `true`. Missing
   * or any non-`'true'` value fails closed (treated as `false`). This does
   * NOT gate `approval_required` mode, which already requires each
   * individual draft to carry a real human approval (Section F) — this
   * flag only affects whether the *automation job* itself
   * (`PUBLISH_DUE_CONTENT`) is allowed to trigger that already-human-approved
   * publish without a further per-run human action.
   */
  contentPublishingAutonomousEnabled: 'content.publishing.autonomous_enabled',
  /**
   * Stage 9 — the X username Metrivio's own account publishes under.
   * Needed to construct a tweet URL (`https://x.com/{handle}/status/{id}`)
   * for `XReadAdapter.getEngagers()` and a mention-search query for
   * business-intent collection — neither of which this codebase had any
   * prior need to know. Optional/unset by default (fails closed to "skip
   * engagement collection, report the gap" rather than guessing a handle).
   */
  contentPublishingOwnXHandle: 'content.publishing.own_x_handle',
} as const;

/** See `outreachMaxMessageLength`'s doc comment above — conservative and documented, not sourced from a verified X platform limit. */
export const DEFAULT_OUTREACH_MAX_MESSAGE_LENGTH = 500;

/** See `outreachAutomationMaxItemsPerRun`'s doc comment above — a small, conservative bound, consistent with `DEFAULT_DISCOVERY_MAX_PROFILES_PER_RUN`'s own style. */
export const DEFAULT_OUTREACH_AUTOMATION_MAX_ITEMS_PER_RUN = 25;

/** See `contentAutomationMaxItemsPerRun`'s doc comment above. */
export const DEFAULT_CONTENT_AUTOMATION_MAX_ITEMS_PER_RUN = 25;

/**
 * Default discovery queries, derived directly from the finalized ICP
 * document rather than invented: founder-role vocabulary from ICP §22.B's
 * own role-tier terminology (Founder/Co-founder/CEO/Owner) combined with the
 * DTC/ecommerce/Shopify business-model terms ICP §7/§11 already use, and
 * pain/intent terms taken verbatim from DATABASE.md's own `pain_signals.
 * topic` enum (CAC/ROAS/MER/attribution/budget_allocation/
 * channel_performance/profitability) — not a separately-invented keyword
 * list.
 */
export const DEFAULT_DISCOVERY_FOUNDER_QUERIES = [
  'founder DTC',
  'founder ecommerce',
  'co-founder Shopify',
  'CEO DTC brand',
] as const;

export const DEFAULT_DISCOVERY_PAIN_INTENT_QUERIES = [
  'CAC',
  'ROAS',
  'MER',
  'attribution',
  'budget allocation',
  'channel performance',
  'profitability',
] as const;

export const DEFAULT_DISCOVERY_MAX_CANDIDATES_PER_QUERY = 25;
export const DEFAULT_DISCOVERY_MAX_PROFILES_PER_RUN = 50;

/**
 * Default page set to check for a domain, in priority order — the home page
 * is always fetched first; the rest are the pages most likely to carry the
 * specific first-party facts Stage 5 looks for (team size, press/
 * announcements, careers). Not exhaustive by design — a small, fixed list,
 * per instruction H ("prefer homepage/about/team/press/careers/contact
 * only," "no unbounded crawling").
 */
export const DEFAULT_WEBSITE_EVIDENCE_PAGE_PATHS = [
  '/',
  '/about',
  '/about-us',
  '/team',
  '/our-team',
  '/press',
  '/news',
  '/careers',
  '/jobs',
] as const;

export const DEFAULT_WEBSITE_EVIDENCE_MAX_PAGES_PER_DOMAIN = 4;
export const DEFAULT_WEBSITE_EVIDENCE_FETCH_TIMEOUT_MS = 8000;

export class SystemConfigService {
  constructor(private readonly db: MetrivioDb) {}

  private async getRaw(key: string): Promise<string | undefined> {
    const rows = await this.db.select().from(systemConfig).where(eq(systemConfig.key, key)).limit(1);
    return rows[0]?.value;
  }

  private async setRaw(key: string, value: string, updatedBy: string): Promise<void> {
    const existing = await this.db.select().from(systemConfig).where(eq(systemConfig.key, key)).limit(1);
    const now = new Date().toISOString();
    if (existing.length > 0) {
      await this.db
        .update(systemConfig)
        .set({ value, updatedAt: now, updatedBy })
        .where(eq(systemConfig.key, key));
    } else {
      await this.db.insert(systemConfig).values({ key, value, updatedAt: now, updatedBy });
    }
  }

  /**
   * Seeds system_config from environment defaults, but only for keys that
   * don't already have a stored value — an existing Settings change must
   * never be silently reverted by a restart with different env vars.
   */
  async seedDefaultsFromEnv(env: Env): Promise<void> {
    const defaults: Record<string, string> = {
      [SYSTEM_CONFIG_KEYS.automationMode('prospecting.outreach')]: env.PROSPECTING_OUTREACH_AUTOMATION_MODE,
      [SYSTEM_CONFIG_KEYS.automationMode('content.publishing')]: env.CONTENT_PUBLISHING_AUTOMATION_MODE,
      [SYSTEM_CONFIG_KEYS.killSwitch]: String(env.KILL_SWITCH),
      [SYSTEM_CONFIG_KEYS.dailyLimitDms]: String(env.DAILY_LIMIT_DMS),
      [SYSTEM_CONFIG_KEYS.dailyLimitFollows]: String(env.DAILY_LIMIT_FOLLOWS),
      [SYSTEM_CONFIG_KEYS.dailyLimitPosts]: String(env.DAILY_LIMIT_POSTS),
      [SYSTEM_CONFIG_KEYS.dailyLimitScrapes]: String(env.DAILY_LIMIT_SCRAPES),
      [SYSTEM_CONFIG_KEYS.retryMaxAttempts]: '3',
      [SYSTEM_CONFIG_KEYS.sessionHealthAutoDowngrade]: String(env.SESSION_HEALTH_AUTO_DOWNGRADE),
      [SYSTEM_CONFIG_KEYS.geographyFilter]: '[]',
      [SYSTEM_CONFIG_KEYS.verticalInclusionRules]: '[]',
      [SYSTEM_CONFIG_KEYS.verticalExclusionRules]: '[]',
      [SYSTEM_CONFIG_KEYS.discoveryFounderQueries]: JSON.stringify(DEFAULT_DISCOVERY_FOUNDER_QUERIES),
      [SYSTEM_CONFIG_KEYS.discoveryPainIntentQueries]: JSON.stringify(DEFAULT_DISCOVERY_PAIN_INTENT_QUERIES),
      [SYSTEM_CONFIG_KEYS.discoveryMaxCandidatesPerQuery]: String(DEFAULT_DISCOVERY_MAX_CANDIDATES_PER_QUERY),
      [SYSTEM_CONFIG_KEYS.discoveryMaxProfilesPerRun]: String(DEFAULT_DISCOVERY_MAX_PROFILES_PER_RUN),
      [SYSTEM_CONFIG_KEYS.websiteEvidencePagePaths]: JSON.stringify(DEFAULT_WEBSITE_EVIDENCE_PAGE_PATHS),
      [SYSTEM_CONFIG_KEYS.websiteEvidenceMaxPagesPerDomain]: String(DEFAULT_WEBSITE_EVIDENCE_MAX_PAGES_PER_DOMAIN),
      [SYSTEM_CONFIG_KEYS.websiteEvidenceFetchTimeoutMs]: String(DEFAULT_WEBSITE_EVIDENCE_FETCH_TIMEOUT_MS),
    };

    for (const [key, value] of Object.entries(defaults)) {
      const existing = await this.getRaw(key);
      if (existing === undefined) {
        await this.setRaw(key, value, 'system:boot-seed');
      }
    }
  }

  async getAutomationMode(subsystem: AutomationSubsystem): Promise<AutomationMode> {
    const raw = await this.getRaw(SYSTEM_CONFIG_KEYS.automationMode(subsystem));
    if (raw && isAutomationMode(raw)) return raw;
    // Fail safe: an unset or corrupt value is treated as dry_run, never as
    // autonomous — a missing config value must never accidentally unlock
    // live sends (ARCHITECTURE.md §1.4 / §7).
    return 'dry_run';
  }

  async setAutomationMode(subsystem: AutomationSubsystem, mode: AutomationMode, updatedBy: string): Promise<void> {
    await this.setRaw(SYSTEM_CONFIG_KEYS.automationMode(subsystem), mode, updatedBy);
  }

  async isKillSwitchActive(): Promise<boolean> {
    const raw = await this.getRaw(SYSTEM_CONFIG_KEYS.killSwitch);
    return raw === 'true';
  }

  async setKillSwitch(active: boolean, updatedBy: string): Promise<void> {
    await this.setRaw(SYSTEM_CONFIG_KEYS.killSwitch, String(active), updatedBy);
  }

  async getDailyLimit(kind: 'dms' | 'follows' | 'posts' | 'scrapes'): Promise<number> {
    const keyMap = {
      dms: SYSTEM_CONFIG_KEYS.dailyLimitDms,
      follows: SYSTEM_CONFIG_KEYS.dailyLimitFollows,
      posts: SYSTEM_CONFIG_KEYS.dailyLimitPosts,
      scrapes: SYSTEM_CONFIG_KEYS.dailyLimitScrapes,
    } as const;
    const raw = await this.getRaw(keyMap[kind]);
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    // Fail safe: an unparseable limit is treated as 0 (nothing allowed),
    // never as unlimited.
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  async setDailyLimit(kind: 'dms' | 'follows' | 'posts' | 'scrapes', value: number, updatedBy: string): Promise<void> {
    const keyMap = {
      dms: SYSTEM_CONFIG_KEYS.dailyLimitDms,
      follows: SYSTEM_CONFIG_KEYS.dailyLimitFollows,
      posts: SYSTEM_CONFIG_KEYS.dailyLimitPosts,
      scrapes: SYSTEM_CONFIG_KEYS.dailyLimitScrapes,
    } as const;
    await this.setRaw(keyMap[kind], String(Math.max(0, Math.trunc(value))), updatedBy);
  }

  /** See `contentPublishingAutonomousEnabled`'s doc comment — fails closed (unset or anything other than `'true'` means `false`). */
  async isContentPublishingAutonomousEnabled(): Promise<boolean> {
    const raw = await this.getRaw(SYSTEM_CONFIG_KEYS.contentPublishingAutonomousEnabled);
    return raw === 'true';
  }

  async setContentPublishingAutonomousEnabled(enabled: boolean, updatedBy: string): Promise<void> {
    await this.setRaw(SYSTEM_CONFIG_KEYS.contentPublishingAutonomousEnabled, String(enabled), updatedBy);
  }

  /** See `contentPublishingOwnXHandle`'s doc comment — `null` when unset, never a guessed/default handle. */
  async getContentPublishingOwnXHandle(): Promise<string | null> {
    const raw = await this.getRaw(SYSTEM_CONFIG_KEYS.contentPublishingOwnXHandle);
    return raw ?? null;
  }

  async setContentPublishingOwnXHandle(handle: string, updatedBy: string): Promise<void> {
    await this.setRaw(SYSTEM_CONFIG_KEYS.contentPublishingOwnXHandle, handle, updatedBy);
  }

  async isSessionHealthAutoDowngradeEnabled(): Promise<boolean> {
    const raw = await this.getRaw(SYSTEM_CONFIG_KEYS.sessionHealthAutoDowngrade);
    // Fail safe in the opposite direction from limits: an unset value keeps
    // the safety net ON by default (ARCHITECTURE.md §3.5 — "On by default").
    return raw === undefined ? true : raw === 'true';
  }

  async getGeographyFilter(): Promise<string[]> {
    const raw = await this.getRaw(SYSTEM_CONFIG_KEYS.geographyFilter);
    return raw ? (JSON.parse(raw) as string[]) : [];
  }

  async getVerticalRules(): Promise<{ inclusion: string[]; exclusion: string[] }> {
    const inclusionRaw = await this.getRaw(SYSTEM_CONFIG_KEYS.verticalInclusionRules);
    const exclusionRaw = await this.getRaw(SYSTEM_CONFIG_KEYS.verticalExclusionRules);
    return {
      inclusion: inclusionRaw ? (JSON.parse(inclusionRaw) as string[]) : [],
      exclusion: exclusionRaw ? (JSON.parse(exclusionRaw) as string[]) : [],
    };
  }

  async getDiscoveryFounderQueries(): Promise<string[]> {
    const raw = await this.getRaw(SYSTEM_CONFIG_KEYS.discoveryFounderQueries);
    return raw ? (JSON.parse(raw) as string[]) : [...DEFAULT_DISCOVERY_FOUNDER_QUERIES];
  }

  async setDiscoveryFounderQueries(queries: string[], updatedBy: string): Promise<void> {
    await this.setRaw(SYSTEM_CONFIG_KEYS.discoveryFounderQueries, JSON.stringify(queries), updatedBy);
  }

  async getDiscoveryPainIntentQueries(): Promise<string[]> {
    const raw = await this.getRaw(SYSTEM_CONFIG_KEYS.discoveryPainIntentQueries);
    return raw ? (JSON.parse(raw) as string[]) : [...DEFAULT_DISCOVERY_PAIN_INTENT_QUERIES];
  }

  async setDiscoveryPainIntentQueries(queries: string[], updatedBy: string): Promise<void> {
    await this.setRaw(SYSTEM_CONFIG_KEYS.discoveryPainIntentQueries, JSON.stringify(queries), updatedBy);
  }

  async getDiscoveryMaxCandidatesPerQuery(): Promise<number> {
    const raw = await this.getRaw(SYSTEM_CONFIG_KEYS.discoveryMaxCandidatesPerQuery);
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DISCOVERY_MAX_CANDIDATES_PER_QUERY;
  }

  async getDiscoveryMaxProfilesPerRun(): Promise<number> {
    const raw = await this.getRaw(SYSTEM_CONFIG_KEYS.discoveryMaxProfilesPerRun);
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DISCOVERY_MAX_PROFILES_PER_RUN;
  }

  async getWebsiteEvidencePagePaths(): Promise<string[]> {
    const raw = await this.getRaw(SYSTEM_CONFIG_KEYS.websiteEvidencePagePaths);
    return raw ? (JSON.parse(raw) as string[]) : [...DEFAULT_WEBSITE_EVIDENCE_PAGE_PATHS];
  }

  async setWebsiteEvidencePagePaths(paths: string[], updatedBy: string): Promise<void> {
    await this.setRaw(SYSTEM_CONFIG_KEYS.websiteEvidencePagePaths, JSON.stringify(paths), updatedBy);
  }

  async getWebsiteEvidenceMaxPagesPerDomain(): Promise<number> {
    const raw = await this.getRaw(SYSTEM_CONFIG_KEYS.websiteEvidenceMaxPagesPerDomain);
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WEBSITE_EVIDENCE_MAX_PAGES_PER_DOMAIN;
  }

  async getWebsiteEvidenceFetchTimeoutMs(): Promise<number> {
    const raw = await this.getRaw(SYSTEM_CONFIG_KEYS.websiteEvidenceFetchTimeoutMs);
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WEBSITE_EVIDENCE_FETCH_TIMEOUT_MS;
  }

  /** `null` means "not configured" — see the key's own doc comment above. Never defaults to a tier. */
  async getOutreachMinimumTier(): Promise<'A' | 'B' | 'C' | null> {
    const raw = await this.getRaw(SYSTEM_CONFIG_KEYS.outreachMinimumTier);
    return raw === 'A' || raw === 'B' || raw === 'C' ? raw : null;
  }

  async setOutreachMinimumTier(tier: 'A' | 'B' | 'C', updatedBy: string): Promise<void> {
    await this.setRaw(SYSTEM_CONFIG_KEYS.outreachMinimumTier, tier, updatedBy);
  }

  async getOutreachMaxMessageLength(): Promise<number> {
    const raw = await this.getRaw(SYSTEM_CONFIG_KEYS.outreachMaxMessageLength);
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OUTREACH_MAX_MESSAGE_LENGTH;
  }

  async setOutreachMaxMessageLength(length: number, updatedBy: string): Promise<void> {
    await this.setRaw(SYSTEM_CONFIG_KEYS.outreachMaxMessageLength, String(Math.max(1, Math.trunc(length))), updatedBy);
  }

  async getOutreachAutomationMaxItemsPerRun(): Promise<number> {
    const raw = await this.getRaw(SYSTEM_CONFIG_KEYS.outreachAutomationMaxItemsPerRun);
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OUTREACH_AUTOMATION_MAX_ITEMS_PER_RUN;
  }

  async setOutreachAutomationMaxItemsPerRun(value: number, updatedBy: string): Promise<void> {
    await this.setRaw(SYSTEM_CONFIG_KEYS.outreachAutomationMaxItemsPerRun, String(Math.max(1, Math.trunc(value))), updatedBy);
  }

  async getContentAutomationMaxItemsPerRun(): Promise<number> {
    const raw = await this.getRaw(SYSTEM_CONFIG_KEYS.contentAutomationMaxItemsPerRun);
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTENT_AUTOMATION_MAX_ITEMS_PER_RUN;
  }

  async setContentAutomationMaxItemsPerRun(value: number, updatedBy: string): Promise<void> {
    await this.setRaw(SYSTEM_CONFIG_KEYS.contentAutomationMaxItemsPerRun, String(Math.max(1, Math.trunc(value))), updatedBy);
  }
}

export function generateConfigId(): string {
  return uuid();
}
