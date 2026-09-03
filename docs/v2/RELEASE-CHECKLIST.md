# Release checklist

| | |
|---|---|
| **Part of** | LZP-1008 (ops runbook) |
| **Companion to** | `docs/v2/RELEASE.md` — the *how* and the *why*. This is the *what, in order*. |
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
- [ ] **`workflow_dispatch` run completed green before any real tag** — `src-tauri/` has never been
      compiled; nobody knows whether the Rust half builds
- [ ] ⛔ **The relay address in the four invitation files is the REAL one.**
      `docs/v2/email/invitation.{de,en}.{txt,html}` each carry a `SERVERADRESSE` / `SERVER ADDRESS`
      line with the literal `https://lzp-sync-po.vercel.app` on it, alone, unpunctuated. That host
      is the project's own placeholder name and **no such app exists yet** — a `*.vercel.app`
      project name is claimable by anyone until the PO claims it. It is a literal and not a
      `{{…}}` placeholder because `scripts/mom-test-probe.mjs`'s `FILL` substitutes only
      `NAME`/`RELEASE_URL`/`EINLADUNGSCODE`/`ABSENDER`, and probe row `M2` asserts the parsed
      origin equals that exact string. Substitute it before the mail is sent; both HTML files
      carry the `sed` in their head comment. → real origin: ...................................
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
      without a `.DS_Store`? Nobody has ever seen it (`E1-VERIFICATION.md` §3, LZP-107)
- [ ] Decide whether `Bitte zuerst lesen.html` goes on the disk image
      (`docs/v2/invitation-email.md` §8.2). Under D1 it is one of only two surfaces that can reach
      a person *before* macOS refuses the app. → decision: ..........................................

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
- [ ] `node scripts/mom-test-probe.mjs` → exit 0 *(fails today: `MOM-TEST.md` §2.3)*
- [ ] Suites green:
      `npm test` ......... · `npm run test:attack` ......... · `npm run test:server` ......... ·
      `npm run test:fleet` ......... · `npm run test:property` ......... · `npm run test:dom` .........
- [ ] **Zero npm dependencies at the repository root.** `package.json` declares no
      `dependencies`; the only `devDependency` is `@tauri-apps/cli`; there is no `node_modules`.
      Prisma belongs to `server/package.json` and to nowhere else.
- [ ] `server/package-lock.json` committed and current — Vercel's `installCommand` is `npm ci`,
      which fails outright without it
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
| **LZP-1006, the Mom test** — a real person, on a clean Mac, unassisted | `docs/v2/MOM-TEST.md` §0, §9 |
| `gatekeeper_status` is implemented in neither shell, so the guided unlock screen never fires | `E1-VERIFICATION.md` §4 |
| the DMG's Finder layout has never been seen | `E1-VERIFICATION.md` §3 |
| the 21.3 Datenschutz section is not in the product (`Frankfurt`, `Vercel`, `Prisma` appear nowhere in `src/`) | LZP-1001 |
| the epoch ladder and the poisoned rung are **priced, not closed** | `RUNBOOK.md` §5 |
| `RateBucket` rows carrying IP addresses are never swept | `RUNBOOK.md` §7.2 |
| D1 is reversible for 99 €/yr, 3 secrets and 4 variables, and **no code change** | `RELEASE.md` §8 |
