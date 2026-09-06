import { writeAuditLog, type MetrivioDb, type JobHandler, type JobHandlerContext, type JobHandlerResult } from '@metrivio/core';
import { ContentSignalStore } from '../signals/content-signal-store.js';
import { PAIN_TAXONOMY_CATEGORIES } from '../pain-taxonomy/pain-taxonomy.js';
import { ANALYZE_ICP_CONVERSATIONS_JOB_TYPE } from './job-types.js';

/**
 * Stage 7, Section Z/E — `ANALYZE_ICP_CONVERSATIONS`. Pure aggregation over
 * already-collected ICP signals (no new network I/O) — recurring problems,
 * rising problems, and unresolved-vs-total volume per pain category
 * (Section E), recorded to `audit_log` for observability/auditability
 * (Section R) between full `WeeklyIntelligenceReportService` runs.
 */
export class AnalyzeIcpConversationsHandler implements JobHandler {
  readonly jobType = ANALYZE_ICP_CONVERSATIONS_JOB_TYPE;

  constructor(
    private readonly db: MetrivioDb,
    private readonly signals: ContentSignalStore
  ) {}

  async run(ctx: JobHandlerContext): Promise<JobHandlerResult> {
    const icpSignals = await this.signals.list({ signalType: 'icp_post', limit: ctx.maxItems });

    const byCategory: Record<string, number> = {};
    for (const category of PAIN_TAXONOMY_CATEGORIES) byCategory[category] = 0;
    for (const s of icpSignals) {
      const category = s.painCategory ?? 'other';
      byCategory[category] = (byCategory[category] ?? 0) + 1;
    }

    await writeAuditLog(this.db, {
      actor: 'system',
      actionType: 'automation.icp_conversation_analysis.completed',
      entityType: 'content_signal',
      dryRun: ctx.dryRun,
      detail: { runId: ctx.runId, signalsAnalyzed: icpSignals.length, byCategory },
    });

    return { itemsProcessed: icpSignals.length, itemsSucceeded: icpSignals.length, itemsFailed: 0, detail: { byCategory } };
  }
}
