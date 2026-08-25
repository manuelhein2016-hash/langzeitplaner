// tests/tier1/core-purity.test.js — the DOM-free boundary gate.  ADR 005 §2.
//
// THE HARD RULE THIS FILE ENFORCES:
//   No file under src/js/core/, src/js/crypto/, src/js/sync/ or server/core/ may reference
//   window, document, localStorage, indexedDB, navigator, alert, fetch, XMLHttpRequest,
//   setTimeout/setInterval, process.env, node:fs, Date.now() or Math.random(). Clock and
//   randomness arrive through ctx/ports. The dependency direction is one-way.
//
// Enforced twice, mechanically, exactly as ADR 005 §2 specifies:
//   1. STATICALLY — read every file, strip comments and string literals, fail on a forbidden
//      identifier with file:line, and fail on any import whose specifier escapes the allowed
//      direction.
//   2. DYNAMICALLY — `await import()` every one of those files under bare Node with
//      globalThis.window and globalThis.document DELETED, asserting no throw.
//
// FILES ARE DISCOVERED BY READING THE DIRECTORY, never from a list. A module added by a later
// work package is covered the moment it lands. That is the point: this gate has to be the thing
// nobody remembers to update.
//
// The filesystem work lives in ../helpers/purity.js because suite-integrity.test.js forbids
// node:fs inside a tier-1 test file, and that rule protects the user's real board.json.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PURE_DIRS,
  dirExists,
  pureFiles,
  scanForbidden,
  scanImportDirection,
  stripCommentsAndStrings,
  importSpecifiers,
} from '../helpers/purity.js';

// ─────────────────────────────────────────────────────────────────────────────
// Delete the two globals BEFORE anything under test can be imported. Node has neither by
// default; we define them first so the deletion is a real deletion rather than a no-op, and so
// this file would still be a meaningful gate if it were ever run under a harness that provides
// them (tests/helpers/env.js, for instance, defines `window` — which is exactly why this file
// must not import it).
// ─────────────────────────────────────────────────────────────────────────────
globalThis.window = { pretend: 'browser' };
globalThis.document = { pretend: 'dom' };
delete globalThis.window;
delete globalThis.document;

const FILES = pureFiles();

test('the pure directories are discovered by reading the tree, and core/ is populated', () => {
  assert.ok(dirExists('src/js/core'), 'src/js/core must exist');
  const core = FILES.filter((f) => f.dir === 'src/js/core');
  assert.ok(core.length >= 5, `expected at least the five level-0 core modules, found ${core.length}`);
  // The gate must not be silently scoped to nothing if a directory is renamed.
  assert.deepEqual(PURE_DIRS.filter(dirExists).length > 0, true);
  for (const f of FILES) {
    assert.match(f.rel, /^(src\/js\/(core|crypto|sync)|server\/core)\//);
  }
});

test('window and document really are absent for the whole of this file', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(Object.prototype.hasOwnProperty.call(globalThis, 'window'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(globalThis, 'document'), false);
});

test('every pure module imports cleanly with window and document deleted', async () => {
  const failures = [];
  const exportCounts = [];
  for (const f of FILES) {
    try {
      const mod = await import(f.url);
      exportCounts.push([f.rel, Object.keys(mod).length]);
    } catch (err) {
      failures.push(`${f.rel}: ${err && err.message}`);
    }
  }
  assert.deepEqual(failures, [], `modules that threw under bare Node:\n  ${failures.join('\n  ')}`);
  const empty = exportCounts.filter(([, n]) => n === 0).map(([rel]) => rel);
  assert.deepEqual(empty, [], `modules exporting nothing (an empty gate is not a gate): ${empty}`);
});

test('importing the pure modules does not conjure window or document into existence', () => {
  // A module that shims what it needs would pass the import check and still be DOM-coupled.
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof globalThis.localStorage, 'undefined');
});

test('no forbidden identifier appears in any pure module', () => {
  const hits = [];
  for (const f of FILES) hits.push(...scanForbidden(f));
  const report = hits.map((h) => `${h.file}:${h.line} uses ${h.ident} -> ${h.text}`);
  assert.deepEqual(report, [], `ADR 005 §2 violations:\n  ${report.join('\n  ')}`);
});

test('no import escapes the one-way dependency direction', () => {
  const bad = [];
  for (const f of FILES) bad.push(...scanImportDirection(f));
  const report = bad.map((b) => `${b.file}:${b.line} imports ${b.spec} — ${b.why}`);
  assert.deepEqual(report, [], `dependency-direction violations:\n  ${report.join('\n  ')}`);
});

test('every pure module is reached by the static scan (no zero-length source)', () => {
  for (const f of FILES) {
    assert.ok(f.src.length > 0, `${f.rel} is empty`);
    assert.equal(stripCommentsAndStrings(f.src).split('\n').length, f.src.split('\n').length,
      `${f.rel}: the scanner lost a line, so reported line numbers would be wrong`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURE BUILDERS. The negative controls below need source text that CONTAINS import
// statements. Writing them as literals would make this file itself look, to
// suite-integrity.test.js's own grep, like a tier-1 test that imports src/ modules and
// node:fs directly — and that grep is right to be blunt. So the fixtures are assembled at
// runtime instead, which keeps every import-looking sequence out of this file's own source.
// ─────────────────────────────────────────────────────────────────────────────

const imp = (what, spec) => `import ${what} from ${JSON.stringify(spec)};`;
const reExport = (what, spec) => `export { ${what} } from ${JSON.stringify(spec)};`;
const dynImp = (spec) => `const m = await import(${JSON.stringify(spec)});`;

// ─────────────────────────────────────────────────────────────────────────────
// The scanner polices itself. A gate whose detector is broken is worse than no gate: it turns
// an unguarded boundary into one that LOOKS guarded. These are the negative controls.
// ─────────────────────────────────────────────────────────────────────────────

test('the scanner catches a violation in code', () => {
  const hits = scanForbidden({ rel: 'fake.js', src: 'export const x = 1;\nconst el = document.body;\n' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].ident, 'document');
  assert.equal(hits[0].line, 2);
});

test('the scanner catches every identifier on the ADR 005 §2 list', () => {
  const samples = {
    window: 'const a = window.x;',
    document: 'const a = document.x;',
    localStorage: 'localStorage.getItem("k");',
    indexedDB: 'indexedDB.open("db");',
    navigator: 'const a = navigator.userAgent;',
    alert: 'alert("hi");',
    fetch: 'fetch("/x");',
    XMLHttpRequest: 'const r = new XMLHttpRequest();',
    setTimeout: 'setTimeout(f, 1);',
    setInterval: 'setInterval(f, 1);',
    'process.env': 'const a = process.env.X;',
    'node:fs': imp('fsMod', 'node:fs'),
    'Date.now': 'const t = Date.now();',
    'Math.random': 'const r = Math.random();',
  };
  const missed = [];
  for (const [ident, src] of Object.entries(samples)) {
    const hits = scanForbidden({ rel: 'fake.js', src });
    if (!hits.some((h) => h.ident === ident)) missed.push(ident);
  }
  assert.deepEqual(missed, [], `the scanner would not have caught: ${missed}`);
});

test('the scanner does NOT fire on the same words in comments or string literals', () => {
  const src = [
    '// this module must never touch document or window',
    '/* Date.now() is banned here; the clock is injected */',
    'const message = "localStorage is unavailable";',
    'const t = `Math.random is not used`;',
    'export const ok = 1;',
  ].join('\n');
  assert.deepEqual(scanForbidden({ rel: 'fake.js', src }), []);
});

test('the scanner still fires inside a template literal expression', () => {
  // `${...}` is code, not text. A reference hiding in one must not slip through.
  const src = 'export const s = `value: ${document.title}`;';
  const hits = scanForbidden({ rel: 'fake.js', src });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].ident, 'document');
});

test('a regex literal containing a quote does not swallow the rest of the file', () => {
  const src = 'const re = /["\']/;\nconst a = window.x;\n';
  const hits = scanForbidden({ rel: 'fake.js', src });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].ident, 'window');
  assert.equal(hits[0].line, 2);
});

test('the import-direction scan catches an escape out of core/', () => {
  const bad = scanImportDirection({
    rel: 'src/js/core/bad.js',
    dir: 'src/js/core',
    src: [imp('{ saveBoard }', '../storage.js'), imp('{ x }', '../platform/net.js')].join('\n'),
  });
  assert.equal(bad.length, 2);
  assert.match(bad[0].why, /outside/);
});

test('the import-direction scan accepts core -> core and crypto -> core', () => {
  assert.deepEqual(
    scanImportDirection({ rel: 'src/js/core/a.js', dir: 'src/js/core', src: imp('{ b64u }', './b64.js') }),
    []
  );
  assert.deepEqual(
    scanImportDirection({ rel: 'src/js/crypto/a.js', dir: 'src/js/crypto', src: imp('{ canonicalJSON }', '../core/canon.js') }),
    []
  );
});

test('the import-direction scan rejects a bare specifier — zero npm dependencies', () => {
  const bad = scanImportDirection({ rel: 'src/js/core/a.js', dir: 'src/js/core', src: imp('x', 'lodash') });
  assert.equal(bad.length, 1);
  assert.match(bad[0].why, /zero npm dependencies/);
});

test('import specifiers are found on both static and dynamic forms', () => {
  const specs = importSpecifiers({
    rel: 'x.js',
    src: [imp('a', './a.js'), reExport('b', './b.js'), dynImp('./c.js')].join('\n'),
  }).map((s) => s.spec);
  assert.deepEqual(specs, ['./a.js', './b.js', './c.js']);
});
