import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { writeAuditLog, schema, type MetrivioDb, type createLogger } from '@metrivio/core';
import { applyDraftTransition, isTerminalDraftState, type MessageDraftState } from '../state-machine/draft-state-machine.js';
import { buildPersonalizationCandidates, type PersonalizationCandidate, type EvidenceRowInput, type PainSignalRowInput, type TechnologyDetectionInput } from '../personalization/personalization-candidates.js';
import { renderMessageDraft } from './message-templates.js';
import { renderFollowUpMessageDraft } from '../follow-up/follow-up-message-templates.js';
import type { MessageDraft, FollowUpIntent } from './message-draft.js';

/**
 * Persists the message-draft lifecycle entirely through the existing
 * `audit_log` table (Section G: "use the existing audit-log pattern rather
 * than creating a second audit system") — zero schema changes. A draft's
 * current state is derived by replaying its own audit_log rows in order,
 * which is a natural fit for DATABASE.md's own stated principle ("nothing
 * is deleted, only superseded... so the audit trail stays intact").
 *
 * Why not `outreach_messages`: that table's `status` enum
 * (`queued`/`sent`/`failed`/`skipped_stop_condition`, DATABASE.md §2) and
 * its `NOT NULL` `sequence_id`/`sequence_step_order` columns model a
 * message already committed to a running sequence — it has no
 * representation for DRAFTED/PENDING_APPROVAL/APPROVED/REJECTED, and widening
 * its enum plus adding `approval_status`/`rejection_reason` columns would be
 * a schema change. Per Section N, that gap is documented here (and in
 * RISK_REGISTER.md) rather than silently migrated; the audit-log-backed
 * design below is the "alternative if possible" that avoids the migration
 * entirely for Stage 6A's actual scope (draft + approval only, no send).
 *
 * Known limitation (documented, not fixed here): looking up a prospect's
 * drafts scans every `outreach.draft.created` audit_log row rather than
 * using an index — acceptable for this stage's foundation scope, called
 * out in RISK_REGISTER.md as a future optimization if draft volume grows
 * (at which point a real `message_drafts` table would be the correct fix,
 * not a workaround here).
 */

const ENTITY_TYPE = 'outreach_draft';

const ACTION_TYPES = {
  created: 'outreach.draft.created',
  submittedForApproval: 'outreach.draft.submitted_for_approval',
  approved: 'outreach.draft.approved',
  rejected: 'outreach.draft.rejected',
} as const;

interface CreatedDetail {
  sequence: number;
  prospectId: string;
  selectedHook: PersonalizationCandidate | null;
  messageText: string;
  evidenceReferences: string[];
  generatedAt: string;
  /** Stage 6D additions — present only for a follow-up draft (Section A). */
  sequenceId?: string;
  sequenceStepOrder?: number;
  parentOutreachMessageId?: string;
  followUpIntent?: FollowUpIntent;
}

interface TransitionDetail {
  sequence: number;
  approvedBy?: string;
  rejectedBy?: string;
  reason?: string;
}

export interface GenerateDraftInput {
  prospectId: string;
  displayName: string | null;
  companyName: string | null;
  evidenceRows: EvidenceRowInput[];
  painSignals: PainSignalRowInput[];
  technologyDetections: TechnologyDetectionInput[];
  /**
   * Stage 6D follow-up fields (Section A/D/F) — all four are populated
   * together only by `FollowUpDraftService`; an original Stage 6A/6B
   * caller omits every one of them and gets exactly today's behavior
   * (`renderMessageDraft`, no evidence exclusion, no sequence fields
   * persisted). When present, `generateDraft()` renders via
   * `renderFollowUpMessageDraft()` instead and excludes
   * `excludeEvidenceId` from candidate selection so the follow-up is
   * required to reference a *new* verified observation, not the one
   * already used in the original message.
   */
  followUp?: {
    sequenceId: string;
    sequenceStepOrder: number;
    followUpIntent: FollowUpIntent;
    parentOutreachMessageId?: string;
    /** The original draft's `selectedHook.evidenceId`, excluded from this follow-up's candidate pool. */
    excludeEvidenceId?: string;
  };
}

export interface GenerateDraftResult {
  draft: MessageDraft;
  /** False when an existing non-terminal draft for this prospect was returned instead of creating a new one (idempotency, Section M). */
  created: boolean;
}

export class OutreachDraftService {
  constructor(
    private readonly db: MetrivioDb,
    private readonly logger?: ReturnType<typeof createLogger>
  ) {}

  /**
   * Builds personalization candidates from already-gathered evidence
   * (no I/O of its own beyond the audit_log reads/writes below) and
   * creates a new `MessageDraft` in state `DRAFTED`. Idempotent: if a
   * non-terminal (DRAFTED/PENDING_APPROVAL) draft already exists for this
   * prospect, it is returned unchanged instead of creating a second one —
   * Stage 6A allows at most one in-flight draft per prospect at a time.
   */
  async generateDraft(input: GenerateDraftInput): Promise<GenerateDraftResult> {
    const existing = await this.listDraftsForProspect(input.prospectId);
    const nonTerminal = existing.find((d) => !isTerminalDraftState(d.status));
    if (nonTerminal) {
      return { draft: nonTerminal, created: false };
    }

    const allCandidates = buildPersonalizationCandidates({
      evidenceRows: input.evidenceRows,
      painSignals: input.painSignals,
      technologyDetections: input.technologyDetections,
      companyName: input.companyName,
    });
    const candidates = input.followUp?.excludeEvidenceId ? allCandidates.filter((c) => c.evidenceId !== input.followUp?.excludeEvidenceId) : allCandidates;
    const selectedHook = candidates[0] ?? null;
    const messageText = input.followUp
      ? renderFollowUpMessageDraft(input.displayName, input.companyName, input.followUp.followUpIntent, selectedHook)
      : renderMessageDraft(input.displayName, input.companyName, selectedHook);
    const evidenceReferences = candidates.map((c) => c.evidenceId);
    const generatedAt = new Date().toISOString();
    const draftId = uuid();

    const detail: CreatedDetail = {
      sequence: 0,
      prospectId: input.prospectId,
      selectedHook,
      messageText,
      evidenceReferences,
      generatedAt,
      ...(input.followUp
        ? {
            sequenceId: input.followUp.sequenceId,
            sequenceStepOrder: input.followUp.sequenceStepOrder,
            followUpIntent: input.followUp.followUpIntent,
            ...(input.followUp.parentOutreachMessageId ? { parentOutreachMessageId: input.followUp.parentOutreachMessageId } : {}),
          }
        : {}),
    };
    await writeAuditLog(this.db, {
      actor: 'system',
      actionType: ACTION_TYPES.created,
      entityType: ENTITY_TYPE,
      entityId: draftId,
      detail: detail as unknown as Record<string, unknown>,
    });

    this.logger?.info({ draftId, prospectId: input.prospectId, hookType: selectedHook?.hookType ?? null, isFollowUp: !!input.followUp }, 'outreach_draft.created');

    const draft: MessageDraft = {
      id: draftId,
      prospectId: input.prospectId,
      selectedHook,
      messageText,
      evidenceReferences,
      generatedAt,
      status: 'DRAFTED',
      ...(input.followUp
        ? {
            sequenceId: input.followUp.sequenceId,
            sequenceStepOrder: input.followUp.sequenceStepOrder,
            followUpIntent: input.followUp.followUpIntent,
            ...(input.followUp.parentOutreachMessageId ? { parentOutreachMessageId: input.followUp.parentOutreachMessageId } : {}),
          }
        : {}),
    };
    return { draft, created: true };
  }

  async submitForApproval(draftId: string): Promise<MessageDraft> {
    return this.transition(draftId, 'SUBMIT_FOR_APPROVAL', ACTION_TYPES.submittedForApproval, 'system', {});
  }

  async approve(draftId: string, approvedBy: string): Promise<MessageDraft> {
    return this.transition(draftId, 'APPROVE', ACTION_TYPES.approved, 'human', { approvedBy });
  }

  async reject(draftId: string, rejectedBy: string, reason?: string): Promise<MessageDraft> {
    return this.transition(draftId, 'REJECT', ACTION_TYPES.rejected, 'human', { rejectedBy, reason });
  }

  async getDraft(draftId: string): Promise<MessageDraft | null> {
    const rows = await this.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entityType, ENTITY_TYPE), eq(schema.auditLog.entityId, draftId)));
    if (rows.length === 0) return null;
    return this.fold(rows);
  }

  /**
   * Scans every `outreach.draft.created` row and filters by prospectId in
   * application code (see the "known limitation" doc comment above the
   * class) — deliberately not a new indexed lookup path for this stage.
   */
  async listDraftsForProspect(prospectId: string): Promise<MessageDraft[]> {
    const createdRows = await this.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entityType, ENTITY_TYPE), eq(schema.auditLog.actionType, ACTION_TYPES.created)));

    const draftIds: string[] = [];
    for (const row of createdRows) {
      if (!row.detail || !row.entityId) continue;
      const detail = JSON.parse(row.detail) as CreatedDetail;
      if (detail.prospectId === prospectId) draftIds.push(row.entityId);
    }

    const drafts = await Promise.all(draftIds.map((id) => this.getDraft(id)));
    return drafts.filter((d): d is MessageDraft => d !== null);
  }

  private async transition(
    draftId: string,
    transitionName: 'SUBMIT_FOR_APPROVAL' | 'APPROVE' | 'REJECT',
    actionType: string,
    actor: 'system' | 'human',
    extra: { approvedBy?: string; rejectedBy?: string; reason?: string }
  ): Promise<MessageDraft> {
    const current = await this.getDraft(draftId);
    if (!current) {
      throw new Error(`Cannot apply transition "${transitionName}": no draft found with id ${draftId}`);
    }

    const nextState: MessageDraftState = applyDraftTransition(current.status, transitionName);
    if (nextState === current.status) {
      // Idempotent duplicate transition (e.g. approving an already-APPROVED
      // draft) — no new audit_log row, current state returned unchanged.
      return current;
    }

    const sequenceRows = await this.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entityType, ENTITY_TYPE), eq(schema.auditLog.entityId, draftId)));
    const detail: TransitionDetail = { sequence: sequenceRows.length, ...extra };

    await writeAuditLog(this.db, {
      actor,
      actionType,
      entityType: ENTITY_TYPE,
      entityId: draftId,
      detail: detail as unknown as Record<string, unknown>,
    });

    this.logger?.info({ draftId, transition: transitionName, nextState }, 'outreach_draft.transitioned');

    const updated = await this.getDraft(draftId);
    if (!updated) {
      throw new Error(`Draft ${draftId} vanished immediately after a transition was written — this should be unreachable`);
    }
    return updated;
  }

  private fold(rows: Array<typeof schema.auditLog.$inferSelect>): MessageDraft {
    const parsed = rows
      .map((r) => ({ actionType: r.actionType, detail: r.detail ? (JSON.parse(r.detail) as CreatedDetail & TransitionDetail) : null }))
      .filter((r): r is { actionType: string; detail: CreatedDetail & TransitionDetail } => r.detail !== null)
      .sort((a, b) => a.detail.sequence - b.detail.sequence);

    const createdEvent = parsed.find((r) => r.actionType === ACTION_TYPES.created);
    if (!createdEvent) {
      throw new Error('Cannot fold draft state: no "created" event found in its audit_log history — this should be unreachable');
    }

    const draft: MessageDraft = {
      id: rows[0]?.entityId ?? '',
      prospectId: createdEvent.detail.prospectId,
      selectedHook: createdEvent.detail.selectedHook,
      messageText: createdEvent.detail.messageText,
      evidenceReferences: createdEvent.detail.evidenceReferences,
      generatedAt: createdEvent.detail.generatedAt,
      status: 'DRAFTED',
      ...(createdEvent.detail.sequenceId !== undefined ? { sequenceId: createdEvent.detail.sequenceId } : {}),
      ...(createdEvent.detail.sequenceStepOrder !== undefined ? { sequenceStepOrder: createdEvent.detail.sequenceStepOrder } : {}),
      ...(createdEvent.detail.parentOutreachMessageId !== undefined ? { parentOutreachMessageId: createdEvent.detail.parentOutreachMessageId } : {}),
      ...(createdEvent.detail.followUpIntent !== undefined ? { followUpIntent: createdEvent.detail.followUpIntent } : {}),
    };

    for (const event of parsed) {
      if (event.actionType === ACTION_TYPES.submittedForApproval) {
        draft.status = 'PENDING_APPROVAL';
      } else if (event.actionType === ACTION_TYPES.approved) {
        draft.status = 'APPROVED';
        if (event.detail.approvedBy) draft.approvedBy = event.detail.approvedBy;
      } else if (event.actionType === ACTION_TYPES.rejected) {
        draft.status = 'REJECTED';
        if (event.detail.rejectedBy) draft.rejectedBy = event.detail.rejectedBy;
        if (event.detail.reason) draft.rejectionReason = event.detail.reason;
      }
    }

    return draft;
  }
}
