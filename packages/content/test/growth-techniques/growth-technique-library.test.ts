import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { MetrivioDb } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { GrowthTechniqueLibrary, deriveTechniqueStatus } from '../../src/growth-techniques/growth-technique-library.js';

let db: MetrivioDb;
let sqlite: Database.Database;
let library: GrowthTechniqueLibrary;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  library = new GrowthTechniqueLibrary(db);
});

afterEach(() => sqlite.close());

describe('deriveTechniqueStatus', () => {
  it('is UNVERIFIED with fewer than 2 observations regardless of performance data', () => {
    expect(deriveTechniqueStatus(1, true)).toBe('UNVERIFIED');
    expect(deriveTechniqueStatus(0, false)).toBe('UNVERIFIED');
  });

  it('is LIKELY with 2+ observations but no performance data', () => {
    expect(deriveTechniqueStatus(2, false)).toBe('LIKELY');
  });

  it('is OBSERVED only with 3+ observations AND performance data', () => {
    expect(deriveTechniqueStatus(3, true)).toBe('OBSERVED');
    expect(deriveTechniqueStatus(3, false)).toBe('LIKELY');
  });

  it('never jumps straight to OBSERVED from a single data point', () => {
    expect(deriveTechniqueStatus(1, true)).not.toBe('OBSERVED');
  });
});

describe('GrowthTechniqueLibrary.record / list', () => {
  it('persists a technique and returns it with a generated id', async () => {
    const technique = await library.record({
      technique: 'numbered hook',
      category: 'hook',
      evidence: 'observed 5 times',
      applicability: 'use specific counts',
      status: 'LIKELY',
    });
    expect(technique.id).toBeTruthy();
  });

  it('filters by category', async () => {
    await library.record({ technique: 'a', category: 'hook', evidence: 'e', applicability: 'a', status: 'LIKELY' });
    await library.record({ technique: 'b', category: 'cta', evidence: 'e', applicability: 'a', status: 'LIKELY' });
    const hooks = await library.list({ category: 'hook' });
    expect(hooks).toHaveLength(1);
    expect(hooks[0].technique).toBe('a');
  });

  it('filters by status', async () => {
    await library.record({ technique: 'a', category: 'hook', evidence: 'e', applicability: 'a', status: 'OBSERVED' });
    await library.record({ technique: 'b', category: 'hook', evidence: 'e', applicability: 'a', status: 'UNVERIFIED' });
    const observed = await library.list({ status: 'OBSERVED' });
    expect(observed).toHaveLength(1);
  });

  it('never records source attribution to a named individual — exampleReference stays generic', async () => {
    const technique = await library.record({
      technique: 'contrarian hook',
      category: 'contrarian_content',
      evidence: 'observed across tracked accounts',
      applicability: 'state a defensible position',
      status: 'LIKELY',
      exampleReference: 'tracked expert accounts (aggregate, no individual attribution)',
    });
    expect(technique.exampleReference).not.toMatch(/@\w+/);
  });
});
