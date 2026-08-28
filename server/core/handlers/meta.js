// server/core/handlers/meta.js — GET /api/v1/meta.  LZP-206 · ADR 003 §3, §4 · RELEASE §7.4.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SMALLEST HANDLER, AND THE ONLY ONE THAT MUST WORK WHEN NOTHING ELSE DOES
// ─────────────────────────────────────────────────────────────────────────────
//
// Four constants and a clock. It looks like a health check, and it is not one — it is load
// bearing in three separate places:
//
//   1. **22.7's plain sentence.** A client below `PROTO_MIN` is refused everywhere else with
//      426. `meta` is where it reads `minProto` and `minClientVersion` so the outdated screen
//      (deliverable 26, i18n `updateRequired`) can name a version instead of saying "something
//      went wrong". This is why `version.js` lists `meta` in `VERSION_EXEMPT`: gating the
//      endpoint that explains the gate is a closed loop with the family inside it.
//   2. **The post-deploy smoke test** (RELEASE §7.4) reads `{region, minProto, maxProto,
//      serverTime}` and asserts Frankfurt, the N−1 window, "and that nothing family-shaped leaks
//      from an unauthenticated endpoint".
//   3. **Story 21.3.** This is the one endpoint anyone on the internet can call. Whatever it
//      returns is public, forever, to everybody.
//
// So the interesting decisions here are all about what it does NOT do.
//
// ── IT TOUCHES NO STORE ──────────────────────────────────────────────────────
// No database read, no database write, no rate-limit bucket. `limits.js` RATE_COVERAGE records
// the reasoning in full and `tests/server/limits.test.js` calls this handler with a `ctx.store`
// that throws on every property access, so "meta works when Postgres is down" is asserted rather
// than assumed. A rate limiter here would be a `RateBucket` write — a database round trip — on
// the one endpoint whose job is to answer when the rest is failing.
//
// ── IT IS UNAUTHENTICATED, AND ANSWERS THE SAME THING TO EVERYONE ────────────
// No `ctx.auth`, therefore no nonce row, no signature verification, and — the part worth saying
// out loud — **no response that varies with who asked**. There is no space count, no member
// count, no build hash, no adapter name, no uptime, no queue depth. An observer learns the
// protocol window, the region, and roughly what time the server thinks it is. Every one of those
// is already public: the region is in the Datenschutz copy (21.3), the protocol window is in the
// response headers of every other endpoint, and the time is in every `Date:` header.
//
// PURITY (ADR 003 §9). `serverTime` comes from `ctx.now()`. A handler that reached for the wall
// clock directly would be untestable and would fail the ADR 005 §2 gate; more to the point, the
// fleet suite drives a fake clock and a handler that ignored it would make every timing
// assertion in the suite a coincidence.

import { PROTO_MIN, PROTO_MAX, versionHeaders } from '../version.js';

/**
 * The deployment region, in Vercel's spelling.
 *
 * Vercel says `fra1`, Prisma Postgres says `eu-central-1`, and both are Frankfurt — neither name
 * is a typo for the other (RELEASE §7.2 step 5). This constant is the Vercel one because that is
 * what `server/vercel.json` pins and what `.github/scripts/check-server-config.mjs` refuses to
 * let through as anything else (decision D2, addendum §9).
 *
 * It is duplicated from `vercel.json` rather than read from it, because a handler may not touch
 * the filesystem. `tests/server/limits.test.js` reads `server/vercel.json` and asserts the two
 * agree, so the duplication cannot drift — and if it ever did, the Datenschutz text that tells
 * the family their data is in Frankfurt would become false, which is the reason the deploy
 * pre-flight treats this value as a blocking check rather than a preference.
 */
export const REGION = 'fra1';

/** Exactly the keys ADR 003 §3 and RELEASE §7.4 name. The test asserts the set, not a subset. */
export const META_KEYS = Object.freeze(['region', 'minProto', 'maxProto', 'serverTime']);

/**
 * GET /api/v1/meta
 *
 * @param {Object} _req a ServerReq — unused: the answer does not depend on the request
 * @param {Object} ctx a ServerCtx; only `ctx.now` is read
 * @returns {Promise<{status:number, headers:Object<string,string>, body:Object}>}
 */
export async function meta(_req, ctx) {
  return {
    status: 200,
    headers: versionHeaders(),
    body: {
      region: REGION,
      minProto: PROTO_MIN,
      maxProto: PROTO_MAX,
      serverTime: ctx.now(),
    },
  };
}

export default meta;
