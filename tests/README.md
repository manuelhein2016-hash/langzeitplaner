# LangzeitPlaner — v1 regression suite

This is the **characterization suite** the v2 sprint plan gates the op-log
retrofit (LZP-402) on, and the mitigation for risk **R5, "v1 regressions"**.

## The characterization rule

**These tests lock in what v1 does TODAY. They are not a specification.**

If a test goes red, the default assumption is that the *change* is wrong, not
the test. That is the entire point: when LZP-402 replaces the store with an
append-only op-log, this suite is the thing that says whether the board still
behaves the way it behaved before the retrofit.

Three consequences worth stating out loud:

1. **A test that looks odd is probably documenting something odd.** Where v1's
   behaviour is surprising, the test says so in a comment rather than
   "correcting" it. `store.init()` not clearing the undo stack, `storagePath()`
   returning a cosmetic label that does not match where bytes actually go,
   `FERIEN_META.verified === false` — all deliberately pinned.
2. **Do not fix the app to make a test pass** while characterizing. If v1 truly
   contradicts a numbered story in the spec, that is a *finding* to report, not
   a patch to write.
3. **When you intentionally change behaviour in v2**, update the test in the
   same commit and say why in the message. A red test that gets deleted is a
   regression that got shipped.

## Two tiers, and why

v1 mixes pure logic with DOM rendering, so one runner cannot cover it. Neither
tier adds an npm dependency — v1 has **zero runtime dependencies** and that
property is preserved. Tier 1 uses `node --test` (built in); tier 2 uses
WebKit, which ships with macOS.

| | Tier 1 | Tier 2 |
|---|---|---|
| Runner | `node --test` | `LangzeitPlaner --test <file>` (WKWebView) |
| Speed | ~150 ms, whole suite | ~2 s build + ~1 s per file |
| Sees | exported functions, plain data | the real DOM, the real bridge, real events |
| Files | `tests/tier1/*.test.js` | `tests/tier2/*.dom.js` |
| Deps | none | none (`swiftc` + WebKit, both on macOS) |

## Running them

```bash
npm test              # tier 1 — 444 tests, ~5 s. Run this constantly.
npm run test:dom      # tier 2 — 111 tests, ~12 s incl. the swiftc build
npm run test:all      # both, tier 1 first

npm run test:watch                              # tier 1 in watch mode
./tests/run-dom-tests.sh tests/tier2/x.dom.js   # one tier-2 file
KEEP_BUILD=1 ./tests/run-dom-tests.sh           # keep the temp .app for poking at
```

Tier 1 needs only Node (verified from a clean environment). Tier 2 additionally
needs `swiftc` and WebKit, both of which ship with macOS — which is why
`npm test` is tier 1 alone and `test:all` is the full gate.

See **`COVERAGE.md`** for what is and is not covered, story by story.

Both tiers exit non-zero on failure and print TAP, so CI needs no adapter.

---

## Tier 1 — pure logic under `node --test`

### Module classification

Tier 1 can only test what imports and runs without a DOM. The v1 modules split
three ways:

| Module | Class | Note |
|---|---|---|
| `dates.js` | **PURE** | string date math, no globals at all |
| `palette.js` | **PURE** | fixed data + lookups |
| `i18n.js` | **PURE** | string tables + module-level `current` language |
| `holidays.js` | **PURE** | computed Feiertage; memoised in a module `Map` |
| `ferien.js` | **PURE** | bundled data + index builder |
| `layout.js` | **PURE** | the whole render model; imports only pure siblings |
| `storage.js` | **PURE at import, DOM-coupled in use** | guards `window` with `typeof`, but calls `localStorage` bare |
| `store.js` | **PURE at import, DOM-coupled in use** | imports `storage.js`; needs `localStorage` once anything persists |
| `ui.js` | DOM-coupled | every export touches `document` |
| `board.js` | DOM-coupled | imports pure `layout.js`, then builds DOM |
| `legend.js`, `popover.js`, `print.js`, `find.js`, `settings.js`, `backup.js` | DOM-coupled | import cleanly under Node, but every export needs `document` |
| `interact.js` | DOM-coupled **at import time** | assigns `window.__lzpContextMenu` at top level |
| `main.js` | DOM-coupled **at import time** | boots the app; `window.addEventListener` at top level |

Only `interact.js` and `main.js` throw on a bare `import` under Node. The rest
import fine — which is a trap: importing cleanly is not the same as being
testable. `board.js` imports pure `layout.js` and is still untestable in tier 1,
because everything it exports calls `document.createElement`.

**Tier 1 therefore covers**: `dates`, `palette`, `i18n`, `holidays`, `ferien`,
`layout`, `storage`, `store`. Everything else is tier 2's job.

### The environment shim

`tests/helpers/env.js` is deliberately tiny. It provides exactly two things:

- **`localStorage`** — a `Map`-backed stand-in. `storage.js` calls it *bare*, so
  without it five of its exports throw `ReferenceError` under Node.
- **`window`, without `__TAURI__`** — so `storage.js` takes its **browser
  branch**, explicitly rather than by accident. (`storage.js` guards `window`
  with `typeof` and tolerates its absence; we define it anyway so the branch
  under test is a stated choice.)

It shims nothing else. `crypto.randomUUID`, `structuredClone`, `setTimeout` are
real Node 22 globals — `env.js` *asserts* they exist rather than standing in for
them, so a Node downgrade fails loudly instead of silently testing a fake.
There is **no `document`** on purpose: a module that needs one belongs in tier 2,
against a real engine, not a hand-rolled fake DOM.

`tests/helpers/fixtures.js` builds deterministic boards on top of the app's own
`defaultState()` — so a change to v1's defaults surfaces as a failure instead of
drifting past a hand-copied literal — with stable category ids, because
`assignLanes` tie-breaks on `id`.

### What tier 1 can and cannot cover

**Can**: date arithmetic and DST-free day math; the Easter/Buß-und-Bettag
computation and per-state `own` flags; the bundled Ferien index; the *entire*
`buildBoard` model — lane assignment, the per-column lane rescue, holiday
demotion, overflow counts, yearly-repeat projection, horizon flags; the store's
undo/redo/mutate contract, migration repair, snapshot rolling, and the exact
localStorage shape the browser branch writes.

**Cannot**: anything rendered. No DOM node, no CSS, no class name, no event, no
`__TAURI__` bridge, no print stylesheet. Also no wall-clock behaviour — every
layout test passes an explicit `today`.

---

## Tier 2 — the real board in a real browser engine

`shell-macos/main.swift` already had a `--smoke` mode that booted the board
headlessly in a real `WKWebView`. Tier 2 generalises that into an assertion
runner:

```
LangzeitPlaner --test <file.js> [--scratch <dir>]
```

It loads the actual `index.html` + `src/` from the app bundle over the `app:`
scheme, waits for the board to render, evaluates `<file.js>` against the live
DOM, prints TAP 13 and exits 0/1. This is **the same engine and the same code
path as the shipping app** — not a simulation of one.

`tests/run-dom-tests.sh` builds the shell into a temp dir with `swiftc` and runs
each `tests/tier2/*.dom.js` in **its own process with its own scratch dir**, so
files cannot see each other's persisted board — the same per-file isolation
`node --test` gives tier 1.

### Isolation — the property that makes this safe to run

Tier 2 exercises the real bridge, including `save_board`. Three independent
guards keep that away from your actual calendar:

1. **Redirection.** In `--smoke`/`--test`, `appSupportDir()` returns a scratch
   directory instead of `~/Library/Application Support/LangzeitPlaner`.
2. **A hard abort.** `resolveScratchDir()` refuses to run — `exit 70`, before
   any window opens — if the scratch path resolves to, or inside, the real board
   directory. Verified: `--scratch ~/Library/Application\ Support/LangzeitPlaner`
   prints `FATAL: … Refusing to run.` and exits 70.
3. **A before/after fingerprint.** `run-dom-tests.sh` shasums the real board
   directory before the run and again after, and fails the whole run if anything
   changed. The check reports `ok - isolation: … untouched by the run`.

### Writing a tier 2 test

Test files are **plain scripts, not modules** — they are spliced into an async
function body. So:

- top-level `await` **works**;
- `import` statements and top-level `return` **do not** — use
  `await importApp('layout.js')` to reach a real ES module inside the page.

Globals the harness provides:

| | |
|---|---|
| `test(name, fn)` | register a test; `fn` may be async |
| `assert` | `ok`, `equal`, `notEqual`, `deepEqual`, `match`, `includes`, `fail` |
| `$(sel)` / `$$(sel)` | `querySelector` / `querySelectorAll` as an array |
| `waitFor(fn, {timeout, interval, what})` | poll until truthy, else throw |
| `sleep(ms)` | |
| `importApp('store.js')` | dynamic-import one of the app's real modules |
| `diag(...)` | print a TAP `#` comment; `console.log` is forwarded here |

Uncaught page errors and unhandled rejections are collected by the shell's
injected `window.__lzpErrors` and reported as failures **even if every assert
passed** — v1 booting with an exception is a regression.

Tests must clean up after themselves: the page is shared across every `test()`
in one file. The existing files use a `reset()` / `try…finally` pattern.

### What tier 2 can and cannot cover

**Can**: the DOM board.js builds — 12 columns × 31 rows, void padding, day
numbers, weekday labels, `.we`/`.today`/`.hol` classes, holiday chips and the
demoted gutter dot, note tints and the `↻` marker, bar stripes/labels/handles,
horizon cues, `+n` overflow chips; real pointer and keyboard gestures —
click-to-type, drag-to-lay-a-bar, undo/redo, selection, find, the legend, the
day popover, scratchpads; the native `__TAURI__` bridge round-trip and its error
path; the enforced no-network property (a real `fetch` off-origin is *blocked*,
not just discouraged); the menu event channel and the shell-facing hooks
(`__lzpFlush`, `__lzpContextMenu`, `__lzpEmit`).

**Cannot**:

- **Anything needing a visible window or a human.** The window is created but
  never shown to a user; no screenshots, no visual diffing.
- **Native modal dialogs.** `export_board` / `import_board` open a real
  `NSSavePanel`/`NSOpenPanel` and would hang a headless run. The bridge commands
  are reachable but must not be invoked from a test.
- **Printing.** `printBoard` runs a modal `NSPrintOperation`. The print
  *stylesheet* and the `beforeprint` furniture are testable via the DOM; the
  actual print output is not.
- **Layout/CSS correctness.** Tier 2 asserts on classes, inline styles and
  `calc()` strings, not on computed geometry or pixels. "The bar is in lane 2"
  is checked; "the bar looks right" is not.
- **`SMAppService` (launch at login)** and the menu-bar status item — both touch
  real system state and are deliberately not exercised.
- **Wall-clock dependence.** The board boots in rolling mode from *today*, so
  tier 2 tests derive expectations from the live model rather than hardcoding
  months. Anything genuinely calendar-dependent belongs in tier 1, where `today`
  is an argument.
- **Non-macOS CI.** Tier 2 needs `swiftc` and WebKit. Tier 1 runs anywhere Node
  does, which is why `npm test` is tier 1 alone.

---

## Layout

```
tests/
  README.md                    this file
  COVERAGE.md                  story-by-story ledger (1.1 – 14.2) + discrepancies
  run-dom-tests.sh             tier 2 runner: build + run + isolation check
  helpers/
    env.js                     minimal Node globals for the pure modules
    fixtures.js                deterministic board states
  tier1/                       node --test          444 tests
    dates-holidays.test.js     dates, Feiertage, Schulferien, leap projection
    layout.test.js             the whole buildBoard model: lanes, overflow, cues
    repeats-find-i18n.test.js  F9 repeats, F14 find, 13.7 DE/EN
    store-persistence.test.js  mutate/undo/redo, migration, snapshots, export
    palette.test.js            the fixed ten-tone palette (4.5)
    storage.test.js            storage.js's own four exports (11.4)
    suite-integrity.test.js    META — the suite polices itself (see below)
  tier2/                       real WKWebView       111 tests
    board-render.dom.js        the DOM board.js builds
    dom-rendering.dom.js       grid, layers, print stylesheet, Today
    interaction.dom.js         real pointer/keyboard gestures
    shell-bridge.dom.js        the native __TAURI__ bridge, CSP, menu events
```

**Every tier-1 file must live in `tier1/` and every tier-2 file in `tier2/`.**
`npm test` globs `tests/tier1/*.test.js` and `run-dom-tests.sh` globs
`tests/tier2/*.dom.js`; a file written anywhere else runs in nobody's gate.
`suite-integrity.test.js` fails if a stranded test file appears.

## The suite polices itself

A green suite that proves nothing is worse than no suite — it turns an ungated
retrofit into one that only *looks* gated. Two guards, both verified by
deliberately introducing the fault they catch:

- **No vacuous tests.** The tier-2 harness counts `assert` calls per test and
  reports a body that asserted nothing as `not ok — VACUOUS`. Standing down
  requires an explicit `skip(reason)`, which prints a TAP `# SKIP` directive and
  is counted separately — never a silent `ok`. (The bundled Schulferien table
  expiring past `FERIEN_META.horizon` is the only real use.) Tier 1 has no such
  runtime hook, so `suite-integrity.test.js` enforces the same rule statically.
- **No fake wiring.** `suite-integrity.test.js` also fails on a disabled test
  (`test.skip`/`test.todo`), a stranded test file, a tier-1 file that imports
  `node:fs` or reaches into `Application Support`, a tier-1 file importing a
  stand-in instead of the real `src/js/` module, and any added npm dependency.
