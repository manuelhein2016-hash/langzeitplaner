// src/js/crypto/spacekeys.js — space keys, wrapping, and rotation epochs.  LZP-303 · ADR 002 §3, §4.
//
// DOM-free, I/O-free, dependency-free (ADR 005 §2). The CSPRNG, the SubtleCrypto and the key
// STORE all arrive as injected ports; nothing here reads a clock, opens a database or touches a
// global other than `globalThis.crypto` (and that only through `identity.js`'s lazy resolver).
//
// ═════════════════════════════════════════════════════════════════════════════
// TWO SPACES THAT CAN NEVER SUBSTITUTE FOR ONE ANOTHER  (ADR 002 §3, stories 19.4, 20.5, 21.2)
// ═════════════════════════════════════════════════════════════════════════════
//
//   PSK    AES-256-GCM 256-bit, per epoch   PERSONAL space `psp_…`. One per member, my own
//                                           devices only. Carries EVERYTHING: Privat entries,
//                                           the Belegt/Geteilt source entries, categories,
//                                           scratchpads, tombstones.
//   FSK_e  AES-256-GCM 256-bit, per epoch   FAMILY space `fsp_…`. Every current, attested member
//                                           device. Carries only `pub.*` projections and the
//                                           `member:` / `space:` records.
//
// **Story 20.5 — „even the admin cannot read another member's private entries" — is enforced
// here or nowhere, and it is enforced BY CONSTRUCTION rather than by policy.** Four barriers,
// three of which live in this file:
//
//   1. KEY SEPARATION. `createSpaceKey()` draws 32 bytes from the CSPRNG. There is no derivation
//      path between a `PSK` and an `FSK_e` — not a KDF, not a shared parent, no master key, and
//      deliberately no relationship to the Keychain `DEK` either. Holding every family key gives
//      **zero** information about any personal key.
//   2. TRANSPORT SEPARATION, **IN BOTH DIRECTIONS**. `personalRecipients()` and
//      `familyRecipients()` are two functions with non-overlapping, hard-coded scopes, and
//      neither can take the other's list: `personalRecipients` REFUSES a device belonging to any
//      member but me, and every recipient carries a non-enumerable brand naming the space kind it
//      may be wrapped for. `wrapToRecipients` refuses an unbranded or wrongly-branded recipient,
//      so a hand-rolled object literal cannot slip past the two constructors. (ADR 002 §11 rule
//      10.)  **The same two lists are the admissible SENDER sets** — `admissibleSenders()` turns
//      one into the only thing `admitWraps` will derive a KEK against (§6b, finding S1). The set
//      of devices entitled to RECEIVE a space key and the set entitled to DELIVER it are the same
//      set, so barrier 2 needed no second list, only a second direction.
//   3. DOMAIN SEPARATION IN THE CRYPTOGRAPHY ITSELF, twice over and independently:
//        · the HKDF salt is `wireSalt ‖ canonicalJSON([kind, spaceId, epoch])`, so the KEK that
//          wraps `FSK_3` is a DIFFERENT KEY from the KEK that wraps `PSK_3` even for the same
//          ECDH pair and the same 32 random wire bytes; and
//        · the AES-GCM AAD carries the same triple, so a wrap blob lifted from one space into
//          the other fails the tag rather than producing a key.
//      The **space kind is an authenticated type tag** in both. Neither binding is carried in the
//      blob — both sides reconstruct it from context they already hold, which is what makes a
//      disagreement a decryption failure instead of a negotiation.
//   4. REDACTION AT SOURCE, above all three: a Privat entry never produces a family-space op at
//      all. That barrier is ADR 004's and lives in `projectForFamily()`.
//
// The admin role is a COORDINATION role over the op log. There is no crypto path from admin to
// anyone's `PSK`, and this file contains no role parameter of any kind — see D9 below.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE ROTATION GUARANTEE, STATED EXACTLY — the UI copy is written from these lines
// (ADR 002 §4, §7.4, §8.1 · addendum §6 · stories 20.2, 20.3, 20.5 · deliverable 22)
// ═════════════════════════════════════════════════════════════════════════════
//
//   A new epoch is minted on EVERY membership change — join, remove, leave (and on every
//   personal-space device pair/unpair). From the moment epoch `e+1` exists, a removed member
//   decrypts NOTHING that is sealed under it. That is what rotation buys.
//
//   A removed member keeps every op they had ALREADY PULLED and every epoch key `1..e` they had
//   already been given. Forever, on their own machine. Their existing wraps are deleted from the
//   relay, which stops them fetching more; it does not reach the copies on their disk. Rotation
//   buys FUTURE confidentiality and NOTHING ELSE.
//
//   **Unsharing is not unremembering.** The removal confirmation must therefore say, in German
//   first and without hedging:
//
//       „Ab jetzt sieht Mama nichts Neues mehr. Was ihr Mac schon geladen hat, bleibt auf ihrem
//        Mac — geteilt ist geteilt."
//
//   and it must NEVER say „gelöscht bei allen", „zurückgezogen", „niemand kann es mehr sehen",
//   or „live". The crypto cannot make any of those true and the UI may not imply them.
//
//   The join/removal asymmetry is deliberate and must not be "fixed" (ADR 002 §4.3): a JOINING
//   member is granted **all epochs 1..e+1**, because Oma's birthday entered in epoch 1 has to
//   render on the Mac of someone who joined in epoch 7 (A4, 17.1, risk R11). A wrap that covers
//   only the current epoch is a BUG — `buildRotation` and `wrapRingTo` refuse to build one, and
//   the relay enforces the same coverage independently (§4.2).
//
// ═════════════════════════════════════════════════════════════════════════════
// PO DECISION D9 — AN INVITE CARRIES NO KEY MATERIAL. ADMISSION AND DELIVERY ARE SEPARATE.
// ═════════════════════════════════════════════════════════════════════════════
//
// No epoch key is attached to an invite, stored against one on the relay, or derivable from an
// invite code; `suite.js` throws by name on the retired `lzp/v2/invite/wrap` label. Redemption
// makes the joiner a MEMBER; key delivery is a separate act performed by **any existing member
// device on its next ordinary sync — not only the admin's** (ADR 002 §7.1 step 4, which amends
// `DESIGN-DECISIONS.md` D9's "the admin's device must be online"; gating on the admin alone would
// make a two-person family depend on one sleeping laptop).
//
// That is why **nothing in this file takes a role, an `isAdmin` flag, or an admin member id.**
// `wrapRingTo` needs the caller's ECDH private key and the key ring, both of which every member
// device has. If a future change adds a role parameter to any function here, D9's delivery half
// has been quietly re-gated on one machine.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE ENGINE-DIFFERENCE RULES THAT BITE IN THIS FILE  (ADR 002 §1)
// ═════════════════════════════════════════════════════════════════════════════
//
//   RULE 6 — **never AES-KW a P-256 private key.** Nothing here uses AES-KW at all; every wrap is
//     AES-256-GCM. The trap this rule guards is one function away: `wrapKey('raw', spaceKey, …)`
//     over a 32-byte AES key would survive AES-KW, so a prototype written with AES-KW here would
//     work and then fail the moment §7.2 wrapped a 138-byte PKCS#8. There is no AES-KW constant
//     in `suite.js` to reach for, and there is none here.
//   RULE 5 — a peer's ECDH public key is imported with `keyUsages: []`. Always through
//     `identity.importKexPublic`, never by hand.
//   RULE 4 — `HkdfParams.salt` is mandatory; `suite.hkdf(salt, label)` takes it as a required
//     positional argument, so it cannot be forgotten.
//   RULE 3 — no branching on error NAMES. `unwrapSpaceKey` catches at a try/catch BOUNDARY and
//     returns `null`; it never reads `err.name`, because Node says `InvalidAccessException`
//     where WebKit says `InvalidAccessError`.
//   RULE 1 — no signature bytes are compared anywhere. Attestations are checked with
//     `verifyAttestation(...) !== null`.
//
// ═════════════════════════════════════════════════════════════════════════════
// AN HONEST NOTE ON `extractable: true`
// ═════════════════════════════════════════════════════════════════════════════
//
// The device pairs `IK_sig`/`IK_kex` are `extractable: false` — their private bytes never enter
// the JS heap. **A space key cannot be**: `SubtleCrypto.wrapKey` refuses a non-extractable key,
// and every space key must be re-wrappable to every future joiner for as long as the space
// exists (§7.1 step 5). So `createSpaceKey()` and `unwrapSpaceKey()` both produce EXTRACTABLE
// keys, `KeyRing.put` REFUSES a non-extractable one — a ring that accepted one would silently
// lose the ability to onboard the next family member for that epoch — and the honest statement
// of the residual is ADR 002 §8.2: on an unlocked, compromised Mac the space keys are readable.
// Non-extractability was never the barrier that protects the personal space; barriers 1-4 are.

import { b64u, ub64, CodecError } from '../core/b64.js';
import { canonicalBytes } from '../core/canon.js';
import { defaultRandom } from '../core/ids.js';
import {
  SUITE_ID,
  AEAD,
  KDF,
  INFO,
  USAGES,
  SYMMETRIC_KEY_BYTES,
  SALT_BYTES,
  RAW_PUBKEY_BYTES,
  hkdf,
  aesgcm,
} from './suite.js';
import {
  defaultSubtle,
  importKexPublic,
  importSigPublic,
  verifyAttestation,
} from './identity.js';

// ─────────────────────────────────────────────────────────────────────────────
// 0. Ports, and one error type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} CryptoPorts
 * @property {SubtleCrypto} [subtle]
 * @property {(n:number) => Uint8Array} [random]
 */

const subtleOf = (ports) => (ports && ports.subtle) || defaultSubtle();
const randomOf = (ports) => (ports && ports.random) || defaultRandom;

/**
 * Our own bug, or a protocol violation this device must not paper over: a malformed space id, a
 * wrap that does not cover every epoch, a recipient with the wrong brand, an attestation that
 * does not verify.
 *
 * It is a CLASS and not a message convention because rule 3 forbids branching on error names: a
 * caller that needs to distinguish this from an engine error uses `instanceof`, which is stable
 * across both engines, and never `err.name`.
 */
export class SpaceKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpaceKeyError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Space identity — the type tag, derived and never accepted
// ─────────────────────────────────────────────────────────────────────────────

/** The two kinds. There is no third, and no code path that treats an unknown id as either. */
export const SPACE_KIND = Object.freeze({ PERSONAL: 'personal', FAMILY: 'family' });

/** `core/ids.js`'s `spaceId(kind)` prefixes. This file DERIVES the kind; it never takes one. */
export const SPACE_PREFIX = Object.freeze({ personal: 'psp_', family: 'fsp_' });

/** `'psp_' | 'fsp_'` + 22 base64url characters (`core/ids.js` `ID_BYTES` = 16). */
const SPACE_ID_RE = /^(psp|fsp)_[A-Za-z0-9_-]{22}$/;

/** `WrapBlob.v`. A blob carrying any other `v` is refused — versioning, not negotiation. */
export const WRAP_V = 1;

/** Epoch numbering starts at 1. `0` is the sentinel `currentEpoch()` returns for "none held". */
export const FIRST_EPOCH = 1;

/** @param {unknown} v @returns {boolean} */
export function isSpaceId(v) {
  return typeof v === 'string' && SPACE_ID_RE.test(v);
}

/**
 * The authenticated type tag, **derived from the id and never supplied by a caller**.
 *
 * This is the single place the personal/family distinction is computed, and it throws rather
 * than defaulting: a space id we cannot classify must never be treated as either kind, because
 * both branches of the mistake are catastrophic — a personal key wrapped to the Familienkreis,
 * or a family key admitted into the personal ring.
 *
 * @param {string} spaceId
 * @returns {'personal'|'family'}
 * @throws {SpaceKeyError}
 */
export function spaceKindOf(spaceId) {
  if (!isSpaceId(spaceId)) {
    throw new SpaceKeyError(
      `spaceKindOf: ${JSON.stringify(spaceId)} is not a space id. ` +
      "Expected 'psp_' or 'fsp_' + 22 base64url characters (core/ids.js spaceId())."
    );
  }
  return spaceId.startsWith(SPACE_PREFIX.personal) ? SPACE_KIND.PERSONAL : SPACE_KIND.FAMILY;
}

/** @param {unknown} n @returns {boolean} */
function isEpoch(n) {
  return Number.isSafeInteger(n) && n >= FIRST_EPOCH;
}

function assertEpoch(n, who) {
  if (!isEpoch(n)) {
    throw new SpaceKeyError(`${who}: epoch must be a safe integer >= ${FIRST_EPOCH}, got ${JSON.stringify(n)}`);
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Domain separation — the salt and the AAD
//
// Both carry the SAME triple `[kind, spaceId, epoch]` and neither travels in the blob. The
// receiver reconstructs them from context it already holds, so a disagreement about which space
// or which epoch a wrap belongs to is a decryption FAILURE and not a field anyone can rewrite.
// One of the two would be enough; there are two because this is the seam story 20.5 rests on and
// a single point of failure here is a single point of failure for the product's central promise.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The bytes appended to the 32 random wire bytes to form the HKDF salt.
 *
 * HKDF's salt is the standard place for domain separation and it is not required to be secret.
 * Binding here — rather than in the `info` label — is deliberate: `INFO`'s labels are WIRE FORMAT
 * and `suite.infoBytes()` whitelists them, so adding `lzp/v2/space-key-wrap/personal` would be a
 * wire-format change requiring a new ADR. The salt costs nothing and is not on the wire.
 *
 * @param {string} spaceId @param {number} epoch
 * @returns {Uint8Array}
 */
export function wrapSaltContext(spaceId, epoch) {
  const kind = spaceKindOf(spaceId);
  assertEpoch(epoch, 'wrapSaltContext');
  return canonicalBytes([INFO.spaceKeyWrap, WRAP_V, SUITE_ID, kind, spaceId, epoch]);
}

/**
 * The AES-GCM additional data for a space-key wrap. ALWAYS non-empty (`suite.aesgcm` refuses an
 * empty one), and identical in shape to the salt context above — same triple, same order, so a
 * reviewer can see at a glance that the two bindings agree.
 *
 * @param {string} spaceId @param {number} epoch
 * @returns {Uint8Array}
 */
export function wrapAad(spaceId, epoch) {
  return wrapSaltContext(spaceId, epoch);
}

/** `wireSalt(32) ‖ context`. Rule 4's salt, with the domain folded in. */
function saltFor(wireSalt, spaceId, epoch) {
  const ctx = wrapSaltContext(spaceId, epoch);
  const out = new Uint8Array(wireSalt.length + ctx.length);
  out.set(wireSalt, 0);
  out.set(ctx, wireSalt.length);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The space key itself
// ─────────────────────────────────────────────────────────────────────────────

/** The AES-GCM parameters `importKey`/`unwrapKey` want. `AEAD` also carries tag/iv sizes. */
const AES_KEY_ALG = Object.freeze({ name: AEAD.name, length: AEAD.length });

/**
 * A fresh space key: 32 bytes from the CSPRNG, imported as AES-256-GCM.
 *
 * BARRIER 1. Drawn, not derived. There is no parent key, no KDF and no relationship to any other
 * key in the product — including the Keychain `DEK`, which wraps exactly one thing (the recovery
 * identity) and is not a master key. Possessing every family key reveals nothing about any
 * personal key because there is nothing to reveal.
 *
 * EXTRACTABLE — see the header. `wrapKey` requires it, and every epoch key must stay wrappable
 * to every future joiner for as long as the space exists.
 *
 * @param {CryptoPorts} [ports]
 * @returns {Promise<CryptoKey>} AES-256-GCM, extractable, usages `['encrypt','decrypt']`
 */
export async function createSpaceKey(ports) {
  const bytes = randomOf(ports)(SYMMETRIC_KEY_BYTES);
  if (!(bytes instanceof Uint8Array) || bytes.length !== SYMMETRIC_KEY_BYTES) {
    throw new SpaceKeyError(`createSpaceKey: the random port must return ${SYMMETRIC_KEY_BYTES} bytes`);
  }
  const key = await subtleOf(ports).importKey('raw', bytes, AES_KEY_ALG, true, [...USAGES.aead]);
  bytes.fill(0); // the raw material has no further use in this heap
  return key;
}

/**
 * Is this object a usable space key? Checked structurally rather than trusted, because the ring
 * is the one place a wrong key type would go unnoticed until an op failed to decrypt three
 * layers away.
 * @param {unknown} k
 * @returns {string|null} a reason it is NOT, or `null` if it is
 */
function spaceKeyProblem(k) {
  if (!k || typeof k !== 'object') return 'not a CryptoKey';
  if (k.type !== 'secret') return `expected a secret key, got type ${JSON.stringify(k.type)}`;
  const alg = k.algorithm || {};
  if (alg.name !== AEAD.name) return `expected ${AEAD.name}, got ${JSON.stringify(alg.name)}`;
  if (alg.length !== AEAD.length) return `expected a ${AEAD.length}-bit key, got ${JSON.stringify(alg.length)}`;
  const usages = Array.isArray(k.usages) ? k.usages : [];
  for (const u of USAGES.aead) if (!usages.includes(u)) return `missing the '${u}' usage`;
  if (k.extractable !== true) {
    return (
      'a space key must be EXTRACTABLE: SubtleCrypto.wrapKey refuses a non-extractable key and ' +
      'every epoch key must stay re-wrappable to every future joiner (ADR 002 §7.1 step 5)'
    );
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Wrapping — ECDH -> HKDF -> AES-GCM KEK -> wrapKey('raw')
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} WrapBlob
 * @property {1} v
 * @property {string} salt b64url, 32 bytes — the RANDOM half of the HKDF salt; the domain half
 *                         is reconstructed by the receiver and never travels
 * @property {string} iv   b64url, 12 bytes
 * @property {string} ct   b64url, 48 bytes — the 32-byte key plus the 16-byte GCM tag
 */

/**
 * @typedef {Object} WrapContext
 * @property {string} spaceId
 * @property {number} epoch
 * @property {SubtleCrypto} [subtle]
 * @property {(n:number) => Uint8Array} [random]
 */

/** @param {WrapContext} ctx @param {string} who */
function assertWrapContext(ctx, who) {
  if (!ctx || typeof ctx !== 'object') {
    throw new SpaceKeyError(
      `${who}: a {spaceId, epoch} context is REQUIRED. It is the authenticated domain separator ` +
      '(ADR 002 §3 barrier 3) and there is deliberately no default.'
    );
  }
  spaceKindOf(ctx.spaceId);
  assertEpoch(ctx.epoch, who);
  return ctx;
}

/**
 * ECDH -> HKDF-SHA-256 -> AES-256-GCM key-encryption key.
 *
 * @param {CryptoKey} myKexPriv   my ECDH P-256 private key
 * @param {CryptoKey} theirKexPub the peer's ECDH P-256 public key, imported with `keyUsages: []`
 * @param {Uint8Array} wireSalt   the 32 random bytes that travel in the blob
 * @param {string} spaceId @param {number} epoch
 * @param {CryptoPorts} [ports]
 * @returns {Promise<CryptoKey>}
 */
async function deriveKek(myKexPriv, theirKexPub, wireSalt, spaceId, epoch, ports) {
  const S = subtleOf(ports);
  const shared = await S.deriveBits({ name: 'ECDH', public: theirKexPub }, myKexPriv, 256);
  const ikm = await S.importKey('raw', shared, KDF.name, false, ['deriveKey']);
  // RULE 4: the salt is a required positional argument of `suite.hkdf` — it cannot be omitted.
  return S.deriveKey(
    hkdf(saltFor(wireSalt, spaceId, epoch), INFO.spaceKeyWrap),
    ikm,
    AES_KEY_ALG,
    false,
    [...USAGES.kek]
  );
}

/**
 * Wrap one epoch's space key to one recipient's ECDH public key.
 *
 * **The `ctx` argument is not optional and is an amendment to ADR 002 §3's sketch**, which wrote
 * `wrapSpaceKey(spaceKey, myKexPriv, theirKexPub)`. Without the space and the epoch there is
 * nothing to put in the AAD, `suite.aesgcm` refuses an empty one, and barrier 3 does not exist.
 * Neither field enters the blob: the blob stays the verified `{v, salt, iv, ct}` — 156 bytes of
 * JSON — and both sides derive the binding from context they already hold.
 *
 * RULE 6: AES-GCM, never AES-KW.
 *
 * @param {CryptoKey} spaceKey extractable AES-256-GCM
 * @param {CryptoKey} myKexPriv
 * @param {CryptoKey} theirKexPub
 * @param {WrapContext} ctx
 * @returns {Promise<WrapBlob>}
 */
export async function wrapSpaceKey(spaceKey, myKexPriv, theirKexPub, ctx) {
  assertWrapContext(ctx, 'wrapSpaceKey');
  const problem = spaceKeyProblem(spaceKey);
  if (problem) throw new SpaceKeyError(`wrapSpaceKey: ${problem}`);

  const rand = randomOf(ctx);
  const wireSalt = rand(SALT_BYTES);
  const iv = rand(AEAD.ivBytes);
  if (!(wireSalt instanceof Uint8Array) || wireSalt.length !== SALT_BYTES) {
    throw new SpaceKeyError(`wrapSpaceKey: the random port must return ${SALT_BYTES} salt bytes`);
  }
  if (!(iv instanceof Uint8Array) || iv.length !== AEAD.ivBytes) {
    throw new SpaceKeyError(`wrapSpaceKey: the random port must return ${AEAD.ivBytes} iv bytes`);
  }

  const kek = await deriveKek(myKexPriv, theirKexPub, wireSalt, ctx.spaceId, ctx.epoch, ctx);
  const ct = await subtleOf(ctx).wrapKey(
    'raw', spaceKey, kek, aesgcm(iv, wrapAad(ctx.spaceId, ctx.epoch))
  );
  return Object.freeze({ v: WRAP_V, salt: b64u(wireSalt), iv: b64u(iv), ct: b64u(new Uint8Array(ct)) });
}

/**
 * Open a wrap addressed to me, or return `null`.
 *
 * **`null` means "this blob did not open", for EVERY reason, and every reason has the same
 * answer: do not admit a key, keep the ops parked (ADR 002 §4.4).** Not addressed to me; wrong
 * space; wrong epoch; wrong sender; corrupt; hostile; an off-curve point the engine refused.
 * They are deliberately not distinguished, because distinguishing them would mean reading an
 * engine error NAME (rule 3 — Node says `InvalidAccessException` where WebKit says
 * `InvalidAccessError`) and because none of them changes what the caller must do.
 *
 * A malformed ARGUMENT — a bad `ctx`, a missing space id — still throws: that is our bug, not a
 * peer's data, and it is the one thing this function may be loud about.
 *
 * @param {WrapBlob} blob
 * @param {CryptoKey} myKexPriv
 * @param {CryptoKey} theirKexPub the sender's ECDH public key, from their VERIFIED attestation.
 *        Since 2026-08-28 that sentence is ENFORCED rather than documented: the only caller,
 *        `admitWraps`, can obtain this key only from an `admissibleSenders()` set, which imports
 *        it from the bytes `recipientProblem` bound to the attestation (§6b, finding S1).
 * @param {WrapContext} ctx
 * @returns {Promise<CryptoKey|null>} extractable AES-256-GCM, or null
 */
export async function unwrapSpaceKey(blob, myKexPriv, theirKexPub, ctx) {
  assertWrapContext(ctx, 'unwrapSpaceKey');
  const parsed = parseWrapBlob(blob);
  if (!parsed) return null;
  try {
    const kek = await deriveKek(myKexPriv, theirKexPub, parsed.salt, ctx.spaceId, ctx.epoch, ctx);
    const key = await subtleOf(ctx).unwrapKey(
      'raw',
      parsed.ct,
      kek,
      aesgcm(parsed.iv, wrapAad(ctx.spaceId, ctx.epoch)),
      AES_KEY_ALG,
      true,
      [...USAGES.aead]
    );
    return spaceKeyProblem(key) ? null : key;
  } catch {
    // RULE 3: a try/catch BOUNDARY, never an error name.
    return null;
  }
}

/**
 * Decode `{v, salt, iv, ct}` without trusting any of it. Peer data: `null`, never a throw.
 * @param {unknown} blob
 * @returns {{salt:Uint8Array, iv:Uint8Array, ct:Uint8Array}|null}
 */
export function parseWrapBlob(blob) {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return null;
  if (blob.v !== WRAP_V) return null;
  if (typeof blob.salt !== 'string' || typeof blob.iv !== 'string' || typeof blob.ct !== 'string') return null;
  let salt;
  let iv;
  let ct;
  try {
    salt = ub64(blob.salt);
    iv = ub64(blob.iv);
    ct = ub64(blob.ct);
  } catch (err) {
    if (err instanceof CodecError) return null;
    throw err;
  }
  if (salt.length !== SALT_BYTES) return null;
  if (iv.length !== AEAD.ivBytes) return null;
  // 32-byte key + 16-byte tag. A shorter ct cannot be a wrapped AES-256 key under GCM.
  if (ct.length !== SYMMETRIC_KEY_BYTES + AEAD.tagLength / 8) return null;
  return { salt, iv, ct };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Recipients — BARRIER 2, and the brand that makes it structural
//
// ADR 002 §11 rule 10: `personalRecipients` and `familyRecipients` are separate functions with
// non-overlapping scopes, and NEITHER MAY TAKE THE OTHER'S LIST. A comment cannot enforce that.
// A brand can: each constructor stamps a non-enumerable Symbol naming the space kind the
// recipient may be wrapped for, `wrapToRecipients` refuses anything else, and a hand-written
// object literal has no brand at all — the same idiom ADR 004 §2.2 barrier 3 uses to keep an
// unbranded patch out of `sealOp`.
// ─────────────────────────────────────────────────────────────────────────────

const SCOPE = Symbol('lzp/v2/spacekeys/recipient-scope');

/**
 * @typedef {Object} Recipient
 * @property {string} deviceId    the `KeyWrapRow.deviceId` this wrap is filed under
 * @property {string} memberId    the HOUSING member — whose record the attestation sits in
 * @property {'device'|'recovery'} role
 * @property {Uint8Array} kexPubRaw 65 bytes — the key the space key is wrapped TO
 * @property {string|null} attestation the `dev.*` register blob; `null` only for `role:'recovery'`
 * @property {Uint8Array|null} housingRecoveryPubRaw the housing member's `RK_sig` PUBLIC key,
 *           65 bytes — the key the attestation must verify under (§2.3 condition (4))
 */

/** The brand, read back. `null` for anything this module did not construct. */
export function recipientScope(r) {
  return (r && typeof r === 'object' && r[SCOPE]) || null;
}

function brand(recipient, scope) {
  Object.defineProperty(recipient, SCOPE, { value: scope, enumerable: false, writable: false });
  return Object.freeze(recipient);
}

/**
 * A member's recovery key gets a wrap row too (§4.2 step 2), and `KeyWrapRow` is keyed by
 * `deviceId`, so it needs one. `rec_<memberId>` is reserved for it and can never collide with a
 * real `dev_` id.
 * @param {string} memberId
 */
export const recoveryRecipientId = (memberId) => `rec_${memberId}`;

function rawOf(v, who, field) {
  let bytes = v;
  if (typeof v === 'string') {
    try {
      bytes = ub64(v);
    } catch (err) {
      if (err instanceof CodecError) throw new SpaceKeyError(`${who}: ${field} is not base64url`);
      throw err;
    }
  }
  if (!(bytes instanceof Uint8Array) || bytes.length !== RAW_PUBKEY_BYTES) {
    throw new SpaceKeyError(`${who}: ${field} must be ${RAW_PUBKEY_BYTES} raw bytes of a P-256 point`);
  }
  return bytes;
}

/**
 * **ONLY my own devices, plus my own recovery key.** BARRIER 2's personal half.
 *
 * The scope is hard-coded in the strongest form available: this function REFUSES a device whose
 * `memberId` is not mine. A family member list therefore cannot be passed to it — not "should
 * not", cannot: the first foreign device throws. That refusal is the test that proves ADR 002
 * §11 rule 10 holds, and it is worth more than the comment above it.
 *
 * The recovery recipient needs no attestation because it is MY OWN key, held locally, never off
 * the wire. `familyRecipients` deliberately has no equivalent — see its header.
 *
 * @param {{memberId:string,
 *          devices:Array<{deviceId:string, memberId?:string, kexPubRaw:Uint8Array|string,
 *                         attestation:string, revokedAt?:*}>,
 *          recoveryKexPubRaw?:Uint8Array|string,
 *          recoverySigPubRaw:Uint8Array|string}} me
 * @returns {Recipient[]}
 */
export function personalRecipients(me) {
  const who = 'personalRecipients';
  if (!me || typeof me !== 'object') throw new SpaceKeyError(`${who}: expected my own identity`);
  const { memberId } = me;
  if (typeof memberId !== 'string' || memberId.length === 0) {
    throw new SpaceKeyError(`${who}: memberId is required`);
  }
  const devices = Array.isArray(me.devices) ? me.devices : null;
  if (!devices) throw new SpaceKeyError(`${who}: me.devices must be an array of MY OWN attested devices`);

  const housing = rawOf(me.recoverySigPubRaw, who, 'recoverySigPubRaw');
  const out = [];
  for (const d of devices) {
    if (!d || typeof d !== 'object') throw new SpaceKeyError(`${who}: a device entry is not an object`);
    // `memberId` is REQUIRED on every entry, and that is the refusal, not a formality: an
    // optional field would let a family device list — which carries the field under a different
    // name or not at all — slip through unchecked, and barrier 2 would be a comment again.
    if (d.memberId !== memberId) {
      throw new SpaceKeyError(
        `${who}: REFUSING a device belonging to member ${JSON.stringify(d.memberId)} — the ` +
        `personal space is wrapped to ${JSON.stringify(memberId)}'s own devices and to nothing ` +
        'else (ADR 002 §3 barrier 2, §11 rule 10). This function can never take a family list.'
      );
    }
    if (d.revokedAt !== undefined && d.revokedAt !== null) continue;
    if (typeof d.deviceId !== 'string' || d.deviceId.length === 0) {
      throw new SpaceKeyError(`${who}: a device entry has no deviceId`);
    }
    if (typeof d.attestation !== 'string' || d.attestation.length === 0) {
      throw new SpaceKeyError(
        `${who}: device ${d.deviceId} has no attestation blob. Every recipient is verified ` +
        'before a key is wrapped to it (ADR 002 §2.3, §4.2 step 2).'
      );
    }
    out.push(brand({
      deviceId: d.deviceId,
      memberId,
      role: 'device',
      kexPubRaw: rawOf(d.kexPubRaw, who, `device ${d.deviceId} kexPubRaw`),
      attestation: d.attestation,
      housingRecoveryPubRaw: housing,
    }, SPACE_KIND.PERSONAL));
  }

  if (me.recoveryKexPubRaw !== undefined && me.recoveryKexPubRaw !== null) {
    out.push(brand({
      deviceId: recoveryRecipientId(memberId),
      memberId,
      role: 'recovery',
      kexPubRaw: rawOf(me.recoveryKexPubRaw, who, 'recoveryKexPubRaw'),
      attestation: null,
      housingRecoveryPubRaw: housing,
    }, SPACE_KIND.PERSONAL));
  }
  return out;
}

/**
 * **Every non-removed member's attested, non-revoked devices.** BARRIER 2's family half.
 *
 * ⚠ NO RECOVERY RECIPIENTS, AND THAT IS A REPORTED GAP, NOT AN OVERSIGHT — finding E2E3-8.
 * ADR 002 §4.2 step 2 says a rotation wraps "plus each member's `RK_kex`". The WIRE FIELD now
 * exists — finding E3-2 added `Member.recoveryPubKex` and `handlers/members.js` publishes it —
 * and this function still refuses to use it, because **nothing signs it**.
 *
 * That asymmetry is the whole argument and it is worth stating precisely. `recoveryPubSig` is
 * also just a relay column, but it is *self-checking in use*: swap it and every device
 * attestation of that member stops verifying, `assertRecipients` throws, and the rotation stops.
 * Loud. `recoveryPubKex` is checked by nothing at all: swap it alone and every attestation stays
 * genuine, the member list looks exactly right, nobody's signature fails, and the next rotation
 * wraps `FSK_{e+1}` to a key the relay chose. That is not ADR 002 §8.5's accepted,
 * UI-surfaceable phantom member — it is a silent, unattributable key injection into the family
 * key, and it is a live break of stories 21.1 and 21.2. It is the same class as finding S1, one
 * door further along.
 *
 * So this function wraps to attested DEVICES only and reports every member whose recovery key it
 * could not include on `familyRecipientsReport().missingRecoveryKex`. `recipientProblem()`
 * additionally REFUSES a family-scoped recovery recipient by name, so a future change cannot
 * open this door by accident — and `requiredRecipients()` on the relay no longer demands the row,
 * so the refusal costs a family nothing but ADR 002 §7.3's A2 delivery path.
 *
 * **What closes it** is one signed artefact, and ADR 002 §2.3 specifies it: `recoveryPubKex` as
 * an OPTIONAL SEVENTH FIELD of `DeviceAttestation`. Extra fields are already tolerated by
 * `parseAttestationBlob` and already covered by the signature; the relay already accepts the
 * field (`assertAttestationClosed` in `handlers/spaces.js`). It needs `attestDevice()` in
 * `identity.js` to sign it and one comparison here. Until then, this is the one place that
 * changes, and closing this gap means BUILDING THAT — not calling `rawOf(m.recoveryPubKex)`.
 *
 * It also cannot be handed one member's own identity: it takes an ARRAY of member records, each
 * carrying its own `recoveryPubSig`, and every recipient it produces is branded `'family'`.
 *
 * ⚠ **THIS FUNCTION TAKES THE RELAY'S MEMBER ROW, VERBATIM.** Its field names are the ones
 * `GET /api/v1/spaces/:id/members` publishes — `recoveryPubSig`, `recoveryPubKex`, `devices[]`
 * with `deviceId`, `kexPubRaw`, `attestation`, `revokedAt` — so a caller pipes the response in
 * without translating, and a translation step is exactly where finding E2E3-5 lived: this used
 * to read `recoveryKexPubRaw`, which no server ever emitted, so `missingRecoveryKex` named every
 * member of every family for a column that was there all along.
 *
 * `personalRecipients` reads `recoverySigPubRaw`/`recoveryKexPubRaw` and that is NOT a second
 * spelling of the same field: its argument is MY OWN identity, assembled locally from my own
 * key store, and it never comes off a relay. Two different objects, each internally consistent.
 *
 * @param {Array<{memberId:string, removedAt?:*, recoveryPubSig:Uint8Array|string,
 *                recoveryPubKex?:Uint8Array|string,
 *                devices:Array<{deviceId:string, kexPubRaw:Uint8Array|string,
 *                               attestation:string, revokedAt?:*}>}>} members
 * @returns {Recipient[]}
 */
export function familyRecipients(members) {
  return familyRecipientsReport(members).recipients;
}

/**
 * `familyRecipients` plus the two things a caller must be able to SURFACE rather than discover:
 * which members were skipped as removed, and which members have no reachable `RK_kex`.
 * @returns {{recipients:Recipient[], removed:string[], missingRecoveryKex:string[]}}
 */
export function familyRecipientsReport(members) {
  const who = 'familyRecipients';
  if (!Array.isArray(members)) {
    throw new SpaceKeyError(`${who}: expected an array of member records, one per Familienkreis member`);
  }
  const recipients = [];
  const removed = [];
  const missingRecoveryKex = [];
  const seen = new Set();

  for (const m of members) {
    if (!m || typeof m !== 'object') throw new SpaceKeyError(`${who}: a member record is not an object`);
    const { memberId } = m;
    if (typeof memberId !== 'string' || memberId.length === 0) {
      throw new SpaceKeyError(`${who}: a member record has no memberId`);
    }
    if (seen.has(memberId)) throw new SpaceKeyError(`${who}: member ${memberId} appears twice`);
    seen.add(memberId);

    if (m.removedAt !== undefined && m.removedAt !== null) {
      // T2. A removed member receives NOTHING further (ADR 002 §4.3), and the relay additionally
      // deletes every wrap they hold, for all epochs, in the same transaction (§4.2 step 4).
      removed.push(memberId);
      continue;
    }
    const housing = rawOf(m.recoveryPubSig, who, `member ${memberId} recoveryPubSig`);
    // Finding E2E3-5: the relay's spelling, which is the only one that ever arrives here.
    if (m.recoveryPubKex === undefined || m.recoveryPubKex === null) missingRecoveryKex.push(memberId);

    const devices = Array.isArray(m.devices) ? m.devices : null;
    if (!devices) throw new SpaceKeyError(`${who}: member ${memberId} has no devices array`);
    for (const d of devices) {
      if (!d || typeof d !== 'object') throw new SpaceKeyError(`${who}: a device entry is not an object`);
      if (d.revokedAt !== undefined && d.revokedAt !== null) continue;
      if (typeof d.deviceId !== 'string' || d.deviceId.length === 0) {
        throw new SpaceKeyError(`${who}: a device of member ${memberId} has no deviceId`);
      }
      if (typeof d.attestation !== 'string' || d.attestation.length === 0) {
        throw new SpaceKeyError(
          `${who}: device ${d.deviceId} of member ${memberId} has no attestation blob. ` +
          'Every recipient is verified before a key is wrapped to it (ADR 002 §2.3, §4.2 step 2).'
        );
      }
      recipients.push(brand({
        deviceId: d.deviceId,
        memberId,
        role: 'device',
        kexPubRaw: rawOf(d.kexPubRaw, who, `device ${d.deviceId} kexPubRaw`),
        attestation: d.attestation,
        housingRecoveryPubRaw: housing,
      }, SPACE_KIND.FAMILY));
    }
  }
  return { recipients, removed, missingRecoveryKex };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Verification before wrapping (ADR 002 §2.3, §4.2 step 2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify one recipient's attestation and bind it to the key we are about to wrap to.
 *
 * The last check is the one that matters most and is the easiest to leave out: **`att.kexPubRaw`
 * must equal the `kexPubRaw` we are wrapping to.** An attestation that verifies but names a
 * different agreement key would let a member (or a relay that reordered a member list) redirect
 * the space key to a key of their choosing while every signature still checked out. That is a
 * key-injection channel, and `crypto.contract.js` §2 names it explicitly.
 *
 * @param {Recipient} r
 * @param {CryptoPorts} [ports]
 * @returns {Promise<string|null>} a reason it is UNUSABLE, or `null` if it verified
 */
export async function recipientProblem(r, ports) {
  if (recipientScope(r) === null) {
    return (
      'unbranded: recipients must come from personalRecipients() or familyRecipients(), which ' +
      'are the only two scopes that exist (ADR 002 §3 barrier 2, §11 rule 10)'
    );
  }
  if (r.role === 'recovery') {
    // ── THE BYPASS IS SCOPED, AND THE SCOPE IS THE ARGUMENT — finding E2E3-8 ─────────────────
    // "my own key, held locally, never off the wire" is true of a PERSONAL recovery recipient,
    // which `personalRecipients()` builds from `me.recoveryKexPubRaw` after refusing every device
    // that is not mine. It is false of a FAMILY one, whose only possible source is
    // `Member.recoveryPubKex` — a relay column NOTHING SIGNS. Waving that through here would
    // wrap `FSK_{e+1}` to whatever key the relay put in that column, silently, with every
    // attestation still verifying and the member list still looking right.
    //
    // `familyRecipients()` builds no such recipient today, so this is defence in depth rather
    // than a live check — which is precisely why it is here: the next agent who makes rotation
    // "work" by constructing one gets a named refusal instead of a green suite and a broken 21.2.
    if (recipientScope(r) === SPACE_KIND.FAMILY) {
      return (
        `REFUSING a family recovery recipient for member ${r.memberId}: its key can only have ` +
        'come from `Member.recoveryPubKex`, a relay column NOTHING signs. Swapping it is silent ' +
        '(every device attestation still verifies, the member list still looks right) and it ' +
        'hands the relay the family key — finding E2E3-8, the S1 class one door along. Bind ' +
        '`recoveryPubKex` into the DeviceAttestation payload first (ADR 002 §2.3); until then a ' +
        'family rotation covers devices only and the relay does not demand more.'
      );
    }
    return null; // my own key, held locally, never off the wire
  }
  if (!(r.housingRecoveryPubRaw instanceof Uint8Array)) return 'no housing recovery public key to verify under';

  let recSigPub;
  try {
    recSigPub = await importSigPublic(r.housingRecoveryPubRaw, ports);
  } catch {
    return `member ${r.memberId}'s recovery public key is not an importable P-256 point`;
  }
  // Verified under the HOUSING member's key — never under `att.memberId` (§2.3 condition (4)).
  // `verifyAttestation` also enforces §5.2.2's P2 and never throws.
  const att = await verifyAttestation(r.attestation, recSigPub, ports);
  if (att === null) return `the attestation of device ${r.deviceId} does not verify under member ${r.memberId}`;
  if (att.memberId !== r.memberId) return `attestation of ${r.deviceId} claims member ${att.memberId}, filed under ${r.memberId}`;
  if (att.deviceId !== r.deviceId) return `attestation filed for ${r.deviceId} names device ${att.deviceId}`;
  if (att.kexPubRaw !== b64u(r.kexPubRaw)) {
    return (
      `the attestation of ${r.deviceId} names a DIFFERENT agreement key than the one this wrap ` +
      'would be addressed to — refusing (key injection, crypto.contract.js §2)'
    );
  }
  return null;
}

/**
 * Every recipient, verified. Throws on the first failure rather than skipping it.
 *
 * Skipping would be worse in both directions: the relay's coverage check (§4.2) rejects a bump
 * that does not cover every current device, so a silent skip becomes a `409` the user cannot act
 * on; and a device in your own folded member list whose attestation does not verify is a security
 * event, not a hiccup.
 *
 * @param {Recipient[]} recipients @param {'personal'|'family'} kind @param {CryptoPorts} [ports]
 */
export async function assertRecipients(recipients, kind, ports) {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new SpaceKeyError('assertRecipients: at least one recipient is required — a wrap to nobody is a lost epoch');
  }
  const ids = new Set();
  for (const r of recipients) {
    const scope = recipientScope(r);
    if (scope !== kind) {
      throw new SpaceKeyError(
        `assertRecipients: a ${scope === null ? 'UNBRANDED' : JSON.stringify(scope)} recipient ` +
        `cannot receive a ${JSON.stringify(kind)}-space key. The two recipient scopes are ` +
        'disjoint by construction (ADR 002 §3 barrier 2, §11 rule 10) — this is story 20.5.'
      );
    }
    if (ids.has(r.deviceId)) throw new SpaceKeyError(`assertRecipients: duplicate recipient ${r.deviceId}`);
    ids.add(r.deviceId);
    const problem = await recipientProblem(r, ports);
    if (problem !== null) throw new SpaceKeyError(`assertRecipients: ${problem}`);
  }
  return recipients;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6b. Verification on the RECEIVING side — the admissible sender set (finding S1)
//
// ═══ THE FINDING THIS SECTION EXISTS FOR ═══
//
// `unwrapSpaceKey`'s contract has always said `theirKexPub` is "the sender's ECDH public key,
// FROM THEIR VERIFIED ATTESTATION". Until 2026-08-28 its only caller, `admitWraps`, read that key
// off `row.senderKexPubRaw` — a field of the RELAY'S OWN JSON — and verified nothing: no member
// list, no attestation, no recipient check. One throwaway ECDH keypair and one extra row in
// `GET /api/v1/spaces/:id/keys` put a key of the attacker's choosing into the victim's ring, for
// the PERSONAL space as readily as the family one, and the victim then sealed its own Privat
// entries under it. Barriers 1-4 all answer *which key opens which envelope*; this walked past
// all four by changing *which key the victim uses*.
//
// ═══ WHY THIS IS A PARAMETER AND NOT AN `if` ═══
//
// ADR 002 §4.2 step 2 put the attestation check on the WRAPPING side only, and the receiving side
// is the one that decides which key it will use. `admitWraps(ring, rows, ctx)` had nowhere to put
// the verified set — no member list, no `attestationOf`, no allowlist — so the check had nowhere
// to live and an `if` inside the loop would have had nothing to compare against. `ctx.senders` is
// **REQUIRED and has no default**: a caller that forgets it gets a `SpaceKeyError` naming S1, not
// a silent admission. E2/E5 is the first caller that will wire it.
//
// ═══ WHAT MAKES IT STRUCTURAL RATHER THAN A VALIDATION STEP ═══
//
//   · THE SET CANNOT BE HAND-ROLLED. `admissibleSenders` takes `Recipient[]`, and a `Recipient`
//     exists only if `personalRecipients()` or `familyRecipients()` made it — the non-enumerable
//     `SCOPE` brand of barrier 2 is not reachable from outside this module, and an object literal
//     or a spread copy has none. So "the devices I will accept a key FROM" is computed by the same
//     two constructors, under the same two hard-coded scopes, as "the devices I will wrap a key
//     TO". `personalRecipients` REFUSES any device that is not mine, so the personal space's
//     sender set cannot contain Mama however the caller assembles the list.
//   · THE SET IS BOUND TO ONE SPACE. A `SenderSet` carries the `spaceId` it was verified for and
//     `admitWraps` refuses one built for a different space or kind — a family sender set can
//     never authorize a `psp_` admission.
//   · **THE ROW SELECTS A SENDER; IT CANNOT SUPPLY ONE.** `row.senderKexPubRaw` is now an INDEX
//     into the verified set and nothing else. The `CryptoKey` the KEK is derived against is the
//     one this module imported from `Recipient.kexPubRaw` at verification time — the key
//     `recipientProblem` bound to `att.kexPubRaw` (§2.3). Relay bytes never reach `deriveBits`.
//   · THE RING REMEMBERS. `KeyRing.put`'s fourth argument records the origin, so a ring entry can
//     say which verified device delivered it (`ring.originOf`). A `CryptoKey` carries no
//     provenance; the slot it sits in now does.
//
// ═══ THE ONE THING THIS DOES NOT CLOSE, STATED PLAINLY ═══
//
// A device's FIRST family sync — §7.1 step 6, before it holds any epoch key — cannot fold the
// family stream, so it cannot build `familyRecipients` from authenticated state. Its roster has
// to come from relay coordination data (`MemberRowDb.recoveryPubSig` plus the `dev.*` blobs), and
// every attestation in it is verified here, under the recovery key the row carries. A relay that
// wants an admission must therefore invent a MEMBER — recovery key, attestation, the lot — and
// that member appears in the member list (15.4) as somebody nobody invited. That converts an
// invisible, unattributable key injection into ADR 002 §8.5's already-accepted, UI-surfaceable
// phantom member. It does not eliminate it. The PERSONAL space has no such bootstrap: its sender
// set comes from my own pairing record (§6), which was authenticated out of band by the SAS.
// ─────────────────────────────────────────────────────────────────────────────

const SENDER_SET = Symbol('lzp/v2/spacekeys/verified-sender-set');

/**
 * @typedef {Object} SenderSet
 * @property {'personal'|'family'} kind
 * @property {string} spaceId
 * @property {(kexPubRaw:Uint8Array|string) => {deviceId:string, memberId:string, kexPub:CryptoKey}|null} lookup
 * @property {() => number} size
 * @property {() => string[]} deviceIds
 */

/** Is this a `SenderSet` this module built? `false` for anything else, including a copy of one. */
export function isSenderSet(v) {
  return !!(v && typeof v === 'object' && v[SENDER_SET] === true);
}

/**
 * The devices this space will accept an epoch key FROM, verified once and reusable.
 *
 * Every recipient is put through the identical gate the WRAPPING side uses — the brand must match
 * the space kind, the attestation must verify under the housing member's `RK_sig`, and
 * `att.kexPubRaw` must equal the key itself (`recipientProblem`, §2.3, §4.2 step 2). The result
 * indexes the VERIFIED `CryptoKey`s by their raw bytes, so `admitWraps` never imports a point the
 * relay sent it.
 *
 * **An EMPTY list is allowed and means "I can authenticate nobody yet"** — every row is then
 * refused as `unauthorized` and the ops stay parked (§4.4), which is the right answer for a
 * joiner between §7.1 steps 2 and 6. `assertRecipients` refuses an empty list because a wrap to
 * nobody is a lost epoch; an admission from nobody is merely a sync that admitted nothing, and
 * throwing here would push callers towards passing a list they had not verified.
 *
 * A recovery recipient (`role:'recovery'`, my own key, never off the wire) is included: it is the
 * one recipient with no attestation, and `personalRecipients` only ever produces MINE.
 *
 * @param {Recipient[]|SenderSet} recipients
 * @param {string} spaceId
 * @param {CryptoPorts} [ports]
 * @returns {Promise<SenderSet>}
 */
export async function admissibleSenders(recipients, spaceId, ports) {
  const who = 'admissibleSenders';
  const kind = spaceKindOf(spaceId);

  if (isSenderSet(recipients)) {
    if (recipients.spaceId !== spaceId) {
      throw new SpaceKeyError(
        `${who}: this sender set was verified for ${recipients.spaceId} and cannot authorize an ` +
        `admission into ${spaceId}. A set is bound to ONE space (ADR 002 §3 barrier 2, finding S1).`
      );
    }
    return recipients;
  }
  if (!Array.isArray(recipients)) {
    throw new SpaceKeyError(
      `${who}: expected the Recipient[] from personalRecipients() or familyRecipients() — the ` +
      'same two constructors the wrapping side uses. There is no third way to name a device this ' +
      'space may accept a key from (ADR 002 §11 rule 10).'
    );
  }

  /** @type {Map<string, {deviceId:string, memberId:string, kexPub:CryptoKey}>} */
  const byKey = new Map();
  const ids = new Set();
  for (const r of recipients) {
    const scope = recipientScope(r);
    if (scope !== kind) {
      throw new SpaceKeyError(
        `${who}: a ${scope === null ? 'UNBRANDED' : JSON.stringify(scope)} recipient cannot ` +
        `authorize a ${JSON.stringify(kind)}-space admission. The two scopes are disjoint by ` +
        'construction (ADR 002 §3 barrier 2, §11 rule 10) — this is story 20.5, on the way IN.'
      );
    }
    if (ids.has(r.deviceId)) throw new SpaceKeyError(`${who}: duplicate sender ${r.deviceId}`);
    ids.add(r.deviceId);
    const problem = await recipientProblem(r, ports);
    if (problem !== null) throw new SpaceKeyError(`${who}: ${problem}`);

    const raw = b64u(r.kexPubRaw);
    const clash = byKey.get(raw);
    if (clash) {
      throw new SpaceKeyError(
        `${who}: devices ${clash.deviceId} and ${r.deviceId} present the SAME agreement key. Two ` +
        'devices sharing an `IK_kex` cannot be told apart by a wrap row, so the set would be ' +
        'ambiguous about who delivered a key — refusing rather than picking one.'
      );
    }
    // RULE 5: `keyUsages: []`, and always through `identity.importKexPublic`. This is the key the
    // KEK is derived against — imported HERE, from the verified attestation's bytes, never from a
    // relay row.
    byKey.set(raw, {
      deviceId: r.deviceId,
      memberId: r.memberId,
      kexPub: await importKexPublic(r.kexPubRaw, ports),
    });
  }

  const set = {
    kind,
    spaceId,
    lookup(kexPubRaw) {
      let raw;
      try {
        raw = b64u(rawOf(kexPubRaw, who, 'senderKexPubRaw'));
      } catch {
        return null; // peer data: absent, malformed, not a point. Not in the set either way.
      }
      return byKey.get(raw) || null;
    },
    size: () => byKey.size,
    deviceIds: () => [...ids].sort(),
  };
  Object.defineProperty(set, SENDER_SET, { value: true, enumerable: false, writable: false });
  return Object.freeze(set);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Wrapping to many — one epoch, and then ALL of them
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One epoch key, to every recipient. Every attestation is verified first (§4.2 step 2).
 * @param {CryptoKey} spaceKey @param {CryptoKey} myKexPriv @param {Recipient[]} recipients
 * @param {WrapContext} ctx
 * @returns {Promise<Array<{deviceId:string, epoch:number, wrapped:WrapBlob}>>}
 */
export async function wrapToRecipients(spaceKey, myKexPriv, recipients, ctx) {
  assertWrapContext(ctx, 'wrapToRecipients');
  const kind = spaceKindOf(ctx.spaceId);
  await assertRecipients(recipients, kind, ctx);

  const out = [];
  for (const r of recipients) {
    const theirKexPub = await importKexPublic(r.kexPubRaw, ctx); // RULE 5: keyUsages []
    out.push({
      deviceId: r.deviceId,
      epoch: ctx.epoch,
      wrapped: await wrapSpaceKey(spaceKey, myKexPriv, theirKexPub, ctx),
    });
  }
  return out;
}

/**
 * **EVERY epoch `1..upTo`, to every recipient.** This is the function A4 / story 17.1 / risk R11
 * depend on: a member who joins in epoch 7 must still see Oma's birthday, entered in epoch 1.
 *
 * It REFUSES to build a partial ring. A wrap covering only the current epoch is a bug (ADR 002
 * §4.3, §7.1 step 5) and the failure it causes is silent — a joiner whose board is simply missing
 * three years of entries with no error anywhere — so the gap is named and thrown here, on the
 * device that has the keys, rather than discovered later on the device that does not.
 *
 * @param {Map<number,CryptoKey>|Object<string,CryptoKey>} spaceKeysByEpoch
 * @param {CryptoKey} myKexPriv
 * @param {Recipient[]} recipients
 * @param {{spaceId:string, upTo:number} & CryptoPorts} ctx
 * @returns {Promise<Array<{deviceId:string, epoch:number, wrapped:WrapBlob}>>}
 */
export async function wrapRingToRecipients(spaceKeysByEpoch, myKexPriv, recipients, ctx) {
  if (!ctx || typeof ctx !== 'object') throw new SpaceKeyError('wrapRingToRecipients: a {spaceId, upTo} context is required');
  const { spaceId } = ctx;
  const upTo = assertEpoch(ctx.upTo, 'wrapRingToRecipients');
  const kind = spaceKindOf(spaceId);
  const keys = normalizeKeysByEpoch(spaceKeysByEpoch, 'wrapRingToRecipients');

  const missing = [];
  for (let e = FIRST_EPOCH; e <= upTo; e++) if (!keys.has(e)) missing.push(e);
  if (missing.length > 0) {
    throw new SpaceKeyError(
      `wrapRingToRecipients: refusing to build a wrap that covers only part of ${spaceId}'s ` +
      `history — epochs [${missing.join(', ')}] of 1..${upTo} are missing. A joiner must receive ` +
      'ALL epochs or entries from before they joined silently never render (ADR 002 §4.3, ' +
      '§7.1 step 5; A4, story 17.1, risk R11).'
    );
  }
  await assertRecipients(recipients, kind, ctx);

  const out = [];
  for (let e = FIRST_EPOCH; e <= upTo; e++) {
    for (const row of await wrapToRecipients(keys.get(e), myKexPriv, recipients, { ...ctx, spaceId, epoch: e })) {
      out.push(row);
    }
  }
  return out;
}

/**
 * D9's delivery half, as one call: **any existing member device** hands a joiner the whole ring.
 *
 * There is no role parameter and there will not be one. Admission was authorized by the invite
 * the admin issued and can revoke; delivery is not a second gate (ADR 002 §7.1 step 4).
 *
 * @param {KeyRing} ring @param {string} spaceId @param {CryptoKey} myKexPriv
 * @param {Recipient[]} newRecipients @param {CryptoPorts} [ports]
 */
export async function wrapRingTo(ring, spaceId, myKexPriv, newRecipients, ports) {
  assertRing(ring, 'wrapRingTo');
  const upTo = ring.currentEpoch(spaceId);
  if (upTo < FIRST_EPOCH) {
    throw new SpaceKeyError(`wrapRingTo: this device holds no key for ${spaceId}; it cannot deliver a ring it does not have`);
  }
  return wrapRingToRecipients(ring.keysByEpoch(spaceId), myKexPriv, newRecipients, { ...ports, spaceId, upTo });
}

/** @returns {Map<number,CryptoKey>} */
function normalizeKeysByEpoch(v, who) {
  const out = new Map();
  const add = (k, key) => {
    const epoch = typeof k === 'string' ? Number(k) : k;
    assertEpoch(epoch, who);
    const problem = spaceKeyProblem(key);
    if (problem) throw new SpaceKeyError(`${who}: the key for epoch ${epoch} is unusable — ${problem}`);
    out.set(epoch, key);
  };
  if (v instanceof Map) {
    for (const [k, key] of v) add(k, key);
  } else if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) add(k, v[k]);
  } else {
    throw new SpaceKeyError(`${who}: expected a Map<epoch, CryptoKey> or a plain object keyed by epoch`);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. The KeyRing
//
// Synchronous, because `openOp`'s key selection may not await (ADR 002 §5.2.2 P4) and because a
// miss is a PARK rather than an error. Keyed by the FULL space id, so a personal key can never
// be returned for a family lookup: `get('fsp_…', 3)` cannot reach anything stored under a `psp_`
// id, whatever a caller intended.
//
// It RETAINS every epoch it ever held (`crypto.contract.js` §3). Discarding an old epoch would
// discard the ability to read the history, and to re-wrap that history to the next joiner.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} KeyOrigin
 * @property {'local'|'admitted'} how  `local` — minted here, or restored from this device's own
 *           key store. `admitted` — unwrapped from a relay row whose sender was verified.
 * @property {string|null} deviceId  the VERIFIED device that delivered it; null when `local`
 * @property {string|null} memberId
 */

/**
 * @typedef {Object} KeyRing
 * @property {(space:string, epoch:number) => CryptoKey|null} get
 * @property {(space:string, epoch:number, k:CryptoKey, origin?:KeyOrigin) => boolean} put
 *           false ⇒ the slot was taken
 * @property {(space:string, epoch:number) => KeyOrigin|null} originOf
 * @property {(space:string, epoch:number) => boolean} has
 * @property {(space:string) => number} currentEpoch   0 ⇒ no key for this space
 * @property {(space:string) => number[]} epochs       ascending; every epoch ever held
 * @property {(space:string) => Map<number,CryptoKey>} keysByEpoch
 * @property {(space:string, upTo:number) => number[]} missing
 * @property {(space:string, upTo:number) => boolean} covers
 * @property {() => string[]} spaces
 * @property {() => number} size
 * @property {() => number} refusedPuts
 * @property {() => string[]} loadSkipped
 */

/**
 * @param {Iterable<[string, number, CryptoKey]>} [entries]
 * @returns {KeyRing}
 */
/** The origin every key that was NOT admitted from the network carries. */
const LOCAL_ORIGIN = Object.freeze({ how: 'local', deviceId: null, memberId: null });

export function createKeyRing(entries) {
  /** @type {Map<string, Map<number, CryptoKey>>} */
  const bySpace = new Map();
  /** Provenance, keyed identically. A `CryptoKey` carries none; the SLOT does (finding S1). */
  const originBySpace = new Map();
  let refused = 0;
  const skipped = [];

  const ring = {
    get(space, epoch) {
      // TOTAL, and null for anything not held — including a malformed id. `env.sp` and `env.ep`
      // are PEER data and a miss is a park (§4.4), so this must not throw where `openOp` reads it.
      if (!isSpaceId(space) || !isEpoch(epoch)) return null;
      const m = bySpace.get(space);
      return (m && m.get(epoch)) || null;
    },

    put(space, epoch, key, origin) {
      // Our own data: loud. A key entering the ring under a space id nobody can classify, or
      // under an epoch that is not an epoch, is a bug that must not become a silent no-op.
      spaceKindOf(space);
      assertEpoch(epoch, 'KeyRing.put');
      const problem = spaceKeyProblem(key);
      if (problem) throw new SpaceKeyError(`KeyRing.put: ${problem}`);

      let m = bySpace.get(space);
      if (!m) bySpace.set(space, (m = new Map()));
      if (m.has(epoch)) {
        // FIRST WRITE WINS, and it is not an error. Two members legitimately wrapping the same
        // epoch to the same joiner is the ordinary case under D9 (§7.1 step 4), so a throw here
        // would break the common path. A LATER, DIFFERENT key for an epoch already held is
        // either that duplicate or an attempted substitution; neither may displace a key that is
        // already decrypting ops. The count is exposed so a caller can surface the anomaly.
        refused++;
        return false;
      }
      m.set(epoch, key);
      let o = originBySpace.get(space);
      if (!o) originBySpace.set(space, (o = new Map()));
      o.set(epoch, origin === undefined || origin === null ? LOCAL_ORIGIN : Object.freeze({
        how: origin.how === 'admitted' ? 'admitted' : 'local',
        deviceId: typeof origin.deviceId === 'string' ? origin.deviceId : null,
        memberId: typeof origin.memberId === 'string' ? origin.memberId : null,
      }));
      return true;
    },

    /**
     * WHO PUT THIS KEY HERE. `null` for a slot that holds nothing.
     *
     * This is the answer to "a `KeyRing` entry is a `CryptoKey` and a `CryptoKey` carries no
     * provenance" (finding S1). `how:'admitted'` names the VERIFIED device the wrap came from —
     * `admitWraps` is the only writer that can set it, and it can only set it to a device that
     * was in the `SenderSet`.
     */
    originOf(space, epoch) {
      if (ring.get(space, epoch) === null) return null;
      const o = originBySpace.get(space);
      return (o && o.get(epoch)) || LOCAL_ORIGIN;
    },

    has: (space, epoch) => ring.get(space, epoch) !== null,

    currentEpoch(space) {
      const m = bySpace.get(space);
      if (!m || m.size === 0) return 0;
      let max = 0;
      for (const e of m.keys()) if (e > max) max = e;
      return max;
    },

    epochs(space) {
      const m = bySpace.get(space);
      return m ? [...m.keys()].sort((a, b) => a - b) : [];
    },

    keysByEpoch(space) {
      const m = bySpace.get(space);
      return new Map(m ? [...m.entries()].sort((a, b) => a[0] - b[0]) : []);
    },

    missing(space, upTo) {
      assertEpoch(upTo, 'KeyRing.missing');
      const m = bySpace.get(space);
      const gaps = [];
      for (let e = FIRST_EPOCH; e <= upTo; e++) if (!m || !m.has(e)) gaps.push(e);
      return gaps;
    },

    covers: (space, upTo) => ring.missing(space, upTo).length === 0,

    spaces: () => [...bySpace.keys()].sort(),

    size() {
      let n = 0;
      for (const m of bySpace.values()) n += m.size;
      return n;
    },

    refusedPuts: () => refused,
    loadSkipped: () => [...skipped],
    /** @internal used by `loadKeyRing` to report custody failures without a second return value */
    _skip: (id) => void skipped.push(id),
  };

  // `[space, epoch, key]`, plus an optional fourth element for a caller that already knows the
  // origin — `loadKeyRing` rebuilding a ring whose entries were admitted in an earlier session.
  if (entries) for (const [space, epoch, key, origin] of entries) ring.put(space, epoch, key, origin);
  return ring;
}

function assertRing(ring, who) {
  for (const m of ['get', 'put', 'currentEpoch', 'epochs', 'keysByEpoch']) {
    if (typeof ring?.[m] !== 'function') throw new SpaceKeyError(`${who}: expected a KeyRing (missing ${m})`);
  }
  return ring;
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Custody — the ring behind a KeyStore port
//
// `identity.js`'s header already reserves this namespace: "the same store also holds space keys
// (LZP-303) and the WrapBlobs the key ring is rebuilt from". Record ids are
// `lzp/v2/space/<spaceId>/<epoch>`, which cannot collide with any `KEYSTORE_IDS` value.
// ─────────────────────────────────────────────────────────────────────────────

/** The record-id namespace for space keys. */
export const SPACE_KEY_PREFIX = 'lzp/v2/space/';

/** @param {string} spaceId @param {number} epoch @returns {string} */
export function spaceKeyRecordId(spaceId, epoch) {
  spaceKindOf(spaceId);
  assertEpoch(epoch, 'spaceKeyRecordId');
  return `${SPACE_KEY_PREFIX}${spaceId}/${epoch}`;
}

/** The inverse. `null` for anything that is not one of our record ids. */
export function parseSpaceKeyRecordId(id) {
  if (typeof id !== 'string' || !id.startsWith(SPACE_KEY_PREFIX)) return null;
  const rest = id.slice(SPACE_KEY_PREFIX.length);
  const slash = rest.lastIndexOf('/');
  if (slash <= 0) return null;
  const spaceId = rest.slice(0, slash);
  const epoch = Number(rest.slice(slash + 1));
  if (!isSpaceId(spaceId) || !isEpoch(epoch)) return null;
  return { spaceId, epoch };
}

/**
 * Persist one epoch key. Idempotent at the store level — the store is keyed by (space, epoch).
 * @param {import('./identity.js').KeyStore} ks
 */
export async function saveSpaceKey(ks, spaceId, epoch, key) {
  assertKeyStore(ks, 'saveSpaceKey');
  const problem = spaceKeyProblem(key);
  if (problem) throw new SpaceKeyError(`saveSpaceKey: ${problem}`);
  await ks.put(spaceKeyRecordId(spaceId, epoch), key);
}

/**
 * Rebuild the ring from the key store.
 *
 * **A record that reads back as `null` is SKIPPED, not thrown on**, and it is reported on
 * `ring.loadSkipped()`. That is not defensiveness for its own sake: on WebKit a persisted
 * `CryptoKey` is encrypted under a per-application WebCrypto master key whose Keychain ACL is
 * bound to the CODE SIGNATURE of the binary that created it, so after an update re-signs the
 * bundle the keys deserialise to `null` with no error anywhere (LZP-302's finding 8,
 * `platform/keystore.js`). Throwing would turn that into "the app will not start"; skipping and
 * reporting turns it into "these epochs need re-wrapping", which is recoverable — any other
 * member device can re-deliver the ring (D9, §7.1 step 4).
 *
 * @param {import('./identity.js').KeyStore} ks
 * @returns {Promise<KeyRing>}
 */
export async function loadKeyRing(ks) {
  assertKeyStore(ks, 'loadKeyRing');
  const ring = createKeyRing();
  for (const id of await ks.list()) {
    const parsed = parseSpaceKeyRecordId(id);
    if (!parsed) continue;
    const key = await ks.get(id);
    if (key === null || key === undefined || spaceKeyProblem(key) !== null) {
      ring._skip(id);
      continue;
    }
    ring.put(parsed.spaceId, parsed.epoch, key);
  }
  return ring;
}

function assertKeyStore(ks, who) {
  for (const m of ['get', 'put', 'del', 'list']) {
    if (typeof ks?.[m] !== 'function') {
      throw new SpaceKeyError(`${who}: the KeyStore port must implement get/put/del/list (missing ${m})`);
    }
  }
  return ks;
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. Rotation (ADR 002 §4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §4.1's trigger table, as data rather than as prose, so it can be asserted.
 *
 * `space: null` means the event rotates nothing.
 */
export const ROTATION_TRIGGERS = Object.freeze({
  'member.join': Object.freeze({ rotate: true, space: SPACE_KIND.FAMILY, why: 'a leaked, already-redeemed invite must yield a superseded key' }),
  'member.remove': Object.freeze({ rotate: true, space: SPACE_KIND.FAMILY, why: 'T2 — the removed member must not read future ops' }),
  'member.leave': Object.freeze({ rotate: true, space: SPACE_KIND.FAMILY, why: 'T2 — same, initiated from the other side' }),
  'device.pair': Object.freeze({ rotate: true, space: SPACE_KIND.PERSONAL, why: 'my device list changed (story 19.5)' }),
  'device.unpair': Object.freeze({ rotate: true, space: SPACE_KIND.PERSONAL, why: 'my device list changed' }),
  'admin.transfer': Object.freeze({ rotate: false, space: null, why: "nobody's read access changes (story 20.1)" }),
  'space.rename': Object.freeze({ rotate: false, space: null, why: 'no read access changes' }),
  'profile.edit': Object.freeze({ rotate: false, space: null, why: 'no read access changes' }),
});

/**
 * Does this event rotate?
 *
 * **An unknown event THROWS.** Returning `false` for a name nobody listed would make every future
 * membership event default to "no rotation" — a silent security downgrade of exactly the kind
 * §4.1 exists to prevent, and one that no test would notice.
 *
 * @param {string} event @returns {{rotate:boolean, space:'personal'|'family'|null, why:string}}
 */
export function rotatesOn(event) {
  const row = Object.prototype.hasOwnProperty.call(ROTATION_TRIGGERS, event) ? ROTATION_TRIGGERS[event] : null;
  if (!row) {
    throw new SpaceKeyError(
      `rotatesOn: ${JSON.stringify(event)} is not one of ADR 002 §4.1's rotation triggers ` +
      `(${Object.keys(ROTATION_TRIGGERS).join(', ')}). An unlisted event must not silently mean ` +
      '"no rotation" — add it to the table with a reason, or fix the caller.'
    );
  }
  return row;
}

/**
 * @typedef {Object} Rotation
 * @property {string} spaceId
 * @property {'personal'|'family'} kind
 * @property {number} epoch  the NEW epoch, `e+1`
 * @property {Array<{deviceId:string, epoch:number, wrapped:WrapBlob}>} wraps  ALL epochs `1..e+1`
 * @property {Array<{id:string, epoch:number}>} invites  refreshed — NO key material (D9)
 * @property {string[]} coveredDevices
 */

/**
 * Build a rotation payload: every epoch `1..nextEpoch`, wrapped to every recipient.
 *
 * WHAT THIS FUNCTION DOES NOT DO, DELIBERATELY:
 *  · **It does not mint.** `crypto.contract.js` §3 lists "mint" as step 1, but a function that
 *    minted a key AND built a network payload would lose that key if the POST failed — the wraps
 *    would be orphaned and the epoch unreadable by anyone, including the rotator. The caller
 *    mints with `createSpaceKey()`, persists, and then calls this; `rotateSpace()` below does
 *    exactly that in the right order and hands the key back.
 *  · **It attaches no key material to an invite.** ADR 002 §4.2 step 3 still says "re-wrap every
 *    open invite blob", which is superseded text: PO decision D9 removed `Invite.wrappedKeys`
 *    (§7.1, `server.contract.js`'s `refreshInvite(id, epoch)` — "no key material — D9"), and
 *    `suite.infoBytes()` throws by name on the retired `lzp/v2/invite/wrap` label. An open invite
 *    is refreshed to the new epoch and carries nothing else. An invite object that arrives here
 *    carrying wrapped keys is REFUSED rather than stripped, because stripping would hide the fact
 *    that some caller still believes in the seven-day read window the PO removed.
 *
 * @param {string} spaceId
 * @param {number} nextEpoch  `e+1`
 * @param {Map<number,CryptoKey>|Object} spaceKeysByEpoch  must contain 1..nextEpoch
 * @param {CryptoKey} myKexPriv
 * @param {Recipient[]} recipients
 * @param {Array<{id:string}>} [openInvites]
 * @param {CryptoPorts} [ports]
 * @returns {Promise<Rotation>}
 */
export async function buildRotation(spaceId, nextEpoch, spaceKeysByEpoch, myKexPriv, recipients, openInvites = [], ports) {
  const kind = spaceKindOf(spaceId);
  assertEpoch(nextEpoch, 'buildRotation');

  const invites = [];
  if (!Array.isArray(openInvites)) throw new SpaceKeyError('buildRotation: openInvites must be an array');
  for (const inv of openInvites) {
    if (!inv || typeof inv !== 'object' || typeof inv.id !== 'string' || inv.id.length === 0) {
      throw new SpaceKeyError('buildRotation: an open invite has no id');
    }
    for (const forbidden of ['wrappedKeys', 'wrapped', 'keys', 'epochKeys']) {
      if (inv[forbidden] !== undefined) {
        throw new SpaceKeyError(
          `buildRotation: invite ${inv.id} carries ${JSON.stringify(forbidden)}. PO decision D9: ` +
          'an invite carries NO key material — none attached, none stored against it, none ' +
          'derivable from the code (ADR 002 §7.1). Refusing rather than silently stripping it.'
        );
      }
    }
    invites.push({ id: inv.id, epoch: nextEpoch });
  }

  const wraps = await wrapRingToRecipients(spaceKeysByEpoch, myKexPriv, recipients, {
    ...ports, spaceId, upTo: nextEpoch,
  });

  return Object.freeze({
    spaceId,
    kind,
    epoch: nextEpoch,
    wraps,
    invites,
    coveredDevices: [...new Set(wraps.map((w) => w.deviceId))].sort(),
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 10b. THE WIRE — the ONE place this module speaks the relay's JSON.  Findings E2E3-1/2/3/4.
//
// ═══ WHY THIS SECTION EXISTS AT ALL ═══
//
// It did not, and that was the whole of the E2↔E3 seam. `buildRotation()` returns a `Rotation`
// in this module's own vocabulary; `POST /api/v1/spaces/:id/epoch` takes a body in the relay's.
// Nothing converted between them, so every caller converted by hand — and there was exactly one
// caller, `server/dev/two-client.js`, which hand-rolled its own `packWrap` and carried the sender's
// public key BY COURIER (its own comment: "STAND-IN: the wire carries no attestation"). A
// courier steps over every gap instead of hitting one, which is why both sides stayed green
// while four field mismatches sat between them:
//
//   E2E3-1  the client said `deviceId`; the relay requires `recipientId` — and the relay is
//           right, because a recipient may be `rec_<memberId>`, which is not a device id at all.
//   E2E3-2  the client emitted the `WrapBlob` OBJECT; the relay requires base64url BYTES, because
//           `OPAQUE_FIELDS.KeyWrap` refuses a String in that column and that refusal is what
//           makes RULE 1 ("a future handler cannot store a readable note") structural. So the
//           encoding moves to the client, not the column to the wire.
//   E2E3-3  `admitWraps` requires `row.senderKexPubRaw`; nothing carried it. The relay now
//           STAMPS the depositor it authenticated and publishes it as this exact field.
//   E2E3-4  `Rotation.invites` is refused by the relay as `retired_by_d9`. It stays a LOCAL
//           report — it is what refuses an invite arriving with key material — and never travels.
//
// ═══ THE RULE THIS SECTION IS ═══
//
//     ONE FUNCTION PER DIRECTION, AND NO OTHER CODE IN THIS MODULE KNOWS THE RELAY'S SPELLING.
//
// `rotationBody()` and `createSpaceWraps()` write it; `parseKeysResponse()` reads it. The
// internal `Recipient.deviceId` keeps its own name, which is fine precisely because it never
// crosses. A second translator anywhere is this bug again.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * `WrapBlob` → the base64url string the `KeyWrap.wrapped` column takes.
 *
 * (Named `encodeWrap`/`decodeWrap` rather than the obvious `packWrap`/`unpackWrap` for one
 * concrete reason: `tests/tier1/crypto-spacekeys.test.js`'s rule-6 guard asserts that no export
 * of this module matches `/kw/i`, because AES-KW over a P-256 private key is ADR 002 §1 rule 6's
 * trap and a prototype that only ever wraps a 32-byte AES key would never hit it. `pac{kW}rap`
 * trips that scan. The guard is worth more than the name.)
 *
 * Canonical JSON, so the same blob is the same bytes on both Macs and in the column — the blob
 * is not signed, but it IS an idempotency target (`putKeyWraps` upserts on
 * `(spaceId, epoch, recipientId)`), and two spellings of one value are two rows waiting to
 * happen. `canonicalBytes` is the same serialiser ADR 002 §2.3 and ADR 001 use.
 *
 * @param {WrapBlob} blob @returns {string}
 */
export function encodeWrap(blob) {
  if (!parseWrapBlob(blob)) {
    throw new SpaceKeyError('encodeWrap: not a WrapBlob — refusing to put unrecognised bytes on the wire');
  }
  return b64u(canonicalBytes({ v: WRAP_V, salt: blob.salt, iv: blob.iv, ct: blob.ct }));
}

/**
 * The inverse. **Peer data: `null`, never a throw** — the same contract as `parseWrapBlob`, and
 * for the same reason. Every failure has one answer: do not admit a key (§4.4).
 * @param {unknown} packed @returns {WrapBlob|null}
 */
export function decodeWrap(packed) {
  if (typeof packed !== 'string' || packed.length === 0 || packed.length > 4096) return null;
  let bytes;
  try {
    bytes = ub64(packed);
  } catch (err) {
    if (err instanceof CodecError) return null;
    throw err;
  }
  let blob;
  try {
    blob = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  return parseWrapBlob(blob) ? blob : null;
}

/**
 * `wrapToRecipients`/`wrapRingToRecipients` output → the relay's `wraps[]`.
 *
 * The rename is the fix for E2E3-1 and it is a correction, not a concession: `Recipient.deviceId`
 * already holds `rec_<memberId>` for a recovery recipient, so `recipientId` is the true name and
 * the relay had it right. Nothing else in this module changes name.
 *
 * @param {Array<{deviceId:string, epoch:number, wrapped:WrapBlob}>} wraps
 * @returns {Array<{recipientId:string, epoch:number, wrapped:string}>}
 */
export function wireWraps(wraps) {
  if (!Array.isArray(wraps)) throw new SpaceKeyError('wireWraps: expected the wrap rows from wrapToRecipients()');
  return wraps.map((w) => ({ recipientId: w.deviceId, epoch: w.epoch, wrapped: encodeWrap(w.wrapped) }));
}

/**
 * A `Rotation` → the exact JSON body of `POST /api/v1/spaces/:id/epoch`.
 *
 * **`invites` is deliberately absent** (finding E2E3-4). ADR 002 §4.2 step 3 predates PO decision
 * D9: an invite carries no key material, so there is nothing for a client to re-wrap, and the
 * relay refreshes every open invite's epoch itself. `rotateEpoch` refuses the KEY's presence —
 * not a non-empty list, the key — so a body spread from a `Rotation` was a 400 even with every
 * other field repaired. `Rotation.invites` survives as the local guard it is: `buildRotation`
 * REFUSES an invite object carrying `wrappedKeys`, which is how a caller still believing in the
 * pre-D9 seven-day read window finds out.
 *
 * **`senderDeviceId` is deliberately absent too** (finding E2E3-3, the other half). The relay
 * stamps the depositor from the request it authenticated; a client may not name it, and
 * `readWraps`'s closed field set 400s a body that tries. That is what makes the sender a fact
 * the relay observed rather than a claim it was handed.
 *
 * @param {Rotation} rotation @returns {{epoch:number, wraps:Array<Object>}}
 */
export function rotationBody(rotation) {
  if (!rotation || typeof rotation !== 'object') throw new SpaceKeyError('rotationBody: expected a Rotation');
  assertEpoch(rotation.epoch, 'rotationBody');
  return { epoch: rotation.epoch, wraps: wireWraps(rotation.wraps) };
}

/**
 * The `wraps` half of a `POST /api/v1/spaces` body. Same encoding, different envelope: creation
 * carries epoch 1 only, and the coverage rule is established there rather than checked.
 * @param {Array<{deviceId:string, epoch:number, wrapped:WrapBlob}>} wraps
 */
export const createSpaceWraps = wireWraps;

/**
 * `GET /api/v1/spaces/:id/keys` → the rows `admitWraps` takes.
 *
 * A row the relay mangled is DROPPED here rather than passed on as a shape `admitWraps` would
 * have to re-check: this function's whole job is to be the boundary, and a boundary that forwards
 * garbage is not one. Dropping is safe because it is indistinguishable, to the caller, from the
 * relay never having sent the row — which the relay can do anyway, and which §4.4's park already
 * covers.
 *
 * `senderKexPubRaw` is passed through UNTOUCHED and untrusted. `admitWraps` looks it up in a set
 * this module verified; it selects a sender and can never supply one (§6b).
 *
 * @param {unknown} body the parsed JSON response
 * @returns {{spaceId:string|null, currentEpoch:number|null, keysPending:boolean,
 *            rows:Array<{epoch:number, wrapped:WrapBlob, senderKexPubRaw:string|null}>,
 *            dropped:number}}
 */
export function parseKeysResponse(body) {
  const out = { spaceId: null, currentEpoch: null, keysPending: true, rows: [], dropped: 0 };
  if (!body || typeof body !== 'object') return out;
  if (typeof body.spaceId === 'string') out.spaceId = body.spaceId;
  if (isEpoch(body.currentEpoch)) out.currentEpoch = body.currentEpoch;
  out.keysPending = body.keysPending !== false;
  const rows = Array.isArray(body.wraps) ? body.wraps : [];
  for (const r of rows) {
    if (!r || typeof r !== 'object' || !isEpoch(r.epoch)) { out.dropped++; continue; }
    const wrapped = decodeWrap(r.wrapped);
    if (wrapped === null) { out.dropped++; continue; }
    out.rows.push({
      epoch: r.epoch,
      recipientId: typeof r.recipientId === 'string' ? r.recipientId : null,
      wrapped,
      senderKexPubRaw: typeof r.senderKexPubRaw === 'string' ? r.senderKexPubRaw : null,
    });
  }
  return out;
}

/**
 * Mint → persist into the ring → build the payload, in that order.
 *
 * The order is the point. The new key exists in the ring BEFORE any wrap is built, so a rotation
 * that fails half way leaves a device that can still read what it just sealed; the reverse order
 * leaves an epoch whose key was minted, wrapped and then dropped.
 *
 * `nextEpoch` is `ring.currentEpoch(spaceId) + 1`, so the first rotation of a brand-new space
 * mints epoch 1. The relay's `@@unique([spaceId, epoch])` makes the POST first-writer-wins: a
 * concurrent rotator gets `409 epoch_taken`, re-fetches its wraps, and either stops (it now holds
 * one) or retries at `e+2` (§4.2).
 *
 * @param {{ring:KeyRing, spaceId:string, myKexPriv:CryptoKey, recipients:Recipient[],
 *          openInvites?:Array<{id:string}>} & CryptoPorts} opts
 * @returns {Promise<Rotation & {key:CryptoKey}>}
 */
export async function rotateSpace(opts) {
  if (!opts || typeof opts !== 'object') throw new SpaceKeyError('rotateSpace: options are required');
  const { ring, spaceId, myKexPriv, recipients, openInvites = [] } = opts;
  assertRing(ring, 'rotateSpace');
  spaceKindOf(spaceId);

  const nextEpoch = ring.currentEpoch(spaceId) + 1;
  const key = await createSpaceKey(opts);
  if (!ring.put(spaceId, nextEpoch, key)) {
    throw new SpaceKeyError(`rotateSpace: the ring already holds ${spaceId} epoch ${nextEpoch}`);
  }
  const rotation = await buildRotation(
    spaceId, nextEpoch, ring.keysByEpoch(spaceId), myKexPriv, recipients, openInvites, opts
  );
  return Object.freeze({ ...rotation, key });
}

/**
 * Admit every wrap the relay returned for this device (`GET /api/v1/spaces/:id/keys` returns
 * every wrap addressed to it, ALL epochs — §4.4).
 *
 * **`ctx.senders` IS REQUIRED — it is the fix for finding S1 and it has no default.** See §6b
 * above for why it is a parameter rather than a branch. It is the `Recipient[]` from
 * `personalRecipients()` / `familyRecipients()`, or a `SenderSet` from `admissibleSenders()` when
 * the caller wants to verify once and admit many times.
 *
 * THE ORDER OF THE THREE OUTCOMES IS ITSELF A DECISION:
 *
 *   1. `ring.has(spaceId, epoch)` short-circuits FIRST, so a slot this device already holds is a
 *      `duplicate` whoever sent the row. First-write-wins has already decided; an unauthenticated
 *      row at an occupied epoch never gets as far as an authentication question and could not
 *      change the answer if it did. (D9's ordinary case — two member devices both wrapping the
 *      ring to a joiner, §7.1 step 4 — lands here and must stay quiet.)
 *   2. Then the SENDER: `row.senderKexPubRaw` is looked up in the verified set. A miss is
 *      `unauthorized` — counted separately from `refused`, because "a stranger tried to give me a
 *      key" and "a wrap did not open" are different events and only one of them is a security
 *      event a caller may want to surface.
 *   3. Only then the AEAD. A blob that does not open is counted, not thrown on: the ordinary
 *      cause is a wrap addressed to a sibling device, and the answer is the same as for an unknown
 *      epoch — park, and re-evaluate when more arrives (§4.4).
 *
 * `unauthorized` is folded into `refused` as well, so the pre-S1 report shape keeps its meaning
 * ("how many rows did not become keys") for any caller that only reads that.
 *
 * @param {KeyRing} ring
 * @param {Array<{epoch:number, wrapped:WrapBlob, senderKexPubRaw:Uint8Array|string}>} rows
 * @param {{spaceId:string, myKexPriv:CryptoKey, senders:Recipient[]|SenderSet} & CryptoPorts} ctx
 * @returns {Promise<{admitted:number[], refused:number, duplicates:number, unauthorized:number,
 *                    unauthorizedEpochs:number[]}>}
 */
export async function admitWraps(ring, rows, ctx) {
  assertRing(ring, 'admitWraps');
  if (!ctx || typeof ctx !== 'object') throw new SpaceKeyError('admitWraps: a {spaceId, myKexPriv, senders} context is required');
  const { spaceId, myKexPriv } = ctx;
  spaceKindOf(spaceId);
  if (!Array.isArray(rows)) throw new SpaceKeyError('admitWraps: rows must be an array');
  if (ctx.senders === undefined || ctx.senders === null) {
    throw new SpaceKeyError(
      'admitWraps: `ctx.senders` is REQUIRED and has no default. Every row here is relay data, ' +
      'and without the set of devices this space may accept a key FROM, `senderKexPubRaw` is an ' +
      'attacker-chosen ECDH key that decides which key this device will seal its own private ' +
      'entries under (finding S1; ADR 002 §4.2 step 2, §4.4). Pass the Recipient[] from ' +
      'personalRecipients()/familyRecipients(), or a SenderSet from admissibleSenders(). Pass an ' +
      'EMPTY array to mean "I can authenticate nobody yet" — every row is then refused and the ' +
      'ops stay parked, which is the correct state between §7.1 steps 2 and 6.'
    );
  }
  const senders = await admissibleSenders(ctx.senders, spaceId, ctx);

  const admitted = [];
  let refused = 0;
  let duplicates = 0;
  const unauthorizedEpochs = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !isEpoch(row.epoch)) { refused++; continue; }
    if (ring.has(spaceId, row.epoch)) { duplicates++; continue; }

    // THE ROW SELECTS A SENDER; IT CANNOT SUPPLY ONE. `senderKexPubRaw` is an index into the
    // verified set — absent, malformed, or simply not one of us all give the same `null` — and
    // the `CryptoKey` below was imported from the sender's own VERIFIED attestation, never from
    // these bytes.
    const sender = senders.lookup(row.senderKexPubRaw);
    if (sender === null) {
      refused++;
      unauthorizedEpochs.push(row.epoch);
      continue;
    }

    const key = await unwrapSpaceKey(row.wrapped, myKexPriv, sender.kexPub, { ...ctx, spaceId, epoch: row.epoch });
    if (key === null) { refused++; continue; }
    if (ring.put(spaceId, row.epoch, key, { how: 'admitted', deviceId: sender.deviceId, memberId: sender.memberId })) {
      admitted.push(row.epoch);
    } else duplicates++;
  }
  admitted.sort((a, b) => a - b);
  unauthorizedEpochs.sort((a, b) => a - b);
  return { admitted, refused, duplicates, unauthorized: unauthorizedEpochs.length, unauthorizedEpochs };
}
