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
//   M-R6  KEY INJECTION through `admitWraps`                             **SUCCEEDED**
//
// M-R6 is a live break of 20.5 and 21.2 and it is not any of the four barriers' fault: the four
// barriers are about which key opens which envelope, and M-R6 changes WHICH KEY THE VICTIM USES.
// See its own block for the sequence.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as sk from '../../src/js/crypto/spacekeys.js';
import { sealOp, openOp, brandFamilyPatch, ENVELOPE_PARK } from '../../src/js/crypto/envelope.js';
import {
  S, DAY, makeMember, memberRecord, ring, tableOf, makeOp, hdrFor, fnoteKey,
  outcomeOf, rawKey, b64u, mkSpaceId, mkOpId,
} from './_member-kit.js';

const CRYPTO_DIR = fileURLToPath(new URL('../../src/js/crypto/', import.meta.url));

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
    const rotator = await makeMember();
    const peer = await makeMember();
    const FSP = mkSpaceId('family');
    const PSP = mkSpaceId('personal');
    const key3 = await sk.createSpaceKey();

    const [w] = await sk.wrapToRecipients(
      key3, rotator.devices[0].devKex.privateKey,
      sk.familyRecipients([memberRecord(peer)]), { spaceId: FSP, epoch: 3 }
    );

    // The salt AND the AAD both bind `[label, WRAP_V, SUITE_ID, kind, spaceId, epoch]`, so a row
    // the relay (or a member with push access) refiles is simply a blob that does not open.
    const asEpoch9 = await sk.admitWraps(sk.createKeyRing(),
      [{ epoch: 9, wrapped: w.wrapped, senderKexPubRaw: rotator.devices[0].kexPubRaw }],
      { spaceId: FSP, myKexPriv: peer.devices[0].devKex.privateKey });
    assert.deepEqual(asEpoch9, { admitted: [], refused: 1, duplicates: 0 });

    const asPersonal = await sk.admitWraps(sk.createKeyRing(),
      [{ epoch: 3, wrapped: w.wrapped, senderKexPubRaw: rotator.devices[0].kexPubRaw }],
      { spaceId: PSP, myKexPriv: peer.devices[0].devKex.privateKey });
    assert.deepEqual(asPersonal, { admitted: [], refused: 1, duplicates: 0 });
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
      { spaceId: FSP, myKexPriv: phantom.devices[0].devKex.privateKey });
    assert.deepEqual(admitted.admitted, [3]);
    assert.equal(await rawKey(kr.get(FSP, 3)), await rawKey(fsk), 'the phantom holds FSK_3');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M-R6 — **SUCCEEDED.** Key injection through `admitWraps`.
// ═════════════════════════════════════════════════════════════════════════════

describe('T5 injects a key instead of stealing one', () => {
  test('M-R6 SUCCEEDED — an UNATTESTED sender puts a key of its own choosing into a victim\'s PERSONAL ring, and then reads what the victim seals with it', async () => {
    // THE SEQUENCE.
    //  1. `unwrapSpaceKey`'s own contract says `theirKexPub` is "the sender's ECDH public key,
    //     FROM THEIR VERIFIED ATTESTATION". Its only caller, `admitWraps`, takes it off
    //     `row.senderKexPubRaw` — a field of the untrusted row — and verifies nothing.
    //  2. So the attacker generates a throwaway ECDH pair, wraps a key SHE chose to the victim's
    //     `IK_kex` (a public key, published in the victim's own attestation), and posts the row.
    //  3. `admitWraps` admits it for any epoch the victim's ring does not already hold.
    //  4. The victim now SEALS under the attacker's key. Everything that device writes in that
    //     epoch — including its Privat entries, which live in the personal space — is readable by
    //     the attacker and by nobody else.
    //
    // ADR 002 §4.2 step 2 puts the attestation check on the WRAPPING side ("verify the device
    // attestation of every current member device, THEN wrap"). There is no equivalent on the
    // RECEIVING side, and the receiving side is the one that decides which key it will use.
    const victim = await makeMember();
    const V = victim.devices[0];
    const PSP = mkSpaceId('personal');

    const attackerKex = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
    const attackerKey = await sk.createSpaceKey();
    const victimKexPub = await S.importKey('raw', V.kexPubRaw, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    const injected = await sk.wrapSpaceKey(attackerKey, attackerKex.privateKey, victimKexPub,
      { spaceId: PSP, epoch: 2 });

    const kr = sk.createKeyRing();
    const report = await sk.admitWraps(kr, [{
      epoch: 2,
      wrapped: injected,
      senderKexPubRaw: b64u(new Uint8Array(await S.exportKey('raw', attackerKex.publicKey))),
    }], { spaceId: PSP, myKexPriv: V.devKex.privateKey });

    assert.deepEqual(report, { admitted: [2], refused: 0, duplicates: 0 },
      'admitWraps refused an unattested sender — if this line ever fails, M-R6 is FIXED');
    assert.equal(await rawKey(kr.get(PSP, 2)), await rawKey(attackerKey));

    // Step 4 — the victim's own Privat entry, sealed under the injected key and read by the
    // attacker. Nothing in `sealOp` can notice: a `KeyRing` entry is a `CryptoKey`, and a
    // `CryptoKey` carries no provenance.
    const privat = makeOp(V, PSP, { f: { date: '2026-09-10', text: 'Therapietermin' } });
    const env = await sealOp(privat, kr, V.devSig.privateKey, hdrFor(privat, V, 2));
    const stolen = await openOp(env, ring([[PSP, 2, attackerKey]]), tableOf(V));
    assert.equal(stolen.status, 'opened');
    assert.equal(stolen.op.f.text, 'Therapietermin', '21.2 / 20.5 are broken along this route');
  });

  test('M-R6b SUCCEEDED — the relay chooses the ROW ORDER, so the injected key beats the honest one and the honest wrap is counted as a duplicate', async () => {
    // The same hole, in the shape it takes when an honest wrap also exists. `admitWraps` is
    // first-row-wins (`ring.has` short-circuits), and the row order is the relay's to choose.
    const victim = await makeMember();
    const honest = await makeMember();
    const V = victim.devices[0];
    const FSP = mkSpaceId('family');
    const honestKey = await sk.createSpaceKey();
    const attackerKey = await sk.createSpaceKey();

    const victimKexPub = await S.importKey('raw', V.kexPubRaw, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    const attackerKex = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
    const honestWrap = await sk.wrapSpaceKey(honestKey, honest.devices[0].devKex.privateKey, victimKexPub, { spaceId: FSP, epoch: 4 });
    const forged = await sk.wrapSpaceKey(attackerKey, attackerKex.privateKey, victimKexPub, { spaceId: FSP, epoch: 4 });

    const kr = sk.createKeyRing();
    const report = await sk.admitWraps(kr, [
      { epoch: 4, wrapped: forged, senderKexPubRaw: b64u(new Uint8Array(await S.exportKey('raw', attackerKex.publicKey))) },
      { epoch: 4, wrapped: honestWrap, senderKexPubRaw: honest.devices[0].kexPubRaw },
    ], { spaceId: FSP, myKexPriv: V.devKex.privateKey });

    assert.deepEqual(report, { admitted: [4], refused: 0, duplicates: 1 });
    assert.equal(await rawKey(kr.get(FSP, 4)), await rawKey(attackerKey));

    // And the second-order damage: every GENUINE epoch-4 envelope now fails the tag, and an
    // AEAD failure in `openOp` is a THROW, not a park — so those ops are dropped, not retried.
    const author = honest.devices[0];
    const op = makeOp(author, FSP, { k: 'note.set', space: mkSpaceId('personal') });
    const genuine = await sealOp(op, ring([[op.space, 4, honestKey]]), author.devSig.privateKey, hdrFor(op, author, 4));
    assert.equal(await outcomeOf(() => openOp(genuine, ring([[op.space, 4, attackerKey]]), tableOf(author))), 'aead');
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

  test('M-R7c **SUCCEEDED against barrier 4** — the "authenticated" level is only consulted when the PATCH is silent', async () => {
    // ADR 004 §2.2 barrier 4, and `envelope.js`'s own comment on the line: "re-derive the level
    // from the AUTHENTICATED register map, NEVER from the caller."
    //
    // What the code does:
    //     const declared = op.f['pub.level'] ?? undefined;
    //     const folded   = ctx.levelOf(op.e);
    //     const level    = declared === undefined || declared === null ? folded : declared;
    //
    // The caller's value WINS whenever the caller supplies one — and a projection must supply one
    // on every legitimate transition, so it supplies one nearly always. `brand.level === level` is
    // then satisfied by the same caller having lied twice, and the backstop is handed the lie as
    // its level. The authenticated register map is consulted only for a patch that omits
    // `pub.level` entirely.
    //
    // This does not let a member read a PEER's Belegt entry — barrier 4 guards the author's own
    // outbound path, so the leak is self-inflicted. It does mean barrier 4 provides no defence
    // against the bug it exists to catch (a projection that publishes text for a Belegt entry),
    // which is what WP-10 will be building on top of.
    const me = await makeMember();
    const dev = me.devices[0];
    const FSP = mkSpaceId('family');
    const kr = ring([[FSP, 1, await sk.createSpaceKey()]]);
    const e = fnoteKey(me.memberId);

    // The register map — the authenticated one — says this entry is BELEGT.
    const ctx = { levelOf: () => 'belegt', assertFamilyPatch: () => {} };
    const op = makeOp(dev, FSP, {
      k: 'pub.set', e,
      f: brandFamilyPatch(
        { 'pub.level': 'geteilt', 'pub.date': '2026-09-10', 'pub.text': 'Scheidungsanwalt 14:30' },
        { kind: 'fnote', level: 'geteilt' }),
    });
    const env = await sealOp(op, kr, dev.devSig.privateKey, hdrFor(op, dev, 1), ctx);
    assert.equal(typeof env.ct, 'string', 'barrier 4 refused — if this fails, M-R7c is FIXED');

    // …and no reader refuses it either: `geteiltOnly` is enforced at SEAL time only. Grep-level
    // assertion, because the fold is another workflow's file and this is a report, not a fix.
    const ops = readFileSync(fileURLToPath(new URL('../../src/js/core/ops.js', import.meta.url)), 'utf8');
    assert.ok(/geteiltOnly: true/.test(ops), 'the mark exists in FIELDS');
    const authz = readFileSync(fileURLToPath(new URL('../../src/js/core/authz.js', import.meta.url)), 'utf8');
    assert.equal(/geteiltOnly/.test(authz), false, 'nothing in the authorization fold reads it');
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
