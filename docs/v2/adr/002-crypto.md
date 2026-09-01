# ADR 002 — Crypto: primitives, keys, pairing, recovery

| | |
|---|---|
| **Status** | Accepted — normative |
| **Date** | 2026-08-25 |
| **Tickets** | LZP-301, 302, 303, 304, 305, 306 · supports 502, 601/602, 608, 701, 1003, 1004 |
| **Stories** | 15.2, 15.3, 15.5, 19.4, 19.5, 20.2, 20.3, 20.5, 21.1, 21.2, 21.3, 21.4, A2 |
| **Amends** | LZP-301's "libsodium-based design" premise → `LZP-CRYPTO-1` (§1); LZP-302's "macOS Keychain via Tauri" → non-extractable IndexedDB keys + a Keychain *backstop* (§2.2) |
| **Amended** | 2026-09-01 (E7 red team, T5) — **§4.2's coverage check is restated as a ROW COUNT and §8 gains 8.5a.** `assertCoverage` asks whether a `KeyWrap` row EXISTS for every (required recipient, epoch) pair; it reads epoch numbers and never bytes, and it cannot, because telling a wrap from noise means opening one. `src/js/sync/keys.js` §4 had derived a client-side coverage PROOF from it (*"observing that an epoch EXISTS is observing that it held"*), and one junk wrap plus one lost race locked a joiner out of a Familienkreis for ever, silently — finding **T5-K1**. §8.5 covered only the over-wide half of the same absence (a rotator wrapping to devices that should not have the key); **8.5a** adds the mirror image, member-driven DENIAL of key delivery, with what is closed, what remains, and who owns the rest. Finding **T5-K2** is in the same pair: D9's waiting state is now answered from `ring.covers(1..e)` and not from the relay's row count. |
| | 2026-08-29 (E2↔E3 seam) — **§4.2 is amended in four places and §2.3 gains one optional field.** The rotation this section specifies could not be performed by any client over the API ADR 003 specifies, and both sides were green because neither suite ever put one side's output into the other's input. (a) Step 4's POST body is restated exactly: `wraps[]` carries `recipientId` (not `deviceId`), `wrapped` is **base64url of the canonical-JSON `WrapBlob`** (not the object), and it carries **no `invites`** — D9 removed the key material, so the relay refreshes open invites itself and refuses the field. (b) Step 6's `senderKexPubRaw` is **published by the relay, never supplied by a client**: `KeyWrap` gains a relay-stamped `senderDeviceId` and `GET /keys` serves the ADR's field by joining to `Device.kexPubRaw`. (c) `GET /spaces/:id/members` **publishes `Device.attestation`** — the roster step 6 already required, and without it `familyRecipients()` throws on the list the relay serves. (d) Step 2's "plus each member's `RK_kex`" is **SUSPENDED for the family space**: nothing signs `Member.recoveryPubKex`, so wrapping to it hands a curious relay `FSK_{e+1}` silently. §2.3 specifies the binding that lifts the suspension — an OPTIONAL seventh signed field `recoveryPubKex` in `DeviceAttestation`. Findings **E2E3-1 … E2E3-8**. |
| | 2026-08-28 (E3 fix pass) — §2.3's "Two shorts, no winner" is rewritten as **"One short, one signer"** and its claim that *"attestOpen (WP-6) MUST enforce P2, which closes this at the root and removes the stall"* is **struck as false**: P2 shipped and the squat still passes it, because `sigPubRaw` is public and the squat copies key and short together. I-3 / R5-7 is closed instead by a **possession proof at fold time** — a `dev.<S>` register is a credential only if the op that wrote it was stamped by the device it attests. §5.2.1's and §5.2.5's I-3 notes amended to match; §5.2.2 gains two obligations (check 4 is now load-bearing for the fold, and nothing may enter the log without passing `openOp`). |
| | 2026-08-27 (round 4) — §2.3's stated guarantee was untrue in two places and is corrected in place: the four acceptance conditions bind **nothing to `deviceId`** ("A `deviceId` is a label, not an identity"), and `deviceShort → DeviceAttestation` is *argued* rather than enforced, so a contested short now resolves to `null` instead of to a winner ("Two shorts, no winner"). §2.3 also gains "Revocation — the gap, and who owns it" (WP-9) and §8 gains **8.2a**. §5.2.1 and §5.2.5 amended to match; §5.2.4's T5 row extended. |

> This ADR is written threat-model-first. §0 names the adversaries; every later section
> justifies itself against one of them. §8 is the honest list of what those adversaries can
> still do — it is not an appendix, it is the section the Datenschutz copy (21.3, LZP-1001) and
> the removal confirmations (20.2, deliverable 22) are written from.

---

## 0. Threat model — the five adversaries

| # | adversary | what they hold | what they must NOT get | enforced by |
|---|---|---|---|---|
| **T1** | Curious or compromised relay (Vercel + Prisma, or anyone with a DB dump) | every envelope, every header, every IP, arrival times | any note text, bar label, scratchpad, category name, member display name, Belegt content | AES-256-GCM under keys the server never holds (§3); the minimal plaintext header (§5); size padding (§5.3) |
| **T2** | Removed family member (the ex-partner is the honest case) | all ciphertext they pulled, all epoch keys they held | ability to decrypt **future** family ops; ability to push or pull | epoch rotation (§4); device revocation + signature auth (ADR 003 §2) |
| **T3** | Stolen / seized laptop | a disk image, possibly an unlocked session | ideally everything | **partially unanswerable** — §8.2. Honest answer: FileVault + revocation + epoch bump |
| **T4** | Active MITM on pairing (hostile Wi-Fi, or a malicious relay) | the pairing session; ability to substitute ephemeral keys | ability to become one of my devices | the SAS comparison (§6) — **not** the code entropy |
| **T5** | Family member as adversary — **the admin included** | the family space key, the whole family log, admin endpoints | any Privat entry; any Belegt content; ability to edit or delete entries they do not own; ability to purge another member | two disjoint keys (§3); redaction at source (ADR 004); structural ownership + the staged authz fold (ADR 001 §4) |

**The one adversary we do not defend against, by design:** the honest family member who already
saw a shared entry. Addendum §6: *unsharing is not unremembering.* Every UI string touching a
visibility downgrade or a member removal must say so (§7.4, ADR 004 §7).

**Design axiom.** *Plaintext leaves a device through exactly one function*, and that function is
`projectForFamily()` (ADR 004 §2). Everything in this ADR is a supporting argument.

---

## 1. Ciphersuite — `LZP-CRYPTO-1`, WebCrypto only, zero dependencies

**Decision (this ADR is LZP-301's deliverable; its "libsodium-based" premise is amended here):**

| purpose | algorithm |
|---|---|
| signing (device identity, op signatures, HTTP request auth) | **ECDSA P-256 / SHA-256** |
| key agreement (space-key wrapping) | **ECDH P-256** → **HKDF-SHA-256** → **AES-256-GCM** KEK |
| content encryption | **AES-256-GCM**, 12-byte IV, `tagLength: 128`, non-empty AAD |
| derivation | **HKDF-SHA-256** (salt mandatory — pass `new Uint8Array(0)` if you mean none) |
| backup passphrase | **PBKDF2-SHA-256, 600 000 iterations** → AES-256-GCM |

**`minimumSystemVersion` stays `12.0`.** No macOS floor bump. No new dependency. This is the
decisive reason P-256 wins over Curve25519, and it is evidence-backed, not preference:

- **Ed25519** shipped in **Safari 17.0** (18 Sep 2023) — [WebKit Features in Safari 17.0](https://webkit.org/blog/14445/webkit-features-in-safari-17-0/).
- **X25519** shipped only in **Safari 18.4** (31 Mar 2025) — [WebKit Features in Safari 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/):
  *"adds support for X25519 for Web Cryptography … deriveBits, deriveKey, exportKey, generateKey,
  and importKey"*. macOS **Monterey never receives it** (its last Safari is 17.6).
- **MDN `browser-compat-data` records `safari: 17` for X25519 and is wrong** — it contradicts
  WebKit's own release notes and Igalia's implementation history
  ([*Can I use Secure Curves in the Web Platform?*](https://blogs.igalia.com/jfernandez/2025/02/28/can-i-use-secure-curves-in-the-web-platform/):
  Ed25519 in STP 178, X25519 in STP 211). caniuse inherits the error. **Take 18.4.**
- **ECDSA / ECDH P-256** ship since **Safari 7 / 11**; HKDF, PBKDF2, AES-GCM and AES-KW since 11.
- **`LSMinimumSystemVersion` cannot express the X25519 floor anyway.** It gates the *OS*, but
  X25519 is gated by the *WebKit* version, and on Sonoma and Ventura Safari updates
  independently. A macOS 14.0 machine that skipped the March-2025 update has no X25519. A
  Curve25519 profile would therefore need the raised floor **and** a runtime probe **and** a
  designed degradation path. P-256 needs none of the three.

**Two WebKit deviations found by running known-answer tests inside a real WKWebView** (macOS 26.3,
`app://localhost` scheme), neither documented in any compat table. Profile 1 avoids both, but they
are recorded because a downstream agent will otherwise rediscover them at 23:00:

- **WebKit Ed25519 signatures are non-deterministic (hedged, CryptoKit-backed).** Signing the same
  message three times yields three different signatures, and RFC 8032 vector 1 is not reproduced.
  Signatures still interoperate with Node.
- **WebKit `verify()` returns `false` for Ed25519 over a zero-length message** — including for a
  valid RFC 8032 reference signature. ECDSA, HMAC and RSASSA all handle empty input correctly. A
  silent `false` on a valid signature is the worst possible failure shape for a sync protocol.

**Engine-difference rules that are part of this contract:**

| # | rule |
|---|---|
| 1 | **Never compare signature bytes.** WebCrypto ECDSA is non-deterministic in *both* engines. No golden-signature fixtures in CI, no signature-as-idempotency-key, no content address including `sig`. Assert `verify() === true`. |
| 2 | **Never sign or verify a zero-length payload.** The AAD is constructed to be always non-empty and `seal`/`open` keep an explicit `length === 0` guard. It costs nothing and documents the hazard. |
| 3 | **Never branch on error *names*.** Node says `InvalidAccessException` (non-standard) where WebKit says `InvalidAccessError`. Branch on `try/catch` boundaries only. |
| 4 | **`HkdfParams.salt` is mandatory** in both engines — omitting it is a `TypeError`. |
| 5 | **Import a peer's ECDH public key with `keyUsages: []`** — a non-empty array is a `SyntaxError` in both. |
| 6 | **Never AES-KW a P-256 private key.** PKCS#8 is 138 bytes, not a multiple of 8 ⇒ `OperationError` in both. Use AES-GCM for all key wrapping. (Trap: X25519/Ed25519 PKCS#8 is 48 bytes and *does* work — so a 25519 prototype hides this.) |
| 7 | **Node has no `indexedDB` and `isSecureContext` is `undefined`** (not `false`). Both engines report `isSecureContext === true` under the shell's `app://localhost` scheme. |

**Versioning, not negotiation.** One suite, pinned by `Envelope.v`, replaced wholesale if it ever
needs replacing. A client that meets a `v` it does not know **parks** the op (ADR 001 §7.4) and
reports a protocol error. There is **no downgrade negotiation surface** — that would be a
liability with no upside against a blind relay.

**The capability probe is a guard, not a gate.** `probeCrypto()` (~1 ms, §9.1) runs at the moment
the user first touches "Familienkreis erstellen / beitreten" or "Gerät koppeln" — **never in
solo mode, never on first run** (Principle 7, story 15.1). If any primitive is missing, the
family entry point stays disabled with one plain German sentence; solo mode is completely
unaffected. The probe result is logged into the LZP-1003 self-audit report and asserted in
LZP-1005.

---

## 2. Identity and key custody

### 2.1 The four keypairs

```
per DEVICE (one Mac)                                    custody: §2.2
  IK_sig   ECDSA P-256, extractable:false   signs ops, signs HTTP requests
  IK_kex   ECDH  P-256, extractable:false   receives wrapped space keys

per MEMBER (survives every device)                      custody: §2.2 + the backup file (§7)
  RK_sig   ECDSA P-256, extractable:true    "I am this member": attests devices, adopts devices
  RK_kex   ECDH  P-256, extractable:true    receives wrapped space keys during recovery
```

Plus two symmetric spaces keys (§3) and, on first *family* use only, a 32-byte device
encryption key `DEK` in the Keychain (§2.2).

### 2.2 Where private keys live — and why not simply the Keychain

**Primary: non-extractable `CryptoKey` in IndexedDB.** WebKit structured-clones a
non-extractable `CryptoKey` into IndexedDB and it survives, still non-extractable, still able to
sign — verified in a real WKWebView. Generating `IK_sig`/`IK_kex` with `extractable: false` means
the private bytes **never enter the JS heap at all**. That is strictly stronger than exporting
PKCS#8 to hand to a native Keychain API, which necessarily materialises the secret in JS where a
compromised page script could read it. It also works identically in the dev browser and in Node
(memory adapter), so the whole crypto layer is developable and CI-testable without a shell build.

**Backstop: the macOS Keychain, for the *recovery* identity only.** IndexedDB under a custom
`app://` scheme can be evicted by the OS, and eviction would look identical to "this device was
never paired". So `shell-macos/main.swift` gains three cases in the bridge switch (currently
`:142-211`), mirrored into `src-tauri/src/lib.rs` for parity:

```swift
case "keychain_set":     // SecItemAdd / SecItemUpdate,
                         // kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                         // service "org.langzeitplaner.keys", account = args["key"]
case "keychain_get":     // SecItemCopyMatching -> String? (NSNull if absent)
case "keychain_delete":  // SecItemDelete
```

The Keychain holds **only** a 32-byte `DEK` plus `RK_sig`/`RK_kex` as AES-GCM-wrapped PKCS#8
under that `DEK`. `IK_*` never leave IndexedDB. If IndexedDB is evicted the device must re-pair,
but the *member* identity survives, so the user is never locked out of their own membership.

**Fallback chain** in `src/js/crypto/identity.js`:
shell Keychain → `keys/recovery.enc` at mode `0600` in Application Support (dev / browser) →
in-memory (Node CI). All three sit behind one `KeyStore` port:

```js
/**
 * @typedef {Object} KeyStore
 * @property {(id:string) => Promise<CryptoKey|CryptoKeyPair|Uint8Array|null>} get
 * @property {(id:string, k:CryptoKey|CryptoKeyPair|Uint8Array) => Promise<void>} put
 * @property {(id:string) => Promise<void>} del
 * @property {() => Promise<string[]>} list
 */
```

`idbKeyStore()` in the app, `fileKeyStore()` in dev, `memKeyStore()` in tests. This asymmetry is
explicit in the LZP-1005 harness contract.

> **VERIFICATION ITEM for LZP-302 — do not assume.** Confirm with a real `--test` run that a
> non-extractable `CryptoKey` in IndexedDB **persists across an app relaunch** under the
> `app://localhost` scheme. If it does not, fall back to `identity.enc` in Application Support,
> AES-GCM-wrapped under the Keychain `DEK`, with `extractable: true` device keys — and record the
> downgrade in `DESIGN-DECISIONS.md`, because it is a real reduction in T3 resistance.
>
> **ANSWERED 2026-08-27 — YES. No downgrade; nothing to record in `DESIGN-DECISIONS.md`.**
> Proved by **two separate launches of the real shell**, not by one process writing and reading
> its own memory: `tests/tier2/crypto-keystore-phase1.dom.js` performs a full
> `ensureDeviceIdentity` and its process exits; `-phase2.dom.js` is a **new process** that reads
> it back. The restored key has `extractable === false`, `exportKey('pkcs8'|'jwk')` still
> **rejects**, a signature it makes verifies under the public point the *previous* process
> recorded, `deviceShort` is unchanged, and `ensureDeviceIdentity` **adopts** rather than mints.
>
> **⚠ One condition this ADR did not know about, and it is load-bearing.** WebKit cannot
> structured-clone a `CryptoKey` without the login Keychain: the persisted key is encrypted under
> a per-application "WebCrypto master key" WebKit keeps as a Keychain generic password **whose
> ACL is bound to the code signature of the binary that created it**. Re-sign or rebuild the app
> and WebKit can no longer read it — it logs `Cannot store WebCrypto master key, error -25299` to
> the process's *stderr* where the page cannot see it, `put()` then rejects with `DataCloneError`,
> and **previously stored keys read back as `null`** while plain values in the same database are
> untouched. So §2.2's framing that IndexedDB custody *avoids* depending on the Keychain is only
> half true: on WebKit the Keychain is a **prerequisite** of the primary store. Combined with
> **D1 (ship unsigned)** and LZP-102's bundle-replacing updater, every device key would become
> unreadable after an update. → **finding E3-1**, `docs/v2/FINDINGS.md`; owner WP-8 / LZP-102.

### 2.3 Device attestation — the anti-key-injection measure

A device's public keys are trusted **only** if signed by the owning member's recovery key:

```js
/** @typedef {Object} DeviceAttestation
 * @property {string} memberId
 * @property {string} deviceId      'dev_' + 22 b64url
 * @property {string} deviceShort   16 Crockford base32 (ADR 001 §1.2)
 * @property {string} sigPubRaw     b64url of the 65-byte raw P-256 point
 * @property {string} kexPubRaw     b64url, 65 bytes
 * @property {string} createdAt     'YYYY-MM-DD'
 * @property {string} [recoveryPubKex]  OPTIONAL, b64url, 65 bytes — the MEMBER's RK_kex. §4.2's
 *                                      suspended recovery wrap turns on this field. See below.
 */
signature = ECDSA-P256/SHA-256( RK_sig.private, canonicalJSON(attestation) )
```

#### `recoveryPubKex` — the optional seventh field, and what it buys  *(added 2026-08-29)*

**The problem it solves.** §4.2 step 2 wraps the space key "plus each member's `RK_kex`", and
`Member.recoveryPubKex` is a relay column that **nothing signs**. Swapping `recoveryPubSig` is
loud — every device attestation of that member stops verifying and the rotation halts. Swapping
`recoveryPubKex` alone is silent, leaves every attestation genuine, is invisible in the member
list, and hands the relay `FSK_{e+1}`. So §4.2 step 2's family half is SUSPENDED (finding
E2E3-8), and the only thing that lifts the suspension is a signature over that key by the member
whose key it is.

**The cheapest such signature already exists**, and this is why the field goes here rather than
into a new blob or a new column:

- the payload is signed by `RK_sig`, which is exactly the key that must vouch for `RK_kex`;
- `parseAttestationBlob` **already tolerates extra fields**, deliberately, so a v2.0 client reads
  a v2.1 blob unchanged, and those fields are **already covered by the signature**.
  **That tolerance is a property of the parser and of clients reading the member list.** The
  relay's door is a CLOSED SET (`assertAttestationClosed`, `server/core/handlers/devices.js`),
  because the relay PUBLISHES this blob and cannot park what it must store; a new field is
  therefore added to the relay's allow-list **one release BEFORE any client mints it** — ADR 003
  §4's N−1 rule, in the server-first direction.

  **And the release order is NOT the whole protocol, which is amendment B-16 (round 10).** Saying
  "server first" states the intention and leaves the client with no way to act on it. What
  actually bites is that a v2.1 client meeting an older relay gets
  `400 { reason: "attestation_unknown_field" }` and has every reason to read it as a malformed
  request of its own. So: **the allow-list is part of the HTTP surface and moves with
  `X-LZP-Protocol`.** A field is added to the allow-list in protocol `N`; a client MUST NOT mint
  it until it has seen `maxProto ≥ N` (already published by `GET /meta` — no new surface); and
  that `400` is a **version signal**, which is what 22.4's „Update verfügbar" is for, pointed at
  the *server*. The two rules never governed the same object: ADR 003 §4's N+1 park rule governs
  the **encrypted op stream the relay never reads**, and this blob is an HTTP field the relay
  **stores and publishes**, where a tolerant door would be R8-7's free-text channel. The full
  statement, with its five obligations, is **ADR 003 §4.2**. *(Amendment B-13, round 9. The finding
  it closes is R8-7: the closed set had shipped on two of the four doors that persist a `Device`
  row, so `POST /devices` and `/devices/adopt` stored a seventh field verbatim and
  `GET /spaces/:id/members` published it — a free-text channel through a relay whose whole claim,
  story 21.1, is that it holds none.)*;
- the relay **already accepts** the field — it is the one entry on `assertAttestationClosed`'s
  optional list — and checks only its shape, because the binding is not the relay's to make;
- a member attests every one of her own devices, so the binding is repeated once per device and
  a relay that swaps the column is contradicted by every one of them.

**The obligations, and there are exactly three:**

1. `identity.js` `attestDevice()` must sign it when the caller supplies it. Today it
   re-canonicalises exactly six fields, so it cannot mint a seventh — that is the one change.
2. `familyRecipients()` must build the recovery recipient **only** when the member's own device
   attestations carry a `recoveryPubKex` equal to the roster's `Member.recoveryPubKex`, and
   `recipientProblem()`'s named refusal must be narrowed to the unbound case rather than deleted.
3. `requiredRecipients()` may then demand `rec_<memberId>` of a family space again. It does not
   need to change first: the wrap is already a KNOWN recipient, so it lands as soon as a client
   can build it.

**Not a fifth acceptance condition.** The four conditions below are unchanged; this field is
covered by condition (4)'s signature and by nothing else, and no `dev.*` register is accepted or
rejected on account of it. A blob without it is a v2.0 blob and stays valid for ever.

The attestation travels **inside the E2EE stream**, as the family register
`member:<memberId>` → field `dev.<deviceShort>` → value `b64u(canonicalJSON(att)) + '.' + b64u(sig)`
(a write-once register, ADR 001 §3.1). It is therefore authored under a key the relay does not
hold, so **a malicious relay cannot fabricate a device row for an existing member.**

Every client verifies the attestation before accepting an op from that device (ADR 001 §4.0), and
**every client verifies it before wrapping a space key to that device** (§4.2).

**The four conditions under which a `dev.*` register is accepted at all** (ADR 001 §4.0), stated
here because §5.2's lookup depends on every one of them:

1. the op writing it is admissible — `op.act === memberId`, the record's own member and nobody else;
2. the **register name equals `att.deviceShort`**;
3. `att.memberId` equals the housing member; and
4. the signature verifies under **that housing member's** recovery key.

**Consequence, and it is load-bearing for §5.2: `deviceShort → DeviceAttestation` is a FUNCTION
across the whole space.** A member who copies a peer's attestation blob verbatim into their own
record — the blob is inside the E2EE stream, so every member can read it — fails (3) and (4) and
the register never enters the table. Two members legitimately holding the same short would need the
same signing **private** key, which is outside the model. This is what lets `openOp` resolve a
device from `env.dv` alone, **before** it has decrypted anything and therefore before it knows
`op.act`.

> **AMENDED 2026-08-27 — round-4 finding 4 and finding I-3.** The paragraph above overstated the
> guarantee in two places and the corrections are normative. **(a)** "a function" is what the four
> conditions *argue*, not what they *enforce*: two members would need the same signing private key
> to collide **honestly**, but a dishonest collision needs only a well-formed blob, because
> nothing pure and synchronous can check §5.2.2's P2. **(b)** the four conditions bind
> `memberId` and `deviceShort` and bind **nothing to `deviceId`** — see "A `deviceId` is a label"
> below. Neither correction changes the wire form or the four conditions.
>
> **AMENDED AGAIN 2026-08-28 — I-3 CLOSED.** (a) above is still true of the FOUR conditions and
> the amendment stands. What has changed is that a **fifth** rule now enforces what they only
> argued, and it is not a fifth *acceptance* condition — the blob is still accepted — it is a
> rule about which accepted register is a **credential**: the op that wrote it must have been
> stamped by the device it attests. See "One short, one signer" below. The wire form and the four
> conditions are again unchanged.

#### A `deviceId` is a label, not an identity

Enumerate the payload's six fields against the four acceptance conditions. `memberId` is bound by
(1), (3) and (4). `deviceShort` is bound by (2). `sigPubRaw` and `kexPubRaw` are covered by the
signature. `createdAt` is decorative. **`deviceId` is bound by nothing** — it is 128 random bits
with no derivational relationship to any key, asserted by its own author.

So a member can mint an attestation that is honest in every checkable respect — her record, her
short, her `memberId`, her signature, her keys — carrying **a peer's `deviceId`**. All four
conditions pass. `src/js/core/authz.js` claimed the opposite in a comment ("a deviceId can only
ever map to one member") and published a `deviceId → memberId` map resolved first-writer-wins,
which made the outcome of a two-member dispute a function of who backdated harder.

**There is no fifth condition to add.** No pure fold can know which member a random label
"really" belongs to, and any rule that picked a winner would be picking it on a stamp the
attacker chooses. So the fix is ADR 001 §4.4's, applied here: **remove the forgeable resolver
rather than guard it.**

> **The identity of a device is the pair — the housing member record and the register name — and
> the register name is `deviceShort`, which ADR 001 §1.2 derives from the signing key and §5.2.2
> P2 self-certifies. `deviceId` is a label carried inside one signed attestation and is
> meaningful only relative to it. Nothing may key on a bare `deviceId`.**

Everything that enforces anything already reads the pair: ADR 001 §4.0 stage 0b asks whether
`op.dev` is attested **in `op.act`'s own record**, and §5.2.2's checks 3 and 5 read `deviceId` and
`memberId` off the *same* attestation resolved by `env.dv`. `AuthzResult.memberOfDevice` now
answers only when there is exactly one claimant and returns `null` otherwise, with every contested
label published on `AuthzResult.deviceIdCollisions`.

A contested claim is **admitted, not rejected**, and that is deliberate: refusing both claims
would hand any member a way to un-attest an honest peer's device by naming its label — a denial
of service strictly worse than an unresolved query. It costs the forger nothing either, and that
is the property that makes this a fix rather than a mitigation: **any op she can author holding a
copied label she can author holding an invented one**, so copying is a name collision and not a
capability. She still cannot author as the victim (stage 0b reads `op.act`'s own record) and
cannot sign as the victim's device (P2/P3 bind the signature to `att.sigPubRaw`).

**Obligation on WP-9 and WP-6.** Story 20.2's device purge (`deleteOpsByDevices`) and any
per-member device panel must key on **`deviceShort`** — which the relay derives and self-certifies
at registration (§5.2.0) — or on the pair. A purge keyed on `op.dev` would let a removed member
name an honest peer's label and have that peer's ops deleted with her own.

#### One short, one signer  *(was "Two shorts, no winner" — rewritten 2026-08-28, I-3 CLOSED)*

The mirror residual. Nothing pure and synchronous can check
`crock32(SHA-256(sigPubRaw)[0..10]) === att.deviceShort` — that is §5.2.2's **P2**, it needs a
SHA-256, and the authorization fold may not await — so a member **can** file a well-formed
attestation under a peer's short (finding I-3). Two answers were tried before this one, and both
are recorded because the second was shipped and was worse than it looked:

1. **resolve minimal-under-`≺`.** Handed a *backdated* squatter the lookup, and therefore handed
   `openOp` the squatter's verification key.
2. **refuse the contest** — `attestationOf` returns `null` for a contested short, which parks the
   sealed envelope (P1) rather than opening it under the wrong key. Safe against impersonation,
   and **catastrophic against denial of service**: the short is the last sixteen characters of
   every stamp a device has ever written, a `dev.*` register is self-authorizing, `dev.*` is
   write-once and there is no revocation — so **one op from any member permanently muted any named
   Mac in the family**, and the user's symptom was "my calendar stopped syncing and nobody can say
   why". Worse still, in the window before the victim's own register had been folded there was no
   contest to see: the squat *resolved*, P2 passed, P3 passed, the AEAD passed, and §5.2.2's
   **check 5 threw** — a rejection, which is final, so the victim's traffic was not parked but
   **dropped**. Red-team rows M-I3b and M-I3c.

> **THE SENTENCE THAT STOOD HERE IS STRUCK, AND IT WAS FALSIFIABLE AND FALSE.** It read:
> *"`attestOpen` (WP-6) MUST enforce P2, which closes this at the root and removes the stall."*
> P2 shipped as a MUST in `verifyAttestation`, and **the squat still passes**, because
> `sigPubRaw` is a **public key travelling in the victim's own register**, inside the E2EE stream
> every member can read. She copies the key *and* the short, tells the truth about the binding
> between them, and satisfies P2 with room to spare. **A remedy that binds two fields cannot catch
> an attacker who copies both.** P2 remains a MUST — it stops a member inventing a short unrelated
> to any key, and it is what refuses the *other* spelling, a peer's `sigPubRaw` filed under one's
> own short — but it is not what makes the lookup a function.

**What makes it a function** is FINDINGS §4.5 option (a) — first-claim binding on the pair
`(sigPubRaw, deviceShort)` — with the strengthening the red team's own measurement forced. Option
(a) was priced as *"the first writer wins a race"*. It is not a race, because the claim only counts
when it is **proved**, and only one claimant can ever prove it:

> **A `dev.<S>` register is a CREDENTIAL only if the op that wrote it was itself stamped by the
> device it attests:** `devOf(op.ts) === att.deviceShort`.

That one equality is a possession proof, and it is the only one a pure fold can read. Every op
reaching the fold came through `openOp`, which binds three things to `env.dv`: **P2** (`env.dv` is
the short of `att.sigPubRaw`), **P3** (the envelope signature verifies under `att.sigPubRaw`), and
**check 4** (`devOf(op.ts) === env.dv`). So an op whose stamp ends in `S` was signed by the holder
of the private key that hashes to `S`. The public fields are copyable — that is exactly why P2
alone never closed this — but **the signature is not**, and the stamp is where the signature shows
through into the plaintext the fold sees.

This is what every honest flow already does and the only thing any of them do: §6.3 step 8, the
new Mac **self-attests** and writes its own register (`pairing.js` `adoptPairedDevice`); §7.3 step
4, the restoring Mac self-attests (`backup.js`, `ensureAttestedDevice`). **No flow has one device
file another device's attestation, and none may be added.**

The squatter's register is still **admitted** — refusing it would hand any member a way to
un-attest an honest peer by naming their short, which is the same worse trade this ADR already
refuses for the *label*, and it would cost her nothing since any op she can author under a peer's
short she can author under an invented one. It is admitted, **reported on
`AuthzResult.unprovenShorts`**, and never resolved.

**`attestationOf` still returns `null`, and all three causes are parks:**

1. no claim on the short at all;
2. every claim on it **unproven** — including the pre-collision window, which is now a P1 park
   instead of a resolve-then-throw. Check 5 in `envelope.js` is unchanged and stays a throw; it
   simply never runs, because a blob nobody can back is no longer admitted as a credential;
3. the short **proved on two different member records**. Two members cannot both hold one signing
   private key, so this is a genuine 80-bit collision or a broken engine, and neither is a contest
   a fold may pick a winner in. Reported on `AuthzResult.shortCollisions`, together with the one
   `sigPubRaw` under two different shorts — a direct contradiction of §1.2 visible without hashing
   anything, which `verifyAttestation`'s P2 already refuses at condition (4), so it is defence in
   depth against a blob arriving some other way rather than the live check it looks like.

**Two obligations this creates, and they are load-bearing.** The fold reads `op.ts` and trusts it
*because* `openOp` checked it. So: **§5.2.2's check 4 may not be weakened, made optional, or moved
after the decrypt**, and **nothing may append an op to the log without it having passed `openOp`**
— or that door must refuse `member.set{dev.*}` outright. A v1 migration, an import, a local author
or a future replay path that skips the envelope carries whatever stamp its author chose.
Characterized as **M-I5b** in `tests/attack/crypto-member-impersonate.test.js`, which stays green
because the door, not the fold, is where that would have to be fixed. Owner: **WP-8**.

**What is not closed.** The bootstrap: a brand-new device's own attestation travels in an envelope
sealed under its own short, so a peer who has never seen that device cannot open the op that would
tell it the key. That is ADR 001 §4.0's regress at the envelope seam rather than the fold's, it
predates this change and is untouched by it, and it is why §2.3's device panel and the pairing
flow — not the fold — have to deliver a first attestation. Owner: **WP-9**.

#### Revocation — the gap, and who owns it

**There is no device revocation anywhere in the authorization fold, and `dev.*` write-once means
an attestation cannot even be amended or withdrawn.** A `member.set{dev.<short>: null}` loses to
the original claim; a replacement blob under the same short is rejected `writeOnce`. So the
attestation of a stolen laptop (T3) or of an ex-partner's Mac (T2) stays valid forever, and stage
0b keeps admitting its ops.

What exists today is **key distribution, not admissibility**: the epoch bump (§4) stops wrapping
new space keys to a revoked device, so it cannot read *future* content. It can still author ops
the fold admits, and it can still read every epoch it already holds. That is the honest statement
of the T2/T3 residual and it belongs next to §8.2's.

**Owner: WP-9** (Familienkreis lifecycle — create → invite → join → member list → remove with
rotation → leave → delete space), together with ADR 003 §2's device revocation on the relay. The
design decision it must make, and which is deliberately *not* made here: a revocation is an
admissibility fact about a device, so it needs a register that a later op can write — which is
exactly what `dev.*` write-once forbids. Either a **separate** `rev.<deviceShort>` register on the
owning member's record (write-once too, so it cannot be un-revoked, and admissible only from the
housing member or the admin), or a revocation carried in the space record. Whichever is chosen,
it must be a *fold* input, or two devices will disagree about whether an op is admissible.
Characterized as row **R4-16a** in `tests/attack/round4-attestation.test.js`, which stays green
because the gap is real.

Residual: a malicious relay could still fabricate a whole *member* row on the coordination API.
The rotating client would then wrap the family key to an unattested stranger unless someone
notices an unknown name in the member list. **The member list is therefore a security surface,
not just a roster** — deliverable 22 must treat it that way, and the panel shows a per-member
**device count** so an extra device is at least visible. §8.5. The count is unaffected by the
label forgery above (one register, one device, whatever the label says), and the panel SHOULD also
render `deviceIdCollisions` and `shortCollisions`, the two contests the fold can see but cannot
decide, **and `unprovenShorts`, which is the one it now decides** — a member trying to claim a
peer's short costs the peer nothing, but the family should still be able to see that it happened.

### 2.4 Solo mode generates nothing

First run mints only a `memberId` (a uuid) and a `deviceShort` (derived on demand). **No keygen,
no probe, no network, first-run screen unchanged.** Key generation happens at the family opt-in
moment and nowhere else.

---

## 3. The key hierarchy — and why no family key can ever decrypt a private entry

```
PSK      AES-256-GCM 256-bit, per epoch    PERSONAL space. One per member. My devices only.
FSK_e    AES-256-GCM 256-bit, per epoch    FAMILY space. Every current member device.
```

| | Personal space `psp_…` | Family space `fsp_…` |
|---|---|---|
| exists when | ≥2 of my own devices are paired (19.4) | I create or join a Kreis (15.2/15.3) |
| key holders | only devices I have paired via §6 | every current, attested member device |
| carries | **everything**: Privat, the Belegt/Geteilt *source* entries, categories, scratchpads, tombstones | only `pub.*` projections + `member:`/`space:` records |
| epoch bumps on | device add / device unpair | every membership change (join, remove, leave) |

**Stories 20.5 and 21.2 — "enforced by encryption, not by policy" — rest on four independent
barriers.** All four are required, and all four must appear in the Datenschutz copy:

1. **Key separation.** `PSK` and `FSK_e` are independently generated with
   `crypto.getRandomValues(32)`. There is no derivation path between them — not a KDF, not a
   shared parent, no master key. Possessing `FSK_e` gives **zero** information about `PSK`.
2. **Transport separation.** `PSK` is wrapped only to `IK_kex` of devices in **my own** device
   list and to `RK_kex`. `src/js/crypto/spacekeys.js` has two non-overlapping recipient
   resolvers, `personalRecipients(identity)` and `familyRecipients(members)`; the personal
   wrapping path never consults a family member list, and there is no code path from one to the
   other. The only route into my device list is §6's pairing protocol with human SAS
   confirmation.
3. **AAD binding.** Every envelope's AAD contains `space` and `epoch`. A personal envelope
   replayed into the family stream fails GCM tag verification, and its ECDSA signature over the
   same AAD fails too. There is no "wrong key, right ciphertext" degradation path —
   `OperationError`, verified in both engines.
4. **Redaction at source, above all of the above.** A Privat entry **never produces a
   family-space op at all**, and a Belegt entry's text is never encoded into one. Even total
   compromise of every family key reveals nothing private, because the plaintext was never
   there. ADR 004 is the proof.

The admin role is a *coordination* role over the op log; there is no crypto path from admin to
anyone's `PSK`. That is what makes 20.5 true by construction.

```js
// src/js/crypto/spacekeys.js — DOM-free
export async function createSpaceKey()                                    // -> CryptoKey AES-256-GCM
export async function wrapSpaceKey(spaceKey, myKexPriv, theirKexPub)      // -> WrapBlob (~156 B JSON)
export async function unwrapSpaceKey(blob, myKexPriv, theirKexPub)        // -> CryptoKey
export async function wrapToRecipients(spaceKey, myKexPriv, recipients)   // recipients: Device[]
export function personalRecipients(identity)   // ONLY my devices + my RK. Hard-coded scope.
export function familyRecipients(members)      // every non-removed member's attested devices
export class KeyRing { get(space, epoch); put(space, epoch, key); currentEpoch(space); }
```

`WrapBlob = { v: 1, salt: b64u(32), iv: b64u(12), ct: b64u }` — verified 156 bytes of JSON.
Derivation: `ECDH(mine, theirs) → HKDF-SHA-256(salt, info) → AES-256-GCM KEK → wrapKey('raw')`.

**HKDF `info` labels are fixed strings and part of the wire format:**

```
'lzp/v2/space-key-wrap'   'lzp/v2/pair/rid'   'lzp/v2/pair/ck'   'lzp/v2/pair/sas'
'lzp/v2/pair/kek'         'lzp/v2/invite/id'  'lzp/v2/invite/verify'
'lzp/v2/invite/wrap' [RETIRED — D9]           'lzp/v2/backup'     'lzp/v2/device/dek'
```

---

## 4. Epochs and rotation (LZP-303 · stories 20.2, 20.3, 20.5)

### 4.1 Triggers

| event | rotate? | why |
|---|---|---|
| member joins (15.3) | **yes** → `e+1` | so a leaked, already-redeemed invite yields a superseded key |
| member removed (20.2) | **yes** → `e+1` | T2 |
| member leaves (20.3) | **yes** → `e+1` | T2 |
| my device paired (19.5) | **yes**, personal space → `e+1` | |
| my device unpaired | **yes**, personal space → `e+1` | |
| admin role transfer (20.1) | no | nobody's read access changes |
| space rename, profile edit | no | |

### 4.2 Who rotates, and the procedure — **amended 2026-08-28: the check goes on BOTH sides**

> **This section was wrong, and it was wrong by omission.** Step 2 below put the attestation check
> on the **wrapping** side and there was no equivalent on the **receiving** side — and the
> receiving side is the one that decides which key it will use. `admitWraps` therefore read the
> sender's ECDH public key off `KeyWrapRow.senderKexPubRaw`, a field of the relay's own JSON, and
> verified nothing: no member list, no attestation, no recipient check.
>
> One throwaway ECDH keypair and one extra row in `GET /api/v1/spaces/:id/keys` put a key of the
> attacker's choosing into a victim's ring — **for the personal space as readily as the family
> one** — and the victim then sealed its own Privat entries under it. That is a live break of
> stories 20.5 and 21.2 that walks past all four of §3's barriers without touching any of them,
> because the four barriers answer *which key opens which envelope* and this changes *which key
> the victim uses*. Found independently by the T1/T2 and T5/T4 red teams (finding **S1**).
>
> **Step 6 below is the amendment.** It is written as a step of this procedure rather than as a
> footnote in §4.4 because it is the same check as step 2, in the other direction, against the
> same list.

**The member whose action caused the rotation performs it** — the joiner on join, the admin on
removal, the departing member's successor-admin on leave. This removes the "the admin's Mac must
be awake" dependency that would otherwise put story 15.3 ("a non-technical family member gets in
within a minute") at the mercy of a sleeping laptop.

1. `FSK_{e+1} = createSpaceKey()`
2. Verify the **device attestation** (§2.3) of every current, non-revoked member device, then
   `wrapSpaceKey(FSK_{e+1}, myKexPriv, deviceKexPub)` for each, plus each member's `RK_kex`.

   > **AMENDED 2026-08-29 — "plus each member's `RK_kex`" is SUSPENDED for the family space.**
   > Finding **E2E3-8**. The wire field exists (E3-2 added `Member.recoveryPubKex` and
   > `GET /spaces/:id/members` publishes it) and `familyRecipients()` still refuses to use it,
   > because **nothing signs it**. The asymmetry is the argument: `recoveryPubSig` is also a relay
   > column, but it is self-checking *in use* — swap it and every device attestation of that
   > member stops verifying, `assertRecipients` throws and the rotation stops, loudly.
   > `recoveryPubKex` is checked by nothing: swap it alone and every attestation stays genuine,
   > the member list looks exactly right, no signature fails, and the next rotation wraps
   > `FSK_{e+1}` to a key the relay chose. That is not §8.5's accepted, UI-surfaceable phantom
   > member — it is a **silent, unattributable key injection**, the same class as finding S1 one
   > door further along, and a live break of 21.1 and 21.2.
   >
   > So: `familyRecipients()` builds no recovery recipient; `recipientProblem()` **refuses a
   > family-scoped recovery recipient by name** so a future change cannot open the door by
   > accident; and `requiredRecipients()` on the relay no longer *demands* the row for an `fsp_`
   > space — it remains a KNOWN recipient, so the day the binding exists no relay change is
   > needed. The **personal** space is unaffected and still requires it: `personalRecipients()`
   > builds that recipient from `me.recoveryKexPubRaw`, my own key, held locally, which never
   > came off a relay.
   >
   > **The price, stated rather than hidden.** A family member who loses every device has no wrap
   > addressed to her recovery key, so §7.3's A2 recovery of a FAMILY space waits for the next
   > rotation by somebody else — which re-wraps epochs `1..e+1` to the device she re-adopts with
   > `RK_sig`. That is a delay. The alternative is the relay reading the family board. **The
   > binding that lifts the suspension is specified in §2.3 ("`recoveryPubKex`, the optional
   > seventh field"), and closing this means BUILDING IT** — not calling `rawOf(recoveryPubKex)`.
3. Re-wrap every **open (un-redeemed, non-expired, non-revoked) invite blob** to `FSK_{1..e+1}`
   under its stored `wrapSalt` — the server returns the open-invite list in the same call
   (§5 of ADR 003). *Rotation must not silently invalidate a pending invite; a family of eight
   onboarding two people at once would otherwise break.*

   > **SUPERSEDED BY D9, and the wire now says so.** An invite carries no key material, so there
   > is nothing for a client to re-wrap and **the POST body carries no `invites` field** — the
   > relay refreshes every open invite's epoch itself. `rotateEpoch` refuses the field's
   > *presence* (`400 retired_by_d9`), and `rotationBody()` does not emit it, so a body spread
   > from a `Rotation` is no longer a 400. Finding **E2E3-4**.
4. `POST /api/v1/spaces/:id/epoch { epoch: e+1, wraps: [{recipientId, epoch, wrapped}] }`
   — one transaction: insert the `KeyWrap` rows, set `Space.currentEpoch`, **delete every
   `KeyWrap` belonging to a removed or revoked device, for all epochs**, refresh open invites.

   > **AMENDED 2026-08-29 — the body is restated exactly, because the old spelling was a 400.**
   > Findings **E2E3-1 … E2E3-4**. Three fields and one absence, and each was a real mismatch
   > between this ADR's client and ADR 003's relay:
   >
   > | field | it is | it was, and why that failed |
   > |---|---|---|
   > | `recipientId` | a device id **or** `rec_<memberId>` | the client emitted `deviceId`; `readObject`'s closed field set 400s an unknown key. The relay's spelling wins and is also the true one — `rec_…` is not a device id (finding E3-4) |
   > | `epoch` | per entry | unchanged; a rotation carries the `1..e` backfill alongside `e+1` (§4.3) |
   > | `wrapped` | **base64url of `canonicalJSON(WrapBlob)`** | the client emitted the `WrapBlob` OBJECT. `KeyWrap.wrapped` is `Bytes` and `OPAQUE_FIELDS` refuses a String there — that refusal is what makes "a future handler cannot store a readable note" structural — so the encoding moves to the client. `spacekeys.js` `encodeWrap`/`decodeWrap` are the only two functions that perform it |
   > | *(no `invites`)* | — | see step 3 |
   > | *(no sender)* | — | see step 6 |
   >
   > **`rotationBody()` is the ONLY function that writes this body and `parseKeysResponse()` the
   > only one that reads the reply.** A second translator anywhere is this finding again: the one
   > program that ran both sides before this pass, `server/dev/two-client.js`, hand-rolled its own
   > packer and carried the sender key by courier, and so stepped over every gap instead of
   > hitting one.
5. Emit `space.set{epoch: e+1}` into the family log so honest clients switch immediately.
6. **ON THE RECEIVING DEVICE — the mirror of step 2, and it is not optional.** Before a wrap row
   from `GET /api/v1/spaces/:id/keys` is unwrapped, the receiver verifies **who sent it**, against
   the same list and by the same rule step 2 uses: the row's `senderKexPubRaw` must be the
   agreement key of a device that is **admissible for that space**, and that device's attestation
   must verify under its housing member's `RK_sig` with `att.kexPubRaw` bound to the key itself
   (§2.3). A row naming any other key is refused before a KEK is derived; it is **not** allowed to
   fail on the AEAD instead, because an AEAD failure is a statement about arithmetic and not about
   identity.

   **The admissible sender set for a space is the same set as its recipient set:**

   | space | admissible senders |
   |---|---|
   | personal `psp_…` | **my own** attested, non-revoked devices, and nothing else — never another member's device, however attested, however current |
   | family `fsp_…` | every **non-removed** member's attested, non-revoked devices |

   > **AMENDED 2026-08-29 — `senderKexPubRaw` IS PUBLISHED BY THE RELAY, NEVER SUPPLIED BY A
   > CLIENT.** Finding **E2E3-3**. This step was unimplementable end to end: `MODEL_COLUMNS.KeyWrap`
   > had four columns and none was a sender, `GET /spaces/:id/keys` returned
   > `{epoch, recipientId, wrapped}`, and `POST /spaces/:id/epoch` 400s a wrap carrying a fifth
   > key — so `admitWraps` had no index into its verified set and **threw on every honest row**.
   >
   > `KeyWrap` gains **`senderDeviceId`**, written by the relay from the request it authenticated
   > (`auth.deviceId` on a rotation, the founding device on `POST /spaces`) and **never read off a
   > body** — `readWraps`'s closed field set refuses both spellings. `GET /spaces/:id/keys` then
   > serves this section's own field, `senderKexPubRaw`, by joining to the `Device.kexPubRaw` it
   > already holds and already publishes in the member list. The client side and the wording above
   > are therefore unchanged.
   >
   > **Why a stamped device id rather than the client-supplied key this section first specified.**
   > The row only ever *selects* a sender — the `CryptoKey` the KEK is derived against is the one
   > `admissibleSenders()` imported from the sender's own verified attestation — so the field need
   > only be an index. A 65-byte client-chosen blob on every wrap row is a covert channel a blind
   > relay has no reason to accept; a stamped device id carries **zero** client-chosen bits and
   > states no fact the relay did not already observe when it checked that signature. It is
   > classified in ADR 003 §5.2's inventory as such.
   >
   > **What the relay can do with it, exactly:** lie. A relay that stamps or serves the wrong
   > sender causes a **refusal** — the receiver derives against a key the wrap was not made for,
   > or looks up a key that is not in its set — and never an admission. A dangling sender (the
   > device row cascaded away by a member removal) publishes `null`, which `SenderSet.lookup`
   > answers `null` for, which is `unauthorized`: the correct answer for a key deposited by a
   > device this space no longer admits. The rotation that follows the removal re-deposits epochs
   > `1..e+1` under a live sender, so it heals.

   `src/js/crypto/spacekeys.js` implements this as a **required parameter, not a validation step**:
   `admitWraps(ring, rows, ctx)` refuses to run without `ctx.senders`, and `ctx.senders` can only
   be the branded `Recipient[]` that `personalRecipients()` / `familyRecipients()` produce —
   §3 barrier 2's two constructors, whose scopes are hard-coded and whose brand is a
   non-enumerable module-private `Symbol` a caller cannot forge. `admissibleSenders()` runs every
   entry through the wrapping side's own `recipientProblem()` and indexes the public keys **it**
   imported, so `senderKexPubRaw` selects a sender and can never supply one.

   **The bootstrap residual, stated rather than hidden.** A device's first family sync (§7.1 step
   6) holds no epoch key, so it cannot fold the family stream and its roster must come from relay
   coordination data (`MemberRowDb.recoveryPubSig` plus the `dev.*` blobs).

   > **AMENDED 2026-08-29 — and that roster is now actually served.** Finding **E2E3-6**. This
   > paragraph specified the roster in 2026-08-28 and `handlers/members.js` did not publish
   > `Device.attestation`, on the defensible ground that "the relay's device rows are a hint about
   > who to wrap to; the log is the authority". `familyRecipients()` — the ONLY constructor of the
   > branded recipient/sender set §3 barrier 2 and this step are built out of — **throws** on a
   > device with no attestation blob. Two defensible positions, and together a rotation nobody
   > could build. `GET /spaces/:id/members` now publishes it.
   >
   > **The 21.1 cost is nil, and that is measured rather than argued.** Every field inside the
   > blob is already a column the relay holds and already publishes — `memberId`, `deviceId`,
   > `deviceShort`, `sigPubRaw`, `kexPubRaw` — plus `createdAt`, a DAY, strictly coarser than the
   > `Device.addedAt` the relay keeps to the millisecond. The relay already STORED the blob. And
   > every member can already read the same blob out of the E2EE stream (§2.3: *"the blob is
   > inside the E2EE stream, so every member can read it"*). To keep that true rather than
   > incidental, the relay now enforces a **closed field set** on the payload at every write path:
   > the six §2.3 fields plus the one optional `recoveryPubKex` below, `createdAt` matched against
   > `YYYY-MM-DD`. There are no free bits, so the blob is not a channel. Forward compatibility
   > becomes explicit — a v2.1 field must be added to that list, exactly as a new column must be
   > added to `MODEL_COLUMNS`, under ADR 003 §4's N−1 rule.
   >
   > **It is a hint and never authority.** `recipientProblem()` re-verifies the signature under the
   > housing member's `recoveryPubSig`, re-checks P2, and binds `att.kexPubRaw` to the very key the
   > wrap would be addressed to. A relay that fabricates a blob fails that signature; a relay that
   > fabricates a blob *and* a recovery key has invented a whole MEMBER, which is §8.5's
   > already-accepted, UI-surfaceable phantom. The distinction §2.3 already draws is the one that
   > resolves this: the relay's device rows support **key distribution, not admissibility**.
   >
   > **Where it is NOT published, deliberately:** not on `GET /ops`. That piggyback runs every 45
   > seconds for every device in every space; the rotation roster is a membership-change path.
   >
   > **One residual this creates.** `familyRecipients()` throws on an unverifiable blob, so a
   > device row carrying one wedges every future rotation for the whole family. Every write path
   > now enforces the blob's shape and self-consistency, and `POST /spaces` and `POST /devices`
   > additionally verify the signature — **`POST /invites/redeem` does not yet**, and must. Owner:
   > `server/core/handlers/invites.js`. Every attestation in
   that roster is verified, so a relay that wants an admission must invent a whole **member** —
   recovery key, device, attestation — which surfaces in the member list (15.4). That is §8.5's
   already-accepted, UI-surfaceable phantom member, not an anonymous key injection. The personal
   space has no such bootstrap: its sender set comes from my own pairing record (§6), authenticated
   out of band by the SAS.

   An empty sender set is legal and means "I can authenticate nobody yet": every row is refused and
   the ops stay parked (§4.4). That is the correct state between §7.1 steps 2 and 6, and it is the
   reason this is a refusal rather than a throw.

**Two server-enforced checks make rotation safe without the server reading anything:**

- `@@unique([spaceId, epoch])` on the `Epoch` row ⇒ **first writer wins**. A concurrent rotator
  gets `409 epoch_taken`, re-fetches its wraps and stops if it now holds one; otherwise it
  retries at `e+2`.
- **Coverage check:** the server rejects an epoch bump whose `wraps` do not cover **every**
  current, non-revoked device of **every** non-removed member. This is checkable from
  coordination data alone and it closes the obvious denial-of-service: a member rotating to a key
  wrapped only to themselves.

  > **AMENDED 2026-09-01 — THE COVERAGE CHECK IS A ROW COUNT. Say so, or a client will read it as
  > a statement about keys.** Findings **T5-K1** and **T5-K2**.
  >
  > `server/core/handlers/spaces.js#assertCoverage` asks, for each required recipient, whether a
  > `KeyWrap` row EXISTS for every epoch `1..e`. It reads the epoch numbers and never the bytes:
  >
  > ```js
  > const have = new Set((await tx.getKeyWraps(spaceId, r)).map((w) => w.epoch));
  > ```
  >
  > It cannot do more. Telling a genuine wrap from 156 bytes of noise means opening one, and a
  > relay that can open a wrap is the failure this whole ADR is written against (§0, T3/T4). So
  > **an epoch exists as soon as the rows exist**, whatever is in them, and a member may rotate
  > with genuine wraps for the people she likes and garbage for the person she wants to keep out.
  > The check passes. `GET /spaces/:id/keys` then answers that person `keysPending: false`,
  > because it counts the same rows.
  >
  > **What the check therefore does buy, stated exactly:** it refuses a rotation that leaves a
  > live device UNNAMED (the denial-of-service above), and it refuses a wrap set that covers only
  > the current epoch rather than `1..e` (step 5, A4, story 17.1, risk R11). Both are questions
  > about the SHAPE of the table, which is coordination data by construction.
  >
  > **What it does not buy, and what read it as if it did.** `src/js/sync/keys.js` §4 derived its
  > client-side coverage proof from this check, in as many words — *"coverage is not a hope about
  > other clients — it is a server-enforced invariant, and observing that an epoch EXISTS is
  > observing that it held"*. One junk wrap plus one lost race (`409 epoch_taken`, read as *"their
  > wraps cover the same recipients"*) wrote a durable record saying a joiner held a ring she
  > could not open, and no honest device in the family ever delivered to her again: empty board,
  > no warning, nothing in an error state, for the life of the install. The client's coverage
  > record is now three statements about KEYS — *I delivered to it* (this device's own accepted
  > rotation), *it delivered to me* (`ring.originOf` names the device whose wrap actually opened,
  > and a wrap only opens if that device held the key), *it is me* — and no statement about epoch
  > numbers at all. The residual this leaves on the relay side is §8.5's
  > "member-driven denial of key delivery".

### 4.3 The join / removal asymmetry — state it, do not "fix" it

- A **joining** member is granted **all epochs `1…e+1`**. They must be, or Oma's birthday —
  entered in epoch 1 — would be invisible to them, contradicting 17.1 and A4, the addendum's
  killer feature. This is delivered by the invite blob (§5) carrying every epoch key the space
  held at invite creation, refreshed on rotation (§4.2 step 3).
- A **removed** member is granted nothing further, and their existing wraps are deleted.

Rotation therefore protects against **removal only**. Write that down or someone will "fix" the
asymmetry.

### 4.4 Epoch skipping and parked ops

A member offline across three rotations needs every epoch key spanning ops they have not read.
`GET /api/v1/spaces/:id/keys` returns **every** wrap addressed to this device, all epochs — and
every one of those rows is relay data, so **§4.2 step 6 runs on each of them before it is
unwrapped**. A row whose sender is not admissible for the space is refused, not parked: parking is
for "I cannot resolve this yet", and "you are not one of us" is resolved.
`openOp` looks the epoch up in the `KeyRing`; on a miss it triggers **one** key fetch and retries;
on a second miss it **parks** the op (ADR 001 §7.4) rather than erroring. A key arriving later
unparks it, and because merge is set-based, unparking late is harmless.

---

## 5. The op envelope (LZP-304)

### 5.1 Wire shape — exactly what the server stores

```jsonc
{
  "v":   1,
  "sp":  "fsp_6PcRpKuaml6yt5QfS5v8Aw",   // spaceId — 'fsp_'/'psp_' + 22 b64url, per core/entities.js
  "ep":  3,                              // key epoch
  "dv":  "7QAR2MZ9XKPNC0GV",             // deviceShort of the author
  "oid": "8Kx2Qm7bR0aZ4tV9wLpNcg",       // opId — random, NO time component
  "wit": "kQ7bR0aZ4tV9wLpNcgXk92",       // chain witness (§5.4); '' on the first push
  "iv":  "pQ7bR0aZ4tV9wLpN",             // b64url, 12 bytes
  "ct":  "Xk92…",                        // AES-256-GCM over the PADDED plaintext
  "sig": "MEUCIQ…"                       // ECDSA P-256/SHA-256 over aad ‖ iv ‖ ct
}
```

> **CORRECTED 2026-08-27, E3 integration.** The `sp` above previously read
> `"fsp_9xQ2mR7bL0aZ4tV8wK"` — 18 characters after the prefix, where `core/entities.js`'s
> `SPACE_ID_RE` requires 22, so the ADR's own example did not satisfy the ADR's own regex. It
> was copied into a fixture at least once. `oid`, `dv` and the rest are valid as written; only
> the space id was wrong. The regexes are normative, the examples are illustrations.

```js
// src/js/crypto/envelope.js — DOM-free
const AAD = (h) => TE.encode(JSON.stringify(
  ['lzp/v2/op', h.v, h.sp, h.ep, h.dv, h.oid, h.wit]));   // always non-empty

/** @returns {Promise<Envelope>} */
export async function sealOp(op, keyring, sigPriv, hdr);
/** @returns {Promise<Op>} @throws on bad signature, wrong key, or any §5.2 mismatch */
export async function openOp(env, keyring, authorSigPub);
```

**The HLC stamp is inside the ciphertext and nowhere else.** There is deliberately **no `ts`
column** in the `Op` table and no timestamp in the envelope header. The relay keeps `receivedAt`,
which it cannot avoid knowing; it does **not** learn that an op was *authored* three weeks ago on
a train. This is a metadata reduction below the addendum §3 schema sketch and it is a stated
21.3 improvement, not a deviation.

**Sign the ciphertext, verify before decrypt.** `sig` covers `aad ‖ iv ‖ ct`; sign-then-encrypt is
*not* used. A failed signature never reaches the AES path.

**What each AAD field blocks:**

| field | attack |
|---|---|
| `v` | version confusion / downgrade to a suite we no longer trust |
| `sp` | the relay replays a **personal** op into the **family** space hoping a client decrypts it under the wrong key (or vice versa) |
| `ep` | the relay relabels a stale-epoch op as current, or pins a client to a compromised epoch |
| `oid` | **envelope splicing** — the relay rewrites the outer idempotency key to make one op look like two, or to suppress a delete by colliding its id |
| `dv` | the relay re-attributes an op to another device |
| `wit` | the relay rewrites what a device claimed to have seen (§5.4) |

### 5.2 Identity resolution, and the mandatory checks

> **This section is the resolution of the `deviceShort` contradiction that was blocking WP-6.**
> It was written 2026-08-27 from `judge:conformance` Part C, with two corrections to that
> resolution stated in full below rather than papered over. Nothing here needs a further decision;
> `envelope.js` can be written against it.

#### 5.2.0 One definition, and what it is not

`deviceShort` is defined **once**, in **ADR 001 §1.2**, as
`crock32(SHA-256(rawSigPublicKey)[0..10])` → 16 Crockford base32 characters, 80 bits — a function
of the device's **signing key** and of nothing else. `op.dev` is `'dev_' + 128 random bits` with
**no derivational relationship to that key**, so `deviceShort(op.dev)` **is not a computation that
exists**. Earlier drafts of this section and of ADR 001 §4.0 wrote it as though it were; that was
an error, and this section is the correction.

**§1.2 wins over the lookup reading because four consumers cannot be served by anything else**, and
exactly one consumer needs a lookup:

| consumer | needs | why the alternative fails |
|---|---|---|
| **HTTP request auth** — `LZP1 device=<deviceShort>` (`sync.contract.js:112`), `getDeviceByShort` (`server.contract.js:191`) | key-derived | the server is the verifier and holds **no** attestation registers — they are inside E2EE ciphertext it cannot read. A key-derived short is **self-certifying**: the relay recomputes it at registration and refuses a device claiming a short it cannot derive. A random id would be an unverifiable claim the relay must simply trust, widening §2.3's residual from "fabricate a member row" to "fabricate a device row" |
| **the relay's device principal** — `Op.deviceShort`, `deleteOpsByDevices` for 20.2's purge, `setLastSeenSeq` for ADR 001 §7.3's GC | key-derived | `op.dev` is **inside the ciphertext**; the relay never sees it, and could not attribute, purge or track a device at all |
| **the HLC tiebreak** — the 16-char stamp tail (ADR 001 §1.3) | key-derived | ADR 001 §6.2's proof that `≺` is a strict total order rests on "80-bit hashes of **distinct public keys**", and §8.1's `ZERO_DEVICE_SHORT` minimum depends on the Crockford alphabet. Neither statement is true of a random id |
| **`envelope.js`'s key selector** — `env.dv` | key-derived | `openOp` must find `authorSigPub` **before** it can verify anything; a self-certifying handle means a wrong key cannot silently be substituted |
| **ADR 001 §4.0 stage 0b** — "is `op.dev` an attested device of `op.act`?" | **lookup** | `op.dev` appears only inside the plaintext, and the attestation is the only table that maps it |

Note that this section was already **half** consistent with that decision: its fourth line,
`op.act === memberOf(env.dv)`, is a *lookup* keyed by `dv`. Only the third line applied
`deviceShort()` as a function. The contradiction was one line deep.

#### 5.2.1 ⚠ Two corrections to the resolution as it was handed over

Both are stated loudly because getting either wrong makes `envelope.js` unimplementable or unsafe.

1. **`att === null` is NOT a post-decrypt check. It cannot be.** The resolution as filed listed
   "`att !== null`" among the *post-decrypt* checks and said a null attestation parks the op. The
   attestation is the **only** source of `authorSigPub`: with `att === null` there is no key to
   verify the signature with and no reason to reach the AES path at all. Resolving `att` is
   therefore a **pre-decrypt gate**, and what gets parked is a **sealed envelope, unopened** —
   re-opened when the attesting `member.set{dev.*}` arrives. The outbox/inbox must be able to hold
   an envelope it has never decrypted, which is the same shape ADR 002 §4's unknown-epoch park
   already requires.
2. **`attestationOf` is keyed by `deviceShort` ALONE, and that is only sound because of an
   invariant that must be enforced at fold time.** The resolution wrote the signature as
   `attestationOf(env.dv)` while *describing* it as "the register `member:<op.act> → dev.<env.dv>`"
   — a two-key description of a one-key function, and `op.act` is **not knowable before decrypt**,
   so a two-key lookup could not run where it is needed. The one-key form is correct **provided**
   §2.3's four acceptance conditions hold, which make `deviceShort → DeviceAttestation` a function
   across the space. Binding back to the decrypted body is then check **5** below
   (`att.memberId === op.act`), not a second lookup. **If a future change relaxes §2.3 condition (3)
   or (4), this section breaks and must be revisited.**

   > **AMENDED 2026-08-27 (I-3), and again 2026-08-28.** "the four conditions make it a function"
   > is an argument, not an enforcement. What ENFORCES it is §2.3's "One short, one signer": the
   > register must have been written by the device it attests, which only the holder of that
   > device's signing key can do — and which is sound **because of this very section**, since P2,
   > P3 and check 4 below are what make a stamp ending in `S` a signature by `S`'s key. **§5.2.2
   > is therefore load-bearing for the fold and not only for this envelope: check 4 may not be
   > weakened, made optional, or moved after the decrypt.** The lookup remains a *partial*
   > function and P1's park still covers the hole: `att === null` means absent, unproven, or
   > proved twice, and **all of them are parks, never rejections**.

#### 5.2.2 The gate, in order

Let

```
att = attestationOf(env.dv)     // the DeviceAttestation whose deviceShort is env.dv, decoded from
                                // the folded dev.* registers and signature-verified under its
                                // housing member's RK_sig (ADR 001 §4.0 stage 0a, §2.3 above)
```

**Pre-decrypt** — in this order, no exceptions:

```
P1  att !== null                              // else PARK THE ENVELOPE, unopened (ADR 001 §7.4)
P2  deviceShortOf(att.sigPubRaw) === env.dv   // the short is self-certifying (ADR 001 §1.2)
P3  verify(sig, aad ‖ iv ‖ ct, att.sigPubRaw) // VERIFY BEFORE DECRYPT — hard failure
P4  keyring has epoch env.ep                  // else PARK (§4) — a failed key never reaches AES
```

**Post-decrypt** — `openOp` **must** verify all five and **throw** on any mismatch:

```
1  op.id        === env.oid
2  op.space     === env.sp
3  att.deviceId === op.dev                    // ← replaces "deviceShort(op.dev) === env.dv"
4  devOf(op.ts) === env.dv                    // the HLC tiebreak is this device's own short
5  att.memberId === op.act                    // replaces "op.act === memberOf(env.dv)"
```

**What each check buys.**

- **3** is the one this section used to get wrong. `env.dv` is the *outer* device handle the relay
  sees and routes on; `op.dev` is the *inner* one the plaintext carries. Without 3 a valid signer
  could seal an authenticated header over a body naming a different device — the same class of
  splice the `oid` binding blocks for op identity.
- **4 is new and it is not optional.** The stamp's last 16 characters are the LWW final tiebreak,
  and ADR 001 §6.2's claim that `≺` is a *strict total order* rests on "two writes from different
  devices differ in `deviceShort`". A device that stamped its ops with a peer's short would break
  that premise. Convergence itself survives — the register join falls through to `opId` and then to
  the canonical value (`src/js/core/registers.js cmpWrites`) — but merge outcomes would silently
  stop being **attributable**, and the honest fix is one string comparison here rather than an
  argument later. It also closes the only T5 gap the lookup reading otherwise leaves open: forging
  a peer's short inside one's own stamps.
- **5, with P2** is attribution. 17.6 renders `op.act` directly as „von Mama";
  **attribution is a trust surface, treat it as one.** P2 is what makes `dv` self-certifying and is
  the same computation the relay performs at device registration — which is why the relay needs no
  attestation registers to bind a `deviceShort` to a public key (§2.3, ADR 003 §2).

#### 5.2.3 Where the table comes from

`att` is supplied by ADR 001 §4.0's stage-0a fold, which must therefore expose the attestation
**payload**, not merely a verification boolean:

```js
/** @property {(dv: DeviceShort) => DeviceAttestation|null} attestationOf */
```

on `AuthzResult`, replacing the `Set<DeviceShort> attestedDevices` and
`(devId) => MemberId|null memberOfDevice` entries in `ops.contract.js` §4 and matching `openOp`'s
fourth parameter in `crypto.contract.js` §4. The injected verifier `foldAuthorized` takes changes
from `attestVerify(memberId, blob) => boolean` to
**`attestOpen(memberId, blob) => DeviceAttestation|null`**. `openOp` is otherwise given no way to
perform P1–P3 or checks 3–5.

`src/js/core/authz.js` already decodes exactly this object (`parseAttestationBlob`, `:181`) and
already walks the folded registers to build the table (`:650-663`); the payload is **discarded** at
`:661`, where only `deviceId → memberId` is kept. **That is a ~10-line change in `authz.js` plus
two contract lines, and it is the concrete unblocker for WP-6** (LZP-304). It is finding **F-10** in
`docs/v2/FINDINGS.md`.

#### 5.2.4 The chain this buys, and what it costs each adversary

```
op.f  ──(AES-256-GCM under FSK_e, AAD binds v‖sp‖ep‖dv‖oid‖wit)──►  ct
ct    ──(ECDSA over aad‖iv‖ct, key = att.sigPubRaw named by dv)──►  sig
dv    ──(self-certifying: crock32(SHA-256(sigPubRaw)[0..10]))────►  sigPubRaw
sigPubRaw ──(inside DeviceAttestation, signed by RK_sig)─────────►  {memberId, deviceId, deviceShort}
att   ──(register member:<M> → dev.<dv>, write-once, §2.3 (1)-(4))►  M attested it
op.dev === att.deviceId  ∧  op.act === att.memberId === M
```

- **T1 (relay).** `dv` is in the AAD, so re-attributing an op to another device breaks the GCM tag
  *and* the signature. The relay cannot fabricate a `dev.*` register — it is authored under
  `RK_sig` inside the E2EE stream (§2.3). Check 3 additionally stops the relay pairing an
  authenticated header with an unrelated body's `dev`. **Strictly stronger than the old text.**
- **T4 (MITM at pairing).** Unchanged — the SAS is the defence, and the new device self-attests
  with the restored `RK_sig` (§6.3 step 8), which is what mints the `dev.<short>` register.
- **T5 (member as adversary, admin included).** A member can add devices **only to their own
  record** (ADR 001 §4.0, enforced as admissibility at `authz.js:612` and write-once at
  `:626-644`). Forging another member's short inside one's own stamps is closed by check 4.
  Filing another member's **`deviceId`** inside one's own attestation is not closed by any check
  and cannot be — see §2.3 "A `deviceId` is a label, not an identity". It is instead made
  worthless: the fold publishes no `deviceId → memberId` resolver, so the copied label admits
  exactly the ops an invented label would, and the contest is reported on `deviceIdCollisions`.
  Filing another member's **`deviceShort`** — which the four conditions also fail to close, and
  which P2 does **not** close either — is made worthless the same way and by the same reasoning:
  the register is admitted, reported on `unprovenShorts`, and never becomes a credential, because
  she cannot author the op that would prove it (§2.3 "One short, one signer"; the proof rests on
  check 4 above, which is why that check is not optional). *(extended 2026-08-28, I-3 closed.)*
- **T2 / T3 (removed member, stolen laptop).** The attestation is **not revocable** — §2.3
  "Revocation — the gap, and who owns it". Only the epoch bump limits the damage, and it limits
  future *reads*, not authorship. WP-9.

#### 5.2.5 Bootstrapping, and the one thing that is NOT a rejection

An envelope may legitimately arrive before the attestation that would resolve it: there is **no
causal delivery** in this system (ADR 001 §2), so a member's first content op overtaking their
`member.set{dev.*}` op is ordinary, not hostile. `att === null` therefore **parks the sealed
envelope** (P1) and never rejects it — a rejection is final, and a final rejection here is silent
data loss on first contact and on every partial pull. This is finding **F-6**, and today the shipping
fold does the wrong thing: `authz.js:671` **rejects** `unattestedDevice`, and `store.js:699-703`
drops the rejected op without appending it to the log, so it is never re-evaluated. A park reason
(`ATTESTATION`) must exist in `ops.js`'s `PARK_REASONS` before WP-8 pulls from a real peer.

**`att === null` has more than one cause, and every one of them is a park.** The fold returns
`null` for an **absent** short, for one whose only claims are **unproven** (§2.3 "One short, one
signer"), and for one **proved on two member records**. `openOp` must not distinguish them: all
mean *this envelope cannot be resolved to a device right now*, all are re-evaluable — the absent
one when the attestation arrives, the unproven one when the real device files its own register —
and turning any of them into a rejection is the same silent data loss. A caller that wants to
*report* the difference reads `AuthzResult.unprovenShorts` and `AuthzResult.shortCollisions`.

> **2026-08-28.** The sentence struck here said the contested case resolves itself "when
> `attestOpen`'s P2 refuses the squat". P2 does not refuse the squat and never could — see §2.3.
> The pre-collision window it hid is the case that used to *resolve*, decrypt and then throw at
> check 5, which is a rejection and therefore the silent data loss this paragraph exists to
> forbid. It parks now.

Checks P2, P3, 1, 2, 3, 4 and 5 remain **hard failures**: those are protocol violations, not version
or delivery skew.

`openOp` also rejects a field whose *value* fails its declared type check in `FIELDS`
(a protocol violation → drop and log locally), while an unknown *kind* or an unknown *field name*
is **parked** (ADR 001 §7.4).

>  **Amended 2026-08-27.** Corrected by `judge:conformance` Part C, resolving the contradiction
>  recorded in `docs/v2/contracts/ops.contract.js:279-290` and STATUS §6. The implementation
>  (`src/js/core/ids.js:138`, `src/js/core/authz.js:159-173, 591-663`) already follows the lookup
>  reading; only the documents were wrong. §5.2.1's two corrections are **this pass's**, not the
>  reviewer's, and they change the shape of `openOp`: the attestation gate moved *ahead* of the
>  decrypt, and the lookup is single-keyed with an invariant (§2.3) carrying the weight.

### 5.3 Padding — the measure that makes Belegt honest

Before encryption the plaintext is

```
varint(len) ‖ utf8(canonicalJSON(op)) ‖ zeros      padded to the next multiple of 256 bytes
```

Without it, a Belegt op (no `pub.text`) is visibly shorter on the wire and in the `ct` column than
a Geteilt op, and **T1 can distinguish "she shared the details" from "she only marked herself
busy"** — an inference story 16.7 explicitly promises not to enable. With it, ops of 1–256
plaintext bytes (the overwhelming majority) are indistinguishable in length. 21.3 already admits
"encrypted blob sizes" are observable; padding narrows what that observation is worth.

Cost: ~1.4× storage at the observed 284-byte typical envelope. Accepted.

### 5.4 The chain witness — censorship *detection*, honestly scoped

A relay can silently withhold specific ops from specific devices, and nothing else in this design
would notice. `Op.chainHash = SHA-256(prevChainHash ‖ opId)` is computed by the server per space;
on push, a client sets `Envelope.wit` to the highest `chainHash` it had pulled — so **every op a
member authors commits to what that member had seen**. Peers cross-check `wit` against their own
chain and log a diagnostic on a fork.

**Scope, stated so it is not oversold:** this is **detection-only, best-effort, and it never
blocks sync in v2** (a false positive that broke a family's board would be far worse than the
attack). The diagnostic surfaces in the LZP-1003 self-audit and in the sync `error` detail pane.
A relay that rewrites the chain consistently per-device still wins. A full transparency log is
deliberately deferred — §8.6.

---

## 6. Device pairing (LZP-306 · story 19.5)

### 6.1 Threat model

The relay is untrusted and assumed to be an **active MITM (T4)**: it may read, modify, drop,
replay and reorder everything, and may run the protocol with both sides. The pairing code travels
out of band — shown on screen A, typed into screen B by the same human in the same room. Physical
access to an unlocked Mac and shoulder-surfing of the pairing screen are out of scope.

### 6.2 Parameters

| | value | rationale |
|---|---|---|
| pairing code | **12 Crockford base32 chars = 60 bits**, displayed `XXXX-XXXX-XXXX` | typed once, in one room, by the owner of both machines. Crockford already excludes I/L/O/U. |
| what the relay learns of the code | **nothing**: `rid = b64u(HKDF(code, '', 'lzp/v2/pair/rid', 16))` is derived from the **whole** code | an offline attack on `rid` costs the full 2⁶⁰, not 2⁴⁰ |
| TTL | **180 s**, single use | an online guessing budget is meaningless |
| attempts | **5 failed decrypts per `rid`, then the rendezvous is burned**; 20 `pair/get` per IP per hour | |
| SAS | **6 decimal digits**, shown on **both** devices, confirmed on **both** | **the actual MITM defence** |

### 6.3 The protocol

```
Device A (existing, holds PSK)         relay (untrusted)            Device B (new)
──────────────────────────────────────────────────────────────────────────────────
1. C = 60 random bits, shown as XXXX-XXXX-XXXX  ── typed by the human ──────────►
   rid = b64u(HKDF(C,'','lzp/v2/pair/rid',16))
   ck  = HKDF(C,'','lzp/v2/pair/ck',32) → AES-256-GCM
   ephemeral ECDH pair (a, A_eph)
2. POST /api/v1/pair/offer { rid,
     box_A = AESGCM(ck, {A_eph, A_sigPub, A_devId, memberId}) }
                                       ◄── GET /api/v1/pair/:rid ──── 3. B derives rid, ck
                                                                         opens box_A
                                                                         (fail ⇒ wrong code,
                                                                          burn one attempt)
                                                                      4. ephemeral (b, B_eph)
                                       ◄── POST /api/v1/pair/answer ──
                                            { rid, box_B = AESGCM(ck,
                                              {B_eph, B_sigPub, B_kexPub, B_devId}) }
5. A polls, opens box_B
6. both:  S   = ECDH(own_eph_priv, peer_eph_pub)
          SAS = decimal6(HKDF(S ‖ A_eph ‖ B_eph, '', 'lzp/v2/pair/sas', 4))
   ┌────────────────────────────────────────────────────────────────────────┐
   │  BOTH SCREENS SHOW THE SAME 6 DIGITS · BOTH USERS MUST CONFIRM         │
   │  „Stimmen die Zahlen auf beiden Bildschirmen überein?"                 │
   └────────────────────────────────────────────────────────────────────────┘
7. A: kek = HKDF(S,'','lzp/v2/pair/kek',32)
      POST /api/v1/pair/deliver { rid, AESGCM(kek, {
          PSK epochs 1..e, memberId, RK_sig/RK_kex PKCS#8,
          familySpaceId + FSK epochs 1..e (if any) }) }
8. B unwraps, mints its own **non-extractable** IK_sig/IK_kex, self-attests with the
   restored RK_sig, registers the device, and pulls from seq 0.
9. A rotates PSK → e+1 and wraps to every own device. The relay burns rid.
```

### 6.4 Honest security analysis — the numbers, not the vibe

- **Passive relay.** Learns `rid` (opaque), two ephemeral public keys, and nothing else. `ck` and
  `S` are both out of reach. Safe.
- **Online guessing.** An attacker who never saw the code must guess a 60-bit value to compute a
  valid `rid`, against a 5-attempt, 180-second window. Effectively impossible.
- **Active MITM — the real threat.** A MITM substitutes its own ephemeral key toward each side.
  It can then attempt an **offline** attack on `C` from `box_A`: 2⁶⁰ HKDF+AES-GCM trials. At a
  well-resourced ~10¹¹ trials/s that is on the order of **months**, against a 180-second window —
  but the honest framing is that **the code is not the security parameter. The SAS is.**

  With a MITM in the middle A and B derive different `S`, therefore different six-digit SAS
  values, and the human comparing two screens on one desk sees it. MITM success collapses to
  10⁻⁶ per attempt **with no offline path** — the attacker must commit to a guess before the
  human looks.
- **Why not a 128-bit code and no SAS?** Because a long code transported over any channel the
  attacker can see is *also* MITM-able, and 26 typed characters is exactly the friction 19.5
  refuses. Short code + SAS is strictly better on both axes. Same trade as ZRTP, Signal safety
  numbers and Matrix, for the same reason.
- **Why no PAKE?** WebCrypto exposes none, and implementing SPAKE2 on raw P-256 arithmetic in JS
  would ship the weakest crypto in the product to its most exposed moment.

> **19.5's "both-ends confirmation" is load-bearing, not decorative.** A downstream agent who
> "simplifies" pairing by auto-confirming when the boxes decrypt has removed the only MITM
> defence in the product. The SAS screen is **not skippable** and **not defaulted to „Ja"**, and
> `tests/fleet/pairing-mitm.test.js` drives the protocol through `tests/helpers/mitm.js` — an
> active-attacker transport that substitutes ephemeral keys — and **asserts SAS divergence and a
> refused pairing**.

---

## 7. Invites, backup and recovery

### 7.1 Invite codes (15.3, 15.5) — **amended by PO decision D9 (2026-08-25)**

> **This section was rewritten.** The original design shipped the family keys *inside* the invite
> blob so a joiner never had to wait. The PO chose the tighter option: **a leaked invite email is
> never sufficient to read family content.** The 7-day read window described in the superseded text
> does not exist in this product. The cost is a waiting state, specified below and in
> `DESIGN-DECISIONS.md` § D9.

Invites travel by email, so they get operational controls rather than a SAS. They authorize
**membership**, and nothing else. They carry **no key material of any kind**.

| | value |
|---|---|
| code | **12 Crockford chars = 60 bits**, `XXXX-XXXX-XXXX` |
| `inviteId` | `b64u(HKDF(code,'', 'lzp/v2/invite/id', 16))` — the raw code never reaches the server |
| `verifier` | `SHA-256(HKDF(code,'', 'lzp/v2/invite/verify', 32))`, stored; redemption presents the HKDF output |
| ~~`wrappedKeys`~~ | **removed — D9.** No epoch key, wrapped or otherwise, is ever attached to an invite, stored on the server against an invite, or derived from an invite code. |
| TTL | 7 days (15.5) |
| single use | atomic: `UPDATE "Invite" SET usedAt = now() WHERE id = $1 AND usedAt IS NULL RETURNING *` |
| revocable | by the admin at any time (15.5) |
| rate limit | 10 redemptions per IP per hour |

**What redemption actually does.** Redeeming proves knowledge of the code and publishes the
joiner's *public* device key. It never yields readable content:

1. The joiner presents the verifier and posts `member.join` carrying their **device public keys**
   and a self-signed attestation. The server marks the invite used, atomically and once.
2. The joiner is **immediately a member**: `member.profile.set` (display name, colour) enters the
   family op stream, and every member's list (15.4) shows them. From the product's point of view
   the join has *succeeded* at this point.
3. The joiner holds **no epoch key yet**, so the family ops they can already pull are ciphertext
   they cannot open. They are parked (ADR 001 §7, risk R11) — never dropped.
4. **Any existing member device** — not only the admin's — wraps the current key ring to the new
   device on its next ordinary sync, and pushes the wrap. This is deliberate: gating on the admin
   alone would make a 2-person family depend on one sleeping laptop. Admission was already
   authorized by the invite the admin issued and can revoke; delivery is not a second gate.
5. The wrap covers **all epochs `1..e`**, so the joiner sees the shared history — Oma's birthday
   entered three years ago must render (A4, 17.1, risk R11). A wrap that covers only the current
   epoch is a bug, and the server enforces wrap coverage.
6. On arrival the joiner unwraps, the parked ops re-evaluate, and the board fills in.

**The waiting state is a designed screen, not an error** (deliverables 15 and 25). Between steps 2
and 6 Mom is a full member looking at a board with no family entries on it. The UI must:

- say she is **in** the circle, in one calm German-first line, and that the entries appear by
  themselves when another member's Mac next syncs;
- never render as an error, a failure, or a retry prompt;
- never instruct her to go and ask someone to open their laptop — it resolves on its own;
- keep 19.3's rule: no spinner on the board. This is the `pending` sync state, not `error`.

**Why this is the right trade despite 15.3.** Story 15.3's promise — a non-technical member is in
"within a minute" — is kept for *membership*, which is what she does at the keyboard. What now
depends on someone else's Mac being awake is *content arrival*. The alternative bought a
one-step join by accepting that anyone reading the invitation email within 7 days could join and
read everything ever shared. For a product whose central promise is that no one sees what you did
not choose to share, that was the wrong side of the trade.

**Residual risk after D9.** An attacker who reads the invite email within 7 days can still consume
the invite and **become a member of the circle** — appearing in the member list under a name they
chose, and receiving future shared content once a member device wraps to them. What they cannot do
is read anything from the email alone. The out-of-band control is unchanged and now load-bearing:
every member sees the new name appear (15.4), and removal rotates the epoch (20.2, §4.2), which
cuts off everything after it. The Datenschutz text (21.3, LZP-1001) says this in plain German.

### 7.2 Backup v2 (LZP-305 · A2) — the recovery artifact

```jsonc
{
  "_README_de": "DIES IST DEIN SCHLÜSSEL. Wer diese Datei und dein Passwort hat, ist du. Ohne diese Datei und ohne deine Macs sind die Daten unwiederbringlich — niemand sonst hat die Schlüssel.",
  "_README_en": "THIS FILE IS YOUR KEY. …",
  "format": "langzeitplaner-backup", "v": 2,
  "exportedAt": "2026-08-25", "app": "2.0.0",

  "board": { "schemaVersion": 2, "notes": [], "bars": [], "categories": [],
             "scratchpads": {}, "settings": {}, "_v2": { } },

  "identity": {                                   // OMITTED ENTIRELY if no passphrase was given
    "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "b64u32" },
    "memberId": "mem_7f2c…",
    "sealed": "b64u"                              // AES-256-GCM over canonicalJSON({
                                                  //   recSigPkcs8, recKexPkcs8,
                                                  //   personal: {id, epochs:{…}},
                                                  //   family:   {id, epoch, epochs:{…}} })
  }
}
```

**Decisions, and the reason for each:**

- **`identity` is encrypted or absent. It is never written in plaintext.** Two of the three
  reviewed designs shipped raw PKCS#8 recovery keys in a file the onboarding actively tells the
  user to email to themselves; anyone who read that mailbox became them, permanently and
  undetectably. This design refuses that outcome, at the cost of one field in the export sheet.
- **The export sheet offers two buttons, and neither is silent.** *„Backup mit Passwort sichern"*
  (primary, includes `identity`) and *„Nur Einträge sichern"* (no passphrase, no `identity`).
  The sheet states, in one line each: with a password the backup restores your board **and** your
  family membership; without one it restores your board only, and a lost Mac means a new pairing.
  A2's own wording is conditional — *"re-joins my Familienkreis **if the keys are present**"* — so
  the second path is spec-compliant, not a degradation.
- **This is not an account password.** "No passwords" (addendum §3) forbids a *registration and
  login* system. It does not forbid encrypting a key file the user chooses to carry. Say so in
  the onboarding honesty moment (deliverable 24).
- **Contains only my data** (A2). `board.notes` / `board.bars` are filtered to entries I own;
  other members' entries are excluded and re-arrive via sync. No other member's keys, ever.
- **`wrapKey('pkcs8', …, {name:'AES-GCM', iv})`** — never AES-KW (§1 rule 6).
- Import still clears undo/redo and goes through the §8.5 diff transaction of ADR 001 (5.4).

**AMENDED 2026-08-28 — findings S3, S7 and S8. Nothing in the shape above changes; the AAD, the
passphrase field and the import RESULT do.**

- **S3 — the `board` block is inside the AAD on the identity path.** The AAD is
  `canonicalJSON` of the plaintext header **plus `board: {digest, hash}`**, where `digest` is
  `b64u(SHA-256(boardDigestInput(file.board)))`, recomputed on both sides. **It is not a field of
  the file**: there is nothing to strip, nothing to downgrade and no wire format to version, and
  the `identity` shape above is untouched. Rewrite one character of one note and the tag fails;
  the import reports `cannot-open`, the same honest code a wrong passphrase gets, because from
  outside the module the two are the same event.

  This ANSWERS finding **E3-6**, which was filed as a PO question, and it answers rather than
  overrules its argument. E3-6 said board authentication "would exist on only one of the two
  export paths, and a guarantee that holds on one path is worse than one stated plainly." That is
  true of the **board-only** file — which has no key and therefore cannot have the guarantee —
  and says nothing about the file that says *„DIES IST DEIN SCHLÜSSEL"* across the top and was
  half unsigned. Two paths with **two stated guarantees** is the shape the argument permits;
  `LIMITS.board.withIdentity` and `LIMITS.board.boardOnly` are those two sentences, in German and
  English, and `README.boardOnly` already tells the user which file she is holding.

  E3-6's second objection is paid rather than argued away: `boardDigestInput` deliberately does
  **not** use `canonicalJSON`, which refuses floats — losing a user's whole export because
  `settings` picked up a `0.5` would be the worse failure. It is a total function over everything
  `JSON.stringify` can write, and it sorts object keys, so a file re-serialized by a different
  writer still opens. Both halves are pinned in tier 1 and in WebKit.

- **S7 — the passphrase has a named floor.** `PASSPHRASE_FLOOR` (12 code points, 5 distinct) and
  a pure `passphraseStrength()` are exported; a passphrase below the floor is **accepted and
  reported**, never silently accepted. The floor is soft on purpose — see DESIGN-DECISIONS D8's
  2026-08-28 extension for the argument and for the one-line change that makes it hard.

- **S8 — a ring that does not cover `1..e` is reported.** `importBackup` returns
  `spaces.<which>.missingEpochs` **only when the ring has holes**, and switches the consequence
  to `identity-restored-keys-pending`. The wrapping side already refused a partial ring loudly
  (§4.2); the restoring side accepted one in silence, so the two sides disagreed about §4.3's own
  rule. Reported rather than refused: a restore that recovers everything from epoch 4 on is worth
  having on a Mac whose owner may have nothing else left, and §7.3 step 6 already says what
  happens to the rest.

- **What is still NOT checkable here, now SAID rather than omitted.** `importBackup` returns
  `familyBinding = {spaceId, verified:false, say}` on every family restore. Whether the Kreis the
  file names is this member's is not in the file — the enumerated domain proves it, because the
  „my Kreis" and „another Kreis" inputs are literally the same bytes — so the statement is
  unconditional and the check itself belongs to §7.3 step 5's `POST /devices/adopt`.

### 7.3 Re-join on import (A2, LZP-1004)

1. `importBoard` detects an `identity` block and prompts for the passphrase.
2. Unwrap → `RK_sig`, `RK_kex`, space ids, all epoch keys.
3. **Mint fresh non-extractable device keys for this machine.** Never restore a device identity —
   a device is a machine, not a person.
4. Self-attest with the restored `RK_sig` (§2.3).
5. `POST /api/v1/devices/adopt`, signed by `RK_sig`. The server holds
   `Member.recoveryPubSig` (a public key) and verifies, then attaches the device to the existing
   member. **No admin involvement, no new invite** — this is the only path that survives losing
   every device.
   **This step now carries a named obligation (2026-08-28, C2c-2).** It is the ONLY thing in the
   system that can contradict a backup file about which Kreis it enrols a Mac in: `family.id` is
   a payload field, and `importBackup` is I/O-free and cannot check it — the enumerated domain
   shows the honest and the hostile file are the same bytes at that seam. The client says so
   (`result.familyBinding.say`); the server is where it is decided.
6. The restored epoch keys decrypt everything already on the server. If the family epoch has
   advanced past what the backup holds, the client requests a wrap and the rotation coverage
   check (§4.2) means the next rotation includes it; until then, newer ops are **parked**, not
   lost, and the sync status shows „Schlüssel ausstehend".
   **AMENDED 2026-08-28 (S8): the same is now true of a ring with a hole BELOW the top, and the
   client is told which.** `result.spaces.<which>.missingEpochs` carries the numbers, present only
   when there are any, and `result.consequence` becomes `identity-restored-keys-pending`. Before
   this, a sparse ring restored in total silence and the Mac simply could not read epochs 1-3.
7. Personal space rotates to `e+1` and the recovered device joins as a normal own-device.

### 7.4 Copy contract — what the UI may and may not claim

The crypto cannot make the following true, so the UI must not imply them. Required strings
(deliverables 18, 19, 22, 24; audited by LZP-1003, which reviews **strings**, not only code):

- Member removal / leave confirmation:
  > „Ab jetzt sieht **Mama** nichts Neues mehr. Was ihr Mac schon geladen hat, bleibt auf ihrem
  > Mac — geteilt ist geteilt."
- First visibility downgrade:
  > „Ab dem nächsten Abgleich verschwindet der Eintrag von den anderen Boards. Was schon sichtbar
  > war, wurde schon gesehen."
- Belegt tooltip on the owner's own board:
  > „Andere sehen: Datum, deinen Namen, deine Farbe — keinen Text."
- **Never**: „gelöscht bei allen" · „zurückgezogen" · „niemand kann es mehr sehen" · „live".

---

## 8. What an adversary CAN still do — the honest limits

Ranked by how much they should worry the PO. This section is the source text for 21.3
(LZP-1001) and for the confirmations in deliverable 22.

**8.1 A removed member keeps everything they already held. Forever.** All epoch keys up to their
removal, and all ciphertext they had already pulled, on their own machine. Rotation buys **future**
confidentiality only. Worst realistic case: an acrimonious separation where the removed member
kept a full local replica. `20.2`'s "deletes their shared entries from all family boards" is
implemented as a *projection* rule plus a server-side purge of their `Op` rows — both of which an
honest client honours and a modified client does not.

**8.2 A stolen, unlocked laptop is a total compromise of that user.** Non-extractable keys prevent
*exfiltration* of key material, not *use* of it. There is no PIN and no re-auth — all of which
would contradict "no passwords". The honest defences are FileVault (outside our control) and,
after the fact, device revocation plus an epoch bump, which protects the family space going
forward and does nothing for what is already on that disk.

**8.2a There is no device revocation in the authorization fold, and an attestation cannot be
withdrawn.** *(added 2026-08-27 — round-4 row R4-16a; see §2.3 "Revocation — the gap, and who
owns it".)* `dev.*` registers are write-once, so a `member.set{dev.<short>: null}` loses to the
original claim and a replacement blob is rejected `writeOnce`. The attestation of a stolen laptop
(8.2) or an ex-partner's Mac (8.1) therefore stays valid **forever**, and ADR 001 §4.0 stage 0b
keeps admitting ops from it. What the epoch bump buys is key *distribution* — the revoked device
stops receiving new space keys — not admissibility: it can still author ops every honest client
folds. This is a real gap, not a documented trade, and it is **owned by WP-9** together with ADR
003 §2. The design constraint is stated in §2.3: revocation must be a *fold* input, or two devices
will disagree about whether an op is admissible.

**8.3 Retraction is client-cooperative.** ADR 004 §5's guarantee holds for honest clients. A
member running a modified build simply keeps their fold. Screenshots, Time Machine backups and
the peer's own `snapshots.json` are entirely outside our reach. This is unavoidable in any E2EE
system; the design's contribution is refusing to pretend otherwise in the UI (§7.4).

**8.4 An invite is an admission ticket, not a key** *(amended — PO decision D9)*. Whoever reads
the email within the 7-day window can consume the invite and **become a member**: they appear in
the member list under a name they choose, and they receive shared content once some member device
wraps the key ring to them. What they cannot do is read anything from the email alone — no epoch
key is attached to, stored against, or derivable from an invite. The controls are the member list
(15.4), which surfaces the intruder to every member, and removal (20.2), which rotates the epoch
and cuts off everything after it. What removal cannot undo is what they already pulled and
decrypted: addendum §6 again — unsharing is not unremembering.

**8.5 There is no key transparency.** Members cannot verify that a rotator wrapped `FSK_e` only to
genuine member devices. Device attestation (§2.3) stops a *relay* from forging a device for an
existing member, but a malicious relay could still fabricate a whole **member** row, and a
malicious admin could add a phantom *member* and read the family space. Partial mitigation: the
member list shows per-member device counts, so an extra device is visible to a curious member.
A signed, append-only, cross-verified device log is the real fix and is deferred to the backlog.

> **The mitigation is now half-built, and the half that is missing is one field.**
> *(2026-09-01.)* Until this pass the sentence above described nothing that existed: `MemberRow`
> in `src/js/family/membersui.js` had no device field and the count reached no screen, which the
> T5 red team drove — a member attests an outsider's Mac, every barrier passes because every fact
> about the row is true, and the family's next ordinary sync wraps epochs `1..e+1` to it. The row
> and its tag exist now (and read only the LENGTH of the relay's array, so a relay answering
> `devices: 9999` cannot write a nine-thousand into a family's member list). But
> `family/mount.js#refreshRoster` maps the roster down to `memberId`, `colorRef`, `removedAt`, so
> `deviceCount` is `null` on every launch and renders as nothing — correctly, because *unknown*
> and *zero* are different facts. **Owner: `src/js/family/mount.js`.** Driven, both halves, in
> `tests/fleet/e6-attack-keydelivery.test.js` §5d.

**8.5a A member can DENY a peer the key, and the relay cannot tell.** *(added 2026-09-01 —
findings **T5-K1** / **T5-K2**; the mirror image of 8.5, and until now this section had only the
over-wide half.)* 8.5 says a rotator cannot be held to wrapping only to **genuine** devices. The
same absence runs the other way: a rotator cannot be held to wrapping a **usable key** to every
device it names. §4.2's coverage check counts rows (see the amendment there), so a member may
rotate with real wraps for her friends and 156 bytes of noise for the person she wants to keep
out, get a `200`, and leave that person unable to read anything sealed from that epoch onward.
Nothing about it is detectable by the relay, and until this pass nothing about it was detectable
by the other members either.

- **What is closed.** The denial is no longer permanent and no longer silent. An honest device's
  duty to a recipient is now discharged only by *delivering* to it or by *being delivered to by
  it*, never by an epoch bump or a lost race, so the first honest tick after the hostile rotation
  hands the excluded member the whole ring. And the excluded member's own Mac stops claiming
  otherwise: D9's „Schlüssel ausstehend" is answered from `ring.covers(1..e)` and not from the
  relay's row count, so a partial ring keeps the waiting state and a partial arrival never
  withdraws it (that half is **T5-K2**).
- **What remains.** A member who rotates on every membership change with junk for one peer holds
  that peer at a stale epoch: no device can prove that an epoch minted by somebody ELSE reached a
  third party in openable form, and no route can say so without telling the relay the same thing.
  The victim sees it — parked ops, `keysPending` true, and the deferral ladder ending in a visible
  error — and every other Mac sees a healthy circle. **Owner:** a route by which a member can
  report "I cannot open epoch e", which is ADR 003's and `server/core/handlers/keys.js`'s, not
  this section's.
- **One interaction, because it is not obvious — and it is now RESOLVED.** T5-K3's first fix made
  `KeyWrap` write-once per `(spaceId, epoch, recipientId)`, so the FIRST depositor of a cell owned
  it. Against a *joiner* — whose cells for `1..e` are all empty when she arrives — a hostile
  rotator who got there first therefore kept those cells, and an honest member's later wraps for
  them were refused **by the store**. Measured end to end in
  `tests/fleet/e6-attack-keydelivery.test.js` §1: she held one epoch, no history, „Omas
  Geburtstag" never rendered, and her ops quarantined into a visible error.

  The cell therefore includes the **depositor** — `(spaceId, epoch, recipientId, senderDeviceId)`
  — and both rules hold at once. An attacker still cannot move one byte anybody else deposited (a
  different depositor is a different row, so T5-K3 is closed *by construction* rather than by
  refusal), and an honest wrap **coexists** with a hostile one, which is a case the receiving side
  already handles: §4.2 step 6 walks the rows, counts the one that will not open as `refused`, and
  admits the one that does. `assertCoverage` folds a recipient's rows into a Set of epoch numbers
  before it counts, so duplicates cannot inflate coverage. §7.3's A2 recovery is what this buys:
  the founder restored onto an empty ring recovers his whole key history from the relay even after
  a hostile rotation over every one of his cells.

  **What it costs:** rows, not data. One row per depositing device per `(epoch, recipient)`,
  bounded by `MAX_WRAPS = 1024` per rotation and by the epoch race every rotation must win, under
  a signed device identity and a rate-limit budget.

  **And one thing it un-builds.** `wrapsRefused` on a rotation response can now only ever be a
  device re-wrapping **its own** earlier cells with a fresh salt and IV — which every rotation
  after the first does, for every epoch below its own. It is ordinary accounting and **never an
  abuse signal**; a warning built on it would fire for ever on an honest relay, and one was
  removed from `sync/keys.js` for exactly that reason.
- **Not the same class as a confidentiality break.** This is denial of service and denial of
  history against one member by another member of her own circle, in a product whose adversary
  table (§0, T5) already includes that person. It is not a path to reading anything: every route
  in this section's neighbourhood was driven by the same attacker in the same pass and produced
  **zero bytes** of a Privat entry.

**8.6 The relay can censor, and detection is best-effort.** §5.4's witness makes selective
withholding *detectable in principle* by cross-checking what members claim to have seen; it is
diagnostic-only in v2 and a consistently-lying relay defeats it. A Merkle transparency log over
`(spaceId, seq)` with client-side continuity verification is ~40 lines and is **the item most
worth reconsidering if the threat model ever hardens.**

**8.7 The relay learns a rich social graph even without content.** Space membership, device counts
per member, when each device is awake, how often each person writes, epoch bumps (⇒ membership
churn), request timing, and every IP address. Padding hides sizes; nothing here hides timing. A
burst of ops on a Sunday evening followed by two weeks of silence is a legible holiday. A mixnet
or cover traffic would be absurd for a family calendar, so this is accepted and disclosed. **It is
the largest gap between "the server can't read your data" and "the server learns nothing about
you", and the Datenschutz copy must not blur it.**

**8.8 Belegt leaks by design — and correlation leaks more.** 16.7 deliberately publishes
existence + owner + duration. Over months a family member can infer patterns from Belegt blocks
alone ("Mama is Belegt every Tuesday evening", "a week away every March"). Belegt is *not*
privacy; it is a smaller disclosure. Pure invisibility is what Privat is for, and the three-state
control must make that legible (deliverable 18).

**8.9 No forward secrecy within an epoch, and no post-compromise security.** A leaked `FSK_e`
decrypts every epoch-`e` op, past and future, until the next membership change. A family that
never changes membership runs one key forever. Per-op ratcheting (Double Ratchet / MLS) is far
out of scope for 2–8 people at zero dependencies; membership-triggered rotation is the coarsest
possible ratchet. A time-based rotation (say monthly) is available later at the cost of one
re-wrap pass per month.

**8.10 We do not control ECDSA nonce generation.** A nonce reuse or bias in CryptoKit/OpenSSL
leaks the signing key. WebCrypto exposes no hedging control. Accepted; identical for every
WebCrypto application.

**8.11 The backup is still a single point of failure.** With a passphrase: lose the passphrase,
lose the identity. Without one: lose every Mac, lose the family membership. This is the Option-B
trade the addendum already states; both halves must be said out loud at export time.

**8.12 The recovery key has no revocation.** If it leaks there is no way to rotate it without
re-pairing every device and re-joining the circle, and no way to detect that it leaked.

---

## 9. Verified call shapes

Every snippet below was executed in **Node v22.23.1** and in a real **WKWebView on macOS 26.3**
over the same `app://localhost` scheme the shipped shell uses, with identical results.

### 9.1 Capability probe (~1 ms; the guard from §1)

```js
export async function probeCrypto() {
  const S = globalThis.crypto?.subtle;
  if (!S) return { ok: false, why: 'no SubtleCrypto (insecure context?)' };
  const has = async (fn) => { try { await fn(); return true; } catch { return false; } };
  return {
    ok: true,
    aesgcm: await has(() => S.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt'])),
    hkdf:   await has(async () => {
      const k = await S.importKey('raw', new Uint8Array(32), 'HKDF', false, ['deriveBits']);
      return S.deriveBits({ name: 'HKDF', hash: 'SHA-256',
        salt: new Uint8Array(0), info: new Uint8Array(0) }, k, 256);
    }),
    pbkdf2: await has(async () => {
      const k = await S.importKey('raw', new Uint8Array(8), 'PBKDF2', false, ['deriveBits']);
      return S.deriveBits({ name: 'PBKDF2', hash: 'SHA-256',
        salt: new Uint8Array(16), iterations: 1000 }, k, 256);
    }),
    ecdsa: await has(() => S.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign','verify'])),
    ecdh:  await has(() => S.generateKey({ name: 'ECDH',  namedCurve: 'P-256' }, false, ['deriveBits'])),
  };
}
```

### 9.2 Keys, wrapping, envelope

```js
const SIG   = { name: 'ECDSA', namedCurve: 'P-256' };   // generateKey / importKey params
const SIGOP = { name: 'ECDSA', hash: 'SHA-256' };       // sign / verify params — DIFFERENT SHAPE
const KEX   = { name: 'ECDH',  namedCurve: 'P-256' };

const identity = await crypto.subtle.generateKey(SIG, false, ['sign', 'verify']);
const kex      = await crypto.subtle.generateKey(KEX, false, ['deriveBits']);

// Wire format for public keys: 'raw' — 65 bytes, uncompressed 0x04‖X‖Y (identical both engines).
const pub = new Uint8Array(await crypto.subtle.exportKey('raw', identity.publicKey));

const peerSig = await crypto.subtle.importKey('raw', pub,    SIG, true, ['verify']);
const peerKex = await crypto.subtle.importKey('raw', kexPub, KEX, true, []);   // MUST be []

async function wrapKek(myKexPriv, theirKexPub, salt, info) {
  const ss  = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirKexPub }, myKexPriv, 256);
  const ikm = await crypto.subtle.importKey('raw', ss, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: TE.encode(info) },
    ikm, { name: 'AES-GCM', length: 256 }, false,
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']);
}
```

Verified export sizes, identical in both engines: `raw` public **65 B**, `spki` **91 B**,
`pkcs8` **138 B**, `jwk.crv === 'P-256'`. A wrapped P-256 private key under AES-GCM is **154 B**.
A typical `note.set` envelope measured **284 B** before padding, **≈380 B** after padding and
base64.

**Verified P-256 point validation** (the standard objection to NIST curves in ECDH — checked, not
assumed):

| input to `importKey('raw', …, ECDH P-256)` | Node 22 | WebKit 26.3 |
|---|---|---|
| off-curve point (valid x, forged y) | `DataError` | `DataError` |
| point at infinity (`0x00`) | `DataError` | `DataError` |
| a P-384 public key offered as P-256 | `DataError` | `DataError` |
| `deriveBits` across mismatched curves | `InvalidAccessError` | `InvalidAccessError` |

Both engines validate the point before scalar multiplication. There is no invalid-curve surface
at the API level.

### 9.3 Reproducing the evidence

The probe harness lives at `tools/crypto-probe/` (promoted from the LZP-301 spike):
`probe.js` (the shared body), `node-run.mjs`, `wk.swift` (a 45-line WKWebView runner —
`swiftc -O -o wkprobe wk.swift -framework Cocoa -framework WebKit`). Run
`node --no-warnings node-run.mjs` and `./wkprobe "$PWD" app`, then diff the two JSON outputs;
under `LZP-CRYPTO-1` every row must match. Note: `evaluateJavaScript` cannot return a promise
(`WKErrorDomain Code=5`) — use `callAsyncJavaScript`.

---

## 10. Repo consequences

- `src-tauri/tauri.conf.json` → `bundle.macOS.minimumSystemVersion` **stays `"12.0"`**.
  `shell-macos/build.sh` → `LSMinimumSystemVersion` **stays `12.0`**. Neither file changes.
- `package.json` → unchanged. **Zero runtime dependencies preserved.**
- `src-tauri/tauri.conf.json` `csp` currently allows `connect-src 'self' ipc: http://ipc.localhost`.
  Add exactly the one sync origin. Story 21.5 ("exactly one sync endpoint and nothing else")
  becomes **CSP-enforceable** rather than test-enforceable — wire it into LZP-1002.
- `shell-macos/main.swift` gains `keychain_set` / `keychain_get` / `keychain_delete`
  (§2.2), plus the navigation-delegate origin gate (ADR 003 §7). `src-tauri/src/lib.rs` gets the
  same commands beside `:44-62`, registered in `generate_handler!` at `:209-217` — **uncompiled
  on this machine and knowingly so**; the Swift shell is the reference implementation for v2.

## 11. What downstream agents must not change without a new ADR

1. The ciphersuite is `LZP-CRYPTO-1`. No Curve25519, no libsodium, no npm crypto.
2. Verify **before** decrypt; run every §5.2 post-decrypt identity check.
3. The AAD is always non-empty and contains `v, sp, ep, dv, oid, wit`.
4. Plaintext is padded to 256-byte buckets before encryption.
5. There is no authoring timestamp anywhere outside the ciphertext.
6. Pairing requires human SAS confirmation on **both** ends. It is never auto-confirmed.
7. Rotation happens on **every** membership change, and the server enforces wrap coverage.
8. Joiners receive **all** epochs; removed members receive none.
9. Recovery keys are never written to disk or to a backup in plaintext.
10. `personalRecipients` and `familyRecipients` are separate functions with non-overlapping
    scopes, and neither may take the other's list. **Amended 2026-08-28 (finding S1): those same
    two lists are the two admissible SENDER sets, and `admitWraps` may not run without one.** The
    devices entitled to receive a space key and the devices entitled to deliver it are the same
    devices, so this rule reads in both directions and there is deliberately no third list.
