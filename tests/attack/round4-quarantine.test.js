// ─────────────────────────────────────────────────────────────────────────────
// ROUND 4 — ADVERSARY, ATTACK 1: THE A3-C1 QUARANTINE
//
// INVERTED 2026-08-27 · ADR 006 (`docs/v2/adr/006-board-log-authority.md`) is implemented.
//
// The rows below were green BECAUSE the defects existed. What they attacked was the second of
// three attempts at one question — when `board.json` and the op log disagree, who wins?
//
//   attempt 1  `shouldMigrate(board, {opsLogExists})` — "is there a log?"        killed by R3-31
//   attempt 2  a provenance envelope + an entity CENSUS with a zero-overlap gate  killed by R4-1a
//   attempt 3  a bigger threshold                                                killed on paper
//
// ADR 006 §2 is the argument that ended the tuning: "the log is this board's own log, one persist
// behind" (R4-4a) and "the log is another board's" (R4-2a) produce THE SAME OBSERVATION — the
// board has keys the log lacks — so no function of set overlap can separate them and no threshold
// over it can be correct. The information was not in the key sets; it had to be written to disk
// deliberately, BY BOTH FILES.
//
// THE RULE NOW: `board.json` is the truth, the log is history. Every launch migrates
// `board.json` into an op set and the log is reconciled ONTO it. The gate is one equality —
// `checkpoint.lzp.lineageId === board._v2.lineageId` — and it is affordable precisely because
// adoption cannot change content: the reconciliation is a DIFF, and the board wins every
// disagreement at a fresh stamp.
//
// So this file now measures three things instead of one:
//   §1  a stranger's log changes nothing, whatever it names (the census is gone, not widened);
//   §2  two boards swapped: one comparison, no shared-key arithmetic;
//   §3  the inverse — a log this build wrote is still adopted, and a version bump is not a refusal;
//   §4  the crash between the two writes KEEPS the user's work, above the log's horizon.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { LS, LS_BOARD, LS_OPS, LS_CHECKPOINT, v2store, bootV2, v1board, note } from './_upgrade-harness.js';
import { minter, DEV, ME, PSP } from './_kit.js';

const op = minter(DEV.meDesk, { act: ME });
const J = (v) => JSON.stringify(v);
const jsonl = (ops) => ops.map((o) => JSON.stringify(o)).join('\n');

/** A real user's board: five appointments, two categories, one month of scratchpad. */
const VICTIM = () => v1board({
  notes: [
    note('n1', '2026-03-04', 'Zahnarzt'), note('n2', '2026-04-01', 'Steuer'),
    note('n3', '2026-05-09', 'Geburtstag Mama'), note('n4', '2026-06-10', 'Urlaub'),
    note('n5', '2026-07-11', 'Konzert'),
  ],
  scratchpads: { '2026-03': 'Einkaufen: Milch, Brot' },
});

/** Boot v2 over exactly these three slots and report what survived. */
async function bootWith({ board, ops, checkpoint }) {
  LS.clear();
  if (board !== undefined) LS.setItem(LS_BOARD, typeof board === 'string' ? board : J(board));
  if (ops !== undefined) LS.setItem(LS_OPS, typeof ops === 'string' ? ops : jsonl(ops));
  if (checkpoint !== undefined) LS.setItem(LS_CHECKPOINT, typeof checkpoint === 'string' ? checkpoint : J(checkpoint));
  await bootV2();
  return v2store;
}

/**
 * A LEGITIMATE log for `board`, written by this build over that board — envelope, census and all.
 * `_opsPersisted` is what WP-8 turns on when a space is created; forcing it here is the only way
 * to make the shipping store write the two files it does not write in solo mode (A3-M5/§9).
 */
async function realLogFor(board) {
  LS.clear();
  LS.setItem(LS_BOARD, J(board));
  await bootV2();
  v2store._opsPersisted = true;
  await v2store.persistNow();
  return { board: LS.getItem(LS_BOARD), ops: LS.getItem(LS_OPS), checkpoint: LS.getItem(LS_CHECKPOINT) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. A STRANGER'S LOG NOW CHANGES NOTHING, WHATEVER IT NAMES
// ─────────────────────────────────────────────────────────────────────────────

describe('R4-1 · A3-C1: a log that is not bound to this board contributes nothing', () => {
  test('R4-1a INVERTED (ADR 006) · ONE stray op naming pad:2026-03 changes nothing at all', async () => {
    // `pad:<YYYY-MM>` is the whole pad key space (entities.js:parseEntityKey) — a MONTH, not a
    // UUID, shared by every board in existence and guessable in one try. Under the census that was
    // enough to make an unrelated log authoritative. There is no census any more: a bare
    // `ops.jsonl` carries no header and therefore no lineage, so it is never adopted.
    const s = await bootWith({ board: VICTIM(), ops: [op('pad.set', 'pad:2026-03', { text: 'fremd' }, { space: PSP })] });

    assert.equal(s.ready, true);
    assert.equal(s.quarantine?.reason, 'no-checkpoint', 'refused, and the reason names a fact');
    assert.equal(s.state.notes.length, 5, 'five appointments');
    assert.equal(s.state.categories.length, 2, 'both categories');
    assert.deepEqual(s.state.scratchpads, { '2026-03': 'Einkaufen: Milch, Brot' }, "and the user's own text");

    await s.persistNow();
    const onDisk = JSON.parse(LS.getItem(LS_BOARD));
    assert.equal(onDisk.notes.length, 5, 'the autosave writes the whole board back');
    assert.equal(onDisk.categories.length, 2);
    assert.equal(onDisk._v2, undefined, 'and solo mode still writes no _v2 (ADR 006 §4.1)');
  });

  test('R4-1b INVERTED · an op naming a note the board DOES carry is equally inert', async () => {
    const s = await bootWith({ board: VICTIM(), ops: [op('note.set', 'note:n1', { text: 'fremd' }, { space: PSP })] });
    assert.equal(s.quarantine?.reason, 'no-checkpoint');
    assert.equal(s.state.notes.length, 5, 'every note');
    assert.equal(s.state.categories.length, 2, 'every category');
    assert.equal(s.state.notes.find((n) => n.id === 'n1').text, 'Zahnarzt', "and n1 is the user's, not the stranger's");
  });

  test('R4-1c · the zero-overlap case is refused too — for the same reason, not a different one', async () => {
    // The point of the inversion: one reason covers both, because overlap is no longer consulted.
    const s = await bootWith({ board: VICTIM(), ops: [op('note.set', 'note:nobody', { text: 'fremd' }, { space: PSP })] });
    assert.equal(s.quarantine?.reason, 'no-checkpoint');
    assert.equal(s.state.notes.length, 5, 'the board is intact');
  });

  test('R4-1d INVERTED · nothing is called "drift" any more, and the refusal is a quarantine', async () => {
    const s = await bootWith({ board: VICTIM(), ops: [op('pad.set', 'pad:2026-03', { text: 'fremd' }, { space: PSP })] });
    assert.deepEqual(s.warnings.filter((w) => /never heard of|the log is authoritative once it exists/.test(w)), [],
      'the "drift" warning that used to describe a hostile swap as expected is gone with the branch that produced it');
    assert.ok(s.warnings.some((w) => /QUARANTINED \(no-checkpoint\)/.test(w)), JSON.stringify(s.warnings));
  });

  test('R4-1e · INV-1, the ADR in one assertion: an unadoptable log cannot change content', async () => {
    // content(boot(B, L)) ≡ content(boot(B, ∅)) for every hostile L.
    const content = (st) => JSON.stringify({
      notes: st.notes, bars: st.bars, categories: st.categories, scratchpads: st.scratchpads,
    });
    const alone = content((await bootWith({ board: VICTIM() })).state);
    const HOSTILE = {
      'zero overlap': [op('note.set', 'note:nobody', { text: 'x' }, { space: PSP })],
      'one key': [op('pad.set', 'pad:2026-03', { text: 'x' }, { space: PSP })],
      'every key': [
        op('note.set', 'note:n1', { text: 'x' }, { space: PSP }),
        op('note.set', 'note:n2', { text: 'x' }, { space: PSP, ctr: 1 }),
        op('note.set', 'note:n3', { text: 'x' }, { space: PSP, ctr: 2 }),
        op('note.set', 'note:n4', { text: 'x' }, { space: PSP, ctr: 3 }),
        op('note.set', 'note:n5', { text: 'x' }, { space: PSP, ctr: 4 }),
        op('pad.set', 'pad:2026-03', { text: 'x' }, { space: PSP, ctr: 5 }),
      ],
      'every key plus tombstones': [
        op('note.set', 'note:n1', { _alive: false }, { space: PSP }),
        op('note.set', 'note:n2', { _alive: false }, { space: PSP, ctr: 1 }),
        op('pad.set', 'pad:2026-03', { _alive: false }, { space: PSP, ctr: 2 }),
      ],
    };
    for (const [what, ops] of Object.entries(HOSTILE)) {
      const s = await bootWith({ board: VICTIM(), ops });
      assert.equal(content(s.state), alone, `${what}: the board is the board it would be with no log at all`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. TWO BOARDS SWAPPED BETWEEN MACHINES
// ─────────────────────────────────────────────────────────────────────────────

describe('R4-2 · two boards swapped between machines', () => {
  test("R4-2a INVERTED (INV-2) · board A + board B's LEGITIMATE checkpoint is one comparison", async () => {
    const A = v1board({ notes: [note('a1', '2026-03-04', 'A-Notiz')], scratchpads: { '2026-03': 'Board A' } });
    const B = v1board({
      notes: [note('b1', '2026-09-09', 'B-Notiz'), note('b2', '2026-10-10', 'B2')],
      categories: [{ id: 'cat-b', name: 'B', nameEn: 'B', paletteRef: 'blau', visible: true }],
      scratchpads: { '2026-03': 'Board B' },
    });
    const logA = await realLogFor(A);
    const logB = await realLogFor(B);
    const lzpA = JSON.parse(logA.checkpoint).lzp;
    const lzpB = JSON.parse(logB.checkpoint).lzp;
    assert.notEqual(lzpA.lineageId, lzpB.lineageId, 'two boards, two lineages');
    assert.equal(JSON.parse(logB.board)._v2.lineageId, lzpB.lineageId, 'and each board names its own');

    const s = await bootWith({ board: logA.board, checkpoint: logB.checkpoint });
    assert.equal(s.quarantine?.reason, 'foreign-lineage', "B's checkpoint belongs to B, and one equality says so");
    assert.deepEqual(s.state.notes.map((n) => n.id), ['a1'], 'A is showing A');
    assert.deepEqual(s.state.scratchpads, { '2026-03': 'Board A' }, 'including the month key they share');
    assert.deepEqual(s.warnings.filter((w) => /folded from a different generation/.test(w)), [],
      'no fingerprint arithmetic is involved any more, so there is no "generation" warning to mistake for benign');
  });

  test('R4-2b · the same swap with no month key in common is refused for the same reason', async () => {
    const A = v1board({ notes: [note('a1', '2026-03-04', 'A-Notiz')], scratchpads: { '2027-01': 'Board A' } });
    const B = v1board({
      notes: [note('b1', '2026-09-09', 'B-Notiz')],
      categories: [{ id: 'cat-b', name: 'B', nameEn: 'B', paletteRef: 'blau', visible: true }],
      scratchpads: { '2026-03': 'Board B' },
    });
    const logB = await realLogFor(B);
    const s = await bootWith({ board: A, checkpoint: logB.checkpoint });
    assert.equal(s.quarantine?.reason, 'board-carries-no-lineage',
      'A has never had a log, so nothing is adoptable — and how many keys it shares with B is not asked');
    assert.deepEqual(s.state.notes.map((n) => n.id), ['a1']);
  });

  test('R4-2c · INV-11: only the lineage decides. Every other envelope field is inert.', async () => {
    const A = VICTIM();
    const logA = await realLogFor(A);
    const board = JSON.parse(logA.board);
    for (const mutate of [
      (cp) => { cp.lzp.gen = 9999; },
      (cp) => { cp.lzp.at = 0; },
      (cp) => { cp.lzp.boardHash = 'deadbeef:1'; },
      (cp) => { cp.lzp.v = 99; },
      (cp) => { delete cp.lzp.boardHash; },
    ]) {
      const cp = JSON.parse(logA.checkpoint);
      mutate(cp);
      const s = await bootWith({ board: logA.board, checkpoint: J(cp) });
      assert.equal(s.quarantine, null, 'adopted: none of these is part of the verdict');
      assert.equal(s.state.notes.length, 5);
    }
    // `_v2.gen` on the BOARD is equally inert …
    const bumped = { ...board, _v2: { ...board._v2, gen: 12345 } };
    let s = await bootWith({ board: bumped, checkpoint: logA.checkpoint });
    assert.equal(s.quarantine, null, '_v2.gen is diagnostics, not a verdict');
    // … and one character of either lineageId is not.
    const flipped = { ...board, _v2: { ...board._v2, lineageId: `${board._v2.lineageId.slice(0, -1)}Z` } };
    s = await bootWith({ board: flipped, checkpoint: logA.checkpoint });
    assert.equal(s.quarantine?.reason, 'foreign-lineage');
    assert.equal(s.state.notes.length, 5, 'and the board is still whole — a quarantine cannot cost content');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE INVERSE — can the rule refuse a log that IS this board's?
// ─────────────────────────────────────────────────────────────────────────────

describe("R4-3 · the inverse: refusing a log that is genuinely this board's", () => {
  test('R4-3a INVERTED (INV-7) · a checkpoint from a NEWER build is ADOPTED — `lzp.v` is never consulted', async () => {
    // E1 ships an updater. Under attempt 2 an unknown envelope version was an unconditional
    // refusal, and the reason it gave ("carries no `lzp` provenance envelope") was not what had
    // happened. ADR 006 §4.2 freezes `lineageId` and `gen` FOREVER precisely so that a build which
    // cannot read the rest of the envelope can still read the two fields that matter.
    const A = VICTIM();
    const logA = await realLogFor(A);
    const cp = JSON.parse(logA.checkpoint);
    cp.lzp.v = 99;
    cp.lzp.somethingFromTheFuture = { nested: true };
    const s = await bootWith({ board: logA.board, checkpoint: J(cp) });

    assert.equal(s.quarantine, null, 'a version bump is not a refusal');
    assert.equal(s.diagnostics().source, 'op-log');
    assert.equal(s.state.notes.length, 5);
  });

  test('R4-3b · a checkpoint with no lzp at all IS refused, and costs no content', async () => {
    const A = VICTIM();
    const logA = await realLogFor(A);
    const cp = JSON.parse(logA.checkpoint);
    delete cp.lzp;
    const s = await bootWith({ board: logA.board, checkpoint: J(cp) });
    assert.equal(s.quarantine?.reason, 'log-carries-no-lineage');
    assert.equal(s.state.notes.length, 5, 'every entry the user can see survived the refusal');
    assert.deepEqual(s.state.scratchpads, { '2026-03': 'Einkaufen: Milch, Brot' });
  });

  test('R4-3c UPDATED (I-6) · the quarantine promises: not applied, NOT DELETED, not overwritten', async () => {
    // Promise 2 used to be "left exactly where it is", which meant the refusal was re-derived and
    // re-reported on every launch with no way for the user to make it stop (I-6). The sanctioned
    // form is a MOVE: the bytes are still on disk, under a name that says why, and they are not
    // read again. Nothing is deleted — that is asserted below on the bytes themselves.
    const A = VICTIM();
    const logA = await realLogFor(A);
    const cp = JSON.parse(logA.checkpoint);
    delete cp.lzp;
    const cpBytes = J(cp);
    const opBytes = jsonl([op('note.set', 'note:nobody', { text: 'x' }, { space: PSP })]);
    const s = await bootWith({ board: logA.board, ops: opBytes, checkpoint: cpBytes });

    assert.equal(s.quarantine?.reason, 'log-carries-no-lineage');
    assert.equal(s._opsPersisted, false, 'the structural half of promise 3');
    const moved = s.quarantine.movedAside;
    assert.ok(moved && moved.ops && moved.checkpoint, 'both slots were moved aside');
    assert.equal(LS.getItem(moved.checkpoint), cpBytes, 'checkpoint.json, byte for byte, under its quarantine name');
    assert.equal(LS.getItem(moved.ops), opBytes, 'ops.jsonl, byte for byte');

    await s.persistNow();
    s.apply('createNoteInline', { id: 'later', date: '2026-08-08', text: 'danach', categoryId: s.state.categories[0].id });
    await s.persistNow();
    assert.equal(LS.getItem(moved.checkpoint), cpBytes, 'still byte-identical after a full session');
    assert.equal(LS.getItem(moved.ops), opBytes);
    assert.equal(LS.getItem(LS_CHECKPOINT), null, 'and nothing was written into the live slots');
    assert.equal(LS.getItem(LS_OPS), null);
  });

  test('R4-3d · INV-15, promise 4: the same board loads identically with and without the refused files', async () => {
    const A = VICTIM();
    const logA = await realLogFor(A);
    const cp = JSON.parse(logA.checkpoint);
    delete cp.lzp;
    const withLog = await bootWith({ board: logA.board, checkpoint: J(cp), ops: jsonl([op('note.set', 'note:nobody', { text: 'x' }, { space: PSP })]) });
    const a = JSON.stringify(withLog.state);
    const withoutLog = await bootWith({ board: logA.board });
    assert.equal(a, JSON.stringify(withoutLog.state),
      'a quarantine cannot cost content — provable by construction: `state` came from board.json before the log was read');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE CRASH BETWEEN THE TWO WRITES — the branch that used to lose work
// ─────────────────────────────────────────────────────────────────────────────

describe('R4-4 · a crash between saveBoard and saveCheckpoint', () => {
  test("R4-4a INVERTED (INV-3) · the note survives, above the checkpoint's horizon", async () => {
    // `persistNow` writes board.json, THEN checkpoint.json (ADR 006 R5). Interrupt it between the
    // two and board.json is the newer, MORE COMPLETE file. Being ahead is the EXPECTED state under
    // that ordering, so reconciliation is the ordinary path here and not an exception: the board's
    // extra note is minted onto the adopted log at a fresh stamp.
    const A = VICTIM();
    const logA = await realLogFor(A);

    LS.clear();
    LS.setItem(LS_BOARD, logA.board);
    LS.setItem(LS_CHECKPOINT, logA.checkpoint);
    await bootV2();
    v2store._opsPersisted = true;
    v2store.apply('createNoteInline', {
      id: 'brandnew', date: '2026-05-05', text: 'nach dem Checkpoint', categoryId: v2store.state.categories[0].id,
    });
    await v2store.persistNow();
    const newerBoard = LS.getItem(LS_BOARD);
    assert.ok(JSON.parse(newerBoard).notes.some((n) => n.id === 'brandnew'), 'the note reached board.json');

    // …and now the crash: the new board.json survives, the checkpoint write did not happen.
    const s = await bootWith({ board: newerBoard, checkpoint: logA.checkpoint });
    assert.equal(s.quarantine, null, 'being one persist ahead is not a foreign log');
    assert.ok(s.state.notes.some((n) => n.id === 'brandnew'), 'the note the user created is on the board');
    assert.equal(s.diagnostics().lineage.reconciled, 1, 'exactly one change was reconciled — the note, and nothing else');
    assert.ok(s.warnings.some((w) => /board\.json is the truth and it won/.test(w)),
      'and it is reported, rather than described as expected loss');

    // THE HAZARD ADR 006 §12.6 names: mint below the log's stamps and LWW silently keeps the
    // log's value. The reconciled op must be ABOVE the checkpoint horizon, or R4-4a is back with
    // no warning anywhere. Deleting `_observeEveryStamp` reddens exactly this line.
    const horizon = JSON.parse(logA.checkpoint).horizon;
    const stamp = s.registers().get('note:brandnew')?.get('text')?.stamp;
    assert.ok(stamp > horizon, `the note's stamp ${stamp} must be above the horizon ${horizon}`);

    await s.persistNow();
    assert.ok(JSON.parse(LS.getItem(LS_BOARD)).notes.some((n) => n.id === 'brandnew'),
      'and the next autosave keeps it');
  });

  test('R4-4c · INV-3, the SILENT one: the clock is advanced past every stamp BEFORE anything is minted', async () => {
    // ADR 006 §12.6. If the reconciliation mints below a register's stamp, LWW quietly keeps the
    // LOG's value and R4-4a is back with no warning anywhere. The hazard only shows when the log's
    // stamps are AHEAD of this device's wall clock — a skewed peer, a machine whose clock was set
    // back, a file restored from a future-dated backup — so that is the fixture.
    //
    // The post-condition (R4) is the second net: with the clock-observe loop deleted, the diff
    // loses to LWW, the projection no longer matches board.json, and the log is quarantined
    // `reconcile-failed`. So the mutant costs HISTORY, never content — which is exactly the
    // degradation the ADR promises, and exactly what this row pins.
    const A = VICTIM();
    const logA = await realLogFor(A);
    const board = JSON.parse(logA.board);
    board.notes.find((n) => n.id === 'n1').text = 'aus board.json';

    const future = Date.now() + 60 * 60 * 1000;         // 1 h ahead: inside the 24 h park window
    const tail = jsonl([op('note.set', 'note:n1', { text: 'aus dem Log' }, { space: PSP, ms: future })]);

    const s = await bootWith({ board, ops: tail, checkpoint: logA.checkpoint });

    assert.equal(s.quarantine, null, 'the log is this board\'s log and is adopted');
    assert.equal(s.diagnostics().source, 'op-log', 'so the history survives — this is what the mutant costs');
    assert.equal(s.state.notes.find((n) => n.id === 'n1').text, 'aus board.json',
      'and board.json won, because the reconciled op was minted ABOVE the log\'s future stamp');
    const stamp = s.registers().get('note:n1').get('text').stamp;
    assert.ok(stamp.slice(0, 13) > String(future - 1).padStart(13, '0'),
      `the minted stamp ${stamp} must sit above the log's ${future}`);
  });

  test('R4-4d · INV-13, the post-condition: a SABOTAGED reconciler still cannot cost content', async () => {
    // ADR 006 R4 is what makes the whole design obviously correct rather than merely argued: after
    // reconciling, the store asserts that the log now says what board.json says, and if it does
    // not — FOR ANY REASON AT ALL — the log is quarantined and the board is used alone. Every
    // conceivable failure of the reconciler degrades to "history lost, content kept".
    //
    // The reconciler is sabotaged here in the bluntest possible way: it mints nothing. Deleting
    // the post-condition (§12.7's "may not be removed as redundant") reddens exactly this row.
    const A = VICTIM();
    const logA = await realLogFor(A);
    const board = JSON.parse(logA.board);
    board.notes.find((n) => n.id === 'n1').text = 'nur in board.json';

    const proto = Object.getPrototypeOf(v2store);
    const real = proto._diffBetween;
    proto._diffBetween = () => [];                    // the sabotage
    let s;
    try { s = await bootWith({ board, checkpoint: logA.checkpoint }); }
    finally { proto._diffBetween = real; }

    assert.equal(s.quarantine?.reason, 'reconcile-failed', 'the post-condition caught it');
    assert.equal(s.state.notes.find((n) => n.id === 'n1').text, 'nur in board.json',
      'and board.json was kept whole');
    assert.equal(s.state.notes.length, 5);
  });

  test('R4-4b · INV-6: a crash-forward reconcile regresses NO stamp to GENESIS', async () => {
    const A = VICTIM();
    const logA = await realLogFor(A);
    LS.clear();
    LS.setItem(LS_BOARD, logA.board);
    LS.setItem(LS_CHECKPOINT, logA.checkpoint);
    await bootV2();
    v2store._opsPersisted = true;
    v2store.apply('renameCategory', { id: v2store.state.categories[0].id, name: 'Umbenannt', lang: 'de' });
    await v2store.persistNow();
    const live = v2store.registers().get(`cat:${v2store.state.categories[0].id}`).get('name').stamp;
    assert.ok(!live.startsWith('0000000000000'), 'a real edit carries a real stamp');
    const newerBoard = LS.getItem(LS_BOARD);

    const s = await bootWith({ board: newerBoard, checkpoint: logA.checkpoint });
    const after = s.registers().get(`cat:${s.state.categories[0].id}`).get('name').stamp;
    assert.ok(!after.startsWith('0000000000000'),
      'the reconciled field is minted fresh, not re-migrated at GENESIS');
    const untouched = s.registers().get('note:n2').get('text').stamp;
    assert.ok(untouched.startsWith('0000000000000'),
      'and a field that did NOT change keeps the stamp the log had — the diff minted nothing for it');
  });
});
