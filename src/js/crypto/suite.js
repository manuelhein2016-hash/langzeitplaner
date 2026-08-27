// src/js/crypto/suite.js — `LZP-CRYPTO-1`.  ADR 002 §1, §3's label table, §9.2.
//
// DOM-free, I/O-free, dependency-free (ADR 005 §2). Constants and shape-builders only: this
// file performs no cryptography, so it can be imported by anything — including a probe that
// runs before we know the engine can do any of it.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SUITE IS DECIDED. IT IS NOT NEGOTIATED. (ADR 002 §1, §11 rule 1)
// ─────────────────────────────────────────────────────────────────────────────
//
//   signing / device identity / request auth : ECDSA P-256 / SHA-256
//   key agreement (wrapping space keys)      : ECDH  P-256 -> HKDF-SHA-256 -> AES-256-GCM KEK
//   content encryption                       : AES-256-GCM, 12-byte IV, tagLength 128, non-empty AAD
//   derivation                               : HKDF-SHA-256 (salt mandatory)
//   backup passphrase                        : PBKDF2-SHA-256, 600 000 iterations -> AES-256-GCM
//
// P-256 and not Curve25519 because WKWebView is the binding constraint: X25519 shipped only in
// Safari 18.4 and macOS Monterey never receives it, while ECDSA/ECDH P-256 have shipped since
// Safari 7/11. That keeps `minimumSystemVersion` at 12.0 and adds no dependency. There is ONE
// suite, pinned by `Envelope.v`, replaced wholesale if it is ever replaced. There is deliberately
// **no downgrade-negotiation surface** — it would be a liability with no upside against a blind
// relay — so nothing in this file is a "preferred" or "minimum" anything.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SEVEN ENGINE-DIFFERENCE RULES (ADR 002 §1) ARE PART OF THIS CONTRACT
// ─────────────────────────────────────────────────────────────────────────────
// Each is a bug that only shows up on one engine, at night. Where a rule can be encoded as a
// value or a guard rather than as a comment, it is, and the exports below say which:
//
//   1. Never compare signature bytes. WebCrypto ECDSA is non-deterministic in BOTH engines —
//      assert `verify() === true`. No golden-signature fixtures, no signature as an idempotency
//      key, no content address containing `sig`.
//   2. Never sign or verify a zero-length payload. -> `assertSignable()` below.
//   3. Never branch on error NAMES. Node says `InvalidAccessException` where WebKit says
//      `InvalidAccessError`. Branch on try/catch boundaries only.
//   4. `HkdfParams.salt` is MANDATORY in both engines; omitting it is a TypeError. -> `hkdf()`
//      takes the salt as a required positional argument and refuses `undefined`.
//   5. Import a peer's ECDH public key with `keyUsages: []`; a non-empty array is a SyntaxError.
//      -> `USAGES.peerKex`, which is a frozen empty array.
//   6. Never AES-KW a P-256 private key: PKCS#8 is 138 bytes, not a multiple of 8, so AES-KW
//      raises `OperationError`. Use AES-GCM for ALL key wrapping. -> `PKCS8_P256_BYTES` is
//      exported precisely so the arithmetic is checkable, and there is no AES-KW constant here
//      to reach for. (The trap: 25519 PKCS#8 is 48 bytes and DOES work, so a 25519 prototype
//      hides this.)
//   7. Node has no `indexedDB`, and `isSecureContext` is `undefined` there — not `false`. Both
//      engines report `isSecureContext === true` under the shell's `app://localhost` scheme.
//      -> `src/js/platform/keystore.js` owns that asymmetry; nothing here touches either.
//
// AN EIGHTH, FOUND BY LZP-302 AND NOT IN §1's TABLE — see `src/js/platform/keystore.js`:
// WebKit's structured clone of a `CryptoKey` needs a WebCrypto master key it fetches from the
// macOS Keychain. When the Keychain is unreachable the IndexedDB `put()` throws `DataCloneError`,
// which looks like a serialisation bug and is really a custody failure.

// ─────────────────────────────────────────────────────────────────────────────
// 0. Identity of the suite
// ─────────────────────────────────────────────────────────────────────────────

/** The one suite. Logged in the LZP-1003 self-audit report and asserted in LZP-1005. */
export const SUITE_ID = 'LZP-CRYPTO-1';

/** `Envelope.v`. A client meeting a `v` it does not know PARKS the op (ADR 001 §7.4). */
export const ENVELOPE_V = 1;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Algorithm parameters
//
// SIG and SIGOP are DIFFERENT SHAPES for the same algorithm and mixing them up is the classic
// P-256 bug: `generateKey`/`importKey` want `namedCurve`, `sign`/`verify` want `hash`. Passing
// SIG to sign() raises an error whose NAME differs between the engines (rule 3), so the failure
// is unpleasant to diagnose. They are separate frozen objects for that reason.
// ─────────────────────────────────────────────────────────────────────────────

/** generateKey / importKey params for the signing keys. */
export const SIG = Object.freeze({ name: 'ECDSA', namedCurve: 'P-256' });

/** sign / verify params. DIFFERENT SHAPE from SIG. */
export const SIGOP = Object.freeze({ name: 'ECDSA', hash: 'SHA-256' });

/** generateKey / importKey params for the key-agreement keys. */
export const KEX = Object.freeze({ name: 'ECDH', namedCurve: 'P-256' });

/** Content encryption. `ivBytes` is 12 because GCM's counter construction is defined for 96-bit
 *  IVs and any other length costs an extra GHASH pass for no benefit. */
export const AEAD = Object.freeze({ name: 'AES-GCM', length: 256, tagLength: 128, ivBytes: 12 });

/** Derivation. `salt` is mandatory in both engines (rule 4) so it is not defaulted here. */
export const KDF = Object.freeze({ name: 'HKDF', hash: 'SHA-256' });

/** The backup passphrase KDF (ADR 002 §7.2, D8). 600 000 is the OWASP 2023 PBKDF2-SHA-256 floor. */
export const BACKUP_KDF = Object.freeze({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600000 });

/** The digest every hash in this product uses. */
export const HASH = 'SHA-256';

/** Plaintext is padded to a multiple of this before encryption (ADR 002 §5.3). */
export const PAD_BUCKET = 256;

// ─────────────────────────────────────────────────────────────────────────────
// 2. Verified sizes (ADR 002 §9.2 — measured in Node 22 and WKWebView alike)
//
// These are assertions about the engines, not preferences. `tests/tier1/crypto-identity.test.js`
// and `tests/tier2/crypto-identity.dom.js` check every one of them against a real key, which is
// what turns this block from documentation into a tripwire.
// ─────────────────────────────────────────────────────────────────────────────

/** Uncompressed P-256 point, `0x04 || X || Y`. The wire format for every public key. */
export const RAW_PUBKEY_BYTES = 65;
/** SubjectPublicKeyInfo for P-256. Not used on the wire; checked so a format swap is visible. */
export const SPKI_P256_BYTES = 91;
/** PKCS#8 for a P-256 private key. **138 is not a multiple of 8** — this is rule 6's arithmetic. */
export const PKCS8_P256_BYTES = 138;
/** A P-256 private key wrapped under AES-GCM: 138 + 16 tag. */
export const WRAPPED_PKCS8_BYTES = 154;
/** The symmetric space keys and the device encryption key are all 256-bit. */
export const SYMMETRIC_KEY_BYTES = 32;
/** HKDF salt width wherever this product chooses one (`WrapBlob.salt`). */
export const SALT_BYTES = 32;
/** SHA-256 output. */
export const DIGEST_BYTES = 32;
/** `deviceShort` = crock32(SHA-256(rawSigPub)[0..10]) — 10 bytes -> 16 characters (ADR 001 §1.2). */
export const DEVICE_SHORT_PREFIX_BYTES = 10;
/** …and therefore this many Crockford characters. */
export const DEVICE_SHORT_CHARS = 16;

// ─────────────────────────────────────────────────────────────────────────────
// 3. Key usages
//
// Every one of these is a real constraint, not decoration. Rule 5 lives here: a peer's ECDH
// public key MUST be imported with `keyUsages: []`, because a non-empty array is a SyntaxError
// in both engines — ECDH usages belong to the PRIVATE half, and the public half of an agreement
// has no usage at all.
// ─────────────────────────────────────────────────────────────────────────────

export const USAGES = Object.freeze({
  /** Our own signing pair, at `generateKey` — which splits the list across the two halves. */
  sig: Object.freeze(['sign', 'verify']),
  /**
   * Our own signing PRIVATE key, at `importKey`/`unwrapKey`.
   *
   * `generateKey` is forgiving and hands `['sign','verify']` out to the right halves. `importKey`
   * is not: a private EC key carrying `verify` is a **`SyntaxError`** — "Unsupported key usage for
   * a ECDSA key" in Node, an equivalent refusal in WebKit. It is the same class of trap as rule 5
   * (`keyUsages: []` for a peer's ECDH public key), one algorithm along, and it only appears on
   * the RESTORE path, which is the path a developer exercises last.
   */
  sigPrivate: Object.freeze(['sign']),
  /** Our own agreement pair. `deriveKey` too, so `wrapKek` can go straight to an AES-GCM KEK. */
  kex: Object.freeze(['deriveBits', 'deriveKey']),
  /** Our own agreement PRIVATE key at `importKey` — the same list; ECDH has no public usages. */
  kexPrivate: Object.freeze(['deriveBits', 'deriveKey']),
  /** A peer's signing public key: verification only. We never sign with someone else's key. */
  peerSig: Object.freeze(['verify']),
  /** RULE 5. A peer's ECDH public key. MUST be empty. */
  peerKex: Object.freeze([]),
  /** A derived KEK, or a space key. */
  aead: Object.freeze(['encrypt', 'decrypt']),
  /** A KEK that also wraps and unwraps key material. */
  kek: Object.freeze(['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']),
  /** HKDF / PBKDF2 input keying material. */
  derive: Object.freeze(['deriveBits', 'deriveKey']),
});

/** `extractable` for the two per-DEVICE pairs. false ⇒ the private bytes never enter the JS heap. */
export const DEVICE_KEY_EXTRACTABLE = false;
/** `extractable` for the two per-MEMBER recovery pairs — they must reach the backup file (§7.2). */
export const RECOVERY_KEY_EXTRACTABLE = true;

// ─────────────────────────────────────────────────────────────────────────────
// 4. HKDF info labels — PART OF THE WIRE FORMAT (ADR 002 §3)
//
// Changing one of these strings does not "rename" anything; it derives a different key, and the
// symptom on the far side is an `OperationError` from AES-GCM, not a mismatch anyone can read.
// ─────────────────────────────────────────────────────────────────────────────

export const INFO = Object.freeze({
  spaceKeyWrap: 'lzp/v2/space-key-wrap',
  pairRid: 'lzp/v2/pair/rid',
  pairCk: 'lzp/v2/pair/ck',
  pairSas: 'lzp/v2/pair/sas',
  pairKek: 'lzp/v2/pair/kek',
  inviteId: 'lzp/v2/invite/id',
  inviteVerify: 'lzp/v2/invite/verify',
  backup: 'lzp/v2/backup',
  deviceDek: 'lzp/v2/device/dek',
});

/**
 * `lzp/v2/invite/wrap` is RETIRED by PO decision D9 (2026-08-25): an invite carries no key
 * material of any kind — none attached, none stored against it on the server, none derivable
 * from the code. It is listed here rather than deleted so that a downstream agent who finds the
 * label in the superseded §7.1 text, or in a stale draft, meets a refusal instead of silently
 * re-introducing the seven-day read window the PO removed. `infoBytes()` throws on it.
 */
export const RETIRED_INFO = Object.freeze(['lzp/v2/invite/wrap']);

const KNOWN_INFO = new Set(Object.values(INFO));
const RETIRED = new Set(RETIRED_INFO);

const TE = new TextEncoder();

/**
 * The bytes of an HKDF `info` label, refusing anything that is not one of the fixed strings.
 *
 * The whitelist is the point. `info` is a wire-format field with no error reporting: a typo
 * derives a different key and surfaces three layers away as "this family member's ops will not
 * decrypt". A typo caught here is one line; a typo shipped is a support incident.
 *
 * @param {string} label one of `INFO`'s values
 * @returns {Uint8Array}
 */
export function infoBytes(label) {
  if (RETIRED.has(label)) {
    throw new Error(
      `suite: the HKDF label ${JSON.stringify(label)} is RETIRED by PO decision D9 — ` +
      'invites carry no key material. See ADR 002 §7.1.'
    );
  }
  if (!KNOWN_INFO.has(label)) {
    throw new Error(
      `suite: ${JSON.stringify(label)} is not one of the fixed HKDF info labels ` +
      '(ADR 002 §3). Adding one is a wire-format change.'
    );
  }
  return TE.encode(label);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Parameter builders that encode a rule
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RULE 4 — `HkdfParams.salt` is mandatory in both engines; omitting it is a `TypeError` whose
 * message differs between them, which is exactly the kind of failure rule 3 says not to read.
 * So the salt is a REQUIRED positional argument here and `undefined` is refused loudly, in our
 * own words, before WebCrypto ever sees it.
 *
 * Pass `NO_SALT` when you genuinely mean "no salt" — the ADR's own instruction. Writing it out
 * makes the intent reviewable; leaving the argument off makes it a bug.
 *
 * @param {Uint8Array} salt
 * @param {string} label one of `INFO`'s values
 * @returns {{name:'HKDF', hash:'SHA-256', salt:Uint8Array, info:Uint8Array}}
 */
export function hkdf(salt, label) {
  if (!(salt instanceof Uint8Array)) {
    throw new Error(
      'suite.hkdf: salt is MANDATORY (ADR 002 §1 rule 4) and must be a Uint8Array. ' +
      'Pass NO_SALT if you mean none.'
    );
  }
  return { name: KDF.name, hash: KDF.hash, salt, info: infoBytes(label) };
}

/** The explicit "no salt" value rule 4 tells callers to pass. Zero-length, so nothing to mutate. */
export const NO_SALT = new Uint8Array(0);

/**
 * @param {Uint8Array} salt
 * @param {number} [iterations]
 * @returns {{name:'PBKDF2', hash:'SHA-256', salt:Uint8Array, iterations:number}}
 */
export function pbkdf2(salt, iterations = BACKUP_KDF.iterations) {
  if (!(salt instanceof Uint8Array) || salt.length === 0) {
    throw new Error('suite.pbkdf2: a non-empty salt is required');
  }
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new Error('suite.pbkdf2: iterations must be a positive integer');
  }
  return { name: BACKUP_KDF.name, hash: BACKUP_KDF.hash, salt, iterations };
}

/**
 * @param {Uint8Array} iv 12 bytes
 * @param {Uint8Array} additionalData ALWAYS non-empty (ADR 002 §5.1, §11 rule 3)
 * @returns {{name:'AES-GCM', iv:Uint8Array, additionalData:Uint8Array, tagLength:128}}
 */
export function aesgcm(iv, additionalData) {
  if (!(iv instanceof Uint8Array) || iv.length !== AEAD.ivBytes) {
    throw new Error(`suite.aesgcm: iv must be exactly ${AEAD.ivBytes} bytes`);
  }
  if (!(additionalData instanceof Uint8Array) || additionalData.length === 0) {
    throw new Error(
      'suite.aesgcm: the AAD must be non-empty (ADR 002 §1 rule 2 / §5.1). ' +
      'An envelope AAD always carries v, sp, ep, dv, oid and wit, so an empty one is a bug.'
    );
  }
  return { name: AEAD.name, iv, additionalData, tagLength: AEAD.tagLength };
}

/**
 * RULE 2 — never sign or verify a zero-length payload.
 *
 * WebKit's `verify()` returns **`false`** for Ed25519 over an empty message even for a valid
 * reference signature, and a silent `false` on a valid signature is the worst possible failure
 * shape for a sync protocol. ECDSA is not known to have that flaw in either engine, but the
 * guard costs nothing, documents the hazard where it would bite, and means no future change of
 * signing algorithm re-opens it. Every `sign`/`verify` call site in `src/js/crypto/` goes
 * through this.
 *
 * @param {Uint8Array} bytes
 * @param {string} who call-site name, for the message
 * @returns {Uint8Array} the same bytes, so this can wrap an argument inline
 */
export function assertSignable(bytes, who) {
  if (!(bytes instanceof Uint8Array)) throw new Error(`${who}: expected bytes to sign or verify`);
  if (bytes.length === 0) {
    throw new Error(`${who}: refusing a zero-length payload (ADR 002 §1 rule 2)`);
  }
  return bytes;
}
