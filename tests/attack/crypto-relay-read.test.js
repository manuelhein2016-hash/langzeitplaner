// ATTACK · T1 — the curious or compromised relay tries to READ.
//
// ADR 002 §0 T1: "every envelope, every header, every IP, arrival times" → must NOT get "any note
// text, bar label, scratchpad, category name, member display name, Belegt content".
//
// This file attacks the CONTENT channel and then every METADATA channel the design leaves beside
// it: ciphertext LENGTH (§5.3's padding), op frequency, arrival timing, the plaintext header
// fields, the size of a wrap, and the number of epochs.
//
// Each test is named SUCCEEDED or FAILED from the ADVERSARY's point of view, and asserts the
// concrete outcome either way. A test named SUCCEEDED is a characterization of a real capability
// the relay has today — it is green because the capability is real, and it turns red the day the
// capability is closed, which is the only way a defence can be noticed when it lands.

import test from 'node:test';
import assert from 'node:assert/strict';

import { b64u, ub64 } from '../../src/js/core/b64.js';
import { canonicalBytes, canonicalJSON } from '../../src/js/core/canon.js';
import { spaceId as mkSpaceId } from '../../src/js/core/ids.js';
import { PAD_BUCKET, AEAD } from '../../src/js/crypto/suite.js';
import {
  sealOp, openOp, paddedLength, pad, unpad, ENVELOPE_FIELDS, AAD_FIELDS,
} from '../../src/js/crypto/envelope.js';
import {
  wrapSpaceKey, wrapRingToRecipients, familyRecipients, createKeyRing,
} from '../../src/js/crypto/spacekeys.js';
import {
  makeDevice, tableOf, memberRecord, spaceKey, ring, makeOp, pubOp, hdrFor,
  outcome, personalSpace, familySpace, importKex, forge, S,
} from './_crypto-relay-kit.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. The content channel itself
// ─────────────────────────────────────────────────────────────────────────────

test('FAILED — T1 holds the envelope and no key: there is no content in any of the nine wire fields', async () => {
  const dev = await makeDevice();
  const sp = personalSpace();
  const key = await spaceKey();
  const r = ring([[sp, 3, key]]);

  const op = makeOp(dev, sp, { f: { date: '2026-09-10', text: 'Scheidungsanwalt Dr. Weber' } });
  const env = await sealOp(op, r, dev.sigPriv, hdrFor(op, dev.dv, 3, ''));

  // Exactly nine fields, and the relay sees all nine.
  assert.deepEqual(Object.keys(env).sort(), [...ENVELOPE_FIELDS].sort());

  // Nothing the user typed appears anywhere in the stored row — not in a field, not in the JSON.
  const onTheWire = JSON.stringify(env);
  for (const secret of ['Scheidungsanwalt', 'Weber', '2026-09-10', op.e, op.act, op.dev, op.ts]) {
    assert.equal(onTheWire.includes(secret), false, `${secret} leaked into the wire row`);
  }
  // op.id DOES appear — it is `oid`, deliberately (§5.1: the outer idempotency key IS the op id).
  assert.equal(env.oid, op.id);
});

test('FAILED — T1 holding no key at all: openOp parks rather than leaking a decrypt oracle', async () => {
  const dev = await makeDevice();
  const sp = personalSpace();
  const key = await spaceKey();
  const op = makeOp(dev, sp);
  const env = await sealOp(op, ring([[sp, 3, key]]), dev.sigPriv, hdrFor(op, dev.dv, 3, ''));

  // The relay's own client, with an empty ring: a park, never a partial read.
  assert.equal(await outcome(() => openOp(env, ring([]), tableOf(dev))), 'park:epoch');

  // The relay's own client, with a key of its own choosing: one indistinguishable AEAD refusal.
  const wrong = await spaceKey();
  assert.equal(await outcome(() => openOp(env, ring([[sp, 3, wrong]]), tableOf(dev))), 'aead');
});

test('FAILED — a family key never opens a personal envelope, even relabelled (barriers 1 and 3)', async () => {
  const dev = await makeDevice();
  const psp = personalSpace();
  const fsp = familySpace();
  const psk = await spaceKey();
  const fsk = await spaceKey();

  const op = makeOp(dev, psp, { f: { date: '2026-09-10', text: 'Therapie' } });
  const env = await sealOp(op, ring([[psp, 3, psk]]), dev.sigPriv, hdrFor(op, dev.dv, 3, ''));

  // Relabelling `sp` breaks the SIGNATURE first — the AAD is what was signed (§5.1).
  const relabelled = { ...env, sp: fsp };
  assert.equal(await outcome(() => openOp(relabelled, ring([[fsp, 3, fsk]]), tableOf(dev))), 'P3');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The LENGTH channel — §5.3's padding, checked at every bucket edge
// ─────────────────────────────────────────────────────────────────────────────

test('FAILED — the padding is a true step function and the bucket edges are exactly where §5.3 says', () => {
  assert.equal(PAD_BUCKET, 256);

  // The CEILING reading (§5.3's resolved ambiguity): a payload whose prefixed length is already a
  // multiple of 256 stays in that bucket rather than being pushed into one of its own.
  assert.equal(paddedLength(254), 256);  // varint(254) is 2 bytes -> 256 exactly
  assert.equal(paddedLength(255), 512);
  assert.equal(paddedLength(510), 512);  // 2 + 510 = 512 exactly
  assert.equal(paddedLength(511), 768);
  assert.equal(paddedLength(766), 768);
  assert.equal(paddedLength(767), 1024);

  // Every value in a bucket is genuinely one length on the wire — no residue survives.
  const lengths = new Set();
  for (let n = 255; n <= 510; n++) lengths.add(paddedLength(n));
  assert.deepEqual([...lengths], [512]);

  // And the varint is not a second spelling of the length: the boundary moves by exactly one byte
  // at 254/255 because varint(254) and varint(255) are 2 bytes but 254+2 = 256 and 255+2 = 257.
  assert.equal(paddedLength(1) % PAD_BUCKET, 0);
});

test('SUCCEEDED (partial) — 16.7 holds for short texts and BREAKS at 140 bytes of pub.text', async () => {
  const dev = await makeDevice();
  const fsp = familySpace();
  const fsk = await spaceKey();
  const r = ring([[fsp, 4, fsk]]);

  // These are FORGED, not sealed: `sealOp` refuses every family `pub.set` today (WP-10 has not
  // landed), so the only way to measure the real wire length of a Belegt op is to build the exact
  // plaintext §5.3 pads and encrypt it. The measurement is of the padding, not of `sealOp`.
  const belegt = { 'pub.level': 'belegt', 'pub.from': '2026-09-10', 'pub.to': '2026-09-10' };
  const geteilt = (text) => ({ ...belegt, 'pub.level': 'geteilt', 'pub.text': text });

  const lenOf = (f) => {
    const bytes = canonicalBytes(pubOp(dev, fsp, f));
    return { payload: bytes.length, padded: paddedLength(bytes.length), ct: paddedLength(bytes.length) + AEAD.tagLength / 8 };
  };

  const b = lenOf(belegt);
  // A REAL op is already 356 bytes before any user text. §5.3's claim that "ops of 1–256 plaintext
  // bytes — the overwhelming majority — are indistinguishable" describes a bucket THIS PRODUCT
  // NEVER USES: no op reaches the wire in bucket 1.
  assert.ok(b.payload > PAD_BUCKET, `a bare Belegt op is ${b.payload} bytes — already past bucket 1`);
  assert.equal(b.padded, 512);
  assert.equal(b.ct, 528);

  // 16.7's promise holds where it matters most: a short shared note is byte-identical in length.
  for (const n of [1, 5, 20, 54, 80, 100, 130]) {
    assert.equal(lenOf(geteilt('x'.repeat(n))).ct, b.ct, `${n} chars should be indistinguishable`);
  }

  // …and it stops holding here. 140 ASCII characters — one ordinary German appointment note —
  // pushes the op into bucket 3, and NO Belegt op can ever reach bucket 3.
  assert.equal(lenOf(geteilt('x'.repeat(139))).ct, 528);
  assert.equal(lenOf(geteilt('x'.repeat(140))).ct, 784);

  // Umlauts halve the headroom: UTF-8 makes each 2 bytes, so 80 German characters already cross.
  assert.equal(lenOf(geteilt('ü'.repeat(80))).ct, 784);

  // The consequence, stated as the relay would state it: ct === 784 in a family space is a
  // ONE-SIDED PROOF of Geteilt. The relay learns "she shared the details", which is precisely the
  // inference 16.7 promises not to enable.
  const boundary = new Set([b.ct, lenOf(geteilt('ü'.repeat(80))).ct]);
  assert.equal(boundary.size, 2, 'if this becomes 1 the padding was widened and the finding closed');

  // And the ciphertexts really are those lengths on the wire, not just in the arithmetic.
  const long = pubOp(dev, fsp, geteilt('ü'.repeat(80)));
  const short = pubOp(dev, fsp, belegt);
  assert.equal(ub64((await forge(long, hdrFor(long, dev.dv, 4, ''), fsk, dev.sigPriv)).ct).length, 784);
  assert.equal(ub64((await forge(short, hdrFor(short, dev.dv, 4, ''), fsk, dev.sigPriv)).ct).length, 528);
  assert.equal(r.get(fsp, 4), fsk);
});

test('SUCCEEDED — the length bucket separates op KINDS, so T1 reads the shape of the traffic', async () => {
  const dev = await makeDevice();
  const fsp = familySpace();

  const bucketOf = (op) => paddedLength(canonicalBytes(op).length);

  const smallPub = bucketOf(pubOp(dev, fsp, { 'pub.level': 'belegt', 'pub.from': '2026-09-10', 'pub.to': '2026-09-10' }));
  // A `member.set` carrying a device attestation blob is ~600 b64 characters of register value.
  const attRegister = makeOp(dev, fsp, {
    k: 'member.set', e: `member:${dev.memberId}`,
    f: { [`dev.${dev.dv}`]: dev.blob },
  });
  const registerBucket = bucketOf(attRegister);

  assert.notEqual(smallPub, registerBucket,
    'if these ever coincide the kind channel narrowed — good news, update this row');
  // The relay therefore reads "a device was attested" vs "an entry changed" off the ct column
  // alone, with no key. §8.7 concedes membership churn via `ep`; it does not concede this.
  assert.ok(registerBucket > smallPub);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The HEADER channels — six plaintext fields, and two of them are author-chosen
// ─────────────────────────────────────────────────────────────────────────────

test('SUCCEEDED — `wit` is up to 86 characters of AUTHOR-CHOSEN PLAINTEXT that nothing ever checks', async () => {
  const dev = await makeDevice();
  const sp = personalSpace();
  const key = await spaceKey();
  const r = ring([[sp, 3, key]]);

  // The exfiltration. A modified or coerced client puts the plaintext it is not allowed to publish
  // into `wit`, which travels in the clear and is authenticated — so the relay reads it and every
  // honest peer accepts the envelope without a murmur.
  const secret = 'Zahnarzt-Dr-Mueller-1430';
  const smuggled = Buffer.from(secret, 'utf8').toString('base64url');
  assert.ok(smuggled.length <= 86);

  const op = makeOp(dev, sp);
  const env = await sealOp(op, r, dev.sigPriv, hdrFor(op, dev.dv, 3, smuggled));

  // T1's read, with no key and no work:
  assert.equal(Buffer.from(env.wit, 'base64url').toString('utf8'), secret);

  // Every honest client accepts it. `wit` is diagnostic-only (§5.4) and `openOp` never compares it
  // to anything, so there is no check to fail.
  assert.equal(await outcome(() => openOp(env, r, tableOf(dev))), 'OPENED');

  // 64 bytes per op, in the clear. The asymmetry worth naming: `unpad` closes a 255-byte-per-op
  // channel inside the CIPHERTEXT with an explicit zero-check and a paragraph of reasoning —
  // "the pad is not a place to carry data" — while this one sits in the header, wider in reach.
  assert.equal(unpadRejectsData(), 'padding');
  function unpadRejectsData() {
    const p = pad(new Uint8Array([1, 2, 3]));
    p[p.length - 1] = 0x41;
    try { unpad(p); } catch (e) { return e.check; }
    return 'NOTHING WAS THROWN';
  }
});

test('SUCCEEDED — `iv` is 12 more bytes of author-chosen plaintext, and sealOp will reuse one', async () => {
  const dev = await makeDevice();
  const sp = personalSpace();
  const key = await spaceKey();
  const r = ring([[sp, 3, key]]);

  const chosen = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const opA = makeOp(dev, sp, { f: { date: '2026-09-10', text: 'AAAAAAAA' } });
  const opB = makeOp(dev, sp, { f: { date: '2026-09-10', text: 'BBBBBBBB' } });

  const a = await sealOp(opA, r, dev.sigPriv, hdrFor(opA, dev.dv, 3, ''), { random: () => chosen.slice() });
  const b = await sealOp(opB, r, dev.sigPriv, hdrFor(opB, dev.dv, 3, ''), { random: () => chosen.slice() });

  // `sealOp` checks the IV's LENGTH and nothing else. Two ops, one key, one nonce.
  assert.equal(a.iv, b.iv);
  assert.equal(await outcome(() => openOp(a, r, tableOf(dev))), 'OPENED');
  assert.equal(await outcome(() => openOp(b, r, tableOf(dev))), 'OPENED');

  // GCM under a repeated nonce is a stream cipher used twice: ct_a XOR ct_b === pt_a XOR pt_b, and
  // T1 recovers one plaintext from the other with no key at all.
  const ca = ub64(a.ct);
  const cb = ub64(b.ct);
  const pa = pad(canonicalBytes(opA));
  const recovered = new Uint8Array(pa.length);
  for (let i = 0; i < pa.length; i++) recovered[i] = ca[i] ^ cb[i] ^ pa[i];
  assert.deepEqual(recovered, pad(canonicalBytes(opB)),
    'a repeated IV hands T1 the second plaintext in full');

  // No barrier anywhere refuses this: neither the ring, nor `sealOp`, nor `openOp`, nor the relay.
  // The only thing standing between the product and it is that the default `random` port is the
  // CSPRNG — which §8.10 already notes we do not control for ECDSA, and does not note here.
});

test('SUCCEEDED — six plaintext header fields give T1 a per-device activity profile with no key', async () => {
  const mama = await makeDevice();
  const papa = await makeDevice();
  const mamaLaptop = await makeDevice(mama.memberId);
  const sp = personalSpace();
  const key = await spaceKey();
  const r = ring([[sp, 3, key], [sp, 4, key], [sp, 5, key]]);

  const stream = [];
  for (const [d, ep, n] of [[mama, 3, 5], [papa, 3, 2], [mamaLaptop, 5, 4]]) {
    for (let i = 0; i < n; i++) {
      const op = makeOp(d, sp);
      stream.push(await sealOp(op, r, d.sigPriv, hdrFor(op, d.dv, ep, '')));
    }
  }

  // Everything below is computed from the plaintext columns of the `Op` table.
  const devices = new Set(stream.map((e) => e.dv));
  assert.equal(devices.size, 3, 'T1 counts the devices in the circle exactly');

  const perDevice = {};
  for (const e of stream) perDevice[e.dv] = (perDevice[e.dv] || 0) + 1;
  assert.deepEqual(Object.values(perDevice).sort(), [2, 4, 5],
    'T1 reads who writes how much — §8.7, and it is exact, not approximate');

  const epochs = new Set(stream.map((e) => e.ep));
  assert.equal(epochs.size, 2);
  assert.equal(Math.max(...epochs), 5,
    'the epoch counter is a membership-churn counter in the clear: 5 means five key changes');

  // What T1 does NOT get from the header: which member each device belongs to. `dv` is a hash of a
  // signing key, and the `memberId → dev.*` mapping lives inside the ciphertext. Mama's two
  // devices are two unlinked pseudonyms to the relay — until the coordination API links them.
  assert.notEqual(mama.dv, mamaLaptop.dv);
  assert.equal(new Set([mama.dv, mamaLaptop.dv]).size, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The WRAP channels — size, and count
// ─────────────────────────────────────────────────────────────────────────────

test('FAILED — a WrapBlob is a constant 156 bytes: its size says nothing about the key inside', async () => {
  const dev = await makeDevice();
  const peer = await makeDevice();
  const sp = familySpace();
  const sizes = new Set();
  for (let i = 0; i < 8; i++) {
    const blob = await wrapSpaceKey(await spaceKey(), dev.kexPriv, await importKex(peer.kexPubRaw),
      { spaceId: sp, epoch: 1 + i });
    sizes.add(canonicalJSON(blob).length);
    assert.equal(ub64(blob.salt).length, 32);
    assert.equal(ub64(blob.iv).length, AEAD.ivBytes);
    assert.equal(ub64(blob.ct).length, 48); // 32-byte key + 16-byte tag, always
  }
  assert.equal(sizes.size, 1, 'every wrap is the same size regardless of epoch or key');
  assert.deepEqual([...sizes], [156]);
});

test('SUCCEEDED — the wrap TABLE is an unencrypted census: devices × epochs, exactly', async () => {
  const mama = await makeDevice();
  const papa = await makeDevice();
  const sp = familySpace();
  const recipients = familyRecipients([memberRecord(mama), memberRecord(papa)]);

  const keys = new Map();
  for (let e = 1; e <= 4; e++) keys.set(e, await spaceKey());

  const wraps = await wrapRingToRecipients(keys, mama.kexPriv, recipients, { spaceId: sp, upTo: 4 });

  // Row count alone: 2 devices × 4 epochs. And every row carries `deviceId` in the clear
  // (`KeyWrapRow.deviceId`), so T1 reads the device roster and the full rotation history.
  assert.equal(wraps.length, 8);
  assert.equal(new Set(wraps.map((w) => w.deviceId)).size, 2);
  assert.deepEqual([...new Set(wraps.map((w) => w.epoch))].sort(), [1, 2, 3, 4]);

  // §4.3's join asymmetry is legible from the table too: a device whose rows start at epoch 1 has
  // been here since the beginning; a device whose rows ALSO start at epoch 1 but appears only
  // after the epoch-4 bump is a joiner being handed the history. T1 sees the difference by
  // arrival time, which nothing pads.
  const perDevice = wraps.filter((w) => w.deviceId === mama.deviceId);
  assert.equal(perDevice.length, 4, 'every recipient receives EVERY epoch — A4 requires it (§4.3)');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The AAD, restated as the relay's inventory
// ─────────────────────────────────────────────────────────────────────────────

test('the AAD binds six of the nine fields, and the other three are the ciphertext itself', async () => {
  assert.deepEqual([...AAD_FIELDS], ['v', 'sp', 'ep', 'dv', 'oid', 'wit']);
  const unbound = ENVELOPE_FIELDS.filter((f) => !AAD_FIELDS.includes(f));
  assert.deepEqual(unbound, ['iv', 'ct', 'sig']);
  // `iv` and `ct` are covered by the SIGNATURE (`sig` is over `aad ‖ iv ‖ ct`), so nothing on the
  // wire is unauthenticated. That is why every rewrite below fails at P3 rather than at the AEAD.
});
