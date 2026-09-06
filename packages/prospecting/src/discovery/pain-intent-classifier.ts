/**
 * Pain/intent tweet classification (BUILD_PLAN.md Stage 4B). Maps a tweet's
 * text to DATABASE.md's own `pain_signals.topic` enum — reusing that exact,
 * already-finalized vocabulary rather than inventing new categories. A match
 * here is a raw discovery observation, feeding the existing `pain_signals`
 * table (personalization input) — it is never itself ICP scoring evidence
 * (ARCHITECTURE.md/ICP §16: "no signal, no 'why now' claim"; a keyword match
 * is not proof of anything about revenue, spend, or DTC status).
 */

export const PAIN_SIGNAL_TOPICS = [
  'CAC',
  'ROAS',
  'MER',
  'attribution',
  'budget_allocation',
  'channel_performance',
  'profitability',
] as const;
export type PainSignalTopic = (typeof PAIN_SIGNAL_TOPICS)[number];

export interface PainIntentClassification {
  matched: boolean;
  topic: PainSignalTopic | null;
  matchedPhrase: string | null;
}

const TOPIC_PATTERNS: Array<{ topic: PainSignalTopic; pattern: RegExp }> = [
  { topic: 'CAC', pattern: /\bCAC\b|\bcustomer acquisition cost\b/i },
  { topic: 'ROAS', pattern: /\bROAS\b|\breturn on ad spend\b/i },
  { topic: 'MER', pattern: /\bMER\b|\bmarketing efficiency ratio\b/i },
  { topic: 'attribution', pattern: /\battribution\b/i },
  { topic: 'budget_allocation', pattern: /\bbudget allocation\b|\ballocat\w* (?:our|my|the) (?:ad )?budget\b/i },
  { topic: 'channel_performance', pattern: /\bchannel performance\b/i },
  { topic: 'profitability', pattern: /\bprofitability\b/i },
];

export function classifyPainIntent(tweetText: string | undefined | null): PainIntentClassification {
  const text = tweetText ?? '';
  for (const { topic, pattern } of TOPIC_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return { matched: true, topic, matchedPhrase: match[0] };
    }
  }
  return { matched: false, topic: null, matchedPhrase: null };
}
