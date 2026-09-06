/**
 * Stage 7 pain taxonomy (Section C). Reuses the EXACT categories
 * `pain_signals.topic` already defines (DATABASE.md, Stage 3/4) as the
 * verified starting vocabulary — per instruction, "inspect existing
 * DATABASE.md / ICP documentation and use repository evidence as the
 * source of truth" rather than inventing a large, ungrounded category
 * list. This taxonomy is intentionally its OWN type, independent of the
 * `pain_signals` table column (which serves outreach personalization
 * specifically) — content-intelligence signals are a different table
 * (`content_signals`) with a different purpose, so widening `pain_signals`'
 * own DB-column type was avoided entirely (zero risk to Stage 3/4C).
 *
 * `'other'` is always a safe fallback — never omit a signal for lack of a
 * matching category. New categories can be added to this array later
 * without any migration, since `content_signals.pain_category` is a plain
 * text column (Section C: "allow new categories to be added later").
 */
export const PAIN_TAXONOMY_CATEGORIES = [
  'CAC',
  'ROAS',
  'MER',
  'attribution',
  'budget_allocation',
  'channel_performance',
  'profitability',
  'other',
] as const;
export type PainTaxonomyCategory = (typeof PAIN_TAXONOMY_CATEGORIES)[number];

export function isPainTaxonomyCategory(value: unknown): value is PainTaxonomyCategory {
  return typeof value === 'string' && (PAIN_TAXONOMY_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Deterministic, keyword-based classification — NOT an LLM (Section AF: the
 * foundation must work without one). Every keyword list below is a direct,
 * literal vocabulary match to the category name itself and its closest
 * synonyms already used in this repository's own docs (ICP §22's own
 * terminology) — never an invented, unverified synonym list. Returns
 * `'other'` rather than guessing when no category's keywords appear, since
 * an ungrounded classification would be worse than an honest fallback.
 *
 * Multiple categories can match the same text; the first match in
 * `PAIN_TAXONOMY_CATEGORIES`'s own declared order wins, making the result
 * deterministic and independent of object-key iteration order.
 */
const KEYWORDS: Record<Exclude<PainTaxonomyCategory, 'other'>, readonly string[]> = {
  CAC: ['cac', 'customer acquisition cost', 'cost per acquisition', 'cpa'],
  ROAS: ['roas', 'return on ad spend'],
  MER: ['mer', 'marketing efficiency ratio'],
  attribution: ['attribution', 'multi-touch', 'last-click', 'last click', 'incrementality'],
  budget_allocation: ['budget allocation', 'channel mix', 'spend allocation', 'where to spend'],
  channel_performance: ['channel performance', 'meta vs google', 'channel mix performance', 'which channel'],
  profitability: ['profitability', 'contribution margin', 'unit economics', 'margin'],
};

export function classifyPainCategory(text: string): PainTaxonomyCategory {
  const lower = text.toLowerCase();
  for (const category of PAIN_TAXONOMY_CATEGORIES) {
    if (category === 'other') continue;
    if (KEYWORDS[category].some((kw) => lower.includes(kw))) {
      return category;
    }
  }
  return 'other';
}
