// ─────────────────────────────────────────────────────────────────────────────
// T5 — THE FAMILY MEMBER, THE ADMIN INCLUDED, TRYING TO READ (ADR 002 §0)
//
// This is the adversary the product's central promise is about:
//
//   20.5  "no role, including admin, grants insight into anyone else's private entries"
//   21.1  "the server never holds readable content"
//   21.2  enforced by ENCRYPTION, not by policy
//
// Every attacker below is a real, attested member of the same Kreis. She holds `FSK_e` for every
// epoch that exists, the whole family log, and — where it matters — the admin role. The question
// is not "are the keys different" (they are, trivially) but "is there a sequence of moves that
// gets a key she holds to open a document she does not own".
//
// Six routes are tried, and the sixth is the one that works:
//
//   M-R1  the family key against a personal envelope                     FAILED (aead)
//   M-R2  a forged space tag — relabel the envelope into the family space FAILED (P3, then aead)
//   M-R3  a confused epoch — relabel, refile a wrap, downgrade the ring   FAILED (P3 / refused)
//   M-R4  a personal envelope replayed into the family stream            FAILED (P3)
//   M-R5  an "admin endpoint" — any capability in crypto/ that reads     FAILED (there is none)
//   M-R6  KEY INJECTION through `admitWraps`                             SUCCEEDED → **CLOSED**
//
// M-R6 was a live break of 20.5 and 21.2 and it was not any of the four barriers' fault: the four
// barriers are about which key opens which envelope, and M-R6 changed WHICH KEY THE VICTIM USES.
//
// ⚠ INVERTED 2026-08-28 — finding S1. `admitWraps` now REQUIRES `ctx.senders`: the admissible
// sender set for a space, built by the SAME two constructors that build the recipient set
// (`personalRecipients` / `familyRecipients`) and verified by the same `recipientProblem`. A wrap
// row's `senderKexPubRaw` selects a sender out of that set; it can no longer supply one. See
// `spacekeys.js` §6b, and `tests/attack/crypto-relay-keyinjection.test.js` for the T1 half.
//
// The rows below are the attack unchanged, with the assertions inverted — M-R6 is the PERSONAL
// instance (story 20.5, the sharpest one) and M-R6b the ordering instance.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as sk from '../../src/js/crypto/spacekeys.js';
import { sealOp, openOp, brandFamilyPatch, ENVELOPE_PARK } from '../../src/js/crypto/envelope.js';
import { foldAuthorized, registerValue } from '../../src/js/core/authz.js';
import {
  S, DAY, makeMember, memberRecord, ring, tableOf, makeOp, hdrFor, fnoteKey,
  outcomeOf, rawKey, b64u, mkSpaceId, mkOpId, attOp, attestOpenOver, fmt,
} from './_member-kit.js';

const CRYPTO_DIR = fileURLToPath(new URL('../../src/js/crypto/', import.meta.url));

/**
 * THE PATCHED BUILD, as a fixture. Everything about this attacker is real — a real member, real
 * keys, a real attested device, real authority over her own entity — and the ONE thing she does
 * that the shipped client cannot is skip `sealOp`. That is not cheating: `sealOp` runs on HER
 * Mac, so every barrier inside it is hers to delete, and the question this helper asks is the
 * only one left afterwards — what does the PEER do with the op when it arrives?
 *
 * Returns the peer's folded view of the entity: the two content registers, and what the fold
 * says it withheld.
 *
 * @param {'privat'|'belegt'|'geteilt'} level the level the entity really stands at
 */
async function foldLeak(level) {
  const her = await makeMember();
  const dev = her.devices[0];
  const FSP = mkSpaceId('family');
  const E = fnoteKey(her.memberId);
  const at = (n) => fmt(1787836800000 + n * 1000, 0, dev.deviceShort);
  const op = (f, n) => ({ ...makeOp(dev, FSP, { k: 'pub.set', e: E, f }), ts: at(n) });

  const ops = [
    attOp(her.memberId, dev, dev.attestation, dev.deviceShort, FSP, 1787836700000),
    { ...makeOp(dev, FSP, { k: 'member.set', e: `member:${her.memberId}`,
      f: { displayName: 'Mama', _alive: true } }), ts: at(1) },
    { ...makeOp(dev, FSP, { k: 'space.set', e: `space:${FSP}`,
      f: { admin: her.memberId, adminPrev: null, name: 'Familie' } }), ts: at(2) },
    op({ 'pub.level': level, 'pub.alive': true }, 3),
    // The attack: the geteiltOnly field, carrying a value, for an entry at `level`.
    op({ 'pub.date': '2026-10-01', 'pub.text': 'Scheidungsanwalt 14:30' }, 4),
  ];
  const attacker = ops[ops.length - 1];

  const attestOpen = await attestOpenOver([[her.memberId, dev.attestation, her.rec.recSig.publicKey]]);
  const r = foldAuthorized(ops, { me: her.memberId, attestOpen });
  return {
    text: registerValue(r.regs, E, 'pub.text'),
    date: registerValue(r.regs, E, 'pub.date'),
    reported: r.contentAboveLevel.filter((x) => x.opId === attacker.id).map((x) => x.field),
    rejected: r.rejectionOf(attacker.id),
  };
}

/**
 * MY OWN devices, in the shape `personalRecipients` reads — barrier 2's personal half, which is
 * also the personal space's admissible SENDER set since finding S1. `personalRecipients` REFUSES
 * any device whose `memberId` is not mine, so this list cannot be widened by a caller mistake.
 */
const ownRecord = (m) => ({
  memberId: m.memberId,
  recoverySigPubRaw: m.recoveryPubSig,
  devices: m.devices.map((d) => ({
    deviceId: d.deviceId, memberId: m.memberId, kexPubRaw: d.kexPubRaw, attestation: d.attestation,
  })),
});

/** The report shape `admitWraps` returns when NOTHING was admitted and nothing was unauthorized. */
const REFUSED_ONE = { admitted: [], refused: 1, duplicates: 0, unauthorized: 0, unauthorizedEpochs: [] };

// ═════════════════════════════════════════════════════════════════════════════
// M-R1 · M-R2 · M-R4 — the family key, the forged tag, the cross-space replay
// ═════════════════════════════════════════════════════════════════════════════

describe('T5 reads a Privat entry', () => {
  test('M-R1/R2/R4 FAILED — the admin holds every family key and none of them opens a personal op', async () => {
    const victim = await makeMember();
    const admin = await makeMember();
    const V = victim.devices[0];

    const PSP = mkSpaceId('personal');
    const FSP = mkSpaceId('family');
    const psk = await sk.createSpaceKey();
    // The admin's whole key ring: FIVE family epochs, every one of them hers by right.
    const fsks = [];
    for (let e = 1; e <= 5; e++) fsks.push(await sk.createSpaceKey());

    const op = makeOp(V, PSP, { f: { date: '2026-09-10', text: 'Therapietermin' } });
    const env = await sealOp(op, ring([[PSP, 1, psk]]), V.devSig.privateKey, hdrFor(op, V, 1));

    // The honest open, first — three refusals prove nothing if the happy path is broken.
    const mine = await openOp(env, ring([[PSP, 1, psk]]), tableOf(V));
    assert.equal(mine.status, 'opened');
    assert.equal(mine.op.f.text, 'Therapietermin');

    // M-R1. Every family epoch key, substituted for the personal one. AES-GCM has no
    // "wrong key, partial plaintext" path: the tag fails and there is nothing to salvage.
    for (let e = 0; e < fsks.length; e++) {
      assert.equal(
        await outcomeOf(() => openOp(env, ring([[PSP, 1, fsks[e]]]), tableOf(V))), 'aead',
        `family epoch ${e + 1} opened a personal envelope`
      );
    }

    // M-R2. The forged space tag — the move a member or a relay actually has, since `sp` is
    // plaintext on the wire. It never reaches the cipher: `sp` is in the AAD and the AAD is what
    // was SIGNED, so a relabel breaks P3, verify-before-decrypt.
    for (let e = 0; e < fsks.length; e++) {
      assert.equal(
        await outcomeOf(() => openOp({ ...env, sp: FSP }, ring([[FSP, 1, fsks[e]]]), tableOf(V))), 'P3'
      );
    }

    // M-R4. The same envelope pushed into the family stream unchanged — the relay's replay. The
    // attacker's ring is keyed by (space, epoch) and holds nothing under a PERSONAL space id, so
    // this does not even reach a key: it PARKS, which is the correct shape (a missing key is
    // never a rejection, §4.4) and is also a dead end for her.
    assert.equal(await outcomeOf(() => openOp(env, ring([[FSP, 1, fsks[0]]]), tableOf(V))),
      `park:${ENVELOPE_PARK.EPOCH}`);
    // So she files her family key into the personal slot instead — the only way to make the ring
    // hand `openOp` a key at all. Now it reaches AES-GCM, and stops there.
    assert.equal(await outcomeOf(() => openOp(env, ring([[PSP, 1, fsks[0]]]), tableOf(V))), 'aead');

    // And nothing about the admin's ROLE changes any of it. There is no admin-shaped argument to
    // pass: `openOp(env, keyring, attestationOf, ports?)` — three required parameters, and the
    // fourth is a defaulted ports bag, so `Function.length` is 3.
    assert.equal(openOp.length, 3);
    assert.match(openOp.toString().slice(0, 120), /^async function openOp\(env, keyring, attestationOf, ports = \{\}\)/);
  });

  test('M-R2b FAILED — even a member who can produce a VALID signature over the relabelled header still fails the tag', async () => {
    // The barriers must be independent, or the whole thing rests on one. A modified client of my
    // own — the one adversary who can re-sign — gets past P3 and lands on the GCM tag instead.
    const me = await makeMember();
    const dev = me.devices[0];
    const PSP = mkSpaceId('personal');
    const FSP = mkSpaceId('family');
    const psk = await sk.createSpaceKey();
    const fsk = await sk.createSpaceKey();

    const op = makeOp(dev, PSP, { f: { date: '2026-09-10', text: 'Therapietermin' } });
    const env = await sealOp(op, ring([[PSP, 1, psk]]), dev.devSig.privateKey, hdrFor(op, dev, 1));

    const { aadOf } = await import('../../src/js/crypto/envelope.js');
    const { ub64 } = await import('../../src/js/core/b64.js');
    const relabelled = { ...env, sp: FSP };
    const parts = [aadOf(relabelled), ub64(relabelled.iv), ub64(relabelled.ct)];
    let n = 0;
    for (const p of parts) n += p.length;
    const signed = new Uint8Array(n);
    let at = 0;
    for (const p of parts) { signed.set(p, at); at += p.length; }
    const resigned = {
      ...relabelled,
      sig: b64u(new Uint8Array(await S.sign({ name: 'ECDSA', hash: 'SHA-256' }, dev.devSig.privateKey, signed))),
    };
    assert.equal(await outcomeOf(() => openOp(resigned, ring([[FSP, 1, fsk]]), tableOf(dev))), 'aead');
    assert.equal(await outcomeOf(() => openOp(resigned, ring([[FSP, 1, psk]]), tableOf(dev))), 'aead');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M-R3 — the confused epoch, at both seams
// ═════════════════════════════════════════════════════════════════════════════

describe('T5 confuses an epoch', () => {
  test('M-R3a FAILED — an envelope relabelled into an epoch the attacker holds is refused before the cipher', async () => {
    const me = await makeMember();
    const dev = me.devices[0];
    const FSP = mkSpaceId('family');
    const compromised = await sk.createSpaceKey();   // epoch 1 — the ex-partner still has it
    const current = await sk.createSpaceKey();       // epoch 6 — after the rotation

    const op = makeOp(dev, mkSpaceId('personal'), {});
    const sp = op.space;
    const env = await sealOp(op, ring([[sp, 6, current]]), dev.devSig.privateKey, hdrFor(op, dev, 6));

    // Pin the client back to the compromised epoch — §5.1's stated purpose for `ep` in the AAD.
    assert.equal(await outcomeOf(() => openOp({ ...env, ep: 1 }, ring([[sp, 1, compromised]]), tableOf(dev))), 'P3');
    // …and relabelling the space at the same time changes nothing.
    assert.equal(
      await outcomeOf(() => openOp({ ...env, ep: 1, sp: FSP }, ring([[FSP, 1, compromised]]), tableOf(dev))), 'P3'
    );
  });

  test('M-R3b FAILED — a wrap refiled under a different epoch or space is refused by admitWraps', async () => {
    // THE SENDER IS DELIBERATELY AUTHORIZED IN BOTH CALLS. Since S1 an unknown sender is refused
    // before the AEAD ever runs, so a rotator who is a stranger would make this row pass for the
    // wrong reason and stop measuring barrier 3 at all. `peer` has two Macs: the second is a
    // legitimate member of the family sender set AND of `peer`'s own personal sender set, so the
    // only thing left to refuse the refiled row is the salt/AAD binding — which is the point.
    const peer = await makeMember(2);
    const rotatorPriv = peer.devices[1].devKex.privateKey;
    const rotatorPub = peer.devices[1].kexPubRaw;
    const FSP = mkSpaceId('family');
    const PSP = mkSpaceId('personal');
    const key3 = await sk.createSpaceKey();

    const wraps = await sk.wrapToRecipients(
      key3, rotatorPriv, sk.familyRecipients([memberRecord(peer)]), { spaceId: FSP, epoch: 3 }
    );
    const w = wraps.find((x) => x.deviceId === peer.devices[0].deviceId);

    // The salt AND the AAD both bind `[label, WRAP_V, SUITE_ID, kind, spaceId, epoch]`, so a row
    // the relay (or a member with push access) refiles is simply a blob that does not open.
    const asEpoch9 = await sk.admitWraps(sk.createKeyRing(),
      [{ epoch: 9, wrapped: w.wrapped, senderKexPubRaw: rotatorPub }],
      { spaceId: FSP, myKexPriv: peer.devices[0].devKex.privateKey,
        senders: sk.familyRecipients([memberRecord(peer)]) });
    assert.deepEqual(asEpoch9, REFUSED_ONE, 'refused by the AEAD, with the sender authorized');

    const asPersonal = await sk.admitWraps(sk.createKeyRing(),
      [{ epoch: 3, wrapped: w.wrapped, senderKexPubRaw: rotatorPub }],
      { spaceId: PSP, myKexPriv: peer.devices[0].devKex.privateKey,
        senders: sk.personalRecipients(ownRecord(peer)) });
    assert.deepEqual(asPersonal, REFUSED_ONE, 'refused by the AEAD, with the sender authorized');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M-R5 — the admin endpoint that does not exist (20.5)
// ═════════════════════════════════════════════════════════════════════════════

describe('T5 is the admin', () => {
  test('M-R5 FAILED — nothing under src/js/crypto/ takes a role, and the two recipient scopes cannot be crossed', async () => {
    // (a) STRUCTURAL. `wrapRingTo`'s header says "there is no role parameter and there will not
    //     be one". Assert it of the code rather than of the comment: no executable line in the
    //     crypto layer reads an admin flag, a role gate or a permission.
    const forbidden = /\b(isAdmin|isOwner|canRead|privileged|hasPermission|grantRead|asAdmin)\b/;
    for (const f of readdirSync(CRYPTO_DIR).filter((n) => n.endsWith('.js'))) {
      const code = readFileSync(CRYPTO_DIR + f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')          // block comments
        .replace(/^\s*\/\/.*$/gm, '')              // line comments
        .replace(/^\s*\*.*$/gm, '');               // stray jsdoc continuation
      assert.equal(forbidden.test(code), false, `${f} contains a role gate`);
    }

    // (b) BEHAVIOURAL, which is the half that matters. The admin's move is to feed the family
    //     member list to the PERSONAL wrapping path. `personalRecipients` does not "should not"
    //     take it — the first foreign device throws, by memberId, before any key is touched.
    const me = await makeMember(2);
    const mama = await makeMember();
    assert.throws(
      () => sk.personalRecipients({
        memberId: me.memberId,
        recoverySigPubRaw: me.recoveryPubSig,
        devices: [
          ...me.devices.map((d) => ({ deviceId: d.deviceId, memberId: me.memberId, kexPubRaw: d.kexPubRaw, attestation: d.attestation })),
          { deviceId: mama.devices[0].deviceId, memberId: mama.memberId, kexPubRaw: mama.devices[0].kexPubRaw, attestation: mama.devices[0].attestation },
        ],
      }),
      /REFUSING a device belonging to member/
    );

    // (c) And the brands are checked at the wrap, so a family recipient smuggled into a personal
    //     rotation is refused even if it never went through `personalRecipients`.
    const fam = sk.familyRecipients([memberRecord(mama)]);
    const psk = await sk.createSpaceKey();
    await assert.rejects(
      () => sk.wrapToRecipients(psk, me.devices[0].devKex.privateKey, fam, { spaceId: mkSpaceId('personal'), epoch: 1 }),
      /cannot receive a "personal"-space key/
    );
    // …and a hand-built object literal has no brand at all.
    await assert.rejects(
      () => sk.wrapToRecipients(psk, me.devices[0].devKex.privateKey, [{
        deviceId: mama.devices[0].deviceId, memberId: mama.memberId, role: 'device',
        kexPubRaw: mama.devices[0].kexPubRaw, attestation: mama.devices[0].attestation,
        housingRecoveryPubRaw: mama.recoveryPubSig,
      }], { spaceId: mkSpaceId('personal'), epoch: 1 }),
      /UNBRANDED/
    );
  });

  test('M-R5b — what the admin CAN do is cut a member off, and no client-side check refuses it (§4.2 coverage is server-only)', async () => {
    // 20.5 is about READING and 20.5 holds. This is the honest neighbour of it: `familyRecipients`
    // takes `removedAt` from the CALLER, not from the authenticated fold, so an admin rotating the
    // family key can silently omit an honest member. ADR 002 §4.2's answer is a SERVER-ENFORCED
    // coverage check — and `server/` in this repo contains `vercel.json` and nothing else, so the
    // check exists in the contract and nowhere in any code that runs.
    const admin = await makeMember();
    const mama = await makeMember();
    const oma = await makeMember();
    const all = [memberRecord(admin), memberRecord(mama), memberRecord(oma)];
    const withOmaCut = [memberRecord(admin), memberRecord(mama), memberRecord(oma, { removedAt: '2026-08-27' })];

    const report = sk.familyRecipientsReport(withOmaCut);
    assert.deepEqual(report.removed, [oma.memberId]);
    assert.equal(report.recipients.length, 2, 'the rotation covers two of three members');

    const FSP = mkSpaceId('family');
    const key = await sk.createSpaceKey();
    const rot = await sk.buildRotation(FSP, 2, new Map([[1, await sk.createSpaceKey()], [2, key]]),
      admin.devices[0].devKex.privateKey, report.recipients, [], {});
    assert.equal(rot.coveredDevices.includes(oma.devices[0].deviceId), false);
    // Nothing in the built code compares `coveredDevices` against the real member list. The only
    // artefact that could is `rot.coveredDevices` itself, which is a REPORT for the caller.
    assert.deepEqual(
      sk.familyRecipients(all).map((r) => r.deviceId).sort().filter((d) => !rot.coveredDevices.includes(d)),
      [oma.devices[0].deviceId]
    );
  });

  test('M-R5c — §8.5 holds as written: a phantom member row gets the family key from an HONEST rotator', async () => {
    // Not a new hole — ADR 002 §8.5 says so — but it is worth one runnable row, because the
    // mitigation the ADR names (the member list is a security surface) is a UI obligation and the
    // crypto layer cannot tell a phantom from Oma.
    const honest = await makeMember();
    const phantom = await makeMember();          // the admin's own second identity
    const FSP = mkSpaceId('family');
    const fsk = await sk.createSpaceKey();

    const recipients = sk.familyRecipients([memberRecord(honest), memberRecord(phantom)]);
    const wraps = await sk.wrapToRecipients(fsk, honest.devices[0].devKex.privateKey, recipients,
      { spaceId: FSP, epoch: 3 });
    const row = wraps.find((w) => w.deviceId === phantom.devices[0].deviceId);

    const kr = sk.createKeyRing();
    const admitted = await sk.admitWraps(kr,
      [{ epoch: 3, wrapped: row.wrapped, senderKexPubRaw: honest.devices[0].kexPubRaw }],
      { spaceId: FSP, myKexPriv: phantom.devices[0].devKex.privateKey,
        senders: sk.familyRecipients([memberRecord(honest)]) });
    assert.deepEqual(admitted.admitted, [3]);
    assert.equal(await rawKey(kr.get(FSP, 3)), await rawKey(fsk), 'the phantom holds FSK_3');
    // S1's fix does not touch §8.5 and must not be read as if it did: the rotator here IS honest
    // and IS in the phantom's sender set. What the fix changed is that the ring can now name who
    // delivered the key, which is the difference between an anonymous injection and a member row
    // somebody can look at.
    assert.equal(kr.originOf(FSP, 3).deviceId, honest.devices[0].deviceId);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M-R6 — SUCCEEDED, and **CLOSED 2026-08-28** (finding S1). Key injection through `admitWraps`.
// ═════════════════════════════════════════════════════════════════════════════

describe('T5 injects a key instead of stealing one', () => {
  test('M-R6 CLOSED — an UNATTESTED sender cannot put a key into a victim\'s PERSONAL ring, and neither can an ATTESTED fellow member', async () => {
    // THE SEQUENCE THAT USED TO WORK.
    //  1. `unwrapSpaceKey`'s contract says `theirKexPub` is "the sender's ECDH public key, FROM
    //     THEIR VERIFIED ATTESTATION". Its only caller, `admitWraps`, took it off
    //     `row.senderKexPubRaw` — a field of the untrusted row — and verified nothing.
    //  2. So the attacker generated a throwaway ECDH pair, wrapped a key SHE chose to the victim's
    //     `IK_kex` (a public key, published in the victim's own attestation), and posted the row.
    //  3. `admitWraps` admitted it for any epoch the victim's ring did not already hold.
    //  4. The victim then SEALED under the attacker's key.
    //
    // THE FIX. `ctx.senders` is now required, and for a `psp_` space it can only be the output of
    // `personalRecipients`, which REFUSES a device belonging to any member but me. So the personal
    // space's sender set is my own attested Macs and nothing else — by construction, not by check.
    //
    // BOTH HALVES ARE ASSERTED, because a fix that only knew about strangers would leave 20.5
    // broken by Mama, who is attested, current, and has no business in my Privat ring: row ② is
    // the one that says "attested" was never the question. Attested BY WHOM, INTO WHAT, is.
    const victim = await makeMember(2);          // my Mac, and my own second Mac
    const mama = await makeMember();             // a real, attested, current member of the Kreis
    const V = victim.devices[0];
    const PSP = mkSpaceId('personal');
    const KEX = { name: 'ECDH', namedCurve: 'P-256' };

    const attackerKex = await S.generateKey(KEX, true, ['deriveKey', 'deriveBits']);
    const attackerKey = await sk.createSpaceKey();
    const victimKexPub = await S.importKey('raw', V.kexPubRaw, KEX, true, []);
    const ctx = {
      spaceId: PSP,
      myKexPriv: V.devKex.privateKey,
      senders: sk.personalRecipients(ownRecord(victim)),
    };

    const kr = sk.createKeyRing();
    const report = await sk.admitWraps(kr, [
      // ① the throwaway keypair — S1 in its purest form
      {
        epoch: 2,
        wrapped: await sk.wrapSpaceKey(attackerKey, attackerKex.privateKey, victimKexPub, { spaceId: PSP, epoch: 2 }),
        senderKexPubRaw: b64u(new Uint8Array(await S.exportKey('raw', attackerKex.publicKey))),
      },
      // ② Mama — attested, real, current, and not one of MY devices
      {
        epoch: 3,
        wrapped: await sk.wrapSpaceKey(attackerKey, mama.devices[0].devKex.privateKey, victimKexPub, { spaceId: PSP, epoch: 3 }),
        senderKexPubRaw: mama.devices[0].kexPubRaw,
      },
    ], ctx);

    assert.deepEqual(report, {
      admitted: [], refused: 2, duplicates: 0, unauthorized: 2, unauthorizedEpochs: [2, 3],
    }, 'if this line ever fails, M-R6 is OPEN again');
    assert.equal(kr.size(), 0, 'nothing this device did not authenticate is in the personal ring');

    // Step 4, the other way round: the Privat entry is sealed under a key that came from MY OWN
    // second Mac, and the attacker's key opens nothing.
    const psk2 = await sk.createSpaceKey();
    const mine = await sk.admitWraps(kr, [{
      epoch: 2,
      wrapped: await sk.wrapSpaceKey(psk2, victim.devices[1].devKex.privateKey, victimKexPub, { spaceId: PSP, epoch: 2 }),
      senderKexPubRaw: victim.devices[1].kexPubRaw,
    }], ctx);
    assert.deepEqual(mine.admitted, [2], 'my own second Mac is still admitted — the fix is not "refuse everything"');
    assert.deepEqual(kr.originOf(PSP, 2),
      { how: 'admitted', deviceId: victim.devices[1].deviceId, memberId: victim.memberId });

    const privat = makeOp(V, PSP, { f: { date: '2026-09-10', text: 'Therapietermin' } });
    const env = await sealOp(privat, kr, V.devSig.privateKey, hdrFor(privat, V, 2));
    assert.equal(await outcomeOf(() => openOp(env, ring([[PSP, 2, attackerKey]]), tableOf(V))), 'aead',
      '21.2 / 20.5 hold along this route again');
    assert.equal((await openOp(env, kr, tableOf(V))).op.f.text, 'Therapietermin');
  });

  test('M-R6b CLOSED — the relay still chooses the ROW ORDER, and the order no longer decides', async () => {
    // The same hole, in the shape it took when an honest wrap also existed. `admitWraps` is still
    // first-row-wins (`ring.has` short-circuits, and it must: two member devices both wrapping the
    // ring to a joiner is D9's ordinary case, §7.1 step 4). What changed is that a row from a
    // sender this device cannot name never reaches `put`, so winning the race buys nothing.
    const victim = await makeMember();
    const honest = await makeMember();
    const V = victim.devices[0];
    const FSP = mkSpaceId('family');
    const honestKey = await sk.createSpaceKey();
    const attackerKey = await sk.createSpaceKey();

    const KEX = { name: 'ECDH', namedCurve: 'P-256' };
    const victimKexPub = await S.importKey('raw', V.kexPubRaw, KEX, true, []);
    const attackerKex = await S.generateKey(KEX, true, ['deriveKey', 'deriveBits']);
    const honestWrap = await sk.wrapSpaceKey(honestKey, honest.devices[0].devKex.privateKey, victimKexPub, { spaceId: FSP, epoch: 4 });
    const forged = await sk.wrapSpaceKey(attackerKey, attackerKex.privateKey, victimKexPub, { spaceId: FSP, epoch: 4 });

    const kr = sk.createKeyRing();
    const report = await sk.admitWraps(kr, [
      { epoch: 4, wrapped: forged, senderKexPubRaw: b64u(new Uint8Array(await S.exportKey('raw', attackerKex.publicKey))) },
      { epoch: 4, wrapped: honestWrap, senderKexPubRaw: honest.devices[0].kexPubRaw },
    ], {
      spaceId: FSP,
      myKexPriv: V.devKex.privateKey,
      senders: sk.familyRecipients([memberRecord(honest), memberRecord(victim)]),
    });

    assert.deepEqual(report, {
      admitted: [4], refused: 1, duplicates: 0, unauthorized: 1, unauthorizedEpochs: [4],
    });
    assert.equal(await rawKey(kr.get(FSP, 4)), await rawKey(honestKey));
    // The injected row is no longer INDISTINGUISHABLE from the benign duplicate: `duplicates` is
    // 0 and `unauthorized` is 1, so a caller finally has an anomaly it can surface.
    assert.equal(report.duplicates, 0);

    // And the second-order damage goes with it: the genuine epoch-4 envelope opens.
    const author = honest.devices[0];
    const op = makeOp(author, FSP, { k: 'note.set', space: mkSpaceId('personal') });
    const genuine = await sealOp(op, ring([[op.space, 4, honestKey]]), author.devSig.privateKey, hdrFor(op, author, 4));
    assert.equal((await openOp(genuine, ring([[op.space, 4, honestKey]]), tableOf(author))).status, 'opened');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M-R7 — the Belegt content, and the level the caller gets to declare
// ═════════════════════════════════════════════════════════════════════════════

describe('T5 reads the content of a Belegt entry', () => {
  test('M-R7 FAILED — the family write path is CLOSED today: no family pub.set can be sealed at all (WP-10)', async () => {
    const me = await makeMember();
    const dev = me.devices[0];
    const FSP = mkSpaceId('family');
    const kr = ring([[FSP, 1, await sk.createSpaceKey()]]);
    const e = fnoteKey(me.memberId);
    const op = makeOp(dev, FSP, {
      k: 'pub.set', e,
      f: brandFamilyPatch({ 'pub.level': 'belegt', 'pub.date': '2026-09-10' }, { kind: 'fnote', level: 'belegt' }),
    });
    // `ctx.assertFamilyPatch` is barrier 2 and it is REQUIRED, so until `core/project.js` lands
    // there is nothing to attack end to end. Recorded so a later reader does not mistake a green
    // suite here for a proven family read path.
    assert.equal(await outcomeOf(() => sealOp(op, kr, dev.devSig.privateKey, hdrFor(op, dev, 1), {})), 'barrier4');
    assert.equal(
      await outcomeOf(() => sealOp(op, kr, dev.devSig.privateKey, hdrFor(op, dev, 1), { levelOf: () => 'belegt' })),
      'barrier2'
    );
  });

  test('M-R7b FAILED — with a stub projection injected, the BACKSTOP still refuses pub.text at belegt', async () => {
    const me = await makeMember();
    const dev = me.devices[0];
    const FSP = mkSpaceId('family');
    const kr = ring([[FSP, 1, await sk.createSpaceKey()]]);
    const e = fnoteKey(me.memberId);
    const ctx = { levelOf: () => 'belegt', assertFamilyPatch: () => {} };
    const op = makeOp(dev, FSP, {
      k: 'pub.set', e,
      f: brandFamilyPatch(
        { 'pub.level': 'belegt', 'pub.date': '2026-09-10', 'pub.text': 'Scheidungsanwalt' },
        { kind: 'fnote', level: 'belegt' }),
    });
    assert.equal(await outcomeOf(() => sealOp(op, kr, dev.devSig.privateKey, hdrFor(op, dev, 1), ctx)), 'backstop');
  });

  test('M-R7c CLOSED (S5) — the declared level is a CLAIM CHECKED against the map, and the lie is refused', async () => {
    // ─────────────────────────────────────────────────────────────────────────────────────────
    // THIS ROW SUCCEEDED. IT IS INVERTED, NOT DELETED. What it used to prove:
    //
    //     const declared = op.f['pub.level'] ?? undefined;
    //     const folded   = ctx.levelOf(op.e);
    //     const level    = declared === undefined || declared === null ? folded : declared;
    //
    // The caller's value won whenever the caller supplied one — and a projection supplies one on
    // every legitimate transition, so nearly always. `brand.level === level` was then satisfied by
    // the same caller having lied twice, and the backstop was handed the lie as its level. The
    // authenticated register map was consulted only for a patch that omitted `pub.level` entirely,
    // so barrier 4 — the barrier that exists to stop a future caller who never read ADR 004 —
    // stopped nothing. Finding **S5**; domain C4 priced it at 35 of 324 cells.
    //
    // What the code does now (`src/js/crypto/envelope.js`, "BARRIER 4 — THE LEVEL IS THE
    // AUTHENTICATED ONE"): `level = folded`, full stop, with `declared` appearing in no expression
    // that produces it; a `declared` that is present, non-null and different from the map is a
    // barrier-4 refusal; `absent` and `null` are silence. The legitimate transition still seals,
    // because `ctx.levelOf` reads the entity's authenticated `visibility` TRUTH register — which
    // already carries the NEW level when the publish microtask runs — and not the last-published
    // `pub.level`, which is the level the transition is moving away FROM.
    // ─────────────────────────────────────────────────────────────────────────────────────────
    const me = await makeMember();
    const dev = me.devices[0];
    const FSP = mkSpaceId('family');
    const kr = ring([[FSP, 1, await sk.createSpaceKey()]]);
    const e = fnoteKey(me.memberId);

    // The register map — the authenticated one — says this entry is BELEGT.
    const ctx = { levelOf: () => 'belegt', assertFamilyPatch: () => {} };
    const attack = brandFamilyPatch(
      { 'pub.level': 'geteilt', 'pub.date': '2026-09-10', 'pub.text': 'Scheidungsanwalt 14:30' },
      { kind: 'fnote', level: 'geteilt' });
    const op = makeOp(dev, FSP, { k: 'pub.set', e, f: attack });
    assert.equal(
      await outcomeOf(() => sealOp(op, kr, dev.devSig.privateKey, hdrFor(op, dev, 1), ctx)),
      'barrier4', 'the lie in pub.level is refused where it is told — if this fails, S5 is back');

    // The honest publication of the SAME entry still seals, so the fix is not "refuse everything".
    const honest = brandFamilyPatch(
      { 'pub.level': 'belegt', 'pub.date': '2026-09-10' }, { kind: 'fnote', level: 'belegt' });
    const hOp = makeOp(dev, FSP, { k: 'pub.set', e, f: honest });
    assert.equal(typeof (await sealOp(hOp, kr, dev.devSig.privateKey, hdrFor(hOp, dev, 1), ctx)).ct, 'string');

    // ── THE RECEIVER SIDE — ALSO CLOSED, AND THIS HALF IS INVERTED TOO ──────────────────────
    //
    // What stood here until 2026-08-28 was a GREP: `assert.equal(/geteiltOnly/.test(authz),
    // false, 'REPORTED, OPEN: nothing in the authorization fold reads geteiltOnly')`. It was a
    // report rather than a proof because `core/authz.js` was another agent's file at the time.
    //
    // The finding it reported was real and it was the COMPOUNDING half of this row: barriers 3
    // and 4 and the backstop all live in `sealOp`, so a member running a patched build has no
    // seal path to defeat — they hand the relay an envelope whose plaintext already carries the
    // text, and until stage 3c existed every honest peer decrypted it, folded it and rendered it.
    // `geteiltOnly` was a mark only the writer consulted, which is a house style, not an
    // invariant.
    //
    // Proven behaviourally now, not by grep — the attacker skips `sealOp` entirely, which is
    // exactly the capability the patched build has and the honest one does not.
    const belegt = await foldLeak('belegt');
    assert.equal(belegt.text, undefined,
      'THE POINT: the peer refuses to fold a geteiltOnly value for a Belegt entry. If this reads '
      + 'the string, the receiver-side half of M-R7c is back and every barrier above it is '
      + 'author-side, i.e. defeated by the build that mounted this attack.');
    assert.equal(belegt.date, '2026-10-01',
      'and the Belegt payload SURVIVES — the field is dropped, the op is not thrown away');
    assert.deepEqual(belegt.reported, ['pub.text'], 'and the peer can say what it withheld');

    // Not vacuous: the same op, the same attacker, an entity that really is Geteilt — it lands.
    const geteilt = await foldLeak('geteilt');
    assert.equal(geteilt.text, 'Scheidungsanwalt 14:30',
      'control: at Geteilt the identical write is applied, so the refusal above is the LEVEL');
  });

  test('M-R7d FAILED — 16.7 holds: Belegt and Geteilt are the same length on the wire', async () => {
    const me = await makeMember();
    const dev = me.devices[0];
    const FSP = mkSpaceId('family');
    const kr = ring([[FSP, 1, await sk.createSpaceKey()]]);
    const e = fnoteKey(me.memberId);
    const seal = async (patch, level) => {
      const op = makeOp(dev, FSP, { k: 'pub.set', e, f: brandFamilyPatch(patch, { kind: 'fnote', level }) });
      return sealOp(op, kr, dev.devSig.privateKey, hdrFor(op, dev, 1),
        { levelOf: () => level, assertFamilyPatch: () => {} });
    };
    const belegt = await seal({ 'pub.level': 'belegt', 'pub.date': '2026-09-10', 'pub.alive': true }, 'belegt');
    const geteilt = await seal(
      { 'pub.level': 'geteilt', 'pub.date': '2026-09-10', 'pub.alive': true, 'pub.text': 'Zahnarzt um 14:30' },
      'geteilt');
    assert.equal(belegt.ct.length, geteilt.ct.length);
  });
});
