// tests/tier1/core-authz.test.js — the staged authorization fold.
// ADR 001 §4, §6, §12.3 · ADR 002 §2.3, §5.1, §5.2 · ADR 004 §5, §8 · ops.contract.js §4.
//
// WHAT THIS FILE IS PROTECTING, in the order it matters.
//
//  1. ORDER-INDEPENDENCE (property P5). `foldAuthorized` must admit exactly the same ops for the
//     same SET of ops, whatever order they arrive in, however often they are re-delivered, and
//     whichever subset a partition happened to deliver first. This is not a nicety: if
//     admissibility depended on arrival order, two devices holding identical op sets would
//     render different boards, and every convergence claim in ADR 001 §6 would be false. The
//     assertion vehicle is `snapshot()`, a fully ordered rendering of the whole result, compared
//     with deep-equal — so a difference in ONE rejected op's reason code fails the test.
//
//  2. STRUCTURAL OWNERSHIP (risk R10, ADR 001 §4.4). Every reviewed v2 design resolved ownership
//     as "the author of the smallest-stamp write". Stamps have no lower bound, so one line of
//     modified client emitting a backdated owner write at `ms = 0` would have taken over any
//     entity in the family. The adversarial tests here run exactly that attack — at `ms = 0`, at
//     `ctr = 0`, with a forged genesis, with a forged member record, in 100 shuffles — and
//     assert that no register on my entity is ever authored by anybody else.
//
//  3. THE ADMIN CHAIN LIVES IN THE LOG, NOT ON THE SERVER (ADR 001 §4.1, §12.4). A compromised
//     relay that could rewrite a role table could flip the validity of an admin unshare and make
//     previously-hidden content reappear on every family board. So the chain is resolved from
//     `space.set{admin, adminPrev}` alone, and a forged claim must lose in EVERY order.
//
//  4. CO-EDIT IS READ FROM `pub.coEdit`, NEVER FROM A TRUTH REGISTER (ADR 001 §4.3, ADR 004 §8).
//     A peer does not have my `coEdit` truth field and could never evaluate it. If the predicate
//     ever reads a truth register, the fold becomes unevaluable on exactly the machines that
//     must evaluate it — so the test asserts that the truth registers are absent and the
//     decision still comes out right.
//
// NO TEST READS THE WALL CLOCK (ADR 005 §5). Every stamp is a literal, every id is a counter.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  foldAuthorized, snapshot, AuthzError, STAGES, REJECT_REASONS, isRejectReason,
  parseAttestationBlob, unsharePatch, isAdminUnsharePatch, classifyUnsharePatch, registerOf, registerValue,
} from '../../src/js/core/authz.js';

import { fmt, cmp } from '../../src/js/core/stamp.js';
import { createdAt, cmpWrites, applyOp, getValue } from '../../src/js/core/registers.js';
import { b64u, ub64 } from '../../src/js/core/b64.js';
import { canonicalBytes, utf8, utf8Decode } from '../../src/js/core/canon.js';
import { FIELDS, fieldsOf, fieldSpec, validateOp, PARK_REASONS } from '../../src/js/core/ops.js';
import {
  memberKey, spaceKey, noteKey, familyKey, ownerOfEntity, parseEntityKey, PREF_KEY,
} from '../../src/js/core/entities.js';

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic harness. Seeded, injected, wall-clock-free.
// ─────────────────────────────────────────────────────────────────────────────

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

function shuffled(rnd, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 22 base64url characters; `-` is in the alphabet, so it is a legal filler. */
const pad22 = (s) => (s + '----------------------').slice(0, 22);
/** 16 Crockford base32 characters; `0` is the lowest and therefore a legal filler. */
const short16 = (s) => (s + '0000000000000000').slice(0, 16);

const memId = (tag) => `mem_${pad22(tag)}`;
const devIdOf = (tag) => `dev_${pad22(tag)}`;

const ME = memId('ME');
const MAMA = memId('MAMA');
const PAPA = memId('PAPA');
const EVE = memId('EVE');                       // a genuine family member, and the attacker

const FSP = `fsp_${pad22('FAM')}`;
const FSP2 = `fsp_${pad22('FAM2')}`;
const PSP = `psp_${pad22('MINE')}`;

const D = {
  [ME]: { id: devIdOf('DME'), short: short16('DME') },
  [MAMA]: { id: devIdOf('DMAMA'), short: short16('DMAMA') },
  [PAPA]: { id: devIdOf('DPAPA'), short: short16('DPAPA') },
  [EVE]: { id: devIdOf('DEVE'), short: short16('DEVE') },
};
const ME_LAPTOP = { id: devIdOf('DME2'), short: short16('DME2') };

const U1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const U2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const BASE = 1787836800000;                     // a fixed wall-clock millisecond. Never Date.now.
const S = (ms, ctr, dev) => fmt(ms, ctr, dev);

let seq = 0;
const rid = (tag) => pad22(`${tag}${++seq}`);
/** Reset before any fixture whose op ids must be stable across two constructions. */
const resetIds = () => { seq = 0; };

/**
 * The `dev.*` register value ADR 002 §2.3 fixes:
 *   b64u(canonicalJSON(attestation)) + '.' + b64u(signature)
 * The "signature" here is a byte string a test verifier can check without WebCrypto — the point
 * of the test is the BINDING (payload names the member and the device), not the primitive.
 */
function attBlob({ memberId, deviceId, deviceShort, sigOver = null }) {
  const att = {
    memberId,
    deviceId,
    deviceShort,
    sigPubRaw: b64u(utf8(`sigpub:${deviceId}`)),
    kexPubRaw: b64u(utf8(`kexpub:${deviceId}`)),
    createdAt: '2026-08-25',
  };
  const signed = sigOver ?? `sig:${memberId}:${deviceId}`;
  return `${b64u(canonicalBytes(att))}.${b64u(utf8(signed))}`;
}

/** Stands in for `crypto/identity.js:verifyAttestation` — checks the signature binds the payload. */
function verifier(memberId, blob) {
  const dot = blob.indexOf('.');
  if (dot < 0) return false;
  try {
    const att = JSON.parse(utf8Decode(ub64(blob.slice(0, dot))));
    const sig = utf8Decode(ub64(blob.slice(dot + 1)));
    return att.memberId === memberId && sig === `sig:${att.memberId}:${att.deviceId}`;
  } catch {
    return false;
  }
}

/** Build one op, and refuse to build an invalid one — a test fixture must not smuggle junk in. */
function mk(k, e, f, o) {
  const op = {
    v: 1,
    id: o.id ?? rid('op'),
    ts: o.ts,
    space: o.space,
    act: o.act,
    dev: o.dev,
    gid: k === 'pref.set' ? null : (o.gid ?? rid('g')),
    k,
    e,
    f,
  };
  const v = validateOp(op);
  if (!v.ok) throw new Error(`test fixture built an invalid op: ${v.reason}`);
  Object.freeze(op.f);
  return Object.freeze(op);
}

const attestOp = (m, dev, ts, extra = {}) =>
  mk('member.set', memberKey(m), {
    [`dev.${extra.regShort ?? dev.short}`]: attBlob({
      memberId: extra.blobMember ?? m,
      deviceId: dev.id,
      deviceShort: extra.blobShort ?? dev.short,
      sigOver: extra.sigOver ?? null,
    }),
  }, { act: extra.act ?? m, dev: extra.dev ?? dev.id, ts, space: extra.space ?? FSP });

const memberOp = (m, f, ts, o = {}) =>
  mk('member.set', memberKey(m), f, {
    act: o.act ?? m, dev: o.dev ?? D[o.act ?? m].id, ts, space: o.space ?? FSP, id: o.id, gid: o.gid,
  });

const spaceOp = (f, ts, o) =>
  mk('space.set', spaceKey(o.spaceId ?? FSP), f, {
    act: o.act, dev: o.dev ?? D[o.act].id, ts, space: o.space ?? o.spaceId ?? FSP, id: o.id, gid: o.gid,
  });

const pubOp = (kind, owner, uuid, f, ts, o) =>
  mk('pub.set', familyKey(kind, owner, uuid), f, {
    act: o.act, dev: o.dev ?? D[o.act].id, ts, space: o.space ?? FSP, id: o.id, gid: o.gid,
  });

const noteOp = (uuid, f, ts, o = {}) =>
  mk('note.set', noteKey(uuid), f, {
    act: o.act ?? ME, dev: o.dev ?? D[ME].id, ts, space: o.space ?? PSP, id: o.id, gid: o.gid,
  });

/** The standard ctx: me, a verifier, no wall clock armed unless a test arms it. */
const CTX = (over = {}) => ({ me: ME, attestVerify: verifier, ...over });

/**
 * A family: three attested members, ME is the genesis admin. Deterministic op ids, so two
 * constructions of the same fixture are byte-identical and shuffles are reproducible.
 */
function family({ members = [ME, MAMA, PAPA], admin = ME, genesisId = 'GEN' } = {}) {
  resetIds();
  const ops = [];
  members.forEach((m, i) => {
    ops.push(attestOp(m, D[m], S(BASE + i, 0, D[m].short)));
    ops.push(memberOp(m, { displayName: m.slice(4, 8), _alive: true }, S(BASE + i, 1, D[m].short)));
  });
  const gen = spaceOp({ admin, adminPrev: null, name: 'Familie' }, S(BASE + 10, 0, D[admin].short),
    { act: admin, id: pad22(genesisId) });
  ops.push(gen);
  return { ops, genesis: gen };
}

/** Ids of the ops `foldAuthorized` admitted, sorted — the thing P5 is really about. */
const admittedIds = (r) => r.admitted.map((o) => o.id).sort();
const reason = (r, op) => (r.rejectionOf(op.id) || {}).reason ?? null;

/** Fold the same SET in `n` different orders and return every snapshot. */
function foldShuffles(ops, ctx, n = 60, seed = 20260825) {
  const rnd = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) out.push(snapshot(foldAuthorized(shuffled(rnd, ops), ctx)));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The contract surface
// ─────────────────────────────────────────────────────────────────────────────

test('foldAuthorized returns every field ops.contract.js §4 declares', () => {
  const { ops } = family();
  const r = foldAuthorized(ops, CTX());
  for (const k of ['regs', 'admin', 'adminAt', 'currentMembers', 'rejected', 'parked']) {
    assert.ok(k in r, `AuthzResult is missing ${k}`);
  }
  assert.ok(r.regs instanceof Map);
  assert.ok(r.currentMembers instanceof Set);
  assert.ok(Array.isArray(r.rejected) && Array.isArray(r.parked));
  assert.equal(typeof r.adminAt, 'function');
  assert.equal(r.admin, ME);
});

test('ctx.me is required and is not guessed', () => {
  const { ops } = family();
  assert.throws(() => foldAuthorized(ops, {}), AuthzError);
  assert.throws(() => foldAuthorized(ops, { me: 'not-a-member' }), AuthzError);
  assert.throws(() => foldAuthorized(ops, null), AuthzError);
  assert.throws(() => foldAuthorized(ops, CTX({ nowMs: 'soon' })), AuthzError);
});

test('the reason codes are a closed, unique set', () => {
  const values = Object.values(REJECT_REASONS);
  assert.equal(new Set(values).size, values.length, 'two reason codes collide');
  for (const v of values) assert.ok(isRejectReason(v), `${v} is not recognised`);
  assert.equal(isRejectReason('somethingElse'), false);
  assert.deepEqual(STAGES, ['attestation', 'adminChain', 'membership', 'content']);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The register join — LWW, write-once, and the tiebreak that must not be arrival order
// ─────────────────────────────────────────────────────────────────────────────

test('per-field max-by-stamp: the greater stamp wins, in either arrival order', () => {
  const a = noteOp(U1, { text: 'alt' }, S(BASE, 0, D[ME].short));
  const b = noteOp(U1, { text: 'neu' }, S(BASE + 1, 0, D[ME].short));
  const fwd = foldAuthorized([a, b], CTX());
  const rev = foldAuthorized([b, a], CTX());
  assert.equal(registerValue(fwd.regs, noteKey(U1), 'text'), 'neu');
  assert.equal(registerValue(rev.regs, noteKey(U1), 'text'), 'neu');
  assert.deepEqual(snapshot(fwd), snapshot(rev));
});

test('delete racing an edit converges to "dead, with an unread new text" (ADR 001 §6)', () => {
  const del = noteOp(U1, { _alive: false }, S(BASE, 0, D[ME].short));
  const edit = noteOp(U1, { text: 'spaeter' }, S(BASE + 5, 0, D[ME].short));
  const r = foldAuthorized([edit, del], CTX());
  assert.equal(registerValue(r.regs, noteKey(U1), '_alive'), false);
  assert.equal(registerValue(r.regs, noteKey(U1), 'text'), 'spaeter');
  assert.deepEqual(snapshot(foldAuthorized([del, edit], CTX())), snapshot(r));
});

test('`_born` writeOnce is NOT enforced by the join — createdAt survives it anyway', () => {
  // `FIELDS.note._born` is marked `writeOnce`, and `registers.js` joins it with plain
  // max-by-stamp like every other field. Reported as a gap in `registers.js`; it is not closed
  // here because `_born` rides inside ops that also carry content, so refusing the op would drop
  // a legitimate write and stripping the field would make ops non-atomic.
  //
  // What matters downstream still holds: `createdAt` is the MIN stamp over ALL of an entity's
  // registers (ADR 001 §1.4), so it does not move when the `_born` register does, and only the
  // entity's own owner can write it at all. This test is a characterization, not an endorsement.
  const born = noteOp(U1, { _born: S(BASE, 0, D[ME].short), text: 'da' }, S(BASE, 0, D[ME].short));
  const later = noteOp(U1, { _born: S(BASE + 999, 0, D[ME].short) }, S(BASE + 999, 0, D[ME].short));
  const r = foldAuthorized([born, later], CTX());
  assert.equal(registerValue(r.regs, noteKey(U1), '_born'), S(BASE + 999, 0, D[ME].short),
    'if this flips, registers.js started honouring writeOnce — update the note');
  assert.equal(createdAt(r.regs, noteKey(U1)), S(BASE, 0, D[ME].short), 'createdAt did not move');
  assert.deepEqual(snapshot(foldAuthorized([later, born], CTX())), snapshot(r));
});

test('a `dev.*` attestation register cannot be replaced by a later one (ADR 002 §2.3)', () => {
  // The key-injection attack: a member replaces their own attested key material with a
  // relay-supplied one at a greater stamp. Write-once means the first blob is the only blob.
  const first = attestOp(MAMA, D[MAMA], S(BASE, 0, D[MAMA].short));
  const swap = mk('member.set', memberKey(MAMA), {
    [`dev.${D[MAMA].short}`]: attBlob({ memberId: MAMA, deviceId: devIdOf('EVIL'), deviceShort: D[MAMA].short }),
  }, { act: MAMA, dev: D[MAMA].id, ts: S(BASE + 9999, 0, D[MAMA].short), space: FSP });
  const r = foldAuthorized([first, swap], CTX());
  const held = parseAttestationBlob(registerValue(r.regs, memberKey(MAMA), `dev.${D[MAMA].short}`));
  assert.equal(held.deviceId, D[MAMA].id, 'the later attestation overwrote the first');
  assert.equal(reason(r, swap), REJECT_REASONS.WRITE_ONCE, 'the second claim is REJECTED, not silently outvoted');
  assert.equal(r.memberOfDevice(devIdOf('EVIL')), null);
  assert.deepEqual(snapshot(foldAuthorized([swap, first], CTX())), snapshot(r));
});

test('write-once on dev.* is minimal-under-`≺`, so it survives a backdated rival too', () => {
  // The mirror attack: instead of a LATER blob, an EARLIER one. Whichever direction, the answer
  // must be the same on every device — the minimum of a total order, not "whatever arrived".
  const real = attestOp(MAMA, D[MAMA], S(BASE + 500, 0, D[MAMA].short));
  const backdated = mk('member.set', memberKey(MAMA), {
    [`dev.${D[MAMA].short}`]: attBlob({ memberId: MAMA, deviceId: devIdOf('EVIL'), deviceShort: D[MAMA].short }),
  }, { act: MAMA, dev: D[MAMA].id, ts: S(0, 0, '0000000000000000'), space: FSP });
  const r = foldAuthorized([real, backdated], CTX());
  assert.equal(reason(r, real), REJECT_REASONS.WRITE_ONCE, 'the earlier claim is the one that stands');
  assert.equal(r.memberOfDevice(devIdOf('EVIL')), MAMA, 'characterizing: earliest wins, whoever wrote it');
  assert.equal(r.memberOfDevice(D[MAMA].id), null);
  assert.deepEqual(snapshot(foldAuthorized([backdated, real], CTX())), snapshot(r));
});

test('two different writes at the SAME stamp resolve content-addressably, not by arrival', () => {
  // Only forgery or corruption produces this (ADR 001 §6.1 calls the tiebreak "unreachable"),
  // and an unreachable branch that is not deterministic is a divergence waiting for an attacker.
  const ts = S(BASE, 3, D[ME].short);
  const x = noteOp(U1, { text: 'xxx' }, ts);
  const y = noteOp(U1, { text: 'yyy' }, ts);
  const fwd = foldAuthorized([x, y], CTX());
  const rev = foldAuthorized([y, x], CTX());
  assert.equal(registerValue(fwd.regs, noteKey(U1), 'text'), registerValue(rev.regs, noteKey(U1), 'text'));
  // `registers.js` breaks the tie on the opId, then on the value. Both are properties of the
  // WRITES, so both devices reach the same answer without consulting arrival order.
  const winner = cmpWrites({ stamp: ts, op: x.id, value: 'xxx' }, { stamp: ts, op: y.id, value: 'yyy' }) > 0 ? 'xxx' : 'yyy';
  assert.equal(registerValue(fwd.regs, noteKey(U1), 'text'), winner);
});

test('duplicate delivery is idempotent, and is not an error condition', () => {
  const { ops } = family();
  const once = snapshot(foldAuthorized(ops, CTX()));
  const thrice = snapshot(foldAuthorized([...ops, ...ops, ...ops], CTX()));
  assert.deepEqual(thrice, once);
  assert.deepEqual(thrice.splicedIds, []);
});

test('two DIFFERENT bodies under one opId are envelope splicing, and are reported', () => {
  // ADR 002 §5.1: "the relay rewrites the outer idempotency key to make one op look like two, or
  // to suppress a delete by colliding its id". Whichever body every device picks, they must all
  // pick the SAME one.
  const id = pad22('COLLIDE');
  const a = noteOp(U1, { text: 'aaa' }, S(BASE, 0, D[ME].short), { id });
  const b = noteOp(U1, { text: 'bbb' }, S(BASE, 1, D[ME].short), { id });
  const fwd = foldAuthorized([a, b], CTX());
  const rev = foldAuthorized([b, a], CTX());
  assert.deepEqual(snapshot(fwd), snapshot(rev));
  assert.deepEqual(fwd.splicedIds, [id]);
  assert.equal(fwd.admitted.length, 1, 'a spliced id must not become two admitted ops');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Stage 0 — device attestation
// ─────────────────────────────────────────────────────────────────────────────

test('solo mode: my own personal ops are admitted with no attestation register anywhere', () => {
  // R11 / A4: a board with no family must not be empty. If the device gate demanded an
  // attestation the personal space could never be read before a family existed.
  const ops = [
    noteOp(U1, { _born: S(0, 0, '0000000000000000'), date: '2026-09-10', text: 'Zahnarzt', _alive: true }, S(0, 0, '0000000000000000')),
    noteOp(U2, { date: '2026-09-11', text: 'Sport' }, S(BASE, 0, D[ME].short)),
  ];
  const r = foldAuthorized(ops, CTX({ nowMs: BASE }));
  assert.equal(r.admitted.length, 2);
  assert.deepEqual(r.rejected, []);
  assert.equal(registerValue(r.regs, noteKey(U1), 'text'), 'Zahnarzt');
});

test('a personal op authored by someone who is not me is rejected', () => {
  const foreign = mk('note.set', noteKey(U1), { text: 'nicht meins' },
    { act: MAMA, dev: D[MAMA].id, ts: S(BASE, 0, D[MAMA].short), space: PSP });
  const r = foldAuthorized([foreign], CTX());
  assert.equal(r.admitted.length, 0);
  assert.equal(reason(r, foreign), REJECT_REASONS.NOT_MY_ACT);
});

test('ctx.myDevices, when known, is the local device set §4.0 asks for', () => {
  const mine = noteOp(U1, { text: 'a' }, S(BASE, 0, D[ME].short));
  const stolen = noteOp(U1, { text: 'b' }, S(BASE + 1, 0, ME_LAPTOP.short), { dev: devIdOf('UNKNOWN') });
  const r = foldAuthorized([mine, stolen], CTX({ myDevices: new Set([D[ME].id]) }));
  assert.equal(reason(r, stolen), REJECT_REASONS.NOT_MY_DEVICE);
  assert.equal(registerValue(r.regs, noteKey(U1), 'text'), 'a');
  // Without the set, the check degrades to `act === me` — documented, and asserted so nobody
  // assumes the strict behaviour is the default.
  const lax = foldAuthorized([mine, stolen], CTX());
  assert.equal(registerValue(lax.regs, noteKey(U1), 'text'), 'b');
});

test('a family op from an unattested device is rejected', () => {
  const { ops } = family({ members: [ME] });
  const stranger = memberOp(EVE, { displayName: 'Eve' }, S(BASE + 20, 0, D[EVE].short), { act: EVE, dev: D[EVE].id });
  const r = foldAuthorized([...ops, stranger], CTX());
  assert.equal(reason(r, stranger), REJECT_REASONS.UNATTESTED_DEVICE);
  assert.equal(r.regs.has(memberKey(EVE)), false);
});

test('with no attestVerify the fold fails closed — every family op is rejected', () => {
  const { ops } = family();
  const r = foldAuthorized(ops, { me: ME });
  assert.equal(r.admitted.length, 0);
  assert.equal(r.admin, null);
  assert.deepEqual([...r.currentMembers], []);
  assert.ok(r.rejected.length >= ops.length - 1);
});

test('an attestation for somebody else\'s member record is rejected', () => {
  const forged = attestOp(MAMA, D[EVE], S(BASE, 0, D[EVE].short), { act: EVE, dev: D[EVE].id });
  const r = foldAuthorized([forged], CTX());
  assert.equal(reason(r, forged), REJECT_REASONS.NOT_SELF);
  assert.equal(r.memberOfDevice(D[EVE].id), null);
});

test('an attestation whose payload names another member does not verify', () => {
  const forged = attestOp(EVE, D[EVE], S(BASE, 0, D[EVE].short), { blobMember: MAMA });
  const r = foldAuthorized([forged], CTX());
  assert.equal(reason(r, forged), REJECT_REASONS.BAD_ATTESTATION);
});

test('an attestation whose payload deviceShort disagrees with its register name is rejected', () => {
  // `dev.<deviceShort>` is the register NAME; the payload restates it. If the two may disagree,
  // the register name stops being a key that binds anything.
  //
  // The disagreeing short must be a WELL-FORMED one (`XTRA` — `O` and `U` are not in the
  // Crockford alphabet, so `short16('OTHER')` is refused by `parseAttestationBlob` before this
  // predicate is ever reached, and the test would pass with the predicate deleted).
  const forged = attestOp(EVE, D[EVE], S(BASE, 0, D[EVE].short), { blobShort: short16('XTRA') });
  const r = foldAuthorized([forged], CTX());
  assert.equal(reason(r, forged), REJECT_REASONS.BAD_ATTESTATION);
});

test('an attestation with a bad signature is rejected', () => {
  const forged = attestOp(EVE, D[EVE], S(BASE, 0, D[EVE].short), { sigOver: 'sig:whatever' });
  const r = foldAuthorized([forged], CTX());
  assert.equal(reason(r, forged), REJECT_REASONS.BAD_ATTESTATION);
});

test('a member.set mixing dev.* registers with ordinary fields is refused, not half-applied', () => {
  const mixed = mk('member.set', memberKey(MAMA), {
    [`dev.${D[MAMA].short}`]: attBlob({ memberId: MAMA, deviceId: D[MAMA].id, deviceShort: D[MAMA].short }),
    displayName: 'Mama',
  }, { act: MAMA, dev: D[MAMA].id, ts: S(BASE, 0, D[MAMA].short), space: FSP });
  const r = foldAuthorized([mixed], CTX());
  assert.equal(reason(r, mixed), REJECT_REASONS.MIXED_MEMBER_PATCH);
  assert.equal(r.regs.has(memberKey(MAMA)), false, 'the dev register must not have landed either');
});

test('`deviceShort(op.dev)` is a LOOKUP over the dev.* registers, not a hash of op.dev', () => {
  // ADR 001 §1.2 defines deviceShort as a hash of the SIGNING KEY; §4.0 and ADR 002 §5.2 then
  // write `deviceShort(op.dev)` against a random `dev_` id that has no relationship to that key.
  // The only consistent reading is a lookup, and this is it.
  const { ops } = family();
  const r = foldAuthorized(ops, CTX());
  assert.equal(r.memberOfDevice(D[MAMA].id), MAMA);
  assert.equal(r.memberOfDevice(D[PAPA].id), PAPA);
  assert.equal(r.memberOfDevice(devIdOf('NOPE')), null);
  assert.deepEqual([...r.attestedDevices.get(ME)], [D[ME].id]);
});

test('one member\'s attested device does not authorise another member\'s ops', () => {
  const { ops } = family();
  const impersonation = pubOp('fnote', MAMA, U1, { 'pub.level': 'geteilt' },
    S(BASE + 30, 0, D[MAMA].short), { act: MAMA, dev: D[PAPA].id });
  const r = foldAuthorized([...ops, impersonation], CTX());
  assert.equal(reason(r, impersonation), REJECT_REASONS.UNATTESTED_DEVICE);
});

test('a second device of mine is attested by a second dev.* register on the same record', () => {
  const { ops } = family({ members: [ME] });
  const second = attestOp(ME, ME_LAPTOP, S(BASE + 3, 0, ME_LAPTOP.short));
  const fromLaptop = pubOp('fnote', ME, U1, { 'pub.level': 'belegt', 'pub.date': '2026-09-10' },
    S(BASE + 40, 0, ME_LAPTOP.short), { act: ME, dev: ME_LAPTOP.id });
  const r = foldAuthorized([...ops, second, fromLaptop], CTX());
  assert.equal(reason(r, fromLaptop), null);
  assert.deepEqual([...r.attestedDevices.get(ME)].sort(), [D[ME].id, ME_LAPTOP.id].sort());
});

test('parseAttestationBlob refuses everything that is not the ADR 002 §2.3 wire form', () => {
  const good = attBlob({ memberId: MAMA, deviceId: D[MAMA].id, deviceShort: D[MAMA].short });
  assert.equal(parseAttestationBlob(good.split('.')[0]), null, 'a payload with no signature half');
  assert.equal(parseAttestationBlob(`.${good.split('.')[1]}`), null);
  assert.equal(parseAttestationBlob(`${good.split('.')[0]}.`), null);
  assert.equal(parseAttestationBlob(null), null);
  assert.equal(parseAttestationBlob('not base64url at all!!'), null);
  assert.equal(parseAttestationBlob(`${b64u(utf8('[1,2,3]'))}.${b64u(utf8('sig'))}`), null, 'an array is not an attestation');
  assert.equal(parseAttestationBlob(`${b64u(utf8('{"memberId":"nope"}'))}.${b64u(utf8('sig'))}`), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3b. F-10 — the attestation PAYLOAD survives the fold (ADR 002 §5.2, §5.2.1, §5.2.3)
//
// `openOp` is handed `env.dv` — a deviceShort — and nothing else it can trust. Before it may
// decrypt, it must find `att.sigPubRaw` (§5.2.2 P2/P3); after it decrypts, it must bind the
// plaintext with `att.deviceId` and `att.memberId` (checks 3 and 5). The fold used to keep only
// `deviceId → memberId`, which is none of those, so `envelope.js` could not be written at all.
//
// The lookup is keyed by `deviceShort` ALONE, because `op.act` is not knowable before decrypt.
// §5.2.1 says in as many words that this is sound only while ADR 002 §2.3's four acceptance
// conditions hold, and names (3) and (4) as the two whose relaxation breaks §5.2. So each of the
// four is asserted here on its own, with the other three neutralised where that is possible —
// a test that only fires when all four are removed at once would not notice one of them going.
// ─────────────────────────────────────────────────────────────────────────────

test('F-10: the decoded attestation carries every field ADR 002 §2.3 fixes, sigPubRaw included', () => {
  // INVERTED. This assertion used to pin the defect: it deep-equalled the three-field object the
  // fold kept and the payload was discarded at the register walk. WP-6 needs all six.
  const good = attBlob({ memberId: MAMA, deviceId: D[MAMA].id, deviceShort: D[MAMA].short });
  assert.deepEqual(parseAttestationBlob(good), {
    memberId: MAMA,
    deviceId: D[MAMA].id,
    deviceShort: D[MAMA].short,
    sigPubRaw: b64u(utf8(`sigpub:${D[MAMA].id}`)),
    kexPubRaw: b64u(utf8(`kexpub:${D[MAMA].id}`)),
    createdAt: '2026-08-25',
  });
  assert.ok(Object.isFrozen(parseAttestationBlob(good)), 'the table hands out an immutable credential');
});

test('F-10: an attestation missing a field openOp needs is not a partial credential, it is none', () => {
  // `sigPubRaw` is the whole of §5.2.2 P2 and P3. Admitting a device whose blob has no signing
  // key would put a row in the table that `openOp` can only ever throw on.
  const full = {
    memberId: MAMA, deviceId: D[MAMA].id, deviceShort: D[MAMA].short,
    sigPubRaw: 'AAAA', kexPubRaw: 'BBBB', createdAt: '2026-08-25',
  };
  const blobOf = (att) => `${b64u(canonicalBytes(att))}.${b64u(utf8(`sig:${MAMA}:${D[MAMA].id}`))}`;
  const without = (k) => { const a = { ...full }; delete a[k]; return blobOf(a); };
  assert.ok(parseAttestationBlob(blobOf(full)), 'the control: all six present parses');
  assert.equal(parseAttestationBlob(without('sigPubRaw')), null, 'no sigPubRaw');
  assert.equal(parseAttestationBlob(without('kexPubRaw')), null, 'no kexPubRaw');
  assert.equal(parseAttestationBlob(without('createdAt')), null, 'no createdAt');
  assert.equal(parseAttestationBlob(blobOf({ ...full, sigPubRaw: 'not base64url!' })), null);
  assert.equal(parseAttestationBlob(blobOf({ ...full, sigPubRaw: '' })), null);
  assert.equal(parseAttestationBlob(blobOf({ ...full, sigPubRaw: 65 })), null);
  // A NEWER build's extra field is not a refusal — same version-skew discipline as the unshare
  // patch. Refusing it would make a v2.1 device unable to author ops on a v2.0 client.
  assert.ok(parseAttestationBlob(blobOf({ ...full, quantumPubRaw: 'CCCC' })), 'an unknown extra field is ignored');
});

test('F-10: attestationOf(deviceShort) is the table envelope.js is written against', () => {
  const { ops } = family();
  const r = foldAuthorized(ops, CTX());
  const att = r.attestationOf(D[MAMA].short);
  assert.equal(att.memberId, MAMA, 'check 5: att.memberId === op.act');
  assert.equal(att.deviceId, D[MAMA].id, 'check 3: att.deviceId === op.dev');
  assert.equal(att.deviceShort, D[MAMA].short);
  assert.equal(att.sigPubRaw, b64u(utf8(`sigpub:${D[MAMA].id}`)), 'P2/P3: the verification key');
  assert.equal(att.kexPubRaw, b64u(utf8(`kexpub:${D[MAMA].id}`)), '§4.2 wraps the space key to this');
  // And it is a total function on peer-supplied input: `env.dv` arrives from the wire, so a
  // lookup miss is `null`, never a throw (the door policy — external input is refused, not
  // thrown on; a throw here would take the whole pull down on one malformed envelope).
  assert.equal(r.attestationOf(short16('NOSUCH')), null);
  for (const junk of [null, undefined, 42, {}, [], '', 'not-a-short']) {
    assert.equal(r.attestationOf(junk), null, `attestationOf(${JSON.stringify(junk)}) must not throw`);
  }
});

test('F-10 condition (1): a dev.* register on somebody else\'s record never enters the table', () => {
  const forged = attestOp(MAMA, D[EVE], S(BASE, 0, D[EVE].short), { act: EVE, dev: D[EVE].id });
  const r = foldAuthorized([forged], CTX());
  assert.equal(reason(r, forged), REJECT_REASONS.NOT_SELF);
  assert.equal(r.attestationOf(D[EVE].short), null);
});

test('F-10 condition (2): the register name and att.deviceShort must agree, or the key binds nothing', () => {
  // If they may disagree, `dev.<short>` stops being a key and `attestationOf` stops being a
  // function: the same payload could be filed under any name its author liked.
  // `XTRA`, not `OTHER`: `O` and `U` are outside the Crockford alphabet, so a short built from
  // `OTHER` never survives `parseAttestationBlob` and the test would pass with condition (2)
  // deleted. A predicate is only tested by a value that reaches it.
  const forged = attestOp(EVE, D[EVE], S(BASE, 0, D[EVE].short), { blobShort: short16('XTRA') });
  const r = foldAuthorized([forged], CTX({ attestVerify: () => true }));
  assert.equal(reason(r, forged), REJECT_REASONS.BAD_ATTESTATION);
  assert.equal(r.attestationOf(short16('XTRA')), null);
  assert.equal(r.attestationOf(D[EVE].short), null);
});

test('F-10 condition (3): copying a peer\'s attestation blob into my own record is rejected', () => {
  // The blob travels inside the E2EE stream, so EVERY member can read Mama's verbatim. Eve files
  // Mama's bytes, unaltered, under Mama's own short in EVE's member record. Condition (2) passes
  // — the register name does equal `att.deviceShort`. Only (3) stands between that op and a
  // table in which `attestationOf(mamaShort)` might resolve to a record Eve controls.
  const { ops } = family();
  const mamaBlob = attBlob({ memberId: MAMA, deviceId: D[MAMA].id, deviceShort: D[MAMA].short });
  const copy = mk('member.set', memberKey(EVE), { [`dev.${D[MAMA].short}`]: mamaBlob },
    { act: EVE, dev: D[EVE].id, ts: S(0, 0, '0000000000000000'), space: FSP });   // ms=0: minimal under ≺
  // The verifier is made to accept EVERYTHING, so condition (4) cannot be what rejects this and
  // the assertion is about (3) alone.
  const r = foldAuthorized([...ops, copy], CTX({ attestVerify: () => true }));
  assert.equal(reason(r, copy), REJECT_REASONS.BAD_ATTESTATION,
    'a payload naming MAMA housed on EVE\'s record must not be admitted');
  assert.equal(r.attestationOf(D[MAMA].short).memberId, MAMA, 'the short still resolves to Mama');
  assert.deepEqual(r.shortCollisions, [], 'the copy never reached the table, so there is no contest');
  assert.equal(r.attestedDevices.has(EVE), false);
  assert.deepEqual(snapshot(foldAuthorized(shuffled(mulberry32(7), [...ops, copy]),
    CTX({ attestVerify: () => true }))), snapshot(r));
});

test('F-10 condition (4): an attestation whose signature does not verify is rejected', () => {
  // Eve rewrites the payload so it names her (condition (3) now passes) but signs it with — or
  // rather, replays a signature belonging to — Mama. Only (4) is left.
  //
  // NOTE ON WHAT THIS CAN AND CANNOT PROVE. `attestationVerifies` is handed `subject`, the
  // housing member, never `att.memberId`. That distinction is NOT falsifiable while condition
  // (3) stands, because (3) has already forced the two to be equal — swapping the argument
  // changes no outcome. It is kept as the second lock on the same door: if a future change ever
  // relaxes (3) — which ADR 002 §5.2.1 warns against by name — this line is what still refuses
  // a peer's blob, and it must not have been "simplified" to the payload's own claim by then.
  const forged = mk('member.set', memberKey(EVE), {
    [`dev.${D[EVE].short}`]: attBlob({
      memberId: EVE, deviceId: D[EVE].id, deviceShort: D[EVE].short,
      sigOver: `sig:${MAMA}:${D[MAMA].id}`,
    }),
  }, { act: EVE, dev: D[EVE].id, ts: S(BASE, 0, D[EVE].short), space: FSP });
  const r = foldAuthorized([forged], CTX());
  assert.equal(reason(r, forged), REJECT_REASONS.BAD_ATTESTATION);
  assert.equal(r.attestationOf(D[EVE].short), null);
});

test('F-10: ctx.attestOpen is accepted, and its answer may not disagree with the register bytes', () => {
  // ADR 001 §4.0 / ADR 002 §5.2.3 name the injection `attestOpen(memberId, blob) =>
  // DeviceAttestation|null`. The payload the table publishes still comes from the register
  // bytes; `attestOpen` decides only whether they verify. An opener that returns a DIFFERENT
  // attestation is treated as a failed verification — otherwise the injected function would be
  // a second, unlogged source of device identity, which is the key-injection hole §2.3 closes.
  const { ops } = family({ members: [ME, MAMA] });
  const honest = (memberId, blob) => (verifier(memberId, blob) ? parseAttestationBlob(blob) : null);
  const viaOpen = foldAuthorized(ops, { me: ME, attestOpen: honest });
  assert.deepEqual(snapshot(viaOpen), snapshot(foldAuthorized(ops, CTX())),
    'attestOpen and attestVerify must fold to the same board');
  assert.equal(viaOpen.attestationOf(D[MAMA].short).deviceId, D[MAMA].id);

  const liar = (memberId, blob) => {
    const att = parseAttestationBlob(blob);
    return att ? { ...att, sigPubRaw: b64u(utf8('sigpub:ATTACKER')) } : null;
  };
  const lied = foldAuthorized(ops, { me: ME, attestOpen: liar });
  assert.equal(lied.attestationOf(D[MAMA].short), null, 'a disagreeing opener verifies nothing');
  assert.equal(lied.admitted.length, 0);

  const refuses = foldAuthorized(ops, { me: ME, attestOpen: () => null });
  assert.equal(refuses.admitted.length, 0, 'attestOpen fails closed exactly as attestVerify does');
  assert.equal(foldAuthorized(ops, { me: ME }).admitted.length, 0, 'and neither injection is fail-open');
});

test('I-3 CLOSED: a SQUATTED deviceShort is unproven, so the victim keeps it — at any stamp', () => {
  // §2.3 argues `deviceShort → DeviceAttestation` is a function because two members would need
  // the same signing PRIVATE key. The four conditions do not enforce that: nothing in a pure,
  // synchronous fold can check `crock32(SHA-256(sigPubRaw)[0..10]) === deviceShort` — that is
  // §5.2.2's P2 and it lives in `openOp`. So a member CAN mint a well-formed attestation under a
  // peer's short, and P2 does not stop her: `sigPubRaw` is public and she copies it.
  //
  // Two answers to that have been tried here. The FIRST resolved the contest minimal-under-`≺`,
  // which handed the lookup — and therefore `openOp`'s verification key — to whichever claimant
  // backdated harder. The SECOND refused the contest outright, which was safe against
  // impersonation and catastrophic against denial of service: one op, and every envelope the
  // victim's Mac would ever seal parked for ever (I-3 / R5-7).
  //
  // THE THIRD, and the one asserted here — FINDINGS §4.5 option (a): a `dev.<S>` register is a
  // credential only if the op that WROTE it was stamped by the device it attests. The squatter
  // can copy every public field; she cannot author an op whose stamp ends in his short, because
  // that envelope must verify under his key (`openOp` P3 + check 4). So there is no contest to
  // resolve — one of the two claims was never a claim.
  const { ops } = family({ members: [ME] });
  const squat = (ms) => mk('member.set', memberKey(EVE), {
    [`dev.${D[ME].short}`]: attBlob({ memberId: EVE, deviceId: devIdOf('EVEX'), deviceShort: D[ME].short }),
  }, { act: EVE, dev: devIdOf('EVEX'), ts: S(ms, 0, short16('EVEX')), space: FSP, id: pad22('squat') });

  for (const ms of [BASE + 5000, 0]) {
    const r = foldAuthorized([...ops, squat(ms)], CTX());
    assert.deepEqual(r.shortCollisions, [], `ms=${ms}: nothing is contested`);
    assert.deepEqual(r.unprovenShorts, [D[ME].short], `ms=${ms}: the attempt is still REPORTED`);
    assert.equal(r.attestationOf(D[ME].short).memberId, ME,
      `ms=${ms}: and no stamp the squatter picks takes the lookup away from its owner`);
  }

  // Stage 0b is untouched either way: the device gate is per-member, so ME's own ops still stand.
  const early = foldAuthorized([...ops, squat(0)], CTX());
  assert.equal(early.attestedDevices.get(ME).has(D[ME].id), true);
  assert.equal(early.memberOfDevice(D[ME].id), ME);
  assert.equal(early.rejected.length, 0, 'and nothing is rejected — refusing both claims would be a DoS handle');

  // THE PRE-COLLISION WINDOW — S2(c). With the victim's own register not yet folded there is
  // nothing to contest at all, so no ordering rule could ever have helped here. The squat is
  // refused for being unproven, which turns what used to be a resolve-decrypt-THROW (a final
  // rejection, i.e. silent data loss) into a P1 park.
  const alone = foldAuthorized([squat(0)], CTX());
  assert.deepEqual(alone.shortCollisions, []);
  assert.equal(alone.attestationOf(D[ME].short), null, 'she is never handed a short she cannot sign for');
  assert.deepEqual(alone.unprovenShorts, [D[ME].short]);

  // TWO PROVEN CLAIMS IS STILL A REFUSAL, and that half must not be lost: it needs one signing
  // private key in two member records, which is an 80-bit collision or a broken engine, and
  // neither is a contest a fold may pick a winner in.
  const twinOfMine = mk('member.set', memberKey(EVE), {
    [`dev.${D[ME].short}`]: attBlob({ memberId: EVE, deviceId: devIdOf('EVEX'), deviceShort: D[ME].short }),
  }, { act: EVE, dev: devIdOf('EVEX'), ts: S(BASE + 7000, 0, D[ME].short), space: FSP, id: pad22('twin') });
  const both = foldAuthorized([...ops, twinOfMine], CTX());
  assert.deepEqual(both.shortCollisions, [D[ME].short]);
  assert.equal(both.attestationOf(D[ME].short), null);

  // The only thing that would be fatal: two devices resolving the short differently.
  for (const seed of [1, 2, 3, 4, 5]) {
    assert.deepEqual(snapshot(foldAuthorized(shuffled(mulberry32(seed), [...ops, squat(0)]), CTX())),
      snapshot(early), `shuffle ${seed} changed how the short resolves`);
  }
});

test('I-3: one sigPubRaw under two deviceShorts is contested without hashing anything', () => {
  // The half of ADR 001 §1.2 a pure fold CAN enforce. P2 needs SHA-256 and lives in `openOp`,
  // but "one signing key hashes to exactly one short" is an EQUALITY, and it catches the squat
  // that lands before its victim's own attestation — when there is no second member record yet
  // for the collision test above to fire on.
  const twinShort = short16('TWNX');
  const own = mk('member.set', memberKey(EVE), {
    [`dev.${D[EVE].short}`]: attBlob({ memberId: EVE, deviceId: D[EVE].id, deviceShort: D[EVE].short }),
  }, { act: EVE, dev: D[EVE].id, ts: S(BASE, 0, D[EVE].short), space: FSP });
  const twin = mk('member.set', memberKey(EVE), {
    [`dev.${twinShort}`]: attBlob({ memberId: EVE, deviceId: D[EVE].id, deviceShort: twinShort }),
  }, { act: EVE, dev: D[EVE].id, ts: S(BASE + 1, 0, D[EVE].short), space: FSP });

  const r = foldAuthorized([own, twin], CTX());
  assert.deepEqual(r.shortCollisions, [D[EVE].short, twinShort].sort(),
    'both shorts are contested: one of the two must be a lie about §1.2');
  assert.equal(r.attestationOf(D[EVE].short), null);
  assert.equal(r.attestationOf(twinShort), null);
  assert.deepEqual(snapshot(foldAuthorized([twin, own], CTX())), snapshot(r));
});

test('R4-13: a deviceId is a LABEL — two claimants means no owner, not a race', () => {
  // ADR 002 §2.3's four conditions bind `memberId` and `deviceShort`. They bind NOTHING to
  // `deviceId`, which is 128 random bits its own author asserts. `authz.js` used to claim
  // otherwise and publish `deviceId → memberId` as first-writer-wins over an order the attacker
  // could choose by backdating (round-4 finding 4). The map is gone: `memberOfDevice` answers
  // only when there is exactly one claimant, and every contest is on `deviceIdCollisions`.
  const { ops } = family({ members: [ME, MAMA] });
  // Eve's own record, Eve's own short, Eve's own memberId, signed by Eve — and MAMA's label.
  const adopt = (ms) => mk('member.set', memberKey(EVE), {
    [`dev.${D[EVE].short}`]: attBlob({ memberId: EVE, deviceId: D[MAMA].id, deviceShort: D[EVE].short }),
  }, { act: EVE, dev: D[EVE].id, ts: S(ms, 0, D[EVE].short), space: FSP, id: pad22('adopt') });

  for (const ms of [0, BASE + 9999]) {
    const r = foldAuthorized([...ops, adopt(ms)], CTX());
    assert.equal(reason(r, adopt(ms)), null, `ms=${ms}: still admitted — a rejection would be a DoS handle`);
    assert.equal(r.memberOfDevice(D[MAMA].id), null, `ms=${ms}: the label resolves to NOBODY`);
    assert.deepEqual(r.deviceIdCollisions, [D[MAMA].id], `ms=${ms}: and the contest is reported`);
    assert.equal(r.attestedDevices.get(MAMA).has(D[MAMA].id), true, `ms=${ms}: Mama is not un-attested`);
  }

  // Order-independence covers the report, not just the answer: two Macs must agree on a contest.
  const set = [...ops, adopt(0)];
  for (const seed of [11, 12, 13]) {
    assert.deepEqual(snapshot(foldAuthorized(shuffled(mulberry32(seed), set), CTX())),
      snapshot(foldAuthorized(set, CTX())), `shuffle ${seed}`);
  }
});

test('R4-13d: the adopted label confers nothing a freshly invented one would not', () => {
  // The proof that there is nothing left to forge, rather than a promise. Whatever Eve can do
  // holding Mama's label she can do holding a label she made up, so adopting Mama's is a name
  // collision and not a capability — and she still cannot author as MAMA, because stage 0b reads
  // `op.act`'s OWN record.
  const { ops } = family({ members: [ME, MAMA] });
  const evesOwn = (devId) => mk('member.set', memberKey(EVE), {
    [`dev.${D[EVE].short}`]: attBlob({ memberId: EVE, deviceId: devId, deviceShort: D[EVE].short }),
  }, { act: EVE, dev: D[EVE].id, ts: S(BASE, 0, D[EVE].short), space: FSP, id: pad22('claim') });
  const evesOp = (devId) => memberOp(EVE, { displayName: 'Eve' }, S(BASE + 5, 0, D[EVE].short),
    { act: EVE, dev: devId, id: pad22('evop') });

  const stolen = foldAuthorized([...ops, evesOwn(D[MAMA].id), evesOp(D[MAMA].id)], CTX());
  const fresh = foldAuthorized([...ops, evesOwn(devIdOf('FRESH')), evesOp(devIdOf('FRESH'))], CTX());
  assert.deepEqual(stolen.rejected.map((o) => o.id), fresh.rejected.map((o) => o.id),
    'identical outcomes ⇒ the stolen label conferred nothing');

  // And the thing the forgery was for is still refused.
  const asMama = memberOp(MAMA, { displayName: 'gekapert' }, S(BASE + 6, 0, D[EVE].short),
    { act: MAMA, dev: D[MAMA].id, id: pad22('asmama') });
  const r = foldAuthorized([evesOwn(D[MAMA].id), asMama], CTX());
  assert.equal(reason(r, asMama), REJECT_REASONS.UNATTESTED_DEVICE,
    'Eve\'s claim does not attest MAMA — the gate is the (member, device) pair');
});

test('F-10: with no contest, shortCollisions is empty and every attested short resolves', () => {
  const { ops } = family();
  const r = foldAuthorized(ops, CTX());
  assert.deepEqual(r.shortCollisions, []);
  for (const m of [ME, MAMA, PAPA]) {
    assert.equal(r.attestationOf(D[m].short).memberId, m);
    assert.equal(r.memberOfDevice(r.attestationOf(D[m].short).deviceId), m,
      'the retained accessors stay derivable from the new one');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Stage 1 — the admin chain, resolved from the log
// ─────────────────────────────────────────────────────────────────────────────

test('genesis is admissible only when op.act === op.f.admin', () => {
  const { ops } = family({ members: [ME, MAMA] });
  const r = foldAuthorized(ops, CTX());
  assert.equal(r.admin, ME);

  resetIds();
  const bad = [
    attestOp(MAMA, D[MAMA], S(BASE, 0, D[MAMA].short)),
    spaceOp({ admin: ME, adminPrev: null }, S(BASE + 10, 0, D[MAMA].short), { act: MAMA, spaceId: FSP2 }),
  ];
  const r2 = foldAuthorized(bad, CTX());
  assert.equal(r2.adminOfSpace(FSP2), null);
  assert.equal(reason(r2, bad[1]), REJECT_REASONS.LOST_ADMIN_CHAIN);
});

test('a space.set carrying `admin` but no `adminPrev` is not a genesis with an implied null', () => {
  const { ops } = family({ members: [ME] });
  const rootless = spaceOp({ admin: EVE }, S(BASE + 20, 0, D[ME].short), { act: ME });
  const r = foldAuthorized([...ops, rootless], CTX());
  assert.equal(reason(r, rootless), REJECT_REASONS.BAD_ADMIN_LINK);
  assert.equal(r.admin, ME);
});

test('an admin transfer moves the admin, and the old admin loses the role', () => {
  const { ops, genesis } = family();
  const transfer = spaceOp({ admin: MAMA, adminPrev: genesis.id }, S(BASE + 100, 0, D[ME].short), { act: ME });
  const r = foldAuthorized([...ops, transfer], CTX());
  assert.equal(r.admin, MAMA);
  assert.equal(r.adminAt(S(BASE + 50, 0, D[ME].short)), ME, 'point-in-time before the transfer');
  assert.equal(r.adminAt(S(BASE + 100, 0, D[ME].short)), MAMA, 'the transfer stamp itself counts');
  assert.equal(r.adminChainOf(FSP).length, 2);
});

test('a transfer signed by anyone but the current admin is rejected, in every order', () => {
  const { ops, genesis } = family();
  const forged = spaceOp({ admin: EVE, adminPrev: genesis.id }, S(BASE + 100, 0, D[MAMA].short), { act: MAMA });
  const all = [...ops, forged];
  const snaps = foldShuffles(all, CTX(), 60);
  for (const s of snaps) assert.deepEqual(s, snaps[0]);
  const r = foldAuthorized(all, CTX());
  assert.equal(r.admin, ME);
  assert.equal(reason(r, forged), REJECT_REASONS.LOST_ADMIN_CHAIN);
});

test('an orphan transfer waits for its parent instead of rooting itself', () => {
  const { ops, genesis } = family();
  const t1 = spaceOp({ admin: MAMA, adminPrev: genesis.id }, S(BASE + 100, 0, D[ME].short), { act: ME, id: pad22('T1') });
  const t2 = spaceOp({ admin: PAPA, adminPrev: pad22('T1') }, S(BASE + 200, 0, D[MAMA].short), { act: MAMA });
  const without = foldAuthorized([...ops, t2], CTX());
  assert.equal(without.admin, ME, 'an orphan must not root itself');
  assert.equal(reason(without, t2), REJECT_REASONS.LOST_ADMIN_CHAIN);
  const withParent = foldAuthorized([...ops, t2, t1], CTX());
  assert.equal(withParent.admin, PAPA, 'the same op becomes admissible when its parent arrives');
});

test('the longest valid chain wins over a rival fork', () => {
  const { ops, genesis } = family();
  // ME transfers to MAMA; MAMA transfers on to PAPA. A rival link, also signed by ME off the
  // same genesis, tries to hand the role to EVE — legal in isolation, shorter in context.
  const t1 = spaceOp({ admin: MAMA, adminPrev: genesis.id }, S(BASE + 100, 0, D[ME].short), { act: ME, id: pad22('T1') });
  const t2 = spaceOp({ admin: PAPA, adminPrev: pad22('T1') }, S(BASE + 110, 0, D[MAMA].short), { act: MAMA });
  const rival = spaceOp({ admin: EVE, adminPrev: genesis.id }, S(BASE + 900, 0, D[ME].short), { act: ME });
  const all = [...ops, t1, t2, rival];
  const snaps = foldShuffles(all, CTX(), 40);
  for (const s of snaps) assert.deepEqual(s, snaps[0]);
  const r = foldAuthorized(all, CTX());
  assert.equal(r.admin, PAPA, 'the two-link chain beats the one-link rival despite its greater ts');
  assert.equal(reason(r, rival), REJECT_REASONS.LOST_ADMIN_CHAIN);
});

test('equal-length rivals are broken by the greater ts of the disputed link, deterministically', () => {
  const { ops, genesis } = family();
  const lo = spaceOp({ admin: MAMA, adminPrev: genesis.id }, S(BASE + 100, 0, D[ME].short), { act: ME });
  const hi = spaceOp({ admin: PAPA, adminPrev: genesis.id }, S(BASE + 101, 0, D[ME].short), { act: ME });
  const all = [...ops, lo, hi];
  const r = foldAuthorized(all, CTX());
  assert.equal(r.admin, PAPA);
  const snaps = foldShuffles(all, CTX(), 40);
  for (const s of snaps) assert.deepEqual(s, snaps[0]);
  assert.equal(reason(r, lo), REJECT_REASONS.LOST_ADMIN_CHAIN);
});

test('rivals that tie on ts as well as on length are still resolved totally', () => {
  // The ts tiebreak is not enough on its own: two links from the same device in the same
  // millisecond with the same counter carry the SAME stamp. Without a further total tiebreak the
  // winner would be "whichever the walk saw last", which is arrival order wearing a disguise.
  const { ops, genesis } = family();
  const same = S(BASE + 100, 0, D[ME].short);
  const t1 = spaceOp({ admin: MAMA, adminPrev: genesis.id }, same, { act: ME, id: pad22('TIE_A') });
  const t2 = spaceOp({ admin: PAPA, adminPrev: genesis.id }, same, { act: ME, id: pad22('TIE_B') });
  const all = [...ops, t1, t2];
  const r = foldAuthorized(all, CTX());
  assert.equal(r.admin, PAPA, 'the greater opId is the final, total tiebreak');
  const snaps = foldShuffles(all, CTX(), 40, 4711);
  for (const s of snaps) assert.deepEqual(s, snaps[0]);

  // And the same for two GENESIS links carrying one stamp.
  resetIds();
  const base = [
    attestOp(ME, D[ME], S(BASE, 0, D[ME].short), { space: FSP2 }),
    attestOp(MAMA, D[MAMA], S(BASE + 1, 0, D[MAMA].short), { space: FSP2 }),
  ];
  const g1 = spaceOp({ admin: ME, adminPrev: null }, S(BASE + 10, 0, D[ME].short), { act: ME, spaceId: FSP2, id: pad22('GA') });
  const g2 = spaceOp({ admin: MAMA, adminPrev: null }, S(BASE + 10, 0, D[ME].short), { act: MAMA, dev: D[MAMA].id, spaceId: FSP2, id: pad22('GB') });
  const g = [...base, g1, g2];
  const rg = foldAuthorized(g, CTX());
  assert.equal(rg.adminOfSpace(FSP2), MAMA, 'GB > GA on the opId');
  const gsnaps = foldShuffles(g, CTX(), 40, 1234);
  for (const s of gsnaps) assert.deepEqual(s, gsnaps[0]);
});

test('a backdated transfer does not reach back over a link that had not yet happened', () => {
  const { ops, genesis } = family();
  const back = spaceOp({ admin: MAMA, adminPrev: genesis.id }, S(BASE, 0, D[ME].short), { act: ME });
  const r = foldAuthorized([...ops, back], CTX());
  assert.equal(r.admin, MAMA, 'causal order still puts the transfer last');
  // Genesis is at BASE+10; the transfer claims BASE. The walk stops at the first link whose ts
  // is greater than the query, so nothing before genesis resolves — a backdated transfer cannot
  // manufacture an admin for a period in which the space did not yet exist.
  assert.equal(r.adminAt(S(BASE, 0, D[ME].short)), null);
  assert.equal(r.adminAt(S(BASE + 5, 0, D[ME].short)), null);
  // From genesis onwards BOTH links are within the window, so the transfer is already in effect.
  // That is inside the outgoing admin's power (only he could sign it), and it is deterministic —
  // which is the property that matters. Reported as an ADR observation, not a hole.
  assert.equal(r.adminAt(S(BASE + 10, 0, D[ME].short)), MAMA);
  assert.equal(r.adminAt(S(BASE + 1000, 0, D[ME].short)), MAMA);
});

test('a cycle in adminPrev terminates instead of hanging', () => {
  const { ops } = family({ members: [ME] });
  const a = spaceOp({ admin: MAMA, adminPrev: pad22('CY_B') }, S(BASE + 100, 0, D[ME].short), { act: ME, id: pad22('CY_A') });
  const b = spaceOp({ admin: ME, adminPrev: pad22('CY_A') }, S(BASE + 101, 0, D[ME].short), { act: MAMA, id: pad22('CY_B'), dev: D[ME].id });
  const r = foldAuthorized([...ops, a, b], CTX());
  assert.equal(r.admin, ME, 'the real genesis still wins; neither cycle link roots itself');
  assert.equal(reason(r, a), REJECT_REASONS.LOST_ADMIN_CHAIN);
  assert.equal(reason(r, b), REJECT_REASONS.UNATTESTED_DEVICE);
});

test('space.set{name} is admissible only from admin@op.ts (story 20.1)', () => {
  const { ops, genesis } = family();
  const byAdmin = spaceOp({ name: 'Familie Hein' }, S(BASE + 50, 0, D[ME].short), { act: ME });
  const byOther = spaceOp({ name: 'Uebernommen' }, S(BASE + 60, 0, D[MAMA].short), { act: MAMA });
  const transfer = spaceOp({ admin: MAMA, adminPrev: genesis.id }, S(BASE + 100, 0, D[ME].short), { act: ME });
  const afterByOld = spaceOp({ name: 'Zurueck' }, S(BASE + 200, 0, D[ME].short), { act: ME });
  const r = foldAuthorized([...ops, byAdmin, byOther, transfer, afterByOld], CTX());
  assert.equal(reason(r, byAdmin), null);
  assert.equal(reason(r, byOther), REJECT_REASONS.NOT_ADMIN);
  assert.equal(reason(r, afterByOld), REJECT_REASONS.NOT_ADMIN, 'the former admin loses the power at the transfer stamp');
  assert.equal(registerValue(r.regs, spaceKey(FSP), 'name'), 'Familie Hein');
});

test('a space.set sealed into one space may not address another', () => {
  const { ops } = family({ members: [ME] });
  const crossed = mk('space.set', spaceKey(FSP2), { name: 'fremd' },
    { act: ME, dev: D[ME].id, ts: S(BASE + 50, 0, D[ME].short), space: FSP });
  const r = foldAuthorized([...ops, crossed], CTX());
  assert.equal(reason(r, crossed), REJECT_REASONS.SPACE_MISMATCH);
  assert.equal(r.regs.has(spaceKey(FSP2)), false);
});

test('ctx.genesisOpId pins the root and closes the forged-genesis fork', () => {
  // Reported as an ADR gap: with the §4.1 rule alone, a member can mint a rival GENESIS for an
  // existing space and win an equal-length tie on ts. The pin is the caller's out-of-log answer.
  const { ops, genesis } = family();
  const forgedGenesis = spaceOp({ admin: EVE, adminPrev: null }, S(BASE + 99999, 0, D[MAMA].short), { act: EVE, dev: D[MAMA].id });
  const eve = [
    attestOp(EVE, D[EVE], S(BASE + 3, 0, D[EVE].short)),
    memberOp(EVE, { displayName: 'Eve', _alive: true }, S(BASE + 4, 0, D[EVE].short)),
  ];
  const forgedByEve = spaceOp({ admin: EVE, adminPrev: null }, S(BASE + 99999, 0, D[EVE].short), { act: EVE });
  const unpinned = foldAuthorized([...ops, ...eve, forgedByEve], CTX());
  assert.equal(unpinned.admin, EVE, 'characterizing the hole the ADR leaves open');
  const pinned = foldAuthorized([...ops, ...eve, forgedByEve], CTX({ genesisOpId: genesis.id }));
  assert.equal(pinned.admin, ME);
  assert.equal(reason(pinned, forgedByEve), REJECT_REASONS.LOST_ADMIN_CHAIN);
  assert.equal(reason(unpinned, forgedGenesis), null, 'the unused fixture stays out of the result');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Stage 2 — membership
// ─────────────────────────────────────────────────────────────────────────────

test('member.set{displayName,colorRef} is self-edit only — not even the admin may do it', () => {
  const { ops } = family();
  const self = memberOp(MAMA, { displayName: 'Mama', colorRef: 'rose' }, S(BASE + 50, 0, D[MAMA].short));
  const byAdmin = memberOp(MAMA, { displayName: 'Umbenannt' }, S(BASE + 60, 0, D[ME].short), { act: ME });
  const byPeer = memberOp(MAMA, { displayName: 'Frech' }, S(BASE + 70, 0, D[PAPA].short), { act: PAPA });
  const r = foldAuthorized([...ops, self, byAdmin, byPeer], CTX());
  assert.equal(reason(r, self), null);
  assert.equal(reason(r, byAdmin), REJECT_REASONS.NOT_SELF);
  assert.equal(reason(r, byPeer), REJECT_REASONS.NOT_SELF);
  assert.equal(registerValue(r.regs, memberKey(MAMA), 'displayName'), 'Mama');
});

test('removal (_alive:false) is admissible from the member and from the admin, and from nobody else', () => {
  const { ops } = family();
  const byAdmin = memberOp(PAPA, { _alive: false }, S(BASE + 100, 0, D[ME].short), { act: ME });
  const byPeer = memberOp(MAMA, { _alive: false }, S(BASE + 101, 0, D[PAPA].short), { act: PAPA });
  const bySelf = memberOp(MAMA, { _alive: false }, S(BASE + 102, 0, D[MAMA].short), { act: MAMA });
  const r = foldAuthorized([...ops, byAdmin, byPeer, bySelf], CTX());
  assert.equal(reason(r, byAdmin), null, 'admin removes (20.2)');
  assert.equal(reason(r, bySelf), null, 'member leaves (20.3)');
  assert.equal(reason(r, byPeer), REJECT_REASONS.NOT_ADMIN);
  assert.deepEqual([...r.currentMembers].sort(), [ME]);
});

test('an admin removal bundled with any other field is not a removal', () => {
  const { ops } = family();
  const sneaky = memberOp(PAPA, { _alive: false, displayName: 'Weg' }, S(BASE + 100, 0, D[ME].short), { act: ME });
  const r = foldAuthorized([...ops, sneaky], CTX());
  assert.equal(reason(r, sneaky), REJECT_REASONS.NOT_SELF);
  assert.ok(r.currentMembers.has(PAPA));
});

test('a former admin cannot remove a member after the transfer stamp', () => {
  const { ops, genesis } = family();
  const transfer = spaceOp({ admin: MAMA, adminPrev: genesis.id }, S(BASE + 100, 0, D[ME].short), { act: ME });
  const late = memberOp(PAPA, { _alive: false }, S(BASE + 200, 0, D[ME].short), { act: ME });
  const early = memberOp(PAPA, { _alive: false }, S(BASE + 50, 0, D[ME].short), { act: ME, id: pad22('EARLY') });
  const r = foldAuthorized([...ops, transfer, late], CTX());
  assert.equal(reason(r, late), REJECT_REASONS.NOT_ADMIN);
  const r2 = foldAuthorized([...ops, transfer, early], CTX());
  assert.equal(reason(r2, early), null, 'the same act is admissible at a stamp when he still was admin');
});

test('currentMembers is exactly {member record exists AND _alive !== false}', () => {
  const { ops } = family();
  const r = foldAuthorized(ops, CTX());
  assert.deepEqual([...r.currentMembers].sort(), [ME, MAMA, PAPA].sort());
  const left = memberOp(PAPA, { _alive: false }, S(BASE + 100, 0, D[PAPA].short));
  const r2 = foldAuthorized([...ops, left], CTX());
  assert.deepEqual([...r2.currentMembers].sort(), [ME, MAMA].sort());
  // Only the attestation register, no member.set: the record exists, so the member is current.
  const bare = [attestOp(EVE, D[EVE], S(BASE + 5, 0, D[EVE].short))];
  const r3 = foldAuthorized([...ops, ...bare], CTX());
  assert.ok(r3.currentMembers.has(EVE));
});

test('a removed member can re-admit themselves in-log — characterized, not endorsed', () => {
  // ADR 001 §4.2 rules on `_alive:false` and is silent on `_alive:true`, so the register is a
  // plain LWW race between the member and the admin. Reported as an ADR gap: at the FOLD level
  // 20.2 is not final, and its finality comes from the key rotation and `deleteOpsByMember`
  // instead. Pinned here so the behaviour cannot change silently in either direction.
  const { ops } = family();
  const removed = memberOp(PAPA, { _alive: false }, S(BASE + 100, 0, D[ME].short), { act: ME });
  const back = memberOp(PAPA, { _alive: true }, S(BASE + 200, 0, D[PAPA].short), { act: PAPA });
  const r = foldAuthorized([...ops, removed, back], CTX());
  assert.equal(reason(r, back), null);
  assert.ok(r.currentMembers.has(PAPA), 'if this flips, the ADR gap was closed — update the note');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Stage 3a — governing fields, and the admin unshare
// ─────────────────────────────────────────────────────────────────────────────

/** A family whose ME entity is published Geteilt with co-edit on. */
function published({ level = 'geteilt', coEdit = true, owner = ME } = {}) {
  const f = family();
  const pub = pubOp('fnote', owner, U1, {
    'pub.level': level,
    'pub.coEdit': coEdit,
    'pub.alive': true,
    'pub.date': '2026-09-10',
    'pub.text': level === 'geteilt' ? 'Zahnarzt' : null,
    'pub.repeatsYearly': false,
    _born: S(BASE + 20, 0, D[owner].short),
  }, S(BASE + 20, 0, D[owner].short), { act: owner });
  return { ...f, ops: [...f.ops, pub], pub, e: familyKey('fnote', owner, U1) };
}

test('the owner may write governing fields on their own entity', () => {
  const { ops, pub, e } = published();
  const r = foldAuthorized(ops, CTX());
  assert.equal(reason(r, pub), null);
  assert.equal(registerValue(r.regs, e, 'pub.level'), 'geteilt');
  assert.equal(ownerOfEntity(e), ME);
});

test('a non-owner governing write is rejected — including from a current member', () => {
  const { ops, e } = published();
  const grab = pubOp('fnote', ME, U1, { 'pub.level': 'privat' }, S(BASE + 500, 0, D[MAMA].short), { act: MAMA });
  const grantSelf = pubOp('fnote', ME, U1, { 'pub.coEdit': true }, S(BASE + 501, 0, D[PAPA].short), { act: PAPA });
  const r = foldAuthorized([...ops, grab, grantSelf], CTX());
  assert.equal(reason(r, grab), REJECT_REASONS.NOT_OWNER);
  assert.equal(reason(r, grantSelf), REJECT_REASONS.NOT_OWNER);
  assert.equal(registerValue(r.regs, e, 'pub.level'), 'geteilt');
});

test('unsharePatch() is every pub.* field of the kind, and `_born` is not withdrawn', () => {
  for (const kind of ['fnote', 'fbar']) {
    const p = unsharePatch(kind);
    const pubFields = fieldsOf(kind).filter((f) => f.startsWith('pub.'));
    assert.deepEqual(Object.keys(p).sort(), pubFields.sort());
    assert.equal(p['pub.level'], 'privat');
    for (const f of pubFields) if (f !== 'pub.level') assert.equal(p[f], null, `${kind}.${f}`);
    assert.equal('_born' in p, false, `${kind}: the entry is unshared, never deleted (18.3)`);
  }
});

test('the admin unshare is admissible, and reverts the entry to owner-private', () => {
  const { ops, e } = published();
  const unshare = pubOp('fnote', ME, U1, { ...unsharePatch('fnote') }, S(BASE + 600, 0, D[ME].short), { act: ME });
  // ME is the admin here, and also the owner — so make MAMA the admin to test the real path.
  const f2 = family();
  const pub2 = pubOp('fnote', PAPA, U1, {
    'pub.level': 'geteilt', 'pub.coEdit': false, 'pub.alive': true,
    'pub.date': '2026-09-10', 'pub.text': 'privat gemeint', 'pub.repeatsYearly': false,
  }, S(BASE + 20, 0, D[PAPA].short), { act: PAPA });
  const byAdmin = pubOp('fnote', PAPA, U1, { ...unsharePatch('fnote') }, S(BASE + 700, 0, D[ME].short), { act: ME });
  const r = foldAuthorized([...f2.ops, pub2, byAdmin], CTX());
  const key = familyKey('fnote', PAPA, U1);
  assert.equal(reason(r, byAdmin), null);
  assert.equal(registerValue(r.regs, key, 'pub.level'), 'privat');
  assert.equal(registerValue(r.regs, key, 'pub.text'), null, 'withdrawn EXPLICITLY, not by omission');
  assert.equal(ownerOfEntity(key), PAPA, 'the unshare does not transfer the entity');
  assert.equal(reason(foldAuthorized(ops, CTX()), unshare), null, 'the owner may of course write it too');
});

test('an unshare that carries a non-withdrawal is PARKED, and one that is no unshare at all is rejected', () => {
  // The predicate is a property of the PATCH, never a diff against this build's field table. Two
  // outcomes, and neither of them is "silently still shared":
  //   * `_born` alongside the withdrawals — a value this build cannot read as a withdrawal, and
  //     therefore possibly a shape a LATER build gives meaning to. Parked: retained, not applied,
  //     re-evaluated after an app update. An admin still gets no general write primitive out of
  //     it, because a parked op is never folded.
  //   * the level set to `belegt` rather than `privat` — not an unshare in any version. Rejected.
  const f2 = family();
  const pub2 = pubOp('fnote', PAPA, U1, {
    'pub.level': 'geteilt', 'pub.coEdit': false, 'pub.alive': true,
    'pub.date': '2026-09-10', 'pub.text': 'geheim', 'pub.repeatsYearly': false,
  }, S(BASE + 20, 0, D[PAPA].short), { act: PAPA });
  const extra = pubOp('fnote', PAPA, U1, { ...unsharePatch('fnote'), _born: S(BASE, 0, D[ME].short) },
    S(BASE + 700, 0, D[ME].short), { act: ME });
  const wrongLevel = pubOp('fnote', PAPA, U1, { ...unsharePatch('fnote'), 'pub.level': 'belegt' },
    S(BASE + 702, 0, D[ME].short), { act: ME });
  const r = foldAuthorized([...f2.ops, pub2, extra, wrongLevel], CTX());

  assert.equal(reason(r, extra), null, 'a near-miss is not REJECTED — a rejection is final');
  assert.equal(r.parkReasonOf(extra.id), 'unshareShape', 'it is parked, for re-evaluation after an update');
  assert.equal(reason(r, wrongLevel), REJECT_REASONS.NOT_AN_UNSHARE);
  assert.equal(registerValue(r.regs, familyKey('fnote', PAPA, U1), 'pub.text'), 'geheim',
    'neither op was applied: parked is not admitted');
  assert.equal(registerValue(r.regs, familyKey('fnote', PAPA, U1), 'pub.level'), 'geteilt');
});

test('an unshare from an OLDER build — one pub field short — still unshares', () => {
  // THE VERSION-SKEW CASE. A build that predates a `pub.*` field emits an unshare without it. If
  // the newer client demanded an exact match against its own table it would REJECT that op — and a
  // rejection is final, so the entry the admin unshared would stay published on the newer client
  // while it is hidden on the older one. That is ADR 001 §4.1's "previously-hidden content
  // reappears", reached through a staggered app update instead of a hostile relay.
  //
  // What matters is that the level goes to privat and that everything the patch DOES carry is a
  // withdrawal. `pub.text` here is the field the older build never knew: it is not withdrawn by
  // this op, and ADR 004 §5.3 mechanism 2 (the forget pass, `oplog.js:forget`) is what blanks the
  // residue once the level lands on privat.
  const f2 = family();
  const pub2 = pubOp('fnote', PAPA, U1, {
    'pub.level': 'geteilt', 'pub.coEdit': false, 'pub.alive': true,
    'pub.date': '2026-09-10', 'pub.text': 'geheim', 'pub.repeatsYearly': false,
  }, S(BASE + 20, 0, D[PAPA].short), { act: PAPA });
  const short = { ...unsharePatch('fnote') };
  delete short['pub.text'];
  const older = pubOp('fnote', PAPA, U1, short, S(BASE + 701, 0, D[ME].short), { act: ME });
  const r = foldAuthorized([...f2.ops, pub2, older], CTX());
  const key = familyKey('fnote', PAPA, U1);

  assert.equal(reason(r, older), null, 'admitted — the unshare is not version-coupled');
  assert.equal(registerValue(r.regs, key, 'pub.level'), 'privat', 'THE POINT: it really is unshared');
  assert.equal(registerValue(r.regs, key, 'pub.date'), null, 'and everything it carried IS withdrawn');
  assert.equal(registerValue(r.regs, key, 'pub.alive'), null);
});

test('a non-admin cannot use the unshare shape', () => {
  const f2 = family();
  const pub2 = pubOp('fnote', PAPA, U1, {
    'pub.level': 'geteilt', 'pub.coEdit': true, 'pub.alive': true,
    'pub.date': '2026-09-10', 'pub.text': 'geheim', 'pub.repeatsYearly': false,
  }, S(BASE + 20, 0, D[PAPA].short), { act: PAPA });
  const byPeer = pubOp('fnote', PAPA, U1, { ...unsharePatch('fnote') }, S(BASE + 700, 0, D[MAMA].short), { act: MAMA });
  const r = foldAuthorized([...f2.ops, pub2, byPeer], CTX());
  assert.equal(reason(r, byPeer), REJECT_REASONS.NOT_OWNER);
  assert.equal(registerValue(r.regs, familyKey('fnote', PAPA, U1), 'pub.text'), 'geheim');
});

test('isAdminUnsharePatch reads the patch, not this build\'s field table', () => {
  assert.equal(isAdminUnsharePatch('fnote', unsharePatch('fnote')), true);
  assert.equal(isAdminUnsharePatch('fbar', unsharePatch('fbar')), true);

  // A patch this build's table does not generate is still an unshare: it sets the level to privat
  // and every other field it carries is a withdrawal. That is what makes the predicate survive a
  // staggered rollout in BOTH directions — one field short (an older build) and one field extra
  // (a newer one).
  assert.equal(isAdminUnsharePatch('fnote', unsharePatch('fbar')), true, 'a foreign kind\'s pub fields');
  assert.equal(isAdminUnsharePatch('fnote', { 'pub.level': 'privat' }), true, 'the minimum');
  assert.equal(isAdminUnsharePatch('fnote', { ...unsharePatch('fnote'), 'pub.futureField': null }), true,
    'a pub field only a newer build knows, correctly withdrawn');

  // And what is NOT an unshare: a non-null value beside the level (the general-write-primitive
  // hole), a level that is not privat, and a patch with no level at all.
  assert.equal(isAdminUnsharePatch('fnote', { ...unsharePatch('fnote'), 'pub.text': 'x' }), false);
  assert.equal(isAdminUnsharePatch('fnote', { ...unsharePatch('fnote'), 'pub.level': 'belegt' }), false);
  assert.equal(isAdminUnsharePatch('fnote', { 'pub.text': null }), false);
  assert.equal(isAdminUnsharePatch('fnote', {}), false);
  assert.equal(isAdminUnsharePatch('fnote', null), false);
});

test('classifyUnsharePatch separates park-it from drop-it', () => {
  // The tri-state is the whole point: only a patch that cannot be an unshare in any version is
  // rejected, because a rejection is final and a wrongly-final rejection means "still shared".
  assert.equal(classifyUnsharePatch('fnote', unsharePatch('fnote')), 'unshare');
  assert.equal(classifyUnsharePatch('fnote', { 'pub.level': 'privat', 'pub.text': null }), 'unshare');

  assert.equal(classifyUnsharePatch('fnote', { 'pub.level': 'privat', 'pub.text': '' }), 'skew',
    'a future build that withdraws with a sentinel instead of null');
  assert.equal(classifyUnsharePatch('fnote', { 'pub.level': 'privat', _born: 1 }), 'skew',
    'a non-pub field alongside the withdrawals');

  assert.equal(classifyUnsharePatch('fnote', { 'pub.level': 'geteilt' }), 'no');
  assert.equal(classifyUnsharePatch('fnote', { 'pub.alive': null }), 'no');
  assert.equal(classifyUnsharePatch('fnote', []), 'no');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Stage 3b — co-editing, read from pub.coEdit and never from a truth register
// ─────────────────────────────────────────────────────────────────────────────

test('a co-editor may write a co-editable content field when coEdit AND geteilt AND a member', () => {
  const { ops, e } = published();
  const edit = pubOp('fnote', ME, U1, { 'pub.text': 'Zahnarzt 14 Uhr' }, S(BASE + 800, 0, D[MAMA].short), { act: MAMA });
  const r = foldAuthorized([...ops, edit], CTX());
  assert.equal(reason(r, edit), null);
  assert.equal(registerValue(r.regs, e, 'pub.text'), 'Zahnarzt 14 Uhr');
  assert.equal(registerOf(r.regs, e, 'pub.text').author, MAMA, 'attribution follows the writer (17.6)');
});

test('co-edit is refused when pub.coEdit is false', () => {
  const { ops, e } = published({ coEdit: false });
  const edit = pubOp('fnote', ME, U1, { 'pub.text': 'fremd' }, S(BASE + 800, 0, D[MAMA].short), { act: MAMA });
  const r = foldAuthorized([...ops, edit], CTX());
  assert.equal(reason(r, edit), REJECT_REASONS.NO_COEDIT);
  assert.equal(registerValue(r.regs, e, 'pub.text'), 'Zahnarzt');
});

test('co-editing requires Geteilt — a Belegt entry has no readable text to co-edit', () => {
  const { ops, e } = published({ level: 'belegt', coEdit: true });
  const edit = pubOp('fnote', ME, U1, { 'pub.text': 'eingeschmuggelt' }, S(BASE + 800, 0, D[MAMA].short), { act: MAMA });
  const r = foldAuthorized([...ops, edit], CTX());
  assert.equal(reason(r, edit), REJECT_REASONS.NOT_GETEILT);
  assert.equal(registerValue(r.regs, e, 'pub.text'), null, 'Belegt published an explicit null, and it stands');
});

test('a non-member cannot co-edit, even with coEdit and Geteilt set', () => {
  const { ops, e } = published();
  const eve = [attestOp(EVE, D[EVE], S(BASE + 5, 0, D[EVE].short))];
  const left = memberOp(EVE, { _alive: false }, S(BASE + 6, 0, D[EVE].short));
  const edit = pubOp('fnote', ME, U1, { 'pub.text': 'von draussen' }, S(BASE + 800, 0, D[EVE].short), { act: EVE });
  const r = foldAuthorized([...ops, ...eve, left, edit], CTX());
  assert.equal(reason(r, edit), REJECT_REASONS.NOT_MEMBER);
  assert.equal(registerValue(r.regs, e, 'pub.text'), 'Zahnarzt');
});

test('a co-editor cannot grant themselves co-edit — pub.coEdit is folded a stage earlier', () => {
  const { ops, e } = published({ coEdit: false });
  const grant = pubOp('fnote', ME, U1, { 'pub.coEdit': true }, S(BASE + 800, 0, D[MAMA].short), { act: MAMA });
  const thenEdit = pubOp('fnote', ME, U1, { 'pub.text': 'doch' }, S(BASE + 801, 0, D[MAMA].short), { act: MAMA });
  const r = foldAuthorized([...ops, grant, thenEdit], CTX());
  assert.equal(reason(r, grant), REJECT_REASONS.NOT_OWNER);
  assert.equal(reason(r, thenEdit), REJECT_REASONS.NO_COEDIT);
  assert.equal(registerValue(r.regs, e, 'pub.coEdit'), false);
});

test('revoking co-edit retroactively withdraws the co-editor\'s writes, in every order', () => {
  // The consequence of "each stage reads only the FINAL values of earlier stages" (ADR 001 §4).
  // It is what makes admissibility a function of the SET; the alternative diverges.
  const { ops, e } = published();
  const edit = pubOp('fnote', ME, U1, { 'pub.text': 'Mamas Fassung' }, S(BASE + 800, 0, D[MAMA].short), { act: MAMA });
  const withEdit = foldAuthorized([...ops, edit], CTX());
  assert.equal(registerValue(withEdit.regs, e, 'pub.text'), 'Mamas Fassung');

  const revoke = pubOp('fnote', ME, U1, { 'pub.coEdit': false }, S(BASE + 900, 0, D[ME].short), { act: ME });
  const all = [...ops, edit, revoke];
  const r = foldAuthorized(all, CTX());
  assert.equal(reason(r, edit), REJECT_REASONS.NO_COEDIT);
  assert.equal(registerValue(r.regs, e, 'pub.text'), 'Zahnarzt');
  const snaps = foldShuffles(all, CTX(), 40);
  for (const s of snaps) assert.deepEqual(s, snaps[0]);
});

test('the predicate reads pub.* only — the owner\'s truth registers are not even present', () => {
  // A peer holds no `visibility` / `coEdit` truth register for my entity: those live in my
  // personal space and were never transmitted. If the predicate ever consulted one, the fold
  // would be unevaluable on exactly the machines that must evaluate it (ADR 001 §4.3).
  const { ops, e } = published();
  const truth = noteOp(U1, { visibility: 'privat', coEdit: false, text: 'Zahnarzt' }, S(BASE + 950, 0, D[ME].short));
  const edit = pubOp('fnote', ME, U1, { 'pub.date': '2026-09-11' }, S(BASE + 960, 0, D[MAMA].short), { act: MAMA });
  const withTruth = foldAuthorized([...ops, truth, edit], CTX());
  const withoutTruth = foldAuthorized([...ops, edit], CTX());
  assert.equal(reason(withTruth, edit), null, 'the truth registers say privat and no-coEdit, and are ignored');
  assert.equal(reason(withoutTruth, edit), null);
  assert.equal(registerValue(withTruth.regs, e, 'pub.date'), '2026-09-11');
  assert.equal(registerValue(withoutTruth.regs, noteKey(U1), 'visibility'), undefined);
});

test('every non-governing family field is co-editable, so the field guard is defence in depth', () => {
  // If this ever stops holding, `NOT_COEDITABLE` becomes reachable and needs its own case here.
  for (const kind of ['fnote', 'fbar']) {
    for (const f of fieldsOf(kind)) {
      const s = fieldSpec(kind, f);
      assert.ok(s.gov === true || s.coEdit === true, `${kind}.${f} is neither governing nor co-editable`);
    }
  }
  assert.equal(FIELDS.fnote['pub.text'].coEdit, true);
});

test('a co-editor writing a governing field takes the 3a path, never the 3b one', () => {
  const { ops } = published();
  const born = pubOp('fnote', ME, U1, { _born: S(0, 0, '0000000000000000') }, S(BASE + 800, 0, D[MAMA].short), { act: MAMA });
  const alive = pubOp('fnote', ME, U1, { 'pub.alive': false }, S(BASE + 801, 0, D[MAMA].short), { act: MAMA });
  const r = foldAuthorized([...ops, born, alive], CTX());
  assert.equal(reason(r, born), REJECT_REASONS.NOT_OWNER);
  assert.equal(reason(r, alive), REJECT_REASONS.NOT_OWNER, 'no member may delete another member\'s entry');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7c. Stage 3c — INV-R1 on the RECEIVING device (ADR 004 §2.2, barrier 4's mirror)
//
// Every other redaction barrier lives in `sealOp`, on the machine the author controls. These
// rows are about the machine they do NOT control: what the fold does with a `pub.set` that
// carries content the entity's own level does not carry, however it got sealed.
// ─────────────────────────────────────────────────────────────────────────────

test('S5(r) — a geteiltOnly value below Geteilt is DROPPED, and the rest of the op survives', () => {
  const { ops, e } = published({ level: 'belegt' });
  // The patched build: a real member, a real device, real authority over their own entity — and
  // a `pub.text` for an entry the family only ever agreed to see as Belegt.
  const leak = pubOp('fnote', ME, U1, { 'pub.date': '2026-10-01', 'pub.text': 'Scheidungsanwalt' },
    S(BASE + 800, 0, D[ME].short), { act: ME });
  const r = foldAuthorized([...ops, leak], CTX());

  assert.equal(registerValue(r.regs, e, 'pub.text'), null,
    'THE POINT: the value never reaches the register map — if this reads the string, S5(r) is back');
  assert.equal(registerValue(r.regs, e, 'pub.date'), '2026-10-01',
    'and the DATE survives: at Belegt a date is the legitimate payload, not content above the level');
  assert.equal(reason(r, leak), null, 'the op itself is admitted — only the field was refused');

  const rows = r.contentAboveLevel.filter((x) => x.opId === leak.id);
  assert.deepEqual(rows.map((x) => x.field), ['pub.text'], 'exactly one field is reported dropped');
  assert.equal(rows[0].level, 'belegt', 'the report says which level refused it');
  assert.equal(rows[0].e, e);
});

test('S5(r) — `admitted` hands back the REDACTED body, so re-applying it cannot undo the drop', () => {
  const { ops, e } = published({ level: 'belegt' });
  const leak = pubOp('fnote', ME, U1, { 'pub.date': '2026-10-01', 'pub.text': 'Scheidungsanwalt' },
    S(BASE + 800, 0, D[ME].short), { act: ME });
  const r = foldAuthorized([...ops, leak], CTX());

  const asFolded = r.admitted.find((o) => o.id === leak.id);
  assert.ok(asFolded, 'the op IS admitted');
  assert.deepEqual(Object.keys(asFolded.f), ['pub.date'],
    'the body in `admitted` is the body that was folded, not the body that arrived');

  // …and that is the whole reason it matters: `ops.contract.js` §3 lets a caller re-apply an
  // admitted op to the settled map. Handing back the original would put the value straight back.
  const copy = new Map();
  for (const [k, cells] of r.regs) copy.set(k, new Map(cells));
  assert.equal(applyOp(copy, asFolded), false, 're-applying an admitted op changes nothing (P2)');
  assert.equal(getValue(copy, e, 'pub.text'), null, 'and it certainly does not restore the text');
});

test('S5(r) — an explicit null is a WITHDRAWAL and passes at every level', () => {
  for (const level of ['privat', 'belegt', 'geteilt']) {
    const { ops, e } = published({ level: 'geteilt' });
    const down = pubOp('fnote', ME, U1, { 'pub.level': level, 'pub.text': null },
      S(BASE + 800, 0, D[ME].short), { act: ME });
    const r = foldAuthorized([...ops, down], CTX());
    assert.equal(reason(r, down), null, `${level}: the downgrade is admitted`);
    assert.equal(registerValue(r.regs, e, 'pub.text'), null, `${level}: the text is withdrawn`);
    assert.deepEqual(r.contentAboveLevel.filter((x) => x.opId === down.id), [],
      `${level}: a null is not "content above the level" and must not be reported as a drop`);
  }
});

test('S5(r) — the rule is RETROACTIVE: a later downgrade withdraws a legitimately-shared text', () => {
  // Sealed while the entry really WAS Geteilt. Nothing about this op was ever wrong.
  const { ops, e } = published({ level: 'geteilt' });
  assert.equal(foldAuthorized(ops, CTX()).regs.get(e).get('pub.text').value, 'Zahnarzt',
    'control: at Geteilt the text is readable, so the drop below is the level and not the fixture');

  // The owner downgrades — and, like an older build or a patched one, forgets the null.
  const down = pubOp('fnote', ME, U1, { 'pub.level': 'belegt' }, S(BASE + 900, 0, D[ME].short), { act: ME });
  const r = foldAuthorized([...ops, down], CTX());
  assert.equal(registerValue(r.regs, e, 'pub.text'), undefined,
    'THE POINT: the text goes even though the op that carried it was legitimate when it was sealed');
  assert.equal(registerValue(r.regs, e, 'pub.date'), '2026-09-10', 'the Belegt payload stays');

  // …and it does not depend on which op arrived first, which is the whole reason the rule reads
  // the FINAL folded level rather than the level at the offending op's stamp.
  const shuffled = foldAuthorized([down, ...ops], CTX());
  assert.deepEqual(snapshot(shuffled).regs, snapshot(r).regs);
});

test('S5(r) — at Privat nothing is published at all, not even the date', () => {
  const { ops, e } = published({ level: 'geteilt' });
  const down = pubOp('fnote', ME, U1, { 'pub.level': 'privat' }, S(BASE + 900, 0, D[ME].short), { act: ME });
  const r = foldAuthorized([...ops, down], CTX());
  for (const f of ['pub.text', 'pub.date', 'pub.repeatsYearly']) {
    assert.equal(registerValue(r.regs, e, f), undefined, `${f} is gone at Privat`);
  }
  assert.equal(registerValue(r.regs, e, 'pub.level'), 'privat', 'the governing register is NOT dropped');
  assert.equal(registerValue(r.regs, e, 'pub.alive'), true,
    'nor is `pub.alive` — governing registers are how a withdrawal is expressed');
});

test('S5(r) — an op the redaction empties is REJECTED, because `applyOp` refuses an empty patch', () => {
  const { ops, e } = published({ level: 'belegt' });
  const only = pubOp('fnote', ME, U1, { 'pub.text': 'nur Text' }, S(BASE + 800, 0, D[ME].short), { act: ME });
  const r = foldAuthorized([...ops, only], CTX());
  assert.equal(reason(r, only), REJECT_REASONS.CONTENT_ABOVE_LEVEL);
  assert.equal(r.rejectionOf(only.id).stage, STAGES[3]);
  assert.equal(r.admitted.some((o) => o.id === only.id), false,
    'an op with nothing applicable left may not sit in `admitted` — P2 would throw on it');
  assert.deepEqual(r.contentAboveLevel.filter((x) => x.opId === only.id).map((x) => x.field),
    ['pub.text'], 'it is still REPORTED — a rejection is not a reason to stop saying what was dropped');
});

test('S5(r) — a co-editor cannot unlock the field by asserting the level in the same patch', () => {
  // The receiving-side re-run of S5's own move: if the level cannot be declared at seal time,
  // try declaring it in the op the peer folds. `pub.level` is governing, so this is not a
  // co-edit at all and stage 3a refuses it before stage 3c is even asked.
  const { ops, e } = published({ level: 'belegt' });
  const grab = pubOp('fnote', ME, U1, { 'pub.level': 'geteilt', 'pub.text': 'fremd' },
    S(BASE + 800, 0, D[MAMA].short), { act: MAMA });
  const r = foldAuthorized([...ops, grab], CTX());
  assert.equal(reason(r, grab), REJECT_REASONS.NOT_OWNER);
  assert.equal(registerValue(r.regs, e, 'pub.level'), 'belegt', 'the level did not move');
  assert.equal(registerValue(r.regs, e, 'pub.text'), null, 'and the text did not land');
});

test('S5(r) — the honest Geteilt publication is untouched: the rule refuses, it does not blank', () => {
  const { ops, e } = published({ level: 'geteilt' });
  const r = foldAuthorized(ops, CTX());
  assert.equal(registerValue(r.regs, e, 'pub.text'), 'Zahnarzt');
  assert.equal(registerValue(r.regs, e, 'pub.date'), '2026-09-10');
  assert.deepEqual(r.contentAboveLevel, [], 'nothing is reported dropped on an honest log');
});

test('S5(r) — the report rides in the snapshot, so P5 covers it', () => {
  const { ops } = published({ level: 'belegt' });
  const leak = pubOp('fnote', ME, U1, { 'pub.date': '2026-10-01', 'pub.text': 'x' },
    S(BASE + 800, 0, D[ME].short), { act: ME });
  const a = snapshot(foldAuthorized([...ops, leak], CTX()));
  const b = snapshot(foldAuthorized([leak, ...ops.slice().reverse()], CTX()));
  assert.equal(a.contentAboveLevel.length, 1);
  assert.deepEqual(a.contentAboveLevel, b.contentAboveLevel,
    'a device that reported a redaction its peer did not would be exactly the divergence INV-R1 removes');
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Structural ownership — risk R10, adversarially
// ─────────────────────────────────────────────────────────────────────────────

test('there is no owner register to write: `owner` is an unknown field and parks the whole op', () => {
  const { ops } = published();
  const steal = {
    v: 1, id: rid('op'), ts: S(0, 0, '0000000000000000'), space: FSP, act: MAMA, dev: D[MAMA].id,
    gid: rid('g'), k: 'pub.set', e: familyKey('fnote', ME, U1), f: { owner: MAMA },
  };
  const r = foldAuthorized([...ops, steal], CTX());
  assert.equal(r.parkReasonOf(steal.id), PARK_REASONS.UNKNOWN_FIELD, 'unknown is parked, never applied');
  assert.equal(registerValue(r.regs, familyKey('fnote', ME, U1), 'owner'), undefined);
  for (const kind of Object.keys(FIELDS)) {
    for (const f of fieldsOf(kind)) {
      assert.ok(!/^owner|ownerId|seriesId$/i.test(f), `${kind}.${f} must not exist (ADR 001 §12.6)`);
    }
  }
});

test('a backdated write at ms=0 by anyone but the owner never lands, in 100 shuffles', () => {
  const { ops, e } = published();
  const attacks = [];
  const ZERO = '0000000000000000';
  for (const field of ['pub.level', 'pub.coEdit', 'pub.alive', 'pub.text', 'pub.date', '_born']) {
    const value = field === 'pub.level' ? 'privat'
      : field === 'pub.text' ? 'von Eve'
        : field === 'pub.date' ? '1970-01-01'
          : field === '_born' ? S(0, 0, ZERO) : true;
    attacks.push(pubOp('fnote', ME, U1, { [field]: value }, S(0, attacks.length, ZERO), { act: MAMA, dev: D[MAMA].id }));
    attacks.push(pubOp('fnote', ME, U1, { [field]: value }, S(0, 100 + attacks.length, ZERO), { act: PAPA, dev: D[PAPA].id }));
  }
  const all = [...ops, ...attacks];
  const rnd = mulberry32(4242);
  const base = snapshot(foldAuthorized(all, CTX()));
  for (let i = 0; i < 100; i++) {
    const r = foldAuthorized(shuffled(rnd, all), CTX());
    assert.deepEqual(snapshot(r), base, `shuffle ${i} changed the outcome`);
  }
  const r = foldAuthorized(all, CTX());
  for (const [field, cell] of r.regs.get(e)) {
    assert.equal(cell.author, ME, `${field} on my entity was authored by ${cell.author}`);
  }
  assert.equal(ownerOfEntity(e), ME);
});

test('no admissible op of any kind changes ownerOfEntity for any entity in the fold', () => {
  const { ops } = published();
  const rnd = mulberry32(99);
  const ZERO = '0000000000000000';
  const noise = [];
  const actors = [ME, MAMA, PAPA, EVE];
  for (let i = 0; i < 400; i++) {
    const act = actors[Math.floor(rnd() * actors.length)];
    const owner = rnd() < 0.5 ? ME : PAPA;
    const ms = rnd() < 0.5 ? 0 : BASE + Math.floor(rnd() * 5000);
    const dev = D[act].id;
    noise.push(pubOp('fnote', owner, rnd() < 0.5 ? U1 : U2,
      { 'pub.text': `n${i}`, }, S(ms, i % 900000, rnd() < 0.5 ? ZERO : D[act].short), { act, dev }));
  }
  const r = foldAuthorized([...ops, ...noise], CTX());
  for (const e of r.regs.keys()) {
    const parsed = parseEntityKey(e);
    assert.ok(parsed, `${e} is not a well-formed entity key`);
    // The owner is a literal segment of the key. It cannot be anything else, and no op rewrote a key.
    assert.equal(ownerOfEntity(e), parsed.kind === 'fnote' || parsed.kind === 'fbar' ? parsed.owner : null);
  }
  for (const op of r.admitted) {
    const owner = ownerOfEntity(op.e);
    if (owner === null) continue;
    const isUnshare = isAdminUnsharePatch(parseEntityKey(op.e).kind, op.f);
    assert.ok(op.act === owner || isUnshare || Object.keys(op.f).every((f) => (fieldSpec(parseEntityKey(op.e).kind, f) || {}).coEdit === true),
      `${op.act} wrote ${Object.keys(op.f)} on ${op.e}`);
  }
});

test('a key that could parse two ways is not a key at all', () => {
  // If a uuid could contain `/` or `:`, a member could mint a key that parses as somebody
  // else's entity. `parseEntityKey` refuses, so `validateOp` rejects, so nothing is folded.
  const bad = {
    v: 1, id: rid('op'), ts: S(BASE, 0, D[MAMA].short), space: FSP, act: MAMA, dev: D[MAMA].id,
    gid: rid('g'), k: 'pub.set', e: `fnote:${MAMA}/${ME}/${U1}`, f: { 'pub.text': 'x' },
  };
  const v = validateOp(bad);
  assert.equal(v.ok, false);
  assert.equal(v.park, false, 'a malformed key is a protocol violation, not version skew');
  const r = foldAuthorized([bad], CTX());
  assert.equal(r.admitted.length, 0);
  assert.equal(reason(r, bad), REJECT_REASONS.SHAPE);
});

test('the same uuid under two owners is two entities that never touch', () => {
  const f = family();
  const mine = pubOp('fnote', ME, U1, { 'pub.level': 'geteilt', 'pub.text': 'meins' }, S(BASE + 20, 0, D[ME].short), { act: ME });
  const hers = pubOp('fnote', MAMA, U1, { 'pub.level': 'geteilt', 'pub.text': 'ihres' }, S(BASE + 21, 0, D[MAMA].short), { act: MAMA });
  const r = foldAuthorized([...f.ops, mine, hers], CTX());
  assert.equal(registerValue(r.regs, familyKey('fnote', ME, U1), 'pub.text'), 'meins');
  assert.equal(registerValue(r.regs, familyKey('fnote', MAMA, U1), 'pub.text'), 'ihres');
  assert.notEqual(familyKey('fnote', ME, U1), familyKey('fnote', MAMA, U1));
});

test('the admin can unshare but cannot take, delete or rename another member\'s entity', () => {
  const f = family();
  const pub = pubOp('fnote', PAPA, U1, {
    'pub.level': 'geteilt', 'pub.coEdit': false, 'pub.alive': true,
    'pub.date': '2026-09-10', 'pub.text': 'Papas Termin', 'pub.repeatsYearly': false,
  }, S(BASE + 20, 0, D[PAPA].short), { act: PAPA });
  const del = pubOp('fnote', PAPA, U1, { 'pub.alive': false }, S(BASE + 700, 0, D[ME].short), { act: ME });
  const rename = pubOp('fnote', PAPA, U1, { 'pub.text': 'geaendert' }, S(BASE + 701, 0, D[ME].short), { act: ME });
  const r = foldAuthorized([...f.ops, pub, del, rename], CTX());
  assert.equal(reason(r, del), REJECT_REASONS.NOT_AN_UNSHARE);
  assert.equal(reason(r, rename), REJECT_REASONS.NO_COEDIT);
  assert.equal(registerValue(r.regs, familyKey('fnote', PAPA, U1), 'pub.text'), 'Papas Termin');
  assert.equal(registerValue(r.regs, familyKey('fnote', PAPA, U1), 'pub.alive'), true);
});

test('a forged member record plus a forged genesis still cannot reach my entity', () => {
  // The full attack, assembled: EVE self-attests, self-declares a member, forges a genesis for
  // the family space, declares herself admin, and unshares my entry.
  const { ops, e } = published();
  const eve = [
    attestOp(EVE, D[EVE], S(0, 0, '0000000000000000')),
    memberOp(EVE, { displayName: 'Eve', _alive: true }, S(0, 1, '0000000000000000')),
    spaceOp({ admin: EVE, adminPrev: null }, S(0, 2, '0000000000000000'), { act: EVE }),
  ];
  const unshare = pubOp('fnote', ME, U1, { ...unsharePatch('fnote') }, S(0, 3, '0000000000000000'), { act: EVE });
  const r = foldAuthorized([...ops, ...eve, unshare], CTX({ genesisOpId: undefined }));
  // Her genesis is at ms=0, ours at BASE+10: equal length, ours has the greater ts and wins.
  assert.equal(r.admin, ME);
  assert.equal(reason(r, unshare), REJECT_REASONS.NOT_OWNER);
  assert.equal(registerValue(r.regs, e, 'pub.text'), 'Zahnarzt');
  assert.equal(ownerOfEntity(e), ME);
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Order-independence — property P5, and the sync failure modes around it
// ─────────────────────────────────────────────────────────────────────────────

/** A rich fixture: honest traffic, races, a transfer, a removal, and an attacker. */
function busyWorld() {
  const { ops, genesis } = family();
  const out = [...ops];
  out.push(attestOp(EVE, D[EVE], S(BASE + 3, 0, D[EVE].short)));
  out.push(memberOp(EVE, { displayName: 'Eve', _alive: true }, S(BASE + 4, 0, D[EVE].short)));

  // ME publishes two entries, one Geteilt with co-edit and one Belegt.
  out.push(pubOp('fnote', ME, U1, {
    'pub.level': 'geteilt', 'pub.coEdit': true, 'pub.alive': true,
    'pub.date': '2026-09-10', 'pub.text': 'Zahnarzt', 'pub.repeatsYearly': false,
    _born: S(BASE + 20, 0, D[ME].short),
  }, S(BASE + 20, 0, D[ME].short), { act: ME }));
  out.push(pubOp('fbar', ME, U2, {
    'pub.level': 'belegt', 'pub.coEdit': null, 'pub.alive': true,
    'pub.startDate': '2026-10-01', 'pub.endDate': '2026-10-14', 'pub.label': null,
    _born: S(BASE + 21, 0, D[ME].short),
  }, S(BASE + 21, 0, D[ME].short), { act: ME }));

  // Concurrent co-edits of the same field from two devices, same millisecond.
  out.push(pubOp('fnote', ME, U1, { 'pub.text': 'Zahnarzt 14h' }, S(BASE + 30, 0, D[MAMA].short), { act: MAMA }));
  out.push(pubOp('fnote', ME, U1, { 'pub.text': 'Zahnarzt 15h' }, S(BASE + 30, 0, D[PAPA].short), { act: PAPA }));
  // A co-edit of a different field — different register, both survive (18.5).
  out.push(pubOp('fnote', ME, U1, { 'pub.date': '2026-09-11' }, S(BASE + 31, 0, D[MAMA].short), { act: MAMA }));
  // An illegal co-edit on the Belegt bar.
  out.push(pubOp('fbar', ME, U2, { 'pub.label': 'Urlaub' }, S(BASE + 32, 0, D[MAMA].short), { act: MAMA }));

  // Governance: transfer to MAMA, MAMA removes EVE, EVE fights back.
  out.push(spaceOp({ admin: MAMA, adminPrev: genesis.id }, S(BASE + 100, 0, D[ME].short), { act: ME, id: pad22('T1') }));
  out.push(memberOp(EVE, { _alive: false }, S(BASE + 110, 0, D[MAMA].short), { act: MAMA }));
  out.push(spaceOp({ admin: EVE, adminPrev: pad22('T1') }, S(BASE + 120, 0, D[EVE].short), { act: EVE }));
  out.push(pubOp('fnote', ME, U1, { 'pub.text': 'von Eve' }, S(0, 0, '0000000000000000'), { act: EVE }));

  // Personal + local traffic, including migrated GENESIS stamps at ms = 0.
  out.push(noteOp(U1, { _born: S(0, 0, '0000000000000000'), date: '2026-09-10', text: 'Zahnarzt', _alive: true }, S(0, 0, '0000000000000000')));
  out.push(noteOp(U1, { text: 'Zahnarzt, verschoben' }, S(BASE + 200, 0, D[ME].short)));
  out.push(mk('pref.set', PREF_KEY, { lastCategoryId: 'cat-1', 'layers.feiertage': true },
    { act: ME, dev: D[ME].id, ts: S(BASE + 201, 0, D[ME].short), space: 'local' }));
  return out;
}

test('P5 — 200 shuffles of the same set produce an identical result, byte for byte', () => {
  const ops = busyWorld();
  const rnd = mulberry32(1789);
  const base = snapshot(foldAuthorized(ops, CTX({ nowMs: BASE + 100000 })));
  for (let i = 0; i < 200; i++) {
    const s = snapshot(foldAuthorized(shuffled(rnd, ops), CTX({ nowMs: BASE + 100000 })));
    assert.deepEqual(s, base, `shuffle ${i} diverged`);
  }
  assert.ok(base.admitted.length > 10, 'the fixture must actually admit something');
});

test('P5 — reversal, the worst case for a streaming fold, changes nothing', () => {
  const ops = busyWorld();
  const fwd = snapshot(foldAuthorized(ops, CTX()));
  const rev = snapshot(foldAuthorized(ops.slice().reverse(), CTX()));
  assert.deepEqual(rev, fwd);
  assert.ok(fwd.rejected.length > 0, 'the fixture must actually reject something');
});

test('P5 — duplicate delivery at random multiplicity changes nothing', () => {
  const ops = busyWorld();
  const rnd = mulberry32(31337);
  const base = snapshot(foldAuthorized(ops, CTX()));
  for (let i = 0; i < 25; i++) {
    const dup = [];
    for (const op of shuffled(rnd, ops)) {
      const n = 1 + Math.floor(rnd() * 3);
      for (let j = 0; j < n; j++) dup.push(op);
    }
    assert.deepEqual(snapshot(foldAuthorized(shuffled(rnd, dup), CTX())), base, `multiplicity round ${i}`);
  }
  assert.equal(base.splicedIds.length, 0);
});

test('P3-shaped — a partition heals: three replicas, disjoint deliveries, then gossip', () => {
  const ops = busyWorld();
  const rnd = mulberry32(777);
  const full = snapshot(foldAuthorized(ops, CTX()));
  for (let round = 0; round < 20; round++) {
    const parts = [[], [], []];
    for (const op of shuffled(rnd, ops)) parts[Math.floor(rnd() * 3)].push(op);
    // Each replica sees its own partition first, then everything.
    for (const p of parts) {
      const healed = snapshot(foldAuthorized([...p, ...shuffled(rnd, ops)], CTX()));
      assert.deepEqual(healed, full, `replica diverged in round ${round}`);
    }
  }
  assert.ok(full.currentMembers.length >= 3);
});

test('P5 — a growing prefix never depends on the path it grew along', () => {
  // Two devices receive the same ops in different orders and re-fold from scratch after every
  // delivery. Every prefix of one must equal the same prefix SET on the other.
  const ops = busyWorld();
  const rnd = mulberry32(24680);
  const orderA = shuffled(rnd, ops);
  const orderB = shuffled(rnd, ops);
  for (let n = 1; n <= ops.length; n++) {
    const setA = orderA.slice(0, n);
    const same = new Set(setA.map((o) => o.id));
    const setB = orderB.filter((o) => same.has(o.id));
    assert.deepEqual(snapshot(foldAuthorized(setB, CTX())), snapshot(foldAuthorized(setA, CTX())), `prefix ${n}`);
  }
});

test('P5 — every output array, not just the register map, is a function of the set', () => {
  const ops = busyWorld();
  const rnd = mulberry32(5150);
  const base = foldAuthorized(ops, CTX());
  for (let i = 0; i < 30; i++) {
    const r = foldAuthorized(shuffled(rnd, ops), CTX());
    assert.deepEqual(admittedIds(r), admittedIds(base));
    assert.deepEqual(r.rejected.map((o) => o.id), base.rejected.map((o) => o.id));
    assert.deepEqual(r.parked.map((o) => o.id), base.parked.map((o) => o.id));
    assert.deepEqual([...r.currentMembers].sort(), [...base.currentMembers].sort());
    assert.equal(r.admin, base.admin);
  }
});

test('P5 — the rejection REASON is order-independent too, not merely the verdict', () => {
  // A reason that flipped between `noCoEdit` and `notMember` under reordering would mean two
  // devices disagreed about WHY, which is one refactor away from disagreeing about WHETHER.
  const ops = busyWorld();
  const rnd = mulberry32(60607);
  const base = foldAuthorized(ops, CTX());
  const want = Object.fromEntries(base.rejected.map((o) => [o.id, base.rejectionOf(o.id).reason]));
  for (let i = 0; i < 30; i++) {
    const r = foldAuthorized(shuffled(rnd, ops), CTX());
    assert.deepEqual(Object.fromEntries(r.rejected.map((o) => [o.id, r.rejectionOf(o.id).reason])), want);
  }
  assert.ok(Object.keys(want).length > 0);
});

test('the busy world resolves to the outcomes the ADR describes', () => {
  // A shuffle test that asserts only self-consistency can be satisfied by a fold that rejects
  // everything. This pins what the fixture actually MEANS.
  const r = foldAuthorized(busyWorld(), CTX());
  const e1 = familyKey('fnote', ME, U1);
  const e2 = familyKey('fbar', ME, U2);
  assert.equal(r.admin, MAMA, 'ME transferred to MAMA; EVE\'s counter-link is not signed by MAMA');
  assert.equal(r.currentMembers.has(EVE), false, 'MAMA removed EVE while admin');
  assert.equal(registerValue(r.regs, e1, 'pub.text'), 'Zahnarzt 15h', 'PAPA\'s deviceShort is the tiebreak');
  assert.equal(registerValue(r.regs, e1, 'pub.date'), '2026-09-11', 'a different register: both edits survive');
  assert.equal(registerValue(r.regs, e2, 'pub.label'), null, 'no co-editing a Belegt bar');
  assert.equal(registerValue(r.regs, noteKey(U1), 'text'), 'Zahnarzt, verschoben');
  assert.equal(registerValue(r.regs, PREF_KEY, 'layers.feiertage'), true);
});

test('a co-edit and a governance change racing across a partition converge', () => {
  const { ops, genesis } = family();
  const pub = pubOp('fnote', PAPA, U1, {
    'pub.level': 'geteilt', 'pub.coEdit': true, 'pub.alive': true,
    'pub.date': '2026-09-10', 'pub.text': 'Papa', 'pub.repeatsYearly': false,
  }, S(BASE + 20, 0, D[PAPA].short), { act: PAPA });
  const edit = pubOp('fnote', PAPA, U1, { 'pub.text': 'Mama war hier' }, S(BASE + 30, 0, D[MAMA].short), { act: MAMA });
  const transfer = spaceOp({ admin: MAMA, adminPrev: genesis.id }, S(BASE + 40, 0, D[ME].short), { act: ME });
  const unshare = pubOp('fnote', PAPA, U1, { ...unsharePatch('fnote') }, S(BASE + 50, 0, D[MAMA].short), { act: MAMA });
  const all = [...ops, pub, edit, transfer, unshare];
  const snaps = foldShuffles(all, CTX(), 50, 909);
  for (const s of snaps) assert.deepEqual(s, snaps[0]);
  const r = foldAuthorized(all, CTX());
  assert.equal(reason(r, unshare), null, 'MAMA is admin at BASE+50');
  assert.equal(registerValue(r.regs, familyKey('fnote', PAPA, U1), 'pub.level'), 'privat');
  assert.equal(registerValue(r.regs, familyKey('fnote', PAPA, U1), 'pub.text'), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Parking — never dropping (ADR 001 §7.4, §12.5)
// ─────────────────────────────────────────────────────────────────────────────

test('an unknown kind and an unknown field are parked with their op, not rejected', () => {
  const unknownKind = {
    v: 1, id: rid('op'), ts: S(BASE, 0, D[ME].short), space: PSP, act: ME, dev: D[ME].id,
    gid: rid('g'), k: 'reaction.set', e: noteKey(U1), f: { emoji: 'x' },
  };
  const unknownField = {
    v: 1, id: rid('op'), ts: S(BASE, 1, D[ME].short), space: PSP, act: ME, dev: D[ME].id,
    gid: rid('g'), k: 'note.set', e: noteKey(U1), f: { text: 'bekannt', mood: 'neu' },
  };
  const r = foldAuthorized([unknownKind, unknownField], CTX());
  assert.equal(r.parkReasonOf(unknownKind.id), PARK_REASONS.UNKNOWN_KIND);
  assert.equal(r.parkReasonOf(unknownField.id), PARK_REASONS.UNKNOWN_FIELD);
  assert.equal(r.parked.length, 2);
  assert.deepEqual(r.rejected, []);
  assert.equal(registerValue(r.regs, noteKey(U1), 'text'), undefined,
    'the known half of a not-fully-understood op must not be applied');
});

test('a future stamp is parked, and the SAME op is admitted once local time passes it', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const fromTheFuture = noteOp(U1, { text: 'morgen' }, S(BASE + DAY + 60000, 0, D[ME].short));
  const early = foldAuthorized([fromTheFuture], CTX({ nowMs: BASE }));
  assert.equal(early.parkReasonOf(fromTheFuture.id), PARK_REASONS.FUTURE);
  assert.equal(early.admitted.length, 0);
  const later = foldAuthorized([fromTheFuture], CTX({ nowMs: BASE + 2 * DAY }));
  assert.equal(later.parked.length, 0);
  assert.equal(registerValue(later.regs, noteKey(U1), 'text'), 'morgen');
});

test('there is no lower bound: a stamp at ms=0 is admitted at any nowMs (A4 / story 17.1)', () => {
  // The flaw that would have made a joining member's board empty of everything older than a
  // horizon. An op is NEVER discarded for being old (ADR 001 §1.3, §12.5).
  const ancient = noteOp(U1, { _born: S(0, 0, '0000000000000000'), text: 'aus 2019', date: '2019-03-01' },
    S(0, 0, '0000000000000000'));
  for (const nowMs of [0, BASE, BASE + 4e11]) {
    const r = foldAuthorized([ancient], CTX({ nowMs }));
    assert.equal(r.parked.length, 0, `parked at nowMs=${nowMs}`);
    assert.equal(registerValue(r.regs, noteKey(U1), 'text'), 'aus 2019');
  }
});

test('an op sealed under an epoch key we do not hold is parked, not rejected', () => {
  const op = noteOp(U1, { text: 'verschluesselt' }, S(BASE, 0, D[ME].short));
  const r = foldAuthorized([op], CTX({ haveEpochKey: false }));
  assert.equal(r.parkReasonOf(op.id), PARK_REASONS.EPOCH);
  assert.deepEqual(r.rejected, []);
  assert.equal(r.regs.size, 0);
});

test('a parked op never influences a stage, so parking cannot be used as a side channel', () => {
  const { ops } = published();
  const parked = {
    v: 1, id: rid('op'), ts: S(BASE + 800, 0, D[MAMA].short), space: FSP, act: MAMA, dev: D[MAMA].id,
    gid: rid('g'), k: 'pub.set', e: familyKey('fnote', ME, U1), f: { 'pub.coEdit': true, futureThing: 1 },
  };
  const withParked = foldAuthorized([...ops, parked], CTX());
  const without = foldAuthorized(ops, CTX());
  assert.equal(withParked.parkReasonOf(parked.id), PARK_REASONS.UNKNOWN_FIELD);
  assert.deepEqual(snapshot(withParked).regs, snapshot(without).regs);
  assert.deepEqual(snapshot(withParked).admitted, snapshot(without).admitted);
});

test('a shape violation is rejected, not parked — it is a protocol violation, not version skew', () => {
  const badType = {
    v: 1, id: rid('op'), ts: S(BASE, 0, D[ME].short), space: PSP, act: ME, dev: D[ME].id,
    gid: rid('g'), k: 'note.set', e: noteKey(U1), f: { repeatsYearly: 'yes' },
  };
  const r = foldAuthorized([badType], CTX());
  assert.equal(r.parked.length, 0);
  assert.equal(reason(r, badType), REJECT_REASONS.SHAPE);
  assert.equal(r.rejectionOf(badType.id).stage, STAGES[0]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Housekeeping the fold must not get wrong
// ─────────────────────────────────────────────────────────────────────────────

test('every declared reason code is actually reachable — except the one that is not', () => {
  // An enum member no code path can produce is a lie about what a caller may see. Every code is
  // triggered here from a real fixture; the single exception is documented, not hidden.
  const seen = new Set();
  const collect = (r) => { for (const o of r.rejected) seen.add(r.rejectionOf(o.id).reason); };

  const { ops, genesis } = family();
  const pub = pubOp('fnote', PAPA, U1, {
    'pub.level': 'geteilt', 'pub.coEdit': true, 'pub.alive': true,
    'pub.date': '2026-09-10', 'pub.text': 'Papa', 'pub.repeatsYearly': false,
  }, S(BASE + 20, 0, D[PAPA].short), { act: PAPA });

  collect(foldAuthorized([{
    v: 1, id: rid('op'), ts: S(BASE, 0, D[ME].short), space: PSP, act: ME, dev: D[ME].id,
    gid: rid('g'), k: 'note.set', e: noteKey(U1), f: { repeatsYearly: 'yes' },
  }], CTX()));                                                          // shape
  collect(foldAuthorized([...ops, mk('space.set', spaceKey(FSP2), { name: 'fremd' },
    { act: ME, dev: D[ME].id, ts: S(BASE + 50, 0, D[ME].short), space: FSP })], CTX()));   // spaceMismatch
  collect(foldAuthorized([mk('note.set', noteKey(U1), { text: 'x' },
    { act: MAMA, dev: D[MAMA].id, ts: S(BASE, 0, D[MAMA].short), space: PSP })], CTX()));  // notMyAct
  collect(foldAuthorized([noteOp(U1, { text: 'x' }, S(BASE, 0, D[ME].short), { dev: devIdOf('X') })],
    CTX({ myDevices: new Set([D[ME].id]) })));                          // notMyDevice
  collect(foldAuthorized([memberOp(EVE, { displayName: 'E' }, S(BASE, 0, D[EVE].short), { act: EVE })], CTX())); // unattestedDevice
  collect(foldAuthorized([attestOp(EVE, D[EVE], S(BASE, 0, D[EVE].short), { sigOver: 'nope' })], CTX())); // badAttestation
  collect(foldAuthorized([mk('member.set', memberKey(MAMA), {
    [`dev.${D[MAMA].short}`]: attBlob({ memberId: MAMA, deviceId: D[MAMA].id, deviceShort: D[MAMA].short }),
    displayName: 'Mama',
  }, { act: MAMA, dev: D[MAMA].id, ts: S(BASE, 0, D[MAMA].short), space: FSP })], CTX())); // mixedMemberPatch
  collect(foldAuthorized([attestOp(MAMA, D[MAMA], S(BASE, 0, D[MAMA].short)),
    mk('member.set', memberKey(MAMA), {
      [`dev.${D[MAMA].short}`]: attBlob({ memberId: MAMA, deviceId: devIdOf('EVIL'), deviceShort: D[MAMA].short }),
    }, { act: MAMA, dev: D[MAMA].id, ts: S(BASE + 9, 0, D[MAMA].short), space: FSP })], CTX())); // writeOnce
  collect(foldAuthorized([...ops, memberOp(MAMA, { displayName: 'Neu' }, S(BASE + 60, 0, D[ME].short), { act: ME })], CTX())); // notSelf
  collect(foldAuthorized([...ops, spaceOp({ name: 'X' }, S(BASE + 60, 0, D[MAMA].short), { act: MAMA })], CTX())); // notAdmin
  collect(foldAuthorized([...ops, spaceOp({ admin: EVE }, S(BASE + 60, 0, D[ME].short), { act: ME })], CTX())); // badAdminLink
  collect(foldAuthorized([...ops, spaceOp({ admin: EVE, adminPrev: genesis.id },
    S(BASE + 60, 0, D[MAMA].short), { act: MAMA })], CTX()));           // lostAdminChain
  collect(foldAuthorized([...ops, pub, pubOp('fnote', PAPA, U1, { 'pub.level': 'privat' },
    S(BASE + 60, 0, D[MAMA].short), { act: MAMA })], CTX()));           // notOwner
  // notAnUnshare — the patch does not set the level to privat at all, so it is not an unshare in
  // ANY version. (A patch that MEANS to unshare but carries something this build cannot read as a
  // withdrawal is PARKED, not rejected — see the version-skew tests above.)
  collect(foldAuthorized([...ops, pub, pubOp('fnote', PAPA, U1,
    { ...unsharePatch('fnote'), 'pub.level': 'belegt' }, S(BASE + 60, 0, D[ME].short), { act: ME })], CTX())); // notAnUnshare
  collect(foldAuthorized([...ops, pubOp('fnote', PAPA, U1, { 'pub.level': 'geteilt', 'pub.coEdit': false },
    S(BASE + 20, 0, D[PAPA].short), { act: PAPA }),
  pubOp('fnote', PAPA, U1, { 'pub.text': 'x' }, S(BASE + 60, 0, D[MAMA].short), { act: MAMA })], CTX())); // noCoEdit
  collect(foldAuthorized([...ops, pubOp('fnote', PAPA, U1, { 'pub.level': 'belegt', 'pub.coEdit': true },
    S(BASE + 20, 0, D[PAPA].short), { act: PAPA }),
  pubOp('fnote', PAPA, U1, { 'pub.text': 'x' }, S(BASE + 60, 0, D[MAMA].short), { act: MAMA })], CTX())); // notGeteilt
  collect(foldAuthorized([...ops, pub, memberOp(MAMA, { _alive: false }, S(BASE + 50, 0, D[MAMA].short)),
    pubOp('fnote', PAPA, U1, { 'pub.text': 'x' }, S(BASE + 60, 0, D[MAMA].short), { act: MAMA })], CTX())); // notMember
  // contentAboveLevel — stage 3c, and reachable only when the redaction empties the patch. The
  // OWNER writes `pub.text` (the `geteiltOnly` field) to their own entity while it stands at
  // Belegt: nothing about the authority is wrong, and nothing of the patch survives the level.
  collect(foldAuthorized([...ops, pubOp('fnote', PAPA, U1, { 'pub.level': 'belegt' },
    S(BASE + 20, 0, D[PAPA].short), { act: PAPA }),
  pubOp('fnote', PAPA, U1, { 'pub.text': 'x' }, S(BASE + 60, 0, D[PAPA].short), { act: PAPA })], CTX())); // contentAboveLevel

  // notAlive — stage 3b's THIRD governing register, landed with E9-A §1i. The entry is Geteilt
  // and co-editable, the owner deletes it (18.6), and a co-editor writes to the corpse. The
  // author side (`store.familyCoEditLevelOf`) always refused this; the receiving side did not.
  collect(foldAuthorized([...ops, pub,
    pubOp('fnote', PAPA, U1, { 'pub.alive': false }, S(BASE + 40, 0, D[PAPA].short), { act: PAPA }),
    pubOp('fnote', PAPA, U1, { 'pub.text': 'x' }, S(BASE + 60, 0, D[MAMA].short), { act: MAMA })], CTX())); // notAlive

  const declared = Object.values(REJECT_REASONS).sort();
  const unreachable = [REJECT_REASONS.NOT_COEDITABLE];   // see the "defence in depth" test above
  assert.deepEqual([...seen].sort(), declared.filter((r) => !unreachable.includes(r)));
  assert.equal(seen.has(REJECT_REASONS.NOT_COEDITABLE), false);
});


test('an empty op set folds to an empty, well-formed result', () => {
  const r = foldAuthorized([], CTX());
  assert.equal(r.regs.size, 0);
  assert.equal(r.admin, null);
  assert.deepEqual([...r.currentMembers], []);
  assert.deepEqual(r.admitted, []);
  assert.equal(r.adminAt(S(BASE, 0, D[ME].short)), null);
});

test('registerOf / registerValue tell an absent register apart from an explicit null', () => {
  const { ops, e } = published({ level: 'belegt' });
  const r = foldAuthorized(ops, CTX());
  assert.equal(registerValue(r.regs, e, 'pub.text'), null, 'Belegt wrote an explicit null');
  assert.equal(registerValue(r.regs, e, 'pub.repeatsYearly'), false);
  assert.equal(registerOf(r.regs, e, 'pub.text').author, ME);
  assert.equal(registerOf(r.regs, e, 'nichtVorhanden'), null);
  assert.equal(registerValue(r.regs, 'note:nope', 'text'), undefined);
});

test('two family spaces keep separate admin chains and do not bleed', () => {
  resetIds();
  const a = [
    attestOp(ME, D[ME], S(BASE, 0, D[ME].short)),
    memberOp(ME, { displayName: 'Ich', _alive: true }, S(BASE, 1, D[ME].short)),
    spaceOp({ admin: ME, adminPrev: null }, S(BASE + 10, 0, D[ME].short), { act: ME, spaceId: FSP }),
    attestOp(MAMA, D[MAMA], S(BASE + 1, 0, D[MAMA].short), { space: FSP2 }),
    spaceOp({ admin: MAMA, adminPrev: null }, S(BASE + 11, 0, D[MAMA].short), { act: MAMA, spaceId: FSP2 }),
  ];
  const r = foldAuthorized(a, CTX());
  assert.equal(r.adminOfSpace(FSP), ME);
  assert.equal(r.adminOfSpace(FSP2), MAMA);
  assert.equal(r.admin, null, 'with two spaces the singular accessor declines to guess');
  assert.equal(r.adminAt(S(BASE + 100, 0, D[ME].short)), null);
});

test('the register map iterates deterministically, so downstream Map order is stable too', () => {
  // `materialize()` sorts its arrays, but any code that walks `regs` directly (a checkpoint
  // serializer, a diff) inherits Map insertion order. It must not carry arrival order into a file.
  const ops = busyWorld();
  const rnd = mulberry32(8080);
  const keysOf = (r) => [...r.regs.keys()].map((e) => `${e}|${[...r.regs.get(e).keys()].join(',')}`);
  const base = keysOf(foldAuthorized(ops, CTX()));
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(keysOf(foldAuthorized(shuffled(rnd, ops), CTX())), base, `iteration order changed on shuffle ${i}`);
  }
  assert.ok(base.length > 5);
});

test('every admitted op is frozen and was not mutated by the fold', () => {
  const ops = busyWorld();
  const before = ops.map((o) => JSON.stringify(o));
  const r = foldAuthorized(ops, CTX());
  assert.deepEqual(ops.map((o) => JSON.stringify(o)), before, 'foldAuthorized mutated an input op');
  for (const op of r.admitted) assert.ok(Object.isFrozen(op));
  assert.ok(r.admitted.length > 0);
});

test('cmp on stamps is the only comparator the chain uses, and it is a plain string order', () => {
  // Guards against a refactor to numeric comparison, which would break at the 13-digit boundary.
  const a = S(BASE, 0, D[ME].short);
  const b = S(BASE, 1, D[ME].short);
  const c = S(BASE + 1, 0, D[ME].short);
  assert.equal(cmp(a, b), -1);
  assert.equal(cmp(b, c), -1);
  assert.equal(cmp(a, a), 0);
  assert.ok(a < b && b < c, 'fixed width means plain `<` is the same order');
});
