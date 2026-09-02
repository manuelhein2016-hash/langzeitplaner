// src/js/core/registers.js — THE LWW JOIN. The convergence heart of the product.
// ADR 001 §1.3, §1.4, §2, §5 step 2, §6, §7.2 · ADR 004 §4.1, §5.1 · ops.contract.js §3.
//
// DOM-free, I/O-free, dependency-free (ADR 005 §2).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
//
// A RegisterMap is a finite product of independent cells keyed by (entityKey, field). Each cell
// holds exactly one `{ value, stamp, author, op }`. The update rule is, in full:
//
//     cell  ←  max_≺ (cell, incomingWrite)
//
// and `≺` is the stamp string compared with plain `<`. That is the ENTIRE merge semantics of
// LangzeitPlaner v2. There is no move op, no create op, no delete op and no per-kind special
// case at this layer (ADR 001 §0.1, §12.2). `_alive` is a register like any other, which is why
// "delete at A, edit at B > A" converges to "dead, with an unread new text" on every device
// without a line of special handling.
//
// `max` over a totally ordered set is Associative, Commutative and Idempotent. A finite product
// of ACI operations is ACI. Therefore folding a SET of ops is order-independent and
// duplicate-insensitive BY CONSTRUCTION — not by argument, not by a dedupe table (ADR 001 §0.2,
// §6). Reorder-, duplicate-, interleave- and partition-convergence are corollaries, and
// `tests/tier1/core-registers.test.js` asserts each of them directly rather than trusting the
// proof.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ORDER ON WRITES — THREE KEYS, AND WHY THE THIRD EXISTS
//
// ADR 001 §6 step 1 gives two: the stamp, "with the write's `opId` as an unreachable final
// tiebreak". Step 2 then argues the opId is unreachable because deviceShort is unique per device
// and the counter strictly increments per local event, so two distinct honest writes always
// differ in (ms, ctr, deviceShort).
//
// That argument is sound for HONEST devices and is exactly why the opId must be RETAINED in the
// register (the contract's `{value, stamp, author}` typedef cannot express the tiebreak it
// mandates — see the note on `Register` below). It says nothing about a device running a
// modified client, which can emit two ops carrying the same stamp. So this module adds a THIRD
// key — a deterministic total order on the scalar value itself — and the resulting `≺` is total
// over every possible write, honest or not. Without it, two peers receiving a malicious pair in
// different orders would silently diverge, which is precisely the failure this module exists to
// make impossible. It costs one string comparison that in practice never runs.
//
// ─────────────────────────────────────────────────────────────────────────────
// `null` IS A VALUE. ABSENCE IS NOT. (R9 — ADR 001 §2, ADR 004 §5.1)
//
// A register holding `null` EXISTS, has a stamp, has an author, and WINS against every older
// write exactly like any other value. That is the whole mechanism behind a visibility downgrade:
// `Geteilt → Belegt` writes `'pub.text': null` at a fresh stamp, so every peer's `pub.text`
// register is overwritten with `null` and their boards stop rendering the text.
//
// If a downgrade merely OMITTED `pub.text`, no register write would occur, the old register
// would keep its value and its stamp, and every other member's board would keep rendering the
// text — while the owner's own board looked correctly downgraded. No owner-side smoke test
// catches that. It is R9, the single highest-value defect in the v2 surface, and this module's
// job is to make the difference between "null" and "absent" impossible to blur:
//
//     getRegister(regs, e, f) === undefined   →  never written
//     getRegister(regs, e, f).value === null  →  written, cleared, and it WON
//
// Materialization (ADR 001 §5 step 1) is what SKIPS null-valued registers when projecting an
// entity. The join never skips them: dropping the register would resurrect the old value the
// next time two devices merged.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TWO NAMESPACES, AND THE ONE ASYMMETRY (ADR 004 §1, §4.1)
//
//   personal space   note:5e1a-…-9c            date · text · categoryId · repeatsYearly
//                                              visibility · coEdit · _alive · _born   ← THE TRUTH
//   family space     fnote:mem_7f2c…/5e1a-…-9c pub.level · pub.date · pub.text? …
//                                                                            ← THE PUBLICATION
//
// They are DIFFERENT ENTITY KEYS holding DIFFERENT FIELD NAMES with INDEPENDENT stamps. Nothing
// in this file can move a value from one to the other; `applyOp` refuses a `pub.*` field on a
// truth key and a truth field on a family key, because `FIELDS` gives no spec for either. A3
// ("categories are never synced") is therefore enforced by the ABSENCE of `pub.categoryId` from
// the table, not by a filter someone can forget to apply.
//
// `promoteRegister` is the ONE place the two namespaces meet, and it is deliberately asymmetric.
// See its comment; that asymmetry is the correctness heart of ADR 004 and property test P7c.

import { cmp, isStamp } from './stamp.js';
import {
  parseEntityKey, familyKey, isMemberId, isOpId, isFamilyKind, FAMILY_OF,
} from './entities.js';
import { fieldSpec, coEditableFields, isScalar } from './ops.js';

/** Thrown when a register map, a blob or an op violates an invariant this module maintains. */
export class RegisterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RegisterError';
  }
}

/** Bumped only when the serialized checkpoint shape changes. */
export const REGISTER_FORMAT = 1;

/**
 * @typedef {Object} Register
 * @property {string|number|boolean|null} value  a JSON scalar or null. `null` is a VALUE.
 * @property {string} stamp   the 37-char HLC stamp of the winning write
 * @property {string} author  `op.act` — the acting MEMBER, not the device. 17.6 renders it as
 *                            "von Mama", ADR 001 §1.4 reads it for `updatedBy`, and ADR 004
 *                            §4.1's promotion rule compares it against `me`. It MUST be the
 *                            member: with the device there instead, my own second Mac's
 *                            publication writes would be promoted onto my truth and a Belegt
 *                            downgrade would blank my own note on my other machine.
 * @property {string} op      the winning write's OpId — ADR 001 §6's final tiebreak. It is
 *                            ADDITIVE to ops.contract.js §3's `{value, stamp, author}` typedef,
 *                            which cannot express the tiebreak the same document mandates: once
 *                            a checkpoint has collapsed ops into registers, `mergeMaps` has
 *                            nothing else to break a stamp tie with. Reported as a contract gap.
 */

/** @typedef {Map<string, Map<string, Register>>} RegisterMap */

// ─────────────────────────────────────────────────────────────────────────────
// 1. The order on writes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A deterministic total order on the scalars a register may hold. Mostly not a meaningful order —
 * it exists so `≺` never returns "equal" for two different values, and it is consulted only when
 * a stamp AND an opId BOTH tie, which honest devices cannot produce.
 *
 * ONE RANK IS LOAD-BEARING: `null` sorts ABOVE every non-null value. The exact (stamp, opId) tie
 * that ADR 001 §6 calls "unreachable" is made reachable by exactly one mechanism — the ADR 004
 * §5.3 forget pass, which blanks a register's value IN PLACE, at its existing stamp and opId, so
 * the plaintext leaves the disk while the stamp stays behind for convergence. Re-delivering the
 * very op that wrote it is then an exact tie against its own blanked self. Ranking `null` lowest
 * would let the cold re-delivery of a publication UN-BLANK a field the owner retracted — a
 * retraction guarantee silently not holding. Ranking it highest makes forget absorbing: the blank
 * wins the tie, and only a genuinely NEWER publication (a greater stamp, i.e. the owner sharing
 * again) can restore the value, which is the owner republishing rather than a leak.
 *
 * This is safe precisely because the comparator runs only under a double tie: a real edit to
 * `null` and a real edit to a value always differ in stamp, and never reach here.
 * @param {unknown} v @returns {string}
 */
function valueKey(v) {
  if (v === null) return '\uffff';                     // ← above every branch below. See above.
  switch (typeof v) {
    case 'boolean': return v ? '1t' : '1f';
    case 'number': return '2' + String(v);
    case 'string': return '3' + v;
    default: return '9' + String(v);
  }
}

const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The second key. An OpId is a 22-character Crockford/base64url string, so every real one sorts
 * below `'￿'`.
 *
 * A WRITE WITH NO OPID RANKS ABOVE EVERY REAL ONE — the same "when a tie is reachable at all, the
 * absorbing side wins" rule `valueKey` applies to `null`, and it is here for the same reason.
 * This rank is the WHOLE of the defence, not a backstop behind a door that refuses: REG-26 turned
 * `deserializeRegisters`'s refusal of an op-less checkpoint register into a REPAIR (it normalises
 * `op` to `null` and reports it), because refusing meant losing the user's whole board over one
 * missing 22-character id. An unattributed write therefore CAN exist inside this build, by
 * design, and this comparator is what makes that safe.
 * Ranking a missing opId LOWEST — which is what `a.op ?? ''` used to do — made every real
 * op at the same stamp beat it, so a single dropped optional key anywhere upstream turned the ADR
 * 004 §5.3 forget blank (value `null`, stamp AND opId retained precisely so the blank wins its own
 * tie) back into the retracted plaintext on the next re-pull. INV-R4 says a downgrade removes; a
 * comparator that lets an older value win a tie is that invariant not holding. Ranking it highest
 * makes the unattributed write absorbing instead: only a genuinely GREATER stamp — the owner
 * publishing again — can displace it, which is republication, not a leak.
 * @param {unknown} o @returns {string}
 */
function opKey(o) {
  return typeof o === 'string' && o !== '' ? o : '￿';
}

/**
 * `≺` — the strict total order on writes (ADR 001 §6 step 1, extended per the header note).
 * Stamp, then opId, then the value. Anything less than total would let two peers that received
 * the same ops in different orders disagree.
 * @param {{stamp:string, op?:string, value:any}} a
 * @param {{stamp:string, op?:string, value:any}} b
 * @returns {-1|0|1}
 */
export function cmpWrites(a, b) {
  return /** @type {-1|0|1} */ (
    cmp(a.stamp, b.stamp)
    || byString(opKey(a.op), opKey(b.op))
    || byString(valueKey(a.value), valueKey(b.value))
  );
}

/** The join on one cell. Ties return `a`, because a tie means the two writes are identical. */
export function maxWrite(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return cmpWrites(b, a) > 0 ? b : a;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Construction and the fold
// ─────────────────────────────────────────────────────────────────────────────

/** @returns {RegisterMap} */
export function emptyRegisters() {
  return new Map();
}

/**
 * The cheap structural guard `applyOp` runs. It protects THIS MODULE'S invariants and nothing
 * else: the order needs a real stamp, the Map needs a real key, the promotion rule needs a real
 * member as `author`, the semilattice needs scalars, and a field with no `FieldSpec` would
 * create a register nothing downstream can ever read.
 *
 * It is deliberately NOT `validateOp`. Protocol-level type checking (str80 length, enum
 * membership, `YYYY-MM-DD`) is `classifyOp`'s job on the way in, and an op that reaches the join
 * has already been through it (ops.contract.js §3: "assumes `op` was already admitted"). Running
 * the full validator a second time on the hot fold path buys nothing.
 *
 * @param {any} op @returns {string|null} the reason it cannot be applied, or null
 */
export function applicabilityError(op) {
  if (op === null || typeof op !== 'object' || Array.isArray(op)) return 'op is not an object';
  if (!isStamp(op.ts)) return `op.ts is not a 37-char stamp: ${JSON.stringify(op.ts)}`;
  if (!isMemberId(op.act)) return `op.act is not a MemberId: ${JSON.stringify(op.act)}`;
  if (!isOpId(op.id)) return `op.id is not a 22-char OpId: ${JSON.stringify(op.id)}`;
  const entity = parseEntityKey(op.e);
  if (!entity) return `op.e is not a well-formed entity key: ${JSON.stringify(op.e)}`;
  if (op.f === null || typeof op.f !== 'object' || Array.isArray(op.f)) return 'op.f is not an object';
  const names = Object.keys(op.f);
  if (names.length === 0) return 'op.f is empty — an op that writes nothing is malformed';
  for (const name of names) {
    if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
      return `op.f carries the forbidden key ${JSON.stringify(name)}`;
    }
    if (!fieldSpec(entity.kind, name)) {
      // Unknown fields are PARKED upstream (ADR 001 §7.4, §10) and must never reach the join.
      // Arriving here means a caller skipped `classifyOp`, which is a bug worth a loud stop.
      return `${entity.kind} has no field ${JSON.stringify(name)} — an unknown field is PARKED, never applied`;
    }
    if (!isScalar(op.f[name])) {
      return `op.f[${JSON.stringify(name)}] is not a JSON scalar or null — no nested objects, no arrays`;
    }
  }
  return null;
}

/**
 * Fold ONE op into `regs`. Idempotent, commutative, associative. Performs NO authorization —
 * `foldAuthorized` (ADR 001 §4) decides admissibility in stages before anything gets here.
 *
 * MUTATES `regs` in place, as ops.contract.js §3's `(regs, op) => boolean` signature requires.
 *
 * @param {RegisterMap} regs
 * @param {Object} op
 * @returns {boolean} true iff any register was REPLACED — i.e. the incoming write won somewhere.
 *   Note the precise meaning: a newer write carrying a value identical to the one already there
 *   returns `true`, because the register (stamp and author included) did change and `updatedAt`
 *   / `updatedBy` / 17.6's "geändert So." move with it. A caller that wants "did any rendered
 *   VALUE change" must diff values itself; v1 re-renders the whole board on every emit anyway
 *   (`board.js:26`), so the safe direction here is to over-report, never to under-report.
 */
export function applyOp(regs, op) {
  const bad = applicabilityError(op);
  if (bad) throw new RegisterError(`applyOp: ${bad}`);

  let ent = regs.get(op.e);
  if (ent === undefined) {
    ent = new Map();
    regs.set(op.e, ent);
  }

  let changed = false;
  for (const field of Object.keys(op.f)) {
    const incoming = Object.freeze({ value: op.f[field], stamp: op.ts, author: op.act, op: op.id });
    const current = ent.get(field);
    // `>` and not `>=`: a re-delivered op ties on all three keys and must be a no-op, or every
    // duplicate would report a change and 17.5's "neu" dot would fire on old news.
    if (current === undefined || cmpWrites(incoming, current) > 0) {
      ent.set(field, incoming);
      changed = true;
    }
  }
  return changed;
}

/**
 * Fold many. MUTATES `regs` and returns it (ops.contract.js §3).
 * @param {RegisterMap} regs @param {Iterable<Object>} ops @returns {RegisterMap}
 */
export function foldAll(regs, ops) {
  if (!(regs instanceof Map)) throw new RegisterError('foldAll: regs must be a RegisterMap');
  for (const op of ops) applyOp(regs, op);
  return regs;
}

/**
 * The convenience the tests and the checkpoint loader want: fold a fresh map.
 * @param {...Iterable<Object>} opLists @returns {RegisterMap}
 */
export function fold(...opLists) {
  const regs = emptyRegisters();
  for (const ops of opLists) foldAll(regs, ops);
  return regs;
}

/**
 * Field-wise max of two register maps — how a checkpoint is folded with a tail (ADR 001 §7.2).
 * Returns a NEW map and mutates neither argument; `Register` objects are frozen and therefore
 * safe to share between maps.
 *
 * This is the operation that makes compaction free of coordination: because per-field stamps are
 * RETAINED in the checkpoint, `mergeMaps(fold(prefix), fold(tail)) === fold(prefix ∪ tail)` for
 * ANY partition — including a late-arriving op older than the horizon, which is compared against
 * the checkpoint's retained stamp and wins or loses by the identical rule.
 *
 * @param {RegisterMap} a @param {RegisterMap} b @returns {RegisterMap}
 */
export function mergeMaps(a, b) {
  if (!(a instanceof Map) || !(b instanceof Map)) throw new RegisterError('mergeMaps: expected two RegisterMaps');
  const out = new Map();
  for (const [e, fields] of a) out.set(e, new Map(fields));
  for (const [e, fields] of b) {
    let ent = out.get(e);
    if (ent === undefined) {
      out.set(e, new Map(fields));
      continue;
    }
    for (const [f, reg] of fields) {
      const cur = ent.get(f);
      if (cur === undefined || cmpWrites(reg, cur) > 0) ent.set(f, reg);
    }
  }
  return out;
}

/** A copy nobody can mutate through. Registers are frozen, so the inner Maps are all that copy. */
export function cloneRegisters(regs) {
  const out = new Map();
  for (const [e, fields] of regs) out.set(e, new Map(fields));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Reads
// ─────────────────────────────────────────────────────────────────────────────

/** @returns {Map<string, Register>|undefined} */
export function registersOf(regs, e) {
  return regs.get(e);
}

/**
 * @returns {Register|undefined} `undefined` means NEVER WRITTEN. A register whose `.value` is
 * `null` was written, cleared and won. Blurring the two is R9 (ADR 004 §5.1).
 */
export function getRegister(regs, e, field) {
  const ent = regs.get(e);
  return ent === undefined ? undefined : ent.get(field);
}

/** @returns {any} the register's value, or `undefined` when the register does not exist. */
export function getValue(regs, e, field) {
  const r = getRegister(regs, e, field);
  return r === undefined ? undefined : r.value;
}

/** True when the register EXISTS — including when it holds `null`. @returns {boolean} */
export function hasRegister(regs, e, field) {
  return getRegister(regs, e, field) !== undefined;
}

/** Sorted, so any listing derived from it is deterministic. @returns {string[]} */
export function entityKeys(regs) {
  return [...regs.keys()].sort(byString);
}

/** Sorted. @returns {string[]} */
export function fieldNames(regs, e) {
  const ent = regs.get(e);
  return ent === undefined ? [] : [...ent.keys()].sort(byString);
}

/** @returns {number} total register count, for budgets and diagnostics */
export function registerCount(regs) {
  let n = 0;
  for (const fields of regs.values()) n += fields.size;
  return n;
}

// ── ADR 001 §1.4 — derived timestamps, no stored createdAt / updatedAt ───────
//
// Both are pure functions of the op set and therefore convergent for free. They deliver 17.6
// ("von Mama · geteilt · geändert So.") without a syncable field two devices could disagree
// about. Implemented here rather than in materialize.js because they are pure register queries
// and nothing about them needs a MaterializeCtx; ops.contract.js groups them under §5, so
// materialize.js is expected to re-export them.

/** `createdAt = min stamp over an entity's registers` (= the `_born` stamp). @returns {?string} */
export function createdAt(regs, e) {
  const ent = regs.get(e);
  if (ent === undefined || ent.size === 0) return null;
  let min = null;
  for (const r of ent.values()) if (min === null || r.stamp < min) min = r.stamp;
  return min;
}

/** `updatedAt = max stamp`. @returns {?string} */
export function updatedAt(regs, e) {
  const ent = regs.get(e);
  if (ent === undefined || ent.size === 0) return null;
  let max = null;
  for (const r of ent.values()) if (max === null || r.stamp > max) max = r.stamp;
  return max;
}

/**
 * `updatedBy = author of the register holding updatedAt`. Ties on the stamp fall through to the
 * same `≺` the join uses, so this is a function of the SET and not of Map insertion order.
 * @returns {?string} a MemberId
 */
export function updatedBy(regs, e) {
  const ent = regs.get(e);
  if (ent === undefined || ent.size === 0) return null;
  let best = null;
  for (const r of ent.values()) if (best === null || cmpWrites(r, best) > 0) best = r;
  return best === null ? null : best.author;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The truth / `pub.*` namespace bridge — and the promotion asymmetry
// ─────────────────────────────────────────────────────────────────────────────

/** `text` → `pub.text`. The publication field name is mechanically derived (ADR 004 §2.1). */
export const pubFieldFor = (truthField) => `pub.${truthField}`;

/** `pub.text` → `text`, else null. */
export const truthFieldFor = (pubField) =>
  (typeof pubField === 'string' && pubField.startsWith('pub.') ? pubField.slice(4) : null);

/**
 * The promotion rule for ONE field (ADR 001 §5 step 2, ADR 004 §4.1):
 *
 *     effective[f] = maxByStamp( truth[f], pub[f] where pub[f].author !== me )
 *
 * ┌───────────────────────────────────────────────────────────────────────────────────────────┐
 * │ NEVER PROMOTE MY OWN `pub.*` WRITES. They are projections *of* the truth, not edits *to*   │
 * │ it — which is exactly why publishing `pub.text: null` for a Belegt downgrade does not      │
 * │ blank my own note.                                                                        │
 * └───────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * That sentence is required verbatim in the source by ADR 004 §4.1. This single asymmetry is the
 * correctness heart of ADR 004 (INV-R3: "a redaction can never make my own board lie to me") and
 * it is guarded by property test P7c.
 *
 * `author` is the acting MEMBER, so the rule holds across ALL of my devices: my desktop's
 * retraction op carries `act === me`, so my laptop declines to promote it too. Were `author` the
 * DEVICE, a Geteilt→Belegt downgrade on one Mac would blank the note on the other — a silent
 * data-loss bug that no single-device test could ever see.
 *
 * THIS FUNCTION IS THE ADR FORMULA VERBATIM — `null` is a first-class value here and a co-editor
 * who clears my text with `pub.text: null` DOES clear it (R9, story 18.2). The one case the
 * formula gets wrong, an ADMIN UNSHARE, is excluded one level up by `withdrawnByOther()`, not by
 * blanket-refusing nulls. See the note there for why the distinction has to be made at the entity
 * level and cannot be made here.
 *
 * `materialize.js` calls THIS function rather than carrying its own copy of the rule: ADR 004 §4.1
 * calls the promotion "the correctness heart", and two implementations of a correctness heart is
 * one too many — one of them eventually gets the asymmetry subtly wrong, and only one of them has
 * P7c pointed at it.
 *
 * @param {Register|undefined} truthReg
 * @param {Register|undefined} pubReg
 * @param {string} me  MemberId. Required, and validated: `undefined` here would make every
 *                     `pubReg.author === me` comparison false and promote my own retractions.
 * @returns {Register|undefined}
 */
export function promoteRegister(truthReg, pubReg, me) {
  if (!isMemberId(me)) {
    throw new RegisterError(`promoteRegister: \`me\` must be a MemberId, got ${JSON.stringify(me)}`);
  }
  if (pubReg === undefined) return truthReg;
  if (pubReg.author === me) return truthReg;          // ← the asymmetry. Do not "simplify" it.
  if (truthReg === undefined) return pubReg;
  return cmpWrites(pubReg, truthReg) > 0 ? pubReg : truthReg;
}

/**
 * Was this entity's family publication withdrawn by SOMEBODY ELSE? — i.e. is the winning
 * `pub.level` register `'privat'` (or `pub.alive` `false`) under an author who is not me?
 *
 * ═══ WHY THIS EXISTS: two normative passages contradict each other, and this is the reading ═══
 *
 * ADR 001 §5 step 2 and ADR 004 §4.1 state promotion as
 *     effective[f] = maxByStamp( truth[f], pub[f] where pub[f].author !== me )
 * with no further qualification. ADR 004 §5's transition table states that an ADMIN UNSHARE
 * (story 18.3) is `pub.set{'pub.level':'privat', …all content → null}` and that "the owner's
 * truth is untouched — the entry reverts to owner-private and is never deleted", which INV-R3
 * restates as "a redaction can never make my own board lie to me".
 *
 * Those cannot both hold. The unshare's `pub.text: null` carries `author === admin ≠ me` at a
 * stamp newer than my truth, so the formula promotes it, and materialization step 1 skips
 * `null` — MY OWN NOTE GOES BLANK, on my own board, from a register I did not write. That is
 * precisely the failure INV-R3 names.
 *
 * The tempting fix — never promote a `null` — is WRONG and was rejected: it also breaks story
 * 18.2 / risk R9, where a co-editor clearing my text with an explicit `pub.text: null` must
 * reach my truth, because `null` is a first-class value (ADR 004 §5.1) and not a synonym for
 * "absent".
 *
 * The discriminator that separates the two IS in the register map, exactly and locally. An admin
 * unshare is ONE op, so its `pub.level: 'privat'` carries the same stamp and the same author as
 * its content nulls; and `pub.level` is `gov: true`, so ADR 001 §4.3 stage 3a admits it from the
 * owner or the admin ALONE — a co-editor physically cannot write it. Therefore:
 *
 *     a `pub.level` of 'privat' (or `pub.alive: false`) authored by someone other than me
 *     ⟺ a third party retracted my publication ⟺ an admin unshare
 *
 * and in that state the family projection holds no edits of mine to promote at all. Every other
 * case is untouched, which is why this is a narrower deviation than the null guard:
 *
 *   · MY OWN retraction (Geteilt → Privat)  → author IS me → normal promotion; my own nulls are
 *     blocked by the asymmetry and a co-editor's earlier edits still stand. Unchanged.
 *   · Geteilt → Belegt by me                → `pub.level: 'belegt'`, not a withdrawal. Unchanged.
 *   · a co-editor clearing a field          → `pub.level` still 'geteilt'. Unchanged, R9 holds.
 *   · admin unshare                         → gate fires, truth stands whole. 18.3 holds.
 *
 * Reported loudly as an ADR contradiction; §5 step 2's formula needs this qualifier written into
 * it. Pinned by tests on both sides so neither half can be "simplified" away.
 *
 * @param {Map<string, Register>|undefined} famCells the `fnote:`/`fbar:` register map
 * @param {string} me MemberId
 * @returns {boolean}
 */
export function withdrawnByOther(famCells, me) {
  if (!famCells) return false;
  const level = famCells.get('pub.level');
  if (level !== undefined && level.value === 'privat' && level.author !== me) return true;
  const alive = famCells.get('pub.alive');
  return alive !== undefined && alive.value === false && alive.author !== me;
}

/**
 * The effective registers of an entity I OWN: my truth, with a co-editor's newer publication
 * writes promoted over it. Only `coEdit: true` fields are eligible, so a peer can never write my
 * `visibility`, my `coEdit` or my `_alive` through the family space — those are `gov: true` and
 * are governed by ADR 001 §4.3 stage 3a, one layer up.
 *
 * Returns a NEW Map and mutates nothing. Entities with no family counterpart (`cat`, `pad`,
 * `pref`) and entities with no publication record return their truth registers unchanged.
 *
 * This is the owner side of ADR 004 §4. The VIEWER side has no promotion at all: a foreign
 * entity is read from `pub.*` only, because its truth fields were never transmitted and cannot
 * exist. Passing a foreign key here is a caller bug and throws.
 *
 * @param {RegisterMap} regs
 * @param {string} truthKey  `note:<uuid>` / `bar:<uuid>` / `cat:<uuid>` / `pad:<YYYY-MM>`
 * @param {string} me        MemberId — the owner, i.e. this human
 * @returns {Map<string, Register>}
 */
export function promoteEntity(regs, truthKey, me) {
  if (!isMemberId(me)) {
    throw new RegisterError(`promoteEntity: \`me\` must be a MemberId, got ${JSON.stringify(me)}`);
  }
  const parsed = parseEntityKey(truthKey);
  if (!parsed) throw new RegisterError(`promoteEntity: not an entity key: ${JSON.stringify(truthKey)}`);
  if (isFamilyKind(parsed.kind)) {
    throw new RegisterError(
      `promoteEntity: ${truthKey} is a family key — a viewer reads pub.* only and never promotes (ADR 004 §4.2)`,
    );
  }

  const out = new Map(regs.get(truthKey) ?? []);
  const famKind = FAMILY_OF[parsed.kind];
  if (!famKind) return out;

  const fam = regs.get(familyKey(famKind, me, parsed.id));
  if (fam === undefined) return out;
  if (withdrawnByOther(fam, me)) return out;         // ← story 18.3. See withdrawnByOther().

  for (const field of coEditableFields(parsed.kind)) {
    const effective = promoteRegister(out.get(field), fam.get(pubFieldFor(field)), me);
    if (effective === undefined) out.delete(field);
    else out.set(field, effective);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4.1 THE LWW SEAM — which write is standing, and whether mine is one of them
//     (story 18.5 · deliverable 23 · LZP-904 · ADR 004 §8 · ADR 001 §5 step 2, §6)
// ─────────────────────────────────────────────────────────────────────────────
//
// ═══ WHY THIS LIVES HERE AND NOT IN THE UI ═══════════════════════════════════════════════════
//
// 18.5 is FOUR requirements, and only the first is a merge rule: "the later change wins per
// field". That rule is already the whole of this module — `cmpWrites`, `applyOp`, and (for the
// owner) `promoteRegister`. It is property-tested for commutativity, associativity, idempotence
// and totality, and ADR 004 §8 is explicit that the notice which follows is "a UI observation of
// the fold, NEVER a merge rule".
//
// The failure mode this seam exists to prevent is therefore not a bug in the notice. It is a
// SECOND RESOLUTION RULE: a UI module that, in order to say "your edit lost", re-derives who won
// by comparing timestamps — or worse, by comparing values — and drifts from the fold. The
// notice would then be right about a board state that does not exist. So the question
//
//     "is the write I made still the one standing in this cell?"
//
// is answered HERE, by the same three-key `≺` and the same promotion asymmetry that decided the
// board, and `family/conflict.js` is left with no arithmetic to get wrong. It gets a boolean.
//
// ═══ WHAT IS DELIBERATELY NOT HERE ═══════════════════════════════════════════════════════════
//
// No 30-second window (that is a *policy* about in-flightness, ADR 004 §8, and it belongs with
// the clock, in `family/conflict.js`). No copy. No DOM. No notion of "recent". This function
// would give the same answer about a write from 1998, and the caller is what decides that
// nobody wants to hear about it.

/**
 * @typedef {Object} Displacement
 * @property {string} entity  the entity key that was asked about
 * @property {string} field   the field that was asked about
 * @property {string} by      the MEMBER who now holds the cell (`Register.author`) — 17.6's
 *                            "von Mama". Never a device: see the `Register` typedef.
 * @property {string} stamp   the winning write's stamp
 * @property {string|null} op the winning write's OpId, or null for a repaired register (REG-26)
 */

/**
 * The write that is STANDING in one cell — i.e. the one the board is currently drawn from.
 *
 * For a family key (`fnote:`/`fbar:`) that is simply the folded cell: a viewer reads `pub.*` and
 * has no promotion at all, because a foreign entity's truth fields were never transmitted
 * (ADR 004 §4.2).
 *
 * For a truth key (`note:`/`bar:`) it is the cell AFTER promotion, because promotion is what
 * `materialize.js` renders and therefore what the human sees. This function calls
 * `promoteEntity()` rather than reproducing its four lines, for the reason `promoteRegister`
 * already gives at length: two implementations of a correctness heart is one too many, and only
 * one of them has P7c pointed at it. The cost is one small `Map` per call, over a set of cells
 * bounded by what one human touched in the last half-minute.
 *
 * @param {RegisterMap} regs
 * @param {string} key    an entity key, truth or family
 * @param {string} field  the field name AS THE OP WROTE IT — `text` on a truth key, `pub.text`
 *                        on a family key. There is no translation here; the two namespaces stay
 *                        apart exactly as the module header says.
 * @param {string} me     MemberId. Required on BOTH branches, and that is not symmetry for its
 *                        own sake: the family branch does not promote, but `displacedBy` below
 *                        has to be able to ask "is the standing author me", and a caller with no
 *                        member id has no family, hence no co-editor, hence no question. Making
 *                        it required is what stops a solo board from ever reaching this code with
 *                        `me === undefined` and reading its OWN later write as somebody else's.
 * @returns {Register|undefined} `undefined` iff nothing was ever written to that cell
 */
export function standingWrite(regs, key, field, me) {
  if (!(regs instanceof Map)) throw new RegisterError('standingWrite: regs must be a RegisterMap');
  if (!isMemberId(me)) {
    throw new RegisterError(`standingWrite: \`me\` must be a MemberId, got ${JSON.stringify(me)}`);
  }
  const parsed = parseEntityKey(key);
  if (!parsed) throw new RegisterError(`standingWrite: not an entity key: ${JSON.stringify(key)}`);
  if (isFamilyKind(parsed.kind)) return regs.get(key)?.get(field);
  return promoteEntity(regs, key, me).get(field);
}

/**
 * 18.5's question, and the ONLY question this seam answers: **has the write I made been
 * displaced by somebody else's?**
 *
 * ┌───────────────────────────────────────────────────────────────────────────────────────────┐
 * │ THREE REFUSALS, IN THIS ORDER, AND EACH ONE IS A PRODUCT RULE RATHER THAN A GUARD.        │
 * └───────────────────────────────────────────────────────────────────────────────────────────┘
 *
 *  1. **Nothing standing → not displaced.** An unwritten cell is not a conflict; it is a cell.
 *
 *  2. **`standing.author === me` → not displaced.** This is the one that makes 18.5 mean
 *     "two PEOPLE" instead of "two writes". `author` is the acting MEMBER (see the `Register`
 *     typedef), so it covers my own second Mac: my laptop's newer write beating my desktop's is
 *     19.4 working, not a conflict, and it must never produce a notice. Were `author` the
 *     device, every two-Mac household would be told it was fighting with itself.
 *
 *     It also, structurally, keeps the OWNER's own publication out of the picture: my `pub.text`
 *     is a projection *of* my truth (ADR 004 §4.1), so it carries `author === me` and is
 *     declined here for the same reason `promoteRegister` declines to promote it.
 *
 *  3. **`cmpWrites(standing, mine) <= 0` → not displaced.** My write is the one standing (or an
 *     equal one is), so there is nothing to say. Note that this compares by the SAME `≺` the
 *     fold used — stamp, then opId, then value — so a caller can never be told it lost a
 *     comparison the board resolved the other way.
 *
 * **`mine` need not still be in the map**, and usually is not: a displaced write leaves no trace
 * in the cell that displaced it. That is why the caller passes the write itself rather than a
 * cell reference, and it is why a displacement can be reported for an op that was never folded
 * here at all (an outbox line that lost before it was pushed).
 *
 * **This function is silent about GOVERNING fields, because it is never asked about them.** It
 * has no field table of its own and applies no filter; the caller's ledger admits only
 * `coEdit: true` fields (`ops.js` `FIELDS`), which is what keeps an admin unshare (18.3) and a
 * remote deletion (18.6) from being reported as a lost edit. ADR 004 §7 forbids an
 * "X made an entry private" notification outright, and the enforcement is the absence of those
 * fields from the ledger — one table, read by `promoteEntity` and by the caller alike.
 *
 * @param {RegisterMap} regs
 * @param {string} key    the entity key my write named
 * @param {string} field  the field my write named
 * @param {{stamp: string, op?: string|null, value?: any}} mine  MY write, as the op carried it
 * @param {string} me     MemberId
 * @returns {Displacement|null}
 */
export function displacedBy(regs, key, field, mine, me) {
  if (!mine || typeof mine !== 'object' || !isStamp(mine.stamp)) {
    throw new RegisterError(`displacedBy: \`mine\` must carry a stamp, got ${JSON.stringify(mine)}`);
  }
  const standing = standingWrite(regs, key, field, me);
  if (standing === undefined) return null;                        // 1
  if (standing.author === me) return null;                        // 2
  if (cmpWrites(standing, mine) <= 0) return null;                // 3
  return Object.freeze({
    entity: key,
    field,
    by: standing.author,
    stamp: standing.stamp,
    op: typeof standing.op === 'string' && standing.op !== '' ? standing.op : null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Serialization — the checkpoint payload (ADR 001 §7.2, §9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * JSON-safe, and KEY-SORTED at both levels on purpose. Two devices that folded the same op set
 * in different delivery orders hold Maps with different insertion orders; sorting makes their
 * serialized checkpoints BYTE-IDENTICAL, so "did these two devices converge?" is a string
 * comparison in a test, in a diagnostic and in the fleet harness. It costs one sort per save of
 * a file written at most every few thousand ops.
 *
 * `value + stamp + author` is what ops.contract.js §3 requires; `op` is the retained OpId
 * tiebreak (see the `Register` typedef).
 *
 * @param {RegisterMap} regs @returns {Object}
 */
export function serializeRegisters(regs) {
  if (!(regs instanceof Map)) throw new RegisterError('serializeRegisters: expected a RegisterMap');
  /** @type {Object<string, Object>} */
  const out = {};
  for (const e of [...regs.keys()].sort(byString)) {
    const fields = regs.get(e);
    const bag = {};
    for (const f of [...fields.keys()].sort(byString)) {
      const r = fields.get(f);
      Object.defineProperty(bag, f, {
        value: { value: r.value, stamp: r.stamp, author: r.author, op: r.op },
        enumerable: true, writable: true, configurable: true,
      });
    }
    Object.defineProperty(out, e, { value: bag, enumerable: true, writable: true, configurable: true });
  }
  return { v: REGISTER_FORMAT, regs: out };
}

/**
 * Where a checkpoint repair is recorded. A Symbol, and non-enumerable, so it is invisible to
 * `JSON.stringify`, to `assert.deepEqual` and to every existing reader of a RegisterMap —
 * `deserializeRegisters` keeps its `(blob) => RegisterMap` signature, and a caller that never
 * heard of repairs (`oplog.js:load`) is unaffected.
 */
const REPAIRS = Symbol('registers.repairs');

/** @type {readonly Object[]} */
const NO_REPAIRS = Object.freeze([]);

/**
 * What `deserializeRegisters` had to repair to load this map — `[]` for a clean file.
 *
 * The report is the second half of REG-26's fix and is not decoration: "we quietly rewrote part
 * of your board" is exactly the class of event principle 6 („nichts geht verloren") requires the
 * app to be able to SAY. The store surfaces it; a diagnostic prints it; a test asserts on it.
 *
 * @param {RegisterMap} regs a map returned by `deserializeRegisters`
 * @returns {readonly {entity:string, field:string, reason:string, was:string, message:string}[]}
 */
export function deserializeRepairs(regs) {
  if (!(regs instanceof Map)) throw new RegisterError('deserializeRepairs: expected a RegisterMap');
  return /** @type {any} */ (regs)[REPAIRS] ?? NO_REPAIRS;
}

/** A hostile checkpoint may put anything in `op`; a report is prose and must stay bounded. */
function brief(v) {
  let s;
  try { s = typeof v === 'string' ? JSON.stringify(v) : String(v); } catch { s = '(unprintable)'; }
  return s.length > 40 ? `${s.slice(0, 37)}…` : s;
}

/**
 * @param {Object} blob
 * @param {{ onRepair?: (repair: Object) => void }} [o] `onRepair` is called once per repaired
 *        register, in file order, after the whole blob has loaded. The same records are
 *        retrievable from the returned map with `deserializeRepairs`, which is how the one-arg
 *        callers (`oplog.js:load`) reach them.
 * @returns {RegisterMap}
 *
 * STRICT on shape, TOLERANT on vocabulary, and — for the ONE field whose loss costs attribution
 * rather than correctness — REPAIRING. A register whose stamp, author or value is malformed
 * throws: those three decide where the write sits in `≺`, and pretending a corrupt one is fine
 * would poison the order for every future merge. A register whose FIELD NAME or ENTITY KIND this
 * build does not know is retained verbatim, because a checkpoint is our own already-admitted
 * state and dropping it is how a downgrade to an older build (ADR 001 §8.4's "cheap insurance
 * against a bad background update") turns "does not show the new thing" into "loses the new
 * thing". `applyOp` is stricter precisely because an OP is untrusted input from a peer and has a
 * park/reject triage of its own.
 *
 * REG-26 — WHY THE MISSING `op` IS REPAIRED AND NOT REFUSED.
 *
 * The previous shipped build (496fa0d) read `const op = r.op === undefined ? '' : r.op` and then
 * WROTE THE `''` BACK, so a user who ran last week's build can have such a register on disk
 * today, sitting among several thousand well-formed ones. The fix pass before this one made `op`
 * mandatory and threw. The safety reasoning was right — an unattributed register must not rank as
 * the weakest possible write, because `''` ranked BELOW every real opId and let a re-delivered op
 * at the identical stamp beat the ADR 004 §5.3 forget blank, un-blanking retracted plaintext —
 * but throwing turns one lost attribution into a REFUSAL OF THE WHOLE BOARD FILE, with no partial
 * load and no repair path. That trade is upside down: eleven years of appointments against one
 * missing 22-character id.
 *
 * So the safety is kept exactly where it belongs — in `opKey`, which ranks an unattributed write
 * ABOVE every real one, making it absorbing, so only a genuinely GREATER stamp (the owner
 * publishing again) can displace it — and the door repairs instead of refusing:
 *
 *   · the value, the stamp and the author are taken as they are; nothing the user can see moves;
 *   · `op` is normalised to `null`, i.e. "attribution known-lost", which `opKey` reads as
 *     absorbing and which is honest on the next save (`serializeRegisters` writes `"op":null`,
 *     and re-loading that repairs it to the same thing — the repair is idempotent and the file's
 *     bytes stop drifting);
 *   · the event is REPORTED, per register, so nothing about it is silent.
 *
 * Losing one attribution beats losing the file.
 */
export function deserializeRegisters(blob, o = {}) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) {
    throw new RegisterError('deserializeRegisters: options must be an object');
  }
  if (o.onRepair !== undefined && typeof o.onRepair !== 'function') {
    throw new RegisterError('deserializeRegisters: onRepair must be a function');
  }
  if (blob === null || typeof blob !== 'object' || Array.isArray(blob)) {
    throw new RegisterError('deserializeRegisters: blob is not an object');
  }
  if (blob.v !== REGISTER_FORMAT) {
    throw new RegisterError(`deserializeRegisters: unknown format version ${JSON.stringify(blob.v)}`);
  }
  const src = blob.regs;
  if (src === null || typeof src !== 'object' || Array.isArray(src)) {
    throw new RegisterError('deserializeRegisters: blob.regs is not an object');
  }

  const out = new Map();
  /** @type {Object[]} */
  const repairs = [];
  for (const e of Object.keys(src)) {
    if (typeof e !== 'string' || e.length === 0 || !e.includes(':')) {
      throw new RegisterError(`deserializeRegisters: ${JSON.stringify(e)} is not an entity key`);
    }
    const fields = src[e];
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new RegisterError(`deserializeRegisters: ${e} does not carry a field bag`);
    }
    const ent = new Map();
    for (const f of Object.keys(fields)) {
      if (f === '__proto__' || f === 'constructor' || f === 'prototype') {
        throw new RegisterError(`deserializeRegisters: ${e} carries the forbidden field ${JSON.stringify(f)}`);
      }
      const r = fields[f];
      if (r === null || typeof r !== 'object' || Array.isArray(r)) {
        throw new RegisterError(`deserializeRegisters: ${e}.${f} is not a register`);
      }
      if (!isStamp(r.stamp)) throw new RegisterError(`deserializeRegisters: ${e}.${f} has no valid stamp`);
      if (!isMemberId(r.author)) throw new RegisterError(`deserializeRegisters: ${e}.${f} has no valid author`);
      if (!('value' in r)) throw new RegisterError(`deserializeRegisters: ${e}.${f} has no value (absent is not null — R9)`);
      if (!isScalar(r.value)) throw new RegisterError(`deserializeRegisters: ${e}.${f} value is not a JSON scalar or null`);
      // `op` is REPAIRED, not refused — REG-26, and the long note on this function says why.
      // Everything the user can see (value, stamp, author) is already validated above and is
      // taken verbatim; only the 22-character attribution is missing, and it is normalised to
      // `null` so `opKey` ranks the write ABSORBING instead of weakest. A truncated writer, a
      // lossy JSON round-trip, a hostile checkpoint and — the case that actually happens — a file
      // written by build 496fa0d, which coerced a missing `op` to `''` and wrote it back, all
      // land here and all load.
      let op = r.op;
      if (!isOpId(op)) {
        repairs.push(Object.freeze({
          entity: e,
          field: f,
          reason: 'unattributed-register',
          was: brief(op),
          message:
            `${e}.${f} carries no usable op id (${brief(op)}); its value, stamp and author were ` +
            'kept and the attribution was cleared. It now ranks ABOVE every attributed write at ' +
            'the same stamp, so a re-delivered op cannot undo it (ADR 004 §5.3).',
        }));
        op = null;
      }
      ent.set(f, Object.freeze({ value: r.value, stamp: r.stamp, author: r.author, op }));
    }
    out.set(e, ent);
  }
  if (repairs.length) {
    Object.defineProperty(out, REPAIRS, {
      value: Object.freeze(repairs), enumerable: false, writable: false, configurable: false,
    });
    if (o.onRepair) for (const rep of repairs) o.onRepair(rep);
  }
  return out;
}
