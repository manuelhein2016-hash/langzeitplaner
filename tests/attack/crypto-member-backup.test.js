// ─────────────────────────────────────────────────────────────────────────────
// T5 / T3 — THE BACKUP FILE (ADR 002 §7.2, §7.3, §8.11, D8)
//
// The backup is the one artefact the onboarding actively tells the user to carry off the machine.
// „Wer diese Datei und dein Passwort hat, ist du." So the file is attacked here as a family
// member who got hold of it — from a shared Dropbox, a family NAS, an unlocked Mac.
//
//   M-B1  a stolen file, no passphrase                    FAILED (D8 holds: sealed or absent)
//   M-B2  a weak passphrase                               was **SUCCEEDED** — INVERTED 2026-08-28
//                                                          (S7): the floor is named, measured and
//                                                          surfaced; it is deliberately SOFT
//   M-B3  a tampered `identity` block                     FAILED (the header is the AAD)
//   M-B4  a tampered BOARD block                          was **SUCCEEDED** — INVERTED 2026-08-28
//                                                          (S3): the board digest is in the AAD
//                                                          on the identity path. E3-6 answered.
//   M-B5  an import that half-applies                     was **SUCCEEDED** — INVERTED 2026-08-28
//                                                          (S4): still refused, no longer for ever
//   M-B6  a re-join that binds you to the wrong Kreis     HALF INVERTED 2026-08-28 (S8): the
//                                                          epoch gaps are reported; the KREIS
//                                                          still cannot be checked here, and is
//                                                          now SAID rather than omitted
//
// EVERY ROW BELOW THAT SAYS "INVERTED" ASSERTS THE OPPOSITE OF WHAT IT ASSERTED, over the same
// attack, from the same starting position. None of them was deleted: a red-team row that is
// removed when it is fixed takes the proof of the fix with it.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import * as sk from '../../src/js/crypto/spacekeys.js';
import {
  exportBackup, importBackup, inspectBackup, deriveBackupKey, passphraseStrength,
  BACKUP_ERROR_CODES, LIMITS, PASSPHRASE_FLOOR, EXPORT_SHEET_COPY,
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

  test('M-B2 INVERTED — the floor exists, is named, and is surfaced on every passphrase the attack used', async () => {
    // ─────────────────────────────────────────────────────────────────────────────────────
    // WAS: "**SUCCEEDED** — there is no passphrase floor, so 600 000 PBKDF2 rounds protect a
    // one-character password by a factor of 600 000." The dictionary attack below is the SAME
    // attack, run against the SAME file, and it still cracks it — because the fix is not a
    // pretence that 600 000 rounds became more than 600 000 rounds. What changed is that the
    // module now HAS an opinion about the Passwort and hands it to the sheet before the user
    // commits, which is what „Wer diese Datei und dein Passwort hat, ist du" needed all along.
    //
    // ⚠ THE FLOOR IS SOFT ON PURPOSE, and this row is where that decision is visible: every weak
    // passphrase below still EXPORTS. A hard refusal pushes the user onto „Nur Einträge sichern"
    // — no keys at all — which is strictly worse than a bad lock on a real door. If the PO rules
    // otherwise, `PASSPHRASE_FLOOR.hard` flips and this row goes red by name.
    // ─────────────────────────────────────────────────────────────────────────────────────
    const { me } = await aBackup();
    const psk = await sk.createSpaceKey();
    for (const weak of ['1', 'a', '1234', 'passwort', '        x']) {
      const told = [];
      const f = await exportBackup(
        board({ owner: me.memberId }),
        { memberId: me.memberId, recSig: me.rec.recSig, recKex: me.rec.recKex },
        { personal: { id: mkSpaceId('personal'), epochs: new Map([[1, psk]]) } },
        weak, { exportedAt: DAY, app: APP, iterations: FAST, onWeakPassphrase: (x) => told.push(x) });
      // still accepted…
      assert.equal(inspectBackup(f).hasIdentity, true, `${JSON.stringify(weak)} was refused`);
      // …and no longer accepted IN SILENCE, which is the whole of the fix.
      assert.equal(passphraseStrength(weak).weak, true, `${JSON.stringify(weak)} passes the floor`);
      assert.equal(told.length, 1, `${JSON.stringify(weak)} exported without telling anyone`);
      assert.ok(told[0].reasons.length > 0);
      assert.ok(told[0].say.de.length > 0 && told[0].say.en.length > 0);
      // …and NOTHING about the weakness is written into the file. A „this one was weak" flag
      // would hand the thief a sorting key for the drawer.
      assert.equal(JSON.stringify(f).includes('weak'), false);
      assert.equal(JSON.stringify(f).includes('strength'), false);
    }

    // THE DICTIONARY ATTACK, UNCHANGED AND STILL SUCCESSFUL. It is kept exactly as the red team
    // ran it, because the fix does not claim to defeat it — it claims the user was warned.
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
    assert.equal(BACKUP_KDF.iterations, 600000);
    assert.equal(LIMITS.kdfIterations ?? BACKUP_KDF.iterations, BACKUP_KDF.iterations);

    // And the passphrase the honest user is nudged towards is not weak by the same measure.
    assert.equal(passphraseStrength('Kirschbaum-Sonntag-Regenschirm-41').weak, false);
    assert.equal(PASSPHRASE_FLOOR.hard, false, 'the floor became hard — M-B2 needs re-reading');
    assert.ok(EXPORT_SHEET_COPY.passphrase.hint.de.length > 0);
    assert.ok(LIMITS.passphraseFloor.de.includes('10 000'));
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

  test('M-B4 INVERTED — the BOARD is inside the AAD now: her file no longer opens at all (E3-6, answered)', async () => {
    // ─────────────────────────────────────────────────────────────────────────────────────
    // THE SEQUENCE, UNCHANGED. Mama finds Papa's backup on the family NAS. She cannot read the
    // identity block and does not try. She rewrites `board.notes` — changes a text, adds an
    // entry, deletes one — and puts the file back. Papa restores after a disk failure and types
    // HIS passphrase.
    //
    // WAS: the import succeeded, `identityRestored: true`, and her board came back as his, with
    // `inspectBackup` reporting HER counts as fact. E3-6 was filed as a PO question and this was
    // the answer to it in the form of a running attack.
    //
    // NOW: the AAD carries a SHA-256 of the whole `board` block, recomputed on both sides, so
    // her edit changes the additional data and the AES-GCM tag refuses the file. The code is
    // `cannot-open` — the same one a wrong passphrase gets — because from outside the module the
    // two are the same event: this is not the file it claims to be.
    //
    // E3-6's objection is answered rather than overruled. It said a guarantee on ONE of the two
    // export paths is worse than one stated plainly; `LIMITS.board` now states BOTH paths
    // plainly, and `README.boardOnly` already tells the user which file she is holding.
    // ─────────────────────────────────────────────────────────────────────────────────────
    const { me, file } = await aBackup();

    const attacks = [
      ['rewritten', (f) => { f.board.notes[0].text = 'Scheidungsanwalt'; }],
      ['added', (f) => { f.board.notes.push({ id: 'n2', owner: me.memberId, date: '2026-12-24', text: 'eingeschmuggelt' }); }],
      // The quieter shape, and the one the red team called worse: DELETING leaves no count
      // anywhere to compare against, because the count is derived from the block being attacked.
      ['emptied', (f) => { f.board.notes = []; }],
      ['category', (f) => { f.board.categories.push({ id: 'x', name: 'X' }); }],
      ['settings', (f) => { f.board.settings = { bundesland: 'HH' }; }],
      ['scratchpad', (f) => { f.board.scratchpads = { '2026-09': 'anders' }; }],
      ['lineage', (f) => { f.board._v2 = { lineageId: 'lin_AAAAAAAAAAAAAAAAAAAAAAAAAA', gen: 1 }; }],
    ];
    for (const [what, tamper] of attacks) {
      const t = clone(file);
      tamper(t);
      const ks = memKeyStore();
      assert.equal(await outcomeOf(() => importBackup(t, 'Schlüsselbund-2026', ks, opts())),
        'cannot-open', `${what}: if this ever succeeds, M-B4 is OPEN AGAIN`);
      assert.deepEqual(await ks.list(), [], `${what} wrote to the key store`);
    }

    // The one thing that is NOT tampering: the same board through a different JSON writer. The
    // digest sorts keys, so re-serialising the file does not brick it — without this the fix
    // would be a landmine under every caller that ever re-writes the file.
    const reordered = clone(file);
    const bd = reordered.board;
    reordered.board = { settings: bd.settings, notes: bd.notes, bars: bd.bars,
      categories: bd.categories, scratchpads: bd.scratchpads, schemaVersion: bd.schemaVersion };
    const ok = await importBackup(reordered, 'Schlüsselbund-2026', memKeyStore(), opts());
    assert.equal(ok.identityRestored, true);
    assert.equal(ok.board.notes[0].text, 'Zahnarzt');

    // `inspectBackup` is still PURE and still pre-passphrase, so it still renders what the FILE
    // says — it cannot hash without SubtleCrypto and it is called before the user has typed
    // anything. That is not the hole any more: the sheet may show her counts, and then the import
    // refuses and applies nothing. Asserted so nobody "fixes" it into an async function.
    const emptied = clone(file);
    emptied.board.notes = [];
    assert.equal(inspectBackup(emptied).counts.notes, 0);
    assert.equal(await outcomeOf(() => importBackup(emptied, 'Schlüsselbund-2026', memKeyStore(), opts())),
      'cannot-open');

    // The board-only file is UNCHANGED and still unauthenticated — the honest half of the limit,
    // on the path it is true of.
    const plain = await exportBackup(
      board({ owner: me.memberId }),
      { memberId: me.memberId, recSig: me.rec.recSig, recKex: me.rec.recKex },
      null, null, { exportedAt: DAY, app: APP });
    const p = clone(plain);
    p.board.notes[0].text = 'von Mama';
    const out = await importBackup(p, null, memKeyStore(), opts());
    assert.equal(out.board.notes[0].text, 'von Mama');
    assert.equal(out.identityRestored, false);
    assert.ok(LIMITS.board.boardOnly.de.includes('nicht signiert'));
    assert.ok(LIMITS.board.withIdentity.de.includes('versiegelt'));
  });
});

describe('T5 makes the import half-apply', () => {
  test('M-B5 INVERTED — the half-written store is still refused, and no longer refused FOR EVER', async () => {
    // ─────────────────────────────────────────────────────────────────────────────────────
    // WAS: "**SUCCEEDED in one shape** — a failure between the two recovery writes leaves 2 of 3
    // records and the Mac then refuses that backup for ever." §7.3's ordering was right as far as
    // it went — nothing written until everything is decrypted, a conflicting store refused before
    // any write — but `KeyStore.put` is one record at a time, so a crash between them left a
    // state `assertKeyStoreIsFree` classified as `keystore-partial` and REFUSED on every retry.
    // The Mac was intact, the file was intact, and the restore was impossible.
    //
    // NOW: the refusal STAYS — nothing is written over anything in the same breath as discovering
    // it, and the user is told — and the dead residue is cleared on the way out, so the retry
    // meets an empty store. The delete is narrow and argued in `prepareKeyStore`: the residue is
    // partial (every reader in `identity.js` refuses it by construction, so no code path in this
    // product can ever turn it back into an identity) AND no readable metadata names another
    // member. M-B5c below is the row that proves the second half.
    // ─────────────────────────────────────────────────────────────────────────────────────
    const { file } = await aBackup();
    const inner = memKeyStore();
    let n = 0;
    const flaky = {
      get: inner.get, del: inner.del, list: inner.list,
      put: async (id, v) => { n += 1; if (n > 2) throw new Error('disk full'); return inner.put(id, v); },
    };
    await assert.rejects(() => importBackup(file, 'Schlüsselbund-2026', flaky, opts()));
    assert.equal((await inner.list()).length, 2, 'the store is neither empty nor complete');

    // The attempt that meets the residue is still REFUSED, loudly, with the code that names what
    // happened…
    assert.equal(await outcomeOf(() => importBackup(file, 'Schlüsselbund-2026', inner, opts())),
      'keystore-partial');
    // …and the residue is gone, so the retry is a first-ever restore.
    assert.deepEqual(await inner.list(), [], 'the residue survived — M-B5 is OPEN AGAIN');
    const out = await importBackup(file, 'Schlüsselbund-2026', inner, opts());
    assert.equal(out.identityRestored, true, 'if this ever fails, M-B5 is OPEN AGAIN');
    assert.equal((await inner.list()).length, 6);

    // A THIRD import is the idempotent one — the shape users actually produce by clicking twice.
    assert.equal((await importBackup(file, 'Schlüsselbund-2026', inner, opts())).identityRestored, true);

    // The copy moved with the behaviour: it used to say „Dieser Mac muss neu gekoppelt werden",
    // which would now send the user to re-pair a Mac that needs one more click.
    const inner2 = memKeyStore();
    let k = 0;
    const flaky2 = {
      get: inner2.get, del: inner2.del, list: inner2.list,
      put: async (id, v) => { k += 1; if (k > 1) throw new Error('disk full'); return inner2.put(id, v); },
    };
    await assert.rejects(() => importBackup(file, 'Schlüsselbund-2026', flaky2, opts()));
    let err = null;
    try { await importBackup(file, 'Schlüsselbund-2026', inner2, opts()); } catch (e) { err = e; }
    assert.equal(err.code, 'keystore-partial');
    assert.equal(err.say.de.includes('neu gekoppelt'), false);
    assert.ok(err.say.de.includes('noch einmal'));

    // AND THE DELETE IS BEHIND THE TAG. T5, who has the Mac but not the passphrase, cannot use
    // this path to wipe anything: `prepareKeyStore` is step 4, after the AEAD has authenticated
    // the file, and a file she cannot open never gets there.
    const inner3 = memKeyStore();
    let j = 0;
    const flaky3 = {
      get: inner3.get, del: inner3.del, list: inner3.list,
      put: async (id, v) => { j += 1; if (j > 2) throw new Error('disk full'); return inner3.put(id, v); },
    };
    await assert.rejects(() => importBackup(file, 'Schlüsselbund-2026', flaky3, opts()));
    const before = (await inner3.list()).sort();
    assert.equal(await outcomeOf(() => importBackup(file, 'falsch', inner3, opts())), 'cannot-open');
    assert.deepEqual((await inner3.list()).sort(), before, 'a wrong passphrase reached the delete');
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
  test('M-B6 HALF INVERTED — the epoch gaps are now reported; the KREIS still cannot be checked here, and is now SAID', async () => {
    // ─────────────────────────────────────────────────────────────────────────────────────
    // §7.3 step 6 says the restored epoch keys "decrypt everything already on the server" and
    // that a newer epoch parks. What no part of `importBackup` can know is whether this member is
    // STILL in that Kreis, or ever was: `family.id` and the epochs are payload fields, and the
    // authority that could contradict them (the member list, the admin chain) is the fold's and
    // arrives later. So a backup handed to you by a family member — „ich hab dir dein Backup
    // wiederhergestellt" — attaches your restored Mac to whatever Kreis the file names.
    //
    // THE TWO HALVES CAME APART UNDER MEASUREMENT, and the domain is what separated them:
    //
    //   THE EPOCHS (S8) — CLOSED. A sparse ring used to import in total silence while the
    //   WRAPPING side refused a partial ring loudly; the two sides disagreed about §4.3's own
    //   rule. `result.spaces.<which>.missingEpochs` now carries the numbers and the consequence
    //   becomes `identity-restored-keys-pending` — §7.3 step 6's „Schlüssel ausstehend".
    //
    //   THE KREIS — NOT CLOSABLE HERE, and `tests/helpers/crypto-domains.js` proves it rather
    //   than asserting it: C2c-1 („mein Kreis") and C2c-2 („ein anderer Kreis") are the SAME
    //   INPUT — two fresh, well-formed `fsp_` ids — because the difference is not in the file.
    //   No implementation can warn on one and stay silent on the other. So the honest thing is
    //   said UNCONDITIONALLY, on `result.familyBinding`, and the check itself is carried to §7.3
    //   step 5's `POST /devices/adopt`, which is the only authority that can contradict a file.
    // ─────────────────────────────────────────────────────────────────────────────────────
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
      'ein-langes-Passwort-2026', { exportedAt: DAY, app: APP, iterations: FAST });

    const out = await importBackup(file, 'ein-langes-Passwort-2026', memKeyStore(), opts());
    assert.equal(out.spaces.family.id, FSP);
    assert.deepEqual([...out.spaces.family.epochs.keys()], [4]);

    // S8 — the silence is gone. The restore still happens (refusing would throw away everything
    // from epoch 4 on, for a member who may have nothing else left), and it says what is missing.
    assert.deepEqual([...out.spaces.family.missingEpochs], [1, 2, 3],
      'a sparse ring imported without comment — S8 is OPEN AGAIN');
    assert.equal(out.consequence.code, 'identity-restored-keys-pending');
    assert.ok(out.consequence.de.includes('Schlüssel ausstehend'));

    // M-B6's own half: the Kreis is NAMED and NAMED AS UNVERIFIED, on every family restore.
    assert.equal(out.familyBinding.spaceId, FSP);
    assert.equal(out.familyBinding.verified, false);
    assert.ok(out.familyBinding.say.de.includes('nicht nachprüfen'));

    // …and this is what is STILL TRUE and still not fixable here: the self-attestation binds this
    // Mac to whatever `identity.memberId` the file carried. That is the intended behaviour — it
    // is exactly why the file is „dein Schlüssel" — and it is why the sentence above matters.
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
    // NOT THE LAST CHARACTER, AND THE REASON IS A REAL TRAP — found by this row FLAKING once in
    // sixteen runs. A base64url string whose byte length is not a multiple of 3 ends in a
    // character carrying SLACK BITS, and `ub64` is strict about them: `A`→`B` there sets a slack
    // bit, so the string stops being base64url at all and `inspectBackup` refuses it with
    // `identity-damaged` BEFORE the tag is ever reached. The row then measured the shape guard
    // instead of the AEAD, at random, depending on what the last ciphertext byte happened to be.
    // A middle character is fully significant, and `A`↔`z` (0 ↔ 51) moves the high bits.
    const flipped = clone(file);
    const mid = Math.floor(flipped.identity.sealed.length / 2);
    flipped.identity.sealed = flipped.identity.sealed.slice(0, mid)
      + (flipped.identity.sealed[mid] === 'A' ? 'z' : 'A')
      + flipped.identity.sealed.slice(mid + 1);
    assert.equal(await outcomeOf(() => importBackup(flipped, 'Schlüsselbund-2026', memKeyStore(), opts())),
      'cannot-open');
  });
});
