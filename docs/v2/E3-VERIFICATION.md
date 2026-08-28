# E3 — identity and crypto: what is verified, what is written but unverified, what is owed

**Integration pass, 2026-08-27.** Tickets LZP-301…306. Suite: `LZP-CRYPTO-1` (ADR 002 §1).

This file exists because "the tests are green" and "the guarantee is true" are different claims,
and on a machine that can build only one of the two shells they are different *by a known amount*.
Every row below says which of three things it is:

| verdict | means |
|---|---|
| **VERIFIED-HERE** | executed on this machine, in the engine that ships, with the evidence named |
| **WRITTEN-UNVERIFIED** | the code exists and is reviewed, but it has **never been compiled or run**, and the exact reason is stated |
| **OWED** | not built. Named owner, named blocker |

Nothing is marked verified on the strength of a Node run alone where the engine matters. Node is
not the engine the product ships in; `shell-macos/` is, and it is buildable here, so it was used.

---

## 1. Suite numbers, at the close of the pass

| suite | command | result |
|---|---|---|
| tier 1 | `npm test` | **1665 pass · 0 fail** (101 suites) |
| property | `npm run test:property` | **62 pass · 0 fail** |
| attack | `npm run test:attack` | **566 pass · 0 fail** |
| tier 2 — real WKWebView | `npm run test:dom` | **22 files · 375 pass · 0 fail · tier 2: PASS** |

E3's own share of tier 1: `crypto-identity` 62 · `crypto-spacekeys` 38 · `crypto-envelope` 52 ·
`crypto-pairing` 57 · `crypto-backup` 69 · `crypto-guarantees` 8 = **286**.
E3's share of tier 2: `crypto-identity` 26 · `crypto-keystore-phase1` 4 · `-phase2` 8 ·
`crypto-spacekeys` 11 · `crypto-envelope` 19 · `crypto-pairing` 13 · `crypto-backup` 16 = **97**.

Zero npm dependencies (`dependencies: {}`; `devDependencies` is `@tauri-apps/cli` alone, as
before). No new files in the repository root.

---

## 2. Ticket verification

| ticket | what it is | verdict | evidence — or the exact reason it is not |
|---|---|---|---|
| **LZP-301** | the ciphersuite spike | **VERIFIED-HERE** (delivered before this pass) | ADR 002. Its conclusion is load-bearing and still holds: **P-256, not Curve25519, because WKWebView is the binding constraint** — X25519 shipped only in Safari 18.4 and macOS Monterey never receives it, while ECDSA/ECDH P-256 ship since Safari 7/11. Keeps `minimumSystemVersion` at 12.0 and adds no dependency. |
| **LZP-302** | suite, probe, identity, key custody | **VERIFIED-HERE** | `crypto-identity.dom.js` (26) in the real engine; `crypto-keystore-phase1/2.dom.js` (12) across **two separate app launches**. All seven engine rules exercised in WebKit — §4 below. §2.2's open verification item is **answered: YES** — §3 below. |
| **LZP-303** | space keys, epochs, rotation | **VERIFIED-HERE** | `crypto-spacekeys.dom.js` (11), including a **cross-engine KAT**: both ECDH keys, the wire salt, the IV and the space key are pinned, and the wrap ciphertext is asserted **byte-for-byte identical in Node and in WKWebView**, for a family space and a personal space. Legitimate because ECDH/HKDF/AES-GCM are deterministic — rule 1 is about ECDSA and does not apply. Family sharing *is* "a wrap made on one Mac opens on another"; without this, engine divergence leaves every tier-1 assertion green and the product broken. |
| **LZP-304** | the op envelope | **VERIFIED-HERE** | `crypto-envelope.dom.js` (19). Centrepiece is a **cross-engine fixture**: a real envelope produced by `sealOp` in Node v22.23.1, embedded with its raw AES key and `DeviceAttestation`, opened inside WKWebView. One assertion proves five things no single-engine test can — the AAD is the same bytes, AES-256-GCM/12-byte-IV/128-bit-tag interoperates, a Node ECDSA P-256 signature verifies under WebKit's, the 256-byte padding and its varint agree, and `canonicalJSON` agrees. Per rule 1 the fixture's `sig` is **verified, never compared**. |
| **LZP-305** | backup / recovery (A2, D8) | **VERIFIED-HERE** | `crypto-backup.dom.js` (16). The KDF chain is pinned by two hex vectors asserted byte-identical in both engines, plus a second hand-rolled implementation in `tests/helpers/kat.js` that reproduces a real file. **Measured in WKWebView: 600 000 PBKDF2-SHA-256 rounds in 173–227 ms** — the export sheet needs no progress state. |
| **LZP-306** | pairing (19.4, 19.5) | **VERIFIED-HERE** | `crypto-pairing.dom.js` (13), plus the hostile relay `tests/helpers/mitm.js` — five transports (honest / active-MITM / blind / replay / downgrade) that **re-implement HKDF, AES-GCM, the AAD, the framing and the padding against raw WebCrypto and write the four `lzp/v2/pair/*` labels out as literals**, so an attacker built from the victim's own helpers cannot "find" a bug in them. |
| **the macOS shell bridge** | `keychain_set/get/delete`, service `org.langzeitplaner.keys` | **VERIFIED-HERE** | `shell-macos/main.swift`, exercised against a **real Keychain** by the two keystore phases. `keychainService()` gives headless runs a separate service (`…keys.headless-test`) so a test can never touch a production item. |
| **the Tauri shell bridge** | the same three commands in `src-tauri/src/lib.rs` | **WRITTEN-UNVERIFIED** | **There is no Rust toolchain on this machine** (PLAN.md risk R8), so `src-tauri/` cannot be compiled here *at all* — not "was not", *cannot be*. Written to match the Swift reference command-for-command and marked as unverified in the file itself. §5 below is the checklist for the first machine that has `cargo`. |
| **invites** (ADR 002 §7.1, stories 15.3 / 15.5) | `generateInviteCode`, `deriveInvite` | **OWED** | No ticket in LZP-302…306 covered them. Owner **WP-7**, together with the `/api/v1/invite/*` endpoints. Note `sealInviteKeys` / `openInviteKeys` are **retired by D9, not owed** — see §6. |

---

## 3. ADR 002 §2.2's open item — **ANSWERED: YES**, with one condition the ADR did not know about

> *"Confirm with a real `--test` run that a non-extractable `CryptoKey` in IndexedDB persists
> across an app relaunch under the `app://localhost` scheme."*

**It does.** Proved by **two separate launches of the real shell**, not by one process reading back
its own memory: `crypto-keystore-phase1.dom.js` performs a full `ensureDeviceIdentity` and its
process exits; `-phase2.dom.js` is a **new process** that reads it back. On the restored key:

- `extractable === false`;
- `exportKey('pkcs8')` and `exportKey('jwk')` still **reject**;
- a signature made by the restored **private** key verifies under the public point the *previous
  process* recorded;
- `deviceShort` is unchanged;
- `ensureDeviceIdentity` **adopts** rather than mints.

**No downgrade to `identity.enc` is needed, and nothing goes into `DESIGN-DECISIONS.md`** — which
is what the ADR asked for if the answer had been no.

### The condition — and it is a shipping blocker, not a footnote

WebKit cannot structured-clone a `CryptoKey` **without the login Keychain**. A persisted
`CryptoKey` is encrypted under a per-application *"WebCrypto master key"* that WebKit keeps as a
Keychain generic password **whose ACL is bound to the code signature of the binary that created
it**. Rebuild or re-sign the app and WebKit can no longer read it:

- it logs `Cannot store WebCrypto master key, error -25299` to the **process's stderr**, where the
  page cannot see it;
- `put()` then rejects with `DataCloneError`;
- and — the part that makes it hard to spot — **previously stored keys read back as `null`**,
  while plain values in the same database survive untouched.

Reproduced three ways: with no login keychain (`-60006`), and twice with a **rebuilt binary against
an item created by the previous build** (`-25299`, key returns `null`).

Two consequences:

1. §2.2's framing that IndexedDB custody *avoids* depending on the Keychain is **only half true**.
   On WebKit the Keychain is a **prerequisite of the primary store**.
2. **`shell-macos/build.sh` ad-hoc signs, D1 says ship unsigned, and LZP-102's updater replaces the
   bundle.** On that path every device key becomes unreadable after an update:
   `ensureDeviceIdentity` would find 2 of its 3 records, refuse (correctly — it is deliberately
   brittle about partial state), and the user would have to re-pair **after every update**.

`idbKeyStore.put` reports this as `KeyStoreUnavailableError` — *"custody unavailable"*, never *"bad
key material"* — and does so **without branching on the error name** (rule 3). A stable
Developer-ID signature makes the ACL survive. → **finding E3-1**, owner WP-8 / LZP-102 packaging.

This also forced a real fix to `tests/run-dom-tests.sh`: the tier-2 build is now re-identified as
`org.langzeitplaner.domtest` before launch, so WebKit's website data store (localStorage **and**
IndexedDB) is genuinely isolated from the installed app — **it was shared before** — and the stale
master-key item the suite must clear belongs to the suite. Clearing the production one would have
orphaned a real installation's device keys.

---

## 4. The seven engine-difference rules — coverage

Each rule is covered by a test **in both engines** unless the row says otherwise. No rule is
"not applicable": all seven bite somewhere in E3.

| # | rule | Node | WKWebView |
|---|---|---|---|
| 1 | never compare signature bytes | `crypto-identity` — *"RULE 1: two signatures over the same bytes DIFFER — no golden-signature fixture is possible"* | `crypto-identity.dom` — *"RULE 1: WebKit ECDSA is non-deterministic too"*; `crypto-envelope.dom` — *"RULE 1 in WebKit: two seals of one op differ in sig, iv and ct"* |
| 2 | never sign/verify a zero-length payload | `crypto-identity` — *"RULE 2 is a guard"*, *"RULE 2, at the seam"* | `crypto-identity.dom` — *"RULE 2: WebKit refuses a zero-length payload at our guard, before it reaches verify()"* |
| 3 | never branch on error NAMES | `crypto-identity`, `crypto-spacekeys` (*"unwrapSpaceKey returns null for every failure and never leaks an engine error name"*) | `crypto-identity.dom`, `crypto-spacekeys.dom`, `crypto-envelope.dom`. Names are **recorded as diagnostics** (§7) and never compared |
| 4 | `HkdfParams.salt` is mandatory | `crypto-identity` — *"RULE 4 is a required argument, not a comment"* and *"at the engine: omitting it really is a TypeError here"* | `crypto-identity.dom` — *"RULE 4: HkdfParams.salt is mandatory here too"*; `crypto-backup.dom` |
| 5 | peer ECDH public key needs `keyUsages: []` | `crypto-identity` — *"RULE 5 is encoded as a frozen empty array, and a non-empty one really is refused"* | `crypto-identity.dom`; `crypto-pairing.dom` — *"a peer ephemeral ECDH point imports with keyUsages [] and REJECTS with anything else"* |
| 6 | never AES-KW a P-256 private key | `crypto-identity` — *"AES-KW really does refuse a P-256 private key, and AES-GCM does not"*; `crypto-spacekeys` characterizes **the trap**: AES-KW *would* wrap a 32-byte space key, which is why a 25519 prototype hides the bug | `crypto-identity.dom` (*"…and AES-GCM wraps it to 154 bytes"*); `crypto-spacekeys.dom`; `crypto-pairing.dom` — *"the delivered PKCS#8 is 138 bytes, and WebKit refuses to AES-KW it"* |
| 7 | Node has no `indexedDB`; `isSecureContext` is `undefined` there | `crypto-identity` — *"RULE 7: Node has no indexedDB, so idbKeyStore refuses rather than pretending"*. **Not shimmed**: a fake IndexedDB would have turned an unverified design into one that merely *looked* verified | `crypto-identity.dom` — *"this engine has indexedDB and isSecureContext === true under app://localhost"*; `crypto-envelope.dom` |

Plus the **two rules LZP-302 discovered that the seven do not name**, both now in the contract
header: **(8)** the WebCrypto master key / code-signature ACL — §3 above; **(9)** `importKey` /
`unwrapKey` of a **private** EC key must carry only the private usages (`USAGES.sigPrivate` /
`USAGES.kexPrivate`) — a `SyntaxError` in both engines, and it bites only on the **restore** path,
the one a developer exercises last.

---

## 5. The purity gate

Everything under `src/js/crypto/` imports under **bare Node with `window` and `document`
deleted**, and holds no state and does no I/O. Enforced twice:

- **statically and dynamically** by `tests/tier1/core-purity.test.js`, which **discovers files by
  reading the directory, never from a list** — so a module added by a later work package is
  covered the moment it lands;
- **independently, as its own gate** for this pass. Result:

```
window in globalThis     : false
document in globalThis   : false
indexedDB in globalThis  : false      (rule 7: Node has none)
isSecureContext          : undefined  (rule 7: undefined, not false)

  OK  src/js/crypto/backup.js      17 exports
  OK  src/js/crypto/envelope.js    18 exports
  OK  src/js/crypto/identity.js    23 exports
  OK  src/js/crypto/pairing.js     20 exports
  OK  src/js/crypto/probe.js        4 exports
  OK  src/js/crypto/spacekeys.js   34 exports
  OK  src/js/crypto/suite.js       30 exports
  OK  src/js/platform/keystore.js (the ONE stateful module) 12 exports

PURITY GATE: PASS
```

`keystore.js` is the single stateful module and lives in **`src/js/platform/`**, not under
`crypto/` — ADR 005 §2's direction, and the reason `crypto/` can take a `KeyStore` as a port.

---

## 6. What the Tauri side needs when a machine with `cargo` exists

`src-tauri/src/lib.rs` is written and reviewed; it has **never been compiled**. Two things to check
before trusting it — both of which the Swift reference gets right and neither of which the simple
binding guarantees:

1. **ACCESSIBILITY — a security difference, not a style one, and the first thing to check.** The
   Swift side sets `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. *WhenUnlocked*: unreadable while
   the Mac is locked. *ThisDeviceOnly*: **never synced to iCloud Keychain** — ADR 002 §8.12 records
   that the recovery key has **no revocation and no leak detection**, so syncing it would widen
   that residual from one Mac to every device on the Apple ID.
   `security_framework::passwords`' convenience functions **take no accessibility argument**. If
   they do not default to `WhenUnlockedThisDeviceOnly`, rewrite against
   `security_framework::item::ItemAddOptions` (or raw `SecItemAdd`) with the attribute set
   explicitly.
2. **ISOLATION.** The Swift shell uses a separate service name for headless runs so a test can
   never touch a production item. Tauri has no headless test mode today; if one is added, mirror
   `keychainService()`.

Then re-run the two keystore phases against the Tauri shell. The service name and the two account
names are fixed by ADR 002 §2.2 and mirrored in `src/js/platform/keystore.js` as
`KEYCHAIN_SERVICE` / `KEYCHAIN_ACCOUNTS`, so a drift is a one-line diff, not a hunt.

---

## 7. The guarantee suite — `tests/tier1/crypto-guarantees.test.js`

One test per numbered product promise, each end-to-end through the real public API, because a
guarantee is a claim about a **composition** and a composition can be false while every module in
it is green. All eight pass. **Each was mutation-tested**; the mutation that should kill it does.

| # | guarantee | result | mutation that kills it |
|---|---|---|---|
| **21.1** | the server never holds readable content | **PASS** | remove the AAD's space binding; disable padding |
| **21.2 / 20.5** | no family key can decrypt a personal-space op; no role grants insight into another member's private entries | **PASS** | remove `personalRecipients`' scope refusal; remove the AAD's space binding |
| **20.2** | a removed member cannot decrypt after the rotation — **and can still decrypt what they already held** | **PASS** | make `familyRecipients` keep every member it has ever seen |
| **16.7** | Belegt is indistinguishable from Geteilt by ciphertext **length** | **PASS** | disable the 256-byte padding |
| **19.4** | my own devices share my private board, end to end | **PASS** | (covered by the padding and AAD mutations) |
| **19.5** | pairing fails closed against the MITM relay | **PASS** | see the pairing suite's own seven mutants |
| **A2 / D8** | the backup's identity block is never plaintext; a wrong passphrase fails cleanly | **PASS** | — |
| **15.1 / Principle 7** | solo mode generates no keys and runs no probe | **PASS** | add one `import` of `crypto/probe.js` to `boot.js` |

Three of these deserve a note, because the *shape* of the assertion is the point:

- **20.2 asserts the honest limit in the same test as the guarantee.** Removal is **forward-only**:
  the removed member keeps `FSK_1` and every epoch-1 envelope she ever synced, and no rotation can
  reach into her Mac and take either away. German copy that says *„sieht deine Einträge nicht
  mehr"* without *„ab jetzt"* is false, and this row is what keeps that sentence honest.
- **16.7's boundary is pinned, not rounded off.** Belegt and an ordinary shared entry are both
  **528 bytes** of ciphertext (512 padded + one 16-byte tag). A **maximal** 80-character `pub.text`
  crosses into the next bucket at **784**. So the guarantee is *"Belegt is indistinguishable from an
  ordinary shared entry"*, **not** *"length is never informative"* — §5.3 never claimed the latter,
  and the test asserts the edge so nobody widens the claim later.
- **15.1 is asserted in the two forms it can actually be false**, because it is the one guarantee
  whose breach produces no error, no delay and no wrong answer: **(a) reachability** — nothing under
  `src/js/crypto/` or `src/js/platform/keystore.js` is reachable from `boot.js`, `firstrun.js` or
  `main.js`, since an `import` is evaluated whether or not anyone calls the function; **(b)
  evaluation** — importing the whole crypto layer draws **zero** CSPRNG bytes and performs **zero**
  `generateKey`/`deriveBits` calls, so a future `const K = await generateKey()` at module scope
  fails here rather than shipping. The spies are themselves proved to observe a real keygen, so (b)
  cannot pass vacuously; and the import walk is proved to find a prefix that *is* reachable, so (a)
  cannot either.

### WebKit error names, recorded as diagnostics only

Never branched on (rule 3), recorded so rule 3 stays a live constraint rather than folklore:
`InvalidAccessError` (Node says `InvalidAccessException`) · `TypeError` (missing HKDF salt) ·
`SyntaxError` (non-empty peer ECDH usages; a private ECDSA key carrying `verify`) ·
`OperationError` (AES-KW over 138-byte PKCS#8; AES-GCM wrong key; tampered AAD) ·
`DataError` (off-curve point, point at infinity) · `DataCloneError` (§3's master-key loss).

---

## 8. Still owed — the full list

Everything here is **reported, not reached into**: no E3 file touches another owner's module.

### Blocking a downstream work package

| # | what | owner | why it cannot be done here |
|---|---|---|---|
| 1 | **`core/ops.js` has no `PARK_REASONS.ATTESTATION`** (finding **F-6**) | **WP-8** | ADR 002 §5.2.5 requires an op from a device whose attestation has not arrived to be **parked, not rejected**. `authz.js:671` rejects and `store.js:699-703` drops without appending, so it is never re-evaluated. `ENVELOPE_PARK.ATTESTATION` is defined in `envelope.js` with the value ops.js must adopt; until then a caller writing it into the log fails `isParkReason`, which is the correct loud symptom. **Both tiers assert the gap is still real**, so the rows turn red the day WP-8 lands it — which is when to re-point the constant and delete them. |
| 2 | **`core/project.js` does not exist** | **WP-10** | `PROJECT_CONTRACT` in `envelope.js` is the spec, executable: brand every returned patch with a non-enumerable/non-writable/non-configurable `Symbol.for('lzp/v2/family-patch')`; `brand.level` is the level actually applied; export `assertFamilyPatch(patch, kind, level)`; the outbox injects it plus `levelOf(entityKey)` from the authenticated register map. **Until all four land, no family `pub.set` can be sealed at all** — deliberately. `crypto-envelope.test.js` runs a conforming miniature projection against the contract so WP-10 has something to run against on day one. |
| 3 | **No wire field carries another member's `RK_kex`** | **WP-7 / ADR 003 §2** | §4.2 step 2 says a rotation wraps "plus each member's `RK_kex`", but `MemberRowDb` carries only `recoveryPubSig` and the `dev.*` attestations cover **device** keys. Wrapping to an unauthenticated public key someone hands you is exactly the key-injection channel §2 names, so `familyRecipients` wraps to **attested devices only** and reports every member it could not include on `familyRecipientsReport().missingRecoveryKex`. The personal space has no such gap. |
| 4 | **`KeyWrapRow.deviceId` for a recovery recipient** | **server** | `recoveryRecipientId` reserves `rec_<memberId>`. If the relay's `KeyWrap.deviceId` is a foreign key onto `Device`, the server must accommodate it — or drop recovery wraps entirely. |
| 5 | **The four `/api/v1/pair/*` endpoints**, plus rid-burn semantics and one rate-limit policy | **WP-7** | "5 failed decrypts per rid" **cannot be a relay-side counter** — the relay holds no key and cannot observe a decrypt, so it is necessarily *client-reported*, and anyone who knows a rid can burn it. (Knowing a rid means knowing the code, so the DoS is bounded by the same secret.) Separately, ADR 002 §6.2 and ADR 003 §6.1 publish **different limiters** — 20 `pair/get`/IP/hour vs 5 failed rid lookups/IP/**minute** plus 10 sessions/member/hour. Not contradictory, not interchangeable; both are carried on `PAIRING` and a test asserts they are not the same thing. |
| 6 | **`member:<memberId>` → `dev.<deviceShort>` writes, and unpairing** | **WP-9** | `adoptPairedDevice` returns the blob; writing the register is WP-9's. **Unpairing does not exist**: `dev.*` is write-once and there is no revocation anywhere (§2.3, §8.2a), so a „Gerät entfernen" button can only stop *future key distribution*. **The UI string must say the smaller true thing.** A test asserts `pairing.js` exposes no `revoke`/`unpair`, so nobody mistakes it for having solved this. |
| 7 | **The wiring ticket** `src/js/backup.js` | **LZP-1004** | Call order is written out as §9 of `backup.js`. Two things it must not get wrong: `result.board` is `schemaVersion: 2` with `visibility`/`coEdit`, so it goes through ADR 001 §5.4's diff transaction and **never** `migrateV1`; and `result.consequence` must be shown on **both** paths. |
| 8 | **Invites** — `generateInviteCode`, `deriveInvite` | **WP-7** | Not covered by any E3 ticket. `sealInviteKeys`/`openInviteKeys` are **retired by D9** and must not be built: `suite.js`'s `RETIRED_INFO` makes `infoBytes('lzp/v2/invite/wrap')` throw **by name**, and `buildRotation` **refuses** an invite carrying `wrappedKeys` rather than stripping it — stripping would hide a caller who still believes in the seven-day read window. |
| 9 | **The outbox must pass `ctx.attestation` to `sealOp`**, and must be able to hold a **sealed, never-decrypted envelope** for both park reasons | **WP-8** | Same shape §4.4's unknown-epoch park already requires. |

### Open, and not closed by anything in E3

- ~~**I-3 / R5-7 stays OPEN**~~ — **CLOSED 2026-08-28, in `src/js/core/authz.js`, and no E3 file
  changed.** Everything this entry says about P2 is true and is the reason the answer had to come
  from the fold: a `dev.<S>` register is a credential only if the op that wrote it was stamped by
  the device it attests (`devOf(cell.stamp) === att.deviceShort`), which is sound because
  `openOp`'s P2, P3 and check 4 mean an op stamped with `S` was signed by `S`'s key. Two
  obligations land on this layer as a result and are recorded in `crypto.contract.js`: **check 4
  may not be weakened, made optional, or moved after the decrypt**, and **nothing may append an op
  that has not passed `openOp`** (M-I5b). `attestationOf` is still a **partial** function — absent,
  unproven, or proved twice — so nothing built on the park behaviour changes. Original text follows.
  Every E3 module says so in its own tests rather than assuming
  otherwise. `verifyAttestation` enforces **P2** as a MUST — it refuses a validly-signed blob whose
  `deviceShort` is not `crock32(SHA-256(sigPubRaw)[0..10])`, and `attestDevice` refuses to mint one.
  **But P2 buys self-consistency, not identity**: `sigPubRaw` is a **public key travelling in the
  victim's own register** inside the E2EE stream every member can read, so a squatter copies it,
  tells the truth about it, files it under her own record, and passes P2.
  Closing it needs **FINDINGS §4.5 option (a)** — first-claim binding on the pair
  `(sigPubRaw, deviceShort)` at fold time — which is `src/js/core/authz.js`'s decision, and no E3
  file touches it. Consequently `openOp` treats `attestationOf` as a **partial function** and
  **parks**; it does not assume P2 restores liveness on a squatted short. Characterization rows
  named *"I-3 / R5-7 IS STILL OPEN"* exist in **both tiers** so it cannot be re-planned away.
- **§8.5 — no key transparency.** A phantom member receives the family key and this layer cannot
  tell. Characterized, not fixed.
- **§8.9 — no forward secrecy within an epoch.** Characterized, not fixed.
- **§2.3 / §8.2a — no device revocation anywhere.** `openOp` has no revocation input and **did not
  invent one**: a test asserts that an attestation carrying a `revokedAt` still opens. If that row
  ever fails, revocation was invented at the wrong seam.
- **The backup's board block is not authenticated** — a PO decision, stated in full in
  `crypto.contract.js` §7 and carried as `LIMITS.boardNotAuthenticated` in German and English.
- **`canonicalJSON` NFC-normalises**, so a note typed as NFD (macOS decomposes) is sealed as NFC
  and comes back NFC on every peer *and on the author's own second device*, while the local truth
  register still holds NFD until something rewrites it. Not a bug in `envelope.js` and not fixable
  there — the fix, if wanted, is to normalise at the **mutation** seam so the store and the wire
  agree. Un-normalising the wire is not an option. Pinned as a characterization row for WP-8.

### Documentation corrections applied by this pass

- **ADR 002 §5.1's example `sp`** was `fsp_9xQ2mR7bL0aZ4tV8wK` — 18 characters after the prefix,
  where `core/entities.js`'s `SPACE_ID_RE` requires 22. The ADR's own example did not satisfy the
  ADR's own regex, and it had been copied into a fixture. Corrected in place, with a note that the
  regexes are normative and the examples are illustrations. `oid`, `dv` and the rest were valid.
- **`DESIGN-DECISIONS.md` D9** said *"the admin's device must be online"*. ADR 002 §7.1 step 4 says
  **any existing member device**, is later, and gives the reason — a two-person family would
  otherwise depend on one sleeping laptop. Corrected, with the original preserved as a footnote.
  The delivered code enforces the ADR **structurally**: nothing in `spacekeys.js` takes a role, an
  `isAdmin` flag or an admin id, and a test asserts no export names one.
- **ADR 002 §2.2's verification item** is closed with the evidence and the code-signing condition.
