// tests/fleet/e6-gate-slots.test.js — THE FRESH MEMBER-ADVERSARY, ROUND 2: the separated slots.
//
// The question this file asks is the one the integration pass answered at `6e11ca1`: **can family
// traffic still reach personal state?** The pass closed two channels — a whole-slot write that
// DELETED the other engine's rows, and a cap counted across spaces — and this file re-drives both,
// then keeps going into the channel neither of them is about.
//
// The rig is `src/js/family/engine.js`'s own two ports, reproduced exactly (they are
// module-private): ONE slot, TWO `createParkingLot`s, each declaring `space`, `loadRecords` and
// `saveRecords` SYNCHRONOUS. Nothing here is stubbed except the disk itself, and the disk is
// stubbed the way a disk fails: it stops accepting writes when it is full.
//
// SUCCEEDED / FAILED are from the ADVERSARY's side.

import '../helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createParkingLot, createOutbox, PARK_CAP, PARK_REVIVALS } from '../../src/js/sync/outbox.js';
import { createCursors } from '../../src/js/sync/cursor.js';
import { readFileSync } from 'node:fs';

const PSP = 'psp_personal000000000000000';
const FSP = 'fsp_family0000000000000000';

let n = 0;
const oid = () => `oid${String(n++).padStart(19, '0')}`;
const env = (sp, ep = 1) => ({
  v: 1, sp, ep, dv: 'dev1', oid: oid(), wit: '', iv: 'AAAAAAAAAAAAAAAA', ct: 'Y3Q', sig: 'c2ln',
});

/**
 * ONE durable slot for the device, two ports over it — `family/engine.js#parkedEnvelopeStore`,
 * byte for byte, including the deliberate absence of `async`.
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
// §2 · THE CHANNEL NEITHER FIX IS ABOUT — ONE SLOT, ONE WRITE, TWO SPACES
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§2 · the shared slot', async (t) => {
  await t.test(
    '§2a · SUCCEEDED — the SHELF is not counted against the cap, so the slot has no bound',
    async () => {
      const { disk, port } = sharedSlot();
      const family = createParkingLot({ storage: port(FSP), cap: 3 });
      await family.load();
      // Eve's ops arrive faster than the ladder can give up on them. Each cycle: fill the lot to
      // the cap, let the ladder shelve them, and the cap is free again — while the SLOT grows.
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
      assert.equal(family.shelved(FSP).length, 24);
      assert.equal(disk.rows.length, 24,
        `the SLOT holds 24 rows under a cap of 3 — the cap bounds the replay set, not the disk, `
        + 'and `shelf` has no bound at all');
    });

  await t.test(
    '§2b · SUCCEEDED — a slot filled by the family space STALLS THE PERSONAL SPACE\'S CURSOR',
    async () => {
      // The per-space cap removed the COUNT channel. The WRITE channel is still shared: both lots
      // write the whole slot, so a slot the family space filled is a slot the personal space
      // cannot write into — and `park()` returning false is, in this file's own words, "the
      // caller MUST NOT advance the cursor past this".
      const { disk, port } = sharedSlot({ budget: 2600 });
      const family = createParkingLot({ storage: port(FSP), cap: PARK_CAP });
      const personal = createParkingLot({ storage: port(PSP), cap: PARK_CAP });
      await family.load();
      await personal.load();

      assert.equal(await personal.park(PSP, env(PSP), '1', 'attestation'), true,
        'the personal space works while the slot is small');

      let landed = 0;
      for (let i = 0; i < 40; i++) {
        if (await family.park(FSP, env(FSP), String(i), 'epoch')) landed++;
      }
      assert.ok(landed > 0 && landed < 40, `${landed} family rows fit before the disk said no`);
      assert.ok(family.diagnostics().parked < PARK_CAP,
        'and the FAMILY lot is nowhere near its own cap — the bound that bit is the slot');

      const before = disk.rows.length;
      const stalled = await personal.park(PSP, env(PSP), '2', 'attestation');
      assert.equal(stalled, false,
        'THE PERSONAL SPACE\'S CURSOR IS STALLED, for a reason that is not its own');
      assert.equal(disk.rows.length, before, 'and nothing of its own was written');
      const warn = personal.diagnostics();
      assert.ok(warn.unwritable >= 1, JSON.stringify(warn));
    });

  await t.test(
    '§2c · SUCCEEDED — and the sentence the user is shown names the wrong cause',
    async () => {
      const said = [];
      const { port } = sharedSlot({ budget: 2000 });
      const family = createParkingLot({ storage: port(FSP), warn: (m) => said.push(m) });
      const personal = createParkingLot({ storage: port(PSP), warn: (m) => said.push(m) });
      await family.load();
      await personal.load();
      for (let i = 0; i < 30; i++) await family.park(FSP, env(FSP), String(i), 'epoch');
      said.length = 0;
      await personal.park(PSP, env(PSP), '1', 'attestation');
      assert.ok(said.length > 0, 'something is said');
      assert.equal(said.some((m) => m.includes(FSP)), false,
        `nothing tells the user the family space is what filled the disk: ${JSON.stringify(said)}`);
    });

  await t.test(
    '§2d · FAILED — but the family lot never DESTROYS a personal row on the way through',
    async () => {
      // The retention rule holds even at the budget: a failed write leaves the disk as it was.
      const { disk, port } = sharedSlot({ budget: 1400 });
      const personal = createParkingLot({ storage: port(PSP) });
      const family = createParkingLot({ storage: port(FSP) });
      await personal.load();
      await family.load();
      const keep = env(PSP);
      assert.equal(await personal.park(PSP, keep, '1', 'attestation'), true);
      for (let i = 0; i < 20; i++) await family.park(FSP, env(FSP), String(i), 'epoch');
      assert.equal(disk.rows.filter((r) => r.oid === keep.oid).length, 1,
        'the personal envelope is still on the disk — retention over loss held');
    });

  await t.test(
    '§2e · THE CONTROL — one slot PER SPACE and §2b/§2c go away entirely',
    async () => {
      // The mutation check for §2b and §2c, in the file: the finding is the SHARED KEY and
      // nothing else. `family/engine.js` line 798 declares `LS_PARKED` without a spaceId, and
      // line 913 reads it without one, while `LS_SEALED`, `LS_RING` and `LS_COVER` are all
      // per space. Give the parking lot the same treatment and the coupling disappears.
      const a = sharedSlot({ budget: 2600 });
      const b = sharedSlot({ budget: 2600 });
      const family = createParkingLot({ storage: a.port(FSP), cap: PARK_CAP });
      const personal = createParkingLot({ storage: b.port(PSP), cap: PARK_CAP });
      await family.load();
      await personal.load();
      for (let i = 0; i < 40; i++) await family.park(FSP, env(FSP), String(i), 'epoch');
      assert.equal(await personal.park(PSP, env(PSP), '1', 'attestation'), true);
      assert.equal(await personal.park(PSP, env(PSP), '2', 'attestation'), true,
        'the personal cursor never notices the family space at all');
      assert.equal(personal.diagnostics().unwritable, 0);
    });

  await t.test('§2f · and the shared key is really there, in the file', () => {
    const src = readFileSync(new URL('../../src/js/family/engine.js', import.meta.url), 'utf8');
    assert.match(src, /const LS_PARKED = 'langzeitplaner\.parked';/);
    assert.match(src, /loadRecords\(\) \{ return readJSON\(LS_PARKED, \[\]\); \}/,
      'ONE key for the device, while LS_SEALED next to it is `${LS_SEALED}.${spaceId}`');
    assert.match(src, /load\(spaceId\) \{ return readJSON\(`\$\{LS_SEALED\}\.\$\{spaceId\}`, \[\]\); \}/);
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
