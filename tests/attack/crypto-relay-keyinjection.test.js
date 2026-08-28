// ATTACK · T1 — the relay stops trying to READ the ciphertext and instead CHOOSES THE KEY.
//
// ADR 002 §4.2 step 2 and §2.3 make the OUTBOUND direction rigorous: before a space key is wrapped
// to anybody, `assertRecipients` → `recipientProblem` verifies the recipient's attestation under
// the housing member's recovery key AND binds `att.kexPubRaw` to the exact key the wrap is
// addressed to — "an attestation that verifies but names a different agreement key would let a
// member (or a relay that reordered a member list) redirect the space key to a key of their
// choosing while every signature still checked out. That is a key-injection channel."
//
// This file asked the mirror question, which ADR 002 never asked: **who verifies the SENDER, on
// the way IN?**  `unwrapSpaceKey`'s own JSDoc answered it — "theirKexPub: the sender's ECDH public
// key, from their VERIFIED attestation" — and `admitWraps`, the one function that actually feeds
// `GET /api/v1/spaces/:id/keys` into the ring, took that key straight off the relay's row.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// INVERTED 2026-08-28 — finding S1 is CLOSED, and these rows are now the regression that holds it
// closed. Every attack below is byte-for-byte the one that succeeded; only the assertions moved.
//
// THE FIX (`spacekeys.js` §6b): `admitWraps(ring, rows, ctx)` REQUIRES `ctx.senders`, the same
// `Recipient[]` the wrapping side uses. `admissibleSenders()` puts every one of them through
// `recipientProblem` — brand, attestation, and the `att.kexPubRaw` binding — and indexes the keys
// it imported itself. `row.senderKexPubRaw` became an INDEX into that set: it selects a sender, it
// cannot supply one, and relay bytes never reach `deriveBits` again.
//
// WHAT WOULD HAVE MADE A WEAKER FIX LOOK GOOD, and is therefore asserted here too:
//   · the row that was refused by the AEAD all along (a valid point belonging to nobody) is NOT
//     the row that mattered — see "the two refusals are different refusals";
//   · a check that only ran on the family space would leave story 20.5 broken, so the PERSONAL
//     instance is a row of its own;
//   · a check that could be skipped by omitting an argument is not a check — `ctx.senders` has no
//     default and the omission throws.
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// GROUND RULE: T1 holds NO family key and forges NO signature anywhere in this file. Everything
// below is done with a throwaway ECDH keypair the relay generates for itself and two JSON rows.

import test from 'node:test';
import assert from 'node:assert/strict';

import { b64u, ub64 } from '../../src/js/core/b64.js';
import * as identity from '../../src/js/crypto/identity.js';
import { memberId as mkMemberId, deviceId as mkDeviceId } from '../../src/js/core/ids.js';
import {
  createKeyRing, admitWraps, admissibleSenders, isSenderSet, createSpaceKey, wrapSpaceKey,
  unwrapSpaceKey, wrapToRecipients, familyRecipients, personalRecipients, recipientProblem,
  assertRecipients, SpaceKeyError,
} from '../../src/js/crypto/spacekeys.js';
import { sealOp, openOp } from '../../src/js/crypto/envelope.js';
import {
  makeDevice, memberRecord, tableOf, makeOp, hdrFor, outcome, familySpace, personalSpace,
  importKex, rawPubOf, rawAesOf, DAY, S,
} from './_crypto-relay-kit.js';

/** The relay's own throwaway ECDH keypair. No attestation, no member record, no signature. */
const relayKeypair = () => S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);

/**
 * ONE member with TWO attested Macs under ONE recovery identity — the shape `personalRecipients`
 * reads. The kit's `makeDevice` mints a fresh recovery identity per call, and the personal space
 * is precisely the case where two devices must share one, so this is built here.
 */
async function twoMacs() {
  const memberId = mkMemberId();
  const rec = await identity.generateRecoveryKeys();
  const devices = [];
  for (let i = 0; i < 2; i += 1) {
    const { devSig, devKex } = await identity.generateDeviceKeys();
    const deviceId = mkDeviceId();
    const att = await identity.buildDeviceAttestation({ memberId, deviceId, createdAt: DAY }, devSig.publicKey, devKex.publicKey);
    devices.push({
      memberId,
      deviceId,
      att,
      dv: att.deviceShort,
      blob: await identity.attestDevice(att, rec.recSig.privateKey),
      sigPriv: devSig.privateKey,
      kexPriv: devKex.privateKey,
      kexPubRaw: ub64(att.kexPubRaw),
    });
  }
  return {
    memberId,
    devices,
    /** Barrier 2's personal half: MY OWN devices, and nothing else can be put in this list. */
    own: {
      memberId,
      recoverySigPubRaw: await identity.exportRawPublic(rec.recSig.publicKey),
      recoveryKexPubRaw: await identity.exportRawPublic(rec.recKex.publicKey),
      devices: devices.map((d) => ({
        deviceId: d.deviceId, memberId, kexPubRaw: d.kexPubRaw, attestation: d.blob,
      })),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

test('REFUSED — the relay cannot inject a space key of its own choosing through admitWraps', async () => {
  const victim = await makeDevice();
  const honestPeer = await makeDevice();
  const fsp = familySpace();

  const honestKey = await createSpaceKey();
  const relayKey = await createSpaceKey();       // the relay generated this and keeps it
  const relay = await relayKeypair();

  const victimKexPub = await importKex(victim.kexPubRaw);
  const honestWrap = await wrapSpaceKey(honestKey, honestPeer.kexPriv, victimKexPub, { spaceId: fsp, epoch: 4 });
  const forgedWrap = await wrapSpaceKey(relayKey, relay.privateKey, victimKexPub, { spaceId: fsp, epoch: 4 });

  // `GET /api/v1/spaces/:id/keys` is a relay response. The relay writes the array, so the relay
  // writes the ORDER — and `KeyRing.put` is first-write-wins. That is still true; it is simply no
  // longer enough, because the first row never reaches `put`.
  const ring = createKeyRing();
  const report = await admitWraps(ring, [
    { epoch: 4, wrapped: forgedWrap, senderKexPubRaw: b64u(await rawPubOf(relay)) },
    { epoch: 4, wrapped: honestWrap, senderKexPubRaw: honestPeer.att.kexPubRaw },
  ], {
    spaceId: fsp,
    myKexPriv: victim.kexPriv,
    senders: familyRecipients([memberRecord(honestPeer), memberRecord(victim)]),
  });

  // The forged row is UNAUTHORIZED — counted apart from an ordinary AEAD refusal, because "a
  // stranger tried to give me a key" and "a wrap did not open" are different events.
  assert.deepEqual(report.admitted, [4]);
  assert.equal(report.unauthorized, 1);
  assert.deepEqual(report.unauthorizedEpochs, [4]);
  assert.equal(report.refused, 1, 'the unauthorized row is a refusal as well, for a caller that only reads this');
  assert.equal(report.duplicates, 0, 'and it is NOT the benign D9 number any more');

  // The honest key won the slot even though the relay listed its own row first.
  assert.equal(await rawAesOf(ring.get(fsp, 4)), await rawAesOf(honestKey));
  assert.notEqual(await rawAesOf(ring.get(fsp, 4)), await rawAesOf(relayKey));

  // And the slot can say WHO delivered it. A `CryptoKey` carries no provenance; the slot does.
  assert.deepEqual(ring.originOf(fsp, 4),
    { how: 'admitted', deviceId: honestPeer.deviceId, memberId: honestPeer.memberId });
});

test('REFUSED — with nothing but the forged row the ring stays EMPTY, so there is nothing to seal under', async () => {
  const victim = await makeDevice();
  const peer = await makeDevice();
  const fsp = familySpace();
  const relay = await relayKeypair();
  const relayKey = await createSpaceKey();

  const ring = createKeyRing();
  const report = await admitWraps(ring, [{
    epoch: 4,
    wrapped: await wrapSpaceKey(relayKey, relay.privateKey, await importKex(victim.kexPubRaw), { spaceId: fsp, epoch: 4 }),
    senderKexPubRaw: b64u(await rawPubOf(relay)),
  }], {
    spaceId: fsp, myKexPriv: victim.kexPriv, senders: familyRecipients([memberRecord(peer), memberRecord(victim)]),
  });

  assert.deepEqual(report.admitted, []);
  assert.equal(report.unauthorized, 1);

  // `currentEpoch` is the ring's max, so admitting at `e+1` used to BECOME the current epoch and
  // the outbox sealed its next op into it. The ring never took the key, so there is no epoch.
  assert.equal(ring.currentEpoch(fsp), 0);
  assert.equal(ring.get(fsp, 4), null);
  assert.equal(ring.originOf(fsp, 4), null);

  // The op that used to leak. `sealOp` finds no key and says so, loudly, on the device that has
  // the problem — instead of quietly sealing to the relay.
  const op = makeOp(victim, fsp, {
    k: 'member.set', e: `member:${victim.memberId}`, f: { displayName: 'Mama' },
  });
  assert.equal(await outcome(() => sealOp(op, ring, victim.sigPriv, hdrFor(op, victim.dv, 4, ''))), 'shape');

  // …and the relay's key opens nothing, because nothing was ever sealed under it.
  assert.equal(ring.currentEpoch(fsp), 0, 'step 4 of the old sequence has no step 3 to stand on');
});

test('REFUSED — the DENIAL OF SERVICE goes with it: honest epoch-4 ops open normally', async () => {
  const victim = await makeDevice();
  const author = await makeDevice();
  const fsp = familySpace();
  const relay = await relayKeypair();

  const honestKey = await createSpaceKey();
  const relayKey = await createSpaceKey();

  const op = makeOp(author, fsp, { k: 'member.set', e: `member:${author.memberId}`, f: { displayName: 'Papa' } });
  const honestEnv = await sealOp(op, { get: () => honestKey }, author.sigPriv, hdrFor(op, author.dv, 4, ''));

  const ctx = {
    spaceId: fsp,
    myKexPriv: victim.kexPriv,
    senders: familyRecipients([memberRecord(author), memberRecord(victim)]),
  };

  // The relay gets its row in FIRST, alone, before the honest one exists.
  const ring = createKeyRing();
  const first = await admitWraps(ring, [{
    epoch: 4,
    wrapped: await wrapSpaceKey(relayKey, relay.privateKey, await importKex(victim.kexPubRaw), { spaceId: fsp, epoch: 4 }),
    senderKexPubRaw: b64u(await rawPubOf(relay)),
  }], ctx);
  assert.equal(first.unauthorized, 1);

  // The slot was never poisoned, so the genuine wrap still lands — first-write-wins is not a
  // liability once the only rows that can reach `put` are authenticated ones.
  const second = await admitWraps(ring, [{
    epoch: 4,
    wrapped: await wrapSpaceKey(honestKey, author.kexPriv, await importKex(victim.kexPubRaw), { spaceId: fsp, epoch: 4 }),
    senderKexPubRaw: author.att.kexPubRaw,
  }], ctx);
  assert.deepEqual(second.admitted, [4]);
  assert.equal(second.duplicates, 0, 'the genuine key is NOT refused as a permanent duplicate any more');

  // Not an `aead` throw. The board keeps epoch 4.
  const opened = await openOp(honestEnv, ring, tableOf(author));
  assert.equal(opened.status, 'opened');
  assert.equal(opened.op.f.displayName, 'Papa');
  assert.equal(ring.refusedPuts(), 0, 'and no legitimate put was ever refused');
});

test('the asymmetry is gone: INBOUND now verifies exactly what OUTBOUND verifies', async () => {
  const me = await makeDevice();
  const peer = await makeDevice();
  const fsp = familySpace();
  const relay = await relayKeypair();

  // OUTBOUND. Take a genuine family recipient and swap in the relay's agreement key — the exact
  // key-injection `crypto.contract.js` §2 names. It is caught, by the `att.kexPubRaw` binding.
  const [genuine] = familyRecipients([memberRecord(peer)]);
  const injected = Object.freeze({ ...genuine, kexPubRaw: await rawPubOf(relay) });
  const problem = await recipientProblem(injected);
  // The clone lost its non-enumerable brand, so it is refused one step earlier still — which is
  // itself barrier 2 working. Both refusals are real; assert that SOMETHING refuses it.
  assert.notEqual(problem, null);
  assert.match(problem, /unbranded|DIFFERENT agreement key/);

  // And a branded recipient whose attestation names another key is refused on the binding itself.
  const recips = familyRecipients([memberRecord(peer, {
    devices: [{ deviceId: peer.deviceId, kexPubRaw: await rawPubOf(relay), attestation: peer.blob }],
  })]);
  assert.match(await recipientProblem(recips[0]), /DIFFERENT agreement key/);
  await assert.rejects(() => assertRecipients(recips, 'family'), /DIFFERENT agreement key/);

  // INBOUND. The same key, in the same position — the ECDH counterparty the KEK is derived from —
  // arrives on a relay row, and now meets the SAME gate: `admissibleSenders` runs every sender
  // through `recipientProblem` before a single byte is derived.
  const senders = familyRecipients([memberRecord(peer), memberRecord(me)]);
  const ring = createKeyRing();
  const report = await admitWraps(ring, [{
    epoch: 1,
    wrapped: await wrapSpaceKey(await createSpaceKey(), relay.privateKey, await importKex(me.kexPubRaw), { spaceId: fsp, epoch: 1 }),
    senderKexPubRaw: b64u(await rawPubOf(relay)),
  }], { spaceId: fsp, myKexPriv: me.kexPriv, senders });
  assert.deepEqual(report.admitted, []);
  assert.equal(report.unauthorized, 1);

  // The very same list refuses the very same swap on the way in, for the very same reason.
  await assert.rejects(
    () => admissibleSenders([...recips], fsp),
    /DIFFERENT agreement key/,
  );

  // `admitWraps` NOW HAS a parameter through which the verified set arrives, and it has no
  // default: the check that had nowhere to live has somewhere to live.
  assert.equal(admitWraps.length, 3, 'ring, rows, ctx — and ctx is {spaceId, myKexPriv, senders} + ports');

  // THE CALLER WHO FORGETS. E2/E5 is the first caller that will wire this, and the question a
  // future adversary will ask is what happens when it does not. Asserted with the LIVE forged row
  // rather than an empty batch, so a fix that made `ctx.senders` optional-with-a-default would
  // fail here on both counts rather than on a formality.
  const forgetful = createKeyRing();
  const forgedRow = {
    epoch: 1,
    wrapped: await wrapSpaceKey(await createSpaceKey(), relay.privateKey, await importKex(me.kexPubRaw), { spaceId: fsp, epoch: 1 }),
    senderKexPubRaw: b64u(await rawPubOf(relay)),
  };
  await assert.rejects(
    () => admitWraps(forgetful, [forgedRow], { spaceId: fsp, myKexPriv: me.kexPriv }),
    (err) => err instanceof SpaceKeyError && /`ctx.senders` is REQUIRED/.test(err.message),
    'omitting the sender set must throw, not silently admit — a skippable check is not a check',
  );
  assert.equal(forgetful.size(), 0, 'and nothing was admitted on the way to that throw');
});

test('THE PERSONAL INSTANCE — story 20.5: an unattested sender cannot reach my Privat ring either', async () => {
  // The sharpest form of the finding, and the reason the fix is not allowed to be family-only:
  // the attacker needs one throwaway keypair and the victim's `IK_kex`, which is a PUBLIC key
  // published in the victim's own attestation and readable by every member of the Kreis.
  const mine = await twoMacs();
  const [me, myOtherMac] = mine.devices;
  const mama = await makeDevice();               // a real, attested, current member of the Kreis
  const psp = personalSpace();
  const attacker = await relayKeypair();

  const senders = personalRecipients(mine.own);
  const ctx = { spaceId: psp, myKexPriv: me.kexPriv, senders };
  const myKexPub = await importKex(me.kexPubRaw);

  const rows = [
    // ① the throwaway keypair — S1 in its purest form
    {
      epoch: 2,
      wrapped: await wrapSpaceKey(await createSpaceKey(), attacker.privateKey, myKexPub, { spaceId: psp, epoch: 2 }),
      senderKexPubRaw: b64u(await rawPubOf(attacker)),
    },
    // ② Mama — attested, real, current, and with no business at all in my Privat ring. This is
    //    the row that proves "attested" was never the question. Attested BY WHOM, INTO WHAT, is.
    {
      epoch: 3,
      wrapped: await wrapSpaceKey(await createSpaceKey(), mama.kexPriv, myKexPub, { spaceId: psp, epoch: 3 }),
      senderKexPubRaw: mama.att.kexPubRaw,
    },
  ];

  const ring = createKeyRing();
  const report = await admitWraps(ring, rows, ctx);
  assert.deepEqual(report.admitted, []);
  assert.equal(report.unauthorized, 2);
  assert.deepEqual(report.unauthorizedEpochs, [2, 3]);
  assert.equal(ring.size(), 0, 'nothing this device did not authenticate is in the personal ring');

  // My own second Mac, by contrast, is admitted — the personal sender set is not "nobody".
  const psk2 = await createSpaceKey();
  const ok = await admitWraps(ring, [{
    epoch: 2,
    wrapped: await wrapSpaceKey(psk2, myOtherMac.kexPriv, myKexPub, { spaceId: psp, epoch: 2 }),
    senderKexPubRaw: myOtherMac.att.kexPubRaw,
  }], ctx);
  assert.deepEqual(ok.admitted, [2]);
  assert.equal(await rawAesOf(ring.get(psp, 2)), await rawAesOf(psk2));
  assert.equal(ring.originOf(psp, 2).deviceId, myOtherMac.deviceId);

  // And the Privat entry that used to be readable by the attacker is sealed under MY key.
  const privat = makeOp(me, psp, { f: { date: '2026-09-10', text: 'Therapietermin' } });
  const env = await sealOp(privat, ring, me.sigPriv, hdrFor(privat, me.dv, 2, ''));
  assert.equal((await openOp(env, ring, tableOf(me))).op.f.text, 'Therapietermin');
});

test('the sender set is BOUND, and it cannot be hand-rolled or borrowed from the other space', async () => {
  const me = await makeDevice();
  const peer = await makeDevice();
  const fsp = familySpace();
  const other = familySpace();
  const psp = personalSpace();

  const family = familyRecipients([memberRecord(peer), memberRecord(me)]);
  const set = await admissibleSenders(family, fsp);
  assert.equal(isSenderSet(set), true);
  assert.equal(set.size(), 2);

  // A set verified for one space cannot authorize an admission into another.
  await assert.rejects(() => admissibleSenders(set, other), /verified for .* cannot authorize/);
  await assert.rejects(
    () => admitWraps(createKeyRing(), [], { spaceId: other, myKexPriv: me.kexPriv, senders: set }),
    /verified for .* cannot authorize/,
  );

  // A family list cannot authorize a personal admission — barrier 2, on the way in.
  await assert.rejects(() => admissibleSenders(family, psp), /cannot authorize a "personal"-space admission/);

  // A copy of a `SenderSet` is not a `SenderSet`: the brand is non-enumerable and unforgeable.
  assert.equal(isSenderSet({ ...set }), false);
  await assert.rejects(() => admissibleSenders({ ...set }, fsp), /expected the Recipient\[\]/);

  // And a hand-written recipient literal — the shape a caller reaches for when it wants to "just
  // allow this one key" — has no brand at all.
  await assert.rejects(
    () => admissibleSenders([{
      deviceId: peer.deviceId, memberId: peer.memberId, role: 'device',
      kexPubRaw: peer.kexPubRaw, attestation: peer.blob, housingRecoveryPubRaw: peer.recSigPubRaw,
    }], fsp),
    /UNBRANDED recipient cannot authorize/,
  );
});

test('the two refusals are different refusals — the AEAD never was the authentication', async () => {
  // The row that was ALWAYS refused, and the row that was not, differ by one thing: whether the
  // arithmetic was done right. A fix that made the first refusal "stronger" would have fixed
  // nothing, which is why both are here.
  const me = await makeDevice();
  const peer = await makeDevice();
  const fsp = familySpace();
  const stranger = await relayKeypair();
  const nobody = await relayKeypair();
  const myPub = await importKex(me.kexPubRaw);
  const senders = familyRecipients([memberRecord(peer), memberRecord(me)]);
  const ctx = { spaceId: fsp, myKexPriv: me.kexPriv, senders };

  // ① wrapped with `stranger`, DECLARING `nobody`: the KEK derives to the wrong bytes. Refused by
  //    the AEAD before S1 and after it — this row never proved anything.
  const mismatched = {
    epoch: 1,
    wrapped: await wrapSpaceKey(await createSpaceKey(), stranger.privateKey, myPub, { spaceId: fsp, epoch: 1 }),
    senderKexPubRaw: b64u(await rawPubOf(nobody)),
  };
  // ② the same row with the arithmetic done right. Before S1 this one was ADMITTED.
  const consistent = {
    epoch: 2,
    wrapped: await wrapSpaceKey(await createSpaceKey(), stranger.privateKey, myPub, { spaceId: fsp, epoch: 2 }),
    senderKexPubRaw: b64u(await rawPubOf(stranger)),
  };

  const ring = createKeyRing();
  const report = await admitWraps(ring, [mismatched, consistent], ctx);
  assert.deepEqual(report.admitted, []);
  // BOTH are now unauthorized, and neither ever reaches the AEAD: the sender check runs first, so
  // an unknown sender is refused for being unknown rather than for being unlucky.
  assert.equal(report.unauthorized, 2);
  assert.deepEqual(report.unauthorizedEpochs, [1, 2]);

  // Absent and malformed sender fields land in the same bucket, not in a separate one — an index
  // that is not in the set is not in the set, however it fails to be.
  const junk = await admitWraps(createKeyRing(), [
    { epoch: 5, wrapped: consistent.wrapped },
    { epoch: 6, wrapped: consistent.wrapped, senderKexPubRaw: 'nicht-ein-punkt!!' },
    { epoch: 7, wrapped: consistent.wrapped, senderKexPubRaw: new Uint8Array(3) },
  ], ctx);
  assert.equal(junk.unauthorized, 3);
  assert.deepEqual(junk.admitted, []);
});

test('an EMPTY sender set is a park, not a crash — the joiner between §7.1 steps 2 and 6', async () => {
  // The joiner cannot fold the family stream before she holds a key, so her first sync may have
  // nobody it can authenticate. That must refuse every row and stay quiet, not throw: a throw on
  // the ordinary bootstrap path is how a caller learns to pass a list it did not verify.
  const her = await makeDevice();
  const peer = await makeDevice();
  const fsp = familySpace();
  const key = await createSpaceKey();
  const row = {
    epoch: 1,
    wrapped: await wrapSpaceKey(key, peer.kexPriv, await importKex(her.kexPubRaw), { spaceId: fsp, epoch: 1 }),
    senderKexPubRaw: peer.att.kexPubRaw,
  };

  const ring = createKeyRing();
  const parked = await admitWraps(ring, [row], { spaceId: fsp, myKexPriv: her.kexPriv, senders: [] });
  assert.deepEqual(parked.admitted, []);
  assert.equal(parked.unauthorized, 1);
  assert.equal(ring.size(), 0);

  // The same row, once she can name the sender. Re-evaluable, which is what §4.4 requires.
  const admitted = await admitWraps(ring, [row], {
    spaceId: fsp, myKexPriv: her.kexPriv, senders: familyRecipients([memberRecord(peer)]),
  });
  assert.deepEqual(admitted.admitted, [1]);
  assert.equal(await rawAesOf(ring.get(fsp, 1)), await rawAesOf(key));
});

test('OPEN (ADR 002 §8.5) — the bootstrap residual, named: a phantom MEMBER still delivers', async () => {
  // What the fix does NOT buy, stated with a runnable row rather than a caveat.
  //
  // A device's first family sync has no authenticated roster to build `familyRecipients` from, so
  // the roster comes from relay coordination data. The relay can therefore invent a whole member
  // — recovery keypair, device, attestation that verifies under it — and be in the set.
  //
  // The difference S1's fix makes is not zero and is not "closed": the relay can no longer inject
  // with ONE throwaway ECDH key and no identity at all. It has to appear in the member list (15.4)
  // as somebody nobody invited, which is §8.5's already-accepted, UI-surfaceable residual. And a
  // caller that builds its sender set from FOLDED state — every sync after the first — is not
  // exposed to this at all.
  const her = await makeDevice();
  const phantom = await makeDevice();            // the relay's own minted "member"
  const fsp = familySpace();
  const phantomKey = await createSpaceKey();

  const ring = createKeyRing();
  const report = await admitWraps(ring, [{
    epoch: 1,
    wrapped: await wrapSpaceKey(phantomKey, phantom.kexPriv, await importKex(her.kexPubRaw), { spaceId: fsp, epoch: 1 }),
    senderKexPubRaw: phantom.att.kexPubRaw,
  }], {
    spaceId: fsp, myKexPriv: her.kexPriv, senders: familyRecipients([memberRecord(phantom)]),
  });
  assert.deepEqual(report.admitted, [1]);

  // …and the ring names who did it, which is the whole difference between this and S1: an
  // injection that used to be anonymous is now attributable to a member row somebody can look at.
  assert.deepEqual(ring.originOf(fsp, 1),
    { how: 'admitted', deviceId: phantom.deviceId, memberId: phantom.memberId });
});

test('what DOES hold: the wrap AAD still pins space and epoch, so a wrap cannot be moved', async () => {
  const me = await makeDevice();
  const peer = await makeDevice();
  const a = familySpace();
  const b = familySpace();
  const key = await createSpaceKey();
  const mine = await importKex(me.kexPubRaw);

  const blob = await wrapSpaceKey(key, peer.kexPriv, mine, { spaceId: a, epoch: 2 });
  const theirs = await importKex(peer.kexPubRaw);

  assert.notEqual(await unwrapSpaceKey(blob, me.kexPriv, theirs, { spaceId: a, epoch: 2 }), null);
  // Replayed into another space, or relabelled to another epoch: `null`, both times. The relay
  // cannot promote a stale epoch's wrap, and cannot move a personal wrap into a family slot.
  assert.equal(await unwrapSpaceKey(blob, me.kexPriv, theirs, { spaceId: b, epoch: 2 }), null);
  assert.equal(await unwrapSpaceKey(blob, me.kexPriv, theirs, { spaceId: a, epoch: 3 }), null);
  // …which is precisely why the attack above had to bring its OWN key rather than move an old one.
});

test('FAILED — personalRecipients still cannot be handed a family list (barrier 2 is structural)', async () => {
  const me = await makeDevice();
  const stranger = await makeDevice();

  assert.throws(() => personalRecipients({
    memberId: me.memberId,
    recoverySigPubRaw: me.recSigPubRaw,
    recoveryKexPubRaw: me.recKexPubRaw,
    devices: [
      { deviceId: me.deviceId, memberId: me.memberId, kexPubRaw: me.kexPubRaw, attestation: me.blob },
      { deviceId: stranger.deviceId, memberId: stranger.memberId, kexPubRaw: stranger.kexPubRaw, attestation: stranger.blob },
    ],
  }), /REFUSING a device belonging to member/);

  // And a family-branded recipient cannot receive a personal key, whatever the caller intended.
  const family = familyRecipients([memberRecord(me)]);
  const aKey = await createSpaceKey();
  await assert.rejects(
    () => wrapToRecipients(aKey, me.kexPriv, family, { spaceId: `psp_${'A'.repeat(22)}`, epoch: 1 }),
    /cannot receive a "personal"-space key/);
});
