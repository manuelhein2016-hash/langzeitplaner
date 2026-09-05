// Assemble the web payload the app bundle ships — `node scripts/build-frontend.mjs`
//
//   node scripts/build-frontend.mjs                       build dist/ (the default; Tauri's
//                                                         beforeBuildCommand runs exactly this)
//   node scripts/build-frontend.mjs --check-release       the release-staging rows, readable
//   node scripts/build-frontend.mjs --check-release --json
//   node scripts/build-frontend.mjs --check-release --simulate '<json>'    # mutants
//
// There is no bundler, no minifier and no dependency here, and there is not
// going to be one: the app is ~3 900 lines of plain ES modules and WKWebView
// loads them from disk. This script only decides WHICH FILES GET IN.
//
// WHY IT EXISTS. tauri.conf.json used to say `"frontendDist": "../"`, i.e.
// "ship the repository". Tauri copies that directory into the app bundle, so
// every build would have carried `.git` (3.3 MB of history), `tests/` (2.1 MB),
// `docs/`, `assets/` and `src-tauri/target/` onto the target Mac — blowing the
// story-22.1 size budget several times over, and putting the project's entire
// history on a family member's laptop. Neither is a thing you notice by
// looking at the app.
//
// The fix is an ALLOWLIST, not an ignore list. A denylist silently ships
// whatever nobody thought to exclude; this refuses everything it was not told
// about. `dist/` is gitignored and rebuilt from scratch every time.

import { cpSync, rmSync, mkdirSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// THE ONE PLACE THIS DIRECTORY IS NAMED. `--check-release` below reads it back out
// of this constant rather than re-typing "dist", so moving the frontend build's
// output moves the collision check with it instead of leaving a stale copy behind.
const FRONTEND_DIR = 'dist';
const DIST = resolve(ROOT, FRONTEND_DIR);

// Everything the page actually loads, and nothing else. index.html references
// ./src/css/*.css and ./src/js/boot.js; assets/ holds icon sources used by the
// bundlers, never by the page, so it does not travel.
const SHIP = ['index.html', 'src'];

// MEASURED 2026-09-05: 83 files, 3 598 KiB — 3.51 MiB, i.e. 88 % of this ceiling.
// The "~750 KB" this comment claimed was a v1 number and had not been re-measured
// since v2 added core/, crypto/, family/ and sync/ (store.js alone is 366 KiB).
// The ceiling is NOT the DMG budget — it is a tripwire for "something large
// wandered into src/", and at 88 % it will fire on the next substantial module
// rather than on an accident. Raising it is a deliberate act: do it in this file,
// with a reason, and re-measure the DMG budget in release.yml at the same time.
const PAYLOAD_CEILING_BYTES = 4 * 1024 * 1024;

function build() {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  for (const entry of SHIP) {
    const from = resolve(ROOT, entry);
    try {
      statSync(from);
    } catch {
      console.error(`build-frontend: ${entry} does not exist`);
      process.exit(1);
    }
    cpSync(from, join(DIST, entry), { recursive: true, dereference: true });
  }

  // ── what actually landed ───────────────────────────────────────────────────
  let total = 0;
  const files = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const size = statSync(p).size;
        total += size;
        files.push([relative(DIST, p), size]);
      }
    }
  })(DIST);

  // ── the invariants worth failing over ──────────────────────────────────────
  const problems = [];

  if (total > PAYLOAD_CEILING_BYTES) {
    const biggest = files.sort((a, b) => b[1] - a[1]).slice(0, 5);
    problems.push(
      `web payload is ${(total / 1024 / 1024).toFixed(2)} MiB, over the ${PAYLOAD_CEILING_BYTES / 1024 / 1024} MiB tripwire.\n` +
        biggest.map(([f, s]) => `    ${(s / 1024).toFixed(0).padStart(7)} KiB  ${f}`).join('\n'),
    );
  }

  // Nothing from the repository's plumbing may ride along, whatever anyone
  // nests inside src/ later.
  for (const [f] of files) {
    if (/(^|\/)(\.git|node_modules|\.DS_Store)(\/|$)/.test(f)) problems.push(`${f} must not be in the bundle`);
    if (/\.(test|dom)\.js$/.test(f)) problems.push(`${f} is a test file and must not ship`);
  }

  // Story 13.4 / 21.5, and the CSP in index.html. The shipped page may not point
  // at anything off-origin. Comments are stripped first so the (correct, useful)
  // explanatory comments in index.html do not trip it.
  const html = readFileSync(join(DIST, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
    if (/^(https?:)?\/\//i.test(m[1])) problems.push(`index.html loads an off-origin resource: ${m[1]}`);
  }
  if (!/<meta[^>]+Content-Security-Policy/i.test(html)) {
    problems.push('index.html has no Content-Security-Policy meta tag (story 13.4 / 21.5)');
  }

  if (problems.length) {
    console.error('build-frontend: refusing to ship this payload');
    for (const p of problems) console.error(`  FAIL ${p}`);
    process.exit(1);
  }

  console.log(`build-frontend: ${FRONTEND_DIR}/ ready — ${files.length} files, ${(total / 1024).toFixed(0)} KiB`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  --check-release — THE RELEASE MAY NOT STAGE INTO THIS SCRIPT'S OUTPUT
// ═════════════════════════════════════════════════════════════════════════════
//
// WHAT WAS ON DISK, AND IT WAS ON THE SHIP PATH.
//
// `src-tauri/tauri.conf.json` names `node scripts/build-frontend.mjs` as its
// beforeBuildCommand, so `cargo tauri build` runs the function above and leaves
// `<root>/dist` holding the web payload: `index.html` plus the whole `src/` tree,
// 3 598 KiB in 83 files, measured 2026-09-05 — `dist/*` expands to exactly two
// entries, `dist/index.html` and the `dist/src` DIRECTORY.
// `.github/workflows/release.yml` then staged the DMG, the updater
// archive and its signature into that SAME directory and ran
//
//     shasum -a 256 dist/* | tee dist/SHA256SUMS.txt
//
// Three consequences, none of them theoretical:
//
//   1. SHA256SUMS.txt is pasted verbatim into the PUBLIC release notes. It
//      carried a checksum line for `dist/index.html` — a file nobody downloads.
//   2. The same glob handed `shasum` the `dist/src` DIRECTORY. `shasum` exits
//      non-zero on a directory (`Is a directory`) — and GitHub Actions runs a
//      `run:` block as `bash -e {0}`, WITHOUT `pipefail`, so the pipeline's
//      status was `tee`'s zero. The checksum step could not fail. A checksum
//      step that cannot fail is not a checksum step.
//   3. `upload-artifact` took `path: dist/`, so every rehearsal shipped the web
//      payload beside the DMG.
//
// WHY THE CHECK LIVES HERE, of all files. Because this is the file that decides
// the colliding directory. A gate that hard-codes "dist" somewhere else goes
// stale the moment `FRONTEND_DIR` above changes; reading it out of the constant
// means the row moves with the thing it protects, and the mutants below kill it
// from BOTH sides — repoint the release at `dist`, or repoint this script at the
// release's staging directory, and the same row dies.
//
// NOT A NARROWER GLOB. `shasum -a 256 dist/*.dmg dist/*.tar.gz …` would go green
// today and re-open the moment a fourth artifact is added. Two directories that
// cannot overlap is the property; the glob is a symptom.
//
// Zero dependencies and no YAML parser, in keeping with the rest of the repo:
// the workflow is matched as text, which is also how `check-dmg-readme.mjs` and
// `check-release-config.mjs` read it.

const WORKFLOW = '.github/workflows/release.yml';
const TAURI_CONF = 'src-tauri/tauri.conf.json';

/** The name of the step that stages artifacts. Spelled here so a rename is a red row, not a diff. */
const STAGE_STEP = 'Stage release artifacts';

/** Lift one step's `run:` body out of the workflow text. No YAML parser (zero deps). */
function stepBody(workflow, name) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (start < 0) return null;
  const indent = lines[start].length - lines[start].trimStart().length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    const ind = l.length - l.trimStart().length;
    if (ind <= indent && l.trimStart().startsWith('- ')) { end = i; break; }
  }
  const slice = lines.slice(start, end);
  const runAt = slice.findIndex((l) => /^\s*run:\s*\|\s*$/.test(l));
  if (runAt < 0) return null;
  return slice.slice(runAt + 1).join('\n');
}

/** Drop whole-line comments — YAML's and the shell's are both `#` — so a row about
 *  what the workflow DOES is not fooled by a comment that talks about it. */
function withoutComments(text) {
  return text.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
}

/** Normalise a repo-relative directory: no `./`, no trailing slash. */
function norm(dir) {
  return String(dir ?? '').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** true when `a` and `b` are the same directory, or one contains the other. */
function collides(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return true;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/** Read the world. Everything a row needs, and nothing computed yet. */
function observe() {
  const workflow = readFileSync(join(ROOT, WORKFLOW), 'utf8');
  const staging = stepBody(workflow, STAGE_STEP) ?? '';
  const conf = JSON.parse(readFileSync(join(ROOT, TAURI_CONF), 'utf8'));
  const declared = withoutComments(staging).match(/^\s*STAGE=(\S+)\s*$/m);
  return {
    frontendDir: relative(ROOT, DIST),
    tauriFrontendDist: conf?.build?.frontendDist ?? null,
    stageDir: declared ? declared[1] : null,
    stagingStep: staging,
    workflow,
  };
}

/** Pure. `--simulate` feeds this a mutated state; nothing here reads a file. */
function releaseRows(s) {
  const out = [];
  const row = (id, ok, msg) => out.push({ id, ok: !!ok, msg });

  const staging = withoutComments(s.stagingStep ?? '');
  const workflow = withoutComments(s.workflow ?? '');

  row('STAGE-DECLARED', !!s.stageDir && !/^[/~]/.test(s.stageDir),
    `release.yml's "${STAGE_STEP}" step must declare its staging directory as a single `
    + `repo-relative \`STAGE=<dir>\` assignment; found ${JSON.stringify(s.stageDir)}. Every `
    + 'consumer downstream reads it back out of that one line as a step output, so if it is not '
    + 'there the directory is being spelled somewhere by hand and the two can drift.');

  // ── the row this whole file exists for ──────────────────────────────────────
  row('STAGE-NOT-FRONTEND', !collides(s.stageDir, s.frontendDir),
    `the release stages into ${JSON.stringify(s.stageDir)} and build-frontend.mjs rebuilds `
    + `${JSON.stringify(s.frontendDir)}. Those must not be the same directory, and neither may `
    + 'contain the other. This script `rm -rf`s its output and refills it with index.html and '
    + 'src/ as tauri.conf.json\'s beforeBuildCommand, so a shared directory means the public '
    + 'SHA256SUMS.txt hashes the web payload, `shasum` is handed a directory, and '
    + 'upload-artifact ships 3 598 KiB of frontend beside the DMG. Do not fix this by narrowing '
    + 'the glob — the next artifact re-opens it. Give the release its own directory.');

  row('TAURI-AGREES', norm(String(s.tauriFrontendDist ?? '').replace(/^\.\.\//, '')) === norm(s.frontendDir),
    `tauri.conf.json build.frontendDist is ${JSON.stringify(s.tauriFrontendDist)} but this `
    + `script writes ${JSON.stringify(s.frontendDir)}. They must name the same directory, or the `
    + 'row above is guarding a directory nothing actually builds into — and `cargo tauri build` '
    + 'would bundle a stale or missing payload.');

  const frontendRe = norm(s.frontendDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  row('NO-STRAY-DIST', !new RegExp(`(^|[^\\w./-])${frontendRe}(/|\\b)`).test(workflow),
    `release.yml still names ${JSON.stringify(norm(s.frontendDir))} outside a comment. The `
    + 'staging, manifest, upload and publish steps must reach the artifacts through the staging '
    + 'directory only; one leftover path is one asset published from, or checksummed out of, the '
    + 'frontend build.');

  const hasPipefail = /set\s+-o\s+pipefail/.test(staging);
  const hasShasumTee = /shasum[^\n]*\|\s*tee/.test(staging);
  row('CHECKSUM-CAN-FAIL', hasPipefail && !hasShasumTee,
    `the staging step sets pipefail: ${hasPipefail}; it still pipes shasum into tee: `
    + `${hasShasumTee}. GitHub runs \`run:\` as \`bash -e {0}\`, NOT \`bash -eo pipefail\`, so `
    + '`shasum … | tee …` reports tee\'s exit status and a failing shasum is invisible. That is '
    + 'exactly how `Is a directory` on dist/src rode to a green tick. Redirect instead of tee, '
    + 'and keep pipefail on so the next pipeline added here cannot repeat it.');

  row('NON-FILE-REFUSED', /\[\s*!\s*-f\s+"\$f"\s*\]/.test(staging),
    'the staging step must refuse a non-regular file before it hashes anything. A directory in '
    + 'the staging tree is what made `shasum` exit non-zero in the first place; with the pipe '
    + 'gone it now fails the step, but an explicit check names the file and says what to do '
    + 'instead of printing "Is a directory" and stopping.');

  row('SUMS-BARE-NAMES', /\(\s*cd\s+"\$STAGE"\s*&&\s*shasum/.test(staging),
    'checksums must be taken from INSIDE the staging directory (`( cd "$STAGE" && shasum … )`). '
    + 'SHA256SUMS.txt is pasted verbatim into the public release notes, so every line must be a '
    + 'bare asset name a reader can match against what they downloaded — not an internal build '
    + 'path, and not a path into a directory that does not exist for them.');

  return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--check-release')) {
  const simAt = argv.indexOf('--simulate');
  const state = simAt >= 0 ? JSON.parse(argv[simAt + 1]) : observe();
  const rows = releaseRows(state);
  const bad = rows.filter((r) => !r.ok);
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ rows }, null, 2));
  } else if (bad.length) {
    console.error('release staging check FAILED\n');
    for (const r of bad) console.error(`  ✗ ${r.id}: ${r.msg}\n`);
  } else {
    console.log(
      `release staging OK — the frontend build owns ${norm(state.frontendDir)}/, the release `
      + `stages into ${norm(state.stageDir)}/, and the checksum step can fail.`,
    );
  }
  process.exit(bad.length ? 1 : 0);
} else {
  build();
}
