import { asc, eq } from 'drizzle-orm';
import { schema, type MetrivioDb } from '@metrivio/core';

/**
 * Stage 6E, Section H — the deterministic "which (prospect, sequence) pairs
 * might have a follow-up due" enumeration. This is deliberately the ONLY
 * place that scans `outreach_messages` to find candidates; every other
 * automation piece in this stage takes a candidate list as input rather
 * than re-deriving it.
 *
 * A candidate is any (prospectId, sequenceId) pair with at least one `sent`
 * `outreach_messages` row — i.e., an engagement that has actually started.
 * Whether a follow-up is actually due, eligible, or blocked is decided
 * entirely by Stage 6C's `FollowUpEligibilityService` — this function makes
 * no eligibility judgment of its own, matching Section H's instruction not
 * to duplicate timing/eligibility logic here.
 *
 * Deterministic ordering (`prospectId` then `sequenceId`, both ascending)
 * means the same database state always yields the same candidate list in
 * the same order — required for bounded runs to behave predictably when
 * `maxCandidates` truncates the result (Section O: no implicit ordering).
 *
 * Known limitation, consistent with this codebase's existing precedent
 * (`OutreachDraftService.listDraftsForProspect`): distinct pairs are
 * computed in application code from a full scan of `sent` rows rather than
 * a SQL DISTINCT, acceptable at this foundation scope and documented rather
 * than worked around.
 */
export interface DueFollowUpCandidate {
  prospectId: string;
  sequenceId: string;
}

export async function findActiveSequenceCandidates(db: MetrivioDb, maxCandidates: number): Promise<DueFollowUpCandidate[]> {
  const sentRows = await db
    .select({ prospectId: schema.outreachMessages.prospectId, sequenceId: schema.outreachMessages.sequenceId })
    .from(schema.outreachMessages)
    .where(eq(schema.outreachMessages.status, 'sent'))
    .orderBy(asc(schema.outreachMessages.prospectId), asc(schema.outreachMessages.sequenceId));

  const seen = new Set<string>();
  const candidates: DueFollowUpCandidate[] = [];
  for (const row of sentRows) {
    const key = `${row.prospectId}::${row.sequenceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ prospectId: row.prospectId, sequenceId: row.sequenceId });
    if (candidates.length >= maxCandidates) break;
  }
  return candidates;
}
