import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDbClient } from '../packages/core/src/db/client.js';
import { loadEnv } from '../packages/core/src/config/env.js';

/**
 * Applies every migration in drizzle/migrations to the database at
 * DATABASE_PATH. Safe to run repeatedly — drizzle tracks which migrations
 * have already been applied. This is what BUILD_PLAN.md Stage 1's exit
 * criteria means by "database migrates cleanly from empty."
 */
function main() {
  const env = loadEnv();
  const { db, sqlite } = createDbClient({ path: env.DATABASE_PATH });
  migrate(db, { migrationsFolder: './drizzle/migrations' });
  console.log(`Migrations applied successfully to ${env.DATABASE_PATH}`);
  sqlite.close();
}

main();
