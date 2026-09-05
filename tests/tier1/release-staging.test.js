// tests/tier1/release-staging.test.js — the release does not stage into the frontend build.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
//  WHAT WAS ON DISK, MEASURED
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `src-tauri/tauri.conf.json` names `node scripts/build-frontend.mjs` as its beforeBuildCommand,
// and that script `rm -rf`s `<root>/dist` and refills it with the web payload. Measured at
// 4db8f22 on 2026-09-05:
//
//     node scripts/build-frontend.mjs   ->  dist/ ready — 83 files, 3 598 KiB
//     ls -1d dist/*                     ->  dist/index.html
//                                           dist/src            <- A DIRECTORY
//
// `.github/workflows/release.yml` then staged the DMG, the updater archive and its signature
// into that SAME directory and ran `shasum -a 256 dist/* | tee dist/SHA256SUMS.txt`. Three
// things followed, and all three shipped:
//
//   1. SHA256SUMS.txt is pasted VERBATIM into the public release notes. It carried a checksum
//      line for `dist/index.html`, which is not in the release and which nobody can download.
//   2. `shasum` was handed the `dist/src` directory. It exits non-zero on one. GitHub Actions
//      runs a `run:` block as `bash -e {0}` — NOT `pipefail` — so the pipeline reported `tee`'s
//      zero and the failure was invisible. §3 below measures both halves of that claim rather
//      than asserting them.
//   3. `upload-artifact` took `path: dist/`, so every rehearsal carried 3 598 KiB of frontend
//      beside the DMG.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE REGRESSION THIS FILE EXISTS FOR, AND WHY IT IS SYMMETRIC
// ─────────────────────────────────────────────────────────────────────────────────────────────
// The fix is a staging directory the frontend build never touches — `build/release`, which is
// already gitignored and already the release's scratch space (build/dmg, build/email). It is NOT
// a narrower glob: `shasum dist/*.dmg dist/*.tar.gz` goes green today and re-opens the moment a
// fourth artifact is added.
//
// The regression is one careless edit away FROM EITHER SIDE. Someone can point the release back
// at `dist`, or point `build-frontend.mjs`'s output at `build/release`. §2's mutants kill the
// same row both ways round, which is why the predicate takes both directories as state instead
// of hard-coding one of them.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE ROWS GO THROUGH A SUBPROCESS
// ─────────────────────────────────────────────────────────────────────────────────────────────
// `suite-integrity.test.js` bans `node:fs` in tier 1 outright, so this file cannot read
// release.yml itself. The predicate therefore lives in `scripts/build-frontend.mjs` behind
// `--check-release`, and this file reaches it through `--json` and `--simulate` — the same shape
// `dmg-contents.test.js` uses for `check-dmg-readme.mjs`.
//
// It lives in `build-frontend.mjs` specifically, and not in a new checker beside it, because
// that script is the file that DECIDES the colliding directory. It reads its own `FRONTEND_DIR`
// constant back out; a gate that spelled "dist" somewhere else would go stale the moment that
// constant moved, which is exactly the class of silent drift this whole epic keeps catching.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE CANNOT PROVE
// ─────────────────────────────────────────────────────────────────────────────────────────────
// That the release WORKS. `cargo tauri build` has never run on any machine in this project and
// cannot run here, so no DMG, no `.app.tar.gz` and no `latest.json` has ever existed on disk to
// be staged. Everything below is about the pipeline's shape: which directory it writes to, which
// paths it publishes from, and whether its checksum step is capable of failing. The first real
// artifact still has to come out of a `workflow_dispatch` rehearsal (plan Part 6.1).
//
// ═════════════════════════════════════════════════════════════════════════════════════════════

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The shipped updater. `latest.json` is staged by the step under test and parsed by THIS module
// on every family Mac, so §4's claim about the published manifest is a claim about what the app
// actually reads — not about a shape invented in a test.
import { TARGET, parseManifest } from '../../src/js/platform/updater.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECK = path.join(ROOT, 'scripts', 'build-frontend.mjs');

/** The staging directory, spelled here so a silent move is a failing row and not a diff. */
const STAGE_DIR = 'build/release';

/** The directory `build-frontend.mjs` owns. Pinned for the same reason. */
const FRONTEND_DIR = 'dist';

/** Run the shipped predicate. A red row makes it exit 1; that is data, not a crash. */
function run(args) {
  let out;
  try {
    out = execFileSync('node', [CHECK, '--check-release', ...args, '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  } catch (e) {
    if (!e.stdout) throw e;
    out = e.stdout;
  }
  return JSON.parse(out).rows;
}

/** The real world, as the predicate sees it. */
const observed = () => run([]);

/** The state the predicate observes today, recovered by asking it in simulate-free mode first. */
function honestState() {
  // Built from the same literals the rows assert, so a mutant is a one-key edit away from a
  // state this file has already proved is green (§1).
  return {
    frontendDir: FRONTEND_DIR,
    tauriFrontendDist: `../${FRONTEND_DIR}`,
    stageDir: STAGE_DIR,
    stagingStep: [
      'set -o pipefail',
      `STAGE=${STAGE_DIR}`,
      'rm -rf "$STAGE"',
      'mkdir -p "$STAGE"',
      'for f in "$STAGE"/*; do',
      '  if [ ! -f "$f" ]; then',
      '    echo "::error::not a regular file"',
      '    exit 1',
      '  fi',
      'done',
      '( cd "$STAGE" && shasum -a 256 -- * ) > "$RUNNER_TEMP/SHA256SUMS.txt"',
      'mv "$RUNNER_TEMP/SHA256SUMS.txt" "$STAGE/SHA256SUMS.txt"',
    ].join('\n'),
    workflow: [
      '      - name: Stage release artifacts',
      '        id: stage',
      `          STAGE=${STAGE_DIR}`,
      '          path: ${{ steps.stage.outputs.dir }}/',
      '            "$STAGE/latest.json" \\',
    ].join('\n'),
  };
}

/** Rows for a mutated state. `patch` is applied over the honest one. */
function mutate(patch) {
  const state = { ...honestState(), ...patch };
  return run(['--simulate', JSON.stringify(state)]);
}

const idsOf = (rows) => rows.map((r) => r.id);
const row = (rows, id) => {
  const r = rows.find((x) => x.id === id);
  assert.ok(r, `no row named ${id} — the predicate was renamed and this file stopped gating`);
  return r;
};
const red = (rows) => rows.filter((r) => !r.ok).map((r) => r.id);

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('§1 · the pipeline as it stands today', () => {
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  test('every release-staging row is green against the real repository', () => {
    const rows = observed();
    assert.deepEqual(
      red(rows),
      [],
      'release.yml and build-frontend.mjs disagree:\n  '
        + rows.filter((r) => !r.ok).map((r) => `${r.id}: ${r.msg}`).join('\n  '),
    );
  });

  test('the predicate produces the seven rows this file names', () => {
    // A row that is silently dropped is a gate that silently stops gating. Naming the set here
    // means deleting one is a failure in this file, not an absence nobody notices.
    assert.deepEqual(idsOf(observed()), [
      'STAGE-DECLARED',
      'STAGE-NOT-FRONTEND',
      'TAURI-AGREES',
      'NO-STRAY-DIST',
      'CHECKSUM-CAN-FAIL',
      'NON-FILE-REFUSED',
      'SUMS-BARE-NAMES',
    ]);
  });

  test('the honest-path control: the state §2 mutates is itself green', () => {
    // THE CONTROL. Every mutant below is this state with one key changed. If the unmutated state
    // were already red, the mutants would prove nothing at all — they would just be red twice.
    const rows = mutate({});
    assert.deepEqual(red(rows), [], 'the unmutated simulate state is not green — §2 proves nothing');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('§2 · mutants — each names the row that dies', () => {
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  test('the release stages back into dist/ — STAGE-NOT-FRONTEND dies', () => {
    // The exact state on disk before this change: `mkdir -p dist` in the staging step.
    const rows = mutate({ stageDir: FRONTEND_DIR });
    assert.equal(row(rows, 'STAGE-NOT-FRONTEND').ok, false);
    assert.match(row(rows, 'STAGE-NOT-FRONTEND').msg, /must not be the same directory/);
    assert.deepEqual(red(rows), ['STAGE-NOT-FRONTEND'], 'exactly one row should die for this');
  });

  test('the release stages INSIDE dist/ — STAGE-NOT-FRONTEND dies', () => {
    // The plausible "fix" that is not one: a subdirectory of the frontend output survives the
    // next `rm -rf DIST` for exactly as long as nobody rebuilds the frontend after staging.
    assert.equal(row(mutate({ stageDir: `${FRONTEND_DIR}/release` }), 'STAGE-NOT-FRONTEND').ok, false);
  });

  test('build-frontend.mjs is repointed AT the staging directory — the same row dies', () => {
    // The symmetric careless edit. Nothing in release.yml changes; this script's FRONTEND_DIR
    // moves onto the staging tree and the next `cargo tauri build` deletes the release.
    const rows = mutate({ frontendDir: STAGE_DIR, tauriFrontendDist: `../${STAGE_DIR}` });
    assert.equal(row(rows, 'STAGE-NOT-FRONTEND').ok, false);
  });

  test('the frontend output CONTAINS the staging directory — the same row dies', () => {
    const rows = mutate({ frontendDir: 'build', tauriFrontendDist: '../build' });
    assert.equal(row(rows, 'STAGE-NOT-FRONTEND').ok, false);
  });

  test('the staging step stops declaring STAGE= — STAGE-DECLARED dies', () => {
    const rows = mutate({ stageDir: null });
    assert.equal(row(rows, 'STAGE-DECLARED').ok, false);
  });

  test('an absolute staging path — STAGE-DECLARED dies', () => {
    // `STAGE=/tmp/release` would work on a runner and make `upload-artifact`'s `path:` and
    // `gh release create` reach outside the workspace. The step output is repo-relative or it
    // is not a step output.
    assert.equal(row(mutate({ stageDir: '/tmp/release' }), 'STAGE-DECLARED').ok, false);
  });

  test('tauri.conf.json is repointed away from what this script builds — TAURI-AGREES dies', () => {
    // Without this row, STAGE-NOT-FRONTEND could be satisfied by guarding a directory that
    // `cargo tauri build` no longer bundles from.
    const rows = mutate({ tauriFrontendDist: '../frontend' });
    assert.equal(row(rows, 'TAURI-AGREES').ok, false);
    assert.deepEqual(red(rows), ['TAURI-AGREES']);
  });

  test('one leftover dist/ path in a publish step — NO-STRAY-DIST dies', () => {
    // The half-done edit: the staging step moves, `gh release create` does not, and the release
    // publishes from a directory that holds the web payload.
    const s = honestState();
    const rows = mutate({ workflow: `${s.workflow}\n            dist/latest.json \\` });
    assert.equal(row(rows, 'NO-STRAY-DIST').ok, false);
    assert.deepEqual(red(rows), ['NO-STRAY-DIST']);
  });

  test('a COMMENT naming dist/ does not kill NO-STRAY-DIST', () => {
    // The row is about what the workflow does. The step's own explanation has to be able to say
    // the word "dist" — the comment block above the staging step is most of why this fix is
    // legible — so a row that could not tell the two apart would force the explanation out.
    const s = honestState();
    const rows = mutate({ workflow: `${s.workflow}\n      # it used to be dist/ and that was the bug` });
    assert.deepEqual(red(rows), []);
  });

  test('pipefail is dropped from the staging step — CHECKSUM-CAN-FAIL dies', () => {
    const s = honestState();
    const rows = mutate({ stagingStep: s.stagingStep.replace('set -o pipefail\n', '') });
    assert.equal(row(rows, 'CHECKSUM-CAN-FAIL').ok, false);
    assert.match(row(rows, 'CHECKSUM-CAN-FAIL').msg, /bash -e \{0\}/);
  });

  test('the checksum goes back through `| tee` — CHECKSUM-CAN-FAIL dies', () => {
    // Even WITH pipefail this row stays red, on purpose. `shasum … | tee dist/SHA256SUMS.txt`
    // has a second defect: `tee` creates the output file when the pipeline is set up, so the
    // glob feeding shasum can pick up the sums file and hash it. Measured in §3.
    const s = honestState();
    const rows = mutate({
      stagingStep: `${s.stagingStep}\nshasum -a 256 "$STAGE"/* | tee "$STAGE/SHA256SUMS.txt"`,
    });
    assert.equal(row(rows, 'CHECKSUM-CAN-FAIL').ok, false);
  });

  test('the non-regular-file guard is removed — NON-FILE-REFUSED dies', () => {
    const s = honestState();
    const rows = mutate({ stagingStep: s.stagingStep.replace('  if [ ! -f "$f" ]; then', '  if false; then') });
    assert.equal(row(rows, 'NON-FILE-REFUSED').ok, false);
  });

  test('checksums taken from outside the staging directory — SUMS-BARE-NAMES dies', () => {
    // `shasum -a 256 "$STAGE"/*` produces `build/release/LangzeitPlaner-2.0.0-universal.dmg`,
    // and that string goes verbatim into the public release notes.
    const s = honestState();
    const rows = mutate({
      stagingStep: s.stagingStep.replace(
        '( cd "$STAGE" && shasum -a 256 -- * ) > "$RUNNER_TEMP/SHA256SUMS.txt"',
        'shasum -a 256 "$STAGE"/* > "$RUNNER_TEMP/SHA256SUMS.txt"',
      ),
    });
    assert.equal(row(rows, 'SUMS-BARE-NAMES').ok, false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('§3 · the masking, measured rather than asserted', () => {
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  //
  // Every claim above about `bash -e` and `pipefail` is a claim about a shell, so it is settled
  // by running one. The scratch tree is made and removed by the script itself, which keeps this
  // file free of `node:fs` (suite-integrity bans it here) and off the user's real storage.

  /** Run a script under `bash -e` in a throwaway directory shaped like the old `dist/`. */
  function inFakeDist(script) {
    const prelude = [
      'set -e',
      'D=$(mktemp -d)',
      'trap \'rm -rf "$D"\' EXIT',
      'cd "$D"',
      'mkdir -p dist/src',
      'printf x > dist/index.html',
      'printf y > dist/src/store.js',
      'printf z > dist/LangzeitPlaner-2.0.0-universal.dmg',
    ].join('\n');
    try {
      const stdout = execFileSync('bash', ['-c', `${prelude}\n${script}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, stdout };
    } catch (e) {
      return { status: e.status, stdout: e.stdout ?? '' };
    }
  }

  test('`shasum` on a directory exits non-zero — the failure is real', () => {
    const r = inFakeDist('shasum -a 256 dist/src > /dev/null');
    assert.notEqual(r.status, 0, 'shasum accepted a directory; the premise of this whole file is gone');
  });

  test('`shasum dist/* | tee` under bash -e exits 0 — the failure was INVISIBLE', () => {
    // This is the shape release.yml had, and the shape GitHub Actions runs (`bash -e {0}`).
    const r = inFakeDist('shasum -a 256 dist/* | tee dist/SHA256SUMS.txt > /dev/null');
    assert.equal(r.status, 0, 'the old pipeline would have failed — then the bug was never invisible');
  });

  test('the same pipeline with pipefail exits non-zero — the fix is the fix', () => {
    const r = inFakeDist('set -o pipefail\nshasum -a 256 dist/* | tee dist/SHA256SUMS.txt > /dev/null');
    assert.notEqual(r.status, 0, 'pipefail did not surface shasum\'s failure');
  });

  test('the shipped shape fails loudly on a directory, and hashes bare names otherwise', () => {
    // Exactly what the staging step now does, over a tree that contains a directory: the guard
    // catches it and the step stops.
    const guarded = [
      'set -o pipefail',
      'STAGE=dist',
      'for f in "$STAGE"/*; do',
      '  if [ ! -f "$f" ]; then echo "not a regular file: $f"; exit 1; fi',
      'done',
      '( cd "$STAGE" && shasum -a 256 -- * ) > sums.txt',
    ].join('\n');
    const bad = inFakeDist(guarded);
    assert.notEqual(bad.status, 0, 'a directory in the staging tree did not stop the step');
    assert.match(bad.stdout, /not a regular file: dist\/src/);

    // And over a tree of files only, it produces BARE names — what the public notes must carry.
    const good = inFakeDist(`rm -rf dist/src\n${guarded}\ncat sums.txt`);
    assert.equal(good.status, 0, good.stdout);
    assert.match(good.stdout, /^[0-9a-f]{64} {2}LangzeitPlaner-2\.0\.0-universal\.dmg$/m);
    assert.doesNotMatch(good.stdout, /dist\//, 'a build path leaked into the public checksum list');
    // …and the sums file does not hash itself, which `| tee` can do: tee opens the output when
    // the pipeline is set up, so the glob feeding shasum may see it. Redirect-then-move cannot.
    assert.doesNotMatch(good.stdout, /sums\.txt/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('§4 · what is staged is what the fleet reads', () => {
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  //
  // The staging directory is not bookkeeping: `latest.json` is written into it, published from
  // it, and then fetched by every installed Mac. These rows tie the directory to the shipped
  // client so the fix cannot be "correct" in a way the updater disagrees with.

  test('the published asset name is the key the shipped updater looks up', () => {
    // release.yml step 16 asserts `published.platforms["darwin-universal"]` by hand. That string
    // is only right because the updater asks for it — so assert it against the module, not the
    // literal, or the two can drift and only Mom finds out.
    assert.equal(TARGET, 'darwin-universal');
  });

  test('a manifest staged under the new directory still parses for the fleet', () => {
    // The manifest's CONTENT does not depend on where it was staged — and that is the point:
    // moving the directory must be a pipeline change and not a protocol change. This row would
    // catch a "fix" that renamed the platform key along with the directory.
    const staged = {
      version: '2.0.0',
      notes: 'LangzeitPlaner 2.0.0',
      pub_date: '2026-09-05T00:00:00Z',
      platforms: {
        [TARGET]: {
          signature: 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=',
          url: 'https://github.com/o/r/releases/download/v2.0.0/LangzeitPlaner-2.0.0-universal.app.tar.gz',
        },
      },
    };
    const parsed = parseManifest(JSON.stringify(staged));
    assert.equal(parsed.version, '2.0.0');
    assert.ok(parsed.platforms[TARGET], `the updater found no ${TARGET} entry — the fleet sees no update`);
    assert.ok(
      parsed.platforms[TARGET].url.endsWith('.app.tar.gz'),
      'the updater downloads the archive, not the DMG',
    );
  });

  test('the staging directory is gitignored — a local run leaves no untracked tree', () => {
    // `build/` is already ignored (release artwork and the DMG read-me live under it), which is
    // half of why the staging tree was put there rather than in a new top-level directory.
    let ignored = true;
    try {
      execFileSync('git', ['check-ignore', '-q', STAGE_DIR], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      ignored = false;
    }
    assert.ok(
      ignored,
      `${STAGE_DIR} is not gitignored. Staging writes five release assets into it, and an `
        + 'untracked DMG in the working tree is a thing somebody eventually commits.',
    );
  });
});
