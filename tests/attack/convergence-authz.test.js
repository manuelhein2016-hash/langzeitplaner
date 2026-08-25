// tests/attack/convergence-authz.test.js
//
// CONVERGENCE ATTACKS against src/js/core/authz.js — the staged fold whose whole reason to exist
// is "admissibility is a function of the SET of ops, never of the enumeration".

import test from 'node:test';
import assert from 'node:assert/strict';

import { foldAuthorized, snapshot } from '../../src/js/core/authz.js';
import { canonicalJSON } from '../../src/js/core/canon.js';
import { noteKey, memberKey, spaceKey, familyKey } from '../../src/js/core/entities.js';
import {
  generate, attestationBlob, attestVerify, DEVICES, ME, MAMA, PAPA, PSP, FSP,
} from '../helpers/gen.js';
import { BASE_MS, minter, shuffled, pad22 } from './_kit.js';

const M = (d) => minter(d, { fsp: FSP });

const DEV = {
  meDesk: DEVICES.find((d) => d.name === 'me-desktop'),
  meLap: DEVICES.find((d) => d.name === 'me-laptop'),
  mama: DEVICES.find((d) => d.name === 'mama-mac'),
  papa: DEVICES.find((d) => d.name === 'papa-mac'),
};

const NOTE = '5e1a0000-0000-4000-8000-000000000001';
const soloCtx = { me: ME, nowMs: BASE_MS };

// ─────────────────────────────────────────────────────────────────────────────
// A5 CLOSED — `splicedIds` is now a function of the SET, not of the delivery.
//
// The defect: authz.js fixed exactly this class of bug for `rejected` and `parked` during WP-1
// ("a re-pull whose batch boundary differs would otherwise make two devices report 2 parked and
// 1 parked for the same log"). `splicedIds` was left as a running push with no dedupe, so a
// re-pull that re-delivered one of the two spliced bodies made two devices report a different
// number of splices for the same log. It is now collected into a Set and sorted — the same
// discipline as its two siblings, applied at the one place it was missing.
// ─────────────────────────────────────────────────────────────────────────────

test('A5 CLOSED — splicedIds is idempotent under duplicate delivery', () => {
  const op = M(DEV.meDesk);
  const ID = pad22('SPLICED');
  const a = op('note.set', noteKey(NOTE), { date: '2026-09-10', text: 'A' }, { ms: BASE_MS, space: PSP, id: ID });
  const b = op('note.set', noteKey(NOTE), { date: '2026-09-10', text: 'B' }, { ms: BASE_MS, space: PSP, id: ID });

  const once = foldAuthorized([a, b], soloCtx);
  const redelivered = foldAuthorized([a, b, a], soloCtx);
  const heavily = foldAuthorized([b, a, b, a, b, a, a], soloCtx);

  // The WINNER converges — the content-addressable max is ACI, and that part was always sound.
  assert.deepEqual(snapshot(once).regs, snapshot(redelivered).regs);

  // THE FIX: so does the reported splice list, and so does the whole result.
  assert.deepEqual(once.splicedIds, [ID]);
  assert.deepEqual(redelivered.splicedIds, [ID]);
  assert.deepEqual(heavily.splicedIds, [ID]);
  assert.deepEqual(snapshot(once), snapshot(redelivered));
  assert.deepEqual(snapshot(once), snapshot(heavily));

  // NOT VACUOUS — the list is deduped, not emptied or hard-coded to one entry. A second,
  // independent splice is still reported, and the two are sorted.
  const ID2 = pad22('SPLICED2');
  const c = op('note.set', noteKey(NOTE), { text: 'C' }, { ms: BASE_MS + 1, space: PSP, id: ID2 });
  const d = op('note.set', noteKey(NOTE), { text: 'D' }, { ms: BASE_MS + 1, space: PSP, id: ID2 });
  const both = foldAuthorized([a, b, c, d, a, c], soloCtx);
  assert.deepEqual(both.splicedIds, [ID, ID2].sort());

  // …and an honest duplicate — the SAME body twice — is not a splice at all.
  assert.deepEqual(foldAuthorized([a, a, a], soloCtx).splicedIds, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// A6 CLOSED — a SPLICED PARKED op is resolved content-addressably, like every other.
//
// The defect: the content-addressable splice resolution ran only on ops that classified as
// `admit`. An op that PARKED (unknown version / kind / field / space, or a future stamp)
// short-circuited into `parkOp`, which dedupes by opId, so the retained body was whichever
// arrived first. A parked op is retained precisely so it can be applied later (§7.4), so two
// devices that received the two envelopes in opposite orders would apply DIFFERENT ops after
// the app update, and never reconcile.
//
// The fix routes every non-rejected body through one candidate map and resolves the splice
// BEFORE the verdict is acted on — the same rule, and now literally the same shape, as
// `oplog.js:append`, whose A6 half was fixed at the same time.
// ─────────────────────────────────────────────────────────────────────────────

test('A6 CLOSED — two bodies under one opId that PARK: the retained body is the canonical max', () => {
  const op = M(DEV.meDesk);
  const ID = pad22('PARKSPLICE');
  const mk = (text) => {
    const base = op('note.set', noteKey(NOTE), { date: '2026-09-10', text }, { ms: BASE_MS, space: PSP, id: ID });
    return Object.freeze({ ...base, v: 2 });            // a version this build does not know
  };
  const a = mk('A');
  const b = mk('B');

  const one = foldAuthorized([a, b], soloCtx);
  const two = foldAuthorized([b, a], soloCtx);

  assert.equal(one.parked.length, 1);
  assert.equal(two.parked.length, 1);
  assert.equal(one.parkReasonOf(ID), 'version');
  assert.equal(two.parkReasonOf(ID), 'version');

  // THE FIX: same set, same retained body, on every device — so after the app update both
  // devices apply the same text to the same register.
  const winner = canonicalJSON(a) > canonicalJSON(b) ? a : b;
  assert.equal(one.parked[0].f.text, winner.f.text);
  assert.equal(two.parked[0].f.text, winner.f.text);
  assert.deepEqual(one.parked[0], two.parked[0]);
  assert.deepEqual(snapshot(one), snapshot(two));

  // The splice is reported even though neither body could be applied — a splice is a property
  // of the envelopes, not of this build's verdict on their contents.
  assert.deepEqual(one.splicedIds, [ID]);
  assert.deepEqual(two.splicedIds, [ID]);

  // NOT VACUOUS — the losing body is a real, different body, so `deepEqual` above is the
  // resolution agreeing rather than the two inputs being identical to begin with.
  assert.notDeepEqual(a.f, b.f);
  assert.equal([a.f.text, b.f.text].includes(winner.f.text), true);

  // And it survives shuffling and duplication of the whole batch.
  for (let seed = 1; seed <= 20; seed++) {
    const perm = shuffled([a, b, a, b], seed);
    assert.deepEqual(snapshot(foldAuthorized(perm, soloCtx)), snapshot(one), `seed ${seed}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLS
// ─────────────────────────────────────────────────────────────────────────────

test('CONTROL — foldAuthorized is invariant under shuffle + duplication on generated worlds', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const w = generate(seed);
    const all = [...w.setupOps, ...w.ops];
    const reference = snapshot(foldAuthorized(all, w.authzCtx));
    for (const s of [seed * 7 + 1, seed * 13 + 3]) {
      const perm = shuffled([...all, ...shuffled(all, s).slice(0, 5)], s);
      assert.deepEqual(snapshot(foldAuthorized(perm, w.authzCtx)), reference, `seed ${seed}/${s}`);
    }
  }
});

test('CONTROL — a co-edit grant that is later revoked is retroactively withdrawn on every device', () => {
  const w = world();
  const grant = w.me('pub.set', w.fkey, { 'pub.level': 'geteilt', 'pub.coEdit': true },
    { ms: BASE_MS + 100, space: FSP });
  const coedit = w.mamaOp('pub.set', w.fkey, { 'pub.text': 'von Mama' }, { ms: BASE_MS + 200, space: FSP });
  const revoke = w.me('pub.set', w.fkey, { 'pub.coEdit': false }, { ms: BASE_MS + 300, space: FSP });

  const withRevoke = [...w.setup, grant, coedit, revoke];
  const seenGrantFirst = foldAuthorized(withRevoke, w.ctx);
  const seenRevokeFirst = foldAuthorized([...w.setup, revoke, coedit, grant], w.ctx);
  assert.deepEqual(snapshot(seenGrantFirst), snapshot(seenRevokeFirst));
  assert.equal(seenGrantFirst.rejectionOf(coedit.id).reason, 'noCoEdit');
});

test('CONTROL — ownership cannot be backdated: a stamp of 0 does not steal an entry', () => {
  const w = world();
  const share = w.me('pub.set', w.fkey, { 'pub.level': 'geteilt', 'pub.coEdit': true },
    { ms: BASE_MS + 100, space: FSP });
  // Mama, running a modified client, writes a governing field on MY entity at ms = 0.
  const steal = w.mamaOp('pub.set', w.fkey, { 'pub.level': 'privat', 'pub.coEdit': false },
    { ms: 0, space: FSP });
  const r = foldAuthorized([...w.setup, share, steal], w.ctx);
  assert.equal(r.rejectionOf(steal.id).reason, 'notOwner');
  assert.equal(r.regs.get(w.fkey).get('pub.level').value, 'geteilt');
});

test('CONTROL — the admin chain resolves identically under every permutation', () => {
  const w = world();
  const g = w.setup.find((o) => o.k === 'space.set');
  const t1 = w.me('space.set', spaceKey(FSP), { admin: MAMA, adminPrev: g.id },
    { ms: BASE_MS + 400, space: FSP });
  const t2 = w.me('space.set', spaceKey(FSP), { admin: PAPA, adminPrev: g.id },
    { ms: BASE_MS + 400, space: FSP });          // a deliberate same-millisecond rival
  const t3 = M(DEV.mama)('space.set', spaceKey(FSP), { admin: PAPA, adminPrev: t1.id },
    { ms: BASE_MS + 500, space: FSP });

  const links = [t1, t2, t3];
  const reference = snapshot(foldAuthorized([...w.setup, ...links], w.ctx));
  for (let s = 1; s <= 32; s++) {
    assert.deepEqual(snapshot(foldAuthorized(shuffled([...w.setup, ...links, t2], s), w.ctx)), reference, `seed ${s}`);
  }
  const r = foldAuthorized([...w.setup, ...links], w.ctx);
  assert.equal(r.admin, PAPA, 'the longer chain wins (ADR 001 §4.1)');
});

// KNOWN GAP — OPEN FINDING, WP-9. Pinned to CURRENT behaviour, so this row is green while the
// gap exists; if it goes red the gap was closed and the row should be inverted, not repaired.
//
// It is the convergence-side face of `ownership-authz-admin.test.js`'s A5b ("an outsider joins
// the Kreis unassisted"): a `member:<M>` entity that exists only because of a self-authorizing
// `dev.*` attestation register is counted as a LIVE member, with no `_alive` and no invite behind
// it. `currentMembers` is what gates a foreign entry's visibility (20.2), so this decides who can
// see shared content. The fix belongs with WP-9's invite/redeem flow — membership has to be
// CONFERRED before `authz.js` can refuse to infer it — which is why it is not closed in WP-1.
// See the disposition block at the top of `ownership-authz-admin.test.js` for the full reasoning.
test('KNOWN GAP — a bare attestation makes its author a currentMember', () => {
  // Already characterized by the WP-1 author; re-run here because it is a convergence-shaped
  // hazard for WP-3: `currentMembers` is what gates a foreign entry's visibility (20.2).
  const w = world();
  assert.ok(w.r.currentMembers.has(PAPA));
  const bare = foldAuthorized(w.setup.filter((o) => !(o.k === 'member.set' && 'displayName' in o.f)), w.ctx);
  assert.ok(bare.currentMembers.has(MAMA), '`member:` exists via dev.* alone ⇒ counted as alive');
});

// ─────────────────────────────────────────────────────────────────────────────

function world() {
  const me = M(DEV.meDesk);
  const mamaOp = M(DEV.mama);
  const papaOp = M(DEV.papa);
  const fkey = familyKey('fnote', ME, NOTE);

  const att = attestationBlob;

  const setup = [
    me('member.set', memberKey(ME), { [`dev.${DEV.meDesk.short}`]: att(ME, DEV.meDesk) }, { ms: BASE_MS - 9000, space: FSP }),
    mamaOp('member.set', memberKey(MAMA), { [`dev.${DEV.mama.short}`]: att(MAMA, DEV.mama) }, { ms: BASE_MS - 8000, space: FSP }),
    papaOp('member.set', memberKey(PAPA), { [`dev.${DEV.papa.short}`]: att(PAPA, DEV.papa) }, { ms: BASE_MS - 7000, space: FSP }),
    me('member.set', memberKey(ME), { displayName: 'Ich', _alive: true }, { ms: BASE_MS - 6000, space: FSP }),
    mamaOp('member.set', memberKey(MAMA), { displayName: 'Mama', _alive: true }, { ms: BASE_MS - 5000, space: FSP }),
    papaOp('member.set', memberKey(PAPA), { displayName: 'Papa', _alive: true }, { ms: BASE_MS - 4000, space: FSP }),
    me('space.set', spaceKey(FSP), { admin: ME, adminPrev: null, name: 'Familie' }, { ms: BASE_MS - 3000, space: FSP }),
  ];

  const ctx = { me: ME, nowMs: BASE_MS + 10 * 3600000, attestVerify };
  return { me, mamaOp, papaOp, fkey, setup, ctx, r: foldAuthorized(setup, ctx) };
}
