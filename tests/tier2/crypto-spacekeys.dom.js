// TIER 2 · LZP-303 — space keys, wrapping and rotation inside the REAL WKWebView.
// ADR 002 §3, §4 · docs/v2/contracts/crypto.contract.js §3.
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE TIER-1 ONE.
// Node is a WebCrypto engine, but it is not THE engine. The shipping app runs JavaScriptCore
// inside WKWebView under `app://localhost`, and ADR 002 §1's seven rules exist because the two
// disagree in ways no compat table records. Three claims in particular are only half-proved by
// `npm test` and are proved here:
//
//   1. **`unwrapKey` with an AES-GCM `additionalData` works in WebKit.** Every space key in the
//      product arrives through that one call. If WebKit ignored or mishandled the AAD, barrier 3
//      of §3 — the barrier story 20.5 rests on — would be a Node-only property.
//   2. **The wrap is byte-identical across the two engines.** The same known-answer vector as
//      `tests/tier1/crypto-spacekeys.test.js`, asserted here. Family sharing IS "a wrap made on
//      one Mac opens on another"; if the engines derived different KEKs from the same inputs the
//      whole tier-1 suite would be green and the product would not work.
//   3. **Rule 6's arithmetic, in this engine.** AES-KW happily wraps a 32-byte space key — which
//      is exactly why a prototype hides the bug — and refuses a 138-byte P-256 PKCS#8.
//
// It deliberately does NOT touch IndexedDB. Custody and persistence are
// `crypto-keystore-phase1.dom.js` / `-phase2.dom.js`, which need two separate launches; this file
// is about the ALGORITHMS and uses no store at all, so it can run in any order without leaving
// anything behind in the WebKit data store.
//
// NO GOLDEN SIGNATURES ANYWHERE (rule 1). The KAT below is over a WRAP, which is deterministic —
// ECDH is a scalar multiplication, HKDF a hash chain, AES-GCM a block cipher. The one
// non-deterministic primitive in the suite, ECDSA, is asserted only through `verify() === true`.

const sk = await importApp('crypto/spacekeys.js');
const identity = await importApp('crypto/identity.js');
const suite = await importApp('crypto/suite.js');
const ids = await importApp('core/ids.js');
const b64 = await importApp('core/b64.js');

const S = crypto.subtle;
const TE = new TextEncoder();
const TD = new TextDecoder();
const DAY = '2026-08-27';

const FSP = ids.spaceId('family');
const PSP = ids.spaceId('personal');

// ── the LZP-304 stand-in, identical to the tier-1 file's ─────────────────────
const opAad = (h) => TE.encode(JSON.stringify(['lzp/v2/op', h.v, h.sp, h.ep, h.dv, h.oid, h.wit]));
const hdrFor = (sp, ep, dv) => ({ v: 1, sp, ep, dv, oid: 'oid' + ep + dv, wit: '' });

async function sealUnder(spaceKey, hdr, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await S.encrypt({ name: 'AES-GCM', iv, additionalData: opAad(hdr), tagLength: 128 }, spaceKey, TE.encode(text));
  return { ...hdr, iv, ct: new Uint8Array(ct) };
}
async function openUnder(spaceKey, env) {
  const pt = await S.decrypt({ name: 'AES-GCM', iv: env.iv, additionalData: opAad(env), tagLength: 128 }, spaceKey, env.ct);
  return TD.decode(pt);
}
/** No `assert.rejects` in this harness. Returns the error name for a `diag`, never for a branch. */
async function refused(fn) {
  try { await fn(); return null; } catch (e) { return (e && e.name) || 'Error'; }
}

async function makeMember(n = 1) {
  const memberId = ids.memberId();
  const rec = await identity.generateRecoveryKeys();
  const recoveryPubSig = await identity.exportRawPublic(rec.recSig.publicKey);
  const recoveryKexPubRaw = await identity.exportRawPublic(rec.recKex.publicKey);
  const devices = [];
  for (let i = 0; i < n; i++) {
    const { devSig, devKex } = await identity.generateDeviceKeys();
    const deviceId = ids.deviceId();
    const att = await identity.buildDeviceAttestation({ memberId, deviceId, createdAt: DAY }, devSig.publicKey, devKex.publicKey);
    devices.push({
      deviceId,
      memberId,
      kexPubRaw: await identity.exportRawPublic(devKex.publicKey),
      attestation: await identity.attestDevice(att, rec.recSig.privateKey),
      devKex,
    });
  }
  return { memberId, rec, recoveryPubSig, recoveryKexPubRaw, devices };
}

const memberRecord = (m, extra = {}) => ({
  memberId: m.memberId,
  recoveryPubSig: m.recoveryPubSig,
  devices: m.devices.map((d) => ({ deviceId: d.deviceId, kexPubRaw: d.kexPubRaw, attestation: d.attestation })),
  ...extra,
});
const ownRecord = (m) => ({
  memberId: m.memberId,
  recoverySigPubRaw: m.recoveryPubSig,
  recoveryKexPubRaw: m.recoveryKexPubRaw,
  devices: m.devices.map((d) => ({ deviceId: d.deviceId, memberId: m.memberId, kexPubRaw: d.kexPubRaw, attestation: d.attestation })),
});

/**
 * Deliver every wrap addressed to one device into a fresh ring.
 *
 * `senders` is `admitWraps`' REQUIRED `ctx.senders` (finding S1): the branded, attestation-checked
 * list of devices this space will accept an epoch key FROM. It is real here, not a stub — a wrong
 * or missing one makes every call below refuse, which is what the S1 row at the end asserts.
 */
async function ringFor(wraps, device, senderKexPubRaw, spaceId, senders) {
  const ring = sk.createKeyRing();
  const rows = wraps.filter((w) => w.deviceId === device.deviceId)
    .map((w) => ({ epoch: w.epoch, wrapped: w.wrapped, senderKexPubRaw }));
  const report = await sk.admitWraps(ring, rows, { spaceId, myKexPriv: device.devKex.privateKey, senders });
  return { ring, report };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. The call shapes this module depends on, in THIS engine
// ═════════════════════════════════════════════════════════════════════════════

test('WebKit: ECDH -> HKDF -> AES-GCM wrapKey/unwrapKey round-trips WITH an AAD', async () => {
  // The one call every space key in the product arrives through. `unwrapKey` with an AES-GCM
  // `additionalData` is not exercised by anything LZP-302 shipped, and barrier 3 of ADR 002 §3
  // would be a Node-only property if this engine ignored it.
  const A = await makeMember();
  const B = await makeMember();
  const key = await sk.createSpaceKey();
  const fam = sk.familyRecipients([memberRecord(B)]);
  const [w] = await sk.wrapToRecipients(key, A.devices[0].devKex.privateKey, fam, { spaceId: FSP, epoch: 1 });

  const senderPub = await identity.importKexPublic(A.devices[0].kexPubRaw);
  const back = await sk.unwrapSpaceKey(w.wrapped, B.devices[0].devKex.privateKey, senderPub, { spaceId: FSP, epoch: 1 });
  assert.notEqual(back, null, 'the honest unwrap must succeed in WKWebView');
  assert.equal(back.algorithm.name, 'AES-GCM');
  assert.equal(back.algorithm.length, 256);
  assert.equal(back.extractable, true, 'a space key must stay re-wrappable to every future joiner');

  const raw = b64.b64u(new Uint8Array(await S.exportKey('raw', key)));
  assert.equal(b64.b64u(new Uint8Array(await S.exportKey('raw', back))), raw, 'same 32 bytes, through the wrap');
  assert.equal(JSON.stringify(w.wrapped).length, 156, 'ADR 002 §3 measured 156 B — in this engine too');
  diag('engine: ' + navigator.userAgent);
});

test('WebKit: the AAD is really enforced by unwrapKey — a wrong space or epoch yields null, not a key', async () => {
  const A = await makeMember();
  const B = await makeMember();
  const key = await sk.createSpaceKey();
  const [w] = await sk.wrapToRecipients(key, A.devices[0].devKex.privateKey, sk.familyRecipients([memberRecord(B)]), { spaceId: FSP, epoch: 2 });
  const senderPub = await identity.importKexPublic(A.devices[0].kexPubRaw);
  const priv = B.devices[0].devKex.privateKey;

  assert.notEqual(await sk.unwrapSpaceKey(w.wrapped, priv, senderPub, { spaceId: FSP, epoch: 2 }), null);
  assert.equal(await sk.unwrapSpaceKey(w.wrapped, priv, senderPub, { spaceId: PSP, epoch: 2 }), null, 'a family wrap is not a personal wrap');
  assert.equal(await sk.unwrapSpaceKey(w.wrapped, priv, senderPub, { spaceId: FSP, epoch: 1 }), null, 'wrong epoch');
  assert.equal(await sk.unwrapSpaceKey(w.wrapped, priv, senderPub, { spaceId: ids.spaceId('family'), epoch: 2 }), null, 'a different family space');
  // RULE 3: `null`, never an error name a caller could branch on. The name is only ever a diag.
  const tampered = b64.ub64(w.wrapped.ct);
  tampered[0] ^= 0xff;
  assert.equal(await sk.unwrapSpaceKey({ ...w.wrapped, ct: b64.b64u(tampered) }, priv, senderPub, { spaceId: FSP, epoch: 2 }), null);
});

test('KAT: this engine produces the SAME wrap bytes as Node — family sharing depends on it', async () => {
  // The identical vector asserted in `tests/tier1/crypto-spacekeys.test.js`. The two copies must
  // stay in sync; a reviewer can diff them. Deterministic because ECDH, HKDF and AES-GCM all are
  // — this is not a signature, and rule 1 is not in play.
  const K = {
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
  };
  // LZP-302 finding 9: a PRIVATE EC key at importKey carries only the private usages. A public
  // usage here is a SyntaxError in both engines, and it only bites on this restore path.
  const aPriv = await S.importKey('pkcs8', b64.ub64(K.aPkcs8), { name: 'ECDH', namedCurve: 'P-256' }, true, [...suite.USAGES.kexPrivate]);
  const bPub = await identity.importKexPublic(b64.ub64(K.bRaw));
  const spaceKey = await S.importKey('raw', b64.ub64(K.keyBytes), { name: 'AES-GCM', length: 256 }, true, [...suite.USAGES.aead]);
  const salt = b64.ub64(K.salt);
  const iv = b64.ub64(K.iv);
  const random = (n) => (n === 32 ? salt.slice() : iv.slice());

  const fam = await sk.wrapSpaceKey(spaceKey, aPriv, bPub, { spaceId: K.spaceIdFamily, epoch: K.epoch, random });
  const per = await sk.wrapSpaceKey(spaceKey, aPriv, bPub, { spaceId: K.spaceIdPersonal, epoch: K.epoch, random });
  assert.equal(fam.ct, K.ctFamily, 'WebKit and Node must derive the same KEK from the same inputs');
  assert.equal(per.ct, K.ctPersonal);
  assert.notEqual(fam.ct, per.ct, 'and the domain separator is in the KAT itself');
});

test('RULE 6 in this engine: AES-KW wraps a 32-byte space key and REFUSES a 138-byte PKCS#8', async () => {
  // The trap, recorded rather than remembered: this module wraps a 32-byte AES key, 32 IS a
  // multiple of 8, and AES-KW would look perfectly fine here. It is the very next thing to be
  // wrapped — §7.2's recovery PKCS#8 — that breaks. A 25519 prototype hides this entirely,
  // because 25519 PKCS#8 is 48 bytes and DOES work.
  const kek = await S.generateKey({ name: 'AES-KW', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  const spaceKey = await sk.createSpaceKey();
  const ok = await S.wrapKey('raw', spaceKey, kek, 'AES-KW');
  assert.equal(new Uint8Array(ok).byteLength, 40, 'AES-KW happily takes 32 bytes — the trap');

  const { recSig } = await identity.generateRecoveryKeys();
  const pkcs8 = new Uint8Array(await S.exportKey('pkcs8', recSig.privateKey));
  assert.equal(pkcs8.length, 138, '138 is not a multiple of 8');
  const name = await refused(() => S.wrapKey('pkcs8', recSig.privateKey, kek, 'AES-KW'));
  assert.notEqual(name, null, 'AES-KW over a P-256 private key must fail in WebKit too');
  diag('WebKit AES-KW over 138-byte PKCS#8 -> ' + name);   // recorded for the rule-3 file, never branched on
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Story 20.5, in the engine the family actually runs
// ═════════════════════════════════════════════════════════════════════════════

test('20.5 in WKWebView: a family key applied to a personal envelope FAILS', async () => {
  const psk = await sk.createSpaceKey();
  const fsk = await sk.createSpaceKey();
  const priv = await sealUnder(psk, hdrFor(PSP, 1, 'MAMA000000000000'), 'Zahnarzt 14:30 — Privat');

  assert.equal(await openUnder(psk, priv), 'Zahnarzt 14:30 — Privat');
  const wrongKey = await refused(() => openUnder(fsk, priv));
  assert.notEqual(wrongKey, null, 'the admin holding every family key gets an error, not a plaintext');
  const relabelled = await refused(() => openUnder(psk, { ...priv, sp: FSP }));
  assert.notEqual(relabelled, null, 'and `sp` is inside the AAD, so relabelling fails under the CORRECT key too');
  diag('WebKit AES-GCM wrong-key -> ' + wrongKey + ' · relabelled -> ' + relabelled);
});

test('barrier 2 in WKWebView: personalRecipients refuses a family device, and the brands do not cross', async () => {
  const me = await makeMember();
  const other = await makeMember();
  const key = await sk.createSpaceKey();

  const mine = sk.personalRecipients(ownRecord(me));
  assert.equal(mine.every((r) => sk.recipientScope(r) === 'personal'), true);
  const fam = sk.familyRecipients([memberRecord(other)]);
  assert.equal(fam.every((r) => sk.recipientScope(r) === 'family'), true);

  const foreign = await refused(async () => sk.personalRecipients({
    ...ownRecord(me),
    devices: [{ deviceId: other.devices[0].deviceId, memberId: other.memberId, kexPubRaw: other.devices[0].kexPubRaw, attestation: other.devices[0].attestation }],
  }));
  assert.notEqual(foreign, null, 'ADR 002 §11 rule 10: the personal path can never take a family list');
  const crossed = await refused(() => sk.wrapToRecipients(key, me.devices[0].devKex.privateKey, mine, { spaceId: FSP, epoch: 1 }));
  assert.notEqual(crossed, null, 'a personal recipient cannot receive a family key');
  const unbranded = await refused(() => sk.wrapToRecipients(key, me.devices[0].devKex.privateKey, [{ ...fam[0] }], { spaceId: FSP, epoch: 1 }));
  assert.notEqual(unbranded, null, 'and a spread copy loses the non-enumerable brand');
});

test('key injection in WKWebView: an attestation naming a DIFFERENT agreement key is refused', async () => {
  const A = await makeMember();
  const attacker = await makeMember();
  const rec = memberRecord(A);
  const injected = sk.familyRecipients([{ ...rec, devices: [{ ...rec.devices[0], kexPubRaw: attacker.devices[0].kexPubRaw }] }]);
  const problem = await sk.recipientProblem(injected[0]);
  assert.match(problem, /DIFFERENT agreement key/);

  // The honest recipient, in the same engine, verifies.
  assert.equal(await sk.recipientProblem(sk.familyRecipients([rec])[0]), null);
});

test('S1 in WKWebView: an unauthenticated sender cannot put a key into either ring', async () => {
  // FINDING S1, in the engine the family actually runs. Until 2026-08-28 `admitWraps` derived its
  // KEK from `row.senderKexPubRaw` — the relay's own JSON — so one throwaway ECDH keypair put a
  // key of the attacker's choosing into the victim's ring and the victim sealed its Privat entries
  // under it. This row is not a Node property: `admissibleSenders` runs an ECDSA P-256 verify over
  // every attestation and a raw public-key import with `keyUsages: []` (rule 5) before a single
  // byte is derived, and both are §1 rules precisely because the two engines disagree about them.
  const me = await makeMember(2);            // my Mac, and my own second Mac
  const mama = await makeMember();           // a real, attested, current member of the Kreis
  const V = me.devices[0];
  const myKexPub = await identity.importKexPublic(V.kexPubRaw);
  const attacker = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  const attackerRaw = new Uint8Array(await S.exportKey('raw', attacker.publicKey));

  // The personal space, which is what story 20.5 is about. Its sender set is MY OWN devices, and
  // `personalRecipients` refuses to build any other kind.
  const ctx = {
    spaceId: PSP,
    myKexPriv: V.devKex.privateKey,
    senders: sk.personalRecipients(ownRecord(me)),
  };
  const ring = sk.createKeyRing();
  const report = await sk.admitWraps(ring, [
    { epoch: 2,
      wrapped: await sk.wrapSpaceKey(await sk.createSpaceKey(), attacker.privateKey, myKexPub, { spaceId: PSP, epoch: 2 }),
      senderKexPubRaw: b64.b64u(attackerRaw) },
    { epoch: 3,
      wrapped: await sk.wrapSpaceKey(await sk.createSpaceKey(), mama.devices[0].devKex.privateKey, myKexPub, { spaceId: PSP, epoch: 3 }),
      senderKexPubRaw: mama.devices[0].kexPubRaw },
  ], ctx);
  assert.deepEqual(report.admitted, [], 'neither a stranger nor an attested fellow member reaches my Privat ring');
  assert.equal(report.unauthorized, 2);
  assert.equal(ring.size(), 0);

  // My own second Mac IS admitted, so the refusal above is a decision and not a broken engine.
  const psk = await sk.createSpaceKey();
  const mine = await sk.admitWraps(ring, [{
    epoch: 2,
    wrapped: await sk.wrapSpaceKey(psk, me.devices[1].devKex.privateKey, myKexPub, { spaceId: PSP, epoch: 2 }),
    senderKexPubRaw: me.devices[1].kexPubRaw,
  }], ctx);
  assert.deepEqual(mine.admitted, [2]);
  assert.equal(ring.originOf(PSP, 2).deviceId, me.devices[1].deviceId, 'and the ring names who delivered it');

  // The whole entry, round-tripped under the key that was actually admitted.
  const env = await sealUnder(ring.get(PSP, 2), hdrFor(PSP, 2, 'PRIV000000000000'), 'Zahnarzt 14:30 — Privat');
  assert.equal(await openUnder(ring.get(PSP, 2), env), 'Zahnarzt 14:30 — Privat');

  // And the family space, same engine, same refusal: an unattested sender is nobody there either.
  const fsp = await sk.admitWraps(sk.createKeyRing(), [{
    epoch: 1,
    wrapped: await sk.wrapSpaceKey(await sk.createSpaceKey(), attacker.privateKey, myKexPub, { spaceId: FSP, epoch: 1 }),
    senderKexPubRaw: b64.b64u(attackerRaw),
  }], { spaceId: FSP, myKexPriv: V.devKex.privateKey, senders: sk.familyRecipients([memberRecord(mama), memberRecord(me)]) });
  assert.deepEqual(fsp.admitted, []);
  assert.equal(fsp.unauthorized, 1);

  // A check that can be skipped is not a check: omitting the set throws in this engine too.
  const omitted = await refused(() => sk.admitWraps(sk.createKeyRing(), [], { spaceId: PSP, myKexPriv: V.devKex.privateKey }));
  assert.notEqual(omitted, null, '`ctx.senders` has no default');
  diag('WebKit admitWraps without ctx.senders -> ' + omitted);
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Rotation, end to end, in the real engine
// ═════════════════════════════════════════════════════════════════════════════

test('3 members · rotate · remove one · rotate — in WKWebView: e opens, e+1 does not', async () => {
  const mama = await makeMember(2);
  const papa = await makeMember();
  const oma = await makeMember();
  const priv = mama.devices[0].devKex.privateKey;
  const senderPub = mama.devices[0].kexPubRaw;
  const ring = sk.createKeyRing();
  const all = () => sk.familyRecipients([memberRecord(mama), memberRecord(papa), memberRecord(oma)]);

  await sk.rotateSpace({ ring, spaceId: FSP, myKexPriv: priv, recipients: all() });
  const e2 = await sk.rotateSpace({ ring, spaceId: FSP, myKexPriv: priv, recipients: all() });
  assert.equal(e2.epoch, 2);
  const before = await sealUnder(ring.get(FSP, 2), hdrFor(FSP, 2, 'VOR0000000000000'), 'Schwimmen Samstag');

  assert.equal(sk.rotatesOn('member.remove').rotate, true, 'removal ALWAYS rotates (ADR 002 §4.1)');
  const e3 = await sk.rotateSpace({
    ring, spaceId: FSP, myKexPriv: priv,
    recipients: sk.familyRecipients([memberRecord(mama), memberRecord(papa), memberRecord(oma, { removedAt: DAY })]),
  });
  assert.equal(e3.coveredDevices.includes(oma.devices[0].deviceId), false, 'the removed member receives nothing further');
  const after = await sealUnder(ring.get(FSP, 3), hdrFor(FSP, 3, 'NACH000000000000'), 'Neuer Plan');

  // Oma's ring is what she held at removal: epochs 1 and 2.
  const omaSide = await ringFor(e2.wraps, oma.devices[0], senderPub, FSP, all());
  assert.deepEqual(omaSide.ring.epochs(FSP), [1, 2]);
  assert.equal(await openUnder(omaSide.ring.get(FSP, 2), before), 'Schwimmen Samstag', 'epoch e still opens — she already had that key');
  assert.equal(omaSide.ring.get(FSP, 3), null, 'and epoch e+1 is not in her ring at all');
  const stillClosed = await refused(() => openUnder(omaSide.ring.get(FSP, 2), after));
  assert.notEqual(stillClosed, null, 'T2: no key she holds opens a post-removal op');

  for (const d of [mama.devices[0], mama.devices[1], papa.devices[0]]) {
    const side = await ringFor(e3.wraps, d, senderPub, FSP, all());
    assert.deepEqual(side.ring.epochs(FSP), [1, 2, 3], 'every remaining member holds the whole ring');
    assert.equal(await openUnder(side.ring.get(FSP, 2), before), 'Schwimmen Samstag');
    assert.equal(await openUnder(side.ring.get(FSP, 3), after), 'Neuer Plan');
  }
});

test("A4 in WKWebView: a joiner delivered by an ORDINARY member reads Oma's birthday from epoch 1", async () => {
  // D9's delivery half, in the real engine: the admin's Mac is shut and Papa's is not.
  const admin = await makeMember();
  const papa = await makeMember();
  const joiner = await makeMember();
  const ring = sk.createKeyRing();
  const seed = () => sk.familyRecipients([memberRecord(admin), memberRecord(papa)]);

  const entries = [];
  for (let e = 1; e <= 4; e++) {
    const rot = await sk.rotateSpace({ ring, spaceId: FSP, myKexPriv: admin.devices[0].devKex.privateKey, recipients: seed() });
    entries.push(await sealUnder(rot.key, hdrFor(FSP, e, 'ALT0000000000000'), e === 1 ? 'Omas Geburtstag' : 'Eintrag ' + e));
  }
  const last = await sk.buildRotation(FSP, 4, ring.keysByEpoch(FSP), admin.devices[0].devKex.privateKey, seed(), []);
  const papaSide = await ringFor(last.wraps, papa.devices[0], admin.devices[0].kexPubRaw, FSP, seed());
  assert.deepEqual(papaSide.ring.epochs(FSP), [1, 2, 3, 4]);

  const wraps = await sk.wrapRingTo(papaSide.ring, FSP, papa.devices[0].devKex.privateKey, sk.familyRecipients([memberRecord(joiner)]));
  const herSide = await ringFor(wraps, joiner.devices[0], papa.devices[0].kexPubRaw, FSP, sk.familyRecipients([memberRecord(papa)]));
  assert.deepEqual(herSide.report.admitted, [1, 2, 3, 4], 'ALL epochs, not just the current one (A4, 17.1, R11)');
  assert.equal(herSide.report.refused, 0);
  assert.equal(await openUnder(herSide.ring.get(FSP, 1), entries[0]), 'Omas Geburtstag');
  assert.equal(await openUnder(herSide.ring.get(FSP, 4), entries[3]), 'Eintrag 4');
});

test('a wrap covering only the current epoch is REFUSED in this engine too', async () => {
  const A = await makeMember();
  const B = await makeMember();
  const keys = new Map([[3, await sk.createSpaceKey()]]);
  let message = null;
  try {
    await sk.wrapRingToRecipients(keys, A.devices[0].devKex.privateKey, sk.familyRecipients([memberRecord(B)]), { spaceId: FSP, upTo: 3 });
  } catch (e) { message = e.message; }
  assert.match(message, /epochs \[1, 2\] of 1\.\.3 are missing/);
});

test('the KeyRing keeps the two spaces apart and refuses a substituted epoch key', async () => {
  const ring = sk.createKeyRing();
  const psk = await sk.createSpaceKey();
  const fsk = await sk.createSpaceKey();
  ring.put(PSP, 1, psk);
  ring.put(FSP, 1, fsk);
  assert.equal(ring.get(PSP, 1), psk);
  assert.notEqual(ring.get(FSP, 1), psk, 'a personal key is never returned for a family lookup');

  assert.equal(ring.put(FSP, 1, await sk.createSpaceKey()), false, 'first write wins');
  assert.equal(ring.get(FSP, 1), fsk);
  assert.equal(ring.refusedPuts(), 1);
  // Peer data: `get` is total, so a hostile `env.sp` parks rather than crashing the sync pass.
  assert.equal(ring.get('nonsense', 1), null);
  assert.equal(ring.get(FSP, 0), null);
});
