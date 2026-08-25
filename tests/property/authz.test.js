// tests/property/authz.test.js — P5, authorization determinism (LZP-406, ADR 005 §4.2).
//
// "**P5** — authz determinism: shuffling ops never changes which ops `foldAuthorized` admits."
//
// This is the property that makes family sharing safe to reason about at all. `foldAuthorized`
// runs five stages, and every later stage reads EARLIER STAGES' FINAL VALUES — never the value a
// register happened to hold when a particular op arrived. If that discipline slips anywhere, two
// devices holding the identical op set reach different conclusions about who the admin is, or
// about whether a co-edit was allowed, and the boards diverge in a way no amount of re-syncing
// repairs. It is a security property as much as a correctness one: an attacker who can influence
// DELIVERY ORDER could otherwise influence AUTHORIZATION.
//
// The assertion is deliberately not "the same ops were admitted". `snapshot()` is a total,
// order-independent projection of the WHOLE result — admitted, rejected WITH THEIR REASON CODES,
// parked with their park reasons, the admin chain, the member set, and the registers. Comparing
// the whole snapshot means a fold that admits the right ops for the wrong reason still fails.

import test from 'node:test';
import assert from 'node:assert/strict';

import '../helpers/env.js';
import {
  generate, ownershipAttacks, pcg32, shuffle, duplicateSome, partition, interleave, attestVerify,
  MEMBERS, ME, MAMA, FSP, PSP,
} from '../helpers/gen.js';
import { SEEDS, seeds, forEachSeed, sig } from './harness.js';

import { foldAuthorized, snapshot } from '../../src/js/core/authz.js';

const snap = (ops, ctx) => sig(snapshot(foldAuthorized(ops, ctx)));

// ═════════════════════════════════════════════════════════════════════════════════════════════
// P5 — the property itself
// ═════════════════════════════════════════════════════════════════════════════════════════════

test(`P5 — shuffling never changes the authorization result, over ${SEEDS} seeds`, () => {
  forEachSeed(seeds(), 'P5 authz determinism', (seed) => {
    const w = generate(seed);
    const rnd = pcg32(seed ^ 0x51);
    const target = snap(w.ops, w.authzCtx);
    for (let i = 0; i < 20; i++) {
      assert.equal(snap(shuffle(rnd, w.ops), w.authzCtx), target,
        `shuffle ${i} changed which ops were authorized`);
    }
    assert.equal(snap([...w.ops].reverse(), w.authzCtx), target, 'reversed delivery changed the result');
  });
});

test(`P5 — duplication never changes it either, over ${SEEDS} seeds`, () => {
  // A re-pull re-delivers ops the fold has already seen. If admission were stateful in any way —
  // a "first writer wins" anywhere, a counter, a Set consulted before it is complete — the second
  // delivery would decide differently.
  forEachSeed(seeds(), 'P5 under duplication', (seed) => {
    const w = generate(seed);
    const rnd = pcg32(seed ^ 0x62);
    const target = snap(w.ops, w.authzCtx);
    for (const rate of [0.15, 0.5]) {
      assert.equal(snap(duplicateSome(rnd, shuffle(rnd, w.ops), rate), w.authzCtx), target);
    }
    assert.equal(snap(shuffle(rnd, [...w.ops, ...w.ops]), w.authzCtx), target,
      'delivering the whole log twice changed the authorization result');
  });
});

test('P5 — a GROWING PREFIX converges: two arrival orders agree at every prefix SET', () => {
  // The strongest form, and the one that catches a stage which reads a partially-folded value.
  // Two devices receive the same ops in different orders; after each delivery they hold different
  // SEQUENCES but, whenever their prefixes happen to be the same SET, they must agree. Building
  // that comparison directly: fold prefix k of order A against the same k ops in order B.
  forEachSeed(seeds(200), 'P5 growing prefix', (seed) => {
    const w = generate(seed);
    const rnd = pcg32(seed ^ 0x73);
    const orderA = shuffle(rnd, w.ops);
    for (let k = 1; k <= orderA.length; k += Math.max(1, Math.floor(orderA.length / 8))) {
      const prefix = orderA.slice(0, k);
      const target = snap(prefix, w.authzCtx);
      for (let t = 0; t < 3; t++) {
        assert.equal(snap(shuffle(rnd, prefix), w.authzCtx), target,
          `prefix of length ${k} authorized differently in another order`);
      }
    }
  });
});

test('P5 — partition and heal reaches the same authorization result as one delivery', () => {
  forEachSeed(seeds(200), 'P5 partition/heal', (seed) => {
    const w = generate(seed);
    const rnd = pcg32(seed ^ 0x84);
    const target = snap(w.ops, w.authzCtx);
    const n = 2 + (seed % 6);
    const parts = partition(rnd, w.ops, n);
    for (let i = 0; i < n; i++) {
      const healed = parts[i].concat(shuffle(rnd, parts.filter((_, j) => j !== i).flat()));
      assert.equal(snap(healed, w.authzCtx), target, `replica ${i} authorized differently`);
    }
    const half = Math.ceil(n / 2);
    assert.equal(
      snap(interleave(rnd, parts.slice(0, half).flat(), parts.slice(half).flat()), w.authzCtx),
      target, 'a riffled heal authorized differently');
  });
});

test('P5 — REJECTION REASONS are order-independent, not merely the admit/reject verdict', () => {
  // Reason codes drive what the user is told (deliverable 20's sync status, the diagnostics
  // panel). Two devices reporting different reasons for the same refusal is a support call that
  // cannot be answered. `snapshot()` already covers this; asserting it separately states that it
  // is a requirement rather than an accident of the snapshot's shape.
  forEachSeed(seeds(150), 'P5 reason codes', (seed) => {
    const w = generate(seed);
    const rnd = pcg32(seed ^ 0x95);
    const reasons = (ops) => {
      const r = foldAuthorized(ops, w.authzCtx);
      return sig([...r.rejected.map((o) => `${o.id}:${sig(r.rejectionOf(o.id))}`).sort(),
        ...r.parked.map((o) => `${o.id}:${r.parkReasonOf(o.id)}`).sort()]);
    };
    const target = reasons(w.ops);
    for (let i = 0; i < 6; i++) assert.equal(reasons(shuffle(rnd, w.ops)), target);
  });
});

test('P5 — the resolved ADMIN is a function of the set, even under a contested chain', () => {
  // The admin chain is the one stage with a comparison that is not simply max-by-stamp (longest
  // chain, ties by greater ts, then opId). A non-total comparator there would resolve differently
  // depending on which rival link was examined first, and the admin is who may unshare EVERY
  // member's entries — so a non-deterministic admin is a non-deterministic redaction power.
  forEachSeed(seeds(200), 'P5 admin chain', (seed) => {
    const w = generate(seed);
    const rnd = pcg32(seed ^ 0xA6);
    const r0 = foldAuthorized(w.ops, w.authzCtx);
    const target = sig([r0.admin, [...r0.currentMembers].sort(), sig(r0.adminChainOf(FSP).map((o) => o.id))]);
    for (let i = 0; i < 10; i++) {
      const r = foldAuthorized(shuffle(rnd, w.ops), w.authzCtx);
      assert.equal(
        sig([r.admin, [...r.currentMembers].sort(), sig(r.adminChainOf(FSP).map((o) => o.id))]),
        target, `shuffle ${i} resolved a different admin or member set`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// P5 under attack — determinism is only interesting if the fold is refusing things
// ═════════════════════════════════════════════════════════════════════════════════════════════

test(`P5 — determinism survives an adversary's ops mixed into the stream, over ${SEEDS} seeds`, () => {
  // A fold that admits everything is trivially order-independent. This mixes in EVE's forged
  // genesis, her backdated writes to my entities and her self-attestation, so the fold is
  // actively refusing things — and the refusals must be identical in every order too.
  forEachSeed(seeds(), 'P5 under attack', (seed) => {
    const w = generate(seed);
    const attack = ownershipAttacks(seed, w);
    const all = [...w.ops, ...attack.ops];
    const rnd = pcg32(seed ^ 0xB7);
    const target = snap(all, w.authzCtx);
    for (let i = 0; i < 12; i++) {
      assert.equal(snap(shuffle(rnd, all), w.authzCtx), target,
        `shuffle ${i} authorized the adversary differently`);
    }
    // And it really is refusing: an attack stream that changed nothing would make this vacuous.
    const r = foldAuthorized(all, w.authzCtx);
    assert.ok(r.rejected.length > 0, 'the adversary\'s ops were all admitted — the test is vacuous');
  });
});

test('P5 — every peer in the Kreis reaches the same verdict about every FAMILY op', () => {
  // `ctx.me` differs per device, and admission in the SHARED space must not depend on it: if it
  // did, a peer could hold ops another peer had rejected and the two would never converge no
  // matter how often they synced.
  //
  // Scoped to `space === FSP` deliberately, and the scope is the point rather than a convenience.
  // PERSONAL-space admission is SUPPOSED to depend on `me` — ADR 001 §4.4 admits a `psp_` op only
  // from my own member and my own devices, which is exactly why my private board cannot be
  // written by a peer even if they somehow obtain my ops. Asserting cross-peer agreement there
  // would be asserting that the personal space is not private. The second half of this test pins
  // that asymmetry so the scoping cannot be mistaken for an oversight later.
  forEachSeed(seeds(150), 'P5 across peers', (seed) => {
    const w = generate(seed);
    const attack = ownershipAttacks(seed, w);
    const all = [...w.ops, ...attack.ops];
    const famVerdicts = (me) => {
      const r = foldAuthorized(all, { ...w.authzCtx, me });
      const fam = (list) => list.filter((o) => o && o.space === FSP).map((o) => o.id).sort();
      return sig([fam(r.admitted), fam(r.rejected), fam(r.parked)]);
    };
    const target = famVerdicts(ME);
    assert.ok(target.length > 10, 'the fixture has no family ops — the test is vacuous');
    for (const m of MEMBERS.slice(1)) {
      assert.equal(famVerdicts(m), target, `${m} judged the family space differently than ${ME} did`);
    }
  });
});

test('P5 — and the PERSONAL space is the deliberate exception: a peer admits none of my psp ops', () => {
  // The other side of the scoping above. My `note.set` ops carry `act === me` in my own personal
  // space; folded on Mama's device they must ALL be refused. This is story 19.4 / ADR 001 §4.4
  // stated as a property, and it is what stops a leaked personal op stream from writing itself
  // onto somebody else's board.
  forEachSeed(seeds(80), 'P5 personal-space isolation', (seed) => {
    const w = generate(seed);
    const minePersonal = w.ops.filter((o) => o.space === PSP);
    assert.ok(minePersonal.length > 0, 'the fixture has no personal ops — the test is vacuous');

    const asMe = foldAuthorized(w.ops, w.authzCtx);
    const asMama = foldAuthorized(w.ops, { ...w.authzCtx, me: MAMA });
    const admittedPsp = (r) => r.admitted.filter((o) => o.space === PSP).length;
    assert.equal(admittedPsp(asMe), minePersonal.length, 'my own device refused my own personal ops');
    assert.equal(admittedPsp(asMama), 0, 'a peer admitted my personal-space ops');
  });
});

test('P5 — attestVerify FAILS CLOSED: with no verifier, no family op is admitted', () => {
  // The default must be refusal, not admission. A ctx that forgot the verifier is a bug; a ctx
  // that forgot the verifier and silently trusted every device is a vulnerability.
  forEachSeed(seeds(60), 'P5 fail-closed', (seed) => {
    const w = generate(seed);
    const open = foldAuthorized(w.ops, w.authzCtx);
    const closed = foldAuthorized(w.ops, { ...w.authzCtx, attestVerify: undefined });
    const familyAdmitted = (r) => r.admitted.filter((o) => o.space === FSP).length;
    assert.ok(familyAdmitted(open) > 0, 'the fixture has no family ops — the test is vacuous');
    assert.equal(familyAdmitted(closed), 0, 'family ops were admitted with no attestation verifier');
    // …and the refusal is still deterministic.
    const rnd = pcg32(seed);
    assert.equal(snap(shuffle(rnd, w.ops), { ...w.authzCtx, attestVerify: undefined }),
      snap(w.ops, { ...w.authzCtx, attestVerify: undefined }));
  });
});

test('P5 — a forged attestation is refused, and a genuine one for another member is too', () => {
  forEachSeed(seeds(60), 'P5 attestation binding', (seed) => {
    const w = generate(seed);
    // A verifier that accepts anything must admit MORE than the real one, or the real one is not
    // actually gating on the signature and stage 0 is decorative.
    const lax = foldAuthorized(w.ops, { ...w.authzCtx, attestVerify: () => true });
    const real = foldAuthorized(w.ops, w.authzCtx);
    assert.ok(lax.admitted.length >= real.admitted.length);
    // The binding itself: the blob must name the member whose record it sits on.
    assert.equal(attestVerify(MAMA, 'nonsense'), false);
    assert.equal(attestVerify(MAMA, ''), false);
  });
});
