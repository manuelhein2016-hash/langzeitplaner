// ATTACK · T2 — the removed family member. ADR 002 §0: "the ex-partner is the honest case."
//
// She holds all ciphertext she pulled and ALL epoch keys she held. She must not be able to
// decrypt a FUTURE family op, and must not be able to push or pull. §4 (epoch rotation) and
// ADR 003 §2 (device revocation + signature auth) are what is supposed to stop her.
//
// The file is written in the order the removal actually happens: rotate → she is cut off → and
// then the four things rotation does NOT buy, each of which is a sentence that must survive into
// the German removal copy (story 20.2, deliverable 22) or the copy is false.

import test from 'node:test';
import assert from 'node:assert/strict';

import { b64u } from '../../src/js/core/b64.js';
import { fmt } from '../../src/js/core/stamp.js';
import {
  createKeyRing, createSpaceKey, buildRotation, familyRecipients, familyRecipientsReport,
  admitWraps, assertRecipients, recipientProblem, rotatesOn, ROTATION_TRIGGERS,
} from '../../src/js/crypto/spacekeys.js';
import { sealOp, openOp } from '../../src/js/crypto/envelope.js';
import {
  makeDevice, memberRecord, tableOf, makeOp, hdrFor, outcome, familySpace, rawAesOf, forge, resign,
} from './_crypto-relay-kit.js';

/** A three-member circle, epochs 1..3, everyone holding everything. */
async function circle() {
  const admin = await makeDevice();
  const papa = await makeDevice();
  const ex = await makeDevice();               // T2
  const fsp = familySpace();
  const keys = new Map();
  for (let e = 1; e <= 3; e++) keys.set(e, await createSpaceKey());
  const ringOf = (upTo) => {
    const r = createKeyRing();
    for (let e = 1; e <= upTo; e++) r.put(fsp, e, keys.get(e));
    return r;
  };
  return { admin, papa, ex, fsp, keys, ringOf, table: tableOf(admin, papa, ex) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. What rotation DOES buy
// ─────────────────────────────────────────────────────────────────────────────

test('FAILED — a future op is unreadable: rotation to epoch 4 cuts her off (story 20.2)', async () => {
  const c = await circle();
  const recipients = familyRecipients([memberRecord(c.admin), memberRecord(c.papa),
    memberRecord(c.ex, { removedAt: '2026-08-27' })]);

  // Removal rotates (§4.1). The rotator is the admin, whose action caused it.
  assert.deepEqual(rotatesOn('member.remove'), ROTATION_TRIGGERS['member.remove']);
  assert.equal(rotatesOn('member.remove').rotate, true);

  const e4 = await createSpaceKey();
  const keys = new Map(c.keys);
  keys.set(4, e4);
  const rotation = await buildRotation(c.fsp, 4, keys, c.admin.kexPriv, recipients, []);

  // Not one wrap is addressed to her device, at ANY epoch — not just at 4.
  assert.equal(rotation.coveredDevices.includes(c.ex.deviceId), false);
  assert.deepEqual(rotation.coveredDevices.sort(), [c.admin.deviceId, c.papa.deviceId].sort());
  assert.equal(rotation.wraps.length, 8); // 2 devices × 4 epochs, ALL of them (§4.3, A4)
  assert.equal(rotation.wraps.filter((w) => w.deviceId === c.ex.deviceId).length, 0);

  // Papa authors into epoch 4. Her ring stops at 3.
  const op = makeOp(c.papa, c.fsp, { k: 'space.set', e: `space:${c.fsp}`, f: { name: 'Familie' } });
  const env = await sealOp(op, createKeyRing([[c.fsp, 4, e4]]), c.papa.sigPriv, hdrFor(op, c.papa.dv, 4, ''));

  // A PARK, not a rejection — §4.4's shape. Honest for a member who is merely behind; for her it
  // is a park that will never resolve, and her client will keep asking for the key for ever.
  assert.equal(await outcome(() => openOp(env, c.ringOf(3), c.table)), 'park:epoch');
});

test('FAILED — a retained epoch key is worthless against a new epoch: no derivation path exists', async () => {
  const c = await circle();
  const e4 = await createSpaceKey();
  const op = makeOp(c.papa, c.fsp, { k: 'space.set', e: `space:${c.fsp}`, f: { name: 'Familie' } });
  const env = await sealOp(op, createKeyRing([[c.fsp, 4, e4]]), c.papa.sigPriv, hdrFor(op, c.papa.dv, 4, ''));

  // She relabels the envelope to an epoch she holds. The AAD binds `ep`, so P3 refuses first…
  const herRing = c.ringOf(3);
  assert.equal(await outcome(() => openOp({ ...env, ep: 3 }, herRing, c.table)), 'P3');

  // …re-signing it under HER key does not help, because the attestation P3 resolves is Papa's:
  const resigned = await resign({ ...env, ep: 3 }, c.ex.sigPriv);
  assert.equal(await outcome(() => openOp(resigned, herRing, c.table)), 'P3');

  // …and the fully self-consistent version — her `dv`, her signature, her epoch — reaches the AEAD
  // and dies there, which is barrier 1: the keys are DRAWN, not derived. FSK_4 has no relationship
  // to FSK_1..3, so holding all three tells her nothing about the fourth.
  const hers = { ...env, dv: c.ex.dv, ep: 3 };
  assert.equal(await outcome(async () => openOp(await resign(hers, c.ex.sigPriv), herRing, c.table)), 'aead');

  // Every epoch key is independently random — assert it, so a future "optimisation" that derived
  // epoch n+1 from epoch n turns this red instead of turning T2 into a non-adversary.
  const raws = new Set();
  for (const k of c.keys.values()) raws.add(await rawAesOf(k));
  raws.add(await rawAesOf(e4));
  assert.equal(raws.size, 4);
});

test('FAILED — she cannot re-admit herself: an old wrap cannot be promoted to a new epoch', async () => {
  const c = await circle();
  const e4 = await createSpaceKey();

  // The only wraps she holds are her own epoch-1..3 rows. She replays one, relabelled as epoch 4.
  const her = familyRecipients([memberRecord(c.ex)]);
  const { wraps } = await buildRotation(c.fsp, 3, c.keys, c.admin.kexPriv, her, []);
  const epoch3Row = wraps.find((w) => w.epoch === 3);

  const ring = createKeyRing();
  const report = await admitWraps(ring, [
    { epoch: 4, wrapped: epoch3Row.wrapped, senderKexPubRaw: c.admin.att.kexPubRaw },
  ], { spaceId: c.fsp, myKexPriv: c.ex.kexPriv });

  // Refused: the wrap's AAD and its HKDF salt both bind the epoch, so the KEK does not even match.
  assert.deepEqual(report.admitted, []);
  assert.equal(report.refused, 1);
  assert.equal(ring.get(c.fsp, 4), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. What rotation does NOT buy — §8.1, §8.2a, §8.9, and one that is in neither
// ─────────────────────────────────────────────────────────────────────────────

test('SUCCEEDED (by design, §8.1) — she keeps EVERYTHING she already held, for ever', async () => {
  const c = await circle();
  const herRing = c.ringOf(3);

  // Every op from every epoch she was in still opens on her machine, after removal, after
  // rotation, after the relay deletes her wrap rows. She has the keys on disk.
  for (let e = 1; e <= 3; e++) {
    const op = makeOp(c.papa, c.fsp, {
      k: 'member.set', e: `member:${c.papa.memberId}`, f: { displayName: `Papa${e}` },
    });
    const env = await sealOp(op, createKeyRing([[c.fsp, e, c.keys.get(e)]]),
      c.papa.sigPriv, hdrFor(op, c.papa.dv, e, ''));
    const opened = await openOp(env, herRing, c.table);
    assert.equal(opened.status, 'opened');
    assert.equal(opened.op.f.displayName, `Papa${e}`);
  }

  // 20.2's copy therefore cannot say „sieht deine Einträge nicht mehr" without „ab jetzt".
  // Addendum §6: unsharing is not unremembering.
});

test('SUCCEEDED (§8.9) — the window between her removal and the rotation landing is fully readable', async () => {
  const c = await circle();
  const herRing = c.ringOf(3);

  // The admin clicks "remove" and the rotation POST is in flight. Papa's Mac has not yet seen
  // `space.set{epoch: 4}` and is still authoring into epoch 3 — the key she holds.
  const op = makeOp(c.papa, c.fsp, {
    k: 'member.set', e: `member:${c.papa.memberId}`, f: { displayName: 'Papa (neuer Kontakt)' },
  });
  const env = await sealOp(op, createKeyRing([[c.fsp, 3, c.keys.get(3)]]),
    c.papa.sigPriv, hdrFor(op, c.papa.dv, 3, ''));

  const opened = await openOp(env, herRing, c.table);
  assert.equal(opened.status, 'opened');
  assert.equal(opened.op.f.displayName, 'Papa (neuer Kontakt)');

  // There is no forward secrecy WITHIN an epoch (§8.9) and no causal barrier at the removal
  // instant: the cut-off is not "the moment she was removed", it is "the moment every authoring
  // device has folded the new epoch". The gap is a network round trip plus a sleeping laptop.
});

test('SUCCEEDED (§8.2a) — she can still AUTHOR an op that every honest client opens and attributes to her', async () => {
  const c = await circle();
  const peerRing = c.ringOf(3);

  // Her attestation is a write-once `dev.*` register. It cannot be amended, cannot be withdrawn,
  // and there is no revocation input anywhere in the fold or in `openOp`. So P1 resolves her, P2
  // and P3 pass, and checks 1–5 pass, because every one of them is TRUE: it really is her device.
  const op = makeOp(c.ex, c.fsp, {
    k: 'member.set', e: `member:${c.ex.memberId}`, f: { displayName: 'Ich bin noch da' },
  });
  const env = await sealOp(op, createKeyRing([[c.fsp, 3, c.keys.get(3)]]),
    c.ex.sigPriv, hdrFor(op, c.ex.dv, 3, ''));

  const opened = await openOp(env, peerRing, c.table);
  assert.equal(opened.status, 'opened');
  assert.equal(opened.attestation.memberId, c.ex.memberId);
  assert.equal(opened.op.act, c.ex.memberId, 'story 17.6 renders this as „von <ihr>"');

  // The ONLY thing standing between this and a family board is ADR 003 §2's request auth at the
  // relay — a coordination check, not a cryptographic one. A peer that receives these bytes any
  // other way (a restored backup, a LAN sync, a compromised or coerced relay, a re-imported
  // `snapshots.json`) admits them with full attribution. `openOp` has no `revokedAt` to compare
  // against and §2.3 says inventing one is not this seam's job. WP-9 owns it.
  assert.equal(openOp.length, 3, 'there is no fourth parameter through which revocation could arrive');
});

test('SUCCEEDED — a stale member list re-admits her to EVERY epoch, including the new one', async () => {
  const c = await circle();

  // `familyRecipients` reads `removedAt` off caller-supplied records. Nothing signs that field,
  // nothing binds it to the log, and the attestation check that DOES run passes — because §8.2a
  // means her attestation is still perfectly valid. So membership is a boolean in the rotator's
  // local fold, and one stale or replayed member list is a complete rollback of the removal.
  const stale = [memberRecord(c.admin), memberRecord(c.papa), memberRecord(c.ex)]; // no removedAt
  const recipients = familyRecipients(stale);
  await assertRecipients(recipients, 'family'); // every attestation verifies. Including hers.
  assert.equal(await recipientProblem(recipients.find((r) => r.deviceId === c.ex.deviceId)), null);

  const e4 = await createSpaceKey();
  const keys = new Map(c.keys);
  keys.set(4, e4);
  const rotation = await buildRotation(c.fsp, 4, keys, c.admin.kexPriv, recipients, []);
  assert.equal(rotation.coveredDevices.includes(c.ex.deviceId), true);

  // She admits the epoch-4 wrap and reads the future.
  const herRing = c.ringOf(3);
  const mine = rotation.wraps
    .filter((w) => w.deviceId === c.ex.deviceId)
    .map((w) => ({ epoch: w.epoch, wrapped: w.wrapped, senderKexPubRaw: c.admin.att.kexPubRaw }));
  const report = await admitWraps(herRing, mine, { spaceId: c.fsp, myKexPriv: c.ex.kexPriv });
  assert.deepEqual(report.admitted, [4]);
  assert.equal(await rawAesOf(herRing.get(c.fsp, 4)), await rawAesOf(e4));

  const op = makeOp(c.papa, c.fsp, { k: 'space.set', e: `space:${c.fsp}`, f: { name: 'Ohne sie' } });
  const env = await sealOp(op, createKeyRing([[c.fsp, 4, e4]]), c.papa.sigPriv, hdrFor(op, c.papa.dv, 4, ''));
  assert.equal((await openOp(env, herRing, c.table)).status, 'opened');

  // The reporting surface exists — but a caller has to look at it, and it says nothing about who
  // is MISSING from the list, only about who was skipped as removed.
  const report2 = familyRecipientsReport(stale);
  assert.deepEqual(report2.removed, [], 'a stale list reports nothing removed — there is no baseline to compare to');
  assert.equal(report2.recipients.length, 3);

  // Note what is NOT protecting here: the relay's own §4.2 coverage check REQUIRES the bump to
  // cover "every current, non-revoked device of every non-removed member", so the relay would
  // reject a rotation that OMITTED her — but it has no reason to reject one that INCLUDES her. The
  // coverage check is a liveness guard pointing in exactly the opposite direction from this attack.
});

test('the honest boundary of `familyRecipients`: it authenticates DEVICES, never MEMBERSHIP', async () => {
  const c = await circle();

  // Removed member → skipped, and reported. This is the check working.
  const proper = familyRecipientsReport([memberRecord(c.admin), memberRecord(c.papa),
    memberRecord(c.ex, { removedAt: '2026-08-27' })]);
  assert.deepEqual(proper.removed, [c.ex.memberId]);
  assert.equal(proper.recipients.some((r) => r.memberId === c.ex.memberId), false);

  // But a member record is not signed by anybody. Anyone who can shape the array that reaches this
  // function decides the roster — and §8.5 already concedes that a malicious relay can "fabricate a
  // whole member row". What §8.5 does NOT say is that the fabricated member then receives EVERY
  // epoch, 1..e+1, because `wrapRingToRecipients` refuses to build a partial ring (§4.3 / A4).
  // So the fabricated member does not get the future; they get the entire history as well.
  const stranger = await makeDevice();
  const withStranger = familyRecipients([memberRecord(c.admin), memberRecord(stranger)]);
  const rot = await buildRotation(c.fsp, 3, c.keys, c.admin.kexPriv, withStranger, []);
  assert.equal(rot.wraps.filter((w) => w.deviceId === stranger.deviceId).length, 3,
    'a phantom member is handed epochs 1, 2 AND 3 — the whole board, retroactively');

  // The one visible artefact for a curious member is the per-member device count in the member
  // list (§2.3, §8.5) — a UI surface, in deliverable 22, that does not exist yet.
});
