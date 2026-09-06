import { KillSwitch, SystemConfigService, type MetrivioDb, type XReadAdapter, type createLogger } from '@metrivio/core';
import { discoverAccounts, type AccountDiscoveryResult } from '../accounts/account-discovery.js';
import { TrackedAccountStore } from '../accounts/tracked-account-store.js';

/**
 * Stage 7, Section H — expert discovery. Deliberately broader than
 * competitor discovery's queries/keywords (Section H explicitly wants a
 * wide niche: DTC, ecommerce, paid acquisition, Meta/Google advertising,
 * attribution, growth, CRO, profitability, direct response, personal
 * branding, founder marketing) — reusing the exact topic list the
 * instructions themselves name, never an invented list. Named examples in
 * the instructions (specific individual creators) are deliberately NOT
 * hardcoded here as permanent dependencies — they are research references
 * a human can seed manually via `TrackedAccountStore.create()` if desired;
 * this discovery path finds accounts from evidence (their own public bio),
 * exactly like competitor discovery.
 */
const DEFAULT_QUERIES = [
  'DTC growth marketing',
  'ecommerce paid acquisition',
  'Meta ads strategy DTC',
  'Google ads ecommerce',
  'marketing attribution growth',
  'conversion rate optimization ecommerce',
  'founder marketing personal brand',
  'direct response marketing',
] as const;

const REQUIRED_BIO_KEYWORDS = [
  'growth',
  'ecommerce',
  'dtc',
  'paid ads',
  'meta ads',
  'google ads',
  'attribution',
  'cro',
  'direct response',
  'performance marketing',
  'marketing',
  'founder',
] as const;

const DEFAULT_MAX_CANDIDATES_PER_QUERY = 15;
const DEFAULT_MAX_ACCOUNTS = 25;

export interface ExpertDiscoveryOptions {
  queries?: readonly string[];
  maxCandidatesPerQuery?: number;
  maxAccounts?: number;
}

export class ExpertDiscoveryService {
  private readonly killSwitch: KillSwitch;
  private readonly accounts: TrackedAccountStore;

  constructor(
    private readonly db: MetrivioDb,
    private readonly xReadAdapter: XReadAdapter,
    private readonly logger?: ReturnType<typeof createLogger>
  ) {
    this.killSwitch = new KillSwitch(new SystemConfigService(db));
    this.accounts = new TrackedAccountStore(db);
  }

  async discover(options: ExpertDiscoveryOptions = {}): Promise<AccountDiscoveryResult> {
    if (await this.killSwitch.isActive()) {
      return { created: [], reused: [], rejected: [] };
    }

    const result = await discoverAccounts(this.xReadAdapter, this.accounts, {
      accountType: 'expert',
      queries: options.queries ?? DEFAULT_QUERIES,
      requiredBioKeywords: REQUIRED_BIO_KEYWORDS,
      maxCandidatesPerQuery: options.maxCandidatesPerQuery ?? DEFAULT_MAX_CANDIDATES_PER_QUERY,
      maxAccounts: options.maxAccounts ?? DEFAULT_MAX_ACCOUNTS,
    });

    this.logger?.info({ created: result.created.length, reused: result.reused.length, rejected: result.rejected.length }, 'expert_discovery.completed');
    return result;
  }
}
