/**
 * Deterministic, no-LLM classifiers over a single fetched website page's
 * visible text (BUILD_PLAN.md Stage 5, rules A/B/E). Every classifier here
 * follows the same conventions as the Stage 4B classifiers
 * (`founder-classifier.ts`, `paid-media-job-posting.ts`): whole-
 * word/phrase regex matches only (never a bare substring), a `reason`
 * field for auditability, and — for the categories this stage was most
 * heavily warned about (triggers, DTC-adjacent claims) — an explicit
 * negative-guard step checked before any positive match is accepted.
 *
 * None of these functions perform any I/O; they take already-fetched page
 * text and return a classification. Fetching, page selection, and
 * persistence are `WebsiteEvidenceService`'s job.
 */

export interface TextMatchResult {
  matched: boolean;
  matchedPhrase: string | null;
  reason: string;
}

export interface EmployeeCountMatchResult extends TextMatchResult {
  employeeCount: number | null;
}

// ---------------------------------------------------------------------------
// A. Revenue-Fit signal categories 1 and 3 (employee count band, warehouse/
//    fulfillment). Signal 2 (Shopify Plus) stays technology-detection-only
//    (unchanged, Stage 2) and signal 4 (2+ paid-acquisition categories) is
//    derived, not observed directly — neither belongs here.
// ---------------------------------------------------------------------------

/** ICP §22.A signal 1: employee count "via LinkedIn company page or equivalent" falls within roughly 5-75. A company's own About/Team page stating its own headcount is exactly such an "equivalent" first-party source. */
const EMPLOYEE_COUNT_MIN = 5;
const EMPLOYEE_COUNT_MAX = 75;

const EMPLOYEE_COUNT_PATTERNS = [
  /\bteam of\s+(\d{1,4})\s+(?:people|employees|team members)\b/i,
  /\b(\d{1,4})\s*[-+]?\s*person team\b/i,
  /\b(\d{1,4})\s+(?:employees|team members|full[- ]time employees)\b/i,
  /\b(\d{1,4})\s+people\s+(?:on our team|strong|and growing)\b/i,
];

export function classifyEmployeeCountBand(pageText: string | undefined | null): EmployeeCountMatchResult {
  const text = pageText ?? '';
  for (const pattern of EMPLOYEE_COUNT_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const count = Number.parseInt(match[1], 10);
      if (!Number.isFinite(count)) continue;
      if (count >= EMPLOYEE_COUNT_MIN && count <= EMPLOYEE_COUNT_MAX) {
        return { matched: true, matchedPhrase: match[0], employeeCount: count, reason: `stated headcount ${count} falls within the ${EMPLOYEE_COUNT_MIN}-${EMPLOYEE_COUNT_MAX} band` };
      }
      return { matched: false, matchedPhrase: match[0], employeeCount: count, reason: `stated headcount ${count} is outside the ${EMPLOYEE_COUNT_MIN}-${EMPLOYEE_COUNT_MAX} band` };
    }
  }
  return { matched: false, matchedPhrase: null, employeeCount: null, reason: 'no explicit headcount statement found' };
}

// Facilities descriptions AND job postings both count per ICP §22.A signal
// 3 ("Warehouse/fulfillment job postings or public references indicating
// physical operations at meaningful scale") — deliberately not restricted
// to job-posting phrasing only.
const WAREHOUSE_FULFILLMENT = /\b(warehouse (?:associate|team|operations|facility|staff)|fulfillment (?:center|centre|team|facility|associate|specialist)|distribution center|distribution centre|our (?:own )?fulfillment (?:center|centre|operation))\b/i;

export function classifyWarehouseFulfillmentSignal(pageText: string | undefined | null): TextMatchResult {
  const text = pageText ?? '';
  const match = text.match(WAREHOUSE_FULFILLMENT);
  if (match) {
    return { matched: true, matchedPhrase: match[0], reason: 'warehouse/fulfillment operations language found' };
  }
  return { matched: false, matchedPhrase: null, reason: 'no warehouse/fulfillment language found' };
}

// ICP §22.A: "The Skill must never state a specific revenue figure ...
// unless CONFIRMED tier is met via a primary source" — a company's own
// website stating its own revenue figure is exactly such a primary source.
// Deliberately excludes funding/investment figures (a raise is not
// revenue) via an explicit negative-context guard checked before accepting
// a match — the single highest-risk false positive for this category.
const REVENUE_STATEMENT = /\$[\d][\d,.]*\s?(?:million|thousand|k|m|mm)?\s+(?:in\s+)?(?:annual\s+)?(?:revenue|sales|in sales|top[- ]line)\b/i;
const FUNDING_CONTEXT_NEARBY = /\b(raised|funding round|series [a-z]|seed round|investment|valuation|secured \$|closed (?:a|our) round)\b/i;

export function classifyConfirmedRevenueStatement(pageText: string | undefined | null): TextMatchResult {
  const text = pageText ?? '';
  const match = text.match(REVENUE_STATEMENT);
  if (!match || match.index === undefined) {
    return { matched: false, matchedPhrase: null, reason: 'no explicit revenue-figure statement found' };
  }
  const windowStart = Math.max(0, match.index - 60);
  const nearby = text.slice(windowStart, match.index + match[0].length);
  if (FUNDING_CONTEXT_NEARBY.test(nearby)) {
    return { matched: false, matchedPhrase: match[0], reason: 'a dollar figure with "revenue"/"sales" wording was found, but funding/investment language nearby means this is a raise amount, not a revenue statement' };
  }
  return { matched: true, matchedPhrase: match[0], reason: 'explicit first-party revenue figure found, with no funding/investment context nearby' };
}

// ---------------------------------------------------------------------------
// B. Decision-maker verification (public visibility, correct profile
//    identified)
// ---------------------------------------------------------------------------

const QUOTE_ATTRIBUTION = /\b(said|says|told|explains|explained|noted|shared|according to)\b/i;

/**
 * ICP §22.B: "Public visibility: decision-maker has visible public
 * activity (LinkedIn posts, press quotes) about the business." A press
 * page quoting the named decision-maker, with an attribution verb nearby,
 * is exactly a "press quote." Requires a full "First Last" name — a
 * single-word name is rejected up front to avoid matching a common word
 * that happens to equal someone's first name.
 */
export function classifyPublicVisibilityPressQuote(
  pageText: string | undefined | null,
  decisionMakerDisplayName: string | undefined | null
): TextMatchResult {
  const text = pageText ?? '';
  const name = (decisionMakerDisplayName ?? '').trim();
  if (!/^[A-Za-z][A-Za-z'.-]*\s+[A-Za-z][A-Za-z'.-]*/.test(name)) {
    return { matched: false, matchedPhrase: null, reason: 'no full name available for the decision-maker (a single word or empty name is never used to search for a quote)' };
  }
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameIndex = text.search(new RegExp(`\\b${escapedName}\\b`, 'i'));
  if (nameIndex === -1) {
    return { matched: false, matchedPhrase: null, reason: `decision-maker name "${name}" not found on this page` };
  }
  const windowEnd = Math.min(text.length, nameIndex + name.length + 200);
  const windowStart = Math.max(0, nameIndex - 200);
  const nearby = text.slice(windowStart, windowEnd);
  const hasQuoteMark = /["“”]/.test(nearby);
  const hasAttribution = QUOTE_ATTRIBUTION.test(nearby);
  if (hasQuoteMark && hasAttribution) {
    return { matched: true, matchedPhrase: name, reason: `"${name}" found near a quotation mark and an attribution verb (press-quote pattern)` };
  }
  return { matched: false, matchedPhrase: null, reason: `"${name}" found on this page, but no nearby quotation mark + attribution verb — name mentions alone do not qualify` };
}

/** Normalizes an X handle or profile URL to a bare, lowercase, `@`-free username for comparison. */
export function normalizeXHandle(value: string | undefined | null): string | null {
  if (!value) return null;
  let v = value.trim();
  const urlMatch = v.match(/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})\b/i);
  if (urlMatch?.[1]) {
    v = urlMatch[1];
  } else {
    v = v.replace(/^@/, '');
  }
  v = v.trim().toLowerCase();
  return v.length > 0 ? v : null;
}

/**
 * ICP §22.B: "Correct target decision-maker ... profile identified (name,
 * current role, and current employer at the target company all
 * confirmed)." The company's own website linking to this exact X account
 * (already captured, zero-fetch, from Stage 2's OpenTechAnalyzer
 * enrichment — see `mineCorrectProfileIdentifiedFromEnrichment` in
 * `enrichment-mining.ts`) confirms "current employer at the target
 * company" from a first-party source; name/role are already established by
 * Stage 4B's own bio-based classification. Kept here as the pure
 * comparison function; enrichment-mining.ts owns reading/parsing the scan.
 */
export function isMatchingXHandle(a: string | undefined | null, b: string | undefined | null): boolean {
  const na = normalizeXHandle(a);
  const nb = normalizeXHandle(b);
  return na !== null && nb !== null && na === nb;
}

// ---------------------------------------------------------------------------
// E. Trigger evidence from press/news pages. Heavily conservative by
//    instruction: only discrete, already-happened events qualify — never a
//    steady-state/capability claim ("we ship nationwide"), and
//    `new_paid_channel_appearing` is deliberately NOT implemented here (see
//    RISK_REGISTER.md Stage 5 section — the required prior-dated-absence
//    half cannot be established from a single page fetch, and more/better
//    press-page text would never fix that; it is a structural mismatch, not
//    a coverage gap).
// ---------------------------------------------------------------------------

export interface TriggerMatchResult extends TextMatchResult {
  triggerType: 'new_product_launch' | 'store_brand_expansion' | 'funding_growth_announcement' | 'funnel_offer_change' | null;
}

const CURRENT_STATE_DISQUALIFIER = /\b(coming soon|stay tuned|we plan to|we will soon|in the future)\b/i;

const TRIGGER_PATTERNS: Array<{ triggerType: TriggerMatchResult['triggerType']; pattern: RegExp }> = [
  {
    triggerType: 'new_product_launch',
    pattern: /\b(?:we(?:'ve| have)?\s+)?(?:just |recently |proudly )?launched (?:our|its|their|a) new\b|\bintroducing (?:our|the) (?:all[- ]new|new)\b|\b(?:has|have) launched (?:its|their|our) new\b/i,
  },
  {
    triggerType: 'store_brand_expansion',
    pattern: /\bnow (?:available|shipping|open) in\b|\bexpand(?:ed|ing) (?:into|to) [a-z]/i,
  },
  {
    triggerType: 'funding_growth_announcement',
    pattern: /\braised \$[\d][\d,.]*\s?(?:million|thousand|k|m|mm)?\b|\bclosed (?:a|our) (?:series [a-z]|seed) round\b|\bsecured \$[\d][\d,.]*\s?(?:million|thousand|k|m|mm)? in funding\b/i,
  },
  {
    triggerType: 'funnel_offer_change',
    pattern: /\bintroducing (?:our new|a new) (?:pricing|offer|promotion)\b|\bnew pricing (?:plans?|structure) (?:is|are) now live\b/i,
  },
];

/** Runs every trigger pattern against one page's text, returning every type that matched (a page can plausibly carry more than one). */
export function classifyPressAnnouncementTriggers(pageText: string | undefined | null): TriggerMatchResult[] {
  const text = pageText ?? '';
  const results: TriggerMatchResult[] = [];
  for (const { triggerType, pattern } of TRIGGER_PATTERNS) {
    const match = text.match(pattern);
    if (!match || match.index === undefined) continue;
    const windowStart = Math.max(0, match.index - 40);
    const windowEnd = Math.min(text.length, match.index + match[0].length + 40);
    const nearby = text.slice(windowStart, windowEnd);
    if (CURRENT_STATE_DISQUALIFIER.test(nearby)) {
      results.push({
        matched: false,
        matchedPhrase: match[0],
        triggerType: null,
        reason: `matched ${triggerType} language, but "coming soon"/future-tense wording nearby means this is not yet a completed event`,
      });
      continue;
    }
    results.push({
      matched: true,
      matchedPhrase: match[0],
      triggerType,
      reason: `discrete ${triggerType} announcement language found, no future-tense/current-state disqualifier nearby`,
    });
  }
  return results.filter((r) => r.matched);
}
