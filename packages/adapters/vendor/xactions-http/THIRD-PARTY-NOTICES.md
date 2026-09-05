# Third-Party Notices — vendored xactions-http subtree

This directory vendors a subset of `nirholas/xactions` (Apache-2.0 — see `LICENSE`). That project's own
`THIRD-PARTY-NOTICES.md` records further upstream attributions for code/data incorporated into the files
vendored here. The entries relevant to this subtree are reproduced below verbatim from upstream's
`THIRD-PARTY-NOTICES.md` at commit `52fbf89991668d58f7a9e7abbed4441734f87c01`; entries about files not
vendored here (e.g. streaming, skills, MCP packaging) are omitted.

| Upstream | Licence | What was used | Where (in this vendored subtree) |
|---|---|---|---|
| [fa0311/TwitterInternalAPIDocument](https://github.com/fa0311/TwitterInternalAPIDocument) | MIT | The GraphQL operation table (query ID, operation name, type), the feature-switch values and field-toggle names x.com's own client sends, and the v1.1 REST dispatch table, from `docs/json/GraphQL.json` and `docs/json/v1.1.json` on the `develop` branch. Regenerated upstream by `npm run sync:endpoints` (not re-run here; this is a static snapshot). | `src/scrapers/twitter/http/x-endpoints.generated.js` |
| [fa0311/latest-user-agent](https://github.com/fa0311/latest-user-agent) | MIT | Current browser User-Agent strings and the request headers that accompany them, including the `Sec-CH-UA` brand lists, from `output.json` and `header.json`. Regenerated upstream by `npm run sync:user-agents` (not re-run here; this is a static snapshot). | `src/client/auth/userAgents.generated.js` |
| [Lqm1/x-client-transaction-id](https://github.com/Lqm1/x-client-transaction-id) | MIT (Copyright 2025 Lami) | The `x-client-transaction-id` algorithm: key-byte index extraction from the `ondemand.s` chunk, the cubic-bezier animation key, and the SHA-256 plus XOR payload assembly, ported to plain regex reads. | `src/scrapers/twitter/http/transactionId.js` |
| [fa0311/x-client-transaction-id-pair-dict](https://github.com/fa0311/x-client-transaction-id-pair-dict) | MIT | Publishing known-good `{animationKey, verification}` pairs so a cold start can sign a request without parsing x.com's bundles; upstream reads the published dictionary at runtime and vendors none of it — same is true here. | `src/scrapers/twitter/http/transactionId.js` |

No other third-party code or data (beyond `nirholas/xactions`'s own Apache-2.0-licensed original work) is
present in the files vendored under this directory.
