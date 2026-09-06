import { describe, it, expect } from 'vitest';
import { resolveDomainFromWebsite, resolveCompanyNameFromBio } from '../../src/discovery/company-domain.js';

describe('resolveDomainFromWebsite', () => {
  it('website-derived domain: normalizes protocol, www, and casing', () => {
    expect(resolveDomainFromWebsite('https://www.Example-Store.com').domain).toBe('example-store.com');
    expect(resolveDomainFromWebsite('http://example-store.com').domain).toBe('example-store.com');
    expect(resolveDomainFromWebsite('example-store.com').domain).toBe('example-store.com');
  });

  it('strips a path/query, keeping only the hostname', () => {
    expect(resolveDomainFromWebsite('https://example-store.com/about?ref=bio').domain).toBe('example-store.com');
  });

  it('no domain: an absent website resolves to unresolved, not an error', () => {
    const result = resolveDomainFromWebsite(undefined);
    expect(result.domain).toBeNull();
    expect(result.source).toBe('unresolved');
  });

  it('malformed/unsupported website value resolves to unresolved with a reason, never a guessed domain', () => {
    const result = resolveDomainFromWebsite('not a url at all !!!');
    expect(result.domain).toBeNull();
    expect(result.rejectedReason).toBeDefined();
  });

  it('social URL rejected as a company domain (Instagram)', () => {
    const result = resolveDomainFromWebsite('https://instagram.com/examplestore');
    expect(result.domain).toBeNull();
    expect(result.rejectedReason).toMatch(/social\/link-aggregator/);
  });

  it('social URL rejected as a company domain (Linktree)', () => {
    const result = resolveDomainFromWebsite('https://linktr.ee/examplestore');
    expect(result.domain).toBeNull();
  });

  it('a real company domain that happens to be a www subdomain of a rejected host is still rejected (rejection is on the bare host)', () => {
    const result = resolveDomainFromWebsite('https://www.instagram.com/examplestore');
    expect(result.domain).toBeNull();
  });

  it('never derives a domain from a company name — only from the website field', () => {
    // No website at all, even with an unambiguous brand name elsewhere — must stay unresolved.
    const result = resolveDomainFromWebsite(null);
    expect(result.domain).toBeNull();
  });
});

describe('resolveCompanyNameFromBio', () => {
  it('explicit company identity: "Founder of Example Brand" extracts "Example Brand"', () => {
    const result = resolveCompanyNameFromBio('Founder of Example Brand, DTC skincare.');
    expect(result.companyName).toBe('Example Brand');
    expect(result.source).toBe('bio_mention');
  });

  it('explicit "@Brand" form extracts a handle-shaped company reference', () => {
    const result = resolveCompanyNameFromBio('Founder @ExampleStore');
    expect(result.companyName).toBe('ExampleStore');
  });

  it('unresolved: a bio with no explicit company mention returns null, not a guess', () => {
    const result = resolveCompanyNameFromBio('Coffee, dogs, and long walks on the beach.');
    expect(result.companyName).toBeNull();
    expect(result.source).toBe('unresolved');
  });

  it('a missing bio returns unresolved', () => {
    expect(resolveCompanyNameFromBio(undefined).companyName).toBeNull();
  });
});
