import { describe, it, expect } from 'vitest';
import { classifyMessageDirection } from '../../src/follow-up/reply-direction.js';

describe('classifyMessageDirection', () => {
  it('classifies as prospect when the sender ID matches the prospects canonical ID', () => {
    expect(classifyMessageDirection({ senderXUserId: '200', prospectXUserId: '200' })).toBe('prospect');
  });

  it('classifies as unknown when the sender ID does not match (never assumed to be "ours")', () => {
    expect(classifyMessageDirection({ senderXUserId: '100', prospectXUserId: '200' })).toBe('unknown');
  });

  it('classifies as unknown when senderXUserId is missing', () => {
    expect(classifyMessageDirection({ senderXUserId: null, prospectXUserId: '200' })).toBe('unknown');
    expect(classifyMessageDirection({ senderXUserId: undefined, prospectXUserId: '200' })).toBe('unknown');
    expect(classifyMessageDirection({ senderXUserId: '', prospectXUserId: '200' })).toBe('unknown');
  });

  it('classifies as unknown when prospectXUserId is missing (identity cannot be established)', () => {
    expect(classifyMessageDirection({ senderXUserId: '200', prospectXUserId: null })).toBe('unknown');
    expect(classifyMessageDirection({ senderXUserId: '200', prospectXUserId: '' })).toBe('unknown');
  });

  it('is case-sensitive and exact — a near-match ID never counts (no fuzzy matching)', () => {
    expect(classifyMessageDirection({ senderXUserId: '2000', prospectXUserId: '200' })).toBe('unknown');
  });

  it('never uses message text, ordering, or any field besides the two canonical IDs', () => {
    // The function signature itself only accepts the two ID fields — this
    // test documents that guarantee rather than exercising a code branch.
    expect(classifyMessageDirection({ senderXUserId: '200', prospectXUserId: '200' })).toBe('prospect');
  });
});
