/**
 * @metrivio/dashboard — Stage 7 addition: a SMALL, read-only content-
 * intelligence dashboard (Section U). No publishing controls, no
 * interactivity, no new frontend framework — a plain HTML table/card
 * render of data already computed by `packages/content`.
 *
 * The original Stage 1 scope (extending the vendored X-Manager Next.js
 * dashboard with Prospects/Outreach/Conversations sections) remains
 * unbuilt — that is still future work, unrelated to this stage.
 */
export const DASHBOARD_PACKAGE_STAGE = 'stage-7-content-intelligence' as const;

export * from './dashboard-data-service.js';
export * from './dashboard-html-renderer.js';
