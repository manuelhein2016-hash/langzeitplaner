// FLEET · THE CONVERGENCE ADVERSARY — THE LYING RELAY.
// ADR 002 §5.4 · ADR 003 §3.1, §3.3 · `src/js/sync/chain.js` · Risk R2.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE QUESTION: WHICH LIES DOES THE CHAIN WITNESS CATCH, AND WHICH ARE INVISIBLE?
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The answer at M1 is shorter than the design implies, and it is a fact about the IMPORT GRAPH
// rather than about cryptography:
//
//     `src/js/sync/chain.js` IS NOT ON THE M1 PATH.
//
// `createChainWitness` has exactly one importer in the whole tree, `src/js/sync/client.js`, and
// `createSyncClient` has NO importer at all — `src/js/family/engine.js` builds
// `createPersonalSync` from `src/js/sync/personal.js`, and `personal.js` mentions the chain only
// to explain why it seals `wit: ''`. So every check ADR 002 §5.4 describes — recompute, and the
// witness cross-check that is "the half a relay lying consistently to one device cannot escape" —
// is written, tested in tier 1, and **not wired to anything the product runs.** §4 pins that as an
// import-graph fact so it cannot rot into a belief.
//
// With the witness out of the path, the four lies separate like this:
//
//   | lie                    | outcome | why |
//   |---|---|---|
//   | REORDER                | harmless | the merge is a per-cell stamp join (`registers.cmpWrites`), so arrival order decides nothing. `pullNow` also re-sorts the page by `seq`, but that is belt: removing the sort in a scratch tree does NOT redden §1, while making the join order-dependent reddens four of its rows. §1 |
//   | REPLAY / DUPLICATE     | harmless | idempotent by `opId` (ADR 001 §6). §1 |
//   | STALE / REWOUND CURSOR | harmless | the client bounds its own pull loop and loses nothing. §1 |
//   | **WITHHOLD**           | **PERMANENT, SILENT, AND IT SURVIVES THE RELAY BECOMING HONEST AGAIN** | §2, §3 |
//
// The withhold is the interesting one and it is worse than "not detected". `pullNow` ends with
//
//     if (floor === null && nextCursor !== null && nextCursor > commit) commit = nextCursor;
//
// — i.e. the client advances to the cursor the relay hands it **whether or not the page that came
// with it contained anything**. So a relay that answers `{ops: [], nextCursor: 42}` does not delay
// those ops, it CONSUMES them: the `since` filter will never offer them again, and the fork
// outlives the attack. §2 shows it one-sided (the ADR's own "Mama cancelled the appointment"
// example); §3 shows it two-sided, which is the fork ADR 002 §5.4 names, and shows that healing
// the relay does not heal the boards.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createFleet, boardsAgree, MUTATORS, chainMutators, simClock } from '../helpers/fleet.js';
import { reachableFrom, pathToPrefix } from '../helpers/importgraph.js';

const BOARD = () => ({
  schemaVersion: 1,
  notes: [{ id: 'n1', date: '2027-03-04', text: 'Zahnarzt 14:30', categoryId: 'c1', repeatsYearly: false }],
  bars: [],
  categories: [{ id: 'c1', name: 'Familie', paletteRef: 'gruen', visible: true }],
  scratchpads: {},
  settings: null,
});

const twoMacs = (over = {}) => createFleet({
  board: BOARD(), devices: ['A', 'B'], clock: simClock(Date.UTC(2026, 11, 10, 9, 0, 0)), ...over,
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. THE THREE THAT COST LATENCY AND NOTHING ELSE
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · SUCCEEDED · reorder, replay and a rewound cursor are latency, not divergence', () => {
  test('a page served backwards is re-sorted by the client before it is opened', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    B.offline();
    await A.apply('createNotePopover', { id: 'k', date: '2027-06-06', text: 'erst', categoryId: 'c1' });
    await A.apply('editNotePopover', { id: 'k', text: 'dann' });
    await A.push();

    B.online();
    f.wire.hostile.onResponse = MUTATORS.reverseOps();
    await B.catchUp();
    f.wire.honest();
    assert.equal(B.state.notes.find((n) => n.id === 'k').text, 'dann',
      'the later edit still wins — ADR 003 §3.3: `seq` is not a merge input. MUTATION-CHECKED: '
      + 'this row survives deleting `pullNow`\'s own `work.sort(...)`, so what defends it is the '
      + 'per-cell stamp join and not the sort; making `registers.cmpWrites` order-dependent '
      + 'reddens it.');
    await f.settle();
    assert.equal(boardsAgree([A, B]).equal, true, boardsAgree([A, B]).detail);
  });

  test('a relay that re-serves the whole log from seq 0 for ever changes nothing', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    await A.apply('editNotePopover', { id: 'n1', text: 'erste Fassung' });
    await f.settle();
    await A.apply('editNotePopover', { id: 'n1', text: 'zweite Fassung' });
    await f.settle();
    const linesBefore = B.logOps({ includeParked: true }).length;

    const whole = await B.run(() => B.transport.request(
      'GET', '/api/v1/ops', { space: f.spaceId, since: '0', limit: '500' }, null, {},
    ));
    f.wire.hostile.onResponse = (res, req, who) => (
      who === B.short && req.method === 'GET' && req.path === '/api/v1/ops' && res.status === 200
        ? { ...res, body: { ...whole.json, nextCursor: res.body.nextCursor, hasMore: false } }
        : res);
    await B.pull();
    await B.pull();
    await B.pull();
    f.wire.honest();

    assert.equal(B.state.notes[0].text, 'zweite Fassung', 'the replay applied nothing new');
    assert.equal(B.logOps({ includeParked: true }).length, linesBefore, 'and doubled no line');
    assert.deepEqual(B.quarantined(), []);
    await f.settle();
    assert.equal(boardsAgree([A, B]).equal, true, boardsAgree([A, B]).detail);
  });

  test('a cursor rewound to `since` on every answer terminates and loses nothing', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    await A.apply('createNotePopover', { id: 'r', date: '2027-06-06', text: 'r', categoryId: 'c1' });
    await A.push();

    f.wire.hostile.onResponse = MUTATORS.rewindCursor();
    const r = await B.sync();
    f.wire.honest();
    assert.deepEqual(r, { ok: true }, 'the client bounds its own loop; the adversary need not');
    assert.equal(B.state.notes.some((n) => n.id === 'r'), true, 'and the ops were applied');
    await f.settle();
    assert.equal(boardsAgree([A, B]).equal, true, boardsAgree([A, B]).detail);
  });

  test('shuffled AND doubled AND paged, together, still converge', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    f.wire.hostile.onResponse = chainMutators(MUTATORS.shuffleOps(7), MUTATORS.duplicateOps());
    for (let i = 0; i < 6; i++) {
      await (i % 2 ? B : A).apply('createNotePopover', {
        id: `m${i}`, date: '2027-07-07', text: `m${i}`, categoryId: 'c1',
      });
      await f.settle();
    }
    f.wire.honest();
    await f.settle();
    assert.equal(A.state.notes.length, 7);
    assert.equal(boardsAgree([A, B]).equal, true, boardsAgree([A, B]).detail);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. THE WITHHOLD — ONE-SIDED, PERMANENT, AND ANNOUNCED AS `healthy`
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · FAILED · a relay that withholds from ONE Mac takes those ops permanently', () => {
  test('"it serves Mac B every op except the one where Mama cancelled the appointment"', async () => {
    // The sentence is `src/js/sync/chain.js`'s own, from the header of the module that exists to
    // catch this and is not on this path.
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();

    f.wire.hostile.onResponse = (res, req, who) => (who === B.short
      ? MUTATORS.withholdOps((o) => o.dv === A.short)(res, req, who)
      : res);
    await A.apply('editNotePopover', { id: 'n1', text: 'Zahnarzt ABGESAGT' });
    await f.settle();
    await f.settle();

    assert.equal(A.state.notes[0].text, 'Zahnarzt ABGESAGT');
    assert.equal(B.state.notes[0].text, 'Zahnarzt 14:30', 'the laptop still shows the old time');
    assert.equal(B.status().state, 'healthy', 'and reports itself in sync');
    assert.deepEqual(B.warnings(), [], 'with no warning of any kind');
    assert.equal(B.cursor(), A.cursor(),
      'THE MECHANISM: `pullNow` takes `nextCursor` from the relay even when the page it came with '
      + 'was emptied, so B\'s cursor is level with A\'s and the `since` filter will never offer '
      + 'those ops again');

    // The relay stops lying. Nothing is repaired.
    f.wire.honest();
    await f.settle();
    await f.settle();
    await B.catchUp(8);
    assert.equal(B.state.notes[0].text, 'Zahnarzt 14:30',
      'THE FINDING: an honest relay does not undo it. The withhold is not a delay, it is a '
      + 'consumption. If this row ever reads "Zahnarzt ABGESAGT", the client has learned to notice '
      + 'a cursor that outruns its page and this test should be inverted.');
    assert.equal(boardsAgree([A, B]).equal, false);
    assert.deepEqual([A.status().state, B.status().state], ['healthy', 'healthy']);
  });

  test('SUCCEEDED (control) · a relay that DELAYS instead of withholding costs nothing', async () => {
    // THE MUTATION CHECK. The same ops, hidden from the same Mac by the same predicate, except
    // that the relay withholds the CURSOR with them — i.e. it delays rather than consumes. The
    // client then loses nothing at all, which is what makes §2 a statement about the cursor and
    // not about withholding.
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    f.wire.hostile.onResponse = (res, req, who) => {
      if (who !== B.short || req.method !== 'GET' || req.path !== '/api/v1/ops' || res.status !== 200) return res;
      return { ...res, body: { ...res.body, ops: [], nextCursor: (req.query && req.query.since) || '0', hasMore: false } };
    };
    await A.apply('editNotePopover', { id: 'n1', text: 'Zahnarzt ABGESAGT' });
    await f.settle();
    assert.equal(B.state.notes[0].text, 'Zahnarzt 14:30', 'delayed, as the adversary intends');
    f.wire.honest();
    await f.settle();
    assert.equal(B.state.notes[0].text, 'Zahnarzt ABGESAGT', 'and delivered the moment it stops');
    assert.equal(boardsAgree([A, B]).equal, true, boardsAgree([A, B]).detail);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. THE FORK
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · FAILED · a two-sided withhold is ADR 002 §5.4\'s fork, and it is permanent', () => {
  test('each Mac is self-consistent, both are `healthy`, and the family silently has two boards', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();

    f.wire.hostile.onResponse = MUTATORS.withholdOps(() => true);
    await A.apply('createNotePopover', { id: 'ax', date: '2027-05-03', text: 'nur bei A', categoryId: 'c1' });
    await B.apply('createNotePopover', { id: 'bx', date: '2027-05-04', text: 'nur bei B', categoryId: 'c1' });
    await f.settle();
    await f.settle();

    assert.deepEqual(A.state.notes.map((n) => n.id).sort(), ['ax', 'n1']);
    assert.deepEqual(B.state.notes.map((n) => n.id).sort(), ['bx', 'n1']);
    assert.deepEqual([A.status().state, B.status().state], ['healthy', 'healthy']);
    assert.deepEqual([A.warnings(), B.warnings()], [[], []],
      'neither Mac has anything to say — the fork is entirely silent');

    f.wire.honest();
    await f.settle();
    await f.settle();
    await A.catchUp(8);
    await B.catchUp(8);
    assert.deepEqual(A.state.notes.map((n) => n.id).sort(), ['ax', 'n1'],
      'and it survives the relay becoming honest');
    assert.deepEqual(B.state.notes.map((n) => n.id).sort(), ['bx', 'n1']);
    assert.equal(boardsAgree([A, B]).equal, false);
  });

  test('SUCCEEDED · the relay still cannot READ, FORGE or RE-ATTRIBUTE — only omit', async () => {
    // The blindness half, kept beside the omission half so the report is not read as "the crypto
    // failed". Every AAD-bound field is checked, so the only power the relay has is the one §2/§3
    // measure.
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    await A.apply('editNotePopover', { id: 'n1', text: 'Blutdruck-Check Praxis Sonnenberg' });
    await A.push();

    const bytes = JSON.stringify(f.wire.seenBodies);
    for (const secret of ['Blutdruck', 'Sonnenberg', 'note.set', '2027-03-04', 'Zahnarzt']) {
      assert.equal(bytes.includes(secret), false, `the relay must not hold ${secret} in plaintext`);
    }

    f.wire.hostile.onResponse = MUTATORS.reattribute(B.short);
    await B.pull();
    f.wire.honest();
    assert.equal(B.state.notes[0].text, 'Zahnarzt 14:30', 're-attribution fails closed');
    assert.equal(B.quarantined().length, 1, 'and costs exactly that op, never the batch');
    assert.match(B.quarantined()[0].reason, /openOp: P3 failed/,
      'and it fails at the named check, BEFORE the decrypt');

    // MUTATION NOTE, recorded because a single-layer mutant does NOT redden the outcome here and
    // that is worth knowing rather than hiding: dropping `dv` from the AAD leaves check 4
    // (`devOf(op.ts) === env.dv`, ADR 002 §5.2.2) to refuse it, and disabling P3 leaves the same
    // check 4. The OUTCOME is defended three deep; only the `P3 failed` assertion above pins the
    // layer, and it reddens under either mutant.
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4. THE REASON — THE WITNESS IS NOT ON THE PATH
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · FAILED · `sync/chain.js` is unreachable from the engine the product runs', () => {
  test('the import graph, not an opinion: nothing the app loads can reach the chain witness', () => {
    // `reachableFrom` follows STATIC and DYNAMIC edges alike, so this is the strongest form of
    // the claim: not "it is lazily loaded", but "there is no edge at all".
    const from = (entry) => new Set(reachableFrom(entry).reached);

    const engine = from('src/js/family/engine.js');
    assert.equal(engine.has('src/js/sync/personal.js'), true,
      "the product's engine is `personal.js` — the control that makes the next line mean something");
    assert.equal(engine.has('src/js/sync/chain.js'), false,
      'THE FINDING: no path from the engine to the chain witness');

    assert.equal(from('src/js/family/mount.js').has('src/js/sync/chain.js'), false,
      'nor from the one door `main.js` opens into family mode');
    assert.equal(from('src/js/main.js').has('src/js/sync/chain.js'), false);
    assert.equal(from('src/js/boot.js').has('src/js/sync/chain.js'), false);

    // …because the only importer of `chain.js` is `client.js`, and nothing imports THAT.
    assert.deepEqual(pathToPrefix('src/js/sync/client.js', 'src/js/sync/chain.js'),
      ['src/js/sync/client.js', 'src/js/sync/chain.js'],
      'one importer, and it is the engine that is never built');
    for (const entry of ['src/js/main.js', 'src/js/boot.js', 'src/js/family/mount.js', 'src/js/family/engine.js']) {
      assert.equal(from(entry).has('src/js/sync/client.js'), false,
        `${entry} does not reach sync/client.js either`);
    }
    // ADR 002 §5.4 says the witness is detection-only and never blocks sync in v2. This is
    // stronger than that, and it is what §2 and §3 are the consequence of: at M1 it never RUNS.
  });
});
