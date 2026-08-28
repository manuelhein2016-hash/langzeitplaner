// server/core/store-interface.js — the SyncStore contract, and the suite every adapter must pass.
//
// ADR 003 §9, ADR 005 §1.6, docs/v2/contracts/server.contract.js §4.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE IS THE MOST IMPORTANT ONE IN E2
// ─────────────────────────────────────────────────────────────────────────────────────────────
// This machine has no Vercel, no Postgres and no GitHub remote, so `server/adapters/prisma.js`
// can never be executed here. The honest choices were (a) ship it unverified and hope, or
// (b) write the specification down as EXECUTABLE CASES, run them against the two adapters that
// can run, and let prisma.js be measured against the same text the moment a machine with a
// database exists. This file is (b).
//
// So the cases below are not "tests for the memory adapter". They are the contract. The memory
// and file adapters are two witnesses that the contract is satisfiable and self-consistent;
// prisma.js is a third implementation of the same prose with `UNVERIFIED` written on every
// claim only a real Postgres can settle.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE TWO STRUCTURAL RULES (LZP-201, story 21.1 — "the relay is blind")
// ─────────────────────────────────────────────────────────────────────────────────────────────
// RULE 1 — THE STORE IS INCAPABLE OF HOLDING PLAINTEXT.
//   Not "handlers are careful". Structural. Two mechanisms, both enforced by every adapter
//   through `normalizeRow` below and both asserted by the contract cases:
//     · every ciphertext-bearing field is declared in OPAQUE_FIELDS and REJECTS anything that is
//       not raw bytes, so a well-meaning future handler cannot assign a note's text to
//       `envelope` and have it silently stored as a UTF-8 string; and
//     · the column set of every model is CLOSED (MODEL_COLUMNS). An unknown key on a row throws.
//       There is no `text`, no `name`, no `ts`, no `wrappedKeys` (D9) to write into, and one
//       cannot be added by accident because adding it means editing this table, the schema and
//       the contract case that reads both.
//   The only readable String columns in the whole store are enumerated in PLAINTEXT_STRINGS,
//   each with the clause that forces it to exist. That list IS the metadata inventory of
//   ADR 003 §5.2 in machine-readable form.
//
// RULE 2 — PER-SPACE, GAPLESS, ROW-LOCKED `seq` (ADR 003 §3.3, risk R3).
//   Never a global SERIAL. A global sequence leaves gaps when transactions commit out of order,
//   and `WHERE seq > cursor` can then skip an op that committed after a higher-numbered one — a
//   silent, intermittent data-loss bug. It also leaks cross-family activity volume: two families
//   sharing one relay could each read the other's traffic rate off their own seq deltas.
//   `reserveSeq` is therefore a per-space counter bump, and duplicate opIds are filtered BEFORE
//   the bump so an idempotent re-push never burns a number.
//
// PURITY (ADR 003 §9). Nothing here reads a clock, a random source, an environment variable or
// the filesystem. The contract cases receive a `makeStore` factory, an injected `clock` and an
// `assert` — so this file is `node:test`-free and could be driven from any harness, including one
// that eventually runs against Frankfurt.

/* eslint-disable no-unused-vars */

// ─────────────────────────────────────────────────────────────────────────────
// 1. Row typedefs — the shapes that cross the adapter boundary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SpaceRow
 * @property {string} id                     'psp_'|'fsp_' + 22 b64url
 * @property {'PERSONAL'|'FAMILY'} kind
 * @property {number} currentEpoch
 * @property {bigint} nextSeq                RULE 2 — the per-space counter
 * @property {Uint8Array|null} headChain     ADR 002 §5.4, opaque
 * @property {Date} createdAt
 */

/**
 * @typedef {Object} MemberRowDb
 * @property {string} id                     'mem_' + 22 b64url — pseudonymous
 * @property {string} spaceId
 * @property {string} colorRef               THE ONE DELIBERATE PLAINTEXT LEAK (ADR 003 §5.2)
 * @property {Uint8Array} recoveryPubSig     65 B raw P-256; verifies attestations and /devices/adopt
 * @property {Uint8Array} recoveryPubKex     65 B raw P-256; the RK_kex rotation wraps to (finding E3-2)
 * @property {Date} joinedAt
 * @property {Date|null} removedAt
 */

/**
 * @typedef {Object} DeviceRow
 * @property {string} id                     'dev_' + 22 b64url — A LABEL, NOT AN IDENTITY (ADR 002 §2.3)
 * @property {string} memberId
 * @property {string} deviceShort            16 Crockford base32 — the real device identity
 * @property {Uint8Array} sigPubRaw
 * @property {Uint8Array} kexPubRaw
 * @property {Uint8Array} attestation        signed by the member's recovery key; opaque here
 * @property {bigint} lastSeenSeq            READ progress  — gates tombstone GC
 * @property {bigint} lastPushedSeq          WRITE progress — also gates GC (server.contract.js amendment)
 * @property {Date} addedAt
 * @property {Date|null} revokedAt
 */

/**
 * @typedef {Object} OpInput                 what a handler hands to `upsertOps`
 * @property {string} opId                   22 b64url — the idempotency key
 * @property {number} epoch
 * @property {string} deviceShort
 * @property {Uint8Array|null} witness
 * @property {Uint8Array} chain
 * @property {Uint8Array} envelope           iv || ct || sig — PADDED. UNREADABLE. OPAQUE.
 */

/**
 * @typedef {OpInput & {spaceId:string, seq:bigint, receivedAt:Date}} OpRow
 */

/**
 * @typedef {Object} KeyWrapRow
 * @property {string} spaceId
 * @property {number} epoch
 * @property {string} recipientId            'dev_…' OR 'rec_<memberId>' — see DECISION E3-4 below
 * @property {Uint8Array} wrapped            {salt,iv,ct} — opaque
 */

/**
 * @typedef {Object} InviteRow
 * @property {string} id                     HKDF(code,…,'id') — the raw code never arrives
 * @property {string} spaceId
 * @property {Uint8Array} verifier
 * @property {Uint8Array} wrapSalt
 * @property {number} epoch
 * @property {string} createdBy
 * @property {Date} expiresAt
 * @property {Date|null} usedAt
 * @property {Date|null} revokedAt
 */
// NOTE: there is no `wrappedKeys`. PO decision D9 — an invite carries no key material of any
// kind. It is absent from MODEL_COLUMNS, so writing one is a throw, not a review comment.

/**
 * @typedef {Object} PairSessionRow
 * @property {string} rid
 * @property {Uint8Array|null} boxA
 * @property {Uint8Array|null} boxB
 * @property {Uint8Array|null} delivery
 * @property {number} attempts               ADR 002 §6.2 — 5 failed decrypts, then BURNED
 * @property {Date} expiresAt                180 s
 * @property {Date|null} burnedAt            a burn is permanent; see `burnPairSession`
 */

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE BLINDNESS TABLE — RULE 1, machine-readable
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every model, and every column it is allowed to have. Closed set. An adapter must reject a row
 * carrying anything else, and `server/prisma/schema.prisma` must declare exactly these.
 *
 * Read this table as the answer to "what can the relay see?" — because it is the whole answer.
 */
export const MODEL_COLUMNS = Object.freeze({
  Space:       Object.freeze(['id', 'kind', 'currentEpoch', 'nextSeq', 'headChain', 'createdAt']),
  Member:      Object.freeze(['id', 'spaceId', 'colorRef', 'recoveryPubSig', 'recoveryPubKex', 'joinedAt', 'removedAt']),
  Device:      Object.freeze(['id', 'memberId', 'deviceShort', 'sigPubRaw', 'kexPubRaw', 'attestation', 'lastSeenSeq', 'lastPushedSeq', 'addedAt', 'revokedAt']),
  Op:          Object.freeze(['spaceId', 'seq', 'opId', 'epoch', 'deviceShort', 'witness', 'chain', 'envelope', 'receivedAt']),
  Epoch:       Object.freeze(['spaceId', 'epoch', 'createdAt']),
  KeyWrap:     Object.freeze(['spaceId', 'epoch', 'recipientId', 'wrapped']),
  Invite:      Object.freeze(['id', 'spaceId', 'verifier', 'wrapSalt', 'epoch', 'createdBy', 'expiresAt', 'usedAt', 'revokedAt']),
  PairSession: Object.freeze(['rid', 'boxA', 'boxB', 'delivery', 'attempts', 'expiresAt', 'burnedAt']),
  Nonce:       Object.freeze(['deviceShort', 'nonce', 'expiresAt']),
  RateBucket:  Object.freeze(['key', 'count', 'windowStart']),
});

/**
 * Columns that carry bytes the server can never interpret. An adapter MUST reject a String here.
 *
 * This is the mechanism, not a naming convention: it is what makes "a future handler cannot put
 * a note's text in the database" true rather than hoped for. Assigning `envelope = 'Zahnarzt'`
 * throws a StoreShapeError at the adapter boundary, in memory, in a file and in Postgres.
 */
export const OPAQUE_FIELDS = Object.freeze({
  Space:       Object.freeze(['headChain']),
  Member:      Object.freeze(['recoveryPubSig', 'recoveryPubKex']),
  Device:      Object.freeze(['sigPubRaw', 'kexPubRaw', 'attestation']),
  Op:          Object.freeze(['witness', 'chain', 'envelope']),
  Epoch:       Object.freeze([]),
  KeyWrap:     Object.freeze(['wrapped']),
  Invite:      Object.freeze(['verifier', 'wrapSalt']),
  PairSession: Object.freeze(['boxA', 'boxB', 'delivery']),
  Nonce:       Object.freeze([]),
  RateBucket:  Object.freeze([]),
});

/** Columns that may be null / absent. Everything else is required on insert. */
export const NULLABLE_FIELDS = Object.freeze({
  Space:       Object.freeze(['headChain']),
  Member:      Object.freeze(['removedAt']),
  Device:      Object.freeze(['revokedAt']),
  Op:          Object.freeze(['witness']),
  Epoch:       Object.freeze([]),
  KeyWrap:     Object.freeze([]),
  Invite:      Object.freeze(['usedAt', 'revokedAt']),
  PairSession: Object.freeze(['boxA', 'boxB', 'delivery', 'burnedAt']),
  Nonce:       Object.freeze([]),
  RateBucket:  Object.freeze([]),
});

/**
 * EVERY readable String column in the store, with the clause that forces it to exist. This is
 * ADR 003 §5.2's metadata inventory as data. A String column not on this list is a design
 * regression and the contract cases fail on it.
 *
 * Note what is absent and cannot be added without editing this constant: any display name, any
 * entry text, any category, any date, any authoring time.
 */
export const PLAINTEXT_STRINGS = Object.freeze({
  'Space.id':            'a space id must be addressable; pseudonymous prefix + 22 b64url',
  'Space.kind':          'PERSONAL|FAMILY — the enum, not a name',
  'Member.id':           'pseudonymous member id',
  'Member.spaceId':      'the relation',
  'Member.colorRef':     'THE ONE DELIBERATE LEAK. 15.3 needs @@unique([spaceId,colorRef]) server-side to prevent a colour collision. One palette index per member. It appears verbatim in the Datenschutz copy (21.3).',
  'Device.id':           'a label, not an identity (ADR 002 §2.3)',
  'Device.memberId':     'the relation',
  'Device.deviceShort':  'derived from the signing key (ADR 001 §1.2); the auth lookup key',
  'Op.spaceId':          'the relation and the per-space cursor scope',
  'Op.opId':             'the idempotency key — random, carries nothing',
  'Op.deviceShort':      'needed to purge a removed member (20.2) and to check e.dv === auth device',
  'Epoch.spaceId':       'the relation',
  'KeyWrap.spaceId':     'the relation',
  'KeyWrap.recipientId': 'a device id or rec_<memberId>; addresses an opaque blob',
  'Invite.id':           'HKDF of the code; the raw code never reaches the server',
  'Invite.spaceId':      'the relation',
  'Invite.createdBy':    'a member id — 15.5 lets the issuer revoke',
  'PairSession.rid':     'HKDF of the pairing code; opaque to the relay (ADR 002 §6.2)',
  'Nonce.deviceShort':   'the replay window is per device',
  'Nonce.nonce':         'a b64url random string the client chose',
  'RateBucket.key':      'a limiter key; composed of route + device/IP, never of content',
});

/**
 * Substrings that may not appear in any column name, in this table or in schema.prisma.
 * Belt and braces on top of the closed column set: they name the shapes a plausible future
 * "small addition" would take, so the failure message can say what the rule is.
 */
export const FORBIDDEN_COLUMN_TOKENS = Object.freeze([
  'wrappedkeys',   // D9 — an invite carries no key material
  'displayname',   // display names travel as member.set ops inside the ciphertext
  'plaintext',
  'notetext',
  'barlabel',
  'category',
  'scratchpad',
  'title',
  'caption',
  'authoredat',    // authoring time lives inside the ciphertext; the relay keeps receivedAt only
  'role',          // the admin is resolved from the in-log chain, never from a column
]);

// ─────────────────────────────────────────────────────────────────────────────
// 3. Row validation — the mechanism behind RULE 1. Adapters import these.
// ─────────────────────────────────────────────────────────────────────────────

/** A programmer error at the adapter boundary. Never a wire status; a handler must not catch it. */
export class StoreShapeError extends Error {
  constructor(message) { super(message); this.name = 'StoreShapeError'; }
}

/** @param {unknown} v @returns {boolean} */
export function isBytes(v) {
  return v instanceof Uint8Array;
}

/**
 * Validate and shallow-copy a row against its model.
 *
 * @param {keyof MODEL_COLUMNS|string} model
 * @param {Object} row
 * @param {{partial?:boolean}} [opts] partial: allow a subset of columns (for patches)
 * @returns {Object} a fresh object carrying exactly the declared columns
 * @throws {StoreShapeError}
 */
export function normalizeRow(model, row, opts) {
  const cols = MODEL_COLUMNS[model];
  if (!cols) throw new StoreShapeError(`unknown model ${model}`);
  if (!row || typeof row !== 'object') throw new StoreShapeError(`${model}: row must be an object`);

  const partial = !!(opts && opts.partial);
  const opaque = OPAQUE_FIELDS[model];
  const nullable = NULLABLE_FIELDS[model];

  for (const k of Object.keys(row)) {
    if (!cols.includes(k)) {
      throw new StoreShapeError(
        `${model}.${k} is not a column. The column set is closed (RULE 1): the relay stores ` +
        `ciphertext and coordination data only. Adding a column means editing MODEL_COLUMNS, ` +
        `server/prisma/schema.prisma and the contract case that compares them.`,
      );
    }
  }

  const out = {};
  for (const k of cols) {
    const present = Object.prototype.hasOwnProperty.call(row, k);
    if (!present) {
      if (partial) continue;
      if (nullable.includes(k)) { out[k] = null; continue; }
      throw new StoreShapeError(`${model}.${k} is required`);
    }
    const v = row[k];
    if (v === null || v === undefined) {
      if (!nullable.includes(k)) throw new StoreShapeError(`${model}.${k} may not be null`);
      out[k] = null;
      continue;
    }
    if (opaque.includes(k)) {
      if (!isBytes(v)) {
        throw new StoreShapeError(
          `${model}.${k} must be raw bytes (Uint8Array), got ${typeof v}. This column carries ` +
          `ciphertext the relay can never read; a string here is how plaintext gets into the ` +
          `database (story 21.1).`,
        );
      }
      out[k] = v;
      continue;
    }
    out[k] = v;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The SyncStore interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SyncStore
 *
 * @property {<T>(fn:(tx:SyncStore)=>Promise<T>) => Promise<T>} tx
 *   ATOMIC. Every mutation inside `fn` commits together or not at all. Rolls back on throw and
 *   re-throws. The handle passed to `fn` is itself a SyncStore, so `tx` nests (re-entrantly, on
 *   the same transaction — it never opens a second one and never deadlocks).
 *
 * SPACES
 * @property {(id:string) => Promise<SpaceRow|null>} getSpace
 * @property {(row:SpaceRow) => Promise<SpaceRow>} createSpace       throws on a duplicate id
 * @property {(id:string) => Promise<void>} deleteSpace              cascades EVERYTHING (20.4)
 * @property {(id:string, n:number) => Promise<bigint>} reserveSeq
 *   RULE 2. Bumps the per-space counter by n under a row lock and returns the LAST seq of the
 *   reserved block, i.e. the new `nextSeq`. The block is [ret-n+1 … ret]. Mirrors
 *   `UPDATE "Space" SET "nextSeq" = "nextSeq" + $n WHERE id = $1 RETURNING "nextSeq"` exactly.
 *   NEVER a Postgres SERIAL.
 * @property {(id:string, epoch:number) => Promise<boolean>} claimEpoch   false if already taken
 * @property {(id:string, epoch:number) => Promise<void>} setCurrentEpoch
 * @property {(id:string, chain:Uint8Array|null) => Promise<void>} setHeadChain
 *
 * OPS
 * @property {(spaceId:string, rows:OpInput[]) => Promise<{inserted:OpRow[], existing:OpRow[]}>} upsertOps
 *   Idempotent on (spaceId, opId). Filters duplicates BEFORE reserving seq, so a re-push burns
 *   no numbers. Assigns seq in array order to the surviving rows, contiguously.
 * @property {(spaceId:string, opIds:string[]) => Promise<OpRow[]>} existingOpIds
 *   Read-only pre-pass. Two callers need it: the chain computation (each new op's chain depends
 *   on its predecessor, so the handler must know which rows are new before it hashes) and
 *   `409 forked_op_id`, which compares the stored envelope with the re-pushed one.
 * @property {(spaceId:string, since:bigint, limit:number) => Promise<{ops:OpRow[], hasMore:boolean}>} listOps
 * @property {(spaceId:string) => Promise<bigint>} headSeq
 * @property {(spaceId:string, deviceShorts:string[]) => Promise<number>} deleteOpsByDevices
 *   20.2. Keyed on deviceShort, never on a bare deviceId — ADR 002 §2.3's obligation on WP-9:
 *   a purge keyed on a forgeable label lets a removed member delete an honest peer's ops.
 *
 * MEMBERS AND DEVICES
 * @property {(spaceId:string) => Promise<MemberRowDb[]>} listMembers      includes removed
 * @property {(m:MemberRowDb) => Promise<MemberRowDb>} addMember
 * @property {(memberId:string, at:number) => Promise<void>} removeMember
 * @property {(spaceId:string, colorRef:string) => Promise<boolean>} colorFree
 * @property {(d:DeviceRow) => Promise<void>} addDevice
 * @property {(deviceId:string) => Promise<DeviceRow|null>} getDevice
 * @property {(deviceShort:string) => Promise<DeviceRow|null>} getDeviceByShort
 * @property {(spaceId:string) => Promise<DeviceRow[]>} listDevices
 *   Every device of every member of the space, revoked ones included. Three callers need it and
 *   the contract had no method for it: the `members` piggyback on pull (ADR 003 §3.2), the
 *   removal purge (20.2), and — the one that matters — the ROTATION COVERAGE CHECK
 *   (ADR 002 §4.2): the server can only reject an epoch bump that omits an honest member if it
 *   can enumerate who was owed a wrap. See INTERFACE_EXTENSIONS.
 * @property {(deviceId:string, at:number) => Promise<void>} revokeDevice
 * @property {(deviceShort:string, seq:bigint) => Promise<void>} setLastSeenSeq   monotone
 * @property {(spaceId:string) => Promise<bigint>} minLastSeenSeq
 * @property {(deviceShort:string, seq:bigint) => Promise<void>} setLastPushedSeq monotone
 * @property {(spaceId:string) => Promise<bigint>} minLastPushedSeq
 *   Both minima FAIL CLOSED: a space with no devices, or a device that has never reported,
 *   yields 0n. "Unknown" must never mean "collectable" (server.contract.js amendment).
 *
 * KEY WRAPS
 * @property {(rows:KeyWrapRow[]) => Promise<void>} putKeyWraps       upsert on (spaceId,epoch,recipientId)
 * @property {(spaceId:string, recipientId:string) => Promise<KeyWrapRow[]>} getKeyWraps  ALL epochs
 * @property {(spaceId:string, recipientIds:string[]) => Promise<number>} deleteKeyWrapsForDevices
 *
 * INVITES
 * @property {(row:InviteRow) => Promise<void>} putInvite
 * @property {(id:string) => Promise<InviteRow|null>} getInvite
 * @property {(id:string, at:number) => Promise<InviteRow|null>} consumeInvite
 *   ATOMIC single-use. Exactly one concurrent caller may win. Returns null if already used,
 *   revoked, expired or unknown — the four are indistinguishable to the caller on purpose.
 * @property {(id:string, at:number) => Promise<void>} revokeInvite
 * @property {(spaceId:string) => Promise<InviteRow[]>} listOpenInvites
 * @property {(id:string, epoch:number) => Promise<void>} refreshInvite   epoch only — no key material (D9)
 *
 * PAIRING, NONCES, RATE LIMITS
 * @property {(rid:string, patch:Object, ttlMs:number) => Promise<void>} putPairSession
 *   Creates or patches. A BURNED rid can never be re-created — see `burnPairSession`.
 * @property {(rid:string) => Promise<PairSessionRow|null>} getPairSession  null when expired or burned
 * @property {(rid:string) => Promise<number>} bumpPairAttempts
 *   ADR 002 §6.2's 5-attempt budget. Atomic increment; concurrent bumps never lose a count.
 *   On an unknown, expired or burned rid it returns Number.MAX_SAFE_INTEGER so a caller written
 *   as `if (attempts >= limits.pairAttempts) burn()` FAILS CLOSED without a special case.
 * @property {(rid:string) => Promise<void>} burnPairSession
 *   Permanent. After a burn `getPairSession` is null forever and `putPairSession` is a no-op —
 *   the rendezvous cannot be resurrected by replaying the offer. This is what makes the code's
 *   60-bit entropy hold: the security argument is a short TTL times a hard attempt cap, and a
 *   burn that a later write could undo is not a cap.
 * @property {(deviceShort:string, nonce:string, ttlMs:number) => Promise<boolean>} claimNonce
 *   false ⇒ replay (ADR 003 §2 step 3). Atomic: exactly one concurrent claimant may win.
 * @property {(key:string, windowMs:number, max:number) => Promise<boolean>} rateAllow
 *   Sliding-window counter over RateBucket. Atomic: exactly `max` of N concurrent calls in one
 *   window may return true. This is the substrate for EVERY limit in ADR 003 §6.1 — push/pull,
 *   invite redemption (10/IP/hour), pair sessions and pair GETs.
 */

/** The complete method set. Frozen; `assertStoreShape` is the gate every adapter passes. */
export const STORE_METHODS = Object.freeze([
  'tx',
  'getSpace', 'createSpace', 'deleteSpace', 'reserveSeq', 'claimEpoch', 'setCurrentEpoch', 'setHeadChain',
  'upsertOps', 'existingOpIds', 'listOps', 'headSeq', 'deleteOpsByDevices',
  'listMembers', 'addMember', 'removeMember', 'colorFree',
  'addDevice', 'getDevice', 'getDeviceByShort', 'listDevices', 'revokeDevice',
  'setLastSeenSeq', 'minLastSeenSeq', 'setLastPushedSeq', 'minLastPushedSeq',
  'putKeyWraps', 'getKeyWraps', 'deleteKeyWrapsForDevices',
  'putInvite', 'getInvite', 'consumeInvite', 'revokeInvite', 'listOpenInvites', 'refreshInvite',
  'putPairSession', 'getPairSession', 'bumpPairAttempts', 'burnPairSession',
  'claimNonce', 'rateAllow',
]);

/**
 * Where this interface deliberately differs from docs/v2/contracts/server.contract.js §4, and
 * why. Recorded here rather than in a commit message because the contract file is owned by the
 * architecture pass and these are the rows a reviewer must agree with or reverse.
 */
export const INTERFACE_EXTENSIONS = Object.freeze([
  Object.freeze({
    id: 'E2-I1', kind: 'added', method: 'listDevices',
    why: 'ADR 002 §4.2 makes the server reject a rotation whose wraps do not cover every current, non-revoked device of every non-removed member. The contract had listMembers (no devices) and getDevice (one at a time), so the coverage check — the largest single thing an admin can do to an honest member, and the control E3 found "in a contract and in no code" — was not expressible. It is also what the `members` piggyback on pull (ADR 003 §3.2) reads.',
  }),
  Object.freeze({
    id: 'E2-I2', kind: 'added', method: 'existingOpIds',
    why: 'ADR 003 §3.1 requires 409 forked_op_id on a re-push of a known opId with different bytes, which needs the stored envelope; and ADR 002 §5.4 chains each op on its predecessor, which needs to know which rows are new before hashing. Neither is possible with upsertOps alone.',
  }),
  Object.freeze({
    id: 'E2-I3', kind: 'added', method: 'setHeadChain',
    why: 'Space.headChain exists in ADR 003 §5.1 and no contract method wrote it.',
  }),
  Object.freeze({
    id: 'E2-I4', kind: 'changed', method: 'upsertOps',
    why: 'Takes OpInput rows WITHOUT seq/receivedAt and assigns both. ADR 003 §3.3 requires duplicates to be filtered before the counter bump; a caller that supplied seq would have to reserve first and then discover the duplicates, burning numbers on every retry. Moving the assignment inside makes RULE 2 structural instead of a handler convention.',
  }),
  Object.freeze({
    id: 'E2-I5', kind: 'changed', method: 'getKeyWraps / putKeyWraps / deleteKeyWrapsForDevices',
    why: 'KeyWrapRow.deviceId is renamed recipientId and is NOT a foreign key onto Device. This closes finding E3-4: ADR 002 §4.2 step 2 wraps to every device AND to each member RK_kex, and a recovery recipient has no Device row. Values are a device id or the reserved form rec_<memberId>.',
  }),
  Object.freeze({
    id: 'E2-I6', kind: 'added', method: 'Member.recoveryPubKex',
    why: 'Closes finding E3-2. ADR 002 §4.2 step 2 requires a rotation to wrap to each member RK_kex; MemberRowDb carried only recoveryPubSig (a signing key), so the wrap had no public key to address and the coverage check had nothing to demand.',
  }),
  Object.freeze({
    id: 'E2-I7', kind: 'added', method: 'PairSession.burnedAt',
    why: 'ADR 002 §6.2 says the rendezvous is BURNED after 5 failed decrypts. A row that is merely deleted can be re-created by replaying pair/offer, which resets the budget and makes the 60-bit code the security parameter after all. The burn is a tombstone.',
  }),
  Object.freeze({
    id: 'E2-I8', kind: 'added', method: 'Device.lastPushedSeq',
    why: 'Already normative in server.contract.js as an amendment (WRITE progress gates tombstone GC as well as READ progress); listed here because it is absent from ADR 003 §5.1 model Device and the schema now carries it.',
  }),
]);

/**
 * @param {any} store
 * @returns {{ok:boolean, missing:string[], extra:string[]}}
 */
export function inspectStoreShape(store) {
  const missing = [];
  const extra = [];
  if (!store || typeof store !== 'object') return { ok: false, missing: [...STORE_METHODS], extra: [] };
  for (const m of STORE_METHODS) if (typeof store[m] !== 'function') missing.push(m);
  const allowedExtras = new Set(['close', 'dispose', 'flush']);
  for (const k of Object.keys(store)) {
    if (!STORE_METHODS.includes(k) && !allowedExtras.has(k)) extra.push(k);
  }
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

/** @param {any} store @throws {StoreShapeError} */
export function assertStoreShape(store) {
  const r = inspectStoreShape(store);
  if (r.ok) return;
  throw new StoreShapeError(
    `SyncStore shape violation. missing: [${r.missing.join(', ')}]; unexpected public members: ` +
    `[${r.extra.join(', ')}] — a store must expose exactly the interface, so a handler cannot ` +
    `come to depend on one adapter's private surface.`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Fixtures — shared by the contract cases and by every handler test to come
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic filler bytes. Never a signature, never compared byte-wise (ADR 002 §1 rule 1). */
export function bytes(n, seed) {
  const out = new Uint8Array(n);
  let x = (seed === undefined ? 7 : seed) | 0;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out[i] = x & 0xff; }
  return out;
}

export const fixtures = Object.freeze({
  bytes,
  space: (o) => ({ id: 'fsp_AAAAAAAAAAAAAAAAAAAAAA', kind: 'FAMILY', currentEpoch: 1, nextSeq: 0n, headChain: null, createdAt: new Date(0), ...o }),
  member: (o) => ({ id: 'mem_AAAAAAAAAAAAAAAAAAAAAA', spaceId: 'fsp_AAAAAAAAAAAAAAAAAAAAAA', colorRef: 'gruen', recoveryPubSig: bytes(65, 1), recoveryPubKex: bytes(65, 2), joinedAt: new Date(0), removedAt: null, ...o }),
  device: (o) => ({ id: 'dev_AAAAAAAAAAAAAAAAAAAAAA', memberId: 'mem_AAAAAAAAAAAAAAAAAAAAAA', deviceShort: '7QAR2MZ9XKPNC0GV', sigPubRaw: bytes(65, 3), kexPubRaw: bytes(65, 4), attestation: bytes(120, 5), lastSeenSeq: 0n, lastPushedSeq: 0n, addedAt: new Date(0), revokedAt: null, ...o }),
  op: (opId, o) => ({ opId, epoch: 1, deviceShort: '7QAR2MZ9XKPNC0GV', witness: null, chain: bytes(32, 6), envelope: bytes(512, 7), ...o }),
  invite: (o) => ({ id: 'inv_AAAAAAAAAAAAAAAAAAAAAA', spaceId: 'fsp_AAAAAAAAAAAAAAAAAAAAAA', verifier: bytes(32, 8), wrapSalt: bytes(32, 9), epoch: 1, createdBy: 'mem_AAAAAAAAAAAAAAAAAAAAAA', expiresAt: new Date(7 * 86400000), usedAt: null, revokedAt: null, ...o }),
});

const SP = 'fsp_AAAAAAAAAAAAAAAAAAAAAA';
const SP2 = 'fsp_BBBBBBBBBBBBBBBBBBBBBB';

async function threw(assert, fn, hint) {
  let ok = false;
  let value;
  try { value = await fn(); } catch { ok = true; }
  assert.ok(ok, `${hint} — expected a throw, got ${JSON.stringify(value === undefined ? null : String(value))}`);
}

const seqsOf = (r) => [...r.inserted, ...r.existing].map((o) => o.seq);
const sortBig = (a) => [...a].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

async function withSpace(makeStore, id) {
  const store = await makeStore();
  await store.createSpace(fixtures.space({ id: id || SP }));
  return store;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE CONTRACT — executable, adapter-agnostic, node:test-free
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every case is `{id, title, tags, run(env)}` where env is
 *   { makeStore: () => Promise<SyncStore>,   // a fresh, empty store bound to `clock`
 *     assert,                                // node:assert/strict-shaped
 *     clock: { now(): number, advance(ms): void } }
 *
 * tests/server/store-contract.test.js runs the whole array against `memory` and `file`.
 * `prisma.js` is measured against the same array on the day a machine with Postgres exists;
 * until then the only thing that file's implementation is checked for is interface SHAPE, and
 * everything else it claims is listed in its own UNVERIFIED_CLAIMS export.
 *
 * @type {ReadonlyArray<{id:string,title:string,tags:string[],run:(env:Object)=>Promise<void>}>}
 */
export const STORE_CONTRACT_CASES = Object.freeze([

  // ── shape ──────────────────────────────────────────────────────────────────
  { id: 'C01', title: 'the adapter implements exactly the SyncStore interface', tags: ['shape'],
    run: async ({ makeStore, assert }) => {
      const store = await makeStore();
      const r = inspectStoreShape(store);
      assert.deepEqual(r.missing, [], 'missing methods');
      assert.deepEqual(r.extra, [], 'unexpected public members');
    } },

  { id: 'C02', title: 'the transaction handle is itself a full SyncStore', tags: ['shape', 'tx'],
    run: async ({ makeStore, assert }) => {
      const store = await makeStore();
      await store.tx(async (t) => { assert.deepEqual(inspectStoreShape(t).missing, []); });
    } },

  // ── RULE 1: the store is incapable of holding plaintext ────────────────────
  { id: 'C03', title: 'RULE 1 — an op envelope must be raw bytes; a string is refused', tags: ['blind'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      await threw(assert, () => store.upsertOps(SP, [fixtures.op('op1', { envelope: 'Zahnarzt 14:30' })]),
        'a String envelope must be refused at the adapter boundary');
      const head = await store.headSeq(SP);
      assert.equal(head, 0n, 'a refused row must not have burned a seq');
    } },

  { id: 'C04', title: 'RULE 1 — every opaque column refuses a string, in every model', tags: ['blind'],
    run: async ({ makeStore, assert }) => {
      const store = await makeStore();
      await threw(assert, () => store.createSpace(fixtures.space({ headChain: 'text' })), 'Space.headChain');
      await store.createSpace(fixtures.space());
      await threw(assert, () => store.addMember(fixtures.member({ recoveryPubSig: 'text' })), 'Member.recoveryPubSig');
      await threw(assert, () => store.addMember(fixtures.member({ recoveryPubKex: 'text' })), 'Member.recoveryPubKex');
      await store.addMember(fixtures.member());
      await threw(assert, () => store.addDevice(fixtures.device({ attestation: 'text' })), 'Device.attestation');
      await threw(assert, () => store.putKeyWraps([{ spaceId: SP, epoch: 1, recipientId: 'dev_x', wrapped: 'text' }]), 'KeyWrap.wrapped');
      await threw(assert, () => store.putInvite(fixtures.invite({ verifier: 'text' })), 'Invite.verifier');
      await threw(assert, () => store.putPairSession('rid1', { boxA: 'text' }, 180000), 'PairSession.boxA');
    } },

  { id: 'C05', title: 'RULE 1 — the column set is closed: an unknown column is refused', tags: ['blind'],
    run: async ({ makeStore, assert }) => {
      const store = await makeStore();
      await threw(assert, () => store.createSpace(fixtures.space({ displayName: 'Familie Hein' })), 'Space.displayName');
      await store.createSpace(fixtures.space());
      await threw(assert, () => store.addMember(fixtures.member({ displayName: 'Mama' })), 'Member.displayName');
      await threw(assert, () => store.addMember(fixtures.member({ role: 'admin' })), 'Member.role — the admin is resolved from the in-log chain');
      await threw(assert, () => store.upsertOps(SP, [fixtures.op('op1', { ts: 1787836800123 })]),
        'Op.ts — authoring time lives inside the ciphertext; the relay keeps receivedAt only');
    } },

  { id: 'C06', title: 'RULE 1 / D9 — an invite cannot carry key material', tags: ['blind', 'D9'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      await threw(assert, () => store.putInvite(fixtures.invite({ wrappedKeys: bytes(64, 11) })),
        'Invite.wrappedKeys was removed by decision D9 and must not be storable');
      await store.putInvite(fixtures.invite());
      const got = await store.getInvite('inv_AAAAAAAAAAAAAAAAAAAAAA');
      assert.deepEqual(Object.keys(got).sort(), [...MODEL_COLUMNS.Invite].sort(),
        'an invite row carries exactly the declared columns and nothing else');
    } },

  { id: 'C07', title: 'RULE 1 — a stored op row exposes exactly the declared columns', tags: ['blind'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      const r = await store.upsertOps(SP, [fixtures.op('op1')]);
      assert.deepEqual(Object.keys(r.inserted[0]).sort(), [...MODEL_COLUMNS.Op].sort());
    } },

  // ── spaces ────────────────────────────────────────────────────────────────
  { id: 'C08', title: 'an unknown space reads as null, not as an empty row', tags: ['space'],
    run: async ({ makeStore, assert }) => {
      const store = await makeStore();
      assert.equal(await store.getSpace('fsp_nope'), null);
    } },

  { id: 'C09', title: 'createSpace round-trips, and a duplicate id is refused', tags: ['space'],
    run: async ({ makeStore, assert }) => {
      const store = await makeStore();
      const row = await store.createSpace(fixtures.space({ kind: 'PERSONAL', id: 'psp_x' }));
      assert.equal(row.kind, 'PERSONAL');
      const got = await store.getSpace('psp_x');
      assert.equal(got.currentEpoch, 1);
      assert.equal(got.nextSeq, 0n);
      assert.equal(got.headChain, null);
      await threw(assert, () => store.createSpace(fixtures.space({ id: 'psp_x' })), 'duplicate space id');
    } },

  { id: 'C10', title: 'claimEpoch is first-writer-wins; setCurrentEpoch and setHeadChain persist', tags: ['space', 'rotation'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      assert.equal(await store.claimEpoch(SP, 2), true);
      assert.equal(await store.claimEpoch(SP, 2), false, 'a concurrent rotator must lose the race (409 epoch_taken)');
      assert.equal(await store.claimEpoch(SP, 3), true);
      await store.setCurrentEpoch(SP, 2);
      await store.setHeadChain(SP, bytes(32, 12));
      const s = await store.getSpace(SP);
      assert.equal(s.currentEpoch, 2);
      assert.equal(isBytes(s.headChain), true);
    } },

  { id: 'C11', title: 'deleteSpace cascades every row of that space and nothing of another', tags: ['space', '20.4'],
    run: async ({ makeStore, assert }) => {
      const store = await makeStore();
      await store.createSpace(fixtures.space({ id: SP }));
      await store.createSpace(fixtures.space({ id: SP2 }));
      await store.addMember(fixtures.member({ spaceId: SP }));
      await store.addMember(fixtures.member({ id: 'mem_B', spaceId: SP2, colorRef: 'blau' }));
      await store.addDevice(fixtures.device({ memberId: 'mem_AAAAAAAAAAAAAAAAAAAAAA' }));
      await store.upsertOps(SP, [fixtures.op('op1')]);
      await store.upsertOps(SP2, [fixtures.op('op2')]);
      await store.putInvite(fixtures.invite({ spaceId: SP }));
      await store.putKeyWraps([{ spaceId: SP, epoch: 1, recipientId: 'dev_AAAAAAAAAAAAAAAAAAAAAA', wrapped: bytes(64, 13) }]);
      await store.deleteSpace(SP);
      assert.equal(await store.getSpace(SP), null);
      assert.equal((await store.listMembers(SP)).length, 0);
      assert.equal((await store.listDevices(SP)).length, 0);
      assert.equal((await store.listOps(SP, 0n, 100)).ops.length, 0);
      assert.equal(await store.getInvite('inv_AAAAAAAAAAAAAAAAAAAAAA'), null);
      assert.equal((await store.getKeyWraps(SP, 'dev_AAAAAAAAAAAAAAAAAAAAAA')).length, 0);
      assert.equal((await store.listOps(SP2, 0n, 100)).ops.length, 1, 'the other space is untouched');
      assert.notEqual(await store.getSpace(SP2), null);
    } },

  // ── RULE 2: per-space, gapless, row-locked seq ────────────────────────────
  { id: 'C12', title: 'RULE 2 — reserveSeq returns the LAST seq of the block, mirroring the ADR SQL', tags: ['seq'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      assert.equal(await store.reserveSeq(SP, 1), 1n, 'first op in a space is seq 1');
      assert.equal(await store.reserveSeq(SP, 1), 2n);
      assert.equal(await store.reserveSeq(SP, 5), 7n, 'a block of 5 reserves 3..7 and returns 7');
      assert.equal((await store.getSpace(SP)).nextSeq, 7n);
    } },

  { id: 'C13', title: 'RULE 2 — reserveSeq refuses n < 1 and an unknown space', tags: ['seq'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      await threw(assert, () => store.reserveSeq(SP, 0), 'n must be at least 1');
      await threw(assert, () => store.reserveSeq(SP, -3), 'n must be positive');
      await threw(assert, () => store.reserveSeq('fsp_nope', 1), 'unknown space');
    } },

  { id: 'C14', title: 'RULE 2 — seq is PER SPACE; two spaces both start at 1', tags: ['seq'],
    run: async ({ makeStore, assert }) => {
      const store = await makeStore();
      await store.createSpace(fixtures.space({ id: SP }));
      await store.createSpace(fixtures.space({ id: SP2 }));
      const a = await store.upsertOps(SP, [fixtures.op('op1'), fixtures.op('op2')]);
      const b = await store.upsertOps(SP2, [fixtures.op('op3')]);
      assert.deepEqual(seqsOf(a), [1n, 2n]);
      assert.deepEqual(seqsOf(b), [1n], 'a global SERIAL would have made this 3 and leaked the other family activity volume');
    } },

  { id: 'C15', title: 'RULE 2 — GAPLESS under concurrent appends from many devices', tags: ['seq', 'concurrency'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      const batches = [];
      for (let d = 0; d < 8; d++) {
        const rows = [];
        for (let i = 0; i < 3; i++) rows.push(fixtures.op(`d${d}op${i}`, { deviceShort: `SHORT${d}` }));
        batches.push(store.upsertOps(SP, rows));
      }
      const results = await Promise.all(batches);
      const all = sortBig(results.flatMap(seqsOf));
      assert.equal(all.length, 24);
      const expected = [];
      for (let i = 1n; i <= 24n; i++) expected.push(i);
      assert.deepEqual(all, expected, 'the assigned seqs must be exactly 1..24 — no gap, no duplicate');
      assert.equal(await store.headSeq(SP), 24n);
      for (const r of results) {
        const s = seqsOf(r);
        assert.equal(s[2] - s[0], 2n, 'one push batch must receive a CONTIGUOUS block');
      }
    } },

  { id: 'C16', title: 'RULE 2 — gapless under concurrent transactions that read then write', tags: ['seq', 'tx', 'concurrency'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      const work = [];
      for (let i = 0; i < 10; i++) {
        work.push(store.tx(async (t) => {
          const s = await t.getSpace(SP);
          assert.ok(s, 'the space is visible inside the transaction');
          const r = await t.upsertOps(SP, [fixtures.op(`tx${i}`)]);
          return r.inserted[0].seq;
        }));
      }
      const got = sortBig(await Promise.all(work));
      const expected = [];
      for (let i = 1n; i <= 10n; i++) expected.push(i);
      assert.deepEqual(got, expected, 'a lost update here is the silent data-loss bug ADR 003 §3.3 names');
    } },

  { id: 'C17', title: 'listOps is strictly greater-than the cursor, ascending, and paginates honestly', tags: ['seq', 'cursor'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      const rows = [];
      for (let i = 0; i < 7; i++) rows.push(fixtures.op(`op${i}`));
      await store.upsertOps(SP, rows);
      const first = await store.listOps(SP, 0n, 3);
      assert.deepEqual(first.ops.map((o) => o.seq), [1n, 2n, 3n]);
      assert.equal(first.hasMore, true);
      const second = await store.listOps(SP, 3n, 3);
      assert.deepEqual(second.ops.map((o) => o.seq), [4n, 5n, 6n]);
      assert.equal(second.hasMore, true);
      const third = await store.listOps(SP, 6n, 3);
      assert.deepEqual(third.ops.map((o) => o.seq), [7n]);
      assert.equal(third.hasMore, false);
      assert.deepEqual((await store.listOps(SP, 7n, 3)).ops, [], 'a caught-up cursor returns nothing');
    } },

  { id: 'C18', title: 'headSeq is 0 on an empty space — a cursor may start at 0', tags: ['seq', 'cursor'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      assert.equal(await store.headSeq(SP), 0n);
      assert.equal(await store.headSeq('fsp_nope'), 0n, 'an unknown space must not throw a cursor query');
    } },

  // ── idempotency ───────────────────────────────────────────────────────────
  { id: 'C19', title: 'upsertOps is idempotent on (spaceId, opId) and reports the EXISTING seq', tags: ['ops', 'idempotency'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      const a = await store.upsertOps(SP, [fixtures.op('op1'), fixtures.op('op2')]);
      assert.deepEqual(a.inserted.map((o) => o.opId), ['op1', 'op2']);
      assert.deepEqual(a.existing, []);
      const b = await store.upsertOps(SP, [fixtures.op('op1'), fixtures.op('op2')]);
      assert.deepEqual(b.inserted, [], 'a re-push inserts nothing');
      assert.deepEqual(b.existing.map((o) => o.seq), [1n, 2n], 'and reports the seq the ops already have');
    } },

  { id: 'C20', title: 'a re-push does NOT burn seq numbers', tags: ['ops', 'idempotency', 'seq'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      await store.upsertOps(SP, [fixtures.op('op1')]);
      for (let i = 0; i < 5; i++) await store.upsertOps(SP, [fixtures.op('op1')]);
      assert.equal((await store.getSpace(SP)).nextSeq, 1n, 'five retries must leave the counter alone');
      const r = await store.upsertOps(SP, [fixtures.op('op2')]);
      assert.equal(r.inserted[0].seq, 2n, 'the next genuine op is seq 2, not seq 7 — the cursor stays gapless');
    } },

  { id: 'C21', title: 'a mixed batch inserts only the new rows and gives them a contiguous block', tags: ['ops', 'idempotency'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      await store.upsertOps(SP, [fixtures.op('a'), fixtures.op('b')]);
      const r = await store.upsertOps(SP, [fixtures.op('a'), fixtures.op('c'), fixtures.op('b'), fixtures.op('d')]);
      assert.deepEqual(r.inserted.map((o) => o.opId), ['c', 'd']);
      assert.deepEqual(r.inserted.map((o) => o.seq), [3n, 4n]);
      assert.deepEqual(r.existing.map((o) => o.opId), ['a', 'b']);
      assert.deepEqual(r.existing.map((o) => o.seq), [1n, 2n]);
    } },

  { id: 'C22', title: 'the same opId in two different spaces is two different ops', tags: ['ops', 'idempotency'],
    run: async ({ makeStore, assert }) => {
      const store = await makeStore();
      await store.createSpace(fixtures.space({ id: SP }));
      await store.createSpace(fixtures.space({ id: SP2 }));
      const a = await store.upsertOps(SP, [fixtures.op('same')]);
      const b = await store.upsertOps(SP2, [fixtures.op('same')]);
      assert.equal(a.inserted.length, 1);
      assert.equal(b.inserted.length, 1, 'idempotency is scoped per space');
    } },

  { id: 'C23', title: 'a duplicate opId inside ONE batch is collapsed, not double-inserted', tags: ['ops', 'idempotency'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      const r = await store.upsertOps(SP, [fixtures.op('x'), fixtures.op('x')]);
      assert.equal(r.inserted.length + r.existing.length, 2, 'both entries are answered');
      assert.equal(r.inserted.length, 1, 'but only one row is stored');
      assert.equal((await store.getSpace(SP)).nextSeq, 1n);
    } },

  { id: 'C24', title: 'existingOpIds returns the stored rows so a fork can be detected', tags: ['ops'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      await store.upsertOps(SP, [fixtures.op('op1', { envelope: bytes(512, 40) })]);
      const found = await store.existingOpIds(SP, ['op1', 'op2']);
      assert.deepEqual(found.map((o) => o.opId), ['op1']);
      assert.equal(isBytes(found[0].envelope), true, '409 forked_op_id needs the stored bytes to compare');
      assert.deepEqual(await store.existingOpIds(SP2, ['op1']), [], 'scoped per space');
      assert.deepEqual(await store.existingOpIds(SP, []), []);
    } },

  { id: 'C25', title: 'deleteOpsByDevices purges exactly that device and leaves seq monotone', tags: ['ops', '20.2'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      await store.upsertOps(SP, [
        fixtures.op('a', { deviceShort: 'AAAA' }),
        fixtures.op('b', { deviceShort: 'BBBB' }),
        fixtures.op('c', { deviceShort: 'AAAA' }),
        fixtures.op('d', { deviceShort: 'BBBB' }),
      ]);
      const n = await store.deleteOpsByDevices(SP, ['AAAA']);
      assert.equal(n, 2);
      const left = await store.listOps(SP, 0n, 100);
      assert.deepEqual(left.ops.map((o) => o.opId), ['b', 'd']);
      assert.deepEqual(left.ops.map((o) => o.seq), [2n, 4n], 'a purge leaves holes; seq stays monotone and is never reused');
      assert.equal((await store.getSpace(SP)).nextSeq, 4n, 'the counter must NOT rewind — a rewind would re-issue a seq a peer cursor has already passed');
      assert.equal(await store.deleteOpsByDevices(SP, ['AAAA']), 0, 'purging twice is a no-op');
      assert.equal(await store.deleteOpsByDevices(SP, []), 0);
    } },

  // ── members and devices ───────────────────────────────────────────────────
  { id: 'C26', title: 'addMember / listMembers, and listMembers includes removed members', tags: ['members'],
    run: async ({ makeStore, assert, clock }) => {
      const store = await withSpace(makeStore);
      await store.addMember(fixtures.member({ id: 'mem_1', colorRef: 'gruen' }));
      await store.addMember(fixtures.member({ id: 'mem_2', colorRef: 'blau' }));
      await store.removeMember('mem_2', clock.now());
      const all = await store.listMembers(SP);
      assert.equal(all.length, 2, 'a removed member must still be listed — pull needs the device to member map to verify their old ops');
      const removed = all.find((m) => m.id === 'mem_2');
      assert.ok(removed.removedAt instanceof Date);
      assert.equal(all.find((m) => m.id === 'mem_1').removedAt, null);
    } },

  { id: 'C27', title: 'colorFree enforces 15.3 per space, and a taken colour is refused', tags: ['members', '15.3'],
    run: async ({ makeStore, assert }) => {
      const store = await makeStore();
      await store.createSpace(fixtures.space({ id: SP }));
      await store.createSpace(fixtures.space({ id: SP2 }));
      assert.equal(await store.colorFree(SP, 'gruen'), true);
      await store.addMember(fixtures.member({ id: 'mem_1', spaceId: SP, colorRef: 'gruen' }));
      assert.equal(await store.colorFree(SP, 'gruen'), false);
      assert.equal(await store.colorFree(SP2, 'gruen'), true, 'colours are scoped to one family');
      await threw(assert, () => store.addMember(fixtures.member({ id: 'mem_2', spaceId: SP, colorRef: 'gruen' })),
        'the unique constraint is the enforcement, not the colorFree read');
    } },

  { id: 'C28', title: 'removeMember is idempotent and does not move an existing removal time', tags: ['members'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      await store.addMember(fixtures.member({ id: 'mem_1' }));
      await store.removeMember('mem_1', 1000);
      await store.removeMember('mem_1', 5000);
      const m = (await store.listMembers(SP))[0];
      assert.equal(m.removedAt.getTime(), 1000, 'the first removal is the one that counts');
      await store.removeMember('mem_nope', 1000);
    } },

  { id: 'C29', title: 'devices: add, look up by id and by short, and refuse a duplicate short', tags: ['devices'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      await store.addMember(fixtures.member({ id: 'mem_1' }));
      await store.addDevice(fixtures.device({ id: 'dev_1', memberId: 'mem_1', deviceShort: 'SHORT1' }));
      assert.equal((await store.getDevice('dev_1')).deviceShort, 'SHORT1');
      assert.equal((await store.getDeviceByShort('SHORT1')).id, 'dev_1');
      assert.equal(await store.getDevice('dev_nope'), null);
      assert.equal(await store.getDeviceByShort('NOPE'), null);
      await threw(assert, () => store.addDevice(fixtures.device({ id: 'dev_2', memberId: 'mem_1', deviceShort: 'SHORT1' })),
        'deviceShort is globally unique — it is derived from the signing key (ADR 001 §1.2)');
    } },

  { id: 'C30', title: 'a revoked device is still readable — auth step 4 must be able to see it', tags: ['devices'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      await store.addMember(fixtures.member({ id: 'mem_1' }));
      await store.addDevice(fixtures.device({ id: 'dev_1', memberId: 'mem_1', deviceShort: 'SHORT1' }));
      await store.revokeDevice('dev_1', 4242);
      const d = await store.getDeviceByShort('SHORT1');
      assert.ok(d, 'a revoked device must not vanish, or auth would answer 401 bad_auth instead of 403 device_revoked');
      assert.equal(d.revokedAt.getTime(), 4242);
    } },

  { id: 'C31', title: 'listDevices enumerates every device of every member — the rotation coverage input', tags: ['devices', 'rotation'],
    run: async ({ makeStore, assert, clock }) => {
      const store = await withSpace(makeStore);
      await store.addMember(fixtures.member({ id: 'mem_1', colorRef: 'gruen' }));
      await store.addMember(fixtures.member({ id: 'mem_2', colorRef: 'blau' }));
      await store.addDevice(fixtures.device({ id: 'dev_1', memberId: 'mem_1', deviceShort: 'S1' }));
      await store.addDevice(fixtures.device({ id: 'dev_2', memberId: 'mem_1', deviceShort: 'S2' }));
      await store.addDevice(fixtures.device({ id: 'dev_3', memberId: 'mem_2', deviceShort: 'S3' }));
      await store.revokeDevice('dev_2', clock.now());
      const ds = await store.listDevices(SP);
      assert.deepEqual(ds.map((d) => d.id).sort(), ['dev_1', 'dev_2', 'dev_3']);
      const live = ds.filter((d) => d.revokedAt === null);
      assert.deepEqual(live.map((d) => d.id).sort(), ['dev_1', 'dev_3'],
        'ADR 002 §4.2: a rotation must wrap to every current non-revoked device of every non-removed member, and this is where the server learns who that is');
      assert.deepEqual(await store.listDevices(SP2), []);
    } },

  { id: 'C32', title: 'lastSeenSeq and lastPushedSeq are monotone and their minima FAIL CLOSED', tags: ['devices', 'gc'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      assert.equal(await store.minLastSeenSeq(SP), 0n, 'no devices at all must not read as "everything is collectable"');
      await store.addMember(fixtures.member({ id: 'mem_1' }));
      await store.addDevice(fixtures.device({ id: 'dev_1', memberId: 'mem_1', deviceShort: 'S1' }));
      await store.addDevice(fixtures.device({ id: 'dev_2', memberId: 'mem_1', deviceShort: 'S2' }));
      assert.equal(await store.minLastSeenSeq(SP), 0n, 'a device that never reported holds the minimum at 0');
      await store.setLastSeenSeq('S1', 50n);
      assert.equal(await store.minLastSeenSeq(SP), 0n, 'still 0 — S2 has reported nothing');
      await store.setLastSeenSeq('S2', 30n);
      assert.equal(await store.minLastSeenSeq(SP), 30n);
      await store.setLastSeenSeq('S1', 10n);
      assert.equal((await store.getDevice('dev_1')).lastSeenSeq, 50n, 'progress is monotone; a stale ack must not rewind it');
      await store.setLastPushedSeq('S1', 40n);
      await store.setLastPushedSeq('S2', 5n);
      assert.equal(await store.minLastPushedSeq(SP), 5n,
        'WRITE progress gates GC too: a device caught up on reads can still hold a three-week-old unpushed edit');
      await store.setLastSeenSeq('UNKNOWN', 999n);
      assert.equal(await store.minLastSeenSeq(SP), 30n);
    } },

  // ── key wraps ─────────────────────────────────────────────────────────────
  { id: 'C33', title: 'key wraps round-trip per recipient across ALL epochs (ADR 002 §4.4)', tags: ['keys'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      await store.putKeyWraps([
        { spaceId: SP, epoch: 1, recipientId: 'dev_1', wrapped: bytes(156, 21) },
        { spaceId: SP, epoch: 2, recipientId: 'dev_1', wrapped: bytes(156, 22) },
        { spaceId: SP, epoch: 2, recipientId: 'dev_2', wrapped: bytes(156, 23) },
      ]);
      const w = await store.getKeyWraps(SP, 'dev_1');
      assert.deepEqual(w.map((x) => x.epoch).sort(), [1, 2],
        'a member offline across three rotations needs every epoch spanning the ops they have not read');
      assert.equal((await store.getKeyWraps(SP, 'dev_2')).length, 1);
      assert.equal((await store.getKeyWraps(SP, 'dev_nope')).length, 0);
    } },

  { id: 'C34', title: 'putKeyWraps upserts on (spaceId, epoch, recipientId)', tags: ['keys'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      await store.putKeyWraps([{ spaceId: SP, epoch: 1, recipientId: 'dev_1', wrapped: bytes(156, 24) }]);
      await store.putKeyWraps([{ spaceId: SP, epoch: 1, recipientId: 'dev_1', wrapped: bytes(156, 25) }]);
      const w = await store.getKeyWraps(SP, 'dev_1');
      assert.equal(w.length, 1, 're-wrapping the same epoch to the same recipient replaces, it does not accumulate');
    } },

  { id: 'C35', title: 'a recovery recipient rec_<memberId> is storable — finding E3-4', tags: ['keys', 'E3-4'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      await store.addMember(fixtures.member({ id: 'mem_1' }));
      await store.putKeyWraps([{ spaceId: SP, epoch: 3, recipientId: 'rec_mem_1', wrapped: bytes(156, 26) }]);
      const w = await store.getKeyWraps(SP, 'rec_mem_1');
      assert.equal(w.length, 1,
        'ADR 002 §4.2 step 2 wraps to each member RK_kex as well as to each device; a foreign key onto Device would have made that unstorable');
    } },

  { id: 'C36', title: 'deleteKeyWrapsForDevices removes a recipient across every epoch', tags: ['keys', '20.2'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      await store.putKeyWraps([
        { spaceId: SP, epoch: 1, recipientId: 'dev_1', wrapped: bytes(156, 27) },
        { spaceId: SP, epoch: 2, recipientId: 'dev_1', wrapped: bytes(156, 28) },
        { spaceId: SP, epoch: 2, recipientId: 'dev_2', wrapped: bytes(156, 29) },
      ]);
      assert.equal(await store.deleteKeyWrapsForDevices(SP, ['dev_1']), 2,
        'ADR 002 §4.2 step 4: delete every KeyWrap of a removed or revoked device, for ALL epochs');
      assert.equal((await store.getKeyWraps(SP, 'dev_1')).length, 0);
      assert.equal((await store.getKeyWraps(SP, 'dev_2')).length, 1);
    } },

  // ── invites ───────────────────────────────────────────────────────────────
  { id: 'C37', title: 'consumeInvite is atomic single-use', tags: ['invites', '15.3'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      await store.putInvite(fixtures.invite({ id: 'inv_1' }));
      const first = await store.consumeInvite('inv_1', 1000);
      assert.ok(first, 'the first redemption wins');
      assert.equal(first.usedAt.getTime(), 1000);
      assert.equal(await store.consumeInvite('inv_1', 2000), null, 'the second is refused');
      assert.equal(await store.consumeInvite('inv_nope', 1000), null, 'an unknown invite is indistinguishable from a used one');
    } },

  { id: 'C38', title: 'exactly ONE of many concurrent redemptions may win', tags: ['invites', 'concurrency'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      await store.putInvite(fixtures.invite({ id: 'inv_1' }));
      const results = await Promise.all([0, 1, 2, 3, 4, 5].map(() => store.consumeInvite('inv_1', 1000)));
      assert.equal(results.filter(Boolean).length, 1,
        'a lost race here admits two members on one invite and the admin sees one name');
    } },

  { id: 'C39', title: 'a revoked or expired invite cannot be consumed', tags: ['invites', '15.5'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      await store.putInvite(fixtures.invite({ id: 'inv_r' }));
      await store.revokeInvite('inv_r', 500);
      assert.equal(await store.consumeInvite('inv_r', 1000), null, '15.5 — the admin may revoke at any time');
      await store.putInvite(fixtures.invite({ id: 'inv_e', expiresAt: new Date(900) }));
      assert.equal(await store.consumeInvite('inv_e', 1000), null, 'the 7-day TTL is enforced by the store, not by the caller');
      assert.ok(await store.consumeInvite('inv_e', 800), 'and only after it has actually expired');
    } },

  { id: 'C40', title: 'listOpenInvites is the rotation re-wrap list: not used, not revoked, not expired', tags: ['invites', 'rotation'],
    run: async ({ makeStore, assert, clock }) => {
      const store = await withSpace(makeStore);
      const t = clock.now();
      await store.putInvite(fixtures.invite({ id: 'inv_open', expiresAt: new Date(t + 86400000) }));
      await store.putInvite(fixtures.invite({ id: 'inv_used', expiresAt: new Date(t + 86400000) }));
      await store.putInvite(fixtures.invite({ id: 'inv_revd', expiresAt: new Date(t + 86400000) }));
      await store.putInvite(fixtures.invite({ id: 'inv_old', expiresAt: new Date(t - 1) }));
      await store.putInvite(fixtures.invite({ id: 'inv_other', spaceId: SP2, expiresAt: new Date(t + 86400000) }));
      await store.consumeInvite('inv_used', t);
      await store.revokeInvite('inv_revd', t);
      const open = await store.listOpenInvites(SP);
      assert.deepEqual(open.map((i) => i.id), ['inv_open'],
        'ADR 002 §4.2 step 3 — rotation must not silently invalidate a pending invite, and must not resurrect a dead one');
    } },

  { id: 'C41', title: 'refreshInvite moves the epoch and NOTHING else (D9)', tags: ['invites', 'D9'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      await store.putInvite(fixtures.invite({ id: 'inv_1', epoch: 1 }));
      const before = await store.getInvite('inv_1');
      await store.refreshInvite('inv_1', 4);
      const after = await store.getInvite('inv_1');
      assert.equal(after.epoch, 4);
      assert.deepEqual(after.verifier, before.verifier);
      assert.deepEqual(after.wrapSalt, before.wrapSalt);
      assert.equal(after.expiresAt.getTime(), before.expiresAt.getTime(),
        'a re-wrap on rotation must not silently extend the 7-day window');
    } },

  // ── pairing: the rid burn and the 5-attempt budget (ADR 002 §6.2) ─────────
  { id: 'C42', title: 'pair sessions patch-merge and expire on their own TTL', tags: ['pair'],
    run: async ({ makeStore, assert, clock }) => {
      const store = await withSpace(makeStore);
      await store.putPairSession('rid1', { boxA: bytes(200, 31) }, 180000);
      await store.putPairSession('rid1', { boxB: bytes(200, 32) }, 180000);
      const s = await store.getPairSession('rid1');
      assert.equal(isBytes(s.boxA), true);
      assert.equal(isBytes(s.boxB), true);
      assert.equal(s.delivery, null);
      assert.equal(s.attempts, 0);
      clock.advance(180001);
      assert.equal(await store.getPairSession('rid1'), null, 'ADR 002 §6.2 — the TTL is 180 s and it is the store that enforces it');
    } },

  { id: 'C43', title: 'THE 5-ATTEMPT BUDGET — bumpPairAttempts is atomic; concurrent bumps lose nothing', tags: ['pair', 'concurrency', 'E3'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      await store.putPairSession('rid1', { boxA: bytes(200, 33) }, 180000);
      const got = await Promise.all([0, 1, 2, 3, 4].map(() => store.bumpPairAttempts('rid1')));
      assert.deepEqual(got.sort((a, b) => a - b), [1, 2, 3, 4, 5],
        'a lost increment here turns a 5-guess budget into an unbounded one, and the pairing code is only 60 bits');
      assert.equal((await store.getPairSession('rid1')).attempts, 5);
    } },

  { id: 'C44', title: 'THE RID BURN — a burned rendezvous is gone and cannot be re-created', tags: ['pair', 'E3'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      await store.putPairSession('rid1', { boxA: bytes(200, 34) }, 180000);
      await store.burnPairSession('rid1');
      assert.equal(await store.getPairSession('rid1'), null);
      await store.putPairSession('rid1', { boxA: bytes(200, 35) }, 180000);
      assert.equal(await store.getPairSession('rid1'), null,
        'replaying pair/offer must NOT resurrect the rendezvous — a burn a later write can undo is not an attempt cap');
      await store.burnPairSession('rid1');
    } },

  { id: 'C45', title: 'bumpPairAttempts FAILS CLOSED on an unknown, expired or burned rid', tags: ['pair', 'E3'],
    run: async ({ makeStore, assert, clock }) => {
      const store = await withSpace(makeStore);
      assert.equal(await store.bumpPairAttempts('rid_unknown'), Number.MAX_SAFE_INTEGER,
        'a caller written as `if (n >= limits.pairAttempts) burn()` must fail closed with no special case');
      await store.putPairSession('rid_b', { boxA: bytes(8, 36) }, 180000);
      await store.burnPairSession('rid_b');
      assert.equal(await store.bumpPairAttempts('rid_b'), Number.MAX_SAFE_INTEGER);
      await store.putPairSession('rid_e', { boxA: bytes(8, 37) }, 1000);
      clock.advance(1001);
      assert.equal(await store.bumpPairAttempts('rid_e'), Number.MAX_SAFE_INTEGER);
    } },

  // ── nonces: the replay window (ADR 003 §2 step 3) ────────────────────────
  { id: 'C46', title: 'claimNonce is single-use per device and detects a replay', tags: ['auth'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      assert.equal(await store.claimNonce('S1', 'n1', 300000), true);
      assert.equal(await store.claimNonce('S1', 'n1', 300000), false, 'the same nonce twice is a replay');
      assert.equal(await store.claimNonce('S2', 'n1', 300000), true, 'the window is per device');
      assert.equal(await store.claimNonce('S1', 'n2', 300000), true);
    } },

  { id: 'C47', title: 'exactly ONE of many concurrent claims of the same nonce wins', tags: ['auth', 'concurrency'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      const got = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map(() => store.claimNonce('S1', 'n1', 300000)));
      assert.equal(got.filter(Boolean).length, 1, 'a lost race here is a replayable request');
    } },

  { id: 'C48', title: 'a nonce is claimable again once its TTL has passed', tags: ['auth'],
    run: async ({ makeStore, assert, clock }) => {
      const store = await withSpace(makeStore);
      assert.equal(await store.claimNonce('S1', 'n1', 300000), true);
      clock.advance(299999);
      assert.equal(await store.claimNonce('S1', 'n1', 300000), false, 'still inside the window');
      clock.advance(2);
      assert.equal(await store.claimNonce('S1', 'n1', 300000), true,
        'the 300 s replay window is bounded by the 120 s auth window, so re-use after expiry is safe and the table must not grow forever');
    } },

  // ── rate limits: the substrate for every limit in ADR 003 §6.1 ───────────
  { id: 'C49', title: 'rateAllow permits exactly `max` in a window, then denies', tags: ['limits', 'E3'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      const got = [];
      for (let i = 0; i < 6; i++) got.push(await store.rateAllow('redeem:1.2.3.4', 3600000, 4));
      assert.deepEqual(got, [true, true, true, true, false, false],
        'ADR 002 §7.1 / ADR 003 §6.1 — 10 invite redemptions per IP per hour; this is the mechanism that makes that a number rather than a sentence');
    } },

  { id: 'C50', title: 'rate windows roll, and keys are independent', tags: ['limits'],
    run: async ({ makeStore, assert, clock }) => {
      const store = await withSpace(makeStore);
      assert.equal(await store.rateAllow('k1', 60000, 1), true);
      assert.equal(await store.rateAllow('k1', 60000, 1), false);
      assert.equal(await store.rateAllow('k2', 60000, 1), true, 'a second key has its own budget');
      clock.advance(60001);
      assert.equal(await store.rateAllow('k1', 60000, 1), true, 'the window rolled');
    } },

  { id: 'C51', title: 'concurrent rateAllow admits exactly `max` — no burst slips through', tags: ['limits', 'concurrency', 'E3'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      const calls = [];
      for (let i = 0; i < 25; i++) calls.push(store.rateAllow('push:dev1', 60000, 10));
      const got = await Promise.all(calls);
      assert.equal(got.filter(Boolean).length, 10,
        'a limiter that is only correct when requests arrive one at a time is not a limiter');
    } },

  { id: 'C52', title: 'rateAllow with max 0 denies everything', tags: ['limits'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      assert.equal(await store.rateAllow('k', 60000, 0), false);
    } },

  // ── transactions ──────────────────────────────────────────────────────────
  { id: 'C53', title: 'tx returns the callback value and commits its writes', tags: ['tx'],
    run: async ({ makeStore, assert }) => {
      const store = await makeStore();
      const out = await store.tx(async (t) => {
        await t.createSpace(fixtures.space({ id: SP }));
        await t.upsertOps(SP, [fixtures.op('a')]);
        return 'done';
      });
      assert.equal(out, 'done');
      assert.ok(await store.getSpace(SP));
      assert.equal(await store.headSeq(SP), 1n);
    } },

  { id: 'C54', title: 'tx ROLLS BACK every mutation on a throw — including the seq counter', tags: ['tx'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      await store.upsertOps(SP, [fixtures.op('a')]);
      await threw(assert, () => store.tx(async (t) => {
        await t.upsertOps(SP, [fixtures.op('b'), fixtures.op('c')]);
        await t.addMember(fixtures.member({ id: 'mem_x' }));
        await t.putKeyWraps([{ spaceId: SP, epoch: 1, recipientId: 'dev_x', wrapped: bytes(16, 41) }]);
        throw new Error('handler failed after writing');
      }), 'the transaction must re-throw');
      assert.equal((await store.listOps(SP, 0n, 100)).ops.length, 1, 'the ops rolled back');
      assert.equal((await store.listMembers(SP)).length, 0, 'the member rolled back');
      assert.equal((await store.getKeyWraps(SP, 'dev_x')).length, 0, 'the wrap rolled back');
      assert.equal((await store.getSpace(SP)).nextSeq, 1n,
        'and the counter rolled back — ADR 002 §4.2 needs the whole rotation to be one transaction, wraps and epoch together');
    } },

  { id: 'C55', title: 'the store is fully usable after a rollback', tags: ['tx'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      await threw(assert, () => store.tx(async (t) => { await t.upsertOps(SP, [fixtures.op('a')]); throw new Error('x'); }), 'rollback');
      const r = await store.upsertOps(SP, [fixtures.op('a')]);
      assert.equal(r.inserted[0].seq, 1n, 'a rolled-back op did not consume its opId or its seq');
    } },

  { id: 'C56', title: 'tx nests re-entrantly on the same transaction and never deadlocks', tags: ['tx'],
    run: async ({ makeStore, assert }) => {
      const store = await makeStore();
      await store.tx(async (t) => {
        await t.createSpace(fixtures.space({ id: SP }));
        await t.tx(async (inner) => { await inner.upsertOps(SP, [fixtures.op('a')]); });
      });
      assert.equal(await store.headSeq(SP), 1n);
      await threw(assert, () => store.tx(async (t) => {
        await t.upsertOps(SP, [fixtures.op('b')]);
        await t.tx(async () => { throw new Error('inner'); });
      }), 'a throw in a nested tx aborts the whole transaction');
      assert.equal(await store.headSeq(SP), 1n, 'the outer writes rolled back with it');
    } },

  { id: 'C57', title: 'transactions serialise: a rotation cannot interleave with another', tags: ['tx', 'rotation', 'concurrency'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      const winners = await Promise.all([2, 2, 2, 3].map((epoch) => store.tx(async (t) => {
        const claimed = await t.claimEpoch(SP, epoch);
        if (!claimed) return null;
        await t.setCurrentEpoch(SP, epoch);
        await t.putKeyWraps([{ spaceId: SP, epoch, recipientId: 'dev_1', wrapped: bytes(156, epoch) }]);
        return epoch;
      })));
      assert.equal(winners.filter((w) => w === 2).length, 1, 'first writer wins the epoch (409 epoch_taken for the rest)');
      assert.equal((await store.getKeyWraps(SP, 'dev_1')).length, 2, 'epochs 2 and 3 each landed exactly once');
    } },

  { id: 'C58', title: 'a failed transaction leaves no partial rate-limit or nonce state', tags: ['tx', 'limits'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      await threw(assert, () => store.tx(async (t) => {
        await t.rateAllow('k', 60000, 1);
        await t.claimNonce('S1', 'n1', 300000);
        throw new Error('x');
      }), 'rollback');
      assert.equal(await store.rateAllow('k', 60000, 1), true, 'the rolled-back call did not consume the budget');
      assert.equal(await store.claimNonce('S1', 'n1', 300000), true, 'nor the nonce');
    } },

  // ── durability of the shapes handlers depend on ──────────────────────────
  { id: 'C59', title: 'bigint columns stay bigint and Date columns stay Date across a round trip', tags: ['shape'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      await store.addMember(fixtures.member({ id: 'mem_1' }));
      await store.addDevice(fixtures.device({ id: 'dev_1', memberId: 'mem_1', deviceShort: 'S1', lastSeenSeq: 12n }));
      await store.upsertOps(SP, [fixtures.op('a')]);
      const s = await store.getSpace(SP);
      const d = await store.getDevice('dev_1');
      const o = (await store.listOps(SP, 0n, 10)).ops[0];
      assert.equal(typeof s.nextSeq, 'bigint');
      assert.equal(typeof d.lastSeenSeq, 'bigint');
      assert.equal(typeof d.lastPushedSeq, 'bigint');
      assert.equal(typeof o.seq, 'bigint');
      assert.ok(s.createdAt instanceof Date);
      assert.ok(o.receivedAt instanceof Date);
      assert.equal(isBytes(o.envelope), true, 'the envelope comes back as bytes, never as a string');
    } },

  { id: 'C60', title: 'a row handed back is a copy — mutating it cannot corrupt the store', tags: ['shape'],
    run: async ({ makeStore, assert }) => {
      const store = await withSpace(makeStore);
      const s1 = await store.getSpace(SP);
      s1.currentEpoch = 99;
      s1.kind = 'PERSONAL';
      const s2 = await store.getSpace(SP);
      assert.equal(s2.currentEpoch, 1, 'a handler that edits a returned row must not be writing to the database');
      assert.equal(s2.kind, 'FAMILY');
    } },
]);

