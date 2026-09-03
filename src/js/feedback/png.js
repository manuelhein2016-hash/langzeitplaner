// src/js/feedback/png.js — an indexed PNG encoder that CANNOT DRAW TEXT.  LZP-1009.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS AT ALL, WHEN `canvas.toDataURL()` IS ONE LINE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// LZP-1009's redaction rule is **"redact by not drawing, never by obscuring"**, and the reason is
// not stylistic: blur and black boxes are reversible when the source pixels or the DOM survive,
// and a full-fidelity board image that exists in memory *even for a moment* is an image a future
// bug can send. The rule is therefore not "blur it well" but **"a full-fidelity board image must
// never exist on this path at all"**.
//
// A `<canvas>` cannot give that guarantee. `ctx.fillText`, `ctx.drawImage(video)` and
// `ctx.drawImage(anotherCanvas)` are one refactor away from any canvas anybody holds, and
// `html2canvas`-shaped code is one npm install away. The guarantee this file gives instead is
// **structural and permanent**:
//
//   ██ THERE IS NO GLYPH PATH. This encoder's only primitive is `fillRect`. It has no font, no
//   ██ text measurement, no image input, no compositing source. Handed the string
//   ██ „Scheidungsanwältin Dr. Kübler 14:30" it has no function that could put it on a pixel.
//
// So "the redacted image contains no entry text" is not a claim about a filter that ran. It is a
// claim about a capability the code does not have, and `tests/tier1/feedback.test.js` §3 asserts
// it as such: the module's whole export surface is enumerated, and every input it accepts is a
// number or a palette index.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY IT IS HAND-ROLLED
// ─────────────────────────────────────────────────────────────────────────────────────────────
// Zero npm dependencies (ADR 005 §5). There is no `pako`, no `CompressionStream` on the WebKit
// version this ships against, and `canvas.toBlob` is exactly what is being refused above. So the
// DEFLATE stream is written here: fixed-Huffman blocks with a run matcher that only ever looks
// at two distances — one byte back, and one row back. That is not a weak general compressor; it
// is close to the ideal one for THIS input, because a redacted board is flat fills and repeated
// rows, and it is ~150 lines instead of a library.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// PURITY
// ─────────────────────────────────────────────────────────────────────────────────────────────
// No DOM, no clock, no randomness, no globals beyond `Uint8Array`/`TextEncoder`-free arithmetic.
// Every function is a pure function of its arguments. This is what lets tier 1 run the real
// encoder in Node and decode the bytes back with `zlib.inflateSync` to prove the stream is a
// real PNG rather than something only this file can read.

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. The raster — an indexed byte plane and one primitive
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** PNG indexed colour tops out at 256 entries; so does this. */
export const MAX_PALETTE = 256;

/**
 * A fixed-size indexed raster.
 *
 * ONE mutator, `fillRect`, and it takes four numbers and a palette index. There is deliberately
 * no `drawImage`, no `putPixel(x, y, r, g, b)` and no `blit`: a redacted render is a list of
 * rectangles, and anything richer than a rectangle is a channel through which detail could
 * survive. The clipping is unconditional so a caller's rounding error is a clipped rectangle
 * rather than an exception in the middle of a report.
 */
export class Raster {
  /**
   * @param {number} w width in pixels
   * @param {number} h height in pixels
   * @param {number} [bg] the palette index every pixel starts as
   */
  constructor(w, h, bg = 0) {
    const W = Math.max(1, Math.floor(w));
    const H = Math.max(1, Math.floor(h));
    this.w = W;
    this.h = H;
    this.px = new Uint8Array(W * H);
    if (bg !== 0) this.px.fill(bg & 0xff);
  }

  /**
   * The ONLY way a pixel changes. Half-open on the right and bottom, clipped to the raster.
   * @param {number} x @param {number} y @param {number} w @param {number} h @param {number} idx
   */
  fillRect(x, y, w, h, idx) {
    let x0 = Math.round(x);
    let y0 = Math.round(y);
    let x1 = Math.round(x + w);
    let y1 = Math.round(y + h);
    if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
    if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > this.w) x1 = this.w;
    if (y1 > this.h) y1 = this.h;
    if (x1 <= x0 || y1 <= y0) return;
    const v = idx & 0xff;
    for (let y = y0; y < y1; y++) {
      this.px.fill(v, y * this.w + x0, y * this.w + x1);
    }
  }

  /**
   * A one-pixel-thick outline, as four `fillRect`s. Provided because a hairline drawn as a
   * filled rectangle of height 0 disappears, and a board's grid IS its structure — the thing the
   * report is for.
   */
  strokeRect(x, y, w, h, idx, t = 1) {
    this.fillRect(x, y, w, t, idx);
    this.fillRect(x, y + h - t, w, t, idx);
    this.fillRect(x, y, t, h, idx);
    this.fillRect(x + w - t, y, t, h, idx);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. CRC-32 and Adler-32
// ─────────────────────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

/** @param {Uint8Array} bytes @returns {number} */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {Uint8Array} bytes @returns {number} */
export function adler32(bytes) {
  let a = 1;
  let b = 0;
  // 5552 is the largest block for which the sums cannot overflow a 32-bit accumulator.
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(i + 5552, bytes.length);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. DEFLATE — fixed Huffman, two distances
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// RFC 1951. Non-Huffman fields are written LSB-first; Huffman codes are written MSB-first. Both
// are below, and getting the two backwards is the classic way to produce a file that no decoder
// accepts — which is why tier 1 inflates the output with `node:zlib` rather than trusting this.

class BitWriter {
  constructor() {
    this.buf = new Uint8Array(1024);
    this.len = 0;
    this.bit = 0;      // bits already used in buf[len]
  }

  _grow() {
    if (this.len + 8 <= this.buf.length) return;
    const next = new Uint8Array(this.buf.length * 2);
    next.set(this.buf.subarray(0, this.len + 1));
    this.buf = next;
  }

  /** LSB-first — lengths, the BFINAL/BTYPE header, and every "extra bits" field. */
  bits(value, count) {
    for (let i = 0; i < count; i++) {
      this._grow();
      if ((value >>> i) & 1) this.buf[this.len] |= (1 << this.bit);
      if (++this.bit === 8) { this.bit = 0; this.len++; }
    }
  }

  /** MSB-first — Huffman codes only. */
  code(value, count) {
    for (let i = count - 1; i >= 0; i--) {
      this._grow();
      if ((value >>> i) & 1) this.buf[this.len] |= (1 << this.bit);
      if (++this.bit === 8) { this.bit = 0; this.len++; }
    }
  }

  finish() {
    const n = this.bit === 0 ? this.len : this.len + 1;
    return this.buf.slice(0, n);
  }
}

/** RFC 1951 §3.2.6 — the fixed literal/length code. */
function writeFixedLiteral(bw, sym) {
  if (sym <= 143) bw.code(0x30 + sym, 8);
  else if (sym <= 255) bw.code(0x190 + (sym - 144), 9);
  else if (sym <= 279) bw.code(sym - 256, 7);
  else bw.code(0xc0 + (sym - 280), 8);
}

/** length 3..258 -> {sym, extra, extraBits}; RFC 1951 §3.2.5 table. */
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function writeLength(bw, len) {
  let i = LEN_BASE.length - 1;
  while (LEN_BASE[i] > len) i--;
  writeFixedLiteral(bw, 257 + i);
  if (LEN_EXTRA[i]) bw.bits(len - LEN_BASE[i], LEN_EXTRA[i]);
}

function writeDistance(bw, dist) {
  let i = DIST_BASE.length - 1;
  while (DIST_BASE[i] > dist) i--;
  bw.code(i, 5);                                   // the fixed distance code is 5 bits, MSB-first
  if (DIST_EXTRA[i]) bw.bits(dist - DIST_BASE[i], DIST_EXTRA[i]);
}

/**
 * Compress with a matcher that considers exactly TWO distances.
 *
 * `stride` is the length of one PNG scanline including its filter byte. Those two distances are
 * not a simplification of a general search — they are the two redundancies this input actually
 * has: a run of one colour along a row (distance 1) and a row identical to the one above it
 * (distance `stride`). A generic hash-chain matcher would find the same matches, more slowly, in
 * five times the code.
 *
 * @param {Uint8Array} data @param {number} stride @returns {Uint8Array} a raw DEFLATE stream
 */
export function deflateRaw(data, stride) {
  const bw = new BitWriter();
  bw.bits(1, 1);                                   // BFINAL
  bw.bits(1, 2);                                   // BTYPE = 01, fixed Huffman
  const n = data.length;
  let i = 0;
  while (i < n) {
    let bestLen = 0;
    let bestDist = 0;
    for (const dist of (stride > 0 && stride < 32768 ? [stride, 1] : [1])) {
      if (dist > i) continue;
      let len = 0;
      const max = Math.min(258, n - i);
      while (len < max && data[i + len] === data[i + len - dist]) len++;
      if (len > bestLen) { bestLen = len; bestDist = dist; }
    }
    if (bestLen >= 3) {
      writeLength(bw, bestLen);
      writeDistance(bw, bestDist);
      i += bestLen;
    } else {
      writeFixedLiteral(bw, data[i]);
      i++;
    }
  }
  writeFixedLiteral(bw, 256);                      // end of block
  return bw.finish();
}

/** zlib wrapper (RFC 1950) around `deflateRaw`. */
function zlib(data, stride) {
  const body = deflateRaw(data, stride);
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78;                                   // CM=8, CINFO=7 (32K window)
  out[1] = 0x01;                                   // FCHECK so that (0x78<<8|0x01) % 31 === 0
  out.set(body, 2);
  const a = adler32(data);
  const p = 2 + body.length;
  out[p] = (a >>> 24) & 0xff;
  out[p + 1] = (a >>> 16) & 0xff;
  out[p + 2] = (a >>> 8) & 0xff;
  out[p + 3] = a & 0xff;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4. The container
// ─────────────────────────────────────────────────────────────────────────────────────────────

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const TE_ASCII = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(TE_ASCII(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Encode an indexed raster as a PNG.
 *
 * ⚠ THE PALETTE IS THE ONLY COLOUR CHANNEL AND IT IS SUPPLIED BY THE CALLER. There is no path
 * from a DOM node, a font, or an image to a byte of output — only from `Raster.fillRect` and
 * from this array of triples.
 *
 * @param {Raster} raster
 * @param {Array<[number,number,number]>} palette up to `MAX_PALETTE` RGB triples
 * @returns {Uint8Array} the complete PNG file
 */
export function encodePng(raster, palette) {
  if (!(raster instanceof Raster)) throw new TypeError('encodePng: not a Raster');
  if (!Array.isArray(palette) || palette.length === 0 || palette.length > MAX_PALETTE) {
    throw new RangeError(`encodePng: palette must hold 1..${MAX_PALETTE} entries`);
  }

  const { w, h, px } = raster;
  const stride = w + 1;                            // one filter byte per scanline
  const raw = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;                           // filter 0 (None) — the rows are already flat
    raw.set(px.subarray(y * w, y * w + w), y * stride + 1);
  }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;                                     // bit depth
  ihdr[9] = 3;                                     // colour type 3 — indexed
  ihdr[10] = 0;                                    // deflate
  ihdr[11] = 0;                                    // adaptive filtering
  ihdr[12] = 0;                                    // no interlace

  const plte = new Uint8Array(palette.length * 3);
  for (let i = 0; i < palette.length; i++) {
    plte[i * 3] = palette[i][0] & 0xff;
    plte[i * 3 + 1] = palette[i][1] & 0xff;
    plte[i * 3 + 2] = palette[i][2] & 0xff;
  }

  const parts = [
    Uint8Array.from(SIG),
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('IDAT', zlib(raw, stride)),
    chunk('IEND', new Uint8Array(0)),
  ];
  // No tEXt, no iTXt, no zTXt, no tIME, no pHYs. A text chunk is a place a caption could be
  // added later, and this file is the one place in the product where "later" must be impossible.
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * The chunk types this encoder emits, in order. Exported so a test can assert the set rather
 * than read the bytes for it — in particular that no `tEXt`-family chunk is ever produced.
 */
export const EMITTED_CHUNKS = Object.freeze(['IHDR', 'PLTE', 'IDAT', 'IEND']);
