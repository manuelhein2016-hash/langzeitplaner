# LangzeitPlaner

A rolling 12-month planning board for macOS: every month a column, every day a
thin row, behaving like a whiteboard. Click a day and type, drag colored bars
across weeks and months, move everything at any time. No accounts, no cloud, no
sync, no notifications, no times of day.

Built from `LangzeitPlaner Wireframes.dc.html`. Which of the fifteen wireframe
options were chosen, and why, is in **[DESIGN-DECISIONS.md](DESIGN-DECISIONS.md)**.

## Run it

```bash
npm run dev
```

Then open <http://localhost:4173>. A static server is needed only because ES
modules require an origin — nothing is fetched from the network at runtime.

## As a Mac app

A hand-built `.app` bundle — no installer, no packager, no Electron. Needs only
the Xcode Command Line Tools (`swiftc`), which macOS already has:

```bash
./shell-macos/build.sh
```

That compiles `shell-macos/main.swift` (a ~230-line WKWebView shell), builds the
`.icns` from `assets/icon.svg`, copies the web layer into
`Contents/Resources/web/`, validates the plist and registers the bundle with
LaunchServices. Output: `/Applications/LangzeitPlaner.app`. Pass
`--dest ~/Desktop` to put it elsewhere.

The shell exposes the same `window.__TAURI__` surface the frontend already talks
to, so the web layer runs unchanged and storage goes to Application Support
rather than localStorage. It provides the §9 menu bar, ⌘W hiding instead of
quitting, the optional menu-bar icon (13.2), and the native print dialog.

Verify it without a screen:

```bash
/Applications/LangzeitPlaner.app/Contents/MacOS/LangzeitPlaner --smoke
```

which loads the board headlessly and prints what it rendered plus a bridge
round-trip check.

**Swapping the icon.** `build.sh` renders every icon size from
`assets/icon.svg` (via `scripts/render-svg.swift`, which uses the SVG rasteriser
macOS 13+ exposes through `NSImage`). Edit the SVG and re-run the script —
iconset, `.icns` and bundle are regenerated.

`assets/icon-1024.png` is the old source and is now only a fallback for macOS 12.
It is **flattened onto opaque white**, so any icon derived from it renders as a
white square rather than a rounded app icon; that is why the SVG is the source now.

**Dock tile.** Pinned via the `com.apple.dock` preference domain
(`persistent-apps` → a `file-tile` pointing at the bundle) plus `killall Dock`.
Moving or renaming the `.app` invalidates the tile; re-run the pin step.

## As a Tauri app

`src-tauri/` is the intended production shell but needs a Rust toolchain, which
is not installed here — see "What was verified" below:

```bash
npm install && npm run tauri:dev
```

## Layout

```
index.html              app shell: titlebar, toolbar, board, print furniture
dev-server.mjs          20-line static server for local development
src/css/app.css         design tokens + board styles
src/css/print.css       A4/A3 landscape print stylesheet
src/js/
  dates.js              YYYY-MM-DD arithmetic — no times, no timezones
  holidays.js           Feiertage, computed (Easter + Buß-und-Bettag rules)
  ferien.js             Schulferien, bundled data  ← see warning below
  palette.js            the ten fixed category tones
  store.js              state, undo, autosave, daily snapshots
  layout.js             the board model: rows, capacity, lanes, segments
  board.js              model → DOM
  interact.js           pointer state machine: click, drag, resize, edit
  popover.js            day popover (full note stack)
  legend.js             legend + category management + delete-with-reassign
  find.js               find overlay
  settings.js           settings sheet
  backup.js             export / import
  print.js              page rule + print header/legend
  i18n.js               DE (default) / EN
  main.js               bootstrap, keyboard map, clock, native-menu bridge
src-tauri/              native shell: menus, atomic writes, tray, dialogs
```

## ⚠️ Schulferien data is placeholder

`src/js/ferien.js` is structurally final but its **dates are unverified sample
data**. School holidays are negotiated per Bundesland and published by the KMK
only ~2–3 years ahead, so unlike Feiertage they cannot be derived from a rule.

The app says so rather than pretending: `FERIEN_META.verified = false` puts a
warning next to the horizon line in settings. To ship real data, replace the
`FERIEN` table from <https://www.kmk.org/service/ferien.html>, set `verified:
true`, and update `horizon`. Nothing else changes.

Feiertage have no such caveat — they are computed from fixed dates, Easter
arithmetic and the Buß-und-Bettag rule, so that layer never runs out of data
(6.5). Verified against Easter 2027/2038/2087/2100 and the full Bayern and
Sachsen sets.

## Storage

One human-readable JSON, written atomically (temp file + rename):

```
~/Library/Application Support/LangzeitPlaner/board.json
~/Library/Application Support/LangzeitPlaner/snapshots.json   (last 7 days)
```

In a plain browser this degrades to `localStorage` under the same key names, so
the board is fully usable during development. Nothing above `storage.js` knows
which backend is active. The file carries `schemaVersion` and is migrated on load
(11.6); dangling category references are repaired rather than dropped.

## Zero network by architecture (13.4)

There is no HTTP client anywhere: no CDN, no webfont request, no analytics. The
Tauri CSP allows `self` and the IPC channel only, and no networking crate is
linked.

One consequence: the wireframe's Ubuntu typeface is *used when it is installed
locally* and otherwise falls back to the system UI face. To pin the exact
typography, drop the WOFF2 files into `assets/fonts/` and add to `app.css`:

```css
@font-face { font-family: 'Ubuntu'; src: url('../../assets/fonts/Ubuntu-Regular.woff2') format('woff2'); font-weight: 400; font-display: swap; }
/* …and one per weight you ship */
```

Still local, still no request.

## Keyboard

| | |
|---|---|
| ⌘Z / ⇧⌘Z | Undo / Redo (50 steps) |
| ⌘F | Find |
| ⌘T | Jump to today |
| ⌘P | Print |
| ⌘1 / ⌘2 | Toggle Feiertage / Schulferien |
| ⌘, | Settings |
| ⇧⌘E / ⇧⌘I | Export / Import |
| ⌘W / ⌘Q | Hide window / Quit (native shell) |
| Enter / Esc | Commit edit, step hits / cancel, deselect, close |
| ⌫ | Delete selected entry |

## What was verified, and what wasn't

Exercised in a real browser against a populated board (27 notes, 12 bars,
scratchpads, Bayern layers):

- 12 columns aligned by day number, weekend/Ferien/overlap shading, Today marker
- bar lanes stable across all five month segments of a 5-month bar; segment
  geometry within 1 px of its day rows; month split, `↑`/`↓` and horizon cues
- create note (click + Enter), edit, drag to another day, drag-create a bar with
  up-drag normalisation, resize an edge, move keeping length — each with undo
  and redo, and the right state landing in storage
- day popover with the full 4-note stack plus the bars covering that day
- find across notes, bar labels and scratchpads; hit stepping; no-match state
- category hide/show removing both its notes and its bars
- yearly repeats: Feb-29 → Feb-28 in non-leap years, Feb-29 in leap years,
  nothing before the anchor year (9.4 / 9.5)
- pinned mode + year paging reaching rolled-out history (1.5 / 8.4)
- Feiertage for Bayern and Sachsen; Easter and Buß-und-Bettag for distant years
- German ↔ English including weekday abbreviations and holiday names
- sticky month headers under vertical scroll; horizontal scroll (1.4)
- A4 print metrics applying to the live DOM (12 × 88 px columns, 20 px rows,
  731 px total against a 733 px content box), Today highlight suppressed,
  print header and legend strip built

Inside the native macOS shell (`--smoke`, headless): 12 columns, 365 day rows,
9 nationwide holidays, 12 scratchpads, `__TAURI__` bridge save/load round-trip,
no JS errors. Smoke writes go to a scratch directory, never the real board.

A full story audit (all 79, each failure adversarially verified) ran on
2026-08-01; the fixes are listed in DESIGN-DECISIONS.md. Post-fix, the browser
suite re-verified: per-day lane rescue (a 4th bar renders wherever ≤3 coincide),
mirrored horizon cues, Today surviving weekend-in-Ferien, right-click popover
with ↻ on any day, field-focused ⌘Z leaving the board alone, Schulferien
default-off until a Bundesland is picked (then auto-on), and the find history
list jumping to pinned months.

Not verified here:

- **`src-tauri/` has never been compiled** — there is no Rust toolchain on this
  machine. The menu bar, atomic writes, tray icon, native save/open dialogs and
  autostart are written against the Tauri 2 API but unbuilt. Treat that
  directory as reviewed-by-eye, not tested.
- The real macOS print dialog (only the print *stylesheet* was verified, by
  applying it on screen).
- Month-roll animation and midnight/wake auto-roll (8.2/8.5/8.6) — they need a
  real date change; the clock logic ticks every 30 s and on focus/visibility.
