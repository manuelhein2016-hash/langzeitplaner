// docs/v2/contracts/crypto.contract.js
//
// INTERFACE CONTRACT — crypto. Normative for ADR 002.
// Suite: LZP-CRYPTO-1 — ECDSA P-256/SHA-256 · ECDH P-256 → HKDF-SHA-256 → AES-256-GCM
//        · AES-256-GCM (tagLength 128, non-empty AAD) · PBKDF2-SHA-256 600k for the backup.
// WebCrypto only. Zero dependencies. macOS floor stays 12.0.
//
// HARD RULES (ADR 002 §1) that this contract encodes:
//   · never compare signature bytes — ECDSA is non-deterministic in BOTH engines
//   · never sign or verify a zero-length payload
//   · never branch on error NAMES (Node and WebKit disagree)
//   · HkdfParams.salt is mandatory; pass new Uint8Array(0) if you mean none
//   · import a peer's ECDH public key with keyUsages: []
//   · never AES-KW a P-256 private key (138 B PKCS#8) — always AES-GCM

/* eslint-disable no-unused-vars */

// ─────────────────────────────────────────────────────────────────────────────
// 0. Suite constants
// ─────────────────────────────────────────────────────────────────────────────

/** generateKey / importKey params */
export const SIG = Object.freeze({ name: 'ECDSA', namedCurve: 'P-256' });
/** sign / verify params — DIFFERENT SHAPE from SIG. A classic source of bugs. */
export const SIGOP = Object.freeze({ name: 'ECDSA', hash: 'SHA-256' });
export const KEX = Object.freeze({ name: 'ECDH', namedCurve: 'P-256' });
export const AEAD = Object.freeze({ name: 'AES-GCM', length: 256, tagLength: 128, ivBytes: 12 });
export const KDF = Object.freeze({ name: 'HKDF', hash: 'SHA-256' });
export const BACKUP_KDF = Object.freeze({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600000 });

/** Plaintext is padded to a multiple of this before encryption (ADR 002 §5.3). */
export const PAD_BUCKET = 256;

/** HKDF info labels. These strings are part of the wire format. Do not change one casually. */
export const INFO = Object.freeze({
  spaceKeyWrap: 'lzp/v2/space-key-wrap',
  pairRid: 'lzp/v2/pair/rid',
  pairCk: 'lzp/v2/pair/ck',
  pairSas: 'lzp/v2/pair/sas',
  pairKek: 'lzp/v2/pair/kek',
  inviteId: 'lzp/v2/invite/id',
  inviteVerify: 'lzp/v2/invite/verify',
  // inviteWrap RETIRED by PO decision D9 — invites carry no key material.
  backup: 'lzp/v2/backup',
  deviceDek: 'lzp/v2/device/dek',
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Capability probe  (ADR 002 §9.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ~1 ms. A GUARD, not a gate: it runs at the moment the user first touches
 * "Familienkreis erstellen / beitreten" or "Gerät koppeln" — NEVER in solo mode and
 * NEVER on first run (Principle 7, story 15.1).
 * @returns {Promise<{ok:boolean, why?:string, aesgcm?:boolean, hkdf?:boolean,
 *                     pbkdf2?:boolean, ecdsa?:boolean, ecdh?:boolean}>}
 */
export async function probeCrypto() { throw new Error('not implemented'); }

// ─────────────────────────────────────────────────────────────────────────────
// 2. Key custody  (ADR 002 §2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} KeyStore
 * @property {(id:string) => Promise<CryptoKey|CryptoKeyPair|Uint8Array|null>} get
 * @property {(id:string, k:CryptoKey|CryptoKeyPair|Uint8Array) => Promise<void>} put
 * @property {(id:string) => Promise<void>} del
 * @property {() => Promise<string[]>} list
 */

/** WebKit: structured-cloned non-extractable CryptoKeys in IndexedDB. @returns {KeyStore} */
export function idbKeyStore() { throw new Error('not implemented'); }
/** Dev/browser: AES-GCM-wrapped PKCS#8 in Application Support under the Keychain DEK. */
export function fileKeyStore(storage) { throw new Error('not implemented'); }
/** Node/CI: in memory. Node 22 has no indexedDB — this asymmetry is explicit in LZP-1005. */
export function memKeyStore() { throw new Error('not implemented'); }

/**
 * @typedef {Object} Identity
 * @property {string} memberId
 * @property {string} deviceId
 * @property {string} deviceShort
 * @property {CryptoKeyPair} devSig   ECDSA P-256, extractable:false — the private bytes never
 *                                    enter the JS heap
 * @property {CryptoKeyPair} devKex   ECDH P-256, extractable:false
 * @property {CryptoKeyPair} [recSig] ECDSA P-256, extractable:true — Keychain + backup only
 * @property {CryptoKeyPair} [recKex] ECDH P-256, extractable:true
 */

/** Generates NOTHING in solo mode. @param {KeyStore} ks @returns {Promise<Identity>} */
export async function ensureDeviceIdentity(ks, memberId) { throw new Error('not implemented'); }
/** @param {KeyStore} ks @returns {Promise<Identity>} */
export async function ensureRecoveryIdentity(ks, memberId) { throw new Error('not implemented'); }

/**
 * @typedef {Object} DeviceAttestation
 * @property {string} memberId @property {string} deviceId @property {string} deviceShort
 * @property {string} sigPubRaw  b64url of the 65-byte raw P-256 point
 * @property {string} kexPubRaw  b64url, 65 bytes
 * @property {string} createdAt  'YYYY-MM-DD'
 */

/**
 * Signed by the member's RECOVERY key. Travels inside the E2EE stream as the register
 * `member:<memberId>` → `dev.<deviceShort>`, so a malicious relay cannot fabricate a device row
 * for an existing member.
 * @returns {Promise<string>} b64u(canonicalJSON(att)) + '.' + b64u(sig)
 */
export async function attestDevice(att, recSigPriv) { throw new Error('not implemented'); }

/**
 * MUST be called before accepting an op from that device AND before wrapping any space key to it.
 * @param {string} blob @param {CryptoKey} recSigPub
 * @returns {Promise<DeviceAttestation|null>} null on any failure — never throw-and-branch on names
 */
export async function verifyAttestation(blob, recSigPub) { throw new Error('not implemented'); }

// ─────────────────────────────────────────────────────────────────────────────
// 3. Space keys and epochs  (ADR 002 §3, §4)
// ─────────────────────────────────────────────────────────────────────────────

/** @typedef {{v:1, salt:string, iv:string, ct:string}} WrapBlob  ~156 B of JSON, verified */

/** @returns {Promise<CryptoKey>} AES-256-GCM, from crypto.getRandomValues(32) */
export async function createSpaceKey() { throw new Error('not implemented'); }

/** ECDH → HKDF(salt=32 random, info=INFO.spaceKeyWrap) → AES-GCM KEK → wrapKey('raw'). */
export async function wrapSpaceKey(spaceKey, myKexPriv, theirKexPub) { throw new Error('not implemented'); }
/** @returns {Promise<CryptoKey>} */
export async function unwrapSpaceKey(blob, myKexPriv, theirKexPub) { throw new Error('not implemented'); }

/** @typedef {{deviceId:string, kexPubRaw:Uint8Array, attestation:string}} Recipient */

/**
 * ONLY my own devices + my recovery key. Hard-coded scope: this function must never be able to
 * take a family member list. Barrier 2 of ADR 002 §3.
 * @param {Identity} identity @returns {Recipient[]}
 */
export function personalRecipients(identity) { throw new Error('not implemented'); }
/** Every non-removed member's attested, non-revoked devices. @returns {Recipient[]} */
export function familyRecipients(members) { throw new Error('not implemented'); }

/** @param {Recipient[]} recipients @returns {Promise<Array<{deviceId:string, wrapped:WrapBlob}>>} */
export async function wrapToRecipients(spaceKey, myKexPriv, recipients) { throw new Error('not implemented'); }

/**
 * @typedef {Object} KeyRing
 * @property {(space:string, epoch:number) => CryptoKey|null} get
 * @property {(space:string, epoch:number, k:CryptoKey) => void} put
 * @property {(space:string) => number} currentEpoch
 * @property {(space:string) => number[]} epochs   clients RETAIN every epoch they ever held
 */
/** @param {KeyStore} ks @returns {Promise<KeyRing>} */
export async function loadKeyRing(ks) { throw new Error('not implemented'); }

/**
 * Rotation, performed by the member whose action caused it (joiner on join, admin on remove).
 * Steps: mint → VERIFY every recipient's attestation → wrap to all → re-wrap every OPEN invite
 * blob → one atomic POST. The server rejects a bump whose wraps do not cover every current
 * non-revoked device (ADR 002 §4.2), and `@@unique([spaceId, epoch])` makes it first-writer-wins.
 * @returns {Promise<{epoch:number, wraps:Array<{deviceId:string, wrapped:WrapBlob}>,
 *                    invites:Array<{id:string}>}>}   // no wrappedKeys — D9
 */
export async function buildRotation(spaceId, nextEpoch, spaceKeysByEpoch, myKexPriv,
                                    recipients, openInvites) { throw new Error('not implemented'); }

// ─────────────────────────────────────────────────────────────────────────────
// 4. The op envelope  (ADR 002 §5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Envelope
 * @property {1}      v
 * @property {string} sp   spaceId
 * @property {number} ep   key epoch
 * @property {string} dv   deviceShort of the author
 * @property {string} oid  opId — random, NO time component; the server idempotency key
 * @property {string} wit  chain witness; '' on the first push (diagnostic only)
 * @property {string} iv   b64url, 12 bytes
 * @property {string} ct   b64url, AES-256-GCM over the PADDED plaintext
 * @property {string} sig  b64url, ECDSA P-256/SHA-256 over aad ‖ iv ‖ ct
 */

/** AAD = TE.encode(JSON.stringify(['lzp/v2/op', v, sp, ep, dv, oid, wit])). ALWAYS non-empty. */
export function aadOf(hdr) { throw new Error('not implemented'); }

/**
 * Seal one op.
 * SECURITY: for a family space this MUST
 *   (a) refuse an unbranded patch (only projectForFamily produces a branded one), and
 *   (b) RE-DERIVE the level from the authenticated register map — never trust a caller-supplied
 *       level — before running assertFamilyPatch (ADR 004 §2.2 barriers 3 and 4).
 * @param {Object} op @param {KeyRing} keyring @param {CryptoKey} sigPriv
 * @param {{v:1, sp:string, ep:number, dv:string, oid:string, wit:string}} hdr
 * @returns {Promise<Envelope>}
 */
export async function sealOp(op, keyring, sigPriv, hdr) { throw new Error('not implemented'); }

/**
 * [AMENDED 2026-08-27 — ADR 002 §5.2 was rewritten; this signature changed with it.]
 *
 * PRE-DECRYPT GATE, in this order (§5.2.2):
 *   P1  att = attestationOf(env.dv); att === null  → the caller PARKS THE SEALED ENVELOPE,
 *       unopened (ADR 001 §7.4). It is not a rejection: there is no causal delivery, so an op
 *       overtaking its own attestation is ordinary. `att` is ALSO the only source of the
 *       verification key, which is why this cannot be a post-decrypt check.
 *   P2  deviceShortOf(att.sigPubRaw) === env.dv        // the short is self-certifying, §1.2
 *   P3  verify(sig, aad ‖ iv ‖ ct, att.sigPubRaw)      // VERIFY BEFORE DECRYPT
 *   P4  keyring holds epoch env.ep                     // else the caller PARKS (§4)
 *
 * POST-DECRYPT, all five, throw on any mismatch:
 *   1 op.id === env.oid · 2 op.space === env.sp · 3 att.deviceId === op.dev
 *   4 devOf(op.ts) === env.dv · 5 att.memberId === op.act
 * 3 replaces the impossible `deviceShort(op.dev) === env.dv`; 5 replaces `memberOf(env.dv)`;
 * 4 is new and not optional (it is what keeps ADR 001 §6.2's total order attributable).
 * Without these, `op.act` — which 17.6 renders as "von Mama" — is forgeable.
 *
 * @param {Envelope} env @param {KeyRing} keyring
 * @param {(dv:string) => DeviceAttestation|null} attestationOf  from AuthzResult (OWED — F-10)
 * @returns {Promise<Object>} the Op
 * @throws on bad signature, wrong key, or any identity mismatch. Missing epoch and a null
 *         attestation are NOT throws — they are parks, signalled to the caller.
 */
export async function openOp(env, keyring, attestationOf) { throw new Error('not implemented'); }

/** varint(len) ‖ utf8(canonicalJSON(op)) ‖ zeros, to a multiple of PAD_BUCKET. */
export function pad(plaintextBytes) { throw new Error('not implemented'); }
/** @returns {Uint8Array} */
export function unpad(paddedBytes) { throw new Error('not implemented'); }

// ─────────────────────────────────────────────────────────────────────────────
// 5. Pairing  (ADR 002 §6) — 19.5
// ─────────────────────────────────────────────────────────────────────────────

/** 12 Crockford base32 chars = 60 bits, displayed XXXX-XXXX-XXXX. @returns {string} */
export function generatePairingCode() { throw new Error('not implemented'); }
/** rid = b64u(HKDF(code, '', INFO.pairRid, 16)) — derived from the WHOLE code, so the relay's
 *  offline work factor is the full 2^60. @returns {Promise<{rid:string, ck:CryptoKey}>} */
export async function derivePairing(code) { throw new Error('not implemented'); }

/**
 * @typedef {Object} PairingSession
 * @property {() => Promise<{rid:string, boxA:string, code:string}>} beginAsExisting
 * @property {(code:string, boxA:string) => Promise<{boxB:string}>} answerAsNew
 * @property {(boxB:string) => Promise<{sas:string}>} confirmExisting  → 6 decimal digits
 * @property {() => Promise<{sas:string}>} confirmNew                  → 6 decimal digits
 * @property {(payload:Object) => Promise<string>} deliver   AES-GCM under HKDF(S,…,pairKek)
 * @property {(blob:string) => Promise<Object>} receive
 */
/**
 * Transport-agnostic; the fleet suite drives it through tests/helpers/mitm.js.
 * THE SAS IS THE MITM DEFENCE, NOT THE CODE. It is shown on BOTH screens, confirmed on BOTH,
 * never skippable and never defaulted to „Ja". An agent who auto-confirms on successful
 * decryption has removed the only MITM defence in the product.
 * @returns {PairingSession}
 */
export function createPairingSession(identity, keyring) { throw new Error('not implemented'); }

// ─────────────────────────────────────────────────────────────────────────────
// 6. Invites  (ADR 002 §7.1) — 15.3, 15.5
// ─────────────────────────────────────────────────────────────────────────────

/** 12 Crockford chars = 60 bits. @returns {string} */
export function generateInviteCode() { throw new Error('not implemented'); }

/**
 * The raw code NEVER reaches the server.
 * @param {string} code
 * @returns {Promise<{inviteId:string, verifier:Uint8Array, wrapKey:CryptoKey}>}
 */
export async function deriveInvite(code) { throw new Error('not implemented'); }

/**
 * Wraps EVERY epoch key 1..e, so a joiner can read the history — Oma's birthday entered in epoch
 * 1 must be visible to a member who joins in epoch 5 (A4, 17.1). Refreshed on every rotation.
 * @param {Map<number, CryptoKey>} epochKeys @param {CryptoKey} wrapKey @param {Uint8Array} salt
 * @returns {Promise<string>} b64url
 */
export async function sealInviteKeys(epochKeys, wrapKey, salt) { throw new Error('not implemented'); }
/** @returns {Promise<Map<number, CryptoKey>>} */
export async function openInviteKeys(blob, wrapKey, salt) { throw new Error('not implemented'); }

// ─────────────────────────────────────────────────────────────────────────────
// 7. Backup / recovery  (ADR 002 §7.2, §7.3) — A2, LZP-305
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} BackupV2
 * @property {string} _README_de @property {string} _README_en
 * @property {'langzeitplaner-backup'} format @property {2} v
 * @property {string} exportedAt @property {string} app
 * @property {Object} board       materialized v1-shape state, MY entries only (A2)
 * @property {{ kdf:Object, memberId:string, sealed:string }} [identity]
 *           AES-256-GCM over canonicalJSON({recSigPkcs8, recKexPkcs8, personal, family}).
 *           OMITTED ENTIRELY when no passphrase is given. NEVER written in plaintext.
 */

/**
 * @param {Object} board @param {Identity} identity @param {Object} spaces
 * @param {string|null} passphrase  null ⇒ the `identity` block is OMITTED, not plaintext.
 *        The export sheet offers two explicit buttons and states the consequence of each;
 *        A2's own wording is conditional ("if the keys are present").
 * @returns {Promise<BackupV2>}
 */
export async function exportBackup(board, identity, spaces, passphrase) { throw new Error('not implemented'); }

/**
 * Import: unwrap → MINT FRESH non-extractable device keys for this machine (never restore a
 * device identity; a device is a machine, not a person) → self-attest with the restored recovery
 * key → POST /devices/adopt signed by RK_sig → pull from seq 0.
 * @param {BackupV2} file @param {string|null} passphrase @param {KeyStore} ks
 * @returns {Promise<{board:Object, identity:Identity|null, spaces:Object|null}>}
 */
export async function importBackup(file, passphrase, ks) { throw new Error('not implemented'); }

// ─────────────────────────────────────────────────────────────────────────────
// 8. Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** @param {ArrayBuffer|Uint8Array} b @returns {string} */
export function b64u(b) { throw new Error('not implemented'); }
/** @param {string} s @returns {Uint8Array} */
export function ub64(s) { throw new Error('not implemented'); }
/** @param {Uint8Array} b @returns {string} Crockford base32 */
export function crock32(b) { throw new Error('not implemented'); }
/** Sorted keys, no whitespace, NFC strings, integers only. @param {any} v @returns {string} */
export function canonicalJSON(v) { throw new Error('not implemented'); }
