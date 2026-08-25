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
//
// ─── WP-1 RECONCILIATION (2026-08-25) ────────────────────────────────────────
// The six machinery packages were built in parallel against this file and were
// forbidden from editing each other's sources; each reported the changes it
// needed instead. Those changes are now applied here, so this file describes
// what src/js/core/ ACTUALLY implements. Every one is ADDITIVE — no existing
// name, signature or meaning changed — and each is marked `[WP-1]` with the
// reason it could not be avoided. Where a change reflects a genuine gap or
// contradiction in ADR 001/004 rather than an oversight here, it says so.

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
 * @property {boolean}  [writeOnce]  [WP-1] ADMISSIBILITY, not merge. Enforced on the way IN, by
 *                                   `authz.js`, never by the join (which is unconditional
 *                                   max-by-`≺`, ADR 001 §12.2). `member['dev.*']` IS enforced —
 *                                   only the minimal write under `≺` is admissible, because a
 *                                   second one is the ADR 002 §2.3 key-injection hole. `_born` is
 *                                   deliberately NOT enforced: it rides inside ops that also carry
 *                                   content, so rejecting the op would drop a legitimate write and
 *                                   stripping the field would make ops non-atomic. Its exposure is
 *                                   nil — `createdAt` is min over ALL an entity's stamps, so it
 *                                   does not move when the `_born` register does. ADR 001 §3.1
 *                                   should say the flag is an admissibility attribute.
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

/**
 * @typedef {Object} Register
 * @property {any}      value
 * @property {Stamp}    stamp
 * @property {MemberId} author  the acting MEMBER (`op.act`), never the device — so a retraction
 *                              published from my laptop is not promoted on my desktop either.
 * @property {OpId}     op      [WP-1] the winning write's opId, RETAINED. ADR 001 §6 step 1 makes
 *                              the opId the final tiebreak, but once a checkpoint has collapsed
 *                              ops into registers there is no op left to read it from, so
 *                              `mergeMaps` could not break a stamp tie and two devices could
 *                              disagree. `deserializeRegisters` accepts its absence (as '') so an
 *                              older or hand-built checkpoint still orders totally.
 */
/** @typedef {Map<EntityKey, Map<string, Register>>} RegisterMap */

/** @returns {RegisterMap} */
export function emptyRegisters() { throw new Error('not implemented'); }

/**
 * Fold ONE op. Idempotent, commutative, associative. Assumes `op` was already admitted
 * by foldAuthorized — applyOp itself performs no authorization.
 *
 * [WP-1] The join is UNCONDITIONAL max-by-`≺` on every field, `_born` included (ADR 001 §12.2,
 * "no exceptions, no per-kind special cases"). `FieldSpec.writeOnce` is therefore an
 * ADMISSIBILITY attribute and NOT a merge attribute — "the register refuses a second write" is
 * not commutative, so it cannot live here. See the note on `FieldSpec.writeOnce`.
 *
 * [WP-1] "changed" means the register was REPLACED, not that its value differs. A newer write
 * carrying an identical value returns `true`, because `updatedAt`/`updatedBy` — story 17.6's
 * „geändert So." line — move with it.
 *
 * @param {RegisterMap} regs @param {Op} op
 * @returns {boolean} true iff any register actually changed (drives re-render and 17.5)
 */
export function applyOp(regs, op) { throw new Error('not implemented'); }

/** @param {RegisterMap} regs @param {Iterable<Op>} ops @returns {RegisterMap} */
export function foldAll(regs, ops) { throw new Error('not implemented'); }

/** Field-wise max — used to fold a checkpoint with a tail. @returns {RegisterMap} */
export function mergeMaps(a, b) { throw new Error('not implemented'); }

/**
 * [WP-1] THE PROMOTION, and the one place ADR 001 §5 step 2 / ADR 004 §4.1 needed a qualifier.
 *
 *     effective[f] = maxByStamp( truth[f], pub[f] where pub[f].author !== me )
 *
 * lives in `registers.js` and NOWHERE ELSE — `materialize.js` calls it rather than carrying a
 * second copy, because ADR 004 §4.1 calls it "the correctness heart" and only one copy can be the
 * one P7c is pointed at.
 *
 * @param {Register|undefined} truthReg @param {Register|undefined} pubReg @param {MemberId} me
 * @returns {Register|undefined}
 */
export function promoteRegister(truthReg, pubReg, me) { throw new Error('not implemented'); }

/**
 * [WP-1] THE QUALIFIER §5 step 2 is missing, and it resolves a real contradiction between two
 * normative passages.
 *
 * ADR 004 §5's transition table says an ADMIN UNSHARE (story 18.3) is
 * `pub.set{'pub.level':'privat', …all content → null}` and that "the owner's truth is untouched".
 * INV-R3 restates it: "a redaction can never make my own board lie to me". But that op carries
 * `author === admin ≠ me` at a newer stamp, so the formula above promotes its `pub.text: null`
 * onto my truth and materialization step 1 skips `null` — MY OWN NOTE GOES BLANK. Both passages
 * cannot hold.
 *
 * Resolved WITHOUT a blanket "never promote null", which would break story 18.2 / risk R9 (a
 * co-editor clearing my text with an explicit `null` must reach my truth). `pub.level` is
 * `gov: true`, so stage 3a admits it from the owner or the admin alone and a co-editor physically
 * cannot write it; an unshare is one op, so its level and its content nulls share a stamp and an
 * author. Therefore a `pub.level` of `'privat'` (or `pub.alive: false`) under an author who is
 * not me IS an admin unshare, and in that state promotion is skipped entirely.
 *
 * @param {Map<string, Register>|undefined} famCells @param {MemberId} me @returns {boolean}
 */
export function withdrawnByOther(famCells, me) { throw new Error('not implemented'); }

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
 *
 * [WP-1] additive, all derived from the same immutable set so they stay functions of it:
 * @property {Op[]} admitted
 * @property {(id:OpId) => {stage:string, reason:string}|null} rejectionOf
 * @property {(id:OpId) => string|null} parkReasonOf
 * @property {(sid:SpaceId) => MemberId|null} adminOfSpace
 * @property {(sid:SpaceId, at:Stamp) => MemberId|null} adminAtInSpace
 * @property {(sid:SpaceId) => Op[]} adminChainOf
 * @property {Set<DeviceShort>} attestedDevices
 * @property {(devId:DeviceId) => MemberId|null} memberOfDevice
 * @property {OpId[]} splicedIds                two different bodies under one opId; one is
 *                                              admitted by canonical form so every device agrees
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
 * [WP-1] `attestVerify` ALONE IS NOT SUFFICIENT and this is an ADR gap, not an oversight here.
 * ADR 001 §1.2 defines `deviceShort` as a hash of the SIGNING KEY, while §4.0 and ADR 002 §5.2
 * write `deviceShort(op.dev)` — and `op.dev` has no derivational relationship to that key. The
 * only consistent reading is a LOOKUP: the `member:<M> → dev.<short>` attestation registers are
 * the table, and resolving `op.dev` means DECODING the attestation blob to read `att.deviceId`.
 * The fold therefore needs the payload, not just a boolean. §4.0 and ADR 002 §5.2 should say
 * "lookup"; a cleaner contract would be `attestOpen(memberId, blob) => DeviceAttestation|null`.
 * `attestVerify` FAILS CLOSED when absent: no family op is admitted.
 *
 * [WP-1] Stage 0 would otherwise regress infinitely — the ops that CREATE attestations are
 * themselves ops. A `member.set` patch consisting SOLELY of `dev.*` registers is
 * self-authorizing on `op.act === memberId` (§4.0's own second sentence) and gated only by
 * `attestVerify`. A patch mixing `dev.*` with ordinary member fields has two predicates and no
 * single answer, so it is refused whole. §4.0 needs one sentence saying this.
 *
 * @param {Iterable<Op>} ops
 * @param {{ me: MemberId, nowMs: number,
 *           attestVerify: (memberId:MemberId, blob:string) => boolean,
 *           myDevices?: Set<DeviceId>,   [WP-1] §4.0's "local device set"; absent, the check
 *                                        degrades to `act === me`, all §4.4 claims for the
 *                                        personal space
 *           genesisOpId?: OpId,          [WP-1] OPTIONAL PIN closing a real hole §4.1 leaves
 *                                        open: genesis is admissible from anyone with
 *                                        `act === admin`, chains compare by length then greater
 *                                        `ts`, and the common chain has length 1 — so any member
 *                                        who knows the `fsp_` id can mint a rival genesis with a
 *                                        greater ts and become admin, which grants the unshare
 *                                        power over everyone's entries. Default behaviour is the
 *                                        pure ADR rule. §4.1 NEEDS A BINDING between a space id
 *                                        and its genesis link before family sharing ships.
 *           haveEpochKey?: (op:Op) => boolean }} ctx
 * @returns {AuthzResult}
 */
export function foldAuthorized(ops, ctx) { throw new Error('not implemented'); }

/**
 * [WP-1] A total, order-independent projection of an AuthzResult — the whole of property P5 as
 * one `deepEqual` rather than a checklist.
 * @param {AuthzResult} result @returns {Object}
 */
export function snapshot(result) { throw new Error('not implemented'); }

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
 *
 * [WP-1] ALL OPTIONAL, and all defaulting to "no badge motion, no dot". ADR 004 §6's badge needs
 * `outboxHasPendingPubOp(entity)` and §7.2's „neu" dot needs `maxSeq(entity)`; registers carry no
 * seq (ADR 001 §7.2) and this ctx carried neither hook, so neither was computable as specified.
 * The two SUPPRESSION clauses (a downgrade never dots, a deletion never dots) are enforced INSIDE
 * materialize rather than delegated, so a caller with a sloppy seq source still cannot make a
 * retraction blink.
 * @property {(e:EntityKey) => boolean} [pendingPub]
 * @property {(e:EntityKey) => string|null} [seqOf]
 * @property {(e:EntityKey) => boolean} [isNew]
 * @property {(e:EntityKey) => boolean} [levelDecreased]
 * @property {Object} [defaultSettings]  [WP-1] §5 step 6 says settings merge over
 *                    `defaultState().settings`, but `core/` may not import `store.js` (ADR 005
 *                    §2). `store.js` passes its own, so the app keeps ONE source of truth.
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
/**
 * [WP-1] `undo()` is typed `() => Op[]`, and an Op needs `id`, `act`, `dev`, `space` and `gid` —
 * none of which the declared cfg carried, so as written this could not build an op. The two
 * original members keep their names and meanings exactly; the rest are additive.
 *
 * [WP-1] `push`/`undo`/`redo` take an OPTIONAL trailing `state` (the current materialized state),
 * because the shadow assertion needs it at transfer time — v1's `undo()` clones the CURRENT
 * content onto its redo stack (`store.js:177`). The zero-argument call still matches `() => Op[]`.
 *
 * [WP-1] `undo()` returns `[]`, never `false`; `store.undo()` maps empty → `false` for the v1
 * surface in store.contract.js. Do not treat `[]` as truthy.
 *
 * @param {{ limitGroups:number, mint:() => Stamp,
 *           act:MemberId, dev:DeviceId,
 *           newOpId?:() => OpId, newGid?:() => GroupId,
 *           space?:SpaceRef, familySpaceId?:SpaceId|null, shadow?:boolean }} cfg
 * @returns {UndoStacks}
 */
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
 * [WP-1 round 2] `checkpoint()` returns
 *   {horizon, regs, cursors, seqs, bodies, parked, spliced, at}
 * `bodies`, `parked` and `spliced` are ADDITIVE and each one is required for a closed defect:
 *   · `bodies`  — a 96-bit fingerprint per opId whose LINE has been folded away, so a second,
 *                 DIFFERENT body at a re-used opId is spliced rather than answered "duplicate"
 *                 after a compaction (A1). Costs ~40 bytes per dropped line; see the note on
 *                 ADR 001 §7.2's storage bound below.
 *   · `parked`  — parked lines WITH THEIR REASONS, so a relaunch can re-classify them instead of
 *                 losing why they were parked (A2-a).
 *   · `spliced` — splice evidence, which cannot be re-derived once the losing body is gone.
 * `seqs` is now keyed by **opId**, not by stamp: two ops may legitimately share a stamp (§8.1
 * stamps every migrated op `GENESIS(index)` with `ZERO_DEVICE_SHORT`, so two boards migrated into
 * one personal space collide by construction), and a stamp-keyed index let one op's push seq
 * satisfy the tombstone-GC guard for another. A pre-round-2, stamp-keyed file still loads: the two
 * key shapes are distinguishable, so there is no version flag and no migration pass.
 *
 * [WP-1 round 2] `ops(q)` returns the APPLIED set (`{includeParked:true}` opts in), so
 * `fold(log.ops())` is safe; `lines()` is the explicit "every line on disk" accessor, returning
 * `{op, seq, park}`. `seqOfOp(id)` is the opId-keyed seq lookup, and `tombstoneCollectable`'s ctx
 * gains an optional `seqOfOp`.
 *
 * @property {() => {horizon:Stamp, regs:Object, cursors:Object, seqs:Object, bodies:Object,
 *                   parked:Object[], spliced:string[], at:number}} checkpoint
 *           [WP-1] `seqs` is additive and REQUIRED: condition 3 of §7.3 needs stamp→seq for a
 *           stamp that may live only in the checkpoint. Without persisting it, tombstone GC
 *           silently stops working after the first relaunch — it never throws, it just never
 *           collects. Pruned on compaction to the stamps surviving registers hold, so the bound
 *           stays O(entities × fields).
 * @property {() => number} compact          fold ops <= horizon into the checkpoint; → dropped count
 * @property {(o:{checkpoint:Object, tail:Op[]}) => RegisterMap} load
 * @property {(op:Op, reason:'future'|'epoch'|'unknownKind'|'unknownField'|'version'|'unknownSpace') => void} park
 *           [WP-1] `version` and `unknownSpace` were missing from this enum; ADR 001 §10 mandates
 *           both and `ops.js:PARK_REASONS` carries all six.
 * @property {(pred:(op:Op)=>boolean) => Op[]} unpark
 * @property {(e:EntityKey, space:SpaceRef, opts?:{fields?:string[], values?:'all'}) => number} forget
 *           the ADR 004 §5.3 forget pass: purge this entity's lines for that space.
 *           [WP-1] `opts` is additive because §5.3 has TWO triggers and one default cannot serve
 *           both. A full retraction must blank the content registers the retraction did not
 *           itself null; a Geteilt→BELEGT downgrade must NOT, or it erases a Belegt entry the
 *           family is meant to keep seeing. Default = all non-governing; `{fields}` narrows;
 *           `{values:'all'}` is the hard purge. Governing registers keep their values by default
 *           because `pub.alive:false` / `pub.level` ARE the retraction.
 */
/**
 * [WP-1] `now` is REQUIRED, not optional: `core/` may not read a clock (ADR 005 §2) and the 24 h
 * future-park must not be silently unarmed by an omitted argument. `createOpLog({storage})` alone
 * throws. `storage` is accepted and retained but NEVER CALLED — using it would make the log
 * async, and an `await` between `txn()` and `emit()` breaks bar-label editing (ADR 001 §0.9). It
 * is exposed as `log.ports.storage` so `platform/oplogfile.js` can wire in without a signature
 * change, and there is a test that the port is never touched.
 * @param {{ storage?: any, now: () => number, registers?: any }} ports @returns {OpLog}
 */
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
 * [WP-1] `opId` is CSPRNG by §1.2, and byte-identical double migration is impossible with random
 * ids, so migration DERIVES it:
 *   b64u(SHA-256("lzp.migrate.op" ‖ label ‖ act ‖ index ‖ kind ‖ entityKey)[0..16])
 * Deliberately excluding `op.dev` (or two Macs diverge) and deliberately excluding `f` — the opId
 * is SERVER-VISIBLE, and hashing the payload into it would hand the relay a confirmation oracle
 * for guessed note text, defeating the point of encrypting the body.
 *
 * [WP-1] §8.2 says "one `gid` labelled 'migrate:v1'", but `gid` is a 22-char GroupId and
 * `validateOp` rejects anything else. 'migrate:v1' is the LABEL; the gid is derived from it and
 * constant. §8.2 should say "labelled".
 *
 * @param {Object} v1board  parsed board.json (already through v1's own migrate())
 * @param {{ memberId: MemberId, deviceId: DeviceId, deviceShort: DeviceShort }} ctx
 * @returns {{ ops: Op[], warnings: string[], lossy: boolean, index: number, report: Object }}
 *          [WP-1] `lossy` is additive: `f` is scalars-only, so a v1 board can carry more than a
 *          register can hold (v1's limits are DOM `maxLength` attributes and do not apply to an
 *          imported or hand-edited file). The store must be able to refuse and tell the user
 *          rather than migrating quietly — the original file is about to be replaced.
 *
 *          [WP-1] A lossy migration does not merely SET the flag: it THROWS `MigrationLossyError`
 *          (whole result on `.result`) unless the caller passed `ctx.onLossy` or
 *          `ctx.acceptLossy`. A boolean nobody is obliged to read is not a safety mechanism.
 *
 *          [WP-1 round 2] Nothing that would remove an ENTRY FROM THE BOARD is dropped:
 *          an over-long `str40`/`str80` is TRUNCATED (the cut characters are in `report.losses`),
 *          and a TEXT field the file holds as a non-string is kept as the string v1 paints for it
 *          (`n.text || '…'`, `popover.js:193`) — `reason: 'coerced'`, original value in the
 *          report. A malformed DATE is still dropped, never repaired. A `null` is still a
 *          first-class register value (ADR 001 §2) EXCEPT in a field renderability requires,
 *          where it takes `''` — the value ATT-53 already gives an absent one.
 *
 *          [WP-1 round 2] An unknown TOP-LEVEL key is a reported loss, as it is on the import
 *          door; the two doors share `V1_BOARD_KEYS`.
 */
export function migrateV1(v1board, ctx) { throw new Error('not implemented'); }

/**
 * Import (11.3) and snapshot restore (11.5). NOT a `board.reset` op — that primitive has no fold
 * rule and is rejected (ADR 001 §8.5). Emits per-field restoring writes at FRESH stamps plus
 * `_alive:false` for entities absent from the import. Personal + local spaces ONLY; the publisher
 * re-derives family ops afterwards.
 * [WP-1 round 2] THE TWO DOORS ARE ONE DOOR. In v1, `store.replaceAll(next)` IS
 * `this.state = migrate(next)` (`store.js:194`) — the import path and the launch path are the
 * same function — so every place where `replace.js` and `migrate1to2.js` answered the same bytes
 * differently was a v2 regression with nothing in v1 behind it. `replace.js` therefore IMPORTS
 * `truncateToFit`, `coerceToV1Text`, `rekeyed`, `defaultCategories` and `V1_BOARD_KEYS` rather
 * than reimplementing them, and performs v1's two settings repairs (`store.js:86,90`). Property
 * P13 asserts both doors produce the same board over 500 ugly seeds.
 *
 * [WP-1 round 2] `replaceAllOps` THROWS `ReplaceLossyError` (whole plan on `.plan`) on a lossy
 * import unless `ctx.onLossy` / `ctx.acceptLossy` — the exact twin of `MigrationLossyError`, and
 * more load-bearing here: 11.5 is snapshot restore, so the board being replaced is gone
 * afterwards. Callers that want the diagnostics call `planReplaceAll`, which never throws.
 *
 * [WP-1 round 2] `IMPORT_DEFAULTS` are FORCED, not defaulted: an imported file cannot set
 * `visibility`/`coEdit` (story 16.1, ADR 004). The exposure the file asked for is returned on
 * `plan.reshares` for the user to confirm, so neither granting nor dropping is silent.
 *
 * [WP-1 round 2] `ctx.defaultSettings` (v1's `defaultState().settings`) SHOULD be supplied: it is
 * what lets a pref the import omits be reset to its v1 DEFAULT rather than cleared. Clearing and
 * defaulting are different boards for every pref whose default is `true` (REG-8).
 *
 * @param {RegisterMap} regs @param {Object} incoming @param {{ mint:() => Stamp, me:MemberId,
 *          personalSpaceId:SpaceId|null, deviceId:DeviceId, defaultSettings?:Object,
 *          acceptLossy?:boolean, onLossy?:(plan:Object)=>void }} ctx
 * @returns {Op[]}
 * @throws {ReplaceLossyError} on a lossy import with neither `acceptLossy` nor `onLossy`
 */
export function replaceAllOps(regs, incoming, ctx) { throw new Error('not implemented'); }

/**
 * [WP-1 round 2] The diagnostics-carrying form. Never throws for bad DATA; the store calls THIS
 * one for an import or a restore, because two of the fields exist only here:
 *
 *   {ops, warnings, lossy, gid, undoable, label, written, removed, retractions, reshares}
 *
 *   · `retractions` — family keys (`fnote:<me>/…`) whose personal truth this transaction
 *     tombstoned. `replace.js` may not write a family register (ADR 001 §8.5 step 5 — the scope
 *     gate is what stops one person's restore from blanking the family board), so the PUBLISHER
 *     must re-derive exposure for these afterwards or the family keeps seeing an entry its owner
 *     deleted (RECHECK-40-4).
 *   · `reshares` — exposure the FILE asked for and was refused; ask the user, then apply.
 *
 * @param {RegisterMap} regs @param {Object} incoming @param {Object} ctx @returns {Object} plan
 */
export function planReplaceAll(regs, incoming, ctx) { throw new Error('not implemented'); }
