import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { schema, type MetrivioDb } from '@metrivio/core';
import type { TrackedAccount, TrackedAccountInput, TrackedAccountType } from './tracked-account.js';

/**
 * Persistence for `content_tracked_accounts` (Stage 7 schema addition) —
 * shared by both competitor and expert discovery/intelligence, since a
 * "tracked non-outreach account" is the exact same shape for either
 * (Section F/H). Never used for an ICP account — those reuse `prospects`
 * directly (Section A).
 */
export class TrackedAccountStore {
  constructor(private readonly db: MetrivioDb) {}

  async findByUsername(xUsername: string): Promise<TrackedAccount | null> {
    const rows = await this.db.select().from(schema.contentTrackedAccounts).where(eq(schema.contentTrackedAccounts.xUsername, xUsername)).limit(1);
    return rows[0] ? this.toDomain(rows[0]) : null;
  }

  async getById(id: string): Promise<TrackedAccount | null> {
    const rows = await this.db.select().from(schema.contentTrackedAccounts).where(eq(schema.contentTrackedAccounts.id, id)).limit(1);
    return rows[0] ? this.toDomain(rows[0]) : null;
  }

  async create(input: TrackedAccountInput): Promise<TrackedAccount> {
    const existing = await this.findByUsername(input.xUsername);
    if (existing) return existing; // idempotent — never a duplicate tracked-account row for the same handle

    const id = uuid();
    const discoveredAt = new Date().toISOString();
    await this.db.insert(schema.contentTrackedAccounts).values({
      id,
      accountType: input.accountType,
      xUsername: input.xUsername,
      xUserId: input.xUserId ?? undefined,
      displayName: input.displayName ?? undefined,
      companyName: input.companyName ?? undefined,
      classificationReason: input.classificationReason,
      classificationConfidence: input.classificationConfidence,
      active: true,
      discoveredAt,
    });
    return { id, ...input, active: true, discoveredAt };
  }

  async listByType(accountType: TrackedAccountType): Promise<TrackedAccount[]> {
    const rows = await this.db.select().from(schema.contentTrackedAccounts).where(and(eq(schema.contentTrackedAccounts.accountType, accountType), eq(schema.contentTrackedAccounts.active, true)));
    return rows.map((r) => this.toDomain(r));
  }

  private toDomain(row: typeof schema.contentTrackedAccounts.$inferSelect): TrackedAccount {
    return {
      id: row.id,
      accountType: row.accountType,
      xUsername: row.xUsername,
      xUserId: row.xUserId,
      displayName: row.displayName,
      companyName: row.companyName,
      classificationReason: row.classificationReason,
      classificationConfidence: row.classificationConfidence,
      active: row.active,
      discoveredAt: row.discoveredAt,
    };
  }
}
