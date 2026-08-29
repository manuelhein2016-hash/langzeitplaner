// FLEET · THE CONVERGENCE ADVERSARY — THE SEARCH FOR A PERMANENT DISAGREEMENT.  Risk R2.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS IS AND HOW IT DIFFERS FROM `disorder.test.js`
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `tests/fleet/disorder.test.js` drives a seeded schedule of EDITS through a relay that reorders,
// duplicates and pages, with one device partitioned. Its lattice is the edit kinds.
//
// This file's lattice is the LIFECYCLE. The same seeded schedule interleaves the edits with the
// events that change what a device HOLDS rather than what it means:
//
//        offline / online   ·   quit and relaunch   ·   COMPACT   ·   the hostile relay
//
// and it asks four questions of every run, after the network has healed and both Macs have been
// synced to a fixed point:
//
//   INV-A  the two Macs agree on CONTENT — compared canonically, so a difference in JSON key
//          order is not counted here (§3 owns that).
//   INV-B  the two Macs agree on `board.json` BYTE FOR BYTE. This is the fleet's own criterion
//          and the one the E5 demonstration claimed.
//   INV-C  the REGISTER DIGESTS agree — value, stamp and author, cell by cell. Two Macs can
//          project the same board out of cells that disagree about who wrote what and when, and
//          the next edit would then diverge.
//   INV-D  the result is STABLE: syncing again changes nothing.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE RESULT, STATED UP FRONT BECAUSE IT IS WHAT THE FILE IS FOR
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Over 24 seeds × 30 steps the answer separates cleanly into two, and the separator is ONE event:
//
//   · **WITHOUT `compact`, content ALWAYS converges** — through partitions, relaunches, reorder,
//     duplication, paging and a hostile relay, in every seed. ADR 003 §3.3's claim holds. §1.
//   · **WITH `compact`, content diverges permanently in the majority of seeds**, with empty
//     outboxes, empty quarantines, no log quarantine and `sync.status() === 'healthy'` on both
//     Macs. Every one of those runs has had `store._outboxHorizonCap()` stand its cap down, and
//     the mechanism is minimised with its control in `attack-converge-outbox.test.js` §1. §2.
//   · and `board.json` is **not byte-identical** even in the runs that DO converge, because the
//     two Macs learn one entity's fields in different orders and `materialize.js` emits an
//     entity's properties in register-insertion order. Same values, different bytes. §3.
//
// Zero dependencies; the schedule comes from `seededRandom`, so a red run names its seed.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFleet, boardsAgree, registerDigest, MUTATORS, chainMutators, simClock,
} from '../helpers/fleet.js';
import { seededRandom } from '../helpers/loopback.js';

const BOARD = () => ({
  schemaVersion: 1,
  notes: [{ id: 'seed', date: '2027-03-04', text: 'Anfang', categoryId: 'c1', repeatsYearly: false }],
  bars: [{ id: 'bseed', startDate: '2027-07-01', endDate: '2027-07-10', label: 'Urlaub', categoryId: 'c1' }],
  categories: [{ id: 'c1', name: 'Familie', paletteRef: 'gruen', visible: true }],
  scratchpads: {},
  settings: null,
});

/** Content equality that does not care about property order. §3 is where order is judged. */
const sortKeys = (v) => (Array.isArray(v)
  ? v.map(sortKeys)
  : (v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
    : v));
const canonical = (dev) => JSON.stringify(sortKeys(dev.boardContent()));

const EDITS = ['edit', 'create', 'delete', 'bar', 'pad'];
const LIFE = ['sync', 'offline', 'online', 'quit', 'mutate-on', 'mutate-off'];

/**
 * One run. `events` is the alphabet — the ONLY difference between §1 and §2 is whether it
 * contains `'compact'`, which is what makes the comparison a controlled one rather than two
 * separate experiments.
 */
async function run(seed, events, steps = 30) {
  const rand = seededRandom(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const f = await createFleet({
    board: BOARD(), devices: ['A', 'B'], clock: simClock(Date.UTC(2026, 11, 10, 9, 0, 0)),
  });
  /** The script's own answer, computed from the script and not from either Mac. */
  const expect = new Map([['seed', 'Anfang']]);
  const log = [];

  for (let i = 0; i < steps; i++) {
    const who = pick(['A', 'B']);
    const d = f.device(who);
    const ev = pick(events);
    log.push(`${who}:${ev}`);
    switch (ev) {
      case 'create': {
        const id = `n${i}`;
        if (await d.apply('createNotePopover', {
          id, date: '2027-05-05', text: `${who}${i}`, categoryId: 'c1',
        })) expect.set(id, `${who}${i}`);
        break;
      }
      case 'edit': {
        const ids = [...expect.keys()];
        if (!ids.length) break;
        const id = pick(ids);
        // Only count it if THIS Mac could perform it — a Mac that has not received the entry yet
        // declines, and the script must not claim an edit that never happened.
        if (await d.apply('editNotePopover', { id, text: `${who}${i}` })) expect.set(id, `${who}${i}`);
        break;
      }
      case 'delete': {
        const ids = [...expect.keys()];
        if (ids.length < 2) break;
        const id = pick(ids);
        if (await d.apply('deleteNotePopover', { id })) expect.delete(id);
        break;
      }
      case 'bar':
        await d.apply('moveBar', { id: 'bseed', startDate: '2027-08-01', endDate: '2027-08-10' });
        break;
      case 'pad':
        await d.apply('padBlur', { month: '2027-05', text: `${who}${i}` });
        break;
      case 'sync': if (!d.isOffline) await d.sync(); break;
      case 'offline': d.offline(); break;
      case 'online': d.online(); break;
      case 'quit': await d.relaunch(); break;
      case 'compact': d.store._tailOverBytes = true; await d.persist(); break;
      case 'mutate-on':
        f.wire.hostile.onResponse = chainMutators(MUTATORS.shuffleOps(seed + i), MUTATORS.duplicateOps());
        break;
      case 'mutate-off': f.wire.honest(); break;
      default: break;
    }
    f.clock.advance(7 * 60 * 1000);
  }

  // ── the endgame: an honest relay, both Macs online, synced to a fixed point ──────────────
  f.wire.honest();
  f.device('A').online();
  f.device('B').online();
  for (const d of f.all) await d.catchUp(8);
  await f.settle(3);
  for (const d of f.all) await d.catchUp(4);

  const A = f.device('A');
  const B = f.device('B');
  const bytes = boardsAgree([A, B]);
  const da = registerDigest(A);
  const db = registerDigest(B);
  const cells = [...new Set([...Object.keys(da), ...Object.keys(db)])]
    .filter((k) => JSON.stringify(da[k]) !== JSON.stringify(db[k]));

  const before = canonical(A);
  await f.settle(2);
  const stable = canonical(A) === before;

  // INV-B′ — NOTHING WAS LOST AND NOTHING SURVIVED THAT SHOULD NOT HAVE, computed from the
  // SCRIPT and not from either Mac. Two Macs that both dropped the same op agree perfectly, so
  // this is the invariant self-comparison cannot give. Only mutations the device actually
  // performed are counted (a Mac that has not received an entry declines to edit it).
  const onA = new Set(A.state.notes.map((n) => n.id));
  const onB = new Set(B.state.notes.map((n) => n.id));
  const lost = [...expect.keys()].filter((id) => !onA.has(id) || !onB.has(id));
  const extra = [...onA].filter((id) => !expect.has(id));

  return {
    seed,
    log,
    content: canonical(A) === canonical(B),   // INV-A
    bytes: bytes.equal,                       // INV-B
    detail: bytes.detail,
    cells: cells.length,                      // INV-C
    stable,                                   // INV-D
    lost,                                     // INV-B′
    extra,
    entries: onA.size,
    // `store.warnings` is emptied by every relaunch, so the durable signal is the store's own
    // once-per-session flag, which `_outboxHorizonCap()` sets when it stands the cap down.
    e52: !!(A.store._e52Warned || B.store._e52Warned),
    quarantined: [...A.quarantined(), ...B.quarantined()].map((q) => q.reason),
    logQuarantine: [A, B].map((d) => d.storeDiagnostics().quarantine?.reason ?? null).filter(Boolean),
    outbox: A.outboxSize() + B.outboxSize(),
    status: [A.status().state, B.status().state],
  };
}

const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. WITHOUT COMPACTION — THE PROPERTY HOLDS
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The honest sweep, run ONCE. §1 judges its content; §3 judges its bytes. */
const HONEST = [];

describe('§1 · SUCCEEDED · partition + reorder + duplication + paging + relaunch never diverge', () => {
  test('24 seeds × 30 steps: content converges, the registers agree, and the result is stable', async () => {
    const events = [...EDITS, ...LIFE];
    const bad = [];
    for (const seed of SEEDS) {
      const r = await run(seed, events);
      HONEST.push(r);
      if (!r.content || r.cells || !r.stable || r.lost.length || r.extra.length) bad.push(r);
    }
    // NON-VACUITY: a sweep in which nothing ever reached the other Mac would pass every line
    // above. The scripts must actually have built boards.
    const built = HONEST.filter((r) => r.entries > 1).length;
    assert.ok(built >= SEEDS.length / 2,
      `only ${built}/${SEEDS.length} seeds ended with more than the starting entry — the sweep is vacuous`);
    assert.deepEqual(
      bad.map((r) => ({
        seed: r.seed, content: r.content, cells: r.cells, stable: r.stable,
        lost: r.lost, extra: r.extra, script: r.log.join(' '),
      })),
      [],
      'ADR 003 §3.3 — `seq` is a transport cursor and never a merge input — must hold under every '
      + 'interleaving of partition, reorder, duplication, paging, quit and a hostile relay',
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. ADD ONE EVENT — COMPACTION — AND THE MAJORITY OF SEEDS DIVERGE FOR EVER
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · FAILED · the same schedules with `compact` in the alphabet', () => {
  test('a permanent, stable content divergence, with `healthy` on both Macs and nothing queued', async () => {
    const events = [...EDITS, ...LIFE, 'compact'];
    const rows = [];
    for (const seed of SEEDS) rows.push(await run(seed, events));
    const diverged = rows.filter((r) => !r.content);

    assert.ok(diverged.length > 0,
      'THIS ROW IS THE FINDING. If it ever goes green — no seed diverges — `store._outboxHorizonCap()` '
      + 'has been fixed and this test should be inverted, not deleted.');

    // It is not an artefact of an unfinished endgame: nothing is queued, nothing is refused, and
    // nothing repairs it on a second pass.
    for (const r of diverged) {
      assert.equal(r.outbox, 0, `seed ${r.seed}: both outboxes are empty — nothing is still owed`);
      assert.deepEqual(r.quarantined, [], `seed ${r.seed}: the engine refused nothing`);
      assert.deepEqual(r.logQuarantine, [], `seed ${r.seed}: neither log was quarantined`);
      assert.deepEqual(r.status, ['healthy', 'healthy'],
        `seed ${r.seed}: STORY 19.3 — the indicator draws nothing, on two Macs that disagree`);
      assert.equal(r.stable, true, `seed ${r.seed}: and it is stable, i.e. permanent`);
      assert.equal(r.e52, true,
        `seed ${r.seed}: every divergent run carries the E5-2 stand-down warning — the mechanism is `
        + 'minimised in attack-converge-outbox.test.js §1');
    }

    // The size of it, recorded so a later pass can see the number move.
    assert.ok(diverged.length >= SEEDS.length / 4,
      `measured at ${diverged.length}/${SEEDS.length} seeds; seeds ${JSON.stringify(diverged.map((r) => r.seed))}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. `board.json` IS NOT BYTE-IDENTICAL, EVEN WHEN THE CONTENT IS
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · FAILED (LOW) · `board.json` is not byte-identical, even where the content is', () => {
  test('the same run, the same values, a different JSON key order', () => {
    // ADR 003 §3.3 says a relay that serves ops out of order "cannot cause divergence — only
    // latency". That is true of the CONTENT and false of the BYTES: `materialize.js` emits an
    // entity's properties in the order its register CELLS were created, so a Mac that learned
    // `text` before `date` writes `{id, text, categoryId, date, …}` where its peer writes
    // `{id, date, text, categoryId, …}`. Same values, same array order, a different file.
    //
    // It matters twice. `board.json` byte-identity is the fleet's own convergence criterion and
    // the one the E5 demonstration reported; and `checkpoint().lzp.boardHash` is taken over
    // exactly these bytes (non-gating today — this is the reason it must stay that way until the
    // materialiser is canonical).
    //
    // Harvested from §1's own sweep rather than hand-built, because the generator is CONCURRENT
    // AUTHORSHIP — the two Macs learning one entity's fields in different orders — and not any
    // single mutator. `sync/personal.js` re-sorts every page by `seq` before opening it, so a
    // reordering relay alone cannot produce it.
    assert.ok(HONEST.length === SEEDS.length, '§1 must have run first — it fills HONEST');
    const orderOnly = HONEST.filter((r) => r.content && !r.bytes);
    assert.ok(orderOnly.length > 0,
      'THIS ROW IS THE FINDING. If it goes green — every converged run is byte-identical — the '
      + 'materialiser has been made canonical and this test should be inverted, not deleted. '
      + `Measured over ${SEEDS.length} seeds.`);
    for (const r of orderOnly) {
      assert.equal(r.cells, 0,
        `seed ${r.seed}: the registers agree exactly, so this is a SERIALISATION difference and `
        + 'not a merge one');
      assert.match(r.detail, /disagree on:/);
    }
    assert.ok(orderOnly.length <= SEEDS.length,
      `byte-different-but-content-identical seeds: ${JSON.stringify(orderOnly.map((r) => r.seed))}`);
  });
});
