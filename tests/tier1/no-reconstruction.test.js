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
  RECONSTRUCTION_MARKERS,
  SELF,
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

// The scan skips exactly one file — the detector's own, whose head lists every phrase it looks
// for and would otherwise report itself for ever. An exclusion is where a guard goes to die, so
// it is asserted to be that ONE file and nothing else.
test('the scan covers every helper but the detector itself', () => {
  const names = helperSelfDescriptions().map((h) => h.name);
  assert.ok(names.length > 5, `only ${names.length} helpers scanned — the walk stopped working`);
  assert.equal(names.includes(SELF), false, 'the detector is the one file it may not scan');
  for (const must of ['loopback.js', 'fleet.js', 'purity.js', 'mitm.js']) {
    assert.ok(names.includes(must), `${must} was not scanned`);
  }
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
  assert.equal(RECONSTRUCTION_MARKERS.length, 5, 'a marker was removed from the table');
  // Every marker fires on a banner somebody would actually write. A regex that can no longer
  // match anything is how this class of gate goes quietly vacuous — the exact failure F-9 was,
  // one directory over — and the table is small enough to keep one witness per row.
  const witnesses = [
    '// this file is a reconstruction of the original helper',
    '// a best-effort rebuild, sorry',
    '// rebuilt from the surviving call sites',
    '// rebuild from call sites',
    '// the original was better than this',
  ];
  witnesses.forEach((line, i) => {
    assert.ok(RECONSTRUCTION_MARKERS[i].test(line),
      `marker ${i} (${RECONSTRUCTION_MARKERS[i]}) no longer matches ${JSON.stringify(line)}`);
    assert.ok(reconstructionMarkerIn(line), `and the detector misses it: ${line}`);
  });
});
