// server/core/handlers/reports.js — the operator's three read routes.  LZP-1009 second pass.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THIS FILE REVERSES THE ROUTE TABLE'S WRITE-ONLY RULE, AND SAYS WHY IN ITS OWN WORDS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `router.js` used to state the rule in one sentence: *"a read-back turns a relay that takes
// custody into a relay that STORES reports addressably, and the two are different products."*
// **That sentence is correct. The PO has chosen the other product**, on 2026-09-04/05, and the
// argument is not that the old sentence was wrong — it is that all three of its supports have
// moved:
//
//   1. **The dangerous half was the UNAUTHENTICATED read-back.** What the rule actually
//      protected is "nobody can enumerate other people's complaints", and a P-256 verify against
//      a key this relay was configured with closes that STRUCTURALLY rather than by absence. The
//      surface a stranger can reach is unchanged: without the operator's private key, every
//      route in this file answers 401, and on a relay with no key configured it answers 404.
//   2. **The custody claim was ALREADY FALSE in the deployed relay.** `langzeitplaner.vercel.app`
//      binds no `feedbackSink` and answers an honest `501 not_implemented` to every report. The
//      choice on the table was never "custody or storage" — it was **a store with an operator, or
//      no feature at all**, and the report that matters most („ich komme nicht rein") is written
//      by a Mac with no family circle, which had no way to send it either.
//   3. **The property that must actually survive is preserved VERBATIM.** „A report never enters
//      the op log and can never appear on the family's board" is a fact about the `Report` model —
//      no `spaceId`, no relation to `Space` — and about who writes it: the **sink**, which is
//      server configuration, and never `handlers/feedback.js`. That handler is NOT TOUCHED by
//      this pass, and `tests/server/feedback.test.js` §4 — the POST handler run against a store
//      whose every other property throws — still passes unchanged. That row is the check that
//      storage did not break promise 1, and it is why this file is a second file.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// ██ THE OPERATOR IDENTITY — AND WHY IT IS NOT `Member.role` COMING BACK ██
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// This is the objection a reader of ADR 003 §5.1 will raise first, so it is answered before the
// code rather than after it.
//
// §5.1 removed `Member.role` because **the admin of a circle** is a fact about a family, it lives
// in the in-log chain (ADR 001 §4.1) inside ciphertext the relay may not read (story 21.1), and a
// column would have been the relay asserting something it cannot check. Finding E2-203-2 records
// the consequence and `store-interface.js` keeps `'role'` in `FORBIDDEN_COLUMN_TOKENS` so it
// cannot return by accident. **None of that changes here.**
//
// **Who operates this relay** is a different question with a different answer: it is SERVER
// CONFIGURATION, exactly like `ctx.feedbackSink`. There is no column, no row, no field in any
// body, and nothing a client can claim — the only place the operator's identity exists is one
// environment variable on the deployment, read by `server/adapters/vercel.js#buildCtx` and handed
// in on `ctx`. A caller cannot become the operator by asserting anything; they can only hold a
// private key or not.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE CREDENTIAL
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//     Authorization: LZPADMIN ts=<unixMillis>, nonce=<b64u16>, sig=<b64u64>
//
// **The header is reused deliberately.** `shell-macos`'s SSRF preflight allows exactly four
// header names on an outbound request, and adding a fifth would be a change to the allowlist that
// holds the family door — a much larger blast radius than a second scheme token. So the two
// schemes share one header and are told apart by the FIRST token, strictly:
// `auth.js#parseAuthorization` throws `401 bad_auth` on any scheme that is not `LZP1`, and
// `parseAdminAuthorization` below throws on any scheme that is not `LZPADMIN`. Neither parser can
// ever see the other's credential as its own, and `tests/server/reports.test.js` §2 asserts BOTH
// directions rather than one.
//
// **The signed bytes carry a third domain prefix**, `lzp/reports/v1\n` — a sibling of
// `auth.js`'s `lzp/v2\n` and of `handlers/feedback.js`'s `lzp/feedback/v1\n`, and deliberately
// neither a prefix nor a suffix of either. A signature made to delete a report must not verify as
// a sync request and vice versa; one shared prefix plus one field-order coincidence is all a
// cross-protocol replay needs.
//
// **Replay is the existing `Nonce` table, and there is NO SCHEMA CHANGE.** The namespace key is
// `deviceShortOfRaw(operatorPubKey)` — the same sixteen Crockford characters `Device.deviceShort`
// already holds, because the operator's key IS his device signing key. Sharing the namespace can
// only ever REFUSE MORE (a nonce spent on a sync request cannot be re-spent here), nothing new
// enters the table's alphabet, and `claimNonce`'s contract (store C46/C47) is used exactly as
// `auth.js` step 3 uses it.
//
// **An unconfigured relay answers 404, not 401.** A relay with no operator must not advertise an
// operator surface: 404 is the same answer it gives for `/api/v1/nope`, and it is what makes the
// three routes invisible on any deployment that has not opted in. A CONFIGURED relay answers 401
// to a bad credential, which does tell a prober that an operator exists — that is deliberate and
// it is in `ADMIN_PROVES_NOT`, because on a relay someone deployed for themselves the existence
// of an operator is implied by the deployment.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// PURITY (ADR 003 §9, ADR 005 §2). No clock beyond `ctx.now()`, no randomness, no I/O, no
// `process.env`, no `node:` import, no framework types. The env var is read in the ADAPTER.
// ═════════════════════════════════════════════════════════════════════════════════════════════

import { fail } from '../errors.js';
import { enforceFor } from '../limits.js';
import {
  ub64, b64u, verifySignature, deviceShortOfRaw, canonicalQuery, headerOf,
  B64U_RE, TS_RE, NONCE_BYTES, SIG_BYTES,
} from '../auth.js';
import { versionHeaders } from '../version.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. The honest sentences, on the wire
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What a `LZPADMIN` credential establishes. Published on every successful admin response, in
 * `handlers/feedback.js`'s own `PROVES`/`PROVES_NOT` idiom and for its reason: a demotion that
 * lives in a comment is a demotion the next reader does not see.
 */
export const ADMIN_PROVES = Object.freeze({
  operator:
    'the caller holds the private half of the P-256 key this relay was configured with '
    + '(LZP_REPORTS_ADMIN_PUB) and signed THIS method, path and query under the lzp/reports/v1 '
    + 'domain, inside the auth window, with a nonce this relay had not already seen',
});

/**
 * What it does NOT establish. An array rather than one string, because each clause is a separate
 * claim a separate row pins — a joined paragraph is a paragraph somebody edits in the middle.
 */
export const ADMIN_PROVES_NOT = Object.freeze([
  // ⚠ THE ONE THE PO ASKED FOR BY NAME, AND IT IS FIRST BECAUSE IT IS THE BIGGEST.
  'ANYTHING AGAINST THE PLATFORM. Whoever can set this relay\'s environment variables can also '
  + 'read its database directly, and can set LZP_REPORTS_ADMIN_PUB to a key of their own. This '
  + 'credential is a control against the internet, not against Vercel, not against the database '
  + 'host, and not against anyone with the deployment dashboard. It must not be read as '
  + 'protecting a report from the operator of the operator.',
  'that the caller is a family member, or that a family member could ever become the operator. '
  + 'A valid LZP1 device signature — any member, any device, any circle — is refused here: these '
  + 'routes never call ctx.auth, and the two Authorization grammars reject each other\'s scheme '
  + 'token outright.',
  'a role. There is no column, no row and no body field; nothing a client sends can make it the '
  + 'operator. ADR 003 §5.1\'s removal of Member.role is untouched — the admin of a CIRCLE is '
  + 'still resolved from the in-log chain, and `role` stays in FORBIDDEN_COLUMN_TOKENS.',
  'that a report is confidential once retained. A signed report\'s devicePub is byte-identical '
  + 'to Device.sigPubRaw, so one join names the member, her circle and her household. That is a '
  + 'property of RETENTION, not of this credential; it is a disclosure, and it belongs on the '
  + 'Datenschutz screen and in server-metadata.md §7 rather than being defended against here.',
  'anything if the private key leaks. It is his device signing key, in the login keychain of an '
  + 'unlocked Mac — an attacker holding it already holds that Mac, and everything on it.',
  'that the surface is invisible. A CONFIGURED relay answers 401 where an unconfigured one '
  + 'answers 404, so a prober can tell that an operator exists. Deliberate: hiding it would cost '
  + 'the honest 404 that keeps every other deployment free of the surface entirely.',
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. The credential grammar
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The scheme token. Not `LZP1`, and `auth.js#parseAuthorization:400` refuses it for that. */
export const ADMIN_SCHEME = 'LZPADMIN';

/** Exactly these three, each exactly once. No `device=`: the key is configuration, not a claim. */
export const ADMIN_PARAMS = Object.freeze(['ts', 'nonce', 'sig']);

/**
 * The third domain prefix. A sibling of `auth.js`'s `SIGNED_PREFIX` (`lzp/v2\n`) and
 * `handlers/feedback.js`'s `FEEDBACK_PREFIX` (`lzp/feedback/v1\n`), and neither a prefix nor an
 * extension of either — `tests/server/reports.test.js` §2f asserts all six pairwise relations.
 */
export const REPORTS_PREFIX = 'lzp/reports/v1\n';

/** ADR 002 §1 — an uncompressed P-256 point. */
const RAW_PUBKEY_BYTES = 65;

const TE = new TextEncoder();

/**
 * The exact bytes an admin signature covers.
 *
 *     "lzp/reports/v1\n" + METHOD + "\n" + path + "?" + sortedQuery + "\n" + ts + "\n" + nonce
 *
 * Shaped after `auth.js#signedString` on purpose, with ONE field removed: there is no body hash,
 * because **these routes carry no body at all**. `requireOperator` refuses a non-empty `rawBody`
 * outright, which is what makes the omission safe rather than a hole — a field that cannot be
 * present cannot be unsigned. (`POST /feedback/:id/delete` names its subject in the PATH, which
 * is inside the signature, so nothing it acts on rides outside one.)
 *
 * @param {{method:string, path:string, sortedQuery:string, ts:string, nonce:string}} p
 * @returns {string}
 */
export function adminSignedString(p) {
  return REPORTS_PREFIX + p.method.toUpperCase() + '\n' + p.path + '?' + p.sortedQuery + '\n'
    + p.ts + '\n' + p.nonce;
}

/**
 * Parse `LZPADMIN ts=…, nonce=…, sig=…`, strictly.
 *
 * A deliberate near-copy of `auth.js#parseAuthorization`: exactly the listed parameters, each
 * exactly once, no extras, no quoting, every value checked against the shape it is allowed to
 * have before it is used. Copied rather than shared because the two differ in what they accept
 * (there is no `device=` here) and a parser generalised over both would be a parser with a mode
 * — which is how `alg=none` happens.
 *
 * @param {string|undefined} header
 * @returns {{ts:string, nonce:string, sig:string, tsMs:number, sigBytes:Uint8Array}}
 * @throws {import('../errors.js').HttpError} 401 bad_auth
 */
export function parseAdminAuthorization(header) {
  if (typeof header !== 'string') throw fail('bad_auth');
  const sp = header.indexOf(' ');
  if (sp < 0) throw fail('bad_auth');
  // THE SEPARATION, IN ONE LINE. `LZP1 …` cannot reach the code below, and `auth.js`'s parser
  // rejects `LZPADMIN …` by the mirror image of this check. Case-insensitive on the scheme
  // because RFC 7235 says schemes are, and because `auth.js` is.
  if (header.slice(0, sp).toUpperCase() !== ADMIN_SCHEME) throw fail('bad_auth');

  const out = /** @type {Record<string,string>} */ ({});
  for (const part of header.slice(sp + 1).split(',')) {
    const s = part.trim();
    if (s === '') throw fail('bad_auth');
    const eq = s.indexOf('=');
    if (eq <= 0) throw fail('bad_auth');
    const k = s.slice(0, eq).trim();
    const v = s.slice(eq + 1).trim();
    if (!ADMIN_PARAMS.includes(k)) throw fail('bad_auth');      // no unknown parameters, ever
    if (out[k] !== undefined) throw fail('bad_auth');           // no duplicates, ever
    out[k] = v;
  }
  for (const k of ADMIN_PARAMS) if (out[k] === undefined) throw fail('bad_auth');

  if (!TS_RE.test(out.ts)) throw fail('bad_auth');
  if (!B64U_RE.test(out.nonce)) throw fail('bad_auth');
  // The nonce becomes half of a store key, so its WIDTH is checked and not merely its alphabet —
  // `auth.js`'s note: admitting arbitrary strings here is how an unauthenticated caller writes
  // rows of its own choosing into the Nonce table.
  if (ub64(out.nonce, NONCE_BYTES) === null) throw fail('bad_auth');
  const sigBytes = ub64(out.sig, SIG_BYTES);
  if (sigBytes === null) throw fail('bad_auth');

  return { ts: out.ts, nonce: out.nonce, sig: out.sig, tsMs: Number(out.ts), sigBytes };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. What this file needs from its hosts — declared, not assumed
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The `ctx` member this file adds, in `handlers/feedback.js:146-153`'s idiom and for its reason:
 * the failure mode of a missing one is not a crash at boot, it is a screen that shows nothing.
 *
 * OPTIONAL, and that is the whole design. Most relays have no operator configured and must not
 * grow an operator surface; absent, all three routes answer 404 and the deployment is exactly
 * what it was before this pass.
 */
export const CTX_EXTENSIONS = Object.freeze([
  Object.freeze({
    name: 'reportsAdminPub',
    shape: 'string — base64url of a raw 65-byte P-256 public key',
    absent: 'all three admin routes answer 404 not_found. A relay with no operator must not '
      + 'advertise an operator surface; this is the ordinary state of a deployment and not a fault.',
    optional: true,
  }),
]);

/**
 * The report id shape. Published from here because the HANDLER is what turns a path segment into
 * a store key, so the handler is what has to refuse a bad one — `router.js#segmentsOf` stops
 * traversal and separators and nothing else.
 *
 * `rep_` + 22 base64url characters, mirroring `MEMBER_ID_RE` and `SPACE_ID_RE` in `limits.js` and
 * `auth.js`. **The store must mint ids in this shape**; see `STORE_REQUIREMENTS`.
 */
export const REPORT_ID_RE = /^rep_[A-Za-z0-9_-]{22}$/;

/**
 * The three store methods this file calls, with the shape of each and what breaks when it is
 * missing. `server/core/store-interface.js` is not this file's to write, so the contract is
 * DECLARED here and asserted by `tests/server/reports.test.js` §6 against whatever the adapters
 * ship — the same reasoning `CTX_EXTENSIONS` uses one paragraph up.
 *
 * ⚠ NOTE WHAT IS NOT IN THIS LIST: `putReport`. A report is written by the **sink**
 * (`ctx.feedbackSink`, bound to `store.putReport` by the host), never by a handler — which is
 * exactly why `handlers/feedback.js` still reaches `ctx.store` only through the rate limiter and
 * why its §4 rows pass unchanged. This file READS what that sink wrote and deletes rows; it never
 * creates one.
 */
export const STORE_REQUIREMENTS = Object.freeze([
  Object.freeze({
    name: 'listReports',
    shape: '(limit:number) => Promise<ReportRow[]>',
    contract: 'newest first (receivedAt desc, id desc to break a tie inside one millisecond), at '
      + 'most `limit` rows, and it SWEEPS — the 90-day expiry is lazy on put and on list because '
      + 'Vercel Hobby has no cron. An expired row is never returned whether or not the sweep ran.',
    absent: 'GET /feedback answers 501 not_implemented, after the credential has been verified.',
  }),
  Object.freeze({
    name: 'getReport',
    shape: '(id:string) => Promise<ReportRow|null>',
    contract: 'null for unknown AND for expired, indistinguishably — expiry is enforced at READ '
      + 'as well as by the sweep, the way `getPairSession` and `consumeInvite` already treat '
      + 'theirs. Does not sweep: a read of one row must not write.',
    absent: 'GET /feedback/:id answers 501 not_implemented, after the credential has been verified.',
  }),
  Object.freeze({
    name: 'deleteReport',
    shape: '(id:string) => Promise<boolean>',
    contract: 'true when a row was removed, false when there was nothing to remove. IDEMPOTENT, '
      + 'and never a throw — the admin view can be open in two windows.',
    absent: 'POST /feedback/:id/delete answers 501 not_implemented, after the credential has been verified.',
  }),
]);

/**
 * A stored `ReportRow` (`store-interface.js`) as it goes on the wire.
 *
 * THREE CONVERSIONS AND NOTHING ELSE, each because JSON cannot carry the stored type: two `Date`s
 * become epoch milliseconds (the admin view renders „verfällt am …" from `expiresAt`), and two
 * `Uint8Array`s become base64url — `auth.js#b64u`, the one encoding this codebase puts on a wire.
 *
 * `devicePub` is nulled on an UNSIGNED report rather than echoed. The store's column is nullable
 * and the sink writes null, but a handler that passed the column through unconditionally would
 * put a "device" beside a report nobody signed the day some other writer filled it in — and
 * `PROVES.unsigned` says an unsigned report proves *nothing at all*.
 *
 * @param {Object} r @param {boolean} withImage
 */
function onWire(r, withImage) {
  const signed = r.signed === true;
  return {
    id: r.id,
    receivedAt: msOf(r.receivedAt),
    expiresAt: msOf(r.expiresAt),
    signed,
    devicePub: signed && r.devicePub ? b64u(r.devicePub) : null,
    prose: r.prose,
    ...(withImage
      ? { image: r.image instanceof Uint8Array ? b64u(r.image) : null }
      : { hasImage: r.image instanceof Uint8Array }),
  };
}

/** A `Date` from the store, or an epoch number if an adapter ever hands one over. */
function msOf(v) {
  if (v instanceof Date) return v.getTime();
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The most rows one list answers with.
 *
 * Handler-local, in `spaces.js#MAX_WRAPS` and `invites.js#MAX_OPEN_INVITES`'s idiom: a
 * cardinality ceiling is not a rate and does not belong in `RATE_RULES`. Two hundred is far above
 * what 90 days at `feedbackPerIpHour` = 5 from a household can produce and far below what would
 * make one response expensive; past it the answer says `more: true` and the oldest rows wait for
 * a deletion or for the sweep.
 */
export const MAX_LIST_ROWS = 200;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4. The gate every one of the three routes runs first
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Budget, then existence, then credential — in that order, and the order is the control.
 *
 * @param {Object} req @param {Object} ctx @param {string} ruleName a key of `RATE_RULES`
 * @returns {Promise<Uint8Array>} the operator's raw public key, for a caller that wants to log it
 */
async function requireOperator(req, ctx, ruleName) {
  // ── 1. THE BUDGET, FIRST. ──────────────────────────────────────────────────────────────────
  // `handlers/feedback.js`'s own doctrine, on routes with the same shape of exposure: the
  // expensive part of an unauthenticated request is the P-256 verify, so a flood is refused above
  // it. `ip` and `pre-auth` are forced rather than chosen — before the verify there is no
  // identity at all, and after it there is exactly one caller in the world, which is not a bucket.
  await enforceFor(req, ctx, ruleName, null);

  // ── 2. IS THERE AN OPERATOR AT ALL? ────────────────────────────────────────────────────────
  // Before the credential is even parsed, because the answer must not depend on what the caller
  // presented: on a relay with no key configured these routes are 404, exactly as
  // `/api/v1/nope` is, and nothing tells a prober that the surface was ever specified.
  const configured = ctx && ctx.reportsAdminPub;
  const pub = typeof configured === 'string' ? ub64(configured, RAW_PUBKEY_BYTES) : null;
  if (pub === null) throw fail('not_found');

  // ── 3. NOTHING RIDES OUTSIDE THE SIGNATURE. ────────────────────────────────────────────────
  // `adminSignedString` has no body hash, so a body would be unsigned data a handler could act
  // on — the classic parse-twice defect `auth.js#readSignedBody` closes from the other end. The
  // cheapest way to make it unwritable is to make a body impossible.
  const raw = req && req.rawBody instanceof Uint8Array ? req.rawBody : new Uint8Array(0);
  if (raw.length > 0) throw fail('bad_request', { unexpectedField: 'body' });

  // ── 4. THE CREDENTIAL. ─────────────────────────────────────────────────────────────────────
  const cred = parseAdminAuthorization(headerOf(req, 'authorization'));

  // ── 5. THE WINDOW, symmetric, ADR 003 §2 step 2's number. ──────────────────────────────────
  const now = ctx.now();
  const authWindowMs = positiveOr(ctx && ctx.limits && ctx.limits.authWindowMs, 120000);
  if (Math.abs(now - cred.tsMs) > authWindowMs) throw fail('stale_request');

  // ── 6. THE REPLAY WINDOW, on the EXISTING Nonce table. ─────────────────────────────────────
  // The namespace key is the operator key's own deviceShort — sixteen Crockford characters, the
  // same alphabet the column already holds, so no schema change and no widening of what may be
  // written there. Sharing the namespace with his sync device (the same key, hence the same
  // short) can only refuse more.
  //
  // ⚠ THE SAME HONEST NOTE `auth.js` CARRIES: this claim happens BEFORE the verify, so a caller
  // who reaches it writes one Nonce row per request without proving anything. It is bounded by
  // `nonceTtlMs`, by step 1's IP budget above it, and — unlike the sync ladder — by step 2, which
  // means an unconfigured relay never writes one at all.
  const nonceTtlMs = positiveOr(ctx && ctx.limits && ctx.limits.nonceTtlMs, 300000);
  const short = await deviceShortOfRaw(pub, ctx);
  if (short === null) throw fail('internal');
  const fresh = await ctx.store.claimNonce(short, cred.nonce, nonceTtlMs);
  if (!fresh) throw fail('replay');

  // ── 7. THE VERIFY. ─────────────────────────────────────────────────────────────────────────
  const bytes = TE.encode(adminSignedString({
    method: req.method,
    path: req.path,
    sortedQuery: canonicalQuery(req.query),
    ts: cred.ts,
    nonce: cred.nonce,
  }));
  const ok = await verifySignature(pub, cred.sigBytes, bytes, ctx);
  if (!ok) throw fail('bad_signature');
  return pub;
}

/**
 * The store methods a route needs, checked AFTER the credential so an unauthenticated caller
 * learns nothing about how this relay is provisioned.
 *
 * 501 and not 500, for `handlers/feedback.js#sendFeedback`'s reason turned around: a relay whose
 * store cannot keep a report is a relay that has not finished being deployed, and saying so is
 * more useful to the one person who will ever see it than a generic failure.
 *
 * @param {Object} ctx @param {string} method @param {string} routeName
 */
function requireStore(ctx, method, routeName) {
  const store = ctx && ctx.store;
  if (!store || typeof store[method] !== 'function') {
    throw fail('not_implemented', { route: routeName });
  }
  return store;
}

/** `limits.js#numberFrom`'s contract, locally: a host's typo must not disable a window. */
function positiveOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

/** The id in the path, refused before it becomes a store key. */
function reportIdOf(req) {
  const id = req && req.params && req.params.id;
  if (typeof id !== 'string' || !REPORT_ID_RE.test(id)) throw fail('bad_request');
  return id;
}

/** Every admin answer carries the protocol window and the two honest sentences. */
function answer(body) {
  return {
    status: 200,
    headers: versionHeaders(),
    body: { ok: true, ...body, proves: ADMIN_PROVES.operator, provesNot: ADMIN_PROVES_NOT },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 5. The three handlers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/feedback — the list.
 *
 * Metadata plus her prose, newest first, and NO image bytes: the admin view renders the picture
 * lazily through `getReport`, so opening the screen does not pull 256 KB per report over a
 * tethered connection.
 *
 * @param {Object} req @param {Object} ctx
 */
export async function listReports(req, ctx) {
  await requireOperator(req, ctx, 'reportsRead');
  const store = requireStore(ctx, 'listReports', 'listReports');
  // ONE MORE THAN THE PAGE, so `more` is a fact the store answered rather than a guess. The
  // alternative — asking for exactly the cap and reporting `more: false` — cannot tell a full
  // page from an overflowing one.
  const rows = await store.listReports(MAX_LIST_ROWS + 1);
  const all = Array.isArray(rows) ? rows : [];
  const page = all.slice(0, MAX_LIST_ROWS);
  if (typeof ctx.log === 'function') ctx.log({ route: 'listReports', status: 200 });
  return answer({
    reports: page.map((r) => onWire(r, false)),
    more: all.length > page.length,
  });
}

/**
 * GET /api/v1/feedback/:id — one report, with the redacted PNG.
 *
 * A missing or EXPIRED row is a 404 and the two are not distinguished, for `auth.js` step 4's
 * reason stated on a much smaller surface: there is nothing the one legitimate caller does
 * differently in the two cases, and the store enforces expiry at read rather than trusting the
 * sweep to have run.
 *
 * @param {Object} req @param {Object} ctx
 */
export async function getReport(req, ctx) {
  await requireOperator(req, ctx, 'reportsRead');
  const id = reportIdOf(req);
  const store = requireStore(ctx, 'getReport', 'getReport');
  const row = await store.getReport(id);
  if (!row) throw fail('not_found');
  if (typeof ctx.log === 'function') ctx.log({ route: 'getReport', status: 200 });
  return answer({ report: onWire(row, true) });
}

/**
 * POST /api/v1/feedback/:id/delete — the manual half of retention.
 *
 * IDEMPOTENT, and it answers 200 with `deleted: false` rather than 404 when there was nothing to
 * remove — `RATE_COVERAGE.deleteSpace`'s reasoning, on a route with one caller: a delete that
 * errors on the second press is a delete the operator has to think about, and there is nothing
 * for him to do differently.
 *
 * **This is the only WRITE in this file, and it only ever removes.** There is no edit route, no
 * annotate route and no reply route, and there must never be one: Principle 10 says the board is
 * not a messenger, and the report path has no return leg at any layer — see §7 of the test file,
 * which asserts the absence over this module's source rather than remembering it.
 *
 * @param {Object} req @param {Object} ctx
 */
export async function deleteReport(req, ctx) {
  await requireOperator(req, ctx, 'reportsDelete');
  const id = reportIdOf(req);
  const store = requireStore(ctx, 'deleteReport', 'deleteReport');
  const removed = await store.deleteReport(id);
  if (typeof ctx.log === 'function') ctx.log({ route: 'deleteReport', status: 200 });
  return answer({ deleted: removed === true });
}

/**
 * The registry slice, in `handlers/pair.js`'s idiom. `blindness.test.js` §8 asserts
 * `handlers[name] === mod[name]` for every `HANDLER_OWNERS` row, so the module's exports are
 * named for the ROUTES and there is no second function that could drift from one.
 */
export const handlers = Object.freeze({ listReports, getReport, deleteReport });
export default handlers;
