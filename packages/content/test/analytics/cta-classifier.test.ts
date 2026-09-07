import { describe, it, expect } from 'vitest';
import { classifyCtaType } from '../../src/analytics/cta-classifier.js';

describe('classifyCtaType', () => {
  it('classifies an explicit reply ask', () => {
    expect(classifyCtaType('What do you think? Reply below.')).toBe('reply_cta');
  });
  it('classifies a follow ask', () => {
    expect(classifyCtaType('Follow for more like this.')).toBe('follow_cta');
  });
  it('classifies a link-in-bio ask', () => {
    expect(classifyCtaType('Link in bio for the full breakdown.')).toBe('link_cta');
  });
  it('classifies a DM ask', () => {
    expect(classifyCtaType('DM me if you want to chat.')).toBe('dm_cta');
  });
  it('classifies a bare trailing question as question_cta', () => {
    expect(classifyCtaType('Is your CAC climbing too?')).toBe('question_cta');
  });
  it('classifies plain statement text with no CTA as none', () => {
    expect(classifyCtaType('CAC keeps climbing for most DTC brands.')).toBe('none');
  });
  it('prioritizes an explicit reply ask over a trailing question mark', () => {
    expect(classifyCtaType('Curious what you think — comment below?')).toBe('reply_cta');
  });
});
