// src/js/core/ids.js — identifiers.  ADR 001 §1.2, ops.contract.js §1.
//
// DOM-free, I/O-free, dependency-free (ADR 005 §2).
//
// NO ULIDs, ANYWHERE (ADR 001 §1.2). The op id is server-visible — it is the idempotency key —
// and a ULID's leading 48 bits are the authoring wall clock. That would hand the relay the
// creation time of every op, including ops written three weeks offline on a train, for free.
// `receivedAt` already tells the server when an op ARRIVED; authoring time is a strictly
// additional metadata leak we decline at zero cost (story 21.3). Sortability buys nothing:
// delivery order is the server's `seq` and merge order is the HLC stamp.
//
// RANDOMNESS AND UUIDs ARE INJECTED.
// Every generator takes its entropy source as a trailing parameter that defaults to the platform
// CSPRNG, so the zero-argument call matches ops.contract.js exactly while tests can pin a seeded
// source and get reproducible ids. `Math.random()` is banned in core/ (ADR 005 §2) and does not
// appear here; the default is `crypto.getRandomValues`, which is a real CSPRNG in Node and in
// WebKit alike, and `crypto.randomUUID`, which is what v1 already uses (store.js:14).

import { b64u, crock32 } from './b64.js';

/** @typedef {(n:number) => Uint8Array} RandomSource */

/** The platform CSPRNG. @type {RandomSource} */
export const defaultRandom = (n) => crypto.getRandomValues(new Uint8Array(n));

/** v1's scheme, unchanged. Entity uuids are NEVER re-keyed (ADR 001 §1.2). */
export const defaultUuid = () => crypto.randomUUID();

/** 16 bytes = 128 bits -> 22 base64url characters, the width every machine id below uses. */
const ID_BYTES = 16;

function draw(rand, n, who) {
  const b = rand(n);
  if (!(b instanceof Uint8Array) || b.length !== n) {
    throw new Error(`${who}: the injected random source must return a Uint8Array of length ${n}`);
  }
  return b;
}

/**
 * v1's entity id scheme, carried into v2 verbatim. Migration keeps existing values (ADR 001
 * §1.2): re-keying would gain no ordering — the stamp provides it — destroy external references,
 * and break the byte-identical-double-migration property in §8.1.
 * @param {() => string} [uuid]
 * @returns {string}
 */
export function entityUuid(uuid = defaultUuid) {
  return uuid();
}

/**
 * 22-char base64url, 128 CSPRNG bits, NO time component. The server's idempotency key.
 * @param {RandomSource} [rand]
 * @returns {string}
 */
export function opId(rand = defaultRandom) {
  return b64u(draw(rand, ID_BYTES, 'opId'));
}

/**
 * Transaction group — the unit of undo. Never leaves the device, and has no effect on merge
 * (ADR 001 §2).
 * @param {RandomSource} [rand]
 * @returns {string}
 */
export function groupId(rand = defaultRandom) {
  return b64u(draw(rand, ID_BYTES, 'groupId'));
}

/**
 * The acting human. Pseudonymous: it is what the relay sees, and it is what 17.6 renders as
 * "von Mama" only after a local member record supplies the display name.
 * @param {RandomSource} [rand]
 * @returns {string}
 */
export function memberId(rand = defaultRandom) {
  return 'mem_' + b64u(draw(rand, ID_BYTES, 'memberId'));
}

/**
 * The authoring device.
 * @param {RandomSource} [rand]
 * @returns {string}
 */
export function deviceId(rand = defaultRandom) {
  return 'dev_' + b64u(draw(rand, ID_BYTES, 'deviceId'));
}

/**
 * @param {'family'|'personal'} kind
 * @param {RandomSource} [rand]
 * @returns {string} 'fsp_' | 'psp_' + 22 base64url
 */
export function spaceId(kind, rand = defaultRandom) {
  if (kind !== 'family' && kind !== 'personal') {
    throw new Error(`spaceId: kind must be 'family' or 'personal', got ${JSON.stringify(kind)}`);
  }
  return (kind === 'family' ? 'fsp_' : 'psp_') + b64u(draw(rand, ID_BYTES, 'spaceId'));
}

// ─────────────────────────────────────────────────────────────────────────────
// deviceShort — the stamp tiebreak
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The all-zeros device short. Every Crockford character sorts at or above '0', so this is a
 * true minimum — which is what makes the GENESIS stamp of a v1 migration lose to every real
 * stamp on every device (ADR 001 §1.2, §8.1).
 */
export const ZERO_DEVICE_SHORT = '0'.repeat(16);

/** Exactly 16 Crockford characters. */
const DEVICE_SHORT_RE = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{16}$/;

/** @param {unknown} s @returns {boolean} */
export function isDeviceShort(s) {
  return typeof s === 'string' && DEVICE_SHORT_RE.test(s);
}

/**
 * `crock32(SHA-256(rawSigPublicKey).slice(0, 10))` -> 16 Crockford characters = 80 bits.
 *
 * Deliberately DETERMINISTIC and deliberately SYNCHRONOUS.
 *   * Deterministic, so a device cannot claim two identities and the server can bind a
 *     deviceShort to a public key at registration.
 *   * 80 bits, so no server-side collision check is needed — a 16-device family collides with
 *     probability around 1e-20.
 *   * Synchronous, because `foldAuthorized` (ADR 001 §4.0) and `openOp`'s post-decrypt identity
 *     check (ADR 002 §5.2) both need it inside code the contracts type as returning a value,
 *     not a promise. WebCrypto's digest is async, so the hash is computed by the small pure
 *     SHA-256 below rather than by `crypto.subtle`. It is injected, so `src/js/crypto/` may
 *     substitute a WebCrypto-backed digest where it is already in async context.
 *
 * @param {Uint8Array|ArrayBuffer|number[]} rawSigPub the raw (uncompressed) P-256 point, 65 bytes
 * @param {(b:Uint8Array|ArrayBuffer|number[]) => Uint8Array} [sha] injected digest, 32 bytes out
 * @returns {string} 16 Crockford base32 characters
 */
export function deviceShortOf(rawSigPub, sha = sha256) {
  const digest = sha(rawSigPub);
  if (!(digest instanceof Uint8Array) || digest.length !== 32) {
    throw new Error('deviceShortOf: the digest function must return 32 bytes');
  }
  return crock32(digest.subarray(0, 10));
}

/** ADR 005 §1.1 names this one `deviceShort`; ops.contract.js names it `deviceShortOf`. Same
 *  function, both spellings, so neither document has to be wrong. */
export const deviceShort = deviceShortOf;

// ─────────────────────────────────────────────────────────────────────────────
// SHA-256 — FIPS 180-4, ~50 lines, no dependency
//
// Present only because `deviceShortOf` must be synchronous (see above). It is not a general
// crypto facility: everything else in the product uses WebCrypto (ADR 002). Verified against
// the three standard test vectors in tests/tier1/core-primitives.test.js.
// ─────────────────────────────────────────────────────────────────────────────

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function toBytes(b) {
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  if (Array.isArray(b)) return Uint8Array.from(b);
  throw new Error('sha256: expected bytes');
}

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

/**
 * @param {Uint8Array|ArrayBuffer|number[]} input
 * @returns {Uint8Array} 32 bytes
 */
export function sha256(input) {
  const msg = toBytes(input);
  const l = msg.length;
  const padded = new Uint8Array(((l + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[l] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(l / 0x20000000));
  view.setUint32(padded.length - 4, ((l % 0x20000000) * 8) >>> 0);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, h0); ov.setUint32(4, h1); ov.setUint32(8, h2); ov.setUint32(12, h3);
  ov.setUint32(16, h4); ov.setUint32(20, h5); ov.setUint32(24, h6); ov.setUint32(28, h7);
  return out;
}
