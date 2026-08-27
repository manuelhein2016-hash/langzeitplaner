// ─────────────────────────────────────────────────────────────────────────────
// ROUND 6 — ADVERSARY, ATTACK 2: THE RECOVERY PATH   ·   FIXED, AND INVERTED
//
// R5-3 was the round-5 CRITICAL: `_recoverFromLog` — ADR 006's one asymmetric branch, which
// performs NO lineage check of any kind — was entered on `kind !== 'ok'`, so a `board.json` that
// merely failed to PARSE handed the board to whatever log was lying beside it. The fix narrowed
// the branch to ONE classification: `classifyBoardFile()` must answer `absent`.
//
// The whole of ADR 006 hangs off that one five-way answer. It decides, for the same accident
// one byte apart, between:
//
//     'absent'      → believe an unverified log, present it as the user's board, and COMMIT it
//     anything else → refuse every log, show a snapshot, and write nothing for the whole session
//
// Round 6 found three inputs on the wrong side of that line, in OPPOSITE directions, and round 7
// closed all three FROM THE ENUMERATED INPUT DOMAIN (`tests/helpers/domains.js` D1) rather than a
// branch at a time. Every row below now names the domain entry it pins.
//
//    R6-5a  a ZERO-BYTE `board.json` was `absent` — and an empty file is a FILE, the single most
//           likely outcome of an interrupted write. → `storage.loadBoardFile` now decides on the
//           BYTES: any string a store answers with, of any length INCLUDING ZERO, is the file's
//           bytes and `JSON.parse` judges them. `absent` means NO STORE ANSWERED WITH A STRING.
//           D1-b01 × all four sources.
//    R6-5c/d  `{}` — and any JSON object at all — was `ok`, i.e. an AUTHORITATIVE assertion that
//           the board is empty. → `classifyBoardFile` now asks whether the object carries any of
//           a board's own collections in a board's shape (`boardKeysOf`). D1-b14…b18.
//    R6-6a/b  the inverse: `board.json` genuinely gone + a log that will not load (or that loads
//           and asserts nothing) was an EMPTY, WRITABLE board with `snapshots.json` unread. → the
//           outcome of a recovery is now enumerated (R-a/R-b/R-c in `_recoverFromLog`) and the
//           two that recover nothing go to `_bootRecoveryFailed`, which is §5.6's machinery.
//           D1-r3, D1-r4, D1-r5.
//
// §3 holds the controls that stop "refuse everything" and "recover nothing" passing as fixes.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  LS, LS_BOARD, LS_OPS, LS_CHECKPOINT, v2store, bootV2, v1board, note,
  J, bound, bootWith, slots, session, texts, SNAPSHOT, SNAP_DAY,
} from './_round6-kit.js';
import { minter, DEV, ME, PSP } from './_kit.js';

/** The victim's board, and the stranger's — each with the legitimate pair this build writes. */
const VICTIM = () => v1board({
  notes: [note('n1', '2026-03-04', 'Zahnarzt'), note('n2', '2026-04-01', 'Steuer')],
});
const STRANGER = () => v1board({ notes: [note('x1', '2026-02-02', 'FREMDES BOARD')] });

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE BYTES DECIDE — `board.json` AS AN INPUT, NOT AS A BRANCH (domain D1)
// ─────────────────────────────────────────────────────────────────────────────

describe('R6-5 · classifyBoardFile is the whole precondition of ADR 006, and it is driven by the bytes', () => {
  test('R6-5a INVERTED (D1-b01) · a ZERO-BYTE board.json is a FILE: read-only, snapshot shown, the stranger\'s log refused', async () => {
    const theirs = await bound(STRANGER());

    // board.json exists. It holds nothing, which is what an interrupted write leaves behind.
    const s = await bootWith({ board: '', ops: theirs.ops, checkpoint: theirs.checkpoint, snapshots: SNAPSHOT() });

    assert.equal(s.bootFailure?.reason, 'board-unparseable',
      'zero bytes are bytes: the file is there and it does not say what the board is');
    assert.match(s.bootFailure.detail, /EMPTY — zero bytes/,
      'and the reason says WHICH unparseable it is, because "0 bytes are still on disk" reads like a bug');
    assert.equal(s.quarantine?.reason, 'board-unreadable', 'the stranger\'s log is refused, not adopted');
    assert.equal(s._recoveredFrom?.from, 'snapshot', 'R7 was NOT taken');
    assert.deepEqual(texts(s), ['AUS DEM SCHNAPPSCHUSS'], 'snapshots.json stands in, labelled');
    assert.equal(s._recoveredFrom.day, SNAP_DAY);
    assert.equal(s.state.notes.some((n) => /FREMD/.test(n.text)), false,
      'and no board that was never this user\'s reaches the screen');

    // …and the session cannot make any of it permanent. This is the half that made R6-5a a
    // CRITICAL rather than a scare: the old path was WRITABLE.
    const before = slots();
    s._opsPersisted = false;
    await s.persistNow();
    assert.deepEqual(slots(), before, 'every slot is byte-identical after a persist');
    assert.equal(LS.getItem(LS_BOARD), '', 'the zero bytes are still exactly zero bytes, for a rescue pass');
    assert.ok(LS.getItem(LS_CHECKPOINT) !== null, 'and a failed boot never sequesters the log (R5-3b)');
  });

  test('R6-5a2 INVERTED (D1-b01 × D1_SOURCES) · all four places bytes can come from agree, and only a store that answers with NO string is `absent`', async () => {
    // The source axis is the other half of R5-3c's lesson: `saveBoardText` falls back to
    // localStorage, so a native read that misses or throws MUST still look there — and what it
    // finds there is judged by the same rule. `fallback` may change; `status` may not.
    const storage = await import('../../src/js/storage.js');
    const w = globalThis.window;
    const had = Object.prototype.hasOwnProperty.call(w, '__TAURI__');
    const prev = w.__TAURI__;
    const withNative = async (native, bytes, fn) => {
      w.__TAURI__ = { core: { invoke: async (cmd) => {
        assert.equal(cmd, 'load_board');
        if (native === 'throws') throw new Error('EIO: the file is locked');
        if (native === 'missing') return null;
        return bytes;
      } } };
      try { return await fn(); } finally { if (had) w.__TAURI__ = prev; else delete w.__TAURI__; }
    };
    try {
      LS.clear(); LS.setItem(LS_BOARD, '');
      assert.equal((await storage.loadBoardFile()).status, 'unparseable', 'browser');

      LS.clear();
      assert.equal((await withNative('bytes', '', () => storage.loadBoardFile())).status, 'unparseable',
        'Tauri, the native read answers with zero bytes');

      LS.clear(); LS.setItem(LS_BOARD, '');
      assert.equal((await withNative('throws', null, () => storage.loadBoardFile())).status, 'unparseable',
        'Tauri, the native read threw and the localStorage fallback holds zero bytes');
      LS.clear(); LS.setItem(LS_BOARD, '');
      assert.equal((await withNative('missing', null, () => storage.loadBoardFile())).status, 'unparseable',
        'Tauri, the native read returned nothing and the fallback holds zero bytes');

      // THE CONTROLS ON THE OTHER SIDE OF THE RULE — `absent` is still reachable, and still
      // exactly as narrow as it was. D1-n01/n02/n03.
      LS.clear();
      assert.equal((await withNative('throws', null, () => storage.loadBoardFile())).status, 'read-failed',
        'a thrown native read with an EMPTY fallback is a FACT, never an absence (D1-n01)');
      LS.clear();
      assert.equal((await withNative('missing', null, () => storage.loadBoardFile())).status, 'absent',
        'a native miss with an empty fallback is the fresh install it looks like (D1-n02)');
      LS.clear();
      assert.equal((await storage.loadBoardFile()).status, 'absent', 'a browser with no key at all (D1-n03)');

      // …and the fallback a failed SAVE leaves behind is still reachable, `fallback` and all.
      LS.clear(); LS.setItem(LS_BOARD, J(VICTIM()));
      const viaFallback = await withNative('throws', null, () => storage.loadBoardFile());
      assert.equal(viaFallback.status, 'ok');
      assert.equal(viaFallback.fallback, true, 'and it says which store answered');
    } finally {
      if (had) w.__TAURI__ = prev; else delete w.__TAURI__;
    }
  });

  test('R6-5b FAILED (held) · ONE corrupted byte instead of zero — the control that shows the two are now treated ALIKE', async () => {
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

  test('R6-5c INVERTED (D1-b14) · `{}` is NOT a board: read-only, the snapshot shown, and this board\'s own log left where it is', async () => {
    const mine = await bound(VICTIM());
    const s = await bootWith({ board: {}, ops: mine.ops, checkpoint: mine.checkpoint, snapshots: SNAPSHOT() });

    assert.equal(s.bootFailure?.reason, 'board-not-a-board',
      'an object with none of a board\'s collections is not an assertion that the board is empty');
    assert.match(s.bootFailure.detail, /none of a board's collections/);
    assert.deepEqual(texts(s), ['AUS DEM SCHNAPPSCHUSS'],
      'the user\'s two appointments are not replaced by an empty screen');
    assert.equal(s.quarantine?.reason, 'board-unreadable',
      'and the log is refused for the honest reason — nothing ties it, not "the board carries no lineage"');
    assert.equal(s.quarantine.movedAside, null, 'NOT sequestered: a failed boot never renames the evidence');
    assert.ok(LS.getItem(LS_CHECKPOINT) !== null, 'checkpoint.json is still at the name the app looks at');

    // `[]` — one character away — was always treated as the disaster it is. Now `{}` is too.
    const t = await bootWith({ board: [], ops: mine.ops, checkpoint: mine.checkpoint, snapshots: SNAPSHOT() });
    assert.equal(t.bootFailure?.reason, 'board-not-a-board');
    assert.deepEqual(texts(t), ['AUS DEM SCHNAPPSCHUSS']);
  });

  test('R6-5d INVERTED (D1-b15/b16/b17) · and it is not only `{}`: no JSON object passes as a board without a board\'s collections', async () => {
    const mine = await bound(VICTIM());
    for (const shape of [{}, { schemaVersion: 1 }, { hello: 'welt' }, { notes: 'nicht ein array' }]) {
      const s = await bootWith({ board: shape, ops: mine.ops, checkpoint: mine.checkpoint, snapshots: SNAPSHOT() });
      assert.equal(s.bootFailure?.reason, 'board-not-a-board', `${J(shape)} boots READ-ONLY`);
      assert.deepEqual(texts(s), ['AUS DEM SCHNAPPSCHUSS'], `${J(shape)} shows the snapshot, not an empty board`);
      const before = slots();
      await s.persistNow();
      assert.deepEqual(slots(), before, `${J(shape)}: and nothing on disk moves`);
    }
  });

  test('R6-5g INVERTED (D1-b18) · the ENVELOPE-ONLY object — the one member of the `{}` class that cost CONTENT, not history', async () => {
    // `{"_v2":{lineageId:<the victim's own>,gen:N}}` is not a corrupt file: it is exactly, and
    // only, ADR 006 §4.1's additive key. Under `Array.isArray` it classified `ok`, so the verdict
    // was `same-lineage`, the log was ADOPTED, and `_reconcileOntoBoard` then minted one
    // `{_alive:false}` per entity — "the log has a live entry the board lacks" is an honoured
    // deletion (§5.4) and this "board" lacks all of them. The empty board and the tombstones were
    // both committed, and at WP-8 what propagates is not a corrupt file but well-formed deletes
    // this app minted itself. `_v2` is not content, and it is not a board.
    const mine = await bound(VICTIM());
    const lineageId = JSON.parse(mine.checkpoint).lzp.lineageId;
    const s = await bootWith({
      board: { _v2: { lineageId, gen: 9 } },
      ops: mine.ops, checkpoint: mine.checkpoint, snapshots: SNAPSHOT(),
    });

    assert.equal(s.bootFailure?.reason, 'board-not-a-board',
      'the envelope alone is not a board, however well-formed the lineage inside it is');
    assert.equal(s._adopted, null, 'so the log is never adopted…');
    assert.equal(s.quarantine?.reason, 'board-unreadable', '…and never reconciled against');
    assert.deepEqual(texts(s), ['AUS DEM SCHNAPPSCHUSS'], 'the snapshot stands in');

    const before = slots();
    s._opsPersisted = false;
    await s.persistNow();
    assert.deepEqual(slots(), before, 'and not one tombstone is minted, let alone committed');
  });

  test('R6-5e FAILED (held) · the three kinds the R5-3 fix already caught still go read-only over a snapshot', async () => {
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

  test('R6-5h FAILED (held) · THE NON-VACUITY CONTROL: a board that IS a board still boots normally, on every shape a board has ever had', async () => {
    // The failure mode of every fix in this file is "refuse everything". These are the boards
    // `boardKeysOf` must keep saying yes to — D1-b19/b20/b21, plus v0's four-key shape and a
    // board that carries exactly ONE collection, which is all the rule ever asked for.
    const withLineage = await bound(VICTIM());
    const SHAPES = {
      'a v1 board (no _v2)': J(VICTIM()),
      'a v2 board with a lineage': withLineage.board,
      '`_v2` present but carrying no lineage': J({ ...VICTIM(), _v2: { gen: 3 } }),
      'a v0 board: no schemaVersion, no scratchpads': J({
        notes: [{ id: 'n1', date: '2026-02-02', text: 'alt', categoryId: 'c-a' }],
        bars: [], categories: [{ id: 'c-a', name: 'Alt', paletteRef: 'rot', visible: true }],
        settings: { language: 'en' },
      }),
      'settings and nothing else': J({ settings: { rowHeight: 26 } }),
      'an EMPTY but well-shaped board — the one this app itself writes on a fresh install': J({
        schemaVersion: 1, notes: [], bars: [], categories: [], scratchpads: {}, settings: {},
      }),
    };
    for (const [what, board] of Object.entries(SHAPES)) {
      const s = await bootWith({ board, snapshots: SNAPSHOT() });
      assert.equal(s.bootFailure, null, `${what}: boots writable`);
      assert.equal(s._recoveredFrom, null, `${what}: and is not a recovery of anything`);
    }
    // …and the one that has to keep working end to end: a board plus its OWN log, adopted,
    // reconciled to nothing. Removing `settings`/`scratchpads` from `BOARD_SHAPE` would not be
    // caught by the shapes above alone.
    const s = await bootWith({ board: withLineage.board, ops: withLineage.ops, checkpoint: withLineage.checkpoint });
    assert.equal(s.bootFailure, null);
    assert.equal(s.quarantine, null, 'the board\'s own log is still adopted');
    assert.equal(s._adopted?.reconciled, 0, 'and the plan is EMPTY on an exact match (INV-4)');
    assert.deepEqual(texts(s).sort(), ['Steuer', 'Zahnarzt']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE INVERSE — REFUSING TO RECOVER WHEN RECOVERY WAS THE RIGHT ANSWER
// ─────────────────────────────────────────────────────────────────────────────

describe('R6-6 · the caution\'s own failure mode', () => {
  test('R6-6a INVERTED (D1-r3) · board.json gone + a log that will not load ⇒ READ-ONLY over the snapshot, not an empty committable board', async () => {
    // This is the morning ADR 006 §5.6 wrote three paragraphs about — "the one situation in which
    // the app has genuinely lost sight of the user's data and has to say so" — reached through
    // §5.5, where none of that machinery used to exist. The board file is GONE. The log is the
    // only other record and it does not load. `snapshots.json` is right there, and is now read.
    const s = await bootWith({ checkpoint: '{"horizon":"NICHT EIN STAMP"}', snapshots: SNAPSHOT() });

    assert.equal(s.quarantine?.reason, 'unreadable-log', 'the log was tried and refused');
    assert.equal(s.bootFailure?.reason, 'recovery-unusable',
      'and a recovery that recovered nothing is not a fresh install');
    assert.equal(s._recoveredFrom?.from, 'snapshot', 'snapshots.json is CONSULTED, not merely loaded');
    assert.deepEqual(texts(s), ['AUS DEM SCHNAPPSCHUSS'], 'and it is what the user sees');
    assert.equal(s._recoveredFrom.day, SNAP_DAY);
    assert.ok(s.warnings.some((w) => /THIS IS NOT A FRESH INSTALL/.test(w)),
      `and the warning says so out loud: ${J(s.warnings)}`);
    assert.equal(s.quarantine.movedAside, null,
      'the refused log is left where it is: on this path it may be the freshest record that exists');

    const before = slots();
    s._opsPersisted = false;
    await s.persistNow();
    assert.deepEqual(slots(), before, 'and nothing is committed — least of all an empty board.json');
    assert.equal(LS.getItem(LS_BOARD), null, 'the missing file stays missing, for a rescue pass');
  });

  test('R6-6b INVERTED (D1-r4) · the same for a log that loads cleanly and asserts NOTHING', async () => {
    const s = await bootWith({
      checkpoint: { horizon: null, regs: { v: 1, regs: {} }, lzp: { v: 2, lineageId: 'lin_ZZZZZZZZZZZZZZZZZZZZZZZZZZ', gen: 1 } },
      snapshots: SNAPSHOT(),
    });
    assert.equal(s._recoveredFrom?.from, 'snapshot',
      'NOT reported as a recovery `from: op-log` — of nothing at all');
    assert.equal(s.diagnostics().source, 'board.json',
      'and `source` does not say "recovery" about a boot on which nothing was recovered');
    assert.equal(s.quarantine, null, 'the log is NOT quarantined: nothing is wrong with it, it is empty');
    assert.equal(s.bootFailure?.reason, 'recovery-unusable');
    assert.deepEqual(texts(s), ['AUS DEM SCHNAPPSCHUSS'], 'the snapshot is shown instead');
    const before = slots();
    s._opsPersisted = false;
    await s.persistNow();
    assert.deepEqual(slots(), before);
  });

  test('R6-6f INVERTED (D1-r5) · the genuinely unrecoverable morning: empty is allowed, SILENT and WRITABLE are not', async () => {
    const s = await bootWith({ checkpoint: '{"horizon":"NICHT EIN STAMP"}' });
    assert.equal(s.quarantine?.reason, 'unreadable-log');
    assert.equal(s.bootFailure?.reason, 'recovery-unusable', 'read-only');
    assert.equal(s._recoveredFrom?.from, 'none', 'nothing stood in, and it says so rather than saying nothing');
    assert.deepEqual(texts(s), [], 'the calendar is empty…');
    assert.ok(s.warnings.some((w) => /it is empty because nothing could be read/i.test(w)),
      `…and the warning says WHY it is empty: ${J(s.warnings)}`);
    const before = slots();
    s._opsPersisted = false;
    await s.persistNow();
    assert.deepEqual(slots(), before, 'and the emptiness is not committed');
  });

  test('R6-6c FAILED (held) · board.json gone + a log that DOES load is recovered and said out loud', async () => {
    const mine = await bound(VICTIM());
    const s = await bootWith({ ops: mine.ops, checkpoint: mine.checkpoint, snapshots: SNAPSHOT() });
    assert.equal(s._recoveredFrom?.from, 'op-log');
    assert.equal(s.bootFailure, null, 'a real recovery is WRITABLE — this is the row that stops "refuse everything"');
    assert.deepEqual(texts(s).sort(), ['Steuer', 'Zahnarzt'], 'the work is back');
    assert.ok(s.warnings.some((w) => /Nothing verified that this log belongs to this board/.test(w)),
      'and the warning says out loud that nothing verified the tie');
    assert.equal(s._lineageId, JSON.parse(mine.checkpoint).lzp.lineageId,
      'the recovered board re-binds to the lineage it came out of (R5-3)');
  });

  test('R6-6e FAILED (held) · a log with content that will not PROJECT is still recovered — the control on `_logAssertsNothing`', async () => {
    // The failure mode of R6-6b's fix is answering "this log asserts nothing" when the truth is
    // "this log asserts something this build cannot draw yet". `_projectSafe` repairs exactly
    // that, one setting at a time, discarding no entry — so a projection that THROWS must never
    // be read as an empty log. Same shape as R4-8a, asserted here by name.
    const mk = minter(DEV.meDesk, { act: ME });
    const s = await bootWith({
      ops: [
        mk('note.set', 'note:r1', { text: 'gerettet', date: '2026-03-04', _alive: true }, { space: PSP }),
        mk('pref.set', 'pref:app', { mode: 'pinned', startMonth: 'nope' }, { space: PSP, ctr: 1 }),
      ],
      snapshots: SNAPSHOT(),
    });
    assert.equal(s._recoveredFrom?.from, 'op-log', 'still a recovery: the log has a note in it');
    assert.equal(s.bootFailure, null, 'and still writable — a repairable setting is not a lost board');
    assert.deepEqual(texts(s), ['gerettet'], 'the note the log carried is on screen');
    assert.ok(s.warnings.some((w) => /could not be drawn with the settings it was loaded with/.test(w)),
      'and `_projectSafe` says which setting it reset — the refusal is repaired, not read as emptiness');
  });

  test('R6-6d FAILED (held) · no board and NO log is still a fresh install — story 15.1, INV-12', async () => {
    const s = await bootWith({ snapshots: SNAPSHOT() });
    assert.equal(s.state.settings.seenFirstRun, false, 'the first-run tour shows');
    assert.equal(s.quarantine, null);
    assert.equal(s.bootFailure, null, 'and it is WRITABLE — the other half of "refuse everything"');
    assert.equal(s._recoveredFrom, null);
    await session();
    assert.ok(LS.getItem(LS_BOARD) !== null, 'a fresh install still writes its board');
  });
});
