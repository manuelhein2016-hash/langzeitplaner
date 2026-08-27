// ─────────────────────────────────────────────────────────────────────────────
// ROUND 6 — ADVERSARY, ATTACK 1: THE LOG NOW RECORDS
//
// R5-4 closed A3-M5: `_persistOps` is now the four steps of ADR 006 §6 — append the outbox,
// compact when the tail has grown, checkpoint, truncate only what the checkpoint folds. That put
// a NEW WRITE PATH ON THE HOT LOOP, and this file audits it and nothing else.
//
// §1 is the control block: everything R5-4 claimed still holds. `_born` really is stable across
//    five launches, an ordinary launch really does reconcile ZERO, the ③/④ crash really does cost
//    nothing, and an op that loses LWW really is written nowhere.
//
// §2 is `ops.jsonl`'s bound. It holds: `TAIL_COMPACT_AT` caps the tail at 1 500 lines and the
//    compaction that caps it is real.
//
// §3 is where it broke. THE BOUND ON `ops.jsonl` WAS PURCHASED WITH AN UNBOUNDED
//    `checkpoint.json`. `compact()` calls `rememberBody` for every line it drops, `pruneSeqIndex`
//    pruned `seqs`/`tsById` and never touched `bodies`, and `bodies` is serialized into every
//    checkpoint from then on. The file therefore grew with the number of ops the user had EVER
//    written — not with the size of their board — and it is rewritten whole on every debounced
//    save. A3-M5 was "nothing appends"; the fix made something append, and the thing that then
//    grew without bound was the one file `saveCheckpoint` rewrites atomically each time.
//
// §4 is the parked op, which the brief asks about by name. A single op stamped beyond the drift
//    window is PARKED — ADR 001 §7.4's whole purpose, and it changes no register. `_clockSkew`
//    (R5-2e's fix) nevertheless walked `ops({includeParked:true})`, found that stamp, and
//    quarantined THE ENTIRE LOG as `clock-skew` on a message that named this Mac's clock. The
//    park is the mechanism that was supposed to make a bad clock harmless; the fix turned it into
//    a whole-history quarantine that repeated on every launch until the stamp passed — and,
//    because `foldAuthorized` decided the park BEFORE the authorisation stages, one a stranger
//    could trigger with nothing but a date.
//
// ROUND 7 CLOSED §3 AND §4 AND THE ROWS BELOW ARE INVERTED — see the block comment on each
// `describe`. Three fixes, all in files this round owned:
//   `src/js/core/oplog.js`  `pruneSeqIndex` ends in `boundBodies()` — an oldest-first eviction to
//                           `BODY_FINGERPRINT_CAP` that never evicts an id still holding a line.
//   `src/js/store.js`       `_clockSkew` walks `ops({liveOnly:true})`: a parked op is in no
//                           register, so no mint has to be above it.
//   `src/js/store.js`       `applyRemote` withholds `nowMs` from `foldAuthorized`, whose only
//                           consumer of it is the 24 h clamp — so authorisation is decided first.
//
// Rows tagged `SUCCEEDED (defect)` are green BECAUSE the defect is there. Invert one when its
// defect closes; never delete it. Rows tagged `FAILED (held)` are the controls — and R6-3c,
// R6-4d and R6-4e are the three that keep the inverted rows from being satisfiable by DELETING
// the mechanism instead of bounding it.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  LS, LS_BOARD, LS_OPS, LS_CHECKPOINT, v2store, bootV2, v1board, note,
  J, session, cpOf, tailLines, texts, addNote, editNote, bornOf,
} from './_round6-kit.js';
import { minter, DEV, ME, PSP } from './_kit.js';
import { createOpLog, BODY_FINGERPRINT_CAP } from '../../src/js/core/oplog.js';

const op = minter(DEV.meDesk, { act: ME });
const START = () => v1board({ notes: [note('n0', '2026-03-01', 'DER ANFANG')] });

/** Seed a board and give it a lineage-bearing pair — the state every row below starts from. */
async function seeded(board = START()) {
  LS.clear();
  LS.setItem(LS_BOARD, J(board));
  return session();
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE CONTROLS — R5-4's claims, re-derived rather than re-run
// ─────────────────────────────────────────────────────────────────────────────

describe('R6-1 · the log records, and it records the same thing every time', () => {
  test('R6-1a FAILED (held) · `_born` is STABLE across five launches, one new entry per launch', async () => {
    // R5-4c, re-derived. The defect it closed made every entry created after the first persist
    // re-minted `born:true` at a fresh stamp on EVERY launch, so its array position was a
    // function of when the app was opened. Five launches is enough to see a drift of one.
    await seeded();
    const seen = new Map();
    const moved = [];
    for (let i = 2; i <= 5; i++) {
      const s = await session(addNote(`n${i}`, `S${i}`));
      assert.equal(s.quarantine, null, `launch ${i} adopts its own log`);
      assert.equal(s._adopted?.reconciled, 0,
        `launch ${i} reconciles ZERO — a non-zero count is news, not the happy path`);
      for (const n of s.state.notes) {
        const b = bornOf(s, `note:${n.id}`);
        if (seen.has(n.id) && seen.get(n.id) !== b) moved.push(`${n.id} @ launch ${i}`);
        seen.set(n.id, b);
      }
      assert.deepEqual(texts(s), ['DER ANFANG', ...Array.from({ length: i - 1 }, (_, k) => `S${k + 2}`)],
        `and the array ORDER is v1's insertion order at launch ${i} (ADR 001 §5 step 5)`);
    }
    assert.deepEqual(moved, [], 'no `_born` moved on any launch');
    assert.equal(seen.size, 5, 'and the row is not vacuous: five entries were actually watched');
  });

  test('R6-1b FAILED (held) · the ③/④ crash — checkpoint written, tail NOT truncated — costs nothing', async () => {
    // ADR 006 §6: "`truncateOps` may only ever drop lines the checkpoint being written already
    // folds — which is a CHECKED condition". This is the crash on the other side of that check.
    await seeded();
    await session(addNote('nA', 'SESSION2'));
    const tailBytes = LS.getItem(LS_OPS);
    assert.equal(tailLines(), 1, 'session 2 really did leave one line in the tail');

    await bootV2();
    v2store._opsPersisted = true;
    v2store._log.compact();                                  // ② ran
    LS.setItem(LS_CHECKPOINT, J(v2store._stampedCheckpoint('x:1')));   // ③ ran
    LS.setItem(LS_OPS, tailBytes);                           // ④ did NOT
    assert.equal(Object.keys(cpOf().regs.regs).includes('note:nA'), true, 'the checkpoint folds nA');

    const bornBefore = (await bootV2()) && bornOf(v2store, 'note:nA');
    assert.equal(v2store.quarantine, null);
    assert.deepEqual(texts(v2store), ['DER ANFANG', 'SESSION2']);
    assert.equal(v2store._adopted?.reconciled, 0, 'the double copy is recognised, not re-minted');
    v2store._opsPersisted = true;
    await v2store.persistNow();
    assert.equal(tailLines(), 0, 'and the duplicate line is dropped on the next persist');
    assert.ok(Object.keys(cpOf().bodies).length > 0,
      'the BODY FINGERPRINT of the folded line survives into the checkpoint (A1 round 2)');
    assert.equal(bornOf(v2store, 'note:nA'), bornBefore, '`_born` did not move across the repair');
  });

  test('R6-1c FAILED (held) · an op that LOSES LWW is written nowhere and moves no horizon', async () => {
    await seeded();
    await bootV2();
    v2store._opsPersisted = true;
    v2store.mutate('edit', (st) => { st.notes[0].text = 'NEUER'; });
    const lines = v2store._log.lines().length;
    v2store.applyRemote([op('note.set', 'note:n0', { text: 'VERLIERER' }, { ms: 1000, space: PSP })]);
    assert.equal(v2store._log.lines().length, lines, 'the losing op is not kept as a line');
    assert.equal(v2store.state.notes[0].text, 'NEUER');
    await v2store.persistNow();
    const s = await bootV2();
    assert.equal(s.state.notes[0].text, 'NEUER', 'and it does not come back on the next launch');
    assert.equal(s.quarantine, null);
    assert.equal(s._adopted?.reconciled, 0);
  });

  test('R6-1d FAILED (held) · a TORN last line in ops.jsonl costs history, never content', async () => {
    await seeded();
    await session(addNote('nA', 'SESSION2'));
    const torn = LS.getItem(LS_OPS).slice(0, -12);            // the write stopped mid-line
    LS.setItem(LS_OPS, torn);
    const s = await bootV2();
    assert.deepEqual(texts(s), ['DER ANFANG', 'SESSION2'], 'board.json is the truth and it kept the note');
    assert.equal(s.quarantine, null, 'a torn tail is not a quarantine — the checkpoint is intact');
    assert.equal(s._adopted?.reconciled, 1, 'exactly one change is re-minted, and it is REPORTED');
    assert.ok(s.warnings.some((w) => /reconciled 1 change/.test(w)));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. `ops.jsonl` IS BOUNDED — the half of INV-17 that holds
// ─────────────────────────────────────────────────────────────────────────────

describe('R6-2 · the tail file', () => {
  test('R6-2a FAILED (held) · ops.jsonl never exceeds TAIL_COMPACT_AT, and the compaction is real', async () => {
    await seeded();
    await bootV2();
    v2store._opsPersisted = true;
    const h0 = cpOf().horizon;
    let maxTail = 0;
    let horizonMovedAt = null;
    for (let i = 0; i < 3200; i++) {
      v2store.mutate('edit', (st) => { st.notes[0].text = `T${i}`; });
      if (i % 50 === 49) {
        await v2store.persistNow();
        maxTail = Math.max(maxTail, tailLines());
        if (horizonMovedAt === null && cpOf().horizon !== h0) horizonMovedAt = i;
      }
    }
    await v2store.persistNow();
    assert.ok(maxTail > 1000, `the tail really did grow (max ${maxTail}) — the row is not vacuous`);
    assert.ok(maxTail < 2000, `and it stayed under localStorage's LS_OPS_CAP (max ${maxTail})`);
    assert.ok(horizonMovedAt !== null, 'a compaction really ran and advanced the horizon');
    const s = await session();
    assert.equal(s.state.notes[0].text, 'T3199', 'and nothing was lost across the compaction');
    assert.equal(s._adopted?.reconciled, 0);
  });

  test('R6-2b FAILED (held) · ADR 001 §7.2\'s OTHER trigger: a FAT tail compacts at launch, under the line cap', async () => {
    // The line cap is not a byte cap, and §7.2 asks for both. One `note.set` carrying a pasted
    // page of text is kilobytes; a few hundred of them are nowhere near `TAIL_COMPACT_AT` and are
    // over any byte budget worth having — and on the browser path `ops.jsonl` shares
    // localStorage's whole-origin quota with board.json, checkpoint.json and snapshots.json.
    // This row is what stops "compact when the tail has grown" from meaning lines alone.
    // A NOTIZZETTEL, not a note: `note.text` is clamped to 80 characters, and a scratchpad is
    // where a pasted page of text actually lands in this app — which is also why the 50 MB member
    // of the D1 byte domain is built out of one.
    const FAT = 'x'.repeat(12 * 1024);
    await seeded();
    await bootV2();
    v2store._opsPersisted = true;
    for (let i = 0; i < 260; i++) {                     // ≈3 MB in ≈260 lines: way under 1 500
      v2store.mutate('pad', (st) => { st.scratchpads['2026-01'] = `${FAT}${i}`; });
      if (i % 40 === 39) await v2store.persistNow();
    }
    await v2store.persistNow();
    const bytesBefore = (LS.getItem(LS_OPS) || '').length;
    const linesBefore = tailLines();
    assert.ok(bytesBefore > 2 * 1024 * 1024,
      `setup: the tail really is fat (${bytesBefore} bytes) — the row is not vacuous`);
    assert.ok(linesBefore < 1500,
      `and it is nowhere near the LINE cap (${linesBefore} lines), so only a BYTE trigger can fire`);

    // The trigger is measured at launch — the one moment the bytes have just been read and
    // parsed anyway — and consumed by the first persist of that session.
    const s = await bootV2();
    assert.equal(s._tailOverBytes, true, 'launch measured the tail and armed §7.2\'s 2 MB trigger');
    s._opsPersisted = true;
    s.mutate('pad', (st) => { st.scratchpads['2026-01'] = 'DANACH'; });
    await s.persistNow();
    assert.equal(s._tailOverBytes, false, 'and the trigger is one-shot: this compaction is what makes it false');
    assert.ok((LS.getItem(LS_OPS) || '').length < bytesBefore / 4,
      `the tail was compacted away (${bytesBefore} → ${(LS.getItem(LS_OPS) || '').length} bytes)`);

    const after = await bootV2();
    assert.equal(after.quarantine, null, 'and nothing was lost doing it');
    assert.equal(after.state.scratchpads['2026-01'], 'DANACH');
    assert.equal(after._adopted?.reconciled, 0);
    assert.equal(after._tailOverBytes, false, 'the slim tail does not re-arm the trigger');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. …AND `checkpoint.json` IS NOT
//
// The bound above is bought with an unbounded file. `compact()` remembers one body fingerprint
// per dropped line so that a splice can still be told from a re-delivery after the line is gone
// (A1 round 2, and it is right to do so). Nothing ever forgets one. `pruneSeqIndex` prunes
// `seqById`, `tsById` and `legacySeqByStamp` on the same call and steps over `bodies`.
// ─────────────────────────────────────────────────────────────────────────────

describe('R6-3 · checkpoint.json grows with every op the user has ever written', () => {
  // ── INVERTED IN ROUND 7. `pruneSeqIndex` now ends in `boundBodies()` — an oldest-first eviction
  // down to `BODY_FINGERPRINT_CAP` that never evicts an id still holding a line. The two rows
  // below assert the BOUND at exactly the marks where round 6 measured the unbounded curve, so
  // deleting the `boundBodies()` call, or raising the cap so it is no longer the retained-line
  // bound, is red here and at D4-i5/D4-g5/D4-g6.
  //
  // WHAT IS DELIBERATELY NOT ASSERTED: that `bodies` is EMPTY. Round 6's own mutant F1 — prune
  // `bodies` by `pruneSeqIndex`'s `keepIds` — would make both rows pass and put round 2's attack
  // A1 back, because `bodies` holds exactly the ids `keepIds` excludes. The requirement is a cap,
  // not a purge, and R6-3c below pins the half a purge would break.
  test('R6-3a FAILED (held) · the checkpoint is FLAT across restarts, and so is the board', async () => {
    await seeded();
    const sizes = [];
    for (let s = 1; s <= 4; s++) {
      await bootV2();
      v2store._opsPersisted = true;
      for (let i = 0; i < 800; i++) {
        v2store.mutate('edit', (st) => { st.notes[0].text = `s${s}-${i}`; });
        if (i % 50 === 49) await v2store.persistNow();
      }
      await v2store.persistNow();
      const c = cpOf();
      sizes.push({
        bytes: JSON.stringify(c).length,
        bodies: Object.keys(c.bodies).length,
        regs: Object.keys(c.regs.regs).length,
        boardBytes: LS.getItem(LS_BOARD).length,
      });
    }
    // The board is one note and four registers throughout. SO IS THE CHECKPOINT, NOW.
    assert.deepEqual(sizes.map((x) => x.regs), [4, 4, 4, 4], 'the BOARD never grows: four registers, start to finish');
    assert.ok(sizes[3].boardBytes < 2000, `board.json stays small (${sizes[3].boardBytes} bytes)`);
    assert.ok(sizes[3].bodies <= BODY_FINGERPRINT_CAP,
      `and the checkpoint carries at most ${BODY_FINGERPRINT_CAP} body fingerprints, not one per op `
      + `ever written (${sizes[3].bodies}); round 6 measured 6 000 here`);
    // 3 200 ops in, against 800 ops in: round 6 measured a factor of more than three. The bound
    // is what makes this a ratio near 1 — the live log is the same size at both marks.
    assert.ok(sizes[3].bytes <= 2 * sizes[2].bytes,
      `and it stopped growing: ${sizes[2].bytes} → ${sizes[3].bytes} bytes over the last 800 edits`);
    const s = await bootV2();
    assert.equal(s.state.notes.length, 1, 'one note');
    assert.ok(JSON.stringify(cpOf()).length < 200000,
      `and the file the next save rewrites atomically is bounded (${JSON.stringify(cpOf()).length} bytes); `
      + 'round 6 measured it past 280 KB and still climbing');
  });

  test('R6-3b FAILED (held) · `bodies` stops at the cap: it is bounded by the LIVE log, not by ops-ever', async () => {
    await seeded();
    await bootV2();
    v2store._opsPersisted = true;
    const counts = [];
    for (let i = 0; i < 3200; i++) {
      v2store.mutate('edit', (st) => { st.notes[0].text = `T${i}`; });
      if (i % 200 === 199) { await v2store.persistNow(); counts.push(Object.keys(cpOf().bodies).length); }
    }
    for (const n of counts) {
      assert.ok(n <= BODY_FINGERPRINT_CAP, `bodies never exceeded the cap (saw ${n} > ${BODY_FINGERPRINT_CAP})`);
    }
    // THE CURVE, not just its endpoint. Round 6's defect was that this sequence was strictly
    // increasing; the fix is that it PLATEAUS. Asserting only the endpoint would pass for a cap
    // that is merely larger than 3 200.
    const half = counts.slice(Math.floor(counts.length / 2));
    assert.ok(Math.max(...half) - Math.min(...half) <= 1,
      `and it plateaus rather than climbing: the second half of the curve is ${half.join(', ')}`);
    assert.equal(Object.keys(cpOf().seqs).length, 0,
      '`seqs` is still pruned on the same call (`pruneSeqIndex`) — the fix added to that function, '
      + 'it did not replace what was there');
  });

  test('R6-3c FAILED (held) · the cap is a cap and NOT a purge — measured on a SUPERSEDED op', async () => {
    // The non-vacuity control for R6-3a/b, and the row that dies under round 6's own mutant F1
    // (`pruneSeqIndex` prunes `bodies` by `keepIds` instead of capping it).
    //
    // THE OP HERE HAS TO BE ONE THAT LOST, and that is the whole point of the row. `keepIds` is
    // "ids a surviving register attributes, plus retained lines", so a purge by `keepIds` keeps
    // the WINNER's fingerprint — every obvious version of this test passes under the mutant. What
    // it drops is every absorbed op no register points at any more, which after a day's editing
    // is nearly all of them. So: two bodies at the same field, the second wins, both compacted,
    // and the SPLICE IS AGAINST THE LOSER.
    const log = createOpLog({ now: () => Date.now() });
    const mk = minter(DEV.meDesk, { act: ME });
    const loser = mk('note.set', 'note:n0', { text: 'EINS' }, { ms: Date.now() - 5000, space: PSP });
    const winner = mk('note.set', 'note:n0', { text: 'ZWEI' }, { ms: Date.now(), space: PSP });
    log.append(loser);
    log.append(winner);
    log.compact();                                     // both LINES are gone; both fingerprints stay
    assert.equal(log.ops().length, 0, 'compacted: no line is held for either');
    assert.deepEqual(Object.keys(log.checkpoint().bodies).sort(), [loser.id, winner.id].sort(),
      'BOTH fingerprints are carried — not just the one a surviving register happens to name');
    assert.equal(log.append(loser).status, 'duplicate',
      'the superseded body is still recognised as a duplicate rather than re-folded and re-written');
    assert.equal(log.append({ ...loser, f: { text: 'DREI' } }).status, 'conflict',
      'and a SECOND body under the superseded opId is still caught as an envelope splice');
    assert.deepEqual(log.splicedIds(), [loser.id],
      'and REPORTED — `spliced` is the only evidence an opId ever arrived under two bodies and it '
      + 'cannot be re-derived from the tail (ADR 002 §5.1, REG-28)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE PARKED OP — ADR 001 §7.4's shock absorber, wired to the fire alarm
// ─────────────────────────────────────────────────────────────────────────────

describe('R6-4 · one parked op quarantines the whole history', () => {
  // ── INVERTED IN ROUND 7, BY TWO INDEPENDENT FIXES, AND THE SPLIT IS THE POINT ────────────────
  //
  //   THE BLAST RADIUS  `store._clockSkew` walks `ops({liveOnly:true})`. A parked op is in no
  //                     register, so §12.6's "mint above every stamp the log carries" never had
  //                     anything to say about it. → R6-4a, R6-4b.
  //   THE ORDERING      `store.applyRemote` withholds `nowMs` from `foldAuthorized`. The 24 h
  //                     clamp is `nowMs`'s only consumer anywhere in that fold, so withholding it
  //                     stops the clock pre-empting the authorisation stages and nothing else.
  //                     → R6-4c.
  //
  // EITHER FIX ALONE LEAVES THE OTHER ROW RED, which is why both are asserted separately below
  // rather than through one "no quarantine happens" row. With only the blast-radius fix, a
  // stranger's refused write is still kept and still persisted into the victim's checkpoint
  // (R6-4c's first two assertions). With only the ordering fix, the victim's OWN second Mac,
  // whose clock is two days fast, still quarantines the whole history every launch (R6-4a).
  test('R6-4a FAILED (held) · a single 48 h-future op is parked and costs THAT OP AND NOTHING ELSE', async () => {
    await seeded();
    await bootV2();
    v2store._opsPersisted = true;

    // One of the user's OWN devices, whose clock is two days fast, sends an ordinary note edit.
    // ADR 001 §7.4 PARKS it: it changes no register, it is not applied, and it waits for the
    // stamp to become sane. That is the design working, and it must stay working.
    // AUTHORED BY THIS MEMBER, and that is now load-bearing. Round 6's version of this row used
    // the kit's default `act` (`ME`), which is NOT `v2store._me` — so under round 7's ordering
    // fix it is a FOREIGN author and is refused outright, which is R6-4c's row, not this one.
    // The two cells have to be minted differently or the `own` column is never probed at all.
    const mine = minter(DEV.meDesk, { act: v2store._me });
    const future = mine('note.set', 'note:n0', { text: 'AUS DER ZUKUNFT' },
      { ms: Date.now() + 48 * 3600e3, space: PSP, actAs: v2store._me });
    v2store.applyRemote([future]);
    assert.deepEqual(v2store._log.lines().filter((l) => l.park !== null).map((l) => l.park), ['future'],
      'the op is PARKED — it changes no register (ADR 001 §7.4)');
    assert.equal(v2store.state.notes[0].text, 'DER ANFANG', 'and nothing on screen moved');

    v2store.mutate('edit', (st) => { st.notes[0].text = 'MEINE ECHTE ÄNDERUNG'; });
    await v2store.persistNow();
    assert.equal(cpOf().parked.length, 1, 'the parked line rides in checkpoint().parked, as A2 round 2 requires');

    // …and on the next launch the parked stamp is not counted, because it decides nothing.
    const s = await bootV2();
    assert.equal(s.quarantine, null,
      'ONE parked op — an op the log has already neutralised by parking it — quarantines NOTHING');
    assert.equal(s.state.notes[0].text, 'MEINE ECHTE ÄNDERUNG', 'content is whole (ADR 006 promise 4)');
    assert.ok(s._adopted, 'and the history is ADOPTED: a park is not a disagreement');
    assert.equal(s._adopted.reconciled, 0, 'with nothing to reconcile — board.json and the log agree');
    // AND IT IS STILL PARKED. The fix must not have bought the quarantine by admitting the op.
    assert.deepEqual(s._log.lines().filter((l) => l.park !== null).map((l) => l.park), ['future'],
      're-read from the checkpoint, the line is still parked and still not applied');
    assert.equal(s.state.notes[0].text, 'MEINE ECHTE ÄNDERUNG', 'the future value is still not on screen');
  });

  test('R6-4b FAILED (held) · ninety days ahead, across three launches, and the device still records', async () => {
    await seeded();
    await bootV2();
    v2store._opsPersisted = true;
    const mine = minter(DEV.meDesk, { act: v2store._me });   // this member's own second Mac
    v2store.applyRemote([mine('note.set', 'note:n0', { text: 'ZUKUNFT' },
      { ms: Date.now() + 90 * 24 * 3600e3, space: PSP, actAs: v2store._me })]);   // ninety days, not two
    v2store.mutate('edit', (st) => { st.notes[0].text = 'ECHT'; });
    await v2store.persistNow();

    let expected = 'ECHT';
    for (const launch of [1, 2, 3]) {
      const s = await bootV2();
      assert.equal(s.quarantine, null, `launch ${launch} adopts the log`);
      assert.ok(s._adopted, `launch ${launch} keeps the history`);
      assert.equal(s.state.notes[0].text, expected,
        `launch ${launch} opens on what the PREVIOUS launch recorded, not on the future value`);
      assert.equal(s._log.parkedOps({ reason: 'future' }).length, 1,
        `and the parked op is retained across launch ${launch}, not dropped (§12.5)`);

      // A3-M5 WAS "THE DEVICE RECORDS NOTHING", and this is the half of R6-4b that mattered.
      // `_quarantineLog` sets `_opsPersisted = false`; nothing else in `init()` can turn it back
      // on, so a quarantined session records nothing for as long as the quarantine lasts — at
      // +90 days, ninety days. It no longer runs, so WP-8's flag is the ONLY thing standing
      // between this session and a durable log: switched on, the session records, and what it
      // records still carries the parked line rather than folding it.
      s._opsPersisted = true;                  // WP-3 ships with this off; WP-8 turns it on
      s.mutate('edit', (st) => { st.notes[0].text = `LAUNCH${launch}`; });
      await s.persistNow();
      assert.equal(cpOf().parked.length, 1,
        `launch ${launch} recorded, and the parked line is still parked in what it recorded`);
      assert.equal(s.state.notes[0].text, `LAUNCH${launch}`, 'and the future value never won');
      expected = `LAUNCH${launch}`;
      s._opsPersisted = false;
    }
  });

  test('R6-4c FAILED (held) · the op the authz gate refuses is refused AT EVERY STAMP, future included', async () => {
    // The park used to be decided BEFORE the authorisation gate. A foreign author's op stamped
    // NOW was refused outright and never became a line; the SAME author's op stamped 48 h ahead
    // was parked — i.e. kept, persisted into `checkpoint().parked`, and then read back by
    // `_clockSkew` on the next launch. An outsider whose write the store rejects could therefore
    // disable the victim's entire history using nothing but a date. Now the gate runs first.
    const foreign = minter(DEV.mama);
    await seeded();
    await bootV2();
    v2store._opsPersisted = true;
    v2store.warnings.length = 0;

    v2store.applyRemote([foreign('note.set', 'note:n0', { text: 'JETZT' }, { ms: Date.now(), space: PSP })]);
    assert.equal(v2store._log.lines().length, 0, 'stamped NOW: refused by authz, never a line');
    assert.ok(v2store.warnings.some((w) => /notMyAct/.test(w)));

    v2store.warnings.length = 0;
    v2store.applyRemote([foreign('note.set', 'note:n0', { text: 'ZUKUNFT' },
      { ms: Date.now() + 48 * 3600e3, space: PSP })]);
    assert.equal(v2store._log.lines().length, 0,
      'stamped 48 h AHEAD: the SAME op, judged by the SAME rule — refused, never a line');
    assert.ok(v2store.warnings.some((w) => /notMyAct/.test(w)),
      'and refused for the same REASON, reported by name rather than swallowed as a park');

    v2store.mutate('edit', (st) => { st.notes[0].text = 'MEINS'; });
    await v2store.persistNow();
    assert.equal(cpOf().parked.length, 0, 'nothing of the stranger\'s reached the victim\'s checkpoint');
    const s = await bootV2();
    assert.equal(s.quarantine, null, 'and there is no date a stranger can send that costs the victim a history');
    assert.equal(s.state.notes[0].text, 'MEINS', 'content is whole, as it always was');
    assert.ok(s._adopted, 'and the history is adopted');
  });

  test('R6-4e FAILED (held) · `clock-skew` STILL FIRES on the input it was written for — the other non-vacuity control', async () => {
    // R6-4a/b/c are all "no quarantine happens", so on their own they are also passed by deleting
    // `_clockSkew` outright. This is the row that stops that, and it is the input R5-2e actually
    // described: THE LOCAL CLOCK MOVED BACKWARDS. A stamp only reaches a register by being inside
    // the drift window when it was written, so a register 48 h ahead is a Mac whose clock ran
    // fast and was then corrected — a dead CMOS battery, a restored VM, a botched NTP step. The
    // checkpoint is rewritten here rather than the clock stubbed, because the on-disk file is
    // exactly what such a Mac leaves behind and it is what `init()` reads.
    await seeded();
    await bootV2();
    v2store._opsPersisted = true;
    v2store.mutate('edit', (st) => { st.notes[0].text = 'GESCHRIEBEN ALS DIE UHR VORGING'; });
    await v2store.persistNow();

    const cp = cpOf();
    const far = `${String(Date.now() + 48 * 3600e3).padStart(13, '0')}.000001.0000000000000000`;
    cp.horizon = far;
    cp.lzp.horizon = far;
    for (const cells of Object.values(cp.regs.regs)) for (const c of Object.values(cells)) c.stamp = far;
    LS.setItem(LS_CHECKPOINT, J(cp));

    const s = await bootV2();
    assert.equal(s.quarantine?.reason, 'clock-skew',
      'a LIVE register 48 h ahead still refuses adoption: no op minted now could be applied above it');
    assert.match(s.quarantine.detail, /THE CLOCK ON THIS MAC IS BEHIND THIS BOARD'S OWN HISTORY/,
      'and the detail no longer accuses a peer\'s clock of being this Mac\'s fault — the stamp is '
      + 'in a register, so it was written HERE, inside the window, and the clock has moved since');
    assert.equal(s.quarantine.movedAside, null,
      'still DEFERRED: a refusal that is expected to stop being true must leave the files where '
      + 'the next launch looks for them (`DEFERRED_QUARANTINE`)');
    assert.equal(s.state.notes[0].text, 'GESCHRIEBEN ALS DIE UHR VORGING', 'content is whole (ADR 006 promise 4)');
  });

  test('R6-4d FAILED (held) · a stamp twelve hours ahead reconciles perfectly — the non-vacuity control', async () => {
    await seeded();
    await bootV2();
    v2store._opsPersisted = true;
    const mine = minter(DEV.meDesk, { act: v2store._me });
    v2store.applyRemote([mine('note.set', 'note:n0', { text: 'ZWOELF STUNDEN VORAUS' },
      { ms: Date.now() + 12 * 3600e3, space: PSP, actAs: v2store._me })]);
    assert.equal(v2store.state.notes[0].text, 'ZWOELF STUNDEN VORAUS', 'inside the window it is APPLIED, not parked');
    await v2store.persistNow();
    const s = await bootV2();
    assert.equal(s.quarantine, null, 'and the log is adopted: §7.1 is a window, not a ban');
    assert.equal(s.state.notes[0].text, 'ZWOELF STUNDEN VORAUS');
    assert.equal(s._adopted?.reconciled, 0);
  });
});
