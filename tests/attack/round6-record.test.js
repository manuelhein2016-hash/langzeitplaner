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
// §3 is where it breaks. THE BOUND ON `ops.jsonl` IS PURCHASED WITH AN UNBOUNDED
//    `checkpoint.json`. `compact()` calls `rememberBody` for every line it drops, `pruneSeqIndex`
//    prunes `seqs`/`tsById` and deliberately never touches `bodies`, and `bodies` is serialized
//    into every checkpoint from then on. The file therefore grows with the number of ops the user
//    has EVER written — not with the size of their board — and it is rewritten whole on every
//    debounced save. A3-M5 was "nothing appends"; the fix made something append, and the thing
//    that now grows without bound is the one file `saveCheckpoint` rewrites atomically each time.
//
// §4 is the parked op, which the brief asks about by name. A single op stamped beyond the drift
//    window is PARKED — ADR 001 §7.4's whole purpose, and it changes no register. `_clockSkew`
//    (R5-2e's fix) nevertheless walks `ops({includeParked:true})`, finds that stamp, and
//    quarantines THE ENTIRE LOG as `clock-skew` on a message that names this Mac's clock. The
//    park is the mechanism that was supposed to make a bad clock harmless; the fix turned it into
//    a whole-history quarantine that repeats on every launch until the stamp passes.
//
// Rows tagged `SUCCEEDED (defect)` are green BECAUSE the defect is there. Invert one when its
// defect closes; never delete it. Rows tagged `FAILED (held)` are the controls.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  LS, LS_BOARD, LS_OPS, LS_CHECKPOINT, v2store, bootV2, v1board, note,
  J, session, cpOf, tailLines, texts, addNote, editNote, bornOf,
} from './_round6-kit.js';
import { minter, DEV, ME, PSP } from './_kit.js';

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
  test('R6-3a SUCCEEDED (defect) · the checkpoint grows monotonically across restarts while the BOARD does not', async () => {
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
    // The board is one note and four registers throughout. The checkpoint is not.
    assert.deepEqual(sizes.map((x) => x.regs), [4, 4, 4, 4], 'the BOARD never grows: four registers, start to finish');
    assert.ok(sizes[3].boardBytes < 2000, `board.json stays small (${sizes[3].boardBytes} bytes)`);
    assert.ok(sizes[3].bodies >= 1500,
      `but the checkpoint carries ${sizes[3].bodies} body fingerprints for a board of ONE note`);
    assert.ok(sizes[3].bytes > 3 * sizes[0].bytes,
      `and it grew ${sizes[0].bytes} → ${sizes[3].bytes} bytes across four restarts of the same one-note board`);
    // The growth is DURABLE — it is on disk, it survives the restart, and it is re-written whole
    // by `saveCheckpoint` on every debounced save.
    const s = await bootV2();
    assert.equal(s.state.notes.length, 1, 'one note');
    assert.ok(JSON.stringify(cpOf()).length > 60000,
      'and the file the next save rewrites atomically is already tens of kilobytes');
  });

  test('R6-3b SUCCEEDED (defect) · nothing ever forgets a body: `bodies` only ever grows', async () => {
    await seeded();
    await bootV2();
    v2store._opsPersisted = true;
    const counts = [];
    for (let i = 0; i < 3200; i++) {
      v2store.mutate('edit', (st) => { st.notes[0].text = `T${i}`; });
      if (i % 200 === 199) { await v2store.persistNow(); counts.push(Object.keys(cpOf().bodies).length); }
    }
    for (let i = 1; i < counts.length; i++) {
      assert.ok(counts[i] >= counts[i - 1], `bodies never shrank (${counts[i - 1]} → ${counts[i]})`);
    }
    assert.ok(counts[counts.length - 1] >= 1500,
      `and the count tracks OPS EVER WRITTEN, not registers: ${counts[counts.length - 1]} fingerprints `
      + 'for a board that has four');
    assert.equal(Object.keys(cpOf().seqs).length, 0,
      '`seqs` IS pruned on the same call (`pruneSeqIndex`); `bodies` is the one index that is not');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE PARKED OP — ADR 001 §7.4's shock absorber, wired to the fire alarm
// ─────────────────────────────────────────────────────────────────────────────

describe('R6-4 · one parked op quarantines the whole history', () => {
  test('R6-4a SUCCEEDED (defect) · a single 48 h-future op is parked, persisted, and then refuses the log on the NEXT launch', async () => {
    await seeded();
    await bootV2();
    v2store._opsPersisted = true;

    // A peer whose clock is two days fast sends one ordinary note edit. ADR 001 §7.4 PARKS it:
    // it changes no register, it is not applied, and it waits for the stamp to become sane. That
    // is the design working.
    const future = op('note.set', 'note:n0', { text: 'AUS DER ZUKUNFT' },
      { ms: Date.now() + 48 * 3600e3, space: PSP });
    v2store.applyRemote([future]);
    assert.deepEqual(v2store._log.lines().filter((l) => l.park !== null).map((l) => l.park), ['future'],
      'the op is PARKED — it changes no register (ADR 001 §7.4)');
    assert.equal(v2store.state.notes[0].text, 'DER ANFANG', 'and nothing on screen moved');

    v2store.mutate('edit', (st) => { st.notes[0].text = 'MEINE ECHTE ÄNDERUNG'; });
    await v2store.persistNow();
    assert.equal(cpOf().parked.length, 1, 'the parked line rides in checkpoint().parked, as A2 round 2 requires');

    // …and on the next launch `_clockSkew` walks `ops({includeParked:true})`, finds that stamp,
    // and refuses the ENTIRE log.
    const s = await bootV2();
    assert.equal(s.quarantine?.reason, 'clock-skew',
      'ONE parked op — an op the log has already neutralised by parking it — quarantines the whole history');
    assert.match(s.quarantine.detail, /THIS MACHINE'S CLOCK is the problem, not the log/,
      'and the reason blames a clock that is not wrong: the stamp came from a PEER');
    assert.match(s.quarantine.detail, /set this Mac's date and time correctly/,
      'the user is given an instruction that cannot help them');

    // Promise 4 holds — content is never the cost. That is the ADR working.
    assert.equal(s.state.notes[0].text, 'MEINE ECHTE ÄNDERUNG', 'content is whole (ADR 006 promise 4)');
    assert.equal(s._adopted, null, 'but the history is gone: nothing was adopted');
  });

  test('R6-4b SUCCEEDED (defect) · the refusal is DEFERRED, so it repeats on every launch until the stamp passes', async () => {
    await seeded();
    await bootV2();
    v2store._opsPersisted = true;
    v2store.applyRemote([op('note.set', 'note:n0', { text: 'ZUKUNFT' },
      { ms: Date.now() + 90 * 24 * 3600e3, space: PSP })]);      // ninety days, not two
    v2store.mutate('edit', (st) => { st.notes[0].text = 'ECHT'; });
    await v2store.persistNow();

    for (const launch of [1, 2, 3]) {
      const s = await bootV2();
      assert.equal(s.quarantine?.reason, 'clock-skew', `launch ${launch} refuses the log again`);
      assert.equal(s.quarantine.movedAside, null,
        'and `DEFERRED_QUARANTINE` leaves the files under the names the next launch will look at, '
        + 'so there is no way for the user to make it stop');
      assert.equal(s.state.notes[0].text, 'ECHT');
      s._opsPersisted = false;                 // WP-3 ships with this off; WP-8 turns it on
    }
    // Under WP-8 this is the whole of A3-M5 again, remotely: `_quarantineLog` sets
    // `_opsPersisted = false`, so for the next ninety days this device records nothing at all.
    const s = await bootV2();
    assert.equal(s._opsPersisted, false, 'and a quarantined session persists no ops by construction');
  });

  test('R6-4c SUCCEEDED (defect) · the op the authz gate REFUSES still lands in the checkpoint, because it is future-dated', async () => {
    // The park is decided BEFORE the authorisation gate. A foreign author's op stamped NOW is
    // refused outright and never becomes a line; the SAME author's op stamped 48 h ahead is
    // parked — i.e. kept, persisted into `checkpoint().parked`, and then read back by
    // `_clockSkew` on the next launch. An outsider whose write the store rejects can therefore
    // still disable the victim's entire history, using nothing but a date.
    const foreign = minter(DEV.mama);
    await seeded();
    await bootV2();
    v2store._opsPersisted = true;
    v2store.warnings.length = 0;

    v2store.applyRemote([foreign('note.set', 'note:n0', { text: 'JETZT' }, { ms: Date.now(), space: PSP })]);
    assert.equal(v2store._log.lines().length, 0, 'stamped NOW: refused by authz, never a line');
    assert.ok(v2store.warnings.some((w) => /notMyAct/.test(w)));

    v2store.applyRemote([foreign('note.set', 'note:n0', { text: 'ZUKUNFT' },
      { ms: Date.now() + 48 * 3600e3, space: PSP })]);
    assert.deepEqual(v2store._log.lines().map((l) => l.park), ['future'],
      'stamped 48 h AHEAD: the same refused op is PARKED, i.e. kept');

    v2store.mutate('edit', (st) => { st.notes[0].text = 'MEINS'; });
    await v2store.persistNow();
    assert.equal(cpOf().parked.length, 1, 'and it is written into the victim\'s own checkpoint');
    const s = await bootV2();
    assert.equal(s.quarantine?.reason, 'clock-skew',
      'one date from a stranger the store already refused, and the whole history is gone');
    assert.equal(s.state.notes[0].text, 'MEINS', 'content is still whole — the cost is history, every launch');
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
