/**
 * Automation modes, per ARCHITECTURE.md §1.4 and §7.
 *
 * All three are first-class, fully supported end states — none is a
 * "stripped down" or discouraged path. `dry_run` is only the safe default
 * on first boot, not a ceiling on what the system can do.
 */
export const AUTOMATION_MODES = ['dry_run', 'approval_required', 'autonomous'] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

export function isAutomationMode(value: unknown): value is AutomationMode {
  return typeof value === 'string' && (AUTOMATION_MODES as readonly string[]).includes(value);
}

/**
 * The two subsystems that each carry their own, independently configurable
 * automation_mode (DATABASE.md `system_config`: `prospecting.outreach.automation_mode`,
 * `content.publishing.automation_mode`).
 */
export const AUTOMATION_SUBSYSTEMS = ['prospecting.outreach', 'content.publishing'] as const;
export type AutomationSubsystem = (typeof AUTOMATION_SUBSYSTEMS)[number];

/**
 * Session Health states, per ARCHITECTURE.md §3.5.
 */
export const SESSION_HEALTH_STATES = ['healthy', 'degraded', 'at_risk'] as const;
export type SessionHealthState = (typeof SESSION_HEALTH_STATES)[number];
