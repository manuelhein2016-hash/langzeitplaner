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
// 5. `board.json` IS THE TRUTH. THE OP LOG IS HISTORY. (ADR 006 — normative, read it.)
//
//    Every launch loads `board.json` and migrates it into an op set — the SPINE — with no
//    predicate and no branch. The log is then reconciled ONTO that spine; it may contribute
//    stamps, tombstones, parked ops, cursors and splice evidence, and it may never contribute,
//    remove or alter one entity or one field value `board.json` asserts.
//
//    Two attempts at a smarter rule were broken by adversaries (`shouldMigrate(board,
//    {opsLogExists})` → R3-31; a provenance envelope plus an entity census → R4-1a/R4-2a). ADR
//    006 §2 proves no third one can work: "the log is one persist behind" and "the log is a
//    stranger's" produce the SAME observation — the board has keys the log lacks — so no
//    function of set overlap can tell them apart. The missing information had to be put on disk
//    deliberately, BY BOTH FILES: `board.json._v2.lineageId` and `checkpoint.json.lzp.lineageId`.
//
//    The gate is therefore ONE equality (`adoptable`), and it is affordable precisely because
//    adoption cannot change content: adoption is load → project → DIFF against `board.json` →
//    mint the difference at fresh stamps above the log's horizon. A log adopted by mistake costs
//    the user nothing. Do not add a second condition to `adoptable()`; if one seems necessary,
//    the reconciler is wrong, not the gate (ADR 006 §12.4).
//
// SOLO MODE WRITES NO SECOND FILE AND NO SECOND KEY (ADR 001 §9/§11, ADR 006 §4.1). `_v2` is
// attached to `board.json` only once a lineage exists — i.e. once the log is durable — so in
// solo mode as it ships today `board.json` does not change at all, `ops.jsonl` and
// `checkpoint.json` do not exist, and the spine's GENESIS(i) stamps stay a pure function of the
// file (ADR 001 §8.1), so two Macs opening the same board agree byte for byte.
//
// 6. `init()` ALWAYS BOOTS TO SOMETHING, AND ALWAYS SAYS WHAT IT REFUSED (Finding 2 / I-2).
//    `_project()` can throw — `materialize` refuses a `settings` that would make `layout.js:25`
//    produce a NaN year and hang `holidays.js:51` — and a throw out of `init()` is a WHITE
//    SCREEN with the user's intact `board.json` sitting right there. Every projection at a boot
//    or replace boundary goes through `_projectSafe()` / a CANDIDATE, which repairs the settings
//    it can and, in the last resort, opens read-only rather than writing a board nobody made.

import { todayISO, monthKeyOf } from './dates.js';
import { nextFreeRef } from './palette.js';
import * as storage from './storage.js';

import {
  PERSONAL_PLACEHOLDER, FIELDS, flattenPref, spaceClassOf, PARK_REASONS, OP_KINDS, OpError,
  noteSet, barSet, catSet, padSet, prefSet, buildMutation, mutation,
} from './core/ops.js';
import { isMonthKey, noteKey, barKey, catKey, isMemberId, isDeviceId, isSpaceId } from './core/entities.js';
import {
  opId as newOpId, groupId as newGid, memberId as mintMemberId, deviceId as mintDeviceId,
  ZERO_DEVICE_SHORT, isDeviceShort,
} from './core/ids.js';
import { crock32 } from './core/b64.js';
import {
  createClock, isStamp, cmp, msOf, ctrOf, fmt as fmtStamp,
  MAX_FUTURE_DRIFT_MS, MAX_STAMP_CTR, MAX_STAMP_MS,
} from './core/stamp.js';
import { createOpLog, ZERO_STAMP } from './core/oplog.js';
import { materialize, stripV2Fields, exportV1JSON } from './core/materialize.js';
import { createUndoStacks, makeTx, captureImages, shadowContent } from './core/undo.js';
import { migrateV1, migrateSnapshots, toV1Snapshot } from './core/migrate1to2.js';
import { planReplaceAll } from './core/replace.js';
import { foldAuthorized, REJECT_REASONS } from './core/authz.js';
// THE join, and nothing but the join. `registers.js` owns `≺` and the LWW fold; the withdrawal
// repair in `registers()` re-folds the log's own lines minus the ops the fold withdrew, and it
// does that with the product's one `applyOp` rather than a second copy of the comparator.
import { applyOp, deserializeRegisters } from './core/registers.js';
// ADR 004 §2 — the ONE function permitted to turn a local entry into something that leaves the
// device, and `ops.contract.js` §6's derivation that calls it. The store owns §2.3's LOUD failure
// path; `PUBLISH_FAILURE_CONTRACT` in that module is the specification `_publishAndEnqueue` below
// satisfies, clause by clause.
import {
  derivePublication, PUBLISH_FAILURE_CONTRACT, adminUnshareFollowUp, coEditOp,
} from './core/project.js';

/**
 * THE TWO REFUSALS A LATER OP CAN CURE — finding F-6, and the reason `applyRemote` parks.
 *
 * `authz.js` stage 0b answers these two when it has never been shown an attestation for the
 * op's author. That is a statement about what THIS DEVICE KNOWS, not about the op, and an
 * attestation is itself an op — it can arrive in a later page or through pairing. Every other
 * rejection reason is a verdict about the op that no later op can change.
 *
 * Spelled from `REJECT_REASONS` rather than as literals so a renamed verdict is a build error
 * here rather than a filter that silently stops matching. `sync/personal.js` exports the same
 * pair as `CURABLE_REFUSALS` for its cursor hold; the two must agree and `sync-personal.test.js`
 * pins that they do — this file may not import `sync/`, because `main.js` imports this one and
 * ADR 003 §7 gate 2 requires `sync/` to be unreachable from the boot graph.
 */
const CURABLE_REFUSALS = new Set([REJECT_REASONS.NOT_MY_DEVICE, REJECT_REASONS.UNATTESTED_DEVICE]);

/**
 * THE REFUSALS A LATER OP CAN CREATE — the mirror of `CURABLE_REFUSALS`, and the whole input to
 * the retroactive-withdrawal pass. See `store.registers()` for the argument and for what is
 * deliberately absent (`notOwner`, `notCoEditable`, `notMember`, `lostAdminChain`).
 *
 * Spelled from `REJECT_REASONS` for the same reason the pair above is: a renamed verdict must be
 * a build error here, never a filter that quietly stops matching and takes a convergence
 * guarantee with it.
 */
const RETROACTIVE_REFUSALS = new Set([
  REJECT_REASONS.NOT_ALIVE,             // stage 3b — the owner deleted it (18.6)
  REJECT_REASONS.NO_COEDIT,             // stage 3b — the owner unticked the box (18.2)
  REJECT_REASONS.NOT_GETEILT,           // stage 3b — the owner downgraded the level
  REJECT_REASONS.CONTENT_ABOVE_LEVEL,   // stage 3c — redacted to nothing at the new level
]);

/**
 * THE PARK VERDICTS ONLY THE FOLD CAN REACH — E9-C §3b-b, finding 2.
 *
 * `applyRemote` read `verdict.rejected` and nothing else, so the tri-state's whole middle had no
 * reader at that seam. Every OTHER park reason survives that gap because it comes from
 * `classifyOp`, which `_log.append` runs itself: `future`, `epoch`, `version`, `unknownKind`,
 * `unknownField`, `unknownSpace` are all reached again one line later. `UNSHARE_SHAPE` is not —
 * it is produced INSIDE `foldAuthorized` stage 3a and nowhere else — so an admin patch the fold
 * decided to HOLD was appended as a live op and folded by the log's plain LWW, sentinel and all.
 *
 * Its first victim is not an attacker but an app update: the tri-state exists so that a v2.1
 * retraction this build cannot confirm is retained and re-judged after an update, and instead it
 * was applied wholesale by the build that could not read it.
 *
 * IT IS A SET, NOT A BRANCH, because the honest rule is "a park the classifier cannot reach must
 * be honoured here" and today exactly one reason satisfies that. A future fold-only verdict adds
 * a line; parking EVERY member of `verdict.parked` would double-park what `_log.append` already
 * parks and would move the `future` seam R6-4c pins.
 */
const FOLD_ONLY_PARKS = new Set([PARK_REASONS.UNSHARE_SHAPE]);

/**
 * Does this named mutation build ops that live in the FAMILY space? DERIVED from `OP_KINDS`, not
 * from a list here: the table already declares each row's `kinds` and `OP_KINDS` already declares
 * each kind's space, so a sixth family mutation is covered the moment it is added and a list
 * would be the thing that silently stopped matching.
 *
 * `every` and not `some`: a row that mixed a family op with a personal one would not be a family
 * mutation, it would be a bug in `core/ops.js` (the two spaces are sealed under different keys —
 * 21.2), and answering `true` for it here would hide that behind a friendly error message.
 * @param {string} name @returns {boolean}
 */
function isFamilyMutation(name) {
  let kinds;
  try { kinds = mutation(name).kinds; }
  catch { return false; }                   // unknown name — `buildMutation` owns that refusal
  return Array.isArray(kinds) && kinds.length > 0
    && kinds.every((k) => OP_KINDS[k] && OP_KINDS[k].space === 'family');
}

export const SCHEMA_VERSION = 1;
const UNDO_LIMIT = 50;
/** How many warnings the channel holds before it stops growing (F-8). */
const WARN_LIMIT = 1000;
/**
 * How many terminal refusals ride in `checkpoint.json` (L-1). The ledger is EVIDENCE, not a log:
 * one entry is enough to stop reporting `healthy`, and a device under a hostile relay must not be
 * able to grow this file without bound. Most recent kept — see `_syncRefusalsForDisk`.
 */
const REFUSAL_LEDGER_CAP = 200;
/**
 * How many chain findings ride in `checkpoint.json` (P-4, and S4c in the property suite).
 *
 * The same argument as `REFUSAL_LEDGER_CAP`, one field over: `syncChain` is a FLAG — one finding
 * is enough for `status.js` to stop reporting `healthy` — and a device being fed a broken stream
 * by a hostile relay must not be able to grow this file without bound. Ten is well past the point
 * where an eleventh detail string tells a reader anything the first did not, and the whole record
 * is thrown away by the first pull that verifies (`personal.js` sets `store.syncChain = null`).
 */
const CHAIN_FINDING_CAP = 10;
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
/**
 * The truth fields a MATERIALIZED entry may carry a newer value for than the raw registers do —
 * ADR 004 §4.1's promotion. `_publishAndEnqueue` overlays exactly these and nothing else, so a
 * field materialization derives (`redacted`, `isForeign`, `exposure`, `ownerId`) can never reach
 * a projection, and `categoryId` is absent on purpose (A3): it has no `pub.` counterpart at any
 * level and therefore nothing to overlay onto.
 */
const PROMOTED_TRUTH_FIELDS = [
  'date', 'text', 'repeatsYearly', 'startDate', 'endDate', 'label', 'coEdit', 'visibility',
];
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

const KEY_OF = { note: noteKey, bar: barKey, cat: catKey };

/**
 * THE `_born` A NEW ROW MUST CARRY — the whole of R6-7, and the reason it is a rule about the
 * INPUT and not about a branch.
 *
 * `diffCollection` used to ask one question — *is this id in `before`?* — and answer `born: true`.
 * `born: true` writes `_born = this op's own stamp` (`ops.js:makeOp`), which is FRESH, and
 * `_born` is what `entities.js:cmpNotes/cmpBars/cmpCategories` sorts on. So a row the diff mints
 * lands at the END of the array. When `after` is `board.json` and `board.json` is the truth, the
 * END is the wrong place unless that is where `board.json` has it — and ADR 006 §5.4 names two
 * ordinary events that put it somewhere else:
 *
 *   · a Time-Machine restore of a `board.json` from before a delete in the MIDDLE (R6-7a). The
 *     ADR blesses this by name. The log tombstoned the middle entry; the board still has it.
 *   · any loss of `ops.jsonl`'s head — the browser fallback's `slice(-LS_OPS_CAP)` drops the
 *     OLDEST lines, i.e. exactly the entries that are not last (R6-7d).
 *
 * Both quarantined the ENTIRE history — every stamp, tombstone, parked op and cursor — with
 * `reconcile-failed / DIFFERENT ORDER`, and the post-condition was right to refuse: the log on
 * screen really did disagree with the board about a user-visible order (ADR 001 §5 step 5).
 * D5's four cells name the trap exactly: relaxing the post-condition is cell (c) and is unsound.
 * The cell the build has to be in is (d) — the reconciler REPAIRS the order and the check still
 * guards the repair — and that means the diff has to be able to choose a `_born`.
 *
 * ─── THE INPUT DOMAIN, ENUMERATED, AND THE ANSWER PER INPUT ────────────────────────────────────
 * For one id, three facts decide everything. `L` is the log's register map (`ctx.regs`), which is
 * the *reconciled* log during `_reconcileOntoBoard` and the live one during `mutate`.
 *
 *   in `before` | `L` has a `_born` | where `after` puts it | what must be written
 *   ------------+-------------------+-----------------------+---------------------------------
 *      yes      |   (yes)           |      anywhere         | the field diff only; `_born` is
 *               |                   |                       | NOT touched — an entry alive in
 *               |                   |                       | both keeps the position the log
 *               |                   |                       | gave it, and a disagreement here
 *               |                   |                       | is R5-5a's sabotage, which MUST
 *               |                   |                       | still be refused
 *      no       |   YES             |      anywhere         | a RESTORE, not a birth. `_alive:
 *               |                   |                       | true` + the fields, and no `_born`
 *               |                   |                       | at all: the log still carries the
 *               |                   |                       | original (a tombstone clears
 *               |                   |                       | `_alive`, never `_born`), and that
 *               |                   |                       | original IS the position
 *               |                   |                       | `board.json` has it in
 *      no       |   no              |      LAST             | `born: true` — a fresh stamp sorts
 *               |                   |                       | above everything, which is where
 *               |                   |                       | `after` wants it. Unchanged; this
 *               |                   |                       | is `mutate()`'s ordinary path and
 *               |                   |                       | R4-4a's "board is ahead" note
 *      no       |   no              |    INTERIOR           | an explicit `_born` strictly
 *               |                   |                       | between its neighbours' — computed
 *               |                   |                       | by `bornBetween` below
 *     absent from `after`, present in `before`  ⇒ `{_alive:false}`; no `_born` either way
 *
 * ─── WHAT THIS IS NOT ──────────────────────────────────────────────────────────────────────────
 *   · It is not a licence to move an entry the log and the board BOTH have. Those are anchors and
 *     are never re-stamped, so R5-5a's swapped-`_born` attack still ends in `reconcile-failed`.
 *     D5's `see` probe is that control and it is in the property suite.
 *   · It is not a new stamp AUTHORITY. The op's own `ts` is still a fresh `ctx.mint()`, above the
 *     log's horizon, so LWW is unchanged and R4-4a still holds. Only the VALUE of the `_born`
 *     register is chosen, and `_born` is a POSITION, not a time — ADR 001 §8.1's `GENESIS(i)`
 *     already encodes a v1 array index into that field for exactly this reason.
 *   · It cannot fail unsafely. Every branch that cannot find a value falls back to `born: true`,
 *     which is today's behaviour, and the post-condition then refuses exactly as it does now.
 *
 * @param {Object} regs `ctx.regs` — a read-only RegisterMap view, or anything without `.get`
 * @param {string} kind @param {string} id
 * @returns {?string} the `_born` VALUE the log already holds for this entity, or null
 */
const NO_CELLS = { get: () => undefined };

function cellsInLog(regs, kind, id) {
  const key = KEY_OF[kind];
  if (!key || !regs || typeof regs.get !== 'function') return NO_CELLS;
  const cells = regs.get(key(id));
  return cells && typeof cells.get === 'function' ? cells : NO_CELLS;
}

/** @param {{get:Function}} cells @returns {?string} */
function bornOfCells(cells) {
  const cell = cells.get('_born');
  return cell && isStamp(cell.value) ? cell.value : null;
}

/**
 * `n` stamps strictly between `lo` and `hi`, ascending — or null when there is no room.
 *
 * The stamp is `pad13(ms).pad6(ctr).dev16` and is compared as a plain string, so `ctr` outranks
 * `dev` outright: `X.(c+1).<anything>` is greater than `X.c.<anything>`, whatever the two device
 * shorts are. That is why the device component here is `ZERO_DEVICE_SHORT` and not a fabricated
 * one — it is the same all-zeros marker `GENESIS(i)` uses to say *this position was derived, not
 * observed on a device*, and it never has to be compared to make the arithmetic work.
 *
 * `hi === null` never reaches this function: a run with no fixed successor takes `ctx.mint()`
 * instead, which is the ordinary append and must stay byte-identical to today.
 *
 * @param {?string} lo exclusive lower bound, or null for "no fixed predecessor"
 * @param {string} hi  exclusive upper bound @param {number} n
 * @returns {?string[]}
 */
function bornBetween(lo, hi, n) {
  const step = (s) => {
    const ms = msOf(s); const ctr = ctrOf(s);
    if (ctr < MAX_STAMP_CTR) return fmtStamp(ms, ctr + 1, ZERO_DEVICE_SHORT);
    return ms < MAX_STAMP_MS ? fmtStamp(ms + 1, 0, ZERO_DEVICE_SHORT) : null;
  };
  const back = (s) => {
    const ms = msOf(s); const ctr = ctrOf(s);
    if (ctr > 0) return fmtStamp(ms, ctr - 1, ZERO_DEVICE_SHORT);
    return ms > 0 ? fmtStamp(ms - 1, MAX_STAMP_CTR, ZERO_DEVICE_SHORT) : null;
  };
  const out = [];
  if (lo !== null) {
    let cur = lo;
    for (let i = 0; i < n; i += 1) {
      cur = step(cur);
      if (cur === null || cur >= hi) return null;
      out.push(cur);
    }
    return out;
  }
  // No fixed predecessor: build downwards from `hi` so the run still ends just below it.
  let cur = hi;
  for (let i = 0; i < n; i += 1) {
    cur = back(cur);
    if (cur === null) return null;
    out.unshift(cur);
  }
  return out;
}

/**
 * MY OWN ROWS. A FOREIGN ENTRY IS NOT BOARD CONTENT THIS DEVICE MAY DESCRIBE — and this was a
 * latent blocker rather than a tidiness filter.
 *
 * `_diff` is v1's "say what changed about my board in ops", and every op it can mint is a
 * `note.set` / `bar.set` / `cat.set` / `pad.set` in MY PERSONAL SPACE. A foreign entry has no
 * truth registers by construction (ADR 004 §4.2 — the viewer holds `pub.*` and nothing else) and
 * its `id` is the FAMILY ENTITY KEY (`fnote:<member>/<uuid>`), not a uuid. So handing one to
 * `diffCollection` does one of two things, both wrong:
 *
 *   · `cellsInLog` calls `noteKey('fnote:mem_…/e1')` and THROWS `EntityKeyError` out of whatever
 *     door ran the diff — `_adopt()`, which every local write calls first. That is the failure
 *     this filter was found by: one family entry on the board and the next `setSettings` threw;
 *   · and if it did not throw, it would MINT `note:<the family key>` — a private copy of Mama's
 *     entry in MY personal space, pushed to MY other Mac, for ever.
 *
 * It could not happen before a family space existed: `stripV2Fields` (`materialize.js:947`)
 * filters `!isForeign` while `familySpaceId === null`, so solo mode never had one of these in
 * `state.notes`. `store.useFamilySpace()` is what makes the branch reachable, so the filter lands
 * with it.
 *
 * The test is `isForeign`, which `materialize` writes on EVERY candidate (`false` on my own,
 * `true` on a viewer's), plus the key shape as a second lock — a row hand-written into `state` by
 * a caller that predates the retrofit carries no flag at all, and `id` containing `:` is the one
 * thing that cannot be true of a v1 uuid.
 * @param {any} rows @returns {any[]}
 */
function ownRows(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.filter((e) => !(e && (e.isForeign === true || (typeof e.id === 'string' && e.id.includes(':')))));
}

/** One collection, before vs after, into `ops`. Entries are matched by `id`, never by index. */
function diffCollection(spec, before, after, ctx, ops, warn) {
  const prev = new Map();
  for (const e of Array.isArray(before) ? before : []) {
    if (e && e.id !== undefined && e.id !== null) prev.set(String(e.id), e);
  }
  // PASS 1 — decide, per id, what has to be written. Nothing is minted yet, because the `_born`
  // a new row needs depends on the rows AROUND it in `after`, which is the whole of R6-7.
  const seen = new Set();
  const rows = [];
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
    const cells = cellsInLog(ctx?.regs, spec.kind, id);
    const held = bornOfCells(cells);
    // A RESTORE is an entity the log KNOWS (it has a `_born`) and does not currently hold as
    // alive. `_alive` is the discriminator and not `before`, because on the `mutate()` door
    // `before` is a clone taken at the top of a transaction and a NESTED `mutate()` can commit an
    // entity into the log inside it — R3-11's shape, where the outer diff re-describes an entity
    // that is very much alive. That is a different (open, latent, someone else's) defect, and it
    // keeps the behaviour it had. On the reconciler's door `before` IS the log's live projection,
    // so the two readings coincide and this is exactly "the log tombstoned it, the board did not".
    const restore = !old && held !== null && cells.get('_alive')?.value !== true;
    rows.push({ id, old, f, held, restore, needsBorn: !old && !restore, born: null });
  }
  // PASS 2 — a row whose position is already decided is an ANCHOR: an entry alive in both, or a
  // restore, sits at the `_born` the log holds and this diff must not move it. Runs of rows that
  // are NOT anchored get a `_born` between the anchors that bracket them; a run with no anchor
  // after it is an append and takes a fresh mint — `mutate()`'s ordinary path, unchanged.
  const anchorOf = (r) => (r.needsBorn ? r.born : r.held);
  for (let i = 0; i < rows.length; i += 1) {
    if (!rows[i].needsBorn) continue;
    let j = i;
    while (j < rows.length && rows[j].needsBorn) j += 1;
    const lo = i > 0 ? anchorOf(rows[i - 1]) : null;
    const hi = j < rows.length ? anchorOf(rows[j]) : null;
    // An anchor whose `_born` the log does not carry constrains nothing this code can compute
    // (`entities.js` sorts a missing `_born` LAST), so the run falls back to a fresh mint and the
    // post-condition judges the result — today's behaviour, reached deliberately.
    if (hi !== null && !(i > 0 && lo === null)) {
      const between = bornBetween(lo, hi, j - i);
      if (between) for (let k = i; k < j; k += 1) rows[k].born = between[k - i];
    }
    i = j - 1;
  }
  // PASS 3 — emit, in `after`'s order, so the fresh mints of an append are still ascending.
  for (const r of rows) {
    const { id, old, f } = r;
    if (r.restore) {
      // A RESTORE. The log kept this entity's `_born` through its tombstone (a delete writes
      // `_alive: false` and nothing else), so writing a fresh one would MOVE an entry that
      // `board.json` has exactly where the log had it. `spec.born`'s defaults are filled in only
      // where the log has no cell for them: re-asserting `visibility` at a fresh stamp would
      // clobber a value the log legitimately holds, and omitting it from an entity that somehow
      // never had one would leave a fragment `materialize` cannot render.
      const patch = { ...f, _alive: true };
      const cells = cellsInLog(ctx?.regs, spec.kind, id);
      for (const [name, value] of Object.entries(spec.born)) {
        if (cells.get(name) === undefined) patch[name] = value;
      }
      ops.push(SETTER[spec.kind](ctx, id, patch));
    } else if (!old && r.born !== null) {
      ops.push(SETTER[spec.kind](ctx, id, { ...f, ...spec.born, _alive: true, _born: r.born }));
    } else if (!old) {
      ops.push(SETTER[spec.kind](ctx, id, { ...f, ...spec.born, _alive: true }, { born: true }));
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

// ── who wins, `board.json` or the log? (ADR 006) ──────────────────────────────
//
// THE DECISION, IN ONE LINE: `board.json` is the truth; the op log is history; every launch
// loads `board.json` and the log is reconciled ONTO it, never the reverse.
//
// Two rules that looked reasonable are dead, and the corpses are kept here so a third is not
// written:
//
//  1. `shouldMigrate(board, {opsLogExists})` — "is there a log?" One well-formed line in
//     `ops.jsonl` replaced a whole board with the fold of that line (A3-C1 / R3-31).
//  2. A provenance envelope on `checkpoint.json` PLUS an entity census with a zero-overlap
//     threshold. `pad:<YYYY-MM>` is a MONTH, shared by every board that ever existed, so
//     recognising ONE key was enough to hand the board over (R4-1a), and two boards sharing one
//     month key swapped wholesale (R4-2a).
//
// ADR 006 §2 ends the tuning: "the log is this board's own log, one persist behind" (R4-4a) and
// "the log is a stranger's" (R4-2a) BOTH present as "the board has keys the log lacks". Set
// overlap is a function of the two key sets alone, so no threshold over it can separate them —
// raising 1-of-N to k-of-N moves the failure from one case to the other. The information is not
// in the key sets. It has to be put on disk deliberately, BY BOTH FILES, because the one file
// that knows the board moved is the board.
//
//   board.json     `_v2: { lineageId, gen }`     — additive, ADR 001 §8.4's sanctioned key
//   checkpoint.json`lzp: { v, lineageId, gen, boardHash, horizon, at }`
//
// THE VERDICT IS ONE EQUALITY: `cp.lzp.lineageId === board._v2.lineageId`. No census, no
// threshold, no counter, no version comparison. `lzp.v` is NEVER consulted — that is what kills
// R4-3a's false refusal of a log written by a newer build. `gen` and `boardHash` are diagnostics
// and a fast path; neither gates.
//
// A blunt equality is affordable ONLY because adoption cannot change content (`_adoptHistory` →
// `_reconcileOntoBoard`): the log is loaded, projected, DIFFED against the board's own spine, and
// the difference is minted at fresh stamps above the log's horizon. A log adopted by mistake — a
// forged lineage, a copied file — therefore costs the user nothing. Do not add a second condition
// here (ADR 006 §12.4); if one seems necessary, the reconciler is wrong, not the gate.

/** The envelope version. NOT consulted by the verdict (ADR 006 §4.2) — humans and migrations only. */
const LZP_CHECKPOINT_ENVELOPE = 2;

/**
 * Quarantine reasons that are expected to STOP BEING TRUE without anyone touching the files, and
 * whose log must therefore keep its own name so the next launch can reconsider it (R5-2e).
 * One member, and adding a second needs the same argument: what changes, and who changes it?
 */
const DEFERRED_QUARANTINE = new Set(['clock-skew']);

/**
 * Is this the stamp of a MIGRATION op — `GENESIS(i)`, whose device short is all zeros (ADR 001
 * §8.1)? A stamp, not an op: `_born` carries one too, and only `op.ts` decides sealability.
 * @param {unknown} ts @returns {boolean}
 */
function isGenesisStamp(ts) {
  return isStamp(ts) && ts.slice(-16) === ZERO_DEVICE_SHORT;
}

/** FNV-1a, 32 bit, hex. Not a hash for security — a cheap stable fingerprint of a byte string. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * `<fnv1a>:<length>` over the EXACT bytes of a `board.json`.
 *
 * ADR 006 §4.2: this is an optimisation and a diagnostic and NEVER a gate, which is exactly why
 * 32 bits plus a length is enough and why no async WebCrypto call may appear on the `flushSync`
 * path. Nothing branches on it.
 */
function boardHash(text) {
  const s = typeof text === 'string' ? text : '';
  return `${fnv1a(s)}:${s.length}`;
}

/**
 * How many lines `ops.jsonl` may hold before a persist compacts (ADR 001 §7.2 · R5-4).
 *
 * §7.2's policy is "compact when the tail exceeds 5 000 ops". `storage.appendOps`' browser
 * fallback has no append primitive and caps the file at `LS_OPS_CAP` lines by dropping the OLDEST
 * — which, for a line the checkpoint does not fold, is the one loss this whole file exists to
 * prevent. So the threshold is the smaller of the two, with headroom, and it is ONE number rather
 * than a per-backend branch: a branch only one backend ever exercises is a branch that is never
 * tested, and this one may not be wrong.
 *
 * ONE thing §7.2 asks for that this deliberately does not do, recorded so it is not mistaken for
 * done: the compaction is TOTAL rather than "keeping a 30-day tail for debuggability".
 * `truncateOps` can only drop a PREFIX of the file and the store does not track which line of the
 * file each op is on, so a partial compaction could not trim anything at all — and §7.2's own
 * losslessness proof (`fold(checkpoint ∪ tail) === fold(all ops)` for ANY partition) says the
 * retained tail buys debuggability and nothing else. ADR 001 §7.2 was amended on 2026-08-27 to
 * drop the clause rather than leave it owed; see the amendment note there.
 */
const TAIL_COMPACT_AT = Math.min(5000, Math.floor(storage.LS_OPS_CAP * 0.75));

/**
 * §7.2's OTHER trigger, which was owed and is now paid: "…or on launch when it exceeds 2 MB".
 *
 * `TAIL_COMPACT_AT` bounds the tail in LINES, and a line is not a fixed size. One `note.set`
 * carrying a pasted year of text is tens of kilobytes; 1 499 of them are under the line cap and
 * over any byte budget worth having, and on the browser path `ops.jsonl` shares localStorage's
 * whole-origin quota with `board.json`, `checkpoint.json` and `snapshots.json`. So the byte
 * bound is a SECOND, independent trigger and not a replacement: whichever is crossed first
 * compacts.
 *
 * WHY AT LAUNCH RATHER THAN ON EVERY SAVE. Measuring the tail's bytes means serializing it, which
 * is the one thing the debounced save path may not do on a keystroke. At launch it is free: the
 * bytes were just read off disk and parsed, so the measurement is the same order as the work that
 * has already happened, and it happens once.
 */
const TAIL_COMPACT_BYTES = 2 * 1024 * 1024;

/**
 * How many bytes the tail `init()` just read occupies as JSONL — the quantity §7.2's 2 MB is a
 * bound on. Measured from the PARSED lines rather than re-read from disk, because `loadOps()` is
 * the only reader and it does not hand back the raw text, and because the two backends store the
 * same lines under different bytes (a native file, a localStorage string) and the bound is about
 * the lines.
 *
 * `+ 1` per line is the newline `toJSONL` joins them with. A line that cannot be serialized at
 * all counts as zero rather than throwing: a compaction is an optimisation, and refusing to boot
 * over one is not a trade this function is allowed to make.
 */
function tailBytes(tail) {
  if (!Array.isArray(tail)) return 0;
  let n = 0;
  for (const line of tail) {
    try { n += JSON.stringify(line).length + 1; } catch { /* unserializable: it costs no bound */ }
  }
  return n;
}

/**
 * The identity of ONE LINE of `ops.jsonl`: its opId and its body. Used only to answer "have I
 * already written this line?" — see `_uncommittedTailLines`. The body is in the key because an
 * opId is not unique across bodies once envelope splicing is possible (ADR 002 §5.1), and a
 * 32-bit fingerprint is enough because the cost of a collision is one line that is not appended
 * twice, never a line that is not appended at all.
 */
function tailLineKey(op) {
  const s = canonJSON(op ?? null);
  return `${op && typeof op.id === 'string' ? op.id : '?'}:${fnv1a(s)}:${s.length}`;
}

const LINEAGE_PREFIX = 'lin_';

/** `lin_` + 128 random bits in Crockford base32. Minted once per lineage, opaque forever. */
function mintLineageId() {
  return LINEAGE_PREFIX + crock32(crypto.getRandomValues(new Uint8Array(16)));
}

/** Frozen FOREVER (ADR 006 §12.2): a future envelope version must still be legible for this. */
function isLineageId(v) {
  return typeof v === 'string' && v.startsWith(LINEAGE_PREFIX) && v.length > LINEAGE_PREFIX.length
    && v.length <= 64 && /^[0-9A-Za-z_-]+$/.test(v);
}

/**
 * Split `board.json`'s parsed bytes into the v1 board and the ADR 006 binding.
 *
 * `_v2` NEVER ENTERS `store.state` (ADR 006 §4.1). It is attached at serialization and removed
 * here, before `migrate()`, so `exportJSON`, `snapshots.json` and `replaceAll` never see it and
 * 11.4's "`board.json` IS `store.state`" stays true modulo one documented additive key.
 * @returns {{board0: Object|null, binding: {lineageId:string, gen:number}|null}}
 */
function splitBoardEnvelope(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { board0: null, binding: null };
  const v2 = raw._v2;
  const binding = v2 && typeof v2 === 'object' && !Array.isArray(v2) && isLineageId(v2.lineageId)
    ? { lineageId: v2.lineageId, gen: Number.isInteger(v2.gen) && v2.gen >= 0 ? v2.gen : 0 }
    : null;
  if (!('_v2' in raw)) return { board0: raw, binding: null };
  const board0 = { ...raw };
  delete board0._v2;
  return { board0, binding };
}

/**
 * `store.state` → the exact bytes of `board.json`, with `_v2` attached when a lineage exists.
 *
 * Serialized ONCE per persist so that the hash in the checkpoint names the bytes that were
 * actually written (ADR 006 §6). `_v2` holds `{lineageId, gen}` and nothing else, ever — it is
 * not a scratch area (§12.3).
 */
function serializeBoard(state, binding) {
  if (!binding) return JSON.stringify(state, null, 2);
  return JSON.stringify({ ...state, _v2: { lineageId: binding.lineageId, gen: binding.gen } }, null, 2);
}

/**
 * THE FIVE COLLECTIONS A BOARD IS MADE OF, AND THE TYPE EACH ONE HAS TO HAVE. (R6-5c/d)
 *
 * This is the whole of "is this object one of ours". It is deliberately NOT a validator: a board
 * that is merely damaged is still a board and `migrate()` repairs it (`bars: 'x'` becomes `[]`,
 * a dangling `categoryId` is re-pointed, a missing collection is defaulted). The question here is
 * the one ADR 006 §4.1 actually needs answered — *did this app write this file?* — and the
 * evidence for it is that at least one of these keys is present AND has the shape this app has
 * always written it in.
 *
 * `schemaVersion` is NOT in this list, and neither is `_v2`. Neither is content: a version number
 * is a claim any file can make, and `_v2` is an ADDITIVE key (§4.1) that says which log is bound
 * to a board — it is not itself a board. `{"_v2":{lineageId:…}}` is the sharpest input in the
 * whole domain (D1-b18) precisely because it is nothing but the envelope.
 */
const BOARD_SHAPE = Object.freeze([
  ['notes', Array.isArray],
  ['bars', Array.isArray],
  ['categories', Array.isArray],
  ['scratchpads', (v) => !!v && typeof v === 'object' && !Array.isArray(v)],
  ['settings', (v) => !!v && typeof v === 'object' && !Array.isArray(v)],
]);

/**
 * Which of a board's own collections does this object carry, in the shape a board carries them?
 * @returns {string[]} the key names, in `BOARD_SHAPE` order. EMPTY means "this is not a board".
 */
function boardKeysOf(board0) {
  const out = [];
  if (!board0 || typeof board0 !== 'object' || Array.isArray(board0)) return out;
  for (const [key, wellTyped] of BOARD_SHAPE) {
    if (Object.prototype.hasOwnProperty.call(board0, key) && wellTyped(board0[key])) out.push(key);
  }
  return out;
}

/** One human-readable phrase naming what a non-board actually is. */
function describeNonBoard(raw, board0) {
  if (Array.isArray(raw)) return 'an array';
  if (raw === null) return 'null';
  if (typeof raw !== 'object') return `a ${typeof raw}`;
  const keys = Object.keys(board0 && typeof board0 === 'object' ? board0 : raw);
  const present = keys.length
    ? `it carries ${keys.slice(0, 6).map((k) => `\`${k}\``).join(', ')}`
    : 'it is empty';
  return 'an object with none of a board\'s collections (notes, bars, categories, scratchpads, '
    + `settings) — ${present}`;
}

/**
 * WHICH OF THE FIVE THINGS IS `board.json`? (R5-3a/b/c, R6-5a/c/d — the precondition nothing
 * defended, and then the two inputs that fell off OPPOSITE sides of it.)
 *
 * ADR 006's rule has exactly one precondition: `board.json` must be READABLE. Before this
 * function the code asked one question — did `splitBoardEnvelope` hand back a board? — and five
 * different situations answered it identically:
 *
 *   'ok'           A BOARD was read: an object carrying at least one of a board's own
 *                  collections, in a board's shape. `boardKeysOf()` is the whole test.
 *   'absent'       there is no board file. A fresh install, or R7's recovery when a log is
 *                  beside it. The ONLY one of these that may ever adopt a log (ADR 006 §5.5).
 *   'unparseable'  the bytes are there and `JSON.parse` threw — INCLUDING ZERO BYTES, which are
 *                  bytes (R6-5a). §5.5's defence — "reaching it requires deleting board.json" —
 *                  is not this precondition. One truncated write reaches it, and the user's data
 *                  is still on disk.
 *   'not-a-board'  the bytes parsed to something that is not a board: `[]`, `"a string"`, `null`,
 *                  `7` — AND ALSO `{}`, `{"schemaVersion":1}`, `{"hello":"welt"}`,
 *                  `{"notes":"nicht ein array"}`, `{"_v2":{…}}` (R6-5c/d). Someone or something
 *                  wrote over the file with valid JSON that is not this app's board.
 *   'read-failed'  the read threw: a locked file, a dismissed permission prompt, an EIO.
 *                  NOTHING is known — least of all that the file is gone.
 *
 * The last three mean THE BOARD EXISTS AND THIS APP CANNOT SEE IT. They are not recoveries and
 * they are not fresh installs; they are the one situation in which the app has genuinely lost
 * the user's data and has to say so (`_bootUnreadableBoard`).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY `Array.isArray` WAS NOT ENOUGH, AND WHY `{}` IS THE WORST INPUT IN THE DOMAIN.
 *
 * Under ADR 006 `board.json` is the SOLE content authority, so classifying an unrecognised
 * object as `ok` is not a shrug — it is an AUTHORITATIVE ASSERTION THAT THE BOARD IS EMPTY. Three
 * things follow from that one word, measured (D1-b14/b18):
 *
 *   1. the user's calendar is empty on screen, and the session is WRITABLE;
 *   2. this board's own log is quarantined `board-carries-no-lineage` — because `{}` carries no
 *      `_v2` — and SEQUESTERED, renamed out of reach, on the strength of the empty object;
 *   3. worst: with the victim's own lineage in the envelope (`{"_v2":{lineageId:…}}`) the verdict
 *      is `same-lineage`, the log is ADOPTED, and `_reconcileOntoBoard` mints one
 *      `{_alive:false}` retraction PER ENTITY — because "the log has a live entry the board
 *      lacks" is an honoured deletion (§5.4) and this "board" lacks all of them. The empty board
 *      and the tombstones are both committed and the next launch agrees. At WP-8 what propagates
 *      to every paired device is not a corrupt file but well-formed deletes this app minted.
 *
 * Every other member of this domain costs HISTORY. That one costs the calendar. → D1-b14…b18,
 * `tests/attack/round6-recovery.test.js` R6-5c/R6-5d.
 *
 * @returns {{kind: 'ok'|'absent'|'unparseable'|'not-a-board'|'read-failed', detail: string}}
 */
function classifyBoardFile(file, board0) {
  const f = file && typeof file === 'object'
    ? file
    : { status: 'read-failed', error: 'storage returned nothing at all' };
  const bytes = typeof f.text === 'string' ? f.text.length : 0;
  const onDisk = `its ${bytes} byte${bytes === 1 ? '' : 's'} are still on disk, untouched`;
  switch (f.status) {
    case 'read-failed':
      return {
        kind: 'read-failed',
        detail: `${f.where ?? 'the board file'} could not be read (${f.error || 'no reason given'})`,
      };
    case 'unparseable':
      // ZERO BYTES ARE BYTES (R6-5a). The file exists; it just does not say what the board is.
      // Saying so plainly matters — "0 bytes are still on disk" reads like a bug report.
      return {
        kind: 'unparseable',
        detail: bytes === 0
          ? `${f.where ?? 'board.json'} is EMPTY — zero bytes, which is what an interrupted write `
            + 'leaves behind. The file is there and it does not say what the board is'
          : `${f.where ?? 'board.json'} is not valid JSON (${f.error || 'JSON.parse failed'}); ${onDisk}`,
      };
    case 'absent':
      return { kind: 'absent', detail: 'there is no board file' };
    default:
      if (boardKeysOf(board0).length > 0) return { kind: 'ok', detail: '' };
      return {
        kind: 'not-a-board',
        detail: `${f.where ?? 'board.json'} is valid JSON but not a board `
          + `(${describeNonBoard(f.raw, board0)}); ${onDisk}`,
      };
  }
}

/**
 * WHY IS THIS SESSION READ-ONLY? One sentence, keyed off `bootFailure.reason`.
 *
 * There are now THREE ways to reach a read-only session and they are not the same event:
 *   - `unprojectable` — board.json was READ fine and then refused to DRAW (`_projectSafe` step 4);
 *   - `board-unparseable` / `board-not-a-board` / `board-read-failed` — board.json was never read
 *     at all, so nothing is known about whether it draws (`_bootUnreadableBoard`);
 *   - `recovery-unusable` — board.json is not there AT ALL and the log beside it recovered
 *     nothing (`_bootRecoveryFailed`, R6-6a/b). Nothing is wrong with a file here; the file is
 *     missing, and saying anything about "the board on disk" would name a file that is gone.
 *
 * Before round 5's integration `persistNow` told every one of them "the board on disk could not
 * be drawn", which is false on three of the four and is the *worst* thing to say on them: it
 * asserts the file is broken when the honest claim is that this app could not open it — often
 * transient, and often the difference between a user relaunching and a user giving up. The copy
 * `_bootUnreadableBoard` documents is keyed off the same enum, so the two never drift apart.
 */
function readOnlyBecause(bootFailure) {
  const tail = ' Every file on disk is exactly as it was.';
  switch (bootFailure && bootFailure.reason) {
    case 'board-read-failed':
      return 'board.json could not be accessed this launch, so nothing may be written over it — '
        + 'this is often temporary; quit and reopen.' + tail;
    case 'board-unparseable':
    case 'board-not-a-board':
      return 'board.json could not be read, so the board on screen is a stand-in and may not be '
        + 'saved over the real file.' + tail;
    case 'recovery-unusable':
      return 'board.json is missing and the op log beside it could not rebuild the board, so the '
        + 'board on screen is a stand-in and writing it would make an empty calendar permanent.'
        + tail;
    default:
      return 'the board on disk could not be drawn.' + tail;
  }
}

/** The newest snapshot that is actually restorable. 11.5's safety net, read defensively. */
function newestUsableSnapshot(list) {
  for (const s of Array.isArray(list) ? list : []) {
    if (s && typeof s === 'object' && typeof s.day === 'string'
      && s.state && typeof s.state === 'object' && !Array.isArray(s.state)) return s;
  }
  return null;
}

const no = (reason, detail) => ({ ok: false, reason, detail });

/**
 * MAY THE LOG'S HISTORY BE ADOPTED? One comparison. Never throws. (ADR 006 §5.2)
 *
 * Five refusals, each naming a fact rather than a guess. `gen` is not read, `v` is not read,
 * `boardHash` does not gate, and no key sets are compared.
 *
 * A bare `ops.jsonl` with no `checkpoint.json` is NEVER adopted: a line format has no header and
 * therefore no lineage. That is what makes A3-C1's original attack — one stray line — structurally
 * unreachable rather than merely unlikely. The cost is that one crash shape (append written,
 * checkpoint write lost) costs a session's HISTORY; under ADR 006 R5 it can never cost content.
 *
 * @returns {{ok:boolean, reason:string, detail:string, exact?:boolean}}
 */
function adoptable(binding, checkpoint, boardText) {
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
    return no('no-checkpoint',
      'there is no readable checkpoint.json; a bare ops.jsonl carries no header and therefore no '
      + 'lineage, and a log with no lineage is never adopted');
  }
  if (!binding) {
    return no('board-carries-no-lineage',
      'board.json carries no _v2.lineageId, so no op log has ever been bound to this board');
  }
  const lzp = checkpoint.lzp;
  if (!lzp || typeof lzp !== 'object' || Array.isArray(lzp) || !isLineageId(lzp.lineageId)) {
    return no('log-carries-no-lineage',
      'checkpoint.json carries no lzp.lineageId; it was not written by this app over any board');
  }
  if (lzp.lineageId !== binding.lineageId) {
    return no('foreign-lineage',
      `checkpoint.json belongs to lineage ${lzp.lineageId}; this board is ${binding.lineageId}`);
  }
  return {
    ok: true,
    reason: 'same-lineage',
    detail: `lineage ${lzp.lineageId}`,
    // Reporting and a fast path only — see `boardHash`. Never a gate.
    exact: typeof lzp.boardHash === 'string' && lzp.boardHash === boardHash(boardText),
  };
}

/**
 * The v1 content of a projected board, reduced to EXACTLY what the register model can express:
 * the four collections keyed by id with their v1 fields, the month-keyed pads, the flattened
 * prefs — AND THE ORDER OF EACH COLLECTION. Used only by the post-condition (ADR 006 R4), and
 * deliberately NOT built out of `_diff`, so that a sabotaged reconciler cannot make the check
 * that guards it vacuous (INV-13).
 *
 * ARRAY ORDER IS CONTENT (R5-5a). This used to compare id→fields maps only, with the reasoning
 * that "entry ORDER is not content". It is: ADR 001 §5 step 5 is explicit that the comparators
 * are MANDATORY, NOT COSMETIC, because v1's capacity slice (`layout.js:209`) and its per-column
 * lane rescue (`layout.js:162-177`) are order-sensitive, so two devices that folded the same ops
 * into different array orders draw different boards from identical data.
 *
 * And order is contributed ENTIRELY BY THE LOG: the comparators sort by `_born`, which is a
 * register, is written once at creation and can never be re-minted (`ops.js` `writeOnce`), and is
 * not in any `COLLECTION[].fields` — so `diffCollection` cannot mint it and, until this change,
 * `v1ContentOf` could not see it either. The reconciler's field list was also its guard's blind
 * spot: swapping two `_born` VALUES inside an adopted checkpoint reordered the board on screen
 * with `quarantine === null` and `reconciled === 0`.
 *
 * Because `_born` cannot be re-minted, R3 cannot be satisfied by minting the difference here the
 * way it is for every other field. What is left is R4, and R4 is enough: the order the LOG
 * asserts must equal the order `board.json` asserts, or the log is refused and `board.json` — in
 * whose array order the truth lives — is used alone. History lost, content kept, order kept.
 *
 * The two orders agree on every path the app itself produces, which is what makes this safe:
 * `board.json` is always written from `store.state`, `store.state` is always the output of
 * `materialize`, and `materialize` sorts by the very `_born` the log holds. They can only differ
 * when one of the two files was written by something that is not this app.
 */
function v1ContentOf(board) {
  const out = { notes: {}, bars: {}, categories: {}, scratchpads: {}, settings: null, order: {} };
  for (const spec of COLLECTION) {
    const bag = out[spec.key];
    const seq = [];
    for (const e of Array.isArray(board?.[spec.key]) ? board[spec.key] : []) {
      if (!e || e.id === undefined || e.id === null) continue;
      const id = String(e.id);
      if (id in bag) continue;                  // a duplicate id: the first one wins, as `_diff` does
      const f = {};
      for (const name of spec.fields) if (e[name] !== undefined) f[name] = e[name];
      bag[id] = f;
      seq.push(id);
    }
    out.order[spec.key] = seq;
  }
  const pads = board?.scratchpads;
  if (pads && typeof pads === 'object') {
    for (const k of Object.keys(pads)) if (isMonthKey(k)) out.scratchpads[k] = pads[k];
  }
  try { out.settings = flattenPref(board?.settings || {}); } catch { out.settings = null; }
  return out;
}

/** Key-order-independent JSON, so the comparison reports VALUES and not insertion order. */
function canonJSON(v) {
  if (Array.isArray(v)) return `[${v.map(canonJSON).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonJSON(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * ADR 006 R4's post-condition, as a predicate: do these two projections assert the same content?
 *
 * Both sides come out of the SAME `materialize` call path — one over the adopted log, one over
 * the spine that `board.json` was migrated into — so defaults, repairs and normalisations are
 * identical on both sides and only a genuine disagreement can show up.
 *
 * Entry ORDER IS compared, and the argument that it was not is in `v1ContentOf` (R5-5a). The
 * fields are compared as a map keyed by id so that the report is about VALUES; the order is
 * compared as the id sequence, separately, so that a disagreement about order says so and a
 * disagreement about a value is not disguised as one.
 */
function sameV1Content(a, b) {
  return canonJSON(v1ContentOf(a)) === canonJSON(v1ContentOf(b));
}

/**
 * WHICH HALF of the post-condition failed, said in one clause. `reconcile-failed` is true and
 * useless on its own; the two halves have different causes and only one of them is repairable in
 * principle, so the detail names which one it was (R5-5a).
 * @param {?Object} theirs the adopted log's projection, or null when it would not project
 * @param {Object} mine `board.json`'s own projection @returns {string}
 */
function postConditionDetail(theirs, mine) {
  if (theirs === null) return 'the log could not be projected at all after reconciliation';
  const A = v1ContentOf(theirs);
  const B = v1ContentOf(mine);
  const orderDiffers = canonJSON(A.order) !== canonJSON(B.order);
  A.order = null;
  B.order = null;
  const valuesDiffer = canonJSON(A) !== canonJSON(B);
  if (orderDiffers && !valuesDiffer) {
    return 'the log projects exactly the entries board.json carries but in a DIFFERENT ORDER. Array '
      + 'order is user-visible (ADR 001 §5 step 5) and it is decided by `_born`, which is write-once '
      + 'and therefore the one thing the reconciler cannot mint the difference for';
  }
  if (orderDiffers) return 'the log disagrees with board.json about both entry values and entry order';
  return 'the log still did not assert what board.json asserts';
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
    // ── IDENTITY (finding A3-H4 · ADR 002 §2.2 · ADR 001 §4.0) ────────────────────────────
    //
    // TWO MODES, AND THE DIFFERENCE IS THE WHOLE OF PRINCIPLE 7.
    //
    // SOLO. What is minted here: EPHEMERAL, per launch, deliberately not persisted, because
    // there is nowhere to persist it — `board.json` is asserted to be exactly `store.state`
    // (11.4) and a persist is asserted to touch exactly the two v1 storage slots. Nothing
    // observable depends on it: migrated stamps carry ZERO_DEVICE_SHORT by construction (ADR 001
    // §8.1), and `ownerId` / `updatedBy` are stripped out of everything that leaves this file.
    // **No key is generated and no probe is run to get here** (ADR 002 §2.4, story 15.1): these
    // three values are a uuid and 10 random bytes, and `src/js/crypto/` is not imported by this
    // file, transitively or otherwise — `tests/tier1/crypto-identity.test.js`'s PRINCIPLE 7 gate
    // walks the graph from `boot.js` and fails if it ever is.
    //
    // FAMILY / PAIRED. `useIdentity()` replaces all four with the DURABLE identity the keystore
    // holds — `ensureDeviceIdentity` via `src/js/platform/device-identity.js`, whose `deviceId`
    // and key-derived `deviceShort` survive a relaunch. The store never reaches for it: crypto
    // is INJECTED, at the family opt-in moment and nowhere else, which is what keeps solo mode
    // from being able to generate a key even by accident.
    //
    // WHY THIS IS A CONVERGENCE BLOCKER AND NOT A TIDINESS ITEM (A3-H4 / R3-41): `foldAuthorized`
    // gates a personal-space op on `op.act === me`, and an ephemeral `me` means Mac B refuses
    // every op Mac A ever wrote. Two Macs over one board cannot converge AT ALL until this is
    // durable — and any fleet test that mints its ops with the receiving store's own `_me` is a
    // false green.
    this._me = mintMemberId();
    this._device = mintDeviceId();
    this._short = crock32(crypto.getRandomValues(new Uint8Array(10)));
    this._clock = createClock(this._short, () => Date.now());
    /** The injected durable identity, or null in solo mode. Read-only once set. */
    this._identity = null;
    /**
     * ADR 001 §4.0's "the LOCAL device set" — my member's OTHER devices, as PAIRING established
     * them, not as the log reports them. `ctx.myDevices` is this ∪ `_device` ∪ whatever the fold
     * itself attests (see `_myDevices`). Empty in solo mode.
     */
    this._peerDevices = new Set();
    /**
     * `(memberId, blob) => DeviceAttestation|null`, injected with the identity. Without it
     * `foldAuthorized` FAILS CLOSED on every `dev.*` register — which is right: a fold that
     * admitted attestations it could not verify would be the key-injection hole ADR 002 §2.3
     * exists to close, entered through the front door.
     */
    this._attestOpen = null;
    this._log = createOpLog({ now: () => Date.now() });
    /**
     * ── THE RETROACTIVE-WITHDRAWAL REPAIR (E9-B · finding 1) ────────────────────────────────
     * `{base, regs, withdrawn:Map<string, string[]|null>}` — see `_authorizedRegisters`. `null`
     * means "not computed for the current log". `_authzArmed` is the ONE bit that decides whether
     * `registers()` pays for a fold at all; it starts `true` because a log loaded from disk may
     * already carry a withdrawn op, and it is re-derived on every fold.
     */
    this._authz = null;
    this._authzArmed = true;
    this._stacks = this._makeStacks();
    this._personalSpaceId = null;
    this._familySpaceId = null;
    this._opsPersisted = false;
    /** finding E5-2: the stand-down warning is said once per session, not once per save. */
    this._e52Warned = false;
    this.publisher = nullPublisher();
    /**
     * ── THE SYNC SEAM (LZP-502 · ADR 003 §8.1 · ADR 006 §9) ────────────────────────────────
     * `true` from the moment `usePersonalSpace()` lands until this store is thrown away. It is
     * NOT the same fact as `_opsPersisted`: a quarantined or read-only launch has a personal
     * space and still may not write the log (§9.5), and the difference is exactly the case the
     * flag exists to keep separate.
     */
    this._syncArmed = false;
    /** `true` when THIS launch republishes its whole personal projection — ADR 006 §9.3's W2
     *  re-join. Set by `init()` when a lineage-bearing board's log was quarantined, and reported
     *  through `diagnostics().sync` so a re-join is a visible event and never a quiet one. */
    this._rejoined = false;
    /**
     * ── ADR 004 §2.3 — THE LOUD FAILURE PATH'S OWN STATE ──────────────────────────────────
     *
     * `null` in health; otherwise `{ at, entityKey, barrier, message }`, the `RedactionError`
     * that stopped the family sync loop. It is a HALT, not a warning: `familyOutbox()` answers
     * `[]` while it is set, so not one further family envelope is offered to the relay.
     *
     * IT IS DELIBERATELY NOT `_syncArmed = false`. That flag gates `_logMayBeWritten()`, so
     * clearing it would stop the LOG being written and lose the very ops the halt exists to
     * protect — the failure mode §5.1 describes, arrived at from the other side. What must stop
     * is publication, and only publication.
     */
    this.redactionHalt = null;

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

    // ── THE SYNC LEDGER — the two things the ENGINE knows and the disk did not (L-1, P-4) ─────
    //
    // `diagnostics().sync` derives `parked` and `lost` from the log and the checkpoint, which are
    // already durable. The other two cannot be derived from anything, because they are facts
    // about bytes that are GONE:
    //
    //   `syncRefusals`  a terminal refusal — a bad signature, a failed AEAD, a malformed
    //                   envelope. The refusal is CORRECT and the cursor is released past the op
    //                   (ADR 003 §8.2), so the relay will never offer it again and this record is
    //                   the only thing left in the world that remembers the divergence. Kept in
    //                   `sync/personal.js`'s per-session `Map` it was visible for minutes and
    //                   then `healthy` for ever — finding L-1.
    //   `syncChain`     ADR 002 §5.4's chain witness said the relay's page does not add up: a
    //                   gap, a mismatch, or a `nextCursor` beyond the last row it actually
    //                   served. `null` means "verified, or nothing to verify" — finding P-4.
    //
    // BOTH ARE THE STORE'S, NOT THE ENGINE'S, and they are declared here rather than created by
    // the first engine that writes one: an engine that adds properties to the store it was
    // injected with is how two files stop agreeing about what the store is.
    //
    // AND BOTH NOW RIDE IN THE CHECKPOINT — `_stampedCheckpoint` writes `lzp.refusals` and
    // `lzp.chain`, `_restoreSyncLedger` reads both back — so both survive the quit, where an
    // array on an instance dies with the process exactly as the Map did. For two rounds only the
    // first of them rode, which is the whole of finding S4c: the docblock gave one reason for two
    // fields and the disk honoured it for one. `syncChain` is cleared again by the first pull
    // that carries positive evidence, so a restored verdict is a report and not a ratchet.
    /** @type {Array<{oid:string, seq:string, reason:string, at:number}>} */
    this.syncRefusals = [];
    /** @type {{ok:false, findings:Array, at:number}|null} */
    this.syncChain = null;

    // ── ADR 006 — the board/log binding ────────────────────────────────────────
    /** The lineage this board's log belongs to, or null in solo mode (where no log is durable). */
    this._lineageId = null;
    /** Diagnostics only. Frozen in the format forever; NOTHING branches on it (ADR 006 §4.2). */
    this._gen = 0;
    /** `{lineageId, exact, reconciled}` when a log's history was adopted; null otherwise. */
    this._adopted = null;
    /** True when `board.json` was not the source of the board on screen (R7, or R5-3's read-only boot). */
    this._recovered = false;
    /** `{from: 'op-log'|'snapshot'|'none', day, at, lineageId}` — WHICH recovery, or null. */
    this._recoveredFrom = null;

    // ── the tail file, `ops.jsonl` (R5-4 · ADR 006 §9.2) ──────────────────────
    /** How many lines `ops.jsonl` holds. `truncateOps(keepFromLine)` wants a line count, and the
     *  store is the only thing that knows one without re-reading the file it just appended to. */
    this._tailLines = 0;
    /** `tailLineKey(op)` for every line already committed — to the tail file, or to a checkpoint
     *  that folds it. Never appended twice. Reset by `init()` from the tail it just read. */
    this._opsCommitted = new Set();
    /** Did the tail `init()` read exceed `TAIL_COMPACT_BYTES`? ADR 001 §7.2's second trigger.
     *  One-shot: the first `_persistOps` of the session compacts and clears it. */
    this._tailOverBytes = false;
    /**
     * Set when even a repaired projection could not be rendered. The app opens on whatever it
     * could build and REFUSES TO WRITE for the rest of the session — the one thing worse than a
     * board that cannot be drawn is that board's replacement committed over the file (I-2).
     */
    this.bootFailure = null;
    /** So the read-only session says so once, not once per debounce tick. */
    this._toldAboutReadOnly = false;

    this.state = defaultState();
    this.snapshots = [];
    this.listeners = new Set();
    this._saveTimer = null;
    this._lastSnapshotDay = null;
    this.ready = false;
    this.undoStack = stackView(() => this._stacks.size().undo, () => this._stacks.clear());
    this.redoStack = stackView(() => this._stacks.size().redo, () => this._stacks.clear());
  }

  /** The undo stacks carry `act`/`dev` into every inverse op, so they are rebuilt with the
   *  identity rather than pinned to whichever one the constructor happened to mint. */
  _makeStacks() {
    return createUndoStacks({
      act: this._me,
      dev: this._device,
      mint: () => this._clock.tick(),
      newOpId,
      newGid,
      // LZP-502: the SPACE IN FORCE, not the placeholder. `undo()` emits NEW ops carrying the
      // pre-values (rule U4) and they go on the wire like any other local op — so an inverse op
      // stamped `space: 'personal'` while every other op carries `psp_…` is an op the outbox
      // would offer and `sealOp` would refuse for ever (ADR 002 §5.2.2 check 2). That is a ⌘Z
      // that syncs on one Mac and never reaches the other, which is the worst possible shape for
      // a bug in undo. `usePersonalSpace()` rebuilds the stacks for the same reason
      // `useIdentity()` does.
      space: this._personalSpaceId ?? PERSONAL_PLACEHOLDER,
      limitGroups: UNDO_LIMIT,
      // `shadow` is deliberately NOT passed: `createUndoStacks` defaults to `DEV`, which the
      // suites arm process-wide through `tests/helpers/dev-flag.mjs` (ATT-96). Pinning it here
      // would disarm risk R5's mechanical guard for the whole app.
    });
  }

  // ── DURABLE DEVICE IDENTITY — the A3-H4 seam ────────────────────────────────────────────────
  //
  // ADR 002 §2.2's identity, handed in rather than reached for. `src/js/platform/device-identity.js`
  // is what produces it (`ensureDeviceIdentity` over the keystore); this file must not import it,
  // because that would put `src/js/crypto/` in `boot.js`'s import graph and solo mode would then
  // evaluate the key generator on first run — the exact thing story 15.1 and ADR 002 §2.4 forbid,
  // and the thing `tests/tier1/crypto-identity.test.js`'s PRINCIPLE 7 gate fails on.
  //
  // WHAT IT CHANGES, AND WHAT IT DOES NOT.
  //   · `_me` stops being per-process, so `foldAuthorized`'s `op.act === me` stops rejecting my
  //     own other Mac. This is the A3-H4 blocker, and it is the whole reason the seam exists.
  //   · `_short` stops being random and becomes `crock32(SHA-256(sigPubRaw)[0..10])`, so the
  //     device short every future stamp carries is the one ADR 002 §5.2.2's check 4 compares
  //     against `env.dv`. Any op minted before this call carries the old short and is not
  //     re-stamped — see the ordering rule below.
  //   · `board.json` is UNCHANGED by it. Identity is not board content (11.4), nothing is
  //     written to disk here, and `state` is not touched.
  //
  // ORDERING — the one rule a caller has to keep. Call it BEFORE `init()`. The spine is minted
  // from `board.json` at `init()` with whatever identity is current (`_buildSpine` passes
  // `memberId`/`deviceId` to `migrateV1`), so an identity adopted afterwards leaves this
  // session's spine authored by the ephemeral one. That is survivable rather than corrupting —
  // ADR 006's whole point is that `board.json` is the truth and the log is history, so the next
  // launch re-derives the spine under the durable identity — but it is not what anyone means,
  // so a post-`init()` call re-derives immediately: it warns, and the caller is told to
  // `await store.init()` again. `_lineageId` and `board.json` are untouched by that, so
  // re-initialising costs nothing (ADR 006 §9.4's re-derivation, arrived at from the other side).
  //
  /**
   * @param {{memberId:string, deviceId:string, deviceShort:string,
   *          peerDeviceIds?:Iterable<string>,
   *          attestOpen?:(m:string, blob:string) => (Object|null)}} identity
   * @returns {{memberId:string, deviceId:string, deviceShort:string}} what the store now is
   */
  useIdentity(identity) {
    const id = identity && typeof identity === 'object' ? identity : {};
    // Loud, not lenient. A half-formed identity that was quietly ignored would leave the store
    // ephemeral while the caller believed it durable, and the symptom would be "sync silently
    // converges nothing" — the same class of failure A3-H4 already is.
    if (!isMemberId(id.memberId)) {
      throw new TypeError(`store.useIdentity: memberId must be a MemberId, got ${JSON.stringify(id.memberId)}`);
    }
    if (!isDeviceId(id.deviceId)) {
      throw new TypeError(`store.useIdentity: deviceId must be a DeviceId, got ${JSON.stringify(id.deviceId)}`);
    }
    if (!isDeviceShort(id.deviceShort)) {
      throw new TypeError(
        'store.useIdentity: deviceShort must be the 16-character Crockford short of the signing key '
        + `(ADR 002 §5.2.0), got ${JSON.stringify(id.deviceShort)}`
      );
    }
    if (this._identity
      && (this._identity.memberId !== id.memberId || this._identity.deviceId !== id.deviceId)) {
      // The same discipline `ensureDeviceIdentity` applies to a half-written key store, for the
      // same reason: a device that quietly re-points at a second identity has authored ops under
      // two names and nobody can tell which of them is this Mac.
      throw new Error(
        `store.useIdentity: this store already runs as ${this._identity.memberId}/${this._identity.deviceId}. `
        + 'An identity is never re-pointed; build a new store.'
      );
    }

    const peers = new Set();
    for (const d of id.peerDeviceIds || []) {
      if (!isDeviceId(d)) throw new TypeError(`store.useIdentity: peerDeviceIds holds ${JSON.stringify(d)}`);
      if (d !== id.deviceId) peers.add(d);
    }
    if (id.attestOpen !== undefined && id.attestOpen !== null && typeof id.attestOpen !== 'function') {
      throw new TypeError('store.useIdentity: attestOpen must be (memberId, blob) => DeviceAttestation|null');
    }

    this._me = id.memberId;
    this._device = id.deviceId;
    this._short = id.deviceShort;
    // The HLC state is carried across, never restarted: `save()`/`opts.state` exist precisely so
    // a clock can be rebuilt without walking backwards. A clock that restarted at 0 would mint
    // stamps below ops this very session already appended.
    this._clock = createClock(this._short, () => Date.now(), { state: this._clock.save() });
    this._peerDevices = peers;
    this._attestOpen = id.attestOpen ?? null;
    this._identity = Object.freeze({
      memberId: id.memberId, deviceId: id.deviceId, deviceShort: id.deviceShort,
    });
    this._stacks = this._makeStacks();

    if (this.ready) {
      this._warn(
        'the device identity was adopted after the board had already loaded, so this session\'s '
        + 'history is still authored by the temporary one. Call store.init() again — board.json is '
        + 'the truth and re-deriving from it costs nothing.'
      );
    }
    return { ...this._identity };
  }

  /** Is this store running on a durable, keystore-backed identity? Diagnostics and tests. */
  hasDurableIdentity() { return this._identity !== null; }

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   * WHO THIS DEVICE CAN VERIFY AN ATTESTATION FOR — ADR 002 §2.3, and it is a MOVING SET.
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   *
   * `foldAuthorized` stage 0a takes `ctx.attestOpen(memberId, blob)` and, without one,
   * `attestationVerifies` returns **`false` for every blob** — fail-closed, correctly, because a
   * fold that admitted an unverifiable attestation would be the key-injection hole §2.3 exists to
   * close. `useIdentity()` accepts one, and that was the ONLY way to supply it.
   *
   * **MEASURED, THREE MACS, A REAL CIRCLE.** Nothing in `src/js/` ever passed one. So every peer's
   * `member.set{dev.<short>}` op was rejected `badAttestation` at stage 0a, and — because that op
   * is the one thing that could ever attest that device — every *subsequent* op from that peer was
   * parked `unattestedDevice`, permanently, curable by nothing. A circle could not admit a single
   * op from anybody. That is finding E6-1 read from its far side, and it survived a whole round
   * because both halves fail silently: the ops arrive, they park, and the board is simply empty.
   *
   * **WHY IT IS ITS OWN METHOD AND NOT AN ARGUMENT TO `useIdentity()`.** The two answer different
   * questions and change on different clocks. An identity is adopted ONCE, before `init()`, and
   * re-pointing it is refused. Who I can verify changes every time the roster does — a member
   * joins, a member pairs a second Mac — and each of those must refresh this WITHOUT re-adopting
   * an identity, which would warn about a spine minted under the temporary one and rebuild the
   * undo stacks for no reason. `family/engine.js#startFamilyEngine` refreshes it on every key
   * pass, from `platform/device-identity.js#buildAttestOpen` over the roster's own rows.
   *
   * It is a SYNCHRONOUS lookup because the fold is synchronous and WebCrypto is not; the async
   * verification happens once, in the builder, and a blob that failed it is simply absent — which
   * `authz.js` reads as `BAD_ATTESTATION`. Fail-closed is preserved end to end.
   *
   * @param {((memberId:string, blob:string) => (Object|null))|null} fn
   */
  setAttestOpen(fn) {
    if (fn !== null && typeof fn !== 'function') {
      throw new TypeError('store.setAttestOpen: expected (memberId, blob) => DeviceAttestation|null, or null');
    }
    this._attestOpen = fn;
    return this;
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // THE SYNC SEAM — LZP-502.  `src/js/sync/personal.js` is the only caller.
  //
  // ADR 003 §8 puts the engine outside this file: the transport, the cadence, the backoff and
  // the envelopes all live in `src/js/sync/`, and `store.js` neither imports them nor knows
  // whether one is attached. What it owns is the six facts a sync engine cannot compute for
  // itself, and every one of them is a projection of the LOG:
  //
  //   usePersonalSpace()  which `psp_…` id this board's ops are authored into
  //   outbox()            the sealed-but-unacknowledged lines — §8.1, derived, never a queue
  //   ackPushed()         the server has it (`accepted` OR `duplicate` — §3.1, identically)
  //   cursor()/noteCursor()   the transport cursor, §3.3, riding BELOW the commit point (§9 W1)
  //   applyRemote(ops, {seqs})  the inbox
  //   setPublisher()      ADR 004 §3's retraction hand-off (the WP-3 obligation)
  //
  // WHY THE OUTBOX IS DERIVED AND NOT A SECOND FILE. ADR 003 §8.1 defines it as "`ops.jsonl`
  // lines whose `seq` is unset", and that definition is worth more than it looks: it means every
  // path that appends a local op — `_commit`, `undo`, `redo`, `_adopt`, `replaceAll`, and any
  // path a later round adds — is in the outbox automatically, with no publish hook to forget at
  // one of them. A separate queue would have to be written to at six call sites and would drift
  // at the seventh. It also survives quit and crash for free, because the log does (19.1).
  // ══════════════════════════════════════════════════════════════════════════════════════════

  /**
   * Adopt the personal space this board's ops belong to (story 19.4).
   *
   * ORDERING — the same rule `useIdentity()` has, for the same reason and with more teeth.
   * **Call it BEFORE `init()`.** `_ctx().space` is `_personalSpaceId ?? PERSONAL_PLACEHOLDER`, so
   * the spine `init()` mints from `board.json` carries whichever of the two was current — and an
   * op stamped `space: 'personal'` can NEVER be sealed for a `psp_…` space: ADR 002 §5.2.2 check
   * 2 (`hdr.sp === op.space`) is mirrored inside `sealOp`, so it fails at authoring time on the
   * one machine that can still do something about it. Adopting the space first means the whole
   * board is minted into it, once, by the ordinary spine path, with GENESIS stamps when the board
   * has never had a log (so two Macs migrating the same `board.json` still agree byte for byte —
   * ADR 001 §8.1) and fresh ones when it has (ADR 006 §9.4).
   *
   * A post-`init()` call is REFUSED rather than warned about, which is the one place this seam is
   * stricter than `useIdentity()`: `useIdentity` after `init()` leaves a survivable "this
   * session's history is authored by the temporary identity", while a space adopted after `init()`
   * leaves a whole log of placeholder-space ops that the outbox would offer and `sealOp` would
   * then refuse one by one, for ever, with nothing on screen to say why.
   *
   * @param {string} spaceId a `psp_…` SpaceId
   * @returns {string} the id now in force
   */
  usePersonalSpace(spaceId) {
    if (!isSpaceId(spaceId) || spaceClassOf(spaceId) !== 'personal' || spaceId === PERSONAL_PLACEHOLDER) {
      throw new TypeError(
        `store.usePersonalSpace: expected a psp_… SpaceId, got ${JSON.stringify(spaceId)}`);
    }
    if (this._personalSpaceId !== null && this._personalSpaceId !== spaceId) {
      throw new Error(
        `store.usePersonalSpace: this store already writes into ${this._personalSpaceId}. A board `
        + 'belongs to one personal space; build a new store.');
    }
    if (this.ready) {
      throw new Error(
        'store.usePersonalSpace: call it BEFORE init(). Adopting a space afterwards leaves this '
        + "session's whole log authored into the 'personal' placeholder, and sealOp refuses every "
        + 'one of those envelopes (ADR 002 §5.2.2 check 2). Re-run init().');
    }
    this._personalSpaceId = spaceId;
    this._syncArmed = true;
    // The undo stacks carry the space into every inverse op, so they are rebuilt rather than
    // pinned to whatever the constructor happened to hold — the same discipline `useIdentity()`
    // applies to `act`/`dev`, and for a sharper reason: see `_makeStacks`.
    this._stacks = this._makeStacks();
    return spaceId;
  }

  /** The `psp_…` id in force, or `null` in solo mode. */
  personalSpaceId() { return this._personalSpaceId; }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // THE FAMILY PUBLISH SEAM — finding E6-1, and the write half of E6
  //
  // `_familySpaceId` has existed since WP-3. It is read by `_project()` (which strips the v2
  // decorations while it is null), by `_projectionOf`, by the checkpoint envelope and by
  // `_ctx()`, where `core/ops.js:spaceFor` refuses to build a `pub.set` / `member.set` /
  // `space.set` without it. Nothing ever SET it. The consequences, all measured:
  //
  //   · `store.apply('setMyProfile', …)` threw `unknown mutation` — 15.6's write half did not
  //     exist, so every member row on every Mac read „Name noch nicht angekommen", MY OWN
  //     INCLUDED (E6-1);
  //   · a family op that arrives from a peer folds into the register map and CANNOT RENDER,
  //     because `core/materialize.js:791` is `if (!familySpaceId) break;`. The op lands, the
  //     board stays empty, and nothing anywhere is in an error state;
  //   · `outbox()` is hard-filtered to `_personalSpaceId`, so a family op this device authored
  //     would never be offered to the relay: this build shared nothing outbound.
  //
  // FOUR METHODS, and they are the whole seam. `sync/family.js` takes the outbox as a PORT
  // (`{lines, ack}`) with an empty default and reports `outbound.wired === false` until one is
  // handed in — `familyOutbound()` is that port, so wiring it is one property and not a new
  // protocol.
  // ══════════════════════════════════════════════════════════════════════════════════════════

  /**
   * Adopt the Familienkreis this device's family ops are authored into (F15, ADR 001 §3).
   *
   * **UNLIKE `usePersonalSpace()`, THIS MAY BE CALLED AFTER `init()`, AND THAT IS NOT A
   * RELAXATION.** The personal rule exists because `_ctx().space` defaults to the `'personal'`
   * PLACEHOLDER, so a spine minted before the space is adopted carries the wrong space in every
   * op and `sealOp` refuses each one for ever (ADR 002 §5.2.2 check 2). There is no family
   * placeholder: `spaceFor` THROWS without an `fsp_…`, so before this call the log holds no family
   * op at all and there is nothing to have stamped wrongly. Being callable mid-session is also
   * required rather than convenient — joining a circle happens in the middle of a session, which
   * is the whole of story 15.3.
   *
   * Three things follow the assignment, each of which is a defect if it is missing:
   *   · the log becomes writable (`_logMayBeWritten`), because a Mac can be in a Familienkreis
   *     without ever having opted into own-device sync (19.4) — that is precisely the Mac E6's
   *     verification measured making zero `/ops` requests — and until now `_opsPersisted` was
   *     gated on a PERSONAL space alone, so that Mac's family ops would never have reached disk;
   *   · the board is re-projected, because `_project()` branches on `_familySpaceId` to decide
   *     whether the v2 decorations are stripped and whether a foreign entry may render at all;
   *   · `emit()` runs, so a board mounted before the join redraws without anybody polling.
   *
   * @param {string} spaceId an `fsp_…` SpaceId
   * @returns {string} the id now in force
   */
  useFamilySpace(spaceId) {
    if (!isSpaceId(spaceId) || spaceClassOf(spaceId) !== 'family') {
      throw new TypeError(
        `store.useFamilySpace: expected an fsp_… SpaceId, got ${JSON.stringify(spaceId)}`);
    }
    if (this._familySpaceId !== null && this._familySpaceId !== spaceId) {
      throw new Error(
        `store.useFamilySpace: this store already writes into ${this._familySpaceId}. Addendum `
        + '20.6 — a user belongs to at most ONE Familienkreis; leave the first (20.3) and build a '
        + 'new store.');
    }
    if (this._familySpaceId === spaceId) return spaceId;
    this._familySpaceId = spaceId;
    this._syncArmed = true;
    // ADR 006 §9.5 — `_logMayBeWritten()` is what consults `store.quarantine`, so this may turn
    // the flag ON and can never turn it on over bytes the quarantine is preserving.
    if (this.ready) {
      this._opsPersisted = this._logMayBeWritten();
      this._project();
      this.emit('family-space');
    }
    return spaceId;
  }

  /** The `fsp_…` id in force, or `null` when this Mac is in no Familienkreis. */
  familySpaceId() { return this._familySpaceId; }

  /**
   * THE FAMILY OUTBOX — `outbox()`'s definition, over the family space (ADR 003 §8.1).
   *
   * It is the SAME METHOD with a different space rather than a second reader, because the four
   * filters `outbox()` documents are not personal-space facts: `seq === null` is the definition,
   * a parked line is a promise not to fold, a peer's op can never be in my outbox (`POST /ops`
   * answers `403 device_mismatch`), and a genesis stamp is shared prehistory. A copy would drift
   * at the first of them somebody remembered to change in one place.
   * @param {{limit?:number}} [opts]
   */
  familyOutbox(opts = {}) {
    // ADR 004 §2.3 — a RedactionError STOPS THE SYNC LOOP. Here is where it stops: the engine
    // asks for lines and is told there are none, for as long as the halt stands. It is never
    // logged-and-skipped, because a silently omitted downgrade op is exactly the §5.1 failure —
    // the entry looks downgraded on my board and stays fully readable on Mama's.
    if (this.redactionHalt) return [];
    return this.outbox({ ...opts, space: this._familySpaceId });
  }

  /**
   * ── ADR 004 §2.3 — THE PUBLICATION SEAM, AND THE LOUD FAILURE PATH ────────────────────────
   *
   * `core/project.js:PUBLISH_FAILURE_CONTRACT` is the specification this satisfies; its six
   * clauses are checked executably by `tests/tier1/redaction-failpath.test.js`.
   *
   * **IT IS CALLED SYNCHRONOUSLY, FROM INSIDE THE APPEND, AND THAT IS A DEPARTURE FROM §2.3's
   * WORDING WITH §2.3's OWN REASON.** The ADR places the publish path "inside the
   * `queueMicrotask` after `emit()`" because ADR 001 §0.9 forbids an `await` above `emit()` — the
   * hazard is ASYNCHRONY, and `derivePublication` is pure and synchronous. Deferring it to a
   * microtask would buy nothing and cost two things that matter:
   *
   *   1. **The gid.** ADR 004 §5 requires the truth write and the publication to be ONE
   *      transaction — one ⌘Z (18.4). An op appended after `_stacks.push` carries the gid and is
   *      outside the undo entry, so ⌘Z would restore `visibility: 'privat'` in the truth and
   *      leave `pub.level: 'geteilt'` published. A leak that survives undo.
   *   2. **The ordering.** A microtask runs after `emit()`, so every listener redraws against a
   *      board whose publication has not been derived yet, and the exposure badge (§6) reads a
   *      state that is one tick stale in the UNSAFE direction.
   *
   * What genuinely belongs in the microtask is the SEALING, and it is already there: the outbox
   * is derived from the log (`ops.jsonl` lines with no `seq`), so there is no enqueue step at
   * all and `sync/family.js` seals on its own cadence.
   *
   * @param {Object[]} localOps the ops just appended @param {string} gid their group
   * @returns {Object[]} the `pub.set` ops appended, `[]` when solo or when nothing changed
   */
  _publishAndEnqueue(localOps, gid) {
    if (this._familySpaceId === null) return [];        // 16.1 — solo mode costs zero bytes
    if (this.redactionHalt) return [];                  // already halted; do not compound it
    let pubs = [];
    try {
      pubs = derivePublication(localOps, this.registers(), {
        ...this._ctx(gid),
        me: this._me,
        truthOf: (truthKind, uuid) => this._truthOf(truthKind, uuid),
      });
    } catch (err) {
      // CATCH BY NAME, never by identity: `core/project.js` and `crypto/envelope.js` each export
      // a `RedactionError` and neither may import the other (ADR 005 §2).
      if (err && err.name === 'RedactionError') {
        this.redactionHalt = {
          at: new Date().toISOString(),
          barrier: err.barrier ?? null,
          message: String(err.message),
          gid: gid ?? null,
        };
        this._warn(
          `PUBLICATION HALTED (${err.barrier ?? 'redaction'}): ${err.message} — family sync is `
          + 'stopped and nothing further will be published from this Mac until the cause is '
          + `fixed. ${PUBLISH_FAILURE_CONTRACT.adr}. Your own board is unchanged and your local `
          + 'ops are safe; what has stopped is publication, and only publication.',
        );
        return [];
      }
      throw err;
    }
    if (!pubs.length) return [];
    this._armAuthz(pubs);
    for (const op of pubs) this._log.append(op);
    return pubs;
  }

  /**
   * The MATERIALIZED truth fields of one of my entities — ADR 004 §4.1's `truth` argument.
   *
   * Two layers, and the order is the whole point. The registers carry the structural rows
   * (`_alive`, `_born`, `visibility`) that materialization renames or strips; the materialized
   * entry carries PROMOTION — a co-editor's newer `pub.date` already folded over my older one
   * (§4.1). Publishing raw registers would re-publish my stale value at a fresh stamp on every
   * visibility change and silently win, which is the co-edit half of the §5.1 failure.
   *
   * @param {'note'|'bar'} truthKind @param {string} uuid @returns {Object|null}
   */
  _truthOf(truthKind, uuid) {
    let cells;
    try { cells = this.registers().get(`${truthKind}:${uuid}`); } catch { cells = null; }
    if (!cells) return null;
    const truth = {};
    for (const [name, cell] of cells) truth[name] = cell === null ? null : cell.value;
    const list = truthKind === 'note' ? this.state.notes : this.state.bars;
    const mat = Array.isArray(list) ? list.find((e) => e && e.id === uuid) : undefined;
    if (mat) {
      for (const f of PROMOTED_TRUTH_FIELDS) {
        if (Object.hasOwn(mat, f)) truth[f] = mat[f];
      }
    }
    return truth;
  }

  /**
   * The `{lines, ack}` port `sync/family.js` declares as `FamilySyncDeps.outbound`.
   *
   * `ack` is `ackPushed`, unchanged and unwrapped: `oplog.ack(oid, seq)` addresses a line by opId
   * and knows nothing about spaces, so one acknowledger serves both engines and there is no way
   * for the two to disagree about what "the server has it" means (ADR 003 §3.1).
   */
  familyOutbound() {
    return {
      lines: (o) => this.familyOutbox(o || {}),
      ack: (entries) => this.ackPushed(entries),
    };
  }

  /**
   * **ADR 004 §2.2 BARRIER 4 — `sealOp`'s `ctx.levelOf`, answered from the AUTHENTICATED REGISTER
   * MAP and from nothing else.**
   *
   * `crypto/envelope.js` refuses to seal a family `pub.set` without this function, and the refusal
   * is deliberate: the level a payload may carry must be re-derived at seal time rather than taken
   * from the patch. Finding S5 is what happens when it is not — the caller's declared level wins,
   * a legitimate projection declares one on every transition, and a `pub.text` gets sealed for an
   * entry the register map calls **belegt**.
   *
   * **THE ONE CHOICE IN HERE IS WHICH REGISTER IT READS, AND `visibility` IS THE ONLY RIGHT
   * ANSWER.** `pub.level` — the level last PUBLISHED to the family — is the level a transition is
   * moving AWAY from, so wiring this to it makes every first share a barrier-4 refusal and every
   * downgrade a barrier-4 refusal in the other direction. `visibility` is the entity's own `gov`
   * truth register in MY PERSONAL space (ADR 001 §3.1), it already carries the NEW level when the
   * publish microtask runs (ADR 001 §0.9), and it is the same value `core/visibility.js#plan()`
   * hands to `projectForFamily` as `truth.visibility`. One value, two consumers — which is exactly
   * what `PUBLISH_FAILURE_CONTRACT` clause 5 requires and what `brand.level === level` checks.
   *
   * **A FOREIGN ENTRY ANSWERS `null`, AND THAT IS A REFUSAL RATHER THAN A GUESS.** The key names
   * its owner (`fnote:<memberId>/<uuid>`, ADR 001 §4.4), and a viewer holds `pub.*` for a peer's
   * entry and no `visibility` register at all — there is no truth here to re-derive from. Barrier 4
   * turns the `null` into a `RedactionError`, which is the correct outcome: **this device may not
   * publish somebody else's entry**, and answering with the peer's last-published `pub.level`
   * instead would let a co-edit re-publish a text at a level its owner had since withdrawn.
   *
   * @param {string} entityKey an `fnote:`/`fbar:` family key
   * @returns {'privat'|'belegt'|'geteilt'|null}
   */
  familyLevelOf(entityKey) {
    if (typeof entityKey !== 'string') return null;
    const slash = entityKey.indexOf('/');
    const colon = entityKey.indexOf(':');
    if (colon < 0 || slash < 0) return null;
    const kind = entityKey.slice(0, colon);
    const owner = entityKey.slice(colon + 1, slash);
    const uuid = entityKey.slice(slash + 1);
    const truthKind = kind === 'fnote' ? 'note' : (kind === 'fbar' ? 'bar' : null);
    if (truthKind === null) return null;
    // Ownership is READ OFF THE KEY, not off a flag: `_me` is this device's MemberId and the key
    // carries the author's. A key naming anybody else has no truth register on this Mac and the
    // honest answer is that there is nothing to derive.
    if (owner !== this._me) return null;
    let cells;
    try { cells = this.registers().get(`${truthKind}:${uuid}`); } catch { return null; }
    const cell = cells && typeof cells.get === 'function' ? cells.get('visibility') : undefined;
    const v = cell === undefined ? undefined : cell.value;
    return v === 'privat' || v === 'belegt' || v === 'geteilt' ? v : null;
  }

  /**
   * ── BARRIER 4's LEVEL FOR SOMEBODY ELSE'S ENTRY — story 18.2, and ONLY 18.2 ────────────────
   *
   * `familyLevelOf` above answers `null` for a foreign key and that stays exactly right: it reads
   * the entity's own `visibility` TRUTH register, and a viewer holds no truth for a peer's entry.
   * But "there is no truth here" was being read as "nothing may be sealed here", and that made
   * 18.2 a permission nobody could exercise: `pub.coEdit` granted the co-editor the right to edit,
   * `interact.js` let the gesture start, and `sealOp` then refused the write with a
   * `RedactionError` — which sets `redactionHalt` and stops ALL family sync from this Mac. The
   * flag was worse than absent.
   *
   * **THE LEVEL OF A CO-EDIT IS NOT A TRUTH QUESTION, AND THAT IS WHY THIS IS A DIFFERENT
   * FUNCTION AND NOT A LOOSENING OF THAT ONE.** `familyLevelOf`'s argument against reading
   * `pub.level` — "the level a transition is moving AWAY from" — is an argument about a
   * TRANSITION, and only an owner has one. A co-editor moves no level: they write `pub.text` at
   * whatever level the owner has already published and the fold has already authenticated. So the
   * right source here is the one `authz.js` stage 3b itself consults, and this reads exactly the
   * registers that predicate reads:
   *
   *     pub.level === 'geteilt'   AND   pub.coEdit === true   AND   pub.alive !== false
   *
   * — three folded, authenticated governing registers, written by the OWNER alone (stage 3a), on
   * a key whose owner segment is somebody else. Nothing the caller supplies appears in the
   * answer. A co-editor still cannot grant themselves co-edit, because writing `pub.coEdit` is a
   * governing write and stage 3a folds those from the owner; forging one locally changes this
   * Mac's answer and no other device's, and the op it produces is rejected by every peer. D7:
   * enforcement is by convergence, and this function is a CAPABILITY check — "would the family
   * accept this write?" — asked before the bytes exist, so an honest client refuses early instead
   * of halting itself.
   *
   * **IT ANSWERS `null` FOR MY OWN KEY, DELIBERATELY.** My entries publish through
   * `derivePublication` from their truth register — one entity, one producer (ADR 004 §5.1). If
   * this answered for my own keys it would become a second producer reading the level I last
   * PUBLISHED, and a downgrade would re-publish at the level it was moving away from. That is
   * finding S5, and it is the exact bug `familyLevelOf`'s comment exists to prevent.
   *
   * **IT IS NEVER CONSULTED FOR A RETRACTION**, and `sync/family.js` is where that is enforced:
   * an admin unshare (18.3) is a `pub.set` on a foreign key too, and barrier 4's retraction
   * clause fires only while `levelOf` has NO answer. See `sync/family.js:sealLevelFor`.
   *
   * @param {string} entityKey an `fnote:`/`fbar:` family key naming SOMEBODY ELSE as owner
   * @returns {'geteilt'|null}
   */
  familyCoEditLevelOf(entityKey) {
    if (typeof entityKey !== 'string') return null;
    const colon = entityKey.indexOf(':');
    const slash = entityKey.indexOf('/');
    if (colon < 0 || slash < 0 || slash < colon) return null;
    const kind = entityKey.slice(0, colon);
    const owner = entityKey.slice(colon + 1, slash);
    if (kind !== 'fnote' && kind !== 'fbar') return null;
    if (owner === this._me) return null;          // mine: `derivePublication` owns it, not this
    if (this._familySpaceId === null) return null;
    let cells;
    try { cells = this.registers().get(entityKey); } catch { return null; }
    if (!cells || typeof cells.get !== 'function') return null;
    const read = (field) => {
      const cell = cells.get(field);
      return cell === undefined || cell === null ? undefined : cell.value;
    };
    if (read('pub.alive') === false) return null;             // withdrawn or deleted
    if (read('pub.coEdit') !== true) return null;             // 18.1 — the default is no
    if (read('pub.level') !== 'geteilt') return null;         // co-edit exists at no other level
    return 'geteilt';
  }

  /**
   * ── 18.2's WRITE · the co-editor's commit, and the ONE door `interact.js` may use ──────────
   *
   * A foreign entry's `id` IS its entity key (`fbar:mem_mama…/uuid`), and every v1 mutation
   * routes through `entities.js:barKey/noteKey`, which THROW on anything that is not a bare uuid.
   * So `store.apply('moveBar', …)` is not merely wrong for a co-edit, it wedges the board — the
   * throw escapes `onPointerUp` above the lines that clear the drag. This is the door that exists
   * so that gesture has somewhere to go.
   *
   * ⚠ IT IS A FAMILY-SPACE WRITE AND NOTHING ELSE. There is no truth register to move: the entry
   * is not mine, it lives on my board only as a projection of the family's `pub.*` registers, and
   * a co-edit writes those registers directly. `_publishAndEnqueue` is deliberately NOT called —
   * it derives publications from MY truth ops, and there is no truth op here.
   *
   * ⚠ IT IS ONE TRANSACTION, so 18.4 holds. The op goes through `_commit`, which is what puts it
   * on the undo stack: my ⌘Z undoes MY co-edit, and a peer's co-edit of the same entry arrives
   * through `applyRemote`, which touches neither stack. The two never mix.
   *
   * The level is not an argument. It is read from `familyCoEditLevelOf` — the authenticated fold
   * — immediately above the call, and `coEditOp` → `projectCoEditPatch` → `sealOp` each re-check
   * it. A `null` here is the honest "the family has not granted this", and the answer is `false`
   * rather than a throw: 18.2's grant can be withdrawn by the owner between the pointer going
   * down and coming up, and a withdrawn permission is a declined gesture, not a crash.
   *
   * @param {string} entityKey an `fnote:`/`fbar:` key naming somebody else
   * @param {Object} changes   `{'pub.text': '…'}` / `{'pub.date': 'YYYY-MM-DD'}`
   * @param {string} [label]   the undo label
   * @returns {boolean} whether an op was appended
   */
  applyCoEdit(entityKey, changes, label) {
    const level = this.familyCoEditLevelOf(entityKey);
    if (level === null) return false;                    // not granted, or not foreign, or gone
    if (!this._intervalStaysOrdered(entityKey, changes)) return false;
    const colon = entityKey.indexOf(':');
    const slash = entityKey.indexOf('/');
    const kind = entityKey.slice(0, colon);
    const owner = entityKey.slice(colon + 1, slash);
    const uuid = entityKey.slice(slash + 1);
    const shadow = this._shadow();
    const ctx = this._ctx();
    let op;
    try {
      op = coEditOp(ctx, { kind, owner, uuid }, level, changes);
    } catch (err) {
      // The projection refused — a governing field, a non-scalar, an unknown field. That is a
      // programmer error at this call site rather than externally-sourced input, but it must not
      // reach `onPointerUp`: see the wedge above. Reported, and declined.
      if (err && err.name === 'RedactionError') {
        this._warn(`co-edit refused by the projection (${err.barrier ?? 'barrier1'}): ${err.message}`);
        return false;
      }
      throw err;
    }
    if (op === null) return false;                       // nothing actually changed
    this._commit(label ?? 'Familieneintrag bearbeitet', [op], shadow);
    return true;
  }

  /**
   * ── THE BAR'S ONE CROSS-FIELD INVARIANT: `startDate <= endDate` (E9-D §4c) ────────────────
   *
   * A `fbar` has a value NO SINGLE FIELD OWNS. `pub.startDate` and `pub.endDate` are each a
   * register with its own stamp and its own per-field LWW winner — which is correct, is what
   * story 18.5 promises ("the later change wins PER FIELD"), and is heavily property-tested — and
   * between the two of them sits an ordering nothing in the register model enforces. Two invited
   * co-editors, two ordinary drags, one edge each: nobody's write is displaced, so 18.5 correctly
   * tells nobody anything, and the bar converges to `start 2027-03-01 / end 2026-12-20`.
   * `buildBoard` then emits ZERO segments and the entry leaves every board in the family,
   * silently, while still sitting in `state.bars` and surviving a reload.
   *
   * ── WHAT THIS FUNCTION IS, AND WHAT IT DELIBERATELY IS NOT ───────────────────────────────
   *
   * IT IS the shipped door keeping its own promise: `applyCoEdit` is the ONE door `interact.js`
   * may use, and a gesture that would invert the bar THIS MAC CAN SEE is a declined gesture, the
   * same way a withdrawn grant is (`familyCoEditLevelOf` returning `null` above). It costs one
   * register read and it is the half a door can honestly make true.
   *
   * IT IS NOT THE FIX FOR §4c, and pretending otherwise would be the third layer of D7's own
   * warning about `layout.js:canEditEntry`: this is a promise about THIS Mac's hands and it
   * proves nothing about a peer. Two writes that are each ordered where they were MADE still
   * converge to an inverted pair — Mama pulls the right edge in to the 10th while Oma, who has
   * not seen that, pushes the left edge out to the 15th — and no author-side predicate anywhere
   * can see that, because neither author has the other's write.
   *
   * THE CONVERGENT HALF BELONGS IN THE PROJECTION, and it is owed rather than done here because
   * `core/materialize.js` belongs to another owner this round. The rule it wants is ADR 001 §5
   * step 7's shape exactly — "reference repair is a projection INVARIANT, not a mutation" — one
   * more line beside the dangling-category repair:
   *
   *     a bar whose folded `startDate` is after its folded `endDate` projects with its interval
   *     repaired from the LATER-STAMPED of the two registers (that edge is the one the family
   *     most recently agreed to move; the other follows it), idempotently, without rewriting the
   *     log and without either co-editor's op being touched.
   *
   * It has to live there for the same reason the category repair does: it is a pure function of
   * the register map, so every device computes the same answer with nothing to synchronise, and
   * an entry that is unrenderable is repaired rather than dropped.
   *
   * @param {string} entityKey the foreign `fbar:`/`fnote:` key being edited
   * @param {Object} changes   the caller's patch, before `projectCoEditPatch` sees it
   * @returns {boolean} `false` when this write would invert the bar as this Mac currently folds it
   */
  _intervalStaysOrdered(entityKey, changes) {
    if (typeof entityKey !== 'string' || !entityKey.startsWith('fbar:')) return true;
    if (!changes || typeof changes !== 'object') return true;
    const wantsStart = Object.prototype.hasOwnProperty.call(changes, 'pub.startDate');
    const wantsEnd = Object.prototype.hasOwnProperty.call(changes, 'pub.endDate');
    if (!wantsStart && !wantsEnd) return true;
    let cells = null;
    try { cells = this.registers().get(entityKey); } catch { cells = null; }
    const folded = (f) => {
      const cell = cells && typeof cells.get === 'function' ? cells.get(f) : undefined;
      return cell === undefined || cell === null ? undefined : cell.value;
    };
    const was = { s: folded('pub.startDate'), e: folded('pub.endDate') };
    const start = wantsStart ? changes['pub.startDate'] : was.s;
    const end = wantsEnd ? changes['pub.endDate'] : was.e;
    // A half-published bar has no interval to invert yet, and an explicit `null` is a withdrawal
    // rather than a date (ADR 004 §5.1). Neither is this predicate's business.
    if (typeof start !== 'string' || typeof end !== 'string') return true;
    if (start <= end) return true;                         // ISO dates compare lexicographically
    // ⚠ IT REFUSES TO *CREATE* AN INVERSION, NEVER TO LIVE WITH ONE. If the bar this Mac folds
    // is ALREADY inverted — because §4c-b happened, or because a peer's single-field write landed
    // between the pointer going down and coming up — then refusing here would wedge the entry:
    // every gesture that could repair it would be declined by the state it is trying to repair,
    // and the entry that draws nothing would also be the entry nobody can move. So an interval
    // that was broken before the gesture is not this predicate's to defend.
    if (typeof was.s === 'string' && typeof was.e === 'string' && was.s > was.e) return true;
    this._warn(
      `co-edit declined: it would set ${entityKey} to start ${start} and end ${end}. A bar that `
      + 'starts after it ends draws nothing at all, so the gesture is refused rather than folded.');
    return false;
  }

  /**
   * Who holds the admin seat, and the opId a transfer must name as `adminPrev` (ADR 001 §4.1).
   *
   * The chain is `core/authz.js`'s to resolve and this does not re-resolve it: `applyRemote`
   * gates every remote op on `foldAuthorized` before it reaches the log, so a link that lost the
   * longest-chain resolution never became a register write and `space:<id>` → `admin` is the
   * accepted head's value. `headOpId` is that register's `op` — the very link the next transfer
   * supersedes — which is why this is one register read and not a second chain walk.
   *
   * @returns {{spaceId:string|null, admin:string|null, headOpId:string|null, isMe:boolean}}
   */
  familyAdmin() {
    const sid = this._familySpaceId;
    const blank = { spaceId: sid, admin: null, headOpId: null, isMe: false };
    if (sid === null) return blank;
    const cells = this.registers().get(`space:${sid}`);
    const cell = cells && cells.get('admin');
    if (!cell || typeof cell.value !== 'string') return blank;
    return {
      spaceId: sid,
      admin: cell.value,
      headOpId: typeof cell.op === 'string' ? cell.op : null,
      isMe: cell.value === this._me,
    };
  }

  /**
   * Every space this device authors SYNCED ops into. `local` is never one of them (ADR 001 §3.3).
   * The order is personal-then-family and nothing depends on it; what depends on the LIST is
   * `_outboxHorizonCap()`, which must see BOTH outboxes or a compaction folds away a family op
   * the relay has never seen — finding E5-2, one space to the right.
   * @returns {string[]}
   */
  _syncedSpaces() {
    const out = [];
    if (this._personalSpaceId !== null) out.push(this._personalSpaceId);
    if (this._familySpaceId !== null) out.push(this._familySpaceId);
    return out;
  }

  /**
   * MAY THE LOG BE WRITTEN THIS LAUNCH? ADR 006 §9.5, and it is the whole of that rule.
   *
   * "Whoever sets `_opsPersisted = true` when a space is created must consult `store.quarantine`
   * first. Turning the flag on over a quarantined log overwrites the very bytes the quarantine
   * exists to preserve." `_sequesterQuarantine()` renames those bytes out of the way, so once it
   * reports `movedAside` there is nothing left to overwrite and the log may be written again.
   * A refused move (or a DEFERRED_QUARANTINE reason, which is kept in place ON PURPOSE so the
   * next launch can reconsider it) means the log stays read-only for this session.
   */
  _logMayBeWritten() {
    // EITHER space arms the log. A Mac can be in a Familienkreis without ever having opted into
    // own-device sync (19.4 is a separate opt-in, and `family/mount.js` mounts the circle from
    // `board.json` alone) — gating this on the PERSONAL space alone meant that Mac authored
    // family ops into a log it would never write, so every one of them was lost at quit.
    if (!this._syncArmed || this._syncedSpaces().length === 0) return false;
    if (this.bootFailure) return false;                       // I-2: a read-only session writes nothing
    if (this.quarantine && !this.quarantine.movedAside) return false;
    return true;
  }

  /**
   * THE OUTBOX (ADR 003 §8.1) — the lines this device authored that the server has not confirmed.
   *
   * Four filters, and every one of them is a defect if it is missing:
   *
   *  · `seq === null` — the definition. An op leaves the outbox when the server reports it in
   *    `accepted` OR `duplicate` (§3.1: the client treats them identically), which is
   *    `ackPushed()` below, which is `oplog.ack()`, which rides in `checkpoint().seqs` and so
   *    survives a relaunch. This is why a crash between push and ack costs one duplicate push and
   *    never a lost op, and why at-least-once delivery is sufficient.
   *  · `park === null` — a parked line is a promise not to fold. Pushing one would publish an op
   *    this build has already decided it cannot apply.
   *  · `op.dev === this._device` — **A PEER'S OP CAN NEVER BE IN MY OUTBOX.** It is not a
   *    politeness: `POST /ops` refuses `e.dv !== auth.deviceShort` with `403 device_mismatch`,
   *    and `sealOp` cannot even build the envelope, because `devOf(op.ts)` is the peer's short
   *    and check 4 compares it against mine. Without this filter, one peer op that arrived
   *    without a seq wedges the outbox permanently.
   *  · the space — `op.space === this._personalSpaceId`. This is F-7's outbound half. `pref.set`
   *    is a `local`-space op and settings are NEVER synced (17.7, rule U6); a family op belongs
   *    to a different key and a different stream (21.2 — the two scopes are disjoint and the
   *    crypto layer enforces it, so this filter is the second of two locks, not the only one).
   *  · **GENESIS stamps — the spine is shared PREHISTORY, not traffic.** A migration op's stamp
   *    carries the all-zeros device short by construction (ADR 001 §8.1), so `sealOp` refuses it
   *    on ADR 002 §5.2.2 check 4 and no honest peer could open it if it somehow got out. It does
   *    not need to travel and must not: §8.1's determinism means the op is a pure function of
   *    `board.json`, so every Mac holding that file has already minted the identical op, with the
   *    identical opId — which is exactly why re-stamping the spine instead would collide on
   *    `409 forked_op_id` (same id, different bytes) on the second Mac's very first push.
   *    Without this filter the outbox offers the whole migrated board and the engine quarantines
   *    it line by line, leaving story 19.3's `error` indicator lit on day one for every M1 user
   *    with two healthy Macs.
   *    **THE COROLLARY IS OWED AND IS REPORTED, NOT PAPERED OVER:** a Mac that does NOT hold that
   *    `board.json` — a genuinely new device paired in, which ADR 002 §6.3 step 8 says "pulls from
   *    seq 0" — receives nothing of the pre-space board through the op stream. Pairing (or the
   *    backup file, ADR 002 §7.2) has to hand the board over. See E5's report.
   *
   * @param {{limit?:number, space?:string|null}} [opts] `space` defaults to the PERSONAL space,
   *        which is what every pre-existing caller means. `familyOutbox()` passes the `fsp_…`;
   *        the filters below are identical for both and are not personal-space facts.
   * @returns {Array<{op:Object, seq:null, park:null}>} in the log's own arrival order
   */
  outbox({ limit = Infinity, space } = {}) {
    const sp = space === undefined ? this._personalSpaceId : space;
    if (sp === null || sp === undefined) return [];
    const out = [];
    for (const line of this._log.lines()) {
      if (out.length >= limit) break;
      if (line.seq !== null && line.seq !== undefined) continue;
      if (line.park !== null && line.park !== undefined) continue;
      const op = line.op;
      if (!op || op.dev !== this._device) continue;
      if (op.space !== sp) continue;
      if (isGenesisStamp(op.ts)) continue;
      out.push(line);
    }
    return out;
  }

  /** How many lines the outbox holds. Cheap enough to call on every status tick. */
  outboxSize() { return this.outbox().length; }

  /**
   * The server has these ops (ADR 003 §3.1 — `accepted` and `duplicate` mean the same thing).
   *
   * It does NOT persist by itself. The seq lands in `checkpoint().seqs`, which `persistNow`
   * writes below the commit point, so an ack lost to a crash costs one idempotent re-push.
   * @param {Array<{oid:string, seq:string|number|bigint}>} entries
   * @returns {number} how many lines actually moved
   */
  ackPushed(entries) {
    let n = 0;
    for (const e of Array.isArray(entries) ? entries : []) {
      if (!e || typeof e.oid !== 'string') continue;
      try { if (this._log.ack(e.oid, e.seq)) n += 1; }
      catch (err) { this._warn(`push ack refused for ${e.oid}: ${err.name}: ${err.message}`); }
    }
    if (n) {
      this.schedulePersist();
      // 16.6 / ADR 004 §6 — THE ACK IS WHAT MAKES THE BADGE TRUE, so it has to redraw.
      //
      // `exposure` is derived from what carries a server `seq`, and this method is the only place
      // a `seq` ever appears for a local op. Without the re-projection the badge stayed HOLLOW
      // until the next unrelated edit — the entry was published, the family could see it, and my
      // own board went on saying "not synced yet" for as long as I did not touch anything. That
      // is the badge lagging in the SAFE direction, which is why it was invisible, and it is
      // still wrong: 19.3 says a sync state that has resolved must stop being shown.
      //
      // Only when a family space exists, because only then is there an exposure to be wrong about.
      if (this._familySpaceId !== null) {
        this._project();
        this.emit('sync');
      }
    }
    return n;
  }

  /** The transport cursor for a space (ADR 003 §3.3), as a decimal string, or `'0'`. */
  cursor(space) {
    const c = this._log.cursor(space ?? this._personalSpaceId);
    return c === null ? '0' : String(c);
  }

  /**
   * Advance the transport cursor — **W1 (ADR 006 §9.1), and this method IS the assertion.**
   *
   *   > The persisted cursor may never be ahead of `board.json`. Cursors ride in
   *   > `checkpoint().cursors`, which is written AFTER `board.json` in the same persist (R5), so
   *   > this holds automatically — and it must be asserted, so that a future sync engine cannot
   *   > break it by persisting a cursor through some other file.
   *
   * The assertion is structural rather than a runtime check: there is exactly one way to move a
   * cursor and it writes into the LOG, whose only route to disk is `_persistOps`, which
   * `persistNow` runs strictly after the `saveBoardText` commit point. A sync engine that wanted
   * to persist a cursor "through some other file" would have to add a storage call, and
   * `tests/tier1/sync-personal.test.js` asserts that a crash between the two leaves the cursor
   * behind the board and never ahead of it.
   *
   * `oplog.setCursor` never moves backwards, which is the other half of §3.3: a crash mid-pull
   * re-fetches rather than skips.
   * @returns {boolean} whether it advanced
   */
  noteCursor(space, seq) {
    const sp = space ?? this._personalSpaceId;
    if (sp === null) throw new Error('store.noteCursor: no personal space — call usePersonalSpace() first');
    let moved = false;
    try { moved = this._log.setCursor(sp, seq); }
    catch (e) { this._warn(`cursor refused for ${sp}: ${e.name}: ${e.message}`); return false; }
    if (moved) this.schedulePersist();
    return moved;
  }

  /**
   * Install the real publication port (ADR 004 §3) — **the WP-3 obligation's landing site.**
   *
   * `replaceAll()` hands `plan.retractions` to `this.publisher` at the moment of the import, and
   * that moment is usually BEFORE any sync engine exists: `nullPublisher()` therefore RECORDS
   * rather than discards (see its docblock). Anything less than carrying that record across here
   * would mean an import performed in solo mode leaves entries live on the family's boards for
   * ever (story 16.5, RECHECK-40-4) — the list is computable only by `planReplaceAll`, and
   * nothing in `core/` runs after the transaction lands, so if it is dropped here it cannot be
   * recovered anywhere.
   * @param {Object} pub
   */
  setPublisher(pub) {
    if (!pub || typeof pub !== 'object'
      || typeof pub.retract !== 'function' || typeof pub.askToReshare !== 'function') {
      throw new TypeError('store.setPublisher: a publisher must implement retract() and askToReshare()');
    }
    const old = this.publisher;
    this.publisher = pub;
    const carried = { retractions: 0, reshares: 0 };
    if (old && Array.isArray(old.pendingRetractions) && old.pendingRetractions.length) {
      carried.retractions = old.pendingRetractions.length;
      pub.retract(old.pendingRetractions.slice());
      old.pendingRetractions.length = 0;
    }
    if (old && Array.isArray(old.pendingReshares) && old.pendingReshares.length) {
      carried.reshares = old.pendingReshares.length;
      pub.askToReshare(old.pendingReshares.slice());
      old.pendingReshares.length = 0;
    }
    return carried;
  }

  /**
   * `ctx.myDevices` — ADR 001 §4.0's "the LOCAL device set", SUPPLIED rather than defaulted.
   *
   * Finding A3-H4 item (3): "`ctx.myDevices` actually supplied — it is optional today and the
   * check degrades to `act === me`. Once identity is durable, (3) is *derived*
   * (`attestationOf` filtered by `memberId`), needs no new plumbing, and removes the
   * degradation."
   *
   * **"ONCE IDENTITY IS DURABLE" IS THE WHOLE CONDITION, AND IT IS LOAD-BEARING — `null` HERE
   * IS AN ANSWER, NOT AN OMISSION.** §4.0 sanctions the degradation *"where the caller does not
   * supply it"*, and in solo mode this caller genuinely cannot: `_device` is minted per process
   * (see the constructor), so `{_device}` is a set that is DIFFERENT ON EVERY LAUNCH. Supplying
   * it would not be "the local device set", it would be an assertion — "I have exactly one
   * device, and it is whichever uuid this process happened to draw" — that the store has no
   * grounds for and that would refuse ops the same Mac wrote yesterday. Solo mode therefore
   * keeps §4.0's degradation, deliberately and reportably (`diagnostics().identity.durable`),
   * and the moment `useIdentity()` lands the degradation is gone for good.
   *
   * Three sources, unioned, in order of how much they cost to be wrong about:
   *
   *   1. `_device` — this Mac. Mine by construction; nothing else can be said about it.
   *   2. `_peerDevices` — my member's other devices as PAIRING established them (ADR 002 §6).
   *      This is the source §4.0 actually names, and it is the only one that exists for two Macs
   *      of one person with no Familienkreis: `member.set` is a FAMILY-space op kind
   *      (`core/ops.js` OP_KINDS), so a personal-only fleet has nowhere to write a `dev.*`
   *      register and source 3 below is empty for it. Reported — see E5's notes.
   *   3. every `deviceId` the fold itself attests to `me`, i.e. `attestationOf` filtered by
   *      member. This is the family-space source, and it is why the fold below runs twice.
   *
   * @param {Object} [attested] an `AuthzResult`, when one has already been computed
   * @returns {Set<string>|null} null in solo mode — see above
   */
  _myDevices(attested) {
    if (!this._identity) return null;
    const set = new Set([this._device, ...this._peerDevices]);
    const fromLog = attested && attested.attestedDevices instanceof Map
      ? attested.attestedDevices.get(this._me)
      : null;
    if (fromLog) for (const d of fromLog) set.add(d);
    return set;
  }

  /**
   * The ctx every authorization fold in this file is run with. One function, so the fold that
   * LEARNS the device set and the fold that GATES on it cannot drift apart.
   * @param {{myDevices?:Set<string>}} [extra]
   */
  _authzCtx(extra = {}) {
    const ctx = { me: this._me };
    if (this._attestOpen) ctx.attestOpen = this._attestOpen;
    if (extra.myDevices) ctx.myDevices = extra.myDevices;
    return ctx;
  }

  /**
   * THE SPINE (ADR 006 R1). `board.json` is migrated into an op set on EVERY launch, whether a
   * log exists or not. There is no predicate here any more; the path that used to be rare is the
   * only path, which is why it is the path every test exercises.
   *
   * `stampBase` (§9.4): a board that has NEVER had a log is migrated at `GENESIS(i)`, a pure
   * function of the file, so two Macs migrating the same `board.json` agree byte for byte. A
   * board that HAS a lineage but whose log was refused is a RE-DERIVATION, not a migration: its
   * values are the newest thing this device knows, and stamping them at the bottom of the order
   * would make them lose every contest they should win (R4-7b). Those get fresh stamps, minted in
   * one sequence in the migration's own order, so the run is still deterministic.
   *
   * `migrateV1` does not take a `stampBase` (`core/migrate1to2.js` belongs to another owner this
   * round), so the re-stamp is applied here, on the way into the log. Ops are frozen by
   * construction, hence the copy.
   */
  _buildSpine(board, { restamp }) {
    const spine = createOpLog({ now: () => Date.now() });
    // `personalSpaceId` — LZP-502. `migrateV1` has taken it since WP-3 (ADR 001 §8.2: "omitted in
    // solo mode … the ops carry the 'personal' placeholder and are rewritten the first time a
    // personal space is created") and nothing passed it, so the whole spine — i.e. THE WHOLE
    // BOARD — was authored into the placeholder even on a store that had adopted a space. Every
    // one of those ops is unsealable (ADR 002 §5.2.2 check 2 is mirrored in `sealOp`), so the
    // outbox would have offered the entire board and the engine would have refused it op by op.
    // Passing it here is also what makes ADR 006 §9.3's re-join work at all.
    const r = migrateV1(board, {
      memberId: this._me,
      deviceId: this._device,
      acceptLossy: true,
      ...(this._personalSpaceId ? { personalSpaceId: this._personalSpaceId } : {}),
    });
    this._warnAll(r.warnings);
    // A RE-STAMP RE-MINTS THE opId TOO, AND THAT IS NOT TIDINESS (LZP-502).
    //
    // `migrateV1` is pure and deterministic: two Macs migrating the same `board.json` produce
    // byte-identical ops INCLUDING their opIds, which is what makes a second Mac's push a clean
    // `duplicate` instead of a conflict. A re-stamp changes the BODY (`ts`, and with it the
    // device short) while leaving the id — and `@@unique([spaceId, opId])` plus the relay's
    // byte comparison then answer `409 forked_op_id` (ADR 003 §3.1) to a push that is not a fork
    // at all. Measured: two Macs over one copied board, and the second one's whole board is
    // refused. Keeping the id was the bug; a re-derivation is a NEW authorship, so it gets new
    // ids, and the two sets merge by entity key exactly as any two devices' ops do.
    for (const op of r.ops) {
      spine.append(restamp ? { ...op, id: newOpId(), ts: this._clock.tick() } : op);
    }
    return spine;
  }

  async init() {
    const file = await storage.loadBoardFile();
    const { text, raw } = file;
    const { board0, binding } = splitBoardEnvelope(raw);
    const boardFile = classifyBoardFile(file, board0);
    const board = migrate(board0 ?? defaultState());

    const checkpoint = await storage.loadCheckpoint();
    const tail = await storage.loadOps();
    const hasLog = !!checkpoint || tail.length > 0;

    this.clearWarnings();
    this.quarantine = null;
    this.bootFailure = null;
    // The ledger is re-read from the checkpoint below, once it is known whether that checkpoint
    // was believed. Emptying it here rather than there means a refused log cannot leave last
    // session's refusals standing as if they were this board's.
    this.syncRefusals = [];
    this.syncChain = null;
    this._e52Warned = false;
    this._toldAboutReadOnly = false;
    this._adopted = null;
    this._recovered = false;
    this._recoveredFrom = null;
    this._lineageId = binding ? binding.lineageId : null;
    this._gen = binding ? binding.gen : 0;
    // The tail on disk is committed BY DEFINITION — it is what was just read off it — so nothing
    // below re-appends a line that is already there (R5-4). A tail entry is an op, a `{op, seq}`
    // pair or a `lines()` record, exactly as `oplog.load()` accepts them.
    this._tailLines = tail.length;
    this._opsCommitted = new Set(tail.map((l) => tailLineKey(l && typeof l === 'object' && l.op ? l.op : l)));
    // ADR 001 §7.2's SECOND compaction trigger — "…or on launch when it exceeds 2 MB" — armed
    // here and consumed by the first `_persistOps` of the session. See `TAIL_COMPACT_BYTES` for
    // why the byte bound is independent of the line bound and why it is measured only here.
    // A tail that cannot be measured (a cyclic line — impossible off disk, cheap to survive) is
    // treated as not over the bound, because a compaction is an optimisation and a launch is not
    // the place to throw for one.
    this._tailOverBytes = tailBytes(tail) > TAIL_COMPACT_BYTES;

    // 11.5's safety net, loaded BEFORE the branch that needs it. `snaps` is re-used below rather
    // than read twice, so `migrateSnapshots`' warnings are still reported exactly once.
    const snaps = migrateSnapshots(await storage.loadSnapshots());

    if (boardFile.kind === 'ok') {
      // ── R1. THE SPINE. Unconditional, every launch, no predicate. ──────────────
      //
      // `restamp: !!binding` IS UNCHANGED BY LZP-502, and the reason is worth writing down
      // because the obvious "fix" for a sync engine is to widen it and it is wrong.
      //
      //   ADR 001 §8.1  migration stamps carry the ALL-ZEROS device short by construction, so two
      //                 Macs migrating the same `board.json` agree byte for byte.
      //   ADR 002 §5.2.2 check 4  `devOf(op.ts) === env.dv`, mirrored inside `sealOp`, and NOT
      //                 weakenable: `core/authz.js` reads `devOf(op.ts)` as proof that the writer
      //                 holds that short's signing key (FINDINGS §4.5 / I-3).
      //
      // Together they say **a migrated op can never be sealed** — and the first reading of that
      // is "so re-stamp the spine once a space exists". Measured, that reading costs more than it
      // buys: the two Macs' migrated register stamps then differ for every cell of the shared
      // prehistory (ADR 004 §4.3 makes those decorations load-bearing the day a family space
      // exists), and it re-derives the whole board on any launch that has not yet persisted.
      //
      // The correct reading is §8.1's own: **the spine is shared PREHISTORY, not traffic.** It is
      // a pure function of `board.json`, so every Mac that holds that file reproduces it exactly,
      // and it never has to travel. `store.outbox()` is where that is enforced — see the GENESIS
      // filter there — and the corollary (a Mac that does NOT hold the file gets nothing of the
      // pre-space board through the op stream) is reported, not papered over.
      const spine = this._buildSpine(board, { restamp: !!binding });
      // ── R2. ONE EQUALITY. ─────────────────────────────────────────────────────
      if (!hasLog) {
        this._log = spine;                     // solo: nothing to adopt, nothing to refuse
        // A DIFFERENT LOG: the withdrawal cache and its arming bit describe the old one.
        this._authz = null; this._authzArmed = true;
      } else {
        const verdict = adoptable(binding, checkpoint, text);
        if (!verdict.ok) {
          this._log = spine;
          // A DIFFERENT LOG: the withdrawal cache and its arming bit describe the old one.
          this._authz = null; this._authzArmed = true;
          this._quarantineLog(verdict.reason, verdict.detail, checkpoint, tail);
        } else {
          this._log = this._adoptHistory(spine, checkpoint, tail, verdict);
          // A DIFFERENT LOG: the withdrawal cache and its arming bit describe the old one.
          this._authz = null; this._authzArmed = true;
        }
      }
    } else if (boardFile.kind === 'absent' && hasLog) {
      // R7 — an absent board file is not a disagreement. §5.5. THE ONLY BRANCH THAT ADOPTS A LOG
      // IT CANNOT TIE TO A BOARD, and it is reachable only when the file is genuinely gone.
      //
      // `snaps.snapshots` is passed because R7 CAN FAIL, and §5.6's answer to a failed recovery
      // is the same file as its answer to an unreadable board (R6-6a/b). This is the only line
      // of `init()` this pass changed.
      this._log = this._recoverFromLog(checkpoint, tail, snaps.snapshots);
      // A DIFFERENT LOG: the withdrawal cache and its arming bit describe the old one.
      this._authz = null; this._authzArmed = true;
    } else if (boardFile.kind === 'absent') {
      board.settings.seenFirstRun = false;      // a fresh install. Story 15.1, INV-12.
      this._log = this._buildSpine(board, { restamp: false });
      // A DIFFERENT LOG: the withdrawal cache and its arming bit describe the old one.
      this._authz = null; this._authzArmed = true;
    } else {
      // The board file EXISTS and this app could not read it (R5-3a/b/c).
      this._log = this._bootUnreadableBoard(boardFile, checkpoint, tail, snaps.snapshots);
      // A DIFFERENT LOG: the withdrawal cache and its arming bit describe the old one.
      this._authz = null; this._authzArmed = true;
    }
    // The log is durable only once a space exists (ADR 001 §9/§11, ADR 006 §9.5). LZP-502 turns
    // this on — and MUST consult `store.quarantine` first, or it overwrites the very bytes the
    // quarantine exists to preserve. So the decision is DEFERRED to the end of `init()`, after
    // `_sequesterQuarantine()` has (or has not) renamed those bytes out of the way; until then
    // this launch is treated as solo, which is the fail-safe direction.
    this._opsPersisted = false;
    // ADR 006 §9.3 / W2 — A QUARANTINE AT FLEET SCALE IS A RE-JOIN, NOT A SILENT RESET.
    // `this._log` is the spine here, so every op in it is unacknowledged and the outbox is the
    // whole personal projection: the republication W2 asks for happens by construction, and the
    // §9.4 `'now'` stamps it needs are the `restamp: !!binding` above. What was missing was the
    // "visible, reported" half — this flag, and `diagnostics().sync.rejoin`.
    this._rejoined = this._syncArmed && !!this.quarantine && !!binding;

    // The registers were replaced wholesale under stacks that survive `init()` by design (v1
    // fact, pinned at store-persistence.test.js:271). Retire their DEV shadow expectations,
    // which describe a board that is no longer on screen; the stacks themselves are untouched.
    this._stacks.remoteApplied();

    // Finding 2 / I-2 — NEVER a white screen. `_project` can refuse, from a poisoned checkpoint
    // and from a poisoned `board.json` alike; both land here and both boot.
    this._projectSafe();

    this.snapshots = snaps.snapshots;
    this._warnAll(snaps.warnings);
    this._lastSnapshotDay = this.snapshots[0]?.day ?? null;
    // What was on disk when the app opened. This — not the edited state — is
    // what the day's snapshot has to preserve.
    this._persisted = structuredClone(this.state);
    // I-6 — refuse the log ONCE. Strictly after the board is on screen, and it can only fail
    // safely: a move that does not happen costs one repeated warning per launch and nothing else.
    //
    // NEVER ON A FAILED BOOT. A read-only session's promise is that every file is exactly as it
    // was, and a move-aside is a write. It is also precisely the wrong moment to rename the log:
    // on the `board-unreadable` path it may be the freshest record of the board that exists, and
    // the user has just been told to send it in for a rescue (R5-3b's "the evidence is renamed
    // away one launch after the board is").
    if (this.quarantine && !this.bootFailure) await this._sequesterQuarantine();
    // ADR 006 §9.5, decided HERE and nowhere else — see `_logMayBeWritten()`. It is deliberately
    // the LAST thing before `ready`, because the quarantine verdict AND the move-aside outcome
    // are both inputs and neither is known any earlier.
    this._opsPersisted = this._logMayBeWritten();
    if (this._syncArmed && !this._opsPersisted) {
      this._warn(
        'sync is configured but this launch will not write the op log: '
        + (this.bootFailure ? 'the session is read-only.' : 'a quarantined log is still on disk.')
        + ' Local edits are kept in board.json and will be published once the next launch can '
        + 'write history.');
    }
    if (this._rejoined) {
      this._warn(
        'the history beside this board was refused, so this device RE-JOINS: its whole board is '
        + 'republished at fresh stamps (ADR 006 §9.3). Nothing is lost and nothing on your peers '
        + 'is deleted — the two boards merge.');
    }
    // ── L-1 · the refusal ledger, read back off the checkpoint that was actually believed ──────
    // `this.quarantine` is the whole gate: a log this launch refused takes its ledger with it.
    if (!this.quarantine) this._restoreSyncLedger(checkpoint);
    // ── L-3 · THE PARK HAS A REAPER, AND THIS IS ITS FIRST RUN ────────────────────────────────
    //
    // `unparkAttested()` re-judges a line held for a missing device attestation, and before this
    // it was called from exactly one place in the product — `family/mount.js`, on the adoption of
    // a NEW peer. So a Mac that learned about its sibling on Monday and quit still held Monday's
    // op on Tuesday, and on every launch after that, for ever: the cursor had long since been
    // released past it (ADR 003 §8.2 bounds the hold), which makes the parked line the ONLY copy
    // this Mac can reach and nothing was looking at it.
    //
    // HERE, because here is where the two preconditions are first both true: `useIdentity()` has
    // already filled `_peerDevices` (it must run before `init()`, and warns if it does not), and
    // the log has just been loaded. It is a no-op with nothing parked and costs one `parkedOps()`
    // call otherwise. The engine calls it again on every pull — see `sync/personal.js` — which is
    // what covers the pairing that completes mid-session.
    try { this.unparkAttested(); } catch (e) {
      this._warn(`held ops could not be re-judged on launch (${e.name}: ${e.message}); they stay parked`);
    }
    this.ready = true;
    this.emit('init');
  }

  /**
   * ADOPT THE LOG'S HISTORY — and nothing else (ADR 006 §5.3).
   *
   * Three things happen here in an order that is load-bearing:
   *
   *  1. The log is loaded. A3-H1 stays closed: anything thrown on the way in is a quarantine,
   *     never a dead app.
   *  2. THE CLOCK IS ADVANCED PAST EVERY STAMP THE LOG CARRIES, BEFORE ANYTHING IS MINTED. This
   *     is the one silent failure mode in the whole design (ADR 006 §12.6): mint below a
   *     register's stamp and LWW quietly keeps the LOG's value, R4-4a is back, and nothing
   *     anywhere says so. Deleting this loop reddens INV-3 and nothing else.
   *  3. The board's own spine is diffed onto the history, so `board.json` wins every
   *     disagreement — with a FRESH stamp, which is what makes it win against a peer too.
   *
   * Then the post-condition (R4): if the reconciled log does not assert exactly what the board
   * asserts, for any reason at all, the log is quarantined and the board is used alone. Every
   * conceivable failure of the reconciler therefore degrades to "history lost, content kept".
   * It may NOT be removed as redundant (§12.7).
   *
   * @returns {Object} the log to run on — the history when it was adopted, the spine when it was not
   */
  _adoptHistory(spine, checkpoint, tail, verdict) {
    const history = createOpLog({ now: () => Date.now() });
    try {
      history.load({ checkpoint, tail });
    } catch (e) {
      this._quarantineLog('unreadable-log', `${e.name}: ${e.message}`, checkpoint, tail);
      return spine;
    }
    // ── THE PRECONDITION FOR STEP 2, CHECKED BEFORE STEP 2 IS ATTEMPTED (R5-2e) ─────────────
    // §12.6 ("mint above every stamp the log carries") and ADR 001 §1.3/§7.4 ("a stamp more than
    // 24 h ahead of local wall time is neither adopted by the clock nor applied by the log") are
    // both normative and, for a log stamped beyond the drift window, they contradict each other.
    // This is where that is decided, ONCE, by name — see `_clockSkew`.
    const skew = this._clockSkew(history, checkpoint);
    if (skew) {
      this._quarantineLog('clock-skew', skew, checkpoint, tail);
      return spine;
    }
    try {
      this._observeEveryStamp(history, checkpoint);
    } catch (e) {
      this._quarantineLog('unreadable-log', `the clock refused a stamp the log carries (${e.name}: ${e.message})`, checkpoint, tail);
      return spine;
    }

    let reconciled = 0;
    let mine;
    try {
      mine = this._projectionOf(spine);
      reconciled = this._reconcileOntoBoard(history, mine);
    } catch (e) {
      this._quarantineLog('reconcile-failed',
        `the log could not be reconciled onto board.json (${e.name}: ${e.message}); board.json was kept whole`,
        checkpoint, tail);
      return spine;
    }

    let theirs = null;
    try { theirs = this._projectionOf(history); } catch { theirs = null; }
    if (theirs === null || !sameV1Content(theirs, mine)) {
      this._quarantineLog('reconcile-failed',
        `after reconciliation ${postConditionDetail(theirs, mine)}; board.json was kept whole`,
        checkpoint, tail);
      return spine;
    }

    if (reconciled) {
      this._warn(`op log: reconciled ${reconciled} change${reconciled === 1 ? '' : 's'} board.json carried that the `
        + 'log did not (expected after a crash between the two writes; board.json is the truth and it won)');
    }
    this._adopted = { lineageId: verdict.detail, exact: verdict.exact === true, reconciled };
    return history;
  }

  /**
   * IS THIS MACHINE'S CLOCK THE REASON THE LOG CANNOT BE ADOPTED? (R5-2e)
   *
   * TWO NORMATIVE RULES MEET HERE AND ONLY ONE OF THEM CAN BE OBEYED:
   *
   *   ADR 006 §12.6  the clock is advanced past every stamp in the loaded log BEFORE any op is
   *                  minted, or the reconciliation silently loses to LWW and R4-4a is back.
   *   ADR 001 §1.3   `clock.observe` DECLINES a stamp more than `MAX_FUTURE_DRIFT_MS` (24 h)
   *        + §7.4    ahead of local wall time, and `oplog.append` PARKS an op stamped that far
   *                  ahead. A parked op changes no register, so a reconciliation minted up there
   *                  would not be applied even if the clock had agreed to mint it.
   *
   * For a log whose stamps are inside the drift window there is no conflict and nothing happens
   * here — that is the ordinary path, including a skew of many hours (the non-vacuity control).
   * Beyond it the two rules are irreconcilable, and the resolution is NOT to mint below the log
   * and hope: it is to say so. §12.6 is a PRECONDITION FOR ADOPTION, not an instruction to try.
   * ADR 006 §7 gains the `clock-skew` reason and §12.6 is amended to say exactly this.
   *
   * WHY IT IS A SEPARATE REASON AND NOT `reconcile-failed`. `reconcile-failed` is true and
   * useless: it names the post-condition, never the cause, and the cause here is a fact about
   * the MACHINE that the user can act on (a dead CMOS battery, a VM resumed from a snapshot, a
   * botched NTP step, a manual date change) and that the store cannot repair. It is also the one
   * quarantine reason that is EXPECTED TO STOP BEING TRUE: the wall clock passes, or is fixed,
   * and the same log becomes adoptable again. So `_sequesterQuarantine` does not move it aside —
   * a refusal that is deferred must leave the files where the next launch will look for them.
   *
   * ───────────────────────────────────────────────────────────────────────────────────────────
   * THE INPUT DOMAIN — WHICH STAMPS MAY RAISE THIS CEILING (R6-4, tests/helpers/domains.js D2×D3)
   *
   * Round 5 wrote this function against a set of BRANCHES ("the registers, the horizon, the
   * lines") and round 6 walked in through the one member of the input domain nobody had written
   * down. So the domain is written down here, as a table over WHAT A STAMP DECIDES, and the code
   * below is nothing but this table:
   *
   *   stamp carried by …            decides state?   may block a mint?   counted here?
   *   ────────────────────────────  ──────────────   ─────────────────   ─────────────
   *   a register cell (checkpoint    YES              YES — LWW compares  YES
   *     or tail, it is one map)                       a mint against it
   *   `checkpoint.horizon`           YES — it is the  YES — `compact()`   YES
   *                                  fold boundary    and `append` both
   *                                                   refuse below it
   *   a LIVE line (`ops()`)          YES — it is in   YES                 YES
   *                                  the fold
   *   a PARKED line                  NO  — ADR 001    NO                  **NO**
   *     (`future`, `epoch`,          §7.4: parked is
   *      `unknownKind`, `version`,   retained AND NOT
   *      `unknownSpace`,             APPLIED. It is in
   *      `unknownField`)             no register at all.
   *   a REJECTED op                  NO — never a line, never reachable from here.
   *
   * §12.6's precondition is "mint ABOVE every stamp the log carries", and round 5 read `carries`
   * as `holds a line for`. It is not: it is a statement about the stamps a MINT WILL BE COMPARED
   * AGAINST, and a parked op is compared against nothing. THERE IS NOTHING FOR A MINT TO BE
   * "ABOVE" WHEN THE OP IS IN NO REGISTER. Counting a parked stamp here turned §7.4's shock
   * absorber — the mechanism whose whole job is to make ONE peer's bad clock cost ONE op — into a
   * whole-history quarantine that repeats every launch until the stamp passes (R6-4a/b), and,
   * because the park is decided before the authorisation gate, one that a stranger could trigger
   * remotely with a date (R6-4c; the ordering half of that is fixed in `applyRemote`).
   *
   * `liveOnly: true` is the explicit spelling of `ops()`' default and it is spelled explicitly
   * BECAUSE the default is what was wrong: a reader who sees `ops()` cannot tell whether the
   * author decided about parked lines or never thought about them.
   *
   * WHAT REMAINS REACHABLE, and it is the case this function was written for: a stamp that is in
   * a register or is the horizon and is more than 24 h ahead can only have got there by being
   * ADMITTED, i.e. by having been inside the window when it was written. So it means the local
   * clock has moved BACKWARDS since — a corrected NTP step, a restored VM, a hand-set date. The
   * detail below says that and no longer accuses the Mac of a fault it may not have.
   *
   * @returns {?string} the detail for the quarantine, or null when the log is inside the window
   */
  _clockSkew(log, checkpoint) {
    let max = isStamp(checkpoint?.horizon) ? checkpoint.horizon : null;
    const consider = (s) => { if (isStamp(s) && (max === null || cmp(s, max) > 0)) max = s; };
    for (const cells of log.registers().values()) {
      if (!cells || typeof cells.values !== 'function') continue;
      for (const cell of cells.values()) consider(cell?.stamp);
    }
    // LIVE LINES ONLY. See the table above: a parked line is in no register, so no mint has to
    // be above it. Changing this to `{includeParked:true}` is round 6's mutant F2 in reverse and
    // reddens R6-4a/R6-4b/R6-4c and D2-s12/s14/s16/s18 × {own,foreign}.
    for (const op of log.ops({ liveOnly: true })) consider(op?.ts);
    if (max === null) return null;
    const now = Date.now();
    const ahead = msOf(max) - now;
    if (ahead <= MAX_FUTURE_DRIFT_MS) return null;
    const hours = Math.round(ahead / 3600000);
    return 'THE CLOCK ON THIS MAC IS BEHIND THIS BOARD\'S OWN HISTORY, and the history is not the '
      + `problem: a value this board is showing was written at ${new Date(msOf(max)).toISOString()}, `
      + `which is ${hours} hours ahead of this Mac's clock (${new Date(now).toISOString()}) — more `
      + `than the ${MAX_FUTURE_DRIFT_MS / 3600000} hours ADR 001 §1.3 allows, so no op minted now `
      + 'could be applied above it. A stamp only gets into a register by being inside that window '
      + 'when it was written, so the clock has moved backwards since (a corrected time server, a '
      + 'restored virtual machine, a hand-set date). The log is this board\'s own and it is NOT '
      + 'being discarded: set this Mac\'s date and time correctly (or wait until the date passes) '
      + 'and the history is adopted again on the next launch.';
  }

  /**
   * Every stamp in a loaded log, into the clock. See `_adoptHistory` step 2 — this is the whole
   * of ADR 006 §12 rule 6 and it is the reason `_reconcileOntoBoard` can be a plain diff.
   * Its precondition is `_clockSkew`, which has already answered null when this runs.
   *
   * IT WALKS A WIDER DOMAIN THAN `_clockSkew` ON PURPOSE, and the difference is not an oversight.
   * `_clockSkew` asks "can a mint be placed above everything that decides state?", so a parked
   * line — which decides none — must not be counted. This asks "is the clock at least as far
   * along as everything the log has seen?", where a parked line is free to be counted because
   * `clock.observe` DECLINES anything more than `MAX_FUTURE_DRIFT_MS` ahead on its own
   * (`core/stamp.js:167`) and a parked line INSIDE the window (`unknownKind`, `version`,
   * `unknownSpace`, `unknownField`, `epoch` — the five park reasons that are not `future`) is one
   * this build may promote on the next launch after an update, at which point it does decide
   * state. Observing it early costs nothing and keeps the clock monotone across that promotion.
   */
  _observeEveryStamp(log, checkpoint) {
    if (isStamp(checkpoint?.horizon)) this._clock.observe(checkpoint.horizon);
    for (const cells of log.registers().values()) {
      if (!cells || typeof cells.values !== 'function') continue;
      for (const cell of cells.values()) if (isStamp(cell?.stamp)) this._clock.observe(cell.stamp);
    }
    for (const op of log.ops({ includeParked: true })) if (isStamp(op?.ts)) this._clock.observe(op.ts);
  }

  /** The v1-shaped projection of an arbitrary log. `_project`'s materialize, without the install. */
  _projectionOf(log) {
    const full = materialize(log.registers(), {
      me: this._me,
      familySpaceId: this._familySpaceId,
      members: new Map(),
      currentMembers: new Set([this._me]),
      hiddenMembers: new Set(),
      defaultSettings: defaultState().settings,
    });
    return this._familySpaceId ? full : stripV2Fields(full);
  }

  /**
   * MINT THE DIFFERENCE, AT FRESH STAMPS (ADR 006 R3 / §5.4).
   *
   * THE PRIMITIVE MATTERS AND IT IS EASY TO GET WRONG. `planReplaceAll` emits a `set` for EVERY
   * entry unconditionally (`replace.js:560`), so using it here would re-stamp every field and
   * reset every `_born` ON EVERY LAUNCH — R4-7b, permanently, on the happy path. The right
   * primitive is the one `_adopt()` is already made of: "the board object was edited outside a
   * transaction; mint ops for the difference." Swapping `_diff` for `planReplaceAll` here reddens
   * INV-4, and INV-4 is the most important row in the table.
   *
   * What falls out of a diff, none of it a special case:
   *   · exact match ⇒ ZERO ops; every stamp, `_born`, tombstone, parked op and cursor survives;
   *   · the board has an entry the log lacks ⇒ one `set` above the log's horizon (R4-4a's note);
   *   · the log has a live entry the board lacks ⇒ one `{_alive:false}` — an honoured deletion,
   *     which is also what makes a Time-Machine restore of an older `board.json` mean what the
   *     user meant by restoring it;
   *   · a FOREIGN TOMBSTONE CAN NEVER DELETE MY ENTRY: if the board carries the entity, the diff
   *     mints a live `set` above the tombstone. No rule about tombstones is needed.
   *
   * OWED AT WP-8 (recorded so it is not rediscovered): `_diff` produces no `retractions`. A
   * deletion discovered at init inside a family space owes the publisher one, the way
   * `planReplaceAll` does (`plan.retractions`, G-2). Unreachable until a family space can exist.
   *
   * @returns {number} how many ops the board contributed
   */
  _reconcileOntoBoard(history, mine) {
    const theirs = this._projectionOf(history);
    const ops = this._diffBetween(theirs, theirs.settings, mine, mine.settings, history);
    for (const op of ops) history.append(op);
    return ops.length;
  }

  /**
   * R7 — `board.json` is ABSENT, so there is no truth for a log to overrule and therefore no
   * disagreement to resolve (ADR 006 §5.5). The log is loaded as the truth and the boot is
   * REPORTED as a recovery. This is the one asymmetric branch in the design.
   *
   * ─────────────────────────────────────────────────────────────────────────────────────────
   * R6-6a/b — A RECOVERY CAN FAIL, AND FAILING IS NOT A FRESH INSTALL.
   *
   * The precondition above (`kind === 'absent'` and a log exists) is about the INPUT. It says
   * nothing about the OUTCOME, and round 5 wrote the branch as though the two were the same
   * thing. Enumerate the outcome instead — the input here is the pair `(checkpoint, tail)` and
   * it has exactly three ends:
   *
   *   R-a  `log.load()` THROWS.                       Nothing was recovered. The log is refused.
   *   R-b  it loads and asserts NO entity at all.     Nothing was recovered. The log is fine.
   *   R-c  it loads and asserts at least one entity.  A recovery — R7, said out loud, below.
   *
   * Only R-c is a recovery. R-a and R-b used to fall out of this function as an EMPTY, WRITABLE
   * board with `_recoveredFrom === null`, so no recovery was reported, nothing was read-only,
   * and the first autosave wrote the empty board over the slot the missing file used to occupy
   * — while `snapshots.json` sat in `store.snapshots`, loaded by `init()` and never consulted.
   * That is the exact morning ADR 006 §5.6 spends three paragraphs on, reached through §5.5
   * where none of §5.6's machinery exists. Both now go to `_bootRecoveryFailed`, which IS that
   * machinery. → D1-r3, D1-r4, D1-r5; `tests/attack/round6-recovery.test.js` R6-6a/R6-6b.
   *
   * The controls that say this is a narrowing and not a ban: D1-r1 (no board, NO log) is still a
   * fresh install, and D1-r2 / R6-6c (no board, a log with something in it) is still a recovery,
   * still writable, still said out loud.
   *
   * ITS PRECONDITION IS NOW THE ONE §5.5 ARGUES FOR. "Reaching it requires deleting board.json,
   * and anyone who can delete it can equally write it" was never the precondition the code had:
   * the precondition was that `JSON.parse` threw, and `[]`, `"a string"`, `null`, a truncated
   * object and a read that failed all took this branch (R5-3a/b/c). They now take
   * `_bootUnreadableBoard`. This one is entered only when the file is genuinely not there.
   *
   *   no board + no log  = a fresh install. Unchanged, story 15.1 untouched — not this path.
   *   no board + a log   = a recovery, said out loud.
   *
   * THE RECOVERED BOARD IS RE-BOUND TO THE LOG IT CAME OUT OF. Without this the board written by
   * the next persist carries no `_v2`, so the very next launch quarantines that same log as
   * `board-carries-no-lineage` and moves it aside — the log is destroyed one launch after it
   * became the only copy of the board. Adopting its lineage is not a new trust decision: its
   * content is already on screen, which is a strictly larger concession than its name.
   */
  _recoverFromLog(checkpoint, tail, snapshots) {
    const log = createOpLog({ now: () => Date.now() });
    try {
      log.load({ checkpoint, tail });
    } catch (e) {
      // ── R-a. THE ONLY OTHER RECORD OF THE BOARD WILL NOT LOAD. ────────────────────────────
      // Not a fresh install: a fresh install has no log. The board file is gone, the one thing
      // that might have rebuilt it is unusable, and `snapshots.json` — §5.6's own stated answer
      // — was already loaded two statements up in `init()`. It used to be dropped on the floor
      // here in favour of an empty, WRITABLE board that the first autosave then committed.
      this._quarantineLog('unreadable-log', `${e.name}: ${e.message}`, checkpoint, tail,
        'board.json was MISSING, so there was nothing to load unchanged;');
      return this._bootRecoveryFailed(
        `the op log beside it could not be loaded (${e.name}: ${e.message})`,
        checkpoint, tail, snapshots);
    }
    try { this._observeEveryStamp(log, checkpoint); } catch { /* a stamp the clock refuses is not fatal here */ }
    if (this._logAssertsNothing(log)) {
      // ── R-b. IT LOADED, AND IT ASSERTS NOTHING. ───────────────────────────────────────────
      // No note, no bar, no category, no scratchpad. A recovery that recovers no entry is
      // indistinguishable, on screen, from no recovery at all — and calling it one is how an
      // empty board acquires the authority of the file that is missing. The log is NOT
      // quarantined: nothing is wrong with it, it simply has nothing in it.
      return this._bootRecoveryFailed(
        'the op log beside it loaded cleanly and asserts no note, bar, category or scratchpad, '
        + 'so there is nothing in it to recover the board from',
        checkpoint, tail, snapshots);
    }
    const lzp = checkpoint && typeof checkpoint === 'object' ? checkpoint.lzp : null;
    if (lzp && typeof lzp === 'object' && isLineageId(lzp.lineageId)) {
      this._lineageId = lzp.lineageId;
      this._gen = Number.isInteger(lzp.gen) && lzp.gen >= 0 ? lzp.gen : 0;
    }
    this._recovered = true;
    this._recoveredFrom = { from: 'op-log', lineageId: this._lineageId, day: null, at: null };
    this._warn('board.json was MISSING and an op log was found beside it; the board was RECOVERED from '
      + 'the log. Nothing verified that this log belongs to this board — a log has no way to prove it '
      + '— so check the board is yours and complete BEFORE making a change. If it is not, quit without '
      + 'editing: the log is still on disk and so is snapshots.json.');
    return log;
  }

  /**
   * DOES THIS LOG ASSERT ANY BOARD CONTENT AT ALL? (R6-6b — the second half of a failed recovery.)
   *
   * Measured on the PROJECTION, because the projection is what a user would see, and counted
   * over the four things a v1 board can hold: notes, bars, categories, scratchpads. A log with
   * nothing in all four projects to a blank calendar, which is the same picture a store with no
   * files at all draws — and one of those two is a recovery and the other is a fresh install.
   *
   * THE `catch` IS NOT A SHRUG AND IT MUST STAY `false`. A projection that THROWS is a log with
   * something in it that this build cannot draw yet — a poisoned `startMonth`, say — and
   * `_projectSafe` repairs exactly that, one setting at a time, without discarding a single
   * entry. Answering `true` here would send a recoverable board to a read-only boot. The control
   * is `tests/attack/round4-failsafe-init.test.js` R4-8a: a bare `ops.jsonl` carrying one note
   * AND a `pref.set` that makes `materialize` refuse, which must still recover the note and must
   * still leave `bootFailure === null`.
   */
  _logAssertsNothing(log) {
    let p;
    try { p = this._projectionOf(log); } catch { return false; }
    const n = (a) => (Array.isArray(a) ? a.length : 0);
    const pads = p && p.scratchpads && typeof p.scratchpads === 'object'
      ? Object.keys(p.scratchpads).length
      : 0;
    return n(p?.notes) + n(p?.bars) + n(p?.categories) + pads === 0;
  }

  /**
   * WHAT A READ-ONLY BOOT PUTS ON SCREEN IN PLACE OF THE BOARD IT CANNOT SHOW.
   *
   * 11.5's snapshot ring is the safety net and this is the one place it is unwound, so that
   * `_recoveredFrom` and `bootFailure.shownInstead` are written in the same statement and can
   * never disagree about what the user is looking at. Both callers — the unreadable board file
   * (§5.6) and the failed recovery (§5.5's R-a/R-b) — need exactly this, and having two copies of
   * it is how one of them ends up not consulting `snapshots.json` at all, which is R6-6a.
   *
   * `bootFailure` MUST ALREADY BE SET when this is called: it writes `shownInstead` into it.
   *
   * @returns {{board: Object, snap: Object|null}}
   */
  _standIn(snapshots) {
    const snap = newestUsableSnapshot(snapshots);
    if (snap) {
      this._recoveredFrom = { from: 'snapshot', day: snap.day, at: snap.at ?? null, lineageId: null };
      this.bootFailure.shownInstead = { from: 'snapshot', day: snap.day, at: snap.at ?? null };
      return { board: migrate(structuredClone(snap.state)), snap };
    }
    // `seenFirstRun` is LEFT AT v1's VALUE (false ⇒ the first-run tour shows) deliberately.
    // Showing the tour over a disaster is wrong, but it is what v1 did with a corrupt
    // board.json and `tests/tier1/store-persistence.test.js:240` characterizes it by name
    // ("treated as a first run"). Re-baselining a v1 observable is the tier-1 owner's call,
    // not this pass's; the read-only guard and the warning are what actually protect the file.
    this._recoveredFrom = { from: 'none', day: null, at: null, lineageId: null };
    this.bootFailure.shownInstead = { from: 'none', day: null, at: null };
    return { board: migrate(defaultState()), snap: null };
  }

  /**
   * §5.5's R-a AND R-b — `board.json` IS GONE AND THE LOG BESIDE IT RECOVERED NOTHING (R6-6a/b).
   *
   * The inverse of R5-3, and the more likely failure once R5-3's caution is in place: the caution
   * refusing to recover is one bug, and the recovery quietly succeeding at nothing is the other.
   * Both end here, and the three things this does are §5.6's three things, for §5.6's reasons:
   *
   *  1. **`bootFailure` FIRST**, so the session is read-only before anything can write. The board
   *     file's slot is left exactly as it was found — which on this path means LEFT ABSENT, and
   *     that is the whole point: an empty board committed over a missing file is a board that
   *     was never recovered being made permanent, and every later launch agrees with it.
   *  2. **`snapshots.json` is consulted.** It was loaded by `init()` before the branch was taken
   *     and it is the only file left that has ever held this user's board. §8.2 names it as the
   *     answer for exactly this morning; R6-6a's measurement was that it sat in `store.snapshots`
   *     and no code path read it.
   *  3. **It is said out loud**, and what is said is true: the board file is missing, THIS IS NOT
   *     A FRESH INSTALL, and what is on screen is a snapshot (or nothing) rather than the board.
   *
   * The log is NOT quarantined here — R-a's caller has already quarantined it as `unreadable-log`
   * before calling, and R-b's log is not defective at all. And because `bootFailure` is set, the
   * `!this.bootFailure` gate at the end of `init()` means the refused log is NOT sequestered: a
   * read-only session's promise is that every file is exactly as it was, and on this path the log
   * may be the freshest record of the board that exists.
   *
   * HUMAN-FACING COPY (DE ships; EN twins), keyed off `bootFailure.reason === 'recovery-unusable'`:
   *   DE  „Die Datei board.json ist nicht vorhanden. Daneben liegt ein Journal, aber es lässt
   *       sich nicht dazu verwenden, den Kalender wiederherzustellen. Das ist KEINE Neu-
   *       installation. Angezeigt wird der letzte Schnappschuss vom <Tag>; diese Sitzung
   *       speichert nichts, damit nichts überschrieben wird."
   *   EN  "board.json is not there. There is an op log beside it, but it cannot be used to
   *       rebuild the calendar. This is NOT a fresh install. What you see is the snapshot from
   *       <day>; nothing will be saved this session, so nothing can be overwritten."
   *   …with no snapshot the second sentence becomes:
   *   DE  „Es gibt keinen Schnappschuss." / EN  "There is no snapshot."
   *
   * @param {string} why one clause naming which of R-a / R-b happened
   * @returns {Object} the spine to run on — built from a snapshot, or from nothing
   */
  _bootRecoveryFailed(why, checkpoint, tail, snapshots) {
    this.bootFailure = {
      at: new Date().toISOString(),
      reason: 'recovery-unusable',
      detail: `board.json is not there and ${why}`,
      shownInstead: null,
      logPresent: !!checkpoint || (Array.isArray(tail) && tail.length > 0),
    };
    const { board, snap } = this._standIn(snapshots);
    // `_recovered` stays FALSE. `diagnostics().source` would otherwise say 'recovery' about a
    // boot on which nothing was recovered — which is the very claim R6-6b was filed against.
    this._warn(
      `board.json IS NOT THERE and ${why}. THIS IS NOT A FRESH INSTALL: an op log was found `
      + 'beside the missing board file, so this device has had a board. Nothing will be written '
      + 'to board.json, ops.jsonl or checkpoint.json this session, so every file on disk is '
      + `exactly as it was. ${snap
        ? `What is on screen is the snapshot from ${snap.day} (Einstellungen › Schnappschüsse), `
          + 'which may be up to a day older than the board you last saw.'
        : 'There is no snapshot to fall back on either, so the calendar is empty — but it is empty '
          + 'because nothing could be read, not because there is nothing to read.'}`,
    );
    return this._buildSpine(board, { restamp: false });
  }

  /**
   * `board.json` EXISTS AND THIS APP COULD NOT READ IT (R5-3a/b/c) — the one path where the app
   * has genuinely lost the user's data, and therefore the one path where it must say so instead
   * of quietly presenting something else.
   *
   * Three facts decide everything here:
   *
   *  1. **The log is never the content.** ADR 006's gate is `cp.lzp.lineageId ===
   *     board._v2.lineageId`, and an unreadable board has no `_v2` to compare — so there is NO
   *     evidence that the log beside it is this board's. The old code inferred the opposite from
   *     the absence of evidence and handed the board to whatever log was lying there: R5-3b
   *     needed a legitimate pair for the attacker's OWN board plus one truncated byte. Salvaging
   *     a lineage out of the corrupt bytes would be a fourth heuristic on a question that has
   *     killed three (ADR 006 §2); the honest answer is that the tie cannot be made.
   *  2. **`snapshots.json` is §8.2's own stated answer**, and it was never even mentioned. It is
   *     this app's own file, in this app's own shape, and 11.5 exists for exactly this morning.
   *     It is at most a day old; the log might be fresher, but "fresher" is worth nothing when
   *     nothing ties it to this board.
   *  3. **Nothing is committed.** `bootFailure` puts the session read-only (`persistNow` and
   *     `flushSync` both return early), so `board.json` keeps its bytes for a rescue pass, the
   *     log keeps its bytes and is NOT moved aside, and the user gets to decide. The previous
   *     behaviour made a recoverable morning permanent on the first autosave.
   *
   * The board on screen is therefore a snapshot or nothing, it is labelled, and it cannot be
   * written back over the file it is standing in for.
   *
   * HUMAN-FACING COPY (DE is the shipping language; the settings pane owes this a real surface —
   * `bootFailure.reason` and `.detail` are the seam, see `subscribeWarnings`/`diagnostics`):
   *
   *   board-unparseable / board-not-a-board
   *     DE  „Die Datei board.json konnte nicht gelesen werden. Ihre Daten sind NICHT gelöscht —
   *         die Datei liegt unverändert an ihrem Platz. Angezeigt wird der letzte Schnappschuss
   *         vom <Tag>. Diese Sitzung speichert nichts, damit nichts überschrieben wird."
   *     EN  "board.json could not be read. Your data has NOT been deleted — the file is still
   *         where it was, untouched. What you see is the snapshot from <day>. Nothing will be
   *         saved this session, so nothing can be overwritten."
   *   board-read-failed
   *     DE  „Auf board.json konnte nicht zugegriffen werden (<Grund>). Das ist oft vorübergehend:
   *         App beenden und neu öffnen. Angezeigt wird der letzte Schnappschuss vom <Tag>; diese
   *         Sitzung speichert nichts."
   *     EN  "board.json could not be accessed (<reason>). This is often temporary — quit and
   *         reopen. What you see is the snapshot from <day>; nothing will be saved this session."
   *   …with no snapshot, the second sentence becomes:
   *     DE  „Es gibt keinen Schnappschuss. Der Kalender ist leer, bis die Datei gelesen werden
   *         kann." / EN  "There is no snapshot. The calendar is empty until the file can be read."
   *
   * @returns {Object} the spine to run on — built from a snapshot, or from nothing
   */
  _bootUnreadableBoard(boardFile, checkpoint, tail, snapshots) {
    // FIRST, before anything can be written. Read-only is the promise the rest of this rests on.
    this.bootFailure = {
      at: new Date().toISOString(),
      reason: `board-${boardFile.kind}`,     // board-unparseable | board-not-a-board | board-read-failed
      detail: boardFile.detail,
      /** For the settings pane: what the app could show instead. Filled in below. */
      shownInstead: null,
      logPresent: !!checkpoint || (Array.isArray(tail) && tail.length > 0),
    };

    if (this.bootFailure.logPresent) {
      this._quarantineLog(
        'board-unreadable',
        `${boardFile.detail}, so there is no _v2.lineageId to compare and nothing ties this log to `
        + 'this board; a log is never adopted on evidence it cannot supply',
        checkpoint, tail,
        'board.json was NOT replaced and this session writes nothing;',
      );
    }

    const { board, snap } = this._standIn(snapshots);
    this._recovered = true;

    this._warn(
      `board.json COULD NOT BE READ: ${boardFile.detail}. Your board has NOT been deleted — every file `
      + 'is exactly where it was and this session will NOT write to board.json, ops.jsonl or '
      + `checkpoint.json, so nothing can be overwritten. ${snap
        ? `What is on screen is the snapshot from ${snap.day} (Einstellungen › Schnappschüsse), which may be `
          + 'up to a day older than the board you last saw.'
        : 'There is no snapshot to fall back on, so the calendar is empty until board.json can be read.'}`
      + (this.bootFailure.logPresent
        ? ' An op log was found beside it and was NOT used: nothing ties a log to a board whose lineage '
          + 'cannot be read, and believing one would be how a stranger\'s board ends up on your screen.'
        : ''),
    );

    return this._buildSpine(board, { restamp: false });
  }

  /**
   * PROJECT, AND ALWAYS BOOT TO SOMETHING (Finding 2 · I-2 · A3-H1's real closure).
   *
   * A3-H1 wrapped `_log.load` and the consistency check. It did not wrap `_project()`, two
   * statements later — and `materialize` legitimately REFUSES a `settings` that would make
   * `layout.js:25` produce a NaN year and hang `holidays.js:51` forever. Refusing is right; where
   * the refusal landed was not: outside every door, `ready === false`, a white screen, with an
   * intact `board.json` on disk. Rows R4-5a-e reached it through `checkpoint.json`; I-2 reaches
   * the same throw site through `board.json` itself. One policy closes both.
   *
   * THE POLICY: the app always boots, and it always says what it refused.
   *
   *   1. project as it stands;
   *   2. failing that, reset the three settings the projection can actually refuse — `mode`,
   *      `startMonth`, `pageYears` — at a fresh stamp, and say so;
   *   3. failing that, reset every setting to the v1 defaults, and say so;
   *   4. failing that, open on an empty board AND REFUSE TO WRITE FOR THE REST OF THE SESSION.
   *      Step 4 changes no file: `persistNow` and `flushSync` both return early while
   *      `bootFailure` is set, so the board that could not be drawn is still the board on disk
   *      for a rescue pass — and for the next build.
   *
   * Steps 2 and 3 touch SETTINGS ONLY. No note, bar, category or scratchpad is ever discarded to
   * make a board renderable.
   */
  _projectSafe() {
    const d = defaultState().settings;
    const steps = [
      null,
      { what: 'the pinned start month (mode, startMonth, pageYears)', patch: { mode: d.mode, startMonth: d.startMonth, pageYears: d.pageYears } },
      { what: 'every setting', patch: this._defaultPrefs() },
    ];
    let last = null;
    for (const step of steps) {
      if (step) {
        this._warn(`the board could not be drawn with the settings it was loaded with `
          + `(${last.name}: ${last.message}) — ${step.what} was reset to the default. `
          + 'Nothing on the board itself was changed.');
        try { this._log.append(prefSet(this._ctx(), step.patch)); }
        catch (e) { this._warn(`settings repair refused by the log: ${e.name}: ${e.message}`); }
      }
      try {
        this.state = this._blankState();
        this._project({ settings: true });
        return true;
      } catch (e) {
        last = e;
      }
    }
    // Step 4. Nothing this store can build renders. Open, say so, and go read-only.
    //
    // FIRST REASON WINS (round 5 integration). `_bootUnreadableBoard` runs BEFORE this and may
    // already have set `bootFailure` to a `board-*` reason with the `shownInstead` the settings
    // pane keys its copy off. If the stand-in it chose — a `snapshots.json` entry — then also
    // refuses to project, the session is still read-only for the ORIGINAL reason: board.json
    // could not be READ. Overwriting `reason` with 'unprojectable' would tell the user their
    // board cannot be DRAWN, which is a different (and here unknowable) claim about a file
    // nothing has successfully parsed. The projection failure is recorded beside it instead, so
    // no diagnostic is lost. Session read-only-ness is unaffected either way: it is
    // `bootFailure` being truthy that gates `persistNow`/`flushSync`, not its reason.
    const projectionFailure = `${last.name}: ${last.message}`;
    this.bootFailure = this.bootFailure
      ? { ...this.bootFailure, projectionFailure }
      : {
          at: new Date().toISOString(),
          reason: 'unprojectable',
          detail: projectionFailure,
        };
    this._warn((this.bootFailure.reason === 'unprojectable'
      ? 'the board on disk could not be drawn at all '
      : 'the stand-in shown in place of the unreadable board.json could not be drawn either ')
      + `(${projectionFailure}). The app has opened on an EMPTY board and will NOT write to `
      + 'board.json, ops.jsonl or checkpoint.json this session, so every file on disk is exactly as '
      + 'it was. Restore a snapshot from Einstellungen, or send board.json in for a rescue.');
    this._log = createOpLog({ now: () => Date.now() });
    // A DIFFERENT LOG: the withdrawal cache and its arming bit describe the old one.
    this._authz = null; this._authzArmed = true;
    try {
      this.state = this._blankState();
      this._project({ settings: true });
    } catch {
      this.state = defaultState();
    }
    return false;
  }

  /**
   * I-6 — move a refused log aside so it is refused ONCE, not once per launch.
   *
   * "Not deleted" is one of the quarantine's promises and it survives a move: the bytes stay on
   * disk under a name that says why. `storage.quarantineLogAside()` writes the copy BEFORE
   * removing the original and cannot do either on the native path, where no shell command can
   * create a third file — so this is a best-effort tidy-up and never a precondition for anything.
   *
   * NEVER ON A REFUSAL THAT IS EXPECTED TO STOP BEING TRUE (R5-2e). `clock-skew` says "come back
   * when this Mac's date is right"; renaming the files is how that promise is broken, because the
   * next launch does not look under the new name. A refusal that is DEFERRED must leave the bytes
   * where the deferral points. `DEFERRED_QUARANTINE` is that list and it has exactly one member —
   * every other reason is a fact about the files themselves, which the next launch cannot change.
   */
  async _sequesterQuarantine() {
    if (this.quarantine && DEFERRED_QUARANTINE.has(this.quarantine.reason)) {
      this.quarantine.movedAside = null;
      this.quarantine.deferred = true;
      this._warn('the op log was left exactly where it is, under its own name: this refusal is expected to '
        + 'stop being true, and the next launch has to be able to find the files to reconsider them.');
      return;
    }
    let r;
    try { r = await storage.quarantineLogAside(); }
    catch (e) { r = { moved: false, reason: `${e.name}: ${e.message}` }; }
    if (this.quarantine) this.quarantine.movedAside = r.moved ? { ops: r.ops, checkpoint: r.checkpoint } : null;
    if (r.moved) {
      this._warn(`the refused op log was moved aside to ${[r.ops, r.checkpoint].filter(Boolean).join(' and ')}; `
        + 'it is still on disk and can be inspected or restored, and it will not be re-read on the next launch.');
    } else {
      this._warn(`the refused op log was left where it is (${r.reason}), so this refusal is reported again `
        + 'on every launch until the files are moved or removed by hand.');
    }
  }

  /**
   * Refuse an op log without destroying it (A3-C1 · ADR 006 §7).
   *
   * QUARANTINE IS FIVE PROMISES. The first three are unchanged and structural:
   *
   *  1. NOT APPLIED. The log's registers never reach `state`.
   *  2. NOT DELETED. The bytes stay on disk. I-6's move-aside (`_sequesterQuarantine`) is the
   *     sanctioned form of "not re-read"; it is a MOVE and never a delete.
   *  3. NOT OVERWRITTEN. `_opsPersisted = false` is set here, so `_persistOps` cannot touch
   *     either slot for the rest of the session.
   *
   * ADR 006 adds two, and the first is the point of the whole ADR:
   *
   *  4. A QUARANTINE CAN NEVER COST CONTENT. Not "does not" — CANNOT. `state` is derived from the
   *     spine, which was built from `board.json` before the log was read at all, so there is no
   *     code path from a quarantine to a lost entry. Provable by construction; pinned by INV-15.
   *  5. THE REASON IS TRUE. The enum is exact and every member names a fact, not a guess:
   *     `no-checkpoint`, `board-carries-no-lineage`, `log-carries-no-lineage`, `foreign-lineage`,
   *     `unreadable-log`, `clock-skew`, `reconcile-failed`, `board-unreadable`. `lzp.v` is NEVER
   *     a reason (R4-3a).
   *
   *     `board-unreadable` (R5-3a/b/c) is the one member that is not about the log at all: the
   *     BOARD could not be read, so there is no `_v2.lineageId` for the gate to compare and no
   *     evidence either way. A log is refused on the absence of a tie, never adopted on it.
   *
   *     `clock-skew` (R5-2e) is the one member that is not about either FILE: both are this
   *     board's own and both are well formed, and the machine's date is what makes the log
   *     unusable today. It is therefore also the only DEFERRED reason — see
   *     `_sequesterQuarantine` and `_clockSkew`.
   *
   * THE LINEAGE IS RE-MINTED ON `foreign-lineage` ONLY, because that is the only reason that says
   * the old lineage was never ours. On every other reason it is kept, so a log a newer build
   * wrote and this build could not read becomes readable again the moment the user re-upgrades.
   *
   * @param {string} [note] replaces "board.json was loaded unchanged" for a caller on which that
   *        sentence would be false. The rest of the message is fixed: the files are still there.
   */
  _quarantineLog(reason, detail, checkpoint, tail, note) {
    // Structural, not incidental: whatever the caller does next, this session may not write to
    // the two log slots. (WP-8 setting `_opsPersisted` when a space is created must consult
    // `store.quarantine` first — see ADR 006 §9.5 and FINDINGS A3-C1.)
    this._opsPersisted = false;
    if (reason === 'foreign-lineage') {
      // W2 (ADR 006 §9.3): the log we were bound to belongs to someone else, so this device's
      // history under that lineage is over. A new lineage makes the next persist a re-join rather
      // than a silent convergence reset. Content is untouched — it came from `board.json`.
      this._lineageId = mintLineageId();
      this._gen = 0;
    }
    const lines = Array.isArray(tail) ? tail : [];
    this.quarantine = {
      at: new Date().toISOString(),
      reason,
      detail,
      /** Set by `_sequesterQuarantine()`: where the bytes went, or null when they did not move. */
      movedAside: null,
      checkpointHorizon: (checkpoint && typeof checkpoint === 'object' ? checkpoint.horizon : null) ?? null,
      tailLines: lines.length,
      // A sample, not the log: the files themselves are untouched on disk, so a rescue pass reads
      // them there rather than out of a field that would pin an arbitrarily large log in memory.
      checkpoint: checkpoint ?? null,
      tailSample: lines.slice(0, 50),
      tailSampled: Math.min(lines.length, 50),
    };
    this._warn(
      `op log QUARANTINED (${reason}): ${detail}. ${note ?? 'board.json was loaded unchanged;'} `
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
      // ADR 006: `board.json` is always the content authority, so `source` says where the HISTORY
      // came from — 'op-log' when a log's history was adopted, 'recovery' when there was no board
      // file to be authoritative and the log had to be, 'board.json' otherwise.
      source: this._recovered ? 'recovery' : this._adopted ? 'op-log' : 'board.json',
      // WHICH recovery — `source: 'recovery'` alone said "not board.json" and let R5-3a/b hide
      // inside it. `'op-log'` is R7 (the file is genuinely gone); `'snapshot'` and `'none'` are
      // the read-only boot over a board.json that exists and could not be read.
      recoveredFrom: this._recoveredFrom ? { ...this._recoveredFrom } : null,
      // WHICH identity this session runs as (A3-H4). `durable: false` is the solo-mode answer and
      // is not a fault: it means no key was generated and none was needed (ADR 002 §2.4). It is
      // also the answer that explains a sync engine converging nothing, which is exactly why it
      // is reportable rather than private. No key material and no public key appears here.
      identity: {
        durable: this._identity !== null,
        memberId: this._me,
        deviceId: this._device,
        deviceShort: this._short,
        peerDevices: [...this._peerDevices].sort(),
        canVerifyAttestations: this._attestOpen !== null,
      },
      // WHAT THE SYNC SEAM IS DOING (LZP-502). No key material, no space key, no envelope — a
      // space id, two counters and three booleans, all of which the user's own settings pane may
      // show. `logWritable: false` beside `armed: true` is the ADR 006 §9.5 refusal, and it is
      // the answer to "why has nothing uploaded since this morning".
      sync: {
        armed: this._syncArmed,
        personalSpaceId: this._personalSpaceId,
        logWritable: this._opsPersisted,
        outbox: this._personalSpaceId === null ? 0 : this.outboxSize(),
        cursor: this._personalSpaceId === null ? null : this.cursor(),
        rejoin: this._rejoined,
        pendingRetractions: Array.isArray(this.publisher?.pendingRetractions)
          ? this.publisher.pendingRetractions.length : 0,
        // ── THE FOUR FIELDS DOMAIN S4 REQUIRES ─────────────────────────────────────────────
        //
        // `sync-domains.js` S4 is the enumeration of "what the user and the system can observe",
        // and its verdict on this build was that the answer is `healthy` in every row, because
        // there was no field here to say anything else with. `sync/status.js`'s
        // `SYNC_DIAGNOSTIC_FIELDS` names exactly these four and folds over them; the names are
        // the domain's, not this file's, so a fix is expressible in the product's own vocabulary
        // rather than in a new seam nobody else knows about.
        //
        // ALL FOUR MUST SURVIVE A RELAUNCH — that is the requirement, not a nicety. Two of them
        // do so by DERIVATION from what is already on disk (below); two are RECORDED by the sync
        // engine, and until it records them durably they read `0`/`null`, which is honest: this
        // file will not invent evidence it does not have. What it will not do any more is omit
        // the field, because an absent field reads as `healthy` to every consumer, and
        // `sync/status.js`'s `blindSpots()` exists precisely to refuse that.
        //
        //   parked   DERIVED. `_log.parkedOps()` — durable by construction: a parked line rides
        //            in `checkpoint().parked` with its reason (ADR 001 §7.4). Closes L-2's store
        //            half; `S4-held`'s `storeReports: 'sync.parked'`.
        //   refused  RECORDED by the engine (L-1). `sync/personal.js`'s `quarantined` Map is
        //            per-session, so a terminal refusal is visible for minutes and then for ever
        //            reported as `healthy`, with the cursor already past the op. The engine owner
        //            appends to `syncRefusals`; this seam only counts.
        //   lost     DERIVED. See `_syncLostOps()` — E5-2's own signature, read back off the
        //            checkpoint, so it survives every relaunch after the fold.
        //   chain    RECORDED by the engine (P-4). ADR 002 §5.4's chain witness. `sync/chain.js`
        //            implements it and `src/` imports it from nowhere, so this is `null` until
        //            `pullNow` calls `verifyChain`; the field is here so that wiring it is one
        //            assignment rather than a new seam.
        parked: this._personalSpaceId === null ? 0 : this._log.parkedOps().length,
        refused: Array.isArray(this.syncRefusals) ? this.syncRefusals.length : 0,
        lost: this._syncLostOps().length,
        chain: this.syncChain ?? null,
        // ── THE FAMILY HALF (E6-1) ───────────────────────────────────────────────────────────
        // Reported beside the personal counters and never merged into them: two spaces, two
        // engines, two key rings (21.2), and „nichts geht raus" has a different cause and a
        // different cure on each side. `familyOutbox` reads 0 on every Mac in no circle, which is
        // the same answer it gave before this seam existed.
        familySpaceId: this._familySpaceId,
        familyOutbox: this._familySpaceId === null ? 0 : this.familyOutbox().length,
        familyCursor: this._familySpaceId === null ? null : this.cursor(this._familySpaceId),
        admin: this.familyAdmin().admin,
      },
      lineage: {
        id: this._lineageId,
        gen: this._gen,
        adopted: !!this._adopted,
        exact: this._adopted ? this._adopted.exact : null,
        reconciled: this._adopted ? this._adopted.reconciled : null,
      },
      bootFailure: this.bootFailure ? { ...this.bootFailure } : null,
      warnings: [...this.warnings],
      quarantine: this.quarantine
        ? {
          at: this.quarantine.at,
          reason: this.quarantine.reason,
          detail: this.quarantine.detail,
          checkpointHorizon: this.quarantine.checkpointHorizon,
          tailLines: this.quarantine.tailLines,
          movedAside: this.quarantine.movedAside ?? null,
        }
        : null,
    };
  }

  /**
   * ── `diagnostics().sync.lost` — E5-2, READ BACK OFF THE DISK ─────────────────────────────────
   *
   * THE FACT THIS RECOVERS. `_outboxHorizonCap()` exists to stop a persist folding past the
   * oldest line the relay has not acknowledged. When it fails to — and its `cap === null` arm
   * stands the cap down in the state every compaction leaves behind — the line is folded away for
   * real: `outbox()` returns 0, the board keeps the value, and the other Mac will never see it.
   * The user loses nothing ON THIS MAC. What is lost is the FACT, and the fact is what
   * `sync-domains.js` S4-lost requires this layer to be able to report.
   *
   * WHY THIS IS A DERIVATION AND NOT A LEDGER. A ledger written at the moment of the fold would
   * be a per-session note in memory (E5-2's existing `_e52Warned` is exactly that, and `_warn`'s
   * array is emptied by the next `init()` — F-8). The fold, by contrast, leaves a PERMANENT
   * signature in the two files this store already writes, and re-reading it costs one pass:
   *
   *   an opId that
   *     · writes a live register of a PERSONAL-space entity      (`note`/`bar`/`cat`/`pad`;
   *       `pref` is `local`-space and is never synced — story 17.7, rule U6 — so a settings write
   *       is unacknowledged for ever by design and must not be counted),
   *     · was minted by THIS device                              (`stamp.slice(-16) === _short`,
   *       the same test `outbox()` uses; a peer's op carries the peer's short and arrived WITH a
   *       seq, and a migration op carries the all-zeros short and never travels — ADR 001 §8.1),
   *     · carries NO server seq                                  (`_log.seqOfOp`, which rides in
   *       `checkpoint().seqs` keyed by opId since attack A7), and
   *     · has NO LINE LEFT in the log                            (a line would BE the outbox
   *       entry; `outbox()` would offer it and the next push would send it)
   *
   *   is an op this Mac authored, never got acknowledged for, and can no longer offer.
   *
   * Every clause is load-bearing and each one is a false positive that would otherwise light the
   * amber ring on a healthy Mac. Registers and seqs both ride in the checkpoint, so the answer is
   * identical before and after a quit — which is the half of S4-lost the engine cannot supply.
   *
   * Solo installs return `[]` without touching the registers: with no personal space there is no
   * relay to be unacknowledged by.
   *
   * @returns {string[]} the opIds, in register order. Read-only; nothing branches on it.
   */
  _syncLostOps() {
    if (this._personalSpaceId === null) return [];
    const regs = this.registers();
    if (!regs || typeof regs.values !== 'function') return [];

    const online = new Set();
    for (const line of this._log.lines()) if (line?.op?.id) online.add(line.op.id);

    const lost = [];
    const seen = new Set();
    for (const [key, cells] of regs) {
      if (typeof key !== 'string') continue;
      // The entity kind is the prefix of `core/entities.js`'s `localKey`. Parsed by hand rather
      // than with `parseEntityKey` so that this seam adds no import to a file another owner is
      // editing this round; the four kinds below are `OP_KINDS`' `space: 'personal'` entities.
      const kind = key.slice(0, key.indexOf(':'));
      if (kind !== 'note' && kind !== 'bar' && kind !== 'cat' && kind !== 'pad') continue;
      if (!cells || typeof cells.values !== 'function') continue;
      for (const cell of cells.values()) {
        const id = cell && typeof cell.op === 'string' ? cell.op : '';
        if (!id || seen.has(id) || online.has(id)) continue;
        const ts = cell.stamp;
        if (!isStamp(ts) || isGenesisStamp(ts) || ts.slice(-16) !== this._short) continue;
        if (this._log.seqOfOp(id) !== null) continue;
        seen.add(id);
        lost.push(id);
      }
    }
    return lost;
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

  /**
   * An OpCtx for one transaction. `regs` arms `ops.js`'s existence gate (ATT-88).
   * @param {string} [gid] @param {Object} [log] the log the gate reads — the live one by default,
   *        and the log being reconciled during `_reconcileOntoBoard` (ADR 006 §5.4)
   */
  _ctx(gid, log) {
    return {
      act: this._me,
      dev: this._device,
      gid: gid ?? newGid(),
      mint: () => this._clock.tick(),
      newOpId,
      newGid,
      space: this._personalSpaceId ?? PERSONAL_PLACEHOLDER,
      familySpaceId: this._familySpaceId,
      regs: log ? log.registers() : this.registers(),
    };
  }

  /**
   * The RegisterMap — checkpoint ⊕ tail, WITH THE FOLD'S RETROACTIVE VERDICT APPLIED.
   * Read-only; `core/` owns every write to it.
   *
   * ═════════════════════════════════════════════════════════════════════════════════════════
   * WHY THIS IS NO LONGER `this._log.registers()` — E9-B, finding 1, and it was a CONVERGENCE
   * BUG rather than an authorization one.
   * ═════════════════════════════════════════════════════════════════════════════════════════
   *
   * `core/authz.js` stage 3b decides a co-edit against the FINAL value of `pub.coEdit`,
   * `pub.level` and `pub.alive`, and says what that means: "an owner who revokes co-edit
   * retroactively withdraws every co-editor write to that entity, at every stamp, ON EVERY
   * DEVICE". Stage 3c says the same for content above a level, "whatever order the ops arrived
   * in". Both sentences are TRUE of `foldAuthorized` — `e9-attack-diverge` §2d proves it over
   * eight shuffles — and both were FALSE of this store, because `applyRemote` used the fold as
   * an ARRIVAL GATE: it folded `[my log] + [this batch]`, dropped the ops OF THIS BATCH the
   * verdict refused, and left every op already in the log exactly where it was. Which ops a
   * withdrawal reached was therefore a function of WHEN EACH MAC HAPPENED TO PULL. Measured:
   * one revocation, three ops, no patched client, and Oma read `Nordsee` while Eve read
   * `Herbstferien` — for ever, because a further pull has nothing left to deliver.
   *
   * ── WHICH SIDE WAS WRONG, AND WHY IT IS THIS ONE ─────────────────────────────────────────
   *
   * The prose. A rule that admits a write because of a grant that was later withdrawn makes
   * admissibility depend on which op the folding device saw first, and a device that folds from
   * scratch — a fresh joiner's first pull, a restore, the fleet harness's convergence check —
   * has no "first" to depend on. So the retroactive reading is the only one that converges and
   * `authz.js` keeps it.
   *
   * THE TEMPTING ALTERNATIVE WAS COSTED AND REFUSED: let the owner's revocation carry a FORWARD
   * write that restores their own value, so nothing has to be re-folded. It converges whenever
   * the restoring write is newer than every withdrawn one — and the revoking device cannot know
   * that, because the withdrawn writes are exactly the ops it has not pulled. `e9-attack-diverge`
   * §2c is that case: Papa's downgrade is minted OLDER than Mama's co-edit and pushed after it,
   * so a forward write loses the LWW contest it was minted to win. A withdrawal that only works
   * when you are already in sync is not a withdrawal.
   *
   * ── AND THE COST, HONESTLY (ADR 006: `board.json` is the truth, the op log is history) ────
   *
   * A full `foldAuthorized` over the LZP-1007 fixture (8 members × 2 years, ≈6 000 entries,
   * 12 013 ops) is **75 ms**, measured; the log's own plain LWW fold of the same set is 19 ms.
   * Two of them — the `myDevices` two-pass — is 150 ms against ADR 001 §5.1's 40 ms materialize
   * budget. So re-folding on every READ is not available, and neither is re-folding on every log
   * MUTATION: `_commit` runs on every edit.
   *
   * What makes it affordable is that a withdrawal cannot appear out of nowhere. Every stage that
   * can change an op's verdict reads registers written by exactly three kinds of op:
   *
   *     `member.set`  stages 0a/0b (attestations), 2 (membership), 3a (`membersIn`)
   *     `space.set`   stage 1 (the admin chain), 3a (the unsharing admin)
   *     `pub.set` carrying a GOVERNING field (`pub.level`, `pub.coEdit`, `pub.alive`, `_born`)
   *                   stage 3a's own fold, which is what 3b and 3c read
   *
   * Nothing else in the vocabulary can change any other op's admissibility — a `note.set`, a
   * `pref.set`, a `pad.set`, a co-editor's `pub.text` are all invisible to every predicate. So
   * ONLY those three arm a fold (`_armAuthz`), and the arming bit stays raised for as long as a
   * withdrawal is actually in force. That last half is the safety property: a missed arming site
   * can delay noticing a NEW withdrawal until the next governing op; it can never drop one that
   * is already held, because `_authzArmed` is re-derived from the withdrawal set on every fold.
   *
   * A remote batch pays nothing at all: `applyRemote` already folds, and hands its verdict here
   * through `_noteAuthzVerdict`.
   *
   * ── WHAT THE REPAIR IS, AND WHAT IT IS NOT ───────────────────────────────────────────────
   *
   * It is NOT "return `verdict.regs`". That map is the fold of what the FOLD admitted, and the
   * fold refuses ops for reasons that have nothing to do with a withdrawal — an unattested
   * device, a personal-space op from a Mac I have not paired yet. Serving it would silently
   * delete content on an ordinary board. The repair is subtractive and named: the ops the
   * verdict withdrew are removed BY ID, the fields stage 3c redacted are removed BY NAME, and
   * everything else is folded exactly as the log folds it. When nothing is withdrawn this method
   * returns the log's own memoised map, by identity — the same object, at the same cost as
   * before this existed.
   */
  registers() {
    const base = this._log.registers();
    const c = this._authz;
    if (c !== null && c.base === base) return c.regs;
    // Not armed: nothing that could create a withdrawal has entered the log, and none is in
    // force. The log's fold IS the authorized fold, which is the ordinary case for every board.
    if (!this._authzArmed) { this._authz = null; return base; }
    return this._refoldAuthorized(base);
  }

  /**
   * Fold the whole log and apply the verdict to it. The two passes are `applyRemote`'s, for the
   * reason stated there: a `dev.*` attestation is itself an op, so the device set is not a
   * constant and pass 1 exists only to learn it.
   * @param {Object} base `this._log.registers()`
   */
  _refoldAuthorized(base) {
    let verdict;
    try {
      const all = [...this._log.ops({ includeParked: true })];
      const devices = this._identity ? this._myDevices(foldAuthorized(all, this._authzCtx())) : null;
      verdict = foldAuthorized(all, this._authzCtx(devices ? { myDevices: devices } : {}));
    } catch (e) {
      // ADR 006 R4's rule, applied one layer down: every conceivable failure of this pass
      // degrades to "history kept, nothing withdrawn" — never to lost content. It is loud.
      this._warn(`the authorization fold failed (${e.name}: ${e.message}); the retroactive `
        + 'withdrawal pass was skipped and the log\'s own fold is being served');
      this._authz = { base, regs: base, withdrawn: new Map() };
      return base;
    }
    return this._noteAuthzVerdict(verdict, base);
  }

  /**
   * Record a verdict that has already been computed over this log, and repair the register map
   * from it. `applyRemote` calls this so a remote batch pays for exactly one fold, not two.
   * @param {Object} verdict an `AuthzResult` folded over this log's ops
   * @param {Object} [base] `this._log.registers()`, when the caller already holds it
   */
  _noteAuthzVerdict(verdict, base = this._log.registers()) {
    const withdrawn = this._withdrawalsOf(verdict);
    this._authzArmed = withdrawn.size > 0;
    const regs = withdrawn.size === 0 ? base : this._repairWithdrawn(withdrawn);
    this._authz = { base, regs, withdrawn };
    return regs;
  }

  /**
   * The ops in MY OWN LOG that the current fold no longer admits — the retroactive verdicts and
   * nothing else.
   *
   * WHY THE SET IS NARROW, AND WHAT IS DELIBERATELY OUT OF IT. Removing an op from the register
   * map removes content, so the only refusals honoured here are the ones that are a FUNCTION OF
   * ANOTHER OP'S FINAL VALUE — the ones that can become true after the op was admitted:
   *
   *   `notAlive` · `noCoEdit` · `notGeteilt`   stage 3b, read off the FINAL 3a registers
   *   `contentAboveLevel`                      stage 3c, read off the FINAL `pub.level`
   *   `unshareShape` (a PARK, not a refusal)   stage 3a's tri-state — held, and re-judged by a
   *                                            build that can read it
   *
   * Everything else the fold can say is a verdict about the op ITSELF and cannot change:
   * `notOwner` is structural (§4.4 — there is nothing to backdate), `notCoEditable` is a
   * function of the patch, `shape`/`badAttestation`/`writeOnce` are the op's own form. An op in
   * this log carrying one of those was never admitted by `applyRemote` in the first place, and
   * treating "the fold refuses it" as "delete it" would make a local commit that the fold
   * happens to dislike cost the user their entry.
   *
   * `notMember` and `lostAdminChain` ARE retroactive and are NOT here. A removal already has a
   * mechanism of its own — `materialize`'s `currentMembers` filter (ADR 001 §5 step 3, story
   * 20.2) drops every entry of a removed member without touching a register — and widening this
   * pass to overlap it is a membership-lifecycle decision (WP-9), not a co-editor one. Recorded
   * as owed rather than done, because the two mechanisms must be designed together or a re-join
   * will resurrect what the other one hid.
   *
   * @param {Object} verdict
   * @returns {Map<string, string[]|null>} opId → `null` (the whole op) or the field names dropped
   */
  _withdrawalsOf(verdict) {
    const out = new Map();
    const isLive = (id) => typeof id === 'string' && this._log.has(id) && !this._log.isParked(id);
    const reasonOf = (id) => {
      try { return verdict.rejectionOf(id)?.reason ?? null; } catch { return null; }
    };
    for (const op of (Array.isArray(verdict?.rejected) ? verdict.rejected : [])) {
      const id = op && op.id;
      if (!isLive(id)) continue;
      if (RETROACTIVE_REFUSALS.has(reasonOf(id))) out.set(id, null);
    }
    for (const op of (Array.isArray(verdict?.parked) ? verdict.parked : [])) {
      const id = op && op.id;
      if (!isLive(id)) continue;
      let why = null;
      try { why = verdict.parkReasonOf(id); } catch { why = null; }
      if (FOLD_ONLY_PARKS.has(why)) out.set(id, null);
    }
    for (const r of (Array.isArray(verdict?.contentAboveLevel) ? verdict.contentAboveLevel : [])) {
      const id = r && r.opId;
      if (!isLive(id) || out.get(id) === null) continue;   // `null` = the whole op is already gone
      const fields = out.get(id) ?? [];
      if (!fields.includes(r.field)) fields.push(r.field);
      out.set(id, fields);
    }
    return out;
  }

  /**
   * `checkpoint ⊕ (live lines − the withdrawn ones)`, with stage 3c's dropped fields removed
   * from the bodies that survive. A plain LWW fold — `registers.js` owns the join and this does
   * not carry a second copy of it.
   *
   * THE ONE THING IT CANNOT REPAIR, and it says so out loud rather than pretending otherwise: an
   * op that has been COMPACTED is no longer a line. Its value is folded into the checkpoint, it
   * is not in `_log.ops()` and therefore not in the set `foldAuthorized` is given, so the fold
   * never names it and there is nothing here to subtract. `oplog.js:park()` refuses the same
   * case for the same reason, in the same words.
   *
   * THE BOUND IS `_persistOps` STEP ②: compaction runs at `TAIL_COMPACT_AT` lines (capped at the
   * outbox horizon, so nothing unacknowledged is folded), which is a count of THIS Mac's writes
   * and not a promise that every peer has seen the op. So a revocation that arrives after that
   * many local edits reaches every peer that has not compacted and not the one that has. It is
   * the same residual `oplog.js` already carries for `park()`, it is bounded by ADR 001 §7.2's
   * own policy rather than by anything this pass introduced, and closing it needs a checkpoint
   * that can be re-folded — which is exactly what §7.2 says it deliberately is not.
   * @param {Map<string, string[]|null>} withdrawn
   */
  _repairWithdrawn(withdrawn) {
    const h = this._log.horizon();
    const out = deserializeRegisters(this._log.checkpoint({ horizon: h ?? ZERO_STAMP }).regs);
    for (const op of this._log.ops()) {
      const w = withdrawn.has(op.id) ? withdrawn.get(op.id) : undefined;
      if (w === null) continue;                             // withdrawn whole
      if (w === undefined) { applyOp(out, op); continue; }
      const f = {};
      for (const [k, v] of Object.entries(op.f)) if (!w.includes(k)) f[k] = v;
      if (Object.keys(f).length) applyOp(out, Object.freeze({ ...op, f: Object.freeze(f) }));
    }
    return out;
  }

  /**
   * Raise the fold flag if any of `ops` could change another op's admissibility. See the essay
   * on `registers()` for the derivation of the three kinds; the predicate is DERIVED from
   * `FIELDS`' own `gov` marks rather than restating a list, so a new governing register arms this
   * without anybody remembering to come here.
   * @param {Iterable<Object>} ops
   */
  _armAuthz(ops) {
    if (this._authzArmed) return;
    for (const op of ops) {
      if (!op || typeof op !== 'object') { this._authzArmed = true; return; }   // unknown ⇒ arm
      if (op.k === 'member.set' || op.k === 'space.set') { this._authzArmed = true; return; }
      if (op.k !== 'pub.set') continue;
      const colon = typeof op.e === 'string' ? op.e.indexOf(':') : -1;
      const table = colon > 0 ? FIELDS[op.e.slice(0, colon)] : null;
      if (!table) { this._authzArmed = true; return; }                          // unknown ⇒ arm
      for (const f of Object.keys(op.f || {})) {
        if (table[f] && table[f].gov === true) { this._authzArmed = true; return; }
      }
    }
  }

  /** The opIds this device is currently withholding from its own board, and why. Diagnostics. */
  withdrawnOps() {
    this.registers();
    const out = [];
    for (const [id, fields] of (this._authz?.withdrawn ?? new Map())) {
      out.push(Object.freeze({ id, fields: fields === null ? null : fields.slice() }));
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * THE THREE MEMBER INPUTS `materialize()` NEEDS, out of the log and out of the local prefs.
   *
   * This used to be three constants — `members: new Map()`, `currentMembers: new Set([me])`,
   * `hiddenMembers: new Set()` — and each of them silently disabled a shipped story:
   *
   *   · `currentMembers: {me}` is the strictest possible reading of ADR 001 §4.2 and it drops
   *     EVERY foreign entry: `entities.js:projectable` refuses a foreign entry whose owner is not
   *     in the set (20.2). So Mama's shared entry folded into the register map, converged
   *     perfectly, and was never drawn. Now it is §4.2's own definition, verbatim —
   *     `{ m : member:m exists ∧ _alive !== false }` — read off the same registers `authz.js`
   *     reads it off, which is legitimate here BECAUSE `applyRemote` gates on `foldAuthorized`
   *     before anything reaches the log: `registers()` IS the authorized fold (see `applyRemote`).
   *     `me` is unioned in unconditionally, so a Mac whose own `member:` record has not folded yet
   *     still renders its own board — fail-open for me, fail-closed for everybody else.
   *   · `members: new Map()` left 17.2's member colour and 17.6's attribution with nothing to
   *     resolve, so a foreign entry rendered under its initial and „einem Mitglied".
   *   · `hiddenMembers: new Set()` made 17.3's per-member toggle change the LEGEND AND NOT THE
   *     BOARD. `store.setSettings({hiddenMembers: {…}})` wrote the pref, `materialize` accepted
   *     the ctx field, `projectable` applied it — and `_project()` never passed it. Every layer
   *     of that feature existed except the one line that connects them.
   *
   * IT IS DELIBERATELY NOT USED BY `_projectionOf()`. That builds a projection of an ARBITRARY
   * log to compare against another one (`_reconcileOntoBoard`, `_projectSafe`'s trial). Feeding a
   * device-local PRESENTATION filter into a comparison would make hiding Papa look like content
   * that had gone missing, and reconciliation would try to put it back.
   *
   * @param {Map} regs @returns {{members:Map, currentMembers:Set<string>, hiddenMembers:Set<string>}}
   */
  _memberCtx(regs) {
    const members = new Map();
    const currentMembers = new Set([this._me]);
    for (const key of regs.keys()) {
      if (!key.startsWith('member:')) continue;
      const id = key.slice('member:'.length);
      if (!isMemberId(id)) continue;
      const cells = regs.get(key);
      const val = (f) => {
        const c = cells.get(f);
        return c === undefined ? undefined : c.value;
      };
      // §4.2: a member record EXISTS ⇒ they are current, unless `_alive` is explicitly false. An
      // absent `_alive` is not a "no" (ADR 001 §5 step 3: meaning is never inferred from absence),
      // which is why a record carrying nothing but a `dev.*` attestation already counts.
      if (val('_alive') !== false) currentMembers.add(id);
      const displayName = val('displayName');
      const colorRef = val('colorRef');
      const name = typeof displayName === 'string' ? displayName.trim() : '';
      members.set(id, {
        displayName: name === '' ? null : name,
        colorRef: typeof colorRef === 'string' ? colorRef : null,
        // 17.2's chip. `[...name][0]` and never `name[0]`: a name beginning with an emoji or an
        // astral character would otherwise put half a surrogate pair in a 16 px circle.
        //
        // `family/membersui.js:initialOf` carries the same rule for the LEGEND, with
        // `toLocaleUpperCase(de|en)` and a `·` placeholder, and the two are deliberately not one
        // function: `membersui.js` imports THIS module, so importing it back would be a cycle,
        // and it is a `family/` module, which ADR 005 §2 keeps out of `boot.js`'s import graph.
        // The rule they share is the grapheme; de and en upper-case identically, and `null` here
        // means "no name yet", which `materialize` renders as an absent chip rather than a dot.
        initial: name === '' ? null : [...name][0].toUpperCase(),
      });
    }
    return { members, currentMembers, hiddenMembers: this._hiddenMembers() };
  }

  /**
   * 16.6 / ADR 004 §6 — THE EXPOSURE BADGE'S TWO INPUTS. *"The badge must never promise a privacy
   * state that has not yet reached the server."*
   *
   * The badge on MY OWN entry is derived from what actually reached the log, never from my local
   * intent. Both hooks are optional in `materialize.js` and without them the badge simply reports
   * the current level and never pends — which was the honest answer while there was no outbox to
   * ask, and is the wrong one now that there is: a pending downgrade would render as ALREADY
   * WITHDRAWN, and that is the badge promising a privacy state the family has not been told about.
   *
   * `lastAckedPubLevel` restricts `pub.level` to ops that carry a server `seq` (ADR 003 §3.1's
   * `accepted` ≡ `duplicate`), so a level whose op is still in the outbox does not count. Both
   * errors then point the same way — a pending upgrade shows the old LOWER exposure, a pending
   * downgrade the old HIGHER one — and the badge never UNDER-reports what others can see.
   *
   * Solo mode reaches none of it: with no family space there are no `fnote:`/`fbar:` registers, so
   * the closures are never called.
   *
   * @param {Map} regs @returns {Object} the two `MaterializeCtx` hooks
   */
  _exposureCtx() {
    if (this._familySpaceId === null) return {};
    // ONE PASS over the log, not one per entity. Two answers come out of it:
    //   `pending`  entity keys with a `pub.set` still in the outbox (no seq, not parked)
    //   `acked`    the NEWEST `pub.level` among ops that DO carry a seq
    //
    // The second cannot be read off the register map, and that is the whole subtlety: the map
    // keeps only the winner, and the winner of a pending downgrade is the op that has not reached
    // the server. Asking the map and treating an unacked winner as "no answer" makes a pending
    // Geteilt→Belegt render as PRIVAT — the badge under-reporting what the family can still see,
    // which is the one direction ADR 004 §6 forbids.
    const pending = new Set();
    const acked = new Map();
    const ackedAt = new Map();
    for (const line of this._log.lines()) {
      const op = line.op;
      if (!op || op.k !== 'pub.set' || op.space !== this._familySpaceId) continue;
      if (line.seq === null || line.seq === undefined) {
        if (!line.park) pending.add(op.e);
        continue;
      }
      if (!Object.hasOwn(op.f ?? {}, 'pub.level')) continue;
      // Stamps are 37 fixed-width characters and order lexicographically (ADR 001 §6), so the
      // newest acked level is a string comparison and needs no clock.
      const prev = ackedAt.get(op.e);
      if (prev !== undefined && prev >= op.ts) continue;
      ackedAt.set(op.e, op.ts);
      acked.set(op.e, op.f['pub.level']);
    }
    return {
      pendingPub: (fkey) => pending.has(fkey),
      lastAckedPubLevel: (fkey) => {
        const v = acked.get(fkey);
        return v === 'privat' || v === 'belegt' || v === 'geteilt' ? v : null;
      },
    };
  }

  /**
   * Story 17.3 — the per-member toggle, from `settings.hiddenMembers.<memberId>`.
   *
   * A DEVICE-LOCAL pref (`pref.set`, the `local` space, never synced — rule U6, story 17.7), and
   * `core/replace.js:PRESERVED_PREF_PREFIXES` keeps it across an import for exactly this reason:
   * "restoring a snapshot would otherwise un-hide every foreign entry in the family".
   *
   * Only a `true` hides. The register is set to `false` to UN-hide (`membersui.js:463` writes the
   * absolute value, never a toggle, so two Macs converge instead of cancelling), and reading any
   * truthy value would make `false` mean hidden.
   * @returns {Set<string>}
   */
  _hiddenMembers() {
    const out = new Set();
    const raw = this.state && this.state.settings && this.state.settings.hiddenMembers;
    if (!raw || typeof raw !== 'object') return out;
    for (const [id, v] of Object.entries(raw)) if (v === true) out.add(id);
    return out;
  }

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
    const regs = this.registers();
    const full = materialize(regs, {
      me: this._me,
      familySpaceId: this._familySpaceId,
      ...this._memberCtx(regs),
      ...this._exposureCtx(),
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
    this._armAuthz(ops);
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
    // ONE gid for the whole group, read before anything is appended, because ADR 004 §5 requires
    // the truth write and the publication derived from it to carry the SAME one.
    const gid = ops.find((o) => o.gid)?.gid ?? newGid();
    // Captured against the PRE-transaction registers — `captureImages` is explicit that folding
    // first and capturing second records the post-state twice and produces an undo that does
    // nothing. It also refuses any op that is not mine, which IS story 18.4.
    const { pre, post } = captureImages(this.registers(), ops, { me: this._me });
    // E9-B · finding 1: a LOCAL op can withdraw a peer's write too — the owner unticking
    // `pub.coEdit` on their own entry is a `_commit`, and every co-editor write already in
    // this log has to go with it. `_armAuthz` raises the flag only for the three kinds that
    // can change any predicate's answer; see `registers()`.
    this._armAuthz(ops);
    for (const op of ops) this._log.append(op);
    this._project();
    // ADR 004 §2.3, §5 — the publication rides in the SAME group, so it is one ⌘Z. It is derived
    // AFTER `_project()` because promotion (§4.1) is what makes `state.notes` the truth this
    // device may publish, and it is NOT in the undo images on purpose: `core/undo.js` decides
    // that a publication is derived, and "undoing the truth and letting the publisher re-derive
    // is the only path that cannot leave the family space describing a state the owner's board no
    // longer holds." That sentence is only true because `undo()`/`redo()` below call this too.
    const published = this._publishAndEnqueue(ops, gid);
    if (published.length) this._project();
    // A `[L]` row's `pref.set` has to reach `state.settings` BEFORE `emit()`, or every listener
    // that redraws on this action reads the stale value (4.2) — and in the two `delete-category`
    // rows it would read an id that this very group just tombstoned. Re-syncing `_projected`
    // afterwards is what stops the next `_adopt()` seeing a diff and emitting the pref twice.
    if (applyPrefOps(this.state.settings, ops)) {
      this._projected.settings = structuredClone(this.state.settings);
    }
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
    const tx = makeTx({ state: this.state, regs: this.registers(), ...this._ctx() });
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
    // A FAMILY MUTATION ON A MAC WITH NO CIRCLE, ANSWERED HERE RATHER THAN THREE LAYERS DOWN.
    // `core/ops.js:spaceFor` already refuses (it must — it is the last gate before the op is
    // minted), but its sentence is about an `OpCtx` field, and the caller of `store.apply` is a
    // click handler in `family/`. This one names the method that fixes it.
    //
    // IT THROWS `OpError` AND NOT A PLAIN `Error`, deliberately: R3-21 measured that this door
    // already has two error classes for a caller to catch (`OpError` and `EntityKeyError`) and
    // called that a defect. A third would make the defect worse. This refusal IS an
    // op-construction precondition — it is `spaceFor`'s own refusal, raised one layer up where
    // the sentence can name the method that fixes it — so it is `spaceFor`'s error class too.
    if (this._familySpaceId === null && isFamilyMutation(name)) {
      throw new OpError(
        `store.apply(${JSON.stringify(name)}): this store is in no Familienkreis. Call `
        + 'store.useFamilySpace(fsp_…) first — before this, core/ops.js cannot address a family '
        + 'op at any space (ADR 001 §3) and solo mode emits none by design (story 15.1).');
    }
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
   *
   * ── WHAT LZP-502 ADDED, AND WHY EACH HALF IS NOT OPTIONAL ────────────────────────────────
   *
   * **`meta.seqs` — the server's sequence numbers.** Without them a pulled op enters the log with
   * `seq === null`, which is the DEFINITION of the outbox (§8.1) — so every op a peer sent would
   * be pushed straight back at it, for ever, growing by one round trip per pull. The seq also
   * rides in `checkpoint().seqs`, which is what makes the outbox survive a relaunch without
   * re-publishing the world. A batch handed in without seqs still works (that is how every
   * pre-existing test calls this door and how a `local` merge would); it simply cannot leave the
   * outbox, which the outbox's own `op.dev === this._device` filter then catches.
   *
   * **The space filter — finding F-7, and it is the reason this door needed a filter at all.**
   * ADR 001 §3.3 says the `local` space is "never synced" and 17.7 says settings never leave the
   * machine, but `applyRemote` had no space filter, so a remote `pref.set` was ADMITTED: it moved
   * the register map while `state.settings` — which `_project()` deliberately does not re-derive
   * — did not move with it, and the two then disagreed about row height and about WHICH Feiertage
   * layer is drawn. Three things are refused here, before the authorization fold, because none of
   * them is an authorization question:
   *   · `local`-space ops (F-7 / M-2). Never on a wire in either direction.
   *   · a personal-space op addressed to a DIFFERENT `psp_…` than mine — the cross-space replay
   *     that ADR 002 §5.2.2 check 2 refuses at the envelope, refused a second time at the op, so
   *     the property does not depend on a caller having opened the envelope first.
   *   · the `'personal'` PLACEHOLDER from a peer once I have a real space. A peer that is still
   *     pre-space cannot have sealed anything, so such an op can only be a replay or a local
   *     mistake, and admitting it would let an unspaced log write into a spaced one.
   *
   * @param {Object[]} ops
   * @param {{seqs?:Object<string,string>|Map<string,string>}} [meta]
   * @returns {{applied:string[], refused:Array<{id:string, reason:string}>, batch:number}}
   *          `refused` carries the fold's own reason code, which is what lets the puller tell a
   *          refusal that a later op can cure (an attestation that has not arrived — F-6) from
   *          one that nothing will ever cure. This door still never throws.
   */
  applyRemote(ops, meta = {}) {
    const result = { applied: [], refused: [], batch: 0 };
    const seqOf = (id) => {
      const s = meta && meta.seqs;
      if (!s) return undefined;
      const v = s instanceof Map ? s.get(id) : (Object.prototype.hasOwnProperty.call(s, id) ? s[id] : undefined);
      return v === undefined || v === null ? undefined : v;
    };
    if (ops === null || ops === undefined) return result;
    if (!Array.isArray(ops)) {
      this._warn(`remote batch refused: expected an array of ops, got ${typeof ops}`);
      return result;
    }
    const list = [...ops];
    if (!list.length) return result;
    result.batch = list.length;
    this._adopt();

    // Shape first, so nothing downstream has to defend itself against `null`.
    const wellFormed = [];
    for (const op of list) {
      if (!(op && typeof op === 'object' && !Array.isArray(op) && typeof op.id === 'string' && op.id !== '')) {
        this._warn(`remote op refused: not a well-formed op (${op === null ? 'null' : typeof op})`);
        continue;
      }
      // ── F-7 · the space filter, ahead of the fold ──────────────────────────
      const cls = spaceClassOf(op.space);
      if (cls === 'local') {
        this._warn(`remote op ${op.id} refused: the local space is never synced (ADR 001 §3.3, story 17.7)`);
        result.refused.push({ id: op.id, reason: 'localSpace' });
        continue;
      }
      if (cls === 'personal' && this._personalSpaceId !== null && op.space !== this._personalSpaceId) {
        this._warn(
          `remote op ${op.id} refused: it is addressed to personal space ${JSON.stringify(op.space)}, `
          + `not to ${this._personalSpaceId}`);
        result.refused.push({ id: op.id, reason: 'foreignSpace' });
        continue;
      }
      // The same refusal for the FAMILY space, which had none. Addendum 20.6 is "at most one
      // Familienkreis", so a `pub.set` addressed to another `fsp_…` is a cross-space replay and
      // never an ordinary arrival — and unlike the personal case it would have folded into the
      // register map and rendered, because `materialize` gates a foreign entry on the OWNER being
      // a current member and never on the op's space. Guarded on `!== null` so a store that has
      // adopted no circle judges a family op exactly as it did before (that is how every
      // pre-existing test drives this door).
      if (cls === 'family' && this._familySpaceId !== null && op.space !== this._familySpaceId) {
        this._warn(
          `remote op ${op.id} refused: it is addressed to family space ${JSON.stringify(op.space)}, `
          + `not to ${this._familySpaceId}`);
        result.refused.push({ id: op.id, reason: 'foreignSpace' });
        continue;
      }
      wellFormed.push(op);
    }

    let verdict;
    try {
      // ── AUTHORISATION IS DECIDED FIRST, ON A CLOCK THAT PARKS NOTHING (R6-4c · D3-p5) ───────
      //
      // `ctx.nowMs` has exactly one consumer in the whole authorization fold: `classifyOp`'s
      // 24 h future clamp (`core/ops.js:502`, and `nowMs` appears nowhere else in
      // `core/authz.js`). Passing it here made `foldAuthorized` SHORT-CIRCUIT a future-stamped op
      // straight into `parked` (`core/authz.js:751`) BEFORE any of the three authorisation stages
      // ran — so the op never entered `verdict.rejected`, the loop below never skipped it, and
      // `_log.append` parked it. The same author's op stamped NOW is refused outright. One date,
      // and a stranger's write was kept, persisted into the victim's own `checkpoint().parked`
      // and read back on the next launch.
      //
      // THE INPUT DOMAIN, so the next round cannot walk in through a cell nobody wrote down
      // (tests/helpers/domains.js D3). `classifyOp` has three verdicts and six park reasons:
      //
      //   verdict   park reason      derived from        may authz judge the op?   who decides
      //   ───────   ──────────────   ─────────────────   ───────────────────────   ───────────
      //   reject    —                the op's SHAPE      no — it is not an op      classifyOp
      //   park      `future`         THE WALL CLOCK      YES — every field authz    ← THE BUG:
      //                                                  reads is present and       the clock
      //                                                  well-formed                pre-empted
      //                                                                             authz
      //   park      `version`,       the op's SHAPE      no — the vocabulary is    classifyOp
      //             `unknownKind`,   (`validateOp`)      unknown to this build, so
      //             `unknownSpace`,                      authz cannot know what it
      //             `unknownField`                       would be authorising
      //   park      `epoch`          key material        no — the body is sealed   the caller
      //   admit     —                —                   YES                       authz
      //
      // Only the `future` row is decided by a clock, and only that row is a park an authorisation
      // question could have answered. So the clock is withheld from the GATE and left where it
      // belongs — in `_log.append`, which classifies with `now()` and parks what is genuinely
      // ahead. The five shape/key parks are unchanged: they still short-circuit, because for them
      // "authorise first" is not a thing that can be done at all.
      //
      // NOTHING ELSE MOVES. This loop reads `verdict.rejected` and `verdict.rejectionOf` and
      // nothing else — not `regs`, not `admitted`, not `parked` — so withholding `nowMs` changes
      // exactly one thing: a future-stamped op is now judged by the same rules as the same op
      // stamped now. Restoring `nowMs: Date.now()` here is the mutant, and it reddens R6-4c,
      // D3-p5 and D2-s12/s14/s16/s18 × foreign.
      //
      // ── AND `ctx.myDevices` IS SUPPLIED, WHICH TAKES TWO FOLDS (A3-H4 item 3) ───────────────
      //
      // The device set is not a constant: a `dev.*` attestation register is itself an op, and it
      // can arrive in the very batch being judged (ADR 002 §6.3 — a newly paired Mac's first
      // pull carries its own attestation). So the same op set is folded twice over ONE ctx
      // builder:
      //
      //   pass 1  no `myDevices`  → learns `attestedDevices`. Stage 0a's four ADR 002 §2.3
      //                             conditions still run in full here, so a `dev.*` register
      //                             that does not verify under the member's recovery key
      //                             contributes nothing to pass 2. Without an injected
      //                             `attestOpen` NOTHING verifies and the set stays whatever
      //                             pairing supplied — fail closed, as §2.3 requires.
      //   pass 2  `myDevices`     → THE GATE. `verdict` is this one, and nothing reads pass 1.
      //
      // Pass 1 cannot admit anything pass 2 refuses, because it is strictly the weaker ctx:
      // `myDevices` only ever ADDS a rejection (`core/authz.js` stage 0b). The cost is one extra
      // fold per remote batch, over a set that is already in memory — and it is paid ONLY when
      // the identity is durable, because in solo mode `_myDevices()` is `null` by design and the
      // second fold would be identical to the first.
      const all = [...this._log.ops({ includeParked: true }), ...wellFormed];
      const devices = this._identity ? this._myDevices(foldAuthorized(all, this._authzCtx())) : null;
      verdict = foldAuthorized(all, this._authzCtx(devices ? { myDevices: devices } : {}));
    } catch (e) {
      // The gate itself could not reach a verdict. Admitting the batch ungated would break the
      // promise on the line above (`registers()` stays the authorized fold), so the batch is
      // refused — loudly, and without touching the board.
      this._warn(`remote batch refused: the authorization fold failed (${e.name}: ${e.message})`);
      for (const op of wellFormed) result.refused.push({ id: op.id, reason: 'foldFailed' });
      return result;
    }
    const rejected = Array.isArray(verdict?.rejected) ? verdict.rejected : [];
    const refused = new Set(rejected.map((o) => o && o.id));
    const reasonOf = (id) => {
      if (typeof verdict.rejectionOf !== 'function') return 'inadmissible';
      try { return verdict.rejectionOf(id)?.reason ?? 'inadmissible'; } catch { return 'inadmissible'; }
    };
    // ── E9-C §3b-b · THE FOLD'S *PARK* VERDICT NOW HAS A READER ─────────────────────────────
    //
    // `verdict.parked` used to be dropped on the floor here, and `FOLD_ONLY_PARKS` says which
    // half of it that actually cost us: `UNSHARE_SHAPE` is produced only inside `foldAuthorized`
    // stage 3a, so `_log.append`'s own `classifyOp` — which is what saves every other park
    // reason at this seam — never sees it. `{...unsharePatch, 'pub.text': 'gekapert'}` therefore
    // landed on every peer as a live op while `authz.js:1209` was still claiming that "a parked
    // op is never folded, so an admin who pads an unshare with a content write still gets no
    // write primitive". The claim is true again because this map is consulted.
    const held = new Map();
    for (const op of (Array.isArray(verdict?.parked) ? verdict.parked : [])) {
      const id = op && op.id;
      if (typeof id !== 'string') continue;
      let why = null;
      try { why = verdict.parkReasonOf(id); } catch { why = null; }
      if (FOLD_ONLY_PARKS.has(why)) held.set(id, why);
    }
    for (const op of wellFormed) {
      if (held.has(op.id) && !refused.has(op.id)) {
        const why = held.get(op.id);
        try {
          this._log.park(op, why);
          this._warn(
            `remote op ${op.id} parked: ${why} — the authorization fold could not read this patch `
            + 'as the withdrawal it declares itself to be. It is HELD, not applied and not lost, '
            + 'and re-judged by a build that can read it (ADR 001 §7.4).');
          result.refused.push({ id: op.id, reason: why, parked: true });
          continue;
        } catch (e) {
          // Already folded into the checkpoint: there is no line left to park. Fall through to a
          // refusal, which is honest about having kept nothing.
          this._warn(`remote op ${op.id}: ${why}, and it could not be parked (${e.message})`);
          result.refused.push({ id: op.id, reason: why });
          continue;
        }
      }
      if (refused.has(op.id)) {
        const why = reasonOf(op.id);
        // ── F-6 · A CURABLE REFUSAL IS PARKED, NOT DROPPED ─────────────────────────────────
        //
        // The finding, in its own words: "`applyRemote` drops a refused op without appending it,
        // so an unattested-device op that arrives before its attestation is lost rather than
        // parked." Two of `authz.js` stage 0b's verdicts are not judgements about the op at all —
        // they are judgements about what THIS DEVICE KNOWS. `notMyDevice` and `unattestedDevice`
        // both mean "I have never been shown an attestation for the author", and an attestation
        // is itself an op: it can arrive in a later page, or through pairing, minutes later.
        // Dropping the line makes that unrecoverable, because the relay's `since` filter will
        // never serve it again once the cursor has moved past it.
        //
        // So it is PARKED — ADR 001 §7.4's own vocabulary, under the reason ADR 002 §5.2.5
        // requires (`PARK_REASONS.ATTESTATION`, landed by E5). A parked line is in no register,
        // is never projected, is never offered by `outbox()`, and rides in `checkpoint().parked`
        // with its reason, so the hold survives a quit as STATE rather than as a re-fetch.
        // `oplog.load()` feeds the reason back through `classifyOp` as `haveAttestation: false`,
        // which is what stops a relaunch from quietly promoting it to live — see that flag.
        //
        // EVERY OTHER refusal is still a refusal. `foreignSpace`, `localSpace`, a forged act, a
        // malformed shape: those are verdicts about the op, no later op can change them, and
        // parking them would be a way of keeping a stranger's write on disk for ever.
        if (CURABLE_REFUSALS.has(why)) {
          try {
            this._log.park(op, PARK_REASONS.ATTESTATION);
            this._warn(
              `remote op ${op.id} parked: ${why} — this device has not been shown an attestation `
              + 'for its author yet. It is held, not lost, and re-judged when one arrives.');
            result.refused.push({ id: op.id, reason: why, parked: true });
            continue;
          } catch (e) {
            // The one case `park()` refuses: the op is already folded into the checkpoint, so
            // there is no line left to park and parking would be cosmetic. Fall through to the
            // ordinary refusal, which is honest about having kept nothing.
            this._warn(`remote op ${op.id}: ${why}, and it could not be parked (${e.message})`);
          }
        }
        this._warn(`remote op ${op.id} refused: ${why}`);
        result.refused.push({ id: op.id, reason: why });
        continue;
      }
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
      const seq = seqOf(op.id);
      try {
        this._log.append(op, seq === undefined ? {} : { seq });
        result.applied.push(op.id);
      } catch (e) {
        this._warn(`remote op ${op.id} refused by the log: ${e.name}: ${e.message}`);
        result.refused.push({ id: op.id, reason: 'log' });
      }
    }
    // ── F-6, THE OTHER HALF · A HELD OP IS RE-JUDGED, NOT MERELY KEPT ─────────────────────
    //
    // Parking would be a slower way of losing the op if nothing ever looked at it again. This
    // sweep is what closes the loop, and it costs one pass over the parked set because the
    // verdict it consults has ALREADY judged those ops: `verdict` was folded over
    // `[...this._log.ops({includeParked:true}), ...wellFormed]`, i.e. over the parked lines too.
    // So an op parked because the batch that carried its author's attestation had not arrived is
    // admitted by the very batch that carries it — same-batch and split-batch alike, with no
    // second fold and no second gate to keep in step with the first.
    //
    // `unpark` re-runs `classifyOp`, which knows nothing about devices; the AUTHORIZATION answer
    // is the one computed above, which is why the predicate is a set membership and not a
    // re-derivation.
    const stillRefused = refused;
    const cured = [];
    for (const e of this._log.parkedOps({ reason: PARK_REASONS.ATTESTATION })) {
      if (!stillRefused.has(e.op.id)) cured.push(e.op.id);
    }
    if (cured.length) {
      const ids = new Set(cured);
      const promoted = this._log.unpark((op) => ids.has(op.id));
      for (const op of promoted) {
        if (!result.applied.includes(op.id)) result.applied.push(op.id);
      }
      if (promoted.length) {
        this._warn(
          `${promoted.length} op(s) held for a missing device attestation are now authorised and `
          + 'have been applied.');
      }
    }

    // ── E9-B · THE VERDICT IS APPLIED TO THE WHOLE LOG, NOT ONLY TO THIS BATCH ─────────────
    //
    // This is finding 1, and the line above it is the bug in one sentence: everything before
    // this point judges `wellFormed` — the ops that just ARRIVED — while `verdict` was folded
    // over `[my whole log] + [this batch]` and therefore also knows which ops ALREADY IN MY LOG
    // the batch has just retroactively withdrawn. Nobody read that half, so an owner's
    // revocation reached only the ops that had not landed yet, and which ops those were was a
    // function of when this Mac happened to pull. `store.registers()` carries the argument.
    //
    // It costs nothing: the fold has already run. `_noteAuthzVerdict` records it, and only
    // re-folds the log if a LATER mutation invalidates the answer.
    this._noteAuthzVerdict(verdict);

    // ── 18.3's OWNER-SIDE HALF · the moderation is reconciled, not merely received ──────────
    //
    // ADR 004 §5's admin-unshare row: "the owner's client also sets its local `visibility` to
    // `'privat'` in a follow-up txn so the two agree." Without it, 18.3's "it reverts" is true
    // only until the owner next touches the entry — `derivePublication` reads the level from the
    // `visibility` TRUTH register and `lastPublished` from the folded `pub.level`, and after a
    // moderation those disagree, so the owner's very next keystroke re-publishes the whole
    // Geteilt patch and SILENTLY UNDOES THE MODERATION. Measured as row U3-b.
    //
    // It runs HERE, after the fold and before `_project()`, because the disagreement it closes is
    // created by the batch that just landed and the projection below is the first thing that
    // would read it.
    //
    // ⚠ IT IS APPENDED, NOT COMMITTED, AND THAT IS 18.4. `_commit` would push an undo entry, so
    // Mama's ⌘Z would "undo" Papa's moderation of her entry — an undo of something she never did.
    // `adminUnshareFollowUp` is idempotent and sorted, so re-running it after a resurrect or a
    // second pull emits nothing new.
    //
    // ⚠ IT NOTIFIES NOBODY. No marker, no warning, no „Papa hat deinen Eintrag entfernt" —
    // Principle 9, and `visibility.js:NO_SNITCH_CONTRACT.noNotification`. The ops it returns carry
    // exactly `{visibility:'privat'}` and there is no op kind that could carry a notice.
    if (this._familySpaceId !== null && result.applied.length) {
      try {
        const follow = adminUnshareFollowUp(this.registers(), { ...this._ctx(), me: this._me });
        this._armAuthz(follow);
        for (const op of follow) this._log.append(op);
      } catch (e) {
        // Never let the reconciliation cost the batch that arrived. The disagreement it closes is
        // cosmetic until the owner edits; a throw here would discard ops already admitted.
        this._warn(`the admin-unshare reconciliation could not run (${e.name}: ${e.message})`);
      }
    }

    this._stacks.remoteApplied();
    this._project();
    this.schedulePersist();
    this.emit('remote');
    return result;
  }

  /**
   * Re-judge every op parked for a missing device attestation, with no new batch to trigger it.
   *
   * `applyRemote`'s own sweep covers the case where the attestation arrives as an op. This covers
   * the case that is the ONLY one M1 has: `member.set{dev.*}` is a family-space op kind, so a
   * person with two Macs and no Familienkreis has nowhere in the log to record an attestation at
   * all, and the device set is learnt from PAIRING instead (ADR 001 §4.0's "the LOCAL device
   * set", which §2.3 says the pairing flow has to deliver). When `useIdentity()` or a pairing
   * completion widens `_peerDevices`, nothing else would ever look at the held lines again.
   *
   * @returns {string[]} the opIds that became live
   */
  unparkAttested() {
    const held = this._log.parkedOps({ reason: PARK_REASONS.ATTESTATION });
    if (!held.length) return [];
    const all = [...this._log.ops({ includeParked: true })];
    let verdict;
    try {
      const devices = this._identity ? this._myDevices(foldAuthorized(all, this._authzCtx())) : null;
      verdict = foldAuthorized(all, this._authzCtx(devices ? { myDevices: devices } : {}));
    } catch (e) {
      this._warn(`held ops could not be re-judged (${e.name}: ${e.message}); they stay parked`);
      return [];
    }
    const refused = new Set((Array.isArray(verdict?.rejected) ? verdict.rejected : []).map((o) => o && o.id));
    const ids = new Set(held.map((e) => e.op.id).filter((id) => !refused.has(id)));
    if (!ids.size) return [];
    const promoted = this._log.unpark((op) => ids.has(op.id));
    if (promoted.length) {
      this._project();
      this.schedulePersist();
      this.emit('remote');
      this._warn(
        `${promoted.length} op(s) held for a missing device attestation are now authorised and `
        + 'have been applied.');
    }
    return promoted.map((op) => op.id);
  }

  /** The op group describing what `fn` just did to `state`. */
  _diff(before, beforeSettings) {
    return this._diffBetween(before, beforeSettings, this.state, this.state.settings, this._log);
  }

  /**
   * The same diff, over two boards neither of which has to be `state`.
   *
   * `_diff` is the whole of `mutate()`; ADR 006 §5.4 needs exactly the same computation between
   * the projection of an adopted log and the projection of `board.json`'s spine, against that
   * log's registers rather than the live one's. The generalisation is the fix — the reconciler
   * IS `_diff`, unchanged, called with a different `before`.
   */
  _diffBetween(before, beforeSettings, after, afterSettings, log) {
    const ctx = this._ctx(undefined, log);
    const ops = [];
    const warn = (m) => this._warn(m);
    for (const spec of COLLECTION) {
      diffCollection(spec, ownRows(before[spec.key]), ownRows(after[spec.key]), ctx, ops, warn);
    }
    diffPads(before.scratchpads, after.scratchpads, ctx, ops, warn);
    const patch = diffSettings(beforeSettings, afterSettings, this._defaultPrefs());
    if (patch) ops.push(prefSet(ctx, patch));
    return ops;
  }

  _defaultPrefs() { return flattenPref(defaultState().settings); }

  /** Settings are configuration, not board content — not undoable (spec 5.4), never synced (17.7). */
  setSettings(patch) {
    const before = structuredClone(this.state.settings);
    Object.assign(this.state.settings, patch);
    this._pref(diffSettings(before, this.state.settings, this._defaultPrefs()));
    // ── STORY 17.3, THE LAST LINK ─────────────────────────────────────────────────────────────
    // `hiddenMembers` is the ONE pref that changes which entries are on the board rather than how
    // they look: `materialize` takes it as ctx and `entities.js:projectable` drops a foreign
    // entry whose owner is in it. Every other setting is read by the RENDERER from
    // `state.settings`, which is why `setSettings` has never re-projected — and why hiding Papa
    // changed the legend and left his entries on the board.
    //
    // Scoped to the one key on purpose: `settings.js:143,147` fire on every `input` event of a
    // range slider, and a projection per pixel is exactly the op-storm rule U6 exists to avoid.
    // `_adopt()` first, for the same reason `mutate()` does it — a direct edit to `state` that
    // the store has not seen would otherwise be reverted by the projection rather than kept.
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'hiddenMembers')) {
      this._adopt();
      this._project();
    }
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
    this._armAuthz(ops);
    for (const op of ops) this._log.append(op);
    this._project();
    // ⌘Z ON A SHARED ENTRY MUST WITHDRAW IT (ADR 004 §5.1, `core/undo.js`'s own reasoning).
    // A `pub.set` is not undoable and is never inverted; what happens instead is that the truth
    // is restored and the publisher RE-DERIVES against it — so undoing a share emits the
    // retraction, and undoing a downgrade re-publishes. Without this line the register map keeps
    // the level the user just took back, and no owner-side smoke test notices, because the
    // owner's board is right. `_project()` runs first so promotion is applied.
    if (this._publishAndEnqueue(ops, ops[0]?.gid ?? null).length) this._project();
    this._stacks.verify(this.state);
    this.schedulePersist();
    this.emit('undo');
    return true;
  }
  redo() {
    this._adopt();
    const ops = this._stacks.redo(this.state);
    if (!ops.length) return false;
    this._armAuthz(ops);
    for (const op of ops) this._log.append(op);
    this._project();
    if (this._publishAndEnqueue(ops, ops[0]?.gid ?? null).length) this._project();   // see undo()
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
    const plan = planReplaceAll(this.registers(), board, {
      mint: () => this._clock.tick(),
      me: this._me,
      deviceId: this._device,
      personalSpaceId: this._personalSpaceId,
      newOpId,
      newGid,
      defaultSettings: defaultState().settings,
    });

    // ── I-1 · PROJECT INTO A CANDIDATE, SWAP ONLY ON SUCCESS ────────────────────
    //
    // This used to be `this.state = this._blankState(); this._project(...)`, in that order, with
    // `persistNow()` two lines below and a 700 ms autosave behind it. A projection that refused
    // — an imported board with `mode:'pinned'` and an unrenderable `startMonth`, which
    // `materialize` is RIGHT to refuse — therefore threw with `state` already blanked, and the
    // next autosave committed the blank to `board.json`. Story 11.5's safety net was itself a way
    // to lose the board, and 11.3's import was the same shape.
    //
    // So the whole replacement is now rehearsed on a THROWAWAY log first. Nothing is appended to
    // the live log, nothing is retracted, `state` is not touched and no file is written until a
    // projection has been shown to succeed. A repair the rehearsal needed is carried across so
    // the commit takes the path the rehearsal proved.
    const rehearsal = this._rehearse(plan.ops);
    if (!rehearsal.ok) {
      this._warn('import refused: the board in this file cannot be drawn '
        + `(${rehearsal.detail}). Nothing was changed — the board you had is still on screen and still on disk.`);
      return false;
    }

    // APPEND, never replace (F-8). `plan.warnings` of `[]` used to erase everything the session
    // had accumulated — including the migration report the user had not been shown yet.
    if (plan.lossy) this._warn('import: this file could not be represented in full — see the entries below');
    this._warnAll(plan.warnings);
    this._authzArmed = true;                 // a whole board arrived; re-derive from scratch
    for (const op of plan.ops) this._log.append(op);
    if (rehearsal.repair) {
      this._warn(`import: ${rehearsal.repair.what} could not be drawn as given and was reset to the default; `
        + 'every note, bar, category and scratchpad in the file was imported unchanged.');
      this._log.append(prefSet(this._ctx(), rehearsal.repair.patch));
    }
    this._stacks.clear();
    this.publisher.retract(plan.retractions);    // ← the WP-3 obligation, hand-off point
    this.publisher.askToReshare(plan.reshares);  // nothing is re-shared until the user confirms

    const previous = this.state;
    this.state = this._blankState();             // v1 installs a NEW state object here
    try {
      this._project({ settings: true });
    } catch (e) {
      // Unreachable: the rehearsal projected the same ops. Kept because "unreachable" is a claim
      // about today's `materialize`, and the cost of being wrong is the board.
      this.state = previous;
      this._warn(`import refused after the rehearsal passed (${e.name}: ${e.message}); the board you had is unchanged.`);
      return false;
    }
    this.persistNow();
    this.emit('replace');
    return true;
  }

  /**
   * Rehearse a whole-board replacement on a THROWAWAY log (I-1).
   *
   * The trial log is `this._log`'s own checkpoint plus the plan's ops, so it folds to exactly the
   * registers the real replacement would produce — without the real log ever holding an op that
   * cannot be projected. Two settings repairs are tried, in the same order and for the same
   * reason as `_projectSafe`; content is never touched.
   *
   * @returns {{ok:boolean, repair:?{what:string, patch:Object}, detail:string}}
   */
  _rehearse(ops) {
    const d = defaultState().settings;
    const steps = [
      null,
      { what: 'the pinned start month (mode, startMonth, pageYears)', patch: { mode: d.mode, startMonth: d.startMonth, pageYears: d.pageYears } },
      { what: 'every setting', patch: this._defaultPrefs() },
    ];
    let base;
    try {
      base = this._log.checkpoint();
    } catch (e) {
      // The live log cannot even describe itself, so there is nothing to rehearse against. Say so
      // and let the commit path's own candidate swap be the guard.
      return { ok: true, repair: null, detail: `no rehearsal was possible (${e.name}: ${e.message})` };
    }
    let last = null;
    for (const step of steps) {
      let trial;
      try {
        trial = createOpLog({ now: () => Date.now() });
        trial.load({ checkpoint: base, tail: [] });
        for (const op of ops) trial.append(op);
        if (step) trial.append(prefSet(this._ctx(undefined, trial), step.patch));
        this._projectionOf(trial);
        return { ok: true, repair: step, detail: 'ok' };
      } catch (e) {
        last = e;
      }
    }
    return { ok: false, repair: null, detail: `${last.name}: ${last.message}` };
  }

  // ── persistence ────────────────────────────────────────────────────────────
  schedulePersist() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.persistNow(), SAVE_DEBOUNCE);
  }

  /**
   * `board.json` FIRST, AND THAT IS THE COMMIT POINT (ADR 006 R5 / §6).
   *
   * Stated once here so no future pass "fixes" the ordering: if `board.json` is the truth about
   * content, the truth file must never be BEHIND. Anything written after it can only ever be
   * behind it, and being behind is harmless for something that is only history. Invert the order
   * and a crash leaves `board.json` behind a checkpoint that is now the only copy of a note — and
   * under R3 the board would then delete it. The ordering and the authority rule are the same
   * decision seen from two sides. Pinned by INV-8 / R4-7a.
   *
   * The bytes are serialized ONCE, so the hash in the checkpoint names what was actually written.
   */
  async persistNow() {
    clearTimeout(this._saveTimer);
    // Finding 2 / I-2 step 4: a board that could not be drawn may not be replaced by the empty
    // board the app is showing instead. Read-only until the user relaunches.
    if (this.bootFailure) {
      if (!this._toldAboutReadOnly) {
        this._toldAboutReadOnly = true;
        this._warn(`a save was skipped: this session is read-only because ${readOnlyBecause(this.bootFailure)}`);
      }
      return;
    }
    this._adopt();
    await this.rollSnapshot();
    // A lineage exists exactly as long as a durable log does (ADR 006 §4.1), so solo mode still
    // writes `board.json` byte-for-byte as v1 did and creates no second key of any kind.
    if (this._opsPersisted && !this._lineageId) this._lineageId = mintLineageId();
    const text = serializeBoard(this.state, this._lineageId ? { lineageId: this._lineageId, gen: ++this._gen } : null);
    await storage.saveBoardText(text);            // ◀── THE COMMIT POINT
    this._persisted = structuredClone(this.state);
    // Everything below this line is HISTORY and may be lost to a crash. ADR 001 §9/§11: solo mode
    // writes no second file; the log becomes durable when a space is created.
    if (this._opsPersisted) await this._persistOps(boardHash(text));
  }

  /**
   * THE LOG ACTUALLY RECORDS (R5-4 · A3-M5 · ADR 006 §6, §9.2). Never called while
   * `_opsPersisted` is false, and everything it does is below the commit point (R5/INV-8).
   *
   * WHAT WAS WRONG, because it is the most consequential defect this project has had. The body
   * was `saveCheckpoint(this._log.checkpoint())` + `truncateOps(0)`, and BOTH halves were inert:
   *
   *   · `checkpoint()` folds to `resolveHorizon(opts,'read')` = `horizon ?? maxLiveStamp()`, and
   *     `horizon` is NON-NULL for any log that has been `load()`ed. So from the SECOND LAUNCH
   *     onward the persisted checkpoint was frozen at the horizon it was read with, and every op
   *     minted since was above it and simply not in the file.
   *   · nothing ever called `appendOps`, so the ops that the checkpoint did not carry had nowhere
   *     else to be. `truncateOps(0)` is `keepFromLine > 0`-guarded and means "keep everything",
   *     which was harmless only because the file it kept was always empty.
   *
   * Consequences, all measured (R5-4a-d): no op after the first persist was ever written; every
   * ordinary launch reconciled a growing number of "changes board.json carried that the log did
   * not (expected after a crash)" so the happy path and the crash path were indistinguishable
   * forever; and every entry created after the first persist was re-minted `born: true` at a
   * fresh stamp on EVERY launch, making its array position a function of when the app was opened.
   *
   * THE SHAPE ADR 006 §6 ASKS FOR — "append the new tail, checkpoint, then `truncateOps(folded)`":
   *
   *   ① APPEND what the coming checkpoint will not carry. That is the outbox of §9.2 and it is
   *      the only reason `ops.jsonl` exists. A line already committed is never written twice
   *      (`_opsCommitted`), and a PARKED line is never written at all — it rides in
   *      `checkpoint().parked` by construction, with the park reason `load()` cannot re-derive.
   *   ② COMPACT when the tail has grown (ADR 001 §7.2), which is the only thing that advances the
   *      horizon and therefore the only thing that lets ④ ever drop a line.
   *   ③ CHECKPOINT — the fold of everything at or below that horizon, plus the envelope.
   *   ④ TRUNCATE, and ONLY lines ③ already folds. The condition is checked, not assumed: if one
   *      admitted op is above the checkpoint's horizon, the tail is the only copy of it and the
   *      file is left alone. This is the half that makes a crash between ③ and ④ cost nothing.
   */
  async _persistOps(hash) {
    // ⓪ THE OUTBOX CAP — finding E5-2. One value, computed once, then imposed on ①, ② and ③
    //    alike, because the defect was precisely that ① predicted a horizon ③ then exceeded.
    //    `undefined` means "nothing is unacknowledged" — the overwhelmingly common case and the
    //    only case a solo install ever has — and every step below then behaves exactly as it did.
    const cap = this._outboxHorizonCap();

    // ① the outbox (ADR 006 §9.2)
    const pending = this._uncommittedTailLines(cap === undefined ? this._comingHorizon() : cap);
    if (pending.length) {
      await storage.appendOps(pending);
      for (const line of pending) this._opsCommitted.add(tailLineKey(line.op));
      this._tailLines += pending.length;
    }

    // ② the compaction policy (ADR 001 §7.2) — BOTH of its triggers, whichever is crossed first:
    //    `TAIL_COMPACT_AT` lines, or `TAIL_COMPACT_BYTES` measured once at launch. The byte
    //    trigger is one-shot: this compaction is what makes it false, so it is consumed here
    //    rather than re-measured on every debounced save.
    //
    //    Under a cap the horizon is passed EXPLICITLY, because `compact()`'s own default absorbs
    //    everything currently held — including an op the relay has never seen. Compaction is
    //    lossless for STATE (§7.2) and was never lossless for the OUTBOX, which is a claim about
    //    LINES. A cap of `ZERO_STAMP` means there is nothing this persist may fold at all, so the
    //    compaction is skipped rather than run for no gain.
    if (this._tailLines >= TAIL_COMPACT_AT || this._tailOverBytes) {
      this._tailOverBytes = false;
      try {
        if (cap === undefined) this._log.compact();
        else if (cap !== ZERO_STAMP) this._log.compact({ horizon: cap });
      } catch (e) {
        // A compaction that cannot run costs a bigger file and nothing else, so it is a warning
        // and never a refusal to persist — the checkpoint below is still written.
        this._warn(`op log: the tail could not be compacted (${e.name}: ${e.message}); ops.jsonl keeps growing`);
      }
    }

    // ③ the checkpoint, under the SAME cap ① was selected against
    const cp = this._stampedCheckpoint(hash, cap);
    await storage.saveCheckpoint(cp);

    // ④ drop only what ③ folds
    if (this._tailLines > 0 && !this._log.ops().some((o) => cmp(o.ts, cp.horizon) > 0)) {
      await storage.truncateOps(this._tailLines);
      this._tailLines = 0;
      // `_opsCommitted` is deliberately NOT cleared: those lines are committed to the CHECKPOINT
      // now, which is a stronger statement than "they are in the tail file", and re-appending
      // them would put back exactly what this call just dropped.
    }
  }

  /**
   * The lines the log holds that are not yet on disk and that the coming checkpoint will not
   * carry — i.e. the outbox, exactly (ADR 006 §9.2).
   *
   * Three exclusions, each load-bearing:
   *   · PARKED lines ride in `checkpoint().parked` with their reasons (A2 round 2), so writing
   *     them to the tail as well would duplicate them and, on the way back in, hand `load()` two
   *     copies of one op.
   *   · lines the coming checkpoint FOLDS (at or below the horizon it will use) are already
   *     durable in the file written two statements later, so the tail would be scratch.
   *   · lines already appended (`_opsCommitted`, keyed by opId AND body) are on disk. The body is
   *     in the key so that an envelope splice — a second body under a re-used opId (ADR 002 §5.1)
   *     — is appended rather than mistaken for the line already written; the fold is a function
   *     of the op SET, so both bodies in the file is the correct outcome, not a hazard.
   */
  _uncommittedTailLines(horizon) {
    const h = horizon === undefined ? this._comingHorizon() : horizon;
    const out = [];
    for (const line of this._log.lines()) {
      if (line.park !== null && line.park !== undefined) continue;
      if (h !== null && isStamp(line.op?.ts) && cmp(line.op.ts, h) <= 0) continue;
      if (this._opsCommitted.has(tailLineKey(line.op))) continue;
      out.push(line);
    }
    return out;
  }

  /**
   * The horizon `checkpoint()` will resolve to, computed without serializing a checkpoint to find
   * out: `horizon ?? maxLiveStamp()` — `resolveHorizon(opts, 'read')`, which is the one thing
   * R5-4 proves must not be guessed at. Null means the log holds nothing live and the checkpoint
   * will fall back to `ZERO_STAMP`, which folds nothing and keeps every line in the tail.
   *
   * It is a PREDICTION and deliberately conservative: it is computed before `compact()` may raise
   * the horizon, so it can only ever be lower than what ③ ends up folding, and a line kept in the
   * tail that the checkpoint then folds costs one write and is dropped by ④.
   */
  _comingHorizon() {
    const h = this._log.horizon();
    if (h !== null) return h;
    let max = null;
    for (const o of this._log.ops()) if (isStamp(o?.ts) && (max === null || cmp(o.ts, max) > 0)) max = o.ts;
    return max;
  }

  /**
   * **THE OUTBOX CAP — finding E5-2, and the one line that closes it.**
   *
   * WHAT WAS WRONG. ADR 003 §8.1 defines the outbox as "`ops.jsonl` lines whose `seq` is unset"
   * and promises it "survives quit and crash (19.1)". `outbox()` implements the first half
   * exactly. The second half did not hold, because a checkpoint FOLDS every op at or below its
   * horizon into `regs` and drops the LINE, and nothing capped that horizon. So an op the relay
   * had never seen was written to disk as a register VALUE and never as a LINE; `load()` brings
   * back registers rather than lines; and the next launch's outbox was empty.
   *
   * The fleet harness measured the consequence: five entries made on a laptop while it was
   * offline never reach the desktop, ever, the two boards are permanently divergent, and
   * `sync.status()` reports `healthy` throughout. Not only offline, either — the 700 ms autosave
   * debounce beats the 2 s push debounce, so an edit and a quit within two seconds took the same
   * path on a perfectly online Mac.
   *
   * THE RULE. **A persist may not fold past the oldest line the relay has not acknowledged.**
   * Same shape as ADR 001 §7.3's tombstone GC, which is already gated on `Device.lastSeenSeq` for
   * the same reason — you may not compact away what a peer has not seen. Here the peer is the
   * relay, and `outbox()` is the definition of "not seen", CALLED rather than re-derived so the
   * two cannot drift: a line the outbox stops offering (a genesis stamp, a peer's op, a
   * `local`-space op) is also a line whose survival in `ops.jsonl` nothing depends on.
   *
   * WHY IT COSTS SOLO MODE NOTHING. `_persistOps` is the only caller and runs only while
   * `_opsPersisted` is true, which `_logMayBeWritten()` gates on `_syncArmed && personalSpaceId`.
   * A solo install has no outbox, so this returns `undefined` and every step of `_persistOps`
   * takes the byte-identical path it took before — including `compact()`'s own `'advance'` mode,
   * which R5-4e depends on to bound `ops.jsonl`.
   *
   * THE RECEDING GUARD, AND THE SECOND HALF OF E5-2 — the arm that re-opened this finding.
   *
   * `oplog.resolveHorizon` throws if a horizon moves backwards, and a checkpoint written by a
   * build without this cap can legitimately already fold an unacknowledged op. Nothing can put
   * that line back, so the cap stands down and says so.
   *
   * **The condition for that stand-down is a fact about the FLOOR, not about the CAP.** The
   * round that landed this method asked `cap === null || cmp(cap, held) < 0` and returned
   * `undefined` — no cap at all — which is the opposite of standing down: it hands the log back
   * its own defaults and folds the unacknowledged line for real.
   *
   * And `cap === null` is not a rare state. It is the state EVERY compaction leaves behind: once
   * a checkpoint has folded everything below the outbox floor, there is by definition no live
   * line strictly below it any more, so `cap` is null on the next persist and every persist after
   * it. `compact ▸ author offline ▸ compact` therefore folded the edit away, `outbox()` returned
   * 0, `status()` said `healthy`, and the two Macs diverged for ever. That is E5-2, re-opened by
   * `tests/fleet/attack-converge-outbox.test.js` §1 and by `sync-domains.js`'s `S2s-compact-
   * sandwich`, `S2-R1L0A0O0`, `S3-unacked` and `S4-lost`.
   *
   * THE THREE STATES, SEPARATED. `held` is the persisted horizon: everything at or below it is
   * already folded into `regs` and its lines are already gone.
   *
   *   1 `held >= floor` — the persisted checkpoint ALREADY folds the unacknowledged op. This and
   *     only this is the unrecoverable case the guard was written for. Warn once, stand down.
   *   2 `cap === null` (and `held < floor`) — nothing live below the floor. The correct cap is
   *     the persisted horizon itself: it is already folded, so it cannot recede, and it is below
   *     the floor, so it cannot fold the line. `ZERO_STAMP` when there is no horizon yet.
   *   3 otherwise — `cap`, raised to `held` if `held` is higher, for the same no-receding reason.
   *
   * In every one of 2 and 3 the answer is a STAMP BELOW THE FLOOR, which is the invariant this
   * method exists to maintain, and `undefined` — "no cap" — is never one of them.
   *
   * @returns {string|undefined} `undefined` — no cap, use the log's own defaults; reached only in
   *          state 1 and when there is no outbox at all. A stamp — fold no further than this.
   *          `ZERO_STAMP` — fold nothing at all this time.
   */
  _outboxHorizonCap() {
    let floor = null;
    // BOTH OUTBOXES, and the union is the point. A family op this device authored is
    // unacknowledged in exactly the sense §8.1 defines, and folding it into the checkpoint drops
    // its LINE while keeping its register value — which is E5-2 verbatim, one space to the right:
    // the entry is on my board, `familyOutbox()` returns 0, `status()` says healthy, and Mama
    // never sees it. Nothing else here changes: with no family space `_syncedSpaces()` is the
    // personal space alone and every step takes the byte-identical path it took before.
    for (const sp of this._syncedSpaces()) {
      for (const line of this.outbox({ space: sp })) {
        const ts = line.op?.ts;
        if (isStamp(ts) && (floor === null || cmp(ts, floor) < 0)) floor = ts;
      }
    }
    if (floor === null) return undefined;

    const held = this._log.horizon();

    // ① The persisted horizon already folds the unacknowledged op. Unrecoverable; say so once.
    if (held !== null && cmp(held, floor) >= 0) {
      if (!this._e52Warned) {
        this._e52Warned = true;
        this._warn(
          'op log: the persisted horizon already folds an op the server has not acknowledged, so '
          + 'its line cannot be kept in ops.jsonl (finding E5-2, on a log written before the cap '
          + 'landed). The board is intact; that edit may need a re-push from this device.');
      }
      return undefined;
    }

    // Fold up to the greatest live stamp STRICTLY below the floor, and no further.
    let cap = null;
    for (const o of this._log.ops()) {
      if (!isStamp(o?.ts) || cmp(o.ts, floor) >= 0) continue;
      if (cap === null || cmp(o.ts, cap) > 0) cap = o.ts;
    }

    // ② and ③. `held` is below the floor here, so raising the cap to it is always safe and is
    // never a recession. Both arms return a stamp; neither returns "no cap".
    if (cap === null) return held === null ? ZERO_STAMP : held;
    return held !== null && cmp(cap, held) < 0 ? held : cap;
  }

  /**
   * `oplog.checkpoint()` plus the ADR 006 §4.2 envelope `init()` reads on the way back in.
   *
   * `lineageId` is the WHOLE verdict and is frozen forever. `gen` is frozen too and is consulted
   * by nothing — it exists so a support bundle can say which generation of `board.json` a fold
   * belongs to. `boardHash` is over the exact bytes `persistNow` just wrote and chooses a fast
   * path; it never gates, which is why 32 bits is enough. `v` is a version for humans and for a
   * future migration — a version this build does not know IS NOT A REFUSAL (R4-3a).
   *
   * `core/oplog.js` neither writes nor reads `lzp` — the log has no business knowing what a v1
   * board file is — and `load()` ignores keys it does not recognise, so the envelope costs the
   * format nothing.
   */
  _stampedCheckpoint(hash, horizon) {
    // `horizon` is `_outboxHorizonCap()` (finding E5-2). `undefined` — no cap — keeps the log's
    // own `resolveHorizon(opts,'read')` default, which is what every solo persist uses.
    const cp = this._log.checkpoint(horizon === undefined ? {} : { horizon });
    return {
      ...cp,
      lzp: {
        v: LZP_CHECKPOINT_ENVELOPE,
        lineageId: this._lineageId,
        gen: this._gen,
        boardHash: hash ?? null,
        horizon: cp.horizon,
        at: Date.now(),
        // ── L-1 · THE REFUSAL LEDGER RIDES HERE ──────────────────────────────────────────────
        // `lzp` is the STORE's half of the checkpoint — `core/oplog.js` neither writes nor reads
        // it — which makes it the one place a fact the LOG has no line for can be made durable.
        // A refused envelope is exactly that: it never became an op, so there is nothing for
        // `parked` or `regs` to carry, and the cursor is already past it.
        //
        // It rides BELOW the commit point for the same reason the cursor does (ADR 006 §9.1 W1):
        // `_persistOps` runs strictly after `saveBoardText`, so a crash between the two loses the
        // record and re-pulls the op, which re-derives the same refusal. Losing it in that
        // direction is free; the direction that is not free is losing it at every quit.
        refusals: this._syncRefusalsForDisk(),
        // ── P-4 · AND SO DOES THE CHAIN VERDICT, FOR THE SAME REASON, AT LAST ────────────────
        //
        // These two fields are declared in ONE docblock above (`syncRefusals`, `syncChain`) for
        // one stated reason — "facts about bytes that are GONE" — and for two rounds only the
        // first of them rode here. The cost was measured as S4c in `tests/property/
        // sync-domains.test.js`: a Mac that spent a whole session correctly saying the relay's
        // stream did not add up quits, relaunches, and reports `healthy` over a board that is
        // still missing the appointment. `init()` nulls `syncChain`, no checkpoint carried it,
        // and so the only thing that could ever speak up again was a successful pull — from the
        // relay the accusation is ABOUT.
        //
        // IT DOES NOT BECOME AN UN-CLEARABLE RED LIGHT, which is the failure this whole round
        // exists to avoid. `sync/personal.js` clears the field (`store.syncChain = null`) on the
        // first pull carrying POSITIVE EVIDENCE — freshly folded rows, or an owed row delivered
        // — so a restored verdict lasts exactly until the relay proves itself and no longer. An
        // honest relay repeating itself does not clear it and must not: that is R8-1a.
        chain: this._syncChainForDisk(),
      },
    };
  }

  /**
   * The chain verdict, bounded and stripped for the disk.
   *
   * WHAT MAY RIDE: the finding KIND, the seq it is about, the seq a gap counted from, and the
   * human detail string `chain.js` wrote. That is the same four facts `diagnostics().sync.chain`
   * already publishes to a settings sheet.
   *
   * WHAT MAY NOT, and why this is a projection rather than a `JSON.stringify` of the object: 21.3
   * forbids ciphertext in anything a person can screenshot or mail to support, and a finding is
   * built beside envelopes. Dropping unknown fields HERE rather than at the display is the same
   * rule `status.js shelvedDetail()` follows — a field dropped at the display is a field the next
   * display forgets to drop — and it also keeps a future `chain.js` from silently widening what
   * this file writes to disk.
   */
  _syncChainForDisk() {
    const c = this.syncChain;
    if (!c || typeof c !== 'object' || c.ok !== false) return null;
    const all = Array.isArray(c.findings) ? c.findings : [];
    const kept = all.slice(0, CHAIN_FINDING_CAP).map((f) => {
      const row = { kind: String((f && f.kind) ?? '') };
      if (f && f.seq !== undefined && f.seq !== null) row.seq = String(f.seq);
      if (f && f.from !== undefined && f.from !== null) row.from = String(f.from);
      if (f && typeof f.detail === 'string') row.detail = f.detail;
      return row;
    });
    return {
      kind: typeof c.kind === 'string' ? c.kind : 'chain',
      findings: kept,
      at: Number.isFinite(c.at) ? c.at : 0,
    };
  }

  /**
   * The refusal ledger, bounded for the disk.
   *
   * `REFUSAL_LEDGER_CAP` entries, MOST RECENT KEPT. A device being fed forged envelopes by a
   * hostile relay would otherwise grow `checkpoint.json` without bound, and the hundredth
   * identical refusal tells the user nothing the first one did not. The count under-reports past
   * the cap and that is stated rather than hidden: every consumer of `diagnostics().sync.refused`
   * asks `> 0`, and the cap does not change that answer.
   */
  _syncRefusalsForDisk() {
    const all = Array.isArray(this.syncRefusals) ? this.syncRefusals : [];
    const kept = all.length > REFUSAL_LEDGER_CAP ? all.slice(all.length - REFUSAL_LEDGER_CAP) : all;
    return kept.map((r) => ({
      oid: String(r && r.oid), seq: String(r && r.seq), reason: String(r && r.reason),
      at: Number.isFinite(r && r.at) ? r.at : 0,
    }));
  }

  /**
   * ── R8-4's OTHER HALF · A CURED REFUSAL IS RETRACTED ─────────────────────────────────────────
   *
   * The refusal ledger was built for a refusal that is FINAL: a bad signature, a failed AEAD, an
   * op nothing will ever be able to open. The cursor is released past it, the relay will never
   * offer it again, and the record is the only thing left — so it is durable, and durable is
   * right.
   *
   * Round 9 made one class of refusal survivable and the ledger did not notice. The parking lot's
   * ladder gives up on an envelope whose attestation had not landed within `maxDeferrals` pulls;
   * `refuse()` now SHELVES those bytes instead of destroying them, and the next launch revives
   * them. When one of those revivals opens, the divergence the ledger reports has HEALED — and
   * without this the Mac keeps saying `error` about it for the rest of the device's life, which
   * is round 8's own failure (`healthy` while wrong) pointing the other way. An indicator that
   * cannot go out is an indicator nobody reads.
   *
   * Retraction is by `oid` and it is not a lie about history: the op is in the log, folded into
   * the registers, and `checkpoint().seqs` says so. Nothing else can call this — `sync/personal.js`
   * calls it only for oids the STORE itself reported in `applyRemote(…).applied`, so a hostile
   * relay cannot clear a verdict by asserting one.
   *
   * @param {string|string[]} oids the op ids that have now applied
   * @returns {number} how many ledger rows were retracted
   */
  retractSyncRefusal(oids) {
    if (!Array.isArray(this.syncRefusals) || this.syncRefusals.length === 0) return 0;
    const cured = new Set(Array.isArray(oids) ? oids : [oids]);
    const before = this.syncRefusals.length;
    this.syncRefusals = this.syncRefusals.filter((r) => !(r && cured.has(r.oid)));
    const n = before - this.syncRefusals.length;
    if (n > 0) {
      this._warn(
        `sync: ${n} change${n === 1 ? '' : 's'} that an earlier session had given up on `
        + `${n === 1 ? 'has' : 'have'} now arrived and been applied. The earlier refusal is `
        + 'withdrawn — nothing is diverged (R8-4).');
    }
    return n;
  }

  /**
   * ── L-1, THE OTHER HALF: READ THE LEDGER BACK ────────────────────────────────────────────────
   *
   * Called from `init()` with the checkpoint that was actually adopted, and ONLY then. A
   * quarantined log's checkpoint is bytes this store has just refused to believe about the board;
   * believing its refusal ledger instead would be reporting an error on the authority of a file
   * the same launch decided it could not trust.
   *
   * A malformed entry is DROPPED rather than thrown on: this runs inside `init()`, and A3-H1
   * ("anything thrown on the way in is a quarantine, never a dead app") applies to a diagnostics
   * ledger with more force than it does to the log itself.
   */
  _restoreSyncLedger(checkpoint) {
    const lzp = checkpoint && typeof checkpoint === 'object' ? checkpoint.lzp : null;
    const rows = lzp && typeof lzp === 'object' && Array.isArray(lzp.refusals) ? lzp.refusals : [];
    const out = [];
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      if (typeof r.oid !== 'string' || typeof r.reason !== 'string') continue;
      out.push({
        oid: r.oid,
        seq: typeof r.seq === 'string' ? r.seq : String(r.seq ?? '0'),
        reason: r.reason,
        at: Number.isFinite(r.at) ? r.at : 0,
      });
      if (out.length >= REFUSAL_LEDGER_CAP) break;
    }
    this.syncRefusals = out;

    // ── P-4 · THE CHAIN VERDICT, READ BACK ───────────────────────────────────────────────────
    //
    // Same gate as the refusals above (`this.quarantine` — a log this launch refused takes its
    // whole ledger with it), same total-parser discipline: a malformed entry is DROPPED, never
    // thrown on, because this runs inside `init()`.
    //
    // A restored verdict is restored as `ok: false` and NOT re-derived, which is the point: this
    // device cannot re-check a page it will never be served again, so what rides is the record of
    // a check that already happened. `at` is kept as written so the detail pane can say WHEN,
    // rather than claiming the launch discovered it.
    const c = lzp && typeof lzp === 'object' ? lzp.chain : null;
    const rawFindings = c && typeof c === 'object' && Array.isArray(c.findings) ? c.findings : null;
    if (rawFindings) {
      const findings = [];
      for (const f of rawFindings) {
        if (!f || typeof f !== 'object' || typeof f.kind !== 'string' || f.kind === '') continue;
        const row = { kind: f.kind };
        if (typeof f.seq === 'string') row.seq = f.seq;
        if (typeof f.from === 'string') row.from = f.from;
        if (typeof f.detail === 'string') row.detail = f.detail;
        findings.push(row);
        if (findings.length >= CHAIN_FINDING_CAP) break;
      }
      // An EMPTY findings list is not a verdict. `status.js` reads `sync.chain` as a flag, so a
      // `{ok:false, findings:[]}` would light the indicator with nothing behind it to show — the
      // "not evidence" shape round 10 spent a whole item keeping out of this field.
      if (findings.length) {
        this.syncChain = {
          ok: false,
          kind: typeof c.kind === 'string' && c.kind !== '' ? c.kind : 'chain',
          findings,
          at: Number.isFinite(c.at) ? c.at : 0,
        };
      }
      // ⚠ AND NO `_warn()` HERE, WHICH IS THE DIFFERENCE BETWEEN THIS FIELD AND THE REFUSALS.
      //
      // The restore above is deliberately silent on the warning channel, and it was measured
      // getting this wrong first: a `_warn` on restore turned S4c's second half red with
      // `'warnings' !== null` — the Mac caught up, `syncChain` was correctly cleared by the
      // evidence, and the warning outlived it, so the indicator stayed lit on a device with
      // nothing left to tell anybody. That is the un-clearable red light in a different field.
      //
      // The two ledgers differ in exactly this: a REFUSAL is permanent (the bytes are gone and
      // will never be offered again), so a channel with no lifecycle fits it. A CHAIN VERDICT is
      // withdrawable by definition — `personal.js` clears it on positive evidence — so it may
      // only ride in a channel that can be withdrawn too. `syncChain` is that channel:
      // `diagnostics().sync.chain` is non-null from the first millisecond of the launch,
      // `status.js` enumerates it as a flag, and the first verifying pull takes it away again.
      // `warnings` has no such door — `clearWarnings()` runs at `init()` and nowhere else.
    }

    if (out.length) {
      this._warn(
        `sync: ${out.length} change${out.length === 1 ? '' : 's'} from another device `
        + `${out.length === 1 ? 'was' : 'were'} refused by an earlier session and cannot be `
        + 'fetched again. Nothing here was changed, and nothing was lost on the device that made '
        + `${out.length === 1 ? 'it' : 'them'} (finding L-1).`);
    }
  }

  /**
   * Synchronous last-chance write for pagehide/beforeunload.
   *
   * It writes the board and no log files, so the board moves without the checkpoint — which is
   * exactly the "ahead" state, and reconciliation handles it (ADR 006 §6). `gen` deliberately
   * does NOT advance here; nothing reads `gen`, which is why nothing reads `gen`.
   */
  flushSync() {
    if (!this.ready || this.bootFailure) return;
    clearTimeout(this._saveTimer);
    if (storage.isTauri()) { this.persistNow(); return; }
    storage.saveBoardSyncText(
      serializeBoard(this.state, this._lineageId ? { lineageId: this._lineageId, gen: this._gen } : null),
    );
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
  /**
   * I-1 — the return value is now the truth. `replaceAll` refuses a board it cannot draw and
   * leaves everything alone; a `restoreSnapshot` that returned `true` regardless would tell
   * `settings.js:224-254` that the restore happened when nothing did.
   */
  restoreSnapshot(day) {
    const s = this.snapshots.find((x) => x.day === day);
    if (!s) return false;
    return this.replaceAll(structuredClone(s.state)) !== false;
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
