import { and, desc, eq } from 'drizzle-orm';
import { schema, type MetrivioDb, type TechAnalyzerResult } from '@metrivio/core';
import { isMatchingXHandle } from './classifiers.js';

/**
 * Mines the domain's most recent successful `technology_scans.raw_response`
 * (Stage 2's already-fetched OpenTechAnalyzer enrichment — `enrichment.
 * social`) for the prospect's own X handle, with zero new network I/O. This
 * is the highest-value, lowest-risk item in Stage 5's plan: the data is
 * already sitting in the database from a scan that ran for an entirely
 * different reason (technology fingerprinting), and nothing before this
 * stage ever read `.enrichment` back out of it.
 *
 * Result: ICP §22.B's "correct target decision-maker profile identified"
 * sub-item, specifically its "current employer at the target company"
 * half — confirmed here by a first-party source (the company's own website
 * linking to this exact X account) rather than assumed from the bio alone.
 */
export interface CorrectProfileMatch {
  matched: boolean;
  /** The exact X handle/URL string found in the scan's enrichment.social.x array, when matched is true. */
  matchedValue: string | null;
  /** The technology_scans row the enrichment came from, for provenance (sourceUrl). */
  scanId: string | null;
  reason: string;
}

export async function mineCorrectProfileIdentifiedFromEnrichment(
  db: MetrivioDb,
  companyDomain: string,
  prospectXUsername: string
): Promise<CorrectProfileMatch> {
  const scans = await db
    .select()
    .from(schema.technologyScans)
    .where(and(eq(schema.technologyScans.companyDomain, companyDomain), eq(schema.technologyScans.scanStatus, 'OK')))
    .orderBy(desc(schema.technologyScans.scannedAt))
    .limit(1);

  const scan = scans[0];
  if (!scan || !scan.rawResponse) {
    return { matched: false, matchedValue: null, scanId: null, reason: 'no successful technology scan (with a raw response) exists for this domain yet' };
  }

  let parsed: TechAnalyzerResult;
  try {
    parsed = JSON.parse(scan.rawResponse) as TechAnalyzerResult;
  } catch {
    return { matched: false, matchedValue: null, scanId: scan.id, reason: 'the scan\'s raw_response could not be parsed as JSON' };
  }

  const social = parsed.enrichment?.social as Record<string, unknown> | undefined;
  const xHandles = social?.x;
  if (!Array.isArray(xHandles) || xHandles.length === 0) {
    return { matched: false, matchedValue: null, scanId: scan.id, reason: 'the scan\'s enrichment carried no social.x entries' };
  }

  for (const entry of xHandles) {
    if (typeof entry === 'string' && isMatchingXHandle(entry, prospectXUsername)) {
      return { matched: true, matchedValue: entry, scanId: scan.id, reason: `the company's own website (per the existing technology scan) links to @${prospectXUsername}` };
    }
  }

  return { matched: false, matchedValue: null, scanId: scan.id, reason: `the scan's enrichment listed ${xHandles.length} X handle(s), none matching @${prospectXUsername}` };
}
