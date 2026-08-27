// ─────────────────────────────────────────────────────────────────────────────
// UPGRADE DAY — DISK-SHAPED FAILURES  (WP-3 adversary)
//
// ADR 001 §8.4's idempotence predicate decides, on every single launch, whether `board.json` is
// the truth or the op log is:
//
//     shouldMigrate(board, { opsLogExists: !!checkpoint || tail.length > 0 })
//
// `opsLogExists` is a pure EXISTENCE test. It never asks whether the log actually reconstructs a
// board. So the moment anything parseable is sitting in `ops.jsonl` or `checkpoint.json`,
// `board.json` stops being read — and 700 ms later it is overwritten with whatever the log
// produced, which for a log that reconstructs nothing is an empty board.
//
// Solo mode is supposed to write neither file, which is what keeps this from firing on a clean
// upgrade. The rows below are the ways one of them is there anyway: a space created and then
// abandoned, a beta build, a crash between the ops write and the checkpoint write (ADR 001 §7.2's
// own sequence), a shared browser origin in dev.
//
// Rows are PINNED TO CURRENT BEHAVIOUR (`docs/v2/STATUS.md` §5). A `DEFECT` row going RED means
// the defect was fixed — invert the row. Scratch only: in-memory localStorage, no real file.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LS, LS_BOARD, LS_OPS, LS_CHECKPOINT, LS_SNAP,
  bootV1, bootV2, v1store, v2store, v1board, note, bar, diffDeep,
} from './_upgrade-harness.js';

const J = (o) => JSON.stringify(o);

/** A board with something on it, so "the board is empty" is unmistakable. */
const REAL_BOARD = () => v1board({
  notes: [note('n1', '2026-04-02', 'Zahnarzt'), note('n2', '2026-05-11', 'Elternabend')],
  bars: [bar('b1', '2026-04-10', '2026-06-20', 'Sommerprojekt')],
  scratchpads: { '2026-04': 'Milch kaufen' },
});

const size = (s) => ({
  notes: s.notes.length, bars: s.bars.length,
  categories: s.categories.length, pads: Object.keys(s.scratchpads).length,
});
const FULL = { notes: 2, bars: 1, categories: 2, pads: 1 };
const EMPTY = { notes: 0, bars: 0, categories: 0, pads: 0 };

/** Launch v2 over the given slot contents and let the first autosave run. */
async function launch(setup) {
  LS.clear();
  setup();
  await bootV2();
  const onScreen = size(v2store.state);
  await v2store.persistNow();
  const onDisk = size(JSON.parse(LS.getItem(LS_BOARD)));
  return { onScreen, onDisk, warnings: [...v2store.warnings], slots: LS._keys().slice().sort() };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE BASELINE — a clean upgrade day
// ─────────────────────────────────────────────────────────────────────────────

test('HELD · a clean upgrade: board.json alone, no second file created (ADR 001 §9/§11)', async () => {
  const r = await launch(() => LS.setItem(LS_BOARD, J(REAL_BOARD())));
  assert.deepEqual(r.onScreen, FULL);
  assert.deepEqual(r.onDisk, FULL);
  assert.deepEqual(r.slots, ['langzeitplaner.board', 'langzeitplaner.snapshots'],
    'exactly the two v1 slots — no ops.jsonl, no checkpoint.json');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE DEFECT — one parseable line in the log discards board.json entirely
// ─────────────────────────────────────────────────────────────────────────────

test('HELD · a single parseable line in ops.jsonl is quarantined; the board is untouched on screen and on disk', async () => {
  // INVERTED 2026-08-27 — A3-C1 is closed. RE-ANCHORED the same day to ADR 006, which replaced the
  // rule: `board.json` is the truth and the log is history, the gate is one equality
  // (`checkpoint.lzp.lineageId === board._v2.lineageId`), and a bare `ops.jsonl` has no header and
  // therefore no lineage — so it is never adopted, whatever it names. See `adoptable` in store.js.
  const strayOp = J({ id: 'AAAAAAAAAAAAAAAAAAAAAA', k: 'note.set', e: 'note:ghost', f: { text: 'ghost' } });
  const r = await launch(() => {
    LS.setItem(LS_BOARD, J(REAL_BOARD()));
    LS.setItem(LS_OPS, `${strayOp}\n`);
  });
  assert.deepEqual(r.onScreen, FULL, 'the board comes up whole');
  assert.deepEqual(r.onDisk, FULL, 'and the autosave writes the whole board back');
  assert.equal(r.warnings.length, 2, 'two things to tell the user: what was refused, and where it went');
  assert.match(r.warnings[0], /QUARANTINED \(no-checkpoint\)/);
  assert.equal(v2store.quarantine.reason, 'no-checkpoint');
  // I-6: moved aside, never deleted. The bytes are the test, not the filename.
  const moved = v2store.quarantine.movedAside;
  assert.equal(LS.getItem(moved.ops), `${strayOp}\n`, 'the refused log is still on disk, byte for byte');
  assert.equal(LS.getItem(LS_OPS), null, 'and it will not be re-read on the next launch');
  assert.deepEqual(r.slots, ['langzeitplaner.board', moved.ops, 'langzeitplaner.snapshots'].sort(),
    'and no checkpoint was written over it');

  // And the end state is the board the user had, not a factory-fresh one.
  LS.removeItem(moved.ops); LS.removeItem(LS_CHECKPOINT);
  await bootV2();
  assert.deepEqual(size(v2store.state), FULL);
});

test('HELD · the same thing via checkpoint.json — a stub `{}` carries no provenance and is refused', async () => {
  const r = await launch(() => {
    LS.setItem(LS_BOARD, J(REAL_BOARD()));
    LS.setItem(LS_CHECKPOINT, '{}');
  });
  assert.deepEqual(r.onScreen, FULL);
  assert.deepEqual(r.onDisk, FULL);
  assert.equal(v2store.quarantine.reason, 'board-carries-no-lineage',
    'a checkpoint may not outrank board.json on the strength of merely existing, and this board has '
    + 'never had a log bound to it at all');
  assert.equal(LS.getItem(v2store.quarantine.movedAside.checkpoint), '{}',
    'and it is still on disk, byte for byte, under a name that says why');
});

test('HELD · ADR 001 §7.2\'s own crash window: ops written, checkpoint not — plus a torn last line', async () => {
  // The exact sequence the brief named. `_persistOps()` writes the checkpoint and then truncates;
  // a crash in between, or a space-creation that got as far as the ops file, leaves ops.jsonl
  // with a tail and no checkpoint beside it. The tail is not this board's tail, so it is refused.
  const op = J({ id: 'AAAAAAAAAAAAAAAAAAAAAA', k: 'note.set', e: 'note:ghost', f: { text: 'ghost' } });
  const bytes = `${op}\n{"id":"BBBB","k":"note.se`;                 // ← the torn final line
  const r = await launch(() => {
    LS.setItem(LS_BOARD, J(REAL_BOARD()));
    LS.setItem(LS_OPS, bytes);
  });
  assert.deepEqual(r.onScreen, FULL);
  assert.deepEqual(r.onDisk, FULL);
  assert.ok(!r.slots.some((k) => k.startsWith('langzeitplaner.checkpoint')),
    'no checkpoint of an empty board is written, so nothing becomes self-sustaining');
  assert.equal(LS.getItem(v2store.quarantine.movedAside.ops), bytes,
    'the torn tail is preserved for a rescue pass, not truncated away');
});

test('DEFECT (A3-M5, still open) · `_persistOps` passes truncateOps(0), which keeps every line', async () => {
  // RE-ANCHORED 2026-08-27. The original setup — three stray lines beside a real board — no
  // longer reaches `_persistOps` at all, because that log is now QUARANTINED and
  // `_opsPersisted` stays false. Which is the point of the fix, and is asserted first here.
  // A3-M5 is a different finding (owner: WP-8) and is measured underneath, on a log the store
  // itself wrote and therefore trusts.
  const op = J({ id: 'AAAAAAAAAAAAAAAAAAAAAA', k: 'note.set', e: 'note:ghost', f: { text: 'ghost' } });
  LS.clear();
  LS.setItem(LS_BOARD, J(REAL_BOARD()));
  LS.setItem(LS_OPS, `${op}\n${op}\n${op}\n`);
  await bootV2();
  assert.equal(v2store.quarantine.reason, 'no-checkpoint');
  await v2store.persistNow();
  assert.equal((LS.getItem(v2store.quarantine.movedAside.ops) || '').split('\n').filter(Boolean).length, 3,
    'a quarantined tail is left alone — the store does not write to a log it refused');
  assert.deepEqual(size(v2store.state), FULL, 'and the board is the user\'s');

  // Now the same measurement on a TRUSTED log: this build writes the checkpoint, then asks
  // storage to drop the tail it has just folded, and passes 0.
  LS.clear();
  LS.setItem(LS_BOARD, J(REAL_BOARD()));
  await bootV2();
  v2store._opsPersisted = true;
  await v2store.persistNow();                       // → saveCheckpoint(), then truncateOps(0)
  LS.setItem(LS_OPS, `${op}\n${op}\n${op}\n`);
  await v2store.persistNow();
  assert.equal((LS.getItem(LS_OPS) || '').split('\n').filter(Boolean).length, 3,
    'DEFECT: storage.js:truncateOps treats 0 as "keep from line 0" = keep everything; `_persistOps` passes 0');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. WHAT HELD — the failure shapes the parser really does absorb
// ─────────────────────────────────────────────────────────────────────────────

test('HELD · unparseable junk in ops.jsonl is skipped and board.json still wins', async () => {
  const r = await launch(() => {
    LS.setItem(LS_BOARD, J(REAL_BOARD()));
    LS.setItem(LS_OPS, 'not json at all\n{{{\n');
  });
  assert.deepEqual(r.onScreen, FULL);
  assert.deepEqual(r.onDisk, FULL);
});

test('HELD · an empty ops.jsonl does not count as a log', async () => {
  const r = await launch(() => {
    LS.setItem(LS_BOARD, J(REAL_BOARD()));
    LS.setItem(LS_OPS, '');
  });
  assert.deepEqual(r.onDisk, FULL);
});

test('HELD · a checkpoint torn mid-write is unparseable, so the board is re-migrated intact', async () => {
  // First produce a REAL checkpoint the way space creation will, then cut it in half.
  LS.clear();
  LS.setItem(LS_BOARD, J(REAL_BOARD()));
  await bootV2();
  v2store._opsPersisted = true;
  await v2store.persistNow();
  const real = LS.getItem(LS_CHECKPOINT);
  assert.ok(real.length > 1000, 'a real checkpoint was written');

  const r = await launch(() => {
    LS.setItem(LS_BOARD, J(REAL_BOARD()));
    LS.setItem(LS_CHECKPOINT, real.slice(0, Math.floor(real.length * 0.6)));
  });
  assert.deepEqual(r.onScreen, FULL, 'loadCheckpoint() catches the parse error and returns null');
  assert.deepEqual(r.onDisk, FULL);
});

test('HELD · a checkpoint written by this build round-trips the board exactly', async () => {
  LS.clear();
  LS.setItem(LS_BOARD, J(REAL_BOARD()));
  await bootV2();
  v2store._opsPersisted = true;
  await v2store.persistNow();
  const viaFile = structuredClone(v2store.state);
  await bootV2();                                    // relaunch — now the log is authoritative
  assert.deepEqual(diffDeep(viaFile, v2store.state), []);
});

test('HELD · a torn board.json is not made worse by the retrofit — v1 and v2 both fall back to defaults', async () => {
  const torn = '{"schemaVersion":1,"notes":[{"id":"n1","date":"2026-0';
  LS.clear(); LS.setItem(LS_BOARD, torn); await bootV1();
  const v1 = size(v1store.state);
  LS.clear(); LS.setItem(LS_BOARD, torn); await bootV2();
  assert.deepEqual(size(v2store.state), v1);
  assert.equal(v2store.state.categories.length, 4);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. A READ-ONLY / FULL DISK
// ─────────────────────────────────────────────────────────────────────────────

test('HELD · when every write throws, board.json keeps its pre-upgrade bytes — same as v1', async () => {
  const bytes = J(REAL_BOARD());
  const realSet = LS.setItem.bind(LS);
  const boom = () => { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; };

  LS.clear(); LS.setItem(LS_BOARD, bytes); await bootV2();
  LS.setItem = boom;
  let v2err = null;
  try { await v2store.persistNow(); } catch (e) { v2err = e; }
  let flushErr = null;
  try { v2store.flushSync(); } catch (e) { flushErr = e; }
  LS.setItem = realSet;
  assert.equal(v2err?.name, 'QuotaExceededError', 'persistNow rejects — unhandled, as it was in v1');
  assert.equal(flushErr, null, 'storage.js:saveBoardSync catches it');
  assert.equal(LS.getItem(LS_BOARD), bytes, 'the file is untouched, which is the thing that matters');

  LS.clear(); LS.setItem(LS_BOARD, bytes); await bootV1();
  LS.setItem = boom;
  let v1err = null;
  try { await v1store.persistNow(); } catch (e) { v1err = e; }
  LS.setItem = realSet;
  assert.equal(v1err?.name, v2err.name, 'v1 did exactly the same — no new failure mode');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. IDEMPOTENCE — this build writes, this build re-reads
// ─────────────────────────────────────────────────────────────────────────────

test('HELD · board.json is byte-stable across three launch/persist generations', async () => {
  LS.clear();
  LS.setItem(LS_BOARD, J(REAL_BOARD()));
  const gens = [];
  for (let i = 0; i < 3; i++) {
    await bootV2();
    await v2store.persistNow();
    gens.push(LS.getItem(LS_BOARD));
  }
  assert.equal(gens[0], gens[1], 'generation 1 === 2');
  assert.equal(gens[1], gens[2], 'generation 2 === 3');
});

test('HELD · a board migrated TWICE is the board migrated once', async () => {
  LS.clear();
  LS.setItem(LS_BOARD, J(REAL_BOARD()));
  await bootV2(); await v2store.persistNow();
  const once = structuredClone(v2store.state);
  await bootV2(); await v2store.persistNow();
  assert.deepEqual(diffDeep(once, v2store.state), []);
});

test('HELD · a board this build wrote is still openable by the FROZEN v1 store (no forward lock-in)', async () => {
  LS.clear();
  LS.setItem(LS_BOARD, J(REAL_BOARD()));
  await bootV2(); await v2store.persistNow();
  const v2bytes = LS.getItem(LS_BOARD);
  const v2state = structuredClone(v2store.state);

  LS.clear(); LS.setItem(LS_BOARD, v2bytes);
  await bootV1();
  assert.deepEqual(diffDeep(v2state, v1store.state), [], 'v1 reads it back identically');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. MIGRATION INTERRUPTED MIDWAY
// ─────────────────────────────────────────────────────────────────────────────

test('HELD · init() writes nothing, so a crash anywhere inside the migration leaves board.json untouched', async () => {
  const bytes = J(REAL_BOARD());
  LS.clear();
  LS.setItem(LS_BOARD, bytes);
  const realSet = LS.setItem.bind(LS);
  const writes = [];
  LS.setItem = (k, v) => { writes.push(k); return realSet(k, v); };
  await bootV2();
  LS.setItem = realSet;
  assert.deepEqual(writes, [], 'init() performed zero writes');
  assert.equal(LS.getItem(LS_BOARD), bytes, 'the pre-upgrade bytes are still the bytes on disk');
});

test('HELD · snapshots.json is written before board.json, so an interrupted persist never leaves a half board', async () => {
  LS.clear();
  LS.setItem(LS_BOARD, J(REAL_BOARD()));
  await bootV2();
  const realSet = LS.setItem.bind(LS);
  const order = [];
  LS.setItem = (k, v) => { order.push(k); if (k === LS_BOARD) throw new Error('crash between the two writes'); return realSet(k, v); };
  await v2store.persistNow().catch(() => {});
  LS.setItem = realSet;
  assert.deepEqual(order, [LS_SNAP, LS_BOARD], 'snapshots first, board second');
  const stillThere = JSON.parse(LS.getItem(LS_BOARD));
  assert.deepEqual(size(stillThere), FULL, 'board.json is the whole old board, not a half-written one');
});
