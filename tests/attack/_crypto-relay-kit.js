// tests/attack/_crypto-relay-kit.js
//
// Shared adversary tooling for `crypto-relay-*.test.js` — ADR 002 §0's T1 (the curious or
// compromised relay) and T2 (the removed family member).
//
// WHAT AN ADVERSARY IS ALLOWED TO DO HERE, AND WHAT THEY ARE NOT.
//   T1 holds every envelope, every plaintext header, every IP and every arrival time. It holds NO
//      key, so it may never call `sealOp` with a real space key. Everything T1 does below is byte
//      surgery on envelopes it received, plus free choice of what it returns from any endpoint
//      (`GET /spaces/:id/keys` rows, the member list, the order and the subset of the op stream).
//   T2 additionally holds every epoch key she ever held and her own, still-attested device keys —
//      §8.2a: an attestation is write-once and cannot be withdrawn.
//
// `forge()` is the modified-client tool: it produces an envelope whose ECDSA signature is genuinely
// valid and whose GCM tag genuinely verifies over an adversarial plaintext. It is what makes the
// five post-decrypt checks testable at all, and it models T2 (who has both) and a coerced member
// (T5) — never T1, who has no key. Every use of it below says which adversary it is standing in for.
//
// SIGNATURE BYTES ARE NEVER COMPARED (ADR 002 §1 rule 1) and NO ERROR NAME IS EVER BRANCHED ON
// (rule 3): outcomes come back as `err.check` / `err.barrier` — strings this codebase defines.

import { b64u, ub64 } from '../../src/js/core/b64.js';
import { canonicalBytes } from '../../src/js/core/canon.js';
import { fmt } from '../../src/js/core/stamp.js';
import {
  memberId as mkMemberId, deviceId as mkDeviceId, opId as mkOpId, groupId as mkGroupId,
  entityUuid, spaceId as mkSpaceId,
} from '../../src/js/core/ids.js';
import { AEAD, SIGOP, KEX, aesgcm } from '../../src/js/crypto/suite.js';
import * as identity from '../../src/js/crypto/identity.js';
import { memKeyStore } from '../../src/js/platform/keystore.js';
import { aadOf, pad, EnvelopeError, RedactionError } from '../../src/js/crypto/envelope.js';

export const S = globalThis.crypto.subtle;
export const DAY = '2026-08-27';
export const BASE_MS = 1787836800123;

// ─────────────────────────────────────────────────────────────────────────────
// Identities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A member with one attested device. `memKeyStore()` — Node has no `indexedDB` (rule 7).
 * @param {string} [memberId] reuse to give one member two devices
 */
export async function makeDevice(memberId = mkMemberId()) {
  const ks = memKeyStore();
  const deviceId = mkDeviceId();
  const rec = await identity.ensureRecoveryIdentity(ks, memberId, { createdAt: DAY });
  const minted = await identity.ensureAttestedDevice(ks, memberId, rec.recSig.privateKey, {
    deviceId, createdAt: DAY,
  });
  return {
    memberId,
    deviceId,
    att: minted.attestation,
    blob: minted.blob,
    dv: minted.attestation.deviceShort,
    sigPriv: minted.identity.devSig.privateKey,
    sigPub: minted.identity.devSig.publicKey,
    kexPriv: minted.identity.devKex.privateKey,
    kexPub: minted.identity.devKex.publicKey,
    kexPubRaw: ub64(minted.attestation.kexPubRaw),
    recSigPub: rec.recSig.publicKey,
    recSigPubRaw: new Uint8Array(await S.exportKey('raw', rec.recSig.publicKey)),
    recKexPubRaw: new Uint8Array(await S.exportKey('raw', rec.recKex.publicKey)),
  };
}

/** The `AuthzResult.attestationOf` table — keyed by `deviceShort` ALONE (ADR 002 §5.2.1). */
export const tableOf = (...devs) => {
  const m = new Map(devs.map((d) => [d.dv, d.att]));
  return (dv) => m.get(dv) || null;
};

/** A member record in the shape `familyRecipients` reads. */
export const memberRecord = (dev, over = {}) => ({
  memberId: dev.memberId,
  recoveryPubSig: dev.recSigPubRaw,
  recoveryKexPubRaw: dev.recKexPubRaw,
  devices: [{ deviceId: dev.deviceId, kexPubRaw: dev.kexPubRaw, attestation: dev.blob }],
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// Ops, keys, rings
// ─────────────────────────────────────────────────────────────────────────────

export const familySpace = () => mkSpaceId('family');
export const personalSpace = () => mkSpaceId('personal');

export async function spaceKey() {
  return S.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/** A `KeyRing` over explicit (space, epoch) pairs. `get` is SYNCHRONOUS — the contract types it so. */
export function ring(entries) {
  const m = new Map(entries.map(([sp, ep, k]) => [`${sp} ${ep}`, k]));
  return { get: (sp, ep) => m.get(`${sp} ${ep}`) || null };
}

export function makeOp(dev, sp, over = {}) {
  return {
    v: 1,
    id: mkOpId(),
    ts: fmt(BASE_MS, 3, dev.dv),
    space: sp,
    act: dev.memberId,
    dev: dev.deviceId,
    gid: mkGroupId(),
    k: 'note.set',
    e: `note:${entityUuid()}`,
    f: { date: '2026-09-10', text: 'Zahnarzt' },
    ...over,
  };
}

/** A family `pub.set` — the op shape §5.3's padding argument is actually about. */
export function pubOp(dev, sp, f, over = {}) {
  return makeOp(dev, sp, { k: 'pub.set', e: `fnote:${entityUuid()}`, f, ...over });
}

export const hdrFor = (op, dv, ep = 3, wit = '') => ({ v: 1, sp: op.space, ep, dv, oid: op.id, wit });

// ─────────────────────────────────────────────────────────────────────────────
// The adversary's tools
// ─────────────────────────────────────────────────────────────────────────────

/** SEAL WITHOUT ANY OF `sealOp`'s GUARDS — a modified client (T2 / T5), never T1. */
export async function forge(op, hdr, key, sigPriv, { plaintext = null, ivBytes = null } = {}) {
  const aad = aadOf(hdr);
  const body = plaintext !== null ? plaintext : pad(canonicalBytes(op));
  const iv = ivBytes || globalThis.crypto.getRandomValues(new Uint8Array(AEAD.ivBytes));
  const ct = new Uint8Array(await S.encrypt(aesgcm(iv, aad), key, body));
  const sig = new Uint8Array(await S.sign(SIGOP, sigPriv, concat(aad, iv, ct)));
  return { ...hdr, iv: b64u(iv), ct: b64u(ct), sig: b64u(sig) };
}

/** Re-sign an existing envelope's `aad ‖ iv ‖ ct` under another key — the second step of any
 *  header rewrite, and the step that proves the AAD and the signature are INDEPENDENT barriers. */
export async function resign(env, sigPriv) {
  const aad = aadOf(env);
  const sig = new Uint8Array(await S.sign(SIGOP, sigPriv, concat(aad, ub64(env.iv), ub64(env.ct))));
  return { ...env, sig: b64u(sig) };
}

export function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * Run `fn` and report WHAT REFUSED IT, as a plain string this codebase defines.
 *
 *   'C1'…'C5' / 'P2' / 'P3' / 'shape' / 'aead' / 'padding' / 'canonical'  — `EnvelopeError.check`
 *   'barrier2'…'barrier4' / 'backstop' / 'brand'                          — `RedactionError.barrier`
 *   'park:<reason>'                                                       — a park, not a throw
 *   'OPENED'                                                              — the attack SUCCEEDED
 *   'UNEXPECTED …'                                                        — an uncaught foreign throw
 *
 * `UNEXPECTED` is not a helper convenience: an uncaught non-`EnvelopeError` escaping `openOp` is
 * itself one of the things this suite is hunting for, so it must be VISIBLE in the assertion diff
 * rather than crashing the test.
 */
export async function outcome(fn) {
  let r;
  try {
    r = await fn();
  } catch (err) {
    if (err instanceof EnvelopeError) return err.check;
    if (err instanceof RedactionError) return err.barrier;
    return `UNEXPECTED ${err && err.name}: ${err && err.message}`;
  }
  if (r && r.status === 'park') return `park:${r.parkReason}`;
  if (r && r.status === 'opened') return 'OPENED';
  return `RETURNED ${JSON.stringify(r)}`;
}

/** Import a raw P-256 point as an ECDH public key. RULE 5: `keyUsages` MUST be empty. */
export const importKex = (raw) => S.importKey('raw', raw, KEX, true, []);

export const rawPubOf = async (kp) => new Uint8Array(await S.exportKey('raw', kp.publicKey));

/** The raw 32 bytes behind an extractable AES key — so a test can prove WHICH key is in a ring. */
export const rawAesOf = async (k) => b64u(new Uint8Array(await S.exportKey('raw', k)));
