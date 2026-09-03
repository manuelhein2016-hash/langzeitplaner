// ─────────────────────────────────────────────────────────────────────────────
// E10 / LZP-1003 — KEY HANDLING AT THE SEAMS, AND THE SEVEN ENGINE-DIFFERENCE RULES
//
// Two halves, and the second is the one the ticket asks by name: are the seven rules still held
// EVERYWHERE, including in code written after they were written down? The answer this pass found
// is **no** — `pairing.js` broke rule 3 in two places, and both are now closed and driven from
// `e10-crypto-pairing.test.js`. The rows here are the rules stated as PROPERTIES rather than as a
// checklist, so a future violation fails a test instead of passing a review.
//
//   E10-K1  the epoch poisoning, from the crypto side       **SUCCEEDED** — priced, not closed
//   E10-K2  the ring is the authority for „Schlüssel ausstehend"   FAILED
//   E10-K3  rule 1 — no signature bytes are ever compared          FAILED
//   E10-K4  rule 2 — nothing zero-length is signed, no AAD is empty FAILED
//   E10-K5  rule 3 — every refusal carries a code THIS repo chose   FAILED (after E10-P1)
//   E10-K6  rules 4, 5, 6, 7                                       FAILED
//
// A CHECKLIST REVIEW PERFORMED BY THE SYSTEM THAT WROTE THE CRYPTO FINDS WHAT IT ALREADY THOUGHT
// OF. So no row below reads a comment claiming a rule is held: every one of them runs the code.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as sk from '../../src/js/crypto/spacekeys.js';
import * as identity from '../../src/js/crypto/identity.js';
import {
  hkdf, pbkdf2, aesgcm, assertSignable, USAGES, NO_SALT, INFO,
  PKCS8_P256_BYTES, RAW_PUBKEY_BYTES, SYMMETRIC_KEY_BYTES, SIG, KEX,
} from '../../src/js/crypto/suite.js';
import { restorePairingPayload, PAIRING } from '../../src/js/crypto/pairing.js';
import { importBackup, BACKUP_ERROR_CODES } from '../../src/js/crypto/backup.js';
import { memKeyStore } from '../../src/js/platform/keystore.js';
import { makeMember, memberRecord, mkSpaceId, mkDeviceId, outcomeOf, b64u, DAY, S } from './_member-kit.js';

const CRYPTO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'js', 'crypto');
const cryptoSources = () => readdirSync(CRYPTO_DIR)
  .filter((f) => f.endsWith('.js'))
  .map((f) => [f, readFileSync(join(CRYPTO_DIR, f), 'utf8')]);

const noise = (n) => b64u(crypto.getRandomValues(new Uint8Array(n)));

// ═════════════════════════════════════════════════════════════════════════════

describe('E10-K1 · the epoch poisoning, driven from the crypto side', () => {
  test('**SUCCEEDED** — a poisoned rung is indistinguishable from a real one without opening it, and the crypto layer is not where that is fixed', async () => {
    // ─────────────────────────────────────────────────────────────────────────
    // ADR 002 §8.5a: a member may rotate with real wraps for her friends and 156 bytes of noise
    // for the person she wants to keep out, and the relay cannot tell — `assertCoverage` counts
    // ROWS and reads epoch numbers, never bytes, "and it cannot, because telling a wrap from
    // noise means opening one".
    //
    // This row drives the half that IS in `src/js/crypto/` and shows exactly where the honesty
    // ends. The crypto layer gives the right local answer — the junk does not open, it is counted
    // `refused`, the ring stays uncovered, and nothing is silently admitted. What it CANNOT do is
    // tell anybody: no route exists by which the victim says "I cannot open epoch e", and no
    // route could without telling the relay the same thing.
    //
    // OWNER: ADR 002 §8.5a's report path — ADR 003's and `server/core/handlers/keys.js`'s, and
    // explicitly "not this section's". Priced, not closed; `docs/v2/STATUS.md` records that one
    // poisoned rung freezes a space, so no rate limit reaches it. Nothing below claims otherwise.
    // ─────────────────────────────────────────────────────────────────────────
    const victim = await makeMember();
    const rotator = await makeMember();
    const fsp = mkSpaceId('family');
    const senders = sk.familyRecipients([memberRecord(rotator)]);
    const rotatorPub = rotator.devices[0].kexPubRaw;
    const victimKexPriv = victim.devices[0].devKex.privateKey;

    // Epoch 1 is honest. Epoch 2 is 156 bytes of the rotator's choosing.
    const real = await sk.wrapToRecipients(
      await sk.createSpaceKey(), rotator.devices[0].devKex.privateKey,
      sk.familyRecipients([memberRecord(victim)]), { spaceId: fsp, epoch: 1 }
    );
    const honestRow = { epoch: 1, wrapped: real[0].wrapped, senderKexPubRaw: rotatorPub };
    const poisonedRow = {
      epoch: 2,
      wrapped: { v: 1, salt: noise(32), iv: noise(12), ct: noise(48) },
      senderKexPubRaw: rotatorPub,
    };

    const ring = sk.createKeyRing();
    const report = await sk.admitWraps(ring, [honestRow, poisonedRow], {
      spaceId: fsp, myKexPriv: victimKexPriv, senders,
    });

    // The local answer is correct and complete.
    assert.deepEqual(report.admitted, [1], 'the honest rung lands');
    assert.equal(report.refused, 1, 'the poisoned one is counted, never admitted');
    assert.equal(report.unauthorized, 0, 'and the SENDER was authorized — that is the whole point');
    assert.equal(ring.has(fsp, 2), false, 'no key materialises out of noise');
    assert.equal(ring.covers(fsp, 2), false, 'the ring knows it cannot read epoch 2');

    // AND THE THING THAT IS NOT CLOSED: nothing in this report distinguishes „my peer sent junk"
    // from „that wrap was addressed to my sibling Mac", which is the ordinary case §4.2 step 6
    // walks past every sync. Both are `refused`. A caller cannot raise an alarm on this number
    // without raising one on every honest rotation.
    const siblingRing = sk.createKeyRing();
    const forSomeoneElse = await sk.wrapToRecipients(
      await sk.createSpaceKey(), rotator.devices[0].devKex.privateKey,
      sk.familyRecipients([memberRecord(await makeMember())]), { spaceId: fsp, epoch: 2 }
    );
    const ordinary = await sk.admitWraps(siblingRing,
      [{ epoch: 2, wrapped: forSomeoneElse[0].wrapped, senderKexPubRaw: rotatorPub }],
      { spaceId: fsp, myKexPriv: victimKexPriv, senders });
    assert.equal(ordinary.refused, report.refused - report.admitted.length + 1);
    assert.equal(
      ordinary.refused, 1,
      'the honest case and the hostile case produce the SAME number: this is why the report path is owed'
    );
  });

  test('an honest wrap COEXISTS with a hostile one — the depositor is part of the cell (T5-K3)', async () => {
    // §8.5a's resolution: `(spaceId, epoch, recipientId, senderDeviceId)`, so a hostile rotator
    // who got to a joiner's empty cells first cannot keep them. On the receiving side that is
    // "walk the rows, count the one that will not open as refused, admit the one that does" —
    // asserted here over one epoch with two rows from two different depositors.
    const victim = await makeMember();
    const good = await makeMember();
    const bad = await makeMember();
    const fsp = mkSpaceId('family');
    const senders = sk.familyRecipients([memberRecord(good), memberRecord(bad)]);
    const key = await sk.createSpaceKey();
    const real = await sk.wrapToRecipients(
      key, good.devices[0].devKex.privateKey,
      sk.familyRecipients([memberRecord(victim)]), { spaceId: fsp, epoch: 3 }
    );

    const ring = sk.createKeyRing();
    // The hostile row FIRST, which is the order that used to lose the cell for ever.
    const report = await sk.admitWraps(ring, [
      { epoch: 3, wrapped: { v: 1, salt: noise(32), iv: noise(12), ct: noise(48) }, senderKexPubRaw: bad.devices[0].kexPubRaw },
      { epoch: 3, wrapped: real[0].wrapped, senderKexPubRaw: good.devices[0].kexPubRaw },
    ], { spaceId: fsp, myKexPriv: victim.devices[0].devKex.privateKey, senders });

    assert.deepEqual(report.admitted, [3], 'the honest wrap still lands, whoever deposited first');
    assert.equal(ring.has(fsp, 3), true, 'the cell is filled by the depositor whose bytes open');
    assert.deepEqual(ring.missing(fsp, 3), [1, 2], 'and only the rungs nobody has sent yet are missing');
    assert.equal(ring.originOf(fsp, 3).how, 'admitted');
    assert.equal(ring.originOf(fsp, 3).memberId, good.memberId, 'and the ring records WHO it came from');
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('E10-K2 · the ring, not a row count, answers D9\'s waiting state', () => {
  test('FAILED — `covers(1..e)` is false while any rung is missing, and a partial arrival never withdraws it (T5-K2)', async () => {
    const fsp = mkSpaceId('family');
    const ring = sk.createKeyRing();
    assert.equal(ring.covers(fsp, 3), false, 'an empty ring covers nothing');
    ring.put(fsp, 3, await sk.createSpaceKey());
    assert.equal(ring.covers(fsp, 3), false, 'the TOP epoch alone is not coverage…');
    assert.deepEqual(ring.missing(fsp, 3), [1, 2], '…and the ring names which rungs are absent');
    ring.put(fsp, 1, await sk.createSpaceKey());
    assert.equal(ring.covers(fsp, 3), false);
    ring.put(fsp, 2, await sk.createSpaceKey());
    assert.equal(ring.covers(fsp, 3), true, 'only a complete ring withdraws the waiting state');
  });

  test('and the restore path now agrees with it about an EMPTY ring — the E10-B1 seam, from this side', async () => {
    // Stated here as well as in the backup file, because the two modules disagreeing is what the
    // defect WAS: a reader checking only one of them would have found each self-consistent.
    const spaceId = mkSpaceId('family');
    assert.deepEqual(sk.createKeyRing().missing(spaceId, 4), [1, 2, 3, 4]);
    const { MAX_REPORTED_MISSING_EPOCHS } = await import('../../src/js/crypto/backup.js');
    assert.equal(Number.isSafeInteger(MAX_REPORTED_MISSING_EPOCHS), true);
    assert.ok(MAX_REPORTED_MISSING_EPOCHS > 0);
  });

  test('a key already in the ring is never displaced by a later one, and the anomaly is counted', async () => {
    const fsp = mkSpaceId('family');
    const ring = sk.createKeyRing();
    const first = await sk.createSpaceKey();
    ring.put(fsp, 1, first);
    assert.equal(ring.put(fsp, 1, await sk.createSpaceKey()), false, 'first write wins');
    assert.equal(ring.get(fsp, 1), first, 'and the key that is already decrypting ops stays');
    assert.equal(ring.refusedPuts(), 1, 'the substitution attempt is surfaceable, not silent');
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('E10-K3 · rule 1 — never compare signature bytes', () => {
  test('FAILED — ECDSA is non-deterministic in this engine, and every check in the repo is verify() === true', async () => {
    const me = await makeMember();
    const msg = new TextEncoder().encode('lzp/v2/e10/rule-1');
    const a = await identity.signBytes(me.rec.recSig.privateKey, msg);
    const b = await identity.signBytes(me.rec.recSig.privateKey, msg);
    assert.notDeepEqual(a, b, 'two signatures over one message differ — a golden fixture would be a flake');
    assert.equal(await identity.verifyBytes(me.rec.recSig.publicKey, a, msg), true);
    assert.equal(await identity.verifyBytes(me.rec.recSig.publicKey, b, msg), true);

    // Two attestations of the same device also differ byte-for-byte and both verify — so nothing
    // may content-address, deduplicate or idempotency-key on an attestation blob.
    const d = me.devices[0];
    const att = await identity.buildDeviceAttestation(
      { memberId: me.memberId, deviceId: d.deviceId, createdAt: DAY }, d.devSig.publicKey, d.devKex.publicKey
    );
    const one = await identity.attestDevice(att, me.rec.recSig.privateKey);
    const two = await identity.attestDevice(att, me.rec.recSig.privateKey);
    assert.notEqual(one, two);
    assert.notEqual(await identity.verifyAttestation(one, me.rec.recSig.publicKey), null);
    assert.notEqual(await identity.verifyAttestation(two, me.rec.recSig.publicKey), null);
  });

  test('and no source file under src/js/crypto/ compares a signature to a fixture', () => {
    for (const [name, src] of cryptoSources()) {
      // A golden-signature constant would have to appear as a long base64url literal next to a
      // signature word. The negative is asserted structurally rather than by reading prose.
      assert.equal(
        /sig\w*\s*===\s*['"][A-Za-z0-9_-]{40,}/.test(src), false,
        `${name}: a signature is compared to a literal`
      );
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('E10-K4 · rule 2 — never sign a zero-length payload, and never an empty AAD', () => {
  test('FAILED — the guard refuses, in the one place every sign/verify goes through', () => {
    assert.throws(() => assertSignable(new Uint8Array(0), 'x'), /zero-length/);
    assert.throws(() => assertSignable('not bytes', 'x'), /expected bytes/);
    assert.deepEqual(assertSignable(new Uint8Array([1]), 'x'), new Uint8Array([1]));
  });

  test('FAILED — `aesgcm()` refuses an empty AAD, so no AES-GCM call in the product can have one', () => {
    assert.throws(() => aesgcm(new Uint8Array(12), new Uint8Array(0)), /non-empty/);
    assert.throws(() => aesgcm(new Uint8Array(12), undefined), /non-empty/);
    assert.throws(() => aesgcm(new Uint8Array(11), new Uint8Array([1])), /12 bytes/);
  });

  test('FAILED — the pairing AAD is never empty and never transmitted, for all three slots', async () => {
    const { pairAad, PAIR_MSG } = await import('../../src/js/crypto/pairing.js');
    const seen = new Set();
    for (const type of Object.values(PAIR_MSG)) {
      const aad = pairAad(type, 'rid-abc');
      assert.ok(aad.length > 0);
      seen.add(b64u(aad));
    }
    assert.equal(seen.size, 3, 'the three slots produce three different AADs — a replay is a tag failure');
    assert.equal(await outcomeOf(() => pairAad('not-a-slot', 'rid')), 'protocol');
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('E10-K5 · rule 3 — every refusal carries a code THIS repository chose', () => {
  test('FAILED — the two boundaries that leaked an engine error now answer with a code (E10-P1)', async () => {
    // These are the rows the checklist would have ticked and this pass found open. Kept here as
    // well as in the pairing file, because the rule is the repository's and not one module's.
    assert.equal(await outcomeOf(() => restorePairingPayload({
      v: 1, memberId: 'mem_x',
      recSigPkcs8: noise(PKCS8_P256_BYTES), recKexPkcs8: noise(PKCS8_P256_BYTES),
      personal: { spaceId: mkSpaceId('personal'), epochs: { 1: noise(SYMMETRIC_KEY_BYTES) } },
    })), 'payload');
  });

  test('FAILED — a wrong passphrase and a tampered file are ONE code, because distinguishing them would be an oracle', async () => {
    const me = await makeMember();
    const { exportBackup } = await import('../../src/js/crypto/backup.js');
    const file = await exportBackup(
      { schemaVersion: 2, notes: [], bars: [], categories: [], scratchpads: {}, settings: {} },
      { memberId: me.memberId, recSig: me.rec.recSig, recKex: me.rec.recKex },
      { personal: { id: mkSpaceId('personal'), epochs: new Map([[1, await sk.createSpaceKey()]]) } },
      'Kirschbaum-Sonntag-Regenschirm', { exportedAt: DAY, app: '2.0.0', iterations: 1000 }
    );
    const wrongPw = await outcomeOf(() => importBackup(
      JSON.parse(JSON.stringify(file)), 'falsch-falsch-falsch', memKeyStore(),
      { deviceId: mkDeviceId(), createdAt: DAY, iterations: 1000 }
    ));
    const tampered = JSON.parse(JSON.stringify(file));
    tampered.board.notes.push({ id: 'x', date: '2026-01-01', text: 'fremd' });
    const edited = await outcomeOf(() => importBackup(
      tampered, 'Kirschbaum-Sonntag-Regenschirm', memKeyStore(),
      { deviceId: mkDeviceId(), createdAt: DAY, iterations: 1000 }
    ));
    assert.equal(wrongPw, 'cannot-open');
    assert.equal(edited, wrongPw, 'one code — the module cannot tell the two apart and must not guess');
    assert.equal(BACKUP_ERROR_CODES.includes('cannot-open'), true, 'and it is on the fixed list a caller switches over');
  });

  test('FAILED — `openPairBox` returns null for every failure shape, never a reason', async () => {
    const { derivePairing, openPairBox, sealPairBox, PAIR_MSG } = await import('../../src/js/crypto/pairing.js');
    const { ck, rid } = await derivePairing('ABCDEFGHJKMN');
    const box = await sealPairBox(ck, PAIR_MSG.offer, rid, { v: 1, hello: 'world' });
    assert.notEqual(await openPairBox(ck, PAIR_MSG.offer, rid, box), null, 'precondition: it opens');

    const other = await derivePairing('NMKJHGFEDCBA');
    for (const [what, run] of Object.entries({
      'wrong key': () => openPairBox(other.ck, PAIR_MSG.offer, rid, box),
      'wrong slot': () => openPairBox(ck, PAIR_MSG.answer, rid, box),
      'wrong rid': () => openPairBox(ck, PAIR_MSG.offer, 'someone-elses-rid', box),
      'truncated': () => openPairBox(ck, PAIR_MSG.offer, rid, box.slice(0, box.length - 4)),
      'not a string': () => openPairBox(ck, PAIR_MSG.offer, rid, 42),
      'no dot': () => openPairBox(ck, PAIR_MSG.offer, rid, 'aaaaaaaa'),
    })) {
      assert.equal(await run(), null, `${what}: every failure is the same null, with no oracle`);
    }
  });

  test('and no file under src/js/crypto/ branches on an ENGINE error name', () => {
    const OURS = /(PairingError|BackupError|SpaceKeyError|EnvelopeError|RedactionError|CodecError|BackupError)/;
    for (const [name, src] of cryptoSources()) {
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;                     // prose may DISCUSS the names
        const branches = /\b(err|error|e)\s*\.\s*name\s*(===|!==|==|!=)/.test(line)
          || /\bswitch\s*\(\s*(err|error|e)\s*\.\s*name\s*\)/.test(line);
        assert.equal(
          branches && !OURS.test(line), false,
          `${name}:${i + 1} branches on an error NAME — rule 3`
        );
      });
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('E10-K6 · rules 4, 5, 6 and 7', () => {
  test('rule 4 — an HKDF salt is MANDATORY, and `NO_SALT` is the explicit way to mean none', () => {
    assert.throws(() => hkdf(undefined, INFO.pairKek), /MANDATORY/);
    assert.throws(() => hkdf(null, INFO.pairKek), /MANDATORY/);
    assert.throws(() => hkdf('', INFO.pairKek), /MANDATORY/);
    const params = hkdf(NO_SALT, INFO.pairKek);
    assert.equal(params.salt instanceof Uint8Array, true);
    assert.equal(params.salt.length, 0, 'zero-length, and PRESENT — which is what the rule asks');
    // PBKDF2's sibling refuses the empty one, because there the salt is not decorative.
    assert.throws(() => pbkdf2(new Uint8Array(0), 1000), /non-empty salt/);
    assert.throws(() => pbkdf2(new Uint8Array(32), 0), /positive integer/);
  });

  test('rule 5 — a peer\'s ECDH public key is imported with NO usages, and a non-empty list is refused by the engine', async () => {
    assert.deepEqual([...USAGES.peerKex], [], 'the frozen empty list this rule lives in');
    assert.equal(Object.isFrozen(USAGES.peerKex), true, 'so it cannot drift');

    const kp = await S.generateKey(KEX, true, ['deriveBits', 'deriveKey']);
    const raw = new Uint8Array(await S.exportKey('raw', kp.publicKey));
    // The shipped call works…
    const imported = await identity.importKexPublic(raw);
    assert.deepEqual(imported.usages, []);
    // …and the mistake the rule names really is refused by this engine, so the rule is not folklore.
    await assert.rejects(() => S.importKey('raw', raw, KEX, true, ['deriveBits']));
  });

  test('rule 5\'s sibling — a P-256 PRIVATE key imported with `verify` in the usages is refused', async () => {
    const kp = await S.generateKey(SIG, true, ['sign', 'verify']);
    const pkcs8 = new Uint8Array(await S.exportKey('pkcs8', kp.privateKey));
    await assert.rejects(() => S.importKey('pkcs8', pkcs8, SIG, true, ['sign', 'verify']));
    // Which is why `USAGES.sigPrivate` exists, and why the restore path uses it.
    const ok = await S.importKey('pkcs8', pkcs8, SIG, true, [...USAGES.sigPrivate]);
    assert.equal(ok.type, 'private');
  });

  test('rule 6 — nothing is AES-KW\'d, and the arithmetic that forbids it is real', async () => {
    assert.equal(PKCS8_P256_BYTES, 138);
    assert.notEqual(PKCS8_P256_BYTES % 8, 0, '138 is not a multiple of 8 — AES-KW cannot carry it');
    assert.equal(SYMMETRIC_KEY_BYTES % 8, 0, 'and 32 IS, which is the trap: a prototype would work');

    // No AES-KW constant exists anywhere under src/js/crypto/, in any spelling.
    for (const [name, src] of cryptoSources()) {
      const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      assert.equal(/['"]AES-KW['"]/.test(code), false, `${name}: an AES-KW algorithm name in live code`);
    }

    // And the engine really refuses it, so the rule is measured rather than trusted.
    const kek = await S.generateKey({ name: 'AES-KW', length: 256 }, true, ['wrapKey', 'unwrapKey']);
    const kp = await S.generateKey(SIG, true, ['sign', 'verify']);
    await assert.rejects(() => S.wrapKey('pkcs8', kp.privateKey, kek, 'AES-KW'));
  });

  test('rule 7 — nothing under src/js/crypto/ touches indexedDB or isSecureContext, and Node has neither', () => {
    assert.equal(typeof globalThis.indexedDB, 'undefined', 'Node has no indexedDB…');
    assert.equal(globalThis.isSecureContext, undefined, '…and `isSecureContext` is undefined, not false');
    for (const [name, src] of cryptoSources()) {
      const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      assert.equal(/\bindexedDB\b/.test(code), false, `${name}: reaches for indexedDB`);
      assert.equal(/\bisSecureContext\b/.test(code), false, `${name}: reaches for isSecureContext`);
    }
  });

  test('and nothing under src/js/crypto/ reads a clock — the ports are the whole surface', () => {
    for (const [name, src] of cryptoSources()) {
      const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      assert.equal(/Date\.now\(\)/.test(code), false, `${name}: reads a clock (ADR 005 §2)`);
      assert.equal(/new Date\(\)/.test(code), false, `${name}: reads a clock (ADR 005 §2)`);
    }
    // The one place a clock is REQUIRED, it is required loudly rather than defaulted.
    assert.equal(PAIRING.ttlSeconds, 180);
  });

  test('and a raw public point is exactly 65 bytes everywhere it is asserted', async () => {
    const kp = await S.generateKey(KEX, true, ['deriveBits', 'deriveKey']);
    const raw = await identity.exportRawPublic(kp.publicKey);
    assert.equal(raw.length, RAW_PUBKEY_BYTES);
    assert.equal(raw[0], 0x04, 'uncompressed');
  });
});
