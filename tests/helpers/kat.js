// tests/helpers/kat.js — known-answer material for LZP-CRYPTO-1's DETERMINISTIC halves.
//
// WHAT A KNOWN-ANSWER TEST IS FOR HERE, AND WHAT IT MUST NOT BE USED FOR
// ---------------------------------------------------------------------
// ADR 002 §1 rule 1 is absolute: **ECDSA is non-deterministic in BOTH engines**, so there are no
// golden signatures anywhere in this repository and there never will be. What IS deterministic —
// and therefore what belongs here — is every derivation and every digest:
//
//     SHA-256 · HKDF-SHA-256 · PBKDF2-SHA-256 · Crockford base32 · deviceShort
//
// Two independent kinds of evidence, because they catch different faults:
//
//   1. PUBLISHED VECTORS. RFC 6234's SHA-256 answers and RFC 5869's HKDF test case 1. These
//      catch "both of our implementations are wrong in the same way".
//   2. A SECOND IMPLEMENTATION. The HMAC-SHA-256 below is built on `src/js/core/ids.js`'s own
//      hand-rolled SHA-256 — the ~50-line one that exists because `deviceShortOf` must be
//      synchronous while `crypto.subtle.digest` is not — and HKDF and PBKDF2 are then derived
//      from it in the plainest possible way. Asserting that WebCrypto agrees with it is the only
//      thing that can catch the failure that would otherwise be invisible: `core/ids.js`'s digest
//      and the platform's digest quietly being *different functions*. If they were, every
//      `deviceShort` in the product would be wrong, and no amount of testing SHA-256 vectors
//      against one of them alone would say so.
//
// This is a HELPER rather than test-file code because `tests/tier1/suite-integrity.test.js`
// requires every tier-1 test body to assert, and a reference implementation is not a test.

import { sha256 } from '../../src/js/core/ids.js';

const BLOCK = 64; // SHA-256's block size, in bytes
const OUT = 32;

/** @param {string} hex @returns {Uint8Array} */
export function hex(hexString) {
  const clean = hexString.replace(/\s+/g, '');
  if (clean.length % 2 !== 0) throw new Error('hex: odd length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** @param {Uint8Array|ArrayBuffer} bytes @returns {string} */
export function toHex(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** @param {...Uint8Array} parts @returns {Uint8Array} */
export function cat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** FIPS 198-1 HMAC, over `core/ids.js`'s SHA-256. @returns {Uint8Array} 32 bytes */
export function hmacSha256(key, message) {
  let k = key.length > BLOCK ? sha256(key) : key;
  const padded = new Uint8Array(BLOCK);
  padded.set(k);
  const ipad = new Uint8Array(BLOCK);
  const opad = new Uint8Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    ipad[i] = padded[i] ^ 0x36;
    opad[i] = padded[i] ^ 0x5c;
  }
  return sha256(cat(opad, sha256(cat(ipad, message))));
}

/** RFC 5869 §2.2. @returns {Uint8Array} 32 bytes */
export function hkdfExtract(salt, ikm) {
  return hmacSha256(salt, ikm);
}

/** RFC 5869 §2.3. @returns {Uint8Array} `length` bytes */
export function hkdfExpand(prk, info, length) {
  const n = Math.ceil(length / OUT);
  if (n > 255) throw new Error('hkdfExpand: length too large');
  const out = new Uint8Array(n * OUT);
  let t = new Uint8Array(0);
  for (let i = 1; i <= n; i++) {
    t = hmacSha256(prk, cat(t, info, Uint8Array.of(i)));
    out.set(t, (i - 1) * OUT);
  }
  return out.subarray(0, length);
}

/** The whole of RFC 5869 in one call — what `crypto.subtle.deriveBits({name:'HKDF'})` performs. */
export function hkdf(salt, ikm, info, length) {
  return hkdfExpand(hkdfExtract(salt, ikm), info, length);
}

/** RFC 8018 §5.2, PBKDF2-HMAC-SHA-256. Slow on purpose; keep `iterations` small in tests. */
export function pbkdf2(password, salt, iterations, length) {
  const blocks = Math.ceil(length / OUT);
  const out = new Uint8Array(blocks * OUT);
  for (let b = 1; b <= blocks; b++) {
    const be = Uint8Array.of((b >>> 24) & 255, (b >>> 16) & 255, (b >>> 8) & 255, b & 255);
    let u = hmacSha256(password, cat(salt, be));
    const acc = u.slice();
    for (let i = 1; i < iterations; i++) {
      u = hmacSha256(password, u);
      for (let j = 0; j < OUT; j++) acc[j] ^= u[j];
    }
    out.set(acc, (b - 1) * OUT);
  }
  return out.subarray(0, length);
}

// ─────────────────────────────────────────────────────────────────────────────
// Published vectors
// ─────────────────────────────────────────────────────────────────────────────

const TE = new TextEncoder();

/** FIPS 180-4 / RFC 6234's three standard SHA-256 answers. */
export const SHA256_VECTORS = Object.freeze([
  { input: TE.encode('abc'), hex: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
  { input: TE.encode(''), hex: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
  {
    input: TE.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    hex: '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  },
]);

/** RFC 5869 test case 1 — HKDF-SHA-256, the exact primitive `LZP-CRYPTO-1` derives with. */
export const HKDF_RFC5869_CASE1 = Object.freeze({
  ikm: hex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'),
  salt: hex('000102030405060708090a0b0c'),
  info: hex('f0f1f2f3f4f5f6f7f8f9'),
  length: 42,
  prk: '077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5',
  okm: '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
});

/**
 * `deviceShort` answers, pinned. `crock32(SHA-256(rawSigPub)[0..10])` is a wire-format value: it
 * is the last 16 characters of every stamp a device writes (ADR 001 §1.3) and the `dv` the relay
 * routes on (ADR 003 §2). A change to any of the three functions in that chain — the digest, the
 * 10-byte truncation, or the Crockford alphabet — is a change to the wire, and these rows are
 * what make it show up as a red test instead of as a family that stops syncing.
 *
 * The inputs are not real public keys and do not need to be: `deviceShortOf` hashes 65 bytes and
 * does not care whether they are on the curve.
 */
export const DEVICE_SHORT_VECTORS = Object.freeze([
  { name: '65 zero bytes', input: new Uint8Array(65), short: 'K3745QQFA7A04TEN' },
  { name: '0x00..0x40', input: Uint8Array.from({ length: 65 }, (_, i) => i), short: '9FYJS2VF3VP7MAQY' },
  {
    name: 'a 0x04-prefixed point',
    input: Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : (i * 7) % 256)),
    short: 'ER58SEE5W7SY3FKX',
  },
]);

/** Crockford base32 answers for the exact 10-byte width `deviceShort` uses. */
export const CROCK32_VECTORS = Object.freeze([
  { input: new Uint8Array(10), out: '0000000000000000' },
  { input: new Uint8Array(10).fill(0xff), out: 'ZZZZZZZZZZZZZZZZ' },
  { input: Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), out: '000G40R40M30E209' },
]);
