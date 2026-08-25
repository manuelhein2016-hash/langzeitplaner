// docs/v2/contracts/ops.contract.js
//
// INTERFACE CONTRACT — op-log core. Normative for ADR 001 and ADR 004.
// This file is signatures + JSDoc only. Implementations live in src/js/core/.
// Every function here MUST be implementable with no DOM, no I/O, no wall clock
// and no Math.random (ADR 005 §2).
//
// Downstream implementers: satisfy these signatures exactly. If a signature is
// wrong, change it HERE first (with a note in the ADR), not silently at the
// call site.

/* eslint-disable no-unused-vars */

// ─────────────────────────────────────────────────────────────────────────────
// 1. Identity and stamps  (ADR 001 §1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 37 chars, fixed width, so a plain string `<` is a strict total order:
 *   pad13(wallMillis) '.' pad6(counter) '.' deviceShort16
 * Example: "1787836800123.000003.7QAR2MZ9XKPNC0GV"
 * @typedef {string} Stamp
 */

/** 22-char base64url of 128 CSPRNG bits. NO time component. @typedef {string} OpId */
/** 22-char base64url of 128 CSPRNG bits, device-local only. @typedef {string} GroupId */
/** "mem_" + 22 b64url. @typedef {string} MemberId */
/** "dev_" + 22 b64url. @typedef {string} DeviceId */
/** 16 Crockford base32 chars = crock32(SHA-256(rawSigPub)[0..10]). @typedef {string} DeviceShort */
/** "psp_"|"fsp_" + 22 b64url. @typedef {string} SpaceId */
/** 'local' | SpaceId. @typedef {string} SpaceRef */

/**
 * note:<uuid> | bar:<uuid> | cat:<uuid> | pad:<YYYY-MM> | pref:app
 * | fnote:<MemberId>/<uuid> | fbar:<MemberId>/<uuid>
 * | member:<MemberId> | space:<SpaceId>
 * @typedef {string} EntityKey
 */

/** @typedef {'note'|'bar'|'cat'|'pad'|'pref'|'fnote'|'fbar'|'member'|'space'} EntityKind */
/** @typedef {'note.set'|'bar.set'|'cat.set'|'pad.set'|'pref.set'|'pub.set'|'member.set'|'space.set'} OpKind */
/** @typedef {'privat'|'belegt'|'geteilt'} Visibility */

/** Ops further in the future than this are PARKED, never dropped. ADR 001 §1.3. */
export const MAX_FUTURE_DRIFT_MS = 24 * 60 * 60 * 1000;

/** @type {Stamp} A stamp that sorts below every real stamp; index-carrying. ADR 001 §8.1. */
export function GENESIS(index) { throw new Error('not implemented'); }

/** @typedef {{ ms:number, ctr:number }} ClockState */

/**
 * @typedef {Object} Clock
 * @property {() => Stamp}        tick     mint a stamp for a locally authored write (mutates)
 * @property {(s:Stamp) => void}  observe  absorb a received stamp; NEVER rewrites `s`
 * @property {() => Stamp}        peek
 * @property {() => number}       skew     ms difference vs the last server time seen
 * @property {() => ClockState}   save
 */

/**
 * @param {DeviceShort} deviceShort
 * @param {() => number} now  injected; no module may call Date.now() directly
 * @returns {Clock}
 */
export function createClock(deviceShort, now) { throw new Error('not implemented'); }

/** @param {number} ms @param {number} ctr @param {DeviceShort} dev @returns {Stamp} */
export function fmt(ms, ctr, dev) { throw new Error('not implemented'); }

/** Strict total order on stamps. @param {Stamp} a @param {Stamp} b @returns {-1|0|1} */
export function cmp(a, b) { throw new Error('not implemented'); }

/** @param {Stamp} s @returns {number} */ export function msOf(s) { throw new Error('not implemented'); }
/** @param {Stamp} s @returns {number} */ export function ctrOf(s) { throw new Error('not implemented'); }
/** @param {Stamp} s @returns {DeviceShort} */ export function devOf(s) { throw new Error('not implemented'); }

/** @returns {string} v1-compatible crypto.randomUUID(). Entity ids are NEVER re-keyed. */
export function entityUuid() { throw new Error('not implemented'); }
/** @returns {OpId} */    export function opId() { throw new Error('not implemented'); }
/** @returns {GroupId} */ export function groupId() { throw new Error('not implemented'); }
/** @param {Uint8Array} rawSigPub @returns {DeviceShort} */
export function deviceShortOf(rawSigPub) { throw new Error('not implemented'); }

// ─────────────────────────────────────────────────────────────────────────────
// 2. The op  (ADR 001 §2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Op
 * @property {1}        v
 * @property {OpId}     id    unique; the server idempotency key
 * @property {Stamp}    ts    the LWW stamp for EVERY field in `f`
 * @property {SpaceRef} space
 * @property {MemberId} act   the acting human — rendered as "von Mama" (17.6); authenticated
 * @property {DeviceId} dev
 * @property {GroupId}  gid   transaction group; the unit of undo; NO effect on merge
 * @property {OpKind}   k
 * @property {EntityKey} e
 * @property {Object<string, string|number|boolean|null>} f
 *           field patch. JSON SCALARS OR null ONLY — no nested objects, no arrays.
 *           `null` means "clear this register" and is a first-class value (ADR 004 §5.1).
 */

/**
 * The one field table. Every downstream agent reads it; nobody invents a field.
 * Shape: FIELDS[EntityKind][fieldName] = FieldSpec
 * @typedef {Object} FieldSpec
 * @property {'date'|'str'|'str40'|'str80'|'id'|'bool'|'int'|'enum'|'stamp'|'opId'|'any'} t
 * @property {string[]} [values]     for t === 'enum'
 * @property {boolean}  [coEdit]     may a co-editor write it? (ADR 001 §4.3 stage 3b)
 * @property {boolean}  [gov]        governing field — owner/admin only (stage 3a)
 * @property {boolean}  [writeOnce]
 * @property {boolean}  [geteiltOnly]
 * @type {Object<EntityKind, Object<string, FieldSpec>>}
 */
export const FIELDS = /** @type {any} */ (null);

/** @param {EntityKey} e @returns {EntityKind} */
export function kindOfEntity(e) { throw new Error('not implemented'); }
/** @param {EntityKey} e @returns {MemberId|null} owner segment of a family key, else null */
export function ownerOfEntity(e) { throw new Error('not implemented'); }
/** @param {MemberId} owner @param {string} uuid @returns {EntityKey} */
export function familyKey(kind, owner, uuid) { throw new Error('not implemented'); }

/**
 * Validate an op's shape: kind/entity agreement, scalar-only `f`, known field names,
 * declared types, reserved-name rules, `YYYY-MM-DD` on every date field.
 * @param {Op} op
 * @returns {{ ok: true } | { ok: false, reason: string, park: boolean }}
 *          `park: true` for an unknown kind or unknown field name (forward compat, ADR 001 §7.4);
 *          `park: false` for a type violation, which is a protocol violation.
 */
export function validateOp(op) { throw new Error('not implemented'); }

// ─────────────────────────────────────────────────────────────────────────────
// 3. Registers and the merge  (ADR 001 §6)
// ─────────────────────────────────────────────────────────────────────────────

/** @typedef {{ value: any, stamp: Stamp, author: MemberId }} Register */
/** @typedef {Map<EntityKey, Map<string, Register>>} RegisterMap */

/** @returns {RegisterMap} */
export function emptyRegisters() { throw new Error('not implemented'); }

/**
 * Fold ONE op. Idempotent, commutative, associative. Assumes `op` was already admitted
 * by foldAuthorized — applyOp itself performs no authorization.
 * @param {RegisterMap} regs @param {Op} op
 * @returns {boolean} true iff any register actually changed (drives re-render and 17.5)
 */
export function applyOp(regs, op) { throw new Error('not implemented'); }

/** @param {RegisterMap} regs @param {Iterable<Op>} ops @returns {RegisterMap} */
export function foldAll(regs, ops) { throw new Error('not implemented'); }

/** Field-wise max — used to fold a checkpoint with a tail. @returns {RegisterMap} */
export function mergeMaps(a, b) { throw new Error('not implemented'); }

/** @param {RegisterMap} regs @returns {Object} JSON-safe; retains value+stamp+author */
export function serializeRegisters(regs) { throw new Error('not implemented'); }
/** @param {Object} blob @returns {RegisterMap} */
export function deserializeRegisters(blob) { throw new Error('not implemented'); }

// ─────────────────────────────────────────────────────────────────────────────
// 4. Authorization — the staged fold  (ADR 001 §4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} AuthzResult
 * @property {RegisterMap} regs
 * @property {MemberId|null} admin              chain-resolved current admin
 * @property {(at:Stamp) => MemberId|null} adminAt
 * @property {Set<MemberId>} currentMembers
 * @property {Op[]} rejected                    dropped: failed admissibility
 * @property {Op[]} parked                      retained: future stamp / unknown epoch / unknown kind
 */

/**
 * The ONLY entry point that turns a set of ops into state. Stages:
 *   0 device attestation · 1 the in-log admin chain · 2 membership
 *   3a governing pub fields (owner/admin only) · 3b content (co-edit predicate)
 * Every stage is a fold over the same immutable set, reading only earlier stages' FINAL values,
 * so the result is a function of the SET, not of the enumeration (property P5).
 *
 * NOTE: it never consults a server role column. The admin is resolved from
 * `space.set{admin, adminPrev}` ops alone (ADR 001 §4.1).
 *
 * @param {Iterable<Op>} ops
 * @param {{ me: MemberId, nowMs: number, attestVerify: (memberId:MemberId, blob:string) => boolean }} ctx
 * @returns {AuthzResult}
 */
export function foldAuthorized(ops, ctx) { throw new Error('not implemented'); }

// ─────────────────────────────────────────────────────────────────────────────
// 5. Materialization  (ADR 001 §5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} MaterializeCtx
 * @property {MemberId} me
 * @property {Map<MemberId, {displayName:string, colorRef:string, initial:string}>} members
 * @property {Set<MemberId>} currentMembers
 * @property {SpaceId|null} familySpaceId       null in solo mode
 * @property {Set<MemberId>} hiddenMembers      device-local pref (17.3)
 * @property {Object} prefs                     the local `pref:app` registers
 * @property {Object<SpaceRef, string>} lastSeenSeq  device-local (17.5)
 * @property {(e:EntityKey) => Visibility|null} lastAckedPubLevel   16.6, see ADR 004 §6
 */

/**
 * The contract: for a SOLO board the output is deep-equal to v1's `store.state`.
 * Sorts are mandatory, not cosmetic (ADR 001 §5 step 5).
 * @param {RegisterMap} regs @param {MaterializeCtx} ctx
 * @returns {{schemaVersion:2, notes:Object[], bars:Object[], categories:Object[],
 *            scratchpads:Object<string,string>, settings:Object}}
 */
export function materialize(regs, ctx) { throw new Error('not implemented'); }

/** createdAt = min stamp over an entity's registers. @returns {Stamp|null} */
export function createdAt(regs, e) { throw new Error('not implemented'); }
/** updatedAt = max stamp. @returns {Stamp|null} */
export function updatedAt(regs, e) { throw new Error('not implemented'); }

// The shared day-selector (ADR 005 §3). layout.js AND popover.js must both call these.
/** @returns {Object[]} note occurrences on `date`, own + family, already filtered/decorated */
export function notesOnDate(state, date, ctx) { throw new Error('not implemented'); }
/** @returns {Object[]} */
export function barsOnDate(state, date, ctx) { throw new Error('not implemented'); }

// ─────────────────────────────────────────────────────────────────────────────
// 6. Redaction / publication  (ADR 004 §2)  — THE SECURITY BOUNDARY
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Readonly<{fnote:string[], fbar:string[]}>} */
export const GETEILT_FIELDS = /** @type {any} */ (null);
/** @type {Readonly<{fnote:string[], fbar:string[]}>} */
export const BELEGT_FIELDS = /** @type {any} */ (null);

export class RedactionError extends Error {}

/**
 * The ONLY function permitted to turn a local entry into something that leaves the device.
 * Builds a NEW object additively from a frozen allowlist. Never `delete p.text`, never
 * `{...entry, text: undefined}` — both are one refactor away from publishing a field somebody
 * adds to Note next year.
 *
 * The returned object carries a non-enumerable brand; `sealOp` refuses an unbranded family patch.
 *
 * @param {'fnote'|'fbar'} kind
 * @param {Object} truth            the entity's materialized truth fields
 * @param {Visibility} level
 * @param {Visibility|null} lastPublished
 * @returns {Object|null}           null == nothing to publish (privat, never published)
 */
export function projectForFamily(kind, truth, level, lastPublished) { throw new Error('not implemented'); }

/**
 * Every field the level withdraws, EXPLICITLY null, plus pub.level:'privat' and pub.alive:false.
 * Omission is not withdrawal — see ADR 004 §5.1, the bug no owner-side smoke test would catch.
 * @param {'fnote'|'fbar'} kind @returns {Object}
 */
export function retractPatch(kind) { throw new Error('not implemented'); }

/**
 * Defence in depth. Throws RedactionError. `level` MUST be re-derived by the caller from the
 * authenticated register map, never taken from an argument the same caller supplied to
 * projectForFamily (ADR 004 §2.2 barrier 4).
 * @param {Object} patch @param {'fnote'|'fbar'} kind @param {Visibility} level
 * @returns {void}
 */
export function assertFamilyPatch(patch, kind, level) { throw new Error('not implemented'); }

/**
 * Derive the family-space ops for one transaction. PURE.
 * @param {Op[]} localOps      the ops just applied to the personal space
 * @param {RegisterMap} regs   post-apply
 * @param {{ me: MemberId, familySpaceId: SpaceId|null, mint: () => Stamp,
 *           lastPublished: (e:EntityKey) => Visibility|null }} ctx
 * @returns {Op[]}             `pub.set` ops; empty when solo or when nothing is published
 */
export function derivePublication(localOps, regs, ctx) { throw new Error('not implemented'); }

// ─────────────────────────────────────────────────────────────────────────────
// 7. Undo  (ADR 001 §7.1)
// ─────────────────────────────────────────────────────────────────────────────

/** @typedef {{ gid:GroupId, label:string,
 *              pre:Array<[EntityKey, string, any]>, post:Array<[EntityKey, string, any]> }} UndoEntry */

/**
 * @typedef {Object} UndoStacks
 * @property {(gid:GroupId, label:string, pre:any[], post:any[]) => void} push  local txns ONLY
 * @property {() => Op[]} undo   fresh ops (new opIds, new stamps) restoring `pre`
 * @property {() => Op[]} redo   fresh ops restoring `post`
 * @property {() => boolean} canUndo
 * @property {() => boolean} canRedo
 * @property {() => void} clear  import / snapshot restore (story 5.4)
 */
/** @param {{ limitGroups:number, mint:() => Stamp }} cfg @returns {UndoStacks} */
export function createUndoStacks(cfg) { throw new Error('not implemented'); }

/**
 * @typedef {Object} Tx   the builder handed to store.txn(label, fn)
 * @property {GroupId} gid
 * @property {(kind:'note'|'bar'|'cat'|'pad', id:string) => Object|undefined} get  read current values
 * @property {Object} state                          read-only view, for existing branching
 * @property {(id:string) => {set:(patch:Object)=>void, create:(f:Object)=>void, del:()=>void}} note
 * @property {(id:string) => {set:(patch:Object)=>void, create:(f:Object)=>void, del:()=>void}} bar
 * @property {(id:string) => {set:(patch:Object)=>void, create:(f:Object)=>void, del:()=>void}} cat
 * @property {(month:string) => {set:(patch:Object)=>void, del:()=>void}} pad
 * @property {(patch:Object) => void} pref            LOCAL space; no gid; never undone (B5)
 * @property {(catId:string) => void} ensureVisible   story 4.6, inside the same group
 * @property {Op[]} ops
 */

// ─────────────────────────────────────────────────────────────────────────────
// 8. Op log, checkpoint, parking  (ADR 001 §7.2–§7.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} OpLog
 * @property {(op:Op) => void} append
 * @property {(q:{space?:SpaceRef, sinceStamp?:Stamp}) => Iterable<Op>} ops
 * @property {() => {horizon:Stamp, regs:Object, cursors:Object, at:number}} checkpoint
 * @property {() => number} compact          fold ops <= horizon into the checkpoint; → dropped count
 * @property {(o:{checkpoint:Object, tail:Op[]}) => RegisterMap} load
 * @property {(op:Op, reason:'future'|'epoch'|'unknownKind'|'unknownField') => void} park
 * @property {(pred:(op:Op)=>boolean) => Op[]} unpark
 * @property {(e:EntityKey, space:SpaceRef) => number} forget
 *           the ADR 004 §5.3 forget pass: purge this entity's lines for that space
 */
/** @param {{ storage: any }} ports @returns {OpLog} */
export function createOpLog(ports) { throw new Error('not implemented'); }

/**
 * An entity may be dropped from a checkpoint ONLY when all three hold. This is the single rule
 * whose violation causes incorrect behaviour (ADR 001 §7.3). Do not "optimize" condition 3 away.
 * @param {RegisterMap} regs @param {EntityKey} e
 * @param {{ nowMs:number, minDeviceSeq:bigint, seqOf:(s:Stamp)=>bigint }} ctx
 * @returns {boolean}
 */
export function tombstoneCollectable(regs, e, ctx) { throw new Error('not implemented'); }

// ─────────────────────────────────────────────────────────────────────────────
// 9. Migration  (ADR 001 §8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * v1 board.json → v2 ops. PURE. Stamps are GENESIS(i) with ONE global counter running
 * categories → notes → bars → scratchpads, so (a) everything pre-existing loses to every future
 * edit and (b) two independent migrations of the same file are BYTE-IDENTICAL — which is what
 * makes pairing two already-migrated Macs converge with no spurious conflicts.
 *
 * AC (property P8):
 *   materialize(foldAuthorized(migrateV1(b).ops)) deep-equals stripV2Fields(v1migrate(b))
 * including array order after the deterministic sort.
 *
 * @param {Object} v1board  parsed board.json (already through v1's own migrate())
 * @param {{ memberId: MemberId, deviceId: DeviceId, deviceShort: DeviceShort }} ctx
 * @returns {{ ops: Op[], warnings: string[] }}
 */
export function migrateV1(v1board, ctx) { throw new Error('not implemented'); }

/**
 * Import (11.3) and snapshot restore (11.5). NOT a `board.reset` op — that primitive has no fold
 * rule and is rejected (ADR 001 §8.5). Emits per-field restoring writes at FRESH stamps plus
 * `_alive:false` for entities absent from the import. Personal + local spaces ONLY; the publisher
 * re-derives family ops afterwards.
 * @param {RegisterMap} regs @param {Object} incoming @param {{ mint:() => Stamp, me:MemberId,
 *          personalSpaceId:SpaceId|null, deviceId:DeviceId }} ctx
 * @returns {Op[]}
 */
export function replaceAllOps(regs, incoming, ctx) { throw new Error('not implemented'); }
