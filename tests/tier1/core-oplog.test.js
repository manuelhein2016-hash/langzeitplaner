// tests/tier1/core-oplog.test.js — the in-memory op log.
// ADR 001 §6, §7.2, §7.3, §7.4, §10, §12.5 · ADR 004 §5.3 · ops.contract.js §8.
//
// WHAT THIS FILE IS PROTECTING, in the order it matters.
//
//  1. R15 — TOMBSTONE RESURRECTION. ADR 001 §13.3 calls condition 3 of §7.3 "the one
//     unsafe-if-violated rule". This file does not merely assert that the boolean comes out
//     false: it BUILDS the resurrection. Two logs are fed the same history; one collects the
//     tombstone while a device is still behind (the violation), one obeys the rule. A late op
//     from the long-offline Mac then arrives at both, and the entry comes back from the dead on
//     exactly one of them. If someone "optimizes" condition 3 away next year, the test that goes
//     red is a narrated data-corruption scenario, not an arithmetic detail.
//
//  2. R11 — NOTHING IS EVER DROPPED FOR BEING OLD. There is no staleness gate in this module and
//     there must never be one. An op stamped at millisecond zero is admitted at any `nowMs`;
//     unknown kinds, unknown fields, unknown versions, unknown spaces and 24-h-future stamps are
//     PARKED and re-evaluated, never discarded. That is what makes a joining member see Oma's
//     epoch-1 birthday (A4 / 17.1) and an old client degrade to "does not show the new thing"
//     rather than "loses the new thing" (§7.4).
//
//  3. IDEMPOTENCE AND ORDER-INDEPENDENCE, TESTED AS PROPERTIES. The whole of ADR 001 §6 reduces
//     to "state is a function of the SET of ops". So the log is checked under permutation,
//     duplication, interleaving and partition — including a partition healed in the opposite
//     order on the two sides — rather than along one happy path.
//
//  4. LOSSLESS COMPACTION (§7.2, property P10). `registers()` is byte-identical before and after
//     `compact()`, and an op OLDER than the horizon arriving AFTER compaction still merges by the
//     identical rule: it loses to a newer retained stamp and wins over an older one.
//
//  5. THE FORGET PASS (ADR 004 §5.3) IS STABLE UNDER RE-DELIVERY. Blanking a register value while
//     retaining its stamp is only a real removal if re-delivering the very op that wrote it does
//     not put it back.
//
// NO TEST READS THE WALL CLOCK (ADR 005 §5). Every stamp comes from an HLC bound to a `wall`
// object the test advances by hand; every opId comes from a counter; every seq is explicit.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createOpLog, tombstoneCollectable, horizonBeforeMs,
  APPEND, OpLogError, TombstoneGuardError, TOMBSTONE_MIN_AGE_MS, ZERO_STAMP,
} from '../../src/js/core/oplog.js';

// The REAL join the log folds through (ADR 005 §1.1). Never a local re-implementation: a test
// that folded through its own copy of the LWW rule would be green against itself.
import * as registers from '../../src/js/core/registers.js';

import { createClock, fmt, cmp, MAX_FUTURE_DRIFT_MS } from '../../src/js/core/stamp.js';
import { canonicalJSON } from '../../src/js/core/canon.js';
import { ZERO_DEVICE_SHORT } from '../../src/js/core/ids.js';
import { PARK_REASONS, noteSet, catSet, prefSet, pubSet, makeOp } from '../../src/js/core/ops.js';
import { noteKey, familyKey, PREF_KEY } from '../../src/js/core/entities.js';

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic fixtures. Seeded, injected, wall-clock-free.
// ─────────────────────────────────────────────────────────────────────────────

const T0 = 1787836800000;                       // a fixed instant; nothing derives it from a clock
const DAY = 24 * 60 * 60 * 1000;

const MEM_A = `mem_${'A'.repeat(22)}`;
const MEM_B = `mem_${'B'.repeat(22)}`;
const DEV_A = `dev_${'A'.repeat(22)}`;
const DEV_B = `dev_${'B'.repeat(22)}`;
const SHORT_A = 'A'.repeat(16);                 // Crockford base32, 16 chars
const SHORT_B = 'B'.repeat(16);
const SHORT_C = 'C'.repeat(16);
const PSP = `psp_${'P'.repeat(22)}`;
const FSP = `fsp_${'F'.repeat(22)}`;

const U1 = 'note-one';
const U2 = 'note-two';
const U3 = 'note-three';

/** 22 base64url characters, unique and ordered — never random, so a failure replays exactly. */
const oid = (tag, n) => tag.padEnd(4, 'z') + String(n).padStart(18, '0');
const gid = (tag, n) => `g${tag.padEnd(3, 'z')}${String(n).padStart(18, '0')}`;

/** A wall clock the test moves by hand. The ONLY source of time anywhere in this file. */
function makeWall(ms = T0) {
  return { ms, advance(by) { this.ms += by; return this.ms; }, set(to) { this.ms = to; return this.ms; } };
}

/**
 * One authoring device: an HLC bound to `wall`, plus a counter-backed OpCtx. `tag` is 1–4
 * characters and keeps every opId this device mints distinguishable in a failure message.
 */
function makeAuthor({ tag, short = SHORT_A, act = MEM_A, dev = DEV_A, wall }) {
  const clock = createClock(short, () => wall.ms);
  let n = 0;
  let g = 0;
  const ctx = {
    act, dev, gid: gid(tag, 0), space: PSP, familySpaceId: FSP,
    mint: () => clock.tick(),
    newOpId: () => oid(tag, n++),
  };
  return {
    ctx, clock, wall,
    /** start a new transaction group */
    txn() { ctx.gid = gid(tag, ++g); return ctx; },
    note(id, f, o) { return noteSet(ctx, id, f, o); },
    cat(id, f, o) { return catSet(ctx, id, f, o); },
    pref(f) { return prefSet(ctx, f); },
    pub(kind, owner, uuid, f, o) { return pubSet(ctx, kind, owner, uuid, f, o); },
  };
}

function log(wall, extra = {}) {
  return createOpLog({ now: () => wall.ms, ...extra });
}

/** A canonical, comparable snapshot of the materialized register state. */
const snap = (l) => JSON.stringify(registers.serializeRegisters(l.registers()));
const EMPTY = JSON.stringify(registers.serializeRegisters(registers.emptyRegisters()));

/** The value a register currently holds, or the sentinel `MISSING`. */
const MISSING = Symbol('missing');
function val(l, e, f) {
  const cells = l.registers().get(e);
  if (!cells || !cells.has(f)) return MISSING;
  return cells.get(f).value;
}
function stampOf(l, e, f) {
  const cells = l.registers().get(e);
  return cells && cells.has(f) ? cells.get(f).stamp : null;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(rnd, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** A mixed stream from three devices over three entities, with real HLC interleaving. */
function buildStream() {
  const wall = makeWall();
  const a = makeAuthor({ tag: 'a', short: SHORT_A, act: MEM_A, dev: DEV_A, wall });
  const b = makeAuthor({ tag: 'b', short: SHORT_B, act: MEM_B, dev: DEV_B, wall });
  const c = makeAuthor({ tag: 'c', short: SHORT_C, act: MEM_A, dev: DEV_A, wall });
  const ops = [];
  const push = (...xs) => { for (const x of xs) ops.push(x); };

  a.txn(); push(a.note(U1, { date: '2026-09-10', text: 'Zahnarzt', categoryId: 'cat-1', _alive: true }, { born: true }));
  wall.advance(5);
  b.txn(); push(b.note(U2, { date: '2026-09-11', text: 'Elternabend', _alive: true }, { born: true }));
  wall.advance(1);
  c.txn(); push(c.note(U1, { date: '2026-09-12' }));
  a.txn(); push(a.note(U1, { text: 'Zahnarzt 14:00' }));
  wall.advance(1000);
  b.txn(); push(b.note(U2, { text: 'Elternabend 19:00' }), b.note(U1, { categoryId: 'cat-2' }));
  a.txn(); push(a.note(U3, { date: '2026-10-01', text: 'Urlaub', _alive: true }, { born: true }));
  wall.advance(2);
  c.txn(); push(c.note(U3, { _alive: false }));
  a.txn(); push(a.cat('cat-1', { name: 'Familie', paletteRef: 'p0', visible: true, _alive: true }, { born: true }));
  wall.advance(7);
  b.txn(); push(b.note(U1, { repeatsYearly: true }));
  push(a.pref({ lastCategoryId: 'cat-1' }));
  return { ops, wall, a, b, c };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. The contract surface
// ═════════════════════════════════════════════════════════════════════════════

test('createOpLog returns every method ops.contract.js §8 declares', () => {
  const l = log(makeWall());
  for (const m of ['append', 'ops', 'checkpoint', 'compact', 'load', 'park', 'unpark', 'forget']) {
    assert.equal(typeof l[m], 'function', `OpLog.${m} is missing`);
  }
  assert.equal(typeof tombstoneCollectable, 'function');
});

test('createOpLog refuses to exist without an injected clock', () => {
  // core/ may not read the wall clock (ADR 005 §2), and a log with no clock would silently
  // disarm the 24 h future park — a safety rule must not evaporate through an omitted argument.
  assert.throws(() => createOpLog({}), OpLogError);
  assert.throws(() => createOpLog({ storage: {} }), /ports\.now is required/);
  assert.throws(() => createOpLog({ now: 12345 }), OpLogError);
});

test('the storage port is accepted and never called', () => {
  // Persistence is platform/oplogfile.js's job. If this module touched storage it would have to
  // be async, and an await between txn() and emit() breaks bar-label editing (ADR 001 §0.9).
  const calls = [];
  const storage = new Proxy({}, { get: (_t, k) => { calls.push(k); return () => {}; } });
  const wall = makeWall();
  const l = log(wall, { storage });
  const a = makeAuthor({ tag: 'a', wall });
  l.append(a.txn() && a.note(U1, { date: '2026-09-10' }));
  l.checkpoint();
  l.compact();
  assert.deepEqual(calls, [], `oplog reached into the storage port: ${calls.join(', ')}`);
  assert.equal(l.ports.storage, storage);
});

test('an injected registers port replaces the provisional reference join', () => {
  // registers.js does not exist yet (ADR 005 §1.1 assigns the LWW join to it). The seam has to be
  // real, or wiring it up later becomes a rewrite instead of one line.
  const wall = makeWall();
  const seen = [];
  const port = {
    ...registers,
    applyOp(regs, op) { seen.push(op.id); return registers.applyOp(regs, op); },
  };
  const l = log(wall, { registers: port });
  const a = makeAuthor({ tag: 'a', wall });
  const op = (a.txn(), a.note(U1, { date: '2026-09-10' }));
  l.append(op);
  l.registers();
  assert.ok(seen.includes(op.id), 'the injected applyOp was never called');
});

test('an incomplete registers port is refused at construction', () => {
  assert.throws(() => createOpLog({ now: () => T0, registers: { applyOp() {} } }), /missing/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Append and dedupe
// ═════════════════════════════════════════════════════════════════════════════

test('an appended op is folded into the registers', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const op = (a.txn(), a.note(U1, { date: '2026-09-10', text: 'Zahnarzt' }));
  assert.equal(l.append(op).status, APPEND.APPENDED);
  assert.equal(val(l, noteKey(U1), 'date'), '2026-09-10');
  assert.equal(val(l, noteKey(U1), 'text'), 'Zahnarzt');
  assert.equal(l.size, 1);
});

test('the same op twice is a no-op — idempotent append', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const op = (a.txn(), a.note(U1, { date: '2026-09-10' }));
  assert.equal(l.append(op).status, APPEND.APPENDED);
  const before = snap(l);
  assert.equal(l.append(op).status, APPEND.DUPLICATE);
  assert.equal(l.append(op).status, APPEND.DUPLICATE);
  assert.equal(l.size, 1, 'a duplicate added a second line');
  assert.equal(l.ops().length, 1);
  assert.equal(snap(l), before);
});

test('a structurally identical COPY of an op is also a duplicate', () => {
  // The wire hands us JSON.parse output, not the object we minted. Dedupe is by opId, and the
  // content check must not be identity-based.
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const op = (a.txn(), a.note(U1, { date: '2026-09-10' }));
  l.append(op);
  const wireCopy = JSON.parse(JSON.stringify(op));
  assert.notEqual(wireCopy, op);
  assert.equal(l.append(wireCopy).status, APPEND.DUPLICATE);
  assert.equal(l.size, 1);
});

test('duplicating an entire stream 4x folds to what one copy folds to', () => {
  // ADR 001 §6 corollary: duplicate delivery needs no dedupe FOR CORRECTNESS. Dedupe is a
  // performance optimisation, so the fold must be right even with it switched off by luck.
  const { ops, wall } = buildStream();
  const once = log(makeWall(wall.ms));
  for (const op of ops) once.append(op);
  const many = log(makeWall(wall.ms));
  const rnd = mulberry32(7);
  for (const op of [...ops, ...shuffle(rnd, ops), ...ops, ...shuffle(rnd, ops)]) many.append(op);
  assert.equal(snap(many), snap(once));
  assert.equal(many.size, once.size);
});

test('the same opId with DIFFERENT content is a conflict, resolved CONTENT-ADDRESSABLY', () => {
  // opId is the server's idempotency key. Two bodies under one id is corruption or forgery —
  // silently keeping either one and calling it a duplicate would hide it, so it is still
  // reported as a CONFLICT. What it may NOT be is resolved by arrival order: `authz.js` picks
  // the body whose canonical form sorts higher "so every device picks the same one", and a log
  // that picked the first arrival instead would leave two honest Macs that received the two
  // envelopes in opposite orders permanently disagreeing from an identical op set.
  const wall = makeWall();
  const a = makeAuthor({ tag: 'a', wall });
  const first = (a.txn(), a.note(U1, { text: 'Zahnarzt' }));
  const forged = { ...first, f: { text: 'Etwas anderes' } };
  const [lo, hi] = canonicalJSON(first) < canonicalJSON(forged) ? [first, forged] : [forged, first];

  for (const [order, arrival] of [['lo first', [lo, hi]], ['hi first', [hi, lo]]]) {
    const l = log(makeWall(wall.ms));
    assert.equal(l.append(arrival[0]).status, APPEND.APPENDED);
    const r = l.append(arrival[1]);
    assert.equal(r.status, APPEND.CONFLICT, order);
    assert.match(r.reason, /different content/);
    assert.equal(l.size, 1, order);
    assert.equal(val(l, noteKey(U1), 'text'), hi.f.text, `${order}: the canonical max must stand`);
    assert.deepEqual(l.get(hi.id).f, hi.f, order);
    assert.deepEqual(l.splicedIds(), [first.id], `${order}: the splice must be reported`);
  }
});

test('the splice winner is the same on two devices that saw the envelopes in opposite orders', () => {
  // A1, end to end: this is the assertion that the defect is closed.
  const wall = makeWall();
  const a = makeAuthor({ tag: 'a', wall });
  const bodyA = (a.txn(), a.note(U1, { date: '2026-09-10', text: 'Zahnarzt' }));
  const bodyB = { ...bodyA, f: { date: '2026-09-10', text: 'GEFAELSCHT' } };

  const one = log(makeWall(wall.ms));
  one.append(bodyA); one.append(bodyB);
  const two = log(makeWall(wall.ms));
  two.append(bodyB); two.append(bodyA);
  assert.equal(snap(one), snap(two), 'two devices, one op set, two different boards');

  // …and re-delivery cannot change either the winner or the report (it is a function of the SET).
  for (const op of [bodyA, bodyB, bodyA, bodyA, bodyB]) one.append(op);
  assert.equal(snap(one), snap(two));
  assert.deepEqual(one.splicedIds(), two.splicedIds());
  assert.deepEqual(one.splicedIds(), [bodyA.id]);
});

test('a spliced op that PARKS is resolved by the same content-addressable rule', () => {
  // A6 in this module: parking must not become a back door for arrival-order resolution. A
  // parked op is retained precisely so it can be applied after an app update, so keeping
  // "whichever arrived first" would only defer the divergence to the update.
  const wall = makeWall();
  const a = makeAuthor({ tag: 'a', wall });
  const base = (a.txn(), a.note(U1, { date: '2026-09-10', text: 'A' }));
  const bodyA = { ...base, k: 'reminder.set' };                    // unknown kind ⇒ parks
  const bodyB = { ...base, k: 'reminder.set', f: { date: '2026-09-10', text: 'B' } };
  const hi = canonicalJSON(bodyA) > canonicalJSON(bodyB) ? bodyA : bodyB;

  for (const arrival of [[bodyA, bodyB], [bodyB, bodyA]]) {
    const l = log(makeWall(wall.ms));
    assert.equal(l.append(arrival[0]).status, APPEND.PARKED);
    const r = l.append(arrival[1]);
    assert.equal(r.status, APPEND.CONFLICT);
    assert.equal(l.parkedSize, 1);
    assert.equal(l.parkReasonOf(base.id), PARK_REASONS.UNKNOWN_KIND, 'the park reason must survive a splice');
    assert.deepEqual(l.get(base.id).f, hi.f, 'the retained parked body must be the canonical max');
  }
});

test('a splice that arrives while the loser is LIVE is un-applied, not merged on top', () => {
  // Replacing the body must re-fold, or the loser's writes would linger in the registers under
  // the winner's id — a checkpoint that no set of ops can reproduce.
  const wall = makeWall();
  const a = makeAuthor({ tag: 'a', wall });
  const lo = (a.txn(), a.note(U1, { date: '2026-09-10', text: 'A' }));
  const hi = { ...lo, f: { text: 'zzz' } };                        // canonically greater, and no `date`
  assert.ok(canonicalJSON(hi) > canonicalJSON(lo));
  const l = log(makeWall(wall.ms));
  l.append(lo);
  assert.equal(l.append(hi).status, APPEND.CONFLICT);
  assert.equal(val(l, noteKey(U1), 'text'), 'zzz');
  assert.equal(val(l, noteKey(U1), 'date'), MISSING, "the losing body's writes survived the splice");

  const clean = log(makeWall(wall.ms));
  clean.append(hi);
  assert.equal(snap(l), snap(clean), 'the spliced log does not equal the log that only ever saw the winner');
});

test('a malformed second body neither wins nor disturbs the one we hold', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const good = (a.txn(), a.note(U1, { date: '2026-09-10' }));
  l.append(good);
  const r = l.append({ ...good, f: { date: 42 } });                // a declared type broken
  assert.equal(r.status, APPEND.REJECTED, 'a protocol violation may not enter the splice contest');
  assert.equal(val(l, noteKey(U1), 'date'), '2026-09-10');
  assert.deepEqual(l.splicedIds(), []);
});

test('a protocol violation is REJECTED and not stored', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const good = (a.txn(), a.note(U1, { date: '2026-09-10' }));
  const bad = { ...good, id: oid('x', 1), f: { date: 42 } };      // declared type broken
  const r = l.append(bad);
  assert.equal(r.status, APPEND.REJECTED);
  assert.equal(l.size, 0);
  assert.equal(l.parkedSize, 0, 'a type violation must not be parked — it is not a version skew');
  assert.equal(l.has(bad.id), false);
});

test('append survives being handed junk', () => {
  const l = log(makeWall());
  for (const junk of [null, undefined, 42, 'op', [], { v: 1 }]) {
    assert.equal(l.append(junk).status, APPEND.REJECTED, `${JSON.stringify(junk)} was not rejected`);
  }
  assert.equal(l.size, 0);
});

test('a stored op is frozen — the log is append-only', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const wire = JSON.parse(JSON.stringify((a.txn(), a.note(U1, { text: 'Zahnarzt' }))));
  l.append(wire);
  const stored = l.get(wire.id);
  assert.ok(Object.isFrozen(stored));
  assert.ok(Object.isFrozen(stored.f));
  assert.throws(() => { stored.f.text = 'anders'; }, TypeError);
});

test('ops() hands back a fresh array that cannot reach into the log', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  l.append((a.txn(), a.note(U1, { date: '2026-09-10' })));
  const got = l.ops();
  got.length = 0;
  got.push('nonsense');
  assert.equal(l.ops().length, 1);
  assert.notEqual(l.ops()[0], 'nonsense');
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Convergence: reorder, interleave, partition
// ═════════════════════════════════════════════════════════════════════════════

test('40 random permutations of one stream all fold to the same registers', () => {
  const { ops, wall } = buildStream();
  const reference = log(makeWall(wall.ms));
  for (const op of ops) reference.append(op);
  const want = snap(reference);
  for (let seed = 1; seed <= 40; seed++) {
    const l = log(makeWall(wall.ms));
    for (const op of shuffle(mulberry32(seed), ops)) l.append(op);
    assert.equal(snap(l), want, `permutation seed ${seed} diverged`);
  }
});

test('a partition healed in opposite orders converges on both sides', () => {
  // The realistic failure: two Macs offline from each other, each folds its own half first and
  // the peer's half later, in a different order. This is the shape of story 19.6.
  const { ops, wall } = buildStream();
  const half = Math.floor(ops.length / 2);
  const left = ops.slice(0, half);
  const right = ops.slice(half);

  const macA = log(makeWall(wall.ms));
  for (const op of left) macA.append(op);
  const macB = log(makeWall(wall.ms));
  for (const op of shuffle(mulberry32(11), right)) macB.append(op);
  assert.notEqual(snap(macA), snap(macB), 'the partition was not actually a partition');

  for (const op of shuffle(mulberry32(12), right)) macA.append(op);
  for (const op of shuffle(mulberry32(13), left)) macB.append(op);
  assert.equal(snap(macA), snap(macB));
});

test('three-way interleave with duplicates and re-delivery converges', () => {
  const { ops, wall } = buildStream();
  const rnd = mulberry32(99);
  const noisy = shuffle(rnd, [...ops, ...ops.slice(3, 8), ...ops.slice(0, 2)]);
  const logs = [log(makeWall(wall.ms)), log(makeWall(wall.ms)), log(makeWall(wall.ms))];
  for (const op of ops) logs[0].append(op);
  for (const op of noisy) logs[1].append(op);
  for (const op of shuffle(mulberry32(4), noisy)) logs[2].append(op);
  assert.equal(snap(logs[1]), snap(logs[0]));
  assert.equal(snap(logs[2]), snap(logs[0]));
});

test('per-field LWW: the greater stamp wins, whatever the arrival order', () => {
  const wall = makeWall();
  const a = makeAuthor({ tag: 'a', short: SHORT_A, wall });
  const older = (a.txn(), a.note(U1, { text: 'alt' }));
  wall.advance(1000);
  const newer = (a.txn(), a.note(U1, { text: 'neu' }));
  assert.equal(cmp(newer.ts, older.ts), 1);

  const forward = log(makeWall());
  forward.append(older); forward.append(newer);
  const backward = log(makeWall());
  backward.append(newer); backward.append(older);
  assert.equal(val(forward, noteKey(U1), 'text'), 'neu');
  assert.equal(val(backward, noteKey(U1), 'text'), 'neu', 'a late older op undid an applied newer one');
});

test('monotone reads: a three-weeks-late op is absorbed, never rolled back', () => {
  // ADR 001 §6, "Monotone reads" — the reason story 19.6 needs no special handling.
  const wall = makeWall();
  const a = makeAuthor({ tag: 'a', short: SHORT_A, wall });
  const b = makeAuthor({ tag: 'b', short: SHORT_B, act: MEM_B, dev: DEV_B, wall });
  const stale = (b.txn(), b.note(U1, { date: '2026-09-01' }));
  wall.advance(21 * DAY);
  const current = (a.txn(), a.note(U1, { date: '2026-10-05' }));
  const l = log(makeWall(wall.ms));
  l.append(current);
  const before = snap(l);
  assert.equal(l.append(stale).status, APPEND.APPENDED, 'a three-week-old op must still be ADMITTED');
  assert.equal(val(l, noteKey(U1), 'date'), '2026-10-05');
  assert.equal(snap(l), before, 'absorbing an older op changed the state');
});

test('concurrent edits to DIFFERENT fields both survive (story 18.5)', () => {
  const wall = makeWall();
  const a = makeAuthor({ tag: 'a', short: SHORT_A, wall });
  const b = makeAuthor({ tag: 'b', short: SHORT_B, act: MEM_B, dev: DEV_B, wall });
  const moved = (a.txn(), a.note(U1, { date: '2026-09-20' }));
  const retitled = (b.txn(), b.note(U1, { text: 'Zahnarzt verschoben' }));
  for (const order of [[moved, retitled], [retitled, moved]]) {
    const l = log(makeWall());
    for (const op of order) l.append(op);
    assert.equal(val(l, noteKey(U1), 'date'), '2026-09-20');
    assert.equal(val(l, noteKey(U1), 'text'), 'Zahnarzt verschoben');
  }
});

test('delete/edit race converges to dead-with-the-newest-content (ADR 001 §6)', () => {
  const wall = makeWall();
  const a = makeAuthor({ tag: 'a', short: SHORT_A, wall });
  const b = makeAuthor({ tag: 'b', short: SHORT_B, act: MEM_B, dev: DEV_B, wall });
  const del = (a.txn(), a.note(U1, { _alive: false }));
  wall.advance(50);
  const edit = (b.txn(), b.note(U1, { text: 'doch nicht' }));
  for (const order of [[del, edit], [edit, del]]) {
    const l = log(makeWall(wall.ms));
    for (const op of order) l.append(op);
    assert.equal(val(l, noteKey(U1), '_alive'), false);
    assert.equal(val(l, noteKey(U1), 'text'), 'doch nicht', 'content registers must not be cleared by a delete');
  }
  // and a resurrect needs an EXPLICIT _alive:true at a greater stamp — story 18.6
  wall.advance(50);
  const undo = (a.txn(), a.note(U1, { _alive: true }));
  const l = log(makeWall(wall.ms));
  for (const op of [del, edit, undo]) l.append(op);
  assert.equal(val(l, noteKey(U1), '_alive'), true);
});

test('the fan-out of legend.js:197 converges under partial delivery', () => {
  // N note reassignments + a category tombstone in ONE gid. The group has no cross-device
  // atomicity requirement; a half-delivered fan-out must be a consistent half-reassigned board.
  const wall = makeWall();
  const a = makeAuthor({ tag: 'a', wall });
  a.txn();
  const fan = [
    a.note(U1, { categoryId: 'cat-2' }),
    a.note(U2, { categoryId: 'cat-2' }),
    a.note(U3, { categoryId: 'cat-2' }),
    a.cat('cat-1', { _alive: false }),
  ];
  assert.equal(new Set(fan.map((o) => o.gid)).size, 1, 'the fan-out must carry one gid');
  const partial = log(makeWall());
  for (const op of fan.slice(0, 2)) partial.append(op);
  assert.equal(val(partial, noteKey(U3), 'categoryId'), MISSING);
  const full = log(makeWall());
  for (const op of shuffle(mulberry32(3), fan)) full.append(op);
  for (const op of fan.slice(2)) partial.append(op);
  assert.equal(snap(partial), snap(full));
});

test('iteration order does not change the fold', () => {
  const { ops, wall } = buildStream();
  const l = log(makeWall(wall.ms));
  for (const op of ops) l.append(op);
  const arrival = l.ops().map((o) => o.id);
  assert.deepEqual(arrival, ops.map((o) => o.id), 'ops() is documented as arrival order');
  const reversed = log(makeWall(wall.ms));
  for (const op of [...l.ops()].reverse()) reversed.append(op);
  assert.equal(snap(reversed), snap(l));
});

test('two DISTINCT writes sharing a stamp still resolve identically on every device', () => {
  // Unreachable per ADR 001 §6's total-order argument — reachable only from a forged or corrupt
  // stamp. The join must stay a semilattice anyway, or one hostile peer splits the family.
  const wall = makeWall();
  const a = makeAuthor({ tag: 'a', short: SHORT_A, wall });
  const one = (a.txn(), a.note(U1, { text: 'eins' }));
  const two = { ...(a.txn(), a.note(U1, { text: 'zwei' })), ts: one.ts };
  const forward = log(makeWall()); forward.append(one); forward.append(two);
  const backward = log(makeWall()); backward.append(two); backward.append(one);
  assert.equal(val(forward, noteKey(U1), 'text'), val(backward, noteKey(U1), 'text'));
  assert.notEqual(val(forward, noteKey(U1), 'text'), MISSING);
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Parking, not dropping (ADR 001 §7.4, §10, §12.5)
// ═════════════════════════════════════════════════════════════════════════════

/** A well-formed op, mutated into something a build one version behind would not understand. */
function skewed(base, patch) { return { ...base, id: oid('sk', skewed.n = (skewed.n ?? 0) + 1), ...patch }; }

test('an unknown op KIND is parked, retained and not applied', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const base = (a.txn(), a.note(U1, { date: '2026-09-10' }));
  const fromTheFuture = skewed(base, { k: 'reminder.set', e: 'note:x', f: { at: '2027-01-01' } });
  const r = l.append(fromTheFuture);
  assert.equal(r.status, APPEND.PARKED);
  assert.equal(r.parkReason, PARK_REASONS.UNKNOWN_KIND);
  assert.equal(l.size, 0);
  assert.equal(l.parkedSize, 1);
  assert.equal(l.has(fromTheFuture.id), true, 'a parked op must be RETAINED');
  assert.deepEqual(l.ops({ liveOnly: true }), [], 'a parked op is not an APPLIED op');
  assert.deepEqual(l.ops({ includeParked: false }), [], 'the older spelling of liveOnly still works');
  assert.equal(l.ops({ includeParked: true }).length, 1);
  assert.equal(l.ops().length, 1, 'ops() defaults to every LINE — a parked line is a line on disk');
});

test('an unknown FIELD parks the WHOLE op — never half of it', () => {
  // Applying the half we understand is precisely how "does not show the new thing" becomes
  // "loses the new thing" (ADR 001 §7.4).
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const base = (a.txn(), a.note(U1, { date: '2026-09-10' }));
  const r = l.append(skewed(base, { f: { date: '2026-09-10', reminderAt: '08:00' } }));
  assert.equal(r.status, APPEND.PARKED);
  assert.equal(r.parkReason, PARK_REASONS.UNKNOWN_FIELD);
  assert.deepEqual(r.fields, ['reminderAt']);
  assert.equal(val(l, noteKey(U1), 'date'), MISSING, 'the understood half of a parked op was applied');
});

test('an unknown op VERSION and an unknown SPACE are parked', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const base = (a.txn(), a.note(U1, { date: '2026-09-10' }));
  assert.equal(l.append(skewed(base, { v: 2 })).parkReason, PARK_REASONS.VERSION);
  assert.equal(l.append(skewed(base, { space: 'xsp_somethingnewentirely' })).parkReason, PARK_REASONS.UNKNOWN_SPACE);
  assert.equal(l.parkedSize, 2);
  assert.equal(l.size, 0);
});

test('a stamp more than 24 h in the future is parked, and the boundary is exact', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', short: SHORT_A, wall });

  const atLimit = { ...(a.txn(), a.note(U1, { date: '2026-09-10' })), ts: fmt(wall.ms + MAX_FUTURE_DRIFT_MS, 0, SHORT_A) };
  assert.equal(l.append(atLimit).status, APPEND.APPENDED, 'exactly +24 h must be admitted');

  const overLimit = { ...(a.txn(), a.note(U2, { date: '2026-09-10' })), ts: fmt(wall.ms + MAX_FUTURE_DRIFT_MS + 1, 0, SHORT_A) };
  const r = l.append(overLimit);
  assert.equal(r.status, APPEND.PARKED);
  assert.equal(r.parkReason, PARK_REASONS.FUTURE);
  assert.equal(l.parkedSize, 1);
});

test('R11 — an op stamped at millisecond ZERO is admitted at any nowMs', () => {
  // There is NO lower bound and no staleness gate. This is the rule that makes a joining member
  // see the birthday Oma entered in epoch 1 (A4 / 17.1) instead of an empty board.
  const wall = makeWall(T0 + 400 * DAY);
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', short: SHORT_A, wall });
  const ancient = { ...(a.txn(), a.note(U1, { date: '1998-03-14', text: 'Oma Geburtstag', _alive: true })), ts: fmt(0, 1, SHORT_A) };
  assert.equal(l.append(ancient).status, APPEND.APPENDED);
  assert.equal(val(l, noteKey(U1), 'text'), 'Oma Geburtstag');
  assert.equal(l.parkedSize, 0);
});

test('an epoch we do not hold parks the op; the caller unparks it after the key fetch', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const op = (a.txn(), a.note(U1, { date: '2026-09-10' }));
  const r = l.append(op, { haveEpochKey: false });
  assert.equal(r.parkReason, PARK_REASONS.EPOCH);
  assert.equal(l.size, 0);
  const promoted = l.unpark((o) => o.id === op.id);
  assert.deepEqual(promoted.map((o) => o.id), [op.id]);
  assert.equal(val(l, noteKey(U1), 'date'), '2026-09-10');
  assert.equal(l.parkedSize, 0);
});

test('unpark RE-EVALUATES: a still-future op stays parked no matter what the predicate says', () => {
  // `pred` selects candidates; the classifier decides. Otherwise a caller could unpark a broken
  // peer's clock into every register — the exact poisoning §1.3's clamp exists to prevent.
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', short: SHORT_A, wall });
  const far = { ...(a.txn(), a.note(U1, { date: '2026-09-10' })), ts: fmt(wall.ms + 3 * DAY, 0, SHORT_A) };
  l.append(far);
  assert.equal(l.parkedSize, 1);
  assert.deepEqual(l.unpark(() => true), [], 'a future op was unparked before its time');
  assert.equal(l.parkedSize, 1);
  assert.equal(l.parkReasonOf(far.id), PARK_REASONS.FUTURE);

  wall.advance(3 * DAY);                              // local wall time advances past it
  const promoted = l.unpark();
  assert.deepEqual(promoted.map((o) => o.id), [far.id]);
  assert.equal(val(l, noteKey(U1), 'date'), '2026-09-10');
});

test('unpark never drops an op it still cannot classify', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const alien = skewed((a.txn(), a.note(U1, { date: '2026-09-10' })), { k: 'reminder.set' });
  l.append(alien);
  assert.deepEqual(l.unpark(), []);
  assert.equal(l.parkedSize, 1, 'an op this build still does not understand was DELETED');
  assert.equal(l.get(alien.id).id, alien.id);
});

test('an unparked op competes for LWW like any other write', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', short: SHORT_A, wall });
  const b = makeAuthor({ tag: 'b', short: SHORT_B, act: MEM_B, dev: DEV_B, wall });
  const parkedOp = (a.txn(), a.note(U1, { text: 'aus der Zukunft' }));
  l.append(parkedOp, { haveEpochKey: false });
  wall.advance(5000);
  l.append((b.txn(), b.note(U1, { text: 'gerade eben' })));
  assert.equal(val(l, noteKey(U1), 'text'), 'gerade eben');
  l.unpark();
  assert.equal(val(l, noteKey(U1), 'text'), 'gerade eben', 'an unparked OLDER op won a register it should have lost');
});

test('park() moves a live op back to the parked set', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const op = (a.txn(), a.note(U1, { date: '2026-09-10' }));
  l.append(op);
  assert.equal(val(l, noteKey(U1), 'date'), '2026-09-10');
  l.park(op, PARK_REASONS.EPOCH);
  assert.equal(l.size, 0);
  assert.equal(l.parkedSize, 1);
  assert.equal(val(l, noteKey(U1), 'date'), MISSING, 'parking an op left its writes in the registers');
});

test('park() REFUSES an op that has already been folded into the checkpoint', () => {
  // Parking means NOT APPLIED. After compaction the op's line is gone and its writes are merged
  // into the checkpoint inseparably, so "park" could only be cosmetic — `isParked()` true while
  // the register it wrote sits there unchanged. Rebuilding the checkpoint from the surviving
  // lines is not an option (compaction dropped them; that is §7.2's whole point), so between
  // lying and losing data this throws and the caller finds out.
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const op = (a.txn(), a.note(U1, { date: '2026-09-10', text: 'A' }));
  l.append(op);
  l.compact();
  assert.equal(l.size, 0);

  assert.throws(() => l.park(op, PARK_REASONS.EPOCH), OpLogError);
  assert.throws(() => l.park(op, PARK_REASONS.EPOCH), /folded into the checkpoint/);
  assert.equal(l.isParked(op.id), false, 'the refused park left the op in the parked set anyway');
  assert.equal(val(l, noteKey(U1), 'text'), 'A', 'the refusal must not half-apply anything either');

  // The point of the refusal: silently accepting it would put this log out of step with a peer
  // that parked the same op BEFORE compacting, from an identical op set.
  const other = log(makeWall(wall.ms));
  other.park(op, PARK_REASONS.EPOCH);
  assert.equal(other.registers().has(noteKey(U1)), false);
  assert.notEqual(snap(l), snap(other), 'the two logs must be visibly different — that is why this throws');

  // A LATE op below the horizon is still a live line, and parking it is exact, so it is allowed.
  const b = makeAuthor({ tag: 'b', short: SHORT_B, act: MEM_B, dev: DEV_B, wall: makeWall(wall.ms - 5000) });
  const late = (b.txn(), b.note(U2, { date: '2026-08-01' }));
  assert.equal(cmp(late.ts, l.horizon()), -1, 'the late op must be below the horizon for this half to mean anything');
  assert.equal(l.append(late).status, APPEND.APPENDED);
  l.park(late, PARK_REASONS.EPOCH);
  assert.equal(l.isParked(late.id), true);
  assert.equal(val(l, noteKey(U2), 'date'), MISSING, 'parking a live pre-horizon line must un-apply it exactly');

  // An op we have never seen is not in the checkpoint either, so it may be parked freely.
  const unseen = (b.txn(), b.note(U3, { date: '2026-08-02' }));
  l.park(unseen, PARK_REASONS.EPOCH);
  assert.equal(l.isParked(unseen.id), true);
});

test('park() refuses a reason that is not a park reason', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const op = (a.txn(), a.note(U1, { date: '2026-09-10' }));
  assert.throws(() => l.park(op, 'stale'), OpLogError);
  assert.throws(() => l.park(op, 'old'), /is not a park reason/);
  assert.throws(() => l.park({}, PARK_REASONS.EPOCH), OpLogError);
  assert.equal(l.parkedSize, 0);
});

test('re-appending a parked op is a duplicate, not a second park', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const alien = skewed((a.txn(), a.note(U1, { date: '2026-09-10' })), { k: 'reminder.set' });
  l.append(alien);
  assert.equal(l.append(alien).status, APPEND.DUPLICATE);
  assert.equal(l.parkedSize, 1);
});

test('parkedOps() reports the reason and the offending field names', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const base = (a.txn(), a.note(U1, { date: '2026-09-10' }));
  l.append(skewed(base, { f: { date: '2026-09-10', reminderAt: '08:00', snooze: 5 } }));
  const [entry] = l.parkedOps({ reason: PARK_REASONS.UNKNOWN_FIELD });
  assert.deepEqual(entry.fields, ['reminderAt', 'snooze']);
  assert.equal(entry.reason, PARK_REASONS.UNKNOWN_FIELD);
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Query
// ═════════════════════════════════════════════════════════════════════════════

test('ops() filters by space, entity, kind and sinceStamp', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  a.txn();
  const n1 = a.note(U1, { date: '2026-09-10' });
  wall.advance(10);
  const n2 = a.note(U2, { date: '2026-09-11' });
  const p1 = a.pref({ lastCategoryId: 'cat-1' });
  const f1 = a.pub('fnote', MEM_A, U1, { 'pub.level': 'belegt', 'pub.date': '2026-09-10' });
  for (const op of [n1, n2, p1, f1]) l.append(op);

  assert.deepEqual(l.ops({ space: 'local' }).map((o) => o.id), [p1.id]);
  assert.deepEqual(l.ops({ space: FSP }).map((o) => o.id), [f1.id]);
  assert.deepEqual(l.ops({ space: PSP }).map((o) => o.id), [n1.id, n2.id]);
  assert.deepEqual(l.ops({ entity: noteKey(U2) }).map((o) => o.id), [n2.id]);
  assert.deepEqual(l.ops({ kind: 'pref.set' }).map((o) => o.id), [p1.id]);
  assert.deepEqual(l.ops({ sinceStamp: n1.ts }).map((o) => o.id), [n2.id, p1.id, f1.id]);
  assert.equal(l.ops({ sinceStamp: ZERO_STAMP }).length, 4);
});

test('sinceStamp is strictly greater — a cursor never re-yields its own boundary', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const op = (a.txn(), a.note(U1, { date: '2026-09-10' }));
  l.append(op);
  assert.deepEqual(l.ops({ sinceStamp: op.ts }), []);
  assert.equal(l.ops({ sinceStamp: fmt(0, 0, ZERO_DEVICE_SHORT) }).length, 1);
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Checkpoint and compaction (ADR 001 §7.2 · property P10)
// ═════════════════════════════════════════════════════════════════════════════

test('checkpoint() reports horizon, registers, cursors and the injected time', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const op = (a.txn(), a.note(U1, { date: '2026-09-10' }));
  l.append(op, { seq: '17' });
  l.setCursor(PSP, '17');
  wall.advance(500);
  const cp = l.checkpoint();
  assert.equal(cp.horizon, op.ts);
  assert.equal(cp.at, wall.ms, 'checkpoint().at must come from the injected clock');
  assert.deepEqual(cp.cursors, { [PSP]: '17' });
  const cell = cp.regs.regs[noteKey(U1)].date;
  assert.equal(cell.value, '2026-09-10');
  assert.equal(cell.stamp, op.ts);
  assert.equal(cell.author, MEM_A);
  assert.equal(cell.op, op.id, 'the checkpoint must retain the opId tiebreak (registers.js §0)');
});

test('checkpoint() is pure — it does not compact', () => {
  const { ops, wall } = buildStream();
  const l = log(makeWall(wall.ms));
  for (const op of ops) l.append(op);
  const n = l.size;
  l.checkpoint(); l.checkpoint();
  assert.equal(l.size, n);
  assert.equal(l.horizon(), null);
});

test('compaction is LOSSLESS with respect to materialized state', () => {
  const { ops, wall } = buildStream();
  const l = log(makeWall(wall.ms));
  for (const op of ops) l.append(op);
  const before = snap(l);
  const dropped = l.compact();
  assert.equal(dropped, ops.length);
  assert.equal(l.size, 0, 'every line was inside the horizon and should have been dropped');
  assert.equal(snap(l), before, 'compaction changed the materialized register state');
});

test('compaction with a partial horizon keeps the tail', () => {
  const { ops, wall } = buildStream();
  const l = log(makeWall(wall.ms));
  for (const op of ops) l.append(op);
  const before = snap(l);
  const cut = ops[4].ts;
  const dropped = l.compact({ horizon: cut });
  const expected = ops.filter((o) => cmp(o.ts, cut) <= 0).length;
  assert.equal(dropped, expected);
  assert.equal(l.size, ops.length - expected);
  assert.equal(snap(l), before);
  for (const op of l.ops()) assert.equal(cmp(op.ts, cut), 1, 'a line at or below the horizon survived');
});

test('P10 — a late op OLDER than the horizon merges by the identical rule', () => {
  // The whole point of retaining per-field stamps in the checkpoint. Nothing about compaction may
  // need peer acknowledgement (ADR 001 §7.2).
  const wall = makeWall();
  const a = makeAuthor({ tag: 'a', short: SHORT_A, wall });
  const b = makeAuthor({ tag: 'b', short: SHORT_B, act: MEM_B, dev: DEV_B, wall });

  const lateLoser = (b.txn(), b.note(U1, { text: 'alt', date: '2026-09-01' }));
  wall.advance(10);
  const kept = (a.txn(), a.note(U1, { text: 'neu' }));
  wall.advance(10);
  const laterStill = (a.txn(), a.note(U2, { date: '2026-09-30' }));

  const compacted = log(makeWall(wall.ms));
  compacted.append(kept);
  compacted.append(laterStill);
  compacted.compact();
  assert.equal(compacted.size, 0);
  assert.equal(compacted.append(lateLoser).status, APPEND.APPENDED, 'a pre-horizon op must still be admitted');
  assert.equal(val(compacted, noteKey(U1), 'text'), 'neu', 'a pre-horizon op beat a newer retained stamp');
  assert.equal(val(compacted, noteKey(U1), 'date'), '2026-09-01', 'a field the checkpoint never held was lost');

  const never = log(makeWall(wall.ms));
  for (const op of [kept, laterStill, lateLoser]) never.append(op);
  assert.equal(snap(compacted), snap(never), 'compacted and never-compacted logs diverged');
});

test('P10 — a late op NEWER than a checkpointed stamp still wins', () => {
  const wall = makeWall();
  const a = makeAuthor({ tag: 'a', short: SHORT_A, wall });
  const b = makeAuthor({ tag: 'b', short: SHORT_B, act: MEM_B, dev: DEV_B, wall });
  const early = (a.txn(), a.note(U1, { text: 'alt' }));
  wall.advance(10);
  const late = (b.txn(), b.note(U1, { text: 'neu von Mama' }));

  const l = log(makeWall(wall.ms));
  l.append(early);
  l.compact({ horizon: early.ts });
  assert.equal(l.size, 0);
  l.append(late);
  assert.equal(val(l, noteKey(U1), 'text'), 'neu von Mama');
});

test('compaction never drops a parked line', () => {
  // A parked op from a newer sibling can easily be OLDER than the horizon. Dropping it here would
  // be exactly the "loses the new thing" failure §7.4 exists to prevent.
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const alien = skewed((a.txn(), a.note(U1, { date: '2026-09-10' })), { k: 'reminder.set' });
  l.append(alien);
  wall.advance(5000);
  l.append((a.txn(), a.note(U2, { date: '2026-09-11' })));
  const dropped = l.compact();
  assert.equal(dropped, 1, 'only the one live line was inside the horizon');
  assert.equal(l.parkedSize, 1);
  assert.equal(l.get(alien.id).id, alien.id, 'a parked op was compacted away');
});

test('compaction is idempotent and the horizon may not recede', () => {
  const { ops, wall } = buildStream();
  const l = log(makeWall(wall.ms));
  for (const op of ops) l.append(op);
  const cut = ops[5].ts;
  l.compact({ horizon: cut });
  const after = snap(l);
  assert.equal(l.compact({ horizon: cut }), 0);
  assert.equal(snap(l), after);
  assert.throws(() => l.compact({ horizon: ops[1].ts }), /may not recede/);
  assert.throws(() => l.checkpoint({ horizon: 'not-a-stamp' }), OpLogError);
});

test('compacting an empty log is a no-op', () => {
  const l = log(makeWall());
  assert.equal(l.compact(), 0);
  assert.equal(l.horizon(), ZERO_STAMP);
  assert.equal(snap(l), EMPTY);
});

test('horizonBeforeMs expresses the "keep a 30-day tail" policy without reading a clock', () => {
  const wall = makeWall();
  const a = makeAuthor({ tag: 'a', short: SHORT_A, wall });
  const old = (a.txn(), a.note(U1, { date: '2026-09-10' }));
  wall.advance(40 * DAY);
  const recent = (a.txn(), a.note(U2, { date: '2026-10-20' }));
  const l = log(makeWall(wall.ms));
  l.append(old); l.append(recent);
  const dropped = l.compact({ horizon: horizonBeforeMs(wall.ms - 30 * DAY) });
  assert.equal(dropped, 1);
  assert.deepEqual(l.ops().map((o) => o.id), [recent.id]);
  assert.equal(val(l, noteKey(U1), 'date'), '2026-09-10', 'the compacted op left no register behind');
  assert.throws(() => horizonBeforeMs(-1), OpLogError);
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Serialize / load
// ═════════════════════════════════════════════════════════════════════════════

test('load(checkpoint + tail) equals the fold of every op', () => {
  const { ops, wall } = buildStream();
  const source = log(makeWall(wall.ms));
  for (const op of ops) source.append(op);
  const cut = ops[6].ts;
  source.compact({ horizon: cut });
  const cp = JSON.parse(JSON.stringify(source.checkpoint()));
  const tail = JSON.parse(JSON.stringify(source.ops()));

  const restored = log(makeWall(wall.ms));
  restored.load({ checkpoint: cp, tail });
  const fresh = log(makeWall(wall.ms));
  for (const op of ops) fresh.append(op);
  assert.equal(snap(restored), snap(fresh));
  assert.equal(restored.horizon(), cut);
});

test('the documented persist pair {checkpoint(), ops()} round-trips PARKED ops losslessly', () => {
  // The whole cycle, because the failure this closes needed no adversary: `checkpoint()` folds
  // only what is APPLIED, so a parked op survives a relaunch ONLY if it is in the tail. When
  // `ops()` omitted it, an ordinary quit-and-reopen destroyed every parked write — the exact
  // "loses the new thing" failure §7.4 and §12.5 exist to prevent — and the peer that did not
  // relaunch kept it, so the two devices diverged the moment wall time passed the stamp.
  const wall = makeWall();
  const a = makeAuthor({ tag: 'a', short: SHORT_A, wall });
  const b = makeAuthor({ tag: 'b', short: SHORT_B, act: MEM_B, dev: DEV_B, wall });
  const onTime = (a.txn(), a.note(U1, { date: '2026-09-10', text: 'heute' }));
  // A peer whose clock runs 48 h fast, and an op from a build we do not know yet: both PARKED.
  const fromFuture = { ...(b.txn(), b.note(U1, { text: 'aus der Zukunft' })), ts: fmt(wall.ms + 2 * DAY, 0, SHORT_B) };
  const fromNewerBuild = skewed((a.txn(), a.note(U2, { date: '2026-09-11' })), { k: 'reminder.set' });

  const before = log(makeWall(wall.ms));
  before.append(onTime, { seq: '7' });
  assert.equal(before.append(fromFuture).status, APPEND.PARKED);
  assert.equal(before.append(fromNewerBuild).status, APPEND.PARKED);
  assert.equal(before.parkedSize, 2);

  // Exactly the pair the module documents, through JSON, exactly as `ops.jsonl` would be.
  const persisted = JSON.parse(JSON.stringify({ checkpoint: before.checkpoint(), tail: before.ops() }));
  assert.equal(persisted.tail.length, 3, 'ops() silently omitted the parked lines');

  const after = log(makeWall(wall.ms));
  after.load(persisted);
  assert.equal(after.parkedSize, 2, 'a relaunch destroyed the parked ops');
  assert.equal(after.has(fromFuture.id), true);
  assert.equal(after.has(fromNewerBuild.id), true);
  assert.equal(after.parkReasonOf(fromFuture.id), PARK_REASONS.FUTURE, 'the tail is RE-classified, not trusted');
  assert.equal(after.parkReasonOf(fromNewerBuild.id), PARK_REASONS.UNKNOWN_KIND);
  assert.equal(snap(after), snap(before), 'the reloaded registers differ from the ones we persisted');

  // …and the RELOADED op still re-evaluates when its prerequisite arrives: the clock passes it,
  // `unpark()` promotes it, and it competes for LWW like any other write.
  const relaunchWall = makeWall(wall.ms);
  const relaunched = log(relaunchWall);
  relaunched.load(persisted);
  assert.equal(relaunched.parkedSize, 2);
  relaunchWall.advance(3 * DAY);
  assert.deepEqual(relaunched.unpark((o) => o.id === fromFuture.id).map((o) => o.id), [fromFuture.id]);
  assert.equal(val(relaunched, noteKey(U1), 'text'), 'aus der Zukunft');

  // …and it lands exactly where the peer that never relaunched lands. THIS is the divergence the
  // old behaviour produced: on the relaunched Mac the write simply did not exist any more.
  const neverRelaunched = log(makeWall(wall.ms));
  neverRelaunched.append(onTime, { seq: '7' });
  neverRelaunched.append(fromFuture);
  neverRelaunched.append(fromNewerBuild);
  const stillUpWall = makeWall(wall.ms + 3 * DAY);
  const stillUp = log(stillUpWall);
  stillUp.load({ checkpoint: neverRelaunched.checkpoint(), tail: neverRelaunched.ops() });
  stillUp.unpark((o) => o.id === fromFuture.id);
  assert.equal(snap(relaunched), snap(stillUp), 'the relaunched Mac and the one that stayed up disagree');
});

test('load() re-classifies the tail rather than trusting yesterdays verdict', () => {
  // An op parked as `unknownKind` by yesterday's build must become live after an app update with
  // nobody writing a migration; and a stamp that was 23 h in the future must re-park if the
  // user's clock jumped backwards.
  const wall = makeWall();
  const a = makeAuthor({ tag: 'a', short: SHORT_A, wall });
  const soon = { ...(a.txn(), a.note(U1, { date: '2026-09-10' })), ts: fmt(wall.ms + 23 * 60 * 60 * 1000, 0, SHORT_A) };

  const normal = log(makeWall(wall.ms));
  assert.equal(normal.append(soon).status, APPEND.APPENDED);

  const clockWentBack = log(makeWall(wall.ms - 3 * DAY));
  clockWentBack.load({ tail: [soon] });
  assert.equal(clockWentBack.parkedSize, 1);
  assert.equal(clockWentBack.parkReasonOf(soon.id), PARK_REASONS.FUTURE);
  assert.equal(clockWentBack.size, 0);
});

test('load() accepts both bare ops and {op, seq} lines', () => {
  const wall = makeWall();
  const a = makeAuthor({ tag: 'a', wall });
  a.txn();
  const n1 = a.note(U1, { date: '2026-09-10' });
  const n2 = a.note(U2, { date: '2026-09-11' });
  const l = log(makeWall(wall.ms));
  l.load({ tail: [n1, { op: n2, seq: '99' }] });
  assert.equal(l.size, 2);
  assert.equal(l.seqOf(n2.ts), 99n);
  assert.equal(l.seqOf(n1.ts), null, 'an unacked op must report an UNKNOWN seq, not zero');
});

test('load() wipes whatever was there before', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  l.append((a.txn(), a.note(U1, { date: '2026-09-10' })));
  l.setCursor(PSP, 5);
  l.load({ tail: [] });
  assert.equal(l.size, 0);
  assert.equal(snap(l), EMPTY);
  assert.equal(l.cursor(PSP), null);
  assert.equal(l.horizon(), null);
});

test('serializeRegisters round-trips losslessly, including nulls and stamps', () => {
  const wall = makeWall();
  const a = makeAuthor({ tag: 'a', wall });
  a.txn();
  const ops = [a.note(U1, { date: '2026-09-10', text: 'Zahnarzt', repeatsYearly: true, _alive: true }, { born: true }),
    a.note(U2, { text: null })];
  const l = log(makeWall(wall.ms));
  for (const op of ops) l.append(op);
  const blob = JSON.parse(JSON.stringify(registers.serializeRegisters(l.registers())));
  const back = registers.deserializeRegisters(blob);
  assert.equal(JSON.stringify(registers.serializeRegisters(back)), JSON.stringify(blob));
  assert.equal(back.get(noteKey(U2)).get('text').value, null, 'null is a first-class value, not an absence');
});

test('a hostile checkpoint cannot pollute Object.prototype', () => {
  // checkpoint.json is JSON on the user's disk, and JSON.parse creates a real own `__proto__`.
  const l = log(makeWall());
  const cell = `{"value":1,"stamp":"${ZERO_STAMP}","author":"${MEM_A}","op":"${oid('h', 1)}"}`;
  const good = `{"date":{"value":"2026-09-10","stamp":"${ZERO_STAMP}","author":"${MEM_A}","op":"${oid('h', 2)}"}}`;
  const hostile = JSON.parse(`{"v":1,"regs":{"__proto__":{"pwned":${cell}},"note:ok":${good}}}`);
  assert.throws(() => l.load({ checkpoint: { regs: hostile } }), Error);
  assert.equal({}.pwned, undefined, 'Object.prototype was polluted by a checkpoint file');
  assert.equal(l.registers().has('__proto__'), false);

  const clean = JSON.parse(`{"v":1,"regs":{"note:ok":${good}}}`);
  l.load({ checkpoint: { regs: clean } });
  assert.equal(val(l, 'note:ok', 'date'), '2026-09-10');
});

test('a corrupt checkpoint register is refused loudly rather than folded', () => {
  const l = log(makeWall());
  const bad = (cell) => () => l.load({ checkpoint: { regs: { v: 1, regs: { 'note:x': { date: cell } } } } });
  assert.throws(bad({ value: '2026-09-10', author: MEM_A }), Error);                     // no stamp
  assert.throws(bad({ value: '2026-09-10', stamp: ZERO_STAMP }), Error);                 // no author
  assert.throws(bad({ stamp: ZERO_STAMP, author: MEM_A }), Error);                       // no value: absent is not null (R9)
  assert.throws(() => l.load({ checkpoint: { regs: { v: 99, regs: {} } } }), Error);      // unknown format
  assert.equal(snap(l), EMPTY);
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Cursors and seqs (ADR 003 §3.3)
// ═════════════════════════════════════════════════════════════════════════════

test('a cursor never moves backwards', () => {
  // It is advanced only after a batch is folded AND persisted; a crash mid-pull must re-fetch
  // rather than skip.
  const l = log(makeWall());
  assert.equal(l.setCursor(PSP, '10'), true);
  assert.equal(l.setCursor(PSP, '20'), true);
  assert.equal(l.setCursor(PSP, '15'), false);
  assert.equal(l.setCursor(PSP, '20'), false);
  assert.equal(l.cursor(PSP), 20n);
  assert.deepEqual(l.cursors(), { [PSP]: '20' });
  assert.throws(() => l.setCursor(PSP, -1), OpLogError);
  assert.throws(() => l.setCursor(PSP, 'twenty'), OpLogError);
});

test('cursors and seqs survive a checkpoint / load cycle', () => {
  // Without persisting stamp→seq, condition 3 of §7.3 becomes unevaluable after every relaunch
  // and tombstone GC silently stops working forever.
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const op = (a.txn(), a.note(U1, { date: '2026-09-10', _alive: true }));
  l.append(op, { seq: 4242 });
  l.setCursor(PSP, 4242);
  const cp = JSON.parse(JSON.stringify(l.checkpoint()));
  l.compact();

  const restored = log(makeWall(wall.ms));
  restored.load({ checkpoint: cp, tail: [] });
  assert.equal(restored.cursor(PSP), 4242n);
  assert.equal(restored.seqOf(op.ts), 4242n, 'the stamp→seq index did not survive the reload');
});

test('an ack after the fact records the seq', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const op = (a.txn(), a.note(U1, { date: '2026-09-10' }));
  l.append(op);
  assert.equal(l.seqOf(op.ts), null);
  assert.equal(l.ack(op.id, '77'), true);
  assert.equal(l.seqOf(op.ts), 77n);
  assert.equal(l.ack(oid('zz', 1), '1'), false);
});

test('a duplicate delivery carrying a seq acks the op we already hold', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const op = (a.txn(), a.note(U1, { date: '2026-09-10' }));
  l.append(op);                                   // our own write, still in the outbox
  assert.equal(l.append(op, { seq: '5' }).status, APPEND.DUPLICATE);
  assert.equal(l.seqOf(op.ts), 5n, 'the server told us the seq and we threw it away');
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. Tombstone GC — ADR 001 §7.3, risk R15
// ═════════════════════════════════════════════════════════════════════════════

/** A world in which note U1 was created, then deleted, and then 401 days went by. */
function tombstoneWorld() {
  const wall = makeWall();
  const a = makeAuthor({ tag: 'a', short: SHORT_A, wall });
  a.txn();
  const create = a.note(U1, { date: '2026-09-10', text: 'Zahnarzt', _alive: true }, { born: true });
  wall.advance(60_000);
  a.txn();
  const del = a.note(U1, { _alive: false });
  const nowMs = wall.ms + 401 * DAY;
  const l = log(makeWall(nowMs));
  l.append(create, { seq: '100' });
  l.append(del, { seq: '101' });
  return { l, create, del, nowMs, wall, a };
}

/**
 * Condition 3's two halves. `minDeviceSeq` is the fleet minimum of `lastSeenSeq` (READ progress);
 * `minPushedSeq` is the fleet minimum of `lastPushedSeq` (WRITE progress — the global seq
 * high-water at which each device last confirmed a DRAINED outbox). Both are required, and the
 * tests that only care about one half pass the same number for both.
 */
const guard = (l, nowMs, minDeviceSeq, minPushedSeq = minDeviceSeq) => (
  { nowMs, minDeviceSeq, minPushedSeq, seqOf: l.seqOf });

test('all three conditions satisfied — the tombstone is collectable', () => {
  const { l, nowMs } = tombstoneWorld();
  assert.equal(tombstoneCollectable(l.registers(), noteKey(U1), guard(l, nowMs, 101n)), true);
});

test('condition 1 — a living entity is never collectable', () => {
  const { l, nowMs } = tombstoneWorld();
  const a = makeAuthor({ tag: 'r', short: SHORT_A, wall: makeWall(nowMs) });
  l.append((a.txn(), a.note(U1, { _alive: true })), { seq: '102' });
  assert.equal(val(l, noteKey(U1), '_alive'), true);
  assert.equal(tombstoneCollectable(l.registers(), noteKey(U1), guard(l, nowMs + 1000, 999n)), false);
});

test('condition 2 — the 400-day boundary is exact', () => {
  const { l, del } = tombstoneWorld();
  const delMs = Number(del.ts.slice(0, 13));
  const exactly = delMs + TOMBSTONE_MIN_AGE_MS;
  assert.equal(tombstoneCollectable(l.registers(), noteKey(U1), guard(l, exactly, 999n)), false,
    'exactly 400 days is not "more than 400 days"');
  assert.equal(tombstoneCollectable(l.registers(), noteKey(U1), guard(l, exactly + 1, 999n)), true);
});

test('condition 2 uses the NEWEST stamp, not the tombstone stamp', () => {
  const { l, nowMs, del } = tombstoneWorld();
  const later = makeAuthor({ tag: 'q', short: SHORT_B, act: MEM_B, dev: DEV_B, wall: makeWall(nowMs - DAY) });
  l.append((later.txn(), later.note(U1, { text: 'nachtrag' })), { seq: '110' });
  assert.equal(cmp(stampOf(l, noteKey(U1), 'text'), del.ts), 1);
  assert.equal(tombstoneCollectable(l.registers(), noteKey(U1), guard(l, nowMs, 999n)), false,
    'a register written yesterday cannot be more than 400 days old');
});

test('CONDITION 3 — a device that has not folded past the tombstone blocks GC', () => {
  const { l, nowMs } = tombstoneWorld();
  assert.equal(tombstoneCollectable(l.registers(), noteKey(U1), guard(l, nowMs, 100n)), false,
    'a device one seq behind the tombstone did NOT block collection');
  assert.equal(tombstoneCollectable(l.registers(), noteKey(U1), guard(l, nowMs, 0n)), false,
    'a device that has folded nothing did NOT block collection');
  assert.equal(tombstoneCollectable(l.registers(), noteKey(U1), guard(l, nowMs, 101n)), true);
});

test('condition 3 cannot be evaluated away by simply not passing the data', () => {
  // This is the assertion ADR 001 §7.3 asks for. "Do not optimize condition 3 away" has to bite
  // against the caller who omits minDeviceSeq, because that is what optimising it away looks like.
  const { l, nowMs } = tombstoneWorld();
  const regs = l.registers();
  assert.throws(() => tombstoneCollectable(regs, noteKey(U1), { nowMs }), TombstoneGuardError);
  assert.throws(() => tombstoneCollectable(regs, noteKey(U1), { nowMs, seqOf: l.seqOf }), /minDeviceSeq/);
  assert.throws(() => tombstoneCollectable(regs, noteKey(U1), { nowMs, minDeviceSeq: 101n }), /seqOf/);
  assert.throws(() => tombstoneCollectable(regs, noteKey(U1), null), TombstoneGuardError);
  assert.throws(() => tombstoneCollectable(regs, noteKey(U1), { minDeviceSeq: 1n, minPushedSeq: 1n, seqOf: l.seqOf }), /nowMs/);
  assert.throws(() => tombstoneCollectable(regs, noteKey(U1), { nowMs, minDeviceSeq: 101, minPushedSeq: 101n, seqOf: l.seqOf }),
    /BigInt/, 'a Number minDeviceSeq must not be silently coerced');
  assert.throws(() => tombstoneCollectable({}, noteKey(U1), guard(l, nowMs, 1n)), TombstoneGuardError);

  // …and the WRITE half of condition 3 is guarded exactly as hard as the read half, because
  // omitting it is what "optimizing condition 3 away" looks like once the read half is in place.
  assert.throws(() => tombstoneCollectable(regs, noteKey(U1), { nowMs, minDeviceSeq: 101n, seqOf: l.seqOf }),
    /minPushedSeq/, 'GC ran without knowing whether any device still has an unpushed outbox');
  assert.throws(() => tombstoneCollectable(regs, noteKey(U1), { nowMs, minDeviceSeq: 101n, minPushedSeq: 101, seqOf: l.seqOf }),
    /BigInt/, 'a Number minPushedSeq must not be silently coerced');
  assert.throws(() => tombstoneCollectable(regs, noteKey(U1), { nowMs, minDeviceSeq: 101n, minPushedSeq: -1n, seqOf: l.seqOf }),
    /may not be negative/);
  assert.throws(() => l.collectTombstones({ nowMs, minDeviceSeq: 101n }), /minPushedSeq/,
    'collectTombstones must not supply a permissive default for the caller who omits it');
});

test('an UNKNOWN seq never means yes', () => {
  // Our own write that the server has not acked yet, or an op compacted before we tracked seqs.
  const { l, nowMs } = tombstoneWorld();
  const blind = { nowMs, minDeviceSeq: 10n ** 9n, minPushedSeq: 10n ** 9n, seqOf: () => null };
  assert.equal(tombstoneCollectable(l.registers(), noteKey(U1), blind), false);
  const wrongType = { nowMs, minDeviceSeq: 10n ** 9n, minPushedSeq: 10n ** 9n, seqOf: () => 101 };
  assert.equal(tombstoneCollectable(l.registers(), noteKey(U1), wrongType), false);
});

test('a family entity is judged on pub.alive, and pref / space are never collectable', () => {
  const wall = makeWall();
  const a = makeAuthor({ tag: 'a', wall });
  a.txn();
  const key = familyKey('fnote', MEM_A, U1);
  const pub = a.pub('fnote', MEM_A, U1, { 'pub.level': 'geteilt', 'pub.text': 'Zahnarzt', 'pub.alive': true }, { born: true });
  wall.advance(1000);
  a.txn();
  const dead = a.pub('fnote', MEM_A, U1, { 'pub.alive': false });
  const pref = a.pref({ lastCategoryId: 'cat-1' });
  const nowMs = wall.ms + 401 * DAY;
  const l = log(makeWall(nowMs));
  l.append(pub, { seq: '1' }); l.append(pref, { seq: '2' }); l.append(dead, { seq: '3' });

  assert.equal(tombstoneCollectable(l.registers(), key, guard(l, nowMs, 3n)), true);
  assert.equal(tombstoneCollectable(l.registers(), PREF_KEY, guard(l, nowMs, 99n)), false,
    'pref has no tombstone register and must never be collected');
  assert.equal(tombstoneCollectable(l.registers(), 'note:nonexistent', guard(l, nowMs, 99n)), false);
});

test('collectTombstones honours all three conditions and drops the lines too', () => {
  const { l, nowMs } = tombstoneWorld();
  assert.deepEqual(l.collectTombstones({ nowMs, minDeviceSeq: 100n, minPushedSeq: 100n }), [], 'GC ran while a device was behind');
  assert.equal(l.registers().has(noteKey(U1)), true);

  const collected = l.collectTombstones({ nowMs, minDeviceSeq: 101n, minPushedSeq: 101n });
  assert.deepEqual(collected, [noteKey(U1)]);
  assert.equal(l.registers().has(noteKey(U1)), false, 'the entity survived collection');
  assert.equal(l.ops({ entity: noteKey(U1) }).length, 0, 'the lines survived collection');
});

test('R15 — collecting a tombstone too early RESURRECTS a deleted entry', () => {
  // The narrated scenario ADR 001 §13.3 calls "the one unsafe-if-violated rule".
  //
  //   • Papa creates "Zahnarzt", then deletes it. 401 days pass. Both ops reach the relay
  //     (seq 100 and 101).
  //   • Mama's MacBook has been in a drawer since seq 100: it folded the create, never the
  //     delete, and it is holding one unpushed edit of its own from that week.
  //   • Papa's Mac compacts. If it collects the tombstone now — conditions 1 and 2 hold, and
  //     only condition 3 says no — the entity leaves the checkpoint entirely: no value, and
  //     crucially no STAMP for the delete to win with.
  //   • Mama's Mac comes back and pushes. Her edit is OLDER than the delete, so it should be
  //     absorbed silently. On the log that obeyed the rule, it is. On the log that did not, the
  //     dentist appointment is back on the wall calendar.
  const { l: obedient, nowMs, wall, del } = tombstoneWorld();

  const mama = makeAuthor({ tag: 'm', short: SHORT_B, act: MEM_B, dev: DEV_B, wall: makeWall(wall.ms - 30_000) });
  const drawerEdit = (mama.txn(), mama.note(U1, { text: 'Zahnarzt 15:00' }));
  assert.equal(cmp(drawerEdit.ts, del.ts), -1, 'the drawer edit must predate the delete for this to be the R15 case');

  // 1. the rule is obeyed: condition 3 refuses, and the tombstone stays.
  assert.deepEqual(obedient.collectTombstones({ nowMs, minDeviceSeq: 100n, minPushedSeq: 100n }), []);

  // 2. the rule is violated: the same GC, with condition 3 struck out.
  const violated = log(makeWall(nowMs));
  violated.load({ checkpoint: JSON.parse(JSON.stringify(obedient.checkpoint())), tail: [] });
  const regs = violated.registers();
  const doomed = [...regs.keys()].filter((e) => {
    const cells = regs.get(e);
    const alive = cells.get('_alive');
    if (!alive || alive.value !== false) return false;                       // condition 1
    let newest = null;
    for (const r of cells.values()) if (newest === null || cmp(r.stamp, newest) > 0) newest = r.stamp;
    return nowMs - Number(newest.slice(0, 13)) > TOMBSTONE_MIN_AGE_MS;       // condition 2, and NO condition 3
  });
  assert.deepEqual(doomed, [noteKey(U1)], 'the violating GC did not even select the entity');
  violated.load({
    checkpoint: (() => {
      const cp = JSON.parse(JSON.stringify(violated.checkpoint()));
      for (const e of doomed) delete cp.regs.regs[e];
      return cp;
    })(),
    tail: [],
  });
  assert.equal(violated.registers().has(noteKey(U1)), false);

  // 3. Mama reconnects and pushes her one stale edit to both Macs.
  assert.equal(obedient.append(drawerEdit, { seq: '102' }).status, APPEND.APPENDED);
  assert.equal(violated.append(drawerEdit, { seq: '102' }).status, APPEND.APPENDED);

  assert.equal(val(obedient, noteKey(U1), '_alive'), false, 'the obedient log lost the tombstone');
  assert.equal(val(violated, noteKey(U1), '_alive'), MISSING);
  assert.equal(val(violated, noteKey(U1), 'text'), 'Zahnarzt 15:00',
    'THE RESURRECTION: a deleted entry is back, and this is what condition 3 prevents');
  assert.notEqual(snap(obedient), snap(violated));
});

test('once the long-offline device catches up, the same tombstone IS collectable', () => {
  const { l, nowMs } = tombstoneWorld();
  assert.deepEqual(l.collectTombstones({ nowMs, minDeviceSeq: 100n, minPushedSeq: 100n }), []);
  assert.deepEqual(l.collectTombstones({ nowMs, minDeviceSeq: 101n, minPushedSeq: 101n }), [noteKey(U1)]);
  assert.equal(l.registers().size, 0);
});

test('R15 — CONDITION 3(b): an UNPUSHED write resurrects the entry the GC collected around it', () => {
  // The half of condition 3 that ADR 001 §7.3 does not state, narrated end to end.
  //
  //   • Papa creates "Zahnarzt" and deletes it; both ops reach the relay (seq 100, 101).
  //   • Mama's MacBook has PULLED everything — its lastSeenSeq is current, so the read half of
  //     condition 3 says yes — but it has been unable to PUSH for 500 days, and its outbox holds
  //     one edit of that entry.
  //   • The register the delete wrote is what absorbs that edit. Collect the entity and there is
  //     no stamp left to absorb anything with, so the edit does not lose the join — it RECREATES
  //     the entry, however old it is. The read half cannot see this coming: the outbox is not
  //     lastSeenSeq.
  const { l: gcd, nowMs, wall } = tombstoneWorld();

  const mama = makeAuthor({ tag: 'm', short: SHORT_B, act: MEM_B, dev: DEV_B, wall: makeWall(wall.ms + 5 * DAY) });
  const stuckInOutbox = (mama.txn(), mama.note(U1, { text: 'Zahnarzt verschoben' }));

  // Reads are fully caught up (500 ≫ 101). Writes are not: Mama last drained her outbox at 99.
  assert.equal(tombstoneCollectable(gcd.registers(), noteKey(U1), guard(gcd, nowMs, 500n, 99n)), false,
    'a device with an unacked outbox did NOT block collection — this is R15 through the other door');
  assert.deepEqual(gcd.collectTombstones({ nowMs, minDeviceSeq: 500n, minPushedSeq: 99n }), []);
  assert.equal(gcd.registers().has(noteKey(U1)), true);

  // The peer that never GC'd, for the comparison.
  const kept = log(makeWall(nowMs));
  kept.load({ checkpoint: JSON.parse(JSON.stringify(gcd.checkpoint())), tail: [] });

  // Mama finally pushes. §12.5: both logs ADMIT the op, however old it is.
  assert.equal(gcd.append(stuckInOutbox, { seq: '900' }).status, APPEND.APPENDED);
  assert.equal(kept.append(stuckInOutbox, { seq: '900' }).status, APPEND.APPENDED);

  assert.equal(val(gcd, noteKey(U1), '_alive'), false, 'THE RESURRECTION: the deleted entry is back');
  assert.equal(snap(gcd), snap(kept), 'the device that GC\'d and the device that did not disagree');

  // Once every device has drained its outbox past the tombstone, the same GC is allowed.
  assert.equal(tombstoneCollectable(gcd.registers(), noteKey(U1), guard(gcd, nowMs, 500n, 500n)), false,
    'the fresh push is newer than 400 days, so condition 2 now blocks it — collection is merely deferred');
});

test('an entity whose own registers are not all acked is never collectable', () => {
  // The mirror image: the unacked write is in OUR outbox. Its stamp is in the registers with no
  // seq, so condition 3 cannot be evaluated for it at all — and unknown never means yes.
  const { l, nowMs, wall } = tombstoneWorld();
  const b = makeAuthor({ tag: 'u', short: SHORT_B, act: MEM_B, dev: DEV_B, wall: makeWall(wall.ms - 30_000) });
  l.append((b.txn(), b.note(U1, { categoryId: 'cat-9' })));       // no seq: still in our outbox
  assert.equal(l.seqOf(l.get([...l.ops({ liveOnly: true })].at(-1).id).ts), null);
  assert.equal(tombstoneCollectable(l.registers(), noteKey(U1), guard(l, nowMs, 10n ** 9n)), false,
    'an entity with an unacked register was collected');
  assert.deepEqual(l.collectTombstones({ nowMs, minDeviceSeq: 10n ** 9n, minPushedSeq: 10n ** 9n }), []);
});

test('collectTombstones never deletes a PARKED op, and an entity with one is not collectable', () => {
  // §7.3's three conditions all reason about the entity's REGISTERS. A parked op is by
  // construction not in them: it never contributed to condition 2's max(stamps) and never
  // contributed to condition 3, and it may carry a stamp NEWER than every register the entity
  // has. Deleting it would destroy a newer sibling's write retained precisely so the next app
  // update could apply it — "loses the new thing", §7.4's whole reason to exist — and it would
  // leave a device that has GC'd applying a different op set from one that has not.
  const { l, nowMs, wall } = tombstoneWorld();
  const a = makeAuthor({ tag: 'n', short: SHORT_C, wall: makeWall(wall.ms + 1000) });
  const fromNewerBuild = skewed((a.txn(), a.note(U1, { date: '2026-09-10' })),
    { f: { date: '2026-09-10', reminderMinutes: 30 } });
  assert.equal(l.append(fromNewerBuild, { seq: '105' }).status, APPEND.PARKED);
  assert.equal(l.parkedSize, 1);

  assert.deepEqual(l.collectTombstones({ nowMs, minDeviceSeq: 999n, minPushedSeq: 999n }), [],
    'the tombstone was collected while a parked op for that entity was still waiting');
  assert.equal(l.parkedSize, 1, 'the retained forward-compatibility op was destroyed by the GC');
  assert.equal(l.get(fromNewerBuild.id).id, fromNewerBuild.id);
  assert.equal(l.registers().has(noteKey(U1)), true);

  // A sibling that has not GC'd holds exactly the same thing — no divergence.
  const sibling = log(makeWall(nowMs));
  sibling.load({ checkpoint: JSON.parse(JSON.stringify(l.checkpoint())), tail: l.ops() });
  assert.equal(sibling.parkedSize, 1);
  assert.equal(snap(sibling), snap(l));

  // …and once the op is understood, the tombstone becomes collectable again on its own terms.
  const other = log(makeWall(nowMs));
  other.load({ checkpoint: JSON.parse(JSON.stringify(l.checkpoint())), tail: [] });
  assert.deepEqual(other.collectTombstones({ nowMs, minDeviceSeq: 999n, minPushedSeq: 999n }), [noteKey(U1)]);
});

test('a device that never returns blocks GC forever — and that is the safe outcome', () => {
  const { l, nowMs } = tombstoneWorld();
  for (const years of [1, 3, 10, 40]) {
    assert.deepEqual(l.collectTombstones({ nowMs: nowMs + years * 365 * DAY, minDeviceSeq: 100n, minPushedSeq: 100n }), [],
      `GC gave up after ${years} years and collected anyway`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. The forget pass (ADR 004 §5.3)
// ═════════════════════════════════════════════════════════════════════════════

function publishedWorld() {
  const wall = makeWall();
  const a = makeAuthor({ tag: 'a', wall });
  a.txn();
  const key = familyKey('fnote', MEM_A, U1);
  const pub = a.pub('fnote', MEM_A, U1,
    { 'pub.level': 'geteilt', 'pub.date': '2026-09-10', 'pub.text': 'Zahnarzt', 'pub.alive': true }, { born: true });
  wall.advance(1000);
  a.txn();
  const retract = a.pub('fnote', MEM_A, U1, { 'pub.level': 'privat', 'pub.text': null, 'pub.alive': false });
  const l = log(makeWall(wall.ms));
  l.append(pub); l.append(retract);
  return { l, key, pub, retract, wall, a };
}

test('forget purges this entity\'s lines for that space and returns the count', () => {
  const { l, key, pub } = publishedWorld();
  const a = makeAuthor({ tag: 'o', wall: makeWall() });
  const other = (a.txn(), a.pub('fnote', MEM_A, U2, { 'pub.level': 'belegt' }));
  l.append(other);
  assert.equal(l.ops({ entity: key }).length, 2);
  assert.equal(l.forget(key, FSP), 2);
  assert.equal(l.ops({ entity: key }).length, 0);
  assert.equal(l.ops({ entity: familyKey('fnote', MEM_A, U2) }).length, 1, 'forget touched another entity');
  assert.equal(l.get(pub.id), null);
});

test('forget drops the register VALUES and RETAINS the stamps', () => {
  const { l, key, retract } = publishedWorld();
  const textStamp = stampOf(l, key, 'pub.text');
  l.forget(key, FSP);
  assert.equal(val(l, key, 'pub.date'), null, 'a content value survived the forget pass');
  assert.equal(stampOf(l, key, 'pub.date'), stampOf(l, key, 'pub.date'));
  assert.notEqual(stampOf(l, key, 'pub.text'), null, 'the stamp was dropped — convergence needs it');
  assert.equal(stampOf(l, key, 'pub.text'), textStamp);
  assert.equal(val(l, key, 'pub.alive'), false, 'the governing retraction registers must survive');
  assert.equal(val(l, key, 'pub.level'), 'privat');
  assert.equal(stampOf(l, key, 'pub.alive'), retract.ts);
});

test('forget survives re-delivery of the op it purged, in-session', () => {
  const { l, key, pub } = publishedWorld();
  l.forget(key, FSP);
  assert.equal(val(l, key, 'pub.text'), null);
  assert.equal(val(l, key, 'pub.date'), null);
  assert.equal(l.append(pub).status, APPEND.DUPLICATE, 'dedupe by opId is what protects this case');
  assert.equal(val(l, key, 'pub.text'), null);
  assert.equal(val(l, key, 'pub.date'), null);
});

test('CLOSED (was a KNOWN GAP) — a cold re-delivery of the publication cannot un-blank a forgotten field', () => {
  // Two fields, and they are blanked by two different mechanisms — which is exactly why both
  // need asserting:
  //
  //   pub.text  was nulled BY THE RETRACTION, at a greater stamp. Re-delivering the publication
  //             loses on stamp, so the forget holds under any tie rule at all.
  //   pub.date  was never re-written; the forget pass blanked it IN PLACE, at the publication's
  //             own stamp and opId. Re-delivering the publication is therefore an EXACT
  //             (stamp, opId) tie against its own blanked self — the one tie ADR 001 §6 calls
  //             "unreachable" that the forget pass makes reachable.
  //
  // FIXED during WP-1 integration by one line in `registers.js:valueKey`: `null` now ranks ABOVE
  // every non-null value, so the blank WINS the double tie and forget is absorbing. That
  // comparator is consulted only when the stamp AND the opId both tie — i.e. only for this exact
  // case — so nothing else in the fold can be affected by it. The companion assertion lives in
  // core-registers.test.js ('cmpWrites returns 0 only for genuinely identical writes').
  //
  // A genuinely NEWER publication still restores the value: that is the owner sharing again, and
  // it is asserted by the next test but one.
  const { l, key, pub, retract } = publishedWorld();
  l.forget(key, FSP);
  const cold = log(makeWall());
  cold.load({ checkpoint: JSON.parse(JSON.stringify(l.checkpoint())), tail: [] });
  assert.equal(cold.append(pub).status, APPEND.APPENDED, 'the op must be admitted; the question is whether it WINS');

  assert.equal(val(cold, key, 'pub.text'), null, 'a value nulled at a greater stamp must stay nulled');
  assert.equal(val(cold, key, 'pub.date'), null,
    'the exact (stamp, opId) tie must be broken IN FAVOUR OF THE BLANK — a retraction that a re-pull can undo is not a retraction');

  // …and re-delivering the retraction alongside it changes nothing.
  cold.append(retract);
  assert.equal(val(cold, key, 'pub.alive'), false);
  assert.equal(val(cold, key, 'pub.text'), null);
  assert.equal(val(cold, key, 'pub.date'), null);
});

test('forget({fields}) scopes the blank to a downgrade\'s nulled field', () => {
  // Geteilt → Belegt: the text goes, the date stays published. Blanking everything here would
  // erase a Belegt entry the family is meant to keep seeing (ADR 004 §5.3 trigger ii).
  const wall = makeWall();
  const a = makeAuthor({ tag: 'd', wall });
  const key = familyKey('fnote', MEM_A, U1);
  a.txn();
  const pub = a.pub('fnote', MEM_A, U1,
    { 'pub.level': 'geteilt', 'pub.date': '2026-09-10', 'pub.text': 'Zahnarzt', 'pub.alive': true }, { born: true });
  wall.advance(1000);
  a.txn();
  const down = a.pub('fnote', MEM_A, U1, { 'pub.level': 'belegt', 'pub.text': null });
  const l = log(makeWall(wall.ms));
  l.append(pub); l.append(down);

  assert.equal(l.forget(key, FSP, { fields: ['pub.text'] }), 2, 'both lines carried the plaintext');
  assert.equal(val(l, key, 'pub.text'), null);
  assert.equal(val(l, key, 'pub.date'), '2026-09-10', 'a Belegt entry lost the date it is meant to publish');
  assert.equal(val(l, key, 'pub.level'), 'belegt');
  assert.throws(() => l.forget(key, FSP, { fields: 'pub.text' }), OpLogError);
});

test('a genuinely NEWER publication still restores the value after a forget', () => {
  // Forget is not a permanent block. If the owner shares the entry again, it comes back — that is
  // the owner republishing, not a leak.
  const { l, key, wall } = publishedWorld();
  l.forget(key, FSP);
  wall.advance(5000);
  const a = makeAuthor({ tag: 'z', wall });
  l.append((a.txn(), a.pub('fnote', MEM_A, U1, { 'pub.level': 'geteilt', 'pub.text': 'Zahnarzt neu', 'pub.alive': true })));
  assert.equal(val(l, key, 'pub.text'), 'Zahnarzt neu');
  assert.equal(val(l, key, 'pub.alive'), true);
});

test('forget works whether or not the entity has been compacted', () => {
  const uncompacted = publishedWorld();
  uncompacted.l.forget(uncompacted.key, FSP);
  const compacted = publishedWorld();
  compacted.l.compact();
  compacted.l.forget(compacted.key, FSP);
  assert.equal(snap(compacted.l), snap(uncompacted.l));
  assert.equal(val(compacted.l, compacted.key, 'pub.text'), null);
});

test('forget also purges a PARKED line for that entity', () => {
  const { l, key } = publishedWorld();
  const a = makeAuthor({ tag: 'p', wall: makeWall() });
  const base = (a.txn(), a.pub('fnote', MEM_A, U1, { 'pub.level': 'belegt' }));
  l.append({ ...base, id: oid('pk', 1), f: { 'pub.level': 'belegt', 'pub.mood': 'happy' } });
  assert.equal(l.parkedSize, 1);
  assert.equal(l.forget(key, FSP), 3);
  assert.equal(l.parkedSize, 0, 'a parked line is still a line on disk');
});

test('forget REFUSES an entity that is still live — the blank would be unrecoverable', () => {
  // The liveness guard. Because `registers.js:valueKey` ranks `null` above every value, the
  // blank wins the exact (stamp, opId) tie a cold re-delivery produces — which is what makes a
  // retraction a retraction, and which also makes an unscoped forget on a STILL-PUBLISHED entity
  // irreversible: nothing can put the value back, while every peer that did not run the pass
  // still shows it. ADR 004 §5.3 fires this pass only on a retraction or a nulled content field,
  // so a forget on a live entity is outside the mechanism it implements, and it is refused.
  const wall = makeWall();
  const a = makeAuthor({ tag: 'v', wall });
  const key = familyKey('fnote', MEM_A, U1);
  const share = (a.txn(), a.pub('fnote', MEM_A, U1,
    { 'pub.level': 'belegt', 'pub.alive': true, 'pub.date': '2026-09-10' }, { born: true }));
  const l = log(makeWall(wall.ms));
  l.append(share);

  assert.throws(() => l.forget(key, FSP), OpLogError);
  assert.throws(() => l.forget(key, FSP), /still live/);
  assert.throws(() => l.forget(key, FSP, { values: 'content' }), /still live/);
  assert.equal(val(l, key, 'pub.date'), '2026-09-10', 'the refused forget blanked something anyway');
  assert.equal(l.ops({ entity: key }).length, 1, 'the refused forget purged a line anyway');

  // A peer that did nothing holds exactly the same board — which is the whole point.
  const peer = log(makeWall(wall.ms));
  peer.append(share);
  assert.equal(snap(l), snap(peer));

  // Two escape hatches, both explicit. (i) the §5.3 trigger (ii) downgrade: scoped to the field
  // mechanism 1 already nulled, on an entity that legitimately stays visible.
  wall.advance(1000);
  const down = (a.txn(), a.pub('fnote', MEM_A, U1, { 'pub.text': null }));
  l.append(down);
  assert.equal(l.forget(key, FSP, { fields: ['pub.text'] }), 2);
  assert.equal(val(l, key, 'pub.date'), '2026-09-10', 'a scoped forget must not touch the other registers');

  // (ii) the deliberate hard purge.
  const hard = log(makeWall(wall.ms));
  hard.append(share);
  assert.equal(hard.forget(key, FSP, { values: 'all' }), 1);
  assert.equal(val(hard, key, 'pub.date'), null);
  assert.equal(val(hard, key, 'pub.alive'), null);
});

test('forget accepts a retraction by EITHER signal — alive:false or level:privat', () => {
  // ADR 004 §5.3's two triggers. `pub.alive:false` is a delete; `pub.level:'privat'` is an
  // un-share with the entry still alive on the owner's own board. Both are retractions.
  const mk = (patch) => {
    const wall = makeWall();
    const a = makeAuthor({ tag: 'w', wall });
    const key = familyKey('fnote', MEM_A, U1);
    const pub = (a.txn(), a.pub('fnote', MEM_A, U1,
      { 'pub.level': 'geteilt', 'pub.date': '2026-09-10', 'pub.text': 'Zahnarzt', 'pub.alive': true }, { born: true }));
    wall.advance(1000);
    const r = (a.txn(), a.pub('fnote', MEM_A, U1, patch));
    const l = log(makeWall(wall.ms));
    l.append(pub); l.append(r);
    return { l, key };
  };
  const gone = mk({ 'pub.alive': false });
  assert.equal(gone.l.forget(gone.key, FSP), 2);
  assert.equal(val(gone.l, gone.key, 'pub.date'), null);

  const unshared = mk({ 'pub.level': 'privat', 'pub.text': null });
  assert.equal(unshared.l.forget(unshared.key, FSP), 2);
  assert.equal(val(unshared.l, unshared.key, 'pub.date'), null);
  assert.equal(val(unshared.l, unshared.key, 'pub.level'), 'privat', 'the governing signal must survive');

  // A personal entity is judged on `_alive`; there is no level to fall back on.
  const wall = makeWall();
  const a = makeAuthor({ tag: 'x', wall });
  const l = log(makeWall(wall.ms));
  l.append((a.txn(), a.note(U1, { date: '2026-09-10', text: 'Zahnarzt', _alive: true }, { born: true })));
  assert.throws(() => l.forget(noteKey(U1), PSP), /still live/);
  wall.advance(1000);
  l.append((a.txn(), a.note(U1, { _alive: false })));
  assert.equal(l.forget(noteKey(U1), PSP), 2);
});

test('forget refuses an entity that does not live in that space', () => {
  // Forgetting a personal note "in the family space" would purge the wrong log — and the truth
  // is the one thing the forget pass must never touch.
  const { l, key } = publishedWorld();
  assert.throws(() => l.forget(noteKey(U1), FSP), /lives in the personal space/);
  assert.throws(() => l.forget(key, PSP), /lives in the family space/);
  assert.throws(() => l.forget('not-an-entity-key', FSP), OpLogError);
  assert.throws(() => l.forget(key, 'nonsense'), OpLogError);
  assert.throws(() => l.forget(key, FSP, { values: 'some' }), OpLogError);
});

test('forget({values:"all"}) is the hard purge, governing registers included', () => {
  const { l, key } = publishedWorld();
  l.forget(key, FSP, { values: 'all' });
  assert.equal(val(l, key, 'pub.alive'), null);
  assert.equal(val(l, key, 'pub.level'), null);
  assert.notEqual(stampOf(l, key, 'pub.alive'), null, 'even a hard purge retains stamps');
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. Introspection and housekeeping
// ═════════════════════════════════════════════════════════════════════════════

test('stats() reports live, parked, seen and entity counts', () => {
  const { ops, wall } = buildStream();
  const l = log(makeWall(wall.ms));
  for (const op of ops) l.append(op);
  const a = makeAuthor({ tag: 'a', wall });
  l.append(skewed((a.txn(), a.note(U1, { date: '2026-09-10' })), { k: 'reminder.set' }));
  const s = l.stats();
  assert.equal(s.live, ops.length);
  assert.equal(s.parked, 1);
  assert.equal(s.seen, ops.length + 1);
  assert.equal(s.entities, l.registers().size);
  assert.ok(s.entities >= 4);
});

test('a compacted opId is still deduped in-session', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const op = (a.txn(), a.note(U1, { date: '2026-09-10' }));
  l.append(op);
  l.compact();
  assert.equal(l.size, 0);
  assert.equal(l.append(op).status, APPEND.DUPLICATE);
  assert.equal(l.size, 0, 'a compacted op was re-added as a new line');
});

test('re-appending a compacted op after a cold start is CORRECT, just not free', () => {
  // Dedupe is a performance optimisation only (ADR 001 §6). Correctness may never depend on it.
  const wall = makeWall();
  const a = makeAuthor({ tag: 'a', wall });
  a.txn();
  const ops = [a.note(U1, { date: '2026-09-10', text: 'Zahnarzt' }), a.note(U2, { date: '2026-09-11' })];
  const warm = log(makeWall(wall.ms));
  for (const op of ops) warm.append(op);
  warm.compact();
  const cold = log(makeWall(wall.ms));
  cold.load({ checkpoint: JSON.parse(JSON.stringify(warm.checkpoint())), tail: [] });
  for (const op of ops) assert.equal(cold.append(op).status, APPEND.APPENDED);
  assert.equal(snap(cold), snap(warm), 're-folding a compacted op changed the state');
});

test('registersCopy() is detached from the log', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  l.append((a.txn(), a.note(U1, { date: '2026-09-10' })));
  const copy = l.registersCopy();
  copy.get(noteKey(U1)).set('date', { value: 'vandalised', stamp: ZERO_STAMP, author: MEM_B });
  assert.equal(val(l, noteKey(U1), 'date'), '2026-09-10');
});

test('the register cache is invalidated by every mutation', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const first = (a.txn(), a.note(U1, { text: 'eins' }));
  l.append(first);
  assert.equal(val(l, noteKey(U1), 'text'), 'eins');
  wall.advance(10);
  l.append((a.txn(), a.note(U1, { text: 'zwei' })));
  assert.equal(val(l, noteKey(U1), 'text'), 'zwei', 'a stale cache was served after an append');
  l.park(l.get(first.id), PARK_REASONS.EPOCH);
  assert.equal(val(l, noteKey(U1), 'text'), 'zwei');
  l.compact();
  assert.equal(val(l, noteKey(U1), 'text'), 'zwei');
});

test('a pref.set op with a null gid round-trips through the log', () => {
  // Rule U6: pref.set carries no gid and is never undone. It is still a normal log line.
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  const op = a.pref({ lastCategoryId: 'cat-1' });
  assert.equal(op.gid, null);
  assert.equal(l.append(op).status, APPEND.APPENDED);
  assert.equal(val(l, PREF_KEY, 'lastCategoryId'), 'cat-1');
  assert.equal(l.append(op).status, APPEND.DUPLICATE);
});

test('every op kind the vocabulary defines can be logged and folded', () => {
  const wall = makeWall();
  const l = log(wall);
  const a = makeAuthor({ tag: 'a', wall });
  a.txn();
  const ops = [
    a.note(U1, { date: '2026-09-10' }),
    makeOp(a.ctx, 'bar.set', 'bar:b1', { startDate: '2026-09-01', endDate: '2026-09-08' }),
    a.cat('cat-1', { name: 'Familie' }),
    makeOp(a.ctx, 'pad.set', 'pad:2026-09', { text: 'Notizen' }),
    a.pref({ density: 'compact' }),
    a.pub('fnote', MEM_A, U1, { 'pub.level': 'belegt' }),
    makeOp(a.ctx, 'member.set', `member:${MEM_B}`, { displayName: 'Mama' }),
    makeOp(a.ctx, 'space.set', `space:${FSP}`, { admin: MEM_A, epoch: 1 }),
  ];
  for (const op of ops) assert.equal(l.append(op).status, APPEND.APPENDED, `${op.k} was not admitted`);
  assert.equal(l.registers().size, 8);
});
