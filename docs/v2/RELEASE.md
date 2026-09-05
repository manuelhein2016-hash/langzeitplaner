# Release runbook — LangzeitPlaner v2

| | |
|---|---|
| **Tickets** | LZP-101 (release workflow), LZP-109 (server auto-deploy) |
| **Stories** | 22.1, 22.5, 22.6, 22.7, 22.8 · amendment A11 · decisions D1, D2, D3 |
| **Date** | 2026-08-27 · **amended 2026-09-05** (§2.1, §2.3, §2.5, §7.4, §8, §11) |
| **Audience** | the PO. Everything here is something you do, not something the team does. |

> ### ██ STATUS — RE-ISSUED 2026-09-05, AND THE OLD PARAGRAPH IS QUOTED, NOT DELETED ██
>
> **What this said from 2026-08-27 until today:**
>
> > "**Status of this document.** The pipeline it describes has never been executed. There is no
> > GitHub remote yet, no Vercel account, no Prisma database and no Rust toolchain on the machine
> > it was written on. Every claim below is either **verified locally** (and says so) or
> > **unverified** (and says so). §11 is the honest list of what will be discovered on the first
> > real run."
>
> **What is true on 2026-09-05, measured rather than assumed:**
>
> | | then | now | how it was measured |
> |---|---|---|---|
> | GitHub remote | none | `origin` → `github.com/manuelhein2016-hash/langzeitplaner`, **public** | `git remote -v`; `GET https://api.github.com/repos/manuelhein2016-hash/langzeitplaner` → **200**, `"private": false`, unauthenticated |
> | Vercel + Prisma | no account, no database | the relay is **deployed and answering**, the `Report` migration applied | `curl -si https://langzeitplaner.vercel.app/api/v1/meta` → **HTTP 200**, `{"region":"fra1",…}`, `x-vercel-id: fra1::fra1::…` |
> | Rust toolchain | none | the crate **compiles** on a clean runner (`ci.yml`'s `shell-rust`, macos-14) | see §11 row 1 — it compiles; `cargo tauri build` still has **never run anywhere** |
> | Apple signing | D1, ship unsigned | **reversed.** Developer ID `ZZ77R3LWS4`; the shipped app is signed, notarized and stapled | `spctl --assess --type execute /Applications/LangzeitPlaner.app` → `accepted`, `source=Notarized Developer ID`; `xcrun stapler validate` → *"The validate action worked!"*; `codesign -dv` → `Authority=Developer ID Application: Manuel Hein (ZZ77R3LWS4)`, `flags=0x10000(runtime)` |
> | tags · workflow runs | 0 · 0 | **still 0 · 0** | `git tag` is empty. The release workflow has never executed |
>
> **The sentence that survives all of that:** the *release pipeline* — this document's §1 ladder —
> has still never been executed end to end, and the app in `/Applications` was signed **by hand**.
> Everything §11 says about `cargo tauri build`, the universal binary, the bundler and the DMG is
> unchanged. What moved is the *world around* the pipeline, not the pipeline.

---

## 1. What one `git tag` actually does

*(Re-issued 2026-09-05: steps 7, 8 and 12 are new — signing is on, and the pipeline now asserts
notarization instead of hoping for it.)*

```
git push origin v2.0.1
        │
        ├─► .github/workflows/release.yml
        │     1  updater signing key present?              ── fails in ~5 s if not
        │     2  CI: tier 1 · property · attack · tier 2   ── a red suite never ships
        │     3  updater endpoint ← this repository
        │     4  pre-flight: tag = package.json = Cargo.toml, real pubkey, zero deps,
        │                    and the eight N-* rows: the notarize sequence still
        │                    exists, in the right order, with every failure hard
        │     5  cargo tauri build --target universal-apple-darwin  ── signs, hardened runtime
        │     6  the .app carries a code signature          ── or it dies on Apple silicon
        │     7  the read-me is injected → the image is REWRITTEN and re-signed
        │     8  notarytool submit --wait → stapler staple → stapler validate DMG *and* .app
        │     9  the DMG mounts and holds LangzeitPlaner.app
        │    10  spctl: the app AND the downloaded image → accepted,
        │                    source=Notarized Developer ID   ── hard when signing is on
        │    11  DMG size budget                            ── warn 14.7 MB · fail 20 MiB
        │    12  staged into build/release/, checksums with pipefail on
        │    13  latest.json, generated only from a VERIFIED signature
        │    14  gh release create — DMG + .app.tar.gz + .sig + latest.json + SHA256SUMS
        │    15  the published latest.json resolves over HTTPS  ── unauthenticated;
        │                    this is where a PRIVATE repository would kill the release
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

**Done, 2026-09-05.** `origin` is `https://github.com/manuelhein2016-hash/langzeitplaner`, on
`main`, and it is **public**.

```bash
# what was actually done
gh repo create langzeitplaner --public --source=. --remote=origin
git push -u origin main
```

> ### ██ AMENDED 2026-09-05 · "NOTHING IN THE PIPELINE NEEDS IT TO BE PUBLIC" WAS MEASURED FALSE ██
>
> **What this section said from 2026-08-27 until today, quoted so the correction can be audited:**
>
> > "`gh repo create langzeitplaner --private --source=. --remote=origin`
> >
> > Private is the right default: the repo will hold the family's server code and, in `docs/`, a
> > fairly complete description of how their data is protected. **Nothing in the pipeline needs it
> > to be public** — GitHub Releases assets on a private repo are reachable by anyone with the URL
> > only if the release is public, so see §2.5 before emailing Mom a link."
>
> **Decided by the PO on 2026-09-05: the repository is PUBLIC.** Not as a preference — the old
> sentence is false, and it is false in two independent places, either of which alone kills the
> release:
>
> **1 · The self-update channel (22.3 / 22.5) is an unauthenticated GET, and there is no token
> anywhere in either shell.** The updater fetches
> `https://github.com/<repo>/releases/latest/download/latest.json`. Measured by reading both
> shells: `shell-macos/main.swift:235` holds the URL and the fetch three hundred lines below it
> builds a bare `URLRequest` on an **ephemeral** `URLSessionConfiguration` — `grep -n
> 'Authorization' shell-macos/main.swift` returns **nothing**, and `src/js/platform/updater.js`
> carries no header and no credential either. On a private repository that URL answers **404 to
> every client**, for ever, with no error a person would ever see: the app checks, is told there
> is nothing, and stays where it is. **A private repo does not break the updater loudly. It
> deletes it silently** — which is the worst of the available failures, because the whole point of
> 22.5 is that nobody downloads anything twice.
>
> **2 · `release.yml` hard-fails every non-prerelease tag at its last step.** Step 16, *"The
> published manifest resolves"* (`.github/workflows/release.yml:786`), runs
> `if: github.ref_type == 'tag' && steps.v.outputs.prerelease != 'true'` and does
> `curl -fsSL "https://github.com/$GITHUB_REPOSITORY/releases/latest/download/latest.json"` five
> times, then `exit 1`. Read the curl: **it sends no `Authorization` header.** `GH_TOKEN` is in
> that step's `env`, but `GH_TOKEN` is consumed by `gh`, not by `curl` — so the step probes the
> URL exactly the way an installed app does, which is precisely why it is the right gate. Private
> repo ⇒ 404 ⇒ the release job goes red **after** publishing the release. That is the gate that
> fails without a public repo, and it is the gate that proves the fix.
>
> **What the old sentence got right, and it is worth keeping:** the code is not the secret. The
> keys are, and they are not in the repository — `.gitignore:16-19` excludes `*.key`, `*.p12`,
> `*.p8` and `.env`, and the history was scanned for all four plus `AuthKey` and `postgres://`
> before the first push. `SYNC_ORIGIN_BUILTIN` and `LZP_REPORTS_ADMIN_PUB` are a public URL and a
> **public** key respectively. What a reader of this repository learns is how the family's data is
> protected, which is the same thing the Datenschutz screen tells the family on purpose.
>
> **The consequence that is now free:** §2.5's dilemma is gone. The invitation e-mail's GitHub
> Releases fallback link resolves for somebody with no GitHub account.

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
| ~~`ENABLE_APPLE_SIGNING`~~ | ~~unset~~ | **no longer optional — see §8. D1 was reversed on 2026-09-05 and this must be `true`.** |
| `LZP_ROTATION_VERIFY_PUBKEY` | unset | set for exactly one release during a key rotation; see §5.3. |

That is the whole list for LZP-101. Signing adds seven more names, and they are now **required**
rather than optional (§8); the server adds none to GitHub (its configuration lives in Vercel — §7).

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

### 2.5 Before the first email to Mom — ✅ SETTLED 2026-09-05

The invitation email (deliverable 28) carries the DMG as an attachment *and* a GitHub Releases
link as fallback for providers that strip DMGs (22.1).

> **The choice this section used to pose, quoted because the reasoning still matters:**
>
> > "A link into a **private** repository asks her to sign in to GitHub, which is exactly the kind
> > of wall this whole epic exists to avoid. Two workable answers, both fine, pick one
> > deliberately: make the repository public (the code is not the secret; the keys are, and they
> > are not in it), or keep it private and make the email's fallback a link you generate yourself
> > — a file you upload somewhere she can reach without an account. Decide this before the email
> > is designed, not after she has hit the login page."

**The first answer was taken** (§2.1). The fallback link resolves without an account, and no
second hosting arrangement is needed. Note that §2.1's *other* reason is the load-bearing one: the
e-mail's fallback link is a convenience, and the updater's manifest URL is the product. Both
needed the same decision; only one of them would have been noticed if it had gone the other way.

**Still true and unchanged:** protect `main` before the first tag. **Anyone who can push a tag can
install code on Mom's Mac**, because the updater will trust it, and a public repository does not
change who may push — it changes who may *read*.

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

### 7.4 What E2 (WP-7) owed this pipeline — ✅ ALL OF IT, DELIVERED AND DEPLOYED

> ### ██ RE-ISSUED 2026-09-05 · THE "OWED" TABLE IS SATISFIED ██
>
> **What this section said until today, quoted rather than deleted:**
>
> > "`server/` currently contains one file: `vercel.json`. Everything below must appear for the
> > deploy to work, and `node .github/scripts/check-server-config.mjs` lists them as *owed* until
> > they do — at which point the same checks become binding."
>
> Measured 2026-09-05: `git ls-files server | wc -l` → **34**. Every row below is committed, and
> the relay built from them is **answering in production**. The checks did become binding, and
> they pass: `node .github/scripts/check-server-config.mjs` → **40 passed · 0 failed · 0 warnings
> · 2 not checked here** (L1 and L2 — see below; they are not a pass and the runner says so).

| path | why the pipeline needs it | state |
|---|---|---|
| `server/package.json` | Vercel's `installCommand` is `npm ci` | ✅ committed |
| `server/package-lock.json` | `npm ci` fails outright without a lockfile | ✅ committed |
| `server/prisma/schema.prisma` | `prisma generate` and `prisma migrate deploy` need a schema; its `url` must be `env("DATABASE_URL")` | ✅ committed |
| `server/prisma/migrations/` | append-only from the first deploy onward | ✅ **two** migrations — `20260903092140_init` and `20260905101500_report` — plus `migration_lock.toml` |
| `server/api/**` | the function entry points `vercel.json`'s `functions` glob (maxDuration 10 s, 1024 MB) refers to | ✅ `server/api/v1/index.js`, reached through `vercel.json`'s `/api/v1/(.*)` → `/api/v1` rewrite |
| `tests/server/*.test.js` | the pre-deploy gate; the workflow runs it the moment the directory exists | ✅ `npm run test:server` → **1094 pass** + 1 stated skip |
| `GET /api/v1/meta` | the smoke test reads `{ region, minProto, maxProto, serverTime }` and asserts Frankfurt, the N−1 protocol window, and that nothing family-shaped leaks from an unauthenticated endpoint | ✅ **answering in production** |

**The production measurement, taken 2026-09-05 and reproducible in one line:**

```
$ curl -si https://langzeitplaner.vercel.app/api/v1/meta
HTTP/2 200
cache-control: no-store
strict-transport-security: max-age=63072000; includeSubDomains
x-content-type-options: nosniff
referrer-policy: no-referrer
x-lzp-min-protocol: 1
x-lzp-protocol: 1
x-vercel-id: fra1::fra1::…

{"region":"fra1","minProto":1,"maxProto":1,"serverTime":…}
```

The five smoke rows `RELEASE-CHECKLIST.md` asks for, all five confirmed: region **`fra1`** (in the
body *and* in `x-vercel-id`, which is the edge that served it) · `Cache-Control: no-store` ·
`X-LZP-Protocol` · HSTS · and **no** `Access-Control-Allow-Origin` — re-asked with an explicit
`Origin: https://evil.example` request header, which is the only way that assertion means
anything, and the response carried no `access-control-*` header of any kind.

Also verified against the live host, because a route table is a claim about the deployment and not
about the tree: `POST /api/v1/feedback` with `{}` answers **400 `{"error":"bad_request",
"unexpectedField":"v"}"`** — i.e. the LZP-1009 route is deployed and its closed-shape validator
(`handlers/feedback.js:187`) is the thing running — while `/api/v1/nope` answers **404
`not_found`**. `GET /api/v1/feedback` answers **404**, which is the designed answer on a relay
with no `LZP_REPORTS_ADMIN_PUB`: the operator surface does not advertise that it exists. **404 is
therefore not evidence either way about whether the operator key is enrolled**, and this document
will not pretend it is.

**What a `curl` from outside cannot settle, and is left to the PO's own measurement:** whether the
deployed relay binds a `feedbackSink`. `handlers/feedback.js:244-246` answers **501
`not_implemented`** when it does not and **202** when it does, and only a *well-formed* report
tells them apart — which writes a row into the family's production database. The PO POSTed one on
2026-09-05 and got **202** with `provesNot` on the wire. That is his measurement, recorded as his.

**And one thing a 202 does not settle.** `U-RAWBODY` — *"the request reaching the handler is an
unconsumed stream, so buffering yields the exact signed bytes"* — is settled only by a request
whose **signature is verified over those bytes**. An *unsigned* report (`proves: unsigned`) never
reaches `verifySignature`; a platform body parser would produce a byte-identical `JSON.parse` and
the 202 would look the same. So: a 202 on an unsigned report proves the sink is bound and proves
nothing about `U-RAWBODY`. The claim needs a **signed** request — a signed report, or any
`LZP1`-authenticated route answering 200. `RELEASE-CHECKLIST.md`'s row says *"one authenticated
request returned 200"* and means exactly that.

**L1 and L2 remain stated skips.** They are not failures and they are not passes:

```
skip L1  migrations APPLIED and the adapter REACHABLE — not checkable offline
skip L2  schema-vs-migration DRIFT — needs a shadow database

cd server && npm ci && DATABASE_URL="…?connection_limit=1" SHADOW_DATABASE_URL="…" \
  node ../.github/scripts/check-server-config.mjs --deep
```

Until `--deep` runs against the **deployed** database, "the migration is applied" rests on the
deploy log and on the relay answering, not on a check.

Two boundaries E2 must not cross — **still binding, and still the reason to read this section:**

- **`server/package.json` may have dependencies; the root `package.json` may not.** Prisma is
  unavoidable server-side and irrelevant to the desktop app. The pre-flight fails if Prisma is
  ever mentioned in the root manifest.
- **No CORS headers on `/api`** — and as of 2026-09-05 this is **witnessed on the deployed relay**,
  not only enforced by the pre-flight: `curl -si -H 'Origin: https://evil.example'
  https://langzeitplaner.vercel.app/api/v1/meta | grep -i access-control` prints nothing. Asking
  *with* an `Origin` header is the only form of the question that means anything.
  The client is a desktop app, not a browser origin. An
  `Access-Control-Allow-Origin` header can only ever help a web page that should not be talking
  to this server (21.5). The pre-flight fails on one.

---

## 8. Apple signing is ON — what it needs

> ### ██ D1 IS REVERSED. DECIDED AND EXECUTED BY THE PO, 2026-09-05. ██
>
> **This section's title and opening, from 2026-08-27 until today, quoted so the reversal is a
> record and not a silent rewrite:**
>
> > "**8. Turning Apple signing on (reversing D1)**
> >
> > D1 said no to a 99 €/yr fee, not no to signing. Reversing it must therefore cost a
> > subscription and ten minutes, not an engineering day. **No file in this repository changes.**"
>
> The subscription was bought. **Developer ID `ZZ77R3LWS4` exists**, and the app that is installed
> today was signed, notarized and stapled **by hand**. Measured on
> `/Applications/LangzeitPlaner.app`, 2026-09-05, and every line is reproducible:
>
> ```
> $ spctl --assess --type execute --verbose=4 /Applications/LangzeitPlaner.app
>   accepted
>   source=Notarized Developer ID
>
> $ codesign -dv --verbose=4 /Applications/LangzeitPlaner.app
>   Identifier=org.langzeitplaner.app
>   CodeDirectory v=20500 … flags=0x10000(runtime)
>   Authority=Developer ID Application: Manuel Hein (ZZ77R3LWS4)
>   Authority=Developer ID Certification Authority
>   Authority=Apple Root CA
>   TeamIdentifier=ZZ77R3LWS4
>
> $ xcrun stapler validate /Applications/LangzeitPlaner.app
>   The validate action worked!
>
> $ security find-identity -v -p codesigning
>   1) 973A684A… "Developer ID Application: Manuel Hein (ZZ77R3LWS4)"
> ```
>
> The old measurement this replaces — `Signature=adhoc`, `spctl … rejected (rc=3)`,
> `Notary Ticket Missing … Severity: Fatal` — is in `SHIP.md` §0, kept there as the record.
>
> **The promise that held: no file in this repository changed to get here.** Every signing step in
> `release.yml` was already written and already gated on `ENABLE_APPLE_SIGNING`. What did *not*
> hold is the "ten minutes" — see §8.3, which is the honest part of this section.

### 8.1 The seven names, and they are no longer optional

`ENABLE_APPLE_SIGNING` was a flag with a default. It is now a **requirement**: the release that
reaches Mom must be the notarized one, because the whole of LZP-106 exists to walk her past a wall
that signing removes.

| name | kind | value |
|---|---|---|
| `APPLE_CERTIFICATE` | secret | `base64 -i cert.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | secret | the `.p12` export password |
| `APPLE_API_KEY_P8` | secret | the contents of `AuthKey_XXXX.p8` |
| `APPLE_SIGNING_IDENTITY` | variable | **exactly** `Developer ID Application: Manuel Hein (ZZ77R3LWS4)` |
| `APPLE_API_KEY_ID` | variable | the key id (the `XXXX` above) |
| `APPLE_API_ISSUER` | variable | the issuer UUID from the same page |
| `ENABLE_APPLE_SIGNING` | variable | `true` |

> **The brief said "a cert and two GitHub secrets". That undercounts.** It is three secrets and
> four variables, because notarization needs its own credential set on top of the signing
> certificate.

`APPLE_SIGNING_IDENTITY` must match the certificate's common name **byte for byte** —
`security find-identity -v -p codesigning` prints the string to copy. `codesign` matches on a
substring, so a truncated value silently selects a *different* identity when a second one is ever
installed. The `.p8` is offered once and never again; keep it where the 99 € renewal notice will
find it.

### 8.2 What the pipeline does with them, and the gate that fails without each

The PO's hand incantation of 2026-09-05 — `codesign --options runtime --timestamp`,
`notarytool submit --wait`, `stapler staple`, `spctl --assess` → `accepted` /
`source=Notarized Developer ID` — is now **in the workflow**, in that order, with every failure
hard. Read this table as: *if this step silently did not happen, which row goes red?*

| `release.yml` step | what it does when `ENABLE_APPLE_SIGNING == 'true'` | the gate that fails without it |
|---|---|---|
| ── 6 ── *Import Apple signing certificate* (`:204`) | throwaway keychain from `APPLE_CERTIFICATE`; `set-key-partition-list` so `codesign` may use it unattended; ends with `security find-identity -v -p codesigning` so the log **names the identity that was actually imported** | the build's own `codesign` fails, and ── 9 ── below |
| ── 6 ── *Enable signing and notarization* (`:223`) | writes `APPLE_SIGNING_IDENTITY`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH` into `$GITHUB_ENV` — the four names Tauri's bundler reads | ── 9b ──'s hardened-runtime assertion, which is the *first* thing that notices |
| ── 7 ── *Build universal bundle* (`:285`) | `cargo tauri build`. With a real identity it signs with `--options runtime` — that is the `flags=0x10000(runtime)` measured above — and, with the API-key names present, submits and staples the **`.app`** | ── 9b ──'s `stapler validate "$APP"`, whose error text says explicitly that stapling the outer `.app` afterwards **cannot** reach the copy inside the image |
| ── 8b ── *Put the unlock page on the DMG* (`:349`) | `dmg-add-readme.sh` rewrites the image to add `Bitte zuerst lesen.html`, then re-signs it `--force --options runtime --timestamp` (`:130-166`) and **prints that the image now has no ticket, by construction** | ── 10 ──'s read-me gate (`:515`), and ── 9b ──'s DMG staple |
| ── 9 ── *The .app carries a code signature* (`:353`) | `codesign --verify` on the bundle | itself — hard, on both branches |
| ── 9b ── **Notarize the rewritten DMG, staple it, and prove both tickets** (`:390`) | asserts `flags=…runtime` on the `.app`; `xcrun notarytool submit --wait --timeout 30m` on the **rewritten** DMG, parsing `status` from JSON and printing `notarytool log` on failure; `xcrun stapler staple`; `xcrun stapler validate` on **both** the DMG and the `.app` | itself — four separate `exit 1`s, and the reason this step exists |
| ── 10 ── *The DMG mounts…* → the Gatekeeper branch (`:544-570`) | on the signed branch, **two** assessments: `spctl --assess --type execute` on the app, and `spctl --assess --type open --context context:primary-signature` on the **image**, each required to exit 0 **and** to print `source=Notarized Developer ID` | itself. The `source=` grep is the sharp one: it is what separates a stranger's verdict from a build machine's locally-trusted one |
| pre-flight ── 4 ── (`:161`) | `check-release-config.mjs --strict` **eight** notarization rows — **N-SUBMIT · N-ORDER · N-STAPLE · N-VALIDATE · N-RUNTIME · N-SPCTL-APP · N-SPCTL-DMG · N-NOTARIZED** | the whole sequence above, **in seconds, before the ~40-minute build** — N-ORDER asserts injection → notarization → gates in that order, so the steps cannot be reordered back into a lie |

**Two orderings are load-bearing and both are asserted rather than remembered.** ── 9b ── runs
*after* the read-me injection, because `dmg-add-readme.sh`'s `mv` replaces the file Tauri built and
any ticket Tauri stapled to the old image is now in `$TMPDIR`; and *before* the mount gate, so the
DMG that every gate below inspects, measures, hashes and uploads is the stapled one. `N-ORDER`
fails the pre-flight if either ever moves.

**Verified by reading, 2026-09-05:** `xcrun notarytool submit`, `xcrun stapler staple` and two
`xcrun stapler validate` calls are present in `release.yml` step 9b, and `spctl` appears on the
signed branch without `|| true`. What was there until today — *"Diagnostic only. Unsigned, this
WILL say `rejected` — that is the expected state under D1"*, with `|| true` — is **quoted verbatim
in the workflow's own comment at `:524-533`**, next to the reason it was right then and wrong now.
`dmg-add-readme.sh:144-150` does the same for the warning it used to print. Both are inversions
with their reasoning attached, which is the house rule.

### 8.3 ⚠ WHAT IS STILL NOT PROVEN, AND MUST STAY NAMED

The steps exist. **They have never run.** Nothing below is a defect; it is the boundary of what
reading a workflow can tell you, and each line is a thing the first `workflow_dispatch` decides:

1. **`cargo tauri build` has never run anywhere.** No universal binary, no bundler invocation, no
   DMG from the real path. Every artifact measured in this project was built by
   `shell-macos/build.sh` + `scripts/make-dmg.sh`, and the app in `/Applications` was signed by
   hand. So ── 7 ──'s claim that Tauri notarizes and staples the `.app` is documented behaviour
   the runner has never demonstrated — which is exactly why ── 9b ── asserts it instead of
   assuming it.
2. **The DMG re-sign branch in `dmg-add-readme.sh` has still never executed.** It was dead under D1
   (`APPLE_SIGNING_IDENTITY` was always `-`) and it is live now, unrun.
3. **Which ticket rides where, measured on the hand-built app rather than reasoned:** the
   notarization ticket for an app bundle is a file *inside* the bundle —
   `/Applications/LangzeitPlaner.app/Contents/CodeResources`, beside `Contents/_CodeSignature/` —
   so the **`.app`'s** ticket survives being copied into a rewritten image. What cannot survive is
   a **DMG-level** staple, and that is the one ── 9b ── produces. This is why the second
   assessment (`--type open --context context:primary-signature`) matters: **the `.app` can be
   perfectly notarized while the image around it is not**, and the image is what arrives in Mom's
   mailbox.
4. **`spctl` on a hosted runner** — the assessments have only ever been run on the PO's Mac.

**Until `workflow_dispatch` is green, `git tag` is a plan and not a reproduction.** That is the
sentence to keep: the incantation has left the PO's head and is in the file, and the file has not
been executed.

### 8.4 LZP-106's unlock screen stays — as the certificate-expiry fallback

**Re-framed, not deleted.** Under D1 the guided Systemeinstellungen screen and the
`Bitte zuerst lesen.html` page on the DMG were the *primary* surface: every first run met a
Gatekeeper wall and something had to walk her past it. With signing on, a first run is boring, and
that whole apparatus becomes a **fallback**.

Keep every piece of it. A Developer ID certificate expires — that is not a risk, it is a date —
and the renewal is a 99 € invoice that can be missed while the fleet keeps updating. The day it
lapses, an unstapled or ad-hoc build meets exactly the wall LZP-106 was built for, on a Mac whose
owner has no idea anything changed. It costs nothing to keep and it is unbuildable in a hurry.

Its gates stay hard for the same reason: `release.yml:378` fails the build if
`Bitte zuerst lesen.html` is not on the mounted image, and `check-dmg-readme.mjs` holds the
producer, both consumers and the icon geometry in agreement. Do not relax them because the wall is
currently gone. What **does** change is where the copy points: the page and the in-app screen now
describe a situation a reader will normally never meet, and `SHIP.md` §3 records that first run
under signing rather than under D1.

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
#   …and against the DEPLOYED database, which is what turns L1/L2 from skips into passes:
#   cd server && npm ci && DATABASE_URL="…?connection_limit=1" SHADOW_DATABASE_URL="…" \
#     node ../.github/scripts/check-server-config.mjs --deep

# is the relay actually up, and does it still answer as a blind relay?
curl -si https://langzeitplaner.vercel.app/api/v1/meta
curl -si -H 'Origin: https://evil.example' https://langzeitplaner.vercel.app/api/v1/meta \
  | grep -i access-control            # must print NOTHING (21.5)

# the three questions to ask of any signed artifact, in this order
spctl --assess --type execute --verbose=4 /path/to/LangzeitPlaner.app   # accepted + source=Notarized Developer ID
spctl --assess --type open --context context:primary-signature -v X.dmg # the verdict a DOWNLOAD gets
xcrun stapler validate X.dmg && xcrun stapler validate /path/to/LangzeitPlaner.app

# watch a release
gh run watch

# emergency stop
gh release edit v2.0.1 --prerelease
```

---

## 11. Known unknowns

Nothing below was executed. It is listed so the first real run is a checklist rather than a
surprise.

> **Re-issued 2026-09-05.** Rows 1 and 8 moved; nothing else did. Two rows are **added** at the
> bottom (13, 14) for the notarization steps, which exist now and have never run. Every other row
> is unchanged, because nothing that would have changed it has happened.

| # | what is unverified | how it will show up | what to do |
|---|---|---|---|
| 1 | ~~**The whole Tauri build.** No Rust on the authoring machine; `src-tauri/` has never been compiled.~~ **PARTLY CLOSED 2026-09-04/05.** The crate **compiles**: `cargo check --all-targets --locked` with `-D warnings` → exit 0, and `ci.yml`'s `shell-rust` job runs it on every push to a clean macos-14 runner. **Still unverified, and this is the big one: `cargo tauri build` has never run anywhere.** No universal binary (the x86_64 half has never been compiled by anybody), no bundler invocation, no DMG from the real path. | anything | run `workflow_dispatch` before any tag |
| 2 | **`"version": "../package.json"`** — documented Tauri 2 behaviour, never exercised here. | the DMG carries the wrong version, or the build rejects the config | fall back to restating the number, and re-enable the equality check in `check-release-config.mjs` |
| 3 | **`APPLE_SIGNING_IDENTITY=-` producing an ad-hoc signature.** `lipo` strips signatures while fusing the slices, and Apple silicon refuses to run an unsigned binary — so this is not cosmetic. | step *"The .app carries a code signature"* fails | sign the bundle explicitly with `codesign --force --deep --sign -` and rebuild the DMG with `hdiutil`, as `shell-macos/build.sh` already does |
| 4 | **The exact `.sig` layout Tauri emits.** The verifier handles both minisign modes and unwraps Tauri's outer base64, and is tested against synthetic vectors — not against a real `tauri signer` artifact. | step *"Generate and verify latest.json"* fails on a real signature | read the printed reason; the parser says which field disagreed |
| 5 | **`minimum_version` as an extra top-level field in `latest.json`.** Tauri's updater should ignore unknown fields. (Renamed from `minClientVersion` during E1 integration — the old spelling matched no client.) | the updater errors parsing the manifest | move it into `notes`, or serve it from a second file |
| 6 | **Tier 2 on a hosted runner.** `run-dom-tests.sh` drives a real WKWebView; a hosted macOS runner may not give it a usable window server. | the `dom` job fails for environmental reasons | `continue-on-error: true` on that job — one line — and note it here |
| 7 | **`createUpdaterArtifacts` and the updater plugin.** `tauri-plugin-updater` is in `Cargo.toml` and registered in `lib.rs`. `capabilities/default.json` still has no `updater:default` permission, and **E1 integration concluded it does not need one**: nothing in the WebView calls a plugin command — the plugin is driven only from Rust, inside custom `#[tauri::command]`s, and capabilities gate the JS→Rust boundary, not Rust→plugin calls. UNVERIFIED (no cargo): if a real build denies the call at runtime, adding `"updater:default"` is the one-line fix. | no `.app.tar.gz` (step *"Locate build output"* fails), or an app that builds and then refuses its own update call | add `"updater:default"` to the capability |
| 8 | ~~**Every Vercel and Prisma claim in §7.** No account exists.~~ **MOSTLY CLOSED 2026-09-05.** The project exists, Root Directory `server`, region `fra1`, `DATABASE_URL` set, both migrations applied by the Vercel build, and `GET /api/v1/meta` answers **200 from `fra1`** with all five smoke rows — §7.4 carries the transcript. **What is still unverified:** `check-server-config.mjs --deep` has never run against the deployed database, so **L1** (migrations applied, adapter reachable) and **L2** (schema-vs-migration drift) remain *stated skips*; and `RUNBOOK.md` §2.5.1 has never run against Frankfurt's **pooler**, so R-8b stands — a transaction-mode pooler can refuse an interactive `$transaction` or silently downgrade `Serializable`, and every atomicity guarantee rests on getting one. Also unwitnessed: the Prisma adapter's two ledger rows **`U-REPORTONCE`** and **`U-REPORTTTL`** (`server/adapters/prisma.js:938-939`) — the 90-day retention's timezone correctness and the duplicate/idempotent-delete behaviour of the `Report` table have **no database witness at all**. | the first `--deep` run, or a report that expires an hour early | run `--deep`, then `LZP_CONTRACT_DATABASE_URL=… npm run test:server` (**never** `DATABASE_URL` — the harness `TRUNCATE`s) |
| 9 | **The DMG size estimate in §4.** | the first build | replace the estimate with the measurement, in this file |
| 10 | **Whether Tauri's DMG bundler can drive Finder on a hosted runner.** It styles the image by sending Apple events; that is refused here with `-1743 Not authorized to send Apple events to Finder`, and the bundler still emits a valid but completely **unstyled** DMG without failing. | nothing in the build — which is the problem. The gate added for it (step *"The DMG mounts and contains the app"*) checks for `.background/background.tiff` and a root `.DS_Store` and fails when either is missing. | if it fails on CI, build the DMG with `scripts/make-dmg.sh` on a Mac with a login session and upload that instead |
| 11 | **Whether Finder localises the `/Applications` symlink to *Programme*.** The localisation table itself is verified (`SystemFolderLocalizations/de.lproj` maps `"Applications" => "Programme"`); whether it applies to a symlink inside a DMG could not be tested on an en-US machine. | the folder in the DMG is labelled "Applications" on a German Mac | nothing to fix in code — `background.svg` paints »Programme« into the window and the invitation e-mail names both words |
| 12 | **Whether `bundle.macOS.dmg.background` accepts a `.tiff`.** Tauri copies the file into `.background/` and names it in its AppleScript, so the extension should not matter, but this was not run. | the DMG has no background; gate 10 catches it | point `background` at `dmg/background.png` instead — `build-release-assets.sh` already produces it. The cost is a soft background on Retina, not a broken install |
| 13 | **NEW 2026-09-05 · the whole notarization sequence.** §8.2's steps 9b and 10 exist and have **never executed**: no `notarytool submit` has been made from CI, the DMG re-sign branch in `dmg-add-readme.sh` has never run (it was dead under D1), and `spctl` has only ever been run on the PO's own Mac. Tauri's own `.app` notarization is documented behaviour the runner has never demonstrated — which is why 9b asserts it. | `workflow_dispatch` fails at step 9b with a `notarytool log` printed under it, or at step 10 with an `spctl` verdict | read the printed submission log. The usual causes are named in the step's own error text: a missing hardened runtime, an unsigned nested binary, an expired certificate |
| 14 | **NEW 2026-09-05 · that a stapled DMG opens offline on a stranger's Mac.** The ticket is what lets Gatekeeper decide without asking Apple. Everything here is measured on machines with a working network. | she opens the DMG on a captive-portal wifi and waits, or is refused | `xcrun stapler validate` on the downloaded image, and §5 step 6 of `SHIP.md` — download it yourself and walk her first run |

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

### The unlock page that rides on the DMG — built, and now placed

`src/js/firstrun.js` (LZP-106) can render its two illustrated unlock steps as one
self-contained HTML file, both languages, no script and no external asset. Its whole point is to
sit on the disk image next to the app: Gatekeeper blocks the app, but it does not block Safari
opening an HTML file, so this is the only thing on the DMG a blocked user can still read.

`./scripts/build-unlock-page.sh` produces it (19 KB) by running `renderUnlockDocument()` in a
real WKWebView through the tier-2 harness, asserting the page is complete and asset-free before
writing it. `build-release-assets.sh` calls it, so it cannot rot.

**It is consumed, on both paths, since 2026-09-04** — § 8.2's option (a). `scripts/make-dmg.sh`
stages and positions it; `.github/scripts/dmg-add-readme.sh` injects it into the DMG the bundler
produced; `release.yml` step 10 fails the release if it is not on the mounted image; and
`.github/scripts/check-dmg-readme.mjs` holds the producer, both consumers, the gate and the icon
geometry in agreement. Measured on the built artifact: DMG root = 4 entries, page sha256 identical
to source. Tauri cannot do this itself and that was checked rather than assumed —
`bundle.macOS.dmg` is `"additionalProperties": false` with exactly five keys, so an invented sixth
makes `cargo tauri build` reject the config outright. The historical reasoning is preserved in
`docs/v2/invitation-email.md` § 8.2; the short version was *inject it and re-run the whole layout,
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
