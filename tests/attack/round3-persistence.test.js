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
// REACHABILITY, STATED HONESTLY. `store.js` never writes `ops.jsonl` today (row R3-38 pins that),
// so nothing in the shipping app can create the precondition on its own. It becomes reachable the
// moment WP-8 appends a single op, or a crash interrupts an append, or — on the browser/dev
// branch, which is how the board is previewed — anything else writes that `localStorage` key.
// The defect is not "the app loses boards today"; it is "the door has no lock on it and WP-8 is
// the next work package".
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
  //
  // The five rows below were green because the defects existed. They now assert the fix, and
  // between them they walk every reach-path the finding named: an unrelated op line, a torn
  // append, an unreadable checkpoint, and a checkpoint that parses but is not a checkpoint.
  //
  // THE RULE THE STORE NOW FOLLOWS: `shouldMigrate`'s `opsLogExists` still answers "has migration
  // already run?", and a second, separate check answers "is this log READABLE and is it a log of
  // THIS board?". Only both together may discard `board.json`. A log that fails either is
  // QUARANTINED — not applied, not deleted, not written to — and the board loads exactly as it
  // does on a machine with no log at all. See `logBelongsToBoard` / `_useLog` in store.js.

  test('R3-31 FAILED (held, A3-C1 closed): one stray line in ops.jsonl is quarantined and board.json is loaded untouched', async () => {
    disk({ ops: JSON.stringify(ONE_OP) });
    const before = LS.getItem(BOARD_KEY);
    assert.equal(contentCount(JSON.parse(before)), 7);

    await launch();
    assert.equal(contentCount(store.state), 7, 'the whole board is on screen …');
    assert.equal(store.state.categories.length, 1, '… categories included …');
    assert.ok(store.warnings.some((w) => /QUARANTINED \(unrelated-log\)/.test(w)),
      '… and the refusal is on the warnings channel, not silent: ' + JSON.stringify(store.warnings));
    assert.equal(store.diagnostics().quarantine.reason, 'unrelated-log');
    assert.equal(store.diagnostics().source, 'board.json');

    await store.persistNow();
    quiet();
    assert.equal(LS.getItem(BOARD_KEY), before, 'board.json is byte-identical after the first autosave');
    assert.equal(LS.getItem(OPS_KEY), JSON.stringify(ONE_OP),
      'and the refused log is still on disk, unmodified — quarantined, not deleted');
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
    assert.equal(store.quarantine.reason, 'unrelated-log');
    assert.equal(store.quarantine.tailLines, 1, 'and the quarantine record says what it refused');
  });

  test('R3-34 FAILED (held): a checkpoint the loader cannot read is quarantined — the board survives and the app is ready', async () => {
    disk({ checkpoint: JSON.stringify({ nonsense: true }) });
    await launch();
    assert.equal(contentCount(store.state), 7, 'a checkpoint no longer outranks a perfectly good board.json …');
    assert.equal(store.ready, true, '… and the app is ready, with the real board on it');
    assert.equal(store.quarantine.reason, 'no-provenance',
      'it carries no `lzp` envelope, so it was not written by this app over this board');
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
      assert.equal(LS.getItem(CHECKPOINT_KEY), bytes, `${what}: the refused checkpoint is untouched on disk`);
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
    assert.equal(cp.lzp.v, 1, 'and it carries the provenance envelope …');
    assert.equal(typeof cp.lzp.boardFp, 'string');
    assert.equal(cp.lzp.boardN, 8, '… naming the board it was folded from (5 notes + 1 bar + 1 pad + 1 category)');

    const stateBefore = structuredClone(store.state);
    await launch();
    assert.equal(store.quarantine, null, 'the relaunch trusts it …');
    assert.equal(store.diagnostics().source, 'op-log');
    assert.deepEqual(store.state, stateBefore, '… and the board comes back exactly');
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
    assert.equal(store.quarantine.reason, 'unrelated-log', 'a well-formed checkpoint of someone else\'s board is still not this board\'s checkpoint');
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
  test('R3-36b FAILED (held): a board.json whose settings nest thousands deep BOOTS, at every depth, and says what it dropped', async () => {
    const deep = (n) => { let o = {}; const root = o; for (let i = 0; i < n; i++) { o.k = {}; o = o.k; } o.leaf = 1; return root; };
    for (const n of [40, 1000, 2000, 4000, 6000]) {
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

  test('R3-39 SUCCEEDED (defect, latent): `_persistOps()` never appends, and `truncateOps(0)` keeps every line — the "checkpoint, then drop the tail" it documents does not happen', async () => {
    // `storage.truncateOps` guards `keepFromLine > 0`, so line 0 means "keep from the beginning",
    // i.e. keep everything. `store._persistOps()` calls `saveCheckpoint()` and then
    // `truncateOps(0)`, and never calls `appendOps()` at all. Measured on storage.js directly so
    // the row does not depend on the unreachable `_opsPersisted === true` branch.
    resetStorage();
    await storage.appendOps([{ a: 1 }, { a: 2 }, { a: 3 }]);
    assert.equal((await storage.loadOps()).length, 3);
    await storage.truncateOps(0);
    assert.equal((await storage.loadOps()).length, 3,
      'DEFECT: the tail the store meant to drop is still there — §7.2 compaction never trims the file');
    await storage.truncateOps(3);
    assert.equal((await storage.loadOps()).length, 0, 'a positive line number does trim, so the intent was `truncateOps(tail.length)`');

    // And the other half: nothing in `store.js` ever calls `appendOps`, so once `_opsPersisted`
    // is true the ops minted this session live ONLY inside `checkpoint.json`. Fine for state,
    // fatal for WP-8's outbox, which needs the ops themselves.
    assert.equal(typeof storage.appendOps, 'function');
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
