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
 * `deserializeRegisters` now REFUSES a checkpoint register without an OpId (see there), so within
 * this build an unattributed write cannot exist; this rank is the defence in depth behind that
 * refusal. Ranking a missing opId LOWEST — which is what `a.op ?? ''` used to do — made every real
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
 * @param {Object} blob @returns {RegisterMap}
 *
 * STRICT on shape, TOLERANT on vocabulary. A register whose stamp, author or value is malformed
 * throws — the file is corrupt and pretending otherwise would poison the order. A register whose
 * FIELD NAME or ENTITY KIND this build does not know is retained verbatim, because a checkpoint
 * is our own already-admitted state and dropping it is how a downgrade to an older build (ADR
 * 001 §8.4's "cheap insurance against a bad background update") turns "does not show the new
 * thing" into "loses the new thing". `applyOp` is stricter precisely because an OP is untrusted
 * input from a peer and has a park/reject triage of its own.
 */
export function deserializeRegisters(blob) {
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
      // `op` IS MANDATORY, exactly like stamp / author / value. It is SHAPE, not vocabulary, and
      // the doctrine above is "strict on shape". `serializeRegisters` has always written it, and
      // `oplog.js`'s forget pass already documents its dependence on it ("registers.js refuses a
      // checkpoint whose `op` is not an OpId"), so nothing legitimate produces a register without
      // one — only a truncated writer, a lossy JSON round-trip or a hostile checkpoint does.
      //
      // Accepting one and storing `''` is what let a re-pull UN-BLANK a retracted field: `''`
      // ranked BELOW every real opId, so any re-delivered op at the identical stamp beat the
      // ADR 004 §5.3 forget blank that deliberately kept that stamp. Refusing the file is the
      // safer of the two available fixes, because it stops the unattributed register at the door
      // instead of reasoning about how it ranks once it is inside; `opKey` above then ranks a
      // missing opId highest as the defence in depth behind this check, so the two failure modes
      // are "the corrupt file is refused" and, if one ever slips past, "the retraction holds" —
      // never "the retraction is undone".
      if (!isOpId(r.op)) throw new RegisterError(`deserializeRegisters: ${e}.${f} has a malformed op id`);
      ent.set(f, Object.freeze({ value: r.value, stamp: r.stamp, author: r.author, op: r.op }));
    }
    out.set(e, ent);
  }
  return out;
}
