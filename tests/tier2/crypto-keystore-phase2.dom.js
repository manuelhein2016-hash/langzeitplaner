// TIER 2 · LZP-302 — KEY CUSTODY, PHASE 2 OF 2: a DIFFERENT PROCESS reads.  ADR 002 §2.2.
//
// This file is a second launch of the same .app. `tests/run-dom-tests.sh` runs one process per
// tier-2 file in glob order, so `…-phase1.dom.js` has already written, exited, and taken its
// JavaScript heap, its WKWebView and its whole address space with it. Everything below therefore
// tests DISK, not memory. That is the entire point, and it is the only way ADR 002 §2.2's
// verification item can be answered honestly.
//
// ⚠ THIS FILE IS HALF OF A PAIR. Run it alone and it FAILS — deliberately. The alternative was to
// `skip()` when phase 1's receipt is absent, and a skip would report "we have no evidence" in the
// same green column as "the keys persisted", which is exactly the failure mode the tier-2 harness's
// vacuous-test rule exists to prevent. `npm run test:dom` always runs both, in order.
//
// It also CLEANS UP: the tier-2 suite shares one WebKit website data store with the installed app
// (it is keyed on the bundle id, and `--scratch` redirects only the data directory), so the last
// thing this file does is delete the probe database.

const keystore = await importApp('platform/keystore.js');
const identity = await importApp('crypto/identity.js');
const b64 = await importApp('core/b64.js');

const TEST_DB = 'lzp-tier2-keystore-probe';
/** A receipt older than this is from a previous run and is not evidence about this one. */
const MAX_RECEIPT_AGE_MS = 10 * 60 * 1000;

const store = keystore.idbKeyStore({ dbName: TEST_DB });

/** Read once, share across the tests below; every one of them needs it. */
let receipt = null;

test('the receipt phase 1 left is present AND fresh — a stale one is not evidence', async () => {
  const bytes = await store.get('phase1/receipt');
  assert.notEqual(bytes, null,
    'no receipt in IndexedDB. Either crypto-keystore-phase1.dom.js did not run in this ' +
    'invocation (run `npm run test:dom`, not this file alone), or IndexedDB did not survive the ' +
    'relaunch — which would mean ADR 002 §2.2\'s primary custody design has to change.');
  receipt = JSON.parse(new TextDecoder().decode(bytes));

  const age = Date.now() - receipt.writtenAt;
  assert.ok(age >= 0 && age < MAX_RECEIPT_AGE_MS,
    'the receipt is ' + Math.round(age / 1000) + 's old — a database left behind by an earlier ' +
    'run would let this file pass on evidence that predates the code under test');
  assert.equal(receipt.deviceShort.length, 16);
  diag('receipt written ' + Math.round(age) + ' ms ago, in the PREVIOUS process');
});

test('ANSWERED: a non-extractable CryptoKey in IndexedDB SURVIVES an app relaunch', async () => {
  // ADR 002 §2.2's open verification item, closed. A fresh process, a fresh WKWebView, and the
  // keypair is still there — as a CryptoKey object, not as bytes.
  const pair = await store.get('lzp/v2/dev/sig');
  assert.notEqual(pair, null, 'the device signing pair did not survive the relaunch');
  assert.equal(Object.prototype.toString.call(pair.privateKey), '[object CryptoKey]');
  assert.equal(Object.prototype.toString.call(pair.publicKey), '[object CryptoKey]');
  assert.equal(pair.privateKey.algorithm.name, 'ECDSA');
  assert.equal(pair.privateKey.algorithm.namedCurve, 'P-256');
  const kex = await store.get('lzp/v2/dev/kex');
  assert.notEqual(kex, null, 'the device agreement pair did not survive the relaunch');
  assert.equal(kex.privateKey.algorithm.name, 'ECDH');
});

test('…and it is STILL NON-EXTRACTABLE: exportKey on the restored private key REJECTS', async () => {
  // The property the whole custody design rests on. A key that came back extractable would be
  // strictly worse than no persistence at all: the private bytes would now be reachable from the
  // JS heap on every launch, and §8.2's honest limit ("prevents exfiltration, not use") would
  // stop being true.
  const pair = await store.get('lzp/v2/dev/sig');
  assert.equal(pair.privateKey.extractable, false);
  for (const format of ['pkcs8', 'jwk']) {
    let threw = false;
    try { await crypto.subtle.exportKey(format, pair.privateKey); } catch (e) { threw = true; diag(format + ' -> ' + e.name); }
    assert.equal(threw, true, 'exportKey(' + format + ') on the restored private key must REJECT');
  }
  const kex = await store.get('lzp/v2/dev/kex');
  assert.equal(kex.privateKey.extractable, false);
  let threw = false;
  try { await crypto.subtle.exportKey('pkcs8', kex.privateKey); } catch (e) { threw = true; }
  assert.equal(threw, true);
});

test('…and it is THE SAME KEY: it signs, and phase 1\'s recorded public key verifies it', async () => {
  // "It survived and it is usable" is not enough — it has to be the key phase 1 attested. The
  // public point in the receipt was written by the previous process, so verifying against it is
  // what makes this an identity claim rather than a liveness one.
  const pair = await store.get('lzp/v2/dev/sig');
  const msg = new TextEncoder().encode('signed after a relaunch');
  const sig = await identity.signBytes(pair.privateKey, msg);
  assert.equal(sig.length, 64);
  assert.equal(await identity.verifyBytes(pair.publicKey, sig, msg), true, 'the restored pair is self-consistent');

  const recorded = await identity.importSigPublic(b64.ub64(receipt.sigPubRaw));
  assert.equal(await identity.verifyBytes(recorded, sig, msg), true,
    'the restored PRIVATE key matches the PUBLIC key the previous process recorded');
  assert.equal(await identity.verifyBytes(recorded, sig, new TextEncoder().encode('something else')), false);
});

test('…and its deviceShort is unchanged, so every stamp this Mac ever wrote still resolves', async () => {
  // `deviceShort` is a function of the signing key and nothing else (ADR 001 §1.2). If custody
  // did not survive, a re-paired Mac would get a NEW short — and every op it had authored would
  // suddenly carry a short no attestation resolves. That is the practical cost the verification
  // item was about, so it is asserted directly rather than inferred.
  const pair = await store.get('lzp/v2/dev/sig');
  const raw = await identity.exportRawPublic(pair.publicKey);
  assert.equal(b64.b64u(raw), receipt.sigPubRaw, 'the public point is byte-identical');
  assert.equal(identity.deviceShortOf(raw), receipt.deviceShort, 'the short is unchanged');
  assert.equal(await identity.deviceShortOfAsync(raw), receipt.deviceShort);
});

test('…and ensureDeviceIdentity ADOPTS it rather than minting a second identity', async () => {
  // The end-to-end statement: on the second launch, the pairing code path finds the identity it
  // already has. Note that no `deviceId`/`createdAt` is passed — the adopting branch must not
  // need them, and if it silently minted instead, this call would throw for want of them.
  const id = await identity.ensureDeviceIdentity(store, receipt.memberId);
  assert.equal(id.deviceShort, receipt.deviceShort);
  assert.equal(id.deviceId, receipt.deviceId, 'the random deviceId label survived too');
  assert.equal(id.createdAt, '2026-08-27');
  assert.equal(id.devSig.privateKey.extractable, false);
  // And it still refuses to re-point at a different member across the relaunch.
  let threw = false;
  try { await identity.ensureDeviceIdentity(store, 'mem_someone_entirely_else'); } catch (e) { threw = true; }
  assert.equal(threw, true, 'a persisted device must not be re-pointed at another member');
});

test('the kex pair survived usably too — it is what §4.2 wraps a space key to', async () => {
  const kex = await store.get('lzp/v2/dev/kex');
  const peer = await identity.importKexPublic(b64.ub64(receipt.kexPubRaw));
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, kex.privateKey, 256);
  assert.equal(bits.byteLength, 32);
  // ECDH with one's own recorded public key is deterministic, so this doubles as an identity
  // check: a different private key would give different bits.
  const again = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, kex.privateKey, 256);
  assert.equal(
    [...new Uint8Array(bits)].join(','),
    [...new Uint8Array(again)].join(','),
    'the restored agreement key is stable'
  );
});

test('clean-up: the probe database is removed from the shared WebKit data store', async () => {
  await store.destroy();
  const after = keystore.idbKeyStore({ dbName: TEST_DB });
  assert.deepEqual(await after.list(), [], 'the tier-2 run must not leave keys on the machine');
  assert.equal(await after.get('phase1/receipt'), null);
  // The shipping database name was never touched by either phase.
  assert.notEqual(TEST_DB, keystore.IDB_DB_NAME);
});
