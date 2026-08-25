// tests/attack/ownership-authz-admin.test.js
//
// ATTACK SURFACE: the admin chain (ADR 001 §4.1) and everything admin authority unlocks —
// the §4.3 unshare, the §4.2 removal, and through §4.3 stage 3b the co-edit predicate.
//
// I am ZORRO. I am a real, invited, attested member of the Familienkreis. PAPA is the admin.
// I want admin, and I want it without PAPA ever signing a transfer.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// DISPOSITION OF THE `SUCCEEDED` ROWS IN THIS FILE — READ THIS BEFORE TRUSTING A GREEN RUN
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Every row below titled `… SUCCEEDED …` is an OPEN FINDING. It is pinned to the behaviour the
// code has TODAY, so the row is green while the defect exists. That is deliberate and it is the
// only honest way to keep a known hole visible in a passing suite — but it inverts the usual
// reading of red and green, so:
//
//     IF ONE OF THESE ROWS GOES RED, THE DEFECT WAS PROBABLY FIXED.
//     Do not "repair" the test. Invert it to assert the new, correct behaviour, and move its
//     entry in the list below from OPEN to CLOSED.
//
// THESE ARE NOT ACCEPTED BEHAVIOUR. In particular they are NOT covered by decision D7
// (DESIGN-DECISIONS.md, "ownership is structural, not server-validated"). D7's guarantee is:
//
//     "a member who patches their own client can still emit an op the others will reject —
//      but not one they will accept."
//
// Every row below emits an op the others DO accept: each honest device folds it identically and
// agrees with the attacker. So these findings BREAK D7's stated guarantee rather than falling
// under its accepted trade, and they should be read as work owed, not as a documented limit.
//
// WHY THEY ARE NOT FIXED IN THIS PASS. They are all membership-and-authority lifecycle, which is
// PLAN.md's WP-9 (Familienkreis and lifecycle: create → invite → join → member list → remove with
// rotation → leave → delete space) and, for the device-identity half, WP-6/WP-8. WP-1 is the pure
// core and has no invite, no server-validated membership and no key rotation, so there is nothing
// in this work package that could refuse them: "an outsider joins the Kreis unassisted" is not a
// regression against a join flow, it is the absence of one. Closing them inside `authz.js` alone
// would mean inventing that design without the PO, and the WP-1 fix pass was scoped to the
// convergence and v1-fidelity defects, all of which ARE closed (see the `CLOSED` rows).
//
// THE ONE CHEAP LEVER THAT ALREADY EXISTS, and the shape of the eventual answer: several of these
// are defeated by a ctx field that exists but DEFAULTS TO OFF — `ctx.genesisOpId` pins the root
// and defeats the whole A2 family (see `A2e`), `ctx.myDevices` closes B6 (see `B6b`), `opts.me`
// closes C1b, `ctx.nowMs` closes B4c. WP-1's own fix pass adopted the opposite house rule
// everywhere it touched — `tombstoneCollectable` THROWS on a missing `minPushedSeq` rather than
// defaulting to something permissive, `forget` refuses rather than assuming, `migrateV1` throws
// rather than losing data quietly. Applying that same rule to these four ctx fields is the
// obvious first move for WP-3/WP-9, and it is a wiring decision (who supplies them, and what
// solo mode does before any genesis exists) rather than a core algorithm change.
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// OPEN in this file (12 rows, all WP-9):
//   A2, A2b, A2c       — ANY member can mint a genesis link (`adminPrev: null`, `act === f.admin`
//                        is the whole predicate), and chain LENGTH is compared before `ts`
//                        (`betterChain`), so one forged root plus one self-transfer outranks the
//                        real root. Defeated today only by `ctx.genesisOpId` (A2e). `A2d` is the
//                        companion CONTROL — it is green either way — showing the takeover is a
//                        property of the op SET, so every device is taken over identically.
//   A3, A3b, A3c       — register keys carry no space, so admin of a space I invented applies to
//                        yours. Needs the space id to bind the register, or the admin query to be
//                        scoped to `ctx.familySpaceId`.
//   A3d                — collateral: `AuthzResult.admin` silently goes null as soon as a second
//                        space exists (`soleSpace`), so minting one is a denial of service against
//                        every admin-gated affordance. The per-space accessors stay correct.
//   A4, A4b            — the chain query is unbounded in time and in membership, so a FORMER or
//                        REMOVED admin still authorises by backdating below the transfer.
//   A5, A5b, A5c       — membership is self-asserting: `member.set{_alive:true}` re-admits you and
//                        a self-attestation makes an outsider a member. This is the one that most
//                        obviously needs WP-9's invite/redeem flow rather than a core patch.

import test from 'node:test';
import assert from 'node:assert/strict';

import '../helpers/env.js';
import {
  preamble, newWorld, authzCtx, mctxFromFold, actor, D,
  ME, MAMA, PAPA, ZORRO, EVE, FSP, FSP_EVIL, PSP, T, U1, U_PAPA, BASE_MS, HOUR,
  attestationBlob, reasonOf, wasAdmitted, lcg, shuffle, noteById,
} from './_harness.js';

import { foldAuthorized, unsharePatch, snapshot } from '../../src/js/core/authz.js';
import { materialize } from '../../src/js/core/materialize.js';
import { memberKey, spaceKey, familyKey } from '../../src/js/core/entities.js';
import { defaultState } from '../../src/js/store.js';

const mat = (r, over) => materialize(r.regs, {
  ...mctxFromFold(r, over), defaultSettings: defaultState().settings,
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// A1 — HONEST TRANSFER FORGERY. Can I just declare myself the next admin?
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('A1 FAILED (defence holds): a transfer link I author over PAPA\'s genesis is not a link', () => {
  const w = preamble();
  const forged = w.A.zorro.op('space.set', spaceKey(FSP),
    { admin: ZORRO, adminPrev: w.genesis.id }, { space: FSP, ms: T.now });

  const r = foldAuthorized([...w.ops, forged], authzCtx());

  assert.equal(r.admin, PAPA, 'PAPA must still be admin');
  assert.equal(wasAdmitted(r, forged), false);
  assert.equal(reasonOf(r, forged), 'lostAdminChain');
  // authz.js:264 — `if (kid.op.act !== link.admin) continue;`  The transfer must be authored by
  // the admin the superseded link named. This is the check ADR 001 §4.1 promises and it works.
});

test('A1b FAILED (defence holds): backdating the forged transfer below the genesis changes nothing', () => {
  const w = preamble();
  const forged = w.A.zorro.op('space.set', spaceKey(FSP),
    { admin: ZORRO, adminPrev: w.genesis.id }, { space: FSP, ms: 0 });
  const r = foldAuthorized([...w.ops, forged], authzCtx());
  assert.equal(r.admin, PAPA);
  assert.equal(reasonOf(r, forged), 'lostAdminChain');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// A2 — FORGED GENESIS + SELF-EXTENSION. The one that works.
//
// ADR 001 §4.1: "Genesis link: the space-create op has `adminPrev: null` and `admin: <creator>`;
// it is admissible only if `op.act === op.f.admin`."  There is no second condition, so ANY member
// can mint a root. The existing property test (tests/property/ownership.test.js, EVE's attack)
// mints ONE root and loses the tie-break to the honest root's greater `ts` — which is why this
// hole has never fired. The fix is one extra op: make my chain LONGER, and length is compared
// BEFORE `ts` (authz.js:230 `betterChain`).
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('A2 SUCCEEDED: a forged genesis plus one self-transfer makes ZORRO admin of the real family space', () => {
  const w = preamble();
  // op 1 — the forged root. act === f.admin, adminPrev === null. That is the whole predicate.
  const g = w.A.zorro.op('space.set', spaceKey(FSP),
    { admin: ZORRO, adminPrev: null }, { space: FSP, ms: T.genesis - 5000 });
  // op 2 — I hand the space to myself. `kid.op.act === link.admin` holds: I am the admin of MY
  // root, so I may transfer from it.
  const t2 = w.A.zorro.op('space.set', spaceKey(FSP),
    { admin: ZORRO, adminPrev: g.id }, { space: FSP, ms: T.genesis - 4000 });

  const r = foldAuthorized([...w.ops, g, t2], authzCtx());

  assert.equal(r.admin, ZORRO, 'EXPECTED FAILURE: ZORRO is admin without any link PAPA signed');
  assert.deepEqual(r.adminChainOf(FSP).map((o) => o.id), [g.id, t2.id]);
  assert.equal(wasAdmitted(r, w.genesis), false, "PAPA's real genesis is now rejected");
  assert.equal(reasonOf(r, w.genesis), 'lostAdminChain');
});

test('A2b SUCCEEDED: the forged admin then unshares PAPA\'s entry off every family board (18.3)', () => {
  const w = preamble();
  const g = w.A.zorro.op('space.set', spaceKey(FSP), { admin: ZORRO, adminPrev: null },
    { space: FSP, ms: T.genesis - 5000 });
  const t2 = w.A.zorro.op('space.set', spaceKey(FSP), { admin: ZORRO, adminPrev: g.id },
    { space: FSP, ms: T.genesis - 4000 });
  // The §4.3 admin unshare, byte-exact, on an entity I do not own.
  const kill = w.A.zorro.op('pub.set', familyKey('fnote', PAPA, U_PAPA),
    unsharePatch('fnote'), { space: FSP, ms: T.now });

  const before = mat(foldAuthorized(w.ops, authzCtx()));
  assert.ok(before.notes.some((n) => n.ownerId === PAPA), 'precondition: PAPA is on my board');

  const r = foldAuthorized([...w.ops, g, t2, kill], authzCtx());
  assert.equal(wasAdmitted(r, kill), true, 'EXPECTED FAILURE: the unshare was admitted');
  const st = mat(r);
  assert.equal(st.notes.some((n) => n.ownerId === PAPA), false,
    "EXPECTED FAILURE: PAPA's Geteilt entry is gone from my board, unshared by a member who never held admin");
});

test('A2c SUCCEEDED: the forged admin removes PAPA from the Kreis (20.2) and erases everything he shared', () => {
  const w = preamble();
  const g = w.A.zorro.op('space.set', spaceKey(FSP), { admin: ZORRO, adminPrev: null },
    { space: FSP, ms: T.genesis - 5000 });
  const t2 = w.A.zorro.op('space.set', spaceKey(FSP), { admin: ZORRO, adminPrev: g.id },
    { space: FSP, ms: T.genesis - 4000 });
  const purge = w.A.zorro.op('member.set', memberKey(PAPA), { _alive: false },
    { space: FSP, ms: T.now });

  const r = foldAuthorized([...w.ops, g, t2, purge], authzCtx());
  assert.equal(wasAdmitted(r, purge), true);
  assert.equal(r.currentMembers.has(PAPA), false,
    'EXPECTED FAILURE: PAPA is no longer a member, decided by an op nobody with authority wrote');
  assert.equal(mat(r).notes.some((n) => n.ownerId === PAPA), false);
});

test('A2d — the takeover is arrival-order independent (it is a property of the SET, as designed)', () => {
  const w = preamble();
  const g = w.A.zorro.op('space.set', spaceKey(FSP), { admin: ZORRO, adminPrev: null },
    { space: FSP, ms: T.genesis - 5000 });
  const t2 = w.A.zorro.op('space.set', spaceKey(FSP), { admin: ZORRO, adminPrev: g.id },
    { space: FSP, ms: T.genesis - 4000 });
  const all = [...w.ops, g, t2];
  const base = snapshot(foldAuthorized(all, authzCtx()));
  const rnd = lcg(0xA2D);
  for (let i = 0; i < 40; i++) {
    assert.deepEqual(snapshot(foldAuthorized(shuffle(rnd, all), authzCtx())), base,
      'foldAuthorized is order-independent — the takeover is deterministic, not a race');
  }
});

test('A2e FAILED (defence holds): ctx.genesisOpId pins the root and defeats A2 entirely', () => {
  const w = preamble();
  const g = w.A.zorro.op('space.set', spaceKey(FSP), { admin: ZORRO, adminPrev: null },
    { space: FSP, ms: T.genesis - 5000 });
  const t2 = w.A.zorro.op('space.set', spaceKey(FSP), { admin: ZORRO, adminPrev: g.id },
    { space: FSP, ms: T.genesis - 4000 });
  const r = foldAuthorized([...w.ops, g, t2], authzCtx({ genesisOpId: w.genesis.id }));
  assert.equal(r.admin, PAPA, 'the pin holds — but it is opt-in and defaults to off');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// A3 — CROSS-SPACE AUTHORITY. Admin of MY OWN circle, applied to YOURS.
//
// Register keys carry no space: `member:<M>` and `fnote:<M>/<uuid>` are the same cells no matter
// which `op.space` the op that wrote them declared. `foldAuthorized` resolves the admin from
// `adminAtKey(spaceKey(op.space), op.ts)` — THE OP'S OWN, SELF-DECLARED SPACE. So being admin of
// a space I created myself is authority over every family entity in the fold.
//
// Reachability, honestly: ADR 002 §5.2 binds `op.space` to the sealing key, so this op only
// decrypts on a device that holds FSP_EVIL's keys. That device exists as soon as one person is in
// two circles — "Familie" and "Familie Nord" — which the product does not forbid, and it is
// exactly the member the attacker recruits.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('A3 SUCCEEDED: admin of a space I invented can unshare an entry in a space I do not run', () => {
  const w = preamble();
  // I create my own circle. Genesis is self-authorising, so nobody had to let me.
  const mine = w.A.zorro.op('space.set', spaceKey(FSP_EVIL), { admin: ZORRO, adminPrev: null },
    { space: FSP_EVIL, familySpaceId: FSP_EVIL, ms: T.genesis });
  // …and use it to unshare PAPA's entry, which lives in FSP.
  const kill = w.A.zorro.op('pub.set', familyKey('fnote', PAPA, U_PAPA), unsharePatch('fnote'),
    { space: FSP_EVIL, familySpaceId: FSP_EVIL, ms: T.now });

  const r = foldAuthorized([...w.ops, mine, kill], authzCtx());

  assert.equal(r.adminOfSpace(FSP), PAPA, 'PAPA is still admin of the real space…');
  assert.equal(r.adminOfSpace(FSP_EVIL), ZORRO, '…and I am admin of mine');
  assert.equal(wasAdmitted(r, kill), true,
    'EXPECTED FAILURE: an unshare authorised by the WRONG space was admitted');
  assert.equal(mat(r).notes.some((n) => n.ownerId === PAPA), false,
    "EXPECTED FAILURE: PAPA's entry was unshared by the admin of an unrelated circle");
});

test('A3b SUCCEEDED: the same trick removes a member of a circle I am not the admin of', () => {
  const w = preamble();
  const mine = w.A.zorro.op('space.set', spaceKey(FSP_EVIL), { admin: ZORRO, adminPrev: null },
    { space: FSP_EVIL, familySpaceId: FSP_EVIL, ms: T.genesis });
  const purge = w.A.zorro.op('member.set', memberKey(MAMA), { _alive: false },
    { space: FSP_EVIL, familySpaceId: FSP_EVIL, ms: T.now });

  const r = foldAuthorized([...w.ops, mine, purge], authzCtx());
  assert.equal(wasAdmitted(r, purge), true);
  assert.equal(r.currentMembers.has(MAMA), false,
    'EXPECTED FAILURE: MAMA was removed from the family by the admin of a different space');
});

test('A3c SUCCEEDED: removing MAMA this way also strips her stage-3b co-edit rights', () => {
  const w = preamble();
  // MAMA legitimately co-edits MY Geteilt+coEdit note.
  const mamaEdit = w.A.mama.op('pub.set', familyKey('fnote', ME, U1),
    { 'pub.text': 'von Mama' }, { space: FSP, ms: T.coedit });
  const ok = foldAuthorized([...w.ops, mamaEdit], authzCtx());
  assert.equal(wasAdmitted(ok, mamaEdit), true, 'precondition: the co-edit is legal');

  const mine = w.A.zorro.op('space.set', spaceKey(FSP_EVIL), { admin: ZORRO, adminPrev: null },
    { space: FSP_EVIL, familySpaceId: FSP_EVIL, ms: T.genesis });
  const purge = w.A.zorro.op('member.set', memberKey(MAMA), { _alive: false },
    { space: FSP_EVIL, familySpaceId: FSP_EVIL, ms: T.coedit - 1000 });

  const r = foldAuthorized([...w.ops, mamaEdit, mine, purge], authzCtx());
  assert.equal(reasonOf(r, mamaEdit), 'notMember',
    'EXPECTED FAILURE: MAMA\'s legitimate co-edit is now inadmissible on every device');
});

test('A3d SUCCEEDED (collateral): a second space silently nulls AuthzResult.admin', () => {
  const w = preamble();
  const mine = w.A.zorro.op('space.set', spaceKey(FSP_EVIL), { admin: ZORRO, adminPrev: null },
    { space: FSP_EVIL, familySpaceId: FSP_EVIL, ms: T.genesis });
  const r = foldAuthorized([...w.ops, mine], authzCtx());
  assert.equal(r.admin, null,
    'EXPECTED FAILURE: `admin` and `adminAt()` go null the moment a second space appears — '
    + 'any caller that asks "am I the admin?" through the headline accessor now says no');
  assert.equal(r.adminAt(String(T.now).padStart(13, '0') + '.000000.0000000000000000'), null);
  assert.equal(r.adminOfSpace(FSP), PAPA, 'only the per-space accessor still answers');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// A4 — THE RETROACTIVE ADMIN. `admin@ts` trusts the op's own, unbounded `ts`.
//
// ADR 001 §4.4: "Stamps have no lower bound, so a member running a modified client could emit an
// owner write backdated to ms = 0 and take over any entity… There is nothing to backdate."
// True for OWNERSHIP. Not true for ADMIN AUTHORITY, which IS resolved by stamp — `adminAtIn()`
// walks the chain and stops at the first link whose `ts` exceeds the op's self-declared `ts`.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('A4 SUCCEEDED: a former admin unshares an entry forever, by backdating below the transfer', () => {
  const w = newWorld();
  const base = preamble(w);
  // The honest history: PAPA (genesis) hands admin to MAMA. ZORRO never held it; PAPA did.
  const handover = w.A.papa.op('space.set', spaceKey(FSP),
    { admin: MAMA, adminPrev: base.genesis.id }, { space: FSP, ms: T.publish + 1000 });

  const ops = [...base.ops, handover];
  const sane = foldAuthorized(ops, authzCtx());
  assert.equal(sane.admin, MAMA, 'precondition: MAMA is the admin now, PAPA is not');

  // PAPA, an EX-admin, backdates an unshare of MY entry to a moment when he still was admin —
  // but AFTER I published, so it wins the LWW join.
  const kill = w.A.papa.op('pub.set', familyKey('fnote', ME, U1), unsharePatch('fnote'),
    { space: FSP, ms: T.publish + 500 });

  const r = foldAuthorized([...ops, kill], authzCtx());
  assert.equal(wasAdmitted(r, kill), true,
    'EXPECTED FAILURE: an ex-admin unshare, authored today, admitted because it says it is old');
  // …and it wins the register, so the entry really is unpublished for the whole family.
  assert.equal(r.regs.get(familyKey('fnote', ME, U1)).get('pub.level').value, 'privat');
  assert.equal(r.regs.get(familyKey('fnote', ME, U1)).get('pub.level').author, PAPA);
});

test('A4b SUCCEEDED: a REMOVED member keeps that power — removal does not bound the chain query', () => {
  const w = newWorld();
  const base = preamble(w);
  const handover = w.A.papa.op('space.set', spaceKey(FSP),
    { admin: MAMA, adminPrev: base.genesis.id }, { space: FSP, ms: T.publish + 1000 });
  // MAMA, the current admin, throws PAPA out of the family entirely.
  const evict = w.A.mama.op('member.set', memberKey(PAPA), { _alive: false },
    { space: FSP, ms: T.publish + 2000 });
  const kill = w.A.papa.op('pub.set', familyKey('fnote', ME, U1), unsharePatch('fnote'),
    { space: FSP, ms: T.publish + 500 });

  const r = foldAuthorized([...base.ops, handover, evict, kill], authzCtx());
  assert.equal(r.currentMembers.has(PAPA), false, 'PAPA is out of the Kreis');
  assert.equal(wasAdmitted(r, kill), true,
    'EXPECTED FAILURE: an evicted ex-admin can still unshare my entries at will');
});

test('A4c FAILED (defence holds): backdating BELOW the genesis buys nothing', () => {
  const w = preamble();
  const kill = w.A.zorro.op('pub.set', familyKey('fnote', PAPA, U_PAPA), unsharePatch('fnote'),
    { space: FSP, ms: 0 });
  const r = foldAuthorized([...w.ops, kill], authzCtx());
  assert.equal(reasonOf(r, kill), 'notOwner', 'admin@0 is null, so nobody is admin at ms = 0');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// A5 — MEMBERSHIP. Self-service.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('A5 SUCCEEDED: a removed member re-admits themselves with one op (member.set{_alive:true})', () => {
  const w = preamble();
  const evict = w.A.papa.op('member.set', memberKey(ZORRO), { _alive: false },
    { space: FSP, ms: T.now });
  const undoEvict = w.A.zorro.op('member.set', memberKey(ZORRO), { _alive: true },
    { space: FSP, ms: T.now + 1000 });

  const gone = foldAuthorized([...w.ops, evict], authzCtx());
  assert.equal(gone.currentMembers.has(ZORRO), false, 'the admin removal works…');

  const r = foldAuthorized([...w.ops, evict, undoEvict], authzCtx());
  assert.equal(wasAdmitted(r, undoEvict), true);
  assert.equal(r.currentMembers.has(ZORRO), true,
    'EXPECTED FAILURE: 20.2 removal is reversible by the removed member alone (authz.js:640)');
});

test('A5b SUCCEEDED: an outsider joins the Kreis unassisted — self-attest, self-declare, done', () => {
  const w = preamble();
  const attest = w.A.eve.op('member.set', memberKey(EVE),
    { [`dev.${D.eve.short}`]: attestationBlob(EVE, D.eve) }, { space: FSP, ms: T.now });
  const declare = w.A.eve.op('member.set', memberKey(EVE),
    { displayName: 'Eve', colorRef: 'p2', _alive: true }, { space: FSP, ms: T.now + 1 });

  const r = foldAuthorized([...w.ops, attest, declare], authzCtx());
  assert.equal(r.currentMembers.has(EVE), true,
    'EXPECTED FAILURE: nothing in the fold requires an admin to have admitted a member');
  assert.ok(r.attestedDevices.has(EVE));
});

test('A5c SUCCEEDED: and that self-declared membership is enough to co-edit my Geteilt entry', () => {
  const w = preamble();
  const attest = w.A.eve.op('member.set', memberKey(EVE),
    { [`dev.${D.eve.short}`]: attestationBlob(EVE, D.eve) }, { space: FSP, ms: T.now });
  const declare = w.A.eve.op('member.set', memberKey(EVE),
    { displayName: 'Eve', _alive: true }, { space: FSP, ms: T.now + 1 });
  const write = w.A.eve.op('pub.set', familyKey('fnote', ME, U1),
    { 'pub.text': 'von Eve' }, { space: FSP, ms: T.now + 2 });

  const r = foldAuthorized([...w.ops, attest, declare, write], authzCtx());
  assert.equal(wasAdmitted(r, write), true,
    'EXPECTED FAILURE: stage 3b\'s `currentMembers.has(op.act)` is satisfied by self-assertion');
  assert.equal(noteById(mat(r), U1).text, 'von Eve',
    'EXPECTED FAILURE: an uninvited outsider rewrote the text of my note');
});

test('A5d FAILED (defence holds): I cannot touch another member\'s displayName or colour', () => {
  const w = preamble();
  const rename = w.A.zorro.op('member.set', memberKey(PAPA), { displayName: 'Idiot' },
    { space: FSP, ms: T.now });
  const r = foldAuthorized([...w.ops, rename], authzCtx());
  assert.equal(reasonOf(r, rename), 'notSelf');
});

test('A5e FAILED (defence holds): a removal smuggled alongside a rename is refused', () => {
  const w = preamble();
  const g = w.A.zorro.op('space.set', spaceKey(FSP), { admin: ZORRO, adminPrev: null },
    { space: FSP, ms: T.genesis - 5000 });
  const t2 = w.A.zorro.op('space.set', spaceKey(FSP), { admin: ZORRO, adminPrev: g.id },
    { space: FSP, ms: T.genesis - 4000 });
  // Even as the (forged) admin: `onlyAlive` is `names.length === 1`, so this is not a removal.
  const sneaky = w.A.zorro.op('member.set', memberKey(PAPA), { _alive: false, displayName: 'x' },
    { space: FSP, ms: T.now });
  const r = foldAuthorized([...w.ops, g, t2, sneaky], authzCtx());
  assert.equal(reasonOf(r, sneaky), 'notSelf');
  assert.equal(r.currentMembers.has(PAPA), true);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// A6 — MISCELLANEOUS GOVERNANCE PROBES that the code turns away.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('A6 FAILED (defence holds): a space.set sealed into FSP that addresses FSP_EVIL is refused', () => {
  const w = preamble();
  const cross = w.A.zorro.op('space.set', spaceKey(FSP_EVIL), { admin: ZORRO, adminPrev: null },
    { space: FSP, familySpaceId: FSP, ms: T.now });
  const r = foldAuthorized([...w.ops, cross], authzCtx());
  assert.equal(reasonOf(r, cross), 'spaceMismatch');
});

// A6b and A6c both probed the same stage-3a predicate, and the fix to one of them changed the
// answer to the other. The predicate used to be an EXACT match against this build's
// `unsharePatch(kind)`, so it was version-coupled in both directions:
//
//   · a patch with one field TOO MANY was rejected — which is what A6b wanted, and
//   · a patch with one field TOO FEW was rejected too — which is defect C2, because an unshare
//     authored by an OLDER build carries exactly one field fewer, and a rejection is FINAL. The
//     entry the admin unshared stayed visible on the newer client. That is the
//     "previously-hidden content reappears" failure of ADR 001 §4.1, reached through a staggered
//     app update rather than through an adversary.
//
// `classifyUnsharePatch` is now a property of the PATCH — level → privat, and every other field
// it carries is null — plus a tri-state verdict. A6c is now ADMITTED (correct). A6b is now
// PARKED, and A6b's substantive claim is unchanged and still asserted below: the admin gets no
// general write primitive, because a parked op is never folded.
//
// WHY PARK AND NOT REJECT for A6b's greedy patch. The two inputs are byte-indistinguishable from
// a legitimate future one: this build cannot tell `pub.text: 'gekapert'` (an attack) from
// `pub.text: <some future sentinel>` (a withdrawal it has not learned yet). One rule must cover
// both, so the question is which way to err. A rejection is final and, in the case it gets
// wrong, leaves shared content published forever — a privacy failure, live on any staggered
// rollout. A park applies nothing today and defers the verdict to a build that can read it. The
// park is therefore the conservative choice on the axis that matters, and it costs the attacker
// nothing they did not already have. It carries its own reason code (`unshareShape`) precisely
// so the unpark seam can see that this op was already found to be a governance write on someone
// else's entity, and must be re-judged by stage 3a rather than waved through as pre-approved.

test('A6b DEFENDED: an admin-shaped write with ONE extra field still writes nothing', () => {
  const w = preamble();
  const g = w.A.zorro.op('space.set', spaceKey(FSP), { admin: ZORRO, adminPrev: null },
    { space: FSP, ms: T.genesis - 5000 });
  const t2 = w.A.zorro.op('space.set', spaceKey(FSP), { admin: ZORRO, adminPrev: g.id },
    { space: FSP, ms: T.genesis - 4000 });
  const target = familyKey('fnote', PAPA, U_PAPA);
  const greedy = w.A.zorro.op('pub.set', target,
    { ...unsharePatch('fnote'), 'pub.text': 'gekapert' }, { space: FSP, ms: T.now });

  const r = foldAuthorized([...w.ops, g, t2, greedy], authzCtx());

  // THE CLAIM THAT MATTERS, unchanged from the original probe: no write primitive.
  assert.equal(wasAdmitted(r, greedy), false, 'the admin gets no general write primitive');
  assert.notEqual((r.regs.get(target) || new Map()).get('pub.text')?.value, 'gekapert',
    'and nothing the greedy patch carried reached a register');

  // The reason moved from a rejection to a park, and the op is retained rather than dropped.
  assert.equal(reasonOf(r, greedy), null, 'no longer a final rejection…');
  assert.equal(r.parkReasonOf(greedy.id), 'unshareShape', '…it is parked, under its own reason');
  assert.ok(r.parked.some((o) => o.id === greedy.id), 'and the op itself is retained');

  // NOT VACUOUS — the same fold, same admin, same entity: the CLEAN unshare from this very
  // actor IS admitted and does land. So `wasAdmitted === false` above is the extra field being
  // caught, not the whole 3a path quietly failing for some unrelated reason.
  const clean = w.A.zorro.op('pub.set', target, unsharePatch('fnote'), { space: FSP, ms: T.now });
  const ok = foldAuthorized([...w.ops, g, t2, clean], authzCtx());
  assert.equal(wasAdmitted(ok, clean), true, 'control: the clean unshare from the same actor lands');
  assert.equal(ok.regs.get(target).get('pub.level').value, 'privat');
});

test('A6c CLOSED (C2): an unshare that omits one null — an older build\'s — still unshares', () => {
  const w = preamble();
  const g = w.A.zorro.op('space.set', spaceKey(FSP), { admin: ZORRO, adminPrev: null },
    { space: FSP, ms: T.genesis - 5000 });
  const t2 = w.A.zorro.op('space.set', spaceKey(FSP), { admin: ZORRO, adminPrev: g.id },
    { space: FSP, ms: T.genesis - 4000 });
  const target = familyKey('fnote', PAPA, U_PAPA);

  // Exactly what a build that did not yet know `pub.text` would emit.
  const partial = { ...unsharePatch('fnote') };
  delete partial['pub.text'];
  const op = w.A.zorro.op('pub.set', target, partial, { space: FSP, ms: T.now });

  const r = foldAuthorized([...w.ops, g, t2, op], authzCtx());

  assert.equal(reasonOf(r, op), null, 'NOT rejected — a rejection here is defect C2');
  assert.equal(wasAdmitted(r, op), true);
  assert.equal(r.regs.get(target).get('pub.level').value, 'privat', 'THE POINT: it really unshares');

  // The field the short patch never mentioned is NOT withdrawn by this op — nothing pretends it
  // was. ADR 004 §5.3 mechanism 2 (the `oplog.js` forget pass, which fires on the level landing
  // at `privat`) is what removes the residue, and that is the honest division of labour.
  assert.equal(r.regs.get(target).get('pub.text')?.value, 'Papas Termin',
    'the omitted field is untouched by THIS op — mechanism 2 blanks it, not stage 3a');

  // NOT VACUOUS — drop the level from the patch and it is a hard rejection again, so the
  // admission above is the C2 rule working and not stage 3a having been disabled wholesale.
  const noLevel = { ...partial };
  delete noLevel['pub.level'];
  const bad = w.A.zorro.op('pub.set', target, noLevel, { space: FSP, ms: T.now });
  const r2 = foldAuthorized([...w.ops, g, t2, bad], authzCtx());
  assert.equal(reasonOf(r2, bad), 'notAnUnshare', 'control: a patch that is no unshare at all still dies');
});

test('A6d FAILED (defence holds): space.set{name} from a non-admin is refused (20.1)', () => {
  const w = preamble();
  const rename = w.A.zorro.op('space.set', spaceKey(FSP), { name: 'Zorros Kreis' },
    { space: FSP, ms: T.now });
  const r = foldAuthorized([...w.ops, rename], authzCtx());
  assert.equal(reasonOf(r, rename), 'notAdmin');
});

test('A6e FAILED (defence holds): mutually-referencing chain links do not hang or admit', () => {
  const w = preamble();
  // Two links pointing at each other's opIds. `seen` guards the cycle (authz.js:262).
  const a = w.A.zorro.op('space.set', spaceKey(FSP),
    { admin: ZORRO, adminPrev: 'BBBBBBBBBBBBBBBBBBBBBB' }, { space: FSP, ms: T.now, id: 'AAAAAAAAAAAAAAAAAAAAAA' });
  const b = w.A.zorro.op('space.set', spaceKey(FSP),
    { admin: ZORRO, adminPrev: 'AAAAAAAAAAAAAAAAAAAAAA' }, { space: FSP, ms: T.now, id: 'BBBBBBBBBBBBBBBBBBBBBB' });
  const r = foldAuthorized([...w.ops, a, b], authzCtx());
  assert.equal(r.admin, PAPA);
  assert.equal(reasonOf(r, a), 'lostAdminChain');
  assert.equal(reasonOf(r, b), 'lostAdminChain');
});
