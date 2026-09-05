import type { KillSwitch } from '../kill-switch/kill-switch.js';
import type { SystemConfigService } from '../config/system-config.js';
import type { AutomationMode, AutomationSubsystem } from './types.js';

export interface WriteGuardResult {
  mode: AutomationMode;
}

/**
 * The single choke point every write-adapter call (Stage 2+) and outreach/
 * publishing pipeline (Stage 8/11) must pass through before doing anything
 * that would touch X. It composes two independently-testable pieces —
 * KillSwitch and SystemConfigService — rather than duplicating either one's
 * logic, so there is exactly one place that decides "is this call allowed to
 * proceed, and in what mode."
 *
 * This class deliberately does NOT decide what a caller should do with each
 * mode (queue for approval vs. send immediately vs. log-and-simulate) — that
 * behavior belongs to the pipeline stage that has the actual send logic
 * (Stage 8 sequence engine, Stage 11 publishing integration). What this class
 * guarantees is that the kill switch is always checked first, and that the
 * mode returned always comes from SystemConfigService's fail-safe default
 * (`dry_run`) rather than an assumption baked into a caller.
 */
export class WriteGuard {
  constructor(
    private readonly killSwitch: KillSwitch,
    private readonly config: SystemConfigService
  ) {}

  /**
   * Throws KillSwitchActiveError if the kill switch is on (this always wins,
   * per ARCHITECTURE.md §7 — "the one control that always overrides
   * everything else"). Otherwise returns the current automation_mode for the
   * given subsystem, for the caller to act on.
   */
  async checkBeforeWrite(subsystem: AutomationSubsystem, actionType: string): Promise<WriteGuardResult> {
    await this.killSwitch.assertNotActive(actionType);
    const mode = await this.config.getAutomationMode(subsystem);
    return { mode };
  }
}
