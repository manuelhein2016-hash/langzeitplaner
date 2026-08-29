// src/js/sync/protocol.js — the wire, stated once.  LZP-501 · stories 19.1, 19.2, 22.7.
// ADR 003 §1, §2, §3, §4 · docs/v2/contracts/sync.contract.js §0, §1, §2, §5.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE IS
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// Everything about the HTTP surface that is a FACT rather than a policy: the constants, the
// exact bytes ADR 003 §2 signs, the strict readers for the two response bodies, and the one
// function that turns an HTTP outcome into the four words `client.js` is allowed to branch on.
//
// It is pure. No clock, no randomness, no I/O, no DOM — `tests/tier1/core-purity.test.js`
// scans `src/js/sync/` as one of its four pure directories, and `tests/tier1/network-scope.test.js`
// scans it again for any way to open a socket. Both are load-bearing here: the transport is a
// PORT (ADR 003 §8) and this module never learns what is on the other end of it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE DUPLICATION, NAMED, AND WHY IT IS NOT AN ACCIDENT — reported to the ground phase
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `signedString` and `canonicalQuery` now exist in THREE files:
//
//     server/core/auth.js       the verifier — normative for the relay
//     src/js/platform/net.js    the signer   — the transport, which owns the ECDSA call
//     src/js/sync/protocol.js   this file    — the contract's declared home (sync.contract.js §2)
//
// That is one more than anybody wants, and it is forced by ADR 005 §2's import direction:
// `src/js/sync/` may import `sync/`, `crypto/` and `core/` and NOTHING ELSE, so it cannot reach
// `platform/net.js`, and `server/` is off-limits to the whole client. The honest response to a
// rule that cannot be expressed by an import is a rule that is expressed by a TEST:
// `tests/tier1/sync-protocol.test.js` runs this file's two functions, `net.js`'s two, and the
// RELAY's two over the same generated corpus — including the query where sort-before-encode and
// sort-after disagree — and asserts all three agree character for character. Two files agreeing
// with the same prose is not the same as two files agreeing with each other.
//
//   RECOMMENDED, and NOT done here because `platform/net.js` is another owner's file: net.js
//   should import `signedString`, `canonicalQuery`, `SIGNED_PREFIX`, `AUTH_SCHEME` and
//   `NONCE_BYTES` from THIS module and delete its copies. `platform/` may import `sync/` (it is
//   not a pure directory and the import graph allows it), the gate-2 walker is unaffected because
//   net.js and sync/ are both already outside the boot graph, and the cross-check test then
//   becomes a two-way check against the relay instead of a three-way one. It is a five-line diff
//   and it removes the only copy that is genuinely redundant.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS DELIBERATELY *NOT* HERE
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `sync.contract.js` §2 declares `authHeader(p, deviceShort, sigPriv)` — an ECDSA signature —
// alongside `signedString`. It is not implemented here, and that is a decision, not an omission:
//
//   · the transport already signs (`platform/net.js signRequest`), because the signature has to
//     cover `rawBody`, and `rawBody` is the exact bytes the transport is about to send. A second
//     signer that hashed a re-encoding of its own body would be the parse-twice defect the
//     relay's `readSignedBody` exists to prevent, seen from the client end;
//   · `IK_sig` is `extractable: false`, so signing is a `sign(bytes)` PORT wherever it happens,
//     and a port needs exactly one holder;
//   · `src/js/sync/` may not import `src/js/platform/keystore.js` anyway.
//
// So this module states the BYTES and the transport makes the SIGNATURE. `signedString` here is
// what a test uses to prove the transport signed the right thing, and what a future non-HTTP
// carrier would reuse.

import { b64u, ub64, CodecError } from '../core/b64.js';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 0. Protocol constants (ADR 003 §4 · sync.contract.js §0)
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** v2.0 GA ships protocol 1. */
export const PROTOCOL = 1;
/** The window this CLIENT speaks. The server's own N−1 rule is `server/core/version.js`'s. */
export const PROTO_MIN = 1;
export const PROTO_MAX = 1;

export const HDR = Object.freeze({
  protocol: 'X-LZP-Protocol',
  client: 'X-LZP-Client',
  minProtocol: 'X-LZP-Min-Protocol',
  auth: 'Authorization',
});

/** The same names, lower-cased — response headers arrive normalised (`net.js readHeaders`). */
export const HDR_LC = Object.freeze({
  protocol: 'x-lzp-protocol',
  client: 'x-lzp-client',
  minProtocol: 'x-lzp-min-protocol',
  retryAfter: 'retry-after',
});

export const LIMITS = Object.freeze({
  opsPerPush: 200,
  bytesPerEnvelope: 64 * 1024,
  bytesPerRequest: 4 * 1024 * 1024,
  opsPerPull: 500,
  authWindowMs: 120000,
  nonceTtlMs: 300000,
});

export const CADENCE = Object.freeze({
  pushDebounceMs: 2000,
  pullVisibleMs: 45000,
  pullJitterMs: 15000,      // re-randomised each tick, per device — no thundering herd (R3)
  pullHiddenMs: 600000,
  backoffBaseMs: 2000,
  backoffMaxMs: 300000,     // full jitter: delay = random(0, base)
  pendingAfterMs: 20000,
  statusDebounceMs: 2000,
});

/**
 * The only two paths this engine ever addresses. `net.js`'s `PATH_RE` refuses anything outside
 * `/api/v1/…` at the transport; naming them here keeps the client from constructing one.
 */
export const PATHS = Object.freeze({
  ops: '/api/v1/ops',
  meta: '/api/v1/meta',
});

/** ADR 003 §2. */
export const AUTH_SCHEME = 'LZP1';
export const SIGNED_PREFIX = 'lzp/v2\n';
export const NONCE_BYTES = 16;

/** Exactly these four parameters, each exactly once. Not a subset, not a superset. */
export const AUTH_PARAMS = Object.freeze(['device', 'ts', 'nonce', 'sig']);

const DEVICE_SHORT_RE = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{16}$/;
const TS_RE = /^[0-9]{1,15}$/;
const B64U_RE = /^[A-Za-z0-9_-]+$/;
const SEQ_RE = /^(?:0|[1-9][0-9]{0,18})$/;
const OP_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const SPACE_ID_RE = /^(?:psp_|fsp_)[A-Za-z0-9_-]{22}$/;

/** The nine plaintext fields of an envelope, in wire order (ADR 002 §5.1). There is no tenth. */
export const ENVELOPE_KEYS = Object.freeze(['v', 'sp', 'ep', 'dv', 'oid', 'wit', 'iv', 'ct', 'sig']);

/** What a pulled row adds on top of an envelope. */
export const PULL_EXTRA_KEYS = Object.freeze(['seq', 'chain']);

/**
 * Everything a push body may carry. `drained` is E2's additive field (`server/core/handlers/ops.js`
 * reports it as **E2-202-E**): ADR 003 §3.1 lists `space`, `ackSeq` and `ops` only, and the server
 * fails CLOSED without it — `minLastPushedSeq` stays 0 and no tombstone is ever collected. So the
 * client sends it, truthfully, and only when the outbox for that space is genuinely empty
 * afterwards. **Guessing it resurrects deleted entries** (ADR 001 §7.3 condition 3).
 */
export const PUSH_BODY_KEYS = Object.freeze(['space', 'ackSeq', 'ops', 'drained']);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. `seq` — a decimal string that does not fit in a double
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `Space.nextSeq` is a Postgres `BigInt` and every `seq` on the wire is a decimal STRING for
// exactly that reason. A client that did `Number(seq)` would be correct for the first nine
// quadrillion ops and then silently start comparing cursors wrong — the class of bug ADR 003 §3.3
// spends a paragraph preventing on the server side. So seqs are compared as BigInt and stored as
// their canonical decimal spelling, and a non-canonical spelling (`'007'`, `' 7'`, `'7.0'`) is
// refused rather than coerced: a cursor with several spellings is a cursor whose persistence is a
// matter of opinion.

/** @param {unknown} v @returns {bigint|null} null on anything that is not a canonical seq. */
export function parseSeq(v) {
  if (typeof v === 'bigint') return v >= 0n ? v : null;
  if (typeof v !== 'string' || !SEQ_RE.test(v)) return null;
  return BigInt(v);
}

/** @param {unknown} v @returns {boolean} */
export const isSeq = (v) => parseSeq(v) !== null;

/** `-1 | 0 | 1`, or `null` when either side is not a seq. */
export function cmpSeq(a, b) {
  const x = parseSeq(a);
  const y = parseSeq(b);
  if (x === null || y === null) return null;
  return x < y ? -1 : x > y ? 1 : 0;
}

export const ZERO_SEQ = '0';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. Request authentication — exactly what bytes are signed (ADR 003 §2)
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * `sortedQuery`: `encodeURIComponent` per component, then sorted over the ENCODED forms in
 * code-unit order, key first then value; a repeated key is an array and its occurrences sort by
 * value.
 *
 * ⚠ THE HALF ADR 003 §2 LEAVES UNSTATED, and it is not cosmetic. "sorted by key then value,
 * percent-encoded" does not say whether the sort happens before or after the encoding, and the
 * two disagree: `'~'` (0x7E) sorts AFTER `'a'` raw but encodes to itself while `' '` encodes to
 * `%20`, so `{a:'~', 'a ':'x'}` orders one way before encoding and the other way after. The relay
 * pins sort-AFTER-encode (`server/core/auth.js`, recorded as **E2-202-3**) and this file pins the
 * same, because the verifier is the authority and a client that disagrees produces a
 * `401 bad_signature` nobody can reproduce.
 *
 * @param {Object<string, string|number|string[]>} [query]
 * @returns {string} `''` for no query
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
 * ADR 003 §2, assembled from parts that are already canonical.
 *
 *   "lzp/v2\n" + METHOD + "\n" + path + "?" + sortedQuery + "\n"
 *   + b64u(SHA-256(rawBody)) + "\n" + ts + "\n" + nonce
 *
 * The `"?"` is UNCONDITIONAL — it is a separator, not a query marker. Dropping it when the query
 * is empty is the single most tempting "simplification" in this file and it would make every
 * query-less request fail to verify.
 *
 * The result is NEVER empty: it always begins with `SIGNED_PREFIX` (ADR 002 §1 rule 2 — an empty
 * signed string is a signature over nothing, which verifies against anything of that shape).
 *
 * @param {{method:string, path:string, sortedQuery:string, bodyHashB64u:string,
 *          ts:string|number, nonce:string}} p
 * @returns {string}
 */
export function signedString(p) {
  return SIGNED_PREFIX + String(p.method).toUpperCase() + '\n' + p.path + '?' + p.sortedQuery + '\n' +
         p.bodyHashB64u + '\n' + p.ts + '\n' + p.nonce;
}

/**
 * Assemble the `Authorization` value from parts that have already been computed. Pure string
 * work: the ECDSA operation belongs to the transport (see this file's header).
 * @param {{deviceShort:string, ts:string|number, nonceB64u:string, sigB64u:string}} p
 * @returns {string}
 */
export function buildAuthHeader(p) {
  return `${AUTH_SCHEME} device=${p.deviceShort}, ts=${p.ts}, nonce=${p.nonceB64u}, sig=${p.sigB64u}`;
}

/**
 * Parse one, as strictly as the relay does — unknown parameters, duplicates, a missing one and a
 * non-canonical base64url are all refusals.
 *
 * **It returns `null` instead of throwing**, unlike the relay's, and the difference is
 * deliberate: on the server a malformed header is a client to reject, while here the only caller
 * is a test or a diagnostic looking at a header this process just built. A throw would be a
 * programmer error reported as data.
 *
 * @param {unknown} header
 * @returns {{deviceShort:string, ts:number, nonce:string, sig:string}|null}
 */
export function parseAuthHeader(header) {
  if (typeof header !== 'string') return null;
  const sp = header.indexOf(' ');
  if (sp < 0) return null;
  if (header.slice(0, sp).toUpperCase() !== AUTH_SCHEME) return null;

  const out = {};
  for (const part of header.slice(sp + 1).split(',')) {
    const s = part.trim();
    if (s === '') return null;
    const eq = s.indexOf('=');
    if (eq <= 0) return null;
    const k = s.slice(0, eq).trim();
    const v = s.slice(eq + 1).trim();
    if (!AUTH_PARAMS.includes(k)) return null;
    if (out[k] !== undefined) return null;
    out[k] = v;
  }
  for (const k of AUTH_PARAMS) if (out[k] === undefined) return null;
  if (!DEVICE_SHORT_RE.test(out.device)) return null;
  if (!TS_RE.test(out.ts)) return null;
  if (!B64U_RE.test(out.nonce) || !decodes(out.nonce, NONCE_BYTES)) return null;
  if (!B64U_RE.test(out.sig) || !decodes(out.sig, 64)) return null;
  return { deviceShort: out.device, ts: Number(out.ts), nonce: out.nonce, sig: out.sig };
}

/** Does this base64url string decode, and to `n` bytes if `n` is given? Never throws. */
function decodes(s, n) {
  let bytes;
  try {
    bytes = ub64(s);
  } catch (e) {
    if (e instanceof CodecError) return false;
    throw e;
  }
  return n === undefined || bytes.length === n;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. The version gate (ADR 003 §4 · sync.contract.js §5)
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * `X-LZP-Min-Protocol` rides on every response so a client learns about a coming gate BEFORE it
 * is enforced (22.4's quiet „Update verfügbar" hint). Read from any response, error bodies
 * included — `server/dev-server.mjs` writes both headers unconditionally and the Vercel host must
 * too, which is why this reads headers and not a body.
 *
 * @param {{headers?:Object<string,string>}} res
 * @returns {{proto:number|null, minProto:number|null}}
 */
export function readProtocolHeaders(res) {
  const h = (res && res.headers) || {};
  const read = (name) => {
    const raw = h[name];
    if (typeof raw !== 'string' || !/^[0-9]{1,9}$/.test(raw)) return null;
    return Number(raw);
  };
  return { proto: read(HDR_LC.protocol), minProto: read(HDR_LC.minProtocol) };
}

/**
 * The 426 / 400 gate.
 *
 * A `426` means the plain-language outdated screen (deliverable 26, LZP-104) **and keep working
 * fully offline** — 19.1 does not bend for a protocol bump. A `400 protocol_unknown` means this
 * client has been DOWNGRADED below the server's floor and takes the same screen, because the one
 * sentence a user can act on is the same one.
 *
 * `minProto` and `minClientVersion` are read from the BODY, where `server/core/version.js`'s
 * `failureExtra()` puts both on both failure kinds precisely so a client needs one parser. The
 * header is the fallback, so a 426 from a host that dropped the body still says something true.
 *
 * @param {{status:number, headers?:Object, json?:any}} res
 * @returns {{ok:true} | {ok:false, kind:'too_old'|'unknown', minProto:number|null,
 *            minClientVersion:string|null}}
 */
export function checkProtocol(res) {
  const status = res && res.status;
  const body = (res && res.json) || null;
  const code = body && typeof body.error === 'string' ? body.error : null;
  const hdrs = readProtocolHeaders(res);

  const shape = (kind) => ({
    ok: false,
    kind,
    minProto: Number.isInteger(body && body.minProto) ? body.minProto : hdrs.minProto,
    minClientVersion: body && typeof body.minClientVersion === 'string' ? body.minClientVersion : null,
  });

  if (status === 426) return shape('too_old');
  if (status === 400 && code === 'protocol_unknown') return shape('unknown');
  return { ok: true };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4. Reading a response — the relay is untrusted, so every field is checked
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// ADR 002 §5.1's AAD binds `v`, `sp`, `ep`, `dv`, `oid` and `wit`, so a relay that rewrites one
// of them is caught by `openOp`. It is NOT caught by anything for the fields the AAD does not
// cover — `seq`, `chain` — and it is not caught at all for a body that is simply the wrong
// SHAPE. A `nextCursor` that is `null`, an `ops` that is an object, a `hasMore` that is the
// string `"false"`: each of those, taken at face value, is a cursor that stops advancing or a
// pull loop that never terminates. So the readers below are total and refuse rather than coerce.

/** @param {unknown} o @returns {boolean} */
const isPlainObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

/**
 * One envelope as it arrives inside a pull page. Returns `null` — never throws — because the
 * caller's response to a malformed row is to refuse the whole page, and it needs the reason.
 *
 * The closed key set matters: a field the client does not understand is a field that would be
 * carried into `openOp`, where `assertHeader` refuses it. Refusing here says WHICH field.
 *
 * @param {unknown} row
 * @returns {{seq:string, chain:string, env:Object}|null}
 */
export function readPulledOp(row) {
  if (!isPlainObject(row)) return null;
  const keys = Object.keys(row);
  for (const k of keys) {
    if (!ENVELOPE_KEYS.includes(k) && !PULL_EXTRA_KEYS.includes(k)) return null;
  }
  for (const k of ENVELOPE_KEYS) if (!Object.prototype.hasOwnProperty.call(row, k)) return null;
  for (const k of PULL_EXTRA_KEYS) if (!Object.prototype.hasOwnProperty.call(row, k)) return null;

  if (!isSeq(row.seq)) return null;
  if (typeof row.chain !== 'string' || !B64U_RE.test(row.chain)) return null;
  if (!Number.isInteger(row.v) || row.v < 1) return null;
  if (typeof row.sp !== 'string' || !SPACE_ID_RE.test(row.sp)) return null;
  if (!Number.isInteger(row.ep) || row.ep < 1) return null;
  if (typeof row.dv !== 'string' || !DEVICE_SHORT_RE.test(row.dv)) return null;
  if (typeof row.oid !== 'string' || !OP_ID_RE.test(row.oid)) return null;
  if (typeof row.wit !== 'string' || (row.wit !== '' && !B64U_RE.test(row.wit))) return null;
  for (const k of ['iv', 'ct', 'sig']) {
    if (typeof row[k] !== 'string' || !B64U_RE.test(row[k])) return null;
  }

  const env = {};
  for (const k of ENVELOPE_KEYS) env[k] = row[k];
  return { seq: String(row.seq), chain: row.chain, env: Object.freeze(env) };
}

/**
 * `GET /api/v1/ops` — the whole body, or a refusal naming the field.
 *
 * **`nextCursor` is checked against the page, not merely parsed.** ADR 003 §3.2 fixes it as *"the
 * seq of the last op ACTUALLY RETURNED, and when nothing is returned the caller's own `since`"*.
 * A relay that answered with the head instead would make the client skip every op it did not
 * receive — silently, permanently, on one device. The server is written not to do that; a client
 * that trusts it anyway has no defence when it does. So the cursor is CLAMPED to the last row
 * returned and the discrepancy is reported.
 *
 * @param {{status:number, json:any}} res
 * @param {string} since the cursor this request was made with
 * @returns {{ok:true, ops:Array, nextCursor:string, hasMore:boolean, currentEpoch:number,
 *            serverTime:number, members:Array, cursorLie:string|null}
 *          | {ok:false, why:string}}
 */
export function readPullBody(res, since) {
  const b = res && res.json;
  if (!isPlainObject(b)) return { ok: false, why: 'the pull body is not an object' };
  if (!Array.isArray(b.ops)) return { ok: false, why: 'pull.ops is not an array' };
  if (b.ops.length > LIMITS.opsPerPull) {
    return { ok: false, why: `pull returned ${b.ops.length} ops, above the ${LIMITS.opsPerPull} cap` };
  }
  if (typeof b.hasMore !== 'boolean') return { ok: false, why: 'pull.hasMore is not a boolean' };
  if (!isSeq(b.nextCursor)) return { ok: false, why: `pull.nextCursor ${JSON.stringify(b.nextCursor)} is not a seq` };
  if (!Number.isInteger(b.currentEpoch) || b.currentEpoch < 1) return { ok: false, why: 'pull.currentEpoch is not an epoch' };
  if (!Number.isFinite(b.serverTime)) return { ok: false, why: 'pull.serverTime is not a number' };
  if (b.members !== undefined && !Array.isArray(b.members)) return { ok: false, why: 'pull.members is not an array' };

  const ops = [];
  for (let i = 0; i < b.ops.length; i++) {
    const row = readPulledOp(b.ops[i]);
    if (row === null) return { ok: false, why: `pull.ops[${i}] is not a well-formed envelope row` };
    ops.push(row);
  }
  // ASCENDING, STRICTLY. `listOps` orders by seq and seq is unique per space, so equal or
  // descending neighbours mean the page was reordered in transit or fabricated.
  for (let i = 1; i < ops.length; i++) {
    if (cmpSeq(ops[i - 1].seq, ops[i].seq) !== -1) {
      return { ok: false, why: `pull.ops is not strictly ascending at index ${i} (${ops[i - 1].seq} then ${ops[i].seq})` };
    }
  }
  // Nothing in the page may be at or below the cursor we asked from: `WHERE seq > since`.
  if (ops.length && cmpSeq(ops[0].seq, since) !== 1) {
    return { ok: false, why: `pull returned seq ${ops[0].seq}, which is not above the cursor ${since}` };
  }

  const want = ops.length > 0 ? ops[ops.length - 1].seq : String(parseSeq(since));
  let cursorLie = null;
  if (String(b.nextCursor) !== want) {
    cursorLie = `the relay answered nextCursor=${b.nextCursor} where the last row returned was ${want}`;
  }
  // An empty page with `hasMore: true` and a cursor that does not move is an infinite loop that
  // looks exactly like a hung sync. Caught here rather than in the loop, where it would spin.
  if (ops.length === 0 && b.hasMore === true) {
    return { ok: false, why: 'pull returned an empty page with hasMore: true — the cursor cannot advance' };
  }

  return {
    ok: true,
    ops,
    nextCursor: want,
    hasMore: b.hasMore,
    currentEpoch: b.currentEpoch,
    serverTime: b.serverTime,
    members: Array.isArray(b.members) ? b.members : [],
    cursorLie,
  };
}

/**
 * `POST /api/v1/ops` — `accepted` and `duplicate` are read into ONE set, because ADR 003 §3.1 says
 * the client must treat them identically: both mean "the relay has it". That single sentence is
 * what makes at-least-once delivery sufficient, and it is one line of code, so it is one line of
 * code and not a branch somebody can get wrong later.
 *
 * @param {{status:number, json:any}} res
 * @returns {{ok:true, held:Array<{oid:string, seq:string, chain:string}>, spaceSeq:string,
 *            serverTime:number} | {ok:false, why:string}}
 */
export function readPushBody(res) {
  const b = res && res.json;
  if (!isPlainObject(b)) return { ok: false, why: 'the push body is not an object' };
  if (!Array.isArray(b.accepted)) return { ok: false, why: 'push.accepted is not an array' };
  if (!Array.isArray(b.duplicate)) return { ok: false, why: 'push.duplicate is not an array' };
  if (!isSeq(b.spaceSeq)) return { ok: false, why: `push.spaceSeq ${JSON.stringify(b.spaceSeq)} is not a seq` };

  const held = [];
  const seen = new Set();
  for (const list of [b.accepted, b.duplicate]) {
    for (const r of list) {
      if (!isPlainObject(r)) return { ok: false, why: 'a push receipt is not an object' };
      if (typeof r.oid !== 'string' || !OP_ID_RE.test(r.oid)) return { ok: false, why: 'a push receipt has no opId' };
      if (!isSeq(r.seq)) return { ok: false, why: `push receipt ${r.oid} has no seq` };
      if (typeof r.chain !== 'string' || !B64U_RE.test(r.chain)) return { ok: false, why: `push receipt ${r.oid} has no chain` };
      if (seen.has(r.oid)) continue;                    // the same id in both lists: still held
      seen.add(r.oid);
      held.push({ oid: r.oid, seq: String(r.seq), chain: r.chain });
    }
  }
  return {
    ok: true,
    held,
    spaceSeq: String(b.spaceSeq),
    serverTime: Number.isFinite(b.serverTime) ? b.serverTime : 0,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5. What an HTTP outcome MEANS — the four words `client.js` may branch on
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// ADR 003 §8.2 fixes the policy and it is worth restating because each clause exists to prevent a
// specific failure the family would experience:
//
//   5xx / network error      back off       min(300 s, 2^n × 2 s) with FULL jitter
//   429                      back off       honour `Retry-After`; never faster
//   401 / 403 / 426          STOP           backing off against a revoked device or an old build
//                                           is hammering a wall for ever; the loop stops and the
//                                           status says why
//   409 forked_op_id         TERMINAL for   the envelope must be re-minted; retrying it is an
//                            that item      infinite loop by construction
//   other 4xx (not 408)      TERMINAL for   "a permanently rejected op must never silently spin
//                            that item      forever" — it goes to quarantine, visibly
//   408                      back off       a timeout is a retry, not a verdict
//
// The one thing this function must never do is invent a fifth word. Everything the client does
// is a function of `kind`, and a `kind` nobody enumerated is a code path nobody tested.

/** @typedef {'ok'|'retry'|'stop'|'reject'|'rate'} Verdict */

/**
 * @param {{status:number, headers?:Object, json?:any}} res
 * @returns {{kind:Verdict, code:string|null, retryAfterMs:number|null,
 *            errorKind:'offline'|'auth'|'protocol'|null, forkedOid:string|null}}
 */
export function interpret(res) {
  const status = res && res.status;
  const body = (res && res.json) || null;
  const code = body && typeof body.error === 'string' ? body.error : null;
  const out = { kind: 'retry', code, retryAfterMs: null, errorKind: null, forkedOid: null };

  if (!Number.isInteger(status)) return out;
  if (status >= 200 && status < 300) { out.kind = 'ok'; return out; }

  if (status === 429) {
    out.kind = 'rate';
    out.retryAfterMs = retryAfterMs(res);
    return out;
  }
  if (status === 401 || status === 403) { out.kind = 'stop'; out.errorKind = 'auth'; return out; }
  if (status === 426 || (status === 400 && code === 'protocol_unknown')) {
    out.kind = 'stop';
    out.errorKind = 'protocol';
    return out;
  }
  if (status === 409 && code === 'forked_op_id') {
    out.kind = 'reject';
    // The relay names the id it forked on so the client can re-mint exactly that op. It is
    // coordination data, not content — `errors.js FORBIDDEN_BODY_FIELDS` keeps everything else out.
    out.forkedOid = body && typeof body.oid === 'string' && OP_ID_RE.test(body.oid) ? body.oid : null;
    return out;
  }
  if (status === 408) { out.kind = 'retry'; return out; }
  if (status >= 400 && status < 500) { out.kind = 'reject'; return out; }
  return out;                                            // 5xx and anything unrecognised: retry
}

/**
 * `Retry-After` in milliseconds. Seconds-form only: the HTTP-date form is legal but the relay
 * only ever emits the seconds form (`errors.js toResponse`), and parsing a date here would mean
 * trusting the relay's clock to schedule our own retries.
 *
 * Clamped to `CADENCE.backoffMaxMs`: a `Retry-After: 86400` would otherwise silence a family's
 * sync for a day on one header.
 *
 * @param {{headers?:Object}} res @returns {number|null}
 */
export function retryAfterMs(res) {
  const h = (res && res.headers) || {};
  const raw = h[HDR_LC.retryAfter];
  if (typeof raw !== 'string' || !/^[0-9]{1,7}$/.test(raw.trim())) return null;
  return Math.min(Number(raw.trim()) * 1000, CADENCE.backoffMaxMs);
}

/**
 * Full jitter (ADR 003 §8.2): `delay = random(0, min(300 s, 2^n × 2 s))`.
 *
 * **Full, not "equal", and not decorative.** With eight family members woken by the same shared
 * trigger — a Vercel cold start that 503s everybody at once — a deterministic `2^n` schedule
 * re-synchronises the fleet on every retry and the herd arrives together at each step (Risk R3).
 * Drawing uniformly from `[0, base)` decorrelates them after the first retry.
 *
 * `n` is the count of CONSECUTIVE failures, so `n = 1` gives `[0, 2 s)`.
 *
 * @param {number} n @param {() => number} random a float in [0,1)
 * @param {{backoffBaseMs?:number, backoffMaxMs?:number}} [cadence]
 * @returns {number} milliseconds, an integer >= 0
 */
export function backoffMs(n, random, cadence) {
  const c = cadence || CADENCE;
  const base = c.backoffBaseMs === undefined ? CADENCE.backoffBaseMs : c.backoffBaseMs;
  const max = c.backoffMaxMs === undefined ? CADENCE.backoffMaxMs : c.backoffMaxMs;
  const k = Math.max(1, Math.min(32, Math.floor(n)));
  const ceiling = Math.min(max, base * Math.pow(2, k - 1));
  const r = typeof random === 'function' ? random() : 0;
  const f = Number.isFinite(r) && r >= 0 && r < 1 ? r : 0;
  return Math.floor(f * ceiling);
}

/**
 * The pull interval for one tick: `45 s ± 15 s` while the window is visible, a flat `10 min`
 * while it is hidden.
 *
 * **Re-randomised each tick, per device** (ADR 003 §8.2). A jitter drawn once at start-up and
 * reused would offset the devices from each other and then keep them exactly 45 s apart for ever
 * — which is a herd with a phase shift, not a decorrelated fleet.
 *
 * @param {boolean} visible @param {() => number} random
 * @param {Object} [cadence]
 * @returns {number}
 */
export function pullDelayMs(visible, random, cadence) {
  const c = cadence || CADENCE;
  if (!visible) return c.pullHiddenMs === undefined ? CADENCE.pullHiddenMs : c.pullHiddenMs;
  const base = c.pullVisibleMs === undefined ? CADENCE.pullVisibleMs : c.pullVisibleMs;
  const j = c.pullJitterMs === undefined ? CADENCE.pullJitterMs : c.pullJitterMs;
  const r = typeof random === 'function' ? random() : 0.5;
  const f = Number.isFinite(r) && r >= 0 && r < 1 ? r : 0.5;
  return Math.max(0, Math.round(base + (f * 2 - 1) * j));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6. Sync status (ADR 003 §8.3 · sync.contract.js §4)
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** @typedef {'healthy'|'pending'|'error'} SyncState */

/** How long a pull may be stale before `healthy` stops being true. */
export const HEALTHY_PULL_AGE_MS = 3 * 60 * 1000;
/** Clock skew above this is an `error` with its own sentence (ADR 003 §8.3). */
export const CLOCK_SKEW_LIMIT_MS = 5 * 60 * 1000;

/**
 * The three states, computed from the raw counters and from nothing else.
 *
 * `healthy` is **nothing at all** in the UI — no dot, no text, no tooltip. F11's "silence is the
 * design" extends to the network, and this function returning `'healthy'` is what the toolbar
 * reads as "render no glyph". A fourth state, or a `healthy` that still shows something, is a
 * product change and needs 19.3 reopened.
 *
 * ⚠ THE CHAIN WITNESS IS DELIBERATELY NOT AN INPUT. ADR 002 §5.4 and ADR 003 §10.6 scope it as
 * detection-only, best-effort, "and it never blocks sync in v2" — and ADR 003 §8.3's `error` row
 * enumerates its causes without it. A chain finding is a DIAGNOSTIC on `status().chain`; letting
 * it flip the indicator would put a permanent calm-but-filled glyph on the board of every family
 * that has ever removed a member, because `POST /members/remove` purges that member's `Op` rows
 * (ADR 003 §6.3) and the surviving chain therefore cannot be recomputed. See `chain.js`.
 *
 * @param {{pendingOps:number, pendingSinceMs:number|null, online:boolean,
 *          consecutiveFailures:number, lastPullAt:number|null, now:number,
 *          quarantined:number, errorKind:string|null, clockSkewMs:number}} raw
 * @returns {SyncState}
 */
export function classify(raw) {
  const r = raw || {};
  if (r.errorKind === 'auth' || r.errorKind === 'protocol' || r.errorKind === 'decrypt') return 'error';
  if ((r.quarantined || 0) > 0) return 'error';
  if (Math.abs(r.clockSkewMs || 0) > CLOCK_SKEW_LIMIT_MS) return 'error';
  if ((r.consecutiveFailures || 0) >= 5) return 'error';

  if (r.online === false) return 'pending';
  // A STALLED pull — the parking lot is full, so the cursor is deliberately held still until the
  // key or the attestation those envelopes need arrives. ADR 003 §8.3 does not enumerate it,
  // because the parking lot did not exist when §8.3 was written; it is `pending` rather than
  // `error` because nothing has failed and nothing is lost. Reported as an ADR amendment.
  if (r.errorKind === 'stalled') return 'pending';
  if ((r.consecutiveFailures || 0) >= 1) return 'pending';
  if ((r.pendingOps || 0) > 0 && r.pendingSinceMs !== null && r.pendingSinceMs !== undefined
      && (r.now - r.pendingSinceMs) > CADENCE.pendingAfterMs) return 'pending';

  // A pull that has not succeeded in three minutes is not healthy — but only once a pull has been
  // attempted at all. `lastPullAt === null` at start-up is not a failure; it is a client that has
  // not run yet, and showing a glyph for it would greet every launch with a warning.
  if (r.lastPullAt !== null && r.lastPullAt !== undefined
      && (r.now - r.lastPullAt) > HEALTHY_PULL_AGE_MS) return 'pending';

  return 'healthy';
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 7. Building the two request shapes
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The push body. `ackSeq` is *"the highest seq this device has FOLDED"* — the cursor, not the
 * space head — because ADR 001 §7.3's tombstone GC is gated on it across the whole fleet and
 * over-claiming it lets peers collect tombstones for ops this device never saw. `drained` is the
 * client's explicit, truthful claim that its outbox for this space is empty (see PUSH_BODY_KEYS).
 *
 * @param {{space:string, ackSeq:string, ops:Object[], drained:boolean}} p
 * @returns {Object}
 */
export function pushBody(p) {
  const body = { space: p.space, ackSeq: p.ackSeq, ops: p.ops };
  if (p.drained === true) body.drained = true;
  return body;
}

/** The pull query. `limit` is omitted when it is the server's own default — fewer signed bytes. */
export function pullQuery(space, since, limit) {
  const q = { space, since: String(since) };
  if (Number.isInteger(limit) && limit > 0 && limit !== LIMITS.opsPerPull) q.limit = String(limit);
  return q;
}

/** Re-exported so a caller that has this module does not need `core/b64.js` as well. */
export { b64u, ub64 };
