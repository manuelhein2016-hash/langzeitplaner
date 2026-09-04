#!/usr/bin/env node
// LZP-107 · E10 follow-up — the unlock page is ON the DMG, on BOTH paths, and its
// icon does not land on top of something.
//
//   node .github/scripts/check-dmg-readme.mjs            # rows, human readable
//   node .github/scripts/check-dmg-readme.mjs --json     # rows as JSON
//   node .github/scripts/check-dmg-readme.mjs --simulate '<json>'   # mutants
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHAT WENT WRONG, MEASURED AT 79929b5
// ═══════════════════════════════════════════════════════════════════════════════
// `scripts/build-unlock-page.sh` produced `build/dmg/Bitte zuerst lesen.html`
// (19 427 bytes, rendered in a real WKWebView) and threw it away. Mounting the
// artifact showed three entries: `.background/`, `Applications ->`, and
// `LangzeitPlaner.app`. Under decision D1 the app ships unsigned, so
// `spctl -a -t exec` says `rejected` — correctly, and by design. LZP-106's guided
// unlock screen answers that, and it is inside the app she cannot open yet. The DMG
// window is the only surface that reaches her first, and it carried no instructions.
//
// This file is the connection that was missing, in the same shape as its neighbour
// `check-dmg-geometry.mjs`: the producer, the two consumers and the release gate
// live in four files that drift in silence, so something has to assert they agree.
//
// ═══════════════════════════════════════════════════════════════════════════════
// THE ONE ROW THAT IS NOT BOOKKEEPING — §6, NO-OVERLAP
// ═══════════════════════════════════════════════════════════════════════════════
// docs/v2/invitation-email.md § 8.2 refused to place this file because "a third file
// injected into the image afterwards lands wherever Finder decides, which can be on
// top of the arrow", and doing it blind "would be guessing at a layout in the one
// part of this epic that has no test". This is that test. The position is no longer
// guessed: assets/dmg/background.svg was rendered at 660x420 and every candidate
// centre scanned. Zero candidates collide with nothing. (304, 70) is the minimum —
// it clears BOTH Finder items completely and grazes the arrowhead's upper tip by
// 115 px^2 of the 20 024 px^2 the item occupies. This row keeps the part that can be
// checked without a GUI: the read-me's icon and label must never overlap the app's or
// the Applications folder's, and must stay inside the window. Widen the window, move
// an icon, or nudge the page, and the build stops.
//
// Zero dependencies, no YAML parser: the values it needs are matched directly.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ── the item box model ────────────────────────────────────────────────────────
// Finder draws a 128pt icon centred on the stored position, and its filename label
// underneath. ICON is the real number (scripts/make-dmg.sh sets it explicitly; the
// vendored create-dmg Tauri runs defaults to the same 128 — bundle_dmg line 27).
// LABEL_W/LABEL_H are a deliberate over-estimate: a wrong-in-the-generous-direction
// box makes this check strict, and strict is the safe direction for a layout nobody
// can look at until CI cuts a release.
const ICON = 128;
const LABEL_W = 140;
const LABEL_H = 26;

const itemBox = ({ x, y }) => ({
  icon: { x0: x - ICON / 2, y0: y - ICON / 2, x1: x + ICON / 2, y1: y + ICON / 2 },
  label: { x0: x - LABEL_W / 2, y0: y + ICON / 2, x1: x + LABEL_W / 2, y1: y + ICON / 2 + LABEL_H },
});
const overlap = (a, b) => {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
};
/** Total intersection area between two placed Finder items, icon and label both. */
function itemsOverlap(p, q) {
  const A = itemBox(p), B = itemBox(q);
  return overlap(A.icon, B.icon) + overlap(A.icon, B.label)
       + overlap(A.label, B.icon) + overlap(A.label, B.label);
}

// ── reading the four files ────────────────────────────────────────────────────
const shNum = (src, name) => {
  const m = src.match(new RegExp(`^${name}=(\\d+)`, 'm'));
  return m ? +m[1] : null;
};
const shStr = (src, name) => {
  const m = src.match(new RegExp(`^${name}="([^"]*)"`, 'm'));
  return m ? m[1] : null;
};

/** Everything the rows below judge, lifted out of the repo. */
export function observe() {
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  const mk = read('scripts/make-dmg.sh');
  const inj = read('.github/scripts/dmg-add-readme.sh');
  const rel = read('.github/workflows/release.yml');
  const gen = read('scripts/build-unlock-page.sh');
  const art = read('assets/dmg/background.svg');
  const dmg = conf?.bundle?.macOS?.dmg ?? {};

  const makeName = shStr(mk, 'READ_NAME');
  const injName = shStr(inj, 'READ_NAME');
  // build-unlock-page.sh writes `OUT="build/dmg/<name>"`.
  const outLine = gen.match(/^OUT="build\/dmg\/([^"]+)"/m);

  // The injection step and the mount gate, located by the command each one runs.
  const injectAt = rel.indexOf('.github/scripts/dmg-add-readme.sh');
  const gateAt = rel.indexOf('The DMG mounts and contains the app');

  return {
    producerName: outLine ? outLine[1] : null,
    makeName,
    injName,
    window: { w: dmg.windowSize?.width ?? null, h: dmg.windowSize?.height ?? null },
    app: dmg.appPosition ?? {},
    folder: dmg.applicationFolderPosition ?? {},
    makePos: { x: shNum(mk, 'READ_X'), y: shNum(mk, 'READ_Y') },
    injPos: { x: shNum(inj, 'READ_X'), y: shNum(inj, 'READ_Y') },
    // The verification path must both COPY the page into the staging dir and give
    // Finder a position for it. Either one alone is half the fix.
    makeStages: makeName != null && mk.includes(`cp "$PAGE" "$STAGE/$READ_NAME"`),
    makePositions: mk.includes('set position of item "$READ_NAME"'),
    releaseInjects: injectAt >= 0,
    injectBeforeGate: injectAt >= 0 && gateAt >= 0 && injectAt < gateAt,
    // The gate itself: the mount step must name the page and FAIL on its absence.
    // `exit 1`, not `::warning::` — the Applications-symlink check one block up only
    // warns, and a warning on a runner nobody watches is the same as no check. The
    // 1200-char window is the error message's own length plus slack; it is bounded so
    // the match cannot wander into some later block's `exit 1` and read as a pass.
    releaseGates: /if \[ ! -f "\$MNT\/\$READ_NAME" \]; then[\s\S]{0,1200}?exit 1/.test(rel),
    dmgKeys: Object.keys(dmg),
    // The caption painted under the drop arrow. It is the only sentence about the
    // security warning that she sees BEFORE opening anything, so what it points at
    // has to still exist. It used to point at the e-mail.
    // Matched against a LITERAL, deliberately not against `makeName`. The artwork is
    // painted prose in two languages, not a path, so it is a separate copy of the name
    // and PRODUCER is the row that owns whether the names agree. Deriving this from
    // `makeName` would make a rename kill two rows at once and tell you neither.
    artNamesPage: art.includes(ART_MUST_NAME),
    artNamesEmail: /die E-Mail erkl\u00e4rt|the e-mail explains/.test(art),
  };
}

// Tauri's published schema, definitions.DmgConfig: exactly these five, with
// "additionalProperties": false. Fetched and read, not remembered — an invented
// sixth key does not get ignored, it makes `cargo tauri build` reject the config.
// The caption under the drop arrow has to send her to the file lying beside the app.
// This is the stem of that filename as the ARTWORK spells it, in both languages.
const ART_MUST_NAME = 'Bitte zuerst lesen';

const TAURI_DMG_KEYS = [
  'background', 'windowPosition', 'windowSize', 'appPosition', 'applicationFolderPosition',
];

/** The rows. Pure: everything it judges arrives in `s`. */
export function rows(s) {
  const out = [];
  const row = (id, ok, msg) => out.push({ id, ok: !!ok, msg });

  row('PRODUCER', s.producerName && s.producerName === s.makeName && s.producerName === s.injName,
    `scripts/build-unlock-page.sh writes "${s.producerName}"; make-dmg.sh stages "${s.makeName}"; `
    + `dmg-add-readme.sh stages "${s.injName}". Rename the generator's output and both DMG paths `
    + 'silently ship a disk image with no instructions on it — which is exactly the state this '
    + 'check was written for.');

  row('VERIFY-PATH', s.makeStages && s.makePositions,
    'scripts/make-dmg.sh must BOTH copy the page into the staging directory and give Finder a '
    + `position for it (stages: ${s.makeStages}, positions: ${s.makePositions}). It is the only `
    + 'path anyone can run without a CI runner, and its header says a discrepancy here is a '
    + 'warning about the production path.');

  row('PROD-PATH', s.releaseInjects && s.injectBeforeGate,
    'release.yml must run .github/scripts/dmg-add-readme.sh on the built DMG, and must run it '
    + `BEFORE the mount gate (runs: ${s.releaseInjects}, before the gate: ${s.injectBeforeGate}). `
    + 'Production is `cargo tauri build`; fixing only make-dmg.sh repairs the verification path '
    + 'and leaves the shipped artifact broken.');

  row('GATE', s.releaseGates,
    'release.yml\'s "The DMG mounts and contains the app" step must fail when the page is missing '
    + 'from the mounted image, the way it already fails on a missing Applications symlink, a '
    + 'missing background and a missing .DS_Store. Without it the injection can silently stop '
    + 'working and the release goes out anyway.');

  const posAgree = s.makePos.x != null && s.makePos.x === s.injPos.x && s.makePos.y === s.injPos.y;
  row('POSITION-AGREE', posAgree,
    `make-dmg.sh puts the read-me at (${s.makePos.x}, ${s.makePos.y}); dmg-add-readme.sh puts it `
    + `at (${s.injPos.x}, ${s.injPos.y}). The whole value of make-dmg.sh is that the window you `
    + 'can look at here is the window CI ships.');

  // ── the row that is not bookkeeping ─────────────────────────────────────────
  const readme = { x: s.makePos.x, y: s.makePos.y };
  const vsApp = itemsOverlap(readme, s.app);
  const vsFolder = itemsOverlap(readme, s.folder);
  const b = itemBox(readme);
  const inside = b.icon.x0 >= 0 && b.icon.y0 >= 0
    && b.icon.x1 <= s.window.w && b.label.y1 <= s.window.h;
  row('NO-OVERLAP', vsApp === 0 && vsFolder === 0 && inside,
    `the read-me at (${readme.x}, ${readme.y}) overlaps the app icon by ${vsApp} px² and the `
    + `Applications folder by ${vsFolder} px²; inside the ${s.window.w}x${s.window.h} window: `
    + `${inside}. A 128pt icon plus its label is ${ICON}x${ICON} + ${LABEL_W}x${LABEL_H}. `
    + 'This is § 8.2\'s "risks landing on the artwork", turned into a number.');

  // ── the artwork points at the file, not at a mail that may not be there ────
  // The DMG window exists because the e-mail can be lost, forwarded without its
  // body, or read on a phone. Artwork that answers "what is this warning?" with
  // "the e-mail explains" hands the reader straight back to the surface this whole
  // fix was written to stop depending on — and it did say exactly that until the
  // page was put on the image beside it.
  row('ART-POINTS-AT-PAGE', s.artNamesPage && !s.artNamesEmail,
    `assets/dmg/background.svg names the read-me: ${s.artNamesPage}; still defers to the e-mail: `
    + `${s.artNamesEmail}. The caption under the drop arrow is the only sentence about the `
    + 'Gatekeeper warning that reaches her before she opens anything. It must name the file '
    + 'lying next to the app in that same window.');

  const foreign = s.dmgKeys.filter((k) => !TAURI_DMG_KEYS.includes(k));
  row('TAURI-KEYS', foreign.length === 0,
    `bundle.macOS.dmg carries ${JSON.stringify(foreign)} beyond Tauri's five supported keys. `
    + 'DmgConfig is "additionalProperties": false in schema.tauri.app/config/2, so this does not '
    + 'get ignored — `cargo tauri build` refuses the config and the release never builds. The '
    + 'read-me position lives in the two shell scripts for exactly this reason.');

  return out;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const simAt = argv.indexOf('--simulate');
  const state = simAt >= 0 ? JSON.parse(argv[simAt + 1]) : observe();
  const r = rows(state);
  const bad = r.filter((x) => !x.ok);
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ rows: r }, null, 2));
  } else if (bad.length) {
    console.error('DMG read-me check FAILED\n');
    for (const x of bad) console.error(`  ✗ ${x.id}: ${x.msg}\n`);
  } else {
    console.log('DMG read-me OK — the unlock page is produced, staged on both DMG paths, gated in '
      + 'release.yml, and its icon clears both existing items.');
  }
  process.exit(bad.length ? 1 : 0);
}
