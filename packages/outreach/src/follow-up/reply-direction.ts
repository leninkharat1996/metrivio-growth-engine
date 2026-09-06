/**
 * Message direction classification (Stage 6C, Section B).
 *
 * Hard rule: direction is decided ONLY by comparing canonical X user IDs —
 * never a display name, username, message text, or ordering position.
 * Since Stage 6C's actual need is narrower than "classify every message
 * fully" — it only needs to positively identify PROSPECT messages (a
 * reply) — this function returns exactly two outcomes: `'prospect'` when
 * the sender's canonical ID matches the prospect's own `x_user_id`
 * (`prospects.x_user_id`, already captured during discovery/enrichment),
 * and `'unknown'` for everything else. It deliberately never returns an
 * "ours" classification by exclusion/default (e.g. "not the prospect, so
 * it must be us") — this codebase has no independently-verified "our own
 * account's X user ID" configured anywhere, and guessing direction from
 * absence of a match would be exactly the kind of unsafe inference this
 * stage's instructions forbid. Messages this function can't positively
 * attribute to the prospect are simply not treated as replies — which is
 * also why they are never written to `conversation_messages` by
 * `ReplyDetectionService` (that table's `direction` column only accepts
 * `'outbound'`/`'inbound'`, and this codebase never fabricates the
 * `'outbound'` half from an exclusion; Stage 6B's own send flow already
 * records outbound messages directly, from firsthand knowledge, not
 * inference).
 */

export type MessageDirectionClassification = 'prospect' | 'unknown';

export interface DirectionClassificationInput {
  senderXUserId: string | null | undefined;
  prospectXUserId: string | null | undefined;
}

export function classifyMessageDirection(input: DirectionClassificationInput): MessageDirectionClassification {
  const sender = (input.senderXUserId ?? '').trim();
  const prospect = (input.prospectXUserId ?? '').trim();
  if (sender.length === 0 || prospect.length === 0) return 'unknown';
  return sender === prospect ? 'prospect' : 'unknown';
}
