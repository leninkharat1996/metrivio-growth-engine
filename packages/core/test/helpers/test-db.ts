import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDbClient, type MetrivioDb } from '../../src/db/client.js';
import type Database from 'better-sqlite3';

/**
 * Creates an in-memory SQLite database and applies every real migration in
 * drizzle/migrations to it — the same migration path production uses
 * (scripts/migrate.ts), so tests exercise the actual schema rather than a
 * hand-rolled approximation of it.
 */
export function createTestDb(): { db: MetrivioDb; sqlite: Database.Database } {
  const { db, sqlite } = createDbClient({ path: ':memory:' });
  migrate(db, { migrationsFolder: new URL('../../../../drizzle/migrations', import.meta.url).pathname });
  return { db, sqlite };
}
