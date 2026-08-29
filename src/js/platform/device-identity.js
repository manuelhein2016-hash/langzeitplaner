// src/js/platform/device-identity.js — the keystore → store identity bridge.  LZP-501.
// Finding A3-H4 · ADR 002 §2.2, §2.3, §2.4 · ADR 001 §4.0 · story 15.1 / Principle 7.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THERE IS A FILE HERE AT ALL, RATHER THAN THREE LINES IN `store.js`
// ─────────────────────────────────────────────────────────────────────────────
//
// `store.js` may not import `src/js/crypto/`. Not as a style rule — as a gate:
// `tests/tier1/crypto-identity.test.js`'s PRINCIPLE 7 test walks the import graph from
// `boot.js`, `firstrun.js` and `main.js` and FAILS if anything under `src/js/crypto/` is
// reachable, because an `import` is evaluated whether or not anybody calls the function, and
// ADR 002 §2.4 promises first run mints "only a `memberId` and a `deviceShort`. NO KEYGEN, NO
// PROBE, NO NETWORK." `store.js` is in every one of those graphs.
//
// So the crypto side of the identity lives here, in a module NOTHING in the boot graph imports,
// reached only by the family/pairing opt-in path through a dynamic `await import()`. What it
// hands `store.useIdentity()` is three strings and two closures — no `CryptoKey` crosses that
// seam, and the store stays a module that cannot generate a key even by accident.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT "DURABLE" MEANS HERE, EXACTLY
// ─────────────────────────────────────────────────────────────────────────────
//
//   memberId    THE PERSON. Survives every device (ADR 002 §2.1). Persisted in the keystore's
//               `recMeta` / `devMeta` records, and carried to a second Mac by PAIRING (§6) or by
//               the backup file (§7.2) — never re-minted, because a re-minted memberId is a new
//               person and every op the old one authored becomes a stranger's.
//   deviceId    THIS MAC's label. Minted once, stored in `devMeta`.
//   deviceShort `crock32(SHA-256(rawSigPublicKey)[0..10])` — a function of the signing key and of
//               nothing else, so it is durable exactly because the key is (§5.2.0). It is the
//               short every stamp this Mac mints will carry, which is what makes ADR 002 §5.2.2's
//               check 4 (`devOf(op.ts) === env.dv`) a statement about a signature.
//
// `ensureDeviceIdentity` is idempotent and deliberately brittle about partial state — all three
// records or none, anything between is a loud throw rather than a silently re-minted second
// identity. That discipline is the reason this module is thin: it does not re-implement any of
// it, it decides WHEN to call it and turns the answer into the shape the store takes.
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO MACS, ONE PERSON — WHAT THE STORE NEEDS AND WHERE IT COMES FROM
// ─────────────────────────────────────────────────────────────────────────────
//
// M1 ("Zwei Macs") is one MEMBER with two DEVICES, so both Macs run with the SAME `memberId` and
// different `deviceId`/`deviceShort`. `foldAuthorized`'s personal-space gate is `op.act === me`
// plus `op.dev ∈ ctx.myDevices` (ADR 001 §4.0), so:
//
//   · the shared `memberId` is what makes the first half true — and it is why pairing delivers
//     the member identity rather than minting a second one;
//   · `myDevices` is the second half, and `deviceSetFor` below is where it comes from.
//
// **A GAP, REPORTED RATHER THAN PAPERED OVER.** `core/ops.js`'s `OP_KINDS` puts `member.set` —
// the only op kind that can write a `member:<M>` → `dev.<short>` attestation register — in the
// **family** space (`space: 'family'`, and `spaceFor()` throws without an `fsp_…` id). So a
// person with two Macs and NO Familienkreis has nowhere in the log to record that their second
// Mac is theirs, and the log-derived half of `myDevices` is empty for them. The pairing-derived
// half (`peerDeviceIds`) is what carries M1, which is also the source ADR 001 §4.0 names first
// ("the LOCAL device set"). This is not a defect in either file; it is a seam nobody has had to
// name until a second device existed. It needs an owner before M1 ships.

import {
  ensureDeviceIdentity,
  ensureRecoveryIdentity,
  ensureAttestedDevice,
  verifyAttestation,
  attestOpenFrom,
  attestOpenKey,
  importSigPublic,
  signBytes,
  KEYSTORE_IDS,
} from '../crypto/identity.js';
import { memberId as mintMemberId, deviceId as mintDeviceId } from '../core/ids.js';
import { parseAttestationBlob } from '../core/authz.js';
import { ub64 } from '../core/b64.js';

const TD = new TextDecoder('utf-8', { fatal: true });

/** Custody says whether it will survive a quit. A memory store cannot hold an identity. */
export class IdentityUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'IdentityUnavailableError';
    this.cause = cause;
  }
}

/**
 * The `memberId` this machine already belongs to, read from the keystore's own metadata, or
 * `null` if this Mac has never been part of anything.
 *
 * `devMeta` is preferred over `recMeta` because a Mac paired into an existing member has a device
 * record and may not hold the recovery identity at all; both are checked, and a disagreement is a
 * throw rather than a pick, for the reason `ensureDeviceIdentity` gives about partial state.
 *
 * @param {import('../crypto/identity.js').KeyStore} ks
 * @returns {Promise<string|null>}
 */
export async function readMemberId(ks) {
  const read = async (id) => {
    const bytes = await ks.get(id);
    if (!(bytes instanceof Uint8Array)) return null;
    try {
      const v = JSON.parse(TD.decode(bytes));
      return v && typeof v === 'object' && typeof v.memberId === 'string' ? v.memberId : null;
    } catch {
      return null;
    }
  };
  const [fromDev, fromRec] = await Promise.all([read(KEYSTORE_IDS.devMeta), read(KEYSTORE_IDS.recMeta)]);
  if (fromDev && fromRec && fromDev !== fromRec) {
    throw new IdentityUnavailableError(
      `device-identity: this key store holds a device record for ${fromDev} and a recovery record `
      + `for ${fromRec}. Refusing to choose; this Mac must be re-paired.`
    );
  }
  return fromDev ?? fromRec ?? null;
}

/**
 * Open — or, on the very first family opt-in, mint — this Mac's durable identity.
 *
 * **Never called in solo mode.** Every path into it is behind the family/pairing opt-in, and the
 * import graph is what enforces that (see the header). `probeCrypto()` must have passed before
 * this is reached; `generateKey` is the first thing that fails on an engine that cannot do it,
 * and the family entry point owns that message, not this file.
 *
 * @param {import('../crypto/identity.js').KeyStore} ks
 * @param {{ memberId?:string, today:string, custody?:'indexeddb'|'memory'|string,
 *           allowMemoryCustody?:boolean, withRecoveryKey?:boolean,
 *           newMemberId?:() => string, newDeviceId?:() => string,
 *           subtle?:SubtleCrypto, random?:(n:number)=>Uint8Array }} opts
 *        `today` is injected `YYYY-MM-DD` — nothing here reads a clock.
 * @returns {Promise<{ forStore:{memberId:string, deviceId:string, deviceShort:string},
 *                     identity:Object, sign:(b:Uint8Array)=>Promise<Uint8Array>,
 *                     recovery:Object|null, minted:boolean }>}
 */
export async function openDeviceIdentity(ks, opts) {
  const {
    today, custody, allowMemoryCustody = false, withRecoveryKey = true,
    newMemberId = mintMemberId, newDeviceId = mintDeviceId,
  } = opts || {};
  if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new TypeError("device-identity: openDeviceIdentity needs an injected `today`, 'YYYY-MM-DD'");
  }
  // `chooseKeyStore` reports `kind` precisely so this refusal can exist: a device attested
  // against a memory store has an attestation for a key that will not exist tomorrow, and the
  // member would be left with a permanent `dev.*` register (write-once!) for a ghost.
  if (custody === 'memory' && !allowMemoryCustody) {
    throw new IdentityUnavailableError(
      'device-identity: this runtime offers only memory custody, so an identity minted here would '
      + 'not survive a quit. Refusing to pair against it (keystore.chooseKeyStore reports `kind`).'
    );
  }

  const known = await readMemberId(ks);
  const memberId = opts.memberId ?? known ?? newMemberId();
  if (known && opts.memberId && known !== opts.memberId) {
    throw new IdentityUnavailableError(
      `device-identity: this Mac already belongs to ${known}; it is never re-pointed at ${opts.memberId}.`
    );
  }

  const ports = { subtle: opts.subtle, random: opts.random };
  const recovery = withRecoveryKey
    ? await ensureRecoveryIdentity(ks, memberId, { ...ports, createdAt: today })
    : null;
  const identity = await ensureDeviceIdentity(ks, memberId, {
    ...ports,
    deviceId: newDeviceId(),
    createdAt: today,
  });

  return {
    forStore: {
      memberId: identity.memberId,
      deviceId: identity.deviceId,
      deviceShort: identity.deviceShort,
    },
    identity,
    // The ONE binding `platform/net.js` needs, and the reason net.js imports no crypto: the
    // private half is `extractable: false`, so a signature is the only thing that can cross this
    // boundary. Handed to `createFetchTransport`/`createBridgeTransport` as `sign`.
    sign: (bytes) => signBytes(identity.devSig.privateKey, bytes, ports),
    recovery,
    minted: known === null,
  };
}

/**
 * Attest this device under the member's own recovery key, and produce the `member.set` field the
 * log records it with: `{ ['dev.' + deviceShort]: blob }`.
 *
 * SELF-ATTESTATION IS THE BASE CASE, AND IT IS ALSO THE POSSESSION PROOF. ADR 001 §4.0: "A
 * `member.set` patch consisting SOLELY of `dev.*` registers is self-authorizing on
 * `op.act === memberId`" — requiring an already-attested device to author an attestation has no
 * base case. And FINDINGS §4.5 option (a) adds the half that makes the register a CREDENTIAL
 * rather than a claim: `authz.js` only enters `attestationOf` for a register whose WRITING op was
 * stamped by the device it attests (`devOf(cell.stamp) === att.deviceShort`). So each Mac must
 * author its OWN `dev.<short>`; one Mac writing both produces an `unprovenShort`, which still
 * populates `attestedDevices` but is never handed to `openOp` as a verification key.
 *
 * @param {import('../crypto/identity.js').KeyStore} ks
 * @param {{memberId:string, deviceId:string, deviceShort:string}} who
 * @param {CryptoKey} recSigPriv the member's `RK_sig` private key
 * @param {{createdAt:string, subtle?:SubtleCrypto, random?:(n:number)=>Uint8Array}} opts
 * @returns {Promise<{field:Object<string,string>, blob:string, attestation:Object}>}
 */
export async function selfAttest(ks, who, recSigPriv, opts) {
  const { attestation, blob } = await ensureAttestedDevice(ks, who.memberId, recSigPriv, {
    deviceId: who.deviceId,
    createdAt: opts.createdAt,
    subtle: opts.subtle,
    random: opts.random,
  });
  return { field: { [`dev.${attestation.deviceShort}`]: blob }, blob, attestation };
}

/**
 * Build the SYNCHRONOUS `attestOpen(memberId, blob) => DeviceAttestation|null` that
 * `foldAuthorized` takes, by verifying every blob ahead of time.
 *
 * The fold is pure and synchronous and WebCrypto is not, which is why `attestOpenFrom` exists:
 * the async work is done here, once, and the fold is handed a lookup. Fail-closed is preserved —
 * a blob that does not verify is simply absent from the map, and `attestOpenFrom` returns `null`
 * for it, which `authz.js` reads as `BAD_ATTESTATION`.
 *
 * @param {Array<{memberId:string, recoveryPubSigRaw:Uint8Array|string, blobs:string[]}>} members
 *        the member rows a pull piggybacks (ADR 003 §3.2) plus my own record
 * @param {{subtle?:SubtleCrypto}} [ports]
 * @returns {Promise<(memberId:string, blob:string) => (Object|null)>}
 */
export async function buildAttestOpen(members, ports = {}) {
  const verified = new Map();
  for (const row of members || []) {
    const raw = typeof row.recoveryPubSigRaw === 'string' ? ub64(row.recoveryPubSigRaw) : row.recoveryPubSigRaw;
    if (!(raw instanceof Uint8Array) || raw.length !== 65) continue;
    let recSigPub;
    try {
      recSigPub = await importSigPublic(raw, ports);
    } catch {
      continue;                       // an unusable recovery key verifies nothing; it is not a throw
    }
    for (const blob of row.blobs || []) {
      const att = await verifyAttestation(blob, recSigPub, ports);
      // `verifyAttestation` returning a payload is not on its own enough: the fold compares the
      // opener's answer field by field against `parseAttestationBlob(blob)` and treats any
      // disagreement as a failed verification (`authz.js`'s `attestationVerifies`). Storing the
      // verified payload, and only when it parses, keeps the two answers identical by
      // construction rather than by luck.
      if (att && parseAttestationBlob(blob)) verified.set(attestOpenKey(row.memberId, blob), att);
    }
  }
  return attestOpenFrom(verified);
}

/**
 * `peerDeviceIds` for `store.useIdentity()` — my member's OTHER devices.
 *
 * ADR 001 §4.0 calls this "the local device set", and local is the operative word: it is what
 * PAIRING established on this machine, not what a log or a relay says. `rows` is the member list
 * a pull piggybacks or the pairing session's own result; only my member's row is read, and my own
 * device is excluded because the store adds it unconditionally.
 *
 * @param {string} memberId mine
 * @param {string} myDeviceId mine
 * @param {Array<{memberId:string, devices?:Array<{deviceId?:string, revokedAt?:string|null}>}>} rows
 * @returns {string[]} sorted, so two devices computing it from the same input agree
 */
export function deviceSetFor(memberId, myDeviceId, rows) {
  const out = new Set();
  for (const row of rows || []) {
    if (row.memberId !== memberId) continue;
    for (const d of row.devices || []) {
      // A revoked device is not one of mine any more (19.5). Its ops keep whatever they already
      // merged — revocation is not retroactive — but nothing NEW is admitted under it.
      if (d && typeof d.deviceId === 'string' && !d.revokedAt && d.deviceId !== myDeviceId) {
        out.add(d.deviceId);
      }
    }
  }
  return [...out].sort();
}
