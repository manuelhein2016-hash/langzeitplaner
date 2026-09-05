# SHIP — putting LangzeitPlaner in his mother's hands

| | |
|---|---|
| **Written** | 2026-09-04, at the end of the integration pass that built and mounted the artifacts |
| **Re-issued** | **2026-09-05** — §0, §1, §2, §3 and §5 step 5. Five of the six blockers below fell in one day. Every superseded paragraph is quoted where it stood, not deleted. |
| **Re-issued again** | **2026-09-05, integration pass** — the measurement block, §5 (two steps were missing entirely), the new **§7**, and the short version, which is now *the* ordered list of what only the PO can do. **Three** defects in the release wiring were found by running it — two here, one by the first CI run that had ever executed these tests — and all three are fixed; see §7. |
| **Audience** | the PO, and nobody else |
| **Companion to** | `RELEASE-CHECKLIST.md` — the mechanical sheet. This is the *order*, and the *why*. |
| **Scope** | everything between "the tree is green" and "she is using it" |

`RELEASE-CHECKLIST.md` is a sheet you tick. This is the shorter, harder document: **the things
only you can do**, in the order they unblock each other, with the cost of getting each one wrong.
Every number below was measured, not asserted.

---

## Where the tree actually stands — re-measured 2026-09-05

```
suites          tier1 2328 · attack 986 · server 1094 (+1 skip) · fleet 482 · property 101
                  (2283 at the start of the day; the release wiring added 40, this pass added 5)
                tier2 930 pass / 3 fail  (§A4, §E1, §E3 — a PO ruling and a spec threshold)
                on CI tier 2 shows a FOURTH, §C2 — the runner's font metrics, red before this work
checkers        check-release-config 11 pipeline rows green, exit 0 · --strict exit 1 on exactly
                  the 3 by-hand placeholders · check-server-config 40/0/0 + 2 stated skips
                  check-dmg-readme, check-dmg-geometry, check-ci-triggers, check-deploy-window: 0
                  mom-test-probe: exit 0, 41 rows · 39 pass · 2 note · 0 FAIL
redaction bar   1 500 rows across the 41 redaction/Privat-bearing files — 0 fail, a TWELFTH time
acceptance      5 of 5 runs · 175 launches of the shipped .app · 0 phases failed
                refusal ledger 0 in all five · relaunch battery 8 of 8 in all five
privacy         zero plaintext bytes on a real relay's disk, an eleventh time
artifact        build/dmg/LangzeitPlaner.dmg — 2 442 008 B = 2.33 MiB, ~3.32 MB base64
                (hand-built, arm64-only, UNSIGNED — the signed app is the one in /Applications)
git             origin → github.com/manuelhein2016-hash/langzeitplaner, PUBLIC, on main
                0 tags · the release workflow has still never run
relay           https://langzeitplaner.vercel.app — LIVE, 200 from fra1, re-verified this pass
                x-vercel-id fra1::fra1 · no-store + HSTS + nosniff + no-referrer · CORS closed
                0 files under server/ changed in this pass
signing         Developer ID ZZ77R3LWS4 · /Applications/LangzeitPlaner.app is notarized + stapled
                spctl accepted / source=Notarized Developer ID · stapler validate rc=0
```

> **What this block said on 2026-09-04, kept so the day is legible:**
>
> ```
> suites   tier1 2276 · attack 977 · server 1009 (+1 skip) · fleet 482 · property 101
>          tier2 904 pass / 3 fail
> git      0 remotes · 0 tags · no workflow has ever run
> ```
>
> **"The code is not what is blocking this release. Six things are, and five of them are accounts,
> domains and rulings that no agent can perform on your behalf."** That was true and it is the one
> sentence in this document that has actually resolved: **five of the six are done.** What is left
> is §5 step 3 — a green `workflow_dispatch` — plus §5 steps 6–8, which are you, a Mac and a
> person.

---

## §0 · D1 IS REVERSED — signing is on, and §3 is a fallback rather than the plan

> ### ██ RE-ISSUED 2026-09-05. THE OLD SECTION, VERBATIM: ██
>
> > **The one decision that deletes a third of this document**
> >
> > **D1 says ship unsigned.** Everything in §3 below — the guided unlock screen, the standalone
> > page riding on the DMG, the artwork caption, the two sentences added on 2026-09-04, the
> > e-mail's step 3 — exists *only* because of that decision. Measured on the shipped bundle:
> >
> > ```
> > codesign --verify              valid on disk · satisfies its Designated Requirement
> > codesign -dv                   Signature=adhoc · flags=0x2(adhoc)
> > spctl --assess --type execute  rejected  (rc=3)
> > syspolicy_check distribution   Adhoc Signed App ......... Severity: Warning
> >                                Notary Ticket Missing .... Severity: Fatal
> > ```
> >
> > An Apple Developer ID (99 €/yr) plus notarization turns that `rejected` into `accepted`, and
> > the first-run wall — the single most likely place for this to fail in front of her — stops
> > existing. Everything built to walk her past it becomes dead weight you can keep or delete.
> >
> > **You do not need to revisit D1 to ship.** You need to know that you are choosing the harder
> > first run to save 99 €, and that the *unverified* part of §3 (the „beschädigt" wording) is a
> > risk that purchase would remove entirely.

**You revisited it. You bought it. It worked.** Measured on `/Applications/LangzeitPlaner.app`,
2026-09-05, by the same four commands the old block used:

```
codesign --verify              valid on disk
codesign -dv --verbose=4       flags=0x10000(runtime)          ← hardened runtime, not adhoc
                               Authority=Developer ID Application: Manuel Hein (ZZ77R3LWS4)
                               Authority=Developer ID Certification Authority · Apple Root CA
                               TeamIdentifier=ZZ77R3LWS4
spctl --assess --type execute  accepted
                               source=Notarized Developer ID   ← this line is the whole purchase
xcrun stapler validate         The validate action worked!     ← the ticket is ON the file
```

`security find-identity -v -p codesigning` → `1) 973A684A… "Developer ID Application: Manuel Hein
(ZZ77R3LWS4)"`, one valid identity.

**Three consequences, and the third is the one that costs work.**

1. **§3's first run is no longer what a stranger meets.** The Gatekeeper wall is gone; step 5 of
   that table is now the exception, not the rule. The table is kept, and re-headed, because it is
   still exactly what she meets the day a certificate lapses.
2. **Nothing built for D1 gets deleted.** LZP-106's guided unlock screen, `Bitte zuerst lesen.html`
   on the DMG, the ordering-trap sentence, the „beschädigt" warning: all stay, all keep their hard
   gates in `release.yml`. A Developer ID certificate expires — that is a date, not a risk — and
   the renewal is an invoice that can be missed while the fleet keeps updating. See
   `RELEASE.md` §8.4.
3. **⚠ You did this BY HAND, and the pipeline has to be able to do it too.** That is Part 5 of the
   ship plan and it is now written into `.github/workflows/release.yml` — step 9b *"Notarize the
   rewritten DMG, staple it, and prove both tickets"*, plus a hard `spctl` gate that requires
   `accepted` **and** `source=Notarized Developer ID` on **both** the app and the downloaded image,
   plus **ten** pre-flight rows (`N-SUBMIT`, `N-ORDER`, `N-STAPLE`, `N-STAPLE-LOUD`, `N-VALIDATE`,
   `N-RUNTIME`, `N-SIGPIPE`, `N-SPCTL-APP`, `N-SPCTL-DMG`, `N-NOTARIZED`) that fail in seconds if
   the sequence is ever removed or reordered. **None of it has ever run against Apple** — but the
   two steps that carry it have now been executed against real fixtures, and **two of them were
   broken**; the last two rows in that list are the ones that came out of it. See §7.
   `RELEASE.md` §8.2 is the step-by-step; §8.3 is what is still unproven.

---

## §1 · ✅ DONE 2026-09-05 · The relay host is claimed, and the substitution is whole

**`https://langzeitplaner.vercel.app`.** Pure ASCII, so the umlaut trap below never fired.

Measured, in all six files:

```
$ grep -rn SYNC_ORIGIN_BUILTIN shell-macos/main.swift src-tauri/src/lib.rs
  shell-macos/main.swift:845   let SYNC_ORIGIN_BUILTIN = "https://langzeitplaner.vercel.app"
  src-tauri/src/lib.rs:749     const SYNC_ORIGIN_BUILTIN: &str = "https://langzeitplaner.vercel.app";

$ grep -rn langzeitplaner.vercel.app docs/v2/email/
  invitation.de.txt · invitation.de.html · invitation.en.txt · invitation.en.html   — all four
```

`tests/tier1/release-gate.test.js` accepts only *"all unset"* or *"all set to one https origin"*,
and it is green: both halves moved in one commit, which is what that gate exists to force.

> **What this section said until 2026-09-05, kept because the trap it names is permanent:**
>
> > "**Only you can do this: it needs a domain or a Vercel account, and a payment method.** The
> > address in all four invitation mails today is `https://serveradresse-fehlt.invalid`. That is
> > deliberate — RFC 2606 §2 makes `.invalid` undelegatable, so no stranger can register the thing
> > your mother has been told to trust. It is also why `mom-test-probe.mjs` exits **1** with
> > `FAIL M2s`, and why that FAIL is *correct* until this step is done.
> >
> > The trap that AUDIT F1 found, and that the checklist now guards: **the address is written in
> > six files, and the four you would naturally think of are the four that nothing reads.**
> >
> > ```bash
> > # 1 · the four mails — what she reads
> > sed -i '' 's|https://serveradresse-fehlt\.invalid|https://NEW-HOST|g' docs/v2/email/invitation.*
> >
> > # 2 · the pinned origin — what every sync_request is rebuilt against, byte for byte
> > #     shell-macos/main.swift:~790   let SYNC_ORIGIN_BUILTIN = "https://NEW-HOST"
> > #     src-tauri/src/lib.rs:714      const SYNC_ORIGIN_BUILTIN: &str = "https://NEW-HOST";
> > ```
> >
> > Do only half and you ship a build where the address she was told to type is read by nothing,
> > and every family request is refused locally as `no_origin_configured` before a socket exists."

**The trap has not gone away — it has only been survived once.** Every future host change is the
same six files and the same one commit. Read the ASCII warning below before you ever move it.

> ### ⚠ THE HOST MUST BE PURE ASCII
>
> This is a German-first product and you will be tempted by a German word. **Do not put an umlaut
> in the relay domain.** Measured 2026-09-04 by compiling each shell's validator and running one
> value through both:
>
> | configured | pinned by Swift | pinned by Rust |
> |---|---|---|
> | `https://xn--mnchen-3ya.example.org` | `https://münchen.example.org` (U-label) | `https://xn--mnchen-3ya.example.org` (A-label) |
>
> `src/js/platform/net.js:265` sends the **A-label**, so Rust agrees with the page and Swift does
> not: every family request in the macOS shell is refused for ever as
> `url_is_not_the_canonical_rebuild`. `release-gate.test.js` cannot see it — it compares the two
> constants for *equality*, and they *are* equal; the divergence is in how each shell **parses**
> the identical string. `shell-macos/main.swift:962` is the half that is wrong if you ever want to
> allow one.

**Done when:** `node scripts/mom-test-probe.mjs` exits **0** and no row says `FAIL`.
**Measured 2026-09-05: exit 0 · `41 rows · 39 pass · 2 note · 0 FAIL`.** `M2s` — the reserved relay
slot that was red *by design* until a host was claimed — is a pass. The two remaining `note` rows
are `H13`/`H14`, the honest-shortfall paste cases, and were always notes.

---

## §2 · ✅ DEPLOYED 2026-09-05 — and here is exactly how far "proved" goes

> **What this section said until today:**
>
> > "**Only you can do this: Vercel account, Prisma Postgres, a `DATABASE_URL`.**
> > `node .github/scripts/check-server-config.mjs` today exits **0** with `39 passed · 0 failed ·
> > 2 not checked here`."

**The relay is live.** Root Directory `server`, region `fra1`, Prisma Postgres in `eu-central-1`,
`DATABASE_URL` in Production carrying `connection_limit=1` (`adapters/prisma.js:180-184` throws
otherwise, by design — ADR 003 §10 risk R3). Both migrations — `20260903092140_init` and
`20260905101500_report` — are applied by `vercel-build.sh`'s `prisma migrate deploy`, which runs
only when `VERCEL_ENV=production` or Preview has been declared isolated.

**Measured from outside, 2026-09-05, and reproducible in one line each:**

```
$ curl -si https://langzeitplaner.vercel.app/api/v1/meta
HTTP/2 200 · x-vercel-id: fra1::fra1::…
cache-control: no-store · strict-transport-security: max-age=63072000; includeSubDomains
x-content-type-options: nosniff · referrer-policy: no-referrer
x-lzp-protocol: 1 · x-lzp-min-protocol: 1
{"region":"fra1","minProto":1,"maxProto":1,"serverTime":…}

$ curl -si -H 'Origin: https://evil.example' …/api/v1/meta | grep -i access-control
(nothing — no CORS header of any kind, which is 21.5's whole point)

$ curl -s -X POST -H 'X-LZP-Protocol: 1' -d '{}' …/api/v1/feedback
400 {"error":"bad_request","unexpectedField":"v"}      ← the LZP-1009 route IS deployed
$ curl -s …/api/v1/nope
404 {"error":"not_found"}
```

`node .github/scripts/check-server-config.mjs` now reads **40 passed · 0 failed · 0 warnings · 2
not checked here.**

**⚠ Four things this does NOT prove, and each has to stay named.**

1. **L1 and L2 are still stated skips.** *Migrations applied* and *schema-vs-migration drift* are
   not checkable offline, and `--deep` has never been run against the deployed database. That the
   relay answers is evidence the deploy succeeded; it is not the check.

   ```bash
   cd server && npm ci
   DATABASE_URL="…?connection_limit=1" SHADOW_DATABASE_URL="…" \
     node ../.github/scripts/check-server-config.mjs --deep
   ```
2. **The adapter has met a laptop's PostgreSQL, not Frankfurt's pooler** (R-8b). 66 of 66 contract
   cases against PostgreSQL 17.10 — but a transaction-mode pooler can refuse an interactive
   `$transaction` or silently downgrade `Serializable`, and every atomicity guarantee rests on
   getting one. `RUNBOOK.md` §2.5.1 against the **deployed** database, and
   `LZP_CONTRACT_DATABASE_URL=… npm run test:server` — **never** `DATABASE_URL`, the harness
   `TRUNCATE`s.
3. **`U-REPORTONCE` and `U-REPORTTTL` have no database witness at all**
   (`server/adapters/prisma.js:938-939`). Whether Prisma binds a JS `Date` correctly against this
   schema's `TIMESTAMP(3)` decides whether the 90-day retention is off by the session's timezone
   offset — an hour in Frankfurt for half the year, which is D2's own region — and nothing visibly
   fails when it is: reports live an hour longer or vanish an hour early, and the number in the
   Datenschutz copy is quietly false.
4. **A 202 on an unsigned report does not settle `U-RAWBODY`.** The claim is that the request
   reaching the handler is an unconsumed stream, so buffering yields the exact **signed** bytes.
   An unsigned report never reaches `verifySignature`, and a platform body parser would produce a
   byte-identical `JSON.parse`. `U-RAWBODY` needs one **signed** request answering 200/202 —
   that is what `RELEASE-CHECKLIST.md`'s *"one authenticated request returned 200"* means, and its
   failure mode is a total outage: every signature fails.

And the asymmetry the checklist opens with, unchanged and now live: **a server deploy has no tag,
no release page and no version dialog.** `git push main` deploys it and nothing announces that it
happened — and `vercel.json`'s `ignoreCommand` means a commit that touches nothing under `server/`
deploys nothing at all, so the relay can legitimately be running an older commit than `main`. If
you only ever watch the tag, you will not notice the deploy that broke the relay.

---

## §3 · The first run — walked under D1, and re-headed now that D1 is gone

> ### ██ RE-FRAMED 2026-09-05 · THIS IS NOW THE FALLBACK, NOT THE PATH ██
>
> Every row below was measured on 2026-09-04 against an **ad-hoc-signed** artifact, under D1. D1 is
> reversed (§0). On the artifact that ships next, **step 5 does not happen**: `spctl` says
> `accepted / source=Notarized Developer ID`, macOS opens the app, and steps 6 and 7 are never
> reached.
>
> **The table is kept, unedited, for three reasons and not out of sentiment:**
>
> 1. **It is what she meets the day the certificate lapses.** A Developer ID expires on a date. The
>    renewal is an invoice, and an invoice can be missed while the fleet keeps updating itself.
> 2. **It is the only walked measurement of the artifact-to-stranger path this project has.**
>    Steps 1–4 and 6–7 are unchanged by signing: the mail is the same 4 321 B, the DMG is the same
>    2.33 MiB, quarantine still rides on the file and not its contents, and the read-me still opens
>    in Safari without a prompt.
> 3. **The ordering trap in it is not a Gatekeeper fact.** *"The app on the image and the app in
>    Programme are two different objects to Gatekeeper"* stays true under a Developer ID; it simply
>    stops mattering, because both objects are now accepted.
>
> **What changes in the copy:** `unlockLead`, `unlockNote`, `Bitte zuerst lesen.html` and the
> e-mail's step 3 now describe a situation a reader will normally never meet. They keep their hard
> gates in `release.yml` — `:515` fails the build if the read-me is not on the mounted image — and
> `RELEASE.md` §8.4 is the reasoning for keeping them.

This was walked end to end on 2026-09-04 on the real artifact, **under D1**. Steps 1–2 and 4–6 are
measured; where something could not be executed here it says so rather than claiming a pass.

| | she does | she gets | how we know |
|---|---|---|---|
| 1 | opens the mail | 4 321 B of German: three headed steps, the code, the address, and step 3 warning her about the security wall *before* she meets it | `build/email/invitation.de.txt`, read start to finish |
| 2 | downloads `LangzeitPlaner.dmg` | 2.33 MiB. Fits any mailbox — ~3.32 MB base64, against Gmail's 25 MB | `stat -f%z` on the built image |
| 3 | double-clicks the DMG | a 660×420 window: app icon left, „Programme" right, an arrow between them, **and `Bitte zuerst lesen.html` beside them** | mounted; 4 entries, listed in the report |
| 4 | drags the app to Programme | the copy is stamped `com.apple.quarantine 0283;…` at copy time | `xattr -p` before and after `cp -R` |
| 5 | double-clicks the app | **Gatekeeper refuses it** — `spctl` → `rejected`, rc=3 | measured; the *dialog wording* is NOT verified here, see §6 |
| 6 | opens the read-me in the DMG window | 20 301 B, Safari, no Gatekeeper prompt, German then English, both illustrations | rendered and read as its audience |
| 7 | follows it | Apple-Menü → Systemeinstellungen → Datenschutz & Sicherheit → „Sicherheit" → „Dennoch öffnen" → „Öffnen" → Passwort | the path is correct for macOS 26.6.2 |

> **The in-app unlock screen never presents itself unasked.** `gatekeeper_status` is implemented
> in neither shell (`firstrun.js:37,117`), so LZP-106's automatic path is dark. That is why step 6
> is the load-bearing one: **the page on the DMG is not a second surface, it is the only one** that
> reaches her without her going looking for it. If you ship a DMG without it, a blocked reader has
> a window containing an app icon, a folder, and nothing that explains the warning.
>
> **Amended 2026-09-05.** Under a Developer ID nobody is blocked, so nothing above fires on a
> normal first run. It stays exactly as written, because it is the certificate-expiry fallback —
> and note what that means for LZP-106's dark automatic path: **it is dark on the one day it would
> be needed.** The page on the DMG is not merely the first surface any more, it is still the
> *only* one, and it now has to survive a year of nobody looking at it. That is what the gates in
> `release.yml` and `check-dmg-readme.mjs` are for: a fallback nobody exercises is a fallback that
> rots, and the only thing standing between this one and rot is a build that refuses to publish
> without it.

### The two things that changed on 2026-09-04, and why

**The ordering trap.** Quarantine rides on the `.dmg` **file**, not its contents. Mount a
downloaded image and *nothing* inside carries `com.apple.quarantine` — not the volume root, not the
`.app`, not one file inside the bundle (checked recursively). Copy the app off and the copy is
stamped. So the app on the image and the app in Programme are two different objects to Gatekeeper,
and approving the first does not approve the second. Somebody who opens it from the DMG window can
see it work, drag it across afterwards, and hit the wall a *second* time on a copy she believes she
already unlocked — at which point the screen that promised to ask "once" has asked twice and the
instructions look wrong. `unlockLead` now names the order in both languages.

**The word „beschädigt".** A quarantined ad-hoc bundle can present as „ist beschädigt und kann
nicht geöffnet werden", with a **Papierkorb** button and sometimes no „Dennoch öffnen" at all.
**This could not be reproduced here** — see §6 — so it is an unverified possibility, not a known
behaviour. It is named anyway, because the asymmetry is total: one sentence against her putting
the app in the Trash, which is the one unrecoverable outcome on this screen.

---

## §4 · Rule on what only you can rule on — three of four are ruled

None of these is an engineering choice, and each has copy or a test row waiting on it.

**✅ D10 / story 21.5 — RULED 2026-09-04/05: a solo Mac may send.**

> **What stood here:** *"the amendment may have bought nothing. D10 amended a measured property
> ("zero requests" → "zero **unrequested** requests") to keep „Rückmeldung senden" working for the
> one tester with no Familienkreis. **As shipped, the code refuses her anyway**: the feedback port
> is bound only inside the family door (`family/mount.js#bindFeedback`, behind
> `if (!hasPersonal && !hasCircle) return;`). So either the gate is wrong and the button should
> work solo — because your mother is solo until she joins — or the amendment bought nothing and
> D10 should be revisited. `soloBody` changes with whichever way you rule. This is D-E / D-F."*

The first horn was taken. `src/js/feedback/relay.js#bindSoloSender` is a second caller of
`setFeedbackPort` and the second dynamic door out of the boot graph — onto `platform/net.js` and
nothing else, never `crypto/`, `sync/` or `family/`. D10's amendment stops being vacuous, `soloBody`
was rewritten, and `e13-datenschutz.dom.js` §1b/§1c now hold the **opposite** sentence with the old
one pinned as a mutant that must die. D-E and D-F are closed with it.

**✅ Repository visibility — RULED 2026-09-05: PUBLIC.**

> **What stood here:** *"Public, or private with a fallback download link she can reach without a
> GitHub account? Decide **before** the mail is designed, not after she meets a login page."*

The e-mail's fallback link was the *stated* reason and it is the smaller one. The real reason is
that the updater's manifest fetch is an unauthenticated GET with no token anywhere in either shell,
so a private repository deletes the self-update channel silently, for every client, for ever —
`RELEASE.md` §2.1 has the two measurements and the gate.

**✅ D1 — RULED and EXECUTED 2026-09-05.** §0 above. The 99 € was spent.

**⚠ D-G / F10 — the backwards-folded interval. STILL OPEN, and still yours.** What it projects as,
and whether the repair should raise 18.5's suppressed notice. `e9-attack-restore.test.js` still
disagrees with itself: `:37` says OPEN, `:256` says CLOSED. Land the ruling and that disagreement
resolves. Nothing in this round touched it.

---

## §5 · The mechanical release, in order

Each step here is blocked by the one above it.

1. ~~**Create the GitHub repo and push.** The tree is local-only: `git remote -v` is empty,
   `git tag` is empty, no workflow has ever run.~~ **✅ DONE 2026-09-05.** `origin` →
   `github.com/manuelhein2016-hash/langzeitplaner`, **public**, on `main`; `ci.yml` runs on every
   push, including `shell-rust` on macos-14, which is the only proof `src-tauri` compiles. Still
   true: **`git tag` is empty and the release workflow has never run.** Protect `main` now if you
   have not — anyone who can push a tag can install code on Mom's Mac.
2. **Generate the updater keypair** — `cargo tauri signer generate`. Then:
   - `src-tauri/tauri.conf.json:66` `plugins.updater.pubkey` — literally
     `REPLACE_ME__run_cargo_tauri_signer_generate__see_docs_v2_RELEASE.md` today.
     `check-release-config.mjs --strict` correctly exits **1** on it.
   - `src-tauri/tauri.conf.json:64` endpoints — still says `OWNER/REPO`. **This one is rewritten
     for you** by `release.yml`'s step 3, from `GITHUB_REPOSITORY`, so the shipped app can only
     ever poll the repository it was built from.
   - ~~`shell-macos/main.swift:227` `UPDATE_MANIFEST_URL` — still says `OWNER-PLACEHOLDER`.~~
     **✅ DONE 2026-09-05** — `main.swift:235` now holds the real slug. The Swift shell is *not*
     built by that workflow, so nothing rewrites it and it had to be correct in the file.
     `main.swift:586-591` refuses the fetch outright while either the key is empty or the
     placeholder is present, which is the right failure mode: **no key, no installs.**
   - Secrets `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
   - **Plus the seven Apple names** — three secrets and four variables, `RELEASE.md` §8.1. These
     are no longer optional; `ENABLE_APPLE_SIGNING` must be `true`.

   Measured 2026-09-05: `check-release-config.mjs --tag v2.0.0` exits 0 with four **notes** and
   nine green shell/pipeline rows — the notes are exactly the two placeholders above plus
   `SH-KEY` (empty `UPDATER_PUBLIC_KEY_B64`) and `SH-SLUG` (skipped because there is nothing to
   compare against until the endpoint is rewritten in CI). `--strict` refuses to release on them,
   which is correct.
2b. **Enrol yourself as the relay's operator — and the two halves go in the order below, not the
   order they are usually written in.** This step was missing from every previous issue of this
   document. Without it the feedback channel lands reports on the relay and **there is no screen
   anywhere that can read them**.

   `RELEASE-CHECKLIST.md:126-141` covers the `LZP_REPORTS_ADMIN_PUB` half properly — the variable,
   the 86 base64url characters, the deliberate 405→404 change on a live endpoint, the
   `ADMIN_PROVES_NOT[0]` caveat, and the right confirmation (one **signed** `GET
   /api/v1/feedback` returning 200). **What it never names, anywhere in the file, is
   `reportsAdmin`** — measured: zero occurrences. So its own instruction, *"from ⚙ → Berichte →
   „Mein Schlüssel""*, is as written **unfollowable**: that section is not on the screen until the
   flag is set, and nothing in the product ever sets it.

   The usual phrasing — *"set `LZP_REPORTS_ADMIN_PUB` from the admin view's copy button, and set
   `reportsAdmin: true` in your board.json"* — **states the two halves in the impossible order.**
   The copy button lives *inside* the admin view, and the admin view is what the flag unlocks.
   Read from the code, not from memory:

   - `src/js/feedback/admin.js:111` — `reportsAdminEnabled()` is
     `settings().reportsAdmin === true`, and `settings.js:453` draws **nothing** unless it is.
     Nothing under `src/js/` ever writes that pref, by design (D12a), so no sequence of clicks
     reaches it on anybody else's Mac — **and none reaches it on yours either.**
   - `admin.js:277-284` — the key string and its „Kopieren" button render only `if (cred)`.
   - `family/mount.js:581` — `cred` is set by `setReportsCredential({ devicePub, sign })`, which
     runs inside the **Familienkreis mount**. The German copy says so on screen
     (`feedback/copy.js` `aNoKey`): *"Er entsteht erst mit einem Familienkreis."*

   So the real order is **flag → Familienkreis → copy → Vercel**:

   1. Quit the app. Edit `board.json` in your Application Support directory by hand and add
      `"reportsAdmin": true` to `settings`. Once, on your Mac only.
   2. Launch. You need a **Familienkreis on this Mac** for a device key to exist at all — if you
      have not made one yet, the section will render with a „—" and the sentence explaining why.
   3. Einstellungen → **Berichte** → „Kopieren". That string is `devicePub`; it is not a second
      key, it is the same device signing key the sender already uses (`mount.js:575`).
   4. Paste it into the Vercel project as **`LZP_REPORTS_ADMIN_PUB`** and redeploy.

   **How you know it worked, and what proves nothing.** A relay with no operator configured
   answers **404** on all three reports routes — deliberately, before the credential is parsed, so
   the reply cannot depend on what was presented (D12b). That means `GET /api/v1/feedback` → 404
   is **evidence of nothing**: unconfigured and undeployed are the same answer by design.
   Measured on production this pass, with no operator enrolled: `GET /api/v1/meta` → 200 from
   `fra1`, `/api/v1/nope` → 404. The only honest confirmation is the one the checklist already
   names — **one signed `GET /api/v1/feedback` returning 200** — or the admin view listing a
   report you know you sent.

   **What this does not defend against, stated on the wire as `ADMIN_PROVES_NOT[0]`:** whoever can
   set this relay's environment variables can read its database directly. It is a control against
   the internet, not against Vercel.

3. **Run `workflow_dispatch` and get it green before any real tag.** `cargo tauri build` has
   *never run anywhere*. What is now known: the crate **compiles** (rustc 1.98.1, `cargo check
   --all-targets --locked` with `-D warnings` → exit 0), and it did **not** before 2026-09-04 —
   `Cargo.toml` declared `macos-private-api` while `tauri.conf.json` declared
   `"macOSPrivateApi": false`, and `tauri-build` aborts on the mismatch **in build.rs, before rustc
   reads a line of source**. On a tag that would have failed 25–40 minutes in, with the family
   waiting. `ci.yml`'s `shell-rust` job now runs it on every push.
   **Still unrun:** the universal x86_64+arm64 build (the Intel half has never been compiled by
   anybody), the bundler, and the DMG the bundler produces.
4. **Watch the DMG size gate.** Warn 14.7 MB / fail 20 MiB. The hand-built arm64-only image is
   2.33 MiB — comfortable — but the **arm64 release binary alone is 10.0 MB**, so a universal
   binary is ≈20 MB *before* DMG compression. **That gate is far closer than anyone has assumed**
   and it may fire on the first real universal build.
5. **Tag a PRERELEASE first, and push it BY NAME.**

   ```bash
   git tag v2.0.0-rc.1
   git push origin v2.0.0-rc.1        # ← by name. NOT `git push --tags`.
   ```

   > **Corrected 2026-09-05. What this line said:** *"**Tag it.** `git tag v2.0.0 && git push
   > --tags`."*
   >
   > **`git push --tags` pushes every tag in your local repository**, not the one you just made —
   > including anything left over from an experiment, a rehearsal, or a colleague's fetch. Every
   > tag matching `v[0-9]+.[0-9]+.[0-9]+` or `v…-*` **starts a release run** (`release.yml:49-51`),
   > and a release run publishes to GitHub Releases and moves the fleet. Naming the tag is the
   > difference between one release and every release you have ever half-made. `RELEASE.md` §3
   > already had this right; this line did not.
   >
   > **And go through `-rc.1` first.** `releases/latest/download/latest.json` does **not** resolve
   > to a prerelease, so no installed app is offered it — that is the safety valve that makes an
   > untested Tauri shell acceptable, and `release.yml`'s step 15 skips the published-manifest
   > check on a prerelease for the same reason. Install the rc yourself, confirm it opens the same
   > **19 notes / 9 bars / 6 categories / 2 scratchpads** board from the same directory, *then*
   > `git tag v2.0.0 && git push origin v2.0.0`.

6. **Download the DMG from the release page yourself, on a Mac that has never seen this app**, and
   walk §3 as she will. This is the step nothing here can substitute for; see §6. Under signing
   the three questions to ask of what you downloaded are `spctl --assess --type open --context
   context:primary-signature` on the **image**, `spctl --assess --type execute` on the app, and
   `xcrun stapler validate` on both — the same three the pipeline now asks.
7. **Send the mail.**
8. **Run the Mom test** — `docs/v2/MOM-TEST.md`, LZP-1006. A real person, a clean Mac, unassisted,
   you not touching the keyboard.

---

## §6 · What could NOT be measured here, stated plainly

These are not open tickets. They are the honest boundary of what this machine could observe, and
each one is a thing you will learn on first contact.

- **The Gatekeeper dialog she actually sees.** The quarantined bundle was launched here and it
  **ran** — translocated, no prompt, `open` rc=0 — including with a CDHash this Mac had never
  seen. But `spctl --status` says `assessments enabled`, so that is not Gatekeeper being off: the
  responsible process for anything this session launches is Claude Code, which plausibly holds the
  **Developer Tools** TCC exemption ("allow this app to run software that does not meet the system
  security policy"). `TCC.db` is SIP-protected and could not be read to confirm it. **So no local
  launch measures what her Mac will do**, the „beschädigt" wording stays unverified, and step 5 of
  §3 rests on the `spctl` verdict alone. Step 6 of §5 is the measurement that settles it.
- **That the DMG window *looks* right.** Finder automation is refused on this machine (`-1743`,
  reproduced), so no locally built image carries a `.DS_Store` and the window opens unstyled here.
  CI *can* drive Finder — the existing `.DS_Store` gate in `release.yml` proves it — and the
  injector warns loudly if it ever cannot.
- **The read-me's icon position under a real Finder.** (304, 70) is measured against the artwork,
  not chosen: every candidate centre was scanned, **zero clear the app box, the Applications box
  and the painted art all three**. (304, 70) clears both Finder items completely and grazes the
  arrowhead by 115 px² of 20 024 (0.6%). Growing `windowSize` fixes it properly, and the
  `NO-OVERLAP` row stays green when the window widens, so it will not block that change.
- **The Rust shell has never been *run*.** It compiles and links, and its origin validator was
  executed against the 28-row table (26/28 vs Swift; the 2 gaps are exactly the headless dev
  carve-out). But no `sync_request` has crossed a socket, no window has opened, no Keychain has
  been touched — and because `lib.rs:794` has no headless hook, **no existing harness can point it
  at a test relay**. Tier 2 can never cover it.
- ~~**DMG re-signing after read-me injection is dead code under D1 and untested.** If you ever
  enable real signing, the notarization staple must be produced *after* the injection step.~~
  **Half-closed 2026-09-05.** The instruction is now *executed* rather than printed:
  `dmg-add-readme.sh` re-signs with `--options runtime --timestamp` and says in the log that the
  image has no ticket **by construction**, and `release.yml` step 9b submits, staples and validates
  it immediately afterwards and before every gate that inspects the DMG. `check-release-config.mjs`
  rows `N-ORDER`/`N-STAPLE`/`N-RUNTIME` fail the pre-flight if that step is removed or reordered.
  **Still untested:** the branch has never executed — it was dead under D1 because
  `APPLE_SIGNING_IDENTITY` was always `-`, and it is live and unrun now.
- **NEW · which ticket rides where, measured rather than reasoned.** The notarization ticket for an
  app bundle is a file *inside* the bundle (`Contents/CodeResources`, beside
  `Contents/_CodeSignature/` — listed on the stapled app in `/Applications`), so the `.app`'s
  ticket survives being copied into a rewritten image. A **DMG-level** staple does not. That is why
  step 9b validates **both**, and why the Gatekeeper gate asks `--type open --context
  context:primary-signature` of the image separately: **the app can be perfectly notarized while
  the image around it is not**, and the image is what arrives in her mailbox.
- **The eight human-only v1 stories.** Still about twenty minutes with the app open, still the
  cheapest missing evidence in the project.

---

## §7 · The gates were run, and two of them were broken

**New 2026-09-05, integration pass.** §5 step 3 says the pipeline "has not been asked to perform
the incantation once". It still has not — but the two steps that carry it, 9b (notarize, staple,
validate) and 10 (mount, assess), were extracted from `release.yml` **verbatim** and executed on
this Mac against real fixtures: the real notarized-and-stapled `/Applications/LangzeitPlaner.app`,
real DMGs built around it, real `codesign`, real `hdiutil`, real `stapler`, real `spctl`. Only
`notarytool` was scripted, because it needs an Apple account.

**A gate nobody has seen fail is not a gate. Two of these had never been seen at all — and a
third was found by the first CI run that had ever executed these tests.**

### The two defects, both fatal, both found by using a real tool instead of a stub

**1 · The hardened-runtime assertion failed on a correctly hardened bundle.** `release.yml:404`
shipped as:

```bash
if ! codesign -d --verbose=2 "$APP" 2>&1 | grep -q 'flags=.*runtime'; then
```

`codesign -d --verbose=2` prints sixteen lines; `flags=0x10000(runtime)` is the fourth. `grep -q`
exits the instant it matches and closes the read end, so codesign takes **SIGPIPE** on the fifth.
Measured on the real app:

```
pipeline rc=141   PIPESTATUS=(141 0)          141 = 128 + SIGPIPE
```

The step runs `set -euo pipefail`, so 141 is the pipeline's status and `if !` fires. **The first
signed release would have hard-failed at the first assertion of the notarization step, printing
"carries no hardened-runtime flag" directly above a dump reading `flags=0x10000(runtime)`.** A gate
that fails closed on the honest path is not a stricter gate; it is a pipeline that cannot ship.

It survived review because **a stubbed `codesign` writes little and exits before its reader does,
and never raises SIGPIPE.** The defect is invisible to any harness that does not use the real tool
— which is exactly what the prior pass's twelve-of-twelve green stub run was.

Fixed by capturing to a file and grepping the file, which is what step 10 already does with
`spctl`, for this reason. Pinned by pre-flight row **`N-SIGPIPE`** and by `release-gate.test.js`
§5l/§5m; §5p is the negative control that keeps the corrected step legally able to **quote the
defective line** while explaining itself.

**2 · The staple was the one failure in the step that said nothing.** `xcrun stapler staple
"$DMG"` ran bare. Measured against a DMG Apple has no record of:

```
CloudKit query for … failed due to "Record not found".
The staple and validate action failed! Error 65.
```

GitHub runs a `run:` block with no `shell:` key under **`bash -e`** — `set -e` on, **pipefail
off** — so that ends the step at exit 65 with no `::error`, showing only *"Process completed with
exit code 65"* while the cause sits four lines up in a collapsed section. And this failure is not
hypothetical after an `Accepted` verdict: the ticket is fetched from Apple's CDN, and *"Record not
found"* moments after acceptance is **propagation lag, which is a re-run and not a rebuild.**
Nobody re-runs a raw 65. Now named, and the message says which it is. Pinned by **`N-STAPLE-LOUD`**
and §5n/§5o.

> `N-STAPLE` stayed green through both — the command is present, and that is all it ever asked.
> These are second rows rather than clauses of that one because "the command is there" and "the
> command's verdict reaches the log" are different questions, and the first eight rows only asked
> the first.

### What was demonstrated failing, and what stayed green

Every line below is an exit code from the shipped step text.

| state constructed | the step that dies | how |
|---|---|---|
| Apple returns `Invalid` | 9b · `Notarization failed` | exit 1, log printed |
| `notarytool` returns no JSON at all | 9b · `Notarization failed` | `status=<none>`, exit 1 |
| the `.app` has no hardened runtime | 9b · `No hardened runtime` | real ad-hoc re-signed app |
| `Accepted`, but the ticket will not staple | 9b · `Stapling the DMG failed` | real `stapler`, exit 1 |
| the DMG is ticketed, the `.app` is not | 9b · `The .app carries no notarization ticket` | real `stapler`, exit 1 |
| **the app is notarized, the IMAGE is not** | 10 · `Gatekeeper rejects the downloaded image` | **see below** |
| the app inside is ad-hoc signed | 10 · `Gatekeeper rejects the app` | real `spctl`, exit 3 → 1 |
| `accepted` without `source=Notarized Developer ID` | 10 · `Accepted, but not as a notarized app` | `spctl` scripted |
| the read-me is missing from the image | 10 · `DMG has no instructions on it` | exit 1 |
| **ad-hoc branch, the same rejected image** | **nothing — exit 0** | the fallback survives |

**The sixth row is the one that justifies the whole section.** The `.app` inside that image is
genuinely notarized — real `spctl` returned `accepted / source=Notarized Developer ID` on it — and
the gate still fails, because the image around it is `rejected / source=no usable signature`. That
is precisely the read-me-injection hazard: **the app can be perfectly notarized while the image
that arrives in her mailbox is not**, and the old `spctl … || true` could not see the difference.

The last row is the certificate-expiry fallback, and it is not a rounding error: the identical
rejected image, on the ad-hoc branch, exits **0**. `rejected` is the correct answer with no
Developer ID, and failing on it would mean no build at all on the day the certificate lapses.

### A measurement worth keeping

Re-signing an already-stapled `.app` ad hoc leaves the ticket **file** byte-identical —
`Contents/CodeResources` hashes the same before and after — and `stapler validate` still goes from
**rc=0 to rc=65**. The ticket binds to the code-directory hash, not to the bytes beside it. So
"`codesign --force` can put a signature back and cannot put a staple back" is not a figure of
speech, and a check that merely looked for the ticket file would have been satisfied.

### The staging step, run against a real `dist/`

`node scripts/build-frontend.mjs` → 83 files, 3 598 KiB, and `dist/*` expands to `dist/index.html`
plus **`dist/src`, a directory**. Both staging steps were then run over it.

| | exit | what `SHA256SUMS.txt` carried |
|---|---|---|
| **old** step (`mkdir -p dist`, `shasum dist/* \| tee`) | **0 — green** | 4 lines, including `dist/index.html`; `shasum: dist/src: Is a directory` swallowed |
| **new** step (`STAGE=build/release`, redirect, `pipefail`) | 0 | 3 lines, bare asset names, and it does not list itself |

And it now fails when it should, in three independent places:

- a directory in the staging tree → `::error … Staging tree has a non-file`, **exit 1**;
- with that guard *deleted*, `pipefail` + the redirect still fail the step, because `shasum`'s
  status is now the step's — **exit 1**;
- restore **both** the missing `pipefail` **and** the `| tee`, and it goes back to **exit 0** with
  the `.sig` silently missing from the published list. That is the original bug, reproduced.

`dist/` is byte-identical before and after the new step (83 files, same tree digest): the collision
is gone rather than narrowed.

### What this still does not prove

- **Nothing has run against Apple.** No runner, no certificate, no submission. `--wait
  --timeout 30m`, the `--output-format json` field names and `stapler validate`'s exit behaviour
  come from the documented CLI and from these fixtures, not from a real notarization.
- **No `cargo tauri build` has ever run**, here or anywhere, so no real DMG, `.app.tar.gz` or
  `latest.json` has ever existed to notarize or to stage. Everything above is the pipeline's
  *shape*, exercised on stand-ins.
- **The `.app` staple ordering is a hard fail, not a repair.** Tauri stapling the `.app` before it
  builds the DMG is what makes the copy *inside* the image ticketed. Step 9b cannot fix that after
  the fact and says so. If Tauri turns out not to staple, **the first signed run stops there** —
  correct, but it means the failure to expect is `The .app carries no notarization ticket`, and the
  fix is the bundler step, not step 9b.
- **The fixture harness is not committed.** Tier 1 bans `node:fs`, so a repo version needs a file
  outside the four this pass owns. The *predicates* are committed (`N-SIGPIPE`, `N-STAPLE-LOUD`,
  §5l–§5p); the fixtures are not. Worth a ticket.

### And a third defect, which only the first push could find

The two above were found on this Mac. **The third was found by CI, on the first run that had ever
seen these tests** — `release-gate.test.js` §5/§6 and `release-staging.test.js` were both
uncommitted until this pass, so no runner had executed a line of them.

`§6e` asserted that an unresolved updater endpoint makes `SH-SLUG` report **SKIP**. True on a
laptop. **False on a runner**, because `ci.yml` sets `GITHUB_REPOSITORY` while `tauri.conf.json`
still holds `OWNER/REPO`, and the pre-flight then falls back to that variable — which is the whole
purpose of the fallback, and `PASS` is the correct verdict there. **The row was right and the test
was wrong:** it inherited the environment, so it asserted a different thing depending on who ran it.

Both `§6e` and `§6f` now name the environment they mean, and `preflightRows` takes an override.
Verified under all three: `GITHUB_REPOSITORY` unset, set to this repository, and set to a fork —
**42/42 in every one**. A fork's disagreeing slug is a real finding and it is now its own case,
`§6e(c)`, which asserts `SH-SLUG` **FAIL**s there: a fork builds a Tauri app pointing at itself
while the Swift shell still polls the original, and that is exactly the half-updated fleet the row
exists for.

> The lesson is the same one as the SIGPIPE defect, in a different costume: **a gate is only as
> good as the environment it was last run in.** These three were all found by running the thing
> rather than reading it, and two of the three could not have been found any other way.

### One latent hazard, named and not fixed

`scripts/build-unlock-page.sh:56` runs `printf '%s' "$RAW" | grep -q '^# pass 1$'` under
`set -euo pipefail` — the same construction. It has never fired and cannot today: `$RAW` is one
harness's TAP output, far under the 64 KiB pipe buffer, so `printf` completes before the reader
leaves. Measured: at 200 000 bytes the identical line **does** abort. Not this pass's file, and the
payload is bounded, so it is recorded rather than changed.

---

## The short version, if you read nothing else — re-issued 2026-09-05

**Everything an agent could do is done.** What is left is eight things, and every one of them
needs your password, your keyboard, or your judgement. They are listed in the order they unblock
each other; nothing below can be started before the line above it is finished.

```
DONE — and each of these has a measurement behind it, not an assurance
  ✅ D1 ruled and executed.       ZZ77R3LWS4 · accepted / source=Notarized Developer ID · stapled
  ✅ Relay host claimed.          langzeitplaner.vercel.app · pure ASCII · six files, one commit
  ✅ Relay deployed and LIVE.     200 from fra1 · both migrations applied · 40/0/2 readiness
  ✅ Repo public, CI green.       github.com/manuelhein2016-hash/langzeitplaner, on main
  ✅ D10 + visibility ruled.      solo may send · repository is public
  ✅ Release wiring exists.       notarize+staple+validate asserted; spctl is a hard gate signed,
                                  `|| true` ad hoc; staging no longer collides with dist/
  ✅ The gates were run failing.  §7 — ten constructed states, each dying at its named step

STILL YOURS — in this order
 1. Generate the updater keypair.   `cargo tauri signer generate -w ~/.langzeitplaner-updater.key`
                                    It asks for a password. Choose one; do not leave it empty.
 2. Paste three values.             tauri.conf.json:66 pubkey (PUBLIC half) — commit it
                                    secret TAURI_SIGNING_PRIVATE_KEY (PRIVATE half)
                                    secret TAURI_SIGNING_PRIVATE_KEY_PASSWORD
                                    AND main.swift:233 UPDATER_PUBLIC_KEY_B64 — same keypair.
                                    Nothing rewrites these. --strict names all three today.
                                    (Plus the 7 Apple names, RELEASE.md §8.1, ENABLE_APPLE_SIGNING=true.)
 3. reportsAdmin: true — FIRST.     By hand, in YOUR board.json, once. Nothing in src/js/ writes it.
 4. Then copy your key.             Einstellungen → Berichte → „Kopieren". Needs a Familienkreis
                                    on this Mac, or the row renders „—". → LZP_REPORTS_ADMIN_PUB
                                    on Vercel, then redeploy. Order matters: see §5 step 2b —
                                    the copy button lives INSIDE the view the flag unlocks.
 5. workflow_dispatch, green.       `cargo tauri build` has STILL never run anywhere. This is the
                                    first real measurement of §7. Watch the DMG size gate: the
                                    arm64 binary alone is 10.0 MB, so universal is ≈20 MB before
                                    compression and the fail line is 20 MiB.
 6. Tag v2.0.0-rc.1 as a PRERELEASE.
                                    `git tag v2.0.0-rc.1 && git push origin v2.0.0-rc.1`
                                    BY NAME. Never `git push --tags` — every tag you have ever
                                    made would start a release run.
                                    WHY a prerelease: releases/latest/download/latest.json does
                                    not resolve to one, so no installed app is offered it. That
                                    is the safety valve for a Tauri build nobody has ever run.
 7. Install the rc YOURSELF.        On a Mac that has never seen this app. Download it from the
                                    release page — not from build/. Confirm it opens the same
                                    19 notes / 9 bars / 6 categories / 2 scratchpads board from
                                    the same directory. Ask it the three questions §5 step 6 lists.
 8. Only then tag v2.0.0.           Same rule: by name. Then the mail, then the Mom test —
                                    LZP-1006, a real person, a clean Mac, and you not touching
                                    the keyboard. Nothing in this repository can move that one.
```

> **Do not skip 6 before 7.** The rc exists so that the first Tauri bundle anyone has ever run
> lands on **your** Mac and not on hers. If it is wrong, a prerelease costs you an afternoon; a
> release moves the whole fleet, and `main.swift:422-478` replaces an installed bundle in place.

> **What this block said on 2026-09-04:**
>
> ```
> 1.  Rule on D1.                    (99 € deletes the hardest part of her first run)
> 2.  Claim a relay host.            PURE ASCII. Six files, one commit.
> 3.  Deploy the relay, --deep.      L1 and L2 are not a pass until you run them.
> 4.  Rule on D10 and D-G.           Copy and a test row are waiting.
> 5.  Repo, keypair, secrets.        Four placeholders, all named in §5.2.
> 6.  workflow_dispatch green.       cargo tauri build has never run. Watch the size gate.
> 7.  Tag. Download it yourself.     On a Mac that has never seen this app. Walk §3.
> 8.  Send the mail.
> 9.  Run the Mom test — and do not touch the keyboard.
> ```

**The one sentence worth carrying out of this document:** everything that fell today fell because a
person did it by hand, and **`git tag` has still never done any of it.** The pipeline now contains
the incantation; it has not been asked to perform it once.

> **Amended by §7, and the amendment is small but it is the honest one.** The pipeline has now
> been asked to perform *the parts that do not need Apple* — on real fixtures, with the real
> tools — and **two of them were broken**, one fatally: the notarization step's very first
> assertion failed on a correctly signed bundle, so the first `workflow_dispatch` with signing on
> would have gone red for the opposite of the real reason. Both are fixed and pinned. That does not
> make the pipeline proven. It makes it *tested where it could be tested*, and it moves the
> remaining unknown to exactly one place: **what Apple says, and what `cargo tauri build`
> produces.** Step 5 of the list above is where you find out.
