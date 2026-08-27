# E1 — what is proven, and what is merely written

| | |
|---|---|
| **Epic** | E1 — distribution, installation and updates (F22, A11, A12), tickets LZP-101…109 |
| **Written** | 2026-08-27, at the close of the E1 integration pass |
| **Machine** | macOS 15 (Darwin 25.3.0), node v22.23.1, swiftc 6.2, git, gh. **No Rust, no cargo. No GitHub remote. No Apple Developer ID. No Vercel or Prisma account.** |
| **Governing decision** | **PO decision D1 — ship unsigned.** LZP-105 is out of scope; LZP-106 is mandatory. |

This epic has more surface that cannot be exercised on the authoring machine than any other part
of the project. That is not a defect of the work; it is the shape of the problem — a release
pipeline is not testable without the accounts it releases into. What follows separates the two
halves as sharply as the evidence allows.

**Read the middle column, not the ticket titles.** Three states, and only three:

- **VERIFIED-HERE** — something was executed on this machine and its output is quoted or
  reproducible by the command given. A design argument is not verification.
- **WRITTEN-UNVERIFIED** — the code exists and was reviewed, and *nothing on this machine can
  run it*. The reason is named, and so is the exact thing the PO must do.
- **NOT-APPLICABLE (D1)** — dropped by the PO's decision to ship unsigned.

---

## 1. Suite state at the close of integration

All four green, run in this order, against the full working tree:

```
npm test              1359 pass · 0 fail   (100 suites)
npm run test:property   51 pass · 0 fail
npm run test:attack    338 pass · 0 fail   (29 suites)
npm run test:dom       278 pass · 0 fail   (15 files, real WKWebView)
```

Tier 2 by file: board-render 19 · dom-rendering 44 · firstrun-unlock 20 · interaction 32 ·
retrofit-probe 29 · probe2 20 · probe3 11 · probe4 10 · probe5 8 · probe6 7 · probe7 7 ·
shell-bridge 16 · shell-oplog 14 · shell-updater 10 · update-ui 31.

Plus, outside the four suites and specific to this epic:

```
./shell-macos/updater-selftest.sh                    TAP 25/25 PASS   (real swiftc, real Ed25519,
                                                                       real bundle swap)
node .github/scripts/minisign.selftest.mjs           14/14 green
node .github/scripts/check-release-config.mjs        exit 0 (lenient) / exit 1 (--strict, correctly)
node .github/scripts/check-dmg-geometry.mjs          exit 0
node .github/scripts/check-email-copy.mjs            exit 0
node .github/scripts/check-server-config.mjs         exit 0, 5 items reported as *owed* to E2/WP-7
```

---

## 2. Three integration defects found and fixed

The four E1 agents each delivered a green vertical slice. The defects were all in the seams
between them — which is exactly where nobody's tests were looking, because every agent's fixture
supplied the other side by hand.

### 2.1 The published manifest addressed a platform no client looks up — **update pipeline dead**

`.github/scripts/make-update-manifest.mjs` wrote `platforms: { "darwin-aarch64", "darwin-x86_64" }`.
All three clients look up **`darwin-universal`**:

```
src/js/platform/updater.js:98    export const TARGET = 'darwin-universal';
shell-macos/main.swift:213       let UPDATE_TARGET = "darwin-universal"
src-tauri/src/lib.rs:216         const UPDATE_TARGET: &str = "darwin-universal";
```

Proven, not inferred. Feeding the generator's own pre-fix output to the real client parser:

```
PRE-FIX manifest as the client sees it:
  minimumVersion : null
  running 1.0.0 -> status=unsupported-platform outdated=false msg=none
```

Every Mac in the family would have reported `unsupported-platform` on every check, forever, while
CI stayed green. 22.3 and 22.5 would have been false in the shipped product.

**Fixed:** the manifest now lists `darwin-universal` first, with the two per-arch keys as aliases
pointing at the same universal archive. The read-back gate asserts `darwin-universal` **by name**
rather than counting keys, and `release.yml`'s published-manifest comparison does the same.

### 2.2 The 22.7 minimum-version field was spelled differently on the two sides

The generator wrote `minClientVersion`. `parseManifest` accepts `minimum_version` or
`minimumVersion` and nothing else — see the `null` in the trace above. The 22.7 bar, its settings
restatement, and LZP-104's whole minimum-version decision were unreachable from a real release.

**Fixed:** the manifest key is now `minimum_version`. The CLI flag (`--min-client-version`) and the
repository variable (`LZP_MIN_CLIENT_VERSION`) keep their names; `docs/v2/RELEASE.md` §9 and its
unknowns table are corrected. Verified end-to-end against a synthetic signed archive:

```
signature verified (legacy mode, key B5916CF06225D1B3) over 4096 bytes
  version          1.1.0
  minimum_version  1.0.5
  platforms        darwin-universal, darwin-aarch64, darwin-x86_64
→ real client: running 1.0.0 -> status=update-available outdated=true msg=updateRequired(1.0.5)
```

### 2.3 Nothing ever opened the 21.5 consent gate — **the update check never ran**

Both shells implement `update_set_disclosed`, both default `disclosed` to `false`, and both
refuse to fetch a manifest or download a byte until it is `true`. **No JavaScript ever called it.**
`disclosed` would have stayed false on every machine for the life of the product; the launch check
and the daily check stopped at the gate; the tests all passed because every fixture seeded
`disclosed: true` by hand.

LZP-106 flagged this precisely and declined to fix it inside the unlock screen, correctly: that
screen appears only on a launch macOS actually refused, so on a healthy install it would never
run and the gate would never open.

**Fixed** — one function, `discloseUpdateCheck()` in `src/js/update-ui.js`, called from the three
places where the disclosure sentence is on screen and the user has just acted on it:

| surface | who it reaches |
|---|---|
| the welcome card (`maybeFirstRun`, `main.js`) now carries `updateCheckHint`, and dismissing it discloses | a **fresh install** — Mom |
| turning **„Automatisch nach Updates suchen"** on in Settings → Updates | an **existing install**, whose `seenFirstRun` was set long before this feature existed |
| pressing **„Jetzt suchen"** | anyone, at any time |

Never from a timer, never from boot, never from the unlock screen. Five new tier-2 tests
(`update-ui.dom.js` 27–31) hold the line, including one that asserts a launch check does **not**
disclose and that no request leaves the machine when it stops at the gate.

Verified live in the browser against a fake port — the call order is the whole point:

```
["menuHint:null", "setDisclosed:true", "status", "fetchManifest", "download", "menuHint:1.1.0"]
```

---

## 3. The ticket table

| # | ticket | state | evidence, or the exact reason it cannot be verified here |
|---|---|---|---|
| **LZP-101** | Release pipeline: tag → universal DMG + signed update artifacts → GitHub Releases | **WRITTEN-UNVERIFIED** (partly verified) | **Verified here:** all 3 workflows parse as YAML (PyYAML `safe_load`); **36** bash `run:` blocks pass `bash -n`, 0 failures; the entire non-Rust path — pre-flight, signature verification, manifest generation, read-back gate, published-manifest comparison — runs end-to-end against a synthetic minisign-signed archive, correct on the happy path and on wrong-key / missing-sig / empty-sig / version-mismatch. **Cannot be verified:** the `cargo tauri build` at its centre. **PO must:** create the GitHub repo, add `TAURI_SIGNING_PRIVATE_KEY` + `..._PASSWORD`, and run the workflow via `workflow_dispatch` **before** the first real tag. |
| **LZP-102** | Auto-updater client (22.3, 22.5, 22.6) | **VERIFIED-HERE** (Swift + JS) / **WRITTEN-UNVERIFIED** (Tauri) | **Verified here:** `updater-selftest.sh` **25/25** — real `swiftc`, real Ed25519, real tarball, real bundle swap in a scratch dir; a bad signature installs **nothing** (target bundle marker still `OLD-BUILD`) and the poisoned artifact is deleted; a `node:crypto` signature verifies under CryptoKit (cross-implementation); Application Support fingerprinted before and after, untouched. Tier 1 `platform-updater.test.js` 33/33; tier 2 `shell-updater.dom.js` 10/10 over the real bridge. **Cannot be verified:** `src-tauri/src/lib.rs` has never been compiled. **PO must:** on a machine with cargo, confirm `UpdaterExt::updater_builder()`, `version_comparator`, `check()`, and that `Update` exposes `raw_json` / `download()` / `install()`. |
| **LZP-103** | Update UX — the quiet hint, settings section, restart (22.4) | **VERIFIED-HERE** (Swift + browser) / **WRITTEN-UNVERIFIED** (Tauri menu) | **Verified here:** tier 2 `update-ui.dom.js` **31/31** in real WKWebView; both native menus read out of the live `NSMenu` via `--smoke` in both languages and both states; screenshotted DE and EN in a real browser (settings section, 22.7 bar over an intact board), zero console errors. **Cannot be verified:** the Tauri half of the menu, and **the real relaunch** — `relaunchSelf()` (`open -n` + `exit(0)`) is refused in headless runs so tier 2 cannot terminate its own runner. **PO must:** quit-and-return once by hand on a real build. |
| **LZP-104** | Minimum client version (22.7) | **VERIFIED-HERE** | Tier 1 covers the decision and 21 malformed-manifest cases; tier 2 asserts the exact German and English sentence and its DOM position. **This ticket was broken at the seam and is now fixed** — see §2.2. The 22.7 bar itself remains unreachable in a solo install by design (`familyMode` is false until E3/WP-7 lands the family flag); that is 21.5, not a stub. |
| **LZP-105** | Signing and notarization | **NOT-APPLICABLE (D1)** | The PO decided to ship unsigned. Every signing and notarization step is nonetheless **written** in `release.yml` and gated on the repository variable `ENABLE_APPLE_SIGNING`. **Correction to the brief, restated:** reversing D1 costs **3 secrets and 4 variables**, not two secrets — notarization needs its own App Store Connect credential set. The promise that does hold is the one that matters: **no code change.** Full list in `RELEASE.md` §8. |
| **LZP-106** | Guided Systemeinstellungen unlock screen (22.2, A12) | **VERIFIED-HERE** (as a screen) / **UNVERIFIABLE** (in its own situation) | **Verified here:** tier 2 `firstrun-unlock.dom.js` **20/20** in real WKWebView; rendered and screenshotted in DE and EN, zero console errors ⇒ zero CSP violations; no `<img>`, no external URL, no webfont, no inline script; Escape closes it, focus lands on the button, Tab cannot reach the board; not a modal (opaque background, zero `.scrim`); the German label is Apple's own **„Dennoch öffnen"** (support.apple.com de-de/102445), and it now agrees across the screen, `i18n.js`, the DMG art and all four e-mail files. **Cannot be verified:** how it looks *inside a build macOS has actually blocked* — there is no unsigned quarantined build here to be refused by. **See §4 for the gap that matters more.** |
| **LZP-107** | DMG artwork, icons, disk-image layout (22.1) | **VERIFIED-HERE** (mostly) | **Verified here:** artwork built end-to-end from SVG source; a **real DMG built and mounted** — `1 532 565 bytes = 1.46 MiB`, `Applications -> /Applications` present, `.background/background.tiff` present at **660×420**; the `.icns` extracted with `iconutil` and confirmed `hasAlpha: yes` at 1024 px, which is the real fix for the white-square icon defect; `check-dmg-geometry.mjs` green and negative-tested; the standalone unlock page renders in a real WKWebView (19 392 bytes) and contains **zero** external URLs and **zero** `<script>` tags. **Cannot be verified:** the **Finder layout** — this machine refuses Apple events to Finder (`-1743`), so the built DMG has **no `.DS_Store`** and opens unstyled. `release.yml` gates on exactly that. **PO must:** look at the first CI-built DMG. If it is unstyled, build it on a Mac with a login session using `scripts/make-dmg.sh`. |
| **LZP-108** | Invitation e-mail (deliverable 28, 22.1) | **VERIFIED-HERE** (as artefacts) | **Verified here:** `check-email-copy.mjs` green and negative-tested (it caught a deleted Gatekeeper warning, a planted D9 violation and a planted tracking pixel); four files, both languages, four placeholders enforced so a real invite code cannot be committed; the German unlock steps match `i18n.js` string for string. **Cannot be verified:** that it *works on a person*. The screenshot in it is a **rendering, not a screen capture**. **PO must:** run LZP-1006 — send it to a real second Mac and watch someone follow it. That is the highest-information test in the plan and nothing here substitutes for it. |
| **LZP-109** | Server deploy guard rails (22.8, D3) | **WRITTEN-UNVERIFIED** | **Verified here:** `server.yml` parses; `check-server-config.mjs` runs and correctly reports E2/WP-7's five missing files as *owed* rather than *failed*, becoming binding per-file the moment each appears; `server/vercel.json` pins **fra1** (D2), migration-in-build, no CORS, `no-store`. **Cannot be verified:** every Vercel and Prisma claim — no account exists, and the workflow deliberately does **not** deploy (Vercel's GitHub integration does). **PO must:** create the Vercel project and the Prisma Postgres database, both in Frankfurt, and connect the GitHub integration. |

---

## 4. The gap that matters most: `gatekeeper_status` is implemented in neither shell

LZP-106's automatic unlock screen asks the native host whether macOS actually refused this bundle,
and shows nothing at all unless the answer is a documented yes. The command it asks for —
`gatekeeper_status` — **exists in neither `shell-macos/main.swift` nor `src-tauri/src/lib.rs`.**
LZP-106 handed it to LZP-107/108; LZP-107/108 did not build it. Verified by grep: the only hits
are the contract in `src/js/firstrun.js` and a tier-2 comment.

**Consequence:** the automatic path never fires. `probeHost()` returns `supported:false`, and
`supported:false` never shows the screen — tier 2 asserts exactly that against the real shell.

**This is deliberately still not fixed, and that is a judgement, not an omission.** The signal is
the `com.apple.quarantine` flag word on `Bundle.main.bundlePath`, and its semantics can only be
confirmed against a genuinely quarantined, genuinely refused build — which does not exist on this
machine. Writing that logic blind risks the one failure that would actually damage this product:
greeting a healthy launch with a security screen. A calendar that does that has broken a promise
Mom cannot un-see.

**What carries the product without it** — and it does carry it:

1. `build/dmg/Bitte zuerst lesen.html`, the same tested two-step copy in both languages, riding on
   the disk image where a double-click opens it in Safari (which Gatekeeper does not block). Built
   here, read, verified asset-free. **Not yet placed on the DMG** — LZP-107 declined to inject a
   third item into a two-item Finder layout it could not then inspect. `docs/v2/invitation-email.md`
   §8.2 has the three options; the recommendation is to place it on the first CI run that produces
   a real DMG, which is also the first moment anyone can look at the result.
2. Settings → **„Wenn sich die App nicht öffnet"**, permanently, on every platform. Verified in
   the screenshots below.
3. Step 3 of the invitation e-mail, which is the only one of the three that reaches Mom *before*
   the dialog does — because while macOS is blocking the app, the app is not running, so no HTML
   inside it can be on screen. That ordering is a fact about macOS, not a limitation of the work.

**PO must:** either accept surfaces 1–3 as the shipped answer (defensible), or ask for
`gatekeeper_status` to be implemented **on a machine that can produce a quarantined build and
watch macOS refuse it**.

---

## 5. Story 21.5 versus story 22.3 — the resolution

The two E1 agents that touched this did not actually disagree; one stated the answer and the other
built the surface it needs. Integration made it one thing. This is the reading that ships:

> **The board makes zero network requests, in solo and family mode alike. The shell — the native
> process, outside the WebView — makes exactly one: an unauthenticated HTTPS GET of one static
> manifest on one pinned host, and only after a human has been told.**

What that rests on, all of it checked:

| claim | how it is held |
|---|---|
| the page cannot reach off-origin | CSP is `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'` — **unchanged by this epic**, no `script-src` override, zero inline scripts, zero external `src`/`href` in `index.html`. Verified in a real browser: `fetch('https://example.com/x')` → *"Refused to connect because it violates the document's Content Security Policy"*. Tier 2 asserts the same on the page the unlock screen lives on. |
| `updater.js` contains no `fetch` | the module is DOM-free, I/O-free, clock-free and import-free; the project's own purity scanner passes it and tier 2 re-asserts it inside a real browser |
| the request is made in Rust/Swift, not JS | which is why the Tauri CSP was deliberately **not** widened with a release host |
| the whole port is four methods | `status`, `noteCheck`, `fetchManifest`, `download` — none can reach a board, op log, checkpoint or snapshot. That is how 22.7's *"updates never touch user data"* is mechanical rather than promised. The Swift selftest fingerprints Application Support before and after. |
| **no request happens until a human has been told** | two gates, `disclosed` **and** `enabled`, both enforced in JS *and* re-checked in Swift and Rust, because a bridge command is reachable from any page script. Defaults: `disclosed=false`, `enabled=true` — a fresh install is silent until someone has been told. **§2.3 is what made this true rather than merely written.** |

**The trade, in two sentences.** Delivering 22.3 means solo mode is no longer *literally*
zero-network: one host learns that some Mac asked for a public file, roughly daily, which is no
more than downloading the app already discloses, and carries no identifier, no query string and no
board content. The alternative — no check in solo mode — makes 22.3 false for most installs and,
under D1, leaves Mom on whatever build the e-mail carried, forever, with no way to reach her.

**Two consequences the PO must action, both product decisions rather than engineering ones:**

1. The About / marketing line **"zero network"** must become the scoped wording (A1 already permits
   it): *"das Board geht nie online; die App fragt einmal täglich, ob es eine neuere Version gibt."*
2. The Datenschutz text (21.3) must name **the release host as a second remote** beside the sync
   endpoint.

---

## 6. Screenshots taken during this pass

All in a real browser against `node dev-server.mjs`, 1280×860, **zero console errors** in every
one (the only console output in the whole session was the CSP violation I deliberately induced to
prove the block is real).

| # | what | what it shows |
|---|---|---|
| 1 | **The board, healthy launch, DE** | 12 columns, **372 `.day` rows**, the welcome card. **No unlock screen, no update bar, no ⚙ dot** — the new screens do not appear on a healthy launch. The welcome card correctly omits the update-disclosure line, because the browser preview has no updater and must not claim one. |
| 2 | **Unlock screen, DE** | „macOS fragt beim ersten Start einmal nach", two cards, both inline-SVG illustrations, **„Dennoch öffnen"** drawn as the single brightest thing on the page, the time-boxed-button footnote, one *Verstanden*. Fits 1000×780 without scrolling. |
| 3 | **Unlock screen, EN** | identical geometry, every string swapped **including the ones inside the SVGs** ("Open Anyway", "Move to Trash", "Privacy & Security"). |
| 4 | **Board + 22.7 bar, DE** | *"Diese Version ist zu alt. Bitte auf Version 1.0.5 oder neuer aktualisieren."* + *Neu starten*, as a bar under the toolbar with the board **fully intact** behind it. |
| 5 | **Settings → Updates, DE** | dot on UPDATES · Installierte Version 1.0.0 · *Update verfügbar — 1.1.0 / Update bereit — beim nächsten Start aktiv* + *Neu starten* · the do-nothing hint · the 21.5 switch and its disclosure sentence · *Jetzt suchen* + *Zuletzt geprüft* · the 22.7 restatement · and **„Wenn sich die App nicht öffnet"** at the bottom. |
| 6 | **Settings → Updates, EN** | the same, in English, with the English 22.7 bar visible behind the sheet. |

The Swift shell was built (`./shell-macos/build.sh --dest …`, 2.2 MB bundle) and run headless:

```
SMOKE {"cols":12,"days":365,"hol":9,"pads":12,"bridge":"roundtrip-ok","tauriDetected":true,"errors":[]}
SMOKE MENU de quiet  ["Über LangzeitPlaner", "", "Auf Updates prüfen …", "", "Einstellungen …", …]
SMOKE MENU de staged ["Über LangzeitPlaner", "", "Update verfügbar (1.1.0) — neu starten", …]
```

`errors: []`, and the quiet menu carries **no** update item — the hint appears only when something
is genuinely staged.

---

## 7. Everything that needs an account before it can be trusted

| needs | who | what is blocked until it exists |
|---|---|---|
| **GitHub repository** (D3) | PO | The repo is local-only with **no remote**. `release.yml`, `ci.yml`, `server.yml` have never executed. `plugins.updater.endpoints` still holds `OWNER/REPO`; the Swift shell's `UPDATE_MANIFEST_URL` still holds `OWNER-PLACEHOLDER` and refuses with `no-release-host` rather than resolving whatever answers. That is what keeps tier 2 hermetic. |
| **The updater keypair** | PO | `plugins.updater.pubkey` is the literal string `REPLACE_ME__run_cargo_tauri_signer_generate__…`, and `check-release-config.mjs --strict` **fails on it**, correctly. Run `cargo tauri signer generate`; the public half goes in `tauri.conf.json`, the private half becomes `TAURI_SIGNING_PRIVATE_KEY`. **An earlier draft of this config briefly carried a real-looking public key whose private half nobody held** — that is precisely the hijackable path 22.6 forbids, and it is now a placeholder that blocks releases instead. |
| **A machine with cargo** | PO / CI | The entire Tauri shell. `src-tauri/` has never been compiled. Run `workflow_dispatch` before the first tag. |
| **Apple Developer ID** *(optional — D1 says no)* | PO | Nothing is blocked. Reversing D1 costs 3 secrets + 4 variables and **no code change**. |
| **Vercel project + Prisma Postgres, Frankfurt** (D2) | PO | LZP-109's whole surface, and E2/WP-7's five owed files. |
| **A second Mac and a real e-mail** | PO | **LZP-1006, the Mom test.** Under D1 this is the measurement of exactly what that decision made harder, and no amount of green tests substitutes for it. |

### Two smaller things that need a real signature to settle

1. **The minisign algorithm.** The CI verifier accepts both `Ed` (pure) and `ED` (prehashed
   BLAKE2b-512). The Swift shell **refuses `ED` loudly** rather than mis-verifying, because
   CryptoKit has no BLAKE2b. Tauri's own updater handles both, so a prehashed signature does not
   break the shipping shell — but the Swift reference shell could then never install an update.
   Which one `cargo tauri signer sign` actually emits is unknown here. The manifest generator now
   prints a loud CI warning if the signature is prehashed, so the first real release answers the
   question instead of hiding it.
2. **`updater:default` in `capabilities/default.json`.** It is absent. Integration concluded it is
   **not needed**: nothing in the WebView calls a plugin command — the plugin is driven only from
   Rust inside custom `#[tauri::command]`s, and capabilities gate the JS→Rust boundary. Reasoned,
   not verified. If a real build denies the call at runtime, adding `"updater:default"` is the
   one-line fix.

---

## 8. Discipline checks

- **No npm dependency added**, runtime or dev. `package.json` is byte-identical to `HEAD`; there is
  no `node_modules/` and no `package-lock.json`. (`@tauri-apps/cli` was already a devDependency
  before this epic began.)
- **`src/js/core/` and `src/js/store.js` were not modified by this epic.** They *are* modified in
  the working tree — by the concurrent WP-3 retrofit agent — and are deliberately **left
  uncommitted** for their owner. Committing them would have been touching them.
- **No stray files in the repository root.** `dist/` and `build/` are both git-ignored.
- **The CSP is unchanged.** `index.html` is byte-identical to `HEAD`; `tauri.conf.json`'s `csp` line
  is untouched by the diff.
