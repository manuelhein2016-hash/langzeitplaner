# ADR 002 — Crypto: primitives, keys, pairing, recovery

| | |
|---|---|
| **Status** | Accepted — normative |
| **Date** | 2026-08-25 |
| **Tickets** | LZP-301, 302, 303, 304, 305, 306 · supports 502, 601/602, 608, 701, 1003, 1004 |
| **Stories** | 15.2, 15.3, 15.5, 19.4, 19.5, 20.2, 20.3, 20.5, 21.1, 21.2, 21.3, 21.4, A2 |
| **Amends** | LZP-301's "libsodium-based design" premise → `LZP-CRYPTO-1` (§1); LZP-302's "macOS Keychain via Tauri" → non-extractable IndexedDB keys + a Keychain *backstop* (§2.2) |

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
 */
signature = ECDSA-P256/SHA-256( RK_sig.private, canonicalJSON(attestation) )
```

The attestation travels **inside the E2EE stream**, as the family register
`member:<memberId>` → field `dev.<deviceShort>` → value `b64u(canonicalJSON(att)) + '.' + b64u(sig)`
(a write-once register, ADR 001 §3.1). It is therefore authored under a key the relay does not
hold, so **a malicious relay cannot fabricate a device row for an existing member.**

Every client verifies the attestation before accepting an op from that device (ADR 001 §4.0), and
**every client verifies it before wrapping a space key to that device** (§4.2).

Residual: a malicious relay could still fabricate a whole *member* row on the coordination API.
The rotating client would then wrap the family key to an unattested stranger unless someone
notices an unknown name in the member list. **The member list is therefore a security surface,
not just a roster** — deliverable 22 must treat it that way, and the panel shows a per-member
**device count** so an extra device is at least visible. §8.5.

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

### 4.2 Who rotates, and the procedure

**The member whose action caused the rotation performs it** — the joiner on join, the admin on
removal, the departing member's successor-admin on leave. This removes the "the admin's Mac must
be awake" dependency that would otherwise put story 15.3 ("a non-technical family member gets in
within a minute") at the mercy of a sleeping laptop.

1. `FSK_{e+1} = createSpaceKey()`
2. Verify the **device attestation** (§2.3) of every current, non-revoked member device, then
   `wrapSpaceKey(FSK_{e+1}, myKexPriv, deviceKexPub)` for each, plus each member's `RK_kex`.
3. Re-wrap every **open (un-redeemed, non-expired, non-revoked) invite blob** to `FSK_{1..e+1}`
   under its stored `wrapSalt` — the server returns the open-invite list in the same call
   (§5 of ADR 003). *Rotation must not silently invalidate a pending invite; a family of eight
   onboarding two people at once would otherwise break.*
4. `POST /api/v1/spaces/:id/epoch { epoch: e+1, wraps: [{deviceId, wrapped}], invites: [...] }`
   — one transaction: insert the `KeyWrap` rows, set `Space.currentEpoch`, **delete every
   `KeyWrap` belonging to a removed or revoked device, for all epochs**, refresh invite blobs.
5. Emit `space.set{epoch: e+1}` into the family log so honest clients switch immediately.

**Two server-enforced checks make rotation safe without the server reading anything:**

- `@@unique([spaceId, epoch])` on the `Epoch` row ⇒ **first writer wins**. A concurrent rotator
  gets `409 epoch_taken`, re-fetches its wraps and stops if it now holds one; otherwise it
  retries at `e+2`.
- **Coverage check:** the server rejects an epoch bump whose `wraps` do not cover **every**
  current, non-revoked device of **every** non-removed member. This is checkable from
  coordination data alone and it closes the obvious denial-of-service: a member rotating to a key
  wrapped only to themselves.

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
`GET /api/v1/spaces/:id/keys` returns **every** wrap addressed to this device, all epochs.
`openOp` looks the epoch up in the `KeyRing`; on a miss it triggers **one** key fetch and retries;
on a second miss it **parks** the op (ADR 001 §7.4) rather than erroring. A key arriving later
unparks it, and because merge is set-based, unparking late is harmless.

---

## 5. The op envelope (LZP-304)

### 5.1 Wire shape — exactly what the server stores

```jsonc
{
  "v":   1,
  "sp":  "fsp_9xQ2mR7bL0aZ4tV8wK",       // spaceId
  "ep":  3,                              // key epoch
  "dv":  "7QAR2MZ9XKPNC0GV",             // deviceShort of the author
  "oid": "8Kx2Qm7bR0aZ4tV9wLpNcg",       // opId — random, NO time component
  "wit": "kQ7bR0aZ4tV9wLpNcgXk92",       // chain witness (§5.4); '' on the first push
  "iv":  "pQ7bR0aZ4tV9wLpN",             // b64url, 12 bytes
  "ct":  "Xk92…",                        // AES-256-GCM over the PADDED plaintext
  "sig": "MEUCIQ…"                       // ECDSA P-256/SHA-256 over aad ‖ iv ‖ ct
}
```

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

### 5.2 Mandatory post-decrypt checks

After a successful decrypt, `openOp` **must** verify and throw on any mismatch:

```
op.id    === env.oid
op.space === env.sp
deviceShort(op.dev) === env.dv
op.act   === memberOf(env.dv)          // from the attested device registers, §2.3
```

Without these, a valid signer could bind an authenticated header to an unrelated op body, and
`op.act` — which 17.6 renders directly as "von Mama" — would be forgeable by any member.
**Attribution is a trust surface; treat it as one.**

`openOp` also rejects a field whose *value* fails its declared type check in `FIELDS`
(a protocol violation → drop and log locally), while an unknown *kind* or an unknown *field name*
is **parked** (ADR 001 §7.4).

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
6. The restored epoch keys decrypt everything already on the server. If the family epoch has
   advanced past what the backup holds, the client requests a wrap and the rotation coverage
   check (§4.2) means the next rotation includes it; until then, newer ops are **parked**, not
   lost, and the sync status shows „Schlüssel ausstehend".
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
    scopes, and neither may take the other's list.
