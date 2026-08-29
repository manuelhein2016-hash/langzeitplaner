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
  // ── HOW MANY REFUSALS THE RUN REACHED, WHICH IS NOT HOW MANY IT ENDED WITH ─────────────────
  //
  // `sync.diagnostics().opsQuarantined` is the engine's own cumulative counter and it dies with
  // the process, so a relaunch is banked before it is lost. This is §2's non-vacuity signal since
  // round 9: a refusal that was later CURED is retracted from both the session map and the durable
  // ledger (R8-4), and it must be, so the end state can no longer prove the tamperer ever fired.
  /** @type {Map<Object, number>} refusals counted in that device's FINISHED sessions */
  const banked = new Map();
  const live = (dev) => dev.diagnostics().opsQuarantined || 0;
  const bank = (dev) => banked.set(dev, (banked.get(dev) || 0) + live(dev));

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
      case 'quit': bank(d); await d.relaunch(); break;
      case 'compact': d.store._tailOverBytes = true; await d.persist(); break;
      case 'mutate-on':
        f.wire.hostile.onResponse = chainMutators(MUTATORS.shuffleOps(seed + i), MUTATORS.duplicateOps());
        break;
      // THE QUARANTINE EVENT. One flipped ciphertext byte per page: AES-GCM refuses it, `pullNow`
      // quarantines that op and releases the cursor past it (ADR 003 §8.2), and the op is gone
      // from whichever Mac was reading. It is stacked ON TOP of the reorder/duplicate mutators
      // rather than replacing them, so the alphabet only ever grows.
      case 'tamper-on':
        f.wire.hostile.onResponse = chainMutators(
          MUTATORS.shuffleOps(seed + i), MUTATORS.duplicateOps(), MUTATORS.tamperCiphertext(i));
        break;
      case 'tamper-off':
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
    // Every refusal this run REACHED, cured or not. See `banked` above.
    refusalsReached: [A, B].reduce((n, dev) => n + (banked.get(dev) || 0) + live(dev), 0),
    logQuarantine: [A, B].map((d) => d.storeDiagnostics().quarantine?.reason ?? null).filter(Boolean),
    outbox: A.outboxSize() + B.outboxSize(),
    status: [A.status().state, B.status().state],
    // 19.3's promise as a boolean, from `sync/status.js`'s own fold: TRUE only when the state is
    // healthy AND the enumerated domain of observables is empty AND every row of it could be
    // answered. A divergent run in which BOTH Macs are `silent` is the failure the whole round is
    // about, and it is the one thing §2's second row forbids.
    silent: A.status().silent === true && B.status().silent === true,
    diag: [A.storeDiagnostics().sync, B.storeDiagnostics().sync]
      .map((d) => ({ parked: d.parked, refused: d.refused, lost: d.lost, chain: !!d.chain, outbox: d.outbox })),
  };
}

const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);

/**
 * THE HEADLINE SWEEP. 128 seeds, because the property this file exists to state was found to be
 * FALSE at 2 of 24 after the first fix landed — a rate a 24-seed sweep would report as "it works"
 * on most runs. The alphabet is not narrowed to make it pass: it is the widest one in the file.
 */
const WIDE_SEEDS = Array.from({ length: 128 }, (_, i) => i + 1);

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

// INVERTED, NOT REPAIRED, and this row named its own trigger: "If it ever goes green — no seed
// diverges — `store._outboxHorizonCap()` has been fixed and this test should be inverted, not
// deleted." Two fixes were needed and the second was only visible once the first had landed:
//
//   E5-2  `_outboxHorizonCap()` stood its cap down when `cap === null`, which is not a rare state
//         — it is the state EVERY compaction leaves behind. Returning `undefined` there is not
//         standing down, it is imposing NO cap and folding the unacknowledged line for real.
//   L-4   `core/oplog.js` `load()` fed each tail line the `seq` its BYTES carry, and a tail line
//         is written before any ack exists, so it always reads `null`. The durable ack rides in
//         `checkpoint().seqs`. An acknowledged op therefore came back looking unacknowledged, the
//         outbox floor sank below the persisted horizon, and the cap was pushed into E5-2's one
//         genuinely unrecoverable arm. With only the first fix in place this sweep still lost an
//         op on seeds 3 and 10 of 24 — which is how L-4 was found.
//
// The alphabet is UNCHANGED and is still the widest in the file. Nothing was narrowed to make it
// pass; §1's honest sweep is the control that says so.
describe('§2 · CLOSED (E5-2, L-4) · the same schedules with `compact` in the alphabet', () => {
  test('128 seeds × 30 steps: content converges, the registers agree, nothing is lost', async () => {
    const events = [...EDITS, ...LIFE, 'compact'];
    const rows = [];
    for (const seed of WIDE_SEEDS) rows.push(await run(seed, events));

    // NON-VACUITY FIRST. A sweep in which the two Macs never exchanged anything would satisfy
    // every line below, and so would one in which `compact` never fired.
    const built = rows.filter((r) => r.entries > 1).length;
    assert.ok(built >= WIDE_SEEDS.length / 2,
      `only ${built}/${WIDE_SEEDS.length} seeds ended with more than the starting entry — vacuous`);
    const compacted = rows.filter((r) => r.log.some((e) => e.endsWith(':compact'))).length;
    assert.ok(compacted >= WIDE_SEEDS.length * 0.9,
      `only ${compacted}/${WIDE_SEEDS.length} scripts contained a compaction — the alphabet is not armed`);

    const bad = rows.filter((r) => !r.content || r.cells || !r.stable || r.lost.length || r.extra.length);
    assert.deepEqual(
      bad.map((r) => ({
        seed: r.seed, content: r.content, cells: r.cells, stable: r.stable,
        lost: r.lost, extra: r.extra, e52: r.e52, outbox: r.outbox, status: r.status,
        script: r.log.join(' '),
      })),
      [],
      'THE PROPERTY: for every op set and every interleaving of partition, reorder, duplication, '
      + 'COMPACTION, restart and a hostile relay, the two Macs converge — on content, on the '
      + 'register digests cell by cell, stably, with nothing the script performed missing from '
      + 'either board and nothing on either board the script never performed.',
    );

    // AND THE UNRECOVERABLE ARM IS NEVER REACHED. `_e52Warned` is set only when the persisted
    // horizon ALREADY folds an unacknowledged op — a file written before the cap existed. No run
    // of this build may produce one, and a run that does is the finding coming back.
    const stoodDown = rows.filter((r) => r.e52).map((r) => r.seed);
    assert.deepEqual(stoodDown, [],
      `seeds ${JSON.stringify(stoodDown)} stood the outbox cap down; this build must never write a `
      + 'checkpoint that folds past its own outbox floor');
  });

  test('CLOSED (R8-4) · a QUARANTINE in the alphabet is CURABLE — and never costs data silently', async () => {
    // ═══════════════════════════════════════════════════════════════════════════════════════════
    // THE SIXTH EVENT, AND THE ONE THE PROPERTY ABOVE CANNOT SIMPLY ABSORB.
    //
    // `tamper` flips a ciphertext byte, so AES-GCM refuses the op and `pullNow` quarantines it.
    // That refusal is CORRECT — the bytes are what they are — and ADR 003 §8.2 releases the cursor
    // past it, so the op is genuinely gone from the victim. Asserting convergence here would be
    // asserting that a forged envelope is applied, which is the opposite of what 21.1 promises.
    //
    // So the property that must hold over this alphabet is the one that makes E6's bar meaningful:
    // **either the two Macs converge, or the Mac that lost something SAYS SO, durably.** A run may
    // not end divergent and quiet. That is what "provably not losing ops" means once an adversary
    // is allowed to destroy one: not "nothing is ever lost", but "nothing is ever lost in silence".
    // ═══════════════════════════════════════════════════════════════════════════════════════════
    const events = [...EDITS, ...LIFE, 'compact', 'tamper-on', 'tamper-off'];
    const rows = [];
    for (const seed of WIDE_SEEDS) rows.push(await run(seed, events));

    const armed = rows.filter((r) => r.log.some((e) => e.endsWith(':tamper-on'))).length;
    assert.ok(armed >= WIDE_SEEDS.length * 0.9,
      `only ${armed}/${WIDE_SEEDS.length} scripts armed the tamperer — the alphabet is not armed`);
    // ── NON-VACUITY, RE-BASED BY THE ROUND-9 INTEGRATION PASS ────────────────────────────────
    //
    // This used to read `rows.filter((r) => r.quarantined.length > 0).length > 0` — the refusals
    // still STANDING at the end of the run — and it went red the moment R8-4's retraction landed.
    // Measured over these same 128 seeds, before and after, with nothing else changed:
    //
    //     before:  quarantined-at-end 14 · durable ledger 17 · DIVERGED 0 · lost 0
    //     after:   quarantined-at-end  0 · durable ledger  0 · DIVERGED 0 · lost 0
    //
    // Read that carefully, because it says something about the OLD build and not about the new
    // one: every single one of those 17 durable refusals was about an op that had in fact
    // ARRIVED. The tamperer flips one ciphertext byte per page; the op is refused, and a later
    // page or a relaunch re-serves the same op untampered and it applies. Nothing was ever lost —
    // `lost` is empty on both sides of the change — so the row's own title was overstated and its
    // non-vacuity control was being satisfied by a stale record rather than by a real loss.
    //
    // So the honest signal is that a refusal was REACHED, not that one is still standing, and
    // `refusalsReached` counts them across relaunches. The property below is untouched and is the
    // one that matters: a run may not end divergent and quiet.
    const refused = rows.filter((r) => r.refusalsReached > 0).length;
    assert.ok(refused > 0,
      'no run reached a refusal at all, so this row is measuring the same thing as the one above');
    // And the cure is not the absence of the disease: a refusal that is retracted was retracted
    // because the op APPLIED, so those runs must be the converged ones.
    for (const r of rows.filter((x) => x.refusalsReached > 0 && x.quarantined.length === 0)) {
      assert.equal(r.content, true,
        `seed ${r.seed}: a refusal was withdrawn on a run that did NOT converge — the retraction `
        + 'must only ever follow the op actually landing (R8-4), never hide a divergence');
      assert.deepEqual(r.lost, [], `seed ${r.seed}: likewise, nothing the script performed is missing`);
    }

    const silent = rows.filter((r) => !r.content && r.silent);
    assert.deepEqual(
      silent.map((r) => ({ seed: r.seed, status: r.status, diag: r.diag, script: r.log.join(' ') })),
      [],
      'A RUN ENDED WITH THE TWO MACS DISAGREEING AND `silent: true` ON BOTH. Story 19.3 promises '
      + 'that quiet MEANS there is nothing to tell you; a divergence nobody can report makes that '
      + 'promise false, and it is the whole of findings L-1, L-2, E5-2 and P-4.',
    );

    // And the converse control, so "report everything for ever" cannot pass: a run that DID
    // converge must be allowed to be silent, and most of them must be.
    const quiet = rows.filter((r) => r.content && r.silent).length;
    assert.ok(quiet >= 1,
      'not one converged run was silent — a build that reports a fault whenever it has anything '
      + 'to say breaks 19.3 in the other direction, which is what this control is for');
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
