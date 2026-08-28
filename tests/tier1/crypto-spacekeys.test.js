// TIER 1 · LZP-303 — space keys, wrapping, and rotation epochs.  ADR 002 §3, §4 ·
// docs/v2/contracts/crypto.contract.js §3.
//
// WHAT THIS FILE IS FOR, AND WHY IT IS ADVERSARIAL RATHER THAN HAPPY-PATH.
// This is the module where a bug is SILENT AND PERMANENT. A wrap that covers only the current
// epoch produces a joiner whose board is simply missing three years of entries, with no error
// anywhere. A family key that could open a personal envelope would break story 20.5 — „even the
// admin cannot read another member's private entries" — without any test failing, because the
// happy path would still work. So almost every test below is an attack: the wrong key, the wrong
// space, the wrong epoch, the wrong sender, a copied attestation, a swapped agreement key, a
// substituted epoch key, a partial ring, an invite carrying key material.
//
// SIGNATURES ARE NEVER COMPARED (ADR 002 §1 rule 1). Attestations are asserted with
// `verifyAttestation(...) !== null`, never against golden bytes.
//
// THE ENVELOPE HELPERS AT THE TOP ARE A DELIBERATE STAND-IN. `src/js/crypto/envelope.js` is
// LZP-304's file and does not exist yet, but the claim "no family key may EVER decrypt a
// personal-space op" is LZP-303's to prove, and it cannot be proved without an op. So this file
// builds ADR 002 §5.1's AAD by hand — `['lzp/v2/op', v, sp, ep, dv, oid, wit]`, verbatim — and
// seals under a space key exactly as §5.1 specifies. When `envelope.js` lands, these two
// functions are replaced by imports and every assertion below must still hold.

import test from 'node:test';
import assert from 'node:assert/strict';

import { b64u, ub64 } from '../../src/js/core/b64.js';
import { deviceId as mkDeviceId, memberId as mkMemberId, spaceId as mkSpaceId } from '../../src/js/core/ids.js';
import { memKeyStore } from '../../src/js/platform/keystore.js';
import { INFO, AEAD, SALT_BYTES, SYMMETRIC_KEY_BYTES, RAW_PUBKEY_BYTES, USAGES, infoBytes } from '../../src/js/crypto/suite.js';
import * as identity from '../../src/js/crypto/identity.js';
import { KEYSTORE_IDS } from '../../src/js/crypto/identity.js';
import * as sk from '../../src/js/crypto/spacekeys.js';

const S = globalThis.crypto.subtle;
const TE = new TextEncoder();
const TD = new TextDecoder();
const DAY = '2026-08-27';

// ── the LZP-304 stand-in ─────────────────────────────────────────────────────

/** ADR 002 §5.1, verbatim. ALWAYS non-empty (§1 rule 2 / §11 rule 3). */
const opAad = (h) => TE.encode(JSON.stringify(['lzp/v2/op', h.v, h.sp, h.ep, h.dv, h.oid, h.wit]));

async function sealUnder(spaceKey, hdr, text) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(AEAD.ivBytes));
  const ct = await S.encrypt(
    { name: 'AES-GCM', iv, additionalData: opAad(hdr), tagLength: AEAD.tagLength },
    spaceKey, TE.encode(text)
  );
  return { ...hdr, iv, ct: new Uint8Array(ct) };
}

async function openUnder(spaceKey, env) {
  const pt = await S.decrypt(
    { name: 'AES-GCM', iv: env.iv, additionalData: opAad(env), tagLength: AEAD.tagLength },
    spaceKey, env.ct
  );
  return TD.decode(pt);
}

const hdrFor = (sp, ep, dv) => ({ v: 1, sp, ep, dv, oid: 'oid' + ep + dv, wit: '' });

// ── fixtures ─────────────────────────────────────────────────────────────────

/** One member with `n` attested devices, and their recovery pair. Real keys, real signatures. */
async function makeMember(n = 1) {
  const memberId = mkMemberId();
  const rec = await identity.generateRecoveryKeys();
  const recoveryPubSig = await identity.exportRawPublic(rec.recSig.publicKey);
  const recoveryKexPubRaw = await identity.exportRawPublic(rec.recKex.publicKey);
  const devices = [];
  for (let i = 0; i < n; i++) {
    const { devSig, devKex } = await identity.generateDeviceKeys();
    const deviceId = mkDeviceId();
    const att = await identity.buildDeviceAttestation({ memberId, deviceId, createdAt: DAY }, devSig.publicKey, devKex.publicKey);
    const attestation = await identity.attestDevice(att, rec.recSig.privateKey);
    devices.push({
      deviceId,
      memberId,
      deviceShort: att.deviceShort,
      kexPubRaw: await identity.exportRawPublic(devKex.publicKey),
      sigPubRaw: await identity.exportRawPublic(devSig.publicKey),
      attestation,
      att,
      devSig,
      devKex,
    });
  }
  return { memberId, rec, recoveryPubSig, recoveryKexPubRaw, devices };
}

/** The shape `familyRecipients` takes, from the fixture above. */
const memberRecord = (m, extra = {}) => ({
  memberId: m.memberId,
  recoveryPubSig: m.recoveryPubSig,
  devices: m.devices.map((d) => ({ deviceId: d.deviceId, kexPubRaw: d.kexPubRaw, attestation: d.attestation })),
  ...extra,
});

/** The shape `personalRecipients` takes. */
const ownRecord = (m, extra = {}) => ({
  memberId: m.memberId,
  recoverySigPubRaw: m.recoveryPubSig,
  recoveryKexPubRaw: m.recoveryKexPubRaw,
  devices: m.devices.map((d) => ({ deviceId: d.deviceId, memberId: m.memberId, kexPubRaw: d.kexPubRaw, attestation: d.attestation })),
  ...extra,
});

const FSP = mkSpaceId('family');
const PSP = mkSpaceId('personal');

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE TYPE TAG — derived, never accepted, and there is no third kind
// ═════════════════════════════════════════════════════════════════════════════

test('spaceKindOf derives the kind from the id and REFUSES anything it cannot classify', () => {
  assert.equal(sk.spaceKindOf(PSP), 'personal');
  assert.equal(sk.spaceKindOf(FSP), 'family');
  assert.equal(sk.SPACE_KIND.PERSONAL, 'personal');
  assert.equal(sk.SPACE_KIND.FAMILY, 'family');

  // A space id we cannot classify must never be treated as EITHER kind: both branches of that
  // mistake are catastrophic (a personal key wrapped to the Kreis, or a family key in the
  // personal ring). So there is no default, and no truthiness fallback.
  for (const bad of ['', 'psp_', 'fsp', 'xxx_' + 'a'.repeat(22), PSP.slice(0, -1), PSP + 'a',
    mkDeviceId(), mkMemberId(), null, undefined, 42, {}, ['psp_' + 'a'.repeat(22)]]) {
    assert.throws(() => sk.spaceKindOf(bad), sk.SpaceKeyError, `should refuse ${JSON.stringify(bad)}`);
    assert.equal(sk.isSpaceId(bad), false);
  }
});

test('the AAD and the HKDF salt context bind kind, space and epoch — and differ on every axis', () => {
  const a = TD.decode(sk.wrapAad(FSP, 1));
  const b = TD.decode(sk.wrapAad(PSP, 1));
  const c = TD.decode(sk.wrapAad(FSP, 2));
  assert.notEqual(a, b, 'two spaces at the same epoch must not share an AAD');
  assert.notEqual(a, c, 'two epochs of one space must not share an AAD');
  assert.equal(a.includes('"family"'), true, 'the KIND is an authenticated field, not an inference');
  assert.equal(b.includes('"personal"'), true);
  assert.equal(a.includes(FSP), true);
  assert.equal(a.includes(INFO.spaceKeyWrap), true);
  assert.ok(sk.wrapAad(FSP, 1).length > 0, 'the AAD is ALWAYS non-empty (ADR 002 §1 rule 2)');
  // The salt context is the same triple — reviewable at a glance, so the two bindings cannot drift.
  assert.equal(TD.decode(sk.wrapSaltContext(FSP, 1)), a);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. STORY 20.5 — NO FAMILY KEY MAY EVER DECRYPT A PERSONAL-SPACE OP
//
// The single most important section in this file. If it ever goes red, "even the admin cannot
// read another member's private entries" has stopped being true.
// ═════════════════════════════════════════════════════════════════════════════

test('20.5: a family key applied to a personal envelope FAILS — the whole product rests on this', async () => {
  const psk = await sk.createSpaceKey();
  const fsk = await sk.createSpaceKey();

  const priv = await sealUnder(psk, hdrFor(PSP, 1, 'MAMA000000000000'), 'Zahnarzt 14:30 — Privat');
  assert.equal(await openUnder(psk, priv), 'Zahnarzt 14:30 — Privat', 'my own key opens my own entry');

  // The admin holds FSK. She has the ciphertext (T1 gave it to her, or she is a member). She has
  // every family key that ever existed. She gets an OperationError, not a plaintext, and not a
  // partial one: there is no "wrong key, right ciphertext" degradation path in AES-GCM.
  await assert.rejects(() => openUnder(fsk, priv), 'the family key must not open a personal op');

  // …and it is not merely that the keys differ. Relabelling the envelope as a family op — which
  // is exactly what a curious relay would try (§5.1's `sp` row) — fails under BOTH keys, because
  // `sp` is inside the AAD.
  const relabelled = { ...priv, sp: FSP };
  await assert.rejects(() => openUnder(fsk, relabelled), 'relabelled + family key');
  await assert.rejects(() => openUnder(psk, relabelled), 'relabelled + the CORRECT key still fails');

  // The epoch is bound too (§5.1's `ep` row): a relay pinning a client to another epoch fails.
  await assert.rejects(() => openUnder(psk, { ...priv, ep: 2 }));
});

test('barrier 1: space keys are DRAWN, not derived — no shared parent, no KDF between them', async () => {
  // `createSpaceKey` consumes exactly 32 bytes of CSPRNG and nothing else. If it ever derived a
  // key from a parent, this port would see a different call pattern.
  const draws = [];
  const random = (n) => { draws.push(n); return Uint8Array.from({ length: n }, (_, i) => (i * 7 + draws.length) & 0xff); };
  await sk.createSpaceKey({ random });
  assert.deepEqual(draws, [SYMMETRIC_KEY_BYTES]);

  // Two keys drawn from the real CSPRNG are different, and both are 256-bit AES-GCM.
  const a = await sk.createSpaceKey();
  const b = await sk.createSpaceKey();
  const ra = new Uint8Array(await S.exportKey('raw', a));
  const rb = new Uint8Array(await S.exportKey('raw', b));
  assert.equal(ra.length, SYMMETRIC_KEY_BYTES);
  assert.notEqual(b64u(ra), b64u(rb));
  assert.equal(a.algorithm.name, 'AES-GCM');
  assert.equal(a.algorithm.length, 256);
  assert.deepEqual([...a.usages].sort(), [...USAGES.aead].sort());
});

test('barrier 1 continued: a space key is EXTRACTABLE, and the ring refuses one that is not', async () => {
  // Stated honestly rather than hidden: `wrapKey` refuses a non-extractable key, and every epoch
  // key must stay re-wrappable to every FUTURE joiner (§7.1 step 5). A ring that accepted a
  // non-extractable key would silently lose the ability to onboard the next member for that
  // epoch — the failure would appear months later, on someone else's Mac.
  const key = await sk.createSpaceKey();
  assert.equal(key.extractable, true);

  const sealed = await S.importKey('raw', new Uint8Array(32), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const ring = sk.createKeyRing();
  assert.throws(() => ring.put(FSP, 1, sealed), /EXTRACTABLE/);
  await assert.rejects(() => sk.wrapSpaceKey(sealed, null, null, { spaceId: FSP, epoch: 1 }), /EXTRACTABLE/);
});

test('barrier 3: a family-space wrap cannot be opened as a personal-space wrap, at any epoch', async () => {
  const A = await makeMember();
  const B = await makeMember();
  const fam = sk.familyRecipients([memberRecord(A), memberRecord(B)]);
  const key = await sk.createSpaceKey();

  const [, toB] = await sk.wrapToRecipients(key, A.devices[0].devKex.privateKey, fam, { spaceId: FSP, epoch: 3 });
  const senderPub = await identity.importKexPublic(A.devices[0].kexPubRaw);
  const bPriv = B.devices[0].devKex.privateKey;

  assert.notEqual(await sk.unwrapSpaceKey(toB.wrapped, bPriv, senderPub, { spaceId: FSP, epoch: 3 }), null, 'the honest open works');
  assert.equal(await sk.unwrapSpaceKey(toB.wrapped, bPriv, senderPub, { spaceId: PSP, epoch: 3 }), null, 'wrong kind');
  assert.equal(await sk.unwrapSpaceKey(toB.wrapped, bPriv, senderPub, { spaceId: mkSpaceId('family'), epoch: 3 }), null, 'a DIFFERENT family space');
  assert.equal(await sk.unwrapSpaceKey(toB.wrapped, bPriv, senderPub, { spaceId: FSP, epoch: 4 }), null, 'wrong epoch');
  assert.equal(await sk.unwrapSpaceKey(toB.wrapped, A.devices[0].devKex.privateKey, senderPub, { spaceId: FSP, epoch: 3 }), null, 'not addressed to me');
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. BARRIER 2 — two recipient scopes that cannot take each other's list
//    (ADR 002 §3 barrier 2, §11 rule 10)
// ═════════════════════════════════════════════════════════════════════════════

test('personalRecipients REFUSES a family device list — the scope is a refusal, not a comment', async () => {
  const me = await makeMember(2);
  const other = await makeMember();

  const mine = sk.personalRecipients(ownRecord(me));
  assert.equal(mine.length, 3, 'two of my devices + my own RK_kex');
  assert.equal(mine.every((r) => sk.recipientScope(r) === 'personal'), true);
  assert.equal(mine.filter((r) => r.role === 'recovery').length, 1);
  assert.equal(mine.find((r) => r.role === 'recovery').deviceId, sk.recoveryRecipientId(me.memberId));

  // ADR 002 §11 rule 10, mechanically: hand it one foreign device and it throws by name.
  assert.throws(
    () => sk.personalRecipients(ownRecord(me, {
      devices: [...ownRecord(me).devices, { deviceId: other.devices[0].deviceId, memberId: other.memberId, kexPubRaw: other.devices[0].kexPubRaw, attestation: other.devices[0].attestation }],
    })),
    /REFUSING a device belonging to member/
  );
  // …and a device entry with NO memberId at all is refused too, so a family list whose entries
  // simply lack the field cannot slip through unchecked.
  assert.throws(() => sk.personalRecipients(ownRecord(me, {
    devices: [{ deviceId: other.devices[0].deviceId, kexPubRaw: other.devices[0].kexPubRaw, attestation: other.devices[0].attestation }],
  })), /REFUSING a device belonging to member/);
});

test('the recipient brand is a non-enumerable Symbol: a copy, a clone or a literal loses it', async () => {
  const A = await makeMember();
  const [r] = sk.familyRecipients([memberRecord(A)]);
  assert.equal(sk.recipientScope(r), 'family');

  // Spread copies enumerable own properties, Symbols included — but the brand is NOT enumerable,
  // so a "harmless" `{...recipient, kexPubRaw: mine}` cannot carry the scope with it. That is
  // exactly the edit a downstream agent would make, and it fails loudly instead of silently.
  assert.equal(sk.recipientScope({ ...r }), null);
  assert.equal(sk.recipientScope(JSON.parse(JSON.stringify({ ...r, kexPubRaw: b64u(r.kexPubRaw) }))), null);
  assert.equal(sk.recipientScope({ deviceId: r.deviceId, memberId: r.memberId, role: 'device', kexPubRaw: r.kexPubRaw, attestation: r.attestation }), null);
  assert.equal(sk.recipientScope(null), null);
  assert.equal(Object.keys(r).includes('scope'), false, 'the brand must not be an ordinary field a caller can set');
});

test('wrapToRecipients refuses an unbranded recipient and a cross-branded one', async () => {
  const A = await makeMember();
  const key = await sk.createSpaceKey();
  const priv = A.devices[0].devKex.privateKey;

  const fam = sk.familyRecipients([memberRecord(A)]);
  const per = sk.personalRecipients(ownRecord(A));

  await assert.rejects(() => sk.wrapToRecipients(key, priv, [{ ...fam[0] }], { spaceId: FSP, epoch: 1 }), /UNBRANDED/);
  await assert.rejects(() => sk.wrapToRecipients(key, priv, per, { spaceId: FSP, epoch: 1 }), /"personal" recipient cannot receive a "family"/);
  await assert.rejects(() => sk.wrapToRecipients(key, priv, fam, { spaceId: PSP, epoch: 1 }), /"family" recipient cannot receive a "personal"/);
  await assert.rejects(() => sk.wrapToRecipients(key, priv, [], { spaceId: FSP, epoch: 1 }), /at least one recipient/);
  await assert.rejects(() => sk.wrapToRecipients(key, priv, [...fam, ...fam], { spaceId: FSP, epoch: 1 }), /duplicate recipient/);
});

test('familyRecipients skips removed members and revoked devices, and REPORTS both', async () => {
  const A = await makeMember(2);
  const B = await makeMember();
  const C = await makeMember();
  const report = sk.familyRecipientsReport([
    memberRecord(A),
    memberRecord(B, { removedAt: '2026-08-01' }),
    { ...memberRecord(C), devices: [{ ...memberRecord(C).devices[0], revokedAt: '2026-08-02' }] },
  ]);
  assert.deepEqual(report.removed, [B.memberId]);
  assert.deepEqual(report.recipients.map((r) => r.memberId), [A.memberId, A.memberId]);
  assert.equal(report.recipients.every((r) => sk.recipientScope(r) === 'family'), true);

  assert.throws(() => sk.familyRecipients([memberRecord(A), memberRecord(A)]), /appears twice/);
  assert.throws(() => sk.familyRecipients(memberRecord(A)), /expected an array of member records/);
  assert.throws(() => sk.familyRecipients([{ ...memberRecord(A), devices: [{ deviceId: 'dev_x', kexPubRaw: A.devices[0].kexPubRaw }] }]), /no attestation blob/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. VERIFY BEFORE WRAPPING (ADR 002 §2.3, §4.2 step 2)
// ═════════════════════════════════════════════════════════════════════════════

test('a device whose attestation does not verify under its HOUSING member is refused a key', async () => {
  const A = await makeMember();
  const B = await makeMember();
  const key = await sk.createSpaceKey();

  // The squatter files a copy of A's attestation blob into HER OWN record. §2.3 condition (4):
  // the blob is verified under the HOUSING member's recovery key, never under `att.memberId`.
  const squat = sk.familyRecipients([{ ...memberRecord(B), devices: [{ deviceId: A.devices[0].deviceId, kexPubRaw: A.devices[0].kexPubRaw, attestation: A.devices[0].attestation }] }]);
  await assert.rejects(
    () => sk.wrapToRecipients(key, A.devices[0].devKex.privateKey, squat, { spaceId: FSP, epoch: 1 }),
    /does not verify under member/
  );

  // A truncated / garbage blob is refused the same way — `verifyAttestation` returns null and
  // never throws, so no caller is tempted to read an engine error name (rule 3).
  const junk = sk.familyRecipients([{ ...memberRecord(A), devices: [{ ...memberRecord(A).devices[0], attestation: 'not.a.blob' }] }]);
  await assert.rejects(() => sk.wrapToRecipients(key, A.devices[0].devKex.privateKey, junk, { spaceId: FSP, epoch: 1 }), /does not verify/);
});

test('KEY INJECTION: an attestation that verifies but names a DIFFERENT agreement key is refused', async () => {
  // The attack `crypto.contract.js` §2 names: "kexPubRaw is what §4.2 wraps the space key to".
  // Everything signs, everything verifies — and the space key goes to a key of the attacker's
  // choosing. One string comparison closes it, and the comparison has to be here because it is
  // the only place that knows both the attestation and the address of the wrap.
  const A = await makeMember();
  const attacker = await makeMember();
  const key = await sk.createSpaceKey();

  const rec = memberRecord(A);
  const injected = sk.familyRecipients([{ ...rec, devices: [{ ...rec.devices[0], kexPubRaw: attacker.devices[0].kexPubRaw }] }]);
  const problem = await sk.recipientProblem(injected[0]);
  assert.match(problem, /names a DIFFERENT agreement key/);
  await assert.rejects(() => sk.wrapToRecipients(key, A.devices[0].devKex.privateKey, injected, { spaceId: FSP, epoch: 1 }), /DIFFERENT agreement key/);
});

test('a recipient filed under the wrong deviceId or the wrong memberId is refused', async () => {
  const A = await makeMember(2);
  const rec = memberRecord(A);

  const wrongDevice = sk.familyRecipients([{ ...rec, devices: [{ ...rec.devices[0], deviceId: A.devices[1].deviceId }] }]);
  assert.match(await sk.recipientProblem(wrongDevice[0]), /names device/);

  // Same signed blob, filed under a member whose recovery key is not the signer.
  const B = await makeMember();
  const wrongMember = sk.familyRecipients([{ memberId: B.memberId, recoveryPubSig: A.recoveryPubSig, devices: [rec.devices[0]] }]);
  assert.match(await sk.recipientProblem(wrongMember[0]), /claims member/);
});

test('a recovery recipient needs no attestation — it is MY OWN key and never came off the wire', async () => {
  const me = await makeMember();
  const per = sk.personalRecipients(ownRecord(me));
  const recovery = per.find((r) => r.role === 'recovery');
  assert.equal(recovery.attestation, null);
  assert.equal(await sk.recipientProblem(recovery), null);

  // …and omitting the recovery key is allowed: a member who has not minted one yet still wraps
  // to their own devices.
  const withoutRecovery = sk.personalRecipients({ ...ownRecord(me), recoveryKexPubRaw: undefined });
  assert.equal(withoutRecovery.some((r) => r.role === 'recovery'), false);
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. THE WRAP ITSELF — sizes, engine rules, and every way it must fail
// ═════════════════════════════════════════════════════════════════════════════

test('WrapBlob is exactly {v, salt, iv, ct} and exactly 156 bytes of JSON (ADR 002 §3, verified)', async () => {
  const A = await makeMember();
  const B = await makeMember();
  const key = await sk.createSpaceKey();
  const [w] = await sk.wrapToRecipients(key, A.devices[0].devKex.privateKey, sk.familyRecipients([memberRecord(B)]), { spaceId: FSP, epoch: 1 });

  assert.deepEqual(Object.keys(w.wrapped).sort(), ['ct', 'iv', 'salt', 'v']);
  assert.equal(w.wrapped.v, 1);
  assert.equal(JSON.stringify(w.wrapped).length, 156, 'the ADR measured 156 B; a change here is a wire-format change');
  assert.equal(ub64(w.wrapped.salt).length, SALT_BYTES);
  assert.equal(ub64(w.wrapped.iv).length, AEAD.ivBytes);
  assert.equal(ub64(w.wrapped.ct).length, SYMMETRIC_KEY_BYTES + AEAD.tagLength / 8, '32-byte key + 16-byte tag');
  // The wrap carries the space and the epoch NOWHERE. Both sides reconstruct them, which is what
  // makes a disagreement a decryption failure instead of a field anyone can rewrite.
  const json = JSON.stringify(w.wrapped);
  assert.equal(json.includes(FSP), false);
  assert.equal(json.includes('epoch'), false);
  assert.equal(w.epoch, 1, 'the epoch travels on the ROW (KeyWrapRow), not inside the blob');
});

test('rule 4: the salt is domain-bound, and two wraps of one key are different blobs that both open', async () => {
  const A = await makeMember();
  const B = await makeMember();
  const key = await sk.createSpaceKey();
  const fam = sk.familyRecipients([memberRecord(B)]);
  const priv = A.devices[0].devKex.privateKey;
  const senderPub = await identity.importKexPublic(A.devices[0].kexPubRaw);

  const [w1] = await sk.wrapToRecipients(key, priv, fam, { spaceId: FSP, epoch: 1 });
  const [w2] = await sk.wrapToRecipients(key, priv, fam, { spaceId: FSP, epoch: 1 });
  assert.notEqual(w1.wrapped.salt, w2.wrapped.salt, 'a fresh salt per wrap');
  assert.notEqual(w1.wrapped.iv, w2.wrapped.iv, 'a fresh IV per wrap — GCM nonce reuse is fatal');
  assert.notEqual(w1.wrapped.ct, w2.wrapped.ct);

  const k1 = await sk.unwrapSpaceKey(w1.wrapped, B.devices[0].devKex.privateKey, senderPub, { spaceId: FSP, epoch: 1 });
  const k2 = await sk.unwrapSpaceKey(w2.wrapped, B.devices[0].devKex.privateKey, senderPub, { spaceId: FSP, epoch: 1 });
  const raw = b64u(new Uint8Array(await S.exportKey('raw', key)));
  assert.equal(b64u(new Uint8Array(await S.exportKey('raw', k1))), raw);
  assert.equal(b64u(new Uint8Array(await S.exportKey('raw', k2))), raw, 'two different blobs, one key');

  // The SAME 32 random wire bytes under a different space give a different KEK: the domain is
  // folded into the HKDF salt, not only into the AAD. Belt and braces, independently sufficient.
  const fixed = new Uint8Array(SALT_BYTES).fill(9);
  const iv = new Uint8Array(AEAD.ivBytes).fill(3);
  const rand = (n) => (n === SALT_BYTES ? fixed.slice() : iv.slice());
  const perFam = await sk.wrapSpaceKey(key, priv, await identity.importKexPublic(B.devices[0].kexPubRaw), { spaceId: FSP, epoch: 1, random: rand });
  const perPer = await sk.wrapSpaceKey(key, priv, await identity.importKexPublic(B.devices[0].kexPubRaw), { spaceId: PSP, epoch: 1, random: rand });
  assert.equal(perFam.salt, perPer.salt, 'same wire salt…');
  assert.equal(perFam.iv, perPer.iv, '…same IV…');
  assert.notEqual(perFam.ct, perPer.ct, '…and a DIFFERENT ciphertext: the KEK itself is domain-separated');
});

// A CROSS-ENGINE KNOWN-ANSWER TEST FOR THE WRAP.
//
// Rule 1 forbids golden SIGNATURES, because ECDSA is non-deterministic in both engines. It says
// nothing about the wrap, and the wrap is completely deterministic: ECDH is a scalar
// multiplication, HKDF is a hash chain, and AES-GCM is a block cipher. Pin both ECDH keys, the
// wire salt, the IV and the space key and the ciphertext is a FUNCTION — so it can be asserted
// byte-for-byte, and the same vector is asserted in `tests/tier2/crypto-spacekeys.dom.js`.
//
// It is worth the 400 characters because family sharing is exactly "a wrap made on one Mac opens
// on another". If Node and WebKit ever derived different KEKs from the same inputs, every tier-1
// assertion in this file would be green and the product would not work. The two copies of this
// vector must be identical; a reviewer can diff them.
export const WRAP_KAT = Object.freeze({
  aPkcs8: 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgw4_wlH2yzkWMv_fMXKFIP05xB-0b3jdJ1bx5HqVMdCuhRANCAARjaOKoieh98vjHBHCrcx4AE5-7l3anW1VtL1A8xw039BbBoWMJonNfsSaEx-gNlzop39_9-UTMtmOdOWM2QECk',
  bRaw: 'BD8_PyGptv6Qat7RWIQXPZGghK9iT9e71MdMn1edo94DFEu6dl96F8tJupObvc7jGat1JBq1QXeuNJ-MoKFT5vc',
  keyBytes: 'Aw4ZJC86RVBbZnF8h5KdqLO-ydTf6vUACxYhLDdCTVg',
  salt: 'AQYLEBUaHyQpLjM4PUJHTFFWW2Blam90eX6DiI2Sl5w',
  iv: 'AhMkNUZXaHmKm6y9',
  spaceIdFamily: 'fsp_AAAAAAAAAAAAAAAAAAAAAA',
  spaceIdPersonal: 'psp_AAAAAAAAAAAAAAAAAAAAAA',
  epoch: 3,
  ctFamily: 'AkWhvt9pW2TenGXB4JMbdXURE1jrFcKO9Nej_YeaQHg7-cabN1ANBgMKkoTA6rXw',
  ctPersonal: 'D_PsLcgjvUlw6p9gLPocL3jo083hZjV7coKFrUGAXhyJwNsrfmf_eGYr6Dak9qYx',
});

test('KAT: the wrap is deterministic and byte-identical to the WebKit vector — and the two spaces differ', async () => {
  const K = WRAP_KAT;
  // LZP-302 finding 9: importing a PRIVATE EC key carries only the PRIVATE usages. `['deriveBits',
  // 'deriveKey']` here; a public usage would be a SyntaxError in both engines.
  const aPriv = await S.importKey('pkcs8', ub64(K.aPkcs8), { name: 'ECDH', namedCurve: 'P-256' }, true, [...USAGES.kexPrivate]);
  const bPub = await identity.importKexPublic(ub64(K.bRaw));            // rule 5: keyUsages []
  const spaceKey = await S.importKey('raw', ub64(K.keyBytes), { name: 'AES-GCM', length: 256 }, true, [...USAGES.aead]);
  const salt = ub64(K.salt);
  const iv = ub64(K.iv);
  const random = (n) => (n === SALT_BYTES ? salt.slice() : iv.slice());

  const fam = await sk.wrapSpaceKey(spaceKey, aPriv, bPub, { spaceId: K.spaceIdFamily, epoch: K.epoch, random });
  const per = await sk.wrapSpaceKey(spaceKey, aPriv, bPub, { spaceId: K.spaceIdPersonal, epoch: K.epoch, random });
  assert.equal(fam.ct, K.ctFamily, 'a wrap made on another engine must open on this one');
  assert.equal(per.ct, K.ctPersonal);
  assert.notEqual(K.ctFamily, K.ctPersonal, 'and the domain separation is in the KAT itself, not only in a runtime assertion');
  assert.equal(fam.salt, K.salt);
  assert.equal(fam.iv, K.iv);
});

test('rule 3: unwrapSpaceKey returns null for every failure and never leaks an engine error name', async () => {
  const A = await makeMember();
  const B = await makeMember();
  const C = await makeMember();
  const key = await sk.createSpaceKey();
  const senderPub = await identity.importKexPublic(A.devices[0].kexPubRaw);
  const bPriv = B.devices[0].devKex.privateKey;
  const ctx = { spaceId: FSP, epoch: 1 };
  const [w] = await sk.wrapToRecipients(key, A.devices[0].devKex.privateKey, sk.familyRecipients([memberRecord(B)]), ctx);

  const tampered = ub64(w.wrapped.ct);
  tampered[0] ^= 0xff;
  const cases = {
    'tampered ct': { ...w.wrapped, ct: b64u(tampered) },
    'tampered iv': { ...w.wrapped, iv: b64u(new Uint8Array(AEAD.ivBytes)) },
    'tampered salt': { ...w.wrapped, salt: b64u(new Uint8Array(SALT_BYTES)) },
    'unknown v': { ...w.wrapped, v: 2 },
    'short ct': { ...w.wrapped, ct: b64u(new Uint8Array(16)) },
    'short salt': { ...w.wrapped, salt: b64u(new Uint8Array(8)) },
    'not base64url': { ...w.wrapped, ct: '###' },
    'missing field': { v: 1, salt: w.wrapped.salt, iv: w.wrapped.iv },
    'an array': [1, 2, 3],
    'a string': 'nope',
    null: null,
  };
  for (const [name, blob] of Object.entries(cases)) {
    assert.equal(await sk.unwrapSpaceKey(blob, bPriv, senderPub, ctx), null, `${name} must be null, not a throw`);
  }
  // Wrong sender: the ECDH secret differs, so the KEK differs. Same answer, same silence.
  assert.equal(await sk.unwrapSpaceKey(w.wrapped, bPriv, await identity.importKexPublic(C.devices[0].kexPubRaw), ctx), null);

  // A malformed ARGUMENT is our bug, not a peer's data, and is the one thing this may throw about.
  await assert.rejects(() => sk.unwrapSpaceKey(w.wrapped, bPriv, senderPub, { spaceId: 'nope', epoch: 1 }), sk.SpaceKeyError);
  await assert.rejects(() => sk.unwrapSpaceKey(w.wrapped, bPriv, senderPub, { spaceId: FSP, epoch: 0 }), sk.SpaceKeyError);
  await assert.rejects(() => sk.unwrapSpaceKey(w.wrapped, bPriv, senderPub, undefined), /REQUIRED/);
});

test('rule 6, characterized: AES-KW WOULD wrap a 32-byte space key — which is why a prototype hides the bug', async () => {
  // This file wraps a 32-byte AES key, and 32 IS a multiple of 8, so AES-KW would work here and
  // a reviewer would see nothing wrong. The rule exists because the very next thing to be wrapped
  // (§7.2's recovery PKCS#8) is 138 bytes and is NOT. Both halves are asserted so the trap is
  // recorded rather than remembered.
  const kek = await S.generateKey({ name: 'AES-KW', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  const spaceKey = await sk.createSpaceKey();
  const ok = await S.wrapKey('raw', spaceKey, kek, 'AES-KW');
  assert.equal(new Uint8Array(ok).length, 40, 'AES-KW happily wraps 32 bytes — the trap');

  const { recSig } = await identity.generateRecoveryKeys();
  const pkcs8 = new Uint8Array(await S.exportKey('pkcs8', recSig.privateKey));
  assert.equal(pkcs8.length, 138, '138 is not a multiple of 8');
  let threw = false;
  try { await S.wrapKey('pkcs8', recSig.privateKey, kek, 'AES-KW'); } catch { threw = true; }
  assert.equal(threw, true, 'AES-KW over a P-256 private key fails in both engines (ADR 002 §1 rule 6)');

  // And nothing in this module reaches for it: every wrap goes through AES-GCM.
  assert.equal(Object.keys(sk).some((k) => /kw/i.test(k)), false);
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. THE KEY RING
// ═════════════════════════════════════════════════════════════════════════════

test('KeyRing.get is TOTAL — a miss is a park, so it returns null and never throws', async () => {
  // ADR 002 §5.2.2 P4: `openOp` looks the epoch up before it has verified anything, and `env.sp`
  // / `env.ep` are PEER data. A throw here would turn a hostile header into a crashed sync pass.
  const ring = sk.createKeyRing();
  for (const [space, epoch] of [[FSP, 1], ['nonsense', 1], [null, 1], [FSP, 0], [FSP, -1], [FSP, 1.5], [FSP, null], [PSP, 1]]) {
    assert.equal(ring.get(space, epoch), null);
  }
  assert.equal(ring.currentEpoch(FSP), 0, '0 means "no key for this space"');
  assert.deepEqual(ring.epochs(FSP), []);
  assert.equal(ring.has(FSP, 1), false);
});

test('KeyRing.put is LOUD — our own data, refused rather than silently dropped', async () => {
  const ring = sk.createKeyRing();
  const key = await sk.createSpaceKey();
  assert.throws(() => ring.put('nonsense', 1, key), sk.SpaceKeyError);
  assert.throws(() => ring.put(FSP, 0, key), /epoch must be a safe integer/);
  assert.throws(() => ring.put(FSP, 1.5, key), /epoch must be a safe integer/);
  assert.throws(() => ring.put(FSP, 1, null), /not a CryptoKey/);

  const { devSig } = await identity.generateDeviceKeys();
  assert.throws(() => ring.put(FSP, 1, devSig.privateKey), /expected a secret key/);
  const aes128 = await S.generateKey({ name: 'AES-GCM', length: 128 }, true, ['encrypt', 'decrypt']);
  assert.throws(() => ring.put(FSP, 1, aes128), /expected a 256-bit key/);
  const encryptOnly = await S.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  assert.throws(() => ring.put(FSP, 1, encryptOnly), /missing the 'decrypt' usage/);
});

test('KeyRing: a key put under one space is NEVER returned for another', async () => {
  const ring = sk.createKeyRing();
  const psk = await sk.createSpaceKey();
  const fsk = await sk.createSpaceKey();
  ring.put(PSP, 1, psk);
  ring.put(FSP, 1, fsk);
  assert.equal(ring.get(PSP, 1), psk);
  assert.equal(ring.get(FSP, 1), fsk);
  assert.notEqual(ring.get(PSP, 1), ring.get(FSP, 1));
  assert.deepEqual(ring.spaces(), [FSP, PSP].sort());

  // A second family space — v2 has one, but the ring must not conflate two ids of one KIND.
  const other = mkSpaceId('family');
  assert.equal(ring.get(other, 1), null);
});

test('KeyRing: FIRST WRITE WINS — a substituted epoch key cannot displace one already decrypting', async () => {
  const ring = sk.createKeyRing();
  const real = await sk.createSpaceKey();
  const substitute = await sk.createSpaceKey();
  assert.equal(ring.put(FSP, 3, real), true);
  assert.equal(ring.put(FSP, 3, substitute), false, 'the second key is refused, not stored');
  assert.equal(ring.get(FSP, 3), real);
  assert.equal(ring.refusedPuts(), 1, 'and the anomaly is countable, so a caller can surface it');

  // The ordinary cause of a second put is two members both wrapping the same epoch to a joiner
  // (D9, §7.1 step 4), which is why this is a `false` and not a throw: a throw would break the
  // common path in order to report the rare one.
  const env = await sealUnder(real, hdrFor(FSP, 3, 'OMA0000000000000'), 'Omas Geburtstag');
  assert.equal(await openUnder(ring.get(FSP, 3), env), 'Omas Geburtstag');
});

test('KeyRing RETAINS every epoch, and names the gaps a partial delivery left', async () => {
  const ring = sk.createKeyRing();
  for (const e of [3, 1, 5]) ring.put(FSP, e, await sk.createSpaceKey());
  assert.deepEqual(ring.epochs(FSP), [1, 3, 5], 'ascending, and nothing discarded');
  assert.equal(ring.currentEpoch(FSP), 5);
  assert.deepEqual([...ring.keysByEpoch(FSP).keys()], [1, 3, 5]);
  assert.deepEqual(ring.missing(FSP, 5), [2, 4]);
  assert.equal(ring.covers(FSP, 5), false);
  assert.equal(ring.covers(FSP, 1), true);
  assert.equal(ring.size(), 3);
});

// ═════════════════════════════════════════════════════════════════════════════
// 6b. THE ADMISSIBLE SENDER SET — finding S1, ADR 002 §4.2 step 6 (amended 2026-08-28)
//
// Barrier 2 on the way IN. Until 2026-08-28 `admitWraps` derived its KEK from the sender key the
// RELAY put on the row, so one throwaway ECDH keypair chose which key the victim sealed its own
// Privat entries under. The domain that says which cells this is about is `C1` in
// `tests/helpers/crypto-domains.js` (128 cells, 30 of them S1's); the adversarial half is
// `tests/attack/crypto-relay-keyinjection.test.js` and `crypto-member-read.test.js` M-R6.
// ═════════════════════════════════════════════════════════════════════════════

test('admitWraps REFUSES to run without ctx.senders — a skippable check is not a check', async () => {
  const me = await makeMember();
  const peer = await makeMember();
  const key = await sk.createSpaceKey();
  const myPub = await identity.importKexPublic(me.devices[0].kexPubRaw);
  const row = {
    epoch: 1,
    wrapped: await sk.wrapSpaceKey(key, peer.devices[0].devKex.privateKey, myPub, { spaceId: FSP, epoch: 1 }),
    senderKexPubRaw: peer.devices[0].kexPubRaw,
  };
  const ring = sk.createKeyRing();
  await assert.rejects(
    () => sk.admitWraps(ring, [row], { spaceId: FSP, myKexPriv: me.devices[0].devKex.privateKey }),
    (e) => e instanceof sk.SpaceKeyError && /`ctx.senders` is REQUIRED/.test(e.message)
  );
  assert.equal(ring.size(), 0, 'and nothing was admitted on the way to the throw');
  // `null` is not "no opinion" either — a caller that computed an empty roster must pass `[]`.
  await assert.rejects(
    () => sk.admitWraps(ring, [row], { spaceId: FSP, myKexPriv: me.devices[0].devKex.privateKey, senders: null }),
    /`ctx.senders` is REQUIRED/
  );
});

test('the sender set is the RECIPIENT set: the two constructors, the same brand, the same verification', async () => {
  const me = await makeMember(2);
  const peer = await makeMember();
  const psp = mkSpaceId('personal');

  const family = await sk.admissibleSenders(sk.familyRecipients([memberRecord(me), memberRecord(peer)]), FSP);
  assert.equal(sk.isSenderSet(family), true);
  assert.equal(family.size(), 3, 'my two Macs and the peer\'s one');
  assert.deepEqual(family.deviceIds(), [...me.devices, ...peer.devices].map((d) => d.deviceId).sort());

  const personal = await sk.admissibleSenders(sk.personalRecipients(ownRecord(me)), psp);
  assert.equal(personal.size(), 3, 'my two Macs plus my own recovery key');
  // THE STRUCTURAL CLAIM: `personalRecipients` refuses a foreign device, so the personal sender
  // set cannot contain one — not "must not", cannot. There is no list to pass that would work.
  assert.throws(() => sk.personalRecipients({
    ...ownRecord(me),
    devices: [{ deviceId: peer.devices[0].deviceId, memberId: peer.memberId, kexPubRaw: peer.devices[0].kexPubRaw, attestation: peer.devices[0].attestation }],
  }), /REFUSING a device belonging to member/);

  // A set is BOUND to one space, and the brands do not cross.
  await assert.rejects(() => sk.admissibleSenders(family, mkSpaceId('family')), /verified for .* cannot authorize/);
  await assert.rejects(() => sk.admissibleSenders(sk.familyRecipients([memberRecord(peer)]), psp),
    /cannot authorize a "personal"-space admission/);
  await assert.rejects(() => sk.admissibleSenders(sk.personalRecipients(ownRecord(me)), FSP),
    /cannot authorize a "family"-space admission/);

  // Unbranded, and a spread copy of a branded one: both refused, because the brand is a
  // non-enumerable module-private Symbol.
  const [genuine] = sk.familyRecipients([memberRecord(peer)]);
  await assert.rejects(() => sk.admissibleSenders([{ ...genuine }], FSP), /UNBRANDED recipient cannot authorize/);
  assert.equal(sk.isSenderSet({ ...family }), false);
  await assert.rejects(() => sk.admissibleSenders({ ...family }, FSP), /expected the Recipient\[\]/);

  // And the same key-injection binding the wrapping side enforces (§2.3): an attestation that
  // verifies but names a DIFFERENT agreement key is refused on the way in too.
  const rec = memberRecord(peer);
  const swapped = sk.familyRecipients([{ ...rec, devices: [{ ...rec.devices[0], kexPubRaw: me.devices[0].kexPubRaw }] }]);
  await assert.rejects(() => sk.admissibleSenders(swapped, FSP), /DIFFERENT agreement key/);
});

test('an EMPTY sender set refuses every row and never throws — the joiner before step 6', async () => {
  // `assertRecipients` refuses an empty list because a wrap to NOBODY is a lost epoch. An
  // admission from nobody is merely a sync that admitted nothing, and throwing here would teach a
  // caller to pass a roster it had not verified.
  const her = await makeMember();
  const peer = await makeMember();
  const key = await sk.createSpaceKey();
  const myPub = await identity.importKexPublic(her.devices[0].kexPubRaw);
  const row = {
    epoch: 1,
    wrapped: await sk.wrapSpaceKey(key, peer.devices[0].devKex.privateKey, myPub, { spaceId: FSP, epoch: 1 }),
    senderKexPubRaw: peer.devices[0].kexPubRaw,
  };
  const ring = sk.createKeyRing();
  const parked = await sk.admitWraps(ring, [row], { spaceId: FSP, myKexPriv: her.devices[0].devKex.privateKey, senders: [] });
  assert.deepEqual(parked, { admitted: [], refused: 1, duplicates: 0, unauthorized: 1, unauthorizedEpochs: [1] });
  assert.equal(ring.size(), 0);
  // …and the SAME row, once she can name the sender. Re-evaluable, which is what §4.4 requires.
  const now = await sk.admitWraps(ring, [row], {
    spaceId: FSP, myKexPriv: her.devices[0].devKex.privateKey, senders: sk.familyRecipients([memberRecord(peer)]),
  });
  assert.deepEqual(now.admitted, [1]);
});

test('the ring REMEMBERS who delivered each key — a CryptoKey carries no provenance, the slot does', async () => {
  const me = await makeMember();
  const peer = await makeMember();
  const key = await sk.createSpaceKey();
  const myPub = await identity.importKexPublic(me.devices[0].kexPubRaw);

  const ring = sk.createKeyRing();
  // Minted here, or restored from this device's own key store: `local`, with no device id.
  ring.put(FSP, 1, await sk.createSpaceKey());
  assert.deepEqual(ring.originOf(FSP, 1), { how: 'local', deviceId: null, memberId: null });
  assert.equal(ring.originOf(FSP, 9), null, 'a slot that holds nothing has no origin');
  assert.equal(ring.originOf('not-a-space', 1), null);

  await sk.admitWraps(ring, [{
    epoch: 2,
    wrapped: await sk.wrapSpaceKey(key, peer.devices[0].devKex.privateKey, myPub, { spaceId: FSP, epoch: 2 }),
    senderKexPubRaw: peer.devices[0].kexPubRaw,
  }], {
    spaceId: FSP, myKexPriv: me.devices[0].devKex.privateKey,
    senders: sk.familyRecipients([memberRecord(peer)]),
  });
  assert.deepEqual(ring.originOf(FSP, 2), {
    how: 'admitted', deviceId: peer.devices[0].deviceId, memberId: peer.memberId,
  });

  // `rotateSpace` mints, so its epoch is `local` — the ring can tell its own keys from the ones
  // it accepted, which is the distinction the finding said did not exist.
  const rot = await sk.rotateSpace({
    ring, spaceId: PSP, myKexPriv: me.devices[0].devKex.privateKey,
    recipients: sk.personalRecipients(ownRecord(me)),
  });
  assert.equal(ring.originOf(PSP, rot.epoch).how, 'local');
});

test('C1 in miniature: the four sender kinds against one free slot, both spaces', async () => {
  // One cell from each row of `crypto-domains.js`'s C1 sender axis, kept here so the unit suite
  // fails too when the property suite is not what someone is running.
  const me = await makeMember(2);
  const peer = await makeMember();
  const outsider = await makeMember();
  const throwaway = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  const myPub = await identity.importKexPublic(me.devices[0].kexPubRaw);
  const myPriv = me.devices[0].devKex.privateKey;

  const wrapFrom = async (priv, space, epoch) =>
    sk.wrapSpaceKey(await sk.createSpaceKey(), priv, myPub, { spaceId: space, epoch });

  for (const [space, senders, entitled] of [
    [FSP, sk.familyRecipients([memberRecord(me), memberRecord(peer)]), ['member', 'myself']],
    [PSP, sk.personalRecipients(ownRecord(me)), ['member', 'myself']],
  ]) {
    const kinds = {
      // `member` — the CONTROL. In the family space that is the peer; in the personal space it is
      // my own second Mac. If this ever refuses, every refusal below is vacuous.
      member: space === FSP
        ? { priv: peer.devices[0].devKex.privateKey, declared: peer.devices[0].kexPubRaw }
        : { priv: me.devices[1].devKex.privateKey, declared: me.devices[1].kexPubRaw },
      myself: { priv: myPriv, declared: me.devices[0].kexPubRaw },
      'other-member': { priv: outsider.devices[0].devKex.privateKey, declared: outsider.devices[0].kexPubRaw },
      unattested: { priv: throwaway.privateKey, declared: new Uint8Array(await S.exportKey('raw', throwaway.publicKey)) },
      absent: { priv: throwaway.privateKey, declared: undefined },
      malformed: { priv: throwaway.privateKey, declared: 'nicht-ein-punkt!!' },
    };
    let epoch = 1;
    for (const [name, spec] of Object.entries(kinds)) {
      const row = { epoch, wrapped: await wrapFrom(spec.priv, space, epoch) };
      if (spec.declared !== undefined) row.senderKexPubRaw = spec.declared;
      const ring = sk.createKeyRing();
      const rep = await sk.admitWraps(ring, [row], { spaceId: space, myKexPriv: myPriv, senders });
      if (entitled.includes(name)) {
        assert.deepEqual(rep.admitted, [epoch], `${space} / ${name} must be ADMITTED`);
        assert.equal(ring.originOf(space, epoch).how, 'admitted');
      } else {
        assert.deepEqual(rep.admitted, [], `${space} / ${name} must be REFUSED`);
        assert.equal(rep.unauthorized, 1, `${space} / ${name} must be UNAUTHORIZED, not merely unopenable`);
        assert.equal(ring.get(space, epoch), null);
      }
      epoch += 1;
    }
  }
});

test('a slot the ring ALREADY holds is a duplicate whoever sent the row — first-write-wins decides first', async () => {
  // C1's `held` cells. The `ring.has` short-circuit runs BEFORE the sender check and must: two
  // member devices both wrapping the same epoch to a joiner is D9's ordinary case (§7.1 step 4),
  // and an unauthenticated row at an occupied slot could not change the answer anyway.
  const me = await makeMember();
  const peer = await makeMember();
  const throwaway = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  const myPub = await identity.importKexPublic(me.devices[0].kexPubRaw);

  const held = await sk.createSpaceKey();
  const ring = sk.createKeyRing();
  ring.put(FSP, 4, held);

  const rep = await sk.admitWraps(ring, [{
    epoch: 4,
    wrapped: await sk.wrapSpaceKey(await sk.createSpaceKey(), throwaway.privateKey, myPub, { spaceId: FSP, epoch: 4 }),
    senderKexPubRaw: b64u(new Uint8Array(await S.exportKey('raw', throwaway.publicKey))),
  }], {
    spaceId: FSP, myKexPriv: me.devices[0].devKex.privateKey,
    senders: sk.familyRecipients([memberRecord(peer)]),
  });
  assert.deepEqual(rep, { admitted: [], refused: 0, duplicates: 1, unauthorized: 0, unauthorizedEpochs: [] });
  const rawAes = async (k) => b64u(new Uint8Array(await S.exportKey('raw', k)));
  assert.equal(await rawAes(ring.get(FSP, 4)), await rawAes(held), 'the key already decrypting ops is untouched');
  assert.deepEqual(ring.originOf(FSP, 4), { how: 'local', deviceId: null, memberId: null });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. ALL EPOCHS — Oma's birthday (A4, story 17.1, risk R11)
// ═════════════════════════════════════════════════════════════════════════════

test('a wrap covering only the current epoch is REFUSED, and the missing epochs are named', async () => {
  const A = await makeMember();
  const B = await makeMember();
  const fam = sk.familyRecipients([memberRecord(B)]);
  const keys = new Map([[5, await sk.createSpaceKey()]]);
  await assert.rejects(
    () => sk.wrapRingToRecipients(keys, A.devices[0].devKex.privateKey, fam, { spaceId: FSP, upTo: 5 }),
    /epochs \[1, 2, 3, 4\] of 1\.\.5 are missing/
  );
  // A gap in the middle is caught too — the failure it causes is "three years of entries silently
  // never render", which no error message would otherwise ever be printed for.
  for (const e of [1, 2, 4, 5]) keys.set(e, await sk.createSpaceKey());
  await assert.rejects(() => sk.wrapRingToRecipients(keys, A.devices[0].devKex.privateKey, fam, { spaceId: FSP, upTo: 5 }), /\[3\]/);
});

test("A4: a joiner who arrives in epoch 7 can still read Oma's birthday, entered in epoch 1", async () => {
  const oldTimer = await makeMember();
  const joiner = await makeMember();
  const ring = sk.createKeyRing();
  const fam = sk.familyRecipients([memberRecord(oldTimer)]);

  // Seven epochs of history, one entry each.
  const entries = [];
  for (let e = 1; e <= 7; e++) {
    const rot = await sk.rotateSpace({ ring, spaceId: FSP, myKexPriv: oldTimer.devices[0].devKex.privateKey, recipients: fam });
    assert.equal(rot.epoch, e);
    entries.push(await sealUnder(rot.key, hdrFor(FSP, e, 'ALT0000000000000'), e === 1 ? 'Omas Geburtstag' : `Eintrag ${e}`));
  }

  // Mom joins. D9: no key material came with her invite. Any existing member device delivers.
  const joinerRecipients = sk.familyRecipients([memberRecord(joiner)]);
  const wraps = await sk.wrapRingTo(ring, FSP, oldTimer.devices[0].devKex.privateKey, joinerRecipients);
  assert.deepEqual([...new Set(wraps.map((w) => w.epoch))].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7], 'ALL epochs, not just the current one');

  const herRing = sk.createKeyRing();
  const senderPubRaw = oldTimer.devices[0].kexPubRaw;
  const admitted = await sk.admitWraps(
    herRing,
    wraps.map((w) => ({ epoch: w.epoch, wrapped: w.wrapped, senderKexPubRaw: senderPubRaw })),
    // S1: the delivering device is named, not assumed. Mom's first family sync is §7.1 step 6 —
    // she cannot fold the family stream yet, so this roster is the relay's coordination data and
    // every attestation in it is verified by `admissibleSenders` before a byte is derived.
    { spaceId: FSP, myKexPriv: joiner.devices[0].devKex.privateKey, senders: sk.familyRecipients([memberRecord(oldTimer)]) }
  );
  assert.deepEqual(admitted.admitted, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(admitted.refused, 0);

  assert.equal(await openUnder(herRing.get(FSP, 1), entries[0]), 'Omas Geburtstag', 'the killer feature');
  for (let e = 1; e <= 7; e++) {
    assert.equal(await openUnder(herRing.get(FSP, e), entries[e - 1]), e === 1 ? 'Omas Geburtstag' : `Eintrag ${e}`);
  }
});

test('wrapRingTo refuses to deliver a ring this device does not hold', async () => {
  const A = await makeMember();
  const B = await makeMember();
  await assert.rejects(
    () => sk.wrapRingTo(sk.createKeyRing(), FSP, A.devices[0].devKex.privateKey, sk.familyRecipients([memberRecord(B)])),
    /holds no key/
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. ROTATION, END TO END — the scenario LZP-303 was written for
// ═════════════════════════════════════════════════════════════════════════════

test('3 members · rotate · remove one · rotate: the removed member opens epoch e and NOT e+1', async () => {
  const mama = await makeMember(2);   // two Macs, so the multi-device case is exercised too
  const papa = await makeMember();
  const oma = await makeMember();
  const priv = mama.devices[0].devKex.privateKey;   // Mama happens to be the admin. Nothing here knows that.

  const ring = sk.createKeyRing();
  const all = () => sk.familyRecipients([memberRecord(mama), memberRecord(papa), memberRecord(oma)]);

  // ── epoch 1: three members ────────────────────────────────────────────────
  const e1 = await sk.rotateSpace({ ring, spaceId: FSP, myKexPriv: priv, recipients: all() });
  assert.equal(e1.epoch, 1);
  assert.equal(e1.coveredDevices.length, 4, 'Mama x2, Papa, Oma');

  // ── epoch 2: a second, ordinary rotation ──────────────────────────────────
  const e2 = await sk.rotateSpace({ ring, spaceId: FSP, myKexPriv: priv, recipients: all() });
  assert.equal(e2.epoch, 2);
  assert.deepEqual([...new Set(e2.wraps.map((w) => w.epoch))].sort(), [1, 2], 'a rotation re-delivers the WHOLE ring');

  const beforeRemoval = await sealUnder(ring.get(FSP, 2), hdrFor(FSP, 2, 'VOR00000000000000'.slice(0, 16)), 'Schwimmen Samstag');

  // ── Oma is removed. Rotation is MANDATORY (§4.1) and it is what T2 rests on. ──
  assert.equal(sk.rotatesOn('member.remove').rotate, true);
  const remaining = () => sk.familyRecipients([
    memberRecord(mama), memberRecord(papa), memberRecord(oma, { removedAt: '2026-08-27' }),
  ]);
  const e3 = await sk.rotateSpace({ ring, spaceId: FSP, myKexPriv: priv, recipients: remaining() });
  assert.equal(e3.epoch, 3);

  const omaDevice = oma.devices[0].deviceId;
  assert.equal(e3.coveredDevices.includes(omaDevice), false, "the removed member's devices receive NOTHING further");
  assert.deepEqual(e3.coveredDevices.sort(), [...mama.devices.map((d) => d.deviceId), papa.devices[0].deviceId].sort());
  assert.deepEqual([...new Set(e3.wraps.map((w) => w.epoch))].sort(), [1, 2, 3], 'and the remaining members get every epoch');

  const afterRemoval = await sealUnder(ring.get(FSP, 3), hdrFor(FSP, 3, 'NACH0000000000000'.slice(0, 16)), 'Neuer Plan');

  // ── what each party can now open ──────────────────────────────────────────
  const rebuild = async (member, deviceIx, rotation) => {
    const r = sk.createKeyRing();
    const rows = rotation.wraps
      .filter((w) => w.deviceId === member.devices[deviceIx].deviceId)
      .map((w) => ({ epoch: w.epoch, wrapped: w.wrapped, senderKexPubRaw: mama.devices[0].kexPubRaw }));
    await sk.admitWraps(r, rows, {
      spaceId: FSP, myKexPriv: member.devices[deviceIx].devKex.privateKey, senders: all(),
    });
    return r;
  };

  // Oma's ring is what she held at the moment she was removed: epochs 1 and 2, from rotation e2.
  const omaRing = await rebuild(oma, 0, e2);
  assert.deepEqual(omaRing.epochs(FSP), [1, 2]);
  assert.equal(await openUnder(omaRing.get(FSP, 2), beforeRemoval), 'Schwimmen Samstag', 'epoch e still opens — she already had that key');
  assert.equal(omaRing.get(FSP, 3), null, 'and there is no epoch e+1 in her ring at all');
  // Even holding the ciphertext, every key she has fails against it. This is T2, mechanically.
  for (const e of omaRing.epochs(FSP)) {
    await assert.rejects(() => openUnder(omaRing.get(FSP, e), afterRemoval), `epoch ${e} must not open a post-removal op`);
  }

  // Every remaining member opens BOTH.
  for (const [member, ix] of [[mama, 0], [mama, 1], [papa, 0]]) {
    const r = await rebuild(member, ix, e3);
    assert.deepEqual(r.epochs(FSP), [1, 2, 3], `${member === mama ? 'mama' : 'papa'}#${ix} holds the whole ring`);
    assert.equal(await openUnder(r.get(FSP, 2), beforeRemoval), 'Schwimmen Samstag');
    assert.equal(await openUnder(r.get(FSP, 3), afterRemoval), 'Neuer Plan');
  }
});

test('UNSHARING IS NOT UNREMEMBERING — the removed member keeps every op she had already pulled', async () => {
  // Addendum §6, ADR 002 §8.1. This is asserted, not merely written down, because the removal
  // confirmation copy (deliverable 22, §7.4) is written FROM it:
  //   „Ab jetzt sieht Mama nichts Neues mehr. Was ihr Mac schon geladen hat, bleibt auf ihrem
  //    Mac — geteilt ist geteilt."
  // If this test ever went red, that string would have become a lie in the other direction, and
  // the UI would be free to say „gelöscht bei allen", which the crypto cannot deliver.
  const admin = await makeMember();
  const leaving = await makeMember();
  const ring = sk.createKeyRing();
  const priv = admin.devices[0].devKex.privateKey;

  const both = sk.familyRecipients([memberRecord(admin), memberRecord(leaving)]);
  const e1 = await sk.rotateSpace({ ring, spaceId: FSP, myKexPriv: priv, recipients: both });
  const history = [];
  for (const t of ['Omas Geburtstag', 'Sommerferien', 'Zahnarzt Papa']) {
    history.push(await sealUnder(e1.key, hdrFor(FSP, 1, 'HIST000000000000'), t));
  }

  const herRing = sk.createKeyRing();
  await sk.admitWraps(
    herRing,
    e1.wraps.filter((w) => w.deviceId === leaving.devices[0].deviceId)
      .map((w) => ({ epoch: w.epoch, wrapped: w.wrapped, senderKexPubRaw: admin.devices[0].kexPubRaw })),
    { spaceId: FSP, myKexPriv: leaving.devices[0].devKex.privateKey, senders: both }
  );

  await sk.rotateSpace({
    ring, spaceId: FSP, myKexPriv: priv,
    recipients: sk.familyRecipients([memberRecord(admin), memberRecord(leaving, { removedAt: DAY })]),
  });

  // Rotation reaches the relay. It does not reach her disk.
  for (const [i, env] of history.entries()) {
    assert.equal(await openUnder(herRing.get(FSP, 1), env), ['Omas Geburtstag', 'Sommerferien', 'Zahnarzt Papa'][i]);
  }
  assert.equal(herRing.currentEpoch(FSP), 1, 'she is stuck at the epoch she held — and keeps it forever');
});

test('every membership change rotates; an unlisted event THROWS rather than defaulting to "no"', () => {
  for (const e of ['member.join', 'member.remove', 'member.leave']) {
    assert.deepEqual([sk.rotatesOn(e).rotate, sk.rotatesOn(e).space], [true, 'family'], e);
  }
  for (const e of ['device.pair', 'device.unpair']) {
    assert.deepEqual([sk.rotatesOn(e).rotate, sk.rotatesOn(e).space], [true, 'personal'], e);
  }
  for (const e of ['admin.transfer', 'space.rename', 'profile.edit']) {
    assert.deepEqual([sk.rotatesOn(e).rotate, sk.rotatesOn(e).space], [false, null], e);
  }
  // A `false` default for an unlisted event would be a silent security downgrade that no test
  // would catch — every future membership event would quietly stop rotating.
  for (const e of ['member.suspend', 'MEMBER.REMOVE', '', 'toString', 'constructor', undefined]) {
    assert.throws(() => sk.rotatesOn(e), /not one of ADR 002 §4.1's rotation triggers/);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. PO DECISION D9 — admission and key delivery are separate
// ═════════════════════════════════════════════════════════════════════════════

test('D9: ANY existing member device delivers the ring — nothing here takes a role or an admin id', async () => {
  const admin = await makeMember();
  const papa = await makeMember();        // an ordinary member. Not the admin. Asleep? No.
  const joiner = await makeMember();

  const ring = sk.createKeyRing();
  const seed = sk.familyRecipients([memberRecord(admin), memberRecord(papa)]);
  const e1 = await sk.rotateSpace({ ring, spaceId: FSP, myKexPriv: admin.devices[0].devKex.privateKey, recipients: seed });
  const entry = await sealUnder(e1.key, hdrFor(FSP, 1, 'FRUEH00000000000'), 'Omas Geburtstag');

  // Papa's Mac holds the ring too — he was a recipient of the rotation.
  const papaRing = sk.createKeyRing();
  await sk.admitWraps(
    papaRing,
    e1.wraps.filter((w) => w.deviceId === papa.devices[0].deviceId)
      .map((w) => ({ epoch: w.epoch, wrapped: w.wrapped, senderKexPubRaw: admin.devices[0].kexPubRaw })),
    { spaceId: FSP, myKexPriv: papa.devices[0].devKex.privateKey, senders: seed }
  );

  // …so PAPA delivers, on his next ordinary sync, with the admin's laptop shut.
  const wraps = await sk.wrapRingTo(papaRing, FSP, papa.devices[0].devKex.privateKey, sk.familyRecipients([memberRecord(joiner)]));
  const herRing = sk.createKeyRing();
  await sk.admitWraps(
    herRing,
    wraps.map((w) => ({ epoch: w.epoch, wrapped: w.wrapped, senderKexPubRaw: papa.devices[0].kexPubRaw })),
    // …and PAPA is the verified sender here, not the admin. The sender set is a membership
    // question, never a role question — D9's delivery half survives S1's fix intact.
    { spaceId: FSP, myKexPriv: joiner.devices[0].devKex.privateKey, senders: sk.familyRecipients([memberRecord(papa)]) }
  );
  assert.equal(await openUnder(herRing.get(FSP, 1), entry), 'Omas Geburtstag');

  // The structural half of D9: if a role parameter ever appears in this module, delivery has been
  // quietly re-gated on one machine and story 15.3 depends on that machine being awake.
  const source = Object.keys(sk).join(' ');
  assert.equal(/admin|role|isAdmin/i.test(source), false, 'no export names a role');
});

test('D9: an invite is refreshed to the new epoch and carries NO key material — refused, not stripped', async () => {
  const A = await makeMember();
  const ring = sk.createKeyRing();
  const fam = sk.familyRecipients([memberRecord(A)]);
  await sk.rotateSpace({ ring, spaceId: FSP, myKexPriv: A.devices[0].devKex.privateKey, recipients: fam });

  const rot = await sk.rotateSpace({
    ring, spaceId: FSP, myKexPriv: A.devices[0].devKex.privateKey, recipients: fam,
    openInvites: [{ id: 'inv_1' }, { id: 'inv_2' }],
  });
  assert.deepEqual(rot.invites, [{ id: 'inv_1', epoch: 2 }, { id: 'inv_2', epoch: 2 }]);
  assert.deepEqual([...new Set(rot.invites.flatMap((i) => Object.keys(i)))].sort(), ['epoch', 'id']);

  // Stripping would hide the fact that some caller still believes in the seven-day read window
  // the PO removed. So it is a refusal.
  for (const field of ['wrappedKeys', 'wrapped', 'keys', 'epochKeys']) {
    await assert.rejects(
      () => sk.buildRotation(FSP, 1, ring.keysByEpoch(FSP), A.devices[0].devKex.privateKey, fam, [{ id: 'inv_1', [field]: 'x' }]),
      /PO decision D9/
    );
  }
  // And the retired HKDF label is still refused by name, one layer down.
  assert.throws(() => infoBytes('lzp/v2/invite/wrap'), /RETIRED by PO decision D9/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. CUSTODY — the ring behind a KeyStore port
// ═════════════════════════════════════════════════════════════════════════════

test('space keys round-trip through a KeyStore, and their ids cannot collide with an identity record', async () => {
  const ks = memKeyStore();
  const keys = new Map();
  for (const [space, epoch] of [[FSP, 1], [FSP, 2], [PSP, 1]]) {
    const k = await sk.createSpaceKey();
    keys.set(`${space}/${epoch}`, k);
    await sk.saveSpaceKey(ks, space, epoch, k);
  }
  const ring = await sk.loadKeyRing(ks);
  assert.deepEqual(ring.epochs(FSP), [1, 2]);
  assert.deepEqual(ring.epochs(PSP), [1]);
  assert.equal(ring.get(FSP, 2), keys.get(`${FSP}/2`));
  assert.deepEqual(ring.loadSkipped(), []);

  assert.equal(sk.spaceKeyRecordId(FSP, 3), `lzp/v2/space/${FSP}/3`);
  assert.deepEqual(sk.parseSpaceKeyRecordId(sk.spaceKeyRecordId(FSP, 3)), { spaceId: FSP, epoch: 3 });
  for (const bad of [...Object.values(KEYSTORE_IDS), 'lzp/v2/space/', 'lzp/v2/space/nope/1', `lzp/v2/space/${FSP}/0`, `lzp/v2/space/${FSP}`, '', null]) {
    assert.equal(sk.parseSpaceKeyRecordId(bad), null, `${bad} must not parse as a space key id`);
  }
  // An identity record sitting in the same store is invisible to `loadKeyRing`.
  await ks.put(KEYSTORE_IDS.devMeta, new Uint8Array([1, 2, 3]));
  assert.equal((await sk.loadKeyRing(ks)).size(), 3);
});

test('LZP-302 finding 8: a key that reads back as null is SKIPPED and REPORTED, not thrown on', async () => {
  // On WebKit a persisted CryptoKey is encrypted under a per-application WebCrypto master key
  // whose Keychain ACL is bound to the CODE SIGNATURE of the binary that created it. After an
  // update re-signs the bundle, previously stored keys deserialise to `null` — no error, no
  // warning, while plain values in the same database survive. Throwing here would turn that into
  // "the app will not start"; skipping turns it into "these epochs need re-wrapping", which any
  // other member device can fix (D9).
  const inner = memKeyStore();
  await sk.saveSpaceKey(inner, FSP, 1, await sk.createSpaceKey());
  await sk.saveSpaceKey(inner, FSP, 2, await sk.createSpaceKey());
  const lossy = { ...inner, get: async (id) => (id.endsWith('/1') ? null : inner.get(id)) };

  const ring = await sk.loadKeyRing(lossy);
  assert.deepEqual(ring.epochs(FSP), [2]);
  assert.deepEqual(ring.loadSkipped(), [`lzp/v2/space/${FSP}/1`]);
  assert.equal(ring.get(FSP, 1), null, 'and the gap is a park, not a wrong key');
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. WHAT LZP-303 DOES *NOT* CLOSE — characterized so it cannot be re-planned away
// ═════════════════════════════════════════════════════════════════════════════

test('OPEN: no wire field carries another member\'s RK_kex, so family rotation wraps to devices only', async () => {
  // ADR 002 §4.2 step 2 says a rotation wraps "plus each member's RK_kex". `MemberRowDb`
  // (server.contract.js §4) holds `recoveryPubSig` and NOTHING ELSE, and the `dev.*` attestations
  // cover DEVICE keys. Wrapping a family key to an unauthenticated public key someone hands you
  // is precisely the key-injection channel closed above, so `familyRecipients` refuses to invent
  // the field and REPORTS the gap instead. This row exists so the omission is a known, owned gap
  // rather than a silent deviation from the ADR.
  const A = await makeMember();
  const B = await makeMember();
  const report = sk.familyRecipientsReport([memberRecord(A), memberRecord(B)]);
  assert.deepEqual(report.missingRecoveryKex.sort(), [A.memberId, B.memberId].sort());
  assert.equal(report.recipients.every((r) => r.role === 'device'), true, 'no recovery recipient in the family scope');

  // The personal space has no such gap: my own RK_kex is mine, held locally, never off the wire.
  assert.equal(sk.personalRecipients(ownRecord(A)).some((r) => r.role === 'recovery'), true);
});

test('OPEN (ADR 002 §8.5): there is NO key transparency — a phantom member receives the family key', async () => {
  // A malicious admin (or a relay that fabricates a member row) adds a member nobody knows. Their
  // attestation is self-signed under their own recovery key and verifies perfectly, because that
  // is all an attestation claims. Nothing in this file can tell a phantom from Oma, and nothing
  // downstream may be built as though it can. The mitigations are the member list (15.4) and the
  // per-member device count, both of which are UI, and §8.5 says so.
  const phantom = await makeMember();
  const key = await sk.createSpaceKey();
  const real = await makeMember();
  const recipients = sk.familyRecipients([memberRecord(real), memberRecord(phantom)]);
  const wraps = await sk.wrapToRecipients(key, real.devices[0].devKex.privateKey, recipients, { spaceId: FSP, epoch: 1 });
  const got = await sk.unwrapSpaceKey(
    wraps.find((w) => w.deviceId === phantom.devices[0].deviceId).wrapped,
    phantom.devices[0].devKex.privateKey,
    await identity.importKexPublic(real.devices[0].kexPubRaw),
    { spaceId: FSP, epoch: 1 }
  );
  assert.notEqual(got, null, 'the phantom gets the key — this is §8.5, and it is not a bug in this file');
  assert.equal(await sk.recipientProblem(recipients[1]), null, 'their attestation verifies; that is all it ever claimed');
});

test('OPEN (ADR 002 §8.9): no forward secrecy within an epoch — one leaked FSK_e opens all of epoch e', async () => {
  // Membership-triggered rotation is the coarsest possible ratchet, and that is the stated trade.
  // A family that never changes membership runs one key for ever, and every op of that epoch —
  // past and future — falls to it. Written down here so nobody discovers it as a surprise.
  const A = await makeMember();
  const ring = sk.createKeyRing();
  const rot = await sk.rotateSpace({ ring, spaceId: FSP, myKexPriv: A.devices[0].devKex.privateKey, recipients: sk.familyRecipients([memberRecord(A)]) });
  const early = await sealUnder(rot.key, hdrFor(FSP, 1, 'A000000000000000'), 'Januar');
  const late = await sealUnder(rot.key, hdrFor(FSP, 1, 'A000000000000000'), 'Dezember');
  const leaked = await S.importKey('raw', await S.exportKey('raw', rot.key), { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  assert.equal(await openUnder(leaked, early), 'Januar');
  assert.equal(await openUnder(leaked, late), 'Dezember');
  assert.equal(ring.currentEpoch(FSP), 1, 'and no rotation happened, because no membership changed');
});

test('the exported surface is exactly what crypto.contract.js §3 names, plus what §3 could not express', () => {
  // The contract's `wrapSpaceKey(spaceKey, myKexPriv, theirKexPub)` has no space and no epoch,
  // so it has nothing to put in the AAD and barrier 3 does not exist. The fourth argument is
  // MANDATORY here and the deviation is deliberate and reported.
  for (const name of ['createSpaceKey', 'wrapSpaceKey', 'unwrapSpaceKey', 'personalRecipients',
    'familyRecipients', 'wrapToRecipients', 'loadKeyRing', 'buildRotation',
    // Added to the contract 2026-08-28 with finding S1 — §4.2 step 6's receiving-side check.
    'admissibleSenders', 'isSenderSet']) {
    assert.equal(typeof sk[name], 'function', `crypto.contract.js §3 names ${name}`);
  }
  assert.equal(sk.wrapSpaceKey.length, 4, 'the {spaceId, epoch} context is a required 4th argument');
  assert.equal(sk.unwrapSpaceKey.length, 4);
  assert.equal(sk.WRAP_V, 1);
  assert.equal(sk.FIRST_EPOCH, 1);
  assert.equal(sk.SPACE_KEY_PREFIX, 'lzp/v2/space/');
  assert.equal(RAW_PUBKEY_BYTES, 65);
});
