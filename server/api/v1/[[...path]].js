// server/api/v1/[[...path]].js — the Vercel function entry point.  ADR 003 §9 · ADR 005 §1.6.
//
// "~15 lines: normalise Request → ServerReq, build ctx with prismaStore(), run router, write
//  ServerRes back. **A bug in it cannot be a bug in a handler.**" — ADR 003 §9.
//
// It is shorter than that, because the normalisation, the ctx and the header policy live in
// `server/adapters/vercel.js`, which is testable. This file exists to be the PATH Vercel's
// filesystem router matches (`/api/v1/*`, catch-all, all methods) and to be nothing else. There
// is no logic here to get wrong: no route table (router.js), no auth (auth.js), no limits
// (limits.js), no composition (handlers/index.js). If this file were deleted and rewritten by
// someone who had never read the ADR, the worst they could do is change which URL prefix works.
//
// `config` is re-exported because Vercel reads it from the ENTRY module, not from an import:
// `runtime: 'nodejs'` (Prisma cannot run on Edge) and `bodyParser: false` (ADR 003 §2 signs the
// RAW bytes — see U-RAWBODY in the adapter).

export { config, default } from '../../adapters/vercel.js';
