import type { MetrivioDb } from '@metrivio/core';
import { FollowUpEligibilityService } from '../follow-up/follow-up-eligibility-service.js';
import { findNextSequenceStep } from '../follow-up/sequence-step.js';
import type { FollowUpEligibilityStatus } from '../follow-up/follow-up-eligibility.js';
import { findActiveSequenceCandidates, type DueFollowUpCandidate } from './candidate-discovery.js';

/**
 * Stage 6E, Section H — deterministic due-follow-up discovery, built
 * entirely on top of Stage 6C's `FollowUpEligibilityService` (the sole
 * authority on eligibility/timing — never duplicated here) plus the shared
 * `findNextSequenceStep()` helper (Stage 6D) for the one Stage-6D-local
 * `NO_NEXT_STEP` distinction, exactly mirroring how `FollowUpDraftService`
 * already does this. This class never sends anything and never creates a
 * draft — it only ever answers "is a follow-up due for this candidate, and
 * why."
 *
 * `ERROR` is a status this module adds locally (never part of Stage 6C's
 * own `FollowUpEligibilityStatus` contract) for the one case Stage 6C
 * cannot represent: this orchestration layer's own call to
 * `evaluate()` throwing an unexpected exception (e.g. a DB error), as
 * opposed to `evaluate()` itself legitimately returning `UNKNOWN` for a
 * business reason (failed reply detection, indeterminate state). Keeping
 * these distinct means a bug in this layer is never silently reported as
 * an ordinary business outcome (Section Q).
 */
export type DueFollowUpStatus = FollowUpEligibilityStatus | 'NO_NEXT_STEP' | 'ERROR';

export interface DueFollowUpResult extends DueFollowUpCandidate {
  status: DueFollowUpStatus;
  reason: string;
}

export interface FindDueFollowUpsOptions {
  maxCandidates: number;
  /** Independently bounds how many candidates actually get a (network-touching) reply-detection check — Section P. */
  maxReplyChecks: number;
}

export interface FindDueFollowUpsResult {
  results: DueFollowUpResult[];
  candidatesConsidered: number;
  replyChecksPerformed: number;
}

export class DueWorkDiscoveryService {
  constructor(
    private readonly db: MetrivioDb,
    private readonly eligibilityService: FollowUpEligibilityService
  ) {}

  /** Evaluates exactly one candidate — never throws; a hard failure is reported as `{status: 'ERROR'}`, never as any legitimate eligibility status (Section Q). */
  async evaluateCandidate(candidate: DueFollowUpCandidate): Promise<DueFollowUpResult> {
    try {
      const result = await this.eligibilityService.evaluate(candidate.prospectId, candidate.sequenceId);
      if (result.status === 'UNKNOWN') {
        const lookup = await findNextSequenceStep(this.db, candidate.prospectId, candidate.sequenceId);
        if (lookup.noNextStepDefined) {
          return { ...candidate, status: 'NO_NEXT_STEP', reason: 'no next-step definition exists in this sequence after the most recently sent step' };
        }
      }
      return { ...candidate, status: result.status, reason: result.reason };
    } catch (err) {
      return { ...candidate, status: 'ERROR', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async findDueFollowUps(options: FindDueFollowUpsOptions): Promise<FindDueFollowUpsResult> {
    const candidates = await findActiveSequenceCandidates(this.db, options.maxCandidates);
    const results: DueFollowUpResult[] = [];
    let replyChecksPerformed = 0;

    for (const candidate of candidates) {
      if (replyChecksPerformed >= options.maxReplyChecks) break;
      results.push(await this.evaluateCandidate(candidate));
      replyChecksPerformed += 1;
    }

    return { results, candidatesConsidered: candidates.length, replyChecksPerformed };
  }
}
