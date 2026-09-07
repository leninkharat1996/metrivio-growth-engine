import { desc, eq } from 'drizzle-orm';
import { schema, writeAuditLog, type MetrivioDb, type createLogger } from '@metrivio/core';
import { classifyPainCategory } from '../pain-taxonomy/pain-taxonomy.js';
import { classifyHookType, type HookType } from '../hooks/hook-classifier.js';
import { classifyCtaType, type CtaType } from '../analytics/cta-classifier.js';
import type { PainTaxonomyCategory } from '../pain-taxonomy/pain-taxonomy.js';

/**
 * Stage 7, Section R/S — Metrivio's own post-performance ingestion and
 * analysis. Audit-log-backed (Section AD: no new table — there is no live
 * publishing volume yet to justify one; see RISK_REGISTER.md), mirroring
 * the "small-volume foundation data via audit_log" pattern already used
 * for growth techniques and content-opportunity provenance.
 *
 * `ingestSnapshot()` NEVER defaults a missing metric to zero — an absent
 * field is stored as `null` and stays `null` through every downstream
 * calculation (Section R: "do not invent unavailable metrics"). Because
 * no verified X publishing transport exists yet (Section Y), this
 * service has no real data to operate on today — it is implemented and
 * tested against injected data, never claimed as "live tested."
 */
export interface OwnPostMetricsInput {
  postId: string;
  draftId?: string | null;
  text?: string | null;
  format?: string | null;
  impressions?: number | null;
  likes?: number | null;
  replies?: number | null;
  reposts?: number | null;
  bookmarks?: number | null;
  profileVisits?: number | null;
  /** Replies/engagement specifically attributable to a known ICP prospect (cross-referenced by X user id against `prospects`) — the "business intent" signal Section S calls for, distinct from raw reach/engagement. */
  icpEngagementCount?: number | null;
}

export interface OwnPostMetricsSnapshot extends OwnPostMetricsInput {
  hookType: HookType | null;
  painCategory: PainTaxonomyCategory | null;
  /** Stage 9, Section E — derived from `text` exactly like `hookType`/`painCategory` above; `null` only when no text was supplied. */
  ctaType: CtaType | null;
  capturedAt: string;
}

export interface PostPerformanceSummary {
  postId: string;
  reach: number | null;
  engagement: number | null;
  icpEngagement: number | null;
  /** Categorical, never a fabricated score — Section S's explicit REACH/ENGAGEMENT/ICP_ENGAGEMENT/BUSINESS_INTENT distinction. */
  businessIntentSignal: 'present' | 'none' | 'unknown';
  hookType: HookType | null;
  painCategory: PainTaxonomyCategory | null;
}

export class OwnContentPerformanceService {
  constructor(
    private readonly db: MetrivioDb,
    private readonly logger?: ReturnType<typeof createLogger>
  ) {}

  async ingestSnapshot(input: OwnPostMetricsInput): Promise<OwnPostMetricsSnapshot> {
    const capturedAt = new Date().toISOString();
    const snapshot: OwnPostMetricsSnapshot = {
      ...input,
      draftId: input.draftId ?? null,
      text: input.text ?? null,
      format: input.format ?? null,
      impressions: input.impressions ?? null,
      likes: input.likes ?? null,
      replies: input.replies ?? null,
      reposts: input.reposts ?? null,
      bookmarks: input.bookmarks ?? null,
      profileVisits: input.profileVisits ?? null,
      icpEngagementCount: input.icpEngagementCount ?? null,
      hookType: input.text ? classifyHookType(input.text) : null,
      painCategory: input.text ? classifyPainCategory(input.text) : null,
      ctaType: input.text ? classifyCtaType(input.text) : null,
      capturedAt,
    };

    await writeAuditLog(this.db, {
      actor: 'system',
      actionType: 'content.performance.ingested',
      entityType: 'content_post',
      entityId: input.postId,
      detail: snapshot as unknown as Record<string, unknown>,
    });

    this.logger?.info({ postId: input.postId }, 'own_content_performance.ingested');
    return snapshot;
  }

  /** Every distinct postId that has ever had a snapshot ingested — used by the `analyze_own_content` automation job to know what to analyze without a caller having to track post ids separately. */
  async listIngestedPostIds(): Promise<string[]> {
    const rows = await this.db.select().from(schema.auditLog).where(eq(schema.auditLog.actionType, 'content.performance.ingested'));
    return [...new Set(rows.map((r) => r.entityId).filter((id): id is string => !!id))];
  }

  /** The most recently ingested snapshot for one post — never averages or invents a number between snapshots. */
  async getLatestSnapshot(postId: string): Promise<OwnPostMetricsSnapshot | null> {
    const rows = await this.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, postId))
      .orderBy(desc(schema.auditLog.timestamp));
    const row = rows.find((r) => r.actionType === 'content.performance.ingested' && r.entityType === 'content_post');
    return row?.detail ? (JSON.parse(row.detail) as OwnPostMetricsSnapshot) : null;
  }

  private toSummary(snapshot: OwnPostMetricsSnapshot): PostPerformanceSummary {
    const engagementFields = [snapshot.likes, snapshot.replies, snapshot.reposts, snapshot.bookmarks];
    const hasEngagementData = engagementFields.some((f) => f != null);
    const engagement = hasEngagementData ? engagementFields.reduce((sum: number, f) => sum + (f ?? 0), 0) : null;

    const businessIntentSignal: PostPerformanceSummary['businessIntentSignal'] =
      snapshot.icpEngagementCount == null ? 'unknown' : snapshot.icpEngagementCount > 0 ? 'present' : 'none';

    return {
      postId: snapshot.postId,
      reach: snapshot.impressions ?? null,
      engagement,
      icpEngagement: snapshot.icpEngagementCount ?? null,
      businessIntentSignal,
      hookType: snapshot.hookType,
      painCategory: snapshot.painCategory,
    };
  }

  /**
   * Ranks by business intent first, then ICP engagement, then general
   * engagement, then reach LAST — directly implementing Section S's own
   * example ("10,000 views/zero ICP engagement may be less valuable than
   * 1,500 views/several target-founder replies").
   */
  async analyzeTopPosts(postIds: string[]): Promise<PostPerformanceSummary[]> {
    const summaries: PostPerformanceSummary[] = [];
    for (const postId of postIds) {
      const snapshot = await this.getLatestSnapshot(postId);
      if (snapshot) summaries.push(this.toSummary(snapshot));
    }

    const intentRank = { present: 2, unknown: 1, none: 0 } as const;
    return summaries.sort((a, b) => {
      if (intentRank[a.businessIntentSignal] !== intentRank[b.businessIntentSignal]) return intentRank[b.businessIntentSignal] - intentRank[a.businessIntentSignal];
      if ((b.icpEngagement ?? -1) !== (a.icpEngagement ?? -1)) return (b.icpEngagement ?? -1) - (a.icpEngagement ?? -1);
      if ((b.engagement ?? -1) !== (a.engagement ?? -1)) return (b.engagement ?? -1) - (a.engagement ?? -1);
      return (b.reach ?? -1) - (a.reach ?? -1);
    });
  }
}
