// tests/attack/ownership-authz-content.test.js
//
// ATTACK SURFACE: §4.3 stage 3 (who may write which field of whose entity), §4.0 attestation,
// §4.4's "there is nothing to backdate", and the Pass-A dedupe that decides which op body under
// a given opId the whole family will agree on.
//
// I am ZORRO, an attested member. Sometimes I am EVE, who was never invited.
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
// OPEN in this file (7 rows):
//   B3, B3b, B3c       — WP-6/ADR 002. An opId is not bound to its author, so re-using another
//                        member's opId makes the two bodies a SPLICE, and the content-addressable
//                        max can be the attacker's — deleting the victim's op before admissibility
//                        ever runs. B3b is the sharp one: it suppresses a PRIVACY DOWNGRADE, so
//                        text the owner retracted stays on the family board. The fix is to derive
//                        or sign the opId over (author, body); it cannot be done in `authz.js`,
//                        which sees only what the envelope claims.
//   B4, B4c            — WP-3 wiring. The +24 h clamp is off when `ctx.nowMs` is omitted, so a
//                        year-9999 stamp wins every join forever. `B4b` proves the clamp works
//                        when it is supplied — this is the "optional guard defaults to permissive"
//                        pattern named in the disposition above.
//   B5c                — WP-6. A device SHORT is 16 characters chosen by its owner and nothing
//                        binds it to a member, so I can claim another member's short.
//   B6                 — WP-3 wiring. `ctx.myDevices` closes it (`B6b`); omitted, a forged
//                        personal-space op is admitted.

import test from 'node:test';
import assert from 'node:assert/strict';

import '../helpers/env.js';
import {
  preamble, authzCtx, mctxFromFold, D,
  ME, MAMA, PAPA, ZORRO, EVE, FSP, PSP, T, U1, U2, BASE_MS, HOUR, DAY,
  attestationBlob, reasonOf, wasAdmitted, lcg, shuffle, noteById, short16,
} from './_harness.js';

import { foldAuthorized, snapshot } from '../../src/js/core/authz.js';
import { materialize } from '../../src/js/core/materialize.js';
import { familyKey, noteKey, memberKey, EntityKeyError } from '../../src/js/core/entities.js';
import { validateOp } from '../../src/js/core/ops.js';
import { canonicalJSON } from '../../src/js/core/canon.js';
import { defaultState } from '../../src/js/store.js';

const mat = (r, over) => materialize(r.regs, {
  ...mctxFromFold(r, over), defaultSettings: defaultState().settings,
});
const cell = (r, e, f) => (r.regs.get(e) || new Map()).get(f);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// B1 — DIRECT OWNERSHIP THEFT. Every variant. All of them bounce.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('B1 FAILED (defence holds): pub.level on an entity I do not own, at ms = 0', () => {
  const w = preamble();
  const steal = w.A.zorro.op('pub.set', familyKey('fnote', ME, U1),
    { 'pub.level': 'privat', 'pub.coEdit': false }, { space: FSP, ms: 0 });
  const r = foldAuthorized([...w.ops, steal], authzCtx());
  assert.equal(reasonOf(r, steal), 'notOwner');
});

test('B1b FAILED (defence holds): pub.alive:false on someone else\'s entity (a remote delete)', () => {
  const w = preamble();
  const kill = w.A.zorro.op('pub.set', familyKey('fnote', PAPA, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
    { 'pub.alive': false }, { space: FSP, ms: T.now });
  const r = foldAuthorized([...w.ops, kill], authzCtx());
  assert.equal(reasonOf(r, kill), 'notOwner');
});

test('B1c FAILED (defence holds): granting MYSELF co-edit rights on your entry', () => {
  const w = preamble();
  const grant = w.A.zorro.op('pub.set', familyKey('fnote', PAPA, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
    { 'pub.coEdit': true }, { space: FSP, ms: T.now });
  const r = foldAuthorized([...w.ops, grant], authzCtx());
  assert.equal(reasonOf(r, grant), 'notOwner');
});

test('B1d FAILED (defence holds): _born on someone else\'s entity is gov, so it bounces too', () => {
  const w = preamble();
  const reborn = w.A.zorro.op('pub.set', familyKey('fnote', ME, U1),
    { _born: '0000000000000.000000.0000000000000000' }, { space: FSP, ms: T.now });
  const r = foldAuthorized([...w.ops, reborn], authzCtx());
  assert.equal(reasonOf(r, reborn), 'notOwner');
});

test('B1e FAILED (defence holds): an owner segment cannot be smuggled through the key', () => {
  const w = preamble();
  // `fnote:<ME>/<ZORRO>/<uuid>` — the id half would have to contain a '/', which ENTITY_UUID_RE
  // forbids precisely so the key cannot be re-read to name a different owner.
  for (const key of [
    `fnote:${ME}/${ZORRO}/${U1}`,
    `fnote:${ZORRO}/${ME}/${U1}`,
    `fnote:${ME}${ZORRO}/${U1}`,
    `fnote:/${U1}`,
    `fnote:${ME}/`,
  ]) {
    assert.throws(() => w.A.zorro.op('pub.set', key, { 'pub.text': 'x' }, { space: FSP, ms: 0 }),
      /invalid|not a well-formed/i, `makeOp accepted the forged key ${key}`);
  }
});

test('B1f FAILED (defence holds): a `note.set` cannot be smuggled into the family space', () => {
  const w = preamble();
  // The kind↔space binding is checked in validateOp (ops.js:387). Without it a family-sealed
  // op would land on `note:<uuid>` — MY TRUTH — and stage 3 admits truth ops unconditionally.
  const forged = {
    v: 1, id: 'FORGEDooooooooooooooo1', ts: '1787836900000.000000.' + short16('ZORROMAC'),
    space: FSP, act: ZORRO, dev: D.zorro.id, gid: 'FORGEDggggggggggggggg1',
    k: 'note.set', e: noteKey(U1), f: { text: 'gekapert' },
  };
  const v = validateOp(forged);
  assert.equal(v.ok, false);
  assert.match(v.reason, /belongs in the personal space/);
  const r = foldAuthorized([...w.ops, forged], authzCtx());
  assert.equal(reasonOf(r, forged), 'shape');
  assert.equal(noteById(mat(r), U1).text, 'Zahnarzt');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// B2 — CO-EDIT. The gates ADR 001 §4.3 stage 3b promises.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('B2 FAILED (defence holds): co-editing an entry whose pub.coEdit is false', () => {
  const w = preamble();
  const key = familyKey('fnote', PAPA, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  const edit = w.A.zorro.op('pub.set', key, { 'pub.text': 'gekapert' }, { space: FSP, ms: T.now });
  const r = foldAuthorized([...w.ops, edit], authzCtx());
  assert.equal(reasonOf(r, edit), 'noCoEdit');
});

test('B2b FAILED (defence holds): co-edit is refused when the level is Belegt, even with coEdit true', () => {
  const w = preamble();
  const key = familyKey('fnote', ME, U1);
  const downgrade = w.A.me.op('pub.set', key, { 'pub.level': 'belegt' }, { space: FSP, ms: T.publish + 100 });
  const edit = w.A.zorro.op('pub.set', key, { 'pub.text': 'gekapert' }, { space: FSP, ms: T.now });
  const r = foldAuthorized([...w.ops, downgrade, edit], authzCtx());
  assert.equal(reasonOf(r, edit), 'notGeteilt');
});

test('B2c FAILED (defence holds): a co-editor may not write a non-coEdit field', () => {
  const w = preamble();
  const key = familyKey('fnote', ME, U1);
  // `pub.level` / `pub.coEdit` / `pub.alive` are gov (→ notOwner). There is no fnote field that
  // is neither gov nor coEdit, so the `notCoEditable` branch is reached via `_born`, which is
  // both writeOnce and gov — assert the stronger of the two answers.
  const gov = w.A.zorro.op('pub.set', key, { 'pub.coEdit': false }, { space: FSP, ms: T.now });
  const r = foldAuthorized([...w.ops, gov], authzCtx());
  assert.equal(reasonOf(r, gov), 'notOwner');
});

test('B2d FAILED (defence holds): revoking co-edit retroactively withdraws every co-editor write', () => {
  const w = preamble();
  const key = familyKey('fnote', ME, U1);
  const edit = w.A.zorro.op('pub.set', key, { 'pub.text': 'von Zorro' }, { space: FSP, ms: T.coedit });
  const revoke = w.A.me.op('pub.set', key, { 'pub.coEdit': false }, { space: FSP, ms: T.coedit + 1000 });

  assert.equal(wasAdmitted(foldAuthorized([...w.ops, edit], authzCtx()), edit), true);
  const r = foldAuthorized([...w.ops, edit, revoke], authzCtx());
  assert.equal(reasonOf(r, edit), 'noCoEdit', 'the final register decides, at every stamp');
  assert.equal(noteById(mat(r), U1).text, 'Zahnarzt');
});

test('B2e FAILED (defence holds): admissibility does not depend on arrival order — 200 shuffles', () => {
  const w = preamble();
  const key = familyKey('fnote', ME, U1);
  const grant = w.A.me.op('pub.set', key, { 'pub.coEdit': true }, { space: FSP, ms: T.coedit - 100 });
  const edit = w.A.zorro.op('pub.set', key, { 'pub.text': 'von Zorro' }, { space: FSP, ms: T.coedit });
  const revoke = w.A.me.op('pub.set', key, { 'pub.coEdit': false }, { space: FSP, ms: T.coedit + 100 });
  const regrant = w.A.me.op('pub.set', key, { 'pub.coEdit': true }, { space: FSP, ms: T.coedit + 200 });
  const all = [...w.ops, grant, edit, revoke, regrant];

  const base = snapshot(foldAuthorized(all, authzCtx()));
  const rnd = lcg(0xB2E);
  for (let i = 0; i < 200; i++) {
    // shuffle AND duplicate: a re-pull with a different batch boundary must change nothing.
    const perm = shuffle(rnd, all);
    const dup = perm.concat(perm.slice(0, 5));
    assert.deepEqual(snapshot(foldAuthorized(dup, authzCtx())), base,
      `arrival order ${i} changed the admitted set — a race would grant a write`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// B3 — OPID SQUATTING. Pass A keeps ONE body per opId, and it picks by canonical JSON.
//
// ADR 002 §5.1 lists exactly this attack against `oid` — "to suppress a delete by colliding its
// id" — and blocks it in the AAD, which stops the RELAY. It does not stop a MEMBER, who chooses
// their own `oid` and signs it honestly. Pass A (authz.js:445-462) then throws one of the two
// bodies away before any admissibility check has run, so the loser is suppressed even when the
// winner is inadmissible.
//
// `mem_ZORRO…` sorts after `mem_ME…`, and `act` is the first key canonicalJSON compares.
// Real member ids are random; an attacker regenerates until theirs sorts high.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('B3 SUCCEEDED: re-using another member\'s opId deletes their op from every device', () => {
  const w = preamble();
  const publish = w.ops.find((o) => o.k === 'pub.set' && o.act === ME);
  assert.ok(publish, 'precondition: ME published U1');

  // I author an entirely legitimate op of my own — on MY OWN entity, which I am entitled to
  // write — and give it the opId of ME's publication.
  const squat = w.A.zorro.op('pub.set', familyKey('fnote', ZORRO, U2),
    { 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-11-11', 'pub.text': 'meins' },
    { space: FSP, ms: T.now, id: publish.id });

  const r = foldAuthorized([...w.ops, squat], authzCtx());
  assert.deepEqual(r.splicedIds, [publish.id], 'the collision is at least detected…');
  const survivor = r.admitted.find((o) => o.id === publish.id);
  assert.ok(survivor, 'one body under that id survived…');
  assert.equal(survivor.act, ZORRO,
    'EXPECTED FAILURE: the body that survived is MINE, not ME\'s — the loser is not retried');
  assert.equal(r.admitted.some((o) => o === publish), false,
    'EXPECTED FAILURE: ME\'s own publication op was discarded before admissibility ran');
  assert.equal(cell(r, familyKey('fnote', ME, U1), 'pub.level'), undefined,
    'EXPECTED FAILURE: my entry was never published — the family never sees it');
});

test('B3b SUCCEEDED: squatting suppresses a PRIVACY DOWNGRADE and keeps my text on the family board', () => {
  const w = preamble();
  const key = familyKey('fnote', ME, U1);
  // I decide U1 should be private again. This is the op that must never be suppressible.
  const downgrade = w.A.me.op('pub.set', key,
    { 'pub.level': 'privat', 'pub.text': null, 'pub.date': null, 'pub.repeatsYearly': null },
    { space: FSP, ms: T.now });
  const clean = foldAuthorized([...w.ops, downgrade], authzCtx());
  assert.equal(cell(clean, key, 'pub.level').value, 'privat', 'precondition: the downgrade works');

  const squat = w.A.zorro.op('pub.set', familyKey('fnote', ZORRO, U2),
    { 'pub.level': 'belegt', 'pub.alive': true, 'pub.date': '2026-11-11' },
    { space: FSP, ms: T.now + 1, id: downgrade.id });

  const r = foldAuthorized([...w.ops, downgrade, squat], authzCtx());
  assert.equal(cell(r, key, 'pub.level').value, 'geteilt',
    'EXPECTED FAILURE: the retraction never happened; "Zahnarzt" is still shared with the family');
  assert.equal(cell(r, key, 'pub.text').value, 'Zahnarzt');
});

test('B3c SUCCEEDED: an inadmissible body still evicts the admissible one (dedupe runs before authz)', () => {
  const w = preamble();
  const publish = w.ops.find((o) => o.k === 'pub.set' && o.act === ME);
  // This body is rejected at stage 3a — and ME's op is gone anyway.
  const squat = w.A.zorro.op('pub.set', familyKey('fnote', PAPA, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
    { 'pub.level': 'privat' }, { space: FSP, ms: T.now, id: publish.id });
  const r = foldAuthorized([...w.ops, squat], authzCtx());
  assert.equal(reasonOf(r, squat), 'notOwner', 'my forged body is refused…');
  assert.equal(r.admitted.some((o) => o === publish), false,
    '…and ME\'s legitimate op died with it');
  assert.equal(cell(r, familyKey('fnote', ME, U1), 'pub.level'), undefined,
    'EXPECTED FAILURE: nothing published U1, so the entry is invisible to the whole family');
});

test('B3d — the suppression is deterministic across shuffles, so every device loses the same op', () => {
  const w = preamble();
  const publish = w.ops.find((o) => o.k === 'pub.set' && o.act === ME);
  const squat = w.A.zorro.op('pub.set', familyKey('fnote', ZORRO, U2),
    { 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-11-11' },
    { space: FSP, ms: T.now, id: publish.id });
  const all = [...w.ops, squat];
  const base = snapshot(foldAuthorized(all, authzCtx()));
  const rnd = lcg(0xB3D);
  for (let i = 0; i < 50; i++) {
    assert.deepEqual(snapshot(foldAuthorized(shuffle(rnd, all), authzCtx())), base);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// B4 — THE 24-HOUR FIELD PIN. A stamp 23 h in the future is ADMITTED by design (§1.3).
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('B4 SUCCEEDED: a co-editor pins my note\'s text for a day with a +23 h stamp', () => {
  const w = preamble();
  const key = familyKey('fnote', ME, U1);
  const pin = w.A.zorro.op('pub.set', key, { 'pub.text': 'ZORRO WAR HIER' },
    { space: FSP, ms: T.now + 23 * HOUR });
  // I notice, and fix my own note through the normal path, repeatedly, at real wall time.
  const fixes = [1, 2, 3].map((i) => w.A.me.op('note.set', noteKey(U1), { text: `Zahnarzt ${i}` },
    { space: PSP, ms: T.now + i * 1000 }));

  const r = foldAuthorized([...w.ops, pin, ...fixes], authzCtx());
  assert.equal(wasAdmitted(r, pin), true, 'inside MAX_FUTURE_DRIFT_MS, so not parked');
  assert.equal(noteById(mat(r), U1).text, 'ZORRO WAR HIER',
    'EXPECTED FAILURE: every edit I make to MY OWN note loses to a co-editor\'s future stamp');
});

test('B4b FAILED (defence holds): +25 h is parked, and parking is not admission', () => {
  const w = preamble();
  const key = familyKey('fnote', ME, U1);
  const far = w.A.zorro.op('pub.set', key, { 'pub.text': 'ZU WEIT' },
    { space: FSP, ms: T.now + 25 * HOUR });
  const r = foldAuthorized([...w.ops, far], authzCtx());
  assert.equal(r.parked.some((o) => o.id === far.id), true);
  assert.equal(r.parkReasonOf(far.id), 'future');
  assert.equal(noteById(mat(r), U1).text, 'Zahnarzt');
});

test('B4c SUCCEEDED: with ctx.nowMs omitted the clamp is off and a year-9999 stamp wins forever', () => {
  const w = preamble();
  const key = familyKey('fnote', ME, U1);
  const forever = w.A.zorro.op('pub.set', key, { 'pub.text': 'FUER IMMER' },
    { space: FSP, ms: 9999999999999 });
  // `nowMs` is optional on the ctx (ops.contract §4 types it `nowMs?`), and `classifyOp` only
  // arms the clamp `if (typeof ctx.nowMs === 'number')`.
  const r = foldAuthorized([...w.ops, forever], { me: ME, attestVerify: authzCtx().attestVerify });
  assert.equal(wasAdmitted(r, forever), true,
    'EXPECTED FAILURE: an optional ctx field is the only thing between the log and a permanent pin');
  assert.equal(noteById(mat(r), U1).text, 'FUER IMMER');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// B5 — ATTESTATION. §4.0's write-once rule, and what the blob is NOT bound to.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('B5 FAILED (defence holds): I cannot add a device to another member\'s record', () => {
  const w = preamble();
  const inject = w.A.zorro.op('member.set', memberKey(PAPA),
    { [`dev.${D.zorro.short}`]: attestationBlob(PAPA, D.zorro) }, { space: FSP, ms: 0 });
  const r = foldAuthorized([...w.ops, inject], authzCtx());
  assert.equal(reasonOf(r, inject), 'notSelf');
  assert.equal(r.attestedDevices.get(PAPA).has(D.zorro.id), false);
});

test('B5b FAILED (defence holds): a second, backdated claim on my own dev.<short> is refused', () => {
  const w = preamble();
  const replace = w.A.zorro.op('member.set', memberKey(ZORRO),
    { [`dev.${D.zorro.short}`]: attestationBlob(ZORRO, { ...D.zorro, id: D.eve.id }) },
    { space: FSP, ms: 0 });   // ms = 0 → the MINIMAL write, which is exactly what write-once takes
  const r = foldAuthorized([...w.ops, replace], authzCtx());
  // Minimal-under-≺ wins, so the BACKDATED claim is the admitted one and the honest one loses.
  const honest = w.ops.find((o) => o.k === 'member.set' && o.act === ZORRO && Object.keys(o.f)[0].startsWith('dev.'));
  assert.equal(wasAdmitted(r, replace), true);
  assert.equal(reasonOf(r, honest), 'writeOnce',
    'write-once is "smallest stamp wins", so backdating replaces a device record — but only my own');
  assert.equal(r.attestedDevices.get(ZORRO).has(D.eve.id), true);
  assert.equal(r.attestedDevices.get(ZORRO).has(D.zorro.id), false);
});

test('B5c SUCCEEDED: I can claim ANOTHER member\'s deviceId inside my own attestation', () => {
  const w = preamble();
  // The blob's `deviceId` is not bound to anything. `parseAttestationBlob` checks only that
  // `memberId === subject` and `deviceShort === the register name`. So I sign, with my own key,
  // a payload that says "dev_PAPAMAC belongs to me", and file it in MY OWN record.
  const shortOfLie = short16('LIE');
  const blob = attestationBlob(ZORRO, { id: D.papa.id, short: shortOfLie });
  const claim = w.A.zorro.op('member.set', memberKey(ZORRO), { [`dev.${shortOfLie}`]: blob },
    { space: FSP, ms: 0 });   // ms = 0: first in (ts,id) order ⇒ first into `memberOfDevice`

  const r = foldAuthorized([...w.ops, claim], authzCtx());
  assert.equal(wasAdmitted(r, claim), true);
  assert.equal(r.attestedDevices.get(ZORRO).has(D.papa.id), true,
    'EXPECTED FAILURE: PAPA\'s device is now an attested device of MINE');
  assert.equal(r.memberOfDevice(D.papa.id), ZORRO,
    'EXPECTED FAILURE: memberOfDevice() — the map ADR 002 §5.2 uses to check `op.act` — now names ME');

  // And the stage-0b device gate lets me author ops from "Papas Mac".
  const spoof = w.A.zorro.op('pub.set', familyKey('fnote', ZORRO, U2),
    { 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-12-24', 'pub.text': 'x' },
    { space: FSP, ms: T.now, dev: D.papa.id });
  const r2 = foldAuthorized([...w.ops, claim, spoof], authzCtx());
  assert.equal(wasAdmitted(r2, spoof), true,
    'EXPECTED FAILURE: stage 0b admits my op authored from a device that is not mine');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// B6 — THE PERSONAL SPACE. What the fold alone does and does not guarantee.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('B6 SUCCEEDED (latent): a forged personal-space op is admitted when ctx.myDevices is omitted', () => {
  const w = preamble();
  // `op.act` is a plaintext field. Stage 0b's family branch checks the attestation table; the
  // personal branch checks `op.act === me` and then `myDevices` — ONLY IF the caller passed one.
  const forged = w.A.zorro.op('note.set', noteKey(U1), { text: 'gekapert', date: '2027-01-01' },
    { space: PSP, ms: T.now, act: ME });
  const r = foldAuthorized([...w.ops, forged], authzCtx());
  assert.equal(wasAdmitted(r, forged), true,
    'EXPECTED FAILURE: an op from an unknown device rewrote my truth register');
  assert.equal(noteById(mat(r), U1).text, 'gekapert');
});

test('B6b FAILED (defence holds): ctx.myDevices closes it', () => {
  const w = preamble();
  const forged = w.A.zorro.op('note.set', noteKey(U1), { text: 'gekapert' },
    { space: PSP, ms: T.now, act: ME });
  const r = foldAuthorized([...w.ops, forged], authzCtx({ myDevices: new Set([D.me.id, D.meLaptop.id]) }));
  assert.equal(reasonOf(r, forged), 'notMyDevice');
  assert.equal(noteById(mat(r), U1).text, 'Zahnarzt');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// B7 — REPLAY, DUPLICATION, UNKNOWN KINDS. The set-based core does its job.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('B7 FAILED (defence holds): replaying a stale co-edit after revocation grants nothing', () => {
  const w = preamble();
  const key = familyKey('fnote', ME, U1);
  const grant = w.A.me.op('pub.set', key, { 'pub.coEdit': true }, { space: FSP, ms: T.coedit });
  const edit = w.A.zorro.op('pub.set', key, { 'pub.text': 'von Zorro' }, { space: FSP, ms: T.coedit + 10 });
  const revoke = w.A.me.op('pub.set', key, { 'pub.coEdit': false }, { space: FSP, ms: T.coedit + 20 });
  // Replay the grant a hundred times. It is the same op, so it is the same register write.
  const replays = Array.from({ length: 100 }, () => grant);
  const r = foldAuthorized([...w.ops, grant, edit, revoke, ...replays], authzCtx());
  assert.equal(reasonOf(r, edit), 'noCoEdit');
  assert.equal(noteById(mat(r), U1).text, 'Zahnarzt');
});

test('B7b FAILED (defence holds): an invented op kind is parked, never admitted', () => {
  const w = preamble();
  const weird = {
    v: 1, id: 'WEIRDoooooooooooooooo1', ts: '1787836900000.000000.' + short16('ZORROMAC'),
    space: FSP, act: ZORRO, dev: D.zorro.id, gid: 'WEIRDgggggggggggggggg1',
    k: 'owner.transfer', e: familyKey('fnote', ME, U1), f: { owner: ZORRO },
  };
  const r = foldAuthorized([...w.ops, weird], authzCtx());
  assert.equal(r.parkReasonOf(weird.id), 'unknownKind');
  assert.equal(wasAdmitted(r, weird), false);
});

test('B7c FAILED (defence holds): an `owner` field is not constructible and is parked if hand-rolled', () => {
  const w = preamble();
  assert.throws(() => w.A.zorro.op('pub.set', familyKey('fnote', ME, U1), { owner: ZORRO },
    { space: FSP, ms: 0 }), /unknown field/i);
  const handRolled = {
    v: 1, id: 'OWNERoooooooooooooooo1', ts: '1787836900000.000000.' + short16('ZORROMAC'),
    space: FSP, act: ZORRO, dev: D.zorro.id, gid: 'OWNERgggggggggggggggg1',
    k: 'pub.set', e: familyKey('fnote', ME, U1), f: { owner: ZORRO },
  };
  const r = foldAuthorized([...w.ops, handRolled], authzCtx());
  assert.equal(r.parkReasonOf(handRolled.id), 'unknownField');
});

test('B7d FAILED (defence holds): minting a family key that reuses my uuid makes it THEIR entry', () => {
  const w = preamble();
  const clone = w.A.zorro.op('pub.set', familyKey('fnote', ZORRO, U1),
    { 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-09-10', 'pub.text': 'Zahnarzt' },
    { space: FSP, ms: T.now, born: true });
  const r = foldAuthorized([...w.ops, clone], authzCtx());
  const st = mat(r);
  assert.equal(noteById(st, U1).text, 'Zahnarzt', 'my own entry is untouched');
  assert.equal(noteById(st, U1).ownerId, ME);
  const theirs = st.notes.find((n) => n.entityKey === familyKey('fnote', ZORRO, U1));
  assert.ok(theirs, 'theirs is a separate, correctly-attributed entry');
  assert.equal(theirs.ownerId, ZORRO);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// B8 CLOSED — THE ONE ORDER-DEPENDENCE THIS SUITE FOUND, AND ITS ROOT CAUSE.
//
// The defect: ADR 001 §0.2 / §6 say the result is a function of the SET. `authz.js` says so
// twice, and `rejected`/`parked` were de-multiset-ed during WP-1 integration for exactly this
// reason. But the SPLICE RESOLUTION ran only over ops that classified as `admit`: a body that
// PARKED short-circuited straight into `parkOp`, which dedupes by opId, so the FIRST body seen
// won and the second was swallowed. Two devices that pulled the same log in different batch
// orders retained DIFFERENT BODIES under the same opId — and a parked op is a register write
// waiting to be applied (§7.4). They also recorded different park REASONS, and the reason
// decides WHEN the op unparks: `future` when the wall clock advances, `unknownField` only after
// an app update. Same set, two devices, two different days, two different writes.
//
// The fix (`authz.js`, Pass A): classification no longer decides the contest. Every body that is
// not a protocol violation enters one candidate map, the canonical max wins — exactly as in
// `oplog.js:append` — and only THEN is the winner routed to `parkOp` or to the fold. A rejected
// body still never competes.
//
// Two properties follow that the old code did not have, and both are asserted below: the
// retained body and its park reason are a function of the SET (B8), and the splice verdict no
// longer depends on THIS DEVICE'S CLOCK (B8b) — under the old code, whether the two bodies met
// at all depended on which side of the 24 h future clamp one of them fell on.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('B8 CLOSED: the retained body AND its park reason are a function of the op set', () => {
  const w = preamble();
  const ID = 'PARKoooooooooooooooooo';
  const key = familyKey('fnote', ZORRO, U2);
  const futureBody = w.A.zorro.op('pub.set', key,
    { 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-12-01' },
    { space: FSP, ms: T.now + 25 * HOUR, id: ID });
  const unknownFieldBody = { ...futureBody, ts: futureBody.ts, f: { 'pub.wat': 1 } };

  // NOT VACUOUS — in isolation these two bodies really do park for DIFFERENT reasons. Without
  // this, the equality below could hold simply because both happened to park the same way.
  assert.equal(foldAuthorized([...w.ops, futureBody], authzCtx()).parkReasonOf(ID), 'future');
  assert.equal(foldAuthorized([...w.ops, unknownFieldBody], authzCtx()).parkReasonOf(ID), 'unknownField');

  const a = foldAuthorized([...w.ops, futureBody, unknownFieldBody], authzCtx());
  const b = foldAuthorized([...w.ops, unknownFieldBody, futureBody], authzCtx());

  // THE FIX: one body survives on both devices, and it is the content-addressable max — not
  // whichever envelope the relay happened to hand over first.
  const winner = canonicalJSON(futureBody) > canonicalJSON(unknownFieldBody)
    ? futureBody : unknownFieldBody;
  for (const [name, r] of [['arrival order A', a], ['arrival order B', b]]) {
    const held = r.parked.filter((o) => o.id === ID);
    assert.equal(held.length, 1, `${name}: exactly one body retained`);
    assert.deepEqual(held[0].f, winner.f, `${name}: and it is the canonical max`);
  }
  assert.equal(a.parkReasonOf(ID), b.parkReasonOf(ID),
    'THE POINT: the same set of ops now unparks on the same day on every device');

  // Re-delivery does not change it either, and the splice is reported exactly once (A5).
  const again = foldAuthorized([...w.ops, unknownFieldBody, futureBody, unknownFieldBody], authzCtx());
  assert.deepEqual(snapshot(again), snapshot(b));
  assert.deepEqual(again.splicedIds, [ID]);
  assert.equal(again.parkReasonOf(ID), a.parkReasonOf(ID));

  assert.deepEqual(snapshot(a), snapshot(b));
});

test('B8b CLOSED: a splice is a splice even when one body parks — and the clock does not vote', () => {
  const w = preamble();
  const ID = 'PARK2ooooooooooooooooo';
  const key = familyKey('fnote', ZORRO, U2);
  const parked = w.A.zorro.op('pub.set', key, { 'pub.level': 'geteilt', 'pub.alive': true },
    { space: FSP, ms: T.now + 25 * HOUR, id: ID });
  const live = w.A.zorro.op('pub.set', key, { 'pub.level': 'belegt', 'pub.alive': true },
    { space: FSP, ms: T.now, id: ID });

  const a = foldAuthorized([...w.ops, parked, live], authzCtx());
  const b = foldAuthorized([...w.ops, live, parked], authzCtx());
  assert.deepEqual(snapshot(a), snapshot(b), 'both arrival orders agree');

  // Two different bodies under one opId is envelope splicing (ADR 002 §5.1) whatever this
  // build's verdict on either of them happens to be. It used to go UNREPORTED whenever one body
  // parked, because the two never met.
  assert.deepEqual(a.splicedIds, [ID]);
  assert.deepEqual(b.splicedIds, [ID]);

  // THE PROPERTY THE OLD CODE LACKED. Under the old code the two bodies met only if BOTH
  // classified as admit, so whether they contested at all depended on which side of the 24 h
  // future clamp `parked` fell on — i.e. on the local wall clock. Fold the identical set on a
  // device whose clock is 26 h further along, where `parked` classifies as admit instead:
  const ahead = foldAuthorized([...w.ops, parked, live], authzCtx({ nowMs: T.now + 26 * HOUR }));
  assert.deepEqual(ahead.splicedIds, [ID], 'still one splice, still reported');

  const winner = canonicalJSON(parked) > canonicalJSON(live) ? parked : live;
  const bodyOf = (r) => [...r.admitted, ...r.parked].find((o) => o.id === ID).f;
  assert.deepEqual(bodyOf(a), winner.f, 'the canonical max wins…');
  assert.deepEqual(bodyOf(ahead), winner.f, '…and the two clocks agree on which body that is');
});
