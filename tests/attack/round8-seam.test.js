// ATTACK · ROUND 8 — THE SEAM: WHAT PUBLISHING `Device.attestation` COST.
// ADR 002 §2.3 · ADR 003 §3, §6.2 · story 21.1 · findings E2E3-6 / E2E3-7.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT CHANGED
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Round 8 made `Device.attestation` a PUBLISHED field: `GET /spaces/:id/members` returns it, and
// it is the roster `crypto/spacekeys.js familyRecipients()` is built from. Publishing a field the
// relay stores in the clear is a 21.1 question, and the round answered it — in
// `server/core/handlers/spaces.js`:
//
//   > With the set closed, **every field of a published blob is a value the relay already holds
//   > in a column** … Zero free bits. That is why the publication costs 21.1 nothing, and it is
//   > checkable rather than argued.
//
// `assertAttestationClosed()` is that check, and it is correct. `tests/server/blindness.test.js`
// §2 drives „Großmutter Käthe" at it and gets a `400 attestation_unknown_field`.
//
// THE ATTACK IS THE OTHER DOOR. `readDevice` — and therefore `assertAttestationClosed` — lives in
// `handlers/spaces.js` and is reached by `POST /spaces` and `POST /invites/redeem`. The route
// that exists precisely to add a device to an existing space is `POST /devices`, in
// `handlers/devices.js`, and it runs `verifyDeviceClaim` only. `verifyDeviceClaim` checks P2, S1
// and S2 — it is the SIGNATURE half — and its helper `parseAttestationBlob` is documented as
// deliberately TOLERATING extra fields, which is right for a parser and is the whole hazard for a
// door. The blob is then stored verbatim (`TextEncoder().encode(body.attestation)`) and published.
//
// One rule, three doors, two of them closed.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// INVERTED 2026-08-29 — R8-7 CLOSED.  One rule, FOUR doors, all of them closed.
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The rule moved DOWN rather than being copied sideways. `assertAttestationClosed` now lives in
// `server/core/handlers/devices.js` — the file `spaces.js` already imports `parseAttestationBlob`,
// `bytesToB64u` and `verifyDeviceClaim` from — and it runs inside `verifyDeviceClaim`, before the
// signature check, because a smuggled field is a SHAPE fault and never a forgery: the attacker
// signs it perfectly well with her own recovery key, so S1 could never have been what caught it.
//
// Four doors persist a `Device` row and every one of them now reaches the rule:
//
//     POST /spaces           createSpace   → readAttestedDevice → readDevice   (already closed)
//     POST /invites/redeem   redeemInvite  → readDevice                        (already closed)
//     POST /devices          registerDevice → attachDevice → verifyDeviceClaim (CLOSED HERE)
//     POST /devices/adopt    adoptDevice    → attachDevice → verifyDeviceClaim (CLOSED HERE)
//
// `tests/server/blindness.test.js` §7a is the other half of this inversion: it ENUMERATES those
// four doors, drives the corpus word at each, and asserts that the set of handler files able to
// persist a device row is exactly the three that exist — so a fifth door reddens a row rather
// than quietly reopening this. §1 below is the same measurement in the fleet, end to end, and it
// keeps the third Mac and the corpus word so the attack is still visible in the row that closed.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createFleet, simClock } from '../helpers/fleet.js';
import { b64u } from '../../src/js/core/b64.js';
import { generateDeviceKeys, exportRawPublic, deviceShortOfB64u } from '../../src/js/crypto/identity.js';

const TE = new TextEncoder();
const S = globalThis.crypto.subtle;

const BOARD = () => ({
  schemaVersion: 1,
  notes: [{ id: 'n1', date: '2027-03-04', text: 'Zahnarzt 14:30', categoryId: 'c1', repeatsYearly: false }],
  bars: [],
  categories: [{ id: 'c1', name: 'Familie', paletteRef: 'gruen', visible: true }],
  scratchpads: {},
  settings: null,
});

const twoMacs = () => createFleet({
  board: BOARD(), devices: ['A', 'B'], clock: simClock(Date.UTC(2026, 11, 10, 9, 0, 0)),
});

/** `b64u(payload) + '.' + b64u(sig)` — ADR 002 §2.3's spelling, signed by `key`. */
async function blobOf(payloadObject, key) {
  const payload = TE.encode(JSON.stringify(payloadObject));
  const sig = new Uint8Array(await S.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, payload));
  return `${b64u(payload)}.${b64u(sig)}`;
}

const CORPUS = 'Großmutter Käthe';

/** A brand-new Mac, with the shipped generator. `deviceShort` really is derived from `sigPubRaw`. */
async function mintDevice() {
  const { devSig, devKex } = await generateDeviceKeys();
  const sigPubRaw = b64u(await exportRawPublic(devSig.publicKey));
  const kexPubRaw = b64u(await exportRawPublic(devKex.publicKey));
  return {
    devSig,
    devKex,
    sigPubRaw,
    kexPubRaw,
    deviceShort: await deviceShortOfB64u(sigPubRaw),
    deviceId: `dev_${b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)))}`,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · INVERTED — R8-7. THE CLOSED FIELD SET IS ON EVERY DOOR
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The roster's published attestation payloads, decoded. E2E3-6 — `GET /members` carries them. */
async function publishedPayloads(f, dev) {
  const seen = await dev.run(() => dev.transport.request(
    'GET', `/api/v1/spaces/${f.spaceId}/members`, undefined, null, {}));
  assert.equal(seen.status, 200);
  const blobs = (seen.json.members || [])
    .flatMap((m) => m.devices || [])
    .map((d) => d.attestation)
    .filter((a) => typeof a === 'string');
  assert.ok(blobs.length > 0, 'the roster publishes the blob — E2E3-6, and this is the point');
  return {
    wire: JSON.stringify(seen.json),
    decoded: blobs.map((a) => new TextDecoder().decode(
      Uint8Array.from(atob(a.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))),
  };
}

describe('§1 · INVERTED · `POST /devices` cannot publish a family word through the relay', () => {
  test('an attestation with a seventh field is REFUSED, and the word never reaches the roster', async () => {
    const f = await twoMacs();
    const B = f.device('B');

    // A THIRD Mac, minted with the shipped key generator. Every field of the claim is honest —
    // P2 holds because the short really is derived from the signing key, and S1 holds because the
    // member's own recovery key signs it. Only the PAYLOAD gains a seventh field. That is the
    // whole point: nothing about keys can catch this, so nothing about keys is what does.
    const third = await mintDevice();
    const payload = {
      memberId: f.memberId,
      deviceId: third.deviceId,
      deviceShort: third.deviceShort,
      sigPubRaw: third.sigPubRaw,
      kexPubRaw: third.kexPubRaw,
      createdAt: '2026-08-29',
      note: CORPUS,
    };
    const blob = await blobOf(payload, f.recovery.recSig.privateKey);

    const res = await B.run(() => B.transport.request('POST', '/api/v1/devices', undefined, {
      spaceId: f.spaceId,
      memberId: f.memberId,
      deviceId: third.deviceId,
      deviceShort: third.deviceShort,
      sigPubRaw: third.sigPubRaw,
      kexPubRaw: third.kexPubRaw,
      attestation: blob,
    }));
    assert.equal(res.status, 400,
      `R8-7 REGRESSED: \`POST /devices\` admitted a seventh field — ${JSON.stringify(res.json)}. `
      + '`verifyDeviceClaim` must run `assertAttestationClosed` before S1.');
    assert.equal(res.json.reason, 'attestation_unknown_field',
      'the same reason `POST /spaces` gives — one rule, one answer, four doors');
    assert.equal(JSON.stringify(res.json).includes(CORPUS), false,
      'and the refusal does not echo the smuggled word back out');

    // Refused at the DOOR, so there is no row: the relay is not holding the word unread, it
    // never held it. Both halves matter — "stored but never served" stopped being a defence the
    // moment `GET /members` began publishing the column (E2E3-6).
    const { wire, decoded } = await publishedPayloads(f, B);
    assert.equal(decoded.some((d) => d.includes(CORPUS)), false,
      'the corpus word is not inside any published attestation');
    assert.equal(wire.includes(CORPUS), false, 'nor anywhere else in the roster response');
    assert.equal(wire.includes(b64u(TE.encode(JSON.stringify(payload))).slice(0, 24)), false,
      'and the bytes B uploaded are not in the store to be served back');
    assert.equal(decoded.length, 2, 'still the two honest Macs — the third was never created');
  });

  test('the closed set is a SET, not a hard six — the ADR 002 §2.3 optional field is admitted', async () => {
    // The other half of the decision recorded at `assertAttestationClosed`: closing the door is
    // versioning, not negotiation, and the version gate is the relay's allow-list. `recoveryPubKex`
    // is on it TODAY, before anything mints it, which is what lets E2E3-8's binding land as a
    // client-only change. A door that refused every seventh field would have made that impossible
    // and would have proved the "negotiation, not versioning" objection right.
    const f = await twoMacs();
    const B = f.device('B');
    const third = await mintDevice();
    const recKexPub = b64u(await exportRawPublic(f.recovery.recKex.publicKey));
    const blob = await blobOf({
      memberId: f.memberId,
      deviceId: third.deviceId,
      deviceShort: third.deviceShort,
      sigPubRaw: third.sigPubRaw,
      kexPubRaw: third.kexPubRaw,
      createdAt: '2026-08-29',
      recoveryPubKex: recKexPub,
    }, f.recovery.recSig.privateKey);

    const res = await B.run(() => B.transport.request('POST', '/api/v1/devices', undefined, {
      spaceId: f.spaceId,
      memberId: f.memberId,
      deviceId: third.deviceId,
      deviceShort: third.deviceShort,
      sigPubRaw: third.sigPubRaw,
      kexPubRaw: third.kexPubRaw,
      attestation: blob,
    }));
    assert.equal(res.status, 200, JSON.stringify(res.json));

    // …and it is SHAPE-checked, not trusted: 65 raw bytes of P-256 point, which is the one thing
    // the relay can say about a key it will never use. Anything else is a free-bit channel with
    // a respectable name on it.
    const fourth = await mintDevice();
    const chatty = await blobOf({
      memberId: f.memberId,
      deviceId: fourth.deviceId,
      deviceShort: fourth.deviceShort,
      sigPubRaw: fourth.sigPubRaw,
      kexPubRaw: fourth.kexPubRaw,
      createdAt: '2026-08-29',
      recoveryPubKex: b64u(TE.encode('Grossmutter Kaethe wohnt in Kiel')),
    }, f.recovery.recSig.privateKey);
    const bad = await B.run(() => B.transport.request('POST', '/api/v1/devices', undefined, {
      spaceId: f.spaceId,
      memberId: f.memberId,
      deviceId: fourth.deviceId,
      deviceShort: fourth.deviceShort,
      sigPubRaw: fourth.sigPubRaw,
      kexPubRaw: fourth.kexPubRaw,
      attestation: chatty,
    }));
    assert.equal(bad.status, 400, JSON.stringify(bad.json));
    assert.equal(bad.json.reason, 'attestation_recoveryPubKex');
  });

  test('`createdAt` is a DAY on this door too — the one required field no column pins', async () => {
    const f = await twoMacs();
    const B = f.device('B');
    const third = await mintDevice();
    const blob = await blobOf({
      memberId: f.memberId,
      deviceId: third.deviceId,
      deviceShort: third.deviceShort,
      sigPubRaw: third.sigPubRaw,
      kexPubRaw: third.kexPubRaw,
      createdAt: 'Zahnarzt 14:30',
    }, f.recovery.recSig.privateKey);
    const res = await B.run(() => B.transport.request('POST', '/api/v1/devices', undefined, {
      spaceId: f.spaceId,
      memberId: f.memberId,
      deviceId: third.deviceId,
      deviceShort: third.deviceShort,
      sigPubRaw: third.sigPubRaw,
      kexPubRaw: third.kexPubRaw,
      attestation: blob,
    }));
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.equal(res.json.reason, 'attestation_createdAt');
    assert.equal(JSON.stringify(res.json).includes('Zahnarzt'), false, 'and it is not echoed');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · FAILED — the two things a published sender was supposed to make possible
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The seam question was "can a sender be forged now that one is published?". No. The publication
// is of a blob whose signature chains to `Member.recoveryPubSig`, which the relay holds as a
// column and did not learn from this request, and P2 binds `deviceShort` to `sigPubRaw` by
// construction. Both halves are checked below, and both refuse.

describe('§2 · FAILED · the signature half of the door holds', () => {
  test('an attestation signed by the wrong key is refused — S1', async () => {
    const f = await twoMacs();
    const B = f.device('B');
    // Signed with the DEVICE key instead of the member's recovery signing key. Every field of the
    // payload is otherwise honest, so only S1 can catch it.
    const blob = await blobOf({
      memberId: f.memberId,
      deviceId: B.wire.deviceId,
      deviceShort: B.short,
      sigPubRaw: B.wire.sigPubRaw,
      kexPubRaw: B.wire.kexPubRaw,
      createdAt: '2026-08-29',
    }, B.keys.identity.devSig.privateKey);
    const res = await B.run(() => B.transport.request('POST', '/api/v1/devices', undefined, {
      spaceId: f.spaceId, memberId: f.memberId,
      deviceId: B.wire.deviceId, deviceShort: B.short,
      sigPubRaw: B.wire.sigPubRaw, kexPubRaw: B.wire.kexPubRaw,
      attestation: blob,
    }));
    assert.equal(res.status, 401, JSON.stringify(res.json));
    assert.equal(res.json.check, 'attestation_signature');
  });

  test('a device short that is not derived from its own signing key is refused — P2', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    // B claims A's short. P2 is checked BEFORE the signature and independently of it, so a member
    // cannot shadow a peer's short even by attesting to their own lie.
    const blob = await blobOf({
      memberId: f.memberId,
      deviceId: B.wire.deviceId,
      deviceShort: A.short,
      sigPubRaw: B.wire.sigPubRaw,
      kexPubRaw: B.wire.kexPubRaw,
      createdAt: '2026-08-29',
    }, f.recovery.recSig.privateKey);
    const res = await B.run(() => B.transport.request('POST', '/api/v1/devices', undefined, {
      spaceId: f.spaceId, memberId: f.memberId,
      deviceId: B.wire.deviceId, deviceShort: A.short,
      sigPubRaw: B.wire.sigPubRaw, kexPubRaw: B.wire.kexPubRaw,
      attestation: blob,
    }));
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.equal(res.json.reason, 'not_derived_from_sigPubRaw');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · CLOSED — R8-7b. THE OTHER THING THESE TWO DOORS ADMITTED THAT `readDevice` NEVER DID
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Found by ENUMERATING the four doors rather than by attacking one of them, which is the whole
// argument for `tests/server/blindness.test.js` §7a existing: `POST /devices` and
// `POST /devices/adopt` took `deviceId` through `requireId` — 128 characters of
// `[A-Za-z0-9_.:-]` — where `readDevice` has always pinned `dev_` + 22 b64url and states the
// reason in its own comment: *"`KeyWrap.recipientId` admits a device id OR the reserved
// `rec_<memberId>` … a device allowed to name itself `rec_mem_…` could therefore be handed the
// wraps addressed to another member's recovery key … the two namespaces cannot meet."*
//
// On these two doors they met, and the sharp end is not the reading. It is
// `POST /devices/revoke`, which calls `deleteKeyWrapsForDevices(spaceId, [deviceId])` — a store
// method that matches on `KeyWrap.recipientId`. **Register `rec_mem_MAMA` as a device, revoke
// it, and Mama's recovery wraps are deleted for every epoch**, which is ADR 002 §7.3's "the only
// path that survives losing every device". Two ordinary requests, one member, no forgery.
//
// Measured before the fix, on the shipped router: `POST /devices` with
// `deviceId: 'rec_mem_…'` → **200**, and with `deviceId:
// 'Grossmutter-Kaethe.wohnt:in-Kiel_seit_1998'` → **200**, served straight back by
// `GET /spaces/:id/members` (`Device.id` is on `DEVICE_PROJECTION`).

describe('§3 · CLOSED · a device id cannot name a key-wrap recipient, or anything else', () => {
  /** Register a second Mac of the fleet's own member under a chosen id. */
  async function attach(f, dev, deviceId, path) {
    const third = await mintDevice();
    const blob = await blobOf({
      memberId: f.memberId,
      deviceId,
      deviceShort: third.deviceShort,
      sigPubRaw: third.sigPubRaw,
      kexPubRaw: third.kexPubRaw,
      createdAt: '2026-08-29',
    }, f.recovery.recSig.privateKey);
    return dev.run(() => dev.transport.request('POST', path || '/api/v1/devices', undefined, {
      spaceId: f.spaceId,
      memberId: f.memberId,
      deviceId,
      deviceShort: third.deviceShort,
      sigPubRaw: third.sigPubRaw,
      kexPubRaw: third.kexPubRaw,
      attestation: blob,
    }));
  }

  test('`rec_<memberId>` is refused — the reserved recipient namespace stays reserved', async () => {
    const f = await twoMacs();
    const B = f.device('B');

    // The wraps this protects really are there, and they really are addressed to `rec_…`. Without
    // this the refusal below would be a rule about nothing.
    const before = await B.run(() => B.transport.request(
      'GET', `/api/v1/spaces/${f.spaceId}/keys`, undefined, null, {}));
    assert.equal(before.status, 200);
    const recipients = before.json.wraps.map((w) => w.recipientId);
    assert.ok(recipients.includes(`rec_${f.memberId}`),
      'the member recovery wrap exists — this is what a squatted device id would collect and, on '
      + 'revoke, delete');

    // A synthetic peer, so the shape of the CROSS-MEMBER attack is the shape under test and not
    // an accident of a one-member fleet.
    const victim = `mem_${b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)))}`;
    for (const squat of [`rec_${f.memberId}`, `rec_${victim}`]) {
      const res = await attach(f, B, squat);
      assert.equal(res.status, 400, `R8-7b REGRESSED for ${squat}: ${JSON.stringify(res.json)}`);
      assert.equal(res.json.field, 'deviceId');
    }

    // Nothing was written, so nothing can be revoked, so the wraps are untouched.
    const after = await B.run(() => B.transport.request(
      'GET', `/api/v1/spaces/${f.spaceId}/keys`, undefined, null, {}));
    assert.equal(after.status, 200);
    assert.deepEqual(after.json.wraps.map((w) => w.recipientId).sort(), recipients.sort());
  });

  test('a chatty device id is refused, on BOTH doors, and never reaches the roster', async () => {
    const f = await twoMacs();
    const B = f.device('B');
    const chatty = 'Grossmutter-Kaethe.wohnt:in-Kiel_seit_1998';
    for (const path of ['/api/v1/devices', '/api/v1/devices/adopt']) {
      const res = await attach(f, B, chatty, path);
      assert.equal(res.status, 400, `${path}: ${JSON.stringify(res.json)}`);
      assert.equal(res.json.field, 'deviceId');
      assert.equal(JSON.stringify(res.json).includes('Kiel'), false, 'and it is not echoed back');
    }
    const seen = await B.run(() => B.transport.request(
      'GET', `/api/v1/spaces/${f.spaceId}/members`, undefined, null, {}));
    assert.equal(seen.status, 200);
    assert.equal(JSON.stringify(seen.json).includes('Kiel'), false,
      '`Device.id` is on DEVICE_PROJECTION — a label a member chooses is a published label');
  });

  test('CONTROL — an honest `dev_` + 22 id still registers, on both doors', async () => {
    // The refusal above must not be satisfiable by a door that refuses every id. This is the row
    // that would go red if it were.
    for (const path of ['/api/v1/devices', '/api/v1/devices/adopt']) {
      const f = await twoMacs();
      const B = f.device('B');
      const id = `dev_${b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)))}`;
      const res = await attach(f, B, id, path);
      assert.equal(res.status, 200, `${path}: ${JSON.stringify(res.json)}`);
      assert.equal(res.json.deviceId, id);
    }
  });
});
