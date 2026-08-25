// tests/property/harness.js — shared scaffolding for the LZP-406 property suite.
//
// NOT a test file (no `.test.js`), so `npm run test:property` does not pick it up as one.
//
// The one job here that matters: when a property fails, the failure has to be REPLAYABLE and
// SMALL. A property suite whose failure message is "expected A to equal B" over two 40 kB JSON
// blobs across 500 seeds is a suite people turn off. `check()` therefore prints the seed, shrinks
// the counterexample by delta debugging, and prints the minimal op list — and it pins the seed in
// the message so the failing case can be copied straight into a regression test.

import assert from 'node:assert/strict';
import { shrink, describe as describeOps } from '../helpers/gen.js';

/**
 * How many seeds every property runs over. LZP-406 and PLAN.md WP-4 both say **≥ 500**.
 *
 * It is a constant rather than an environment read on purpose: ADR 005 §5 forbids `process.env`
 * in the pure tree, and a suite whose coverage silently depends on how the runner was invoked is
 * a suite that is green on the developer's machine and untested in CI.
 */
export const SEEDS = 500;

/** `[0, 1, … SEEDS-1]` — consecutive on purpose; see the note on `pcg32` in gen.js. */
export const seeds = (n = SEEDS) => Array.from({ length: n }, (_, i) => i);

/**
 * Run `body(seed)` over every seed. `body` throws to fail.
 *
 * Reports the FIRST failing seed rather than the last, and rethrows with the seed in the message,
 * so the fix cycle is "copy the seed into a regression test, then debug one case".
 *
 * @param {number[]} range @param {(seed:number) => void} body @param {string} label
 */
export function forEachSeed(range, label, body) {
  for (const seed of range) {
    try {
      body(seed);
    } catch (err) {
      err.message = `${label} FAILED at seed ${seed}\n` +
        `  → pin it: add a regression test that calls this property with seed ${seed} only\n` +
        `${err.message}`;
      throw err;
    }
  }
}

/**
 * The shrinking wrapper. `predicate(ops)` returns true when the bug still reproduces; on failure
 * the op set is minimised and printed.
 *
 * `keep` pins the authorization preamble — attestations, member records, the genesis link. Drop
 * one of those and every family op becomes inadmissible, which "reproduces" the failure for
 * entirely the wrong reason and hands the reader a counterexample that is a lie.
 *
 * @param {Object[]} ops @param {(ops:Object[]) => boolean} reproduces @param {string} label
 */
export function reportShrunk(ops, reproduces, label) {
  const keep = (op) => op.k === 'member.set' || op.k === 'space.set';
  const minimal = shrink(ops, reproduces, { keep });
  assert.fail(
    `${label}\n` +
    `  shrank ${ops.length} ops → ${minimal.length}\n` +
    `${describeOps(minimal)}`,
  );
}

/** A stable byte signature. Deep-equality would not catch array or key ORDER; this does. */
export const sig = (x) => JSON.stringify(x);
