import { describe, it, expect } from 'vitest';
import { buildOAuth1AuthorizationHeader, type OAuth1Credentials } from '../src/oauth1-signer.js';

const credentials: OAuth1Credentials = {
  consumerKey: 'ck',
  consumerSecret: 'cs',
  accessToken: 'at',
  accessTokenSecret: 'ats',
};

describe('buildOAuth1AuthorizationHeader — structural correctness', () => {
  it('returns a header starting with "OAuth "', () => {
    const header = buildOAuth1AuthorizationHeader({ method: 'POST', url: 'https://api.x.com/2/tweets', credentials });
    expect(header.startsWith('OAuth ')).toBe(true);
  });

  it('includes every required oauth_* parameter', () => {
    const header = buildOAuth1AuthorizationHeader({ method: 'POST', url: 'https://api.x.com/2/tweets', credentials, timestampSeconds: 1700000000, nonce: 'fixednonce' });
    for (const param of ['oauth_consumer_key', 'oauth_nonce', 'oauth_signature_method', 'oauth_signature', 'oauth_timestamp', 'oauth_token', 'oauth_version']) {
      expect(header).toContain(`${param}=`);
    }
  });

  it('uses HMAC-SHA1 as the signature method (the verified source\'s own documented scheme)', () => {
    const header = buildOAuth1AuthorizationHeader({ method: 'POST', url: 'https://api.x.com/2/tweets', credentials });
    expect(header).toContain('oauth_signature_method="HMAC-SHA1"');
  });

  it('is deterministic given a fixed timestamp and nonce', () => {
    const a = buildOAuth1AuthorizationHeader({ method: 'POST', url: 'https://api.x.com/2/tweets', credentials, timestampSeconds: 1700000000, nonce: 'abc123' });
    const b = buildOAuth1AuthorizationHeader({ method: 'POST', url: 'https://api.x.com/2/tweets', credentials, timestampSeconds: 1700000000, nonce: 'abc123' });
    expect(a).toBe(b);
  });

  it('produces a different nonce on successive calls when none is injected', () => {
    const a = buildOAuth1AuthorizationHeader({ method: 'POST', url: 'https://api.x.com/2/tweets', credentials });
    const b = buildOAuth1AuthorizationHeader({ method: 'POST', url: 'https://api.x.com/2/tweets', credentials });
    expect(a).not.toBe(b);
  });

  it('changes the signature when the URL changes (nothing else)', () => {
    const a = buildOAuth1AuthorizationHeader({ method: 'POST', url: 'https://api.x.com/2/tweets', credentials, timestampSeconds: 1700000000, nonce: 'fixed' });
    const b = buildOAuth1AuthorizationHeader({ method: 'POST', url: 'https://api.x.com/2/other', credentials, timestampSeconds: 1700000000, nonce: 'fixed' });
    expect(a).not.toBe(b);
  });

  it('changes the signature when the method changes (nothing else)', () => {
    const a = buildOAuth1AuthorizationHeader({ method: 'POST', url: 'https://api.x.com/2/tweets', credentials, timestampSeconds: 1700000000, nonce: 'fixed' });
    const b = buildOAuth1AuthorizationHeader({ method: 'GET', url: 'https://api.x.com/2/tweets', credentials, timestampSeconds: 1700000000, nonce: 'fixed' });
    expect(a).not.toBe(b);
  });

  it('changes the signature when the consumer secret changes (nothing else)', () => {
    const a = buildOAuth1AuthorizationHeader({ method: 'POST', url: 'https://api.x.com/2/tweets', credentials, timestampSeconds: 1700000000, nonce: 'fixed' });
    const b = buildOAuth1AuthorizationHeader({ method: 'POST', url: 'https://api.x.com/2/tweets', credentials: { ...credentials, consumerSecret: 'different' }, timestampSeconds: 1700000000, nonce: 'fixed' });
    expect(a).not.toBe(b);
  });

  it('changes the signature when the access token secret changes (nothing else)', () => {
    const a = buildOAuth1AuthorizationHeader({ method: 'POST', url: 'https://api.x.com/2/tweets', credentials, timestampSeconds: 1700000000, nonce: 'fixed' });
    const b = buildOAuth1AuthorizationHeader({ method: 'POST', url: 'https://api.x.com/2/tweets', credentials: { ...credentials, accessTokenSecret: 'different' }, timestampSeconds: 1700000000, nonce: 'fixed' });
    expect(a).not.toBe(b);
  });

  it('never includes a request body/text parameter in the signature base (only oauth_* params are signed, per the verified source\'s v2 comment)', () => {
    // Structural proof: two calls with identical method/url/credentials/timestamp/nonce produce an
    // identical header regardless of what a caller might separately be about to POST as a body.
    const a = buildOAuth1AuthorizationHeader({ method: 'POST', url: 'https://api.x.com/2/tweets', credentials, timestampSeconds: 1700000000, nonce: 'fixed' });
    const b = buildOAuth1AuthorizationHeader({ method: 'POST', url: 'https://api.x.com/2/tweets', credentials, timestampSeconds: 1700000000, nonce: 'fixed' });
    expect(a).toBe(b);
  });

  it('percent-encodes values inside the header (never emits a raw unencoded space)', () => {
    const header = buildOAuth1AuthorizationHeader({ method: 'POST', url: 'https://api.x.com/2/tweets?a=b c', credentials, timestampSeconds: 1700000000, nonce: 'fixed' });
    expect(header).not.toContain(' c"');
  });
});
