// tests/fleet/e6-gate-removal.test.js — THE FRESH MEMBER-ADVERSARY, ROUND 2: the new removal
// authorization.
//
// Eve is invited, attested, non-admin, running her own client. She forges nothing: every key she
// signs with is a key her own process generated, every route she calls is one the shipped client
// calls, and every body she sends is a body the relay's own readers accept.
//
// The thing under attack is `server/core/auth.js` §6b (`verifyAdminProof`, the two-key rule) and
// `server/core/handlers/lifecycle.js`'s `adminProofGate` — the founder anchor and the
// `roster.length > 1` delete gate, both landed at `6e11ca1` against findings T5-M1a/b/c.
//
// Every `test()` name says SUCCEEDED or FAILED **from the adversary's side**: SUCCEEDED means the
// attack worked and the row asserts the damage, FAILED means the defence held and the row asserts
// the refusal. Nothing here is fixed; this file only measures.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCircle, join, memberRow, deviceRow, S,
} from './e6-attack-circle.js';
import { adminProofString } from '../../server/core/auth.js';
import { b64u } from '../../src/js/core/b64.js';

const TE = new TextEncoder();

/** Sign one admin proof with a member's RECOVERY signing key — the key `verifyAdminProof` checks. */
async function mintProof(signer, { act, spaceId, target, epoch }) {
  const bytes = TE.encode(adminProofString({ act, spaceId, target, epoch }));
  const sig = new Uint8Array(await S.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, signer.recovery.recSig.privateKey, bytes));
  return { by: signer.forStore.memberId, sig: b64u(sig) };
}

const remove = (C, by, memberId, extra = {}) => by.transport.request(
  'POST', '/api/v1/members/remove', undefined, { spaceId: C.spaceId, memberId, ...extra }, {});

const del = (C, by, extra = {}) => by.transport.request(
  'POST', `/api/v1/spaces/${C.spaceId}/delete`, undefined, { confirm: C.spaceId, ...extra }, {});

const leave = (C, by) => by.transport.request(
  'POST', '/api/v1/members/leave', undefined, { spaceId: C.spaceId }, {});

const members = async (C, by) => (await by.transport.request(
  'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined, {})).json;

/** Papa founds, Mama and Eve join. The rig every row below starts from. */
async function circle(extraNames = []) {
  const C = await buildCircle(['papa', 'mama', 'eve', ...extraNames]);
  C.colors.eve2 = 'rot';
  C.colors.eve3 = 'orange';
  assert.equal((await join(C, C.mama)).status, 200);
  assert.equal((await join(C, C.eve)).status, 200);
  return C;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · THE TWO-KEY RULE, ATTACKED BY ONE PERSON WITH ONE MAC
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§1 · the founder anchor and the delete gate, from inside a real three-member circle', async (t) => {
  await t.test('§1a · FAILED — Eve alone cannot remove the founder', async () => {
    const C = await circle();
    const res = await remove(C, C.eve, C.papa.forStore.memberId);
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'admin_proof_required');
    assert.equal(res.json.reason, 'founder_removal_needs_second_key');
    const r = await members(C, C.eve);
    const papa = r.members.find((m) => m.memberId === C.papa.forStore.memberId);
    assert.equal(papa.removedAt ?? null, null, 'the founder is still a member');
  });

  await t.test('§1b · FAILED — Eve alone cannot delete a three-member circle', async () => {
    const C = await circle();
    const res = await del(C, C.eve);
    assert.equal(res.status, 403);
    assert.equal(res.json.reason, 'second_member_signature_required');
  });

  await t.test('§1c · FAILED — a proof Eve signs for herself is no evidence', async () => {
    const C = await circle();
    const seen = await members(C, C.eve);
    const proof = await mintProof(C.eve, {
      act: 'member.remove', spaceId: C.spaceId,
      target: C.papa.forStore.memberId, epoch: seen.currentEpoch,
    });
    const res = await remove(C, C.eve, C.papa.forStore.memberId, { adminProof: proof });
    assert.equal(res.status, 400);
    assert.equal(res.json.reason, 'admin_proof_self_signed');
  });

  // ── THE ATTACK ───────────────────────────────────────────────────────────────────────────────
  await t.test(
    '§1d · SUCCEEDED — Eve invites HERSELF a second time and co-signs her own founder removal',
    async () => {
      const C = await circle(['eve2']);

      // One human, one Mac, one patched app. `mintMember` is what `openDeviceIdentity` does on a
      // fresh launch: a new keystore, a new device identity, a new recovery key. Nothing is
      // forged — every key below is one Eve's own process minted, and both live in her Keychain.
      // `join()` is the SHIPPED pair of requests: Eve mints the invite (invites.js: "Any member
      // may issue an invite, not only the admin"), and her second identity redeems it.
      const joined = await join(C, C.eve2, { inviter: C.eve });
      assert.equal(joined.status, 200, 'any member may issue an invite — invites.js says so');

      const seen = await members(C, C.eve);
      assert.equal(seen.members.filter((m) => (m.removedAt ?? null) === null).length, 4);

      const proof = await mintProof(C.eve2, {
        act: 'member.remove', spaceId: C.spaceId,
        target: C.papa.forStore.memberId, epoch: seen.currentEpoch,
      });
      const res = await remove(C, C.eve, C.papa.forStore.memberId, { adminProof: proof });

      assert.equal(res.status, 200, 'THE FOUNDER GATE IS OPEN');
      assert.equal(res.json.removed, true);
      assert.equal(res.json.authorizedBy, 'admin_proof');
      assert.ok(res.json.purgedOps >= 0);
      assert.ok(res.json.revokedDevices >= 1, 'the founder\'s devices are revoked');

      const after = await members(C, C.eve);
      const papa = after.members.find((m) => m.memberId === C.papa.forStore.memberId);
      assert.notEqual(papa.removedAt ?? null, null, 'ADR 001 §4.0 attestation + §4.1 genesis, gone');
    });

  await t.test(
    '§1e · SUCCEEDED — the same second identity deletes the whole Familienkreis',
    async () => {
      const C = await circle(['eve2']);
      assert.equal((await join(C, C.eve2, { inviter: C.eve })).status, 200);
      const seen = await members(C, C.eve);
      const proof = await mintProof(C.eve2, {
        act: 'space.delete', spaceId: C.spaceId, target: C.spaceId, epoch: seen.currentEpoch,
      });
      const res = await del(C, C.eve, { adminProof: proof });
      assert.equal(res.status, 200, 'THE DELETE GATE IS OPEN');
      assert.equal(res.json.deleted, true);
      assert.equal(res.json.authorizedBy, 'admin_proof');
      // And it is gone for everybody: Papa's next request is not a 403, it is "not your family".
      const papaSees = await C.papa.transport.request(
        'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined, {});
      assert.notEqual(papaSees.status, 200);
    });

  await t.test(
    '§1f · SUCCEEDED — and then she empties the circle: N removals plus one leave',
    async () => {
      const C = await circle(['eve2']);
      assert.equal((await join(C, C.eve2, { inviter: C.eve })).status, 200);
      const seen = await members(C, C.eve);
      const proof = await mintProof(C.eve2, {
        act: 'member.remove', spaceId: C.spaceId,
        target: C.papa.forStore.memberId, epoch: seen.currentEpoch,
      });
      assert.equal((await remove(C, C.eve, C.papa.forStore.memberId, { adminProof: proof })).status, 200);
      assert.equal((await remove(C, C.eve, C.mama.forStore.memberId)).status, 200);
      assert.equal((await remove(C, C.eve, C.eve2.forStore.memberId)).status, 200);
      const out = await leave(C, C.eve);
      assert.equal(out.status, 200);
      assert.equal(out.json.spaceDeleted, true, 'the last-member-out cascade — T5-M1c, end to end');
    });

  await t.test(
    '§1g · SUCCEEDED — and the number of second keys she can hold is not bounded by anything',
    async () => {
      // `MAX_OPEN_INVITES = 20` bounds how many invites are open AT ONCE, and every one of Eve's
      // is redeemed the moment she mints it, so `open` never exceeds one. There is no member cap
      // in `server/core/` at all — `grep -rn 'MAX_MEMBERS|too_many_members' server/core/` is
      // empty — so ADR 003 §3.2's "a family is at most eight people" is a sentence and not a
      // check.
      const C = await circle(['s1', 's2', 's3', 's4', 's5']);
      for (let i = 1; i <= 5; i++) C.colors[`s${i}`] = `farbe${i}`;
      for (let i = 1; i <= 5; i++) {
        assert.equal((await join(C, C[`s${i}`], { inviter: C.eve })).status, 200, `sybil ${i}`);
      }
      const seen = await members(C, C.eve);
      const live = seen.members.filter((m) => (m.removedAt ?? null) === null);
      assert.equal(live.length, 8, 'three real people and five identities on one Mac');
      // Each is a distinct `Member.id`, so each is a distinct `memberRemovePerMemberHour` bucket
      // AND a distinct admissible co-signer.
      const ids = new Set(live.map((m) => m.memberId));
      assert.equal(ids.size, 8);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · THE FOUNDER ANCHOR AFTER THE FOUNDER HAS GONE
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§2 · the anchor is a member id, and a member id can stop being a member', async (t) => {
  await t.test(
    '§2a · SUCCEEDED — once the founder LEAVES, one ordinary member destroys the circle alone',
    async () => {
      const C = await circle();
      // The honest, shipped path: an admin who leaves transfers first (`leavedelete.js:503`).
      const tr = await C.papa.transport.request('POST', '/api/v1/members/transfer', undefined, {
        spaceId: C.spaceId, memberId: C.mama.forStore.memberId,
      }, {});
      assert.equal(tr.status, 200, 'transferAdmin is a shipped op');
      const gone = await leave(C, C.papa);
      assert.equal(gone.status, 200);
      assert.equal(gone.json.spaceDeleted, false, 'Mama and Eve are still here');

      // Eve now needs no second key for anything: every LIVE member is a non-founder.
      const rm = await remove(C, C.eve, C.mama.forStore.memberId);
      assert.equal(rm.status, 200, 'no founder gate — the anchor points at a tombstone');
      assert.equal(rm.json.authorizedBy, 'membership_only');
      const out = await leave(C, C.eve);
      assert.equal(out.json.spaceDeleted, true, 'the Familienkreis is gone, by one member alone');
    });

  await t.test(
    '§2b · SUCCEEDED — a founder who rejoins is removable by one member, on her own word',
    async () => {
      const C = await circle(['papaBack']);
      C.colors.papaBack = 'tuerkis';
      assert.equal((await leave(C, C.papa)).status, 200);
      // Papa comes back through the ordinary invite flow. New member id, same human, same Mac.
      assert.equal((await join(C, C.papaBack, { inviter: C.mama })).status, 200);
      const rm = await remove(C, C.eve, C.papaBack.forStore.memberId);
      assert.equal(rm.status, 200, 'the founder is back and the anchor no longer names him');
      assert.equal(rm.json.authorizedBy, 'membership_only');
    });

  await t.test(
    '§2c · FAILED — while the founder is present, the gate is real for BOTH shapes',
    async () => {
      const C = await circle();
      assert.equal((await remove(C, C.mama, C.papa.forStore.memberId)).status, 403);
      assert.equal((await remove(C, C.eve, C.papa.forStore.memberId)).status, 403);
      // and a proof for the WRONG target does not travel
      const seen = await members(C, C.eve);
      const wrong = await mintProof(C.mama, {
        act: 'member.remove', spaceId: C.spaceId,
        target: C.eve.forStore.memberId, epoch: seen.currentEpoch,
      });
      const res = await remove(C, C.eve, C.papa.forStore.memberId, { adminProof: wrong });
      assert.equal(res.status, 401);
      assert.equal(res.json.check, 'admin_proof');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · THE PROOF AS A BEARER TOKEN
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§3 · what the signed string binds, and what it does not', async (t) => {
  await t.test('§3a · FAILED — a proof for another SPACE does not travel', async () => {
    const C = await circle();
    const seen = await members(C, C.eve);
    const proof = await mintProof(C.mama, {
      act: 'member.remove', spaceId: 'fsp_00000000000000000000000000',
      target: C.papa.forStore.memberId, epoch: seen.currentEpoch,
    });
    assert.equal((await remove(C, C.eve, C.papa.forStore.memberId, { adminProof: proof })).status, 401);
  });

  await t.test('§3b · FAILED — a proof for the WRONG ACT does not travel', async () => {
    const C = await circle();
    const seen = await members(C, C.eve);
    const proof = await mintProof(C.mama, {
      act: 'space.delete', spaceId: C.spaceId, target: C.papa.forStore.memberId,
      epoch: seen.currentEpoch,
    });
    assert.equal((await remove(C, C.eve, C.papa.forStore.memberId, { adminProof: proof })).status, 401);
  });

  await t.test('§3c · FAILED — a proof at a NEIGHBOURING epoch does not travel', async () => {
    const C = await circle();
    const seen = await members(C, C.eve);
    for (const e of [seen.currentEpoch - 1, seen.currentEpoch + 1]) {
      const proof = await mintProof(C.mama, {
        act: 'member.remove', spaceId: C.spaceId,
        target: C.papa.forStore.memberId, epoch: e,
      });
      assert.equal(
        (await remove(C, C.eve, C.papa.forStore.memberId, { adminProof: proof })).status, 401,
        `epoch ${e}`);
    }
  });

  await t.test(
    '§3d · SUCCEEDED — a proof is a BEARER token: it names no beneficiary, so Eve spends Papa\'s',
    async () => {
      const C = await circle(['oma']);
      assert.equal((await join(C, C.oma)).status, 200);
      const seen = await members(C, C.eve);
      // Mama co-signs so that PAPA — the founder, and by every product story the admin — can
      // remove Oma. Nothing in the signed string says who may present it.
      const forPapa = await mintProof(C.mama, {
        act: 'member.remove', spaceId: C.spaceId,
        target: C.oma.forStore.memberId, epoch: seen.currentEpoch,
      });
      const res = await remove(C, C.eve, C.oma.forStore.memberId, { adminProof: forPapa });
      assert.equal(res.status, 200, 'Eve presented a proof minted for somebody else');
      assert.equal(res.json.authorizedBy, 'admin_proof');
    });

  await t.test(
    '§3e · SUCCEEDED — and it is REPLAYABLE for as long as nobody rotates',
    async () => {
      const C = await circle(['oma']);
      assert.equal((await join(C, C.oma)).status, 200);
      const seen = await members(C, C.eve);
      const proof = await mintProof(C.mama, {
        act: 'member.remove', spaceId: C.spaceId,
        target: C.papa.forStore.memberId, epoch: seen.currentEpoch,
      });
      // Spent once.
      assert.equal((await remove(C, C.eve, C.papa.forStore.memberId, { adminProof: proof })).status, 200);
      // The relay only ever SAYS `rotateRequired: true`; it cannot perform the rotation, and no
      // client here does. The epoch has not moved, so the same bytes authorize again.
      const again = await remove(C, C.eve, C.papa.forStore.memberId, { adminProof: proof });
      assert.equal(again.status, 200);
      assert.equal(again.json.alreadyRemoved, true);
      const still = await members(C, C.eve);
      assert.equal(still.currentEpoch, seen.currentEpoch, 'the epoch never moved');
    });

  await t.test('§3f · FAILED — a REMOVED member\'s signature is not a second key', async () => {
    const C = await circle(['oma']);
    assert.equal((await join(C, C.oma)).status, 200);
    assert.equal((await remove(C, C.eve, C.oma.forStore.memberId)).status, 200);
    const seen = await members(C, C.eve);
    const proof = await mintProof(C.oma, {
      act: 'member.remove', spaceId: C.spaceId,
      target: C.papa.forStore.memberId, epoch: seen.currentEpoch,
    });
    const res = await remove(C, C.eve, C.papa.forStore.memberId, { adminProof: proof });
    assert.equal(res.status, 400);
    assert.equal(res.json.reason, 'admin_proof_signer_not_a_member');
  });
});
