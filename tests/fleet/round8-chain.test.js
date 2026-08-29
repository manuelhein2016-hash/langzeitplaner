// FLEET · ROUND 8 ADVERSARY — THE DETECTOR THAT IS NOW ON THE PRODUCT PATH.
// ADR 002 §5.4 · ADR 003 §3.3, §6.3 · `src/js/sync/chain.js` · `src/js/sync/cursor.js`.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT CHANGED, AND WHY THAT IS THE WHOLE ATTACK SURFACE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Round 8 closed P-4 by wiring ADR 002 §5.4's chain witness into `pullNow`. Three things landed
// together and each of them is new:
//
//   1. `verifyChain(rows, anchor)` runs over every page — the RAW function, not
//      `createChainWitness`, which is the stateful wrapper the same file ships and which owns the
//      dedupe, the `broken` flag, `fromGenesis`, and the member-purge tolerance ADR 003 §6.3
//      needs. That wrapper is still imported by nothing.
//   2. A finding becomes a CURSOR HOLD (`chainHoles` → `holds` → `floor`). ADR 002 §5.4 says the
//      witness is "detection-only, best-effort, and it NEVER BLOCKS SYNC in v2 (a false positive
//      that broke a family's board would be far worse than the attack)". A cursor hold is
//      blocking sync.
//   3. The anchor became DURABLE, through `sync/cursor.js`'s `advance(space, seq, head, …)`.
//
// This file attacks (2) and (3). It contains no hostile relay in §1 and §2: the relay is the
// shipped one, answering honestly, and it was accused anyway.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 AND §2 ARE INVERTED — ROUND 9 (2026-08-29). WHAT CHANGED, IN ONE PARAGRAPH
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `pullNow` now uses `createChainWitness`, which is what item 1 above said it should have used,
// and every symptom §1 and §2 measured was one missing piece of that wrapper:
//
//   · `observe()` drops rows at or below the verified head (`fresh`), so the honest re-serve of a
//     held page is silent instead of being read as `seq jumped from 1 to 1` (§1a);
//   · the record persisted beside the cursor is ONE ROW — `pullNow` looks the chain up BY the
//     commit seq and stores `''` rather than a chain that belongs to a row further along, so a
//     relaunch anchors on something that was true (§1b, §1c);
//   · a break RE-ANCHORS. The hold it places lasts for the pull that found it and is not re-armed,
//     because the witness does not re-report a break it has already folded past. A member removal
//     (ADR 003 §6.3) therefore costs one pull and a diagnostic instead of the space (§2).
//
// The rows below now assert those outcomes. `tests/fleet/attack-converge-relay.test.js` §2/§3 and
// `tests/fleet/fleet-harness.test.js` §2a hold the other side of the trade — a withheld op is
// still not consumed while the relay is lying about the page it served — and they are what make
// "the hold moved" different from "the hold was deleted".
//
// EVERY ROW BELOW ASSERTS A PROPERTY THAT WAS FALSE AT `23af664`. §3 still asserts a DEFECT and
// goes RED when it is fixed — the house rule is unchanged: invert the row, never delete it.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createFleet, createRelay, boardsAgree, MUTATORS, simClock, MINUTE } from '../helpers/fleet.js';

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

const chainHeads = (dev) => JSON.parse(dev.disk.getItem('langzeitplaner.chainheads') || '{}');
const findings = (dev) => (dev.storeDiagnostics().sync.chain?.findings || []);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · CLOSED (R8-1) — THE PERSISTED ANCHOR IS ONE ROW, AND A RE-SERVED PAGE IS NOT A HOLE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// WHAT THE DEFECT WAS. `cursor.js advance(space, seq, head, commit)` writes `{ seq, chain:
// head.chain }`. `seq` was the COMMIT POINT and `head.chain` the chain of the LAST ROW OF THE
// PAGE, and those are the same row only when nothing in the page was held. One parked op — F-6's
// ordinary first contact, a peer's content op overtaking its attestation — was enough: the commit
// stopped below the head, and the record claimed a chain value for a seq that never had it. The
// next launch anchored on it, recomputed `SHA-256(anchor.chain ‖ oid)` against an honest page,
// could not match, and told the user the server's record of their board did not add up. Nothing
// was withheld. Nothing was re-ordered. The two Macs converged.
//
// The same mismatch between two conditions produced the cheaper form, without any quit at all:
// `chainAnchor` advanced whenever a PAGE verified, the CURSOR only when nothing in the page was
// held, so the second pull of a held page was verified against an anchor INSIDE it and reported
// as `seq jumped from 1 to 1` — a hole between a seq and itself.
//
// WHAT IT IS NOW. `pullNow` folds each page through `createChainWitness().observe()`, whose first
// act is to drop every row at or below the head it has already verified, and persists the chain
// of THE COMMITTED ROW beside the cursor — or nothing at all, if it does not hold that row's
// chain. The three rows below are the three shapes of the old defect, asserted in the positive.

describe('§1 · CLOSED · an honest relay is not accused, and the record on disk is one row', () => {
  // ── §1a · TWO PULLS AND ONE HELD OP. THE ROW THAT USED TO GO `error` ON THE SECOND. ─────────
  //
  // `chain.js`'s wrapper is what makes this silent, in the sentence its own header uses:
  //
  //   > ROWS AT OR BELOW THE HEAD ARE ALREADY FOLDED. A client normally never re-pulls below its
  //   > cursor, but a rewound cursor, a crash mid-pull or a re-observation of one page must not
  //   > manufacture a break … `const fresh = s.head ? rows.filter(…cmpSeq…) : rows.slice()`
  //
  // Reverting `pullNow` to the raw `verifyChain` — mutant M-A9 — puts `gap` back on the second
  // pull and this row dies with the round-8 sentence in it.
  test('§1a · a held page re-served is SILENT, however many times it is re-served', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    f.attestations.delete(A.short);          // fleet.js S-1: at M1 this hop has no wire at all
    await A.apply('createNotePopover', { id: 'p1', date: '2027-06-07', text: 'von A', categoryId: 'c1' });
    await A.push();

    const before = B.cursor();
    await B.pull();
    assert.equal(B.cursor(), before, 'the op is parked, so the cursor is held — the designed path');
    assert.equal(B.storeDiagnostics().sync.chain, null, 'and after ONE pull nothing is wrong');
    assert.equal(B.status().state, 'pending');

    for (let i = 0; i < 4; i++) {
      f.clock.advance(MINUTE);
      await B.pull();                        // the relay honestly re-serves what is still owed
      assert.equal(B.storeDiagnostics().sync.chain, null,
        `pull ${i + 2}: the honest re-serve of a held page is not evidence of anything`);
      assert.equal(B.status().state, 'pending',
        `pull ${i + 2}: a hold is work outstanding — pending, and never error`);
      assert.equal(B.cursor(), before, `pull ${i + 2}: and the cursor is still held below the park`);
    }
    assert.equal(B.warnings().join(' ').includes('does not add up'), false,
      'and the user is told nothing, because nothing happened');
    assert.equal(f.wire.hostile.onResponse, null, 'THE RELAY IS THE SHIPPED ONE, ANSWERING HONESTLY');
  });


  // ── §1b · THE DURABLE FORM. THE RECORD ON DISK IS THE ROW THE CURSOR IS ON. ─────────────────
  test('§1b · the persisted anchor pairs the cursor seq with THAT SEQ\'s chain', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();

    // B authors first, so B's own op takes the low seq and the page has a row ABOVE the hold.
    await B.apply('createNotePopover', { id: 'b1', date: '2027-06-06', text: 'von B', categoryId: 'c1' });
    await B.push();
    // A's attestation has not reached B yet. `fleet.js` S-1: at M1 the attestation hop has no
    // wire at all, so this is the DESIGNED state on first contact, not an injected fault.
    const attA = f.attestations.get(A.short);
    f.attestations.delete(A.short);
    await A.apply('createNotePopover', { id: 'a1', date: '2027-06-07', text: 'von A', categoryId: 'c1' });
    await A.push();

    await B.pull();
    const held = await B.heldEnvelopes();
    assert.equal(held.length, 1, 'A\'s op is parked for the missing attestation — P-8\'s own path');
    const rec = chainHeads(B)[f.spaceId];
    assert.equal(rec.seq, B.cursor(), 'the record\'s seq is the CURSOR');
    // The property, stated as the equality that used to fail: the chain stored beside seq N is the
    // chain the relay served for seq N, and not the chain of the row the page happened to end on.
    const page = await B.run(() => B.transport.request(
      'GET', '/api/v1/ops', { space: f.spaceId, since: '0', limit: '500' }, null, {}));
    const rows = page.json.ops;
    const atCursor = rows.find((o) => String(o.seq) === rec.seq);
    const above = rows.find((o) => BigInt(o.seq) > BigInt(rec.seq));
    assert.equal(rec.chain, atCursor.chain,
      'the stored chain IS the chain of the seq it is stored against — one row, one record');
    assert.notEqual(rec.chain, above.chain,
      'and it is not the chain of a row the cursor has not reached. `pullNow` looks the anchor up '
      + 'BY the commit seq (`chainBySeq`) instead of handing `advance()` whatever the page ended on.');

    // ── and here is what that buys on the next launch ───────────────────────
    await B.close();
    await B.open();
    f.attestations.set(A.short, attA);          // the cure arrives; the relay stays honest
    await B.pull();

    assert.deepEqual(findings(B), [],
      'the honest page verifies against the anchor, because the anchor was true when it was written');
    assert.equal(B.storeDiagnostics().sync.chain, null, 'so there is no verdict to show');
    assert.equal(B.status().state, 'healthy', 'and no `error` on a relay that did nothing');
    assert.equal(B.warnings().join(' ').includes('does not add up'), false,
      'and nobody is told their board does not add up');
    assert.equal(B.state.notes.some((n) => n.id === 'a1'), true,
      'AND THE HELD OP LANDED — the hold was a delay, which is the whole of F-6');

    await f.settle();
    assert.equal(boardsAgree([A, B]).equal, true,
      'the two Macs hold byte-identical boards: ' + boardsAgree([A, B]).detail);
  });

  test('§1c · and it stays quiet as the log grows — no escalation from `mismatch` to `gap`', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    await B.apply('createNotePopover', { id: 'b1', date: '2027-06-06', text: 'von B', categoryId: 'c1' });
    await B.push();
    const attA = f.attestations.get(A.short);
    f.attestations.delete(A.short);
    await A.apply('createNotePopover', { id: 'a1', date: '2027-06-07', text: 'von A', categoryId: 'c1' });
    await A.push();
    await B.pull();
    await B.close();
    await B.open();
    f.attestations.set(A.short, attA);
    await B.pull();

    await A.apply('editNotePopover', { id: 'a1', text: 'zweite Fassung' });
    await A.push();
    f.clock.advance(MINUTE);
    await B.pull();
    assert.deepEqual(findings(B).map((x) => x.kind), [],
      'the anchor was coherent, so it keeps verifying: round 8 re-persisted a wrong chain on every '
      + 'advance (`if (w.ok) chainAnchor = w.head` never fired again) and the verdict escalated '
      + 'from `mismatch` to `gap` and stayed there for the life of the space');
    await f.settle();
    assert.equal(B.status().state, 'healthy', 'still healthy after a full settle');
    assert.equal(B.state.notes.find((n) => n.id === 'a1').text, 'zweite Fassung',
      'and the later edit is on the board');
    assert.equal(boardsAgree([A, B]).equal, true, boardsAgree([A, B]).detail);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · CLOSED (R8-2) — A MEMBER PURGE COSTS ONE PULL AND A DIAGNOSTIC, NOT THE SPACE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `chain.js`'s own header is explicit about this case and about what a client must do:
//
//   > ADR 003 §6.3 has `POST /members/remove` … purge that member's `Op` rows … deleting rows
//   > makes every subsequent `chain` value unrecomputable by anyone, for ever.
//   > · a break is reported ONCE PER BREAK … with `benignCause: 'member-purge'` named in it;
//   > · verification RESUMES from the new head — the client re-anchors on the row it just saw.
//   > The alternative — treating a purge as an attack — would turn the one legitimate destructive
//   > operation in the product into a permanent red light.
//
// That paragraph describes `createChainWitness`. Round 8 called `verifyChain` instead and added a
// cursor hold the ADR forbids, so the result was worse than a permanent red light: the cursor
// stopped at the hole for ever and every op past the first page was permanently unreachable, on an
// honest relay, across relaunches.
//
// `pullNow` now folds through the wrapper. The hole is reported ONCE, with its benign cause; the
// witness re-anchors on the row the relay served; the hold it placed is not re-armed on the next
// pull; and verification continues from the new anchor — the honest ceiling, "provable since the
// last anchor". What the hold still buys is the one honest round trip in which a relay that has
// truncated a page can serve what it says it owes, which is the half `fleet-harness.test.js` §2a
// and `attack-converge-relay.test.js` §2 measure and which mutant M-B in the round-9 table kills.
//
// `deleteOpsByDevices` is called here directly on the shipped memory adapter. That is the exact
// call `POST /members/remove` makes (`store-interface.js` C25 pins its semantics: "a purge leaves
// holes; seq stays monotone and is never reused").

describe('§2 · CLOSED · one legitimate member removal costs one pull, and nothing else', () => {
  test('the cursor passes the hole on the next pull, and every op above it lands', async () => {
    const base = createRelay().limits;
    const clock = simClock(Date.UTC(2026, 11, 10, 9, 0, 0));
    // A two-row page, so the log is several pages long. Nothing else about the relay changes.
    const relay = createRelay({ clock, limits: { ...base, opsPerPull: 2 } });
    const f = await createFleet({ board: BOARD(), devices: ['A', 'B'], clock, relay });
    const A = f.device('A');
    const B = f.device('B');
    /** Sync with the rate window cleared, so nothing here can be a 429 in disguise. */
    const slowSync = async (dev, n) => {
      for (let i = 0; i < n; i++) { f.clock.advance(MINUTE * 10); await dev.sync(); }
      assert.equal(dev.status().consecutiveFailures, 0,
        'every request in this phase was answered 200');
    };
    await f.settle();

    await A.apply('createNotePopover', { id: 'a1', date: '2027-06-07', text: 'eins', categoryId: 'c1' });
    await A.push();
    await B.pull();                                   // B now holds a verified anchor
    const anchored = B.cursor();
    assert.equal(chainHeads(B)[f.spaceId].chain !== '', true, 'the anchor is durable (P-4\'s fix)');

    await A.apply('createNotePopover', { id: 'a2', date: '2027-06-08', text: 'zwei', categoryId: 'c1' });
    await A.push();
    const purged = await f.relay.store.deleteOpsByDevices(f.spaceId, [A.short]);
    assert.ok(purged > 0, 'ADR 003 §6.3 / story 20.2 — the removed member\'s Op rows go with them');

    // Life goes on: six more entries, from a device that is still in the space.
    for (let i = 0; i < 6; i++) {
      await A.apply('createNotePopover', { id: `z${i}`, date: `2027-07-0${i + 1}`, text: `z${i}`, categoryId: 'c1' });
    }
    f.clock.advance(MINUTE * 10);
    await A.push();

    // ── THE BREAK IS SEEN, ONCE, AND IT HOLDS THE CURSOR FOR EXACTLY ONE PULL ────────────────
    f.clock.advance(MINUTE * 10);
    await B.pull();
    const fs = findings(B);
    assert.equal(fs[0]?.kind, 'gap', 'the hole is detected — the detector did not get weaker');
    assert.equal(fs[0].benignCause, 'member-purge',
      'and it names the benign cause, which is the whole reason the client may not treat it as a fork');
    assert.equal(B.cursor(), anchored,
      'the cursor is held for THIS pull: a relay that truncated a page gets one honest round trip '
      + 'to serve what it says it owes');

    f.clock.advance(MINUTE * 10);
    await B.pull();
    assert.notEqual(B.cursor(), anchored,
      'AND THE WITNESS RE-ANCHORS: the same break is not re-reported, so it is not re-armed as a '
      + 'hold, and the cursor moves. Round 8 stopped here for ever, waiting for rows that had been '
      + 'deleted by design (`chainHoles` → `holds` → `floor`, on every pull, unconditionally).');
    assert.deepEqual(findings(B).map((x) => x.kind), ['gap'],
      'the verdict is the SAME finding, not a second one — `chain.js` dedupes by the break itself');

    await slowSync(B, 2);
    const missing = [0, 1, 2, 3, 4, 5].filter((i) => !B.state.notes.some((n) => n.id === `z${i}`));
    assert.deepEqual(missing, [],
      'every entry above the purge landed, including the pages past the first — the cursor moved, '
      + 'so page two was asked for');
    assert.equal(B.status().state, 'healthy',
      'and the red light `chain.js` forbids is out: a later page verifies against the new anchor, '
      + 'which is positive evidence, and a break that has been re-anchored past is not a fork');
    const said = B.warnings().join(' ');
    assert.equal(/still owed/.test(said), false,
      'nothing promised the user that deleted rows are "still owed" by a relay that cannot serve them');
    assert.match(said, /removed from a shared board/,
      'what it says instead is the one thing a family can act on: if somebody was removed, this is '
      + 'expected and nothing is wrong');
    assert.match(said, /Syncing continues/, 'and that sync did not stop');

    await B.close();
    await B.open();
    await slowSync(B, 2);
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5].filter((i) => !B.state.notes.some((n) => n.id === `z${i}`)), [],
      'and the relaunch keeps them: the durable anchor is a row that was really served, so the '
      + 'next session verifies from it instead of re-deriving the purge as a fresh accusation');
    assert.equal(B.status().state, 'healthy');
    assert.equal(B.quarantined().length, 0, 'nothing was refused on the witness\'s word — ADR 002 §8.6');
  });

  // ── THE CONTROL. A PURGE MUST NOT MAKE THE DETECTOR STOP DETECTING. ────────────────────────
  //
  // `chain.js` §5's own words: "suppressing every LATER break would be the detector switching
  // itself off, which is worse". This is that row through the product's pull path rather than
  // through a direct call: after the purge above, a relay that rewrites a chain value on a LATER
  // page is still caught.
  test('CONTROL · after the purge, a later lie is still caught', async () => {
    const base = createRelay().limits;
    const clock = simClock(Date.UTC(2026, 11, 10, 9, 0, 0));
    const relay = createRelay({ clock, limits: { ...base, opsPerPull: 2 } });
    const f = await createFleet({ board: BOARD(), devices: ['A', 'B'], clock, relay });
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    await A.apply('createNotePopover', { id: 'a1', date: '2027-06-07', text: 'eins', categoryId: 'c1' });
    await A.push();
    await B.pull();
    await A.apply('createNotePopover', { id: 'a2', date: '2027-06-08', text: 'zwei', categoryId: 'c1' });
    await A.push();
    await f.relay.store.deleteOpsByDevices(f.spaceId, [A.short]);
    for (let i = 0; i < 4; i++) {
      await A.apply('createNotePopover', { id: `y${i}`, date: `2027-08-0${i + 1}`, text: `y${i}`, categoryId: 'c1' });
    }
    f.clock.advance(MINUTE * 10);
    await A.push();
    f.clock.advance(MINUTE * 10);
    await B.sync();                                   // the purge is folded and re-anchored past
    assert.equal(B.status().state, 'healthy', 'the purge is survived');

    await A.apply('editNotePopover', { id: 'y0', text: 'nach dem Purge' });
    f.clock.advance(MINUTE * 10);
    await A.push();
    f.wire.hostile.onResponse = MUTATORS.rewriteChain((o, i) => (i === 0 ? 'AAAA' + o.chain.slice(4) : null));
    f.clock.advance(MINUTE * 10);
    await B.pull();
    f.wire.honest();
    assert.equal(findings(B).some((x) => x.kind === 'mismatch'), true,
      'DETECTION SURVIVED THE PURGE. Verification resumed from the anchor the relay itself served, '
      + 'so a rewritten chain on a later page is still a mismatch — degraded from provable-from-'
      + 'genesis to provable-since-the-last-anchor, which is the honest ceiling and not silence.');
    assert.equal(B.status().state, 'error');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · SUCCEEDED — R8-3. `chain` IS DECLARED `durable: true` AND IS NOT PERSISTED AT ALL
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `sync/status.js`'s `SYNC_OBSERVABLES` row `chain` carries `durable: true`, and its own docblock
// says durability is "the requirement, not a nicety". `store.syncChain` is a plain field, set to
// `null` in the constructor and again in `init()`, and it rides in no file. The refusal ledger
// beside it got `checkpoint.lzp.refusals`; this one got nothing.
//
// The S4-diverged probe in `tests/property/sync-domains.test.js` cannot see this: it relaunches
// with the withhold STILL ARMED, so the verdict is re-derived on the next pull and the row reads
// as durable. A one-shot lie is the input that separates the two.

describe('§3 · SUCCEEDED · a fork this device detected is forgotten by the next launch', () => {
  test('one rewritten chain value: `error` before the quit, `silent: true` after it', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    await A.apply('createNotePopover', { id: 'x', date: '2027-06-07', text: 'x', categoryId: 'c1' });
    await A.push();

    f.wire.hostile.onResponse = MUTATORS.rewriteChain((o, i) => (i === 0 ? 'AAAA' + o.chain.slice(4) : null));
    await B.pull();
    f.wire.honest();                                   // one lie, then honesty for ever

    assert.equal(B.status().state, 'error', 'the detector fires — this half works');
    assert.equal(B.storeDiagnostics().sync.chain === null, false, 'and the verdict is in the store');

    await B.close();
    await B.open();
    const s = B.status();
    assert.equal(B.storeDiagnostics().sync.chain, null,
      'DEFECT: the verdict did not survive the quit. `sync/status.js` declares this observable '
      + '`durable: true`; nothing writes it to disk.');
    assert.equal(s.state, 'healthy', 'DEFECT: `healthy`');
    assert.equal(s.silent, true,
      'DEFECT: `silent: true` — the build actively claims "there is nothing to tell you" about a '
      + 'fork it detected and recorded ninety seconds ago. That is L-1 exactly, one field over.');
    assert.deepEqual(s.blind, [],
      'and `blindSpots()` cannot help: the field EXISTS and reads `null`, which the fold is '
      + 'required to read as "no fork" rather than as "I have not looked"');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · FAILED — the defences that held, kept as non-vacuity controls
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · FAILED · what the wiring got right', () => {
  test('a device with NO anchor re-anchors instead of accusing anybody', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    await A.apply('createNotePopover', { id: 'q', date: '2027-06-07', text: 'q', categoryId: 'c1' });
    await A.push();
    B.disk.setItem('langzeitplaner.chainheads', '{}');   // a fresh install resuming mid-stream
    await B.close();
    await B.open();
    await B.pull();
    assert.equal(B.storeDiagnostics().sync.chain, null, 'no anchor, no accusation — M13 holds');
    assert.equal(B.status().state, 'healthy');
  });

  test('a withheld op still stops the cursor, which is the attack the wiring is FOR', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    await A.apply('createNotePopover', { id: 'w1', date: '2027-06-07', text: 'eins', categoryId: 'c1' });
    await A.push();
    await B.pull();
    await A.apply('createNotePopover', { id: 'w2', date: '2027-06-08', text: 'zwei', categoryId: 'c1' });
    await A.apply('createNotePopover', { id: 'w3', date: '2027-06-09', text: 'drei', categoryId: 'c1' });
    await A.push();
    const hidden = (await B.run(() => B.transport.request(
      'GET', '/api/v1/ops', { space: f.spaceId, since: B.cursor(), limit: '500' }, null, {}))).json.ops[0].oid;
    f.wire.hostile.onResponse = MUTATORS.withholdOps((o) => o.oid === hidden);
    const before = B.cursor();
    await B.sync();
    assert.equal(B.cursor(), before, 'the cursor did not step over a row it was never handed');
    f.wire.honest();
    await B.catchUp();
    assert.equal(B.state.notes.some((n) => n.id === 'w2') && B.state.notes.some((n) => n.id === 'w3'), true,
      'and an honest page afterwards delivers what was owed — this is the recoverable case, and '
      + 'it is what makes §2\'s purge different: there, the rows are gone');
  });
});
