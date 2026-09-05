import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { assertNoSecretsInPayload } from '../src/logging/logger.js';

/** Captures pino's JSON output lines so we can assert on the redacted values. */
function createCapturingStream() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { stream, lines };
}

describe('logging: credential redaction', () => {
  it('redacts known credential-shaped fields at any nesting depth', () => {
    const { stream, lines } = createCapturingStream();
    const logger = pino(
      {
        redact: {
          paths: ['cookie', 'authToken', '*.apiKey', '*.sessionCookie'],
          censor: '[REDACTED]',
        },
      },
      stream
    );

    logger.info({ cookie: 'super-secret-cookie-value', authToken: 'abc123', unrelated: 'fine' }, 'test.log.line');
    logger.info({ account: { apiKey: 'sk-should-not-appear', sessionCookie: 'also-secret' } }, 'nested.log.line');

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].cookie).toBe('[REDACTED]');
    expect(parsed[0].authToken).toBe('[REDACTED]');
    expect(parsed[0].unrelated).toBe('fine');
    expect(parsed[1].account.apiKey).toBe('[REDACTED]');
    expect(parsed[1].account.sessionCookie).toBe('[REDACTED]');

    // Belt-and-braces: confirm the raw secret strings never appear anywhere
    // in the serialized output at all, not just at the expected key.
    const rawOutput = lines.join('\n');
    expect(rawOutput).not.toContain('super-secret-cookie-value');
    expect(rawOutput).not.toContain('sk-should-not-appear');
    expect(rawOutput).not.toContain('also-secret');
  });
});

describe('logging: assertNoSecretsInPayload (defense-in-depth guard for persisted payloads)', () => {
  it('allows a payload with no credential-shaped keys', () => {
    expect(() => assertNoSecretsInPayload({ prospectId: 'abc', action: 'sent' })).not.toThrow();
  });

  it('throws when a payload contains a credential-shaped key', () => {
    expect(() => assertNoSecretsInPayload({ apiKey: 'sk-123' })).toThrow(/credential-shaped/);
  });

  it('throws for common credential aliases (cookie, token, password, secret)', () => {
    expect(() => assertNoSecretsInPayload({ cookie: 'x' })).toThrow();
    expect(() => assertNoSecretsInPayload({ token: 'x' })).toThrow();
    expect(() => assertNoSecretsInPayload({ password: 'x' })).toThrow();
    expect(() => assertNoSecretsInPayload({ secret: 'x' })).toThrow();
  });

  it('is case-insensitive', () => {
    expect(() => assertNoSecretsInPayload({ ApiKey: 'x' })).toThrow();
  });
});
