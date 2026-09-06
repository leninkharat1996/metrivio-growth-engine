import { describe, it, expect } from 'vitest';
import { classifyOptOutIntent } from '../../src/follow-up/opt-out-classifier.js';

describe('classifyOptOutIntent — explicit opt-out phrases', () => {
  it('matches "please stop contacting me"', () => {
    expect(classifyOptOutIntent('please stop contacting me').isOptOut).toBe(true);
  });

  it('matches "stop messaging me"', () => {
    expect(classifyOptOutIntent('Can you stop messaging me?').isOptOut).toBe(true);
  });

  it('matches "do not contact me"', () => {
    expect(classifyOptOutIntent('Do not contact me again.').isOptOut).toBe(true);
  });

  it('matches "don\'t contact me" (contraction)', () => {
    expect(classifyOptOutIntent("Please don't contact me anymore.").isOptOut).toBe(true);
  });

  it('matches "remove me from your list"', () => {
    expect(classifyOptOutIntent('Please remove me from your list.').isOptOut).toBe(true);
  });

  it('matches "unsubscribe"', () => {
    expect(classifyOptOutIntent('unsubscribe').isOptOut).toBe(true);
  });

  it('matches "not interested, don\'t follow up"', () => {
    expect(classifyOptOutIntent("Not interested, don't follow up.").isOptOut).toBe(true);
  });

  it('matches "leave me alone"', () => {
    expect(classifyOptOutIntent('Seriously, leave me alone.').isOptOut).toBe(true);
  });

  it('matches "no more messages"', () => {
    expect(classifyOptOutIntent('No more messages, please.').isOptOut).toBe(true);
  });

  it('matches "take me off your list"', () => {
    expect(classifyOptOutIntent('Take me off your list.').isOptOut).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(classifyOptOutIntent('STOP CONTACTING ME').isOptOut).toBe(true);
  });

  it('handles punctuation variations', () => {
    expect(classifyOptOutIntent('please, do not contact me!!').isOptOut).toBe(true);
  });
});

describe('classifyOptOutIntent — false positives (ordinary rejection is NOT opt-out)', () => {
  it('"not interested" alone is not an opt-out', () => {
    expect(classifyOptOutIntent('not interested').isOptOut).toBe(false);
  });

  it('"no thanks" is not an opt-out', () => {
    expect(classifyOptOutIntent('no thanks, not for us right now').isOptOut).toBe(false);
  });

  it('a polite decline without a no-further-contact phrase is not an opt-out', () => {
    expect(classifyOptOutIntent("Thanks but we're all set on this for now.").isOptOut).toBe(false);
  });

  it('"maybe later" is not an opt-out', () => {
    expect(classifyOptOutIntent('Maybe later, not right now.').isOptOut).toBe(false);
  });

  it('the word "stop" alone, unrelated to contact, is not an opt-out', () => {
    expect(classifyOptOutIntent('This will stop working if you change the settings.').isOptOut).toBe(false);
  });

  it('the word "remove" in an unrelated context is not an opt-out', () => {
    expect(classifyOptOutIntent('Can you remove the old logo from the deck?').isOptOut).toBe(false);
  });

  it('a question about unsubscribing from something else is not treated as this conversations opt-out beyond the literal word match (documented: "unsubscribe" alone is intentionally always treated as explicit)', () => {
    // "unsubscribe" is kept as an unambiguous standalone trigger per the
    // spec's own example list — this test documents that deliberate
    // choice rather than asserting a false negative.
    expect(classifyOptOutIntent('how do I unsubscribe from this?').isOptOut).toBe(true);
  });

  it('empty/whitespace text is never an opt-out', () => {
    expect(classifyOptOutIntent('').isOptOut).toBe(false);
    expect(classifyOptOutIntent('   ').isOptOut).toBe(false);
    expect(classifyOptOutIntent(null).isOptOut).toBe(false);
    expect(classifyOptOutIntent(undefined).isOptOut).toBe(false);
  });

  it('a message merely containing "interested" positively is not an opt-out', () => {
    expect(classifyOptOutIntent('Actually I am interested, tell me more.').isOptOut).toBe(false);
  });
});
