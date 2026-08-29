// server/core/handlers/spaces.js — space creation (15.2) and epoch rotation (ADR 002 §4.2).
// LZP-203.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE IS FOR
// ─────────────────────────────────────────────────────────────────────────────────────────────
// Two endpoints and one security control.
//
//   POST /api/v1/spaces          15.2 — create a Familienkreis (or a personal space) and become
//                                its first member, in one transaction.
//   POST /api/v1/spaces/:id/epoch  ADR 002 §4.2 — rotate the space key, atomically, and
//                                **coverage-checked**.
//
// The coverage check is the reason this file exists in the shape it does. E3's red team wrote:
//
//   > "every server-enforced control in ADR 002 — rotation coverage, the rid burn, the 5-attempt
//   >  budget, all rate limits — exists in a contract and in no code that runs."
//
// `familyRecipients()` on the client takes the member list from its caller, so an admin rotating
// the family key can silently omit one honest member and cut them off from everything written
// after the bump. ADR 002 §4.2 names the answer: *"the server rejects an epoch bump whose wraps
// do not cover every current, non-revoked device of every non-removed member. This is checkable
// from coordination data alone."* `assertCoverage` below is that check, and `listDevices`
// (interface extension E2-I1) is what makes it expressible at all.
//
// It is a DENIAL the server refuses, not a grant it hands out — 20.5 survives untouched. The
// server still cannot read a wrap, cannot tell a good wrap from 156 bytes of noise, and cannot
// decrypt anything. All it does is count (recipient, epoch) rows, which is coordination data by
// construction.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE COVERAGE RULE, STATED ONCE
// ─────────────────────────────────────────────────────────────────────────────────────────────
// After any write that changes the key ring, for the space's epoch E:
//
//     for every required recipient r, a KeyWrap row (space, e, r) exists for EVERY e in 1..E
//
// where the required recipients are `rec_<memberId>` for every non-removed member (ADR 002 §4.2
// step 2's "plus each member's RK_kex" — finding E3-2) plus the id of every non-revoked device of
// every non-removed member.
//
// The "every e in 1..E" half is not decoration. ADR 002 §7.1 step 5, rewritten for D9:
//
//   > The wrap covers **all epochs 1..e**, so the joiner sees the shared history — Oma's birthday
//   > entered three years ago must render (A4, 17.1, risk R11). A wrap that covers only the
//   > current epoch is a bug, and the server enforces wrap coverage.
//
// Before D9 that history arrived in the invite blob (§4.3, "delivered by the invite blob"). D9
// deleted the blob and did not delete the requirement, so the rotation that follows a join is now
// the ONLY delivery path for epochs 1..e — and a rotation that wraps only e+1 leaves the joiner
// permanently unable to read anything the family wrote before she arrived. The server can see
// that mistake without reading a single byte of key material, so it refuses it.
//
// Because the rule is checked on every write, it is an INVARIANT rather than a one-off: creation
// establishes it at E = 1 and each rotation re-establishes it at E + 1, so a client can never
// arrive at a state where an honest member is quietly missing three years of history.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE WIRE HELPERS LIVE HERE AND NOT IN A NEW MODULE
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ADR 005 §1.6 enumerates `server/core/handlers/`: meta, ops, spaces, invites, members, devices,
// keys, pair. That list is the file inventory, not a suggestion, and a `codec.js` invented here
// would be a file two work packages could both create under two names. So the b64url codec, the
// id shapes and the strict body reader live in this file — the root entity of the three this
// ticket owns — and `members.js` and `invites.js` import them. The dependency runs one way,
// spaces → members → invites, and never back.
//
// PURITY (ADR 003 §9). No clock, no randomness, no I/O, no globals: `ctx.now()`, `ctx.random()`,
// `ctx.store`. `atob`/`btoa` are used as pure functions over a string; nothing else ambient is
// touched.

import { fail } from '../errors.js';
import { clientIp, rateKey, enforceFor } from '../limits.js';
// ADR 002 §2.3's server-side half, written ONCE in `devices.js` so that `POST /devices`,
// `POST /devices/adopt`, `POST /spaces` and `POST /invites/redeem` cannot drift from each other.
// The import runs spaces → devices, the same direction `keys.js` already imports in; devices.js
// imports only `errors.js` and `limits.js`, so there is no cycle.
import { parseAttestationBlob, verifyDeviceClaim, assertAttestationClosed } from './devices.js';

// ─────────────────────────────────────────────────────────────────────────────
// 0. What this handler needs from `ctx` that docs/v2/contracts/server.contract.js §1 does not
//    declare, and what it needs from the schema that it cannot have.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two additions to `ServerCtx`. Recorded as data, in the style of
 * `server/core/store-interface.js`'s `INTERFACE_EXTENSIONS`, because a reviewer must either
 * agree with them or reverse them — and because the entry point that builds `ctx`
 * (`server/api/**`, LZP-207) has to supply them.
 */
export const CTX_EXTENSIONS = Object.freeze([
  Object.freeze({
    id: 'E2-C1',
    member: 'ctx.sha256',
    shape: '(bytes: Uint8Array) => Promise<Uint8Array>',
    why:
      'ADR 002 §7.1 stores `verifier = SHA-256(HKDF(code,…,"verify",32))` and has redemption '
      + 'present the HKDF output, so the server MUST hash to check it. Storing the presented '
      + 'value instead would make a database dump sufficient to redeem every open invite, which '
      + 'is precisely the property D9 exists to buy. The digest is injected rather than imported '
      + 'for the same reason `now` and `random` are: ADR 003 §9 forbids a handler reaching for an '
      + 'ambient primitive, and a test must be able to drive it.',
    suppliedBy: 'the entry point, as (b) => new Uint8Array(await crypto.subtle.digest("SHA-256", b))',
  }),
]);

/**
 * Structural problems these handlers ran into that cannot be fixed inside this file, each with
 * the file that owns the fix. Frozen and exported so `tests/server/spaces.test.js` can assert
 * they are still stated, rather than leaving them in a commit message nobody reads again.
 */
export const HANDLER_FINDINGS = Object.freeze([
  Object.freeze({
    id: 'E2-203-1',
    status: 'CLOSED round 10 (item 8) — kept, not deleted, because the reasoning is the record.',
    what:
      'WAS: Device.deviceShort was @unique GLOBALLY while Device.memberId points at exactly one '
      + 'Member, which is per-space. One Mac could therefore have a Device row in exactly ONE '
      + 'space. But ADR 002 §2.1 mints IK_sig per DEVICE, not per space, so a Mac has one '
      + 'deviceShort for life, and the product requires that Mac to be in a personal space (19.4) '
      + 'AND a family space (15.2) at once — ADR 003 §10.2 even budgets "8 members x 2 spaces" of '
      + 'pull traffic. NOW: the namespace is the SPACE, @@unique([spaceId, deviceShort]).',
    consequence:
      'WAS: a user who had paired a second Mac (so a psp_ space exists) could not create or join '
      + 'a Familienkreis — the main flow of 15.2/15.3, blocked for exactly the users who bought '
      + 'the multi-device feature. And worse than a product bug: deviceShort is a FUNCTION of a '
      + 'public key that GET /spaces/:id/members publishes to every member of the space, and '
      + 'POST /devices is authorized by an attestation the caller signs with her own recovery '
      + 'key — so any member of your circle could compute your short, register it under her own '
      + 'member and burn the ONE global slot your Mac would ever have.',
    fix:
      'DONE, and NOT as proposed here. This row proposed @@unique([memberId, deviceShort]); that '
      + 'is one notch too loose (two members of one circle could then hold the same short, and '
      + 'ADR 003 §2 step 4 would have two rows in one space and nothing to choose on), and — the '
      + 'half this row was silent about and tests/server/attack-relay-correlate.test.js §2 '
      + 'measured — it hands T1 a CROSS-SPACE CORRELATION column: one machine\'s identical '
      + 'deviceShort in a row in every circle it belongs to. Shipped instead: Device.spaceId + '
      + '@@unique([spaceId, deviceShort]); auth step 4 resolves (deviceShort, spaceId) through '
      + 'listDevicesByShort and verifies the signature against the key every row shares. The '
      + 'correlation is NOT fixed by any of this — it is created by one Mac having a row in two '
      + 'spaces at all, it is stronger through sigPubRaw than through deviceShort, and only a '
      + 'per-space device signing key would remove it. Stated in docs/v2/server-metadata.md §7 '
      + 'and in ADR 003 §5.1; the residual squat is finding R10-8a.',
    owner: 'CLOSED — server/prisma/schema.prisma, server/core/store-interface.js, server/core/auth.js',
  }),
  Object.freeze({
    id: 'E2-203-2',
    what:
      'The server cannot authorize "admin only" on ANY route. ADR 003 §5.1 removed the role '
      + 'column on purpose ("the admin is resolved from the in-log chain"), and '
      + 'FORBIDDEN_COLUMN_TOKENS forbids adding one back. So 15.5 ("revocable by the admin") and '
      + '20.1 ("as admin I can invite, revoke invites, remove members, rename, transfer") have no '
      + 'server-side enforcement point.',
    consequence:
      'Every route this ticket ships authorizes "any current, non-removed member of the space". '
      + 'A hostile family member can issue and revoke invites. Under ADR 002 §0 T5 that is inside '
      + 'the accepted model — it is a coordination nuisance, not a read of anyone\'s data, and it '
      + 'is visible to everyone (15.4). It is NOT inside the model for `POST /members/remove` and '
      + '`POST /spaces/:id/delete`, which is why neither is implemented here: an unverifiable '
      + '"admin" endpoint that purges another member\'s ops is the censorship primitive ADR 003 '
      + '§6.3 explicitly rejects.',
    fix:
      'Either state in an ADR that admin actions are client-enforced from the in-log chain and '
      + 'the server is deliberately permissive, or give the server a verifiable admin proof (a '
      + 'signature by the current admin\'s RK_sig over the request) it can check without a role '
      + 'column. The second is buildable; it is a protocol change and not this ticket\'s call.',
    owner: 'ADR 003 §2 / PO — decision D7 adjacent',
  }),
  Object.freeze({
    id: 'E2-203-3',
    what:
      'Story 15.6 ("I can change my display name and colour anytime and it propagates") has no '
      + 'colour half. The name travels as a `member.set` op inside the ciphertext and works. The '
      + 'colour is `Member.colorRef`, a server column under @@unique([spaceId, colorRef]) — and '
      + 'there is no route in ADR 003 §3 that writes it and no SyncStore method that updates it.',
    consequence: 'A member can pick a colour once, at join, and never change it.',
    fix:
      'A `POST /api/v1/members/color { spaceId, colorRef }` route plus a `setMemberColor(memberId, '
      + 'colorRef)` store method that fails on the unique constraint. Both are one-liners; '
      + 'neither is inventable from inside a handler, because router.js owns the table and '
      + 'store-interface.js owns the method set.',
    owner: 'server/core/router.js + server/core/store-interface.js',
  }),
  Object.freeze({
    id: 'E2-203-4',
    what:
      'Invite.wrapSalt is vestigial under D9. It was the salt for the invite blob\'s KDF; D9 '
      + 'deleted the blob. The column is non-null, so `putInvite` must still supply 32 bytes.',
    consequence:
      'Every invite stores 32 bytes that mean nothing. `createInvite` fills them from '
      + '`ctx.random(32)` rather than from the request body, deliberately: a caller-supplied salt '
      + 'is 32 attacker-chosen bytes parked on the relay against an id the attacker also chose, '
      + 'i.e. a small covert store. Server-generated, it carries no information at all.',
    fix: 'Drop the column, or make it nullable, when the schema is next opened.',
    owner: 'server/prisma/schema.prisma + server/core/store-interface.js',
  }),
  Object.freeze({
    id: 'E2-203-6',
    what:
      '`limits.js` RATE_COVERAGE marks `createSpace` unlimited under AUTHED_REASON — "reachable '
      + 'only after the full ADR 003 §2 chain (nonce claimed, device known and unrevoked, '
      + 'signature verified, membership current)". That is true of every other authenticated '
      + 'route and false of this one and of `redeemInvite`: both are BOOTSTRAP routes that '
      + 'register the very device they are signed by, so §2 step 4 has no Device row to look up '
      + 'and step 6 has no Member. Anyone who can generate a P-256 keypair passes.',
    consequence:
      '`POST /spaces` would be an unauthenticated row generator on a free-tier database. This '
      + 'handler therefore charges a local 5-per-IP-per-hour bucket through limits.js\'s own '
      + '`rateKey`/`clientIp`, which is protection rather than a gap, but it is a number invented '
      + 'in a handler instead of published in ADR 003 §6.1.',
    fix:
      'Add a `spaceCreate` entry to RATE_RULES (ip, hour, pre-auth), flip RATE_COVERAGE.createSpace '
      + 'to declare it, and replace the local call with `enforceFor(req, ctx, "spaceCreate")`. The '
      + 'same review should decide whether `registerDevice` and `adoptDevice` — already flagged by '
      + 'LZP-205 as E2-205-2 — are the same shape of problem.',
    owner: 'server/core/limits.js (LZP-205) + ADR 003 §6.1',
  }),
  Object.freeze({
    id: 'E2-203-5',
    what:
      '`POST /api/v1/spaces/:id/rename` (20.1) has nothing to write. The addendum §3 sketch is '
      + 'explicit that the space name "travels encrypted", ADR 003 §5.1 keeps no name column, and '
      + 'FORBIDDEN_COLUMN_TOKENS would refuse one. The rename is a `space.set` op in the log.',
    consequence: 'The route stays 501 not_implemented. Nothing is lost; the rename works via POST /ops.',
    fix: 'Remove the route from ADR 003 §3 and from router.js, or document it as reserved.',
    owner: 'ADR 003 §3 + server/core/router.js',
  }),
]);

// ─────────────────────────────────────────────────────────────────────────────
// 1. The wire codec — b64url, strictly and canonically
// ─────────────────────────────────────────────────────────────────────────────

const B64U_CHARS = /^[A-Za-z0-9_-]*$/;

/** @param {Uint8Array} u8 @returns {string} */
export function bytesToB64u(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode b64url, and refuse anything that is not the ONE canonical encoding of the bytes it
 * yields. Two properties matter and neither is free:
 *
 *   · a non-canonical encoding (padding, `+/`, stray trailing bits) must not decode, because two
 *     spellings of one value are two cache keys, two idempotency keys and two audit lines; and
 *   · a decode failure must be a 400, never a throw that becomes a 500 with the input in the
 *     message — `toResponse` would swallow it, but the operator's log would not.
 *
 * @param {unknown} value @param {string} field @param {{len?:number, maxLen?:number}} [opts]
 * @returns {Uint8Array}
 */
export function b64uToBytes(value, field, opts) {
  const o = opts || {};
  if (typeof value !== 'string' || value === '' || value.length > 4 * 1024 * 1024) {
    throw fail('bad_request', { field: safeField(field), reason: 'not_b64u' });
  }
  if (!B64U_CHARS.test(value) || value.length % 4 === 1) {
    throw fail('bad_request', { field: safeField(field), reason: 'not_b64u' });
  }
  let bin;
  try {
    bin = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4));
  } catch {
    throw fail('bad_request', { field: safeField(field), reason: 'not_b64u' });
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  if (bytesToB64u(out) !== value) {
    // Trailing bits that the encoder would never have set. Refuse rather than normalise.
    throw fail('bad_request', { field: safeField(field), reason: 'not_canonical' });
  }
  if (typeof o.len === 'number' && out.length !== o.len) {
    throw fail('bad_request', { field: safeField(field), reason: 'wrong_length' });
  }
  if (typeof o.maxLen === 'number' && out.length > o.maxLen) {
    throw fail('payload_too_large', { field: safeField(field) });
  }
  return out;
}

/**
 * Field names ride back to the client on the error body, and the client chose most of them. A
 * 200 KB key name echoed verbatim turns `400 bad_request` into a reflector; so only a name that
 * looks like a field name is echoed, and everything else becomes the literal string `field`.
 * @param {unknown} name @returns {string}
 */
export function safeField(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_.[\]]{1,48}$/.test(name) ? name : 'field';
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Id and token shapes — the one plaintext leak is also the one smuggling channel
// ─────────────────────────────────────────────────────────────────────────────

const B22 = '[A-Za-z0-9_-]{22}';
export const SPACE_ID_RE = new RegExp(`^(?:psp_|fsp_)${B22}$`);
export const MEMBER_ID_RE = new RegExp(`^mem_${B22}$`);
export const DEVICE_ID_RE = new RegExp(`^dev_${B22}$`);
export const INVITE_ID_RE = new RegExp(`^${B22}$`);
/** 16 Crockford base32 (ADR 001 §1.2). Crockford excludes I, L, O and U. */
export const DEVICE_SHORT_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{16}$/;
/**
 * `colorRef` is the ONE deliberately readable string a client can write (ADR 003 §5.2), which
 * makes it the one place a note's text could be smuggled into the relay in the clear. It is a
 * palette index — `blau`, `gruen`, `schiefer` (src/js/palette.js) — so it is bounded to a short
 * lowercase token here. The server does not hard-code the palette: that would couple the relay to
 * a client release and buy nothing the length bound does not already buy.
 */
export const COLOR_REF_RE = /^[a-z][a-z0-9-]{1,23}$/;

/** The reserved recipient form for a member's RK_kex (interface extension E2-I5, finding E3-2). */
export const RECOVERY_PREFIX = 'rec_';
/** @param {string} memberId @returns {string} */
export const recoveryRecipient = (memberId) => RECOVERY_PREFIX + memberId;

// ─────────────────────────────────────────────────────────────────────────────
// 3. The strict body reader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read an object with a CLOSED field set. An unknown key is a 400, not an ignored key.
 *
 * This is the handler-side mirror of `MODEL_COLUMNS` (store-interface.js RULE 1). The store
 * refuses to *hold* a column that is not declared; this refuses to *accept* a field that is not
 * declared, so `{"spaceId": "...", "displayName": "Mama"}` is rejected at the door instead of
 * being quietly dropped one layer further in. Silently dropping is worse than refusing: it makes
 * a client that thinks it is sending a name look like it is working.
 *
 * @param {unknown} value @param {string[]} allowed @param {string[]} required @param {string} where
 * @returns {Object}
 */
export function readObject(value, allowed, required, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('bad_request', { field: safeField(where), reason: 'not_an_object' });
  }
  for (const k of Object.keys(value)) {
    if (!allowed.includes(k)) {
      throw fail('bad_request', { field: safeField(where ? `${where}.${k}` : k), reason: 'unknown_field' });
    }
  }
  for (const k of required) {
    if (!Object.prototype.hasOwnProperty.call(value, k)) {
      throw fail('bad_request', { field: safeField(where ? `${where}.${k}` : k), reason: 'missing' });
    }
  }
  return value;
}

/** @param {Object} obj @param {string} key @param {RegExp} re @param {string} where @returns {string} */
export function readId(obj, key, re, where) {
  const v = obj[key];
  const field = where ? `${where}.${key}` : key;
  if (typeof v !== 'string' || v.length > 128 || !re.test(v)) {
    throw fail('bad_request', { field: safeField(field), reason: 'bad_shape' });
  }
  return v;
}

/** @param {Object} obj @param {string} key @param {string} where @param {{len?:number,maxLen?:number}} [opts] */
export function readBytes(obj, key, where, opts) {
  return b64uToBytes(obj[key], where ? `${where}.${key}` : key, opts);
}

/** @param {Object} obj @param {string} key @param {string} where @param {{min:number,max:number}} range */
export function readInt(obj, key, where, range) {
  const v = obj[key];
  const field = where ? `${where}.${key}` : key;
  if (!Number.isSafeInteger(v) || v < range.min || v > range.max) {
    throw fail('bad_request', { field: safeField(field), reason: 'bad_shape' });
  }
  return v;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Shared handler plumbing — auth, membership, rate limits
// ─────────────────────────────────────────────────────────────────────────────

/** Public-key material as it crosses the wire. 65-byte raw P-256 points (ADR 002 §2.1). */
const P256_RAW_LEN = 65;
/**
 * An attestation is `b64u(canonicalJSON(payload)) + '.' + b64u(sig)` — ADR 002 §2.3. It is
 * OPAQUE in the sense that matters (the relay cannot read the family's data through it) and it
 * is emphatically NOT opaque in the sense E2 first read it: it has a shape, six named fields,
 * and a signature the relay can and does check, because `Member.recoveryPubSig` is a column.
 */
const ATTESTATION_MAX = 4096;
/** A WrapBlob is ~156 bytes of JSON (ADR 002 §3). A kilobyte is four times the honest size. */
export const WRAP_MAX_BYTES = 1024;
/**
 * Wraps per rotation. Eight members x three devices + eight recovery recipients is 32 recipients;
 * a first-ever backfill across 32 epochs is 1024 rows. Past that a family is not a family, and
 * the request cap (ADR 003 §6.1, 4 MB) would land first anyway.
 */
export const MAX_WRAPS = 1024;

/** One hour, in ms. */
export const HOUR_MS = 3600000;

/**
 * Space creations per IP per hour.
 *
 * ADR 003 §6.1 publishes no limiter for `POST /spaces`, and `limits.js`'s `RATE_COVERAGE` marks
 * the route unlimited on the grounds that it is "reachable only after the full ADR 003 §2 chain".
 * That reasoning is right for every other authenticated route and WRONG for this one — see
 * finding E2-203-6. `POST /spaces` is a bootstrap route: it registers the very device it is
 * signed by, so §2 step 4 has no row to look up and anyone who can mint a P-256 keypair passes.
 * Five per hour is generous for a human (a person creates one space, once) and is the difference
 * between a bounded endpoint and an open row generator on a free-tier database.
 *
 * The number is a stand-in, stated rather than hidden: LZP-205 owns §6.1 and the moment
 * `RATE_RULES` gains a `spaceCreate` entry this should become `enforceFor(req, ctx, 'spaceCreate')`
 * like every other limiter.
 */
export const SPACES_PER_IP_HOUR = 5;

/**
 * Read a limit off `ctx.limits` with a documented default. A missing or nonsensical value must
 * not mean "unlimited": the default applies instead.
 * @param {Object} ctx @param {string} name @param {number} fallback @returns {number}
 */
export function limitOf(ctx, name, fallback) {
  const v = ctx && ctx.limits ? ctx.limits[name] : undefined;
  return Number.isSafeInteger(v) && v > 0 ? v : fallback;
}

/**
 * Charge one unit of a local budget. Deliberately built out of `limits.js`'s `rateKey` and
 * `clientIp` rather than out of an interpolated string: the key alphabet check and the
 * `x-vercel-forwarded-for` → `x-real-ip` → `x-forwarded-for` trust order are decisions LZP-205
 * made and wrote down, and a second handler-local copy of them would drift.
 *
 * @param {Object} ctx @param {string} key already through `rateKey()`
 * @param {number} windowMs @param {number} max
 * @throws {HttpError} 429 with Retry-After
 */
export async function enforceRate(ctx, key, windowMs, max) {
  if (!Number.isInteger(max) || max < 1) throw fail('internal');
  const ok = await ctx.store.rateAllow(key, windowMs, max);
  if (ok !== true) throw fail('rate_limited', { retryAfter: Math.ceil(windowMs / 1000) });
}

/**
 * Resolve the caller and prove they are a current member of `spaceId`.
 *
 * The membership check is done HERE as well as in the auth ladder (ADR 003 §2 step 7). That is
 * deliberate duplication: `SPACE_SCOPED` in router.js tells the auth layer where to find the
 * space id, and a route added to the table without a matching entry there would silently skip
 * step 7 for every handler that trusted it. A handler that re-checks cannot be the victim of that
 * omission, and the cost is one `listMembers` a space-scoped route was going to make anyway.
 *
 * @param {Object} req @param {Object} ctx @param {string} spaceId
 * @returns {Promise<{auth:Object, member:Object}>}
 */
export async function requireActiveMember(req, ctx, spaceId) {
  const auth = await ctx.auth(req);
  if (!auth || typeof auth.memberId !== 'string' || auth.memberId === '') throw fail('not_a_member');
  if (typeof ctx.assertMember === 'function') await ctx.assertMember(auth.memberId, spaceId);
  const members = await ctx.store.listMembers(spaceId);
  const member = members.find((m) => m.id === auth.memberId) || null;
  // Unknown, in another space, or removed — all three answer the same 403. A caller who is not in
  // the circle learns nothing about whether the circle exists.
  if (!member || member.removedAt !== null) throw fail('not_a_member');
  return { auth, member };
}

/**
 * The bootstrap ladder, for the two routes that publish a device key rather than presenting one
 * the server already holds: `POST /spaces` and `POST /invites/redeem`.
 *
 * ADR 003 §2 step 4 looks the `Device` up by `deviceShort` and 403s when it is unknown — which is
 * every first request a Mac ever makes. So on these two routes the auth layer verifies `sig`
 * against the public key IN THE BODY and returns `{deviceShort, deviceId:null, memberId:null}`.
 * This function is the handler's half of that contract: whatever the auth layer did, the device
 * short it authenticated must be the one being registered, so a caller cannot sign with key A and
 * register key B.
 *
 * @param {Object} req @param {Object} ctx @param {string} deviceShort
 * @returns {Promise<Object>} the AuthResult
 */
export async function requireSelfAuth(req, ctx, deviceShort) {
  const auth = await ctx.auth(req);
  if (!auth || typeof auth.deviceShort !== 'string' || auth.deviceShort !== deviceShort) {
    throw fail('device_mismatch');
  }
  return auth;
}

/** Log with the ADR 003 §6.2 whitelist and nothing else. @param {Object} ctx @param {Object} evt */
export function logOk(ctx, evt) {
  if (typeof ctx.log !== 'function') return;
  const out = {};
  for (const k of ['route', 'spaceId', 'deviceShort', 'opCount', 'byteCount', 'status', 'ms']) {
    if (evt[k] !== undefined) out[k] = evt[k];
  }
  ctx.log(out);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Reading a device and a member off the wire
// ─────────────────────────────────────────────────────────────────────────────

const DEVICE_FIELDS = ['deviceId', 'deviceShort', 'sigPubRaw', 'kexPubRaw', 'attestation'];
const MEMBER_FIELDS = ['memberId', 'recoveryPubSig', 'recoveryPubKex'];

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ONE SPELLING OF `device.attestation`, ON EVERY ROUTE THAT WRITES ONE — finding E2E3-7
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * It used to be two. `POST /devices` took the blob STRING and stored `TextEncoder.encode(blob)`
 * after `verifyDeviceClaim` checked P2, S1 and S2; `POST /spaces` (and `POST /invites/redeem`,
 * which shares this reader) took base64url and ran it through `readBytes`, verifying **nothing**.
 * So `Device.attestation` had no type: the same column held UTF-8 of a dotted blob on one path
 * and arbitrary decoded bytes on another, and a reader could not tell which without guessing.
 *
 * That was survivable only for as long as nobody READ the column. `GET /spaces/:id/members` now
 * publishes it (finding E2E3-6 — it is the roster `familyRecipients()` is built from), and a
 * publication of a field with two encodings publishes two different things.
 *
 * **The `/devices` contract wins**, in both halves:
 *
 *   · the wire carries the blob STRING and the column holds its UTF-8 bytes, everywhere; and
 *   · the blob must PARSE and must be SELF-CONSISTENT with the device row it arrives in.
 *
 * The second half is enforced here, synchronously, because this reader is shared with
 * `invites.js` — which calls it without `await` — and because it is exactly the part of ADR 002
 * §2.3's check that needs no key: does the signed payload say the same thing as the request?
 * `verifyDeviceClaim`'s S2, minus the `memberId` clause, which needs the member row.
 *
 * **What this reader still does NOT do is verify the SIGNATURE.** That is P2 + S1 and it is
 * async, so it lives in `readAttestedDevice` below, which `createSpace` calls. `redeemInvite`
 * does not yet call it — see the note on `readAttestedDevice`.
 *
 * @param {unknown} raw @param {string} where
 * @returns {{deviceId:string, deviceShort:string, sigPubRaw:Uint8Array, kexPubRaw:Uint8Array,
 *            attestation:Uint8Array, attestationBlob:string}}
 */
export function readDevice(raw, where) {
  const d = readObject(raw, DEVICE_FIELDS, DEVICE_FIELDS, where);
  // The id shape is load-bearing, not cosmetic. `KeyWrap.recipientId` admits a device id OR the
  // reserved `rec_<memberId>` (extension E2-I5); a device allowed to name itself `rec_mem_…`
  // could therefore be handed the wraps addressed to another member's recovery key. `dev_` + 22
  // b64url is the only accepted spelling, so the two namespaces cannot meet.
  const out = {
    deviceId: readId(d, 'deviceId', DEVICE_ID_RE, where),
    deviceShort: readId(d, 'deviceShort', DEVICE_SHORT_RE, where),
    sigPubRaw: readBytes(d, 'sigPubRaw', where, { len: P256_RAW_LEN }),
    kexPubRaw: readBytes(d, 'kexPubRaw', where, { len: P256_RAW_LEN }),
    attestationBlob: readAttestationBlob(d, where),
  };
  const parsed = parseAttestationBlob(out.attestationBlob);
  if (!parsed) throw fail('bad_request', { field: safeField(`${where}.attestation`), reason: 'attestation_shape' });
  const a = parsed.att;
  assertAttestationClosed(a, safeField(`${where}.attestation`));
  // S2 without the member clause. Every field the relay is about to STORE must be the field the
  // member SIGNED — otherwise the row and the blob describe two different devices, and the blob
  // is the half every client verifies.
  if (a.deviceId !== out.deviceId) throw fail('bad_request', { field: safeField(`${where}.attestation`), reason: 'attestation_deviceId' });
  if (a.deviceShort !== out.deviceShort) throw fail('bad_request', { field: safeField(`${where}.attestation`), reason: 'attestation_deviceShort' });
  if (a.sigPubRaw !== bytesToB64u(out.sigPubRaw)) throw fail('bad_request', { field: safeField(`${where}.attestation`), reason: 'attestation_sigPubRaw' });
  if (a.kexPubRaw !== bytesToB64u(out.kexPubRaw)) throw fail('bad_request', { field: safeField(`${where}.attestation`), reason: 'attestation_kexPubRaw' });
  out.attestation = new TextEncoder().encode(out.attestationBlob);
  if (out.attestation.length > ATTESTATION_MAX) throw fail('payload_too_large', { field: safeField(`${where}.attestation`) });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE ATTESTATION PAYLOAD IS A CLOSED FIELD SET — and it is `devices.js`'s copy of the rule
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `assertAttestationClosed` USED TO LIVE HERE, as a private twin of the one in
// `handlers/devices.js`, and the pair was kept "byte-for-byte the same" by hand. Round 8 shipped
// the rule on this file's two doors only, so `POST /devices` and `POST /devices/adopt` stored a
// seventh field verbatim and `GET /spaces/:id/members` published it (R8-7). Round 9 put the rule
// where all four doors reach it — inside `verifyDeviceClaim` — and left the twin here.
//
// The twin is now gone, because within ONE ROUND the two copies had already drifted: they
// disagreed on the `recoveryPubKex` refusal reason (`wrong_length` here, `attestation_recoveryPubKex`
// there), which `tests/server/blindness.test.js` §7a caught and characterized. A rule with two
// implementations drifts silently — each door goes on passing its own tests — and the failure
// mode of THIS rule drifting is a free-text channel through a relay whose whole promise (story
// 21.1) is that it has none. So there is one function, in the file this one already imports
// `parseAttestationBlob` and `verifyDeviceClaim` from, and this door passes its own `field` name
// so a client with several devices in one request is still told WHICH one was refused.
//
// The reasoning that made the set closed in the first place is unchanged and lives with the
// function: `parseAttestationBlob` tolerates extra fields, that tolerance is a property of the
// PARSER and of CLIENTS, and the relay — which publishes this blob and cannot park what it must
// store — pays forward compatibility as ADR 003 §4's N−1 rule, server-first.

/** The blob, as a bounded ASCII string. @param {Object} d @param {string} where @returns {string} */
function readAttestationBlob(d, where) {
  const v = d.attestation;
  const field = `${where}.attestation`;
  if (typeof v !== 'string' || v.length === 0 || v.length > ATTESTATION_MAX) {
    throw fail('bad_request', { field: safeField(field), reason: 'bad_shape' });
  }
  // ASCII only, so `TextEncoder`/`TextDecoder` round-trip the column byte for byte and
  // `GET /members` republishes exactly what was signed. A blob is base64url plus one dot.
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v)) {
    throw fail('bad_request', { field: safeField(field), reason: 'bad_shape' });
  }
  return v;
}

/**
 * `readDevice` plus the two checks that need a key: **P2** (the short is derived from the signing
 * key) and **S1** (the blob is signed by the housing member's recovery key). ADR 002 §2.3's four
 * acceptance conditions, minus condition (1), which is a log-level fact the relay never sees.
 *
 * ⚠ **`POST /invites/redeem` MUST call this too and does not yet** — it calls `readDevice`
 * directly (`invites.js:219`), so a joiner can register a device whose attestation is signed by
 * nothing. That is not merely a weak row: it is a family-wide denial of service, because
 * `familyRecipients()` THROWS on a device whose attestation does not verify, so one bad joiner
 * makes every subsequent rotation unbuildable for everybody. `invites.js` is another pass's file;
 * the change is two lines — read the member keys first, then `await readAttestedDevice(body.device,
 * member, 'device')` — and it is reported as a cross-file need rather than reached into.
 *
 * @param {unknown} raw
 * @param {{memberId?:string, id?:string, recoveryPubSig:Uint8Array}} member the HOUSING member —
 *        either the row from the store or the `readMemberKeys` result of the same request
 * @param {string} where
 */
export async function readAttestedDevice(raw, member, where) {
  const device = readDevice(raw, where);
  await verifyDeviceClaim({
    member: { id: member.memberId ?? member.id, recoveryPubSig: member.recoveryPubSig },
    deviceId: device.deviceId,
    deviceShort: device.deviceShort,
    sigPubRaw: device.sigPubRaw,
    kexPubRaw: device.kexPubRaw,
    attestation: device.attestationBlob,
  });
  return device;
}

/** @param {unknown} raw @param {string} where */
export function readMemberKeys(raw, where) {
  const m = readObject(raw, MEMBER_FIELDS, MEMBER_FIELDS, where);
  return {
    memberId: readId(m, 'memberId', MEMBER_ID_RE, where),
    recoveryPubSig: readBytes(m, 'recoveryPubSig', where, { len: P256_RAW_LEN }),
    recoveryPubKex: readBytes(m, 'recoveryPubKex', where, { len: P256_RAW_LEN }),
  };
}

/**
 * Read a wrap list. Each entry names its own epoch, because a rotation carries the backfill for a
 * joiner (epochs 1..e) alongside the new epoch's wraps (e+1) and the two are not distinguishable
 * by position.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `senderDeviceId` IS STAMPED, NOT READ — finding E2E3-3
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * ADR 002 §4.2 step 6 makes the RECEIVING device verify who sent a wrap before it derives a KEK
 * against it, and `admitWraps` (E3's fix for finding S1) takes that sender as a REQUIRED index
 * into its own verified set. Nothing on this wire carried one: no column, no response field, and
 * `readObject`'s closed field set 400s a client that tries to add one. So every honest wrap was
 * refused by the receiver and the whole of §4.2 was unimplementable over this API.
 *
 * The fix is not to widen this reader. `senderDeviceId` stays OUT of the allowed field set — a
 * client may not name the sender — and the caller passes the device the request was
 * AUTHENTICATED as. Three consequences, all of them the point:
 *
 *   · a client cannot lie about who deposited a row, because it does not get to say;
 *   · the relay learns nothing new (it authenticated that device to accept the request at all),
 *     so `PLAINTEXT_STRINGS` grows by a fact ADR 003 §5.2's inventory already implies; and
 *   · a relay that LIES about it can cause a refusal and never an admission, because the bytes
 *     the receiver derives against come from the sender's own verified attestation and this value
 *     only selects among them (spacekeys.js §6b).
 *
 * @param {unknown} raw @param {number} maxEpoch @param {string} spaceId
 * @param {string} senderDeviceId the AUTHENTICATED depositor — never a body field
 * @returns {Array<{spaceId:string, epoch:number, recipientId:string, wrapped:Uint8Array, senderDeviceId:string}>}
 */
export function readWraps(raw, maxEpoch, spaceId, senderDeviceId) {
  if (typeof senderDeviceId !== 'string' || !DEVICE_ID_RE.test(senderDeviceId)) {
    // Our bug, not the client's: a caller that forgot to say who is depositing. 500, because a
    // wrap with no sender is a wrap no receiver can ever admit (store contract case C62).
    throw fail('internal');
  }
  if (!Array.isArray(raw)) throw fail('bad_request', { field: 'wraps', reason: 'not_an_array' });
  if (raw.length === 0) throw fail('bad_request', { field: 'wraps', reason: 'empty' });
  if (raw.length > MAX_WRAPS) throw fail('payload_too_large', { field: 'wraps' });
  const seen = new Set();
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const where = `wraps[${i}]`;
    const w = readObject(raw[i], ['recipientId', 'epoch', 'wrapped'], ['recipientId', 'epoch', 'wrapped'], where);
    const recipientId = readRecipientId(w.recipientId, `${where}.recipientId`);
    const epoch = readInt(w, 'epoch', where, { min: 1, max: maxEpoch });
    const wrapped = readBytes(w, 'wrapped', where, { maxLen: WRAP_MAX_BYTES });
    const key = JSON.stringify([epoch, recipientId]);
    // Two wraps for one (recipient, epoch) in one request: the store would upsert and the last
    // would win silently, which is a coin flip over which key ring a member ends up holding.
    if (seen.has(key)) throw fail('bad_request', { field: safeField(where), reason: 'duplicate_recipient_epoch' });
    seen.add(key);
    out.push({ spaceId, epoch, recipientId, wrapped, senderDeviceId });
  }
  return out;
}

/** A recipient is a device id or `rec_<memberId>`, and nothing else. @param {unknown} v @param {string} field */
export function readRecipientId(v, field) {
  if (typeof v !== 'string' || v.length > 128) throw fail('bad_request', { field: safeField(field), reason: 'bad_shape' });
  if (DEVICE_ID_RE.test(v)) return v;
  if (v.startsWith(RECOVERY_PREFIX) && MEMBER_ID_RE.test(v.slice(RECOVERY_PREFIX.length))) return v;
  throw fail('bad_request', { field: safeField(field), reason: 'bad_shape' });
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE COVERAGE CHECK  (ADR 002 §4.2, §7.1 step 5 · story 20.2 · finding E3-2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Who is owed a wrap. Pure, so it can be read and tested on its own.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY `rec_<memberId>` IS REQUIRED OF A PERSONAL SPACE AND ONLY PERMITTED OF A FAMILY ONE
 * Finding E2E3-8 — and this is the one place this pass REFUSES the obvious fix.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * ADR 002 §4.2 step 2 says a rotation wraps to every device "plus each member's `RK_kex`", and
 * this function demanded exactly that, of every member of every space. `familyRecipients()` in
 * `src/js/crypto/spacekeys.js` produces **no recovery recipient at all**, and says so in its own
 * header. So every family rotation was `409 incomplete_coverage` — an obligation no client in
 * the world could discharge, which from the user's chair is indistinguishable from a client that
 * will not. It survived because the two halves were written against two different clauses of the
 * same section and each is right about its own.
 *
 * **The obvious repair is a live break of 21.1 and 21.2.** Building the family recovery recipient
 * from `Member.recoveryPubKex` would make every suite green and would hand the relay the family
 * key, because NOTHING SIGNS `recoveryPubKex`. Swapping `recoveryPubSig` is loud — every device
 * attestation of that member then fails to verify and rotation stops — but swapping
 * `recoveryPubKex` alone is SILENT: every attestation stays genuine, the member list looks
 * normal, and the next rotation wraps `FSK_{e+1}` to a key the relay chose. That is not ADR 002
 * §8.5's accepted, UI-surfaceable phantom member; it is an unattributable key injection.
 *
 * So the family recovery wrap is **permitted and not required** until `recoveryPubKex` is bound
 * to `recoveryPubSig` by a signature (ADR 002 §2.3 specifies the binding: an OPTIONAL seventh
 * signed field in `DeviceAttestation`). A client that can bind it may send the row and it lands;
 * a client that cannot, does not, and the rotation still succeeds. The coverage check keeps all
 * of its teeth where they matter — on DEVICES, which is what stops the hostile admin rotating to
 * a ring that omits an honest member.
 *
 * A **personal** space is unaffected and still requires it: `personalRecipients()` builds that
 * recipient from `me.recoveryKexPubRaw`, my own key, held locally, which never came off the relay
 * at all. Same clause of the same ADR; different provenance; different answer.
 *
 * @param {Array<Object>} members every member row of the space, removed ones included
 * @param {Array<Object>} devices every device row of the space, revoked ones included
 * @param {'PERSONAL'|'FAMILY'} kind the space kind — `Space.kind`, which the relay holds
 * @returns {string[]} recipient ids, sorted, unique
 */
export function requiredRecipients(members, devices, kind) {
  if (kind !== 'PERSONAL' && kind !== 'FAMILY') throw fail('internal');
  const active = new Set();
  const out = new Set();
  for (const m of members) {
    if (m.removedAt !== null && m.removedAt !== undefined) continue;
    active.add(m.id);
    // ADR 002 §4.2 step 2: "for each [device], plus each member's RK_kex". Omitting this for the
    // PERSONAL space would be finding E3-2 again — and it is the wrap that makes A2 recovery
    // possible at all, because a member who has lost every device has only RK_kex left.
    if (kind === 'PERSONAL') out.add(recoveryRecipient(m.id));
  }
  for (const d of devices) {
    if (!active.has(d.memberId)) continue;
    if (d.revokedAt !== null && d.revokedAt !== undefined) continue;
    out.add(d.id);
  }
  return [...out].sort();
}

/**
 * Recipients whose wraps must be deleted: every recipient of a removed member, and every revoked
 * device. ADR 002 §4.2 step 4 — "delete every KeyWrap belonging to a removed or revoked device,
 * for all epochs".
 * @param {Array<Object>} members @param {Array<Object>} devices @returns {string[]}
 */
export function staleRecipients(members, devices) {
  const removed = new Set();
  const out = new Set();
  for (const m of members) {
    if (m.removedAt === null || m.removedAt === undefined) continue;
    removed.add(m.id);
    out.add(recoveryRecipient(m.id));
  }
  for (const d of devices) {
    if (removed.has(d.memberId) || (d.revokedAt !== null && d.revokedAt !== undefined)) out.add(d.id);
  }
  return [...out].sort();
}

/** Every recipient id the space could legitimately mention, removed and revoked included. */
export function knownRecipients(members, devices) {
  const out = new Set();
  for (const m of members) out.add(recoveryRecipient(m.id));
  const ids = new Set(members.map((m) => m.id));
  for (const d of devices) if (ids.has(d.memberId)) out.add(d.id);
  return out;
}

/** How many missing (recipient, epoch) pairs are named on the error body before it is truncated. */
const MAX_REPORTED_GAPS = 24;

/**
 * The check itself: after the write, every required recipient holds every epoch 1..epoch.
 *
 * @param {Object} tx a SyncStore (usually a transaction handle)
 * @param {string} spaceId @param {number} epoch @param {string[]} recipients
 * @throws {HttpError} 409 incomplete_coverage, naming what is missing so the client can fix it
 */
export async function assertCoverage(tx, spaceId, epoch, recipients) {
  const missing = [];
  let total = 0;
  for (const r of recipients) {
    const have = new Set((await tx.getKeyWraps(spaceId, r)).map((w) => w.epoch));
    for (let e = 1; e <= epoch; e++) {
      if (have.has(e)) continue;
      total++;
      if (missing.length < MAX_REPORTED_GAPS) missing.push({ recipientId: r, epoch: e });
    }
  }
  if (total === 0) return;
  throw fail('incomplete_coverage', { missing, missingCount: total, epoch });
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. POST /api/v1/spaces  — 15.2
// ─────────────────────────────────────────────────────────────────────────────

const CREATE_FIELDS = ['spaceId', 'kind', 'colorRef', 'member', 'device', 'wraps'];

/**
 * Create a space and become its first member, in one transaction.
 *
 * Four rows and a key ring go in together — Space, Epoch 1, Member, Device, and the epoch-1
 * wraps — because a partial creation is unrecoverable from the client's side: a Space with no
 * Member is a space nobody can authenticate into, and there is no route that would repair it.
 *
 * **Why the epoch-1 wraps are REQUIRED rather than optional.** The coverage rule (§6) is an
 * invariant maintained by every write; it has to be established somewhere, and creation is the
 * only place where the required recipient set is trivially two entries. Without them,
 * `GET /spaces/:id/keys` returns nothing at all for a space that has never rotated, so a member
 * restoring from the A2 backup file recovers a member id and no space key, and the first rotation
 * would have to backfill epoch 1 from a device that may by then be gone. It costs the client one
 * `wrapToRecipients` call it was making anyway.
 *
 * **Auth is the bootstrap ladder** (`requireSelfAuth`): the very first request a Mac makes cannot
 * be authenticated against a stored device row, because this is the request that creates it.
 *
 * @param {Object} req @param {Object} ctx @returns {Promise<Object>} ServerRes
 */
export async function createSpace(req, ctx) {
  const body = readObject(req.body, CREATE_FIELDS, CREATE_FIELDS, '');
  const spaceId = readId(body, 'spaceId', SPACE_ID_RE, '');
  const kind = body.kind;
  if (kind !== 'FAMILY' && kind !== 'PERSONAL') {
    throw fail('bad_request', { field: 'kind', reason: 'bad_shape' });
  }
  // `psp_` is a personal space and `fsp_` a family one (ADR 002 §3). Letting the prefix and the
  // enum disagree would give the relay two answers to "which kind is this" and let a client pick
  // whichever one a later reader trusts.
  const wantPrefix = kind === 'FAMILY' ? 'fsp_' : 'psp_';
  if (!spaceId.startsWith(wantPrefix)) throw fail('bad_request', { field: 'spaceId', reason: 'kind_mismatch' });

  const colorRef = readId(body, 'colorRef', COLOR_REF_RE, '');
  const member = readMemberKeys(body.member, 'member');
  // Finding E2E3-7. This route used to read the attestation as base64url and verify NOTHING,
  // while `POST /devices` read the blob string and verified P2 + S1 + S2. One contract now, and
  // it is the verifying one. The recovery key it verifies under arrives in the same body, so
  // this is a SELF-CONSISTENCY check and not a trust anchor — exactly as at `/devices`, where
  // `Member.recoveryPubSig` was itself self-declared when the member was created. What it buys
  // is that the blob this space is FOUNDED on can be verified by everybody else afterwards.
  // Without it a founder could plant a blob nothing verifies, `familyRecipients()` would throw
  // on the roster forever, and the space could never rotate — a wedge with no route out.
  const device = await readAttestedDevice(body.device, member, 'device');
  // The founder's own device is the depositor of the epoch-1 wraps. Nobody else exists yet.
  const wraps = readWraps(body.wraps, 1, spaceId, device.deviceId);

  // The budget is charged BEFORE the signature is verified, for the reason `limits.js` gives its
  // `pre-auth` phase: verifying a P-256 signature is the expensive half of the request, so a
  // limiter that runs after it bounds the database and not the CPU.
  // Integrated (LZP-207): RATE_RULES gained the `spaceCreate` entry finding E2-203-6 asked for,
  // so this is now the same call every other limiter in the server makes, over a key built by
  // `rateKey()`. `SPACES_PER_IP_HOUR` survives below as the documented value of
  // `LIMITS.spacesPerIpHour`, which is what `enforce` now reads.
  await enforceFor(req, ctx, 'spaceCreate', null);
  const auth = await requireSelfAuth(req, ctx, device.deviceShort);

  const at = ctx.now();
  const result = await ctx.store.tx(async (tx) => {
    if (await tx.getSpace(spaceId)) throw fail('bad_request', { field: 'spaceId', reason: 'exists' });
    if (await tx.getDevice(device.deviceId)) throw fail('bad_request', { field: 'device.deviceId', reason: 'registered' });
    if (await tx.getDeviceByShort(spaceId, device.deviceShort)) {
      // Round 10 item 8, closing E2-203-1: the short's namespace is the SPACE. This space is
      // being created a line above, so a hit here can only be a retry racing itself — but the
      // check stays, because the alternative is a StoreShapeError and a 500. What it no longer
      // refuses is the Mac's OTHER spaces, which is the whole of E2-203-1.
      throw fail('bad_request', { field: 'device.deviceShort', reason: 'registered' });
    }

    await tx.createSpace({
      id: spaceId, kind, currentEpoch: 1, nextSeq: 0n, headChain: null, createdAt: new Date(at),
    });
    await tx.claimEpoch(spaceId, 1);
    // A `memberId` colliding with a member of ANOTHER space is not pre-checkable: `listMembers`
    // is per space and the interface has no global member lookup, so `addMember` throws a
    // StoreShapeError and this answers 500 with no body detail and — because of the transaction —
    // no row written. With 128-bit random ids an honest collision does not happen, and a
    // deliberate one requires already knowing a member id of a space the caller is not in, buys
    // a 500 and changes nothing. Worth a `memberExists(id)` on the store the next time it opens;
    // not worth a column, a catch, or a special case here.
    await tx.addMember({
      id: member.memberId,
      spaceId,
      colorRef,
      recoveryPubSig: member.recoveryPubSig,
      recoveryPubKex: member.recoveryPubKex,
      joinedAt: new Date(at),
      removedAt: null,
    });
    await tx.addDevice({
      id: device.deviceId,
      spaceId,
      memberId: member.memberId,
      deviceShort: device.deviceShort,
      sigPubRaw: device.sigPubRaw,
      kexPubRaw: device.kexPubRaw,
      attestation: device.attestation,
      lastSeenSeq: 0n,
      lastPushedSeq: 0n,
      addedAt: new Date(at),
      revokedAt: null,
    });
    const members = await tx.listMembers(spaceId);
    const devices = await tx.listDevices(spaceId);
    const known = knownRecipients(members, devices);
    for (const w of wraps) {
      if (!known.has(w.recipientId)) throw fail('bad_request', { field: 'wraps', reason: 'unknown_recipient' });
    }
    await tx.putKeyWraps(wraps);
    await assertCoverage(tx, spaceId, 1, requiredRecipients(members, devices, kind));
    return { members: members.length };
  });

  logOk(ctx, { route: 'createSpace', spaceId, deviceShort: auth.deviceShort, status: 200 });
  return {
    status: 200,
    body: {
      spaceId,
      kind,
      memberId: member.memberId,
      deviceId: device.deviceId,
      currentEpoch: 1,
      memberCount: result.members,
      serverTime: at,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. POST /api/v1/spaces/:id/epoch  — ADR 002 §4.2
// ─────────────────────────────────────────────────────────────────────────────

const ROTATE_FIELDS = ['epoch', 'wraps', 'invites'];

/**
 * Rotate the space key to `epoch`, atomically and coverage-checked.
 *
 * **Who may rotate: any current member.** ADR 002 §4.2 is explicit — *"the member whose action
 * caused the rotation performs it — the joiner on join, the admin on removal, the departing
 * member's successor-admin on leave"* — and D9's correction of 2026-08-27 makes it "any member
 * device, not only the admin's" for exactly the reason a two-person family cannot depend on one
 * sleeping laptop. The server could not check "admin" if it wanted to (finding E2-203-2). What
 * makes that safe is not a role: it is the coverage check, which turns "rotate" from a
 * capability into an obligation.
 *
 * **Epoch discipline.** `epoch` must be exactly `currentEpoch + 1`.
 *   · `epoch <= currentEpoch` is the lost race ADR 002 §4.2 describes: `409 epoch_taken`, and the
 *     client re-fetches its wraps and stops if it now holds the key.
 *   · `epoch > currentEpoch + 1` is refused, because the coverage rule spans 1..epoch and an
 *     unbounded jump is an unbounded amount of work bought with one request.
 *
 * **Everything is one transaction and every failure rolls the whole thing back**, including the
 * `Epoch` row. A rotation that fails coverage must not consume `e+1`: if it did, the honest
 * rotator that comes next gets `409 epoch_taken` for an epoch whose key nobody holds, and the
 * family is wedged.
 *
 * @param {Object} req @param {Object} ctx @returns {Promise<Object>} ServerRes
 */
export async function rotateEpoch(req, ctx) {
  const spaceId = readId(req.params || {}, 'id', SPACE_ID_RE, 'params');
  // Authenticate before parsing the body. A wrap list is up to 1024 base64 entries and this route
  // carries no rate limiter — `limits.js` RATE_COVERAGE.rotateEpoch, whose reasoning DOES hold
  // here: the caller must already be a known, unrevoked device of a current member. That
  // membership check is what stands between a stranger and the parse.
  const { auth } = await requireActiveMember(req, ctx, spaceId);

  const body = readObject(req.body, ROTATE_FIELDS, ['epoch', 'wraps'], '');
  // `min: 1` rather than 2 so that a client which is simply behind — it thinks the space is at
  // epoch 0 and asks for 1 — gets the ADR's `409 epoch_taken` and the "re-fetch your wraps" path,
  // instead of a shape error it has no rule for. Zero, a fraction and a string are still 400.
  const epoch = readInt(body, 'epoch', '', { min: 1, max: 1000000 });
  // The depositor is the device this request was AUTHENTICATED as, and there is no body field
  // for it (finding E2E3-3). `requireActiveMember` has already resolved it off the stored row,
  // so it is the relay's own observation and not a claim.
  if (typeof auth.deviceId !== 'string' || !DEVICE_ID_RE.test(auth.deviceId)) throw fail('not_a_member');
  const wraps = readWraps(body.wraps, epoch, spaceId, auth.deviceId);
  // ADR 002 §4.2 step 3 listed `invites` because the pre-D9 rotation re-wrapped the invite blobs.
  // D9 deleted the blobs, so there is nothing for a client to send: the server refreshes every
  // open invite's epoch itself, below, and refuses the field rather than accepting a list whose
  // contents can no longer change the outcome.
  if (Object.prototype.hasOwnProperty.call(body, 'invites')) {
    throw fail('bad_request', { field: 'invites', reason: 'retired_by_d9' });
  }

  const at = ctx.now();
  const out = await ctx.store.tx(async (tx) => {
    const space = await tx.getSpace(spaceId);
    if (!space) throw fail('not_a_member');          // a non-existent space and a space you are
                                                     // not in answer identically.
    if (epoch <= space.currentEpoch) throw fail('epoch_taken', { currentEpoch: space.currentEpoch });
    if (epoch !== space.currentEpoch + 1) {
      throw fail('bad_request', { field: 'epoch', reason: 'not_next', currentEpoch: space.currentEpoch });
    }

    const members = await tx.listMembers(spaceId);
    const devices = await tx.listDevices(spaceId);

    // A wrap addressed to a recipient this space has never heard of is refused. The bytes are
    // opaque, so an arbitrary recipient id is a small write-anything store on someone else's
    // relay — and the honest race (a device revoked between the client's read and its POST) is
    // still admitted, because a revoked device is a KNOWN recipient. Its rows are then deleted
    // below along with the rest of the stale set.
    const known = knownRecipients(members, devices);
    for (const w of wraps) {
      if (!known.has(w.recipientId)) throw fail('bad_request', { field: 'wraps', reason: 'unknown_recipient' });
    }

    await tx.putKeyWraps(wraps);
    const purged = await tx.deleteKeyWrapsForDevices(spaceId, staleRecipients(members, devices));
    await assertCoverage(tx, spaceId, epoch, requiredRecipients(members, devices, space.kind));

    // First writer wins (ADR 002 §4.2, `@@unique([spaceId, epoch])`). Claimed AFTER the coverage
    // check so a refused rotation leaves no trace at all — belt and braces on top of the
    // rollback, which would undo it anyway.
    if (!(await tx.claimEpoch(spaceId, epoch))) throw fail('epoch_taken', { currentEpoch: space.currentEpoch });
    await tx.setCurrentEpoch(spaceId, epoch);

    // ADR 002 §4.2 step 3's surviving half: "Rotation must not silently invalidate a pending
    // invite; a family of eight onboarding two people at once would otherwise break." Under D9
    // that is a pointer move and nothing else — there is no key material on an invite.
    const open = await tx.listOpenInvites(spaceId);
    for (const inv of open) await tx.refreshInvite(inv.id, epoch);

    return { purged, invitesRefreshed: open.length };
  });

  logOk(ctx, { route: 'rotateEpoch', spaceId, deviceShort: auth.deviceShort, status: 200 });
  return {
    status: 200,
    body: {
      spaceId,
      currentEpoch: epoch,
      wrapsStored: wraps.length,
      wrapsPurged: out.purged,
      invitesRefreshed: out.invitesRefreshed,
      serverTime: at,
    },
  };
}
