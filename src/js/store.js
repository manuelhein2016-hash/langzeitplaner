// The whole board lives here: state, undo, autosave, snapshots.
// "Nothing is ever lost" (principle 6) is enforced at this layer, not by
// discipline further up — every content change goes through mutate()/txn().
//
// ─────────────────────────────────────────────────────────────────────────────
// LZP-402 / LZP-403 / LZP-405 — THE RETROFIT.
//
// The v1 public surface is unchanged (ADR 005 §2.2). What changed is underneath it: `state` is
// no longer the truth, it is a PROJECTION. The truth is an append-only op log
// (`core/oplog.js`), folded per field by last-writer-wins (`core/registers.js`) and rendered
// back into the exact v1 shape by `core/materialize.js`. Undo emits inverse ops through
// `core/undo.js` rather than restoring a snapshot, so a peer that already merged the op being
// undone converges (ADR 001 §7.1, rules U1–U10).
//
//   board.json ──migrate()──▶ v1 board ──migrateV1()──▶ ops ──▶ log ──▶ registers
//                                                                          │
//                              store.state ◀── stripV2Fields ◀── materialize
//
// FIVE THINGS TO KNOW BEFORE CHANGING ANYTHING HERE
//
// 1. `mutate(label, fn)` SURVIVES, and it is not a wrapper that lies. ADR 005 §2.2 says it is
//    "removed and replaced by txn()", and that is the right call for the 22 UI sites — but
//    WP-2's characterization suite, which rule 2 of this work package makes the oracle, calls
//    `store.mutate` 44 times in `tests/tier1/store-persistence.test.js` and 16 more in
//    `tests/tier2/`, always as `fn(state)` mutating the state in place. So `mutate` is kept as
//    a DIFF TRANSACTION: `fn` edits `state` exactly as it always did, and the store then diffs
//    the four content keys plus `settings` against a pre-image and emits the ops that describe
//    the change. Same declines, same return value, same "a declining callback's edits are not
//    rolled back" quirk (`store.js:150` in v1). It is also the safety net for the retrofit of
//    the 22 sites: a site converted to `txn()` and a site still on `mutate()` produce the same
//    ops and land in the same log, so the conversion can proceed one file at a time.
//
// 2. `txn → apply → project → emit` is STRICTLY SYNCHRONOUS (ADR 001 §12.1, contract §2.2
//    clause 3). `interact.js:317` asks the DOM for the freshly created bar's label element the
//    instant the call returns. An `await` anywhere above `emit()` silently breaks bar-label
//    editing. Sealing, publication and the outbox belong in a `queueMicrotask` AFTER `emit()`.
//
// 3. `state` KEEPS ITS OBJECT IDENTITY, and so does every entry object in it. The projection is
//    reconciled INTO the existing arrays by id (see `reconcileList`) instead of replacing them.
//    v1 never replaced an entry object either, and callers rely on it: `tests/tier2/
//    dom-rendering.dom.js:816` holds a reference to `store.state.categories[1]` across an
//    unrelated mutation and then writes `cat.visible = false` through it. Only `replaceAll()`
//    installs a new state object, exactly as v1 did.
//
// 4. `settings` is store-owned, not projected on every write. `setSettings` / `setLayer` keep
//    v1's `Object.assign` semantics verbatim — including the quirk that `setSettings({layers})`
//    REPLACES the layer object wholesale — and emit `pref.set` ops beside it. A register map
//    cannot express "this object now has one key", so projecting settings after every write
//    would quietly repair that quirk into a merge. The registers ARE the authority on the load
//    and import paths, where v1 also re-normalises through `migrate()`.
//
// 5. A LOG MAY NOT OUTRANK `board.json` UNTIL IT IS SHOWN TO BE THAT BOARD'S LOG (A3-C1).
//    `shouldMigrate(board, {opsLogExists})` answers "has migration already run?" and nothing
//    else. `_useLog()` answers the two questions that actually license discarding the user's
//    file: can the log be READ, and does it BELONG to this board (`logBelongsToBoard`)? Either
//    answer being no is a QUARANTINE — the log is not applied, not deleted and not written to,
//    the board loads from `board.json` untouched, and `store.warnings` / `store.quarantine` say
//    so. Never add a branch here that prefers a log on the strength of its existence alone.
//
// SOLO MODE WRITES NO SECOND FILE (ADR 001 §9, §11). `ops.jsonl` and `checkpoint.json` are
// created when a space is created. Until then `board.json` IS the checkpoint: on every launch
// the persisted v1 board is re-migrated through `migrateV1`, whose GENESIS(i) stamps are a pure
// function of the file (ADR 001 §8.1), so two Macs opening the same board agree byte for byte
// and every future edit beats every migrated field on every device.

import { todayISO, monthKeyOf } from './dates.js';
import { nextFreeRef } from './palette.js';
import * as storage from './storage.js';

import {
  PERSONAL_PLACEHOLDER, FIELDS, flattenPref,
  noteSet, barSet, catSet, padSet, prefSet, buildMutation, mutation,
} from './core/ops.js';
import { isMonthKey } from './core/entities.js';
import { opId as newOpId, groupId as newGid, memberId as mintMemberId, deviceId as mintDeviceId } from './core/ids.js';
import { crock32 } from './core/b64.js';
import { createClock } from './core/stamp.js';
import { createOpLog } from './core/oplog.js';
import { materialize, stripV2Fields, exportV1JSON } from './core/materialize.js';
import { createUndoStacks, makeTx, captureImages, shadowContent } from './core/undo.js';
import { migrateV1, shouldMigrate, migrateSnapshots, toV1Snapshot } from './core/migrate1to2.js';
import { planReplaceAll } from './core/replace.js';
import { foldAuthorized } from './core/authz.js';

export const SCHEMA_VERSION = 1;
const UNDO_LIMIT = 50;
/** How many warnings the channel holds before it stops growing (F-8). */
const WARN_LIMIT = 1000;
const SNAPSHOT_LIMIT = 7;
const SAVE_DEBOUNCE = 700;

export const uid = () =>
  (crypto.randomUUID?.() ??
    `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

export function defaultState() {
  const cats = [
    { id: uid(), name: 'Arbeit', nameEn: 'Work', paletteRef: 'blau', visible: true },
    { id: uid(), name: 'Familie', nameEn: 'Family', paletteRef: 'gruen', visible: true },
    { id: uid(), name: 'Reisen', nameEn: 'Travel', paletteRef: 'orange', visible: true },
    { id: uid(), name: 'Deadlines', nameEn: 'Deadlines', paletteRef: 'magenta', visible: true },
  ];
  const t = todayISO();
  return {
    schemaVersion: SCHEMA_VERSION,
    notes: [],
    bars: [],
    categories: cats,
    scratchpads: {},
    settings: {
      bundesland: '',
      layers: {
        feiertage: true,
        // 7.5 — off until a Bundesland exists; flipped on automatically when
        // one is first chosen (settings.js). Shipping it "on" with no state
        // showed a pressed toggle that shaded nothing.
        schulferien: false,
        otherStates: false,
        ferienPattern: false,
      },
      mode: 'rolling',
      startMonth: monthKeyOf(t),
      pageYears: 0,
      language: 'de',
      launchAtLogin: false,
      menuBarIcon: true,
      rowHeight: 22,
      colWidth: 118,
      paper: 'a4',
      lastCategoryId: cats[0].id,
      seenFirstRun: false,
    },
  };
}

// ── migration ────────────────────────────────────────────────────────────────
// 11.6: the file carries a schema version and newer app versions migrate it.
//
// UNCHANGED FROM v1, DELIBERATELY. Every quirk in here is characterized (`nextFreeRef([])`
// giving three palette-less categories the same tone, unknown top-level keys dropped, unknown
// settings keys kept), and it is what makes the v2 doors safe: `migrate()` runs FIRST on every
// board that enters the store, so `migrateV1()` and `planReplaceAll()` always receive a
// well-formed v1 board and never have to re-derive v1's repairs. ADR 001 §8's "the v1→v2 branch
// lives inside migrate() at :67" is honoured by the CALLERS of this function (`init` and
// `replaceAll`) rather than by a second branch inside it, because both of them need the ops, not
// a state object — and because a pure v1 `migrate()` is what keeps 30 characterization tests
// measuring v1 instead of measuring the retrofit.
//
// EXPORTED BY WP-3, additively. In v1 this was reachable only through `replaceAll()`, and
// `tests/tier1/core-migrate.test.js:172` used that door to get at it ("v1's OWN migrate(), reached
// through the only exported door"). After LZP-402 `replaceAll()` is a diff transaction over the op
// log, so that door no longer leads here — but the function it was after is still exactly v1's
// (byte-for-byte the baseline commit's), so the honest repair is to open a door onto it rather
// than let a test vendor a copy that can rot. The v1 surface in `store.contract.js` §2.2 is
// unchanged; this only adds to it.
export function migrate(raw) {
  if (!raw || typeof raw !== 'object') return defaultState();
  let s = raw;
  const v = s.schemaVersion ?? 0;
  if (v > SCHEMA_VERSION) {
    console.warn('[store] file is newer than this app; loading defensively');
  }
  // v0 → v1: earliest internal builds had no scratchpads map / layer object.
  const d = defaultState();
  s = {
    schemaVersion: SCHEMA_VERSION,
    notes: Array.isArray(s.notes) ? s.notes : [],
    bars: Array.isArray(s.bars) ? s.bars : [],
    categories:
      Array.isArray(s.categories) && s.categories.length ? s.categories : d.categories,
    scratchpads: s.scratchpads && typeof s.scratchpads === 'object' ? s.scratchpads : {},
    settings: {
      ...d.settings,
      ...(s.settings || {}),
      layers: { ...d.settings.layers, ...((s.settings || {}).layers || {}) },
    },
  };
  // Repair references so a hand-edited file can never orphan an entry.
  const ids = new Set(s.categories.map((c) => c.id));
  const fallback = s.categories[0].id;
  for (const n of s.notes) if (!ids.has(n.categoryId)) n.categoryId = fallback;
  for (const b of s.bars) if (!ids.has(b.categoryId)) b.categoryId = fallback;
  if (!ids.has(s.settings.lastCategoryId)) s.settings.lastCategoryId = fallback;
  for (const c of s.categories) if (!c.paletteRef) c.paletteRef = nextFreeRef([]);
  // 7.5 — a Ferien layer without a Bundesland cannot mean anything; normalise
  // boards written before the default changed.
  if (!s.settings.bundesland) s.settings.layers.schulferien = false;
  return s;
}

// ── the v1 → op diff (what `mutate()` is made of) ────────────────────────────
//
// `fn` mutated `state` in place; these functions read what it did and say it in ops. The field
// lists are v1's product fields, one for one — the v2 additions are written by the constructors
// (`_alive`, `_born`) or defaulted at create (`visibility`, `coEdit`, `defaultVisibility`), and
// never inferred from a v1 entry object, which cannot carry them.

const CONTENT_KEYS = ['notes', 'bars', 'categories', 'scratchpads'];
const SETTER = { note: noteSet, bar: barSet, cat: catSet };
const COLLECTION = [
  { kind: 'note', key: 'notes', fields: ['date', 'text', 'categoryId', 'repeatsYearly'],
    born: { visibility: 'privat', coEdit: false } },
  { kind: 'bar', key: 'bars', fields: ['startDate', 'endDate', 'label', 'categoryId'],
    born: { visibility: 'privat', coEdit: false } },
  { kind: 'cat', key: 'categories', fields: ['name', 'nameEn', 'paletteRef', 'visible'],
    born: { defaultVisibility: 'privat' } },
];

/**
 * Coerce one v1 value into something its register will accept, or return `undefined` to drop it.
 * The only coercion is truncation of the two length-capped strings, which is the same decision
 * `v1import.truncateToFit` takes at the import door — v1's 80/40-character limits are DOM
 * `maxLength` attributes (`interact.js:466`, `popover.js:146`) and do not apply to a value that
 * arrived from a file or from a caller that did not go through an input.
 */
function fitValue(kind, name, value, warn) {
  if (value === undefined || value === null) return null;
  const spec = FIELDS[kind][name];
  if (!spec) return undefined;
  if (spec.t === 'str80' || spec.t === 'str40') {
    if (typeof value !== 'string') { warn(`${kind}.${name} is not a string; dropped`); return undefined; }
    const max = spec.t === 'str80' ? 80 : 40;
    if (value.length > max) { warn(`${kind}.${name} truncated to ${max} characters`); return value.slice(0, max); }
    return value;
  }
  if (spec.t === 'bool' && typeof value !== 'boolean') { warn(`${kind}.${name} is not a boolean; dropped`); return undefined; }
  if (spec.t === 'date' && typeof value !== 'string') { warn(`${kind}.${name} is not a date; dropped`); return undefined; }
  if (spec.t === 'id' && (typeof value !== 'string' || value === '')) { warn(`${kind}.${name} is not an id; dropped`); return undefined; }
  if (spec.t === 'str' && typeof value !== 'string') { warn(`${kind}.${name} is not a string; dropped`); return undefined; }
  return value;
}

/** One collection, before vs after, into `ops`. Entries are matched by `id`, never by index. */
function diffCollection(spec, before, after, ctx, ops, warn) {
  const prev = new Map();
  for (const e of Array.isArray(before) ? before : []) {
    if (e && e.id !== undefined && e.id !== null) prev.set(String(e.id), e);
  }
  const seen = new Set();
  for (const e of Array.isArray(after) ? after : []) {
    if (!e || e.id === undefined || e.id === null) continue;
    const id = String(e.id);
    if (seen.has(id)) continue;                 // a duplicate id in the array: the first one wins
    seen.add(id);
    const old = prev.get(id);
    const f = {};
    for (const name of spec.fields) {
      const b = e[name];
      if (old && Object.is(old[name], b)) continue;
      if (!old && b === undefined) continue;
      const v = fitValue(spec.kind, name, b, warn);
      if (v !== undefined) f[name] = v;
    }
    if (!old) {
      Object.assign(f, spec.born, { _alive: true });
      ops.push(SETTER[spec.kind](ctx, id, f, { born: true }));
    } else if (Object.keys(f).length) {
      ops.push(SETTER[spec.kind](ctx, id, f));
    }
  }
  for (const id of prev.keys()) {
    if (!seen.has(id)) ops.push(SETTER[spec.kind](ctx, id, { _alive: false }));
  }
}

/** The scratchpads map, before vs after. `pad:<YYYY-MM>` is keyed by month (F10). */
function diffPads(before, after, ctx, ops, warn) {
  const a = before && typeof before === 'object' ? before : {};
  const b = after && typeof after === 'object' ? after : {};
  for (const month of Object.keys(b)) {
    if (!isMonthKey(month)) { warn(`scratchpad key ${JSON.stringify(month)} is not a YYYY-MM month; dropped`); continue; }
    const text = b[month];
    if (Object.is(a[month], text)) continue;
    if (typeof text !== 'string') { warn(`scratchpad ${month} is not a string; dropped`); continue; }
    ops.push(padSet(ctx, month, { text, _alive: true }, { born: a[month] === undefined }));
  }
  for (const month of Object.keys(a)) {
    if (isMonthKey(month) && !(month in b)) ops.push(padSet(ctx, month, { _alive: false }));
  }
}

/**
 * Settings, before vs after, as ONE dotted `pref.set` patch — or null when nothing moved.
 *
 * A key the caller REMOVED is written back at its v1 DEFAULT rather than cleared. That is
 * REG-8's rule and it is v1's own reload semantics: v1 persists the settings object as it
 * stands and `migrate()` spreads it over `defaultState().settings`, so a key that is gone comes
 * back as the default — which is the opposite board from `null` for every boolean whose default
 * is `true` (`layers.feiertage`).
 */
function diffSettings(before, after, defaults) {
  let a; let b;
  try { a = flattenPref(before || {}); b = flattenPref(after || {}); } catch { return null; }
  const patch = {};
  for (const k of Object.keys(b)) {
    const v = b[k];
    if (Object.is(a[k], v)) continue;
    patch[k] = v === undefined ? (defaults[k] ?? null) : v;
  }
  for (const k of Object.keys(a)) {
    if (!(k in b)) patch[k] = defaults[k] === undefined ? null : defaults[k];
  }
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v !== null && typeof v !== 'string' && typeof v !== 'boolean' && !Number.isFinite(v)) delete patch[k];
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * The exact inverse of `flattenPref`: write one committed `pref.set` patch back onto the live
 * `state.settings` object, in place.
 *
 * WHY THIS EXISTS. `_project()` deliberately does NOT re-derive `state.settings` on every write
 * (see `_project`'s note: a dotted register map cannot express `setSettings`' wholesale object
 * REPLACEMENT, which `store-persistence.test.js:757` pins as a v1 quirk, so re-projecting after
 * every action would silently repair that quirk into a merge). But seven of the 22 mutation rows
 * are marked `[L]` in ADR 001 §3.2 and carry `settings.lastCategoryId` along with them, and v1
 * wrote that value *inside* the mutation, where every subsequent reader saw it immediately.
 *
 * Without this, the op log and the live board disagree: the register moves, `state.settings` does
 * not, every reader of `lastCategoryId` keeps offering the previous category — and on the next
 * launch the register wins and the user's default changes with no gesture behind it. Story 4.2
 * broken in both directions, silently. All three call-site agents hit it independently
 * (interact.js F-INT-1, popover.js P1, legend.js F-L1) and each had to bridge it locally; this is
 * the one fix that retires all three bridges.
 *
 * It is scoped to the ops of ONE committed group, so it moves exactly the keys the transaction
 * actually wrote and touches nothing else. `setSettings`/`setLayer` do not route through
 * `_commit()`, so their wholesale-replace quirk is untouched by design.
 */
function applyPrefOps(settings, ops) {
  if (!settings) return false;
  let touched = false;
  for (const op of ops) {
    if (op.k !== 'pref.set' || !op.f) continue;
    for (const [dotted, value] of Object.entries(op.f)) {
      const path = dotted.split('.');
      // `__proto__` never reaches here — `ops.js` refuses it at construction — but the walk
      // creates objects, so refuse it again rather than rely on that at a distance.
      if (path.some((seg) => seg === '__proto__' || seg === 'constructor' || seg === 'prototype')) continue;
      let node = settings;
      for (let i = 0; i < path.length - 1; i++) {
        const seg = path[i];
        if (!node[seg] || typeof node[seg] !== 'object') node[seg] = {};
        node = node[seg];
      }
      node[path[path.length - 1]] = value;
      touched = true;
    }
  }
  return touched;
}

// ── projecting back into the v1 state object ─────────────────────────────────

/**
 * Copy `next` into `cur` IN PLACE, preserving the identity of every entry object that survives.
 * See note 3 in the header: a caller may be holding a reference to one of these across a
 * mutation, which v1 made safe by never replacing them.
 */
function reconcileList(cur, next) {
  const by = new Map();
  for (const e of cur) if (e && e.id !== undefined) by.set(String(e.id), e);
  const out = [];
  for (const n of next) {
    const o = by.get(String(n.id));
    if (!o) { out.push(n); continue; }
    for (const k of Object.keys(o)) if (!(k in n)) delete o[k];
    Object.assign(o, n);
    out.push(o);
  }
  cur.length = 0;
  for (const e of out) cur.push(e);
}

/**
 * The same, for the scratchpads map — and it REBUILDS the key order, exactly as `reconcileList`
 * rebuilds array order (F-1, closed 2026-08-27).
 *
 * `Object.assign` onto a live object appends new keys at the end and never moves an existing one,
 * so `core/entities.js:sortScratchpads`' key sort only bit on a map projected into a FRESH object
 * (init / replaceAll). The consequence was that `board.json` — which is `JSON.stringify(state)`
 * and therefore carries the live key order (11.4) — was written in creation order during a
 * session and in sorted order after the next launch: same content, different bytes, no user
 * action in between. ADR 001 §5 step 5 exists to make those comparisons byte-stable.
 *
 * The MAP object keeps its identity (a caller may hold `state.scratchpads`); only its keys are
 * re-laid-out. Deleting and re-inserting is the only way to reorder a JS object's own keys.
 */
function reconcileMap(cur, next) {
  for (const k of Object.keys(cur)) delete cur[k];
  for (const k of Object.keys(next)) cur[k] = next[k];
}

/**
 * The publication seam (ADR 004 §3, WP-8). In solo mode there is nothing to publish and nothing
 * to retract, but `replaceAll()` still hands its retraction list over: `planReplaceAll` is the
 * ONLY place that can compute which of my family-visible entries an import just tombstoned, and
 * nothing in `core/` runs after the transaction lands. Losing the list here means an imported or
 * restored board leaves entries live on the family's boards (story 16.5, RECHECK-40-4). The
 * no-op publisher therefore RECORDS rather than discards.
 */
function nullPublisher() {
  return {
    familySpaceId: null,
    pendingRetractions: [],
    pendingReshares: [],
    retract(keys) { if (keys && keys.length) this.pendingRetractions.push(...keys); },
    askToReshare(list) { if (list && list.length) this.pendingReshares.push(...list); },
    derivePublication() { return []; },
    enqueue() {},
  };
}

// ── is this log a log of THIS board? (A3-C1) ─────────────────────────────────
//
// ADR 001 §8.4's idempotence predicate asks one question about the log — `opsLogExists` — and it
// is the RIGHT question for the predicate it belongs to: "has migration already run?". It is not,
// on its own, a licence to throw `board.json` away, because it never asks whether the log it
// found has anything to do with the board sitting beside it. One stray line in `ops.jsonl` used
// to be enough to replace a full board with the empty fold of that line, write the empty board
// back over `board.json`, and roll it into `snapshots.json` — silently (A3-C1, CRITICAL).
//
// So the store adds a CONSISTENCY CHECK on top of the predicate. It is deliberately two layers,
// because the two files on disk carry different amounts of evidence:
//
//  1. PROVENANCE — `checkpoint.json` written by this store carries an `lzp` envelope naming the
//     board it was folded from (`boardFp`) and the horizon it was folded at. A checkpoint with no
//     envelope was not written by this app, and a checkpoint whose fingerprint does not match the
//     board on disk has, at best, drifted from it. `ops.jsonl` is a line format with no header,
//     so a tail-only log carries no provenance at all and only layer 2 applies to it.
//  2. CENSUS — every entity `board.json` asserts the existence of must be an entity the log has
//     heard of. Once a log exists it is authoritative and `board.json` is its projection, so a
//     log that knows NONE of the board's entities cannot be that board's log. (Knowing SOME but
//     not all is drift — a hand-edited file, a crash between the two writes — which is a warning,
//     not a quarantine: the log still wins, and it says so.)
//
// A log that fails either layer is QUARANTINED: not applied, not deleted, not overwritten, and
// reported on `store.warnings` + `store.quarantine`. `board.json` then loads untouched, exactly
// as it does on a machine with no log at all. Never silently prefer a log over a board it cannot
// be shown to belong to.

/** The envelope version. Bump only when the fields below change meaning. */
const LZP_CHECKPOINT_ENVELOPE = 1;

/** FNV-1a, 32 bit, hex. Not a hash for security — a cheap stable fingerprint of a key list. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Every entity key a v1 board asserts the existence of, in the register map's own key format. */
function boardCensus(board) {
  const keys = new Set();
  const add = (kind, list) => {
    for (const e of Array.isArray(list) ? list : []) {
      if (e && e.id !== undefined && e.id !== null) keys.add(`${kind}:${String(e.id)}`);
    }
  };
  add('note', board?.notes);
  add('bar', board?.bars);
  add('cat', board?.categories);
  const pads = board?.scratchpads;
  if (pads && typeof pads === 'object') for (const m of Object.keys(pads)) keys.add(`pad:${m}`);
  return keys;
}

/** Every entity key a loaded log has heard of — folded, tombstoned or merely parked. */
function logCensus(log) {
  const keys = new Set();
  for (const k of log.registers().keys()) if (typeof k === 'string' && !k.startsWith('pref:')) keys.add(k);
  for (const op of log.ops({ includeParked: true })) {
    if (op && typeof op.e === 'string' && !op.e.startsWith('pref:')) keys.add(op.e);
  }
  return keys;
}

/** `{fp, n}` — the fingerprint of a board's entity census, stable under key order. */
function censusFingerprint(board) {
  const keys = [...boardCensus(board)].sort();
  return { fp: fnv1a(keys.join('|')), n: keys.length };
}

/**
 * Does `log` belong to `board`? Never throws; returns a verdict the caller can act on.
 * @returns {{ok:boolean, reason:string, detail:string, warn?:string}}
 */
function logBelongsToBoard(board, checkpoint, log) {
  // 1. provenance — only a checkpoint can carry it
  if (checkpoint) {
    const env = checkpoint.lzp;
    if (!env || typeof env !== 'object' || env.v !== LZP_CHECKPOINT_ENVELOPE) {
      return {
        ok: false,
        reason: 'no-provenance',
        detail: 'checkpoint.json carries no `lzp` provenance envelope, so it was not written by this '
          + 'app over this board; a checkpoint may not outrank board.json on the strength of merely existing',
      };
    }
  }
  // 2. census — the log must have heard of what the board says exists
  const mine = boardCensus(board);
  if (mine.size === 0) {
    return { ok: true, reason: 'empty-board', detail: 'board.json asserts no entities; there is nothing for the log to contradict', warn: [] };
  }
  const known = logCensus(log);
  const unknown = [...mine].filter((k) => !known.has(k));
  if (unknown.length === mine.size) {
    return {
      ok: false,
      reason: 'unrelated-log',
      detail: `the log knows ${known.size} entit${known.size === 1 ? 'y' : 'ies'} and NONE of the `
        + `${mine.size} board.json asserts (${[...mine].slice(0, 3).join(', ')}${mine.size > 3 ? ', …' : ''})`,
    };
  }
  const drift = unknown.length
    ? `op log accepted, but board.json carries ${unknown.length} entr${unknown.length === 1 ? 'y' : 'ies'} `
      + `the log has never heard of (${unknown.slice(0, 3).join(', ')}${unknown.length > 3 ? ', …' : ''}); `
      + 'the log is authoritative once it exists, so those are not on the board'
    : undefined;
  const env = checkpoint?.lzp;
  const fp = censusFingerprint(board).fp;
  const stale = env && env.boardFp !== fp
    ? `checkpoint.json was folded from a different generation of board.json (${env.boardFp} vs ${fp}) — `
      + 'expected after a crash between the two writes, and the log wins'
    : undefined;
  return {
    ok: true,
    reason: 'related',
    detail: `${mine.size - unknown.length}/${mine.size} of the board's entities are in the log`,
    warn: [stale, drift].filter(Boolean),
  };
}

/**
 * `store.undoStack` / `store.redoStack` are v1 fields that outside code writes: the
 * characterization harnesses reset the world with `store.undoStack.length = 0`
 * (`store-persistence.test.js:67`, `tests/tier2/interaction.dom.js:49`,
 * `tests/attack/_regression-harness.js:41`) and read `store.undoStack.length` as the step count
 * (`interaction.dom.js:393`). The stacks themselves now live inside `core/undo.js`, which holds
 * op images rather than snapshots and cannot hand out its arrays, so these are live views:
 * `.length` reads the real depth and `.length = 0` really clears.
 */
function stackView(depth, clear) {
  return {
    get length() { return depth(); },
    set length(v) { if (Number(v) === 0) clear(); },
    push() { return depth(); },     // accepted and ignored — a v1 entry has no op-log meaning
    toJSON() { return depth(); },
  };
}

// ── store ────────────────────────────────────────────────────────────────────

class Store {
  constructor() {
    // Identity. In solo mode it is EPHEMERAL — minted per launch and deliberately not
    // persisted, because there is nowhere to persist it: `board.json` is asserted to be exactly
    // `store.state` (11.4) and a persist is asserted to touch exactly the two v1 storage slots.
    // Nothing observable depends on it: migrated stamps carry ZERO_DEVICE_SHORT by construction
    // (ADR 001 §8.1), and `ownerId` / `updatedBy` are stripped out of everything that leaves
    // this file. A durable identity arrives with the keystore when a space is created (ADR 002
    // §2.2) — that is also where `deviceShort` stops being random and becomes a function of the
    // signing key.
    this._me = mintMemberId();
    this._device = mintDeviceId();
    this._short = crock32(crypto.getRandomValues(new Uint8Array(10)));
    this._clock = createClock(this._short, () => Date.now());
    this._log = createOpLog({ now: () => Date.now() });
    this._stacks = createUndoStacks({
      act: this._me,
      dev: this._device,
      mint: () => this._clock.tick(),
      newOpId,
      newGid,
      space: PERSONAL_PLACEHOLDER,
      limitGroups: UNDO_LIMIT,
      // `shadow` is deliberately NOT passed: `createUndoStacks` defaults to `DEV`, which the
      // suites arm process-wide through `tests/helpers/dev-flag.mjs` (ATT-96). Pinning it here
      // would disarm risk R5's mechanical guard for the whole app.
    });
    this._personalSpaceId = null;
    this._familySpaceId = null;
    this._opsPersisted = false;
    this.publisher = nullPublisher();

    // ── the warnings channel (F-8) ──────────────────────────────────────────
    // Everything this layer knows it lost, refused or repaired ends up here. It is ONE array for
    // the life of the store — `_warn()` pushes, `clearWarnings()` empties in place — because a
    // consumer that holds the array (or subscribes) must not be detached by the next `init()` or
    // `replaceAll()`. Before this, `init()` and `replaceAll()` ASSIGNED a fresh array, so a
    // migration's report was discarded by the next import and a `plan.warnings` of `[]` erased
    // everything the session had accumulated.
    // STILL OWED: a consumer. `settings.js` belongs to the release pipeline this round; the seam
    // it must wire into is `subscribeWarnings()` / `diagnostics()`. See the WP-10 note in
    // docs/v2/FINDINGS.md F-8.
    this.warnings = [];
    this._warnListeners = new Set();
    /** Set by `init()` when an op log was refused. Inspectable, never written back to disk. */
    this.quarantine = null;

    this.state = defaultState();
    this.snapshots = [];
    this.listeners = new Set();
    this._saveTimer = null;
    this._lastSnapshotDay = null;
    this.ready = false;
    this.undoStack = stackView(() => this._stacks.size().undo, () => this._stacks.clear());
    this.redoStack = stackView(() => this._stacks.size().redo, () => this._stacks.clear());
  }

  async init() {
    const loaded = await storage.loadBoard();
    const board = migrate(loaded ?? defaultState());
    if (!loaded) board.settings.seenFirstRun = false;

    // ADR 001 §8.4's idempotence predicate, both halves. In solo mode there is no op log, so
    // the answer is "migrate" on every launch and `board.json` is the checkpoint (§9). Once a
    // space exists the log is authoritative and re-migrating would re-stamp every field at
    // GENESIS and discard every edit since — which is what `shouldMigrate` refuses.
    const checkpoint = await storage.loadCheckpoint();
    const tail = await storage.loadOps();
    const hasLog = !!checkpoint || tail.length > 0;
    this._log = createOpLog({ now: () => Date.now() });
    this.clearWarnings();
    this.quarantine = null;
    // A3-C1 / A3-H1: the predicate says whether migration has already run; `_useLog` says whether
    // the log it found is READABLE and BELONGS TO THIS BOARD. Only both together may discard
    // `board.json`. Either failure quarantines the log — reported, left on disk, not applied —
    // and the board loads exactly as it would on a machine with no log at all.
    const useLog = !shouldMigrate(board, { opsLogExists: hasLog }).migrate
      && hasLog
      && this._useLog(board, checkpoint, tail);
    if (useLog) {
      this._opsPersisted = true;
    } else {
      const r = migrateV1(board, { memberId: this._me, deviceId: this._device, acceptLossy: true });
      this._warnAll(r.warnings);
      for (const op of r.ops) this._log.append(op);
      this._opsPersisted = false;
    }
    // The registers were replaced wholesale under stacks that survive `init()` by design (v1
    // fact, pinned at store-persistence.test.js:271). Retire their DEV shadow expectations,
    // which describe a board that is no longer on screen; the stacks themselves are untouched.
    this._stacks.remoteApplied();

    this.state = this._blankState();
    this._project({ settings: true });

    const snaps = migrateSnapshots(await storage.loadSnapshots());
    this.snapshots = snaps.snapshots;
    this._warnAll(snaps.warnings);
    this._lastSnapshotDay = this.snapshots[0]?.day ?? null;
    // What was on disk when the app opened. This — not the edited state — is
    // what the day's snapshot has to preserve.
    this._persisted = structuredClone(this.state);
    this.ready = true;
    this.emit('init');
  }

  /**
   * Load the op log — but only if it can be read AND can be shown to belong to `board`.
   *
   * A3-H1: `storage.loadCheckpoint()` catches a JSON parse error and returns `null`, so an
   * UNPARSABLE checkpoint was always safe; one that PARSED and was wrong reached
   * `deserializeRegisters` and threw `RegisterError` out of `init()`, leaving `ready === false`
   * — a white screen with the user's intact `board.json` sitting right there. That asymmetry was
   * the bug. Anything the log throws on the way in is now a quarantine, not a dead app.
   *
   * A3-C1: and a log that loads cleanly still has to be THIS board's log — see
   * `logBelongsToBoard` above.
   *
   * @returns {boolean} true when the log is authoritative; false when the caller must migrate
   *          `board.json` instead.
   */
  _useLog(board, checkpoint, tail) {
    const fresh = () => { this._log = createOpLog({ now: () => Date.now() }); };
    try {
      this._log.load({ checkpoint, tail });
    } catch (e) {
      fresh();
      this._quarantineLog('unreadable-log', `${e.name}: ${e.message}`, checkpoint, tail);
      return false;
    }
    let verdict;
    try {
      verdict = logBelongsToBoard(board, checkpoint, this._log);
    } catch (e) {
      verdict = { ok: false, reason: 'unreadable-log', detail: `the consistency check itself failed: ${e.name}: ${e.message}` };
    }
    if (!verdict.ok) {
      fresh();
      this._quarantineLog(verdict.reason, verdict.detail, checkpoint, tail);
      return false;
    }
    for (const w of verdict.warn ?? []) this._warn(`op log: ${w}`);
    return true;
  }

  /**
   * Refuse an op log without destroying it (A3-C1).
   *
   * QUARANTINE IS THREE PROMISES: the log is not applied, the log is not deleted, and the log is
   * not overwritten. The third is the one that used to fail — `init()` emptied `state`,
   * `persistNow()` wrote the empty board over `board.json`, and `rollSnapshot()` rolled it into
   * `snapshots.json`. Leaving `_opsPersisted` false is what keeps `_persistOps()` away from
   * `checkpoint.json` and `ops.jsonl` for the rest of the session, so the refused bytes are still
   * there for a rescue pass to read.
   *
   * STILL OWED (needs `src/js/storage.js`, another agent's file this round): physically moving
   * the files aside — `ops.quarantined-<ts>.jsonl` / `checkpoint.quarantined-<ts>.json` — so the
   * check does not have to run again on every launch. Until that exists the refusal is re-derived
   * (and re-reported) at each launch, which is the safe direction: nothing is lost either way.
   */
  _quarantineLog(reason, detail, checkpoint, tail) {
    // Structural, not incidental: whatever the caller does next, this session may not write to
    // the two log slots. (WP-8 setting `_opsPersisted` when a space is created must consult
    // `store.quarantine` first — see the note in docs/v2/FINDINGS.md A3-C1.)
    this._opsPersisted = false;
    const lines = Array.isArray(tail) ? tail : [];
    this.quarantine = {
      at: new Date().toISOString(),
      reason,
      detail,
      checkpointHorizon: (checkpoint && typeof checkpoint === 'object' ? checkpoint.horizon : null) ?? null,
      tailLines: lines.length,
      // A sample, not the log: the files themselves are untouched on disk, so a rescue pass reads
      // them there rather than out of a field that would pin an arbitrarily large log in memory.
      checkpoint: checkpoint ?? null,
      tailSample: lines.slice(0, 50),
      tailSampled: Math.min(lines.length, 50),
    };
    this._warn(
      `op log QUARANTINED (${reason}): ${detail}. board.json was loaded unchanged; `
      + 'ops.jsonl and checkpoint.json are still on disk and will not be written to this session.',
    );
  }

  // ── the warnings channel (F-8) ─────────────────────────────────────────────

  /** Record one warning and tell anyone listening. Returns the message, for a caller that logs. */
  _warn(msg) {
    const s = String(msg);
    if (this.warnings.length >= WARN_LIMIT) {
      if (this.warnings.length === WARN_LIMIT) this.warnings.push(`… further warnings suppressed after ${WARN_LIMIT}`);
      return s;
    }
    this.warnings.push(s);
    for (const fn of this._warnListeners) {
      // A consumer that throws may not take the store down with it — this channel exists to
      // report a loss, and a reporter that can turn a loss into a crash is worse than silence.
      try { fn(s, this.warnings); } catch (e) { console.warn('[store] a warnings listener threw', e); }
    }
    return s;
  }
  _warnAll(list) { for (const m of list ?? []) this._warn(m); }

  /** Empty the channel IN PLACE — the array identity is part of the contract. */
  clearWarnings() { this.warnings.length = 0; }

  /**
   * The UI seam a settings pane wires into (story 11.6, principle 6). `fn(message, all)` fires
   * once per warning, synchronously, and the returned function unsubscribes.
   */
  subscribeWarnings(fn) {
    this._warnListeners.add(fn);
    return () => this._warnListeners.delete(fn);
  }

  /** Everything this layer knows about how the current board was loaded. Read-only. */
  diagnostics() {
    return {
      ready: this.ready,
      source: this._opsPersisted ? 'op-log' : 'board.json',
      warnings: [...this.warnings],
      quarantine: this.quarantine
        ? {
          at: this.quarantine.at,
          reason: this.quarantine.reason,
          detail: this.quarantine.detail,
          checkpointHorizon: this.quarantine.checkpointHorizon,
          tailLines: this.quarantine.tailLines,
        }
        : null,
    };
  }

  // ── subscription ───────────────────────────────────────────────────────────
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(reason) {
    for (const fn of this.listeners) fn(this.state, reason);
  }

  // ── the op-log plumbing ────────────────────────────────────────────────────

  _blankState() {
    return { schemaVersion: SCHEMA_VERSION, notes: [], bars: [], categories: [], scratchpads: {}, settings: null };
  }

  /** An OpCtx for one transaction. `regs` arms `ops.js`'s existence gate (ATT-88). */
  _ctx(gid) {
    return {
      act: this._me,
      dev: this._device,
      gid: gid ?? newGid(),
      mint: () => this._clock.tick(),
      newOpId,
      newGid,
      space: this._personalSpaceId ?? PERSONAL_PLACEHOLDER,
      familySpaceId: this._familySpaceId,
      regs: this._log.registers(),
    };
  }

  /** The RegisterMap — checkpoint ⊕ tail. Read-only; `core/` owns every write to it. */
  registers() { return this._log.registers(); }

  /**
   * Ops → the v1 state shape, reconciled into the live state object.
   *
   * `stripV2Fields` is applied while `familySpaceId === null`. It is not cosmetic: the v2
   * decorations `createdAt` / `updatedAt` / `updatedBy` are derived from register STAMPS, and
   * `board.json` is asserted to be byte-identical to `store.state` (11.4) while carrying no
   * stamps by design (ADR 001 §8.4). A decorated `state` would therefore fail to round-trip
   * through its own file and would make `replaceAll()` non-idempotent — both are characterized.
   * When a family space exists the decorations become load-bearing (ADR 004 §4.3) and the full
   * projection is used; §8.4's additive board file follows from that automatically.
   */
  _project({ settings = false } = {}) {
    const d = defaultState();
    const full = materialize(this._log.registers(), {
      me: this._me,
      familySpaceId: this._familySpaceId,
      members: new Map(),
      currentMembers: new Set([this._me]),
      hiddenMembers: new Set(),
      defaultSettings: d.settings,
    });
    const next = this._familySpaceId ? full : stripV2Fields(full);
    if (!Array.isArray(this.state.notes)) this.state.notes = [];
    if (!Array.isArray(this.state.bars)) this.state.bars = [];
    if (!Array.isArray(this.state.categories)) this.state.categories = [];
    if (!this.state.scratchpads || typeof this.state.scratchpads !== 'object') this.state.scratchpads = {};
    reconcileList(this.state.notes, next.notes);
    reconcileList(this.state.bars, next.bars);
    reconcileList(this.state.categories, next.categories);
    reconcileMap(this.state.scratchpads, next.scratchpads);
    if (settings || !this.state.settings) this.state.settings = next.settings;
    this.state.schemaVersion = next.schemaVersion;
    this._projected = this._contentClone();
    this._projected.settings = structuredClone(this.state.settings);
    return this.state;
  }

  /**
   * ADOPT AN EDIT MADE DIRECTLY TO `state`, OUTSIDE ANY TRANSACTION.
   *
   * This is the bridge that makes "state is a projection" safe while code that predates the
   * retrofit is still writing to it. v1's `state` WAS the truth, so a direct write was a
   * legitimate edit, and several live callers still do exactly that: `store.ensureVisible()`
   * called on its own (`store.js:276` in v1, and characterized as "a plain state edit"),
   * `tests/tier2/interaction.dom.js:45`'s `reset()` clearing `state.notes` between gestures,
   * `tests/tier2/dom-rendering.dom.js:76`'s `store.state.settings = before`. Without this, the
   * next projection would quietly resurrect what such a write deleted — the board would grow a
   * note the user had just seen disappear.
   *
   * It is deliberately NOT a transaction: no undo entry, no broadcast. An edit the store never
   * saw is not a user action it can offer to undo, and folding it into the NEXT action's group
   * would make one ⌘Z revert two unrelated things. It runs before every path that re-projects,
   * so the registers describe what is on screen before anything else reads them — which is also
   * what keeps the DEV shadow assertion comparing two states that are about the same board.
   */
  _adopt() {
    const p = this._projected;
    if (!p) return;
    const ops = this._diff(p, p.settings);
    if (!ops.length) return;
    for (const op of ops) this._log.append(op);
    this._projected = this._contentClone();
    this._projected.settings = structuredClone(this.state.settings);
  }

  /**
   * Apply one group of ops as a local user action: append, re-project, record one undo step,
   * broadcast. Synchronous from end to end (see note 2 in the header).
   * @param {string} label @param {Object[]} ops @param {Object} shadow the pre-txn v1 content
   * @returns {boolean} whether anything was applied
   */
  _commit(label, ops, shadow) {
    if (!ops.length) return false;
    // Captured against the PRE-transaction registers — `captureImages` is explicit that folding
    // first and capturing second records the post-state twice and produces an undo that does
    // nothing. It also refuses any op that is not mine, which IS story 18.4.
    const { pre, post } = captureImages(this._log.registers(), ops, { me: this._me });
    for (const op of ops) this._log.append(op);
    this._project();
    // A `[L]` row's `pref.set` has to reach `state.settings` BEFORE `emit()`, or every listener
    // that redraws on this action reads the stale value (4.2) — and in the two `delete-category`
    // rows it would read an id that this very group just tombstoned. Re-syncing `_projected`
    // afterwards is what stops the next `_adopt()` seeing a diff and emitting the pref twice.
    if (applyPrefOps(this.state.settings, ops)) {
      this._projected.settings = structuredClone(this.state.settings);
    }
    const gid = ops.find((o) => o.gid)?.gid ?? newGid();
    this._stacks.push(gid, label, pre, post, shadow);
    this.schedulePersist();
    this.emit(label);
    return true;
  }

  _shadow() { return this._stacks.shadowArmed ? shadowContent(this.state) : undefined; }

  // ── undo-aware mutation ────────────────────────────────────────────────────
  _contentClone() {
    const o = {};
    for (const k of CONTENT_KEYS) o[k] = structuredClone(this.state[k]);
    return o;
  }

  /**
   * Every content change goes through here or through `txn()`. `fn` mutates state in place, and
   * the store then says what it did in ops. The three v1 rules are kept verbatim:
   *   · `return false` declines — nothing is recorded, nothing is broadcast (`store.js:150`);
   *   · a declining callback's edits are NOT rolled back, they simply are not recorded;
   *   · settings written inside the callback are NOT undoable (rule U6 — v1's `CONTENT_KEYS`).
   * The one deliberate divergence is ATT-5, decided in `core/undo.js`: a callback that changes
   * nothing records no step, where v1 recorded an empty one.
   */
  mutate(label, fn) {
    this._adopt();
    const shadow = this._shadow();
    const before = this._contentClone();
    const beforeSettings = structuredClone(this.state.settings);
    const r = fn(this.state);
    if (r === false) return r;                  // fn declined — don't pollute the undo stack
    const ops = this._diff(before, beforeSettings);
    if (!ops.length) return r;
    this._commit(label, ops, shadow);
    return r;
  }

  /** The op-builder form (ADR 001 §7.1) — what the 22 v1 mutate sites are converted to. */
  txn(label, fn) {
    this._adopt();
    const shadow = this._shadow();
    const tx = makeTx({ state: this.state, regs: this._log.registers(), ...this._ctx() });
    const r = fn(tx);
    if (r === false || tx.ops.length === 0) return r;      // store.js:150, verbatim
    this._commit(label, tx.ops, shadow);
    return r;
  }

  /**
   * One of `core/ops.js`'s 22 named v1 mutations, by name. This is the shortest safe rewrite for
   * a call site: the op shapes, the declines and the labels are the ones the ADR §3.2 table and
   * the attack suite already agree on.
   * @param {string} name @param {Object} args @param {string} [label]
   */
  apply(name, args, label) {
    this._adopt();
    const shadow = this._shadow();
    const ctx = this._ctx();
    const ops = buildMutation(name, ctx, args);
    if (!ops.length) return false;                          // the constructor declined (ATT-88)
    this._commit(label ?? mutation(name).label, ops, shadow);
    return true;
  }

  /**
   * Ops from a peer (WP-8). Rule U2 / story 18.4: touches NEITHER stack and never clears redo.
   * Authorization is an ADMISSION gate here rather than a projection step — an op that fails
   * `foldAuthorized` never reaches the log, so `registers()` stays the authorized fold and the
   * checkpoint keeps its meaning. Local ops need no gate: they are authored by me, in my own
   * personal or local space, which is admissible by construction (ADR 001 §4.4).
   *
   * THIS DOOR NEVER THROWS (A3-H3, and the door policy: externally-sourced input is refused and
   * reported, never thrown on — a throw is reserved for programmer error at an internal call
   * site). Every entry in the batch is judged on its own: one malformed op costs that op and
   * nothing else. The refusal set used to be built defensively (`(o) => o && o.id`) and `op.id`
   * read UNGUARDED in the very next loop, so `applyRemote([null, goodOp])` threw a bare
   * `TypeError` and discarded the well-formed op with it. The three siblings found by auditing
   * the rest of the path are guarded here too:
   *   · a non-iterable argument (`applyRemote(42)`) used to throw out of the spread;
   *   · `_clock.observe(op.ts)` THROWS `TypeError` on anything that is not a 37-char stamp;
   *   · `_log.append(op)` throws `OpLogError` for an op below the checkpoint horizon or a body
   *     that splices an opId already seen.
   * @param {Object[]} ops
   */
  applyRemote(ops) {
    if (ops === null || ops === undefined) return;
    if (!Array.isArray(ops)) {
      this._warn(`remote batch refused: expected an array of ops, got ${typeof ops}`);
      return;
    }
    const list = [...ops];
    if (!list.length) return;
    this._adopt();

    // Shape first, so nothing downstream has to defend itself against `null`.
    const wellFormed = [];
    for (const op of list) {
      if (op && typeof op === 'object' && !Array.isArray(op) && typeof op.id === 'string' && op.id !== '') {
        wellFormed.push(op);
      } else {
        this._warn(`remote op refused: not a well-formed op (${op === null ? 'null' : typeof op})`);
      }
    }

    let verdict;
    try {
      verdict = foldAuthorized([...this._log.ops({ includeParked: true }), ...wellFormed], {
        me: this._me,
        nowMs: Date.now(),
      });
    } catch (e) {
      // The gate itself could not reach a verdict. Admitting the batch ungated would break the
      // promise on the line above (`registers()` stays the authorized fold), so the batch is
      // refused — loudly, and without touching the board.
      this._warn(`remote batch refused: the authorization fold failed (${e.name}: ${e.message})`);
      return;
    }
    const rejected = Array.isArray(verdict?.rejected) ? verdict.rejected : [];
    const refused = new Set(rejected.map((o) => o && o.id));
    const reasonOf = (id) => {
      if (typeof verdict.rejectionOf !== 'function') return 'inadmissible';
      try { return verdict.rejectionOf(id)?.reason ?? 'inadmissible'; } catch { return 'inadmissible'; }
    };
    for (const op of wellFormed) {
      if (refused.has(op.id)) { this._warn(`remote op ${op.id} refused: ${reasonOf(op.id)}`); continue; }
      // BELT AND BRACES, and labelled as such after mutation testing: `observe` throws
      // `TypeError` on any non-stamp, but nothing hostile reaches it. `ops.js:validateOp` refuses
      // an `op.ts` that is not a 37-character stamp, so `foldAuthorized` has already put every
      // one of them in `verdict.rejected` and the line above skipped it. Reverting this catch
      // kills no test BECAUSE THE PATH IS UNREACHABLE — the reachability claim is what is pinned,
      // by `round3-doors.test.js` R3-23b, which drives ten hostile stamps through this door and
      // asserts the GATE refuses each by name. If that ever stops being true this catch becomes
      // load-bearing, which is why it stays.
      if (op.dev !== this._device) {
        try { this._clock.observe(op.ts); }
        catch (e) { this._warn(`remote op ${op.id}: its stamp was not observable (${e.message}); the clock was left alone`); }
      }
      try { this._log.append(op); }
      catch (e) { this._warn(`remote op ${op.id} refused by the log: ${e.name}: ${e.message}`); }
    }
    this._stacks.remoteApplied();
    this._project();
    this.schedulePersist();
    this.emit('remote');
  }

  /** The op group describing what `fn` just did to `state`. */
  _diff(before, beforeSettings) {
    const ctx = this._ctx();
    const ops = [];
    const warn = (m) => this._warn(m);
    for (const spec of COLLECTION) diffCollection(spec, before[spec.key], this.state[spec.key], ctx, ops, warn);
    diffPads(before.scratchpads, this.state.scratchpads, ctx, ops, warn);
    const patch = diffSettings(beforeSettings, this.state.settings, this._defaultPrefs());
    if (patch) ops.push(prefSet(ctx, patch));
    return ops;
  }

  _defaultPrefs() { return flattenPref(defaultState().settings); }

  /** Settings are configuration, not board content — not undoable (spec 5.4), never synced (17.7). */
  setSettings(patch) {
    const before = structuredClone(this.state.settings);
    Object.assign(this.state.settings, patch);
    this._pref(diffSettings(before, this.state.settings, this._defaultPrefs()));
    this.schedulePersist();
    this.emit('settings');
  }
  setLayer(patch) {
    const before = structuredClone(this.state.settings);
    Object.assign(this.state.settings.layers, patch);
    this._pref(diffSettings(before, this.state.settings, this._defaultPrefs()));
    this.schedulePersist();
    this.emit('settings');
  }

  /** One `pref.set` in the LOCAL space: no gid, never undone, never on a wire (rule U6). */
  _pref(patch) {
    if (!patch) return;
    try { this._log.append(prefSet(this._ctx(), patch)); }
    catch (e) { this._warn(`settings: ${e.message}`); }
  }

  canUndo() { return this._stacks.canUndo(); }
  canRedo() { return this._stacks.canRedo(); }

  /**
   * ⌘Z emits NEW ops carrying the pre-values (rule U4). It never rewinds the log, because a peer
   * may already have merged the op being undone. With `DEV` on, `verify()` compares the result
   * against a v1-style whole-content snapshot and throws on any disagreement — risk R5's
   * mechanical guard (ADR 001 §7.1).
   */
  undo() {
    this._adopt();
    const ops = this._stacks.undo(this.state);
    if (!ops.length) return false;
    for (const op of ops) this._log.append(op);
    this._project();
    this._stacks.verify(this.state);
    this.schedulePersist();
    this.emit('undo');
    return true;
  }
  redo() {
    this._adopt();
    const ops = this._stacks.redo(this.state);
    if (!ops.length) return false;
    for (const op of ops) this._log.append(op);
    this._project();
    this._stacks.verify(this.state);
    this.schedulePersist();
    this.emit('redo');
    return true;
  }

  /**
   * Import (11.3) and snapshot restore (11.5) replace everything and clear history
   * (spec 5.4: excluded). ADR 001 §8.5: there is no `board.reset` op — a whole-board primitive
   * has no fold rule and no defined behaviour under reordering — so this is a DIFF TRANSACTION.
   *
   * It goes through `planReplaceAll` and NEVER through the short `replaceAllOps` entry point.
   * The short one returns ops alone, so `plan.retractions` — the family keys whose personal
   * truth this transaction just tombstoned — exists only on the plan, and nothing in `core/`
   * runs after the transaction lands. Dropping it leaves entries live on the family's boards
   * after an import or a restore (story 16.5, RECHECK-40-4).
   */
  replaceAll(next) {
    this._adopt();
    const board = migrate(next);                 // v1's own door first: every quirk preserved
    const plan = planReplaceAll(this._log.registers(), board, {
      mint: () => this._clock.tick(),
      me: this._me,
      deviceId: this._device,
      personalSpaceId: this._personalSpaceId,
      newOpId,
      newGid,
      defaultSettings: defaultState().settings,
    });
    // APPEND, never replace (F-8). `plan.warnings` of `[]` used to erase everything the session
    // had accumulated — including the migration report the user had not been shown yet.
    if (plan.lossy) this._warn('import: this file could not be represented in full — see the entries below');
    this._warnAll(plan.warnings);
    for (const op of plan.ops) this._log.append(op);
    this._stacks.clear();
    this.publisher.retract(plan.retractions);    // ← the WP-3 obligation, hand-off point
    this.publisher.askToReshare(plan.reshares);  // nothing is re-shared until the user confirms
    this.state = this._blankState();             // v1 installs a NEW state object here
    this._project({ settings: true });
    this.persistNow();
    this.emit('replace');
  }

  // ── persistence ────────────────────────────────────────────────────────────
  schedulePersist() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.persistNow(), SAVE_DEBOUNCE);
  }

  async persistNow() {
    clearTimeout(this._saveTimer);
    this._adopt();
    await this.rollSnapshot();
    await storage.saveBoard(this.state);
    this._persisted = structuredClone(this.state);
    // ADR 001 §9/§11: solo mode writes no second file. The log becomes durable when a space is
    // created — `board.json` is the checkpoint until then.
    if (this._opsPersisted) await this._persistOps();
  }

  /** WP-8's half: append the tail, then checkpoint. Never called while `_opsPersisted` is false. */
  async _persistOps() {
    await storage.saveCheckpoint(this._stampedCheckpoint());
    await storage.truncateOps(0);
  }

  /**
   * `oplog.checkpoint()` plus the provenance envelope `init()` checks on the way back in (A3-C1).
   *
   * `board.json` has just been written from the same `state` (see `persistNow`), so the
   * fingerprint names exactly the generation of the file this fold belongs to. `core/oplog.js`
   * neither writes nor reads `lzp` — the log has no business knowing what a v1 board file is —
   * and `load()` ignores keys it does not recognise, so the envelope costs the format nothing.
   */
  _stampedCheckpoint() {
    const cp = this._log.checkpoint();
    const { fp, n } = censusFingerprint(this.state);
    return { ...cp, lzp: { v: LZP_CHECKPOINT_ENVELOPE, boardFp: fp, boardN: n, horizon: cp.horizon, at: Date.now() } };
  }

  /** Synchronous last-chance write for pagehide/beforeunload. */
  flushSync() {
    if (!this.ready) return;
    clearTimeout(this._saveTimer);
    if (storage.isTauri()) { this.persistNow(); return; }
    storage.saveBoardSync(this.state);
  }

  /**
   * 11.5 — one snapshot per calendar day, last 7 kept. It stores the *last
   * persisted* board, i.e. the state before today's first write. Snapshotting
   * the edited state instead would make "restore yesterday" return the very
   * change you wanted to undo.
   *
   * `toV1Snapshot` is `stripV2Fields` under the name of the job it does. ADR 001 §8.4 requires
   * `snapshots.json` to stay byte-identical in the v1 shape so that 11.5's restore UI
   * (`settings.js:224-254`) is untouched — and a snapshot is the safety net for exactly the
   * situation where the rest of the system has already gone wrong, so it may not be the first
   * file to acquire a shape nothing else can read.
   */
  async rollSnapshot() {
    const day = todayISO();
    if (this._lastSnapshotDay === day) return;
    this._lastSnapshotDay = day;
    this.snapshots.unshift({
      day,
      at: new Date().toISOString(),
      state: toV1Snapshot(this._persisted || this.state),
    });
    this.snapshots = this.snapshots.slice(0, SNAPSHOT_LIMIT);
    await storage.saveSnapshots(this.snapshots);
  }

  listSnapshots() {
    return this.snapshots.map((s) => ({ day: s.day, at: s.at }));
  }
  restoreSnapshot(day) {
    const s = this.snapshots.find((x) => x.day === day);
    if (!s) return false;
    this.replaceAll(structuredClone(s.state));
    return true;
  }

  // ── export / import ────────────────────────────────────────────────────────
  /**
   * 11.2 — the file the user mails to herself. `exportV1JSON` is
   * `JSON.stringify(stripV2Fields(state), null, 2)`: byte-for-byte v1's format, over a board
   * carrying no MemberId, no entity key, no stamp and no device fingerprint. Exporting the
   * materialized state raw would put `ownerId` and `_born` — whose tail is this device's
   * fingerprint — into that file, and would stamp it `schemaVersion: 2`, which this build's own
   * import door then refuses (`migrateV1` rejects `sv >= 2`).
   */
  exportJSON() {
    return exportV1JSON(this.state);
  }
  exportFilename() {
    return `LangzeitPlaner-${todayISO()}.json`;
  }

  // ── derived helpers ────────────────────────────────────────────────────────
  category(id) {
    return this.state.categories.find((c) => c.id === id) || this.state.categories[0];
  }
  categoryVisible(id) {
    const c = this.state.categories.find((x) => x.id === id);
    return c ? c.visible !== false : true;
  }
  countEntriesIn(catId) {
    return (
      this.state.notes.filter((n) => n.categoryId === catId).length +
      this.state.bars.filter((b) => b.categoryId === catId).length
    );
  }

  /** 4.6 — a new entry can never vanish into a hidden category. v1 verbatim: a plain state edit
   *  that its callers wrap in a mutation, which is what makes the unhide part of the same ⌘Z.
   *  Inside `txn()` the builder's own `tx.ensureVisible()` does the same job on the same group. */
  ensureVisible(catId) {
    const c = this.state.categories.find((x) => x.id === catId);
    if (!c || c.visible !== false) return false;
    c.visible = true;
    return true;
  }
}

export const store = new Store();
