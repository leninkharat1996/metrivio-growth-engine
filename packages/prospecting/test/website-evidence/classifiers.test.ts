import { describe, it, expect } from 'vitest';
import {
  classifyEmployeeCountBand,
  classifyWarehouseFulfillmentSignal,
  classifyConfirmedRevenueStatement,
  classifyPublicVisibilityPressQuote,
  classifyPressAnnouncementTriggers,
  normalizeXHandle,
  isMatchingXHandle,
} from '../../src/website-evidence/classifiers.js';

describe('classifyEmployeeCountBand', () => {
  it('matches "team of 30 people" and reports it in-band (5-75)', () => {
    const result = classifyEmployeeCountBand('We are a team of 30 people building the future of skincare.');
    expect(result.matched).toBe(true);
    expect(result.employeeCount).toBe(30);
  });

  it('matches "45 employees" phrasing', () => {
    const result = classifyEmployeeCountBand('Our company has grown to 45 employees across three offices.');
    expect(result.matched).toBe(true);
    expect(result.employeeCount).toBe(45);
  });

  it('does not match a headcount above the 75 ceiling', () => {
    const result = classifyEmployeeCountBand('We are proud to be a team of 300 people.');
    expect(result.matched).toBe(false);
    expect(result.employeeCount).toBe(300);
  });

  it('does not match a headcount below the 5 floor', () => {
    const result = classifyEmployeeCountBand('Just a team of 2 people working out of a garage.');
    expect(result.matched).toBe(false);
    expect(result.employeeCount).toBe(2);
  });

  it('does not false-positive on an unrelated number (a year, a phone number)', () => {
    const result = classifyEmployeeCountBand('Founded in 2015, headquartered at 30 Main Street.');
    expect(result.matched).toBe(false);
    expect(result.employeeCount).toBeNull();
  });

  it('returns unmatched for empty/undefined text', () => {
    expect(classifyEmployeeCountBand(undefined).matched).toBe(false);
    expect(classifyEmployeeCountBand('').matched).toBe(false);
  });
});

describe('classifyWarehouseFulfillmentSignal', () => {
  it('matches "fulfillment center" language', () => {
    const result = classifyWarehouseFulfillmentSignal('Join our fulfillment center team in Ohio.');
    expect(result.matched).toBe(true);
  });

  it('matches "warehouse associate" job-posting language', () => {
    const result = classifyWarehouseFulfillmentSignal('Now hiring: Warehouse Associate, full-time, Columbus OH.');
    expect(result.matched).toBe(true);
  });

  it('does not match unrelated operational text', () => {
    const result = classifyWarehouseFulfillmentSignal('We ship worldwide with fast, reliable delivery.');
    expect(result.matched).toBe(false);
  });
});

describe('classifyConfirmedRevenueStatement', () => {
  it('matches an explicit first-party revenue figure', () => {
    const result = classifyConfirmedRevenueStatement('Last year we crossed $4.2 million in revenue.');
    expect(result.matched).toBe(true);
  });

  it('matches "$1.5M in annual sales" phrasing', () => {
    const result = classifyConfirmedRevenueStatement('The brand generated $1.5M in annual sales in its second year.');
    expect(result.matched).toBe(true);
  });

  it('does NOT match a funding/raise figure even though it mentions a dollar amount', () => {
    const result = classifyConfirmedRevenueStatement('We raised $5 million in revenue-based financing to fuel growth.');
    expect(result.matched).toBe(false);
    expect(result.reason).toMatch(/funding\/investment/);
  });

  it('does NOT match a valuation figure', () => {
    const result = classifyConfirmedRevenueStatement('Our Series A closed at a $20 million valuation, with strong revenue growth ahead.');
    expect(result.matched).toBe(false);
  });

  it('returns unmatched when no dollar figure is present', () => {
    const result = classifyConfirmedRevenueStatement('We are proud of our revenue growth this year.');
    expect(result.matched).toBe(false);
  });
});

describe('classifyPublicVisibilityPressQuote', () => {
  it('matches a full name near a quote mark and attribution verb', () => {
    const text = 'In a recent interview, Jane Founder said, "We built this company to solve a real problem for shoppers."';
    const result = classifyPublicVisibilityPressQuote(text, 'Jane Founder');
    expect(result.matched).toBe(true);
  });

  it('does not match when the name appears with no quote/attribution nearby', () => {
    const text = 'Jane Founder joined the company in 2019 as its first employee.';
    const result = classifyPublicVisibilityPressQuote(text, 'Jane Founder');
    expect(result.matched).toBe(false);
  });

  it('does not match when the name does not appear on the page at all', () => {
    const text = 'The team announced a new product line this week, quoted extensively in the press.';
    const result = classifyPublicVisibilityPressQuote(text, 'Jane Founder');
    expect(result.matched).toBe(false);
  });

  it('rejects a single-word name up front (never searches for a bare, ambiguous word)', () => {
    const text = '"This is huge for us," Jane said proudly.';
    const result = classifyPublicVisibilityPressQuote(text, 'Jane');
    expect(result.matched).toBe(false);
    expect(result.reason).toMatch(/single word/);
  });

  it('handles an empty/missing display name safely', () => {
    expect(classifyPublicVisibilityPressQuote('some text', null).matched).toBe(false);
    expect(classifyPublicVisibilityPressQuote('some text', undefined).matched).toBe(false);
  });
});

describe('normalizeXHandle / isMatchingXHandle', () => {
  it('normalizes a bare handle, an @-prefixed handle, and a full profile URL to the same value', () => {
    expect(normalizeXHandle('janefounder')).toBe('janefounder');
    expect(normalizeXHandle('@JaneFounder')).toBe('janefounder');
    expect(normalizeXHandle('https://x.com/JaneFounder')).toBe('janefounder');
    expect(normalizeXHandle('https://twitter.com/JaneFounder')).toBe('janefounder');
  });

  it('returns null for empty/undefined input', () => {
    expect(normalizeXHandle(undefined)).toBeNull();
    expect(normalizeXHandle('')).toBeNull();
  });

  it('matches equivalent handles regardless of casing/format', () => {
    expect(isMatchingXHandle('https://x.com/JaneFounder', 'janefounder')).toBe(true);
    expect(isMatchingXHandle('@janefounder', 'JaneFounder')).toBe(true);
  });

  it('does not match different handles', () => {
    expect(isMatchingXHandle('janefounder', 'someoneelse')).toBe(false);
  });
});

describe('classifyPressAnnouncementTriggers', () => {
  it('matches new_product_launch language', () => {
    const results = classifyPressAnnouncementTriggers('We just launched our new skincare line for sensitive skin.');
    expect(results.some((r) => r.triggerType === 'new_product_launch')).toBe(true);
  });

  it('matches store_brand_expansion language', () => {
    const results = classifyPressAnnouncementTriggers('Our products are now available in Canada and the UK.');
    expect(results.some((r) => r.triggerType === 'store_brand_expansion')).toBe(true);
  });

  it('matches funding_growth_announcement language', () => {
    const results = classifyPressAnnouncementTriggers('We raised $8 million to accelerate our growth.');
    expect(results.some((r) => r.triggerType === 'funding_growth_announcement')).toBe(true);
  });

  it('matches funnel_offer_change language', () => {
    const results = classifyPressAnnouncementTriggers('Introducing our new pricing plans, live today.');
    expect(results.some((r) => r.triggerType === 'funnel_offer_change')).toBe(true);
  });

  it('does NOT match a "coming soon" future-tense statement (not yet a completed event)', () => {
    const results = classifyPressAnnouncementTriggers('We just launched our new skincare line — coming soon to more retailers.');
    expect(results.some((r) => r.triggerType === 'new_product_launch')).toBe(false);
  });

  it('does NOT match a generic capability claim ("we ship nationwide")', () => {
    const results = classifyPressAnnouncementTriggers('We ship nationwide and offer free returns on every order.');
    expect(results).toHaveLength(0);
  });

  it('can match more than one trigger type on the same page', () => {
    const results = classifyPressAnnouncementTriggers(
      'We just launched our new product line. We also raised $3 million in seed funding this year.'
    );
    const types = results.map((r) => r.triggerType);
    expect(types).toContain('new_product_launch');
    expect(types).toContain('funding_growth_announcement');
  });

  it('returns an empty array for empty/undefined text', () => {
    expect(classifyPressAnnouncementTriggers(undefined)).toEqual([]);
    expect(classifyPressAnnouncementTriggers('')).toEqual([]);
  });
});
