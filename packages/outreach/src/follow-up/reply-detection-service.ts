import { desc, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import {
  JobRunner,
  KillSwitch,
  SystemConfigService,
  schema,
  writeAuditLog,
  type MetrivioDb,
  type XReplyDetectorAdapter,
  type createLogger,
} from '@metrivio/core';
import { classifyMessageDirection } from './reply-direction.js';
import { classifyOptOutIntent } from './opt-out-classifier.js';
import { deriveReplyState, type ReplyState } from './reply-state.js';

/**
 * Read-only reply detection (Stage 6C, Sections A/C/D/E/I/J/K/M). Never
 * calls `XSendAdapter` and never writes anything beyond
 * `conversations`/`conversation_messages`/`audit_log` — no follow-up is
 * ever sent, scheduled, or queued from this class.
 *
 * Conversation mapping (Section C): the X-native conversation ID is
 * resolved dynamically by `XReplyDetectorAdapter` on every call (via the
 * verified `getInbox()` participant match) rather than persisted anywhere
 * — DATABASE.md's `conversations` table has no `x_conversation_id` column,
 * and none was added; see RISK_REGISTER.md's Stage 6C section for why this
 * is a deliberate design choice, not a schema gap.
 */

const TERMINAL_STOPPED_STATUSES = new Set([
  'stopped_opted_out',
  'stopped_not_interested',
  'stopped_disqualified',
  'stopped_manual',
]);

export interface ReplyDetectionResult {
  prospectId: string;
  conversationId: string | null;
  replyState: ReplyState;
  /** Count of new inbound messages recorded to `conversation_messages` this run — 0 on every re-run against unchanged data (Section I idempotency). */
  newMessagesFound: number;
  detectionSucceeded: boolean;
  reason: string;
}

export const REPLY_DETECTION_BATCH_JOB_TYPE = 'reply_detection_batch';

export class ReplyDetectionService {
  private readonly killSwitch: KillSwitch;
  private readonly config: SystemConfigService;
  private readonly jobRunner: JobRunner;

  constructor(
    private readonly db: MetrivioDb,
    private readonly replyDetector: XReplyDetectorAdapter,
    private readonly logger?: ReturnType<typeof createLogger>
  ) {
    this.config = new SystemConfigService(db);
    this.killSwitch = new KillSwitch(this.config);
    this.jobRunner = new JobRunner(db, logger);
  }

  async detectReplies(prospectId: string): Promise<ReplyDetectionResult> {
    const { result } = await this.detectRepliesWithMeta(prospectId);
    return result;
  }

  /** Internal — also reports whether a real network call was attempted, so `detectRepliesBatch` can charge the shared scrape budget accurately without guessing from the result shape. */
  private async detectRepliesWithMeta(prospectId: string): Promise<{ result: ReplyDetectionResult; networkCallAttempted: boolean }> {
    const prospectRows = await this.db.select().from(schema.prospects).where(eq(schema.prospects.id, prospectId)).limit(1);
    const prospect = prospectRows[0];
    if (!prospect) {
      throw new Error(`Cannot detect replies: no prospect found with id ${prospectId}`);
    }

    if (TERMINAL_STOPPED_STATUSES.has(prospect.outreachStatus)) {
      return { result: await this.finish(prospectId, null, { state: 'STOPPED', reason: 'prospect.outreach_status is a terminal stop/opt-out state' }, 0, true), networkCallAttempted: false };
    }

    if (await this.killSwitch.isActive()) {
      return { result: await this.finish(prospectId, null, { state: 'UNKNOWN', reason: 'the kill switch is active — never interpreted as "no reply"' }, 0, false), networkCallAttempted: false };
    }

    if (!prospect.xUserId) {
      return { result: await this.finish(prospectId, null, { state: 'UNKNOWN', reason: 'prospect has no canonical X user ID on file — identity cannot be safely established' }, 0, false), networkCallAttempted: false };
    }

    let observations: Awaited<ReturnType<XReplyDetectorAdapter['getConversationMessages']>>;
    try {
      observations = await this.replyDetector.getConversationMessages(prospect.xUserId);
    } catch (err) {
      this.logger?.error({ prospectId, err: err instanceof Error ? err.message : String(err) }, 'reply_detection.adapter_failed');
      return { result: await this.finish(prospectId, null, { state: 'UNKNOWN', reason: `detection attempt failed: ${err instanceof Error ? err.message : String(err)}` }, 0, false), networkCallAttempted: true };
    }

    const conversationId = await this.getOrCreateConversation(prospectId);
    const existingMessages = await this.db
      .select()
      .from(schema.conversationMessages)
      .where(eq(schema.conversationMessages.conversationId, conversationId));
    const existingXMessageIds = new Set(existingMessages.map((m) => m.xMessageId).filter((id): id is string => !!id));

    let newMessagesFound = 0;
    for (const observation of observations) {
      const direction = classifyMessageDirection({ senderXUserId: observation.senderXUserId, prospectXUserId: prospect.xUserId });
      if (direction !== 'prospect') continue; // never fabricate an 'outbound' row by exclusion — see reply-direction.ts
      if (observation.xMessageId && existingXMessageIds.has(observation.xMessageId)) continue; // dedup (Section I)

      await this.db.insert(schema.conversationMessages).values({
        id: uuid(),
        conversationId,
        direction: 'inbound',
        content: observation.text,
        xMessageId: observation.xMessageId || undefined,
        timestamp: observation.createdAt || new Date().toISOString(),
      });
      if (observation.xMessageId) existingXMessageIds.add(observation.xMessageId);
      newMessagesFound += 1;
    }

    const allMessages = await this.db
      .select()
      .from(schema.conversationMessages)
      .where(eq(schema.conversationMessages.conversationId, conversationId));
    const inboundMessages = allMessages.filter((m) => m.direction === 'inbound');
    const hasProspectMessage = inboundMessages.length > 0;
    const optOutDetected = inboundMessages.some((m) => classifyOptOutIntent(m.content).isOptOut);

    const conversationRows = await this.db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)).limit(1);
    const conversation = conversationRows[0];
    const conversationStopped = conversation?.state === 'stopped';

    const replyStateResult = deriveReplyState({
      detectionSucceeded: true,
      hasProspectMessage,
      optOutDetected,
      prospectStopped: conversationStopped,
    });

    const mostRecent = [...allMessages].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))[0];
    await this.db
      .update(schema.conversations)
      .set({
        classification: optOutDetected ? 'OPT_OUT' : conversation?.classification,
        lastMessageAt: mostRecent?.timestamp ?? conversation?.lastMessageAt,
        lastMessageDirection: mostRecent?.direction ?? conversation?.lastMessageDirection,
      })
      .where(eq(schema.conversations.id, conversationId));

    return { result: await this.finish(prospectId, conversationId, replyStateResult, newMessagesFound, true), networkCallAttempted: true };
  }

  private async getOrCreateConversation(prospectId: string): Promise<string> {
    const existing = await this.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.prospectId, prospectId))
      .orderBy(desc(schema.conversations.lastMessageAt))
      .limit(1);
    if (existing[0]) return existing[0].id;

    const id = uuid();
    await this.db.insert(schema.conversations).values({ id, prospectId, state: 'active', classification: 'UNKNOWN' });
    return id;
  }

  private async finish(
    prospectId: string,
    conversationId: string | null,
    replyStateResult: { state: ReplyState; reason: string },
    newMessagesFound: number,
    detectionSucceeded: boolean
  ): Promise<ReplyDetectionResult> {
    await writeAuditLog(this.db, {
      actor: 'system',
      actionType: 'outreach.reply_detection.checked',
      entityType: 'conversation',
      entityId: conversationId ?? prospectId,
      detail: { prospectId, conversationId, replyState: replyStateResult.state, newMessagesFound, detectionSucceeded },
    });
    return { prospectId, conversationId, replyState: replyStateResult.state, newMessagesFound, detectionSucceeded, reason: replyStateResult.reason };
  }

  /**
   * Bounded, checkpointed, resumable batch detection over the existing
   * `job_runs` mechanism (Section J) — mirrors
   * `WebsiteEvidenceService.runBatch`/`DiscoveryService.run`'s exact
   * pattern (shared `daily_limit_scrapes` budget, one unit per prospect
   * actually checked over the network; a prospect resolved without a
   * network call — already stopped, kill-switch-blocked, or missing an
   * X user ID — costs nothing). No second job framework.
   */
  async detectRepliesBatch(prospectIds: string[], options: { resumeJobId?: string } = {}): Promise<{ jobId: string; results: ReplyDetectionResult[] }> {
    interface BatchCheckpoint {
      completed: Record<string, ReplyDetectionResult>;
      scrapesUsed: number;
    }

    let jobId: string;
    let checkpoint: BatchCheckpoint;

    if (options.resumeJobId) {
      const existing = await this.jobRunner.get(options.resumeJobId);
      if (!existing) {
        throw new Error(`Cannot resume reply-detection batch: no job_run found with id ${options.resumeJobId}`);
      }
      jobId = existing.id;
      checkpoint = (existing.checkpoint as BatchCheckpoint | null) ?? { completed: {}, scrapesUsed: 0 };
      await this.jobRunner.markResumed(jobId);
    } else {
      checkpoint = { completed: {}, scrapesUsed: 0 };
      jobId = await this.jobRunner.start(REPLY_DETECTION_BATCH_JOB_TYPE, checkpoint);
    }

    const scrapeBudget = await this.config.getDailyLimit('scrapes');
    const pending = prospectIds.filter((id) => !(id in checkpoint.completed));

    for (const prospectId of pending) {
      if (checkpoint.scrapesUsed >= scrapeBudget) break;
      try {
        const { result, networkCallAttempted } = await this.detectRepliesWithMeta(prospectId);
        if (networkCallAttempted) checkpoint.scrapesUsed += 1;
        checkpoint.completed[prospectId] = result;
      } catch (err) {
        checkpoint.completed[prospectId] = {
          prospectId,
          conversationId: null,
          replyState: 'UNKNOWN',
          newMessagesFound: 0,
          detectionSucceeded: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      await this.jobRunner.updateCheckpoint(jobId, checkpoint);
    }

    await this.jobRunner.complete(jobId);

    const results = prospectIds.map(
      (prospectId) =>
        checkpoint.completed[prospectId] ?? {
          prospectId,
          conversationId: null,
          replyState: 'UNKNOWN' as ReplyState,
          newMessagesFound: 0,
          detectionSucceeded: false,
          reason: 'not processed by this batch run (budget exhausted before reaching it)',
        }
    );

    return { jobId, results };
  }
}
