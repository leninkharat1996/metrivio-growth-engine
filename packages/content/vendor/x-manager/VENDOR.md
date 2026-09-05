# Vendored: tylerbuilds/x-manager

**Vendored per BUILD_PLAN.md Stage 1:** "Vendor X-Manager as the `content`/publishing base (fork or git-subtree, pinned to a specific tag), rather than copy-pasting its code — keeps upstream security fixes mergeable."

- **Source:** https://github.com/tylerbuilds/x-manager
- **Pinned commit:** `a3534ba953fc88beac79fc12ca5ebbcd4f3bed2d`
- **Pinned version (package.json):** `0.2.0`
- **Vendored on:** 2026-09-05
- **License:** MIT (see `LICENSE` in this directory) — matches RESEARCH.md §3's finding, re-confirmed at vendor time.
- **Method:** plain source snapshot at the pinned commit (`.git` history removed to avoid a nested-repository inside this monorepo's own git tree). Upgrading later means re-cloning at a newer commit and diffing against this snapshot, or converting to a proper git subtree/submodule if closer upstream tracking becomes valuable.

## What this is for

Per ARCHITECTURE.md §6/§8, this vendored copy is the intended backend for the `XManagerWriteAdapter` implementation (official X API — posting, scheduling, replying) via its Bridge API. **No wiring has been done yet.** This is a Stage 1 vendoring step only:

- Its own `node_modules` were never installed here (no `npm install` was run inside this directory) — installing its dependency tree and actually running it is Stage 2+ work, not Stage 1.
- No environment variables, credentials, or `.env` files from this vendored app are configured.
- `@metrivio/content` does not yet import or call anything from this directory.

## License/content check (RISK_REGISTER.md §3A)

This vendored snapshot contains only X-Manager's own MIT-licensed source. It does **not** contain OpenTechAnalyzer's optional GPL-3.0 community fingerprint dataset (`enthec/webappanalyzer`) — that dataset is unrelated to X-Manager and is never pulled in by this vendoring step. RISK_REGISTER.md §3A's rule (never run `opentechalyzer db import` in a way that bundles GPL-3.0 data into a distributed artifact) remains relevant only to the OpenTechAnalyzer integration (Stage 2+), not to this vendored copy.
