// server/core/auth.js — device-signature auth for the blind relay.  ADR 003 §2; LZP-202.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE IS
// ─────────────────────────────────────────────────────────────────────────────────────────────
// There are no cookies, no sessions, no bearer tokens and no account system, and none may be
// built (addendum §3). Every request to every endpoint carries one header:
//
//     Authorization: LZP1 device=<deviceShort>, ts=<unixMillis>, nonce=<b64u16>, sig=<b64u>
//
// and the whole authorization model is: the bytes of that request, verified against a P-256
// public key the relay already holds for that device. That is the entire trust story, which is
// why this file is worth reading in full before changing one line of it.
//
// TWO PROPERTIES THIS BUYS, both of which matter more than the mechanism:
//
//   1. REMOVING A MEMBER IS INSTANT, SERVER-SIDE. One column write (`Member.removedAt`) and
//      every request from every one of their devices fails at step 4 or step 6. There is no
//      token to expire, no session to invalidate, no cache to bust. 20.1's "sofort" is a
//      property of the auth model rather than a promise of the UI.
//
//   2. THE PRINCIPAL IS SELF-CERTIFYING. `deviceShort = crock32(SHA-256(sigPubRaw)[0..10])`
//      (ADR 001 §1.2) is a function of the signing key and of nothing else. The relay recomputes
//      it and refuses a device claiming a short it cannot derive — see `assertSelfCertifying`.
//      This is why the relay needs no attestation registers: the attestations live inside E2EE
//      ciphertext it cannot read (ADR 002 §5.2), so any principal it could merely *look up*
//      would be an unverifiable claim it had to trust. A key-derived one it can check.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO:
//
//   · It never validates entry OWNERSHIP. It cannot — ownership lives inside the ciphertext
//     (ADR 001 §4.5). LZP-901's "server-side validation" clause is escalated as risk R7, not
//     silently reinterpreted (ADR 003 §2).
//   · It never reads `ct`, and it has no reason to: the signature covers the request *bytes*,
//     not their meaning.
//   · It does not gate on `X-LZP-Protocol`. The N−1 rule is LZP-206's `server/core/version.js`
//     and belongs in front of the router, not inside auth.
//
// PURITY (ADR 003 §9, ADR 005 §2). No clock (`ctx.now()`), no randomness, no I/O, no
// `process.env`, no framework types, and imports resolve inside `server/core/` only — which is
// also why the base64url and Crockford codecs below are written out here instead of imported
// from `src/js/core/b64.js`: the dependency direction in ADR 005 §2 forbids the server reaching
// into the client tree, in either direction. The DEFINITIONS are the client's; the bytes are
// asserted equal to the client's in tests/server/auth.test.js against known answers.

import { fail } from './errors.js';
import { SPACE_SCOPED } from './router.js';

// ─────────────────────────────────────────────────────────────────────────────
// 0. Shapes the wire is allowed to carry
// ─────────────────────────────────────────────────────────────────────────────

/** ADR 001 §1.2 — 16 Crockford base32 characters, 80 bits, upper case, no separators. */
export const DEVICE_SHORT_RE = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{16}$/;

/** A decimal unix-millis string. No sign, no exponent, no leading `+`. */
export const TS_RE = /^[0-9]{1,15}$/;

/** base64url, no padding. 16 random bytes -> 22 characters (ADR 003 §2: `nonce=<b64u16>`). */
export const B64U_RE = /^[A-Za-z0-9_-]+$/;

/** 22 base64url characters = 128 bits (ADR 001 §1.2). */
export const SPACE_ID_RE = /^(?:psp_|fsp_)[A-Za-z0-9_-]{22}$/;

/** The scheme token. Compared case-insensitively: HTTP auth schemes are case-insensitive. */
export const AUTH_SCHEME = 'LZP1';

/** Exactly these four parameters, each exactly once. Not a subset, not a superset. */
export const AUTH_PARAMS = Object.freeze(['device', 'ts', 'nonce', 'sig']);

/** ADR 003 §2 — `signedString` is NEVER empty, because it always begins with this. */
export const SIGNED_PREFIX = 'lzp/v2\n';

/** ECDSA P-256 / SHA-256 (ADR 002 §1). */
const SIG_ALG = Object.freeze({ name: 'ECDSA', namedCurve: 'P-256' });
const SIG_OP = Object.freeze({ name: 'ECDSA', hash: 'SHA-256' });

/**
 * WebCrypto ECDSA emits and expects **P1363** (`r ‖ s`), 64 bytes for P-256, in BOTH engines —
 * not DER. ADR 003 §2's illustrative header shows a DER-looking `sig=MEUCIQD…`; that is an
 * artifact of the example, and ADR 002 §1 is the normative statement. A length check here turns
 * "the client accidentally shipped DER" from an intermittent `verify() === false` into one
 * `401 bad_signature` with an obvious cause.
 */
export const SIG_BYTES = 64;

/** 65 bytes: uncompressed `0x04 ‖ X ‖ Y` (ADR 002 §2). */
const RAW_PUBKEY_BYTES = 65;

/** 16 bytes of client randomness. Fixed width so the Nonce table cannot be filled with junk. */
export const NONCE_BYTES = 16;

const TE = new TextEncoder();

// ─────────────────────────────────────────────────────────────────────────────
// 1. Codecs — strict, and strict for a reason
//
// The decoders REJECT a trailing partial group whose spare bits are non-zero. Without that rule
// one nonce has several spellings, and `claimNonce(deviceShort, nonce)` — the replay window —
// stops being decidable by string comparison: an attacker replays the same 16 bytes spelled a
// different way and the store sees a different key. Canonical in, or refused.
//
// They return `null` rather than throwing. Every caller here is looking at PEER data arriving
// over an unauthenticated socket; external input is refused, not thrown on.
// ─────────────────────────────────────────────────────────────────────────────

const B64U_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64U_INDEX = /** @type {Record<string, number>} */ ({});
for (let i = 0; i < B64U_ALPHABET.length; i++) B64U_INDEX[B64U_ALPHABET[i]] = i;

/** Crockford base32 (ADR 001 §1.2). Every character sorts at or above '0' — the HLC tiebreak
 *  depends on it, so the alphabet is copied verbatim from `src/js/core/b64.js`. */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * base64url encode, RFC 4648 §5, no padding.
 * @param {Uint8Array} b @returns {string}
 */
export function b64u(b) {
  let out = '';
  let i = 0;
  for (; i + 3 <= b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += B64U_ALPHABET[(n >>> 18) & 63] + B64U_ALPHABET[(n >>> 12) & 63] +
           B64U_ALPHABET[(n >>> 6) & 63] + B64U_ALPHABET[n & 63];
  }
  const rest = b.length - i;
  if (rest === 1) {
    const n = b[i] << 16;
    out += B64U_ALPHABET[(n >>> 18) & 63] + B64U_ALPHABET[(n >>> 12) & 63];
  } else if (rest === 2) {
    const n = (b[i] << 16) | (b[i + 1] << 8);
    out += B64U_ALPHABET[(n >>> 18) & 63] + B64U_ALPHABET[(n >>> 12) & 63] + B64U_ALPHABET[(n >>> 6) & 63];
  }
  return out;
}

/**
 * Strict base64url decode. No padding, no standard-base64 `+`/`/`, no non-canonical tail.
 * @param {unknown} s
 * @param {number} [expectLen] when given, a different byte length is also a rejection
 * @returns {Uint8Array|null} null on anything malformed — never a throw
 */
export function ub64(s, expectLen) {
  if (typeof s !== 'string' || s.length === 0) return null;
  if (s.length % 4 === 1) return null;
  const full = Math.floor(s.length / 4);
  const rest = s.length - full * 4;
  const out = new Uint8Array(full * 3 + (rest === 0 ? 0 : rest - 1));
  let o = 0;
  let i = 0;
  const val = (ch) => {
    const v = B64U_INDEX[ch];
    return v === undefined ? -1 : v;
  };
  for (; i + 4 <= s.length; i += 4) {
    const a = val(s[i]); const b = val(s[i + 1]); const c = val(s[i + 2]); const d = val(s[i + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) return null;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = (n >>> 16) & 255;
    out[o++] = (n >>> 8) & 255;
    out[o++] = n & 255;
  }
  if (rest === 2) {
    const a = val(s[i]); const b = val(s[i + 1]);
    if (a < 0 || b < 0) return null;
    const n = (a << 18) | (b << 12);
    if ((n & 0x00ffff) !== 0) return null;                 // non-canonical: spare bits set
    out[o++] = (n >>> 16) & 255;
  } else if (rest === 3) {
    const a = val(s[i]); const b = val(s[i + 1]); const c = val(s[i + 2]);
    if (a < 0 || b < 0 || c < 0) return null;
    const n = (a << 18) | (b << 12) | (c << 6);
    if ((n & 0x0000ff) !== 0) return null;                 // non-canonical: spare bits set
    out[o++] = (n >>> 16) & 255;
    out[o++] = (n >>> 8) & 255;
  }
  if (expectLen !== undefined && out.length !== expectLen) return null;
  return out;
}

/**
 * Crockford base32 encode. Upper case, no padding, no separators. 10 bytes -> 16 characters,
 * which is exactly the `deviceShort` width.
 * @param {Uint8Array} b @returns {string}
 */
export function crock32(b) {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < b.length; i++) {
    acc = (acc << 8) | b[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD_ALPHABET[(acc >>> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD_ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. The engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The platform SubtleCrypto, resolved LAZILY and overridable through `ctx.subtle`.
 *
 * Lazily for the same reason `src/js/crypto/identity.js` does it: a module-load-time read
 * freezes whatever engine happened to exist at import time, which in a test that swaps in a
 * crippled one is the wrong engine. Node has WebCrypto natively, so there is no dependency here
 * and nothing to install.
 *
 * @param {Object} [ctx]
 * @returns {SubtleCrypto}
 */
export function subtleOf(ctx) {
  const s = (ctx && ctx.subtle) || globalThis.crypto?.subtle;
  if (!s) throw fail('internal');
  return s;
}

/** @param {Object} ctx @param {Uint8Array} bytes @returns {Promise<Uint8Array>} */
async function sha256(ctx, bytes) {
  return new Uint8Array(await subtleOf(ctx).digest('SHA-256', bytes));
}

/**
 * `crock32(SHA-256(rawSigPub)[0..10])` — ADR 001 §1.2, computed by the ENGINE's SHA-256.
 *
 * One definition, and it is the client's. `tests/server/auth.test.js` asserts this returns the
 * same string as `src/js/core/ids.js`'s synchronous hand-rolled implementation for the same key,
 * because two spellings of `deviceShort` would mean the HTTP principal and the HLC tiebreak were
 * quietly different functions — a defect no unit test of either one alone would catch.
 *
 * @param {Uint8Array} rawSigPub 65 bytes
 * @param {Object} [ctx]
 * @returns {Promise<string|null>} null if the input is not a 65-byte raw point
 */
export async function deviceShortOfRaw(rawSigPub, ctx) {
  if (!(rawSigPub instanceof Uint8Array) || rawSigPub.length !== RAW_PUBKEY_BYTES) return null;
  const digest = await sha256(ctx, rawSigPub);
  return crock32(digest.subarray(0, 10));
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The signed string — ADR 003 §2, byte for byte
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The canonical query string.
 *
 * ADR 003 §2 says: `""` for no query; otherwise k=v pairs, percent-encoded, sorted by key then
 * value, joined with `&`.
 *
 * **Two refinements the ADR leaves open, pinned here because a signature cannot be ambiguous**
 * (reported to the register as E2-202-3, so the client's implementation pins the same two):
 *
 *   · percent-encoding is `encodeURIComponent`, applied to key and value separately. That
 *     leaves `!'()*-._~` literal, which is stable across every JS engine and is what a client
 *     written in this codebase will reach for.
 *   · the SORT runs over the ENCODED forms, in code-unit order. Sorting before encoding and
 *     sorting after can disagree (`%20` sorts below `!`), so one of the two has to be chosen,
 *     and choosing the one that operates on the bytes that actually appear in the string is the
 *     one a reader can verify by looking at the output.
 *
 * A repeated key is supported (array value) and its occurrences are sorted by value, which is
 * what "sorted by key then value" is for.
 *
 * @param {Object<string,string|string[]>} query
 * @returns {string}
 */
export function canonicalQuery(query) {
  if (!query || typeof query !== 'object') return '';
  const pairs = [];
  for (const k of Object.keys(query)) {
    const v = query[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const one of v) pairs.push([encodeURIComponent(k), encodeURIComponent(String(one))]);
    else pairs.push([encodeURIComponent(k), encodeURIComponent(String(v))]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map((p) => `${p[0]}=${p[1]}`).join('&');
}

/**
 * ADR 003 §2's `signedString`, assembled from parts that are already canonical.
 *
 *     "lzp/v2\n" + METHOD + "\n" + path + "?" + sortedQuery + "\n"
 *                + b64u(SHA-256(rawBody)) + "\n" + ts + "\n" + nonce
 *
 * Note the `"?"` is unconditional — it is a separator, not a query marker — and `path` carries
 * no scheme, no host and no fragment. Exported so a test can build the string a *different* way
 * and assert the server refuses a signature over it.
 *
 * @param {{method:string, path:string, sortedQuery:string, bodyHashB64u:string, ts:string, nonce:string}} p
 * @returns {string}
 */
export function signedString(p) {
  return SIGNED_PREFIX + p.method.toUpperCase() + '\n' + p.path + '?' + p.sortedQuery + '\n' +
         p.bodyHashB64u + '\n' + p.ts + '\n' + p.nonce;
}

/**
 * The exact bytes a request's signature must cover.
 *
 * `rawBody` is hashed — never `body`. That is the whole point of the field: if the signature
 * covered a *parsed* object, an entry point that parses differently from the signer (a duplicate
 * JSON key, a `__proto__`, a number that does not round-trip) would hand a handler data nobody
 * signed. See `readSignedBody`, which closes the other half of the same gap.
 *
 * @param {Object} req @param {Object} ctx
 * @param {{ts:string, nonce:string}} cred
 * @returns {Promise<Uint8Array>}
 */
export async function signedBytes(req, ctx, cred) {
  const raw = req.rawBody instanceof Uint8Array ? req.rawBody : new Uint8Array(0);
  const hash = await sha256(ctx, raw);
  return TE.encode(signedString({
    method: req.method,
    path: req.path,
    sortedQuery: canonicalQuery(req.query),
    bodyHashB64u: b64u(hash),
    ts: cred.ts,
    nonce: cred.nonce,
  }));
}

/**
 * The body a handler is allowed to act on: the parse of the bytes that were SIGNED.
 *
 * `req.body` is whatever the entry point happened to produce and is not, by itself, evidence of
 * anything. `req.rawBody` is what `signedBytes` hashed. A handler that reads `req.body` while
 * auth verified `req.rawBody` is the classic parse-twice defect — two parsers, one signature —
 * and the cheapest way to make it unwritable is to hand the handler the right object and
 * document that the wrong one is a trap. `handlers/ops.js` uses this and never `req.body`.
 *
 * @param {Object} req
 * @returns {Object|null} null for an empty body (every GET)
 * @throws {HttpError} 400 bad_request on non-JSON or a non-object top level
 */
export function readSignedBody(req) {
  const raw = req.rawBody instanceof Uint8Array ? req.rawBody : null;
  if (raw === null) {
    // No raw bytes were provided. An entry point that supplies a parsed body without the bytes
    // it came from cannot be authenticated at all, so refuse rather than trust the parse.
    if (req.body === null || req.body === undefined) return null;
    throw fail('bad_auth', { detail: 'body_without_rawbody' });
  }
  if (raw.length === 0) {
    if (req.body !== null && req.body !== undefined) throw fail('bad_auth', { detail: 'body_without_rawbody' });
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw fail('bad_request');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw fail('bad_request');
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The header
// ─────────────────────────────────────────────────────────────────────────────

/** Case-insensitive header read. Entry points differ on casing; the protocol does not. */
export function headerOf(req, name) {
  const headers = (req && req.headers) || {};
  const want = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === want) return headers[k];
  }
  return undefined;
}

/**
 * Step 1. Parse `LZP1 device=…, ts=…, nonce=…, sig=…`, strictly.
 *
 * Strictly means: exactly the four parameters, each exactly once, no extras, no quoting, and
 * every value already checked against the shape it is allowed to have. A parser that shrugs at
 * an unknown parameter is a parser that will one day accept `alg=none`.
 *
 * The value checks are not cosmetic. `device` becomes a store key (`claimNonce`, and a map key
 * in the file adapter), and `nonce` becomes the other half of that key: admitting arbitrary
 * strings here is how an unauthenticated caller writes rows of its own choosing into the Nonce
 * table.
 *
 * @param {string|undefined} header
 * @returns {{device:string, ts:string, nonce:string, sig:string, tsMs:number, sigBytes:Uint8Array}}
 * @throws {HttpError} 401 bad_auth
 */
export function parseAuthorization(header) {
  if (typeof header !== 'string') throw fail('bad_auth');
  const sp = header.indexOf(' ');
  if (sp < 0) throw fail('bad_auth');
  if (header.slice(0, sp).toUpperCase() !== AUTH_SCHEME) throw fail('bad_auth');

  const out = /** @type {Record<string,string>} */ ({});
  for (const part of header.slice(sp + 1).split(',')) {
    const s = part.trim();
    if (s === '') throw fail('bad_auth');
    const eq = s.indexOf('=');
    if (eq <= 0) throw fail('bad_auth');
    const k = s.slice(0, eq).trim();
    const v = s.slice(eq + 1).trim();
    if (!AUTH_PARAMS.includes(k)) throw fail('bad_auth');       // no unknown parameters, ever
    if (out[k] !== undefined) throw fail('bad_auth');           // no duplicates, ever
    out[k] = v;
  }
  for (const k of AUTH_PARAMS) if (out[k] === undefined) throw fail('bad_auth');

  if (!DEVICE_SHORT_RE.test(out.device)) throw fail('bad_auth');
  if (!TS_RE.test(out.ts)) throw fail('bad_auth');
  if (!B64U_RE.test(out.nonce)) throw fail('bad_auth');
  const nonceBytes = ub64(out.nonce, NONCE_BYTES);
  if (nonceBytes === null) throw fail('bad_auth');
  const sigBytes = ub64(out.sig, SIG_BYTES);
  if (sigBytes === null) throw fail('bad_auth');

  return { device: out.device, ts: out.ts, nonce: out.nonce, sig: out.sig, tsMs: Number(out.ts), sigBytes };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Membership — steps 6 and 7
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where the space id lives for a space-scoped route. `SPACE_SCOPED` (LZP-201) owns the
 * enumeration; this owns the extraction, so a new space-scoped route cannot skip the membership
 * check without appearing in that table first.
 *
 * @param {Object} req the routed request (`params` and `routeName` present)
 * @param {Object|null} body the SIGNED body — never `req.body`
 * @returns {string|null}
 */
export function spaceIdOf(req, body) {
  const spec = SPACE_SCOPED[req && req.routeName];
  if (!spec) return null;
  const colon = spec.indexOf(':');
  const where = spec.slice(0, colon);
  const key = spec.slice(colon + 1);
  let v;
  if (where === 'param') v = req.params && req.params[key];
  else if (where === 'query') v = req.query && req.query[key];
  else if (where === 'body') v = body && body[key];
  return typeof v === 'string' ? v : null;
}

/**
 * The space a request names, read WITHOUT trusting it — the row-selection hint for step 4.
 *
 * It is the same extraction as `spaceIdOf`, over a body parsed defensively: at step 4 nothing has
 * been verified yet, and a malformed body must not change which error the ladder answers. So a
 * parse failure is `null` (no hint), never a throw. The AUTHORITATIVE space is `spaceIdOf` at
 * step 6/7, over the strict parse, after the signature.
 *
 * A wrong hint cannot grant anything: it can only select a row whose `memberId` step 7 then
 * checks against the same space, or select none, which is `not_a_member`.
 *
 * @param {Object} req @returns {string|null}
 */
export function spaceHintOf(req) {
  let body = null;
  try { body = readSignedBody(req); } catch { body = null; }
  const v = spaceIdOf(req, body);
  return typeof v === 'string' && SPACE_ID_RE.test(v) ? v : null;
}

/**
 * Steps 6 and 7, together, because with this store interface they are one lookup.
 *
 * `Member.removedAt` (step 6) can only be read through `listMembers(spaceId)`, and the interface
 * has no `getMember(memberId)` — see AUTH_INTERFACE_GAPS. For a space-scoped route that costs
 * nothing, since step 7 needs the same list. For a route with no space in the request it means
 * step 6 cannot run at all, which is a real gap and is reported rather than papered over.
 *
 * Both failures are the SAME code and the same status. "You were removed" and "that is not your
 * family" must be indistinguishable, or the endpoint becomes an oracle a removed member can use
 * to enumerate which spaces a member id belongs to.
 *
 * @param {string} memberId @param {string} spaceId @param {Object} ctx
 * @returns {Promise<Object>} the member row
 * @throws {HttpError} 403 not_a_member
 */
export async function assertMember(memberId, spaceId, ctx) {
  if (typeof spaceId !== 'string' || !SPACE_ID_RE.test(spaceId)) throw fail('not_a_member');
  const members = await ctx.store.listMembers(spaceId);
  const mine = members.find((m) => m.id === memberId) || null;
  if (!mine) throw fail('not_a_member');
  if (mine.removedAt !== null && mine.removedAt !== undefined) throw fail('not_a_member');
  return mine;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. authenticate — ADR 003 §2, in order, failing closed at every step
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} AuthResult
 * @property {string} deviceShort  the principal
 * @property {string|null} deviceId  the row's label — NOT an identity (ADR 002 §2.3). `null` on a
 *                                 bootstrap route (no row yet) and on a route that names no space
 *                                 when this Mac has rows in several (round 10 item 8).
 * @property {string|null} memberId  `null` in exactly the same two cases. A route that names a
 *                                 space never returns null here: step 7 answers `not_a_member`.
 * @property {string|null} spaceId the space this request is scoped to, when it is scoped to one
 * @property {Object|null} member  the member row, when step 6/7 ran
 * @property {Object|null} body    the parse of the SIGNED bytes; handlers must use this
 */

/**
 * The verification order is ADR 003 §2's, unchanged, with one addition (4b) that only ever
 * refuses more:
 *
 *   1 parse Authorization                          -> 401 bad_auth
 *   2 |now - ts| > limits.authWindowMs             -> 401 stale_request
 *   3 claimNonce() === false                       -> 401 replay
 *   4 unknown device, or revoked in this space     -> 403 device_revoked
 *  4b a stored deviceShort is not derivable from
 *     its stored sigPubRaw                         -> 403 device_revoked
 *   5 signature verification fails                 -> 401 bad_signature
 *   6 member.removedAt != null                     -> 403 not_a_member
 *   7 no row in / not a member of this route's
 *     spaceId                                      -> 403 not_a_member
 *
 * **Step 4 answers the same code for "unknown" and "revoked" on purpose.** Distinguishing them
 * would turn the endpoint into a device-enumeration oracle for anyone who can guess an 80-bit
 * short, and there is nothing a legitimate client does differently in the two cases.
 *
 * **Step 4b is the self-certification check, and it is defence in depth, not a new rule.**
 * ADR 002 §5.2 makes the relay recompute the short at registration; doing it again at every auth
 * costs one SHA-256 and means a row written by some *other* path — a future handler, a migration,
 * a direct database write by whoever holds the relay — still cannot hand an attacker a principal
 * whose key they do not own. It is the single line that keeps "the principal is self-certifying"
 * true independently of who wrote the row.
 *
 * **Honest note on step 3 before step 5** (reported as E2-202-4). The ADR fixes this order, and
 * this file implements the ADR. The consequence is that a `Nonce` row is written for a request
 * whose signature has not yet been checked, and even for a `deviceShort` that does not exist —
 * so an unauthenticated caller can grow that table at one row per request. It is bounded by
 * `nonceTtlMs` (5 minutes) and by whatever IP limiter LZP-205 lands, not by anything here.
 * Reversing the order would fix it and would also make signature verification — the expensive
 * step — reachable before the cheap one, which is the trade the ADR made. Recorded, not
 * silently deviated from.
 *
 * @param {Object} req @param {Object} ctx
 * @returns {Promise<AuthResult>}
 */
/**
 * THE TWO BOOTSTRAP ROUTES — added at integration (LZP-207), reported by LZP-203 as owed.
 *
 * ADR 003 §2 step 4 says "look the Device row up by `deviceShort`". On these two routes there is
 * no row to look up, because THE REQUEST IS THE REGISTRATION: `POST /spaces` creates the first
 * member and their first device, and `POST /invites/redeem` attaches a joiner's device. Running
 * the ordinary ladder on them answers `403 device_revoked` for every honest first request a Mac
 * ever makes — which is exactly what happened the first time the two handlers were driven over
 * real HTTP, and is why this is enumerated rather than inferred.
 *
 * **WHAT A BOOTSTRAP SIGNATURE PROVES, AND WHAT IT DOES NOT.** It is verified against the public
 * key IN THE BODY, so it proves one thing only: the sender holds the private key for the key they
 * are publishing. It is not an authorization and must never be read as one. A key that travels
 * with the signature validating it authenticates nothing about WHO the sender is.
 *
 *   · `redeemInvite` gets its authorization from the invite proof — `SHA-256(proof)` against the
 *     stored verifier (ADR 002 §7.1) — and from nothing else.
 *   · `createSpace` has NO authorization at all, by nature: anyone may create their own space.
 *     What bounds it is `RATE_RULES.spaceCreate`, five per IP per hour, charged BEFORE this
 *     signature is verified. That is finding E2-203-6, and this is the half of it that explains
 *     why the finding mattered.
 *
 * **What is still enforced here**, and it is the one property that makes the ladder safe: the
 * `deviceShort` in the `Authorization` header must be derivable from the presented key —
 * `crock32(SHA-256(sigPubRaw)[0..10])`, the same self-certification as step 4b. So a caller
 * cannot sign with key A and register key B, and the principal named in the header is always the
 * principal whose key verified the request. The handlers then re-check that the short they
 * authenticated is the one being registered (`requireSelfAuth`), so a broken ladder here cannot
 * on its own let one key act for another.
 *
 * Frozen and enumerated in the style of `SPACE_SCOPED`: a third bootstrap route cannot be added
 * without appearing in this list, and `tests/server/blindness.test.js` asserts the list is
 * exactly the set of routes whose handlers call `requireSelfAuth`.
 */
export const BOOTSTRAP_ROUTES = Object.freeze(['createSpace', 'redeemInvite']);

/** @param {Object} req @returns {boolean} */
export function isBootstrapRoute(req) {
  return BOOTSTRAP_ROUTES.includes(req && req.routeName);
}

/**
 * The public key a bootstrap request presents, out of the parse of the SIGNED bytes.
 * `null` when the body does not carry one in the one shape both handlers use.
 * @param {Object} req @returns {Uint8Array|null}
 */
export function presentedSigPubRaw(req) {
  let body;
  try { body = readSignedBody(req); } catch { return null; }
  const dev = body && body.device;
  if (!dev || typeof dev !== 'object' || Array.isArray(dev)) return null;
  if (typeof dev.sigPubRaw !== 'string' || !B64U_RE.test(dev.sigPubRaw)) return null;
  return ub64(dev.sigPubRaw, RAW_PUBKEY_BYTES);
}

export async function authenticate(req, ctx) {
  const limits = ctx.limits || {};
  const authWindowMs = limits.authWindowMs === undefined ? 120000 : limits.authWindowMs;
  const nonceTtlMs = limits.nonceTtlMs === undefined ? 300000 : limits.nonceTtlMs;

  // ── 1 ──
  const cred = parseAuthorization(headerOf(req, 'authorization'));

  // ── 2 ── The window is symmetric: a clock that is fast is as much a problem as one that is
  // slow, and 19.3's `error` state has a specific message for skew because this is the failure
  // a family will actually hit.
  const now = ctx.now();
  if (Math.abs(now - cred.tsMs) > authWindowMs) throw fail('stale_request');

  // ── 3 ── The replay window. `claimNonce` is atomic: of N concurrent claims of one nonce,
  // exactly one returns true (store contract C47).
  const fresh = await ctx.store.claimNonce(cred.device, cred.nonce, nonceTtlMs);
  if (!fresh) throw fail('replay');

  // ── 4 / 4b, or the bootstrap ladder ──
  // `principal` is what step 5 verifies against and what the result names. On an ordinary route
  // it comes from the STORED row and never from the request — a key that travels with the
  // signature it validates authenticates nothing. On a bootstrap route there is no row yet, and
  // the key therefore DOES come from the request; see BOOTSTRAP_ROUTES for what that does and
  // does not prove, and note that the self-certification check is identical in both branches.
  let principal;
  if (isBootstrapRoute(req)) {
    const presented = presentedSigPubRaw(req);
    // `bad_auth`, not `bad_request`: at this point in the ladder the request has not been
    // authenticated at all, and answering with a shape complaint would describe the body of a
    // caller who has proved nothing.
    if (presented === null) throw fail('bad_auth', { detail: 'bootstrap_without_key' });
    const derived = await deviceShortOfRaw(presented, ctx);
    // THE BINDING. Without this line a caller could sign with a key they hold and register a key
    // they do not, and every later request from the registered short would be unforgeable by
    // its actual owner. Same computation as step 4b, applied to the presented key.
    if (derived !== cred.device) throw fail('bad_auth', { detail: 'bootstrap_key_mismatch' });
    principal = { deviceShort: cred.device, sigPubRaw: presented, deviceId: null, memberId: null };
  } else {
    // ── 4 ── THE SHORT NAMES A MACHINE; THE ROW NAMES A MEMBERSHIP (round 10 item 8).
    // `deviceShort` used to be globally unique, so this was one lookup and one row. It is now
    // unique per SPACE — a Mac is legitimately in a personal space and one or more circles at
    // once (19.4 + 15.2), with a row in each. So the lookup returns a SET, and the ladder has to
    // say which of the two questions each step is asking:
    //
    //   · WHO SIGNED THIS? — answered by the KEY, which every row for one short shares, because
    //     `deviceShort` is a function of it (ADR 001 §1.2) and 4b below re-derives it per row.
    //     Step 5 therefore never depends on picking the right row.
    //   · WHICH MEMBER IS SPEAKING? — answered by the row for THIS REQUEST'S SPACE, and by
    //     nothing else. A Mac's membership in one circle says nothing about another.
    const rows = await ctx.store.listDevicesByShort(cred.device);
    if (rows.length === 0) throw fail('device_revoked');

    // ── 4b ── on EVERY row, not just the one we end up using. One bad row is a bad principal.
    for (const r of rows) {
      const derived = await deviceShortOfRaw(r.sigPubRaw, ctx);
      if (derived !== r.deviceShort) throw fail('device_revoked');
    }
    // 4b's corollary, and the line that lets step 5 ignore the row choice: one short, one signer.
    // 4b already forces it (two distinct keys hashing to one short is an 80-bit collision), so
    // this is the assertion that says so out loud rather than a second check.
    if (new Set(rows.map((r) => b64u(r.sigPubRaw))).size !== 1) throw fail('device_revoked');

    const revoked = (r) => r.revokedAt !== null && r.revokedAt !== undefined;
    const hint = spaceHintOf(req);
    const inHint = hint === null ? null : (rows.find((r) => r.spaceId === hint) || null);
    if (inHint !== null) {
      // Revoked HERE. Answered before step 5, exactly as it was when there was one row.
      if (revoked(inHint)) throw fail('device_revoked');
    } else if (rows.every(revoked)) {
      throw fail('device_revoked');
    }
    const live = rows.filter((r) => !revoked(r));
    // **`null` is a legitimate answer, and it must not be resolved by guessing.** A route that
    // names no space (`pair/*`) from a Mac that is in three circles has no "the" member, and
    // picking one would be inventing an authorization. Step 6/7 below turns a null memberId into
    // `not_a_member` for any route that DOES name a space — after the signature, so that "is this
    // Mac in your circle?" is never answerable without the private key.
    const row = inHint || (live.length === 1 ? live[0] : null);

    principal = {
      deviceShort: cred.device, sigPubRaw: rows[0].sigPubRaw,
      deviceId: row ? row.id : null, memberId: row ? row.memberId : null,
    };
  }

  // ── 5 ──
  const bytes = await signedBytes(req, ctx, cred);
  const ok = await verifySignature(principal.sigPubRaw, cred.sigBytes, bytes, ctx);
  if (!ok) throw fail('bad_signature');

  // ── 6, 7 ──
  // A bootstrap route has no member yet, so there is nothing to check membership against.
  // `SPACE_SCOPED` lists neither of them, so `spaceIdOf` answers null and this is a no-op — the
  // enumeration in router.js and the enumeration in BOOTSTRAP_ROUTES agree by construction, and
  // `tests/server/blindness.test.js` asserts they still do.
  const body = readSignedBody(req);
  const spaceId = spaceIdOf(req, body);
  let member = null;
  if (spaceId !== null) {
    // A bootstrap route reaches here with `memberId === null`, and `SPACE_SCOPED` lists neither
    // of them, so this branch cannot fire for one. On an ordinary route a null memberId means
    // step 4 found no row for this Mac IN THIS SPACE — the post-round-10 spelling of "not your
    // family", and the same answer as a removed member, deliberately (see `assertMember`).
    if (principal.memberId === null) throw fail('not_a_member');
    member = await assertMember(principal.memberId, spaceId, ctx);
  }

  return {
    deviceShort: principal.deviceShort,
    deviceId: principal.deviceId,
    memberId: principal.memberId,
    spaceId,
    member,
    body,
  };
}

/**
 * ECDSA P-256 / SHA-256 verification over the exact bytes.
 *
 * `false` on a bad signature AND on a malformed one — never a throw, so no caller is tempted to
 * read an engine's error name (ADR 002 §1 rule 3: Node says `InvalidAccessException` where
 * WebKit says `InvalidAccessError`).
 *
 * @param {Uint8Array} sigPubRaw 65 bytes
 * @param {Uint8Array} signature 64 bytes, P1363
 * @param {Uint8Array} bytes the signed string, always non-empty (rule 2)
 * @param {Object} [ctx]
 * @returns {Promise<boolean>}
 */
export async function verifySignature(sigPubRaw, signature, bytes, ctx) {
  if (!(sigPubRaw instanceof Uint8Array) || sigPubRaw.length !== RAW_PUBKEY_BYTES) return false;
  if (!(signature instanceof Uint8Array) || signature.length !== SIG_BYTES) return false;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return false;   // rule 2
  const S = subtleOf(ctx);
  try {
    const key = await S.importKey('raw', sigPubRaw, SIG_ALG, false, ['verify']);
    return await S.verify(SIG_OP, key, signature, bytes);
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. What this file could not do with the interface it was given
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gaps found while implementing ADR 003 §2 against the LZP-201 store interface. Exported as data
 * — the way `INTERFACE_EXTENSIONS` is — so the integrating pass has a machine-readable list and
 * `tests/server/auth.test.js` can assert each row still carries its consequence. A gap that
 * lives only in a commit message is a gap nobody closes.
 *
 * @type {ReadonlyArray<{id:string, what:string, consequence:string, owner:string}>}
 */
export const AUTH_INTERFACE_GAPS = Object.freeze([
  Object.freeze({
    id: 'E2-202-A',
    what: 'SyncStore has no getMember(memberId). Member.removedAt is reachable only through listMembers(spaceId).',
    consequence:
      'ADR 003 §2 step 6 ("the device\'s Member has removedAt != null -> 403") can only be run on a route ' +
      'that names a space. On the ten routes SPACE_SCOPED does not cover — devices, pair/*, ' +
      'invites/redeem, spaces (create) — a REMOVED member\'s non-revoked device still passes auth, ' +
      'and each of those handlers has to repeat the check for itself. pushOps and pullOps are ' +
      'space-scoped, so LZP-202 is unaffected; LZP-204 and LZP-206 are not.',
    owner: 'LZP-201 (store interface) + LZP-204',
  }),
  Object.freeze({
    id: 'E2-202-B',
    what: 'ADR 003 §2 leaves the percent-encoding and the sort domain of `sortedQuery` unstated.',
    consequence:
      'A signature cannot be ambiguous. `canonicalQuery` pins encodeURIComponent per component and ' +
      'a sort over the ENCODED forms in code-unit order. The client transport (WP-8, LZP-501) must ' +
      'pin the identical two choices or every GET with a query fails 401 bad_signature — which is ' +
      'the single most likely integration failure in this protocol.',
    owner: 'ADR 003 §2 + WP-8',
  }),
  Object.freeze({
    id: 'E2-202-C',
    what: 'Step 3 (claimNonce) runs before step 5 (verify), per ADR 003 §2.',
    consequence:
      'An unauthenticated caller writes one Nonce row per request, for any deviceShort including ' +
      'ones that do not exist. Bounded by nonceTtlMs and by LZP-205\'s IP limiter, by nothing here. ' +
      'ADR 003 §10 item 2 already budgets ~1400 Nonce writes/hour for the honest fleet; this is the ' +
      'adversarial half of the same row.',
    owner: 'LZP-205',
  }),
]);
