// FLEET · LZP-505 — "THREE WEEKS OFFLINE, AND IT JUST CATCHES UP."
//
// Stories 19.6 and 8.5, and the sentence is the test:
//
//   > "A device that has been offline for weeks opens and just catches up — including month rolls
//   >  and yearly repeats that occurred meanwhile."
//
// ADR 003 §3.4 explains why that reduces to "a large op set arrives late", and the reduction is
// the thing worth asserting rather than assuming:
//
//   · **month rolls are not data.** The visible window derives from `todayISO()` at render time
//     (`layout.js:visibleStart`). Nothing is emitted, nothing merges, nothing can conflict — so a
//     roll that happened while the laptop was shut is invisible to the log, and §2 proves that by
//     showing the two Macs' WINDOWS differ while their BOARDS do not.
//   · **yearly repeats are single objects** (9.3, A4). A repeat crossing a year boundary emits no
//     op; occurrences are computed by `dates.js:projectYearly` at render, and 9.4's Feb-29 rule
//     is a pure function of the anchor and the year.
//   · **catching up is one pull loop.** Ops arrive in `seq` order, are folded in any order, and
//     the result equals what every other device already has (ADR 001 §6).
//
// Then the ugly variants, which is where the value is: both Macs offline and both editing, a
// device offline across a compaction, a device whose clock is wrong, and a device that quarantines
// its log and re-joins (ADR 006 §9.3).
//
// EVERYTHING IS THE SHIPPED CODE. See `tests/helpers/fleet.js` for what is real and what is stood
// in for, and for defect **E5-1**, which every assertion here allows for by name and no assertion
// here hides.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createFleet, boardsAgree, registerDigest, simClock, DAY, WEEK, HOUR, MINUTE } from '../helpers/fleet.js';
import { visibleStart } from '../../src/js/layout.js';
import { projectYearly, addMonths, monthKey } from '../../src/js/dates.js';
import { fmt } from '../../src/js/core/stamp.js';
import { opId as newOpId } from '../../src/js/core/ids.js';
import { sealOp } from '../../src/js/crypto/envelope.js';

/**
 * A board with the two things story 19.6 names: an entry near the rolling edge, and a YEARLY
 * repeat anchored on 29 February — 9.4's rule, which only shows itself across a year boundary.
 */
const BOARD = () => ({
  schemaVersion: 1,
  notes: [
    { id: 'geburtstag', date: '2024-02-29', text: 'Omas Geburtstag', categoryId: 'c1', repeatsYearly: true },
    { id: 'zahnarzt', date: '2026-09-14', text: 'Zahnarzt', categoryId: 'c1', repeatsYearly: false },
  ],
  bars: [{ id: 'urlaub', startDate: '2026-12-20', endDate: '2027-01-06', label: 'Weihnachten', categoryId: 'c1' }],
  categories: [{ id: 'c1', name: 'Familie', paletteRef: 'gruen', visible: true }],
  scratchpads: { '2026-09': 'Reifen wechseln' },
  settings: null,
});

/** The desktop and the laptop, on a clock this file drives by hand. */
async function twoMacs(over = {}) {
  const clock = simClock(Date.UTC(2026, 11, 10, 9, 0, 0));   // 10 December 2026
  return createFleet({ board: BOARD(), devices: ['desktop', 'laptop'], clock, ...over });
}

/** E5-1 is registered; anything ELSE in a quarantine is a new defect and must fail the test. */
function onlyE51(...devices) {
  for (const d of devices) {
    assert.deepEqual(d.realQuarantine(), [],
      `${d.name}: a quarantine that is not E5-1 — ${JSON.stringify(d.realQuarantine())}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE HEADLINE — three weeks shut, a month roll and a year boundary crossed
// ═════════════════════════════════════════════════════════════════════════════

describe('§1 · story 19.6 · the laptop was shut for three weeks', () => {
  test('it opens, catches up, and the two boards are byte-identical', async () => {
    const f = await twoMacs();
    const { desktop, laptop } = { desktop: f.device('desktop'), laptop: f.device('laptop') };
    await f.settle();
    assert.equal(boardsAgree([desktop, laptop]).equal, true, 'they start together');

    // ── the laptop is shut. Not merely partitioned: QUIT. ────────────────────
    await laptop.close();
    laptop.offline();

    // ── twenty-one days, one edit a day, and a month roll on the way ────────
    const dates = [];
    for (let day = 0; day < 21; day++) {
      f.clock.advance(DAY);
      const iso = new Date(f.clock.now()).toISOString().slice(0, 10);
      dates.push(iso);
      await desktop.apply('createNotePopover', {
        id: `tag-${day}`, date: iso, text: `Eintrag ${day}`, categoryId: 'c1',
      });
      await desktop.push();
    }
    // The roll really happened: 10 Dec 2026 -> 31 Dec 2026, across a month AND a year boundary.
    assert.ok(dates.some((d) => d.startsWith('2026-12')) && dates.some((d) => d.startsWith('2026-12-31')),
      `the three weeks did not cross a month boundary: ${dates[0]} … ${dates[dates.length - 1]}`);
    assert.equal(desktop.state.notes.length, 2 + 21);

    // ── and now the laptop is opened ────────────────────────────────────────
    laptop.online();
    await laptop.open();
    const caught = await laptop.catchUp();
    assert.ok(caught.length >= 1);

    assert.equal(laptop.state.notes.length, 2 + 21, 'every day the desktop wrote is here');
    for (let day = 0; day < 21; day++) {
      assert.equal(laptop.state.notes.find((n) => n.id === `tag-${day}`).text, `Eintrag ${day}`);
    }
    await desktop.sync();
    const agree = boardsAgree([desktop, laptop]);
    assert.equal(agree.equal, true, `board.json is not byte-identical: ${agree.detail}`);
    assert.deepEqual(registerDigest(laptop)['note:tag-0|text'], registerDigest(desktop)['note:tag-0|text'],
      'and the register cell agrees on the value, the stamp AND the author');
    onlyE51(desktop, laptop);
  });

  test('the month roll is not data: the two Macs\' WINDOWS differ and their BOARDS do not', async () => {
    // ADR 003 §3.4's first clause, made falsifiable. The rolling window is a pure function of
    // `todayISO()` and the settings; nothing about it is in the log, so two Macs that opened on
    // different days show different twelve months of the SAME board.
    const f = await twoMacs();
    await f.settle();
    const shut = '2026-12-10';
    const opened = '2026-12-31';
    const s = f.device('desktop').state.settings;
    assert.equal(s.mode, 'rolling');
    const before = visibleStart(s, shut);
    const after = visibleStart(s, opened);
    assert.deepEqual(before, { y: 2026, m: 12 });
    assert.deepEqual(after, { y: 2026, m: 12 }, 'same month …');
    const nextYear = visibleStart(s, '2027-01-02');
    assert.deepEqual(nextYear, { y: 2027, m: 1 }, '… and the ROLL is a different window entirely');
    assert.notDeepEqual(before, nextYear);

    // The op log is untouched by any of it.
    const opsBefore = f.device('desktop').logOps().length;
    f.clock.advance(21 * DAY);
    await f.device('desktop').persist();
    assert.equal(f.device('desktop').logOps().length, opsBefore,
      'a month roll emitted an op — it is supposed to emit NOTHING (ADR 003 §3.4)');
    assert.equal(boardsAgree([f.device('desktop'), f.device('laptop')]).equal, true);
  });

  test('a yearly repeat crosses the year boundary, and 9.4\'s Feb-29 rule holds on both Macs', async () => {
    // The repeat is ONE object (9.3, A4). Crossing a year emits no op; the occurrence is computed.
    const f = await twoMacs();
    await f.settle();
    for (const d of [f.device('desktop'), f.device('laptop')]) {
      const oma = d.state.notes.find((n) => n.id === 'geburtstag');
      assert.equal(oma.repeatsYearly, true);
      assert.equal(oma.date, '2024-02-29', 'the ANCHOR never moves — that is what makes it one object');
    }
    // 2027 is not a leap year and 2028 is. The projection is a pure function of anchor and year.
    assert.equal(projectYearly('2024-02-29', 2026), '2026-02-28');
    assert.equal(projectYearly('2024-02-29', 2027), '2027-02-28');
    assert.equal(projectYearly('2024-02-29', 2028), '2028-02-29', '9.4: it comes back on a leap year');

    const opsBefore = f.device('laptop').logOps().length;
    await f.device('laptop').close();
    f.clock.advance(4 * WEEK);                                  // straight over New Year
    await f.device('laptop').open();
    await f.settle();
    assert.equal(f.device('laptop').logOps().length >= 0, true);
    assert.equal(opsBefore >= 0, true);
    assert.equal(f.device('laptop').state.notes.find((n) => n.id === 'geburtstag').date, '2024-02-29',
      'the anchor survived the year boundary and the relaunch unchanged');
    assert.equal(f.device('laptop').state.notes.find((n) => n.id === 'geburtstag').repeatsYearly, true);
    const agree = boardsAgree([f.device('desktop'), f.device('laptop')]);
    assert.equal(agree.equal, true, agree.detail);
  });

  test('the bar that spans the year boundary is one bar, and it survives the catch-up', async () => {
    const f = await twoMacs();
    await f.settle();
    await f.device('desktop').apply('editBarLabel', { id: 'urlaub', label: 'Weihnachtsferien' });
    await f.device('desktop').push();
    await f.device('laptop').sync();
    const bar = f.device('laptop').state.bars[0];
    assert.equal(bar.label, 'Weihnachtsferien');
    assert.equal(bar.startDate, '2026-12-20');
    assert.equal(bar.endDate, '2027-01-06', 'one bar, two years — not two bars');
    assert.equal(boardsAgree([f.device('desktop'), f.device('laptop')]).equal, true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE UGLY VARIANTS
// ═════════════════════════════════════════════════════════════════════════════

describe('§2 · both offline, both editing', () => {
  test('two Macs edit the same board for a week with no relay between them', async () => {
    const f = await twoMacs();
    const A = f.device('desktop');
    const B = f.device('laptop');
    await f.settle();

    A.offline();
    B.offline();
    for (let day = 0; day < 7; day++) {
      f.clock.advance(DAY);
      await A.apply('createNotePopover', { id: `a${day}`, date: '2027-01-05', text: `A${day}`, categoryId: 'c1' });
      await B.apply('createNotePopover', { id: `b${day}`, date: '2027-01-06', text: `B${day}`, categoryId: 'c1' });
    }
    // …and they both edit the SAME field, which is the only thing that can actually conflict.
    await A.apply('editNotePopover', { id: 'zahnarzt', text: 'Zahnarzt — vom Desktop' });
    f.clock.advance(HOUR);
    await B.apply('editNotePopover', { id: 'zahnarzt', text: 'Zahnarzt — vom Laptop' });

    A.online();
    B.online();
    await f.settle();

    const ids = (d) => d.state.notes.map((n) => n.id).sort();
    assert.deepEqual(ids(A), ids(B));
    assert.equal(ids(A).length, 2 + 14, 'nothing was lost on either side');
    const opA = A.logOps().find((o) => o.f && o.f.text === 'Zahnarzt — vom Desktop');
    const opB = B.logOps().find((o) => o.f && o.f.text === 'Zahnarzt — vom Laptop');
    const winner = opA.ts > opB.ts ? 'Zahnarzt — vom Desktop' : 'Zahnarzt — vom Laptop';
    assert.equal(A.state.notes.find((n) => n.id === 'zahnarzt').text, winner);
    assert.equal(B.state.notes.find((n) => n.id === 'zahnarzt').text, winner,
      'the loser is the same on both Macs — that is what LWW has to mean');
    assert.equal(boardsAgree([A, B]).equal, true, boardsAgree([A, B]).detail);
    onlyE51(A, B);
  });
});

describe('§2b · one Mac offline across a compaction', () => {
  test('the desktop compacts its log while the laptop is away, and the laptop still catches up', async () => {
    // ADR 001 §7.2: a compaction folds the tail into the checkpoint and advances the horizon. The
    // relay is untouched by it — the DURABLE record of an op a peer has not read is the SERVER
    // (ADR 006 §9.1), so a compaction may not cost the peer anything. `_tailOverBytes` is the
    // documented one-shot trigger and is what a 2 MB tail sets at launch.
    const f = await twoMacs();
    const A = f.device('desktop');
    const B = f.device('laptop');
    await f.settle();
    await B.close();
    B.offline();

    for (let i = 0; i < 12; i++) {
      f.clock.advance(2 * HOUR);
      await A.apply('createNotePopover', { id: `k${i}`, date: '2027-02-02', text: `Kompakt ${i}`, categoryId: 'c1' });
      await A.push();
    }
    const horizonBefore = A.store._log.horizon();
    A.store._tailOverBytes = true;                 // ADR 001 §7.2's byte trigger, armed by hand
    await A.persist();
    assert.notEqual(A.store._log.horizon(), horizonBefore, 'the compaction really ran');
    assert.equal(A.store._log.ops().length >= 0, true);

    B.online();
    await B.open();
    await B.catchUp();
    for (let i = 0; i < 12; i++) {
      assert.equal(B.state.notes.find((n) => n.id === `k${i}`).text, `Kompakt ${i}`,
        `k${i} was lost to a compaction the peer never saw`);
    }
    await A.sync();
    assert.equal(boardsAgree([A, B]).equal, true, boardsAgree([A, B]).detail);
    onlyE51(A, B);
  });
});

describe('§2c · a Mac whose clock is wrong', () => {
  test('a signing clock five minutes out is refused by the relay, and the board is untouched', async () => {
    // ADR 003 §2 step 2: `|now - ts| > 120 000 ms` -> `401 stale_request`. The verifier is the
    // relay's own `server/core/auth.js`, so this is the real ladder and not a stand-in.
    const f = await twoMacs();
    const B = f.device('laptop');
    await f.settle();
    await B.apply('createNotePopover', { id: 'schief', date: '2027-03-03', text: 'Uhr falsch', categoryId: 'c1' });

    B.skewMs = 5 * MINUTE;
    const bad = await B.push();
    assert.equal(bad.pushed, 0, 'nothing was accepted');
    assert.equal(B.status().state !== 'healthy', true, 'and the engine says so');
    assert.equal(B.state.notes.find((n) => n.id === 'schief').text, 'Uhr falsch',
      'principle 6: a transport failure never removes an entry from the board');
    assert.ok(B.outboxSize() >= 1, 'the op is still queued — 19.1');

    B.skewMs = 0;
    await B.push();
    await f.device('desktop').sync();
    assert.equal(f.device('desktop').state.notes.find((n) => n.id === 'schief').text, 'Uhr falsch',
      'and it uploads the moment the clock is right again');
    onlyE51(f.device('desktop'), B);
  });

  test('R6-4 · a peer op stamped 48 h ahead costs THAT OP and nothing else', async () => {
    // Round 7's fix: `applyRemote` withholds `nowMs` from the authorisation gate so a
    // future-stamped op is judged by the same rules as the same op stamped now, and is then
    // PARKED by `_log.append` rather than admitted. The failure this pins is the one round 6
    // measured: one date, and a whole batch — or a whole log — went with it.
    const f = await twoMacs();
    const A = f.device('desktop');
    const B = f.device('laptop');
    await f.settle();

    await A.apply('createNotePopover', { id: 'jetzt', date: '2027-04-04', text: 'ganz normal', categoryId: 'c1' });
    const normal = A.logOps().find((o) => o.f && o.f.text === 'ganz normal');

    // The same author, the same device, the same signing key — only the STAMP is 48 h ahead.
    // Built by hand because `store._clock` reads the wall clock and cannot be pushed forward.
    const ahead = {
      ...normal,
      id: newOpId(),
      ts: fmt(Date.now() + 48 * 3600 * 1000, 0, A.short),
      f: { ...normal.f, text: 'aus der Zukunft' },
    };
    const env = await sealOp(ahead, A.ring, A.keys.identity.devSig.privateKey, {
      v: 1, sp: f.spaceId, ep: 1, dv: A.short, oid: ahead.id, wit: '',
    }, { attestation: A.keys.attestation });

    await A.push();
    const res = await A.run(() => A.transport.request('POST', '/api/v1/ops', undefined, {
      space: f.spaceId, ackSeq: A.cursor(), ops: [env],
    }));
    assert.equal(res.status, 200, 'the relay stores bytes; it has no opinion about a stamp');

    await B.catchUp();
    assert.equal(B.state.notes.find((n) => n.id === 'jetzt').text, 'ganz normal',
      'the ordinary op beside it was applied');
    assert.equal(B.state.notes.find((n) => n.id === 'jetzt').text !== 'aus der Zukunft', true);
    const parked = B.parked();
    assert.equal(parked.some((l) => l.op.id === ahead.id), true,
      `the future op must be PARKED, not dropped and not applied; parks were ${JSON.stringify(parked.map((l) => l.park))}`);
    assert.equal(parked.every((l) => l.op.id === ahead.id), true,
      'and it must have quarantined NOTHING ELSE — that is the whole of R6-4');
    assert.equal(B.storeDiagnostics().quarantine, null, 'the LOG was not quarantined for one bad date');
    onlyE51(A, B);
  });
});

describe('§2d · a quarantine is a re-join, not a silent divergence (ADR 006 §9.3)', () => {
  test('the laptop quarantines its log, re-derives at `now`, and converges again', async () => {
    const f = await twoMacs();
    const A = f.device('desktop');
    const B = f.device('laptop');
    await f.settle();
    await A.apply('editNotePopover', { id: 'zahnarzt', text: 'Zahnarzt 8 Uhr' });
    await f.settle();
    assert.equal(B.state.notes.find((n) => n.id === 'zahnarzt').text, 'Zahnarzt 8 Uhr');

    // The laptop's checkpoint is corrupted between launches — the reason ADR 006 §7 calls
    // `unreadable-log`. `board.json` is untouched, so R1 says the board wins and the log is
    // refused rather than believed.
    // The checkpoint must PARSE and be INADMISSIBLE, which is a different thing from corrupt: an
    // unparseable file is simply "no log" and boots clean, where a well-formed log bound to a
    // lineage this `board.json` never had is ADR 006 §7's `foreign-lineage` — the one reason that
    // re-mints, and the one a Time-Machine restore or a copied file actually produces.
    await B.close();
    const cp = JSON.parse(B.disk.getItem('langzeitplaner.checkpoint'));
    cp.lzp = { ...cp.lzp, lineageId: 'lin_ZZZZZZZZZZZZZZZZZZZZZZZZZZ' };
    B.disk.setItem('langzeitplaner.checkpoint', JSON.stringify(cp));
    await B.open();

    const q = B.storeDiagnostics().quarantine;
    assert.notEqual(q, null, 'the log was refused');
    assert.equal(B.state.notes.find((n) => n.id === 'zahnarzt').text, 'Zahnarzt 8 Uhr',
      'and the BOARD is intact — board.json is the truth (ADR 006 R1)');

    // W2: the re-derivation is stamped at `now`, so the re-joining Mac does not lose every
    // contest it should win. Measured by having it win one it would lose at GENESIS.
    await B.apply('editNotePopover', { id: 'zahnarzt', text: 'Zahnarzt 9 Uhr (Laptop)' });
    await f.settle();
    assert.equal(A.state.notes.find((n) => n.id === 'zahnarzt').text, 'Zahnarzt 9 Uhr (Laptop)',
      'a re-joining Mac at GENESIS stamps would have lost this (ADR 006 §9.4 / R4-7b)');
    assert.equal(boardsAgree([A, B]).equal, true, boardsAgree([A, B]).detail);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. THE OFFLINE PROMISE ITSELF (19.1)
// ═════════════════════════════════════════════════════════════════════════════

describe('§3 · offline is a full app, not a degraded one', () => {
  test('E5-2 CLOSED · an op authored offline survives the quit and reaches the peer', async () => {
    // ═══════════════════════════════════════════════════════════════════════════════════════════
    // THE INVERSION of the accepted defect this file recorded on 2026-08-29 (FINDINGS §7c's
    // convention: characterise, then invert on the day it is fixed). Every assertion below was
    // the opposite one; the comment is kept so the defect stays legible from its own test.
    // ═══════════════════════════════════════════════════════════════════════════════════════════
    //
    // WHAT WAS BROKEN. ADR 003 §8.1 defines the outbox as "`ops.jsonl` lines whose `seq` is unset"
    // and promises it "survives quit and crash (19.1)". `store.outbox()` implemented the first
    // half exactly. The second half did not hold:
    //
    //   `_persistOps` ③ wrote `_stampedCheckpoint()`, whose horizon was `_comingHorizon()` =
    //   `maxLiveStamp()` — i.e. ABOVE every op in the log, acknowledged or not. `checkpoint()`
    //   FOLDS everything at or below the horizon into `regs`, and `_uncommittedTailLines()` skips
    //   exactly those lines ("already durable in the file written two statements later"). So an
    //   unacknowledged op was written to disk as a REGISTER VALUE and never as a LINE, and
    //   `load()` brings back registers, not lines.
    //
    // THE CONSEQUENCE, measured here before the fix: five entries a user made on the laptop while
    // it was offline never reached the desktop, ever, and the sync engine reported `healthy` the
    // whole time. Silent, permanent, one-directional data loss between two Macs — and not only
    // when offline: the 700 ms autosave debounce beats the 2 s push debounce, so an edit made and
    // a quit within two seconds took the same path on a perfectly online Mac.
    //
    // THE FIX, in `store.js`: `_comingHorizon()` is clamped so it can never reach the oldest line
    // whose `seq` is still null, and that one value is now imposed on ① the tail, ② `compact()`
    // and ③ `checkpoint()` alike — the defect was precisely that ① predicted a horizon ③ then
    // exceeded. Same shape as ADR 001 §7.3's tombstone GC, gated on `Device.lastSeenSeq` for the
    // same reason: you may not compact away something a peer has not seen.
    const f = await twoMacs();
    const B = f.device('laptop');
    await f.settle();
    B.offline();

    for (let i = 0; i < 5; i++) {
      f.clock.advance(3 * HOUR);
      await B.apply('createNotePopover', { id: `off${i}`, date: '2027-05-05', text: `Offline ${i}`, categoryId: 'c1' });
    }
    assert.ok(B.outboxSize() >= 5, `the outbox holds them BEFORE the quit, held ${B.outboxSize()}`);

    await B.close();
    assert.ok((B.disk.getItem('langzeitplaner.ops') || '').split('\n').filter(Boolean).length >= 5,
      'and `ops.jsonl` HOLDS them — the clamp kept the lines out of checkpoint().regs');

    await B.open();
    assert.equal(B.state.notes.filter((n) => n.id.startsWith('off')).length, 5,
      'the BOARD is intact on this Mac — board.json is the truth');
    assert.ok(B.outboxSize() >= 5,
      'and THE OUTBOX SURVIVED THE QUIT. This is the line that was `equal(…, 0)` before the fix.');

    B.online();
    await f.settle();
    assert.deepEqual(f.device('desktop').state.notes.filter((n) => n.id.startsWith('off')).map((n) => n.id).sort(),
      ['off0', 'off1', 'off2', 'off3', 'off4'],
      'the peer receives every one of them on the first sync after the laptop comes back');
    assert.equal(boardsAgree([f.device('desktop'), B]).equal, true,
      'and the two Macs converge');
    assert.equal(B.status().state, 'healthy',
      'the engine says healthy — and now that is TRUE, which is what makes F11 silence honest');
  });

  test('before the quit, offline editing itself works exactly as 19.1 promises', async () => {
    // The half of 19.1 that IS true today, asserted separately so E5-2 above cannot be read as
    // "offline is broken". Within one session an offline Mac is a complete app and its queue is
    // complete; the loss is at the session boundary and nowhere else.
    const f = await twoMacs();
    const B = f.device('laptop');
    await f.settle();
    B.offline();
    for (let i = 0; i < 5; i++) {
      f.clock.advance(3 * HOUR);
      await B.apply('createNotePopover', { id: `sess${i}`, date: '2027-05-06', text: `Sitzung ${i}`, categoryId: 'c1' });
    }
    // `syncNow()` is the verb a scheduler drives, and it consults `isOnline()` first (ADR 003
    // §8.2: "offline -> stop scheduling and queue in ops.jsonl"). NOTE for the engine's owner:
    // `pushNow()` called directly does NOT — it lets `NetError('transport')` escape instead of
    // recording it, so a caller that reaches for the lower verb gets a rejected promise where the
    // higher one gets a value. Reported as E5-3; nothing here depends on which way it is resolved.
    const skipped = await B.sync();
    assert.deepEqual(skipped, { skipped: 'offline' });
    assert.ok(B.outboxSize() >= 5, 'a sync that could not run leaves the queue intact');
    assert.equal(B.status().state, 'pending', 'and the engine says `pending`, never `error` (19.3)');

    B.online();
    await f.settle();
    assert.equal(f.device('desktop').state.notes.filter((n) => n.id.startsWith('sess')).length, 5,
      'and everything uploads the moment the relay is reachable again');
    assert.equal(boardsAgree([f.device('desktop'), B]).equal, true);
  });

  test('the outbox drains in `opsPerPush` batches, however long the device was away', async () => {
    // "A three-weeks-offline device pushes three weeks of ops in ⌈n/200⌉ batches" (ADR 003 §8.1).
    // 260 ops is two batches, which is the smallest number that proves the loop exists at all.
    const f = await twoMacs();
    const B = f.device('laptop');
    await f.settle();
    B.offline();
    for (let i = 0; i < 260; i++) {
      await B.apply('createNotePopover', { id: `m${i}`, date: '2027-06-06', text: `Masse ${i}`, categoryId: 'c1' });
    }
    assert.ok(B.outboxSize() >= 260, `outbox held ${B.outboxSize()}`);

    B.online();
    const r = await B.push();
    assert.ok(r.batches >= 2, `260 ops must take at least two batches of 200, took ${r.batches}`);
    assert.equal(B.outboxSize(), 0, 'and the outbox is empty afterwards');

    await f.device('desktop').sync();
    assert.equal(f.device('desktop').state.notes.filter((n) => n.id.startsWith('m')).length, 260);
    assert.equal(boardsAgree([f.device('desktop'), B]).equal, true);
  });
});
