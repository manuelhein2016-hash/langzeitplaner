// META — the suite polices itself.
//
// WHY THIS FILE EXISTS. LZP-402 is gated on "the entire v1 feature set stays
// green". A green suite that proves nothing is worse than no suite at all,
// because it converts an ungated retrofit into one that *looks* gated. These
// tests fail when the characterization suite stops being trustworthy, rather
// than when the app changes.
//
// Tier 2 enforces the same no-vacuous-test rule at RUNTIME (the WKWebView
// harness counts assert() calls per test and reports a test that asserted
// nothing as `not ok — VACUOUS`; standing down requires an explicit skip()
// which prints a TAP `# SKIP`). Tier 1 runs under node:test, which has no such
// hook, so the equivalent check is static: parse the tier-1 files and look at
// every test body.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TESTS = path.dirname(HERE);
const SELF = path.basename(fileURLToPath(import.meta.url));

const tier1Files = fs.readdirSync(HERE)
  .filter((f) => f.endsWith('.test.js') && f !== SELF)
  .map((f) => path.join(HERE, f));

const tier2Files = fs.readdirSync(path.join(TESTS, 'tier2'))
  .filter((f) => f.endsWith('.dom.js'))
  .map((f) => path.join(TESTS, 'tier2', f));

/** Slice out every `test('name', fn)` body by brace matching. */
function testBodies(src) {
  const out = [];
  const re = /(?:^|[\s(])test\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*,/g;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('{', re.lastIndex);
    if (open < 0) continue;
    let depth = 0, i = open;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    out.push({ name: m[2], body: src.slice(open, i + 1) });
  }
  return out;
}

test('every tier-1 test body actually asserts something', () => {
  // The cheapest possible way to ship fake coverage is a test that sets up a
  // scenario and forgets to assert on it. It passes forever and proves nothing.
  const offenders = [];
  let counted = 0;
  for (const f of tier1Files) {
    for (const { name, body } of testBodies(fs.readFileSync(f, 'utf8'))) {
      counted++;
      if (!/assert\.\w+\(/.test(body)) offenders.push(`${path.basename(f)} :: ${name}`);
    }
  }
  assert.ok(counted > 300, `only found ${counted} tier-1 test bodies — the parser stopped working`);
  assert.deepEqual(offenders, [], `tier-1 tests that assert nothing:\n  ${offenders.join('\n  ')}`);
});

test('no test has been silently disabled', () => {
  // `test.skip` / `it.skip` / a `return` on the first line are all ways a red
  // test becomes an invisible one. If a characterization genuinely cannot run,
  // it should be deleted with a note, not parked.
  const offenders = [];
  for (const f of [...tier1Files, ...tier2Files]) {
    const src = fs.readFileSync(f, 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/\b(test|it|describe)\.(skip|todo)\s*\(/.test(line)) {
        offenders.push(`${path.basename(f)}:${i + 1} ${line.trim().slice(0, 70)}`);
      }
      if (/^\s*(test|it)\(.*\{\s*return\s*;?\s*\}/.test(line)) {
        offenders.push(`${path.basename(f)}:${i + 1} empty body`);
      }
    });
  }
  assert.deepEqual(offenders, [], `disabled tests:\n  ${offenders.join('\n  ')}`);
});

test('no tier-1 test reaches outside the repo or into real user storage', () => {
  // Tier 1 must never touch ~/Library/Application Support/LangzeitPlaner, the
  // user's real board.json, or a real browser localStorage. It gets a Map-backed
  // shim from helpers/env.js and nothing else. A test that imported node:fs and
  // wrote somewhere would break that promise silently.
  const banned = [
    /Application Support/,
    /require\(\s*['"]node:fs['"]/,
    /from\s+['"]node:fs['"]/,
    /os\.homedir\(/,
    /process\.env\.HOME/,
  ];
  const offenders = [];
  for (const f of tier1Files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const re of banned) {
      if (re.test(src)) offenders.push(`${path.basename(f)} matches ${re}`);
    }
  }
  assert.deepEqual(offenders, [], `tier-1 files touching real storage:\n  ${offenders.join('\n  ')}`);
});

test('the suite characterizes v1 — it never imports a test double for src/', () => {
  // Every tier-1 file must reach the REAL modules under src/js. A stub or a
  // local re-implementation would make the suite green against itself.
  for (const f of tier1Files) {
    const src = fs.readFileSync(f, 'utf8');
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const appImports = imports.filter((i) => i.includes('src/js/'));
    const helperImports = imports.filter((i) => i.includes('helpers/'));
    const foreign = imports.filter(
      (i) => !i.startsWith('node:') && !i.includes('src/js/') && !i.includes('helpers/')
    );
    assert.deepEqual(foreign, [], `${path.basename(f)} imports something that is neither node:, src/js nor a helper: ${foreign}`);
    assert.ok(
      appImports.length > 0 || helperImports.length > 0,
      `${path.basename(f)} imports no app module at all`
    );
    for (const i of appImports) {
      assert.ok(i.startsWith('../../src/js/'), `${path.basename(f)}: ${i} does not point at the real src/`);
    }
  }
});

test('zero npm dependencies — the v1 property this suite must not break', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(TESTS, '..', 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies ?? {}, {}, 'v1 ships with no runtime dependencies');
  // The only devDependency v1 baseline carries is the Tauri CLI. No test
  // framework, no jsdom — tier 1 is node:test, tier 2 is WebKit.
  const dev = Object.keys(pkg.devDependencies ?? {});
  assert.deepEqual(dev, ['@tauri-apps/cli'], `unexpected devDependencies: ${dev}`);
  assert.ok(!fs.existsSync(path.join(TESTS, '..', 'node_modules', 'jsdom')), 'jsdom must not be installed');
});

test('npm test actually runs every tier-1 file', () => {
  // The trap this suite already fell into once: area files were written to
  // tests/ root while package.json globbed tests/tier1/*.test.js, so 333 tests
  // existed and none of them gated anything.
  const pkg = JSON.parse(fs.readFileSync(path.join(TESTS, '..', 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /tests\/tier1\/\*\.test\.js/);
  // and nothing is stranded outside the two tier directories
  const stranded = fs.readdirSync(TESTS)
    .filter((f) => f.endsWith('.test.js') || f.endsWith('.dom.js') || f.endsWith('.domtest.js'));
  assert.deepEqual(stranded, [], `test files outside tier1/ and tier2/ never run: ${stranded}`);
});

test('the tier-2 runner picks up every tier-2 file', () => {
  const sh = fs.readFileSync(path.join(TESTS, 'run-dom-tests.sh'), 'utf8');
  assert.match(sh, /tests\/tier2\/\*\.dom\.js/);
  for (const f of tier2Files) assert.match(path.basename(f), /\.dom\.js$/);
  assert.ok(tier2Files.length >= 4, `only ${tier2Files.length} tier-2 files found`);
});

// ── added in WP-1 integration: the property suite is a THIRD place tests can be stranded ─────

test('the property suite is wired into package.json and nothing in it is stranded', () => {
  // The exact trap the "npm test actually runs every tier-1 file" test above already records:
  // "area files were written to tests/ root while package.json globbed tests/tier1/*.test.js, so
  // 333 tests existed and none of them gated anything." `tests/property/` (LZP-406, ADR 005 §1.7)
  // is a new directory with its own runner, so it can fall into the same hole — and a property
  // suite that silently does not run is worse than none, because the PLAN treats P1–P9 as a gate.
  const dir = path.join(TESTS, 'property');
  if (!fs.existsSync(dir)) return;                 // the directory is optional until WP-4 lands

  const pkg = JSON.parse(fs.readFileSync(path.join(TESTS, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['test:property'], 'tests/property/ exists but npm has no way to run it');
  assert.match(pkg.scripts['test:property'], /tests\/property\/\*\.test\.js/);
  assert.match(pkg.scripts['test:all'], /test:property/,
    'test:all does not run the property suite, so CI would not either');

  // Every executable test file in there must match the glob the script uses. A file named
  // `foo.spec.js` or `p1.js` would be invisible to the runner while looking like a test.
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 0, 'tests/property/ is empty');
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const isTest = /^\s*import\s+test\s+from\s+'node:test'/m.test(src);
    if (isTest) {
      assert.match(f, /\.test\.js$/,
        `${f} declares tests but does not match tests/property/*.test.js — it never runs`);
    }
  }
});

test('the property suite really does run at least 500 seeds per property', () => {
  // PLAN.md WP-4 and LZP-406 both say "≥ 500 seeds". The number lives in one constant so it
  // cannot be quietly lowered in one file; this asserts the constant itself, so turning the suite
  // into a 5-seed smoke test is a visible change rather than an invisible one.
  const dir = path.join(TESTS, 'property');
  if (!fs.existsSync(dir)) return;
  const harness = fs.readFileSync(path.join(dir, 'harness.js'), 'utf8');
  const m = harness.match(/export const SEEDS\s*=\s*(\d+)/);
  assert.ok(m, 'tests/property/harness.js no longer exports a SEEDS constant');
  assert.ok(Number(m[1]) >= 500, `the property suite was reduced to ${m[1]} seeds (LZP-406 says ≥ 500)`);
});
