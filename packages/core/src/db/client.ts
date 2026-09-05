import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';

export type MetrivioDb = ReturnType<typeof drizzle<typeof schema>>;

export interface DbClientOptions {
  /** Path to the SQLite file. Use ':memory:' for tests. */
  path: string;
}

/**
 * Creates the database connection. WAL mode is enabled per DATABASE.md
 * ("Engine: SQLite (WAL mode)") for concurrent read/write performance and to
 * match the vendored X-Manager instance's own approach.
 */
export function createDbClient(options: DbClientOptions): { db: MetrivioDb; sqlite: Database.Database } {
  if (options.path !== ':memory:') {
    mkdirSync(dirname(options.path), { recursive: true });
  }

  const sqlite = new Database(options.path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

export * as schema from './schema.js';
