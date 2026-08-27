// ATTACK · T1 — the relay stops trying to READ the ciphertext and instead CHOOSES THE KEY.
//
// ADR 002 §4.2 step 2 and §2.3 make the OUTBOUND direction rigorous: before a space key is wrapped
// to anybody, `assertRecipients` → `recipientProblem` verifies the recipient's attestation under
// the housing member's recovery key AND binds `att.kexPubRaw` to the exact key the wrap is
// addressed to — "an attestation that verifies but names a different agreement key would let a
// member (or a relay that reordered a member list) redirect the space key to a key of their
// choosing while every signature still checked out. That is a key-injection channel."
//
// This file asks the mirror question, which ADR 002 never asks: **who verifies the SENDER, on the
// way IN?**  `unwrapSpaceKey`'s own JSDoc answers it — "theirKexPub: the sender's ECDH public key,
// from their VERIFIED attestation" — and `admitWraps`, the one function that actually feeds
// `GET /api/v1/spaces/:id/keys` into the ring, takes that key straight off the relay's row.
//
// GROUND RULE: T1 holds NO family key and forges NO signature anywhere in this file. Everything
// below is done with a throwaway ECDH keypair the relay generates for itself and two JSON rows.

import test from 'node:test';
import assert from 'node:assert/strict';

import { b64u } from '../../src/js/core/b64.js';
import {
  createKeyRing, admitWraps, createSpaceKey, wrapSpaceKey, unwrapSpaceKey,
  wrapToRecipients, familyRecipients, recipientProblem, assertRecipients,
} from '../../src/js/crypto/spacekeys.js';
import { sealOp, openOp } from '../../src/js/crypto/envelope.js';
import {
  makeDevice, memberRecord, tableOf, makeOp, hdrFor, outcome, familySpace,
  importKex, rawPubOf, rawAesOf, S,
} from './_crypto-relay-kit.js';

/** The relay's own throwaway ECDH keypair. No attestation, no member record, no signature. */
const relayKeypair = () => S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);

// ─────────────────────────────────────────────────────────────────────────────

test('SUCCEEDED — the relay injects a space key OF ITS OWN CHOOSING through admitWraps', async () => {
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
  // writes the ORDER — and `KeyRing.put` is first-write-wins.
  const ring = createKeyRing();
  const report = await admitWraps(ring, [
    { epoch: 4, wrapped: forgedWrap, senderKexPubRaw: b64u(await rawPubOf(relay)) },
    { epoch: 4, wrapped: honestWrap, senderKexPubRaw: honestPeer.att.kexPubRaw },
  ], { spaceId: fsp, myKexPriv: victim.kexPriv });

  // The forged row is ADMITTED. Nothing in `admitWraps` asked whose key that was.
  assert.deepEqual(report.admitted, [4]);
  assert.equal(report.refused, 0);
  assert.equal(await rawAesOf(ring.get(fsp, 4)), await rawAesOf(relayKey));
  assert.notEqual(await rawAesOf(ring.get(fsp, 4)), await rawAesOf(honestKey));

  // …and the honest wrap is counted as a `duplicate`, which is INDISTINGUISHABLE from D9's
  // ordinary case (two member devices both wrapping the ring to a joiner, §7.1 step 4). There is
  // no anomaly for a caller to surface, because the benign case produces the identical number.
  assert.equal(report.duplicates, 1);
});

test('SUCCEEDED — the victim then SEALS ITS OWN PLAINTEXT under the relay\'s key', async () => {
  const victim = await makeDevice();
  const fsp = familySpace();
  const relay = await relayKeypair();
  const relayKey = await createSpaceKey();

  const ring = createKeyRing();
  await admitWraps(ring, [{
    epoch: 4,
    wrapped: await wrapSpaceKey(relayKey, relay.privateKey, await importKex(victim.kexPubRaw), { spaceId: fsp, epoch: 4 }),
    senderKexPubRaw: b64u(await rawPubOf(relay)),
  }], { spaceId: fsp, myKexPriv: victim.kexPriv });

  // `currentEpoch` is the ring's max — so a relay that injects at `e+1` becomes the CURRENT epoch,
  // and the outbox seals its next op into it.
  assert.equal(ring.currentEpoch(fsp), 4);

  const op = makeOp(victim, fsp, {
    k: 'member.set', e: `member:${victim.memberId}`, f: { displayName: 'Mama' },
  });
  const env = await sealOp(op, ring, victim.sigPriv, hdrFor(op, victim.dv, 4, ''));

  // The relay reads it. Not a metadata inference — the literal plaintext.
  const relayRing = { get: () => relayKey };
  const opened = await openOp(env, relayRing, tableOf(victim));
  assert.equal(opened.status, 'opened');
  assert.equal(opened.op.f.displayName, 'Mama');
  assert.equal(opened.op.e, `member:${victim.memberId}`);

  // The full sequence, for the record:
  //   1. the relay generates one ECDH keypair and one AES key. No signature, no attestation.
  //   2. it returns ONE extra row from GET /spaces/:id/keys, listed before the honest one.
  //   3. `admitWraps` admits it; the honest wrap becomes a `duplicate`.
  //   4. `ring.currentEpoch` now names the relay's epoch, so the outbox seals into it.
  //   5. every op this device authors from now on is readable by the relay, in plaintext,
  //      including its Privat personal-space ops if the same trick is played on `psp_…`.
  // ADR 002 §21.1's "the server holds no readable content" does not survive step 5.
});

test('SUCCEEDED — the same row also DENIES SERVICE: honest epoch-4 ops become an aead throw for ever', async () => {
  const victim = await makeDevice();
  const author = await makeDevice();
  const fsp = familySpace();
  const relay = await relayKeypair();

  const honestKey = await createSpaceKey();
  const relayKey = await createSpaceKey();

  const op = makeOp(author, fsp, { k: 'member.set', e: `member:${author.memberId}`, f: { displayName: 'Papa' } });
  const honestEnv = await sealOp(op, { get: () => honestKey }, author.sigPriv, hdrFor(op, author.dv, 4, ''));

  const ring = createKeyRing();
  await admitWraps(ring, [{
    epoch: 4,
    wrapped: await wrapSpaceKey(relayKey, relay.privateKey, await importKex(victim.kexPubRaw), { spaceId: fsp, epoch: 4 }),
    senderKexPubRaw: b64u(await rawPubOf(relay)),
  }], { spaceId: fsp, myKexPriv: victim.kexPriv });

  // Not a park — a THROW. `openOp` reaches P4, finds a key, and the AEAD refuses. There is no
  // "the key I hold might be wrong" branch anywhere, and `KeyRing.put` is first-write-wins, so the
  // real epoch-4 key can never displace the injected one. The board silently loses epoch 4.
  assert.equal(await outcome(() => openOp(honestEnv, ring, tableOf(author))), 'aead');

  const second = await admitWraps(ring, [{
    epoch: 4,
    wrapped: await wrapSpaceKey(honestKey, author.kexPriv, await importKex(victim.kexPubRaw), { spaceId: fsp, epoch: 4 }),
    senderKexPubRaw: author.att.kexPubRaw,
  }], { spaceId: fsp, myKexPriv: victim.kexPriv });
  assert.deepEqual(second.admitted, []);
  assert.equal(second.duplicates, 1, 'the genuine key is refused as a duplicate, permanently');

  // And the one anomaly counter the KeyRing exposes — `refusedPuts()`, documented as "the count is
  // exposed so a caller can surface the anomaly" — reads ZERO, because `admitWraps` short-circuits
  // on `ring.has(spaceId, row.epoch)` and never reaches `put`. The counter is dead on the only
  // path that feeds the ring from the network, so even a caller that WANTED to alarm on this
  // cannot: `duplicates` is the benign D9 number and `refusedPuts` never moves.
  assert.equal(ring.refusedPuts(), 0);
});

test('the asymmetry, stated exactly: OUTBOUND verifies the attestation, INBOUND verifies nothing', async () => {
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
  // arrives on a relay row and is used with no attestation, no member record, no signature.
  const ring = createKeyRing();
  const admitted = await admitWraps(ring, [{
    epoch: 1,
    wrapped: await wrapSpaceKey(await createSpaceKey(), relay.privateKey, await importKex(me.kexPubRaw), { spaceId: fsp, epoch: 1 }),
    senderKexPubRaw: b64u(await rawPubOf(relay)),
  }], { spaceId: fsp, myKexPriv: me.kexPriv });
  assert.deepEqual(admitted.admitted, [1]);

  // `admitWraps` has no parameter through which a caller COULD supply the verified set — no
  // `attestationOf`, no member list, no allowlist of sender keys. So this is not a caller mistake
  // waiting to be made; it is a check with nowhere to live. `openOp` takes `attestationOf` for
  // exactly this reason one seam over.
  assert.equal(admitWraps.length, 3, 'ring, rows, ctx — and ctx is {spaceId, myKexPriv} + ports');
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
  const { personalRecipients } = await import('../../src/js/crypto/spacekeys.js');

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
