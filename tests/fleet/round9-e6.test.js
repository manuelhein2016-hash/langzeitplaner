// FLEET · ROUND 10 ADVERSARY — E6's ACTUAL SHAPE, DRIVEN.
// ADR 002 §0 (T2, T5), §4.1 · ADR 003 §3.2, §6.3, §8.2 · stories 15.4, 20.1–20.4 · F-6.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE IS FOR
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// E6 is Familienkreis: create, invite, join, member list, remove, leave, delete space, with 2–8
// members. Round 9 answered a verdict about whether the sync engine could carry it and answered it
// with two headline rows — first contact, and one member removal. This file drives the shapes
// those two do not reach, and reports whether the engine underneath behaves:
//
//   §1  A FOURTH MAC, A SECOND AND THIRD MEMBER, A JOIN ACROSS A PARTITION, TWO REMOVALS RACING.
//       All of it over `router.js` and `adapters/memory.js` with real keys and real ops.
//   §2  THE ROSTER. E6 has a member list on screen. Where does a client's idea of the membership
//       come from, and what refreshes it?
//   §3  THE PARK LADDER, at the two places R8-4/R8-5's fixes stop.
//
// The seam round 9 named is unchanged and is restated here rather than assumed: THERE IS NO FAMILY
// SYNC CLIENT. `createPersonalSync` refuses a non-`psp_` space in its first line, deliberately
// (story 21.2). So the multi-device rows below run three or four Macs of ONE member on a personal
// space — which is what the shipped engine can drive — while the membership rows run over the real
// family endpoints. Where the two must meet, they meet by measurement, not by assumption.
//
// HOUSE RULES. SUCCEEDED rows assert a defect and invert when it is fixed; FAILED rows assert a
// defence that held and must stay green.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFleet, joinNewMember, simClock, MINUTE } from '../helpers/fleet.js';
import {
  createParkingLot, memoryRecordStore, PARK_REVIVALS,
} from '../../src/js/sync/outbox.js';
import { b64u } from '../../src/js/core/b64.js';
import { stripCommentsAndStrings } from '../helpers/purity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SRC = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
/**
 * The same source with comments and string literals blanked. `purity.js` owns the scanner; a
 * second one here would be a second answer to "is this code or is this a sentence". Used for
 * IDENTIFIER scans, where blanking the strings is exactly right.
 */
const CODE = (p) => stripCommentsAndStrings(SRC(p));

/**
 * The same source with COMMENTS removed and string literals KEPT — because a route is a string,
 * so `CODE` above blanks the very thing this scan is looking for, and the raw source counts a
 * route named in prose as a call site. (Measured: before this existed, `family/engine.js` was
 * reported as a roster fetcher on the strength of one sentence in a docblock.)
 *
 * Comment-only, and comment-only in the shape this codebase actually writes: `/* … *\/` blocks,
 * and lines whose first non-space characters are `//` or `*`. A trailing `// …` after code is
 * left alone, which is safe here because no route literal has ever lived in one.
 */
const NOCOMMENT = (p) => SRC(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

const BOARD = () => ({
  schemaVersion: 1,
  notes: [],
  bars: [],
  categories: [{ id: 'c1', name: 'Familie', paletteRef: 'gruen', visible: true }],
  scratchpads: {},
  settings: null,
});
const findings = (dev) => (dev.storeDiagnostics().sync.chain?.findings || []);
const said = (dev) => dev.warnings().join(' ¶ ');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · E6's MULTI-DEVICE PATHS, DRIVEN
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · four Macs, three members, a partition and a race', () => {
  test('§1a · FAILED — the server half of E6 holds under every shape asked for', async () => {
    const clock = simClock(Date.UTC(2026, 11, 10, 9, 0, 0));
    const f = await createFleet({ board: BOARD(), devices: ['A', 'B', 'C', 'D'], clock });
    const [A, B, C, D] = ['A', 'B', 'C', 'D'].map((n) => f.device(n));
    await f.settle();
    assert.equal(f.all.length, 4, 'four distinct identities — the A3-H4 gate ran on all of them');

    // ── A JOIN WHILE A PEER IS OFFLINE ──────────────────────────────────────────────────────
    // D is in a tunnel for the whole of the membership churn. `POST /invites` is issued by a
    // device that is already a member and `POST /invites/redeem` by the joiner's own new device,
    // so nothing about the join needs D awake — which is the property E6 needs and is not obvious.
    D.offline();
    const oma = await joinNewMember(f, { name: 'O', colorRef: 'blau' });
    const opa = await joinNewMember(f, { name: 'P', colorRef: 'rot' });
    assert.equal((await f.relay.store.listMembers(f.spaceId)).length, 3,
      'three members, written by the real redeem handler while a quarter of the fleet was dark');
    assert.notEqual(oma.memberId, opa.memberId);
    assert.notEqual(oma.memberId, A.memberId, 'these are MEMBERS, not more Macs of one person');

    // Everyone authors, so the log interleaves three members' rows.
    for (const [dev, id] of [[oma, 'o1'], [opa, 'p1'], [A, 'a1'], [C, 'c1']]) {
      await dev.apply('createNotePopover', { id, date: '2027-05-01', text: id, categoryId: 'c1' });
      clock.advance(MINUTE);
      await dev.push();
    }
    const before = (await f.relay.store.listOps(f.spaceId, 0n, 1000)).ops;
    assert.ok(before.some((o) => o.deviceShort === oma.short), 'her rows are really in the log');
    assert.ok(before.some((o) => o.deviceShort === opa.short), 'and his');

    // ── TWO REMOVALS RACING ─────────────────────────────────────────────────────────────────
    // Concurrent, from one signing device (the harness mounts one disk at a time, so the
    // concurrency has to live inside a single `run()` — the two requests are still genuinely
    // in flight together against one store).
    const [r1, r2] = await A.run(() => Promise.all([
      A.transport.request('POST', '/api/v1/members/remove', undefined, { spaceId: f.spaceId, memberId: oma.memberId }),
      A.transport.request('POST', '/api/v1/members/remove', undefined, { spaceId: f.spaceId, memberId: opa.memberId }),
    ]));
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    assert.equal(r2.status, 200, JSON.stringify(r2.json));
    assert.equal(r1.json.removed && r2.json.removed, true, 'both removals landed');
    assert.ok(r1.json.purgedOps > 0 && r2.json.purgedOps > 0,
      'NON-VACUITY: each removal purged rows of its own, so the race really did contend');
    assert.equal(r1.json.rotateRequired && r2.json.rotateRequired, true,
      'and each states ADR 002 §4.1\'s obligation independently');

    const after = (await f.relay.store.listOps(f.spaceId, 0n, 1000)).ops;
    assert.equal(after.some((o) => o.deviceShort === oma.short || o.deviceShort === opa.short), false,
      'neither removal was lost to the other: BOTH members\' rows are gone');
    const seqs = after.map((o) => Number(o.seq));
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b),
      'and `seq` is still monotone across two concurrent purges — `store-interface.js` C25');
    assert.equal(new Set(seqs).size, seqs.length, 'with no seq reused');
    assert.equal((await f.relay.store.listMembers(f.spaceId)).filter((m) => m.removedAt === null).length, 1,
      'one member left in the circle');

    // ── A REMOVED MEMBER KEEPS TRYING ───────────────────────────────────────────────────────
    await oma.apply('createNotePopover', { id: 'o2', date: '2027-05-09', text: 'noch da?', categoryId: 'c1' });
    clock.advance(MINUTE);
    await oma.push();
    assert.equal(oma.status().state, 'error',
      'a removed member is refused at auth step 6 and her client says so — removal is instant '
      + 'server-side and does not wait for anyone\'s laptop (ADR 003 §2)');
    assert.equal((await f.relay.store.listOps(f.spaceId, 0n, 1000)).ops.some((o) => o.deviceShort === oma.short),
      false, 'and nothing she pushed after the removal reached the log');

    // ── AND THE MAC THAT WAS DARK THROUGH ALL OF IT COMES BACK ───────────────────────────────
    D.online();
    for (let i = 0; i < 10; i++) { clock.advance(MINUTE * 10); await D.sync(); }
    assert.notEqual(D.cursor(), '0',
      'THE ROW E6 NEEDS: the Mac whose cursor was below every purged row crosses TWO holes torn '
      + 'by two concurrent removals and its cursor still moves. Round 8 wedged on one.');
    assert.equal(D.state.notes.some((n) => n.id === 'a1'), true, 'and it reaches what survives');
    assert.equal(D.state.notes.some((n) => n.id === 'c1'), true);
    assert.equal(D.state.notes.some((n) => n.id === 'o1'), false, 'and not what was purged');
    assert.equal(D.realQuarantine().length, 0, 'nothing was refused on the witness\'s word');
    assert.equal(/still owed/.test(said(D)), false,
      'and nobody was promised the delivery of rows deleted on purpose');
  });

  test('§1b · SUCCEEDED — but the third and fourth Macs arrive with the detector already off', async () => {
    // The E6 consequence of `chain.js`'s honest ceiling, measured rather than reasoned about.
    // After the first break the witness is `broken` for the life of the space and `fromGenesis` is
    // false for ever, so verification degrades to "provable since the last anchor" — permanently,
    // per device, from the first removal onwards. E6 makes removals routine (2–8 members, a circle
    // that changes over years), and a device that joins AFTER the first removal can never reach
    // `fromGenesis` at all: its first pull from `since = 0` is served a log whose first row is not
    // seq 1, so `if (s.head === null && first === 1n) s.fromGenesis = true` never fires.
    const clock = simClock(Date.UTC(2026, 11, 10, 9, 0, 0));
    const f = await createFleet({ board: BOARD(), devices: ['A', 'B', 'C'], clock });
    const [A, B, C] = ['A', 'B', 'C'].map((n) => f.device(n));
    await f.settle();

    for (const [dev, id] of [[C, 'c0'], [A, 'a0'], [C, 'c1'], [A, 'a1']]) {
      await dev.apply('createNotePopover', { id, date: '2027-05-01', text: id, categoryId: 'c1' });
      clock.advance(MINUTE);
      await dev.push();
    }
    const purged = await f.relay.store.deleteOpsByDevices(f.spaceId, [C.short]);
    assert.ok(purged > 0, 'NON-VACUITY: ADR 003 §6.3\'s purge, on the shipped adapter');
    assert.notEqual(Number((await f.relay.store.listOps(f.spaceId, 0n, 1000)).ops[0].seq), 1,
      'the log no longer starts at seq 1 — the first rows went with the removed member');

    // B is the new arrival: its cursor is 0 and it pulls the space for the first time.
    assert.equal(B.cursor(), '0');
    for (let i = 0; i < 6; i++) { clock.advance(MINUTE * 10); await B.sync(); }
    const rec = JSON.parse(B.disk.getItem('langzeitplaner.chainheads') || '{}')[f.spaceId];
    assert.notEqual(rec, undefined, 'B has an anchor');
    assert.equal(rec.fromGenesis, false,
      'THE ROW: a Mac that joins a circle which has ever removed anybody can NEVER earn '
      + '`fromGenesis`, so it can never make the one claim `unknownWitness` is for. Combined with '
      + '`round9-witness.test.js` §1 — where the cross-check has no input and no delivery anyway — '
      + 'ADR 002 §5.4\'s check 2 is unreachable for every device that joins a real family after '
      + 'its first removal, permanently, by construction. Inverts when a device can re-establish a '
      + 'provable baseline: the relay knows its own genesis and could publish a signed low-water '
      + 'mark, which is an ADR 003 §4 decision and not a client fix.');
    assert.equal(B.state.notes.some((n) => n.id === 'a1'), true, 'while sync itself is fine');
    assert.equal(B.realQuarantine().length, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · R10-8 · **HALF CLOSED BY LZP-608** — the roster is refreshed; the FREE RIDE is still unused
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// THE ROW AS IT WAS, kept so the split is legible:
//
//   > ADR 003 §3.2 piggybacks the member list on EVERY pull, precisely so a client's roster tracks
//   > the circle without a second request. `protocol.js readPullBody` parses it. `pullNow` reads
//   > neither. The only roster fetch in `src/` is a single `GET /spaces/:id/members` at mount
//   > (`family/mount.js:338`) — one request, at launch, on one code path.
//
// **The staleness half is closed and the efficiency half is not, and they are different claims.**
// `sync/keys.js` fetches the roster inside EVERY key pass, and `sync/family.js` runs a key pass on
// every `syncNow()` — so a member who joins is visible on the next poll, a member who is removed
// leaves it on the next poll, and `family/engine.js`'s `refreshAttestations` folds the same
// reading into `openOp`'s P1 table. It has to be that way round for a reason that is not about
// freshness at all: ADR 002 §4.2 step 6 makes the roster the ONLY source of the admissible sender
// set, and a device between §7.1 steps 2 and 6 holds no key, so it cannot fold the log to get one.
//
// WHAT IS STILL OPEN, EXACTLY: the roster now costs ONE EXTRA REQUEST PER SYNC, and ADR 003 §3.2
// already puts the same list in the pull response for free. Neither engine reads `body.members`.
// That is a bandwidth row, not a correctness row, and the assertions below keep measuring it —
// including `removedAt`, which `round9-witness.test.js` §4b still needs and still cannot have.

describe('§2 · R10-8 · HALF CLOSED · the roster is refreshed every sync, by a SECOND request', () => {
  test('the pull piggyback is served, parsed by the protocol layer, and read by nobody', async () => {
    const clock = simClock(Date.UTC(2026, 11, 10, 9, 0, 0));
    const f = await createFleet({ board: BOARD(), devices: ['A', 'B'], clock });
    const A = f.device('A');
    await f.settle();
    const oma = await joinNewMember(f, { name: 'O', colorRef: 'blau' });

    // THE SIGNAL IS ON THE WIRE. A's ordinary pull carries the whole membership, including the
    // joiner it has never heard of.
    const page = await A.run(() => A.transport.request(
      'GET', '/api/v1/ops', { space: f.spaceId, since: '0', limit: '500' }, null, {}));
    assert.equal(page.status, 200);
    assert.ok(Array.isArray(page.json.members), 'ADR 003 §3.2 — the piggyback is real');
    assert.equal(page.json.members.some((m) => m.memberId === oma.memberId), true,
      'and it already names the new member, on the very next pull, with no extra request');

    await A.run(() => A.transport.request('POST', '/api/v1/members/remove', undefined, {
      spaceId: f.spaceId, memberId: oma.memberId,
    }));
    const after = await A.run(() => A.transport.request(
      'GET', '/api/v1/ops', { space: f.spaceId, since: '0', limit: '500' }, null, {}));
    const row = after.json.members.find((m) => m.memberId === oma.memberId);
    assert.notEqual(row, undefined, 'and a removed member is still listed…');
    assert.notEqual(row.removedAt, null,
      '…with `removedAt` set — the timestamp that would let a client say WHY the log has a hole');

    // AND NEITHER ENGINE READS IT — the surviving half of R10-8.
    for (const eng of ['src/js/sync/personal.js', 'src/js/sync/family.js']) {
      assert.equal(/body\s*\.\s*members|\.members\b/.test(CODE(eng)), false,
        `THE SURVIVING ROW: \`${eng}\` never touches \`members\`. Every pull carries the answer `
        + 'to "who is in this circle" and both engines drop it on the floor, then pay for a second '
        + 'request to ask again. Inverts when a `pullNow` folds `body.members` (through '
        + '`readPullBody`, which already parses it) into the roster\'s owner.');
    }

    // WHO FETCHES IT, measured over CODE rather than over comments — a prose mention of the route
    // is not a call site, and before this row used `stripCommentsAndStrings` it counted one.
    const roster = [
      'src/js/family/mount.js', 'src/js/family/engine.js', 'src/js/family/familysettings.js',
      'src/js/sync/keys.js', 'src/js/sync/family.js', 'src/js/sync/personal.js',
    ].filter((p) => /\/members['`]|\/members\$\{|spaces\/\$\{[^}]*\}\/members/.test(NOCOMMENT(p)));
    assert.deepEqual(roster, ['src/js/family/mount.js', 'src/js/sync/keys.js'],
      'THE INVERSION: there are now TWO fetchers and they answer two different questions. '
      + '`mount.js` keeps the UI\'s pseudonymous cache — colours for the member list, at sheet '
      + 'open. `sync/keys.js` fetches it inside every key pass, because ADR 002 §4.2 step 6 makes '
      + 'the roster the only source of the ADMISSIBLE SENDER SET and a joiner holding no epoch key '
      + 'cannot fold the log to build one. So the roster is no longer "fetched once, at mount": it '
      + 'tracks the circle on every sync. What it still costs is a second request, which §3.2 '
      + 'offers for free — that half of R10-8 is open and is asserted above.');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · R10-9 · SUCCEEDED — R8-5's FIX WAS APPLIED TO ONE OF THE LOT'S THREE WRITERS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// R8-5 was `park()` reporting success after a write that failed, and the fix is stated as a rule:
//
//   > A FAILED WRITE IS THE SAME ANSWER AS A FULL LOT … an in-memory row is not a retention, so a
//   > `true` here would be this function telling its caller a fact about the disk that is false,
//   > and the caller releasing the cursor on it.
//
// `park()` obeys it. `refuse()` and `release()` — the other two functions that write the same
// file, one of them added by round 9 — end `await persist(); return n;` and drop the verdict on the
// floor. `pullNow` then ignores what they return anyway. Nothing is LOST by this (the disk keeps
// its previous, safer state), which is why it ranks where it does; what breaks is the bound.

describe('§3 · R10-9 · SUCCEEDED · a shelving that never reached the disk is reported as done', () => {
  const SPACE = 'psp_9xQ2mR7bL0aZ4tV8wKQ1rT';
  const rnd = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
  const sealed = (over = {}) => ({
    v: 1, sp: SPACE, ep: 1, dv: '7QAR2MZ9XKPNC0GV', oid: b64u(rnd(16)), wit: '',
    iv: b64u(rnd(12)), ct: b64u(rnd(48)), sig: b64u(rnd(64)), ...over,
  });
  function disk(initial = []) {
    let held = JSON.parse(JSON.stringify(initial));
    const s = {
      durable: true,
      refuse: false,
      async loadRecords() { return JSON.parse(JSON.stringify(held)); },
      async saveRecords(list) {
        if (s.refuse) throw new Error('QuotaExceededError');
        held = JSON.parse(JSON.stringify(list));
      },
      peek() { return JSON.parse(JSON.stringify(held)); },
    };
    return s;
  }

  test('§3a · `refuse()` and `release()` answer the same whether or not the write landed', async () => {
    const d = disk();
    const lot = createParkingLot({ storage: d });
    await lot.load();
    const e = sealed();
    await lot.park(SPACE, e, '7', 'attestation');

    d.refuse = true;
    assert.equal(await lot.park(SPACE, sealed(), '8', 'attestation'), false,
      'CONTROL — R8-5\'s fix is still in place on the writer it was applied to');
    assert.equal(await lot.refuse(SPACE, [e.oid]), 1,
      'THE ROW: `refuse()` reports one envelope shelved, on a disk that refused the write. It is '
      + 'the function round 9 introduced so that `terminal()` would "say the transition out loud" '
      + 'rather than rely on `release()`\'s inference — and it says it to a caller that cannot '
      + 'tell whether it happened. Inverts when it returns the write\'s verdict, as `park()` does.');
    assert.equal(d.peek().some((r) => r.oid === e.oid && r.refused === true), false,
      'and the disk does not have the shelved row: it still holds the pre-refusal record');

    // `pullNow` does not look either way.
    assert.match(SRC('src/js/sync/personal.js'), /await lot\.refuse\(spaceId, \[r\.oid\]\); \} catch/,
      'and the one call site discards the return value entirely');
  });

  test('§3b · the consequence: PARK_REVIVALS is not durable, so §8.2\'s bound is not either', async () => {
    // `refusals` is the counter that stops an envelope nothing will ever open from being replayed
    // at every launch for the rest of the Mac's life (ADR 003 §8.2: "must never silently spin
    // forever"). It only ever increments through a `persist()` that lands. On a slot the disk
    // keeps refusing — which is precisely the situation in which a Mac accumulates unopened
    // envelopes — the counter never moves and the envelope is revived on every launch, for ever.
    const d = disk();
    const e = sealed();
    const first = createParkingLot({ storage: d });
    await first.load();
    await first.park(SPACE, e, '9', 'attestation');

    d.refuse = true;
    for (let launch = 0; launch < PARK_REVIVALS + 4; launch++) {
      const lot = createParkingLot({ storage: d });
      await lot.load();
      assert.equal(lot.parked(SPACE).length, 1,
        `launch ${launch}: still replayed — the ladder will burn again and give up again`);
      assert.equal(await lot.refuse(SPACE, [e.oid]), 1, `launch ${launch}: and still reports success`);
    }
    assert.equal(d.peek()[0].refusals, 0,
      'THE ROW: after seven launches the durable `refusals` counter is still 0, so the bound '
      + 'ADR 003 §8.2 asks for is never reached. `diagnostics().unwritable` is the only place this '
      + 'shows, and nothing reads it. Inverts when a failed shelving is visible to its caller.');
  });

  test('§3c · SUCCEEDED — past the bound, a retained envelope is invisible to the whole product', async () => {
    // The other half of "a held op that is still invisible". `shelved()` exists so the bytes can
    // be handed back whole — `outbox.js`: "That is not a drop: the bytes are on disk,
    // `diagnostics().refused` counts them, and `shelved()` hands them back whole." Nothing in
    // `src/` calls it, so after `PARK_REVIVALS` launches the envelope is a file nothing will ever
    // open again, and the only trace is a count.
    const d = disk();
    const e = sealed();
    for (let launch = 0; launch <= PARK_REVIVALS; launch++) {
      const lot = createParkingLot({ storage: d });
      await lot.load();
      if (launch === 0) await lot.park(SPACE, e, '5', 'attestation');
      await lot.refuse(SPACE, [e.oid]);
    }
    const done = createParkingLot({ storage: d });
    await done.load();
    assert.deepEqual(done.parked(SPACE), [], 'no longer replayed, which is correct');
    assert.equal(done.shelved(SPACE)[0].env.ct, e.ct, 'and the bytes are there, which is also correct');

    // The completeness half, in `blindness.test.js` §7a's discipline: the DIRECTORIES are walked,
    // so a caller added in a file nobody thought of still reddens this row.
    const dirs = ['src/js/sync', 'src/js/family'];
    const readers = dirs.flatMap((d) => fs.readdirSync(path.join(REPO, d))
      .filter((n) => n.endsWith('.js'))
      .map((n) => `${d}/${n}`))
      .filter((p) => /\.shelved\s*\(/.test(SRC(p)));
    assert.deepEqual(readers, ['src/js/sync/status.js'],
      'THE ROW, INVERTED (R10-9c): `shelved()` has a reader. Round 10 measured NO caller anywhere '
      + 'in `src/` — the retention was real and the recovery path did not exist, so a change from '
      + 'a family member sat on the disk, correctly kept, and no screen, no diagnostic and no '
      + 'launch would ever surface it as anything but a number. `sync/status.js shelvedDetail()` '
      + 'is that reader (ADR 002 §8.6\'s detail pane, which is where this row said it belonged), '
      + 'and `SYNC_OBSERVABLES`\' `shelved` row puts the state in the verdict. The CALL SITE — '
      + '`sync/personal.js status()` passing `held:` — landed in the round-10 integration pass and '
      + 'is asserted as its own row in `round8-park.test.js` §7d rather than folded into this one. '
      + 'This walk stays a `.shelved(` walk on purpose: it measures who may touch the LOT, and the '
      + 'answer must stay `status.js` alone even now that the engine offers the shelf through it. '
      + '⚠ IT IS A TEXT GREP, INCLUDING COMMENTS, and two agents have now tripped it by writing '
      + 'the method name in PROSE rather than by adding a caller. That is a false positive and it '
      + 'is left in deliberately — the alternative is a regex that strips comments, which would '
      + 'then miss a caller inside a template string — but a reader who reddens this row should '
      + 'check whether they wrote a CALL or a sentence before changing anything.');
    assert.equal(done.diagnostics().refused, 1, 'the number, which is all there is');
  });
});
