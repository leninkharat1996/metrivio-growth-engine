import { z } from 'zod';
import { AUTOMATION_MODES } from '../automation/types.js';

/**
 * Every environment variable the system reads, with safe defaults, validated
 * with zod so a misconfigured deployment fails loudly at boot rather than
 * silently misbehaving. Nothing in here is a real secret — see .env.example.
 *
 * Per instruction #13 ("keep credentials out of source control") and
 * RISK_REGISTER.md #9: credential-shaped fields default to empty string, are
 * never given a non-empty fallback here, and this module never logs their
 * values (see assertNoSecretsInPayload in ../logging for the write-side
 * guard).
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_PATH: z.string().default('./var/metrivio.sqlite'),
  ENCRYPTION_KEY: z.string().default(''),

  PROSPECTING_OUTREACH_AUTOMATION_MODE: z.enum(AUTOMATION_MODES).default('dry_run'),
  CONTENT_PUBLISHING_AUTOMATION_MODE: z.enum(AUTOMATION_MODES).default('dry_run'),
  KILL_SWITCH: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),

  DAILY_LIMIT_DMS: z.coerce.number().int().nonnegative().default(5),
  DAILY_LIMIT_FOLLOWS: z.coerce.number().int().nonnegative().default(0),
  DAILY_LIMIT_POSTS: z.coerce.number().int().nonnegative().default(3),
  DAILY_LIMIT_SCRAPES: z.coerce.number().int().nonnegative().default(200),

  SESSION_HEALTH_AUTO_DOWNGRADE: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),

  // Credential-shaped values. Empty by default; presence is validated only
  // where a specific adapter is actually invoked (Stage 2+), not here — an
  // empty value at boot is expected and fine for a dry-run-only Stage 1 app.
  XACTIONS_SESSION_COOKIE: z.string().default(''),
  XACTIONS_CT0_TOKEN: z.string().default(''),
  X_API_KEY: z.string().default(''),
  X_API_SECRET: z.string().default(''),
  X_BEARER_TOKEN: z.string().default(''),
  X_MANAGER_ADMIN_TOKEN: z.string().default(''),
  X_MANAGER_ENCRYPTION_KEY: z.string().default(''),
  X_MANAGER_SESSION_SECRET: z.string().default(''),
  ANTHROPIC_API_KEY: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;

/**
 * Parses and validates process.env. Cached after first call so repeated
 * imports don't re-parse; pass `forceReload: true` (used in tests) to bypass
 * the cache when env vars change between test cases.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env, forceReload = false): Env {
  if (cachedEnv && !forceReload) return cachedEnv;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }
  cachedEnv = parsed.data;
  return cachedEnv;
}

/** Test/tooling helper to clear the cache between test cases. */
export function resetEnvCache(): void {
  cachedEnv = undefined;
}
