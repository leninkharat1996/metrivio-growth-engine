import type { PainTaxonomyCategory } from '../pain-taxonomy/pain-taxonomy.js';

/**
 * Deterministic per-category opportunity framing — NOT an LLM (Section AF).
 * Every hook/angle below is a category-level framing pattern, never a
 * claim about Metrivio's own results (no case studies exist — Section N).
 *
 * Pillar naming: DATABASE.md/ARCHITECTURE.md both reference "one of the 15
 * content pillars from the brief," but no such 15-item list exists
 * anywhere in this repository's docs (confirmed by search across
 * `docs/*.md`) — inventing one would not be "using repository evidence as
 * the source of truth" (Section C's own instruction). Until that list is
 * authored, this module uses the pain-taxonomy category itself as the
 * pillar value — grounded in verified repository vocabulary rather than a
 * fabricated pillar taxonomy. Flagged in RISK_REGISTER.md as a documented
 * gap, not a silent substitution.
 */
export interface OpportunityTemplate {
  hook: string;
  angle: string;
  whyItMatters: string;
  recommendedFormat: 'short_post' | 'thread' | 'framework' | 'checklist' | 'teardown' | 'diagnostic_question' | 'myth' | 'analysis';
}

const TEMPLATES: Record<Exclude<PainTaxonomyCategory, 'other'>, OpportunityTemplate> = {
  CAC: {
    hook: 'Why your CAC keeps climbing even when every campaign "works"',
    angle: 'diagnostic framework',
    whyItMatters: 'CAC is one of the most frequently discussed pain points among DTC founders — a clear diagnostic angle builds authority without needing a client result to cite.',
    recommendedFormat: 'framework',
  },
  ROAS: {
    hook: 'Why ROAS can look better while your business gets worse',
    angle: 'contrarian but defensible',
    whyItMatters: 'ROAS is widely used but often misread — a teardown of why the number can mislead is squarely in Metrivio’s marketing-efficiency positioning.',
    recommendedFormat: 'myth',
  },
  MER: {
    hook: 'MER vs. ROAS: the metric most DTC founders are not tracking',
    angle: 'comparative analysis',
    whyItMatters: 'MER captures whole-business efficiency in a way channel-level ROAS cannot — a natural fit for Metrivio’s diagnostic positioning.',
    recommendedFormat: 'analysis',
  },
  attribution: {
    hook: 'The attribution problem most DTC brands have quietly given up on solving',
    angle: 'industry teardown',
    whyItMatters: 'Attribution frustration is a recurring, unresolved theme in ICP conversations — a credible, non-hyped explainer differentiates from vendors selling a "fix."',
    recommendedFormat: 'teardown',
  },
  budget_allocation: {
    hook: 'How to actually decide where next month’s marketing budget goes',
    angle: 'practical operator checklist',
    whyItMatters: 'Budget-allocation decisions are a recurring, concrete question ICP founders ask publicly — a checklist format matches how the question is actually asked.',
    recommendedFormat: 'checklist',
  },
  channel_performance: {
    hook: 'What your channel performance dashboard is not telling you',
    angle: 'diagnostic question',
    whyItMatters: 'Channel-level performance comparisons are common but often incomplete without a whole-business view — directly aligned with Metrivio’s diagnostic angle.',
    recommendedFormat: 'diagnostic_question',
  },
  profitability: {
    hook: 'The kind of growth that quietly kills your margins',
    angle: 'contrarian but defensible',
    whyItMatters: 'Profitability concerns rising alongside growth is a theme ICP founders raise directly — an area with clear differentiation from competitors who mostly discuss top-line metrics.',
    recommendedFormat: 'myth',
  },
};

export function getOpportunityTemplate(category: Exclude<PainTaxonomyCategory, 'other'>): OpportunityTemplate {
  return TEMPLATES[category];
}
