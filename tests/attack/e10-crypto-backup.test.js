// ─────────────────────────────────────────────────────────────────────────────
// E10 / LZP-1003 — THE BACKUP AND RESTORE PASS (ADR 002 §7.2, §7.3, §8.11, A2, D8)
//
// `crypto-member-backup.test.js` attacked this file as a family member who STOLE it: M-B1…M-B6
// are a thief's rows, and they hold. This file attacks the other direction — the file that is
// GENUINE, opens under a passphrase the user really has, and is still not the file she thinks it
// is. §7.3's own copy names that person: „Wenn dir jemand anderes diese Datei gegeben hat."
//
//   E10-B1  a bundle carrying ZERO epoch keys                 was **SUCCEEDED** — now INVERTED
//   E10-B2  a bundle claiming epoch 2 000 000                 was **SUCCEEDED** — now INVERTED
//   E10-B3  the identity block: encrypted, or absent          FAILED — D8 as a property of output
//   E10-B4  restored into a DIFFERENT Familienkreis           **SUCCEEDED** — unfixable here, SAID
//   E10-B5  two Macs restore one file, both are the member    **SUCCEEDED** — structural, reported
//   E10-B6  a truncated or bit-flipped archive                FAILED — and the other half, said
//   E10-B7  what a stolen file yields with NO passphrase      **SUCCEEDED** — the board, in clear
//   E10-B8  A2's filter is on two collections out of five     conditional — the dependency named
//
// THE RE-SEAL BELOW IS THE ATTACK, and it is self-validating: it DECRYPTS the honest file first,
// so a mistake in reconstructing the AAD fails the test rather than faking the attack.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import * as sk from '../../src/js/crypto/spacekeys.js';
import {
  exportBackup, importBackup, inspectBackup, deriveBackupKey, ownBoardOnly,
  IMPORT_CONSEQUENCE, EXPORT_SHEET_COPY, README, LIMITS, MAX_REPORTED_MISSING_EPOCHS,
} from '../../src/js/crypto/backup.js';
import { aesgcm, HASH } from '../../src/js/crypto/suite.js';
import { verifyAttestation } from '../../src/js/crypto/identity.js';
import { canonicalJSON } from '../../src/js/core/canon.js';
import { memKeyStore } from '../../src/js/platform/keystore.js';
import { makeMember, mkSpaceId, mkDeviceId, outcomeOf, b64u, ub64, DAY, FAST, S } from './_member-kit.js';

const APP = '2.0.0';
const PW = 'Kirschbaum-Sonntag-Regenschirm';
const clone = (f) => JSON.parse(JSON.stringify(f));
const opts = () => ({ deviceId: mkDeviceId(), createdAt: DAY, iterations: FAST });

const board = (over = {}) => ({
  schemaVersion: 2,
  notes: [{ id: 'n1', ownerId: over.ownerId, date: '2026-09-10', text: 'Zahnarzt Dr. Sommer' }],
  bars: [], categories: [], scratchpads: {}, settings: {},
  ...over.extra,
});

/** A real file with a real personal ring and, optionally, a real family ring. */
async function aBackup({ epochs = 1, family = null } = {}) {
  const me = await makeMember();
  const psp = mkSpaceId('personal');
  const personal = new Map();
  for (let e = 1; e <= epochs; e++) personal.set(e, await sk.createSpaceKey());
  const spaces = { personal: { id: psp, epochs: personal } };
  let fsp = null;
  if (family) {
    fsp = mkSpaceId('family');
    const fam = new Map();
    for (let e = 1; e <= family; e++) fam.set(e, await sk.createSpaceKey());
    spaces.family = { id: fsp, epoch: family, epochs: fam };
  }
  const file = await exportBackup(
    board({ ownerId: me.memberId }),
    { memberId: me.memberId, recSig: me.rec.recSig, recKex: me.rec.recKex },
    spaces, PW, { exportedAt: DAY, app: APP, iterations: FAST }
  );
  return { me, file, psp, fsp };
}

/**
 * `boardDigestInput`'s equation, re-derived here rather than imported, so the AAD this helper
 * builds is an INDEPENDENT reconstruction and the decrypt below really is a check on it.
 */
const sortedReplacer = (key, value) =>
  (value === null || typeof value !== 'object' || Array.isArray(value))
    ? value
    : Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]]));

async function aadOf(file) {
  const digest = b64u(new Uint8Array(await S.digest(
    HASH, new TextEncoder().encode(JSON.stringify(file.board, sortedReplacer))
  )));
  const id = file.identity;
  return new TextEncoder().encode(canonicalJSON({
    _README_de: file._README_de, _README_en: file._README_en, app: file.app,
    board: { digest, hash: HASH },
    exportedAt: file.exportedAt, format: file.format,
    kdf: { hash: id.kdf.hash, iterations: id.kdf.iterations, name: id.kdf.name, salt: id.kdf.salt },
    memberId: id.memberId, v: file.v,
  }));
}

/**
 * Open the sealed payload, let the caller edit it, seal it again under the SAME key, iv and AAD.
 * This is exactly what whoever wrote the file can do, and nothing an outsider can do.
 */
async function reseal(file, mutate) {
  const id = file.identity;
  const key = await deriveBackupKey(PW, ub64(id.kdf.salt), id.kdf.iterations);
  const raw = ub64(id.sealed);
  const iv = raw.slice(0, 12);
  const aad = await aadOf(file);
  // If `aadOf` were wrong in any byte, this decrypt throws — the helper cannot fake the attack.
  const plain = new Uint8Array(await S.decrypt(aesgcm(iv, aad), key, raw.slice(12)));
  const payload = JSON.parse(new TextDecoder().decode(plain));
  mutate(payload);
  const ct = new Uint8Array(await S.encrypt(aesgcm(iv, aad), key, new TextEncoder().encode(canonicalJSON(payload))));
  const out = clone(file);
  out.identity.sealed = b64u(new Uint8Array([...iv, ...ct]));
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════

describe('E10-B1 · a bundle that carries no keys at all', () => {
  // ───────────────────────────────────────────────────────────────────────────
  // THE ATTACK. §7.2's export side refuses an empty ring LOUDLY — `bundleFor` throws, quoting
  // A4, 17.1 and §7.1 step 5. The import side accepted one in total silence and reported
  // `identity-restored`: „Dein Board ist zurück und deine Schlüssel auch."
  //
  // That is finding S8's own sentence — "the wrapping side already refused a partial ring loudly;
  // the restoring side accepted one in silence, so the two sides disagreed about §4.3's own rule"
  // — with one word changed. S8 closed the SPARSE ring and left the EMPTY one, because
  // `missingEpochsOf` began `if (held.length === 0) return []`, and S8's own contract makes the
  // ABSENCE of `missingEpochs` the "complete" signal.
  //
  // AND TWO MODULES GAVE OPPOSITE ANSWERS ABOUT ONE RING. `KeyRing.missing(space, upTo)` answers
  // `1..upTo` for a ring holding nothing, and ADR 002 §8.5a made that the authority for D9's
  // „Schlüssel ausstehend" (finding T5-K2). The restore is what the user reads FIRST.
  // ───────────────────────────────────────────────────────────────────────────

  test('the two modules disagreed, and the disagreement was the defect', async () => {
    // The authority, stated first, so the assertion below is a comparison and not an opinion.
    const empty = sk.createKeyRing();
    const spaceId = mkSpaceId('family');
    assert.deepEqual(empty.missing(spaceId, 3), [1, 2, 3], 'an empty KeyRing covers nothing…');
    assert.equal(empty.covers(spaceId, 3), false, '…and D9\'s waiting state is read from exactly this');
  });

  test('INVERTED — an empty FAMILY ring is reported, and the consequence says „Schlüssel ausstehend"', async () => {
    const { file, fsp } = await aBackup({ family: 4 });
    const hostile = await reseal(file, (p) => { p.family = { epochs: {}, id: fsp, epoch: 9 }; });

    const r = await importBackup(hostile, PW, memKeyStore(), opts());
    assert.equal(r.spaces.family.epochs.size, 0, 'the ring really is empty');
    // WAS: `undefined` — the "complete" signal, over a space that can read nothing.
    assert.deepEqual([...r.spaces.family.missingEpochs], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // WAS: 'identity-restored' — „Dein Board ist zurück und deine Schlüssel auch."
    assert.equal(r.consequence.code, IMPORT_CONSEQUENCE.identityRestoredWithGaps.code);
    assert.match(r.consequence.de, /Schlüssel ausstehend/);
    assert.match(r.consequence.en, /keys pending/);
  });

  test('INVERTED — and on the PERSONAL space, which is the one holding my own private entries', async () => {
    // Story 19.4 and A2 are about the personal space. An empty personal ring means a Mac that
    // restored „successfully" and cannot read one word the user ever wrote privately.
    const { file, psp } = await aBackup({ epochs: 3 });
    const hostile = await reseal(file, (p) => { p.personal = { epochs: {}, id: psp, epoch: 3 }; });

    const r = await importBackup(hostile, PW, memKeyStore(), opts());
    assert.equal(r.spaces.personal.epochs.size, 0);
    assert.deepEqual([...r.spaces.personal.missingEpochs], [1, 2, 3]);
    assert.equal(r.consequence.code, IMPORT_CONSEQUENCE.identityRestoredWithGaps.code);
  });

  test('INVERTED — an empty ring with NO claimed epoch is still a hole at epoch 1', async () => {
    // `epoch` is optional on a bundle (§7.2 lists it on `family` only). With no claim and no keys
    // there is nothing to take a maximum over, which is exactly how the old code reached `[]`.
    // The floor is 1 — `bundleFor` and `importSpaces` both refuse below it — so a ring holding
    // nothing is missing at least that one.
    const { file, fsp } = await aBackup({ family: 2 });
    const hostile = await reseal(file, (p) => { p.family = { epochs: {}, id: fsp }; });
    const r = await importBackup(hostile, PW, memKeyStore(), opts());
    assert.deepEqual([...r.spaces.family.missingEpochs], [1]);
    assert.equal(r.consequence.code, IMPORT_CONSEQUENCE.identityRestoredWithGaps.code);
  });

  test('and the honest file is untouched: a complete ring still reports COMPLETE', async () => {
    // The non-vacuity half. A fix that reported a gap on every restore would be worse than the
    // silence it replaced — „Schlüssel ausstehend" on a healthy Mac is a permanently red light.
    const { file } = await aBackup({ epochs: 3, family: 2 });
    const r = await importBackup(clone(file), PW, memKeyStore(), opts());
    assert.equal(r.spaces.personal.missingEpochs, undefined, 'absent IS the complete signal (S8)');
    assert.equal(r.spaces.family.missingEpochs, undefined);
    assert.equal(r.consequence.code, IMPORT_CONSEQUENCE.identityRestored.code);
    assert.deepEqual([...r.spaces.personal.epochs.keys()], [1, 2, 3]);
  });

  test('and S8\'s own case — a hole BELOW the top — still reports exactly the numbers it did', async () => {
    const { file, fsp } = await aBackup({ family: 4 });
    const hostile = await reseal(file, (p) => {
      const kept = {};
      for (const [k, v] of Object.entries(p.family.epochs)) if (k === '3' || k === '4') kept[k] = v;
      p.family = { epochs: kept, id: fsp, epoch: 4 };
    });
    const r = await importBackup(hostile, PW, memKeyStore(), opts());
    assert.deepEqual([...r.spaces.family.missingEpochs], [1, 2]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('E10-B2 · a bundle that claims epoch 2 000 000', () => {
  test('INVERTED — the report is bounded, and its PRESENCE is still the signal', async () => {
    // ─────────────────────────────────────────────────────────────────────────
    // `kdf.iterations` is clamped because "PBKDF2 is a loop and `{"iterations": 1e12}` is a
    // denial of service that looks exactly like a slow import" (`MAX_KDF_ITERATIONS`). The very
    // same sentence is true of `bundle.epoch`, which `missingEpochsOf` enumerated from 1 with no
    // bound at all: an authenticated payload claiming two million built and froze a two-million-
    // element array on the restore path — on a Mac whose owner may have nothing else left.
    //
    // Bounded rather than refused, for S8's own reason: the field's contract is its PRESENCE, and
    // `consequence` is what the user reads. Truncating the list cannot make a broken ring look
    // whole.
    // ─────────────────────────────────────────────────────────────────────────
    const { file, fsp } = await aBackup({ family: 2 });
    const hostile = await reseal(file, (p) => { p.family = { ...p.family, id: fsp, epoch: 2_000_000 }; });

    const started = Date.now();
    const r = await importBackup(hostile, PW, memKeyStore(), opts());
    const elapsed = Date.now() - started;

    assert.equal(r.spaces.family.missingEpochs.length, MAX_REPORTED_MISSING_EPOCHS);
    assert.ok(elapsed < 5000, `the restore must not be a loop over an attacker's number (took ${elapsed} ms)`);
    // The signal survives the cap: the ring has holes, and the sentence says so.
    assert.equal(r.consequence.code, IMPORT_CONSEQUENCE.identityRestoredWithGaps.code);
    // And the keys it DOES hold are still there — the cap costs rows, not data.
    assert.deepEqual([...r.spaces.family.epochs.keys()], [1, 2]);
  });

  test('a claim just under the cap is still reported in full, so the bound is not a rounding', async () => {
    const { file, fsp } = await aBackup({ family: 1 });
    const hostile = await reseal(file, (p) => { p.family = { ...p.family, id: fsp, epoch: 40 }; });
    const r = await importBackup(hostile, PW, memKeyStore(), opts());
    assert.deepEqual([...r.spaces.family.missingEpochs], Array.from({ length: 39 }, (_, i) => i + 2));
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('E10-B3 · D8, as a property of the output', () => {
  test('FAILED — encrypted or absent, and stripping the block downgrades HONESTLY rather than claiming success', async () => {
    const { me, file } = await aBackup({ family: 2 });

    // Encrypted: no private material anywhere in the bytes. (M-B1 pays this; repeated here because
    // the rows below are only meaningful against a file that really is sealed.)
    const wire = JSON.stringify(file);
    for (const k of [me.rec.recSig.privateKey, me.rec.recKex.privateKey]) {
      assert.equal(wire.includes(b64u(new Uint8Array(await S.exportKey('pkcs8', k)))), false);
    }

    // THE ATTACK: delete the block. The file still says „DIES IST DEIN SCHLÜSSEL" across the top —
    // that README is a plain field of a file whose identity is gone. So the question is whether
    // the IMPORT claims anything the file can no longer deliver.
    const stripped = clone(file);
    delete stripped.identity;
    assert.match(stripped._README_de, /DIES IST DEIN SCHLÜSSEL/, 'the header still reads as a key file');

    const seen = inspectBackup(stripped);
    assert.equal(seen.hasIdentity, false);
    assert.equal(seen.needsPassphrase, false, 'and it does not even ask');

    const r = await importBackup(stripped, PW, memKeyStore(), opts());
    assert.equal(r.identityRestored, false);
    assert.equal(r.identity, null);
    assert.equal(r.spaces, null);
    assert.equal(r.familyBinding, null);
    // The one thing that matters: the consequence is the REDUCED one, said out loud.
    assert.equal(r.consequence.code, IMPORT_CONSEQUENCE.boardOnly.code);
    assert.match(r.consequence.de, /keine Schlüssel/);
  });

  test('a passphrase offered to a stripped file changes nothing, and is not mistaken for success', async () => {
    const { file } = await aBackup();
    const stripped = clone(file);
    delete stripped.identity;
    const a = await importBackup(stripped, PW, memKeyStore(), opts());
    const b = await importBackup(stripped, null, memKeyStore(), opts());
    assert.equal(a.consequence.code, b.consequence.code);
    assert.equal(a.identityRestored, false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('E10-B4 · restored into a DIFFERENT Familienkreis', () => {
  test('**SUCCEEDED** — and it is unfixable in this module, which is why it is SAID on every restore', async () => {
    // ─────────────────────────────────────────────────────────────────────────
    // THE ENUMERATED DOMAIN IS THE PROOF: the „my Kreis" and „another Kreis" inputs are the same
    // bytes at this seam. `importBackup` is I/O-free; the member list is the fold's and arrives
    // later; §7.3 step 5's `POST /devices/adopt` is the only thing that can contradict a file.
    //
    // So the row SUCCEEDS — the Mac really is enrolled in whichever Kreis the file names — and
    // what is asserted is that the module does not pretend otherwise, UNCONDITIONALLY. A warning
    // that appeared only on the hostile file would be a claim this module cannot make.
    // ─────────────────────────────────────────────────────────────────────────
    const { file } = await aBackup({ family: 2 });
    const stranger = mkSpaceId('family');
    const hostile = await reseal(file, (p) => { p.family = { ...p.family, id: stranger }; });

    const mine = await importBackup(clone(file), PW, memKeyStore(), opts());
    const theirs = await importBackup(hostile, PW, memKeyStore(), opts());

    assert.notEqual(theirs.familyBinding.spaceId, mine.familyBinding.spaceId, 'a different Kreis…');
    assert.equal(theirs.consequence.code, mine.consequence.code, '…and the same consequence code');

    // The statement is identical on both, which is the honest shape.
    for (const r of [mine, theirs]) {
      assert.equal(r.familyBinding.verified, false);
      assert.equal(r.familyBinding.say.code, IMPORT_CONSEQUENCE.familyBindingUnverified.code);
      assert.match(r.familyBinding.say.de, /dieser Mac kann es nicht nachprüfen/);
      assert.match(r.familyBinding.say.de, /Wenn dir jemand anderes diese Datei gegeben hat/);
      assert.match(r.familyBinding.say.en, /cannot\s*\n?\s*check it/);
    }
  });

  test('and a file with no family bundle says nothing, rather than saying it about nothing', async () => {
    const { file } = await aBackup();
    const r = await importBackup(clone(file), PW, memKeyStore(), opts());
    assert.equal(r.familyBinding, null);
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('E10-B5 · two Macs restore one file, and both of them ARE the member', () => {
  test('**SUCCEEDED** — the clone is structural, indistinguishable, and unbounded', async () => {
    // ─────────────────────────────────────────────────────────────────────────
    // §7.3 step 3 mints FRESH device keys on every restore — "a device is a machine, not a
    // person" — and that is correct. Its consequence is that the file plus the passphrase is a
    // MEMBER-CLONING PRIMITIVE: each restore produces a genuine, self-attested device of that
    // member, signed by the real `RK_sig`, verifying on every machine in the circle. Nothing
    // counts them, nothing bounds them, and §8.12 has no revocation for the recovery key.
    //
    // §8.5's stated mitigation is the per-member DEVICE COUNT in the member list. That is the
    // only signal a family gets, and per §8.5's own 2026-09-01 note it currently renders as
    // nothing, because `family/mount.js#refreshRoster` maps the roster down to `memberId`,
    // `colorRef`, `removedAt`. That file is not this ticket's; the interaction is reported.
    // ─────────────────────────────────────────────────────────────────────────
    const { me, file } = await aBackup({ family: 2 });

    const first = await importBackup(clone(file), PW, memKeyStore(), opts());
    const second = await importBackup(clone(file), PW, memKeyStore(), opts());

    // Two DIFFERENT devices…
    assert.notEqual(first.identity.deviceShort, second.identity.deviceShort);
    assert.notEqual(first.blob, second.blob);
    // …of the SAME member, each self-attested under the same recovery key…
    assert.equal(first.identity.memberId, me.memberId);
    assert.equal(second.identity.memberId, me.memberId);
    for (const r of [first, second]) {
      const opened = await verifyAttestation(r.blob, me.rec.recSig.publicKey);
      assert.notEqual(opened, null, 'a clone\'s attestation verifies — there is nothing wrong with it');
      assert.equal(opened.memberId, me.memberId);
      assert.equal(opened.deviceShort, r.identity.deviceShort);
    }
    // …and each holding the whole key ring, so each reads everything the member can read.
    assert.deepEqual([...first.spaces.family.epochs.keys()], [...second.spaces.family.epochs.keys()]);

    // Nothing in the RESULT distinguishes the second restore from the first. There is no field a
    // caller could surface, because there is no fact to surface: both are honest.
    assert.equal(first.consequence.code, second.consequence.code);
    assert.equal(first.familyBinding.spaceId, second.familyBinding.spaceId);
  });

  test('the same file restored a third and fourth time is still accepted — there is no counter to exhaust', async () => {
    const { file } = await aBackup();
    for (let i = 0; i < 3; i++) {
      const r = await importBackup(clone(file), PW, memKeyStore(), opts());
      assert.equal(r.identityRestored, true);
    }
  });

  test('into the SAME store, though, it is idempotent rather than a second device', async () => {
    // The bound that DOES exist, and its shape is worth stating: one store, one identity.
    const { file } = await aBackup();
    const ks = memKeyStore();
    const first = await importBackup(clone(file), PW, ks, opts());
    const again = await importBackup(clone(file), PW, ks, opts());
    assert.equal(again.identity.deviceShort, first.identity.deviceShort, 'adopted, not minted again');
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('E10-B6 · a truncated or bit-flipped archive', () => {
  test('FAILED — every truncation of the sealed blob is one code, and nothing is written', async () => {
    const { file } = await aBackup({ family: 2 });
    const sealed = file.identity.sealed;
    for (const cut of [1, 4, 17, Math.floor(sealed.length / 2), sealed.length - 1]) {
      const bad = clone(file);
      bad.identity.sealed = sealed.slice(0, cut);
      const ks = memKeyStore();
      const code = await outcomeOf(() => importBackup(bad, PW, ks, opts()));
      assert.ok(['identity-damaged', 'cannot-open'].includes(code), `truncated at ${cut}: got ${code}`);
      assert.deepEqual(await ks.list(), [], 'and the key store was never opened');
    }
  });

  test('FAILED — a flipped bit anywhere in the sealed blob, and anywhere in the BOARD, is the same event', async () => {
    const { file } = await aBackup();

    // (a) the ciphertext.
    const raw = ub64(file.identity.sealed);
    for (const at of [0, 12, 30, raw.length - 1]) {
      const flipped = new Uint8Array(raw);
      flipped[at] ^= 0x01;
      const bad = clone(file);
      bad.identity.sealed = b64u(flipped);
      assert.equal(await outcomeOf(() => importBackup(bad, PW, memKeyStore(), opts())), 'cannot-open');
    }

    // (b) the board — S3. One character of one note, and the whole file stops opening.
    const edited = clone(file);
    edited.board.notes[0].text = 'Zahnarzt Dr. Sommer.';
    assert.equal(await outcomeOf(() => importBackup(edited, PW, memKeyStore(), opts())), 'cannot-open');

    // (c) an ADDED entry, which is the shape that matters — somebody writing INTO your board.
    const added = clone(file);
    added.board.notes.push({ id: 'n2', date: '2026-09-11', text: 'Termin beim Anwalt' });
    assert.equal(await outcomeOf(() => importBackup(added, PW, memKeyStore(), opts())), 'cannot-open');

    // A wrong passphrase is the same code. From outside the module the two ARE the same event:
    // this file is not the file it claims to be.
    assert.equal(await outcomeOf(() => importBackup(clone(file), 'wrong-wrong-wrong', memKeyStore(), opts())), 'cannot-open');
  });

  test('and the honest other half: the BOARD-ONLY file is editable, and its own copy says so', async () => {
    const me = await makeMember();
    const boardOnly = await exportBackup(
      board({ ownerId: me.memberId }), { memberId: me.memberId }, null, null,
      { exportedAt: DAY, app: APP }
    );
    const edited = clone(boardOnly);
    edited.board.notes.push({ id: 'n2', date: '2026-09-11', text: 'nicht von mir' });
    const r = await importBackup(edited, null, memKeyStore(), { createdAt: DAY, deviceId: mkDeviceId() });
    assert.equal(r.board.notes.length, 2, 'the edit lands — there is no key, so there is no seal');

    // Two paths, two STATED guarantees. Both sentences exist, in both languages, and they differ.
    assert.match(LIMITS.board.boardOnly.de, /nicht signiert/);
    assert.match(LIMITS.board.withIdentity.de, /versiegelt/);
    assert.notEqual(LIMITS.board.boardOnly.de, LIMITS.board.withIdentity.de);
    assert.match(README.boardOnly.de, /OHNE DEINE SCHLÜSSEL/);
    assert.match(EXPORT_SHEET_COPY.boardOnly.entriesNotSealed.de, /nicht versiegelt/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('E10-B7 · what a stolen file yields with NO passphrase', () => {
  test('**SUCCEEDED** — the whole board, in the clear. The passphrase protects the KEYS, not the CONTENT.', async () => {
    // ─────────────────────────────────────────────────────────────────────────
    // D8 is about the identity block, and D8 holds (E10-B3). `board` is not in it and never was:
    // it is plaintext JSON on BOTH export paths. So the file the onboarding tells the user to
    // carry off the machine — to a Dropbox, a NAS, a mail archive — discloses every note, bar,
    // category and scratchpad she owns to anyone who opens it in a text editor.
    //
    // This is not a defect in the crypto; §7.2 never claimed the board was sealed for
    // confidentiality, and S3 bound it into the AAD for INTEGRITY. It is a defect in what a
    // reader will conclude. LZP-1003 reviews STRINGS as well as code (§7.4), so the strings are
    // the finding: `README.withIdentity` says „Wer diese Datei und dein Passwort hat, ist du" —
    // which reads as *both* are needed — and `sealsEntriesToo` says „Auch die Einträge sind
    // versiegelt", where „versiegelt" is doing integrity's work in a sentence a non-technical
    // reader will hear as confidentiality's.
    // ─────────────────────────────────────────────────────────────────────────
    const { file } = await aBackup({ family: 2 });
    const wire = JSON.stringify(file);

    // Every word of the user's own entry, readable, with no passphrase and no key.
    assert.ok(wire.includes('Zahnarzt Dr. Sommer'), 'the note text is in the file in plain text');
    // And `inspectBackup` — pure, passphrase-free — hands a thief the counts and the memberId.
    const seen = inspectBackup(file);
    assert.equal(seen.counts.notes, 1);
    assert.equal(seen.memberId, file.identity.memberId);

    // THE COPY. No string anywhere in the export sheet, the READMEs or LIMITS tells the user that
    // the entries are readable without the password. If one is ever added, this assertion is what
    // has to be inverted, and the row above is the reason.
    const strings = JSON.stringify([EXPORT_SHEET_COPY, README, LIMITS]);
    const saysContentIsReadable = /ohne Passwort lesbar|lesbar für jeden|readable without|not encrypted|nicht verschlüsselt/i;
    assert.equal(
      saysContentIsReadable.test(strings), false,
      'REPORTED, not fixed here: the copy does not say the entries are readable without the password'
    );
    // What it does say, so the gap is legible rather than asserted in the abstract:
    assert.match(README.withIdentity.de, /Wer diese Datei und dein Passwort hat, ist du/);
    assert.match(EXPORT_SHEET_COPY.withPassword.sealsEntriesToo.de, /Auch die Einträge sind versiegelt/);
  });

  test('and the board-only file discloses exactly the same board — the two paths differ only in the keys', async () => {
    const me = await makeMember();
    const withKeys = await exportBackup(
      board({ ownerId: me.memberId }), { memberId: me.memberId, recSig: me.rec.recSig, recKex: me.rec.recKex },
      { personal: { id: mkSpaceId('personal'), epochs: new Map([[1, await sk.createSpaceKey()]]) } },
      PW, { exportedAt: DAY, app: APP, iterations: FAST }
    );
    const without = await exportBackup(
      board({ ownerId: me.memberId }), { memberId: me.memberId }, null, null, { exportedAt: DAY, app: APP }
    );
    assert.deepEqual(without.board, withKeys.board, 'the same plaintext board on both paths');
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('E10-B8 · A2 is enforced on two collections out of five', () => {
  test('the filter is real on notes and bars — and absent on categories, scratchpads and settings', async () => {
    // ─────────────────────────────────────────────────────────────────────────
    // A2: "contains only my data". `ownBoardOnly` filters `notes` and `bars` by `ownerId` and
    // `isForeign`; `categories` are filtered only for being objects, and `scratchpads` and
    // `settings` are copied WHOLESALE.
    //
    // That is SAFE TODAY, and the reason is outside this module: the family space carries only
    // projected `note:`/`bar:` patches plus the `member:`/`space:` governance registers
    // (`PROJECT_CONTRACT`, ADR 004 §2), so no `cat:` or `pad:` register another member authored
    // can reach a materialized board. A2 therefore holds by a property of the PROJECTION, not by
    // a property of this filter.
    //
    // The row exists so that dependency has a name. The day WP-10 ships a shared scratchpad or a
    // shared category, A2 breaks here, silently, in the one file the user is told to email
    // herself — and nothing in this module would notice.
    // ─────────────────────────────────────────────────────────────────────────
    const mine = 'mem_' + 'A'.repeat(22);
    const theirs = 'mem_' + 'B'.repeat(22);
    const out = ownBoardOnly({
      schemaVersion: 2,
      notes: [
        { id: 'n1', ownerId: mine, date: '2026-09-10', text: 'meins' },
        { id: 'n2', ownerId: theirs, date: '2026-09-11', text: 'Mamas Geheimnis' },
        { id: 'n3', isForeign: true, date: '2026-09-12', text: 'auch nicht meins' },
      ],
      bars: [{ id: 'b1', ownerId: theirs, from: '2026-09-01', to: '2026-09-05', text: 'Papas Urlaub' }],
      categories: [{ id: 'c1', name: 'Mamas Kategorie' }],
      scratchpads: { 'pad:2026-09': 'ein Zettel' },
      settings: { anything: 'kommt mit' },
    }, mine);

    // The half that is enforced.
    assert.deepEqual(out.notes.map((n) => n.id), ['n1'], 'a foreign note never reaches the file');
    assert.deepEqual(out.bars, [], 'nor a foreign bar');
    assert.equal(JSON.stringify(out).includes('Mamas Geheimnis'), false);
    assert.equal(JSON.stringify(out).includes('Papas Urlaub'), false);

    // The half that is NOT — stated as a fact, not as a pass.
    assert.equal(out.categories.length, 1, 'every category comes through, whoever wrote it');
    assert.deepEqual(out.scratchpads, { 'pad:2026-09': 'ein Zettel' }, 'scratchpads are copied wholesale');
    assert.deepEqual(out.settings, { anything: 'kommt mit' }, 'and so are settings');
  });

  test('the dependency, asserted where it lives: the family projection emits note and bar patches and nothing else', async () => {
    // If this ever stops being true, E10-B8's first row stops being safe. Reading the contract is
    // what makes the coupling visible from this file.
    const { PROJECT_CONTRACT } = await import('../../src/js/crypto/envelope.js');
    const clauses = PROJECT_CONTRACT.clauses.join(' ');
    assert.match(clauses, /projectForFamily\(kind, truth, level, lastPublished\)/);
    assert.match(clauses, /family field patch, or null/);
    assert.equal(PROJECT_CONTRACT.adr.includes('ADR 004'), true);
  });
});
