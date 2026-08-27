// TIER 2 · LZP-302 — KEY CUSTODY, PHASE 1 OF 2: write.  ADR 002 §2.2.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE QUESTION THESE TWO FILES ANSWER, AND WHY IT NEEDED TWO FILES
// ═════════════════════════════════════════════════════════════════════════════
//
// ADR 002 §2.2 chose non-extractable `CryptoKey`s in IndexedDB as the PRIMARY custody for device
// keys, and left one thing explicitly unverified:
//
//   > VERIFICATION ITEM for LZP-302 — do not assume. Confirm with a real `--test` run that a
//   > non-extractable `CryptoKey` in IndexedDB PERSISTS ACROSS AN APP RELAUNCH under the
//   > `app://localhost` scheme. If it does not, fall back to `identity.enc` in Application
//   > Support, AES-GCM-wrapped under the Keychain `DEK`, with `extractable: true` device keys —
//   > and record the downgrade in DESIGN-DECISIONS.md, because it is a real reduction in T3
//   > resistance.
//
// "Across a relaunch" cannot be tested inside one process. `tests/run-dom-tests.sh` launches the
// built .app ONCE PER FILE, in glob order, each in a fresh process — so two files whose names
// sort in order ARE two launches, and that is exactly the shape this needs. Phase 1 writes and
// its process exits; phase 2 is a new process that reads.
//
// The two are therefore a PAIR and only mean anything run together, which is what `npm run
// test:dom` does. Phase 2 refuses to pass on a stale receipt (it checks freshness) rather than
// skipping when phase 1 has not run — a skip here would report "no evidence" as "fine", which is
// the one outcome that would make this whole exercise worthless.
//
// ISOLATION, IN THREE LAYERS, AND THE THIRD ONE IS WHY THIS TEST EXPOSED A REAL BUG.
//   1. `--scratch` redirects the app's DATA directory; the runner fingerprints the user's real
//      board before and after.
//   2. `tests/run-dom-tests.sh` re-identifies the test build as `org.langzeitplaner.domtest`, so
//      WebKit's own website data store — keyed on the BUNDLE IDENTIFIER — is separate from the
//      installed app's. Before that change, every tier-2 run shared it.
//   3. A test-only database name, deleted here before writing and again by phase 2. Nothing here
//      goes near `langzeitplaner-keys`, the name the shipping app uses.
//
// Layer 2 exists BECAUSE of what this file found. A `CryptoKey` in IndexedDB is encrypted under a
// per-application "WebCrypto master key" that WebKit keeps in the LOGIN KEYCHAIN, in an item whose
// ACL is bound to the code signature of the binary that created it. Rebuild the app — a new
// cdhash, or an updater swapping the bundle — and WebKit can no longer read it. It says
// `Cannot store WebCrypto master key, error -25299` on the process's stderr, where the page
// cannot see it, and every persisted CryptoKey then deserialises to **null**. Plain values in the
// same database survive untouched, which is what makes it so hard to spot. The runner clears that
// item for the TEST bundle id before each run; clearing the production one would have orphaned a
// real installation's device keys, which is the damage the whole isolation apparatus exists to
// prevent. See the report for LZP-302 — this has a consequence for LZP-102's updater.

const keystore = await importApp('platform/keystore.js');
const identity = await importApp('crypto/identity.js');
const ids = await importApp('core/ids.js');
const b64 = await importApp('core/b64.js');

/** NOT keystore.IDB_DB_NAME. The shipping database must never be what a test writes into. */
const TEST_DB = 'lzp-tier2-keystore-probe';
const DAY = '2026-08-27';

const store = keystore.idbKeyStore({ dbName: TEST_DB });

test('phase 1 starts from nothing: the probe database is deleted before anything is written', async () => {
  // Without this, a second `npm run test:dom` would read the PREVIOUS run's keys and phase 2
  // would pass on evidence that predates the code under test.
  await store.destroy();
  const empty = keystore.idbKeyStore({ dbName: TEST_DB });
  assert.deepEqual(await empty.list(), [], 'the probe database must start empty');
  assert.equal(await empty.get('lzp/v2/dev/sig'), null);
});

test('a NON-EXTRACTABLE CryptoKeyPair can be structured-cloned into IndexedDB at all', async () => {
  // This is the first half of the verification item, and it is not a formality: WebKit wraps a
  // serialised CryptoKey under a WebCrypto master key it fetches from the login Keychain, and
  // when that fetch fails the put rejects with a DataCloneError that says nothing about
  // keychains. `idbKeyStore.put` turns that into a typed KeyStoreUnavailableError; if this test
  // ever fails with one, the Keychain is the place to look, not the crypto.
  const { devSig, devKex } = await identity.generateDeviceKeys();
  assert.equal(devSig.privateKey.extractable, false, 'precondition: the key really is non-extractable');
  await store.put('lzp/v2/dev/sig', devSig);
  await store.put('lzp/v2/dev/kex', devKex);
  assert.deepEqual(await store.list(), ['lzp/v2/dev/kex', 'lzp/v2/dev/sig']);
});

test('a key read back WITHIN this process is still non-extractable and still signs', async () => {
  // The same-process half. Phase 2 does the cross-process half; both are needed, because a
  // structured clone that survives in memory but not on disk would pass one and fail the other.
  const back = await store.get('lzp/v2/dev/sig');
  assert.notEqual(back, null);
  assert.equal(Object.prototype.toString.call(back.privateKey), '[object CryptoKey]');
  assert.equal(back.privateKey.extractable, false, 'the clone must not have made it extractable');
  const msg = new TextEncoder().encode('same process');
  const sig = await identity.signBytes(back.privateKey, msg);
  assert.equal(await identity.verifyBytes(back.publicKey, sig, msg), true);
  let threw = false;
  try { await crypto.subtle.exportKey('pkcs8', back.privateKey); } catch (e) { threw = true; diag('export -> ' + e.name); }
  assert.equal(threw, true, 'exporting the restored private key must REJECT');
});

test('phase 1 writes the full device identity plus a fresh receipt for phase 2', async () => {
  // A whole `ensureDeviceIdentity` through the real store, not just a bare key: what phase 2 has
  // to prove survives is the three-record identity the pairing flow actually creates.
  //
  // NOTE the two bare keys written above are cleared first, one by one — NOT with `destroy()`.
  // `deleteDatabase` is asynchronous and can be BLOCKED by a connection that has not finished
  // closing; a delete issued here would land after these writes and take them with it, and phase
  // 2 would then report "the keys did not survive the relaunch" for a reason that has nothing to
  // do with relaunching. Deleting records is synchronous within its transaction and has no such
  // window.
  const memberId = ids.memberId();
  const deviceId = ids.deviceId();
  const fresh = store;
  await fresh.del('lzp/v2/dev/sig');
  await fresh.del('lzp/v2/dev/kex');
  assert.deepEqual(await fresh.list(), [], 'the probe database is empty again before the real write');
  const id = await identity.ensureDeviceIdentity(fresh, memberId, { deviceId, createdAt: DAY });
  assert.equal(id.devSig.privateKey.extractable, false);
  assert.equal(id.deviceShort.length, 16);

  const raw = await identity.exportRawPublic(id.devSig.publicKey);
  assert.equal(identity.deviceShortOf(raw), id.deviceShort, 'P2 holds for the key just minted');

  // The receipt carries what phase 2 needs to check that this identity is THIS run's, plus a
  // wall-clock stamp so a stale database from a previous run cannot be mistaken for evidence.
  const receipt = new TextEncoder().encode(JSON.stringify({
    writtenAt: Date.now(),
    memberId,
    deviceId,
    deviceShort: id.deviceShort,
    sigPubRaw: b64.b64u(raw),
    kexPubRaw: b64.b64u(await identity.exportRawPublic(id.devKex.publicKey)),
  }));
  await fresh.put('phase1/receipt', receipt);

  const keys = await fresh.list();
  assert.deepEqual(keys, ['lzp/v2/dev/kex', 'lzp/v2/dev/meta', 'lzp/v2/dev/sig', 'phase1/receipt']);
  diag('phase 1 wrote deviceShort ' + id.deviceShort + ' into IndexedDB database ' + TEST_DB);
  diag('this process now exits; crypto-keystore-phase2.dom.js is a SEPARATE launch');
});
