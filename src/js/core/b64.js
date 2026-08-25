// src/js/core/b64.js — base64url and Crockford base32.  ADR 001 §1.2, ADR 002 §6.2.
//
// DOM-free, I/O-free, dependency-free (ADR 005 §2).
//
// Two alphabets, two jobs:
//
//   base64url  — machine ids that travel on the wire: opId, groupId, memberId, spaceId,
//                deviceId, wrapped keys, signatures. 16 random bytes -> 22 chars, no padding.
//   Crockford  — anything a HUMAN reads or types: the 16-char `deviceShort` inside every stamp,
//     base32     the 12-char pairing code, the invite code. Crockford excludes I, L, O and U,
//                so there is no 1/I/l, no 0/O, and no accidental profanity; on input it folds
//                case and maps the excluded letters back onto their digits.
//
// Both codecs are STRICT on decode, deliberately:
//   * only alphabet characters (plus, for Crockford, the separators a human is likely to type),
//   * no padding character at all — the encoders never emit one,
//   * a trailing partial group whose spare bits are non-zero is REJECTED.
// The last rule is the one that matters: without it, `opId` — the server's idempotency key —
// would have several distinct spellings for the same 16 bytes, and "already seen this op" would
// stop being decidable by string comparison. Canonical in, canonical out, or an error.

const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Crockford's alphabet. Note that EVERY character sorts at or above '0' — ADR 001 §1.2
 *  depends on that: it is what makes the all-zeros deviceShort a true minimum, which is what
 *  makes the GENESIS stamp of a migration sort below every real stamp (ADR 001 §8.1). */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const B64U_INDEX = /** @type {Record<string, number>} */ ({});
for (let i = 0; i < B64U.length; i++) B64U_INDEX[B64U[i]] = i;

const CROCK_INDEX = /** @type {Record<string, number>} */ ({});
for (let i = 0; i < CROCKFORD_ALPHABET.length; i++) CROCK_INDEX[CROCKFORD_ALPHABET[i]] = i;

/** Thrown for malformed input. A distinct type so callers can tell "corrupt" from "bug". */
export class CodecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CodecError';
  }
}

/** Accept Uint8Array | ArrayBuffer | number[] and return a Uint8Array view we may read. */
function asBytes(b, who) {
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  if (Array.isArray(b)) {
    for (const n of b) {
      if (!Number.isInteger(n) || n < 0 || n > 255) throw new CodecError(`${who}: not a byte: ${n}`);
    }
    return Uint8Array.from(b);
  }
  throw new CodecError(`${who}: expected bytes, got ${b === null ? 'null' : typeof b}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// base64url
// ─────────────────────────────────────────────────────────────────────────────

/**
 * base64url, RFC 4648 §5, WITHOUT padding.
 * @param {Uint8Array|ArrayBuffer|number[]} bytes
 * @returns {string}
 */
export function b64u(bytes) {
  const b = asBytes(bytes, 'b64u');
  let out = '';
  let i = 0;
  for (; i + 3 <= b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += B64U[(n >>> 18) & 63] + B64U[(n >>> 12) & 63] + B64U[(n >>> 6) & 63] + B64U[n & 63];
  }
  const rest = b.length - i;
  if (rest === 1) {
    const n = b[i] << 16;
    out += B64U[(n >>> 18) & 63] + B64U[(n >>> 12) & 63];
  } else if (rest === 2) {
    const n = (b[i] << 16) | (b[i + 1] << 8);
    out += B64U[(n >>> 18) & 63] + B64U[(n >>> 12) & 63] + B64U[(n >>> 6) & 63];
  }
  return out;
}

/**
 * Strict base64url decode. No padding accepted, no standard-base64 `+`/`/`, and a final
 * partial group must have zero spare bits.
 * @param {string} s
 * @returns {Uint8Array}
 */
export function ub64(s) {
  if (typeof s !== 'string') throw new CodecError('ub64: expected a string');
  if (s.length % 4 === 1) throw new CodecError(`ub64: impossible length ${s.length}`);
  const full = Math.floor(s.length / 4);
  const rest = s.length - full * 4;
  const out = new Uint8Array(full * 3 + (rest === 0 ? 0 : rest - 1));
  let o = 0;
  let i = 0;
  for (; i + 4 <= s.length; i += 4) {
    const n = (val(s[i]) << 18) | (val(s[i + 1]) << 12) | (val(s[i + 2]) << 6) | val(s[i + 3]);
    out[o++] = (n >>> 16) & 255;
    out[o++] = (n >>> 8) & 255;
    out[o++] = n & 255;
  }
  if (rest === 2) {
    const n = (val(s[i]) << 18) | (val(s[i + 1]) << 12);
    if ((n & 0x00ffff) !== 0) throw new CodecError('ub64: non-canonical encoding (spare bits set)');
    out[o++] = (n >>> 16) & 255;
  } else if (rest === 3) {
    const n = (val(s[i]) << 18) | (val(s[i + 1]) << 12) | (val(s[i + 2]) << 6);
    if ((n & 0x0000ff) !== 0) throw new CodecError('ub64: non-canonical encoding (spare bits set)');
    out[o++] = (n >>> 16) & 255;
    out[o++] = (n >>> 8) & 255;
  }
  return out;

  function val(ch) {
    const v = B64U_INDEX[ch];
    if (v === undefined) throw new CodecError(`ub64: not a base64url character: ${JSON.stringify(ch)}`);
    return v;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Crockford base32
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fold a human-typed Crockford string into canonical form: strip the separators people insert
 * (`-`, space, and the non-breaking space a Mac inserts on option-space), upper-case it, and map
 * the four characters Crockford excludes onto what the human meant:
 *   I, i, L, l -> 1        O, o -> 0
 * `U` is NOT mapped; Crockford reserves it and a `U` in a code is an error, not a typo we may
 * guess at.
 * @param {string} s
 * @returns {string}
 */
export function crockNormalize(s) {
  if (typeof s !== 'string') throw new CodecError('crockNormalize: expected a string');
  let out = '';
  for (const ch of s) {
    if (ch === '-' || ch === ' ' || ch === '\u00A0' || ch === '\t') continue;
    const u = ch.toUpperCase();
    if (u === 'I' || u === 'L') out += '1';
    else if (u === 'O') out += '0';
    else out += u;
  }
  return out;
}

/**
 * Crockford base32 encode. Upper-case, no padding, no separators.
 * n bytes -> ceil(8n/5) characters. 10 bytes -> exactly 16 characters = the deviceShort width.
 * @param {Uint8Array|ArrayBuffer|number[]} bytes
 * @returns {string}
 */
export function crock32(bytes) {
  const b = asBytes(bytes, 'crock32');
  let out = '';
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < b.length; i++) {
    acc = (acc << 8) | b[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD_ALPHABET[(acc >>> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD_ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/**
 * Crockford base32 decode. Case-insensitive, separator-tolerant, I/L/O folded (see
 * `crockNormalize`); `U` and every other non-alphabet character are rejected. A trailing
 * partial group whose spare bits are non-zero is rejected.
 * @param {string} s
 * @returns {Uint8Array}
 */
export function uncrock32(s) {
  const t = crockNormalize(s);
  if (t.length % 8 === 1) throw new CodecError(`uncrock32: impossible length ${t.length}`);
  const out = new Uint8Array(Math.floor((t.length * 5) / 8));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const ch of t) {
    const v = CROCK_INDEX[ch];
    if (v === undefined) throw new CodecError(`uncrock32: not a Crockford character: ${JSON.stringify(ch)}`);
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 255;
      acc &= (1 << bits) - 1;
    }
  }
  if (acc !== 0) throw new CodecError('uncrock32: non-canonical encoding (spare bits set)');
  return out;
}
