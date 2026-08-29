// ATTACK · ROUND 10 — THE THIRD DOOR, WITH THE CLOSED SET ON IT.
// ADR 002 §0 (T1, T5), §2.3 · ADR 003 §6.1 · story 21.1 · `server/core/handlers/devices.js`.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT ROUND 9 CLOSED, AND THE QUESTION THAT SURVIVES IT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// R8-7 was a free-text channel through a relay whose whole promise is that it holds none: a member
// signed a seventh field into her own device attestation, two of the four doors stored the blob
// verbatim, and `GET /spaces/:id/members` served the word back to the family. Round 9 closed it
// properly — one `assertAttestationClosed`, imported by every door, plus an enumeration row that
// reddens if a fifth door ever appears. `round8-seam.test.js` §1 is inverted and green.
//
// `assertAttestationClosed`'s own docblock states the claim the fix is supposed to make true:
//
//   > Six required names, one optional, and nothing else — so every field of a blob the relay
//   > publishes is a value it already holds in a column … or a DAY, which is strictly coarser
//   > than the `Device.addedAt` millisecond the relay cannot avoid keeping. **Zero free bits.**
//
// The check runs on `Object.keys(att)` — the PARSED payload. What the relay stores and republishes
// is `body.attestation`, THE STRING, byte for byte, because the signature is over those bytes and
// re-serialising them would break it. So the closed set closes the NAMES and leaves the SPELLING
// wide open, and JSON has a great deal of spelling.
//
// §1 measures the capacity of that channel, end to end, through `POST /devices` and back out of
// `GET /spaces/:id/members`. §2 measures the one required field the checker calls a DAY. §3 turns
// to a different property of the same door — the global `deviceShort` namespace — which E6 needs
// because E6 is the epic where a person belongs to more than one circle.
//
// HOUSE RULES. Every row is labelled SUCCEEDED or FAILED from the attacker's side; a SUCCEEDED row
// asserts the defect and must be INVERTED when it is closed, never deleted.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createFleet, createRelay, simClock } from '../helpers/fleet.js';
import { b64u } from '../../src/js/core/b64.js';
import { generateDeviceKeys, exportRawPublic, deviceShortOfB64u } from '../../src/js/crypto/identity.js';

const TE = new TextEncoder();
const TD = new TextDecoder();
const S = globalThis.crypto.subtle;

const BOARD = () => ({
  schemaVersion: 1,
  notes: [],
  bars: [],
  categories: [{ id: 'c1', name: 'Familie', paletteRef: 'gruen', visible: true }],
  scratchpads: {},
  settings: null,
});
const twoMacs = (over = {}) => createFleet({
  board: BOARD(), devices: ['A', 'B'], clock: simClock(Date.UTC(2026, 11, 10, 9, 0, 0)), ...over,
});

/**
 * `b64u(payload) + '.' + b64u(sig)` over ARBITRARY payload TEXT.
 *
 * Hand-rolled over the text and not over an object, for the same reason `blindness.test.js` §7a
 * hand-rolls its own: `attestDevice` can only mint one canonical spelling, and a test that cannot
 * express a second spelling cannot find a channel that lives in the spelling.
 */
async function blobOfText(text, key) {
  const payload = TE.encode(text);
  const sig = new Uint8Array(await S.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, payload));
  return `${b64u(payload)}.${b64u(sig)}`;
}

/** The payload half of a blob, as the bytes the relay is holding. */
const payloadOf = (blob) => TD.decode(Uint8Array.from(
  atob(blob.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

/** A brand-new Mac, minted with the shipped generator, so P2 holds by construction. */
async function mintDevice() {
  const { devSig, devKex } = await generateDeviceKeys();
  const sigPubRaw = b64u(await exportRawPublic(devSig.publicKey));
  const kexPubRaw = b64u(await exportRawPublic(devKex.publicKey));
  return {
    sigPubRaw,
    kexPubRaw,
    deviceShort: await deviceShortOfB64u(sigPubRaw),
    deviceId: `dev_${b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)))}`,
  };
}

/** Every attestation blob the roster publishes to every member of the space (E2E3-6). */
async function roster(f, dev) {
  const seen = await dev.run(() => dev.transport.request(
    'GET', `/api/v1/spaces/${f.spaceId}/members`, undefined, null, {}));
  assert.equal(seen.status, 200, JSON.stringify(seen.json));
  return {
    wire: JSON.stringify(seen.json),
    blobs: (seen.json.members || []).flatMap((m) => m.devices || [])
      .map((d) => d.attestation).filter((a) => typeof a === 'string'),
  };
}

// ── the covert channel, as a codec, so the row proves RECOVERY and not just acceptance ────────
const bitsOf = (s) => [...TE.encode(s)].flatMap((b) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (b >> i) & 1));
const textOfBits = (bits) => {
  const bytes = [];
  for (let i = 0; i + 7 < bits.length; i += 8) bytes.push(bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0));
  return TD.decode(Uint8Array.from(bytes));
};
/** Insignificant JSON whitespace: one space per 0, one tab per 1. */
const carry = (bits) => bits.map((b) => (b ? '\t' : ' ')).join('');
const readBack = (text) => textOfBits([...text].filter((c) => c === ' ' || c === '\t').map((c) => (c === '\t' ? 1 : 0)));

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · R10-5 · SUCCEEDED — THE CLOSED SET CLOSES THE NAMES AND LEAVES THE SPELLING OPEN
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · R10-5 · SUCCEEDED · a device attestation still carries ~2.7 kB of free bits', () => {
  const SECRET = 'Großmutter Käthe wohnt in Kiel';

  test('§1a · a word smuggled in the whitespace is stored, republished, and read back out', async () => {
    const f = await twoMacs();
    const B = f.device('B');
    const third = await mintDevice();

    // EVERY FIELD IS HONEST. The six names are the six names, in the ADR's own order, each with
    // exactly the value S2 will compare it against. Nothing about keys, signatures, `deviceShort`
    // derivation or field membership is being attacked — the payload is byte-different from the
    // canonical one and semantically identical to it.
    const six = [
      ['memberId', f.memberId],
      ['deviceId', third.deviceId],
      ['deviceShort', third.deviceShort],
      ['sigPubRaw', third.sigPubRaw],
      ['kexPubRaw', third.kexPubRaw],
      ['createdAt', '2026-08-29'],
    ];
    const bits = bitsOf(SECRET);
    const per = Math.ceil(bits.length / six.length);
    let text = '{';
    let at = 0;
    six.forEach(([k, v], i) => {
      if (i) text += ',';
      text += `"${k}":${carry(bits.slice(at, at + per))}${JSON.stringify(v)}`;
      at += per;
    });
    text += '}';
    assert.equal(at >= bits.length, true, 'every bit of the message has a slot');

    const blob = await blobOfText(text, f.recovery.recSig.privateKey);
    const res = await B.run(() => B.transport.request('POST', '/api/v1/devices', undefined, {
      spaceId: f.spaceId,
      memberId: f.memberId,
      deviceId: third.deviceId,
      deviceShort: third.deviceShort,
      sigPubRaw: third.sigPubRaw,
      kexPubRaw: third.kexPubRaw,
      attestation: blob,
    }));
    assert.equal(res.status, 200,
      `THE ROW, first half: the door ACCEPTS it — ${JSON.stringify(res.json)}. `
      + '`assertAttestationClosed` walks `Object.keys(att)` on the PARSED payload, so it sees six '
      + 'known names and nothing else. Every byte between those names is invisible to it.');

    const { blobs, wire } = await roster(f, B);
    const mine = blobs.find((a) => a === blob);
    assert.notEqual(mine, undefined,
      'THE ROW, second half: the relay stores the blob VERBATIM — it must, the signature is over '
      + 'those exact bytes — and `GET /spaces/:id/members` republishes it to every member of the '
      + 'space (E2E3-6). The channel is not "stored but never served".');
    assert.equal(readBack(payloadOf(mine)), SECRET,
      `and the message comes back out whole: "${SECRET}". Inverts when the door requires a `
      + 'CANONICAL spelling of the payload — the simplest form being to re-serialise the parsed '
      + 'object with a fixed key order and compare it byte-for-byte against what was signed, '
      + 'which costs one line and makes "zero free bits" true instead of aspirational.');

    assert.equal(wire.includes('Käthe'), false,
      'and `blindness.test.js` §3\'s corpus search cannot see it: the word is not IN the store as '
      + 'a word. That is the difference between this and R8-7, and it is the reason a fix that '
      + 'only greps for plaintext does not close it.');
  });

  test('§1b · the capacity, measured rather than asserted — about 2.7 kB per device', async () => {
    const f = await twoMacs();
    const B = f.device('B');
    const third = await mintDevice();
    const six = {
      memberId: f.memberId,
      deviceId: third.deviceId,
      deviceShort: third.deviceShort,
      sigPubRaw: third.sigPubRaw,
      kexPubRaw: third.kexPubRaw,
      createdAt: '2026-08-29',
    };
    const honest = JSON.stringify(six);
    // `MAX_ATTESTATION_CHARS` is 4096 and it bounds the BLOB, which is
    // b64u(payload) + '.' + b64u(64-byte sig). Fill the payload to just inside that.
    const sigChars = b64u(new Uint8Array(64)).length;
    const budget = Math.floor((4096 - sigChars - 1) * 3 / 4) - honest.length - 8;
    assert.ok(budget > 2000, `only ${budget} spare bytes — the point would not be worth making`);

    const text = `{${' '.repeat(budget)}${honest.slice(1)}`;
    const blob = await blobOfText(text, f.recovery.recSig.privateKey);
    assert.ok(blob.length <= 4096, `the blob is ${blob.length} chars, inside the cap`);
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
    const { blobs } = await roster(f, B);
    assert.equal(blobs.includes(blob), true,
      `THE ROW: ${budget} bytes of payload the relay stores, publishes to the whole family, and `
      + 'has no account of. Story 21.1\'s claim is that the relay holds no free bits; the honest '
      + 'number today is roughly 2.7 kB per device row, and a family of eight with two Macs each '
      + 'is 43 kB of channel through a store whose Datenschutz copy says it holds ciphertext and '
      + 'coordination data. Inverts when a canonical spelling is required and the spare capacity '
      + 'is zero.');
  });

  test('§1c · FAILED — an unknown NAME is still refused, on this door, exactly as round 9 left it', async () => {
    // The control. Without it §1a and §1b could be read as "the door is open", which is false and
    // would be an unfair summary of round 9's work: the field-name half is genuinely closed.
    const f = await twoMacs();
    const B = f.device('B');
    const third = await mintDevice();
    const blob = await blobOfText(JSON.stringify({
      memberId: f.memberId,
      deviceId: third.deviceId,
      deviceShort: third.deviceShort,
      sigPubRaw: third.sigPubRaw,
      kexPubRaw: third.kexPubRaw,
      createdAt: '2026-08-29',
      note: 'Großmutter Käthe',
    }), f.recovery.recSig.privateKey);
    const res = await B.run(() => B.transport.request('POST', '/api/v1/devices', undefined, {
      spaceId: f.spaceId,
      memberId: f.memberId,
      deviceId: third.deviceId,
      deviceShort: third.deviceShort,
      sigPubRaw: third.sigPubRaw,
      kexPubRaw: third.kexPubRaw,
      attestation: blob,
    }));
    assert.equal(res.status, 400, 'R8-7 stays closed');
    assert.equal(res.json.reason, 'attestation_unknown_field');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · R10-6 · SUCCEEDED — `createdAt` IS NOT A DAY, IT IS EIGHT FREE DIGITS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `assertAttestationClosed` singles this field out: *"`createdAt` is the only required field not
// pinned to a column by S2, so it is the only one that could carry anything. ADR 002 §2.3 types it
// 'YYYY-MM-DD'."* The check is `/^\d{4}-\d{2}-\d{2}$/`, which is a shape and not a date, and the
// justification for admitting the field at all is that a DAY is "strictly coarser than the
// `Device.addedAt` millisecond the relay cannot avoid keeping". That justification does not hold
// for a value that is not a day.

describe('§2 · R10-6 · SUCCEEDED · the one required field with no column behind it', () => {
  test('`9999-99-99` is stored and republished as a device\'s creation day', async () => {
    const f = await twoMacs();
    const B = f.device('B');
    const third = await mintDevice();
    const blob = await blobOfText(JSON.stringify({
      memberId: f.memberId,
      deviceId: third.deviceId,
      deviceShort: third.deviceShort,
      sigPubRaw: third.sigPubRaw,
      kexPubRaw: third.kexPubRaw,
      createdAt: '9999-99-99',
    }), f.recovery.recSig.privateKey);
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
    const { blobs } = await roster(f, B);
    const mine = blobs.find((a) => a === blob);
    assert.equal(JSON.parse(payloadOf(mine)).createdAt, '9999-99-99',
      'THE ROW: `/^\\d{4}-\\d{2}-\\d{2}$/` is a SHAPE. Every digit string of that shape is '
      + 'accepted, so the field carries about 26.6 bits — 8 decimal digits — that the relay holds, '
      + 'publishes to the family, and describes to itself as a day. Small next to §1 and worth '
      + 'having separately because it survives any fix to the SPELLING: a canonical re-serialiser '
      + 'would still pass this through. Inverts when the value must parse to a real calendar date '
      + 'and, ideally, must not be in the future of `Device.addedAt`.');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · R10-7 · INVERTED (was SUCCEEDED) — THE NAMESPACE IS THE SPACE, AND THE SQUAT IS LOCAL
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// ⚠ CLOSED by round 10 item 8, on this row's own terms — it named its inversion condition and
// the first half of it was taken: `Device.deviceShort` is `@@unique([spaceId, deviceShort])`
// rather than globally `@unique`, and `getDeviceByShort` takes a space. The squat below is still
// ACCEPTED in the squatter's own circle (nothing at that door proves possession, and this row's
// reading of `verifyDeviceClaim` was exactly right); what has changed is that it no longer
// reaches out of that circle. The victim's honest registration elsewhere now succeeds.
//
// The RESIDUAL this leaves is recorded as R10-8a in ADR 003 §5.1: she can still pre-empt a KNOWN
// Mac's short inside HER OWN circle and keep that machine out of it. Closing that is this row's
// other named condition — "registration requires a signature by the device key being registered"
// — which on `POST /devices` is a wire change, because that door is deliberately unauthenticated.
//
// The description below is kept verbatim as the record of what was true before the fix.
//
// `attachDevice` guards the collision that matters and does it well:
//
//   > `deviceShort` is a function of the signing key, so a second registration under the same
//   > short is either the SAME device retrying … or a second member trying to claim a key that
//   > already belongs to someone. The latter is refused.
//
// `getDeviceByShort` is GLOBAL — one index over every device row in the relay, not one per space —
// and `verifyDeviceClaim` binds nothing to who owns the private key. `sigPubRaw` is published to
// every co-member by `GET /spaces/:id/members`. So a member of ONE circle can mint a device row in
// a circle of her own bearing a co-member's public key, and the global index then refuses that
// Mac everywhere else, for ever.
//
// ADR 002 §2.3's round-4 amendment already knows the squat exists ("`sigPubRaw` is public and the
// squat copies key and short together") and closes it AT FOLD TIME, with a possession proof: *"a
// `dev.<S>` register is a credential only if the op that wrote it was stamped by the device it
// attests."* That protects the LOG. It says nothing about the relay's registration namespace,
// which is a different resource with a different failure — not a forged credential, a denied join.
// E6 is create/invite/JOIN with 2–8 members, so this is a first-class E6 surface rather than a
// curiosity.

describe('§3 · R10-7 · INVERTED · the squat is now local to the squatter\'s own circle', () => {
  test('the squat is still accepted here, and the honest registration elsewhere now SUCCEEDS', async () => {
    // ONE RELAY, TWO SPACES — the point is a namespace shared across circles, so both must exist.
    const clock = simClock(Date.UTC(2026, 11, 10, 9, 0, 0));
    const relay = createRelay({ clock });
    const hers = await createFleet({ board: BOARD(), devices: ['A', 'B'], clock, relay, tag: 'hers' });
    const his = await createFleet({ board: BOARD(), devices: ['C', 'D'], clock, relay, tag: 'his' });
    assert.notEqual(hers.spaceId, his.spaceId, 'two circles on one relay');
    assert.notEqual(hers.memberId, his.memberId, 'and two different people');

    // The victim's next Mac. Not yet registered anywhere; its public key is the only thing the
    // attacker needs, and in a shared circle the roster hands her one for every device he owns.
    const victimMac = await mintDevice();

    const squat = await blobOfText(JSON.stringify({
      memberId: hers.memberId,
      deviceId: `dev_${b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)))}`,
      deviceShort: victimMac.deviceShort,
      sigPubRaw: victimMac.sigPubRaw,
      kexPubRaw: victimMac.kexPubRaw,
      createdAt: '2026-08-29',
    }), hers.recovery.recSig.privateKey);
    const squatId = JSON.parse(payloadOf(squat)).deviceId;

    const taken = await hers.device('B').run(() => hers.device('B').transport.request(
      'POST', '/api/v1/devices', undefined, {
        spaceId: hers.spaceId,
        memberId: hers.memberId,
        deviceId: squatId,
        deviceShort: victimMac.deviceShort,
        sigPubRaw: victimMac.sigPubRaw,
        kexPubRaw: victimMac.kexPubRaw,
        attestation: squat,
      }));
    assert.equal(taken.status, 200,
      `THE ROW, first half: the squat is ACCEPTED — ${JSON.stringify(taken.json)}. P2 holds `
      + '(the short really is derived from that signing key), S1 holds (she signed with her own '
      + 'recovery key), S2 holds (the row is the row she signed) and the closed set holds. Nothing '
      + 'anywhere asks whether she can PROVE POSSESSION of the private half, and that is the only '
      + 'question that separates her from him.');

    // The victim now tries to add that same Mac to his own circle, entirely honestly.
    const honest = await blobOfText(JSON.stringify({
      memberId: his.memberId,
      deviceId: victimMac.deviceId,
      deviceShort: victimMac.deviceShort,
      sigPubRaw: victimMac.sigPubRaw,
      kexPubRaw: victimMac.kexPubRaw,
      createdAt: '2026-08-29',
    }), his.recovery.recSig.privateKey);
    const denied = await his.device('D').run(() => his.device('D').transport.request(
      'POST', '/api/v1/devices', undefined, {
        spaceId: his.spaceId,
        memberId: his.memberId,
        deviceId: victimMac.deviceId,
        deviceShort: victimMac.deviceShort,
        sigPubRaw: victimMac.sigPubRaw,
        kexPubRaw: victimMac.kexPubRaw,
        attestation: honest,
      }));
    assert.equal(denied.status, 200,
      `THE ROW, INVERTED: the legitimate owner of the key is admitted to his own circle — `
      + `${JSON.stringify(denied.json)}. It used to be 400 { taken: 'deviceShort' }: one global `
      + 'index, first writer wins, and the lockout was PERMANENT, because `deviceShort` is '
      + '`crock32(SHA-256(sigPubRaw))` and escaping it meant destroying a non-extractable device '
      + 'key — a new identity and, for ADR 002 §2.3\'s purposes, a different Mac. Round 10 item 8 '
      + 'took the first of this row\'s two named conditions: the index is scoped per space.');
    assert.equal(denied.json.deviceShort, victimMac.deviceShort);

    // Both rows exist, and they are two memberships of one machine rather than one contested
    // slot. Hers is inert (§3b); his is his.
    const all = await relay.store.listDevicesByShort(victimMac.deviceShort);
    assert.deepEqual(all.map((d) => d.spaceId).sort(), [hers.spaceId, his.spaceId].sort());
  });

  test('§3b · FAILED — the squatter still cannot read, push or be believed in the victim\'s circle', async () => {
    // The bound on §3a, and it matters for the ranking: this is a DENIAL, not an impersonation.
    // The device row she planted lives in her own space, `deleteOpsByDevices` is scoped by
    // `spaceId`, and auth needs the private key she does not have.
    const clock = simClock(Date.UTC(2026, 11, 10, 9, 0, 0));
    const relay = createRelay({ clock });
    const hers = await createFleet({ board: BOARD(), devices: ['A', 'B'], clock, relay, tag: 'h2' });
    const his = await createFleet({ board: BOARD(), devices: ['C', 'D'], clock, relay, tag: 'i2' });
    const victimMac = await mintDevice();
    const squat = await blobOfText(JSON.stringify({
      memberId: hers.memberId,
      deviceId: `dev_${b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)))}`,
      deviceShort: victimMac.deviceShort,
      sigPubRaw: victimMac.sigPubRaw,
      kexPubRaw: victimMac.kexPubRaw,
      createdAt: '2026-08-29',
    }), hers.recovery.recSig.privateKey);
    await hers.device('B').run(() => hers.device('B').transport.request(
      'POST', '/api/v1/devices', undefined, {
        spaceId: hers.spaceId,
        memberId: hers.memberId,
        deviceId: JSON.parse(payloadOf(squat)).deviceId,
        deviceShort: victimMac.deviceShort,
        sigPubRaw: victimMac.sigPubRaw,
        kexPubRaw: victimMac.kexPubRaw,
        attestation: squat,
      }));

    const rows = await relay.store.listDevices(his.spaceId);
    assert.equal(rows.some((d) => d.deviceShort === victimMac.deviceShort), false,
      'the planted row is in HER space and not in his: `listDevices` is scoped, so it is not on '
      + 'his roster, cannot be wrapped to, and a removal in her circle purges only her circle');
    await his.settle();
    assert.equal(his.device('C').realQuarantine().length, 0, 'and his circle is untouched');
  });
});
