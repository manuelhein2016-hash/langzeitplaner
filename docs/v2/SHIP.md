# SHIP — putting LangzeitPlaner in his mother's hands

| | |
|---|---|
| **Written** | 2026-09-04, at the end of the integration pass that built and mounted the artifacts |
| **Audience** | the PO, and nobody else |
| **Companion to** | `RELEASE-CHECKLIST.md` — the mechanical sheet. This is the *order*, and the *why*. |
| **Scope** | everything between "the tree is green" and "she is using it" |

`RELEASE-CHECKLIST.md` is a sheet you tick. This is the shorter, harder document: **the things
only you can do**, in the order they unblock each other, with the cost of getting each one wrong.
Every number below was measured on 2026-09-04 on the artifacts this tree builds, not asserted.

---

## Where the tree actually stands

```
suites          tier1 2276 · attack 977 · server 1009 (+1 skip) · fleet 482 · property 101
                tier2 904 pass / 3 fail  (§A4, §E1, §E3 — a PO ruling and a spec threshold)
acceptance      5 of 5 runs · 175 launches of the shipped .app · 0 phases failed
                refusal ledger 0 in all five · relaunch battery 8 of 8 in all five
privacy         zero plaintext bytes on a real relay's disk, a tenth time
artifact        build/dmg/LangzeitPlaner.dmg — 2 442 008 B = 2.33 MiB, ~3.32 MB base64
git             0 remotes · 0 tags · no workflow has ever run
```

**The code is not what is blocking this release.** Six things are, and five of them are accounts,
domains and rulings that no agent can perform on your behalf. That is the whole content of this
document.

---

## The one decision that deletes a third of this document

**D1 says ship unsigned.** Everything in §3 below — the guided unlock screen, the standalone page
riding on the DMG, the artwork caption, the two sentences added on 2026-09-04, the e-mail's step 3
— exists *only* because of that decision. Measured on the shipped bundle:

```
codesign --verify              valid on disk · satisfies its Designated Requirement
codesign -dv                   Signature=adhoc · flags=0x2(adhoc)
spctl --assess --type execute  rejected  (rc=3)
syspolicy_check distribution   Adhoc Signed App ......... Severity: Warning
                               Notary Ticket Missing .... Severity: Fatal
```

An Apple Developer ID (99 €/yr) plus notarization turns that `rejected` into `accepted`, and the
first-run wall — the single most likely place for this to fail in front of her — stops existing.
Everything built to walk her past it becomes dead weight you can keep or delete.

**You do not need to revisit D1 to ship.** You need to know that you are choosing the harder first
run to save 99 €, and that the *unverified* part of §3 (the „beschädigt" wording) is a risk that
purchase would remove entirely.

---

## §1 · Claim the relay host — and understand that it is one act

**Only you can do this: it needs a domain or a Vercel account, and a payment method.**

The address in all four invitation mails today is `https://serveradresse-fehlt.invalid`. That is
deliberate — RFC 2606 §2 makes `.invalid` undelegatable, so no stranger can register the thing
your mother has been told to trust. It is also why `mom-test-probe.mjs` exits **1** with
`FAIL M2s`, and why that FAIL is *correct* until this step is done.

The trap that AUDIT F1 found, and that the checklist now guards: **the address is written in six
files, and the four you would naturally think of are the four that nothing reads.**

```bash
# 1 · the four mails — what she reads
sed -i '' 's|https://serveradresse-fehlt\.invalid|https://NEW-HOST|g' docs/v2/email/invitation.*

# 2 · the pinned origin — what every sync_request is rebuilt against, byte for byte
#     shell-macos/main.swift:~790   let SYNC_ORIGIN_BUILTIN = "https://NEW-HOST"
#     src-tauri/src/lib.rs:714      const SYNC_ORIGIN_BUILTIN: &str = "https://NEW-HOST";
```

Do only half and you ship a build where the address she was told to type is read by nothing, and
every family request is refused locally as `no_origin_configured` before a socket exists. The page
cannot route around it — `chooseTransport` returns `bridge` inside the shell and `index.html:14`
is `connect-src 'self'`.

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

**Done when:** `node scripts/mom-test-probe.mjs` exits **0** and prints `41 rows · 41 pass`.

---

## §2 · Deploy the relay, and prove it before you trust it

**Only you can do this: Vercel account, Prisma Postgres, a `DATABASE_URL`.**

`node .github/scripts/check-server-config.mjs` today exits **0** with `39 passed · 0 failed · 2 not
checked here`. Those two are not a pass and the runner says so:

- **L1** — migrations actually applied, adapter actually reachable
- **L2** — schema-vs-migration drift (needs a shadow database)

```bash
cd server && npm ci
DATABASE_URL="…?connection_limit=1" SHADOW_DATABASE_URL="…" \
  node ../.github/scripts/check-server-config.mjs --deep
```

Region is `fra1`. Remember the asymmetry the checklist opens with: **a server deploy has no tag, no
release page and no version dialog.** `git push main` deploys it and nothing announces that it
happened. If you only ever watch the tag, you will not notice the deploy that broke the relay.

---

## §3 · The first run — what actually happens to a stranger

This was walked end to end on 2026-09-04 on the real artifact. Steps 1–2 and 4–6 are measured;
where something could not be executed here it says so rather than claiming a pass.

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

## §4 · Rule on what only you can rule on

None of these is an engineering choice, and each has copy or a test row waiting on it.

**D10 / story 21.5 — the amendment may have bought nothing.** D10 amended a *measured* property
("zero requests" → "zero **unrequested** requests") to keep „Rückmeldung senden" working for the
one tester with no Familienkreis. **As shipped, the code refuses her anyway**: the feedback port is
bound only inside the family door (`family/mount.js#bindFeedback`, behind
`if (!hasPersonal && !hasCircle) return;`). So either the gate is wrong and the button should work
solo — because your mother *is* solo until she joins — or the amendment bought nothing and D10
should be revisited. `soloBody` changes with whichever way you rule. This is D-E / D-F.

**D-G / F10 — the backwards-folded interval.** What it projects as, and whether the repair should
raise 18.5's suppressed notice. `e9-attack-restore.test.js` still disagrees with itself: `:37` says
OPEN, `:256` says CLOSED. Land the ruling and that disagreement resolves.

**Repository visibility.** Public, or private with a fallback download link she can reach without a
GitHub account? Decide **before** the mail is designed, not after she meets a login page.

**D1, one more time.** §0 above. Ship unsigned, or spend 99 €.

---

## §5 · The mechanical release, in order

Each step here is blocked by the one above it.

1. **Create the GitHub repo and push.** The tree is local-only: `git remote -v` is empty,
   `git tag` is empty, no workflow has ever run.
2. **Generate the updater keypair** — `cargo tauri signer generate`. Then:
   - `src-tauri/tauri.conf.json:66` `plugins.updater.pubkey` — literally
     `REPLACE_ME__run_cargo_tauri_signer_generate__see_docs_v2_RELEASE.md` today.
     `check-release-config.mjs --strict` correctly exits **1** on it.
   - `src-tauri/tauri.conf.json:64` endpoints — still says `OWNER/REPO`.
   - `shell-macos/main.swift:227` `UPDATE_MANIFEST_URL` — still says `OWNER-PLACEHOLDER`.
   - Secrets `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
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
5. **Tag it.** `git tag v2.0.0 && git push --tags`.
6. **Download the DMG from the release page yourself, on a Mac that has never seen this app**, and
   walk §3 as she will. This is the step nothing here can substitute for; see §6.
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
- **DMG re-signing after read-me injection is dead code under D1 and untested.** If you ever enable
  real signing, the notarization staple must be produced *after* the injection step.
- **The eight human-only v1 stories.** Still about twenty minutes with the app open, still the
  cheapest missing evidence in the project.

---

## The short version, if you read nothing else

```
1.  Rule on D1.                    (99 € deletes the hardest part of her first run)
2.  Claim a relay host.            PURE ASCII. Six files, one commit.
3.  Deploy the relay, --deep.      L1 and L2 are not a pass until you run them.
4.  Rule on D10 and D-G.           Copy and a test row are waiting.
5.  Repo, keypair, secrets.        Four placeholders, all named in §5.2.
6.  workflow_dispatch green.       cargo tauri build has never run. Watch the size gate.
7.  Tag. Download it yourself.     On a Mac that has never seen this app. Walk §3.
8.  Send the mail.
9.  Run the Mom test — and do not touch the keyboard.
```
