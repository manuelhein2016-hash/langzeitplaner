// tests/property/convergence.test.js — P1, P2, P3, P4, P10 (LZP-406, ADR 005 §4.2).
//
// ADR 001 §0.2: "State is a pure function of the SET of ops. Not of any sequence. Reorder-,
// duplicate- and interleave-convergence are therefore true by construction (§6), not by argument,
// and are a one-line property test."
//
// That claim is the load-bearing beam of the whole v2 design — every sync guarantee, every
// offline story, every "three weeks later it just works" in the spec rests on it. "True by
// construction" is exactly the kind of claim that is true right up until someone adds a special
// case for one field. These are the tests that notice.
//
// Every property here runs the REAL pipeline — `foldAuthorized` then `materialize` — not just the
// join. Registers converging while the projection does not is a bug the user sees and a
// register-level test cannot find (it was, in fact, a real bug: `materialize` projected in Map
// iteration order, which is arrival order, so two converged devices rendered the same entry with
// different key orders).

import test from 'node:test';
import assert from 'node:assert/strict';

import '../helpers/env.js';
import {
  generate, pcg32, xorshift32, shuffle, duplicateSome, partition, interleave, SCENARIOS,
} from '../helpers/gen.js';
import { SEEDS, seeds, forEachSeed, sig } from './harness.js';

import { defaultState } from '../../src/js/store.js';
import { foldAuthorized } from '../../src/js/core/authz.js';
import {
  fold, applyOp, mergeMaps, cloneRegisters, serializeRegisters, deserializeRegisters,
  getRegister, cmpWrites,
} from '../../src/js/core/registers.js';
import { materialize } from '../../src/js/core/materialize.js';
import { createOpLog } from '../../src/js/core/oplog.js';

/** The full pipeline, as a byte string. This is what "the same state" means everywhere below. */
function view(ops, world) {
  const r = foldAuthorized(ops, world.authzCtx);
  return sig(materialize(r.regs, { ...world.mctx, defaultSettings: defaultState().settings }));
}

/** Just the registers, as a byte string — sorted at both levels by `serializeRegisters`. */
const regsSig = (ops, world) => sig(serializeRegisters(foldAuthorized(ops, world.authzCtx).regs));

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The generator itself. If this is weak, everything below is theatre.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the generator produces every scenario ADR 005 §4.2 names', () => {
  // §4.2: "The generator matters more than the assertions." This is the assertion that keeps that
  // true — if someone edits gen.js and quietly stops emitting deletes, the properties below stay
  // green while testing much less, and only this test notices.
  const seen = new Set();
  for (const s of seeds(60)) for (const x of generate(s).scenarios) seen.add(x);
  const missing = SCENARIOS.filter((s) => !seen.has(s));
  assert.deepEqual(missing, [], `the generator stopped producing: ${missing.join(', ')}`);
});

test('the generator produces genuinely different streams for consecutive seeds', () => {
  // Property seeds are 0, 1, 2, … and a weak PRNG hands consecutive seeds correlated first
  // outputs — so 500 seeds would explore a handful of distinct op streams and the seed count
  // would be a lie. This measures it rather than assuming PCG behaves.
  const shapes = new Set();
  for (const s of seeds(200)) {
    const w = generate(s);
    shapes.add(`${w.ops.length}:${w.ops.map((o) => o.k[0]).join('')}`);
  }
  assert.ok(shapes.size > 150, `only ${shapes.size} distinct streams across 200 seeds`);
});

test('the generator emits ops the REAL validator admits, and some it must PARK', () => {
  // A generator whose ops are quietly rejected proves nothing: the fold would be converging over
  // the empty set. Both halves are asserted — mostly admitted, and at least one parked, because
  // the +25 h device exists precisely so that parking is exercised.
  let parked = 0;
  for (const s of seeds(40)) {
    const w = generate(s);
    const r = foldAuthorized(w.ops, w.authzCtx);
    assert.ok(r.admitted.length > w.ops.length * 0.8,
      `seed ${s}: only ${r.admitted.length}/${w.ops.length} ops were admitted`);
    parked += r.parked.length;
  }
  assert.ok(parked > 0, 'no op was ever parked — the +25 h device is not doing its job');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// P1 — ORDER-INDEPENDENCE
// ═════════════════════════════════════════════════════════════════════════════════════════════

test(`P1 — materialize(foldAuthorized(σ(S))) is identical for every order, over ${SEEDS} seeds`, () => {
  forEachSeed(seeds(), 'P1 order-independence', (seed) => {
    const w = generate(seed);
    const rnd = pcg32(seed ^ 0xA1);
    const target = view(w.ops, w);
    for (let i = 0; i < 20; i++) {
      assert.equal(view(shuffle(rnd, w.ops), w), target, `shuffle ${i} produced a different board`);
    }
    // Full reversal is not a random shuffle and is worth its own shot: it is the order a log read
    // backwards produces, and it maximises the number of "newer op arrives first" pairs.
    assert.equal(view([...w.ops].reverse(), w), target, 'reversed delivery produced a different board');
  });
});

test('P1 holds under a DIFFERENT PRNG — the property is not an artefact of pcg32', () => {
  forEachSeed(seeds(120), 'P1 under xorshift32', (seed) => {
    const w = generate(seed, { rng: xorshift32 });
    const rnd = xorshift32(seed ^ 0xB2);
    const target = view(w.ops, w);
    for (let i = 0; i < 10; i++) assert.equal(view(shuffle(rnd, w.ops), w), target);
  });
});

test('P1 — array ORDER converges too, not merely array contents', () => {
  // `deepEqual` on two arrays holding the same entries in different orders passes. Order is
  // user-visible (ADR 001 §5 step 5: the capacity slice at layout.js:209 and the lane rescue at
  // :162-177 both consume it), so this compares the id sequence explicitly. `view()` is already a
  // byte comparison, but this states the intent so nobody "optimises" view() into a deepEqual.
  forEachSeed(seeds(100), 'P1 array order', (seed) => {
    const w = generate(seed);
    const rnd = pcg32(seed ^ 0xC3);
    const ids = (ops) => {
      const st = materialize(foldAuthorized(ops, w.authzCtx).regs, w.mctx);
      return [st.notes.map((n) => n.id).join(','), st.bars.map((b) => b.id).join(','),
        st.categories.map((c) => c.id).join(','), Object.keys(st.scratchpads).join(',')].join('|');
    };
    const target = ids(w.ops);
    for (let i = 0; i < 8; i++) assert.equal(ids(shuffle(rnd, w.ops)), target);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// P2 — IDEMPOTENCE
// ═════════════════════════════════════════════════════════════════════════════════════════════

test(`P2 — folding S ∪ (any multiset drawn from S) equals folding S, over ${SEEDS} seeds`, () => {
  forEachSeed(seeds(), 'P2 idempotence', (seed) => {
    const w = generate(seed);
    const rnd = pcg32(seed ^ 0xD4);
    const target = view(w.ops, w);
    for (const rate of [0.1, 0.35, 1.0]) {
      const dup = duplicateSome(rnd, w.ops, rate);
      assert.equal(view(dup, w), target, `re-delivering ${rate * 100}% of the log changed the state`);
    }
    // The strongest form: every op delivered exactly three times, shuffled.
    const tripled = shuffle(rnd, [...w.ops, ...w.ops, ...w.ops]);
    assert.equal(view(tripled, w), target, 'delivering the whole log three times changed the state');
  });
});

test('P2 — re-applying one op to a settled map reports no change and mutates nothing', () => {
  // The register-level statement of the same property, and the one that drives 17.5: `applyOp`
  // returns whether anything CHANGED, and a duplicate must return false or a re-pull would light
  // up every peer's „neu" dot with old news.
  forEachSeed(seeds(120), 'P2 applyOp idempotence', (seed) => {
    const w = generate(seed);
    const r = foldAuthorized(w.ops, w.authzCtx);
    const before = sig(serializeRegisters(r.regs));
    const copy = cloneRegisters(r.regs);
    for (const op of r.admitted) {
      const changed = applyOp(copy, op);
      assert.equal(changed, false, `re-applying ${op.id} reported a change`);
    }
    assert.equal(sig(serializeRegisters(copy)), before, 're-applying the whole log moved a register');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// P3 — PARTITION / HEAL
// ═════════════════════════════════════════════════════════════════════════════════════════════

test(`P3 — 2–8 replicas, random partitions, full gossip → every replica identical`, () => {
  forEachSeed(seeds(250), 'P3 partition/heal', (seed) => {
    const w = generate(seed);
    const rnd = pcg32(seed ^ 0xE5);
    const target = regsSig(w.ops, w);
    const n = 2 + (seed % 7);

    // Each replica sees a random subset first (its own partition), then gossips the rest in a
    // random order — the shape of a real heal, where nobody replays history in order.
    const parts = partition(rnd, w.ops, n);
    for (let i = 0; i < n; i++) {
      const local = parts[i];
      const rest = parts.filter((_, j) => j !== i).flat();
      const healed = local.concat(shuffle(rnd, rest));
      assert.equal(regsSig(healed, w), target, `replica ${i} of ${n} did not converge`);
    }

    // …and two replicas gossiping pairwise, riffled rather than concatenated.
    const [a, b] = [parts.slice(0, Math.ceil(n / 2)).flat(), parts.slice(Math.ceil(n / 2)).flat()];
    assert.equal(regsSig(interleave(rnd, a, b), w), target, 'a pairwise riffle diverged');
  });
});

test('P3 — merging partitions as REGISTER MAPS agrees with folding their union as ops', () => {
  // The two paths a real device actually takes: fold a tail, or merge a checkpoint someone else
  // folded. `mergeMaps` and `foldAll` must be the same semilattice or a checkpoint would mean
  // something different from the ops it was built from.
  forEachSeed(seeds(200), 'P3 mergeMaps vs foldAll', (seed) => {
    const w = generate(seed);
    const rnd = pcg32(seed ^ 0xF6);
    const admitted = foldAuthorized(w.ops, w.authzCtx).admitted;
    const target = sig(serializeRegisters(fold(admitted)));
    const parts = partition(rnd, admitted, 2 + (seed % 5));
    const merged = parts.map((p) => fold(p)).reduce((acc, m) => mergeMaps(acc, m));
    assert.equal(sig(serializeRegisters(merged)), target, 'mergeMaps and foldAll disagree');
    // …and mergeMaps is commutative, which is what makes "who checkpointed first" irrelevant.
    const flipped = parts.slice().reverse().map((p) => fold(p)).reduce((acc, m) => mergeMaps(acc, m));
    assert.equal(sig(serializeRegisters(flipped)), target, 'mergeMaps is not commutative');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// P4 — MONOTONICITY
// ═════════════════════════════════════════════════════════════════════════════════════════════

test(`P4 — an op with a stamp older than a register never changes it, over ${SEEDS} seeds`, () => {
  // The property that makes a late op safe (story 19.6, "three weeks offline"). Stated as a
  // HIGH-WATER MARK: after every single op, no register's stamp has gone down. Checking only the
  // end state would miss a fold that dips and recovers.
  forEachSeed(seeds(), 'P4 monotonicity', (seed) => {
    const w = generate(seed);
    const rnd = pcg32(seed ^ 0x17);
    const admitted = foldAuthorized(w.ops, w.authzCtx).admitted;
    const regs = fold([]);
    const high = new Map();
    for (const op of shuffle(rnd, admitted)) {
      applyOp(regs, op);
      for (const [e, fields] of regs) {
        for (const [f, reg] of fields) {
          const key = `${e} ${f}`;
          const prev = high.get(key);
          if (prev !== undefined) {
            assert.ok(cmpWrites(reg, prev) >= 0,
              `register ${key} went BACKWARDS: ${prev.stamp} → ${reg.stamp}`);
          }
          high.set(key, reg);
        }
      }
    }
  });
});

test('P4 — a genuinely older op re-delivered after the fold is a no-op, register for register', () => {
  forEachSeed(seeds(150), 'P4 late delivery', (seed) => {
    const w = generate(seed);
    const admitted = foldAuthorized(w.ops, w.authzCtx).admitted;
    if (admitted.length < 4) return;
    const settled = fold(admitted);
    const before = sig(serializeRegisters(settled));

    // Re-deliver every op that LOST its cell. None of them may move anything.
    let losers = 0;
    for (const op of admitted) {
      let isLoser = false;
      for (const f of Object.keys(op.f)) {
        const cur = getRegister(settled, op.e, f);
        if (cur && cur.stamp !== op.ts) { isLoser = true; break; }
      }
      if (!isLoser) continue;
      losers++;
      assert.equal(applyOp(settled, op), false, `a losing op ${op.id} reported a change`);
    }
    assert.equal(sig(serializeRegisters(settled)), before,
      `${losers} re-delivered losing ops moved the state`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// P10 — CHECKPOINT TRANSPARENCY
// ═════════════════════════════════════════════════════════════════════════════════════════════

test(`P10 — fold(S) === fold(checkpoint(S₁) ∪ S₂) for every partition, late ops included`, () => {
  // ADR 001 §7.2. If compaction could change the board, every relaunch would be a coin flip —
  // and the failure would look like "the app randomly loses an edit", which is unreportable.
  forEachSeed(seeds(250), 'P10 checkpoint transparency', (seed) => {
    const w = generate(seed);
    const rnd = pcg32(seed ^ 0x28);
    const admitted = foldAuthorized(w.ops, w.authzCtx).admitted;
    if (admitted.length < 6) return;
    const target = sig(serializeRegisters(fold(admitted)));

    for (let k = 0; k < 4; k++) {
      // Split at a RANDOM point in a RANDOM order, so the tail routinely contains ops OLDER than
      // the checkpoint horizon — the out-of-order late case §4.2 asks for by name.
      const order = shuffle(rnd, admitted);
      const cut = 1 + Math.floor(rnd() * (order.length - 1));
      const head = order.slice(0, cut);
      const tail = order.slice(cut);

      const log = createOpLog({ now: () => w.authzCtx.nowMs + 3600000 });
      for (const op of head) log.append(op);
      log.compact();
      const cp = JSON.parse(JSON.stringify(log.checkpoint()));

      const cold = createOpLog({ now: () => w.authzCtx.nowMs + 3600000 });
      cold.load({ checkpoint: cp, tail: [...log.ops({})] });
      for (const op of shuffle(rnd, tail)) cold.append(op);

      assert.equal(sig(serializeRegisters(cold.registers())), target,
        `checkpoint split ${k} at ${cut}/${order.length} changed the state`);
    }
  });
});

test('P10 — a checkpoint survives a real JSON round trip byte for byte', () => {
  // The checkpoint is written to disk and read back by a different process. Serialising and
  // deserialising must be an identity on the registers, or the state after a relaunch is not the
  // state before it — and `serializeRegisters` sorts at both levels precisely so this is a byte
  // comparison rather than a structural one.
  forEachSeed(seeds(150), 'P10 checkpoint round trip', (seed) => {
    const w = generate(seed);
    const regs = foldAuthorized(w.ops, w.authzCtx).regs;
    const once = serializeRegisters(regs);
    const back = deserializeRegisters(JSON.parse(JSON.stringify(once)));
    assert.equal(sig(serializeRegisters(back)), sig(once), 'a checkpoint did not round-trip');
    // …and the board built from the reloaded registers is the same board.
    assert.equal(sig(materialize(back, w.mctx)), sig(materialize(regs, w.mctx)));
  });
});
