/**
 * Minimal robots.txt parser for Stage 5's "respect robots.txt where
 * practical" requirement. Deliberately not spec-complete (no wildcard/`$`
 * path matching, no crawl-delay, no sitemap parsing) — just enough to
 * honor a `User-agent: *` block's `Disallow` prefixes, which covers the
 * overwhelming majority of real-world robots.txt files and is what
 * "practical" calls for at this stage's scope (a handful of fixed page
 * paths per domain, not a crawler).
 */

export interface RobotsRules {
  disallow: string[];
}

/** Parses only the `User-agent: *` group (the group every anonymous fetcher falls under, since this adapter never sends an identifying User-Agent tied to a specific bot name). */
export function parseRobotsTxt(body: string): RobotsRules {
  const lines = body.split(/\r?\n/);
  const disallow: string[] = [];
  let inWildcardGroup = false;
  let sawAnyUserAgentLine = false;

  for (const rawLine of lines) {
    const line = (rawLine.split('#')[0] ?? '').trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(':');
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();

    if (key === 'user-agent') {
      if (sawAnyUserAgentLine && inWildcardGroup) {
        // A new user-agent line after we were already in a matched group,
        // without an intervening blank-separated record, ends that group —
        // conservative: stop applying disallow rules from a group we've left.
      }
      inWildcardGroup = value === '*';
      sawAnyUserAgentLine = true;
      continue;
    }

    if (key === 'disallow' && inWildcardGroup) {
      if (value) disallow.push(value);
    }
  }

  return { disallow };
}

export function isPathDisallowed(rules: RobotsRules, path: string): boolean {
  return rules.disallow.some((prefix) => prefix !== '' && path.startsWith(prefix));
}
