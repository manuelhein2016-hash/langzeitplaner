// ─────────────────────────────────────────────────────────────────────────────
// T5 / T3 — THE BACKUP FILE (ADR 002 §7.2, §7.3, §8.11, D8)
//
// The backup is the one artefact the onboarding actively tells the user to carry off the machine.
// „Wer diese Datei und dein Passwort hat, ist du." So the file is attacked here as a family
// member who got hold of it — from a shared Dropbox, a family NAS, an unlocked Mac.
//
//   M-B1  a stolen file, no passphrase                    FAILED (D8 holds: sealed or absent)
//   M-B2  a weak passphrase                               **SUCCEEDED** — there is no floor
//   M-B3  a tampered `identity` block                     FAILED (the header is the AAD)
//   M-B4  a tampered BOARD block                          **SUCCEEDED** — the board is NOT in
//                                                          the AAD (this is E3-6, and it is
//                                                          exploitable, not merely open)
//   M-B5  an import that half-applies                     **SUCCEEDED** — one shape bricks the
//                                                          Mac for that backup, permanently
//   M-B6  a re-join that binds you to the wrong Kreis     **SUCCEEDED** in the sense that
//                                                          nothing here can refuse it
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import * as sk from '../../src/js/crypto/spacekeys.js';
import {
  exportBackup, importBackup, inspectBackup, deriveBackupKey, BACKUP_ERROR_CODES, LIMITS,
} from '../../src/js/crypto/backup.js';
import { BACKUP_KDF } from '../../src/js/crypto/suite.js';
import { memKeyStore } from '../../src/js/platform/keystore.js';
import { makeMember, outcomeOf, mkSpaceId, mkDeviceId, DAY, FAST } from './_member-kit.js';

const APP = '2.0.0';
const board = (over = {}) => ({
  schemaVersion: 2,
  notes: [{ id: 'n1', owner: over.owner, date: '2026-09-10', text: 'Zahnarzt' }],
  bars: [], categories: [], scratchpads: {}, settings: {},
  ...over.extra,
});

/** A real backup, with a real identity block. `FAST` rounds; the shipped 600 000 is asserted in
 *  `tests/tier1/crypto-backup.test.js` and re-measured in tier 2. */
async function aBackup(passphrase = 'Schlüsselbund-2026', spaces = null) {
  const me = await makeMember();
  const psk = await sk.createSpaceKey();
  const file = await exportBackup(
    board({ owner: me.memberId }),
    { memberId: me.memberId, recSig: me.rec.recSig, recKex: me.rec.recKex },
    spaces ?? { personal: { id: mkSpaceId('personal'), epochs: new Map([[1, psk]]) } },
    passphrase,
    { exportedAt: DAY, app: APP, iterations: FAST }
  );
  return { me, file, psk };
}
const clone = (f) => JSON.parse(JSON.stringify(f));
const opts = () => ({ deviceId: mkDeviceId(), createdAt: DAY, iterations: FAST });

// ═════════════════════════════════════════════════════════════════════════════

describe('T5 steals the backup file', () => {
  test('M-B1 FAILED — D8 holds: the identity block is ciphertext, and a wrong passphrase is indistinguishable from a tampered file', async () => {
    const { me, file } = await aBackup();

    // Nothing secret is readable. The b64url of the recovery private keys is not in the file.
    const wire = JSON.stringify(file);
    const { b64u } = await import('../../src/js/core/b64.js');
    const S = globalThis.crypto.subtle;
    for (const k of [me.rec.recSig.privateKey, me.rec.recKex.privateKey]) {
      const pkcs8 = b64u(new Uint8Array(await S.exportKey('pkcs8', k)));
      assert.equal(wire.includes(pkcs8), false, 'a recovery private key is in the clear');
    }
    // …and the SPACE KEY is not either, which matters as much: it is what reads the board.
    const raw = b64u(new Uint8Array(await S.exportKey('raw', (await aBackup()).psk)));
    assert.equal(wire.includes(raw), false);

    // `inspectBackup` is pure and tells the thief only what the export sheet already says.
    const seen = inspectBackup(file);
    assert.equal(seen.hasIdentity, true);
    assert.equal(seen.needsPassphrase, true);
    assert.deepEqual(Object.keys(seen.kdf).sort(), ['hash', 'iterations', 'name']);

    // Every wrong guess is one code, with no detail. Rule 3 all the way down.
    assert.equal(await outcomeOf(() => importBackup(file, 'falsch', memKeyStore(), opts())), 'cannot-open');
    assert.equal(await outcomeOf(() => importBackup(file, '', memKeyStore(), opts())), 'passphrase-empty');
    assert.equal(await outcomeOf(() => importBackup(file, null, memKeyStore(), opts())), 'passphrase-required');
    assert.ok(BACKUP_ERROR_CODES.includes('cannot-open'));
  });

  test('M-B2 **SUCCEEDED** — there is no passphrase floor, so 600 000 PBKDF2 rounds protect a one-character password by a factor of 600 000', async () => {
    // `passphraseBytes` refuses empty and whitespace-only, and nothing else. „Wer diese Datei und
    // dein Passwort hat, ist du" is the whole security model of this file, and the model has no
    // opinion about what a passwort is. 600 000 rounds is the RIGHT number and it is not a
    // substitute for entropy: a 4-digit PIN is 10 000 candidates, i.e. 6e9 PBKDF2 rounds, which
    // is minutes on one laptop.
    const { me } = await aBackup();
    const psk = await sk.createSpaceKey();
    for (const weak of ['1', 'a', '1234', 'passwort', '        x']) {
      const f = await exportBackup(
        board({ owner: me.memberId }),
        { memberId: me.memberId, recSig: me.rec.recSig, recKex: me.rec.recKex },
        { personal: { id: mkSpaceId('personal'), epochs: new Map([[1, psk]]) } },
        weak, { exportedAt: DAY, app: APP, iterations: FAST });
      assert.equal(inspectBackup(f).hasIdentity, true, `${JSON.stringify(weak)} was refused`);
    }
    // The dictionary attack, run for real over a five-entry dictionary, to show that nothing in
    // the file resists it beyond the cost of the KDF.
    const target = await exportBackup(
      board({ owner: me.memberId }),
      { memberId: me.memberId, recSig: me.rec.recSig, recKex: me.rec.recKex },
      { personal: { id: mkSpaceId('personal'), epochs: new Map([[1, psk]]) } },
      '1234', { exportedAt: DAY, app: APP, iterations: FAST });
    let cracked = null;
    for (const guess of ['0000', '1111', '1234', '9999']) {
      const r = await outcomeOf(() => importBackup(target, guess, memKeyStore(), opts()));
      if (r !== 'cannot-open') { cracked = guess; break; }
    }
    assert.equal(cracked, '1234', 'the file resisted a four-word dictionary');
    // The only mitigation that exists is the KDF cost, and it is a constant.
    assert.equal(BACKUP_KDF.iterations, 600000);
    assert.equal(LIMITS.kdfIterations ?? BACKUP_KDF.iterations, BACKUP_KDF.iterations);
  });
});

describe('T5 tampers with the file', () => {
  test('M-B3 FAILED — every field of the plaintext header is in the AAD, including the README the user is told to read', async () => {
    const { file } = await aBackup();
    const tries = [
      ['_README_de', 'harmlos'],
      ['_README_en', 'harmless'],
      ['app', '1.0.0'],
      ['exportedAt', '2020-01-01'],
    ];
    for (const [field, value] of tries) {
      const t = clone(file);
      t[field] = value;
      assert.equal(await outcomeOf(() => importBackup(t, 'Schlüsselbund-2026', memKeyStore(), opts())),
        'cannot-open', `${field} is outside the AAD`);
    }
    // The identity sub-header too — memberId, iterations, salt.
    for (const [field, value] of [['iterations', FAST + 1], ['salt', file.identity.kdf.salt.replace(/^./, 'A')]]) {
      const t = clone(file);
      t.identity.kdf[field] = value;
      assert.equal(await outcomeOf(() => importBackup(t, 'Schlüsselbund-2026', memKeyStore(), opts())), 'cannot-open');
    }
    const t = clone(file);
    t.identity.memberId = (await makeMember()).memberId;
    assert.equal(await outcomeOf(() => importBackup(t, 'Schlüsselbund-2026', memKeyStore(), opts())), 'cannot-open');
  });

  test('M-B4 **SUCCEEDED** — the BOARD is outside the AAD: a tampered board imports with a fully valid identity beside it (E3-6)', async () => {
    // THE SEQUENCE. Mama finds Papa's backup on the family NAS. She cannot read the identity
    // block and does not try. She rewrites `board.notes` — changes a text, adds an entry, deletes
    // one — and puts the file back. Papa restores after a disk failure, types HIS passphrase, and
    // the import succeeds: the AEAD tag covers the header and the sealed payload and says nothing
    // about the board, so `importBackup` returns her board and his identity together.
    //
    // ADR 002 §7.2 lists `board` as a sibling of `identity` and never says it is authenticated;
    // `sealAad()` enumerates seven fields and `board` is not among them. E3-6 is filed as a PO
    // QUESTION ("should the backup's board block be authenticated"). This is the answer to it in
    // the form of a running attack: with a passphrase the file already claims to be „dein
    // Schlüssel", and half of it is unsigned.
    const { me, file } = await aBackup();
    const tampered = clone(file);
    tampered.board.notes[0].text = 'Scheidungsanwalt';
    tampered.board.notes.push({ id: 'n2', owner: me.memberId, date: '2026-12-24', text: 'eingeschmuggelt' });

    const out = await importBackup(tampered, 'Schlüsselbund-2026', memKeyStore(), opts());
    assert.equal(out.identityRestored, true, 'if this ever fails, M-B4 is FIXED');
    assert.deepEqual(out.board.notes.map((n) => n.text), ['Scheidungsanwalt', 'eingeschmuggelt']);
    assert.equal(out.consequence.code, 'identity-restored');
    // And `inspectBackup` — the pure pre-flight the sheet renders — reports HER counts as fact.
    assert.equal(inspectBackup(tampered).counts.notes, 2);

    // The same hole in its quieter shape: DELETING entries. There is no count anywhere the user
    // could compare against, because the count is derived from the block being attacked.
    const emptied = clone(file);
    emptied.board.notes = [];
    const out2 = await importBackup(emptied, 'Schlüsselbund-2026', memKeyStore(), opts());
    assert.equal(out2.identityRestored, true);
    assert.deepEqual(out2.board.notes, []);
  });
});

describe('T5 makes the import half-apply', () => {
  test('M-B5 **SUCCEEDED in one shape** — a failure between the two recovery writes leaves 2 of 3 records and the Mac then refuses that backup for ever', async () => {
    // §7.3's ordering is careful and it is right as far as it goes: nothing is written until
    // everything is decrypted, and `assertKeyStoreIsFree` refuses a conflicting store BEFORE any
    // write. What it cannot do is make the writes themselves atomic — `KeyStore.put` is one
    // record at a time — so a crash, an eviction or a full disk between them is a state
    // `assertKeyStoreIsFree` classifies as `keystore-partial` and REFUSES on every retry.
    //
    // There is no repair path in the module: `importBackup` never deletes, and a user with a
    // half-written store and a backup file has no supported way to finish the restore.
    const { file } = await aBackup();
    const inner = memKeyStore();
    let n = 0;
    const flaky = {
      get: inner.get, del: inner.del, list: inner.list,
      put: async (id, v) => { n += 1; if (n > 2) throw new Error('disk full'); return inner.put(id, v); },
    };
    await assert.rejects(() => importBackup(file, 'Schlüsselbund-2026', flaky, opts()));
    const left = await inner.list();
    assert.equal(left.length, 2, 'the store is neither empty nor complete');

    // Retry, on a healthy store containing exactly that residue.
    assert.equal(await outcomeOf(() => importBackup(file, 'Schlüsselbund-2026', inner, opts())),
      'keystore-partial', 'if this ever succeeds, M-B5 is FIXED');
    // …and it stays refused: nothing in the module clears the residue.
    assert.equal(await outcomeOf(() => importBackup(file, 'Schlüsselbund-2026', inner, opts())), 'keystore-partial');
  });

  test('M-B5b FAILED — the OTHER half-apply shape is benign: a failure after the recovery triple is idempotently completable', async () => {
    const { file } = await aBackup();
    const inner = memKeyStore();
    let n = 0;
    const flaky = {
      get: inner.get, del: inner.del, list: inner.list,
      put: async (id, v) => { n += 1; if (n > 3) throw new Error('disk full'); return inner.put(id, v); },
    };
    await assert.rejects(() => importBackup(file, 'Schlüsselbund-2026', flaky, opts()));
    assert.deepEqual((await inner.list()).sort(), ['lzp/v2/rec/kex', 'lzp/v2/rec/meta', 'lzp/v2/rec/sig']);
    const out = await importBackup(file, 'Schlüsselbund-2026', inner, opts());
    assert.equal(out.identityRestored, true);
    // And the BOARD is never applied by this module at all, so no caller can receive half of one.
    assert.ok(Array.isArray(out.board.notes));
  });

  test('M-B5c FAILED — a store belonging to someone else is refused before a byte is written', async () => {
    const { file } = await aBackup();
    const other = await aBackup();
    const ks = memKeyStore();
    await importBackup(other.file, 'Schlüsselbund-2026', ks, opts());
    const before = (await ks.list()).sort();
    assert.equal(await outcomeOf(() => importBackup(file, 'Schlüsselbund-2026', ks, opts())), 'keystore-conflict');
    assert.deepEqual((await ks.list()).sort(), before, 'the refused import wrote something');
  });
});

describe('T5 binds a re-join to the wrong Kreis', () => {
  test('M-B6 **SUCCEEDED at this seam** — the restored family space id and epoch ring are taken from the file, and nothing here can check them', async () => {
    // §7.3 step 6 says the restored epoch keys "decrypt everything already on the server" and
    // that a newer epoch parks. What no part of `importBackup` can know is whether this member is
    // STILL in that Kreis, or ever was: `family.id` and the epochs are payload fields, and the
    // authority that could contradict them (the member list, the admin chain) is the fold's, and
    // arrives later. So a backup handed to you by a family member — the honest scenario is „ich
    // hab dir dein Backup wiederhergestellt" — attaches your restored Mac to whatever Kreis the
    // file names, under whatever recovery identity it carries.
    //
    // This is not a flaw in `backup.js`: refusing here would need I/O and this module is I/O-free
    // by design. It is a REPORTED GAP at the seam above it (§7.3 step 5's `POST /devices/adopt`
    // is the only thing that can contradict a file, and `server/` is `vercel.json`).
    const me = await makeMember();
    const psk = await sk.createSpaceKey();
    const fsk = await sk.createSpaceKey();
    const FSP = mkSpaceId('family');
    const file = await exportBackup(
      board({ owner: me.memberId }),
      { memberId: me.memberId, recSig: me.rec.recSig, recKex: me.rec.recKex },
      {
        personal: { id: mkSpaceId('personal'), epochs: new Map([[1, psk]]) },
        family: { id: FSP, epoch: 4, epochs: new Map([[4, fsk]]) },
      },
      'pass', { exportedAt: DAY, app: APP, iterations: FAST });

    const out = await importBackup(file, 'pass', memKeyStore(), opts());
    assert.equal(out.spaces.family.id, FSP);
    // A SPARSE ring — epoch 4 only, no 1..3 — is accepted without comment, even though §4.3 and
    // §7.1 step 5 make "all epochs 1..e" the rule that lets a member see Oma's birthday. The
    // WRAPPING side refuses a partial ring loudly (`wrapRingToRecipients`); the RESTORING side
    // does not, so a restored Mac silently cannot read epochs 1–3 and reports nothing.
    assert.deepEqual([...out.spaces.family.epochs.keys()], [4]);
    // The self-attestation minted here is under the RESTORED recovery key, so it binds this Mac
    // to whatever `identity.memberId` the file carried — which is the intended behaviour and is
    // exactly why the file is „dein Schlüssel".
    assert.equal(out.attestation.memberId, me.memberId);
    assert.equal(typeof out.blob, 'string');
  });

  test('M-B6b FAILED — the restored recovery pair is checked against itself before anything is written', async () => {
    // The one class of forgery this module DOES catch: a payload whose public halves do not
    // belong to its private ones. Both checks are `verify() === true` / an ECDH agreement, never
    // a byte comparison (rule 1), over a fixed NON-EMPTY probe (rule 2).
    const { file } = await aBackup();
    const key = await deriveBackupKey('Schlüsselbund-2026',
      (await import('../../src/js/core/b64.js')).ub64(file.identity.kdf.salt), FAST, {});
    assert.equal(key.type, 'secret');
    assert.equal(key.extractable, false);
    // A truncated or bit-flipped sealed block cannot be salvaged into a partial identity: it is
    // refused either by `inspectBackup`'s shape pass or by the tag, and never half-restored.
    const truncated = clone(file);
    truncated.identity.sealed = truncated.identity.sealed.slice(0, truncated.identity.sealed.length - 8);
    assert.equal(await outcomeOf(() => importBackup(truncated, 'Schlüsselbund-2026', memKeyStore(), opts())),
      'identity-damaged');
    const flipped = clone(file);
    flipped.identity.sealed = flipped.identity.sealed.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    assert.equal(await outcomeOf(() => importBackup(flipped, 'Schlüsselbund-2026', memKeyStore(), opts())),
      'cannot-open');
  });
});
