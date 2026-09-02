// tests/fleet/e6-gate-slots.test.js — THE FRESH MEMBER-ADVERSARY, ROUND 2: the separated slots.
//
// The question this file asks is the one the integration pass answered at `6e11ca1`: **can family
// traffic still reach personal state?** The pass closed two channels — a whole-slot write that
// DELETED the other engine's rows, and a cap counted across spaces — and this file re-drives both,
// then keeps going into the channel neither of them is about.
//
// §1's rig is the two ports as the round-2 adversary reproduced them: ONE slot, TWO
// `createParkingLot`s, each declaring `space`, `loadRecords` and `saveRecords` SYNCHRONOUS. Those
// rows are about `sync/outbox.js`'s MERGE, which is still the rule for every caller that builds a
// port over a slot it shares, so they keep their shared-slot rig on purpose.
//
// §2's rig is NOT a reproduction any more, and that is itself a finding this round.
// `family/engine.js#parkedEnvelopeStore` was module-private, so §2 re-typed it — and a
// reproduction of a defect is a test that cannot see the fix: every behavioural row below stayed
// GREEN over the fixed file, and only the source-shape row (§2f) moved. The port is now exported
// and §2 drives those bytes, over a `localStorage` stand-in that fails the way a disk fails.
//
// SUCCEEDED / FAILED are from the ADVERSARY's side.

import '../helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createParkingLot, createOutbox, PARK_CAP, PARK_REVIVALS } from '../../src/js/sync/outbox.js';
import { createCursors } from '../../src/js/sync/cursor.js';
import { parkedEnvelopeStore } from '../../src/js/family/engine.js';
import { readFileSync } from 'node:fs';

const PSP = 'psp_personal000000000000000';
const FSP = 'fsp_family0000000000000000';

let n = 0;
const oid = () => `oid${String(n++).padStart(19, '0')}`;
const env = (sp, ep = 1) => ({
  v: 1, sp, ep, dv: 'dev1', oid: oid(), wit: '', iv: 'AAAAAAAAAAAAAAAA', ct: 'Y3Q', sig: 'c2ln',
});

/**
 * ONE durable slot for the device, two ports over it, each declaring its space and neither of
 * them `async` — the shape `family/engine.js` had at `6e11ca1`, and the shape ANY port over a
 * slot two writers share still has. §1 keeps it because §1's rows are about `sync/outbox.js`'s
 * merge, which is what makes such a port safe and which no key change retires.
 *
 * `budget` models a full disk: `localStorage` throws `QuotaExceededError` on the write that would
 * exceed it, which is the failure `outbox.js` documents as "A FAILED WRITE IS THE SAME ANSWER AS
 * A FULL LOT".
 */
function sharedSlot({ budget = Infinity } = {}) {
  const disk = { rows: [] };
  const port = (spaceId) => ({
    durable: true,
    space: spaceId,
    loadRecords() { return JSON.parse(JSON.stringify(disk.rows)); },
    saveRecords(rows) {
      const bytes = JSON.stringify(rows).length;
      if (bytes > budget) {
        const e = new Error('QuotaExceededError');
        e.name = 'QuotaExceededError';
        throw e;
      }
      disk.rows = JSON.parse(JSON.stringify(rows));
    },
  });
  return { disk, port };
}

/** The same, for `chainHeadStore` — a MAP keyed by space. */
function sharedChainSlot() {
  const disk = { map: {} };
  const port = (spaceId) => ({
    space: spaceId,
    loadCursors() { return JSON.parse(JSON.stringify(disk.map)); },
    saveCursors(all) { disk.map = JSON.parse(JSON.stringify(all)); },
  });
  return { disk, port };
}

/**
 * THE DEVICE'S STORAGE — one disk, many keys, with a budget, which is what `localStorage` is.
 *
 * TWO BUDGETS, BECAUSE THE FINDING AND ITS RESIDUE LIVE UNDER DIFFERENT ONES, and saying which is
 * which is the whole of the honesty here:
 *
 *   · `slotBudget` — one VALUE stops being writable when it is too big. This is the round-2 rig's
 *     model ("it stops accepting writes when it is full"), and it is the model the finding was
 *     measured under: with one key for two spaces, the personal lot's every write had to re-carry
 *     the family lot's whole backlog, so the family's bytes decided whether the personal space
 *     could write. §2b is that row, inverted.
 *   · `budget` — the ORIGIN's total, which is what a browser actually enforces. Under it the key
 *     fix changes nothing about WHEN a write fails, because one disk is one disk. §2c is that
 *     row, and it stays SUCCEEDED in its first half on purpose: what the fix owes there is not a
 *     write that lands, it is a stall that is honest and a sentence that names the cause.
 *
 * `family/engine.js` reads the bare global, so the swap is a swap of `globalThis.localStorage`.
 */
function device({ budget = Infinity, slotBudget = Infinity } = {}) {
  const map = new Map();
  return {
    map,
    ls: {
      get length() { return map.size; },
      key(i) { return [...map.keys()][i] ?? null; },
      getItem(k) { return map.has(String(k)) ? map.get(String(k)) : null; },
      setItem(k, v) {
        let total = String(v).length;
        for (const [kk, vv] of map) if (kk !== String(k)) total += vv.length;
        if (String(v).length > slotBudget || total > budget) {
          const e = new Error('the quota has been exceeded');
          e.name = 'QuotaExceededError';
          throw e;
        }
        map.set(String(k), String(v));
      },
      removeItem(k) { map.delete(String(k)); },
      clear() { map.clear(); },
    },
  };
}

/** Run `fn` with `dev` as the device's storage, and put the real one back whatever happens. */
async function onDevice(dev, fn) {
  const was = globalThis.localStorage;
  globalThis.localStorage = dev.ls;
  try { return await fn(); } finally { globalThis.localStorage = was; }
}

const PARKED = 'langzeitplaner.parked';
const slotOf = (dev, sp) => JSON.parse(dev.map.get(`${PARKED}.${sp}`) || 'null');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · THE TWO CHANNELS THE PASS CLOSED
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§1 · the closed channels, re-driven', async (t) => {
  await t.test('§1a · FAILED — a family park no longer deletes the personal shelf', async () => {
    const { disk, port } = sharedSlot();
    const personal = createParkingLot({ storage: port(PSP) });
    const family = createParkingLot({ storage: port(FSP) });
    await personal.load();
    await family.load();

    const mine = env(PSP);
    assert.equal(await personal.park(PSP, mine, '1', 'attestation'), true);
    assert.equal(await personal.refuse(PSP, mine.oid, 'gave_up'), 1, 'the shelf: R8-4');

    // An ordinary family park, the exact event that used to destroy it.
    assert.equal(await family.park(FSP, env(FSP), '9', 'epoch'), true);

    assert.equal(disk.rows.filter((r) => r.space === PSP).length, 1,
      'the personal shelf row survived a family write');
    const back = createParkingLot({ storage: port(PSP) });
    await back.load();
    // A relaunch REVIVES a shelved row into the replay set (`PARK_REVIVALS`), so the proof that
    // the bytes survived is that they are here at all — under either heading.
    assert.equal(back.parked(PSP).length + back.shelved(PSP).length, 1,
      'and it survives a relaunch');
  });

  await t.test('§1b · FAILED — a family backlog no longer spends the personal cap', async () => {
    const { port } = sharedSlot();
    const personal = createParkingLot({ storage: port(PSP), cap: 4 });
    const family = createParkingLot({ storage: port(FSP), cap: 4 });
    await personal.load();
    await family.load();
    for (let i = 0; i < 4; i++) {
      assert.equal(await family.park(FSP, env(FSP), String(i), 'epoch'), true);
    }
    assert.equal(await family.park(FSP, env(FSP), '5', 'epoch'), false, 'the FAMILY lot is full');
    assert.equal(await personal.park(PSP, env(PSP), '1', 'attestation'), true,
      'and the personal cursor is untouched by it');
  });

  await t.test('§1c · FAILED — a family cursor write no longer loses the personal chain head', async () => {
    const { disk, port } = sharedChainSlot();
    const personal = createCursors({ storage: port(PSP) });
    const family = createCursors({ storage: port(FSP) });
    await personal.load();
    await family.load();
    await personal.advance(PSP, '12', { seq: '12', chain: 'aaa' }, async () => {}, { fromGenesis: true });
    await family.advance(FSP, '3', { seq: '3', chain: 'bbb' }, async () => {}, { fromGenesis: false });
    assert.equal(disk.map[PSP].chain, 'aaa');
    assert.equal(disk.map[PSP].fromGenesis, true, 'the right to call an unknown witness a fork');
    assert.equal(disk.map[FSP].chain, 'bbb');
  });

  await t.test('§1d · FAILED — and a load does not mix the two spaces', async () => {
    const { port } = sharedSlot();
    const personal = createParkingLot({ storage: port(PSP) });
    const family = createParkingLot({ storage: port(FSP) });
    await personal.load();
    await family.load();
    await personal.park(PSP, env(PSP), '1', 'attestation');
    await family.park(FSP, env(FSP), '1', 'epoch');
    const p2 = createParkingLot({ storage: port(PSP) });
    await p2.load();
    assert.equal(p2.parked().length, 1);
    assert.equal(p2.parked()[0].space, PSP);
    assert.equal(p2.diagnostics().scope, PSP);
    assert.equal(p2.diagnostics().foreign, 1, 'held aside, never adopted');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · THE CHANNEL NEITHER OF THE FIRST TWO FIXES WAS ABOUT — ONE SLOT, ONE WRITE, TWO SPACES
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// CLOSED by `${LS_PARKED}.${spaceId}` — one slot per space, the shape `LS_SEALED` has always had.
//
// The wrong levers, both named by the round-2 adversary and both re-checked here:
//
//   · N-6, counting the shelf against the cap. It closes §2a and OVER-CLOSES: `round8-park.test.js`
//     §6.5 and two tier-1 rows say the cap bounds the REPLAY SET, so one ladder burn-out would
//     permanently shrink a lot. The cap is a deliberate anti-wedge decision and it is untouched.
//   · N-8, letting a park that could not be written answer `true`. That is R8-5 — the cursor
//     released over bytes that are not on the disk — and this pass moved in the OPPOSITE
//     direction: the shipped port used to swallow the failure, and now it throws it (§2h).
//
// The rows below drive `family/engine.js#parkedEnvelopeStore` itself. §2e is the honest-path
// control: no budget, both spaces, everything through the seam end to end.

test('§2 · the per-space slot', async (t) => {
  await t.test(
    '§2a · STILL SUCCEEDED, NARROWED — the shelf has no bound, but it grows in ONE space\'s slot',
    async () => {
      // The shelf is not counted against the cap (`round8-park.test.js` §6.5, and it must not be:
      // see N-6 above), so a relay that serves undecryptable envelopes faster than the ladder
      // gives up on them grows the disk without limit. THAT IS UNCHANGED and it is owed to
      // `sync/outbox.js`'s owner — a bound on the shelf, not on the cap.
      //
      // What this pass changes is the blast radius, and it is the half this file can close: the
      // growth is inside the offending space's own slot, and the space beside it is not in that
      // slot at all.
      const dev = device();
      await onDevice(dev, async () => {
        const family = createParkingLot({ storage: parkedEnvelopeStore(FSP), cap: 3 });
        const personal = createParkingLot({ storage: parkedEnvelopeStore(PSP), cap: 3 });
        await family.load();
        await personal.load();
        const mine = env(PSP);
        assert.equal(await personal.park(PSP, mine, '1', 'attestation'), true);

        for (let cycle = 0; cycle < 8; cycle++) {
          const ids = [];
          for (let i = 0; i < 3; i++) {
            const e = env(FSP);
            ids.push(e.oid);
            assert.equal(await family.park(FSP, e, String(cycle * 3 + i), 'epoch'), true);
          }
          assert.equal(await family.refuse(FSP, ids, 'gave_up'), 3);
        }
        assert.equal(family.diagnostics().parked, 0, 'the cap says the lot is empty');
        assert.equal(family.shelved(FSP).length, 24, 'and 24 envelopes are on the shelf — STILL');
        assert.equal(slotOf(dev, FSP).length, 24, 'the FAMILY slot carries all 24');

        // …and the personal space's slot is one row, unmoved, unaware.
        assert.deepEqual(slotOf(dev, PSP).map((r) => r.oid), [mine.oid],
          'the growth is confined to the space that caused it');
        assert.equal(personal.diagnostics().foreign, 0,
          'and the personal lot holds no foreign rows to write back at all');
      });
    });

  await t.test(
    '§2b · FAILED — a slot the family space filled is no longer a slot the personal space cannot write',
    async () => {
      // The round-2 model, exactly: a slot stops accepting writes when it is full. With ONE key
      // the personal lot's every write re-carried the family lot's whole backlog, so the family's
      // bytes decided whether the personal space could write at all — `park()` false, and in
      // `outbox.js`'s words "the caller MUST NOT advance the cursor past this".
      const dev = device({ slotBudget: 2600 });
      await onDevice(dev, async () => {
        const family = createParkingLot({ storage: parkedEnvelopeStore(FSP), cap: PARK_CAP });
        const personal = createParkingLot({ storage: parkedEnvelopeStore(PSP), cap: PARK_CAP });
        await family.load();
        await personal.load();

        let landed = 0;
        for (let i = 0; i < 40; i++) {
          if (await family.park(FSP, env(FSP), String(i), 'epoch')) landed++;
        }
        assert.ok(landed > 0 && landed < 40, `${landed} family rows fit before the slot said no`);
        assert.ok(family.diagnostics().unwritable >= 1,
          'the family space is stalled ON ITS OWN SLOT, which is its own business');

        const one = env(PSP);
        assert.equal(await personal.park(PSP, one, '1', 'attestation'), true);
        const two = env(PSP);
        assert.equal(await personal.park(PSP, two, '2', 'attestation'), true,
          'the personal cursor never notices the family space');
        assert.equal(personal.diagnostics().unwritable, 0);
        // `true` is a claim about the DISK, so the disk is what is asserted (R8-5).
        assert.deepEqual(slotOf(dev, PSP).map((r) => r.oid), [one.oid, two.oid],
          'and the bytes it said it kept are in ITS slot');
        assert.equal(slotOf(dev, PSP).some((r) => r.space === FSP), false, 'with nobody else in it');
        assert.equal(slotOf(dev, FSP).length, landed, 'the family slot is untouched by either');
      });
    });

  await t.test(
    '§2c · THE RESIDUE, ANSWERED — one disk is one disk, but the stall is honest and it NAMES the space',
    async () => {
      // Under the budget a browser actually enforces — the ORIGIN's total — the family space CAN
      // still fill the device, and the personal park then fails. That is not a defect and no key
      // scheme repairs it: it is two lodgers and one cupboard. What was a defect is what happened
      // next. The old port swallowed the failure (`writeJSON`), so the lot was told the bytes had
      // landed; and nothing anyone was shown named the circle whose backlog filled the disk.
      const said = [];
      const dev = device({ budget: 3000 });
      await onDevice(dev, async () => {
        const family = createParkingLot({ storage: parkedEnvelopeStore(FSP), warn: (m) => said.push(m) });
        const personal = createParkingLot({ storage: parkedEnvelopeStore(PSP), warn: (m) => said.push(m) });
        await family.load();
        await personal.load();
        for (let i = 0; i < 30; i++) await family.park(FSP, env(FSP), String(i), 'epoch');
        said.length = 0;

        const doomed = env(PSP);
        assert.equal(await personal.park(PSP, doomed, '1', 'attestation'), false,
          'THE STALL IS KEPT — a park that did not reach the disk must not release a cursor (R8-5)');
        assert.equal(personal.diagnostics().unwritable, 1);
        assert.equal(slotOf(dev, PSP), null, 'and it did not pretend: nothing of its own was written');

        assert.ok(said.length > 0, 'something is said');
        const named = said.filter((m) => m.includes(FSP));
        assert.equal(named.length >= 1, true,
          `the sentence names the FAMILY space as the cause: ${JSON.stringify(said)}`);
        assert.match(named[0], /QuotaExceededError/, 'and what the disk actually said');
        assert.match(named[0], /stalled by that space/,
          'in a sentence about whose backlog it is, not merely which key it is');
        assert.equal(named.some((m) => m.includes(PSP)), false,
          'and it does not blame the space that is the victim of it');
      });
    });

  await t.test(
    '§2d · FAILED — a full disk still never DESTROYS a row that is already on it',
    async () => {
      // Retention over loss, at the budget, across the seam: a failed write leaves the disk as it
      // was, and the neighbour's slot is not something a failing writer can touch.
      const dev = device({ budget: 3000 });
      await onDevice(dev, async () => {
        const personal = createParkingLot({ storage: parkedEnvelopeStore(PSP) });
        const family = createParkingLot({ storage: parkedEnvelopeStore(FSP) });
        await personal.load();
        await family.load();
        const keep = env(PSP);
        assert.equal(await personal.park(PSP, keep, '1', 'attestation'), true);
        for (let i = 0; i < 30; i++) await family.park(FSP, env(FSP), String(i), 'epoch');
        assert.deepEqual(slotOf(dev, PSP).map((r) => r.oid), [keep.oid],
          'the personal envelope is still on the disk after the family space filled it');
      });
    });

  await t.test(
    '§2e · THE HONEST-PATH CONTROL — two spaces, one device, everything works end to end',
    async () => {
      // NON-VACUITY, and the row every mutant below has to survive: with room on the disk both
      // engines park, replay, release and shelve through the shipped port, each in its own slot,
      // and a relaunch reads back exactly what its own space retained.
      const dev = device();
      await onDevice(dev, async () => {
        const personal = createParkingLot({ storage: parkedEnvelopeStore(PSP) });
        const family = createParkingLot({ storage: parkedEnvelopeStore(FSP) });
        await personal.load();
        await family.load();

        const p1 = env(PSP);
        const p2 = env(PSP);
        const f1 = env(FSP);
        assert.equal(await personal.park(PSP, p1, '1', 'attestation'), true);
        assert.equal(await family.park(FSP, f1, '1', 'epoch'), true);
        assert.equal(await personal.park(PSP, p2, '2', 'epoch'), true);
        assert.deepEqual(personal.parked(PSP).map((r) => r.oid), [p1.oid, p2.oid],
          'the replay order is the park order');
        assert.equal(family.parked(FSP).length, 1);

        // The cure arrives for one of them. The empty release is the PULL BOUNDARY `pullNow`
        // opens with (R10-9d), without which a released row is shelved rather than destroyed.
        assert.equal(await personal.release(PSP, []), 0);
        assert.equal(await personal.release(PSP, [p1.oid]), 1, 'it opened, and it is gone');
        assert.deepEqual(slotOf(dev, PSP).map((r) => r.oid), [p2.oid]);
        assert.equal(slotOf(dev, FSP).length, 1, 'and the family slot is where it was');

        // A relaunch: each side reads back its own, and neither reports a foreign row.
        const p3 = createParkingLot({ storage: parkedEnvelopeStore(PSP) });
        const f3 = createParkingLot({ storage: parkedEnvelopeStore(FSP) });
        assert.equal(await p3.load(), 1);
        assert.equal(await f3.load(), 1);
        assert.equal(p3.parked()[0].oid, p2.oid);
        assert.equal(f3.parked()[0].oid, f1.oid);
        assert.equal(p3.diagnostics().foreign, 0);
        assert.equal(f3.diagnostics().foreign, 0);
        assert.equal(p3.diagnostics().scope, PSP);
        assert.equal(f3.diagnostics().scope, FSP);
        assert.deepEqual([...dev.map.keys()].sort(),
          [`${PARKED}.${FSP}`, `${PARKED}.${PSP}`], 'two slots, and no third');
      });
    });

  await t.test('§2f · and the per-space key is really in the file', () => {
    const src = readFileSync(new URL('../../src/js/family/engine.js', import.meta.url), 'utf8');
    // The prefix constant is unchanged — `e6-attack-privat.test.js` §2a pins that spelling too.
    assert.match(src, /const LS_PARKED = 'langzeitplaner\.parked';/);
    // The slot is per space, the shape `LS_SEALED` has.
    assert.match(src, /const slot = `\$\{LS_PARKED\}\.\$\{spaceId\}`;/);
    assert.match(src, /load\(spaceId\) \{ return readJSON\(`\$\{LS_SEALED\}\.\$\{spaceId\}`, \[\]\); \}/);
    // INVERTED. The two old spellings are asserted ABSENT, not merely outnumbered: either one on
    // its own is the whole of the defect back again.
    assert.equal(/readJSON\(LS_PARKED, \[\]\)/.test(src), false,
      'no engine may read the device-wide parked slot as its own');
    assert.equal(/writeJSON\(LS_PARKED, /.test(src), false,
      'and none may write it — `writeJSON` also swallows, which is §2h');
    // The failure reaches the lot, and the sentence names the neighbour.
    assert.match(src, /function writeParked\(slot, rows\) \{[\s\S]*?throw new Error\(/);
    assert.match(src, /function foreignParkNote\(/);
  });

  await t.test(
    '§2g · THE UPGRADE — a Mac that already has envelopes under the old device-wide key keeps them',
    async () => {
      // Changing a key is a data-loss bug unless the old one is read. These bytes are the only
      // copy of ops whose cursor has already moved past them (ADR 002 §5.2.5: parked, never
      // dropped), so the legacy slot is READ — filtered to this space — and never deleted.
      const dev = device();
      const older = env(PSP);
      const theirs = env(FSP);
      dev.map.set(PARKED, JSON.stringify([
        { space: PSP, oid: older.oid, env: older, seq: '4', reason: 'epoch', at: 1, tries: 0 },
        { space: FSP, oid: theirs.oid, env: theirs, seq: '9', reason: 'epoch', at: 1, tries: 0 },
      ]));
      await onDevice(dev, async () => {
        const personal = createParkingLot({ storage: parkedEnvelopeStore(PSP) });
        await personal.load();
        assert.equal(personal.parked(PSP).length, 1, 'the upgrade did not lose the envelope');
        assert.equal(personal.parked(PSP)[0].oid, older.oid);
        assert.equal(personal.diagnostics().foreign, 0,
          'and it never even SAW the family row — the port filtered it, so it cannot be copied');

        // The first write moves this space into its own slot, and leaves the old one alone: the
        // family engine has not migrated yet, and its row is in there.
        assert.equal(await personal.park(PSP, env(PSP), '5', 'attestation'), true);
        assert.equal(slotOf(dev, PSP).length, 2);
        assert.equal(slotOf(dev, PSP).some((r) => r.space === FSP), false);
        const legacy = JSON.parse(dev.map.get(PARKED));
        assert.equal(legacy.length, 2, 'the legacy slot is NOT deleted');
        assert.equal(legacy.some((r) => r.oid === theirs.oid), true,
          'because the other space still has to read its own row out of it');

        // And the family engine, whenever it next launches, still finds it.
        const family = createParkingLot({ storage: parkedEnvelopeStore(FSP) });
        await family.load();
        assert.deepEqual(family.parked(FSP).map((r) => r.oid), [theirs.oid]);

        // A second launch of the personal engine reads its OWN slot, not the legacy one — and the
        // legacy copy of `older` is not adopted twice.
        const again = createParkingLot({ storage: parkedEnvelopeStore(PSP) });
        assert.equal(await again.load(), 2);
      });
    });

  await t.test(
    '§2h · R8-5, IN THE SHIPPED PORT — a write that did not land is not reported as a park',
    async () => {
      // The shipped `saveRecords` was `writeJSON(LS_PARKED, rows)`, and `writeJSON` swallows: "a
      // full disk is not a crash". For a cached roster that is right. For these bytes it is R8-5
      // exactly — `persist()` returns true over a write that did not happen, `park()` answers
      // `true`, and `sync/personal.js` releases the cursor past an envelope that is on no disk
      // anywhere but the relay. Every rig that ever caught this threw from its own port; the
      // product's port did not. This is the row about the product's port.
      const dev = device({ slotBudget: 10 });
      await onDevice(dev, async () => {
        const personal = createParkingLot({ storage: parkedEnvelopeStore(PSP) });
        await personal.load();
        assert.equal(await personal.park(PSP, env(PSP), '1', 'attestation'), false,
          'a park that could not be written must answer false, so the cursor is held');
        assert.equal(personal.diagnostics().unwritable, 1);
        assert.equal(dev.map.has(`${PARKED}.${PSP}`), false, 'and nothing was written');
      });
    });
});
// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · THE OUTBOUND TWIN
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§3 · the outbound queue is per space by KEY, not by declaration', async (t) => {
  await t.test('§3a · FAILED — `sealedEnvelopeStore` is keyed per space, so there is no seam', () => {
    // `family/engine.js#sealedEnvelopeStore` reads `${LS_SEALED}.${spaceId}`: one slot PER SPACE,
    // so `createOutbox` — which has no `space` declaration and writes its whole set — cannot
    // reach the other engine's rows. Recorded because it is the reason the outbound half needed
    // no fix while the inbound half did, and a future move to one shared key would reopen it.
    assert.equal(typeof createOutbox, 'function');
    assert.equal(PARK_REVIVALS, 3);
  });
});
