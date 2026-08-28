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
// The task asked whether the situation was better, worse or unchanged now that P2 is enforced.
// The answer was: **the confidentiality half is closed, the availability half is WORSE than the
// ADR admits, and ADR 002 §2.3's stated remedy is provably ineffective.**
//
// ── AMENDED 2026-08-28. (b) AND (c) ARE CLOSED; (a) AND (d) STILL STAND, VERBATIM. ────────────
//
// The rows below are INVERTED, not deleted: each still runs the identical attack and now asserts
// that it fails. What closed (b) and (c) is one line in `src/js/core/authz.js` stage 0a —
// FINDINGS §4.5 option (a), first-claim binding on the pair `(sigPubRaw, deviceShort)`, made
// unraceable by requiring the claim to be PROVED:
//
//     a `dev.<S>` register is a credential only if the op that WROTE it was stamped by the
//     device it attests — `devOf(cell.stamp) === att.deviceShort`.
//
//  (a) CLOSED, AND UNTOUCHED. A squatter can never be handed `openOp`'s verification key for a
//      short she does not own, and can never make an op read as authored by her victim. §2.3
//      condition (3) forces `att.memberId` to be the HOUSING member, so check 5 refuses. M-I4.
//      The fix below must not, and does not, lean on this: it takes the credential away one
//      barrier earlier, so both barriers are still independently sufficient.
//
//  (b) CLOSED. The squat no longer parks anything at all. Her claim is admitted (refusing it
//      would let anyone un-attest a peer by naming their short), reported on the new
//      `AuthzResult.unprovenShorts`, and never resolved. Papa's own register — filed by Papa's
//      own Mac — resolves as it always did and his envelopes OPEN. M-I3b.
//
//  (c) CLOSED, AND BY THE SAME LINE, WHICH IS THE HALF THAT PROVES THE SEAM IS RIGHT. In the
//      pre-collision window there is no contest to detect — her blob is the only claim there is —
//      so no ordering rule could ever have helped. It is refused for being unproven, `openOp`
//      parks at P1, and check 5 never runs. `envelope.js` was NOT touched: check 5 is still a
//      throw, and should be, because it is a genuine protocol violation once the attestation is
//      a credential. What was wrong was admitting a blob nobody could back AS one. M-I3c.
//
//  (d) THE STATED REMEDY STILL DOES NOT WORK, AND THIS ROW MUST NOT BE RETIRED. ADR 002 §2.3
//      "Two shorts, no winner" said: "`attestOpen` (WP-6) MUST enforce P2, which closes this at
//      the root and removes the stall." It does not. The built `attestOpen`
//      (`verifyAttestation`) enforces P2 today and the squat still mints, still verifies, still
//      passes all four §2.3 conditions and still folds — M-I3a asserts exactly that, unchanged.
//      P2 binds a short to a key, and the squat tells the truth about that binding: it copies
//      both. What she cannot copy is a SIGNATURE, and the stamp is where the signature shows
//      through into the plaintext the fold sees. M-I3e proves she cannot forge the stamp either.
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

  test('M-I3b INVERTED — the same op no longer parks anything: the short still resolves to Papa and his envelope OPENS', async () => {
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
    // Both are STILL ADMITTED, and that has not changed and must not: they are well-formed writes
    // to two different records, write-once is per-register, and refusing hers would hand any
    // member a way to un-attest an honest peer by naming their short — the same worse trade
    // `authz.js` already refuses for the LABEL (R4-13a).
    assert.deepEqual(r.rejected, []);

    // What changed: her claim is UNPROVEN. Her `member.set` was authored by HER Mac, so its stamp
    // ends in HER short, not his — and she cannot author one that ends in his (M-I3e). So the
    // short is not contested, it is DECIDED.
    assert.deepEqual(r.shortCollisions, [], 'nothing is contested — one of the two claims is not a claim');
    assert.deepEqual(r.unprovenShorts, [P.deviceShort], 'and the attempt is still visible');
    const resolved = r.attestationOf(P.deviceShort);
    assert.notEqual(resolved, null, 'if this is null, I-3 is BACK');
    assert.equal(resolved.memberId, papa.memberId);
    assert.equal(resolved.deviceId, P.deviceId);

    // So every envelope Papa's Mac seals still OPENS.
    const PSP = mkSpaceId('personal');
    const key = await sk.createSpaceKey();
    const op = makeOp(P, PSP);
    const env = await sealOp(op, ring([[PSP, 1, key]]), P.devSig.privateKey, hdrFor(op, P, 1));
    const opened = await openOp(env, ring([[PSP, 1, key]]), (dv) => r.attestationOf(dv));
    assert.equal(opened.status, 'opened');
    assert.equal(opened.op.id, op.id);
    assert.equal(opened.op.act, papa.memberId);

    // The three facts that USED to make this permanent are all still true — and none of them
    // matters any more, which is the point of listing them here rather than deleting them.
    // `dev.*` is still write-once, there is still no revocation (§8.2a, R4-16a), and Papa still
    // cannot re-key around it because his short is the last 16 characters of every stamp he has
    // ever written. He does not need to: nothing was ever taken away.
    const replacement = attOp(papa.memberId, P, P.attestation, P.deviceShort, FSP, 1787837000000);
    const r2 = foldAuthorized([honest, squat, replacement], { me: papa.memberId, attestOpen });
    assert.equal(r2.rejectionOf(replacement.id).reason, 'writeOnce');
    assert.equal(r2.attestationOf(P.deviceShort).memberId, papa.memberId);
    assert.equal(op.ts.endsWith(P.deviceShort), true, 'the short is the last 16 chars of every stamp');
  });

  test('M-I3e — SHE CANNOT FORGE THE ONE FIELD THE FIX READS: an op stamped with his short never survives openOp', async () => {
    // The possession proof is `devOf(cell.stamp) === att.deviceShort`, and `cell.stamp` is the
    // writing op's `ts`. So the whole fix rests on one claim: Mama cannot author an op whose
    // stamp ends in Papa's short. This row is that claim, end to end, in the real engine — not
    // an assertion about the fold, which sees plaintext, but about the seam plaintext comes
    // through.
    const papa = await makeMember();
    const mama = await makeMember();
    const P = papa.devices[0];
    const M = mama.devices[0];
    const { blob } = await squatOn(P, mama);

    // She writes the squat register HERSELF, stamped with HIS short, which is exactly the op the
    // fold would accept as proof. `sealOp` refuses to build it: the header `dv` must agree with
    // the stamp (check 4, mirrored), and her own attestation says her short.
    const forged = attOp(mama.memberId, M, blob, P.deviceShort, FSP, 1787836900000);
    forged.ts = fmt(1787836900000, 1, P.deviceShort);
    assert.equal(forged.ts.endsWith(P.deviceShort), true);

    const key = await sk.createSpaceKey();
    // Sealing it under a header that names HIS short and signing with HER device key: the only
    // combination that could produce the bytes she needs.
    const env = await sealOp(forged, ring([[FSP, 1, key]]), M.devSig.privateKey,
      { v: 1, sp: FSP, ep: 1, dv: P.deviceShort, oid: forged.id, wit: '' });
    // On every peer it dies at P3, BEFORE the decrypt: the signature must verify under
    // `att.sigPubRaw`, which is Papa's public point, and only Papa's private half signs for it.
    const attestOpen = await attestOpenOver([[papa.memberId, P.attestation, papa.rec.recSig.publicKey]]);
    const table = foldAuthorized(
      [attOp(papa.memberId, P, P.attestation, P.deviceShort, FSP, 1787836800000)],
      { me: papa.memberId, attestOpen });
    assert.equal(
      await outcomeOf(() => openOp(env, ring([[FSP, 1, key]]), (dv) => table.attestationOf(dv))),
      'P3');
    // …and if she does not name his short in the header, `sealOp` refuses on this side instead,
    // so the forged stamp never leaves her Mac at all.
    assert.equal(
      await outcomeOf(() => sealOp(forged, ring([[FSP, 1, key]]), M.devSig.privateKey,
        { v: 1, sp: FSP, ep: 1, dv: M.deviceShort, oid: forged.id, wit: '' })),
      'C4');
  });

  test('M-I3c INVERTED — the pre-collision window is a PARK, not a drop: her blob is refused for being unproven, and check 5 never runs', async () => {
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

    // THERE IS STILL NOTHING TO CONTEST — and that is why this window, not the contested one,
    // is the cell that pinned down what the fix had to be. No ordering rule, no "earlier wins",
    // no collision report could ever have helped here: her blob is the only claim in the log.
    assert.deepEqual(squatOnly.shortCollisions, [], 'nothing is contested, then or now');
    // It is refused because it is UNPROVEN: she filed his register from her own Mac.
    assert.equal(squatOnly.attestationOf(P.deviceShort), null, 'she is never handed his short');
    assert.deepEqual(squatOnly.unprovenShorts, [P.deviceShort]);

    const PSP = mkSpaceId('personal');
    const key = await sk.createSpaceKey();
    const op = makeOp(P, PSP, { f: { date: '2026-09-10', text: 'Zahnarzt' } });
    const env = await sealOp(op, ring([[PSP, 1, key]]), P.devSig.privateKey, hdrFor(op, P, 1));

    // So `openOp` stops at P1 and PARKS, unopened. It used to pass P2 (his key, his short), pass
    // P3 (his signature under his own key, named by her blob), pass P4, DECRYPT, and then throw
    // at check 5 — a rejection, which §5.2.5 makes final and `store.js` drops without appending.
    // `envelope.js` is unchanged: check 5 is still a throw, it simply never runs now.
    assert.equal(
      await outcomeOf(() => openOp(env, ring([[PSP, 1, key]]), (dv) => squatOnly.attestationOf(dv))),
      `park:${ENVELOPE_PARK.ATTESTATION}`);

    // And the park is re-evaluable (§5.2.5): the same envelope opens the moment Papa's own
    // register arrives, which is the whole difference between a park and a drop.
    const withPapa = foldAuthorized(
      [attOp(mama.memberId, M, blob, P.deviceShort, FSP, 1787836900000),
        attOp(papa.memberId, P, P.attestation, P.deviceShort, FSP, 1787836800000)],
      { me: papa.memberId, attestOpen: await attestOpenOver([
        [mama.memberId, blob, mama.rec.recSig.publicKey],
        [papa.memberId, P.attestation, papa.rec.recSig.publicKey],
      ]) });
    const opened = await openOp(env, ring([[PSP, 1, key]]), (dv) => withPapa.attestationOf(dv));
    assert.equal(opened.status, 'opened');
    assert.equal(opened.op.id, op.id);
  });

  test('M-I3d INVERTED — the attempt is still DETECTABLE, and now it is decided as well as visible', async () => {
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
    // It moved report: it is no longer a CONTEST (nothing contests a proven claim), it is an
    // unbacked claim, and it is named.
    assert.deepEqual(r.shortCollisions, []);
    assert.deepEqual(r.unprovenShorts, [P.deviceShort]);
    // §2.3's closing paragraph asks the member panel to render this, and it still should — the
    // difference is that the loser can now see somebody tried, instead of the victim seeing his
    // calendar stop. The panel is WP-9.
    assert.equal(r.attestationOf(P.deviceShort).memberId, papa.memberId);
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

    // TWO BARRIERS, EACH INDEPENDENTLY SUFFICIENT, AND THIS ROW ASSERTS BOTH — because the 2026-
    // 08-28 fix added the outer one and the ADR's confidentiality result must not quietly come to
    // depend on it.
    //
    //   OUTER (new): her claim on his short is unproven, so `attestationOf` hands `openOp`
    //                NOTHING for it.
    //   INNER (§2.3 condition (3), unchanged): even if it did resolve, the only attestation she
    //                can get under his short is one whose `memberId` is HERS — she cannot put his
    //                memberId in there — so check 5 refuses on every envelope she seals.
    const { blob, att } = await squatOn(P, mama, { deviceId: M.deviceId });
    const attestOpen = await attestOpenOver([[mama.memberId, blob, mama.rec.recSig.publicKey]]);
    const r = foldAuthorized([attOp(mama.memberId, M, blob, P.deviceShort, FSP, 1787836900000)],
      { me: mama.memberId, attestOpen });
    assert.equal(r.attestationOf(P.deviceShort), null, 'OUTER: unproven, so not a credential');
    // INNER, measured directly on the register bytes, so it is asserted even though the outer
    // barrier now stops the caller ever reaching it.
    assert.equal(att.memberId, mama.memberId, 'she cannot put HIS memberId in there');
    const table = { ...att };

    // She now seals under HIS short. She has no key for it: P3 is verified against
    // `att.sigPubRaw`, which is Papa's public point, and only Papa's private half signs for it.
    // Asserted against the STRONGEST table available to her — Papa's own honest attestation,
    // resolved — so the refusal is P3's and not a side effect of the outer barrier above.
    const PSP = mkSpaceId('personal');
    const key = await sk.createSpaceKey();
    const honestTable = foldAuthorized(
      [attOp(papa.memberId, P, P.attestation, P.deviceShort, FSP, 1787836800000)],
      { me: papa.memberId,
        attestOpen: await attestOpenOver([[papa.memberId, P.attestation, papa.rec.recSig.publicKey]]) });
    const op = makeOp(M, PSP, { ts: fmt(1787836800123, 3, P.deviceShort), dev: M.deviceId });
    const env = await sealOp(op, ring([[PSP, 1, key]]),
      M.devSig.privateKey, { v: 1, sp: PSP, ep: 1, dv: P.deviceShort, oid: op.id, wit: '' });
    assert.equal(
      await outcomeOf(() => openOp(env, ring([[PSP, 1, key]]), (dv) => honestTable.attestationOf(dv))),
      'P3');
    void r;

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

  test('M-I5b — THE PRICE OF THE I-3 FIX, STATED: `openOp` is now the sole enforcer of a CREDENTIAL, not just of an order', async () => {
    // M-I5 above was filed as "check 4 is enforced at exactly one seam", and its cost was a
    // premise about `≺`. Since 2026-08-28 the same one seam also carries the possession proof
    // that closes I-3: `authz.js` reads `devOf(cell.stamp)` and trusts it because `openOp`'s P2,
    // P3 and check 4 together mean an op stamped with S was signed by the holder of S's key.
    //
    // So the scope of M-I5 is now larger and this row says so out loud rather than leaving it to
    // be rediscovered: an op that reaches the log by ANY OTHER DOOR — a v1 migration, an import,
    // a local author, a future replay path — carries whatever stamp its author chose, and if it
    // is a `dev.*` register it will be believed. `foldAuthorized` cannot check this; it is pure
    // and synchronous and the check is a signature verification.
    //
    // THE OBLIGATION THIS CREATES, on WP-8 and on anything that appends: no op may enter the log
    // without having passed `openOp`, or the door must refuse `member.set{dev.*}` outright.
    const papa = await makeMember();
    const mama = await makeMember();
    const P = papa.devices[0];
    const M = mama.devices[0];
    const { blob } = await squatOn(P, mama);
    const attestOpen = await attestOpenOver([
      [papa.memberId, P.attestation, papa.rec.recSig.publicKey],
      [mama.memberId, blob, mama.rec.recSig.publicKey],
    ]);

    // The squat, filed by Mama, with a stamp she could never have sealed (M-I3e proves that).
    const smuggled = attOp(mama.memberId, M, blob, P.deviceShort, FSP, 1787836900000);
    smuggled.ts = fmt(1787836900000, 1, P.deviceShort);
    const r = foldAuthorized([smuggled], { me: papa.memberId, attestOpen });
    // The fold believes the stamp, because the fold's whole justification for believing it is a
    // check it does not run. This is CHARACTERIZATION, not a defect in this file: the bytes
    // cannot exist unless something appended an op that never went through `openOp`.
    assert.equal(r.attestationOf(P.deviceShort)?.memberId, mama.memberId,
      'if this becomes null, a second enforcer of check 4 was added and M-I5 can be retired');
    assert.deepEqual(r.unprovenShorts, []);
  });
});
