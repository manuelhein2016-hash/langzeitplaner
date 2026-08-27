// TIER 2 · LZP-306 — device pairing inside the REAL WKWebView.  ADR 002 §6 · story 19.5.
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE TIER-1 ONE.
// Node is a WebCrypto engine but it is not THE engine. Pairing reaches four corners of WebCrypto
// that ADR 002 §1's rule table exists precisely because the two engines disagree about, and three
// of the four are on the RESTORE path — the path a developer exercises last and a user exercises
// once, on the day they buy a second Mac:
//
//   · `deriveBits` over ECDH P-256, then HKDF over a 162-byte IKM        (the SAS)
//   · `importKey('pkcs8', …)` of a PRIVATE EC key                        (engine difference 9)
//   · `importKey('jwk', …)` of a public half rebuilt from a private one  (`recPublicOf`)
//   · `importKey('raw', …, [])` of a peer's ephemeral ECDH point         (rule 5)
//
// A bug in any of them is invisible in `npm test` and permanent in the product: the second Mac
// simply never works, or worse, works for everything except the one operation nobody tried.
//
// THE CROSS-ENGINE VECTORS AT THE TOP ARE THE POINT OF THE FILE. HKDF is deterministic, so a
// `rid` and a SAS really are functions of their inputs in a way a signature is not (rule 1). If
// Node and WebKit ever disagreed about one, a Mac would derive a rendezvous its own second Mac
// could not find, or two screens would show different digits with no attacker present — and that
// failure looks exactly like a MITM, which is the worst possible thing for it to look like.
//
// It does not touch IndexedDB: custody is `crypto-keystore-phase1/2.dom.js`'s subject, and this
// file uses the memory store so it can run in any order and leave nothing behind.

const pairing = await importApp('crypto/pairing.js');
const identity = await importApp('crypto/identity.js');
const suite = await importApp('crypto/suite.js');
const spacekeys = await importApp('crypto/spacekeys.js');
const keystore = await importApp('platform/keystore.js');
const ids = await importApp('core/ids.js');
const b64 = await importApp('core/b64.js');
const canon = await importApp('core/canon.js');

const S = crypto.subtle;
const DAY = '2026-08-27';

/** The same numbers `tests/tier1/crypto-pairing.test.js` pins, restated so the two files can be
 *  compared by eye without loading either. Both tiers assert them against the same source. */
const VECTORS = {
  rid: [
    ['ABCDEFGHJKMN', 'h1S6avvkKU_1V9DJV6Fv4w'],
    ['00000000000Z', '5PkqkyauZBFPiC-G60V3Xg'],
    ['ZZZZZZZZZZZZ', 'sGw_n7h8hoTQoQrsOQmPYQ'],
  ],
  sas: '550092',
  sasRolesSwapped: '966447',
};

function clock(start = 1700000000000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

async function aesKey() {
  return S.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

async function existingMember(epochs = 2) {
  const ks = keystore.memKeyStore();
  const memberId = ids.memberId();
  const rec = await identity.ensureRecoveryIdentity(ks, memberId, { createdAt: DAY });
  const dev = await identity.ensureDeviceIdentity(ks, memberId, { deviceId: ids.deviceId(), createdAt: DAY });
  const spaceId = ids.spaceId('personal');
  const map = new Map();
  for (let e = 1; e <= epochs; e++) map.set(e, await aesKey());
  return {
    memberId, rec, spaceId,
    identity: { ...dev, recSig: rec.recSig, recKex: rec.recKex },
    keyring: { personal: { spaceId, epochs: map }, family: null },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. The vectors — the reason this file exists
// ═════════════════════════════════════════════════════════════════════════════

test('CROSS-ENGINE: WebKit derives the SAME rid as Node for the same code', async () => {
  for (const [code, expected] of VECTORS.rid) {
    const { rid } = await pairing.derivePairing(code);
    assert.equal(rid, expected, `rid drifted for ${code} — a second Mac would never find the rendezvous`);
  }
  // And the derivation is over the WHOLE code, here too.
  const a = await pairing.derivePairing('ABCDEFGHJKMN');
  const b = await pairing.derivePairing('ABCDEFGHJKM0');
  assert.notEqual(a.rid, b.rid);
  // Separators, case and the I/L/O folding are part of the derivation, not of the display.
  assert.equal((await pairing.derivePairing('abcd-efgh-jkmn')).rid, VECTORS.rid[0][1]);
  assert.equal((await pairing.derivePairing('ABCD EFGH JKMN')).rid, VECTORS.rid[0][1]);
});

test('CROSS-ENGINE: WebKit computes the SAME six digits as Node for the same transcript', async () => {
  const shared = new Uint8Array(32);
  for (let i = 0; i < 32; i++) shared[i] = i;
  const a = new Uint8Array(65).fill(0xa1); a[0] = 4;
  const b = new Uint8Array(65).fill(0xb2); b[0] = 4;
  assert.equal(await pairing.computeSas(shared, a, b), VECTORS.sas);
  // The order is by ROLE, and WebKit agrees about which way round that is.
  assert.equal(await pairing.computeSas(shared, b, a), VECTORS.sasRolesSwapped);
  assert.equal(pairing.sasFromBytes(new Uint8Array([0xff, 0xff, 0xff, 0xff])), '967295');
  assert.equal(pairing.sasFromBytes(new Uint8Array([0, 0, 0, 0])), '000000');
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. The four WebCrypto corners
// ═════════════════════════════════════════════════════════════════════════════

test('RULE 5: a peer ephemeral ECDH point imports with keyUsages [] and REJECTS with anything else', async () => {
  const kp = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits', 'deriveKey']);
  const raw = new Uint8Array(await S.exportKey('raw', kp.publicKey));
  assert.equal(raw.length, suite.RAW_PUBKEY_BYTES);
  // The public half of a pair generated with extractable:false is STILL exportable — the flag
  // belongs to the private half. `beginAsExisting` depends on that being true here as well.
  assert.equal(kp.privateKey.extractable, false);
  const ok = await identity.importKexPublic(raw);
  assert.deepEqual(ok.usages, []);
  let threw = false;
  try {
    await S.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  } catch (e) {
    threw = true;
    diag('WebKit refusal for a non-empty peer ECDH usage list: ' + e.name);
  }
  assert.equal(threw, true, 'a non-empty peer ECDH usage list was accepted — rule 5 is stale');
});

test('ENGINE DIFFERENCE 9: the restored recovery private halves need the PRIVATE usages only', async () => {
  const m = await existingMember(1);
  const payload = await pairing.buildPairingPayload({
    memberId: m.memberId, recSig: m.identity.recSig, recKex: m.identity.recKex,
    personal: m.keyring.personal,
  });
  assert.equal(b64.ub64(payload.recSigPkcs8).length, suite.PKCS8_P256_BYTES);

  // The way that bites: `generateKey` splits ['sign','verify'] across the pair, `importKey` does
  // not — and this is the ONLY place in the product that imports a private EC key.
  let threw = false;
  try {
    await S.importKey('pkcs8', b64.ub64(payload.recSigPkcs8),
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  } catch (e) {
    threw = true;
    diag('WebKit refusal for a private ECDSA key carrying `verify`: ' + e.name);
  }
  assert.equal(threw, true, 'WebKit accepted `verify` on a private key — engine difference 9 is stale');

  const restored = await pairing.restorePairingPayload(payload);
  assert.deepEqual(restored.recSigPriv.usages, ['sign']);
  assert.equal(restored.recSigPriv.type, 'private');
  assert.deepEqual(restored.recKexPriv.usages.slice().sort(), ['deriveBits', 'deriveKey']);
});

test('the restored recovery key is the SAME key — verified, never byte-compared (rule 1)', async () => {
  const m = await existingMember(1);
  const payload = await pairing.buildPairingPayload({
    memberId: m.memberId, recSig: m.identity.recSig, recKex: m.identity.recKex,
    personal: m.keyring.personal,
  });
  const restored = await pairing.restorePairingPayload(payload);
  const bytes = canon.canonicalBytes({ probe: 'same key?' });
  const sig = await identity.signBytes(restored.recSigPriv, bytes);
  assert.equal(await identity.verifyBytes(m.rec.recSig.publicKey, sig, bytes), true);
  const again = await identity.signBytes(restored.recSigPriv, bytes);
  assert.notEqual(b64.b64u(sig), b64.b64u(again), 'ECDSA is non-deterministic in WebKit too (rule 1)');
  assert.equal(await identity.verifyBytes(m.rec.recSig.publicKey, again, bytes), true);
});

test('RULE 6: the delivered PKCS#8 is 138 bytes, and WebKit refuses to AES-KW it', async () => {
  // 138 is not a multiple of 8. This is why every wrap in the product is AES-GCM, and why the
  // pairing delivery is one box rather than a wrapKey call. The trap the rule names is that
  // 25519 PKCS#8 is 48 bytes and DOES work, so a 25519 prototype would have hidden this.
  assert.equal(suite.PKCS8_P256_BYTES % 8, 2);
  const m = await existingMember(1);
  const pkcs8 = new Uint8Array(await S.exportKey('pkcs8', m.rec.recSig.privateKey));
  assert.equal(pkcs8.length, suite.PKCS8_P256_BYTES);
  const kw = await S.generateKey({ name: 'AES-KW', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  let threw = false;
  try {
    await S.wrapKey('pkcs8', m.rec.recSig.privateKey, kw, 'AES-KW');
  } catch (e) {
    threw = true;
    diag('WebKit refusal for AES-KW over a 138-byte PKCS#8: ' + e.name);
  }
  assert.equal(threw, true, 'AES-KW accepted a 138-byte input — rule 6 is stale');
});

test('the public half is recovered from a restored private key — the JWK round trip works here', async () => {
  // `adoptPairedDevice` needs `RK_sig.publicKey` on the new Mac and WebCrypto has no "give me the
  // public half" call, so it round-trips through JWK with `d` removed. That is the fiddliest step
  // on the restore path and the one most likely to differ between engines.
  const c = clock();
  const m = await existingMember(2);
  const A = pairing.createPairingSession(m.identity, m.keyring, c);
  const B = pairing.createPairingSession(null, null, c);
  const o = await A.beginAsExisting();
  const a = await B.answerAsNew(o.display, o.boxA);
  await A.confirmExisting(a.boxB);
  await B.confirmNew();
  A.confirmSasMatch(true);
  B.confirmSasMatch(true);
  const restored = await B.receive(await A.deliver());

  const ksB = keystore.memKeyStore();
  const adopted = await pairing.adoptPairedDevice(ksB, restored, B.newDeviceKeys(), { createdAt: DAY });
  const stored = await ksB.get(identity.KEYSTORE_IDS.recSig);
  assert.equal(stored.publicKey.type, 'public');
  assert.deepEqual(stored.publicKey.usages, ['verify']);
  const kexStored = await ksB.get(identity.KEYSTORE_IDS.recKex);
  assert.deepEqual(kexStored.publicKey.usages, [], 'rule 5 applies to the recovered ECDH public half too');
  // The recovered public key really is the member's: it verifies the self-attestation the
  // restored PRIVATE key just signed.
  assert.notEqual(await identity.verifyAttestation(adopted.blob, stored.publicKey), null);
  assert.notEqual(await identity.verifyAttestation(adopted.blob, m.rec.recSig.publicKey), null);
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. The whole protocol, in the engine that ships
// ═════════════════════════════════════════════════════════════════════════════

test('a full pairing in WKWebView ends with the second Mac reading the first Macs PRIVATE entries', async () => {
  const c = clock();
  const m = await existingMember(3);
  const A = pairing.createPairingSession(m.identity, m.keyring, c);
  const B = pairing.createPairingSession(null, null, c);

  const o = await A.beginAsExisting();
  assert.equal(o.code.length, 12);
  assert.match(o.display, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const a = await B.answerAsNew(o.display, o.boxA);
  const sasA = (await A.confirmExisting(a.boxB)).sas;
  const sasB = (await B.confirmNew()).sas;
  assert.equal(sasA, sasB, 'the two screens disagree with no attacker present');
  assert.match(sasA, /^\d{6}$/);
  diag('SAS in WKWebView: ' + sasA);

  A.confirmSasMatch(true);
  B.confirmSasMatch(true);
  const restored = await B.receive(await A.deliver());

  // Story 19.4, in the shipping engine: a private entry sealed under the OLDEST epoch key.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = canon.canonicalBytes(['lzp/v2/op', 1, m.spaceId, 1]);
  const ct = await S.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
    m.keyring.personal.epochs.get(1), canon.canonicalBytes({ note: 'Zahnarzt, 14:30 — privat' }));
  const pt = await S.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
    restored.personal.epochs.get(1), ct);
  assert.equal(JSON.parse(canon.utf8Decode(new Uint8Array(pt))).note, 'Zahnarzt, 14:30 — privat');
  assert.deepEqual([...restored.personal.epochs.keys()], [1, 2, 3], 'every epoch 1..e, or 19.4 is half-kept');
  assert.equal(restored.memberId, m.memberId);
});

test('the paired device adopts cleanly, and ensureDeviceIdentity ADOPTS rather than mints', async () => {
  const c = clock();
  const m = await existingMember(1);
  const A = pairing.createPairingSession(m.identity, m.keyring, c);
  const B = pairing.createPairingSession(null, null, c);
  const o = await A.beginAsExisting();
  const a = await B.answerAsNew(o.code, o.boxA);
  await A.confirmExisting(a.boxB);
  await B.confirmNew();
  A.confirmSasMatch(true);
  B.confirmSasMatch(true);
  const restored = await B.receive(await A.deliver());

  const ksB = keystore.memKeyStore();
  const minted = B.newDeviceKeys();
  const adopted = await pairing.adoptPairedDevice(ksB, restored, minted, { createdAt: DAY });
  assert.equal(adopted.identity.deviceShort, minted.deviceShort);
  assert.equal(adopted.identity.devSig.privateKey.extractable, false, 'a device key is never extractable');
  // …and it really is non-extractable in WebKit: exporting it must REJECT.
  let threw = false;
  try { await S.exportKey('pkcs8', adopted.identity.devSig.privateKey); } catch { threw = true; }
  assert.equal(threw, true, 'WebKit exported a non-extractable device key');

  const re = await identity.ensureDeviceIdentity(ksB, m.memberId, {});
  assert.equal(re.deviceShort, adopted.identity.deviceShort);
  assert.equal(re.deviceId, adopted.identity.deviceId);
  const rr = await identity.ensureRecoveryIdentity(ksB, m.memberId, {});
  assert.equal(rr.memberId, m.memberId);
  assert.notEqual(await identity.verifyAttestation(adopted.blob, rr.recSig.publicKey), null);
});

test('the real KeyRing from spacekeys.js feeds the payload unmodified, in this engine too', async () => {
  const psp = ids.spaceId('personal');
  const fsp = ids.spaceId('family');
  const k1 = await aesKey();
  const k2 = await aesKey();
  const ring = spacekeys.createKeyRing([[psp, 1, k1], [psp, 2, k2], [fsp, 1, k1]]);
  const spaces = pairing.spacesFromKeyRing(ring, { personalSpaceId: psp, familySpaceId: fsp });
  const m = await existingMember(1);
  const payload = await pairing.buildPairingPayload({
    memberId: m.memberId, recSig: m.identity.recSig, recKex: m.identity.recKex, ...spaces,
  });
  const restored = await pairing.restorePairingPayload(payload);
  assert.deepEqual([...restored.personal.epochs.keys()], [1, 2]);
  assert.equal(restored.family.spaceId, fsp);
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. T4, in the real engine
//
// `tests/helpers/mitm.js` cannot be loaded here — the harness's `importApp` reaches `src/js/`
// and nothing else — so the attacker is written out inline. That is no loss: it keeps this
// version independent of `pairing.js`'s own helpers for the same reason the Node one is, and it
// is short enough to read in one sitting.
// ═════════════════════════════════════════════════════════════════════════════

const TE = new TextEncoder();
const pairAadBytes = (type, rid) => TE.encode(JSON.stringify(['lzp/v2/pair', 1, type, rid]));

async function hkdfKey(ikm, label) {
  const k = await S.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  return S.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: TE.encode(label) },
    k, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** ADR 002 §5.3: `varint(len) || bytes || zeros`, to a multiple of 256. LEB128, unsigned. */
function padded(bytes) {
  const prefix = [];
  let v = bytes.length;
  while (v >= 0x80) { prefix.push((v % 128) | 0x80); v = Math.floor(v / 128); }
  prefix.push(v);
  const out = new Uint8Array(Math.ceil((prefix.length + bytes.length) / 256) * 256);
  out.set(prefix, 0);
  out.set(bytes, prefix.length);
  return out;
}

function unpadded(bytes) {
  let value = 0; let scale = 1; let i = 0;
  for (;;) { const b = bytes[i]; value += (b & 0x7f) * scale; i++; if ((b & 0x80) === 0) break; scale *= 128; }
  return bytes.subarray(i, i + value);
}

async function mitmOpen(key, type, rid, box) {
  try {
    const dot = box.indexOf('.');
    const iv = b64.ub64(box.slice(0, dot));
    const ct = b64.ub64(box.slice(dot + 1));
    const p = new Uint8Array(await S.decrypt(
      { name: 'AES-GCM', iv, additionalData: pairAadBytes(type, rid), tagLength: 128 }, key, ct));
    return JSON.parse(new TextDecoder().decode(unpadded(p)));
  } catch { return null; }
}

async function mitmSeal(key, type, rid, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await S.encrypt(
    { name: 'AES-GCM', iv, additionalData: pairAadBytes(type, rid), tagLength: 128 },
    key, padded(TE.encode(JSON.stringify(obj)))));
  return b64.b64u(iv) + '.' + b64.b64u(ct);
}

test('T4 IN WKWEBVIEW: a relay that substitutes ephemeral keys produces different digits', async () => {
  const c = clock();
  const m = await existingMember(2);
  const A = pairing.createPairingSession(m.identity, m.keyring, c);
  const B = pairing.createPairingSession(null, null, c);

  const o = await A.beginAsExisting();
  // The attacker is handed the code for free — shoulder-surfed. That is §6.4's posture: the code
  // is not the security parameter, the SAS is.
  const ck = await hkdfKey(TE.encode(o.code), 'lzp/v2/pair/ck');
  const openedA = await mitmOpen(ck, 'offer', o.rid, o.boxA);
  assert.notEqual(openedA, null, 'the inline attacker could not open box_A — it is broken, not the module');

  const mToB = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const mToA = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const mToBRaw = new Uint8Array(await S.exportKey('raw', mToB.publicKey));
  const mToARaw = new Uint8Array(await S.exportKey('raw', mToA.publicKey));

  const forgedOffer = await mitmSeal(ck, 'offer', o.rid, { ...openedA, aEph: b64.b64u(mToBRaw) });
  const a = await B.answerAsNew(o.display, forgedOffer);
  const openedB = await mitmOpen(ck, 'answer', o.rid, a.boxB);
  assert.notEqual(openedB, null);
  const forgedAnswer = await mitmSeal(ck, 'answer', o.rid, { ...openedB, bEph: b64.b64u(mToARaw) });

  const sasA = (await A.confirmExisting(forgedAnswer)).sas;
  const sasB = (await B.confirmNew()).sas;
  assert.notEqual(sasA, sasB, 'THE SAS DID NOT DIVERGE IN WEBKIT — the MITM defence is broken here');
  diag('WKWebView SAS under an active MITM — A: ' + sasA + '  B: ' + sasB);

  // The human sees two different numbers and says no. Both sides fail closed, terminally.
  assert.equal(A.confirmSasMatch(sasA === sasB).state, 'refused');
  assert.equal(B.confirmSasMatch(sasA === sasB).state, 'refused');
  let delivered = null;
  try { delivered = await A.deliver(); } catch (e) { assert.equal(e.code, 'refused'); }
  assert.equal(delivered, null, 'A sealed a key transfer despite the refusal');
  assert.equal(A.state(), 'refused');
  assert.equal(B.state(), 'refused');
});

test('T4 IN WKWEBVIEW: a corrupted box fails closed here as well, with no reason given', async () => {
  const c = clock();
  const m = await existingMember(1);
  const A = pairing.createPairingSession(m.identity, m.keyring, c);
  const B = pairing.createPairingSession(null, null, c);
  const o = await A.beginAsExisting();
  const dot = o.boxA.indexOf('.');
  const ct = b64.ub64(o.boxA.slice(dot + 1));
  ct[3] ^= 1;
  const corrupted = o.boxA.slice(0, dot) + '.' + b64.b64u(ct);

  let code = null;
  try { await B.answerAsNew(o.display, corrupted); } catch (e) { code = e.code; }
  assert.equal(code, 'open_failed');
  assert.equal(B.attemptsRemaining(), pairing.PAIRING.maxFailedOpens - 1);
  // And a wrong code is the same outcome — indistinguishable, by design.
  let code2 = null;
  try { await B.answerAsNew('ABCDEFGHJKMN', o.boxA); } catch (e) { code2 = e.code; }
  assert.equal(code2, 'open_failed');
});

test('the TTL and the burn behave identically in this engine', async () => {
  const c = clock();
  const m = await existingMember(1);
  const A = pairing.createPairingSession(m.identity, m.keyring, c);
  const o = await A.beginAsExisting();
  c.advance(pairing.PAIRING.ttlMs + 1);
  let code = null;
  try { await A.confirmExisting('x'); } catch (e) { code = e.code; }
  assert.equal(code, 'expired');
  assert.equal(A.state(), 'expired');

  const B = pairing.createPairingSession(null, null, clock());
  const A2 = pairing.createPairingSession(m.identity, m.keyring, clock());
  const o2 = await A2.beginAsExisting();
  let last = null;
  for (let i = 0; i < pairing.PAIRING.maxFailedOpens; i++) {
    let wrong = 'ABCDEFGHJKM' + '0123456789Z'[i];
    if (wrong === o2.code) wrong = 'ZZZZZZZZZZZZ';
    try { await B.answerAsNew(wrong, o2.boxA); } catch (e) { last = e.code; }
  }
  assert.equal(last, 'burned');
  assert.equal(B.state(), 'burned');
  let after = null;
  try { await B.answerAsNew(o2.code, o2.boxA); } catch (e) { after = e.code; }
  assert.equal(after, 'burned', 'a burned session must not accept the right code either');
});
