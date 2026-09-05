import type {
  XReadAdapter,
  XReadOptions,
  ProfileResult,
  TweetResult,
  AccountResult,
} from '@metrivio/core';
import { NotImplementedInStage1Error } from './not-implemented.js';

/**
 * XActions-backed implementation of XReadAdapter — discovery, enrichment,
 * and engagement reads (RESEARCH.md §2, ARCHITECTURE.md §6).
 *
 * Stage 1 boundary only: this class exists so the rest of the system can be
 * written and tested against the XReadAdapter interface, but it does not
 * call XActions, does not require XACTIONS_SESSION_COOKIE to be set, and
 * makes no network requests. Stage 2 replaces every method body with a real
 * call into a pinned XActions version, per BUILD_PLAN.md Stage 2.
 */
export class XActionsReadAdapter implements XReadAdapter {
  private static readonly NAME = 'XActionsReadAdapter';

  async searchTweets(_query: string, _opts?: XReadOptions): Promise<TweetResult[]> {
    throw new NotImplementedInStage1Error(XActionsReadAdapter.NAME, 'searchTweets');
  }

  async getProfile(_handle: string): Promise<ProfileResult> {
    throw new NotImplementedInStage1Error(XActionsReadAdapter.NAME, 'getProfile');
  }

  async getFollowers(_handle: string, _opts?: XReadOptions): Promise<AccountResult[]> {
    throw new NotImplementedInStage1Error(XActionsReadAdapter.NAME, 'getFollowers');
  }

  async getFollowing(_handle: string, _opts?: XReadOptions): Promise<AccountResult[]> {
    throw new NotImplementedInStage1Error(XActionsReadAdapter.NAME, 'getFollowing');
  }

  async getTweets(_handle: string, _opts?: XReadOptions): Promise<TweetResult[]> {
    throw new NotImplementedInStage1Error(XActionsReadAdapter.NAME, 'getTweets');
  }

  async getListMembers(_listUrl: string): Promise<AccountResult[]> {
    throw new NotImplementedInStage1Error(XActionsReadAdapter.NAME, 'getListMembers');
  }

  async getEngagers(_tweetUrl: string): Promise<AccountResult[]> {
    throw new NotImplementedInStage1Error(XActionsReadAdapter.NAME, 'getEngagers');
  }
}
