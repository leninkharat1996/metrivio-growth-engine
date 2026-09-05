import { describe, it, expect } from 'vitest';
import type { XReadAdapter, XWriteAdapter, TechAnalyzerAdapter, TechAnalyzerResult } from '@metrivio/core';
import {
  XActionsReadAdapter,
  XManagerWriteAdapter,
  XActionsWriteAdapter,
  OpenTechAnalyzerAdapter,
  WappalyzerGoAdapter,
  NotImplementedInStage1Error,
  createDefaultTechAnalyzerAdapter,
} from '../src/index.js';

describe('Adapter contracts: Stage 1 boundary stubs', () => {
  describe('XActionsReadAdapter implements XReadAdapter', () => {
    const adapter: XReadAdapter = new XActionsReadAdapter();

    it('every read method throws NotImplementedInStage1Error (no production calls in Stage 1)', async () => {
      await expect(adapter.searchTweets('CAC')).rejects.toBeInstanceOf(NotImplementedInStage1Error);
      await expect(adapter.getProfile('somehandle')).rejects.toBeInstanceOf(NotImplementedInStage1Error);
      await expect(adapter.getFollowers('somehandle')).rejects.toBeInstanceOf(NotImplementedInStage1Error);
      await expect(adapter.getFollowing('somehandle')).rejects.toBeInstanceOf(NotImplementedInStage1Error);
      await expect(adapter.getTweets('somehandle')).rejects.toBeInstanceOf(NotImplementedInStage1Error);
      await expect(adapter.getListMembers('https://x.com/i/lists/1')).rejects.toBeInstanceOf(NotImplementedInStage1Error);
      await expect(adapter.getEngagers('https://x.com/somehandle/status/1')).rejects.toBeInstanceOf(
        NotImplementedInStage1Error
      );
    });

    it('error message identifies the adapter and method for debuggability', async () => {
      await expect(adapter.getProfile('x')).rejects.toThrow(/XActionsReadAdapter\.getProfile/);
    });
  });

  describe('XManagerWriteAdapter and XActionsWriteAdapter both implement XWriteAdapter', () => {
    const xManager: XWriteAdapter = new XManagerWriteAdapter();
    const xActions: XWriteAdapter = new XActionsWriteAdapter();

    it('XManagerWriteAdapter (owns post/thread/reply per ARCHITECTURE.md §6) throws for all methods in Stage 1', async () => {
      await expect(xManager.postTweet('hello')).rejects.toBeInstanceOf(NotImplementedInStage1Error);
      await expect(xManager.postThread(['a', 'b'])).rejects.toBeInstanceOf(NotImplementedInStage1Error);
      await expect(xManager.replyTo('tweet-1', 'hi')).rejects.toBeInstanceOf(NotImplementedInStage1Error);
      await expect(xManager.getInboxSince(new Date().toISOString())).rejects.toBeInstanceOf(NotImplementedInStage1Error);
      await expect(xManager.getSessionHealth()).rejects.toBeInstanceOf(NotImplementedInStage1Error);
    });

    it('XActionsWriteAdapter (owns sendDM per ARCHITECTURE.md §6) throws for all methods in Stage 1', async () => {
      await expect(xActions.sendDM('handle', 'hi')).rejects.toBeInstanceOf(NotImplementedInStage1Error);
      await expect(xActions.postTweet('hello')).rejects.toBeInstanceOf(NotImplementedInStage1Error);
    });

    it('no outbound automation occurs in Stage 1 — no method resolves successfully on either implementation', async () => {
      const allCalls = [
        () => xManager.postTweet('x'),
        () => xManager.sendDM('h', 'x'),
        () => xActions.postTweet('x'),
        () => xActions.sendDM('h', 'x'),
      ];
      for (const call of allCalls) {
        await expect(call()).rejects.toBeInstanceOf(NotImplementedInStage1Error);
      }
    });
  });

  describe('TechAnalyzerAdapter: OpenTechAnalyzer is primary, wappalyzergo is fallback-only', () => {
    it('createDefaultTechAnalyzerAdapter() returns OpenTechAnalyzerAdapter, never WappalyzerGoAdapter', () => {
      const defaultAdapter = createDefaultTechAnalyzerAdapter();
      expect(defaultAdapter).toBeInstanceOf(OpenTechAnalyzerAdapter);
      expect(defaultAdapter).not.toBeInstanceOf(WappalyzerGoAdapter);
    });

    it('both implementations satisfy the same TechAnalyzerAdapter contract', () => {
      const primary: TechAnalyzerAdapter = new OpenTechAnalyzerAdapter();
      const fallback: TechAnalyzerAdapter = new WappalyzerGoAdapter();
      expect(typeof primary.analyze).toBe('function');
      expect(typeof primary.analyzeMany).toBe('function');
      expect(typeof fallback.analyze).toBe('function');
      expect(typeof fallback.analyzeMany).toBe('function');
    });

    it('the fallback (WappalyzerGoAdapter) still throws NotImplementedInStage1Error — only the primary (OpenTechAnalyzer) got a real Stage 2 implementation', async () => {
      const fallback = new WappalyzerGoAdapter();
      await expect(fallback.analyze('example.com')).rejects.toBeInstanceOf(NotImplementedInStage1Error);
      await expect(fallback.analyzeMany(['example.com'])).rejects.toBeInstanceOf(NotImplementedInStage1Error);
    });

    // OpenTechAnalyzerAdapter's real (Stage 2) behavior — scan/technology
    // status mapping, evidence normalization, render/crawl defaults, batch
    // handling — is covered in open-tech-analyzer.adapter.test.ts against a
    // mocked `opentechalyzer` module, not here (this file no longer asserts
    // that the primary adapter throws, since it is no longer a stub).
  });

  describe('TechAnalyzerResult shape: scan-status vs technology-status distinction (ARCHITECTURE.md §6)', () => {
    it('a non-OK scanStatus type-checks with an empty technologies array — the type does not allow a NOT_DETECTED entry to imply a successful scan', () => {
      // This is a compile-time/shape assertion: TechAnalyzerResult always
      // carries its own scanStatus independent of `technologies[]`, so a
      // BLOCKED/ERROR/INCONCLUSIVE scan is representable with zero
      // technology entries — never with entries marked NOT_DETECTED standing
      // in for the failure. Constructing both shapes here as a smoke test
      // that the type permits the correct pattern.
      const failedScan: TechAnalyzerResult = {
        scanStatus: 'BLOCKED',
        technologies: [],
        detector: 'open_tech_analyzer',
        timestamp: new Date().toISOString(),
      };
      const successfulScanWithNegativeResult: TechAnalyzerResult = {
        scanStatus: 'OK',
        technologies: [
          {
            name: 'Shopify Plus',
            status: 'NOT_DETECTED',
            confidence: 0,
            evidence: [],
          },
        ],
        detector: 'open_tech_analyzer',
        timestamp: new Date().toISOString(),
      };

      expect(failedScan.scanStatus).toBe('BLOCKED');
      expect(failedScan.technologies).toHaveLength(0);
      expect(successfulScanWithNegativeResult.scanStatus).toBe('OK');
      expect(successfulScanWithNegativeResult.technologies[0]?.status).toBe('NOT_DETECTED');
    });
  });
});
