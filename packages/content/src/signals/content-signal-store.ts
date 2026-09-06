import { and, desc, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { schema, type MetrivioDb } from '@metrivio/core';
import { CONTENT_SIGNAL_EXCERPT_MAX_LENGTH, type ContentSignal, type ContentSignalInput, type ContentSignalType } from './content-signal.js';

/**
 * Stage 7, Section K — the structured content-intelligence layer.
 * `content_signals` (Stage 7 schema addition, see RISK_REGISTER.md) is the
 * single table every research subsystem in this package writes to: ICP
 * research, competitor intelligence, expert intelligence, and web research
 * all produce `ContentSignal` rows through this one store, rather than
 * each maintaining its own ad hoc persistence.
 */
export interface ContentSignalFilter {
  signalType?: ContentSignalType;
  prospectId?: string;
  accountId?: string;
  painCategory?: string;
  limit?: number;
}

export class ContentSignalStore {
  constructor(private readonly db: MetrivioDb) {}

  async create(input: ContentSignalInput): Promise<ContentSignal> {
    const id = uuid();
    const excerpt = input.excerpt ? input.excerpt.slice(0, CONTENT_SIGNAL_EXCERPT_MAX_LENGTH) : null;
    const capturedAt = new Date().toISOString();

    await this.db.insert(schema.contentSignals).values({
      id,
      signalType: input.signalType,
      sourceType: input.sourceType,
      sourceUrl: input.sourceUrl ?? undefined,
      prospectId: input.prospectId ?? undefined,
      accountId: input.accountId ?? undefined,
      authorUsername: input.authorUsername ?? undefined,
      companyName: input.companyName ?? undefined,
      topic: input.topic ?? undefined,
      painCategory: input.painCategory ?? undefined,
      confidence: input.confidence,
      excerpt: excerpt ?? undefined,
      extraction: input.extraction ? JSON.stringify(input.extraction) : undefined,
      engagementLikes: input.engagement?.likes ?? undefined,
      engagementReplies: input.engagement?.replies ?? undefined,
      engagementReposts: input.engagement?.reposts ?? undefined,
      engagementBookmarks: input.engagement?.bookmarks ?? undefined,
      engagementViews: input.engagement?.views ?? undefined,
      relevanceScore: input.relevanceScore ?? undefined,
      publishedAt: input.publishedAt ?? undefined,
      capturedAt,
    });

    return this.toDomain({
      id,
      signalType: input.signalType,
      sourceType: input.sourceType,
      sourceUrl: input.sourceUrl ?? null,
      prospectId: input.prospectId ?? null,
      accountId: input.accountId ?? null,
      authorUsername: input.authorUsername ?? null,
      companyName: input.companyName ?? null,
      topic: input.topic ?? null,
      painCategory: input.painCategory ?? null,
      confidence: input.confidence,
      excerpt,
      extraction: input.extraction ? JSON.stringify(input.extraction) : null,
      engagementLikes: input.engagement?.likes ?? null,
      engagementReplies: input.engagement?.replies ?? null,
      engagementReposts: input.engagement?.reposts ?? null,
      engagementBookmarks: input.engagement?.bookmarks ?? null,
      engagementViews: input.engagement?.views ?? null,
      relevanceScore: input.relevanceScore ?? null,
      publishedAt: input.publishedAt ?? null,
      capturedAt,
    });
  }

  async get(id: string): Promise<ContentSignal | null> {
    const rows = await this.db.select().from(schema.contentSignals).where(eq(schema.contentSignals.id, id)).limit(1);
    return rows[0] ? this.toDomain(rows[0]) : null;
  }

  async list(filter: ContentSignalFilter = {}): Promise<ContentSignal[]> {
    const conditions = [];
    if (filter.signalType) conditions.push(eq(schema.contentSignals.signalType, filter.signalType));
    if (filter.prospectId) conditions.push(eq(schema.contentSignals.prospectId, filter.prospectId));
    if (filter.accountId) conditions.push(eq(schema.contentSignals.accountId, filter.accountId));
    if (filter.painCategory) conditions.push(eq(schema.contentSignals.painCategory, filter.painCategory));

    const query = this.db
      .select()
      .from(schema.contentSignals)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(schema.contentSignals.capturedAt));

    const rows = filter.limit ? await query.limit(filter.limit) : await query;
    return rows.map((r) => this.toDomain(r));
  }

  private toDomain(row: typeof schema.contentSignals.$inferSelect): ContentSignal {
    return {
      id: row.id,
      signalType: row.signalType,
      sourceType: row.sourceType,
      sourceUrl: row.sourceUrl,
      prospectId: row.prospectId,
      accountId: row.accountId,
      authorUsername: row.authorUsername,
      companyName: row.companyName,
      topic: row.topic,
      painCategory: row.painCategory as ContentSignal['painCategory'],
      confidence: row.confidence,
      excerpt: row.excerpt,
      extraction: row.extraction ? JSON.parse(row.extraction) : null,
      engagement: {
        likes: row.engagementLikes,
        replies: row.engagementReplies,
        reposts: row.engagementReposts,
        bookmarks: row.engagementBookmarks,
        views: row.engagementViews,
      },
      relevanceScore: row.relevanceScore,
      publishedAt: row.publishedAt,
      capturedAt: row.capturedAt,
    };
  }
}
