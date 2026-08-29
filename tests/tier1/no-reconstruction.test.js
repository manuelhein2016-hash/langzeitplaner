// tests/tier1/no-reconstruction.test.js
//
// A test helper may never be a best-effort reconstruction.
//
// WHY THIS EXISTS. On 2026-08-29 an agent destroyed `tests/helpers/loopback.js` — the loopback
// relay named by `server.contract.js:123`, ADR 005 §1.6 and PLAN.md — and replaced it with a
// rebuild "from the surviving CALL SITES". The rebuild imports the real server handlers, so it
// looks right and it runs; two suites import it, including `sync-convergence.test.js`.
//
// That is the most dangerous shape a test helper can have. What a rebuild recovers from call
// sites is the export NAMES. What it cannot recover is the BEHAVIOUR — and in this helper the
// behaviour is the entire point: `wire.partition/heal/isolated`, `hostile.onResponse`,
// `MUTATORS.shuffleOps(seed)` and `simClock` exist precisely to model a torn, reordered, delayed
// or hostile network. A partition that heals one tick early, or a seeded shuffle that is not the
// shuffle the pinned seed assumes, turns a torn network into a GREEN TEST.
//
// So a green suite over a reconstructed helper is evidence about the reconstruction, not about
// the code under test. A missing helper fails loudly and immediately, which is strictly better.
// This project spent seven adversarial rounds killing false greens; this is that class arriving
// through the harness instead of through the product.
//
// THE RULE. No file under `tests/helpers/` may advertise itself as a reconstruction. Recover the
// original — the owning agent's transcript, editor local history, or a pre-destruction copy
// (`sync-loopback.js` was exactly that here) — or delete the file and let the imports throw. Do
// not leave a plausible rebuild at an authoritative filename.
//
// The fs read lives in `helpers/helper-hygiene.js` because `suite-integrity.test.js` bans
// `node:fs` from tier-1 test files and requires every tier-1 test to import a helper or an app
// module. Both rules are right; this guard obeys them rather than being an exception to them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  helperSelfDescriptions,
  reconstructionMarkerIn,
} from '../helpers/helper-hygiene.js';

test('no helper under tests/helpers/ is a best-effort reconstruction', () => {
  const offenders = helperSelfDescriptions()
    .filter((h) => h.marker)
    .map((h) => `${h.name} — matched ${h.marker}`);

  assert.deepEqual(
    offenders,
    [],
    'A test helper advertises itself as a reconstruction. Its exports were recovered from call ' +
      'sites; its BEHAVIOUR was not. Any suite importing it is testing the rebuild, not the code ' +
      'under test. Recover the original or delete the file so the imports throw:\n  ' +
      offenders.join('\n  '),
  );
});

// A guard that cannot fail is the same bug one level up, so prove this one can.
test('the guard actually detects a reconstruction banner, and only that', () => {
  assert.ok(
    reconstructionMarkerIn(
      '// ⚠ THIS FILE IS A RECONSTRUCTION, AND THE ORIGINAL WAS BETTER\n// rebuilt from the surviving CALL SITES\n',
    ),
    'the detector must match the exact banner that motivated this rule',
  );
  assert.equal(
    reconstructionMarkerIn('// an ordinary helper\nexport const x = 1;\n'),
    null,
    'and must not fire on an ordinary helper',
  );
});
