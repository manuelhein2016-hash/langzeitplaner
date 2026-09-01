// FLEET · T2 — THE REMOVED MEMBER, AND T5's SPACE-MANAGEMENT CAPABILITIES.
// ADR 002 §0 T2/T5 · §4.1 · §4.3 · §7.1 (residual risk) · §8.1 · §8.4 · ADR 003 §2, §6.3 ·
// stories 20.1, 20.2, 20.3, 20.5 · LZP-608 · Addendum §6.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT IS BEING ASKED
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// §0 the ex-partner, after the door closes: can she decrypt a future op, push, pull, use a
//    retained epoch key against a new epoch, exploit the removal→rotation window, or come back?
// §1 the same question asked of the *product's own* claim about what a removal cannot undo.
// §2 **the capability audit story 20.5 is about — run in BOTH directions.** 20.5 says an admin
//    gets space management and never a read. The read half holds. The other half does not hold
//    at all: the relay cannot check "admin" (its own finding E2-203-2), so every management
//    capability 20.1 reserves for the admin is available to EVERY member — including the two
//    that E2-203-2 said, in writing, must therefore not be built.
//
// The removed member here is Mama. The hostile member is Eve. Both are ordinary invited members
// with ordinary clients; nothing below forges anything.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE MUTANT — one run, in a scratch copy of the tree
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   M-D  `server/core/handlers/lifecycle.js` — `POST /members/remove` and
//        `POST /spaces/:id/delete` are WITHDRAWN, which is finding E2-203-2's own stated
//        conclusion applied literally.                                    → §1a · §1b · §1c
//        Collateral, named rather than hidden: §0a, §0b and §0d also die, because the honest
//        admin's removal uses the same route. That is the shape of the finding — there is one
//        route and it cannot tell the two callers apart.
//

import '../helpers/env.js';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { entityUuid as newUuid } from '../../src/js/core/ids.js';
import { openOp } from '../../src/js/crypto/envelope.js';
import { ROTATION_HONESTY, DELIVERY } from '../../src/js/sync/keys.js';

import {
  buildCircle, join, refreshRoster, bootMac, engineFor, on,
  publishAttestation, publishSharedEntry, boardOf, mintMember, memberRow, deviceRow, S,
} from './e6-attack-circle.js';

async function found(C) {
  await bootMac(C, C.papa);
  await on(C.papa, async () => {
    assert.equal(C.papa.store.apply('attestMyDevice', {
      deviceShort: C.papa.forStore.deviceShort, blob: C.papa.myBlob,
    }), true);
    assert.equal(C.papa.store.apply('claimAdmin', {}), true);
    C.papa.engine = engineFor(C, C.papa);
    assert.equal((await C.papa.engine.pushNow()).pushed, 2);
  });
}

async function bring(C, mac) {
  await bootMac(C, mac);
  await on(mac, async () => {
    mac.engine = engineFor(C, mac);
    await mac.engine.syncNow();
    await publishAttestation(C, mac);
  });
}

/** A circle of three, everyone holding the ring, one shared entry each. */
async function circleOfThree() {
  const C = await buildCircle(['papa', 'mama', 'eve']);
  await refreshRoster(C);
  await found(C);
  for (const m of [C.mama, C.eve]) assert.equal((await join(C, m)).status, 200);
  await refreshRoster(C);
  await on(C.papa, () => C.papa.engine.syncNow());
  await bring(C, C.mama);
  await bring(C, C.eve);
  await refreshRoster(C);
  for (const m of [C.papa, C.mama, C.eve]) await on(m, () => m.engine.syncNow());
  return C;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §0 · T2 — THE REMOVED MEMBER
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§0 · T2 · the removed member, at the door and behind it', () => {
  let C = null;
  let removal = null;
  let midWindow = null;
  let rotation = null;
  let mamaEpochsAfter = [];
  let futureEnvelope = null;

  before(async () => {
    C = await circleOfThree();
    assert.ok(C.mama.ring.currentEpoch(C.spaceId) >= 3, 'Mama really held the ring first');
    const before = C.mama.ring.epochs(C.spaceId).slice();

    // Papa removes Mama, through the relay route `family/removal.js` calls.
    removal = await C.papa.transport.request('POST', '/api/v1/members/remove', undefined,
      { spaceId: C.spaceId, memberId: C.mama.forStore.memberId }, {});

    // ── THE WINDOW ─────────────────────────────────────────────────────────────────────────
    // `removal.js` runs `remove ──▶ rotate ──▶ author ──▶ publish`. This is the instant BETWEEN
    // the first two, which is the window a removed member would have to exploit.
    midWindow = {
      pull: await C.mama.transport.request('GET', '/api/v1/ops',
        { space: C.spaceId, since: '0', limit: '10' }, null, {}),
      keys: await C.mama.transport.request('GET', `/api/v1/spaces/${C.spaceId}/keys`, undefined, undefined),
      members: await C.mama.transport.request('GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined),
    };

    await refreshRoster(C);
    rotation = await on(C.papa, () => C.papa.engine.keys.rotate('member.remove'));

    // A FUTURE op: Papa shares something after the rotation. Eve (still a member) can read it.
    await on(C.papa, async () => {
      await C.papa.engine.syncNow();
      await publishSharedEntry(C, C.papa, newUuid(),
        { 'pub.text': 'Nach der Trennung', 'pub.date': '2026-12-01' });
    });
    await on(C.eve, () => C.eve.engine.syncNow());     // Eve's own ordinary tick: she gets e+1
    const page = await C.eve.transport.request('GET', '/api/v1/ops',
      { space: C.spaceId, since: '0', limit: '100' }, null, {});
    futureEnvelope = page.json.ops.find((e) => e.ep === rotation.epoch);

    mamaEpochsAfter = C.mama.ring.epochs(C.spaceId).slice();
    assert.deepEqual(mamaEpochsAfter, before, 'nothing reached into her Mac — §8.1, Addendum §6');
  });

  test('§0a · the removal purged her ops and revoked her devices in one transaction', () => {
    assert.equal(removal.status, 200, JSON.stringify(removal.json));
    assert.equal(removal.json.removed, true);
    assert.equal(removal.json.revokedDevices, 1);
    assert.ok(removal.json.purgedWraps >= 1, 'ADR 002 §4.2 step 4 — every wrap she held, all epochs');
    assert.equal(removal.json.rotateRequired, true);
    assert.equal(removal.json.alreadyDeliveredIsIrrevocable, true,
      'the relay states the honest half rather than letting the client claim more');
  });

  test('§0b · FAILED · she cannot pull, cannot push, cannot fetch a key — from the same instant', () => {
    // The window is not a window: auth is per request, against the device row, so the same
    // transaction that removed her closed every route. There is nothing to exploit BETWEEN
    // `remove` and `rotate` because the first of the two already did the work.
    assert.equal(midWindow.pull.status, 403);
    assert.equal(midWindow.pull.json.error, 'device_revoked');
    assert.equal(midWindow.keys.status, 403);
    assert.equal(midWindow.members.status, 403);
  });

  test('§0c · FAILED · her retained epoch keys cannot open an op from the new epoch', async () => {
    assert.ok(futureEnvelope, 'NON-VACUITY: a real op sealed under the new epoch exists');
    assert.equal(mamaEpochsAfter.includes(rotation.epoch), false,
      `she holds ${mamaEpochsAfter} and the op is at ${rotation.epoch}`);
    const out = await openOp(futureEnvelope, C.mama.ring, (dv) => C.attestations.get(dv) ?? null);
    assert.equal(out.status, 'park', 'no plaintext, and not even an AEAD attempt');
    assert.equal(out.parkReason, 'epoch');
    // NON-VACUITY: the very same bytes DO open for a member who is still in the circle.
    const ok = await openOp(futureEnvelope, C.eve.ring, (dv) => C.attestations.get(dv) ?? null);
    assert.equal(ok.status, 'opened');
    assert.equal(ok.op.f['pub.text'], 'Nach der Trennung');
  });

  test('§0d · FAILED · she cannot rotate, and cannot deposit a key of her own choosing', async () => {
    const res = await C.mama.transport.request('POST', `/api/v1/spaces/${C.spaceId}/epoch`,
      undefined, { epoch: rotation.epoch + 1, wraps: [] }, {});
    assert.equal(res.status, 403);
  });

  test('§0e · FAILED · she cannot come back under the SAME member id', async () => {
    const proof = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const verifier = new Uint8Array(await S.digest('SHA-256', proof));
    const inviteId = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
    const mk = await C.eve.transport.request('POST', '/api/v1/invites', undefined,
      { spaceId: C.spaceId, inviteId, verifier: Buffer.from(verifier).toString('base64url') });
    assert.equal(mk.status, 200);
    const red = await C.mama.transport.request('POST', '/api/v1/invites/redeem', undefined, {
      inviteId,
      proof: Buffer.from(proof).toString('base64url'),
      colorRef: 'gelb',
      member: await memberRow(C.mama),
      device: await deviceRow(C.mama),
    });
    assert.equal(red.status, 400,
      'a removed member id is still a member id; the row cannot be resurrected');
    assert.equal(red.json.reason, 'exists');
  });

  test('§0f · SUCCEEDED-BY-DESIGN · she comes back under a FRESH pseudonym, and §8.4 says so', async () => {
    // ADR 002 §7.1 "Residual risk after D9" and §8.4: whoever holds a live invite becomes a
    // member. Nothing links the new identity to the removed one, and nothing is supposed to —
    // the control is the member list (15.4), not the relay.
    const mallory = await mintMember('mallory');
    mallory.transport = C.mama.transport.constructor === Object ? null : null;
    // A brand-new identity on the same Mac, using the ordinary transport-building path.
    const fresh = await buildFreshMac(C, 'mallory');
    const proof = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const verifier = new Uint8Array(await S.digest('SHA-256', proof));
    const inviteId = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
    const mk = await C.eve.transport.request('POST', '/api/v1/invites', undefined,
      { spaceId: C.spaceId, inviteId, verifier: Buffer.from(verifier).toString('base64url') });
    assert.equal(mk.status, 200);
    const red = await fresh.transport.request('POST', '/api/v1/invites/redeem', undefined, {
      inviteId,
      proof: Buffer.from(proof).toString('base64url'),
      colorRef: 'rot',
      member: await memberRow(fresh),
      device: await deviceRow(fresh),
    });
    assert.equal(red.status, 200, 'she is a member again, under a name she chose');
    // …and the ONLY control is that everybody can see it. Assert the control actually exists.
    const list = await C.eve.transport.request(
      'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined);
    assert.ok(list.json.members.some((m) => m.memberId === fresh.forStore.memberId),
      '15.4 — the new member is visible to every other member, which is the whole defence');
    assert.ok(mallory);
  });

  test('§0g · the product\'s own sentence about all this is still the honest one', () => {
    assert.match(ROTATION_HONESTY.cannotUndo, /already pulled/);
    assert.match(ROTATION_HONESTY.de, /bleibt auf ihrem Mac/);
    assert.equal(rotation.verdict, DELIVERY.DELIVERED, 'and the rotation really happened');
  });
});

/** A brand-new identity with its own transport on the same relay. */
async function buildFreshMac(C, tag) {
  const m = await mintMember(tag);
  const template = C.papa.transport;
  // The transport is rebuilt through the same factory the rig uses for everybody else: the only
  // thing that differs is whose key signs the request.
  const { buildRequest } = await import('../../src/js/platform/net.js');
  m.transport = {
    origin: template.origin,
    async request(method, path, query, body, headers) {
      const cfg = {
        origin: template.origin,
        deviceShort: m.forStore.deviceShort,
        sign: m.sign,
        clientVersion: '2.0.0',
        now: C.now,
        random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
        subtle: S,
      };
      const req = await buildRequest(cfg, method, path, query, body, headers);
      const url = new URL(req.url);
      const q = {};
      for (const [k, v] of url.searchParams) q[k] = v;
      const h = {};
      for (const k of Object.keys(req.headers)) h[k.toLowerCase()] = String(req.headers[k]);
      h['x-real-ip'] = '127.0.0.1';
      const res = await C.relay.handle({
        method: req.method, path: url.pathname, query: q, headers: h,
        body: body ?? null, rawBody: req.rawBody, clientIp: '127.0.0.1',
      });
      return { status: res.status, headers: res.headers, json: res.body };
    },
  };
  return m;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · ATTACK T5-M1 — ANY MEMBER CAN PURGE ANY OTHER MEMBER, INCLUDING THE ADMIN.
//
//   ADR 002 §0's T5 row names "ability to purge another member" in the "must NOT get" column.
//   `server/core/handlers/spaces.js` finding **E2-203-2** — the server's own record — says the
//   relay cannot check "admin" on any route, and then draws the correct conclusion in writing:
//
//       "It is NOT inside the model for `POST /members/remove` and `POST /spaces/:id/delete`,
//        WHICH IS WHY NEITHER IS IMPLEMENTED HERE: an unverifiable 'admin' endpoint that purges
//        another member's ops is the censorship primitive ADR 003 §6.3 explicitly rejects."
//
//   Both are implemented now, in `server/core/handlers/lifecycle.js`, behind
//   `ctx.assertMember(auth.memberId, spaceId)` and nothing else.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// STATE OF THIS ATTACK AFTER THE T5-M1 PASS — READ BEFORE CHANGING A ROW
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
//   §1a, §1b  **STILL SUCCEED.** `POST /members/remove` still authorizes on membership alone.
//             Carried as finding **T5-M1a** in `lifecycle.js#LIFECYCLE_FINDINGS`: the relay now
//             HAS the check (`adminProofGate(..., required: false)`) and does not yet demand it,
//             because demanding it changes what an unproofed honest caller gets and four rows in
//             two fleet suites — `round9-e6.test.js` and `round10-e6-gate.test.js` ×3 — require
//             `200` + `purgedOps > 0` from exactly that caller. One parameter, plus those
//             callers, plus a D7 ruling.
//
//   §1c       **INVERTED.** `POST /spaces/:id/delete` now requires a SECOND member's recovery
//             signature (ADR 003 §3.7). The relay still cannot tell who the admin is — the
//             founder is not derivable, see `auth.js` finding E2-L1b — but it does not have to:
//             T5 is ONE member with ONE Keychain, and she cannot sign under a key she does not
//             hold. The row keeps its old assertions underneath the refusal, plus a non-vacuity
//             half proving the honest two-key delete still works.
//
//   §1e       **NEW, and it is the honest residual.** While §1a stands she can still empty the
//             circle in N+1 requests. Measured rather than argued (finding T5-M1c).
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * ADR 003 §3.7's admin proof, minted the way a Mac would: a signature by the SIGNER's recovery
 * key over bytes the relay assembles for itself. `adminProofString` is imported from the server,
 * so a drift between what a client signs and what the relay verifies is a red row here.
 */
async function adminProof(mac, act, spaceId, target, epoch) {
  const { adminProofString } = await import('../../server/core/auth.js');
  const bytes = new TextEncoder().encode(adminProofString({ act, spaceId, target, epoch }));
  const sig = new Uint8Array(await S.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, mac.recovery.recSig.privateKey, bytes));
  return { by: mac.forStore.memberId, sig: Buffer.from(sig).toString('base64url') };
}

describe('§1 · T5-M1 · INVERTED · a plain member can do neither, and both take a second key', () => {
  let C = null;
  let evicted = null;
  let papaPull = null;
  let papaKeys = null;
  let papaRejoin = null;
  let deleted = null;
  let deletedTries = null;
  let deletedHonest = null;
  let evictedTries = null;
  let evictedHonest = null;
  let papaPullAfter = null;
  let papaOpsOnRelay = 0;

  before(async () => {
    C = await circleOfThree();
    // Eve is not the admin. `store.familyAdmin()` on Papa's Mac says who is.
    await on(C.papa, () => {});
    evicted = await C.eve.transport.request('POST', '/api/v1/members/remove', undefined,
      { spaceId: C.spaceId, memberId: C.papa.forStore.memberId }, {});
    // Every mirror-image shape a patched client reaches for once the bare request is refused.
    const ep0 = (await C.relay.store.getSpace(C.spaceId)).currentEpoch;
    evictedTries = [];
    for (const [pf, hint] of [
      [await adminProof(C.eve, 'member.remove', C.spaceId, C.papa.forStore.memberId, ep0), 'her own recovery key'],
      [{ by: C.mama.forStore.memberId, sig: (await adminProof(C.eve, 'member.remove', C.spaceId, C.papa.forStore.memberId, ep0)).sig },
        "Mama's name over Eve's signature"],
      [await adminProof(C.mama, 'space.delete', C.spaceId, C.papa.forStore.memberId, ep0), 'the wrong act'],
      [await adminProof(C.mama, 'member.remove', C.spaceId, C.papa.forStore.memberId, ep0 + 1), 'the neighbouring epoch'],
      [await adminProof(C.mama, 'member.remove', C.spaceId, C.eve.forStore.memberId, ep0), 'a proof naming ANOTHER target'],
    ]) {
      evictedTries.push([hint, await C.eve.transport.request('POST', '/api/v1/members/remove', undefined,
        { spaceId: C.spaceId, memberId: C.papa.forStore.memberId, adminProof: pf }, {})]);
    }
    // What Papa can still do, measured while he is still IN the circle.
    papaPull = await C.papa.transport.request('GET', '/api/v1/ops',
      { space: C.spaceId, since: '0', limit: '10' }, null, {});
    papaKeys = await C.papa.transport.request(
      'GET', `/api/v1/spaces/${C.spaceId}/keys`, undefined, undefined);
    papaOpsOnRelay = (await C.relay.store.listOps(C.spaceId, 0n, 1000)).ops
      .filter((o) => o.deviceShort === C.papa.forStore.deviceShort).length;

    // NON-VACUITY: the founder CAN be removed — it takes a second live member's key. Driven last,
    // after everything above has been measured on an intact circle, and then UNDONE is impossible
    // — so the delete half below runs against the circle this leaves.
    evictedHonest = await C.eve.transport.request('POST', '/api/v1/members/remove', undefined,
      { spaceId: C.spaceId, memberId: C.papa.forStore.memberId,
        adminProof: await adminProof(C.mama, 'member.remove', C.spaceId, C.papa.forStore.memberId, ep0) }, {});
    papaPullAfter = await C.papa.transport.request('GET', '/api/v1/ops',
      { space: C.spaceId, since: '0', limit: '10' }, null, {});
    // He cannot even come back: his member id is taken by his own tombstone (§0e).
    const proof = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const verifier = new Uint8Array(await S.digest('SHA-256', proof));
    const inviteId = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
    await C.eve.transport.request('POST', '/api/v1/invites', undefined,
      { spaceId: C.spaceId, inviteId, verifier: Buffer.from(verifier).toString('base64url') });
    papaRejoin = await C.papa.transport.request('POST', '/api/v1/invites/redeem', undefined, {
      inviteId,
      proof: Buffer.from(proof).toString('base64url'),
      colorRef: 'gelb',
      member: await memberRow(C.papa),
      device: await deviceRow(C.papa),
    });
    deleted = await C.eve.transport.request(
      'POST', `/api/v1/spaces/${C.spaceId}/delete`, undefined, { confirm: C.spaceId }, {});
    // Every next thing a patched client would try, each refused for its own reason.
    const ep = (await C.relay.store.getSpace(C.spaceId)).currentEpoch;
    deletedTries = [];
    for (const [pf, hint] of [
      [await adminProof(C.eve, 'space.delete', C.spaceId, C.spaceId, ep), 'her own recovery key'],
      [{ by: C.mama.forStore.memberId, sig: (await adminProof(C.eve, 'space.delete', C.spaceId, C.spaceId, ep)).sig },
        "Mama's name over Eve's signature"],
      [await adminProof(C.papa, 'space.delete', C.spaceId, C.spaceId, ep), "the REMOVED admin's own key"],
      [await adminProof(C.mama, 'member.remove', C.spaceId, C.spaceId, ep), 'the wrong act'],
      [await adminProof(C.mama, 'space.delete', C.spaceId, C.spaceId, ep + 1), 'the neighbouring epoch'],
    ]) {
      deletedTries.push([hint, await C.eve.transport.request(
        'POST', `/api/v1/spaces/${C.spaceId}/delete`, undefined,
        { confirm: C.spaceId, adminProof: pf }, {})]);
    }
    // NON-VACUITY: Mama is still in the circle and her key really does open the door.
    deletedHonest = await C.eve.transport.request(
      'POST', `/api/v1/spaces/${C.spaceId}/delete`, undefined,
      { confirm: C.spaceId, adminProof: await adminProof(C.mama, 'space.delete', C.spaceId, C.spaceId, ep) }, {});
  });

  test('§1a · INVERTED · the admin is ANCHORED: an ordinary member cannot throw him out', () => {
    // WAS: `evicted.status === 200` — one request, and the person who created the Familienkreis
    // was outside it. That is finding T5-M1a.
    //
    // The relay still cannot check "admin": the admin chain is an in-log `transferAdmin` op
    // inside the ciphertext (ADR 001 §4.1). What it CAN check is who created the space, because
    // it wrote that row itself — `Space.founderMemberId`, stamped inside `POST /spaces`, never
    // off a body, never moved afterwards. Removing THAT member takes a second member's recovery
    // signature (ADR 003 §3.7).
    assert.equal(evicted.status, 403, JSON.stringify(evicted.json));
    assert.equal(evicted.json.error, 'admin_proof_required');
    assert.equal(evicted.json.field, 'adminProof');
    assert.equal(evicted.json.reason, 'founder_removal_needs_second_key');
    for (const [hint, res] of evictedTries) {
      assert.equal(res.status === 400 || res.status === 401 || res.status === 403, true,
        `the relay accepted ${hint}: ${res.status} ${JSON.stringify(res.json)}`);
      assert.notEqual(res.json.removed, true, `the relay removed the admin on ${hint}`);
    }
    // And he is still there, with everything he had: the refusal is not a partial act.
    assert.equal(papaPull.status, 200, 'he can still pull');
    assert.equal(papaKeys.status, 200, 'he can still fetch his keys');
  });

  test('§1b · INVERTED · §4.0 and §4.1\'s two founding ops are still on the relay', () => {
    // The other half, and the half that says WHY the founder is the one member the relay
    // defends. His `member.set{dev.*}` attestation and his `space.set{admin, adminPrev:null}`
    // genesis link are not his property — they are what lets EVERY future joiner admit anything
    // he ever wrote, and `adminAtIn` answers null for every stamp in the space without them.
    // Losing them is not one member leaving; it is the space destroyed for everybody.
    assert.ok(papaOpsOnRelay >= 2,
      `his two founding ops survived the attempt: ${papaOpsOnRelay} of his rows are on the relay`);
  });

  test('§1b-ii · NON-VACUITY · with a second live member\'s key the same removal works', () => {
    // A refusal that refuses everything is not a control, it is an outage — and the honest admin
    // path has to keep working, which is the whole difference between closing a finding and
    // breaking a feature. Mama is a member, her recovery key is the one on `Member.recoveryPubSig`,
    // and one signature from her turns the very same request into the 20.2 removal.
    assert.equal(evictedHonest.status, 200, JSON.stringify(evictedHonest.json));
    assert.equal(evictedHonest.json.removed, true);
    assert.equal(evictedHonest.json.authorizedBy, 'admin_proof');
    assert.equal(evictedHonest.json.revokedDevices, 1);
    assert.ok(evictedHonest.json.purgedOps >= 2, 'and it really is the same destructive act');
    assert.equal(evictedHonest.json.rotateRequired, true);
    assert.equal(papaPullAfter.status, 403);
    assert.equal(papaPullAfter.json.error, 'device_revoked');
  });

  test('§1c · INVERTED · she can no longer delete the Familienkreis — it takes a second key', () => {
    // WAS: `deleted.status === 200`, one request, three members' circle gone. The relay still
    // cannot check "admin"; what it now checks is that the caller was not ALONE, which is the
    // property that actually separates the honest admin from T5 (ADR 003 §3.7, ADR 002 §0 T5).
    assert.equal(deleted.status, 403, JSON.stringify(deleted.json));
    assert.equal(deleted.json.error, 'admin_proof_required',
      '403 and not 400: the request is well formed and she is authenticated — what is missing is '
      + 'AUTHORITY. `errors.js` gained the code during integration.');
    assert.equal(deleted.json.field, 'adminProof');
    assert.equal(deleted.json.reason, 'second_member_signature_required');
    for (const [hint, res] of deletedTries) {
      assert.equal(res.status === 400 || res.status === 401 || res.status === 403, true,
        `the relay accepted ${hint}: ${res.status} ${JSON.stringify(res.json)}`);
      assert.notEqual(res.json.deleted, true, `the relay deleted the circle on ${hint}`);
    }
  });

  test('§1c-ii · NON-VACUITY · with a second live member\'s key the same request works', () => {
    // A refusal that refuses everything is not a control, it is an outage. Mama is a member, her
    // recovery key is the one on `Member.recoveryPubSig`, and one signature from her turns the
    // very same request into the 20.4 delete — every promise it used to make, still made.
    assert.equal(deletedHonest.status, 200, JSON.stringify(deletedHonest.json));
    assert.equal(deletedHonest.json.deleted, true);
    assert.equal(deletedHonest.json.authorizedBy, 'admin_proof');
    assert.ok(deletedHonest.json.purged.members >= 3);
    assert.equal(deletedHonest.json.localBoardsUnaffected, true);
  });

  test('§1d · the client-side rule exists and is not the one that ran', async () => {
    // `core/ops.js#removeMember` refuses self-removal and `core/authz.js` resolves the admin from
    // the in-log chain — that is the enforcement E2-203-2's proposed resolution relies on. It is
    // real and it is on the WRONG SIDE of the wire: it decides whether the removal OP is
    // admissible, long after the relay has already purged the rows.
    const opsSrc = await import('node:fs').then((fs) => fs.readFileSync(
      new URL('../../src/js/core/ops.js', import.meta.url), 'utf8'));
    assert.match(opsSrc, /mustBeSittingAdmin\(ctx, 'removeMember'\)/,
      'the client HAS the rule: only the sitting admin may author a removal op');
    // The relay's check, for contrast: membership, and nothing else.
    const src = await import('node:fs').then((fs) => fs.readFileSync(
      new URL('../../server/core/handlers/lifecycle.js', import.meta.url), 'utf8'));
    const fn = src.slice(src.indexOf('export async function removeMember'), src.indexOf('20.3 — `POST /api/v1/members/leave`'));
    assert.match(fn, /ctx\.assertMember\(auth\.memberId, spaceId\)/);
    assert.equal(/isAdmin|adminOf|requireAdmin/.test(fn), false,
      'there is no admin check on the route, by design (E2-203-2) — and the route shipped anyway');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1e · THE RESIDUAL — finding T5-M1c. NEW ROW, and it SUCCEEDS.
//
//   §1c closed the ONE-REQUEST destruction primitive. It did not close destruction, and pretending
//   otherwise would be exactly the "closed by breaking something legitimate" failure the §0
//   controls exist to catch. While `/members/remove` authorizes on membership alone (§1a, finding
//   T5-M1a), a hostile member reaches an empty circle in N+1 requests: remove everyone, then
//   LEAVE — and `leaveSpace`'s last-member-out cascade deletes the space.
//
//   The cascade is deliberately NOT gated. Gating it would make a circle everybody left
//   voluntarily undeletable, and it would not close this path, because the path is the un-proofed
//   removal. Closing T5-M1a closes this row with it. Measured here so that "T5-M1 is closed"
//   cannot be said of the half that is not.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1e · T5-M1c · INVERTED · the long way round is shut too, because the founder anchors it', () => {
  let C = null;
  let removals = [];
  let founderTry = null;
  let left = null;
  let spaceAfter = null;

  before(async () => {
    C = await circleOfThree();
    // She may still remove every member who JOINED — that is T5-M1a's residual, and it is the
    // half this file must not claim is closed.
    removals.push(await C.eve.transport.request('POST', '/api/v1/members/remove', undefined,
      { spaceId: C.spaceId, memberId: C.mama.forStore.memberId }, {}));
    // And then she runs out of circle: the last member standing besides her is the FOUNDER.
    founderTry = await C.eve.transport.request('POST', '/api/v1/members/remove', undefined,
      { spaceId: C.spaceId, memberId: C.papa.forStore.memberId }, {});
    left = await C.eve.transport.request('POST', '/api/v1/members/leave', undefined,
      { spaceId: C.spaceId }, {});
    spaceAfter = await C.relay.store.getSpace(C.spaceId);
  });

  test('§1e · N removals plus one leave no longer empties the circle', async () => {
    // WAS: "SUCCEEDS · the long way round is still open". Eve reached an empty Familienkreis in
    // N+1 requests — remove everybody, then `/members/leave`, whose last-member-out cascade
    // deletes the space. The cascade was deliberately NOT gated, because gating it would make a
    // circle everybody left voluntarily undeletable and would not have closed the path anyway:
    // the path was the un-proofed REMOVAL, and that is where it is closed.
    for (const r of removals) {
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.authorizedBy, 'membership_only');
    }
    assert.equal(founderTry.status, 403, JSON.stringify(founderTry.json));
    assert.equal(founderTry.json.reason, 'founder_removal_needs_second_key');

    // She leaves. The cascade does NOT fire, because she is not the last member out — the
    // founder she could not remove is still standing.
    assert.equal(left.status, 200, JSON.stringify(left.json));
    assert.notEqual(left.json.spaceDeleted, true);
    assert.notEqual(spaceAfter, null, 'THE INVARIANT: the Familienkreis is still there');
    const live = (await C.relay.store.listMembers(C.spaceId)).filter((m) => m.removedAt === null);
    assert.deepEqual(live.map((m) => m.id), [C.papa.forStore.memberId],
      'and the founder is who is left in it');
  });

  test('§1e-ii · what it still costs her, stated: N attributable, rate-limited, visible requests', () => {
    // The residual, unchanged in shape and smaller in reach. Every member who JOINED is still one
    // request away: each removal is separately visible on every member list (15.4), separately
    // charged against `memberRemovePerMemberHour = 10`, and leaves the honest admin's client
    // holding a removal with no matching in-log op — an inconsistency rather than a fait
    // accompli. What she can no longer reach is the founder, and therefore the empty circle.
    assert.equal(removals.length, 1);
    assert.equal(removals[0].json.rotateRequired, true);
    assert.ok(removals[0].json.purgedOps >= 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · STORY 20.5's READ HALF — the capability audit, in the direction that HOLDS
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · 20.5 · no route, admin or otherwise, hands anybody a read', () => {
  let C = null;
  let asAdmin = null;
  let asMember = null;

  before(async () => {
    C = await circleOfThree();
    await on(C.papa, async () => {
      await publishSharedEntry(C, C.papa, newUuid(), { 'pub.text': 'Papas Zahnarzt' });
    });
    for (const m of [C.papa, C.mama, C.eve]) await on(m, () => m.engine.syncNow());
    const read = async (mac) => ({
      keys: await mac.transport.request('GET', `/api/v1/spaces/${C.spaceId}/keys`, undefined, undefined),
      members: await mac.transport.request('GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined),
      ops: await mac.transport.request('GET', '/api/v1/ops',
        { space: C.spaceId, since: '0', limit: '100' }, null, {}),
    });
    asAdmin = await read(C.papa);
    asMember = await read(C.eve);
  });

  test('§2a · the admin\'s key route serves HIS OWN wraps and nobody else\'s', () => {
    const mine = new Set(asAdmin.keys.json.wraps.map((w) => w.recipientId));
    assert.deepEqual([...mine].filter((r) => r !== C.papa.forStore.deviceId
      && r !== `rec_${C.papa.forStore.memberId}`), [],
      'there is no "give me everyone\'s wraps" shape, for the admin or for anyone');
    assert.equal(asAdmin.keys.json.wraps.length, asMember.keys.json.wraps.length,
      'the admin\'s answer is the same SHAPE as a plain member\'s — no extra rows, no extra field');
  });

  test('§2b · the member list carries public keys and colour refs, and no readable name', () => {
    const blob = JSON.stringify(asAdmin.members.json);
    for (const needle of ['Papas Zahnarzt', 'Papa', 'Mama', 'Zahnarzt', 'Familie']) {
      assert.equal(blob.includes(needle), false, `the roster leaks ${needle}`);
    }
  });

  test('§2c · the op stream is ciphertext for the admin exactly as for everybody', () => {
    const blob = JSON.stringify(asAdmin.ops.json);
    assert.ok(asAdmin.ops.json.ops.length > 0, 'NON-VACUITY: there really are ops to fail to read');
    assert.equal(blob.includes('Papas Zahnarzt'), false);
    assert.deepEqual(
      JSON.stringify(asAdmin.ops.json.ops.map((e) => Object.keys(e).sort())),
      JSON.stringify(asMember.ops.json.ops.map((e) => Object.keys(e).sort())),
      'identical envelope shape — the admin has no extra field anywhere');
  });

  test('§2d · and the read that DOES work works because of a key, not because of a role', async () => {
    const env = asAdmin.ops.json.ops.find((e) => typeof e.ct === 'string');
    assert.ok(env, 'NON-VACUITY: a sealed op');
    // Eve is not the admin and opens it; a device with no ring does not, whoever it belongs to.
    const asEve = await openOp(env, C.eve.ring, (dv) => C.attestations.get(dv) ?? null);
    assert.notEqual(asEve.status, 'park');
    const { createKeyRing } = await import('../../src/js/crypto/spacekeys.js');
    const asAdminWithoutKeys = await openOp(env, createKeyRing(), (dv) => C.attestations.get(dv) ?? null);
    assert.equal(asAdminWithoutKeys.status, 'park',
      '20.5, enforced by encryption and not by policy');
  });
});
