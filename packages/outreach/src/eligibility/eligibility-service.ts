import { desc, eq } from 'drizzle-orm';
import { KillSwitch, SystemConfigService, schema, type MetrivioDb } from '@metrivio/core';
import { evaluateOutreachEligibility, type OutreachEligibilityResult } from './eligibility.js';

/**
 * The I/O layer around `evaluateOutreachEligibility()` — gathers its inputs
 * from the existing tables (`prospects`, `icp_scores`, `conversations`,
 * `evidence`, `pain_signals`) and the existing `KillSwitch`/
 * `SystemConfigService`, then hands them to the pure evaluator. This class
 * performs no writes and computes nothing scoring-related itself.
 */
export class OutreachEligibilityService {
  private readonly killSwitch: KillSwitch;
  private readonly config: SystemConfigService;

  constructor(private readonly db: MetrivioDb) {
    this.config = new SystemConfigService(db);
    this.killSwitch = new KillSwitch(this.config);
  }

  async evaluate(prospectId: string): Promise<OutreachEligibilityResult> {
    const prospectRows = await this.db.select().from(schema.prospects).where(eq(schema.prospects.id, prospectId)).limit(1);
    const prospect = prospectRows[0];
    if (!prospect) {
      throw new Error(`Cannot evaluate outreach eligibility: no prospect found with id ${prospectId}`);
    }

    const [latestScoreRows, latestConversationRows, evidenceRows, painSignalRows, killSwitchActive, outreachMinimumTier] = await Promise.all([
      this.db.select().from(schema.icpScores).where(eq(schema.icpScores.prospectId, prospectId)).orderBy(desc(schema.icpScores.scoredAt)).limit(1),
      this.db
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.prospectId, prospectId))
        .orderBy(desc(schema.conversations.lastMessageAt))
        .limit(1),
      this.db.select().from(schema.evidence).where(eq(schema.evidence.prospectId, prospectId)).limit(1),
      this.db.select().from(schema.painSignals).where(eq(schema.painSignals.prospectId, prospectId)).limit(1),
      this.killSwitch.isActive(),
      this.config.getOutreachMinimumTier(),
    ]);

    const latestScore = latestScoreRows[0];
    const latestConversation = latestConversationRows[0];

    return evaluateOutreachEligibility({
      outreachStatus: prospect.outreachStatus,
      latestIcpScore: latestScore ? { tier: latestScore.tier, exclusionTriggered: latestScore.exclusionTriggered } : null,
      latestConversation: latestConversation
        ? { state: latestConversation.state, classification: latestConversation.classification, lastMessageDirection: latestConversation.lastMessageDirection ?? null }
        : null,
      hasAnyEvidence: evidenceRows.length > 0 || painSignalRows.length > 0,
      killSwitchActive,
      outreachMinimumTier,
    });
  }
}
