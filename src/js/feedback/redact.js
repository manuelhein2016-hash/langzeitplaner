// src/js/feedback/redact.js — the redacted board image, start to finish.  LZP-1009 · ADR 004.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE PIPELINE, AND THE THING THAT IS MISSING FROM IT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//     board DOM ──► collectPrimitives ──► [numbers] ──► assertNumericOnly ──► Raster ──► PNG
//                   (geometry.js)                        (geometry.js)      (png.js)
//
// **There is no branch of that pipeline in which a full-fidelity image exists.** Not a captured
// one that is then blurred, not a canvas that is then cleared, not a data URL held in a variable
// for one tick. The widest thing that ever exists is a list of rectangles, and rectangles cannot
// be un-redacted because there was never anything in them.
//
// That is a stronger claim than "we redact carefully", and it is the claim the PO's mother is
// actually owed: she is being asked to send a picture of her family's calendar to a stranger.
// „Vertrau mir, ich habe es geschwärzt" is not good enough for the person whose data it is. What
// she gets instead is: the picture is BUILT from geometry, she looks at it before it moves, and
// the thing she is worried about was never in the file.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE SIZE DISCIPLINE
// ─────────────────────────────────────────────────────────────────────────────────────────────
// The endpoint REJECTS an over-size report and never truncates one (`server/core/limits.js`,
// E10-L2), because a truncated report is a lie about what was sent and the preview screen
// promised her otherwise. That means the image must be small BY CONSTRUCTION rather than by
// being cut down afterwards, so:
//
//   · it is rendered at `MAX_W × MAX_H` at the largest, scaled by one uniform factor, and
//   · a board that would still not fit is reported as a smaller image with `scale` on the
//     preview screen, not as a cropped one. A cropped board hides the corner the bug is in.

import { Raster, encodePng } from './png.js';
import { collectPrimitives, assertNumericOnly } from './geometry.js';

/** The largest image this path may ever produce. A 12-month board is wide, not deep. */
export const MAX_W = 1600;
export const MAX_H = 1100;

/** Roles that are drawn as an outline as well as a fill — the board's structure. */
const STROKED = new Set(['column', 'day', 'colhead', 'bar', 'note', 'pad']);

/**
 * Render the board to a PNG that contains no glyph.
 *
 * @param {Element} root the board element
 * @param {Object} [io] injected DOM readers, for tests; see `collectPrimitives`
 * @returns {{ bytes:Uint8Array, w:number, h:number, scale:number, counts:Object }}
 */
export function renderRedactedBoard(root, io) {
  const { w, h, prims, palette, counts } = collectPrimitives(root, io);

  // ██ THE GUARD RUNS IN PRODUCTION, NOT ONLY IN A TEST. ██
  // If `geometry.js` is ever edited into emitting a field that is not one of the six numbers and
  // the role, this throws and the report is not built. A refusal is the correct failure: the
  // alternative is a report that leaves the Mac carrying a field nobody reviewed.
  assertNumericOnly(prims);

  const scale = Math.min(1, MAX_W / w, MAX_H / h);
  const W = Math.max(1, Math.round(w * scale));
  const H = Math.max(1, Math.round(h * scale));

  const raster = new Raster(W, H, 0);
  for (const p of prims) {
    const x = p.x * scale;
    const y = p.y * scale;
    const pw = p.w * scale;
    const ph = p.h * scale;
    if (p.fill >= 0) raster.fillRect(x, y, pw, ph, p.fill);
    if (p.stroke >= 0 && STROKED.has(p.role)) raster.strokeRect(x, y, pw, ph, p.stroke, 1);
  }

  const bytes = encodePng(raster, palette);
  return { bytes, w: W, h: H, scale: Math.round(scale * 1000) / 1000, counts };
}

/**
 * The same picture, as a `data:` URL, purely so the preview screen can show it in an `<img>`.
 *
 * `btoa` over a binary string rather than `URL.createObjectURL`: an object URL is a live handle
 * into a Blob that outlives the sheet and that another module could read, and the whole point of
 * this path is that nothing durable holds board pixels.
 *
 * @param {Uint8Array} bytes @returns {string}
 */
export function pngDataUrl(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return 'data:image/png;base64,' + btoa(bin);
}
