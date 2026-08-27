// tests/attack/_member-kit.js — fixtures for the T5 / T4 attack files.
//
// The adversary here is INSIDE the circle: `crypto-member-read`, `-impersonate`, `-pairing` and
// `-backup` all attack from a real, attested family member's chair — the admin's chair included.
// So every fixture below is a REAL member with REAL keys and a REAL signed attestation. Nothing
// is doubled: the attacker's blobs verify, the attacker's signatures verify, and the attacker's
// devices are attested by the attacker's own recovery key. That is the whole point — the
// interesting attacks are the ones an honest-looking member can mount.
//
// ENGINE RULES (ADR 002 §1) observed: no signature bytes are ever compared (rule 1), no error
// NAME is ever branched on (rule 3) — outcomes are read as `err.check` / `err.code` /
// `err.barrier` or as a `park` this codebase defines — and `memKeyStore()` is used everywhere,
// because Node has no `indexedDB` (rule 7).

import { b64u, ub64 } from '../../src/js/core/b64.js';
import { fmt } from '../../src/js/core/stamp.js';
import {
  memberId as mkMemberId, deviceId as mkDeviceId, opId as mkOpId, groupId as mkGroupId,
  entityUuid, spaceId as mkSpaceId,
} from '../../src/js/core/ids.js';
import * as identity from '../../src/js/crypto/identity.js';
import { memKeyStore } from '../../src/js/platform/keystore.js';

export { b64u, ub64, fmt, mkMemberId, mkDeviceId, mkOpId, mkGroupId, entityUuid, mkSpaceId };
export const S = globalThis.crypto.subtle;
export const DAY = '2026-08-27';
/** Test-only PBKDF2 rounds. The shipped 600 000 is paid by `tests/tier1/crypto-backup.test.js`. */
export const FAST = 1000;

/** A member with a recovery pair and `n` attested devices. */
export async function makeMember(n = 1) {
  const ks = memKeyStore();
  const memberId = mkMemberId();
  const rec = await identity.ensureRecoveryIdentity(ks, memberId, { createdAt: DAY });
  const devices = [];
  for (let i = 0; i < n; i++) {
    const { devSig, devKex } = await identity.generateDeviceKeys();
    const deviceId = mkDeviceId();
    const att = await identity.buildDeviceAttestation(
      { memberId, deviceId, createdAt: DAY }, devSig.publicKey, devKex.publicKey
    );
    devices.push({
      deviceId,
      memberId,
      deviceShort: att.deviceShort,
      att,
      attestation: await identity.attestDevice(att, rec.recSig.privateKey),
      kexPubRaw: await identity.exportRawPublic(devKex.publicKey),
      sigPubRaw: att.sigPubRaw,
      devSig,
      devKex,
    });
  }
  return {
    ks, memberId, rec, devices,
    recoveryPubSig: await identity.exportRawPublic(rec.recSig.publicKey),
  };
}

/** The shape `familyRecipients` takes. */
export const memberRecord = (m, over = {}) => ({
  memberId: m.memberId,
  recoveryPubSig: m.recoveryPubSig,
  devices: m.devices.map((d) => ({
    deviceId: d.deviceId, kexPubRaw: d.kexPubRaw, attestation: d.attestation,
  })),
  ...over,
});

/** A `KeyRing` over an explicit list. `get` is SYNCHRONOUS and TOTAL — a miss is a park. */
export const ring = (entries) => {
  const m = new Map(entries.map(([sp, ep, k]) => [`${sp} ${ep}`, k]));
  return { get: (sp, ep) => m.get(`${sp} ${ep}`) || null };
};

/** `AuthzResult.attestationOf` — keyed by `deviceShort` ALONE (ADR 002 §5.2.1 correction 2). */
export const tableOf = (...devs) => {
  const m = new Map(devs.map((d) => [d.deviceShort, d.att]));
  return (dv) => m.get(dv) || null;
};

export function makeOp(dev, space, over = {}) {
  return {
    v: 1,
    id: mkOpId(),
    ts: fmt(1787836800123, 3, dev.deviceShort),
    space,
    act: dev.memberId,
    dev: dev.deviceId,
    gid: mkGroupId(),
    k: 'note.set',
    e: `note:${entityUuid()}`,
    f: { date: '2026-09-10', text: 'Zahnarzt' },
    ...over,
  };
}

export const hdrFor = (op, dev, ep) =>
  ({ v: 1, sp: op.space, ep, dv: dev.deviceShort, oid: op.id, wit: '' });

/** A family entity key — `fnote:<memberId>/<uuid>` (core/entities.js). */
export const fnoteKey = (memberId) => `fnote:${memberId}/${entityUuid()}`;

/** A `member.set{dev.<short>: blob}` op, as it travels inside the family stream. */
export const attOp = (memberId, dev, blob, short, space, ms) => ({
  v: 1,
  id: mkOpId(),
  ts: fmt(ms, 1, dev.deviceShort),
  space,
  act: memberId,
  dev: dev.deviceId,
  gid: mkGroupId(),
  k: 'member.set',
  e: `member:${memberId}`,
  f: { [`dev.${short}`]: blob },
});

/**
 * The pre-resolved `attestOpen` table `foldAuthorized` takes (ADR 002 §5.2.3). The fold is pure
 * and may not await, so verification is resolved into a table before it runs — and this builds
 * that table with the REAL `verifyAttestation`, never a stub that says yes.
 */
export async function attestOpenOver(pairs) {
  const table = new Map();
  for (const [memberId, blob, recSigPub] of pairs) {
    table.set(identity.attestOpenKey(memberId, blob), await identity.verifyAttestation(blob, recSigPub));
  }
  return (memberId, blob) => table.get(identity.attestOpenKey(memberId, blob)) ?? null;
}

/**
 * Read WHICH invariant refused, as a string this codebase defines — never an engine error NAME
 * (rule 3). A park is reported as `park:<reason>`, because a park is not a refusal.
 */
export async function outcomeOf(fn) {
  try {
    const r = await fn();
    if (r && r.status === 'park') return `park:${r.parkReason}`;
    return (r && r.status) || 'OK';
  } catch (err) {
    return err.check || err.code || err.barrier || `UNEXPECTED ${err && err.name}: ${err && err.message}`;
  }
}

/** Raw AES key bytes, for asserting WHICH key landed in a ring. Keys, not signatures — rule 1
 *  is about signature bytes and does not apply. */
export const rawKey = async (k) => b64u(new Uint8Array(await S.exportKey('raw', k)));
