import { describe, it, expect } from 'vitest';
import { classifyHookType } from '../../src/hooks/hook-classifier.js';

describe('classifyHookType', () => {
  it('classifies a question hook', () => {
    expect(classifyHookType('Why does blended ROAS lie to you?')).toBe('question_hook');
  });

  it('classifies a numbered hook', () => {
    expect(classifyHookType('3 mistakes DTC founders make with attribution')).toBe('numbered_hook');
  });

  it('classifies a contrarian hook', () => {
    expect(classifyHookType('Unpopular opinion: ROAS is a vanity metric')).toBe('contrarian_hook');
  });

  it('falls back to a statement hook', () => {
    expect(classifyHookType('We shipped a new dashboard today.')).toBe('statement_hook');
  });

  it('is deterministic', () => {
    const text = 'How do you actually measure incrementality?';
    expect(classifyHookType(text)).toBe(classifyHookType(text));
  });

  it('never reproduces or alters the input text — it only returns a label', () => {
    const text = 'a very specific distinctive voice line that should never be echoed back';
    const result = classifyHookType(text);
    expect(result).not.toContain('distinctive voice');
  });
});
