import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import type { MetrivioDb } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { OwnContentPerformanceService } from '../../src/own-content/own-content-performance-service.js';
import { GrowthTechniqueLearningService } from '../../src/analytics/growth-technique-learning-service.js';
import { GrowthTechniqueLibrary } from '../../src/growth-techniques/growth-technique-library.js';

let db: MetrivioDb;
let sqlite: Database.Database;
let performance: OwnContentPerformanceService;
let learning: GrowthTechniqueLearningService;
let library: GrowthTechniqueLibrary;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  performance = new OwnContentPerformanceService(db);
  learning = new GrowthTechniqueLearningService(db);
  library = new GrowthTechniqueLibrary(db);
});

afterEach(() => sqlite.close());

async function ingestPosts(count: number, text: string, impressions: number | null = 1000) {
  for (let i = 0; i < count; i++) {
    await performance.ingestSnapshot({ postId: uuid(), text, impressions: impressions ?? undefined });
  }
}

describe('GrowthTechniqueLearningService.learnFromOwnPerformance', () => {
  it('records UNVERIFIED for a hook type with only 1-2 observations', async () => {
    await ingestPosts(1, 'Is CAC climbing for you too?');
    await learning.learnFromOwnPerformance();
    const techniques = await library.list({ category: 'hook' });
    const questionHook = techniques.find((t) => t.technique.startsWith('question_hook'));
    expect(questionHook?.status).toBe('UNVERIFIED');
  });

  it('never promotes a technique to OBSERVED merely from repetition without performance data', async () => {
    await ingestPosts(4, 'Is CAC climbing for you too?', null); // no impressions -> no scoreable performance data
    await learning.learnFromOwnPerformance();
    const techniques = await library.list({ category: 'hook' });
    const questionHook = techniques.find((t) => t.technique.startsWith('question_hook'));
    expect(questionHook?.status).not.toBe('OBSERVED');
  });

  it('promotes to OBSERVED once there are 3+ observations AND real performance data', async () => {
    await ingestPosts(3, 'Is CAC climbing for you too?', 1000);
    await learning.learnFromOwnPerformance();
    const techniques = await library.list({ category: 'hook' });
    const questionHook = techniques.find((t) => t.technique.startsWith('question_hook'));
    expect(questionHook?.status).toBe('OBSERVED');
  });

  it('always attributes evidence to "own published posts (aggregate)", never a named account', async () => {
    await ingestPosts(2, 'Is CAC climbing for you too?');
    const recorded = await learning.learnFromOwnPerformance();
    for (const t of recorded) {
      expect(t.exampleReference).toContain("Metrivio's own published posts");
    }
  });
});
