import pino from 'pino';

/**
 * Field names that must never appear in a log line's value, anywhere in the
 * system. This list is intentionally broad — RISK_REGISTER.md #9 treats a
 * leaked session cookie or OAuth token as equivalent to full account takeover,
 * so redaction here is a hard guarantee, not a best effort.
 *
 * pino's `redact` option replaces matching paths with "[REDACTED]" rather
 * than omitting the key, so a redacted log line is still visible as evidence
 * that *something* was logged there, which is useful for debugging without
 * ever exposing the value itself.
 */
const REDACTED_PATHS = [
  'cookie',
  'sessionCookie',
  'authToken',
  'auth_token',
  'ct0',
  'ct0Token',
  'apiKey',
  'api_key',
  'apiSecret',
  'api_secret',
  'bearerToken',
  'bearer_token',
  'accessToken',
  'access_token',
  'encryptionKey',
  'encryption_key',
  'password',
  'secret',
  'token',
  '*.cookie',
  '*.sessionCookie',
  '*.authToken',
  '*.auth_token',
  '*.ct0',
  '*.apiKey',
  '*.api_key',
  '*.apiSecret',
  '*.api_secret',
  '*.bearerToken',
  '*.bearer_token',
  '*.accessToken',
  '*.access_token',
  '*.password',
  '*.secret',
  '*.token',
];

export interface LoggerOptions {
  level?: string;
  name?: string;
}

/**
 * Creates the shared structured logger. Every subsystem (prospecting,
 * content, adapters) should get its own child logger via `.child({...})`
 * rather than constructing a new root logger, so redaction rules and output
 * format stay consistent across the whole application.
 */
export function createLogger(options: LoggerOptions = {}) {
  return pino({
    name: options.name ?? 'metrivio',
    level: options.level ?? process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: REDACTED_PATHS,
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export const rootLogger = createLogger();

/**
 * Explicit helper for call sites that need to double-check a payload before
 * logging it (e.g. before writing to audit_log.detail, which DATABASE.md §4
 * requires to never contain credential material). This is a defense-in-depth
 * check on top of the logger's own redaction — belt and braces, since
 * audit_log rows are also read back and displayed in the dashboard, not just
 * written to a log stream.
 */
export function assertNoSecretsInPayload(payload: Record<string, unknown>): void {
  const suspiciousKeys = Object.keys(payload).filter((key) =>
    REDACTED_PATHS.some((path) => path.replace('*.', '').toLowerCase() === key.toLowerCase())
  );
  if (suspiciousKeys.length > 0) {
    throw new Error(
      `Refusing to persist payload containing credential-shaped key(s): ${suspiciousKeys.join(', ')}. ` +
        'This check exists because audit_log.detail and job payloads must never contain secrets (RISK_REGISTER.md #9).'
    );
  }
}
