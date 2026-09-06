import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { schema, type MetrivioDb } from '@metrivio/core';

/**
 * Stage 6B deliberately does not build a sequence/campaign authoring UI —
 * that is Stage 8's full "Outreach Engine" (multi-step, day-offset-based
 * sequences). What Stage 6B needs is much narrower: a single, explicit,
 * human-approved DM per prospect, with no follow-up. `outreach_messages`
 * (DATABASE.md §2) already fully represents "one message sent through one
 * channel," but its `sequence_id`/`sequence_step_order` columns are
 * `NOT NULL` and its own `(prospect_id, sequence_id, sequence_step_order)`
 * unique index is *exactly* the duplicate-send backstop Section F of this
 * stage's instructions asks for ("Use existing database state/audit
 * patterns") — so rather than widen the schema, this module finds-or-lazily-
 * creates ONE well-known `sequences` row (name `'stage_6b_manual_send'`,
 * a genuine one-step sequence) and every Stage 6B send always uses
 * `sequence_step_order = 1` against it. The unique index then means a
 * prospect can never receive more than one Stage 6B manual send — which is
 * the correct behavior for this stage (no follow-ups), not an accidental
 * side effect of reusing the table this way.
 */
export const MANUAL_SEND_SEQUENCE_NAME = 'stage_6b_manual_send';
export const MANUAL_SEND_STEP_ORDER = 1;

export async function getOrCreateManualSendSequenceId(db: MetrivioDb): Promise<string> {
  const existing = await db.select().from(schema.sequences).where(eq(schema.sequences.name, MANUAL_SEND_SEQUENCE_NAME)).limit(1);
  if (existing[0]) return existing[0].id;

  const id = uuid();
  await db.insert(schema.sequences).values({
    id,
    name: MANUAL_SEND_SEQUENCE_NAME,
    steps: JSON.stringify([{ step_order: MANUAL_SEND_STEP_ORDER, day_offset: 0, template_id: 'manual-approved-draft', stop_conditions: [] }]),
    active: true,
  });
  return id;
}
