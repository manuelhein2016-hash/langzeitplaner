// server/core/limits.js — abuse basics: payload caps, rate limits, and logs that cannot leak.
// LZP-205 · ADR 003 §6 (all of it) · ADR 002 §6.2, §7.1 · stories 21.3, 21.4.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE IS SHAPED THE WAY IT IS
// ─────────────────────────────────────────────────────────────────────────────
//
// The crypto red team's verdict on E3 was specific and it applies here more than anywhere:
//
//   "every server-enforced control in ADR 002 — rotation coverage, the `rid` burn, the
//    5-attempt budget, all rate limits — exists in a contract and in no code that runs."
//
// A limit that lives in a JSDoc `@typedef` is not a limit. So everything in this file is either
// (a) a function that actually runs and actually throws, or (b) a frozen table that a test
// asserts against something else real. There are three such tables and each one is a gate:
//
//   · `RATE_COVERAGE` names EVERY route in `router.js` and, for each, either the limiter that
//     protects it or an explicit written reason why nothing does. A new route cannot be added
//     without a decision appearing here, because the test enumerates `ROUTE_NAMES` and fails on
//     any name this table does not mention. That is the round-7 move: close the question by
//     enumerating the input domain, not the branches.
//   · `LIMIT_EXTENSIONS` records every number here that is NOT verbatim from
//     `docs/v2/contracts/server.contract.js` LIMITS_SHAPE, each with a stated reason, mirroring
//     `store-interface.js`'s INTERFACE_EXTENSIONS. A deviation that is not recorded fails a test.
//   · `LOG_FIELDS` is the allowlist from ADR 003 §6.2, and the sanitiser reads *from that list*
//     rather than enumerating the caller's object — so a field the list does not name is
//     unreachable by construction, not merely unwelcome.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE BLINDNESS HOLE THIS FILE CLOSES, WHICH IS EASY TO MISS
// ─────────────────────────────────────────────────────────────────────────────
//
// `RateBucket.key` is a plaintext String column. `store-interface.js` PLAINTEXT_STRINGS justifies
// it as "a limiter key; composed of route + device/IP, never of content". Nothing enforced that.
// A limiter keyed on a request header — and the client IP arrives *as a header* on Vercel —
// would happily write `X-Real-IP: Zahnarzt 14:30` into a readable database column, on an
// UNAUTHENTICATED endpoint, at attacker-chosen length. That is story 21.1 defeated by a rate
// limiter, of all things.
//
// So `clientIp()` does not return what the header said. It returns a value that has passed
// `IP_TEXT_RE` and a 45-character cap, or the shared sentinel `'?'`. Every other identity that
// can reach a bucket key — device short, member id — is validated against its own alphabet
// before it is allowed near the store. `rateKey()` then JSON-encodes the parts, so no
// caller-supplied string can impersonate a neighbouring bucket by containing a separator.
//
// PURITY (ADR 003 §9, ADR 005 §2). No clock, no randomness, no I/O, no globals. The window
// arithmetic is a pure function of the numbers; the only state lives behind `ctx.store`.

import { fail, FORBIDDEN_BODY_FIELDS } from './errors.js';
import { ROUTE_NAMES } from './router.js';
import { OPAQUE_FIELDS } from './store-interface.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. The numbers
// ─────────────────────────────────────────────────────────────────────────────

const MINUTE = 60000;
const HOUR = 3600000;

/**
 * ADR 003 §6.1 and ADR 002 §6.2/§7.1, as one frozen table. The first eleven entries are
 * `LIMITS_SHAPE` from `docs/v2/contracts/server.contract.js` verbatim; the rest are recorded in
 * `LIMIT_EXTENSIONS` with reasons.
 *
 * `ctx.limits` is this object in production. Handlers read the number from `ctx.limits` rather
 * than importing it, so a test can tighten a limit to 2 and watch the real code path 429.
 */
export const LIMITS = Object.freeze({
  // ── payload caps (ADR 003 §6.1) ────────────────────────────────────────────
  opsPerPush: 200,
  bytesPerEnvelope: 65536,
  bytesPerRequest: 4194304,
  opsPerPull: 500,
  // ── rate limits (ADR 003 §6.1, ADR 002 §6.2 and §7.1) ──────────────────────
  pushPerMin: 60,
  pullPerMin: 120,
  invitesPerIpHour: 10,
  pairGetPerIpHour: 20,
  pairSessionsPerMemberHour: 10,
  pairAttempts: 5,
  // ── auth window (ADR 003 §2) ───────────────────────────────────────────────
  authWindowMs: 120000,
  nonceTtlMs: 300000,
  // ── extensions, each recorded in LIMIT_EXTENSIONS below ────────────────────
  pairRidMissPerIpMin: 5,
  maxOpsFieldChars: 4194304,
  // ── hoisted at integration (LZP-207) out of the handler-local default tables ─
  spacesPerIpHour: 5,
  deviceRegPerIpHour: 10,
  deviceAdoptPerIpHour: 10,
  memberRemovePerMemberHour: 10,
  pairTtlMs: 180000,
  bytesPerPairBox: 8192,
  epochRotationsPerMemberHour: 20,
});

/**
 * Every number above that is not verbatim from `server.contract.js` LIMITS_SHAPE, with the
 * clause that forces it. `tests/server/limits.test.js` asserts this list is exactly the
 * difference between the two tables and that every entry carries a reason — so an extra limit
 * cannot be slipped in, and a recorded one cannot be quietly deleted.
 */
export const LIMIT_EXTENSIONS = Object.freeze([
  Object.freeze({
    tag: 'E2-L1',
    name: 'pairRidMissPerIpMin',
    value: 5,
    adr: 'ADR 003 §6.1',
    reason:
      'CLOSES FINDING E3-5. ADR 002 §6.2 publishes "20 pair/get per IP per hour"; ADR 003 §6.1 ' +
      'publishes "5 failed rid lookups per IP per minute" AND "10 pair sessions per member per ' +
      'hour". FINDINGS.md called these "not contradictory; not interchangeable" and asked for ' +
      'one RateBucket. The reconciliation is that they are FOUR limiters over three different ' +
      'keyspaces plus one per-rid counter that is not a RateBucket at all, and collapsing them ' +
      'would lose a real control: (1) pairGetPerIpHour = 20 bounds total polling per IP; ' +
      '(2) pairRidMissPerIpMin = 5 bounds GUESSING, which is the actual online attack on the ' +
      '60-bit code and which a 20/hour budget would let run at 20 guesses an hour forever; ' +
      '(3) pairSessionsPerMemberHour = 10 bounds session CREATION by an authenticated member; ' +
      '(4) pairAttempts = 5 is per-rid and lives in Store.bumpPairAttempts, not in RateBucket, ' +
      'because it must survive the attacker changing IP. The two 5s in the ADRs are different ' +
      'numbers about different things and this is the only entry that had no home.',
  }),
  Object.freeze({
    tag: 'E2-L2',
    name: 'maxOpsFieldChars',
    value: 4194304,
    adr: 'ADR 003 §6.1 (request body cap, applied one level down)',
    reason:
      'A guard for `assertBatch` on hosts that hand a handler a parsed body without having ' +
      'enforced `bytesPerRequest` on the raw stream first. Envelope length is measured from the ' +
      'BASE64 STRING LENGTH before any decode, so a 12 MB envelope field is refused with a 413 ' +
      'rather than decoded into a 9 MB Buffer to find out it is too big. Same number as ' +
      'bytesPerRequest by construction: nothing inside a body may exceed the body.',
  }),
  // ───────────────────────────────────────────────────────────────────────────
  // Hoisted at integration (LZP-207). LZP-202..204 each invented a number ADR 003 §6.1 does not
  // publish and parked it in a handler-local default table — `SPACES_PER_IP_HOUR` in spaces.js,
  // `DEVICE_LIMIT_DEFAULTS` in devices.js, `LIFECYCLE_LIMIT_DEFAULTS` in lifecycle.js,
  // `PAIR_LIMIT_DEFAULTS` in pair.js — and every one of them wrote "LZP-205 should absorb this".
  // This is that absorption. The local tables SURVIVE as the fallback each handler reads when
  // `ctx.limits` does not carry the name (`limitOf`), so the files stay independently deployable
  // and their own tests still pin their own numbers; what changes is that `ctx.limits` — which is
  // this object in production — is now the single place a number is edited, and every one of them
  // is now spent through `enforceFor` and therefore through `rateKey()`'s alphabet validation.
  Object.freeze({
    tag: 'E2-L3',
    name: 'spacesPerIpHour',
    value: 5,
    adr: 'ADR 003 §6.1 — AMENDED 2026-09-02, §6.1 "the caps this table did not have" (finding E2-203-6)',
    reason:
      'RATE_COVERAGE used to mark `POST /spaces` unlimited under AUTHED_REASON ("reachable only ' +
      'after the full ADR 003 §2 chain"). That reasoning is true of every other authenticated ' +
      'route and FALSE of this one: `createSpace` is a BOOTSTRAP route that registers the very ' +
      'device it is signed by, so §2 step 4 has no Device row to look up and anyone who can mint ' +
      'a P-256 keypair passes. Unlimited, it is an anonymous row generator on a free-tier ' +
      'database. Five per hour is generous for a human (a person creates one space, once).',
  }),
  Object.freeze({
    tag: 'E2-L4',
    name: 'deviceRegPerIpHour',
    value: 10,
    adr: 'ADR 003 §6.1 — AMENDED 2026-09-02, §6.1 "the caps this table did not have" (finding E2-205-2, decided by LZP-204)',
    reason:
      'CLOSES E2-205-2. `POST /devices` is authorized by an attestation signed under ' +
      'Member.recoveryPubSig, which stops FORGERY and not VOLUME: an attacker can burn function ' +
      'invocations making the server verify signatures that fail. It is also the precondition ' +
      'the rotation-coverage check depends on — if registration were free, a forged device row ' +
      'under an honest member\'s memberId would force the next honest rotation to wrap the new ' +
      'family key to the attacker, turning coverage from a defence into an amplifier.',
  }),
  Object.freeze({
    tag: 'E2-L5',
    name: 'deviceAdoptPerIpHour',
    value: 10,
    adr: 'ADR 003 §6.1 — AMENDED 2026-09-02, §6.1 "the caps this table did not have" (finding E2-205-2)',
    reason:
      'The A2 half of E2-L4. `POST /devices/adopt` (ADR 002 §7.3 step 5) runs the identical ' +
      'check, so it gets an identical budget — in a SEPARATE bucket, so that a burst of recovery ' +
      'attempts after a lost Mac cannot exhaust the budget that admits a freshly paired one.',
  }),
  Object.freeze({
    tag: 'E2-L6',
    name: 'memberRemovePerMemberHour',
    value: 10,
    adr: 'ADR 003 §6.1 — AMENDED 2026-09-02, §6.1 "the caps this table did not have" (finding E2-L1/lifecycle, decided by LZP-204)',
    reason:
      'THE ONE DELIBERATE DISAGREEMENT WITH RATE_COVERAGE\'S OLD REASONING, now resolved in the ' +
      'table rather than in a handler comment. `removeMember` used to be declared unlimited on ' +
      'the grounds that it is "admin-only" — and "admin" is the one thing this server ' +
      'structurally cannot check (finding E2-203-2: no role column, by design). Removal purges ' +
      'the target\'s ops (§6.3), which is the single irreversible action in the API. Until an ' +
      'admin-authority proof exists on the wire, a bounded blast radius is what stands between a ' +
      'compromised member device and the whole circle removed in a loop. A family of eight is ' +
      'removed at most eight times ever; ten an hour is generous for an honest admin.',
  }),
  Object.freeze({
    tag: 'E2-L7',
    name: 'pairTtlMs',
    value: 180000,
    adr: 'ADR 002 §6.2 — 180 s, single use',
    reason:
      'Not a rate rule and deliberately not one: it is the PairSession row\'s own lifetime, ' +
      'enforced by the store (`putPairSession` sets `expiresAt` only on creation, so a later ' +
      'write cannot extend it) rather than by a bucket. It is in this table because it is a §6 ' +
      'number and a reader looking for "how long does a pairing code live" must find one answer.',
  }),
  Object.freeze({
    tag: 'E2-L8',
    name: 'bytesPerPairBox',
    value: 8192,
    adr: 'neither ADR — a payload cap invented by LZP-204 and recorded here',
    reason:
      'A pairing box is one AES-GCM ciphertext around a handful of public keys, padded by ADR ' +
      '002 §5.3\'s construction. 8 KB is far above anything the protocol produces and far below ' +
      'anything usable as free storage on someone else\'s relay. Without a cap, `boxA`/`boxB`/' +
      '`delivery` are three opaque columns an unauthenticated caller can write to.',
  }),
  Object.freeze({
    tag: 'E2-L9',
    name: 'epochRotationsPerMemberHour',
    value: 20,
    adr: 'ADR 003 §6.1 — AMENDED 2026-09-02, §6.1 "the caps this table did not have" (finding T2-E1, the epoch-ladder freeze)',
    reason:
      'CLOSES T2-E1. RATE_COVERAGE.rotateEpoch used to read "a flood costs the attacker their ' +
      'own space\'s epoch numbers and NOTHING ELSE", and the member adversary MEASURED that ' +
      'clause false. `assertCoverage` is a ROW COUNT and rows already deposited count, so one ' +
      'rotation costs an attacker ONE wrap per recipient, while `sync/keys.js#rotateTo` sends ' +
      'recipients x 1..next on EVERY rotation and `readWraps` refuses more than MAX_WRAPS = ' +
      '1024. An unmetered counter that only goes up therefore walks the shipped client past a ' +
      'wall it cannot come back from: no route prunes an epoch, MAX_WRAPS is per REQUEST and ' +
      'there is no second request, so past the wall ADR 002 §4.1\'s "a removal forces e+1" is ' +
      'unperformable BY ANYONE FOR EVER and no joiner can be delivered to again. ' +
      'WHAT IS METERED IS THE CLIMB AND NOT THE REQUEST. `spaces.js#rotateEpoch` spends this ' +
      'budget only where the request would actually take a rung (epoch === currentEpoch + 1); a ' +
      'rotation that loses the race and 409s costs nothing. A device that loses the race has no ' +
      'choice but to retry — ADR 002 §4.2 says so — so charging every attempt would meter the ' +
      'VICTIM of a race at the same rate as its winner, and in a family where two Macs deliver ' +
      'on their own timers that is an honest denial built into the fix. Control row: ' +
      'e6-gate-keys §2d. ' +
      'WHAT THIS RULE DOES NOT CLOSE, stated because the first reading of the finding got it ' +
      'wrong: e6-gate-keys §2a. That row looked like a race a rung budget would bound, and it is ' +
      'not — one rotation carrying wraps nobody can open leaves every honest device noRing at ' +
      'the current epoch, so one is enough and no rate bounds "one". That is ADR 002 §8.5a\'s ' +
      'owed report path (T5 residual 3), not a limiter. This rule bounds how many epochs may be ' +
      'poisoned in an hour (§3d) and nothing more. ' +
      'WHY TWENTY, AND WHY PER MEMBER PER HOUR. An honest rotation is caused by a membership or ' +
      'device event (ADR 002 §4.1) and by nothing else — a family that adds and removes nobody ' +
      'rotates zero times a week — and `keys.js#deliver` batches every uncovered recipient into ' +
      'ONE rotation, so even a marathon onboarding of eight people with three devices each is a ' +
      'handful. The budgets that CAUSE rotations are already 10/hour apiece ' +
      '(memberRemovePerMemberHour, deviceRegPerIpHour, deviceAdoptPerIpHour, invitesPerIpHour), ' +
      'so twenty is above any single member\'s plausible honest cause and cannot bind an honest ' +
      'path. Keyed on the MEMBER and not on the space: a per-space ladder budget would let one ' +
      'hostile member spend the circle\'s whole allowance and 429 the honest admin trying to ' +
      'rotate her out, which is the denial being closed, re-created as the fix.',
  }),
]);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Payload caps  (ADR 003 §6.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The transport-level cap. Called by the HOST before a body is parsed — `server/dev-server.mjs`
 * already counts bytes as they arrive and stops buffering past this, which is the right shape:
 * a cap enforced after `JSON.parse` has already allocated is not a cap.
 *
 * @param {number|Uint8Array|null} raw byte count, or the raw body
 * @param {Object} [limits]
 * @throws {import('./errors.js').HttpError} 413 payload_too_large
 */
export function assertRequestBytes(raw, limits) {
  const max = numberFrom(limits, 'bytesPerRequest');
  const n = typeof raw === 'number' ? raw : raw && typeof raw.length === 'number' ? raw.length : 0;
  if (!Number.isFinite(n) || n < 0) throw fail('bad_request');
  if (n > max) throw fail('payload_too_large', { cap: 'bytesPerRequest', max });
}

/**
 * Base64/base64url decoded length, computed from the ENCODED length alone.
 *
 * Deliberately arithmetic rather than a decode: the point of a size cap is to refuse the work,
 * and `Buffer.from(x,'base64')` on a 12 MB string does the work first. Exact for well-formed
 * base64; for a malformed string it over-estimates by at most two bytes, which errs toward
 * refusing — the correct direction.
 *
 * @param {unknown} v a Uint8Array (already decoded) or a base64/base64url string
 * @returns {number} bytes, or -1 when the value is not something an envelope could be
 */
export function envelopeBytes(v) {
  if (v instanceof Uint8Array) return v.length;
  if (typeof v !== 'string') return -1;
  let n = v.length;
  while (n > 0 && v[n - 1] === '=') n--;         // padding is not payload
  return Math.floor((n * 3) / 4);
}

/**
 * The push batch caps. Order matters: count first (cheap, and it bounds the loop), then the
 * per-envelope size, then the total.
 *
 * A zero-length batch is ALLOWED and is not an error. `POST /ops` with `ops: []` is how a device
 * reports `ackSeq` without having anything to say (ADR 003 §3.1, §6.3) — it is the input to
 * tombstone GC, and rejecting it would make a quiet device unable to unblock its family's
 * garbage collection.
 *
 * @param {unknown} ops the `ops` array from the request body
 * @param {Object} [limits]
 * @returns {number} the total envelope bytes, for `ctx.log({byteCount})`
 * @throws {import('./errors.js').HttpError} 400 bad_request · 413 payload_too_large
 */
export function assertBatch(ops, limits) {
  if (!Array.isArray(ops)) throw fail('bad_request');
  const maxOps = numberFrom(limits, 'opsPerPush');
  const maxEnv = numberFrom(limits, 'bytesPerEnvelope');
  const maxTotal = numberFrom(limits, 'bytesPerRequest');

  if (ops.length > maxOps) throw fail('payload_too_large', { cap: 'opsPerPush', max: maxOps });

  let total = 0;
  for (const op of ops) {
    if (!op || typeof op !== 'object') throw fail('bad_request');
    // `iv` and `ct` are separate fields on the wire (ADR 003 §3.1); `envelope` is the stored
    // concatenation. Measure whichever the caller used, and never look INSIDE any of them.
    const n = envelopeBytes(op.envelope !== undefined ? op.envelope : op.ct);
    if (n < 0) throw fail('bad_request');
    if (n > maxEnv) throw fail('payload_too_large', { cap: 'bytesPerEnvelope', max: maxEnv });
    total += n;
    if (total > maxTotal) throw fail('payload_too_large', { cap: 'bytesPerRequest', max: maxTotal });
  }
  return total;
}

/**
 * `?limit=` on a pull, clamped into `[1, opsPerPull]`. Default and maximum are both `opsPerPull`
 * (ADR 003 §3.2, §6.1).
 *
 * Clamped, never rejected. A malformed `limit` gets the default rather than a 400 because there
 * is nothing to protect: the value's only effect is on the size of a response the server is
 * already bounding, and a client that mis-encodes a cursor knob should still make progress
 * rather than stall in a retry loop it cannot diagnose. `since` is NOT like this — a malformed
 * cursor must not silently become 0, or a typo re-delivers the whole log — but `since` belongs
 * to the pull handler (LZP-202), not here.
 *
 * @param {unknown} raw @param {Object} [limits] @returns {number}
 */
export function pullLimit(raw, limits) {
  const max = numberFrom(limits, 'opsPerPull');
  if (raw === undefined || raw === null || raw === '') return max;
  const n = typeof raw === 'number' ? raw : Number(String(raw));
  if (!Number.isFinite(n)) return max;
  const i = Math.floor(n);
  if (i < 1) return 1;
  if (i > max) return max;
  return i;
}

/**
 * The caps are not independent and the test says so out loud: 200 ops × 64 KB is 12.8 MB, which
 * is over three times `bytesPerRequest`. The request cap is therefore the BINDING one, and a
 * handler that checks only `opsPerPush` and `bytesPerEnvelope` can still be asked to buffer
 * 12.8 MB. `assertBatch` accumulates and trips on the total for exactly that reason.
 */
export const CAP_INTERACTION_NOTE =
  'opsPerPush * bytesPerEnvelope > bytesPerRequest; the request cap binds first and assertBatch enforces it';

// ─────────────────────────────────────────────────────────────────────────────
// 3. Identity — what may become part of a bucket key
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Header trust order for the client IP, tightest first.
 *
 *   1. `x-vercel-forwarded-for` — set by Vercel's edge, replacing whatever the client sent.
 *   2. `x-real-ip` — set by the same edge, and by most reverse proxies.
 *   3. `x-forwarded-for` — **the LAST entry, never the first.** A client can prepend anything it
 *      likes; the value the closest trusted proxy appended is the one at the end. Reading the
 *      first entry is the classic way to make an IP-keyed limiter trivially bypassable, and it
 *      is what a careless implementation does because the first entry is "the real client".
 *
 * UNVERIFIABLE HERE, in the `UNVERIFIED_CLAIMS` sense that `server/adapters/prisma.js`
 * established: no Vercel account exists on this machine, so *that Vercel populates (1) and
 * overwrites a spoofed copy of it* is asserted by nobody. If it does not, every IP-keyed limiter
 * below degrades to (2), then to (3)'s last entry, then to the shared `'?'` bucket — a chain
 * that gets tighter, never looser. **A missing header can only ever put a caller into the most
 * contended bucket, never into a private one.**
 */
export const IP_HEADERS = Object.freeze(['x-vercel-forwarded-for', 'x-real-ip', 'x-forwarded-for']);

/**
 * IPv4, IPv6 and the bracketed form. Hex digits, dots, colons and brackets — nothing else, and
 * at most 45 characters, which is the longest legal IPv6 text form. A zone id (`%eth0`) is
 * deliberately NOT accepted: a zone id is a local interface name, it is never part of a client
 * address as a proxy sees it, and it is the one place an arbitrary string could otherwise ride
 * in on an otherwise-legal address.
 */
const IP_TEXT_RE = /^[0-9A-Fa-f:.[\]]{1,45}$/;

/** Crockford base32, 16 chars — ADR 001 §1.2. No I, L, O or U. */
export const DEVICE_SHORT_RE = /^[0-9A-HJKMNP-TV-Z]{16}$/;

/** `mem_` + 22 base64url — ADR 003 §5.1. */
export const MEMBER_ID_RE = /^mem_[A-Za-z0-9_-]{22}$/;

/**
 * The shared bucket every unidentifiable caller lands in. One character, so it cannot be
 * confused with a real value and cannot carry anything.
 */
export const UNKNOWN_IDENTITY = '?';

/**
 * @param {Object} req a ServerReq
 * @returns {string} a validated IP-ish string, or `UNKNOWN_IDENTITY`
 */
export function clientIp(req) {
  // THE HOST'S OWN PEER ADDRESS WINS OVER EVERY HEADER. This is LZP-204's owed item 7, and it
  // is the one input a client cannot write: `server/adapters/vercel.js` and
  // `server/dev-server.mjs` both set it from `socket.remoteAddress`. Behind Vercel's edge the
  // peer is the edge itself, so it is normally ABSENT there and the header order below applies
  // (U-VERCELIP); on a host where the peer really is the client — the dev host, a self-managed
  // deployment — no `X-Forwarded-For` can override it. Validated with the same alphabet as a
  // header value, because "the host set it" is not a reason to skip the check that keeps German
  // prose out of `RateBucket.key`.
  const direct = req && req.clientIp;
  if (typeof direct === 'string' && direct !== '' && IP_TEXT_RE.test(direct)) return direct;

  const h = (req && req.headers) || {};
  for (const name of IP_HEADERS) {
    const raw = h[name];
    if (typeof raw !== 'string' || raw === '') continue;
    // Only x-forwarded-for is a list; taking the last element of a single value is the value.
    const parts = raw.split(',');
    const candidate = parts[parts.length - 1].trim();
    if (candidate !== '' && IP_TEXT_RE.test(candidate)) return candidate;
    // A header that is present but not IP-shaped is a signal, not an accident. Fall through to
    // the next header rather than trusting it — and if none is usable, share the '?' bucket.
  }
  return UNKNOWN_IDENTITY;
}

/** @param {unknown} v @returns {string} the value, or `UNKNOWN_IDENTITY` */
export function deviceIdentity(v) {
  return typeof v === 'string' && DEVICE_SHORT_RE.test(v) ? v : UNKNOWN_IDENTITY;
}

/** @param {unknown} v @returns {string} the value, or `UNKNOWN_IDENTITY` */
export function memberIdentity(v) {
  return typeof v === 'string' && MEMBER_ID_RE.test(v) ? v : UNKNOWN_IDENTITY;
}

/**
 * The `RateBucket.key`.
 *
 * JSON, not a joined string — the same reasoning as `memory.js`'s composite map keys. A joined
 * key is only unambiguous while every component's alphabet excludes the separator, and the
 * components here include values that arrived in headers. `["push","AB|CD"]` and `["push|AB","CD"]`
 * differ under JSON and collide under any join, so no clever header can address a neighbour's
 * budget.
 *
 * @param {string} rule @param {...string} parts @returns {string}
 */
export function rateKey(rule, ...parts) {
  return JSON.stringify([rule, ...parts]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The rate rules
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} RateRule
 * @property {string} limit    the key in LIMITS holding the maximum
 * @property {number} windowMs
 * @property {'ip'|'device'|'member'} identity   what the bucket is keyed on
 * @property {'pre-auth'|'post-auth'} phase      whether it can run before the signature is checked
 * @property {string} adr
 */

/**
 * Every limiter, by name. Keyed on the *rule*, not the route, because one rule can guard two
 * routes and one route can carry two rules.
 *
 * **`phase` is a real decision, not a label.** A `pre-auth` rule is keyed on the IP because
 * nothing else is known yet, and it runs before any signature verification — which is what makes
 * it useful against a flood, since verifying a P-256 signature is the expensive part. A
 * `post-auth` rule is keyed on a device or member id, which is strictly better (an attacker
 * cannot get a fresh budget by changing address) and strictly later (the identity does not exist
 * until §2 step 5 has passed).
 *
 * @type {Object<string, RateRule>}
 */
export const RATE_RULES = Object.freeze({
  push: Object.freeze({
    limit: 'pushPerMin', windowMs: MINUTE, identity: 'device', phase: 'post-auth',
    adr: 'ADR 003 §6.1 — 60/min per device',
  }),
  pull: Object.freeze({
    limit: 'pullPerMin', windowMs: MINUTE, identity: 'device', phase: 'post-auth',
    adr: 'ADR 003 §6.1 — 120/min per device',
  }),
  inviteRedeem: Object.freeze({
    limit: 'invitesPerIpHour', windowMs: HOUR, identity: 'ip', phase: 'pre-auth',
    adr: 'ADR 003 §6.1 and ADR 002 §7.1 — 10 redemptions per IP per hour',
  }),
  pairGet: Object.freeze({
    limit: 'pairGetPerIpHour', windowMs: HOUR, identity: 'ip', phase: 'pre-auth',
    adr: 'ADR 002 §6.2 — 20 pair/get per IP per hour',
  }),
  pairRidMiss: Object.freeze({
    limit: 'pairRidMissPerIpMin', windowMs: MINUTE, identity: 'ip', phase: 'pre-auth',
    // Consumed on a MISS only, by `noteFailedRidLookup`, so `withLimits` must not spend it on
    // every request. The flag is data rather than a name comparison so a second failure-only
    // rule cannot be added without the wrapper honouring it.
    onFailureOnly: true,
    adr: 'ADR 003 §6.1 — 5 FAILED rid lookups per IP per minute (E2-L1)',
  }),
  pairSession: Object.freeze({
    limit: 'pairSessionsPerMemberHour', windowMs: HOUR, identity: 'member', phase: 'post-auth',
    adr: 'ADR 003 §6.1 — 10 pair sessions per member per hour',
  }),

  // ── added at integration (LZP-207); see LIMIT_EXTENSIONS E2-L3..E2-L6 ──────
  // Each of these was already being charged by a handler, through a local helper over a
  // hand-built key. Modelling them here is what makes the CALL SITE `enforceFor(...)` — which
  // routes the key through `rateKey()` and the identity through `clientIp`/`memberIdentity` —
  // and what puts every §6.1 number in one table a reviewer can read top to bottom.
  spaceCreate: Object.freeze({
    limit: 'spacesPerIpHour', windowMs: HOUR, identity: 'ip', phase: 'pre-auth',
    adr: 'ADR 003 §6.1 amendment owed — 5 space creations per IP per hour (E2-203-6 / E2-L3)',
  }),
  deviceRegister: Object.freeze({
    limit: 'deviceRegPerIpHour', windowMs: HOUR, identity: 'ip', phase: 'pre-auth',
    adr: 'ADR 003 §6.1 amendment owed — 10 device registrations per IP per hour (E2-205-2 / E2-L4)',
  }),
  deviceAdopt: Object.freeze({
    limit: 'deviceAdoptPerIpHour', windowMs: HOUR, identity: 'ip', phase: 'pre-auth',
    adr: 'ADR 003 §6.1 amendment owed — 10 A2 adoptions per IP per hour (E2-205-2 / E2-L5)',
  }),
  memberRemove: Object.freeze({
    limit: 'memberRemovePerMemberHour', windowMs: HOUR, identity: 'member', phase: 'post-auth',
    adr: 'ADR 003 §6.1 amendment owed — 10 removals per member per hour (E2-L6)',
  }),

  // ── added after the round-2 member adversary (T2-E1); see LIMIT_EXTENSIONS E2-L9 ──────────
  // The one rule in this table whose absence was itself the finding. It is `post-auth` and keyed
  // on the MEMBER because the adversary IS a member: an IP key would hand her a fresh ladder
  // budget for the price of a coffee shop, and a space key would let her spend the honest
  // admin's.
  epochRotate: Object.freeze({
    limit: 'epochRotationsPerMemberHour', windowMs: HOUR, identity: 'member', phase: 'post-auth',
    adr: 'ADR 003 §6.1 amendment owed — 20 rotations per member per hour (T2-E1 / E2-L9)',
  }),
});

/** Rule names, frozen, so a typo is a 500 at composition rather than a silently absent limiter. */
export const RATE_RULE_NAMES = Object.freeze(Object.keys(RATE_RULES));

/**
 * EVERY route in `router.js`, and which of ADR 003 §6.1's limiters covers it. `why` is non-null
 * exactly when §6.1 names no limiter for that route, and it states the reason — an endpoint the
 * published table leaves unbudgeted is a decision somebody made, and this is where they made it.
 *
 * **A `why` does not mean the shipped route is unlimited.** Handlers may add limiters beyond the
 * ADR's table, and LZP-202..204's do (see the INTEGRATION WARNING further down). Extra protection
 * is never a failure; the gate this table drives is one-directional —
 * `tests/server/limits.test.js` asserts that every route with a rule DECLARED here really reaches
 * `store.rateAllow`, following the call graph rather than looking for one helper's name.
 *
 * The test enumerates `ROUTE_NAMES` against this table in BOTH directions: a route missing here
 * fails, and a name here that is not a route fails. Adding `POST /api/v1/whatever` to the route
 * table therefore cannot compile past the suite without an answer to "what stops someone calling
 * it a million times".
 *
 * @type {Object<string, {pre:string[], post:string[], why:string|null}>}
 */
export const RATE_COVERAGE = Object.freeze({
  // ── the two hot paths ──────────────────────────────────────────────────────
  pushOps: cov([], ['push'], null),
  pullOps: cov([], ['pull'], null),

  // ── the public, unauthenticated surface ────────────────────────────────────
  meta: cov([], [], // ← deliberate, and the most arguable call in this file
    'DELIBERATELY UNLIMITED, AND STORE-FREE. `meta` returns four constants and ctx.now(). ' +
    'Rate-limiting it would mean a RateBucket write — a DATABASE ROUND TRIP — on the one ' +
    'endpoint whose job is to work when nothing else does: it is how a 426-ed client learns ' +
    'minProto so it can show 22.7\'s one plain sentence, and it is what RELEASE §7.4\'s ' +
    'post-deploy smoke test reads. ADR 003 §6.1 lists no limiter for it. Trading a static ' +
    'response for a database dependency to bound something that returns no secret and costs no ' +
    'work is the wrong trade; platform-level protection is the right layer. The test asserts ' +
    'this handler never touches ctx.store, so the claim stays true.'),
  redeemInvite: cov(['inviteRedeem'], [], null),
  pairGet: cov(['pairGet', 'pairRidMiss'], [], null),
  pairOffer: cov([], ['pairSession'], null),

  // ── the unauthenticated pairing tail — REPORTED, NOT INVENTED ──────────────
  pairAnswer: cov([], [], UNLIMITED_PAIR_REASON()),
  pairDeliver: cov([], [], UNLIMITED_PAIR_REASON()),

  // ── the OTHER bootstrap routes: budgeted at integration (LZP-207) ──────────
  // These four carried a `why` until E2 was integrated, and all four `why`s were wrong in the
  // same way: they reasoned from an authenticated caller on routes that either have no caller
  // identity yet (createSpace, registerDevice, adoptDevice — bootstrap: they register the very
  // device they are signed by) or have one the server cannot check the claim of (removeMember —
  // "admin-only", which finding E2-203-2 says is unknowable here). The handlers were already
  // charging a budget locally and saying so; the rules now live in RATE_RULES, so the numbers
  // are reviewable in one table and the keys go through `rateKey()`.
  createSpace: cov(['spaceCreate'], [], null),
  registerDevice: cov(['deviceRegister'], [], null),
  adoptDevice: cov(['deviceAdopt'], [], null),
  removeMember: cov([], ['memberRemove'], null),

  // ── THE FIFTH `why` THAT WAS WRONG — and this one was wrong about ARITHMETIC ───────────────
  //
  // `rotateEpoch` carried, until the round-2 member adversary measured it:
  //
  //     AUTHED_REASON('serialised by first-writer-wins on Epoch; a flood costs the attacker
  //                    their own space's epoch numbers and nothing else')
  //
  // Both halves are true sentences and the conclusion does not follow from them. First-writer-
  // wins serialises rotations; it does not BOUND them, because the loser simply re-reads
  // `currentEpoch` and asks for the next one. And "nothing else" is false by a factor that grows
  // without limit: `assertCoverage` is a row count and rows ALREADY DEPOSITED count, so a
  // rotation costs an attacker ONE wrap per recipient — while `sync/keys.js#rotateTo` sends
  // `recipients × 1..next` on every rotation and `readWraps` refuses more than `MAX_WRAPS`
  // (1024, `handlers/spaces.js`). The attacker's cost per epoch is flat; the honest client's is
  // linear in the epoch SHE chose. Past `MAX_WRAPS / recipients` the honest rotation stops
  // fitting in a request, the cap is per REQUEST with no continuation, and NO ROUTE PRUNES AN
  // EPOCH — so ADR 002 §4.1's "a removal forces `e+1`" becomes unperformable by anybody, for
  // ever, and no joiner can be delivered to again. Measured end to end through the shipped
  // client in `tests/fleet/e6-gate-keys.test.js` §1.
  //
  // ⚠ THE RULE METERS THE CLIMB, NOT THE REQUEST. `handlers/spaces.js#rotateEpoch` spends this
  // budget only where the request would take a rung (`epoch === currentEpoch + 1`); a rotation
  // that loses the race and 409s costs nothing. That asymmetry is not a softening. A device that
  // loses the race has no choice but to retry — ADR 002 §4.2 makes retrying the protocol — so an
  // entry charge would meter the VICTIM of a race at the same rate as its winner, and two Macs
  // delivering on their own timers is the ordinary state of a family. Control: `e6-gate-keys`
  // §2d, which is the only row in the suite that dies if the charge moves above the pre-flight.
  // What stays unbudgeted is REQUEST VOLUME, which is the half of the old reason that was always
  // sound: the caller is a known, unrevoked device of a current member.
  //
  // ⚠ AND WHAT THIS RULE DOES NOT CLOSE, because the first reading of the finding claimed it did.
  // `e6-gate-keys` §2a — a joiner starved for ever — reads like a race a rung budget would bound.
  // It is not. ONE rotation carrying wraps nobody can open leaves every honest device `noRing` at
  // the current epoch, so it can never rotate to the next one; the eleven that followed in the
  // original row changed nothing the first had not already done. No rate bounds "one". The
  // control that reaches it is ADR 002 §8.5a's owed "I cannot open epoch e" report (T5 residual
  // 3), in `handlers/keys.js` and on the wire. This rule bounds how many epochs may be poisoned
  // in an hour (§3d) and nothing more, and §2a is still an adversary SUCCESS.
  //
  // ⚠ WHAT THE BUDGET DOES AND DOES NOT CLOSE, because a limiter is not a repair. It PRICES the
  // ladder: reaching the wall becomes hours of continuous, authenticated, attributable rotation
  // by a named member — long enough for `removeMember` to end it — instead of one unattended
  // burst. It does not make the ladder reversible. The residual is a pruning/compaction route,
  // or a `rotateTo` that sends only the rows that are missing; both are protocol work
  // (ADR 002 §4.2, ADR 003 §3.7), and `e6-gate-keys.test.js` §1c keeps the wall itself on the
  // record so the residual cannot be forgotten.
  rotateEpoch: cov([], ['epochRotate'], null),

  // ── authenticated, and bounded by the auth identity rather than by a bucket ─
  revokeDevice: cov([], [], AUTHED_REASON('acts only on the caller\'s own member\'s devices')),
  fetchKeys: cov([], [], AUTHED_REASON('read-only, space-scoped, bounded by the wrap count')),
  // ⚠ THE "AT MOST 8" IN THIS LINE WAS NOT A BOUND THIS FILE HELD, and the line used to read as
  // though it were. ADR 003 §3.2 says the piggybacked roster is "at most 8 rows"; when the
  // round-2 adversary looked, `grep -rn 'MAX_MEMBERS|too_many_members' server/core/` was EMPTY,
  // and she reached eight live members — five of them one Mac — without meeting a refusal.
  //
  // The cap is real work and it is NOT this file's. A rate rule bounds a RATE; a membership
  // ceiling is a CARDINALITY refusal on the one route that admits a member —
  // `handlers/invites.js#redeemInvite`, beside the colour and open-invite checks it already
  // runs. That is where it belongs and that is where the two-key/lifecycle round is landing it
  // (`MAX_LIVE_MEMBERS`). This row's job is only to stop asserting a bound it does not hold.
  //
  // It matters here for one reason beyond tidiness: the recipient set is what `MAX_WRAPS = 1024`
  // (`handlers/spaces.js`) is divided by, so the epoch wall that `epochRotate` above now prices
  // sits at `MAX_WRAPS / recipients`. An unbounded roster walks that wall toward the attacker,
  // and `epochRotationsPerMemberHour` is sized against a family, not against a crowd.
  listMembers: cov([], [], AUTHED_REASON('read-only, one row per member; ADR 003 §3.2\'s "at most 8" is a cardinality gate for redeemInvite and never was a fact this table could rely on')),
  renameSpace: cov([], [], AUTHED_REASON('one column write in the caller\'s own space')),
  // T5-M1b: the route now also spends at most ONE extra P-256 verify, on a presented
  // `adminProof`. Still not an amplifier — a caller must already be an authenticated member of
  // the space, one verify is the same order as the request's own auth signature, and a refused
  // proof deletes nothing — but the reason is written down rather than left reading as though
  // the route were free.
  deleteSpace: cov([], [], AUTHED_REASON('idempotent; the second call has nothing to delete; at most one extra signature verify for an adminProof')),
  createInvite: cov([], [], AUTHED_REASON('any current member may issue one (E2-203-2: the server cannot check "admin"); bounded instead by MAX_OPEN_INVITES = 20 per space, which bounds what volume here could actually buy — redeemable memberships, not table rows')),
  revokeInvite: cov([], [], AUTHED_REASON('one column write in the caller\'s own space')),
  openInvites: cov([], [], AUTHED_REASON('read-only, space-scoped')),
  leaveSpace: cov([], [], AUTHED_REASON('self-only, idempotent')),
  transferAdmin: cov([], [], AUTHED_REASON('mirrors the in-log chain and is never authoritative (ADR 006 §9)')),
});

function cov(pre, post, why) {
  return Object.freeze({ pre: Object.freeze(pre), post: Object.freeze(post), why });
}

function AUTHED_REASON(detail) {
  return (
    'No §6.1 limiter declared here. Reachable only after the full ADR 003 §2 chain (nonce claimed, device ' +
    'known and unrevoked, signature verified, membership current), so the caller is a known ' +
    'device of a current member and a flood is attributable and revocable with one column ' +
    `write. ${detail}.`
  );
}

// ATTESTED_REASON was here. It said device registration and A2 adoption were "NOT comfortable"
// and unlimited, and handed the decision to LZP-204. LZP-204 took it (10/IP/hour, both routes,
// separate buckets), so the excuse has been replaced by a rule: RATE_RULES.deviceRegister /
// .deviceAdopt, LIMIT_EXTENSIONS E2-L4 / E2-L5. The reasoning it carried survives there, where it
// is now attached to a number instead of to the absence of one.

function UNLIMITED_PAIR_REASON() {
  return (
    'No §6.1 limiter. `pair/answer` and `pair/deliver` are unauthenticated by necessity — ' +
    'device B has no identity until pairing completes — and are addressed by a `rid` an ' +
    'attacker must already know, i.e. must already have guessed 60 bits or observed. The ' +
    'guessing path is what `pairRidMiss` bounds on `pair/get`; these two are the tail of a ' +
    'rendezvous that already exists. What is NOT bounded is an attacker who knows a live rid ' +
    'overwriting boxB repeatedly — harmless, because the SAS comparison (ADR 002 §6.4) is what ' +
    'the pairing rests on and a substituted box changes the digits on one screen. Reported as ' +
    'E2-205-3 for LZP-204: the per-rid attempt budget (Store.bumpPairAttempts, limits.pairAttempts) ' +
    'is the control ADR 002 §6.2 specifies here, and ADR 002 §6.2 does not say who observes the ' +
    'failed decrypt that is supposed to bump it.'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Enforcement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Consume one unit of a rule's budget, or throw `429 rate_limited` with `Retry-After`.
 *
 * **Fail closed on every ambiguity.** An adapter that returns `undefined`, a rule name that does
 * not exist, a limit that is not a positive integer, an identity that did not validate — each of
 * those denies rather than admits. The one thing this must never do is treat "I could not tell"
 * as "yes": a rate limiter that opens when the store is confused is a rate limiter an attacker
 * confuses on purpose.
 *
 * **`Retry-After` is the whole window, always.** `Store.rateAllow` is a TUMBLING window over
 * `RateBucket{key,count,windowStart}` — three columns cannot express a sliding one, as
 * `memory.js` records — and it returns a boolean, not a remaining time. So the only honest
 * answer is the window length: it never under-advises, and a client that honours it (ADR 003
 * §8.2) always finds the budget reset. Advising less would produce a retry that fails again,
 * which is worse than waiting.
 *
 * @param {Object} ctx a ServerCtx
 * @param {string} ruleName a key of RATE_RULES
 * @param {string} identity a value already through clientIp/deviceIdentity/memberIdentity
 * @returns {Promise<void>}
 * @throws {import('./errors.js').HttpError} 429 rate_limited · 500 internal
 */
export async function enforce(ctx, ruleName, identity) {
  const rule = RATE_RULES[ruleName];
  if (!rule) throw fail('internal');
  const max = numberFrom(ctx && ctx.limits, rule.limit);
  if (!Number.isInteger(max) || max < 1) throw fail('internal');
  if (typeof identity !== 'string' || identity === '') throw fail('internal');
  const store = ctx && ctx.store;
  if (!store || typeof store.rateAllow !== 'function') throw fail('internal');

  const allowed = await store.rateAllow(rateKey(ruleName, identity), rule.windowMs, max);
  if (allowed !== true) {
    throw fail('rate_limited', { retryAfter: Math.ceil(rule.windowMs / 1000) });
  }
}

/**
 * Resolve a rule's identity from what is available, and enforce it.
 * @param {Object} req @param {Object} ctx @param {string} ruleName
 * @param {{deviceShort?:string, memberId?:string}} [auth]
 */
export async function enforceFor(req, ctx, ruleName, auth) {
  const rule = RATE_RULES[ruleName];
  if (!rule) throw fail('internal');
  let identity;
  if (rule.identity === 'ip') identity = clientIp(req);
  else if (rule.identity === 'device') identity = deviceIdentity(auth && auth.deviceShort);
  else identity = memberIdentity(auth && auth.memberId);
  await enforce(ctx, ruleName, identity);
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * INTEGRATION WARNING — READ BEFORE COMPOSING THIS AT THE ROUTER
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ██ RESOLVED AT INTEGRATION (LZP-207): **option (b)**. ██
 * `server/core/handlers/index.js` composes `createRouter(withVersionGate(handlers))` and does
 * NOT wrap with `withLimits`, because every handler charges its own budget — now all of them
 * through `enforceFor`, so the double-charge that made (a) attractive is the only thing (a)
 * would have bought. `tests/server/blindness.test.js` asserts the composition site does not
 * mention `withLimits` while any handler still calls `enforceFor`, so the two cannot both be on.
 * What DID change at integration is the second half of (a): the four numbers LZP-202..204
 * invented locally are now `RATE_RULES` entries (`spaceCreate`, `deviceRegister`, `deviceAdopt`,
 * `memberRemove`), and their call sites are `enforceFor(...)` — so every bucket key in the
 * server now goes through `rateKey()`, which is what the blindness note at the top of this file
 * is about. `withLimits` is kept, tested, and unused: it is the composition (a) would need.
 *
 * The original warning, unchanged, because the reasoning is what makes the choice reviewable:
 *
 * The handlers that landed alongside this file (`server/core/handlers/*.js`, LZP-202..204) each
 * limit themselves, through a local `enforceRate(ctx, key, windowMs, max, retryAfterSec)` defined
 * in `handlers/devices.js`, over their own key namespace (`invites:redeem:ip:…`, `pair:get:ip:…`,
 * `push:<deviceShort>`, …). Their own comments say so and hand the namespace to this ticket:
 * *"LZP-205 owns server/core/limits.js and the rest of §6.1. When it lands it owns this key
 * namespace too; until then push and pull are limited here rather than not at all, because an
 * unlimited append endpoint is the one thing a public relay must not ship."* That was the right
 * call and it means the relay is not shipping unlimited today.
 *
 * It also means **applying `withLimits` on top of those handlers double-charges every pre-auth
 * rule**: `redeemInvite` would spend one unit here and one unit inside `invites.js`, halving the
 * documented budget. So LZP-207, at the composition site, must do exactly one of:
 *
 *   (a) compose `createRouter(withVersionGate(withLimits(handlers)))` AFTER the handlers have
 *       been converged onto `enforceFor` and their local limiters removed — the intended end
 *       state, because it puts every §6.1 number in one table and every bucket key through
 *       `rateKey()`'s validation; or
 *   (b) compose `createRouter(withVersionGate(handlers))` — no `withLimits` — while the handlers
 *       still self-limit.
 *
 * There is no correct third option, and the difference is visible: (b) leaves the bucket keys as
 * interpolated template strings built from `clientIpOf(req)`, which is the shape the blindness
 * note at the top of this file is about.
 */

/**
 * Wrap a handler registry so every `pre-auth` rule for a route runs before its handler does.
 *
 * Composed at the one place the registry is built:
 *
 *     createRouter(withVersionGate(withLimits(handlers)))
 *
 * The `post-auth` rules cannot live here — they need the identity that `ctx.auth(req)` produces
 * — so `pushOps`, `pullOps` and `pairOffer` call `enforceFor(req, ctx, 'push'|'pull'|'pairSession', auth)`
 * themselves, immediately after authenticating. `tests/server/limits.test.js` greps every
 * handler file that exists for exactly that call and fails on a route whose `post` rules are
 * declared in `RATE_COVERAGE` and absent from its source, so a handler landing later cannot land
 * unlimited.
 *
 * @param {Object<string, Function>} handlers
 * @returns {Object<string, Function>}
 */
export function withLimits(handlers) {
  const out = {};
  for (const name of Object.keys(handlers || {})) {
    const inner = handlers[name];
    if (typeof inner !== 'function') { out[name] = inner; continue; }
    const pre = (RATE_COVERAGE[name] && RATE_COVERAGE[name].pre) || [];
    if (pre.length === 0) { out[name] = inner; continue; }
    out[name] = async function rateLimited(req, ctx) {
      for (const ruleName of pre) {
        // A failure-only rule is spent by the handler (noteFailedRidLookup), never on entry.
        if (RATE_RULES[ruleName] && RATE_RULES[ruleName].onFailureOnly) continue;
        await enforceFor(req, ctx, ruleName, null);
      }
      return inner(req, ctx);
    };
  }
  return out;
}

/**
 * Consume one unit of the failed-`rid`-lookup budget (E2-L1). Called by `pairGet` on a MISS —
 * an unknown, expired or burned rid — and never on a hit.
 *
 * It throws 429 like any other limiter, and the caller should let it: an IP that has missed five
 * times in a minute is guessing, and the honest response to a guesser is to stop answering, not
 * to keep answering 404 until the hourly budget runs out.
 *
 * @param {Object} req @param {Object} ctx @returns {Promise<void>}
 */
export async function noteFailedRidLookup(req, ctx) {
  await enforceFor(req, ctx, 'pairRidMiss', null);
}

/**
 * Read a limit out of `ctx.limits`, falling back to the shipped constant.
 *
 * The fallback is the safe direction and is chosen deliberately: a `ctx` built with an incomplete
 * or mistyped limits object gets THE REAL LIMIT, rather than either denying every request (an
 * outage caused by a typo) or admitting every request (a limiter silently disabled by a typo). A
 * limit that IS a number but is not a usable one — 0, negative, fractional — is a different
 * thing: `enforce` refuses it as `500 internal`, because someone meant something by it.
 */
function numberFrom(limits, name) {
  const src = limits && typeof limits === 'object' ? limits : LIMITS;
  const v = Object.prototype.hasOwnProperty.call(src, name) ? src[name] : LIMITS[name];
  return typeof v === 'number' ? v : LIMITS[name];
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Logging that cannot leak  (ADR 003 §6.2 · stories 21.3, 21.4)
// ─────────────────────────────────────────────────────────────────────────────
//
// Story 21.3 is a promise about what the operator of the relay can see. The database side of it
// is `store-interface.js`'s closed column set. The OTHER side is this: a log line is a readable
// string, written by the same process that just held a decrypted-by-nobody envelope in a local
// variable, on infrastructure whose request logs are retained by a third party (Vercel). One
// `ctx.log({ ...req.body })` written in a hurry during a debugging session undoes the entire
// design, and it would look completely reasonable in review.
//
// THE MECHANISM, and why it is not a blocklist. A blocklist of forbidden field names fails the
// day someone logs `{ payload: op }`. So the sanitiser **never enumerates the caller's object**.
// It iterates `LOG_FIELD_NAMES` — a fixed list of seven — and pulls only those keys, each
// through a validator for its own shape. There is no code path from an unnamed property to the
// output, so `{envelope}`, `{payload}`, `{op}`, `{body}` and a name nobody has thought of yet are
// all equally unreachable. The blocklist below (`LOG_FORBIDDEN`) exists only so the TEST can
// state what it is proving.

/**
 * ADR 003 §6.2's field set, verbatim and complete: `{route, spaceId, deviceShort, opCount,
 * byteCount, status, ms}`.
 *
 * Nothing has been added. An error `code` and the name of the limiter that fired would both be
 * genuinely useful to an operator staring at a wall of 429s, and both are absent, because §6.2
 * is normative and widening a privacy allowlist for debugging convenience is precisely the
 * decision this file exists to make hard. Reported as E2-205-4: if the operator experience needs
 * `code`, that is an ADR 003 §6.2 amendment, made deliberately, not a line added here.
 */
export const LOG_FIELDS = Object.freeze({
  route: Object.freeze({ kind: 'route' }),
  spaceId: Object.freeze({ kind: 'pattern', re: /^(psp|fsp)_[A-Za-z0-9_-]{22}$/ }),
  deviceShort: Object.freeze({ kind: 'pattern', re: DEVICE_SHORT_RE }),
  opCount: Object.freeze({ kind: 'count', max: 1000000 }),
  byteCount: Object.freeze({ kind: 'count', max: 1000000000 }),
  status: Object.freeze({ kind: 'status' }),
  ms: Object.freeze({ kind: 'count', max: 3600000 }),
});

export const LOG_FIELD_NAMES = Object.freeze(Object.keys(LOG_FIELDS));

/**
 * The closed set `route` may take: every handler name, plus two the hosts need.
 *
 * `route` is an ENUM, not a path. A raw `req.path` would carry `/api/v1/pair/<rid>` — the
 * rendezvous id, which is HKDF of the pairing code — straight into a log line, and `:id`
 * segments generally are attacker-chosen text of attacker-chosen length. Restricting the field
 * to a name from the route table removes the whole category.
 */
export const LOG_ROUTES = Object.freeze([...ROUTE_NAMES, 'unmatched', 'health']);

/**
 * Every identifier that must never reach a log, DERIVED so it cannot rot: every opaque column of
 * every model, plus `errors.js`'s forbidden body fields, plus the pairing boxes and the
 * shapes ADR 003 §6.2 names by hand. Adding an opaque column to `store-interface.js`
 * automatically extends this list.
 */
export const LOG_FORBIDDEN = Object.freeze([...new Set([
  ...Object.values(OPAQUE_FIELDS).flat(),
  ...FORBIDDEN_BODY_FIELDS,
  'envelope', 'iv', 'ct', 'sig', 'wrapped', 'wrappedKeys', 'boxA', 'boxB', 'delivery',
  'code', 'rid', 'nonce', 'verifier', 'attestation', 'wrapSalt', 'recoveryPubSig',
  'recoveryPubKex', 'sigPubRaw', 'kexPubRaw', 'chain', 'witness', 'headChain',
  'body', 'rawBody', 'payload', 'op', 'ops', 'stack', 'message', 'error', 'path', 'query',
  'headers', 'authorization', 'colorRef', 'displayName',
])].sort());

/**
 * Build the ONE object a log line may contain.
 *
 * Never throws — a logger that can throw turns a diagnostic into an outage. An unusable field is
 * omitted entirely rather than replaced with a placeholder derived from it.
 *
 * @param {unknown} evt
 * @returns {Object} a fresh object carrying a subset of LOG_FIELD_NAMES and nothing else
 */
export function sanitizeLogEvent(evt) {
  const out = {};
  if (!evt || typeof evt !== 'object') return out;
  for (const name of LOG_FIELD_NAMES) {
    let v;
    // A getter on the caller's object may throw, and a Proxy may do worse. Reading is the only
    // thing here that touches caller code, so it is the only thing wrapped.
    try {
      if (!Object.prototype.hasOwnProperty.call(evt, name)) continue;
      v = evt[name];
    } catch { continue; }
    if (v === undefined || v === null) continue;
    const spec = LOG_FIELDS[name];

    if (spec.kind === 'route') {
      if (typeof v === 'string' && LOG_ROUTES.includes(v)) out[name] = v;
      continue;
    }
    if (spec.kind === 'pattern') {
      if (typeof v === 'string' && spec.re.test(v)) out[name] = v;
      continue;
    }
    if (spec.kind === 'status') {
      if (typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599) out[name] = v;
      continue;
    }
    // 'count'
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const n = Math.floor(v);
    if (n < 0) continue;
    out[name] = n > spec.max ? spec.max : n;
  }
  return out;
}

/**
 * The canonical one-line serialisation. Bounded by construction: seven fields, each a validated
 * scalar, so the line can never exceed a couple of hundred characters no matter what was handed
 * in. Hosts should use this rather than hand-rolling `JSON.stringify`, so there is exactly one
 * place where a log line becomes text.
 *
 * @param {unknown} evt @returns {string}
 */
export function formatLogLine(evt) {
  return JSON.stringify(sanitizeLogEvent(evt));
}

/**
 * `ctx.log`. The sink receives the SANITISED object — it never sees the caller's original — so a
 * host cannot accidentally serialise the wrong one.
 *
 * @param {(evt:Object) => void} sink
 * @returns {(evt:Object) => void}
 */
export function createLog(sink) {
  const emit = typeof sink === 'function' ? sink : () => {};
  return function log(evt) {
    try { emit(sanitizeLogEvent(evt)); } catch { /* a broken sink must not fail a request */ }
  };
}
