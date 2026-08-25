// src/js/core/canon.js — canonical JSON + varint.  ADR 005 §1.1, ADR 002 §2.3 / §5.3.
//
// DOM-free, I/O-free, dependency-free (ADR 005 §2).
//
// WHY THIS FILE IS A SECURITY BOUNDARY, NOT A CONVENIENCE
// ------------------------------------------------------
// The output of `canonicalJSON` is what gets SIGNED:
//   * the device attestation           ECDSA over canonicalJSON(att)      ADR 002 §2.3
//   * every sealed op                  varint(len) || utf8(canonicalJSON(op)) || zeros
//                                                                          ADR 002 §5.3
//   * the recovery artifact            AES-GCM over canonicalJSON({...})   ADR 002 §7
// A verifier re-serialises the parsed object and compares. If two engines — V8 in Node, JSC in
// the WKWebView shell — can ever disagree about the bytes for the SAME logical value, then a
// signature made on one Mac fails to verify on the other, and the failure mode is not a crash
// but "your family's ops are silently rejected". Every rule below exists to remove one way that
// could happen. Where a value has no single obviously-canonical encoding, this module REFUSES it
// rather than guessing: an exception at authoring time on one machine is a bug report; a silent
// byte difference across machines is a data-loss incident.
//
// THE RULES
// ---------
//  1. Object keys are sorted, ascending, by UTF-16 code unit (plain `<`) — the RFC 8785 rule,
//     and the only string order every JS engine implements identically.
//  2. No whitespace anywhere. No trailing newline.
//  3. Every string — VALUES AND KEYS ALIKE — is Unicode-normalised to NFC first. Two Macs can
//     hand you "Zahnarzt-Termin fu(combining umlaut)r Oma" and "Zahnarzt-Termin f(u-umlaut)r Oma"
//     for text a human considers identical; NFC makes them the same bytes.
//  4. Numbers must be SAFE INTEGERS. No floats (their shortest-round-trip printing is a
//     minefield we do not need), no NaN, no Infinity, no 1e21, no -0 (normalised to 0).
//     Every number in an op is an epoch counter or a small int; nothing in the product needs
//     a float, so the cheap, total rule is "integers only" (crypto.contract.js §8).
//  5. `undefined` is REFUSED wherever it appears — as an array element, as an object value, as
//     the top-level value. `null` clears a register and is a first-class value (ADR 001 §2);
//     `undefined` is what `{...entry, text: undefined}` produces, which is precisely the
//     redaction anti-pattern ADR 004 §2 exists to prevent. It must not serialise to anything.
//  6. Unpaired surrogates are REFUSED. They survive `normalize('NFC')` unchanged but UTF-8
//     encoding replaces them with U+FFFD, so `canonicalJSON(x)` and `canonicalBytes(x)` would
//     describe different values — the exact cross-engine instability this module must not have.
//  7. Only plain objects (Object.prototype or a null prototype) and arrays are structural.
//     A Date, a Map, a RegExp or any class instance is refused rather than routed through
//     `toJSON()`, which is user-overridable and therefore not canonical.
//  8. Cycles are refused.

const HAS_SURROGATE = /[\uD800-\uDFFF]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;

/** Thrown for anything this module refuses to canonicalise. */
export class CanonError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CanonError';
  }
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

/** NFC-normalise, and refuse anything that cannot survive a UTF-8 round trip. */
function canonString(s, where) {
  const n = s.normalize('NFC');
  if (HAS_SURROGATE.test(n) && LONE_SURROGATE.test(n)) {
    throw new CanonError(`${where}: unpaired surrogate — not encodable as UTF-8`);
  }
  // With no lone surrogates left, JSON.stringify's escaping is fully specified by ECMA-262
  // (QuoteJSONString): shortest escapes for the eight named controls, \u00XX for the rest,
  // and nothing else escaped. That makes it deterministic across engines, so we reuse it
  // instead of hand-rolling a second escaper that could disagree with it.
  return JSON.stringify(n);
}

function canonNumber(v, where) {
  if (!Number.isFinite(v)) throw new CanonError(`${where}: ${String(v)} is not a finite number`);
  if (!Number.isInteger(v)) throw new CanonError(`${where}: ${v} is not an integer (floats are refused)`);
  if (!Number.isSafeInteger(v)) throw new CanonError(`${where}: ${v} exceeds the safe integer range`);
  return String(v === 0 ? 0 : v); // collapses -0 to "0"
}

function walk(v, where, seen) {
  if (v === null) return 'null';

  const t = typeof v;
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'number') return canonNumber(v, where);
  if (t === 'string') return canonString(v, where);
  if (t === 'undefined') {
    throw new CanonError(`${where}: undefined is not representable — use null to clear a value`);
  }
  if (t === 'bigint') throw new CanonError(`${where}: bigint is not representable`);
  if (t === 'function' || t === 'symbol') throw new CanonError(`${where}: ${t} is not representable`);

  if (seen.has(v)) throw new CanonError(`${where}: cycle`);
  seen.add(v);
  try {
    if (Array.isArray(v)) {
      let out = '[';
      for (let i = 0; i < v.length; i++) {
        if (i > 0) out += ',';
        // A hole in a sparse array reads as undefined; walk() refuses it, which is what we want.
        out += walk(v[i], `${where}[${i}]`, seen);
      }
      return out + ']';
    }

    if (!isPlainObject(v)) {
      const name = v.constructor && v.constructor.name ? v.constructor.name : 'object';
      throw new CanonError(`${where}: ${name} is not a plain object — refusing to call toJSON()`);
    }

    // NFC-normalise the KEYS too, then check that normalisation did not merge two distinct
    // keys into one. If it did, the object has no canonical form and the caller must fix it.
    const entries = [];
    const byKey = new Map();
    for (const rawKey of Object.keys(v)) {
      const key = rawKey.normalize('NFC');
      if (HAS_SURROGATE.test(key) && LONE_SURROGATE.test(key)) {
        throw new CanonError(`${where}: key with an unpaired surrogate`);
      }
      if (byKey.has(key)) {
        throw new CanonError(
          `${where}: keys ${JSON.stringify(byKey.get(key))} and ${JSON.stringify(rawKey)} ` +
          'collide after NFC normalisation'
        );
      }
      byKey.set(key, rawKey);
      entries.push([key, v[rawKey]]);
    }
    // Rule 1: ascending by UTF-16 code unit. `<` on strings is exactly that, in every engine.
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    let out = '{';
    for (let i = 0; i < entries.length; i++) {
      if (i > 0) out += ',';
      out += JSON.stringify(entries[i][0]) + ':' + walk(entries[i][1], `${where}.${entries[i][0]}`, seen);
    }
    return out + '}';
  } finally {
    seen.delete(v);
  }
}

/**
 * Canonical JSON: sorted keys, no whitespace, NFC strings, safe integers only.
 * Stable across engines and independent of key insertion order.
 * @param {any} value
 * @returns {string}
 * @throws {CanonError}
 */
export function canonicalJSON(value) {
  return walk(value, '$', new Set());
}

const ENC = new TextEncoder();
const DEC = new TextDecoder('utf-8', { fatal: true });

/** @param {string} s @returns {Uint8Array} */
export function utf8(s) {
  if (typeof s !== 'string') throw new CanonError('utf8: expected a string');
  return ENC.encode(s);
}

/** @param {Uint8Array} b @returns {string} @throws on invalid UTF-8 */
export function utf8Decode(b) {
  return DEC.decode(b);
}

/**
 * The bytes that actually get signed / encrypted.
 * @param {any} value
 * @returns {Uint8Array}
 */
export function canonicalBytes(value) {
  return utf8(canonicalJSON(value));
}

// ─────────────────────────────────────────────────────────────────────────────
// varint — LEB128, unsigned
//
// The length prefix in ADR 002 §5.3's padded plaintext:
//     varint(len) || utf8(canonicalJSON(op)) || zeros    -> a multiple of 256 bytes
// It is what lets `unpad` find the payload boundary without trusting the zero run, so a
// plaintext that legitimately ENDS in a zero byte still round-trips.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {number} n non-negative safe integer
 * @returns {Uint8Array} 1..8 bytes, little-endian base-128 with the high bit as continuation
 */
export function varint(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new CanonError(`varint: ${n} is not a non-negative safe integer`);
  const out = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Uint8Array.from(out);
}

/**
 * @param {Uint8Array} bytes
 * @param {number} [offset]
 * @returns {{ value: number, bytesRead: number }}
 * @throws {CanonError} on truncation, on a value beyond the safe integer range, and on a
 *         non-minimal encoding (a trailing 0x80 continuation byte), which would otherwise give
 *         one length two spellings.
 */
export function readVarint(bytes, offset = 0) {
  let value = 0;
  let scale = 1;
  let i = offset;
  for (;;) {
    if (i >= bytes.length) throw new CanonError('readVarint: truncated');
    const b = bytes[i];
    const chunk = b & 0x7f;
    value += chunk * scale;
    if (!Number.isSafeInteger(value)) throw new CanonError('readVarint: value exceeds the safe integer range');
    i++;
    if ((b & 0x80) === 0) {
      if (i - offset > 1 && chunk === 0) throw new CanonError('readVarint: non-minimal encoding');
      return { value, bytesRead: i - offset };
    }
    scale *= 128;
    if (i - offset > 8) throw new CanonError('readVarint: too long');
  }
}
