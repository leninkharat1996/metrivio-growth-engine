import { v4 as uuid } from 'uuid';
import type { MetrivioDb } from './client.js';
import { auditLog } from './schema.js';
import { assertNoSecretsInPayload } from '../logging/logger.js';

export interface AuditLogEntry {
  actor: 'system' | 'human';
  actionType: string;
  entityType?: string;
  entityId?: string;
  detail?: Record<string, unknown>;
  dryRun?: boolean;
}

/**
 * The single write path for audit_log rows (DATABASE.md §4). Every write
 * action anywhere in the system should go through this, not raw inserts,
 * so the "never contains credentials, cookies, or tokens" rule is enforced
 * in exactly one place rather than trusted at every call site individually.
 */
export async function writeAuditLog(db: MetrivioDb, entry: AuditLogEntry): Promise<void> {
  if (entry.detail) {
    assertNoSecretsInPayload(entry.detail);
  }
  await db.insert(auditLog).values({
    id: uuid(),
    actor: entry.actor,
    actionType: entry.actionType,
    entityType: entry.entityType,
    entityId: entry.entityId,
    detail: entry.detail ? JSON.stringify(entry.detail) : null,
    dryRun: entry.dryRun ?? false,
    timestamp: new Date().toISOString(),
  });
}
