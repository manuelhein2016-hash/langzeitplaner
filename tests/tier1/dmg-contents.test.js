// tests/tier1/dmg-contents.test.js — the DMG carries instructions, on BOTH paths.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
//  WHAT WAS MEASURED, AND WHY A ROW EXISTS FOR IT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// At 79929b5 the PO built the artifacts and mounted the real DMG:
//
//     ls -la /tmp/lzpdmg/   ->  .background/   Applications -> /Applications   LangzeitPlaner.app
//     spctl -a -t exec -vv /Applications/LangzeitPlaner.app  ->  rejected
//
// `rejected` is CORRECT. Decision D1 ships unsigned deliberately, and LZP-106's guided
// Systemeinstellungen unlock screen exists precisely for that wall. But that screen is inside
// the app macOS has just refused to launch. `scripts/build-unlock-page.sh` renders the same two
// steps, both languages, as one self-contained file — 19 427 bytes, built in a real WKWebView —
// and at 79929b5 nothing consumed it:
//
//     grep -rln "zuerst lesen" src-tauri/ .github/ scripts/   ->   scripts/build-unlock-page.sh
//                                                                  (the file that BUILDS it)
//
// So the one surface reaching a stranger before macOS refuses the app carried nothing that told
// her what to do. E10's audit predicted exactly this shape.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THESE ROWS GO THROUGH A SUBPROCESS
// ─────────────────────────────────────────────────────────────────────────────────────────────
// `suite-integrity.test.js` bans `node:fs` in tier 1 outright, so this file cannot read
// release.yml itself. The predicate therefore lives in `.github/scripts/check-dmg-readme.mjs` —
// which is also the gate CI runs before the 40-minute universal build — and this file reaches it
// through `--json` and `--simulate`. The point is the same one release-gate.test.js makes: the
// mutants exercise the SHIPPED predicate, not a copy of it living in the test. A copy would go
// green against itself.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE TWO PATHS, AND WHY BOTH ARE ROWS
// ─────────────────────────────────────────────────────────────────────────────────────────────
// `scripts/make-dmg.sh` is the path anyone can run without a CI runner; its own header says "a
// discrepancy here is a warning about there". Production is `cargo tauri build`. Repairing only
// the first is the exact class of error this project keeps catching: a green verification path
// over a broken artifact. §2 kills each half separately.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE CANNOT PROVE
// ─────────────────────────────────────────────────────────────────────────────────────────────
// That the window LOOKS right. Finder automation is refused on this machine (-1743) and Rust
// cannot be installed here, so no DMG built or inspected locally carries a .DS_Store. §3 keeps
// the part that is checkable without a GUI — the read-me's 128pt icon and its label must clear
// the app's and the Applications folder's, and stay inside the window — which turns
// docs/v2/invitation-email.md § 8.2's "risks landing on the artwork" from a fear into a number.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The real producer. Every row below is downstream of this one function: it renders the page the
// DMG is supposed to carry, and if its name leaves this module the whole chain is decoration.
import { renderUnlockDocument } from '../../src/js/firstrun.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECK = path.join(ROOT, '.github', 'scripts', 'check-dmg-readme.mjs');

/** The file name, spelled here so a silent rename is a failing row and not a diff. */
const READ_NAME = 'Bitte zuerst lesen.html';

/** Run the shipped predicate. A red row makes it exit 1; that is data, not a crash. */
function run(args) {
  let out;
  try {
    out = execFileSync('node', [CHECK, ...args, '--json'], { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    if (!e.stdout) throw e;
    out = e.stdout;
  }
  return JSON.parse(out).rows;
}

/** The rows as the repository stands right now. */
const observed = () => run([]);

/** The rows for a hypothetical repository. `patch` overrides one observation. */
const simulate = (patch) => run(['--simulate', JSON.stringify({ ...baseline, ...patch })]);

/** Look up one row by id. */
const rowOf = (rows, id) => rows.find((r) => r.id === id);

/** Which ids are red. */
const redIds = (rows) => rows.filter((r) => !r.ok).map((r) => r.id);

// The honest observation, captured once so every mutant differs from the real repository by
// exactly one field. Mirrors what `observe()` returns; the control row below proves it still
// scores identically to the real thing, so a drifted baseline cannot quietly weaken the mutants.
const baseline = {
  producerName: READ_NAME,
  makeName: READ_NAME,
  injName: READ_NAME,
  window: { w: 660, h: 420 },
  app: { x: 170, y: 170 },
  folder: { x: 490, y: 170 },
  makePos: { x: 304, y: 70 },
  injPos: { x: 304, y: 70 },
  makeStages: true,
  makePositions: true,
  releaseInjects: true,
  injectBeforeGate: true,
  releaseGates: true,
  dmgKeys: ['background', 'windowSize', 'appPosition', 'applicationFolderPosition'],
  // The caption painted under the drop arrow. Until the page was put on the image it
  // answered "what is this warning?" with "die E-Mail erklärt, was zu tun ist" — which
  // hands the reader back to the one surface the DMG window exists to stop depending on.
  artNamesPage: true,
  artNamesEmail: false,
};

describe('1 · the repository as it stands', () => {
  test('the producer this whole chain hangs on still exists', () => {
    // If renderUnlockDocument() stops being exported, build-unlock-page.sh fails loudly and
    // every row below becomes a claim about a file nobody produces any more.
    assert.equal(typeof renderUnlockDocument, 'function');
  });

  test('every row is green — the page is produced, staged on both paths, and gated', () => {
    const rows = observed();
    assert.deepEqual(redIds(rows), [], 'red rows in the real repository');
    assert.ok(rows.length >= 6, `only ${rows.length} rows — the predicate lost some`);
  });

  test('the control: the simulated baseline scores exactly like the real repository', () => {
    // Without this, a mutant could be passing because the baseline drifted into a shape the
    // predicate is blind to, rather than because the predicate works.
    assert.deepEqual(
      simulate({}).map((r) => [r.id, r.ok]),
      observed().map((r) => [r.id, r.ok]),
    );
  });
});

describe('2 · one mutant per path, each naming the row that dies', () => {
  test('rename the generator output and PRODUCER dies — both DMG builders ship nothing', () => {
    // The 79929b5 failure in miniature: the file is built, and the thing that consumes it looks
    // for a different name. Nobody notices, because a DMG without it still mounts.
    const rows = simulate({ producerName: 'Please read me first.html' });
    assert.equal(rowOf(rows, 'PRODUCER').ok, false);
    assert.deepEqual(redIds(rows), ['PRODUCER']);
  });

  test('make-dmg.sh stops staging the page and VERIFY-PATH dies', () => {
    const rows = simulate({ makeStages: false });
    assert.equal(rowOf(rows, 'VERIFY-PATH').ok, false);
    assert.deepEqual(redIds(rows), ['VERIFY-PATH']);
  });

  test('staged but never positioned — VERIFY-PATH dies on the half-fix too', () => {
    // Half of § 8.2 option (b): the file is on the image and Finder decides where. That is the
    // outcome the ticket's own documentation refused, so it must not read as a pass.
    const rows = simulate({ makePositions: false });
    assert.equal(rowOf(rows, 'VERIFY-PATH').ok, false);
    assert.deepEqual(redIds(rows), ['VERIFY-PATH']);
  });

  test('fix only the path you can run locally and PROD-PATH dies', () => {
    // The exact class of error this project keeps catching: make-dmg.sh green, `cargo tauri
    // build` — the thing that actually ships — untouched.
    const rows = simulate({ releaseInjects: false, injectBeforeGate: false });
    assert.equal(rowOf(rows, 'PROD-PATH').ok, false);
    assert.deepEqual(redIds(rows), ['PROD-PATH']);
  });

  test('inject after the mount gate and PROD-PATH dies — the gate would check the wrong bytes', () => {
    const rows = simulate({ injectBeforeGate: false });
    assert.equal(rowOf(rows, 'PROD-PATH').ok, false);
    assert.deepEqual(redIds(rows), ['PROD-PATH']);
  });

  test('drop the release gate and GATE dies — the injection could silently stop working', () => {
    const rows = simulate({ releaseGates: false });
    assert.equal(rowOf(rows, 'GATE').ok, false);
    assert.deepEqual(redIds(rows), ['GATE']);
  });

  test('the artwork still defers to the e-mail and ART-POINTS-AT-PAGE dies alone', () => {
    // The state at 79929b5, in the one file the read-me fix does not otherwise touch: the
    // page is on the image, correctly named and correctly placed, and the sentence painted
    // under the arrow still points at a mail that can be lost, forwarded without its body,
    // or read on a phone. Every other row is green, which is precisely why it needs its own.
    const rows = simulate({ artNamesPage: false, artNamesEmail: true });
    assert.equal(rowOf(rows, 'ART-POINTS-AT-PAGE').ok, false);
    assert.deepEqual(redIds(rows), ['ART-POINTS-AT-PAGE']);
  });

  test('the caption drops the filename without naming the e-mail — still red', () => {
    // The half-edit: somebody removes "die E-Mail erklärt" and writes nothing in its place.
    // The reader is left with a security warning and no route out of it.
    const rows = simulate({ artNamesPage: false });
    assert.equal(rowOf(rows, 'ART-POINTS-AT-PAGE').ok, false);
    assert.deepEqual(redIds(rows), ['ART-POINTS-AT-PAGE']);
  });

  test('the two builders disagree on the position and POSITION-AGREE dies', () => {
    // make-dmg.sh is only worth running because the window it produces is the window CI ships.
    const rows = simulate({ injPos: { x: 60, y: 300 } });
    assert.equal(rowOf(rows, 'POSITION-AGREE').ok, false);
    assert.deepEqual(redIds(rows), ['POSITION-AGREE']);
  });
});

describe('3 · § 8.2’s fear, as a number', () => {
  test('put the read-me on the app icon and NO-OVERLAP dies with the area', () => {
    const rows = simulate({ makePos: { x: 170, y: 170 }, injPos: { x: 170, y: 170 } });
    const r = rowOf(rows, 'NO-OVERLAP');
    assert.equal(r.ok, false);
    // 128x128 icon + 140x26 label, exactly coincident.
    assert.match(r.msg, /overlaps the app icon by 20024 px/);
  });

  test('put it on the Applications folder and NO-OVERLAP dies there instead', () => {
    const rows = simulate({ makePos: { x: 490, y: 170 }, injPos: { x: 490, y: 170 } });
    const r = rowOf(rows, 'NO-OVERLAP');
    assert.equal(r.ok, false);
    assert.match(r.msg, /Applications folder by 20024 px/);
  });

  test('a one-pixel graze still dies — the row is not a rounding opinion', () => {
    // The app item spans x 106..234. A read-me centred at x=233 overlaps by one column.
    const rows = simulate({ makePos: { x: 361, y: 170 }, injPos: { x: 361, y: 170 } });
    assert.equal(rowOf(rows, 'NO-OVERLAP').ok, false);
  });

  test('half off the window edge and NO-OVERLAP dies — Finder would clip it', () => {
    const rows = simulate({ makePos: { x: 20, y: 70 }, injPos: { x: 20, y: 70 } });
    const r = rowOf(rows, 'NO-OVERLAP');
    assert.equal(r.ok, false);
    assert.match(r.msg, /inside the 660x420 window: false/);
  });

  test('widen the window without moving the icons and the shipped position survives', () => {
    // The inverse: this row must not be a tripwire that fires on any change at all. Growing the
    // window is exactly the change that would give the artwork the third slot it still needs,
    // and it must not read as a regression.
    const rows = simulate({ window: { w: 760, h: 520 } });
    assert.equal(rowOf(rows, 'NO-OVERLAP').ok, true);
  });
});

describe('4 · the config key that does not exist', () => {
  test('invent a sixth bundle.macOS.dmg key and TAURI-KEYS dies before cargo does', () => {
    // Checked against schema.tauri.app/config/2: DmgConfig declares exactly five properties with
    // "additionalProperties": false, and tauri-bundler builds create-dmg's argument list by hand
    // — it never passes the `--add-file` its own vendored script supports. A `readmePosition`
    // key here does not get ignored; `cargo tauri build` refuses the config and the release
    // never builds. That is a 40-minute round trip to learn something this row says in seconds.
    const rows = simulate({
      dmgKeys: ['background', 'windowSize', 'appPosition', 'applicationFolderPosition',
        'readmePosition'],
    });
    const r = rowOf(rows, 'TAURI-KEYS');
    assert.equal(r.ok, false);
    assert.match(r.msg, /readmePosition/);
  });

  test('the shipped config carries no key Tauri would refuse', () => {
    assert.equal(rowOf(observed(), 'TAURI-KEYS').ok, true);
  });
});
