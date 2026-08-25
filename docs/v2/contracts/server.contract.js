// docs/v2/contracts/server.contract.js
//
// INTERFACE CONTRACT — server handlers and the storage adapter. Normative for ADR 003 §9.
//
// HARD RULE: no file under server/core/ may import Prisma, @vercel/*, node:fs, call fetch,
// read process.env, or call Date.now() / crypto.randomUUID() / Math.random(). Everything arrives
// through `ctx`. That is what makes every server story testable on a machine with no Vercel and
// no Postgres — the SAME handler code runs in CI and in production.

/* eslint-disable no-unused-vars */

// ─────────────────────────────────────────────────────────────────────────────
// 1. Request / response / context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ServerReq
 * @property {string} method @property {string} path
 * @property {Object<string,string>} query @property {Object<string,string>} headers
 * @property {any} body @property {Uint8Array} rawBody
 */
/**
 * @typedef {Object} ServerRes
 * @property {number} status @property {Object<string,string>} [headers] @property {any} body
 */
/**
 * @typedef {Object} ServerCtx
 * @property {SyncStore} store
 * @property {() => number} now                        injected clock — no Date.now() in handlers
 * @property {(n:number) => Uint8Array} random
 * @property {(req:ServerReq) => Promise<AuthResult>} auth
 * @property {(memberId:string, spaceId:string) => Promise<void>} assertMember
 * @property {(evt:Object) => void} log
 *           WHITELISTED FIELDS ONLY: {route, spaceId, deviceShort, opCount, byteCount, status, ms}.
 *           It must never be able to receive envelope / ct / iv / sig / wrapped / wrappedKeys /
 *           boxA / boxB / delivery. tests/server/log-redaction.test.js greps the serialiser.
 * @property {typeof LIMITS_SHAPE} limits
 */
/** @typedef {{deviceShort:string, deviceId:string, memberId:string}} AuthResult */

export const LIMITS_SHAPE = Object.freeze({
  opsPerPush: 200, bytesPerEnvelope: 65536, bytesPerRequest: 4194304, opsPerPull: 500,
  pushPerMin: 60, pullPerMin: 120, invitesPerIpHour: 10, pairGetPerIpHour: 20,
  pairSessionsPerMemberHour: 10, pairAttempts: 5,
  authWindowMs: 120000, nonceTtlMs: 300000,
});

export class HttpError extends Error {
  /** @param {number} status @param {string} code @param {Object} [extra] */
  constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Auth  (ADR 003 §2) — fail closed at every step, in this order
// ─────────────────────────────────────────────────────────────────────────────

/**
 *  1 parse Authorization                       → 401 bad_auth
 *  2 |now - ts| > 120 s                        → 401 stale_request
 *  3 claimNonce() === false                    → 401 replay
 *  4 unknown device or revokedAt != null       → 403 device_revoked
 *  5 signature verify fails                    → 401 bad_signature
 *  6 member.removedAt != null                  → 403 not_a_member
 *  7 (space routes) not a member of spaceId    → 403 not_a_member
 *
 * The server CANNOT validate entry ownership — that lives inside the ciphertext (ADR 001 §4.5).
 * LZP-901's "server-side validation" clause is escalated to the PO as risk R7.
 *
 * @param {ServerReq} req @param {ServerCtx} ctx @returns {Promise<AuthResult>}
 */
export async function authenticate(req, ctx) { throw new Error('not implemented'); }

// ─────────────────────────────────────────────────────────────────────────────
// 3. Handlers — pure functions of (req, ctx)
// ─────────────────────────────────────────────────────────────────────────────

/** @typedef {(req:ServerReq, ctx:ServerCtx) => Promise<ServerRes>} Handler */

/** GET /api/v1/meta → {minProto, maxProto, region, serverTime} @type {Handler} */
export async function meta(req, ctx) { throw new Error('not implemented'); }

/** POST /api/v1/ops — idempotent on (spaceId, opId). Never inspects `ct`. @type {Handler} */
export async function pushOps(req, ctx) { throw new Error('not implemented'); }
/** GET /api/v1/ops?space&since&limit — piggybacks `members`. @type {Handler} */
export async function pullOps(req, ctx) { throw new Error('not implemented'); }

/** POST /api/v1/spaces @type {Handler} */              export async function createSpace(req, ctx) { throw new Error('not implemented'); }
/** POST /api/v1/spaces/:id/epoch — atomic; first-writer-wins; COVERAGE-CHECKED @type {Handler} */
export async function rotateEpoch(req, ctx) { throw new Error('not implemented'); }
/** GET  /api/v1/spaces/:id/keys — every wrap for this device, ALL epochs @type {Handler} */
export async function fetchKeys(req, ctx) { throw new Error('not implemented'); }
/** GET  /api/v1/spaces/:id/members @type {Handler} */  export async function listMembers(req, ctx) { throw new Error('not implemented'); }
/** POST /api/v1/spaces/:id/rename @type {Handler} */   export async function renameSpace(req, ctx) { throw new Error('not implemented'); }
/** POST /api/v1/spaces/:id/delete — 20.4, full cascade @type {Handler} */
export async function deleteSpace(req, ctx) { throw new Error('not implemented'); }

/** POST /api/v1/invites @type {Handler} */             export async function createInvite(req, ctx) { throw new Error('not implemented'); }
/** POST /api/v1/invites/redeem — atomic single-use. Admits the member and publishes their
 *  device public key. Returns NO key material (D9): the key ring is wrapped later, by any
 *  member device, via the keys endpoints. @type {Handler} */
export async function redeemInvite(req, ctx) { throw new Error('not implemented'); }
/** POST /api/v1/invites/revoke — 15.5 @type {Handler} */ export async function revokeInvite(req, ctx) { throw new Error('not implemented'); }
/** GET  /api/v1/invites/open — open invites needing a re-wrap on rotation @type {Handler} */
export async function openInvites(req, ctx) { throw new Error('not implemented'); }

/** POST /api/v1/members/remove — 20.1/20.2; PURGES that member's Op rows in the same tx @type {Handler} */
export async function removeMember(req, ctx) { throw new Error('not implemented'); }
/** POST /api/v1/members/leave — 20.3 @type {Handler} */ export async function leaveSpace(req, ctx) { throw new Error('not implemented'); }
/** POST /api/v1/members/transfer — mirrors the IN-LOG admin chain; never authoritative @type {Handler} */
export async function transferAdmin(req, ctx) { throw new Error('not implemented'); }

/** POST /api/v1/devices @type {Handler} */             export async function registerDevice(req, ctx) { throw new Error('not implemented'); }
/** POST /api/v1/devices/adopt — A2 recovery, signed by RK_sig @type {Handler} */
export async function adoptDevice(req, ctx) { throw new Error('not implemented'); }
/** POST /api/v1/devices/revoke @type {Handler} */      export async function revokeDevice(req, ctx) { throw new Error('not implemented'); }

/** POST /api/v1/pair/offer @type {Handler} */          export async function pairOffer(req, ctx) { throw new Error('not implemented'); }
/** GET  /api/v1/pair/:rid @type {Handler} */           export async function pairGet(req, ctx) { throw new Error('not implemented'); }
/** POST /api/v1/pair/answer @type {Handler} */         export async function pairAnswer(req, ctx) { throw new Error('not implemented'); }
/** POST /api/v1/pair/deliver @type {Handler} */        export async function pairDeliver(req, ctx) { throw new Error('not implemented'); }

/**
 * (method, path) → Handler. SHARED by api/v1/[[...path]].js and by tests/helpers/loopback.js,
 * so the fleet suite exercises the real handlers with no sockets.
 * @param {ServerCtx} ctx @param {ServerReq} req @returns {Promise<ServerRes>}
 */
export async function route(ctx, req) { throw new Error('not implemented'); }

// ─────────────────────────────────────────────────────────────────────────────
// 4. The storage adapter interface — the whole contract between handlers and the world
// ─────────────────────────────────────────────────────────────────────────────

/** @typedef {Object} SpaceRow
 *  @property {string} id @property {'PERSONAL'|'FAMILY'} kind
 *  @property {number} currentEpoch @property {bigint} nextSeq @property {Uint8Array|null} headChain */
/** @typedef {Object} MemberRowDb
 *  @property {string} id @property {string} spaceId @property {string} colorRef
 *  @property {Uint8Array} recoveryPubSig @property {Date} joinedAt @property {Date|null} removedAt */
/** @typedef {Object} DeviceRow
 *  @property {string} id @property {string} memberId @property {string} deviceShort
 *  @property {Uint8Array} sigPubRaw @property {Uint8Array} kexPubRaw @property {Uint8Array} attestation
 *  @property {bigint} lastSeenSeq @property {Date|null} revokedAt */
/** @typedef {Object} OpRow
 *  @property {string} spaceId @property {bigint} seq @property {string} opId @property {number} epoch
 *  @property {string} deviceShort @property {Uint8Array|null} witness @property {Uint8Array} chain
 *  @property {Uint8Array} envelope @property {Date} receivedAt */
/** @typedef {Object} InviteRow
 *  @property {string} id @property {string} spaceId @property {Uint8Array} verifier
 *  @property {Uint8Array} wrapSalt @property {number} epoch   // no wrappedKeys — D9
 *  @property {string} createdBy @property {Date} expiresAt
 *  @property {Date|null} usedAt @property {Date|null} revokedAt */
/** @typedef {Object} KeyWrapRow
 *  @property {string} spaceId @property {number} epoch @property {string} deviceId
 *  @property {Uint8Array} wrapped */

/**
 * ~30 methods, all narrow, all async, none leaking SQL.
 *
 * `tx(fn)` is in the interface precisely because Postgres transaction semantics are the one
 * behaviour that cannot be exercised on this machine: the memory adapter implements it with a
 * mutex plus snapshot/rollback so the SHAPE is exercised, and
 * tests/server/store-contract.test.js runs the same ~40 assertions against `memory` and `file`
 * so `prismaStore` has one written specification to satisfy.
 *
 * @typedef {Object} SyncStore
 *
 * @property {<T>(fn:(tx:SyncStore)=>Promise<T>) => Promise<T>} tx   ATOMIC. Rolls back on throw.
 *
 * // spaces
 * @property {(id:string) => Promise<SpaceRow|null>} getSpace
 * @property {(row:SpaceRow, adminMemberId:string) => Promise<SpaceRow>} createSpace
 * @property {(id:string) => Promise<void>} deleteSpace                 // cascades EVERYTHING (20.4)
 * @property {(id:string, n:number) => Promise<bigint>} reserveSeq
 *           row-locked per-space counter (ADR 003 §3.3). NEVER a Postgres SERIAL: a global
 *           sequence leaves gaps and `WHERE seq > cursor` can then skip a late-committing op.
 * @property {(id:string, epoch:number) => Promise<boolean>} claimEpoch  // false if already taken
 * @property {(id:string, epoch:number) => Promise<void>} setCurrentEpoch
 *
 * // ops
 * @property {(spaceId:string, rows:OpRow[]) => Promise<{inserted:OpRow[], existing:OpRow[]}>} upsertOps
 * @property {(spaceId:string, since:bigint, limit:number) => Promise<{ops:OpRow[], hasMore:boolean}>} listOps
 * @property {(spaceId:string) => Promise<bigint>} headSeq
 * @property {(spaceId:string, deviceShorts:string[]) => Promise<number>} deleteOpsByDevices  // 20.2
 *
 * // members & devices
 * @property {(spaceId:string) => Promise<MemberRowDb[]>} listMembers          // includes removed
 * @property {(m:MemberRowDb) => Promise<MemberRowDb>} addMember
 * @property {(memberId:string, at:number) => Promise<void>} removeMember
 * @property {(spaceId:string, colorRef:string) => Promise<boolean>} colorFree  // 15.3
 * @property {(d:DeviceRow) => Promise<void>} addDevice
 * @property {(deviceShort:string) => Promise<DeviceRow|null>} getDeviceByShort
 * @property {(deviceId:string) => Promise<DeviceRow|null>} getDevice
 * @property {(deviceId:string, at:number) => Promise<void>} revokeDevice
 * @property {(deviceShort:string, seq:bigint) => Promise<void>} setLastSeenSeq
 * @property {(spaceId:string) => Promise<bigint>} minLastSeenSeq            // gates tombstone GC
 *
 * // key wraps
 * @property {(rows:KeyWrapRow[]) => Promise<void>} putKeyWraps
 * @property {(spaceId:string, deviceId:string) => Promise<KeyWrapRow[]>} getKeyWraps
 * @property {(spaceId:string, deviceIds:string[]) => Promise<number>} deleteKeyWrapsForDevices
 *
 * // invites
 * @property {(row:InviteRow) => Promise<void>} putInvite
 * @property {(id:string) => Promise<InviteRow|null>} getInvite
 * @property {(id:string, at:number) => Promise<InviteRow|null>} consumeInvite
 *           ATOMIC single-use: UPDATE ... WHERE id=$1 AND usedAt IS NULL RETURNING *,
 *           There is no wrappedKeys column to clear (D9).
 * @property {(id:string, at:number) => Promise<void>} revokeInvite
 * @property {(spaceId:string) => Promise<InviteRow[]>} listOpenInvites
 * @property {(id:string, epoch:number) => Promise<void>} refreshInvite   // no key material — D9
 *
 * // pairing, nonces, rate limits
 * @property {(rid:string, patch:Object, ttlMs:number) => Promise<void>} putPairSession
 * @property {(rid:string) => Promise<Object|null>} getPairSession
 * @property {(rid:string) => Promise<number>} bumpPairAttempts
 * @property {(rid:string) => Promise<void>} burnPairSession
 * @property {(deviceShort:string, nonce:string, ttlMs:number) => Promise<boolean>} claimNonce
 *           false ⇒ replay
 * @property {(key:string, windowMs:number, max:number) => Promise<boolean>} rateAllow
 */

/** Production only. @returns {SyncStore} */ export function prismaStore() { throw new Error('not implemented'); }
/** Tests + the fleet suite. Maps + a mutex for tx(); snapshot/rollback. @returns {SyncStore} */
export function memoryStore() { throw new Error('not implemented'); }
/** server/dev-server.mjs — lets two REAL app windows sync on this machine. @returns {SyncStore} */
export function fileStore(dir) { throw new Error('not implemented'); }

/**
 * The only Vercel-aware file in the repo (< 40 lines): normalise Request → ServerReq, build ctx
 * with prismaStore(), run route(), write ServerRes back. A bug in it cannot be a bug in a handler.
 */
export function vercelAdapter(routeFn, storeFactory) { throw new Error('not implemented'); }
