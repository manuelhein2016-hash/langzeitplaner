// src/js/core/project.js — THE SINGLE CHOKE POINT THROUGH WHICH PLAINTEXT LEAVES A DEVICE.
//
// ADR 004 §2, §2.1, §2.2 barriers 1 and 2, §2.3, §5, §5.1 · ADR 002 §5 (`sealOp`'s branded-patch
// precondition) · ADR 001 §3.1 (the truth / `pub.*` register split) · ops.contract.js §6.
//
// DOM-free, side-effect-free, imports nothing outside `core/` (ADR 004 §2, ADR 005 §2).
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE AXIOM THIS FILE IS
//
//   "Plaintext leaves a device through exactly one function, and that function is
//    projectForFamily()."  — ADR 002 §0. Everything in ADR 004 is a supporting argument for it.
//
// THE INVARIANT, quoted from ADR 004's own headline:
//
//   For every op sealed under a FAMILY key, for every entity whose level at seal time is not
//   `geteilt`, the op's field patch contains no content field with a non-null value. It is
//   asserted on the EMITTED OPS and on the SEALED BYTES — never on the rendering. A rendering
//   bug can therefore produce the wrong pixels; it cannot produce a leak.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// FOUR THINGS ALREADY LEARNED THE HARD WAY, RESTATED HERE BECAUSE THE NEXT READER OF THIS FILE
// IS THE PERSON WHO WOULD OTHERWISE REDISCOVER THEM
//
//  1. INV-R4 — THE EXPLICIT-NULL RULE (risk R9). The family materializer is a per-field LWW fold.
//     A downgrade that OMITS a field rather than writing an explicit `null` performs NO REGISTER
//     WRITE for it: the old register keeps its value and its stamp and every peer's board keeps
//     rendering the text. The entry looks correctly downgraded on my board and stays fully
//     readable on Mama's, and no owner-side smoke test catches it, because the owner's board is
//     right. OMISSION IS NOT WITHDRAWAL.
//
//     The construction below makes omission structurally impossible rather than remembered:
//     `projectForFamily` ALWAYS emits every row of `GETEILT_FIELDS[kind]` — the union of both
//     allowlists, since BELEGT ⊂ GETEILT — carrying a VALUE where the level permits one and an
//     EXPLICIT `null` where it does not. There is no code path in which a withdrawable field is
//     absent from a patch, so there is nothing for a future edit to forget.
//
//  2. BARRIER 4 WAS BROKEN ONCE (finding S5) AND IS FIXED IN `crypto/envelope.js`: the level is
//     re-derived from the AUTHENTICATED register map — the entity's own `visibility` TRUTH
//     register — never from the caller. THIS FILE MUST NOT REINTRODUCE A CALLER-DECLARED LEVEL.
//     Two consequences, both load-bearing:
//       · `pub.level` in the emitted patch is a RESTATEMENT of the `level` argument, which the
//         caller is contractually obliged to have read from that same truth register. It is
//         checked at the seal seam against the map; it can never move the level a single step.
//       · The agreement check at `assertTruthAgrees` below reads `truth.visibility` — the TRUTH
//         register — and NEVER `truth.level`, which on a materialized entry is the PUBLISHED
//         level (`materialize.js:ownCandidate`: "`level` is what the FAMILY sees; `visibility` is
//         my truth register"). Comparing against the published level is exactly the mis-named
//         source that made the old formula need its `??`, and the `??` was the hole.
//
//  3. INV-R3 — THE OWNER ALWAYS SEES THE TRUTH. This file never writes a truth register and never
//     reads a `pub.*` one. It is a projection OF the truth, never an edit TO it, which is why
//     publishing `pub.text: null` to make an entry Belegt does not blank my own note. The rule
//     that makes that true lives in `materialize.js:promote` ("never promote my own `pub.*`
//     writes"); this file's obligation is only to never be the thing that violates it.
//
//  4. `RedactionError` MUST BE LOUD (risk R13). It is thrown on the publish path, which runs
//     inside the `queueMicrotask` after `emit()` (ADR 001 §0.9) — where an unhandled rejection is
//     plausible. `PUBLISH_FAILURE_CONTRACT` at the bottom of this file states the normative
//     obligation that puts on `store._publishAndEnqueue`, executably, so it can be run rather
//     than remembered: STOP THE SYNC LOOP, set the `error` sync state, never log-and-skip. A
//     silently omitted downgrade op is exactly the §5.1 failure.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT IS ABSENT FROM THE ALLOWLISTS, AND WHY ABSENCE IS THE MECHANISM
//
//   categoryId          A3. Categories are NEVER synced, at any level, and that is enforced by
//                       THE ABSENCE OF A FIELD, not by a filter someone can forget to apply.
//                       There is no `pub.categoryId` register in `ops.js:FIELDS` either, so a
//                       category cannot be published even by a caller who hand-builds a patch.
//   owner               it IS the entity key (`fnote:<memberId>/<uuid>`, ADR 001 §4.4). There is
//                       no owner register to backdate and one fewer thing that can disagree.
//   member colour       derived from the member record on the VIEWER's device (ADR 004 §4.2).
//   member initial      likewise.
//   text / label        absent from BELEGT — this is INV-R1 itself.
//   coEdit              absent from BELEGT. Co-editing dates you can see while the text stays
//                       hidden is incoherent (ADR 004 §8).
//
// ═════════════════════════════════════════════════════════════════════════════════════════════

import { FIELDS, pubSet, noteSet, barSet } from './ops.js';
import { VISIBILITY_LEVELS, parseEntityKey, familyKey, isMemberId } from './entities.js';
import { isStamp } from './stamp.js';

// ─────────────────────────────────────────────────────────────────────────────
// 0. Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ADR 004 §2.2's barrier refusing to project or to assert. The SIBLING of
 * `crypto/envelope.js`'s class of the same name, not its rival: that one is raised by the SEAL
 * seam (barriers 3 and 4), this one by the PROJECTION seam (barriers 1 and 2).
 *
 * They are deliberately two classes with one `name`, because `envelope.js` may not import from
 * `core/` in the reverse direction for a shared base and `core/project.js` may not import from
 * `crypto/` at all (ADR 005 §2). A caller that catches by NAME — which is what the §2.3 loud
 * failure path does — catches both; a caller that catches by identity must catch both classes.
 * `PUBLISH_FAILURE_CONTRACT.catchBy` states that so a store implementation can run it.
 *
 * `barrier` is machine-readable so a test can report WHICH invariant refused without reading an
 * error message: `'barrier1'` (the projection's own construction), `'barrier2'`
 * (`assertFamilyPatch`), `'A3'` (a category), `'INV-R1'` (content above the level), `'INV-R4'`
 * (a withdrawal that is not one), `'shape'` (a malformed argument).
 */
export class RedactionError extends Error {
  /** @param {string} message @param {string} [barrier] */
  constructor(message, barrier = 'shape') {
    super(message);
    this.name = 'RedactionError';
    this.barrier = barrier;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The allowlists (ADR 004 §2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Freeze a literal all the way down.
 *
 * ADR 004 §2 prints `Object.freeze({ fnote: [...], fbar: [...] })`, which freezes the WRAPPER and
 * leaves the arrays writable: `GETEILT_FIELDS.fnote.push('categoryId')` would then silently widen
 * the allowlist from anywhere in the process, and every barrier downstream would agree that the
 * category is allowed, because they all ask this table. An allowlist that can be appended to at
 * run time is not an allowlist. Reported as an ADR wording gap.
 */
function deepFreeze(x) {
  if (x === null || typeof x !== 'object') return x;
  for (const k of Object.keys(x)) deepFreeze(x[k]);
  return Object.freeze(x);
}

/** The two family entity kinds. Validated against BEFORE any table is indexed — see `kindOf`. */
export const FAMILY_KINDS = deepFreeze(['fnote', 'fbar']);

/**
 * Every field a GETEILT entry publishes. Verbatim from ADR 004 §2, in ADR order, deep-frozen.
 * @type {Readonly<{fnote: ReadonlyArray<string>, fbar: ReadonlyArray<string>}>}
 */
export const GETEILT_FIELDS = deepFreeze({
  fnote: ['pub.level', 'pub.alive', 'pub.date', 'pub.repeatsYearly', 'pub.coEdit', 'pub.text'],
  fbar: ['pub.level', 'pub.alive', 'pub.startDate', 'pub.endDate', 'pub.coEdit', 'pub.label'],
});

/**
 * Every field a BELEGT entry publishes. A STRICT SUBSET of `GETEILT_FIELDS` — the difference is
 * exactly `{text|label, coEdit}`, which is INV-R1 and ADR 004 §8 written as a set difference.
 * @type {Readonly<{fnote: ReadonlyArray<string>, fbar: ReadonlyArray<string>}>}
 */
export const BELEGT_FIELDS = deepFreeze({
  fnote: ['pub.level', 'pub.alive', 'pub.date', 'pub.repeatsYearly'],
  fbar: ['pub.level', 'pub.alive', 'pub.startDate', 'pub.endDate'],
});
// Note what is absent from BOTH lists, at every level:
//   categoryId  (A3)  ·  owner  (it is the entity key)  ·  memberColor / initial (derived)
// Note what is absent from BELEGT: text, label, coEdit.

/**
 * `_born`, and nothing else.
 *
 * IT IS NOT ON EITHER ALLOWLIST AND IT IS STILL REQUIRED, so it is named here rather than
 * smuggled into one of them. ADR 004 §5's transition table writes `'_born': …` on the FIRST
 * publication (the Privat→Belegt and Privat→Geteilt rows) and `ops.js:FIELDS` carries
 * `fnote._born` / `fbar._born` for that reason — "without it the first publication of an entry
 * could not carry its create stamp and `createdAt` (ADR 001 §1.4) would be undefined for every
 * foreign entry."
 *
 * KEEPING THE TWO LISTS BYTE-IDENTICAL TO THE ADR IS THE POINT. A reviewer comparing §2's code
 * block against this file must find no difference; a third, differently-named list makes the
 * exception visible instead of hiding it inside the thing it is an exception to. And `_born` is
 * not content: it is a stamp, its shape is checked with `isStamp` at every seam that admits it,
 * and its only source is the entity's own write-once truth register.
 */
export const STRUCTURAL_FIELDS = deepFreeze({ fnote: ['_born'], fbar: ['_born'] });

/**
 * The two GOVERNING rows: the level itself and the tombstone. They are not content, they are
 * emitted at every level, and neither is ever withdrawn by a downgrade — a downgrade RESTATES
 * them. `authz.js` folds them in stage 3a, ahead of everything a co-editor may write.
 */
export const GOVERNING_FIELDS = deepFreeze(['pub.level', 'pub.alive']);

/**
 * WHICH TRUTH FIELD EACH PUBLISHED FIELD IS A PROJECTION OF. The rename in ADR 004 §2.1's table,
 * as data, so that the construction below never spells a truth field name inline.
 *
 * `pub.level` and `pub.alive` are absent on purpose: `pub.level` comes from the `level` ARGUMENT
 * (which barrier 4 re-derives from `visibility`, and which the seal seam checks), and `pub.alive`
 * is normalized from `_alive` rather than passed through — see `aliveOf`.
 *
 * `categoryId` HAS NO ROW HERE AND NO ROW IN `ops.js:FIELDS[fnote|fbar]`. That is A3: two
 * independent tables, neither of which can name a category, and no filter to forget.
 */
export const TRUTH_SOURCE = deepFreeze({
  fnote: { 'pub.date': 'date', 'pub.repeatsYearly': 'repeatsYearly', 'pub.coEdit': 'coEdit', 'pub.text': 'text' },
  fbar: { 'pub.startDate': 'startDate', 'pub.endDate': 'endDate', 'pub.coEdit': 'coEdit', 'pub.label': 'label' },
});

/**
 * The fields a CO-EDITOR may write (ADR 001 §4.3 stage 3b, ADR 004 §8) — DERIVED from
 * `ops.js:FIELDS`' own `coEdit` marks rather than restated, so it cannot drift from the table
 * `authz.js` admits against. A governing field can never appear here, which is why "a co-editor
 * can never grant themselves co-edit" needs no rule of its own.
 */
export const COEDIT_FIELDS = deepFreeze(Object.fromEntries(
  FAMILY_KINDS.map((k) => [k, Object.keys(FIELDS[k]).filter((f) => FIELDS[k][f].coEdit === true)]),
));

/**
 * THE FLOOR, not a fallback (ADR 004 §3, `core/visibility.js:DEFAULT_VISIBILITY`).
 *
 * Spelled here rather than imported, because this module owns which BYTES may leave and
 * `core/visibility.js` owns the level POLICY: an import would make every product question about
 * levels a reason to touch the most security-critical file in the project, and files edited for
 * cosmetic reasons stop being reviewed line by line. The two are held together by a test that
 * asserts they agree, not by an edge — the same construction `DISCLOSURE` uses against §2.1.
 */
const DEFAULT_LEVEL = 'privat';

/** Every spelling of a category that must never appear in a family patch (A3). */
const CATEGORY_SPELLINGS = deepFreeze(['categoryId', 'pub.categoryId', 'cat', 'pub.cat', 'category']);

// ─────────────────────────────────────────────────────────────────────────────
// 2. The brand — ADR 004 §2.2 barrier 3's other half
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ A GLOBAL-REGISTRY SYMBOL, AND THAT IS A DELIBERATE STRUCTURAL CHOICE, NOT A SHORTCUT.
 *
 * ADR 004 §2 requires this module to import NOTHING outside `core/`, and ADR 005 §2's import
 * direction forbids `core/ -> crypto/` besides. So this file cannot import a brand token from
 * `crypto/envelope.js`, and `envelope.js` cannot import one from here without inverting the
 * direction the purity gate enforces. `Symbol.for` is the one token both sides can name without
 * importing anything: it resolves out of the cross-realm global symbol registry, so
 * `Symbol.for('lzp/v2/family-patch')` here and in `envelope.js` are THE SAME SYMBOL.
 *
 * WHAT THIS BRAND IS NOT: a capability, and unforgeable. Any caller can write the symbol onto an
 * object. It is not trying to be. Barrier 3's job, in ADR 004's own words, is that "no future
 * caller can bypass the allowlist, INCLUDING ONE WRITTEN BY A DOWNSTREAM AGENT WHO NEVER READ
 * THIS DOCUMENT" — and a downstream agent does not stumble into `Symbol.for('lzp/v2/family-patch')`
 * with a well-formed evidence object beside it. They either read ADR 004 or they get a
 * `RedactionError`. Someone who deliberately forges the brand has to RESTATE the redaction
 * decision in the evidence, and the seal seam then checks that restatement against the
 * authenticated register map (barrier 4) and against `FIELDS`' `geteiltOnly` marks (the backstop).
 */
export const FAMILY_PATCH_BRAND = Symbol.for('lzp/v2/family-patch');

/**
 * @typedef {Object} FamilyPatchBrand
 * @property {1} v
 * @property {'projectForFamily'} source  one producer, named.
 * @property {'fnote'|'fbar'} kind
 * @property {'privat'|'belegt'|'geteilt'} level  the level the projection ACTUALLY APPLIED,
 *   restated so barrier 4 has something to compare the register map against. NEVER a value the
 *   caller supplied that this module did not itself validate and use.
 * @property {ReadonlyArray<string>} fields  the rows this projection emitted.
 */

/**
 * Attach the brand and seal the patch shut.
 *
 * NON-ENUMERABLE IS REQUIRED, NOT STYLISTIC: `canonicalJSON` walks `Object.keys`, so an
 * enumerable brand would be sealed into the ciphertext and become wire format. A symbol key is
 * never enumerated by `Object.keys` anyway, so the two protections agree and neither is load
 * bearing alone. `writable:false, configurable:false` means a patch cannot be RE-BRANDED at a
 * different level after the projection decided — barrier 4's attack, one step earlier.
 *
 * AND THEN THE PATCH ITSELF IS FROZEN. ADR 004 §2's contract does not require it and this module
 * does it anyway, because the cheapest way past an allowlist is not to argue with it: it is to
 * take the object it produced and add a key. A frozen patch means the set of published fields is
 * decided exactly once, by the function that read the allowlist, and cannot be widened afterwards
 * by anyone — including by this file's own callers, and including in a `queueMicrotask` two
 * layers away where nobody is reading ADR 004.
 *
 * ⚠ THE OBLIGATION THIS PUTS ON EVERY CALLER, and it is a real one: a `structuredClone` or a
 * JSON round trip of the op between here and `sealOp` DROPS THE SYMBOL and un-freezes the copy,
 * and the clone is then refused at barrier 3. That refusal is loud, immediate and correct — but
 * it will look like a bug in this module, so: the patch this function returns must reach `sealOp`
 * BY REFERENCE. Asserted by `PUBLISH_FAILURE_CONTRACT.byReference`.
 */
function brandAndFreeze(patch, kind, level, fields) {
  Object.defineProperty(patch, FAMILY_PATCH_BRAND, {
    value: Object.freeze({
      v: 1,
      source: 'projectForFamily',
      kind,
      level,
      fields: Object.freeze([...fields]),
    }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(patch);
}

/**
 * Read the brand back. `null` when absent or malformed — the caller decides what that means, and
 * for `sealOp` it means refusal. A local copy of `envelope.js:familyPatchBrand` and not an import
 * (see `FAMILY_PATCH_BRAND`); the two read the same symbol and validate the same five clauses.
 * @param {any} patch @returns {FamilyPatchBrand|null}
 */
export function familyPatchBrand(patch) {
  if (patch === null || typeof patch !== 'object') return null;
  const ev = patch[FAMILY_PATCH_BRAND];
  if (ev === null || typeof ev !== 'object') return null;
  if (ev.v !== 1 || ev.source !== 'projectForFamily') return null;
  if (!FAMILY_KINDS.includes(ev.kind)) return null;
  if (!VISIBILITY_LEVELS.includes(ev.level)) return null;
  if (!Array.isArray(ev.fields)) return null;
  return ev;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Argument validation — the boring half of barrier 1
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ VALIDATE THE KIND BEFORE INDEXING ANY TABLE WITH IT.
 *
 * `GETEILT_FIELDS` is a plain object, so `GETEILT_FIELDS['toString']` is a FUNCTION, not
 * `undefined`, and `new Set(GETEILT_FIELDS['constructor'])` throws a `TypeError` rather than a
 * `RedactionError`. A prototype-chain name reaching a table lookup would turn a refusal into an
 * engine error, and §2.3's loud failure path catches `RedactionError` — so the one class of bug
 * that must never be quiet would arrive wearing the wrong name.
 */
function kindOf(kind, where) {
  if (!FAMILY_KINDS.includes(kind)) {
    throw new RedactionError(
      `${where}: ${JSON.stringify(kind)} is not a family entity kind. Only ${FAMILY_KINDS.join(' and ')} `
      + 'are projected; a personal-space entity is never published (ADR 004 §1).', 'shape');
  }
  return kind;
}

function levelOf(level, where) {
  if (!VISIBILITY_LEVELS.includes(level)) {
    throw new RedactionError(
      `${where}: ${JSON.stringify(level)} is not a visibility level. The level is re-derived from `
      + 'the authenticated `visibility` truth register (ADR 004 §2.2 barrier 4) and there is '
      + 'nothing to project at a level that does not exist.', 'barrier1');
  }
  return level;
}

/** A JSON scalar or null — the only thing a register may hold (ADR 001 §2). */
const isScalarOrNull = (v) => v === null
  || typeof v === 'string' || typeof v === 'boolean'
  || (typeof v === 'number' && Number.isFinite(v));

/**
 * Read one truth field EXACTLY ONCE.
 *
 * Once, because `truth` is an object the caller owns and a getter that answers `'harmlos'` to the
 * type check and `'Scheidungsanwalt 14:30'` to the value read is the cheapest way through a
 * projection that inspects a field twice. Every read below goes through this function and lands
 * in a `const`.
 *
 * A value that is not a JSON scalar becomes `null` — an EXPLICIT withdrawal, never an omission
 * (INV-R4), and never a coercion: `{toString(){…}}` does not become a string, `undefined` does not
 * become `''`. A string is passed through VERBATIM even when it is malformed for its declared
 * type, so a bad `YYYY-MM-DD` fails loudly at `validateOp` inside `sealOp` instead of silently
 * becoming a `null` that erases the family's copy of a real booking.
 */
function readOnce(truth, name) {
  const v = truth[name];
  return isScalarOrNull(v) ? v : null;
}

/**
 * `pub.alive` is the one field NORMALIZED rather than passed through, because absence must not be
 * readable as "maybe dead": it is the tombstone (ADR 004 §5, `materialize.js`'s `projectable`
 * step 3), it is a governing field, and a `null` there would leave a peer with no answer at all.
 * Only an explicit `_alive === false` means dead. An entry materialized for display has had
 * `_alive` renamed to `alive` and then stripped (`materialize.js:finish`), so both spellings are
 * read — and a caller who has neither is publishing a live entry, which is the only entry the
 * arrays it came from can contain.
 */
function aliveOf(truth) {
  const under = truth._alive;
  if (under === false) return false;
  if (under === true) return true;
  return truth.alive !== false;
}

/**
 * BARRIER 1's agreement check, and the one place this file could have reintroduced finding S5.
 *
 * It reads `truth.visibility` — MY TRUTH REGISTER — and never `truth.level`, which on a
 * materialized entry is the PUBLISHED level, i.e. the level a transition is moving AWAY from.
 * Comparing the argument against the published level would make every legitimate share disagree
 * and would be the exact mis-named source that made barrier 4's old formula need a fallback onto
 * the caller's value. Comparing it against `visibility` costs nothing and is free defence: the
 * `level` argument is contractually the value of that same register, so a disagreement means the
 * caller read one entity and handed us another.
 *
 * Silence is not disagreement. A truth object with no `visibility` (registers on a fresh device,
 * a caller assembling one field at a time) asserts nothing and is not refused here — barrier 4 at
 * the seal seam still re-derives the level from the map, and an absent answer there is a refusal.
 *
 * AN ANSWER OUTSIDE THE SET IS A REFUSAL, NEVER SILENCE, and that is barrier 4's own rule applied
 * one seam earlier: "an answer from the map outside `privat|belegt|geteilt` (including `null` and
 * `undefined`) is a REFUSAL, never a fallback to the patch". `null` and `undefined` are the two
 * that ADR 004 §2.2 has to name because the map genuinely has no answer for most entities on a
 * fresh device mid-pull; a `visibility` register holding `'oeffentlich'` is a different thing —
 * `ops.js` types it as an enum, so no op this build would accept could have written it, and an
 * entry whose level register says something impossible is not one to publish on a guess.
 *
 * Treating it as silence is also what lets the brand quietly restate it: `brand.level =
 * truth.visibility ?? level` is indistinguishable from `level` on every OTHER input, and the
 * mutant that writes it survives a domain in which no truth object carries an impossible level.
 * The `alien-vis` row of R1 is that input.
 */
function assertTruthAgrees(truth, level) {
  const declared = truth.visibility;
  if (declared === undefined || declared === null) return;
  if (!VISIBILITY_LEVELS.includes(declared)) {
    throw new RedactionError(
      `projectForFamily: the entry's \`visibility\` truth register holds ${JSON.stringify(declared)}, `
      + 'which is not a visibility level. There is nothing to re-derive FROM and the argument may '
      + 'not supply one — refusing rather than publishing on a guess (ADR 004 §2.2 barrier 4, '
      + 'applied one seam earlier).', 'barrier1');
  }
  if (declared === level) return;
  throw new RedactionError(
    `projectForFamily: the entry's own \`visibility\` truth register says ${JSON.stringify(declared)} `
    + `but the projection was asked for ${JSON.stringify(level)}. Refusing rather than picking one — `
    + 'the level is the authenticated one (ADR 004 §2.2 barrier 4) and a disagreement means the '
    + 'caller read one entity and handed us another.', 'barrier1');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. `projectForFamily` — ADR 004 §2
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the family-space field patch for one entry. PURE. Side-effect-free. Never mutates
 * `truth`.
 *
 * ADDITIVE CONSTRUCTION FROM A FROZEN ALLOWLIST. Never `delete p.text`, never
 * `{...entry, text: undefined}`: both are ONE REFACTOR AWAY from publishing a field somebody adds
 * to `Note` next year. The loop below starts from an empty object and can only ever write a key
 * that `GETEILT_FIELDS[kind]` names, so a new truth field is published only when someone edits
 * that list — which shows up in review.
 *
 * WHAT IT ALWAYS EMITS (this is INV-R4 made structural, see the header):
 *   every row of `GETEILT_FIELDS[kind]`, in ADR order —
 *     · `pub.level`  the level argument, restated for the receiver (ADR 004 §4.2 renders from it)
 *     · `pub.alive`  the tombstone, normalized to a boolean
 *     · a VALUE for each remaining row the level's allowlist permits
 *     · an EXPLICIT `null` for each remaining row it does not
 *   plus `_born` on a FIRST publication only (ADR 004 §5's Privat→Belegt / Privat→Geteilt rows).
 *
 * THREE CASES RETURN `null` — "there is nothing to publish", which costs zero bytes on the wire
 * and is 16.1's "private by default":
 *   · `level === 'privat'` and the entry was never published        — 16.1, a Privat entry
 *     (`lastPublished` is `null` or `'privat'`)                       produces NO FAMILY OP AT ALL
 *   · the entry is DEAD and was never published                      — publishing a tombstone for
 *                                                                      something nobody ever saw
 *                                                                      LEAKS ITS EXISTENCE
 *   · nothing else. Every other input produces a patch.
 *
 * @param {'fnote'|'fbar'} kind
 * @param {Object} truth   the entity's MATERIALIZED truth fields — promotion (ADR 004 §4.1)
 *   already applied, so a co-editor's newer `pub.date` is what gets republished and a visibility
 *   change does not silently revert it. Reading raw truth registers here would make every
 *   transition an unmarked overwrite of every co-editor's work.
 * @param {'privat'|'belegt'|'geteilt'} level   THE AUTHENTICATED LEVEL, read by the caller from
 *   this entity's own `visibility` truth register. Not an intent, not a request.
 * @param {'privat'|'belegt'|'geteilt'|null} lastPublished  the level this entity was last
 *   published at, or `null` for never. It decides only WHETHER there is anything to say, never
 *   WHAT is said.
 * @returns {Object|null} a frozen, branded patch, or `null` when there is nothing to publish.
 * @throws {RedactionError}
 */
export function projectForFamily(kind, truth, level, lastPublished) {
  kindOf(kind, 'projectForFamily');
  levelOf(level, 'projectForFamily');

  if (truth === null || typeof truth !== 'object' || Array.isArray(truth)) {
    throw new RedactionError(
      `projectForFamily: \`truth\` must be the entity's materialized fields, not ${
        Array.isArray(truth) ? 'an array' : JSON.stringify(truth)}. A projection with no entry to `
      + 'project is a bug on this device, not an empty publication.', 'shape');
  }
  if (lastPublished !== null && !VISIBILITY_LEVELS.includes(lastPublished)) {
    throw new RedactionError(
      `projectForFamily: \`lastPublished\` must be a level or null, not ${JSON.stringify(lastPublished)}. `
      + '`undefined` is not "never published" — say `null`, so a missing argument is a refusal '
      + 'rather than a silent first publication.', 'shape');
  }

  assertTruthAgrees(truth, level);

  const wasPublished = lastPublished !== null && lastPublished !== 'privat';
  const alive = aliveOf(truth);

  // 16.1 — a Privat entry produces no family op at all. There is exactly one thing that
  // legitimately travels at Privat and it is a WITHDRAWAL of what was published before.
  if (level === 'privat') return wasPublished ? retractPatch(kind) : null;

  // Publishing a tombstone for an entry that was never published announces that it existed —
  // and the entry it announces is one 16.1 kept off the wire entirely.
  if (!alive && !wasPublished) return null;

  const rows = GETEILT_FIELDS[kind];
  const source = TRUTH_SOURCE[kind];
  // THE ALLOWLIST FOR THIS LEVEL. Everything not in it is withdrawn, explicitly, below.
  const permitted = new Set(level === 'geteilt' ? GETEILT_FIELDS[kind] : BELEGT_FIELDS[kind]);

  const patch = {};
  const emitted = [];
  for (const field of rows) {
    let value;
    if (field === 'pub.level') {
      value = level;
    } else if (field === 'pub.alive') {
      value = alive;
    } else if (!alive) {
      // A DEAD entry publishes its tombstone and NOTHING ELSE, at any level (ADR 004 §5, the
      // "delete while published" row: `pub.alive:false` plus all content fields → null). The
      // nulls are what make §5.3's forget pass have something to act on and what stop a later
      // re-share from resurrecting stale text through a register nobody overwrote (§5.1).
      value = null;
    } else if (permitted.has(field)) {
      value = readOnce(truth, source[field]);
    } else {
      // THE WITHDRAWAL. This is the whole of INV-R4 and it is not conditional on the transition:
      // a field outside this level's allowlist is written `null` on EVERY publish, so there is no
      // ordering, no "did we come from Geteilt", and nothing for a later edit to forget.
      value = null;
    }
    patch[field] = value;
    emitted.push(field);
  }

  // `_born` on a FIRST publication only (ADR 004 §5). Write-once, a stamp, never content — and
  // omitted rather than guessed when the truth register does not carry one, because a `createdAt`
  // that is missing is a cosmetic gap and a `_born` that is invented is a protocol violation.
  if (!wasPublished) {
    const born = truth._born;
    if (isStamp(born)) {
      patch._born = born;
      emitted.push('_born');
    }
  }

  // The projection asserts its own output before anyone sees it. Barrier 2 is injected into the
  // seal seam and runs again there; running it HERE too means a caller that never reaches
  // `sealOp` — a test, a snapshot writer, a future exporter — cannot hold an unasserted patch.
  assertFamilyPatch(patch, kind, level);

  return brandAndFreeze(patch, kind, level, emitted);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. `retractPatch` — ADR 004 §5.1, the downgrade path
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every withdrawable field, EXPLICITLY null, plus `pub.level: 'privat'`.
 *
 * ⚠ `pub.alive` IS `null` HERE AND ADR 004 §5.1's CODE BLOCK SAYS `false`. THE `null` IS RIGHT,
 * AND THIS IS THE ONE PLACE THIS FILE KNOWINGLY DEPARTS FROM A PRINTED ADR SNIPPET. Three
 * independent pieces of shipped code say so, and the ADR's own §5 prose says so too:
 *
 *   1. `crypto/envelope.js` barrier 4 refuses any family patch at `privat` carrying a non-null
 *      value in any field but `pub.level` — "a downgrade to privat writes explicit nulls and
 *      nothing else". `pub.alive: false` IS such a value. A retraction shaped as §5.1's code
 *      block CANNOT BE SEALED AT ALL.
 *   2. `core/authz.js:classifyUnsharePatch` PARKS (does not apply) a patch carrying a non-null
 *      value beside `pub.level: 'privat'`. A `false` would arrive at every peer as version skew.
 *   3. `core/authz.js:unsharePatch` — the admin's retraction, already shipped — writes
 *      `'pub.alive': null`, and `tests/tier1/core-integration.test.js:1012` carries the note
 *      "NOTE FOR WP-10: `project.js:retractPatch('fnote')` must produce this byte for byte."
 *
 * And ADR 004 §5's transition TABLE agrees: the admin-unshare row is "`pub.level:'privat'`, all
 * content → null" with no `pub.alive: false` in it. §5.1's `false` is a stale snippet.
 *
 * IT IS ALSO THE BETTER ANSWER, not merely the compatible one. One retraction shape means the
 * owner's own "→ Privat" and the admin's unshare are BYTE-IDENTICAL on the wire, so a peer cannot
 * tell which happened — Principle 9, "no surveillance mechanics", enforced by the absence of a
 * distinguishing byte rather than by a policy. And nothing is lost: a peer drops the entity on
 * `pub.level === 'privat'` before it ever consults the tombstone (ADR 004 §4.2,
 * `materialize.js`'s `projectable`).
 *
 * The full set is emitted on EVERY retraction regardless of what was published before, because
 * "which fields did this entity ever carry" is a question with a different answer on every peer,
 * and INV-R4 is a claim about all of them.
 *
 * @param {'fnote'|'fbar'} kind
 * @returns {Object} a frozen, branded patch — directly sealable, so nobody hand-builds one.
 */
export function retractPatch(kind) {
  kindOf(kind, 'retractPatch');
  const rows = GETEILT_FIELDS[kind];
  const patch = {};
  for (const field of rows) patch[field] = field === 'pub.level' ? 'privat' : null;
  assertFamilyPatch(patch, kind, 'privat');
  return brandAndFreeze(patch, kind, 'privat', rows);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5b. `derivePublication` — ops.contract.js §6, and the seam WP-10 declared blocked
// ─────────────────────────────────────────────────────────────────────────────

/** Read one folded register value, or `undefined`. `regs.get(key)` is a `Map` of name → cell. */
function foldedValue(regs, entityKey, name) {
  if (!regs || typeof regs.get !== 'function') return undefined;
  let cells;
  try { cells = regs.get(entityKey); } catch { return undefined; }
  if (!cells || typeof cells.get !== 'function') return undefined;
  const cell = cells.get(name);
  return cell === undefined || cell === null ? undefined : cell.value;
}

/**
 * THE ONE CALLER OF `projectForFamily` IN THE PRODUCT. `ops.contract.js` §6 declares it; nothing
 * implemented it, which is why `core/project.js` shipped as an orphan and `sealOp` refused every
 * family `pub.set` at barrier 2. PURE, and every seam it needs is a port.
 *
 * ── WHY IT IS DERIVED FROM STATE RATHER THAN EMITTED BY THE VISIBILITY CONTROL ──────────────
 *
 * `store.js`'s own header states the rule the outbox is built on: *"every path that appends a
 * local op is in the outbox automatically, with no publish hook to forget at one of them. A
 * separate queue would have to be written to at six call sites and would drift at the seventh."*
 * A publication minted by the sharing control would be exactly that seventh site — and it would
 * be missing from ⌘Z, from a text edit of an already-shared entry, from a delete, and from
 * `interact.js`'s drag. `core/undo.js` has already decided this in the other direction: `pub.set`
 * is deliberately NOT undoable, because *"undoing the truth and letting the publisher re-derive is
 * the only path that cannot leave the family space describing a state the owner's board no longer
 * holds."* That sentence only becomes true if a publisher re-derives, and this is it.
 *
 * So the question this function answers is never "what did the user just do" but always **"does
 * what the family holds still equal the projection of what I hold?"** — and it emits exactly the
 * ops that close the difference. Idempotent by construction: run it twice and the second run
 * emits nothing, which is what stops a keystroke storm from becoming an op storm.
 *
 * ── WHAT IT REFUSES TO GUESS ────────────────────────────────────────────────────────────────
 *
 *   · An entity whose `visibility` truth register is ABSENT is `privat` (`DEFAULT_VISIBILITY`) —
 *     a v1 board that has never met E7 publishes nothing, which is 16.1 for the whole existing
 *     corpus at once. It is a FLOOR, not a fallback: a register holding something outside the
 *     enum reaches `assertTruthAgrees` and is refused, never rounded down.
 *   · A key naming anybody else is skipped. Ownership is read off the key (ADR 001 §4.4); this
 *     device publishes its own entries and nobody else's, and there is no flag to disagree with.
 *   · `truthOf` is REQUIRED. ADR 004 §4.1 requires the MATERIALIZED entry — promotion applied —
 *     and raw registers are not that: publishing them would silently overwrite a co-editor's
 *     newer `pub.date` with the owner's older one on every visibility change.
 *
 * @param {Array<Object>} localOps  the ops just applied to the personal space
 * @param {Object} regs             the RegisterMap, POST-apply
 * @param {Object} ctx              an OpCtx (`act`, `dev`, `gid`, `mint`, `newOpId`, `newGid`,
 *   `space`, `familySpaceId`) extended with:
 *   `me` the owning MemberId, and `truthOf(truthKind, uuid) -> Object|null`, the materialized
 *   truth fields of one entity.
 * @returns {Array<Object>} `pub.set` ops — empty when solo, or when the family already holds the
 *   projection of what this device holds.
 * @throws {RedactionError}
 */
export function derivePublication(localOps, regs, ctx) {
  if (!Array.isArray(localOps) || localOps.length === 0) return [];
  if (ctx === null || typeof ctx !== 'object') {
    throw new RedactionError('derivePublication: `ctx` must be an OpCtx', 'shape');
  }
  if (ctx.familySpaceId === null || ctx.familySpaceId === undefined) return [];
  const me = ctx.me ?? ctx.act;
  if (typeof me !== 'string' || me === '') {
    throw new RedactionError('derivePublication: `ctx.me` must be this device\'s MemberId', 'shape');
  }
  if (typeof ctx.truthOf !== 'function') {
    throw new RedactionError(
      'derivePublication: `ctx.truthOf(truthKind, uuid)` is required. ADR 004 §4.1 requires the '
      + 'MATERIALIZED entry — promotion applied — and raw registers are not that: a visibility '
      + 'change would republish the owner\'s stale value over a co-editor\'s newer one.', 'shape');
  }

  // 1. WHICH OF MY ENTITIES DID THIS TRANSACTION TOUCH. In first-seen order, deduplicated, so a
  //    group that writes one entity twice publishes once.
  const touched = [];
  const seen = new Set();
  for (const op of localOps) {
    if (op === null || typeof op !== 'object') continue;
    if (op.k !== 'note.set' && op.k !== 'bar.set') continue;
    if (op.act !== me) continue;               // ownership is read off the op's author, never a flag
    const parsed = parseEntityKey(op.e);
    if (!parsed || (parsed.kind !== 'note' && parsed.kind !== 'bar')) continue;
    if (seen.has(op.e)) continue;
    seen.add(op.e);
    touched.push({ truthKind: parsed.kind, uuid: parsed.id });
  }
  if (touched.length === 0) return [];

  const out = [];
  for (const { truthKind, uuid } of touched) {
    const kind = truthKind === 'note' ? 'fnote' : 'fbar';
    const fkey = familyKey(kind, me, uuid);

    const truth = ctx.truthOf(truthKind, uuid);
    if (truth === null || typeof truth !== 'object') continue;   // gone from the board entirely

    // THE LEVEL. `visibility` — the truth register — and never `pub.level`, which is the level a
    // transition is moving AWAY from (finding S5). The same value is what `store.familyLevelOf`
    // answers at the seal seam, so `brand.level === level` holds by construction rather than by
    // two seams happening to agree.
    const declared = truth.visibility;
    const level = declared === undefined || declared === null ? DEFAULT_LEVEL : declared;

    const lastRaw = foldedValue(regs, fkey, 'pub.level');
    const lastPublished = VISIBILITY_LEVELS.includes(lastRaw) ? lastRaw : null;

    const patch = projectForFamily(kind, truth, level, lastPublished);
    if (patch === null) continue;                                // 16.1 — zero bytes on the wire

    // 2. IS THE FAMILY ALREADY HOLDING THIS? A publication that changes no register is an op
    //    nobody needs and a byte on the wire that says a transaction happened. Compare by value
    //    against the FOLDED family registers; `_born` is write-once, so an entity that already
    //    has one is not re-born by a repeat.
    let differs = false;
    for (const k of Object.keys(patch)) {
      const held = foldedValue(regs, fkey, k);
      if (k === '_born') { if (held === undefined) differs = true; continue; }
      // `undefined` (never written) is never equal to a value the projection wants to state —
      // including `null`, which is a WITHDRAWAL and must reach a peer that already holds a value.
      if (held !== patch[k]) { differs = true; }
    }
    if (!differs) continue;

    // BY REFERENCE, all the way to `sealOp`. `pubSet` -> `makeOp` copies the patch and carries the
    // brand's symbol across; a `structuredClone` or a spread anywhere on this path drops it and
    // barrier 3 refuses the clone (PUBLISH_FAILURE_CONTRACT.byReference).
    out.push(pubSet(ctx, kind, me, uuid, patch));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5c. THE ADMIN UNSHARE — story 18.3, LZP-903 (ADR 004 §5's last transition row)
//
//   "As admin I can unshare any entry from the family space — it reverts to owner-private, it is
//    never deleted — so moderation is possible but non-destructive, and I still can't read what
//    was never shared."
//
// Three properties, and each one is a STRUCTURAL consequence of something in this file rather
// than a rule the admin's code remembers:
//
//   IT REVERTS.       The op writes `pub.level: 'privat'` plus an explicit null to every other
//                     withdrawable register (INV-R4). ADR 004 §4.2 drops a `privat` publication
//                     before it ever consults the tombstone, so the entity leaves every peer's
//                     board — and `retractPatch` is the SAME function the owner's own „→ Privat"
//                     calls, so the two are byte-identical on the wire.
//   IT NEVER DELETES. The patch is `pub.*` ONLY. There is no `_alive` in it (`retractPatch` walks
//                     `GETEILT_FIELDS`, which has no `_alive` row, and `pub.alive` is nulled, not
//                     set false), and this device cannot write the owner's personal space at all:
//                     `core/ops.js:spaceFor` addresses a `note.set` to MY personal space and the
//                     owner's truth registers do not exist here. The entry survives on the
//                     owner's board, in full, in their category colour.
//   IT NEVER READS.   The op is built from the KIND alone. `adminUnshareOp` is handed no `truth`
//                     object, has no parameter that could carry one, and reads no register of the
//                     entity. An admin CANNOT unshare what was never shared, because a Privat
//                     entry has no family entity key on their device to name.
//
// AND IT IS NOT AUTHORISED HERE. `crypto/envelope.js`'s barrier-4 retraction clause refuses to
// seal it unless the folded admin chain names this author, and `core/authz.js` stage 3a decides
// it again, from `op.ts`, on every device including the admin's own. D7: ownership is structural
// and enforcement is by convergence.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Story 18.3 as claims, so a test asserts the RULE and not a message. The client-side half of
 * `crypto/envelope.js:RETRACTION_CLAUSE`.
 */
export const ADMIN_UNSHARE_CONTRACT = Object.freeze({
  story: '18.3',
  adr: 'ADR 004 §5 (admin unshare row), §5.1 · ADR 001 §4.1, §4.3 stage 3a · D7',
  clauses: Object.freeze([
    'It reverts: the patch is retractPatch(kind) — pub.level "privat" plus an explicit null in '
      + 'every other withdrawable register. Omission is not withdrawal (INV-R4).',
    'It never deletes: the patch carries no `_alive`, touches no personal-space register, and '
      + '`pub.alive` is NULLED rather than set false. The owner keeps the entry.',
    'It never reads: adminUnshareOp takes (ctx, {kind, owner, uuid}) and no truth object. There '
      + 'is no parameter through which content could enter, and nothing that was never shared has '
      + 'a family entity key on the admin\'s device to name.',
    'It is byte-identical to the owner\'s own "→ Privat": one producer, retractPatch(kind), '
      + 'which takes the kind and nothing else. A peer cannot tell which happened (Principle 9).',
    'It is not authorised here. crypto/envelope.js barrier 4\'s retraction clause refuses to seal '
      + 'it unless the folded admin chain names op.act; core/authz.js stage 3a decides it again '
      + 'on every device from op.ts. Enforcement is by convergence, not by gatekeeper (D7).',
    'The owner\'s device reconciles afterwards with adminUnshareFollowUp(regs, ctx) — one '
      + 'personal-space `visibility: "privat"` write per moderated entity, and no notification '
      + 'of any kind (Principle 9, NO_SNITCH_CONTRACT.noNotification).',
  ]),
});

/**
 * THE ADMIN'S RETRACTION OP. One `pub.set`, addressed to somebody else's family entity, carrying
 * `retractPatch(kind)` and nothing else.
 *
 * ⚠ WHY IT LIVES IN THIS FILE AND NOT IN `family/unshare.js`. ADR 002 §0's axiom is that
 * plaintext leaves a device through exactly one function. An unshare carries no plaintext — that
 * is the whole of it — but the OP that carries it must be branded to be sealable (barrier 3), and
 * a moderation driver that minted its own would have exactly one way forward: forge
 * `Symbol.for('lzp/v2/family-patch')`. `projectCoEditPatch` is the precedent, and the reasoning
 * there is the reasoning here: a narrow, reviewed door is strictly safer than the hand-rolled one
 * its absence guarantees.
 *
 * IT IS DELIBERATELY ARITY-2 AND CONTENT-BLIND. There is no `truth` parameter, no `level`
 * parameter and no patch parameter. The only thing a caller can vary is WHICH entity — which is
 * all 18.3 gives an admin — and the bytes are a function of the KIND alone.
 *
 * @param {Object} ctx  an OpCtx with `familySpaceId` set (`store._ctx()`)
 * @param {{kind:'fnote'|'fbar', owner:string, uuid:string}} spec  the entity to unshare
 * @returns {Object} one frozen `pub.set` op, its patch branded at `privat`
 * @throws {RedactionError}
 */
export function adminUnshareOp(ctx, spec) {
  if (ctx === null || typeof ctx !== 'object') {
    throw new RedactionError('adminUnshareOp: `ctx` must be an OpCtx', 'shape');
  }
  if (ctx.familySpaceId === null || ctx.familySpaceId === undefined) {
    throw new RedactionError(
      'adminUnshareOp: this device is in no Familienkreis. `core/ops.js:spaceFor` cannot address a '
      + 'family op at any space, and there is nothing to unshare FROM (story 15.1).', 'shape');
  }
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new RedactionError(
      'adminUnshareOp: `spec` must be {kind, owner, uuid} — the entity, and nothing about its '
      + 'content. There is deliberately no parameter through which content could enter.', 'shape');
  }
  // AN UNKNOWN KEY IS A REFUSAL, NEVER AN IGNORED ARGUMENT. `{kind, owner, uuid}` is the whole of
  // what an admin may say about an entry, and a caller that also passes `truth`, `level` or `f`
  // has misunderstood this door badly enough that silently dropping it would hide the mistake —
  // and "we simply never pass one" is a habit, where this is a property (18.3: it never reads).
  for (const key of Object.keys(spec)) {
    if (key === 'kind' || key === 'owner' || key === 'uuid') continue;
    throw new RedactionError(
      `adminUnshareOp: \`spec\` carries "${key}". An unshare names an ENTITY and says nothing `
      + 'about its content — {kind, owner, uuid} is the whole vocabulary, and an extra key is a '
      + 'caller that thinks this function can be told what to publish (story 18.3).', 'shape');
  }
  const kind = kindOf(spec.kind, 'adminUnshareOp');
  if (!isMemberId(spec.owner)) {
    throw new RedactionError(
      `adminUnshareOp: \`owner\` must be the MemberId the entity key carries, not ${
        JSON.stringify(spec.owner)}. Ownership is STRUCTURAL (ADR 001 §4.4) — an unshare names the `
      + 'owner because the key does, never because a flag says so.', 'shape');
  }
  if (typeof spec.uuid !== 'string' || spec.uuid === '') {
    throw new RedactionError(
      `adminUnshareOp: \`uuid\` must be the entity's uuid, not ${JSON.stringify(spec.uuid)}.`, 'shape');
  }
  // BY REFERENCE to `pubSet`, exactly as `derivePublication` is: the brand is a non-enumerable
  // symbol and a clone anywhere on this path drops it (PUBLISH_FAILURE_CONTRACT.byReference).
  return pubSet(ctx, kind, spec.owner, spec.uuid, retractPatch(kind));
}

/**
 * THE OWNER'S SIDE OF 18.3, and the half without which "it reverts" is only true until the owner
 * next touches the entry.
 *
 * ADR 004 §5's admin-unshare row: *"On receipt, the owner's client also sets its local
 * `visibility` to `'privat'` in a follow-up txn so the two agree."* Measured, and it is not
 * cosmetic. `derivePublication` reads the level from the `visibility` TRUTH register and
 * `lastPublished` from the folded `pub.level`. After a moderation those two disagree — truth
 * still says `geteilt`, the family holds `privat` — so the owner's very next keystroke on that
 * entry projects a full Geteilt patch again, `differs` is true, and **the moderation is silently
 * undone by an edit that had nothing to do with it**. The admin sees the text come back and has
 * no way to tell whether the owner re-shared on purpose.
 *
 * So the owner's device closes the disagreement the way the ADR says: ONE personal-space write.
 * It is not a rejection of the admin's op and it does not delete anything — the entry stays on
 * the owner's board, in full, exactly as 18.3 requires; only its exposure follows what the family
 * actually holds. A later re-share is then a deliberate act with a visible control, which is what
 * 16.1 means by "oversharing is structurally impossible".
 *
 * ⚠ IT NOTIFIES NOBODY. No warning, no marker, no „Papa hat deinen Eintrag entfernt". Principle 9
 * and `visibility.js:NO_SNITCH_CONTRACT.noNotification`: there is no op kind that could carry
 * one, and this function returns only `note.set`/`bar.set` ops carrying exactly `{visibility}`.
 *
 * ⚠ IT RECONCILES DEAD ENTITIES TOO, and that is deliberate. A tombstoned entry that keeps
 * `visibility: 'geteilt'` in its truth register republishes in full the moment the owner's ⌘Z
 * resurrects it (18.6) — which would resurrect moderated content through an undo of something
 * else. `derivePublication` emits nothing for the write itself (privat + never-published → null),
 * so the reconciliation costs zero family bytes.
 *
 * IDEMPOTENT BY CONSTRUCTION. It emits only where the two registers DISAGREE, so a second run
 * over the same map emits nothing — the same "does the family still equal my projection?" shape
 * `derivePublication` has, one register to the left.
 *
 * @param {Object} regs  the RegisterMap, POST-apply
 * @param {Object} ctx   an OpCtx extended with `me` (this device's MemberId)
 * @returns {Array<Object>} `note.set`/`bar.set` ops carrying exactly `{visibility:'privat'}`
 */
export function adminUnshareFollowUp(regs, ctx) {
  if (ctx === null || typeof ctx !== 'object') {
    throw new RedactionError('adminUnshareFollowUp: `ctx` must be an OpCtx', 'shape');
  }
  if (ctx.familySpaceId === null || ctx.familySpaceId === undefined) return [];
  const me = ctx.me ?? ctx.act;
  if (!isMemberId(me)) {
    throw new RedactionError(
      'adminUnshareFollowUp: `ctx.me` must be this device\'s MemberId. Ownership is read off the '
      + 'entity key (ADR 001 §4.4) and there is nothing to compare it against.', 'shape');
  }
  if (!regs || typeof regs.keys !== 'function') return [];

  const out = [];
  // Sorted, so the ops are a function of the SET of registers and not of Map insertion order —
  // two of my Macs folding the same log must produce the same follow-up.
  for (const entityKey of [...regs.keys()].sort()) {
    const parsed = parseEntityKey(entityKey);
    if (!parsed) continue;
    const kind = parsed.kind;
    if (kind !== 'fnote' && kind !== 'fbar') continue;
    if (parsed.owner !== me) continue;              // somebody else's entry: not mine to reconcile
    if (foldedValue(regs, entityKey, 'pub.level') !== 'privat') continue;

    const truthKind = kind === 'fnote' ? 'note' : 'bar';
    const truthKey = `${truthKind}:${parsed.id}`;
    const held = foldedValue(regs, truthKey, 'visibility');
    // Silence agrees. An absent register is `DEFAULT_LEVEL` (16.1's floor for a v1 board), and a
    // register holding something outside the enum is NOT rounded down to privat here: it is left
    // for `assertTruthAgrees` on the publish path, which refuses rather than guesses.
    if (held === undefined || held === null || held === DEFAULT_LEVEL) continue;
    if (!VISIBILITY_LEVELS.includes(held)) continue;

    out.push((truthKind === 'note' ? noteSet : barSet)(ctx, parsed.id, { visibility: DEFAULT_LEVEL }));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. `projectCoEditPatch` — the co-editor's door (ADR 004 §8, LZP-902/904)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A CO-EDITOR's write into `pub.*`, projected.
 *
 * NOT IN ADR 004 §2's export list, and here anyway, for one reason: ADR 002 §0's axiom is that
 * plaintext leaves a device through EXACTLY ONE function, and a co-editor's write is plaintext
 * leaving a device. §8 says "a co-editor's write goes into `pub.*` and is admitted by ADR 001
 * §4.3 stage 3b" and names no producer for it. Without a door here, the agent who builds 18.2
 * has a patch that `sealOp` refuses and exactly one way forward: forge the brand. A narrow,
 * reviewed door is strictly safer than the hand-rolled one its absence guarantees.
 *
 * It is DELIBERATELY NARROWER than `projectForFamily` on every axis:
 *   · `level` must be `'geteilt'`. `pub.coEdit` exists only at Geteilt (ADR 004 §2.1, §8), so
 *     there is no level at which a co-editor may write anything at all except that one.
 *   · only the fields `ops.js:FIELDS` itself marks `coEdit: true` — DERIVED, not restated, so it
 *     cannot drift from what `authz.js` stage 3b will admit.
 *   · NO GOVERNING FIELD, ever. `pub.level`, `pub.coEdit`, `pub.alive` and `_born` are folded in
 *     stage 3a from the owner or the admin alone, which is why "a co-editor can never grant
 *     themselves co-edit" is a consequence of the staged fold rather than a rule anyone enforces.
 *     A caller that names one gets a refusal, not a silent drop: silently dropping it would make
 *     an op that says one thing and does another.
 *   · a partial patch is correct here and would be wrong in `projectForFamily`. INV-R4 is about
 *     WITHDRAWALS; a co-editor withdraws nothing, and re-publishing fields they did not touch
 *     would overwrite the owner's newer values at the co-editor's stamp.
 *
 * @param {'fnote'|'fbar'} kind
 * @param {'geteilt'} level  the authenticated level of the entity, re-derived by the caller.
 * @param {Object} changes   `{'pub.text': 'Bescherung 18:00'}` — the fields actually edited.
 * @returns {Object} a frozen, branded patch.
 * @throws {RedactionError}
 */
export function projectCoEditPatch(kind, level, changes) {
  kindOf(kind, 'projectCoEditPatch');
  levelOf(level, 'projectCoEditPatch');
  if (level !== 'geteilt') {
    throw new RedactionError(
      `projectCoEditPatch: a co-editor may write only at geteilt, not at ${JSON.stringify(level)}. `
      + '`pub.coEdit` exists at no other level (ADR 004 §2.1, §8) — co-editing dates you can see '
      + 'while the text stays hidden is incoherent.', 'barrier1');
  }
  if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new RedactionError('projectCoEditPatch: `changes` must be a plain object', 'shape');
  }

  const permitted = new Set(COEDIT_FIELDS[kind]);
  const patch = {};
  const emitted = [];
  for (const field of Object.keys(changes)) {
    if (!permitted.has(field)) {
      throw new RedactionError(
        `projectCoEditPatch: "${field}" is not a co-editable field of ${kind}. A co-editor writes `
        + `only ${COEDIT_FIELDS[kind].join(', ')}; every governing field is folded in stage 3a from `
        + 'the owner alone (ADR 001 §4.3, ADR 004 §8).', 'barrier1');
    }
    // NOT `readOnce`'s "anything odd becomes null". For the PROJECTION a null is a withdrawal and
    // the safe reading of a malformed truth field; for a CO-EDITOR a null is an EDIT that clears
    // the owner's text (`materialize.js:promote` — "a null from a co-editor is promoted like any
    // other value"). Turning `undefined` into a deletion of someone else's note is not a safe
    // default, so it is a refusal.
    const v = changes[field];
    if (!isScalarOrNull(v)) {
      throw new RedactionError(
        `projectCoEditPatch: "${field}" carries ${JSON.stringify(v) ?? typeof v}, which is not a `
        + 'JSON scalar (ADR 001 §2). A co-editor\'s `null` CLEARS the owner\'s value, so a '
        + 'malformed change is refused rather than quietly turned into one.', 'shape');
    }
    patch[field] = v;
    emitted.push(field);
  }
  if (emitted.length === 0) return null;

  assertFamilyPatch(patch, kind, level);
  return brandAndFreeze(patch, kind, level, emitted);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. `assertFamilyPatch` — ADR 004 §2.2 barrier 2
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Throws `RedactionError` BEFORE ANYTHING IS SEALED. Injected into the seal seam as
 * `ctx.assertFamilyPatch`, where `sealOp` REFUSES to seal a family `pub.set` without it — a
 * security check that is skipped when absent is not a security check.
 *
 * `level` MUST have been re-derived by the caller from the authenticated register map, never
 * taken from an argument the same caller supplied to `projectForFamily` (ADR 004 §2.2 barrier 4).
 * `sealOp` passes the value it re-derived; this function trusts that and asserts nothing about
 * where it came from, because it cannot see the map.
 *
 * ── THREE PLACES THIS IS STRICTER THAN §2.2's PRINTED CODE, each with the input that made it ──
 *
 *  (a) `Object.hasOwn(FIELDS[kind], k)`, NOT `k in FIELDS[kind]`. `in` walks the prototype chain,
 *      so §2.2's null escape reads `'toString' in FIELDS.fnote` as TRUE and lets `{toString: null}`
 *      through — and `envelope.js`'s backstop, which does `const f = spec[name]`, reads the
 *      inherited function as a field spec and lets it through too. Both barriers, one prototype.
 *      The value is null so nothing leaks today; the hole is that a name nobody declared is
 *      travelling, and the next person to add a `k in` check will not be so lucky.
 *
 *  (b) `patch['pub.text'] !== null`, NOT `patch['pub.text'] ||`. §2.2's truthiness test lets
 *      `pub.text: ''` past at Belegt, and `ops.js` says in its own words that "a blank note text
 *      is a legitimate value" — which is exactly why `null` had to be reserved for "redacted".
 *      An empty string below Geteilt is a VALUE reaching a family key. `envelope.js`'s backstop
 *      already refuses it (`patch[name] !== null`), so the printed barrier 2 was the WEAKER of
 *      the two and the one advertised as the allowlist's own assertion.
 *
 *  (c) A PRIVAT patch may carry `pub.level: 'privat'` and explicit nulls, and nothing else. §2.2
 *      indexes `BELEGT_FIELDS` for every non-Geteilt level, so at Privat it would admit a real
 *      `pub.date` — a booking published for an entry 16.1 says produces no family op at all.
 *      `envelope.js` barrier 4 refuses it at the seal seam; barrier 2 is supposed to be the
 *      barrier that does not depend on reaching the seal seam.
 *
 * @param {Object} patch @param {'fnote'|'fbar'} kind @param {'privat'|'belegt'|'geteilt'} level
 * @returns {void}
 * @throws {RedactionError}
 */
export function assertFamilyPatch(patch, kind, level) {
  kindOf(kind, 'assertFamilyPatch');
  levelOf(level, 'assertFamilyPatch');
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new RedactionError(
      `assertFamilyPatch: the patch must be a plain object, not ${
        Array.isArray(patch) ? 'an array' : JSON.stringify(patch)}`, 'shape');
  }

  // ⚠ NO ACCESSORS, AND THIS RUNS BEFORE EVERY OTHER CHECK. A patch is scalars-only data (ADR
  // 001 §2), and a property whose value is COMPUTED is the one shape that can answer `null` to
  // this function and the real text to `canonicalJSON` a few frames later. Every barrier reads
  // the patch by property access — this one, `envelope.js`'s backstop, `validateOp` — so all
  // three read the FIRST answers and the AEAD seals the LAST: a time-of-check/time-of-use gap in
  // the one function whose entire job is the check. `projectForFamily` never builds such a patch
  // (it writes plain values and freezes them); this refuses the hand-built one that does, one
  // barrier before the brand would have to.
  for (const k of Object.getOwnPropertyNames(patch)) {
    const d = Object.getOwnPropertyDescriptor(patch, k);
    if (d && !('value' in d)) {
      throw new RedactionError(
        `assertFamilyPatch: "${k}" is an ACCESSOR, not a value. A patch is scalars-only data `
        + '(ADR 001 §2); a computed property can answer one thing to every barrier and another to '
        + 'the serializer, and it is the second answer that gets sealed.', 'shape');
    }
  }

  // A3 SECOND, so the message is A3's. The allowlist loop below would refuse `categoryId` anyway —
  // it is on no list and it is not a field of `fnote`/`fbar`, so the null escape cannot reach it
  // either — but it would refuse it as "an unknown field", which is true and useless. ADR 004 is
  // the most security-critical document in this project and §2.3 requires its failure path to be
  // LOUD; a generic complaint shadowing the one rule everybody quotes is a quieter failure for
  // the one class of bug that must never be quiet.
  for (const name of CATEGORY_SPELLINGS) {
    if (Object.hasOwn(patch, name)) {
      throw new RedactionError(
        `assertFamilyPatch: "${name}" would leak a category to the family space. Categories are `
        + 'NEVER synced, at any level (A3, ADR 004 §2.1) — enforced by the absence of a field, and '
        + 'this is the message that says the absence was not enough.', 'A3');
    }
  }

  // INV-R1, SECOND, and before the allowlist loop for the same reason A3 went first: the loop
  // would refuse `pub.text` at Belegt as "a field outside the allowlist", which is true and says
  // nothing, while this says INV-R1 — the invariant the whole epic exists to enforce, by name, in
  // the error a human reads at 23:00. `!== null`, not truthiness — see (b) above.
  if (level !== 'geteilt') {
    for (const k of ['pub.text', 'pub.label']) {
      if (Object.hasOwn(patch, k) && patch[k] !== null) {
        throw new RedactionError(
          `assertFamilyPatch: a ${level} payload carries content in "${k}" (${
            JSON.stringify(patch[k])}) — INV-R1. Only an explicit null — a withdrawal — is `
          + 'permitted below geteilt. The text of a Belegt entry is never encoded into an op '
          + 'sealed under a family key (ADR 004 §2.1, §2.2).', 'INV-R1');
      }
    }
  }

  const allowed = new Set(level === 'geteilt' ? GETEILT_FIELDS[kind] : BELEGT_FIELDS[kind]);
  const structural = new Set(STRUCTURAL_FIELDS[kind]);

  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (allowed.has(k)) {
      // (c) — at Privat the allowlist is BELEGT's, and BELEGT's rows are still content. The only
      // thing that travels at Privat is a withdrawal.
      if (level === 'privat' && k !== 'pub.level' && v !== null) {
        throw new RedactionError(
          `assertFamilyPatch: a privat patch carries a value in "${k}" (${JSON.stringify(v)}). A `
          + 'Privat entry produces no family op at all (16.1); the one thing that legitimately '
          + 'travels at privat is a WITHDRAWAL — explicit nulls and nothing else '
          + '(ADR 004 §5.1, INV-R4).', 'INV-R4');
      }
      if (level === 'privat' && k === 'pub.level' && v !== 'privat' && v !== null) {
        throw new RedactionError(
          `assertFamilyPatch: a privat patch declares \`pub.level: ${JSON.stringify(v)}\``, 'INV-R4');
      }
      continue;
    }
    // §5's WITHDRAWAL escape: an explicit `null` clears a previously published value and must
    // pass at every level, or a downgrade could never retract a shared text. IT CAN NEVER LET A
    // VALUE THROUGH, which is the whole of the distinction. `Object.hasOwn`, not `in` — see (a).
    if (v === null && Object.hasOwn(FIELDS[kind], k)) continue;
    // `_born` — structural, write-once, a stamp, never content. See `STRUCTURAL_FIELDS`.
    if (structural.has(k) && isStamp(v)) continue;
    throw new RedactionError(
      `assertFamilyPatch: field "${k}" may not be sealed under a family key at level ${
        JSON.stringify(level)}. The allowlist for this level is [${[...allowed].join(', ')}]; `
      + 'anything else may appear only as an explicit null (a withdrawal, ADR 004 §5.1). '
      + 'Additive construction from the frozen allowlist is the rule — hand-building a patch is '
      + 'not a supported call (ADR 004 §2.2 barrier 1).', 'barrier2');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. The contracts this module puts on the seams it does not own
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ADR 004 §2.3 — THE FAILURE PATH IS LOUD, NEVER SWALLOWED — as clauses that can be run rather
 * than remembered. `src/js/store.js` owns the code; this is the specification it must satisfy,
 * kept beside the thing that throws so the two cannot drift.
 *
 * The shape deliberately mirrors `crypto/envelope.js:PROJECT_CONTRACT`, which is the contract
 * pointing the other way. Two contracts, one direction each, no third opinion.
 */
export const PUBLISH_FAILURE_CONTRACT = Object.freeze({
  module: 'src/js/store.js',
  fn: '_publishAndEnqueue',
  adr: 'ADR 004 §2.3, §5.1 · risk R13',
  catchBy: 'name',
  byReference: true,
  clauses: Object.freeze([
    'The projection runs inside the queueMicrotask after emit() (ADR 001 §0.9), where an '
      + 'unhandled rejection is plausible. `_publishAndEnqueue` wraps it in try/catch.',
    'A RedactionError STOPS THE SYNC LOOP, sets the `error` sync state, writes a local diagnostic '
      + 'and shows the settings strip. It is NEVER logged-and-skipped, because a silently omitted '
      + 'downgrade op is exactly the ADR 004 §5.1 failure: the entry looks downgraded on my board '
      + 'and stays fully readable on Mama\'s.',
    'Catch by NAME (`err.name === "RedactionError"`), not by identity: core/project.js and '
      + 'crypto/envelope.js each export a class of that name and neither may import the other '
      + '(ADR 005 §2). `err.barrier` says which invariant refused.',
    'The patch projectForFamily returns must reach sealOp BY REFERENCE. It carries a '
      + 'non-enumerable Symbol.for("lzp/v2/family-patch") brand, and structuredClone, JSON round '
      + 'trips and object spread all DROP it — the clone is then refused at barrier 3, loudly, '
      + 'which looks like a bug in the projection and is not one.',
    'The caller reads `level` from the entity\'s own `visibility` TRUTH register and passes the '
      + 'same value to projectForFamily and to sealOp\'s ctx.levelOf. Wiring either to the '
      + 'last-published `pub.level` makes every first share a barrier-4 refusal (finding S5).',
    'The caller passes the MATERIALIZED entry as `truth` — promotion (ADR 004 §4.1) already '
      + 'applied — so a visibility change does not republish a stale value over a co-editor\'s '
      + 'newer one.',
  ]),
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. `coEditOp` — the co-editor's OP door (ADR 004 §8, story 18.2 · E9 integration)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE `pub.set`, addressed to SOMEBODY ELSE'S family entity, carrying a co-editor's changes.
 *
 * ⚠ WHY IT EXISTS, AND WHY HERE. `projectCoEditPatch` (§6) produced a branded PATCH and nothing
 * that could carry it: `adminUnshareOp` is the precedent one section up, and its reasoning is the
 * reasoning here. Without this door the agent wiring 18.2 holds a correct patch, no op, and
 * exactly one way forward — mint the op by hand and forge `Symbol.for('lzp/v2/family-patch')`.
 * The whole point of a branded patch is that the brand is unreachable outside this file, so the
 * door has to be in this file too.
 *
 * ⚠ THE OWNER IS AN ARGUMENT AND THAT IS NOT A HOLE. `pubSet` builds the key from
 * `(kind, owner, uuid)`, so a caller can address any entity it can name — and it may. Ownership
 * is STRUCTURAL (ADR 001 §4.4): the key names the owner, so naming somebody else's entity is not
 * a forgery, it is the only way to say "this entry, the one that is theirs". What a co-editor may
 * then WRITE is decided three times over and never here: `projectCoEditPatch` refuses every
 * governing field, `sealOp`'s barrier 4 refuses unless the AUTHENTICATED fold says this entity is
 * `geteilt` with `pub.coEdit`, and `authz.js` stage 3b decides it again on every receiving device
 * from `op.ts` alone. This function's whole contribution is that the bytes are branded and the
 * patch is narrow. D7: enforcement is by convergence, not by gatekeeper.
 *
 * ⚠ IT TAKES `level` AND MUST NOT BE READ AS "THE CALLER DECLARES THE LEVEL". The caller passes
 * what the authenticated fold answered (`store.familyCoEditLevelOf`, which reads the folded
 * `pub.level`/`pub.coEdit` registers and nothing the caller controls); `projectCoEditPatch`
 * refuses anything but `'geteilt'`; and `sealOp` RE-DERIVES it from the same fold and refuses if
 * the two disagree. Three readings of one register — a lie here is caught one layer down, on the
 * device that told it, before any byte is sealed.
 *
 * @param {Object} ctx  an OpCtx with `familySpaceId` set (`store._ctx()`)
 * @param {{kind:'fnote'|'fbar', owner:string, uuid:string}} spec  whose entity, and which
 * @param {'geteilt'} level   the level the AUTHENTICATED fold answered for that entity
 * @param {Object} changes    `{'pub.text': '…'}` — only `FIELDS[kind]`'s `coEdit` fields
 * @returns {Object|null} one frozen `pub.set` op, or `null` when `changes` is empty
 * @throws {RedactionError}
 */
export function coEditOp(ctx, spec, level, changes) {
  if (ctx === null || typeof ctx !== 'object') {
    throw new RedactionError('coEditOp: `ctx` must be an OpCtx', 'shape');
  }
  if (ctx.familySpaceId === null || ctx.familySpaceId === undefined) {
    throw new RedactionError(
      'coEditOp: this device is in no Familienkreis. A co-edit is a write into the FAMILY space '
      + 'and there is no family space to address (story 15.1).', 'shape');
  }
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new RedactionError(
      'coEditOp: `spec` must be {kind, owner, uuid} — the entity being edited.', 'shape');
  }
  // An unknown key is a refusal, for `adminUnshareOp`'s reason: a caller that also passes `f`,
  // `patch` or `truth` has misunderstood this door badly enough that dropping it silently would
  // hide the mistake. The content travels in `changes`, through the projection, or not at all.
  for (const key of Object.keys(spec)) {
    if (key === 'kind' || key === 'owner' || key === 'uuid') continue;
    throw new RedactionError(
      `coEditOp: \`spec\` carries "${key}". A co-edit names an ENTITY — {kind, owner, uuid} is the `
      + 'whole vocabulary; the changes travel in `changes`, through `projectCoEditPatch`.', 'shape');
  }
  const kind = kindOf(spec.kind, 'coEditOp');
  if (!isMemberId(spec.owner)) {
    throw new RedactionError(
      `coEditOp: \`owner\` must be the MemberId the entity key carries, not ${
        JSON.stringify(spec.owner)}. Ownership is STRUCTURAL (ADR 001 §4.4) — a co-edit names the `
      + 'owner because the KEY does, never because a flag says so.', 'shape');
  }
  if (typeof spec.uuid !== 'string' || spec.uuid === '') {
    throw new RedactionError(
      `coEditOp: \`uuid\` must be the entity's uuid, not ${JSON.stringify(spec.uuid)}.`, 'shape');
  }
  // A CO-EDITOR NEVER ADDRESSES THEIR OWN ENTITY THROUGH THIS DOOR. Their own entries publish
  // through `derivePublication` from the TRUTH register (ADR 004 §4.1) — one producer per entity.
  // Two producers for one entity is how a stale truth value gets re-published at a fresh stamp
  // over a co-editor's newer one, which is the §5.1 failure this door must not reintroduce.
  const me = ctx.act;
  if (isMemberId(me) && spec.owner === me) {
    throw new RedactionError(
      'coEditOp: this entity is MINE. My own entries reach the family through '
      + '`derivePublication` from their `visibility` truth register, never through the co-editor\'s '
      + 'door — one entity, one producer (ADR 004 §4.1, §5.1).', 'shape');
  }
  const patch = projectCoEditPatch(kind, level, changes);
  if (patch === null) return null;                 // nothing was actually edited
  // BY REFERENCE to `pubSet`, exactly as `derivePublication` and `adminUnshareOp` are: the brand
  // is a non-enumerable symbol and a clone anywhere on this path drops it
  // (PUBLISH_FAILURE_CONTRACT.byReference).
  return pubSet(ctx, kind, spec.owner, spec.uuid, patch);
}
