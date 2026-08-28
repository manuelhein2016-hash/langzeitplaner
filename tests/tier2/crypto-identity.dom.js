// TIER 2 · LZP-302 — `LZP-CRYPTO-1` inside the REAL WKWebView.  ADR 002 §1, §2, §9.
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE TIER-1 ONE.
// Node is a WebCrypto engine, but it is not THE engine: the shipping app runs JavaScriptCore
// inside WKWebView under the `app://localhost` scheme, and ADR 002 §1's whole table of seven
// engine-difference rules exists because the two disagree in ways no compat table records. Every
// claim ADR 002 makes about "both engines" is only half-proved by `npm test`. This is the other
// half, and it runs against the same `src/` the user's Mac loads.
//
// It deliberately does NOT touch IndexedDB. Custody and persistence are
// `crypto-keystore-phase1.dom.js` / `-phase2.dom.js`, which need two separate launches; this file
// is about the ALGORITHMS and the identity layer, and uses the memory store so it can be run in
// any order without leaving anything behind in the shared WebKit data store.
//
// NO GOLDEN SIGNATURES ANYWHERE (rule 1). Every signature assertion below is `verify() === true`.

const suite = await importApp('crypto/suite.js');
const probeMod = await importApp('crypto/probe.js');
const identity = await importApp('crypto/identity.js');
const ids = await importApp('core/ids.js');
const b64 = await importApp('core/b64.js');
const canon = await importApp('core/canon.js');
const authz = await importApp('core/authz.js');
const stamp = await importApp('core/stamp.js');
const entities = await importApp('core/entities.js');
const keystore = await importApp('platform/keystore.js');

const S = crypto.subtle;
const TE = new TextEncoder();
const DAY = '2026-08-27';

const toHex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));

async function makeMember() {
  const ks = keystore.memKeyStore();
  const memberId = ids.memberId();
  const deviceId = ids.deviceId();
  const rec = await identity.ensureRecoveryIdentity(ks, memberId, { createdAt: DAY });
  const minted = await identity.ensureAttestedDevice(ks, memberId, rec.recSig.privateKey, {
    deviceId, createdAt: DAY,
  });
  return { ks, memberId, deviceId, rec, ...minted };
}

// ── the context this whole design assumes ────────────────────────────────────

test('RULE 7: this engine has indexedDB and isSecureContext === true under app://localhost', () => {
  // The other half of the asymmetry tier 1 records. Node has neither, and `isSecureContext` there
  // is `undefined` — not `false`. Here both are real, and `crypto.subtle` exists BECAUSE the
  // context is secure: the custom `app://` scheme is registered as such. If this ever flipped,
  // every family feature would fail at its second step with an unreadable TypeError, which is
  // precisely what `probeCrypto()` exists to turn into one plain German sentence.
  assert.equal(location.protocol, 'app:');
  assert.equal(isSecureContext, true);
  assert.equal(typeof indexedDB, 'object');
  assert.equal(typeof crypto.subtle, 'object');
  diag('engine: ' + navigator.userAgent);
});

test('probeCrypto: all five rows are true in this engine, and the suite is usable', async () => {
  const t0 = performance.now();
  const r = await probeMod.probeCrypto();
  const ms = performance.now() - t0;
  diag('probe took ' + ms.toFixed(2) + ' ms: ' + JSON.stringify(r));
  assert.equal(r.ok, true);
  assert.equal(r.suite, 'LZP-CRYPTO-1');
  for (const row of probeMod.PROBE_ROWS) assert.equal(r[row], true, row + ' missing in WebKit');
  assert.equal(probeMod.isSuiteAvailable(r), true);
  // ADR 002 §1 claims "~1 ms". Assert something a slow machine still passes, so the row is a
  // guard against a probe that accidentally runs 600 000 PBKDF2 iterations, not a benchmark.
  assert.ok(ms < 250, 'the probe took ' + ms.toFixed(1) + ' ms — it must stay cheap enough to run at a click');
});

// ── the deterministic halves: known-answer tests ─────────────────────────────

test('KAT · SHA-256 published vectors, in WebKit\'s digest AND in core/ids.js', async () => {
  const vectors = [
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ];
  for (const [text, want] of vectors) {
    assert.equal(toHex(await S.digest('SHA-256', TE.encode(text))), want, 'WebKit digest: ' + text.slice(0, 12));
    assert.equal(toHex(ids.sha256(TE.encode(text))), want, 'core/ids.js sha256: ' + text.slice(0, 12));
  }
});

test('KAT · core/ids.js SHA-256 and WebKit\'s digest are the SAME FUNCTION', async () => {
  // `core/ids.js` carries a hand-rolled SHA-256 because the authorization fold may not await.
  // If it and JavaScriptCore ever disagreed, every deviceShort computed on a Mac would differ
  // from every deviceShort computed in Node — the ops would sync and the attribution would rot.
  for (const n of [0, 1, 54, 55, 56, 57, 63, 64, 65, 127, 128, 129, 200]) {
    const input = Uint8Array.from({ length: n }, (_, i) => (i * 31 + n) % 256);
    assert.equal(toHex(ids.sha256(input)), toHex(await S.digest('SHA-256', input)), 'length ' + n);
  }
});

test('KAT · HKDF-SHA-256 reproduces RFC 5869 test case 1 in WebKit', async () => {
  const ikm = fromHex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b');
  const salt = fromHex('000102030405060708090a0b0c');
  const info = fromHex('f0f1f2f3f4f5f6f7f8f9');
  const k = await S.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const okm = await S.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, 42 * 8);
  assert.equal(
    toHex(okm),
    '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865'
  );
});

test('KAT · PBKDF2-SHA-256 reproduces the published vector in WebKit', async () => {
  const k = await S.importKey('raw', TE.encode('password'), 'PBKDF2', false, ['deriveBits']);
  const bits = await S.deriveBits(suite.pbkdf2(TE.encode('salt'), 4096), k, 256);
  assert.equal(toHex(bits), 'c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a');
});

test('KAT · deviceShort and Crockford base32 are byte-identical to the Node answers', async () => {
  // These are the pinned rows from tests/helpers/kat.js, restated here because a tier-2 file is a
  // plain script and cannot import a helper. A divergence between the two lists IS the bug this
  // pair of files exists to find: `deviceShort` is the `dv` the relay routes on and the last 16
  // characters of every stamp, so one differing character means a family stops converging.
  const vectors = [
    [new Uint8Array(65), 'K3745QQFA7A04TEN'],
    [Uint8Array.from({ length: 65 }, (_, i) => i), '9FYJS2VF3VP7MAQY'],
    [Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : (i * 7) % 256)), 'ER58SEE5W7SY3FKX'],
  ];
  for (const [input, want] of vectors) {
    assert.equal(identity.deviceShortOf(input), want, 'sync');
    assert.equal(await identity.deviceShortOfAsync(input), want, 'via WebKit\'s digest');
    assert.equal(identity.deviceShortOfB64u(b64.b64u(input)), want, 'via b64url');
  }
  assert.equal(b64.crock32(new Uint8Array(10)), '0000000000000000');
  assert.equal(b64.crock32(new Uint8Array(10).fill(255)), 'ZZZZZZZZZZZZZZZZ');
  assert.equal(b64.crock32(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])), '000G40R40M30E209');
});

// ── the seven rules, where they apply ────────────────────────────────────────

test('RULE 1: WebKit ECDSA is non-deterministic too — no golden-signature fixture is possible', async () => {
  const { recSig } = await identity.generateRecoveryKeys();
  const msg = TE.encode('the same message, three times');
  const a = await identity.signBytes(recSig.privateKey, msg);
  const b = await identity.signBytes(recSig.privateKey, msg);
  const c = await identity.signBytes(recSig.privateKey, msg);
  assert.equal(a.length, 64, 'P1363 r||s, 64 bytes — not DER');
  const spellings = new Set([b64.b64u(a), b64.b64u(b), b64.b64u(c)]);
  assert.equal(spellings.size, 3, 'three signings gave ' + spellings.size + ' distinct signatures');
  for (const s of [a, b, c]) {
    assert.equal(await identity.verifyBytes(recSig.publicKey, s, msg), true, 'and every one verifies');
  }
});

test('RULE 1, cross-engine: a signature made HERE is verifiable by the same code path', async () => {
  // The useful half of rule 1: signatures do not compare, but they DO interoperate. A device key
  // minted in WebKit, exported as a 65-byte raw point, re-imported as a peer key, verifies.
  const { devSig } = await identity.generateDeviceKeys();
  const raw = await identity.exportRawPublic(devSig.publicKey);
  const peer = await identity.importSigPublic(raw);
  const msg = TE.encode('across the seam');
  const sig = await identity.signBytes(devSig.privateKey, msg);
  assert.equal(await identity.verifyBytes(peer, sig, msg), true);
  assert.equal(await identity.verifyBytes(peer, sig, TE.encode('across the seaM')), false);
});

test('RULE 2: WebKit refuses a zero-length payload at our guard, before it reaches verify()', async () => {
  // ADR 002 §1 records the reason this rule is not paranoia: WebKit's `verify()` returns FALSE
  // for Ed25519 over an empty message even for a valid RFC 8032 reference signature. A silent
  // `false` on a valid signature is the worst possible failure shape for a sync protocol, so the
  // guard exists for every algorithm regardless of which one has the flaw today.
  const { recSig } = await identity.generateRecoveryKeys();
  let threw = false;
  try { await identity.signBytes(recSig.privateKey, new Uint8Array(0)); } catch (e) { threw = true; }
  assert.equal(threw, true, 'signBytes must refuse an empty payload');
  threw = false;
  try { await identity.verifyBytes(recSig.publicKey, new Uint8Array(64), new Uint8Array(0)); } catch (e) { threw = true; }
  assert.equal(threw, true, 'verifyBytes must refuse an empty payload');
  // And for the record: ECDSA over empty input is NOT broken here — the guard is prophylactic.
  const sig = await S.sign({ name: 'ECDSA', hash: 'SHA-256' }, recSig.privateKey, new Uint8Array(0));
  const ok = await S.verify({ name: 'ECDSA', hash: 'SHA-256' }, recSig.publicKey, sig, new Uint8Array(0));
  diag('WebKit ECDSA over a zero-length message verifies: ' + ok + ' (recorded, not relied on)');
  assert.equal(typeof ok, 'boolean');
});

test('RULE 3: WebKit\'s error name for a non-extractable export is NOT Node\'s', async () => {
  // Node: InvalidAccessException. WebKit: InvalidAccessError. Recorded here and in
  // tests/tier1/crypto-identity.test.js so the pair of them is the evidence for the rule; nothing
  // in src/ branches on either.
  const { devSig } = await identity.generateDeviceKeys();
  let name = null;
  try { await S.exportKey('pkcs8', devSig.privateKey); } catch (e) { name = e && e.name; }
  diag('WebKit error name: ' + name + '  ·  Node says InvalidAccessException');
  assert.ok(name, 'exporting a non-extractable private key must throw');
  assert.match(name, /^InvalidAccess(Error|Exception)$/);
});

test('RULE 4: HkdfParams.salt is mandatory here too — omitting it throws', async () => {
  const k = await S.importKey('raw', new Uint8Array(32), 'HKDF', false, ['deriveBits']);
  let threw = false;
  try {
    await S.deriveBits({ name: 'HKDF', hash: 'SHA-256', info: new Uint8Array(0) }, k, 256);
  } catch (e) { threw = true; diag('omitted salt -> ' + e.name); }
  assert.equal(threw, true, 'if WebKit ever accepts a missing salt, rule 4 becomes engine-specific');
  const ok = await S.deriveBits(suite.hkdf(suite.NO_SALT, suite.INFO.backup), k, 256);
  assert.equal(ok.byteLength, 32);
});

test('RULE 5: a peer ECDH public key needs keyUsages: [] in WebKit as well', async () => {
  const kex = await S.generateKey(suite.KEX, true, ['deriveBits', 'deriveKey']);
  const raw = new Uint8Array(await S.exportKey('raw', kex.publicKey));
  let threw = false;
  try { await S.importKey('raw', raw, suite.KEX, true, ['deriveBits']); } catch (e) { threw = true; diag('non-empty usages -> ' + e.name); }
  assert.equal(threw, true, 'a non-empty usage list on a peer ECDH public key must be refused');
  const peer = await identity.importKexPublic(raw);
  assert.equal(peer.type, 'public');
  assert.deepEqual(peer.usages, []);
  // …and it still works for what it is for.
  const bits = await S.deriveBits({ name: 'ECDH', public: peer }, kex.privateKey, 256);
  assert.equal(bits.byteLength, 32);
});

test('RULE 6: AES-KW refuses a P-256 private key in WebKit; AES-GCM wraps it to 154 bytes', async () => {
  const kp = await S.generateKey(suite.SIG, true, ['sign', 'verify']);
  const pkcs8 = await S.exportKey('pkcs8', kp.privateKey);
  assert.equal(pkcs8.byteLength, 138, 'PKCS#8 is 138 bytes — and 138 is not a multiple of 8');
  const kw = await S.generateKey({ name: 'AES-KW', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  let threw = false;
  try { await S.wrapKey('pkcs8', kp.privateKey, kw, 'AES-KW'); } catch (e) { threw = true; diag('AES-KW -> ' + e.name); }
  assert.equal(threw, true, 'AES-KW over a 138-byte PKCS#8 must fail (the 25519 prototype trap)');
  const gcm = await S.generateKey({ name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await S.wrapKey('pkcs8', kp.privateKey, gcm, { name: 'AES-GCM', iv, tagLength: 128 });
  assert.equal(wrapped.byteLength, 154, '138 + a 16-byte GCM tag');
});

// ── key shapes, sizes and non-extractability ─────────────────────────────────

test('the export sizes ADR 002 §9.2 measured are what WebKit produces', async () => {
  const kp = await S.generateKey(suite.SIG, true, ['sign', 'verify']);
  assert.equal((await S.exportKey('raw', kp.publicKey)).byteLength, 65, 'raw');
  assert.equal((await S.exportKey('spki', kp.publicKey)).byteLength, 91, 'spki');
  assert.equal((await S.exportKey('pkcs8', kp.privateKey)).byteLength, 138, 'pkcs8');
  assert.equal((await S.exportKey('jwk', kp.publicKey)).crv, 'P-256');
  const raw = new Uint8Array(await S.exportKey('raw', kp.publicKey));
  assert.equal(raw[0], 0x04, 'uncompressed point');
});

test('device keys generated HERE are non-extractable and exportKey REJECTS', async () => {
  const { devSig, devKex } = await identity.generateDeviceKeys();
  assert.equal(devSig.privateKey.extractable, false);
  assert.equal(devKex.privateKey.extractable, false);
  for (const [what, key] of [['sig', devSig.privateKey], ['kex', devKex.privateKey]]) {
    let threw = false;
    try { await S.exportKey('pkcs8', key); } catch (e) { threw = true; }
    assert.equal(threw, true, 'exportKey(pkcs8) on the ' + what + ' private key must reject');
    threw = false;
    try { await S.exportKey('jwk', key); } catch (e) { threw = true; }
    assert.equal(threw, true, 'exportKey(jwk) on the ' + what + ' private key must reject');
  }
  // The public halves still travel.
  assert.equal((await identity.exportRawPublic(devSig.publicKey)).length, 65);
});

test('both engines validate a P-256 point before scalar multiplication', async () => {
  const kex = await S.generateKey(suite.KEX, true, ['deriveBits', 'deriveKey']);
  const raw = new Uint8Array(await S.exportKey('raw', kex.publicKey));
  const offCurve = raw.slice();
  offCurve[64] ^= 0x01;
  for (const [what, bad] of [['off-curve', offCurve], ['point at infinity', new Uint8Array(1)]]) {
    let threw = false;
    try { await identity.importKexPublic(bad); } catch (e) { threw = true; diag(what + ' -> ' + e.name); }
    assert.equal(threw, true, what + ' must be refused at import');
  }
});

// ── identity and attestation ─────────────────────────────────────────────────

test('a device identity minted in WebKit has the six-field attestation §2.3 fixes', async () => {
  const m = await makeMember();
  assert.deepEqual(Object.keys(m.attestation).sort(), [...identity.ATTESTATION_FIELDS].sort());
  assert.equal(m.attestation.memberId, m.memberId);
  assert.equal(b64.ub64(m.attestation.sigPubRaw).length, 65);
  assert.equal(b64.ub64(m.attestation.kexPubRaw).length, 65);
  assert.equal(m.attestation.deviceShort, identity.deviceShortOfB64u(m.attestation.sigPubRaw), 'P2');
  assert.equal(m.identity.devSig.privateKey.extractable, false);
});

test('an attestation minted in WebKit verifies, and every tampered field fails', async () => {
  const m = await makeMember();
  const back = await identity.verifyAttestation(m.blob, m.rec.recSig.publicKey);
  assert.notEqual(back, null);
  assert.equal(back.deviceShort, m.attestation.deviceShort);
  for (const field of identity.ATTESTATION_FIELDS) {
    const swapped = Object.assign({}, m.attestation);
    swapped[field] = field === 'createdAt' ? '2020-01-01' : m.attestation[field] + 'X';
    const forged = b64.b64u(canon.canonicalBytes(swapped)) + '.' + m.blob.split('.')[1];
    assert.equal(await identity.verifyAttestation(forged, m.rec.recSig.publicKey), null, field);
  }
});

test('the blob WebKit produces is the byte-for-byte shape core/authz.js parses', async () => {
  // canonicalJSON is a security boundary precisely because two engines must agree on the bytes
  // that get signed. This is the WebKit half of that claim.
  const m = await makeMember();
  const parts = m.blob.split('.');
  assert.equal(parts.length, 2);
  assert.equal(toHex(b64.ub64(parts[0])), toHex(canon.canonicalBytes(m.attestation)));
  assert.equal(b64.ub64(parts[1]).length, 64);
  const parsed = authz.parseAttestationBlob(m.blob);
  assert.notEqual(parsed, null);
  assert.equal(parsed.deviceShort, m.attestation.deviceShort);
  assert.equal(parsed.sigPubRaw, m.attestation.sigPubRaw);
});

test('P2 is enforced here too: a validly-signed but inconsistent short verifies to null', async () => {
  const m = await makeMember();
  const lying = Object.assign({}, m.attestation, { deviceShort: ids.ZERO_DEVICE_SHORT });
  const payload = canon.canonicalBytes(lying);
  const sig = await identity.signBytes(m.rec.recSig.privateKey, payload);
  const blob = b64.b64u(payload) + '.' + b64.b64u(sig);
  assert.notEqual(authz.parseAttestationBlob(blob), null, 'the shape is fine');
  assert.equal(await identity.verifyAttestation(blob, m.rec.recSig.publicKey), null, 'P2 refuses it');
  let threw = false;
  try { await identity.attestDevice(lying, m.rec.recSig.privateKey); } catch (e) { threw = true; }
  assert.equal(threw, true, 'and it is never minted in the first place');
});

test('I-3 / R5-7 in WebKit: P2 still does not stop a copied public key — and the fold does', async () => {
  // Tier 1 carries the same pair of claims; this is the shipping engine, so neither the finding
  // nor its fix can be dismissed as a Node artefact. Two halves, and the first is UNCHANGED:
  //
  //  (1) P2 does not close I-3. `sigPubRaw` is PUBLIC and travels in the victim's own register,
  //      so the squat copies key and short together, tells the truth about both, mints, and
  //      verifies. ADR 002 §2.3's struck sentence claimed otherwise.
  //  (2) What closes it is the possession proof at fold time (§2.3 "One short, one signer"):
  //      a `dev.<S>` register is a credential only if the op that WROTE it was stamped by the
  //      device it attests. Mallory can copy every public field; she cannot stamp an op with a
  //      short whose private key she does not hold, because that envelope must pass P3.
  const victim = await makeMember();
  const mallory = await makeMember();
  const squat = {
    memberId: mallory.memberId,
    deviceId: ids.deviceId(),
    deviceShort: victim.attestation.deviceShort,
    sigPubRaw: victim.attestation.sigPubRaw,
    kexPubRaw: mallory.attestation.kexPubRaw,
    createdAt: DAY,
  };
  assert.equal(identity.attestationSelfConsistent(squat), true, 'P2 is satisfied — that is the finding');
  const blob = await identity.attestDevice(squat, mallory.rec.recSig.privateKey);
  const opened = await identity.verifyAttestation(blob, mallory.rec.recSig.publicKey);
  assert.notEqual(opened, null, 'and it verifies under her own recovery key');
  assert.notEqual(opened.memberId, victim.memberId, 'two member records still claim one short');

  // ── (2), in the real fold, with keys this engine generated and blobs it signed ──
  const FSP = ids.spaceId('family');
  const V = victim.attestation.deviceShort;
  const M = mallory.attestation.deviceShort;
  const attOp = (memberId, blobValue, regShort, byShort, ms) => ({
    v: 1,
    id: ids.opId(),
    ts: stamp.fmt(ms, 1, byShort),
    space: FSP,
    act: memberId,
    dev: memberId === victim.memberId ? victim.deviceId : mallory.deviceId,
    gid: ids.groupId(),
    k: 'member.set',
    e: entities.memberKey(memberId),
    f: { ['dev.' + regShort]: blobValue },
  });
  // The real `attestOpen`, pre-resolved with the real `verifyAttestation` — never a stub.
  const table = new Map();
  for (const [mid, key] of [[victim.memberId, victim.rec.recSig.publicKey],
    [mallory.memberId, mallory.rec.recSig.publicKey]]) {
    for (const bl of [victim.blob, blob]) {
      table.set(identity.attestOpenKey(mid, bl), await identity.verifyAttestation(bl, key));
    }
  }
  const attestOpen = identity.attestOpenFrom(table);

  const honest = attOp(victim.memberId, victim.blob, V, V, 1787836800000);
  const theSquat = attOp(mallory.memberId, blob, V, M, 1787836700000);   // backdated, deliberately

  const r = authz.foldAuthorized([honest, theSquat], { me: victim.memberId, attestOpen });
  assert.equal(r.rejected.length, 0, 'the squat is ADMITTED — refusing it would be the DoS handle');
  assert.deepEqual(r.shortCollisions, [], 'and it contests nothing, because it was never a claim');
  assert.deepEqual(r.unprovenShorts, [V], 'it is reported instead');
  assert.equal(r.attestationOf(V).memberId, victim.memberId, 'the victim keeps his own short');

  // The pre-collision window — one op, no contest to see — resolves to NOBODY, not to her.
  const windowOnly = authz.foldAuthorized([theSquat], { me: victim.memberId, attestOpen });
  assert.equal(windowOnly.attestationOf(V), null, 'she is never handed a short she cannot sign for');
  assert.deepEqual(windowOnly.unprovenShorts, [V]);

  // And the proof is a real signature check in this engine, not a string comparison: an op
  // stamped with the victim's short verifies ONLY under the victim's signing key.
  const aad = TE.encode('lzp/v2/probe/' + V);
  const sig = await identity.signBytes(mallory.identity.devSig.privateKey, aad);
  const victimPub = await identity.importSigPublic(b64.ub64(victim.attestation.sigPubRaw));
  assert.equal(await identity.verifyBytes(victimPub, sig, aad), false,
    'a signature she can make never verifies under the key his short names — this is P3');
});

test('ensureDeviceIdentity is idempotent in WebKit and refuses a partial store', async () => {
  const ks = keystore.memKeyStore();
  const memberId = ids.memberId();
  const first = await identity.ensureDeviceIdentity(ks, memberId, { deviceId: ids.deviceId(), createdAt: DAY });
  const again = await identity.ensureDeviceIdentity(ks, memberId);
  assert.equal(again.deviceShort, first.deviceShort);
  await ks.del('lzp/v2/dev/meta');
  let threw = false;
  try { await identity.ensureDeviceIdentity(ks, memberId, { deviceId: ids.deviceId(), createdAt: DAY }); }
  catch (e) { threw = true; diag('partial store -> ' + e.message.slice(0, 70)); }
  assert.equal(threw, true, 'a partial store must never be silently regenerated over');
});

// ── the Keychain backstop, through the real Swift bridge ─────────────────────

test('the shell exposes keychain_set / keychain_get / keychain_delete', async () => {
  // ADR 002 §2.2's three cases in shell-macos/main.swift. A headless run uses a SEPARATE
  // Keychain service name (`keychainService()` in main.swift), so nothing here can reach the
  // production items — the structural equivalent of the scratch-directory redirection, because
  // the login Keychain cannot be fingerprinted before and after the way the board directory is.
  const kc = keystore.keychainPort(window.__TAURI__.core.invoke);
  const key = 'tier2-probe';
  await kc.del(key);
  assert.equal(await kc.get(key), null, 'absent reads as null');
  await kc.set(key, 'first');
  assert.equal(await kc.get(key), 'first');
  await kc.set(key, 'second');
  assert.equal(await kc.get(key), 'second', 'set is idempotent — a re-pair rewrites in place');
  await kc.del(key);
  assert.equal(await kc.get(key), null);
  await kc.del(key); // deleting something absent is success
});

test('ensureDek mints a 32-byte DEK in the real Keychain and returns the same one twice', async () => {
  const kc = keystore.keychainPort(window.__TAURI__.core.invoke);
  await kc.del(keystore.KEYCHAIN_ACCOUNTS.dek);
  const dek = await keystore.ensureDek(kc);
  assert.equal(dek.length, 32);
  const again = await keystore.ensureDek(kc);
  assert.equal(b64.b64u(again), b64.b64u(dek), 'the second call must not mint a new one');
  await kc.del(keystore.KEYCHAIN_ACCOUNTS.dek);
  assert.equal(await kc.get(keystore.KEYCHAIN_ACCOUNTS.dek), null, 'cleaned up after itself');
});

test('fileKeyStore round-trips a recovery pair through the real engine, and refuses a device key', async () => {
  const files = new Map();
  const bytes = {
    read: async (k) => (files.has(k) ? files.get(k) : null),
    write: async (k, v) => void files.set(k, v),
    remove: async (k) => void files.delete(k),
    keys: async () => [...files.keys()],
  };
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const ks = keystore.fileKeyStore(bytes, { dek });
  const { recSig } = await identity.generateRecoveryKeys();
  await ks.put('lzp/v2/rec/sig', recSig);
  const written = files.get('lzp/v2/rec/sig');
  const pkcs8 = b64.b64u(new Uint8Array(await S.exportKey('pkcs8', recSig.privateKey)));
  assert.equal(written.includes(pkcs8), false, 'the private key must never be written unwrapped');
  const back = await ks.get('lzp/v2/rec/sig');
  const msg = TE.encode('wkwebview round trip');
  const sig = await identity.signBytes(back.privateKey, msg);
  assert.equal(await identity.verifyBytes(recSig.publicKey, sig, msg), true, 'same key, restored');

  const { devSig } = await identity.generateDeviceKeys();
  let threw = false;
  try { await ks.put('lzp/v2/dev/sig', devSig); } catch (e) { threw = true; diag('file store -> ' + e.name); }
  assert.equal(threw, true, 'a non-extractable device key must never reach a file store');
});
