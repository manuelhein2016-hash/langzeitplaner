// TIER 1 · AUDIT — PASS 3, THE `_buildSpine` SWEEP
//
// „the neighbouring defect just fixed: `migrateV1` re-authoring a foreign entry as the
//  viewer's own Privat note, once per launch. That family of bug — the spine
//  re-migrating `board.json` every launch under ADR 006 — deserves its own sweep. What
//  else does `_buildSpine` re-author?"
//
// This is the sweep, as rows rather than as prose. It answers three questions:
//
//   §S1  WHAT CAN THE SPINE AUTHOR AT ALL? Every op `migrateV1` emits, classified by
//        `core/ops.js:OP_KINDS`. If any of them were a FAMILY-space kind, the spine
//        could re-author somebody else's writing by construction. None is. GREEN.
//   §S2  WHEN DO THE SPINE'S OPS ACTUALLY BECOME THE LOG? On the ordinary launch they
//        do not: `store.js:_adoptHistory` returns `history`, and the spine is used only
//        as the projection the log is diffed AGAINST. The re-authoring window is the
//        THREE branches where the spine IS the log. Read, cited, and bounded. GREEN.
//   §S3  THE RESIDUAL. `withoutForeignEntries` recognises another member's entry by
//        `isForeign === true` or by an `entityKey` matching `^f(note|bar):` — the two
//        fields `stripV2Fields` REMOVES — and not by `id`, which survives the strip and
//        still spells `fnote:<memberId>/<uuid>`. AMBER: latent, reachability stated exactly.
//   §S4  `migrateV1` authors every own entry at `visibility: 'privat'`, discarding the
//        `visibility: 'geteilt'` that a family Mac's `board.json` actually carries.
//        Measured, with the two things that stop it mattering named. AMBER.
//
// ⚠ READ THE VERDICTS THE RIGHT WAY ROUND. All five rows PASS, and two of them
// (§S3, §S3b, §S4) pass BECAUSE the behaviour they describe is present. They are
// CHARACTERIZATION rows, not red-on-arrival ones, because neither §S3 nor §S4 is a live
// defect in this build — both are latent, and each assertion message says in so many
// words what it will mean when the row goes red („…and this row is obsolete"). A reader
// who sees `5 pass` and concludes „nothing found here" has read them backwards. The
// red-on-arrival findings of this pass are in `tests/audit/display-integrity.dom.js`.
//
// Zero npm dependencies; `node --test`.
// ─────────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';

import { migrateV1 } from '../../src/js/core/migrate1to2.js';
import { stripV2Fields, toV1Board, V1_ENTRY_FIELDS } from '../../src/js/core/materialize.js';
import { OP_KINDS } from '../../src/js/core/ops.js';
import { FAMILY_KINDS, TRUTH_KINDS } from '../../src/js/core/entities.js';

const ME = 'mem_' + 'A'.repeat(22);
const MAMA = 'mem_' + 'Z'.repeat(22);
const MAC = 'dev_' + 'A'.repeat(22);
const CTX = Object.freeze({ memberId: ME, deviceId: MAC, acceptLossy: true });

/** `store.js:withoutForeignEntries`, reproduced verbatim — it is module-private. */
const isForeignByGuard = (e) => !!e && typeof e === 'object'
  && (e.isForeign === true
    || (typeof e.entityKey === 'string' && /^f(?:note|bar):/.test(e.entityKey)));

const CATS = [{ id: 'c1', name: 'Allgemein', nameEn: 'General', paletteRef: 'blau', visible: true }];

/** A board as a FAMILY Mac writes it, AS `_buildSpine` RECEIVES IT.
 *
 *  `store.js:persistNow` writes `serializeBoard(this.state)` and `this.state` is
 *  `this._familySpaceId ? full : stripV2Fields(full)` (`store.js:2968`) — so on a family Mac
 *  `board.json` is the FULL v2 board, `schemaVersion: 2`, foreign entries and all.
 *  `init()` then runs `migrate(board0)`, which rewrites `schemaVersion` to `SCHEMA_VERSION`
 *  (= 1, `store.js:196`) and passes the ENTRY OBJECTS THROUGH BY REFERENCE — so every v2 field
 *  is still on them when `migrateV1` sees them. That pairing is what §S4 is about, and it is
 *  also why `migrateV1`'s own `schemaVersion: 2` refusal never fires on this path. */
const familyBoard = () => ({
  schemaVersion: 1,
  notes: [
    { id: 'own-uuid-1', uuid: 'own-uuid-1', entityKey: 'note:own-uuid-1',
      date: '2026-09-12', text: 'Omas Geburtstag', categoryId: 'c1', repeatsYearly: false,
      isForeign: false, ownerId: ME, visibility: 'geteilt', coEdit: false,
      exposure: { level: 'geteilt', pending: false } },
    { id: `fnote:${MAMA}/mama-uuid-1`, uuid: 'mama-uuid-1', entityKey: `fnote:${MAMA}/mama-uuid-1`,
      date: '2026-09-14', text: 'Chorprobe', repeatsYearly: false,
      isForeign: true, ownerId: MAMA, level: 'geteilt', redacted: false,
      memberColorRef: 'magenta', initial: 'M' },
  ],
  bars: [
    { id: `fbar:${MAMA}/mama-uuid-2`, uuid: 'mama-uuid-2', entityKey: `fbar:${MAMA}/mama-uuid-2`,
      startDate: '2026-10-01', endDate: '2026-10-08', label: 'Kur',
      isForeign: true, ownerId: MAMA, level: 'geteilt', memberColorRef: 'magenta', initial: 'M' },
  ],
  categories: CATS,
  scratchpads: { '2026-09': 'Steuerunterlagen' },
  settings: { lastCategoryId: 'c1', rowHeight: 22, layers: { feiertage: true } },
});

// ═════════════════════════════════════════════════════════════════════════════════
// §S1 · THE SPINE CAN ONLY EVER AUTHOR THE VIEWER'S OWN TRUTH
// ═════════════════════════════════════════════════════════════════════════════════

test('§S1 · every op the spine emits is a personal- or local-space kind, never a family one', () => {
  const board = familyBoard();
  // The guard `_buildSpine` applies before calling `migrateV1`.
  const own = {
    ...board,
    notes: board.notes.filter((n) => !isForeignByGuard(n)),
    bars: board.bars.filter((b) => !isForeignByGuard(b)),
  };
  const r = migrateV1(own, CTX);

  const kinds = [...new Set(r.ops.map((o) => o.k))].sort();
  const spaces = kinds.map((k) => `${k} → ${OP_KINDS[k].space} (${OP_KINDS[k].entities.join(',')})`);
  for (const s of spaces) console.log('   ' + s);

  const familyOps = kinds.filter((k) => OP_KINDS[k].entities.some((e) => FAMILY_KINDS.includes(e)));
  assert.deepEqual(familyOps, [],
    `the spine emits a FAMILY-space op kind, so it can re-author another member's writing: `
    + JSON.stringify(familyOps));
  for (const k of kinds) {
    assert.ok(OP_KINDS[k].entities.every((e) => TRUTH_KINDS.includes(e)),
      `${k} writes an entity kind that is not one of the viewer's own truth kinds`);
  }
  // The corollary, said out loud: `cat`, `pad` and `pref` have no family counterpart at
  // all (there is no `fcat:`/`fpad:` in ENTITY_KINDS), so re-authoring a category, a
  // scratchpad or a preference as mine every launch is not a laundering — they ARE mine.
  console.log(`   ${kinds.length} kinds, ${r.ops.length} ops, 0 of them family-space`);
});

// ═════════════════════════════════════════════════════════════════════════════════
// §S2 · THE SPINE'S OPS REACH THE LOG ON THREE BRANCHES, NOT ON THE ORDINARY LAUNCH
//
// `store.js:init()`:
//     const spine = this._buildSpine(board, { restamp: !!binding });
//     if (!hasLog)              this._log = spine;                          ← ① solo / first run
//     else if (!verdict.ok)   { this._log = spine; this._quarantineLog(…); } ← ② refused log
//     else  this._log = this._adoptHistory(spine, checkpoint, tail, verdict);
//
// and `_adoptHistory` (store.js:2782) returns `history` on the happy path. The spine is
// consumed there as `mine = this._projectionOf(spine)`, the BOARD side of
// `_reconcileOntoBoard`'s diff — its ops are never appended. It returns `spine` only on
// its own four bail-outs (unreadable log, clock skew, refused stamp, reconcile-failed),
// each of which quarantines. ← ③
//
// This row pins the shape of that reasoning where a future reader will trip over it: the
// spine is a projection input on the ordinary launch and a LOG only when there is no
// history to adopt. A regression that made it the log unconditionally would put the
// whole board back at GENESIS stamps every launch.
// ═════════════════════════════════════════════════════════════════════════════════

test('§S2 · the spine of a board with no log asserts exactly the viewer’s own board, once', () => {
  const board = familyBoard();
  const own = {
    ...board,
    notes: board.notes.filter((n) => !isForeignByGuard(n)),
    bars: board.bars.filter((b) => !isForeignByGuard(b)),
  };
  const r = migrateV1(own, CTX);
  const keys = r.ops.map((o) => o.e);
  console.log('   entities the spine asserts: ' + JSON.stringify(keys));

  // Nobody else's entity key is in it — the property `withoutForeignEntries` exists for.
  const foreignKeys = keys.filter((k) => /(^|:)f(note|bar):/.test(k) || k.includes(MAMA));
  assert.deepEqual(foreignKeys, [],
    `the spine asserts an entity that belongs to another member: ${JSON.stringify(foreignKeys)}`);
  // And exactly one op per entity — a spine that grew per launch is the LZP-1002 shape.
  assert.equal(new Set(keys).size, keys.length,
    'the spine asserts the same entity twice; a per-launch spine that grows is the defect');
  // Every stamp is GENESIS (all-zero device short, ADR 001 §8.1) before any re-stamp.
  const nonGenesis = r.ops.filter((o) => !String(o.ts).endsWith('0'.repeat(16)));
  assert.deepEqual(nonGenesis.map((o) => o.ts), [],
    'a migration op carries a device short, so two Macs migrating one board.json disagree');
});

// ═════════════════════════════════════════════════════════════════════════════════
// §S3 · THE RESIDUAL — THE GUARD LOOKS AT THE TWO FIELDS THE STRIP REMOVES
//
// `store.js:withoutForeignEntries` recognises another member's entry by
//
//     e.isForeign === true  ||  /^f(?:note|bar):/.test(e.entityKey)
//
// `materialize.js:stripV2Fields` keeps `V1_ENTRY_FIELDS` and nothing else:
//
//     note: ['id', 'date', 'text', 'categoryId', 'repeatsYearly']
//
// so BOTH markers are gone from a stripped row — while `id` survives and, for a foreign
// entry, still literally spells `fnote:<memberId>/<uuid>`. The guard does not look at `id`.
//
// ── REACHABILITY, EXACTLY ────────────────────────────────────────────────────────
// `stripV2Fields` filters `!isForeign` BEFORE it strips, so no writer in this build
// emits a stripped foreign row: not `persistNow` (solo), not `exportJSON` (11.2), not
// `rollSnapshot` (11.5). This is therefore a LATENT gap in a defence-in-depth guard and
// NOT a live leak. It matters because the guard exists precisely to survive the day some
// other path puts a foreign entry in that file — and against the file format this app
// writes in solo mode, it is blind. The one marker that survives every strip is the one
// it does not read.
// ═════════════════════════════════════════════════════════════════════════════════

test('§S3 · a stripped foreign row is invisible to the guard, and is re-authored as mine', () => {
  const board = familyBoard();

  // What the strip does today: the foreign rows are filtered out first, which is why
  // this is latent rather than live.
  const strippedToday = toV1Board(board);
  console.log('   toV1Board(family board).notes = ' + JSON.stringify(strippedToday.notes));
  assert.equal(strippedToday.notes.length, 1, 'today the strip filters foreign rows before stripping');
  assert.equal(strippedToday.bars.length, 0, 'today the strip filters foreign bars too');

  // The SHAPE the guard would have to survive: the same strip, without that filter.
  const keepOnly = (kind) => {
    const allow = new Set(V1_ENTRY_FIELDS[kind]);
    return (e) => Object.fromEntries(Object.entries(e).filter(([k]) => allow.has(k)));
  };
  const strippedRow = keepOnly('note')(board.notes[1]);
  console.log('   the same foreign note, stripped: ' + JSON.stringify(strippedRow));

  assert.equal(isForeignByGuard(board.notes[1]), true,
    'precondition: unstripped, the guard sees it — this is why the family path is safe');
  assert.equal(isForeignByGuard(strippedRow), false,
    'the guard already reads the stripped row correctly, and this row is obsolete');
});

test('§S3b · what the spine then writes: another member’s note, minted as mine at Privat', () => {
  const board = familyBoard();
  const keepOnly = (kind) => {
    const allow = new Set(V1_ENTRY_FIELDS[kind]);
    return (e) => Object.fromEntries(Object.entries(e).filter(([k]) => allow.has(k)));
  };
  const hostile = {
    schemaVersion: 1,
    notes: [keepOnly('note')(board.notes[1])],       // Mama's Chorprobe, markers stripped
    bars: [],
    categories: CATS,
    scratchpads: {},
    settings: { lastCategoryId: 'c1', layers: {} },
  };
  // `_buildSpine` would pass this straight through — the guard answered "not foreign".
  assert.equal(isForeignByGuard(hostile.notes[0]), false, 'precondition: the guard lets it through');

  const r = migrateV1(hostile, CTX);
  for (const w of r.warnings) console.log('   warning: ' + w);
  const notes = r.ops.filter((o) => o.k === 'note.set');
  for (const o of notes) console.log(`   ${o.k} ${o.e} ${JSON.stringify(o.f)}`);

  assert.equal(notes.length, 1, 'the spine authored something other than one note');
  const op = notes[0];
  assert.equal(op.f.text, 'Chorprobe', 'precondition: it is her text that was re-authored');
  assert.equal(op.f.visibility, 'privat',
    'the entry survived as something other than the viewer’s own Privat note, and this row is obsolete');
  // And the owner is not merely lost, he is UNRECOVERABLE: `migrateV1` refuses the
  // `fnote:<mem>/<uuid>` string as an id and mints a derived one, so the resulting
  // `note:<mint>` names nobody. Nothing downstream can undo this by inspection.
  assert.ok(!op.e.includes(MAMA),
    `the minted key still carries the real owner (${op.e}), so the re-authoring is at least reversible `
    + '— and this row is obsolete');
  assert.match(op.e, /^note:/,
    'the re-authored entry is a personal-space `note:` entity — the viewer’s own truth');
});

// ═════════════════════════════════════════════════════════════════════════════════
// §S4 · WHAT ELSE THE SPINE DISCARDS: MY OWN `visibility`
//
// `store.js:COLLECTION` gives the note constructor `born: { visibility: 'privat',
// coEdit: false }` and `fields: ['date','text','categoryId','repeatsYearly']`. The
// comment above it says the v2 additions are "never inferred from a v1 entry object,
// which cannot carry them" — and on a FAMILY Mac `board.json` is the full v2 board
// (`store.js:2968`), so the entry object CAN carry them and the spine still ignores it.
//
// A launch therefore re-derives my own shared note as Privat. Two things stop that
// mattering, and both are worth naming because a change to either makes it matter:
//
//   1. On the ordinary launch the spine's ops are never appended (§S2). They are the
//      BOARD side of `_reconcileOntoBoard`'s diff, and `_diffBetween`/`sameV1Content`
//      compare v1 CONTENT only — `visibility` is in `born`, not in `fields`, so it is
//      written only for an entity the log does not already hold.
//   2. On the branches where the spine IS the log (§S2 ① and ②) there is no folded
//      `visibility: 'geteilt'` left to lose: the log that carried it was refused or
//      never existed, and ADR 006 §9.3's re-join republishes from scratch.
//
// So this is AMBER: measured, understood, not currently harmful, and one edit away from
// being a silent unshare of every entry on the board. Recorded rather than filed.
// ═════════════════════════════════════════════════════════════════════════════════

test('§S4 · the spine authors my own Geteilt entry as Privat, discarding what board.json says', () => {
  const board = familyBoard();
  const mine = board.notes[0];
  assert.equal(mine.visibility, 'geteilt', 'precondition: board.json says this note is shared');

  const own = { ...board, notes: [mine], bars: [] };
  const r = migrateV1(own, CTX);
  const op = r.ops.find((o) => o.k === 'note.set');
  console.log(`   board.json says visibility=${JSON.stringify(mine.visibility)}, `
    + `exposure=${JSON.stringify(mine.exposure)}`);
  console.log(`   the spine writes ${JSON.stringify(op.f)}`);

  assert.equal(op.f.visibility, 'privat',
    'the spine already carries the visibility board.json holds, and this row is obsolete');
  assert.equal(op.f.coEdit, false, 'and coEdit, likewise, is a born default rather than a read');
  // The measurement that makes the risk concrete: nothing in the emitted field set
  // mentions the entry's real disclosure at all.
  assert.deepEqual(Object.keys(op.f).filter((k) => k === 'exposure' || k === 'level'), [],
    'the spine carries a disclosure field it should not');
});
