// tests/tier1/no-reconstruction.test.js
//
// A test helper may never be a best-effort reconstruction.
//
// WHY THIS EXISTS. On 2026-08-29 an agent destroyed `tests/helpers/loopback.js` — the loopback
// relay named by `server.contract.js:123`, ADR 005 §1.6 and PLAN.md — and replaced it with a
// rebuild "from the surviving CALL SITES". The rebuild imports the real server handlers, so it
// looks right and it runs; two suites import it, including `sync-convergence.test.js`.
//
// That is the most dangerous shape a test helper can have. The exports a reconstruction can
// recover from call sites are the NAMES. What it cannot recover is the BEHAVIOUR, and in this
// helper the behaviour is the entire point: `wire.partition/heal/isolated`, `hostile.onResponse`,
// `MUTATORS.shuffleOps(seed)` and `simClock` exist precisely to model a torn, reordered, delayed
// or hostile network. A helper whose partition heals one tick early, or whose seeded shuffle is
// not the shuffle the pinned seed assumes, turns a torn network into a GREEN TEST.
//
// So: a green suite over a reconstructed helper is evidence about the reconstruction, not about
// the code under test. A missing helper fails loudly and immediately, which is strictly better.
// This project spent seven adversarial rounds killing false greens; this is that class, arriving
// through the test harness instead of through the product.
//
// THE RULE. No file under `tests/helpers/` may advertise itself as a reconstruction. Recover the
// original (the owning agent's transcript, editor local history, or a pre-destruction copy —
// `sync-loopback.js` was exactly that here), or delete the file and let the imports throw.
// Do not leave a plausible rebuild at an authoritative filename.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HELPERS = fileURLToPath(new URL('../helpers/', import.meta.url));

// Phrases a rebuild uses to describe itself. Matched case-insensitively against the file's
// leading comment block only, so ordinary prose about reconstruction elsewhere is not caught.
const SELF_DESCRIPTIONS = [
  /this file is a reconstruction/i,
  /best-effort (rebuild|reconstruction)/i,
  /rebuil[td] from the surviving call sites/i,
  /rebuil[td] from (the )?call sites/i,
  /the original was better/i,
];

const headOf = (src) => src.split('\n').slice(0, 60).join('\n');

test('no helper under tests/helpers/ is a best-effort reconstruction', () => {
  const offenders = [];
  for (const name of readdirSync(HELPERS)) {
    if (!name.endsWith('.js') && !name.endsWith('.mjs')) continue;
    const src = readFileSync(path.join(HELPERS, name), 'utf8');
    const head = headOf(src);
    const hit = SELF_DESCRIPTIONS.find((re) => re.test(head));
    if (hit) offenders.push(`${name} — matched ${hit}`);
  }
  assert.deepEqual(
    offenders,
    [],
    'A test helper advertises itself as a reconstruction. Its exports were recovered from call ' +
      'sites; its BEHAVIOUR was not. Any suite importing it is testing the rebuild, not the code. ' +
      'Recover the original or delete the file so the imports throw:\n  ' + offenders.join('\n  '),
  );
});

// The guard above is worthless if it cannot fire, so prove it can.
test('the guard actually detects a reconstruction banner', () => {
  const banner = '// ⚠ THIS FILE IS A RECONSTRUCTION, AND THE ORIGINAL WAS BETTER\n// rebuilt from the surviving CALL SITES\n';
  assert.ok(
    SELF_DESCRIPTIONS.some((re) => re.test(headOf(banner))),
    'the detector must match the exact banner that motivated this rule',
  );
  assert.ok(
    !SELF_DESCRIPTIONS.some((re) => re.test(headOf('// an ordinary helper\nexport const x = 1;\n'))),
    'and must not fire on an ordinary helper',
  );
});
