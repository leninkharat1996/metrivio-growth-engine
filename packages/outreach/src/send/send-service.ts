import { and, desc, eq, gte } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import {
  KillSwitch,
  SystemConfigService,
  schema,
  writeAuditLog,
  XSendAuthenticationRequiredError,
  XSendRateLimitedError,
  XSendNotFoundError,
  XSendNetworkError,
  XSendUnexpectedError,
  type MetrivioDb,
  type XSendAdapter,
  type createLogger,
} from '@metrivio/core';
import type { OutreachDraftService } from '../drafts/draft-store.js';
import { getOrCreateManualSendSequenceId, MANUAL_SEND_STEP_ORDER } from './manual-sequence.js';
import type { SendApprovedDraftInput, SendApprovedDraftResult, OutreachSendOutcome } from './send-outcome.js';
import type { FollowUpEligibilityService } from '../follow-up/follow-up-eligibility-service.js';
import type { FollowUpEligibilityStatus } from '../follow-up/follow-up-eligibility.js';

/** Maps a Stage 6C eligibility status (other than ELIGIBLE) to the Stage 6D send outcome that reports it — never conflated with `BLOCKED`'s kill-switch-only meaning except where the eligibility status itself IS "the kill switch is active." */
function mapEligibilityStatusToSendOutcome(status: Exclude<FollowUpEligibilityStatus, 'ELIGIBLE'>): OutreachSendOutcome {
  switch (status) {
    case 'REPLIED':
      return 'REPLIED';
    case 'OPTED_OUT':
      return 'OPTED_OUT';
    case 'STOPPED':
      return 'STOPPED';
    case 'NOT_DUE':
      return 'NOT_DUE';
    case 'ALREADY_SENT':
      return 'ALREADY_SENT';
    case 'BLOCKED':
      return 'BLOCKED';
    case 'UNKNOWN':
      return 'FOLLOW_UP_INELIGIBLE';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/**
 * The Stage 6B send boundary: `APPROVED DRAFT -> SAFE SINGLE X SEND ->
 * AUDIT/RESULT`. Every safety property this stage's instructions require
 * lives here, ahead of the one line that would ever touch the network
 * (`this.sendAdapter.sendDirectMessage(...)`):
 *
 *   1. kill switch (checked twice — before preparing the write, and again
 *      immediately before the network call)
 *   2. the draft's CURRENT, reloaded state must be exactly APPROVED
 *   3. the draft's own `prospectId` must match the caller's stated target
 *   4. the target prospect must have a canonical X user ID on file — never
 *      a username-only fallback
 *   5. the message text is exactly the draft's own text (this class never
 *      generates, edits, or truncates it) and passes length validation
 *   6. duplicate-send protection via `outreach_messages`' own existing
 *      unique index (`packages/outreach/src/send/manual-sequence.ts`)
 *   7. the existing `daily_limit_dms` config value, checked against a
 *      rolling 24h count of real sends — no new rate-limit mechanism
 *   8. dry-run short-circuits before any of the above two writes anything
 *
 * This class contains NO batch/bulk API, no scheduler, no queue worker, and
 * no automatic retry of a failed send — `send()` performs exactly one
 * attempt for exactly one caller-specified draft/prospect pair, full stop.
 */
export class SendApprovedDraftService {
  private readonly killSwitch: KillSwitch;
  private readonly config: SystemConfigService;

  constructor(
    private readonly db: MetrivioDb,
    private readonly draftService: OutreachDraftService,
    private readonly sendAdapter: XSendAdapter,
    private readonly logger?: ReturnType<typeof createLogger>,
    /**
     * Optional — Stage 6D's mandatory pre-send reply-recheck (Section C).
     * When omitted, or when the reloaded draft carries no `sequenceId`
     * (an original Stage 6A/6B-shaped draft), behavior is byte-for-byte
     * identical to Stage 6B: no eligibility recheck runs at all. This
     * preserves every existing Stage 6B test while adding the follow-up
     * safety check only for follow-up drafts.
     */
    private readonly followUpEligibilityService?: FollowUpEligibilityService
  ) {
    this.config = new SystemConfigService(db);
    this.killSwitch = new KillSwitch(this.config);
  }

  async send(input: SendApprovedDraftInput): Promise<SendApprovedDraftResult> {
    const dryRun = input.dryRun ?? false;

    // 1. Kill switch — checked before preparing the write at all (Section G).
    if (await this.killSwitch.isActive()) {
      return this.finish(input, { outcome: 'BLOCKED', reason: 'the kill switch is active — refusing to prepare this send' });
    }

    // 2/3. Reload the draft's authoritative, current state — never trust a
    // caller-supplied in-memory draft object (Section D).
    const draft = await this.draftService.getDraft(input.draftId);
    if (!draft) {
      return this.finish(input, { outcome: 'NOT_APPROVED', reason: `no draft found with id ${input.draftId}` });
    }
    if (draft.prospectId !== input.prospectId) {
      return this.finish(input, { outcome: 'TARGET_INVALID', reason: `draft ${input.draftId} belongs to prospect ${draft.prospectId}, not the requested ${input.prospectId}` });
    }
    if (draft.status !== 'APPROVED') {
      return this.finish(input, { outcome: 'NOT_APPROVED', reason: `draft is in state "${draft.status}", not APPROVED` });
    }

    // 4. Target identity — reloaded fresh, canonical ID required (Section C).
    const prospectRows = await this.db.select().from(schema.prospects).where(eq(schema.prospects.id, input.prospectId)).limit(1);
    const prospect = prospectRows[0];
    if (!prospect) {
      return this.finish(input, { outcome: 'TARGET_INVALID', reason: `no prospect found with id ${input.prospectId}` });
    }
    if (!prospect.xUserId) {
      return this.finish(input, { outcome: 'TARGET_INVALID', reason: 'prospect has no canonical X user ID on file — refusing to send based on username alone' });
    }

    // 4b. Mandatory pre-send reply-recheck (Section C): "Draft generated !=
    // Follow-up still eligible" — reloads authoritative reply/eligibility
    // state fresh, immediately before this send, rather than trusting the
    // eligibility check that ran back when the draft was created. Only
    // applies to a follow-up draft (one carrying its own `sequenceId`) and
    // only when this service was constructed with a FollowUpEligibilityService.
    if (draft.sequenceId && this.followUpEligibilityService) {
      const recheck = await this.followUpEligibilityService.evaluate(input.prospectId, draft.sequenceId);
      if (recheck.status !== 'ELIGIBLE') {
        return this.finish(input, { outcome: mapEligibilityStatusToSendOutcome(recheck.status), reason: `pre-send follow-up eligibility recheck: ${recheck.reason}` });
      }
    }

    // 5. Message validation — the draft's exact text, untouched (Section K), within a conservative, documented length bound (Section J).
    const messageText = draft.messageText;
    if (!messageText || messageText.trim().length === 0) {
      return this.finish(input, { outcome: 'MESSAGE_INVALID', reason: 'the approved draft has empty message text' });
    }
    const maxLength = await this.config.getOutreachMaxMessageLength();
    if (messageText.length > maxLength) {
      return this.finish(input, { outcome: 'MESSAGE_INVALID', reason: `message is ${messageText.length} characters, exceeding the configured maximum of ${maxLength} — never truncated, refused instead` });
    }

    // 6. Duplicate-send protection (Section F) — the existing outreach_messages
    // unique index is the backstop; this lookup decides whether we're
    // looking at a fresh send, a safe retry of a known non-ambiguous
    // failure, or a case that must never be attempted again.
    // Section I: a follow-up draft carries its OWN real sequenceId/
    // sequenceStepOrder — the dedup key resolves from the draft itself when
    // present, falling back to the Stage 6B manual-send singleton only for
    // an original (non-follow-up) draft that carries neither.
    const sequenceId = draft.sequenceId ?? (await getOrCreateManualSendSequenceId(this.db));
    const sequenceStepOrder = draft.sequenceStepOrder ?? MANUAL_SEND_STEP_ORDER;
    const existingRows = await this.db
      .select()
      .from(schema.outreachMessages)
      .where(
        and(
          eq(schema.outreachMessages.prospectId, input.prospectId),
          eq(schema.outreachMessages.sequenceId, sequenceId),
          eq(schema.outreachMessages.sequenceStepOrder, sequenceStepOrder)
        )
      )
      .limit(1);
    const existing = existingRows[0];

    if (existing) {
      if (existing.status === 'sent') {
        return this.finish(input, { outcome: 'ALREADY_SENT', reason: 'this prospect already has a successfully sent Stage 6B message', outreachMessageId: existing.id });
      }
      if (existing.status === 'queued') {
        return this.finish(input, {
          outcome: 'ALREADY_SENT',
          reason: 'a previous send attempt for this prospect is still recorded as "queued" (interrupted mid-attempt) — treated as ambiguous and blocked until a human verifies and clears this record',
          outreachMessageId: existing.id,
        });
      }
      if (existing.status === 'failed') {
        const detail = parseErrorDetail(existing.errorDetail);
        if (detail?.ambiguous) {
          return this.finish(input, {
            outcome: 'ALREADY_SENT',
            reason: 'a previous send attempt for this prospect failed ambiguously (its delivery status to X is unknown) — resend is blocked until a human manually verifies via X and clears this record',
            outreachMessageId: existing.id,
          });
        }
        // A known, non-ambiguous prior failure (e.g. this exact capability
        // gap, or a validation failure that never reached the network) —
        // an explicit, human-initiated call is safe to retry against; this
        // is NOT an automatic system-driven retry (Section P).
      } else if (existing.status === 'skipped_stop_condition') {
        return this.finish(input, { outcome: 'ALREADY_SENT', reason: 'an existing outreach_messages row for this prospect is in a terminal non-send state', outreachMessageId: existing.id });
      }
    }

    // 7. Existing daily_limit_dms config, rolling 24h window — no second rate-limit system.
    const dailyLimit = await this.config.getDailyLimit('dms');
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const sentToday = await this.db
      .select()
      .from(schema.outreachMessages)
      .where(and(eq(schema.outreachMessages.channel, 'dm'), eq(schema.outreachMessages.status, 'sent'), gte(schema.outreachMessages.sentAt, since)));
    if (sentToday.length >= dailyLimit) {
      return this.finish(input, { outcome: 'LIMIT_REACHED', reason: `the configured daily DM limit (${dailyLimit}) has already been reached in the last 24 hours` });
    }

    // 8. Kill switch — checked again, immediately before the network write (Section G).
    if (await this.killSwitch.isActive()) {
      return this.finish(input, { outcome: 'BLOCKED', reason: 'the kill switch became active immediately before the network write' });
    }

    if (dryRun) {
      return this.finish(input, {
        outcome: 'DRY_RUN',
        reason: 'every validation/approval/identity/limit/kill-switch check passed — no network write was performed',
        wouldSendTo: { xUserId: prospect.xUserId, xUsername: prospect.xUsername },
        wouldSendText: messageText,
      });
    }

    return this.performRealSend(input, draft, prospect, messageText, sequenceId, sequenceStepOrder, existing?.id);
  }

  private async performRealSend(
    input: SendApprovedDraftInput,
    draft: { id: string; evidenceReferences: string[] },
    prospect: typeof schema.prospects.$inferSelect,
    messageText: string,
    sequenceId: string,
    sequenceStepOrder: number,
    existingRowId: string | undefined
  ): Promise<SendApprovedDraftResult> {
    const personalizationBasis = JSON.stringify({ draftId: draft.id, evidenceReferences: draft.evidenceReferences });

    try {
      const result = await this.sendAdapter.sendDirectMessage({ targetUserId: prospect.xUserId as string, messageText });
      const outreachMessageId = await this.upsertOutreachMessage(existingRowId, {
        prospectId: input.prospectId,
        sequenceId,
        sequenceStepOrder,
        personalizationBasis,
        messageContent: messageText,
        status: 'sent',
        sentAt: result.sentAt,
        errorDetail: null,
      });

      await this.recordConversationMessage(input.prospectId, messageText, result.xMessageId ?? null, result.sentAt);

      this.logger?.info({ prospectId: input.prospectId, draftId: draft.id, outreachMessageId }, 'outreach_send.sent');
      return this.finish(input, { outcome: 'SENT', reason: 'sent successfully', outreachMessageId, xMessageId: result.xMessageId });
    } catch (err) {
      const mapped = mapSendError(err);
      const outreachMessageId = await this.upsertOutreachMessage(existingRowId, {
        prospectId: input.prospectId,
        sequenceId,
        sequenceStepOrder,
        personalizationBasis,
        messageContent: messageText,
        status: 'failed',
        sentAt: null,
        errorDetail: JSON.stringify({ outcome: mapped.outcome, ambiguous: mapped.ambiguous, message: mapped.message }),
      });
      this.logger?.error({ prospectId: input.prospectId, draftId: draft.id, outcome: mapped.outcome }, 'outreach_send.failed');
      return this.finish(input, { outcome: mapped.outcome, reason: mapped.message, outreachMessageId });
    }
  }

  private async upsertOutreachMessage(
    existingRowId: string | undefined,
    values: {
      prospectId: string;
      sequenceId: string;
      sequenceStepOrder: number;
      personalizationBasis: string;
      messageContent: string;
      status: 'sent' | 'failed';
      sentAt: string | null;
      errorDetail: string | null;
    }
  ): Promise<string> {
    if (existingRowId) {
      await this.db
        .update(schema.outreachMessages)
        .set({
          personalizationBasis: values.personalizationBasis,
          messageContent: values.messageContent,
          status: values.status,
          sentAt: values.sentAt ?? undefined,
          errorDetail: values.errorDetail ?? undefined,
        })
        .where(eq(schema.outreachMessages.id, existingRowId));
      return existingRowId;
    }

    const id = uuid();
    await this.db.insert(schema.outreachMessages).values({
      id,
      prospectId: values.prospectId,
      sequenceId: values.sequenceId,
      sequenceStepOrder: values.sequenceStepOrder,
      personalizationBasis: values.personalizationBasis,
      messageContent: values.messageContent,
      channel: 'dm',
      status: values.status,
      sentAt: values.sentAt ?? undefined,
      errorDetail: values.errorDetail ?? undefined,
    });
    return id;
  }

  /** Finds the prospect's most recent conversation (or starts one) and records the outbound message — reuses `conversations`/`conversation_messages` exactly as documented, no new tables (Section O). Reply detection remains explicitly out of scope. */
  private async recordConversationMessage(prospectId: string, messageText: string, xMessageId: string | null, sentAt: string): Promise<void> {
    const existingConversations = await this.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.prospectId, prospectId))
      .orderBy(desc(schema.conversations.lastMessageAt))
      .limit(1);

    let conversationId = existingConversations[0]?.id;
    if (conversationId) {
      await this.db
        .update(schema.conversations)
        .set({ state: 'active', lastMessageAt: sentAt, lastMessageDirection: 'outbound' })
        .where(eq(schema.conversations.id, conversationId));
    } else {
      conversationId = uuid();
      await this.db.insert(schema.conversations).values({
        id: conversationId,
        prospectId,
        state: 'active',
        classification: 'UNKNOWN',
        lastMessageAt: sentAt,
        lastMessageDirection: 'outbound',
      });
    }

    await this.db.insert(schema.conversationMessages).values({
      id: uuid(),
      conversationId,
      direction: 'outbound',
      content: messageText,
      xMessageId: xMessageId ?? undefined,
      timestamp: sentAt,
    });
  }

  /** Every call to `send()` ends here — one uniform audit trail entry regardless of outcome (Section M), safe by construction: only ids/outcomes/reasons are ever passed in, never credential material. */
  private async finish(input: SendApprovedDraftInput, partial: Omit<SendApprovedDraftResult, 'reason'> & { reason: string }): Promise<SendApprovedDraftResult> {
    await writeAuditLog(this.db, {
      actor: 'system',
      actionType: 'outreach.send.attempt',
      entityType: 'outreach_message',
      entityId: partial.outreachMessageId ?? input.draftId,
      dryRun: input.dryRun ?? false,
      detail: {
        draftId: input.draftId,
        prospectId: input.prospectId,
        outcome: partial.outcome,
        reason: partial.reason,
      },
    });
    return partial;
  }
}

function parseErrorDetail(raw: string | null): { outcome: OutreachSendOutcome; ambiguous: boolean; message: string } | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { outcome: OutreachSendOutcome; ambiguous: boolean; message: string };
  } catch {
    return null;
  }
}

/** Mirrors `XReadAdapter`'s error-mapping discipline exactly — no adapter-specific error type ever escapes this boundary. */
function mapSendError(err: unknown): { outcome: OutreachSendOutcome; ambiguous: boolean; message: string } {
  if (err instanceof XSendAuthenticationRequiredError) return { outcome: 'AUTH_REQUIRED', ambiguous: false, message: err.message };
  if (err instanceof XSendRateLimitedError) return { outcome: 'RATE_LIMITED', ambiguous: false, message: err.message };
  if (err instanceof XSendNotFoundError) return { outcome: 'NOT_FOUND', ambiguous: false, message: err.message };
  if (err instanceof XSendNetworkError) return { outcome: 'NETWORK_ERROR', ambiguous: true, message: err.message };
  if (err instanceof XSendUnexpectedError) return { outcome: 'UNEXPECTED_ERROR', ambiguous: false, message: err.message };
  return { outcome: 'UNEXPECTED_ERROR', ambiguous: true, message: err instanceof Error ? err.message : String(err) };
}
