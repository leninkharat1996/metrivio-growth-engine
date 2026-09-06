import { asc, isNotNull } from 'drizzle-orm';
import { schema, type MetrivioDb } from '@metrivio/core';

/**
 * Bounded, deterministic candidate enumeration for ICP content research —
 * reuses `prospects` exactly as Section A requires (no second discovery
 * pass). A candidate is any prospect with a known X username who is not in
 * a terminal stopped/opted-out state — mirrors the same
 * `TERMINAL_STOPPED_STATUSES` judgment already used in
 * `packages/outreach/src/follow-up/reply-detection-service.ts`, applied
 * here only to decide "is this a safe/sensible account to research,"
 * never to gate an outreach action (this package never sends anything).
 */
const TERMINAL_STOPPED_STATUSES = new Set(['stopped_opted_out', 'stopped_not_interested', 'stopped_disqualified', 'stopped_manual']);

export async function findIcpResearchCandidates(db: MetrivioDb, maxCandidates: number): Promise<string[]> {
  const rows = await db
    .select({ id: schema.prospects.id, outreachStatus: schema.prospects.outreachStatus })
    .from(schema.prospects)
    .where(isNotNull(schema.prospects.xUsername))
    .orderBy(asc(schema.prospects.id));

  const candidates: string[] = [];
  for (const row of rows) {
    if (TERMINAL_STOPPED_STATUSES.has(row.outreachStatus)) continue;
    candidates.push(row.id);
    if (candidates.length >= maxCandidates) break;
  }
  return candidates;
}
