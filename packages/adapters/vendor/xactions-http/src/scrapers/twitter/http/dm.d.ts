// Hand-authored by Metrivio — NOT part of the upstream xactions snapshot.
// See VENDOR.md "Hand-authored TypeScript declarations" for why this exists
// and what must be reviewed when the vendor pin is bumped.

import type { TwitterHttpClient } from './client.js';

export interface SendDMOptions {
  mediaId?: string;
}

export interface SendDMResult {
  messageId: string;
  createdAt: string;
}

export function sendDM(
  client: TwitterHttpClient,
  recipientId: string,
  text: string,
  options?: SendDMOptions
): Promise<SendDMResult>;
