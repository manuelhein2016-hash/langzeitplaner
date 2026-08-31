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
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · T5-M1 · a plain member evicts the admin and then deletes the circle', () => {
  let C = null;
  let evicted = null;
  let papaPull = null;
  let papaKeys = null;
  let papaRejoin = null;
  let deleted = null;

  before(async () => {
    C = await circleOfThree();
    // Eve is not the admin. `store.familyAdmin()` on Papa's Mac says who is.
    await on(C.papa, () => {});
    evicted = await C.eve.transport.request('POST', '/api/v1/members/remove', undefined,
      { spaceId: C.spaceId, memberId: C.papa.forStore.memberId }, {});
    papaPull = await C.papa.transport.request('GET', '/api/v1/ops',
      { space: C.spaceId, since: '0', limit: '10' }, null, {});
    papaKeys = await C.papa.transport.request(
      'GET', `/api/v1/spaces/${C.spaceId}/keys`, undefined, undefined);
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
  });

  test('§1a · the admin\'s own Mac was thrown out of the circle by an ordinary member', () => {
    assert.equal(evicted.status, 200, JSON.stringify(evicted.json));
    assert.equal(evicted.json.removed, true);
    assert.equal(evicted.json.revokedDevices, 1);
    assert.equal(papaPull.status, 403);
    assert.equal(papaPull.json.error, 'device_revoked');
    assert.equal(papaKeys.status, 403);
    assert.equal(papaRejoin.status, 400, 'and he cannot rejoin under his own member id');
  });

  test('§1b · his ops were DELETED from the relay — including §4.0 and §4.1\'s two founding ops', () => {
    assert.ok(evicted.json.purgedOps >= 2,
      `purgedOps: ${evicted.json.purgedOps}. Those are his \`member.set{dev.*}\` attestation and `
      + 'the `space.set{admin, adminPrev:null}` genesis link — the two ops without which no '
      + 'future joiner can ever admit anything he ever wrote, and `adminAtIn` answers null for '
      + 'every stamp in the space');
  });

  test('§1c · and the same member can then delete the whole Familienkreis', () => {
    assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
    assert.equal(deleted.json.deleted, true);
    assert.ok(deleted.json.purged.members >= 3);
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
