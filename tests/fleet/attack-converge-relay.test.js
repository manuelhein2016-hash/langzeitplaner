// FLEET · THE CONVERGENCE ADVERSARY — THE LYING RELAY.
// ADR 002 §5.4 · ADR 003 §3.1, §3.3 · `src/js/sync/chain.js` · Risk R2.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE QUESTION: WHICH LIES DOES THE CHAIN WITNESS CATCH, AND WHICH ARE INVISIBLE?
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// When this file was written the answer was a fact about the IMPORT GRAPH rather than about
// cryptography: `src/js/sync/chain.js` was not on the M1 path at all. `createChainWitness` had
// exactly one importer in the tree — `src/js/sync/client.js`, LZP-501's superseded engine — and
// `createSyncClient` had no importer at all, so every check ADR 002 §5.4 describes was written,
// tested in tier 1, and wired to nothing the product ran. That was finding P-4, and §4 pinned it
// as an import-graph fact so it could not rot into a belief.
//
// **IT IS ON THE PATH NOW.** `sync/personal.js` imports `verifyChain` and `pullNow` runs two
// checks over every page:
//
//   1. THE WITNESS — `verifyChain(rows, anchor)`, anchored on the last head this device verified
//      (durable, in `sync/cursor.js` behind the `chainStore` port). Catches a hole INSIDE a page,
//      a re-ordering, a fabricated `chain`, and a stream re-chained across a relaunch.
//   2. THE PAGE CLAIM — `server/core/handlers/ops.js` states that "`nextCursor` is the seq of the
//      last op ACTUALLY RETURNED, and when the page is empty it is `since`". A `nextCursor` past
//      the last row served is the relay asking this device to step over rows it never sent, which
//      is the withhold that leaves no hole to find because the hole is at the END of the page.
//
// Neither check refuses an op. ADR 002 §8.6 and ADR 003 §10.6 keep the witness DIAGNOSTIC-ONLY in
// v2 and that is respected: the rows that arrived are authentic and are applied. What the finding
// changes is the CURSOR — the first missing seq becomes a hold — and the indicator.
//
// So the four lies now separate like this:
//
//   | lie                    | outcome | why |
//   |---|---|---|
//   | REORDER                | harmless | the merge is a per-cell stamp join (`registers.cmpWrites`), so arrival order decides nothing. `pullNow` also re-sorts the page by `seq`, but that is belt: removing the sort in a scratch tree does NOT redden §1, while making the join order-dependent reddens four of its rows. §1 |
//   | REPLAY / DUPLICATE     | harmless | idempotent by `opId` (ADR 001 §6). §1 |
//   | STALE / REWOUND CURSOR | harmless | the client bounds its own pull loop and loses nothing. §1 |
//   | **WITHHOLD**           | **A DELAY, REPORTED** — the cursor never moves over an op this device was not handed, so the relay still owes it and an honest page delivers it. §2, §3 |
//
// §2 is the one-sided withhold (the ADR's own "Mama cancelled the appointment" example); §3 is
// the two-sided one, which is the fork ADR 002 §5.4 names; §4 is the import-graph fact, inverted;
// §5 is the ANCHOR — what the witness remembers across a quit, and the rule that a MISSING anchor
// re-anchors rather than accusing an honest relay.

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

// INVERTED, NOT REPAIRED, and this row named its own trigger: "If this row ever reads 'Zahnarzt
// ABGESAGT', the client has learned to notice a cursor that outruns its page and this test should
// be inverted."
//
// It has. `sync/personal.js`'s `pullNow` now imports `sync/chain.js` — P-4's sharp half — and runs
// TWO checks over every page:
//
//   1. `verifyChain(rows, anchor)` — ADR 002 §5.4's witness. Catches a hole INSIDE a page, a
//      re-ordering, and a fabricated `chain` value.
//   2. THE PAGE CLAIM. `server/core/handlers/ops.js` says in its own words that "`nextCursor` is
//      the seq of the last op ACTUALLY RETURNED, and when the page is empty it is `since`". A
//      `nextCursor` past the last row served is the relay asking this device to step over rows it
//      never sent — the withhold that leaves no hole to find, because the hole is at the END of
//      the page. That is exactly the mechanism this row measured, and it is the only one of the
//      two that can cause a LOSS, so it is the only one that touches the cursor.
//
// Neither check refuses the ops that DID arrive: they are individually authenticated, and refusing
// them would let a hostile relay wedge the device with one bad `chain` byte. What the finding does
// is stop the cursor — so the relay keeps owing the op — and light `error`.
describe('§2 · CLOSED (P-4) · a withhold is now a DELAY: the cursor is held and the ops come back', () => {
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
    assert.equal(B.state.notes[0].text, 'Zahnarzt 14:30',
      'the laptop still shows the old time WHILE THE RELAY IS LYING — that part is unchanged, and '
      + 'no client-side check can conjure bytes it was not sent');
    assert.equal(B.status().state, 'error',
      'AND IT SAYS SO. `sync/chain.js` is on the path now; reverting either the import or the '
      + 'page-claim check turns this back to `healthy` (finding P-4).');
    assert.ok(B.storeDiagnostics().sync.chain,
      'and the store can name it: `diagnostics().sync.chain` carries the witness\'s finding');
    assert.equal(B.storeDiagnostics().sync.chain.kind, 'withheld',
      'by the kind the mechanism actually is — a cursor claim past the last row served');
    assert.ok(B.warnings().some((w) => /does not add up/.test(w)),
      'in a sentence, once, not once a pull');
    assert.notEqual(B.cursor(), A.cursor(),
      'THE MECHANISM, INVERTED: `pullNow` takes `nextCursor` only while the relay\'s claim about '
      + 'the page is sound, so B\'s cursor stops BELOW the withheld op and the relay still owes it.');

    // The relay stops lying, and the ops arrive. A withhold is a DELAY again.
    f.wire.honest();
    await f.settle();
    await f.settle();
    await B.catchUp(8);
    assert.equal(B.state.notes[0].text, 'Zahnarzt ABGESAGT',
      'an honest relay DOES undo it: the withhold was never a consumption, because the cursor was '
      + 'never moved over an op this device had not been handed');
    assert.equal(boardsAgree([A, B]).equal, true, boardsAgree([A, B]).detail);
    assert.deepEqual([A.status().state, B.status().state], ['healthy', 'healthy'],
      'and the verdict CLEARS on positive evidence — a page that verifies — so a fork that healed '
      + 'does not light the indicator for ever');
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

describe('§3 · CLOSED (P-4) · a two-sided withhold is ADR 002 §5.4\'s fork, and BOTH Macs see it', () => {
  test('each Mac is self-consistent, both report `error`, and neither cursor moved over the fork', async () => {
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
    assert.deepEqual([A.status().state, B.status().state], ['error', 'error'],
      'THE FORK IS NO LONGER SILENT. ADR 002 §5.4 names chain-witness verification as the one '
      + 'mechanism for detecting this, and `pullNow` runs it now. Reverting the wiring turns both '
      + 'of these back to `healthy` (finding P-4).');
    assert.ok(A.warnings().some((w) => /does not add up/.test(w))
      && B.warnings().some((w) => /does not add up/.test(w)),
    'and BOTH Macs have something to say — the fork is reported on both sides of it');

    f.wire.honest();
    await f.settle();
    await f.settle();
    await A.catchUp(8);
    await B.catchUp(8);
    assert.deepEqual(A.state.notes.map((n) => n.id).sort(), ['ax', 'bx', 'n1'],
      'AND IT HEALS the moment the relay stops: neither cursor was ever moved over an op the '
      + 'device had not been handed, so nothing was consumed and both halves are still owed');
    assert.deepEqual(B.state.notes.map((n) => n.id).sort(), ['ax', 'bx', 'n1']);
    assert.equal(boardsAgree([A, B]).equal, true, boardsAgree([A, B]).detail);
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

describe('§4 · CLOSED (P-4) · `sync/chain.js` is on the path the product actually runs', () => {
  test('the import graph, not an opinion: the engine reaches the chain witness', () => {
    // `reachableFrom` follows STATIC and DYNAMIC edges alike, so this is the strongest form of
    // the claim in both directions: it was not "lazily loaded", there was no edge at all — and
    // now the edge is a STATIC import in the one file the design ever named as its call site.
    const from = (entry) => new Set(reachableFrom(entry).reached);

    const engine = from('src/js/family/engine.js');
    assert.equal(engine.has('src/js/sync/personal.js'), true,
      "the product's engine is `personal.js` — the control that makes the next line mean something");
    assert.equal(engine.has('src/js/sync/chain.js'), true,
      'and it reaches the chain witness. If this goes false again, §2 and §3 above go silent with '
      + 'it, because ADR 002 §5.4 names no other mechanism (finding P-4).');
    assert.deepEqual(pathToPrefix('src/js/sync/personal.js', 'src/js/sync/chain.js'),
      ['src/js/sync/personal.js', 'src/js/sync/chain.js'],
      'by a DIRECT import from `pullNow`\'s own module — not through a fourth file');

    assert.equal(from('src/js/family/mount.js').has('src/js/sync/chain.js'), true,
      'and from the one door `main.js` opens into family mode');
    assert.equal(from('src/js/main.js').has('src/js/sync/chain.js'), true);

    // THE HALF THAT MUST NOT BE READ AS "SO DELETE THE ROW". ADR 003 §7 gate 2 requires the sync
    // modules to sit behind exactly ONE dynamic door, so a solo LAUNCH evaluates none of them.
    // `reachableFrom` deliberately follows dynamic edges (a walk that ignored them would report
    // the design as a defect), so `boot.js` reaches this too — through `main.js`'s single
    // `await import()` of `family/mount.js`, and through nothing else. That is the property, and
    // it is stated as a path rather than as an absence:
    assert.deepEqual(pathToPrefix('src/js/boot.js', 'src/js/sync/chain.js'),
      ['src/js/boot.js', 'src/js/main.js', 'src/js/family/mount.js', 'src/js/family/engine.js',
        'src/js/sync/personal.js', 'src/js/sync/chain.js'],
      'the ONLY route is through the family door — `tests/attack/privacy-e5-silence.test.js` is '
      + 'where the door itself is pinned as dynamic and single');

    // The old importer, `client.js`, is LZP-501's superseded engine and is now deleted; nothing
    // reaches it because it no longer exists. `sync-domains.js` S5 carries that as data.
    assert.equal(from('src/js/family/engine.js').has('src/js/sync/client.js'), false,
      'and the dead engine is not back');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5. THE ANCHOR — WHAT THE WITNESS REMEMBERS ACROSS A QUIT
//
// `verifyChain` verifies a RUN against a known point. Where that point comes from decides what a
// relaunch costs, and the two rows below are the two halves of getting it right. They exist
// because a mutation pass found both of them unpinned: removing the durable anchor, and removing
// the rule that a MISSING anchor may not be treated as genesis, each killed no test at all.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§5 · the chain anchor is durable, and a missing one accuses nobody', () => {
  test('a relay that forks the stream ACROSS a relaunch is caught on the first page after it', async () => {
    // WITHOUT a durable anchor this is the relay's free move: quit, and the first page of the new
    // session is adopted as the truth, whatever it says. `sync/cursor.js` keeps the verified head
    // beside the sync position — its own header's argument for why the two belong together — so
    // the first page after the quit is checked against what the LAST session verified.
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    await A.apply('editNotePopover', { id: 'n1', text: 'vor dem Neustart' });
    await f.settle();
    assert.equal(B.state.notes[0].text, 'vor dem Neustart', 'B verified a page and stored its head');
    assert.equal(B.status().state, 'healthy', 'and has nothing to report');

    await B.relaunch();

    // The relay now re-chains the stream: every `chain` value is replaced. Nothing else changes —
    // the envelopes are the same authentic bytes, so no signature and no AEAD tag can see this.
    f.wire.hostile.onResponse = MUTATORS.rewriteChain((o, i) => b64uOfIndex(i));
    await A.apply('editNotePopover', { id: 'n1', text: 'nach dem Neustart' });
    await f.settle();
    await f.settle();

    assert.equal(B.status().state, 'error',
      'THE FORK IS CAUGHT. Reverting the `chainAnchor = cursors.head(spaceId)` line in '
      + '`loadLot()` makes this `healthy`: the first row of the first page is adopted as the '
      + 'anchor and the re-chained stream becomes the new truth (finding P-4).');
    assert.ok(B.storeDiagnostics().sync.chain, 'and the store can name it');
    f.wire.honest();
  });

  test('a MISSING anchor re-anchors rather than accusing — an honest relay is never blamed', async () => {
    // THE OTHER HALF, and the reason the row above cannot be closed by "verify from genesis
    // always". `verifyChain(rows, null)` computes `SHA-256(∅ ‖ oid)` for the first row, which is
    // right for a device pulling from `since = 0` and WRONG for every other page — a device
    // resuming at seq 40 is handed a chain over rows it never saw. `chain.js`'s own answer to an
    // anchor it cannot use is "re-anchor on the next row rather than reporting a fork this device
    // cannot prove", and this is that rule one layer up.
    //
    // Reached by nothing exotic: a device upgrading from a build with no anchor store, or one
    // whose anchor write failed (`cursor.js` reports that and keeps going, deliberately).
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    await A.apply('editNotePopover', { id: 'n1', text: 'erste Seite' });
    await f.settle();
    assert.notEqual(B.cursor(), '0', 'B is resuming mid-stream, which is the whole point');

    await B.close();
    B.disk.removeItem('langzeitplaner.chainheads');       // the upgrade, or the failed write
    await B.open();

    await A.apply('editNotePopover', { id: 'n1', text: 'zweite Seite' });
    await f.settle();
    await f.settle();

    assert.equal(B.state.notes[0].text, 'zweite Seite', 'the page is applied …');
    assert.equal(B.status().state, 'healthy',
      '… and NOBODY IS ACCUSED. Removing the re-anchor branch in `pullNow` makes this `error` on '
      + 'a perfectly honest relay, on the first pull after every such launch — a defence that '
      + 'cries wolf is a defence that gets turned off.');
    assert.equal(B.storeDiagnostics().sync.chain, null);
  });
});

/** A syntactically valid, wrong, base64url chain value — 32 bytes, distinct per row. */
function b64uOfIndex(i) {
  const b = new Uint8Array(32);
  b[0] = (i + 1) & 0xff;
  return Buffer.from(b).toString('base64url');
}
