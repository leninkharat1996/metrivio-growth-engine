import { writeAuditLog, type MetrivioDb, type JobHandler, type JobHandlerContext, type JobHandlerResult } from '@metrivio/core';
import { TrackedAccountStore } from '../accounts/tracked-account-store.js';
import { TrackedAccountResearchService } from '../accounts/tracked-account-research-service.js';
import { PersonalBrandAnalysisService } from '../personal-brand/personal-brand-analysis-service.js';
import { ANALYZE_EXPERT_CONTENT_JOB_TYPE } from './job-types.js';

/**
 * Stage 7, Section Z/I/Q — `ANALYZE_EXPERT_CONTENT`. Runs
 * `TrackedAccountResearchService.researchAccount()` across every tracked,
 * active expert account, then (only when new signals were actually
 * captured) re-runs `PersonalBrandAnalysisService.analyzeAndRecordTechniques()`
 * so the growth-technique library reflects the freshest data — pairing
 * these two steps in one job avoids a separate, easy-to-forget follow-up
 * job for what is really one logical "refresh expert intelligence" unit
 * of work.
 */
export class AnalyzeExpertContentHandler implements JobHandler {
  readonly jobType = ANALYZE_EXPERT_CONTENT_JOB_TYPE;

  constructor(
    private readonly db: MetrivioDb,
    private readonly accounts: TrackedAccountStore,
    private readonly research: TrackedAccountResearchService,
    private readonly personalBrand: PersonalBrandAnalysisService
  ) {}

  async run(ctx: JobHandlerContext): Promise<JobHandlerResult> {
    const experts = (await this.accounts.listByType('expert')).slice(0, ctx.maxItems);
    let succeeded = 0;
    let failed = 0;
    let signalsCreated = 0;

    for (const account of experts) {
      try {
        const signals = await this.research.researchAccount(account.id);
        signalsCreated += signals.length;
        succeeded += 1;
      } catch (err) {
        failed += 1;
        await writeAuditLog(this.db, {
          actor: 'system',
          actionType: 'automation.expert_analysis.failed',
          entityType: 'content_tracked_account',
          entityId: account.id,
          dryRun: ctx.dryRun,
          detail: { runId: ctx.runId, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    let techniquesRecorded = 0;
    if (signalsCreated > 0) {
      const techniques = await this.personalBrand.analyzeAndRecordTechniques();
      techniquesRecorded = techniques.length;
    }

    return { itemsProcessed: experts.length, itemsSucceeded: succeeded, itemsFailed: failed, detail: { signalsCreated, techniquesRecorded } };
  }
}
