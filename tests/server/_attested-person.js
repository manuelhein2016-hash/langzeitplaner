// tests/server/_attested-person.js — a person the relay will actually admit.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS IS, AND WHY IT IS NOT A FIXTURE GENERATOR
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Every `tests/server/` suite used to build a person out of `bytes(65, seed)` — sixty-five
// deterministic bytes standing in for a P-256 point, and `bytes(120, seed)` standing in for an
// attestation. That was correct for as long as the relay treated `device.attestation` as an
// opaque column, and it is exactly why finding E2E3-7 survived so long: a suite whose
// attestations are noise cannot notice that one route verifies them and another does not.
//
// `POST /api/v1/spaces` now runs the same ADR 002 §2.3 check `POST /api/v1/devices` has always
// run, and `GET /api/v1/spaces/:id/members` publishes the blob (finding E2E3-6), so the
// attestation has to be REAL — signed by a real recovery key over the real public points of the
// real device being registered.
//
// **Nothing here is a stand-in and nothing is hand-rolled.** The keys come from WebCrypto, the
// short comes from the shipping `deviceShortOfRawBytes`, and the blob comes from the shipping
// `buildDeviceAttestation` + `attestDevice` — the same two functions `pairing.js` and `backup.js`
// call on a real Mac. A test that minted its own blob would be proving that the relay accepts
// what this file writes rather than what the product writes, which is the courier problem the
// E2↔E3 seam was made of (`server/dev/two-client.js`: *"STAND-IN: the wire carries no
// attestation"*).
//
// Ids stay in the caller's hands so a suite can keep its own naming; only the CRYPTOGRAPHY is
// fixed. `deviceShort` cannot be chosen, because ADR 001 §1.2 derives it and the relay re-derives
// it (`verifyDeviceClaim`'s P2).
// ═════════════════════════════════════════════════════════════════════════════════════════════

import {
  attestDevice,
  buildDeviceAttestation,
  deviceShortOf as deviceShortOfRawBytes,
  exportRawPublic,
} from '../../src/js/crypto/identity.js';

const S = globalThis.crypto.subtle;

const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rnd = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const id22 = () => b64u(rnd(16));

/** @returns {Promise<{priv:CryptoKey, pub:CryptoKey, pubRaw:Uint8Array}>} */
async function genSig() {
  const kp = await S.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { priv: kp.privateKey, pub: kp.publicKey, pubRaw: await exportRawPublic(kp.publicKey) };
}

/** @returns {Promise<{priv:CryptoKey, pub:CryptoKey, pubRaw:Uint8Array}>} */
async function genKex() {
  const kp = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { priv: kp.privateKey, pub: kp.publicKey, pubRaw: await exportRawPublic(kp.publicKey) };
}

/**
 * One member with one device, attested for real.
 *
 * Every byte field is a `Uint8Array`; every `*B64` field is its base64url spelling, so a suite
 * that speaks either can use this without converting. `attestation` is the blob STRING — the one
 * spelling every write path now takes (finding E2E3-7) — and `attestationBytes` is what the
 * column holds.
 *
 * @param {{colorRef?:string, memberId?:string, deviceId?:string, createdAt?:string,
 *          recovery?:{priv:CryptoKey, pubRaw:Uint8Array}}} [o]
 */
export async function attestedPerson(o = {}) {
  const rec = o.recovery ? { priv: o.recovery.priv, pubRaw: o.recovery.pubRaw } : await genSig();
  const recKex = o.recoveryKex || await genKex();
  const sig = await genSig();
  const kex = await genKex();

  const memberId = o.memberId || `mem_${id22()}`;
  const deviceId = o.deviceId || `dev_${id22()}`;
  const createdAt = o.createdAt || '2026-08-29';

  // The shipping minter, not a copy of it. `buildDeviceAttestation` DERIVES `deviceShort` and
  // `attestDevice` refuses to sign a payload that fails ADR 002 §5.2.2's P2 — so a person this
  // function returns is one the relay's own P2 check will agree with, and a person it cannot
  // build is one the relay would have refused.
  const att = await buildDeviceAttestation({ memberId, deviceId, createdAt }, sig.pub, kex.pub);
  const attestation = await attestDevice(att, rec.priv);

  return {
    colorRef: o.colorRef || 'gruen',
    memberId,
    deviceId,
    deviceShort: deviceShortOfRawBytes(sig.pubRaw),

    // device identity
    sigPriv: sig.priv,
    sigPub: sig.pub,
    kexPub: kex.pub,
    sigPubRaw: sig.pubRaw,
    sigPubRawB64: b64u(sig.pubRaw),
    kexPriv: kex.priv,
    kexPubRaw: kex.pubRaw,
    kexPubRawB64: b64u(kex.pubRaw),

    // member identity
    recPriv: rec.priv,
    recoveryPubSig: rec.pubRaw,
    recoveryPubSigB64: b64u(rec.pubRaw),
    recKexPriv: recKex.priv,
    recoveryPubKex: recKex.pubRaw,
    recoveryPubKexB64: b64u(recKex.pubRaw),

    attestation,
    attestationBytes: new TextEncoder().encode(attestation),
  };
}

/**
 * A SECOND device for an existing person, attested by the SAME member recovery key. This is what
 * story 19.5 does, and it is the case that makes a rotation carry more than one wrap per member.
 * @param {Awaited<ReturnType<typeof attestedPerson>>} p
 */
export async function attestedDeviceFor(p, o = {}) {
  // `borrowKeysFrom` is ADR 002 §2.3's SQUAT, buildable on purpose: one member attesting, under
  // her own recovery key, a payload naming ANOTHER device's public points — which is honest in
  // every checkable respect and gives her that device's `deviceShort`. It is how a suite reaches
  // the relay's `deviceShort` collision check now that a short cannot simply be typed.
  const sig = o.borrowKeysFrom ? { priv: null, pub: o.borrowKeysFrom.sigPub, pubRaw: o.borrowKeysFrom.sigPubRaw } : await genSig();
  const kex = o.borrowKeysFrom ? { priv: null, pub: o.borrowKeysFrom.kexPub, pubRaw: o.borrowKeysFrom.kexPubRaw } : await genKex();
  const deviceId = o.deviceId || `dev_${id22()}`;
  const att = await buildDeviceAttestation(
    { memberId: p.memberId, deviceId, createdAt: o.createdAt || '2026-08-29' }, sig.pub, kex.pub,
  );
  const attestation = await attestDevice(att, p.recPriv);
  return {
    memberId: p.memberId,
    deviceId,
    deviceShort: deviceShortOfRawBytes(sig.pubRaw),
    sigPriv: sig.priv,
    sigPubRaw: sig.pubRaw,
    sigPubRawB64: b64u(sig.pubRaw),
    kexPriv: kex.priv,
    kexPubRaw: kex.pubRaw,
    kexPubRawB64: b64u(kex.pubRaw),
    attestation,
    attestationBytes: new TextEncoder().encode(attestation),
  };
}

/** The `device` half of a `POST /spaces` or `POST /invites/redeem` body. */
export const deviceWire = (p) => ({
  deviceId: p.deviceId,
  deviceShort: p.deviceShort,
  sigPubRaw: p.sigPubRawB64,
  kexPubRaw: p.kexPubRawB64,
  attestation: p.attestation,
});

/** The `member` half. */
export const memberWire = (p) => ({
  memberId: p.memberId,
  recoveryPubSig: p.recoveryPubSigB64,
  recoveryPubKex: p.recoveryPubKexB64,
});

/** The row a suite seeds straight into the store when it is not testing the endpoint. */
export const deviceRow = (p, o = {}) => ({
  id: p.deviceId,
  memberId: p.memberId,
  deviceShort: p.deviceShort,
  sigPubRaw: p.sigPubRaw,
  kexPubRaw: p.kexPubRaw,
  attestation: p.attestationBytes,
  lastSeenSeq: 0n,
  lastPushedSeq: 0n,
  addedAt: o.addedAt || new Date(0),
  revokedAt: o.revokedAt ?? null,
});

export { b64u, rnd, id22 };
