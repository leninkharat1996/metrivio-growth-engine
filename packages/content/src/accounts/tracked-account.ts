import type { ContentConfidenceLevel } from '../confidence.js';

export const TRACKED_ACCOUNT_TYPES = ['competitor', 'expert'] as const;
export type TrackedAccountType = (typeof TRACKED_ACCOUNT_TYPES)[number];

export interface TrackedAccountInput {
  accountType: TrackedAccountType;
  xUsername: string;
  xUserId?: string | null;
  displayName?: string | null;
  companyName?: string | null;
  classificationReason: string;
  classificationConfidence: ContentConfidenceLevel;
}

export interface TrackedAccount extends TrackedAccountInput {
  id: string;
  active: boolean;
  discoveredAt: string;
}
