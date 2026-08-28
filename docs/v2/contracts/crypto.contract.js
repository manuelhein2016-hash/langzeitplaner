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
//
// ─────────────────────────────────────────────────────────────────────────────
// DELIVERED 2026-08-27 — LZP-302. §0, §1 and §2 below are IMPLEMENTED and proved in BOTH engines:
//   src/js/crypto/suite.js · src/js/crypto/probe.js · src/js/crypto/identity.js
//   src/js/platform/keystore.js  ← the ONLY stateful piece; §2's three stores live HERE, not in
//                                  crypto/, which stays DOM-free and I/O-free (ADR 005 §2)
//   tests/tier1/crypto-identity.test.js (62) · tests/tier2/crypto-identity.dom.js (26)
//   tests/tier2/crypto-keystore-phase1.dom.js + -phase2.dom.js (12, TWO app launches)
// §3 is DELIVERED 2026-08-27 — LZP-303: `src/js/crypto/spacekeys.js`, with
//   tests/tier1/crypto-spacekeys.test.js (38) · tests/tier2/crypto-spacekeys.dom.js (11).
//   Its header lists five deliberate deviations from the signatures sketched there; read them.
// §4 is DELIVERED 2026-08-27 — LZP-304: `src/js/crypto/envelope.js`, with
//   tests/tier1/crypto-envelope.test.js (52) · tests/tier2/crypto-envelope.dom.js (19).
// §5 is DELIVERED 2026-08-27 — LZP-306: `src/js/crypto/pairing.js`, with
//   tests/tier1/crypto-pairing.test.js (57) · tests/tier2/crypto-pairing.dom.js (13) ·
//   the hostile relay `tests/helpers/mitm.js`.
// §7 is DELIVERED 2026-08-27 — LZP-305: `src/js/crypto/backup.js`, with
//   tests/tier1/crypto-backup.test.js (78) · tests/tier2/crypto-backup.dom.js (21).
// §6 (invites) is **NOT DELIVERED and two of its three functions are RETIRED by D9** — read §6.
//
// E3 INTEGRATION 2026-08-27: the eight numbered product guarantees these seven files exist to
// support are asserted end-to-end, one test each, in `tests/tier1/crypto-guarantees.test.js`,
// and the ticket-by-ticket evidence is `docs/v2/E3-VERIFICATION.md`. A module suite proves a
// module; that file proves the COMPOSITION, which is where a guarantee actually fails.
//
// TWO THINGS LZP-302 LEARNED THAT ARE NOT IN THE SEVEN RULES, AND THAT §3-§7 WILL HIT:
//
//   8. **WebKit cannot structured-clone a `CryptoKey` without the login Keychain.** A persisted
//      CryptoKey is encrypted under a per-application "WebCrypto master key" WebKit keeps as a
//      Keychain generic password whose ACL is bound to the CODE SIGNATURE of the binary that
//      created it. Rebuild or re-sign the app — which `LZP-102`'s updater does on every update —
//      and WebKit can no longer read it: it logs `Cannot store WebCrypto master key, error
//      -25299` to the PROCESS's stderr, where the page cannot see it, and from then on
//      `put()` rejects with `DataCloneError` and previously-stored keys read back as **null**.
//      Plain values in the same database are untouched, which is what makes it hard to spot.
//      ⇒ code signing with a stable identity is a PREREQUISITE of §2.2's custody design, not a
//      packaging detail. `idbKeyStore.put` reports this as `KeyStoreUnavailableError`.
//   9. **`importKey`/`unwrapKey` of a PRIVATE EC key must carry ONLY the private usages.**
//      `generateKey` accepts `['sign','verify']` and splits it across the pair; `importKey` of
//      the private half with `verify` in the list is a `SyntaxError` in both engines. Same class
//      of trap as rule 5, one algorithm along, and it only bites on the RESTORE path — the path
//      a developer exercises last. `suite.js` exports `USAGES.sigPrivate` / `USAGES.kexPrivate`.

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

// `src/js/crypto/suite.js` implements the block above and adds the guards that turn four of the
// seven rules from comments into code. Use these rather than hand-building a params object:
//
//   SUITE_ID · ENVELOPE_V              the suite name and the envelope version
//   infoBytes(label)                   the bytes of an `INFO` label, WHITELISTED. `lzp/v2/invite/wrap`
//                                      throws by name (D9) so a stale draft cannot re-create the
//                                      seven-day read window; an unknown label throws too, because
//                                      a typo derives a different key and surfaces three layers
//                                      away as "this member's ops will not decrypt"
//   hkdf(salt, label)                  RULE 4 — `salt` is a REQUIRED positional argument
//   NO_SALT                            the explicit "I mean none" value rule 4 tells you to pass
//   pbkdf2(salt, iterations)           defaults to BACKUP_KDF.iterations (600 000)
//   aesgcm(iv, aad)                    refuses a wrong-length IV and an EMPTY AAD
//   assertSignable(bytes, who)         RULE 2 — refuses a zero-length payload
//   USAGES.peerKex                     RULE 5 — a frozen EMPTY array
//   USAGES.sigPrivate / .kexPrivate    engine difference 9 — private-half usages for importKey
//   RAW_PUBKEY_BYTES 65 · SPKI_P256_BYTES 91 · PKCS8_P256_BYTES 138 · WRAPPED_PKCS8_BYTES 154
//                                      RULE 6's arithmetic, checkable: 138 is not a multiple of 8

// ─────────────────────────────────────────────────────────────────────────────
// 1. Capability probe  (ADR 002 §9.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ~1 ms (measured: 10 ms in WKWebView, first call, cold). A GUARD, not a gate: it runs at the
 * moment the user first touches "Familienkreis erstellen / beitreten" or "Gerät koppeln" —
 * NEVER in solo mode and NEVER on first run (Principle 7, story 15.1).
 *
 * That "never" is enforced mechanically, not remembered: `tests/tier1/crypto-identity.test.js`
 * walks the import graph of `boot.js`, `firstrun.js` and `main.js` and fails if anything under
 * `src/js/crypto/` is REACHABLE from any of them. An import is evaluated whether or not anyone
 * calls the function, so a reachability check is the honest form of "solo mode generates nothing".
 *
 * ⚠ `ok` IS NOT THE GATE. `ok` means "this engine has a SubtleCrypto" — ADR 002 §9.1's field,
 * kept with exactly that meaning. **`usable`** means "this engine can run LZP-CRYPTO-1", i.e. all
 * five rows are true, and it is what the family entry point must branch on. A caller that gated
 * on `ok` alone would enable family mode on an engine with `crypto.subtle` and no ECDH. Use
 * `isSuiteAvailable(result)` rather than re-deriving it. `unavailableMessage(result)` returns the
 * one plain German (and English) sentence for the disabled state; it deliberately names no
 * algorithm and says that the existing board is unaffected.
 *
 * @param {{subtle?:SubtleCrypto}} [ports] injected so a test can hand it a crippled engine
 * @returns {Promise<{ok:boolean, why?:string, aesgcm?:boolean, hkdf?:boolean,
 *                     pbkdf2?:boolean, ecdsa?:boolean, ecdh?:boolean,
 *                     suite:string, usable:boolean, missing:string[]}>}
 */
export async function probeCrypto(ports) { throw new Error('not implemented'); }

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

// The three stores live in `src/js/platform/keystore.js` — NOT under `src/js/crypto/`, which is
// DOM-free and I/O-free and takes the `KeyStore` above as a PORT (ADR 005 §2).

/**
 * WebKit: structured-cloned non-extractable CryptoKeys in IndexedDB. The PRIMARY store.
 *
 * ADR 002 §2.2's open verification item is **ANSWERED: YES.** A non-extractable `CryptoKey`
 * persists across an app relaunch under `app://localhost`, comes back with
 * `extractable === false`, still signs, still verifies under the public point recorded by the
 * previous process, and `exportKey` still REJECTS. Proved by two separate launches of the real
 * shell — `tests/tier2/crypto-keystore-phase1.dom.js` writes, its process exits,
 * `-phase2.dom.js` is a new process that reads. No downgrade to `identity.enc` is needed and
 * none is recorded in `DESIGN-DECISIONS.md`.
 *
 * The caveat is engine difference 8 in this file's header: that persistence depends on a
 * Keychain item bound to the app's code signature. `put` reports its loss as
 * `KeyStoreUnavailableError`, which means CUSTODY IS UNAVAILABLE — not "bad key material".
 *
 * @param {{factory?:IDBFactory, dbName?:string, storeName?:string, version?:number}} [opts]
 *        `factory` and `dbName` are injected so a test never writes into the shipping database.
 * @returns {KeyStore & {destroy:() => Promise<void>}}
 */
export function idbKeyStore(opts) { throw new Error('not implemented'); }

/**
 * Dev/browser, and the Keychain backstop's own format: AES-GCM-wrapped PKCS#8 under the DEK.
 *
 * **EXTRACTABLE KEYS ONLY.** `wrapKey` requires the key to be extractable and `IK_sig`/`IK_kex`
 * are generated `extractable: false` precisely so that no code path can turn them into bytes, so
 * this store REFUSES a device key. That refusal is a tripwire, not a limitation: a device key
 * reaching a file store would mean the non-extractability guarantee had already been given up
 * upstream. Device keys live in IndexedDB or they do not live.
 *
 * @param {{read:Function, write:Function, remove:Function, keys:Function}} bytes
 * @param {{dek:Uint8Array, subtle?:SubtleCrypto, random?:Function}} opts see `ensureDek`
 */
export function fileKeyStore(bytes, opts) { throw new Error('not implemented'); }

/** Node/CI: in memory. Node 22 has no indexedDB — this asymmetry is explicit in LZP-1005, and it
 *  is NOT shimmed: a fake IndexedDB would have turned an unverified design into one that merely
 *  LOOKED verified. Nothing in tier 1 says anything about persistence. */
export function memKeyStore() { throw new Error('not implemented'); }

/** The fallback chain, reporting WHICH store it gave you. `'memory'` means nothing survives a
 *  quit, so a pairing flow must refuse to run against it outside a test — an attestation minted
 *  over a key that will not exist tomorrow is worse than no pairing at all.
 *  @returns {{kind:'indexeddb'|'memory', store:KeyStore}} */
export function chooseKeyStore(opts) { throw new Error('not implemented'); }

/** The three shell commands ADR 002 §2.2 adds to `shell-macos/main.swift` (and, UNVERIFIED, to
 *  `src-tauri/src/lib.rs`): `keychain_set` / `keychain_get` / `keychain_delete`, service
 *  `org.langzeitplaner.keys`, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` — ThisDeviceOnly
 *  because §8.12 says the recovery key has no revocation, and iCloud sync would widen that
 *  residual to every device on the Apple ID. A HEADLESS run uses a separate service name.
 *  @param {(cmd:string, args?:object) => Promise<any>} invoke */
export function keychainPort(invoke) { throw new Error('not implemented'); }

/** The 32-byte device encryption key (§2.1, §2.2), minted once into the Keychain. It wraps
 *  exactly one thing — the recovery identity's PKCS#8, beside it. It is NOT a master key: `PSK`
 *  and `FSK_e` have no derivation path to it or to each other (§3 barrier 1).
 *  @returns {Promise<Uint8Array>} 32 bytes */
export async function ensureDek(keychain, ports) { throw new Error('not implemented'); }

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

/**
 * Generates NOTHING in solo mode. Idempotent, and DELIBERATELY BRITTLE about partial state:
 * three records make one identity (`dev/sig`, `dev/kex`, `dev/meta`); all three ⇒ return it,
 * none ⇒ mint, **anything in between throws**. Regenerating over a half-written store would mint
 * a SECOND `deviceShort` for a Mac that already has an attested one, and every op the old short
 * authored would suddenly be from a device nobody attested. A loud failure the user can be told
 * about is strictly better. It also refuses to re-point an existing device at another member.
 *
 * `deviceId` and `createdAt` are required ONLY on the minting path and are INJECTED — nothing
 * under `src/js/crypto/` reads a clock (ADR 005 §2).
 *
 * @param {KeyStore} ks @param {string} memberId
 * @param {{deviceId?:string, createdAt?:string, subtle?:SubtleCrypto, random?:Function}} [opts]
 * @returns {Promise<Identity>}
 */
export async function ensureDeviceIdentity(ks, memberId, opts) { throw new Error('not implemented'); }

/** Same discipline, for a stronger reason: §8.12 records that the recovery key has NO
 *  REVOCATION, so regenerating it silently would orphan the member from their own Familienkreis
 *  with no way back and no way to notice.
 *  @param {KeyStore} ks @returns {Promise<{memberId:string, createdAt:string,
 *           recSig:CryptoKeyPair, recKex:CryptoKeyPair}>} */
export async function ensureRecoveryIdentity(ks, memberId, opts) { throw new Error('not implemented'); }

/** Mint + self-attest in one call — the shape §6.3 step 8 (pairing) and §7.3 step 4 (recovery)
 *  both need. A restored member always gets FRESH device keys: a device is a machine, not a
 *  person. @returns {Promise<{identity:Identity, attestation:DeviceAttestation, blob:string}>} */
export async function ensureAttestedDevice(ks, memberId, recSigPriv, opts) { throw new Error('not implemented'); }

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
 *
 * This is the async half of what `foldAuthorized` takes as the SYNCHRONOUS injection
 * `ctx.attestOpen(memberId, blob) => DeviceAttestation|null` (ADR 001 §4.0, ADR 002 §5.2.3;
 * `ctx.attestVerify`, the WP-1 boolean, is still accepted). The fold is pure and synchronous, so
 * WP-6 must pre-resolve verification into a sync closure rather than hand it a Promise. Two
 * obligations on that closure:
 *   · it is called with the HOUSING member's id — the member whose record the register sits in,
 *     never the payload's self-declared `att.memberId` (§2.3 condition (4)); and
 *   · it MUST also check `deviceShortOf(att.sigPubRaw) === att.deviceShort` (§5.2.2 P2). The
 *     fold cannot: the binding is a SHA-256 and nothing in `authz.js` may await. Enforcing it
 *     here is what makes an attestation SELF-CONSISTENT — see `AuthzResult.shortCollisions`.
 *     [Was SHOULD; raised to MUST 2026-08-27, finding I-3.]
 *     [CORRECTED 2026-08-28. The bracket that stood here said P2 "makes `deviceShort ->
 *     DeviceAttestation` a real function instead of an argued one" and "is what restores"
 *     liveness on a squatted short. BOTH CLAIMS WERE FALSE and were measured false: `sigPubRaw`
 *     is a PUBLIC key travelling in the victim's own register, so the squatter copies the key
 *     AND the short together, tells the truth about the binding, and passes P2 — a remedy that
 *     binds two fields cannot catch an attacker who copies both. P2 stays a MUST, because it
 *     stops a member inventing a short unrelated to any key and it is the check this layer CAN
 *     make; it is not the check that makes the lookup a function. That is
 *     `devOf(cell.stamp) === att.deviceShort` at fold time — see `AuthzResult.unprovenShorts`
 *     and ADR 002 §2.3 "One short, one signer".]
 * The fold publishes the payload decoded from the REGISTER BYTES, not the one this returns, and
 * treats a disagreement between the two as a failed verification — on ALL SIX fields, `kexPubRaw`
 * and `createdAt` included (R4-15a). An opener that may disagree about `kexPubRaw` while still
 * being believed is a key-injection channel: `kexPubRaw` is what §4.2 wraps the space key to.
 *
 * DELIVERED. Four properties of the implementation, each load-bearing:
 *   1. it returns the PAYLOAD, not a boolean (§5.2.1 correction 1, finding F-10);
 *   2. it verifies over the **original** payload bytes, not a re-canonicalisation of the six
 *      parsed fields — so a v2.1 attestation carrying extra fields still verifies under a v2.0
 *      client, and those extras stay covered by the signature while remaining uninterpreted;
 *   3. it enforces **P2** (`deviceShortOf(att.sigPubRaw) === att.deviceShort`), the MUST above;
 *   4. it never throws. A malformed blob from a peer is data, not a bug in this process, and
 *      `null` is a defined outcome at every seam (§5.2.5: a null attestation PARKS the sealed
 *      envelope, it never rejects it). Throwing would also tempt a caller into reading an error
 *      name, which rule 3 forbids.
 * It decodes with `core/authz.js`'s own `parseAttestationBlob` rather than a second decoder that
 * could disagree with the fold's.
 *
 * ⚠ WHAT P2 BUYS, AND WHAT IT DOES NOT — finding **I-3 / R5-7 is OPEN** (`FINDINGS.md` §4.5).
 * P2 makes an attestation SELF-CONSISTENT. It does **not** make `deviceShort -> DeviceAttestation`
 * a function across the space, because `sigPubRaw` is a PUBLIC key travelling in the victim's own
 * register inside the E2EE stream every member can read: a squatter copies it, tells the truth
 * about it, files it under her own record, and passes P2. Nothing in `src/js/crypto/` closes I-3
 * and **nothing downstream may be built as though it does** — see `attestationSelfConsistent`'s
 * header and the characterization rows named "I-3 / R5-7 IS STILL OPEN" in both test tiers.
 * Closing it needs a first-claim binding on the PAIR `(sigPubRaw, deviceShort)` at fold time —
 * option (a) in FINDINGS §4.5 — which is `src/js/core/authz.js`'s decision, not this seam's.
 *
 * @param {string} blob @param {CryptoKey} recSigPub  the HOUSING member's key, never `att.memberId`'s
 * @returns {Promise<DeviceAttestation|null>} null on any failure — never throw-and-branch on names
 */
export async function verifyAttestation(blob, recSigPub, ports) { throw new Error('not implemented'); }

/** §5.2.2's P2 in pure synchronous form. See the warning above: self-consistency, not identity. */
export function attestationSelfConsistent(att) { throw new Error('not implemented'); }

/** `crock32(SHA-256(rawSigPub)[0..10])` — the ONE definition (ADR 001 §1.2). Synchronous, over
 *  `core/ids.js`'s pure SHA-256, because the fold and `openOp`'s check 4 may not await.
 *  `deviceShortOfB64u(sigPubRaw)` is the same from the b64url spelling and returns `null` on
 *  anything malformed; `deviceShortOfAsync` is the WebCrypto-backed variant, and the two are
 *  asserted equal in both engines so the hand-rolled digest can never quietly become a different
 *  function from the platform's. */
export function deviceShortOf(rawSigPub) { throw new Error('not implemented'); }

// ─────────────────────────────────────────────────────────────────────────────
// 3. Space keys and epochs  (ADR 002 §3, §4)
//
// DELIVERED 2026-08-27 — LZP-303.  `src/js/crypto/spacekeys.js`, proved in BOTH engines:
//   tests/tier1/crypto-spacekeys.test.js (38) · tests/tier2/crypto-spacekeys.dom.js (11)
//
// FIVE DEVIATIONS FROM THE SIGNATURES SKETCHED BELOW, EACH DELIBERATE AND EACH TESTED. Read
// them before writing a caller; four of the five are the difference between barrier 3 existing
// and not existing.
//
//  (a) **`wrapSpaceKey` / `unwrapSpaceKey` take a mandatory 4th argument, `{spaceId, epoch}`.**
//      Without the space and the epoch there is nothing to put in the AAD, `suite.aesgcm()`
//      refuses an empty one, and ADR 002 §3 barrier 3 does not exist. NEITHER FIELD ENTERS THE
//      BLOB — it stays the verified `{v, salt, iv, ct}`, asserted at exactly 156 bytes of JSON in
//      both engines — because both sides reconstruct the binding from context they already hold.
//      That is what makes a disagreement about which space a wrap belongs to a DECRYPTION
//      FAILURE instead of a field somebody can rewrite.
//  (b) **The domain is bound twice, independently: in the HKDF salt AND in the AAD.** The HKDF
//      salt is `wireSalt(32) ‖ canonicalJSON([label, v, suite, kind, spaceId, epoch])`, so the
//      KEK that wraps `FSK_3` is a different key from the one that wraps `PSK_3` even for the
//      same ECDH pair and the same 32 random wire bytes. It is bound in the salt rather than in
//      the `info` label because `INFO`'s labels are WIRE FORMAT and `suite.infoBytes()`
//      whitelists them — a per-kind label would be a wire-format change needing a new ADR.
//  (c) **`Recipient` carries a non-enumerable brand naming its space kind**, and `memberId` +
//      `housingRecoveryPubRaw`. `wrapToRecipients` refuses an unbranded or cross-branded
//      recipient, which is what turns ADR 002 §11 rule 10 from a comment into a mechanism: a
//      spread copy (`{...recipient, kexPubRaw: mine}`) LOSES the brand and is refused.
//      `personalRecipients` additionally REFUSES any device entry whose `memberId` is not mine,
//      so it cannot be handed a family list even by accident.
//  (d) **`wrapToRecipients` VERIFIES before it wraps** (§2.3, §4.2 step 2) and additionally binds
//      `att.kexPubRaw === recipient.kexPubRaw`. That last comparison is the key-injection check
//      §2 above names: an attestation that verifies but points at a different agreement key would
//      redirect the space key with every signature still checking out. It throws rather than
//      skipping — a skip becomes a `409` from the relay's coverage check that the user cannot act
//      on, and an unverifiable device in one's own folded member list is a security event.
//  (e) **`buildRotation` does not mint.** A function that minted a key AND built a network
//      payload would lose that key if the POST failed, leaving an epoch unreadable by everyone
//      including the rotator. `rotateSpace({ring, ...})` mints, puts it in the ring, and only
//      then builds — and hands the key back. `wraps` rows carry `epoch`, which they must:
//      `KeyWrapRow` (server.contract.js §4) is keyed by `(spaceId, epoch, deviceId)` and ADR 002
//      §4.2 step 4's `{deviceId, wrapped}` sketch could not have been stored.
//
// TWO THINGS LZP-303 COULD NOT CLOSE, BOTH CHARACTERIZED IN BOTH TIERS SO THEY CANNOT BE
// RE-PLANNED AWAY:
//   · **No wire field carries another member's `RK_kex`.** §4.2 step 2 says a rotation wraps
//     "plus each member's `RK_kex`"; `MemberRowDb` holds `recoveryPubSig` and nothing else, and
//     the `dev.*` attestations cover DEVICE keys. Wrapping to an unauthenticated public key is
//     exactly (d)'s injection channel, so `familyRecipients` wraps to attested devices only and
//     reports every member it could not include on `familyRecipientsReport().missingRecoveryKex`.
//     The personal space has no such gap: my own `RK_kex` is mine and never came off the wire.
//     **Owner: whoever publishes `Member.recoveryPubKex` — WP-7 / ADR 003 §2.**
//   · **ADR 002 §4.2 step 3 is superseded text.** It still says "re-wrap every open invite blob";
//     D9 removed `Invite.wrappedKeys` entirely (§7.1, `refreshInvite(id, epoch)` — "no key
//     material"). `buildRotation` refreshes an open invite to the new epoch and REFUSES an invite
//     object carrying `wrappedKeys`/`wrapped`/`keys`/`epochKeys` rather than stripping it,
//     because stripping would hide a caller who still believes in the seven-day read window.
// ─────────────────────────────────────────────────────────────────────────────

/** @typedef {{v:1, salt:string, iv:string, ct:string}} WrapBlob  156 B of JSON, verified in both
 *  engines. `salt` is 32 B, `iv` 12 B, `ct` 48 B (a 32-byte key + a 16-byte GCM tag). The space
 *  and the epoch are NOT in it — see deviation (a). */

/** @typedef {{spaceId:string, epoch:number, subtle?:SubtleCrypto,
 *             random?:(n:number)=>Uint8Array}} WrapContext */

/** 32 bytes from the CSPRNG, imported as AES-256-GCM. DRAWN, NOT DERIVED — barrier 1 of ADR 002
 *  §3: there is no derivation path between `PSK` and `FSK_e`, and none to the Keychain `DEK`.
 *  EXTRACTABLE, unavoidably: `wrapKey` refuses a non-extractable key and every epoch key must
 *  stay re-wrappable to every future joiner (§7.1 step 5). `KeyRing.put` refuses one that is not.
 *  @param {{subtle?:SubtleCrypto, random?:(n:number)=>Uint8Array}} [ports]
 *  @returns {Promise<CryptoKey>} */
export async function createSpaceKey(ports) { throw new Error('not implemented'); }

/** ECDH → HKDF-SHA-256(salt = 32 random ‖ domain, info = INFO.spaceKeyWrap) → AES-256-GCM KEK →
 *  `wrapKey('raw', …, aesgcm(iv, wrapAad(spaceId, epoch)))`. RULE 6: AES-GCM, never AES-KW.
 *  @param {WrapContext} ctx MANDATORY — deviation (a) @returns {Promise<WrapBlob>} */
export async function wrapSpaceKey(spaceKey, myKexPriv, theirKexPub, ctx) { throw new Error('not implemented'); }

/** `null` means "this blob did not open", for EVERY reason — not addressed to me, wrong space,
 *  wrong epoch, wrong sender, corrupt, hostile — and every reason has the same answer: admit no
 *  key, keep the ops parked (§4.4). They are deliberately not distinguished, because
 *  distinguishing them would mean reading an engine error NAME (rule 3). A malformed ARGUMENT
 *  still throws: that is our bug, not a peer's data.
 *  @param {WrapContext} ctx @returns {Promise<CryptoKey|null>} */
export async function unwrapSpaceKey(blob, myKexPriv, theirKexPub, ctx) { throw new Error('not implemented'); }

/** @typedef {{deviceId:string, memberId:string, role:'device'|'recovery',
 *             kexPubRaw:Uint8Array, attestation:string|null,
 *             housingRecoveryPubRaw:Uint8Array|null}} Recipient
 *  Plus a NON-ENUMERABLE brand naming the space kind — deviation (c). `recipientScope(r)` reads
 *  it and returns `null` for anything these two constructors did not make. */

/**
 * ONLY my own devices + my recovery key. Hard-coded scope: this function must never be able to
 * take a family member list. Barrier 2 of ADR 002 §3, §11 rule 10 — and it is a REFUSAL, not a
 * convention: every device entry must carry `memberId`, and one that is not mine throws.
 * @param {{memberId:string, recoverySigPubRaw:Uint8Array|string,
 *          recoveryKexPubRaw?:Uint8Array|string,
 *          devices:Array<{deviceId:string, memberId:string, kexPubRaw:Uint8Array|string,
 *                         attestation:string, revokedAt?:*}>}} me
 * @returns {Recipient[]}
 */
export function personalRecipients(me) { throw new Error('not implemented'); }

/** Every non-removed member's attested, non-revoked devices. NO recovery recipients — see the
 *  `RK_kex` gap above. `familyRecipientsReport(members)` is the same call with
 *  `{recipients, removed, missingRecoveryKex}`. @returns {Recipient[]} */
export function familyRecipients(members) { throw new Error('not implemented'); }

/** One epoch, to every recipient, each verified first — deviation (d).
 *  @param {WrapContext} ctx
 *  @returns {Promise<Array<{deviceId:string, epoch:number, wrapped:WrapBlob}>>} */
export async function wrapToRecipients(spaceKey, myKexPriv, recipients, ctx) { throw new Error('not implemented'); }

/** EVERY epoch `1..ctx.upTo`, to every recipient, and it REFUSES to build a partial ring —
 *  naming the missing epochs. A wrap covering only the current epoch is a bug whose symptom is a
 *  joiner's board silently missing three years of entries (ADR 002 §4.3, §7.1 step 5; A4, story
 *  17.1, risk R11). `wrapRingTo(ring, spaceId, myKexPriv, recipients, ports)` is the same call
 *  from a `KeyRing` — **D9's delivery half, and it takes no role: ANY existing member device
 *  wraps the ring to a joiner, not only the admin's** (§7.1 step 4).
 *  @param {{spaceId:string, upTo:number}} ctx */
export async function wrapRingToRecipients(spaceKeysByEpoch, myKexPriv, recipients, ctx) { throw new Error('not implemented'); }

/**
 * @typedef {Object} KeyRing
 * @property {(space:string, epoch:number) => CryptoKey|null} get   TOTAL — `null` for anything
 *           not held, INCLUDING a malformed id: `env.sp`/`env.ep` are peer data and a miss is a
 *           park (§5.2.2 P4), so a throw here would turn a hostile header into a crashed sync.
 * @property {(space:string, epoch:number, k:CryptoKey, origin?:KeyOrigin) => boolean} put  LOUD on our own data —
 *           it throws on an unclassifiable space id, a non-epoch, or a key that is not an
 *           extractable AES-256-GCM. **FIRST WRITE WINS**: a second key for an epoch already
 *           held returns `false` and does not displace one that is already decrypting ops. It is
 *           `false` and not a throw because two members both wrapping the same epoch to a joiner
 *           is the ordinary case under D9; the count is on `refusedPuts()`.
 * @property {(space:string) => number} currentEpoch  0 ⇒ no key for this space
 * @property {(space:string) => number[]} epochs   clients RETAIN every epoch they ever held
 * @property {(space:string) => Map<number,CryptoKey>} keysByEpoch
 * @property {(space:string, upTo:number) => number[]} missing
 * @property {(space:string, upTo:number) => boolean} covers
 * @property {(space:string, epoch:number) => KeyOrigin|null} originOf  WHO PUT THIS KEY HERE —
 *           `null` for a slot that holds nothing. Added 2026-08-28 for finding S1: "a `KeyRing`
 *           entry is a `CryptoKey`, and a `CryptoKey` carries no provenance" was the sentence
 *           that made the injection invisible to `sealOp`. `how:'admitted'` names the VERIFIED
 *           device the wrap came from, and only `admitWraps` can set it — to a device that was in
 *           its `SenderSet`. Everything else (minted here, restored from this device's own key
 *           store) is `how:'local'` with both ids `null`.
 * @property {() => number} refusedPuts
 * @property {() => string[]} loadSkipped
 */
export function createKeyRing(entries) { throw new Error('not implemented'); }

/** Rebuild the ring from `lzp/v2/space/<spaceId>/<epoch>` records. A record that reads back as
 *  `null` is SKIPPED and reported on `ring.loadSkipped()`, never thrown on: on WebKit that is
 *  LZP-302's finding 8 — a re-signed bundle makes persisted CryptoKeys deserialise to `null` with
 *  no error — and it is recoverable, because any other member device can re-deliver the ring (D9).
 *  @param {KeyStore} ks @returns {Promise<KeyRing>} */
export async function loadKeyRing(ks) { throw new Error('not implemented'); }
/** @param {KeyStore} ks */
export async function saveSpaceKey(ks, spaceId, epoch, key) { throw new Error('not implemented'); }

/** ADR 002 §4.1's trigger table as DATA. `rotatesOn(event)` THROWS on an unlisted event: a
 *  `false` default would make every future membership event silently stop rotating, which is a
 *  security downgrade no test would catch. */
export const ROTATION_TRIGGERS = Object.freeze({});
export function rotatesOn(event) { throw new Error('not implemented'); }

/**
 * Rotation, performed by the member whose action caused it (joiner on join, admin on remove).
 * Steps: VERIFY every recipient's attestation → wrap ALL epochs `1..nextEpoch` to all of them →
 * refresh every OPEN invite to the new epoch (no key material — D9) → one atomic POST. The
 * server rejects a bump whose wraps do not cover every current non-revoked device (ADR 002 §4.2),
 * and `@@unique([spaceId, epoch])` makes it first-writer-wins. **It does not mint** — deviation
 * (e); `rotateSpace()` is the call that does, in the safe order.
 * @returns {Promise<{spaceId:string, kind:'personal'|'family', epoch:number,
 *                    wraps:Array<{deviceId:string, epoch:number, wrapped:WrapBlob}>,
 *                    invites:Array<{id:string, epoch:number}>,
 *                    coveredDevices:string[]}>}   // no wrappedKeys — D9
 */
export async function buildRotation(spaceId, nextEpoch, spaceKeysByEpoch, myKexPriv,
                                    recipients, openInvites, ports) { throw new Error('not implemented'); }

/** Mint → put into the ring → build. The order matters: the new key exists in the ring BEFORE
 *  any wrap is built, so a rotation that fails half way leaves a device that can still read what
 *  it just sealed. @returns {Promise<Rotation & {key:CryptoKey}>} */
export async function rotateSpace(opts) { throw new Error('not implemented'); }

/**
 * The admissible SENDER set for one space — **the anti-key-injection measure on the way IN**
 * (finding S1, ADR 002 §4.2 step 6 as amended 2026-08-28).
 *
 * `recipients` is the branded `Recipient[]` from `personalRecipients()` / `familyRecipients()` —
 * §3 barrier 2's two constructors, and there is no third way to name a device a space may accept
 * a key from. Every entry goes through `recipientProblem()`: brand matches the space kind, the
 * attestation verifies under the housing member's `RK_sig`, and `att.kexPubRaw` is bound to the
 * key itself. The returned set indexes the public keys IT imported and is bound to ONE `spaceId`.
 *
 * An EMPTY list is legal and means "I can authenticate nobody yet" — every row is then refused
 * and the ops stay parked (§4.4), which is the correct state for a joiner between §7.1 steps 2
 * and 6.
 *
 * @returns {Promise<SenderSet>} frozen, branded, unforgeable by a caller
 */
export async function admissibleSenders(recipients, spaceId, ports) { throw new Error('not implemented'); }

/** Is this a `SenderSet` `admissibleSenders()` built? `false` for a copy — the brand is a
 *  non-enumerable module-private Symbol, so a spread loses it. */
export function isSenderSet(v) { throw new Error('not implemented'); }

/**
 * Admit every wrap the relay returned for this device (`GET /spaces/:id/keys` — every epoch,
 * §4.4). A blob that does not open is COUNTED, not thrown on: the ordinary cause is a wrap from
 * a member whose key this device has not folded yet, and the answer is the same as an unknown
 * epoch — park and re-evaluate.
 *
 * **`ctx.senders` IS REQUIRED and has no default** (finding S1). Without it, `senderKexPubRaw` is
 * an attacker-chosen ECDH key that decides which key this device seals its own private entries
 * under; ADR 002 §4.2 step 2 put the attestation check on the wrapping side only, and the
 * receiving side is the one that decides which key it will use. It takes the `Recipient[]` from
 * `personalRecipients()` / `familyRecipients()`, or a `SenderSet` from `admissibleSenders()`. A
 * row's `senderKexPubRaw` is an INDEX into that set — it selects a sender and cannot supply one.
 *
 * `unauthorized` counts rows whose sender is not in the set. It is folded into `refused` as well,
 * so the pre-S1 shape keeps its meaning, but it is reported apart because "a stranger tried to
 * give me a key" is a security event and "a wrap did not open" is not.
 *
 * @param {{spaceId:string, myKexPriv:CryptoKey, senders:Recipient[]|SenderSet}} ctx
 * @returns {Promise<{admitted:number[], refused:number, duplicates:number,
 *                    unauthorized:number, unauthorizedEpochs:number[]}>} */
export async function admitWraps(ring, rows, ctx) { throw new Error('not implemented'); }

// ─────────────────────────────────────────────────────────────────────────────
// 4. The op envelope  (ADR 002 §5)
//
// DELIVERED 2026-08-27 — LZP-304.  `src/js/crypto/envelope.js`, proved in BOTH engines.
//
// TWO SIGNATURE DEVIATIONS FROM THE SKETCHES BELOW. Both are folded into the JSDoc; read them
// before writing a caller, because the second one changes what `await openOp(...)` evaluates to.
//
//  (a) **`sealOp` takes a 5th argument, `ctx`** — `{assertFamilyPatch?, levelOf?, attestation?,
//      subtle?, random?}`. Barrier 4 is UNIMPLEMENTABLE without `levelOf`: the security note
//      below says "re-derive the level from the authenticated register map" and the four-argument
//      signature gives `sealOp` no way to reach one.
//
//      ⚠ **THE PRECONDITION WP-10 MUST SATISFY BEFORE IT BUILDS ON BARRIER 4 (finding S5, closed
//      2026-08-28; ADR 004 §2.2 barrier 4 as AMENDED).** Two clauses, and the second is the one
//      that makes the first survivable:
//
//        1. `op.f['pub.level']` IS A RESTATEMENT, NEVER AN INPUT. `sealOp` computes
//           `level = ctx.levelOf(op.e)` and nothing else; a declared `pub.level` that is present,
//           non-null and different from it is a `barrier4` refusal, exactly like a disagreeing
//           `brand.level`. `absent` and `null` are silence and consult the map (§5's withdrawal
//           patches carry `pub.level: null`). A map answer outside `privat|belegt|geteilt` —
//           `null` and `undefined` included — is a refusal, never a fallback to the patch.
//           This replaces the old `patch['pub.level'] ?? currentPubLevel(entityKey)`, which let
//           the caller's value win whenever the caller supplied one and which the E3 red team
//           walked through to seal a `pub.text` for a **belegt** entry (row M-R7c).
//        2. `ctx.levelOf` MUST BE WIRED TO THE ENTITY'S AUTHENTICATED `visibility` TRUTH REGISTER,
//           **not** to the last-published `pub.level` of the family entity. The published level is
//           the level a transition is moving AWAY from; wiring `levelOf` to it makes every
//           legitimate share a barrier-4 refusal on the first attempt. The truth register already
//           carries the NEW level when the publish microtask runs (ADR 001 §0.9, ADR 004 §2.3), so
//           the honest transition agrees with the map and the caller asserts nothing. Domain C4 in
//           `tests/helpers/crypto-domains.js` walks all 325 inputs of
//           (declared × folded × brand × payload) against this rule.
//
//      `assertFamilyPatch` is ADR 004 §2.2's
//      barrier 2, injected because `core/project.js` (WP-10) does not exist — and it is
//      REQUIRED for a family `pub.set`, not optional: a security check that is skipped when its
//      module is missing is not a security check, and the failure of an unbuilt module must read
//      "you cannot publish", never "you publish unchecked".
//  (b) **`openOp` returns a DISCRIMINATED UNION, not the Op.** The old JSDoc said parks are
//      "signalled to the caller" *and* `@returns the Op`; those cannot both be true.
//      `{status:'opened', op, attestation}` vs `{status:'park', parkReason, reason, fields?}`
//      makes it impossible to use a park as an op — `const op = await openOp(...)` then `op.f`
//      is a TypeError AT THE SEAM rather than an `undefined` three layers downstream. Hard
//      failures (bad signature, identity mismatch, AEAD) still THROW an `EnvelopeError` whose
//      `.check` is one of `P2|P3|C1..C5|shape|aead|padding|canonical` — a value this codebase
//      defines, so no caller ever has to read an engine's error name (rule 3).
//
// ALSO EXPORTED, AND LOAD-BEARING:
//   ENVELOPE_FIELDS         the nine wire fields. There is no tenth, and a test says so.
//   assertHeader(hdr, who)  restricts every header field to an ASCII alphabet, which is what
//                           makes it safe to keep §5.1's `JSON.stringify` AAD verbatim rather
//                           than canonicalising it — one byte of drift is every GCM tag failing
//                           for half a family, so the wire format was NOT "improved".
//   FAMILY_PATCH_BRAND      `Symbol.for('lzp/v2/family-patch')` — ADR 004 §2 forbids
//                           `project.js` importing outside `core/` and ADR 005 §2 forbids
//                           `core/ -> crypto/`, so the global symbol registry is the ONE token
//                           both sides can name without an import. It is NOT a capability and
//                           NOT unforgeable; barrier 3's job is that an agent who never read
//                           ADR 004 gets a refusal, and a deliberate forger still has to restate
//                           the redaction decision for barrier 4 and the backstop to check.
//   PROJECT_CONTRACT        the seven clauses WP-10 must satisfy, executable. Until all four
//                           land, NO family `pub.set` can be sealed at all.
//   ENVELOPE_PARK           park reasons. `ENVELOPE_PARK.ATTESTATION` is defined HERE with the
//                           value `core/ops.js` must adopt, because `PARK_REASONS.ATTESTATION`
//                           DOES NOT EXIST YET — finding F-6, owner WP-8. `PARK_REASONS_NEEDED`
//                           states the obligation in code and both tiers assert the gap is still
//                           real, so those rows turn red the day WP-8 lands it. That is the
//                           moment to re-point `ENVELOPE_PARK.ATTESTATION` and delete them.
//   pad / unpad / paddedLength   §5.3. `unpad` is STRICT — a non-zero padding byte or a
//                           non-minimal varint is refused, because both are covert channels the
//                           GCM tag cannot see. An exact multiple of 256 stays 256 (ceiling, not
//                           always-add): always-add would give a 256-byte op a bucket of its own
//                           and make it the most distinguishable op on the wire, which is the
//                           opposite of what §5.3 claims.
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
 *   (b) READ the level from the authenticated register map — `level = ctx.levelOf(op.e)`, the
 *       entity's `visibility` truth register — and REFUSE, not prefer, a `op.f['pub.level']` that
 *       disagrees with it, before running assertFamilyPatch (ADR 004 §2.2 barriers 3 and 4, as
 *       amended for finding S5; deviation (a) above states the full precondition).
 * It also does three things beyond the brief, each because the failure it prevents is REMOTE
 * AND SILENT:
 *   · with `ctx.attestation` supplied it mirrors the whole far-side gate — P2, checks 3 and 5,
 *     and P3 itself, verifying the signature it just made under `att.sigPubRaw`. A device signing
 *     with a key its own attestation does not name produces an envelope that fails P3 on every
 *     peer AND NOWHERE ELSE: permanent, invisible, and unattributable. One local ECDSA verify on
 *     the outbox path turns it into an exception on the machine that caused it. **The outbox
 *     SHOULD pass `ctx.attestation`**; without it there is nothing to compare a non-extractable
 *     private key against, and that limit is asserted too.
 *   · it refuses an op THIS BUILD would itself park or reject — we are the author, and publishing
 *     an op our own family cannot apply is a bug on the one machine that knew better.
 *   · the redaction gate runs BEFORE `validateOp`. Both refuse a patch carrying `categoryId`, but
 *     `validateOp` says "unknown field on fnote" — true and useless — while the gate says "a
 *     category leaked to the family space (A3)". §2.3 requires that path to be loud.
 *
 * @param {Object} op @param {KeyRing} keyring @param {CryptoKey} sigPriv
 * @param {{v:1, sp:string, ep:number, dv:string, oid:string, wit:string}} hdr
 * @param {{assertFamilyPatch?:Function, levelOf?:Function, attestation?:DeviceAttestation,
 *          subtle?:SubtleCrypto, random?:Function}} [ctx]  deviation (a)
 * @returns {Promise<Envelope>}
 * @throws {RedactionError} `.barrier` ∈ `barrier2|barrier3|barrier4|backstop|brand`
 * @throws {EnvelopeError}  `.check` ∈ `P2|P3|C1..C5|shape|aead|padding|canonical`
 */
export async function sealOp(op, keyring, sigPriv, hdr, ctx) { throw new Error('not implemented'); }

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
 * WHERE `attestationOf` COMES FROM. `AuthzResult.attestationOf` — `src/js/core/authz.js`,
 * delivered 2026-08-27 (finding F-10). It is keyed by `deviceShort` ALONE because `op.act` is not
 * knowable before decrypt, and that one-key form is sound only while ADR 002 §2.3's four
 * acceptance conditions hold; all four are enforced at stage 0a and pinned individually by
 * `tests/tier1/core-authz.test.js` §3b. §5.2.1 warns that relaxing (3) or (4) breaks this
 * section — if either ever moves, THIS FUNCTION is what stops working.
 *
 * AND ONE THING `openOp` MUST NOT SKIP. P2 is not a formality: it is the ONLY place
 * `att.deviceShort` is ever bound to `att.sigPubRaw`. The fold cannot check it — it is pure and
 * synchronous, and the binding is a SHA-256 — so a member CAN file a well-formed attestation
 * under a peer's short.
 *
 * [AMENDED 2026-08-27 — I-3.] The fold no longer RESOLVES that contest. It used to pick
 * minimal-under-`≺`, which handed a backdated squatter the lookup and therefore handed THIS
 * FUNCTION the squatter's verification key. `attestationOf` returns `null` for any short on
 * `AuthzResult.shortCollisions`, so a squatted short reaches P1 and PARKS the sealed envelope
 * instead of being opened under the wrong key. Two consequences for `openOp`:
 *   · P1's `null` has more than one cause — absent, contested, or unproven — and all of them are
 *     parks. Do not turn any of them into a rejection; §5.2.5's argument covers all.
 *   · a squatter could therefore STALL a peer's envelopes, which was the deliberate trade (a
 *     park is re-evaluable; a wrong key is not).
 *
 * [AMENDED 2026-08-28 — I-3 / R5-7 CLOSED, and the sentence above about P2 removing the stall is
 * struck. It said "P2 inside `attestOpen` is what removes the stall by refusing the squat at
 * fold time." P2 shipped, and the squat still passed it: `sigPubRaw` is public, so she copies
 * key and short together and tells the truth about both. WHAT CLOSED IT is a possession proof
 * the fold CAN make — a `dev.<S>` register is a credential only if the op that WROTE it was
 * stamped by the device it attests (`devOf(cell.stamp) === att.deviceShort`), which is sound
 * precisely because THIS FUNCTION's P2, P3 and check 4 mean an op stamped with S was signed by
 * the holder of S's private key. Consequences for `openOp`, and they are obligations:
 *   · `openOp` is now the SOLE enforcer of a credential, not just of an ordering premise. Check
 *     4 (`devOf(op.ts) === env.dv`) may not be weakened, made optional, or moved after the
 *     decrypt: the authorization fold reads the stamp and trusts it because of this check.
 *   · nothing may append an op to the log without it having passed `openOp` — or that door must
 *     refuse `member.set{dev.*}` outright. Characterized as M-I5b in
 *     `tests/attack/crypto-member-impersonate.test.js`.
 *   · P1's `null` is still a park in every case, including the pre-collision window that used to
 *     resolve, decrypt and then throw at check 5. Check 5 is unchanged and stays a throw.]
 *
 * WHAT DOES NOT EXIST YET, AND `openOp` MUST NOT PRETEND IT DOES: **device revocation.** There
 * is none, anywhere — see ADR 002 §2.3 "Revocation — the gap, and who owns it" (owner: WP-9).
 * `dev.*` registers are write-once, so an attestation cannot even be amended or withdrawn; a
 * stolen device stays attested and stays admitted until the epoch bump stops wrapping keys to
 * it, which is a key-distribution measure and not an admissibility one. `openOp` has no
 * revocation input, no revocation check, and no `revokedAt` to compare against — do not invent
 * one at this seam; it belongs in the attestation register design.
 *
 * ORDER, which §5.2.2 left unstated: **identity checks FIRST, shape triage second.** Otherwise a
 * parked op (unknown field, unknown kind) would be un-parked after an app update and applied
 * WITHOUT ITS ATTRIBUTION EVER HAVING BEEN CHECKED. Pinned by a test.
 *
 * §5.2.5's "rejects a bad value / parks an unknown kind or field" is DELEGATED to `core/ops.js`'s
 * `validateOp` rather than re-decided here, so seal, open and the fold run one set of rules.
 *
 * @param {Envelope} env @param {KeyRing} keyring
 * @param {(dv:string) => DeviceAttestation|null} attestationOf  AuthzResult.attestationOf —
 *        still a PARTIAL function, and `openOp` must stay built for that. I-3/R5-7 is CLOSED
 *        (2026-08-28) so a SQUATTED short no longer returns `null`; an absent one, an unproven
 *        one and a genuine two-signer collision still do, and all three PARK.
 * @param {{subtle?:SubtleCrypto}} [ports]
 * @returns {Promise<{status:'opened', op:Object, attestation:DeviceAttestation}
 *                 | {status:'park', parkReason:string, reason:string, fields?:string[]}>}
 *          deviation (b) — NOT the Op.
 * @throws {EnvelopeError} on bad signature, wrong key, or any identity mismatch. Missing epoch
 *         and a null attestation are NOT throws — they are the `park` arm above.
 */
export async function openOp(env, keyring, attestationOf, ports) { throw new Error('not implemented'); }

/** varint(len) ‖ utf8(canonicalJSON(op)) ‖ zeros, to a multiple of PAD_BUCKET. CEILING: an exact
 *  multiple stays where it is. A NON-CANONICAL plaintext is a protocol violation and throws —
 *  key order and insignificant whitespace are author-chosen, the GCM tag authenticates them, and
 *  they land on every honest client's disk. */
export function pad(plaintextBytes) { throw new Error('not implemented'); }
/** STRICT: refuses a non-zero padding byte, a non-minimal varint, and a length that is not an
 *  exact bucket. Each of those is a covert channel the tag cannot see. @returns {Uint8Array} */
export function unpad(paddedBytes) { throw new Error('not implemented'); }

// ─────────────────────────────────────────────────────────────────────────────
// 5. Pairing  (ADR 002 §6) — 19.5
//
// DELIVERED 2026-08-27 — LZP-306.  `src/js/crypto/pairing.js`, proved in BOTH engines against a
// hostile relay (`tests/helpers/mitm.js`: honest / active-MITM / blind / replay / downgrade).
//
// THREE SIGNATURE CORRECTIONS, plus three decisions the ADR left open.
//
//  (a) **`createPairingSession(identity, keyring, ports)` takes a third argument and `ports.now`
//      is REQUIRED.** §6.2 fixes a 180 s TTL and a 5-failed-open budget; nothing under
//      `src/js/crypto/` may read a clock (ADR 005 §2), so without an injected `now` the session
//      could not enforce a parameter this ADR publishes. A session that silently could not
//      enforce a stated protocol parameter is worse than one that refuses to exist.
//  (b) **`keyring` is `{personal:{spaceId, epochs}, family}`, not a `KeyRing`.** The payload
//      needs space IDs and a `KeyRing` does not carry them. `spacesFromKeyRing(keyring, ids)`
//      converts; it is duck-typed on `epochs()`/`get()` and proved against the real
//      `createKeyRing()` in both tiers.
//  (c) **`adoptPairedDevice(ks, restored, newDeviceKeys, {createdAt})` exists and is step 8.**
//      `ensureAttestedDevice` cannot serve it — that call MINTS, and B's keys were already
//      minted at step 4. Minting twice produces a second Mac that is silently unreadable.
//      `adoptPairedDevice` persists the step-4 pair into the three records `ensureDeviceIdentity`
//      reads, keys first and metadata last; the test then runs the REAL `ensureDeviceIdentity`
//      over the store and asserts it ADOPTS, so format drift is impossible.
//
//   · **The pairing boxes' AAD** is unspecified by §6 and mandatory by §5.1. It is
//     `canonicalJSON(['lzp/v2/pair', v, type, rid])`, **reconstructed by the receiver and never
//     transmitted** — which is what makes slot-swapping and version-lying IMPOSSIBLE rather than
//     merely detected. Framing is `b64u(iv) + '.' + b64u(ct)`, matching the attestation blob.
//   · **Which spelling of the code feeds HKDF.** §6.3 writes `HKDF(C, …)`; DECODING is *wrong*,
//     not merely a choice — `uncrock32` of 12 chars yields 7 bytes = **56 bits**, and rejects any
//     code whose 4 spare bits are set, which is 15 codes in 16. The IKM is the UTF-8 of the
//     NORMALISED 12-character string.
//   · **Epoch coverage 1..e is enforced on BOTH send and receive.** §7.1 step 5 states it for
//     invites; 19.4 is the stronger form of the same requirement, and a truncated or gappy ring
//     means a second Mac silently missing years of entries.
//   · Padding is LZP-304's `pad`/`unpad`, IMPORTED not re-implemented — a delivery's length
//     otherwise tells the relay how many epochs a member holds and whether they are in a Kreis
//     at all (§8.7).
//
// ⚠ **`confirmSasMatch` accepts the literal boolean `true` and nothing else**, and anything else
// refuses TERMINALLY. `tests/tier1/crypto-pairing.test.js` carries the row named "THE SAS IS
// LOAD-BEARING: a client that auto-confirms hands the attacker EVERYTHING" — same MITM, same
// code, the only difference being `humanCompares: () => true` — and it asserts the attacker ends
// up holding `RK_sig`, `RK_kex` and every epoch key, then uses the stolen `RK_sig` to mint an
// attestation for its own device that verifies under the victim's recovery key. Nobody can call
// this control decorative after reading it. LZP-503: the SAS screen is not skippable and not
// defaulted to „Ja".
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
 * @param {{now:() => number}} ports  REQUIRED — deviation (a)
 * @returns {PairingSession}  plus `state/role/sas/peer/attemptsRemaining/newDeviceKeys/
 *          obligations`. `obligations()` returns `{rotatePersonalSpaceTo, wrapTo}` after a
 *          successful delivery — §6.3 step 9. `pairing.js` does NOT rotate; LZP-303's
 *          `buildRotation` must be driven with that.
 */
export function createPairingSession(identity, keyring, ports) { throw new Error('not implemented'); }

/** §6.3 step 8. NOT `ensureAttestedDevice` — deviation (c). @param {KeyStore} ks
 *  @returns {Promise<{identity:Identity, attestation:DeviceAttestation, blob:string}>} */
export async function adoptPairedDevice(ks, restored, newDeviceKeys, opts) { throw new Error('not implemented'); }

// ─────────────────────────────────────────────────────────────────────────────
// 6. Invites  (ADR 002 §7.1) — 15.3, 15.5
//
// ⚠ **NOT DELIVERED BY E3, AND TWO OF THE FOUR FUNCTIONS BELOW ARE RETIRED.** No ticket in
// LZP-302..306 covered invites; `deriveInvite` and `generateInviteCode` are OWED (owner: WP-7,
// with the four `/api/v1/invite/*` endpoints).
//
// **`sealInviteKeys` / `openInviteKeys` MUST NOT BE BUILT.** PO decision **D9** removed
// `Invite.wrappedKeys` entirely: an invite carries **no key material**, so a leaked invite email
// is never sufficient to read family content. The two functions below are the seven-day read
// window D9 deleted, and they are left here struck through rather than removed so that a future
// reader finds the decision instead of re-deriving the feature. This is enforced in code, not by
// this comment:
//   · `suite.js`'s `RETIRED_INFO` makes `infoBytes('lzp/v2/invite/wrap')` **throw by name**, so a
//     stale draft cannot even derive the wrapping key;
//   · `spacekeys.js`'s `buildRotation` **REFUSES** an invite object carrying
//     `wrappedKeys`/`wrapped`/`keys`/`epochKeys` rather than stripping it — stripping would hide
//     a caller who still believes in the read window.
// What replaces them: `refreshInvite(id, epoch)` (no key material), plus **any existing member
// device** wrapping the ring to the joiner via `wrapRingTo` once she has redeemed. Note the ADR
// beats `DESIGN-DECISIONS.md` here: D9's prose says "the admin's device must be online", §7.1
// step 4 says "any existing member device — not only the admin's", and §7.1 is later and gives
// the reason. `spacekeys.js` takes no role, no `isAdmin` flag and no admin id, and a test asserts
// no export names one.
//
// A4 / story 17.1 / risk R11 is unaffected and is already satisfied by the delivered path:
// `wrapRingToRecipients` wraps EVERY epoch `1..e` and REFUSES to build a partial ring, naming the
// missing epochs. Oma's birthday, entered in epoch 1, is readable by a member who joins in
// epoch 7 — asserted end to end in `tests/tier1/crypto-spacekeys.test.js`.
// ─────────────────────────────────────────────────────────────────────────────

/** 12 Crockford chars = 60 bits. OWED — WP-7. @returns {string} */
export function generateInviteCode() { throw new Error('not implemented'); }

/**
 * The raw code NEVER reaches the server. OWED — WP-7.
 * NOTE the return shape must LOSE `wrapKey` when this is built: D9 leaves nothing to wrap.
 * @param {string} code
 * @returns {Promise<{inviteId:string, verifier:Uint8Array}>}
 */
export async function deriveInvite(code) { throw new Error('not implemented'); }

/** ⛔ RETIRED BY D9 — DO NOT IMPLEMENT. See the section header. `infoBytes` throws on this
 *  label by name so the key cannot be derived even by a caller who ignores this. */
export async function sealInviteKeys(epochKeys, wrapKey, salt) { throw new Error('RETIRED by D9'); }
/** ⛔ RETIRED BY D9 — DO NOT IMPLEMENT. */
export async function openInviteKeys(blob, wrapKey, salt) { throw new Error('RETIRED by D9'); }

// ─────────────────────────────────────────────────────────────────────────────
// 7. Backup / recovery  (ADR 002 §7.2, §7.3) — A2, D8, LZP-305
//
// DELIVERED 2026-08-27.  `src/js/crypto/backup.js`, proved in BOTH engines.
// Measured in WKWebView: **600 000 PBKDF2-SHA-256 rounds in 173–227 ms** — the export sheet does
// not need a progress state.
//
// WHAT §7.2 LEFT OPEN, AND HOW IT IS RESOLVED (each pinned by a test; the first three are wire
// format and cannot be changed without a new ADR):
//   · **`sealed = b64u(iv ‖ ct‖tag)`, 12-byte IV FIRST.** §7.2 shows `sealed` as one opaque
//     string and lists no `iv`, while §3's `WrapBlob` carries `{salt, iv, ct}` explicitly.
//     Adding a field to a normative shape is a wire-format change; choosing the encoding of one
//     opaque string is not.
//   · **The KDF chain is `PBKDF2-SHA-256(pw, salt, iters) → HKDF-SHA-256(salt, 'lzp/v2/backup')
//     → AES-256-GCM`.** §3 fixes `INFO.backup` as wire format and NOTHING derived from it — a
//     label in a frozen list with no user is a label someone deletes. §7.2's "PBKDF2 → AES-GCM"
//     stays true (HKDF is §1's named derivation primitive), and the chain is deterministic, so
//     it is pinned three ways: a second hand-rolled implementation in `tests/helpers/kat.js`
//     reproduces a real file, and two hex vectors (4 096 and the shipped 600 000) are asserted
//     byte-identical in Node and WebKit.
//   · **The AAD is the ENTIRE PLAINTEXT HEADER, PLUS A DIGEST OF THE BOARD** — both READMEs,
//     `format`, `v`, `exportedAt`, `app`, `identity.memberId`, every `identity.kdf` field, and
//     `board: {digest, hash}` where `digest = b64u(SHA-256(boardDigestInput(file.board)))`.
//     A `sealed` blob cannot be relabelled under another member, re-stamped with a different
//     iteration count, have the honesty copy stripped, **or have one word of one entry rewritten**,
//     without the tag failing. The digest is **not a field of the file** — it is recomputed on
//     both sides, so there is nothing to strip and no wire format to version. See S3 below.
//   · **The public halves are RECOVERED, not stored.** §7.2 seals only `recSigPkcs8`/
//     `recKexPkcs8`; PKCS#8 imports to a private key alone and every consumer needs a
//     `CryptoKeyPair`. Rather than add fields or parse DER by offset, the private key is
//     re-exported as JWK and the public half imported from the same `x`/`y` — then **verified
//     cryptographically in both directions** (a signature must verify; an ECDH against an
//     ephemeral pair must agree from both sides). Proved in WebKit, not assumed.
//   · **Two READMEs, not one.** §7.2 gives one German header. Writing „DIES IST DEIN SCHLÜSSEL"
//     across a file that contains no key is a lie the user ACTS on — she guards it as if it
//     restores her Familienkreis. `README.boardOnly` says what that file is and what it will not
//     do; §7.2's German for the identity file is kept VERBATIM and asserted as such.
//   · **`level` is NOT exported.** A2 says "with their flags"; `visibility` and `coEdit` are
//     truth registers, `level` is a projection of the family space. A restored board that has not
//     re-joined anything must not assert "others can see this" about a space it is not in (INV-R3).
//   · **`_v2` travels as provenance, not as a claim.** Export carries it; `importBackup` strips
//     it and returns it as `result.lineage` for the caller to decide (ADR 006 §5.5).
//   · **`identity.memberId` and both space ids are SHAPE-VALIDATED at export and import**, per
//     slot — so a key ring cannot file `PSK` under an `fsp_` id (§3 barrier 2 in miniature). This
//     was found by the WKWebView run, not by review: a mis-shaped MemberId imported
//     "successfully" and then minted an attestation that `core/authz.js`'s
//     `parseAttestationBlob` refuses on EVERY machine, with nothing anywhere saying why.
//
// ─────────────────────────────────────────────────────────────────────────────
// FIXED 2026-08-28 — S3, S4, S7, S8. The four backup findings from the E3 red team.
// ─────────────────────────────────────────────────────────────────────────────
//
// **S3 — the board block IS authenticated, on the identity path.** This replaces the "one honest
// limit" that stood here, and E3-6 (which was filed as a PO question) is answered. E3-6's
// argument was that binding the board "would exist on ONE of the two export paths, and a
// guarantee that holds on one path is worse than one stated plainly." That is true of the
// BOARD-ONLY file, which has no key and therefore cannot have the guarantee, and says nothing
// about the file that says „DIES IST DEIN SCHLÜSSEL" across the top and was half unsigned:
// whoever found it on the family NAS could rewrite, add or DELETE entries and the import returned
// a fully valid identity beside her board. Two paths with TWO STATED guarantees is the shape the
// argument permits — `LIMITS.board.withIdentity` and `LIMITS.board.boardOnly`, German and
// English, plus one line each under the two export-sheet buttons.
//   E3-6's second objection is PAID rather than argued away. `boardDigestInput` deliberately does
//   NOT use `canonicalJSON` (which refuses floats): it is a total function over everything
//   `JSON.stringify` can write, so a `settings` that picked up a `0.5` cannot cost the user their
//   export. It sorts object keys, so a file re-serialized by a different writer still opens — the
//   one member of the field domain where "the import must SUCCEED" is the requirement (C2a-20).
//
// **S4 — a half-written key store is repairable.** `prepareKeyStore` (was `assertKeyStoreIsFree`)
// still REFUSES the attempt that meets a partial store, and now clears the dead residue on the
// way out, so the retry meets an empty store. It deletes only what is provably dead on two
// independent grounds — the triple is partial (every reader in `identity.js` refuses it by
// construction) AND no readable metadata names another member, which is now checked even on a
// PARTIAL triple, i.e. strictly stricter than before. It runs at step 4, after the AEAD tag, so a
// thief with the Mac and a random file never reaches the delete. `SAY['keystore-partial']` changed
// with it: „Dieser Mac muss neu gekoppelt werden" was true of a module that never deleted.
//
// **S7 — the passphrase has a named, SOFT floor.** `PASSPHRASE_FLOOR` + a pure
// `passphraseStrength()` + `EXPORT_SHEET_COPY.passphrase` (DE/EN, shown BEFORE anything is typed)
// + an optional `opts.onWeakPassphrase` port so "the sheet forgot to ask" is testable. Soft
// because a hard refusal pushes the user onto „Nur Einträge sichern" — no recovery artefact at
// all — which is strictly worse. `PASSPHRASE_FLOOR.hard = true` is the whole of the other
// decision; the code `passphrase-too-weak` and its sentence exist, unused, so it stays one line.
//
// **S8 — a ring that does not cover 1..e is reported.** `result.spaces.<which>.missingEpochs`,
// present ONLY when there are holes, and `result.consequence` becomes
// `identity-restored-keys-pending` (§7.3 step 6's „Schlüssel ausstehend").
//
// ⚠ **WHAT IS STILL NOT CHECKABLE HERE, AND IS NOW SAID.** `result.familyBinding =
// {spaceId, verified:false, say}` on every family restore. Whether the Kreis the file names is
// this member's is NOT IN THE FILE, and the enumerated domain proves it rather than asserting it:
// the „mein Kreis" and „ein anderer Kreis" inputs (C2c-1, C2c-2) are the same bytes, so no
// implementation can warn on one and stay silent on the other. The check belongs to §7.3 step 5's
// `POST /api/v1/devices/adopt`. **Owner: `server/`.**
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} BackupV2
 * @property {string} _README_de @property {string} _README_en
 * @property {'langzeitplaner-backup'} format @property {2} v
 * @property {string} exportedAt @property {string} app
 * @property {Object} board       materialized v1-shape state, MY entries only (A2)
 * @property {{ kdf:Object, memberId:string, sealed:string }} [identity]
 *           AES-256-GCM over canonicalJSON({recSigPkcs8, recKexPkcs8, personal, family}),
 *           with the plaintext header AND a SHA-256 of `board` as the AAD (S3).
 *           OMITTED ENTIRELY when no passphrase is given. NEVER written in plaintext.
 */

/**
 * @param {Object} board @param {Identity} identity @param {Object} spaces
 * @param {string|null} passphrase  null ⇒ the `identity` block is OMITTED, not plaintext.
 *        The export sheet offers two explicit buttons and states the consequence of each;
 *        A2's own wording is conditional ("if the keys are present").
 * @param {{exportedAt:string, app:string, salt?:Uint8Array, iv?:Uint8Array, iterations?:number,
 *          subtle?:SubtleCrypto, random?:Function}} opts  `exportedAt` and `app` are INJECTED —
 *        nothing under `src/js/crypto/` reads a clock or a build constant (ADR 005 §2).
 * @returns {Promise<BackupV2>}
 */
export async function exportBackup(board, identity, spaces, passphrase, opts) { throw new Error('not implemented'); }

/** A2, enforced here rather than trusted from a caller: MY entries only. @returns {Object} board */
export function ownBoardOnly(board, memberId) { throw new Error('not implemented'); }

/** SYNCHRONOUS, and takes NO passphrase — so the import sheet can state the consequence before
 *  the user commits to anything. @returns {{format, v, exportedAt, app, hasIdentity,
 *  needsPassphrase, memberId, kdf, counts, consequence}} */
export function inspectBackup(file) { throw new Error('not implemented'); }

/** PBKDF2 → HKDF(salt, INFO.backup) → AES-256-GCM. @returns {Promise<CryptoKey>} */
export async function deriveBackupKey(passphrase, salt, iterations, ports) { throw new Error('not implemented'); }

/**
 * Import: unwrap → MINT FRESH non-extractable device keys for this machine (never restore a
 * device identity; a device is a machine, not a person) → self-attest with the restored recovery
 * key → POST /devices/adopt signed by RK_sig → pull from seq 0.
 *
 * The POST is NOT done here (this module is I/O-free): `importBackup` returns `blob` and
 * `identity.recSig.privateKey`; the request and its signature belong to the sync layer.
 *
 * It returns a board **only on complete success**, and it writes NOTHING to `ks` on any failure —
 * asserted by fingerprinting the store before and after every refusal. Every failure is a
 * `BackupError` whose `.code` is one of `BACKUP_ERROR_CODES` and whose `.say` carries a German
 * and an English sentence, so no caller ever renders an engine error name (rule 3).
 *
 * ⚠ For the wiring ticket (`src/js/backup.js`, LZP-1004), two things it must not get wrong:
 * `result.board` is `schemaVersion: 2` and carries `visibility`/`coEdit`, so it goes through
 * ADR 001 §5.4's diff transaction and **never** through `migrateV1`; and `result.consequence`
 * must be shown on **both** paths. The exact call order is written out as §9 of `backup.js`.
 *
 * @param {BackupV2} file @param {string|null} passphrase @param {KeyStore} ks
 * @param {{deviceId:string, createdAt:string, iterations?:number, subtle?:SubtleCrypto,
 *          random?:Function}} opts
 * @returns {Promise<{board:Object, lineage:Object|null, identityRestored:boolean,
 *          identity:Identity|null, spaces:Object|null, attestation:DeviceAttestation|null,
 *          blob:string|null, consequence:Object,
 *          familyBinding:{spaceId:string, verified:false, say:Object}|null}>}
 *          `spaces.<which>` carries `missingEpochs:number[]` ONLY when the ring has holes (S8);
 *          its ABSENCE is the "complete" signal, and `consequence` then becomes
 *          `identity-restored-keys-pending`. `familyBinding` is non-null on every family restore.
 */
export async function importBackup(file, passphrase, ks, opts) { throw new Error('not implemented'); }

/**
 * S7 — PURE, SYNCHRONOUS, NO CRYPTO, so the export sheet can call it on every keystroke.
 * The floor is REPORTED, not enforced: `PASSPHRASE_FLOOR.hard` is false and D8's 2026-08-28
 * extension argues why. `exportBackup` also calls it once and fires `opts.onWeakPassphrase`.
 * @param {any} passphrase
 * @returns {{code:'ok'|'weak'|'empty', weak:boolean, chars:number, distinct:number,
 *            reasons:string[], say:{de,en}|null}}
 */
export function passphraseStrength(passphrase) { throw new Error('not implemented'); }

/**
 * S3 — the bytes the board digest is taken over, and the only thing that must be true of them:
 *   `boardDigestInput(b)` === `boardDigestInput(JSON.parse(JSON.stringify(b)))`
 * NOT `canonicalJSON` — that refuses floats, and losing a user's export to a stray `settings`
 * value would be worse than the attack this defends against. Sorts object keys; leaves arrays.
 * @param {any} board @returns {Uint8Array} never empty
 */
export function boardDigestInput(board) { throw new Error('not implemented'); }

// ─────────────────────────────────────────────────────────────────────────────
// 8. Helpers
//
// All four ALREADY EXIST in core/ and are re-used, not re-implemented: `b64u`/`ub64`/`crock32`
// in `src/js/core/b64.js`, `canonicalJSON` in `src/js/core/canon.js`. `canon.js`'s header
// explains why it is a security boundary rather than a convenience — its output is what gets
// signed, so two engines disagreeing about the bytes for one logical value would mean a
// signature made on one Mac silently failing on the other.
// ─────────────────────────────────────────────────────────────────────────────

/** @param {ArrayBuffer|Uint8Array} b @returns {string} */
export function b64u(b) { throw new Error('not implemented'); }
/** @param {string} s @returns {Uint8Array} */
export function ub64(s) { throw new Error('not implemented'); }
/** @param {Uint8Array} b @returns {string} Crockford base32 */
export function crock32(b) { throw new Error('not implemented'); }
/** Sorted keys, no whitespace, NFC strings, integers only. @param {any} v @returns {string} */
export function canonicalJSON(v) { throw new Error('not implemented'); }
