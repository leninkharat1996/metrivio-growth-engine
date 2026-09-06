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

export interface InboxParticipant {
  id: string;
  username: string;
  name: string;
  avatar: string;
}

export interface InboxConversationSummary {
  conversationId: string;
  participants: InboxParticipant[];
  lastMessage: { text: string; createdAt: string; senderId: string };
  unreadCount: number;
  type: 'one_to_one' | 'group';
}

export interface GetInboxOptions {
  limit?: number;
  cursor?: string;
}

export interface GetInboxResult {
  conversations: InboxConversationSummary[];
  cursor: string | null;
}

export function getInbox(client: TwitterHttpClient, options?: GetInboxOptions): Promise<GetInboxResult>;

export interface ConversationMediaItem {
  type: string;
  url: string;
}

export interface ConversationReaction {
  emoji: string;
  senderId: string;
}

export interface ConversationMessage {
  id: string;
  text: string;
  senderId: string;
  createdAt: string;
  media: ConversationMediaItem[] | null;
  reactions: ConversationReaction[];
}

export interface GetConversationOptions {
  limit?: number;
  cursor?: string;
}

export interface GetConversationResult {
  messages: ConversationMessage[];
  cursor: string | null;
}

export function getConversation(
  client: TwitterHttpClient,
  conversationId: string,
  options?: GetConversationOptions
): Promise<GetConversationResult>;
