import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDbClient, type MetrivioDb } from '@metrivio/core';
import type Database from 'better-sqlite3';

/** Mirrors packages/{core,adapters,prospecting,outreach,content}/test/helpers/test-db.ts. */
export function createTestDb(): { db: MetrivioDb; sqlite: Database.Database } {
  const { db, sqlite } = createDbClient({ path: ':memory:' });
  migrate(db, { migrationsFolder: new URL('../../../../drizzle/migrations', import.meta.url).pathname });
  return { db, sqlite };
}
