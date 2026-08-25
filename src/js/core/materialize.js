// src/js/core/materialize.js — RegisterMap + ctx → the EXACT v1 state shape.
// ADR 001 §5, §1.4, §11 · ADR 004 §4, §5, §6, §7.2 · ops.contract.js §5 · ADR 005 §1.1, §2.
//
// DOM-free, I/O-free, imports nothing outside core/ (ADR 005 §2).
//
// THE CONTRACT, IN ONE SENTENCE (ADR 001 §5):
//   for a SOLO board the output is deep-equal to what `store.state` held in v1.
// `layout.js` and `board.js` are unchanged for solo mode. Everything v2 adds is ADDITIVE on the
// entry objects (ADR 001 §8.4), which is why a v1 build still loads a v2 board.
//
// FOUR THINGS IN HERE ARE LOAD-BEARING AND EASY TO BREAK. Each is commented where it happens.
//
// 1. THE PROMOTION ASYMMETRY (ADR 004 §4.1, property P7c). For my own entries I read the TRUTH
//    registers and then promote a co-editor's `pub.*` write — but NEVER my own `pub.*` writes.
//    They are projections *of* the truth, not edits *to* it, which is exactly why publishing
//    `pub.text: null` for a Belegt downgrade does not blank my own note. ADR 004 §4.1 requires
//    this sentence to appear in this file; it does, again, at `promote()`.
//
// 2. THE SORTS ARE MANDATORY, NOT COSMETIC (ADR 001 §5 step 5). v1's capacity slice
//    (`layout.js:209`) and per-column lane rescue (`layout.js:162-177`) are order-sensitive, so
//    array order is USER-VISIBLE (stories 2.4, 2.5, 3.8). Two devices that folded the same ops
//    into different array orders would render different "+n" chips from identical data. The
//    comparators live in entities.js and every one of them is total — `_born` first, entity id
//    as the final tiebreak — so `materialize` is a pure deterministic function of the registers
//    and the convergence proof's step 5 (ADR 001 §6) holds byte for byte.
//
// 3. MEANING IS NEVER INFERRED FROM ABSENCE (ADR 001 §5 step 3, ADR 004 §13.6). A register whose
//    value is `null` is CLEARED, not "empty": step 1 skips it, and `renderable()` then refuses
//    the entity rather than guessing. A Geteilt note whose `pub.text` has not arrived yet is
//    INVISIBLE, not "Belegt". No default is fabricated for a missing field anywhere in this file
//    — `repeatsYearly` stays absent rather than becoming `false`, because a fabricated `false` is
//    indistinguishable from an authored one and that is the bug class ADR 004 exists to prevent.
//
// 4. A FOREIGN ENTRY IS GATED BY ITS MEMBER, NEVER BY A CATEGORY (A3, 17.3). Foreign entries have
//    no `categoryId` at all — `categoryId` has no `pub.` counterpart at any level — so the
//    reference-repair pass (step 7) must not touch them, and neither must the category filter.
//    Routing a foreign entry through `categoryVisible(undefined)` would answer "visible" by v1's
//    dangling-reference rule; correct by accident is not good enough for a privacy control.
//
// WHAT THIS FILE DOES NOT DO. There is no incremental applier (ADR 001 §5.1): `materialize()` is
// a full rebuild and there is deliberately no second code path guarded by an equivalence test,
// because the fast one is the one that gets a clever optimization at 2 a.m. It also performs no
// authorization — every op reaching the RegisterMap was already admitted by `foldAuthorized`
// (ADR 001 §4) — and it never mutates `regs`.

import {
  parseEntityKey, familyKeyFor,
  projectable, sortNotes, sortBars, sortCategories, sortScratchpads,
} from './entities.js';
import { FIELDS, coEditableFields } from './ops.js';
import { cmpWrites, promoteRegister, withdrawnByOther, createdAt, updatedAt, updatedBy } from './registers.js';

// ops.contract.js §5 groups the three derived timestamps with materialization; ADR 005 §1.1 puts
// the register queries in `registers.js`, and that is where they are implemented, because none of
// them needs a MaterializeCtx. Re-exported here so both documents' import paths resolve — aliases,
// never copies. A second implementation of `updatedAt` is a second answer to "geändert wann?".
export { createdAt, updatedAt, updatedBy };

// ─────────────────────────────────────────────────────────────────────────────
// 0. The v1 settings defaults (ADR 001 §5 step 6)
//
// `core/` may not import `store.js` (ADR 005 §2 — the dependency direction is one-way and the
// purity gate enforces it mechanically), so v1's `defaultState().settings` cannot be reached from
// here. It is duplicated below, MINUS the two members v1 computes from the wall clock and from a
// freshly minted uuid:
//
//   startMonth     v1: monthKeyOf(todayISO())  — a clock read, forbidden in core/ (ADR 005 §2)
//   lastCategoryId v1: cats[0].id              — a uuid that does not exist until the categories do
//
// Both are `null` here and both are repaired downstream: `lastCategoryId` by the same
// dangling-reference rule v1 applies at `store.js:86`, `startMonth` by the caller. `store.js`
// passes its own `defaultState().settings` as `ctx.defaultSettings`, so in the real app there is
// exactly one source of truth and this constant is only the headless fallback. The duplication is
// pinned by a test that diffs it against the real `defaultState()` key by key.
//
// "REPAIRED BY THE CALLER" WAS AN UNGUARDED HOLE, AND IT WAS AN APP HANG (ATT-97). A caller who
// omits `ctx.defaultSettings` got `startMonth: null`; `layout.js:25` then parses `'null-01'` into
// `{y: NaN, m: NaN}` and `holidays.js:51`'s `while (dow(year, 11, d) !== 3) d -= 1;` never
// terminates. `buildSettings` now THROWS on exactly the combination that reaches that code —
// `mode === 'pinned'` with an unparseable `startMonth` — so this constant cannot be used to
// render a pinned board by accident. It is still exported: it is what a test diffs against, and
// what a caller merges its own clock read into.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * v1 `defaultState().settings`, minus the two dynamic members.
 * NOT SAFE AS A `ctx.defaultSettings` for a pinned board — `startMonth` is `null` and
 * `buildSettings` refuses it. Pass v1's own `defaultState().settings` instead.
 * @type {Readonly<Object>}
 */
export const DEFAULT_SETTINGS = Object.freeze({
  bundesland: '',
  layers: Object.freeze({
    feiertage: true,
    schulferien: false,
    otherStates: false,
    ferienPattern: false,
  }),
  mode: 'rolling',
  startMonth: null,
  pageYears: 0,
  language: 'de',
  launchAtLogin: false,
  menuBarIcon: true,
  rowHeight: 22,
  colWidth: 118,
  paper: 'a4',
  lastCategoryId: null,
  seenFirstRun: false,
});

/** The schemaVersion `materialize()` stamps on its output (ops.contract.js §5). */
export const SCHEMA_VERSION_V2 = 2;

/** The one entity that carries the device-local prefs (ADR 001 §3.3). */
export const PREF_ENTITY = 'pref:app';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Register helpers
// ─────────────────────────────────────────────────────────────────────────────

/** @typedef {{ value:any, stamp:string, author:string }} Register */
/** @typedef {Map<string, Map<string, Register>>} RegisterMap */

const EMPTY = new Map();

/** @param {RegisterMap} regs @param {string} e @returns {Map<string, Register>} never null */
const cellsOf = (regs, e) => (regs && regs.get(e)) || EMPTY;

/**
 * `null` means the register was CLEARED / REDACTED and is never a value (ADR 001 §5 step 1,
 * ADR 004 §5.1). `undefined` cannot occur — `f` is scalars-or-null by contract — but is treated
 * the same way so a hand-built RegisterMap in a test cannot smuggle a hole through.
 * @param {Register|undefined} r @returns {boolean}
 */
const carries = (r) => !!r && r.value !== null && r.value !== undefined;

/**
 * The same three derivations over an explicit register list — which is what materialization needs,
 * because for one of my own entries the registers that produced the projected values are the
 * TRUTH registers plus whichever `pub.*` registers won promotion. Attributing "geändert" to a
 * co-editor's promoted write is 17.6; attributing it to a register whose value was not used
 * would be a lie about what changed.
 * @param {Register[]} list
 * @returns {{createdAt:string|null, updatedAt:string|null, updatedBy:string|null}}
 */
function derivedTimes(list) {
  let min = null, best = null;
  for (const r of list) {
    if (!r) continue;
    if (min === null || r.stamp < min) min = r.stamp;
    if (best === null || cmpWrites(r, best) > 0) best = r;
  }
  return {
    createdAt: min,
    updatedAt: best ? best.stamp : null,
    updatedBy: best ? best.author ?? null : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. The truth ⇄ publication field mapping
//
// Derived from `FIELDS` rather than written out, so a field added to `fnote` next year cannot be
// silently dropped on the viewer side — and so the promotable set cannot drift away from the
// co-edit predicate that ADR 001 §4.3 stage 3b enforces at the authorization layer.
// ─────────────────────────────────────────────────────────────────────────────

/** `pub.date` → `date`, `pub.level` → `level`, `_born` → `_born`. The viewer-side rename. */
const displayName = (field) => (field.startsWith('pub.') ? field.slice(4) : field);

/**
 * The fields promotion may carry from the family space back onto my own entry: exactly those a
 * CO-EDITOR is allowed to write (`coEdit: true` on the family side) AND that name a co-editable
 * truth field. `pub.coEdit`, `pub.level`, `pub.alive` and `_born` are GOVERNING fields — owner or
 * admin only, folded in the earlier stage — and are therefore absent here by construction, which
 * is what makes "a co-editor can never grant themselves co-edit" (ADR 004 §8) structural rather
 * than a rule someone has to remember.
 * @type {Readonly<Object<string, Readonly<Object<string,string>>>>} truthKind → { pubField: truthField }
 */
export const PROMOTABLE = Object.freeze(
  Object.fromEntries(
    [['note', 'fnote'], ['bar', 'fbar']].map(([truthKind, famKind]) => {
      const map = {};
      for (const pubField of coEditableFields(famKind)) {
        const name = displayName(pubField);
        const spec = FIELDS[truthKind][name];
        if (spec && spec.coEdit === true) map[pubField] = name;
      }
      return [truthKind, Object.freeze(map)];
    }),
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// 3. Step 1 + step 2 — project one entity into a candidate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Step 1: `entity[field] = register.value`, skipping registers whose value is `null`.
 *
 * ADDITIVE CONSTRUCTION FROM THE FROZEN FIELD TABLE, on the READ side. Only register names
 * declared in `FIELDS[kind]` reach the entry. `validateOp` already parks an op carrying an
 * undeclared field, so in a well-formed log this filter never fires — which is exactly why it is
 * here. A register named `text` or `categoryId` sitting on an `fnote:` key could only arrive from
 * a modified client or a hand-edited checkpoint, and without this line it would be renamed
 * straight onto the rendered entry: `categoryId` would put another member's entry into one of my
 * categories (A3), and a raw `text` would render content the redaction boundary never published.
 * This is barrier 1 of ADR 004 §2.2 pointed the other way, and it costs one `has()`.
 *
 * `id` SEEDS THE OBJECT (ATT-51). v1 writes `id` first in every entry it creates
 * (`interact.js`, `store.js:19-24`), so `board.json` reads `{"id": …, "date": …}` and a user
 * diffing two exports — 11.4 promises the file stays human-readable — sees one changed line, not
 * a whole re-ordered object. Assigning `id` in the decoration pass instead put it LAST, because
 * a key added to a JS object after the fact keeps its insertion position. Seeding it here is the
 * whole fix: `Object.assign(fields, {id, …})` downstream then rewrites the same value in place.
 *
 * @param {Map<string, Register>} cells
 * @param {string} kind          key into FIELDS
 * @param {(f:string)=>string} rename
 * @param {string} id            the v1 `id` token for this entry — always the FIRST key
 * @returns {{fields:Object, used:Register[]}}
 */
function projectCells(cells, kind, rename, id) {
  const fields = { id };
  const used = [];
  // The iteration order is `FIELDS[kind]`'s DECLARATION order, never the register map's.
  // Map iteration order is op-ARRIVAL order: projecting in it would give two devices holding
  // identical registers different key orders in the same entry, and `board.json` is
  // human-readable (11.4) and byte-compared. Determinism here is the same requirement as the
  // array sorts in step 5 — it is just one level further down.
  for (const field of FIELD_ORDER[kind] || []) {
    const reg = cells.get(field);
    if (!carries(reg)) continue;
    fields[rename(field)] = reg.value;
    used.push(reg);
  }
  return { fields, used };
}

/** Declared field names per kind, wildcards dropped — the canonical projection order. */
const FIELD_ORDER = Object.freeze(Object.fromEntries(
  Object.entries(FIELDS).map(([kind, table]) => [
    kind, Object.freeze(Object.keys(table).filter((f) => !f.includes('*'))),
  ]),
));

/**
 * PROMOTION — the correctness heart of ADR 004 (§4.1, property P7c).
 *
 *     effective[f] = maxByStamp( truth[f], pub[f] where pub[f].author !== me )
 *
 * NEVER PROMOTE MY OWN `pub.*` WRITES. They are projections *of* the truth, not edits *to* it —
 * which is exactly why publishing `pub.text: null` to make an entry Belegt does not blank my own
 * note. ADR 004 §4.1 requires this comment to live in this file.
 *
 * A `null` from a CO-EDITOR is promoted like any other value — clearing my text is an edit and
 * `null` is a first-class value (R9, ADR 004 §5.1). An ADMIN UNSHARE (18.3) also writes nulls,
 * and it must NOT blank my own note; the two are separated by `registers.js:withdrawnByOther`,
 * which is where the full argument lives.
 *
 * BOTH RULES LIVE IN `registers.js`, which this function delegates to. This comment stays here
 * because ADR 004 §4.1 requires it to; the CODE does not, because a second implementation of the
 * correctness heart is a second thing to get wrong.
 *
 * @param {Object} fields   the truth projection, mutated in place (a fresh object we own)
 * @param {Register[]} used the truth registers that produced it, appended to
 * @param {Map<string, Register>} truthCells
 * @param {Map<string, Register>} pubCells
 * @param {string} truthKind 'note' | 'bar'
 * @param {string|null} me
 */
function promote(fields, used, truthCells, pubCells, truthKind, me) {
  if (withdrawnByOther(pubCells, me)) return;        // ← story 18.3. See withdrawnByOther().
  for (const [pubField, truthField] of Object.entries(PROMOTABLE[truthKind])) {
    const t = truthCells.get(truthField);
    const p = pubCells.get(pubField);
    // ONE implementation of the rule, and it is `registers.js:promoteRegister`. It is a pure
    // register→register function, so calling it here costs nothing and removes the second copy
    // that ADR 001 §5.1 rejects for the materializer itself.
    const winner = promoteRegister(t, p, me);
    if (winner === undefined || winner === t) continue;  // the truth stood; step 1 emitted it
    if (carries(winner)) {
      fields[truthField] = winner.value;
      used.push(winner);
      continue;
    }
    // The co-editor's write wins AND it is `null` — an explicit CLEAR, not an absence. `null` is
    // a first-class value (ADR 004 §5.1, risk R9) and story 18.2 says a co-editor may clear my
    // field. Step 1 ran BEFORE promotion and already emitted the truth value, so the field has to
    // be withdrawn from the projection now — "skip registers whose value is null" (ADR 001 §5
    // step 1) applies to the EFFECTIVE register, not to the truth register it replaced.
    //
    // Getting this wrong is invisible in the obvious direction: skipping the null instead leaves
    // the owner's stale text on screen and looks like nothing happened. It was caught by a
    // negative control on the family leg of core-integration.test.js, not by a unit test.
    //
    // The admin unshare, which also writes nulls, never reaches here — `withdrawnByOther` above
    // returned early — so this cannot blank the owner's own note (INV-R3).
    delete fields[truthField];
    const i = used.indexOf(t);
    if (i >= 0) used.splice(i, 1);   // and it must stop claiming 17.6's „geändert" line
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Step 4 — decoration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The exposure badge (16.6, ADR 004 §6). "The badge must never promise a privacy state that has
 * not yet reached the server", so it is derived from WHAT ACTUALLY REACHED THE LOG, not from my
 * local intent: a pending upgrade shows the old, LOWER exposure; a pending downgrade shows the
 * old, HIGHER one. Both errors point the same way — the badge never under-reports what others can
 * see.
 *
 * ADR 004 §6 spells the rule with `outboxHasPendingPubOp(entity)`, which `MaterializeCtx`
 * (ops.contract.js §5) does not carry. Two hooks are accepted and neither is required:
 *   ctx.lastAckedPubLevel(e)  the family `pub.level` restricted to ops that carry a server seq
 *   ctx.pendingPub(e)         true iff the outbox still holds a pub op for `e`
 * With only the first, `pending` is `acked !== current`, which agrees with the ADR's formula on
 * every transition that changes the level — the only case the badge renders differently.
 * With neither, exposure is simply the current level, never pending: correct for a solo board and
 * for a family whose outbox is empty, which is the steady state.
 *
 * @param {Object} ctx @param {string} fkey @param {string|null} current
 * @returns {{level:string, pending:boolean}}
 */
function exposureOf(ctx, fkey, current) {
  const cur = current || 'privat';
  const acked = ctx.lastAckedPubLevel ? (ctx.lastAckedPubLevel(fkey) || 'privat') : cur;
  const pending = ctx.pendingPub ? !!ctx.pendingPub(fkey) : acked !== cur;
  return { level: acked, pending };
}

/**
 * The quiet „neu" dot (17.5, ADR 004 §7.2):
 *
 *     isNew(e) = maxSeq(e) > lastSeenSeq[space] && !levelDecreased(e) && pub.alive !== false
 *
 * The two SUPPRESSION clauses are enforced here and are not delegated: ADR 004 §7 forbids
 * surveillance mechanics, and "a retraction or downgrade never dots" / "a deletion never dots" is
 * that rule. A caller supplying a sloppy `seqOf` therefore still cannot make a downgrade blink.
 *
 * The comparison clause needs `maxSeq(e)` — a per-op SERVER sequence number. Registers carry
 * `{value, stamp, author}` and no seq (ADR 001 §7.2), so materialization cannot derive it; the
 * cursor layer owns it. Either hook supplies it, and with neither the dot is simply off:
 *   ctx.seqOf(e)  → the entity's max server seq, compared against ctx.lastSeenSeq[familySpaceId]
 *   ctx.isNew(e)  → the whole comparison, pre-computed
 *
 * @param {Object} ctx @param {string} fkey @param {boolean} alive @returns {boolean}
 */
function isNewOf(ctx, fkey, alive) {
  if (alive === false) return false;                                   // a deletion never dots
  if (ctx.levelDecreased && ctx.levelDecreased(fkey)) return false;    // a downgrade never dots
  if (ctx.seqOf) {
    const seen = (ctx.lastSeenSeq || {})[ctx.familySpaceId];
    const seq = ctx.seqOf(fkey);
    if (seq === null || seq === undefined) return false;
    if (seen === null || seen === undefined) return true;
    return cmpSeq(seq, seen) > 0;
  }
  if (ctx.isNew) return !!ctx.isNew(fkey);
  return false;
}

/**
 * Server seqs are decimal integers that outgrow `Number.MAX_SAFE_INTEGER` in principle and are
 * typed as strings by `MaterializeCtx`. Compare numerically when both sides are digit strings or
 * numbers, and fall back to the plain relational operator otherwise — never `Number()`, which
 * would round two distinct large seqs to the same value.
 */
function cmpSeq(a, b) {
  const num = (v) => (typeof v === 'bigint' ? v
    : typeof v === 'number' && Number.isInteger(v) ? BigInt(v)
      : typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : null);
  const na = num(a), nb = num(b);
  if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. The entry builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Members whose entries may appear at all (20.2). Absent, it is derived from `ctx.members`; absent
 * again it is EMPTY, not "everyone".
 *
 * This gate is a privacy control — it is what makes removing a member instantaneous on every
 * board without crypto and without a purge op — so it fails CLOSED. A malformed ctx hides
 * entries, which is visible and reportable; the other default would silently keep showing a
 * removed member's entries and nothing on screen would say so.
 */
function currentMembersOf(ctx) {
  if (ctx.currentMembers instanceof Set) return ctx.currentMembers;
  if (ctx.currentMembers) return new Set(ctx.currentMembers);
  if (ctx.members) return new Set(ctx.members.keys ? ctx.members.keys() : Object.keys(ctx.members));
  return new Set();
}

const memberRecord = (ctx, memberId) => {
  const m = ctx.members;
  if (!m) return null;
  return (m.get ? m.get(memberId) : m[memberId]) || null;
};

/**
 * One of MY entries: truth registers, then promotion, then the family-side decorations read out
 * of `fnote:<me>/<uuid>` / `fbar:<me>/<uuid>`.
 * @returns {Object|null} the candidate, or null when there is nothing to project
 */
function ownCandidate(regs, key, parsed, ctx) {
  const truthKind = parsed.kind;                       // 'note' | 'bar'
  const truthCells = cellsOf(regs, key);
  if (truthCells.size === 0) return null;

  const { fields, used } = projectCells(truthCells, truthKind, (f) => (f === '_alive' ? 'alive' : f), parsed.id);

  const me = ctx.me || null;
  const fkey = me && ctx.familySpaceId ? familyKeyFor(key, me) : null;
  const pubCells = fkey ? cellsOf(regs, fkey) : EMPTY;
  if (pubCells.size > 0) promote(fields, used, truthCells, pubCells, truthKind, me);

  const pubLevelReg = pubCells.get('pub.level');
  const level = carries(pubLevelReg) ? pubLevelReg.value : null;

  return Object.assign(fields, {
    id: parsed.id,
    uuid: parsed.id,
    entityKey: key,
    ownerId: me,
    isForeign: false,
    // `level` is what the FAMILY sees; `visibility` is my truth register and stays whatever it
    // says. They can legitimately disagree for one round trip after an admin unshare (ADR 004 §5),
    // and the owner's client reconciles it in a follow-up txn — not here, because materialization
    // never writes ops.
    level,
    redacted: false,
    memberColorRef: null,
    initial: null,
    exposure: fkey ? exposureOf(ctx, fkey, level) : null,
    isNew: false,                                      // 17.5 dots a PEER's change, never my own
    ...derivedTimes(used),
  });
}

/**
 * A FOREIGN entry: `pub.*` only. Truth fields for a foreign entity cannot exist, because they
 * were never transmitted (ADR 001 §5 step 2, ADR 004 §4.2).
 *
 * `id` is the whole entity key, not the uuid. v1's `id` is the token that addresses an entry in
 * the state arrays, and for a foreign entry that token IS the key: `layout.js:43`/`:56` index
 * bars by `id` and `entities.js`'s comparators use it as the final tiebreak, both of which need
 * it to be UNIQUE. A uuid is not — a member running a modified client can mint
 * `fbar:mem_them/<the uuid of one of my bars>`, and two entries sharing an `id` would collide in
 * `assignLanes`'s Map and in every id lookup. The entity key cannot collide, because its owner
 * segment is structural (ADR 001 §4.4). `uuid` carries the series id (ADR 004 §9) for callers
 * that need it.
 */
function foreignCandidate(regs, key, parsed, ctx) {
  const cells = cellsOf(regs, key);
  if (cells.size === 0) return null;

  const { fields, used } = projectCells(cells, parsed.kind, displayName, key);
  const owner = parsed.owner;
  const rec = memberRecord(ctx, owner);
  const level = typeof fields.level === 'string' ? fields.level : null;

  return Object.assign(fields, {
    id: key,
    uuid: parsed.id,
    entityKey: key,
    ownerId: owner,
    isForeign: true,
    level,
    // A Belegt block renders the word "belegt" in place of text and carries no category colour
    // anywhere (ADR 004 §4.2). It renders IDENTICALLY to one that was always Belegt — there is no
    // history, no „war geteilt", and nothing in this object from which one could be derived
    // (ADR 004 §7.1).
    redacted: level === 'belegt',
    memberColorRef: rec ? rec.colorRef ?? null : null,
    initial: rec ? rec.initial ?? null : null,
    exposure: null,                                    // exposure is MY disclosure state, not theirs
    isNew: isNewOf(ctx, key, fields.alive),
    ...derivedTimes(used),
  });
}

/** Strip the internal `alive` marker; everything else is the entry. */
function finish(candidate) {
  const { alive, ...entry } = candidate;   // eslint-disable-line no-unused-vars
  return entry;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Step 6 — settings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `pref:app` holds DOTTED register names with scalar values, because `f` is scalars-only by
 * contract (ADR 001 §2) and `pref` is not the one exception: `layers.feiertage`,
 * `lastSeenSeq.<spaceId>`, `hiddenMembers.<memberId>`. Rebuild the nested object v1's
 * `state.settings` is.
 *
 * Register names are SORTED before rebuilding. Map iteration order is op-arrival order, and an
 * unsorted rebuild would give two devices with identical registers different key orders in
 * `board.json` — which is human-readable (11.4) and compared byte-wise. Determinism here is the
 * same requirement as the array sorts in step 5.
 */
function prefsFromRegisters(regs) {
  const out = {};
  const cells = cellsOf(regs, PREF_ENTITY);
  for (const field of [...cells.keys()].sort()) {
    const reg = cells.get(field);
    if (!carries(reg)) continue;                       // a cleared pref falls back to the default
    const path = field.split('.');
    let node = out;
    let ok = true;
    for (let i = 0; i < path.length - 1; i++) {
      const seg = path[i];
      if (node[seg] === undefined) node[seg] = {};
      else if (node[seg] === null || typeof node[seg] !== 'object') { ok = false; break; }
      node = node[seg];
    }
    // A scalar already sitting where a branch has to go (`mode` and `mode.x` both present) is a
    // malformed pref set. Keep the scalar, drop the branch: `settings` feeds v1 code that has
    // never seen an object there, and a thrown error would make one bad pref unbootable.
    if (ok) node[path[path.length - 1]] = reg.value;
  }
  return out;
}

/** `YYYY-MM`. The only shape `layout.js:25` can parse (`parseISO(\`${startMonth}-01\`)`). */
const MONTH_KEY_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;

/**
 * Thrown when the projection cannot produce a settings object the v1 renderer can survive.
 * It is a THROW and not a repaired default because there is no honest repair available in here:
 * every candidate value for `startMonth` is a clock read, and `core/` may not read a clock
 * (ADR 005 §2). The caller — which does have a clock — must pass `ctx.defaultSettings`.
 */
export class MaterializeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MaterializeError';
  }
}

/**
 * Defaults, overridden by the prefs, with `layers` merged one level deep — `store.js:76-80`'s
 * defensive nested spread, verbatim, so a board written before a layer existed still gets it.
 *
 * The spread ORDER is also v1's, which is what makes the key order of the result identical to
 * v1's: every default first, in `defaultState()`'s order, then any extra key the prefs carry.
 *
 * TWO OF v1's LOAD-TIME REPAIRS ARE PROJECTION INVARIANTS HERE, and one is not.
 *
 *  · `store.js:86`'s `lastCategoryId` dangling-reference repair — below, with the same argument
 *    as the entry-level repair in step 7.
 *  · `store.js:89-91`'s "no Bundesland ⇒ schulferien off" (story 7.5) — below. THIS WAS THE
 *    ATT-30 DEFECT. It was left out on the reasoning that v1 applies it once, in `migrate()`, and
 *    a materializer that re-applied it would be changing v1 rather than reproducing it. That
 *    reasoning was wrong about v1: `replaceAll()` (`store.js`, import 11.3 and snapshot restore
 *    11.5) runs `migrate()` on EVERY incoming board, so v1 re-normalises on every whole-board
 *    load, and v2 rebuilds the whole board on every single projection. Without this line the
 *    invariant survives exactly until the first import and is then gone forever — a shipped v1
 *    guarantee dropped silently. `ferienIndex` is skipped by `layout.js:107` when there is no
 *    Bundesland anyway, so the layer could only ever render as a pressed toggle shading nothing.
 *  · `store.js:88`'s `paletteRef` backfill is still NOT reproduced: it needs `nextFreeRef` from
 *    `palette.js`, which is outside `core/` (ADR 005 §2). It stays the retrofit's job and is
 *    tested here as an absence.
 */
function buildSettings(regs, ctx, categories) {
  const d = ctx.defaultSettings || DEFAULT_SETTINGS;
  const p = prefsFromRegisters(regs);
  const settings = {
    ...d,
    ...p,
    layers: { ...(d.layers || {}), ...(p.layers || {}) },
  };
  // Step 7 for `lastCategoryId` — `store.js:86`, lifted into the projection like the entry-level
  // repair, so "delete the category that was last used" is idempotent and never rewrites the log.
  if (categories.length) {
    const ids = new Set(categories.map((c) => c.id));
    if (!ids.has(settings.lastCategoryId)) settings.lastCategoryId = categories[0].id;
  }

  // ATT-30 / story 7.5 — `store.js:89-91`, as a projection invariant. `settings.layers` is the
  // fresh object spread three lines up, so this mutates nothing the caller owns.
  if (!settings.bundesland) settings.layers.schulferien = false;

  // ATT-97 — THE HANG, CLOSED STRUCTURALLY.
  //
  // `DEFAULT_SETTINGS.startMonth` is `null`, because v1 computes it from the wall clock and
  // `core/` may not read one. The ADR called that "repaired downstream by the caller"; nothing
  // enforced it. A caller who omits `ctx.defaultSettings` therefore gets `startMonth: null`, and
  // `layout.js:25` then does `parseISO('null-01')` → `{y: NaN, m: NaN}` → `holidays.js:51`'s
  // `while (dow(year, 11, d) !== 3) d -= 1;` never terminates. Not a wrong pixel: the app hangs.
  //
  // Only `mode === 'pinned'` reads `startMonth` (`layout.js:24`), so that is exactly the
  // condition that is refused — loudly, at the projection, with the ctx key that fixes it named
  // in the message. A `'rolling'` board is untouched, which is what keeps a headless fold (a
  // test, a checkpoint verifier, a sync worker) working with a bare ctx.
  if (settings.mode === 'pinned' && !MONTH_KEY_RE.test(settings.startMonth)) {
    throw new MaterializeError(
      'materialize: settings.mode is "pinned" but settings.startMonth is '
      + `${JSON.stringify(settings.startMonth)}, which layout.js:25 cannot parse. `
      + 'Pass ctx.defaultSettings (v1 defaultState().settings) — core/ may not read a clock, '
      + 'so it cannot invent a start month, and rendering this board would hang the app '
      + '(holidays.js:51 loops forever on a NaN year).',
    );
  }
  return settings;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. materialize
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} MaterializeCtx
 * @property {string} [me]                         my MemberId; absent ⇒ solo
 * @property {Map<string,{displayName:string, colorRef:string, initial:string}>} [members]
 * @property {Set<string>} [currentMembers]        20.2 — a removed member's entries vanish at once
 * @property {string|null} [familySpaceId]         null ⇒ solo mode
 * @property {Set<string>} [hiddenMembers]         device-local per-member toggle (17.3)
 * @property {Object} [defaultSettings]            v1's `defaultState().settings`
 * @property {Object<string,string>} [lastSeenSeq] device-local (17.5)
 * @property {(e:string)=>string|null} [lastAckedPubLevel]  16.6 (ADR 004 §6)
 * @property {(e:string)=>boolean} [pendingPub]
 * @property {(e:string)=>string|number|null} [seqOf]
 * @property {(e:string)=>boolean} [isNew]
 * @property {(e:string)=>boolean} [levelDecreased]
 */

/**
 * RegisterMap + ctx → the exact v1 state shape.
 *
 * @param {RegisterMap} regs
 * @param {MaterializeCtx} [ctx]
 * @returns {{schemaVersion:number, notes:Object[], bars:Object[], categories:Object[],
 *            scratchpads:Object<string,string>, settings:Object}}
 */
export function materialize(regs, ctx = {}) {
  const me = ctx.me || null;
  const familySpaceId = ctx.familySpaceId ?? null;
  const currentMembers = currentMembersOf(ctx);
  const hiddenMembers = ctx.hiddenMembers instanceof Set
    ? ctx.hiddenMembers
    : ctx.hiddenMembers ? new Set(ctx.hiddenMembers) : null;
  const filterCtx = {
    currentMembers,
    ...(hiddenMembers ? { hiddenMembers } : {}),
  };

  const notes = [];
  const bars = [];
  const categories = [];
  const scratchpads = {};

  for (const key of regs ? regs.keys() : []) {
    const parsed = parseEntityKey(key);
    if (!parsed) continue;                             // not an entity key; nothing to project

    switch (parsed.kind) {
      case 'note':
      case 'bar': {
        const cand = ownCandidate(regs, key, parsed, ctx);
        // Step 3 — the filter, in the ADR's stated order. `projectable` drops a tombstone
        // (`alive === false`) and then applies `renderable()`: has date && has text for a note,
        // has both dates for a bar.
        if (cand && projectable(parsed.kind, cand, filterCtx)) {
          (parsed.kind === 'note' ? notes : bars).push(finish(cand));
        }
        break;
      }

      case 'fnote':
      case 'fbar': {
        // MY OWN publication is not a second entry on my board. It was read above, as promotion
        // and as the exposure badge. Projecting it here as well would duplicate every entry I
        // share the moment I share it — and would render my own note through the redaction path.
        if (me !== null && parsed.owner === me) break;
        // Solo mode is structurally untouched (ADR 001 §11): with no family space there is no
        // viewer side at all, so a stray family register cannot reach the board.
        if (!familySpaceId) break;
        const truthKind = parsed.kind === 'fnote' ? 'note' : 'bar';
        const cand = foreignCandidate(regs, key, parsed, ctx);
        // `projectable` applies, in order: tombstone (`pub.alive === false`), level absent or
        // `privat` ⇒ not projected at all, `M ∉ currentMembers` (20.2), `M ∈ hiddenMembers`
        // (17.3), then renderability — where a Geteilt entry whose `pub.text` has not arrived is
        // INVISIBLE rather than being mistaken for Belegt (ADR 001 §5 step 3).
        if (cand && projectable(truthKind, cand, filterCtx)) {
          (truthKind === 'note' ? notes : bars).push(finish(cand));
        }
        break;
      }

      case 'cat': {
        const cells = cellsOf(regs, key);
        if (cells.size === 0) break;
        const { fields, used } = projectCells(cells, 'cat', (f) => (f === '_alive' ? 'alive' : f), parsed.id);
        if (fields.alive === false) break;             // a deleted category is gone from the legend
        categories.push(finish(Object.assign(fields, {
          id: parsed.id,
          entityKey: key,
          ...derivedTimes(used),
        })));
        break;
      }

      case 'pad': {
        const cells = cellsOf(regs, key);
        const aliveReg = cells.get('_alive');
        if (carries(aliveReg) && aliveReg.value === false) break;
        const textReg = cells.get('text');
        // v1 DELETES the key when the pad empties (`interact.js:619-620, 633-634`), so an absent
        // or cleared `text` register means an absent key here — not `''`.
        if (!carries(textReg)) break;
        scratchpads[parsed.id] = textReg.value;
        break;
      }

      // `pref:app` is read by buildSettings; `member:` and `space:` are governance registers that
      // reach the UI through `ctx`, not through the v1 state shape.
      default:
        break;
    }
  }

  // Step 5 — the deterministic sorts. See the header: these are user-visible, not cosmetic.
  const sortedCategories = sortCategories(categories);

  // Step 7 — reference repair as a PROJECTION INVARIANT, not a mutation (ADR 001 §5 step 7).
  // v1 does this once, at load (`store.js:82-88`); v2 does it on every projection, so it is
  // idempotent and never rewrites the log. That matters because "create note in category X"
  // concurrent with "delete category X" is a real race at family scale, and the loser must not be
  // an orphaned entry. Foreign entries are skipped: they have no `categoryId` at all (A3), and
  // inventing one for them would put another member's entry in one of MY categories.
  if (sortedCategories.length) {
    const ids = new Set(sortedCategories.map((c) => c.id));
    const fallback = sortedCategories[0].id;
    for (const e of notes) if (!e.isForeign && !ids.has(e.categoryId)) e.categoryId = fallback;
    for (const e of bars) if (!e.isForeign && !ids.has(e.categoryId)) e.categoryId = fallback;
  }

  return {
    schemaVersion: SCHEMA_VERSION_V2,
    notes: sortNotes(notes),
    bars: sortBars(bars),
    categories: sortedCategories,
    scratchpads: sortScratchpads(scratchpads),
    settings: buildSettings(regs, ctx, sortedCategories),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. The v1 shape — the export / persist / snapshot seam (ADR 001 §8.3, §8.4)
//
// ATT-80 / ATT-81. v1's `exportJSON()` is `JSON.stringify(this.state, null, 2)` — the state
// VERBATIM — and 11.2 mails that file to somebody. Over a MATERIALIZED state that file would
// carry `ownerId` (a MemberId), `_born` (whose last 16 characters are this device's `deviceShort`
// fingerprint), `entityKey`, `updatedBy`, and `schemaVersion: 2` — which `migrateV1` then refuses
// on the way back in. Two bugs, one cause: nothing turned the v2 state back into a v1 board.
//
// `toV1Board` / `exportV1JSON` below are that seam. They are exported from THIS file because
// this file is what decides which fields are additive.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The v1 product fields, per v1 entity kind, `id` first — v1's own key order.
 *
 * THIS IS THE ONLY HAND-WRITTEN LIST IN THE STRIP, and it is a list of what v1 HAD: a closed,
 * finished set that cannot grow, because v1 is not being developed. Everything else is DERIVED.
 * The list that must never be hand-written is the complementary one — "the v2 fields" — because
 * that one grows every time somebody adds a row to `FIELDS`, and a privacy strip that forgets a
 * field leaks it silently into a file the user mails to somebody.
 * @type {Readonly<Object<string, readonly string[]>>}
 */
export const V1_ENTRY_FIELDS = Object.freeze({
  note: Object.freeze(['id', 'date', 'text', 'categoryId', 'repeatsYearly']),
  bar: Object.freeze(['id', 'startDate', 'endDate', 'label', 'categoryId']),
  cat: Object.freeze(['id', 'name', 'nameEn', 'paletteRef', 'visible']),
});

/** Everything `materialize` decorates an entry with in step 4 (ADR 001 §5 step 4). */
const DECORATIONS = Object.freeze([
  'uuid', 'entityKey', 'ownerId', 'isForeign', 'level', 'redacted',
  'memberColorRef', 'initial', 'exposure', 'isNew',
  'createdAt', 'updatedAt', 'updatedBy',
]);

/**
 * Every key a materialized entry can carry that a v1 entry cannot — DERIVED, not listed.
 *
 * The three sources are exhaustive by construction:
 *   1. `FIELDS[note|bar|cat]`      — every truth register that can be projected (step 1),
 *   2. `FIELDS[fnote|fbar]` renamed — every `pub.*` register a foreign entry projects (step 2),
 *   3. `DECORATIONS`               — step 4, which is this file's own doing,
 * minus `V1_ENTRY_FIELDS`, plus `alive` and `_alive` (the tombstone marker `finish()` strips,
 * belt and braces). A field added to `FIELDS` next year is therefore in this set the day it is
 * added, and `toV1Board` drops it without anyone remembering to update a list.
 * @type {readonly string[]}
 */
export const V2_ENTRY_FIELDS = Object.freeze((() => {
  // The union of the three v1 lists: a v1 field is a v1 field on every kind that declares it,
  // and `pub.date` → `date` must not be mistaken for a v2 addition just because it arrived
  // through the family space.
  const v1 = new Set(Object.values(V1_ENTRY_FIELDS).flat());
  const all = new Set([
    ...['note', 'bar', 'cat'].flatMap((k) => Object.keys(FIELDS[k])),
    ...['fnote', 'fbar'].flatMap((k) => Object.keys(FIELDS[k]).map(displayName)),
    ...DECORATIONS,
    'alive', '_alive',
  ]);
  return [...all].filter((f) => !v1.has(f)).sort();
})());

/**
 * Drop every v2-additive field from a materialized board, leaving the v1 shape at
 * `schemaVersion: 1`. Foreign entries are dropped entirely — v1 has no representation for one.
 *
 * The filter is a WHITELIST (`V1_ENTRY_FIELDS`), not a blacklist. A blacklist that misses a key
 * leaks it; a whitelist that misses a key loses it, and the §8.3 round-trip test goes red the
 * same day. Both failure modes are caught by a test, but only one of them is a privacy incident,
 * so the strip is built to fail in the other direction. `V2_ENTRY_FIELDS` remains exported (it is
 * what `undo.js:shadowContent` subtracts) and is asserted to be the exact complement.
 *
 * @param {Object} state @returns {Object} a new object; `state` is not touched
 */
export function stripV2Fields(state) {
  const keepOnly = (kind) => {
    const allow = new Set(V1_ENTRY_FIELDS[kind]);
    return (e) => {
      const o = {};
      for (const k of Object.keys(e)) if (allow.has(k)) o[k] = e[k];
      return o;
    };
  };
  return {
    schemaVersion: 1,
    notes: state.notes.filter((n) => !n.isForeign).map(keepOnly('note')),
    bars: state.bars.filter((b) => !b.isForeign).map(keepOnly('bar')),
    categories: state.categories.map(keepOnly('cat')),
    scratchpads: { ...state.scratchpads },
    settings: { ...state.settings, layers: { ...state.settings.layers } },
  };
}

/**
 * THE SEAM WP-3 CALLS. `store.exportJSON()` (11.2), `store.persist()`'s `board.json` (§8.4) and
 * `store._rollSnapshot()`'s `snapshots.json` (11.5) all need the SAME thing: the v1 board, at
 * `schemaVersion: 1`, with nothing device-identifying in it. Alias, not a copy.
 * @param {Object} state a materialized state @returns {Object} the v1 board shape
 */
export const toV1Board = stripV2Fields;

/**
 * `store.exportJSON()`, v2 edition — byte-for-byte v1's `JSON.stringify(state, null, 2)`, over
 * the STRIPPED board. The result re-imports through `migrateV1` (it says `schemaVersion: 1`) and
 * carries no MemberId, no entity key, no stamp and no device fingerprint.
 * @param {Object} state @param {number} [indent] @returns {string}
 */
export const exportV1JSON = (state, indent = 2) => JSON.stringify(toV1Board(state), null, indent);
