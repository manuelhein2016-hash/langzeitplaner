// TIER 2 · LZP-305 — backup v2 inside the REAL WKWebView.  ADR 002 §7.2 / §7.3 · D8 · A2.
//
// WHY THIS FILE EXISTS SEPARATELY FROM `tests/tier1/crypto-backup.test.js`.
// `npm test` proves the design in Node. The shipping app runs JavaScriptCore inside WKWebView
// under `app://localhost`, and ADR 002 §1's whole table of engine-difference rules exists because
// the two disagree in ways no compatibility table records. Backup v2 walks into four of them at
// once — PBKDF2, HKDF, AES-GCM and a PKCS#8 → JWK → public-key reconstruction — and it is the one
// module whose bug is silent AND permanent: a file that seals correctly here and opens nowhere is
// discovered years later by someone who has already lost the Mac.
//
// THE THREE THINGS ONLY THIS FILE CAN PROVE:
//
//   1. **A file written by Node opens in WebKit, byte for byte.** `FIXTURE` below is a REAL backup
//      produced by `exportBackup` under Node 22 with a pinned salt and IV. If WebKit's PBKDF2,
//      HKDF, AES-GCM or canonical-JSON bytes differed from Node's by one bit, the GCM tag would
//      fail and this file would go red. Nothing else in the suite asserts that.
//   2. **The cross-engine KDF vector.** The whole chain
//      `PBKDF2-SHA-256 → HKDF-SHA-256('lzp/v2/backup') → AES-256-GCM` is pinned to hexadecimal
//      computed in Node — at 4 096 rounds and at the shipped 600 000.
//   3. **Engine difference 9 and resolution 4 in WebKit.** `importKey('pkcs8', …)` of a P-256
//      private key with `verify` in the usages must be refused HERE too, and `exportKey('jwk')`
//      of that private key must carry `x` and `y` — which is how the public halves come back.
//
// THE FIXTURE CONTAINS REAL, SEALED PRIVATE KEYS AND THAT IS FINE: they were generated for this
// file, they belong to no member, they protect nothing, and they are under a passphrase written
// three lines below. Nothing about them is a secret — which is precisely why they can sit in a
// repository, and precisely why a REAL backup may not.
//
// No IndexedDB: custody and persistence are `crypto-keystore-phase{1,2}.dom.js`, which need two
// launches. This file uses `memKeyStore()` so it leaves nothing behind and can run in any order.
//
// NO GOLDEN SIGNATURES (rule 1). The pinned hexadecimal below is AES-GCM ciphertext under a fixed
// key, IV and AAD, which IS deterministic in both engines — that is what makes a vector possible
// here and impossible for ECDSA.

const backup = await importApp('crypto/backup.js');
const suite = await importApp('crypto/suite.js');
const identity = await importApp('crypto/identity.js');
const keystore = await importApp('platform/keystore.js');
const ids = await importApp('core/ids.js');
const b64 = await importApp('core/b64.js');

const S = crypto.subtle;
const TE = new TextEncoder();
const DAY = '2026-08-27';
const toHex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

/** The passphrase `FIXTURE` was sealed under. Not a secret — see the header. */
const FIXTURE_PW = 'Tier-Zwei-Passwort';

// ─────────────────────────────────────────────────────────────────────────────
// A real backup file, produced by Node 22 with `salt = 0x5a…`, `iv = 0x3c…` and 2 048 rounds
// (2 048 rather than 600 000 only so this file stays fast; the shipped count is exercised by the
// KDF vector below). Regenerating it is a deliberate act: if it ever has to be replaced, the
// replacement must be produced by Node and pasted here, or the cross-engine claim evaporates.
// ─────────────────────────────────────────────────────────────────────────────
const FIXTURE = {
  _README_de: "DIES IST DEIN SCHLÜSSEL. Wer diese Datei und dein Passwort hat, ist du. Ohne diese Datei und ohne deine Macs sind die Daten unwiederbringlich — niemand sonst hat die Schlüssel.",
  _README_en: "THIS FILE IS YOUR KEY. Whoever has this file and your password is you. Without this file and without your Macs the data is gone for good — nobody else holds the keys.",
  format: 'langzeitplaner-backup',
  v: 2,
  exportedAt: '2026-08-27',
  app: '2.0.0',
  board: {
      "schemaVersion": 2,
      "notes": [
          {
              "id": "n1",
              "date": "2026-09-01",
              "text": "Zahnarzt",
              "categoryId": "c1",
              "repeatsYearly": false,
              "visibility": "privat",
              "coEdit": false
          }
      ],
      "bars": [
          {
              "id": "b1",
              "startDate": "2026-10-01",
              "endDate": "2026-10-14",
              "label": "Urlaub",
              "categoryId": "c1",
              "visibility": "belegt",
              "coEdit": false
          }
      ],
      "categories": [
          {
              "id": "c1",
              "name": "Arbeit",
              "nameEn": "Work",
              "paletteRef": "blau",
              "visible": true
          }
      ],
      "scratchpads": {
          "2026-09": "Hütte buchen?"
      },
      "settings": {
          "bundesland": "BY",
          "layers": {
              "feiertage": true
          }
      }
  },
  identity: {
    kdf: {"name": "PBKDF2", "hash": "SHA-256", "iterations": 2048, "salt": "WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo"},
    memberId: 'mem_T1er2F1xtur3M3mb3rAAAA',
    sealed:
      'PDw8PDw8PDw8PDw8G1XK2x-QEmzSd93b5KgG_B9WP1iYLIZ0FUZAbnWidu1m5Hoz_IlvZSvLRFWve0kQ4kjdnV_x44lKdtbV' +
      'q-e_6pn1idjMGTdM2TA5xiFQSkm4Am7T-3XUZaULa7zLef33GeDSAwr45G1_R7_y2SINXLbntnVVDxWLdOPPwhbFxuc52E5O' +
      'V9I78HhfDa7KBNfjWkeah22NmqcPCtBl3Cpr_sk9iZ6R3cK6ANwrkWUOFLb7WbyfJH4Tfgp1z1K5eXwDowjLlTeUEUPu5EUT' +
      'N4JJuIGtegH0MOuKYik61c59yJmeKM2AZ_DCu5QKo54oLfTM_8AykHIY86rtOAeI_oSxl_gmmEDTQH2C37sUHQIuxYUO7o3L' +
      'Zwlz09XS5-Ysdf0GjHRLKU7Z6CbXcnhcYxj5htVcNBHAn3QPYe-bc8G47FyJH6Zj1qw9ZKuFgBV_DhrKbbz04f7zU1P5Tbdv' +
      'mcUtTf3op5WtXCJVgU-Qs_TZMsVcnZGbDZLHO1e1iUCgfYPwOil2iAC1Nnw3pl6MqWmGAaq6PArXuDTS1pkiXV43l3ITadLH' +
      'd-BEAMZ6al-rvO-FlhektQdeYSrQJi0JSWegYdzLBhSLr8W2KUj5LSdB2G-mE4NRs1TdlRkkTYMp2JOvdlu2bukUbBOHt8-Q' +
      'lCitlD2UYlU4qB8T9IysnzBKc-e3H7fc1TWXq-oWEhrzscy6vfietPy7aNp7YGJMthiE2UV2NLpXrutAiocb2RUZFEPiAg5C' +
      'F1E34WH_uaqDkajkGigAvpxF3cjfkmIs79dQcsbdCNTwOKJsSJDAlFBdt6tv9r-Lv4b9bskvX-zbdWBOtlNuPhK7HvLVagHz' +
      't7DDhqNRAgleiJHtUuKqe28R9Yt-jB5jaFZlOAdAwvzBgWH01JlENqmQvLjQ2WxBTWZMadGaIFnw',
  },
};

/** The two cross-engine vectors, computed in Node 22 (see this file's header, point 2). */
const KDF_VECTOR = Object.freeze({
  salt: Uint8Array.from({ length: 32 }, (_, i) => i),
  iv: new Uint8Array(12).fill(0x2a),
  aad: TE.encode('lzp/v2/test/kat'),
  plaintext: TE.encode('LZP'),
  at4096: '16bcf5ffd80f9da9dceadb39a6e37558786ad6',
  at600000: '862dde50273ecc053874ce95abdbe6fb304450',
  passphrase: 'Ein Passwort mit ÄÖÜ',
});

const clone = (o) => JSON.parse(JSON.stringify(o));

async function makeMember() {
  const ks = keystore.memKeyStore();
  const memberId = ids.memberId();
  const rec = await identity.ensureRecoveryIdentity(ks, memberId, { createdAt: DAY });
  const minted = await identity.ensureAttestedDevice(ks, memberId, rec.recSig.privateKey, {
    deviceId: ids.deviceId(), createdAt: DAY,
  });
  const ek = async () => S.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  return {
    ks,
    memberId,
    identity: { ...minted.identity, recSig: rec.recSig, recKex: rec.recKex },
    spaces: {
      personal: { id: 'psp_T3st2P3rs0nalSpac3AAAA', epochs: new Map([[1, await ek()]]) },
      family: { id: 'fsp_T3st2Fam1lySpac3AAAAAA', epoch: 2, epochs: new Map([[1, await ek()], [2, await ek()]]) },
    },
  };
}

function makeBoard(me) {
  return {
    schemaVersion: 2,
    notes: [
      { id: 'n1', date: '2026-09-01', text: 'Zahnarzt', categoryId: 'c1', repeatsYearly: false,
        visibility: 'privat', coEdit: false, ownerId: me, isForeign: false, _born: '1|2|' + 'A'.repeat(16) },
      { id: 'fnote:mem_N4chb4rN4chb4rAAAAAAAA/n2', date: '2026-09-02', text: 'NICHT MEINS',
        ownerId: 'mem_N4chb4rN4chb4rAAAAAAAA', isForeign: true },
    ],
    bars: [{ id: 'b1', startDate: '2026-10-01', endDate: '2026-10-14', label: 'Urlaub',
             categoryId: 'c1', visibility: 'belegt', coEdit: false, ownerId: me }],
    categories: [{ id: 'c1', name: 'Arbeit', nameEn: 'Work', paletteRef: 'blau', visible: true }],
    scratchpads: { '2026-09': 'Hütte buchen?' },
    settings: { bundesland: 'BY', layers: { feiertage: true } },
  };
}

/** `assert.rejects`, which this harness does not have. Returns the error for further assertions. */
async function rejects(fn, what) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err !== null, what + ' did not reject');
  return err;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. A Node-made file opens here — the claim nothing else in the suite makes
// ═════════════════════════════════════════════════════════════════════════════

test('a backup written by Node opens in WebKit, and every field comes back intact', async () => {
  const seen = backup.inspectBackup(clone(FIXTURE));
  assert.equal(seen.hasIdentity, true);
  assert.equal(seen.needsPassphrase, true);
  assert.equal(seen.memberId, 'mem_T1er2F1xtur3M3mb3rAAAA');
  assert.equal(seen.kdf.iterations, 2048);
  assert.deepEqual(seen.counts, { notes: 1, bars: 1, categories: 1 });

  const r = await backup.importBackup(clone(FIXTURE), FIXTURE_PW, keystore.memKeyStore(), {
    deviceId: ids.deviceId(), createdAt: DAY,
  });
  assert.equal(r.identityRestored, true);
  assert.equal(r.identity.memberId, 'mem_T1er2F1xtur3M3mb3rAAAA');
  assert.equal(r.board.notes[0].text, 'Zahnarzt');
  assert.equal(r.board.notes[0].visibility, 'privat');
  assert.equal(r.board.bars[0].visibility, 'belegt');
  assert.equal(r.board.scratchpads['2026-09'], 'Hütte buchen?');

  // The epoch keys were pinned to 0x11 / 0x21 / 0x22 when the fixture was made, so their BYTES
  // are checkable here — this is the assertion that says WebKit's AES-GCM and HKDF agree with
  // Node's, not merely that something decrypted.
  assert.equal(toHex(await S.exportKey('raw', r.spaces.personal.epochs.get(1))), '11'.repeat(32));
  assert.equal(toHex(await S.exportKey('raw', r.spaces.family.epochs.get(1))), '21'.repeat(32));
  assert.equal(toHex(await S.exportKey('raw', r.spaces.family.epochs.get(2))), '22'.repeat(32));
  assert.equal(r.spaces.family.epoch, 2);
});

test('the fixture still carries the copy this build ships — if it drifts, so did the AAD', () => {
  // The README is inside the AES-GCM AAD, so a change to `README.withIdentity` does NOT break an
  // existing file (its own header is what gets bound) — but it DOES mean every new file says
  // something different. This is the tripwire that makes that a deliberate act.
  assert.equal(FIXTURE._README_de, backup.README.withIdentity.de);
  assert.equal(FIXTURE._README_en, backup.README.withIdentity.en);
  assert.equal(FIXTURE.format, backup.BACKUP_FORMAT);
  assert.equal(FIXTURE.v, backup.BACKUP_V);
});

test('a Node-made file whose header was altered is refused HERE too — the AAD binds in both engines', async () => {
  const f = clone(FIXTURE);
  f.identity.memberId = 'mem_J3m4ndAnd3r3sAAAAAAAAA';
  const err = await rejects(
    () => backup.importBackup(f, FIXTURE_PW, keystore.memKeyStore(), { deviceId: ids.deviceId(), createdAt: DAY }),
    'a relabelled memberId'
  );
  assert.equal(err.code, 'cannot-open');
  assert.ok(err.say.de.length > 0);

  const g = clone(FIXTURE);
  const raw = b64.ub64(g.identity.sealed);
  raw[raw.length - 1] ^= 0x01;
  g.identity.sealed = b64.b64u(raw);
  const err2 = await rejects(
    () => backup.importBackup(g, FIXTURE_PW, keystore.memKeyStore(), { deviceId: ids.deviceId(), createdAt: DAY }),
    'a flipped tag byte'
  );
  assert.equal(err2.code, 'cannot-open');
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. The KDF chain, pinned across engines
// ═════════════════════════════════════════════════════════════════════════════

test('CROSS-ENGINE VECTOR: PBKDF2 → HKDF(lzp/v2/backup) → AES-GCM matches Node at 4 096 rounds', async () => {
  const key = await backup.deriveBackupKey(KDF_VECTOR.passphrase, KDF_VECTOR.salt, 4096);
  const ct = await S.encrypt(
    { name: 'AES-GCM', iv: KDF_VECTOR.iv, additionalData: KDF_VECTOR.aad, tagLength: 128 },
    key, KDF_VECTOR.plaintext
  );
  assert.equal(toHex(ct), KDF_VECTOR.at4096,
    'WebKit derived a different key from Node — every backup would open on one engine only');
});

test('CROSS-ENGINE VECTOR: the same chain at the SHIPPED 600 000 rounds', async () => {
  // The number that actually ships (D8, the OWASP 2023 floor). Paid once, here, because a vector
  // at a test-only iteration count would not prove the shipped parameter.
  const t0 = performance.now();
  const key = await backup.deriveBackupKey(KDF_VECTOR.passphrase, KDF_VECTOR.salt, suite.BACKUP_KDF.iterations);
  const ms = performance.now() - t0;
  diag('600 000 PBKDF2-SHA-256 rounds in WKWebView: ' + ms.toFixed(0) + ' ms');
  const ct = await S.encrypt(
    { name: 'AES-GCM', iv: KDF_VECTOR.iv, additionalData: KDF_VECTOR.aad, tagLength: 128 },
    key, KDF_VECTOR.plaintext
  );
  assert.equal(toHex(ct), KDF_VECTOR.at600000);
  assert.equal(suite.BACKUP_KDF.iterations, 600000);
  // A cost the user waits through, once, behind a sheet they clicked. If this ever crossed a few
  // seconds the sheet would need a progress state, so the number is reported rather than assumed.
  assert.ok(ms < 8000, '600 000 rounds took ' + ms.toFixed(0) + ' ms — the export sheet would need a spinner');
});

test('the HKDF label is load-bearing in this engine too', async () => {
  const a = await backup.deriveBackupKey('pw', KDF_VECTOR.salt, 512);
  const enc = async (k) => toHex(await S.encrypt(
    { name: 'AES-GCM', iv: KDF_VECTOR.iv, additionalData: KDF_VECTOR.aad, tagLength: 128 }, k, KDF_VECTOR.plaintext));
  const real = await enc(a);

  // The same PBKDF2 output, expanded under a DIFFERENT label, must be a different key.
  const pw = await S.importKey('raw', TE.encode('pw'), 'PBKDF2', false, ['deriveBits']);
  const bits = await S.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: KDF_VECTOR.salt, iterations: 512 }, pw, 256);
  const ikm = await S.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const other = await S.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: KDF_VECTOR.salt, info: TE.encode(suite.INFO.spaceKeyWrap) },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  assert.notEqual(await enc(other), real, 'the info label changed nothing — domain separation is not real here');

  // …and the same label reproduces it exactly.
  const same = await S.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: KDF_VECTOR.salt, info: TE.encode(suite.INFO.backup) },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  assert.equal(await enc(same), real);
});

test('RULE 4 in this engine: an HKDF call with no salt is a TypeError, so the salt is positional', async () => {
  const ikm = await S.importKey('raw', new Uint8Array(32), 'HKDF', false, ['deriveBits']);
  const err = await rejects(
    () => S.deriveBits({ name: 'HKDF', hash: 'SHA-256', info: TE.encode('x') }, ikm, 256),
    'HKDF without a salt'
  );
  assert.ok(err instanceof TypeError, 'expected a TypeError, got ' + err.name);
  // …which is exactly why `suite.hkdf()` refuses `undefined` in our own words first.
  let ours = null;
  try { suite.hkdf(undefined, suite.INFO.backup); } catch (e) { ours = e; }
  assert.ok(ours !== null);
  assert.match(ours.message, /salt is MANDATORY/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Engine difference 9 and the public-key reconstruction (resolution 4)
// ═════════════════════════════════════════════════════════════════════════════

test('ENGINE DIFFERENCE 9 holds in WebKit: a P-256 private key may not carry `verify`', async () => {
  const m = await makeMember();
  const pkcs8 = new Uint8Array(await S.exportKey('pkcs8', m.identity.recSig.privateKey));
  assert.equal(pkcs8.length, suite.PKCS8_P256_BYTES);

  const e1 = await rejects(() => S.importKey('pkcs8', pkcs8, suite.SIG, true, ['sign', 'verify']), "['sign','verify']");
  const e2 = await rejects(() => S.importKey('pkcs8', pkcs8, suite.SIG, true, ['verify']), "['verify']");
  diag('WebKit says: ' + e1.name + ' / ' + e2.name);   // recorded for the rule-3 file, never branched on

  const ok = await S.importKey('pkcs8', pkcs8, suite.SIG, true, [...suite.USAGES.sigPrivate]);
  assert.equal(ok.type, 'private');
  assert.deepEqual(ok.usages, ['sign']);
});

test('RESOLUTION 4 in WebKit: a private EC JWK carries x and y, so the public half is recoverable', async () => {
  // The whole restore path rests on this. If WebKit omitted `x`/`y` from a private EC JWK export,
  // `importBackup` could not rebuild a `CryptoKeyPair` at all — and the failure would be a
  // `DataError` from the LAST step of a recovery, on a Mac whose owner has nothing else left.
  const m = await makeMember();
  for (const [who, kp, algo] of [['recSig', m.identity.recSig, suite.SIG], ['recKex', m.identity.recKex, suite.KEX]]) {
    const jwk = await S.exportKey('jwk', kp.privateKey);
    assert.equal(jwk.kty, 'EC', who);
    assert.equal(jwk.crv, 'P-256', who);
    assert.equal(typeof jwk.x, 'string', who + ' has no x');
    assert.equal(typeof jwk.y, 'string', who + ' has no y');
    assert.equal(typeof jwk.d, 'string', who + ' has no d');

    const usages = algo === suite.SIG ? [...suite.USAGES.peerSig] : [...suite.USAGES.peerKex];
    const pub = await S.importKey('jwk', { crv: jwk.crv, ext: true, kty: jwk.kty, x: jwk.x, y: jwk.y }, algo, true, usages);
    const a = new Uint8Array(await S.exportKey('raw', pub));
    const b = new Uint8Array(await S.exportKey('raw', kp.publicKey));
    assert.equal(toHex(a), toHex(b), who + ": the reconstructed point is not the key's own");
    assert.equal(a.length, suite.RAW_PUBKEY_BYTES);
  }
});

test('the restored recovery key really signs, and its restored public half really verifies', async () => {
  const r = await backup.importBackup(clone(FIXTURE), FIXTURE_PW, keystore.memKeyStore(), {
    deviceId: ids.deviceId(), createdAt: DAY,
  });
  // Rule 1: `verify() === true`, never a byte comparison.
  const msg = TE.encode('eine Nachricht aus WebKit');
  const sig = await identity.signBytes(r.identity.recSig.privateKey, msg);
  assert.equal(await identity.verifyBytes(r.identity.recSig.publicKey, sig, msg), true);
  assert.equal(await identity.verifyBytes(r.identity.recSig.publicKey, sig, TE.encode('etwas anderes')), false);

  // The public point sealed into the fixture by Node, recovered here.
  const raw = await identity.exportRawPublic(r.identity.recSig.publicKey);
  assert.equal(b64.b64u(raw), 'BBtawgvESflsl3WyLrFRcTNtRZxuyN0Ifg1xIjZkqaUmOpZmwQrNZPWdsckCHxaAXKa4FfR4SRADe2hV2x5TZc8');
  const kexRaw = await identity.exportRawPublic(r.identity.recKex.publicKey);
  assert.equal(b64.b64u(kexRaw), 'BCGN1u9Y99aZvI_jI2YpFGzjvtwCmfqM_rc5nuD7SaA_in_UjXA1D-SaWxb3Q1lrMisargUdaVypg6bhxxvE12g');
});

test('§7.3 step 3: a restored member gets FRESH non-extractable device keys, and a fresh short', async () => {
  const ks = keystore.memKeyStore();
  const r = await backup.importBackup(clone(FIXTURE), FIXTURE_PW, ks, {
    deviceId: ids.deviceId(), createdAt: DAY,
  });
  assert.equal(r.identity.devSig.privateKey.extractable, false);
  assert.equal(r.identity.devKex.privateKey.extractable, false);
  await rejects(() => S.exportKey('pkcs8', r.identity.devSig.privateKey), 'exporting a device private key');
  assert.notEqual(r.identity.deviceId, 'dev_T1er2F1xtur3D3v1c3AAAA');
  assert.equal(ids.isDeviceShort(r.identity.deviceShort), true);

  // …and the self-attestation over those fresh keys verifies under the RESTORED recovery key —
  // this is what `POST /devices/adopt` presents (§7.3 steps 4-5).
  const att = await identity.verifyAttestation(r.blob, r.identity.recSig.publicKey);
  assert.ok(att !== null, 'the restored RK_sig does not verify its own new attestation');
  assert.equal(att.deviceShort, r.identity.deviceShort);
  assert.equal(att.memberId, 'mem_T1er2F1xtur3M3mb3rAAAA');
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. D8 and A2, asserted against the bytes this engine produces
// ═════════════════════════════════════════════════════════════════════════════

test('D8 in WebKit: no private key material appears in a file this engine wrote', async () => {
  const m = await makeMember();
  const file = await backup.exportBackup(makeBoard(m.memberId), m.identity, m.spaces, 'Ein Passwort',
    { exportedAt: DAY, app: '2.0.0', iterations: 1000 });
  const text = JSON.stringify(file);

  const secrets = [
    b64.b64u(new Uint8Array(await S.exportKey('pkcs8', m.identity.recSig.privateKey))),
    b64.b64u(new Uint8Array(await S.exportKey('pkcs8', m.identity.recKex.privateKey))),
  ];
  for (const bundle of [m.spaces.personal, m.spaces.family]) {
    for (const k of bundle.epochs.values()) secrets.push(b64.b64u(new Uint8Array(await S.exportKey('raw', k))));
  }
  assert.equal(secrets.length, 5);
  for (const s of secrets) assert.equal(text.includes(s), false, 'key material in the exported file');

  // …and the board-only path has no `identity` key at all.
  const boardOnly = await backup.exportBackup(makeBoard(m.memberId), m.identity, m.spaces, null,
    { exportedAt: DAY, app: '2.0.0' });
  assert.equal('identity' in boardOnly, false);
  assert.equal(boardOnly._README_de, backup.README.boardOnly.de);
});

test('A2 in WebKit: a peer\'s entry never reaches the file, and the device fingerprint is gone', async () => {
  const m = await makeMember();
  const file = await backup.exportBackup(makeBoard(m.memberId), m.identity, m.spaces, null,
    { exportedAt: DAY, app: '2.0.0' });
  const text = JSON.stringify(file);
  assert.equal(text.includes('NICHT MEINS'), false);
  assert.equal(text.includes('mem_N4chb4rN4chb4rAAAAAAAA'), false);
  assert.equal(text.includes('A'.repeat(16)), false, 'a _born device fingerprint survived');
  assert.equal(file.board.notes.length, 1);
  assert.equal(file.board.notes[0].visibility, 'privat');
});

test('a full round trip inside this engine: export → wipe → import → the Kreis re-joins', async () => {
  const m = await makeMember();
  const file = clone(await backup.exportBackup(makeBoard(m.memberId), m.identity, m.spaces, 'Familie-2026!',
    { exportedAt: DAY, app: '2.0.0', iterations: 1000 }));

  const fresh = keystore.memKeyStore();
  assert.equal((await fresh.list()).length, 0);
  const r = await backup.importBackup(file, 'Familie-2026!', fresh, { deviceId: ids.deviceId(), createdAt: '2026-09-15' });

  assert.equal(r.identityRestored, true);
  assert.equal(r.identity.memberId, m.memberId);
  assert.notEqual(r.identity.deviceShort, m.identity.deviceShort);
  assert.equal(r.spaces.family.epochs.size, 2);
  assert.equal(r.board.notes.length, 1);
  assert.equal(r.consequence.code, 'identity-restored');

  // The ORIGINAL public key verifies the NEW attestation ⇒ the sealed key really is the key.
  const att = await identity.verifyAttestation(r.blob, m.identity.recSig.publicKey);
  assert.ok(att !== null, 'the restored key is not the key that was sealed');
  assert.equal((await fresh.list()).length, 6);
});

test('a wrong passphrase in WebKit gives the same one honest code, and writes nothing', async () => {
  const ks = keystore.memKeyStore();
  const err = await rejects(
    () => backup.importBackup(clone(FIXTURE), 'falsch', ks, { deviceId: ids.deviceId(), createdAt: DAY }),
    'a wrong passphrase'
  );
  assert.equal(err.code, 'cannot-open');
  assert.includes(err.say.de, 'Passwort');
  assert.deepEqual(await ks.list(), []);
});

test('the board-only path in WebKit reports the consequence and never opens the key store', async () => {
  const m = await makeMember();
  const file = clone(await backup.exportBackup(makeBoard(m.memberId), m.identity, m.spaces, null,
    { exportedAt: DAY, app: '2.0.0' }));
  const ks = keystore.memKeyStore();
  const r = await backup.importBackup(file, null, ks, {});
  assert.equal(r.identityRestored, false);
  assert.equal(r.identity, null);
  assert.equal(r.consequence.code, 'no-identity-in-file');
  assert.includes(r.consequence.de, 'Familienkreis');
  assert.deepEqual(await ks.list(), []);
});
