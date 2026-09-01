// tests/fleet/e6-gate-keys.test.js — THE FRESH MEMBER-ADVERSARY, ROUND 2: the new coverage proof
// and the write-once wrap cell.
//
// Eve is invited, attested, non-admin, running her own client. She forges nothing. What she does
// have is the one privilege `limits.js` grants her without a budget:
//
//     RATE_COVERAGE.rotateEpoch = "serialised by first-writer-wins on Epoch; a flood costs the
//     attacker their own space's epoch numbers and nothing else"
//
// This file measures what "and nothing else" is worth.
//
// Under attack: `src/js/sync/keys.js` §4 (the coverage record, T5-K1/K2), the four-column
// `KeyWrap` cell (T5-K3) in `server/adapters/memory.js`, and `server/core/handlers/spaces.js`'s
// `assertCoverage` + `MAX_WRAPS`.
//
// SUCCEEDED / FAILED are from the ADVERSARY's side.

import '../helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSpaceKey } from '../../src/js/crypto/spacekeys.js';
import { DELIVERY } from '../../src/js/sync/keys.js';
import { MAX_WRAPS } from '../../server/core/handlers/spaces.js';

import {
  buildCircle, join, refreshRoster, bootMac, engineFor, on,
  junkWrap, rosterDeviceIdsOf, catchUpRing, genuineWrap,
} from './e6-attack-circle.js';

const rosterOf = async (C, mac) => (await mac.transport.request(
  'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined, {})).json;

const keysOf = async (C, mac) => (await mac.transport.request(
  'GET', `/api/v1/spaces/${C.spaceId}/keys`, undefined, undefined, {})).json;

const postEpoch = (C, mac, epoch, wraps) => mac.transport.request(
  'POST', `/api/v1/spaces/${C.spaceId}/epoch`, undefined, { epoch, wraps }, {});

/**
 * THE CHEAP ROTATION — what an attacker's client sends, as opposed to what `keys.js#rotateTo`
 * sends.
 *
 * `assertCoverage` needs a row for every recipient at every epoch `1..e`, and rows already
 * deposited count. So once every recipient has a row for every epoch below, the minimum a rotator
 * must submit is ONE wrap per recipient for the NEW epoch. `keys.js#rotateTo` submits
 * `recipients × 1..next` on every rotation instead; that asymmetry is the whole of §1.
 */
async function cheapRotate(C, attacker, epoch, wrapFor) {
  const list = await rosterOf(C, attacker);
  const wraps = [];
  for (const id of rosterDeviceIdsOf(list.members)) {
    wraps.push({ recipientId: id, epoch, wrapped: await wrapFor(id, epoch, list) });
  }
  return postEpoch(C, attacker, epoch, wraps);
}

/** A rotation that backfills everything missing: recipients × 1..epoch. */
async function fullRotate(C, attacker, epoch, wrapFor) {
  const list = await rosterOf(C, attacker);
  const wraps = [];
  for (const id of rosterDeviceIdsOf(list.members)) {
    for (let e = 1; e <= epoch; e++) {
      wraps.push({ recipientId: id, epoch: e, wrapped: await wrapFor(id, e, list) });
    }
  }
  return postEpoch(C, attacker, epoch, wraps);
}

/**
 * A three-member circle in its STEADY state: Papa founded, Mama and Eve joined, and Papa's engine
 * has actually delivered the ring, so everybody — including Eve — holds epochs 1..2.
 *
 * That is the state a real attacker starts from: she is a member who can read the family board.
 */
async function settled(extra = []) {
  const C = await buildCircle(['papa', 'mama', 'eve', ...extra]);
  assert.equal((await join(C, C.mama)).status, 200);
  assert.equal((await join(C, C.eve)).status, 200);
  await refreshRoster(C);
  await bootMac(C, C.papa);
  await on(C.papa, async () => {
    C.papa.engine = engineFor(C, C.papa);
    const d = await C.papa.engine.keys.deliver({ reason: 'settle' });
    assert.equal(d.verdict, DELIVERY.DELIVERED, JSON.stringify(d));
  });
  await catchUpRing(C, C.mama);
  await catchUpRing(C, C.eve);
  assert.equal(C.eve.ring.covers(C.spaceId, 2), true, 'Eve is an ordinary, fully-keyed member');
  return C;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · THE EPOCH LADDER — an unmetered counter that only goes up, and a payload that scales on it
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§1 · the epoch ladder freeze', async (t) => {
  await t.test(
    '§1a · SUCCEEDED — Eve climbs the ladder for free, and the shipped rotation stops fitting',
    async () => {
      const C = await settled(['oma']);
      assert.equal((await join(C, C.oma)).status, 200);
      await refreshRoster(C);
      const junk = await junkWrap(C, 1);
      // One full rotation to seed Oma's empty cells, then the cheap ones. The relay never opens a
      // wrap (`assertCoverage`: "A ROW COUNT, AND NOTHING MORE"), so the bytes cost Eve nothing.
      assert.equal((await fullRotate(C, C.eve, 3, () => junk)).status, 200);
      for (let e = 4; e <= 256; e++) {
        assert.equal((await cheapRotate(C, C.eve, e, () => junk)).status, 200, `epoch ${e}`);
      }
      const at = (await rosterOf(C, C.eve)).currentEpoch;
      assert.equal(at, 256, 'the counter is attacker-controlled and unmetered');

      const recipients = rosterDeviceIdsOf((await rosterOf(C, C.papa)).members);
      assert.equal(recipients.length, 4);
      const shipped = recipients.length * (at + 1);
      assert.ok(shipped > MAX_WRAPS,
        `keys.js#rotateTo sends recipients × 1..next = ${shipped} wraps and MAX_WRAPS is `
        + `${MAX_WRAPS}: past here the shipped client cannot rotate at all`);

      // Measured, not computed: the relay really refuses the payload the client would send.
      const wraps = [];
      for (const id of recipients) {
        for (let e = 1; e <= at + 1; e++) wraps.push({ recipientId: id, epoch: e, wrapped: junk });
      }
      const refused = await postEpoch(C, C.papa, at + 1, wraps);
      assert.equal(refused.status, 413);
      assert.equal(refused.json.error, 'payload_too_large');
      assert.equal(refused.json.field, 'wraps');
    });

  await t.test(
    '§1b · SUCCEEDED — driven through the SHIPPED client, and the family never sees it coming',
    async () => {
      const C = await settled(['oma']);
      // Eve climbs with GENUINE wraps: every ring stays whole, every board keeps working, no
      // warning fires anywhere. This is the quiet version, and it is the realistic one.
      for (let e = 3; e <= 40; e++) {
        const k = await createSpaceKey();
        const res = await cheapRotate(C, C.eve, e,
          (id, ep, list) => genuineWrap(C, C.eve, list, id, ep, k));
        assert.equal(res.status, 200, `epoch ${e}`);
      }
      await catchUpRing(C, C.papa);
      assert.equal(C.papa.ring.covers(C.spaceId, 40), true, 'the family is HEALTHY at epoch 40');

      // Oma joins. 4 × 41 = 164 wraps: still under the cap, so the honest path still works…
      assert.equal((await join(C, C.oma)).status, 200);
      await refreshRoster(C);
      let d;
      await on(C.papa, async () => {
        C.papa.engine = engineFor(C, C.papa);
        await C.papa.engine.keys.admit();
        d = await C.papa.engine.keys.deliver({ reason: 'join' });
      });
      assert.equal(d.verdict, DELIVERY.DELIVERED, JSON.stringify(d));
      await catchUpRing(C, C.oma);
      assert.equal(C.oma.ring.covers(C.spaceId, 41), true, 'below the wall Oma gets her history');

      // …and now Eve walks it past the wall. 4 recipients, so the wall is at epoch 256.
      for (let e = 42; e <= 256; e++) {
        const k = await createSpaceKey();
        assert.equal((await cheapRotate(C, C.eve, e,
          (id, ep, list) => genuineWrap(C, C.eve, list, id, ep, k))).status, 200, `epoch ${e}`);
      }
      await catchUpRing(C, C.papa);
      assert.equal(C.papa.ring.covers(C.spaceId, 256), true,
        'NON-VACUITY: Papa holds the WHOLE ring — nothing is wrong with him');

      let after;
      await on(C.papa, async () => {
        C.papa.engine = engineFor(C, C.papa);
        await C.papa.engine.keys.admit();
        after = await C.papa.engine.keys.rotate('member.remove');
      });
      assert.equal(after.verdict, DELIVERY.REFUSED, JSON.stringify(after));
      assert.equal(after.status, 413);
      assert.equal(after.error, 'payload_too_large');
      // ADR 002 §4.1's "a removal forces e+1" is now unperformable by any device in this circle,
      // for ever: the epoch only goes up and there is no route that prunes one.
    });

  await t.test(
    '§1c · SUCCEEDED — past epoch MAX_WRAPS even a MINIMAL client cannot deliver to one joiner',
    async () => {
      // A future `rotateTo` that sent only the missing rows would still hit the wall, because a
      // joiner needs `1..e` rows OF HER OWN and `MAX_WRAPS` is a per-REQUEST cap with no
      // continuation. `keys.js` states there is no route that deposits a wrap outside a rotation,
      // so there is no second request to put the rest in.
      const C = await settled();
      const junk = await junkWrap(C, 1);
      for (let e = 3; e <= MAX_WRAPS + 2; e++) {
        assert.equal((await cheapRotate(C, C.eve, e, () => junk)).status, 200, `epoch ${e}`);
      }
      const at = (await rosterOf(C, C.eve)).currentEpoch;
      assert.ok(at > MAX_WRAPS, `epoch ${at} > MAX_WRAPS ${MAX_WRAPS}`);
      const wraps = [];
      for (let e = 1; e <= at + 1; e++) {
        wraps.push({ recipientId: C.papa.forStore.deviceId, epoch: e, wrapped: junk });
      }
      assert.ok(wraps.length > MAX_WRAPS);
      assert.equal((await postEpoch(C, C.papa, at + 1, wraps)).status, 413,
        'the ladder is one-way, the cap is per request, and there is no second request');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · STARVING A JOINER BY WINNING EVERY RACE
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§2 · the coverage proof, and the race it cannot win', async (t) => {
  await t.test(
    '§2a · SUCCEEDED — Eve wins every epoch race and Oma is never delivered to, on any tick',
    async () => {
      const C = await settled(['oma']);
      assert.equal((await join(C, C.oma)).status, 200);
      await refreshRoster(C);
      const junk = await junkWrap(C, 1);
      assert.equal((await fullRotate(C, C.eve, 3, () => junk)).status, 200);

      const verdicts = [];
      await on(C.papa, async () => {
        C.papa.engine = engineFor(C, C.papa);
        for (let tick = 0; tick < 12; tick++) {
          // Eve rotates first on every tick. She spends no budget: `RATE_COVERAGE` declares
          // `rotateEpoch` unlimited, on the argument that a flood costs her "nothing else".
          const at = (await rosterOf(C, C.eve)).currentEpoch;
          assert.equal((await cheapRotate(C, C.eve, at + 1, () => junk)).status, 200);
          await C.papa.engine.keys.admit();
          verdicts.push((await C.papa.engine.keys.deliver({ reason: 'tick' })).verdict);
        }
      });
      assert.equal(verdicts.includes(DELIVERY.DELIVERED), false, JSON.stringify(verdicts));
      await catchUpRing(C, C.oma);
      assert.deepEqual(C.oma.ring.epochs(C.spaceId), [],
        'twelve ordinary ticks later Oma holds nothing at all');
      assert.ok((await keysOf(C, C.oma)).wraps.length > 0,
        'and the relay is satisfied — it counted the rows (ADR 002 §4.2, finding T5-K1)');
    });

  await t.test(
    '§2b · FAILED — Eve cannot make Papa BELIEVE he delivered: the record is his own 200s',
    async () => {
      const C = await settled(['oma']);
      assert.equal((await join(C, C.oma)).status, 200);
      await refreshRoster(C);
      const junk = await junkWrap(C, 1);
      assert.equal((await fullRotate(C, C.eve, 3, () => junk)).status, 200);
      let cov; let d;
      await on(C.papa, async () => {
        C.papa.engine = engineFor(C, C.papa);
        await C.papa.engine.keys.admit();
        const at = (await rosterOf(C, C.eve)).currentEpoch;
        assert.equal((await cheapRotate(C, C.eve, at + 1, () => junk)).status, 200);
        d = await C.papa.engine.keys.deliver({ reason: 'tick' });
        cov = C.papa.engine.keys.coverage();
      });
      assert.ok(d.verdict !== DELIVERY.DELIVERED && d.verdict !== DELIVERY.COVERED, d.verdict);
      assert.equal(cov.source, 'self-delivery');
      assert.equal(cov.durable, true, 'NON-VACUITY: a false record WOULD have survived a relaunch');
      assert.equal(
        cov.proof === null || !cov.proof.ids.includes(C.oma.forStore.deviceId), true,
        'a 409 is news about an epoch NUMBER, and Eve\'s word is not Papa\'s proof (T5-K1)');
    });

  await t.test(
    '§2c · FAILED — a half-delivered ring buys Eve no witness credit and no silence',
    async () => {
      // Source 2 of §4 is "it delivered to me", read off `ring.originOf` — stamped by
      // `admitWraps` AFTER a wrap opened, on the receiving device. Eve delivers epoch 3 to Oma
      // for real and leaves 1..2 as junk: the ring is not whole, so nothing is credited and
      // `keysPending` does not clear.
      const C = await settled(['oma']);
      assert.equal((await join(C, C.oma)).status, 200);
      await refreshRoster(C);
      const junk = await junkWrap(C, 1);
      const k3 = await createSpaceKey();
      const list = await rosterOf(C, C.eve);
      const wraps = [];
      for (const id of rosterDeviceIdsOf(list.members)) {
        for (let e = 1; e <= 3; e++) {
          const real = (e === 3);
          wraps.push({
            recipientId: id, epoch: e,
            wrapped: real ? await genuineWrap(C, C.eve, list, id, e, k3) : junk,
          });
        }
      }
      assert.equal((await postEpoch(C, C.eve, 3, wraps)).status, 200);
      await catchUpRing(C, C.oma);
      assert.deepEqual(C.oma.ring.epochs(C.spaceId), [3]);
      assert.equal(C.oma.ring.covers(C.spaceId, 3), false, 'a ring that decrypts and is incomplete');

      // And Papa still owes her a delivery — Eve is not in his `held` set for any reason.
      let d;
      await on(C.papa, async () => {
        C.papa.engine = engineFor(C, C.papa);
        await C.papa.engine.keys.admit();
        d = await C.papa.engine.keys.deliver({ reason: 'after' });
      });
      assert.equal(d.verdict, DELIVERY.DELIVERED);
      assert.ok(d.uncovered.includes(C.oma.forStore.deviceId));
      await catchUpRing(C, C.oma);
      assert.equal(C.oma.ring.covers(C.spaceId, 4), true, 'the honest delivery heals her');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · THE WRITE-ONCE CELL — and the denial the fix could have created
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§3 · write-once wraps', async (t) => {
  await t.test(
    '§3a · FAILED — Eve cannot squat a row addressed to somebody else: the cell names the depositor',
    async () => {
      const C = await settled(['oma']);
      assert.equal((await join(C, C.oma)).status, 200);
      await refreshRoster(C);
      const junk = await junkWrap(C, 1);
      const k3 = await createSpaceKey();
      const list = await rosterOf(C, C.eve);
      // Eve fills EVERY one of Oma's empty cells for 1..3 with bytes nobody can open, while
      // keeping the rest of the family whole so nothing looks wrong.
      const wraps = [];
      for (const id of rosterDeviceIdsOf(list.members)) {
        for (let e = 1; e <= 3; e++) {
          const mine = id === C.oma.forStore.deviceId;
          if (mine) { wraps.push({ recipientId: id, epoch: e, wrapped: junk }); continue; }
          if (e < 3) continue;                       // Papa/Mama/Eve already hold rows for 1..2
          wraps.push({ recipientId: id, epoch: e, wrapped: await genuineWrap(C, C.eve, list, id, e, k3) });
        }
      }
      assert.equal((await postEpoch(C, C.eve, 3, wraps)).status, 200);

      let d;
      await on(C.papa, async () => {
        C.papa.engine = engineFor(C, C.papa);
        await C.papa.engine.keys.admit();
        d = await C.papa.engine.keys.deliver({ reason: 'heal' });
      });
      assert.equal(d.verdict, DELIVERY.DELIVERED,
        'the honest backfill lands BESIDE the junk — under a three-column cell it was refused');
      await catchUpRing(C, C.oma);
      assert.equal(C.oma.ring.covers(C.spaceId, 4), true,
        'Oma holds the WHOLE history — C61\'s healing path, alive');
    });

  await t.test(
    '§3b · FAILED — an honest second pass is not refused into a dead end',
    async () => {
      const C = await settled(['oma']);
      assert.equal((await join(C, C.oma)).status, 200);
      await refreshRoster(C);
      let first; let second;
      await on(C.papa, async () => {
        C.papa.engine = engineFor(C, C.papa);
        first = await C.papa.engine.keys.deliver({ reason: 'one' });
        second = await C.papa.engine.keys.deliver({ reason: 'two' });
      });
      assert.equal(first.verdict, DELIVERY.DELIVERED);
      assert.equal(second.verdict, DELIVERY.COVERED, 'no dead end, and no wasted rotation');
      await catchUpRing(C, C.oma);
      assert.equal(C.oma.ring.covers(C.spaceId, 3), true);
    });

  await t.test(
    '§3c · FAILED — a retry by a device that FORGOT its record re-rotates, and lands',
    async () => {
      // The write-once rule's honest-denial question, asked the hard way: a device whose coverage
      // record was lost (a fresh install, a cleared `localStorage`) delivers again over cells it
      // already owns. The four-column cell makes those its OWN rows, so they are `kept` rather
      // than refused-with-nothing-to-show, and the rotation still lands.
      const C = await settled(['oma']);
      assert.equal((await join(C, C.oma)).status, 200);
      await refreshRoster(C);
      let one; let two; let res;
      await on(C.papa, async () => {
        C.papa.engine = engineFor(C, C.papa);
        one = await C.papa.engine.keys.deliver({ reason: 'one' });
        // The record is gone; the ring is not. Build a second delivery over the same ring.
        const fresh = engineFor(C, C.papa, { coverStore: undefined });
        two = await fresh.keys.deliver({ reason: 'forgot' });
        res = fresh.keys.diagnostics();
      });
      assert.equal(one.verdict, DELIVERY.DELIVERED);
      assert.equal(two.verdict, DELIVERY.DELIVERED, 'a forgotten record costs one extra rotation');
      assert.ok(res.epochs.length >= 3);
      await catchUpRing(C, C.oma);
      assert.equal(C.oma.ring.covers(C.spaceId, 4), true, 'and nothing was lost');
    });

  await t.test(
    '§3d · SUCCEEDED — every squat is a PERMANENT row, and no route can ever delete one',
    async () => {
      const C = await settled();
      const junk = await junkWrap(C, 1);
      for (let e = 3; e <= 42; e++) {
        assert.equal((await cheapRotate(C, C.eve, e, () => junk)).status, 200);
      }
      const rows = (await keysOf(C, C.papa)).wraps;
      assert.ok(rows.length >= 40,
        `${rows.length} rows addressed to one device, most of which will never open, none of `
        + 'which any route can remove. The stated cost of the four-column cell is "rows, not '
        + 'data" — and §1 is what those rows buy.');
    });
});
