// server/api/v1/index.js — the Vercel function entry point.  ADR 003 §9 · ADR 005 §1.6.
//
// "~15 lines: normalise Request → ServerReq, build ctx with prismaStore(), run router, write
//  ServerRes back. **A bug in it cannot be a bug in a handler.**" — ADR 003 §9.
//
// ── WHY THIS IS index.js AND NOT A CATCH-ALL, measured 2026-09-05 ───────────────────────────
//
// It used to be `[[...path]].js`, then `[...path].js`. **Neither expanded on the deployed
// project**: exactly one segment after `/api/v1/` reached this function and everything deeper got
// Vercel's own NOT_FOUND page, never our code. That is over half the API — every space-scoped
// route lives at `/spaces/:id/<thing>` — and it looked healthy from outside, because `/meta` and
// `/ops` are single-segment and both answered correctly.
//
// Measured, not guessed. A plain static function three levels down (`api/v1/spaces/probe.js`)
// answered 200, so deep routing was never the problem and the filename was innocent; dynamic
// segment expansion was. And a temporary rewrite proved `req.url` survives one intact, query
// string included — which is the property this arrangement depends on:
//
//     direct     "url":"/api/v1/spaces/probe"
//     rewritten  "url":"/api/v1/probetest/spaces/spc_x/members?q=1"
//
// So the path is static (`api/v1/index.js` → `/api/v1`) and `vercel.json`'s single rewrite sends
// `/api/v1/(.*)` here. `adapters/vercel.js:142` reads `nodeReq.url` and routes on its pathname
// exactly as it does under `dev-server.mjs`, so the router sees the same URL in both hosts and
// there is no Vercel-shaped special case anywhere below this file.
//
// It is shorter than the ADR's estimate, because the normalisation, the ctx and the header policy
// live in `server/adapters/vercel.js`, which is testable. This file exists to be the PATH Vercel's
// router matches and to be nothing else. There
// is no logic here to get wrong: no route table (router.js), no auth (auth.js), no limits
// (limits.js), no composition (handlers/index.js). If this file were deleted and rewritten by
// someone who had never read the ADR, the worst they could do is change which URL prefix works.
//
// `config` is re-exported because Vercel reads it from the ENTRY module, not from an import:
// `runtime: 'nodejs'` (Prisma cannot run on Edge) and `bodyParser: false` (ADR 003 §2 signs the
// RAW bytes — see U-RAWBODY in the adapter).

export { config, default } from '../../adapters/vercel.js';
