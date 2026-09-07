import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { schema, writeAuditLog, applyDraftTransition, isTerminalDraftState, type MetrivioDb, type DraftLifecycleState, type createLogger } from '@metrivio/core';
import { validateContentDraft } from './content-validation.js';
import { ContentSignalStore } from '../signals/content-signal-store.js';

/**
 * Stage 8, Section W — a deterministic fingerprint of a draft's body,
 * recorded in the `content.draft.approved` audit event and re-derived
 * whenever `updateBody()` is called. `PublishApprovedContentService`
 * compares the two (via `getApprovalIntegrity()`) to detect "approved text
 * A silently became published text B" without ever needing a second,
 * parallel approval-tracking table — the existing audit log is already the
 * append-only, tamper-evident record this needs.
 */
export function contentHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Stage 7, Section O/W — content draft lifecycle, built on the EXISTING
 * `content_drafts` table (DATABASE.md, unchanged) rather than a new one
 * (Section AD). `content_drafts.approval_status` only has three DB values
 * (`pending`/`approved`/`rejected`) — both `DRAFTED` and `PENDING_APPROVAL`
 * map onto the DB's `pending` value; the finer DRAFTED-vs-PENDING_APPROVAL
 * distinction (and `rejectedBy`/`rejectionReason`, which have no dedicated
 * columns at all) is reconstructed the same way Stage 6A's
 * `OutreachDraftService` reconstructs `MessageDraft` state: by replaying
 * this draft's own `audit_log` rows in their recorded `sequence` order.
 * `content_drafts`' own real columns (`body`, `hook_variants`,
 * `chosen_hook`, `quality_check_status/notes`) remain the single source of
 * truth for the draft's actual content — only the approval-lifecycle
 * metadata is audit-log-backed.
 *
 * Reuses the exact same generic `applyDraftTransition()` state machine
 * (`packages/core/src/drafts/draft-lifecycle.ts`) Stage 6A's outreach
 * drafts use — not a second implementation.
 */
const ENTITY_TYPE = 'content_draft';
const ACTION_TYPES = {
  created: 'content.draft.created',
  submittedForApproval: 'content.draft.submitted_for_approval',
  approved: 'content.draft.approved',
  rejected: 'content.draft.rejected',
  bodyChanged: 'content.draft.body_changed',
} as const;

interface TransitionDetail {
  sequence: number;
  approvedBy?: string;
  rejectedBy?: string;
  reason?: string;
  contentHash?: string;
}

interface BodyChangedDetail {
  sequence: number;
  contentHash: string;
  editedBy?: string;
}

/**
 * Stage 8, Section W/X — whether a draft's currently-recorded approval (if
 * any) still covers its current body. `contentChangedSinceApproval: true`
 * means `PublishApprovedContentService` must treat this draft as NOT
 * validly approved, regardless of `content_drafts.approval_status` still
 * reading `'approved'` in the DB — publishing requires a fresh `approve()`
 * call recorded after the most recent body change.
 */
export interface ApprovalIntegrity {
  isApproved: boolean;
  approvedBy?: string;
  contentHashAtApproval?: string;
  currentContentHash: string;
  contentChangedSinceApproval: boolean;
}

export interface ContentDraftInput {
  ideaId: string;
  body: string;
  hookVariants?: { a: string; b: string; c: string };
  chosenHook?: string;
}

export interface ContentDraft {
  id: string;
  ideaId: string;
  body: string;
  hookVariants: { a: string; b: string; c: string } | null;
  chosenHook: string | null;
  qualityCheckStatus: 'pass' | 'flagged';
  qualityCheckNotes: string[];
  status: DraftLifecycleState;
  approvedBy?: string;
  rejectedBy?: string;
  rejectionReason?: string;
  createdAt: string;
}

export interface GenerateDraftResult {
  draft: ContentDraft;
  created: boolean;
}

export class ContentDraftService {
  private readonly signals: ContentSignalStore;

  constructor(
    private readonly db: MetrivioDb,
    private readonly logger?: ReturnType<typeof createLogger>
  ) {
    this.signals = new ContentSignalStore(db);
  }

  /**
   * Creates a draft for an idea, validating it against
   * `validateContentDraft()` (fabrication/originality checks) first.
   * Idempotent: at most one non-terminal draft per idea, mirroring Stage
   * 6A's own draft idempotency rule.
   */
  async generateDraft(input: ContentDraftInput): Promise<GenerateDraftResult> {
    const existing = await this.listDraftsForIdea(input.ideaId);
    const nonTerminal = existing.find((d) => !isTerminalDraftState(d.status));
    if (nonTerminal) {
      return { draft: nonTerminal, created: false };
    }

    // Reuses whatever excerpts this idea's originating content_signals carry, so a draft can never verbatim-copy the research it was built from (Section P).
    const relatedExcerpts = (await this.signals.list({ limit: 500 })).map((s) => s.excerpt).filter((e): e is string => !!e);
    const validation = validateContentDraft(input.body, relatedExcerpts);

    const id = uuid();
    const createdAt = new Date().toISOString();
    await this.db.insert(schema.contentDrafts).values({
      id,
      ideaId: input.ideaId,
      hookVariants: input.hookVariants ? JSON.stringify(input.hookVariants) : undefined,
      chosenHook: input.chosenHook ?? undefined,
      body: input.body,
      qualityCheckStatus: validation.status,
      qualityCheckNotes: validation.notes.length ? JSON.stringify(validation.notes) : undefined,
      approvalStatus: 'pending',
      createdAt,
      updatedAt: createdAt,
    });

    await writeAuditLog(this.db, {
      actor: 'system',
      actionType: ACTION_TYPES.created,
      entityType: ENTITY_TYPE,
      entityId: id,
      detail: { sequence: 0 },
    });

    this.logger?.info({ draftId: id, ideaId: input.ideaId, qualityCheckStatus: validation.status }, 'content_draft.created');

    const draft: ContentDraft = {
      id,
      ideaId: input.ideaId,
      body: input.body,
      hookVariants: input.hookVariants ?? null,
      chosenHook: input.chosenHook ?? null,
      qualityCheckStatus: validation.status,
      qualityCheckNotes: validation.notes,
      status: 'DRAFTED',
      createdAt,
    };
    return { draft, created: true };
  }

  async submitForApproval(draftId: string): Promise<ContentDraft> {
    return this.transition(draftId, 'SUBMIT_FOR_APPROVAL', ACTION_TYPES.submittedForApproval, {});
  }

  async approve(draftId: string, approvedBy: string): Promise<ContentDraft> {
    const current = await this.getDraft(draftId);
    if (!current) {
      throw new Error(`Cannot apply transition "APPROVE": no content draft found with id ${draftId}`);
    }

    // Section W: a draft already APPROVED whose body was subsequently
    // changed (via updateBody()) needs a fresh `approve()` call to record a
    // new contentHash covering the current body — but `applyDraftTransition`
    // treats APPROVED as terminal (no outgoing APPROVE transition), so the
    // generic `transition()` helper below would silently no-op and never
    // record it. Re-approval is therefore handled here directly: it never
    // invents a new state-machine transition, it only ever writes a new
    // `content.draft.approved` audit event re-affirming approval of
    // whatever the current body now is.
    if (current.status === 'APPROVED') {
      const integrity = await this.getApprovalIntegrity(draftId);
      if (!integrity.contentChangedSinceApproval) {
        return current; // already approved and covers the current body — true no-op
      }
      const priorRows = await this.db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityType, ENTITY_TYPE), eq(schema.auditLog.entityId, draftId)));
      const detail: TransitionDetail = { sequence: priorRows.length, approvedBy, contentHash: contentHash(current.body) };
      await writeAuditLog(this.db, { actor: 'human', actionType: ACTION_TYPES.approved, entityType: ENTITY_TYPE, entityId: draftId, detail: detail as unknown as Record<string, unknown> });
      await this.db.update(schema.contentDrafts).set({ approvedBy, updatedAt: new Date().toISOString() }).where(eq(schema.contentDrafts.id, draftId));
      const updated = await this.getDraft(draftId);
      if (!updated) throw new Error(`Content draft ${draftId} vanished during re-approval — this should be unreachable`);
      return updated;
    }

    return this.transition(draftId, 'APPROVE', ACTION_TYPES.approved, { approvedBy, contentHash: contentHash(current.body) });
  }

  async reject(draftId: string, rejectedBy: string, reason?: string): Promise<ContentDraft> {
    return this.transition(draftId, 'REJECT', ACTION_TYPES.rejected, { rejectedBy, reason });
  }

  /**
   * Stage 8, Section W — changes a draft's body after it may already be
   * APPROVED. Deliberately does NOT go through `applyDraftTransition()`
   * (APPROVED has no outgoing transitions in that table, and this method
   * must never bypass that invariant by inventing one) — it updates the
   * `content_drafts.body` column directly and re-runs
   * `validateContentDraft()`, but leaves `approval_status` in the DB
   * untouched. What changes is the audit trail: a
   * `content.draft.body_changed` event recording the new content's hash,
   * which `getApprovalIntegrity()` compares against the hash captured at
   * the most recent `approve()` call to determine whether that approval
   * still covers the current body. This is the mechanism
   * `PublishApprovedContentService` relies on to require re-approval before
   * publishing a draft whose approved text no longer matches its current
   * text.
   */
  async updateBody(draftId: string, newBody: string, editedBy?: string): Promise<ContentDraft> {
    const current = await this.getDraft(draftId);
    if (!current) {
      throw new Error(`Cannot update body: no content draft found with id ${draftId}`);
    }
    if (current.status === 'REJECTED') {
      throw new Error(`Cannot update body of content draft ${draftId}: REJECTED is terminal`);
    }

    const relatedExcerpts = (await this.signals.list({ limit: 500 })).map((s) => s.excerpt).filter((e): e is string => !!e);
    const validation = validateContentDraft(newBody, relatedExcerpts);

    await this.db
      .update(schema.contentDrafts)
      .set({
        body: newBody,
        qualityCheckStatus: validation.status,
        qualityCheckNotes: validation.notes.length ? JSON.stringify(validation.notes) : null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.contentDrafts.id, draftId));

    const priorRows = await this.db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityType, ENTITY_TYPE), eq(schema.auditLog.entityId, draftId)));
    const detail: BodyChangedDetail = { sequence: priorRows.length, contentHash: contentHash(newBody), editedBy };
    await writeAuditLog(this.db, { actor: editedBy ? 'human' : 'system', actionType: ACTION_TYPES.bodyChanged, entityType: ENTITY_TYPE, entityId: draftId, detail: detail as unknown as Record<string, unknown> });

    const updated = await this.getDraft(draftId);
    if (!updated) throw new Error(`Content draft ${draftId} vanished during updateBody — this should be unreachable`);
    return updated;
  }

  /**
   * Stage 8, Sections F/W — derives whether this draft's most recent
   * `approve()` call still covers its current body, by replaying the audit
   * log rather than trusting `content_drafts.approval_status` alone. Used
   * by `PublishApprovedContentService`'s pre-publish approval recheck; must
   * never be bypassed in favor of a cached/in-memory approval flag.
   */
  async getApprovalIntegrity(draftId: string): Promise<ApprovalIntegrity> {
    const current = await this.getDraft(draftId);
    if (!current) {
      throw new Error(`Cannot compute approval integrity: no content draft found with id ${draftId}`);
    }

    const auditRows = await this.db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityType, ENTITY_TYPE), eq(schema.auditLog.entityId, draftId)));
    const events = auditRows
      .map((r) => ({ actionType: r.actionType, detail: r.detail ? (JSON.parse(r.detail) as TransitionDetail & BodyChangedDetail) : null }))
      .filter((e): e is { actionType: string; detail: TransitionDetail & BodyChangedDetail } => e.detail !== null)
      .sort((a, b) => a.detail.sequence - b.detail.sequence);

    let lastApproval: { approvedBy?: string; contentHash?: string; sequence: number } | undefined;
    let lastBodyChangeSequence = -1;

    for (const event of events) {
      if (event.actionType === ACTION_TYPES.approved) {
        lastApproval = { approvedBy: event.detail.approvedBy, contentHash: event.detail.contentHash, sequence: event.detail.sequence };
      } else if (event.actionType === ACTION_TYPES.bodyChanged) {
        lastBodyChangeSequence = event.detail.sequence;
      }
    }

    const currentHash = contentHash(current.body);
    const isApproved = current.status === 'APPROVED' && lastApproval !== undefined;
    const contentChangedSinceApproval = isApproved && (lastApproval!.contentHash !== currentHash || lastBodyChangeSequence > lastApproval!.sequence);

    return {
      isApproved,
      approvedBy: lastApproval?.approvedBy,
      contentHashAtApproval: lastApproval?.contentHash,
      currentContentHash: currentHash,
      contentChangedSinceApproval,
    };
  }

  /**
   * Re-runs `validateContentDraft()` against a draft's existing body and
   * the LATEST set of research excerpts, updating only
   * `quality_check_status`/`quality_check_notes` — never the body, never
   * approval state. Useful when new research signals have been ingested
   * since a draft was first created (Section AG's "validate_content_drafts"
   * automation job). Only meaningful for a non-terminal draft — an
   * APPROVED/REJECTED draft's quality check is left untouched.
   */
  async revalidate(draftId: string): Promise<ContentDraft> {
    const current = await this.getDraft(draftId);
    if (!current) {
      throw new Error(`Cannot revalidate: no content draft found with id ${draftId}`);
    }
    if (isTerminalDraftState(current.status)) {
      return current;
    }

    const relatedExcerpts = (await this.signals.list({ limit: 500 })).map((s) => s.excerpt).filter((e): e is string => !!e);
    const validation = validateContentDraft(current.body, relatedExcerpts);

    await this.db
      .update(schema.contentDrafts)
      .set({ qualityCheckStatus: validation.status, qualityCheckNotes: validation.notes.length ? JSON.stringify(validation.notes) : null, updatedAt: new Date().toISOString() })
      .where(eq(schema.contentDrafts.id, draftId));

    const updated = await this.getDraft(draftId);
    if (!updated) throw new Error(`Content draft ${draftId} vanished during revalidation — this should be unreachable`);
    return updated;
  }

  async getDraft(draftId: string): Promise<ContentDraft | null> {
    const rows = await this.db.select().from(schema.contentDrafts).where(eq(schema.contentDrafts.id, draftId)).limit(1);
    const row = rows[0];
    if (!row) return null;

    const auditRows = await this.db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityType, ENTITY_TYPE), eq(schema.auditLog.entityId, draftId)));
    return this.fold(row, auditRows);
  }

  async listDraftsForIdea(ideaId: string): Promise<ContentDraft[]> {
    const rows = await this.db.select().from(schema.contentDrafts).where(eq(schema.contentDrafts.ideaId, ideaId));
    const drafts = await Promise.all(rows.map((r) => this.getDraft(r.id)));
    return drafts.filter((d): d is ContentDraft => d !== null);
  }

  /** Every draft currently in DRAFTED or PENDING_APPROVAL (the DB's `pending` value covers both) — used by the `validate_content_drafts` automation job. */
  async listNonTerminalDrafts(limit?: number): Promise<ContentDraft[]> {
    const rows = await this.db.select().from(schema.contentDrafts).where(eq(schema.contentDrafts.approvalStatus, 'pending'));
    const drafts = await Promise.all(rows.map((r) => this.getDraft(r.id)));
    const nonTerminal = drafts.filter((d): d is ContentDraft => d !== null);
    return limit ? nonTerminal.slice(0, limit) : nonTerminal;
  }

  private async transition(
    draftId: string,
    transitionName: 'SUBMIT_FOR_APPROVAL' | 'APPROVE' | 'REJECT',
    actionType: string,
    extra: { approvedBy?: string; rejectedBy?: string; reason?: string; contentHash?: string }
  ): Promise<ContentDraft> {
    const current = await this.getDraft(draftId);
    if (!current) {
      throw new Error(`Cannot apply transition "${transitionName}": no content draft found with id ${draftId}`);
    }

    const nextState = applyDraftTransition(current.status, transitionName);
    if (nextState === current.status) {
      return current; // idempotent no-op — no new audit row, no DB write
    }

    const priorRows = await this.db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityType, ENTITY_TYPE), eq(schema.auditLog.entityId, draftId)));
    const detail: TransitionDetail = { sequence: priorRows.length, ...extra };
    await writeAuditLog(this.db, { actor: extra.approvedBy || extra.rejectedBy ? 'human' : 'system', actionType, entityType: ENTITY_TYPE, entityId: draftId, detail: detail as unknown as Record<string, unknown> });

    if (nextState === 'APPROVED' || nextState === 'REJECTED') {
      await this.db
        .update(schema.contentDrafts)
        .set({ approvalStatus: nextState === 'APPROVED' ? 'approved' : 'rejected', approvedBy: extra.approvedBy ?? undefined, updatedAt: new Date().toISOString() })
        .where(eq(schema.contentDrafts.id, draftId));
    }

    this.logger?.info({ draftId, transition: transitionName, nextState }, 'content_draft.transitioned');

    const updated = await this.getDraft(draftId);
    if (!updated) {
      throw new Error(`Content draft ${draftId} vanished immediately after a transition was written — this should be unreachable`);
    }
    return updated;
  }

  private fold(row: typeof schema.contentDrafts.$inferSelect, auditRows: Array<typeof schema.auditLog.$inferSelect>): ContentDraft {
    const parsed = auditRows
      .map((r) => ({ actionType: r.actionType, detail: r.detail ? (JSON.parse(r.detail) as TransitionDetail) : null }))
      .filter((r): r is { actionType: string; detail: TransitionDetail } => r.detail !== null)
      .sort((a, b) => a.detail.sequence - b.detail.sequence);

    const draft: ContentDraft = {
      id: row.id,
      ideaId: row.ideaId,
      body: row.body,
      hookVariants: row.hookVariants ? JSON.parse(row.hookVariants) : null,
      chosenHook: row.chosenHook,
      qualityCheckStatus: row.qualityCheckStatus,
      qualityCheckNotes: row.qualityCheckNotes ? JSON.parse(row.qualityCheckNotes) : [],
      status: 'DRAFTED',
      createdAt: row.createdAt,
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
