/**
 * Paid-media job-posting detection (ICP §22.A Paid Acquisition signal 3:
 * "a paid-media-specific job posting ... posted within the last 90 days").
 * Deliberately the ONLY paid-acquisition-evidence path Stage 4B implements —
 * every other paid-acquisition signal category (Meta Ad Library activity,
 * Google Ads visibility, named agency client) requires a source this stage
 * has no adapter for. Generic "we're hiring" tweets, or hiring for
 * non-paid-media roles, must never match (instruction #12 — this is the one
 * place a false positive would most directly corrupt Stage 3 scoring
 * evidence).
 */

export interface JobPostingClassification {
  qualifies: boolean;
  matchedPhrase: string | null;
  /** Human-readable reason, populated whether or not it qualifies (including "why not"), for auditability. */
  reason: string;
  /** True when the tweet is older than 90 days as of `now` — disqualifying regardless of title match. */
  withinNinetyDays: boolean | null;
}

// Deliberately narrow: only the exact paid-media titles ICP §22.A names
// (media buyer, growth marketer, paid social specialist) plus the one
// closely-synonymous "performance marketer" term already used elsewhere in
// this codebase's own classifier vocabulary — not a broad "marketing" net.
const PAID_MEDIA_TITLE = /\b(media buyer|growth marketer|paid social specialist|performance marketer|paid media (?:manager|specialist))\b/i;
const HIRING_LANGUAGE = /\b(hiring|we'?re looking for|join our team|now hiring|open role|job opening|apply now)\b/i;

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export function classifyPaidMediaJobPosting(
  tweetText: string | undefined | null,
  tweetCreatedAt: string | undefined | null,
  now: Date = new Date()
): JobPostingClassification {
  const text = tweetText ?? '';
  const titleMatch = text.match(PAID_MEDIA_TITLE);
  const hasHiringLanguage = HIRING_LANGUAGE.test(text);

  let withinNinetyDays: boolean | null = null;
  if (tweetCreatedAt) {
    const createdMs = Date.parse(tweetCreatedAt);
    if (!Number.isNaN(createdMs)) {
      withinNinetyDays = now.getTime() - createdMs <= NINETY_DAYS_MS && createdMs <= now.getTime();
    }
  }

  if (!titleMatch) {
    return {
      qualifies: false,
      matchedPhrase: null,
      reason: 'no paid-media-specific job title matched (a generic hiring tweet does not qualify)',
      withinNinetyDays,
    };
  }
  if (!hasHiringLanguage) {
    return {
      qualifies: false,
      matchedPhrase: titleMatch[0],
      reason: 'paid-media title mentioned, but no explicit hiring language found',
      withinNinetyDays,
    };
  }
  if (withinNinetyDays === null) {
    return {
      qualifies: false,
      matchedPhrase: titleMatch[0],
      reason: 'tweet date unavailable — cannot verify the required 90-day window',
      withinNinetyDays,
    };
  }
  if (!withinNinetyDays) {
    return {
      qualifies: false,
      matchedPhrase: titleMatch[0],
      reason: 'matched job language, but the tweet is older than 90 days',
      withinNinetyDays,
    };
  }

  return {
    qualifies: true,
    matchedPhrase: titleMatch[0],
    reason: 'paid-media job title + explicit hiring language + within 90 days',
    withinNinetyDays: true,
  };
}
