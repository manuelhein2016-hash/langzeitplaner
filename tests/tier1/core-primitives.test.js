// tests/tier1/core-primitives.test.js — the level-0 primitives of src/js/core/.
// ADR 001 §1 (identity, the stamp), ADR 005 §1.1, ops.contract.js §1.
//
// These five modules are the foundation everything else stands on, so the tests below are
// deliberately paranoid about the two places where a subtle defect would be invisible until it
// was expensive:
//
//   * canon.js  — its output gets SIGNED (ADR 002 §2.3, §5.3). A cross-engine instability here
//     is a security bug, not a formatting nit, so key-order invariance, NFC and re-serialisation
//     stability are tested as properties over shuffled input, not as one happy-path example.
//   * stamp.js  — it is the LWW comparator for the whole product (ADR 001 §1.3). The full
//     ordering contract is tested: total order, monotonicity under a frozen clock, monotonicity
//     under a clock that steps BACKWARDS, counter overflow, the HLC receive rule, the 24 h
//     future clamp, and the device tiebreak.
//
// NO TEST READS THE WALL CLOCK (ADR 005 §5). Every clock is injected and every random source is
// either seeded or explicitly asserted only on its shape.

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEV } from '../../src/js/core/dev.js';
import {
  b64u, ub64, crock32, uncrock32, crockNormalize, CROCKFORD_ALPHABET, CodecError,
} from '../../src/js/core/b64.js';
import {
  canonicalJSON, canonicalBytes, utf8, utf8Decode, varint, readVarint, CanonError,
} from '../../src/js/core/canon.js';
import {
  entityUuid, opId, groupId, memberId, deviceId, spaceId,
  deviceShortOf, deviceShort, isDeviceShort, ZERO_DEVICE_SHORT, sha256, defaultRandom,
} from '../../src/js/core/ids.js';
import {
  createClock, fmt, cmp, msOf, ctrOf, devOf, isStamp, parse, isTooFarFuture,
  MAX_FUTURE_DRIFT_MS, STAMP_LENGTH, MAX_STAMP_CTR,
} from '../../src/js/core/stamp.js';

// ─────────────────────────────────────────────────────────────────────────────
// Local, seeded, dependency-free helpers. tests/helpers/rng.js and clock.js are WP-2 files;
// until they land these stay here so this suite owns its own determinism.
// ─────────────────────────────────────────────────────────────────────────────

/** mulberry32 — a small seeded PRNG. The seed is printed by every failure message below. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededBytes(rnd, n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(rnd() * 256);
  return b;
}

function shuffle(rnd, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** An injected wall clock under the test's control. Nothing here calls the real one. */
function fakeClock(startMs) {
  let t = startMs;
  return {
    now: () => t,
    advance(ms) { t += ms; return t; },
    set(ms) { t = ms; return t; },
  };
}

const DEV_A = '7QAR2MZ9XKPNC0GV'; // the ADR 001 §1.3 example device
const DEV_B = '0123456789ABCDEF';
const T0 = 1787836800123; // a fixed instant; never Date.now()

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// ═════════════════════════════════════════════════════════════════════════════
// dev.js
// ═════════════════════════════════════════════════════════════════════════════

test('dev.js: DEV is off unless __LZP_DEV is set before import', () => {
  assert.equal(DEV, false);
  assert.equal(typeof DEV, 'boolean');
});

test('dev.js: DEV reads globalThis.__LZP_DEV at import time', async () => {
  // There is no build step in this project (ADR 001 §7.1), so DEV is a module constant read
  // once. A fresh module instance is forced with a query string; tests and dev-server.mjs are
  // the only things that ever set the global.
  const before = globalThis.__LZP_DEV;
  globalThis.__LZP_DEV = true;
  try {
    const mod = await import('../../src/js/core/dev.js?probe=1');
    assert.equal(mod.DEV, true);
  } finally {
    if (before === undefined) delete globalThis.__LZP_DEV;
    else globalThis.__LZP_DEV = before;
  }
  assert.equal(DEV, false, 'the already-imported instance must not change under a live flag flip');
});

// ═════════════════════════════════════════════════════════════════════════════
// b64.js — base64url
// ═════════════════════════════════════════════════════════════════════════════

test('b64u: 16 CSPRNG bytes render as exactly 22 characters (the opId width)', () => {
  assert.equal(b64u(new Uint8Array(16)).length, 22);
  assert.equal(b64u(new Uint8Array(16).fill(255)).length, 22);
  assert.equal(b64u(new Uint8Array(16)), 'A'.repeat(22));
});

test('b64u: matches an independent implementation over every length 0..64', () => {
  // Node's own base64url encoder is the oracle. If these ever disagree, an opId minted by one
  // build would not be the same idempotency key as the "same" opId minted by another.
  const rnd = mulberry32(0xC0FFEE);
  for (let n = 0; n <= 64; n++) {
    const bytes = seededBytes(rnd, n);
    const expected = Buffer.from(bytes).toString('base64url');
    assert.equal(b64u(bytes), expected, `length ${n}, seed 0xC0FFEE`);
  }
});

test('b64u/ub64: round-trip for the empty input and lengths 1..8', () => {
  const rnd = mulberry32(1);
  for (let n = 0; n <= 8; n++) {
    const bytes = seededBytes(rnd, n);
    const round = ub64(b64u(bytes));
    assert.deepEqual(Array.from(round), Array.from(bytes), `length ${n}`);
  }
  assert.equal(b64u(new Uint8Array(0)), '');
  assert.equal(ub64('').length, 0);
});

test('b64u/ub64: round-trip over 200 seeded random byte strings', () => {
  const rnd = mulberry32(42);
  for (let i = 0; i < 200; i++) {
    const bytes = seededBytes(rnd, Math.floor(rnd() * 70));
    assert.deepEqual(Array.from(ub64(b64u(bytes))), Array.from(bytes), `iteration ${i}, seed 42`);
  }
});

test('b64u: emits no padding and never a + or a /', () => {
  const rnd = mulberry32(7);
  for (let i = 0; i < 100; i++) {
    const s = b64u(seededBytes(rnd, 1 + Math.floor(rnd() * 40)));
    assert.equal(/[=+/]/.test(s), false, `unexpected character in ${s}`);
    assert.match(s, /^[A-Za-z0-9_-]+$/);
  }
});

test('ub64: rejects padding, standard-base64 characters and impossible lengths', () => {
  assert.throws(() => ub64('AA=='), CodecError);
  assert.throws(() => ub64('a+b/'), CodecError);
  assert.throws(() => ub64('A'), CodecError); // length % 4 === 1 is impossible
  assert.throws(() => ub64('AAAA!'), CodecError);
  assert.throws(() => ub64(null), CodecError);
});

test('ub64: rejects a non-canonical encoding — one byte string, one spelling', () => {
  // "AA" and "AB" both decode to the byte 0x00 in a lenient decoder. Since opId is the server's
  // idempotency key, two spellings of the same 16 bytes would make "already seen" undecidable
  // by string comparison.
  assert.deepEqual(Array.from(ub64('AA')), [0]);
  assert.throws(() => ub64('AB'), CodecError);
  assert.deepEqual(Array.from(ub64('AAA')), [0, 0]);
  assert.throws(() => ub64('AAB'), CodecError);
});

test('b64u: accepts ArrayBuffer and number[] as well as Uint8Array', () => {
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  assert.equal(b64u(bytes), b64u(bytes.buffer));
  assert.equal(b64u(bytes), b64u([1, 2, 3, 4]));
  assert.throws(() => b64u([1, 2, 300]), CodecError);
});

// ═════════════════════════════════════════════════════════════════════════════
// b64.js — Crockford base32
// ═════════════════════════════════════════════════════════════════════════════

test('crock32: the alphabet excludes I, L, O and U and starts at 0', () => {
  assert.equal(CROCKFORD_ALPHABET, '0123456789ABCDEFGHJKMNPQRSTVWXYZ');
  assert.equal(CROCKFORD_ALPHABET.length, 32);
  for (const bad of ['I', 'L', 'O', 'U']) {
    assert.equal(CROCKFORD_ALPHABET.includes(bad), false, `${bad} must not be in the alphabet`);
  }
  // ADR 001 §1.2 depends on '0' being the minimum: every character sorts at or above it.
  for (const ch of CROCKFORD_ALPHABET) assert.ok(ch >= '0', `${ch} sorts below '0'`);
});

test('crock32: 10 bytes render as exactly 16 characters (the deviceShort width, 80 bits)', () => {
  assert.equal(crock32(new Uint8Array(10)).length, 16);
  assert.equal(crock32(new Uint8Array(10)), '0'.repeat(16));
  assert.equal(crock32(new Uint8Array(10).fill(255)), 'Z'.repeat(16));
});

test('crock32/uncrock32: round-trip for the empty input and lengths 1..8', () => {
  const rnd = mulberry32(11);
  for (let n = 0; n <= 8; n++) {
    const bytes = seededBytes(rnd, n);
    assert.deepEqual(Array.from(uncrock32(crock32(bytes))), Array.from(bytes), `length ${n}`);
  }
  assert.equal(crock32(new Uint8Array(0)), '');
});

test('crock32/uncrock32: round-trip over 200 seeded random byte strings', () => {
  const rnd = mulberry32(1234);
  for (let i = 0; i < 200; i++) {
    const bytes = seededBytes(rnd, Math.floor(rnd() * 40));
    assert.deepEqual(Array.from(uncrock32(crock32(bytes))), Array.from(bytes), `iteration ${i}, seed 1234`);
  }
});

test('crock32: output length is ceil(8n/5) and uses the alphabet only', () => {
  const rnd = mulberry32(99);
  for (let n = 0; n <= 32; n++) {
    const s = crock32(seededBytes(rnd, n));
    assert.equal(s.length, Math.ceil((8 * n) / 5), `length for ${n} bytes`);
    for (const ch of s) assert.ok(CROCKFORD_ALPHABET.includes(ch), `${ch} is not a Crockford character`);
  }
});

test('crockNormalize: folds case, strips the separators a human types, maps I/L to 1 and O to 0', () => {
  // The pairing code is displayed XXXX-XXXX-XXXX and typed by hand (ADR 002 §6.2).
  assert.equal(crockNormalize('abcd-efgh-jkmn'), 'ABCDEFGHJKMN');
  assert.equal(crockNormalize('ABCD EFGH JKMN'), 'ABCDEFGHJKMN');
  assert.equal(crockNormalize('IiLl'), '1111');
  assert.equal(crockNormalize('Oo'), '00');
  assert.equal(crockNormalize(''), '');
});

test('uncrock32: a human-typed code decodes the same however it was typed', () => {
  const bytes = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x01]); // 5 bytes -> 8 characters
  const code = crock32(bytes);
  assert.equal(code.length, 8);
  const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
  assert.deepEqual(Array.from(uncrock32(typed)), Array.from(bytes));
});

test('uncrock32: rejects U, which Crockford reserves, rather than guessing at it', () => {
  assert.throws(() => uncrock32('UUUUUUUU'), CodecError);
  assert.throws(() => uncrock32('ABCDEFGU'), CodecError);
});

test('uncrock32: rejects a non-canonical encoding and an impossible length', () => {
  assert.deepEqual(Array.from(uncrock32('00')), [0]);
  assert.throws(() => uncrock32('01'), CodecError); // spare bits set
  assert.throws(() => uncrock32('A'), CodecError); // 1 leftover character is impossible
});

// ═════════════════════════════════════════════════════════════════════════════
// canon.js — canonical JSON
// ═════════════════════════════════════════════════════════════════════════════

test('canonicalJSON: sorted keys, no whitespace', () => {
  assert.equal(canonicalJSON({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJSON({}), '{}');
  assert.equal(canonicalJSON([]), '[]');
  const s = canonicalJSON({ z: [1, 2], a: { c: true, b: null } });
  assert.equal(s, '{"a":{"b":null,"c":true},"z":[1,2]}');
  assert.equal(/\s/.test(s), false, 'canonical JSON carries no whitespace');
});

test('canonicalJSON: STABLE under key insertion order — 200 seeded shuffles, one byte string', () => {
  // This is the property the signature scheme rests on. Two devices building the same op with
  // their properties assigned in a different order must produce the same bytes to sign.
  const pairs = [
    ['v', 1], ['id', '8Kx2Qm7bR0aZ4tV9wLpNcg'], ['ts', '1787836800123.000003.7QAR2MZ9XKPNC0GV'],
    ['space', 'psp_9xQ2mR7bL0aZ4tV8wK'], ['act', 'mem_2bK7xQ9pLmR0aZ4tV9'],
    ['dev', 'dev_7QaR2mZ9xLpNc0gVtB'], ['gid', '3Ff9pQ2mLx7bR0aZ4tV9wL'],
    ['k', 'note.set'], ['e', 'note:5e1a-9c'],
    ['f', { date: '2026-09-10', text: 'Zahnarzt' }],
  ];
  const rnd = mulberry32(2026);
  const canonical = canonicalJSON(Object.fromEntries(pairs));
  for (let i = 0; i < 200; i++) {
    const built = {};
    for (const [k, v] of shuffle(rnd, pairs)) built[k] = v;
    assert.equal(canonicalJSON(built), canonical, `shuffle ${i}, seed 2026`);
  }
  // and the nested object is order-independent too
  assert.equal(
    canonicalJSON({ f: { text: 'Zahnarzt', date: '2026-09-10' } }),
    canonicalJSON({ f: { date: '2026-09-10', text: 'Zahnarzt' } })
  );
});

test('canonicalJSON: numeric-looking keys sort as strings, not as numbers', () => {
  // JS iterates integer-like own keys in ascending NUMERIC order before the rest, so relying on
  // Object.keys order would give "2" before "10". Canonical JSON sorts by code unit: "10" first.
  const o = {};
  o['10'] = 'ten';
  o['2'] = 'two';
  o.b = 1;
  assert.equal(canonicalJSON(o), '{"10":"ten","2":"two","b":1}');
});

test('canonicalJSON: re-serialising a parse of the output is a fixed point', () => {
  // This is exactly what a verifier does: parse the received bytes, re-canonicalise, compare.
  const value = {
    k: 'note.set', f: { text: 'Kita: Sommerfest', date: '2026-07-11', repeatsYearly: false, categoryId: null },
    nested: [{ b: 2, a: 1 }, [3, [4, { d: 'x', c: 'y' }]]],
    n: -42,
  };
  const once = canonicalJSON(value);
  assert.equal(canonicalJSON(JSON.parse(once)), once);
  assert.deepEqual(JSON.parse(once), JSON.parse(JSON.stringify(value)));
});

test('canonicalJSON: strings are NFC-normalised, values and keys alike', () => {
  const decomposed = 'fu\u0308r Oma'; // u + COMBINING DIAERESIS
  const composed = 'f\u00FCr Oma';    // precomposed LATIN SMALL LETTER U WITH DIAERESIS
  assert.notEqual(decomposed, composed, 'the two spellings really are different strings');
  assert.equal(canonicalJSON({ t: decomposed }), canonicalJSON({ t: composed }));
  assert.equal(canonicalJSON({ [decomposed]: 1 }), canonicalJSON({ [composed]: 1 }));
  assert.deepEqual(Array.from(canonicalBytes({ t: decomposed })), Array.from(canonicalBytes({ t: composed })));
});

test('canonicalJSON: refuses keys that collide only after NFC normalisation', () => {
  const o = { ['f\u00FCr']: 1, ['fu\u0308r']: 2 };
  assert.equal(Object.keys(o).length, 2);
  assert.throws(() => canonicalJSON(o), CanonError);
});

test('canonicalJSON: surrogate pairs survive; unpaired surrogates are refused', () => {
  const emoji = '\u{1F600}';
  const out = canonicalJSON({ t: emoji });
  assert.equal(JSON.parse(out).t, emoji);
  assert.deepEqual(Array.from(canonicalBytes({ t: emoji })), Array.from(utf8(out)));

  assert.throws(() => canonicalJSON({ t: 'a\uD800b' }), CanonError, 'lone high surrogate');
  assert.throws(() => canonicalJSON({ t: 'a\uDC00b' }), CanonError, 'lone low surrogate');
  assert.throws(() => canonicalJSON('\uDC00'), CanonError, 'lone low surrogate at position 0');
  assert.throws(() => canonicalJSON({ ['\uD800']: 1 }), CanonError, 'lone surrogate in a key');
});

test('canonicalJSON: combining characters and mixed scripts round-trip through UTF-8', () => {
  const rnd = mulberry32(31337);
  const alphabet = ['a', 'ä', 'é', '\u{1F600}', '中', ' ', '"', '\\', '\n', 'ß'];
  for (let i = 0; i < 100; i++) {
    let s = '';
    for (let j = 0; j < 12; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    const out = canonicalJSON({ t: s });
    assert.equal(JSON.parse(out).t, s.normalize('NFC'), `iteration ${i}, seed 31337`);
    assert.equal(utf8Decode(canonicalBytes({ t: s })), out);
  }
});

test('canonicalJSON: safe integers only — floats, NaN, Infinity and 2^53 are refused', () => {
  assert.equal(canonicalJSON(0), '0');
  assert.equal(canonicalJSON(-0), '0', '-0 collapses to 0');
  assert.equal(canonicalJSON(-42), '-42');
  assert.equal(canonicalJSON(Number.MAX_SAFE_INTEGER), '9007199254740991');
  assert.throws(() => canonicalJSON(1.5), CanonError);
  assert.throws(() => canonicalJSON(NaN), CanonError);
  assert.throws(() => canonicalJSON(Infinity), CanonError);
  assert.throws(() => canonicalJSON(-Infinity), CanonError);
  assert.throws(() => canonicalJSON(2 ** 53), CanonError);
  assert.throws(() => canonicalJSON(1e21), CanonError);
});

test('canonicalJSON: undefined is refused everywhere; null is a first-class value', () => {
  // ADR 001 §2: `null` clears a register and is a value; `undefined` is not representable, and
  // `{...entry, text: undefined}` is precisely the redaction anti-pattern ADR 004 §2 forbids.
  assert.equal(canonicalJSON(null), 'null');
  assert.equal(canonicalJSON({ nameEn: null }), '{"nameEn":null}');
  assert.throws(() => canonicalJSON(undefined), CanonError);
  assert.throws(() => canonicalJSON({ a: undefined }), CanonError);
  assert.throws(() => canonicalJSON([1, undefined]), CanonError);
  // eslint-disable-next-line no-sparse-arrays
  assert.throws(() => canonicalJSON([1, , 3]), CanonError, 'a hole reads as undefined');
});

test('canonicalJSON: refuses non-plain objects rather than routing them through toJSON()', () => {
  class Sneaky { toJSON() { return 'looks-harmless'; } }
  assert.throws(() => canonicalJSON({ x: new Sneaky() }), CanonError);
  assert.throws(() => canonicalJSON({ x: new Date(0) }), CanonError);
  assert.throws(() => canonicalJSON({ x: new Map() }), CanonError);
  assert.throws(() => canonicalJSON({ x: /re/ }), CanonError);
  assert.throws(() => canonicalJSON(() => 1), CanonError);
  assert.throws(() => canonicalJSON(1n), CanonError);
  assert.throws(() => canonicalJSON(Symbol('s')), CanonError);
  // a null-prototype object IS plain
  const bare = Object.create(null);
  bare.b = 1;
  bare.a = 2;
  assert.equal(canonicalJSON(bare), '{"a":2,"b":1}');
});

test('canonicalJSON: refuses cycles but allows a shared subtree', () => {
  const a = { x: 1 };
  a.self = a;
  assert.throws(() => canonicalJSON(a), CanonError);
  const shared = { v: 1 };
  assert.equal(canonicalJSON({ p: shared, q: shared }), '{"p":{"v":1},"q":{"v":1}}');
});

test('canonicalJSON: control characters use the escaping ECMA-262 specifies', () => {
  assert.equal(canonicalJSON('\u0000'), '"\\u0000"');
  assert.equal(canonicalJSON('\u001F'), '"\\u001f"');
  assert.equal(canonicalJSON('a\nb\tc"d\\e'), '"a\\nb\\tc\\"d\\\\e"');
});

test('canonicalBytes: is exactly the UTF-8 of canonicalJSON', () => {
  const v = { t: 'Zahnarzt äöü \u{1F600}', n: 7 };
  assert.deepEqual(Array.from(canonicalBytes(v)), Array.from(utf8(canonicalJSON(v))));
  assert.equal(utf8Decode(canonicalBytes(v)), canonicalJSON(v));
});

test('utf8Decode: refuses invalid UTF-8 rather than substituting U+FFFD', () => {
  assert.throws(() => utf8Decode(Uint8Array.from([0xff, 0xfe])), TypeError);
});

// ═════════════════════════════════════════════════════════════════════════════
// canon.js — varint
// ═════════════════════════════════════════════════════════════════════════════

test('varint: known encodings', () => {
  assert.deepEqual(Array.from(varint(0)), [0x00]);
  assert.deepEqual(Array.from(varint(1)), [0x01]);
  assert.deepEqual(Array.from(varint(127)), [0x7f]);
  assert.deepEqual(Array.from(varint(128)), [0x80, 0x01]);
  assert.deepEqual(Array.from(varint(300)), [0xac, 0x02]);
  assert.deepEqual(Array.from(varint(16383)), [0xff, 0x7f]);
  assert.deepEqual(Array.from(varint(16384)), [0x80, 0x80, 0x01]);
});

test('varint/readVarint: round-trip across the whole supported range', () => {
  const cases = [0, 1, 127, 128, 255, 256, 16383, 16384, 65535, 2 ** 21, 2 ** 31, 2 ** 40, Number.MAX_SAFE_INTEGER];
  for (const n of cases) {
    const enc = varint(n);
    const dec = readVarint(enc);
    assert.equal(dec.value, n, `round-trip ${n}`);
    assert.equal(dec.bytesRead, enc.length);
  }
  const rnd = mulberry32(5150);
  for (let i = 0; i < 300; i++) {
    const n = Math.floor(rnd() * 2 ** 32);
    assert.equal(readVarint(varint(n)).value, n, `iteration ${i}, seed 5150`);
  }
});

test('readVarint: honours the offset and reports how far it read', () => {
  const frame = new Uint8Array([0xaa, ...varint(300), 0x01, 0x02]);
  const { value, bytesRead } = readVarint(frame, 1);
  assert.equal(value, 300);
  assert.equal(bytesRead, 2);
  assert.equal(frame[1 + bytesRead], 0x01, 'the payload starts right after the length prefix');
});

test('varint: refuses negative and non-integer lengths; readVarint refuses truncation and padding', () => {
  assert.throws(() => varint(-1), CanonError);
  assert.throws(() => varint(1.5), CanonError);
  assert.throws(() => varint(2 ** 53), CanonError);
  assert.throws(() => readVarint(new Uint8Array([0x80])), CanonError, 'truncated');
  assert.throws(() => readVarint(new Uint8Array([])), CanonError, 'empty');
  // 0x80 0x00 is a non-minimal encoding of 0 — one length must have one spelling.
  assert.throws(() => readVarint(new Uint8Array([0x80, 0x00])), CanonError);
});

// ═════════════════════════════════════════════════════════════════════════════
// ids.js — SHA-256 (present only so deviceShortOf can be synchronous)
// ═════════════════════════════════════════════════════════════════════════════

test('sha256: the three FIPS 180-4 test vectors', () => {
  assert.equal(hex(sha256(utf8(''))), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(hex(sha256(utf8('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    hex(sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
  );
});

test('sha256: agrees with WebCrypto over every length 0..200 and across block boundaries', async () => {
  // WebCrypto is the independent oracle, and it is the same primitive ADR 002 uses everywhere
  // else. Lengths 55/56/63/64/119/120 straddle the padding and block boundaries.
  const rnd = mulberry32(0xBEEF);
  const lengths = [...Array(201).keys(), 1000, 4096];
  for (const n of lengths) {
    const bytes = seededBytes(rnd, n);
    const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    assert.equal(hex(sha256(bytes)), hex(expected), `length ${n}, seed 0xBEEF`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ids.js — identifiers
// ═════════════════════════════════════════════════════════════════════════════

test('opId / groupId: 22-char base64url with no time component', () => {
  const zeros = (n) => new Uint8Array(n);
  assert.equal(opId(zeros), 'A'.repeat(22));
  assert.equal(groupId(zeros), 'A'.repeat(22));
  const id = opId((n) => Uint8Array.from({ length: n }, (_, i) => i));
  assert.equal(id.length, 22);
  assert.deepEqual(Array.from(ub64(id)), [...Array(16).keys()]);
});

test('opId: the randomness source is injected, so ids are reproducible in a test', () => {
  const rnd = mulberry32(2024);
  const rand = (n) => seededBytes(rnd, n);
  const a = opId(rand);
  const rnd2 = mulberry32(2024);
  const b = opId((n) => seededBytes(rnd2, n));
  assert.equal(a, b, 'same seed, same id');
  assert.notEqual(a, opId(rand), 'the stream advances');
});

test('opId: the default source is the platform CSPRNG and yields distinct ids', () => {
  const ids = new Set();
  for (let i = 0; i < 64; i++) ids.add(opId());
  assert.equal(ids.size, 64);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(defaultRandom(16).length, 16);
});

test('opId: a random source that returns the wrong shape is a loud error', () => {
  assert.throws(() => opId(() => new Uint8Array(8)), /Uint8Array of length 16/);
  assert.throws(() => opId(() => [0, 1, 2]), /Uint8Array of length 16/);
});

test('memberId / deviceId / spaceId carry their prefixes', () => {
  const zeros = (n) => new Uint8Array(n);
  assert.equal(memberId(zeros), 'mem_' + 'A'.repeat(22));
  assert.equal(deviceId(zeros), 'dev_' + 'A'.repeat(22));
  assert.equal(spaceId('family', zeros), 'fsp_' + 'A'.repeat(22));
  assert.equal(spaceId('personal', zeros), 'psp_' + 'A'.repeat(22));
});

test('spaceId: an unknown kind is refused rather than quietly minting a personal space', () => {
  assert.throws(() => spaceId('familiy'), /family/);
  assert.throws(() => spaceId(undefined), /family/);
});

test('entityUuid: v1 uuids, and the source is injectable', () => {
  assert.equal(entityUuid(() => 'fixed-uuid'), 'fixed-uuid');
  assert.match(entityUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('deviceShortOf: 16 Crockford characters, deterministic, and derived from the key', () => {
  const keyA = utf8('raw-p256-public-key-A');
  const keyB = utf8('raw-p256-public-key-B');
  const a = deviceShortOf(keyA);
  assert.equal(a.length, 16);
  assert.ok(isDeviceShort(a), `${a} is not a valid deviceShort`);
  assert.equal(deviceShortOf(keyA), a, 'a device cannot claim two identities');
  assert.notEqual(deviceShortOf(keyB), a);
  // it really is the first 80 bits of the digest
  assert.equal(a, crock32(sha256(keyA).subarray(0, 10)));
  assert.equal(deviceShort, deviceShortOf, 'ADR 005 and ops.contract.js name the same function');
});

test('deviceShortOf: the digest is injectable, and a bad digest is refused', () => {
  const fake = () => new Uint8Array(32).fill(0);
  assert.equal(deviceShortOf(utf8('anything'), fake), '0'.repeat(16));
  assert.throws(() => deviceShortOf(utf8('x'), () => new Uint8Array(16)), /32 bytes/);
});

test('deviceShortOf: 128 distinct keys give 128 distinct shorts', () => {
  const shorts = new Set();
  for (let i = 0; i < 128; i++) shorts.add(deviceShortOf(utf8(`key-${i}`)));
  assert.equal(shorts.size, 128);
});

test('ZERO_DEVICE_SHORT is a true minimum — the migration stamp depends on it', () => {
  assert.equal(ZERO_DEVICE_SHORT, '0'.repeat(16));
  assert.ok(isDeviceShort(ZERO_DEVICE_SHORT));
  const rnd = mulberry32(808);
  for (let i = 0; i < 200; i++) {
    const other = crock32(seededBytes(rnd, 10));
    assert.ok(ZERO_DEVICE_SHORT <= other, `${other} sorts below the all-zeros short`);
  }
});

test('isDeviceShort: rejects the wrong width and the excluded letters', () => {
  assert.equal(isDeviceShort('7QAR2MZ9XKPNC0GV'), true);
  assert.equal(isDeviceShort('7QAR2MZ9XKPNC0G'), false, '15 characters');
  assert.equal(isDeviceShort('7QAR2MZ9XKPNC0GVV'), false, '17 characters');
  assert.equal(isDeviceShort('IIIIIIIIIIIIIIII'), false, 'I is not in the alphabet');
  assert.equal(isDeviceShort('7qar2mz9xkpnc0gv'), false, 'lower case is not canonical');
  assert.equal(isDeviceShort(null), false);
});

// ═════════════════════════════════════════════════════════════════════════════
// stamp.js — format and accessors
// ═════════════════════════════════════════════════════════════════════════════

test('fmt: the ADR 001 §1.3 example, at exactly 37 characters', () => {
  const s = fmt(1787836800123, 3, DEV_A);
  assert.equal(s, '1787836800123.000003.7QAR2MZ9XKPNC0GV');
  assert.equal(s.length, STAMP_LENGTH);
  assert.equal(fmt(0, 0, ZERO_DEVICE_SHORT), '0000000000000.000000.0000000000000000');
  assert.equal(fmt(0, 0, ZERO_DEVICE_SHORT).length, 37);
});

test('fmt: every field is fixed width, so string order is tuple order', () => {
  const rnd = mulberry32(606);
  for (let i = 0; i < 200; i++) {
    const ms = Math.floor(rnd() * 1e13);
    const ctr = Math.floor(rnd() * 1e6);
    const s = fmt(ms, ctr, DEV_A);
    assert.equal(s.length, 37, `${s}`);
    assert.equal(msOf(s), ms);
    assert.equal(ctrOf(s), ctr);
    assert.equal(devOf(s), DEV_A);
  }
});

test('fmt: refuses anything that would break the fixed width', () => {
  assert.throws(() => fmt(-1, 0, DEV_A), RangeError);
  assert.throws(() => fmt(1e13, 0, DEV_A), RangeError, '14 digits would widen the field');
  assert.throws(() => fmt(1.5, 0, DEV_A), RangeError);
  assert.throws(() => fmt(0, 1000000, DEV_A), RangeError);
  assert.throws(() => fmt(0, -1, DEV_A), RangeError);
  assert.throws(() => fmt(0, 0, 'short'), TypeError);
  assert.throws(() => fmt(0, 0, 'IIIIIIIIIIIIIIII'), TypeError);
});

test('isStamp / parse: accept the real shape and nothing else', () => {
  const s = fmt(T0, 3, DEV_A);
  assert.equal(isStamp(s), true);
  assert.deepEqual(parse(s), { ms: T0, ctr: 3, dev: DEV_A });
  assert.equal(isStamp('1787836800123.000003.7QAR2MZ9XKPNC0G'), false);
  assert.equal(isStamp('1787836800123-000003-7QAR2MZ9XKPNC0GV'), false);
  assert.equal(isStamp(''), false);
  assert.equal(isStamp(undefined), false);
  assert.throws(() => parse('nope'), TypeError);
});

// ═════════════════════════════════════════════════════════════════════════════
// stamp.js — the ordering contract
// ═════════════════════════════════════════════════════════════════════════════

test('cmp: is a strict total order, and it agrees with plain string comparison', () => {
  const rnd = mulberry32(4321);
  const stamps = [];
  for (let i = 0; i < 120; i++) {
    stamps.push(fmt(Math.floor(rnd() * 1e13), Math.floor(rnd() * 1e6), rnd() < 0.5 ? DEV_A : DEV_B));
  }
  // antisymmetry and reflexivity
  for (const a of stamps) {
    assert.equal(cmp(a, a), 0);
    for (const b of stamps) assert.equal(cmp(a, b) + cmp(b, a), 0, `antisymmetry: ${a} vs ${b}`);
  }
  // sorting by cmp is sorting as strings
  assert.deepEqual(stamps.slice().sort(cmp), stamps.slice().sort());
  // transitivity, over every ordered triple of a smaller sample
  const sample = stamps.slice(0, 25);
  for (const a of sample) {
    for (const b of sample) {
      for (const c of sample) {
        if (cmp(a, b) < 0 && cmp(b, c) < 0) assert.ok(cmp(a, c) < 0, `${a} < ${b} < ${c}`);
      }
    }
  }
});

test('cmp: orders by wallMillis, then counter, then deviceShort — in that order', () => {
  assert.equal(cmp(fmt(1, 0, DEV_A), fmt(2, 0, DEV_A)), -1, 'millis dominate');
  assert.equal(cmp(fmt(2, 0, DEV_A), fmt(1, 999999, DEV_A)), 1, 'millis beat a huge counter');
  assert.equal(cmp(fmt(1, 0, DEV_A), fmt(1, 1, DEV_A)), -1, 'then the counter');
  assert.equal(cmp(fmt(1, 1, DEV_B), fmt(1, 1, DEV_A)), -1, 'then the device short');
  assert.equal(cmp(fmt(1, 1, DEV_A), fmt(1, 1, DEV_A)), 0, 'the same write ties with itself');
});

// ═════════════════════════════════════════════════════════════════════════════
// stamp.js — the clock
// ═════════════════════════════════════════════════════════════════════════════

test('createClock: the wall clock is injected — there is no default', () => {
  assert.throws(() => createClock(DEV_A), /now/);
  assert.throws(() => createClock(DEV_A, 12345), /now/);
  assert.throws(() => createClock('nope', () => T0), TypeError);
  assert.throws(() => createClock(DEV_A, () => -1).tick(), RangeError);
});

test('tick: strictly monotonic under a FROZEN wall clock — the counter carries the order', () => {
  const wall = fakeClock(T0);
  const clock = createClock(DEV_A, wall.now);
  const seen = [];
  for (let i = 0; i < 1000; i++) seen.push(clock.tick());
  for (let i = 1; i < seen.length; i++) {
    assert.ok(cmp(seen[i - 1], seen[i]) < 0, `stamp ${i} did not advance: ${seen[i - 1]} -> ${seen[i]}`);
  }
  assert.equal(new Set(seen).size, 1000, 'no two local writes may share a stamp');
  assert.equal(msOf(seen[0]), T0);
  assert.equal(ctrOf(seen[0]), 0);
  assert.equal(ctrOf(seen[999]), 999);
  assert.equal(msOf(seen[999]), T0, 'a frozen wall clock never moves the millis field');
});

test('tick: follows the wall clock forward and resets the counter', () => {
  const wall = fakeClock(T0);
  const clock = createClock(DEV_A, wall.now);
  clock.tick();
  clock.tick();
  assert.equal(ctrOf(clock.peek()), 1);
  wall.advance(5);
  const s = clock.tick();
  assert.equal(msOf(s), T0 + 5);
  assert.equal(ctrOf(s), 0);
});

test('tick: stays monotonic when the wall clock steps BACKWARDS (an NTP correction)', () => {
  // If the counter did not carry the order here, a clock correction would let a later write lose
  // to an earlier one, and LWW would silently discard the newer edit.
  const wall = fakeClock(T0);
  const clock = createClock(DEV_A, wall.now);
  const before = clock.tick();
  wall.set(T0 - 60_000);
  const after = clock.tick();
  assert.ok(cmp(before, after) < 0, `${before} -> ${after}`);
  assert.equal(msOf(after), T0, 'the clock does not travel backwards');
  assert.equal(ctrOf(after), 1);
});

test('tick: counter overflow at 999999 rolls into the next millisecond', () => {
  const wall = fakeClock(T0);
  const clock = createClock(DEV_A, wall.now, { state: { ms: T0, ctr: MAX_STAMP_CTR } });
  const s = clock.tick();
  assert.equal(msOf(s), T0 + 1);
  assert.equal(ctrOf(s), 0);
  assert.ok(cmp(fmt(T0, MAX_STAMP_CTR, DEV_A), s) < 0);
});

test('peek: reports the current state without minting anything', () => {
  const wall = fakeClock(T0);
  const clock = createClock(DEV_A, wall.now);
  assert.equal(clock.peek(), fmt(0, 0, DEV_A), 'a fresh clock is at the origin');
  const s = clock.tick();
  assert.equal(clock.peek(), s);
  assert.equal(clock.peek(), s, 'peek does not mutate');
  assert.deepEqual(clock.save(), { ms: T0, ctr: 0 });
});

test('save / restore: a persisted clock resumes without ever reissuing a stamp', () => {
  const wall = fakeClock(T0);
  const first = createClock(DEV_A, wall.now);
  const a = first.tick();
  const b = first.tick();
  const resumed = createClock(DEV_A, wall.now, { state: first.save() });
  const c = resumed.tick();
  assert.ok(cmp(b, c) < 0, `${b} -> ${c}`);
  assert.equal(new Set([a, b, c]).size, 3);
  assert.throws(() => createClock(DEV_A, wall.now, { state: { ms: -1, ctr: 0 } }), RangeError);
});

// ── the HLC receive rule ─────────────────────────────────────────────────────

test('observe: a higher remote stamp advances this clock past it', () => {
  const wall = fakeClock(T0);
  const clock = createClock(DEV_A, wall.now);
  clock.tick();
  const remote = fmt(T0 + 10_000, 7, DEV_B);
  clock.observe(remote);
  const next = clock.tick();
  assert.ok(cmp(remote, next) < 0, `${remote} -> ${next}`);
  assert.equal(msOf(next), T0 + 10_000);
});

test('observe: NEVER rewrites the received stamp', () => {
  // ADR 001 §1.3: absorbing can only change FUTURE local stamps, so it cannot change any merge
  // outcome on any device.
  const wall = fakeClock(T0);
  const clock = createClock(DEV_A, wall.now);
  const remote = fmt(T0 + 5, 2, DEV_B);
  const copy = String(remote);
  clock.observe(remote);
  assert.equal(remote, copy);
});

test('observe: at the same millisecond the counter takes the greater of the two, plus one', () => {
  const wall = fakeClock(T0);
  const clock = createClock(DEV_A, wall.now);
  clock.tick();
  clock.tick();
  clock.tick(); // ctr = 2
  assert.equal(ctrOf(clock.peek()), 2);
  clock.observe(fmt(T0, 9, DEV_B));
  assert.equal(msOf(clock.peek()), T0);
  assert.equal(ctrOf(clock.peek()), 10);
  const next = clock.tick();
  assert.ok(cmp(fmt(T0, 9, DEV_B), next) < 0);
});

test('observe: an older remote stamp never drags this clock backwards', () => {
  const wall = fakeClock(T0);
  const clock = createClock(DEV_A, wall.now);
  const mine = clock.tick();
  clock.observe(fmt(T0 - 3_600_000, 999, DEV_B));
  const next = clock.tick();
  assert.ok(cmp(mine, next) < 0);
  assert.equal(msOf(next), T0, 'an op from an hour ago does not move the millis field back');
  // ...and the old op is still perfectly usable: nothing is discarded for being old.
  assert.equal(isTooFarFuture(fmt(T0 - 3_600_000, 999, DEV_B), T0), false);
});

test('observe: physical time wins over both and resets the counter', () => {
  const wall = fakeClock(T0);
  const clock = createClock(DEV_A, wall.now);
  clock.tick();
  wall.advance(1000);
  clock.observe(fmt(T0 + 10, 5, DEV_B));
  assert.equal(msOf(clock.peek()), T0 + 1000);
  assert.equal(ctrOf(clock.peek()), 0);
});

test('observe: a stamp beyond MAX_FUTURE_DRIFT_MS is NOT adopted — the op is parked, not lost', () => {
  // ADR 001 §1.3 / §7.4: a peer with a broken clock must not drag ours forward, and its work
  // must not be silently dropped either.
  const wall = fakeClock(T0);
  const clock = createClock(DEV_A, wall.now);
  const before = clock.tick();
  const wild = fmt(T0 + MAX_FUTURE_DRIFT_MS + 1, 0, DEV_B);
  assert.equal(isTooFarFuture(wild, T0), true);
  clock.observe(wild);
  assert.equal(msOf(clock.peek()), T0, 'the wall clock field is untouched');
  const after = clock.tick();
  assert.ok(cmp(before, after) < 0);
  assert.ok(cmp(after, wild) < 0, 'we simply have not caught up with it — that is what parking is for');
});

test('observe: the future clamp is a strict boundary — exactly +24 h is still adopted', () => {
  const wall = fakeClock(T0);
  const clock = createClock(DEV_A, wall.now);
  const edge = fmt(T0 + MAX_FUTURE_DRIFT_MS, 4, DEV_B);
  assert.equal(isTooFarFuture(edge, T0), false);
  clock.observe(edge);
  assert.equal(msOf(clock.peek()), T0 + MAX_FUTURE_DRIFT_MS);
  assert.equal(MAX_FUTURE_DRIFT_MS, 24 * 60 * 60 * 1000);
});

test('observe: once local time catches up, the parked stamp is unremarkable', () => {
  const wall = fakeClock(T0);
  const parked = fmt(T0 + MAX_FUTURE_DRIFT_MS + 60_000, 0, DEV_B);
  assert.equal(isTooFarFuture(parked, wall.now()), true);
  wall.advance(120_000);
  assert.equal(isTooFarFuture(parked, wall.now()), false, 're-evaluated when wall time advances past it');
});

test('observe: refuses something that is not a stamp', () => {
  const clock = createClock(DEV_A, fakeClock(T0).now);
  assert.throws(() => clock.observe('garbage'), TypeError);
  assert.throws(() => clock.observe(undefined), TypeError);
});

// ── the device tiebreak ──────────────────────────────────────────────────────

test('two devices with identical clocks never produce an equal stamp', () => {
  // This is what makes the LWW rule total: there is no "concurrent" case it declines to resolve.
  const wall = fakeClock(T0);
  const a = createClock(DEV_A, wall.now);
  const b = createClock(DEV_B, wall.now);
  const all = new Set();
  for (let i = 0; i < 500; i++) {
    const sa = a.tick();
    const sb = b.tick();
    assert.notEqual(sa, sb, `iteration ${i}`);
    assert.notEqual(cmp(sa, sb), 0);
    assert.equal(msOf(sa), msOf(sb));
    assert.equal(ctrOf(sa), ctrOf(sb));
    assert.equal(devOf(sa), DEV_A);
    assert.equal(devOf(sb), DEV_B);
    all.add(sa);
    all.add(sb);
  }
  assert.equal(all.size, 1000);
});

test('the device short is the LAST tiebreak, never an earlier one', () => {
  const wall = fakeClock(T0);
  const lowDevice = createClock(DEV_B, wall.now); // '0123...' sorts below '7QAR...'
  const highDevice = createClock(DEV_A, wall.now);
  const early = highDevice.tick();               // same ms, ctr 0, high device
  wall.advance(1);
  const late = lowDevice.tick();                 // later ms, ctr 0, low device
  assert.ok(cmp(early, late) < 0, 'a later write wins even from the lexically smaller device');
});

// ── skew ─────────────────────────────────────────────────────────────────────

test('skew: zero until a server time has been seen, then the signed difference', () => {
  const wall = fakeClock(T0);
  const clock = createClock(DEV_A, wall.now);
  assert.equal(clock.skew(), 0);
  clock.observeServerTime(T0 - 300_000);
  assert.equal(clock.skew(), 300_000, 'this Mac reads five minutes ahead of the server');
  clock.observeServerTime(T0 + 1_000);
  assert.equal(clock.skew(), -1_000);
  assert.throws(() => clock.observeServerTime('now'), TypeError);
});

// ═════════════════════════════════════════════════════════════════════════════
// Cross-module: the shapes the rest of v2 is built on
// ═════════════════════════════════════════════════════════════════════════════

test('the GENESIS stamp shape loses to every real stamp, on every device', () => {
  // ADR 001 §8.1: migration stamps encode only the v1 array index, so everything pre-existing
  // loses to every future edit and two migrations of the same file are byte-identical.
  const genesis = (i) => fmt(0, i, ZERO_DEVICE_SHORT);
  assert.equal(genesis(0), '0000000000000.000000.0000000000000000');
  assert.equal(genesis(12), '0000000000000.000012.0000000000000000');
  assert.equal(genesis(12).length, 37);
  assert.ok(cmp(genesis(3), genesis(4)) < 0, 'the index preserves v1 array order');

  const wall = fakeClock(T0);
  for (const dev of [DEV_A, DEV_B, ZERO_DEVICE_SHORT]) {
    const s = createClock(dev, wall.now).tick();
    assert.ok(cmp(genesis(999999), s) < 0, `${genesis(999999)} must lose to ${s}`);
  }
});

test('an op envelope canonicalises identically whichever device built it', () => {
  // The end-to-end shape of what gets signed (ADR 002 §5.3): every id here comes from ids.js,
  // the stamp from stamp.js, and the bytes from canon.js.
  const zeros = (n) => new Uint8Array(n);
  const wall = fakeClock(T0);
  const clock = createClock(deviceShortOf(utf8('pubkey')), wall.now);
  const op = {
    v: 1,
    id: opId(zeros),
    ts: clock.tick(),
    space: spaceId('personal', zeros),
    act: memberId(zeros),
    dev: deviceId(zeros),
    gid: groupId(zeros),
    k: 'note.set',
    e: 'note:' + entityUuid(() => '5e1a-9c'),
    f: { date: '2026-09-10', text: 'Zahnarzt' },
  };
  const reordered = {};
  for (const k of Object.keys(op).reverse()) reordered[k] = op[k];
  assert.equal(canonicalJSON(reordered), canonicalJSON(op));

  const bytes = canonicalBytes(op);
  const framed = new Uint8Array([...varint(bytes.length), ...bytes]);
  const { value, bytesRead } = readVarint(framed);
  assert.equal(value, bytes.length);
  assert.deepEqual(Array.from(framed.subarray(bytesRead)), Array.from(bytes));
  assert.equal(isStamp(op.ts), true);
  assert.match(op.e, /^note:/);
});
