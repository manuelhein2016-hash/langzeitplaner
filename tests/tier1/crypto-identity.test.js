// TIER 1 · LZP-302 — the ground floor of E3: the suite, the probe, device identity, attestation
// and key custody.  ADR 002 §1, §2, §9.1 · docs/v2/contracts/crypto.contract.js §0-§2.
//
// WHAT THIS FILE CAN AND CANNOT PROVE, STATED UP FRONT.
// Node is a real WebCrypto engine and everything algorithmic here is real: real P-256 keys, real
// ECDSA, real HKDF, real PBKDF2. But Node has no `indexedDB` (ADR 002 §1 rule 7), so
// **persistence cannot be tested here at all** — not by shimming a store, which would convert an
// unverified design into one that merely LOOKED verified. The persistence claim is made in
// `tests/tier2/crypto-keystore-phase1.dom.js` / `-phase2.dom.js`, which are two separate launches
// of the real shell, and nowhere else. This file uses `memKeyStore()` and says so.
//
// SIGNATURES ARE NEVER COMPARED (ADR 002 §1 rule 1). ECDSA is non-deterministic in both engines,
// so every assertion about a signature in this file is `verify() === true` or
// `verifyAttestation() !== null`. There is one test that asserts the non-determinism ITSELF,
// which is the only place two signatures over the same bytes are compared — to prove they differ.

import test from 'node:test';
import assert from 'node:assert/strict';

import { b64u, ub64, crock32 } from '../../src/js/core/b64.js';
import { canonicalBytes } from '../../src/js/core/canon.js';
import { deviceId as mkDeviceId, memberId as mkMemberId, sha256, ZERO_DEVICE_SHORT } from '../../src/js/core/ids.js';
import { parseAttestationBlob } from '../../src/js/core/authz.js';

import {
  SUITE_ID, ENVELOPE_V, SIG, SIGOP, KEX, AEAD, KDF, BACKUP_KDF, INFO, RETIRED_INFO,
  PAD_BUCKET, USAGES, RAW_PUBKEY_BYTES, SPKI_P256_BYTES, PKCS8_P256_BYTES, WRAPPED_PKCS8_BYTES,
  SYMMETRIC_KEY_BYTES, DEVICE_SHORT_CHARS, DEVICE_KEY_EXTRACTABLE, RECOVERY_KEY_EXTRACTABLE,
  infoBytes, hkdf, pbkdf2 as pbkdf2Params, aesgcm, assertSignable, NO_SALT,
} from '../../src/js/crypto/suite.js';
import { probeCrypto, isSuiteAvailable, unavailableMessage, PROBE_ROWS } from '../../src/js/crypto/probe.js';
import * as identity from '../../src/js/crypto/identity.js';
import {
  memKeyStore, fileKeyStore, idbKeyStore, keychainPort, ensureDek, chooseKeyStore,
  KeyStoreUnavailableError, KEYCHAIN_ACCOUNTS,
} from '../../src/js/platform/keystore.js';

import {
  hex, toHex, hkdf as pureHkdf, pbkdf2 as purePbkdf2, hmacSha256,
  SHA256_VECTORS, HKDF_RFC5869_CASE1, DEVICE_SHORT_VECTORS, CROCK32_VECTORS,
} from '../helpers/kat.js';
import { pathToPrefix, reachableFrom } from '../helpers/importgraph.js';

const TE = new TextEncoder();
const S = globalThis.crypto.subtle;
const DAY = '2026-08-27';

/** A whole member: recovery pair, one device, an attested blob. Used by most sections below. */
async function makeMember(day = DAY) {
  const ks = memKeyStore();
  const memberId = mkMemberId();
  const deviceId = mkDeviceId();
  const rec = await identity.ensureRecoveryIdentity(ks, memberId, { createdAt: day });
  const minted = await identity.ensureAttestedDevice(ks, memberId, rec.recSig.privateKey, {
    deviceId, createdAt: day,
  });
  return { ks, memberId, deviceId, rec, ...minted };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. The suite is one suite, and the labels are wire format
// ═════════════════════════════════════════════════════════════════════════════

test('LZP-CRYPTO-1 is exactly the five algorithm choices ADR 002 §1 fixes', () => {
  assert.equal(SUITE_ID, 'LZP-CRYPTO-1');
  assert.equal(ENVELOPE_V, 1);
  assert.deepEqual({ ...SIG }, { name: 'ECDSA', namedCurve: 'P-256' });
  assert.deepEqual({ ...KEX }, { name: 'ECDH', namedCurve: 'P-256' });
  assert.equal(AEAD.name, 'AES-GCM');
  assert.equal(AEAD.length, 256);
  assert.equal(AEAD.tagLength, 128);
  assert.equal(AEAD.ivBytes, 12);
  assert.equal(KDF.hash, 'SHA-256');
  assert.equal(BACKUP_KDF.name, 'PBKDF2');
  assert.equal(BACKUP_KDF.iterations, 600000, 'D8 / OWASP floor — lowering this is a security change');
  assert.equal(PAD_BUCKET, 256);
});

test('SIG and SIGOP are different shapes, and using SIG to sign is refused by the engine', async () => {
  // The classic P-256 bug: generateKey/importKey want `namedCurve`, sign/verify want `hash`.
  assert.equal('namedCurve' in SIG, true);
  assert.equal('hash' in SIGOP, true);
  assert.equal('namedCurve' in SIGOP, false);
  const kp = await S.generateKey(SIG, false, ['sign', 'verify']);
  await assert.rejects(() => S.sign(SIG, kp.privateKey, TE.encode('x')));
});

test('the HKDF info labels are exactly ADR 002 §3s table, and lzp/v2/invite/wrap is REFUSED', () => {
  assert.deepEqual(Object.values(INFO).sort(), [
    'lzp/v2/backup',
    'lzp/v2/device/dek',
    'lzp/v2/invite/id',
    'lzp/v2/invite/verify',
    'lzp/v2/pair/ck',
    'lzp/v2/pair/kek',
    'lzp/v2/pair/rid',
    'lzp/v2/pair/sas',
    'lzp/v2/space-key-wrap',
  ]);
  // D9: an invite carries no key material of any kind. The label is not merely absent, it is
  // actively refused, so a downstream agent copying from the superseded §7.1 text gets an error
  // rather than a quietly re-created seven-day read window.
  assert.deepEqual([...RETIRED_INFO], ['lzp/v2/invite/wrap']);
  assert.throws(() => infoBytes('lzp/v2/invite/wrap'), /RETIRED/);
  assert.throws(() => infoBytes('lzp/v2/space-key-wrapp'), /not one of the fixed/);
  assert.deepEqual([...infoBytes(INFO.spaceKeyWrap)], [...TE.encode('lzp/v2/space-key-wrap')]);
});

test('RULE 4 is a required argument, not a comment: hkdf() refuses a missing salt', () => {
  assert.throws(() => hkdf(undefined, INFO.backup), /MANDATORY/);
  assert.throws(() => hkdf(null, INFO.backup), /MANDATORY/);
  const p = hkdf(NO_SALT, INFO.backup);
  assert.equal(p.name, 'HKDF');
  assert.equal(p.salt.length, 0, 'NO_SALT is the explicit "I mean none" value');
  assert.equal(p.hash, 'SHA-256');
});

test('RULE 4, at the engine: omitting HkdfParams.salt really is a TypeError here', async () => {
  const k = await S.importKey('raw', new Uint8Array(32), 'HKDF', false, ['deriveBits']);
  await assert.rejects(
    () => S.deriveBits({ name: 'HKDF', hash: 'SHA-256', info: new Uint8Array(0) }, k, 256),
    'if this ever stops throwing, rule 4 has become engine-specific and the ADR must say so'
  );
  const ok = await S.deriveBits(hkdf(NO_SALT, INFO.backup), k, 256);
  assert.equal(ok.byteLength, 32);
});

test('the AAD is always non-empty and the IV is always 12 bytes — refused otherwise', () => {
  assert.throws(() => aesgcm(new Uint8Array(11), TE.encode('aad')), /12 bytes/);
  assert.throws(() => aesgcm(new Uint8Array(12), new Uint8Array(0)), /non-empty/);
  const p = aesgcm(new Uint8Array(12), TE.encode('aad'));
  assert.equal(p.tagLength, 128);
});

test('RULE 2 is a guard: a zero-length payload is refused before WebCrypto sees it', () => {
  assert.throws(() => assertSignable(new Uint8Array(0), 'x'), /zero-length/);
  assert.equal(assertSignable(TE.encode('a'), 'x').length, 1);
});

test('RULE 5 is encoded as a frozen empty array, and a non-empty one really is refused', async () => {
  assert.deepEqual([...USAGES.peerKex], []);
  assert.equal(Object.isFrozen(USAGES.peerKex), true);
  const kex = await S.generateKey(KEX, true, [...USAGES.kex]);
  const raw = new Uint8Array(await S.exportKey('raw', kex.publicKey));
  await assert.rejects(
    () => S.importKey('raw', raw, KEX, true, ['deriveBits']),
    'a peer ECDH public key with a non-empty usage list must be refused (ADR 002 §1 rule 5)'
  );
  const ok = await identity.importKexPublic(raw);
  assert.equal(ok.type, 'public');
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Known-answer tests — the DETERMINISTIC halves only (rule 1)
// ═════════════════════════════════════════════════════════════════════════════

test('KAT · SHA-256 matches the published vectors, in core/ids.js AND in WebCrypto', async () => {
  for (const v of SHA256_VECTORS) {
    assert.equal(toHex(sha256(v.input)), v.hex, 'core/ids.js sha256');
    assert.equal(toHex(await S.digest('SHA-256', v.input)), v.hex, 'WebCrypto digest');
  }
});

test('KAT · core/ids.js SHA-256 and the platform digest are the SAME FUNCTION', async () => {
  // The failure this catches is the one no vector test alone can: `core/ids.js` carries a
  // hand-rolled SHA-256 because the authorization fold may not await. If it and the engine ever
  // disagreed on some input, every deviceShort in the product would be wrong, silently.
  for (let n = 0; n <= 200; n += 7) {
    const input = Uint8Array.from({ length: n }, (_, i) => (i * 31 + n) % 256);
    assert.equal(toHex(sha256(input)), toHex(await S.digest('SHA-256', input)), `length ${n}`);
  }
  // …and across the 55/56/64-byte padding boundaries, where a hand-rolled SHA-256 breaks first.
  for (const n of [54, 55, 56, 57, 63, 64, 65, 119, 120, 128]) {
    const input = new Uint8Array(n).fill(0xab);
    assert.equal(toHex(sha256(input)), toHex(await S.digest('SHA-256', input)), `boundary ${n}`);
  }
});

test('KAT · HKDF-SHA-256 reproduces RFC 5869 test case 1, in WebCrypto and in a second impl', async () => {
  const c = HKDF_RFC5869_CASE1;
  assert.equal(toHex(pureHkdf(c.salt, c.ikm, c.info, c.length)), c.okm, 'the reference implementation');
  const k = await S.importKey('raw', c.ikm, 'HKDF', false, ['deriveBits']);
  const okm = await S.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: c.salt, info: c.info }, k, c.length * 8);
  assert.equal(toHex(okm), c.okm, 'WebCrypto');
  assert.equal(toHex(hmacSha256(c.salt, c.ikm)), c.prk, 'the extract step');
});

test('KAT · HKDF under the product\'s own info labels agrees between the two implementations', async () => {
  const ikm = new Uint8Array(32).fill(9);
  const salt = hex('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff');
  const k = await S.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  for (const label of Object.values(INFO)) {
    const wc = await S.deriveBits(hkdf(salt, label), k, 256);
    assert.equal(toHex(wc), toHex(pureHkdf(salt, ikm, TE.encode(label), 32)), label);
  }
  // Different labels MUST give different keys — that is the whole point of domain separation.
  const a = toHex(await S.deriveBits(hkdf(salt, INFO.pairCk), k, 256));
  const b = toHex(await S.deriveBits(hkdf(salt, INFO.pairKek), k, 256));
  assert.notEqual(a, b);
});

test('KAT · PBKDF2-SHA-256 matches the published vector and the second implementation', async () => {
  // RFC-style vector: P="password", S="salt", c=4096, dkLen=32.
  const expected = 'c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a';
  const pw = TE.encode('password');
  const salt = TE.encode('salt');
  assert.equal(toHex(purePbkdf2(pw, salt, 4096, 32)), expected, 'the reference implementation');
  const k = await S.importKey('raw', pw, 'PBKDF2', false, ['deriveBits']);
  const wc = await S.deriveBits(pbkdf2Params(salt, 4096), k, 256);
  assert.equal(toHex(wc), expected, 'WebCrypto');
});

test('KAT · Crockford base32 and deviceShort are pinned — they are wire format', () => {
  for (const v of CROCK32_VECTORS) assert.equal(crock32(v.input), v.out);
  for (const v of DEVICE_SHORT_VECTORS) {
    assert.equal(identity.deviceShortOf(v.input), v.short, v.name);
    assert.equal(identity.deviceShortOf(v.input).length, DEVICE_SHORT_CHARS);
    assert.equal(identity.deviceShortOfB64u(b64u(v.input)), v.short, `${v.name} via b64u`);
  }
  // ADR 001 §1.2/§8.1: every Crockford character sorts at or above '0', which is what makes the
  // all-zeros short a true minimum and the GENESIS stamp of a migration lose to every real one.
  assert.equal(ZERO_DEVICE_SHORT.length, DEVICE_SHORT_CHARS);
  for (const v of DEVICE_SHORT_VECTORS) assert.ok(ZERO_DEVICE_SHORT <= v.short);
});

test('deviceShortOf is the SYNC hand-rolled digest and deviceShortOfAsync the engine\'s — equal', async () => {
  for (const v of DEVICE_SHORT_VECTORS) {
    assert.equal(await identity.deviceShortOfAsync(v.input), v.short, v.name);
  }
  const kp = await S.generateKey(SIG, true, ['sign', 'verify']);
  const raw = await identity.exportRawPublic(kp.publicKey);
  assert.equal(identity.deviceShortOf(raw), await identity.deviceShortOfAsync(raw));
});

test('deviceShortOfB64u returns null — never throws — on peer-shaped rubbish', () => {
  // Every caller of this is looking at data from another machine. External input is refused,
  // not thrown on; a throw here would abort a whole sync pass over one bad register.
  for (const bad of ['', 'not base64!!', '!!!!', b64u(new Uint8Array(64)), b64u(new Uint8Array(66))]) {
    assert.equal(identity.deviceShortOfB64u(bad), null, JSON.stringify(bad).slice(0, 24));
  }
  assert.equal(identity.deviceShortOfB64u(b64u(new Uint8Array(65))), 'K3745QQFA7A04TEN');
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. The probe — and WHERE it may not run
// ═════════════════════════════════════════════════════════════════════════════

test('probeCrypto reports all five rows true on this engine, and usable', async () => {
  const r = await probeCrypto();
  assert.equal(r.ok, true);
  assert.equal(r.suite, SUITE_ID);
  for (const row of PROBE_ROWS) assert.equal(r[row], true, row);
  assert.deepEqual([...r.missing], []);
  assert.equal(isSuiteAvailable(r), true);
});

test('probeCrypto reports ok:false, not a throw, when there is no SubtleCrypto', async () => {
  const r = await probeCrypto({ subtle: undefined });
  assert.equal(r.ok, false);
  assert.match(r.why, /SubtleCrypto/);
  assert.equal(isSuiteAvailable(r), false);
  assert.deepEqual([...r.missing], [...PROBE_ROWS]);
});

test('a crippled engine is reported row by row — and `ok` alone is NOT the gate', async () => {
  // The whole point of the two booleans. A caller gating on `ok` would enable family mode on an
  // engine that has crypto.subtle and no ECDH.
  const crippled = {
    generateKey: (alg, ...rest) => (alg?.name === 'ECDH' ? Promise.reject(new Error('nope')) : S.generateKey(alg, ...rest)),
    importKey: (...a) => S.importKey(...a),
    deriveBits: (...a) => S.deriveBits(...a),
  };
  const r = await probeCrypto({ subtle: crippled });
  assert.equal(r.ok, true, 'there IS a SubtleCrypto');
  assert.equal(r.ecdh, false);
  assert.equal(r.ecdsa, true);
  assert.equal(r.usable, false, 'but the suite is not available');
  assert.deepEqual([...r.missing], ['ecdh']);
  assert.equal(isSuiteAvailable(r), false);
});

test('RULE 3: the probe never reads an error name — a thrown string is still just `false`', async () => {
  // Node says InvalidAccessException where WebKit says InvalidAccessError. A probe that inspected
  // `err.name` would work on one engine and misreport on the other. Throwing a bare string has no
  // `.name` at all, so anything that reached for one would break here.
  const hostile = {
    // eslint-disable-next-line no-throw-literal
    generateKey: () => { throw 'not an Error object'; },
    importKey: () => Promise.reject(null),
    deriveBits: () => Promise.reject(undefined),
  };
  const r = await probeCrypto({ subtle: hostile });
  assert.equal(r.ok, true);
  assert.deepEqual([...r.missing], [...PROBE_ROWS]);
  assert.equal(r.usable, false);
});

test('the unavailable message says what the user can act on, and never names an algorithm', async () => {
  const r = await probeCrypto({ subtle: undefined });
  const m = unavailableMessage(r);
  assert.match(m.de, /Familienkreis/);
  assert.match(m.de, /nicht betroffen/, 'it must say the existing board is unaffected');
  for (const word of ['ECDH', 'ECDSA', 'AES', 'HKDF', 'PBKDF2', 'SubtleCrypto']) {
    assert.equal(m.de.includes(word), false, `the copy must not say ${word}`);
    assert.equal(m.en.includes(word), false, `the copy must not say ${word}`);
  }
  await assert.rejects(async () => unavailableMessage(await probeCrypto()), /nothing to say/);
});

test('PRINCIPLE 7: nothing under src/js/crypto/ is reachable from the boot or first-run graph', () => {
  // ADR 002 §2.4 — "First run mints only a memberId and a deviceShort. NO KEYGEN, NO PROBE, NO
  // NETWORK." An `import` is evaluated whether or not anyone calls the function, so the honest
  // form of that promise is a statement about the module graph. This is the enforcement.
  for (const entry of ['src/js/boot.js', 'src/js/firstrun.js', 'src/js/main.js']) {
    const chain = pathToPrefix(entry, 'src/js/crypto/');
    assert.equal(chain, null, chain ? `solo mode reaches crypto: ${chain.join(' -> ')}` : '');
  }
  // And the walker really can find one, so a green result above means something.
  const reached = reachableFrom('src/js/crypto/identity.js').reached;
  assert.ok(reached.includes('src/js/core/ids.js'), 'the import walker found nothing at all');
  assert.equal(pathToPrefix('src/js/crypto/identity.js', 'src/js/crypto/')[0], 'src/js/crypto/identity.js');
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Keys: shapes, sizes, and non-extractability
// ═════════════════════════════════════════════════════════════════════════════

test('device keys are NON-extractable and exporting the private half REJECTS', async () => {
  const { devSig, devKex } = await identity.generateDeviceKeys();
  assert.equal(DEVICE_KEY_EXTRACTABLE, false);
  assert.equal(devSig.privateKey.extractable, false);
  assert.equal(devKex.privateKey.extractable, false);
  // The private bytes never enter the JS heap at all. This is the property everything in ADR 002
  // §2.2 is built on, and §8.2 is honest that it prevents EXFILTRATION, not USE.
  await assert.rejects(() => S.exportKey('pkcs8', devSig.privateKey));
  await assert.rejects(() => S.exportKey('jwk', devSig.privateKey));
  await assert.rejects(() => S.exportKey('pkcs8', devKex.privateKey));
  // The public halves are still exportable — they have to travel.
  assert.equal((await identity.exportRawPublic(devSig.publicKey)).length, RAW_PUBKEY_BYTES);
});

test('recovery keys ARE extractable, because §7.2 must be able to seal them', async () => {
  const { recSig, recKex } = await identity.generateRecoveryKeys();
  assert.equal(RECOVERY_KEY_EXTRACTABLE, true);
  assert.equal(recSig.privateKey.extractable, true);
  assert.equal(recKex.privateKey.extractable, true);
  assert.equal((await S.exportKey('pkcs8', recSig.privateKey)).byteLength, PKCS8_P256_BYTES);
});

test('the export sizes ADR 002 §9.2 measured are what this engine produces', async () => {
  const kp = await S.generateKey(SIG, true, ['sign', 'verify']);
  assert.equal((await S.exportKey('raw', kp.publicKey)).byteLength, RAW_PUBKEY_BYTES, 'raw 65');
  assert.equal((await S.exportKey('spki', kp.publicKey)).byteLength, SPKI_P256_BYTES, 'spki 91');
  assert.equal((await S.exportKey('pkcs8', kp.privateKey)).byteLength, PKCS8_P256_BYTES, 'pkcs8 138');
  assert.equal((await S.exportKey('jwk', kp.publicKey)).crv, 'P-256');
  // RULE 6's arithmetic, spelled out: 138 is not a multiple of 8.
  assert.notEqual(PKCS8_P256_BYTES % 8, 0);
});

test('RULE 6: AES-KW really does refuse a P-256 private key, and AES-GCM does not', async () => {
  // The trap the rule names: X25519/Ed25519 PKCS#8 is 48 bytes and DOES wrap, so a 25519
  // prototype of the key store would have worked and shipped a P-256 build that could store
  // nothing. This row is the tripwire for anyone who "simplifies" wrapping back to AES-KW.
  const kp = await S.generateKey(SIG, true, ['sign', 'verify']);
  const kw = await S.generateKey({ name: 'AES-KW', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  await assert.rejects(() => S.wrapKey('pkcs8', kp.privateKey, kw, 'AES-KW'));

  const gcm = await S.generateKey({ name: 'AES-GCM', length: 256 }, false, [...USAGES.kek]);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(AEAD.ivBytes));
  const wrapped = await S.wrapKey('pkcs8', kp.privateKey, gcm, { name: 'AES-GCM', iv, tagLength: 128 });
  assert.equal(wrapped.byteLength, WRAPPED_PKCS8_BYTES, '138 PKCS#8 + 16 GCM tag');
});

test('RULE 1: two signatures over the same bytes DIFFER — no golden-signature fixture is possible', async () => {
  const { recSig } = await identity.generateRecoveryKeys();
  const msg = TE.encode('the same message, twice');
  const a = await identity.signBytes(recSig.privateKey, msg);
  const b = await identity.signBytes(recSig.privateKey, msg);
  assert.equal(a.length, 64, 'P1363 r||s, not DER');
  assert.notEqual(b64u(a), b64u(b), 'ECDSA is non-deterministic in BOTH engines (ADR 002 §1 rule 1)');
  // The only correct assertion about a signature:
  assert.equal(await identity.verifyBytes(recSig.publicKey, a, msg), true);
  assert.equal(await identity.verifyBytes(recSig.publicKey, b, msg), true);
});

test('RULE 2, at the seam: signBytes and verifyBytes refuse an empty payload', async () => {
  const { recSig } = await identity.generateRecoveryKeys();
  await assert.rejects(() => identity.signBytes(recSig.privateKey, new Uint8Array(0)), /zero-length/);
  await assert.rejects(
    () => identity.verifyBytes(recSig.publicKey, new Uint8Array(64), new Uint8Array(0)),
    /zero-length/
  );
});

test('verifyBytes returns false for a bad OR malformed signature — it never throws', async () => {
  const { recSig } = await identity.generateRecoveryKeys();
  const msg = TE.encode('hello');
  const sig = await identity.signBytes(recSig.privateKey, msg);
  assert.equal(await identity.verifyBytes(recSig.publicKey, sig, TE.encode('hellp')), false);
  const flipped = sig.slice();
  flipped[0] ^= 0xff;
  assert.equal(await identity.verifyBytes(recSig.publicKey, flipped, msg), false);
  assert.equal(await identity.verifyBytes(recSig.publicKey, new Uint8Array(3), msg), false, 'wrong length');
  const other = await identity.generateRecoveryKeys();
  assert.equal(await identity.verifyBytes(other.recSig.publicKey, sig, msg), false, 'wrong key');
});

test('RULE 3, observed: this engine\'s error name is not WebKit\'s, so nothing may read it', async () => {
  // Recorded, not branched on. Node: InvalidAccessException. WebKit: InvalidAccessError.
  // `tests/tier2/crypto-identity.dom.js` asserts the other half of this sentence.
  const { devSig } = await identity.generateDeviceKeys();
  let name = null;
  try {
    await S.exportKey('pkcs8', devSig.privateKey);
  } catch (err) {
    name = err && err.name;
  }
  assert.ok(name, 'exporting a non-extractable key must throw something');
  assert.match(name, /^InvalidAccess(Error|Exception)$/,
    `unexpected error name ${name} — the point stands either way: do not branch on it`);
});

test('both engines validate a P-256 point before scalar multiplication (ADR 002 §9.2)', async () => {
  const kex = await S.generateKey(KEX, true, [...USAGES.kex]);
  const raw = new Uint8Array(await S.exportKey('raw', kex.publicKey));
  const offCurve = raw.slice();
  offCurve[64] ^= 0x01; // a valid x with a forged y
  await assert.rejects(() => identity.importKexPublic(offCurve), 'off-curve point');
  await assert.rejects(() => identity.importKexPublic(new Uint8Array(1)), 'point at infinity');
  const p384 = await S.generateKey({ name: 'ECDH', namedCurve: 'P-384' }, true, ['deriveBits']);
  const raw384 = new Uint8Array(await S.exportKey('raw', p384.publicKey));
  await assert.rejects(() => identity.importKexPublic(raw384), 'a P-384 key offered as P-256');
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. The device attestation (ADR 002 §2.3)
// ═════════════════════════════════════════════════════════════════════════════

test('an attestation carries exactly the six fields §2.3 fixes, and deviceShort is DERIVED', async () => {
  const m = await makeMember();
  assert.deepEqual(Object.keys(m.attestation).sort(), [...identity.ATTESTATION_FIELDS].sort());
  assert.equal(m.attestation.memberId, m.memberId);
  assert.equal(m.attestation.deviceId, m.deviceId);
  assert.equal(m.attestation.createdAt, DAY);
  assert.equal(ub64(m.attestation.sigPubRaw).length, RAW_PUBKEY_BYTES);
  assert.equal(ub64(m.attestation.kexPubRaw).length, RAW_PUBKEY_BYTES);
  // Derived, never accepted from a caller — the only way P2 can hold for a blob we mint.
  assert.equal(m.attestation.deviceShort, identity.deviceShortOfB64u(m.attestation.sigPubRaw));
  assert.equal(m.attestation.deviceShort, m.identity.deviceShort);
});

test('the blob is b64u(canonicalJSON(att)) + "." + b64u(sig), and core/authz.js parses it', async () => {
  const m = await makeMember();
  const [payload, sig] = m.blob.split('.');
  assert.equal(m.blob.split('.').length, 2, 'base64url never contains a dot, so the split is unambiguous');
  assert.deepEqual([...ub64(payload)], [...canonicalBytes(m.attestation)]);
  assert.equal(ub64(sig).length, 64);
  // ONE decoder in the product. `core/authz.js` is the fold's; crypto/ uses the same one rather
  // than a second that could disagree.
  assert.deepEqual({ ...parseAttestationBlob(m.blob) }, { ...m.attestation });
});

test('verifyAttestation returns the PAYLOAD, not a boolean — openOp has no other key source', async () => {
  const m = await makeMember();
  const back = await identity.verifyAttestation(m.blob, m.rec.recSig.publicKey);
  assert.notEqual(back, null);
  assert.deepEqual({ ...back }, { ...m.attestation });
  // §5.2.1 correction 1: with `att === null` there is no key to verify a signature WITH, which
  // is exactly why the attestation gate sits AHEAD of the decrypt.
  assert.equal(typeof back.sigPubRaw, 'string');
});

test('verifyAttestation returns null — never throws — for every way a blob can be wrong', async () => {
  const m = await makeMember();
  const other = await identity.generateRecoveryKeys();
  const [payload, sig] = m.blob.split('.');

  const cases = {
    'the wrong recovery key': [m.blob, other.recSig.publicKey],
    'no dot': [payload, m.rec.recSig.publicKey],
    'empty payload half': [`.${sig}`, m.rec.recSig.publicKey],
    'empty signature half': [`${payload}.`, m.rec.recSig.publicKey],
    'not base64url': ['!!!.!!!', m.rec.recSig.publicKey],
    'not a string': [null, m.rec.recSig.publicKey],
    'a number': [42, m.rec.recSig.publicKey],
    'truncated signature': [`${payload}.${b64u(ub64(sig).slice(0, 30))}`, m.rec.recSig.publicKey],
  };
  for (const [name, args] of Object.entries(cases)) {
    assert.equal(await identity.verifyAttestation(...args), null, name);
  }
});

test('a tampered payload fails: the signature covers all six fields, kexPubRaw included', async () => {
  // R4-15a. `kexPubRaw` is the KEY-AGREEMENT point — the exact value §4.2 wraps the space key to.
  // A verifier that could disagree about it and still be believed is a key-injection channel.
  const m = await makeMember();
  for (const field of identity.ATTESTATION_FIELDS) {
    const swapped = { ...m.attestation };
    swapped[field] = field === 'createdAt' ? '2020-01-01' : `${m.attestation[field]}X`;
    const forged = `${b64u(canonicalBytes(swapped))}.${m.blob.split('.')[1]}`;
    assert.equal(await identity.verifyAttestation(forged, m.rec.recSig.publicKey), null, field);
  }
});

test('an attestation with EXTRA fields still verifies — a v2.1 blob stays readable by v2.0', async () => {
  // Verification is over the ORIGINAL payload bytes, not a re-canonicalisation of the six fields
  // `parseAttestationBlob` keeps. Re-serialising would silently drop the extras and fail every
  // forward-compatible blob, which is the same version-skew discipline the rest of v2 uses.
  const m = await makeMember();
  const extended = { ...m.attestation, futureField: 'from v2.1' };
  const payload = canonicalBytes(extended);
  const sig = await identity.signBytes(m.rec.recSig.privateKey, payload);
  const blob = `${b64u(payload)}.${b64u(sig)}`;
  const back = await identity.verifyAttestation(blob, m.rec.recSig.publicKey);
  assert.notEqual(back, null, 'a v2.1 attestation must stay readable');
  assert.deepEqual(Object.keys(back).sort(), [...identity.ATTESTATION_FIELDS].sort(), 'but only six are interpreted');
});

test('P2 is enforced on the way IN as well as OUT: an inconsistent short is never signed', async () => {
  const m = await makeMember();
  const lying = { ...m.attestation, deviceShort: ZERO_DEVICE_SHORT };
  await assert.rejects(
    () => identity.attestDevice(lying, m.rec.recSig.privateKey),
    /could never pass/,
    'minting a blob that cannot pass P2 is our own bug and must be loud'
  );
  assert.equal(identity.attestationSelfConsistent(lying), false);
  assert.equal(identity.attestationSelfConsistent(m.attestation), true);
});

test('P2 is enforced on the way OUT: a validly-signed but inconsistent blob verifies to null', async () => {
  // The contract raised this from SHOULD to MUST (2026-08-27, finding I-3): the authorization
  // fold cannot check it — it is pure and synchronous and P2 is a SHA-256 — so this is the only
  // place `att.deviceShort` is ever bound to `att.sigPubRaw`.
  const m = await makeMember();
  const lying = { ...m.attestation, deviceShort: ZERO_DEVICE_SHORT };
  const payload = canonicalBytes(lying);
  const sig = await identity.signBytes(m.rec.recSig.privateKey, payload);
  const blob = `${b64u(payload)}.${b64u(sig)}`;
  assert.equal(parseAttestationBlob(blob) !== null, true, 'it parses — the shape is fine');
  assert.equal(await identity.verifyAttestation(blob, m.rec.recSig.publicKey), null, 'P2 refuses it');
});

test('I-3 / R5-7 IS STILL OPEN: P2 does NOT stop a squatter copying a peer\'s public key', async () => {
  // This row exists so the hole cannot be re-planned away. `sigPubRaw` is a PUBLIC key travelling
  // in the victim's own register, inside the E2EE stream every member can read. Mallory copies
  // it, tells the TRUTH about it, files it under HER OWN member record — and passes P2 with room
  // to spare, because P2 asks only "is this short the short of this key?".
  //
  // What this file's design therefore ASSUMES, explicitly: nothing in `src/js/crypto/` closes
  // I-3, and nothing downstream may be built as though it does. Closing it needs a FIRST-CLAIM
  // binding on the pair `(sigPubRaw, deviceShort)` at fold time — option (a) in FINDINGS §4.5 —
  // which is `src/js/core/authz.js`'s decision and is not made here.
  const victim = await makeMember();
  const mallory = await makeMember();

  const squat = {
    memberId: mallory.memberId,          // TRUE: her own record
    deviceId: mkDeviceId(),              // TRUE: her own invented label
    deviceShort: victim.attestation.deviceShort,   // the victim's short
    sigPubRaw: victim.attestation.sigPubRaw,       // the victim's PUBLIC signing key, copied verbatim
    kexPubRaw: mallory.attestation.kexPubRaw,
    createdAt: DAY,
  };
  assert.equal(identity.attestationSelfConsistent(squat), true, 'P2 is satisfied — that is the finding');

  const blob = await identity.attestDevice(squat, mallory.rec.recSig.privateKey);
  const opened = await identity.verifyAttestation(blob, mallory.rec.recSig.publicKey);
  assert.notEqual(opened, null, 'and it verifies under HER OWN recovery key, which is condition (4)');
  assert.equal(opened.deviceShort, victim.attestation.deviceShort);
  assert.notEqual(opened.memberId, victim.memberId, 'two member records now claim one short');
});

test('a copied attestation filed under the WRONG member is caught by condition (4)', async () => {
  // The other half of §2.3: copying a peer's blob VERBATIM into one's own record fails, because
  // the caller must pass the HOUSING member's recovery key and the signature will not verify
  // under it. That is what stops the naive copy — and it is not what I-3 is about.
  const victim = await makeMember();
  const mallory = await makeMember();
  assert.equal(await identity.verifyAttestation(victim.blob, mallory.rec.recSig.publicKey), null);
  assert.notEqual(await identity.verifyAttestation(victim.blob, victim.rec.recSig.publicKey), null);
});

test('a deviceId is a LABEL: an attestation carrying a peer\'s deviceId is fully valid', async () => {
  // ADR 002 §2.3 "A deviceId is a label, not an identity" — enumerated against the four
  // acceptance conditions, `deviceId` is bound by NONE of them. There is no fifth condition to
  // add, and the fix was to remove the forgeable resolver rather than guard it. This row pins
  // that the crypto layer does not pretend otherwise.
  const victim = await makeMember();
  const mallory = await makeMember();
  const copied = { ...mallory.attestation, deviceId: victim.attestation.deviceId };
  const blob = await identity.attestDevice(copied, mallory.rec.recSig.privateKey);
  const back = await identity.verifyAttestation(blob, mallory.rec.recSig.publicKey);
  assert.notEqual(back, null, 'all four conditions pass — nothing binds deviceId');
  assert.equal(back.deviceId, victim.attestation.deviceId);
  assert.notEqual(back.deviceShort, victim.attestation.deviceShort, 'the SHORT still differs — that is the identity');
});

test('attestOpenFrom keys on the HOUSING member and the register bytes together', async () => {
  const m = await makeMember();
  const table = new Map([[identity.attestOpenKey(m.memberId, m.blob), m.attestation]]);
  const open = identity.attestOpenFrom(table);
  assert.deepEqual({ ...open(m.memberId, m.blob) }, { ...m.attestation });
  assert.equal(open('mem_someone_else', m.blob), null, 'never keyed on the payload\'s own memberId');
  assert.equal(open(m.memberId, 'other.blob'), null);
});

test('buildDeviceAttestation refuses a clock read: createdAt is injected or it throws', async () => {
  const { devSig, devKex } = await identity.generateDeviceKeys();
  const who = { memberId: mkMemberId(), deviceId: mkDeviceId() };
  await assert.rejects(() => identity.buildDeviceAttestation(who, devSig.publicKey, devKex.publicKey), /INJECTED/);
  await assert.rejects(
    () => identity.buildDeviceAttestation({ ...who, createdAt: '27.08.2026' }, devSig.publicKey, devKex.publicKey),
    /YYYY-MM-DD/
  );
  const ok = await identity.buildDeviceAttestation({ ...who, createdAt: DAY }, devSig.publicKey, devKex.publicKey);
  assert.equal(ok.createdAt, DAY);
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Custody — the KeyStore port
// ═════════════════════════════════════════════════════════════════════════════

test('memKeyStore is a KeyStore and is honest that it stores nothing durable', async () => {
  const ks = memKeyStore();
  assert.equal(await ks.get('nope'), null);
  await ks.put('a', new Uint8Array([1, 2, 3]));
  assert.deepEqual([...(await ks.get('a'))], [1, 2, 3]);
  await ks.put('b', new Uint8Array([4]));
  assert.deepEqual(await ks.list(), ['a', 'b']);
  await ks.del('a');
  assert.equal(await ks.get('a'), null);
  await ks.del('a'); // deleting something absent is not an error
  assert.deepEqual(await ks.list(), ['b']);
  await assert.rejects(() => ks.put('c', null), /nothing/);
  await assert.rejects(() => ks.get(''), /non-empty/);
  // A fresh store shares nothing with the old one — the property tier 2 has to prove is FALSE
  // of IndexedDB, and that is the whole asymmetry.
  assert.equal(await memKeyStore().get('b'), null);
});

test('RULE 7: Node has no indexedDB, so idbKeyStore refuses rather than pretending', () => {
  assert.equal(typeof globalThis.indexedDB, 'undefined', 'Node 22 has no indexedDB (ADR 002 §1 rule 7)');
  assert.equal(globalThis.isSecureContext, undefined, 'and isSecureContext is undefined here, NOT false');
  assert.throws(() => idbKeyStore({ factory: undefined }), KeyStoreUnavailableError);
  assert.throws(() => idbKeyStore({ factory: undefined }), /memKeyStore/);
});

test('chooseKeyStore names what it gave you, because "memory" means nothing survives a quit', () => {
  const chosen = chooseKeyStore({ factory: undefined });
  assert.equal(chosen.kind, 'memory');
  assert.equal(typeof chosen.store.put, 'function');
  // A pairing flow that ran against a memory store would produce an attestation for a key that
  // will not exist tomorrow, so the kind is reported rather than hidden behind a duck type.
  const fake = { open: () => ({}), deleteDatabase: () => ({}) };
  assert.equal(chooseKeyStore({ factory: fake }).kind, 'indexeddb');
});

test('ensureDeviceIdentity mints once and is idempotent thereafter', async () => {
  const ks = memKeyStore();
  const memberId = mkMemberId();
  const deviceId = mkDeviceId();
  const first = await identity.ensureDeviceIdentity(ks, memberId, { deviceId, createdAt: DAY });
  assert.equal(first.memberId, memberId);
  assert.equal(first.deviceId, deviceId);
  assert.equal(first.deviceShort.length, DEVICE_SHORT_CHARS);
  assert.equal(first.devSig.privateKey.extractable, false);
  assert.deepEqual(await ks.list(), ['lzp/v2/dev/kex', 'lzp/v2/dev/meta', 'lzp/v2/dev/sig']);

  // The second call must NOT need deviceId/createdAt, and must not mint a second identity.
  const again = await identity.ensureDeviceIdentity(ks, memberId);
  assert.equal(again.deviceShort, first.deviceShort);
  assert.equal(again.deviceId, first.deviceId);
  assert.equal(again.createdAt, DAY);
});

test('ensureDeviceIdentity REFUSES a partial store rather than forking this Mac\'s identity', async () => {
  const ks = memKeyStore();
  const memberId = mkMemberId();
  await identity.ensureDeviceIdentity(ks, memberId, { deviceId: mkDeviceId(), createdAt: DAY });
  await ks.del('lzp/v2/dev/meta');
  // Silently regenerating here would mint a SECOND deviceShort for a Mac that already has an
  // attested one — every op the old short authored would suddenly be from a device nobody
  // attested. A loud failure is strictly better.
  await assert.rejects(() => identity.ensureDeviceIdentity(ks, memberId, { deviceId: mkDeviceId(), createdAt: DAY }),
    /partial identity/);
});

test('ensureDeviceIdentity refuses to re-point an existing device at a different member', async () => {
  const ks = memKeyStore();
  const mine = mkMemberId();
  await identity.ensureDeviceIdentity(ks, mine, { deviceId: mkDeviceId(), createdAt: DAY });
  await assert.rejects(() => identity.ensureDeviceIdentity(ks, mkMemberId()), /already belongs to member/);
});

test('ensureDeviceIdentity refuses a store whose short does not match its stored key', async () => {
  const ks = memKeyStore();
  const memberId = mkMemberId();
  const id = await identity.ensureDeviceIdentity(ks, memberId, { deviceId: mkDeviceId(), createdAt: DAY });
  await ks.put('lzp/v2/dev/meta', canonicalBytes({
    memberId, deviceId: id.deviceId, deviceShort: ZERO_DEVICE_SHORT, createdAt: DAY,
  }));
  await assert.rejects(() => identity.ensureDeviceIdentity(ks, memberId), /store is corrupt/);
});

test('ensureRecoveryIdentity is idempotent and refuses to regenerate — §8.12 has no revocation', async () => {
  const ks = memKeyStore();
  const memberId = mkMemberId();
  const first = await identity.ensureRecoveryIdentity(ks, memberId, { createdAt: DAY });
  const again = await identity.ensureRecoveryIdentity(ks, memberId);
  const rawA = new Uint8Array(await S.exportKey('raw', first.recSig.publicKey));
  const rawB = new Uint8Array(await S.exportKey('raw', again.recSig.publicKey));
  assert.equal(b64u(rawA), b64u(rawB), 'the same recovery key came back');
  await ks.del('lzp/v2/rec/kex');
  await assert.rejects(() => identity.ensureRecoveryIdentity(ks, memberId, { createdAt: DAY }), /cannot be revoked/);
});

test('ensureAttestedDevice mints, attests and verifies in one step (§6.3 step 8, §7.3 step 4)', async () => {
  const m = await makeMember();
  assert.equal(m.identity.deviceShort, m.attestation.deviceShort);
  const back = await identity.verifyAttestation(m.blob, m.rec.recSig.publicKey);
  assert.notEqual(back, null);
  // A RESTORED member gets FRESH device keys on the new machine — never a restored device
  // identity. A device is a machine, not a person (§7.3 step 3).
  const second = await identity.ensureAttestedDevice(memKeyStore(), m.memberId, m.rec.recSig.privateKey, {
    deviceId: mkDeviceId(), createdAt: DAY,
  });
  assert.notEqual(second.attestation.deviceShort, m.attestation.deviceShort);
  assert.equal(second.attestation.memberId, m.memberId, 'same member, second machine');
});

test('the KeyStore port is checked: a duck-typed half-store is refused', async () => {
  await assert.rejects(() => identity.ensureDeviceIdentity({ get: () => null }, 'mem_x'), /get\/put\/del\/list/);
  await assert.rejects(() => identity.ensureDeviceIdentity(null, 'mem_x'), /get\/put\/del\/list/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. The Keychain backstop and the file store
// ═════════════════════════════════════════════════════════════════════════════

/** The three shell commands, in a Map. Mirrors keychain_set/get/delete exactly. */
function fakeKeychainInvoke(map = new Map()) {
  return async (cmd, args) => {
    if (cmd === 'keychain_get') return map.has(args.key) ? map.get(args.key) : null;
    if (cmd === 'keychain_set') { map.set(args.key, args.value); return null; }
    if (cmd === 'keychain_delete') { map.delete(args.key); return null; }
    throw new Error(`unknown command: ${cmd}`);
  };
}

test('keychainPort speaks exactly the three commands the shell implements', async () => {
  const map = new Map();
  const kc = keychainPort(fakeKeychainInvoke(map));
  assert.equal(await kc.get('k'), null, 'absent reads as null, not undefined');
  await kc.set('k', 'value');
  assert.equal(await kc.get('k'), 'value');
  await kc.set('k', 'value2');
  assert.equal(await kc.get('k'), 'value2', 'set is idempotent — a re-pair rewrites in place');
  await kc.del('k');
  assert.equal(await kc.get('k'), null);
  await kc.del('k'); // deleting something absent is success
  await assert.rejects(() => kc.set('k', 42), /must be a string/);
  assert.throws(() => keychainPort(null), /must be a function/);
});

test('ensureDek mints a 32-byte key once and returns the same one thereafter', async () => {
  const map = new Map();
  const kc = keychainPort(fakeKeychainInvoke(map));
  const dek = await ensureDek(kc);
  assert.equal(dek.length, SYMMETRIC_KEY_BYTES);
  assert.equal(b64u(await ensureDek(kc)), b64u(dek));
  assert.equal(map.size, 1);
  assert.equal([...map.keys()][0], KEYCHAIN_ACCOUNTS.dek);
});

test('ensureDek refuses to overwrite a wrong-length DEK — that would orphan what it wraps', async () => {
  const map = new Map([[KEYCHAIN_ACCOUNTS.dek, b64u(new Uint8Array(16))]]);
  await assert.rejects(() => ensureDek(keychainPort(fakeKeychainInvoke(map))), KeyStoreUnavailableError);
  assert.equal(map.get(KEYCHAIN_ACCOUNTS.dek), b64u(new Uint8Array(16)), 'and it really did not overwrite');
});

/** An in-memory stand-in for the byte port `fileKeyStore` writes through. */
function memBytes(map = new Map()) {
  return {
    read: async (k) => (map.has(k) ? map.get(k) : null),
    write: async (k, v) => void map.set(k, v),
    remove: async (k) => void map.delete(k),
    keys: async () => [...map.keys()],
    raw: map,
  };
}

test('fileKeyStore round-trips an EXTRACTABLE pair through AES-GCM-wrapped PKCS#8', async () => {
  const bytes = memBytes();
  const dek = await ensureDek(keychainPort(fakeKeychainInvoke()));
  const ks = fileKeyStore(bytes, { dek });
  const { recSig, recKex } = await identity.generateRecoveryKeys();

  await ks.put('lzp/v2/rec/sig', recSig);
  await ks.put('lzp/v2/rec/kex', recKex);
  assert.deepEqual(await ks.list(), ['lzp/v2/rec/kex', 'lzp/v2/rec/sig']);

  const backSig = await ks.get('lzp/v2/rec/sig');
  const msg = TE.encode('round trip');
  const sig = await identity.signBytes(backSig.privateKey, msg);
  assert.equal(await identity.verifyBytes(backSig.publicKey, sig, msg), true, 'the restored key signs');
  // …and the ORIGINAL public key verifies it, so it is the same key and not merely a working one.
  assert.equal(await identity.verifyBytes(recSig.publicKey, sig, msg), true);

  const backKex = await ks.get('lzp/v2/rec/kex');
  const shared = await S.deriveBits({ name: 'ECDH', public: recKex.publicKey }, backKex.privateKey, 256);
  assert.equal(shared.byteLength, 32);
});

test('fileKeyStore stores raw bytes too, and nothing is written in plaintext but them', async () => {
  const bytes = memBytes();
  const dek = await ensureDek(keychainPort(fakeKeychainInvoke()));
  const ks = fileKeyStore(bytes, { dek });
  await ks.put('lzp/v2/dev/meta', canonicalBytes({ memberId: 'mem_x' }));
  assert.deepEqual([...(await ks.get('lzp/v2/dev/meta'))], [...canonicalBytes({ memberId: 'mem_x' })]);

  const { recSig } = await identity.generateRecoveryKeys();
  await ks.put('lzp/v2/rec/sig', recSig);
  const written = bytes.raw.get('lzp/v2/rec/sig');
  const pkcs8 = b64u(new Uint8Array(await S.exportKey('pkcs8', recSig.privateKey)));
  assert.equal(written.includes(pkcs8), false, 'the private key must never appear unwrapped');
  const rec = JSON.parse(written);
  assert.equal(ub64(rec.priv.k).length, WRAPPED_PKCS8_BYTES);
  assert.equal(ub64(rec.priv.iv).length, AEAD.ivBytes);
});

test('fileKeyStore REFUSES a non-extractable device key — that refusal is the tripwire', async () => {
  // `wrapKey` needs the key to be extractable, and IK_sig/IK_kex are generated extractable:false
  // precisely so no code path can turn them into bytes. A device key reaching a file store would
  // mean the guarantee had already been given up upstream.
  const dek = await ensureDek(keychainPort(fakeKeychainInvoke()));
  const ks = fileKeyStore(memBytes(), { dek });
  const { devSig } = await identity.generateDeviceKeys();
  await assert.rejects(() => ks.put('lzp/v2/dev/sig', devSig), KeyStoreUnavailableError);
  await assert.rejects(() => ks.put('lzp/v2/dev/sig', devSig), /idbKeyStore/);
});

test('fileKeyStore needs a real 32-byte DEK and a complete byte port', async () => {
  assert.throws(() => fileKeyStore(memBytes(), { dek: new Uint8Array(16) }), /32-byte DEK/);
  assert.throws(() => fileKeyStore({ read: () => null }, { dek: new Uint8Array(32) }), /must implement/);
});

test('a wrong DEK cannot unwrap — AES-GCM fails the tag, it does not return garbage', async () => {
  const bytes = memBytes();
  const dek = await ensureDek(keychainPort(fakeKeychainInvoke()));
  await fileKeyStore(bytes, { dek }).put('lzp/v2/rec/sig', (await identity.generateRecoveryKeys()).recSig);
  const wrong = new Uint8Array(dek);
  wrong[0] ^= 0xff;
  // There is no "wrong key, right plaintext" degradation path anywhere in this design
  // (ADR 002 §3 barrier 3) — it is an OperationError, in both engines.
  await assert.rejects(() => fileKeyStore(bytes, { dek: wrong }).get('lzp/v2/rec/sig'));
});
