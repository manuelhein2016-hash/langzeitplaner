// docs/v2/contracts/sync.contract.js
//
// INTERFACE CONTRACT — the client sync engine and the wire types. Normative for ADR 003.
// DOM-FREE. The transport, the clock and the scheduler are injected ports; this module tree
// contains no fetch (that lives in src/js/platform/net.js, the only fetch in the product).

/* eslint-disable no-unused-vars */

// ─────────────────────────────────────────────────────────────────────────────
// 0. Protocol constants  (ADR 003 §4)
// ─────────────────────────────────────────────────────────────────────────────

/** v2.0 GA ships protocol 1. */
export const PROTOCOL = 1;
/** The server always accepts PROTO_MAX and PROTO_MAX - 1 (addendum §9, story 22.7). */
export const PROTO_MIN = 1;
export const PROTO_MAX = 1;

export const HDR = Object.freeze({
  protocol: 'X-LZP-Protocol',
  client: 'X-LZP-Client',
  minProtocol: 'X-LZP-Min-Protocol',
  auth: 'Authorization',
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

// ─────────────────────────────────────────────────────────────────────────────
// 1. Wire types  (ADR 003 §3)
// ─────────────────────────────────────────────────────────────────────────────

/** See crypto.contract.js. @typedef {Object} Envelope */

/**
 * @typedef {Object} PushRequest
 * @property {string} space
 * @property {string} ackSeq        highest seq this device has folded; feeds tombstone GC
 * @property {Envelope[]} ops       <= LIMITS.opsPerPush
 */
/**
 * @typedef {Object} PushResponse
 * @property {Array<{oid:string, seq:string, chain:string}>} accepted
 * @property {Array<{oid:string, seq:string, chain:string}>} duplicate
 *           The client treats `accepted` and `duplicate` IDENTICALLY — both mean "the server has
 *           it". That is what makes at-least-once delivery sufficient (ADR 003 §3.1).
 * @property {string} spaceSeq
 * @property {number} serverTime
 */
/**
 * @typedef {Object} PullResponse
 * @property {Array<Envelope & {seq:string, chain:string}>} ops   ascending seq
 * @property {string} nextCursor
 * @property {boolean} hasMore
 * @property {number} currentEpoch
 * @property {number} serverTime
 * @property {MemberRow[]} members   piggybacked: the projection rule and the post-decrypt
 *                                   identity checks both need it BEFORE the ops are applied
 */
/**
 * @typedef {Object} MemberRow
 * @property {string} memberId
 * @property {string} colorRef            the ONE deliberate plaintext leak (ADR 003 §5.2)
 * @property {string|null} removedAt
 * @property {Array<{deviceShort:string, sigPubRaw:string, kexPubRaw:string,
 *                   attestation:string, revokedAt:string|null}>} devices
 */

/** @typedef {{status:number, headers:Object<string,string>, json:any}} HttpResponse */
/**
 * @typedef {Object} Transport
 * @property {(method:string, path:string, query:Object, body:any, headers:Object)
 *             => Promise<HttpResponse>} request
 */

// ─────────────────────────────────────────────────────────────────────────────
// 2. Request authentication  (ADR 003 §2) — state exactly what bytes are signed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the EXACT string that is signed. It is never empty — it always starts with "lzp/v2\n".
 *
 *   "lzp/v2\n" + METHOD + "\n" + path + "?" + sortedQuery + "\n"
 *   + b64u(SHA-256(rawBody)) + "\n" + ts + "\n" + nonce
 *
 * `path` carries no scheme, host or fragment. `sortedQuery` is "" for no query, else k=v pairs,
 * percent-encoded, sorted by key then value, joined with "&". `rawBody` is the exact bytes sent
 * (SHA-256 of zero bytes for a GET).
 *
 * @param {{method:string, path:string, query:Object, rawBody:Uint8Array, ts:number, nonce:string}} p
 * @returns {Promise<string>}
 */
export async function signedString(p) { throw new Error('not implemented'); }

/** @returns {Promise<string>} `LZP1 device=<deviceShort>, ts=<ms>, nonce=<b64u16>, sig=<b64u>` */
export async function authHeader(p, deviceShort, sigPriv) { throw new Error('not implemented'); }

/** @param {string} header @returns {{deviceShort:string, ts:number, nonce:string, sig:string}|null} */
export function parseAuthHeader(header) { throw new Error('not implemented'); }

// ─────────────────────────────────────────────────────────────────────────────
// 3. Outbox, cursors, chain witness
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Durable queue of sealed envelopes; survives quit and crash (19.1). An entry leaves only when
 * the server reports it in `accepted` OR `duplicate`. No size limit and no expiry.
 * @typedef {Object} Outbox
 * @property {(space:string, envs:Envelope[]) => Promise<void>} enqueue
 * @property {(space:string, n:number) => Promise<Envelope[]>} peek
 * @property {(space:string, oids:string[]) => Promise<void>} ack
 * @property {(space:string, oid:string, reason:string) => Promise<void>} quarantine
 *           a permanently rejected op must NEVER silently spin forever
 * @property {(space:string) => Promise<number>} size
 * @property {() => Promise<Array<{space:string, oid:string, reason:string}>>} quarantined
 */
/** @param {{storage:any}} ports @returns {Outbox} */
export function createOutbox(ports) { throw new Error('not implemented'); }

/**
 * Advanced ONLY after the batch has been decrypted, folded AND persisted, so a crash mid-pull
 * re-fetches rather than skips (ADR 003 §3.3).
 * @typedef {Object} Cursors
 * @property {(space:string) => string} get
 * @property {(space:string, seq:string) => Promise<void>} set
 */
export function createCursors(ports) { throw new Error('not implemented'); }

/** Diagnostic only; never blocks sync in v2 (ADR 002 §5.4, §8.6). */
export function verifyChain(ops, lastChain) { throw new Error('not implemented'); }

// ─────────────────────────────────────────────────────────────────────────────
// 4. The engine  (ADR 003 §8)
// ─────────────────────────────────────────────────────────────────────────────

/** @typedef {'healthy'|'pending'|'error'} SyncState */
/**
 * @typedef {Object} SyncStatus
 * @property {SyncState} state
 * @property {number} pendingOps
 * @property {number} consecutiveFailures
 * @property {number|null} lastPullAt
 * @property {'offline'|'auth'|'protocol'|'quarantine'|'decrypt'|'clockSkew'|null} errorKind
 * @property {string|null} detail    plain German, one sentence
 */

/**
 * @typedef {Object} SyncDeps
 * @property {Transport} transport         a PORT — bound to the real handlers in tests
 * @property {any} keyring @property {any} oplog @property {any} identity
 * @property {{personal:string|null, family:string|null}} spaces
 * @property {{ now:() => number }} clock
 * @property {(ms:number, fn:Function) => any} schedule    injected; no setTimeout in core/
 * @property {() => boolean} isOnline
 * @property {(ops:Object[]) => void} onOps    → store.applyRemote; NEVER touches undo/redo
 * @property {(s:SyncStatus) => void} onStatus
 * @property {Outbox} outbox @property {Cursors} cursors
 */

/**
 * @typedef {Object} SyncClient
 * @property {() => void} start @property {() => void} stop
 * @property {() => Promise<void>} pushNow @property {() => Promise<void>} pullNow
 * @property {() => SyncStatus} status
 */

/**
 * Cadence (19.2 as amended): push debounced 2 s after a txn; pull on focus / visibilitychange →
 * visible / online, and every 45 s ± 15 s while visible, every 10 min while hidden.
 * Backoff min(300 s, 2^n * 2 s) with FULL jitter, reset on the first 2xx. 429 honours
 * Retry-After. 401/403/426 stop the loop instead of backing off.
 *
 * THERE IS NO SYNC BUTTON AND NO MANUAL REFRESH ANYWHERE (19.2 — an acceptance criterion).
 * NEVER a spinner on the board.
 *
 * @param {SyncDeps} deps @returns {SyncClient}
 */
export function createSyncClient(deps) { throw new Error('not implemented'); }

/**
 * healthy → nothing at all in the UI (F11's "silence is the design" extends to the network).
 * pending → one small still hollow glyph. error → the same slot, filled, calm, never red-alert.
 * Transitions debounced by CADENCE.statusDebounceMs so a normal push does not flicker it.
 * @param {SyncStatus} raw @returns {SyncState}
 */
export function classify(raw) { throw new Error('not implemented'); }

// ─────────────────────────────────────────────────────────────────────────────
// 5. Version gate  (ADR 003 §4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 426 → the plain-language outdated screen (deliverable 26, LZP-104) and KEEP WORKING FULLY
 * OFFLINE — 19.1 does not bend for a protocol bump.
 * X-LZP-Min-Protocol on every response lets a client surface the quiet „Update verfügbar" hint
 * (22.4) BEFORE the gate is enforced.
 * @param {HttpResponse} res
 * @returns {{ok:true} | {ok:false, kind:'too_old'|'unknown', minProto:number, minClientVersion:string}}
 */
export function checkProtocol(res) { throw new Error('not implemented'); }
