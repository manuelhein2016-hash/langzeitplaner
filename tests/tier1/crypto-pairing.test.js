// TIER 1 · LZP-306 — device pairing.  ADR 002 §6 · story 19.5 · docs/v2/contracts/crypto.contract.js §5.
//
// THIS FILE IS WRITTEN AGAINST THE ATTACKER, NOT AGAINST THE FEATURE.
// There is exactly one happy-path test below (§6) and it earns its place by proving story 19.4 —
// that the second Mac can actually read the first one's PRIVATE entries afterwards. Everything
// else is an adversary: a relay that knows the code, a relay that does not, a replayer, a
// downgrader, a guesser, and a clock. Pairing is the module where a bug is silent and permanent:
// a MITM who gets through does not break anything the user can see, they simply become one of my
// devices forever, and there is no revocation to take it back (§2.3, §8.2a).
//
// THE ONE ASSERTION THAT MATTERS MOST is in §7: the SAS comparison is load-bearing. It is proved
// twice — once by showing that an honest human refuses a MITM, and once by showing that a client
// which auto-confirms hands the attacker the recovery key and the whole key ring. The second test
// exists so that nobody can ever call `confirmSasMatch` a formality; it prints, in assertions,
// exactly what removing it costs.
//
// NO SIGNATURE BYTES ARE COMPARED ANYWHERE (rule 1). Pairing signs nothing; the one signature in
// this file is the step-8 self-attestation, and it is checked with `verifyAttestation() !== null`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { b64u, ub64, crock32, uncrock32, CROCKFORD_ALPHABET, CodecError } from '../../src/js/core/b64.js';
import { canonicalBytes, utf8Decode } from '../../src/js/core/canon.js';
import { memberId as mkMemberId, deviceId as mkDeviceId, spaceId as mkSpaceId, isDeviceShort } from '../../src/js/core/ids.js';
import { INFO, AEAD, PAD_BUCKET, RAW_PUBKEY_BYTES, PKCS8_P256_BYTES, SYMMETRIC_KEY_BYTES } from '../../src/js/crypto/suite.js';
import * as identity from '../../src/js/crypto/identity.js';
import { memKeyStore } from '../../src/js/platform/keystore.js';
import { pathToPrefix, reachableFrom } from '../helpers/importgraph.js';
import { createKeyRing } from '../../src/js/crypto/spacekeys.js';
import { pad as envelopePad, unpad as envelopeUnpad } from '../../src/js/crypto/envelope.js';

import {
  PAIRING, PAIR_V, PAIR_MSG, PAIR_STATE, PAIR_AAD_TAG, PairingError,
  generatePairingCode, formatPairingCode, normalizePairingCode, derivePairing,
  pairAad, sealPairBox, openPairBox, sasFromBytes, computeSas,
  buildPairingPayload, restorePairingPayload, spacesFromKeyRing,
  createPairingSession, adoptPairedDevice,
} from '../../src/js/crypto/pairing.js';

import {
  honestRelay, activeMitm, blindMitm, replayRelay, downgradeRelay,
  drivePairing, bruteForceBudget, attackerDerive, attackerOpen, attackerGuessCode,
  attackerNormalize, ATTACKER_LABELS,
} from '../helpers/mitm.js';

const S = globalThis.crypto.subtle;
const DAY = '2026-08-27';

/** A clock we control. Nothing under src/js/crypto/ may read one, so every session gets this. */
function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, at: () => t };
}

async function aesKey() {
  return S.generateKey({ name: AEAD.name, length: AEAD.length }, true, ['encrypt', 'decrypt']);
}

/** A member with a recovery identity, one paired Mac, and a personal key ring of `epochs` keys. */
async function existingMember(epochs = 2) {
  const PSP = mkSpaceId('personal');
  const ks = memKeyStore();
  const memberId = mkMemberId();
  const rec = await identity.ensureRecoveryIdentity(ks, memberId, { createdAt: DAY });
  const dev = await identity.ensureDeviceIdentity(ks, memberId, { deviceId: mkDeviceId(), createdAt: DAY });
  const personal = new Map();
  for (let e = 1; e <= epochs; e++) personal.set(e, await aesKey());
  return {
    ks,
    memberId,
    identity: { ...dev, recSig: rec.recSig, recKex: rec.recKex },
    rec,
    personalSpaceId: PSP,
    keyring: { personal: { spaceId: PSP, epochs: personal }, family: null },
  };
}

function sessions(m, ports) {
  return {
    A: createPairingSession(m.identity, m.keyring, ports),
    B: createPairingSession(null, null, ports),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. The numbers ADR 002 §6.2 fixes, in code
// ═════════════════════════════════════════════════════════════════════════════

test('§6.2s parameters are exported as values, not left as prose', () => {
  assert.equal(PAIRING.codeChars, 12);
  assert.equal(PAIRING.codeBits, 60);
  assert.equal(PAIRING.ttlSeconds, 180);
  assert.equal(PAIRING.ttlMs, 180_000);
  assert.equal(PAIRING.maxFailedOpens, 5);
  assert.equal(PAIRING.sasDigits, 6);
  assert.equal(PAIRING.sasBytes, 4);
  assert.equal(PAIRING.singleUse, true);
  // 12 characters of a 32-symbol alphabet IS 60 bits. If someone shortens the code, this fails
  // before §6.4's whole security argument quietly becomes false.
  assert.equal(PAIRING.codeChars * Math.log2(CROCKFORD_ALPHABET.length), PAIRING.codeBits);
  assert.equal(CROCKFORD_ALPHABET.length, 32);
});

test('BOTH ADRs rate limits are carried, because they count different things', () => {
  // ADR 002 §6.2: 5 failed decrypts per rid; 20 pair/get per IP per hour.
  assert.equal(PAIRING.maxFailedOpens, 5);
  assert.equal(PAIRING.relayGetPerIpPerHour, 20);
  // ADR 003 §6.1: 10 pair sessions per member per hour; 5 failed rid lookups per IP per MINUTE.
  assert.equal(PAIRING.sessionsPerMemberPerHour, 10);
  assert.equal(PAIRING.failedRidLookupsPerIpPerMinute, 5);
  // They are not the same limiter and a reader who saw only one would build the wrong one.
  assert.notEqual(PAIRING.relayGetPerIpPerHour, PAIRING.failedRidLookupsPerIpPerMinute * 60);
});

test('the HKDF labels this protocol uses are §3s four fixed strings and nothing else', () => {
  assert.equal(INFO.pairRid, 'lzp/v2/pair/rid');
  assert.equal(INFO.pairCk, 'lzp/v2/pair/ck');
  assert.equal(INFO.pairSas, 'lzp/v2/pair/sas');
  assert.equal(INFO.pairKek, 'lzp/v2/pair/kek');
  // The adversary in tests/helpers/mitm.js writes them out independently. If the two ever
  // disagree, the attacker stops being able to attack and half this file goes green for the
  // wrong reason — so they are pinned equal here, deliberately, at the seam.
  assert.deepEqual(
    { rid: INFO.pairRid, ck: INFO.pairCk, sas: INFO.pairSas, kek: INFO.pairKek },
    { ...ATTACKER_LABELS }
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. The code — 60 bits, and the four-bit trap
// ═════════════════════════════════════════════════════════════════════════════

test('a pairing code is 12 Crockford characters, uniform, and displayed XXXX-XXXX-XXXX', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const c = generatePairingCode();
    assert.equal(c.length, 12);
    for (const ch of c) assert.ok(CROCKFORD_ALPHABET.includes(ch), `${ch} is not Crockford`);
    seen.add(c);
  }
  assert.equal(seen.size, 500, '500 codes collided — the generator is not random');
  assert.match(formatPairingCode('0123456789AB'), /^\w{4}-\w{4}-\w{4}$/);
  assert.equal(formatPairingCode('0123456789AB'), '0123-4567-89AB');
});

test('every character of the alphabet is reachable — no silently narrowed code space', () => {
  // `b & 31` over a uniform byte is exactly uniform, so all 32 symbols must appear. A generator
  // that quietly used, say, 16 symbols would halve the entropy and still look random.
  const hist = new Map();
  let bump = 0;
  const random = () => Uint8Array.from({ length: 12 }, () => (bump++) & 255);
  for (let i = 0; i < 40; i++) for (const ch of generatePairingCode(random)) hist.set(ch, (hist.get(ch) ?? 0) + 1);
  assert.equal(hist.size, 32, `only ${hist.size} of 32 symbols are reachable`);
});

test('normalisation folds what a human types, and refuses what Crockford reserves', () => {
  const canonical = normalizePairingCode('0123456789AB');
  assert.equal(normalizePairingCode('0123-4567-89ab'), canonical);
  assert.equal(normalizePairingCode(' 0123 4567 89AB '), canonical);
  assert.equal(normalizePairingCode('0123 4567 89AB'), canonical, 'option-space on a Mac');
  // I/i/L/l -> 1 and O/o -> 0, because those are the characters Crockford excludes precisely
  // because humans confuse them with digits.
  assert.equal(normalizePairingCode('IL0oO1234567'), normalizePairingCode('110001234567'));
  // U is RESERVED, not a typo. Guessing at it would derive a different rid and present as
  // "the code is wrong" on a code the user typed correctly.
  assert.throws(() => normalizePairingCode('U12345678901'), (e) => e.code === 'code_invalid');
  for (const bad of ['', '0123', '0123456789ABC', 123, null, {}, '01234567890!']) {
    assert.throws(() => normalizePairingCode(bad), (e) => e instanceof PairingError);
  }
});

test('THE FOUR-BIT TRAP: the code is NOT decoded before derivation, and here is why', () => {
  // uncrock32 of a 12-character code yields floor(12*5/8) = 7 bytes = 56 bits, and rejects any
  // code whose four spare bits are non-zero. Deriving `rid` from decoded bytes would therefore
  // throw away four bits of the sixty §6.4 prices the whole protocol on — or throw outright.
  let rejected = 0;
  let widths = new Set();
  for (let i = 0; i < 200; i++) {
    try {
      widths.add(uncrock32(generatePairingCode()).length);
    } catch (err) {
      assert.ok(err instanceof CodecError);
      rejected += 1;
    }
  }
  assert.ok(rejected > 150, `only ${rejected}/200 codes would even decode — decoding is not an option`);
  for (const w of widths) assert.equal(w, 7, 'a decoded code is 56 bits, not 60');
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. rid and ck
// ═════════════════════════════════════════════════════════════════════════════

test('rid is 16 bytes derived from the WHOLE code, so the offline work factor is 2^60', async () => {
  const code = generatePairingCode();
  const { rid, ck } = await derivePairing(code);
  assert.equal(ub64(rid).length, 16);
  assert.equal(ck.algorithm.name, AEAD.name);
  assert.equal(ck.algorithm.length, 256);
  assert.equal(ck.extractable, false);

  // Every single character position must matter. A rid derived from a prefix would cost 2^40.
  for (let i = 0; i < PAIRING.codeChars; i++) {
    const alt = code.slice(0, i) + (code[i] === '0' ? '1' : '0') + code.slice(i + 1);
    const other = await derivePairing(alt);
    assert.notEqual(other.rid, rid, `character ${i} does not affect rid`);
  }
});

test('rid does not leak the code, and the display form derives the same rid as the raw one', async () => {
  const code = generatePairingCode();
  const a = await derivePairing(code);
  const b = await derivePairing(formatPairingCode(code));
  const c = await derivePairing(code.toLowerCase());
  assert.equal(a.rid, b.rid);
  assert.equal(a.rid, c.rid);
  assert.equal(a.rid.includes(code), false);
  assert.equal(b64u(new TextEncoder().encode(code)), b64u(new TextEncoder().encode(code)));
  assert.notEqual(a.rid, b64u(new TextEncoder().encode(code)));
});

/**
 * CROSS-ENGINE VECTORS. Asserted here and, byte for byte, in
 * `tests/tier2/crypto-pairing.dom.js` inside the real WKWebView.
 *
 * These are the only fixtures in this file, and they are legitimate ones: HKDF is deterministic,
 * so a `rid` and a SAS are functions of their inputs in a way a signature is not (rule 1). If
 * Node and WebKit ever disagreed about one of them, a Mac would derive a rendezvous its own
 * second Mac could not find, or two screens would show different digits with no attacker
 * present — and the failure would look exactly like a MITM.
 */
export const PAIRING_VECTORS = Object.freeze({
  rid: Object.freeze([
    ['ABCDEFGHJKMN', 'h1S6avvkKU_1V9DJV6Fv4w'],
    ['00000000000Z', '5PkqkyauZBFPiC-G60V3Xg'],
    ['ZZZZZZZZZZZZ', 'sGw_n7h8hoTQoQrsOQmPYQ'],
  ]),
  /** shared secret = bytes 0..31; A_eph = 0x04 then 64 x 0xA1; B_eph = 0x04 then 64 x 0xB2. */
  sas: '550092',
  sasRolesSwapped: '966447',
});

test('CROSS-ENGINE VECTORS: rid and the SAS are pinned, and tier 2 asserts the same numbers', async () => {
  for (const [code, rid] of PAIRING_VECTORS.rid) {
    assert.equal((await derivePairing(code)).rid, rid, `rid drifted for ${code}`);
  }
  const shared = Uint8Array.from({ length: 32 }, (_, i) => i);
  const a = Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : 0xa1));
  const b = Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : 0xb2));
  assert.equal(await computeSas(shared, a, b), PAIRING_VECTORS.sas);
  assert.equal(await computeSas(shared, b, a), PAIRING_VECTORS.sasRolesSwapped);
});

test('the independent attacker derives the same rid — the wire format is the wire format', async () => {
  const code = generatePairingCode();
  const mine = await derivePairing(code);
  const theirs = await attackerDerive(code);
  assert.equal(mine.rid, theirs.rid, 'the module and an independent implementation disagree about rid');
  assert.equal(attackerNormalize(formatPairingCode(code)), normalizePairingCode(code));
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. The boxes — the AAD is the protocol's structure
// ═════════════════════════════════════════════════════════════════════════════

test('the padding is LZP-304s padding, not a second spelling of it', async () => {
  // Two implementations of one wire construction is how a wire construction stops being one, so
  // `pairing.js` imports `pad`/`unpad` from `envelope.js`. Proving the box really goes through
  // them means a future divergence cannot be silent — and it inherits `unpad`'s refusal of a
  // non-zero trailing byte, which closes a covert channel the party choosing this plaintext
  // would otherwise own.
  const k = await aesKey();
  const box = await sealPairBox(k, PAIR_MSG.offer, 'R', { hello: 'world' });
  const ct = ub64(box.slice(box.indexOf('.') + 1));
  assert.equal((ct.length - 16) % PAD_BUCKET, 0, 'the ciphertext is not a whole number of buckets');
  const roundTrip = envelopeUnpad(envelopePad(canonicalBytes({ hello: 'world' })));
  assert.deepEqual(roundTrip, canonicalBytes({ hello: 'world' }));
  // A stuffed pad is refused rather than ignored.
  const stuffed = envelopePad(canonicalBytes({ hello: 'world' }));
  stuffed[stuffed.length - 1] = 0x42;
  assert.throws(() => envelopeUnpad(stuffed));
});

test('the AAD binds the domain, the version, the SLOT and the rid, and is never empty', () => {
  const aad = pairAad(PAIR_MSG.offer, 'RID');
  assert.ok(aad.length > 0, 'suite.aesgcm() refuses an empty AAD (§5.1)');
  assert.equal(utf8Decode(aad), JSON.stringify([PAIR_AAD_TAG, PAIR_V, 'offer', 'RID']));
  assert.notDeepEqual(pairAad(PAIR_MSG.offer, 'RID'), pairAad(PAIR_MSG.answer, 'RID'));
  assert.notDeepEqual(pairAad(PAIR_MSG.offer, 'RID'), pairAad(PAIR_MSG.offer, 'RID2'));
  assert.throws(() => pairAad('op', 'RID'), (e) => e.code === 'protocol');
  assert.throws(() => pairAad(PAIR_MSG.offer, ''), (e) => e.code === 'protocol');
});

test('a box round-trips, is padded to a 256-byte bucket, and hides its own contents length', async () => {
  const k = await aesKey();
  const small = await sealPairBox(k, PAIR_MSG.offer, 'R', { a: 1 });
  const big = await sealPairBox(k, PAIR_MSG.offer, 'R', { a: 1, b: 'x'.repeat(40) });
  const ctLen = (box) => ub64(box.slice(box.indexOf('.') + 1)).length;
  assert.equal(ctLen(small), PAD_BUCKET + 16, 'one bucket plus the GCM tag');
  assert.equal(ctLen(small), ctLen(big), 'two different payloads must not have two different sizes');
  assert.deepEqual(await openPairBox(k, PAIR_MSG.offer, 'R', small), { a: 1 });
});

test('every way a box can fail produces the SAME outcome: null, never a reason (rule 3)', async () => {
  const k = await aesKey();
  const other = await aesKey();
  const good = await sealPairBox(k, PAIR_MSG.offer, 'R', { a: 1 });
  const dot = good.indexOf('.');
  const ct = ub64(good.slice(dot + 1));
  ct[0] ^= 1;
  const tampered = `${good.slice(0, dot)}.${b64u(ct)}`;

  const outcomes = [
    await openPairBox(other, PAIR_MSG.offer, 'R', good),      // wrong code
    await openPairBox(k, PAIR_MSG.answer, 'R', good),         // wrong SLOT
    await openPairBox(k, PAIR_MSG.offer, 'R2', good),         // wrong rendezvous
    await openPairBox(k, PAIR_MSG.offer, 'R', tampered),      // tampered ciphertext
    await openPairBox(k, PAIR_MSG.offer, 'R', 'nonsense'),    // malformed
    await openPairBox(k, PAIR_MSG.offer, 'R', `${good}x`),    // truncated/extended
    await openPairBox(k, PAIR_MSG.offer, 'R', 42),            // not even a string
  ];
  assert.deepEqual(outcomes, [null, null, null, null, null, null, null]);
  // Telling a caller `your code was right but the relay changed the box` apart from `wrong code`
  // would be an oracle. The caller cannot act on the difference; the attacker very much can.
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. The SAS
// ═════════════════════════════════════════════════════════════════════════════

test('the SAS is exactly six decimal digits, big-endian, mod 10^6, zero-padded', () => {
  assert.equal(sasFromBytes(Uint8Array.from([0, 0, 0, 0])), '000000');
  assert.equal(sasFromBytes(Uint8Array.from([0, 0, 0, 1])), '000001');
  assert.equal(sasFromBytes(Uint8Array.from([0x00, 0x0f, 0x42, 0x3f])), '999999');
  assert.equal(sasFromBytes(Uint8Array.from([0x00, 0x0f, 0x42, 0x40])), '000000', 'wraps at 10^6');
  assert.equal(sasFromBytes(Uint8Array.from([0xff, 0xff, 0xff, 0xff])), '967295');
  for (const bad of [Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 3, 4, 5]), 'x']) {
    assert.throws(() => sasFromBytes(bad), (e) => e instanceof PairingError);
  }
});

test('the modulo bias is the documented one and does not move §6.4s 10^-6', () => {
  // 2^32 = 4294 * 10^6 + 967296. The first 967296 values occur once more often than the rest.
  const q = Math.floor(2 ** 32 / 1e6);
  const r = 2 ** 32 - q * 1e6;
  assert.equal(q, 4294);
  assert.equal(r, 967296);
  // The most likely single SAS value occurs (q+1) times out of 2^32; the least likely, q times.
  const best = (q + 1) / 2 ** 32;
  const worst = q / 2 ** 32;
  assert.ok(best > 1e-6 && best < 1.0000077e-6, `best guess ${best}`);
  assert.ok(worst < 1e-6 && worst > 0.99977e-6, `worst guess ${worst}`);
  // §6.4 prices the attacker at 10^-6. The whole spread is 1/q — one part in 4294, i.e. 2.3e-4 —
  // and the attacker only gets the FAVOURABLE end of it, which is 7.7 parts per million above
  // uniform. Neither is a security-relevant difference, and saying so numerically is cheaper
  // than arguing about it later.
  assert.ok(best / 1e-6 < 1.00001, 'the attackers side of the bias must stay negligible');
  assert.ok((best - worst) / worst < 2.34e-4, 'the whole spread is one part in 4294');
});

test('the SAS is ordered by ROLE and is a function of the whole transcript', async () => {
  const a = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const b = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const aRaw = new Uint8Array(await S.exportKey('raw', a.publicKey));
  const bRaw = new Uint8Array(await S.exportKey('raw', b.publicKey));
  const pub = await S.importKey('raw', bRaw, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const shared = new Uint8Array(await S.deriveBits({ name: 'ECDH', public: pub }, a.privateKey, 256));

  const sas = await computeSas(shared, aRaw, bRaw);
  assert.match(sas, /^\d{6}$/);
  assert.equal(await computeSas(shared, aRaw, bRaw), sas, 'deterministic');
  // Swapping the roles must change the digits. Sorting the two points instead would make the SAS
  // blind to which side sent which — a small hole, but a free one to close.
  assert.notEqual(await computeSas(shared, bRaw, aRaw), sas);
  // And the secret is not the only input: changing a transcript element changes the digits.
  const flipped = Uint8Array.from(shared);
  flipped[0] ^= 1;
  assert.notEqual(await computeSas(flipped, aRaw, bRaw), sas);
  // `computeSas` is async, so a bad point is a REJECTION, not a throw. Asserting the wrong one
  // leaves an unhandled rejection behind and quietly passes.
  await assert.rejects(() => computeSas(shared, aRaw.subarray(0, 64), bRaw), (e) => e.code === 'protocol');
  await assert.rejects(() => computeSas(shared, aRaw, 'not bytes'), (e) => e.code === 'protocol');
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. The one happy path — and it must end with story 19.4 satisfied
// ═════════════════════════════════════════════════════════════════════════════

test('a full pairing over an honest relay ends with the new Mac reading my PRIVATE entries', async () => {
  const c = clock();
  const m = await existingMember(3);
  const { A, B } = sessions(m, c);
  const relay = honestRelay({ now: c.now });

  const run = await drivePairing({ A, B, transport: relay });
  assert.equal(run.error, null, run.error?.message);
  assert.equal(run.sasA, run.sasB, 'both screens show the same six digits');
  assert.match(run.sasA, /^\d{6}$/);
  assert.equal(run.stateA, PAIR_STATE.delivered);
  assert.equal(run.stateB, PAIR_STATE.received);

  // Story 19.4, literally: encrypt a private entry on the first Mac under PSK epoch 1 — the
  // oldest key, the one a partial ring would have dropped — and open it on the second.
  const psk1 = m.keyring.personal.epochs.get(1);
  const iv = crypto.getRandomValues(new Uint8Array(AEAD.ivBytes));
  const aad = canonicalBytes(['lzp/v2/op', 1, m.personalSpaceId, 1]);
  const ct = await S.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, psk1,
    canonicalBytes({ note: 'Zahnarzt, 14:30 — privat' }));
  const opened = await S.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
    run.restored.personal.epochs.get(1), ct);
  assert.equal(JSON.parse(utf8Decode(new Uint8Array(opened))).note, 'Zahnarzt, 14:30 — privat');
  assert.deepEqual([...run.restored.personal.epochs.keys()], [1, 2, 3], 'every epoch, 1..e');
  assert.equal(run.restored.memberId, m.memberId);

  // The relay held nothing but ciphertext.
  const seen = JSON.stringify(relay.transcript());
  assert.equal(seen.includes(m.memberId), false, 'the relay learned the memberId');
  assert.equal(seen.includes(run.code), false, 'the relay learned the pairing code');
  assert.equal(seen.includes(run.sasA), false, 'the relay learned the SAS');
});

test('§6.3 step 8: the new Mac self-attests with the RESTORED recovery key, and that is its register', async () => {
  const c = clock();
  const m = await existingMember(2);
  const { A, B } = sessions(m, c);
  const run = await drivePairing({ A, B, transport: honestRelay({ now: c.now }) });
  assert.equal(run.error, null);

  const ksB = memKeyStore();
  const adopted = await adoptPairedDevice(ksB, run.restored, B.newDeviceKeys(), { createdAt: DAY });

  // It is a device of MY member, signed by MY recovery key — which is the whole point of
  // shipping RK_sig in the payload.
  const att = await identity.verifyAttestation(adopted.blob, m.rec.recSig.publicKey);
  assert.notEqual(att, null, 'the self-attestation does not verify under the member recovery key');
  assert.equal(att.memberId, m.memberId);
  assert.equal(att.deviceShort, adopted.identity.deviceShort);
  assert.ok(isDeviceShort(att.deviceShort));
  assert.equal(identity.attestationSelfConsistent(att), true, '§5.2.2 P2');
  assert.notEqual(att.deviceShort, m.identity.deviceShort, 'a device is a machine, not a person');

  // THE ANTI-DRIFT ASSERTION. `adoptPairedDevice` writes the three records `ensureDeviceIdentity`
  // reads. Running the real function over the store afterwards is what makes it impossible for
  // the two formats to diverge without a test going red.
  const re = await identity.ensureDeviceIdentity(ksB, m.memberId, {});
  assert.equal(re.deviceShort, adopted.identity.deviceShort, 'ensureDeviceIdentity did not ADOPT');
  assert.equal(re.deviceId, adopted.identity.deviceId);
  assert.equal(re.devSig.privateKey.extractable, false, 'a device key is never extractable');
  const rr = await identity.ensureRecoveryIdentity(ksB, m.memberId, {});
  assert.equal(rr.memberId, m.memberId);
  // And the restored recovery key really is the SAME key — it verifies the first Mac's own blob.
  const firstMacBlob = (await identity.ensureAttestedDevice(
    memKeyStore(), m.memberId, rr.recSig.privateKey, { deviceId: mkDeviceId(), createdAt: DAY }
  )).blob;
  assert.notEqual(await identity.verifyAttestation(firstMacBlob, m.rec.recSig.publicKey), null);
});

test('the keys the new Mac attests are the keys it put in box_B — not a second, fresher pair', async () => {
  // If step 8 minted again, the attested `kexPubRaw` would not be the one the first Mac wrapped
  // the rotated PSK to, and the second Mac would be silently unable to read anything new. This
  // is the bug a literal reading of §6.3 step 8 invites.
  const c = clock();
  const m = await existingMember();
  const { A, B } = sessions(m, c);
  const run = await drivePairing({ A, B, transport: honestRelay({ now: c.now }) });
  const minted = B.newDeviceKeys();
  const adopted = await adoptPairedDevice(memKeyStore(), run.restored, minted, { createdAt: DAY });

  assert.equal(adopted.attestation.deviceShort, minted.deviceShort);
  assert.equal(adopted.attestation.deviceId, minted.deviceId);
  // A's `obligations()` names the very device it must wrap the next epoch to.
  const ob = A.obligations();
  assert.equal(ob.wrapTo.deviceShort, minted.deviceShort);
  assert.equal(ob.wrapTo.kexPubRaw, adopted.attestation.kexPubRaw, 'A would wrap to a different key');
  assert.equal(ob.rotatePersonalSpaceTo, 3, '§6.3 step 9 — PSK rotates to e+1');
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. T4 — THE ACTIVE MITM. The section this module exists for.
// ═════════════════════════════════════════════════════════════════════════════

test('T4: a relay that SUBSTITUTES EPHEMERAL KEYS produces different digits on the two screens', async () => {
  const c = clock();
  const m = await existingMember(2);
  const { A, B } = sessions(m, c);

  // The attacker is handed the code for free — shoulder-surfed off the first Mac's screen. That
  // is the posture §6.4 assumes: the code is not the security parameter, the SAS is.
  let code = null;
  const mitm = activeMitm({ code: () => code, now: c.now });
  const run = await drivePairing({ A, B, transport: mitm, learnCode: (x) => { code = x; } });

  assert.equal(mitm.substituted(), true, 'the attacker did not actually attack');
  assert.notEqual(run.sasA, run.sasB, 'THE SAS DID NOT DIVERGE — the MITM defence is broken');
  assert.match(run.sasA, /^\d{6}$/);
  assert.match(run.sasB, /^\d{6}$/);
  // The attacker's own view agrees with each victim's, which is what makes this a real MITM and
  // not a broken transport.
  assert.equal(await mitm.sasSeenBy('A'), run.sasA);
  assert.equal(await mitm.sasSeenBy('B'), run.sasB);

  // FAILS CLOSED, on both ends, terminally.
  assert.equal(run.errorCode, 'refused');
  assert.equal(run.stateA, PAIR_STATE.refused);
  assert.equal(run.stateB, PAIR_STATE.refused);
  assert.equal(run.delivered, null, 'A sealed a key transfer despite the refusal');
  assert.equal(run.restored, null);
  assert.equal(await mitm.decryptDelivery(), null, 'the attacker obtained key material');
  assert.equal(mitm.transcript().deliveries.length, 0, 'a delivery reached the relay');
});

test('T4: a refused session is DEAD — no retry, no second chance, no delivery', async () => {
  const c = clock();
  const m = await existingMember();
  const { A, B } = sessions(m, c);
  let code = null;
  await drivePairing({ A, B, transport: activeMitm({ code: () => code, now: c.now }), learnCode: (x) => { code = x; } });

  // The human said no. Nothing may talk either side back into it.
  await assert.rejects(() => A.deliver(), (e) => e.code === 'refused');
  await assert.rejects(() => B.receive('anything'), (e) => e.code === 'refused');
  assert.throws(() => A.confirmSasMatch(true), (e) => e.code === 'refused');
  assert.throws(() => B.confirmSasMatch(true), (e) => e.code === 'refused');
  assert.equal(A.state(), PAIR_STATE.refused);
});

test('THE SAS IS LOAD-BEARING: a client that auto-confirms hands the attacker EVERYTHING', async () => {
  // ADR 002 §6.4's boxed warning, as an assertion. This is the test that makes it impossible to
  // describe `confirmSasMatch` as a formality: the same MITM, the same code, the same protocol —
  // the only difference is a client that treats "the boxes decrypted" as "the peer is my Mac".
  const c = clock();
  const m = await existingMember(2);
  const { A, B } = sessions(m, c);
  let code = null;
  const mitm = activeMitm({ code: () => code, now: c.now });

  const run = await drivePairing({
    A, B, transport: mitm, learnCode: (x) => { code = x; },
    humanCompares: () => true,           // ← "it decrypted, so it must be fine"
  });

  assert.notEqual(run.sasA, run.sasB, 'the digits still differed — nobody looked');
  assert.equal(run.stateB, PAIR_STATE.received, 'the pairing "succeeded"');

  const loot = await mitm.decryptDelivery();
  assert.notEqual(loot, null);
  assert.equal(loot.memberId, m.memberId);
  assert.equal(ub64(loot.recSigPkcs8).length, PKCS8_P256_BYTES, 'the attacker holds RK_sig');
  assert.equal(ub64(loot.recKexPkcs8).length, PKCS8_P256_BYTES, 'the attacker holds RK_kex');
  assert.deepEqual(Object.keys(loot.personal.epochs).sort(), ['1', '2'], 'every private-space key');
  // With RK_sig the attacker can mint attestations as this member — for its own devices, on any
  // machine, forever, and §2.3 has no revocation to take it back (§8.2a, §8.12).
  const attackerDev = await identity.generateDeviceKeys();
  const rk = await S.importKey('pkcs8', ub64(loot.recSigPkcs8), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const att = await identity.buildDeviceAttestation(
    { memberId: loot.memberId, deviceId: mkDeviceId(), createdAt: DAY },
    attackerDev.devSig.publicKey, attackerDev.devKex.publicKey
  );
  const forged = await identity.attestDevice(att, rk);
  assert.notEqual(await identity.verifyAttestation(forged, m.rec.recSig.publicKey), null,
    'this is what "auto-confirm on successful decryption" costs');
});

test('T4 without the code: a blind relay cannot substitute a key at all, only corrupt', async () => {
  // §6.4's "passive relay … safe". The ephemeral public keys live INSIDE the ck-sealed boxes, so
  // an attacker without the code has no substitution move. All it can do is break things.
  for (const slot of ['offer', 'answer', 'deliver']) {
    const c = clock();
    const m = await existingMember();
    const { A, B } = sessions(m, c);
    const relay = blindMitm({ flip: slot });
    const run = await drivePairing({ A, B, transport: relay });

    assert.notEqual(run.error, null, `a corrupted ${slot} was accepted`);
    assert.equal(run.errorCode, 'open_failed', `corrupting ${slot} did not fail closed`);
    assert.equal(run.restored, null);
    assert.equal(relay.heldPlaintext(), null);
  }
});

test('a blind relay that DROPS a message stalls the pairing and transfers nothing', async () => {
  for (const slot of ['offer', 'answer', 'deliver']) {
    const c = clock();
    const m = await existingMember();
    const { A, B } = sessions(m, c);
    const run = await drivePairing({ A, B, transport: blindMitm({ drop: slot }) });
    assert.match(run.error.message, /withheld/);
    assert.equal(run.restored, null);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Replay
// ═════════════════════════════════════════════════════════════════════════════

test('REPLAY, wrong slot: box_A served where box_B is expected is an ordinary tag failure', async () => {
  const c = clock();
  const m = await existingMember();
  const { A, B } = sessions(m, c);
  const run = await drivePairing({ A, B, transport: replayRelay({ mode: 'crossSlot' }) });
  assert.equal(run.errorCode, 'open_failed', 'the offer was accepted as an answer');
  assert.equal(run.sasA, null);
  assert.equal(run.restored, null);
});

test('REPLAY, wrong rendezvous: a box captured from another session does not open here', async () => {
  const c = clock();
  // Session one, recorded in full.
  const m1 = await existingMember();
  const s1 = sessions(m1, c);
  const rec = replayRelay({ mode: 'none' });
  await drivePairing({ A: s1.A, B: s1.B, transport: rec });
  const foreign = rec.recorded();
  assert.ok(foreign.boxA && foreign.boxB);

  // Session two, with session one's traffic injected.
  const m2 = await existingMember();
  const s2 = sessions(m2, c);
  const run = await drivePairing({ A: s2.A, B: s2.B, transport: replayRelay({ mode: 'crossRid', foreign }) });
  assert.equal(run.errorCode, 'open_failed', 'a foreign rendezvous box opened');
  assert.equal(run.restored, null);
});

test('REPLAY of the delivery to a completed session: single use is a state fact, not a crypto one', async () => {
  const c = clock();
  const m = await existingMember();
  const { A, B } = sessions(m, c);
  const relay = replayRelay({ mode: 'replayDelivery' });
  const run = await drivePairing({ A, B, transport: relay });
  assert.equal(run.error, null);
  assert.equal(B.state(), PAIR_STATE.received);

  // The relay happily re-serves the same blob. The session is terminal, so there is nothing to
  // serve it to — and this is deliberately NOT a tag failure: it is the state machine.
  const again = await relay.fetchDelivery('x');
  assert.equal(again, run.delivered, 'the relay really did re-serve it');
  await assert.rejects(() => B.receive(again), (e) => e.code === 'received');
  await assert.rejects(() => A.deliver(), (e) => e.code === 'delivered');
});

test('a replayed transcript days later is refused by the TTL even if every byte is right', async () => {
  const c = clock();
  const m = await existingMember();
  const { A, B } = sessions(m, c);
  const offered = await A.beginAsExisting();
  c.advance(PAIRING.ttlMs + 1);
  await assert.rejects(() => A.confirmExisting('anything'), (e) => e.code === 'expired');
  assert.equal(A.state(), PAIR_STATE.expired);
  // And a fresh session started against that stale offer expires on its own clock too.
  const B2 = createPairingSession(null, null, c);
  const r = await B2.answerAsNew(offered.display, offered.boxA);
  assert.ok(r.boxB);
  c.advance(PAIRING.ttlMs + 1);
  await assert.rejects(() => B2.confirmNew(), (e) => e.code === 'expired');
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. Downgrade
// ═════════════════════════════════════════════════════════════════════════════

test('DOWNGRADE: there is no version to negotiate down to, and the claim is refused', async () => {
  const c = clock();
  const m = await existingMember();
  const { A, B } = sessions(m, c);
  let code = null;
  const relay = downgradeRelay({ code: null, mode: 'bumpVersion' });
  // First, from an attacker WITHOUT the code: it cannot even edit the field.
  const blind = await drivePairing({ A, B, transport: relay, learnCode: (x) => { code = x; } });
  assert.equal(blind.error, null, 'a relay with no code could not rewrite anything');

  // Now with the code, which is the only way the field is reachable at all.
  const m2 = await existingMember();
  const s2 = sessions(m2, c);
  let code2 = null;
  const armed = downgradeRelay({ code: { toString: () => code2 }, mode: 'bumpVersion' });
  const run = await drivePairing({
    A: s2.A, B: s2.B, transport: armed, learnCode: (x) => { code2 = x; },
  });
  assert.notEqual(run.error, null, 'a version claim of 2 was accepted');
  assert.ok(['version', 'open_failed'].includes(run.errorCode), `unexpected ${run.errorCode}`);
  assert.equal(run.restored, null);
});

test('DOWNGRADE: re-labelling a box into another slot fails, because the slot is in the AAD', async () => {
  const c = clock();
  const m = await existingMember();
  const { A, B } = sessions(m, c);
  let code = null;
  const relay = downgradeRelay({ code: { toString: () => code }, mode: 'swapSlotLabels' });
  const run = await drivePairing({ A, B, transport: relay, learnCode: (x) => { code = x; } });
  assert.equal(run.errorCode, 'open_failed');
  assert.equal(run.restored, null);
});

test('DOWNGRADE of the PAYLOAD: a truncated key ring is refused, so 19.4 cannot be half-kept', async () => {
  // The strongest downgrade available to anyone who got past the SAS: deliver only the CURRENT
  // epoch, so the second Mac silently shows an empty history. §7.1 step 5 calls exactly this a
  // bug for invites; 19.4 makes it a bug here.
  const c = clock();
  const m = await existingMember(3);
  const { A, B } = sessions(m, c);
  const full = await buildPairingPayload({
    memberId: m.memberId, recSig: m.identity.recSig, recKex: m.identity.recKex,
    personal: m.keyring.personal, family: null,
  });

  const truncated = { ...full, personal: { spaceId: full.personal.spaceId, epochs: { 3: full.personal.epochs['3'] } } };
  const gappy = { ...full, personal: { spaceId: full.personal.spaceId, epochs: { 1: full.personal.epochs['1'], 3: full.personal.epochs['3'] } } };
  const empty = { ...full, personal: { spaceId: full.personal.spaceId, epochs: {} } };

  // Refused on the way out…
  const relay = honestRelay({ now: c.now });
  const run = await drivePairing({ A, B, transport: relay, payload: truncated });
  assert.equal(run.errorCode, 'payload');
  assert.equal(run.restored, null);

  // …and on the way in, so a compromised sender cannot get it past the receiver either.
  for (const bad of [truncated, gappy, empty]) {
    await assert.rejects(() => restorePairingPayload(bad), (e) => e.code === 'payload');
  }
  const ok = await restorePairingPayload(full);
  assert.deepEqual([...ok.personal.epochs.keys()], [1, 2, 3]);
});

test('a payload claiming a version this client does not know is PARKED, never guessed at', async () => {
  const m = await existingMember();
  const full = await buildPairingPayload({
    memberId: m.memberId, recSig: m.identity.recSig, recKex: m.identity.recKex,
    personal: m.keyring.personal,
  });
  await assert.rejects(() => restorePairingPayload({ ...full, v: 2 }), (e) => e.code === 'version');
  await assert.rejects(() => restorePairingPayload({ ...full, v: undefined }), (e) => e.code === 'version');
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. Guessing the code — the online budget, the burn, and the TTL
// ═════════════════════════════════════════════════════════════════════════════

test('BRUTE FORCE: the online budget inside one TTL is arithmetic, and it is negligible', () => {
  // §6.4's "effectively impossible", computed over the ADRs' own published limits rather than
  // asserted as an opinion. If someone shortens the code or loosens a limiter, this moves.
  const perHour = bruteForceBudget({ ratePerHour: PAIRING.relayGetPerIpPerHour });
  const perMinute = bruteForceBudget({ ratePerMinute: PAIRING.failedRidLookupsPerIpPerMinute });
  assert.equal(perHour.space, 2 ** 60);
  assert.equal(perHour.guesses, 1, '20/hour over 180 s is one guess');
  assert.equal(perMinute.guesses, 15, '5/minute over 180 s is fifteen');
  assert.ok(perMinute.probability < 2e-17, `probability ${perMinute.probability}`);
  assert.equal(perMinute.probability, 15 / 2 ** 60);
  // And §6.4's offline number, checked rather than quoted: at a well-resourced 10^11 trials per
  // second the full 2^60 takes "on the order of months" — against a 180-second window.
  const trialsPerSecond = 1e11;
  const monthsForFullSpace = 2 ** 60 / trialsPerSecond / (30 * 24 * 3600);
  assert.ok(monthsForFullSpace > 4 && monthsForFullSpace < 5, `${monthsForFullSpace} months`);
  const inWindow = bruteForceBudget({ ratePerMinute: trialsPerSecond * 60 });
  assert.ok(inWindow.probability < 2e-5, `even 1e11/s only reaches ${inWindow.probability}`);
  // Which is why the honest framing is §6.4's: the code is not the security parameter. That
  // 1.6e-5 is sixteen times MORE likely than guessing the SAS — and all it buys an attacker who
  // has spent those months is the right to stand in the middle and guess six digits anyway.
});

test('BRUTE FORCE: five failed opens burn the rendezvous, and the sixth never happens', async () => {
  const c = clock();
  const m = await existingMember();
  const A = createPairingSession(m.identity, m.keyring, c);
  const offered = await A.beginAsExisting();
  const relay = honestRelay({ now: c.now });
  await relay.offer(offered.rid, offered.boxA);

  // A guesser types wrong codes. Each derives a DIFFERENT rid, so the relay has nothing to serve
  // — which is the first wall. The second wall is the session's own counter.
  let served = 0;
  for (let i = 0; i < 50; i++) {
    const guess = attackerGuessCode();
    if (guess === offered.code) continue;
    const { rid } = await derivePairing(guess);
    if (await relay.get(rid) !== null) served += 1;
  }
  assert.equal(served, 0, 'a wrong code found a rendezvous');

  // Now the harder case: an attacker who somehow has the rid but not the code, feeding the real
  // box to a new device that types wrong codes. Five failures and the session is finished.
  const B = createPairingSession(null, null, c);
  const codes = [];
  while (codes.length < PAIRING.maxFailedOpens) {
    const g = attackerGuessCode();
    if (g !== offered.code) codes.push(g);
  }
  for (let i = 0; i < PAIRING.maxFailedOpens - 1; i++) {
    await assert.rejects(() => B.answerAsNew(codes[i], offered.boxA), (e) => e.code === 'open_failed');
    assert.equal(B.attemptsRemaining(), PAIRING.maxFailedOpens - (i + 1));
  }
  await assert.rejects(() => B.answerAsNew(codes[4], offered.boxA), (e) => e.code === 'burned');
  assert.equal(B.state(), PAIR_STATE.burned);
  assert.equal(B.attemptsRemaining(), 0);
  // Terminal means terminal: the RIGHT code no longer works either, and the session says
  // 'burned' rather than a generic "wrong state" — a caller told the latter would offer a retry.
  await assert.rejects(() => B.answerAsNew(offered.code, offered.boxA), (e) => e.code === 'burned');
});

test('the relay burns the rendezvous on the fifth reported failure, and on consumption', async () => {
  const c = clock();
  const relay = honestRelay({ now: c.now });
  await relay.offer('RID', 'box');
  for (let i = 0; i < PAIRING.maxFailedOpens; i++) await relay.reportFailedOpen('RID');
  assert.equal(await relay.get('RID'), null, 'the rendezvous survived five failures');
  assert.equal(relay.transcript().burned, true);

  const r2 = honestRelay({ now: c.now });
  await r2.offer('R2', 'box');
  await r2.deliver('R2', 'blob');
  assert.equal(await r2.fetchDelivery('R2'), 'blob');
  assert.equal(await r2.fetchDelivery('R2'), null, '§6.2 single use');
});

test('the TTL closes the window at every stage, on both sides', async () => {
  for (const stage of ['answer', 'confirmExisting', 'confirmNew', 'deliver', 'receive']) {
    const c = clock();
    const m = await existingMember();
    const { A, B } = sessions(m, c);
    const offered = await A.beginAsExisting();

    if (stage === 'answer') {
      // THE ONE PLACE THE TWO CLOCKS ARE NOT THE SAME CLOCK, AND IT IS BY DESIGN.
      // B has no way to know when the code was minted: nothing in the offer is a timestamp, and
      // nothing may be, because a relay-supplied one is attacker-controlled. So a stale OFFER is
      // refused by the relay, which holds the rendezvous and burns it — that is §6.2's TTL — and
      // B's own 180 s bounds B's own steps. Asserting otherwise here would be asserting a
      // guarantee the protocol does not make.
      const relay = honestRelay({ now: c.now });
      await relay.offer(offered.rid, offered.boxA);
      c.advance(PAIRING.ttlMs + 1);
      assert.equal(await relay.get(offered.rid), null, 'the relay served a stale rendezvous');
      const fresh = await B.answerAsNew(offered.code, offered.boxA);
      assert.ok(fresh.boxB, 'B measures its own window, from its own first step');
      continue;
    }
    const answered = await B.answerAsNew(offered.code, offered.boxA);
    if (stage === 'confirmExisting') {
      c.advance(PAIRING.ttlMs + 1);
      await assert.rejects(() => A.confirmExisting(answered.boxB), (e) => e.code === 'expired');
      continue;
    }
    if (stage === 'confirmNew') {
      c.advance(PAIRING.ttlMs + 1);
      await assert.rejects(() => B.confirmNew(), (e) => e.code === 'expired');
      continue;
    }
    await A.confirmExisting(answered.boxB);
    await B.confirmNew();
    A.confirmSasMatch(true);
    B.confirmSasMatch(true);
    c.advance(PAIRING.ttlMs + 1);
    if (stage === 'deliver') {
      await assert.rejects(() => A.deliver(), (e) => e.code === 'expired');
    } else {
      await assert.rejects(() => B.receive('x'), (e) => e.code === 'expired');
    }
  }
});

test('the TTL is exactly 180 s, not "about" 180 s', async () => {
  const c = clock();
  const m = await existingMember();
  const { A, B } = sessions(m, c);
  const offered = await A.beginAsExisting();
  c.advance(PAIRING.ttlMs);                 // exactly at the boundary — still open
  const answered = await B.answerAsNew(offered.code, offered.boxA);
  assert.ok(answered.boxB);
  c.advance(1);                             // one millisecond past — closed
  await assert.rejects(() => A.confirmExisting(answered.boxB), (e) => e.code === 'expired');
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. The state machine as a defence in its own right
// ═════════════════════════════════════════════════════════════════════════════

test('confirmSasMatch takes the boolean true and NOTHING else — no truthiness, no default', async () => {
  // A caller that forgot to pass the human's answer must fail CLOSED, and a truthy sentinel it
  // happened to have lying around must not be mistaken for a person who looked at two screens.
  for (const answer of [undefined, null, false, 0, 1, 'ja', 'true', {}, [], 'yes']) {
    const c = clock();
    const m = await existingMember();
    const { A, B } = sessions(m, c);
    const o = await A.beginAsExisting();
    const a = await B.answerAsNew(o.code, o.boxA);
    await A.confirmExisting(a.boxB);
    assert.equal(A.confirmSasMatch(answer).state, PAIR_STATE.refused, `${JSON.stringify(answer)} confirmed a pairing`);
    await assert.rejects(() => A.deliver(), (e) => e.code === 'refused');
  }
});

test('a session cannot be talked into swapping roles', async () => {
  const c = clock();
  const m = await existingMember();
  const A = createPairingSession(m.identity, m.keyring, c);
  const o = await A.beginAsExisting();
  await assert.rejects(() => A.answerAsNew(o.code, o.boxA), (e) => e.code === 'role');
  assert.equal(A.state(), PAIR_STATE.failed);

  const B = createPairingSession(null, null, c);
  const A2 = createPairingSession(m.identity, m.keyring, c);
  const o2 = await A2.beginAsExisting();
  await B.answerAsNew(o2.code, o2.boxA);
  await assert.rejects(() => B.beginAsExisting(), (e) => e.code === 'role');
});

test('every step refuses to run out of order, and a delivery never precedes a confirmation', async () => {
  const c = clock();
  const m = await existingMember();
  const { A, B } = sessions(m, c);

  await assert.rejects(() => A.deliver(), (e) => e.code === 'state');
  await assert.rejects(() => A.confirmExisting('x'), (e) => e.code === 'state');
  const o = await A.beginAsExisting();
  await assert.rejects(() => A.beginAsExisting(), (e) => e.code === 'state');
  await assert.rejects(() => A.deliver(), (e) => e.code === 'state');
  assert.throws(() => A.confirmSasMatch(true), (e) => e.code === 'state');

  const a = await B.answerAsNew(o.code, o.boxA);
  await assert.rejects(() => B.receive('x'), (e) => e.code === 'state');
  await A.confirmExisting(a.boxB);
  await B.confirmNew();
  // Still not confirmed by a human.
  await assert.rejects(() => A.deliver(), (e) => e.code === 'state');
  await assert.rejects(() => B.receive('x'), (e) => e.code === 'state');
  A.confirmSasMatch(true);
  B.confirmSasMatch(true);
  // And the roles do not cross even at the last step.
  await assert.rejects(() => B.deliver(), (e) => e.code === 'role');
  const blob = await A.deliver();
  await assert.rejects(() => A.receive(blob), (e) => e.code === 'delivered');
});

test('a session refuses to attach this Mac to a member other than the one whose code was typed', async () => {
  // The delivery is sealed under a key derived from the ECDH, so only a successful MITM could
  // substitute the memberId — but if one ever did, the new Mac would silently become somebody
  // else's device. Cross-checking the delivered memberId against the OFFER closes it for free.
  const c = clock();
  const m = await existingMember();
  const other = await existingMember();
  const { A, B } = sessions(m, c);
  const o = await A.beginAsExisting();
  const a = await B.answerAsNew(o.code, o.boxA);
  await A.confirmExisting(a.boxB);
  await B.confirmNew();
  A.confirmSasMatch(true);
  B.confirmSasMatch(true);
  const wrong = await buildPairingPayload({
    memberId: other.memberId, recSig: other.identity.recSig, recKex: other.identity.recKex,
    personal: other.keyring.personal,
  });
  const blob = await A.deliver(wrong);
  await assert.rejects(() => B.receive(blob), (e) => e.code === 'protocol');
  assert.equal(B.state(), PAIR_STATE.failed);
});

test('a session with no clock is refused at construction, not at the TTL check', () => {
  // ADR 005 §2 forbids a clock inside src/js/crypto/, and §6.2's TTL is a stated parameter. A
  // session that silently could not enforce it would be worse than one that refuses to exist.
  assert.throws(() => createPairingSession(null, null, {}), (e) => e.code === 'no_clock');
  assert.throws(() => createPairingSession(null, null, undefined), (e) => e.code === 'no_clock');
  assert.throws(() => createPairingSession(null, null, { now: 12345 }), (e) => e.code === 'no_clock');
});

test('the existing device refuses to begin without a real identity', async () => {
  const c = clock();
  await assert.rejects(() => createPairingSession(null, null, c).beginAsExisting(), (e) => e.code === 'identity');
  await assert.rejects(
    () => createPairingSession({ memberId: 'm' }, null, c).beginAsExisting(),
    (e) => e.code === 'identity'
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 12. The payload
// ═════════════════════════════════════════════════════════════════════════════

test('the payload carries the recovery identity and the ring — and NEVER a device private key', async () => {
  const m = await existingMember(2);
  const p = await buildPairingPayload({
    memberId: m.memberId, recSig: m.identity.recSig, recKex: m.identity.recKex,
    personal: m.keyring.personal, family: null,
  });
  assert.equal(p.v, PAIR_V);
  assert.equal(p.memberId, m.memberId);
  assert.equal(ub64(p.recSigPkcs8).length, PKCS8_P256_BYTES);
  assert.equal(ub64(p.recKexPkcs8).length, PKCS8_P256_BYTES);
  assert.equal(p.family, null);
  for (const e of ['1', '2']) assert.equal(ub64(p.personal.epochs[e]).length, SYMMETRIC_KEY_BYTES);

  // 138 is not a multiple of 8 — rule 6's arithmetic. This PKCS#8 travels inside an AES-GCM box
  // precisely because AES-KW would raise OperationError over it in both engines.
  assert.notEqual(PKCS8_P256_BYTES % 8, 0);

  // A device key cannot even be offered: it is non-extractable, so there is no code path.
  await assert.rejects(
    () => buildPairingPayload({ memberId: m.memberId, recSig: m.identity.devSig, recKex: m.identity.devKex, personal: m.keyring.personal })
  );
  const flat = JSON.stringify(p);
  const devSigRaw = b64u(await identity.exportRawPublic(m.identity.devSig.publicKey));
  assert.equal(flat.includes(devSigRaw), false, 'the first Mac put its own device key in the payload');
});

test('a payload without the recovery pair is refused — §6.3 step 8 could not happen', async () => {
  const m = await existingMember();
  await assert.rejects(
    () => buildPairingPayload({ memberId: m.memberId, personal: m.keyring.personal }),
    (e) => e.code === 'payload' && /self-attest/.test(e.message)
  );
  await assert.rejects(
    () => buildPairingPayload({ memberId: m.memberId, recSig: m.identity.recSig, recKex: m.identity.recKex }),
    (e) => e.code === 'payload'
  );
});

test('ENGINE DIFFERENCE 9: the restored private halves carry ONLY the private usages', async () => {
  const m = await existingMember();
  const p = await buildPairingPayload({
    memberId: m.memberId, recSig: m.identity.recSig, recKex: m.identity.recKex, personal: m.keyring.personal,
  });
  const r = await restorePairingPayload(p);
  assert.deepEqual(r.recSigPriv.usages, ['sign']);
  assert.deepEqual(r.recKexPriv.usages.slice().sort(), ['deriveBits', 'deriveKey']);
  assert.equal(r.recSigPriv.type, 'private');
  // …and the reason: `verify` on a private EC key is a SyntaxError in BOTH engines, and this is
  // the restore path, which is the path a developer exercises last.
  await assert.rejects(
    () => S.importKey('pkcs8', ub64(p.recSigPkcs8), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  );
});

test('the restored recovery key is the SAME key, provable without comparing signature bytes', async () => {
  const m = await existingMember();
  const p = await buildPairingPayload({
    memberId: m.memberId, recSig: m.identity.recSig, recKex: m.identity.recKex, personal: m.keyring.personal,
  });
  const r = await restorePairingPayload(p);
  // Rule 1: sign with the restored key, verify under the ORIGINAL public key. Two signatures over
  // the same bytes differ in both engines, so `verify() === true` is the only sound assertion.
  const bytes = canonicalBytes({ probe: 'is this the same key' });
  const sig = await identity.signBytes(r.recSigPriv, bytes);
  assert.equal(await identity.verifyBytes(m.rec.recSig.publicKey, sig, bytes), true);
  const again = await identity.signBytes(r.recSigPriv, bytes);
  assert.notEqual(b64u(sig), b64u(again), 'ECDSA is non-deterministic — rule 1 exists for a reason');
  assert.equal(await identity.verifyBytes(m.rec.recSig.publicKey, again, bytes), true);
});

test('a family space rides along when there is one, under the same 1..e rule', async () => {
  const m = await existingMember(2);
  const FSP = mkSpaceId('family');
  const family = { spaceId: FSP, epochs: new Map([[1, await aesKey()], [2, await aesKey()]]) };
  const p = await buildPairingPayload({
    memberId: m.memberId, recSig: m.identity.recSig, recKex: m.identity.recKex,
    personal: m.keyring.personal, family,
  });
  const r = await restorePairingPayload(p);
  assert.equal(r.family.spaceId, FSP);
  assert.deepEqual([...r.family.epochs.keys()], [1, 2]);
  // A space id that is not a space id is refused on both sides — after a MITM has been through,
  // this field is attacker-chosen and becomes a key in the new Mac's ring.
  await assert.rejects(
    () => restorePairingPayload({ ...p, personal: { ...p.personal, spaceId: '../../etc' } }),
    (e) => e.code === 'payload'
  );
  await assert.rejects(
    () => buildPairingPayload({
      memberId: m.memberId, recSig: m.identity.recSig, recKex: m.identity.recKex,
      personal: m.keyring.personal, family: { spaceId: FSP, epochs: new Map([[2, family.epochs.get(2)]]) },
    }),
    (e) => e.code === 'payload'
  );
});

test('spacesFromKeyRing adapts the REAL KeyRing from spacekeys.js, not a stand-in for it', async () => {
  // A structural type nobody checks against the real implementation is a guess. This is the
  // check: build an actual `createKeyRing()` and hand it to the adapter unmodified.
  const k1 = await aesKey();
  const k2 = await aesKey();
  const psp = mkSpaceId('personal');
  const fsp = mkSpaceId('family');
  const ring = createKeyRing([[psp, 1, k1], [psp, 2, k2], [fsp, 1, k1]]);
  const spaces = spacesFromKeyRing(ring, { personalSpaceId: psp, familySpaceId: fsp });
  assert.deepEqual([...spaces.personal.epochs.keys()], [1, 2]);
  assert.deepEqual([...spaces.family.epochs.keys()], [1]);

  // …and it produces a payload the far side accepts, which is the only claim worth making.
  const m = await existingMember(1);
  const p = await buildPairingPayload({
    memberId: m.memberId, recSig: m.identity.recSig, recKex: m.identity.recKex, ...spaces,
  });
  const r = await restorePairingPayload(p);
  assert.deepEqual([...r.personal.epochs.keys()], [1, 2]);
  assert.equal(r.family.spaceId, fsp);
});

test('spacesFromKeyRing tolerates a sparse ring and refuses a caller that gives it nothing', async () => {
  const k1 = await aesKey();
  const k2 = await aesKey();
  const psp = mkSpaceId('personal');
  const fsp = mkSpaceId('family');
  const keyring = {
    epochs: (s) => (s === psp ? [1, 2, 3] : [1]),
    get: (s, e) => (s === psp ? [null, k1, k2, null][e] : k1),   // epoch 3 is listed but absent
  };
  const spaces = spacesFromKeyRing(keyring, { personalSpaceId: psp, familySpaceId: fsp });
  assert.deepEqual([...spaces.personal.epochs.keys()], [1, 2], 'a listed-but-absent epoch is skipped');
  assert.deepEqual([...spaces.family.epochs.keys()], [1]);
  assert.equal(spacesFromKeyRing(keyring, { personalSpaceId: psp }).family, null);
  assert.throws(() => spacesFromKeyRing({}, { personalSpaceId: psp }), (e) => e.code === 'payload');
  assert.throws(() => spacesFromKeyRing(keyring, {}), (e) => e.code === 'payload');
});

// ═════════════════════════════════════════════════════════════════════════════
// 13. Adoption refuses to pair over a Mac that is already somebody's device
// ═════════════════════════════════════════════════════════════════════════════

test('adoptPairedDevice refuses a non-empty store, a foreign pair, and a clock read', async () => {
  const c = clock();
  const m = await existingMember();
  const { A, B } = sessions(m, c);
  const run = await drivePairing({ A, B, transport: honestRelay({ now: c.now }) });
  const minted = B.newDeviceKeys();

  // A store that already holds an identity is not a new device. Pairing over it would orphan
  // every op the old short authored (`ensureDeviceIdentity`'s header makes the same argument).
  const used = memKeyStore();
  await identity.ensureDeviceIdentity(used, mkMemberId(), { deviceId: mkDeviceId(), createdAt: DAY });
  await assert.rejects(() => adoptPairedDevice(used, run.restored, minted, { createdAt: DAY }), (e) => e.code === 'keystore');

  // `createdAt` is injected, never read.
  await assert.rejects(() => adoptPairedDevice(memKeyStore(), run.restored, minted, {}), (e) => e.code === 'protocol');
  await assert.rejects(() => adoptPairedDevice(memKeyStore(), run.restored, minted, { createdAt: '27.08.2026' }), (e) => e.code === 'protocol');

  // An extractable "device" key is not a device key (§2.1).
  const soft = await S.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  await assert.rejects(
    () => adoptPairedDevice(memKeyStore(), run.restored, { ...minted, devSig: soft }, { createdAt: DAY }),
    (e) => e.code === 'protocol'
  );
  await assert.rejects(() => adoptPairedDevice({}, run.restored, minted, { createdAt: DAY }), (e) => e.code === 'keystore');
});

test('a deviceShort that is not the short of the signing key is refused (§5.2.2 P2)', async () => {
  const c = clock();
  const m = await existingMember();
  const { A, B } = sessions(m, c);
  const run = await drivePairing({ A, B, transport: honestRelay({ now: c.now }) });
  const minted = B.newDeviceKeys();
  const otherShort = m.identity.deviceShort;
  await assert.rejects(
    () => adoptPairedDevice(memKeyStore(), run.restored, { ...minted, deviceShort: otherShort }, { createdAt: DAY }),
    (e) => e.code === 'protocol'
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 14. What pairing does NOT close
// ═════════════════════════════════════════════════════════════════════════════

test('I-3 / R5-7 IS STILL OPEN: a paired device is honestly attested, and that is not identity', async () => {
  // The step-8 self-attestation passes P2 — its deviceShort really is the short of its sigPubRaw.
  // P2 is SELF-CONSISTENCY. It does not make `deviceShort -> attestation` a function across the
  // space, because `sigPubRaw` is a PUBLIC key travelling in the E2EE stream every member reads:
  // a squatter copies it, tells the truth about it, files it under her own record, and passes.
  // Nothing in pairing changes that, and nothing downstream may be built as though it does.
  const c = clock();
  const m = await existingMember();
  const { A, B } = sessions(m, c);
  const run = await drivePairing({ A, B, transport: honestRelay({ now: c.now }) });
  const adopted = await adoptPairedDevice(memKeyStore(), run.restored, B.newDeviceKeys(), { createdAt: DAY });
  assert.equal(identity.attestationSelfConsistent(adopted.attestation), true);

  // A different member copies the freshly paired device's public key into her OWN record.
  const squatter = await existingMember();
  const squat = {
    memberId: squatter.memberId,
    deviceId: mkDeviceId(),
    deviceShort: adopted.attestation.deviceShort,       // the victim's short
    sigPubRaw: adopted.attestation.sigPubRaw,           // the victim's public key, copied verbatim
    kexPubRaw: adopted.attestation.kexPubRaw,
    createdAt: DAY,
  };
  const blob = await identity.attestDevice(squat, squatter.rec.recSig.privateKey);
  const verified = await identity.verifyAttestation(blob, squatter.rec.recSig.publicKey);
  assert.notEqual(verified, null, 'P2 stopped the squat — I-3 would be CLOSED and this row is stale');
  assert.equal(verified.deviceShort, adopted.attestation.deviceShort);
  assert.notEqual(verified.memberId, adopted.attestation.memberId);
  // Two members, one short, both self-consistent. Closing this needs a first-claim binding on the
  // PAIR (sigPubRaw, deviceShort) at fold time — FINDINGS §4.5 option (a), owned by core/authz.js.
  // Until then `openOp` must keep treating `attestationOf` as partial and PARK.
});

test('pairing has no revocation, and does not pretend to (§2.3, §8.2a)', () => {
  const api = Object.keys(createPairingSession(null, null, clock()));
  for (const forbidden of ['revoke', 'unpair', 'revokeDevice']) {
    assert.equal(api.includes(forbidden), false, `pairing must not invent revocation — it is WP-9's`);
  }
});

test('PRINCIPLE 7: pairing.js is not reachable from boot, first run or main', () => {
  for (const entry of ['src/js/boot.js', 'src/js/firstrun.js', 'src/js/main.js']) {
    const chain = pathToPrefix(entry, 'src/js/crypto/');
    assert.equal(chain, null, chain ? `solo mode reaches crypto: ${chain.join(' -> ')}` : '');
  }
  // …and the walker really does see this file, so the green above means something.
  const reached = reachableFrom('src/js/crypto/pairing.js').reached;
  assert.ok(reached.includes('src/js/crypto/identity.js'));
  assert.ok(reached.includes('src/js/core/b64.js'));
  assert.equal(reached.some((r) => r.startsWith('src/js/platform/')), false,
    'pairing.js reaches platform/ — the KeyStore is a PORT, not an import');
});
