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
  test('R3-31 SUCCEEDED (defect, CRITICAL): one stray line in ops.jsonl empties the board, and the first autosave writes the empty board over board.json', async () => {
    disk({ ops: JSON.stringify(ONE_OP) });
    const before = JSON.parse(LS.getItem(BOARD_KEY));
    assert.equal(contentCount(before), 7);

    await launch();
    assert.equal(contentCount(store.state), 0, 'DEFECT: the whole board is gone from `state` …');
    assert.equal(store.state.categories.length, 0, '… categories included …');
    assert.deepEqual(store.warnings, [], '… and nothing was warned about');

    await store.persistNow();
    quiet();
    const after = JSON.parse(LS.getItem(BOARD_KEY));
    assert.equal(contentCount(after), 0, 'DEFECT: and board.json — which IS the checkpoint in solo mode — is now empty');
    assert.equal(after.categories.length, 0,
      'the file is not even a legal v1 board any more; the next migrate() substitutes four stranger categories');
  });

  test('R3-32 SUCCEEDED (defect): the day\'s snapshot preserves the ALREADY-EMPTIED board, so 11.5 cannot recover it either', async () => {
    disk({ ops: JSON.stringify(ONE_OP) });
    await launch();
    await store.persistNow();
    quiet();
    assert.equal(store.snapshots.length, 1, 'a snapshot was taken for today …');
    assert.equal(contentCount(store.snapshots[0].state), 0,
      'DEFECT: … of `_persisted`, which init() set to the post-wipe state. The last safety net is empty too.');
  });

  test('R3-33 SUCCEEDED (defect): an INTERRUPTED append is the same attack — the torn last line is skipped, the intact first line still counts as "a log exists"', async () => {
    disk({ ops: `${JSON.stringify(ONE_OP)}\n{"v":1,"id":"CCCC` });
    await launch();
    assert.equal(contentCount(store.state), 0,
      'DEFECT: `parseJSONL` correctly skips the torn line, and the surviving line is enough to trip `shouldMigrate`');
  });

  test('R3-34 SUCCEEDED (defect): a checkpoint the loader cannot read at all also empties the board — silently, no throw', async () => {
    disk({ checkpoint: JSON.stringify({ nonsense: true }) });
    await launch();
    assert.equal(contentCount(store.state), 0, 'DEFECT: an unrecognisable checkpoint outranks a perfectly good board.json');
    assert.equal(store.ready, true, 'and the app happily reports itself ready');
  });

  test('R3-35 SUCCEEDED (defect): a checkpoint that is PARSABLE but carries no format version throws RegisterError out of init() — the app never boots', async () => {
    disk({ checkpoint: JSON.stringify({ horizon: '', regs: {}, cursors: {}, seqs: {}, bodies: {}, parked: [], spliced: [], at: 1 }) });
    await assert.rejects(() => launch(), (e) => e.name === 'RegisterError' && /unknown format version/.test(e.message));
    quiet();
    assert.equal(store.ready, false,
      'DEFECT: `init()` has no try/catch around `_log.load`, so a corrupt checkpoint is a white screen with no recovery path');
    store.ready = false;
  });

  test('R3-36 FAILED (held): a checkpoint that is not JSON AT ALL is tolerated — loadCheckpoint() catches, and the board survives', async () => {
    disk({ checkpoint: 'not json{{' });
    await launch();
    assert.equal(contentCount(store.state), 7,
      'the asymmetry is the point: unparsable is SAFE, parsable-but-wrong is fatal (R3-35) or silent (R3-34)');
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
