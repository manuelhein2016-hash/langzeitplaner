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
  LOCAL_SPACE, PERSONAL_PLACEHOLDER, OpError,
  makeOp, opKindForEntity, fieldsOf, isPubField, flattenPref,
  noteSet, barSet, catSet, padSet, prefSet,
} from './ops.js';
import {
  PREF_KEY, parseEntityKey, isMemberId, isDeviceId, isSpaceId, isEntityUuid, isMonthKey,
} from './entities.js';
import { fmt } from './stamp.js';
// One import, one frozen array of names, no behaviour. `materialize.js` is the single authority
// on which entry fields are v2-ADDITIVE — it is the file that decides which ones it decorates
// with — and `undo.js` already reaches for it for the same question, with the same justification.
// A second list here would be a second answer to "is `createdAt` data, or is it derived?", and
// the answer decides whether re-importing my own export is reported as DATA LOSS.
import { V2_ENTRY_FIELDS } from './materialize.js';
import { ZERO_DEVICE_SHORT, opId as defaultOpId, groupId as defaultGroupId } from './ids.js';

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
 * The fields that get a VALUE when the import does not supply one — never `null`.
 *
 * `visibility: 'privat'` is story 16.1 stated as a constant, and it is the one default in here
 * that is load-bearing for privacy: an imported entry with no visibility register would be an
 * entry whose exposure is decided by whatever code reads the absence, and ADR 004 exists to stop
 * exactly that. `_alive: true` is what "present in the import" MEANS — it is forced, not
 * defaulted, so a hand-edited `_alive: false` on an entry the file also lists cannot produce an
 * entity that is imported and dead at the same time.
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

/** Top-level `board.json` keys this module knows. `_v2` is ADR 001 §8.4's one additive key. */
const KNOWN_BOARD_KEYS = Object.freeze(['schemaVersion', 'notes', 'bars', 'categories', 'scratchpads', 'settings', '_v2']);

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
  const { act, dev, space, gid, newOpId } = checkCtx(ctx);
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
  for (const { kind, from, set, singular } of COLLECTIONS) {
    const list = takeArray(incoming[from], from, warn);
    const seen = new Set();
    for (const entry of list) {
      if (!isPlainObject(entry)) {
        warn(`a ${singular} in the import is not an object (${q(entry)}) and was DROPPED`, true);
        continue;
      }
      const id = entry.id;
      if (!isEntityUuid(id)) {
        warn(`a ${singular} in the import has no usable id (${q(id)}) and was DROPPED`, true);
        continue;
      }
      if (seen.has(id)) {
        // Two registers cannot share an entity key; the second would LWW over the first inside a
        // single transaction and silently merge two entries. v1's arrays tolerate this, v2 cannot.
        warn(`${singular} ${q(id)} appears more than once in the import; only the first was taken`, true);
        continue;
      }
      seen.add(id);
      const key = `${kind}:${id}`;
      present.add(key);
      emit(set(opCtx, id, buildPatch(kind, entry, regs, key, `${singular} ${q(id)}`, warn), { born: true }));
      written.push(key);
    }
    if (kind === 'cat' && list.length && seen.size === 0) {
      warn('no category in the import survived; every imported entry will fall back to a category that does not exist', true);
    }
    if (kind === 'cat' && !list.length) {
      // v1's `migrate()` substitutes `defaultState().categories` here, minting four random uuids
      // (`store.js:73`). This module must not: `core/` may not read a CSPRNG directly (ADR 005
      // §2), and inventing ids inside a transaction two devices both receive would give each
      // device a different four categories.
      warn('the imported board carries no categories; the board will have none until one is created', false);
    }
  }

  // ── step 2b — scratchpads ─────────────────────────────────────────────────
  // Keyed by month, not by uuid (F10). An EMPTY string is kept, unlike migration (§8.2 takes
  // non-empty keys only): v1's `replaceAll` installs the payload's `scratchpads` object verbatim
  // (`store.js:74`), so a `''` in the file is a `''` on the board, and this is a replacement of
  // that object rather than a conversion of a legacy one.
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
    if (typeof text !== 'string') {
      warn(`scratchpad ${q(month)} is not a string (${q(text)}) and was DROPPED`, true);
      continue;
    }
    const key = `pad:${month}`;
    present.add(key);
    emit(padSet(opCtx, month, buildPatch('pad', { text }, regs, key, `scratchpad ${q(month)}`, warn), { born: true }));
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
  }

  // ── step 3b — settings, in the LOCAL space (§8.5 step 5's other half) ─────
  const prefOp = buildPrefOp(regs, incoming, opCtx, warn);
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
  return planReplaceAll(regs, incoming, ctx).ops;
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
 * @returns {Object} the field patch (`_born` is added by `makeOp`)
 */
function buildPatch(kind, entry, regs, key, where, warn) {
  const defaults = IMPORT_DEFAULTS[kind];
  const carried = CARRIED_FIELDS[kind];
  const patch = {};

  for (const name of fieldsOf(kind)) {
    if (name === BORN) continue;                       // written by makeOp from the op's own stamp

    const supplied = Object.prototype.hasOwnProperty.call(entry, name);
    const value = entry[name];
    const ok = supplied && value !== undefined && accepts(kind, name, value);

    if (Object.prototype.hasOwnProperty.call(defaults, name)) {
      if (name === ALIVE) {
        // Forced, never taken from the file: presence in the import IS aliveness.
        if (supplied && value !== true) {
          warn(`${where}: the import lists it AND marks it ${q(name)} = ${q(value)}; it is imported ALIVE`, false);
        }
        patch[name] = defaults[name];
        continue;
      }
      if (supplied && !ok) {
        warn(`${where}: field ${q(name)} = ${q(value)} is not representable in v2; the default ${q(defaults[name])} was used instead`, true);
      }
      patch[name] = ok ? value : defaults[name];
      continue;
    }

    if (!carried.includes(name)) continue;             // unreachable — pinned by checkCoverage()

    if (ok) {
      patch[name] = value;
      continue;
    }
    if (supplied && value !== undefined) {
      warn(`${where}: field ${q(name)} = ${q(value)} is not representable in v2 and was DROPPED`, true);
    }
    // The clear. Only where there is something to clear — see the docblock.
    if (carries(regs, key, name)) patch[name] = null;
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

/** @returns {Object|null} the op, or null when there is nothing to write */
function buildPrefOp(regs, incoming, opCtx, warn) {
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
      if (!(e instanceof OpError)) throw e;
      warn(`setting ${q(key)}: ${e.message}; DROPPED`, true);
    }
  }
  for (const name of Object.keys(next)) {
    if (FORBIDDEN_KEY(name) || !accepts('pref', name, next[name])) {
      warn(`setting ${q(name)} = ${q(next[name])} is not a JSON scalar and was DROPPED`, true);
      delete next[name];
    }
  }

  // The clears: a pref this device holds that the imported board does not carry reverts to its
  // v1 DEFAULT, because that is what v1's whole-object replacement does. `null` is how a register
  // log says that — `materialize.js` skips a cleared register and `buildSettings` then supplies
  // `defaultState().settings`'s value. See PRESERVED_PREF_PREFIXES for the two families that are
  // bookkeeping rather than settings and are therefore left alone.
  for (const name of cellsOf(regs, PREF_KEY).keys()) {
    if (Object.prototype.hasOwnProperty.call(next, name)) continue;
    if (!carries(regs, PREF_KEY, name)) continue;              // already cleared; nothing to clear
    if (PRESERVED_PREF_PREFIXES.some((p) => name === p || name.startsWith(`${p}.`))) continue;
    next[name] = null;
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

/** @returns {{act:string, dev:string, space:string, gid:string, newOpId:()=>string}} */
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

  return { act: ctx.me, dev: ctx.deviceId, space, gid, newOpId };
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
