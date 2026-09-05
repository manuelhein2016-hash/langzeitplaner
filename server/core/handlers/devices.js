// server/core/handlers/devices.js — device registration, adoption and revocation.  LZP-204.
//
// ADR 003 §3 (`POST /devices`, `/devices/adopt`, `/devices/revoke`), ADR 002 §2.3 (attestation),
// §7.3 (A2 recovery), ADR 001 §1.2 (`deviceShort`), story 19.5.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE IS A SECURITY BOUNDARY AND NOT A CRUD ENDPOINT
// ─────────────────────────────────────────────────────────────────────────────────────────────
// These three routes are the ONLY ones in the table that are not in `SPACE_SCOPED` and are not
// authenticated by a device signature — they cannot be. A device that is registering has, by
// definition, no row for `authenticate()` step 4 to find. So the authorization has to come from
// somewhere else, and there is exactly one thing available: **the attestation, signed by the
// member's recovery key, whose public half the server already holds as `Member.recoveryPubSig`**.
//
// That is not defence in depth. It is load-bearing, and it became load-bearing the moment
// `keys.js` started enforcing rotation coverage:
//
//   > The coverage check (ADR 002 §4.2) REQUIRES an honest rotator to wrap the new family key to
//   > every non-revoked device of every current member. If anyone could POST a device row naming
//   > an existing `memberId`, the coverage rule would stop being a protection and become an
//   > attack amplifier: the attacker registers a device under Mama's member id, and the next
//   > honest rotation is *forced* to wrap FSK_{e+1} to the attacker's public key or be refused.
//
// So registration verifies, server-side, all three of the checkable §2.3 conditions:
//
//   P2  `deviceShort === crock32(SHA-256(sigPubRaw)[0..10])`   — ADR 001 §1.2, the self-certifying
//       part. A device cannot claim a short it did not derive from its own signing key.
//   S1  the attestation blob's signature verifies under the HOUSING member's `recoveryPubSig`
//       — §2.3 condition (4), with the housing member taken from the request's `memberId` and
//       never from the payload's self-declared one.
//   S2  every field inside the signed payload equals the field presented in the request
//       — §2.3 conditions (2) and (3), so the row the relay stores is the row the member signed.
//   ID  `deviceId` is `dev_` + 22 b64url and nothing else — finding R8-7b, the OTHER thing these
//       two doors admitted that `readDevice` has always refused. It is not a §2.3 condition
//       either: it is what keeps `Device.id` out of `KeyWrap.recipientId`'s reserved `rec_`
//       namespace. See `DEVICE_ID_RE` for the two attacks it was open to.
//   C   the payload's field set is CLOSED — six names, one optional seventh, nothing else. Not a
//       §2.3 acceptance condition at all: a story 21.1 one, because `GET /spaces/:id/members`
//       publishes this blob. See "THE DOOR IS NOT A PARSER" at `assertAttestationClosed`, which
//       is finding R8-7 and the reason this file gained a check that has nothing to do with keys.
//
// Condition (1) — `op.act === memberId` — is a log-level check and stays on the clients
// (ADR 001 §4.0). The server never sees an op's author.
//
// WHAT IS STILL TRUE AFTER ALL OF THAT: a member's recovery key can attach as many devices to
// its own member as it likes. That is not an attack, it is the definition of §7.3 (A2 recovery:
// "the only path that survives losing every device"). Whoever holds RK_sig *is* the member.
//
// PURITY (ADR 003 §9). No clock, no `node:fs`, no `fetch`, no `process.env`. `crypto.subtle` is
// used for SHA-256 and one ECDSA verification: both are deterministic pure functions of their
// input, neither is I/O, and the alternative — hand-rolling a second SHA-256 and a P-256
// verifier inside `server/core/` — would ship more security-critical code, not less. If the
// runtime has no `subtle`, every check here FAILS CLOSED (500), never "skipped".

import { fail } from '../errors.js';
import { clientIp, enforceFor } from '../limits.js';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §0 SHARED HANDLER PRIMITIVES — TEMPORARY HOME
//
// `server/core/` has no codec module and this pass owns no shared file (one owner per file), so
// the four E2 handler files this pass ships import these from here. They are NOT device logic.
// LZP-207 should hoist §0 into `server/core/codec.js` + `server/core/limits.js` unchanged and
// re-point the three imports; nothing else has to move.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64U_INDEX = (() => {
  const m = Object.create(null);
  for (let i = 0; i < B64U.length; i++) m[B64U[i]] = i;
  return m;
})();

/**
 * Strict base64url decode. No padding, no standard-base64 `+`/`/`, and a trailing partial group
 * whose spare bits are set is rejected — so one blob has exactly one encoding and an attacker
 * cannot present two spellings of the same bytes to two different checks.
 * @param {unknown} s @returns {Uint8Array|null} null on anything malformed; never throws
 */
export function b64uToBytes(s) {
  if (typeof s !== 'string') return null;
  if (s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const ch of s) {
    const v = B64U_INDEX[ch];
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 255;
      acc &= (1 << bits) - 1;
    }
  }
  if (acc !== 0) return null;          // non-canonical: spare bits set
  return out;
}

/** @param {Uint8Array} b @returns {string} */
export function bytesToB64u(b) {
  let out = '';
  let i = 0;
  for (; i + 3 <= b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += B64U[(n >>> 18) & 63] + B64U[(n >>> 12) & 63] + B64U[(n >>> 6) & 63] + B64U[n & 63];
  }
  const rest = b.length - i;
  if (rest === 1) {
    const n = b[i] << 16;
    out += B64U[(n >>> 18) & 63] + B64U[(n >>> 12) & 63];
  } else if (rest === 2) {
    const n = (b[i] << 16) | (b[i + 1] << 8);
    out += B64U[(n >>> 18) & 63] + B64U[(n >>> 12) & 63] + B64U[(n >>> 6) & 63];
  }
  return out;
}

/**
 * The requesting IP comes from `server/core/limits.js` (LZP-205), which is the owner of every
 * §6.1 number and of `RateBucket.key`'s alphabet. It is re-exported here only so the three
 * sibling handler files this pass ships have one import; the LOGIC is not duplicated.
 *
 * ⚠ `clientIp` is only as trustworthy as the edge in front of it. On Vercel `x-forwarded-for` is
 * set by the platform and a client-supplied one is overwritten; on a host that does not overwrite
 * it, a client can spoof the header and evade every per-IP limit. The structural fix is for the
 * platform adapter (`api/v1/index.js`, LZP-207) to put the connection's real peer address
 * on `req.clientIp`. Recorded as owed rather than assumed.
 */
export { clientIp };

/**
 * Charge one unit against a limiter that `RATE_RULES` does not model, or throw `429 rate_limited`.
 *
 * **Everything `server/core/limits.js` DOES model goes through `enforce`/`enforceFor` instead**,
 * so §6.1's numbers live in one table. This exists for exactly one case: device registration and
 * A2 adoption, which LZP-205's own `RATE_COVERAGE` marks unlimited and flags as **E2-205-2 —
 * "NOT comfortable … an attacker can still burn function invocations making the server verify
 * signatures that fail" — and hands to LZP-204 to decide**. This is that decision, taken on the
 * safe side and reported for an ADR 003 §6.1 amendment (E2-L2).
 *
 * The key is built the same way `rateKey()` builds one — JSON, never a join — and from
 * identities that have already been through `clientIp`/`memberIdentity`, so no header text can
 * reach `RateBucket.key` (`PLAINTEXT_STRINGS` justifies that column as "route + device/IP, never
 * content", and this is the other half of making that true).
 *
 * @param {Object} ctx @param {string} rule @param {string} identity already sanitised
 * @param {number} windowMs @param {number} max
 */
export async function enforceRate(ctx, rule, identity, windowMs, max) {
  const ok = await ctx.store.rateAllow(JSON.stringify([rule, identity]), windowMs, max);
  if (!ok) throw fail('rate_limited', { retryAfter: Math.ceil(windowMs / 1000) });
}

/** @param {unknown} v @returns {Object} @throws 400 */
export function requireObject(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw fail('bad_request', { reason: 'body_not_an_object' });
  return v;
}

/**
 * A required opaque id field: a non-empty string of a conservative alphabet and a bounded
 * length. The alphabet matters — the file adapter turns ids into map keys and the router already
 * refuses separators in a path segment; this refuses them in a body.
 * @param {Object} body @param {string} field @param {number} [max]
 * @returns {string}
 */
export function requireId(body, field, max) {
  const v = body[field];
  if (typeof v !== 'string' || v.length === 0 || v.length > (max || 128) || !/^[A-Za-z0-9_.:-]+$/.test(v)) {
    throw fail('bad_request', { field });
  }
  return v;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 `deviceShort` — ADR 001 §1.2, the ONE definition in the system
// ═════════════════════════════════════════════════════════════════════════════════════════════

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 16 Crockford characters, exactly. Mirrors `src/js/core/ids.js`'s `DEVICE_SHORT_RE`. */
export const DEVICE_SHORT_RE = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{16}$/;

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `dev_` + 22 b64url IS THE ONLY SPELLING OF A DEVICE ID — finding R8-7b
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The same value as `handlers/spaces.js`'s `DEVICE_ID_RE` and `src/js/core/entities.js`'s.
 * Restated rather than imported: `spaces.js` imports its parser, its codec and its signature
 * check FROM THIS FILE, so importing back would close a module cycle for one regex.
 * `tests/server/blindness.test.js` §7b pins the two to the same source, so a drift is a red row.
 *
 * `POST /devices` and `POST /devices/adopt` used to take `deviceId` through `requireId`, which
 * admits **128 characters of `[A-Za-z0-9_.:-]`**, while `readDevice` — the reader `POST /spaces`
 * and `POST /invites/redeem` go through — has always pinned `dev_` + 22 b64url and says in as
 * many words why: *"`KeyWrap.recipientId` admits a device id OR the reserved `rec_<memberId>`
 * (extension E2-I5); a device allowed to name itself `rec_mem_…` could therefore be handed the
 * wraps addressed to another member's recovery key … the two namespaces cannot meet."* On these
 * two doors they met. Measured on the shipped router (`round8-seam.test.js` §3):
 *
 *   1. **The wraps.** A current member registers a device whose id is literally
 *      `rec_<some OTHER member's id>`. `GET /spaces/:id/keys` answers
 *      `getKeyWraps(spaceId, auth.deviceId)`, so it hands her that member's recovery wraps. They
 *      stay ciphertext — they are sealed to a key she does not hold — so this is not a
 *      confidentiality break, and it is still a member reading rows addressed to another member.
 *   2. **The denial of service, which is the sharp half.** `POST /devices/revoke` calls
 *      `deleteKeyWrapsForDevices(spaceId, [deviceId])`, and that store method matches on
 *      `KeyWrap.recipientId`. So *register `rec_mem_MAMA` as a device, then revoke it* **deletes
 *      Mama's recovery wraps for every epoch** — and ADR 002 §7.3 calls A2 recovery "the only
 *      path that survives losing every device". One member, two ordinary requests, and another
 *      member's last way back in is gone. Neither route ever needed the laxer alphabet.
 *   3. **The free text.** `Device.id` is published verbatim by `GET /spaces/:id/members`
 *      (`DEVICE_PROJECTION`) and `PLAINTEXT_STRINGS` justifies it as *"a label, not an
 *      identity"*. A 128-character label a member chooses is the same story-21.1 channel R8-7
 *      closed one field over, wearing a different name.
 *
 * `memberId` is deliberately NOT tightened the same way: an unknown, a malformed and a removed
 * member must stay ONE answer (`not_a_member`, §4's `memberIn`), or this route becomes a member
 * oracle. Shape-refusing it first would make a malformed id distinguishable from an absent one.
 */
export const DEVICE_ID_RE = /^dev_[A-Za-z0-9_-]{22}$/;

/**
 * Crockford base32, MSB-first — byte-for-byte the encoder in `src/js/core/b64.js`.
 * Duplicated rather than imported because `server/core/` may import only from `server/core/`
 * (ADR 005 §2, enforced by `tests/helpers/purity.js`). The contract case below pins the two
 * implementations to the same output, so a drift is a test failure and not a mystery.
 * @param {Uint8Array} bytes @returns {string}
 */
export function crock32(bytes) {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    acc = (acc << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(acc >>> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 31];
  return out;
}

/** @returns {SubtleCrypto} @throws 500 — FAIL CLOSED, never "skip the check" */
function subtle() {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw fail('internal');
  return s;
}

/** @param {Uint8Array} bytes @returns {Promise<Uint8Array>} */
export async function sha256(bytes) {
  return new Uint8Array(await subtle().digest('SHA-256', bytes));
}

/**
 * `crock32(SHA-256(rawSigPublicKey)[0..10])` → 16 Crockford characters = 80 bits.
 * ADR 001 §1.2 verbatim, and the reason the server can bind a `deviceShort` to a public key at
 * registration at all.
 * @param {Uint8Array} sigPubRaw @returns {Promise<string>}
 */
export async function deviceShortOf(sigPubRaw) {
  const digest = await sha256(sigPubRaw);
  return crock32(digest.subarray(0, 10));
}

/**
 * ECDSA P-256 / SHA-256 verify over raw bytes. Returns a boolean and never throws for bad input:
 * a malformed key or signature from a caller is data, not a bug in this process. ADR 002 §1
 * rule 3 — branch on the try/catch boundary, never on an error name (Node and WebKit disagree).
 * @param {Uint8Array} pubRaw 65-byte uncompressed point
 * @param {Uint8Array} sig 64-byte raw r‖s
 * @param {Uint8Array} payload
 * @returns {Promise<boolean>}
 */
export async function verifyP256(pubRaw, sig, payload) {
  const s = subtle();
  if (payload.length === 0) return false;        // ADR 002 §1 rule 2 — never verify empty input
  let key;
  try {
    key = await s.importKey('raw', pubRaw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch { return false; }
  try {
    return await s.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, payload);
  } catch { return false; }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 The attestation blob — ADR 002 §2.3
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The six fields `attestDevice` signs (`src/js/crypto/identity.js`). */
export const ATTESTATION_FIELDS = Object.freeze(['memberId', 'deviceId', 'deviceShort', 'sigPubRaw', 'kexPubRaw', 'createdAt']);

/**
 * The optional seventh — ADR 002 §2.3's `recoveryPubKex`, the binding that lifts §4.2 step 2's
 * suspension (finding E2E3-8). It is allowed here BEFORE anything mints it, deliberately: the
 * relay's allow-list has to ship first (see "THE DOOR IS NOT A PARSER" below), and shape-checking
 * a field nobody sends yet costs nothing.
 */
export const ATTESTATION_OPTIONAL = Object.freeze(['recoveryPubKex']);

const MAX_ATTESTATION_CHARS = 4096;

/**
 * Split `b64u(canonicalJSON(att)) + '.' + b64u(sig)` without re-canonicalising anything.
 *
 * ⚠ **The signature is verified over the ORIGINAL payload bytes**, exactly as
 * `src/js/core/authz.js` does, and for the same two reasons: the server has no `canonicalJSON`
 * (it may not import `src/js/core/`), and re-serialising the six known fields would silently
 * drop the extra fields a v2.1 attestation may carry — which ARE covered by the signature — and
 * fail every future blob. Parsing is only ever used to CROSS-CHECK the request against what was
 * signed; it is never used to reconstruct what to verify.
 *
 * @param {unknown} blob
 * @returns {{payload:Uint8Array, sig:Uint8Array, att:Object}|null}
 */
export function parseAttestationBlob(blob) {
  if (typeof blob !== 'string' || blob.length === 0 || blob.length > MAX_ATTESTATION_CHARS) return null;
  const dot = blob.indexOf('.');
  if (dot <= 0 || dot === blob.length - 1) return null;
  if (blob.indexOf('.', dot + 1) !== -1) return null;
  const payload = b64uToBytes(blob.slice(0, dot));
  const sig = b64uToBytes(blob.slice(dot + 1));
  if (!payload || !sig || payload.length === 0 || sig.length !== 64) return null;
  let att;
  try { att = JSON.parse(new TextDecoder().decode(payload)); } catch { return null; }
  if (!att || typeof att !== 'object' || Array.isArray(att)) return null;
  for (const f of ATTESTATION_FIELDS) if (typeof att[f] !== 'string' || att[f].length === 0) return null;
  return { payload, sig, att };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE DOOR IS NOT A PARSER — finding R8-7, and the §2.3 design note round 8 left open
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `parseAttestationBlob` above TOLERATES extra fields and is right to. Round 8 then read that
// tolerance as a property of the SYSTEM and shipped the closed-set check on `readDevice`
// (`handlers/spaces.js`) only — so `POST /spaces` and `POST /invites/redeem` refused a seventh
// field and `POST /devices` and `POST /devices/adopt`, the two routes whose entire job is
// attaching a device, stored it verbatim. `GET /spaces/:id/members` publishes
// `Device.attestation` (finding E2E3-6), so that was a free-text channel through a relay whose
// whole promise is that it holds none: a member could POST „Großmutter Käthe" inside a payload
// every field of which is otherwise honest, and the relay served the word back to the family.
// Measured as row R8-7 in `tests/attack/round8-seam.test.js` §1; that row is now inverted.
//
// One rule, four doors. The check therefore lives HERE, in the file `spaces.js` already imports
// `parseAttestationBlob`, `bytesToB64u` and `verifyDeviceClaim` from, and it runs inside
// `verifyDeviceClaim` — which is the ONE thing all four doors that persist a `Device` row reach
// (`spaces.js createSpace` and `invites.js redeemInvite` through `readDevice`/`readAttestedDevice`,
// `registerDevice` and `adoptDevice` through `attachDevice`).
// `tests/server/blindness.test.js` §7a enumerates those four doors and drives the corpus word at
// each of them, and it also asserts that the set of handler files able to persist a device row is
// exactly the three that exist — so a FIFTH door reddens a row instead of quietly reopening this.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE DECISION ROUND 8 DID NOT TAKE: a closed set at the door vs ADR 002 §2.3's tolerance rule
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// Round 8 raised the objection and did not settle it: refusing an unknown field with `400` is
// "negotiation, not versioning" pointing the other way, and a legitimate v2.1 attestation would
// be REFUSED rather than parked. Settled here, and the reconciliation is that the two rules are
// about two different actors:
//
//   · **A client** that meets a field it does not know PARKS it (ADR 003 §4's N+1 half, ADR 001
//     §7.4). It can: an unknown field is inside a signature it can verify and inside a stream it
//     can read, so "keep it, do not interpret it" is available and is the right answer.
//   · **The relay** has no such option. It is not a reader of this blob, it is a PUBLISHER of it
//     — an opaque column it stores in the clear and hands to every member of the space. "Park it"
//     and "store it" are the same act here, so the only two answers a door has are *store the
//     bytes* — which is the free-text channel — or *refuse them*. Story 21.1's claim is that the
//     relay holds no free bits; a door that tolerates unknown fields makes that claim false.
//
// So the closed set is correct AND the forward-compatibility cost is real, and it is paid the
// way ADR 003 §4 already pays every other one: **N−1, in the server-first direction.** The
// relay's allow-list ships in the release BEFORE any client mints the field; `recoveryPubKex` is
// already on it (E2E3-8's binding is a client-only change when it lands, exactly as designed).
// This is versioning, not negotiation: there is no round trip, nothing is offered or withdrawn,
// and the client never asks what the relay accepts — the release order is the whole protocol.
//
// > **OWED — ADR 002 §2.3 text amendment, reported as a cross-file need.** §2.3's bullet
// > *"`parseAttestationBlob` already tolerates extra fields, deliberately, so a v2.0 client reads
// > a v2.1 blob unchanged"* is offered there as a reason a seventh field is cheap. It is true of
// > a CLIENT and false of the RELAY DOOR, which refuses one. The sentence to add, after that
// > bullet: *"That tolerance is a property of the parser and of clients. The relay's door is a
// > closed set (`assertAttestationClosed`), because the relay publishes this blob and cannot park
// > what it must store; a new field is therefore added to the relay's allow-list one release
// > BEFORE any client mints it — ADR 003 §4's N−1 rule, in the server-first direction."*

/**
 * ADR 002 §2.3's payload, as a CLOSED FIELD SET. Six required names, one optional, and nothing
 * else — so every field of a blob the relay publishes is a value it already holds in a column
 * (`memberId` → `Device.memberId`, `deviceId` → `Device.id`, `deviceShort`, `sigPubRaw`,
 * `kexPubRaw` → the same columns, all four pinned field-by-field by S2 below) or a DAY, which is
 * strictly coarser than the `Device.addedAt` millisecond the relay cannot avoid keeping. Zero
 * free bits.
 *
 * **THE ONE COPY, AS OF THE ROUND-9 INTEGRATION PASS.** It used to be two — this one and a
 * private twin in `handlers/spaces.js` — kept "byte-for-byte the same" by hand, and
 * `blindness.test.js` §7a measured them already differing in one word after a single round. One
 * rule with two implementations is a rule that drifts, and the drift is silent: each door goes on
 * passing its own tests. `spaces.js` now imports THIS function, so all four doors that persist a
 * `Device` row run the same bytes, and a door that were stricter than its sibling — the asymmetry
 * R8-7 closed, pointing the other way — is no longer expressible.
 *
 * The error carries no caller-supplied text. `field` is a caller-chosen NAME, and it is the
 * caller's job to have run it through `safeField` — every caller does, and `spaces.js`'s
 * `readDevice` is why the parameter exists at all: its error bodies name the door
 * (`device.attestation`, `devices[0].attestation`) and losing that would be a worse report for a
 * client with several devices in one request. The REASON is an enum in both cases, so a refusal
 * cannot echo the smuggled word back out (`blindness.test.js` §6 searches every error body for
 * the corpus, and §7a walks all four doors with it).
 *
 * @param {Object} att the PARSED payload — never a re-serialisation
 * @param {string} [field] the already-`safeField`ed name for the error body
 * @throws {HttpError} 400
 */
export function assertAttestationClosed(att, field = 'attestation') {
  for (const k of Object.keys(att)) {
    if (!ATTESTATION_FIELDS.includes(k) && !ATTESTATION_OPTIONAL.includes(k)) {
      throw fail('bad_request', { field, reason: 'attestation_unknown_field' });
    }
  }
  // `createdAt` is the only required field not pinned to a column by S2, so it is the only one
  // that could carry anything. ADR 002 §2.3 types it 'YYYY-MM-DD'.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(att.createdAt)) {
    throw fail('bad_request', { field, reason: 'attestation_createdAt' });
  }
  if (att.recoveryPubKex !== undefined) {
    const raw = b64uToBytes(att.recoveryPubKex);
    if (!raw || raw.length !== P256_POINT_LEN) {
      throw fail('bad_request', { field, reason: 'attestation_recoveryPubKex' });
    }
  }
}

/**
 * The whole server-side half of ADR 002 §2.3, in one place so neither `/devices` nor
 * `/devices/adopt` can drift from the other.
 *
 * @param {{member:Object, deviceId:string, deviceShort:string, sigPubRaw:Uint8Array,
 *          kexPubRaw:Uint8Array, attestation:string}} claim
 * @returns {Promise<{payload:Uint8Array, att:Object}>}
 * @throws {HttpError} 400 on P2 and on the closed field set (R8-7), 401 `bad_signature` on S1/S2
 */
export async function verifyDeviceClaim(claim) {
  // P2 — the self-certifying half. Checked FIRST and independently of the signature, because it
  // is the one property that holds even against a member attesting to their own lie: a member
  // cannot mint a device row under a `deviceShort` they did not derive from its signing key, so
  // they cannot pre-empt or shadow a peer's short.
  const derived = await deviceShortOf(claim.sigPubRaw);
  if (derived !== claim.deviceShort) {
    throw fail('bad_request', { check: 'deviceShort', reason: 'not_derived_from_sigPubRaw' });
  }

  const parsed = parseAttestationBlob(claim.attestation);
  if (!parsed) throw fail('bad_signature', { check: 'attestation_shape' });

  // R8-7 — the CLOSED FIELD SET, before the signature and on every door. Before, because a
  // smuggled field is a shape fault and not a forgery: the attacker signs it perfectly well with
  // her own recovery key, so S1 can never be what catches it. `readDevice` runs the same rule at
  // the same point on the other two doors, and running it twice on those is free.
  assertAttestationClosed(parsed.att);

  // S1 — under the HOUSING member's recovery key, never the payload's self-declared memberId.
  const ok = await verifyP256(claim.member.recoveryPubSig, parsed.sig, parsed.payload);
  if (!ok) throw fail('bad_signature', { check: 'attestation_signature' });

  // S2 — the row we are about to store is the row that was signed.
  const a = parsed.att;
  if (a.memberId !== claim.member.id) throw fail('bad_signature', { check: 'attestation_memberId' });
  if (a.deviceId !== claim.deviceId) throw fail('bad_signature', { check: 'attestation_deviceId' });
  if (a.deviceShort !== claim.deviceShort) throw fail('bad_signature', { check: 'attestation_deviceShort' });
  if (a.sigPubRaw !== bytesToB64u(claim.sigPubRaw)) throw fail('bad_signature', { check: 'attestation_sigPubRaw' });
  if (a.kexPubRaw !== bytesToB64u(claim.kexPubRaw)) throw fail('bad_signature', { check: 'attestation_kexPubRaw' });

  return { payload: parsed.payload, att: a };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 Limits — ADR 003 §6.1 has no row for these three, so they are stated here rather than
// invented at a call site. LZP-205 owns `server/core/limits.js` and should absorb them.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const DEVICE_LIMIT_DEFAULTS = Object.freeze({
  /** Registration is unauthenticated. It is also the amplifier the coverage check would arm if
   *  it were free, so it gets the tightest per-IP budget in the API. */
  deviceRegPerIpHour: 10,
  /** A2 recovery is rarer still, and every failure is a wrong-passphrase or a probe. */
  deviceAdoptPerIpHour: 10,
});

const HOUR = 3600000;
const limitOf = (ctx, name) => (ctx.limits && typeof ctx.limits[name] === 'number' ? ctx.limits[name] : DEVICE_LIMIT_DEFAULTS[name]);

/** 65-byte uncompressed P-256 points, both of them. Nothing else is a public key here. */
const P256_POINT_LEN = 65;

function requirePoint(body, field) {
  const raw = b64uToBytes(body[field]);
  if (!raw || raw.length !== P256_POINT_LEN || raw[0] !== 0x04) throw fail('bad_request', { field });
  return raw;
}

/**
 * Find the member row, refusing a removed one. There is no `getMember(memberId)` in the
 * SyncStore, which is why every route here carries an explicit `spaceId`: `listMembers(spaceId)`
 * is the only lookup available, and requiring the caller to name the space also means a device
 * can never be attached to a member in a space the request did not mention.
 * @returns {Promise<Object>}
 */
async function memberIn(store, spaceId, memberId) {
  const members = await store.listMembers(spaceId);
  const m = members.find((x) => x.id === memberId);
  // Unknown member, removed member and unknown space are ONE answer on purpose: a probe learns
  // only that it may not do this, never whether `mem_…` exists.
  if (!m || m.removedAt !== null) throw fail('not_a_member');
  return m;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 The handlers
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Shared body of `/devices` and `/devices/adopt`.
 *
 * The two routes exist because the CLIENT arrived by two different roads — pairing (ADR 002 §6
 * step 8) and backup import (§7.3 step 5). **The server cannot distinguish them and does not
 * pretend to:** both are authorized by exactly one thing, a signature under
 * `Member.recoveryPubSig`, and writing two different checks would mean one of them was weaker.
 * The routes differ only in their limiter key and in what the response tells the UI to expect.
 *
 * @param {Object} req @param {Object} ctx @param {'register'|'adopt'} mode
 * @returns {Promise<Object>}
 */
async function attachDevice(req, ctx, mode) {
  // Integrated (LZP-207): E2-205-2 is now closed in the table and not only in this file. Two
  // rules rather than one, so a burst of A2 recovery attempts cannot exhaust the budget that
  // admits a freshly paired Mac. See LIMIT_EXTENSIONS E2-L4 / E2-L5.
  await enforceFor(req, ctx, mode === 'adopt' ? 'deviceAdopt' : 'deviceRegister', null);

  const body = requireObject(req.body);
  const spaceId = requireId(body, 'spaceId');
  const memberId = requireId(body, 'memberId');
  // R8-7b — one spelling of a device id, on this door as on the other two. See `DEVICE_ID_RE`.
  const deviceId = requireId(body, 'deviceId');
  if (!DEVICE_ID_RE.test(deviceId)) throw fail('bad_request', { field: 'deviceId' });
  const deviceShort = body.deviceShort;
  if (typeof deviceShort !== 'string' || !DEVICE_SHORT_RE.test(deviceShort)) {
    throw fail('bad_request', { field: 'deviceShort' });
  }
  const sigPubRaw = requirePoint(body, 'sigPubRaw');
  const kexPubRaw = requirePoint(body, 'kexPubRaw');
  if (typeof body.attestation !== 'string') throw fail('bad_request', { field: 'attestation' });

  const space = await ctx.store.getSpace(spaceId);
  if (!space) throw fail('not_a_member');            // same answer as an unknown member — §4 above
  const member = await memberIn(ctx.store, spaceId, memberId);

  await verifyDeviceClaim({ member, deviceId, deviceShort, sigPubRaw, kexPubRaw, attestation: body.attestation });

  const attestationBytes = new TextEncoder().encode(body.attestation);

  const result = await ctx.store.tx(async (tx) => {
    // Idempotency, and the one collision that matters — NOW READ PER SPACE (round 10 item 8).
    // `deviceShort` is a function of the signing key, so a second registration under the same
    // short IN THIS SPACE is either the SAME device retrying (fine — 200, no write) or a second
    // member of THIS circle trying to claim a key that already belongs to someone here. The
    // latter is refused: it is how a removed member would try to re-attach a known-good short to
    // a fresh member row.
    //
    // What it deliberately no longer refuses is the same Mac appearing in ANOTHER space. That
    // refusal was finding E2-203-1 — it blocked 19.4 + 15.2 outright — and it was also a denial
    // of service, because `GET /spaces/:id/members` publishes `sigPubRaw` to every member of a
    // circle and this door is authorized by an attestation the caller signs with her OWN
    // recovery key. Any member of your circle could therefore mint a row carrying your short and
    // burn the one global slot your Mac would ever have. Per space, that row is local to her
    // circle and inert in it: she cannot authenticate as it (ADR 003 §2 step 5 wants the private
    // key). The residual — that she can still keep a KNOWN Mac out of HER OWN circle by
    // pre-empting its short there — is finding R10-8a and is recorded in ADR 003 §5.1.
    const existingShort = await tx.getDeviceByShort(spaceId, deviceShort);
    if (existingShort) {
      if (existingShort.memberId !== memberId || existingShort.id !== deviceId) {
        throw fail('bad_request', { taken: 'deviceShort' });
      }
      return { device: existingShort, created: false };
    }
    const existingId = await tx.getDevice(deviceId);
    if (existingId) throw fail('bad_request', { taken: 'deviceId' });

    const row = {
      id: deviceId,
      spaceId,
      memberId,
      deviceShort,
      sigPubRaw,
      kexPubRaw,
      attestation: attestationBytes,
      lastSeenSeq: 0n,
      lastPushedSeq: 0n,
      addedAt: new Date(ctx.now()),
      revokedAt: null,
    };
    await tx.addDevice(row);
    return { device: row, created: true };
  });

  // §7.3 step 6 — the honest waiting state. A freshly attached device holds no wrap until some
  // member device rotates or re-wraps, and the UI shows „Schlüssel ausstehend" rather than an
  // error. The server can answer this from coordination data alone: it counts wraps, it reads
  // none of them.
  const wraps = await ctx.store.getKeyWraps(spaceId, deviceId);

  if (typeof ctx.log === 'function') ctx.log({ route: req.routeName, spaceId, deviceShort, status: 200 });

  return {
    status: 200,
    body: {
      spaceId,
      memberId,
      deviceId,
      deviceShort,
      registered: result.created,
      currentEpoch: space.currentEpoch,
      keysPending: wraps.length === 0,
      // §4.1: a new own device rotates the PERSONAL space. The server states the obligation; it
      // cannot perform it, because performing it would mean holding a key.
      rotateRequired: true,
      serverTime: ctx.now(),
    },
  };
}

/**
 * `POST /api/v1/devices` — register an attested device (ADR 002 §6.3 step 8, story 19.5).
 *
 * **Deliberately not authenticated by `LZP1`** — see the file header. Authorized by the
 * attestation signature under `Member.recoveryPubSig`, which the server already holds.
 * @type {(req:Object, ctx:Object) => Promise<Object>}
 */
export async function registerDevice(req, ctx) {
  return attachDevice(req, ctx, 'register');
}

/**
 * `POST /api/v1/devices/adopt` — A2 recovery (ADR 002 §7.3 step 5).
 * "The server holds `Member.recoveryPubSig` (a public key) and verifies, then attaches the
 * device to the existing member. No admin involvement, no new invite."
 * @type {(req:Object, ctx:Object) => Promise<Object>}
 */
export async function adoptDevice(req, ctx) {
  return attachDevice(req, ctx, 'adopt');
}

/**
 * `POST /api/v1/devices/revoke` — story 19.5, unpair a device.
 *
 * **A device may be revoked only by a device of the SAME member.** Not by the admin, and not by
 * anyone else: the admin's power over a person is to remove the *member* (20.2, `lifecycle.js`),
 * which is visible to the whole circle and rotates the epoch. Letting an admin silently revoke
 * one of Mama's three Macs would be a surveillance-adjacent power the addendum's "the admin
 * manages the space — never the people" does not grant, and the server can refuse it cheaply
 * because `memberId` is exactly what auth returns.
 *
 * @type {(req:Object, ctx:Object) => Promise<Object>}
 */
export async function revokeDevice(req, ctx) {
  const auth = await ctx.auth(req);
  const body = requireObject(req.body);
  const spaceId = requireId(body, 'spaceId');
  const deviceId = requireId(body, 'deviceId');

  // WHICH MEMBER IS SPEAKING — resolved HERE, not read off `auth` (round 10 item 8).
  // `/devices/revoke` is not in `router.js`'s `SPACE_SCOPED`, so ADR 003 §2 step 4 had no space
  // to select a row with, and a Mac that is in a personal space AND a circle has a row in each.
  // `auth.memberId` is therefore `null` for exactly the users this round unblocked, and reading
  // it would have made the endpoint 403 for them. The short plus the space the body names is the
  // pair ADR 002 §2.3 calls the identity of a device, and it is what this resolves.
  const caller = await ctx.store.getDeviceByShort(spaceId, auth.deviceShort);
  // Unknown space, no row here, and revoked here are ONE answer: this endpoint may not tell a
  // prober which circles a short is in. (A revoked-here device would have answered
  // `device_revoked` at step 4 when the namespace was global; `not_a_member` says strictly less.)
  if (!caller || (caller.revokedAt !== null && caller.revokedAt !== undefined)) throw fail('not_a_member');
  const callerMemberId = caller.memberId;
  await ctx.assertMember(callerMemberId, spaceId);
  // No limiter, deliberately: `RATE_COVERAGE.revokeDevice` in `server/core/limits.js` reasons
  // that this route "acts only on the caller's own member's devices" and is reachable only after
  // the whole ADR 003 §2 chain. Adding a second, undeclared bucket here would put §6.1's policy
  // in two files that could disagree, and LZP-205 owns that table.

  const out = await ctx.store.tx(async (tx) => {
    const target = await tx.getDevice(deviceId);
    // Unknown device and someone else's device are one answer: a member may not enumerate the
    // device ids of the rest of the family by probing this endpoint.
    if (!target || target.memberId !== callerMemberId) throw fail('not_a_member');

    // Refusing to leave a member with no way back in. Revoking your own last device would strand
    // the member behind the A2 backup file, and the honest place to say that is here rather than
    // in a support conversation. `/members/leave` is the endpoint for "I want out".
    const devices = await tx.listDevices(spaceId);
    const live = devices.filter((d) => d.memberId === callerMemberId && d.revokedAt === null);
    if (live.length <= 1 && live.some((d) => d.id === deviceId)) {
      throw fail('bad_request', { reason: 'last_device', use: '/api/v1/members/leave' });
    }

    if (target.revokedAt !== null) return { revoked: false, purgedWraps: 0, deviceShort: target.deviceShort };

    await tx.revokeDevice(deviceId, ctx.now());
    // ADR 002 §4.2 step 4 deletes a revoked device's wraps on the next rotation. Doing it HERE
    // as well is not redundancy for its own sake: between the revocation and the rotation the
    // wraps for epochs 1..e would otherwise still be addressed to a device the member has just
    // said they no longer control.
    const purgedWraps = await tx.deleteKeyWrapsForDevices(spaceId, [deviceId]);
    return { revoked: true, purgedWraps, deviceShort: target.deviceShort };
  });

  if (typeof ctx.log === 'function') ctx.log({ route: req.routeName, spaceId, deviceShort: out.deviceShort, status: 200 });

  return {
    status: 200,
    body: {
      spaceId,
      deviceId,
      revoked: out.revoked,
      purgedWraps: out.purgedWraps,
      rotateRequired: true,                  // §4.1 — "my device unpaired → rotate the personal space"
      serverTime: ctx.now(),
    },
  };
}

/** The slice of the handler registry this file owns. `server/core/handlers/index.js` composes. */
export const handlers = Object.freeze({ registerDevice, adoptDevice, revokeDevice });
