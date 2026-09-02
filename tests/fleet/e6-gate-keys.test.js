// tests/fleet/e6-gate-keys.test.js — THE FRESH MEMBER-ADVERSARY, ROUND 2: the new coverage proof
// and the write-once wrap cell.
//
// Eve is invited, attested, non-admin, running her own client. She forges nothing. What she HAD,
// when this file was written, was the one privilege `limits.js` granted her without a budget:
//
//     RATE_COVERAGE.rotateEpoch = "serialised by first-writer-wins on Epoch; a flood costs the
//     attacker their own space's epoch numbers and nothing else"
//
// This file measured what "and nothing else" is worth. The answer was: the whole circle, for
// ever. `assertCoverage` is a ROW COUNT and rows already deposited count, so a rotation costs Eve
// ONE wrap per recipient — while `sync/keys.js#rotateTo` sends `recipients × 1..next` and
// `readWraps` refuses more than `MAX_WRAPS`. An unmetered counter that only goes up therefore
// walks the shipped client past a wall no route can undo.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THE ANSWERING PASS DID, AND WHAT IT DID NOT DO  (finding T2-E1)
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `RATE_RULES.epochRotate` — 20 rungs per MEMBER per hour, `LIMITS.epochRotationsPerMemberHour`,
// recorded as `LIMIT_EXTENSIONS` E2-L9 — and `handlers/spaces.js#rotateEpoch` spends it.
//
//   · **It meters the CLIMB, not the request.** The budget is charged only where the request
//     would take a rung (`epoch === currentEpoch + 1`); a rotation that loses the race and 409s
//     costs nothing. §2d is the control for that decision: an honest device has no choice but to
//     retry a lost race, and a limiter that charges the loser would meter the victim of a race at
//     the same rate as its winner. Metering the scarce thing — an epoch number, which only a
//     winner consumes — is the only shape that does not build a denial into the fix.
//   · **It PRICES the ladder; it does not make it reversible.** §1c is kept, and re-aimed, for
//     exactly that reason: past `MAX_WRAPS` the wall is still absorbing, and the residual is a
//     pruning route or a `rotateTo` that sends only the missing rows — protocol work, not a gate.
//   · **IT DOES NOT CLOSE §2a, AND §2a SAYS SO IN ITS OWN TITLE.** Reading that row as a race was
//     the mistake: Eve's twelve rotations were one POISONING, and one is enough. A rung budget
//     bounds how many epochs she may poison per hour (§3d measures it) and cannot bound whether
//     one suffices. That is ADR 002 §8.5a's owed report path, not a limiter.
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
import { LIMITS } from '../../server/core/limits.js';

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

/**
 * THE RUNGS ONE MEMBER MAY TAKE IN AN HOUR — read from the shipped table, never retyped, so a
 * change to the number re-aims every row below instead of reddening one that says `20`.
 */
const BUDGET = LIMITS.epochRotationsPerMemberHour;
const HOUR = 3600000;

/**
 * Walk the ladder as far as the meter allows, waiting out each refusal by advancing the relay's
 * own clock one hour. Returns what it cost — because after T2-E1 the interesting quantity is not
 * "can she" but "what does it take her".
 *
 * @returns {Promise<{reached:number, hours:number, refusals:number}>}
 */
async function climb(C, attacker, to, wrapFor) {
  let hours = 0;
  let refusals = 0;
  let at = (await rosterOf(C, attacker)).currentEpoch;
  while (at < to) {
    const res = await cheapRotate(C, attacker, at + 1, wrapFor);
    if (res.status === 429) {
      refusals += 1;
      C.relay.tick(HOUR);                 // she is patient, and the window is a tumbling one
      hours += 1;
      continue;
    }
    if (res.status !== 200) {
      throw new Error(`epoch ${at + 1} → ${res.status} ${JSON.stringify(res.json)}`);
    }
    at += 1;
  }
  return { reached: at, hours, refusals };
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
// §1 · THE EPOCH LADDER — a counter that only goes up, and what a rung now costs
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§1 · the epoch ladder, metered', async (t) => {
  await t.test(
    '§1a · FAILED — Eve buys exactly the hour\'s rungs and no more, and the counter costs her time',
    async () => {
      const C = await settled(['oma']);
      assert.equal((await join(C, C.oma)).status, 200);
      await refreshRoster(C);
      const junk = await junkWrap(C, 1);
      const start = (await rosterOf(C, C.eve)).currentEpoch;

      // One full rotation to seed Oma's empty cells, then the cheap ones. The relay still never
      // opens a wrap (`assertCoverage`: "A ROW COUNT, AND NOTHING MORE"), so the BYTES still cost
      // Eve nothing — what she now pays for is the RUNG.
      assert.equal((await fullRotate(C, C.eve, start + 1, () => junk)).status, 200);
      for (let i = 1; i < BUDGET; i++) {
        const at = (await rosterOf(C, C.eve)).currentEpoch;
        assert.equal((await cheapRotate(C, C.eve, at + 1, () => junk)).status, 200, `rung ${i + 1}`);
      }
      assert.equal((await rosterOf(C, C.eve)).currentEpoch, start + BUDGET,
        'NON-VACUITY: the budget really is spent on rungs SHE TOOK, not on requests she made');

      const at = (await rosterOf(C, C.eve)).currentEpoch;
      const refused = await cheapRotate(C, C.eve, at + 1, () => junk);
      assert.equal(refused.status, 429, 'the ladder is no longer free');
      assert.equal(refused.json.error, 'rate_limited');
      assert.equal(refused.json.retryAfter, 3600);
      assert.equal(refused.headers['Retry-After'], '3600',
        'ADR 003 §6.1: a 429 tells an honest client when to come back');
      assert.equal((await rosterOf(C, C.eve)).currentEpoch, at, 'and the refusal moved nothing');

      // The meter is a WINDOW and not a wall, and the row says so rather than implying the
      // ladder is closed: an hour later she gets exactly as many rungs again.
      C.relay.tick(HOUR);
      for (let i = 0; i < BUDGET; i++) {
        const e = (await rosterOf(C, C.eve)).currentEpoch;
        assert.equal((await cheapRotate(C, C.eve, e + 1, () => junk)).status, 200, `hour 2 rung ${i}`);
      }
      assert.equal((await cheapRotate(C, C.eve,
        (await rosterOf(C, C.eve)).currentEpoch + 1, () => junk)).status, 429);
      assert.equal((await rosterOf(C, C.eve)).currentEpoch, start + 2 * BUDGET);

      // WHAT THE BUDGET BOUGHT, AS A NUMBER. The wall is where `keys.js#rotateTo`'s
      // `recipients × 1..next` stops fitting in one request; reaching it is now hours of
      // continuous, authenticated, attributable rotation by a named member rather than one
      // unattended burst — long enough for `removeMember` to end it.
      const recipients = rosterDeviceIdsOf((await rosterOf(C, C.papa)).members);
      assert.equal(recipients.length, 4);
      const wall = Math.floor(MAX_WRAPS / recipients.length) - 1;
      const hoursToWall = Math.ceil((wall - (start + 2 * BUDGET)) / BUDGET);
      assert.ok(hoursToWall >= 10,
        `the wall at epoch ${wall} is ${hoursToWall} h of sustained rotation away, and it used to `
        + 'be one loop');
    });

  await t.test(
    '§1b · FAILED — Eve spends the whole hour, and the removal ADR 002 §4.1 owes still fits',
    async () => {
      const C = await settled(['oma']);
      // Eve climbs with GENUINE wraps: every ring stays whole, every board keeps working, no
      // warning fires anywhere. This is the quiet version, and it is the realistic one — she just
      // cannot do it more than BUDGET times an hour any more.
      const start = (await rosterOf(C, C.eve)).currentEpoch;
      for (let i = 0; i < BUDGET; i++) {
        const k = await createSpaceKey();
        const at = (await rosterOf(C, C.eve)).currentEpoch;
        const res = await cheapRotate(C, C.eve, at + 1,
          (id, ep, list) => genuineWrap(C, C.eve, list, id, ep, k));
        assert.equal(res.status, 200, `rung ${i}`);
      }
      const k = await createSpaceKey();
      const over = await cheapRotate(C, C.eve, start + BUDGET + 1,
        (id, ep, list) => genuineWrap(C, C.eve, list, id, ep, k));
      assert.equal(over.status, 429, 'a genuine wrap buys no extra rung: the meter is on the climb');

      await catchUpRing(C, C.papa);
      assert.equal(C.papa.ring.covers(C.spaceId, start + BUDGET), true,
        `the family is HEALTHY at epoch ${start + BUDGET}`);

      // ── THE HONEST-PATH CONTROL, AND IT IS THE POINT OF THE ROW ────────────────────────────
      // Oma joins, the shipped client delivers to her, and then the shipped client performs the
      // removal rotation. Under the finding this last call was `REFUSED / 413 payload_too_large`
      // and stayed that way for ever. It must be DELIVERED here, or the fix has closed the attack
      // by breaking the feature.
      assert.equal((await join(C, C.oma)).status, 200);
      await refreshRoster(C);
      let d; let after;
      await on(C.papa, async () => {
        C.papa.engine = engineFor(C, C.papa);
        await C.papa.engine.keys.admit();
        d = await C.papa.engine.keys.deliver({ reason: 'join' });
        after = await C.papa.engine.keys.rotate('member.remove');
      });
      assert.equal(d.verdict, DELIVERY.DELIVERED, JSON.stringify(d));
      assert.equal(after.verdict, DELIVERY.DELIVERED, JSON.stringify(after));
      await catchUpRing(C, C.oma);
      assert.equal(C.oma.ring.covers(C.spaceId, start + BUDGET + 2), true,
        'Oma gets her whole history, and a removal can still force e+1');
    });

  await t.test(
    '§1c · PRICED, NOT CLOSED — past MAX_WRAPS the wall is still absorbing, and no route prunes',
    async () => {
      // THE RESIDUAL, KEPT ON THE RECORD ON PURPOSE. A budget makes the ladder expensive; it does
      // not make it reversible. A joiner needs `1..e` rows OF HER OWN, `MAX_WRAPS` is a
      // per-REQUEST cap with no continuation, and `keys.js` states there is no route that
      // deposits a wrap outside a rotation — so there is no second request to put the rest in.
      // Closing this needs protocol work (a prune/compaction route, or a `rotateTo` that sends
      // only the rows that are missing), not another limiter.
      const C = await settled();
      const junk = await junkWrap(C, 1);
      const { reached, hours, refusals } = await climb(C, C.eve, MAX_WRAPS + 2, () => junk);
      assert.equal(reached, MAX_WRAPS + 2);
      assert.ok(hours >= Math.floor(MAX_WRAPS / BUDGET) - 1,
        `${hours} h of sustained, attributable rotation — it used to be a single unattended loop`);
      assert.equal(refusals, hours, 'every hour boundary was a 429 she had to wait out');

      const wraps = [];
      for (let e = 1; e <= reached + 1; e++) {
        wraps.push({ recipientId: C.papa.forStore.deviceId, epoch: e, wrapped: junk });
      }
      assert.ok(wraps.length > MAX_WRAPS);
      assert.equal((await postEpoch(C, C.papa, reached + 1, wraps)).status, 413,
        'the ladder is one-way, the cap is per request, and there is no second request');
    });
});


// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · STARVING A JOINER BY WINNING EVERY RACE
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§2 · the coverage proof, and the race it cannot win', async (t) => {
  await t.test(
    '§2a · SUCCEEDED — and NOT by volume: ONE poisoned rung is enough, so no rung budget reaches it',
    async () => {
      // ── RE-AIMED AT THE MECHANISM, BECAUSE THE FIRST READING OF THIS ROW WAS WRONG ─────────
      //
      // The row used to be written as a RACE — "Eve rotates first on every tick, twelve times" —
      // and the natural conclusion was that metering her rotations closes it. Measured against
      // the shipped budget, it does not, and the reason is worth more than the row:
      //
      //   Eve's twelve rotations were never twelve wins. They were ONE poisoning. A rotation to
      //   `e+1` carrying wraps nobody can open is accepted, because `assertCoverage` is a ROW
      //   COUNT — and from that instant EVERY honest device is `noRing` at the current epoch, so
      //   it cannot rotate to `e+2` and the joiner is never delivered to. The eleven that
      //   followed changed nothing that the first had not already done.
      //
      // So this is not a rate problem and no rate rule is the answer to it. `RATE_RULES.
      // epochRotate` bounds how many epochs she may poison in an hour (§3d measures exactly
      // that) and does not touch whether one is enough. The control that reaches this is ADR 002
      // §8.5a's owed one — a way for a member to report "I cannot open epoch e" — carried as T5
      // residual 3, and it is protocol work in `handlers/keys.js`.
      const C = await settled(['oma']);
      assert.equal((await join(C, C.oma)).status, 200);
      await refreshRoster(C);
      const junk = await junkWrap(C, 1);
      const start = (await rosterOf(C, C.eve)).currentEpoch;

      // ONE request. Not twelve, and nowhere near the hour's BUDGET rungs.
      assert.equal((await fullRotate(C, C.eve, start + 1, () => junk)).status, 200);

      const verdicts = [];
      await on(C.papa, async () => {
        C.papa.engine = engineFor(C, C.papa);
        for (let tick = 0; tick < 6; tick++) {
          // Eve does NOTHING on any of these ticks. She has spent one rung, ever.
          await C.papa.engine.keys.admit();
          verdicts.push((await C.papa.engine.keys.deliver({ reason: 'tick' })).verdict);
        }
      });
      assert.equal(verdicts.includes(DELIVERY.DELIVERED), false, JSON.stringify(verdicts));
      assert.equal((await rosterOf(C, C.papa)).currentEpoch, start + 1,
        'NON-VACUITY: the epoch is not moving because nobody CAN move it, not because of a race');

      await catchUpRing(C, C.oma);
      assert.deepEqual(C.oma.ring.epochs(C.spaceId), [],
        'six ordinary ticks after ONE hostile rotation, Oma holds nothing at all');
      assert.ok((await keysOf(C, C.oma)).wraps.length > 0,
        'and the relay is satisfied — it counted the rows (ADR 002 §4.2, finding T5-K1)');

      // and the budget really was untouched: she still has the whole hour's ladder if she wants
      // it, which is the honest way to say a limiter is not what closes this.
      assert.equal((await cheapRotate(C, C.eve, start + 2, () => junk)).status, 200);
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

  await t.test(
    '§2d · CONTROL — the honest LOSER of a race pays nothing, so the fix builds no new denial',
    async () => {
      // ── THE CONTROL FOR THE METERING DECISION (T2-E1) ─────────────────────────────────────
      //
      // `RATE_RULES.epochRotate` could have been charged on entry, and the difference is invisible
      // in every other row in this file. It is visible here.
      //
      // A device that loses the epoch race has no choice but to try again — that IS the ADR 002
      // §4.2 protocol ("the client re-fetches its wraps and stops if it now holds the key"), and
      // in a family where two Macs deliver on their own timers, losing is ordinary. Under an
      // entry charge the loser pays for every loss, so a member whose partner happens to rotate
      // faster is metered out of her own circle's key delivery by the honest behaviour of an
      // honest peer.
      //
      // So: Papa loses BUDGET + 4 races — more losses than the hour holds rungs — and then wins
      // one. The win must land. THE MUTANT THIS ROW EXISTS FOR is moving `enforceFor(req, ctx,
      // 'epochRotate', auth)` in `handlers/spaces.js#rotateEpoch` above the pre-flight test, i.e.
      // charging every attempt; this row is the only one in the suite that dies for it.
      const C = await settled();
      const at = (await rosterOf(C, C.papa)).currentEpoch;
      const junk = await junkWrap(C, 1);

      for (let i = 0; i < BUDGET + 4; i++) {
        const lost = await postEpoch(C, C.papa, at,
          [{ recipientId: C.papa.forStore.deviceId, epoch: at, wrapped: junk }]);
        assert.equal(lost.status, 409, `loss ${i} → ${lost.status} ${JSON.stringify(lost.json)}`);
        assert.equal(lost.json.error, 'epoch_taken');
      }
      assert.equal((await rosterOf(C, C.papa)).currentEpoch, at,
        'NON-VACUITY: none of those took a rung, which is exactly why none of them should be paid for');

      const k = await createSpaceKey();
      const won = await cheapRotate(C, C.papa, at + 1,
        (id, ep, list) => genuineWrap(C, C.papa, list, id, ep, k));
      assert.equal(won.status, 200,
        'a device that lost more races than an hour holds rungs was refused its first win');
      await catchUpRing(C, C.mama);
      assert.equal(C.mama.ring.covers(C.spaceId, at + 1), true, 'and the win was a real delivery');
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
    '§3d · PRICED — a squat is still a PERMANENT row, but an hour now buys a countable number',
    async () => {
      // The four-column cell's stated cost is "rows, not data", and no route can remove one —
      // that half is UNCHANGED and stays on the record as the residual. What changed is the rate
      // at which the rows arrive: the squat is charged against the same rung budget as the
      // ladder, because a squat IS a rung.
      const C = await settled();
      const junk = await junkWrap(C, 1);
      const before = (await keysOf(C, C.papa)).wraps.length;
      let taken = 0;
      let refused = null;
      for (let e = 3; e <= 42; e++) {
        const res = await cheapRotate(C, C.eve, e, () => junk);
        if (res.status === 429) { refused = res; break; }
        assert.equal(res.status, 200, `epoch ${e}`);
        taken += 1;
      }
      assert.equal(taken, BUDGET, 'the hour buys exactly the budget and not one row more');
      assert.ok(refused, 'the loop must END at the meter, not at 42 — otherwise this row is vacuous');
      assert.equal(refused.json.error, 'rate_limited');

      const rows = (await keysOf(C, C.papa)).wraps;
      assert.equal(rows.length, before + taken,
        'one squatted row per rung, addressed to one device: bounded by the hour, not by patience');
      // and the permanence is unchanged: there is no prune route, so `rows` only ever grows. That
      // is the residual §1c names, and a limiter is not the thing that closes it.
      assert.ok(rows.length > before);
    });
});
