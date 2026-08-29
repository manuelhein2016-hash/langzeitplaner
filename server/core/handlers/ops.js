// server/core/handlers/ops.js — push and pull.  ADR 003 §3.1, §3.2, §3.3; LZP-202.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// STORY 21.1 IS A PROPERTY OF THIS FILE MORE THAN OF ANY OTHER
// ─────────────────────────────────────────────────────────────────────────────────────────────
// Every note, every bar, every label a family writes passes through these two functions, and
// neither of them can read a byte of it. That is not achieved by discipline; it is achieved by
// there being nothing to read:
//
//   · `ct` is decoded exactly once, to measure its length and to concatenate it into the
//     `envelope` column. It is never parsed, never inspected, never branched on.
//   · The only fields the server understands are the six AAD fields of ADR 002 §5.1 — `v`, `sp`,
//     `ep`, `dv`, `oid`, `wit` — plus `iv` and `sig`. Each has a stated job, and the table in
//     `ENVELOPE_FIELDS` names it. There is no seventh field, and adding one means editing that
//     table, `MODEL_COLUMNS`, and the schema.
//   · Ordering is by `seq` and by nothing else. `seq` is assigned by the store from a per-space
//     counter (ADR 003 §3.3), so it is a function of ARRIVAL, never of content. There is no
//     sort, no filter and no grouping anywhere in this file that reads a payload.
//
// THE THREE THINGS THAT WOULD BE SILENT DATA LOSS IF THEY WERE WRONG, and where they live:
//
//   1. A CURSOR THAT SKIPS.  `nextCursor` is the seq of the last op ACTUALLY RETURNED, and when
//      nothing is returned it is the caller's own `since` — never the head, never `since + limit`.
//      A cursor that advances past an op the client did not receive loses that op permanently and
//      quietly, on one device, and no test of the happy path finds it. See `pullOps`.
//   2. A BURNED SEQ ON RETRY.  Duplicate `opId`s are filtered by the store BEFORE the counter is
//      bumped (RULE 2), and this handler's `existingOpIds` pre-pass makes sure the chain is
//      computed only over the rows that are genuinely new.
//   3. AN ACK THAT LIES.  `ackSeq` gates tombstone GC on every peer (ADR 001 §7.3). A member who
//      inflates it makes their family collect tombstones for ops they have not seen. It is
//      therefore bounded by the space's own assignment high-water — see `parseAck`.
//
// PURITY (ADR 003 §9). No clock but `ctx.now()`, no randomness, no I/O, no `req`/`res`, no
// framework. Everything arrives through `ctx`, which is what lets the fleet suite bind a client's
// Transport port straight to these two functions with no sockets at all.

import { fail } from '../errors.js';
import { b64u, ub64, readSignedBody, assertMember, subtleOf, SPACE_ID_RE } from '../auth.js';
import { enforceFor } from '../limits.js';

// ─────────────────────────────────────────────────────────────────────────────
// 0. The wire shapes this file accepts, and the reason each field exists
// ─────────────────────────────────────────────────────────────────────────────

/** 22 base64url characters = 128 bits. Strict: `opId` is the idempotency key, so it must have
 *  exactly one spelling or "already seen this op" stops being decidable by string comparison. */
const OP_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** AES-GCM, 12-byte IV (ADR 002 §1). */
const IV_BYTES = 12;

/** ECDSA P-256 in P1363 — 64 bytes in both engines, never DER (ADR 002 §1). */
const SIG_BYTES = 64;

/** AES-GCM `tagLength: 128`, so the shortest possible `ct` is the tag alone. */
const MIN_CT_BYTES = 16;

/**
 * `Envelope.v` values this relay will store.
 *
 * **This is a real limit and it is worth being blunt about why** (reported as E2-202-D): the
 * `Op` model has NO `v` column — see `MODEL_COLUMNS.Op` — while ADR 003 §3.2's pull response
 * carries `"v":1` per op. So the relay can round-trip exactly the envelope versions it can
 * reconstruct from a constant, which today is one. ADR 002 §5's promise that *"a client keeps the
 * ability to open every Envelope.v it has ever seen"* is a promise about CLIENTS and is unaffected;
 * a mixed-version LOG, however, needs a column, and the day `v` becomes 2 that column has to
 * arrive with it. Refusing an unknown `v` here is the honest behaviour: the alternative is
 * storing a v2 envelope and serving it back labelled v1, which is exactly the version confusion
 * the AAD's `v` field exists to prevent.
 */
export const ACCEPTED_ENVELOPE_VERSIONS = Object.freeze([1]);

/**
 * The nine fields of an envelope, with the job each one has (ADR 002 §5.1). The first six are
 * the AAD; the last three are the sealed payload. Exported as data so `tests/server/ops.test.js`
 * can assert the handler accepts exactly these and no more — a tenth field would be a place for
 * plaintext to arrive.
 */
export const ENVELOPE_FIELDS = Object.freeze({
  v:   'suite/version pin — blocks downgrade to a suite we no longer trust',
  sp:  'space id — blocks a personal op being replayed into the family space',
  ep:  'key epoch — blocks a stale-epoch op being relabelled as current',
  dv:  'author deviceShort — blocks re-attribution of an op to another device',
  oid: 'idempotency key — blocks envelope splicing (one op made to look like two)',
  wit: 'chain witness — blocks rewriting what a device claimed to have seen (§5.4)',
  iv:  'AES-GCM nonce, 12 bytes — not content, and never inspected',
  ct:  'AES-256-GCM over the PADDED plaintext — decoded to be MEASURED and COPIED, never read',
  sig: 'ECDSA over aad ‖ iv ‖ ct — verified by PEERS, not by the relay (it holds no key)',
});

const ENVELOPE_KEYS = Object.freeze(Object.keys(ENVELOPE_FIELDS));

/** Fields `POST /ops` accepts at the top level. Closed, for the same reason the column set is. */
const PUSH_BODY_KEYS = Object.freeze(['space', 'ackSeq', 'ops', 'drained']);

/**
 * The R3 budget (PLAN.md risk R3, signal S3: *"pull latency > 2 s"*).
 *
 * The number that actually survives the swap from the memory adapter to Postgres-in-Frankfurt is
 * not milliseconds — it is **store round trips**, because each one becomes a network hop and a
 * slot in a `connection_limit=1` pool. A handler that grew a `getDevice()` inside a per-member
 * loop would still be fast here and would blow the budget there. So both are asserted:
 * `tests/server/ops.test.js` counts the calls and times the path.
 */
export const BUDGET = Object.freeze({
  // auth: claimNonce, getDeviceByShort, listMembers
  // pull: rateAllow, getSpace, listOps, listMembers, listDevices
  pullStoreCalls: 8,
  // auth: claimNonce, getDeviceByShort, listMembers
  // push: rateAllow, tx, {getSpace, existingOpIds, upsertOps, setHeadChain, getSpace,
  //                       setLastSeenSeq, setLastPushedSeq}
  pushStoreCalls: 12,
  pullMs: 250,            // handler compute for a full 500-op page; the other 1750 ms of S3's
                          // 2 s is cold start, TLS, Postgres and the trip to Frankfurt
  pushMs: 250,
});

const MINUTE_MS = 60000;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Small shared helpers
// ─────────────────────────────────────────────────────────────────────────────

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The parse of the SIGNED bytes. Never `req.body` — see auth.js `readSignedBody`. */
function signedBodyOf(req, auth) {
  if (auth && Object.prototype.hasOwnProperty.call(auth, 'body')) return auth.body;
  return readSignedBody(req);
}

/**
 * Membership, without paying for it twice.
 *
 * When `ctx.auth` is `auth.js`'s `authenticate`, step 7 has already run for this exact space and
 * the member row is on the result — one fewer round trip on the hot path (R3). When it is
 * anything else, the check is run here. A handler that trusts an injected `ctx.auth` to have
 * done a check it cannot see is a handler whose security depends on its wiring.
 */
async function ensureMember(auth, spaceId, ctx) {
  if (auth && auth.member && auth.spaceId === spaceId) return auth.member;
  if (typeof ctx.assertMember === 'function') return ctx.assertMember(auth.memberId, spaceId);
  return assertMember(auth.memberId, spaceId, ctx);
}

/**
 * ADR 003 §6.1's per-device limits, over the store's `rateAllow`.
 *
 * The key is `route + deviceShort` and never anything derived from content (`RateBucket.key` is
 * a readable String column — see PLAINTEXT_STRINGS — so what goes into it is a blindness
 * question, not just a naming one).
 *
 * ── RECONCILED AT INTEGRATION (LZP-207) ──────────────────────────────────────
 * This helper used to build its own key, `` `${route}:${deviceShort}` `` — an interpolated
 * string, which is precisely the shape `limits.js`'s blindness note warns about, even though
 * `deviceShort` here has already been through the ADR 003 §2 ladder and cannot be arbitrary. It
 * now delegates to `enforceFor`, so the key goes through `rateKey()` (JSON, never a join) and the
 * identity through `deviceIdentity()`. The numbers still come from `ctx.limits` — `enforce`
 * reads `RATE_RULES.push.limit` = `'pushPerMin'` out of it — so a test can still tighten a limit
 * to 2 and watch this code path 429, and the two files stay independently deployable.
 *
 * Same store cost: exactly one `rateAllow` call, so `BUDGET.pushStoreCalls` / `pullStoreCalls`
 * are unchanged and the R3 round-trip test still holds them.
 */
async function enforceRate(req, ctx, ruleName, auth) {
  await enforceFor(req, ctx, ruleName, auth);
}

function logLine(ctx, evt) {
  if (typeof ctx.log === 'function') ctx.log(evt);
}

/** A space id from the wire. Rejected before it ever reaches the store, where it is a map key. */
function requireSpaceId(v) {
  if (typeof v !== 'string' || !SPACE_ID_RE.test(v)) throw fail('bad_request');
  return v;
}

/**
 * A non-negative decimal integer from the wire, as a bigint. Accepts a JSON string or number,
 * because `seq` exceeds `Number.MAX_SAFE_INTEGER` in principle and JSON has no bigint — which is
 * exactly why ADR 003 §3.1 and §3.2 quote every seq as a string.
 */
function parseSeq(v) {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) return null;
    return BigInt(v);
  }
  if (typeof v !== 'string' || !/^[0-9]{1,19}$/.test(v)) return null;
  return BigInt(v);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. The chain (ADR 002 §5.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `chain = SHA-256(prevChain ‖ utf8(opId))`, computed by the server, per space, in seq order.
 *
 * On push a client sets `wit` to the highest chain it had pulled, so every op a member authors
 * commits to what that member had seen, and peers can cross-check. **Scope, from §5.4 and not
 * oversold: detection-only, best-effort, and it never blocks sync in v2.** The server therefore
 * computes the chain and stores the witness; it never compares them, and a mismatched `wit` is
 * not an error here. A false positive that broke a family's board would be far worse than the
 * attack it would catch.
 *
 * `opId` enters as its canonical ASCII spelling, which is the other reason `OP_ID_RE` is strict:
 * two spellings of one id would be two different chains over the same log.
 */
async function chainAfter(ctx, prev, opId) {
  const id = new TextEncoder().encode(opId);
  const buf = new Uint8Array((prev ? prev.length : 0) + id.length);
  if (prev) buf.set(prev, 0);
  buf.set(id, prev ? prev.length : 0);
  return new Uint8Array(await subtleOf(ctx).digest('SHA-256', buf));
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Envelope validation — the order is ADR 003 §3.1's
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate one envelope and reduce it to the columns the store will hold.
 *
 * ADR 003 §3.1 fixes the order: `e.dv === auth.deviceShort` (403 device_mismatch), then
 * `e.sp === body.space` (400 space_mismatch), then `e.ep ≤ space.currentEpoch`
 * (400 future_epoch), then the size caps (413). The order is observable — a client that gets
 * `space_mismatch` learns its `sp` is wrong and not that its whole batch is oversized — so it is
 * implemented as written rather than as convenient.
 *
 * @returns {{opId:string, epoch:number, deviceShort:string, witness:Uint8Array|null, envelope:Uint8Array}}
 */
function validateEnvelope(e, deviceShort, spaceId, currentEpoch, limits) {
  if (!isPlainObject(e)) throw fail('bad_request');

  // A closed key set. A field the relay does not understand is a field it might one day store.
  for (const k of Object.keys(e)) if (!ENVELOPE_KEYS.includes(k)) throw fail('bad_request');
  for (const k of ENVELOPE_KEYS) if (!Object.prototype.hasOwnProperty.call(e, k)) throw fail('bad_request');

  // dv first (§3.1). A non-string `dv` is not this device either, so it lands here too.
  if (e.dv !== deviceShort) throw fail('device_mismatch');
  if (e.sp !== spaceId) throw fail('space_mismatch');

  if (!Number.isInteger(e.v) || !ACCEPTED_ENVELOPE_VERSIONS.includes(e.v)) throw fail('bad_request');
  if (!Number.isInteger(e.ep) || e.ep < 1) throw fail('bad_request');
  if (e.ep > currentEpoch) throw fail('future_epoch');

  if (typeof e.oid !== 'string' || !OP_ID_RE.test(e.oid)) throw fail('bad_request');

  // `wit` is '' on a device's first push (§5.1). Anything else must decode.
  let witness = null;
  if (typeof e.wit !== 'string') throw fail('bad_request');
  if (e.wit !== '') {
    witness = ub64(e.wit);
    if (witness === null) throw fail('bad_request');
  }

  const iv = ub64(e.iv, IV_BYTES);
  if (iv === null) throw fail('bad_request');
  const sig = ub64(e.sig, SIG_BYTES);
  if (sig === null) throw fail('bad_request');
  const ct = ub64(e.ct);
  if (ct === null || ct.length < MIN_CT_BYTES) throw fail('bad_request');

  // iv ‖ ct ‖ sig — ADR 003 §5.1's `envelope` column, and the only thing done with `ct` in this
  // entire file. It is copied. It is not read.
  const envelope = new Uint8Array(iv.length + ct.length + sig.length);
  envelope.set(iv, 0);
  envelope.set(ct, iv.length);
  envelope.set(sig, iv.length + ct.length);
  if (envelope.length > limits.bytesPerEnvelope) throw fail('payload_too_large');

  return { opId: e.oid, epoch: e.ep, deviceShort: e.dv, witness, envelope };
}

/** Split a stored envelope back into the three wire fields. Framing, not content. */
function splitEnvelope(env) {
  if (!(env instanceof Uint8Array) || env.length < IV_BYTES + SIG_BYTES + MIN_CT_BYTES) {
    // Unreachable from `pushOps`, which is the only writer. A row that cannot be framed can also
    // not be served, and dropping it from a page would be exactly the silent skip §3.3 forbids —
    // so this is loud, and it never advances a cursor past the row it could not return.
    throw fail('internal');
  }
  return {
    iv: b64u(env.subarray(0, IV_BYTES)),
    ct: b64u(env.subarray(IV_BYTES, env.length - SIG_BYTES)),
    sig: b64u(env.subarray(env.length - SIG_BYTES)),
  };
}

/** Byte equality. Public data, so no constant-time requirement — and none implied. */
function sameBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * `ackSeq` (ADR 003 §3.1) — *"highest seq this device has folded"*, and the input to ADR 001
 * §7.3's tombstone GC on every peer.
 *
 * **It is bounded by the space's own assignment high-water, and that bound is a security check,
 * not tidiness.** T5 is a family member, the admin included. `minLastSeenSeq` is a MINIMUM over
 * the fleet, so one device claiming `ackSeq = 2^63` cannot on its own release anything — but it
 * removes itself as the brake, and in a two-device space that is the whole brake. The peers then
 * collect tombstones for ops this device never folded, and ADR 001 §12.5 guarantees an old
 * unpushed edit is never discarded for being old, so the entry comes back. Resurrection is the
 * failure mode, and it is silent.
 */
function parseAck(v, highWater) {
  if (v === undefined || v === null) return null;
  const n = parseSeq(v);
  if (n === null) throw fail('bad_request');
  if (n > highWater) throw fail('bad_request');
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. POST /api/v1/ops — push (stories 19.1, 19.2, 21.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Append a batch of sealed envelopes to one space's log.
 *
 * **Idempotent on `(spaceId, opId)` and never on a signature.** WebCrypto ECDSA is
 * non-deterministic in both engines (ADR 002 §1 rule 1), so a signature-keyed idempotency check
 * would classify every honest retry as a new op and duplicate the family's whole board on a
 * flaky connection. `opId` is random, minted once, and re-sent verbatim.
 *
 * A re-push is reported in `duplicate[]` with its EXISTING `seq` and returns 200, never an error.
 * The client treats `accepted` and `duplicate` identically — both mean "the relay has it" — so a
 * response lost in flight costs one retry and never a duplicate entry. That, plus ADR 001 §6's
 * idempotent fold, is why at-least-once delivery is sufficient and exactly-once is never needed.
 *
 * @param {Object} req @param {Object} ctx @returns {Promise<{status:number, body:Object}>}
 */
export async function pushOps(req, ctx) {
  const started = ctx.now();
  const limits = ctx.limits;
  const auth = await ctx.auth(req);
  const body = signedBodyOf(req, auth);
  if (!isPlainObject(body)) throw fail('bad_request');
  for (const k of Object.keys(body)) if (!PUSH_BODY_KEYS.includes(k)) throw fail('bad_request');

  const spaceId = requireSpaceId(body.space);
  await ensureMember(auth, spaceId, ctx);
  await enforceRate(req, ctx, 'push', auth);

  const raw = req.rawBody instanceof Uint8Array ? req.rawBody : new Uint8Array(0);
  if (raw.length > limits.bytesPerRequest) throw fail('payload_too_large');

  const ops = body.ops;
  if (!Array.isArray(ops)) throw fail('bad_request');
  if (ops.length > limits.opsPerPush) throw fail('payload_too_large');
  if (body.drained !== undefined && typeof body.drained !== 'boolean') throw fail('bad_request');

  const result = await ctx.store.tx(async (tx) => {
    const space = await tx.getSpace(spaceId);
    // A membership check that passed against a space row that is gone is an inconsistency, not a
    // client error. Answered as `not_a_member` so the endpoint never confirms which space ids
    // exist to a caller who is not in one.
    if (!space) throw fail('not_a_member');

    const rows = ops.map((e) => validateEnvelope(e, auth.deviceShort, spaceId, space.currentEpoch, limits));

    // The pre-pass (interface extension E2-I2). Two jobs, and neither is possible with
    // `upsertOps` alone: 409 forked_op_id needs the STORED envelope to compare against, and the
    // chain needs to know which rows are genuinely new before it starts hashing.
    const stored = await tx.existingOpIds(spaceId, rows.map((r) => r.opId));
    const byId = new Map(stored.map((o) => [o.opId, o]));

    // Fork detection. Same `oid`, different bytes -> 409, and the client must re-mint.
    //
    // The comparison is over the stored bytes, and it has to be: the relay is blind, so it cannot
    // tell an honest RE-SEAL (fresh iv, fresh non-deterministic signature, same plaintext) from a
    // genuine collision (same id, different op). This is precisely why ADR 003 §8.1 requires the
    // outbox to hold SEALED envelopes rather than re-sealing on retry — a client that re-seals
    // will see 409 on every retry and will be right to treat it as a defect, but the defect will
    // be its own. Reported to WP-8 as a client obligation.
    for (const r of rows) {
      const prev = byId.get(r.opId);
      if (!prev) continue;
      const same = sameBytes(prev.envelope, r.envelope) &&
                   prev.epoch === r.epoch &&
                   prev.deviceShort === r.deviceShort &&
                   sameBytes(prev.witness || new Uint8Array(0), r.witness || new Uint8Array(0));
      if (!same) throw fail('forked_op_id', { oid: r.opId });
    }

    // Chain the genuinely-new rows, in batch order, from the space head. Rows already stored keep
    // the chain they were given; a duplicate must never re-chain, or two devices retrying the
    // same batch would produce two different chains over one log.
    let head = space.headChain;
    const seen = new Set();
    const withChain = [];
    for (const r of rows) {
      const prev = byId.get(r.opId);
      if (prev) { withChain.push({ ...r, chain: prev.chain }); continue; }
      if (seen.has(r.opId)) { withChain.push({ ...r, chain: head }); continue; }  // dup inside the batch
      seen.add(r.opId);
      head = await chainAfter(ctx, head, r.opId);
      withChain.push({ ...r, chain: head });
    }

    const { inserted, existing } = await tx.upsertOps(spaceId, withChain);
    if (seen.size > 0) await tx.setHeadChain(spaceId, head);

    const after = await tx.getSpace(spaceId);
    const highWater = after.nextSeq;

    const ack = parseAck(body.ackSeq, highWater);
    // Space-scoped since round 10 item 8: one Mac has a cursor per circle. See C32b.
    if (ack !== null) await tx.setLastSeenSeq(spaceId, auth.deviceShort, ack);

    // WRITE progress (server.contract.js's 2026-08-27 amendment). `lastPushedSeq` means "the
    // space seq high-water at the moment this device last confirmed a DRAINED outbox", and only
    // the client knows that — so it is an explicit claim, never inferred.
    //
    // **The wire field is additive and is reported as E2-202-E**: ADR 003 §3.1's request body
    // lists `space`, `ackSeq` and `ops` only, so `drained` needs a normative line. Omitting it
    // fails CLOSED (`minLastPushedSeq` stays at 0n and no tombstone is ever collected), which is
    // why inventing a value here — say, the highest seq of this batch — would have been the
    // dangerous choice: read progress and write progress are different facts, and guessing the
    // second one resurrects deleted entries (ADR 001 §7.3 condition 3).
    if (body.drained === true) await tx.setLastPushedSeq(spaceId, auth.deviceShort, highWater);

    return { inserted, existing, spaceSeq: highWater };
  });

  const shape = (o) => ({ oid: o.opId, seq: String(o.seq), chain: b64u(o.chain) });
  const res = {
    accepted: result.inserted.map(shape),
    duplicate: result.existing.map(shape),
    spaceSeq: String(result.spaceSeq),
    serverTime: ctx.now(),
  };

  // ADR 003 §6.2 — the whitelisted field set, and nothing else. No envelope, no ct, no oid.
  logLine(ctx, {
    route: 'pushOps',
    spaceId,
    deviceShort: auth.deviceShort,
    opCount: ops.length,
    byteCount: raw.length,
    status: 200,
    ms: ctx.now() - started,
  });
  return { status: 200, body: res };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. GET /api/v1/ops — pull (stories 19.1, 19.6, 21.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything after a cursor, in `seq` order, plus the member set.
 *
 * `members` rides on every pull because ADR 001 §5 step 3's projection needs the CURRENT member
 * set to be correct *before* the ops are applied, and because ADR 002 §5.2's post-decrypt
 * `op.act === memberOf(dv)` check needs the device→member mapping and the signing keys. At most
 * eight rows of pseudonymous ids — cheaper than a second round trip, and the cost is recorded as
 * a known weakness in ADR 003 §10 rather than hidden.
 *
 * **Display names and colours still travel encrypted, as `member.set` ops.** `colorRef` is the
 * one deliberate plaintext leak (ADR 003 §5.2), and it is here because 15.3's colour-collision
 * prevention needs it server-side. Nothing else about a person is in this response.
 *
 * @param {Object} req @param {Object} ctx @returns {Promise<{status:number, body:Object}>}
 */
export async function pullOps(req, ctx) {
  const started = ctx.now();
  const limits = ctx.limits;
  const auth = await ctx.auth(req);

  const query = req.query || {};
  const spaceId = requireSpaceId(query.space);
  await ensureMember(auth, spaceId, ctx);
  await enforceRate(req, ctx, 'pull', auth);

  const since = query.since === undefined || query.since === '' ? 0n : parseSeq(query.since);
  if (since === null) throw fail('bad_request');

  // `limit` is CLAMPED above the cap and REFUSED below one. Clamping a too-large limit is
  // friendly and cannot lose anything (`hasMore` stays true and the client comes back); accepting
  // a zero or negative one would hand the client a page of nothing with `hasMore: true` — an
  // infinite pull loop that never advances, which looks exactly like a hung sync.
  let limit = limits.opsPerPull;
  if (query.limit !== undefined && query.limit !== '') {
    // Digits only — no whitespace, no sign, no decimal point, no exponent. `Number(' 2')` is 2
    // and `Number('2\n')` is 2, and a query parameter that has several spellings is a query
    // parameter whose canonical form for signing is a matter of opinion.
    if (typeof query.limit !== 'string' || !/^[0-9]{1,9}$/.test(query.limit)) throw fail('bad_request');
    const n = Number(query.limit);
    if (n < 1) throw fail('bad_request');
    limit = Math.min(n, limits.opsPerPull);
  }

  const space = await ctx.store.getSpace(spaceId);
  if (!space) throw fail('not_a_member');

  const page = await ctx.store.listOps(spaceId, since, limit);
  const members = await ctx.store.listMembers(spaceId);
  const devices = await ctx.store.listDevices(spaceId);

  let byteCount = 0;
  const ops = page.ops.map((o) => {
    byteCount += o.envelope.length;
    const parts = splitEnvelope(o.envelope);
    return {
      seq: String(o.seq),
      chain: b64u(o.chain),
      v: ACCEPTED_ENVELOPE_VERSIONS[0],
      sp: o.spaceId,
      ep: o.epoch,
      dv: o.deviceShort,
      oid: o.opId,
      wit: o.witness === null || o.witness === undefined ? '' : b64u(o.witness),
      iv: parts.iv,
      ct: parts.ct,
      sig: parts.sig,
    };
  });

  // THE CURSOR RULE, and the whole reason this line is not `String(space.nextSeq)`:
  // `nextCursor` is the seq of the last op ACTUALLY RETURNED. When the page is empty it is the
  // caller's own `since`. Advancing it to the head would skip every op the client did not
  // receive — including the ops a purge left holes around, and every op that arrives between two
  // pages — and the loss would be silent, permanent, and on one device only.
  const nextCursor = ops.length > 0 ? ops[ops.length - 1].seq : String(since);

  const byMember = new Map();
  for (const m of members) {
    byMember.set(m.id, {
      memberId: m.id,
      colorRef: m.colorRef,
      removedAt: m.removedAt === null || m.removedAt === undefined ? null : m.removedAt.getTime(),
      devices: [],
    });
  }
  for (const d of devices) {
    const entry = byMember.get(d.memberId);
    if (!entry) continue;
    entry.devices.push({
      deviceShort: d.deviceShort,
      sigPubRaw: b64u(d.sigPubRaw),
      kexPubRaw: b64u(d.kexPubRaw),
      revokedAt: d.revokedAt === null || d.revokedAt === undefined ? null : d.revokedAt.getTime(),
    });
  }
  // Deterministic order, by pseudonymous id — never by join time, never by anything derived from
  // content, and never by a column that does not exist. A client diffing this list must not see
  // churn that means nothing.
  const memberList = [...byMember.values()].sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
  for (const m of memberList) m.devices.sort((a, b) => (a.deviceShort < b.deviceShort ? -1 : a.deviceShort > b.deviceShort ? 1 : 0));

  logLine(ctx, {
    route: 'pullOps',
    spaceId,
    deviceShort: auth.deviceShort,
    opCount: ops.length,
    byteCount,
    status: 200,
    ms: ctx.now() - started,
  });

  return {
    status: 200,
    body: {
      ops,
      nextCursor,
      hasMore: page.hasMore,
      currentEpoch: space.currentEpoch,
      serverTime: ctx.now(),
      members: memberList,
    },
  };
}

/** The registry slice LZP-207's `handlers/index.js` composes. */
export const handlers = Object.freeze({ pushOps, pullOps });
