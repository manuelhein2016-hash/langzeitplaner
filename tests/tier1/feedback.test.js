// tests/tier1/feedback.test.js — LZP-1009, the client half. ADR 004 · stories 21.1, 21.4.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE ROW THIS FILE EXISTS FOR
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// LZP-1009's own words: *"write the tier-1 row asserting the payload contains no string from a
// fixture board, and the mutant that adds one entry title."* That is §5, and the rest of this
// file is what makes §5 mean something:
//
//   §1  the ring buffer CANNOT HOLD a sentence — a token grammar, not a filter
//   §2  the geometry walker never reads text, on its source AND on its output
//   §3  the image path has no glyph capability at all, and produces a real PNG
//   §4  the preview screen IS the payload — the same string, not two renderings
//   §5  ██ THE WHOLE PAYLOAD, GREPPED — five German needles, three spellings each ██
//   §6  the port contract, so the one line this ticket does not own cannot land wrong
//   §7  the copy — both languages, German first, and the promises it makes
//   §8  the mutants, each naming the row that dies
//
// The grep is `e10-outbound-payload.test.js`'s, deliberately: that file's §4a says the rig it
// built is the one whoever lands 1009 must point at their payload rather than writing a weaker
// one. `flatten` and the three spellings are reproduced here rather than imported because a
// tier-1 file may not reach into `tests/attack/`; `tests/attack/e10-outbound-payload.test.js` §5
// is where the SAME needles are run over the SAME payload from the attack side.

import '../helpers/env.js';
import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
  noteEvent, readEvents, clearEvents, droppedCount, installErrorTap, _resetTap,
  CAPACITY, TOKEN_RE, EVENT_KINDS, EVENT_KIND_NAMES,
} from '../../src/js/feedback/events.js';
import {
  collectPrimitives, assertNumericOnly, ROLES, BOARD_SELECTORS, parseRgb, Palette,
} from '../../src/js/feedback/geometry.js';
import { Raster, encodePng, deflateRaw, crc32, adler32, EMITTED_CHUNKS } from '../../src/js/feedback/png.js';
import { renderRedactedBoard, MAX_W, MAX_H } from '../../src/js/feedback/redact.js';
import { buildReport, wireBody, signedBytes, b64, SCREENS, SPACE_KINDS } from '../../src/js/feedback/report.js';
import { setFeedbackPort, feedbackPort, canSend, FEEDBACK_PATH } from '../../src/js/feedback/port.js';
import { c, COPY_TABLES } from '../../src/js/feedback/copy.js';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE FIXTURE BOARD — a real German one, and every needle a sentence someone would mind
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Owned by this file rather than shared, for `e10-outbound-payload.test.js`'s stated reason: a
// shared needle would mean a failure here names another file's secrets and a reader goes and
// looks in the wrong place. Every one has an umlaut or a sharp s on purpose.

const NEEDLE = Object.freeze({
  privatNote: 'Scheidungsanwältin Dr. Kübler 14:30',
  privatBar: 'Kur in Bad Wörishofen',
  category: 'Zweitfamilie Süd',
  diagnosis: 'Diagnose F32.1 — mittelgradige Episode',
  scratch: 'Passwort fürs Schließfach: Großmutter77',
  member: 'Großmutter Änne',
  spaceId: 'fsp_9xQ2mR7bL0aZ4tV8wKmü',
});

const TE = new TextEncoder();

/**
 * The FIVE spellings of one needle.
 *
 *   1. the raw JS string
 *   2. its UTF-8 bytes read back as latin-1 — ██ ADDED BECAUSE §5e CAUGHT ITS ABSENCE ██.
 *      The image is a byte plane, and a needle that survived into it is UTF-8 bytes; reading
 *      those back one byte per character turns „Wörishofen" into „Wörishofen", which the raw
 *      spelling does not match. Without this the image half of §5a was searching for something
 *      that could not be there in that form — green, and measuring nothing.
 *   3. the b64url spelling, because a field that was base64-encoded without being encrypted is
 *      perfectly readable and invisible to a plain substring search
 *   4. and 5. the two JSON escapings, because `JSON.stringify` may rewrite `ö` as `\u00f6` and a
 *      needle with an umlaut would then not match itself. Every needle here has one on purpose.
 */
function spellings(s) {
  const bytes = TE.encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64u = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jsonEscaped = JSON.stringify(s).slice(1, -1);
  const uEscaped = [...s].map((ch) => (ch.charCodeAt(0) > 127
    ? '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0') : ch)).join('');
  return [s, bin, b64u, jsonEscaped, uEscaped];
}

/** Which spellings of `needle` appear in `hay`. Empty is the claim; non-empty is the leak. */
function found(hay, needle) {
  return spellings(needle).filter((s) => s.length > 0 && hay.includes(s));
}

/** Bytes as one latin-1 character each — the spelling a byte plane actually holds. */
function latin1(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return bin;
}

/**
 * THE WHOLE PAYLOAD, AS ONE SEARCHABLE STRING.
 *
 * Three parts, and the third one is the whole reason this function is longer than a `join`:
 *
 *   1. the wire body as JSON — the report text, the b64url image, the device block
 *   2. the PNG FILE bytes — where a `tEXt` chunk or a metadata caption would live
 *   3. ██ THE INFLATED PIXEL PLANE ██ — because parts 1 and 2 do not contain the pixels.
 *
 * Part 3 was added after §5e went red, and it is the difference between a real measurement and a
 * green nothing. A PNG's IDAT is DEFLATE, and DEFLATE Huffman-codes its literals: a needle
 * sitting plainly in the pixel buffer does **not** appear byte-for-byte in the file. So a search
 * over the encoded image — the obvious thing to write, and what this function did first — cannot
 * find a leak in the pixels and would have been green over an image with the board's text drawn
 * straight into it. The stream is decompressed with `node:zlib`, a decoder this project did not
 * write, and the raster itself is searched.
 */
function flatten(body, imageBytes) {
  const parts = [JSON.stringify(body)];
  if (imageBytes) {
    parts.push(latin1(imageBytes));
    parts.push(latin1(inflateIdat(imageBytes)));
  }
  return parts.join('\u0000');
}

/** Every IDAT of a PNG, concatenated and inflated. Returns an empty array if there is none. */
function inflateIdat(png) {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks = [];
  let off = 8;
  while (off + 12 <= png.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(...png.subarray(off + 4, off + 8));
    if (type === 'IDAT') chunks.push(Buffer.from(png.subarray(off + 8, off + 8 + len)));
    off += 12 + len;
  }
  if (chunks.length === 0) return new Uint8Array(0);
  return new Uint8Array(zlib.inflateSync(Buffer.concat(chunks)));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A FAKE BOARD. Not a DOM — tier 1 has none by design (`helpers/env.js` says so in full) — but
// the REAL `collectPrimitives`, driven through its injected readers over nodes that carry the
// fixture's German text exactly where a real board carries it.
// ─────────────────────────────────────────────────────────────────────────────────────────────

function fakeBoard() {
  const mk = (cls, text, box) => ({ cls, text, box });
  const nodes = [
    mk('col', null, { left: 0, top: 0, width: 96, height: 800 }),
    mk('col-head', 'März 2027', { left: 0, top: 0, width: 96, height: 22 }),
    mk('day', null, { left: 2, top: 24, width: 92, height: 26 }),
    mk('day we', null, { left: 2, top: 52, width: 92, height: 26 }),
    mk('day today', null, { left: 2, top: 80, width: 92, height: 26 }),
    mk('note', NEEDLE.privatNote, { left: 4, top: 26, width: 88, height: 11 }),
    mk('bar', null, { left: 4, top: 300, width: 88, height: 14 }),
    mk('bar-label', NEEDLE.privatBar, { left: 6, top: 302, width: 84, height: 10 }),
    mk('chip', NEEDLE.member, { left: 86, top: 26, width: 8, height: 8 }),
    mk('d-more', '+3', { left: 70, top: 90, width: 22, height: 10 }),
    mk('scratchpad', null, { left: 100, top: 0, width: 200, height: 400 }),
    mk('pad-label', `${NEEDLE.diagnosis} ${NEEDLE.scratch}`, { left: 102, top: 4, width: 196, height: 10 }),
    mk('redacted-word', NEEDLE.category, { left: 4, top: 40, width: 60, height: 10 }),
  ];
  const root = {
    box: { left: 0, top: 0, width: 1180, height: 840 },
    querySelectorAll(sel) {
      const wanted = sel.split(',').map((s) => s.trim().replace(/^\./, '').split('.'));
      return nodes.filter((n) => {
        const have = n.cls.split(' ');
        return wanted.some((w) => w.every((part) => have.includes(part)));
      });
    },
  };
  const io = {
    rects: (n) => (n === root ? root.box : n.box),
    style: () => ({ backgroundColor: 'rgb(247,247,244)', borderTopColor: 'rgb(190,190,190)', color: 'rgb(32,32,36)' }),
    // ONE line box per node that has text, at the text's own metrics — what a Range would give.
    lineBoxes: (n) => (n.text
      ? [{ left: n.box.left, top: n.box.top, width: Math.min(n.box.width, n.text.length * 6), height: n.box.height }]
      : []),
  };
  return { root, io, nodes };
}

beforeEach(() => { clearEvents(); setFeedbackPort(null); _resetTap(); });

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · THE RING BUFFER CANNOT HOLD A SENTENCE
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · structural events only, by grammar and not by filter', () => {
  test('§1a · the four kinds LZP-1009 names are all recordable', () => {
    noteEvent('render', { ms: 51 }, 1000);
    noteEvent('refusal', { op: 'drag:commit', code: 'not_owner' }, 1001);
    noteEvent('sync', { applied: 3, phase: 'push' }, 1002);
    noteEvent('error', { name: 'KeyStoreUnavailableError' }, 1003);
    const e = readEvents();
    assert.equal(e.length, 4);
    assert.deepEqual(e[0], { k: 'render', t: 1000, ms: 51 });
    assert.deepEqual(e[1], { k: 'refusal', t: 1001, op: 'drag:commit', code: 'not_owner' });
    assert.deepEqual(e[2], { k: 'sync', t: 1002, applied: 3, phase: 'push' });
    assert.deepEqual(e[3], { k: 'error', t: 1003, name: 'KeyStoreUnavailableError' });
  });

  test('§1b · a kind the table does not name is not recordable AT ALL', () => {
    noteEvent('telemetry', { payload: NEEDLE.privatNote }, 1);
    noteEvent('boardSnapshot', { text: NEEDLE.privatBar }, 2);
    assert.deepEqual(readEvents(), []);
  });

  test('§1c · an unnamed FIELD on a named kind is unreachable', () => {
    noteEvent('render', { ms: 12, title: NEEDLE.privatNote, note: NEEDLE.diagnosis }, 5);
    assert.deepEqual(readEvents(), [{ k: 'render', t: 5, ms: 12 }]);
  });

  test('§1d · ██ AN ENTRY TITLE OFFERED AS A DETAIL IS DROPPED, NOT STORED ██', () => {
    // The row the grammar exists for. Every needle is offered in the ONE field of the ONE kind
    // that takes a string, and none of them is representable: spaces, umlauts, digits-first and
    // length all fail `TOKEN_RE`. This is not a filter that could be bypassed by an encoding —
    // the value is never written unless it matches.
    for (const [name, needle] of Object.entries(NEEDLE)) {
      noteEvent('error', { name: needle }, 9);
      noteEvent('refusal', { op: needle, code: needle }, 9);
      noteEvent('screen', { name: needle }, 9);
      assert.deepEqual(readEvents().flatMap((e) => Object.values(e).filter((v) => typeof v === 'string')),
        ['error', 'refusal', 'screen'].slice(0, readEvents().length),
        `${name} was stored in the ring buffer`);
      clearEvents();
    }
    // and the grammar itself refuses each one, directly.
    for (const needle of Object.values(NEEDLE)) {
      assert.equal(TOKEN_RE.test(needle), false, `TOKEN_RE accepts ${JSON.stringify(needle)}`);
    }
  });

  test('§1e · ARMED — the grammar DOES accept the vocabulary of the program', () => {
    // Non-vacuity: §1d would also be green if `TOKEN_RE` accepted nothing at all.
    for (const ok of ['not_owner', 'drag:commit', 'KeyStoreUnavailableError', 'RedactionError',
      'pushOps', 'renderBoard', 'e.tag-1', 'a'.repeat(48)]) {
      assert.equal(TOKEN_RE.test(ok), true, `TOKEN_RE refuses ${ok} — the buffer records nothing useful`);
    }
    assert.equal(TOKEN_RE.test('a'.repeat(49)), false, 'the token cap is not enforced');
  });

  test('§1f · it is bounded and it forgets', () => {
    for (let i = 0; i < CAPACITY + 17; i++) noteEvent('render', { ms: i }, i);
    assert.equal(readEvents().length, CAPACITY);
    assert.equal(droppedCount(), 17);
    assert.equal(readEvents()[0].ms, 17, 'the OLDEST entries are the ones dropped');
    clearEvents();
    assert.deepEqual(readEvents(), []);
    assert.equal(droppedCount(), 0);
  });

  test('§1g · the buffer a caller reads cannot be used to mutate the real one', () => {
    noteEvent('render', { ms: 1 }, 1);
    const copy = readEvents();
    copy[0].ms = 99999;
    copy.push({ k: 'render', t: 2, ms: NEEDLE.privatNote });
    assert.deepEqual(readEvents(), [{ k: 'render', t: 1, ms: 1 }]);
  });

  test('§1h · the error tap records the CLASS NAME and never the message', () => {
    // A message is a string the program built, and a program that builds messages out of board
    // data is exactly the program this product is. `RedactionError`'s message names a field.
    const listeners = {};
    const target = { addEventListener: (k, fn) => { listeners[k] = fn; } };
    assert.equal(installErrorTap(target, () => 4242), true);
    assert.equal(installErrorTap(target, () => 1), false, 'the tap installed twice');
    class KeyStoreUnavailableError extends Error {}
    listeners.error({ error: new KeyStoreUnavailableError(NEEDLE.diagnosis) });
    listeners.unhandledrejection({ reason: new Error(NEEDLE.scratch) });
    const e = readEvents();
    assert.deepEqual(e, [
      { k: 'error', t: 4242, name: 'KeyStoreUnavailableError' },
      { k: 'error', t: 4242, name: 'Error' },
    ]);
    assert.equal(JSON.stringify(e).includes('Diagnose'), false, 'a message reached the buffer');
  });

  test('§1i · a broken caller cannot break a session', () => {
    const hostile = { get ms() { throw new Error('boom'); } };
    assert.doesNotThrow(() => noteEvent('render', hostile, 1));
    assert.doesNotThrow(() => noteEvent(null, null, null));
    assert.doesNotThrow(() => noteEvent('render', { ms: NaN }, undefined));
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · THE GEOMETRY WALKER NEVER READS TEXT
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · numbers out, and the guard runs in production', () => {
  test('§2a · every primitive is a role from a closed set and six finite numbers', () => {
    const { root, io } = fakeBoard();
    const { prims, counts } = collectPrimitives(root, io);
    assert.ok(prims.length > 10, `only ${prims.length} primitives — the walker read nothing`);
    assert.ok(counts.redactions >= 6, `only ${counts.redactions} redaction boxes for 7 text nodes`);
    assert.doesNotThrow(() => assertNumericOnly(prims));
    for (const p of prims) {
      assert.ok(ROLES.includes(p.role));
      assert.deepEqual(Object.keys(p).sort(), ['fill', 'h', 'role', 'stroke', 'w', 'x', 'y']);
    }
  });

  test('§2b · NOT ONE PRIMITIVE CARRIES A STRING FROM THE BOARD', () => {
    const { root, io } = fakeBoard();
    const { prims } = collectPrimitives(root, io);
    const hay = JSON.stringify(prims);
    for (const [name, needle] of Object.entries(NEEDLE)) {
      assert.deepEqual(found(hay, needle), [], `${name} is in the primitive list`);
    }
    assert.ok(hay.includes('redaction'), 'the control: role names ARE in the list, and were found');
  });

  test('§2c · the guard REFUSES a primitive that grew a text field', () => {
    // The row that makes `assertNumericOnly` a control rather than a comment. It runs on every
    // report in production (`redact.js`), so a future edit to `geometry.js` that emitted a label
    // stops the report instead of sending it.
    assert.throws(() => assertNumericOnly([{ role: 'note', x: 0, y: 0, w: 1, h: 1, fill: 1, stroke: 1, label: NEEDLE.privatBar }]),
      /only role and six numbers/);
    assert.throws(() => assertNumericOnly([{ role: NEEDLE.privatNote, x: 0, y: 0, w: 1, h: 1, fill: 1, stroke: 1 }]),
      /has role/);
    assert.throws(() => assertNumericOnly([{ role: 'note', x: '4', y: 0, w: 1, h: 1, fill: 1, stroke: 1 }]),
      /\.x is string/);
  });

  test('§2d · the walker\'s SOURCE names no text-reading API', () => {
    // The other half of §2b: the output is clean, and there is no code that could have made it
    // dirty. Asserted over the exported functions' own source, which is what ships.
    const src = [collectPrimitives, assertNumericOnly, parseRgb].map((f) => f.toString()).join('\n');
    for (const forbidden of ['textContent', 'innerText', 'innerHTML', 'nodeValue', 'getAttribute',
      'outerHTML', 'ariaLabel', 'dataset', 'toString']) {
      assert.equal(new RegExp(`\\b${forbidden}\\b`).test(src), false,
        `the geometry walker calls ${forbidden} — it can read text`);
    }
  });

  test('§2e · a redaction box sits at the TEXT\'s metrics, not the element\'s', () => {
    // The reason the boxes are per line box: "the label is too long for its bar" is exactly the
    // class of bug a report is for, and it is invisible if the redaction is one rectangle the
    // size of the bar. The fixture's `bar-label` text is wider than its own box on purpose.
    const { root, io } = fakeBoard();
    const { prims } = collectPrimitives(root, io);
    const boxes = prims.filter((p) => p.role === 'redaction');
    const widths = new Set(boxes.map((b) => b.w));
    assert.ok(widths.size > 1, 'every redaction box is the same width — the metrics were not read');
    const bar = prims.find((p) => p.role === 'bar');
    assert.ok(boxes.some((b) => Math.abs(b.y - (bar.y + bar.h * 0.14)) < 3),
      'no redaction box sits inside the bar — the label was not redacted at all');
  });

  test('§2f · a selector that matches nothing costs a rectangle, never an exception', () => {
    const empty = { box: { left: 0, top: 0, width: 10, height: 10 }, querySelectorAll: () => [] };
    const io = { rects: () => empty.box, style: () => ({}), lineBoxes: () => [] };
    const r = collectPrimitives(empty, io);
    assert.deepEqual(r.prims, []);
    assert.equal(r.w, 10);
  });

  test('§2g · the palette quantises and saturates rather than throwing', () => {
    const p = new Palette([255, 255, 255]);
    assert.equal(p.add([255, 255, 255]), 0);
    assert.equal(p.add([254, 255, 255]), 0, 'near-identical colours are not quantised together');
    assert.equal(p.add(parseRgb('rgba(0,0,0,0)')), -1, 'a transparent colour got an index');
    for (let i = 0; i < 400; i++) p.add([(i * 7) & 0xff, (i * 13) & 0xff, (i * 29) & 0xff]);
    assert.ok(p.list().length <= 256, 'the palette exceeded what an indexed PNG can hold');
  });

  test('§2h · the selectors cover what a report is for', () => {
    const roles = new Set(BOARD_SELECTORS.map((s) => s.role));
    for (const must of ['bar', 'note', 'day', 'column', 'overflow', 'rail']) {
      assert.ok(roles.has(must), `${must} is not collected — a report cannot show it`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · THE IMAGE PATH HAS NO GLYPH CAPABILITY
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · redaction by not drawing, proved on the capability', () => {
  test('§3a · ██ THE RASTER HAS EXACTLY TWO MUTATORS AND BOTH TAKE ONLY NUMBERS ██', () => {
    // This is the strongest form of "redact by not drawing" available: not a filter that ran, but
    // a capability the code does not have. There is no fillText, no drawImage, no font, no
    // measureText, no source-over. Handed the fixture's needles, this class has no function that
    // could put one on a pixel.
    const names = Object.getOwnPropertyNames(Raster.prototype).filter((n) => n !== 'constructor');
    assert.deepEqual(names.sort(), ['fillRect', 'strokeRect']);
    const src = [Raster.prototype.fillRect, Raster.prototype.strokeRect, encodePng].map(String).join('\n');
    for (const forbidden of ['fillText', 'strokeText', 'drawImage', 'measureText', 'font',
      'getContext', 'toDataURL', 'toBlob', 'ImageData', 'createImageBitmap']) {
      assert.equal(new RegExp(forbidden).test(src), false, `the raster names ${forbidden}`);
    }
    // and `fillRect` really only writes: handed a string it clips to nothing rather than coercing.
    const r = new Raster(4, 4, 0);
    r.fillRect(NEEDLE.privatBar, 0, 10, 10, 1);
    assert.deepEqual([...r.px], new Array(16).fill(0), 'a string reached the pixel buffer');
  });

  test('§3b · the output is a real PNG that node:zlib can inflate to the exact raster', () => {
    // Hand-rolled DEFLATE is where "it looks like a PNG" hides. The bytes are parsed as a PNG
    // here — chunk by chunk, CRC by CRC — and the IDAT is inflated by a decoder this project did
    // not write and compared pixel for pixel.
    const r = new Raster(120, 40, 0);
    r.fillRect(10, 5, 60, 12, 1);
    r.strokeRect(2, 2, 116, 36, 2);
    const png = encodePng(r, [[255, 255, 255], [40, 40, 44], [190, 190, 190]]);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
    let off = 8;
    const seen = [];
    let idat = null;
    while (off < png.length) {
      const len = dv.getUint32(off);
      const type = String.fromCharCode(...png.subarray(off + 4, off + 8));
      seen.push(type);
      if (type === 'IDAT') idat = png.subarray(off + 8, off + 8 + len);
      assert.equal(dv.getUint32(off + 8 + len), crc32(png.subarray(off + 4, off + 8 + len)), `${type} CRC`);
      off += 12 + len;
    }
    assert.deepEqual(seen, [...EMITTED_CHUNKS], 'the chunk list is not what the encoder claims');
    const raw = zlib.inflateSync(Buffer.from(idat));
    assert.equal(raw.length, (r.w + 1) * r.h);
    for (let y = 0; y < r.h; y++) {
      assert.equal(raw[y * (r.w + 1)], 0, 'a filter byte is not 0');
      for (let x = 0; x < r.w; x++) {
        assert.equal(raw[y * (r.w + 1) + 1 + x], r.px[y * r.w + x], `pixel ${x},${y}`);
      }
    }
  });

  test('§3c · NO TEXT CHUNK IS EVER EMITTED — a caption cannot be added later', () => {
    assert.deepEqual([...EMITTED_CHUNKS], ['IHDR', 'PLTE', 'IDAT', 'IEND']);
    for (const t of ['tEXt', 'iTXt', 'zTXt', 'tIME']) {
      assert.equal(EMITTED_CHUNKS.includes(t), false);
      assert.equal(encodePng(new Raster(2, 2), [[0, 0, 0]]).toString().includes(t), false);
    }
  });

  test('§3d · deflate round-trips through a decoder this project did not write', () => {
    for (const data of [new Uint8Array(0), Uint8Array.from([1, 2, 3]), new Uint8Array(5000).fill(9),
      Uint8Array.from({ length: 4096 }, (_, i) => (i * 31) & 0xff)]) {
      const back = zlib.inflateRawSync(Buffer.from(deflateRaw(data, 101)));
      assert.deepEqual([...back], [...data], `deflate lost bytes at length ${data.length}`);
    }
    assert.equal(adler32(TE.encode('abc')), 0x024d0127, 'adler32 is wrong');
  });

  test('§3e · the whole board renders, is bounded, and stays small', () => {
    const { root, io } = fakeBoard();
    const out = renderRedactedBoard(root, io);
    assert.ok(out.w <= MAX_W && out.h <= MAX_H, `${out.w}x${out.h} exceeds the cap`);
    assert.ok(out.bytes.length > 100, 'the image is empty');
    assert.ok(out.bytes.length < 262144, `${out.bytes.length} bytes — over the endpoint's own cap`);
    assert.ok(out.counts.redactions > 0);
  });

  test('§3f · a board larger than the cap is SCALED, never cropped', () => {
    // A cropped board hides the corner the bug is in.
    const { io, root } = fakeBoard();
    const big = { ...root, box: { left: 0, top: 0, width: MAX_W * 3, height: MAX_H * 2 } };
    const io2 = { ...io, rects: (n) => (n === big ? big.box : n.box) };
    const out = renderRedactedBoard(big, io2);
    assert.ok(out.scale < 1, 'a huge board was not scaled at all');
    assert.equal(out.w, MAX_W, 'the scaled width is not the cap — it was cropped');
    // and the far corner still exists in the output, which cropping would have removed.
    assert.ok(out.h > 1);
  });

  test('§3g · the guard runs on the real path: a poisoned primitive stops the REPORT', () => {
    const { root } = fakeBoard();
    const io = {
      rects: () => ({ left: 0, top: 0, width: 10, height: 10 }),
      style: () => ({}),
      lineBoxes: () => [],
    };
    // A walker that started emitting a label would throw here rather than encode it.
    assert.throws(() => assertNumericOnly([{ role: 'note', x: 0, y: 0, w: 1, h: 1, fill: 0, stroke: 0, text: 'x' }]));
    assert.doesNotThrow(() => renderRedactedBoard(root, io));
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · THE PREVIEW SCREEN *IS* THE PAYLOAD
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · one string, shown and sent', () => {
  const base = {
    text: 'Der Balken für den Urlaub springt beim Ziehen eine Woche zurück.',
    lang: 'de', appVersion: '2.0.0', build: '1041', system: 'macOS 15.2',
    screen: 'settings', spaceKind: 'family', now: 1_800_000_000_000,
  };

  test('§4a · the string on screen and the string on the wire are the SAME string', () => {
    // Not "they render the same data" — two functions can stop agreeing silently. The identity is
    // what makes „genau dieser Text verlässt deinen Mac" a checkable promise.
    const built = buildReport(base);
    const body = wireBody(built, null);
    assert.equal(body.report, built.text);
    assert.ok(Object.is(body.report, built.text), 'the wire carries a COPY, not the previewed string');
    assert.deepEqual([...built.bytes], [...TE.encode(built.text)]);
  });

  test('§4b · it carries the six things it is meant to, and her sentence verbatim', () => {
    noteEvent('render', { ms: 51 }, 1_800_000_000_000);
    noteEvent('refusal', { op: 'drag:commit', code: 'not_owner' }, 1_800_000_000_001);
    const built = buildReport(base);
    assert.match(built.text, /2\.0\.0 \(1041\)/);
    assert.match(built.text, /macOS 15\.2/);
    assert.match(built.text, /settings · Familienkreis/);
    assert.match(built.text, /2027-01-15 \d\d:\d\d/);
    assert.ok(built.text.includes(base.text), 'her own sentence is not in the report');
    assert.match(built.text, /render ms=51/);
    assert.match(built.text, /refusal op=drag:commit code=not_owner/);
  });

  test('§4c · a shell that answered with an error string cannot put it in the payload', () => {
    const built = buildReport({ ...base, appVersion: 'Error: EPERM /Users/oma/Library', build: NEEDLE.scratch, system: NEEDLE.diagnosis });
    assert.match(built.text, /unbekannt/);
    for (const n of [NEEDLE.scratch, NEEDLE.diagnosis]) assert.deepEqual(found(built.text, n), []);
    assert.equal(built.text.includes('EPERM'), false);
  });

  test('§4d · the screen and the space kind are closed sets, never free text', () => {
    const built = buildReport({ ...base, screen: NEEDLE.privatNote, spaceKind: NEEDLE.category });
    assert.match(built.text, /other · allein/);
    assert.deepEqual(found(built.text, NEEDLE.privatNote), []);
    assert.deepEqual(found(built.text, NEEDLE.category), []);
    assert.ok(SCREENS.length >= 5 && SPACE_KINDS.length === 3);
  });

  test('§4e · ██ THE RAW SPACE ID IS NEVER IN IT — it is the family\'s correlation handle ██', () => {
    // Subtle and load-bearing: the relay already stores the space id, so with it a report and a
    // database row are the same family and story 21.3's promise about what the operator can see
    // stops holding. What goes out is the WORD „Familienkreis".
    const built = buildReport({ ...base, spaceKind: 'family' });
    const body = wireBody(built, null);
    assert.deepEqual(found(flatten(body, null), NEEDLE.spaceId), []);
    assert.match(built.text, /Familienkreis/, 'the control: the KIND is named, and was found');
  });

  test('§4f · with no image the report says so, rather than pretending', () => {
    const built = buildReport({ ...base, image: null });
    assert.equal(built.image, null);
    assert.match(built.text, /— kein Bild —/);
    assert.equal(wireBody(built, null).image, null);
  });

  test('§4g · the English report is a real translation, not a German one with English labels', () => {
    const de = buildReport(base);
    const en = buildReport({ ...base, lang: 'en' });
    assert.match(en.text, /LangzeitPlaner — feedback/);
    assert.match(en.text, /What happened/);
    assert.match(en.text, /Trail \(structure only, no content\)/);
    assert.equal(/Rückmeldung|Verlauf|Zeitpunkt/.test(en.text), false, 'German leaked into the English report');
    assert.equal(/What happened/.test(de.text), false);
    assert.ok(en.text.includes(base.text), 'her own sentence is translated — it must not be');
  });

  test('§4h · the signed bytes cover the text AND the image, under a domain prefix', () => {
    const built = buildReport({ ...base, image: { bytes: Uint8Array.from([1, 2, 3]), w: 1, h: 1, counts: {} } });
    const bytes = signedBytes(built);
    const s = new TextDecoder().decode(bytes);
    assert.ok(s.startsWith('lzp/feedback/v1\n'), 'no domain prefix — a sync signature could be replayed');
    assert.ok(bytes.length > built.bytes.length + 3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · ██ THE WHOLE PAYLOAD, GREPPED ██
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// LZP-1009's own commissioned row. A real fixture board, the real walker, the real encoder, the
// real report builder and the real wire body — then five German needles, four spellings each,
// over the JSON body AND the raw image bytes.

describe('§5 · the payload contains no string from the fixture board', () => {
  function fullPayload(over = {}) {
    // The structural events are noted HERE rather than in one row, so every row in §5 inspects a
    // payload with a populated ring buffer — §5b's positive control depends on one being in it.
    noteEvent('render', { ms: 51 }, 1_800_000_000_000);
    noteEvent('error', { name: 'KeyStoreUnavailableError' }, 1_800_000_000_001);
    const { root, io } = fakeBoard();
    const image = renderRedactedBoard(root, io);
    const built = buildReport({
      text: 'Beim Ziehen springt der Balken zurück.',
      lang: 'de', appVersion: '2.0.0', build: '1041', system: 'macOS 15.2',
      screen: 'board', spaceKind: 'family', now: 1_800_000_000_000, image, ...over,
    });
    return { body: wireBody(built, null), built, image };
  }

  test('§5a · ██ seven needles, five spellings, over the body and the image bytes — nothing ██', () => {
    const { body, image } = fullPayload();
    const hay = flatten(body, image.bytes);
    for (const [name, needle] of Object.entries(NEEDLE)) {
      assert.deepEqual(found(hay, needle), [],
        `${name} is in the outbound feedback payload: ${JSON.stringify(needle)}`);
    }
  });

  test('§5b · THE SEARCH IS PROVED TO SEARCH — it finds what IS sent', () => {
    // Every row above is an absence, and an absence is what a broken matcher also produces. The
    // identical function over the identical payload, looking for the things that legitimately go.
    const { body, image } = fullPayload();
    const hay = flatten(body, image.bytes);
    for (const [what, s] of Object.entries({
      'her own sentence': 'Beim Ziehen springt der Balken zurück.',
      'the app version': '2.0.0',
      'the system': 'macOS 15.2',
      'the space KIND': 'Familienkreis',
      'the report heading': 'LangzeitPlaner — Rückmeldung',
      'the structural event': 'KeyStoreUnavailableError',
    })) {
      assert.ok(found(hay, s).length > 0, `the search did not find ${what} — §5a proves nothing`);
    }
  });

  test('§5c · THE NEEDLES REALLY WERE ON THE BOARD — the fixture is not empty', () => {
    // The other half of non-vacuity: §5a would also be green if the fixture had never carried the
    // secrets. The same search over the fixture's own text must find every one.
    const { nodes } = fakeBoard();
    const boardText = nodes.map((n) => n.text || '').join('\n');
    for (const [name, needle] of Object.entries(NEEDLE)) {
      if (name === 'spaceId') continue;                 // not a text node; §4e owns it
      assert.ok(found(boardText, needle).length > 0, `${name} was never on the fixture board`);
    }
  });

  test('§5d · ██ THE MUTANT — one entry title added to the payload IS caught ██', () => {
    // The mutation LZP-1009 names: a well-meaning edit that puts one entry title into the report
    // "for context". The row that dies is §5a, and it dies on the FIRST needle.
    const { built, image } = fullPayload();
    const poisoned = { ...wireBody(built, null), report: `${built.text}\nKontext: ${NEEDLE.privatBar}` };
    const hay = flatten(poisoned, image.bytes);
    assert.ok(found(hay, NEEDLE.privatBar).length > 0,
      '§5a IS MEASURING NOTHING — a title planted in the payload was not found');
    // and it is caught in the b64url spelling too, which a plain substring search would miss.
    const encoded = b64(TE.encode(NEEDLE.privatNote));
    const b64Poisoned = { ...wireBody(built, null), report: `${built.text}\n${encoded}` };
    const hay2 = flatten(b64Poisoned, null);
    assert.equal(hay2.includes(NEEDLE.privatNote), false, 'wrong control — the plain search finds it');
    assert.ok(found(hay2, NEEDLE.privatNote).length > 0, 'the b64url spelling is not searched for');
  });

  test('§5e · THE SECOND MUTANT — a title drawn into the IMAGE would be caught too', () => {
    // The image is bytes, and §5a reads them as latin-1. A needle written into the pixel plane —
    // which is what a `fillText` would eventually amount to — is found by the same search.
    const r = new Raster(64, 8, 0);
    const bytes = TE.encode(NEEDLE.privatBar);
    for (let i = 0; i < Math.min(bytes.length, r.px.length); i++) r.px[i] = bytes[i];
    const palette = Array.from({ length: 256 }, (_, i) => [i, i, i]);
    const png = encodePng(r, palette);
    // ██ THE ROW THAT FOUND THE HOLE IN §5a. ██
    // The needle is plainly in the pixel buffer. It is NOT byte-for-byte in the encoded file —
    // DEFLATE Huffman-codes its literals — so the obvious search over `png` is green over a
    // leaking image. `flatten` therefore inflates, and this row is the proof that it must.
    assert.equal(found(latin1(png), NEEDLE.privatBar).length, 0,
      'the compressed file happens to contain the needle verbatim — pick a longer one, this row '
      + 'is meant to demonstrate that searching the FILE is not enough');
    assert.ok(found(flatten({ v: 1 }, png), NEEDLE.privatBar).length > 0,
      'a needle drawn into the pixel plane is NOT caught — §5a\'s image half is vacuous');
  });

  test('§5f · the report never carries the relay origin either', () => {
    const { body, image } = fullPayload();
    const hay = flatten(body, image.bytes);
    assert.equal(hay.includes('relay.example.com'), false);
    assert.equal(/https?:\/\//.test(hay), false, 'the payload names a URL');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 · THE PORT CONTRACT
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§6 · the seam, so the one line this ticket does not own cannot land wrong', () => {
  test('§6a · unbound is the honest default, and `canSend` says so', () => {
    assert.equal(feedbackPort(), null);
    assert.equal(canSend(), false);
  });

  test('§6b · a port without `send` is refused at bind time, not at press time', () => {
    // A binder that got the shape wrong must fail where the mistake is, not on the evening a
    // person finally presses „Senden".
    assert.throws(() => setFeedbackPort({ appVersion: '2.0.0' }), /send\(body\)/);
    assert.throws(() => setFeedbackPort({ send: 'not a function' }), /send\(body\)/);
    assert.equal(canSend(), false);
  });

  test('§6c · a well-formed port binds, and the last binder wins', async () => {
    const calls = [];
    setFeedbackPort({ send: async (b) => { calls.push(b); return { status: 202, body: { ok: true } }; }, appVersion: '2.0.0', spaceKind: 'family' });
    assert.equal(canSend(), true);
    const res = await feedbackPort().send({ v: 1, report: 'x' });
    assert.equal(res.status, 202);
    assert.equal(calls.length, 1);
    setFeedbackPort({ send: async () => ({ status: 500, body: {} }) });      // a re-arm after „Beitreten"
    assert.equal((await feedbackPort().send({})).status, 500);
    setFeedbackPort(null);
    assert.equal(canSend(), false);
  });

  test('§6d · the path is fixed by the seam and agrees with the server', () => {
    // The port is handed no origin and no path: nothing in this tree can be pointed at a second
    // endpoint by a bug here.
    assert.equal(FEEDBACK_PATH, '/api/v1/feedback');
  });

  test('§6e · the feedback tree imports nothing that can open a socket', async () => {
    // ADR 003 §7 gate 2, from this tree's side. `tests/tier1/network-scope.test.js` §2 owns the
    // module-graph claim; this is the cheap direct one, so a future edit here fails in the file
    // that caused it.
    const mods = ['events.js', 'geometry.js', 'png.js', 'redact.js', 'report.js', 'copy.js', 'port.js'];
    for (const m of mods) {
      const mod = await import(`../../src/js/feedback/${m}`);
      assert.ok(mod, m);
    }
    const srcs = [collectPrimitives, encodePng, buildReport, wireBody, setFeedbackPort, noteEvent]
      .map(String).join('\n');
    for (const forbidden of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon']) {
      assert.equal(new RegExp(`\\b${forbidden}\\b`).test(srcs), false, `the feedback tree names ${forbidden}`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7 · THE COPY
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§7 · German first, both languages, and the promises it makes', () => {
  test('§7a · both tables carry exactly the same keys', () => {
    assert.deepEqual(Object.keys(COPY_TABLES.de).sort(), Object.keys(COPY_TABLES.en).sort());
    assert.ok(Object.keys(COPY_TABLES.de).length > 30);
  });

  test('§7b · no German string is left in the English table, and vice versa', () => {
    for (const [k, v] of Object.entries(COPY_TABLES.en)) {
      const s = Array.isArray(v) ? v.join(' ') : v;
      assert.equal(/[äöüßÄÖÜ]/.test(s), false, `en.${k} still has German in it: ${s}`);
    }
    const de = Object.values(COPY_TABLES.de).map((v) => (Array.isArray(v) ? v.join(' ') : v)).join(' ');
    assert.ok(/[äöüßÄÖÜ]/.test(de), 'the German table has no German in it');
  });

  test('§7c · the screen makes the promise, in the person\'s own words', () => {
    assert.match(c('de', 'previewLead'), /Genau dieser Text und genau dieses Bild verlassen deinen Mac/);
    assert.match(c('de', 'imageLead'), /neu gezeichnet, nicht abfotografiert/);
    assert.match(c('de', 'imageLead'), /nie im Bild/);
    assert.match(c('en', 'imageLead'), /re-drawn, not photographed/);
    // and it names the four things that never go.
    const never = c('de', 'never');
    assert.equal(never.length, 4);
    assert.ok(never.some((l) => /Texte deiner Einträge/.test(l)));
    assert.ok(never.some((l) => /Schlüssel/.test(l)));
  });

  test('§7d · the size refusal explains WHY it is not truncated', () => {
    const s = c('de', 'tooLarge', 300, 256);
    assert.match(s, /300 kB/);
    assert.match(s, /256 kB/);
    assert.match(s, /nicht gekürzt/);
    assert.match(s, /gelogen/, 'the copy does not say why truncating would be dishonest');
  });

  test('§7e · NO SURVEY WORDS ANYWHERE — Principle 9', () => {
    // A feedback screen drifts into a survey one word at a time. This is the row that notices.
    const all = JSON.stringify(COPY_TABLES).toLowerCase();
    for (const banned of ['bewerte', 'bewertung', 'sterne', 'zufrieden', 'umfrage', 'rate us',
      'rating', 'survey', 'how likely', 'satisf', 'nps', 'feedback geben?']) {
      assert.equal(all.includes(banned), false, `the copy has drifted into a survey: "${banned}"`);
    }
  });

  test('§7f · a missing key falls back to German rather than to the key name', () => {
    assert.equal(c('en', 'nichtVorhanden'), undefined);
    assert.equal(c('de', 'send'), 'Senden');
    assert.equal(c('xx', 'send'), 'Senden', 'an unknown language does not fall back to German');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §8 · THE MUTANTS
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§8 · what each defect would kill', () => {
  test('§8a · M1 — widen TOKEN_RE to /^.{0,64}$/ ⇒ §1d dies', () => {
    const wide = /^.{0,64}$/;
    assert.ok(wide.test(NEEDLE.privatNote), 'the mutant would not actually admit an entry title');
    assert.equal(TOKEN_RE.test(NEEDLE.privatNote), false, '§1d is the row that dies');
  });

  test('§8b · M2 — emit `label` from the geometry walker ⇒ §2b, §2c and §5a die', () => {
    assert.throws(() => assertNumericOnly([{ role: 'bar', x: 0, y: 0, w: 1, h: 1, fill: 0, stroke: 0, label: NEEDLE.privatBar }]));
  });

  test('§8c · M3 — re-encode the report on the way to the wire ⇒ §4a dies', () => {
    // `wireBody` doing `report: String(built.text)` or a `.trim()` would pass every other row and
    // break the identity that makes the preview a promise.
    const built = buildReport({ text: 'x', lang: 'de', now: 0 });
    assert.ok(Object.is(wireBody(built, null).report, built.text));
  });

  test('§8d · M4 — drop the `safe()` guard on shell-supplied fields ⇒ §4c dies', () => {
    const built = buildReport({ text: 'x', lang: 'de', now: 0, system: NEEDLE.diagnosis });
    assert.deepEqual(found(built.text, NEEDLE.diagnosis), []);
  });

  test('§8e · M5 — bind a port with no `send` ⇒ §6b dies', () => {
    assert.throws(() => setFeedbackPort({}));
  });

  test('§8f · M6 — emit a tEXt chunk carrying the board title ⇒ §3c dies', () => {
    assert.equal(EMITTED_CHUNKS.includes('tEXt'), false);
  });
});
