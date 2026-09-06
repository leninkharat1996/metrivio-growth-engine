import type { XReadAdapter } from '@metrivio/core';
import { TrackedAccountStore } from './tracked-account-store.js';
import type { TrackedAccount, TrackedAccountType } from './tracked-account.js';

/**
 * Shared discovery mechanics for both competitor discovery (Section F) and
 * expert discovery (Section H) — the same search -> profile -> classify
 * loop, parameterized by the caller's own query set and required-evidence
 * keywords, rather than two near-identical copies of this loop.
 *
 * "Only classify something as a competitor/expert when evidence supports
 * it" (Section F) is enforced structurally here: an account is REJECTED
 * (not silently dropped — the rejection and its reason are returned) unless
 * its own public bio contains at least one of the caller-specified
 * required keywords. A generic marketing account that merely appears in a
 * keyword search result is never classified without that additional bio
 * check.
 */
export interface AccountDiscoveryConfig {
  accountType: TrackedAccountType;
  queries: readonly string[];
  /** At least one of these must appear in the candidate's bio for classification to proceed. */
  requiredBioKeywords: readonly string[];
  /** If any of these appear in the bio, the candidate is rejected even if a required keyword also matched (e.g. an account primarily selling something unrelated). */
  excludedBioKeywords?: readonly string[];
  maxCandidatesPerQuery: number;
  maxAccounts: number;
}

export interface AccountDiscoveryRejection {
  username: string;
  reason: string;
}

export interface AccountDiscoveryResult {
  created: TrackedAccount[];
  reused: TrackedAccount[];
  rejected: AccountDiscoveryRejection[];
}

export async function discoverAccounts(xReadAdapter: XReadAdapter, store: TrackedAccountStore, config: AccountDiscoveryConfig): Promise<AccountDiscoveryResult> {
  const candidateUsernames: string[] = [];
  const seen = new Set<string>();

  for (const query of config.queries) {
    if (candidateUsernames.length >= config.maxAccounts) break;
    let tweets;
    try {
      tweets = await xReadAdapter.searchTweets(query, { limit: config.maxCandidatesPerQuery });
    } catch {
      continue; // one failing query never aborts discovery for the others
    }
    for (const tweet of tweets) {
      if (seen.has(tweet.authorUsername)) continue;
      seen.add(tweet.authorUsername);
      candidateUsernames.push(tweet.authorUsername);
      if (candidateUsernames.length >= config.maxAccounts) break;
    }
  }

  const created: TrackedAccount[] = [];
  const reused: TrackedAccount[] = [];
  const rejected: AccountDiscoveryRejection[] = [];

  for (const username of candidateUsernames) {
    const existing = await store.findByUsername(username);
    if (existing) {
      reused.push(existing);
      continue;
    }

    let profile;
    try {
      profile = await xReadAdapter.getProfile(username);
    } catch {
      rejected.push({ username, reason: 'profile lookup failed' });
      continue;
    }

    const bio = (profile.bio ?? '').toLowerCase();
    const matchedKeywords = config.requiredBioKeywords.filter((k) => bio.includes(k));
    if (matchedKeywords.length === 0) {
      rejected.push({ username, reason: 'bio does not contain any required relevance keyword — insufficient evidence to classify' });
      continue;
    }
    if (config.excludedBioKeywords?.some((k) => bio.includes(k))) {
      rejected.push({ username, reason: 'bio matched an exclusion keyword' });
      continue;
    }

    const account = await store.create({
      accountType: config.accountType,
      xUsername: username,
      xUserId: profile.userId ?? null,
      displayName: profile.displayName ?? null,
      companyName: null,
      classificationReason: `public bio contains: ${matchedKeywords.join(', ')}`,
      classificationConfidence: 'OBSERVATION',
    });
    created.push(account);
  }

  return { created, reused, rejected };
}
