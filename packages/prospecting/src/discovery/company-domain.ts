/**
 * Company/domain identification (BUILD_PLAN.md Stage 4B). Conservative by
 * design: the profile website field is the only domain source (ICP-aligned
 * ordering, item 1 of the founder's specified evidence order); a company
 * NAME may additionally come from an explicit bio mention, but a name is
 * never used to construct or guess a domain (hard rule — "Founder of
 * Example Brand" with no website must never become "examplebrand.com").
 */

export interface DomainResolution {
  /** Normalized hostname (lowercase, no protocol, no leading www., no path), or null when unresolved. */
  domain: string | null;
  source: 'profile_website' | 'unresolved';
  /** Present only when a website value existed but was rejected (e.g. a social-platform link). */
  rejectedReason?: string;
}

export interface CompanyNameResolution {
  companyName: string | null;
  source: 'bio_mention' | 'unresolved';
}

/**
 * Hostnames that are never a company's own domain — social/profile/link-
 * aggregator platforms commonly linked from an X bio in place of (or
 * alongside) a real company site. Not exhaustive by design; conservative
 * rejection of the common cases is the goal, not a complete blocklist.
 */
const REJECTED_HOSTS = new Set([
  'twitter.com',
  'x.com',
  'instagram.com',
  'facebook.com',
  'linkedin.com',
  'youtube.com',
  'tiktok.com',
  'threads.net',
  'linktr.ee',
  'linktree.com',
  'bio.link',
  'beacons.ai',
  'substack.com',
  'medium.com',
  'discord.gg',
  'discord.com',
  't.me',
]);

/**
 * Normalizes a raw website string into a bare hostname, or returns null with
 * a reason when it cannot safely be treated as a company domain. Does not
 * perform any network request (no redirect-following) — normalization only.
 */
export function resolveDomainFromWebsite(website: string | undefined | null): DomainResolution {
  if (!website || !website.trim()) {
    return { domain: null, source: 'unresolved' };
  }

  let hostname: string;
  try {
    const withProtocol = /^https?:\/\//i.test(website) ? website : `https://${website}`;
    hostname = new URL(withProtocol).hostname.toLowerCase();
  } catch {
    return { domain: null, source: 'unresolved', rejectedReason: 'not a parseable URL/hostname' };
  }

  const bare = hostname.startsWith('www.') ? hostname.slice(4) : hostname;

  if (!bare || !bare.includes('.')) {
    return { domain: null, source: 'unresolved', rejectedReason: 'not a valid domain' };
  }

  if (REJECTED_HOSTS.has(bare)) {
    return { domain: null, source: 'unresolved', rejectedReason: `rejected: ${bare} is a social/link-aggregator platform, not a company domain` };
  }

  return { domain: bare, source: 'profile_website' };
}

/**
 * A narrow, explicit-only company-name extraction from bio text: "Founder
 * of X", "Founder @X", "Founder at X" — a specific, low-ambiguity pattern,
 * not a general NLP guess. Used only for the `companyName` text field, never
 * for domain construction.
 */
const COMPANY_MENTION =
  /\b(?:founder|co-founder|ceo|owner)\s+(?:of|at)\s+([A-Z][A-Za-z0-9&'.\- ]{1,40}?)(?:[.!?,\n]|$)|\b(?:founder|co-founder|ceo|owner)\s*@\s*([A-Za-z0-9_]{2,40})/i;

export function resolveCompanyNameFromBio(bio: string | undefined | null): CompanyNameResolution {
  const text = bio ?? '';
  const match = text.match(COMPANY_MENTION);
  const name = match ? (match[1] ?? match[2])?.trim() : undefined;
  if (name) {
    return { companyName: name, source: 'bio_mention' };
  }
  return { companyName: null, source: 'unresolved' };
}
