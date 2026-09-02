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
// the refusal. A row named INVERTED used to say SUCCEEDED and now asserts the refusal instead.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THE ANSWERING PASS CHANGED, AND WHAT IT DELIBERATELY DID NOT
// ─────────────────────────────────────────────────────────────────────────────────────────────
//   · **§2 is INVERTED — T5-M3.** The founder anchor now asks whether the founder is still LIVE.
//     Once she is not, every removal in that space takes a second member row. §2a-ii is the
//     non-vacuity, and §2a measures the caveat: in a founder-less TWO-member circle the rule is
//     unsatisfiable, leaving is the way out, and the circle survives.
//   · **§3e is INVERTED — T5-M4, the half a blind relay can close.** A proof presented against an
//     already-removed target is refused. §3e-ii proves the refusal is precise: an UNPROOFED
//     retry is still 20.2's idempotent 200.
//   · **§1d, §1e, §1f and §3d still SUCCEED, and that is the finding.** T5-M2: a `Member` row is
//     not a person, and no blind relay can make it one. §1f now costs Eve a co-signature per
//     removal and she pays it out of her own Keychain. What the answering pass did instead of
//     pretending otherwise was DEMOTE the claim on the wire — `proves` / `provesNot` on every
//     response, `checks` / `doesNotCheck` on every 403 — and BOUND the fleet: §1g is inverted in
//     half by `invites.js#MAX_LIVE_MEMBERS`, ADR 003 §3.2's eight seats made a check.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCircle, join, memberRow, deviceRow, S,
} from './e6-attack-circle.js';
import { adminProofString } from '../../server/core/auth.js';
import { b64u } from '../../src/js/core/b64.js';

const TE = new TextEncoder();

/**
 * Sign one admin proof with a member's RECOVERY signing key — the key `verifyAdminProof` checks.
 *
 * `presenter` is the Mac the proof is minted FOR, and since T5-M4 landed it is inside the signed
 * bytes (`lzp/admin/2`). The helper takes it as its own parameter rather than folding it into
 * `terms` so that every call site below has to say out loud who is going to spend the proof —
 * which is exactly the fact §3d showed nobody was saying.
 */
async function mintProof(signer, presenter, { act, spaceId, target, epoch }) {
  const bytes = TE.encode(adminProofString({
    act, spaceId, target, epoch, presenter: presenter.forStore.memberId,
  }));
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
    const proof = await mintProof(C.eve, C.eve, {
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

      const proof = await mintProof(C.eve2, C.eve, {
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
      const proof = await mintProof(C.eve2, C.eve, {
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
    '§1f · SUCCEEDED — and then she empties the circle: N co-signed removals plus one leave',
    async () => {
      // UNCHANGED IN VERDICT, CHANGED IN COST, and the change is the honest measurement of what
      // T5-M3's founder-liveness rule did and did not buy. Removing the founder makes the anchor
      // name a tombstone, and from that moment EVERY removal in the space needs a second member
      // row — so the three bare removals this row used to make are now three 403s. They are not
      // three refusals for EVE, because she is holding the second row: she co-signs each one with
      // `eve2` and the circle empties exactly as before.
      //
      // That is T5-M2 stated as a measurement rather than an opinion. The gate stops a member who
      // has one identity. It counts to two, and Eve has two.
      const C = await circle(['eve2']);
      assert.equal((await join(C, C.eve2, { inviter: C.eve })).status, 200);
      const seen = await members(C, C.eve);
      const proofFor = (target) => mintProof(C.eve2, C.eve, {
        act: 'member.remove', spaceId: C.spaceId, target, epoch: seen.currentEpoch,
      });

      assert.equal((await remove(C, C.eve, C.papa.forStore.memberId,
        { adminProof: await proofFor(C.papa.forStore.memberId) })).status, 200);

      // The founder is gone, so the bare removal that used to work is now refused — and it names
      // the new reason rather than the founder one, because the target is not the founder.
      const bare = await remove(C, C.eve, C.mama.forStore.memberId);
      assert.equal(bare.status, 403, JSON.stringify(bare.json));
      assert.equal(bare.json.reason, 'founder_gone_every_removal_needs_second_key');

      // And her second Keychain entry answers it.
      assert.equal((await remove(C, C.eve, C.mama.forStore.memberId,
        { adminProof: await proofFor(C.mama.forStore.memberId) })).status, 200);
      // eve2 cannot co-sign her own removal (`admin_proof_self_signed` is about the CALLER, and
      // the caller is Eve) — the relay's only distinctness rule is `by !== caller`, so the second
      // row signing away the second row is admitted.
      assert.equal((await remove(C, C.eve, C.eve2.forStore.memberId,
        { adminProof: await proofFor(C.eve2.forStore.memberId) })).status, 200);

      const out = await leave(C, C.eve);
      assert.equal(out.status, 200);
      assert.equal(out.json.spaceDeleted, true, 'the last-member-out cascade — T5-M1c, end to end');
    });

  await t.test(
    '§1g · INVERTED IN HALF — the identities are BOUNDED now, at ADR 003 §3.2\'s eight seats',
    async () => {
      // WAS: "the number of second keys she can hold is not bounded by anything". `MAX_OPEN_
      // INVITES = 20` bounds how many invites are open AT ONCE, and every one of Eve's is
      // redeemed the moment she mints it, so `open` never exceeded one — and there was no member
      // cap in `server/core/` at all, so ADR 003 §3.2's "at most 8 rows of pseudonymous ids" was
      // a sentence and not a check.
      //
      // NOW: `invites.js#MAX_LIVE_MEMBERS`. This is NOT a fix for T5-M2 and the file says so —
      // a `Member` row is still not a person, and one identity is all the gate needs. What it
      // fixes is the unbounded half: a relay that promises eight rows on the wire and admits
      // eighty was lying to its own client.
      const C = await circle(['s1', 's2', 's3', 's4', 's5', 's6']);
      for (let i = 1; i <= 6; i++) C.colors[`s${i}`] = `farbe${i}`;
      for (let i = 1; i <= 5; i++) {
        assert.equal((await join(C, C[`s${i}`], { inviter: C.eve })).status, 200, `sybil ${i}`);
      }
      const seen = await members(C, C.eve);
      const live = seen.members.filter((m) => (m.removedAt ?? null) === null);
      assert.equal(live.length, 8, 'three real people and five identities on one Mac');
      const ids = new Set(live.map((m) => m.memberId));
      assert.equal(ids.size, 8);

      // THE BOUND. The ninth seat does not exist, and the refusal comes at the INVITE — before
      // an admin composes an email around a code that could never work.
      let refused = null;
      try { await join(C, C.s6, { inviter: C.eve }); } catch (e) { refused = e; }
      assert.notEqual(refused, null, 'a ninth live member was admitted');
      assert.match(String(refused.message), /space_full/);

      // NON-VACUITY, and the deliberate shape of the cap: a seat freed by a removal is a seat.
      // Tombstones are NOT counted (the opposite choice from `deleteSpace`'s exemption, for the
      // opposite reason — see `invites.js`), so a family that has said goodbye to somebody can
      // still invite. Which is also what leaves the sybil bounded rather than closed: Eve buys
      // each further identity with a removal.
      // (Papa is still live and s1 is not the founder, so this removal needs no second row.)
      assert.equal((await remove(C, C.eve, C.s1.forStore.memberId)).status, 200);
      assert.equal((await join(C, C.s6, { inviter: C.eve })).status, 200, 'the freed seat is a seat');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · THE FOUNDER ANCHOR AFTER THE FOUNDER HAS GONE
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§2 · the anchor is a member id, and a member id can stop being a member', async (t) => {
  await t.test(
    '§2a · INVERTED — once the founder leaves, EVERY removal needs a second row (T5-M3)',
    async () => {
      // WAS: "SUCCEEDED — once the founder LEAVES, one ordinary member destroys the circle
      // alone". `required: founder !== null && memberId === founder` never asked whether the
      // founder was still LIVE, so the honest, shipped exit — transfer, then leave
      // (`leavedelete.js`) — deleted the gate on its way out and left T5-M1c wide open behind it.
      //
      // NOW the anchor is asked both questions. Once it no longer names a live member the relay
      // has lost the one blind fact that told a survivable removal from a space-destroying one,
      // so it stops guessing and requires a second member row for every removal in that space.
      const C = await circle();
      // The honest, shipped path: an admin who leaves transfers first (`leavedelete.js:503`).
      const tr = await C.papa.transport.request('POST', '/api/v1/members/transfer', undefined, {
        spaceId: C.spaceId, memberId: C.mama.forStore.memberId,
      }, {});
      assert.equal(tr.status, 200, 'transferAdmin is a shipped op');
      const gone = await leave(C, C.papa);
      assert.equal(gone.status, 200);
      assert.equal(gone.json.spaceDeleted, false, 'Mama and Eve are still here');

      const rm = await remove(C, C.eve, C.mama.forStore.memberId);
      assert.equal(rm.status, 403, JSON.stringify(rm.json));
      assert.equal(rm.json.error, 'admin_proof_required');
      assert.equal(rm.json.reason, 'founder_gone_every_removal_needs_second_key');

      // THE CAVEAT, MEASURED RATHER THAN HIDDEN. This circle is down to two, so the rule is
      // UNSATISFIABLE: the only member who could co-sign is the target. Mama cannot be removed
      // by Eve at all, and Eve cannot be removed by Mama.
      assert.equal((await remove(C, C.mama, C.eve.forStore.memberId)).status, 403);

      // Nobody is trapped, and that is why the cost is the smaller one: leaving still works, and
      // the last member out takes the space with her (20.3). What is closed is one member
      // EMPTYING a circle other people are still in.
      const out = await leave(C, C.eve);
      assert.equal(out.status, 200);
      assert.notEqual(out.json.spaceDeleted, true, 'Mama is still in it');
      const after = await members(C, C.mama);
      assert.deepEqual(
        after.members.filter((m) => (m.removedAt ?? null) === null).map((m) => m.memberId),
        [C.mama.forStore.memberId], 'THE INVARIANT: the Familienkreis is still there, and Mama is in it');
    });

  await t.test(
    '§2a-ii · NON-VACUITY — with a third row standing, the founder-less removal still works',
    async () => {
      // A refusal that refuses everything is an outage, not a gate. Three members, founder gone,
      // and one co-signature turns the very same request into the 20.2 removal.
      const C = await circle(['oma']);
      assert.equal((await join(C, C.oma)).status, 200);
      assert.equal((await leave(C, C.papa)).status, 200);
      const seen = await members(C, C.eve);
      const ok = await remove(C, C.eve, C.mama.forStore.memberId, {
        adminProof: await mintProof(C.oma, C.eve, {
          act: 'member.remove', spaceId: C.spaceId,
          target: C.mama.forStore.memberId, epoch: seen.currentEpoch,
        }),
      });
      assert.equal(ok.status, 200, JSON.stringify(ok.json));
      assert.equal(ok.json.authorizedBy, 'admin_proof');
      assert.ok(ok.json.removed);
      // …and the response refuses to let that enum mean more than the relay checked. T5-M2.
      assert.match(ok.json.proves, /Member rows/);
      assert.match(ok.json.provesNot, /two distinct PEOPLE/);
    });

  await t.test(
    '§2b · INVERTED — a founder who rejoins is NOT removable by one member on her own word',
    async () => {
      // WAS: "SUCCEEDED". Papa leaves and comes back through the ordinary invite flow — same
      // human, same Mac, NEW `Member.id` — so the anchor named a tombstone while the person it
      // was there to protect sat in the circle unprotected.
      const C = await circle(['papaBack']);
      C.colors.papaBack = 'tuerkis';
      assert.equal((await leave(C, C.papa)).status, 200);
      assert.equal((await join(C, C.papaBack, { inviter: C.mama })).status, 200);
      const rm = await remove(C, C.eve, C.papaBack.forStore.memberId);
      assert.equal(rm.status, 403, JSON.stringify(rm.json));
      assert.equal(rm.json.reason, 'founder_gone_every_removal_needs_second_key');

      // The residual is stated rather than implied: the relay is NOT recognising Papa. It has no
      // way to — a rejoined founder is a new row like any other, and E2-L1b is why. What it is
      // doing is refusing to treat a founder-less circle as an unguarded one.
      const seen = await members(C, C.eve);
      const ok = await remove(C, C.eve, C.papaBack.forStore.memberId, {
        adminProof: await mintProof(C.mama, C.eve, {
          act: 'member.remove', spaceId: C.spaceId,
          target: C.papaBack.forStore.memberId, epoch: seen.currentEpoch,
        }),
      });
      assert.equal(ok.status, 200, 'two rows still remove him — the anchor never came back');
    });

  await t.test(
    '§2c · FAILED — while the founder is present, the gate is real for BOTH shapes',
    async () => {
      const C = await circle();
      assert.equal((await remove(C, C.mama, C.papa.forStore.memberId)).status, 403);
      assert.equal((await remove(C, C.eve, C.papa.forStore.memberId)).status, 403);
      // and a proof for the WRONG target does not travel
      const seen = await members(C, C.eve);
      const wrong = await mintProof(C.mama, C.eve, {
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
    const proof = await mintProof(C.mama, C.eve, {
      act: 'member.remove', spaceId: 'fsp_00000000000000000000000000',
      target: C.papa.forStore.memberId, epoch: seen.currentEpoch,
    });
    assert.equal((await remove(C, C.eve, C.papa.forStore.memberId, { adminProof: proof })).status, 401);
  });

  await t.test('§3b · FAILED — a proof for the WRONG ACT does not travel', async () => {
    const C = await circle();
    const seen = await members(C, C.eve);
    const proof = await mintProof(C.mama, C.eve, {
      act: 'space.delete', spaceId: C.spaceId, target: C.papa.forStore.memberId,
      epoch: seen.currentEpoch,
    });
    assert.equal((await remove(C, C.eve, C.papa.forStore.memberId, { adminProof: proof })).status, 401);
  });

  await t.test('§3c · FAILED — a proof at a NEIGHBOURING epoch does not travel', async () => {
    const C = await circle();
    const seen = await members(C, C.eve);
    for (const e of [seen.currentEpoch - 1, seen.currentEpoch + 1]) {
      const proof = await mintProof(C.mama, C.eve, {
        act: 'member.remove', spaceId: C.spaceId,
        target: C.papa.forStore.memberId, epoch: e,
      });
      assert.equal(
        (await remove(C, C.eve, C.papa.forStore.memberId, { adminProof: proof })).status, 401,
        `epoch ${e}`);
    }
  });

  await t.test(
    '§3d · INVERTED — a proof NAMES its beneficiary now, so Eve cannot spend Papa\'s (T5-M4)',
    async () => {
      // WAS: "SUCCEEDED — a proof is a BEARER token: it names no beneficiary, so Eve spends
      // Papa's". Mama co-signed so that PAPA — the founder, and by every product story the admin
      // — could remove Oma, and nothing in `lzp/admin/1 | act | spaceId | target | epoch` said
      // who may present it. Eve presented it and got 200.
      //
      // The landing was never a design question; it was ONE OWNER PER FILE. The integrating pass
      // owns all three minting helpers, so the fifth component is now in the signed bytes:
      // `lzp/admin/2 | act | spaceId | target | epoch | presenter`, presenter =
      // `terms.callerMemberId`, taken off the AUTHENTICATED device's member row and never off
      // the body. It landed BEFORE any co-signature screen exists, which was the condition.
      const C = await circle(['oma']);
      assert.equal((await join(C, C.oma)).status, 200);
      const seen = await members(C, C.eve);

      const forPapa = await mintProof(C.mama, C.papa, {
        act: 'member.remove', spaceId: C.spaceId,
        target: C.oma.forStore.memberId, epoch: seen.currentEpoch,
      });
      const res = await remove(C, C.eve, C.oma.forStore.memberId, { adminProof: forPapa });
      assert.equal(res.status, 401, JSON.stringify(res.json));
      assert.equal(res.json.error, 'bad_signature');
      assert.equal(res.json.check, 'admin_proof');
      // A 401 and not a 400: from the relay's side a proof over different bytes is a wrong
      // signature and there is nothing to enumerate — the same shape as the wrong act, the
      // wrong epoch and the wrong space above. No oracle is added by the binding.
      const r = await members(C, C.eve);
      const oma = r.members.find((m) => m.memberId === C.oma.forStore.memberId);
      assert.equal(oma.removedAt ?? null, null, 'and Oma is still a member');

      // NON-VACUITY, and it is the honest control for this row: the SAME co-signature, minted by
      // the same Mama over the same act, target and epoch, works when the member it names is the
      // one who spends it. The binding refuses a stranger, not the co-signature.
      const forEve = await mintProof(C.mama, C.eve, {
        act: 'member.remove', spaceId: C.spaceId,
        target: C.oma.forStore.memberId, epoch: seen.currentEpoch,
      });
      const ok = await remove(C, C.eve, C.oma.forStore.memberId, { adminProof: forEve });
      assert.equal(ok.status, 200, JSON.stringify(ok.json));
      assert.equal(ok.json.authorizedBy, 'admin_proof');

      // WHAT THIS DOES NOT BUY, said here because the row above could be misread as closing
      // T5-M2: §1d's Eve holds TWO member rows, so she mints her own second-row proof naming
      // HERSELF as presenter and it verifies. Binding the beneficiary stops a proof travelling
      // between two PEOPLE. It cannot make two rows into two people.
    });

  await t.test(
    '§3e · INVERTED — a SPENT proof is not a standing one (T5-M4, the half that could be closed)',
    async () => {
      // WAS: "SUCCEEDED — and it is REPLAYABLE for as long as nobody rotates". ADR 003 §3.7
      // argued that the epoch bounds a proof because "a removal forces e+1". It does not: the
      // relay only ANSWERS `rotateRequired: true`, a CLIENT performs the rotation, and the
      // attacker is the client — so the same bytes re-authorized the same act indefinitely.
      //
      // The relay cannot make the rotation happen. What it can do is notice that the act has
      // already happened: an act that has already happened is not an act a proof can authorize.
      const C = await circle(['oma']);
      assert.equal((await join(C, C.oma)).status, 200);
      const seen = await members(C, C.eve);
      const proof = await mintProof(C.mama, C.eve, {
        act: 'member.remove', spaceId: C.spaceId,
        target: C.papa.forStore.memberId, epoch: seen.currentEpoch,
      });
      // Spent once.
      assert.equal((await remove(C, C.eve, C.papa.forStore.memberId, { adminProof: proof })).status, 200);
      // NON-VACUITY: nothing rotated, so the OLD reason this worked is still in place.
      const still = await members(C, C.eve);
      assert.equal(still.currentEpoch, seen.currentEpoch, 'the epoch never moved');

      const again = await remove(C, C.eve, C.papa.forStore.memberId, { adminProof: proof });
      assert.equal(again.status, 400, JSON.stringify(again.json));
      assert.equal(again.json.reason, 'admin_proof_target_already_removed');
      assert.equal(again.json.alreadyRemoved, true,
        'and it says so, because the client must render this as „ist bereits entfernt" and never '
        + 'as a failed removal — that is the honest cost of the refusal (ADR 003 §3.7)');
    });

  await t.test(
    '§3e-ii · the refusal is PRECISE — an unproofed retry is still the idempotent 200 no-op',
    async () => {
      // The row above must not have been bought by breaking 20.2's idempotency. A retried
      // removal that carries no proof is unchanged: `alreadyRemoved: true`, 200, no second
      // confirmation dialogue. Only presenting a PROOF for an act that has already happened is
      // refused.
      const C = await circle(['oma']);
      assert.equal((await join(C, C.oma)).status, 200);
      assert.equal((await remove(C, C.eve, C.oma.forStore.memberId)).status, 200);
      const retry = await remove(C, C.eve, C.oma.forStore.memberId);
      assert.equal(retry.status, 200, JSON.stringify(retry.json));
      assert.equal(retry.json.alreadyRemoved, true);
      assert.equal(retry.json.removed, false);
    });

  await t.test('§3f · FAILED — a REMOVED member\'s signature is not a second key', async () => {
    const C = await circle(['oma']);
    assert.equal((await join(C, C.oma)).status, 200);
    assert.equal((await remove(C, C.eve, C.oma.forStore.memberId)).status, 200);
    const seen = await members(C, C.eve);
    const proof = await mintProof(C.oma, C.eve, {
      act: 'member.remove', spaceId: C.spaceId,
      target: C.papa.forStore.memberId, epoch: seen.currentEpoch,
    });
    const res = await remove(C, C.eve, C.papa.forStore.memberId, { adminProof: proof });
    assert.equal(res.status, 400);
    assert.equal(res.json.reason, 'admin_proof_signer_not_a_member');
  });
});
