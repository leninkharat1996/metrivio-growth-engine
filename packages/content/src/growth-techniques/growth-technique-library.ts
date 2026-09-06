import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { schema, writeAuditLog, type MetrivioDb } from '@metrivio/core';

/**
 * Stage 7, Section T — a structured library of observed growth
 * techniques. Audit-log-backed (Section AD: no new table — this is a
 * small, low-write-volume catalog, the same "foundation-scope, no live
 * volume yet" reasoning already applied to content-opportunity
 * provenance and own-post performance).
 *
 * `deriveTechniqueStatus()` is the ONLY way a technique's status is set —
 * never a free-form label a caller can arbitrarily pick as "OBSERVED"
 * (Section T: "do not automatically classify a technique as successful
 * without sufficient evidence").
 */
export const GROWTH_TECHNIQUE_STATUSES = ['OBSERVED', 'LIKELY', 'UNVERIFIED'] as const;
export type GrowthTechniqueStatus = (typeof GROWTH_TECHNIQUE_STATUSES)[number];

export const GROWTH_TECHNIQUE_CATEGORIES = [
  'hook',
  'positioning',
  'storytelling',
  'education',
  'contrarian_content',
  'authority',
  'social_proof',
  'cta',
  'content_series',
  'audience_research',
  'engagement',
  'distribution',
  'repurposing',
] as const;
export type GrowthTechniqueCategory = (typeof GROWTH_TECHNIQUE_CATEGORIES)[number];

/** Minimum distinct observations required before a technique can be called `OBSERVED` even with performance data — a single post is never enough evidence. */
const MIN_OBSERVATIONS_FOR_OBSERVED = 3;
const MIN_OBSERVATIONS_FOR_LIKELY = 2;

export function deriveTechniqueStatus(observationCount: number, hasPerformanceData: boolean): GrowthTechniqueStatus {
  if (observationCount >= MIN_OBSERVATIONS_FOR_OBSERVED && hasPerformanceData) return 'OBSERVED';
  if (observationCount >= MIN_OBSERVATIONS_FOR_LIKELY) return 'LIKELY';
  return 'UNVERIFIED';
}

export interface GrowthTechniqueInput {
  technique: string;
  category: GrowthTechniqueCategory;
  /** Description of the evidence backing this entry — never a bare assertion. */
  evidence: string;
  observedPerformance?: string | null;
  applicability: string;
  risk?: string | null;
  status: GrowthTechniqueStatus;
  /** A generic reference to WHERE this was observed (e.g. "tracked expert accounts") — never a named individual's account, keeping this a mechanics library, not a person-tracking one (Section Q: "not which influencer to copy"). */
  exampleReference?: string | null;
}

export interface GrowthTechnique extends GrowthTechniqueInput {
  id: string;
  createdAt: string;
}

const ENTITY_TYPE = 'growth_technique';
const ACTION_TYPE = 'content.growth_technique.recorded';

export class GrowthTechniqueLibrary {
  constructor(private readonly db: MetrivioDb) {}

  async record(input: GrowthTechniqueInput): Promise<GrowthTechnique> {
    const id = uuid();
    const createdAt = new Date().toISOString();
    const technique: GrowthTechnique = { id, createdAt, ...input };
    await writeAuditLog(this.db, {
      actor: 'system',
      actionType: ACTION_TYPE,
      entityType: ENTITY_TYPE,
      entityId: id,
      detail: technique as unknown as Record<string, unknown>,
    });
    return technique;
  }

  async list(filter: { category?: GrowthTechniqueCategory; status?: GrowthTechniqueStatus } = {}): Promise<GrowthTechnique[]> {
    const rows = await this.db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityType, ENTITY_TYPE), eq(schema.auditLog.actionType, ACTION_TYPE)));
    const techniques = rows.map((r) => JSON.parse(r.detail ?? '{}') as GrowthTechnique);
    return techniques.filter((t) => (!filter.category || t.category === filter.category) && (!filter.status || t.status === filter.status));
  }
}
