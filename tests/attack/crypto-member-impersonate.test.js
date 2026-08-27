// ─────────────────────────────────────────────────────────────────────────────
// T5 — THE FAMILY MEMBER TRYING TO *BE* SOMEONE ELSE (ADR 002 §0, §2.3, §5.2)
//
//   M-I1  author an op as another member                                FAILED (fold + check 5)
//   M-I2  adopt another member's device                                 FAILED (three ways)
//   M-I3  claim another member's `deviceShort` — the I-3 / R5-7 squat    see below
//   M-I4  mint an attestation `attestationOf` hands to `openOp` as theirs FAILED (attribution)
//   M-I5  stamp my ops with a peer's short                              FAILED at openOp,
//                                                                       **ADMITTED by the fold**
//
// ═══ THE I-3 / R5-7 VERDICT, WHICH IS THE THING THIS FILE WAS OPENED FOR ═══
//
// The task asks whether the situation is better, worse or unchanged now that P2 is enforced.
// Answer: **the confidentiality half is closed, the availability half is WORSE than the ADR
// admits, and ADR 002 §2.3's stated remedy is provably ineffective.** Three separate claims,
// each with a row below:
//
//  (a) CLOSED. A squatter can never be handed `openOp`'s verification key for a short she does
//      not own, and can never make an op read as authored by her victim. §2.3 condition (3)
//      forces `att.memberId` to be the HOUSING member, so check 5 refuses. M-I4.
//
//  (b) WORSE. `attestationOf` returns `null` for a contested short, `dev.*` is write-once, and
//      there is no revocation anywhere — so ONE op from any member permanently parks EVERY
//      envelope the victim's Mac will ever seal. The ADR calls this "a squatter can stall a
//      peer's envelopes"; the honest word is *permanently*, and it is one op, not a campaign.
//      M-I3a/b.
//
//  (c) AND THERE IS A WINDOW IN WHICH IT IS NOT EVEN A PARK. Before the victim's own
//      `member.set{dev.*}` has been folded — a partial pull, a fresh joiner, any batch boundary —
//      `attestationOf` resolves the squatter's blob, P2 PASSES (she copied a public key and told
//      the truth about it), and check 5 then throws. §5.2.5 is explicit that a rejection is final
//      and that `store.js` drops a rejected op without appending it. So in that window the squat
//      converts the victim's traffic from *parked* to *dropped*. M-I3c.
//
//  (d) THE STATED REMEDY DOES NOT WORK. ADR 002 §2.3 "Two shorts, no winner" says:
//      "`attestOpen` (WP-6) MUST enforce P2, which closes this at the root and removes the
//      stall." It does not, and `identity.js`'s own header says so: `sigPubRaw` is a PUBLIC key
//      travelling in the victim's own register. The built `attestOpen` (`verifyAttestation`)
//      enforces P2 today, and the squat still passes. M-I3a asserts exactly that.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { foldAuthorized } from '../../src/js/core/authz.js';
import * as identity from '../../src/js/crypto/identity.js';
import * as sk from '../../src/js/crypto/spacekeys.js';
import { sealOp, openOp, ENVELOPE_PARK } from '../../src/js/crypto/envelope.js';
import { adoptPairedDevice } from '../../src/js/crypto/pairing.js';
import { memKeyStore } from '../../src/js/platform/keystore.js';
import {
  makeMember, memberRecord, ring, tableOf, makeOp, hdrFor, attOp, attestOpenOver,
  outcomeOf, mkSpaceId, mkDeviceId, fmt, DAY,
} from './_member-kit.js';

const FSP = mkSpaceId('family');

/** The squat, as one function, because four tests need exactly it.
 *  Mama files an attestation in HER OWN record, under PAPA's `deviceShort`, carrying PAPA's
 *  public signing point — which she reads out of Papa's own `dev.*` register, inside the E2EE
 *  stream every member can read — and signs it with her own recovery key. */
async function squatOn(victimDevice, squatter, over = {}) {
  const att = await identity.buildDeviceAttestation(
    { memberId: squatter.memberId, deviceId: over.deviceId ?? victimDevice.deviceId, createdAt: over.createdAt ?? '2020-01-01' },
    victimDevice.devSig.publicKey,                       // ← the copied PUBLIC key
    over.kexPub ?? squatter.devices[0].devKex.publicKey  // ← her own agreement key, or any
  );
  return { att, blob: await identity.attestDevice(att, squatter.rec.recSig.privateKey) };
}

// ═════════════════════════════════════════════════════════════════════════════
// M-I1 — author an op as another member
// ═════════════════════════════════════════════════════════════════════════════

describe('T5 authors as another member', () => {
  test('M-I1 FAILED — twice over: stage 0b refuses at the fold, check 5 refuses at the envelope', async () => {
    const papa = await makeMember();
    const mama = await makeMember();
    const P = papa.devices[0];
    const M = mama.devices[0];

    const attestOpen = await attestOpenOver([
      [papa.memberId, P.attestation, papa.rec.recSig.publicKey],
      [mama.memberId, M.attestation, mama.rec.recSig.publicKey],
    ]);
    const registers = [
      attOp(papa.memberId, P, P.attestation, P.deviceShort, FSP, 1787836800000),
      attOp(mama.memberId, M, M.attestation, M.deviceShort, FSP, 1787836800001),
    ];

    // (a) At the FOLD. Mama's device is attested — in Mama's record. Stage 0b asks whether
    //     `op.dev` is attested in `op.act`'s OWN record, so naming Papa as the actor fails.
    const forged = makeOp(M, FSP, {
      k: 'member.set', e: `member:${papa.memberId}`, f: { displayName: 'Mama' }, act: papa.memberId,
    });
    const r = foldAuthorized([...registers, forged], { me: papa.memberId, attestOpen });
    assert.deepEqual(r.rejectionOf(forged.id), { stage: 'attestation', reason: 'unattestedDevice' });

    // (b) At the ENVELOPE, where it matters even more, because `openOp` runs before the fold and
    //     17.6 renders `op.act` as „von Mama". Check 5 binds the decrypted actor to the
    //     attestation the header's `dv` resolved.
    const PSP = mkSpaceId('personal');
    const key = await sk.createSpaceKey();
    const op = makeOp(M, PSP, { act: papa.memberId });
    const env = await sealOp(op, ring([[PSP, 1, key]]), M.devSig.privateKey, hdrFor(op, M, 1));
    assert.equal(await outcomeOf(() => openOp(env, ring([[PSP, 1, key]]), tableOf(M))), 'C5');

    // (c) …and `sealOp` refuses to build it in the first place when the outbox hands it the
    //     device's own attestation, which turns a permanent remote failure into a local one.
    await assert.rejects(
      () => sealOp(op, ring([[PSP, 1, key]]), M.devSig.privateKey, hdrFor(op, M, 1), { attestation: M.att }),
      (err) => err.check === 'C5'
    );
  });

  test('M-I1b FAILED — Mama cannot file a device into Papa\'s record, even with a blob that verifies', async () => {
    const papa = await makeMember();
    const mama = await makeMember();
    const P = papa.devices[0];
    const M = mama.devices[0];

    // The two shapes she has. (i) her own honest blob, filed into Papa's record — condition (1).
    const intoHis = attOp(papa.memberId, M, M.attestation, M.deviceShort, FSP, 1787836800000);
    intoHis.act = mama.memberId;   // she signs as herself, writing his record
    // (ii) Papa's own blob copied verbatim into her record — condition (3).
    const hisIntoHers = attOp(mama.memberId, M, P.attestation, P.deviceShort, FSP, 1787836800002);

    const attestOpen = await attestOpenOver([
      [papa.memberId, P.attestation, papa.rec.recSig.publicKey],
      [papa.memberId, M.attestation, papa.rec.recSig.publicKey],
      [mama.memberId, M.attestation, mama.rec.recSig.publicKey],
      [mama.memberId, P.attestation, mama.rec.recSig.publicKey],
    ]);
    const r = foldAuthorized([
      attOp(papa.memberId, P, P.attestation, P.deviceShort, FSP, 1787836700000),
      attOp(mama.memberId, M, M.attestation, M.deviceShort, FSP, 1787836700001),
      intoHis, hisIntoHers,
    ], { me: papa.memberId, attestOpen });

    assert.equal(r.rejectionOf(intoHis.id).reason, 'notSelf');
    assert.equal(r.rejectionOf(hisIntoHers.id).reason, 'badAttestation');
    // Papa still has exactly one device, and it is his.
    assert.deepEqual([...r.attestedDevices.get(papa.memberId)], [P.deviceId]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M-I2 — adopt another member's device
// ═════════════════════════════════════════════════════════════════════════════

describe('T5 adopts another member\'s device', () => {
  test('M-I2 FAILED — adoption refuses a non-empty store, a foreign pair and a device that is not the one delivered', async () => {
    const papa = await makeMember();
    const mama = await makeMember();

    // (a) Mama tries to adopt herself onto a Mac that already belongs to Papa.
    const papasMac = memKeyStore();
    await identity.ensureRecoveryIdentity(papasMac, papa.memberId, { createdAt: DAY });
    const fresh = await identity.generateDeviceKeys();
    await assert.rejects(
      () => adoptPairedDevice(papasMac, {
        memberId: mama.memberId, recSig: mama.rec.recSig, recKex: mama.rec.recKex,
        spaces: { personal: null, family: null },
      }, { ...fresh, deviceId: mkDeviceId() }, { createdAt: DAY }),
      (err) => typeof err.code === 'string'
    );

    // (b) The recovery keys are the identity, and `restorePairingPayload` is the only door to
    //     them. Mama holds Papa's PUBLIC recovery key (it is in every attestation she can read)
    //     and that is not a door: it cannot sign, so no attestation she mints verifies as his.
    const probe = new TextEncoder().encode('lzp/v2/attack/probe');
    const sig = await identity.signBytes(mama.rec.recSig.privateKey, probe);
    assert.equal(await identity.verifyBytes(papa.rec.recSig.publicKey, sig, probe), false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M-I3 — the squat.  I-3 / R5-7.
// ═════════════════════════════════════════════════════════════════════════════

describe('T5 claims another member\'s deviceShort (I-3 / R5-7)', () => {
  test('M-I3a **SUCCEEDED** — the squat passes P2 and all four §2.3 acceptance conditions, so §2.3\'s stated remedy ("attestOpen MUST enforce P2, which closes this at the root") is ineffective', async () => {
    const papa = await makeMember();
    const mama = await makeMember();
    const P = papa.devices[0];
    const { att, blob } = await squatOn(P, mama);

    // P2 — `crock32(SHA-256(sigPubRaw)[0..10]) === deviceShort` — holds, because she told the
    // truth about a key that was never secret.
    assert.equal(att.deviceShort, P.deviceShort);
    assert.equal(identity.attestationSelfConsistent(att), true);
    // `attestDevice` MINTS it: the one guard there is P2, and P2 is satisfied.
    assert.equal(typeof blob, 'string');
    // `verifyAttestation` — the built `attestOpen`, which enforces P2 as a MUST — accepts it
    // under MAMA'S recovery key, which is the key §2.3 condition (4) says to use.
    const opened = await identity.verifyAttestation(blob, mama.rec.recSig.publicKey);
    assert.notEqual(opened, null, 'P2 refused the squat — if this fails, I-3 is CLOSED');
    assert.equal(opened.memberId, mama.memberId);
    assert.equal(opened.deviceShort, P.deviceShort);
  });

  test('M-I3b **SUCCEEDED** — one op permanently parks every envelope the victim will ever seal, and there is no way back', async () => {
    const papa = await makeMember();
    const mama = await makeMember();
    const P = papa.devices[0];
    const M = mama.devices[0];
    const { blob } = await squatOn(P, mama);

    const attestOpen = await attestOpenOver([
      [papa.memberId, P.attestation, papa.rec.recSig.publicKey],
      [mama.memberId, blob, mama.rec.recSig.publicKey],
    ]);
    const honest = attOp(papa.memberId, P, P.attestation, P.deviceShort, FSP, 1787836800000);
    const squat = attOp(mama.memberId, M, blob, P.deviceShort, FSP, 1787836900000);   // LATER, deliberately

    const r = foldAuthorized([honest, squat], { me: papa.memberId, attestOpen });
    // Both are ADMITTED. Neither is rejected: they are well-formed writes to two different
    // records, and write-once is per-register.
    assert.deepEqual(r.rejected, []);
    assert.deepEqual(r.shortCollisions, [P.deviceShort]);
    // …and the lookup now refuses to answer at all.
    assert.equal(r.attestationOf(P.deviceShort), null);

    // So every envelope Papa's Mac seals parks, for ever.
    const PSP = mkSpaceId('personal');
    const key = await sk.createSpaceKey();
    const op = makeOp(P, PSP);
    const env = await sealOp(op, ring([[PSP, 1, key]]), P.devSig.privateKey, hdrFor(op, P, 1));
    assert.equal(
      await outcomeOf(() => openOp(env, ring([[PSP, 1, key]]), (dv) => r.attestationOf(dv))),
      `park:${ENVELOPE_PARK.ATTESTATION}`
    );

    // THERE IS NO WAY BACK, and this is the half that makes it worse than the ADR says. Papa
    // cannot withdraw or amend anything (`dev.*` is write-once), and Mama's claim cannot be
    // revoked (there is no revocation input anywhere in the fold — §8.2a). A second attestation
    // for the SAME short in Papa's record loses to his own first claim; a `null` write loses too.
    const replacement = attOp(papa.memberId, P, P.attestation, P.deviceShort, FSP, 1787837000000);
    const withdrawal = { ...attOp(papa.memberId, P, P.attestation, P.deviceShort, FSP, 1787837100000) };
    withdrawal.f = { [`dev.${P.deviceShort}`]: null };
    const r2 = foldAuthorized([honest, squat, replacement, withdrawal], { me: papa.memberId, attestOpen });
    assert.equal(r2.rejectionOf(replacement.id).reason, 'writeOnce');
    assert.equal(r2.attestationOf(P.deviceShort), null, 'still refused');

    // And Papa cannot re-key around it either: a NEW device gets a NEW short, but every op he
    // ever wrote is stamped with the old one and every one of those envelopes stays parked.
    assert.equal(op.ts.endsWith(P.deviceShort), true, 'the short is the last 16 chars of every stamp');
  });

  test('M-I3c **SUCCEEDED, AND WORSE THAN A PARK** — in the pre-collision window the victim\'s envelopes are HARD-REJECTED, which §5.2.5 says is silent data loss', async () => {
    // The window is ordinary, not contrived: there is no causal delivery (ADR 001 §2), pulls are
    // batched, and a joiner starts from seq 0. Any client that has folded the squat but not yet
    // Papa's own `member.set{dev.*}` is in it.
    const papa = await makeMember();
    const mama = await makeMember();
    const P = papa.devices[0];
    const M = mama.devices[0];
    // She copies Papa's attestation payload verbatim except `memberId`, which condition (3)
    // forces to be hers — so `deviceId` is his too.
    const { blob } = await squatOn(P, mama, { deviceId: P.deviceId, createdAt: P.att.createdAt });

    const attestOpen = await attestOpenOver([[mama.memberId, blob, mama.rec.recSig.publicKey]]);
    const squatOnly = foldAuthorized(
      [attOp(mama.memberId, M, blob, P.deviceShort, FSP, 1787836900000)],
      { me: papa.memberId, attestOpen });

    // The lookup hands `openOp` HER blob for HIS short — there is nothing yet to contest it.
    const resolved = squatOnly.attestationOf(P.deviceShort);
    assert.notEqual(resolved, null);
    assert.equal(resolved.memberId, mama.memberId);
    assert.deepEqual(squatOnly.shortCollisions, [], 'nothing is reported as contested yet');

    const PSP = mkSpaceId('personal');
    const key = await sk.createSpaceKey();
    const op = makeOp(P, PSP, { f: { date: '2026-09-10', text: 'Zahnarzt' } });
    const env = await sealOp(op, ring([[PSP, 1, key]]), P.devSig.privateKey, hdrFor(op, P, 1));

    // P2 passes (his key, his short). P3 passes (his signature, verified under his own key,
    // named by her blob). P4 passes. The decrypt SUCCEEDS. It dies at check 5 — a THROW.
    assert.equal(
      await outcomeOf(() => openOp(env, ring([[PSP, 1, key]]), (dv) => squatOnly.attestationOf(dv))),
      'C5');
  });

  test('M-I3d — the contest is DETECTABLE, which is the whole of the mitigation that exists', async () => {
    const papa = await makeMember();
    const mama = await makeMember();
    const P = papa.devices[0];
    const M = mama.devices[0];
    const { blob } = await squatOn(P, mama);
    const attestOpen = await attestOpenOver([
      [papa.memberId, P.attestation, papa.rec.recSig.publicKey],
      [mama.memberId, blob, mama.rec.recSig.publicKey],
    ]);
    const r = foldAuthorized([
      attOp(papa.memberId, P, P.attestation, P.deviceShort, FSP, 1787836800000),
      attOp(mama.memberId, M, blob, P.deviceShort, FSP, 1787836900000),
    ], { me: papa.memberId, attestOpen });
    assert.deepEqual(r.shortCollisions, [P.deviceShort]);
    // §2.3's closing paragraph asks the member panel to render this. Nothing else acts on it,
    // and the panel is WP-9, so today it is reported to nobody.
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M-I4 — mint an attestation that `attestationOf` hands to `openOp` AS THEIRS
// ═════════════════════════════════════════════════════════════════════════════

describe('T5 tries to make an op read as another member\'s', () => {
  test('M-I4 FAILED — attribution is the half of I-3 that IS closed, and condition (3) is what closes it', async () => {
    const papa = await makeMember();
    const mama = await makeMember();
    const P = papa.devices[0];
    const M = mama.devices[0];

    // The only attestation she can get into the table under Papa's short is one whose
    // `memberId` is HERS (§2.3 condition (3), enforced at `authz.js` stage 0a). So the best she
    // can do is make Papa's envelopes fail check 5 — which is M-I3c — and NEVER make one of her
    // OWN envelopes read as his.
    const { blob, att } = await squatOn(P, mama, { deviceId: M.deviceId });
    const attestOpen = await attestOpenOver([[mama.memberId, blob, mama.rec.recSig.publicKey]]);
    const r = foldAuthorized([attOp(mama.memberId, M, blob, P.deviceShort, FSP, 1787836900000)],
      { me: mama.memberId, attestOpen });
    const table = r.attestationOf(P.deviceShort);
    assert.equal(table.memberId, mama.memberId, 'she cannot put HIS memberId in there');

    // She now seals under HIS short. She has no key for it: P3 is verified against
    // `att.sigPubRaw`, which is Papa's public point, and only Papa's private half signs for it.
    const PSP = mkSpaceId('personal');
    const key = await sk.createSpaceKey();
    const op = makeOp(M, PSP, { ts: fmt(1787836800123, 3, P.deviceShort), dev: M.deviceId });
    const env = await sealOp(op, ring([[PSP, 1, key]]),
      M.devSig.privateKey, { v: 1, sp: PSP, ep: 1, dv: P.deviceShort, oid: op.id, wit: '' });
    assert.equal(await outcomeOf(() => openOp(env, ring([[PSP, 1, key]]), (dv) => r.attestationOf(dv))), 'P3');

    // And a `deviceId` copied into her own honest attestation buys nothing: the fold publishes
    // no `deviceId → memberId` resolver, so the label has no owner and is merely reported.
    const { blob: labelSquat } = await squatOn(M, mama, { deviceId: P.deviceId });
    void labelSquat;
    const honestWithHisLabel = await identity.buildDeviceAttestation(
      { memberId: mama.memberId, deviceId: P.deviceId, createdAt: DAY },
      M.devSig.publicKey, M.devKex.publicKey);
    const lblBlob = await identity.attestDevice(honestWithHisLabel, mama.rec.recSig.privateKey);
    const ao2 = await attestOpenOver([
      [papa.memberId, P.attestation, papa.rec.recSig.publicKey],
      [mama.memberId, lblBlob, mama.rec.recSig.publicKey],
    ]);
    const r2 = foldAuthorized([
      attOp(papa.memberId, P, P.attestation, P.deviceShort, FSP, 1787836800000),
      attOp(mama.memberId, M, lblBlob, M.deviceShort, FSP, 1787836900000),
    ], { me: papa.memberId, attestOpen: ao2 });
    assert.deepEqual(r2.deviceIdCollisions, [P.deviceId]);
    assert.equal(r2.memberOfDevice(P.deviceId), null, 'a contested label has no owner');
    assert.deepEqual(r2.shortCollisions, [], 'and the two shorts are untouched');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M-I5 — stamp forgery, and the seam that is holding it up alone
// ═════════════════════════════════════════════════════════════════════════════

describe('T5 stamps her ops with a peer\'s deviceShort', () => {
  test('M-I5 FAILED at openOp, but **the authorization fold ADMITS it** — check 4 is enforced at exactly one seam', async () => {
    // ADR 002 §5.2.2 check 4 exists because ADR 001 §6.2's proof that `≺` is a strict total order
    // rests on "two writes from different devices differ in `deviceShort`". `openOp` enforces it.
    // `foldAuthorized` does not, and nothing else does — so the premise holds only for ops that
    // arrived through a sealed envelope. Any op that reaches the log by another door (a v1
    // migration, an import, a local author, a future replay path) carries whatever short its
    // author chose.
    const papa = await makeMember();
    const mama = await makeMember();
    const P = papa.devices[0];
    const M = mama.devices[0];

    const attestOpen = await attestOpenOver([
      [papa.memberId, P.attestation, papa.rec.recSig.publicKey],
      [mama.memberId, M.attestation, mama.rec.recSig.publicKey],
    ]);
    // Mama's own record, Mama's own device, Mama's own act — and PAPA'S short in the stamp.
    const forgedStamp = makeOp(M, FSP, {
      k: 'member.set', e: `member:${mama.memberId}`, f: { displayName: 'Mama' },
      ts: fmt(1787836800999, 1, P.deviceShort),
    });
    const r = foldAuthorized([
      attOp(papa.memberId, P, P.attestation, P.deviceShort, FSP, 1787836700000),
      attOp(mama.memberId, M, M.attestation, M.deviceShort, FSP, 1787836700001),
      forgedStamp,
    ], { me: mama.memberId, attestOpen });

    assert.deepEqual(r.rejected, [], 'the fold rejected it — if this fails, check 4 gained a second enforcer');
    assert.deepEqual(r.parked, []);
    assert.ok(r.admitted.some((o) => o.id === forgedStamp.id), 'the fold ACCEPTED a stamp bearing a peer\'s short');

    // At the envelope it dies, which is the seam that is carrying the invariant.
    const PSP = mkSpaceId('personal');
    const key = await sk.createSpaceKey();
    const op = makeOp(M, PSP, { ts: fmt(1787836800999, 1, P.deviceShort) });
    const env = await sealOp(op, ring([[PSP, 1, key]]), M.devSig.privateKey,
      { v: 1, sp: PSP, ep: 1, dv: P.deviceShort, oid: op.id, wit: '' });
    assert.equal(await outcomeOf(() => openOp(env, ring([[PSP, 1, key]]), tableOf(M, P))), 'P3');
    // …and with her OWN dv in the header, `sealOp` will not even build it.
    await assert.rejects(
      () => sealOp(op, ring([[PSP, 1, key]]), M.devSig.privateKey, hdrFor(op, M, 1)),
      (err) => err.check === 'C4');
  });
});
