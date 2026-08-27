# Release runbook — LangzeitPlaner v2

| | |
|---|---|
| **Tickets** | LZP-101 (release workflow), LZP-109 (server auto-deploy) |
| **Stories** | 22.1, 22.5, 22.6, 22.7, 22.8 · amendment A11 · decisions D1, D2, D3 |
| **Date** | 2026-08-27 |
| **Audience** | the PO. Everything here is something you do, not something the team does. |

> **Status of this document.** The pipeline it describes has never been executed. There is no
> GitHub remote yet, no Vercel account, no Prisma database and no Rust toolchain on the machine
> it was written on. Every claim below is either **verified locally** (and says so) or
> **unverified** (and says so). §11 is the honest list of what will be discovered on the first
> real run.

---

## 1. What one `git tag` actually does

```
git push origin v2.0.1
        │
        ├─► .github/workflows/release.yml
        │     1  updater signing key present?              ── fails in ~5 s if not
        │     2  CI: tier 1 · property · attack · tier 2   ── a red suite never ships
        │     3  updater endpoint ← this repository
        │     4  pre-flight: tag = package.json = Cargo.toml, real pubkey, zero deps
        │     5  cargo tauri build --target universal-apple-darwin
        │     6  the .app carries a code signature          ── or it dies on Apple silicon
        │     7  the DMG mounts and holds LangzeitPlaner.app
        │     8  DMG size budget                            ── warn 14.7 MB · fail 20 MiB
        │     9  latest.json, generated only from a VERIFIED signature
        │    10  gh release create — DMG + .app.tar.gz + .sig + latest.json + SHA256SUMS
        │    11  the published latest.json resolves over HTTPS
        │
        └─► Vercel's GitHub integration (not a workflow — see §7)
              push to main → production deploy in Frankfurt, prisma migrate deploy in the build
                            │
                            └─► .github/workflows/server.yml `smoke`
                                  /api/v1/meta answers, from fra1, at a protocol clients know
```

Every installed copy then finds the new release by itself (22.3, 22.5). Nobody downloads
anything twice. The Schulferien datasets ride inside the app bundle, so story 7.4's "refresh"
*is* this channel — amendment A11, and there is deliberately no separate data download.

---

## 2. One-time setup

You have none of this yet. Do it in order; each step is a prerequisite of the next.

### 2.1 The GitHub repository

```bash
cd "…/Calendar – Langzeitplaner"
gh repo create langzeitplaner --private --source=. --remote=origin
git push -u origin main
```

Private is the right default: the repo will hold the family's server code and, in `docs/`, a
fairly complete description of how their data is protected. Nothing in the pipeline needs it to
be public — GitHub Releases assets on a private repo are reachable by anyone with the URL only
if the release is public, so **see §2.5 before emailing Mom a link.**

Then, in *Settings → Branches*, protect `main`: require the CI check, and require a pull request.
This matters more than it looks. **Anyone who can push a tag can install code on Mom's Mac**,
because the updater will trust it. Tag pushes are the highest-privilege action in this project.

### 2.2 The updater key

See §5. Do it now — the release workflow refuses to start without it.

### 2.3 Repository secrets and variables

*Settings → Secrets and variables → Actions.*

**Secrets — required today**

| name | what it is |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | the entire contents of the private key file from `cargo tauri signer generate` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password you gave that key |

`GITHUB_TOKEN` is provided automatically; do not create one.

**Variables — optional**

| name | default | what it does |
|---|---|---|
| `LZP_MIN_CLIENT_VERSION` | `0.0.0` | story 22.7's gate. Set it to force outdated clients to update; see §9. |
| `ENABLE_APPLE_SIGNING` | unset | the D1 flag. See §8. |
| `LZP_ROTATION_VERIFY_PUBKEY` | unset | set for exactly one release during a key rotation; see §5.3. |

That is the whole list for LZP-101. Signing adds more (§8); the server adds none to GitHub
(its configuration lives in Vercel — §7).

### 2.4 Version numbers

Three files carry a version and they must agree. `src-tauri/tauri.conf.json` no longer restates
it — it says `"version": "../package.json"`, so the bundle physically cannot disagree with
`package.json`. That leaves two to keep in step:

```
package.json          "version": "2.0.0"      ← the source of truth
src-tauri/Cargo.toml  version = "2.0.0"
```

The pre-flight (`node .github/scripts/check-release-config.mjs --tag v2.0.0`) checks all of it,
including against the tag. **Run it before you tag**, not after.

### 2.5 Before the first email to Mom

The invitation email (deliverable 28) carries the DMG as an attachment *and* a GitHub Releases
link as fallback for providers that strip DMGs (22.1). A link into a **private** repository asks
her to sign in to GitHub, which is exactly the kind of wall this whole epic exists to avoid.
Two workable answers, both fine, pick one deliberately:

- make the repository public (the code is not the secret; the keys are, and they are not in it), or
- keep it private and make the email's fallback a link you generate yourself — a file you upload
  somewhere she can reach without an account.

Decide this before the email is designed, not after she has hit the login page.

---

## 3. Cutting a release

```bash
# 1. bump both version numbers
node -e 'const f="package.json",fs=require("fs"),p=JSON.parse(fs.readFileSync(f));p.version="2.0.1";fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")'
sed -i "" 's/^version = ".*"$/version = "2.0.1"/' src-tauri/Cargo.toml

# 2. check before you commit
node .github/scripts/check-release-config.mjs --tag v2.0.1

# 3. commit, push, tag the pushed commit
git commit -am "Release 2.0.1"
git push
git tag v2.0.1
git push origin v2.0.1
```

Watch it with `gh run watch`. Expect roughly 25–40 minutes cold (the Rust build dominates;
`cargo install tauri-cli` adds ~6 minutes the first time and is cached afterwards).

### Rehearsing

Two ways to build without moving the fleet:

- **`workflow_dispatch`** — *Actions → Release → Run workflow*. Builds, runs every gate, uploads
  the DMG and manifest to the workflow run, and publishes **nothing**. This is how you check the
  size budget after a change that might have added weight.
- **A prerelease tag** — `v2.1.0-rc.1`. Publishes a real GitHub Release marked prerelease.
  `releases/latest/download/latest.json` does **not** resolve to a prerelease, so no installed app
  is offered it; you download it yourself and install it on one Mac. This is the shape of a real
  dry run, and it is what you should do before any release that reaches Mom.

---

## 4. The DMG size budget (story 22.1)

**Why ≈15 MB is a real number and not a vibe.** Mail providers cap the *encoded* attachment, and
base64 inflates a binary by 4/3 plus line breaks — about ×1.36:

| provider | cap | that is this much DMG |
|---|---|---|
| GMX · Web.de · T-Online | 20 MB | **14.7 MB** |
| Gmail · iCloud · Outlook | 25 MB | 18.4 MB |

So the gate has two thresholds:

| | bytes | what happens |
|---|---|---|
| green | ≤ 14 700 000 | fits every German consumer mailbox; the attachment path in 22.1 is honest |
| warn | 14.7 MB – 20 MiB | still ships. The invitation email must lead with the download link, not the attachment |
| **fail** | > 20 971 520 | the build stops. Past here "one email attachment and one drag" is simply untrue |

**What the DMG is expected to weigh.** Measured on this machine:

| part | size | how |
|---|---|---|
| web payload (`index.html` + `src/`) | **773 KiB**, 37 files | `node scripts/build-frontend.mjs` |
| app icon (`.icns` from the 1024 px source) | **828 KiB** | the Swift shell's build |
| whole hand-built Swift shell `.app` | **1.82 MiB** | `shell-macos/build.sh` |

The Rust binary is the part nobody here can measure — there is no cargo on this machine. A
Tauri 2 macOS release binary built with this project's profile (`opt-level = "s"`, `lto = true`,
`strip = true`, `panic = "abort"`) is typically 6–10 MB per architecture; `lipo`-ed into a
universal binary that is roughly 13–20 MB, and the DMG's zlib compression usually halves Mach-O.
**Expected DMG ≈ 8–13 MB** — inside the green band, with the spec's ≈15 MB as the ceiling it was
always aiming at. *This estimate is unverified.* The first `workflow_dispatch` run replaces it
with a fact; put that fact in this table when you have it.

**A trap that was closed on the way here.** `tauri.conf.json` used to say
`"frontendDist": "../"` — *ship the repository*. That would have copied `.git` (3.3 MB of
history), `tests/` (2.1 MB), `docs/` and `src-tauri/target/` into the app bundle: several times
the budget, and the project's entire history sitting on a family member's laptop. It now points
at `../dist`, assembled by `scripts/build-frontend.mjs` from an **allowlist** — `index.html` and
`src/`, nothing else. A denylist would have shipped whatever nobody remembered to exclude.

**If the gate ever fires**, look in this order: the icon set (an `.icns` with every size is
easily a megabyte), then anything new under `src/`, then Tauri feature flags in `Cargo.toml`,
then whether `strip` and `lto` are still on in the release profile.

---

## 5. The updater key

This key is the reason an app that arrives as an email attachment is not a security disaster.
Every installed copy verifies each update against the public half baked into it; an update signed
with anything else is refused (22.6). **Whoever holds the private key can install software on
every family Mac.**

### 5.1 Generating it

```bash
cargo install tauri-cli --version "^2" --locked     # if you do not have it
cargo tauri signer generate -w ~/.langzeitplaner-updater.key
```

It prints a password prompt and then two things: the private key file at that path, and the
**public key** on stdout.

1. Paste the **public** key into `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`,
   replacing the `REPLACE_ME__…` placeholder. Commit it. It is public; that is the point.
2. Put the **contents** of `~/.langzeitplaner-updater.key` into the repository secret
   `TAURI_SIGNING_PRIVATE_KEY` (`gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.langzeitplaner-updater.key`).
3. Put the password into `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
4. Keep the key file somewhere you will still have it in three years, offline, and not only in
   GitHub. §5.4 explains why losing it is expensive.

Never commit the private key. `.gitignore` does not currently name it, because it does not
belong in this directory at all.

### 5.2 What stops an unsigned update

Three things, in descending order of how much they can be argued away:

1. `.github/scripts/make-update-manifest.mjs` has **no code path** that produces a manifest entry
   without a verified signature. It reads the `.sig`, verifies it, and only then holds a value for
   the `signature` field. Remove the verification and the generator crashes — the failure mode is
   a broken build, not a quiet hole.
2. It verifies against the public key **embedded in the app that was just built**, not against
   whatever key happened to sign. A mismatch means the build would ship an app that rejects every
   future update it is ever offered — a fleet nobody can reach again, normally discovered months
   later. Here it is a failed job with the two key ids printed.
3. The workflow refuses to start at all without `TAURI_SIGNING_PRIVATE_KEY`.

The verifier (`.github/scripts/minisign.mjs`) is 130 dependency-free lines and has a self-test
(`node .github/scripts/minisign.selftest.mjs`, 14 assertions, green) covering both minisign
signature modes and, importantly, the three ways it must say no: a signature from another key, a
forgery under a copied key id, and a modified artifact.

### 5.3 Rotating the updater key

**Read this before you start; a rotation done in one step strands every device.**

An installed app verifies with the pubkey *it* carries, not the one inside the update. So going
from K1 to K2 takes two releases:

| release | app embeds | signed with | why |
|---|---|---|---|
| N | pub(**K2**) | **K1** | devices still holding pub(K1) must be able to accept it |
| N+1 | pub(K2) | K2 | every device now holds pub(K2) |

Release N is the only time the manifest generator's key check is deliberately pointed elsewhere:

1. Generate K2. Put its **private** half in `TAURI_SIGNING_PRIVATE_KEY`… **no** — for release N,
   leave `TAURI_SIGNING_PRIVATE_KEY` as K1.
2. Put pub(K2) into `tauri.conf.json`. Commit.
3. Set repository variable `LZP_ROTATION_VERIFY_PUBKEY` to **pub(K1)**.
4. Tag and release N. The workflow prints a loud warning that it is verifying against an
   override key.
5. **Delete `LZP_ROTATION_VERIFY_PUBKEY`.** Swap `TAURI_SIGNING_PRIVATE_KEY` (and its password)
   to K2.
6. Release N+1 normally.

Between steps 4 and 6, a Mac that has not run in a while is still on ≤ N−1 and can still update:
release N is signed with K1, which it trusts. It only needs to pass *through* N. Do not delete
release N until every device has been past it — and since you cannot see that (Principle 9: no
telemetry, no presence), do not delete it at all.

### 5.4 If the private key is lost

There is no recovery. Every installed copy trusts only that key, so no new release can reach
them. The fix is manual: build the next version with a new key and send the DMG round by email
again, one person at a time, with the unlock screen for each. That is one bad afternoon, not a
disaster — but it is exactly the afternoon this pipeline exists to prevent, so keep the backup.

---

## 6. Rolling back

### 6.1 The uncomfortable truth first

**The updater will not downgrade.** Tauri compares versions and only ever moves forward. So a
Mac that already installed the bad release cannot be pulled back by anything you do on GitHub.
Deleting the release only affects devices that have *not* updated yet, and people downloading
fresh.

**The real fix is a roll-forward:** revert the commit, bump the patch version, tag, and let the
channel do its job. Do that first; do the steps below in parallel to stop the spread.

### 6.2 The emergency stop (seconds)

```bash
gh release edit v2.0.1 --prerelease
```

`releases/latest/download/latest.json` immediately stops resolving to it, so every device that
has not yet updated stops being offered it. This is faster and less destructive than deleting,
and it is reversible.

### 6.3 Deleting it

```bash
gh release delete v2.0.1 --yes --cleanup-tag
```

`latest` reverts to the previous release, so the email link and fresh downloads get the good
version again. Devices already on 2.0.1 stay there — see §6.1.

### 6.4 Rolling back a schema change

Different problem, worse consequences: the database in Frankfurt is shared and the desktops are
not in step with it. Rules:

- **Never edit an applied migration.** The CI check `No already-applied migration was rewritten`
  fails a PR that modifies or deletes anything under `server/prisma/migrations/`. Correct a bad
  migration with a *new* migration.
- **Never write a destructive migration in the same release as the code that stops using the
  column.** Ship the code first, let the desktops catch up, drop the column a release later.
  The server must speak the current and the previous protocol (ADR 003 §4) and a dropped column
  breaks the previous one.
- A migration that drops a table or column is flagged by the deploy pre-flight as needing a
  written rollback plan. Write one.

---

## 7. The sync server (LZP-109)

### 7.1 What deploys it — and what does not

Vercel's own GitHub integration is the deployer. Push to `main` becomes the production
deployment; every branch and pull request gets a preview; `prisma migrate deploy` runs inside the
Vercel build. This is decision D3's reading of "GitHub sync" and the standard Vercel workflow.
`.github/workflows/server.yml` deliberately does **not** deploy — re-implementing it with a
deploy token would put a long-lived credential in this repository for no gain. That workflow is
the guard rail on both sides: config and suite before, smoke test after.

### 7.2 Connecting Vercel (one time)

1. Vercel → *Add New → Project* → import the GitHub repo.
2. **Root Directory: `server`.** This is the important one. It makes `server/vercel.json` the
   project config and keeps the desktop app out of the deployment entirely.
3. Framework preset: *Other*. Leave install/build commands alone — `server/vercel.json` sets
   them.
4. Region: `server/vercel.json` pins `fra1` (Frankfurt). Confirm the project's default region
   agrees; the deploy pre-flight fails on any other value, because the Datenschutz text (21.3)
   tells the family their data is in Frankfurt and that sentence has to stay true.
5. Prisma Postgres: create the database in **`eu-central-1`**. Vercel spells that datacentre
   `fra1` and Prisma spells it `eu-central-1`; both are Frankfurt and neither name is a typo.

### 7.3 Environment variables (in Vercel, not GitHub)

| name | environment | value |
|---|---|---|
| `DATABASE_URL` | Production | the Prisma Postgres pooled connection string |
| `DATABASE_URL` | Preview | **a different database.** See below. |
| `LZP_PREVIEW_DB_IS_ISOLATED` | Preview | `true`, *only* once Preview really has its own database |

**Why that last one exists.** `prisma migrate deploy` in a preview build, pointed at the
production `DATABASE_URL`, migrates production from a feature branch. So the build command runs
migrations only when `VERCEL_ENV=production`, or when you have explicitly declared that the
preview database is a separate one. The default is the safe, slightly annoying behaviour:
previews skip migrations and say so in the build log. Give Preview its own database and set the
flag — schema changes are exactly what previews are for.

### 7.4 What E2 (WP-7) owes this pipeline

`server/` currently contains one file: `vercel.json`. Everything below must appear for the deploy
to work, and `node .github/scripts/check-server-config.mjs` lists them as *owed* until they do —
at which point the same checks become binding.

| path | why the pipeline needs it |
|---|---|
| `server/package.json` | Vercel's `installCommand` is `npm ci` |
| `server/package-lock.json` | `npm ci` fails outright without a lockfile. **Commit it.** |
| `server/prisma/schema.prisma` | `prisma generate` and `prisma migrate deploy` need a schema; its `url` must be `env("DATABASE_URL")` |
| `server/prisma/migrations/` | append-only from the first deploy onward |
| `server/api/**` | the function entry points `vercel.json`'s `functions` glob (maxDuration 10 s, 1024 MB) refers to |
| `tests/server/*.test.js` | the pre-deploy gate; the workflow runs it the moment the directory exists |
| `GET /api/v1/meta` | the smoke test reads `{ region, minProto, maxProto, serverTime }` from it and asserts Frankfurt, the N−1 protocol window, and that nothing family-shaped leaks from an unauthenticated endpoint |

Two boundaries E2 must not cross:

- **`server/package.json` may have dependencies; the root `package.json` may not.** Prisma is
  unavoidable server-side and irrelevant to the desktop app. The pre-flight fails if Prisma is
  ever mentioned in the root manifest.
- **No CORS headers on `/api`.** The client is a desktop app, not a browser origin. An
  `Access-Control-Allow-Origin` header can only ever help a web page that should not be talking
  to this server (21.5). The pre-flight fails on one.

---

## 8. Turning Apple signing on (reversing D1)

D1 said no to a 99 €/yr fee, not no to signing. Reversing it must therefore cost a subscription
and ten minutes, not an engineering day. **No file in this repository changes.**

1. Buy the Apple Developer Program membership. Create a *Developer ID Application* certificate
   and export it as `.p12`.
2. Create an App Store Connect API key (*Users and Access → Integrations*) with the Developer
   role. Download the `.p8` once — it is not offered twice.
3. Add these, then set the flag:

| name | kind | value |
|---|---|---|
| `APPLE_CERTIFICATE` | secret | `base64 -i cert.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | secret | the `.p12` export password |
| `APPLE_API_KEY_P8` | secret | the contents of `AuthKey_XXXX.p8` |
| `APPLE_SIGNING_IDENTITY` | variable | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_API_KEY_ID` | variable | the key id (the `XXXX` above) |
| `APPLE_API_ISSUER` | variable | the issuer UUID from the same page |
| `ENABLE_APPLE_SIGNING` | variable | `true` — this is the switch |

> **The brief said "a cert and two GitHub secrets". That undercounts.** It is three secrets and
> four variables, because notarization needs its own credential set on top of the signing
> certificate. The promise that holds is the one that matters: **no code change.** Every signing
> step in `release.yml` is already written and already gated on `ENABLE_APPLE_SIGNING`.

Afterwards: keep LZP-106's guided unlock screen in the product. It costs nothing, and it is the
fallback the day a certificate expires — which, unlike everything else here, is a certainty.

---

## 9. Forcing an update (story 22.7)

`latest.json` carries `minimum_version`, from the repository variable `LZP_MIN_CLIENT_VERSION`
(default `0.0.0` = no gate). **Corrected during E1 integration:** the generator used to write this
field as `minClientVersion`, which no client reads — `src/js/platform/updater.js` accepts
`minimum_version` or `minimumVersion` and nothing else, so 22.7's gate was silently dead. The CLI
flag and the repository variable keep their names; only the JSON key changed. See
`docs/v2/E1-VERIFICATION.md` § "Three integration defects". Set it when a server protocol change makes older clients unable to
sync, and LZP-104's plain-language screen appears on those clients instead of a silent failure.
The server's `426 Upgrade Required` (ADR 003 §4) is the backstop, not the primary gate — the
updater should have moved the device before it ever asks.

Raise it in the same release that raises the protocol, and never retroactively: a device that
cannot reach the network cannot update, and 19.1 does not bend for a protocol bump. It must keep
working fully offline while it says so.

---

## 10. Quick reference

```bash
# before tagging
node .github/scripts/check-release-config.mjs --tag v2.0.1

# what the app will actually ship
node scripts/build-frontend.mjs && du -sh dist

# the signature verifier's own tests
node .github/scripts/minisign.selftest.mjs

# rebuild every release image from its SVG source, and check it lines up
./scripts/build-release-assets.sh
node .github/scripts/check-dmg-geometry.mjs
node .github/scripts/check-email-copy.mjs

# look at the actual DMG window, without Rust and without CI
./shell-macos/build.sh --dest /tmp/lzp && ./scripts/make-dmg.sh /tmp/lzp/LangzeitPlaner.app
open build/dmg/LangzeitPlaner.dmg

# is the server side of the pipeline satisfied?
node .github/scripts/check-server-config.mjs

# watch a release
gh run watch

# emergency stop
gh release edit v2.0.1 --prerelease
```

---

## 11. Known unknowns

Nothing below was executed. It is listed so the first real run is a checklist rather than a
surprise.

| # | what is unverified | how it will show up | what to do |
|---|---|---|---|
| 1 | **The whole Tauri build.** No Rust on the authoring machine; `src-tauri/` has never been compiled. | anything | run `workflow_dispatch` before any tag |
| 2 | **`"version": "../package.json"`** — documented Tauri 2 behaviour, never exercised here. | the DMG carries the wrong version, or the build rejects the config | fall back to restating the number, and re-enable the equality check in `check-release-config.mjs` |
| 3 | **`APPLE_SIGNING_IDENTITY=-` producing an ad-hoc signature.** `lipo` strips signatures while fusing the slices, and Apple silicon refuses to run an unsigned binary — so this is not cosmetic. | step *"The .app carries a code signature"* fails | sign the bundle explicitly with `codesign --force --deep --sign -` and rebuild the DMG with `hdiutil`, as `shell-macos/build.sh` already does |
| 4 | **The exact `.sig` layout Tauri emits.** The verifier handles both minisign modes and unwraps Tauri's outer base64, and is tested against synthetic vectors — not against a real `tauri signer` artifact. | step *"Generate and verify latest.json"* fails on a real signature | read the printed reason; the parser says which field disagreed |
| 5 | **`minimum_version` as an extra top-level field in `latest.json`.** Tauri's updater should ignore unknown fields. (Renamed from `minClientVersion` during E1 integration — the old spelling matched no client.) | the updater errors parsing the manifest | move it into `notes`, or serve it from a second file |
| 6 | **Tier 2 on a hosted runner.** `run-dom-tests.sh` drives a real WKWebView; a hosted macOS runner may not give it a usable window server. | the `dom` job fails for environmental reasons | `continue-on-error: true` on that job — one line — and note it here |
| 7 | **`createUpdaterArtifacts` and the updater plugin.** `tauri-plugin-updater` is in `Cargo.toml` and registered in `lib.rs`. `capabilities/default.json` still has no `updater:default` permission, and **E1 integration concluded it does not need one**: nothing in the WebView calls a plugin command — the plugin is driven only from Rust, inside custom `#[tauri::command]`s, and capabilities gate the JS→Rust boundary, not Rust→plugin calls. UNVERIFIED (no cargo): if a real build denies the call at runtime, adding `"updater:default"` is the one-line fix. | no `.app.tar.gz` (step *"Locate build output"* fails), or an app that builds and then refuses its own update call | add `"updater:default"` to the capability |
| 8 | **Every Vercel and Prisma claim in §7.** No account exists. | the first deploy | §7.4 is the checklist |
| 9 | **The DMG size estimate in §4.** | the first build | replace the estimate with the measurement, in this file |
| 10 | **Whether Tauri's DMG bundler can drive Finder on a hosted runner.** It styles the image by sending Apple events; that is refused here with `-1743 Not authorized to send Apple events to Finder`, and the bundler still emits a valid but completely **unstyled** DMG without failing. | nothing in the build — which is the problem. The gate added for it (step *"The DMG mounts and contains the app"*) checks for `.background/background.tiff` and a root `.DS_Store` and fails when either is missing. | if it fails on CI, build the DMG with `scripts/make-dmg.sh` on a Mac with a login session and upload that instead |
| 11 | **Whether Finder localises the `/Applications` symlink to *Programme*.** The localisation table itself is verified (`SystemFolderLocalizations/de.lproj` maps `"Applications" => "Programme"`); whether it applies to a symlink inside a DMG could not be tested on an en-US machine. | the folder in the DMG is labelled "Applications" on a German Mac | nothing to fix in code — `background.svg` paints »Programme« into the window and the invitation e-mail names both words |
| 12 | **Whether `bundle.macOS.dmg.background` accepts a `.tiff`.** Tauri copies the file into `.background/` and names it in its AppleScript, so the extension should not matter, but this was not run. | the DMG has no background; gate 10 catches it | point `background` at `dmg/background.png` instead — `build-release-assets.sh` already produces it. The cost is a soft background on Retina, not a broken install |

Verified locally, for contrast: all three workflows parse as YAML; all 30 shell steps pass
`bash -n`; the release path's non-Rust steps (endpoint rewrite → strict pre-flight → artifact
location → size budget → staging → manifest generation and verification → published-manifest
comparison) were run end-to-end against a synthetic signed archive and behaved correctly on both
the happy path and the wrong-key, missing-signature, empty-signature and version-mismatch paths;
`scripts/build-frontend.mjs` produces a 773 KiB payload from an allowlist; the minisign
self-test is 14/14 green.

---

## 12. The DMG window and the invitation e-mail (LZP-107 / LZP-108)

**Nothing image-shaped is committed to this repository.** The sources are
`assets/icon.svg`, `assets/dmg/background.svg`, `assets/dmg/window-back.svg` and
`assets/dmg/window-front.svg`; every PNG, TIFF and `.icns` is generated by

```bash
./scripts/build-release-assets.sh
```

which `release.yml` runs before `cargo tauri build` (it has to: `bundle.icon` and
`bundle.macOS.dmg.background` both point at files that do not exist until it does). The
rasteriser is `scripts/render-svg.swift`, ~120 lines against the SVG decoder macOS 13+ exposes
through `NSImage`. No npm dependency, no image toolchain, and no Rust — so unlike the rest of
the release path, this part is fully verifiable on the dev machine.

Rejected: `qlmanage -t`, which pads every thumbnail to a square and anchors the image at the
top, so its output size depends on the source aspect ratio; and `sips`, which cannot decode SVG
at all. Both were tested, not assumed.

### The geometry is a contract

`assets/dmg/background.svg` paints an arrow and a dashed drop-well at coordinates that only mean
anything if they line up with the icon positions in `tauri.conf.json`. Nothing in the file
formats connects the two, so `node .github/scripts/check-dmg-geometry.mjs` does — it fails when
the window size, the icon centres, the arrow's reach or the e-mail illustration's label anchors
disagree across the four files. It runs on every push, not only on a tag.

To see the window without waiting for CI:

```bash
./shell-macos/build.sh --dest /tmp/lzp
./scripts/make-dmg.sh /tmp/lzp/LangzeitPlaner.app
open build/dmg/LangzeitPlaner.dmg
```

`make-dmg.sh` mirrors what Tauri's bundler does and keeps its constants under the same drift
check. It is **not** the production path; it exists so that claims about the DMG can be
measurements, and as a Rust-free escape hatch.

### The icon had a real defect

`assets/icon-1024.png` — the source `shell-macos/build.sh` used for the `.icns` until now — is
flattened onto **opaque white**. Every icon derived from it renders as a white square: in the
Dock, in Finder, and most visibly in the DMG window this ticket exists to polish. Both build
paths now render from `assets/icon.svg` instead, which keeps the alpha channel. Cost: the
`.icns` grows from 828 KB to 954 KB. The CI job *"Release artwork builds from source"* asserts
`hasAlpha: yes`, because a white square looks exactly like a build that worked.

### The unlock page that should ride on the DMG — built, not placed

`src/js/firstrun.js` (LZP-106) can render its two illustrated unlock steps as one
self-contained HTML file, both languages, no script and no external asset. Its whole point is to
sit on the disk image next to the app: Gatekeeper blocks the app, but it does not block Safari
opening an HTML file, so this is the only thing on the DMG a blocked user can still read.

`./scripts/build-unlock-page.sh` produces it (19 KB) by running `renderUnlockDocument()` in a
real WKWebView through the tier-2 harness, asserting the page is complete and asset-free before
writing it. `build-release-assets.sh` calls it, so it cannot rot.

**Nothing consumes it yet.** `bundle.macOS.dmg` can position exactly two items — `appPosition`
and `applicationFolderPosition`. A third file injected after the build lands wherever Finder puts
it, possibly on top of the arrow. The three options and the recommendation are in
`docs/v2/invitation-email.md` § 8.2; the short version is *inject it and re-run the whole layout,
on the first CI run that produces a real DMG* — which is also the first moment anybody can look
at the result.

### The invitation e-mail

Copy, rationale and the sending checklist: **`docs/v2/invitation-email.md`**. The four files to
send are in `docs/v2/email/`; `node .github/scripts/check-email-copy.mjs` fails if the Gatekeeper
warning, the D9 waiting paragraph, the Releases fallback or a placeholder goes missing from any
of them, or if the HTML grows a remote image.

One number from there belongs here: **mail providers cap the base64-encoded message, and the
e-mail carries the screenshot as well as the DMG.** The screenshot is 72 KiB (~0.10 MB encoded),
so the real 20 MB-provider budget is **≈14.6 MB of DMG** against the 14.7 MB warning threshold in
§4. The gate is right to about 0.1 MB — worth knowing, not worth changing.

### What the artwork costs, measured

A full DMG was built here from the Swift shell and then built again without the background, to
get the difference rather than guess it:

| | |
|---|---|
| `build/dmg/LangzeitPlaner.dmg` | 1 511 922 bytes = 1.44 MiB (~2.1 MB base64) |
| of which the DMG background | **166 KiB** |
| `AppIcon.icns` gaining its alpha channel | +126 KB inside the `.app` |

The first draft of the background carried a vertical gradient and a warm radial glow and cost
**824 KiB** — 4.6% of the provider budget — because dithered gradients do not compress. It is
flat now. Anyone reintroducing a gradient there should re-measure; the numbers are recorded in
`assets/dmg/background.svg` itself.

That 1.44 MiB is the Swift shell, not the Tauri build, and the Rust binary is the dominant term
(§4's estimate stands). What is now measured rather than estimated is everything LZP-107 added:
under 0.3 MB in total.
