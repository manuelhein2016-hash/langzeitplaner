// src/js/crypto/identity.js — device and member identity.  LZP-302 · ADR 002 §2.
//
// DOM-free, I/O-free, dependency-free (ADR 005 §2). Every effect — the CSPRNG, the SubtleCrypto,
// the calendar day, and the key STORE itself — arrives as an injected port. Nothing in this file
// reads a clock, opens a database or touches a global other than `globalThis.crypto`, and the
// `KeyStore` it is handed is an interface (`src/js/platform/keystore.js` implements three).
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FOUR KEYPAIRS (ADR 002 §2.1)
// ─────────────────────────────────────────────────────────────────────────────
//
//   per DEVICE (one Mac) — custody §2.2, IndexedDB, NEVER leaves it
//     IK_sig   ECDSA P-256, extractable:FALSE   signs ops, signs HTTP requests
//     IK_kex   ECDH  P-256, extractable:FALSE   receives wrapped space keys
//
//   per MEMBER (survives every device) — custody §2.2 Keychain + the backup file §7.2
//     RK_sig   ECDSA P-256, extractable:TRUE    "I am this member": attests and adopts devices
//     RK_kex   ECDH  P-256, extractable:TRUE    receives wrapped space keys during recovery
//
// `extractable: false` on the device pair is not a formality. It means the private bytes never
// enter the JS heap AT ALL — strictly stronger than exporting PKCS#8 to hand to a native Keychain
// API, which necessarily materialises the secret somewhere a compromised page script could read
// it. It is also why `exportKey` on a device private key must REJECT, and why that rejection is
// asserted in both engines rather than assumed (§2.2's verification item; see
// `tests/tier2/crypto-keystore-phase1.dom.js`).
//
// The recovery pair is extractable precisely because §7.2 has to be able to seal it into the
// backup file. §7.2 then decides, once, that it is sealed under a passphrase or omitted
// entirely — never written in plaintext (PO decision D8).
//
// ─────────────────────────────────────────────────────────────────────────────
// SOLO MODE GENERATES NOTHING (ADR 002 §2.4, Principle 7, story 15.1)
// ─────────────────────────────────────────────────────────────────────────────
//
// First run mints only a `memberId` (a uuid) and a `deviceShort`, and `deviceShort` is derived
// ON DEMAND. No keygen, no probe, no network, first-run screen unchanged. Every function in this
// file is reached from the family opt-in moment and from nowhere else — enforced by an import-
// graph test, not by memory (see `probe.js`'s header).
//
// ─────────────────────────────────────────────────────────────────────────────
// `deviceShort` IS SETTLED — READ THIS BEFORE CHANGING ANYTHING BELOW
// ─────────────────────────────────────────────────────────────────────────────
//
//   deviceShort = crock32(SHA-256(rawSigPublicKey)[0..10])       ADR 001 §1.2, ADR 002 §5.2.0
//
// A function of the device's SIGNING KEY and of nothing else. `op.dev` is `'dev_' + 128 random
// bits` with NO derivational relationship to that key, so `deviceShort(op.dev)` is not a
// computation that exists. Resolving one from the other is a LOOKUP over the member's `dev.*`
// attestation registers — `AuthzResult.attestationOf(dv)` in `src/js/core/authz.js` — and never
// a hash. Four consumers need the key-derived form (HTTP request auth, the relay's device
// principal, the HLC tiebreak, and `openOp`'s key selector); exactly one needs the lookup
// (ADR 001 §4.0 stage 0b). Both are provided here, spelled differently on purpose.

import { b64u, ub64, CodecError } from '../core/b64.js';
import { canonicalBytes } from '../core/canon.js';
import { deviceShortOf as deviceShortOfRawBytes, isDeviceShort, defaultRandom } from '../core/ids.js';
import { parseAttestationBlob } from '../core/authz.js';
import {
  SIG,
  SIGOP,
  KEX,
  USAGES,
  DEVICE_KEY_EXTRACTABLE,
  RECOVERY_KEY_EXTRACTABLE,
  RAW_PUBKEY_BYTES,
  SYMMETRIC_KEY_BYTES,
  assertSignable,
} from './suite.js';

// ─────────────────────────────────────────────────────────────────────────────
// 0. Ports
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} CryptoPorts
 * @property {SubtleCrypto} [subtle] defaults to the platform SubtleCrypto
 * @property {(n:number) => Uint8Array} [random] defaults to `crypto.getRandomValues`
 */

/**
 * The platform SubtleCrypto, resolved LAZILY.
 *
 * Lazily, because this module must import cleanly under bare Node with the DOM globals deleted
 * (`tests/tier1/core-purity.test.js` does exactly that), and because a module-load-time read
 * would freeze whatever `crypto` happened to exist at import time — which in a test that swaps
 * in a crippled engine is the wrong one.
 * @returns {SubtleCrypto}
 */
export function defaultSubtle() {
  const s = globalThis.crypto?.subtle;
  if (!s) {
    throw new Error(
      'identity: no SubtleCrypto. Family features must be gated on probeCrypto() — ' +
      'see src/js/crypto/probe.js. Solo mode never reaches this.'
    );
  }
  return s;
}

const subtleOf = (ports) => (ports && ports.subtle) || defaultSubtle();
const randomOf = (ports) => (ports && ports.random) || defaultRandom;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Key generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} DeviceKeyPairs
 * @property {CryptoKeyPair} devSig ECDSA P-256, private half NON-extractable
 * @property {CryptoKeyPair} devKex ECDH  P-256, private half NON-extractable
 */

/**
 * Mint this machine's two device pairs. Called once, at the family opt-in moment, and again on
 * `importBackup` — a restored member gets FRESH device keys, never a restored device identity,
 * because a device is a machine and not a person (ADR 002 §7.3 step 3).
 * @param {CryptoPorts} [ports]
 * @returns {Promise<DeviceKeyPairs>}
 */
export async function generateDeviceKeys(ports) {
  const S = subtleOf(ports);
  const devSig = await S.generateKey(SIG, DEVICE_KEY_EXTRACTABLE, [...USAGES.sig]);
  const devKex = await S.generateKey(KEX, DEVICE_KEY_EXTRACTABLE, [...USAGES.kex]);
  return { devSig, devKex };
}

/**
 * @typedef {Object} RecoveryKeyPairs
 * @property {CryptoKeyPair} recSig ECDSA P-256, EXTRACTABLE — §7.2 must be able to seal it
 * @property {CryptoKeyPair} recKex ECDH  P-256, EXTRACTABLE
 */

/**
 * Mint the member's recovery pair. Extractable, and that is a decision with a cost: §8.12 records
 * that the recovery key has no revocation and no leak detection. It is extractable because the
 * alternative — a member identity that cannot be carried to a new Mac — makes A2 ("re-joins my
 * Familienkreis") impossible, and makes losing one laptop mean losing the Familienkreis.
 * @param {CryptoPorts} [ports]
 * @returns {Promise<RecoveryKeyPairs>}
 */
export async function generateRecoveryKeys(ports) {
  const S = subtleOf(ports);
  const recSig = await S.generateKey(SIG, RECOVERY_KEY_EXTRACTABLE, [...USAGES.sig]);
  const recKex = await S.generateKey(KEX, RECOVERY_KEY_EXTRACTABLE, [...USAGES.kex]);
  return { recSig, recKex };
}

/**
 * A 32-byte device encryption key (ADR 002 §2.1, §2.2). The Keychain backstop holds this plus the
 * recovery pair wrapped under it; `IK_*` never leave IndexedDB.
 * @param {CryptoPorts} [ports]
 * @returns {Uint8Array} 32 bytes
 */
export function generateDek(ports) {
  const bytes = randomOf(ports)(SYMMETRIC_KEY_BYTES);
  if (!(bytes instanceof Uint8Array) || bytes.length !== SYMMETRIC_KEY_BYTES) {
    throw new Error(`identity.generateDek: the random port must return ${SYMMETRIC_KEY_BYTES} bytes`);
  }
  return bytes;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Public keys on the wire
//
// `raw` — 65 bytes, uncompressed `0x04 || X || Y` — is the wire format for BOTH public keys, in
// both engines, verified. Not `spki` (91 bytes), not `jwk`: `raw` is the shortest, it is what
// `deviceShortOf` hashes, and it is what `DeviceAttestation.sigPubRaw` / `.kexPubRaw` carry.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {CryptoKey} publicKey
 * @param {CryptoPorts} [ports]
 * @returns {Promise<Uint8Array>} exactly 65 bytes
 */
export async function exportRawPublic(publicKey, ports) {
  const raw = new Uint8Array(await subtleOf(ports).exportKey('raw', publicKey));
  if (raw.length !== RAW_PUBKEY_BYTES) {
    throw new Error(
      `identity.exportRawPublic: expected ${RAW_PUBKEY_BYTES} bytes for an uncompressed ` +
      `P-256 point, got ${raw.length}`
    );
  }
  return raw;
}

/**
 * Import a peer's SIGNING public key. Usages are `['verify']` and nothing else: we never sign
 * with a key that came off the wire.
 * @param {Uint8Array} raw 65 bytes
 * @param {CryptoPorts} [ports]
 * @returns {Promise<CryptoKey>}
 */
export async function importSigPublic(raw, ports) {
  return subtleOf(ports).importKey('raw', asBytes(raw), SIG, true, [...USAGES.peerSig]);
}

/**
 * Import a peer's KEY-AGREEMENT public key.
 *
 * RULE 5 (ADR 002 §1): the usages array MUST be empty. A non-empty one is a `SyntaxError` in
 * both engines — ECDH usages belong to the private half, and the public half of an agreement has
 * no usage at all. `USAGES.peerKex` is frozen empty so this cannot drift.
 *
 * Both engines validate the point BEFORE scalar multiplication (§9.2's table: an off-curve point,
 * the point at infinity, and a P-384 key offered as P-256 all raise `DataError`), so there is no
 * invalid-curve surface at this API and no need for a hand-rolled point check.
 * @param {Uint8Array} raw 65 bytes
 * @param {CryptoPorts} [ports]
 * @returns {Promise<CryptoKey>}
 */
export async function importKexPublic(raw, ports) {
  return subtleOf(ports).importKey('raw', asBytes(raw), KEX, true, [...USAGES.peerKex]);
}

function asBytes(b) {
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  throw new Error('identity: expected a Uint8Array of raw key bytes');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. deviceShort
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `crock32(SHA-256(rawSigPub)[0..10])` — the ONE definition (ADR 001 §1.2). Synchronous, using
 * `core/ids.js`'s small pure SHA-256, because the authorization fold and `openOp`'s post-decrypt
 * identity check both need it inside code the contracts type as returning a value, not a promise.
 * Re-exported here so `src/js/crypto/` has a single spelling of it.
 * @param {Uint8Array} rawSigPub 65 bytes
 * @returns {string} 16 Crockford characters
 */
export const deviceShortOf = deviceShortOfRawBytes;

/**
 * The same, from the b64url spelling that travels in `DeviceAttestation.sigPubRaw`.
 *
 * Returns `null` — never throws — on anything malformed, because every caller of this is looking
 * at PEER data. External input is refused, not thrown on. (`openOp`'s P2 and `attestOpen`'s P2
 * are both this call, and both must be able to say "no" rather than crash a sync pass.)
 * @param {string} sigPubRawB64u
 * @returns {string|null}
 */
export function deviceShortOfB64u(sigPubRawB64u) {
  let raw;
  try {
    raw = ub64(sigPubRawB64u);
  } catch (err) {
    if (err instanceof CodecError) return null;
    throw err;
  }
  if (raw.length !== RAW_PUBKEY_BYTES) return null;
  return deviceShortOfRawBytes(raw);
}

/**
 * The WebCrypto-backed variant. Same value, computed by the ENGINE's SHA-256 instead of by
 * `core/ids.js`'s hand-rolled one.
 *
 * It exists to be cross-checked against the synchronous form, in both engines, by
 * `tests/tier1/crypto-identity.test.js` and `tests/tier2/crypto-identity.dom.js`. `core/ids.js`
 * carries a ~50-line SHA-256 because the fold may not await; if that implementation ever
 * disagreed with the platform digest, every `deviceShort` in the product would be wrong in a way
 * no unit test of SHA-256 vectors alone would catch — the two would simply be different functions.
 * This makes them one assertion apart.
 * @param {Uint8Array} rawSigPub
 * @param {CryptoPorts} [ports]
 * @returns {Promise<string>}
 */
export async function deviceShortOfAsync(rawSigPub, ports) {
  const bytes = asBytes(rawSigPub);
  const digest = new Uint8Array(await subtleOf(ports).digest('SHA-256', bytes));
  return deviceShortOfRawBytes(bytes, () => digest);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Signing — with rule 1 and rule 2 attached
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RULE 2 is enforced (`assertSignable`). RULE 1 is a property of the OUTPUT and cannot be
 * enforced here, so it is stated where a caller will read it:
 *
 *   **WebCrypto ECDSA is non-deterministic in BOTH engines.** Signing the same bytes twice
 *   yields two different signatures. Never compare signature bytes, never use a signature as an
 *   idempotency key, never put one in a content address, and never write a golden-signature
 *   fixture. The only correct assertion about a signature is `verify() === true`.
 *
 * @param {CryptoKey} privateKey
 * @param {Uint8Array} bytes non-empty
 * @param {CryptoPorts} [ports]
 * @returns {Promise<Uint8Array>} 64 bytes, P1363 (r||s) — NOT DER, in both engines
 */
export async function signBytes(privateKey, bytes, ports) {
  assertSignable(asBytes(bytes), 'identity.signBytes');
  return new Uint8Array(await subtleOf(ports).sign(SIGOP, privateKey, asBytes(bytes)));
}

/**
 * @param {CryptoKey} publicKey
 * @param {Uint8Array} signature
 * @param {Uint8Array} bytes non-empty
 * @param {CryptoPorts} [ports]
 * @returns {Promise<boolean>} `false` on a bad signature AND on a malformed one — never a throw,
 *          so no caller is tempted to read an engine's error name (rule 3).
 */
export async function verifyBytes(publicKey, signature, bytes, ports) {
  assertSignable(asBytes(bytes), 'identity.verifyBytes');
  try {
    return await subtleOf(ports).verify(SIGOP, publicKey, asBytes(signature), asBytes(bytes));
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. The device attestation (ADR 002 §2.3)
//
// A device's public keys are trusted ONLY if signed by the owning member's recovery key. The
// blob travels INSIDE the E2EE stream as the family register
//
//     member:<memberId>  ->  dev.<deviceShort>  ->  b64u(canonicalJSON(att)) + '.' + b64u(sig)
//
// a write-once register (ADR 001 §3.1), so a malicious relay cannot fabricate a device row for an
// existing member: it is authored under a key the relay does not hold.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} DeviceAttestation
 * @property {string} memberId
 * @property {string} deviceId    'dev_' + 22 b64url
 * @property {string} deviceShort 16 Crockford base32 (ADR 001 §1.2)
 * @property {string} sigPubRaw   b64url of the 65-byte raw P-256 point
 * @property {string} kexPubRaw   b64url, 65 bytes
 * @property {string} createdAt   'YYYY-MM-DD'
 */

/** The six fields §2.3 fixes, in the order it lists them. */
export const ATTESTATION_FIELDS = Object.freeze([
  'memberId', 'deviceId', 'deviceShort', 'sigPubRaw', 'kexPubRaw', 'createdAt',
]);

/**
 * Build the six-field payload for THIS device. `deviceShort` is DERIVED here — never accepted
 * from a caller — which is the only way §5.2.2's P2 can hold for a blob we mint.
 *
 * `createdAt` is a required argument and not a clock read. Nothing under `src/js/crypto/` may
 * read a clock (ADR 005 §2); the caller supplies the day, and the value is decorative anyway —
 * §2.3's field-by-field enumeration puts `createdAt` in the "covered by the signature, bound to
 * nothing" column, alongside `deviceId`.
 *
 * @param {{memberId:string, deviceId:string, createdAt:string}} who
 * @param {CryptoKey} devSigPub
 * @param {CryptoKey} devKexPub
 * @param {CryptoPorts} [ports]
 * @returns {Promise<DeviceAttestation>}
 */
export async function buildDeviceAttestation(who, devSigPub, devKexPub, ports) {
  const { memberId, deviceId, createdAt } = who || {};
  if (typeof memberId !== 'string' || memberId.length === 0) throw new Error('buildDeviceAttestation: memberId');
  if (typeof deviceId !== 'string' || deviceId.length === 0) throw new Error('buildDeviceAttestation: deviceId');
  if (typeof createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(createdAt)) {
    throw new Error("buildDeviceAttestation: createdAt must be 'YYYY-MM-DD' and is INJECTED, not read from a clock");
  }
  const sigRaw = await exportRawPublic(devSigPub, ports);
  const kexRaw = await exportRawPublic(devKexPub, ports);
  return Object.freeze({
    memberId,
    deviceId,
    deviceShort: deviceShortOfRawBytes(sigRaw),
    sigPubRaw: b64u(sigRaw),
    kexPubRaw: b64u(kexRaw),
    createdAt,
  });
}

/**
 * §5.2.2's **P2**, in pure synchronous form: is `att.deviceShort` really the short of
 * `att.sigPubRaw`?
 *
 * ⚠ WHAT P2 DOES AND DOES NOT BUY — read this before relying on it (finding I-3 / R5-7,
 * `docs/v2/FINDINGS.md` §4.5, OPEN):
 *
 *   P2 makes an attestation SELF-CONSISTENT. It does NOT make `deviceShort -> DeviceAttestation`
 *   a function across the space, because `sigPubRaw` is a **public** key travelling in the
 *   victim's own register, inside the E2EE stream every member can read. A squatter copies it,
 *   tells the truth about it, files it under her own member record, and passes P2 with room to
 *   spare. Any plan of the form "I-3 gets fixed when the attestation binding lands" is wrong.
 *
 * So: this function is worth having — it stops a member inventing a short that has no relation
 * to any key, and it is the check the crypto layer CAN make — and it must not be described as
 * closing I-3. What closes I-3 is a first-claim binding on the PAIR `(sigPubRaw, deviceShort)`
 * at fold time, which is a decision owned by `src/js/core/authz.js` and is not made here.
 *
 * @param {DeviceAttestation} att
 * @returns {boolean}
 */
export function attestationSelfConsistent(att) {
  if (!att || typeof att !== 'object') return false;
  if (!isDeviceShort(att.deviceShort)) return false;
  return deviceShortOfB64u(att.sigPubRaw) === att.deviceShort;
}

/**
 * Sign a `DeviceAttestation` with the member's RECOVERY key.
 *
 * The signature is over `canonicalBytes(att)` — sorted keys, no whitespace, NFC strings, integers
 * only — so that a blob signed on one Mac verifies on the other. `src/js/core/canon.js` is the
 * security boundary that makes that true and its header explains why.
 *
 * Refuses to mint a blob that fails P2. Minting an inconsistent attestation is not a peer's
 * malice, it is our own bug, and a bug is the one thing this file may throw about.
 *
 * @param {DeviceAttestation} att
 * @param {CryptoKey} recSigPriv the member's RK_sig private key
 * @param {CryptoPorts} [ports]
 * @returns {Promise<string>} `b64u(canonicalJSON(att)) + '.' + b64u(sig)`
 */
export async function attestDevice(att, recSigPriv, ports) {
  for (const f of ATTESTATION_FIELDS) {
    if (typeof att?.[f] !== 'string' || att[f].length === 0) {
      throw new Error(`attestDevice: attestation field ${f} is missing or not a string`);
    }
  }
  if (!attestationSelfConsistent(att)) {
    throw new Error(
      'attestDevice: refusing to sign an attestation whose deviceShort is not ' +
      'crock32(SHA-256(sigPubRaw)[0..10]) — that blob could never pass ADR 002 §5.2.2 P2'
    );
  }
  const payload = canonicalBytes({
    memberId: att.memberId,
    deviceId: att.deviceId,
    deviceShort: att.deviceShort,
    sigPubRaw: att.sigPubRaw,
    kexPubRaw: att.kexPubRaw,
    createdAt: att.createdAt,
  });
  const sig = await signBytes(recSigPriv, payload, ports);
  return `${b64u(payload)}.${b64u(sig)}`;
}

/**
 * Verify a `dev.*` register value under the HOUSING member's recovery public key, and return the
 * decoded payload — or `null`.
 *
 * MUST be called before accepting an op from that device AND before wrapping any space key to it
 * (§2.3, §4.2 step 2).
 *
 * FOUR PROPERTIES OF THIS FUNCTION, EACH LOAD-BEARING:
 *
 *  1. **It returns the PAYLOAD, not a boolean.** The attestation is the only source of
 *     `authorSigPub`, so a verifier that answered `true`/`false` would leave `openOp` with
 *     nothing to verify a signature WITH (§5.2.1 correction 1, finding F-10).
 *  2. **It verifies over the ORIGINAL payload bytes**, not over a re-canonicalisation of the
 *     parsed six fields. `parseAttestationBlob` ignores unknown EXTRA fields so a v2.1
 *     attestation stays readable by a v2.0 client; those extra fields are still covered by the
 *     signature, and re-serialising the six would silently drop them and fail every v2.1 blob.
 *  3. **It enforces P2** — raised from SHOULD to MUST on 2026-08-27 (`crypto.contract.js` §2).
 *     The authorization fold cannot: it is pure and synchronous and P2 is a SHA-256. See
 *     `attestationSelfConsistent` above for exactly how much P2 buys, which is less than it
 *     sounds.
 *  4. **It never throws.** A malformed blob from a peer is data, not a bug in this process, and
 *     `null` is a defined outcome at every seam that reads it (§5.2.5: a null attestation PARKS
 *     the sealed envelope, it never rejects it). Throwing would also tempt a caller into reading
 *     an error name, which rule 3 forbids.
 *
 * The caller must pass the housing member's key — the member whose RECORD the register sits in —
 * and never the payload's self-declared `att.memberId`. That is §2.3 condition (4), and getting
 * it wrong turns the whole attestation scheme into a self-signed claim.
 *
 * @param {string} blob
 * @param {CryptoKey} recSigPub the HOUSING member's RK_sig public key
 * @param {CryptoPorts} [ports]
 * @returns {Promise<DeviceAttestation|null>}
 */
export async function verifyAttestation(blob, recSigPub, ports) {
  const att = parseAttestationBlob(blob);
  if (!att) return null;
  if (!attestationSelfConsistent(att)) return null;

  const dot = blob.indexOf('.');
  let payload;
  let sig;
  try {
    payload = ub64(blob.slice(0, dot));
    sig = ub64(blob.slice(dot + 1));
  } catch (err) {
    if (err instanceof CodecError) return null;
    throw err;
  }
  if (payload.length === 0 || sig.length === 0) return null; // rule 2

  const ok = await verifyBytes(recSigPub, sig, payload, ports);
  return ok ? att : null;
}

/**
 * The synchronous closure `foldAuthorized` takes as `ctx.attestOpen` (ADR 001 §4.0, ADR 002
 * §5.2.3). The fold is pure and may not await, so verification must be pre-resolved into a table
 * before the fold runs; this builds the closure over such a table.
 *
 * @param {Map<string, DeviceAttestation|null>} verified keyed by `memberId + '\\n' + blob`, the
 *        exact pair the fold will ask about — the HOUSING member and the register bytes
 * @returns {(memberId:string, blob:string) => DeviceAttestation|null}
 */
export function attestOpenFrom(verified) {
  return (memberId, blob) => verified.get(`${memberId}\n${blob}`) ?? null;
}

/** The key `attestOpenFrom`'s table uses. Exported so the pre-resolver cannot disagree with it. */
export const attestOpenKey = (memberId, blob) => `${memberId}\n${blob}`;

// ─────────────────────────────────────────────────────────────────────────────
// 6. Custody — the identity behind a KeyStore port (ADR 002 §2.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} KeyStore
 * @property {(id:string) => Promise<CryptoKey|CryptoKeyPair|Uint8Array|null>} get
 * @property {(id:string, k:CryptoKey|CryptoKeyPair|Uint8Array) => Promise<void>} put
 * @property {(id:string) => Promise<void>} del
 * @property {() => Promise<string[]>} list
 */

/**
 * The record ids. Namespaced, because the same store also holds space keys (LZP-303) and the
 * `WrapBlob`s the key ring is rebuilt from.
 */
export const KEYSTORE_IDS = Object.freeze({
  devSig: 'lzp/v2/dev/sig',
  devKex: 'lzp/v2/dev/kex',
  devMeta: 'lzp/v2/dev/meta',
  recSig: 'lzp/v2/rec/sig',
  recKex: 'lzp/v2/rec/kex',
  recMeta: 'lzp/v2/rec/meta',
  dek: 'lzp/v2/device/dek',
});

/**
 * @typedef {Object} Identity
 * @property {string} memberId
 * @property {string} deviceId
 * @property {string} deviceShort
 * @property {string} createdAt
 * @property {CryptoKeyPair} devSig
 * @property {CryptoKeyPair} devKex
 * @property {CryptoKeyPair} [recSig]
 * @property {CryptoKeyPair} [recKex]
 */

const TD = new TextDecoder('utf-8', { fatal: true });

function decodeMeta(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  try {
    const v = JSON.parse(TD.decode(bytes));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Read this machine's device identity, or mint it once.
 *
 * IDEMPOTENT, AND DELIBERATELY BRITTLE ABOUT PARTIAL STATE. Three records make one identity
 * (`devSig`, `devKex`, `devMeta`). All three present and agreeing ⇒ return it. None present ⇒
 * mint. **Anything in between throws**, and that is the right answer rather than a convenience:
 * silently regenerating over a half-written store would mint a SECOND device identity for a Mac
 * that already has an attested one — a new `deviceShort`, a new attestation the member must
 * re-sign, and every op the old short authored suddenly authored by a device nobody attested.
 * A loud failure the user can be told about ("dieser Mac muss neu gekoppelt werden") is strictly
 * better than a device that quietly forks its own identity.
 *
 * Called at the family opt-in moment and nowhere else. In solo mode this function is never
 * reached, so no key is ever generated (§2.4).
 *
 * @param {KeyStore} ks
 * @param {string} memberId
 * @param {{deviceId?:string, createdAt?:string} & CryptoPorts} [opts] `deviceId` and `createdAt`
 *        are required only on the minting path; both are injected, never derived from a clock.
 * @returns {Promise<Identity>}
 */
export async function ensureDeviceIdentity(ks, memberId, opts = {}) {
  assertKeyStore(ks, 'ensureDeviceIdentity');
  if (typeof memberId !== 'string' || memberId.length === 0) {
    throw new Error('ensureDeviceIdentity: memberId is required');
  }

  const [devSig, devKex, metaBytes] = await Promise.all([
    ks.get(KEYSTORE_IDS.devSig),
    ks.get(KEYSTORE_IDS.devKex),
    ks.get(KEYSTORE_IDS.devMeta),
  ]);
  const present = [devSig, devKex, metaBytes].filter((v) => v !== null && v !== undefined).length;

  if (present === 3) {
    const meta = decodeMeta(metaBytes);
    if (!meta) {
      throw new Error(
        'ensureDeviceIdentity: the stored device metadata is unreadable. Refusing to mint a ' +
        'second identity over it — this Mac must be re-paired.'
      );
    }
    if (meta.memberId !== memberId) {
      throw new Error(
        `ensureDeviceIdentity: this device already belongs to member ${meta.memberId}. ` +
        'A device identity is never re-pointed at a different member; mint a new one.'
      );
    }
    const sigRaw = await exportRawPublic(devSig.publicKey, opts);
    const short = deviceShortOfRawBytes(sigRaw);
    if (short !== meta.deviceShort) {
      throw new Error(
        'ensureDeviceIdentity: the stored deviceShort is not the short of the stored signing ' +
        'key. The store is corrupt; re-pairing is the only safe answer.'
      );
    }
    return Object.freeze({
      memberId,
      deviceId: meta.deviceId,
      deviceShort: meta.deviceShort,
      createdAt: meta.createdAt,
      devSig,
      devKex,
    });
  }

  if (present !== 0) {
    throw new Error(
      `ensureDeviceIdentity: the key store holds ${present} of the 3 device records. ` +
      'Refusing to regenerate over a partial identity — see this function\'s header.'
    );
  }

  const { deviceId, createdAt } = opts;
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    throw new Error('ensureDeviceIdentity: minting needs an injected deviceId (core/ids.js deviceId())');
  }
  if (typeof createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(createdAt)) {
    throw new Error("ensureDeviceIdentity: minting needs an injected createdAt, 'YYYY-MM-DD'");
  }

  const pairs = await generateDeviceKeys(opts);
  const sigRaw = await exportRawPublic(pairs.devSig.publicKey, opts);
  const deviceShort = deviceShortOfRawBytes(sigRaw);

  // Keys first, metadata last. If the process dies mid-write the store is PARTIAL, which the
  // branch above turns into a loud error — never into a silently regenerated second identity.
  await ks.put(KEYSTORE_IDS.devSig, pairs.devSig);
  await ks.put(KEYSTORE_IDS.devKex, pairs.devKex);
  await ks.put(KEYSTORE_IDS.devMeta, canonicalBytes({ memberId, deviceId, deviceShort, createdAt }));

  return Object.freeze({ memberId, deviceId, deviceShort, createdAt, devSig: pairs.devSig, devKex: pairs.devKex });
}

/**
 * Read the member's recovery identity, or mint it once. Same partial-state discipline as
 * `ensureDeviceIdentity`, for a stronger reason: §8.12 records that the recovery key has **no
 * revocation**. Regenerating it silently would orphan the member from their own Familienkreis
 * with no way back and no way to notice.
 *
 * @param {KeyStore} ks
 * @param {string} memberId
 * @param {{createdAt?:string} & CryptoPorts} [opts]
 * @returns {Promise<{memberId:string, createdAt:string, recSig:CryptoKeyPair, recKex:CryptoKeyPair}>}
 */
export async function ensureRecoveryIdentity(ks, memberId, opts = {}) {
  assertKeyStore(ks, 'ensureRecoveryIdentity');
  if (typeof memberId !== 'string' || memberId.length === 0) {
    throw new Error('ensureRecoveryIdentity: memberId is required');
  }

  const [recSig, recKex, metaBytes] = await Promise.all([
    ks.get(KEYSTORE_IDS.recSig),
    ks.get(KEYSTORE_IDS.recKex),
    ks.get(KEYSTORE_IDS.recMeta),
  ]);
  const present = [recSig, recKex, metaBytes].filter((v) => v !== null && v !== undefined).length;

  if (present === 3) {
    const meta = decodeMeta(metaBytes);
    if (!meta) throw new Error('ensureRecoveryIdentity: the stored recovery metadata is unreadable');
    if (meta.memberId !== memberId) {
      throw new Error(
        `ensureRecoveryIdentity: this store holds the recovery identity of ${meta.memberId}. ` +
        'A recovery key is the member; it is never re-pointed.'
      );
    }
    return Object.freeze({ memberId, createdAt: meta.createdAt, recSig, recKex });
  }
  if (present !== 0) {
    throw new Error(
      `ensureRecoveryIdentity: the key store holds ${present} of the 3 recovery records. ` +
      'Refusing to regenerate: a recovery key cannot be revoked (ADR 002 §8.12).'
    );
  }

  const { createdAt } = opts;
  if (typeof createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(createdAt)) {
    throw new Error("ensureRecoveryIdentity: minting needs an injected createdAt, 'YYYY-MM-DD'");
  }

  const pairs = await generateRecoveryKeys(opts);
  await ks.put(KEYSTORE_IDS.recSig, pairs.recSig);
  await ks.put(KEYSTORE_IDS.recKex, pairs.recKex);
  await ks.put(KEYSTORE_IDS.recMeta, canonicalBytes({ memberId, createdAt }));

  return Object.freeze({ memberId, createdAt, recSig: pairs.recSig, recKex: pairs.recKex });
}

/**
 * Mint and self-attest in one call — the shape §6.3 step 8 and §7.3 step 4 both need: a new Mac
 * restores `RK_sig`, mints its OWN non-extractable device keys, and self-attests with the
 * restored recovery key.
 *
 * @param {KeyStore} ks
 * @param {string} memberId
 * @param {CryptoKey} recSigPriv
 * @param {{deviceId:string, createdAt:string} & CryptoPorts} opts
 * @returns {Promise<{identity:Identity, attestation:DeviceAttestation, blob:string}>}
 */
export async function ensureAttestedDevice(ks, memberId, recSigPriv, opts) {
  const identity = await ensureDeviceIdentity(ks, memberId, opts);
  const attestation = await buildDeviceAttestation(
    { memberId, deviceId: identity.deviceId, createdAt: identity.createdAt },
    identity.devSig.publicKey,
    identity.devKex.publicKey,
    opts
  );
  const blob = await attestDevice(attestation, recSigPriv, opts);
  return { identity, attestation, blob };
}

function assertKeyStore(ks, who) {
  for (const m of ['get', 'put', 'del', 'list']) {
    if (typeof ks?.[m] !== 'function') {
      throw new Error(`${who}: the KeyStore port must implement get/put/del/list (missing ${m})`);
    }
  }
}
