import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDbClient, type MetrivioDb } from '@metrivio/core';
import type Database from 'better-sqlite3';

/**
 * Mirrors packages/{core,adapters,prospecting}/test/helpers/test-db.ts —
 * creates an in-memory SQLite database and applies every real migration in
 * drizzle/migrations, so these tests exercise the actual schema rather
 * than a hand-rolled approximation of it.
 */
export function createTestDb(): { db: MetrivioDb; sqlite: Database.Database } {
  const { db, sqlite } = createDbClient({ path: ':memory:' });
  migrate(db, { migrationsFolder: new URL('../../../../drizzle/migrations', import.meta.url).pathname });
  return { db, sqlite };
}
