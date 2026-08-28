// TIER 1 · LZP-305 — backup v2, the recovery artifact.
// ADR 002 §7.2 / §7.3 · amendment A2 · stories 11.2 / 11.3 · PO decision D8.
//
// THIS IS THE MODULE WHERE A BUG IS SILENT AND PERMANENT, so this file is written against the
// failures rather than the feature. Three shapes of bug are worth more than all the rest:
//
//   1. **A key written in plaintext.** D8's whole reason for existing. Asserted over the BYTES of
//      the finished file, not over the code path that produced it — the b64url spelling of every
//      private key the export handled is searched for in `JSON.stringify(file)`, on both paths.
//   2. **Somebody else's entry in my file.** A2. Asserted with `isForeign` set, with `isForeign`
//      ABSENT but a foreign `ownerId` (the case a future materializer could produce), and by
//      naming every device-identifying field that must not survive the strip.
//   3. **A half-applied import.** Every refusal in this file is followed by an assertion that the
//      KeyStore is byte-for-byte what it was before the call.
//
// RULE 1 (ADR 002 §1) — no signature bytes are compared anywhere here. The one place two
// ciphertexts ARE compared is the KAT and the determinism test, where the comparison is the point:
// AES-GCM under a fixed key, IV and AAD IS deterministic, and that is what lets the passphrase
// chain be pinned by a vector at all. ECDSA is not, and is only ever asserted through `verify()`.
//
// SPEED. `BACKUP_KDF.iterations` is 600 000 by design and a test file that paid it 60 times would
// take a minute. Nearly every test injects `iterations` (a port, like `subtle` and `random`); the
// real 600 000 is paid exactly TWICE — once in each direction — so the production number is
// genuinely exercised and the file still runs in a couple of seconds.

import test from 'node:test';
import assert from 'node:assert/strict';

import { b64u, ub64 } from '../../src/js/core/b64.js';
import { utf8 } from '../../src/js/core/canon.js';
import { deviceId as mkDeviceId, memberId as mkMemberId, spaceId as mkSpaceId } from '../../src/js/core/ids.js';
import { V1_ENTRY_FIELDS } from '../../src/js/core/materialize.js';

import {
  AEAD, BACKUP_KDF, INFO, PKCS8_P256_BYTES, SALT_BYTES, SIG, KEX, SYMMETRIC_KEY_BYTES,
  USAGES, infoBytes,
} from '../../src/js/crypto/suite.js';
import * as identity from '../../src/js/crypto/identity.js';
import { memKeyStore } from '../../src/js/platform/keystore.js';
import {
  BACKUP_ERROR_CODES, BACKUP_FORMAT, BACKUP_V, BACKUP_ENTRY_FIELDS, BackupError,
  EXPORT_SHEET_COPY, IMPORT_CONSEQUENCE, LIMITS, MAX_KDF_ITERATIONS, PASSPHRASE_FLOOR, README,
  SEALED_IV_BYTES, boardDigestInput, deriveBackupKey, exportBackup, importBackup, inspectBackup,
  ownBoardOnly, passphraseStrength,
} from '../../src/js/crypto/backup.js';

import { hkdf as pureHkdf, pbkdf2 as purePbkdf2, hex, toHex } from '../helpers/kat.js';

const S = globalThis.crypto.subtle;
const DAY = '2026-08-27';

/**
 * S3 — THE BOARD DIGEST, REIMPLEMENTED HERE, and reimplemented rather than imported on purpose.
 *
 * The two KAT tests below rebuild the AES-GCM AAD by hand from a real file, which is the only
 * thing in the suite that proves the AAD is what `backup.js` says it is rather than merely what
 * `backup.js` does twice. `board` is now a member of that AAD, so the KAT needs the digest — and
 * a KAT that got it by calling the function under test would prove nothing about it.
 *
 * This is a genuinely independent implementation: it SORTS THE TREE and then stringifies, where
 * `boardDigestInput` stringifies THROUGH a sorting replacer. The two agree on every value a JSON
 * file can carry, which is the whole domain either of them is ever handed.
 */
async function katBoardDigest(board) {
  const sortDeep = (v) => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v === null || typeof v !== 'object') return v;
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortDeep(v[k]);
    return o;
  };
  const bytes = utf8(JSON.stringify(sortDeep(board)));
  return b64u(new Uint8Array(await S.digest('SHA-256', bytes)));
}
const APP = '2.0.0';
/** Test-only PBKDF2 rounds. The real 600 000 is paid by the two tests that say so in their name. */
const FAST = { iterations: 1000 };

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

async function aesKey(extractable = true) {
  return S.generateKey({ name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt']);
}

/** A whole member: recovery pair, one attested device, a two-space key ring. */
async function makeMember() {
  const ks = memKeyStore();
  const memberId = mkMemberId();
  const rec = await identity.ensureRecoveryIdentity(ks, memberId, { createdAt: DAY });
  const minted = await identity.ensureAttestedDevice(ks, memberId, rec.recSig.privateKey, {
    deviceId: mkDeviceId(), createdAt: DAY,
  });
  const id = { ...minted.identity, recSig: rec.recSig, recKex: rec.recKex };
  const spaces = {
    personal: { id: mkSpaceId('personal'), epochs: new Map([[1, await aesKey()], [2, await aesKey()]]) },
    family: { id: mkSpaceId('family'), epoch: 3, epochs: new Map([[1, await aesKey()], [2, await aesKey()], [3, await aesKey()]]) },
  };
  return { ks, memberId, identity: id, spaces, attestation: minted.attestation, blob: minted.blob };
}

/**
 * A materialized v2 board: one of my private notes, one of my Belegt bars, one of my Geteilt
 * notes, and ONE FOREIGN NOTE that must never reach the file. Decorated exactly the way
 * `core/materialize.js` decorates one, `_born`'s device fingerprint included.
 */
function makeBoard(me) {
  return {
    schemaVersion: 2,
    notes: [
      {
        id: 'n-privat', date: '2026-09-01', text: 'Zahnarzt', categoryId: 'c1',
        repeatsYearly: false, visibility: 'privat', coEdit: false,
        uuid: 'n-privat', entityKey: 'note:n-privat', ownerId: me, isForeign: false,
        level: null, redacted: false, memberColorRef: null, initial: null, exposure: null,
        isNew: false, createdAt: '2026-08-01', updatedAt: '2026-08-02',
        updatedBy: 'dev_xyz', _born: `1|2|${'A'.repeat(16)}`,
      },
      {
        id: 'n-geteilt', date: '2026-09-02', text: 'Omas Geburtstag', categoryId: 'c2',
        repeatsYearly: true, visibility: 'geteilt', coEdit: true,
        ownerId: me, isForeign: false, level: 'geteilt', exposure: 'shared',
      },
      {
        id: 'fnote:mem_nachbar/n-fremd', date: '2026-09-03', text: 'NICHT MEINS',
        visibility: 'geteilt', level: 'geteilt',
        uuid: 'n-fremd', entityKey: 'fnote:mem_nachbar/n-fremd',
        ownerId: 'mem_nachbar', isForeign: true, memberColorRef: 'rot', initial: 'N',
      },
    ],
    bars: [
      {
        id: 'b-belegt', startDate: '2026-10-01', endDate: '2026-10-14', label: 'Urlaub Italien',
        categoryId: 'c3', visibility: 'belegt', coEdit: false,
        ownerId: me, isForeign: false, level: 'belegt', _born: `3|4|${'B'.repeat(16)}`,
      },
      {
        id: 'b-fremd', startDate: '2026-11-01', endDate: '2026-11-03', label: 'AUCH NICHT MEINS',
        ownerId: 'mem_nachbar', isForeign: true,
      },
    ],
    categories: [
      { id: 'c1', name: 'Arbeit', nameEn: 'Work', paletteRef: 'blau', visible: true },
      { id: 'c2', name: 'Familie', nameEn: 'Family', paletteRef: 'gruen', visible: true },
      { id: 'c3', name: 'Reisen', nameEn: 'Travel', paletteRef: 'orange', visible: false },
    ],
    scratchpads: { '2026-09': 'Hütte buchen?' },
    settings: { bundesland: 'BY', language: 'de', rowHeight: 22, layers: { feiertage: true, schulferien: false } },
    _v2: { lineageId: 'lin_abc', gen: 7 },
  };
}

async function exportWith(m, passphrase, extra = {}) {
  return exportBackup(makeBoard(m.memberId), m.identity, m.spaces, passphrase,
    { exportedAt: DAY, app: APP, ...FAST, ...extra });
}

/** Deep clone through JSON — which is exactly the trip a file takes through the disk. */
const roundTripped = (file) => JSON.parse(JSON.stringify(file));

/** A snapshot of everything a KeyStore holds, for the "nothing was written" assertions. */
async function storeFingerprint(ks) {
  const ids = await ks.list();
  const out = [];
  for (const id of ids) {
    const v = await ks.get(id);
    out.push(`${id}:${v instanceof Uint8Array ? toHex(v) : (v && v.privateKey ? 'pair' : typeof v)}`);
  }
  return out;
}

/**
 * Run `fn`, expect a `BackupError` with `code`, and say what the store must look like afterwards.
 *
 * `after` used to be implicit and universal — "prove `ks` was not touched" — and S4 is the reason
 * it now has to be named. A refused import leaves the store ALONE in every case but one: the dead
 * residue of an interrupted earlier write is cleared on the way out, so the retry is not refused
 * for ever (`prepareKeyStore`). Making that an argument rather than a default keeps every OTHER
 * call site asserting the strong thing, and makes the one exception impossible to introduce by
 * accident.
 *
 * @param {string} code
 * @param {Object} ks
 * @param {() => Promise<any>} fn
 * @param {'unchanged'|'cleared'} [after]
 */
async function refuses(code, ks, fn, after = 'unchanged') {
  const before = await storeFingerprint(ks);
  await assert.rejects(fn, (err) => {
    assert.ok(err instanceof BackupError, `expected a BackupError, got ${err && err.name}: ${err && err.message}`);
    assert.equal(err.code, code, `expected code ${code}, got ${err.code} (${err.message})`);
    assert.ok(BACKUP_ERROR_CODES.includes(err.code));
    assert.equal(typeof err.say.de, 'string');
    assert.ok(err.say.de.length > 0 && err.say.en.length > 0);
    return true;
  });
  if (after === 'cleared') {
    assert.ok(before.length > 0, 'nothing was there to clear — the row measures nothing');
    assert.deepEqual(await storeFingerprint(ks), [], 'the dead residue was left behind');
  } else {
    assert.deepEqual(await storeFingerprint(ks), before, 'the key store was written to on a failed import');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. D8 — the identity block is encrypted or absent. NEVER plaintext.
// ═════════════════════════════════════════════════════════════════════════════

test('D8: with a passphrase, no private key material appears anywhere in the file bytes', async () => {
  const m = await makeMember();
  const file = await exportWith(m, 'Ein sehr langes Passwort');
  const text = JSON.stringify(file);

  // The exact b64url strings D8 forbids: both recovery PKCS#8 keys and every epoch key.
  const forbidden = [
    b64u(new Uint8Array(await S.exportKey('pkcs8', m.identity.recSig.privateKey))),
    b64u(new Uint8Array(await S.exportKey('pkcs8', m.identity.recKex.privateKey))),
  ];
  for (const bundle of [m.spaces.personal, m.spaces.family]) {
    for (const k of bundle.epochs.values()) forbidden.push(b64u(new Uint8Array(await S.exportKey('raw', k))));
  }
  assert.equal(forbidden.length, 7, 'two recovery keys and five epoch keys');
  for (const secret of forbidden) {
    assert.equal(text.includes(secret), false, 'private key material found in the exported file');
  }
  // …and the same in hex and in standard base64, in case some future writer changed spelling.
  for (const secret of forbidden) {
    const raw = ub64(secret);
    assert.equal(text.includes(toHex(raw)), false, 'key material found hex-encoded');
    assert.equal(text.includes(Buffer.from(raw).toString('base64')), false, 'key material found base64-encoded');
  }
  assert.equal(typeof file.identity.sealed, 'string');
  assert.ok(file.identity.sealed.length > 0);
});

test('D8: without a passphrase there is no identity block AT ALL — not an empty one, not a null', async () => {
  const m = await makeMember();
  const file = await exportWith(m, null);
  assert.equal(Object.prototype.hasOwnProperty.call(file, 'identity'), false);
  assert.equal('identity' in file, false);
  assert.equal(JSON.stringify(file).includes('identity'), false);

  const text = JSON.stringify(file);
  const pk = b64u(new Uint8Array(await S.exportKey('pkcs8', m.identity.recSig.privateKey)));
  assert.equal(text.includes(pk), false);
  for (const k of m.spaces.family.epochs.values()) {
    assert.equal(text.includes(b64u(new Uint8Array(await S.exportKey('raw', k)))), false);
  }
});

test('D8: the kdf block records exactly what ADR 002 §7.2 fixes, and 600 000 is the default', async () => {
  const m = await makeMember();
  const real = await exportBackup(makeBoard(m.memberId), m.identity, m.spaces, 'pw',
    { exportedAt: DAY, app: APP });               // no injected iterations — the PRODUCTION path
  assert.deepEqual(real.identity.kdf, {
    name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: real.identity.kdf.salt,
  });
  assert.equal(BACKUP_KDF.iterations, 600000);
  assert.equal(ub64(real.identity.kdf.salt).length, SALT_BYTES);
  assert.equal(real.identity.memberId, m.memberId);
});

test('D8: an empty or whitespace-only passphrase is refused, and no file comes back', async () => {
  const m = await makeMember();
  for (const pw of ['', '   ', '\t\n']) {
    await assert.rejects(() => exportWith(m, pw), (e) => e instanceof BackupError && e.code === 'passphrase-empty');
  }
  // …and it is refused BEFORE any private key is exported: a non-string is a programmer error,
  // not a user error, so it throws a plain Error rather than a BackupError.
  for (const bad of [0, 1, true, {}, [], Symbol.iterator]) {
    await assert.rejects(() => exportWith(m, bad), (e) => !(e instanceof BackupError));
  }
});

test('D8: `undefined` is treated as "no passphrase", not as a passphrase', async () => {
  const m = await makeMember();
  const file = await exportBackup(makeBoard(m.memberId), m.identity, m.spaces, undefined,
    { exportedAt: DAY, app: APP });
  assert.equal('identity' in file, false);
  assert.equal(file._README_de, README.boardOnly.de);
});

test('D8: a passphrase without a recovery pair is a loud failure, never a silent board-only file', async () => {
  const m = await makeMember();
  const noRec = { memberId: m.memberId, deviceId: 'dev_x', deviceShort: 'A'.repeat(16), createdAt: DAY };
  await assert.rejects(
    () => exportBackup(makeBoard(m.memberId), noRec, m.spaces, 'pw', { exportedAt: DAY, app: APP, ...FAST }),
    /recSig/
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. A2 — my data, and nobody else's
// ═════════════════════════════════════════════════════════════════════════════

test('A2: a foreign entry never reaches the file, and its text never appears in the bytes', async () => {
  const m = await makeMember();
  const file = await exportWith(m, 'pw');
  const text = JSON.stringify(file);
  assert.equal(text.includes('NICHT MEINS'), false);
  assert.equal(text.includes('AUCH NICHT MEINS'), false);
  assert.equal(text.includes('mem_nachbar'), false);
  assert.equal(file.board.notes.length, 2);
  assert.equal(file.board.bars.length, 1);
  assert.deepEqual(file.board.notes.map((n) => n.id), ['n-privat', 'n-geteilt']);
});

test('A2: a foreign ownerId is dropped even when `isForeign` is absent — the belt to isForeign\'s braces', () => {
  const me = 'mem_me';
  const board = {
    notes: [
      { id: 'a', text: 'meins' },                                   // no ownerId at all ⇒ mine
      { id: 'b', text: 'auch meins', ownerId: me },
      { id: 'c', text: 'FREMD', ownerId: 'mem_du' },                // no isForeign flag anywhere
      { id: 'd', text: 'FREMD2', ownerId: 'mem_du', isForeign: false }, // and one that LIES
    ],
    bars: [], categories: [], scratchpads: {}, settings: {},
  };
  const out = ownBoardOnly(board, me);
  assert.deepEqual(out.notes.map((n) => n.id), ['a', 'b']);
  assert.equal(JSON.stringify(out).includes('FREMD'), false);
});

test('A2: every device-identifying decoration is stripped, and the flags survive', async () => {
  const m = await makeMember();
  const file = await exportWith(m, 'pw');
  const banned = ['ownerId', 'isForeign', '_born', 'entityKey', 'updatedBy', 'uuid', 'level',
    'redacted', 'memberColorRef', 'initial', 'exposure', 'isNew', 'createdAt', 'updatedAt'];
  for (const e of [...file.board.notes, ...file.board.bars]) {
    for (const k of banned) {
      assert.equal(Object.prototype.hasOwnProperty.call(e, k), false, `${k} survived the strip`);
    }
  }
  // …and the fingerprint bytes themselves are gone from the file, not merely from the objects.
  const text = JSON.stringify(file);
  assert.equal(text.includes('A'.repeat(16)), false, 'a _born device fingerprint survived');
  assert.equal(text.includes('B'.repeat(16)), false);
  assert.equal(text.includes('dev_xyz'), false);

  // A2's "with their flags" — the two TRUTH registers, on my entries, unchanged.
  const geteilt = file.board.notes.find((n) => n.id === 'n-geteilt');
  assert.equal(geteilt.visibility, 'geteilt');
  assert.equal(geteilt.coEdit, true);
  assert.equal(geteilt.repeatsYearly, true);
  assert.equal(file.board.bars[0].visibility, 'belegt');
  assert.equal(file.board.notes.find((n) => n.id === 'n-privat').visibility, 'privat');
});

test('A2: the allowlist is v1\'s own field list plus exactly the two truth flags', () => {
  assert.deepEqual([...BACKUP_ENTRY_FIELDS.note], [...V1_ENTRY_FIELDS.note, 'visibility', 'coEdit']);
  assert.deepEqual([...BACKUP_ENTRY_FIELDS.bar], [...V1_ENTRY_FIELDS.bar, 'visibility', 'coEdit']);
  assert.deepEqual([...BACKUP_ENTRY_FIELDS.cat], [...V1_ENTRY_FIELDS.cat]);
  // `level` — what the FAMILY sees — is deliberately NOT in it: a restored board that has not
  // re-joined anything must not assert "others can see this" about a space it is not in.
  for (const k of Object.keys(BACKUP_ENTRY_FIELDS)) {
    assert.equal(BACKUP_ENTRY_FIELDS[k].includes('level'), false);
    assert.equal(BACKUP_ENTRY_FIELDS[k].includes('ownerId'), false);
  }
});

test('A2: categories, scratchpads and settings come through, and the source board is not mutated', async () => {
  const m = await makeMember();
  const board = makeBoard(m.memberId);
  const before = JSON.stringify(board);
  const file = await exportWith(m, 'pw');

  assert.equal(file.board.categories.length, 3);
  assert.deepEqual(file.board.categories[2], { id: 'c3', name: 'Reisen', nameEn: 'Travel', paletteRef: 'orange', visible: false });
  assert.deepEqual(file.board.scratchpads, { '2026-09': 'Hütte buchen?' });
  assert.equal(file.board.settings.bundesland, 'BY');
  assert.deepEqual(file.board.settings.layers, { feiertage: true, schulferien: false });
  assert.equal(JSON.stringify(makeBoard(m.memberId)), before, 'makeBoard is not stable');

  // `settings.layers` is a COPY: mutating the export must not reach back into the store's state.
  const live = makeBoard(m.memberId);
  const out = ownBoardOnly(live, m.memberId);
  out.settings.layers.feiertage = false;
  out.scratchpads['2026-09'] = 'überschrieben';
  assert.equal(live.settings.layers.feiertage, true);
  assert.equal(live.scratchpads['2026-09'], 'Hütte buchen?');
});

test('A2 cannot be enforced without a memberId, so it is required rather than defaulted', () => {
  assert.throws(() => ownBoardOnly({ notes: [] }, ''), /memberId/);
  assert.throws(() => ownBoardOnly({ notes: [] }, null), /memberId/);
  assert.throws(() => ownBoardOnly({ notes: [] }, undefined), /memberId/);
});

test('the board block is stamped schemaVersion 2 and _v2 travels as provenance, not as a claim', async () => {
  const m = await makeMember();
  const file = await exportWith(m, 'pw');
  assert.equal(file.board.schemaVersion, BACKUP_V);
  assert.deepEqual(file.board._v2, { lineageId: 'lin_abc', gen: 7 });

  // …but import strips it and reports it separately: a restored board on a NEW Mac must not claim
  // a lineage that machine's op log has never seen (ADR 006 §5.5).
  const r = await importBackup(roundTripped(file), 'pw', memKeyStore(),
    { deviceId: mkDeviceId(), createdAt: DAY, ...FAST });
  assert.equal('_v2' in r.board, false);
  assert.deepEqual(r.lineage, { lineageId: 'lin_abc', gen: 7 });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Round trip — export → wipe → import → the board and the identity are back
// ═════════════════════════════════════════════════════════════════════════════

test('11.2/11.3 + A2: export → wipe → import restores the board and the identity, and the Kreis re-joins', async () => {
  const m = await makeMember();
  const file = roundTripped(await exportWith(m, 'Familie-2026!'));

  const fresh = memKeyStore();                                     // the wipe: a brand-new machine
  assert.equal((await fresh.list()).length, 0);

  const r = await importBackup(file, 'Familie-2026!', fresh, {
    deviceId: mkDeviceId(), createdAt: '2026-09-15', ...FAST,
  });

  // the board
  assert.equal(r.board.notes.length, 2);
  assert.equal(r.board.bars.length, 1);
  assert.equal(r.board.categories.length, 3);
  assert.equal(r.board.notes[1].text, 'Omas Geburtstag');
  assert.equal(r.board.notes[1].visibility, 'geteilt');
  assert.deepEqual(r.board.scratchpads, { '2026-09': 'Hütte buchen?' });

  // the identity — restored MEMBER, FRESH DEVICE (§7.3 step 3: a device is a machine, not a person)
  assert.equal(r.identityRestored, true);
  assert.equal(r.identity.memberId, m.memberId);
  assert.notEqual(r.identity.deviceShort, m.identity.deviceShort);
  assert.notEqual(r.identity.deviceId, m.identity.deviceId);
  assert.equal(r.identity.devSig.privateKey.extractable, false);
  assert.equal(r.identity.devKex.privateKey.extractable, false);

  // …and the re-join material: a SELF-attestation over the new device keys, signed by the
  // RESTORED recovery key, which is what `POST /devices/adopt` presents (§7.3 steps 4-5).
  assert.equal(r.attestation.memberId, m.memberId);
  assert.equal(r.attestation.deviceShort, r.identity.deviceShort);
  const verified = await identity.verifyAttestation(r.blob, r.identity.recSig.publicKey);
  assert.notEqual(verified, null, 'the restored RK_sig does not verify its own new attestation');
  assert.equal(verified.deviceShort, r.identity.deviceShort);

  // the restored recovery key IS the original one: the ORIGINAL public key verifies the NEW
  // attestation. (Rule 1 — `verify() === true`, never a byte comparison of signatures.)
  const underOriginal = await identity.verifyAttestation(r.blob, m.identity.recSig.publicKey);
  assert.notEqual(underOriginal, null, 'the restored key is not the key that was sealed');

  assert.equal(r.consequence.code, IMPORT_CONSEQUENCE.identityRestored.code);
});

test('the restored epoch keys really decrypt what the ORIGINAL keys encrypted', async () => {
  // The only assertion that proves the key BYTES survived. Comparing exported raw bytes would
  // prove the same thing; doing it through the AEAD proves it the way the product will use it.
  const m = await makeMember();
  const iv = new Uint8Array(AEAD.ivBytes).fill(9);
  const aad = utf8('lzp/v2/test/aad');
  const secrets = new Map();
  for (const [e, k] of m.spaces.family.epochs) {
    secrets.set(e, new Uint8Array(await S.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, k, utf8(`epoche ${e}`)
    )));
  }

  const file = roundTripped(await exportWith(m, 'pw'));
  const r = await importBackup(file, 'pw', memKeyStore(), { deviceId: mkDeviceId(), createdAt: DAY, ...FAST });

  assert.deepEqual([...r.spaces.family.epochs.keys()].sort((a, b) => a - b), [1, 2, 3]);
  assert.deepEqual([...r.spaces.personal.epochs.keys()].sort((a, b) => a - b), [1, 2]);
  assert.equal(r.spaces.family.id, m.spaces.family.id);
  assert.equal(r.spaces.family.epoch, 3);
  assert.equal(r.spaces.personal.id, m.spaces.personal.id);
  assert.equal('epoch' in r.spaces.personal, false, '§7.2 puts `epoch` on `family` only');

  for (const [e, ct] of secrets) {
    const pt = new Uint8Array(await S.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, r.spaces.family.epochs.get(e), ct
    ));
    assert.equal(new TextDecoder().decode(pt), `epoche ${e}`);
  }
});

test('EVERY epoch comes back, not just the current one — Omas Geburtstag from epoch 1 must render', async () => {
  // A4 / 17.1 / ADR 002 §7.1 step 5. A backup that carried only `family.epoch` would restore a
  // member who is in the circle and cannot read three years of it.
  const m = await makeMember();
  const r = await importBackup(roundTripped(await exportWith(m, 'pw')), 'pw', memKeyStore(),
    { deviceId: mkDeviceId(), createdAt: DAY, ...FAST });
  assert.equal(r.spaces.family.epochs.size, m.spaces.family.epochs.size);
  assert.ok(r.spaces.family.epochs.has(1), 'epoch 1 is missing — the history is unreadable');
});

test('the restored recovery pair is usable in BOTH directions: it signs, and it agrees', async () => {
  const m = await makeMember();
  const r = await importBackup(roundTripped(await exportWith(m, 'pw')), 'pw', memKeyStore(),
    { deviceId: mkDeviceId(), createdAt: DAY, ...FAST });

  // RK_sig — rule 2's non-empty payload, rule 1's `verify() === true`.
  const msg = utf8('eine Nachricht');
  const sig = await identity.signBytes(r.identity.recSig.privateKey, msg);
  assert.equal(await identity.verifyBytes(m.identity.recSig.publicKey, sig, msg), true);
  assert.equal(await identity.verifyBytes(r.identity.recSig.publicKey, sig, msg), true);

  // RK_kex — the restored private key agrees with the ORIGINAL public key, in both directions.
  const raw = await identity.exportRawPublic(m.identity.recKex.publicKey);
  const peer = await identity.importKexPublic(raw);
  const a = new Uint8Array(await S.deriveBits({ name: 'ECDH', public: peer }, r.identity.recKex.privateKey, 256));
  const b = new Uint8Array(await S.deriveBits({ name: 'ECDH', public: r.identity.recKex.publicKey }, m.identity.recKex.privateKey, 256));
  assert.equal(toHex(a), toHex(b), 'the restored RK_kex is not the key that was sealed');
});

test('the restored recovery keys stay extractable, so a restored Mac can make the NEXT backup', async () => {
  const m = await makeMember();
  const r = await importBackup(roundTripped(await exportWith(m, 'pw')), 'pw', memKeyStore(),
    { deviceId: mkDeviceId(), createdAt: DAY, ...FAST });
  assert.equal(r.identity.recSig.privateKey.extractable, true);
  assert.equal(r.identity.recKex.privateKey.extractable, true);
  const again = await exportBackup(makeBoard(m.memberId), r.identity, r.spaces, 'pw2',
    { exportedAt: '2026-10-01', app: APP, ...FAST });
  assert.equal(typeof again.identity.sealed, 'string');
  const back = await importBackup(roundTripped(again), 'pw2', memKeyStore(),
    { deviceId: mkDeviceId(), createdAt: DAY, ...FAST });
  assert.equal(back.identity.memberId, m.memberId);
  assert.equal(back.spaces.family.epochs.size, 3);
});

test('re-importing the same backup into the same store is idempotent, not a scary error', async () => {
  const m = await makeMember();
  const file = roundTripped(await exportWith(m, 'pw'));
  const ks = memKeyStore();
  const a = await importBackup(file, 'pw', ks, { deviceId: mkDeviceId(), createdAt: DAY, ...FAST });
  const b = await importBackup(file, 'pw', ks, { deviceId: mkDeviceId(), createdAt: DAY, ...FAST });
  // The DEVICE identity is adopted rather than re-minted — the second `deviceId` is ignored,
  // exactly as `ensureDeviceIdentity` promises.
  assert.equal(b.identity.deviceShort, a.identity.deviceShort);
  assert.equal(b.identity.deviceId, a.identity.deviceId);
  assert.equal(b.identityRestored, true);
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. The board-only path — and the consequence, reported rather than silent
// ═════════════════════════════════════════════════════════════════════════════

test('board-only: the board is back, the identity is absent, and the consequence is on the result', async () => {
  const m = await makeMember();
  const file = roundTripped(await exportWith(m, null));
  const ks = memKeyStore();
  const r = await importBackup(file, null, ks, {});

  assert.equal(r.board.notes.length, 2);
  assert.equal(r.board.bars.length, 1);
  assert.equal(r.identityRestored, false);
  assert.equal(r.identity, null);
  assert.equal(r.spaces, null);
  assert.equal(r.attestation, null);
  assert.equal(r.blob, null);

  // NOT SILENT. The caller cannot get the board without also getting the sentence that says the
  // Familienkreis did not come back with it.
  assert.equal(r.consequence.code, 'no-identity-in-file');
  assert.ok(r.consequence.de.includes('Familienkreis'));
  assert.ok(r.consequence.en.includes('Familienkreis'));
  assert.notEqual(r.consequence.code, IMPORT_CONSEQUENCE.identityRestored.code);
});

test('board-only: the key store is not opened at all — no keys, no partial identity, nothing', async () => {
  const m = await makeMember();
  const ks = memKeyStore();
  await importBackup(roundTripped(await exportWith(m, null)), null, ks, {});
  assert.deepEqual(await ks.list(), []);
  assert.equal(ks.size(), 0);
});

test('board-only: a passphrase offered for a file that has no keys is ignored, and still reported', async () => {
  const m = await makeMember();
  const r = await importBackup(roundTripped(await exportWith(m, null)), 'irgendwas', memKeyStore(), {});
  assert.equal(r.identityRestored, false);
  assert.equal(r.consequence.code, 'no-identity-in-file');
});

test('board-only: the header says what the file IS — it does not claim to be a key', async () => {
  const m = await makeMember();
  const boardOnly = await exportWith(m, null);
  const withKeys = await exportWith(m, 'pw');

  assert.equal(withKeys._README_de, README.withIdentity.de);
  assert.equal(boardOnly._README_de, README.boardOnly.de);
  assert.notEqual(boardOnly._README_de, withKeys._README_de);
  assert.notEqual(boardOnly._README_en, withKeys._README_en);

  // §7.2's German, verbatim — this string is the file's honesty and is not paraphrased.
  assert.equal(
    withKeys._README_de,
    'DIES IST DEIN SCHLÜSSEL. Wer diese Datei und dein Passwort hat, ist du. Ohne diese Datei '
    + 'und ohne deine Macs sind die Daten unwiederbringlich — niemand sonst hat die Schlüssel.'
  );
  // …and the board-only header does NOT say it is a key, which would be a lie the user acts on.
  assert.equal(boardOnly._README_de.includes('DIES IST DEIN SCHLÜSSEL'), false);
  assert.ok(boardOnly._README_de.includes('OHNE DEINE SCHLÜSSEL'));
  assert.ok(boardOnly._README_de.includes('Familienkreis'));
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. A wrong passphrase, and a tampered or truncated file
// ═════════════════════════════════════════════════════════════════════════════

test('a wrong passphrase fails cleanly, with one honest code, and writes nothing', async () => {
  const m = await makeMember();
  const file = roundTripped(await exportWith(m, 'richtig'));
  const ks = memKeyStore();
  // A trailing space and a changed capital are two passphrases a user will genuinely try, and
  // both must fail the same way as an outright wrong one — no partial credit anywhere.
  await refuses('cannot-open', ks, () => importBackup(file, 'falsch', ks, { deviceId: mkDeviceId(), createdAt: DAY, ...FAST }));
  await refuses('cannot-open', ks, () => importBackup(file, 'richtig ', ks, { deviceId: mkDeviceId(), createdAt: DAY, ...FAST }));
  await refuses('cannot-open', ks, () => importBackup(file, 'Richtig', ks, { deviceId: mkDeviceId(), createdAt: DAY, ...FAST }));
  assert.deepEqual(await ks.list(), [], 'three failed imports left something in the key store');
  // …and the right one still opens afterwards: a failed attempt does not damage the file.
  const ok = await importBackup(file, 'richtig', ks, { deviceId: mkDeviceId(), createdAt: DAY, ...FAST });
  assert.equal(ok.identity.memberId, m.memberId);
});

test('the passphrase is NFC-normalised, so a file made with a decomposed umlaut still opens', async () => {
  // The failure this prevents: „Schlüssel" typed on one input path is NFC, on another NFD. Two
  // byte sequences, two derived keys, and a backup that opens on the Mac that made it and nowhere
  // else — discovered months later, with nothing to tell the user.
  const nfc = 'Schlüssel';        // ü as one code point
  const nfd = 'Schlüssel';       // u + combining diaeresis
  assert.notEqual(nfc, nfd, 'the two spellings must really differ as JS strings');
  assert.equal(nfc.normalize('NFC'), nfd.normalize('NFC'));

  const m = await makeMember();
  const file = roundTripped(await exportWith(m, nfd));
  const r = await importBackup(file, nfc, memKeyStore(), { deviceId: mkDeviceId(), createdAt: DAY, ...FAST });
  assert.equal(r.identityRestored, true);
  assert.equal(r.identity.memberId, m.memberId);
});

test('one flipped byte in the ciphertext is caught by the GCM tag, and nothing is applied', async () => {
  const m = await makeMember();
  const file = roundTripped(await exportWith(m, 'pw'));
  const raw = ub64(file.identity.sealed);
  // The first ciphertext byte, one in the middle, the last tag byte, and the byte just before the
  // tag — four places a truncating disk or a careless editor lands.
  const spots = [SEALED_IV_BYTES, SEALED_IV_BYTES + 5, raw.length - 1, raw.length - 17];
  assert.equal(spots.every((i) => i >= 0 && i < raw.length), true, 'the sealed blob is too short to test');
  for (const at of spots) {
    const bad = raw.slice();
    bad[at] ^= 0x01;
    assert.notEqual(toHex(bad), toHex(raw), 'the flip did not change anything');
    const broken = { ...file, identity: { ...file.identity, sealed: b64u(bad) } };
    const ks = memKeyStore();
    await refuses('cannot-open', ks, () => importBackup(broken, 'pw', ks, { deviceId: mkDeviceId(), createdAt: DAY, ...FAST }));
  }
});

test('a flipped byte in the IV is caught too — the IV is inside the sealed blob, not beside it', async () => {
  const m = await makeMember();
  const file = roundTripped(await exportWith(m, 'pw'));
  const raw = ub64(file.identity.sealed);
  assert.ok(raw.length > SEALED_IV_BYTES + 16, 'sealed must hold an IV, a ciphertext and a tag');
  const bad = raw.slice();
  bad[0] ^= 0xff;
  const broken = { ...file, identity: { ...file.identity, sealed: b64u(bad) } };
  const ks = memKeyStore();
  await refuses('cannot-open', ks, () => importBackup(broken, 'pw', ks, { deviceId: mkDeviceId(), createdAt: DAY, ...FAST }));
});

test('a truncated file fails cleanly at every truncation point, and never half-applies', async () => {
  const m = await makeMember();
  const file = roundTripped(await exportWith(m, 'pw'));
  const raw = ub64(file.identity.sealed);
  for (const keep of [0, 1, SEALED_IV_BYTES, SEALED_IV_BYTES + 8, SEALED_IV_BYTES + 16, raw.length - 1, raw.length - 16]) {
    const broken = { ...file, identity: { ...file.identity, sealed: b64u(raw.slice(0, keep)) } };
    const ks = memKeyStore();
    const before = await storeFingerprint(ks);
    await assert.rejects(
      () => importBackup(broken, 'pw', ks, { deviceId: mkDeviceId(), createdAt: DAY, ...FAST }),
      (e) => e instanceof BackupError && ['cannot-open', 'identity-damaged'].includes(e.code)
    );
    assert.deepEqual(await storeFingerprint(ks), before);
  }
});

test('the AAD binds the whole plaintext header: memberId, kdf, dates and the README are all sealed', async () => {
  const m = await makeMember();
  const base = await exportWith(m, 'pw');

  const mutations = [
    ['memberId relabelled', (f) => { f.identity.memberId = mkMemberId(); }],
    ['iterations downgraded', (f) => { f.identity.kdf.iterations = 1; }],
    ['iterations raised', (f) => { f.identity.kdf.iterations = 2000; }],
    ['salt swapped', (f) => { f.identity.kdf.salt = b64u(new Uint8Array(SALT_BYTES).fill(7)); }],
    ['exportedAt back-dated', (f) => { f.exportedAt = '2020-01-01'; }],
    ['app version rewritten', (f) => { f.app = '9.9.9'; }],
    ['the German README stripped', (f) => { f._README_de = ''; }],
    ['the English README stripped', (f) => { f._README_en = 'nothing to see here'; }],
  ];
  for (const [what, mutate] of mutations) {
    const f = roundTripped(base);
    mutate(f);
    const ks = memKeyStore();
    const before = await storeFingerprint(ks);
    await assert.rejects(
      () => importBackup(f, 'pw', ks, { deviceId: mkDeviceId(), createdAt: DAY, ...FAST }),
      (e) => e instanceof BackupError && ['cannot-open', 'identity-damaged'].includes(e.code),
      `${what} was not caught`
    );
    assert.deepEqual(await storeFingerprint(ks), before, `${what} wrote to the key store`);
  }
});

test('S3 — the board block IS authenticated on the identity path, field by field (was the E3-6 characterization)', async () => {
  // ─────────────────────────────────────────────────────────────────────────────────────────
  // INVERTED 2026-08-28. This row used to assert the opposite, and the sentence it was written
  // from was: "there is no key on the board-only path, so board authentication could exist on
  // only one of the two export paths, and a guarantee that holds on one path is worse than one
  // stated plainly." That is true OF THE BOARD-ONLY FILE. The identity-bearing file says „DIES
  // IST DEIN SCHLÜSSEL" across the top and half of it was unsigned (M-B4).
  //
  // Two paths with two DIFFERENT, STATED guarantees is what `LIMITS.board` now carries. The old
  // key `LIMITS.boardNotAuthenticated` survives as an alias — it is quoted by name in FINDINGS.md,
  // STATUS.md and E3-VERIFICATION.md — and now says the smaller true thing about the file it is
  // true of.
  // ─────────────────────────────────────────────────────────────────────────────────────────
  const m = await makeMember();

  // EVERY collection, not one of them: the fix is in the AAD, so a per-field list would measure
  // nothing, but a mutation of each is what proves there is no forgotten branch either.
  const mutations = [
    ['a note rewritten', (f) => { f.board.notes[0].text = 'vom Angreifer eingesetzt'; }],
    ['a note added', (f) => { f.board.notes.push({ id: 'n9', date: '2026-12-24', text: 'eingeschmuggelt' }); }],
    ['every note DELETED', (f) => { f.board.notes = []; }],
    ['a bar rewritten', (f) => { f.board.bars[0].label = 'Dienstreise'; }],
    ['a category added', (f) => { f.board.categories.push({ id: 'c9', name: 'X' }); }],
    ['the Notizzettel', (f) => { f.board.scratchpads['2026-09'] = 'etwas anderes'; }],
    ['the settings', (f) => { f.board.settings.bundesland = 'HH'; }],
    ['the lineage', (f) => { f.board._v2 = { lineageId: 'lin_AAAAAAAAAAAAAAAAAAAAAAAAAA', gen: 1 }; }],
    ['the schema version', (f) => { f.board.schemaVersion = 3; }],
    ['a key REORDERED and a value changed with it', (f) => {
      f.board = { settings: f.board.settings, notes: [], bars: f.board.bars,
        categories: f.board.categories, scratchpads: f.board.scratchpads, schemaVersion: 2 };
    }],
  ];
  for (const [what, mutate] of mutations) {
    const f = roundTripped(await exportWith(m, 'pw'));
    mutate(f);
    const ks = memKeyStore();
    const before = await storeFingerprint(ks);
    await refuses('cannot-open', ks,
      () => importBackup(f, 'pw', ks, { deviceId: mkDeviceId(), createdAt: DAY, ...FAST }));
    assert.deepEqual(await storeFingerprint(ks), before, `${what} wrote to the key store`);
  }

  // …and REORDERING ALONE is not a mutation: the digest sorts, so a file that came back through a
  // JSON writer with a different key order still opens. Without this the fix would be a landmine
  // under every caller that ever re-serializes the file.
  const reordered = roundTripped(await exportWith(m, 'pw'));
  const b = reordered.board;
  reordered.board = { settings: b.settings, scratchpads: b.scratchpads, categories: b.categories,
    bars: b.bars, notes: b.notes, schemaVersion: b.schemaVersion, ...(b._v2 ? { _v2: b._v2 } : {}) };
  const ok = await importBackup(reordered, 'pw', memKeyStore(), { deviceId: mkDeviceId(), createdAt: DAY, ...FAST });
  assert.equal(ok.identityRestored, true, 'a re-ordered board broke the digest');

  // The copy moved with the behaviour, which is the half LZP-1003 audits.
  assert.ok(LIMITS.board.withIdentity.de.includes('versiegelt'));
  assert.ok(LIMITS.board.withIdentity.en.includes('sealed'));
  assert.ok(LIMITS.board.boardOnly.de.includes('nicht signiert'));
  assert.ok(LIMITS.board.boardOnly.en.includes('not signed'));
  assert.equal(LIMITS.boardNotAuthenticated.de, LIMITS.board.boardOnly.de, 'the alias drifted');
  assert.notEqual(LIMITS.board.withIdentity.de, LIMITS.board.boardOnly.de);
});

test('S3 — the BOARD-ONLY file is still unauthenticated, and that is the stated other half', async () => {
  // The honest limit did not disappear; it moved to the path it is true of. A file with no key
  // has nothing to bind a digest with, and pretending otherwise would be the guarantee-on-one-
  // path problem in its real form.
  const m = await makeMember();
  const f = roundTripped(await exportBackup(makeBoard(m.memberId), m.identity, m.spaces, null,
    { exportedAt: DAY, app: APP }));
  assert.equal('identity' in f, false);
  f.board.notes[0].text = 'vom Angreifer eingesetzt';
  const r = await importBackup(f, null, memKeyStore(), {});
  assert.equal(r.board.notes[0].text, 'vom Angreifer eingesetzt');
  assert.equal(r.identityRestored, false);
  assert.equal(r.consequence.code, 'no-identity-in-file');
  // …and the button that produces this file says so, in both languages.
  assert.ok(EXPORT_SHEET_COPY.boardOnly.entriesNotSealed.de.includes('nicht versiegelt'));
  assert.ok(EXPORT_SHEET_COPY.withPassword.sealsEntriesToo.de.includes('versiegelt'));
});

test('S3 — `boardDigestInput` survives the JSON round trip, floats and all', () => {
  // THE ONE EQUATION THE DIGEST HAS TO SATISFY, and the reason it is not `canonicalJSON`:
  // `canonicalJSON` REFUSES floats, and E3-6's second argument against binding the board was that
  // an export would then FAIL on a board whose `settings` picked up a `0.5`. Losing a user's whole
  // export to a stray setting would be the worse failure — so the digest is a total function over
  // everything `JSON.stringify` can write, and this is the row that says so.
  const trip = (b) => JSON.parse(JSON.stringify(b));
  const same = (b, why) => assert.deepEqual([...boardDigestInput(b)], [...boardDigestInput(trip(b))], why);

  const boards = [
    { schemaVersion: 2, notes: [], bars: [], categories: [], scratchpads: {}, settings: {} },
    { settings: { zoom: 0.5, offset: -1.25, big: 1e21, tiny: 5e-324 } },       // floats — the E3-6 objection
    { settings: { a: null, b: false, c: '' } },
    { scratchpads: { '2026-09': 'Hütte buchen?', '2026-10': 'Grüße' } },        // NFC and NFD alike
    { scratchpads: { '\u00e4': 'NFC', 'a\u0308': 'NFD' } },   // two keys that COLLIDE under NFC:
    //                                                    `canonicalJSON` refuses this outright
    { notes: [{ id: 'n1', text: 'a'.repeat(4000) }] },
    { settings: { '0': 'integer-like key', '10': 'x', '2': 'y', z: 'last' } },  // engine key ordering
    { deep: { a: { b: { c: [1, [2, [3, {}]]] } } } },
  ];
  for (const b of boards) same(b, JSON.stringify(b).slice(0, 60));

  // Order is not content in an OBJECT…
  assert.deepEqual([...boardDigestInput({ a: 1, b: 2 })], [...boardDigestInput({ b: 2, a: 1 })]);
  // …and it IS content in an ARRAY. A board whose entries were re-ordered is a different board.
  assert.notDeepEqual([...boardDigestInput({ n: [1, 2] })], [...boardDigestInput({ n: [2, 1] })]);
  // `undefined` is dropped by JSON.stringify on both sides, so it must be dropped here too.
  assert.deepEqual([...boardDigestInput({ a: 1, b: undefined })], [...boardDigestInput({ a: 1 })]);
  // Rule 2: never zero-length, not even for the emptiest board there is.
  assert.ok(boardDigestInput({}).length > 0);
});

test('two exports of the same identity are different files, and both open', async () => {
  // The salt and the IV are fresh every time. Two identical-looking exports that produced the
  // same `sealed` would mean a fixed salt, which is a real weakness in a passphrase-derived key.
  const m = await makeMember();
  const a = await exportWith(m, 'pw');
  const b = await exportWith(m, 'pw');
  assert.notEqual(a.identity.kdf.salt, b.identity.kdf.salt);
  assert.notEqual(a.identity.sealed, b.identity.sealed);
  for (const f of [a, b]) {
    const r = await importBackup(roundTripped(f), 'pw', memKeyStore(), { deviceId: mkDeviceId(), createdAt: DAY, ...FAST });
    assert.equal(r.identity.memberId, m.memberId);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. What the file has to be before anything is read out of it
// ═════════════════════════════════════════════════════════════════════════════

test('a non-file is refused before any work happens', async () => {
  for (const junk of [null, undefined, 7, 'x', [], true, new Date(0)]) {
    assert.throws(() => inspectBackup(junk), (e) => e instanceof BackupError && e.code === 'not-a-backup');
  }
});

test('a v1 board gets its own code, because there IS a door for it — just not this one', () => {
  const v1 = { schemaVersion: 1, notes: [], bars: [], categories: [], scratchpads: {}, settings: {} };
  assert.throws(() => inspectBackup(v1), (e) => e instanceof BackupError && e.code === 'v1-board');
  // "not a backup" would send the user to delete a perfectly good file.
  assert.throws(() => inspectBackup(v1), (e) => e.say.de.includes('früheren Version'));
});

test('a newer backup version is refused rather than half-understood', () => {
  const f = { format: BACKUP_FORMAT, v: 3, board: { notes: [] } };
  assert.throws(() => inspectBackup(f), (e) => e.code === 'unsupported-version');
  assert.throws(() => inspectBackup({ ...f, v: 1 }), (e) => e.code === 'unsupported-version');
  assert.throws(() => inspectBackup({ ...f, v: '2' }), (e) => e.code === 'unsupported-version');
});

test('a missing or unrecognisable board block is a damaged file, not an empty board', async () => {
  // The `{}` trap from `store.js`'s classifier, one layer out: treating an unrecognisable object
  // as an empty board is an AUTHORITATIVE ASSERTION that the user has no entries.
  const m = await makeMember();
  const good = roundTripped(await exportWith(m, 'pw'));
  for (const board of [undefined, null, {}, [], 'x', 7, { schemaVersion: 2 }, { hello: 'welt' }, { notes: 'nicht ein array' }]) {
    const f = { ...good };
    if (board === undefined) delete f.board; else f.board = board;
    assert.throws(() => inspectBackup(f), (e) => e instanceof BackupError && e.code === 'board-damaged',
      `board ${JSON.stringify(board)} was accepted`);
  }
  // …but a board that is genuinely empty, with the collections present, IS a board.
  const empty = { ...good, board: { schemaVersion: 2, notes: [], bars: [], categories: [], scratchpads: {}, settings: {} } };
  assert.equal(inspectBackup(empty).counts.notes, 0);
});

test('a damaged identity block is refused structurally, before a single PBKDF2 round is run', async () => {
  const m = await makeMember();
  const good = roundTripped(await exportWith(m, 'pw'));
  const broken = [
    ['identity is not an object', (f) => { f.identity = 'x'; }],
    ['no memberId', (f) => { delete f.identity.memberId; }],
    ['empty memberId', (f) => { f.identity.memberId = ''; }],
    // THE SHAPE, found by running this module in WKWebView (tests/tier2/crypto-backup.dom.js).
    // A mis-shaped MemberId imports "successfully" and then yields an attestation that
    // `core/authz.js`'s `parseAttestationBlob` refuses on every machine — the adopt request is
    // rejected and the member never joins anything, with nothing anywhere saying why.
    ['a memberId of the wrong shape', (f) => { f.identity.memberId = 'mem_ZUKURZ'; }],
    ['a memberId with no prefix', (f) => { f.identity.memberId = 'jemand'; }],
    ['a deviceId offered as a memberId', (f) => { f.identity.memberId = mkDeviceId(); }],
    ['no kdf', (f) => { delete f.identity.kdf; }],
    ['wrong kdf name', (f) => { f.identity.kdf.name = 'scrypt'; }],
    ['wrong kdf hash', (f) => { f.identity.kdf.hash = 'SHA-512'; }],
    ['iterations 0', (f) => { f.identity.kdf.iterations = 0; }],
    ['iterations negative', (f) => { f.identity.kdf.iterations = -1; }],
    ['iterations a float', (f) => { f.identity.kdf.iterations = 1000.5; }],
    ['iterations a string', (f) => { f.identity.kdf.iterations = '600000'; }],
    ['no salt', (f) => { delete f.identity.kdf.salt; }],
    ['short salt', (f) => { f.identity.kdf.salt = b64u(new Uint8Array(16)); }],
    ['salt is not base64url', (f) => { f.identity.kdf.salt = '!!!!'; }],
    ['no sealed', (f) => { delete f.identity.sealed; }],
    ['sealed is empty', (f) => { f.identity.sealed = ''; }],
    ['sealed is not base64url', (f) => { f.identity.sealed = '###'; }],
    ['sealed is IV-only', (f) => { f.identity.sealed = b64u(new Uint8Array(SEALED_IV_BYTES)); }],
  ];
  for (const [what, mutate] of broken) {
    const f = roundTripped(good);
    mutate(f);
    assert.throws(() => inspectBackup(f), (e) => e instanceof BackupError && e.code === 'identity-damaged', what);
  }
});

test('an absurd iteration count is a denial of service, so it is clamped rather than obeyed', async () => {
  // `{"iterations": 1e12}` in a hostile file would look exactly like a slow import. The clamp is
  // structural — it fires in `inspectBackup`, which runs no crypto at all — so the refusal is
  // instant rather than eventually.
  const m = await makeMember();
  const f = roundTripped(await exportWith(m, 'pw'));
  f.identity.kdf.iterations = 1e12;
  assert.throws(() => inspectBackup(f), (e) => e.code === 'identity-damaged');
  assert.equal(MAX_KDF_ITERATIONS, 10_000_000);
  assert.ok(MAX_KDF_ITERATIONS > BACKUP_KDF.iterations, 'a file written at the production count must still open');

  const ks = memKeyStore();
  await refuses('identity-damaged', ks, () => importBackup(f, 'pw', ks, { deviceId: mkDeviceId(), createdAt: DAY, ...FAST }));
});

test('a file with keys and no passphrase asks, rather than silently restoring half of itself', async () => {
  const m = await makeMember();
  const f = roundTripped(await exportWith(m, 'pw'));

  // The UI can know BEFORE it commits the user to anything — that is what makes the reduced
  // outcome a choice instead of a surprise.
  const seen = inspectBackup(f);
  assert.equal(seen.needsPassphrase, true);
  assert.equal(seen.hasIdentity, true);
  assert.equal(seen.memberId, m.memberId);
  assert.deepEqual(seen.counts, { notes: 2, bars: 1, categories: 3 });
  assert.equal(seen.kdf.iterations, FAST.iterations);

  const ks = memKeyStore();
  await refuses('passphrase-required', ks, () => importBackup(f, null, ks, { deviceId: mkDeviceId(), createdAt: DAY }));
});

test('inspectBackup on a board-only file says so, and names the consequence up front', async () => {
  const m = await makeMember();
  const seen = inspectBackup(roundTripped(await exportWith(m, null)));
  assert.equal(seen.hasIdentity, false);
  assert.equal(seen.needsPassphrase, false);
  assert.equal(seen.memberId, null);
  assert.equal(seen.kdf, null);
  assert.equal(seen.consequence.code, 'no-identity-in-file');
  assert.equal(seen.exportedAt, DAY);
  assert.equal(seen.app, APP);
});

test('every BackupError carries a code from the fixed list and a sentence in both languages', () => {
  assert.equal(new Set(BACKUP_ERROR_CODES).size, BACKUP_ERROR_CODES.length);
  assert.throws(() => new BackupError('erfunden', 'x', { de: 'a', en: 'b' }), /unknown code/);
  const e = new BackupError('not-a-backup', 'dev message', { de: 'de', en: 'en' });
  assert.equal(e.name, 'BackupError');
  assert.equal(e.code, 'not-a-backup');
  assert.deepEqual({ ...e.say }, { de: 'de', en: 'en' });
  assert.equal(Object.isFrozen(e), true);
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. The key store — refuse BEFORE writing, and never half-apply
// ═════════════════════════════════════════════════════════════════════════════

test('a store already holding ANOTHER member\'s recovery identity is a refusal, not an overwrite', async () => {
  // §8.12: a recovery key has no revocation. Writing over one silently orphans that member from
  // their own Familienkreis with no way back and no way to notice.
  const m = await makeMember();
  const file = roundTripped(await exportWith(m, 'pw'));
  const other = memKeyStore();
  const otherId = mkMemberId();
  const theirs = await identity.ensureRecoveryIdentity(other, otherId, { createdAt: DAY });
  await refuses('keystore-conflict', other,
    () => importBackup(file, 'pw', other, { deviceId: mkDeviceId(), createdAt: DAY, ...FAST }));

  // The other member's recovery key is still THEIRS afterwards, and still works. This is the
  // assertion that matters: `refuses()` proves the ids and the byte lengths are unchanged, this
  // proves the KEY behind them was not swapped.
  const still = await identity.ensureRecoveryIdentity(other, otherId, {});
  const msg = utf8('unversehrt');
  const sig = await identity.signBytes(still.recSig.privateKey, msg);
  assert.equal(await identity.verifyBytes(theirs.recSig.publicKey, sig, msg), true);
  assert.equal(await identity.verifyBytes(m.identity.recSig.publicKey, sig, msg), false);
});

test('a store already holding another member\'s DEVICE identity is refused too', async () => {
  const m = await makeMember();
  const file = roundTripped(await exportWith(m, 'pw'));
  const other = memKeyStore();
  const squatterId = mkMemberId();
  const theirDevice = await identity.ensureDeviceIdentity(other, squatterId, { deviceId: mkDeviceId(), createdAt: DAY });
  await refuses('keystore-conflict', other,
    () => importBackup(file, 'pw', other, { deviceId: mkDeviceId(), createdAt: DAY, ...FAST }));

  // Refused BEFORE the recovery half was written — otherwise this Mac would end up holding one
  // member's device identity and another member's recovery key, which nothing downstream can
  // make sense of.
  assert.deepEqual((await other.list()).sort(), [
    identity.KEYSTORE_IDS.devKex, identity.KEYSTORE_IDS.devMeta, identity.KEYSTORE_IDS.devSig,
  ].sort());
  const untouched = await identity.ensureDeviceIdentity(other, squatterId, {});
  assert.equal(untouched.deviceShort, theirDevice.deviceShort);
});

test('S4 — a PARTIAL key store is refused, CLEARED, and the retry succeeds (was: refused for ever)', async () => {
  // ─────────────────────────────────────────────────────────────────────────────────────────
  // INVERTED 2026-08-28. This row used to end with `assert.equal((await halfRec.list()).length,
  // 2)` — "the partial store was completed instead of refused" — and that assertion was right
  // about the danger and wrong about the remedy: it pinned a state the module could never leave.
  // A user with a half-written store and their own backup file had no supported way to finish
  // (M-B5). The refusal stays; what changed is that the residue does not.
  //
  // Both orders below are the ones a crash actually produces, and the member id MATCHES in both:
  // this is the user's own Mac and the user's own file, which is exactly the case that must not
  // be permanent.
  // ─────────────────────────────────────────────────────────────────────────────────────────
  const m = await makeMember();
  const file = roundTripped(await exportWith(m, 'pw'));
  const imp = () => ({ deviceId: mkDeviceId(), createdAt: DAY, ...FAST });

  const halfRec = memKeyStore();
  await identity.ensureRecoveryIdentity(halfRec, m.memberId, { createdAt: DAY });
  await halfRec.del(identity.KEYSTORE_IDS.recMeta);
  assert.equal((await halfRec.list()).length, 2);
  await refuses('keystore-partial', halfRec, () => importBackup(file, 'pw', halfRec, imp()), 'cleared');
  const a = await importBackup(file, 'pw', halfRec, imp());
  assert.equal(a.identityRestored, true, 'the retry is still refused — S4 is not closed');
  assert.equal((await halfRec.list()).length, 6);

  const halfDev = memKeyStore();
  await identity.ensureDeviceIdentity(halfDev, m.memberId, { deviceId: mkDeviceId(), createdAt: DAY });
  await halfDev.del(identity.KEYSTORE_IDS.devKex);
  assert.equal((await halfDev.list()).length, 2);
  await refuses('keystore-partial', halfDev, () => importBackup(file, 'pw', halfDev, imp()), 'cleared');
  const b = await importBackup(file, 'pw', halfDev, imp());
  assert.equal(b.identityRestored, true);

  // …and every 1-of-3 and 2-of-3 shape, not the two a human happened to think of. Six records,
  // six ways to lose one, six ways to lose two — the residue is dead in all of them.
  const IDS = [identity.KEYSTORE_IDS.recSig, identity.KEYSTORE_IDS.recKex, identity.KEYSTORE_IDS.recMeta];
  for (const keep of [[0], [1], [2], [0, 1], [0, 2], [1, 2]]) {
    const ks = memKeyStore();
    await importBackup(file, 'pw', ks, imp());
    for (let i = 0; i < IDS.length; i++) if (!keep.includes(i)) await ks.del(IDS[i]);
    await ks.del(identity.KEYSTORE_IDS.devSig);
    await ks.del(identity.KEYSTORE_IDS.devKex);
    await ks.del(identity.KEYSTORE_IDS.devMeta);
    assert.equal((await ks.list()).length, keep.length);
    await refuses('keystore-partial', ks, () => importBackup(file, 'pw', ks, imp()), 'cleared');
    const again = await importBackup(file, 'pw', ks, imp());
    assert.equal(again.identityRestored, true, `residue ${JSON.stringify(keep)} is not repairable`);
  }

  // The sentence changed with the behaviour — „muss neu gekoppelt werden" was true of a module
  // that never deleted, and would now send the user to re-pair a Mac that needs one more click.
  const err = await (async () => {
    const ks = memKeyStore();
    await identity.ensureRecoveryIdentity(ks, m.memberId, { createdAt: DAY });
    await ks.del(identity.KEYSTORE_IDS.recMeta);
    try { await importBackup(file, 'pw', ks, imp()); return null; } catch (e) { return e; }
  })();
  assert.equal(err.code, 'keystore-partial');
  assert.ok(err.say.de.includes('noch einmal'), err.say.de);
  assert.equal(err.say.de.includes('neu gekoppelt'), false, 'the copy still tells the user to re-pair');
  assert.ok(err.say.en.toLowerCase().includes('once more'));
});

test('S4 — a store belonging to SOMEBODY ELSE is never cleared, not even when it is partial', async () => {
  // The other side of the same decision, and the one that makes the delete defensible: the
  // residue is cleared because it is provably dead AND provably not somebody else's. A partial
  // store that still NAMES another member is a `keystore-conflict` — which is strictly stricter
  // than before, when a partial store was `keystore-partial` whoever it belonged to.
  const mine = await makeMember();
  const theirs = await makeMember();
  const file = roundTripped(await exportWith(mine, 'pw'));
  const imp = () => ({ deviceId: mkDeviceId(), createdAt: DAY, ...FAST });

  for (const drop of [identity.KEYSTORE_IDS.recSig, identity.KEYSTORE_IDS.recKex]) {
    const ks = memKeyStore();
    await identity.ensureRecoveryIdentity(ks, theirs.memberId, { createdAt: DAY });
    await ks.del(drop);                       // 2 of 3, and the META that names them survives
    const before = (await ks.list()).sort();
    assert.equal(before.length, 2);
    await refuses('keystore-conflict', ks, () => importBackup(file, 'pw', ks, imp()));
    assert.deepEqual((await ks.list()).sort(), before, 'somebody else\'s records were deleted');
    // …and it stays refused. A retry that suddenly worked would be the defect.
    await refuses('keystore-conflict', ks, () => importBackup(file, 'pw', ks, imp()));
  }

  // The same for the DEVICE half.
  const ks = memKeyStore();
  await identity.ensureDeviceIdentity(ks, theirs.memberId, { deviceId: mkDeviceId(), createdAt: DAY });
  await ks.del(identity.KEYSTORE_IDS.devSig);
  const before = (await ks.list()).sort();
  await refuses('keystore-conflict', ks, () => importBackup(file, 'pw', ks, imp()));
  assert.deepEqual((await ks.list()).sort(), before);
});

test('S4 — the delete is behind the AEAD tag: a wrong passphrase cannot wipe a residue', async () => {
  // WHERE the check runs is half the argument. `prepareKeyStore` is step 4, after the file has
  // been authenticated under the user's passphrase, so somebody who finds the Mac and hands it a
  // file it cannot open never reaches the delete — nor does a file whose board was rewritten.
  const m = await makeMember();
  const file = roundTripped(await exportWith(m, 'pw'));
  const imp = () => ({ deviceId: mkDeviceId(), createdAt: DAY, ...FAST });

  const attempts = [
    ['a wrong passphrase', (f) => f, 'falsch'],
    ['a rewritten board', (f) => { f.board.notes[0].text = 'x'; return f; }, 'pw'],
  ];
  for (const [what, tamper, pw] of attempts) {
    const ks = memKeyStore();
    await identity.ensureRecoveryIdentity(ks, m.memberId, { createdAt: DAY });
    await ks.del(identity.KEYSTORE_IDS.recMeta);
    const before = (await ks.list()).sort();
    await refuses('cannot-open', ks, () => importBackup(tamper(roundTripped(file)), pw, ks, imp()));
    assert.deepEqual((await ks.list()).sort(), before, `${what} reached the delete`);
  }
});

test('the restored recovery records are the shape identity.js writes, so ensureRecoveryIdentity ADOPTS them', async () => {
  // If the layout drifted, the next launch would see a foreign store and refuse to start the
  // family features — a bug that only shows up on the second run after a restore.
  const m = await makeMember();
  const ks = memKeyStore();
  await importBackup(roundTripped(await exportWith(m, 'pw')), 'pw', ks,
    { deviceId: mkDeviceId(), createdAt: '2026-09-15', ...FAST });

  const adopted = await identity.ensureRecoveryIdentity(ks, m.memberId, {});   // no createdAt ⇒ must NOT mint
  assert.equal(adopted.memberId, m.memberId);
  assert.equal(adopted.createdAt, '2026-09-15');
  const msg = utf8('adoptiert');
  const sig = await identity.signBytes(adopted.recSig.privateKey, msg);
  assert.equal(await identity.verifyBytes(m.identity.recSig.publicKey, sig, msg), true);

  const readBack = await identity.ensureDeviceIdentity(ks, m.memberId, {});
  assert.equal(readBack.memberId, m.memberId);
  assert.deepEqual((await ks.list()).sort(), [
    identity.KEYSTORE_IDS.devKex, identity.KEYSTORE_IDS.devMeta, identity.KEYSTORE_IDS.devSig,
    identity.KEYSTORE_IDS.recKex, identity.KEYSTORE_IDS.recMeta, identity.KEYSTORE_IDS.recSig,
  ].sort());
});

test('an identity import without an injected deviceId or createdAt throws before touching the store', async () => {
  const m = await makeMember();
  const file = roundTripped(await exportWith(m, 'pw'));
  for (const opts of [{}, { deviceId: mkDeviceId() }, { createdAt: DAY }, { deviceId: '', createdAt: DAY }, { deviceId: mkDeviceId(), createdAt: 'gestern' }]) {
    const ks = memKeyStore();
    await assert.rejects(() => importBackup(file, 'pw', ks, { ...opts, ...FAST }), /deviceId|createdAt/);
    assert.deepEqual(await ks.list(), [], 'the store was written before the arguments were checked');
  }
});

test('a KeyStore missing part of its port is refused, not called half-way', async () => {
  const m = await makeMember();
  const file = roundTripped(await exportWith(m, 'pw'));
  const full = memKeyStore();
  for (const drop of ['get', 'put', 'del', 'list']) {
    const crippled = { ...full, [drop]: undefined };
    await assert.rejects(() => importBackup(file, 'pw', crippled, { deviceId: mkDeviceId(), createdAt: DAY, ...FAST }),
      new RegExp(drop));
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. The passphrase chain — pinned by a SECOND, INDEPENDENT implementation
// ═════════════════════════════════════════════════════════════════════════════

test('KAT: a second implementation of PBKDF2 → HKDF(lzp/v2/backup) → AES-GCM opens a real file', async () => {
  // The chain ADR 002 §7.2 leaves half-specified (see backup.js's resolution 2) is pinned here by
  // reproducing it from `tests/helpers/kat.js`'s hand-rolled RFC 8018 / RFC 5869 code, which
  // shares no line with the engine. If either the order of the two KDFs, the salt reuse, or the
  // info label ever changes, this goes red — and every file in the field would otherwise have
  // stopped opening in silence.
  const m = await makeMember();
  const file = roundTripped(await exportWith(m, 'ein Passwort', { iterations: 500 }));

  const salt = ub64(file.identity.kdf.salt);
  const ikm = purePbkdf2(utf8('ein Passwort'), salt, 500, 32);
  const raw = pureHkdf(salt, ikm, infoBytes(INFO.backup), 32);
  const key = await S.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);

  const sealed = ub64(file.identity.sealed);
  const iv = sealed.slice(0, SEALED_IV_BYTES);
  const ct = sealed.slice(SEALED_IV_BYTES);
  const aad = utf8(JSON.stringify({                     // canonical: sorted keys, no whitespace
    _README_de: file._README_de,
    _README_en: file._README_en,
    app: file.app,
    board: { digest: await katBoardDigest(file.board), hash: 'SHA-256' },   // S3
    exportedAt: file.exportedAt,
    format: file.format,
    kdf: { hash: 'SHA-256', iterations: 500, name: 'PBKDF2', salt: file.identity.kdf.salt },
    memberId: file.identity.memberId,
    v: file.v,
  }));
  const pt = new Uint8Array(await S.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, ct));
  const payload = JSON.parse(new TextDecoder().decode(pt));

  assert.deepEqual(Object.keys(payload).sort(), ['family', 'personal', 'recKexPkcs8', 'recSigPkcs8']);
  assert.equal(ub64(payload.recSigPkcs8).length, PKCS8_P256_BYTES);
  assert.equal(ub64(payload.recKexPkcs8).length, PKCS8_P256_BYTES);
  assert.equal(payload.family.id, m.spaces.family.id);
  assert.equal(payload.family.epoch, 3);
  assert.deepEqual(Object.keys(payload.personal.epochs).sort(), ['1', '2']);
  assert.equal(ub64(payload.family.epochs['1']).length, SYMMETRIC_KEY_BYTES);
  assert.equal('epoch' in payload.personal, false);
});

test('KAT: the derived key is a fixed function of (passphrase, salt, iterations) — a pinned vector', async () => {
  // AES-GCM under a fixed key, IV and AAD IS deterministic, so unlike a signature (rule 1) this
  // can be a golden vector. It pins the WHOLE chain in one number.
  const salt = hex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
  const iv = new Uint8Array(AEAD.ivBytes).fill(0x2a);
  const aad = utf8('lzp/v2/test/kat');
  const key = await deriveBackupKey('Ein Passwort mit ÄÖÜ', salt, 4096);
  const ct = new Uint8Array(await S.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, utf8('LZP')));

  const again = await deriveBackupKey('Ein Passwort mit ÄÖÜ', salt, 4096);
  const ct2 = new Uint8Array(await S.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, again, utf8('LZP')));
  assert.equal(toHex(ct), toHex(ct2), 'the derivation is not deterministic');

  // The second implementation reaches the same bytes.
  const raw = pureHkdf(salt, purePbkdf2(utf8('Ein Passwort mit ÄÖÜ'.normalize('NFC')), salt, 4096, 32), infoBytes(INFO.backup), 32);
  const mirror = await S.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct3 = new Uint8Array(await S.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, mirror, utf8('LZP')));
  assert.equal(toHex(ct3), toHex(ct));
});

test('the HKDF label is load-bearing: any other label derives a different key', async () => {
  const salt = new Uint8Array(SALT_BYTES).fill(3);
  const iv = new Uint8Array(AEAD.ivBytes).fill(1);
  const aad = utf8('x');
  const real = await deriveBackupKey('pw', salt, 512);
  const ct = new Uint8Array(await S.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, real, utf8('LZP')));

  for (const label of [INFO.spaceKeyWrap, INFO.deviceDek, INFO.pairKek]) {
    const raw = pureHkdf(salt, purePbkdf2(utf8('pw'), salt, 512, 32), infoBytes(label), 32);
    const other = await S.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
    const ctOther = new Uint8Array(await S.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, other, utf8('LZP')));
    assert.notEqual(toHex(ctOther), toHex(ct), `${label} derived the same key as ${INFO.backup}`);
  }
});

test('the salt and the iteration count both change the key', async () => {
  const iv = new Uint8Array(AEAD.ivBytes).fill(5);
  const aad = utf8('x');
  const enc = async (k) => toHex(new Uint8Array(await S.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, k, utf8('LZP'))));
  const a = await enc(await deriveBackupKey('pw', new Uint8Array(SALT_BYTES).fill(1), 512));
  const b = await enc(await deriveBackupKey('pw', new Uint8Array(SALT_BYTES).fill(2), 512));
  const c = await enc(await deriveBackupKey('pw', new Uint8Array(SALT_BYTES).fill(1), 513));
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('deriveBackupKey refuses a missing salt (rule 4) and a nonsensical iteration count', async () => {
  await assert.rejects(() => deriveBackupKey('pw', undefined, 512), /salt/);
  await assert.rejects(() => deriveBackupKey('pw', new Uint8Array(0), 512), /salt/);
  await assert.rejects(() => deriveBackupKey('pw', new Uint8Array(SALT_BYTES), 0), /iterations/);
  await assert.rejects(() => deriveBackupKey('pw', new Uint8Array(SALT_BYTES), 1.5), /iterations/);
});

test('THE PRODUCTION PATH: 600 000 real rounds, exported and imported end to end', async () => {
  // The two tests in this file that pay the real number. Everything else injects a smaller one,
  // and a suite in which NOTHING ran the shipped parameter would be characterising a different
  // product from the one that ships.
  const m = await makeMember();
  const file = roundTripped(await exportBackup(makeBoard(m.memberId), m.identity, m.spaces, 'Ein echtes Passwort',
    { exportedAt: DAY, app: APP }));
  assert.equal(file.identity.kdf.iterations, 600000);

  const r = await importBackup(file, 'Ein echtes Passwort', memKeyStore(), { deviceId: mkDeviceId(), createdAt: DAY });
  assert.equal(r.identityRestored, true);
  assert.equal(r.identity.memberId, m.memberId);
  assert.equal(r.board.notes.length, 2);
  assert.equal(r.spaces.family.epochs.size, 3);

  const ks = memKeyStore();
  await refuses('cannot-open', ks, () => importBackup(file, 'Ein falsches Passwort', ks, { deviceId: mkDeviceId(), createdAt: DAY }));
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. The engine rules this module walks into
// ═════════════════════════════════════════════════════════════════════════════

test('ENGINE DIFFERENCE 9: importing a P-256 PRIVATE key with `verify` in the usages is refused', async () => {
  // The trap the restore path is built around, asserted against the real engine rather than
  // trusted from the contract: `generateKey` splits `['sign','verify']` across the pair and
  // `importKey` does not.
  const m = await makeMember();
  const pkcs8 = new Uint8Array(await S.exportKey('pkcs8', m.identity.recSig.privateKey));
  assert.equal(pkcs8.length, PKCS8_P256_BYTES);
  await assert.rejects(() => S.importKey('pkcs8', pkcs8, SIG, true, ['sign', 'verify']));
  await assert.rejects(() => S.importKey('pkcs8', pkcs8, SIG, true, ['verify']));
  // …and with only the private usages it works, which is what `USAGES.sigPrivate` exists for.
  const ok = await S.importKey('pkcs8', pkcs8, SIG, true, [...USAGES.sigPrivate]);
  assert.equal(ok.type, 'private');
  assert.deepEqual(ok.usages, ['sign']);
});

test('RULE 6\'s arithmetic holds for the keys this module actually seals: 138 is not a multiple of 8', async () => {
  const m = await makeMember();
  for (const k of [m.identity.recSig.privateKey, m.identity.recKex.privateKey]) {
    const pkcs8 = new Uint8Array(await S.exportKey('pkcs8', k));
    assert.equal(pkcs8.length, PKCS8_P256_BYTES);
    assert.notEqual(pkcs8.length % 8, 0, 'AES-KW would be an OperationError over this — §1 rule 6');
  }
  // Which is why the seal is AES-GCM: the sealed blob is IV + ciphertext + a 16-byte tag over a
  // canonical JSON payload, and no length is a multiple of anything.
  const file = await exportWith(m, 'pw');
  const sealed = ub64(file.identity.sealed);
  assert.equal(sealed.length > SEALED_IV_BYTES + 16, true);
  assert.equal(SEALED_IV_BYTES, AEAD.ivBytes);
  assert.equal(AEAD.ivBytes, 12);
});

test('RULE 5: the reconstructed RK_kex public key carries NO usages, and still agrees', async () => {
  const m = await makeMember();
  const r = await importBackup(roundTripped(await exportWith(m, 'pw')), 'pw', memKeyStore(),
    { deviceId: mkDeviceId(), createdAt: DAY, ...FAST });
  assert.deepEqual(r.identity.recKex.publicKey.usages, []);
  assert.deepEqual(r.identity.recSig.publicKey.usages, ['verify']);
  assert.deepEqual(r.identity.recSig.privateKey.usages, ['sign']);
  assert.deepEqual([...USAGES.peerKex], []);
  assert.equal(r.identity.recKex.publicKey.algorithm.name, KEX.name);
});

test('nothing in this module branches on an engine error NAME (rule 3)', async () => {
  // Proved by behaviour: the two causes the engine cannot distinguish arrive as ONE code, and a
  // `BackupError` raised inside the decrypt boundary is not swallowed by it.
  const m = await makeMember();
  const file = roundTripped(await exportWith(m, 'pw'));

  const wrongPass = await importBackup(file, 'falsch', memKeyStore(), { deviceId: mkDeviceId(), createdAt: DAY, ...FAST })
    .then(() => null, (e) => e);
  const tampered = { ...file, identity: { ...file.identity, memberId: mkMemberId() } };
  const altered = await importBackup(tampered, 'pw', memKeyStore(), { deviceId: mkDeviceId(), createdAt: DAY, ...FAST })
    .then(() => null, (e) => e);
  assert.equal(wrongPass.code, 'cannot-open');
  assert.equal(altered.code, 'cannot-open');
  assert.equal(wrongPass.say.de, altered.say.de, 'two indistinguishable causes must give one honest answer');
  assert.ok(wrongPass.say.de.includes('Passwort'));
  assert.ok(wrongPass.say.de.includes('verändert'));

  // …and an empty passphrase is OUR error, raised inside the same try, and it survives as itself.
  const empty = await importBackup(file, '   ', memKeyStore(), { deviceId: mkDeviceId(), createdAt: DAY, ...FAST })
    .then(() => null, (e) => e);
  assert.equal(empty.code, 'passphrase-empty');
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. Space keys
// ═════════════════════════════════════════════════════════════════════════════

test('a member with no Familienkreis exports and imports cleanly, with both bundles null', async () => {
  const m = await makeMember();
  const file = roundTripped(await exportBackup(makeBoard(m.memberId), m.identity, null, 'pw',
    { exportedAt: DAY, app: APP, ...FAST }));
  const r = await importBackup(file, 'pw', memKeyStore(), { deviceId: mkDeviceId(), createdAt: DAY, ...FAST });
  assert.equal(r.identityRestored, true);
  assert.equal(r.spaces.personal, null);
  assert.equal(r.spaces.family, null);
  assert.equal(r.identity.memberId, m.memberId);
});

test('an epoch key may arrive as raw bytes or as a CryptoKey, and both restore identically', async () => {
  const m = await makeMember();
  const rawKey = globalThis.crypto.getRandomValues(new Uint8Array(SYMMETRIC_KEY_BYTES));
  const spaces = { personal: null, family: { id: mkSpaceId('family'), epoch: 1, epochs: { 1: rawKey } } };
  const file = roundTripped(await exportBackup(makeBoard(m.memberId), m.identity, spaces, 'pw',
    { exportedAt: DAY, app: APP, ...FAST }));
  const r = await importBackup(file, 'pw', memKeyStore(), { deviceId: mkDeviceId(), createdAt: DAY, ...FAST });
  const back = new Uint8Array(await S.exportKey('raw', r.spaces.family.epochs.get(1)));
  assert.equal(toHex(back), toHex(rawKey));
  assert.equal(r.spaces.family.epochs.get(1).extractable, true, 'a space key must stay wrappable (§3)');
});

test('an empty key ring is refused: a backup carries every epoch, or it is not a recovery artifact', async () => {
  const m = await makeMember();
  for (const epochs of [new Map(), {}]) {
    await assert.rejects(
      () => exportBackup(makeBoard(m.memberId), m.identity, { family: { id: mkSpaceId('family'), epochs } }, 'pw',
        { exportedAt: DAY, app: APP, ...FAST }),
      /EVERY epoch/
    );
  }
});

test('a malformed key ring is refused loudly rather than sealed as junk', async () => {
  const m = await makeMember();
  const FAM = mkSpaceId('family');
  const PERS = mkSpaceId('personal');
  const bad = [
    [{ family: { epochs: { 1: new Uint8Array(32) } } }, /must be a fsp_ SpaceId/],
    [{ family: { id: 'fsp_x', epochs: { 1: new Uint8Array(32) } } }, /must be a fsp_ SpaceId/],
    // §3 barrier 2 in miniature: the two spaces may not be filed under each other's ids.
    [{ family: { id: FAM, epochs: { 1: new Uint8Array(32) } }, personal: { id: FAM, epochs: { 1: new Uint8Array(32) } } }, /must be a psp_ SpaceId/],
    [{ family: { id: PERS, epochs: { 1: new Uint8Array(32) } } }, /must be a fsp_ SpaceId/],
    [{ family: { id: FAM, epochs: { 0: new Uint8Array(32) } } }, /non-positive epoch/],
    [{ family: { id: FAM, epochs: { '-1': new Uint8Array(32) } } }, /non-positive epoch/],
    [{ family: { id: FAM, epochs: { 1: new Uint8Array(16) } } }, /16 bytes/],
    [{ family: { id: FAM, epochs: { 1: 'nicht ein schlüssel' } } }, /neither a CryptoKey nor 32 bytes/],
    [{ family: { id: FAM, epoch: 0, epochs: { 1: new Uint8Array(32) } } }, /positive integer/],
    [{ family: 'x' }, /must be an object or null/],
  ];
  for (const [spaces, re] of bad) {
    await assert.rejects(
      () => exportBackup(makeBoard(m.memberId), m.identity, spaces, 'pw', { exportedAt: DAY, app: APP, ...FAST }),
      re
    );
  }
});

test('a NON-extractable space key cannot be backed up, and the engine says so rather than we do', async () => {
  // Characterizing the dependency §3 already created: `wrapSpaceKey` calls `wrapKey('raw', …)`,
  // which both engines refuse over a non-extractable key. So a key ring that could not be backed
  // up could not be re-wrapped to a new device either — the requirement is §3's, not this file's.
  const m = await makeMember();
  const sealedIn = await aesKey(false);
  assert.equal(sealedIn.extractable, false);
  await assert.rejects(() => S.exportKey('raw', sealedIn));
  await assert.rejects(
    () => exportBackup(makeBoard(m.memberId), m.identity, { family: { id: mkSpaceId('family'), epochs: { 1: sealedIn } } }, 'pw',
      { exportedAt: DAY, app: APP, ...FAST })
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. The copy — LZP-1003 audits STRINGS, not only code
// ═════════════════════════════════════════════════════════════════════════════

test('the export sheet has exactly two buttons, and neither is silent about what it costs', async () => {
  const { withPassword, boardOnly } = EXPORT_SHEET_COPY;
  assert.equal(withPassword.label.de, 'Backup mit Passwort sichern');
  assert.equal(boardOnly.label.de, 'Nur Einträge sichern');
  assert.equal(withPassword.code, 'with-identity');
  assert.equal(boardOnly.code, 'board-only');

  for (const b of [withPassword, boardOnly]) {
    for (const part of ['label', 'gain', 'lose']) {
      assert.equal(typeof b[part].de, 'string');
      assert.ok(b[part].de.length > 0, `${b.code}.${part}.de is empty`);
      assert.ok(b[part].en.length > 0, `${b.code}.${part}.en is empty`);
    }
  }
  // one line each on what you GET and what you LOSE — and the two must differ
  assert.notEqual(withPassword.gain.de, boardOnly.gain.de);
  assert.notEqual(withPassword.lose.de, boardOnly.lose.de);
  assert.ok(withPassword.gain.de.includes('Familienkreis'));
  assert.ok(boardOnly.lose.de.includes('Familienkreis'));
});

test('the sheet says the passphrase cannot be reset, and that it is not an account password', () => {
  assert.ok(EXPORT_SHEET_COPY.withPassword.lose.de.includes('zurücksetzen'));
  assert.ok(EXPORT_SHEET_COPY.withPassword.lose.en.toLowerCase().includes('reset'));
  assert.ok(LIMITS.passphraseLoss.de.includes('keine Wiederherstellung'));
  assert.ok(LIMITS.passphraseLoss.en.includes('no password recovery'));
  // addendum §3 — "no passwords" forbids an ACCOUNT, not a key file, and the sheet must say so
  assert.ok(EXPORT_SHEET_COPY.notAnAccount.de.includes('kein Konto-Passwort'));
  assert.ok(EXPORT_SHEET_COPY.notAnAccount.de.includes('Server'));
  // §8.11 — BOTH halves of the single point of failure, said out loud at export time
  assert.ok(EXPORT_SHEET_COPY.singlePointOfFailure.de.includes('Passwort verloren'));
  assert.ok(EXPORT_SHEET_COPY.singlePointOfFailure.de.includes('Mac verloren'));
});

test('§7.4: no string this module ships makes a claim the crypto cannot keep', () => {
  const forbidden = ['gelöscht bei allen', 'zurückgezogen', 'niemand kann es mehr sehen', 'live'];
  const strings = [];
  const walk = (v) => {
    if (typeof v === 'string') strings.push(v);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk({ README, EXPORT_SHEET_COPY, IMPORT_CONSEQUENCE, LIMITS });
  assert.ok(strings.length > 25, `only ${strings.length} strings found — the walker stopped working`);
  for (const s of strings) {
    for (const phrase of forbidden) {
      assert.equal(s.toLowerCase().includes(phrase), false, `"${phrase}" appears in: ${s}`);
    }
  }
});

test('every user-facing string this module ships exists in BOTH languages and is non-empty', () => {
  const pairs = [];
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (typeof v.de === 'string' || typeof v.en === 'string') pairs.push(v);
    for (const x of Object.values(v)) walk(x);
  };
  walk({ README, EXPORT_SHEET_COPY, IMPORT_CONSEQUENCE, LIMITS });
  assert.ok(pairs.length >= 12, `only ${pairs.length} de/en pairs found`);
  for (const p of pairs) {
    assert.equal(typeof p.de, 'string', `missing German in ${JSON.stringify(p)}`);
    assert.equal(typeof p.en, 'string', `missing English in ${JSON.stringify(p)}`);
    assert.ok(p.de.trim().length > 0);
    assert.ok(p.en.trim().length > 0);
    assert.notEqual(p.de, p.en, `the two languages are identical: ${p.de}`);
  }
});

test('the format identifier and version are the ones ADR 002 §7.2 fixes', async () => {
  const m = await makeMember();
  const file = await exportWith(m, 'pw');
  assert.equal(BACKUP_FORMAT, 'langzeitplaner-backup');
  assert.equal(BACKUP_V, 2);
  assert.equal(file.format, BACKUP_FORMAT);
  assert.equal(file.v, BACKUP_V);
  assert.equal(file.exportedAt, DAY);
  assert.equal(file.app, APP);
  // key order matters to nobody but a human reading the file, and a human reads the README first
  assert.deepEqual(Object.keys(file),
    ['_README_de', '_README_en', 'format', 'v', 'exportedAt', 'app', 'board', 'identity']);
});

test('a mis-shaped MemberId is refused at the SOURCE, so the bad file is never written', async () => {
  // The other half of the fix above: refusing to WRITE a file whose memberId no verifier will
  // accept is better than refusing to read one, because by the time it is read the Mac that could
  // have made a good one may be gone.
  const m = await makeMember();
  for (const bad of ['mem_ZUKURZ', 'jemand', mkDeviceId(), 'mem_' + 'A'.repeat(23)]) {
    await assert.rejects(
      () => exportBackup(makeBoard(m.memberId), { ...m.identity, memberId: bad }, m.spaces, 'pw',
        { exportedAt: DAY, app: APP, ...FAST }),
      /is not a MemberId/,
      `${bad} was accepted`
    );
  }
  // …and the same on the board-only path, where there is no crypto to hide behind.
  await assert.rejects(
    () => exportBackup(makeBoard(m.memberId), { ...m.identity, memberId: 'jemand' }, null, null,
      { exportedAt: DAY, app: APP }),
    /is not a MemberId/
  );
});

test('a swapped space id is refused on the way IN as well as on the way out', async () => {
  // §3 barrier 2: `personalRecipients` and `familyRecipients` have non-overlapping scopes. A
  // sealed key ring that filed `PSK` under an `fsp_` id would hand the personal key to the one
  // resolver that is supposed to be structurally incapable of seeing it.
  const m = await makeMember();
  const file = roundTripped(await exportWith(m, 'pw'));
  const salt = ub64(file.identity.kdf.salt);
  const sealed = ub64(file.identity.sealed);
  const key = await deriveBackupKey('pw', salt, file.identity.kdf.iterations);
  const aad = utf8(JSON.stringify({
    _README_de: file._README_de, _README_en: file._README_en, app: file.app,
    board: { digest: await katBoardDigest(file.board), hash: 'SHA-256' },   // S3
    exportedAt: file.exportedAt, format: file.format,
    kdf: { hash: 'SHA-256', iterations: file.identity.kdf.iterations, name: 'PBKDF2', salt: file.identity.kdf.salt },
    memberId: file.identity.memberId, v: file.v,
  }));
  const gcm = { name: 'AES-GCM', iv: sealed.slice(0, SEALED_IV_BYTES), additionalData: aad, tagLength: 128 };
  const payload = JSON.parse(new TextDecoder().decode(
    new Uint8Array(await S.decrypt(gcm, key, sealed.slice(SEALED_IV_BYTES)))
  ));

  assert.equal(payload.personal.id, m.spaces.personal.id, 'the re-derived AAD did not open the file');
  assert.equal(payload.family.id, m.spaces.family.id);

  // Re-seal the SAME payload with the two space ids swapped — a well-formed, correctly-signed
  // file whose only fault is that the two spaces changed places.
  payload.personal.id = m.spaces.family.id;
  const reseal = await S.encrypt(gcm, key, utf8(JSON.stringify({
    family: payload.family, personal: payload.personal,
    recKexPkcs8: payload.recKexPkcs8, recSigPkcs8: payload.recSigPkcs8,
  })));
  const swapped = { ...file, identity: { ...file.identity, sealed: b64u(new Uint8Array([...gcm.iv, ...new Uint8Array(reseal)])) } };

  const ks = memKeyStore();
  await refuses('sealed-damaged', ks,
    () => importBackup(swapped, 'pw', ks, { deviceId: mkDeviceId(), createdAt: DAY, ...FAST }));
});

test('exportBackup refuses to guess the day, the app version or the member', async () => {
  const m = await makeMember();
  const board = makeBoard(m.memberId);
  await assert.rejects(() => exportBackup(board, m.identity, m.spaces, null, { app: APP }), /exportedAt/);
  await assert.rejects(() => exportBackup(board, m.identity, m.spaces, null, { exportedAt: 'heute', app: APP }), /exportedAt/);
  await assert.rejects(() => exportBackup(board, m.identity, m.spaces, null, { exportedAt: DAY }), /app/);
  await assert.rejects(() => exportBackup(board, {}, m.spaces, null, { exportedAt: DAY, app: APP }), /memberId/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 12. S7 — the passphrase floor, and S8 — the ring that does not cover 1..e
// ═════════════════════════════════════════════════════════════════════════════

test('S7 — `passphraseStrength` has an opinion about every passphrase in C2d, and the two controls pass', () => {
  // The row that used to say „**SUCCEEDED** — there is no floor" (M-B2) is inverted in
  // `tests/attack/crypto-member-backup.test.js`; this is the same domain measured positively.
  // Written as the ENUMERATION, not as five `assert`s, so a floor that is changed later is
  // changed against a list of inputs rather than against a list of branches.
  const rows = [
    ['', 'empty', ['empty']],
    ['   ', 'empty', ['empty']],
    ['1', 'weak', ['too-short', 'too-few-distinct', 'digits-only']],
    ['a', 'weak', ['too-short', 'too-few-distinct']],
    ['1234', 'weak', ['too-short', 'too-few-distinct', 'digits-only']],
    ['passwort', 'weak', ['too-short']],
    ['        x', 'weak', ['too-short', 'too-few-distinct']],
    ['aaaaaaaaaaaaaaaa', 'weak', ['too-few-distinct', 'one-character-repeated']],
    ['Kirschbaum-Sonntag-Regenschirm-41', 'ok', []],
    ['Schlüsselbund-2026', 'ok', []],
  ];
  for (const [pw, code, reasons] of rows) {
    const s = passphraseStrength(pw);
    assert.equal(s.code, code, `${JSON.stringify(pw)} → ${s.code} (${s.reasons.join(', ')})`);
    assert.equal(s.weak, code !== 'ok', JSON.stringify(pw));
    assert.deepEqual([...s.reasons], reasons, JSON.stringify(pw));
    assert.equal(s.say === null, code === 'ok');
    if (s.say) { assert.ok(s.say.de.length > 0 && s.say.en.length > 0); }
  }
  // Not a string is not a passphrase, and must not throw on the way to saying so.
  for (const junk of [null, undefined, 42, {}, []]) assert.equal(passphraseStrength(junk).code, 'empty');
  // Code POINTS, not UTF-16 units: an emoji is one character to the user.
  assert.equal(passphraseStrength('👩‍👩‍👧‍👦').chars < 12, true);
  assert.equal(passphraseStrength('Kirschbaum-Sonntag-Regenschirm-41').chars, 33);
  // NFD and NFC are the same passphrase — the same normalisation `passphraseBytes` applies.
  assert.deepEqual(passphraseStrength('Schlüsselbund-2026'), passphraseStrength('Schlüsselbund-2026'));
});

test('S7 — the floor is SOFT, it is named, and making it hard is one line', async () => {
  // THE DECISION, PINNED. A hard refusal on this artefact pushes the user onto „Nur Einträge
  // sichern" — trading a weak passphrase for NO recovery artefact at all — which is strictly
  // worse. So a weak passphrase EXPORTS, and the weakness is surfaced instead. If the PO rules
  // the other way, `PASSPHRASE_FLOOR.hard` and the C2d rows in `tests/helpers/crypto-domains.js`
  // are the two places it lands, and this row is the one that goes red.
  assert.equal(PASSPHRASE_FLOOR.hard, false);
  assert.equal(PASSPHRASE_FLOOR.minChars, 12);
  assert.equal(PASSPHRASE_FLOOR.minDistinct, 5);
  assert.ok(BACKUP_ERROR_CODES.includes('passphrase-too-weak'), 'the hard-floor code must exist unused');

  const m = await makeMember();
  for (const weak of ['1', 'a', '1234', 'passwort', '        x']) {
    const seen = [];
    const f = await exportBackup(makeBoard(m.memberId), m.identity, m.spaces, weak,
      { exportedAt: DAY, app: APP, ...FAST, onWeakPassphrase: (s) => seen.push(s) });
    assert.equal(inspectBackup(f).hasIdentity, true, `${JSON.stringify(weak)} was refused`);
    // …and the caller was TOLD, once, with the reasons. This is what makes „the sheet forgot to
    // ask" a testable condition rather than a review comment.
    assert.equal(seen.length, 1, `${JSON.stringify(weak)} exported in silence`);
    assert.equal(seen[0].weak, true);
    assert.ok(seen[0].reasons.length > 0);
  }
  // A real passphrase does not fire the port at all.
  const quiet = [];
  await exportBackup(makeBoard(m.memberId), m.identity, m.spaces, 'Kirschbaum-Sonntag-Regenschirm-41',
    { exportedAt: DAY, app: APP, ...FAST, onWeakPassphrase: (s) => quiet.push(s) });
  assert.deepEqual(quiet, []);
  // An EMPTY one is still a refusal — that is the one rule that was already there and stays.
  await assert.rejects(
    () => exportBackup(makeBoard(m.memberId), m.identity, m.spaces, '   ', { exportedAt: DAY, app: APP, ...FAST }),
    (e) => e.code === 'passphrase-empty'
  );
});

test('S7 — the copy the floor is explained with exists in both languages, before anything is typed', () => {
  const p = EXPORT_SHEET_COPY.passphrase;
  for (const part of ['hint', 'weak', 'weakAnyway']) {
    assert.ok(p[part].de.length > 0, `${part}.de`);
    assert.ok(p[part].en.length > 0, `${part}.en`);
    assert.notEqual(p[part].de, p[part].en);
  }
  // Not a wall: the confirm button offers the weak passphrase anyway, and says so.
  assert.ok(p.weakAnyway.de.includes('Trotzdem'));
  // Concrete rather than a rule — „mindestens 12 Zeichen" with a red border produces a sticky note.
  assert.ok(p.hint.de.includes('drei Wörter'));
  assert.ok(LIMITS.passphraseFloor.de.includes('600 000'));
  assert.ok(LIMITS.passphraseFloor.en.includes('600 000'));
});

test('S8 — a ring that does not cover 1..e imports, and SAYS which epochs are missing', async () => {
  // The wrapping side refuses a partial ring loudly; the restoring side accepted one in silence,
  // so a restored Mac could not read epochs 1-3 and reported nothing. Reported, not refused: a
  // restore that recovers everything from epoch 4 onward is worth having on a Mac whose owner may
  // have nothing else left, and §7.3 step 6 already says what happens to the rest („Schlüssel
  // ausstehend", parked, not lost).
  const key = async () => aesKey(true);
  const ringOf = async (ns) => {
    const map = new Map();
    for (const n of ns) map.set(n, await key());
    return map;
  };
  const rows = [
    { epochs: [1, 2, 3, 4], epoch: 4, missing: undefined, code: 'identity-restored' },
    { epochs: [4], epoch: 4, missing: [1, 2, 3], code: 'identity-restored-keys-pending' },
    { epochs: [1, 3], epoch: 3, missing: [2], code: 'identity-restored-keys-pending' },
    { epochs: [2, 3], epoch: 3, missing: [1], code: 'identity-restored-keys-pending' },
    { epochs: [1], epoch: 1, missing: undefined, code: 'identity-restored' },
    // NO `epoch` field: the ring is complete for everything it CLAIMS to cover. Inventing a
    // higher `e` here would report a gap only the server can know about (§4.4 parks that).
    { epochs: [1, 2], epoch: undefined, missing: undefined, code: 'identity-restored' },
    { epochs: [2], epoch: undefined, missing: [1], code: 'identity-restored-keys-pending' },
    // …and an `epoch` AHEAD of the ring is a gap at the top, which is the shape §7.3 step 6 is
    // literally about: the family rotated while this Mac was gone.
    { epochs: [1, 2], epoch: 4, missing: [3, 4], code: 'identity-restored-keys-pending' },
  ];
  for (const row of rows) {
    const m = await makeMember();
    const family = { id: mkSpaceId('family'), epochs: await ringOf(row.epochs) };
    if (row.epoch !== undefined) family.epoch = row.epoch;
    const file = roundTripped(await exportBackup(makeBoard(m.memberId), m.identity,
      { personal: { id: mkSpaceId('personal'), epochs: await ringOf([1]) }, family },
      'pw', { exportedAt: DAY, app: APP, ...FAST }));
    const r = await importBackup(file, 'pw', memKeyStore(), { deviceId: mkDeviceId(), createdAt: DAY, ...FAST });

    assert.equal(r.identityRestored, true, JSON.stringify(row));
    const got = r.spaces.family.missingEpochs;
    if (row.missing === undefined) {
      assert.equal('missingEpochs' in r.spaces.family, false,
        `${JSON.stringify(row)} reported a gap it does not have`);
    } else {
      assert.deepEqual([...got], row.missing, JSON.stringify(row));
    }
    assert.equal(r.consequence.code, row.code, JSON.stringify(row));
    // The keys that ARE there are usable — reporting a gap must not cost the rest.
    assert.deepEqual([...r.spaces.family.epochs.keys()].sort((a, b) => a - b), [...row.epochs]);
  }

  // The PERSONAL bundle is measured by the same rule, and it is the same field.
  const m = await makeMember();
  const file = roundTripped(await exportBackup(makeBoard(m.memberId), m.identity,
    { personal: { id: mkSpaceId('personal'), epoch: 3, epochs: await ringOf([3]) } },
    'pw', { exportedAt: DAY, app: APP, ...FAST }));
  const r = await importBackup(file, 'pw', memKeyStore(), { deviceId: mkDeviceId(), createdAt: DAY, ...FAST });
  assert.deepEqual([...r.spaces.personal.missingEpochs], [1, 2]);
  assert.equal(r.spaces.family, null);
  assert.equal(r.consequence.code, 'identity-restored-keys-pending');
});

test('M-B6 — the Kreis binding is REPORTED as unverified on every family restore, and named', async () => {
  // What this module cannot check, said rather than omitted. `family.id` is a payload field and
  // the authority that could contradict it — §7.3 step 5's `POST /devices/adopt` — is not here.
  // Deliberately UNCONDITIONAL: a file naming somebody else's Kreis is indistinguishable at this
  // seam from one naming your own (`C2c-1` and `C2c-2` are literally the same input), so a
  // warning that appeared only on the bad one would be a claim this module cannot make.
  const m = await makeMember();
  const FSP = mkSpaceId('family');
  const file = roundTripped(await exportBackup(makeBoard(m.memberId), m.identity,
    { personal: { id: mkSpaceId('personal'), epochs: new Map([[1, await aesKey(true)]]) },
      family: { id: FSP, epoch: 1, epochs: new Map([[1, await aesKey(true)]]) } },
    'pw', { exportedAt: DAY, app: APP, ...FAST }));
  const r = await importBackup(file, 'pw', memKeyStore(), { deviceId: mkDeviceId(), createdAt: DAY, ...FAST });
  assert.equal(r.familyBinding.spaceId, FSP);
  assert.equal(r.familyBinding.verified, false);
  assert.ok(r.familyBinding.say.de.includes('nicht nachprüfen'));
  assert.ok(r.familyBinding.say.en.includes('cannot'));

  // No family bundle ⇒ nothing to say. `null`, not a warning about a Kreis that is not there.
  const solo = roundTripped(await exportBackup(makeBoard(m.memberId), m.identity,
    { personal: { id: mkSpaceId('personal'), epochs: new Map([[1, await aesKey(true)]]) } },
    'pw', { exportedAt: DAY, app: APP, ...FAST }));
  const s = await importBackup(solo, 'pw', memKeyStore(), { deviceId: mkDeviceId(), createdAt: DAY, ...FAST });
  assert.equal(s.familyBinding, null);
  // …and the board-only path has the field too, so a caller's `result.familyBinding` is never
  // `undefined` on one branch and an object on the other.
  const boardOnly = roundTripped(await exportBackup(makeBoard(m.memberId), m.identity, m.spaces, null,
    { exportedAt: DAY, app: APP }));
  assert.equal((await importBackup(boardOnly, null, memKeyStore(), {})).familyBinding, null);
});
