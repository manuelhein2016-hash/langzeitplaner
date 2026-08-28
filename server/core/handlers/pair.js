// server/core/handlers/pair.js — the pairing rendezvous.  LZP-204, story 19.5.
//
// ADR 002 §6 (threat model, parameters, protocol, the honest analysis), ADR 003 §3, §6.1.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS RELAY IS AND WHAT IT IS NOT
// ─────────────────────────────────────────────────────────────────────────────────────────────
// It moves three opaque boxes between two ends of one rendezvous and learns nothing that would
// let it substitute a key. `boxA`, `boxB` and `delivery` are AES-GCM ciphertexts under keys
// derived from a code that never reaches the server (`rid = b64u(HKDF(C,'','lzp/v2/pair/rid',16))`
// is derived from the WHOLE code, so an offline attack on `rid` costs the full 2^60), and they
// are opaque columns in the store — a String in one of them throws at the adapter boundary
// (RULE 1). This file never looks inside a box.
//
// **The SAS is the MITM defence and it lives on the clients.** Six decimal digits on two screens
// on one desk, confirmed on both (§6.3 step 6, §6.4). Nothing the server does can create or
// replace that. What the server CAN do — and what ADR 002 §6.2 says it must — is make sure it
// never helps an attacker to more than a bounded number of pulls on one rendezvous, never lets a
// burned rid come back, and never lets a rendezvous be held open past its TTL. Those three are
// this file, and they were, in the E3 red team's words, "in a contract and in no code".
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE FOUR CONTROLS
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// 1. **TTL — 180 s, and it CANNOT BE EXTENDED BY WRITING.** `putPairSession(rid, patch, ttl)`
//    sets `expiresAt` only when it creates the row; a patch onto a live row leaves the original
//    expiry alone. So an attacker holding a rendezvous open by re-posting is not a thing that
//    can happen at the store layer, which is where it belongs — a handler convention would be
//    one refactor away from evaporating.
//
// 2. **The 5-attempt budget.** `bumpPairAttempts` is an atomic increment that returns
//    `Number.MAX_SAFE_INTEGER` for an unknown, expired or burned rid, so the guard below FAILS
//    CLOSED with no special case. An attempt is charged for an **anonymous GET on a rendezvous
//    that has not yet been answered** — which is exactly the shape of an online guess: derive a
//    rid, ask whether it exists, pull `box_A` to attack offline. Reads by the offering device
//    (authenticated) and reads after `box_B` exists (the pair is committed; there is nothing left
//    to guess) are not charged, because charging them would exhaust the honest budget in five
//    polls and pairing would fail for everyone. See §3 for the full argument.
//
// 3. **The burn is a tombstone, not a delete** (E2-I7). After a burn `getPairSession` is null
//    forever and `putPairSession` is a no-op, so replaying `pair/offer` cannot resurrect the
//    rendezvous and reset its budget. A `rid` is consumable **exactly once**: the first
//    anonymous GET that collects a non-null `delivery` burns it.
//
// 4. **Write-once boxes.** `boxA`, `boxB` and `delivery` may each be written once. Two pairings
//    racing on one rid produce one winner and one refusal instead of an overwrite, and nobody
//    can blank a rendezvous mid-flight to force a retry onto a code they are watching.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// FINDING E3-5, RECONCILED
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ADR 002 §6.2 publishes "20 `pair/get` per IP per hour"; ADR 003 §6.1 publishes "5 failed `rid`
// lookups per IP per minute" and "10 pair sessions per member per hour". FINDINGS E3-5 records
// them as open because they are not interchangeable — and they are also not contradictory. They
// limit three different things, so all three are enforced here, from `PAIR_LIMIT_DEFAULTS`:
//
//   · `pairGet`       20/IP/h   — how much of the API one IP may read at all      (pre-auth)
//   · `pairRidMiss`    5/IP/min  — how fast one IP may PROBE the rid space, spent on a MISS only
//   · `pairSession`   10/mem/h   — how many rendezvous one member may open          (post-auth)
//
// The middle one is the one that matters against guessing, and it is the one ADR 002 §6.2 does
// not mention: 5 probes/minute against 2^60 is 3.8e14 years. **LZP-205 owns all three**, as
// `RATE_RULES` in `server/core/limits.js`, and this file spends them through `enforceFor` and
// `noteFailedRidLookup` rather than inventing a bucket namespace of its own — so §6.1's numbers
// live in one table and every key goes through `rateKey()`.
//
// ⚠ COMPOSITION (LZP-207). `pairGet` is a `pre-auth` rule, which `withLimits(handlers)` would
// also spend on entry. `limits.js`'s own integration note says the registry must be composed
// EITHER with `withLimits` and no self-limiting handlers, OR without it while handlers
// self-limit. This file self-limits, so it wants the second — `createRouter(withVersionGate(
// handlers))`. Composing both halves the documented 20/IP/hour; it does not open a hole.
//
// `pairAnswer` and `pairDeliver` carry NO limiter, matching `RATE_COVERAGE`'s written reason.
// That reason ends by handing LZP-204 the question of what actually bounds them (E2-205-3), and
// the answer is in this file: the per-rid attempt budget below, plus WRITE-ONCE boxes, which
// together mean an attacker who knows a live rid can neither exhaust it nor overwrite an honest
// answer — a strictly better answer than "harmless because the SAS catches it".

import { fail } from '../errors.js';
import { enforceFor, noteFailedRidLookup } from '../limits.js';
import { b64uToBytes, bytesToB64u, requireObject } from './devices.js';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 Parameters
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const PAIR_LIMIT_DEFAULTS = Object.freeze({
  /** ADR 002 §6.2 — 180 s, single use. Not a rate rule: it is the row's own lifetime, and it is
   *  enforced by the STORE (`putPairSession` sets `expiresAt` only on creation), not by a bucket. */
  pairTtlMs: 180000,
  /** ADR 002 §6.2 — "5 failed decrypts per rid, then the rendezvous is burned". Per RENDEZVOUS,
   *  not per identity, so it is `Store.bumpPairAttempts` rather than a `RateBucket`. */
  pairAttempts: 5,
  /** Not in either ADR. A box is one AES-GCM ciphertext around a handful of public keys, padded
   *  by §5.3's construction; 8 KB is far above that and far below anything usable as storage. */
  bytesPerPairBox: 8192,
});

const limitOf = (ctx, name) => (ctx.limits && typeof ctx.limits[name] === 'number' ? ctx.limits[name] : PAIR_LIMIT_DEFAULTS[name]);

/** `rid = b64u(HKDF(…, 16))` — 16 bytes, 22 base64url characters, no padding. Checked before any
 *  store call: an unbounded caller-supplied string becomes a map key in the file adapter. */
export const RID_RE = /^[A-Za-z0-9_-]{22}$/;

function requireRid(value) {
  if (typeof value !== 'string' || !RID_RE.test(value)) throw fail('bad_request', { field: 'rid' });
  return value;
}

function requireBox(body, field, ctx) {
  const raw = b64uToBytes(body[field]);
  if (!raw || raw.length === 0 || raw.length > limitOf(ctx, 'bytesPerPairBox')) {
    throw fail('bad_request', { field });
  }
  return raw;
}

/**
 * Authenticate if — and only if — the caller presented credentials.
 *
 * `pair/get` and `pair/answer` are reached by a device that HAS NO IDENTITY YET: ADR 002 §6.3
 * step 8 is where B mints its keys, and that is after step 4. So those routes must accept an
 * anonymous caller. What they must not do is let a caller who presents a BROKEN `Authorization`
 * header fall through to the anonymous path: a failed authentication is a signal, and swallowing
 * it would mean a revoked device's request quietly became an anonymous one. So an absent header
 * is anonymous and a present-but-invalid header is the error `ctx.auth` raised.
 *
 * @param {Object} req @param {Object} ctx @returns {Promise<Object|null>}
 */
async function optionalAuth(req, ctx) {
  const h = (req && req.headers) || {};
  if (typeof h.authorization !== 'string' || h.authorization.length === 0) return null;
  return ctx.auth(req);
}

/**
 * Charge the probe budget and answer 404.
 *
 * Unknown, expired and burned are ONE answer: a caller learns only that there is nothing here,
 * never which of the three it was — otherwise a 410 on a burned rid would confirm to an attacker
 * that they had found a real code, which is the single most valuable bit in the protocol.
 *
 * `noteFailedRidLookup` throws 429 once the IP has missed five times in a minute, and the caller
 * lets it: an IP that is missing repeatedly is guessing, and the honest response to a guesser is
 * to stop answering rather than to keep answering 404 until the hourly budget runs out.
 */
async function missingRendezvous(req, ctx) {
  await noteFailedRidLookup(req, ctx);
  throw fail('not_found');
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 `POST /api/v1/pair/offer`  — device A, authenticated
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * ADR 002 §6.3 step 2. A is an existing device that already holds the personal space key, so it
 * can and must authenticate: an anonymous offer endpoint would let anyone plant a `box_A` under
 * a rid they guessed and wait for a human to type the matching code into the wrong screen.
 *
 * @type {(req:Object, ctx:Object) => Promise<Object>}
 */
export async function pairOffer(req, ctx) {
  const auth = await ctx.auth(req);
  const body = requireObject(req.body);
  const rid = requireRid(body.rid);
  const boxA = requireBox(body, 'boxA', ctx);

  // The one post-auth rule on this route. `withLimits` cannot apply it: it is keyed on the member
  // id, which does not exist until ctx.auth() has run (ADR 003 §2 step 5).
  await enforceFor(req, ctx, 'pairSession', auth);

  const ttl = limitOf(ctx, 'pairTtlMs');

  await ctx.store.tx(async (tx) => {
    const before = await tx.getPairSession(rid);
    // Write-once. A live rendezvous that already carries a box is not re-offered: either the same
    // code was drawn twice (2^-60) or somebody else knows it, and both deserve a refusal rather
    // than an overwrite that would hand the human a `box_A` from a different machine.
    if (before && before.boxA !== null) throw fail('bad_request', { reason: 'rid_in_use' });

    await tx.putPairSession(rid, { boxA }, ttl);

    // THE BURN CHECK. `putPairSession` on a burned rid is a documented no-op, and `burnedAt` is
    // not readable through the interface — by design, the burn is a tombstone and not a status.
    // Writing and reading back is therefore the only way to learn that a rid is dead, and it is
    // a complete one: if the row is absent after a successful put, it is a tombstone.
    const after = await tx.getPairSession(rid);
    if (!after) throw fail('pair_burned');
  });

  if (typeof ctx.log === 'function') ctx.log({ route: req.routeName, deviceShort: auth.deviceShort, status: 200 });

  return { status: 200, body: { rid, expiresInMs: ttl, attemptsAllowed: limitOf(ctx, 'pairAttempts'), serverTime: ctx.now() } };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 `GET /api/v1/pair/:rid`  — both ends, and the ONE place the budget is spent
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * ADR 002 §6.3 steps 3, 5 and 8. Two callers reach this route and they are told different things,
 * which is not a courtesy — it is the control.
 *
 * **Authenticated caller (device A, polling for `box_B` at step 5)**
 *   · receives `boxA` and `boxB`; **never `delivery`** — A wrote it and does not need it back, and
 *     excluding it is what stops A's own poll from consuming the single-use collection;
 *   · **is not charged an attempt**, because an already-registered device is not the online
 *     guesser the budget exists for. It is still charged against `pairGetPerIpHour`, which caps a
 *     hostile FAMILY member — the T5 case, who can authenticate — at 20 rid probes per hour.
 *
 * **Anonymous caller (device B at step 3, then collecting at step 8)**
 *   · receives `boxA` and, once present, `delivery`; **never `boxB`**, which it wrote itself. Two
 *     boxes under the same `ck` are twice the verification material for the offline attack on the
 *     code that §6.4 prices, so neither end is handed the box it did not need;
 *   · **is charged one attempt while `boxB` is null.** That window is exactly the guessable
 *     phase: a caller who has not answered has not proved it can open `box_A`. Once `box_B`
 *     exists the rendezvous is committed and further reads are bounded by the IP limiters
 *     instead — which is necessary, because B must poll for the delivery and a five-poll ceiling
 *     would break every honest pairing on a slow link.
 *   · The fifth charged read **burns** the rendezvous after serving it, so a sixth is a 404.
 *   · A read that returns a non-null `delivery` burns the rendezvous. One collection, ever.
 *
 * The attacker's view: to get more than `pairAttempts` pulls of an unanswered rendezvous, they
 * must first POST an answer — which requires the rid, which requires the code. Guessing the code
 * is bounded by `pairFailedLookupsPerIpMin` against a 2^60 space, and by the 180-second TTL.
 *
 * @type {(req:Object, ctx:Object) => Promise<Object>}
 */
export async function pairGet(req, ctx) {
  const rid = requireRid((req.params || {}).rid);
  await enforceFor(req, ctx, 'pairGet', null);

  const auth = await optionalAuth(req, ctx);
  const maxAttempts = limitOf(ctx, 'pairAttempts');

  const out = await ctx.store.tx(async (tx) => {
    const session = await tx.getPairSession(rid);
    if (!session) return null;                         // unknown, expired or burned — all one answer

    if (auth) {
      return {
        role: 'offerer',
        boxA: session.boxA, boxB: session.boxB, delivery: null,
        attempts: session.attempts, expiresAt: session.expiresAt, charged: false, burned: false,
      };
    }

    let attempts = session.attempts;
    let burned = false;

    if (session.boxB === null) {
      // MAX_SAFE_INTEGER on an unknown/expired/burned rid, so this comparison fails closed.
      attempts = await tx.bumpPairAttempts(rid);
      if (attempts > maxAttempts) {
        await tx.burnPairSession(rid);
        throw fail('pair_burned', { attempts: maxAttempts });
      }
      if (attempts >= maxAttempts) { await tx.burnPairSession(rid); burned = true; }
    }

    if (session.delivery !== null) {
      // §6.3 step 9 — "the relay burns rid". Collection is the consumption event; a rendezvous is
      // usable exactly once and a replay of this GET is a 404.
      await tx.burnPairSession(rid);
      burned = true;
    }

    return {
      role: 'joiner',
      boxA: session.boxA, boxB: null, delivery: session.delivery,
      attempts, expiresAt: session.expiresAt, charged: session.boxB === null, burned,
    };
  });

  if (!out) return missingRendezvous(req, ctx);

  if (typeof ctx.log === 'function') ctx.log({ route: req.routeName, deviceShort: auth ? auth.deviceShort : undefined, status: 200 });

  return {
    status: 200,
    body: {
      rid,
      boxA: out.boxA ? bytesToB64u(out.boxA) : null,
      boxB: out.boxB ? bytesToB64u(out.boxB) : null,
      delivery: out.delivery ? bytesToB64u(out.delivery) : null,
      attempts: out.attempts,
      attemptsAllowed: maxAttempts,
      expiresAt: out.expiresAt instanceof Date ? out.expiresAt.getTime() : null,
      consumed: out.burned,
      serverTime: ctx.now(),
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 `POST /api/v1/pair/answer`  — device B, anonymous by necessity
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * ADR 002 §6.3 step 4. B has no registered identity until step 8, so this route cannot require
 * one — it is limited by IP and by the rendezvous itself instead.
 *
 * An answer is refused unless `box_A` is present (there is nothing to answer) and `box_B` is
 * absent (write-once). The second refusal is the race in the task's list: two devices answering
 * one rid produce one winner and one `400 already_answered`, never a silent overwrite of the
 * honest B's ephemeral key — which is the shape a MITM would want, because it would let them
 * replace an answer the human had already begun comparing digits against.
 *
 * @type {(req:Object, ctx:Object) => Promise<Object>}
 */
export async function pairAnswer(req, ctx) {
  const body = requireObject(req.body);
  const rid = requireRid(body.rid);
  const boxB = requireBox(body, 'boxB', ctx);

  const missing = await ctx.store.tx(async (tx) => {
    const session = await tx.getPairSession(rid);
    if (!session) return true;
    if (session.boxA === null) throw fail('bad_request', { reason: 'not_offered' });
    if (session.boxB !== null) throw fail('bad_request', { reason: 'already_answered' });
    // The TTL rides on the row and a patch never moves it (see the header, control 1). The value
    // passed here is only used if the row had to be created, which it was not.
    await tx.putPairSession(rid, { boxB }, limitOf(ctx, 'pairTtlMs'));
    return false;
  });
  if (missing) return missingRendezvous(req, ctx);

  if (typeof ctx.log === 'function') ctx.log({ route: req.routeName, status: 200 });
  return { status: 200, body: { rid, answered: true, serverTime: ctx.now() } };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 `POST /api/v1/pair/deliver`  — device A, authenticated
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * ADR 002 §6.3 step 7 — the payload that carries the personal space keys and the recovery
 * identity, sealed under `kek = HKDF(S,…)` where `S` is the ECDH shared secret. **The human has
 * confirmed the SAS on both screens before this call is made.** The server cannot verify that and
 * does not claim to; it verifies the two things it can:
 *
 *  · the rendezvous has been ANSWERED — delivering before `box_B` exists means delivering to
 *    nobody, or to whoever answers next, and there is no legitimate client that does it;
 *  · `delivery` is write-once — so a second delivery cannot displace the one B is about to
 *    collect.
 *
 * **What the server cannot check, stated plainly:** `PairSession` has no owner column (its column
 * set is closed — `store-interface.js` RULE 1), so the relay cannot verify that the device
 * delivering is the device that offered. Any authenticated member device that KNOWS THE RID could
 * deliver — and knowing the rid means knowing the 60-bit code, which is the same barrier the
 * whole protocol rests on. The consequence is bounded by write-once and by the SAS: a wrong
 * payload does not decrypt under B's `kek`, so it is a denial, not an impersonation.
 *
 * @type {(req:Object, ctx:Object) => Promise<Object>}
 */
export async function pairDeliver(req, ctx) {
  const auth = await ctx.auth(req);
  const body = requireObject(req.body);
  const rid = requireRid(body.rid);
  const delivery = requireBox(body, 'delivery', ctx);

  const missing = await ctx.store.tx(async (tx) => {
    const session = await tx.getPairSession(rid);
    if (!session) return true;
    if (session.boxA === null || session.boxB === null) throw fail('bad_request', { reason: 'not_answered' });
    if (session.delivery !== null) throw fail('bad_request', { reason: 'already_delivered' });
    await tx.putPairSession(rid, { delivery }, limitOf(ctx, 'pairTtlMs'));
    return false;
  });
  if (missing) return missingRendezvous(req, ctx);

  if (typeof ctx.log === 'function') ctx.log({ route: req.routeName, deviceShort: auth.deviceShort, status: 200 });

  return {
    status: 200,
    body: {
      rid,
      delivered: true,
      // The rendezvous burns when the joiner collects, not now — the collection is the single
      // consumption event (§3). A rotates the personal space to e+1 after the new device
      // registers (§6.3 step 9), which `keys.js` coverage-checks like any other rotation.
      rotateRequired: true,
      serverTime: ctx.now(),
    },
  };
}

/** The slice of the handler registry this file owns. */
export const handlers = Object.freeze({ pairOffer, pairGet, pairAnswer, pairDeliver });
