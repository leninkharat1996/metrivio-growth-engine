import type { SystemConfigService } from '../config/system-config.js';
import type { createLogger } from '../logging/logger.js';

/**
 * Thrown when a write-adapter (or any other guarded) call is attempted while
 * the kill switch is active. Callers should let this propagate rather than
 * catching and retrying — a killed system must fail loudly, not silently
 * swallow the attempted action.
 */
export class KillSwitchActiveError extends Error {
  constructor(actionType: string) {
    super(`Kill switch is active — refusing to execute "${actionType}". Every write-adapter call must check this first (ARCHITECTURE.md §7).`);
    this.name = 'KillSwitchActiveError';
  }
}

/**
 * The kill switch is deliberately the simplest, most central control in the
 * system: one flag, checked before every write-adapter call, that overrides
 * `automation_mode`, daily limits, and everything else (ARCHITECTURE.md §7 —
 * "This is the one control that always overrides everything else").
 *
 * This class wraps SystemConfigService rather than re-implementing storage,
 * so there is exactly one source of truth for the flag's value.
 */
export class KillSwitch {
  constructor(
    private readonly config: SystemConfigService,
    private readonly logger?: ReturnType<typeof createLogger>
  ) {}

  async isActive(): Promise<boolean> {
    return this.config.isKillSwitchActive();
  }

  /**
   * Every write-adapter implementation (Stage 2+) must call this at the top
   * of every method that would send/post/DM/follow/etc. It throws rather
   * than returning a boolean specifically so a caller cannot accidentally
   * ignore the result — the only way past this line is for the switch to
   * genuinely be off.
   */
  async assertNotActive(actionType: string): Promise<void> {
    if (await this.isActive()) {
      throw new KillSwitchActiveError(actionType);
    }
  }

  async activate(updatedBy: string): Promise<void> {
    await this.config.setKillSwitch(true, updatedBy);
    this.logger?.warn({ updatedBy }, 'kill_switch.activated');
  }

  async deactivate(updatedBy: string): Promise<void> {
    await this.config.setKillSwitch(false, updatedBy);
    this.logger?.warn({ updatedBy }, 'kill_switch.deactivated');
  }
}
