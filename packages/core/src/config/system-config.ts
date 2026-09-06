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
} as const;

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
}

export function generateConfigId(): string {
  return uuid();
}
