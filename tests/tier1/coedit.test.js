// tests/tier1/coedit.test.js — E9: OWNER-ONLY EDITING (18.1) AND THE CO-EDIT FLAG (18.2).
// LZP-901 · LZP-902 · decision D7 · ADR 001 §4.2, §4.3, §4.4 · ADR 004 §8 · A7.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE IS FOR, AND WHY IT IS NOT A SECOND `core-authz.test.js`
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `core-authz.test.js` already characterizes the co-edit predicate INSIDE one Familienkreis —
// coEdit/level/membership/field, the retroactive withdrawal, the 3c redaction. Every row there
// stays green and none of it is repeated here. This file adds the two things E9 found that the
// existing suite could not see, because both need a SECOND circle or a THIRD reader:
//
//  §1  MEMBERSHIP WAS GLOBAL WHERE THE LOG SAYS IT IS PER SPACE. Three attacks, all of which the
//      fold ADMITTED before this ticket, and each of which is 18.1 broken in the exact words the
//      story uses — „nobody's plans can be rewritten behind their back":
//
//        E9-1  Eve, admin of a circle SHE invented, unshares Mama's entry in a circle she is not
//              in. `adminAtKey` resolved the admin of `op.space` — correctly — and the register
//              map is keyed by ENTITY, so it landed on Mama's real registers.
//        E9-2  the same lever with a co-edit write: `pub.text: 'gekapert'`, admitted because
//              stage 3b asked the UNION `currentMembers` whether Eve was "a member".
//        E9-3  and the floor: Eve files a self-authorizing `dev.*` attestation in her own space
//              and writes into MINE, on MY entity. She had never been invited to anything.
//
//      The fix is one rule — `authz.js` §4.2b — and it is stated in the terms §4.4 already uses:
//      a family entity's SPACE is not a fourth thing to assert, it is read off the key, through
//      the owner. Both halves of it are exercised separately below, because a fix that only
//      checked the author would leave E9-1 open and one that only checked the owner would leave
//      E9-3 open.
//
//  §4  ONE PREDICATE, THREE READERS. „may I edit this entry?" had three implementations —
//      `layout.js` (the board's pixels), `interact.js` (the pointer state machine) and
//      `family/sharing.js` (the popover) — and they disagreed on three of the thirty cells of
//      the input domain. The whole domain is enumerated here as data, and the three functions
//      are compared cell by cell, so a fourth copy cannot be added quietly.
//
// NO TEST READS THE WALL CLOCK (ADR 005 §5). Every stamp is a literal; every id is a counter.

import test from 'node:test';
import assert from 'node:assert/strict';

import { foldAuthorized, snapshot, REJECT_REASONS, registerValue } from '../../src/js/core/authz.js';
import { fmt } from '../../src/js/core/stamp.js';
import { b64u } from '../../src/js/core/b64.js';
import { canonicalBytes, utf8, utf8Decode } from '../../src/js/core/canon.js';
import { ub64 } from '../../src/js/core/b64.js';
import { validateOp, FIELDS, fieldSpec } from '../../src/js/core/ops.js';
import { memberKey, spaceKey, familyKey, VISIBILITY_LEVELS } from '../../src/js/core/entities.js';
import { allowsCoEdit } from '../../src/js/core/visibility.js';

import { canEditEntry as layoutCanEdit } from '../../src/js/layout.js';
import { canEdit as interactCanEdit } from '../../src/js/interact.js';
import * as sharing from '../../src/js/family/sharing.js';
import { setLang } from '../../src/js/i18n.js';

// ─────────────────────────────────────────────────────────────────────────────
// 0 · harness — deterministic, injected, wall-clock-free
// ─────────────────────────────────────────────────────────────────────────────

const pad22 = (s) => (s + '----------------------').slice(0, 22);
const short16 = (s) => (s + '0000000000000000').slice(0, 16);

const memId = (tag) => `mem_${pad22(tag)}`;
const devIdOf = (tag) => `dev_${pad22(tag)}`;

const ME = memId('ME');
const MAMA = memId('MAMA');
const EVE = memId('EVE');            // a real person with a real Mac — and no invitation

const FSP = `fsp_${pad22('FAM')}`;         // my Familienkreis
const FSP_EVIL = `fsp_${pad22('EVIL')}`;   // the one Eve made for herself

const D = {
  [ME]: { id: devIdOf('DME'), short: short16('DME') },
  [MAMA]: { id: devIdOf('DMAMA'), short: short16('DMAMA') },
  [EVE]: { id: devIdOf('DEVE'), short: short16('DEVE') },
};

const U1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';        // an entry of MAMA's
const U_MINE = 'cccccccc-3333-4333-8333-cccccccccccc';    // an entry of mine

const BASE = 1787836800000;                 // a fixed millisecond. Never Date.now.
const S = (ms, ctr, dev) => fmt(ms, ctr, dev);

let seq = 0;
const rid = (tag) => pad22(`${tag}${++seq}`);
const resetIds = () => { seq = 0; };

/** The ADR 002 §2.3 wire form. The "signature" is checkable without WebCrypto on purpose: what
 *  is under test here is the BINDING, not the primitive. */
function attBlob(memberId, dev) {
  const att = {
    memberId,
    deviceId: dev.id,
    deviceShort: dev.short,
    sigPubRaw: b64u(utf8(`sigpub:${dev.id}`)),
    kexPubRaw: b64u(utf8(`kexpub:${dev.id}`)),
    createdAt: '2026-08-25',
  };
  return `${b64u(canonicalBytes(att))}.${b64u(utf8(`sig:${memberId}:${dev.id}`))}`;
}

function verifier(memberId, blob) {
  const dot = blob.indexOf('.');
  if (dot < 0) return false;
  try {
    const att = JSON.parse(utf8Decode(ub64(blob.slice(0, dot))));
    return att.memberId === memberId
      && utf8Decode(ub64(blob.slice(dot + 1))) === `sig:${att.memberId}:${att.deviceId}`;
  } catch { return false; }
}

/** Build one op, refusing to build an invalid one — a fixture must not smuggle junk past the door. */
function mk(k, e, f, o) {
  const op = {
    v: 1,
    id: o.id ?? rid('op'),
    ts: o.ts,
    space: o.space,
    act: o.act,
    dev: o.dev ?? D[o.act].id,
    gid: o.gid ?? rid('g'),
    k,
    e,
    f,
  };
  const v = validateOp(op);
  if (!v.ok) throw new Error(`fixture built an invalid op: ${v.reason}`);
  Object.freeze(op.f);
  return Object.freeze(op);
}

const attestOp = (m, space, ms) =>
  mk('member.set', memberKey(m), { [`dev.${D[m].short}`]: attBlob(m, D[m]) },
    { act: m, ts: S(ms, 0, D[m].short), space });

const memberOp = (m, f, space, ms, act = m) =>
  mk('member.set', memberKey(m), f, { act, ts: S(ms, 1, D[act].short), space });

const genesisOp = (admin, spaceId, ms) =>
  mk('space.set', spaceKey(spaceId), { admin, adminPrev: null, name: 'Familie' },
    { act: admin, ts: S(ms, 0, D[admin].short), space: spaceId });

const pubOp = (kind, owner, uuid, f, act, space, ms, ctr = 0) =>
  mk('pub.set', familyKey(kind, owner, uuid), f, { act, ts: S(ms, ctr, D[act].short), space });

const CTX = (over = {}) => ({ me: ME, attestVerify: verifier, ...over });

/**
 * MY Familienkreis: ME (admin) and MAMA, both attested, both with member records — and one
 * entry each, published Geteilt. `coEdit` on Mama's is the parameter, because 18.2 is exactly
 * the difference between the two worlds.
 */
function circle({ coEdit = true } = {}) {
  resetIds();
  const ops = [
    attestOp(ME, FSP, BASE),
    memberOp(ME, { displayName: 'Ich', _alive: true }, FSP, BASE),
    attestOp(MAMA, FSP, BASE + 1),
    memberOp(MAMA, { displayName: 'Mama', _alive: true }, FSP, BASE + 1),
    genesisOp(ME, FSP, BASE + 10),
  ];
  const mamasEntry = pubOp('fnote', MAMA, U1, {
    'pub.level': 'geteilt', 'pub.coEdit': coEdit, 'pub.alive': true,
    'pub.date': '2026-12-24', 'pub.text': 'Bescherung', _born: S(BASE + 20, 0, D[MAMA].short),
  }, MAMA, FSP, BASE + 20);
  const myEntry = pubOp('fnote', ME, U_MINE, {
    'pub.level': 'geteilt', 'pub.coEdit': coEdit, 'pub.alive': true,
    'pub.date': '2026-12-31', 'pub.text': 'Silvester', _born: S(BASE + 21, 0, D[ME].short),
  }, ME, FSP, BASE + 21);
  return { ops: [...ops, mamasEntry, myEntry], mamasEntry, myEntry };
}

/** Eve's OWN circle, where she is admin because genesis is self-authorizing (A2 — still open). */
function evesCircle() {
  return [
    attestOp(EVE, FSP_EVIL, BASE + 30),
    memberOp(EVE, { displayName: 'Eve', _alive: true }, FSP_EVIL, BASE + 30),
    genesisOp(EVE, FSP_EVIL, BASE + 31),
  ];
}

const verdictOf = (r, op) => {
  const rej = r.rejectionOf(op.id);
  if (rej) return `rejected:${rej.reason}`;
  if (r.parked.some((p) => p && p.id === op.id)) return 'parked';
  return r.admitted.some((o) => o.id === op.id) ? 'admitted' : 'missing';
};
const valueAt = (r, key, field) => registerValue(r.regs, key, field);

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

const MAMAS_KEY = familyKey('fnote', MAMA, U1);
const MY_KEY = familyKey('fnote', ME, U_MINE);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · THE THREE CROSS-SPACE ATTACKS — 18.1, from outside the Familienkreis
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('E9-0 CONTROL: inside one circle, everything 18.1 and 18.2 promise still works', () => {
  // Without this row the three that follow prove only that the fold refuses things. It has to
  // refuse the RIGHT things, so first: the honest co-edit lands, and the honest refusal refuses.
  const c = circle({ coEdit: true });
  const mineEditedByMama = pubOp('fnote', ME, U_MINE, { 'pub.text': 'von Mama' },
    MAMA, FSP, BASE + 40);
  const r = foldAuthorized([...c.ops, mineEditedByMama], CTX());
  assert.equal(verdictOf(r, mineEditedByMama), 'admitted', 'the invited co-edit is admitted');
  assert.equal(valueAt(r, MY_KEY, 'pub.text'), 'von Mama');

  const off = circle({ coEdit: false });
  const refused = pubOp('fnote', ME, U_MINE, { 'pub.text': 'von Mama' }, MAMA, FSP, BASE + 40);
  const r2 = foldAuthorized([...off.ops, refused], CTX());
  assert.equal(verdictOf(r2, refused), `rejected:${REJECT_REASONS.NO_COEDIT}`,
    '18.1 by default: without the flag, a member of my own circle may not write my entry');
  assert.equal(valueAt(r2, MY_KEY, 'pub.text'), 'Silvester', 'and the text did not move');
});

test('E9-1 CLOSED: admin of a circle Eve invented cannot unshare an entry in mine', () => {
  const c = circle();
  // The unshare SHAPE is the legitimate §4.3 one — this is not a malformed-op test. What is
  // wrong with it is the jurisdiction, and nothing else.
  const kill = pubOp('fnote', MAMA, U1, {
    'pub.level': 'privat', 'pub.coEdit': null, 'pub.alive': null,
    'pub.date': null, 'pub.text': null,
  }, EVE, FSP_EVIL, BASE + 40);

  const r = foldAuthorized([...c.ops, ...evesCircle(), kill], CTX());

  assert.equal(r.adminOfSpace(FSP), ME, 'I am still admin of my circle…');
  assert.equal(r.adminOfSpace(FSP_EVIL), EVE, '…and Eve is still admin of hers');
  assert.equal(verdictOf(r, kill), `rejected:${REJECT_REASONS.NOT_MEMBER}`,
    'the OWNER half of §4.2b: Mama is not a member of Eve\'s space, so the entity is not there '
    + 'to govern — refused before the admin question is even asked');
  assert.equal(valueAt(r, MAMAS_KEY, 'pub.level'), 'geteilt', 'Mama\'s entry is still shared');
  assert.equal(valueAt(r, MAMAS_KEY, 'pub.text'), 'Bescherung');
});

test('E9-2 CLOSED: nor can she co-edit into it from her own circle', () => {
  const c = circle({ coEdit: true });
  const hijack = pubOp('fnote', MAMA, U1, { 'pub.text': 'gekapert' }, EVE, FSP_EVIL, BASE + 40);
  const r = foldAuthorized([...c.ops, ...evesCircle(), hijack], CTX());
  assert.equal(verdictOf(r, hijack), `rejected:${REJECT_REASONS.NOT_MEMBER}`);
  assert.equal(valueAt(r, MAMAS_KEY, 'pub.text'), 'Bescherung',
    'the co-edit grant Mama made to HER family is not a grant to every family');
});

test('E9-3 CLOSED: a self-attested outsider cannot write into MY space, on MY entity', () => {
  // The worst of the three, because Eve has no circle to hide behind and needs no admin role.
  // A `dev.*` register is self-authorizing by design (an attestation cannot require an attested
  // device to author it — infinite regress), and stage 0b's device table is keyed by member, not
  // by space. So her device gate passed and the UNION `currentMembers` called her a member.
  const c = circle({ coEdit: true });
  const eveAttestsHerself = attestOp(EVE, FSP_EVIL, BASE + 30);
  const hijack = pubOp('fnote', ME, U_MINE, { 'pub.text': 'gekapert' }, EVE, FSP, BASE + 40);

  const r = foldAuthorized([...c.ops, eveAttestsHerself, hijack], CTX());

  assert.equal(verdictOf(r, hijack), `rejected:${REJECT_REASONS.NOT_MEMBER}`,
    'the AUTHOR half of §4.2b — the half the owner check alone would not have caught');
  assert.equal(valueAt(r, MY_KEY, 'pub.text'), 'Silvester');
  // The union accessor is unchanged and still reports her: `currentMembers` is what
  // `ops.contract.js` §4 publishes and what `materialize.js` reads for display names. The point
  // of the fix is that it is no longer the AUTHORITY question.
  assert.equal(r.currentMembers.has(EVE), true,
    'the published union is deliberately untouched — authority is asked per space, not here');
});

test('E9-3b: the same op, from a member who IS in my circle, is admitted — the gate is the space', () => {
  // The mirror of E9-3, and the reason it is not simply "reject anything unexpected": change
  // exactly one thing about the attack — put Eve's member record in MY space instead of hers —
  // and the identical op is admitted. The predicate is membership of `op.space` and nothing else.
  const c = circle({ coEdit: true });
  const eveJoinsForReal = [
    attestOp(EVE, FSP, BASE + 30),
    memberOp(EVE, { displayName: 'Eve', _alive: true }, FSP, BASE + 30),
  ];
  const edit = pubOp('fnote', ME, U_MINE, { 'pub.text': 'von Eve' }, EVE, FSP, BASE + 40);
  const r = foldAuthorized([...c.ops, ...eveJoinsForReal, edit], CTX());
  assert.equal(verdictOf(r, edit), 'admitted');
  assert.equal(valueAt(r, MY_KEY, 'pub.text'), 'von Eve');
});

test('E9-4: an EVICTED member of my own circle loses the same power, at any stamp', () => {
  // §4.2b reads the FINAL `_alive`, not "was she a member at `op.ts`" — so backdating below the
  // eviction, which is what defeats the admin CHAIN query (attack row A4, still open), buys
  // nothing against membership. This is the inverse of `ownership-authz-admin.test.js` A4b.
  const c = circle({ coEdit: true });
  const joined = [
    attestOp(EVE, FSP, BASE + 30),
    memberOp(EVE, { displayName: 'Eve', _alive: true }, FSP, BASE + 30),
  ];
  const evict = memberOp(EVE, { _alive: false }, FSP, BASE + 50, ME);
  const backdated = pubOp('fnote', ME, U_MINE, { 'pub.text': 'gekapert' }, EVE, FSP, BASE + 35);
  const alsoAtZero = pubOp('fnote', ME, U_MINE, { 'pub.repeatsYearly': true }, EVE, FSP, 0);

  const r = foldAuthorized([...c.ops, ...joined, evict, backdated, alsoAtZero], CTX());
  assert.equal(r.currentMembers.has(EVE), false);
  assert.equal(verdictOf(r, backdated), `rejected:${REJECT_REASONS.NOT_MEMBER}`);
  assert.equal(verdictOf(r, alsoAtZero), `rejected:${REJECT_REASONS.NOT_MEMBER}`,
    'ms = 0 is not a loophole here either (property P9\'s neighbourhood)');
  assert.equal(valueAt(r, MY_KEY, 'pub.text'), 'Silvester');
});

test('E9-5: the OWNER is gated too, and the gate is RETROACTIVE — story 20.2, at the fold', () => {
  // Not a special case bolted on: §4.2b is one rule about the space, and the owner is one of the
  // two people it names.
  //
  // ⚠ IT READS THE **FINAL** `_alive`, exactly as stage 3b's co-edit predicate reads the final
  // `pub.coEdit`, and for the same reason: admissibility must not depend on which op the folding
  // device happened to see first. So an eviction does not merely stop the NEXT publication, it
  // withdraws every one that came before — the whole entity leaves the register map.
  //
  // THAT IS 20.2 ("a removed member's entries vanish at once"), not a new severity, and the
  // board cannot tell the difference: `materialize.js:projectable` already drops a foreign entry
  // whose owner is `∉ currentMembers`, so the pixels were identical before this ticket. What
  // changed is that the registers agree with the pixels instead of holding content the viewer is
  // no longer entitled to. The five removal/re-join fleet files are the oracle for that claim and
  // all five stay green.
  const c = circle();
  const evictMama = memberOp(MAMA, { _alive: false }, FSP, BASE + 50, ME);
  const afterwards = pubOp('fnote', MAMA, U1, { 'pub.text': 'trotzdem' }, MAMA, FSP, BASE + 60);

  const before = foldAuthorized(c.ops, CTX());
  assert.equal(valueAt(before, MAMAS_KEY, 'pub.text'), 'Bescherung', 'precondition: it was there');

  const r = foldAuthorized([...c.ops, evictMama, afterwards], CTX());
  assert.equal(verdictOf(r, afterwards), `rejected:${REJECT_REASONS.NOT_MEMBER}`,
    'the publication authored after the eviction is refused');
  assert.equal(verdictOf(r, c.mamasEntry), `rejected:${REJECT_REASONS.NOT_MEMBER}`,
    'and so is the one authored before it — the fold reads the final membership, not the stamp');
  assert.equal(valueAt(r, MAMAS_KEY, 'pub.text'), undefined, 'nothing of hers is in the map');
  assert.equal(valueAt(r, MY_KEY, 'pub.text'), 'Silvester', 'and MY entry is untouched');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · THE GATE IS A FUNCTION OF THE SET (property P5) — or it is not a fold rule at all
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('E9 P5: 100 shuffles of the whole hostile world produce one identical snapshot', () => {
  // D7's entire claim is that every honest client applies the SAME deterministic fold. A gate
  // whose verdict depended on arrival order would not be enforcement, it would be a race — one
  // Mac showing „gekapert" and another „Bescherung", with no way to tell which is right.
  const c = circle({ coEdit: true });
  const world = [
    ...c.ops,
    ...evesCircle(),
    pubOp('fnote', MAMA, U1, {
      'pub.level': 'privat', 'pub.coEdit': null, 'pub.alive': null, 'pub.date': null, 'pub.text': null,
    }, EVE, FSP_EVIL, BASE + 40),
    pubOp('fnote', MAMA, U1, { 'pub.text': 'gekapert' }, EVE, FSP_EVIL, BASE + 41),
    pubOp('fnote', ME, U_MINE, { 'pub.text': 'auch gekapert' }, EVE, FSP, BASE + 42),
    pubOp('fnote', ME, U_MINE, { 'pub.text': 'von Mama' }, MAMA, FSP, BASE + 43),
  ];
  const base = snapshot(foldAuthorized(world, CTX()));
  const rnd = mulberry32(20260902);
  for (let i = 0; i < 100; i++) {
    assert.deepEqual(snapshot(foldAuthorized(shuffled(rnd, world), CTX())), base,
      `the fold disagreed with itself on shuffle ${i}`);
  }
  // …and the one honest write in that pile is the one that landed.
  const r = foldAuthorized(world, CTX());
  assert.equal(valueAt(r, MY_KEY, 'pub.text'), 'von Mama');
  assert.equal(valueAt(r, MAMAS_KEY, 'pub.level'), 'geteilt');
});

test('E9 P5: a partial delivery cannot admit what the full set refuses', () => {
  // The order-independence above is over one complete set. This is the other half: a device that
  // has pulled only SOME of the world — no causal delivery anywhere in this product — must not
  // reach a more permissive verdict on any prefix. (Stage 0b's `UNATTESTED_DEVICE` is the seam
  // that makes a genuinely-early op survivable, and `store.js:CURABLE_REFUSALS` re-offers it.)
  const c = circle({ coEdit: true });
  const hijack = pubOp('fnote', ME, U_MINE, { 'pub.text': 'gekapert' }, EVE, FSP, BASE + 42);
  const full = [...c.ops, attestOp(EVE, FSP_EVIL, BASE + 30), ...evesCircle().slice(1), hijack];
  const rnd = mulberry32(7);
  for (let i = 0; i < 40; i++) {
    const prefix = shuffled(rnd, full).slice(0, 1 + Math.floor(rnd() * full.length));
    if (!prefix.includes(hijack)) continue;
    const r = foldAuthorized(prefix, CTX());
    assert.notEqual(verdictOf(r, hijack), 'admitted',
      `a prefix admitted the hijack that the full set refuses (iteration ${i})`);
    assert.notEqual(valueAt(r, MY_KEY, 'pub.text'), 'gekapert');
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · 18.1's SECOND VERB — „edit **or delete**"
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('18.1: `pub.alive` is a GOVERNING field, so a co-editor can never delete', () => {
  // The flag is „Familie darf bearbeiten", not „…darf löschen". That is not enforced by a
  // separate rule; it falls out of the field table, and this row pins the field table so the
  // sentence in the UI stays true of the model.
  for (const kind of ['fnote', 'fbar']) {
    assert.equal(FIELDS[kind]['pub.alive'].gov, true, `${kind}.pub.alive must be governing`);
    assert.notEqual(FIELDS[kind]['pub.alive'].coEdit, true);
  }
  const c = circle({ coEdit: true });
  const del = pubOp('fnote', ME, U_MINE, { 'pub.alive': false }, MAMA, FSP, BASE + 40);
  const r = foldAuthorized([...c.ops, del], CTX());
  assert.equal(verdictOf(r, del), `rejected:${REJECT_REASONS.NOT_OWNER}`,
    'a governing field takes stage 3a, where only the owner and the unsharing admin exist');
  assert.equal(valueAt(r, MY_KEY, 'pub.alive'), true);
});

test('18.3 stays non-destructive: the admin unshare cannot be a deletion in disguise', () => {
  // „it reverts to owner-private, it is never deleted". The admin path admits exactly the
  // withdrawal shape; `pub.alive: false` beside it is not one, and the verdict is a PARK rather
  // than a rejection on purpose (`PARK_REASONS.UNSHARE_SHAPE`) — a wrongly-final rejection of an
  // unshare would leave previously-hidden content visible, so the op is retained for a build
  // that can read it. Either way it is not folded, which is the property under test.
  const c = circle();
  const disguised = pubOp('fnote', MAMA, U1, {
    'pub.level': 'privat', 'pub.alive': false,
  }, ME, FSP, BASE + 40);
  const r = foldAuthorized([...c.ops, disguised], CTX());
  assert.equal(verdictOf(r, disguised), 'parked', 'not admitted, and not thrown away either');
  assert.equal(valueAt(r, MAMAS_KEY, 'pub.alive'), true, 'Mama\'s entry still exists');
  assert.equal(valueAt(r, MAMAS_KEY, 'pub.level'), 'geteilt', 'and nothing of the patch landed');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · ONE PREDICATE, THREE READERS — the whole input domain, as data
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The cross-product the board can actually present: mine vs. someone else's × the three states
 * of the promoted `coEdit` register (absent / false / true) × every level the fold can leave in
 * `entry.level`, INCLUDING `null` (nothing folded yet) and a value from outside the enum (an
 * older client folding a level a newer protocol added — `core/visibility.js`'s X4 row).
 */
const CELLS = [];
for (const isForeign of [false, true]) {
  for (const coEdit of [undefined, false, true]) {
    for (const level of [null, undefined, 'privat', 'belegt', 'geteilt', 'zukunft']) {
      CELLS.push({ isForeign, coEdit, level });
    }
  }
}

test('§4 the three readers of „may I edit this?" agree on all 36 cells', () => {
  const disagreements = [];
  for (const cell of CELLS) {
    const a = layoutCanEdit(cell);
    const b = interactCanEdit(cell);
    const c = sharing.canEditEntry(cell);
    if (!(a === b && b === c)) {
      disagreements.push(`${JSON.stringify(cell)} → layout=${a} interact=${b} sharing=${c}`);
    }
  }
  assert.equal(CELLS.length, 36);
  assert.deepEqual(disagreements, [],
    'a fourth answer to 18.1 has appeared, or one of the three has drifted:\n  '
    + disagreements.join('\n  '));
});

test('§4 the three cells that used to diverge, named — the downgrade window', () => {
  // These are the rows E9 found. `interact.js` and `family/sharing.js` read `coEdit` alone and
  // said TRUE; `layout.js` read the level too and said FALSE. The window is real: `pub.coEdit`
  // is governing and stage 3c never drops governing fields, so a map holds `belegt` beside a
  // not-yet-arrived-null `coEdit: true` between two pulls.
  for (const level of [null, 'privat', 'belegt']) {
    const cell = { isForeign: true, coEdit: true, level };
    assert.equal(layoutCanEdit(cell), false, `level ${level} must not be editable`);
    assert.equal(interactCanEdit(cell), false);
    assert.equal(sharing.canEditEntry(cell), false);
  }
  const ok = { isForeign: true, coEdit: true, level: 'geteilt' };
  assert.equal(layoutCanEdit(ok), true, 'and the invited case still is editable');
  assert.equal(interactCanEdit(ok), true);
  assert.equal(sharing.canEditEntry(ok), true);
});

test('§4 the rule is `allowsCoEdit`, read from core — not a fourth table', () => {
  // ADR 004 §8 lives in `core/visibility.js`. If any reader ever grew its own idea of which
  // levels permit co-editing, this row is where it shows up.
  for (const level of VISIBILITY_LEVELS) {
    const cell = { isForeign: true, coEdit: true, level };
    assert.equal(layoutCanEdit(cell), allowsCoEdit(level), `layout disagrees with core at ${level}`);
    assert.equal(sharing.canEditEntry(cell), allowsCoEdit(level));
    assert.equal(interactCanEdit(cell), allowsCoEdit(level));
  }
  assert.deepEqual(VISIBILITY_LEVELS.filter(allowsCoEdit), ['geteilt']);
});

test('§4 solo mode is unconditionally editable, by construction', () => {
  // `stripV2Fields` keeps only `V1_ENTRY_FIELDS`, so a solo entry has no `isForeign`, no
  // `coEdit` and no `level` at all. Every reader must short-circuit true on that shape or the
  // v1 characterization suite would be measuring a different product.
  const soloNote = { id: 'x', date: '2026-01-01', text: 'Zahnarzt', categoryId: 'c', repeatsYearly: false };
  assert.equal(layoutCanEdit(soloNote), true);
  assert.equal(interactCanEdit(soloNote), true);
  assert.equal(sharing.canEditEntry(soloNote), true);
  // and the existence question is NOT the permission question (see `interact.js:canEdit`)
  assert.equal(interactCanEdit(undefined), true, 'a missing entry is not a forbidden entry');
  assert.equal(sharing.canEditEntry(undefined), false,
    'sharing.js answers the narrower question and says so — it is never a gesture gate');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · 18.2's PURE MODEL AND ITS COPY — the owner's half and the viewer's half
// ═════════════════════════════════════════════════════════════════════════════════════════════

const mine = (over = {}) => ({
  id: 'n1', visibility: 'geteilt', coEdit: false, isForeign: false, ...over,
});

test('18.2 the flag is a one-entry grant, and it exists only at Geteilt (ADR 004 §8)', () => {
  assert.deepEqual(sharing.planCoEditChange(mine({ coEdit: false }), true).patch, { coEdit: true });
  assert.deepEqual(sharing.planCoEditChange(mine({ coEdit: true }), false).patch, { coEdit: false });
  assert.equal(sharing.planCoEditChange(mine({ coEdit: true }), true), null, 'unchanged declines');
  for (const level of ['privat', 'belegt']) {
    assert.equal(sharing.planCoEditChange(mine({ visibility: level }), true), null,
      `${level} refuses the flag even if a caller gets past the disabled input`);
  }
  // …and the patch is the truth register, never a `pub.*` field: what leaves the device is built
  // by `core/project.js` from these, at the one choke point (ADR 004 §2).
  const p = sharing.planCoEditChange(mine(), true).patch;
  assert.deepEqual(Object.keys(p), ['coEdit']);
});

test('18.2 leaving Geteilt withdraws the grant in the SAME transaction — no silent re-grant', () => {
  // Without this, Geteilt → Belegt → Geteilt hands the family write access back to an entry the
  // owner un-shared, restored by a control they were using to disclose LESS.
  for (const to of ['privat', 'belegt']) {
    const plan = sharing.planVisibilityChange(mine({ coEdit: true }), to);
    assert.deepEqual(plan.patch, { visibility: to, coEdit: false }, `${to} must clear coEdit`);
  }
  assert.deepEqual(sharing.planVisibilityChange(mine({ coEdit: false }), 'belegt').patch,
    { visibility: 'belegt' }, 'and it does not write a register that is already false');
});

test('18.2 a foreign entry is never mine to grant, at any level', () => {
  const foreign = { id: 'fnote:x/y', isForeign: true, level: 'geteilt', coEdit: true, visibility: 'geteilt' };
  assert.equal(sharing.planCoEditChange(foreign, true), null);
  assert.equal(sharing.planCoEditChange(foreign, false), null);
  for (const l of VISIBILITY_LEVELS) assert.equal(sharing.planVisibilityChange(foreign, l), null);
});

test('18.2 the viewer\'s line exists in both languages and claims nothing it cannot keep', () => {
  // The owner sees a checkbox; the other member had no way to learn the invitation existed at
  // all. The line says what was GRANTED — an observable fact of `pub.coEdit` — and never that
  // this Mac can write it. ADR 002 §7.4's "Never" list is swept over the whole TXT table by
  // `tests/tier2/sharing-control.dom.js`; this row pins the two new strings' content.
  const de = sharing.TXT.coEditForeign.de;
  const en = sharing.TXT.coEditForeign.en;
  assert.ok(de.startsWith('Familie darf bearbeiten'), 'the glossary term is verbatim and first');
  assert.ok(en.startsWith('Family can edit'));
  for (const s of [de, en]) {
    for (const claim of sharing.FORBIDDEN_CLAIMS) {
      assert.equal(s.toLowerCase().includes(claim.toLowerCase()), false, `forbidden claim: ${claim}`);
    }
    // No second person, no promise about the reader's own hands.
    assert.equal(/\bdu\b|\bdein|\byou\b|\byour\b/i.test(s), false, `the line promises the reader something: ${s}`);
  }
  setLang('de');
  assert.equal(sharing.TXT.coEdit.de, 'Familie darf bearbeiten', 'glossary §13, unparaphrased');
  setLang('en');
  assert.equal(sharing.TXT.coEdit.en, 'Family can edit');
  setLang('de');
});

test('18.2 the fold and the field table agree about what a co-editor may write', () => {
  // The UI says „Familie darf bearbeiten" — bearbeiten, not verwalten. Enumerate what that buys.
  const coEditable = Object.entries(FIELDS.fnote).filter(([, s]) => s.coEdit === true).map(([f]) => f);
  const governing = Object.entries(FIELDS.fnote).filter(([, s]) => s.gov === true).map(([f]) => f);
  assert.deepEqual(coEditable.sort(), ['pub.date', 'pub.repeatsYearly', 'pub.text']);
  assert.deepEqual(governing.sort(), ['_born', 'pub.alive', 'pub.coEdit', 'pub.level']);
  assert.equal(coEditable.some((f) => governing.includes(f)), false,
    'no field is both — a co-editor could otherwise grant themselves something');
  // `pub.text` is the one that is also `geteiltOnly`, which is why 3b requires Geteilt at all.
  assert.equal(fieldSpec('fnote', 'pub.text').geteiltOnly, true);
  assert.equal(fieldSpec('fbar', 'pub.label').geteiltOnly, true);
});

test('18.2 a co-editor cannot grant themselves the flag — it is folded a stage earlier', () => {
  const c = circle({ coEdit: false });
  const selfGrant = pubOp('fnote', ME, U_MINE, { 'pub.coEdit': true }, MAMA, FSP, BASE + 40);
  const thenWrite = pubOp('fnote', ME, U_MINE, { 'pub.text': 'gekapert' }, MAMA, FSP, BASE + 41);
  const r = foldAuthorized([...c.ops, selfGrant, thenWrite], CTX());
  assert.equal(verdictOf(r, selfGrant), `rejected:${REJECT_REASONS.NOT_OWNER}`);
  assert.equal(verdictOf(r, thenWrite), `rejected:${REJECT_REASONS.NO_COEDIT}`);
  assert.equal(valueAt(r, MY_KEY, 'pub.text'), 'Silvester');
});
