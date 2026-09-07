import { eq, sql } from 'drizzle-orm';
import { schema, type MetrivioDb } from '@metrivio/core';

/**
 * Stage 9, Section F — ICP-engagement classification, built on the
 * EXISTING `prospects` identity (Stage 4B) rather than a second,
 * independently-inferred identity system. `prospects.source` has carried
 * a `'content_engagement'` value since Stage 4B's own schema, unused until
 * now — this is the first stage that actually reads/writes against it.
 *
 * Deliberately conservative: an engager is only classified as
 * `ICP_ENGAGEMENT` when they match an EXISTING `prospects` row (by X user
 * ID, preferred, or username as a fallback) — a row that already passed
 * Stage 4B's own discovery/classification process (founder/CEO/growth/
 * marketing-role bio evidence, company/domain extraction). A bio-only
 * role guess made fresh at engagement time, with no corroborating
 * `prospects` row, is deliberately NOT treated as confident enough here
 * (Section F: "if identity cannot be confidently established: UNKNOWN...
 * never infer someone's role from a username alone") — even a bio-based
 * inference is one step more than this stage is willing to commit to
 * "confidently established" without the row already existing.
 */
export const ICP_ENGAGEMENT_CLASSIFICATIONS = ['ICP_ENGAGEMENT', 'UNKNOWN'] as const;
export type IcpEngagementClassification = (typeof ICP_ENGAGEMENT_CLASSIFICATIONS)[number];

export interface EngagerIdentity {
  username: string;
  userId?: string | null;
}

export interface IcpEngagementResult {
  classification: IcpEngagementClassification;
  matchedProspectId?: string;
  roleTitle?: string | null;
  companyName?: string | null;
}

export class IcpEngagementClassifier {
  constructor(private readonly db: MetrivioDb) {}

  async classifyEngager(engager: EngagerIdentity): Promise<IcpEngagementResult> {
    if (engager.userId) {
      const byId = await this.db.select().from(schema.prospects).where(eq(schema.prospects.xUserId, engager.userId)).limit(1);
      if (byId[0]) return this.toResult(byId[0]);
    }

    const usernameLower = engager.username.trim().toLowerCase();
    if (usernameLower.length === 0) return { classification: 'UNKNOWN' };

    const byUsername = await this.db
      .select()
      .from(schema.prospects)
      .where(sql`lower(${schema.prospects.xUsername}) = ${usernameLower}`)
      .limit(1);
    if (byUsername[0]) return this.toResult(byUsername[0]);

    return { classification: 'UNKNOWN' };
  }

  private toResult(row: typeof schema.prospects.$inferSelect): IcpEngagementResult {
    return {
      classification: 'ICP_ENGAGEMENT',
      matchedProspectId: row.id,
      roleTitle: row.roleTitle,
      companyName: row.companyName,
    };
  }
}
