/**
 * @metrivio/prospecting — Stage 1 scaffold only.
 *
 * This package will hold the Discover → Enrich → Verify → Score →
 * Personalize → Outreach → Follow-up → Reply Detection → Stop/Continue
 * pipeline (ARCHITECTURE.md §3), built out across BUILD_PLAN.md Stages 4–9.
 *
 * Nothing functional lives here yet. It exists in Stage 1 so the monorepo's
 * workspace structure matches BUILD_PLAN.md Stage 1 exactly ("Initialize the
 * Node/TypeScript monorepo (workspaces: core, prospecting, content,
 * adapters, dashboard)"), and so later stages have a package to build into
 * rather than needing to scaffold one mid-stage.
 */
export const PROSPECTING_PACKAGE_STAGE = 'scaffold-only' as const;
