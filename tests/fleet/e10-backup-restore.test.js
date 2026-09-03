// FLEET · E10 / LZP-1004 — EXPORT → WIPE → IMPORT → RE-JOIN, END TO END.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS IS A FLEET FILE AND NOT A SEVENTY-NINTH UNIT TEST
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `tests/tier1/crypto-backup.test.js` has 78 rows against `crypto/backup.js` and they are good
// rows: the KDF, the AEAD, the payload shape, the error codes, `ownBoardOnly`'s A2 filter. What
// they cannot reach is the sentence the ticket is actually about —
//
//   "lose all devices AND the backup file, and the data is unrecoverable"  (addendum §3)
//
// — because the interesting half of it is what happens with the file: a Mac that is gone, a file
// that comes back, a relay that has never heard of the new device, and a Familienkreis that has
// to re-admit a member it has a member row for and no key wrap for. That is four components and
// a network, and it is a fleet scenario.
//
// So the ugly ones are the ones here:
//
//   §1  the FILE AS BYTES — D8 checked on the artefact, never on the code path
//   §2  the whole arc: export, the Mac is gone, import onto a new one, re-attest, re-join, and
//       the family's shared entries come back on their own
//   §3  a restore onto a machine that STILL HAS AN OLD BOARD — including the half that is not
//       about this machine at all (16.5 / RECHECK-40-4: the entries the old board was sharing)
//   §4  a backup OLDER THAN THE CURRENT EPOCH — the ring in the file is short, and what the
//       restored Mac shows in the meantime
//   §5  the copy a person reads at the moment she is about to lose everything (A2, D8)
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// D8, AS A PROPERTY OF THE PRODUCED FILE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// DESIGN-DECISIONS D8: *the identity block is passphrase-encrypted or omitted, never plaintext.*
// §1 verifies that on `JSON.stringify(file)` — the bytes that reach the disk and the mail
// archive — and not on which branch `exportBackup` took. The difference matters: a future edit
// that adds one convenience field (`"lastSpaceKey"`, `"recoveryHint"`) would leave every
// code-path assertion green. The check here is that NONE of the secret material this export
// handled appears anywhere in the file's text, plus an exhaustive key list on the identity block.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE RIG, AND THE TWO THINGS IT REPRODUCES RATHER THAN IMPORTS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Everything hard is `e6-attack-circle.js`'s (through `e9-attack-kit.js`): the real relay, the
// real transport, the real family engine, the real key delivery, one `store.js` evaluation per
// Mac. TWO helpers below are reproduced from it rather than imported, and both for the same
// reason the kit itself gives for `coverageStore()` — the function is module-private:
//
//   `transportFor`  is `e6-attack-circle.js#loopbackTransport` + `cfgFor`. A RESTORED Mac has
//                   device keys that did not exist when `buildCircle()` ran, so it cannot reuse
//                   a transport built around the old `sign` and the old `deviceShort`.
//   `bootRestored`  is `bootMac` with two arguments it does not take: a `peerDeviceIds` list (the
//                   restored Mac is a SECOND DEVICE OF THE SAME MEMBER, and ADR 001 §4.0's local
//                   device set is what admits the first Mac's ops) and a seed board.
//
// Neither reimplements a product function; both are harness plumbing, and each is ~20 lines.
//
// ⚠ TRANSPORT DEPENDENCY: as in the other E10 fleet files, everything runs on the FETCH shape of
// `platform/net.js`. `createBridgeTransport`'s `sync_request` is unimplemented in both shells and
// is a parallel workflow's work in progress. Assertions here are about properties of the file,
// the log and the relay's answers — never about `net.js` internals or line numbers.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE DOES NOT PROVE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//  · **The export SHEET and the import CONFIRMATION are screens.** §5 pins the strings and the
//    branch each belongs to; whether the sheet actually shows `singlePointOfFailure` before the
//    button is armed is `tests/tier2/crypto-backup.dom.js`'s, in a browser.
//  · **The file never touches a real disk here.** `src/js/backup.js`'s save/open path goes
//    through the shell (`tauriInvoke`), which is `shell-macos/` and `src-tauri/` — a parallel
//    workflow's files, and neither implements the sync bridge yet either. What is proven here is
//    the ARTEFACT and the RESTORE, not the file dialog.
//  · **Pairing (19.5) is not this file's route.** A restored Mac is the A2 recovery route.
//    `tests/helpers/fleet.js` drives `crypto/pairing.js` for real, in a PERSONAL space with no
//    Familienkreis; one rig carrying a paired second Mac AND a three-member family does not exist
//    yet, and §2's second device is the backup route rather than the pairing-code route.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE MUTANTS — one run each, scratch copy, naming the row that dies
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   M-K1  `crypto/backup.js:exportBackup` — the board-only branch writes
//         `file.identity = { memberId, note: 'plaintext' }`   → §1b, §1c and §5f go RED
//   M-K2  `crypto/backup.js:boardDigest` — returns a constant, so the board is no longer bound
//         into the AEAD's AAD                                 → §1d goes RED
//   M-K3  `crypto/backup.js:importBackup` — step 3 MINTS a fresh recovery pair instead of
//         importing the sealed one                            → §2c, §2d and §2e go RED
//         (the restored Mac's self-attestation then does not verify under the recovery key the
//         relay already holds for that member, and `POST /devices/adopt` refuses it)
//   M-K4  `core/replace.js:planReplaceAll` — `retractions` returned empty
//                                                             → §3c goes RED
//   M-K5  `crypto/backup.js:bundleFor` — the empty-ring refusal removed
//                                                             → §4a goes RED
//
// The honest-path control is this file green at `28f2a35` with no mutant applied.

import '../helpers/env.js';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { localStorage as LS, resetStorage, seedBoard } from '../helpers/env.js';
import { memKeyStore } from '../../src/js/platform/keystore.js';
import { buildAttestOpen } from '../../src/js/platform/device-identity.js';
import { exportRawPublic, signBytes } from '../../src/js/crypto/identity.js';
import { createKeyRing } from '../../src/js/crypto/spacekeys.js';
import { createKeyDelivery } from '../../src/js/sync/keys.js';
import { buildRequest } from '../../src/js/platform/net.js';
import { entityUuid as newUuid, deviceId as mkDeviceId } from '../../src/js/core/ids.js';
import { familyKey } from '../../src/js/core/ops.js';
import { b64u } from '../../src/js/core/b64.js';
import {
  exportBackup, importBackup, inspectBackup, BackupError,
  README, EXPORT_SHEET_COPY, IMPORT_CONSEQUENCE, LIMITS, PASSPHRASE_FLOOR,
  passphraseStrength, BACKUP_FORMAT, BACKUP_V,
} from '../../src/js/crypto/backup.js';

import { circle, converge, on, refreshRoster } from './e9-attack-kit.js';
import { BOARD, ORIGIN, DAY } from './e6-attack-circle.js';

const S = globalThis.crypto.subtle;
const RAND = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const PASS = 'Kirschbaum-Sonntag-Regenschirm';
const APP = '2.0.0';

// ─────────────────────────────────────────────────────────────────────────────
// Harness plumbing reproduced from `e6-attack-circle.js` — see the header for why
// ─────────────────────────────────────────────────────────────────────────────

/** `loopbackTransport` + `cfgFor`, for a Mac whose signing key did not exist at `buildCircle`. */
function transportFor(C, mac) {
  const cfg = {
    origin: ORIGIN,
    deviceShort: mac.forStore.deviceShort,
    sign: mac.sign,
    clientVersion: '2.0.0',
    now: C.now,
    random: RAND,
    subtle: S,
  };
  return {
    origin: ORIGIN,
    async request(method, path, query, body, headers) {
      const req = await buildRequest(cfg, method, path, query, body, headers);
      const url = new URL(req.url);
      const q = {};
      for (const [k, v] of url.searchParams) q[k] = v;
      const h = {};
      for (const k of Object.keys(req.headers)) h[k.toLowerCase()] = String(req.headers[k]);
      h['x-real-ip'] = '127.0.0.1';
      mac.calls.push(`${method} ${url.pathname}`);
      const res = await C.relay.handle({
        method: req.method,
        path: url.pathname,
        query: q,
        headers: h,
        body: body ?? null,
        rawBody: req.rawBody,
        clientIp: '127.0.0.1',
      });
      return { status: res.status, headers: res.headers, json: res.body };
    },
  };
}

/** `bootMac`, plus the local device set and a seed board it does not take. */
async function bootRestored(C, mac, { peerDeviceIds = [], seed = BOARD() } = {}) {
  mac.disk = {};
  mac.store = (await import(`../../src/js/store.js?e10-${mac.tag}-${C.spaceId.slice(4, 12)}`)).store;
  const attestOpen = await buildAttestOpen(await Promise.all(C.macs.map(async (m) => ({
    memberId: m.forStore.memberId,
    recoveryPubSigRaw: await exportRawPublic(m.recovery.recSig.publicKey),
    blobs: [m.myBlob],
  }))));
  await on(mac, async () => {
    resetStorage();
    seedBoard(seed);
    const s = mac.store;
    s.listeners.clear();
    s.ready = false;
    s.warnings.length = 0;
    if (!s.hasDurableIdentity()) s.useIdentity({ ...mac.forStore, peerDeviceIds, attestOpen });
    await s.init();
    s.warnings.length = 0;
    s.useFamilySpace(C.spaceId);
  });
}

/**
 * `startFamilyEngine`'s own attest-open refresh, which the fleet rig does not get for free.
 *
 * `store.setAttestOpen` is the moving half of ADR 002 §2.3 — "who I can verify changes every time
 * the roster does: a member joins, a member pairs a second Mac" — and the product refreshes it on
 * every key pass inside `family/engine.js#startFamilyEngine`. The fleet rig drives
 * `createFamilySync` DIRECTLY, so nothing refreshes it, and a Mac booted before a device existed
 * parks every op that device ever writes. This is that refresh, built the way the product builds
 * it: `buildAttestOpen` over the RELAY'S OWN ROSTER ROWS, not over the harness's `C.macs`.
 */
async function refreshAttestOpen(C, macs) {
  const rows = (C.roster || []).map((m) => ({
    memberId: m.memberId,
    recoveryPubSigRaw: m.recoveryPubSig,
    blobs: (m.devices || []).filter((d) => !d.revokedAt).map((d) => d.attestation),
  }));
  const open = await buildAttestOpen(rows);
  for (const mac of macs) {
    if (!mac.store) continue;
    await on(mac, () => { mac.store.setAttestOpen(open); });
  }
}

/** The family engine for a restored Mac — every port the real one (`engineFor`, verbatim shape). */
async function engineForRestored(C, mac) {
  const { createFamilySync } = await import('../../src/js/sync/family.js');
  return createFamilySync({
    coverStore: {
      async load(spaceId) {
        try {
          const raw = LS.getItem(`langzeitplaner.keycoverage.${spaceId}`);
          return raw ? JSON.parse(raw) : null;
        } catch { return null; }
      },
      async save(spaceId, record) {
        try { LS.setItem(`langzeitplaner.keycoverage.${spaceId}`, JSON.stringify(record)); }
        catch { /* a full disk is not a crash */ }
      },
    },
    store: mac.store,
    transport: mac.transport,
    keyring: mac.ring,
    sigPriv: mac.identity.devSig.privateKey,
    kexPriv: mac.identity.devKex.privateKey,
    recoveryKexPriv: mac.recovery.recKex.privateKey,
    spaceId: C.spaceId,
    me: {
      memberId: mac.forStore.memberId,
      deviceId: mac.forStore.deviceId,
      deviceShort: mac.forStore.deviceShort,
    },
    attestationOf: (dv) => C.attestations.get(dv) ?? null,
    attestation: mac.myAttestation,
    outbound: mac.store.familyOutbound(),
    now: C.now,
    subtle: S,
    random: RAND,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Export / import, driven the way `src/js/backup.js` drives them
// ─────────────────────────────────────────────────────────────────────────────

/** MY board, MY identity, MY rings — the three arguments A2 says an export is made of. */
async function exportFrom(C, mac, passphrase, opts = {}) {
  let board = null;
  await on(mac, () => { board = JSON.parse(JSON.stringify(mac.store.state)); });
  const epochs = mac.ring.keysByEpoch(C.spaceId);   // Map<epoch, CryptoKey>
  return exportBackup(
    board,
    {
      memberId: mac.forStore.memberId,
      recSig: mac.recovery.recSig,
      recKex: mac.recovery.recKex,
    },
    epochs.size ? { family: { id: C.spaceId, epochs }, personal: null } : null,
    passphrase,
    { exportedAt: DAY, app: APP, subtle: S, random: RAND, ...opts },
  );
}

/** The b64url spelling of every private key this member holds, for §1's byte search. */
async function secretsOf(C, mac) {
  const out = [];
  for (const pair of [mac.recovery.recSig, mac.recovery.recKex]) {
    out.push(b64u(new Uint8Array(await S.exportKey('pkcs8', pair.privateKey))));
  }
  for (const [, key] of mac.ring.keysByEpoch(C.spaceId)) {
    out.push(b64u(new Uint8Array(await S.exportKey('raw', key))));
  }
  return out;
}

const notesOn = (mac) => mac.store.state.notes;
const seen = (mac, fk) => notesOn(mac).find((n) => n.entityKey === fk) ?? null;

async function setProfile(C, mac, patch) {
  await on(mac, async () => {
    assert.equal(mac.store.apply('setMyProfile', patch), true);
    await mac.engine.syncNow();
  });
}

async function makeNote(C, mac, { text, visibility = 'geteilt', date = '2026-10-14' }) {
  const id = newUuid();
  await on(mac, async () => {
    assert.equal(mac.store.apply('createNoteInline', {
      id, date, text, categoryId: 'c1', visibility,
    }), true);
    await mac.engine.syncNow();
  });
  return { id, fk: familyKey('fnote', mac.forStore.memberId, id) };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · THE FILE, AS BYTES
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · D8 as a property of the produced file', () => {
  let C; let withKeys; let boardOnly; let secrets;

  before(async () => {
    C = await circle(['papa', 'mama']);
    await setProfile(C, C.papa, { displayName: 'Papa', colorRef: 'gruen' });
    await setProfile(C, C.mama, { displayName: 'Mama', colorRef: 'blau' });
    await converge(C, [C.papa, C.mama]);
    await makeNote(C, C.papa, { text: 'Omas Geburtstag', date: '2027-04-11' });
    await makeNote(C, C.papa, { text: 'Bewerbung', visibility: 'privat', date: '2027-04-12' });
    await makeNote(C, C.mama, { text: 'Mamas Eintrag', date: '2027-04-13' });
    await converge(C, [C.papa, C.mama]);

    withKeys = await exportFrom(C, C.papa, PASS);
    boardOnly = await exportFrom(C, C.papa, null);
    secrets = await secretsOf(C, C.papa);
  });

  test('§1a · with a passphrase: the identity block is a KDF header and a sealed blob, and nothing else', () => {
    assert.deepEqual(Object.keys(withKeys.identity).sort(), ['kdf', 'memberId', 'sealed']);
    assert.deepEqual(Object.keys(withKeys.identity.kdf).sort(),
      ['hash', 'iterations', 'name', 'salt']);
    assert.equal(withKeys.identity.kdf.name, 'PBKDF2');
    assert.equal(withKeys.identity.kdf.hash, 'SHA-256');
    assert.equal(withKeys.identity.kdf.iterations, 600000, 'ADR 002 §7.2');
    assert.equal(withKeys.identity.memberId, C.papa.forStore.memberId);
    assert.equal(typeof withKeys.identity.sealed, 'string');

    // THE BYTES. Not "the code took the sealed branch" — the file's own text.
    const text = JSON.stringify(withKeys);
    assert.ok(secrets.length >= 3, 'the member really holds a recovery pair and a ring');
    for (const s of secrets) {
      assert.equal(text.includes(s), false, 'no private key material appears in the file');
    }
    assert.equal(text.includes(PASS), false, 'and never the passphrase');
    assert.equal(/pkcs8/i.test(text), false);
    // A2 — MY data only. Mama's entry is not in my recovery artefact.
    assert.equal(text.includes('Mamas Eintrag'), false, 'A2 — other members are not exported');
    assert.equal(withKeys.board.notes.some((n) => n.text === 'Omas Geburtstag'), true);
    assert.equal(withKeys.board.notes.some((n) => n.text === 'Bewerbung'), true,
      'A2 — my PRIVATE entries are in my own backup');
  });

  test('§1b · without a passphrase: there is no identity block AT ALL', () => {
    assert.equal(Object.hasOwn(boardOnly, 'identity'), false,
      'D8 — omitted, not empty, and never plaintext');
    const text = JSON.stringify(boardOnly);
    for (const s of secrets) assert.equal(text.includes(s), false);
    assert.equal(/pkcs8|sealed|kdf/i.test(text), false);
    // And the file says which of the two it is, in both languages.
    assert.equal(boardOnly._README_de, README.boardOnly.de);
    assert.equal(boardOnly._README_en, README.boardOnly.en);
    assert.equal(withKeys._README_de, README.withIdentity.de);
    assert.equal(withKeys._README_en, README.withIdentity.en);
  });

  test('§1c · there is no third shape — the two exports are the whole domain', () => {
    for (const file of [withKeys, boardOnly]) {
      assert.equal(file.format, BACKUP_FORMAT);
      assert.equal(file.v, BACKUP_V);
      const seenFile = inspectBackup(file);
      assert.equal(seenFile.hasIdentity, Object.hasOwn(file, 'identity'));
      assert.equal(seenFile.needsPassphrase, seenFile.hasIdentity);
      // Every top-level key, exhaustively: a convenience field cannot be added unnoticed.
      const allowed = ['_README_de', '_README_en', 'app', 'board', 'exportedAt', 'format', 'v'];
      if (seenFile.hasIdentity) allowed.push('identity');
      assert.deepEqual(Object.keys(file).sort(), allowed.sort());
    }
    assert.equal(inspectBackup(withKeys).consequence, IMPORT_CONSEQUENCE.identityRestored);
    assert.equal(inspectBackup(boardOnly).consequence, IMPORT_CONSEQUENCE.boardOnly);
  });

  test('§1d · the seal really is a lock — a wrong passphrase and an edited board both refuse', async () => {
    const ks = () => memKeyStore();
    const opts = { deviceId: mkDeviceId(), createdAt: DAY, subtle: S, random: RAND };

    // (i) the passphrase
    await assert.rejects(
      () => importBackup(withKeys, 'Kirschbaum-Sonntag-Regenschirn', ks(), opts),
      (e) => e instanceof BackupError && e.code === 'cannot-open');
    await assert.rejects(
      () => importBackup(withKeys, null, ks(), opts),
      (e) => e instanceof BackupError && e.code === 'passphrase-required');

    // (ii) S3 — the board is bound into the AEAD's AAD on this path, so editing the file's
    // ENTRIES makes the identity block unopenable. „Es kommt entweder dein Board zurück oder
    // gar keins."
    const tampered = JSON.parse(JSON.stringify(withKeys));
    tampered.board.notes[0].text = 'gekapert';
    await assert.rejects(
      () => importBackup(tampered, PASS, ks(), opts),
      (e) => e instanceof BackupError && e.code === 'cannot-open');

    // …and the honest control: the untouched file opens.
    const ok = await importBackup(withKeys, PASS, ks(), opts);
    assert.equal(ok.identityRestored, true);
    assert.equal(ok.board.notes.some((n) => n.text === 'Omas Geburtstag'), true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · THE WHOLE ARC — export, the Mac is gone, import, re-attest, re-join
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · export → wipe → import → re-join', () => {
  let C; let file; let restored; let mine; let hers;

  before(async () => {
    C = await circle(['papa', 'mama']);
    await setProfile(C, C.papa, { displayName: 'Papa', colorRef: 'gruen' });
    await setProfile(C, C.mama, { displayName: 'Mama', colorRef: 'blau' });
    await converge(C, [C.papa, C.mama]);

    mine = await makeNote(C, C.papa, { text: 'Mein Termin', date: '2027-05-01' });
    hers = await makeNote(C, C.mama, { text: 'Mamas Termin', date: '2027-05-02' });
    await converge(C, [C.papa, C.mama]);

    file = await exportFrom(C, C.papa, PASS);

    // ── THE MAC IS GONE. Nothing of Papa's first machine is carried across: a NEW key store,
    // a NEW device id, and a store module that has never been booted.
    const ks = memKeyStore();
    const result = await importBackup(file, PASS, ks, {
      deviceId: mkDeviceId(), createdAt: DAY, subtle: S, random: RAND,
    });

    restored = {
      tag: 'papaneu',
      ks,
      forStore: {
        memberId: result.identity.memberId,
        deviceId: result.identity.deviceId,
        deviceShort: result.identity.deviceShort,
      },
      identity: result.identity,
      recovery: { recSig: result.identity.recSig, recKex: result.identity.recKex },
      myAttestation: result.attestation,
      myBlob: result.blob,
      sign: (bytes) => signBytes(result.identity.devSig.privateKey, bytes, { subtle: S }),
      disk: {},
      store: null,
      engine: null,
      ring: createKeyRing(),
      calls: [],
      importResult: result,
    };
    for (const [epoch, key] of result.spaces.family.epochs) {
      restored.ring.put(C.spaceId, Number(epoch), key);
    }
    restored.transport = transportFor(C, restored);
    C.macs.push(restored);
    C.papaneu = restored;

    // §7.3 step 5 — the adopt call this module deliberately does not make.
    const adopt = await restored.transport.request('POST', '/api/v1/devices/adopt', undefined, {
      spaceId: C.spaceId,
      memberId: restored.forStore.memberId,
      deviceId: restored.forStore.deviceId,
      deviceShort: restored.forStore.deviceShort,
      sigPubRaw: b64u(await exportRawPublic(restored.identity.devSig.publicKey)),
      kexPubRaw: b64u(await exportRawPublic(restored.identity.devKex.publicKey)),
      attestation: restored.myBlob,
    });
    restored.adopt = adopt;

    await refreshRoster(C);
    await refreshAttestOpen(C, [C.papa, C.mama]);
    await bootRestored(C, restored, { peerDeviceIds: [C.papa.forStore.deviceId] });
    await on(restored, async () => {
      restored.engine = await engineForRestored(C, restored);
      restored.store.replaceAll(restored.importResult.board);
      assert.equal(restored.store.apply('attestMyDevice', {
        deviceShort: restored.forStore.deviceShort, blob: restored.myBlob,
      }), true);
      await restored.engine.syncNow();
    });
    await refreshRoster(C);
    await refreshAttestOpen(C, [C.papa, C.mama, restored]);
    await converge(C, [C.mama]);
    await on(restored, () => restored.engine.syncNow());
    await converge(C, [C.mama]);
  });

  test('§2a · the import says what it did, in both languages, on every path', () => {
    const r = restored.importResult;
    assert.equal(r.identityRestored, true);
    assert.equal(r.consequence, IMPORT_CONSEQUENCE.identityRestored,
      'no gaps: the file carried every epoch the ring had');
    assert.equal(typeof r.consequence.de, 'string');
    assert.equal(typeof r.consequence.en, 'string');
    // M-B6 — the one thing the module CANNOT check, said rather than omitted.
    assert.equal(r.familyBinding.spaceId, C.spaceId);
    assert.equal(r.familyBinding.verified, false);
    assert.equal(r.familyBinding.say, IMPORT_CONSEQUENCE.familyBindingUnverified);
  });

  test('§2b · MY board is back — private entries included', async () => {
    await on(restored, () => {
      const own = notesOn(restored).filter((n) => !n.isForeign);
      assert.equal(own.some((n) => n.id === mine.id && n.text === 'Mein Termin'), true);
      assert.equal(own.some((n) => n.text === 'Mein eigener Eintrag'), true,
        'the Privat entry that was on the board before the circle existed');
    });
  });

  test('§2c · the device is NEW — a device is a machine, not a person', async () => {
    assert.notEqual(restored.forStore.deviceId, C.papa.forStore.deviceId);
    assert.notEqual(restored.forStore.deviceShort, C.papa.forStore.deviceShort);
    assert.equal(restored.forStore.memberId, C.papa.forStore.memberId,
      'the MEMBER is the same person');
    // The recovery key is the restored one — that is what makes the self-attestation verify
    // under the member row the relay already holds.
    assert.equal(restored.adopt.status, 200,
      `POST /devices/adopt → ${JSON.stringify(restored.adopt.json)}`);
    assert.equal(restored.adopt.json.memberId, C.papa.forStore.memberId);
    assert.equal(restored.adopt.json.registered, true, 'a device the relay had never seen');
    // §7.3 step 6 — the honest waiting state, answered from coordination data alone.
    assert.equal(typeof restored.adopt.json.keysPending, 'boolean');
  });

  test('§2d · re-joined — the family\'s shared entries arrive on their own', async () => {
    await on(restored, () => {
      const e = seen(restored, hers.fk);
      assert.ok(e, 'Mama\'s shared entry came back with no act of hers and none of mine');
      assert.equal(e.text, 'Mamas Termin');
      assert.equal(e.memberColorRef, 'blau');
      assert.equal(e.initial, 'M');
    });
    // And the circle sees the restored Mac as the same member, not a new one.
    await on(C.mama, () => {
      const ids = new Set(notesOn(C.mama).filter((n) => n.isForeign).map((n) => n.ownerId));
      assert.deepEqual([...ids], [C.papa.forStore.memberId], 'still one Papa');
    });
    const roster = C.roster.filter((m) => !m.removedAt);
    assert.equal(roster.length, 2, 'two members');
    const papaRow = roster.find((m) => m.memberId === C.papa.forStore.memberId);
    assert.equal(papaRow.devices.filter((d) => !d.revokedAt).length, 2,
      '19.4 — one person, two Macs');
  });

  test('§2e · and the restored Mac can write, and the write reaches Mama', async () => {
    const fresh = await makeNote(C, restored, { text: 'Vom neuen Mac', date: '2027-05-09' });
    await converge(C, [C.mama]);
    await on(C.mama, () => {
      const e = seen(C.mama, fresh.fk);
      assert.ok(e, 'the restored Mac is a full member again');
      assert.equal(e.text, 'Vom neuen Mac');
      assert.equal(e.ownerId, C.papa.forStore.memberId);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · A RESTORE ONTO A MACHINE THAT STILL HAS AN OLD BOARD
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · restoring over a board that is still there', () => {
  let C; let file; let kept; let after;

  before(async () => {
    C = await circle(['papa', 'mama']);
    await setProfile(C, C.papa, { displayName: 'Papa', colorRef: 'gruen' });
    await setProfile(C, C.mama, { displayName: 'Mama', colorRef: 'blau' });
    await converge(C, [C.papa, C.mama]);

    kept = await makeNote(C, C.papa, { text: 'Im Backup', date: '2027-06-01' });
    await converge(C, [C.mama]);

    file = await exportFrom(C, C.papa, PASS);          // ← the file is made HERE

    // …and then life goes on: Papa shares something else, and Mama sees it.
    after = await makeNote(C, C.papa, { text: 'Nach dem Backup', date: '2027-06-02' });
    await converge(C, [C.mama]);
    await on(C.mama, () => assert.ok(seen(C.mama, after.fk)));
  });

  test('§3a · the restore replaces the board — it does not merge into it', async () => {
    const result = await importBackup(file, PASS, memKeyStore(), {
      deviceId: mkDeviceId(), createdAt: DAY, subtle: S, random: RAND,
    });
    await on(C.papa, () => {
      C.papa.store.publisher.pendingRetractions.length = 0;
      assert.equal(C.papa.store.replaceAll(result.board), true);
      assert.equal(notesOn(C.papa).some((n) => n.id === kept.id), true, 'the backup\'s entry is back');
      assert.equal(notesOn(C.papa).some((n) => n.id === after.id), false,
        'and the entry the backup never knew about is gone');
    });
  });

  test('§3b · ⌘Z cannot walk back across an import', async () => {
    await on(C.papa, () => {
      assert.equal(C.papa.store.canUndo(), false,
        'the stack is cleared: an import is not one of my actions');
    });
  });

  test('§3c · RECHECK-40-4 — the entries the old board was sharing are RETRACTED, not orphaned', async () => {
    let retracted = [];
    await on(C.papa, () => { retracted = C.papa.store.publisher.pendingRetractions.slice(); });
    assert.equal(retracted.includes(after.fk), true,
      `16.5 — the restore owes the family a retraction for ${after.fk}; got ${JSON.stringify(retracted)}`);
    assert.equal(retracted.includes(kept.fk), false,
      'and owes nothing for the entry the file still carries');
    // WHAT THIS ROW DOES AND DOES NOT PROVE: the retraction LIST is computed and handed over —
    // that is `planReplaceAll` → `store.publisher.retract`, and losing it is the defect
    // RECHECK-40-4 names. Whether the list is then PUBLISHED depends on a real publisher being
    // installed, which is `family/engine.js#startEngine`'s job and not `createFamilySync`'s; the
    // fleet rig drives the engine directly, so `nullPublisher` RECORDS here, as designed
    // (`store.js#nullPublisher`, `setPublisher`'s carry-across).
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · A BACKUP OLDER THAN THE CURRENT EPOCH
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · the ring in the file is short', () => {
  let C; let oldFile; let epochAtExport; let epochAfter; let newEntry;

  before(async () => {
    C = await circle(['papa', 'mama', 'oma']);
    await setProfile(C, C.papa, { displayName: 'Papa', colorRef: 'gruen' });
    await setProfile(C, C.mama, { displayName: 'Mama', colorRef: 'blau' });
    await converge(C, [C.papa, C.mama, C.oma]);

    epochAtExport = C.papa.ring.currentEpoch(C.spaceId);
    oldFile = await exportFrom(C, C.papa, PASS);

    // A membership change. ADR 002 §4.1: it rotates, so the removed member cannot read what
    // comes next — and so a file made before it holds a ring that stops one epoch short.
    const removed = await C.papa.transport.request('POST', '/api/v1/members/remove', undefined, {
      spaceId: C.spaceId, memberId: C.oma.forStore.memberId,
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    assert.equal(removed.json.rotateRequired, true);

    const kd = createKeyDelivery({
      transport: C.papa.transport,
      spaceId: C.spaceId,
      ring: C.papa.ring,
      myKexPriv: C.papa.identity.devKex.privateKey,
      myRecoveryKexPriv: C.papa.recovery.recKex.privateKey,
      me: {
        memberId: C.papa.forStore.memberId,
        deviceId: C.papa.forStore.deviceId,
        deviceShort: C.papa.forStore.deviceShort,
      },
      now: C.now,
      subtle: S,
      random: RAND,
    });
    const rot = await kd.rotate('member.remove');
    assert.equal(typeof rot, 'object');
    epochAfter = C.papa.ring.currentEpoch(C.spaceId);
    assert.equal(epochAfter, epochAtExport + 1, 'the epoch really moved');

    await refreshRoster(C);
    newEntry = await makeNote(C, C.papa, { text: 'Nach der Rotation', date: '2027-09-09' });
    await converge(C, [C.mama]);
  });

  test('§4a · a backup carries EVERY epoch 1..e — a ring with a hole is refused at the SOURCE', async () => {
    assert.equal(epochAtExport >= 1, true, 'the circle had at least one epoch when the file was made');
    assert.equal(epochAfter, epochAtExport + 1, 'and one more after the removal');
    assert.equal(inspectBackup(oldFile).hasIdentity, true);
    assert.equal(C.papa.ring.covers(C.spaceId, epochAtExport), true,
      'the ring the file was made from was complete for 1..e');

    // ADR 002 §7.1 step 5 — "a backup carries EVERY epoch 1..e; one that carried only the current
    // epoch would restore a member who cannot read the history (A4, 17.1)". Refused when the file
    // is WRITTEN, not discovered when it is read.
    let board = null;
    await on(C.papa, () => { board = JSON.parse(JSON.stringify(C.papa.store.state)); });
    const identity = {
      memberId: C.papa.forStore.memberId,
      recSig: C.papa.recovery.recSig,
      recKex: C.papa.recovery.recKex,
    };
    await assert.rejects(
      () => exportBackup(board, identity, { family: { id: C.spaceId, epochs: new Map() }, personal: null },
        PASS, { exportedAt: DAY, app: APP, subtle: S, random: RAND }),
      /EVERY epoch/);
    // …and the honest control: the full ring exports.
    const ok = await exportBackup(board, identity,
      { family: { id: C.spaceId, epochs: C.papa.ring.keysByEpoch(C.spaceId) }, personal: null },
      PASS, { exportedAt: DAY, app: APP, subtle: S, random: RAND });
    assert.equal(Object.hasOwn(ok, 'identity'), true);
  });

  test('§4b · the restored ring is short, and the import SAYS the keys are complete for what it holds', async () => {
    const result = await importBackup(oldFile, PASS, memKeyStore(), {
      deviceId: mkDeviceId(), createdAt: DAY, subtle: S, random: RAND,
    });
    const epochs = [...result.spaces.family.epochs.keys()].map(Number).sort((a, b) => a - b);
    assert.deepEqual(epochs, Array.from({ length: epochAtExport }, (_, i) => i + 1),
      'every epoch 1..e that existed when the file was written');
    assert.equal(epochs.includes(epochAfter), false, 'and not the one minted after it');
    // S8 — "with gaps" is about HOLES in 1..e, not about being behind the relay. A file that is
    // merely OLD is complete for what it carries, and the copy says so.
    assert.equal(result.spaces.family.missingEpochs, undefined);
    assert.equal(result.consequence, IMPORT_CONSEQUENCE.identityRestored);
    // …and the sentence for the other case exists and is different, in both languages.
    assert.notEqual(IMPORT_CONSEQUENCE.identityRestoredWithGaps.de, result.consequence.de);
    assert.match(IMPORT_CONSEQUENCE.identityRestoredWithGaps.de, /Schlüssel ausstehend/);
    assert.match(IMPORT_CONSEQUENCE.identityRestoredWithGaps.en, /keys pending/);
  });

  test('§4c · an op sealed at the newer epoch is HELD, not lost, until the key is delivered', async () => {
    const result = await importBackup(oldFile, PASS, memKeyStore(), {
      deviceId: mkDeviceId(), createdAt: DAY, subtle: S, random: RAND,
    });
    const shortRing = createKeyRing();
    for (const [epoch, key] of result.spaces.family.epochs) {
      shortRing.put(C.spaceId, Number(epoch), key);
    }
    assert.equal(shortRing.get(C.spaceId, epochAfter), null,
      'the file cannot open what was sealed after it was written');
    assert.ok(shortRing.get(C.spaceId, epochAtExport), 'and can open everything before');

    // The cure is not an action anybody takes: `keys.js#admit()` over a device the roster now
    // knows. Papa's ORIGINAL Mac is the delivering member here (D9 §7.1 step 4 — any member
    // device, not a particular person's).
    assert.equal(C.papa.ring.currentEpoch(C.spaceId), epochAfter);
    await on(C.mama, () => C.mama.engine.syncNow());
    await on(C.mama, () => {
      assert.equal(C.mama.ring.currentEpoch(C.spaceId), epochAfter,
        'a member who stayed does hold the new epoch');
      assert.equal(seen(C.mama, newEntry.fk).text, 'Nach der Rotation');
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · THE COPY A PERSON READS AT THE MOMENT SHE IS ABOUT TO LOSE EVERYTHING
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§5 · key loss = data loss, said out loud (A2, D8)', () => {
  const bilingual = (o, where) => {
    assert.equal(typeof o.de, 'string', `${where}.de`);
    assert.equal(typeof o.en, 'string', `${where}.en`);
    assert.ok(o.de.length > 0 && o.en.length > 0, where);
    assert.notEqual(o.de, o.en, `${where} — German-first means TWO texts, not one twice`);
  };

  test('§5a · the export sheet has two buttons and neither is silent', () => {
    const w = EXPORT_SHEET_COPY.withPassword;
    const b = EXPORT_SHEET_COPY.boardOnly;
    assert.equal(w.code, 'with-identity');
    assert.equal(b.code, 'board-only');
    for (const [o, name] of [[w.label, 'withPassword.label'], [w.gain, 'withPassword.gain'],
      [w.lose, 'withPassword.lose'], [b.label, 'boardOnly.label'], [b.gain, 'boardOnly.gain'],
      [b.lose, 'boardOnly.lose'], [EXPORT_SHEET_COPY.title, 'title']]) bilingual(o, name);

    // D8's own copy consequence: "losing it loses the backup — there is no reset, by design".
    assert.match(w.lose.de, /Passwort kann niemand zurücksetzen/);
    assert.match(w.lose.en, /Nobody can reset the password/);
    // …and the other half, on the button it is true of.
    assert.match(b.lose.de, /neu beitreten/);
    assert.match(b.lose.en, /join the Familienkreis again/);
  });

  test('§5b · both halves of the single point of failure, in one sentence, before anything is typed', () => {
    bilingual(EXPORT_SHEET_COPY.singlePointOfFailure, 'singlePointOfFailure');
    const de = EXPORT_SHEET_COPY.singlePointOfFailure.de;
    assert.match(de, /Mit Passwort: Passwort verloren, Backup verloren/);
    assert.match(de, /Ohne Passwort: letzten Mac verloren, Familienkreis verloren/);
    assert.match(de, /lässt sich nicht rückgängig machen/);

    // Addendum §3 — and it is NOT an account password.
    bilingual(EXPORT_SHEET_COPY.notAnAccount, 'notAnAccount');
    assert.match(EXPORT_SHEET_COPY.notAnAccount.de, /kein Konto-Passwort/);
    assert.match(EXPORT_SHEET_COPY.notAnAccount.de, /geht nie an einen Server/);

    bilingual(LIMITS.passphraseLoss, 'LIMITS.passphraseLoss');
    assert.match(LIMITS.passphraseLoss.de, /keine Wiederherstellung des Passworts/);
    assert.match(LIMITS.passphraseLoss.de, /Absicht/);
  });

  test('§5c · the file says across its own top which of the two it is', () => {
    bilingual(README.withIdentity, 'README.withIdentity');
    bilingual(README.boardOnly, 'README.boardOnly');
    assert.match(README.withIdentity.de, /DIES IST DEIN SCHLÜSSEL/);
    assert.match(README.withIdentity.de, /unwiederbringlich/);
    assert.match(README.boardOnly.de, /OHNE DEINE SCHLÜSSEL/);
    assert.notEqual(README.withIdentity.de, README.boardOnly.de,
      'writing "this is your key" across a file with no key is a lie the user would act on');
  });

  test('§5d · nothing in the copy promises a recovery that does not exist', () => {
    const everything = JSON.stringify([EXPORT_SHEET_COPY, README, IMPORT_CONSEQUENCE, LIMITS]);
    for (const forbidden of [
      'zurücksetzen lassen', 'Passwort zurücksetzen', 'wiederherstellbar',
      'reset your password', 'recover your password', 'password recovery is',
    ]) {
      assert.equal(everything.includes(forbidden), false, `copy must not say ${forbidden}`);
    }
    // The one place "zurücksetzen" IS allowed is the sentence that denies it.
    assert.match(EXPORT_SHEET_COPY.withPassword.lose.de, /kann niemand zurücksetzen/);
  });

  test('§5e · S7 — the weak-passphrase warning is a warning, and it is shown BEFORE typing', () => {
    bilingual(EXPORT_SHEET_COPY.passphrase.hint, 'passphrase.hint');
    bilingual(EXPORT_SHEET_COPY.passphrase.weak, 'passphrase.weak');
    bilingual(EXPORT_SHEET_COPY.passphrase.weakAnyway, 'passphrase.weakAnyway');
    assert.equal(PASSPHRASE_FLOOR.hard, false, 'D8/S7 — the floor is SOFT, deliberately');
    assert.equal(passphraseStrength('1234').weak, true);
    assert.equal(passphraseStrength(PASS).weak, false);
    assert.match(EXPORT_SHEET_COPY.passphrase.weakAnyway.de, /Trotzdem so sichern/);
  });

  test('§5f · a weak passphrase is ACCEPTED, and the caller is told — a testable fact, not a convention', async () => {
    const C = await circle(['papa', 'mama']);
    const told = [];
    const file = await exportFrom(C, C.papa, '1234', {
      onWeakPassphrase: (s) => told.push(s),
    });
    assert.equal(told.length, 1, 'the sheet was told');
    assert.equal(told[0].weak, true);
    assert.ok(Array.isArray(told[0].reasons) && told[0].reasons.length > 0);
    assert.equal(Object.hasOwn(file, 'identity'), true, 'and the file was still written');
    // The reason the floor is soft: the alternative is a user with NO recovery artefact at all.
    const boardOnlyFile = await exportFrom(C, C.papa, null);
    assert.equal(Object.hasOwn(boardOnlyFile, 'identity'), false);
    assert.equal(inspectBackup(boardOnlyFile).consequence, IMPORT_CONSEQUENCE.boardOnly);
  });
});
