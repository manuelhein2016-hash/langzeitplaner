// src/js/core/replace.js — import (11.3) and snapshot restore (11.5) as a DIFF TRANSACTION.
// ADR 001 §8.5, §5, §6, §12.6 · ops.contract.js §9 · store.contract.js `replaceAll`
// ADR 005 §1.1 has no home for this file — see "WHERE THIS FILE LIVES" below.
//
// DOM-free, I/O-free, imports nothing outside core/ (ADR 005 §2).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS, AND WHY IT IS NOT A `board.reset` OP
//
// v1's `store.replaceAll(next)` throws the whole board away and installs another one
// (`store.js:194-200`). In a pure-register op log there is nothing to throw away: the log IS the
// state, my other Mac holds the same log, and "install this board instead" is not a register
// write. One reviewed v2 design added a `board.reset{state}` op carrying a whole board. ADR 001
// §8.5 and §12.6 REJECT it, and the reason is not aesthetic:
//
//   · it has no fold rule — `≺` orders WRITES to a (entity, field) cell, and a board is neither;
//   · it has no defined behaviour under reordering, which §6's whole convergence proof needs;
//   · two concurrent resets have no defined meaning at all.
//
// The last one is the live hole: story 19.4 pairs two of my own Macs, story 11.5 restores
// yesterday's snapshot. Reset-as-an-op means device B, which never saw the reset, keeps emitting
// edits against entities the reset removed, and every one of them is a live register write with a
// perfectly good stamp. The board would oscillate.
//
// So `replaceAll` is a DIFF TRANSACTION, expressed entirely in the primitive that already has a
// fold rule (ADR 001 §8.5, steps 1-6):
//
//   1. Migrate the incoming board to v2 field shape — VALUES ONLY.
//   2. For every entity present in the import: one `X.set` carrying ALL its fields at a FRESH
//      stamp, which is greater than every stamp already in the log.
//   3. For every LIVE LOCAL entity ABSENT from the import: `{_alive: false}` at a fresh stamp.
//   4. The caller clears `undoStack` and `redoStack` — import is excluded from undo (story 5.4).
//   5. Scope: `personal` + `local` ONLY. Family registers are never written here.
//   6. The confirm sheet says so in one line:
//      „Wiederherstellen ändert auch, was deine Familie von dir sieht."
//
// THE LOG IS NEVER REWOUND. Nothing is deleted, nothing is re-stamped, no history is dropped. A
// paired device receives the diff as ordinary ops, folds them by the ordinary rule, and lands on
// the imported board — it converges TO the import instead of fighting it, because every op in the
// transaction carries a stamp greater than anything either device had written. That is the
// property `board.reset` could not have and it is proved in `tests/tier1/core-replace.test.js`
// with two simulated devices.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE 19.4 / 11.5 CONVERGENCE HOLE, AND HOW IT IS CLOSED HERE
//
// Step 3 is a blanket "everything I have that the import does not, dies". Applied naively over
// the whole RegisterMap that is a data-loss bug with somebody else's name on it: my RegisterMap
// also holds `fnote:mem_MAMA/…` — Mama's shared entry, replicated into the family space. Her
// entry is not in MY exported board.json (it never was; the export is my truth, and a foreign
// entry is a projection of HER truth), so a blanket sweep would emit `pub.alive:false` for every
// entry every other member has ever shared with me, at a fresh stamp, and ship it to the family
// relay. One person restoring a snapshot would blank the family's board.
//
// This module therefore never writes a family register at all. `REPLACEABLE_KINDS` is the only
// set it will address, the assertion at the end of `planReplaceAll` re-checks every emitted op
// against it, and `pub.*` fields are refused outright. ADR 001 §8.5 step 5 states the rule; the
// invariant block below is the enforcement, so a later edit that adds a kind to the sweep fails
// loudly here rather than quietly on somebody's family board.
//
// The retraction the import DOES imply is correct and happens elsewhere: after this transaction
// commits, ADR 004 §3's publisher re-derives my family ops FROM MY NEW TRUTH, so an entry of mine
// that no longer exists gets its `pub.alive:false` — from the publisher, which knows what a
// retraction means, and only for entries I own.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHERE THIS FILE LIVES  (a reported ADR gap, not a deviation)
//
// ADR 005 §1.1's module tree lists `ops.js`, `registers.js`, `entities.js`, `materialize.js`,
// `undo.js`, `authz.js`, `oplog.js`, `stamp.js`, `ids.js`, `migrate1to2.js` — and has no home for
// `replaceAllOps`, which ops.contract.js §9 declares and ADR 001 §8.5 specifies. It is NOT
// migration: migration runs once, is deterministic, and stamps GENESIS; this runs on demand, is
// non-deterministic by design (fresh stamps, CSPRNG op ids) and stamps the present. It is not
// `ops.js` either — it reads the current RegisterMap, which `ops.js` never does. So it is its own
// level-1 module, above `ops.js` + `registers.js` + `entities.js` and below the store.
// REPORTED: ADR 005 §1.1's tree should gain `replace.js  — import / snapshot restore (§8.5)`.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS DELIBERATELY NOT REPRODUCED FROM v1's `migrate()`
//
// v1's `replaceAll` runs `migrate(next)` on the way in (`store.js:195`), which does three repairs
// this module does not:
//   · dangling `categoryId` → `categories[0].id`. In v2 that repair is a PROJECTION INVARIANT
//     (`materialize.js` step 7, ADR 001 §5 step 7) and is applied on every projection, so it does
//     not belong in the log. Doing it here as well would write the fallback id into a register
//     and make the repair permanent — the opposite of idempotent.
//   · `paletteRef` backfill, which needs `palette.js` and is outside `core/` (ADR 005 §2).
//   · the 7.5 "no Bundesland ⇒ schulferien off" normalisation, which lives in v1's load-time
//     `migrate()` and is not re-applied on every mutation; a materializer that did would not be
//     reproducing v1, it would be changing it (`materialize.js` §6 says so in those words).
// The last two are the retrofit's business (WP-3), not this module's, and are recorded here so
// nobody re-derives the question from scratch.

import {
  LOCAL_SPACE, PERSONAL_PLACEHOLDER, OpError, FIELDS,
  makeOp, opKindForEntity, fieldsOf, isPubField, flattenPref,
  noteSet, barSet, catSet, padSet, prefSet,
} from './ops.js';
import {
  PREF_KEY, parseEntityKey, familyKeyFor,
  isMemberId, isDeviceId, isSpaceId, isEntityUuid, isMonthKey, isDateString,
} from './entities.js';
import { fmt } from './stamp.js';
// One import, one frozen array of names, no behaviour. `materialize.js` is the single authority
// on which entry fields are v2-ADDITIVE — it is the file that decides which ones it decorates
// with — and `undo.js` already reaches for it for the same question, with the same justification.
// A second list here would be a second answer to "is `createdAt` data, or is it derived?", and
// the answer decides whether re-importing my own export is reported as DATA LOSS.
import { V2_ENTRY_FIELDS } from './materialize.js';
import { ZERO_DEVICE_SHORT, opId as defaultOpId, groupId as defaultGroupId } from './ids.js';
// THE OTHER DOOR. `migrate1to2.js` and this file both turn a v1 board into ops — migration at
// launch (ADR 001 §8.2), this module at import (11.3) and snapshot restore (11.5) — and in v1
// they are LITERALLY THE SAME FUNCTION: `store.replaceAll(next)` is `this.state = migrate(next)`
// (`store.js:194`). v1 has one door. The split into two modules here is a v2 implementation
// detail, so every place where the two answered the same bytes differently was a v2 regression
// with no v1 behind it (REG-20…REG-23).
//
// The four behaviours below are therefore IMPORTED, not re-implemented. A second copy of
// `truncateToFit` would be a second answer to "how long is too long"; a second `rekeyed` would
// give the same duplicate id a different replacement on each door, so the same file restored
// twice would build two different boards; a second set of default categories would mint a second
// four. Shared code is the only form of "the two doors agree" that cannot drift.
//
// `CARRIED_FIELDS` below is still a deliberate second declaration — see its docblock. The
// difference is that a drift in a field LIST is caught by `checkCoverage`, while a drift in a
// BEHAVIOUR is caught by nothing.
//
// A3-H2 adds four more to that list — `coerceToV1Bool`, `coerceToV1Date`, `coerceToV1Id`,
// `mintedId` — and `gridPlacementWarning`, the warning that replaced the old "will not be
// renderable" one (and then, at R4-10, replaced its replacement: see its docblock). Every one of
// them answers "what did v1 MEAN by this value", and two answers to that question is the
// two-doors defect class in its purest form: the same file would migrate into one board at launch
// and restore into a different one from a snapshot.
//
// `missingBarEdge` was the fifth and is GONE from both doors — R4-10 found it anchoring a bar v1
// paints across nine columns onto a single day, and writing an `endDate` into the user's file
// that the file never held. Deleting it is the fix; it had to be deleted on both doors at once,
// for this list's reason.
//
// R5-11 adds the sixth, `coerceToV1BarEdge`, and it is the same argument one more time. A bar
// edge the file holds as text that names no day is DROPPED by the type table, and `layout.js:133`
// does not treat a dropped edge like an absent one: it compares the text. A door that dropped it
// and a door that positioned it would build two different boards from the same bytes — and the
// import door is the one where the file being replaced is gone the moment the transaction lands.
import {
  truncateToFit, coerceToV1Text, coerceToV1Bool, coerceToV1Date, coerceToV1Id, coerceToV1BarEdge,
  mintedId, gridPlacementWarning,
  defaultCategories, rekeyed, V1_BOARD_KEYS,
} from './migrate1to2.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Errors and the vocabulary this module is allowed to touch
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown for a CALLER mistake — a bad ctx, or an invariant this module must never violate.
 *  Never thrown for bad DATA in the incoming board: that produces a warning and a diff that is
 *  as complete as the file allows, because the file is about to replace the user's board and
 *  refusing halfway through would be the worst of both. */
export class ReplaceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReplaceError';
  }
}

/**
 * A replace transaction that LOSES SOMETHING may not complete silently — RECHECK-82-2, and the
 * exact twin of `migrate1to2.js`'s `MigrationLossyError`, which exists for the exact reason
 * stated one file away: "a boolean nobody is obliged to read is not a safety mechanism."
 *
 * `replaceAllOps()` — the entry point `ops.contract.js` §9 declares — used to return a bare array
 * and drop `warnings` and `lossy` on the floor, so nothing in the system was obliged to notice
 * that a note had been truncated or a section discarded. On THIS door that is worse than on the
 * migration door: story 11.5 is snapshot restore, so the board the transaction replaces is gone
 * the moment it lands, and the user is being shown a "restore" that quietly lost something.
 *
 * The whole plan rides on the error, so nothing is discarded by the throw: a caller that means
 * "I know, proceed" catches it and reads `.plan`, or passes `ctx.acceptLossy` / `ctx.onLossy`.
 */
export class ReplaceLossyError extends Error {
  /** @param {Object} plan the full `ReplacePlan` */
  constructor(plan) {
    super(
      `replaceAll: this import cannot be represented without loss (${plan.warnings.length} `
      + `warning${plan.warnings.length === 1 ? '' : 's'}). Pass ctx.acceptLossy or ctx.onLossy to `
      + `proceed; the whole plan is on this error as .plan.\n  - ${plan.warnings.join('\n  - ')}`,
    );
    this.name = 'ReplaceLossyError';
    /** @type {Object} the complete plan — ops, warnings, gid, written, removed */
    this.plan = plan;
    /** @type {string[]} */
    this.warnings = plan.warnings;
  }
}

/**
 * The ONLY entity kinds a replace transaction may address (ADR 001 §8.5 step 5). `pref` is in the
 * list and is handled by its own pass (it is one entity with wildcard registers, not a
 * collection); `fnote`, `fbar`, `member` and `space` are NOT, and that absence is the mechanism —
 * see the header. Frozen, and re-asserted against every emitted op below.
 */
export const REPLACEABLE_KINDS = Object.freeze(['note', 'bar', 'cat', 'pad', 'pref']);

/** The collection kinds, in emission order. Categories first, exactly as migration orders them:
 *  `categories[0]` is v1's dangling-reference fallback (`store.js:84`) and ADR 001 §5 step 7
 *  resolves it by `(_born asc, id asc)`, so the category the fallback picks after an import is
 *  the first one in the imported FILE. */
const COLLECTIONS = Object.freeze([
  Object.freeze({ kind: 'cat', from: 'categories', set: catSet, singular: 'category' }),
  Object.freeze({ kind: 'note', from: 'notes', set: noteSet, singular: 'note' }),
  Object.freeze({ kind: 'bar', from: 'bars', set: barSet, singular: 'bar' }),
]);

/**
 * The v1 product fields carried verbatim from the incoming entry, per kind. Identical to
 * `migrate1to2.js`'s `V1_FIELDS` and deliberately a SECOND declaration rather than an import:
 * these two modules answer different questions (migration converts a file that is being replaced;
 * this one diffs a file against a live board) and a shared constant would silently couple the day
 * one of them needs to change. The coverage assertion below makes a drift visible either way.
 */
export const CARRIED_FIELDS = Object.freeze({
  note: Object.freeze(['date', 'text', 'categoryId', 'repeatsYearly']),
  bar: Object.freeze(['startDate', 'endDate', 'label', 'categoryId']),
  cat: Object.freeze(['name', 'nameEn', 'paletteRef', 'visible']),
  pad: Object.freeze(['text']),
});

/**
 * The v2-additive fields. Every one of them is FORCED — written from this table and never taken
 * from the file — which is `migrate1to2.js`'s `V2_ADDITIONS` rule verbatim (`f[name] = add[name]`,
 * no branch), and for the same reasons.
 *
 * RECHECK-40-3. `visibility` and `coEdit` used to be DEFAULTS: `patch[name] = ok ? value :
 * defaults[name]`, so a `board.json` carrying `visibility: "geteilt", coEdit: true` set the two
 * truth registers a publisher reads, and the family saw an entry the moment the user restored a
 * snapshot. The file decided the user's exposure. Every argument in this table's own text —
 * "story 16.1 stated as a constant", "the one default in here that is load-bearing for privacy" —
 * argued for forcing them and the code defaulted them; the migration door forced them all along.
 *
 * A hand-edited value is not silently ignored: the file said something, and `buildPatch` warns
 * that it was overruled. It is not `lossy`, because nothing the user can SEE was lost — an
 * exposure this device never granted is not the user's data, and refusing the whole restore over
 * it would be worse. Sharing again is one click; un-sharing after the family has read it is not.
 *
 * `_alive: true` is what "present in the import" MEANS, so a hand-edited `_alive: false` on an
 * entry the file also lists cannot produce an entity that is imported and dead at the same time.
 */
export const IMPORT_DEFAULTS = Object.freeze({
  note: Object.freeze({ visibility: 'privat', coEdit: false, _alive: true }),
  bar: Object.freeze({ visibility: 'privat', coEdit: false, _alive: true }),
  cat: Object.freeze({ defaultVisibility: 'privat', _alive: true }),
  pad: Object.freeze({ _alive: true }),
});

/** `_born` is written by `makeOp({born:true})` from the op's OWN fresh stamp, never carried. */
const BORN = '_born';

/** The register that marks an entity dead (ADR 001 §7.3). */
const ALIVE = '_alive';

/**
 * Device-local bookkeeping that an IMPORT MUST NOT CLEAR, by dotted-name prefix.
 *
 * v1's `replaceAll` replaces `state.settings` wholesale, so a local settings key the payload does
 * not carry reverts to its default — and the pref pass below reproduces that by writing `null`.
 * These two register families are v2 additions that are not settings at all: `lastSeenSeq.<space>`
 * is the sync cursor 17.5's "neu" dot is computed against, and `hiddenMembers.<memberId>` is
 * 17.3's per-member view toggle. Clearing `lastSeenSeq` would light up a new-entry dot on every
 * foreign entry in the family the moment anybody restored a snapshot; clearing `hiddenMembers`
 * would silently un-hide a member somebody chose to hide. Neither is board content and neither is
 * in the file being imported, so neither is this transaction's business.
 */
export const PRESERVED_PREF_PREFIXES = Object.freeze(['lastSeenSeq', 'hiddenMembers']);

/** Top-level `board.json` keys. One list, shared with the migration door — see `V1_BOARD_KEYS`. */
const KNOWN_BOARD_KEYS = V1_BOARD_KEYS;

/** The undo label a store should use for the transaction, if it records one at all. */
export const REPLACE_ALL_LABEL = 'replaceAll';

/**
 * Story 5.4: import is EXCLUDED from undo, and v1 implements that by clearing both stacks
 * (`store.js:196-197`). Exported as a constant so the retrofit cannot decide otherwise by
 * accident. The transaction still carries ONE gid across all of its content ops — so if a future
 * story ever did make import undoable, it is already a single ⌘Z and not 400 of them.
 */
export const REPLACE_ALL_UNDOABLE = false;

// ─────────────────────────────────────────────────────────────────────────────
// 2. The coverage assertion (the same guard `migrate1to2.js` carries)
//
// Every field of every replaceable collection kind is accounted for exactly once: carried from
// the file, defaulted, or written by `makeOp` itself. A later work package that adds a field to
// `FIELDS.note` must decide what an IMPORT puts in it, and a module that refuses to load is a
// louder signal than a board that quietly imports without it.
// ─────────────────────────────────────────────────────────────────────────────

for (const { kind } of COLLECTIONS) checkCoverage(kind);
checkCoverage('pad');

function checkCoverage(kind) {
  const declared = fieldsOf(kind).slice().sort();
  const covered = [...CARRIED_FIELDS[kind], ...Object.keys(IMPORT_DEFAULTS[kind]), BORN].sort();
  if (declared.join(',') !== covered.join(',')) {
    throw new ReplaceError(
      `replace.js: FIELDS.${kind} declares [${declared}] but a replace transaction covers ` +
      `[${covered}]. A field was added to the op vocabulary without deciding what an IMPORT ` +
      'puts in it (ADR 001 §8.5 step 2 says ALL its fields).',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Probing the real validator
//
// A hand-edited board, an export from a newer build, or a snapshot written before a field's type
// tightened can all carry a value `ops.js` will not accept. Rather than re-implement its type
// checks here and let the two copies drift, a rejected value is identified by asking the REAL
// constructor about it — `migrate1to2.js` §4 does the same, for the same reason.
// ─────────────────────────────────────────────────────────────────────────────

const PROBE_ACT = 'mem_AAAAAAAAAAAAAAAAAAAAAA';
const PROBE_DEV = 'dev_AAAAAAAAAAAAAAAAAAAAAA';
const PROBE_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const PROBE_STAMP = fmt(0, 0, ZERO_DEVICE_SHORT);
const probeCtx = Object.freeze({
  act: PROBE_ACT,
  dev: PROBE_DEV,
  gid: PROBE_ID,
  mint: () => PROBE_STAMP,
  newOpId: () => PROBE_ID,
  space: PERSONAL_PLACEHOLDER,
});
const probeKey = (kind) => {
  if (kind === 'pad') return 'pad:2000-01';
  if (kind === 'pref') return PREF_KEY;
  return `${kind}:probe`;
};

/** Would `ops.js` accept `{[name]: value}` on this kind? @returns {boolean} */
function accepts(kind, name, value) {
  try {
    makeOp(probeCtx, opKindForEntity(kind), probeKey(kind), { [name]: value });
    return true;
  } catch (e) {
    if (e instanceof OpError) return false;
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Small readers
// ─────────────────────────────────────────────────────────────────────────────

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const q = (v) => JSON.stringify(v);
/** The declared type of a field, for the A3-H2 coercion cascade. */
const fieldTypeOf = (kind, name) => FIELDS[kind]?.[name]?.t ?? null;
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const FORBIDDEN_KEY = (k) => k === '__proto__' || k === 'constructor' || k === 'prototype';

/** @returns {Map<string, {value:any}>} never null */
const cellsOf = (regs, e) => (regs instanceof Map && regs.get(e)) || new Map();

/** The register's value, or `undefined` when it was never written. */
function valueOf(regs, e, field) {
  const reg = cellsOf(regs, e).get(field);
  return reg === undefined ? undefined : reg.value;
}

/**
 * A register that CARRIES something. `undefined` = never written; `null` = written and cleared
 * (ADR 004 §5.1 — blurring the two is R9). Both mean "there is nothing here to replace".
 */
const carries = (regs, e, field) => {
  const v = valueOf(regs, e, field);
  return v !== undefined && v !== null;
};

/** ADR 001 §7.3: an entity is dead only when `_alive` was explicitly written `false`. An absent
 *  `_alive` is ALIVE — `materialize.js` reads it the same way, and inferring death from absence
 *  is the bug class ADR 004 §13.6 forbids. */
const isLive = (regs, e) => valueOf(regs, e, ALIVE) !== false;

// ─────────────────────────────────────────────────────────────────────────────
// 5. planReplaceAll
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ReplaceCtx
 * @property {() => string} mint              `clock.tick()` — ONE FRESH STAMP PER OP (ADR 001 §2).
 *                                            Fresh is what makes the import win on every peer.
 * @property {string} me                      my MemberId — `op.act`
 * @property {string} deviceId                this device — `op.dev`
 * @property {string|null} [personalSpaceId]  a `psp_…` id; null/omitted ⇒ solo mode's placeholder
 * @property {string} [gid]                   supply one to pin it in a test; otherwise minted
 * @property {() => string} [newOpId]         defaults to `ids.opId`
 * @property {() => string} [newGid]          defaults to `ids.groupId`
 * @property {Object} [defaultSettings]       v1's `defaultState().settings`. Supply it: it is what
 *                                            lets an omitted pref be reset to its v1 DEFAULT
 *                                            instead of cleared, which are different boards for
 *                                            every boolean whose default is on (REG-8).
 */

/**
 * @typedef {Object} ReplacePlan
 * @property {Object[]} ops        the diff transaction, in emission order
 * @property {string[]} warnings   everything the incoming board could not carry, in file order
 * @property {boolean} lossy       true when a warning describes DATA LOSS rather than a note.
 *                                 The store must be able to refuse and tell the user before the
 *                                 board it is replacing is gone.
 * @property {string} gid          the ONE group id every content op in the transaction carries
 * @property {boolean} undoable    always false — story 5.4 excludes import from undo
 * @property {string} label        `REPLACE_ALL_LABEL`
 * @property {string[]} written    entity keys the import wrote, in emission order
 * @property {string[]} removed    entity keys tombstoned because the import does not have them
 * @property {string[]} retractions FAMILY keys (`fnote:<me>/…`, `fbar:<me>/…`) that are still
 *                                  PUBLISHED and whose personal truth this transaction just
 *                                  tombstoned. This module may not write them (see the header's
 *                                  scope gate); the publisher must re-derive exposure for each
 *                                  one after the transaction lands, or the family keeps seeing
 *                                  an entry its owner has deleted (RECHECK-40-4).
 * @property {{key:string, visibility:string|null, coEdit:boolean|null}[]} reshares
 *                                  exposure the FILE asked for, which this transaction wrote as
 *                                  PRIVATE instead. Nothing is shared until the user confirms.
 */

/**
 * The full ADR 001 §8.5 diff transaction, with the diagnostics the store needs.
 * PURE: neither `regs` nor `incoming` is read after this returns and neither is mutated.
 *
 * @param {Map} regs        the CURRENT RegisterMap (`Map<EntityKey, Map<field, Register>>`)
 * @param {Object} incoming the parsed board being imported or restored — v1 top-level shape
 * @param {ReplaceCtx} ctx
 * @returns {ReplacePlan}
 */
export function planReplaceAll(regs, incoming, ctx) {
  const { act, dev, space, gid, newOpId, defaultPrefs } = checkCtx(ctx);
  if (regs !== null && regs !== undefined && !(regs instanceof Map)) {
    throw new ReplaceError('planReplaceAll: regs must be a RegisterMap (Map<EntityKey, Map<field, Register>>)');
  }
  if (!isPlainObject(incoming)) {
    throw new ReplaceError(`planReplaceAll: expected a parsed board object, got ${q(incoming)}`);
  }

  const warnings = [];
  let lossy = false;
  const warn = (msg, isLossy) => { warnings.push(msg); if (isLossy) lossy = true; };

  const ops = [];
  const written = [];
  const removed = [];
  const retractions = [];
  /**
   * Exposure the FILE asked for and this transaction refused to grant (see IMPORT_DEFAULTS).
   *
   * Forcing `privat` closes RECHECK-40-3, and on its own it would open a smaller hole in the
   * other direction: story 11.5 restores MY OWN snapshot, which is a v2 export of my own board
   * carrying the visibilities I chose, and silently resetting all of them to private is
   * „etwas geht verloren" — principle 6 — even though nothing is exposed by it.
   *
   * Both are answered by never deciding it here. The registers are written private, so no file
   * can grant exposure; the request is handed back so the store can ask („Diese Datei möchte 3
   * Einträge wieder mit deiner Familie teilen."). Silently granting and silently dropping are
   * both refused; the user decides, which is what ADR 004 says exposure is.
   */
  const reshares = [];
  const askedFor = new Map();
  const asked = (key, field, value) => {
    if (!askedFor.has(key)) {
      const rec = { key, visibility: null, coEdit: null };
      askedFor.set(key, rec);
      reshares.push(rec);
    }
    askedFor.get(key)[field === 'defaultVisibility' ? 'visibility' : field] = value;
  };
  /** Every entity key the import claims — the complement of this set is step 3's sweep. */
  const present = new Set();

  const opCtx = { act, dev, gid, space, mint: ctx.mint, newOpId, familySpaceId: null };
  const emit = (op) => { ops.push(op); return op; };

  for (const key of Object.keys(incoming)) {
    if (!KNOWN_BOARD_KEYS.includes(key)) {
      warn(`the imported board carries an unknown top-level key ${q(key)}; it has no v2 register and was DROPPED`, true);
    }
  }

  // ── step 2a — the three collections ───────────────────────────────────────
  /** The category ids that survived step 2a — v1's `store.js:83` id set. */
  const catIds = new Set();

  for (const { kind, from, set, singular } of COLLECTIONS) {
    const list = takeArray(incoming[from], from, warn);
    const seen = new Set();
    for (const entry of list) {
      if (!isPlainObject(entry)) {
        warn(`a ${singular} in the import is not an object (${q(entry)}) and was DROPPED`, true);
        continue;
      }
      // A3-H2, and the migration door's `entityIdOf` reasoning verbatim: v1 keeps an id-less
      // entry in its array and paints it, so DROPPING it here was an entry the user could see
      // before the restore and cannot see after it — on the door where the board being replaced
      // is gone the moment the transaction lands. A non-string id that NAMES one is carried as
      // that string (and so is every `categoryId` pointing at it, in `buildPatch`); anything else
      // gets a derived id, minted from the entry's content so that both doors, on both Macs,
      // mint the same one.
      let id = entry.id;
      if (!isEntityUuid(id)) {
        const asString = coerceToV1Id(id);
        if (asString) {
          warn(
            `${singular} ${q(id)} in the import has an id that is not a string; it was carried as `
            + `${q(asString.kept)} — the same token, and every reference to it was coerced the same way`,
            false,
          );
          id = asString.kept;
        } else {
          const fresh = mintedId(kind, entry, seen);
          warn(
            `a ${singular} in the import has no usable id (${q(id)}); it was MINTED the derived id `
            + `${q(fresh)} so that the entry survives (A3-H2)`,
            false,
          );
          id = fresh;
        }
      }
      if (seen.has(id)) {
        // REG-22. Two registers cannot share an entity key; the second would LWW over the first
        // inside a single transaction and silently merge two entries. v1's arrays tolerate this
        // and v1 RENDERS BOTH — so taking only the first is an entry the user could see before
        // the restore and cannot see after it (ATT-90). Re-key, exactly as the migration door
        // does, with the same derived function: a v1 entity id is opaque, nothing outside the
        // entry refers to a note or bar id, and a `categoryId` keeps pointing at the FIRST
        // occurrence — which is the category v1's own `find()` would have resolved it to.
        //
        // `rekeyed` is DERIVED, not minted, which is what makes the two doors agree: the same
        // duplicate through import and through migration gets the same replacement id, on this
        // Mac and on the other one (R12).
        const fresh = rekeyed(kind, id, seen);
        warn(
          `${singular} ${q(id)} appears more than once in the import; the second copy was `
          + `RE-KEYED to ${q(fresh)} so that both survive`,
          false,
        );
        id = fresh;
      }
      seen.add(id);
      if (kind === 'cat') catIds.add(id);
      const key = `${kind}:${id}`;
      present.add(key);
      const dropped = new Set();
      const patch = buildPatch(kind, entry, regs, key, `${singular} ${q(id)}`, warn, asked, dropped);

      // Found by the widened property corpus (P16), and it is the same class as REG-20…23: the
      // migration door reported an entry the grid cannot place and this one did not check at all,
      // so the same bytes were `lossy` through one door and clean through the other — and a store
      // that refuses a lossy import would have refused the launch migration while quietly
      // accepting the restore of the identical file.
      //
      // A3-H2 changed WHAT is reported, on both doors together. An entry the grid cannot place no
      // longer leaves the board: `entities.js:renderableNote` keeps an own entry in the ARRAY the
      // way v1's `state.notes` did, and `renderableBar` keeps a bar with one edge or none. What
      // is left is that the grid puts it somewhere the user did not ask for — which is what v1 did
      // with it too — so it is reported and it is NOT lossy. R4-10d: the sentence this used to
      // write was FALSE for three of the four bar shapes it was written about, so the wording is
      // now worked out from the patch by `gridPlacementWarning` rather than assembled here.
      const placement = (kind === 'note' || kind === 'bar')
        ? gridPlacementWarning(kind, singular, id, patch, dropped) : null;
      if (placement) warn(placement, false);
      emit(set(opCtx, id, patch, { born: true }));
      written.push(key);
    }
    // REG-21. v1's `migrate()` substitutes `defaultState().categories` for an empty or unusable
    // list (`store.js:74`), and v1 runs `migrate()` on EVERY import, so v1 substitutes here too.
    // Every other v1 site is written as if the substitution has already happened —
    // `store.category()` never returns undefined, so `legend.js` and `popover.js` read
    // `.paletteRef` off it with no guard — which makes a categoryless board not merely degraded
    // but one the v1 UI throws on, with nothing for ADR 001 §5 step 7 to repair the dangling
    // `categoryId`s to either.
    //
    // The objection this module used to record — "core/ may not read a CSPRNG (ADR 005 §2), and
    // inventing ids would give each device a different four categories" — is real and is already
    // ANSWERED by the sibling module in this directory: `defaultCategories()` DERIVES the four
    // ids. Importing it (rather than deriving a second four here) is what makes the two doors
    // produce the same four category ids for the same file, which is the whole point: a board
    // migrated at launch and the same board restored from a snapshot must not end up with eight.
    if (kind === 'cat' && seen.size === 0) {
      for (const c of defaultCategories()) {
        const key = `cat:${c.id}`;
        present.add(key);
        emit(catSet(opCtx, c.id, buildPatch('cat', c, regs, key, `default category ${q(c.name)}`, warn, asked), { born: true }));
        written.push(key);
        seen.add(c.id);
        catIds.add(c.id);
      }
      warn(
        list.length
          ? "no category in the import was usable; v1's four default categories were substituted (store.js:74)"
          : "the imported board carries no categories; v1's four default categories were substituted (store.js:74)",
        false,
      );
    }
  }

  // ── step 2b — scratchpads ─────────────────────────────────────────────────
  // Keyed by month, not by uuid (F10). An EMPTY string is DROPPED, exactly as migration drops it
  // (§8.2 takes non-empty keys only) and reported exactly as migration reports it — see REG-23
  // and R4-11a at the bottom of this loop. (This comment used to say the opposite, which is the
  // divergence REG-23 closed: v1's `replaceAll` does not install the payload's `scratchpads`
  // object verbatim, it installs `migrate(payload)`'s.)
  const pads = incoming.scratchpads;
  if (pads !== undefined && !isPlainObject(pads)) {
    warn(`scratchpads is not an object (${q(typeof pads)}); treated as empty`, true);
  }
  for (const month of Object.keys(isPlainObject(pads) ? pads : {})) {
    const text = pads[month];
    if (!isMonthKey(month)) {
      warn(`scratchpad key ${q(month)} is not YYYY-MM and was DROPPED`, true);
      continue;
    }
    // A3-H2, and the migration door's pad branch verbatim: v1 paints a scratchpad through
    // `state.scratchpads[key] || ''` (`layout.js:259`), so `42` is the two characters „42" in the
    // textarea and `null` is an empty one. Dropping it threw away a month of the user's typing.
    let padText = text;
    if (typeof padText !== 'string') {
      const coerced = coerceToV1Text('pad', 'text', padText);
      if (coerced) {
        warn(
          `scratchpad ${q(month)} is ${typeof padText === 'object' && padText !== null ? 'an object' : q(padText)}, `
          + `which v2 cannot store; it was kept as the text v1 paints for it (${q(coerced.kept)})`,
          true,
        );
        padText = coerced.kept;
      } else {
        warn(`scratchpad ${q(month)} is ${q(padText)}; v1 painted an empty month for it and so `
          + 'does v2 — no scratchpad register was written', false);
        padText = '';
      }
    }
    // REG-23. ADR 001 §8.2 — "one `pad.set` per NON-EMPTY scratchpad key" — and the migration
    // door obeys it. This one used to keep the `''`, on the reasoning that v1's `replaceAll`
    // installs the payload's `scratchpads` object verbatim; it does not, it installs
    // `migrate(payload)`'s (`store.js:194`), so there was never a v1 behind the divergence.
    //
    // Nothing the user can see moves: v1 renders a pad as `state.scratchpads[key] || ''`
    // (`layout.js:259`), so `''` and absent paint the same empty textarea, and v1's own editor
    // DELETES the key when the text is blank (`interact.js:620,634`) — a `''` only ever reaches
    // us from a hand-edited file. Not a loss, so it does not touch `lossy`.
    //
    // R4-11a — but it IS said. „Not warned" was the other half of the old comment, on the ground
    // that reporting it would make `lossy` noisy; those are two different channels, and the
    // silence made this the one drop in the door that was reported when the value had to be
    // COERCED to `''` and hidden when the file already held `''`. §4b rule 2 is „every coercion
    // is reported so it is auditable". Same sentence as the migration door, for the same bytes.
    if (padText === '') {
      if (text === '') {
        warn(`scratchpad ${q(month)} is an empty string in the file; §8.2 writes no register for `
          + 'an empty month, so the KEY is not carried into v2 — v1 painted an empty textarea for '
          + "it and so does v2, and v1's own editor deletes a blank key too (interact.js:620)",
        false);
      }
      continue;
    }
    const key = `pad:${month}`;
    present.add(key);
    emit(padSet(opCtx, month, buildPatch('pad', { text: padText }, regs, key, `scratchpad ${q(month)}`, warn, asked), { born: true }));
    written.push(key);
  }

  // ── step 3 — `{_alive:false}` for every LIVE LOCAL entity absent from the import ───────────
  //
  // Sorted, so the transaction's op order is a function of the boards and not of Map insertion
  // order — two devices restoring the same snapshot produce the same sequence, and a failing test
  // replays. `REPLACEABLE_KINDS` is what keeps this off `fnote:`, `fbar:`, `member:` and
  // `space:`: see the header. `pref:app` has no `_alive` register and is handled below.
  for (const key of [...(regs instanceof Map ? regs.keys() : [])].sort(byString)) {
    const parsed = parseEntityKey(key);
    if (!parsed) continue;                                  // not an entity key; not ours to touch
    if (parsed.kind === 'pref') continue;                   // step 3b
    if (!REPLACEABLE_KINDS.includes(parsed.kind)) continue; // ← the family scope gate (§8.5 step 5)
    if (present.has(key)) continue;                         // the import has it; step 2 wrote it
    if (!isLive(regs, key)) continue;                       // already dead — no second tombstone,
                                                            // and no fresh stamp for a corpse
    const setter = parsed.kind === 'cat' ? catSet : parsed.kind === 'note' ? noteSet
      : parsed.kind === 'bar' ? barSet : padSet;
    emit(setter(opCtx, parsed.id, { [ALIVE]: false }));
    removed.push(key);

    // RECHECK-40-4 — THE RETRACTION THIS TRANSACTION IS NOT ALLOWED TO MAKE.
    //
    // Tombstoning `note:n1` removes the entry from MY board. If I had published it, the family's
    // copy lives at `fnote:<me>/n1` in the family space, and this module may not touch it: the
    // scope gate above (and the post-build invariant) is the mechanism that stops one person's
    // snapshot restore from blanking the family's board, and it must stay.
    //
    // But "correctly scoped" and "complete" are different things. Without this list the entry
    // disappears from my board and stays on theirs, `pub.text` and all, and NOTHING anywhere
    // says a retraction is owed — the `removed` list was the only trace and it is personal keys,
    // not publications. So the plan names them explicitly, and the publisher (WP-3) re-derives
    // exposure for exactly these keys after the transaction lands. Naming it is what turns a
    // silent hole into a handover.
    if (parsed.kind !== 'note' && parsed.kind !== 'bar') continue;
    const fkey = familyKeyFor(key, act);
    if (cellsOf(regs, fkey).size === 0) continue;              // never published
    if (valueOf(regs, fkey, 'pub.alive') === false) continue;  // already retracted
    retractions.push(fkey);
  }

  // ── step 3b — settings, in the LOCAL space (§8.5 step 5's other half) ─────
  //
  // v1's dangling-reference fallback (`store.js:84`): the FIRST category, after the sort. The
  // categories are emitted first, so it is the first `cat:` op — the same derivation
  // `migrate1to2.js` uses, over the same list.
  const firstCat = ops.find((o) => o.e.startsWith('cat:'));
  const fallbackCatId = firstCat ? firstCat.e.slice('cat:'.length) : null;
  const prefOp = buildPrefOp(regs, incoming, opCtx, warn, fallbackCatId, catIds, defaultPrefs);
  if (prefOp) emit(prefOp);

  // ── the invariant, re-checked against what was actually built ─────────────
  //
  // Not a comment, not a test: the thing that must never happen, refused in the code that would
  // have to do it. A later edit that widens the sweep, or a setter that grew a family branch,
  // fails here — with the op in the message — instead of on somebody's family board.
  for (const op of ops) {
    const parsed = parseEntityKey(op.e);
    if (!parsed || !REPLACEABLE_KINDS.includes(parsed.kind)) {
      throw new ReplaceError(`replaceAll built an op addressing ${q(op.e)}; ADR 001 §8.5 step 5 is personal + local only`);
    }
    if (parsed.owner !== null) {
      throw new ReplaceError(`replaceAll built an op addressing an OWNED entity ${q(op.e)} — a family entity is never mine to replace`);
    }
    if (op.space !== space && op.space !== LOCAL_SPACE) {
      throw new ReplaceError(`replaceAll built an op in space ${q(op.space)}; only ${q(space)} and ${q(LOCAL_SPACE)} are in scope`);
    }
    for (const f of Object.keys(op.f)) {
      if (isPubField(f)) throw new ReplaceError(`replaceAll built an op writing ${q(f)}; the publisher owns pub.* (ADR 004 §3)`);
    }
  }

  return {
    ops,
    warnings,
    lossy,
    gid,
    undoable: REPLACE_ALL_UNDOABLE,
    label: REPLACE_ALL_LABEL,
    written,
    removed,
    retractions,
    reshares: reshares.map((r) => Object.freeze({ ...r })),
  };
}

/**
 * Import (11.3) and snapshot restore (11.5), as ops.contract.js §9 declares it.
 *
 * NOT a `board.reset` op — that primitive has no fold rule and is rejected (ADR 001 §8.5, §12.6).
 * Emits per-field restoring writes at FRESH stamps plus `_alive:false` for entities absent from
 * the import. Personal + local spaces ONLY; the publisher re-derives family ops afterwards.
 *
 * The store wants `planReplaceAll` — it carries the warnings a lossy import must be refused on,
 * and the `undoable: false` that story 5.4 requires. This is the contract-shaped thin wrapper.
 *
 * @param {Map} regs @param {Object} incoming @param {ReplaceCtx} ctx
 * @returns {Object[]} the ops
 */
export function replaceAllOps(regs, incoming, ctx) {
  const plan = planReplaceAll(regs, incoming, ctx);
  // RECHECK-82-2. See `ReplaceLossyError`. `planReplaceAll` still returns the flag and never
  // throws — a caller that wants the diagnostics asks for them — but the SHORT entry point, the
  // one a retrofit reaches for because it only wants the ops, may not lose data in silence.
  if (plan.lossy) {
    if (typeof ctx.onLossy === 'function') ctx.onLossy(plan);
    else if (ctx.acceptLossy !== true) throw new ReplaceLossyError(plan);
  }
  return plan.ops;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. The patch builder — "ALL its fields" (ADR 001 §8.5 step 2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One entity's full-field patch.
 *
 * The three-way rule, and why the third branch exists:
 *   · a DEFAULTED field takes the entry's value when it is representable, and its default
 *     otherwise — never `null`. See `IMPORT_DEFAULTS`.
 *   · a CARRIED field the entry supplies is taken verbatim.
 *   · a CARRIED field the entry does NOT supply is written `null` — but ONLY when a live register
 *     already holds a value for it. This is the difference between a replace and a merge: v1's
 *     `replaceAll` installs the payload's entry object, so a `repeatsYearly` the file omits is
 *     GONE, not inherited from the note that used to be there. Writing `null` at a fresh stamp is
 *     how a register log says "gone" (`materialize.js` skips a cleared register and never
 *     fabricates a default for it). Where there is nothing to clear, nothing is written — that is
 *     what keeps the transaction bounded by `(entities in import + live entities locally)` rather
 *     than by the vocabulary, and it makes a brand-new entity's op identical in shape to the one
 *     migration would have produced.
 *
 * @param {string} kind @param {Object} entry @param {Map} regs @param {string} key
 * @param {string} where @param {(m:string,l:boolean)=>void} warn
 * @param {(key:string, field:string, value:any) => void} asked records an exposure the FILE
 *        requested and this module refused to grant — see `ReplacePlan.reshares`.
 * @param {Set<string>} [dropped] OUT — field names the file CARRIED and this door could not
 *        store. `gridPlacementWarning` cannot tell those from a field the file never had, and on
 *        the grid they are different bars (R5-11). The migration door threads the identical
 *        out-parameter, for the identical reason.
 * @returns {Object} the field patch (`_born` is added by `makeOp`)
 */
function buildPatch(kind, entry, regs, key, where, warn, asked, dropped = new Set()) {
  const defaults = IMPORT_DEFAULTS[kind];
  const carried = CARRIED_FIELDS[kind];
  const patch = {};

  for (const name of fieldsOf(kind)) {
    if (name === BORN) continue;                       // written by makeOp from the op's own stamp

    const supplied = Object.prototype.hasOwnProperty.call(entry, name);
    const value = entry[name];
    const ok = supplied && value !== undefined && accepts(kind, name, value);
    // REG-5 / REG-6. Computed HERE rather than in the `!ok` branch below, because a literal
    // `null` in the file is ACCEPTED — `null` is the "cleared" register value — and it is exactly
    // the accepted value that costs the entry: `materialize` skips a cleared register, so a null
    // `note.text` fails renderability and the note leaves the board. `coerceToV1Text` answers
    // `null` only for the fields renderability actually depends on, so a hand-edited
    // `cat.nameEn: null` is still carried to the log verbatim (ADR 001 §2).
    //
    // `supplied` is the guard that keeps this off the CLEAR at the end of this loop: a field the
    // file OMITS is a deliberate `null` meaning "gone", and that is a different thing entirely.
    const coerced = supplied ? coerceToV1Text(kind, name, value) : null;

    if (Object.prototype.hasOwnProperty.call(defaults, name)) {
      // FORCED, never taken from the file — `migrate1to2.js`'s V2_ADDITIONS rule. See the
      // IMPORT_DEFAULTS docblock: `_alive` is what presence MEANS, and `visibility`/`coEdit`/
      // `defaultVisibility` are the privacy floor a file may not raise (RECHECK-40-3).
      if (supplied && value !== defaults[name]) {
        warn(
          `${where}: the import carries ${q(name)} = ${q(value)}; v2 writes ${q(defaults[name])} `
          + (name === ALIVE
            ? 'because presence in the import is what aliveness means'
            : 'because an imported file does not decide who may see this entry (story 16.1); '
              + 'it is offered back on the plan as a re-share you can confirm'),
          false,
        );
        if (name !== ALIVE) asked(key, name, value);
      }
      patch[name] = defaults[name];
      continue;
    }

    if (!carried.includes(name)) continue;             // unreachable — pinned by checkCoverage()

    if (coerced) {
      warn(
        `${where}: field ${q(name)} is `
        + `${typeof value === 'object' && value !== null ? 'an object' : q(value)}, which v2 `
        + `cannot store as text; it was kept as the text v1 paints for it (${q(coerced.kept)}) `
        + 'rather than dropped, which would have removed the entry from the board',
        true,
      );
      patch[name] = coerced.kept;
      continue;
    }
    if (ok) {
      patch[name] = value;
      continue;
    }
    if (supplied && value !== undefined) {
      // REG-20 / RECHECK-82-1. TRUNCATE, never drop — `migrate1to2.js`'s own words for why:
      // "the user's note did not get shorter on upgrade day, it disappeared". Dropping `text`
      // makes the note unrenderable (ADR 001 §5 step 3) so it leaves the board entirely;
      // dropping `label` leaves the user's bar on the board with no name. On THIS door it is
      // worse than on the migration door, because 11.5 is snapshot restore: the board being
      // replaced is gone the moment the transaction lands.
      const cut = truncateToFit(kind, name, value);
      if (cut) {
        warn(
          `${where}: field ${q(name)} is ${value.length} characters and v2 stores at most `
          + `${cut.kept.length}; it was TRUNCATED, not dropped (${cut.dropped.length} character`
          + `${cut.dropped.length === 1 ? '' : 's'} cut). v1's limit was a DOM maxLength and `
          + 'never applied to a file',
          true,
        );
        patch[name] = cut.kept;
        continue;
      }
      // A3-H2 — COERCE TO v1's MEANING, the migration door's cascade in the same order, from the
      // same functions (`migrate1to2.js` §4b). `repeatsYearly: 'yes'` is the case the finding
      // named: truthy in v1, so the birthday repeats; not a boolean, so v2 dropped the key and
      // the birthday quietly became a one-off.
      // R5-11, BEFORE the date reader on this door too — `coerceToV1Date` trims, and a leading
      // space is exactly the class the edge rule exists for. Same function, same order, same
      // sentence: the `why` is built by the shared coercer so the two doors cannot word it
      // differently.
      const asEdge = coerceToV1BarEdge(kind, name, value);
      if (asEdge) {
        warn(`${where}: ${asEdge.why}`, true);
        patch[name] = asEdge.kept;
        continue;
      }
      const asV1 = coerceToV1Bool(kind, name, value)
        ?? coerceToV1Date(kind, name, value)
        ?? (fieldTypeOf(kind, name) === 'id' ? coerceToV1Id(value) : null);
      if (asV1) {
        warn(
          `${where}: field ${q(name)} = ${q(value)} is not a v2 ${fieldTypeOf(kind, name)}; v1 read `
          + `it as ${q(asV1.kept)} and it was COERCED to that rather than dropped`,
          true,
        );
        patch[name] = asV1.kept;
        continue;
      }
      // R5-11. What is left here is the class with no faithful v2 value: a text that sorts
      // BETWEEN two real dates. Recorded so `gridPlacementWarning` can tell it from an edge the
      // file never carried — see the migration door's twin.
      dropped.add(name);
      warn(
        `${where}: field ${q(name)} = ${q(value)} is not representable in v2 and the FIELD was `
        + 'DROPPED. The entry itself is kept',
        true,
      );
    }
    // ATT-53, ON THIS DOOR TOO. `coerceToV1Text` deliberately answers `null` for an ABSENT value
    // ("absence is ATT-53's business"), and until now this door had no answer for it: a note that
    // arrives with no `text` key at all got no `text` register, which `materialize` reads as
    // unrenderable (ADR 001 §5 step 3), which takes the note off the board. v1 imports that note
    // and DRAWS it — `popover.js:193` is `n.text || '…'` — so the import lost an entry the user
    // could see before it and cannot see after it, on the one door (11.5 snapshot restore) where
    // the board being replaced is gone the moment the transaction lands.
    //
    // The migration door has done this since ATT-53, in exactly these words, and the two doors
    // disagreeing about the same bytes is RECHECK-82-6's defect class — the same file producing
    // two different boards depending on which way in it came. `''` is not an invention: it renders
    // as „…" in v1 just as the absence does, and it is the value v1's own inline create writes.
    //
    // `value === undefined` rather than `!supplied`, so an explicit `text: undefined` is treated
    // as the absence it is, matching `migrate1to2.js` line for line.
    if (value === undefined && kind === 'note' && name === 'text') {
      warn(
        `${where}: no ${q(name)}; imported as "" so the entry stays on the board, which is what `
        + 'v1 draws for it (ATT-53)',
        false,
      );
      patch[name] = '';
      continue;
    }
    // The clear. Only where there is something to clear — see the docblock.
    if (carries(regs, key, name)) patch[name] = null;
  }

  // A3-H2 — the coercion that needs the WHOLE patch, after the field loop and identical to
  // `migrate1to2.js`'s: a repeat with no anchor date is turned off, because `layout.js:72` cannot
  // expand it and takes the whole board down trying.
  //
  // R4-10 REMOVED ITS TWIN. A bar edge the import does not carry used to be ANCHORED here to the
  // edge it does — one day instead of the nine column-segments v1 paints — and the migration door
  // did the same thing, so both doors agreed on the same wrong board. `entities.js:renderableBar`
  // already keeps an OWN bar with no dates so `layout.js` can paint it the way it always did; a
  // one-ended bar needs no rescue either, and an absent edge stays absent on this door too. What
  // was written as a `null` CLEAR above is exactly right for it: absent and cleared both mean "no
  // end", and `layout.js` runs such a bar to the horizon in v2 as it did in v1.
  if (kind === 'note' && patch.repeatsYearly === true && !isDateString(patch.date)) {
    warn(
      `${where}: it is marked as repeating yearly and has no usable date to repeat FROM; v1 `
      + 'cannot draw that board at all (layout.js:72 throws), so the repeat was turned off and '
      + 'the entry kept',
      true,
    );
    patch.repeatsYearly = false;
  }

  // Anything the file carried that v2 has no register for. v1 keeps unknown keys on an entry
  // object verbatim (`store.js:71-74` copies the arrays wholesale) and so does an export, so this
  // really happens; losing it silently would be exactly the "nothing is ever lost" violation the
  // product's principle 6 forbids. `id` is the entity KEY in v2, not a field (ADR 001 §1.1).
  for (const name of Object.keys(entry)) {
    if (name === 'id') continue;
    if (fieldsOf(kind).includes(name)) continue;
    // A v2 export carries the DERIVED decorations `materialize()` added — `entityKey`, `uuid`,
    // `createdAt`, `updatedBy`, `isNew`, `exposure`, … They are not data and they are not lost:
    // every one of them is re-derived from the registers on the next projection. Reporting them
    // as loss would make `lossy` true for every round-trip of the app's own export file, and a
    // store that refuses a lossy import (which is the point of `lossy`) would then refuse it.
    if (V2_ENTRY_FIELDS.includes(name)) continue;
    warn(`${where}: field ${q(name)} has no v2 register and was DROPPED`, true);
  }

  return patch;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Settings — one `pref.set` in the LOCAL space
//
// ADR 001 §8.5 step 5 scopes the transaction to "personal + local", and `local` is this: v1's
// `replaceAll` replaces `state.settings` too, and every settings field is a `pref` register
// (ADR 001 §3.3). `pref.set` carries NO gid and is never undone (rule U6, enforced by `makeOp`),
// which is consistent: story 5.4 excludes the whole import from undo anyway.
//
// The consequence for 19.4, and it is the right one: `pref.set` lives in the `local` space and is
// NEVER SYNCED, so importing a board on this Mac does not reach across and change the other Mac's
// row height. "My entire board syncs between my devices" means BOARD = CONTENT (`ops.js` §5).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Map} regs @param {Object} incoming @param {Object} opCtx
 * @param {(m:string,l:boolean)=>void} warn
 * @param {string|null} fallbackCatId v1's `store.js:84` dangling-reference fallback
 * @param {Set<string>} catIds the category ids that survived the import — v1's `store.js:83` set
 * @param {Object<string, any>|null} defaultPrefs `ctx.defaultSettings`, FLATTENED — see checkCtx
 * @returns {Object|null} the op, or null when there is nothing to write
 */
function buildPrefOp(regs, incoming, opCtx, warn, fallbackCatId, catIds, defaultPrefs) {
  const settings = incoming.settings;
  if (settings !== undefined && !isPlainObject(settings)) {
    warn(`settings is not an object (${q(typeof settings)}); treated as empty`, true);
  }

  /** @type {Object<string, any>} */
  const next = {};
  for (const key of Object.keys(isPlainObject(settings) ? settings : {})) {
    if (FORBIDDEN_KEY(key)) {
      warn(`settings key ${q(key)} is forbidden in a field patch and was DROPPED`, true);
      continue;
    }
    try {
      // One key at a time, so a single bad key costs one key and not the whole settings object.
      Object.assign(next, flattenPref({ [key]: settings[key] }));
    } catch (e) {
      // `RangeError` alongside `OpError`, and it is the door policy rather than defensiveness:
      // `flattenPref` recurses once per level of nesting, so a hand-edited `settings` nested a few
      // thousand deep overflows the stack. This door may not THROW on a hostile file — it refuses
      // the key and says so. `migrate1to2.js` catches the same pair, for the same reason.
      if (!(e instanceof OpError) && !(e instanceof RangeError)) throw e;
      warn(`setting ${q(key)}: ${e.message}; DROPPED`, true);
    }
  }
  for (const name of Object.keys(next)) {
    if (FORBIDDEN_KEY(name) || !accepts('pref', name, next[name])) {
      warn(`setting ${q(name)} = ${q(next[name])} is not a JSON scalar and was DROPPED`, true);
      delete next[name];
    }
  }

  // ── v1's two settings repairs (`store.js:86,90`), which run on EVERY import ────────────────
  // `replaceAll(next)` is `this.state = migrate(next)`, and `migrate` performs both. They are
  // done on the FLATTENED patch, i.e. on what actually reaches the log, exactly as the migration
  // door does them — see `migrate1to2.js` §5 step 4.
  if (Object.prototype.hasOwnProperty.call(next, 'lastCategoryId')
      && fallbackCatId !== null && next.lastCategoryId !== fallbackCatId
      && !catIds.has(next.lastCategoryId)) {
    warn(
      `settings.lastCategoryId ${q(next.lastCategoryId)} names no category in the import; `
      + `repaired to ${q(fallbackCatId)} (v1 store.js:86)`,
      false,
    );
    next.lastCategoryId = fallbackCatId;
  }
  // 7.5 — „ein Ferien-Layer ohne Bundesland kann nichts bedeuten". v1 normalises this on every
  // load AND every import (`store.js:90`).
  if (next['layers.schulferien'] === true && !next.bundesland) {
    warn('settings.layers.schulferien is on with no Bundesland; normalised to off (7.5, v1 store.js:90)', false);
    next['layers.schulferien'] = false;
  }

  // ── The clears ─────────────────────────────────────────────────────────────────────────────
  //
  // A pref this device holds that the imported board does not carry reverts to its v1 DEFAULT,
  // because that is what v1's whole-object replacement does: `migrate()` spreads
  // `{...d.settings, ...(s.settings||{})}` (`store.js:76-80`), so an omitted key comes back as
  // `defaultState().settings`'s value — not as `null`, and not as absent.
  //
  // REG-8, and this is the half of it that lives in THIS file. Writing `null` was an attempt to
  // say "revert to the default" in a register, and a register cannot distinguish that from "the
  // file literally says null". They are not the same board: v1 reads a null `layers.feiertage`
  // as OFF (`layout.js:243`, `s.layers.feiertage &&`) and a MISSING one as ON (the default).
  // `materialize.js:applyClearedPrefs` resolves a null register the only way it can — as v1's
  // reading of null — so a clear meaning "default" and a clear meaning "null" would land on
  // opposite settings for the two prefs whose default is `true` (`layers.feiertage`,
  // `menuBarIcon`), and an import that simply omitted `layers` would silently turn the holiday
  // layer OFF.
  //
  // So the ambiguity is removed at the source: write the DEFAULT VALUE. `null` survives only for
  // a register with no default at all (a v2 extra, a pref this build has never heard of), where
  // "gone" really is the whole meaning and there is nothing else to say.
  //
  // See PRESERVED_PREF_PREFIXES for the two families that are bookkeeping rather than settings
  // and are therefore left alone.
  let clearedWithoutDefault = 0;
  for (const name of cellsOf(regs, PREF_KEY).keys()) {
    if (Object.prototype.hasOwnProperty.call(next, name)) continue;
    if (!carries(regs, PREF_KEY, name)) continue;              // already cleared; nothing to clear
    if (PRESERVED_PREF_PREFIXES.some((p) => name === p || name.startsWith(`${p}.`))) continue;
    if (defaultPrefs && Object.prototype.hasOwnProperty.call(defaultPrefs, name)) {
      next[name] = defaultPrefs[name];
      continue;
    }
    if (defaultPrefs) { next[name] = null; continue; }         // a v2 extra: "gone" is the meaning
    clearedWithoutDefault += 1;
    next[name] = null;
  }
  if (clearedWithoutDefault) {
    // Not lossy — the board is intact either way — but not silent either. A store that does not
    // supply `ctx.defaultSettings` gets v1's reading of `null` for these, which differs from
    // v1's reading of an OMITTED pref for exactly the booleans whose default is `true`.
    warn(
      `${clearedWithoutDefault} setting${clearedWithoutDefault === 1 ? '' : 's'} this device holds `
      + 'and the import does not were CLEARED rather than reset to their v1 default, because no '
      + 'ctx.defaultSettings was supplied; a boolean setting whose default is on will read as off',
      false,
    );
  }

  const names = Object.keys(next).sort();
  if (!names.length) return null;
  // Sorted, so the op's bytes depend on the SETTINGS and not on the key order the file happened
  // to be written in — the same determinism `migrate1to2.js` §5 step 4 wants, for the same reason.
  const sorted = {};
  for (const name of names) sorted[name] = next[name];
  return prefSet(opCtx, sorted);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. ctx
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @returns {{act:string, dev:string, space:string, gid:string, newOpId:()=>string,
 *            defaultPrefs: Object<string,any>|null}}
 */
function checkCtx(ctx) {
  if (!isPlainObject(ctx)) throw new ReplaceError('planReplaceAll: a ctx {mint, me, deviceId} is required');
  if (typeof ctx.mint !== 'function') {
    throw new ReplaceError('planReplaceAll: ctx.mint is required — core/ may not read a clock (ADR 005 §2), and a FRESH stamp per op is what makes the import win on every peer');
  }
  if (!isMemberId(ctx.me)) throw new ReplaceError(`planReplaceAll: ctx.me must be a MemberId, got ${q(ctx.me)}`);
  if (!isDeviceId(ctx.deviceId)) throw new ReplaceError(`planReplaceAll: ctx.deviceId must be a DeviceId, got ${q(ctx.deviceId)}`);

  const psp = ctx.personalSpaceId;
  let space = PERSONAL_PLACEHOLDER;
  if (psp !== undefined && psp !== null) {
    if (!isSpaceId(psp) || !String(psp).startsWith('psp_')) {
      throw new ReplaceError(`planReplaceAll: ctx.personalSpaceId must be a psp_… id or null, got ${q(psp)}`);
    }
    space = psp;
  }

  const newOpId = ctx.newOpId ?? defaultOpId;
  if (typeof newOpId !== 'function') throw new ReplaceError('planReplaceAll: ctx.newOpId must be a function');
  const newGid = ctx.newGid ?? defaultGroupId;
  if (typeof newGid !== 'function') throw new ReplaceError('planReplaceAll: ctx.newGid must be a function');
  // ONE gid for the whole transaction (rule U1): one user action, one group. Import is not
  // undoable (story 5.4), but "not undoable" and "400 separate undo groups" are different
  // failures, and only the first one is the spec's.
  const gid = ctx.gid ?? newGid();

  // `ctx.defaultSettings` — v1's `defaultState().settings`, the same object the store already
  // hands `materialize()`. OPTIONAL, because `core/` may not read `store.js` (ADR 005 §2) and a
  // caller that has not been retrofitted yet must still get a working transaction; a caller that
  // omits it is told, once, in the warnings — see the clear loop in `buildPrefOp`.
  //
  // Flattened HERE rather than in that loop so a malformed one is a CALLER error, refused before
  // a single op is built, rather than a per-key warning buried in a 400-op transaction.
  let defaultPrefs = null;
  if (ctx.defaultSettings !== undefined && ctx.defaultSettings !== null) {
    if (!isPlainObject(ctx.defaultSettings)) {
      throw new ReplaceError(`planReplaceAll: ctx.defaultSettings must be a settings object, got ${q(ctx.defaultSettings)}`);
    }
    defaultPrefs = {};
    for (const key of Object.keys(ctx.defaultSettings)) {
      if (FORBIDDEN_KEY(key)) continue;
      try {
        Object.assign(defaultPrefs, flattenPref({ [key]: ctx.defaultSettings[key] }));
      } catch (e) {
        if (!(e instanceof OpError)) throw e;
        throw new ReplaceError(`planReplaceAll: ctx.defaultSettings.${key} is not a settings value: ${e.message}`);
      }
    }
    for (const name of Object.keys(defaultPrefs)) {
      if (FORBIDDEN_KEY(name) || !accepts('pref', name, defaultPrefs[name])) delete defaultPrefs[name];
    }
  }

  return { act: ctx.me, dev: ctx.deviceId, space, gid, newOpId, defaultPrefs };
}

/** @returns {Object[]} the array, or `[]` with a warning */
function takeArray(v, name, warn) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    warn(`${name} is not an array (${q(typeof v)}); treated as empty, so everything it held is GONE`, true);
    return [];
  }
  return v;
}
