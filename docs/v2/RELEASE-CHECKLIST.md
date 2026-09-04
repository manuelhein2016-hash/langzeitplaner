# Release checklist

| | |
|---|---|
| **Part of** | LZP-1008 (ops runbook) |
| **Companion to** | `docs/v2/RELEASE.md` — the *how* and the *why*. This is the *what, in order*. |
| **Read first** | `docs/v2/SHIP.md` — **the things only the PO can do**, in the order they unblock each other. This sheet is mechanical; that one is the decisions, the accounts and the domain. Working this sheet top to bottom without §1–§2 of that one produces a release nobody can join. |
| **Written** | 2026-09-03 |

Print it, or copy it into the release commit message. Tick every box; write the value where a box
asks for one, so the ticked sheet is a record rather than a memory.

The two mechanisms this checklist covers are **not the same thing** and are triggered
independently, which is the single most likely operator mistake:

```
git tag  v2.0.1   →  the desktop app  →  GitHub Releases  →  every Mac updates itself
git push main     →  the sync server  →  Vercel (fra1)    →  nothing announces it
```

A server deploy has no tag, no release page and no version dialog. If you only ever watch the
tag, you will not notice the deploy that broke the relay.

---

## A · Once, ever — before the first release exists

Nothing below repeats. All of it is still open today.

- [ ] GitHub repository created and `origin` pushed (the tree is local-only; no workflow has ever run)
- [ ] Repository visibility decided **deliberately** — public, or private with a fallback download
      link Mom can reach without a GitHub account (`RELEASE.md` §2.5). Decide before the e-mail is
      designed, not after she meets a login page. → decision: ......................................
- [ ] Updater keypair generated: `cargo tauri signer generate`
- [ ] `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` is a **real** key
      (it is the literal string `REPLACE_ME__…` today, and `check-release-config.mjs --strict`
      correctly fails on it)
- [ ] Secrets: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- [ ] `plugins.updater.endpoints` no longer says `OWNER/REPO`
- [ ] `shell-macos/main.swift`'s `UPDATE_MANIFEST_URL` no longer says `OWNER-PLACEHOLDER`
- [ ] **`workflow_dispatch` run completed green before any real tag.** ~~`src-tauri/` has never
      been compiled; nobody knows whether the Rust half builds~~ — **it has now, and it did not.**
      Measured 2026-09-04 on rustc 1.98.1 / cargo 1.98.1, aarch64-apple-darwin: a clean
      `cargo check` **failed**, in `build.rs`, before rustc ever looked at `lib.rs` —
      `Cargo.toml` declared the `macos-private-api` feature while `tauri.conf.json` declared
      `"macOSPrivateApi": false`, and `tauri-build` refuses the mismatch. `cargo tauri build`
      in `release.yml` would have failed on the first real tag, at the end of a 25–40 minute
      run, with the family waiting. Fixed by dropping the feature (the config was the half that
      was right: no window here is transparent). **After the fix, measured on this machine:**
      `cargo check --all-targets --locked` with `RUSTFLAGS=-D warnings` → exit 0, zero warnings;
      `cargo build` → a 55,942,992-byte Mach-O arm64 executable.
      `.github/workflows/ci.yml`'s **`shell-rust`** job now does both on every push, so this
      cannot go unmeasured again. What is still NOT proven here: `cargo tauri build` itself —
      the universal (x86_64 + arm64) binary, the bundler, the DMG.
- [ ] ⛔ **THE RELAY ORIGIN — ONE ACT, FOUR MAILS AND TWO SHELLS, OR NOT AT ALL.**
      This was two things until AUDIT F1, and the half that mattered was missing. The sheet made
      you write a relay address into four invitation mails that **nothing reads**, and never
      named `SYNC_ORIGIN_BUILTIN` — the string every `sync_request` is rebuilt against, byte for
      byte, in both shells. Work that version of this sheet top to bottom and you ship a build in
      which the address you were just made to write down is read by nothing and every family
      request is refused locally as `no_origin_configured`, before a socket exists. The page
      cannot route around it: `chooseTransport` returns `bridge` inside the shell and
      `index.html:14` is `connect-src 'self'`. Both halves, in one commit:

      ```bash
      # 1 · the four mails  (docs/v2/email/invitation.{de,en}.{txt,html})
      sed -i '' 's|https://serveradresse-fehlt\.invalid|https://NEW-HOST|g' docs/v2/email/invitation.*
      # 2 · the pinned origin, both shells
      #     shell-macos/main.swift   let SYNC_ORIGIN_BUILTIN = "https://NEW-HOST"
      #     src-tauri/src/lib.rs     const SYNC_ORIGIN_BUILTIN: &str = "https://NEW-HOST";
      ```

      → real origin: ...................................  → written into all six files ☐

      ⚠️ **THE HOST MUST BE PURE ASCII. An umlaut in the relay domain breaks the Swift shell
      completely** — and this is a German-first product, so `münchen`, `familienkalender`
      spelled with an ä, or any other IDN is a realistic thing to type into the line above.
      Measured 2026-09-04 by compiling each shell's origin validator and running the same
      value through both:

      | configured `SYNC_ORIGIN_BUILTIN` | pinned by Swift | pinned by Rust |
      |---|---|---|
      | `https://xn--mnchen-3ya.example.org` | `https://münchen.example.org` (U-label) | `https://xn--mnchen-3ya.example.org` (A-label) |

      `URLComponents.host` hands Swift the **decoded** Unicode host; the `url` crate and
      `new URL()` both keep the **Punycode** form. `net.js:265 normalizeOrigin` returns
      `u.host`, so the page always sends the A-label. `syncCanonicalURL` then requires the
      rebuild to equal the request **byte for byte**, and it does not:

      ```
      page requests : https://xn--mnchen-3ya.example.org/api/v1/ops
      Swift          : REFUSED url_is_not_the_canonical_rebuild     ← every request, for ever
      Rust           : ALLOWED https://xn--mnchen-3ya.example.org/api/v1/ops
      ```

      So an IDN relay makes the **Swift** shell refuse every family request locally, before a
      socket exists, while the Rust shell works — the one time the two shells disagree, and the
      broken half is the one every measurement in this project was taken on. Nothing tests this
      (`tests/tier1/release-gate.test.js` compares the two constants for equality, and they
      *are* equal — the divergence is in how each shell parses that identical string). **Choose
      an ASCII host and this cannot bite you.** → host is pure ASCII ☐

      **This box is not the gate.** `tests/tier1/release-gate.test.js` is, and it runs inside
      `npm test` (§B). It fails when the two halves are in different states — either half moved
      alone, or both moved to different hosts — and `scripts/mom-test-probe.mjs` row `M2s` fails
      while the address is still the reserved slot. A checklist item is a reminder; those rows
      are what a release cannot pass with an unset origin.
- [ ] ⛔ **The relay host is CLAIMED, and the placeholder is not.** Today the four mails carry
      `https://serveradresse-fehlt.invalid`. RFC 2606 §2 reserves `.invalid` so no registry can
      delegate it and no resolver answers it — a mail sent before the substitution therefore
      names **nobody**. That is deliberate (AUDIT F13): the previous placeholder was
      `https://lzp-sync-po.vercel.app`, and measured 2026-09-03 it answered **HTTP 404
      `x-vercel-error: DEPLOYMENT_NOT_FOUND`** — a `*.vercel.app` name free for any stranger to
      register. An invitation carries **no key material** (D9), so a stranger's relay mints no
      epoch key and could not read one shared entry; but `deriveInvite(code)` is pure, so a
      joiner's first request would hand that stranger, in the clear, a token that redeems the
      invite against the **real** relay unchanged, plus her device public keys and her IP. The
      cost is a burnt invitation, a seat in the circle taken by somebody else, and a person told
      she joined a family that is not there — **not** a way to read the family's calendar.
      → host claimed on: .................. → `curl -si https://<host>/api/v1/meta` → ..........
- [ ] **Note what that address changed, and say so if anyone asks.** Before it, the e-mail alone
      was not enough to join — the reader had to learn the relay address elsewhere. Now it is.
      That is inside the accepted model (ADR 002 §8.4 and §5's residual-risk paragraph: whoever
      reads the mail within 7 days can consume the invite and become a member; the member list
      15.4 and epoch-rotating removal 20.2 are the controls) and it is not a key: „what they
      cannot do is read anything from the email alone" is unchanged.
- [ ] Vercel project created, **Root Directory `server`**, region `fra1`
- [ ] Prisma Postgres created in `eu-central-1`
- [ ] `DATABASE_URL` set in Vercel **Production**, carrying `connection_limit=1`
- [ ] ⛔ **`server/prisma/migrations/` generated and committed** (`RUNBOOK.md` §2.4). It does not
      exist. Without it the first deploy creates no tables and every query fails.
- [ ] Preview environment: either its own `DATABASE_URL` **and** `LZP_PREVIEW_DB_IS_ISOLATED=true`,
      or neither. Never the flag alone.
- [ ] First smoke test passed (`RUNBOOK.md` §2.5) — record what came back:
      region `.........` · `Cache-Control: no-store` ☐ · `X-LZP-Protocol` ☐ · HSTS ☐ ·
      **no** `Access-Control-Allow-Origin` ☐
- [ ] One authenticated request returned 200 — this settles `U-RAWBODY`, the claim whose failure
      is a total outage
- [x] `LZP_CONTRACT_DATABASE_URL=… npm run test:server` run against a real Postgres —
      **done 2026-09-03 against PostgreSQL 17.10: 66 of 66 contract cases, 1069 rows, 0 fail, 0
      skip.** `U-SEQ` and `U-TX` were checked with two concurrent clients and both were WRONG as
      written: no retry existed anywhere for a `Serializable` abort, and every transaction body
      issued its queries on the outer client. Both are fixed (`server/adapters/prisma.js`).
- [ ] ⛔ **Re-run §2.5.1 against the DEPLOYED database, not a local cluster.** Frankfurt is Prisma
      Postgres behind the platform pooler; a transaction-mode pooler can refuse an interactive
      `$transaction` or silently downgrade `Serializable`, and every atomicity guarantee rests on
      getting one. This is residual R8-R1 and it is the one that matters.
- [ ] **Bind a production `feedbackSink`** — `server/adapters/vercel.js#buildCtx` binds none, so
      `POST /api/v1/feedback` answers **501 not_implemented** on the deployed relay. Honest, and
      not a send: „Rückmeldung senden" is bound in the app (`family/mount.js#bindFeedback`) and
      works end to end against `server/dev-server.mjs`, so the only missing half is a destination.
      → where reports go: ....................................
- [ ] The first CI-built DMG **looked at by a human**: is the Finder layout styled, or did it ship
      without a `.DS_Store`? Nobody has ever seen it (`E1-VERIFICATION.md` §3, LZP-107).
      Still true, and it cannot be answered here: Finder automation is refused on the dev machine
      (`-1743`, reproduced), so **no locally built DMG carries a `.DS_Store`** and the window opens
      unstyled. CI can drive Finder — `release.yml`'s `.DS_Store` gate proves it, and
      `dmg-add-readme.sh` warns loudly if it ever cannot.
- [x] ~~Decide whether `Bitte zuerst lesen.html` goes on the disk image~~ — **decided and landed
      2026-09-04. It does.** `invitation-email.md` §8.2 option (a). Measured before the fix, on a
      real artifact: the DMG root held three entries and the 19 427-byte page the build produced
      was thrown away. It is now staged by `scripts/make-dmg.sh` (verification path) and injected
      by `.github/scripts/dmg-add-readme.sh` (production), gated in `release.yml` step 10, and
      held in agreement by `.github/scripts/check-dmg-readme.mjs` (7 rows) and
      `tests/tier1/dmg-contents.test.js` (19 rows). Verified on the built image: root = 4 entries,
      page sha256 identical to source. **Nothing to do here at release time — but if the gate ever
      fires, do not ship around it.**

---

## B · Every release — before you tag

- [ ] Working tree clean, on the branch you mean to ship
- [ ] `package.json` version bumped → `.................`
- [ ] `src-tauri/Cargo.toml` version bumped to **the same value**
      (`tauri.conf.json` reads `"version": "../package.json"` and physically cannot disagree)
- [ ] `node .github/scripts/check-release-config.mjs --tag vX.Y.Z` → exit 0
- [ ] `node .github/scripts/check-server-config.mjs` → exit 0
- [ ] `node .github/scripts/check-email-copy.mjs` → exit 0
- [ ] `node .github/scripts/check-dmg-geometry.mjs` → exit 0
- [ ] `node .github/scripts/check-dmg-readme.mjs` → exit 0 — the unlock page is produced, staged on
      **both** DMG paths, gated in `release.yml`, and its icon clears the app's and the
      Applications folder's. Runs before the build in CI so a naming or layout mistake costs
      seconds rather than a 40-minute universal Rust build.
- [ ] `node .github/scripts/check-ci-triggers.mjs` → exit 0
- [ ] `node scripts/mom-test-probe.mjs` → exit 0.
      **Red today, and it is supposed to be.** Row `M2s` fails while the four invitations still
      carry the reserved `.invalid` slot, so *green means somebody claimed a host and substituted
      it* — the inverse of what this row used to mean, when it hardcoded and asserted the
      placeholder and a green probe meant "nobody has done the work yet" (AUDIT F13). A
      **solo-only** release may ship with this red: write `solo` in the box, and leave §A's two
      ⛔ relay items unticked. A **family** release may not.  → .............
- [ ] Suites green:
      `npm test` ......... · `npm run test:attack` ......... · `npm run test:server` ......... ·
      `npm run test:fleet` ......... · `npm run test:property` ......... · `npm run test:dom` .........
      Inside `npm test`, **`tests/tier1/release-gate.test.js` is the row that fails on a
      half-done relay substitution** (§A's first ⛔). It reads `SYNC_ORIGIN_BUILTIN` out of both
      shells and the address out of all four invitation files and refuses every state except the
      two coherent ones — everything unset, or everything set to one https origin.
- [ ] **Zero npm dependencies at the repository root.** `package.json` declares no
      `dependencies`; the only `devDependency` is `@tauri-apps/cli`; there is no `node_modules`.
      Prisma belongs to `server/package.json` and to nowhere else.
- [ ] `server/package-lock.json` committed and current — Vercel's `installCommand` is `npm ci`,
      which fails outright without it
- [ ] **`src-tauri/Cargo.lock` committed and current.** It did not exist until 2026-09-04,
      because nothing had ever run `cargo`. CI's `shell-rust` job passes `--locked`, so a stale
      or missing lock fails there with *"the lock file needs to be updated"* — the fix is
      `cargo check --manifest-path src-tauri/Cargo.toml` and commit the result, **never**
      dropping `--locked`. This is the zero-dependency discipline the root `package.json` already
      keeps, applied to the half of the product that has 400-odd transitive Rust crates: without
      a lock every release resolves versions afresh, which is how "it compiled last month"
      becomes a tag nobody can reproduce.
- [ ] **`npm test` still green after any `src-tauri/` edit.** `tests/helpers/helper-hygiene.js`
      reads `lib.rs` as TEXT (`SHELL_RUST`) to hold the two shells to the same refusal
      vocabulary. That gate is worth keeping and it is not a compiler: it cannot see a type
      error, and it did not see the `Cargo.toml` ↔ `tauri.conf.json` feature mismatch that made
      the crate unbuildable. Text gate and `shell-rust` are complements, not substitutes.
- [ ] Any new migration is **new**: `server/prisma/migrations/` has no modified, deleted or renamed
      entry. `server.yml` diffs this and refuses, because the new deployment is served with the old
      one already torn down.
- [ ] If the schema changed: **the previous code still works against the new schema.** A rollback
      rolls the code back and leaves the migration forward. If that is not true, write the plan
      down before you tag (`RELEASE.md` §6.4).
- [ ] CHANGELOG / release note written for a family, not for a repository

---

## C · The dry run — before any release that reaches Mom

Skipping this is defensible for a fix only you will install. It is not defensible for anything
that lands on a Mac you do not own.

- [ ] Prerelease tag pushed: `vX.Y.Z-rc.1`
- [ ] `releases/latest/download/latest.json` still resolves to the **old** release — a prerelease
      is not `latest`, which is what makes this safe
- [ ] The prerelease DMG downloaded and installed by hand on one Mac
- [ ] The app launches, the board draws, no console errors
- [ ] **Quit and reopen once.** The real relaunch after an update has never been performed by
      anybody — `relaunchSelf()` is refused in headless runs, so no suite can reach it
      (`E1-VERIFICATION.md` §3, LZP-103)
- [ ] Existing data intact after the swap: entries, categories, settings, family membership

---

## D · Cutting it

```bash
git commit -am "Release X.Y.Z"
git push
git tag vX.Y.Z
git push origin vX.Y.Z
gh run watch
```

Expect 25–40 minutes cold; the Rust build dominates.

- [ ] All eleven gates in `release.yml` passed (`RELEASE.md` §1 lists them in order)
- [ ] The DMG size gate: warn at 14.7 MB, fail at 20 MiB → actual: ................
- [ ] **`latest.json` lists `darwin-universal` by name.** All three clients look up exactly that
      key; a manifest listing only the two per-arch keys makes every Mac report
      `unsupported-platform` for ever while CI stays green. This was a real defect (§2.1 of
      `E1-VERIFICATION.md`) and the gate now asserts the key by name.
- [ ] **The minimum-version key is spelled `minimum_version`.** Not `minClientVersion`, which
      parses as `null` and silently disables the whole 22.7 mechanism (§2.2 of the same file).
- [ ] The published `latest.json` resolves over HTTPS from outside CI
- [ ] The signature was verified by CI before the manifest was generated — and if the run warned
      that the signature is **prehashed (`ED`)**, note it: Tauri handles it, the Swift reference
      shell refuses it loudly, and that is a decision to take rather than a warning to scroll past.
      → prehashed? ☐ yes ☐ no

---

## E · The server, which has no tag to watch

- [ ] Vercel shows a **Production** deployment from the commit you just pushed
- [ ] The build log shows `prisma migrate deploy` **ran** (production) — or shows the deliberate
      skip line if this was a preview
- [ ] `server.yml`'s `smoke` job green
- [ ] `curl -si https://<prod>/api/v1/meta` → `fra1`, the protocol window your clients know,
      `no-store`, `X-LZP-Protocol`, HSTS, **no CORS header**
- [ ] One real client pushed and pulled successfully after the deploy

---

## F · After

- [ ] One Mac updated itself without being touched — that is 22.3 and 22.5, and it is the whole
      point of the channel
- [ ] The quiet hint appeared as a hint: app menu and settings, **no modal** (22.4)
- [ ] The family was told nothing, because they did not need to be
- [ ] If anything in §A–§E was ticked while untrue, say so in the release note. A checklist that
      is ticked optimistically is worse than no checklist, because the next person reads it as
      evidence.

---

## G · The things this checklist deliberately does not claim

Ticking every box above does **not** mean these are done. They are named here so a green sheet
cannot be mistaken for a finished product.

| still open | where |
|---|---|
| **the Rust shell has never been RUN.** As of 2026-09-04 it compiles, links and produces a binary, and its origin validator was executed against the full 28-value SSRF table (below). But no `sync_request` has ever crossed a real socket from `lib.rs`, no window has ever opened from it, and `keychain_set`/`keychain_get` have never touched a real Keychain. Every end-to-end measurement in this project — `SHELL-VERIFICATION.md`, the 5-instance family run, `npm run test:dom` — was taken on **`shell-macos/main.swift`**, which is not what `release.yml` ships. | §A · this file |
| **the Rust shell has no headless mode, so no existing harness can drive it.** `shell-macos/main.swift:887` reads `LZP_SYNC_ORIGIN` when `isHeadless`, which is how `scripts/shell-ssrf.mjs` drives 28 origins and how `npm run test:dom` reaches a relay at all. `lib.rs:794 sync_origin_setting()` deliberately has no such hook (*"there is no headless override here because there is no headless mode"*). The consequence is not a defect but it is a cost: **the production shell cannot be pointed at a test relay by any means that exists today**, so tier 2 can never run against it. | `lib.rs:794` · `main.swift:887` |
| **`cargo tauri build` has never run** — the universal (x86_64 + arm64) binary, the bundler, the `.app`, the DMG, and the `createUpdaterArtifacts` signing path. `cargo check` and `cargo build` were run for the host arch only; the x86_64 half has never been compiled by anybody, and `scripts/make-dmg.sh` packages the **Swift** shell, not this one | §D · `E1-VERIFICATION.md` §3 |
| **the 28-row SSRF table never exercises the IPv6-literal rule.** Measured 2026-09-04 by mutation: delete `if h.contains(':')` from `is_private_or_local_sync_host` and **all 28 rows still pass**, because `[::1]` is caught by the loopback rule and `[fd00::1]`/`[fe80::1]` by the single-label rule. The rule is still load-bearing — without it `https://[::ffff:1.2.3.4]` is ACCEPTED as a public relay — the table simply never reaches it. Both shells share the shape, so it is a gap in the table, not a divergence. Add a dotted IPv6 literal to `TABLE` in `scripts/shell-ssrf.mjs` to close it | `scripts/shell-ssrf.mjs` |
| **the Familienkreis syncs at all.** `SYNC_ORIGIN_BUILTIN` is `""` in both shells until §A's first ⛔ is done, so every `sync_request` is refused locally. A solo release is unaffected and complete | §A · AUDIT F1 |
| **LZP-1006, the Mom test** — a real person, on a clean Mac, unassisted | `docs/v2/MOM-TEST.md` §0, §9 |
| `gatekeeper_status` is implemented in neither shell, so the guided unlock screen's **automatic** path is dark (`firstrun.js:37,117`). Re-read that alongside the row below: it means the in-app screen never presents itself unasked, and therefore **the page on the DMG is not a second surface, it is the only one** that reaches a blocked reader without her going looking for it | `E1-VERIFICATION.md` §4 |
| the DMG's Finder layout has never been seen | `E1-VERIFICATION.md` §3 |
| **the Gatekeeper dialog a stranger actually sees is unverified.** Measured 2026-09-04: the shipped bundle is ad-hoc signed, `codesign --verify` says *valid on disk · satisfies its Designated Requirement*, `spctl --assess --type execute` says **rejected** (rc=3), and `syspolicy_check distribution` says *Adhoc Signed App — Warning* plus *Notary Ticket Missing — Fatal*. What could **not** be measured is the wording. A quarantined copy — including one with a CDHash this Mac had never seen — **launched** here, translocated and with no prompt; `spctl --status` says `assessments enabled`, so that is not Gatekeeper being off, it is the responsible process (Claude Code) plausibly holding the **Developer Tools** TCC exemption, and `TCC.db` is SIP-protected so it could not be confirmed. Consequence: nobody knows whether she meets „Apple konnte nicht überprüfen…“ or „ist beschädigt und kann nicht geöffnet werden“. The unlock copy names **both** (`i18n.js#unlockNote`, both languages) because one sentence is cheaper than her using the Papierkorb button. **Step §5.6 of `SHIP.md` — download the release yourself onto a Mac that has never seen this app — is the measurement that settles it** | `SHIP.md` §3, §6 |
| **the ordering trap is real and is now only prevented by COPY.** Quarantine rides on the `.dmg` file: nothing on a mounted downloaded image carries `com.apple.quarantine` — not the volume root, not the `.app`, not one file inside the bundle — and the copy is stamped `0283;…` at copy time. So approving the app on the image does not approve the copy in Programme. `unlockLead` names the order in both languages and `tests/tier1/unlock-copy.test.js` §1a/§1b keep it there, but nothing in the product *enforces* it | `SHIP.md` §3 |
| ~~the 21.3 Datenschutz section is not in the product~~ — **CLOSED, and the parenthesis was false when written** (AUDIT F12, 2026-09-04). `Frankfurt`, `Vercel` and `Prisma` are all in `src/js/settings.js`, in both languages; `E10-VERIFICATION.md:491` said the opposite in the same file. The section ships and its sentences are held to the live server enums by `tests/server/datenschutz-claims.test.js`. | LZP-1001 |
| the epoch ladder and the poisoned rung are **priced, not closed** | `RUNBOOK.md` §5 |
| `RateBucket` rows carrying IP addresses are never swept | `RUNBOOK.md` §7.2 |
| D1 is reversible for 99 €/yr, 3 secrets and 4 variables, and **no code change** | `RELEASE.md` §8 |
