// ─────────────────────────────────────────────────────────────────────────────
// THE ORACLE'S OWN GUARD
//
// `tests/fixtures/v1-store-frozen.js` is the v1 store as it stood at the baseline commit, and it
// is what three suites now compare the v2 core against. An oracle that can be edited is not an
// oracle, so this file re-derives it from git on every run and refuses any difference beyond the
// three import specifiers that had to move for the file to resolve from `tests/fixtures/`.
//
// If this goes red, someone edited the frozen copy. Restore it; do not "fix" the assertion.
// ─────────────────────────────────────────────────────────────────────────────

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

/** The v1 baseline. `docs/v2/STATUS.md` §3 pins it as "v1 baseline — LangzeitPlaner 1.0 as handed over". */
const BASELINE = '66126e9';

/** The only edits the vendored copy is allowed to carry: the import specifiers, rewritten. */
const REWRITES = [
  ["from '../../src/js/dates.js'", "from './dates.js'"],
  ["from '../../src/js/palette.js'", "from './palette.js'"],
  ["from '../../src/js/storage.js'", "from './storage.js'"],
];

describe('the frozen v1 store is the baseline commit, byte for byte', () => {
  test('it re-derives from git with only the three import specifiers changed', () => {
    const fromGit = execFileSync(
      'git', ['show', `${BASELINE}:src/js/store.js`],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 << 20 },
    );

    const vendored = readFileSync(path.join(ROOT, 'tests/fixtures/v1-store-frozen.js'), 'utf8');

    // Strip the header this repository added above the vendored body. The sentinel is the only
    // thing separating the two, and everything below it must be v1, unchanged.
    const SENTINEL = '// ==== VENDORED BODY BEGINS — everything below is 66126e9:src/js/store.js ====\n';
    const at = vendored.indexOf(SENTINEL);
    assert.notEqual(at, -1, 'the vendored file has lost its sentinel line');
    const body = vendored.slice(at + SENTINEL.length);

    let restored = body;
    for (const [vendoredSpec, originalSpec] of REWRITES) {
      assert.ok(body.includes(vendoredSpec), `the vendored copy lost ${vendoredSpec}`);
      restored = restored.replace(vendoredSpec, originalSpec);
    }

    assert.equal(
      restored, fromGit,
      'tests/fixtures/v1-store-frozen.js is no longer `git show 66126e9:src/js/store.js`',
    );
  });

  test('and the header says so, so nobody has to read this test to know', () => {
    const vendored = readFileSync(path.join(ROOT, 'tests/fixtures/v1-store-frozen.js'), 'utf8');
    assert.ok(vendored.includes(BASELINE), 'the header must name the commit it is frozen at');
    assert.ok(
      /DO NOT "UPDATE" THIS FILE/.test(vendored),
      'the header must say plainly that this file is not to be updated',
    );
  });
});
