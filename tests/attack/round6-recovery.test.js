// ─────────────────────────────────────────────────────────────────────────────
// ROUND 6 — ADVERSARY, ATTACK 2: THE RECOVERY PATH
//
// R5-3 was the round-5 CRITICAL: `_recoverFromLog` — ADR 006's one asymmetric branch, which
// performs NO lineage check of any kind — was entered on `kind !== 'ok'`, so a `board.json` that
// merely failed to PARSE handed the board to whatever log was lying beside it. The fix narrowed
// the branch to ONE classification: `classifyBoardFile()` must answer `absent`.
//
// The whole of ADR 006 now hangs off that one five-way answer. It decides, for the same accident
// one byte apart, between:
//
//     'absent'      → believe an unverified log, present it as the user's board, and COMMIT it
//     anything else → refuse every log, show a snapshot, and write nothing for the whole session
//
// §1 walks all five kinds and both directions. Two inputs land on the wrong side of that line,
//    in OPPOSITE directions:
//
//    R6-5a  a ZERO-BYTE `board.json` is `absent`. An empty file is a file — it is the single most
//           likely outcome of a write that was interrupted — and it takes R7. A3-C1's original
//           outcome is back, behind zero bytes instead of one bad byte, and this time the session
//           is NOT read-only, so the first autosave commits the stranger's board.
//    R6-5b  `{}` — and any JSON object at all — is `ok`. It becomes an EMPTY BOARD, the session
//           writes normally, and the log that IS this board's is quarantined
//           `board-carries-no-lineage` and moved aside. `[]` gets the full read-only treatment.
//           The line between catastrophe and business-as-usual is `Array.isArray`.
//
// §2 is the inverse the brief asks for, and it is the more likely failure now: can the new
//    caution refuse to recover when recovery was the right answer? It can. `board.json` genuinely
//    gone + a log that will not load = an EMPTY, WRITABLE board with `snapshots.json` sitting
//    unread beside it — the one file ADR 006 §5.6 argues is the answer for exactly this morning.
//
// Rows tagged `SUCCEEDED (defect)` are green BECAUSE the defect is there.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  LS, LS_BOARD, LS_OPS, LS_CHECKPOINT, v2store, bootV2, v1board, note,
  J, bound, bootWith, slots, session, texts, SNAPSHOT, SNAP_DAY,
} from './_round6-kit.js';

/** The victim's board, and the stranger's — each with the legitimate pair this build writes. */
const VICTIM = () => v1board({
  notes: [note('n1', '2026-03-04', 'Zahnarzt'), note('n2', '2026-04-01', 'Steuer')],
});
const STRANGER = () => v1board({ notes: [note('x1', '2026-02-02', 'FREMDES BOARD')] });

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE FIVE KINDS, AND THE TWO THAT ARE ON THE WRONG SIDE
// ─────────────────────────────────────────────────────────────────────────────

describe('R6-5 · classifyBoardFile is now the whole precondition of ADR 006', () => {
  test('R6-5a SUCCEEDED (defect) · a ZERO-BYTE board.json is `absent`, so a stranger\'s log becomes the board — and is committed', async () => {
    const theirs = await bound(STRANGER());

    // board.json exists. It holds nothing, which is what an interrupted write leaves behind.
    const s = await bootWith({ board: '', ops: theirs.ops, checkpoint: theirs.checkpoint, snapshots: SNAPSHOT() });

    assert.equal(s.bootFailure, null, 'NOT a failed boot — the session may write');
    assert.equal(s.quarantine, null, 'the stranger\'s log was not even questioned');
    assert.equal(s._recoveredFrom?.from, 'op-log', 'R7 was taken: the log IS the board');
    assert.deepEqual(texts(s), ['FREMDES BOARD'], 'and a board that was never this user\'s is on screen');
    assert.equal(s.snapshots.length, 1, 'while snapshots.json sat beside it, read and unused');

    // …and the first autosave makes it permanent, which is precisely A3-C1's outcome.
    s._opsPersisted = false;
    await s.persistNow();
    assert.deepEqual(JSON.parse(LS.getItem(LS_BOARD)).notes.map((n) => n.text), ['FREMDES BOARD'],
      'the stranger\'s board is now what board.json says');
  });

  test('R6-5b FAILED (held) · ONE corrupted byte instead of zero — the control that shows the two are treated oppositely', async () => {
    const theirs = await bound(STRANGER());
    const mine = await bound(VICTIM());
    const s = await bootWith({
      board: mine.board.slice(0, 40),            // a truncated write: bytes present, not JSON
      ops: theirs.ops, checkpoint: theirs.checkpoint, snapshots: SNAPSHOT(),
    });
    assert.equal(s.bootFailure?.reason, 'board-unparseable');
    assert.equal(s.quarantine?.reason, 'board-unreadable', 'the log is refused on the absence of a tie');
    assert.deepEqual(texts(s), ['AUS DEM SCHNAPPSCHUSS'], 'and the snapshot stands in, labelled');
    assert.equal(s._recoveredFrom?.day, SNAP_DAY);
    const before = LS.getItem(LS_BOARD);
    await s.persistNow();
    assert.equal(LS.getItem(LS_BOARD), before, 'and the session writes nothing');
  });

  test('R6-5c SUCCEEDED (defect) · `{}` is `ok`: an empty board, a WRITABLE session, and this board\'s own log moved aside', async () => {
    const mine = await bound(VICTIM());
    const s = await bootWith({ board: {}, ops: mine.ops, checkpoint: mine.checkpoint, snapshots: SNAPSHOT() });

    assert.equal(s.bootFailure, null, 'no boot failure: `{}` is an object, so it is "a board"');
    assert.deepEqual(texts(s), [], 'the user\'s two appointments are gone from the screen');
    assert.equal(s.quarantine?.reason, 'board-carries-no-lineage',
      'and the log that IS this board\'s is refused, because `{}` carries no _v2');
    assert.ok(s.quarantine.movedAside, 'AND SEQUESTERED — the evidence is renamed on the first launch');
    assert.equal(LS.getItem(LS_CHECKPOINT), null, 'checkpoint.json is no longer at the name the app looks at');

    // `[]` — one character away — is treated as the disaster it is. `{}` is not.
    const t = await bootWith({ board: [], ops: mine.ops, checkpoint: mine.checkpoint, snapshots: SNAPSHOT() });
    assert.equal(t.bootFailure?.reason, 'board-not-a-board');
    assert.deepEqual(texts(t), ['AUS DEM SCHNAPPSCHUSS']);
  });

  test('R6-5d SUCCEEDED (defect) · and it is not only `{}`: any JSON object at all passes as a board', async () => {
    const mine = await bound(VICTIM());
    for (const shape of [{}, { schemaVersion: 1 }, { hello: 'welt' }, { notes: 'nicht ein array' }]) {
      const s = await bootWith({ board: shape, ops: mine.ops, checkpoint: mine.checkpoint, snapshots: SNAPSHOT() });
      assert.equal(s.bootFailure, null, `${J(shape)} boots writable`);
      assert.deepEqual(texts(s), [], `${J(shape)} draws an empty board`);
    }
  });

  test('R6-5e FAILED (held) · the three kinds the R5-3 fix DOES catch still go read-only over a snapshot', async () => {
    const mine = await bound(VICTIM());
    for (const [what, board] of [['an array', []], ['a number', '7'], ['a string', '"hallo"'], ['null', 'null']]) {
      const s = await bootWith({ board, ops: mine.ops, checkpoint: mine.checkpoint, snapshots: SNAPSHOT() });
      assert.equal(s.bootFailure?.reason, 'board-not-a-board', what);
      assert.equal(s.quarantine?.reason, 'board-unreadable', what);
      assert.ok(LS.getItem(LS_CHECKPOINT) !== null, `${what}: a failed boot never sequesters (R5-3b)`);
      assert.deepEqual(texts(s), ['AUS DEM SCHNAPPSCHUSS'], what);
    }
  });

  test('R6-5f FAILED (held) · a read that THROWS is `read-failed`, read-only, and touches nothing', async () => {
    const mine = await bound(VICTIM());
    LS.clear();
    LS.setItem(LS_BOARD, mine.board);
    if (mine.ops) LS.setItem(LS_OPS, mine.ops);
    LS.setItem(LS_CHECKPOINT, mine.checkpoint);
    LS.setItem('langzeitplaner.snapshots', J(SNAPSHOT()));
    const proto = Object.getPrototypeOf(LS);
    const real = proto.getItem;
    proto.getItem = function (k) {
      if (String(k) === LS_BOARD) throw new Error('EIO: the file is locked');
      return real.call(this, k);
    };
    let s;
    try { s = await bootV2(); } finally { proto.getItem = real; }
    assert.equal(s.bootFailure?.reason, 'board-read-failed');
    assert.equal(s.quarantine?.reason, 'board-unreadable');
    assert.deepEqual(texts(s), ['AUS DEM SCHNAPPSCHUSS']);
    await s.persistNow();
    assert.equal(LS.getItem(LS_BOARD), mine.board, 'the bytes are exactly as they were');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE INVERSE — REFUSING TO RECOVER WHEN RECOVERY WAS THE RIGHT ANSWER
// ─────────────────────────────────────────────────────────────────────────────

describe('R6-6 · the caution\'s own failure mode', () => {
  test('R6-6a SUCCEEDED (defect) · board.json gone + a log that will not load ⇒ an EMPTY, WRITABLE board, with the snapshot unread', async () => {
    // This is the morning ADR 006 §5.6 wrote three paragraphs about — "the one situation in which
    // the app has genuinely lost sight of the user's data and has to say so" — reached through
    // §5.5 instead, where none of that machinery exists. The board file is GONE. The log is the
    // only other record and it does not load. `snapshots.json` is right there.
    const s = await bootWith({ checkpoint: '{"horizon":"NICHT EIN STAMP"}', snapshots: SNAPSHOT() });

    assert.equal(s.quarantine?.reason, 'unreadable-log', 'the log was tried and refused');
    assert.deepEqual(texts(s), [], 'and the user gets an empty calendar');
    assert.equal(s.snapshots.length, 1, 'though snapshots.json was loaded — it is in `store.snapshots`');
    assert.equal(s._recoveredFrom, null, '…and never consulted: no recovery of any kind is reported');
    assert.equal(s.bootFailure, null, 'the session is NOT read-only, so this state is committable');

    s._opsPersisted = false;
    await s.persistNow();
    assert.deepEqual(JSON.parse(LS.getItem(LS_BOARD)).notes, [],
      'and the first autosave writes the empty board to disk');
  });

  test('R6-6b SUCCEEDED (defect) · the same for a log that loads and projects to NOTHING', async () => {
    const s = await bootWith({
      checkpoint: { horizon: null, regs: { v: 1, regs: {} }, lzp: { v: 2, lineageId: 'lin_ZZZZZZZZZZZZZZZZZZZZZZZZZZ', gen: 1 } },
      snapshots: SNAPSHOT(),
    });
    assert.equal(s._recoveredFrom?.from, 'op-log', 'reported as a recovery…');
    assert.deepEqual(texts(s), [], '…of nothing at all');
    assert.equal(s.bootFailure, null);
    assert.equal(s.snapshots.length, 1, 'with the snapshot unread beside it');
  });

  test('R6-6c FAILED (held) · board.json gone + a log that DOES load is recovered and said out loud', async () => {
    const mine = await bound(VICTIM());
    const s = await bootWith({ ops: mine.ops, checkpoint: mine.checkpoint, snapshots: SNAPSHOT() });
    assert.equal(s._recoveredFrom?.from, 'op-log');
    assert.deepEqual(texts(s).sort(), ['Steuer', 'Zahnarzt'], 'the work is back');
    assert.ok(s.warnings.some((w) => /Nothing verified that this log belongs to this board/.test(w)),
      'and the warning says out loud that nothing verified the tie');
    assert.equal(s._lineageId, JSON.parse(mine.checkpoint).lzp.lineageId,
      'the recovered board re-binds to the lineage it came out of (R5-3)');
  });

  test('R6-6d FAILED (held) · no board and no log is still a fresh install — story 15.1, INV-12', async () => {
    const s = await bootWith({ snapshots: SNAPSHOT() });
    assert.equal(s.state.settings.seenFirstRun, false, 'the first-run tour shows');
    assert.equal(s.quarantine, null);
    assert.equal(s.bootFailure, null);
    assert.equal(s._recoveredFrom, null);
  });
});
