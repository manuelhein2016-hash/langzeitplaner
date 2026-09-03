// src/js/feedback/geometry.js — the board, re-read as numbers.  LZP-1009 · ADR 004.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE ONE SENTENCE THIS FILE IS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   **Text is not redacted here. Text is never read here.**
//
// LZP-1009 says "produce the image by re-rendering the board with a redaction flag, not by
// capturing and blurring", and this is the re-render. It walks the live board and emits a list of
// **primitives**, where a primitive is:
//
//     { role: <one of ROLES>, x: n, y: n, w: n, h: n, fill: n, stroke: n }
//
// Seven numbers and one token from a frozen enum. There is no `text` field, no `label`, no
// `title`, no `id`, no `dataset` and no `aria-label`, and `collectPrimitives` never calls
// `textContent`, `innerText`, `innerHTML`, `nodeValue` or `getAttribute` — asserted by
// `tests/tier1/feedback.test.js` §2 over this file's own source, and asserted again on the
// OUTPUT: every value of every returned object is a finite number or a member of `ROLES`.
//
// That is what makes the redaction irreversible rather than merely thorough. A blurred pixel is a
// transformed glyph and transformations get inverted. A rectangle at the same metrics as a glyph
// run is not a transformed glyph — the glyph was never in the pipeline. Nobody can recover it,
// **including us**.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT SURVIVES, AND WHY EACH ONE IS WORTH THE BYTES
// ─────────────────────────────────────────────────────────────────────────────────────────────
// The report exists because the PO's mother is looking at something wrong. Every one of these is
// a thing that can BE wrong and that a sentence typed by a non-technical tester cannot describe:
//
//   · bar geometry — the wrong length, the wrong lane, the wrong month
//   · lanes and stacking — two bars on one row, a bar under the day numbers
//   · the `+n` overflow chip — a day that swallowed entries and did not say so
//   · the ownership rail — the colour stripe that says whose entry this is
//   · the redaction boxes THEMSELVES, at glyph metrics — a label that overflows its bar, a note
//     that is clipped, a line that wrapped where it should not. This is the reason the boxes are
//     per-line-box and not one box per element: "the text is too long for the bar" is invisible
//     if the redaction is a single rectangle the size of the bar.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// OWNERSHIP
// ─────────────────────────────────────────────────────────────────────────────────────────────
// `src/js/board.js`, `layout.js` and `src/css/app.css` belong to a parallel workflow. This file
// therefore asserts **properties** of the rendered board and never its internals: it reads the
// selectors from `BOARD_SELECTORS` below, and a selector that matches nothing produces a report
// with fewer rectangles rather than an exception. `tests/tier2/feedback.dom.js` is where the
// selectors are checked against the real board, in the real engine — the only place that check
// can honestly live.

/**
 * Every role a rectangle may carry. A CLOSED SET, because `role` is the one non-numeric field
 * that reaches the report and a closed set is the only kind of string that cannot carry content.
 */
export const ROLES = Object.freeze([
  'paper',      // the board's own background
  'column',     // one month column
  'colhead',    // the month heading strip
  'day',        // one day row
  'today',      // the today marker
  'weekend',    // a weekend / holiday tint
  'note',       // an entry chip
  'bar',        // a multi-day bar
  'barcont',    // a bar's continuation arrow
  'rail',       // the ownership rail — whose entry this is
  'overflow',   // the +n chip
  'pad',        // the scratchpad panel
  'redaction',  // a filled box where a run of text was NOT drawn
  'chrome',     // toolbar, legend, anything outside the board proper
]);

const ROLE_SET = new Set(ROLES);

/**
 * The board's structure, as selectors. Data, so that a board rename by the parallel workflow is
 * a one-line change here and a failing row in `feedback.dom.js` rather than a silent blank image.
 *
 * ORDER IS PAINT ORDER. The rasteriser draws the list front to back, so a container must appear
 * before the things inside it.
 */
export const BOARD_SELECTORS = Object.freeze([
  Object.freeze({ sel: '.col', role: 'column' }),
  Object.freeze({ sel: '.col-head', role: 'colhead' }),
  Object.freeze({ sel: '.day', role: 'day' }),
  Object.freeze({ sel: '.day.we, .day.hol', role: 'weekend' }),
  Object.freeze({ sel: '.day.today', role: 'today' }),
  Object.freeze({ sel: '.note', role: 'note' }),
  Object.freeze({ sel: '.bar', role: 'bar' }),
  Object.freeze({ sel: '.bar-cont-up, .bar-cont-down', role: 'barcont' }),
  Object.freeze({ sel: '.chip, .neu-dot, .cue', role: 'rail' }),
  Object.freeze({ sel: '.d-more', role: 'overflow' }),
  Object.freeze({ sel: '.scratchpad, .pad', role: 'pad' }),
]);

/** Everything a text run may live in. Matched against the ELEMENT, never against its content. */
const TEXT_HOSTS = '.bar-label, .note, .d-num, .d-wd, .d-hol, .col-head, .d-more, .pad-label, .chip, .redacted-word';

/** A colour that is not a colour. Used when `getComputedStyle` is unavailable (a detached node). */
const TRANSPARENT = Object.freeze([-1, -1, -1]);

/**
 * Parse `rgb(a)` into a triple. Returns `TRANSPARENT` for anything else — including named
 * colours, which the engine always resolves to `rgb()` before `getComputedStyle` returns them,
 * so an unparseable value means "nothing was painted" rather than "we could not read it".
 * @param {string} v @returns {readonly number[]}
 */
export function parseRgb(v) {
  if (typeof v !== 'string') return TRANSPARENT;
  const m = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)\s*)?\)$/);
  if (!m) return TRANSPARENT;
  const a = m[4] === undefined ? 1 : Number(m[4]);
  if (!(a > 0.04)) return TRANSPARENT;                    // effectively invisible
  return [Math.round(Number(m[1])), Math.round(Number(m[2])), Math.round(Number(m[3]))];
}

/**
 * A palette that grows on demand and quantises, so a board with fifty near-identical greys does
 * not spend fifty of the 256 indexed slots on them.
 */
export class Palette {
  /**
   * @param {readonly number[]} bg the colour index 0 always is
   *
   * ⚠ THE BACKGROUND IS QUANTISED ON THE WAY IN, like every other colour. It was not, once, and
   * the consequence was invisible: `add()` quantises before it looks the colour up, so the paper
   * white stored raw at index 0 never matched itself and every element painted in the background
   * colour got a SECOND, near-identical palette entry. Harmless to look at, and it spends the
   * 256 indexed slots twice as fast on a board with many tints. Found by
   * `tests/tier1/feedback.test.js` §2g.
   */
  constructor(bg = [255, 255, 255]) {
    const q = quantise(bg && bg[0] >= 0 ? bg : [255, 255, 255]);
    this.entries = [q];
    this.index = new Map([[key(q), 0]]);
  }

  /** @param {readonly number[]} rgb @returns {number} a palette index, or -1 for transparent */
  add(rgb) {
    if (!rgb || rgb[0] < 0) return -1;
    const q = quantise(rgb);
    const k = key(q);
    const hit = this.index.get(k);
    if (hit !== undefined) return hit;
    if (this.entries.length >= 256) return 1;                  // saturated: fall back to the ink
    const i = this.entries.length;
    this.entries.push(q);
    this.index.set(k, i);
    return i;
  }

  list() { return this.entries.map((e) => [e[0], e[1], e[2]]); }
}

function key(c) { return (c[0] << 16) | (c[1] << 8) | c[2]; }

/** 5 bits per channel — one definition, used by both the constructor and `add`. */
function quantise(c) { return [c[0] & 0xf8, c[1] & 0xf8, c[2] & 0xf8]; }

/**
 * Walk the board and return rectangles.
 *
 * @param {Element} root the board element
 * @param {Object} [io] injected for tests: `{ rects, style, lineBoxes }`
 * @returns {{ w:number, h:number, prims:Array<Object>, palette:Array<number[]>, counts:Object }}
 */
export function collectPrimitives(root, io) {
  const rects = (io && io.rects) || ((n) => n.getBoundingClientRect());
  const style = (io && io.style) || ((n) => getComputedStyle(n));
  const lineBoxes = (io && io.lineBoxes) || defaultLineBoxes;

  const base = rects(root);
  const W = Math.max(1, Math.round(base.width));
  const H = Math.max(1, Math.round(base.height));
  const ox = base.left;
  const oy = base.top;

  const pal = new Palette(parseRgb(style(root).backgroundColor) || [255, 255, 255]);
  const prims = [];
  const counts = { rects: 0, redactions: 0, roles: {} };

  const push = (role, r, fill, stroke) => {
    if (!ROLE_SET.has(role)) return;                          // an unknown role is dropped, never emitted
    const x = r.left - ox;
    const y = r.top - oy;
    const w = r.width;
    const h = r.height;
    if (!(w > 0) || !(h > 0)) return;
    if (x > W || y > H || x + w < 0 || y + h < 0) return;      // scrolled out of frame
    prims.push({ role, x: round2(x), y: round2(y), w: round2(w), h: round2(h), fill, stroke });
    counts.rects++;
    counts.roles[role] = (counts.roles[role] || 0) + 1;
  };

  for (const { sel, role } of BOARD_SELECTORS) {
    let nodes;
    try { nodes = root.querySelectorAll(sel); } catch { continue; }
    for (const n of nodes) {
      const cs = style(n);
      push(role, rects(n), pal.add(parseRgb(cs.backgroundColor)), pal.add(parseRgb(cs.borderTopColor)));
    }
  }

  // ── THE REDACTION PASS ────────────────────────────────────────────────────────────────────
  // One filled box per LINE BOX, at the metrics the glyphs occupied. `lineBoxes` returns
  // rectangles from a DOM Range — a Range yields geometry, and geometry is all that is read from
  // it. The text node is never stringified.
  let texts;
  try { texts = root.querySelectorAll(TEXT_HOSTS); } catch { texts = []; }
  for (const host of texts) {
    const cs = style(host);
    const ink = pal.add(parseRgb(cs.color));
    // ██ CLIPPED THE WAY THE ENGINE CLIPS GLYPHS. ██
    //
    // A `Range` reports a line box's INTRINSIC extent — the width the text would occupy if
    // nothing stopped it — and the board stops it constantly: `.bar-label` is
    // `max-width: 66px; overflow: hidden; text-overflow: ellipsis`, so „Kur in Bad Wörishofen"
    // measures 90px through a Range and PAINTS 66. Drawing the Range's box would put 24px of
    // solid ink across board the label does not cover, and the picture would then show a layout
    // that does not exist — the exact opposite of "layout bugs stay visible", and worse than no
    // picture because it invents one.
    //
    // Found by `tests/tier2/feedback.dom.js` against a real bar on a real board; tier 1 could not
    // see it, because a fake node has no overflow.
    //
    // ⚠ THE CLIP IS CONDITIONAL, AND ON THE SAME CONDITION THE ENGINE USES. `overflow: visible`
    // really does paint outside the box, and clipping unconditionally would then hide a genuine
    // overflow — which is one of the bugs a report is FOR. So the host's own computed `overflow`
    // decides, exactly as it decides for the glyphs.
    const hostRect = rects(host);
    const clipped = String(cs.overflow || 'visible') !== 'visible'
      || String(cs.overflowX || 'visible') !== 'visible';
    for (const box of lineBoxes(host)) {
      const b = clipped ? intersect(box, hostRect) : box;
      if (!b) continue;
      // Inset vertically so the box sits on the baseline the way the glyphs did, rather than
      // filling the line's full leading — a solid line-height block reads as a bar, not as text.
      push('redaction', {
        left: b.left, top: b.top + b.height * 0.14,
        width: b.width, height: Math.max(1, b.height * 0.7),
      }, ink, -1);
      counts.redactions++;
    }
  }

  return { w: W, h: H, prims, palette: pal.list(), counts };
}

/**
 * Per-line geometry for the text inside one element, via `Range.getClientRects()`.
 *
 * Only the DIRECT text children are ranged, so a `.note` containing a nested `.chip` does not
 * have its child's box counted twice — the child is matched by `TEXT_HOSTS` on its own pass.
 * @param {Element} host @returns {Array<DOMRect>}
 */
function defaultLineBoxes(host) {
  const out = [];
  for (const node of host.childNodes) {
    if (node.nodeType !== 3) continue;                        // Node.TEXT_NODE, by number: this
    try {                                                     // file never names the DOM's text API
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) out.push(r);
      range.detach?.();
    } catch { /* a detached or shadow node has no geometry; there is nothing to redact */ }
  }
  return out;
}

function round2(n) { return Math.round(n * 100) / 100; }

/** The overlap of two rects, or null when they do not meet. */
function intersect(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * THE GUARD, exported so it can be run in production and not only in a test.
 *
 * `redact.js` calls this on the primitive list before a single pixel is drawn. It is cheap, it
 * runs on every report, and it is the difference between "the walker above does not read text"
 * (a claim about code that someone will edit) and "no report has ever contained a string"
 * (a claim about every value that reached the raster).
 *
 * @param {Array<Object>} prims
 * @throws {TypeError} naming the offending field
 */
export function assertNumericOnly(prims) {
  const NUM = ['x', 'y', 'w', 'h', 'fill', 'stroke'];
  for (let i = 0; i < prims.length; i++) {
    const p = prims[i];
    const keys = Object.keys(p).sort();
    if (keys.join(',') !== 'fill,h,role,stroke,w,x,y') {
      throw new TypeError(`feedback: primitive ${i} has fields [${keys}] — only role and six numbers may reach the image`);
    }
    if (!ROLE_SET.has(p.role)) throw new TypeError(`feedback: primitive ${i} has role ${JSON.stringify(p.role)}`);
    for (const k of NUM) {
      if (typeof p[k] !== 'number' || !Number.isFinite(p[k])) {
        throw new TypeError(`feedback: primitive ${i}.${k} is ${typeof p[k]}, not a finite number`);
      }
    }
  }
  return prims;
}
