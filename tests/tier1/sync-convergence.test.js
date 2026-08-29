// TIER 1 · LZP-505 — TWO MACS, ONE BOARD, ONE RELAY THAT CAN READ NOTHING.
//
// The fleet harness's own proof. It lives in tier 1 rather than in `tests/fleet/` because it must
// run in `npm test` — the suite that gates every commit — and because everything it asserts is a
// property of the SEAM (`store.outbox`/`applyRemote`, `sealOp`/`openOp`, the cursor) rather than
// of a long-running scenario. The scenarios are in `tests/fleet/`.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE SENTENCE THIS FILE IS WRITTEN AGAINST
// ═════════════════════════════════════════════════════════════════════════════
//
//   FINDINGS A3-H4: "Any fleet test that mints its ops with the receiving store's own `_me` is a
//   FALSE GREEN."
//
// §0 is therefore about the harness and not about the product: it proves the two devices are two
// devices, that the mutants of that claim are REFUSED rather than green, that the transport is
// `platform/net.js` itself, and that the relay holds no plaintext. Only then does §1 claim
// convergence.
//
// EVERYTHING BELOW RUNS THE SHIPPED CODE — `src/js/store.js` twice over, `src/js/sync/personal.js`
// as the engine, `src/js/crypto/pairing.js` through `tests/helpers/mitm.js`'s honest relay,
// `sealOp`/`openOp` unmodified, `platform/net.js`'s `createFetchTransport` with only the socket
// replaced, and all 23 server handlers over the memory adapter.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createFleet, boardsAgree, registerDigest, MUTATORS, chainMutators } from '../helpers/fleet.js';
import { createRelay, createWire, deviceTransport, simClock, ORIGIN } from '../helpers/loopback.js';
import { spaceClassOf } from '../../src/js/core/ops.js';
import { deviceShortOf } from '../../src/js/crypto/identity.js';
import { ub64 } from '../../src/js/core/b64.js';

/** One note, one bar, one category, one pad — enough for a field contest and a collection merge. */
const BOARD = () => ({
  schemaVersion: 1,
  notes: [{ id: 'n0', date: '2026-03-04', text: 'Zahnarzt', categoryId: 'c1', repeatsYearly: false }],
  bars: [{ id: 'b0', startDate: '2026-07-01', endDate: '2026-07-14', label: 'Urlaub', categoryId: 'c1' }],
  categories: [{ id: 'c1', name: 'Familie', paletteRef: 'gruen', visible: true }],
  scratchpads: { '2026-03': 'Notizen' },
  settings: null,
});

const twoMacs = (over = {}) => createFleet({ board: BOARD(), devices: ['A', 'B'], ...over });

/**
 * Every fleet assertion in this file allows exactly one quarantine population — E5-1's — and
 * refuses every other. See `tests/helpers/fleet.js`'s header: the fleet suite found E5-1 and it
 * is registered rather than hidden, so a SECOND defect cannot arrive under its cover.
 */
function onlyE51(...devices) {
  for (const d of devices) {
    assert.deepEqual(d.realQuarantine(), [],
      `${d.name}: a quarantine that is not E5-1 — ${JSON.stringify(d.realQuarantine())}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 0. THE HARNESS IS HONEST — asserted before anything is claimed with it
// ═════════════════════════════════════════════════════════════════════════════

describe('§0 · the harness cannot produce a false green', () => {
  test('A3-H4: two devices, two key stores, two signing keys, ONE member', async () => {
    const f = await twoMacs();
    assert.notEqual(f.A.deviceId, f.B.deviceId, 'two deviceIds');
    assert.notEqual(f.A.short, f.B.short, 'two deviceShorts');
    assert.equal(f.A.memberId, f.B.memberId, 'one member — M1 is one person with two Macs');
    assert.notEqual(f.A.store, f.B.store, 'two store MODULE INSTANCES');
    assert.notEqual(f.A.store._device, f.B.store._device, 'two _device values');
    assert.notEqual(f.A.keys.ks, f.B.keys.ks, 'two key stores');
    for (const d of f.all) {
      const row = f.roster.find((r) => r.deviceId === d.deviceId);
      // The short must BE the key, not a label on it. This is the line that would catch a future
      // harness handing one device the other's pair and relabelling it (ADR 002 §5.2.0).
      assert.equal(deviceShortOf(ub64(row.sigPubRaw)), d.short);
      assert.equal(d.store.hasDurableIdentity(), true);
    }
  });

  test('the gate REFUSES the mutants — it is red for each, not merely green for the honest case', async () => {
    const f = await twoMacs();
    const saved = { ...f.roster[1] };
    f.roster[1] = { ...saved, deviceId: f.roster[0].deviceId };
    await assert.rejects(() => f.assertDistinctIdentities(), /share a deviceId/);
    f.roster[1] = { ...saved, deviceShort: f.roster[0].deviceShort };
    await assert.rejects(() => f.assertDistinctIdentities(), /share a deviceShort/);
    f.roster[1] = { ...saved, sigPubRaw: f.roster[0].sigPubRaw };
    await assert.rejects(() => f.assertDistinctIdentities(), /share a SIGNING KEY/);
    f.roster[1] = { ...saved, memberId: `${saved.memberId.slice(0, 4)}ZZZZZZZZZZZZZZZZZZZZZZ` };
    await assert.rejects(() => f.assertDistinctIdentities(), /ONE member/);
    f.roster[1] = saved;
    assert.equal(await f.assertDistinctIdentities(), true, 'and the honest fleet still passes');
  });

  test('each Mac has its OWN disk — a file written on one is invisible on the other', async () => {
    const f = await twoMacs();
    assert.notEqual(f.A.boardText(), null, 'A has a board.json');
    assert.notEqual(f.B.boardText(), null, 'B has one too');
    f.A.disk.setItem('probe', 'only on A');
    assert.equal(f.B.disk.getItem('probe'), null, 'and the two disks are not the same object');
    assert.ok(f.A.diskKeys().includes('langzeitplaner.board'));
    assert.ok(f.A.diskKeys().includes('langzeitplaner.checkpoint'),
      'the log is durable — usePersonalSpace() armed it (ADR 006 §9.5)');
  });

  test('the transport is net.js itself — an off-origin or off-shape request never reaches the relay', async () => {
    const relay = createRelay({ clock: simClock() });
    const wire = createWire(relay);
    const before = wire.calls.length;
    const t = deviceTransport({
      wire, deviceShort: 'AAAAAAAAAAAAAAAA', sign: async () => new Uint8Array(64),
    });
    await assert.rejects(() => t.request('GET', '/api/v1/../secrets', {}, null));
    await assert.rejects(() => t.request('DELETE', '/api/v1/ops', {}, null));
    await assert.rejects(() => t.request('GET', '/nope', {}, null));
    assert.equal(wire.calls.length, before, 'net.js refused all three before the relay was called');
    assert.equal(t.origin, ORIGIN);
  });

  test('the relay is BLIND: nothing it ever held contains one character of the board', async () => {
    const f = await twoMacs();
    await f.A.apply('editNotePopover', { id: 'n0', text: 'Zahnarzt um 14 Uhr' });
    await f.settle();
    assert.equal(f.B.state.notes[0].text, 'Zahnarzt um 14 Uhr');

    const held = JSON.stringify(f.wire.seenBodies) + JSON.stringify(f.relay.store);
    for (const secret of ['Zahnarzt', 'Urlaub', 'Familie', 'Notizen', '2026-03-04', 'note.set']) {
      assert.equal(held.includes(secret), false, `the relay held the plaintext ${JSON.stringify(secret)}`);
    }
    // And ADR 003 §6.2: only the seven whitelisted fields reached the log serialiser.
    for (const line of f.relay.logLines) {
      for (const k of Object.keys(JSON.parse(line))) {
        assert.ok(f.relay.LOG_FIELD_NAMES.includes(k), `${k} reached the log serialiser`);
      }
    }
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// 1. M1 — the convergence A3-H4 said was impossible
// ═════════════════════════════════════════════════════════════════════════════

describe('§1 · two Macs converge over a blind relay', () => {
  test('the op B folds was authored by A — never re-minted for the receiver', async () => {
    const f = await twoMacs();
    await f.A.apply('editNotePopover', { id: 'n0', text: 'von Mac A' });
    await f.A.push();
    const r = await f.B.pull();
    assert.equal(r.applied >= 1, true, `B applied nothing: ${JSON.stringify(r)}`);

    const folded = f.B.logOps().find((o) => o.f && o.f.text === 'von Mac A');
    assert.ok(folded, 'B folded it');
    assert.equal(folded.dev, f.A.deviceId, "and it is stamped by MAC A — A3-H4's false-green pin");
    assert.equal(folded.act, f.A.memberId);
    assert.equal(folded.ts.slice(-16), f.A.short, 'ADR 002 §5.2.2 check 4: devOf(op.ts) === dv');
    assert.equal(f.B.state.notes[0].text, 'von Mac A');
    onlyE51(f.B);
  });

  test('a three-op exchange in both directions leaves one board', async () => {
    const f = await twoMacs();
    await f.A.apply('editNotePopover', { id: 'n0', text: 'A schreibt' });
    await f.A.apply('createNotePopover', { id: 'nA', date: '2026-04-01', text: 'nur bei A', categoryId: 'c1' });
    await f.B.apply('createNotePopover', { id: 'nB', date: '2026-05-01', text: 'nur bei B', categoryId: 'c1' });
    await f.settle();

    const ids = (d) => d.state.notes.map((n) => n.id).sort();
    assert.deepEqual(ids(f.A), ['n0', 'nA', 'nB']);
    assert.deepEqual(ids(f.B), ['n0', 'nA', 'nB']);
    const agree = boardsAgree([f.A, f.B]);
    assert.equal(agree.equal, true, agree.detail);
    onlyE51(f.A, f.B);
  });

  test('a last-writer-wins contest is decided identically on both Macs', async () => {
    const f = await twoMacs();
    await f.A.apply('editNotePopover', { id: 'n0', text: 'A zuerst' });
    await f.B.apply('editNotePopover', { id: 'n0', text: 'B danach' });
    await f.settle();
    const opA = f.A.logOps().find((o) => o.f && o.f.text === 'A zuerst');
    const opB = f.B.logOps().find((o) => o.f && o.f.text === 'B danach');
    const winner = opA.ts > opB.ts ? 'A zuerst' : 'B danach';
    assert.equal(f.A.state.notes[0].text, winner);
    assert.equal(f.B.state.notes[0].text, winner, 'both Macs picked the SAME winner');
    assert.equal(boardsAgree([f.A, f.B]).equal, true);
  });

  test('a deletion travels, and does not come back on the next sync', async () => {
    const f = await twoMacs();
    await f.A.apply('deleteNotePopover', { id: 'n0' });
    await f.settle();
    assert.deepEqual(f.A.state.notes.map((n) => n.id), []);
    assert.deepEqual(f.B.state.notes.map((n) => n.id), []);
    await f.settle();
    assert.deepEqual(f.B.state.notes.map((n) => n.id), [],
      'a tombstone that resurrects on the next pull is the classic op-log bug');
  });

  test('a bar and a scratchpad travel too — not only notes', async () => {
    const f = await twoMacs();
    await f.A.apply('editBarLabel', { id: 'b0', label: 'Sommerurlaub' });
    await f.A.apply('padBlur', { month: '2026-03', text: 'Neue Notiz' });
    await f.settle();
    assert.equal(f.B.state.bars[0].label, 'Sommerurlaub');
    assert.equal(f.B.state.scratchpads['2026-03'], 'Neue Notiz');
    assert.equal(boardsAgree([f.A, f.B]).equal, true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE RULES OF THE SEAM
// ═════════════════════════════════════════════════════════════════════════════

describe('§2 · the outbox, the cursor and the space filter', () => {
  test('F-7: a `local`-space op never leaves the Mac', async () => {
    const f = await twoMacs();
    await f.A.run(async () => {
      f.A.store.setSettings({ language: 'en' });
      clearTimeout(f.A.store._saveTimer);
      await f.A.store.persistNow();
    });
    const prefs = f.A.logOps().filter((o) => o.k === 'pref.set');
    assert.ok(prefs.length > 0, 'the pref op exists …');
    assert.equal(spaceClassOf(prefs[0].space), 'local', '… in the LOCAL space');
    const outboxIds = new Set(f.A.store.outbox().map((l) => l.op.id));
    for (const p of prefs) {
      assert.equal(outboxIds.has(p.id), false, `pref op ${p.id} was offered to the wire`);
    }
    await f.settle();
    assert.equal(f.B.logOps().some((o) => o.k === 'pref.set' && o.f.language === 'en'), false,
      'and B never received one — settings are not synced (17.7, rule U6)');
    assert.equal(f.B.state.settings.language, 'de');
  });

  test('accepted and duplicate are treated identically: five pushes of one batch burn one seq', async () => {
    const f = await twoMacs();
    await f.A.apply('editNotePopover', { id: 'n0', text: 'genau einmal' });
    await f.A.push();
    const head = async () => (await f.A.run(() => f.A.transport.request(
      'GET', '/api/v1/ops', { space: f.spaceId, since: '0' }, null,
    ))).json;
    const first = await head();

    for (let i = 0; i < 4; i++) await f.A.push();     // the outbox is empty; nothing is re-sealed
    const again = await head();
    assert.equal(again.ops.length, first.ops.length,
      'a retry must not burn a seq — a gappy counter plus `WHERE seq > cursor` SKIPS ops');
    assert.deepEqual(again.ops.map((o) => o.seq), first.ops.map((o) => o.seq));

    const r = await f.B.pull();
    assert.ok(r.applied >= 1);
    assert.equal(f.B.state.notes[0].text, 'genau einmal');
  });

  test('W1 — the persisted cursor is never ahead of `board.json`', async () => {
    // ADR 006 §9.1: "the persisted cursor may never be ahead of board.json … it must be asserted,
    // so that a future sync engine cannot break it by persisting a cursor through some other
    // file." `store.noteCursor` is the only way to move one and it writes into the log, whose
    // only route to disk is `_persistOps`, which runs strictly after `saveBoardText`.
    const f = await twoMacs();
    await f.A.apply('createNotePopover', { id: 'nX', date: '2026-06-01', text: 'nach dem Cursor', categoryId: 'c1' });
    await f.A.push();

    const before = f.B.boardText();
    const cursorBefore = f.B.cursor();
    await f.B.pull();
    assert.notEqual(f.B.boardText(), before, 'the board moved …');
    assert.notEqual(f.B.cursor(), cursorBefore, '… and so did the cursor');
    assert.ok(JSON.parse(f.B.boardText()).notes.some((n) => n.id === 'nX'),
      'the board.json on disk commits the op the cursor now claims to have folded');

    // The DURABLE cursor is the one in `checkpoint().cursors`, and W1 is an INEQUALITY, not an
    // equality: behind is safe (the ops are re-pulled and are idempotent by opId), ahead is data
    // loss. `noteCursor` only schedules a persist, so right after a pull the file is legitimately
    // behind — and that is the safe side of the invariant, which is the point.
    const durable = () => {
      const cp = JSON.parse(f.B.disk.getItem('langzeitplaner.checkpoint'));
      assert.ok(cp, 'the checkpoint exists');
      assert.ok(cp.cursors && typeof cp.cursors === 'object', 'and it carries cursors');
      return BigInt(cp.cursors[f.spaceId] ?? '0');
    };
    assert.ok(durable() <= BigInt(f.B.cursor()),
      `W1 VIOLATED: the persisted cursor ${durable()} is AHEAD of the in-memory one ${f.B.cursor()}`);
    await f.B.persist();
    assert.equal(String(durable()), f.B.cursor(),
      'and one persist brings it level — through the checkpoint, with no second file involved');
    assert.ok(JSON.parse(f.B.boardText()).notes.some((n) => n.id === 'nX'),
      'while board.json still commits everything that cursor claims');
  });

  test('a crash between the fold and the cursor write costs one re-pull and nothing else', async () => {
    const f = await twoMacs();
    await f.A.apply('createNotePopover', { id: 'nY', date: '2026-06-02', text: 'wieder geholt', categoryId: 'c1' });
    await f.A.push();
    await f.B.pull();
    const digest = registerDigest(f.B);
    const before = f.B.boardContent();

    // The crash: the cursor never landed. `oplog.setCursor` never moves backwards, so this is
    // done through the log the way a lost checkpoint would leave it.
    f.B.store._log.setCursor(f.spaceId, '0');
    await f.B.pull();
    assert.deepEqual(registerDigest(f.B), digest, 'folding it twice changed nothing (ADR 001 §6)');
    assert.deepEqual(f.B.boardContent(), before);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. DISORDER — `seq` is a transport cursor and never a merge input (ADR 003 §3.3)
// ═════════════════════════════════════════════════════════════════════════════

describe('§3 · reorder, duplicate and shuffle change latency and nothing else', () => {
  const scenario = async (f) => {
    await f.A.apply('editNotePopover', { id: 'n0', text: 'eins' });
    await f.A.apply('createNotePopover', { id: 'n1', date: '2026-04-04', text: 'zwei', categoryId: 'c1' });
    await f.A.apply('editNotePopover', { id: 'n0', text: 'drei' });
    await f.A.apply('editBarLabel', { id: 'b0', label: 'Sommerurlaub' });
    await f.A.push();
  };

  for (const [name, mutator] of [
    ['served backwards', MUTATORS.reverseOps()],
    ['served twice', MUTATORS.duplicateOps()],
    ['shuffled (seed 7)', MUTATORS.shuffleOps(7)],
    ['shuffled and doubled', chainMutators(MUTATORS.shuffleOps(3), MUTATORS.duplicateOps())],
  ]) {
    test(`a page ${name} folds to the same board`, async () => {
      const f = await twoMacs();
      await scenario(f);
      f.wire.hostile.onResponse = mutator;
      await f.B.sync();
      f.wire.honest();

      assert.equal(f.B.state.notes.find((n) => n.id === 'n0').text, 'drei',
        `${name}: the LWW winner must not depend on arrival order`);
      assert.equal(f.B.state.notes.find((n) => n.id === 'n1').text, 'zwei');
      assert.equal(f.B.state.bars[0].label, 'Sommerurlaub');
      const agree = boardsAgree([f.A, f.B]);
      assert.equal(agree.equal, true, `${name}: ${agree.detail}`);
      onlyE51(f.B);
    });
  }

  test('a rewound cursor costs re-pulls, never a lost or doubled entry', async () => {
    const f = await twoMacs();
    await scenario(f);
    f.wire.hostile.onResponse = MUTATORS.rewindCursor();
    await f.B.pull();                       // the adversary is not obliged to terminate …
    f.wire.honest();
    await f.B.sync();                       // … the client is obliged to lose nothing
    assert.deepEqual(f.B.state.notes.map((n) => n.id).sort(), ['n0', 'n1']);
    assert.equal(f.B.state.notes.find((n) => n.id === 'n0').text, 'drei');
    assert.equal(boardsAgree([f.A, f.B]).equal, true);
  });

  test('per-space seq is gapless under interleaved push', async () => {
    // ADR 003 §3.3: not a SERIAL. A gap plus `WHERE seq > cursor` is a silent, intermittent skip.
    const f = await twoMacs();
    for (let i = 0; i < 4; i++) {
      await f.A.apply('createNotePopover', { id: `a${i}`, date: '2026-08-01', text: `A${i}`, categoryId: 'c1' });
      await f.B.apply('createNotePopover', { id: `b${i}`, date: '2026-08-02', text: `B${i}`, categoryId: 'c1' });
      await f.A.push();
      await f.B.push();
    }
    const page = await f.A.run(() => f.A.transport.request(
      'GET', '/api/v1/ops', { space: f.spaceId, since: '0' }, null,
    ));
    const seqs = page.json.ops.map((o) => Number(o.seq));
    assert.ok(seqs.length >= 8, `only ${seqs.length} ops reached the relay`);
    assert.deepEqual(seqs, seqs.slice().sort((x, y) => x - y), 'ascending');
    for (let i = 1; i < seqs.length; i++) {
      assert.equal(seqs[i], seqs[i - 1] + 1, `gap between ${seqs[i - 1]} and ${seqs[i]}`);
    }
    await f.settle();
    assert.equal(f.A.state.notes.length, 9, '1 seeded + 4 + 4');
    assert.equal(boardsAgree([f.A, f.B]).equal, true);
  });
});
