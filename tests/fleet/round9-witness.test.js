// FLEET · ROUND 10 ADVERSARY — THE WITNESS, NOW THAT IT IS LOAD-BEARING.
// ADR 002 §5.1, §5.4 · ADR 003 §3.2, §3.3, §6.3 · `src/js/sync/chain.js` · `src/js/sync/personal.js`.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE PATTERN THIS ROUND IS LOOKING FOR
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Round 8's fix relocated its failure INTO ITS OWN DETECTOR: it imported `verifyChain`, the leaf,
// left `createChainWitness`, the wrapper, and then rebuilt the wrapper's missing parts badly.
// Round 9 closed that by importing the wrapper — and this file asks the same question one level
// in. `createChainWitness` implements TWO checks, and `chain.js`'s own header numbers them:
//
//   > 1. RECOMPUTE. A client that has pulled a contiguous run can recompute every `chain` it was
//   >    given …
//   > 2. CROSS-CHECK. On push, every device sets `Envelope.wit` to the highest chain it had pulled
//   >    … That is the FORK DETECTOR, and it is **the half that a relay lying consistently to one
//   >    device cannot escape** as long as the two devices ever exchange one op.
//
// Round 9 wired check 1. §1 below measures what happened to check 2.
//
// §2 then attacks the thing round 9 built to make check 1 honest: `chainOwed`, the set that
// remembers which rows a finding said this device was owed. Its docblock is unambiguous —
//
//   > It is emptied by delivery and by nothing else: a relay cannot clear its own verdict by
//   > repeating a page it has already served.
//
// — and §2 asks whether the verdict is actually computed from it.
//
// §3 attacks the durable half: R9-1 made `fromGenesis` writable in both directions so a device
// cannot hand itself back the right to call an unknown witness a fork. §3 asks whether the write
// happens on the one path that lowers the flag.
//
// §4 is the purge-vs-censorship measurement the round was asked for: what a client can still tell
// apart after ADR 003 §6.3's legitimate destructive operation, and what it cannot.
//
// HOUSE RULES. Every row below is an ATTACK and is labelled SUCCEEDED or FAILED from the
// attacker's side. A SUCCEEDED row asserts the defect, so it goes RED when the defect is fixed and
// must then be INVERTED, never deleted. A FAILED row asserts a defence that held.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFleet, createRelay, MUTATORS, simClock, MINUTE } from '../helpers/fleet.js';
import { createChainWitness, CHAIN_FINDINGS } from '../../src/js/sync/chain.js';
import { b64u } from '../../src/js/core/b64.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SRC = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

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
const findings = (dev) => (dev.storeDiagnostics().sync.chain?.findings || []);
const chainHeads = (dev) => JSON.parse(dev.disk.getItem('langzeitplaner.chainheads') || '{}');
const said = (dev) => dev.warnings().join(' ¶ ');
const CRIED_WOLF = /does not add up|no longer check the server's record/;

/** The rows the relay is actually holding, so a test can name a victim by seq. */
const logOf = async (f) => (await f.relay.store.listOps(f.spaceId, 0n, 1000)).ops;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · R10-1 · CLOSED (round 10) — THE FORK DETECTOR IS WIRED AT BOTH ENDS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// INVERTED. Every row below asserted the defect and now asserts the fix; §1c, the control that
// proved the mechanism was complete, is unchanged and still passes, which is how you can tell the
// wiring moved and the wrapper did not.
//
// ADR 002 §5.4's check 2 needs exactly three things, and `chain.js` ships all three:
//
//   (a) a device must PUT its highest pulled chain value in `Envelope.wit` when it pushes.
//       `createChainWitness().witness(space)` returns that value and its docblock says what it is
//       for: *"**This is what makes the fork detector work at all**, and it is one line. Every op
//       this device authors commits to what this device had seen; drop it, or send a constant, and
//       a relay serving two divergent logs is undetectable by anyone."*
//   (b) a puller must HAND `wit` to the witness. `observe(space, rows)` documents its row shape as
//       `{seq, chain, env:{oid, wit, dv}}` and the cross-check loop reads `row.env.wit`.
//   (c) the witness must have pulled from genesis to be allowed to call an unknown `wit` a fork —
//       `fromGenesis`, which §3 below is about.
//
// Round 9's own closing note says the wrapper is "genuinely load-bearing" and counts six mutants
// to prove it. Every one of those mutants is inside check 1. This section measures check 2.
//
// The four rows are: the value IS produced; the value IS delivered; the wrapper catches the fork
// given the rows its contract describes (the unchanged control); and — §1d, added by the fix — the
// two ordinary situations in which a device must NOT accuse, because wiring check 2 without them
// arms a false positive on an honest relay, which is the failure this project has hit twice.

describe('§1 · R10-1 · CLOSED · ADR 002 §5.4 check 2 — the fork half — is wired at both ends', () => {
  test('§1a · every op this product authors commits to what its author had seen', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();

    // A real exchange in both directions, so both Macs have pulled a page and both have a head.
    await A.apply('createNotePopover', { id: 'a1', date: '2027-05-01', text: 'von A', categoryId: 'c1' });
    f.clock.advance(MINUTE);
    await A.push();
    f.clock.advance(MINUTE * 10);
    await B.sync();
    await B.apply('createNotePopover', { id: 'b1', date: '2027-05-02', text: 'von B', categoryId: 'c1' });
    f.clock.advance(MINUTE);
    await B.push();
    f.clock.advance(MINUTE * 10);
    await A.sync();

    // NON-VACUITY. Envelopes really were pushed, and B really had pulled a page before it pushed.
    const pushed = f.wire.seenBodies.filter((b) => b && Array.isArray(b.ops)).flatMap((b) => b.ops);
    assert.ok(pushed.length >= 2, `only ${pushed.length} envelopes crossed the wire — nothing to measure`);
    assert.notEqual(B.cursor(), '0', 'and B had a verified head of its own before it authored b1');

    const wits = [...new Set(pushed.map((o) => o.wit))];
    assert.notDeepEqual(wits, [''],
      'THE ROW, INVERTED. Round 9 sealed the literal `wit: \'\'` on every push, so no op this '
      + 'product authored committed to any chain value and check 2 had no input anywhere in the '
      + 'system. `sealLine` now writes `witness.witness(spaceId)`.');
    // B had pulled a page before it authored `b1`, so B's envelope must carry B's head. A's first
    // op was authored before A had pulled anything, so `''` is the honest value there and §5.1
    // provides for it. Both halves are asserted: a blanket "non-empty" would pass on a constant.
    const bWit = pushed.filter((o) => o.dv === B.short).map((o) => o.wit);
    assert.ok(bWit.some((w) => w !== ''),
      'the Mac that had pulled a page commits to the head it had pulled');
    const served = new Set((await logOf(f)).map((o) => (typeof o.chain === 'string' ? o.chain : b64u(o.chain))));
    for (const w of [...new Set(pushed.map((o) => o.wit))]) {
      if (w === '') continue;
      assert.equal(served.has(w), true,
        `the header carries ${w}, which this relay never served — a witness must be a chain value `
        + 'the relay itself computed, never something the client invented (ADR 002 §5.4)');
    }

    // …and the one function whose entire job is to produce that value now has its call site.
    const srcFiles = ['src/js/sync/personal.js', 'src/js/family/engine.js', 'src/js/family/mount.js',
      'src/js/sync/outbox.js', 'src/js/sync/status.js', 'src/js/sync/protocol.js', 'src/js/sync/cursor.js'];
    const callers = srcFiles.filter((p) => /\bwitness\s*\.\s*witness\s*\(/.test(SRC(p)));
    assert.deepEqual(callers, ['src/js/sync/personal.js'],
      'and `createChainWitness().witness(space)` — the accessor that exists for exactly this — is '
      + 'called from `sealLine`, and from exactly one place. Round 8 imported the leaf and left '
      + 'the wrapper; round 9 imported the wrapper and left the one line inside it that the '
      + 'wrapper\'s own docblock calls "what makes the fork detector work at all".');
    assert.match(SRC('src/js/sync/personal.js'), /wit: witness\.witness\(spaceId\)/,
      'MUTANT M-F1: put `wit: \'\'` back and this row dies first');
  });

  test('§1b · and `pullNow` hands the field to the witness, which is where it is read', async () => {
    // The pull path builds its own row objects for the witness. It builds `{seq, chain, env:{oid}}`
    // — `wit` and `dv` are dropped — so even an envelope that DID carry a witness value could not
    // reach the cross-check. Two independent measurements, because either alone is weak: the
    // shape of the call site, and the behaviour of a client handed a forked page.
    const engine = SRC('src/js/sync/personal.js');
    const rowBuild = engine.match(/rows\.push\(\{.*\}\s*\);/);
    assert.notEqual(rowBuild, null, 'the pull path still builds witness rows in one place');
    assert.equal(/env:\s*\{\s*oid:\s*e\.oid,\s*wit:\s*e\.wit,\s*dv:\s*e\.dv\s*\}/.test(rowBuild[0]), true,
      `THE ROW, INVERTED: the witness is handed \`${rowBuild[0].trim()}\`. \`observe()\` documents `
      + 'its input as `{seq, chain, env:{oid, wit, dv}}` and reads `row.env.wit`; round 9 passed '
      + 'one of the three. MUTANT M-F1b: drop `wit` here and the behavioural half below dies.');

    // The behavioural half. The relay serves B a page whose rows commit to a chain value B has
    // never been served — the exact input `unknownWitness` exists for.
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    await A.apply('createNotePopover', { id: 'a1', date: '2027-05-01', text: 'von A', categoryId: 'c1' });
    f.clock.advance(MINUTE);
    await A.push();

    const FORK = 'Zz'.padEnd(43, 'Q');
    f.wire.hostile.onResponse = (res, req) => {
      if (!/\/ops/.test(req.path) || !res.body || !Array.isArray(res.body.ops)) return res;
      return { ...res, body: { ...res.body, ops: res.body.ops.map((o) => ({ ...o, wit: FORK })) } };
    };
    f.clock.advance(MINUTE * 10);
    await B.pull();
    f.wire.honest();

    const kinds = findings(B).map((x) => x.kind);
    assert.equal(kinds.includes(CHAIN_FINDINGS.UNKNOWN_WITNESS), true,
      'THE ROW, INVERTED: the fork reaches the client and is named as one. B pulled this space '
      + 'from genesis in this session, so it holds every chain value the log has ever had and can '
      + 'say with proof that the value these ops commit to was never in it — which is the whole '
      + 'of ADR 002 §5.4 check 2. Round 9 could not produce this finding under any input.');
    assert.equal(B.status().state, 'error', 'and the indicator says so');
    assert.match(findings(B).find((x) => x.kind === CHAIN_FINDINGS.UNKNOWN_WITNESS).detail,
      /different logs/, 'with the sentence that names what happened');
  });

  test('§1c · CONTROL — the wrapper DOES catch it, given the rows its own contract describes', async () => {
    // Without this row §1a and §1b could be satisfied by a witness that simply cannot detect a
    // fork, which would make them a statement about `chain.js` rather than about its callers. The
    // same page, the same forged `wit`, handed to a fresh witness the way `observe()` says.
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    await A.apply('createNotePopover', { id: 'a1', date: '2027-05-01', text: 'von A', categoryId: 'c1' });
    f.clock.advance(MINUTE);
    await A.push();

    const page = await B.run(() => B.transport.request(
      'GET', '/api/v1/ops', { space: f.spaceId, since: '0', limit: '500' }, null, {}));
    assert.equal(page.status, 200);
    assert.ok(page.json.ops.length > 0, 'a page to fold');

    const FORK = 'Zz'.padEnd(43, 'Q');
    const rows = page.json.ops.map((o) => ({
      seq: String(o.seq), chain: o.chain, env: { oid: o.oid, wit: FORK, dv: o.dv },
    }));
    const w = createChainWitness();
    const out = await w.observe(f.spaceId, rows);
    assert.deepEqual(out.map((x) => x.kind), [CHAIN_FINDINGS.UNKNOWN_WITNESS],
      'the mechanism is complete and correct and has been for three rounds. What is missing is '
      + 'six characters at one call site and one expression at another.');
    assert.equal(out[0].detail.includes('different logs'), true);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §1d · THE OTHER DIRECTION, WHICH IS THE HALF THIS PROJECT HAS GOT WRONG TWICE
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  //
  // Round 8 gave the detector a power the ADR forbids and it cried wolf on the happy path. So a
  // row that only proves a fork IS caught is half a test. Wiring check 2 turns out to arm two
  // false positives, both of them on an honest relay with no attacker anywhere, and both of them
  // in the most ordinary shape a household has: **two Macs, one of them opened less often.**
  //
  //   (a) `restore()` gives back the HEAD and not the WINDOW. `seen` is not persisted anywhere and
  //       comes back holding one value, so after a relaunch every peer `wit` older than this
  //       device's own cursor is "a value I have never seen" — and with one flag gating the answer
  //       it was called a fork. §1d(a) is that Mac.
  //   (b) the 4096-value memory bound evicts, with the same consequence. Pinned as a unit row in
  //       `tests/tier1/sync-chain.test.js` §3, whose assertion round 10 had to invert because it
  //       contradicted its own test name, its own comment and its own section heading.
  //
  // `chain.js` answers both by splitting the right to accuse in two: `fromGenesis`, the durable
  // report, AND `spanFromGenesis`, the live claim that the window is whole. A device with one and
  // not the other says `unverifiableWitness` — *"Not evidence"* — which is the honest answer.
  //
  // And a finding that says "not evidence" may not be READ as evidence: `store.syncChain` is a
  // flag in `status.js`'s taxonomy, so writing one into it lights S4-diverged. `pullNow` computes
  // its verdict from the findings that are evidence and lets the declined ones ride along in the
  // payload. Both halves are needed and both are mutated below.
  test('§1d · a relaunched Mac does not call a fork on a peer that is merely behind', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();

    // A pulls once and then stops pulling: the Mac that gets opened on Sundays. Its head is now
    // fixed at a row that B will very soon be far above.
    await A.apply('createNotePopover', { id: 'sonntag', date: '2027-05-01', text: 'von A', categoryId: 'c1' });
    f.clock.advance(MINUTE);
    await A.push();
    f.clock.advance(MINUTE * 10);
    await A.pull();
    const aHead = A.storeDiagnostics().sync.chain;
    assert.equal(aHead, null, 'NON-VACUITY: nothing is wrong on A, and nothing is wrong anywhere');

    // B is the Mac in daily use. It pulls, writes twice, and pulls again, so its cursor ends well
    // above the row A committed to.
    f.clock.advance(MINUTE * 10);
    await B.sync();
    for (const id of ['b1', 'b2']) {
      await B.apply('createNotePopover', { id, date: '2027-05-02', text: id, categoryId: 'c1' });
    }
    f.clock.advance(MINUTE);
    await B.push();
    f.clock.advance(MINUTE * 10);
    await B.pull();
    const bCursor = B.cursor();

    // A authors an entry WITHOUT pulling first, so its envelope commits to the old head.
    await A.apply('createNotePopover', { id: 'spaet', date: '2027-05-03', text: 'spät', categoryId: 'c1' });
    f.clock.advance(MINUTE);
    await A.push();
    const late = f.wire.seenBodies.filter((b) => b && Array.isArray(b.ops)).flatMap((b) => b.ops)
      .filter((o) => o.dv === A.short && o.wit !== '');
    assert.ok(late.length > 0,
      'NON-VACUITY: A really did commit to something — otherwise this row proves nothing at all');

    // B is closed and reopened. The head comes back from disk; the WINDOW does not exist on disk.
    await B.close();
    await B.open();
    assert.equal(B.cursor(), bCursor, 'the relaunch restored the cursor…');
    assert.equal(chainHeads(B)[f.spaceId].fromGenesis, true,
      '…and the durable `fromGenesis` is TRUE, which is the point of this row: the flag is not '
      + 'what stops the accusation, because the flag is honestly earned and honestly kept here');
    const restored = { ...chainHeads(B)[f.spaceId] };      // the record as the relaunch found it

    f.clock.advance(MINUTE * 10);
    await B.pull();

    assert.equal(B.state.notes.some((n) => n.id === 'spaet'), true, 'A\'s entry lands on B');
    assert.equal(findings(B).some((x) => x.kind === CHAIN_FINDINGS.UNKNOWN_WITNESS), false,
      'THE ROW: no fork is alleged. B cannot place the chain value A committed to — it is below '
      + 'B\'s own cursor and B forgot it when it quit — and a device that has forgotten the value '
      + 'it is being asked about must say so rather than accuse. MUTANT: make `provable` read '
      + '`s.fromGenesis` alone in `chain.js` and this line dies.');
    assert.equal(B.storeDiagnostics().sync.chain, null,
      'and NOTHING was written into the verdict at all. `unverifiableWitness` says "Not evidence" '
      + 'in its own detail string, and `store.syncChain` is a FLAG — anything written there lights '
      + 'S4-diverged. MUTANT: hand `noteChain` every finding rather than the evidence and this '
      + 'line dies, taking `round9-headline.test.js` §2b with it.');
    assert.equal(B.status().state, 'healthy',
      'so the indicator is out, on a relay that did nothing, for two Macs that are simply not '
      + 'equally busy. This is the shape round 8 shipped and round 9 had to undo.');

    // THE CONTROL, so the row above cannot be satisfied by a witness that sees nothing: the same
    // page, handed to a witness restored the same way, DOES produce the declined finding.
    const page = await B.run(() => B.transport.request(
      'GET', '/api/v1/ops', { space: f.spaceId, since: bCursor, limit: '500' }, null, {}));
    const rows = page.json.ops.map((o) => ({
      seq: String(o.seq), chain: o.chain, env: { oid: o.oid, wit: o.wit, dv: o.dv },
    }));
    const w = createChainWitness();
    w.restore(f.spaceId, restored, true);
    const out2 = await w.observe(f.spaceId, rows);
    assert.deepEqual(out2.map((x) => x.kind), [CHAIN_FINDINGS.UNVERIFIABLE_WITNESS],
      'the witness DID see the unplaceable value and DID report it — as the one kind that is not '
      + 'an accusation. The engine\'s silence above is a decision about a finding that exists, '
      + 'not a detector that missed one.');
    assert.match(out2[0].detail, /Not evidence/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · R10-2 STILL OPEN (§2a) · R10-2b CLOSED (§2b) — THE VERDICT, AND THE FIRST PULL
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// ROUND 10 CLOSED §2b AND COULD NOT CLOSE §2a. The two rows looked like one finding and are two.
//
// §2b was a hole in the defence and is now defended: a mismatch at row zero of a page verified
// from genesis holds the cursor for one honest round trip, exactly as a gap does.
//
// §2a asks for `chainVerified` to require `chainOwed.size === 0`, and that clause is **correct
// about the attack and unshippable on its own.** A member purge (ADR 003 §6.3) produces a gap of
// the same shape whose rows are gone BY DESIGN, so the debt can never be discharged and the
// verdict never clears. MEASURED, not argued: with the clause in place `round8-chain.test.js` §2
// fails on *"the red light `chain.js` forbids is out"* and `round9-headline.test.js` §2b fails on
// *"the indicator is OUT"* — both after a legitimate removal that withheld nothing from anybody,
// and both in files this round does not own. §4a below is the reason no rule computed from the
// findings can separate them: the two events are equal field by field. Closing §2a needs the
// second input §4b names, and a PO ruling on a hole with no corroboration at all — the two purge
// rows delete op rows with no membership write, so even the roster is silent there.
//
// The clause and its measured victims are written into `sync/personal.js` beside the expression,
// so the next round does not rediscover it.
//
// `pullNow` keeps `chainOwed`, and its docblock is the strongest sentence in the file:
//
//   > A verdict about the relay may only be cleared by POSITIVE EVIDENCE … It is emptied by
//   > delivery and by nothing else: a relay cannot clear its own verdict by repeating a page it
//   > has already served.
//
// The verdict is then computed as
//
//     const chainVerified = (foldedFresh || owedFilled) && found.length === 0;
//
// — `foldedFresh` is "the head moved", which any relay achieves by continuing to serve honest
// rows. `chainOwed` is consulted only to be emptied; its SIZE is never read. So the set that
// remembers the debt is used only to forgive it, and a relay that withholds one appointment for
// ever is green again two pages later.
//
// The second row is worse and is the one E6 makes routine: on a device's FIRST pull there is no
// anchor, so a withhold at the head of the log produces a `mismatch` rather than a `gap` — and a
// `mismatch` carries no `from`, so `chainHoles` stays empty and the cursor is not held at all.
// Round 9's "one honest round trip" is armed for gaps only.

describe('§2 · R10-2 · a withheld appointment, and the least-defended pull in the product', () => {
  test('§2a · one op withheld for ever; two honest pages later the Mac reads `healthy`', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();

    // B anchors honestly from genesis first, so this is the strongest position the client can be
    // in: a verified head, `fromGenesis`, and a gap-shaped break rather than a mismatch-shaped one.
    await A.apply('createNotePopover', { id: 'a0', date: '2027-05-01', text: 'eins', categoryId: 'c1' });
    f.clock.advance(MINUTE);
    await A.push();
    f.clock.advance(MINUTE * 10);
    await B.pull();
    assert.equal(chainHeads(B)[f.spaceId].fromGenesis, true, 'B is in the best position it can be in');

    // THE APPOINTMENT THE RELAY DOES NOT WANT B TO SEE.
    await A.apply('createNotePopover', { id: 'abgesagt', date: '2027-06-07', text: 'Termin abgesagt', categoryId: 'c1' });
    f.clock.advance(MINUTE);
    await A.push();
    const victim = (await logOf(f)).at(-1);
    for (const [i, id] of ['nach1', 'nach2'].entries()) {
      await A.apply('createNotePopover', { id, date: `2027-06-1${i}`, text: id, categoryId: 'c1' });
      f.clock.advance(MINUTE);
      await A.push();
    }
    f.wire.hostile.onResponse = MUTATORS.withholdOps((o) => String(o.seq) === String(victim.seq));

    f.clock.advance(MINUTE * 10);
    await B.pull();
    assert.equal(findings(B)[0]?.kind, 'gap', 'the hole IS detected — check 1 works');
    assert.equal(B.status().state, 'error', 'and the user is told, on this pull');

    // The documented cost: the hold lasts one pull, then the witness re-anchors and the cursor
    // walks over the hole. That much round 9 states out loud. What follows is not stated.
    f.clock.advance(MINUTE * 10);
    await B.pull();
    f.clock.advance(MINUTE * 10);
    await B.pull();
    assert.notEqual(B.storeDiagnostics().sync.chain, null,
      'while the relay only repeats itself the verdict does stand — that half of the rule holds');

    // ONE honest new row, and the whole accusation is withdrawn.
    await A.apply('createNotePopover', { id: 'nach3', date: '2027-06-20', text: 'nach3', categoryId: 'c1' });
    f.clock.advance(MINUTE * 10);
    await A.push();
    f.clock.advance(MINUTE * 10);
    await B.pull();

    assert.equal(B.state.notes.some((n) => n.id === 'abgesagt'), false,
      'NON-VACUITY: the appointment really is missing from this Mac, and always will be — the '
      + 'cursor is past it, so `GET /ops?since=` will never offer it again.');
    assert.equal(B.storeDiagnostics().sync.chain, null,
      'THE ROW: `store.syncChain` is null. The verdict was cleared by a page that delivered '
      + 'nothing it was owed — `chainVerified = (foldedFresh || owedFilled) && !found.length`, and '
      + '`foldedFresh` means only "the head moved". `chainOwed` still holds the seq of the row the '
      + 'client itself said was missing, and its size is never read anywhere. Inverts to: '
      + '`chainVerified` also requires `chainOwed.size === 0`.');
    assert.equal(B.status().state, 'healthy',
      'and the indicator is OUT over a relay that is still lying, on a Mac that is still missing '
      + 'the entry. A family that opened the settings pane after the first pull and looked again '
      + 'ten minutes later would be told the problem had resolved itself.');
    assert.equal(B.state.notes.some((n) => n.id === 'nach3'), true, 'while everything else lands');
  });

  test('§2b · CLOSED — a head-of-log withhold now holds the first pull, for one round trip', async () => {
    // The position E6 creates constantly — a new member, a new Mac, a restored backup: a device
    // whose cursor is 0 and whose witness has no head. `pullNow` only restores a re-entry anchor
    // when `since !== 0`, so this page is verified from GENESIS: the first served row is checked
    // as `SHA-256(∅ ‖ oid)`, which fails, and the finding is a MISMATCH. A mismatch carries no
    // `from`, `chainHoles` is fed only from `from`, so there is no hold and no round trip.
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();

    await A.apply('createNotePopover', { id: 'zuerst', date: '2027-05-01', text: 'Der erste Eintrag', categoryId: 'c1' });
    f.clock.advance(MINUTE);
    await A.push();
    const victim = (await logOf(f)).at(-1);
    await A.apply('createNotePopover', { id: 'danach', date: '2027-05-02', text: 'danach', categoryId: 'c1' });
    f.clock.advance(MINUTE);
    await A.push();

    assert.equal(B.cursor(), '0', 'B has pulled nothing: this is first contact');
    f.wire.hostile.onResponse = MUTATORS.withholdOps((o) => String(o.seq) === String(victim.seq));
    f.clock.advance(MINUTE * 10);
    await B.pull();

    assert.deepEqual(findings(B).map((x) => x.kind), ['mismatch'],
      'the break is reported as a mismatch, not a gap — there is no anchor for a gap to be relative to');
    assert.equal(findings(B)[0].from, undefined,
      'and a mismatch carries no `from`, which is the field `chainHoles` was built from');
    assert.equal(B.cursor(), '0',
      'THE ROW, INVERTED: THE CURSOR IS HELD ON THE PULL THAT FOUND THE BREAK. Round 9\'s defence '
      + '— "a NEW break holds the cursor for the pull that found it, and for that pull only" — was '
      + 'armed by `gap` and by the page-claim check and by nothing else, so on a device with no '
      + 'anchor the relay chose the shape of the finding by choosing which row to withhold, and '
      + 'the shape it could always reach cost it nothing. A mismatch at row ZERO of a page '
      + 'verified from genesis now holds too. MUTANT M-F2b: drop the `genesisPage` clause in '
      + '`pullNow` and this line dies.');
    assert.equal(B.state.notes.some((n) => n.id === 'danach'), true,
      'and NOTHING IS REFUSED on the witness\'s word — ADR 002 §8.6. The ops that did arrive are '
      + 'on the board; only the cursor waits');

    // AND IT WAITS FOR ONE PULL, NOT FOR EVER — the half that makes this a hold and not R8-2's
    // wedge. The relay is still withholding; the witness has re-anchored on the row it served, so
    // the same page re-served produces no second finding and the cursor moves on.
    f.clock.advance(MINUTE * 10);
    await B.pull();
    assert.notEqual(B.cursor(), '0',
      'the second pull is not held: a hole that cannot be filled — which is what ADR 003 §6.3\'s '
      + 'purge of the OLDEST rows leaves behind, and it produces exactly this mismatch on a device '
      + 'pulling from zero — costs one round trip and not the space (R8-2)');
    assert.equal(B.state.notes.some((n) => n.id === 'zuerst'), false,
      'and the residual is unchanged and is §4.8\'s: the withheld entry is still lost, once, '
      + 'reported. What the hold buys is the round trip in which an honest relay can serve it');
    assert.equal(B.status().state, 'error', 'the break stands in the verdict');
  });

  test('§2c · FAILED — the END-withhold is still refused unconditionally, on every page', async () => {
    // The other shape, and the control that stops §2a/§2b from being read as "the cursor never
    // holds". A `nextCursor` past the last row served is the withhold with no hole to find, and
    // `claimSound` re-arms on every page for ever rather than expiring after one.
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    await A.apply('createNotePopover', { id: 'a1', date: '2027-05-01', text: 'eins', categoryId: 'c1' });
    f.clock.advance(MINUTE);
    await A.push();

    f.wire.hostile.onResponse = (res, req) => {
      if (!/\/ops/.test(req.path) || !res.body || !Array.isArray(res.body.ops)) return res;
      const ops = res.body.ops.slice(0, -1);
      return { ...res, body: { ...res.body, ops, nextCursor: String(res.body.nextCursor) } };
    };
    for (let i = 0; i < 4; i++) {
      f.clock.advance(MINUTE * 10);
      await B.pull();
      assert.equal(B.cursor(), '0',
        `pull ${i + 1}: the cursor is BELOW the rows the relay asked it to step over, and it stays `
        + 'there for as long as the lie is repeated. This is the half a fix to §2a must not break.');
      assert.equal(findings(B)[0]?.kind, 'withheld');
    }
    assert.match(said(B), /still owed/, 'and the sentence promises a delivery the relay CAN make');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · R10-3 · CLOSED (round 10) — THE RECORD IS WRITTEN ON THE PULL THAT HOLDS THE CURSOR
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// INVERTED. It shipped in the same change as §1, and it had to: wiring check 2 while the disk can
// hand a device back a right it has given up is what ARMS the false positive ADR 002 §5.4 spends
// its one sentence forbidding, rather than enabling the detector.
//
// R9-1 made `fromGenesis` a report rather than a ratchet, and `cursor.js` says why in full: the
// flag is *"the RIGHT TO CALL AN UNKNOWN `wit` A FORK … A record that keeps `true` hands the right
// back at the next launch, and the device then accuses the relay of a fork it can no longer
// prove."*
//
// The write is inside `cursors.advance(...)`, and `pullNow` calls `advance` only when
// `commit > since`. A break whose hole sits at or below the first row served holds the cursor at
// `since`, so the ONE pull that lowers the flag in memory is exactly the pull that never writes it
// down. A quit inside that window — an entirely natural thing to do when the sync indicator has
// just gone red — restores `true` on the next launch.

describe('§3 · R10-3 · CLOSED · the durable `fromGenesis` is written by the pull that lowers it', () => {
  test('a break holds the cursor, the Mac is closed, and the launch reads back `fromGenesis: false`', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();

    await A.apply('createNotePopover', { id: 'a0', date: '2027-05-01', text: 'eins', categoryId: 'c1' });
    f.clock.advance(MINUTE);
    await A.push();
    f.clock.advance(MINUTE * 10);
    await B.pull();
    assert.equal(chainHeads(B)[f.spaceId].fromGenesis, true,
      'NON-VACUITY: an honest pull from seq 1 earns the flag, which is correct and is the setup');

    // The hole must be at the FIRST row of the next page, so nothing in it is below the floor and
    // the cursor cannot move. That is also the shape a member purge of the oldest rows produces.
    await A.apply('createNotePopover', { id: 'loch', date: '2027-06-01', text: 'weg', categoryId: 'c1' });
    f.clock.advance(MINUTE);
    await A.push();
    const victim = (await logOf(f)).at(-1);
    for (const [i, id] of ['x1', 'x2'].entries()) {
      await A.apply('createNotePopover', { id, date: `2027-06-1${i}`, text: id, categoryId: 'c1' });
      f.clock.advance(MINUTE);
      await A.push();
    }
    f.wire.hostile.onResponse = MUTATORS.withholdOps((o) => String(o.seq) === String(victim.seq));

    // THE BREAK IS MET BY A FRESH PROCESS, which is the state the fix has to survive: `chainBySeq`
    // — the session's map of seq → the chain value served for it — is empty at this point, so the
    // pull that writes the flag has NO chain value for the seq it is holding at. That is the
    // second half of this row: the write must not take `''` as "store no anchor" when the cursor
    // did not move, or the held pull erases a good anchor on its way past.
    await B.close();
    await B.open();

    const before = B.cursor();
    f.clock.advance(MINUTE * 10);
    await B.pull();
    assert.equal(B.cursor(), before, 'the break held the cursor — round 9\'s one honest round trip');
    assert.equal(findings(B)[0]?.kind, 'gap');

    assert.equal(chainHeads(B)[f.spaceId].fromGenesis, false,
      'THE ROW, INVERTED: the witness lowered `fromGenesis` in memory the moment the page failed '
      + 'to verify (`chain.js`: `s.broken = true; s.fromGenesis = false;`) and THE DISK NOW AGREES. '
      + '`cursors.advance` is still the only writer, and `pullNow` still calls it only when it has '
      + 'something to say — but "the flag this pull computed disagrees with the one on disk" is '
      + 'now one of the two things it can have to say, and the other is a cursor that moved. '
      + 'MUTANT M-F3: put the write back behind `commit > since` alone and this line dies.');
    assert.notEqual(chainHeads(B)[f.spaceId].chain, '',
      'and the held pull did not WIPE the anchor on its way past. `advance` treats any `chain` '
      + 'STRING as the value to store, `\'\'` included — right when the cursor moves to a row this '
      + 'device holds no chain for (R8-1b: no anchor beats a wrong one) and wrong when it did not '
      + 'move at all, because then the pull is making no claim about a new row. This process had '
      + 'never seen the row at its own cursor. MUTANT: pass `{seq, chain: anchorAt}` '
      + 'unconditionally and this line dies.');

    // The user quits, which is what a user does when the sync indicator goes red.
    await B.close();
    await B.open();
    assert.equal(chainHeads(B)[f.spaceId].fromGenesis, false,
      'and the next launch does NOT restore the right the previous session had given up: '
      + '`loadLot()` calls `witness.restore(space, head, cursors.fromGenesis(space))`, and what it '
      + 'reads back is the truth. Round 9 read back `true` and would have accused an honest relay '
      + 'of a fork it could no longer prove, on the first pull after a perfectly ordinary quit.');
  });

  test('§3c · THE TRIPLE · the false positive is reachable, and it takes TWO reverts to reach it', async () => {
    // ── WHY THIS ROW EXISTS ──────────────────────────────────────────────────────────────────
    //
    // §3 and §3b pin the MECHANISM: the durable flag is written by the pull that lowers it. What
    // neither of them measures is the thing ADR 002 §5.4 actually forbids — an honest relay
    // ACCUSED OF A FORK — and the round-10 integration pass found, by building each mutant and
    // running it, that the received account of that hazard was wrong in a way worth writing down.
    //
    // The account was "items 1 and 2 had to ship together, because wiring `wit` without the
    // durable write ARMS the accusation". Measured, that is half right. There are THREE parts,
    // and they do not compose the way the sentence suggests:
    //
    //   item 1   `wit: witness.witness(spaceId)` on every sealed op        — the ARMING condition
    //   item 1b  `provable = s.fromGenesis && s.spanFromGenesis` in `chain.js`  — guard 1
    //   item 2   `commit > at || cursors.fromGenesis(…) !== fromGenesisNow`     — guard 2
    //
    // Measured on this exact arrangement, in a scratch copy, one mutant at a time:
    //
    //   item 2 reverted alone   the durable lie IS restored (`fromGenesis: true` after a break
    //                           this Mac gave the right up for) — and NO accusation follows,
    //                           because `spanFromGenesis` is false on a fresh process.
    //   item 1b reverted alone  no accusation: the disk honestly says `false`.
    //   BOTH reverted           `unknownWitness`, `status: error`, `store.syncChain` SET —
    //                           against a relay that has been honest since the break.
    //   all three reverted      nothing, because with `wit: ''` there is no value to misjudge.
    //
    // So the two guards are INDEPENDENT and either alone is sufficient, which is a stronger
    // position than the one this round was briefed with — and `wit` is what arms all of it, which
    // is why round 9's build was safe only in the sense that its detector was dead.
    //
    // THE ROW ITSELF asserts the honest direction: this build, on this input, accuses nobody. It
    // dies to the pair of reverts above and to nothing smaller, which is exactly what makes it a
    // statement about defence in depth rather than about one line.
    const f = await createFleet({
      board: BOARD(), devices: ['A', 'B', 'C'],
      clock: simClock(Date.UTC(2026, 11, 10, 9, 0, 0)),
    });
    const A = f.device('A');
    const B = f.device('B');
    const C = f.device('C');
    await f.settle(3);

    // 1. B earns `fromGenesis` honestly, from seq 1.
    await A.apply('createNotePopover', { id: 'a0', date: '2027-05-01', text: 'eins', categoryId: 'c1' });
    f.clock.advance(MINUTE);
    await A.push();
    f.clock.advance(MINUTE * 10);
    await B.pull();
    assert.equal(chainHeads(B)[f.spaceId].fromGenesis, true, 'SETUP: honestly earned');

    // 2. ONE BREAK. The witness lowers the flag in memory, and the cursor is held.
    await A.apply('createNotePopover', { id: 'loch', date: '2027-06-01', text: 'weg', categoryId: 'c1' });
    f.clock.advance(MINUTE);
    await A.push();
    const victim = (await logOf(f)).at(-1);
    for (const [i, id] of ['x1', 'x2'].entries()) {
      await A.apply('createNotePopover', { id, date: `2027-06-1${i}`, text: id, categoryId: 'c1' });
      f.clock.advance(MINUTE);
      await A.push();
    }
    f.wire.hostile.onResponse = MUTATORS.withholdOps((o) => String(o.seq) === String(victim.seq));
    f.clock.advance(MINUTE * 10);
    await B.pull();
    assert.equal(findings(B)[0]?.kind, 'gap', 'SETUP: the break really happened');

    // 3. THE RELAY IS HONEST FROM HERE ON. The user quits, which is what one does at a red light.
    f.wire.honest();
    await B.close();
    await B.open();
    assert.equal(chainHeads(B)[f.spaceId].fromGenesis, false,
      'and the right stayed given up across the quit — item 2, which is §3\'s row');

    // 4. C is the Mac opened on Sundays: it pulls ONCE, B then races ahead, and C authors an op
    //    committing to a head far below B's cursor. Nothing here is hostile; it is two Macs that
    //    are not equally busy, which is E6's normal condition and not an attack at all.
    f.clock.advance(MINUTE * 10);
    await C.pull();
    f.clock.advance(MINUTE * 10);
    await B.pull();
    for (const id of ['b1', 'b2']) {
      await B.apply('createNotePopover', { id, date: '2027-06-20', text: id, categoryId: 'c1' });
    }
    f.clock.advance(MINUTE);
    await B.push();
    f.clock.advance(MINUTE * 10);
    await B.pull();
    await C.apply('createNotePopover', { id: 'sonntag', date: '2027-07-01', text: 'von C', categoryId: 'c1' });
    f.clock.advance(MINUTE);
    await C.push();
    const committed = f.wire.seenBodies.filter((x) => x && Array.isArray(x.ops)).flatMap((x) => x.ops)
      .filter((o) => o.dv === C.short && o.wit !== '');
    assert.ok(committed.length > 0,
      'NON-VACUITY: C really did commit to a witness value. Without this the row passes on a '
      + 'build where check 2 is dead, which is precisely round 9\'s false sense of safety — and '
      + 'it is how the first draft of this arrangement fooled itself.');

    // 5. B forgets its window and pulls.
    await B.close();
    await B.open();
    f.clock.advance(MINUTE * 10);
    await B.pull();

    assert.equal(findings(B).some((x) => x.kind === CHAIN_FINDINGS.UNKNOWN_WITNESS), false,
      'THE ROW: no fork is alleged against a relay that did nothing. MUTANTS, both needed: '
      + '`provable = s.fromGenesis` in `chain.js` AND `if (commit > at)` in `personal.js`. Either '
      + 'one alone leaves this green; together they make it `unknownWitness`, `error`, and a '
      + 'verdict written into `store.syncChain`.');
    assert.equal(B.status().state, 'healthy', 'and the indicator is out');
    assert.equal(B.state.notes.some((n) => n.id === 'sonntag'), true,
      'on a Mac that DID receive C\'s entry — the silence is a judgement, not a missed page');
  });

  test('§3b · and what it now costs is real, because §1 landed in the same change', () => {
    // Round 9's version of this row said the defect cost nothing, because §1 measured that neither
    // witness finding could fire on the product path at all. Both halves moved together, so the
    // statement to keep is the one about the mechanism: the flag is what stands between "a fork"
    // and "not evidence", and it is now half of a pair — see §1d for why one flag was not enough.
    const chain = SRC('src/js/sync/chain.js');
    assert.match(chain, /const provable = s\.fromGenesis && s\.spanFromGenesis;/,
      'the right to accuse is the durable history AND the live window, and both are read here');
    assert.match(chain, /kind: provable \? CHAIN_FINDINGS\.UNKNOWN_WITNESS/,
      'and it is what stands between "a fork" and "not evidence"');
    const engine = SRC('src/js/sync/personal.js');
    assert.match(engine, /cursors\.fromGenesis\(spaceId\) !== fromGenesisNow/,
      'and the engine writes the record when the disk disagrees with this pull, not only when the '
      + 'cursor moves — which is the one pull a break can hold');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · R10-4 · SUCCEEDED — PURGE AND CENSORSHIP, MEASURED SIDE BY SIDE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Round 9 made a member purge survivable, which is right and which is exactly the cover a hostile
// relay wants: withhold Papa's op, and let the client attribute the hole to a removal it can see.
// The round was asked to measure what is still distinguishable. The answer is: NOTHING, at the
// client, and the one signal that would separate them is served on the same HTTP response and
// thrown away unread.

describe('§4 · R10-4 · SUCCEEDED · a withhold and a purge are the same event to this client', () => {
  /**
   * ONE SCENARIO, TWO CAUSES, and everything B can see about each.
   *
   * Three Macs of one member, so C's op really applies on B and its disappearance is a hole in the
   * middle of a log B can otherwise read whole. `'purge'` is ADR 003 §6.3's own call on the
   * shipped adapter — `store-interface.js` C25, the same one `purgeMember` makes and the one
   * `round9-headline.test.js` §2a captured. `'withhold'` is a relay that deleted nothing and is
   * simply not serving one row to one device.
   */
  async function observable(mode) {
    const clock = simClock(Date.UTC(2026, 11, 10, 9, 0, 0));
    const f = await createFleet({ board: BOARD(), devices: ['A', 'B', 'C'], clock });
    const A = f.device('A');
    const B = f.device('B');
    const C = f.device('C');
    await f.settle();
    await A.apply('createNotePopover', { id: 'a0', date: '2027-05-01', text: 'eins', categoryId: 'c1' });
    clock.advance(MINUTE);
    await A.push();
    clock.advance(MINUTE * 10);
    await B.pull();

    await C.apply('createNotePopover', { id: 'weg', date: '2027-06-01', text: 'verschwunden', categoryId: 'c1' });
    clock.advance(MINUTE);
    await C.push();
    const victim = (await logOf(f)).at(-1);
    assert.equal(victim.deviceShort, C.short, 'the victim row is C\'s, and only C\'s');
    for (const [i, id] of ['y1', 'y2'].entries()) {
      await A.apply('createNotePopover', { id, date: `2027-06-1${i}`, text: id, categoryId: 'c1' });
      clock.advance(MINUTE);
      await A.push();
    }

    if (mode === 'purge') {
      const n = await f.relay.store.deleteOpsByDevices(f.spaceId, [C.short]);
      assert.ok(n > 0, 'NON-VACUITY: the purge really deleted rows');
    } else {
      f.wire.hostile.onResponse = MUTATORS.withholdOps((o) => String(o.seq) === String(victim.seq));
    }

    for (let i = 0; i < 3; i++) { clock.advance(MINUTE * 10); await B.pull(); }
    return {
      kinds: findings(B).map((x) => x.kind),
      benign: findings(B).map((x) => x.benignCause),
      wolf: CRIED_WOLF.test(said(B)),
      sentence: /removed from a shared board/.test(said(B)),
      stillOwed: /still owed/.test(said(B)),
      missing: !B.state.notes.some((n) => n.id === 'weg'),
      arrived: ['y1', 'y2'].every((id) => B.state.notes.some((n) => n.id === id)),
      quarantined: B.realQuarantine().length,
    };
  }

  test('§4a · the two events are INDISTINGUISHABLE at the client, field by field', async () => {
    const purged = await observable('purge');
    const censored = await observable('withhold');

    assert.deepEqual(purged.kinds, ['gap'], 'NON-VACUITY: the legitimate removal is detected');
    assert.equal(purged.missing, true, 'and its entry is gone, which is the point of a removal');
    assert.equal(censored.missing, true, 'and so is the censored one, which is not the point of anything');

    assert.deepEqual(censored, purged,
      'THE ROW: every field a client can observe about a hostile relay withholding one appointment '
      + 'is EQUAL to the same field about a family removing a member. Same finding kind, same '
      + '`benignCause: \'member-purge\'` — `chain.js` attaches it to every gap and every mismatch '
      + 'unconditionally, because it has nothing else to go on — same sentence to the user ("If '
      + 'somebody was removed from a shared board, that is expected and nothing is wrong"), same '
      + 'end state. Round 9 made the purge survivable and thereby handed a censoring relay its '
      + 'cover story, and this is that cover measured rather than argued. Inverts when the two '
      + 'differ in ANY field — which needs the piggyback §4b names.');
    assert.equal(censored.benign[0], 'member-purge');
    assert.equal(censored.sentence, true);
  });

  test('§4b · the signal that WOULD separate them rides on the same response and is unread', async () => {
    // ADR 003 §3.2 piggybacks the member list on every pull, and `protocol.js readPullBody` parses
    // it: `b.members`. A removal writes `Member.removedAt`, so a client that read the piggyback
    // could say "somebody was removed at 14:02 and the hole is under her device short" — and a
    // client that saw a hole with NO removal in the roster would know it was being censored.
    const engine = SRC('src/js/sync/personal.js');
    assert.equal(/body\s*\.\s*members/.test(engine), false,
      'THE ROW: `pullNow` never reads `body.members`. The one piece of evidence that separates '
      + 'the product\'s legitimate destructive operation from a hostile relay arrives in the same '
      + 'HTTP response as the hole and is discarded.');
    assert.equal(/readPullBody|readPulledOp/.test(engine), false,
      'and neither of `protocol.js`\'s two total, hostile-input readers is used on the pull path '
      + 'at all — `pullNow` reads `body.ops` and `body.nextCursor` off the raw JSON and '
      + 're-implements the `nextCursor` clamp inline. `readPullBody` is the same leaf-versus-'
      + 'wrapper shape as R8-1, in the file next door, with `members` and `cursorLie` inside it.');
    assert.match(SRC('src/js/sync/protocol.js'), /members:/,
      'CONTROL: the reader really does surface the field, so this is a call site and not a gap '
      + 'in the protocol layer');
  });

  test('§4c · FAILED — what a purge still cannot do: nothing is refused on the witness\'s word', async () => {
    // The defence that held, and the reason §4a is a reporting defect rather than a loss. ADR 002
    // §8.6 and ADR 003 §10.6 keep the witness diagnostic-only, and it is: after either event the
    // ops that DID arrive are on the board and nothing was quarantined.
    const censored = await observable('withhold');
    assert.equal(censored.quarantined, 0,
      'no op was refused because a chain value did not add up — a hostile relay cannot wedge this '
      + 'Mac with one bad byte, which is the property ADR 002 §5.4\'s one sentence protects');
  });
});
