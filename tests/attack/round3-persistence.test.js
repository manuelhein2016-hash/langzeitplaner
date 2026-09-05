// ─────────────────────────────────────────────────────────────────────────────
// ROUND 3 — ADVERSARY, ATTACK 4: ops.jsonl + checkpoint.json + board.json MUST AGREE
//
// The retrofit's whole safety argument in solo mode is ADR 001 §8.4's idempotence predicate:
// `shouldMigrate(board, {opsLogExists})`. It has exactly one input about the log — "does one
// exist?" — and NO input about whether that log has anything to do with THIS board. The store
// then takes the branch and, on the log branch, throws `board.json` away:
//
//     this._log.load({ checkpoint, tail });
//     this.state = this._blankState();
//     this._project({ settings: true });        // ← the board is now whatever the log says
//
// and `persistNow()` writes that back over `board.json` — which in solo mode IS the checkpoint.
//
// So: put ONE line in `ops.jsonl` and the user's board is gone from every file on disk, with no
// warning, on the first autosave. That is this file's first row and it is the worst thing round 3
// found.
//
// REACHABILITY, STATED HONESTLY — AND RE-STATED AFTER ROUND 5. As filed, this paragraph read
// "`store.js` never writes `ops.jsonl` today", which was true of SOLO MODE and was then quietly
// read as true of the store. R5-4 found the rest: `_persistOps` never called `appendOps` at all,
// on any path, so the file could not exist even with `_opsPersisted` on — and that was not a
// dormant gap but the thing making every launch after the first reconcile a growing diff. It is
// closed (R3-39 is inverted below; R5-4a-f own it in full). What remains true is the narrower
// claim R3-38 actually pins: SOLO mode writes exactly the two v1 slots and no third file. The
// precondition for this file's attacks therefore arrives with WP-8 turning `_opsPersisted` on —
// which it now genuinely does, rather than "one day might".
//
// Rows tagged `SUCCEEDED (defect)` are green BECAUSE the defect is there.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { localStorage as LS, resetStorage, seedBoard } from '../helpers/env.js';
import { store } from '../../src/js/store.js';
import * as storage from '../../src/js/storage.js';
import { serializeRegisters } from '../../src/js/core/registers.js';
import { readFileSync } from 'node:fs';

const BOARD_KEY = 'langzeitplaner.board';
const OPS_KEY = 'langzeitplaner.ops';
const CHECKPOINT_KEY = 'langzeitplaner.checkpoint';
const SNAP_KEY = 'langzeitplaner.snapshots';

const CATS = () => [{ id: 'c1', name: 'Arbeit', nameEn: 'Work', paletteRef: 'blau', visible: true }];
const RICH = () => ({
  schemaVersion: 1,
  notes: Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, date: `2026-0${i + 1}-04`, text: `Termin ${i}`, categoryId: 'c1', repeatsYearly: false })),
  bars: [{ id: 'b1', startDate: '2026-03-01', endDate: '2026-03-20', label: 'Urlaub', categoryId: 'c1' }],
  categories: CATS(),
  scratchpads: { '2026-03': 'Einkaufsliste' },
  settings: {
    bundesland: 'BY', layers: { feiertage: true, schulferien: true, otherStates: false, ferienPattern: false },
    mode: 'rolling', startMonth: '2026-01', pageYears: 0, language: 'de',
    launchAtLogin: false, menuBarIcon: true, rowHeight: 22, colWidth: 118,
    paper: 'a4', lastCategoryId: 'c1', seenFirstRun: true,
  },
});

/** One well-formed op line, of the kind WP-8's puller will one day write. */
const ONE_OP = {
  v: 1,
  id: 'AAAAAAAAAAAAAAAAAAAAAA',
  ts: '0001787836800000.000000.0000000000000000',
  act: `mem_${'A'.repeat(22)}`,
  dev: `dev_${'A'.repeat(22)}`,
  gid: 'BBBBBBBBBBBBBBBBBBBBBB',
  space: 'personal',
  k: 'note.set',
  e: 'note:zz',
  f: { text: 'ghost' },
};

const quiet = () => clearTimeout(store._saveTimer);

/** A cold start over whatever is in storage now. */
async function launch() {
  clearTimeout(store._saveTimer);
  store.listeners.clear();
  store.undoStack.length = 0;
  store.redoStack.length = 0;
  store.snapshots.length = 0;
  store._lastSnapshotDay = null;
  store.ready = false;
  await store.init();
  clearTimeout(store._saveTimer);
}
/** Lay out a disk: a full board, plus whatever extra files the attack wants beside it. */
function disk({ ops = null, checkpoint = null, snapshots = null } = {}) {
  resetStorage();
  seedBoard(RICH());
  if (ops !== null) LS.setItem(OPS_KEY, ops);
  if (checkpoint !== null) LS.setItem(CHECKPOINT_KEY, checkpoint);
  if (snapshots !== null) LS.setItem(SNAP_KEY, JSON.stringify(snapshots));
}
const contentCount = (b) =>
  (b.notes?.length ?? 0) + (b.bars?.length ?? 0) + Object.keys(b.scratchpads ?? {}).length;

afterEach(quiet);
after(quiet);

// ─────────────────────────────────────────────────────────────────────────────
describe('the three files disagreeing', () => {
  // ── R3-31 … R3-35 · INVERTED 2026-08-27 · A3-C1 (CRITICAL) and A3-H1 (HIGH) are CLOSED ──
  // ── RE-ANCHORED 2026-08-27 · ADR 006 replaced the rule these rows were written against ──
  //
  // The five rows below were green because the defects existed. They now assert the fix, and
  // between them they walk every reach-path the finding named: an unrelated op line, a torn
  // append, an unreadable checkpoint, and a checkpoint that parses but is not a checkpoint.
  //
  // THE RULE THE STORE NOW FOLLOWS (ADR 006): `board.json` is the truth and the op log is
  // history. Every launch migrates `board.json` into an op set — no predicate, no branch — and
  // the log is reconciled ONTO it. A log's history is adopted on exactly one equality,
  // `checkpoint.lzp.lineageId === board._v2.lineageId`; anything else is a QUARANTINE — not
  // applied, not deleted, not written to — and the board loads exactly as it does on a machine
  // with no log at all. The REASONS changed with the rule and are now exact: `no-checkpoint`,
  // `board-carries-no-lineage`, `log-carries-no-lineage`, `foreign-lineage`, `unreadable-log`,
  // `reconcile-failed`. See `adoptable` / `_adoptHistory` in store.js.
  //
  // I-6 also landed: a refused log is MOVED ASIDE (`…ops.quarantined-<ts>`), so it is refused
  // once rather than once per launch. Moving is not deleting — the rows below assert the bytes.

  test('R3-31 FAILED (held, A3-C1 closed): one stray line in ops.jsonl is quarantined and board.json is loaded untouched', async () => {
    disk({ ops: JSON.stringify(ONE_OP) });
    const before = LS.getItem(BOARD_KEY);
    assert.equal(contentCount(JSON.parse(before)), 7);

    await launch();
    assert.equal(contentCount(store.state), 7, 'the whole board is on screen …');
    assert.equal(store.state.categories.length, 1, '… categories included …');
    assert.ok(store.warnings.some((w) => /QUARANTINED \(no-checkpoint\)/.test(w)),
      '… and the refusal is on the warnings channel, not silent: ' + JSON.stringify(store.warnings));
    assert.equal(store.diagnostics().quarantine.reason, 'no-checkpoint',
      'a bare ops.jsonl has no header, so it carries no lineage and is never adopted');
    assert.equal(store.diagnostics().source, 'board.json');

    await store.persistNow();
    quiet();
    assert.equal(LS.getItem(BOARD_KEY), before, 'board.json is byte-identical after the first autosave');
    const moved = store.quarantine.movedAside;
    assert.equal(LS.getItem(moved.ops), JSON.stringify(ONE_OP),
      'and the refused log is still on disk, byte for byte — moved aside (I-6), never deleted');
    assert.equal(LS.getItem(OPS_KEY), null, 'so the same refusal is not re-derived on every launch');
  });

  test('R3-32 FAILED (held): the day\'s snapshot preserves the REAL board, so 11.5 still works after a poisoned log', async () => {
    disk({ ops: JSON.stringify(ONE_OP) });
    await launch();
    await store.persistNow();
    quiet();
    assert.equal(store.snapshots.length, 1, 'a snapshot was taken for today …');
    assert.equal(contentCount(store.snapshots[0].state), 7,
      '… of `_persisted`, which is now the board that was on disk. The safety net survives the attack.');
    assert.equal(store.snapshots[0].state.categories.length, 1);
  });

  test('R3-33 FAILED (held): an INTERRUPTED append is quarantined too — the intact first line no longer outranks the board', async () => {
    disk({ ops: `${JSON.stringify(ONE_OP)}\n{"v":1,"id":"CCCC` });
    await launch();
    assert.equal(contentCount(store.state), 7,
      '`parseJSONL` still skips the torn line; the surviving line is still "a log"; it is simply not a log of THIS board');
    assert.equal(store.quarantine.reason, 'no-checkpoint');
    assert.equal(store.quarantine.tailLines, 1, 'and the quarantine record says what it refused');
  });

  test('R3-34 FAILED (held): a checkpoint the loader cannot read is quarantined — the board survives and the app is ready', async () => {
    disk({ checkpoint: JSON.stringify({ nonsense: true }) });
    await launch();
    assert.equal(contentCount(store.state), 7, 'a checkpoint no longer outranks a perfectly good board.json …');
    assert.equal(store.ready, true, '… and the app is ready, with the real board on it');
    assert.equal(store.quarantine.reason, 'board-carries-no-lineage',
      'this board has never had a log bound to it, so there is no history to adopt');
  });

  test('R3-35 FAILED (held, A3-H1 closed): a checkpoint that PARSES but carries no format version boots the app off board.json', async () => {
    disk({ checkpoint: JSON.stringify({ horizon: '', regs: {}, cursors: {}, seqs: {}, bodies: {}, parked: [], spliced: [], at: 1 }) });
    await launch();                          // ← used to reject with RegisterError and leave ready === false
    assert.equal(store.ready, true, 'init() fails SAFE: an unusable checkpoint is a quarantine, never a white screen');
    assert.equal(contentCount(store.state), 7, 'and the intact board.json that was sitting right there is on screen');
    assert.ok(store.warnings.some((w) => /QUARANTINED/.test(w)), JSON.stringify(store.warnings));
  });

  test('R3-35b FAILED (held): EVERY shape of broken checkpoint boots — none of them is fatal, none of them empties the board', async () => {
    // The asymmetry A3-H1 named was "unparsable is safe, parsable-but-wrong is fatal". Both
    // halves are now the same half. One row per shape, each a cold start over the same board.
    const SHAPES = {
      'not JSON at all': 'not json{{',
      'JSON null': 'null',
      'a JSON array': '[]',
      'a JSON string': '"checkpoint"',
      'a number': '42',
      'an empty object': '{}',
      'no `v` on regs (RegisterError)': JSON.stringify({ horizon: '', regs: {}, cursors: {}, seqs: {}, bodies: {}, parked: [], spliced: [], at: 1 }),
      'regs is a string': JSON.stringify({ regs: 'nope' }),
      'regs is an array': JSON.stringify({ regs: [1, 2, 3] }),
      'horizon is not a stamp (OpLogError)': JSON.stringify({ horizon: 'gestern', regs: null }),
      'horizon is a number': JSON.stringify({ horizon: 17, regs: null }),
      'parked is a string': JSON.stringify({ parked: 'nope', regs: null }),
      'parked holds junk': JSON.stringify({ parked: [null, 5, { op: 'not an op' }], regs: null }),
      'cursors holds __proto__': JSON.stringify({ regs: null, cursors: { __proto__: 1, a: 2 } }),
      'seqs is hostile': JSON.stringify({ regs: null, seqs: { __proto__: 'x', zz: 'NaN' } }),
      'bodies is hostile': JSON.stringify({ regs: null, bodies: { __proto__: ['x'] } }),
      'a v2-shaped stranger': JSON.stringify({ v: 2, regs: { v: 1, regs: {} }, horizon: null }),
      'deeply nested nonsense': JSON.stringify({ regs: { v: 1, regs: { 'note:zz': { text: { deep: { deeper: true } } } } } }),
    };
    for (const [what, bytes] of Object.entries(SHAPES)) {
      disk({ checkpoint: bytes });
      await launch();
      assert.equal(store.ready, true, `${what}: the app booted`);
      assert.equal(contentCount(store.state), 7, `${what}: with the user's board on it`);
      assert.equal(store.state.categories.length, 1, `${what}: categories included`);
      await store.persistNow(); quiet();
      assert.equal(contentCount(JSON.parse(LS.getItem(BOARD_KEY))), 7, `${what}: and the autosave did not empty the file`);
      const slot = store.quarantine?.movedAside?.checkpoint ?? CHECKPOINT_KEY;
      assert.equal(LS.getItem(slot), bytes, `${what}: the refused checkpoint is still on disk, byte for byte`);
    }
  });

  test('R3-35c FAILED (held): a log this build WROTE is still trusted — the check refuses strangers, not the real thing', async () => {
    // The other half of the proof: a consistency check that refuses everything is not a fix.
    disk();
    await launch();
    store._opsPersisted = true;                    // what space creation will do (WP-8)
    await store.persistNow(); quiet();
    assert.ok(LS.getItem(CHECKPOINT_KEY), 'a real checkpoint was written');
    const cp = JSON.parse(LS.getItem(CHECKPOINT_KEY));
    assert.equal(cp.lzp.v, 2, 'and it carries the ADR 006 envelope …');
    assert.ok(/^lin_[0-9A-Za-z_-]+$/.test(cp.lzp.lineageId), '… naming the lineage it belongs to …');
    assert.equal(cp.lzp.lineageId, JSON.parse(LS.getItem(BOARD_KEY))._v2.lineageId,
      '… which is the lineage board.json names, written in the same persist');
    assert.match(cp.lzp.boardHash, /^[0-9a-f]{8}:\d+$/, '… plus a hash of the exact bytes written (never a gate)');

    const stateBefore = structuredClone(store.state);
    const regsBefore = JSON.stringify(serializeRegisters(store.registers()));
    await launch();
    assert.equal(store.quarantine, null, 'the relaunch trusts it …');
    assert.equal(store.diagnostics().source, 'op-log');
    assert.deepEqual(store.state, stateBefore, '… and the board comes back exactly');
    // INV-4, the anti-churn control: an exact match reconciles ZERO ops, so every stamp, `_born`
    // and tombstone survives byte-identically. Swapping `_diff` for `planReplaceAll` in
    // `_reconcileOntoBoard` reddens this line and nothing else.
    assert.equal(store.diagnostics().lineage.reconciled, 0, 'and the reconciliation plan was empty');
    assert.equal(JSON.stringify(serializeRegisters(store.registers())), regsBefore,
      'the register map is byte-identical across the restart — nothing was re-stamped');
  });

  test('R3-35d FAILED (held): a checkpoint from ANOTHER board is refused even though it is perfectly well-formed', async () => {
    // Write a real checkpoint for one board, then put a DIFFERENT board.json beside it. This is
    // the shape a shared browser origin, a restored backup or a copied support bundle produces —
    // and the one no amount of "is the file readable" checking can catch.
    disk();
    await launch();
    store._opsPersisted = true;
    await store.persistNow(); quiet();
    const foreign = LS.getItem(CHECKPOINT_KEY);

    const mine = { ...RICH(), notes: [{ id: 'zz9', date: '2026-09-09', text: 'meins', categoryId: 'k9', repeatsYearly: false }], bars: [], scratchpads: {}, categories: [{ id: 'k9', name: 'Meins', nameEn: 'Mine', paletteRef: 'rot', visible: true }] };
    mine.settings = { ...mine.settings, lastCategoryId: 'k9' };
    resetStorage();
    seedBoard(mine);
    LS.setItem(CHECKPOINT_KEY, foreign);
    await launch();
    assert.equal(store.quarantine.reason, 'board-carries-no-lineage',
      'a well-formed checkpoint of someone else\'s board is still not this board\'s checkpoint');
    assert.deepEqual(store.state.notes.map((n) => n.id), ['zz9'], 'and my board is the one on screen');
  });

  test('R3-36 FAILED (held): a checkpoint that is not JSON AT ALL is tolerated — loadCheckpoint() catches, and the board survives', async () => {
    disk({ checkpoint: 'not json{{' });
    await launch();
    assert.equal(contentCount(store.state), 7,
      'the asymmetry is the point: unparsable is SAFE, parsable-but-wrong is fatal (R3-35) or silent (R3-34)');
  });

  // ── R3-36b · A3-M1a at the STORE layer, on the one input that reaches it unfiltered ──────────
  //
  // Reported by the H-2/COERCE pass as "left for another agent": the two DOORS survive a
  // `settings` nested a few thousand deep — `flattenPref`'s recursion overflows, both doors catch
  // the `RangeError` alongside `OpError` and the key costs one key. The crash was one layer up
  // and OUTSIDE every door: at a depth where the recursion does NOT overflow, the flatten
  // succeeds and mints ONE register name with two thousand dots; `prefsFromRegisters` rebuilds
  // the nesting iteratively and survives; `store._project`'s `structuredClone(state.settings)`
  // then throws `RangeError` out of `init()` with `ready === false`. White screen, intact
  // `board.json` sitting right there — A3-H1's shape, reached through the board rather than the
  // checkpoint. Note the non-monotonicity, which is why one depth would have been a false green:
  // 2000 crashed, 4000 was caught by the door, 6000 crashed again, all on the same build.
  //
  // Closed with a cap on the DEPTH (`ops.js:PREF_MAX_DEPTH = 32`) and a second lock on the way
  // back out (`materialize.js:prefsFromRegisters`), so a name that arrives from a checkpoint or a
  // peer rather than through `flattenPref` cannot build the projection either. The frozen v1
  // store throws on every one of these depths, so this is a place v2 is now strictly better.
  // ── THE HARNESS HAS A STACK TOO, and it is not the same stack everywhere ────────────────────
  //
  // This row went red on CI while passing on every developer machine, and the failure was NOT in
  // the product: `JSON.stringify` threw `RangeError` inside `seedBoard` (tests/helpers/env.js:75)
  // while BUILDING the fixture, so the app was never launched. `JSON.stringify` recurses, and
  // V8's recursion limit is a function of the thread's stack size, which differs between a macOS
  // developer box and a Linux CI runner. Reproduced locally: `--stack-size=984` passes,
  // `--stack-size=600` fails, same build, same file.
  //
  // The premise the row depends on is therefore "this host can SERIALISE a board nested N deep",
  // and it was never stated. It is stated now, and measured at run time rather than assumed.
  // What must NOT change: the row keeps SEVERAL depths. Its own history is why — 2000 crashed,
  // 4000 was caught by the door, 6000 crashed again, on one build. A single depth would have
  // been a false green, so the non-vacuity floor below fails loudly rather than quietly testing
  // one shallow case on a small-stack host.
  const DEEP_DEPTHS = [40, 1000, 2000, 4000, 6000];
  const serialisableHere = (n) => {
    let o = {}; const root = o;
    for (let i = 0; i < n; i++) { o.k = {}; o = o.k; }
    try { JSON.stringify(root); return true; } catch { return false; }
  };

  test('R3-36b FAILED (held): a board.json whose settings nest thousands deep BOOTS, at every depth, and says what it dropped', async () => {
    const deep = (n) => { let o = {}; const root = o; for (let i = 0; i < n; i++) { o.k = {}; o = o.k; } o.leaf = 1; return root; };
    const depths = DEEP_DEPTHS.filter(serialisableHere);
    assert.ok(depths.length >= 3,
      `this host can only serialise ${depths.length} of the ${DEEP_DEPTHS.length} depths `
      + `(${JSON.stringify(depths)}) — below three the non-monotonicity this row exists for is `
      + 'untestable and a pass would be a false green. Raise the runner\'s --stack-size.');
    for (const n of depths) {
      const board = RICH();
      board.settings.deepThing = deep(n);
      resetStorage();
      seedBoard(board);
      const bytes = LS.getItem(BOARD_KEY);

      let err = null;
      try { await launch(); } catch (e) { err = e; }
      assert.equal(err, null, `depth ${n}: init() threw ${err && err.constructor.name} — the app never boots`);
      assert.equal(store.ready, true, `depth ${n}: ready`);
      assert.equal(contentCount(store.state), 7, `depth ${n}: the whole board is on screen`);
      assert.equal(store.state.settings.deepThing, undefined, `depth ${n}: the unrepresentable pref is not in settings`);
      assert.ok(store.warnings.some((w) => /deepThing/.test(w)),
        `depth ${n}: refused in silence — ${JSON.stringify(store.warnings)}`);
      assert.equal(LS.getItem(BOARD_KEY), bytes, `depth ${n}: nothing was written before the user saw the board`);
    }
  });

  test('R3-36c FAILED (held): legitimate nesting is untouched — the cap refuses a tree, not a settings object', async () => {
    const board = RICH();
    board.settings.layers = { feiertage: true, ferien: false };
    board.settings.lastSeenSeq = { 'spc_deadbeefdeadbeefdead12': 7 };
    resetStorage();
    seedBoard(board);
    await launch();
    assert.equal(store.state.settings.layers.feiertage, true);
    assert.equal(store.state.settings.layers.ferien, false);
    assert.equal(store.state.settings.lastSeenSeq['spc_deadbeefdeadbeefdead12'], 7);
    assert.deepEqual(store.warnings.filter((w) => /layers|lastSeenSeq/.test(w)), [],
      'a two-level settings object is what the app actually ships, and it is not a loss');
  });

  test('R3-37 FAILED (held): with no log beside it, board.json alone reloads byte-for-byte identically', async () => {
    disk();
    await launch();
    await store.persistNow(); quiet();
    const gen1 = LS.getItem(BOARD_KEY);
    await launch();
    await store.persistNow(); quiet();
    assert.equal(LS.getItem(BOARD_KEY), gen1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('what the store actually writes', () => {
  test('R3-38 FAILED (held): solo mode writes no second file — a persist touches exactly the two v1 storage slots', async () => {
    disk();
    await launch();
    store.mutate('edit', (s) => { s.notes[0].text = 'geändert'; });
    quiet();
    await store.persistNow();
    quiet();
    assert.deepEqual(LS._keys().sort(), [BOARD_KEY, SNAP_KEY], 'ADR 001 §9/§11, kept');
  });

  test('R3-39 INVERTED (closed by R5-4): `_persistOps()` appends, and the truncate is given a LINE COUNT — "checkpoint, then drop the tail" now happens', async () => {
    // AS FILED (round 3, "latent"): `store._persistOps()` called `saveCheckpoint()` and then
    // `truncateOps(0)`, and never called `appendOps()` at all. Both halves were inert, and the
    // row was filed as latent on the grounds that nothing appends, so nothing grows.
    //
    // That was wrong twice over, which round 5 measured as R5-4: the missing `appendOps` was not
    // latent but LOAD-BEARING (from the second launch on, `checkpoint()` folds only to the
    // horizon it was loaded with, so every op minted since had nowhere to be), and once the
    // append exists the no-op truncate is what lets `ops.jsonl` grow without bound.
    //
    // The storage-level fact this row measured is UNCHANGED and is kept as the control, because
    // it is the reason `truncateOps(0)` was a no-op and not an error: `storage.truncateOps`
    // guards `keepFromLine > 0`, so line 0 legitimately means "keep from the beginning".
    resetStorage();
    await storage.appendOps([{ a: 1 }, { a: 2 }, { a: 3 }]);
    assert.equal((await storage.loadOps()).length, 3);
    await storage.truncateOps(0);
    assert.equal((await storage.loadOps()).length, 3,
      'storage.js is unchanged: line 0 means "keep from the beginning", which is why the old call was inert');
    await storage.truncateOps(3);
    assert.equal((await storage.loadOps()).length, 0, 'a positive line number trims — the intent was always `truncateOps(tail.length)`');

    // THE INVERSION. `store.js` now calls both, and the truncate is given a count.
    const src = readFileSync(new URL('../../src/js/store.js', import.meta.url), 'utf8');
    assert.match(src, /await storage\.appendOps\(/,
      '`store.js` CALLS appendOps — §9.2\'s outbox has a producer (A3-M5 / R5-4d closed)');
    assert.equal(/storage\.truncateOps\(0\)/.test(src), false,
      'and the no-op truncate is gone');
    assert.match(src, /truncateOps\(this\._tailLines\)/,
      'it is given a line count, guarded by "the checkpoint just written folds every one of them"');

    // And behaviourally, end to end: an op minted in session 2 is ON DISK when session 2 ends.
    // R5-4a/f own this claim in full; it is restated here so this row is not source-grep-only.
    disk();
    await launch();
    store._opsPersisted = true;
    await store.persistNow(); quiet();
    await launch();
    store._opsPersisted = true;
    store.mutate('add', (s) => s.notes.push({ id: 'nNEW', date: '2026-04-01', text: 'Steuer', categoryId: 'c1', repeatsYearly: false }));
    quiet();
    await store.persistNow(); quiet();
    const tail = (LS.getItem(OPS_KEY) || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(tail.some((l) => l.op.e === 'note:nNEW'),
      'the second session\'s op is a line of ops.jsonl — under the defect this file did not exist at all');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the same board, opened on two Macs', () => {
  // A SECOND STORE PROCESS. `_me` / `_device` are minted in the constructor, i.e. once per module
  // instance, so a second evaluation of `store.js` is the closest thing this tier has to a second
  // Mac. It shares `localStorage` (a real global) and nothing else.
  let second = null;
  const otherMac = async () => {
    if (!second) second = (await import('../../src/js/store.js?second-mac')).store;
    clearTimeout(second._saveTimer);
    second.listeners.clear();
    second.undoStack.length = 0;
    second.redoStack.length = 0;
    second.snapshots.length = 0;
    second._lastSnapshotDay = null;
    second.ready = false;
    await second.init();
    clearTimeout(second._saveTimer);
    return second;
  };
  afterEach(() => { if (second) clearTimeout(second._saveTimer); });
  after(() => { if (second) clearTimeout(second._saveTimer); });

  test('R3-40 SUCCEEDED (defect): "two Macs opening the same board agree byte for byte" is only half true — the STAMPS agree, the AUTHORS do not', async () => {
    // store.js's header: "two Macs opening the same board agree byte for byte and every future
    // edit beats every migrated field on every device". The stamp half holds — GENESIS(i) is a
    // pure function of the file (ADR 001 §8.1) — but identity is ephemeral (store.js:415), so the
    // `author` on every migrated register differs and `serializeRegisters()` is not identical.
    disk();
    await launch();
    const B = await otherMac();

    assert.notEqual(store._me, B._me, 'identity is minted per process, deliberately');
    assert.deepEqual(B.state, store.state, 'the BOARD is identical, which is what the user sees …');

    const a = JSON.parse(JSON.stringify(serializeRegisters(store.registers())));
    const b = JSON.parse(JSON.stringify(serializeRegisters(B.registers())));
    assert.equal(a.regs['cat:c1']._alive.stamp, b.regs['cat:c1']._alive.stamp, '… and the stamps agree, exactly as §8.1 promises …');
    assert.equal(a.regs['cat:c1']._alive.op, b.regs['cat:c1']._alive.op, '… and so do the opIds …');
    assert.notEqual(a.regs['cat:c1']._alive.author, b.regs['cat:c1']._alive.author,
      '… but the authors do not, so "byte for byte" is false as the header states it');
    assert.notEqual(JSON.stringify(a), JSON.stringify(b));
  });

  test('R3-41 SUCCEEDED (defect, blocks WP-8): the other Mac\'s ops are refused `notMyAct`, so two devices over one board cannot converge at all', async () => {
    disk();
    await launch();
    const B = await otherMac();

    store.apply('editNotePopover', { id: 'n0', text: 'von Mac A' });
    quiet();
    const fromA = store._log.ops().filter((o) => o.k === 'note.set' && o.f.text === 'von Mac A');
    assert.equal(fromA.length, 1);

    B.warnings.length = 0;
    B.applyRemote(fromA);
    clearTimeout(B._saveTimer);
    assert.equal(B.state.notes.find((n) => n.id === 'n0').text, 'Termin 0',
      'DEFECT: Mac B refuses the op outright — nothing converges');
    assert.ok(/notMyAct/.test(B.warnings.join(' ')),
      '`foldAuthorized` degrades ADR 001 §4.0\'s device check to `act === me`, and `me` is not durable yet');
    // ADR 002 §2.2 says a durable identity arrives with the keystore. Until it does, `applyRemote`
    // admits nothing from a real peer — which makes any WP-8 fleet test that mints its ops with
    // the receiving store's own `_me` a false green.
  });

  test('R3-42 FAILED (held, v1 parity): two live stores over one board.json are last-writer-wins on the whole file', async () => {
    // Not a regression — v1 does exactly this, because `board.json` is written whole. Recorded so
    // it is not mistaken for something the op log fixed. It did not: in solo mode the log is not
    // on disk, so there is nothing to merge.
    disk();
    await launch();
    const A = structuredClone(store.state);
    store.mutate('A', (s) => { s.notes[0].text = 'A schreibt'; });
    quiet();
    await store.persistNow(); quiet();

    // "the other process" — a fresh launch that loaded the board BEFORE A saved
    const stale = { ...A, notes: A.notes.map((n) => (n.id === 'n1' ? { ...n, text: 'B schreibt' } : n)) };
    LS.setItem(BOARD_KEY, JSON.stringify(stale, null, 2));
    const final = JSON.parse(LS.getItem(BOARD_KEY));
    assert.equal(final.notes[0].text, 'Termin 0', 'A\'s edit is gone from the file');
    assert.equal(final.notes[1].text, 'B schreibt');
  });
});
