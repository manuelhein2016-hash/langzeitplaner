// FLEET · T5 — THE FAMILY MEMBER AS ADVERSARY, AGAINST THE KEY-DELIVERY PRODUCER.
// ADR 002 §0 T5 · §4.2 (steps 2, 4, 6) · §7.1 steps 4–6 · §8.5 · PO decision D9 · stories 15.3,
// 17.1, 19.3, 20.5, 21.2 · risk R11 · A4.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS, IN ONE SENTENCE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `sync/keys.js` is new, it runs on EVERY member's Mac, and the thing it decides — "does this
// recipient already hold the ring?" — is decided from evidence the adversary in ADR 002 §0's own
// table (T5, "the admin included") is allowed to manufacture.
//
// Everything below hits the SAME routes with the SAME auth as an honest client. Nothing here
// forges a signature, breaks a cipher, or edits a byte in transit. The attacker is Eve: an
// ordinary, invited, attested, non-admin member of the Familienkreis, running a client of her own
// choosing. That is exactly the adversary §0 puts in the table and exactly the one the product
// promises to survive.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE ONE FACT THE WHOLE FILE TURNS ON
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `server/core/handlers/spaces.js#assertCoverage` counts (recipientId, epoch) ROWS:
//
//     const have = new Set((await tx.getKeyWraps(spaceId, r)).map((w) => w.epoch));
//
// The relay cannot open a wrap and must not try, so "coverage" is a statement about the SHAPE of
// the table and never about whether anybody can decrypt anything. `sync/keys.js` §4's coverage
// proof READ it as the stronger claim, in as many words:
//
//     "So coverage is not a hope about other clients — it is a server-enforced invariant, and
//      observing that an epoch EXISTS is observing that it held."
//
// It is not. An epoch exists when 3n rows exist. §1 below is what that cost, and what it costs
// now: that sentence is deleted from `keys.js`, the coverage record is three statements about
// KEYS (I delivered to it · it delivered to me · it is me), and ADR 002 §4.2 says "row count" in
// the ADR so the next reader cannot make the same inference twice.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE FALSE GREENS THIS FILE IS WRITTEN AGAINST
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   1. **the joiner never had a working path.** §0 asserts the HONEST delivery works first, on
//      this very rig, for this very joiner — Mama gets epochs [1..e] with nobody attacking. A
//      denial test on a rig that never delivered is a tautology.
//   2. **the attacker was the relay.** Every request Eve makes goes through `platform/net.js`'s
//      `buildRequest` and the real ADR 003 §2 ladder. She is authenticated as herself, and the
//      relay is `adapters/memory.js` behaving perfectly.
//   3. **"nothing happened" was never measured.** Every SUCCEEDED row asserts the victim's
//      OBSERVABLE state — status, warnings, quarantine, board — and asserts it is quiet. A denial
//      that showed up as an error would be a bad afternoon, not a break.
//   3b. **a fix bought by breaking the honest path.** Every closed row has a non-vacuity control
//      beside it: §0 for the file, §1h for §1 (the same lost race with an HONEST winner — the
//      circle must still converge AND go quiet rather than rotate on every poll), §3d/§3e for §3.
//      A coverage rule that never says `covered` closes every denial in this file and ships a
//      family whose three Macs climb the epoch ladder against each other for ever.
//   4. **the honest devices were asleep.** §1c drives Papa's `syncNow()` five more times after
//      the attack and asserts he still refuses to deliver.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE MUTANTS — one run each, in a scratch copy of the tree, never in the tree
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// A row that says "this attack works" is worth nothing unless closing the hole makes it go red.
// Each mutant below CLOSES one hole; the rows it kills are named beside it. Measured, one run
// each, in `.../scratchpad/mutant`.
//
//   M-A  `sync/keys.js` — the coverage record is ONLY what this device itself delivered.
//        **LANDED**, together with §4 source 2 (`ring.originOf`). §1 and §2 are inverted, so the
//        mutants that prove them are the REVERSE ones. Measured in a scratch copy, one run each:
//
//          M-A1  the `RACED` branch records again (`recordDelivery(at, [...ids, ...owed])`)
//                                                                       → §1b · §1c · §1d
//          M-A2  `observe()` promotes `seen` on an epoch bump, `RACED` left as fixed
//                                                                       → §1b · §1c · §1d
//                (the adversary's own point, reproduced: closing only the `RACED` branch closes
//                 nothing — the inference writes the same false record one tick later)
//          M-D   §4 source 2 is removed (`ringWitnesses` is not consulted)
//                                → §1h3 · and `tests/tier1/sync-family.test.js` §3d and §4a,
//                                  which is the honest path climbing the epoch ladder
//
//        §1a survives all three, correctly: it is a statement about the RELAY.
//   M-B  `sync/keys.js` — `onAdmit` and `keysPending` answer from the relay's row count again
//        (`whole = true`, `stats.keysPending = parsed.keysPending`).
//        **LANDED**; the reverse mutant kills          → §2c · §1f · §3b
//   M-E  `server/core/handlers/spaces.js` — `rotateEpoch` answers `wrapsAdded: wraps.length` and
//        `wrapsRefused: 0` again, i.e. the rotation response counts what was SENT and throws away
//        what the store did.
//        **LANDED**; the reverse mutant kills                 → §3a2 · §1d2
//   M-C  `server/adapters/memory.js` — `putKeyWraps` is write-ONCE; an existing
//        (space, epoch, recipient) row is never replaced.                        → §3a · §3b
//        **LANDED.** §3 is now inverted and asserts the post-fix outcome, so the mutant that
//        proves it is the REVERSE one: restoring the upsert
//        (`state.keyWraps.set(key, r)` unconditionally) kills §3a, §3b and §3c.
//        Measured in a scratch copy, one run: §3a/§3b/§3c red, §0 and §3d/§3e green.
//   M-H  `crypto/spacekeys.js` — `familyRecipientsReport` admits ONE device per member, so a
//        device a member attests for herself is not automatically a ring recipient. → §5b · §5c
//   M-I  `family/membersui.js` — `MemberRow` grows `deviceCount`, i.e. ADR 002 §8.5's stated
//        mitigation is actually rendered.                                              → §5d
//        **LANDED (the UI half).** §5d is inverted and now asserts the field, the tag and the
//        length-only reading; its second half REPORTS that `family/mount.js#refreshRoster` still
//        drops `devices` on the way in, so the tag renders nowhere yet.
//

import '../helpers/env.js';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { entityUuid as newUuid, deviceId as mkDeviceId } from '../../src/js/core/ids.js';
import { createKeyRing } from '../../src/js/crypto/spacekeys.js';
import { exportRawPublic, deviceShortOf } from '../../src/js/crypto/identity.js';
import { attestPeer } from '../../src/js/family/engine.js';
import { b64u } from '../../src/js/core/b64.js';
import { createKeyDelivery, DELIVERY } from '../../src/js/sync/keys.js';

import {
  buildCircle, join, refreshRoster, bootMac, engineFor, on,
  publishAttestation, publishSharedEntry, boardOf,
  hostileRotate, genuineWrap, junkWrap, rosterDeviceIdsOf, catchUpRing, S,
} from './e6-attack-circle.js';

/** Papa's founding pair — ADR 001 §4.0 and §4.1. Without both the circle admits nothing. */
async function found(C) {
  await bootMac(C, C.papa);
  await on(C.papa, async () => {
    assert.equal(C.papa.store.apply('attestMyDevice', {
      deviceShort: C.papa.forStore.deviceShort, blob: C.papa.myBlob,
    }), true);
    assert.equal(C.papa.store.apply('claimAdmin', {}), true);
    C.papa.engine = engineFor(C, C.papa);
    const p = await C.papa.engine.pushNow();
    assert.equal(p.pushed, 2, 'NON-VACUITY: the two founding ops really reached the relay');
  });
}

/** Bring one joined Mac up: store, engine, one ordinary sync, then their own attestation. */
async function bring(C, mac) {
  await bootMac(C, mac);
  await on(mac, async () => {
    mac.engine = engineFor(C, mac);
    await mac.engine.syncNow();
  });
}

const epochsOf = (C, mac) => mac.ring.epochs(C.spaceId);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §0 · THE CONTROL — the honest path, on this rig, for this joiner
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§0 · control: an unattacked circle really does deliver the whole ring', () => {
  let C = null;
  let currentEpoch = 0;

  before(async () => {
    C = await buildCircle(['papa', 'eve', 'mama']);
    await refreshRoster(C);
    await found(C);
    assert.equal((await join(C, C.eve)).status, 200);
    await refreshRoster(C);
    await on(C.papa, () => C.papa.engine.syncNow());
    await bring(C, C.eve);
    await on(C.eve, async () => { await publishAttestation(C, C.eve); });
    await refreshRoster(C);

    assert.equal((await join(C, C.mama)).status, 200);
    await refreshRoster(C);
    const r = await on(C.papa, () => C.papa.engine.syncNow());
    currentEpoch = r.delivery.epoch;
    await bring(C, C.mama);
    await on(C.eve, () => C.eve.engine.syncNow());     // Eve's own next ordinary tick
  });

  test('§0a · Eve holds the whole ring and so does Mama, with nobody attacking', () => {
    const upTo = C.papa.ring.currentEpoch(C.spaceId);
    assert.ok(upTo >= 3, `the space rotated on each join: epoch ${upTo}`);
    for (const mac of [C.papa, C.eve, C.mama]) {
      assert.equal(epochsOf(C, mac)[0], 1, `${mac.tag} holds epoch 1 — the history (A4, 17.1)`);
      assert.equal(mac.ring.covers(C.spaceId, upTo), true,
        `${mac.tag} covers 1..${upTo}: ${epochsOf(C, mac)}`);
    }
    assert.ok(currentEpoch >= 3, 'Papa performed the delivery rotation');
  });

  test('§0b · the joiner\'s waiting state cleared and her engine is healthy', () => {
    const st = C.mama.engine.status();
    assert.equal(st.keysPending, false, 'D9 cleared');
    assert.equal(st.state, 'healthy');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · T5-K1, CLOSED AND INVERTED — the junk wrap no longer buys silence.
//
//   THE ATTACK, AS IT STOOD.  Eve is a member. Mama joins. Eve rotates FIRST — a rotation any
//   member may perform (ADR 002 §4.2: "the member whose action caused the rotation performs it",
//   and `rotateEpoch` requires only `requireActiveMember`) — depositing genuine wraps for herself
//   and for Papa and WELL-FORMED GARBAGE for Mama, for every epoch 1..e+1. The relay accepted it,
//   because `assertCoverage` counts (recipientId, epoch) ROWS and can never do anything else.
//   Papa's own delivery POST then lost the race and read `409 epoch_taken` as *"their wraps cover
//   the same recipients"*, writing a DURABLE record saying Mama holds the ring. From that moment
//   no honest device in the family would ever deliver to her again — ten ordinary ticks, ten
//   `covered`s — and nothing anywhere was in an error state.
//
//   The red team measured that the `RACED` branch was not the root: deleting its claim left the
//   attack fully working, because `observe()`'s inference (*"the epoch bumped, so everyone I saw
//   at the old epoch is covered"*) wrote the same false record one tick later.
//
//       THE ROOT: an epoch bump is not evidence that the bump delivered a usable key.
//
//   THE FIX (landed, `src/js/sync/keys.js` §4).  The coverage record is now three statements
//   about KEYS and no statement about epoch numbers: **I delivered to it** (this device's own
//   accepted rotation), **it delivered to me** (`ring.originOf` names the device whose wrap this
//   device actually opened — a wrap only opens if that device held the key), and **it is me**.
//   `observe()` can only ever remove ids; the `RACED` branch records nothing at all; and a record
//   written by a build from before the fix is discarded rather than trusted.
//
//   WHAT THAT BUYS, AND WHAT IS LEFT — the rows below say which is which.  Papa's very next
//   ordinary tick delivers (§1c), so the denial is no longer permanent and no longer silent, and
//   the joiner's own screen stops claiming otherwise (§1f). What survives is NOT in this file's
//   code any more: T5-K3's write-once rule makes the FIRST depositor of a (space, epoch,
//   recipient) cell its owner for ever, so Eve's junk keeps the cells it grabbed and Papa's
//   honest wraps for those epochs are refused by the store. §1d and §1e are that residual,
//   driven, with the one-line change that closes it named. → REPORTED, `server/adapters/`.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · T5-K1 · a lost race no longer discharges the delivery this device owes', () => {
  let C = null;
  let eveRotation = null;
  let papaAfter = null;
  const laterVerdicts = [];
  const mamaStates = [];
  let coverageAtRace = null;
  let firstDelivery = null;
  let deliveryWarnings = null;
  let mamaWraps = null;
  let lastRotationBody = null;

  before(async () => {
    C = await buildCircle(['papa', 'eve', 'mama']);
    await refreshRoster(C);
    await found(C);

    // Eve joins honestly and receives the ring honestly. She is a full member from here on.
    assert.equal((await join(C, C.eve)).status, 200);
    await refreshRoster(C);
    await on(C.papa, () => C.papa.engine.syncNow());
    await bring(C, C.eve);
    await on(C.eve, async () => { await publishAttestation(C, C.eve); });
    await refreshRoster(C);

    // Papa publishes the history a joiner is promised (A4, story 17.1, risk R11).
    await on(C.papa, async () => {
      await C.papa.engine.syncNow();
      await publishSharedEntry(C, C.papa, newUuid(), { 'pub.text': 'Omas Geburtstag', 'pub.date': '2023-11-14' });
    });

    // ── Mama joins ────────────────────────────────────────────────────────────────────────
    assert.equal((await join(C, C.mama)).status, 200);
    await refreshRoster(C);

    // ── THE RACE, DRIVEN DETERMINISTICALLY ───────────────────────────────────────────────
    //
    // Eve does not need this hook in the field: `rotateEpoch` carries NO rate limiter (its own
    // header says so, and `limits.js` RATE_COVERAGE.rotateEpoch reasons that membership is the
    // bound), so an attacker rotates in a loop and every honest delivery loses. The hook is here
    // so the loss is deterministic rather than a flake — it fires ONCE, on Papa's first
    // `POST /epoch`, and does exactly what Eve's loop would have done a millisecond earlier.
    const honest = C.papa.transport.request.bind(C.papa.transport);
    let armed = true;
    C.papa.transport.request = async (method, path, query, body, headers) => {
      if (armed && method === 'POST' && path.endsWith('/epoch')) {
        armed = false;
        await catchUpRing(C, C.eve);            // an attacker syncs before she attacks
        const roster = await C.eve.transport.request(
          'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined);
        const ring = C.eve.ring.keysByEpoch(C.spaceId);
        const next = roster.json.currentEpoch + 1;
        const fresh = await (await import('../../src/js/crypto/spacekeys.js')).createSpaceKey();
        ring.set(next, fresh);
        eveRotation = await hostileRotate(C, C.eve, async (rid, e) => (
          rid === C.mama.forStore.deviceId
            ? junkWrap(C, e)                                    // ← the whole attack
            : genuineWrap(C, C.eve, roster.json, rid, e, ring.get(e))
        ), { epoch: next });
      }
      return honest(method, path, query, body, headers);
    };

    papaAfter = await on(C.papa, () => C.papa.engine.syncNow());
    // The record AS IT STANDS AT THE END OF THE RACED PASS — before any later tick can write a
    // legitimate one. This is the value a relaunch would restore.
    coverageAtRace = C.papa.engine.keys.coverage();
    // The race hook is spent. From here Papa talks to the relay unmodified, through a recorder
    // that keeps the last accepted rotation body so §1d2 can read the three counts off a REAL
    // delivery rather than a second, synthetic request.
    C.papa.transport.request = async (method, path, query, body, headers) => {
      const res = await honest(method, path, query, body, headers);
      if (method === 'POST' && path.endsWith('/epoch') && res.status === 200) lastRotationBody = res.json;
      return res;
    };

    await bring(C, C.mama);

    // Ten more ordinary ticks on the two honest Macs. Mama's screen is read after every one.
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await on(C.papa, () => C.papa.engine.syncNow());
      if (firstDelivery === null && r.delivery.verdict === DELIVERY.DELIVERED) {
        firstDelivery = r.delivery;
        deliveryWarnings = [...C.papa.store.warnings];
      }
      laterVerdicts.push(r.delivery.verdict);
      // eslint-disable-next-line no-await-in-loop
      await on(C.mama, () => C.mama.engine.syncNow());
      mamaStates.push(C.mama.engine.status().state);
    }
    mamaWraps = await C.mama.transport.request(
      'GET', `/api/v1/spaces/${C.spaceId}/keys`, undefined, undefined);
  });

  test('§1a · REPORTED · the relay still ACCEPTS a rotation in which one recipient can decrypt nothing', () => {
    // UNCHANGED, and it is not a defect the client can close: `assertCoverage` counts rows, and a
    // relay that could tell a wrap from 156 bytes of noise would be a relay that can open a wrap.
    // ADR 002 §4.2 now says "row count" in the ADR, and §8.5 carries the residual this creates.
    // Everything else in this section is about what an honest CLIENT does with that fact.
    assert.equal(eveRotation.status, 200,
      `assertCoverage counts rows, not keys: ${JSON.stringify(eveRotation.json)}`);
    assert.ok(eveRotation.json.wrapsStored >= 3,
      'every required (recipient, epoch) pair got a row — that is all coverage means');
  });

  test('§1b · FAILED · the losing racer records NOTHING about the joiner', () => {
    assert.equal(papaAfter.delivery.verdict, DELIVERY.RACED,
      'the designed outcome of "any member device may deliver" — unchanged, and correct');
    const cov = coverageAtRace;
    assert.equal(cov.source, 'self-delivery',
      'the record names what it is a statement about, so a future reader cannot re-read it as a '
      + 'statement about the relay (finding T5-K1)');
    assert.equal(cov.durable, true,
      'NON-VACUITY: the record really is written to disk, so a false one WOULD have survived a '
      + 'relaunch. This row measures its contents, not its absence.');
    assert.equal(cov.proof === null || !cov.proof.ids.includes(C.mama.forStore.deviceId), true,
      `THE INVARIANT: 409 epoch_taken is news about an EPOCH NUMBER and about nothing else. The `
      + `winner of the race is ADR 002 §0's own T5 adversary, and her word is not this device's `
      + `proof: ${JSON.stringify(cov.proof)}`);
    assert.ok(cov.seen && cov.seen.ids.includes(C.mama.forStore.deviceId),
      'and the roster reading that USED to be promoted into the record is still kept — it is '
      + 'diagnostics now, and keeping it is what makes the two legible side by side');
  });

  test('§1c · FAILED · the very next ordinary tick delivers, unprompted, and names her', () => {
    assert.equal(laterVerdicts[0], DELIVERY.DELIVERED,
      `ten ordinary ticks after the lost race: ${laterVerdicts.join(', ')}`);
    assert.ok(firstDelivery, 'a delivery really happened');
    assert.ok(firstDelivery.uncovered.includes(C.mama.forStore.deviceId),
      'and the recipient it was FOR is the joiner Eve wrapped garbage to');
    assert.deepEqual([...new Set(laterVerdicts.slice(1))], [DELIVERY.COVERED],
      'and then it goes quiet again: one delivery, nine `covered`s. A fix that re-delivered on '
      + 'every poll would be two devices climbing the epoch ladder against each other for ever, '
      + `which is the other half of §4's argument: ${laterVerdicts.join(', ')}`);
  });

  test('§1d · INVERTED · she receives the WHOLE ring — history included, Eve notwithstanding', () => {
    // WHAT THE CLIENT FIX BOUGHT: her ring is no longer empty, and the epoch she holds came from
    // PAPA. Before it, Papa never posted at all after the race.
    const epochs = epochsOf(C, C.mama);
    assert.ok(epochs.length > 0, 'her ring is no longer empty — Papa\'s delivery landed');
    const rows = mamaWraps.json.wraps.filter((w) => epochs.includes(w.epoch));
    assert.ok(rows.length > 0, 'the epochs she holds are on the relay, addressed to her');
    assert.equal(C.mama.ring.originOf(C.spaceId, epochs[0]).deviceId, C.papa.forStore.deviceId,
      'and `ring.originOf` names PAPA as the device whose wrap opened — the honest delivery, on '
      + 'the wire, not an inference (and this is the same provenance §4 source 2 reads)');

    // ── THE HALF THAT WAS REPORTED, AND IS NOW CLOSED IN THE STORE ───────────────────────────
    //
    // This row used to end here: `assert.equal(epochs.includes(1), false)` — epoch 1, the epoch
    // „Omas Geburtstag" was sealed under, was Eve's junk for ever. T5-K3's first fix made a
    // `KeyWrap` cell write-once on `(spaceId, epoch, recipientId)`, which is right for the
    // attack it closes and handed THIS one a new weapon: a joiner's cells for epochs 1..e are
    // all empty when she arrives, so Eve's junk got there first, the cells were hers, and every
    // honest re-delivery was refused BY THE RELAY. Papa could only ever fill the epoch he minted.
    //
    // The close was to make the DEPOSITOR part of the cell —
    // `@@id([spaceId, epoch, recipientId, senderDeviceId])` — so that both findings hold at once.
    // Eve still cannot move one byte Papa deposited (different sender, different row: T5-K3 is
    // closed by construction, and §3a asserts it), and Papa's genuine wrap now COEXISTS with her
    // junk, which is the case `admitWraps` already handled: it walks the rows, counts the one
    // that will not open as `refused`, and admits the one that does.
    assert.equal(epochs.includes(1), true,
      'THE INVARIANT: epoch 1 — the epoch „Omas Geburtstag" was sealed under — is hers. Eve\'s '
      + `junk is still on the relay beside Papa's row and opens nothing: ${epochs}`);
    for (let e = 1; e <= Math.max(...epochs); e++) {
      assert.equal(epochs.includes(e), true, `and the ring is WHOLE, not merely non-empty: ${epochs}`);
    }
    const kd = C.mama.engine.keys.diagnostics();
    assert.ok(kd.refusedRows > 0,
      'the junk rows are still fetched and still refused, every pass — this is what the fix '
      + 'costs, and it is a refusal on her Mac rather than a hole in her history');
    assert.equal(kd.unauthorizedRows, 0,
      'and they are NOT unauthorized — Eve is an admissible sender, so §4.2 step 6 is silent');
  });

  test('§1d2 · INVERTED · the delivering Mac\'s backfill LANDS, so there is nothing to warn about', () => {
    // This row used to assert a WARNING: "the relay kept N wrap cell(s) somebody else had already
    // filled — those epochs were NOT re-delivered". That warning was true and necessary while a
    // cell was `(space, epoch, recipient)`. With the depositor in the cell, Papa's backfill rows
    // are HIS OWN rows and always land, so the condition it fired on no longer exists.
    //
    // It was removed rather than kept as reassurance: `wrapsRefused` is now only ever this device
    // re-wrapping its own earlier cells with a fresh salt and IV, which every rotation after the
    // first does for every epoch below its own. A warning on that fires for ever on an honest
    // relay, and a warning that is always on is a warning nobody reads.
    assert.ok(firstDelivery.detail.includes('wraps for epochs 1..'),
      `the verdict still says what it delivered: ${firstDelivery.detail}`);
    const hit = (deliveryWarnings || []).filter((w) => /wrap cell/.test(String(w)));
    assert.deepEqual(hit, [],
      `THE INVARIANT: no "cells somebody else had already filled" warning is raised, because no `
      + `such cell exists any more: ${JSON.stringify(deliveryWarnings)}`);

    // ── NON-VACUITY FOR THE ACCOUNTING, and it has to bite ───────────────────────────────────
    //
    // A weaker version of this row asserted only that the three counts ADD UP to `wrapsStored`.
    // That is vacuously true of a handler that answers `wrapsAdded: wraps.length, wrapsRefused: 0`
    // — measured: mutant M-E(spaces) killed nothing. So the assertion is on a rotation where the
    // store did something DIFFERENT from what was sent, which is every honest rotation after the
    // first: `wrapRingToRecipients` re-wraps 1..e (A4, story 17.1) and `wrapSpaceKey` draws a
    // fresh salt and IV each time, so this device's own earlier cells come back refused.
    assert.equal(
      lastRotationBody.wrapsAdded + lastRotationBody.wrapsKept + lastRotationBody.wrapsRefused,
      lastRotationBody.wrapsStored,
      'the three still account for every row submitted');
    assert.ok(lastRotationBody.wrapsRefused > 0,
      `THE INVARIANT: the response reports what the STORE did, not what was sent — Papa re-wrapped `
      + `his own cells for 1..e and they were refused: ${JSON.stringify(lastRotationBody)}`);
    assert.ok(lastRotationBody.wrapsAdded < lastRotationBody.wrapsStored,
      'so `added` is strictly less than `submitted`, which is the difference a handler that '
      + 'answered `wraps.length` could not show');
    assert.ok(lastRotationBody.wrapsAdded > 0,
      'and Papa\'s history rows really did LAND this time — the whole point of the store change');
  });

  test('§1e · INVERTED · the history she was promised RENDERS', () => {
    const board = boardOf(C, C.mama);
    assert.equal(board.some((n) => n.text === 'Omas Geburtstag'), true,
      'A4 / story 17.1 / risk R11: the shared history is THERE. This is the row the whole file '
      + 'was written for — a joiner who lost a race to a hostile member still ends up with the '
      + 'family\'s past on her board, because no member can own another member\'s wrap cell.');
  });

  test('§1f · INVERTED · her screen stops saying she is waiting, because she no longer is', () => {
    // THE T5-K2 HALF, met here rather than only in §2. `keysPending` is answered from her RING
    // and not from the relay's row count, so this row is a statement about keys either way. What
    // changed is the FACT underneath it: she now holds the whole ring, so the honest answer is
    // `healthy`, and D9's waiting state clears because the waiting really ended.
    assert.equal(C.mama.engine.status().keysPending, false,
      'THE INVARIANT: she holds the RING, so the sentence is withdrawn — and it is withdrawn on '
      + 'the evidence of her own ring, which is what T5-K2 fixed. Under the pre-integration '
      + 'store she held one epoch and this stayed `true`, correctly, for ever.');
    assert.deepEqual([...new Set(mamaStates)], ['healthy'],
      `and she never had to sit in D9's waiting state at all: ${mamaStates.join(' ')}`);
    assert.equal(C.papa.engine.status().state, 'healthy',
      'and every other Mac in the family sees a healthy circle throughout');
  });

  test('§1g · INVERTED · nothing is quarantined: the ladder never starts', () => {
    const q = C.mama.engine.quarantined();
    assert.deepEqual(q, [],
      `MAX_DEFERRALS is never approached, because the keys arrived. This row used to be the `
      + `end of the whole chain — a calm screen turning into an error one about ops that were `
      + `never damaged — and it was the sharpest statement of why "LOUD is not the same as `
      + `FIXED": ${JSON.stringify(q.map((r) => r.reason))}`);
    assert.equal(C.mama.engine.status().state, 'healthy',
      'her Mac is healthy. The residual that kept this red lived in the RELAY\'s cell key, not '
      + 'in any client, and that is where it was closed.');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1h · THE NON-VACUITY CONTROL FOR §1 — the same lost race, with an HONEST winner.
//
//   Every fix in this pass can be "closed" by breaking something legitimate, and this one has an
//   obvious way to do it: make `RACED` mean nothing AND make the record epoch-keyed, and three
//   Macs rotate against each other for ever while §1b–§1c go green. So the same rig runs again
//   with one byte changed — Eve's wraps for Mama are GENUINE — and the circle has to converge:
//   Mama fully covered, the history on her board, her engine healthy, and a bounded number of
//   rotations rather than one per poll.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1h · NON-VACUITY · a lost race against an HONEST rotator still converges', () => {
  let C = null;
  let papaAfter = null;
  let mamaFirst = null;
  const laterVerdicts = [];
  const mamaVerdicts = [];

  before(async () => {
    C = await buildCircle(['papa', 'eve', 'mama']);
    await refreshRoster(C);
    await found(C);
    assert.equal((await join(C, C.eve)).status, 200);
    await refreshRoster(C);
    await on(C.papa, () => C.papa.engine.syncNow());
    await bring(C, C.eve);
    await on(C.eve, async () => { await publishAttestation(C, C.eve); });
    await refreshRoster(C);
    await on(C.papa, async () => {
      await C.papa.engine.syncNow();
      await publishSharedEntry(C, C.papa, newUuid(), { 'pub.text': 'Omas Geburtstag', 'pub.date': '2023-11-14' });
    });
    assert.equal((await join(C, C.mama)).status, 200);
    await refreshRoster(C);

    const honest = C.papa.transport.request.bind(C.papa.transport);
    let armed = true;
    C.papa.transport.request = async (method, path, query, body, headers) => {
      if (armed && method === 'POST' && path.endsWith('/epoch')) {
        armed = false;
        await catchUpRing(C, C.eve);
        const roster = await C.eve.transport.request(
          'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined);
        const ring = C.eve.ring.keysByEpoch(C.spaceId);
        const next = roster.json.currentEpoch + 1;
        const fresh = await (await import('../../src/js/crypto/spacekeys.js')).createSpaceKey();
        ring.set(next, fresh);
        // THE ONE BYTE: every recipient, including Mama, gets a real wrap of the real key.
        await hostileRotate(C, C.eve, async (rid, e) => (
          genuineWrap(C, C.eve, roster.json, rid, e, ring.get(e))
        ), { epoch: next });
      }
      return honest(method, path, query, body, headers);
    };

    papaAfter = await on(C.papa, () => C.papa.engine.syncNow());
    C.papa.transport.request = honest;

    // Not `bring()`: the joiner's VERY FIRST ordinary sync is the one §4 source 2 is about, and
    // its verdict has to be read rather than thrown away.
    await bootMac(C, C.mama);
    mamaFirst = await on(C.mama, async () => {
      C.mama.engine = engineFor(C, C.mama);
      return C.mama.engine.syncNow();
    });
    for (let i = 0; i < 6; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await on(C.papa, () => C.papa.engine.syncNow());
      laterVerdicts.push(r.delivery.verdict);
      // eslint-disable-next-line no-await-in-loop
      const m = await on(C.mama, () => C.mama.engine.syncNow());
      mamaVerdicts.push(m.delivery.verdict);
    }
  });

  test('§1h1 · Papa lost the same race, and the circle still converged', () => {
    assert.equal(papaAfter.delivery.verdict, DELIVERY.RACED, 'the race really was lost');
    const at = C.mama.ring.currentEpoch(C.spaceId);
    assert.ok(at >= 1, 'she holds a ring');
    assert.equal(C.mama.ring.covers(C.spaceId, at), true,
      `THE CONTROL: the whole ring, epoch 1 included: ${epochsOf(C, C.mama)}`);
    assert.equal(epochsOf(C, C.mama)[0], 1, 'and epoch 1 is the history (A4, story 17.1)');
  });

  test('§1h2 · her board fills in and her engine is healthy', () => {
    assert.equal(boardOf(C, C.mama).some((n) => n.text === 'Omas Geburtstag'), true,
      'the entry sealed under epoch 1, three years before she arrived');
    assert.equal(C.mama.engine.status().keysPending, false, 'D9 cleared, on coverage');
    assert.equal(C.mama.engine.status().state, 'healthy');
    assert.equal(C.mama.engine.quarantined().length, 0, 'and nothing was quarantined');
  });

  test('§1h3 · and the honest family goes QUIET — no epoch ladder', () => {
    assert.deepEqual([...new Set(laterVerdicts.slice(1))], [DELIVERY.COVERED],
      `after the one delivery it owed, six ticks and nothing more: ${laterVerdicts.join(', ')}`);
    // ── §4 SOURCE 2, MEASURED ON THE ONE PASS THAT CAN SEE IT ────────────────────────────────
    //
    // The joiner's first sync admitted epochs 1..e, and `ring.originOf` names EVE on every one of
    // them — she is the device whose wraps actually opened. So the joiner owes Eve nothing. She
    // does still owe PAPA, and correctly: he lost the race, so nothing he did and nothing he sent
    // is evidence about him. One delivery, naming exactly one device.
    //
    // This is the row that dies if source 2 is removed: `uncovered` then names Eve as well, every
    // device owes every other device on every fresh launch, and `tests/tier1/sync-family.test.js`
    // §3d/§4a go red as the family climbs the epoch ladder.
    assert.deepEqual(mamaFirst.delivery.uncovered, [C.papa.forStore.deviceId],
      `she owes the racer she never heard from, and NOT the member whose wraps she just opened: `
      + `${JSON.stringify(mamaFirst.delivery.uncovered)}`);
    assert.deepEqual([...new Set(mamaVerdicts)], [DELIVERY.COVERED],
      `and after that one delivery she is quiet for ever: ${mamaVerdicts.join(', ')}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · T5-K2, CLOSED AND INVERTED — the waiting state now clears on COVERAGE, not on arrivals.
//
//   THE ATTACK, AND IT IS UNCHANGED.  `wrapRingToRecipients` refuses to build a partial ring and
//   says why: *"A wrap that covers only the current epoch is a bug … a joiner whose board is
//   simply missing three years of entries with no error anywhere"*. That refusal is on the HONEST
//   wrapping side. Eve does not call it. She deposits a genuine wrap for the newest epoch and
//   junk for every older one, and the coverage check — rows again — takes it. §2a and §2b still
//   assert exactly that: she gets one epoch of a ring, and it does not cover 1..e.
//
//   WHAT WAS BROKEN.  `keys.js#admit` fired `onAdmit` on `admitted.length > 0`, and
//   `sync/family.js` turns that into `onKeys({keysPending:false})` — the ONE place D9's calm
//   German sentence is withdrawn. `status().keysPending` agreed, because it read the relay's own
//   `keysPending`, which is the same row count. So a device that could not read a single thing
//   published before it arrived was told its keys had come. `ring.covers()` was three lines away.
//
//   THE FIX (landed).  `admit()` computes `ringIsWhole()` — `ring.covers(spaceId, currentEpoch)`
//   — and BOTH the event and `stats.keysPending` are answered from it. `parseKeysResponse()`'s
//   `keysPending` is deliberately not stored: the relay counts rows and this device holds keys.
//   `rotateTo`'s `onAdmit` is gated the same way, so there is no second door.
//
//   §2d and §2e are unchanged and are the residual: her board is still empty and she still cannot
//   pass the ring on. That is TRUE and it is now SAID — which is the whole of what this row was
//   ever about, because a joiner whose screen is honest is a joiner somebody helps.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · T5-K2 · a partial ring no longer clears D9\'s waiting state', () => {
  let C = null;
  let rotation = null;
  const keyEvents = [];

  before(async () => {
    C = await buildCircle(['papa', 'eve', 'mama']);
    await refreshRoster(C);
    await found(C);
    assert.equal((await join(C, C.eve)).status, 200);
    await refreshRoster(C);
    await on(C.papa, () => C.papa.engine.syncNow());
    await bring(C, C.eve);
    await on(C.eve, async () => { await publishAttestation(C, C.eve); });
    await refreshRoster(C);
    await on(C.papa, async () => {
      await C.papa.engine.syncNow();
      await publishSharedEntry(C, C.papa, newUuid(), { 'pub.text': 'Omas Geburtstag', 'pub.date': '2023-11-14' });
    });

    assert.equal((await join(C, C.mama)).status, 200);
    await refreshRoster(C);

    // Eve rotates BEFORE anybody else can: genuine for the new epoch, junk for the history.
    await catchUpRing(C, C.eve);
    const roster = await C.eve.transport.request(
      'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined);
    const next = roster.json.currentEpoch + 1;
    const ring = C.eve.ring.keysByEpoch(C.spaceId);
    const fresh = await (await import('../../src/js/crypto/spacekeys.js')).createSpaceKey();
    ring.set(next, fresh);
    rotation = await hostileRotate(C, C.eve, async (rid, e) => (
      rid === C.mama.forStore.deviceId && e < next
        ? junkWrap(C, e)                                        // ← history withheld
        : genuineWrap(C, C.eve, roster.json, rid, e, ring.get(e))
    ), { epoch: next });

    await bootMac(C, C.mama);
    await on(C.mama, async () => {
      C.mama.engine = engineFor(C, C.mama, { onKeys: (r) => keyEvents.push(r) });
      await C.mama.engine.syncNow();
      await C.mama.engine.syncNow();
    });
  });

  test('§2a · the relay took the rotation', () => {
    assert.equal(rotation.status, 200, JSON.stringify(rotation.json));
  });

  test('§2b · Mama holds exactly ONE epoch of the ring — the attack itself is unchanged', () => {
    const at = rotation.json.currentEpoch;
    assert.deepEqual(epochsOf(C, C.mama), [at], `only the newest epoch: ${epochsOf(C, C.mama)}`);
    assert.equal(C.mama.ring.covers(C.spaceId, at), false, 'the ring does not cover 1..e');
  });

  test('§2c · FAILED · D9\'s waiting state does NOT clear on a ring that is not there', () => {
    // NON-VACUITY FIRST: the ring really did grow, so the old code's trigger really did fire.
    // This row measures what the engine SAID about it, not whether anything happened.
    assert.equal(epochsOf(C, C.mama).length, 1,
      'an epoch really was admitted — `onAdmit`\'s old condition, `admitted.length > 0`, is met');
    assert.deepEqual(keyEvents, [],
      `THE INVARIANT: no \`onKeys\` event, because the ring does not cover 1..e. D9's sentence is `
      + `withdrawn by COVERAGE and by nothing else: ${JSON.stringify(keyEvents)}`);
    assert.equal(C.mama.engine.status().keysPending, true,
      'and `status()` agrees, because `keys.js` now answers it from `ring.covers()` instead of '
      + 'from the relay\'s row count (`parseKeysResponse().keysPending` is no longer stored)');
    assert.ok(C.mama.engine.keys.diagnostics().partialAdmits > 0,
      'and the anomaly is COUNTED — an admission that grew the ring and left it short is exactly '
      + 'what a diagnostics pane needs to show, and what nothing anywhere used to record');
  });

  test('§2d · and nothing on her board is from before she arrived', () => {
    assert.equal(boardOf(C, C.mama).some((n) => n.text === 'Omas Geburtstag'), false,
      'the history is silently absent — no error, no warning, no missing-key state');
  });

  test('§2e · she also cannot deliver the ring onward, and does not say so', () => {
    assert.equal(C.mama.engine.keys.diagnostics().deliveries, 0);
    assert.equal(C.mama.engine.status().state !== 'error', true,
      'a member who can neither read the history nor pass it on looks healthy or merely pending');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · T5-K3, CLOSED AND INVERTED — the overwrite is refused and the key history survives.
//
//   THE ATTACK, AS IT STOOD.  `adapters/memory.js#putKeyWraps` was
//   `state.keyWraps.set(K(spaceId, epoch, recipientId), r)` — an upsert. A rotation could
//   therefore REPLACE any existing (recipient, epoch) wrap, including ones it did not deposit,
//   for every epoch below its own. `readWraps` refuses a duplicate pair WITHIN one request; it
//   said nothing about the rows already in the table. Eve rotated with junk for every recipient
//   and every epoch except her own current one, got a `200`, and Papa's own epoch-1 wrap — the
//   one HE deposited at `POST /spaces`, addressed to his own `IK_kex` — held bytes she chose.
//
//   The victim was never the member who is online: she holds her ring in `localStorage`. The
//   victims were every future joiner, every device paired in tomorrow, and ADR 002 §7.3's A2
//   recovery, which is the ONLY path that survives losing every device. And no honest client
//   could notice — `rotateTo` builds its wrap set from its own ring and posts it, and no route
//   answers "what is already there?".
//
//   THE FIX (mutant M-C, landed).  `putKeyWraps` is WRITE-ONCE in all three adapters, and the
//   `@@id([spaceId, epoch, recipientId])` in `schema.prisma` is what makes an INSERT the whole
//   write. An empty cell is filled; an identical re-post, sender included, is a no-op; a
//   DIFFERING re-post is refused per row and the stored row stands. The relay cannot adjudicate
//   between two sets of bytes — adjudicating means opening a wrap, which is the one thing it may
//   never do — so it does not offer the write at all.
//
//   The rows below are the SAME attack, driven the same way, asserting the opposite outcome. The
//   ones that matter are §3a (the bytes did not move) and §3b (the founding member, restored
//   from the A2 backup onto an empty ring, gets his history back). §3d and §3e are the
//   non-vacuity halves: the fix must not have bought this by breaking the honest path.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · T5-K3 · a member CANNOT overwrite the family\'s wraps, and the history survives', () => {
  let C = null;
  let before1 = 0;
  let bytesBefore = '';
  let bytesAfter = '';
  let historyBefore = null;      // epoch -> the b64 wrap Papa held BEFORE Eve's rotation
  let historyAfter = null;
  let foundingBytes1 = '';       // Papa's epoch-1 cell as `POST /spaces` wrote it, before ANY rotation
  let prevEpoch = 0;
  let next = 0;
  let rotation = null;
  let freshAdmit = null;
  let eveRows = [];
  let papaKex = '';
  let eveKex = '';

  /** The store's own cell identity, minus the space and recipient this block holds fixed.
   *  `GET /keys` publishes the DEPOSITOR as ADR 002 §4.2 step 6's `senderKexPubRaw` (joined from
   *  `Device.kexPubRaw`) rather than as the relay's internal `KeyWrap.senderDeviceId`, so that is
   *  the spelling a client — and this test — identifies a row's author by. */
  const cell = (w) => `${w.epoch}\u0000${w.senderKexPubRaw}`;

  before(async () => {
    C = await buildCircle(['papa', 'eve']);
    await refreshRoster(C);
    await found(C);
    // The epoch-1 cell EXACTLY as `POST /spaces` wrote it, before any rotation has run over it.
    // §3d compares against this: Papa's own honest join-rotation below re-wraps epoch 1 with a
    // fresh salt and IV and must be refused that cell WITHOUT being refused the rotation.
    const founded = await C.papa.transport.request('GET', `/api/v1/spaces/${C.spaceId}/keys`, undefined, undefined);
    foundingBytes1 = founded.json.wraps.find((w) => w.epoch === 1).wrapped;

    assert.equal((await join(C, C.eve)).status, 200);
    await refreshRoster(C);
    await on(C.papa, () => C.papa.engine.syncNow());   // ← Papa's HONEST rotation to epoch 2
    await bring(C, C.eve);
    await on(C.eve, async () => { await publishAttestation(C, C.eve); });
    await refreshRoster(C);

    // The two depositors, in the spelling the WIRE uses (ADR 002 §4.2 step 6's `senderKexPubRaw`,
    // which `GET /keys` joins from `Device.kexPubRaw`). Derived from each Mac's own device key
    // rather than read back off a response, so a row that names the wrong author cannot define
    // its own expectation.
    papaKex = b64u(await exportRawPublic(C.papa.identity.devKex.publicKey));
    eveKex = b64u(await exportRawPublic(C.eve.identity.devKex.publicKey));

    const mine = await C.papa.transport.request('GET', `/api/v1/spaces/${C.spaceId}/keys`, undefined, undefined);
    before1 = mine.json.wraps.length;
    assert.ok(before1 >= 2, 'NON-VACUITY: Papa really has wraps on the relay for Eve to aim at');
    // KEYED BY (epoch, DEPOSITOR). A `KeyWrap` cell is
    // `(spaceId, epoch, recipientId, senderDeviceId)`, so two members may hold a row for the same
    // epoch of the same recipient and folding them onto `epoch` alone would compare Papa's row
    // against whichever one the relay happened to serve last — a test artefact that reads
    // exactly like the attack succeeding. `cell()` is the identity the store actually uses.
    historyBefore = new Map(mine.json.wraps.map((w) => [cell(w), w.wrapped]));
    bytesBefore = historyBefore.get(cell({ epoch: 1, senderKexPubRaw: papaKex }));
    assert.ok(bytesBefore, 'NON-VACUITY: Papa\'s own epoch-1 row is the one under attack');

    await catchUpRing(C, C.eve);
    const roster = await C.eve.transport.request(
      'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined);
    prevEpoch = roster.json.currentEpoch;
    next = prevEpoch + 1;
    const ring = C.eve.ring.keysByEpoch(C.spaceId);
    const fresh = await (await import('../../src/js/crypto/spacekeys.js')).createSpaceKey();
    ring.set(next, fresh);
    // Junk for EVERY recipient and EVERY epoch except Eve's own current one.
    rotation = await hostileRotate(C, C.eve, async (rid, e) => (
      rid === C.eve.forStore.deviceId && e === next
        ? genuineWrap(C, C.eve, roster.json, rid, e, ring.get(e))
        : junkWrap(C, e)
    ), { epoch: next });

    const after = await C.papa.transport.request('GET', `/api/v1/spaces/${C.spaceId}/keys`, undefined, undefined);
    historyAfter = new Map(after.json.wraps.map((w) => [cell(w), w.wrapped]));
    bytesAfter = historyAfter.get(cell({ epoch: 1, senderKexPubRaw: papaKex }));
    eveRows = after.json.wraps.filter((w) => w.senderKexPubRaw === eveKex);

    // Papa's Mac is replaced / restored from the A2 backup: same identity, EMPTY ring.
    const emptyRing = createKeyRing();
    const delivery = createKeyDelivery({
      transport: C.papa.transport,
      spaceId: C.spaceId,
      ring: emptyRing,
      myKexPriv: C.papa.identity.devKex.privateKey,
      myRecoveryKexPriv: C.papa.recovery.recKex.privateKey,
      me: {
        memberId: C.papa.forStore.memberId,
        deviceId: C.papa.forStore.deviceId,
        deviceShort: C.papa.forStore.deviceShort,
      },
      now: C.now,
      subtle: S,
      random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
    });
    freshAdmit = await delivery.admit();
    freshAdmit.epochs = emptyRing.epochs(C.spaceId);
  });

  test('§3a · FAILED · not one byte of Papa\'s existing wraps moved', () => {
    // The rotation is still ACCEPTED, and that is deliberate. Write-once is not a coverage rule
    // and must not become one: Eve may rotate — ADR 002 §4.2, decision D9, "any member device,
    // not only the admin's" — and the epoch-`next` cells she fills are empty when she gets
    // there. What she may not do is touch a row somebody else deposited.
    //
    // SHE IS NO LONGER REFUSED HER OWN ROWS FOR PAPA'S EPOCHS, AND THAT IS THE INTEGRATION
    // DECISION. The cell includes the depositor, so her junk for epoch 1 lands BESIDE his rather
    // than being turned away. Refusing her was what let a hostile member own a JOINER's empty
    // cells for ever and deny her the family's history (§1d/§1e, measured). What must hold — and
    // what this row asserts — is not that her write failed, but that HIS ROW DID NOT MOVE.
    assert.equal(rotation.status, 200, JSON.stringify(rotation.json));
    assert.equal(bytesAfter, bytesBefore,
      'THE INVARIANT: Papa\'s OWN epoch-1 wrap — deposited by him at `POST /spaces`, addressed '
      + 'to his own IK_kex, under his own device id — is byte-for-byte the row he wrote.');
    for (const [k, v] of historyBefore) {
      assert.equal(historyAfter.get(k), v,
        `the cell ${k} is unchanged — the WHOLE history, every epoch and every depositor, not `
        + 'just the first row');
    }
    assert.equal(historyAfter.size, historyBefore.size + eveRows.length,
      'every row that existed before still exists: she ADDED, and replaced nothing');

    // NON-VACUITY. Without this the row above would pass just as well against a store that had
    // rejected her request outright, which is a different (and worse) system.
    assert.ok(eveRows.length > 0,
      'and she really did deposit rows addressed to Papa — this is not a rotation that bounced');
    assert.ok(eveRows.some((w) => w.epoch <= prevEpoch),
      'including rows for epochs BELOW her own, which is the whole of T5-K3\'s attack: they are '
      + 'on the relay, they are hers, they open nothing, and they took nothing');
  });

  test('§3a2 · CLOSED · the response says what LANDED, beside what was sent', () => {
    // This row was REPORTED to `server/core/handlers/spaces.js` and is answered there.
    // `wrapsStored` still counts rows SUBMITTED, because three server suites and
    // `server/dev/two-client.js` already read it and a field that quietly changes what it counts
    // is worse than a field that needs a second one beside it.
    assert.ok(rotation.json.wrapsStored > before1,
      'she SUBMITTED more rows than Papa had');
    assert.equal(rotation.json.wrapsPurged, 0);

    // ── THE THREE COUNTS, WHICH ARE WHAT THE STORE ACTUALLY DID ─────────────────────────────
    // Without them a rotation that stored nothing is indistinguishable, on the wire, from one
    // that landed whole — and that is the shape of every finding in this file: nothing fails,
    // nothing is said, and a board stays empty.
    assert.equal(
      rotation.json.wrapsAdded + rotation.json.wrapsKept + rotation.json.wrapsRefused,
      rotation.json.wrapsStored,
      'the three account for every row submitted, so the number is readable rather than a hint');
    assert.ok(rotation.json.wrapsAdded > 0,
      'the cells she was entitled to really did land, so this is not a 200 that did nothing');

    // ⚠ AND WHAT THE COUNTS ARE NOT. `wrapsRefused` is NOT an abuse signal and no rule may be
    // built on one. Now that the depositor is part of the cell, a refusal can only ever be a
    // device re-wrapping ITS OWN earlier cell with a fresh salt and IV — which every rotation
    // after the first does, for every epoch below its own. Eve's whole attack is `wrapsAdded`,
    // and it is indistinguishable, count-wise, from an honest member delivering a joiner her
    // history. That is why the residual in §1a is a residual and not a rule.
    assert.equal(rotation.json.wrapsRefused, 0,
      'her attack refuses NOTHING: every junk row she aimed at Papa\'s history is a new row of '
      + 'her own. The relay cannot tell it from a delivery, and §1a says so.');
  });

  test('§3b · FAILED · the founding member recovers his whole key history from the relay', () => {
    // The A2 path (ADR 002 §7.3) is the one that survives losing every device, and it has
    // nothing but this table. Before the fix this device — the FOUNDER's, with his own IK_kex
    // and RK_kex — admitted nothing at all.
    const want = [];
    for (let e = 1; e <= prevEpoch; e++) want.push(e);
    assert.deepEqual(freshAdmit.admitted, want,
      `THE INVARIANT: epochs [${want}] open on a device restored onto an EMPTY ring`);
    assert.deepEqual(freshAdmit.epochs, want, 'and they are in the ring, not merely counted');
    assert.equal(freshAdmit.refused, 1,
      'exactly one row refused, and it is the epoch Eve herself deposited junk into — a T5-K1 '
      + 'shaped loss of the NEW epoch, not of the history. Closing that is §1\'s business.');
    assert.equal(freshAdmit.keysPending, true,
      'and this device says so: it holds 1..' + prevEpoch + ' and the space is at ' + next);
  });

  test('§3c · FAILED · a second rotation over the same cells changes nothing either', async () => {
    // Once is an accident. The rule has to hold on the second attempt, on the third, and against
    // an attacker who now knows exactly which cells she is aiming at.
    const again = await hostileRotate(C, C.eve, async (rid, e) => junkWrap(C, e + 1000),
      { epoch: next + 1 });
    assert.equal(again.status, 200, JSON.stringify(again.json));
    const now = await C.papa.transport.request('GET', `/api/v1/spaces/${C.spaceId}/keys`, undefined, undefined);
    const held = new Map(now.json.wraps.map((w) => [cell(w), w.wrapped]));
    for (const [k, v] of historyBefore) {
      assert.equal(held.get(k), v, `the cell ${k} survived the second attempt too`);
    }
    // Her SECOND set of junk cannot displace her FIRST set either. A rule that only protects
    // other people's rows would still let her rewrite history she had already claimed, and a
    // future joiner reads the relay, not the author.
    for (const w of eveRows) {
      assert.equal(held.get(cell(w)), w.wrapped,
        'and she cannot rewrite her OWN earlier rows: write-once is a property of the cell, not '
        + 'a privilege check on who is asking');
    }
  });

  test('§3d · NON-VACUITY · an HONEST rotation was refused the same cells and still succeeded', () => {
    // THE CONTROL THAT MATTERS, and it is not hypothetical: it already ran, in `before()`, on
    // this circle, before Eve did anything. Papa founded the space (epoch 1) and then rotated to
    // epoch 2 when Eve joined — and `wrapRingToRecipients` re-wraps 1..e+1 every time (A4, story
    // 17.1) while `wrapSpaceKey` draws a fresh 32-byte salt and a fresh 12-byte IV per wrap. So
    // Papa's honest rotation submitted DIFFERING bytes for the epoch-1 cell it could not have,
    // exactly as Eve's did.
    //
    // Every fix in this pass could be "closed" by breaking something legitimate, and write-once
    // is the easiest of them all to close that way: refuse the BATCH instead of the ROW and the
    // attack dies — along with the second rotation of every family that ever exists.
    assert.ok(prevEpoch >= 2, `the honest rotation really happened: the space reached ${prevEpoch}`);
    assert.equal(historyBefore.get(cell({ epoch: 1, senderKexPubRaw: papaKex })), foundingBytes1,
      'the epoch-1 cell still holds the bytes `POST /spaces` wrote: Papa\'s own honest rotation '
      + 'was refused that cell too, and correctly — putting the DEPOSITOR in the cell did not '
      + 'turn write-once into a privilege check. A device cannot rewrite its own history either, '
      + 'because a future joiner reads the relay and not the author.');
    assert.ok(historyBefore.has(cell({ epoch: prevEpoch, senderKexPubRaw: papaKex })),
      'and the cells it was entitled to — the new epoch — landed, so the rotation was a 200');
  });

  test('§3e · NON-VACUITY · Papa\'s own ring and engine are untouched by any of it', () => {
    // His own epochs, not the relay's: Papa has not synced since Eve rotated, so he is a step
    // behind on purpose. What matters is that everything he DOES hold is whole and gapless —
    // the ring lives in his `localStorage` and no relay write could ever have reached it.
    const mine = epochsOf(C, C.papa);
    assert.equal(mine[0], 1, `Papa still holds the history from epoch 1: ${JSON.stringify(mine)}`);
    assert.equal(C.papa.ring.covers(C.spaceId, C.papa.ring.currentEpoch(C.spaceId)), true,
      'gapless: the member who is online never depended on the relay for a key he already had');
    assert.equal(C.papa.engine.status().state !== 'error', true);
    assert.equal(typeof createKeyDelivery, 'function');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · THE CONTROL FOR THE WHOLE FILE — what the same attacker CANNOT do
//
// Ranking a break means knowing what held. These rows are the barriers Eve walked past nothing
// of, driven with the same hands, so the report can say "the crypto held; the bookkeeping did
// not" and mean it.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · what held: the sender set, the scopes, and the relay\'s recipient allowlist', () => {
  let C = null;

  before(async () => {
    C = await buildCircle(['papa', 'eve']);
    await refreshRoster(C);
    await found(C);
    assert.equal((await join(C, C.eve)).status, 200);
    await refreshRoster(C);
    await on(C.papa, () => C.papa.engine.syncNow());
    await bring(C, C.eve);
  });

  test('§4a · a wrap addressed to a recipient this space never heard of is refused', async () => {
    const roster = await C.eve.transport.request(
      'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined);
    const next = roster.json.currentEpoch + 1;
    const outsider = 'dev_AAAAAAAAAAAAAAAAAAAAAA';
    const ids = [...rosterDeviceIdsOf(roster.json.members), outsider];
    const res = await hostileRotate(C, C.eve, () => junkWrap(C, 1), { epoch: next, recipients: ids });
    assert.equal(res.status, 400);
    assert.equal(res.json.reason, 'unknown_recipient');
  });

  test('§4b · a rotation that leaves a live device out is refused by the relay', async () => {
    const roster = await C.eve.transport.request(
      'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined);
    const next = roster.json.currentEpoch + 1;
    const res = await hostileRotate(C, C.eve, () => junkWrap(C, 1),
      { epoch: next, recipients: [C.eve.forStore.deviceId] });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'incomplete_coverage',
      'the check has real teeth about WHO is named; it has none about WHAT is in the bytes');
  });

  test('§4c · Eve cannot name herself the depositor of somebody else\'s wrap', async () => {
    const roster = await C.eve.transport.request(
      'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined);
    const next = roster.json.currentEpoch + 1;
    const ids = rosterDeviceIdsOf(roster.json.members);
    const wraps = [];
    for (const id of ids) {
      for (let e = 1; e <= next; e++) {
        wraps.push({
          recipientId: id, epoch: e, wrapped: await junkWrap(C, e),
          senderDeviceId: C.papa.forStore.deviceId,          // ← the field she may not write
        });
      }
    }
    const res = await C.eve.transport.request(
      'POST', `/api/v1/spaces/${C.spaceId}/epoch`, undefined, { epoch: next, wraps }, {});
    assert.equal(res.status, 400, 'readWraps\' closed field set holds (finding E2E3-3)');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · ATTACK T5-K4 — WRAPPING THE RING TO SOMEBODY WHO SHOULD NOT HAVE IT.
//
//   The task's question is "can a member be MADE to wrap the ring to someone who should not have
//   it?" and §4a answers the crude form: no, the relay refuses an unknown recipient. The form
//   that works needs no forgery at all. A member's own `RK_sig` attests devices — that is what an
//   attestation IS (ADR 002 §2.3) — so Eve signs an attestation for a keypair she has just handed
//   to somebody outside the family, posts it to `POST /api/v1/devices`, and every honest member's
//   next ordinary sync wraps epochs 1..e+1 to it. No signature is forged, no barrier is walked
//   past, and every check in `recipientProblem()` passes because everything about the row is true.
//
//   ADR 002 §8.5 accepts a neighbouring case ("a malicious admin could add a phantom MEMBER") and
//   names the mitigation: "the member list shows per-member device counts, so an extra device is
//   visible to a curious member". This row is that residual, driven — including the delivery,
//   which §8.5 does not mention and which is what makes the outsider a reader of the HISTORY.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§5 · T5-K4 · a member attests an outsider\'s Mac and the family delivers the ring to it', () => {
  let C = null;
  let registered = null;
  let outsider = null;
  let delivery = null;
  let wraps = null;

  before(async () => {
    C = await buildCircle(['papa', 'eve']);
    await refreshRoster(C);
    await found(C);
    assert.equal((await join(C, C.eve)).status, 200);
    await refreshRoster(C);
    await on(C.papa, () => C.papa.engine.syncNow());
    await bring(C, C.eve);
    await on(C.papa, async () => {
      await C.papa.engine.syncNow();
      await publishSharedEntry(C, C.papa, newUuid(),
        { 'pub.text': 'Omas Geburtstag', 'pub.date': '2023-11-14' });
      await C.papa.engine.syncNow();
    });

    // A keypair Eve generated for somebody who is not in the family. Nothing about it is hers.
    const sig = await S.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const kex = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const sigPubRaw = b64u(await exportRawPublic(sig.publicKey));
    const kexPubRaw = b64u(await exportRawPublic(kex.publicKey));
    outsider = {
      memberId: C.eve.forStore.memberId,          // filed under EVE — she is vouching for it
      deviceId: mkDeviceId(),
      deviceShort: await deviceShortOf(await exportRawPublic(sig.publicKey)),
      sigPubRaw,
      kexPubRaw,
      kexPriv: kex.privateKey,
    };
    // The SHIPPED minting function, with Eve's own recovery key. Nothing is hand-rolled.
    const { blob } = await attestPeer(outsider, C.eve.recovery.recSig, '2026-08-29');
    registered = await C.eve.transport.request('POST', '/api/v1/devices', undefined, {
      spaceId: C.spaceId,
      memberId: outsider.memberId,
      deviceId: outsider.deviceId,
      deviceShort: outsider.deviceShort,
      sigPubRaw, kexPubRaw,
      attestation: blob,
    }, {});

    await refreshRoster(C);
    // ONE ORDINARY TICK on the honest admin's Mac. Nobody tells him anything.
    delivery = await on(C.papa, () => C.papa.engine.syncNow());
    wraps = await C.eve.transport.request(
      'GET', `/api/v1/spaces/${C.spaceId}/keys`, undefined, undefined);
  });

  test('§5a · the relay accepted a device attested by a member for a key she does not control', () => {
    assert.equal(registered.status, 200, JSON.stringify(registered.json));
  });

  test('§5b · SUCCEEDED · the honest admin\'s next sync wrapped 1..e+1 to it, unprompted', () => {
    assert.equal(delivery.delivery.verdict, DELIVERY.DELIVERED,
      'a new recipient is uncovered, so §7.1 step 4 hands it the whole ring — as designed');
    assert.ok(delivery.delivery.uncovered.includes(outsider.deviceId),
      'and the outsider\'s device is the recipient the delivery was FOR');
    assert.ok(delivery.delivery.detail.includes(`1..${delivery.delivery.epoch}`),
      `wraps for the whole history: ${delivery.delivery.detail}`);
  });

  test('§5c · every barrier passed, because every fact about the row is true', async () => {
    const { familyRecipientsReport, recipientProblem } = await import('../../src/js/crypto/spacekeys.js');
    const roster = await C.papa.transport.request(
      'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined);
    const { recipients } = familyRecipientsReport(roster.json.members);
    const r = recipients.find((x) => x.deviceId === outsider.deviceId);
    assert.ok(r, 'it is a recipient of this space');
    assert.equal(await recipientProblem(r), null,
      'ADR 002 §2.3: the attestation verifies under its housing member\'s RK_sig, the short is '
      + 'the short of the key, and att.kexPubRaw IS the key the wrap is addressed to');
  });

  test('§5d · CLOSED · §8.5\'s stated mitigation is BUILT, and is now FED', () => {
    assert.equal(wraps.status, 200, 'the wraps really are on the relay, addressed to the outsider');
    // §8.5, verbatim: "Partial mitigation: the member list shows per-member device counts, so an
    // extra device is visible to a curious member."
    //
    // WHEN THIS ROW WAS WRITTEN that sentence described nothing: `MemberRow` had eight fields —
    // memberId, displayName, colorRef, initial, alive, isMe, isAdmin, hidden — and none of them
    // was a device count. The roster response carried `devices[]`, so the fact was on the wire
    // and reached no screen.
    const ui = readFileSync(new URL('../../src/js/family/membersui.js', import.meta.url), 'utf8');
    const rowShape = ui.slice(ui.indexOf('@typedef {Object} MemberRow'), ui.indexOf('@typedef {Object} MembersPort'));
    assert.match(rowShape, /deviceCount/,
      `INVERTED: \`MemberRow\` carries the count now:\n${rowShape}`);
    assert.match(ui, /member-tag-dev/,
      'and the module actually renders it as a tag, rather than merely computing it');
    assert.match(ui, /Array\.isArray\(r\.devices\)/,
      'reading only the LENGTH of a network-supplied array, so a relay that answers '
      + '`devices: 9999` cannot put a nine-thousand into a family\'s member list');

    // ── INVERTED · the half that was REPORTED to another module, and landed there ─────────────
    //
    // `family/mount.js#refreshRoster` used to map the relay's member list down to three fields —
    // memberId, colorRef, removedAt — so `deviceCount` was `null` on every row on every launch
    // and the tag rendered nowhere. The mitigation existed and was fed by nothing. One field on
    // one map closed it.
    const mount = readFileSync(new URL('../../src/js/family/mount.js', import.meta.url), 'utf8');
    // Sliced to the END of the function rather than by a character budget: a fixed window silently
    // stops covering the code it is meant to read the moment a comment above it grows.
    const rosterAt = mount.indexOf('async function refreshRoster');
    const mapping = mount.slice(rosterAt, mount.indexOf('\n}', rosterAt));
    assert.ok(mapping.includes('rosterCache ='), 'the slice really covers the mapping it asserts on');
    assert.match(mapping, /devices:/,
      `INVERTED: the roster mapping carries \`devices\` through, so a curious member can see that `
      + `somebody's Mac count went up:\n${mapping.split('rosterCache =')[1] || mapping}`);
    assert.match(mapping, /Array\.isArray\(m\.devices\)/,
      'and it carries it as an ARRAY it checked, so a relay answering `devices: 9999` reaches '
      + '`membersui.js` as an empty list rather than as a number it will render');
  });
});
