import { KillSwitch, SystemConfigService, type MetrivioDb, type XReadAdapter, type createLogger } from '@metrivio/core';
import { discoverAccounts, type AccountDiscoveryResult } from '../accounts/account-discovery.js';
import { TrackedAccountStore } from '../accounts/tracked-account-store.js';

/**
 * Stage 7, Section F — competitor discovery. Uses Metrivio's OWN
 * positioning (marketing-efficiency diagnostic for DTC/ecommerce) to build
 * the search queries, rather than requiring a manually maintained
 * competitor list, per instruction. `REQUIRED_BIO_KEYWORDS` are drawn
 * directly from the competitor categories the instructions themselves
 * name (marketing analytics consultancies, ecommerce growth consultants,
 * performance marketing consultants, fractional growth leaders, DTC growth
 * agencies, marketing efficiency consultants, attribution/measurement
 * companies) — never an invented, ungrounded list.
 */
const DEFAULT_QUERIES = [
  'marketing efficiency consultant DTC',
  'ecommerce growth consultant',
  'performance marketing consultant DTC',
  'fractional CMO ecommerce',
  'DTC growth agency',
  'attribution measurement agency',
] as const;

const REQUIRED_BIO_KEYWORDS = [
  'marketing efficiency',
  'growth consultant',
  'fractional cmo',
  'growth agency',
  'performance marketing',
  'attribution',
  'measurement',
  'media buying',
  'paid media agency',
  'ecommerce growth',
  'dtc growth',
] as const;

const DEFAULT_MAX_CANDIDATES_PER_QUERY = 15;
const DEFAULT_MAX_ACCOUNTS = 25;

export interface CompetitorDiscoveryOptions {
  queries?: readonly string[];
  maxCandidatesPerQuery?: number;
  maxAccounts?: number;
}

export class CompetitorDiscoveryService {
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

  async discover(options: CompetitorDiscoveryOptions = {}): Promise<AccountDiscoveryResult> {
    if (await this.killSwitch.isActive()) {
      return { created: [], reused: [], rejected: [] };
    }

    const result = await discoverAccounts(this.xReadAdapter, this.accounts, {
      accountType: 'competitor',
      queries: options.queries ?? DEFAULT_QUERIES,
      requiredBioKeywords: REQUIRED_BIO_KEYWORDS,
      maxCandidatesPerQuery: options.maxCandidatesPerQuery ?? DEFAULT_MAX_CANDIDATES_PER_QUERY,
      maxAccounts: options.maxAccounts ?? DEFAULT_MAX_ACCOUNTS,
    });

    this.logger?.info({ created: result.created.length, reused: result.reused.length, rejected: result.rejected.length }, 'competitor_discovery.completed');
    return result;
  }
}
