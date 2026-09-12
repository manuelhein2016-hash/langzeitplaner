// Turns the layout model into DOM. Nothing here decides geometry — that is
// layout.js — so the same numbers drive screen, drag previews and print.

import { buildBoard, UNKNOWN_MEMBER_INITIAL } from './layout.js';
import { t, getLang } from './i18n.js';
import { parseISO, MONTH_DE, MONTH_EN } from './dates.js';
import { colorOf } from './palette.js';
import { store } from './store.js';

const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

// ═════════════════════════════════════════════════════════════════════════════
// The family copy (LZP-705 / LZP-706)
//
// ADR 004 §4.3 puts these keys in `i18n.js`, which belongs to another work
// package. `t()` answers the KEY ITSELF when a table has no entry, so every
// string below resolves through `i18n` FIRST and falls back to this table only
// while the key is missing. The day the i18n owner lands them, i18n wins and
// this table goes quiet without a line changing here.
//
// „Belegt"/"Busy" and „Geteilt"/"Shared" are the addendum's own glossary §13.
// `belegtOwnerTip` is the REQUIRED string of ADR 002 §7.4's copy contract, which
// LZP-1003 audits verbatim; `expPending` exists because §6 forbids the badge
// from promising a state that has not reached the server. None of it uses
// §7.4's four forbidden claims — „gelöscht bei allen", „zurückgezogen",
// „niemand kann es mehr sehen", „live".
// ═════════════════════════════════════════════════════════════════════════════
const FAMILY_COPY = {
  de: {
    belegt: 'Belegt',
    geteilt: 'Geteilt',
    privat: 'Privat',
    belegtOwnerTip: 'Andere sehen: Datum, deinen Namen, deine Farbe — keinen Text.',
    geteiltOwnerTip: 'Andere sehen: Datum, Text, deinen Namen, deine Farbe.',
    expPending: 'noch nicht abgeglichen',
    overflowNew: 'neu',
  },
  en: {
    belegt: 'Busy',
    geteilt: 'Shared',
    privat: 'Private',
    belegtOwnerTip: 'Others see: the date, your name, your colour — no text.',
    geteiltOwnerTip: 'Others see: the date, the text, your name, your colour.',
    expPending: 'not synced yet',
    overflowNew: 'new',
  },
};

/** `t()` if `i18n.js` knows the key, this file's table otherwise. */
function ft(key) {
  const v = t(key);
  if (v !== key) return v;
  const table = FAMILY_COPY[getLang()] || FAMILY_COPY.de;
  return table[key] ?? key;
}

let model = null;
export const currentModel = () => model;

// ═════════════════════════════════════════════════════════════════════════════
// THE INCREMENTAL RENDER — LZP-1007, story 17.4 („60 fps")
//
// WHAT THIS REPLACED, AND WHY TUNING COULD NOT CLOSE IT
//
// `renderBoard` used to be `root.textContent = ''` followed by a full twelve-
// month rebuild: 4 195 boxes, every call. Measured in WebKit on the 8 × 2
// fixture (`e8-density-perf.dom.js` §E1, run alone so the number is not
// contention): 60.9 ms — 3.6 frames of a 60 fps budget — decomposed as ~3 ms of
// model, ~23 ms of DOM construction and ~34 ms of layout. Seven CSS levers were
// measured against it (fixed `.d-num`/`.d-wd`, `clip`, hidden pads, `contain`
// on `.day`, `.col`, `.rows`, no label max-width) and NONE of them moved it;
// `contain` on `.day` made it worse at 74.3. `content-visibility` is not
// available either — eleven of twelve columns are on screen, and off-screen
// boxes would falsify the tier-2 geometry rows.
//
// A full rebuild of twelve months cannot fit in one frame in WebKit. So this
// file stopped doing one. Almost every call changes very little — a member
// toggle, one entry edited, a category hidden, a layer flipped — and the board
// now touches only the boxes whose MODEL SLICE changed.
//
// ── THE ONE INVARIANT ────────────────────────────────────────────────────────
//
// **The incremental result is the full result.** Not "close enough": the same
// DOM, node for node, attribute for attribute. An incremental path that can
// differ from the full path is a bug factory, so the design gives it exactly
// one degree of freedom:
//
//   every node this file puts on the board is built by the SAME builder the
//   full path uses. The only thing the incremental path decides is whether to
//   RUN a builder or KEEP what the last run produced.
//
// That reduces correctness to a single, checkable claim: *if a slot's signature
// is unchanged, its builder would have produced the same node.* A signature is
// therefore a string over EVERY model field its builder reads, plus the copy
// epoch for the strings that come from `i18n` rather than the model. Signatures
// deliberately OVER-approximate where it is cheap to: an over-wide signature
// costs a rebuild nobody needed, an under-wide one costs a wrong board.
//
// `tests/tier2/e1-incremental.dom.js` holds the claim to random mutation
// sequences, deep-comparing the incremental board against a from-scratch
// rebuild after every single step.
//
// ── THE FOUR SLOTS OF A DAY ROW, AND WHY THEY ARE FOUR ───────────────────────
//
// Splitting the row is not premature: it is the whole win on the gesture that
// matters most. Hiding one member of eight changes a majority of the day rows
// on the fixture — but on most of them the ONLY thing that changes is the „+n"
// badge's digit, because that member's entry was folded into the overflow
// rather than drawn. `.d-more` is `position: absolute` (`app.css`), so
// rewriting its text dirties one out-of-flow box and NOT the row's flex line.
// Rebuilding the whole row to change a digit would have dirtied the line for
// nothing.
//
//   chrome  the row's own classes, `data-row`, `data-date`, `title`
//   num     `.d-num`, `.d-wd`, and the demoted-holiday dot
//   body    `.d-body` — the holiday line and the notes
//   more    the „+n" badge
//
// ── WHAT MAKES A KEPT NODE STILL EQUAL TO A FRESH ONE ────────────────────────
//
// A full rebuild also had two side effects that were never named as such,
// because destroying the DOM performed them for free. The incremental path has
// to perform them on purpose or it is not equivalent:
//
//   1. TRANSIENT MARKS. `find.js` writes `.hit`/`.current`, `interact.js`
//      writes `.selected`/`.dragging`. A fresh board carries none of them, so
//      neither may a kept one — `scrubMarks` below. (`redraw()` in `main.js`
//      re-applies all four straight after this call, exactly as before.)
//   2. NODES THIS FILE DID NOT MAKE. `interact.js` appends a drag preview, a
//      drop row, an inline editor and a category strip into `.rows`. The child
//      counts are checked per column and a column that does not match is
//      rebuilt whole, which is precisely what `textContent = ''` did to them.
//
// The scratchpad is the third: its `<textarea>` carries uncommitted typing in a
// PROPERTY, which no attribute comparison would see, so `patchPad` reconciles
// `value` and the `empty` class on every render rather than trusting the sig.
// It has ONE deliberate exception, and it is a principle rather than a tuning:
// KEYSTROKES THE MODEL HAS NOT BEEN TOLD ABOUT ARE HERS (P3). `patchPad` does not
// write over them and the full path carries them across the rebuild. It is
// narrow on purpose — see `unsent`: a box she is merely sitting in, having typed
// nothing since it and the model last agreed, still takes the model's value.
// ═════════════════════════════════════════════════════════════════════════════

/** Field separator inside a signature — a byte no board string can contain. */
const SEP = '\u001f';
/** Record separator, between the segments of a column's tail signature. */
const RSEP = '\u001e';

/**
 * The render cache: the nodes this file owns, and the signature each was built
 * from. Null means "the next render is a full one", which is also what any
 * failed integrity check falls back to.
 */
let cache = null;

/**
 * Drop the cache, forcing the next `renderBoard` to be a full rebuild.
 *
 * The seam exists for two callers: the identity test, which needs to produce a
 * from-scratch board to compare against, and anyone who replaces the board's
 * DOM behind this file's back. It is never needed for a state change — that is
 * what the signatures are for.
 */
export function invalidateBoardCache() { cache = null; }

/**
 * Every string this file can put in the DOM that does NOT come from the model.
 *
 * `ft()` resolves through `i18n` first and falls back to `FAMILY_COPY` only
 * while a key is missing, so the copy can change WITHOUT the language changing
 * — the day the i18n owner lands the family keys, mid-session. Comparing the
 * resolved strings rather than `getLang()` alone is what makes that safe.
 *
 * HONEST NOTE, because the rule here is that a claim with no test that dies is
 * recorded as what it actually is. Reducing this to `getLang()` alone SURVIVES
 * every row in `e1-incremental.dom.js` (mutant M4). It has to: `i18n.js` keeps
 * one frozen table per language and exposes no way to change one mid-session,
 * so this build cannot produce the state the breadth exists for. It is kept
 * because it costs eleven table lookups per render and because the FAMILY_COPY
 * fallback above is explicitly written to go quiet the day i18n lands those
 * keys — but it is UNPROVEN breadth, not a tested guarantee, and the half that
 * is tested is the language.
 */
function copyEpoch() {
  return [
    getLang(), t('continues'), t('scratchpad'), t('more'), t('lanesFull'),
    t('untitledBar'), ft('belegt'), ft('overflowNew'), ft('belegtOwnerTip'),
    ft('geteiltOwnerTip'), ft('expPending'),
  ].join(SEP);
}

// ── signatures ───────────────────────────────────────────────────────────────
//
// One per slot, over exactly the model fields that slot's builder reads. Read
// each of these next to its builder; they are a pair, and a field added to one
// without the other is the only way this design can break.

/** `renderNote` reads: id, colour, the five flags, the badge inputs, the text. */
const noteSig = (n) => n.note.id + SEP + n.color + SEP
  + (n.foreign ? 'F' : '') + (n.redacted ? 'R' : '') + (n.canEdit ? 'E' : '')
  + (n.isNew ? 'N' : '') + (n.note.repeatsYearly ? 'Y' : '') + SEP
  + (n.initial ?? '') + SEP
  + (n.exposure ? n.exposure.level + (n.exposure.pending ? '~' : '') : '') + SEP
  + (typeof n.note.text === 'string' ? n.note.text : '');

/** `applyDayChrome`: classes, `data-row`, `data-date`, the hover tips. */
const chromeSig = (d, claimed) => (d.empty
  ? 'E' + d.row
  : d.row + SEP + (claimed ? 'C' : '') + (d.weekend ? 'W' : '') + (d.ferien ? 'F' : '')
    + (d.isToday ? 'T' : '') + (d.holiday ? 'H' : '') + (d.holidayDemoted ? 'D' : '') + SEP
    + d.date + SEP + (d.ferienName || '') + SEP
    + (d.holidayDemoted && d.holiday ? d.holiday.name : ''));

/** `.d-num`, `.d-wd`, and whether the demoted-holiday dot stands before the body. */
const numSig = (d) => d.n + SEP + d.wd + SEP + (d.holidayDemoted ? 'D' : '');

/** `buildBody`: the holiday line, then every drawn note. */
function bodySig(d) {
  let s = d.date + SEP
    + (d.holidayShown && d.holiday
      ? d.holiday.short + SEP + (d.holiday.own ? 'O' : '') + SEP + d.holiday.name
      : '');
  for (const n of d.notes) s += SEP + noteSig(n);
  return s;
}

/** `applyMore`: the digit, the „neu" tell, and the two branches of the hover. */
const moreSig = (d) => (d.overflow > 0
  ? d.overflow + SEP + d.overflowNew + SEP + d.laneOverflow + SEP + d.date
  : '');

/** The column's own chrome: the `.col` attributes and the sticky head. */
const headSig = (col) => col.key + SEP + col.index + SEP + (col.isTodayMonth ? 'T' : '')
  + SEP + col.label + SEP + col.fullLabel;

/** The scratchpad (F10). */
const padSig = (col) => col.key + SEP + col.fullLabel + SEP + col.pad;

// ── the entry point ──────────────────────────────────────────────────────────

/**
 * Classes other files write onto board nodes between renders. A board built
 * from scratch carries none of them; a KEPT node must not either, or the two
 * paths are not the same board. `main.js:redraw()` re-applies every one of them
 * immediately after this call — `applySelection()` and `refreshFind()` — so
 * nothing the user can see flickers, and the four are removed here in ONE sweep
 * rather than per kept node.
 */
const SCRUB = ['hit', 'current', 'selected', 'dragging'];
function scrubMarks(root) {
  // `getElementsByClassName`, not `querySelectorAll`: the collection is LIVE and
  // the engine keeps it per class name, so on the overwhelmingly common render —
  // no marks on the board at all — this is four cached length reads rather than
  // a walk over 4 195 elements. Removing the class shrinks the collection under
  // the loop, which is why it counts down rather than up.
  for (const cls of SCRUB) {
    const live = root.getElementsByClassName(cls);
    for (let i = live.length - 1; i >= 0; i--) live[i].classList.remove(cls);
  }
}

export function renderBoard(root) {
  const state = store.state;
  model = buildBoard(state);
  const epoch = copyEpoch();

  // Density lives on :root only. Every position below is expressed in calc()
  // against these variables, never in resolved pixels — that is what lets the
  // print stylesheet re-metric the identical DOM for A4/A3 (F12) by overriding
  // them on <body>, which sits between :root and the board.
  //
  // The guard is not cosmetic. A custom property on the document element is
  // inherited by every box on the board, so WRITING one — even the value that
  // is already there — is a whole-document style invalidation, and this render
  // exists to avoid exactly that class of work.
  setVar('--row-h', `${model.rowH}px`);
  setVar('--col-w', `${model.colW}px`);

  if (canPatch(root, epoch)) {
    try {
      scrubMarks(root);
      for (let i = 0; i < model.cols.length; i++) patchColumn(cache.cols[i], model.cols[i]);
      return model;
    } catch {
      // THE LAST RESORT, and it is a real one.
      //
      // `canPatch` checks every way the DOM can move out from under the cache
      // that this app actually produces — a different root, a changed language,
      // a node inserted into or removed from a column. It cannot check the one
      // it does not produce: some future caller REPLACING a node inside a row
      // while leaving the child count alone. That would reach a `replaceChild`
      // on a node whose parent has moved, and DOM throws for it.
      //
      // Falling through to the full rebuild makes that outcome slow instead of
      // broken, which is the right trade for a path that must never be able to
      // put a wrong board on screen. Nothing is logged: the board's content is
      // inside these nodes, and `tests/tier1/*` police what this process is
      // allowed to emit. A half-patched board does not survive either — the
      // rebuild below clears the root first.
      cache = null;
    }
  }

  // ── the full path, which is also the first one ─────────────────────────────
  const scrollLeft = root.parentElement ? root.parentElement.scrollLeft : 0;
  // P3, the other path. `patchPad` leaves unsent typing alone; this one is about
  // to DELETE the box it is in, so the sentence and the caret are carried over
  // and put back. The rebuild a person can actually reach while typing is a
  // language switch (13.7), which bumps `copyEpoch` and lands here.
  const ink = liveInk(root);
  root.textContent = '';
  const frag = document.createDocumentFragment();
  const recs = [];
  for (const col of model.cols) {
    const rec = renderColumn(col);
    recs.push(rec);
    frag.appendChild(rec.el);
  }
  root.appendChild(frag);
  cache = { root, epoch, cols: recs };

  restoreInk(root, ink);
  if (root.parentElement) root.parentElement.scrollLeft = scrollLeft;
  return model;
}

/**
 * The UNSENT typing the caret is in, if there is any: its month, the text, and
 * where in it she is. Read BEFORE the root is emptied.
 *
 * It answers `null` unless `unsent()` is true of that box in the cache this render
 * is about to replace — the same question `patchPad` asks, so the two paths keep
 * the same thing and drop the same thing. With no cache to ask (the first render of
 * a process, or a test that dropped it) there is nothing to preserve and nothing is
 * claimed: the model wins, which is what v1 did on every render.
 */
function liveInk(root) {
  const a = root.ownerDocument.activeElement;
  if (!a || a.tagName !== 'TEXTAREA' || !root.contains(a)) return null;
  if (!a.parentElement || !a.parentElement.classList.contains('pad')) return null;
  if (!cache || cache.root !== root) return null;
  const rec = cache.cols.find((c) => c.padTa === a);
  if (!rec || !unsent(rec)) return null;
  return { month: a.dataset.month, value: a.value, start: a.selectionStart, end: a.selectionEnd };
}

/**
 * Put it back on the rebuilt board — same month, same text, same caret.
 *
 * `preventScroll` because focusing scrolls the box into view, and the scroll
 * position this render restores one line later is the one the user left.
 *
 * The month can be off the board by now — the window rolled past it while she was
 * typing in it (8.2's midnight, or a settings change). There is then nothing to
 * restore to, nothing is focused, and the sentence goes with the box. That is
 * v1's outcome for every render and it is not made worse here; it is stated
 * rather than hidden, because it is the one case this function cannot answer.
 */
function restoreInk(root, ink) {
  if (!ink || !ink.month) return;
  const ta = root.querySelector(`.pad > textarea[data-month="${cssQuote(ink.month)}"]`);
  if (!ta) return;
  if (ta.value !== ink.value) ta.value = ink.value;
  padEmptyClass(ta.parentElement, ink.value);
  ta.focus({ preventScroll: true });
  try { ta.setSelectionRange(ink.start, ink.end); } catch { /* not a text range; the value is what matters */ }
}

/** `CSS.escape` is not in every engine this file has to run in; a month key is `YYYY-MM`. */
const cssQuote = (s) => String(s).replace(/["\\]/g, '\\$&');

const setVar = (name, value) => {
  if (document.documentElement.style.getPropertyValue(name) !== value) {
    document.documentElement.style.setProperty(name, value);
  }
};

/**
 * Is the cached board still the board that is on screen?
 *
 * Everything checked here is a way the DOM can have moved out from under the
 * cache — a different root, a language change, a column count change, a node
 * some other file inserted into or removed from a column. Any of them falls
 * back to the full rebuild, which is always correct and never wrong, only slow.
 */
function canPatch(root, epoch) {
  if (!cache || cache.root !== root || cache.epoch !== epoch) return false;
  if (cache.cols.length !== model.cols.length) return false;
  if (root.childElementCount !== cache.cols.length) return false;
  for (let i = 0; i < cache.cols.length; i++) {
    const rec = cache.cols[i];
    if (rec.days.length !== model.cols[i].days.length) return false;
    if (rec.el.parentElement !== root) return false;
    if (rec.el.childElementCount !== 3) return false;            // head · rows · pad
    if (rec.rows.childElementCount !== rec.days.length + tailLength(rec.tail, rec.horizon)) return false;
  }
  return true;
}

// ── columns ──────────────────────────────────────────────────────────────────

/**
 * WHICH ROWS HAVE A BAR LABEL STANDING IN THEIR GUTTER (2.4 · 3.7)
 *
 * Two things are painted to the right of a day's text: the „+n" badge and, on
 * one row per month segment, a bar label. Both used to be opaque overlays over
 * the TEXT COLUMN; both now live in the lane gutter instead (see `app.css`
 * `.d-more` and `.bar-label.on-ink`). 27 px does not hold two of them side by
 * side, so on the rows where they meet the badge steps into the line and takes
 * width — and this scan is what tells the CSS which rows those are.
 *
 * `inkOf` is `layout.js`'s own label-scan predicate, to the term: a label that
 * landed on a row scoring 0 landed on empty space, which is what 3.7 promised,
 * and it keeps all 66 px. Everything is read from the MODEL — no layout is
 * forced and nothing here is read back from the DOM.
 */
function claimedRows(col) {
  const inkOf = (d) => (d.holidayShown ? 1 : 0) + d.notes.length + (d.overflow > 0 ? 1 : 0);
  const dayAtRow = new Map();
  for (const d of col.days) if (!d.empty) dayAtRow.set(d.row, d);
  const claimed = new Set();
  for (const seg of col.segs) {
    const host = dayAtRow.get(seg.labelRow);
    if (host && inkOf(host) > 0) claimed.add(seg.labelRow);
  }
  return claimed;
}

// ── the segment tail ─────────────────────────────────────────────────────────
//
// Everything in a column after its 31 day rows: one group of nodes per bar
// segment — the stripe, the label chip and up to one horizon cue — and then the
// column's own „continues" cue.
//
// IT IS THE MOST EXPENSIVE PART OF THE BOARD PER NODE, by a distance. Measured
// in WebKit on the 8 × 2 fixture: replacing all 275 tail nodes costs 33 ms —
// more than every day row on the board put together — because each one carries
// its position as inline `calc()` against custom properties (which is what lets
// `print.css` re-metric the identical DOM for A4/A3, F12), a background, and in
// the label's case a custom property of its own. Rebuilding a column's tail
// because ONE bar in it moved was the biggest single cost left in a member
// toggle once the day rows were slotted, and it is why this is keyed.
//
// The key is the BAR ID, unique within a column by construction: `layout.js`
// emits at most one segment per bar per month, and the per-column rescue moves
// a segment between lanes rather than adding a second one.
//
// THE STRIPE AND THE LABEL ARE KEYED SEPARATELY, and that is not fussiness.
// `layout.js`'s three-pass label scan moves a label to a different ROW whenever
// the ink under it changes — which a member toggle does on most rows — while
// the stripe it belongs to has not moved at all. Keyed as one unit, 25 of 198
// otherwise-untouched stripes were being rebuilt to move their label; §E1b in
// `e8-density-perf.dom.js` is the row that found it and the row that would find
// it again.
//
// ORDER IS LOAD-BEARING and is reproduced exactly. `find.js` walks
// `.note, .bar-label, .pad textarea` in DOCUMENT order to build its hit list and
// its „3/17" counter, and `layout.js` sorts segments by lane and then by top
// row, so a lane change genuinely reorders them. The placement loop below is a
// two-pointer reconcile: a node already standing where it belongs is not
// touched, and only the ones that actually moved are moved.

/** The hover string, shared by the stripe and its label — see `segTitle`. */
const titleSig = (seg) => (seg.redacted ? 'R' : '') + SEP + (seg.initial ?? '') + SEP
  + (seg.bar.label ?? '') + SEP + seg.bar.startDate + SEP + seg.bar.endDate + SEP
  + (seg.exposure ? seg.exposure.level + (seg.exposure.pending ? '~' : '') : '');

/** `buildStripe`: the coloured range and its two horizon cues. */
const stripeSig = (seg) => seg.lane + SEP + seg.topRow + SEP + seg.rows + SEP + seg.color + SEP
  + (seg.foreign ? 'F' : '') + (seg.redacted ? 'R' : '') + (seg.canEdit ? 'E' : '')
  + (seg.contTop ? 't' : '') + (seg.contBot ? 'b' : '')
  + (seg.beyondStart ? 'S' : '') + (seg.beyondEnd ? 'B' : '') + SEP + titleSig(seg);

/**
 * `buildLabel`: the chip, its row, and whether it had to retreat into the gutter.
 *
 * The LANE is in here only on the branch that reads it. A retreated label is
 * anchored at `right: 2px` and does not know its lane at all, so a lane change
 * under a retreated label changes nothing it draws — and on a family board,
 * where 3.7's scan retreats nearly every label, spending a rebuild on that was
 * 12 of the 198 otherwise-untouched tail nodes a member toggle replaced.
 */
const labelSig = (seg, onInk) => (onInk ? 'I' : 'L' + seg.lane) + SEP + seg.labelRow + SEP + seg.color + SEP
  + (seg.foreign ? 'F' : '') + (seg.redacted ? 'R' : '') + (seg.canEdit ? 'E' : '')
  + (seg.contTop ? 't' : '') + (seg.isNew ? 'N' : '') + SEP
  + (seg.initial ?? '') + SEP + titleSig(seg);

/**
 * One bar's nodes in one column, in DOM order: stripe, label, then the cues.
 * `nodes` is the flattened list the placement loop and the integrity check use;
 * `relink` is what keeps it in step after a half-rebuild.
 */
function relink(rec) {
  rec.nodes = rec.cues.length ? [rec.bar, rec.label, ...rec.cues] : [rec.bar, rec.label];
  return rec;
}

function segRecord(seg, onInk) {
  const rec = { key: seg.bar.id, sSt: stripeSig(seg), sLb: labelSig(seg, onInk), cues: [] };
  buildStripe(rec, seg);
  rec.label = buildLabel(seg, onInk);
  return relink(rec);
}

function buildTail(col, claimed, into) {
  const recs = [];
  for (const seg of col.segs) {
    const rec = segRecord(seg, claimed.has(seg.labelRow));
    for (const n of rec.nodes) into.appendChild(n);
    recs.push(rec);
  }
  return recs;
}

/** Every node the tail owns, in DOM order — what the integrity check counts. */
const tailLength = (recs, horizon) => {
  let n = horizon ? 1 : 0;
  for (const r of recs) n += r.nodes.length;
  return n;
};

function patchTail(rec, col, claimed) {
  const old = rec.tail;
  const byKey = new Map();
  for (const r of old) byKey.set(r.key, r);

  const next = [];
  const keep = new Set();
  for (const seg of col.segs) {
    const onInk = claimed.has(seg.labelRow);
    const prev = byKey.get(seg.bar.id);
    if (!prev || keep.has(seg.bar.id)) { next.push(segRecord(seg, onInk)); continue; }
    keep.add(prev.key);
    const sSt = stripeSig(seg);
    if (sSt !== prev.sSt) {
      prev.bar.remove();
      for (const c of prev.cues) c.remove();
      prev.cues = [];
      buildStripe(prev, seg);
      prev.sSt = sSt;
      relink(prev);
    }
    const sLb = labelSig(seg, onInk);
    if (sLb !== prev.sLb) {
      prev.label.remove();
      prev.label = buildLabel(seg, onInk);
      prev.sLb = sLb;
      relink(prev);
    }
    next.push(prev);
  }

  // Whatever the new list did not claim leaves the DOM first, so the placement
  // pointer below only ever walks over nodes that are staying.
  for (const r of old) {
    if (keep.has(r.key)) continue;
    for (const n of r.nodes) n.remove();
  }

  // Two-pointer placement. `ptr` is where the next tail node belongs; a node
  // already standing there is left exactly where it is, which is the whole
  // point — `insertBefore` on an attached node is a MOVE, and a moved
  // out-of-flow box costs about what a new one costs.
  let ptr = rec.days[rec.days.length - 1].el.nextSibling;
  for (const r of next) {
    for (const n of r.nodes) {
      if (ptr === n) ptr = n.nextSibling;
      else rec.rows.insertBefore(n, ptr);
    }
  }
  rec.tail = next;

  // 3.6's column footer, always last in the column.
  if (col.horizon && !rec.horizon) {
    rec.horizon = el('div', 'horizon-cue', t('continues'));
  } else if (!col.horizon && rec.horizon) {
    rec.horizon.remove();
    rec.horizon = null;
  }
  if (rec.horizon) {
    if (ptr === rec.horizon) ptr = rec.horizon.nextSibling;
    else rec.rows.insertBefore(rec.horizon, ptr);
  }
}

function renderColumn(col) {
  const c = el('div', 'col');
  c.dataset.month = col.key;
  c.dataset.index = String(col.index);
  if (col.isTodayMonth) c.classList.add('is-today-month');

  const head = buildHead(col);
  c.appendChild(head);

  const rows = el('div', 'rows');
  rows.style.height = 'calc(var(--row-h) * 31)';
  rows.dataset.month = col.key;

  const claimed = claimedRows(col);
  const days = [];
  for (const d of col.days) {
    const rec = renderDay(d, claimed.has(d.row));
    days.push(rec);
    rows.appendChild(rec.el);
  }
  const tail = buildTail(col, claimed, rows);
  const horizon = col.horizon ? el('div', 'horizon-cue', t('continues')) : null;
  if (horizon) rows.appendChild(horizon);

  c.appendChild(rows);
  const pad = renderPad(col);
  c.appendChild(pad.el);

  return {
    el: c, head, rows, days, tail, horizon,
    pad: pad.el, padTa: pad.ta,
    // `renderPad` built the box FROM the model, so this is where they agree. See `unsent`.
    padShown: col.pad,
    sHead: headSig(col), sPad: padSig(col),
  };
}

function buildHead(col) {
  const head = el('div', 'col-head');
  head.appendChild(el('span', null, col.label));
  head.title = col.fullLabel;
  return head;
}

function patchColumn(rec, col) {
  const claimed = claimedRows(col);

  const sh = headSig(col);
  if (sh !== rec.sHead) {
    rec.el.className = col.isTodayMonth ? 'col is-today-month' : 'col';
    rec.el.dataset.month = col.key;
    rec.el.dataset.index = String(col.index);
    rec.rows.dataset.month = col.key;
    const head = buildHead(col);
    rec.el.replaceChild(head, rec.head);
    rec.head = head;
    rec.sHead = sh;
  }

  const days = col.days;
  for (let i = 0; i < days.length; i++) patchDay(rec.days[i], days[i], claimed.has(days[i].row));

  patchTail(rec, col, claimed);

  patchPad(rec, col);
}

/**
 * ═══ P3 — A RENDER NEVER WRITES INTO THE TEXTAREA THAT HOLDS THE CARET ═══════
 *
 * `interact.js` commits a scratchpad to the store on a 600 ms pause or on blur
 * (rule U9), so for up to 600 ms at a time the live element holds a sentence the
 * model has not got. v1 could discard it safely: every redraw came from a
 * gesture of the user's own, and every one of those moves focus out of the
 * textarea first, so `focusout` → `onPadBlur` → `commitPad` had already run. v2
 * added a caller v1 did not have — `store.emit('remote')` when a peer's ops fold
 * in — which needs no gesture and no focus change. **The user's own ink wins**,
 * and there is no reading of that principle under which another person's
 * arriving op outranks the sentence she is typing. Nothing is recoverable
 * afterwards either: the text was never committed, so ⌘Z has nothing to restore.
 *
 * So the rule is the one line below, and `unsent` is what makes it narrow: this
 * file does not write over keystrokes the model has not been told about.
 * Everything else about the pad is still reconciled, the model still wins the
 * moment the caret leaves — which is exactly the state `e1-incremental.dom.js`
 * §I4 pins, and it stays pinned — and it still wins in a box she has typed
 * nothing into. The wider rule (the caret alone) was measured and rejected: it
 * makes an untouched box hold a change out, and it turns `retrofit-probe3.dom.js`
 * R3 red. `tests/tier2/e13-glass.dom.js` §G6 is the row that keeps it narrow.
 *
 * THE PAD ELEMENT IS NEVER REPLACED, which is the other half of the same
 * principle. A page turn or a committed keystroke moves `padSig`, and rebuilding
 * the block for it would rip the textarea out from under the caret while she is
 * mid-word — the more reachable half of the defect, because it needs only one
 * 600 ms pause in a long paragraph. Every input `renderPad` reads is patched in
 * place instead: the two `data-month`s, the `aria-label`, the value and the
 * `empty` class. The label text is language-only and a language change bumps
 * `copyEpoch`, which is a full rebuild, so it can never be stale here.
 *
 * Patched in place, the attributes keep the positions `renderPad` gave them, so
 * the serialisation is byte-identical to the from-scratch one. The one thing that
 * can differ is downstream of a value `outerHTML` does not carry at all: a box
 * holding unsent typing is not `empty` and a from-scratch box built from the same
 * model is. `e13-glass.dom.js` §G5 asserts that difference and that there is no
 * other; §I4 never meets it, because a box with no caret in it has no unsent ink.
 */
function patchPad(rec, col) {
  const sp = padSig(col);
  if (sp !== rec.sPad) {
    if (rec.pad.dataset.month !== col.key) rec.pad.dataset.month = col.key;
    if (rec.padTa.dataset.month !== col.key) rec.padTa.dataset.month = col.key;
    const label = `${t('scratchpad')} ${col.fullLabel}`;
    if (rec.padTa.getAttribute('aria-label') !== label) rec.padTa.setAttribute('aria-label', label);
    rec.sPad = sp;
  }
  // The `!==` guard is what keeps the caret still when there is nothing to reset
  // — assigning `value` moves it to the end even when the string is the same.
  if (!unsent(rec) && rec.padTa.value !== col.pad) rec.padTa.value = col.pad;
  // 10.1's „empty" is about what is IN the box, which is why `interact.js`
  // toggles it from the live value on every keystroke. Her first character must
  // not leave a pad that still calls itself empty.
  padEmptyClass(rec.pad, rec.padTa.value);
  // THE AGREEMENT, recorded whenever there is one. `padShown` is the last value on
  // which this box and the model agreed, and `unsent` is the difference between
  // "she has typed since then" and "this box merely lags a change made elsewhere".
  // Only the first is ink; the second is a stale box, and a stale box has no claim.
  if (rec.padTa.value === col.pad) rec.padShown = col.pad;
}

/**
 * Does this box hold keystrokes the model has not been told about?
 *
 * Both halves are load-bearing. THE CARET, because a box she is not in has already
 * committed — `interact.js:onPadBlur` fires on the way out — so anything it holds
 * that the model does not is a leftover, not a sentence. AND THE LAST AGREEMENT,
 * because "the box differs from the model" is also true when the model moved under
 * a box nobody has touched, and reaching in there would then be the board
 * preserving something the user never typed.
 */
const unsent = (rec) =>
  rec.padTa.ownerDocument.activeElement === rec.padTa && rec.padTa.value !== rec.padShown;

/** The one class `renderPad` and `patchPad` must agree on, in one place. */
const padEmptyClass = (pad, text) => pad.classList.toggle('empty', !text.trim());

// ── day rows ─────────────────────────────────────────────────────────────────

/** The row's class list, in the order the full path produced it. */
function dayClass(d, claimed) {
  if (d.empty) return 'day void';
  let c = 'day';
  // 3.7 — a bar label landed on this row, this row already carries ink, and the
  // label has therefore retreated into the lane gutter rather than paint over
  // the sentence. The class is how the „+n" badge finds out that the gutter is
  // taken; `app.css` `.day.claimed .d-more` owns what it does about it.
  if (claimed) c += ' claimed';
  if (d.weekend) c += ' we';
  if (d.ferien) c += ' fer';
  if (d.isToday) c += ' today';
  if (d.holiday) c += ' hol';
  return c;
}

function applyDayChrome(row, d, claimed) {
  row.className = dayClass(d, claimed);
  row.dataset.row = String(d.row);
  if (d.empty) return;
  row.dataset.date = d.date;
  // 7.2 — the shading must never be cryptic; the period name is one hover away.
  const tips = [];
  if (d.ferienName) tips.push(d.ferienName);
  if (d.holidayDemoted && d.holiday) tips.push(d.holiday.name);
  if (tips.length) row.title = tips.join(' · ');
  else row.removeAttribute('title');
}

/**
 * Challenge 2's holiday line — kept only while the user has not claimed the row.
 * `layout.js` has already decided; this is the DOM half.
 */
const holSig = (d) => (d.holidayShown && d.holiday
  ? d.holiday.short + SEP + (d.holiday.own ? 'O' : '') + SEP + d.holiday.name
  : '');

function buildHol(d) {
  const h = el('div', 'd-hol', d.holiday.short);
  if (!d.holiday.own) h.classList.add('foreign');
  h.title = d.holiday.name;
  return h;
}

/**
 * The `.d-body` block: the holiday line, then the notes the capacity rule drew.
 * Fills in the record's per-note bookkeeping as it goes, so a later render can
 * keep the notes that did not move.
 */
function buildBody(d, rec) {
  const body = el('div', 'd-body');
  rec.holSig = holSig(d);
  rec.holEl = null;
  if (rec.holSig) { rec.holEl = buildHol(d); body.appendChild(rec.holEl); }
  rec.notes = [];
  for (const n of d.notes) {
    const node = renderNote(n, d);
    rec.notes.push({ key: n.note.id, sig: noteSig(n), el: node });
    body.appendChild(node);
  }
  return body;
}

/**
 * The notes inside one day row, keyed by entry id.
 *
 * WHY THIS IS KEYED AND THE BODY IS NOT REPLACED WHOLE. A member toggle changes
 * 124 bodies on the 8 × 2 fixture, and in 123 of them ONE of the two drawn notes
 * is the same entry it was before — mine, kept by `orderForCapacity`'s own-first
 * rule, with a peer's entry taking or vacating the second slot. A `.note` is
 * `white-space: nowrap; text-overflow: ellipsis`, so laying one out means
 * shaping its text and measuring the ellipsis; a note that did not change should
 * not pay for that again. Measured in WebKit: replacing 124 whole bodies costs
 * 6.5 ms, replacing one note inside each of them 3.1 ms.
 *
 * The key is the entry id, which is unique within a day — `noteOccurrencesInRange`
 * expands a yearly repeat once per year and a date belongs to one year, so an
 * entry cannot occur twice on the same row. A duplicate would degrade to a fresh
 * build rather than reuse one element twice, which is safe, not merely tolerable.
 */
function patchBody(rec, d) {
  const hs = holSig(d);
  if (hs !== rec.holSig) {
    if (!hs) { rec.holEl.remove(); rec.holEl = null; }
    else {
      const h = buildHol(d);
      if (rec.holEl) rec.body.replaceChild(h, rec.holEl);
      else rec.body.insertBefore(h, rec.body.firstChild);
      rec.holEl = h;
    }
    rec.holSig = hs;
  }

  const old = rec.notes;
  const byKey = new Map();
  for (const r of old) byKey.set(r.key, r);
  const next = [];
  const keep = new Set();
  for (const n of d.notes) {
    const key = n.note.id;
    const sig = noteSig(n);
    const prev = byKey.get(key);
    if (prev && prev.sig === sig && !keep.has(key)) {
      // ═══ THE ONE THING `renderNote` WRITES THAT IS NOT A NOTE FIELD ═══════
      //
      // `node.dataset.date = d.date` — the DAY's date, not the entry's. It is
      // in `bodySig`'s prefix, so this function is reached whenever it can have
      // moved, but it is deliberately NOT in `noteSig`: a row whose date
      // changed keeps every note that did not otherwise change, which is the
      // whole point of keying this list. What it must not keep is last year's
      // attribute.
      //
      // It moves under a kept node exactly once: `entities.js:noteOccurrences`
      // pushes THE SAME note object once per year, so a yearly repeat (9.5)
      // carries one `note.id` across every year, and the „‹ ›" year pager
      // (`main.js:page`) changes a column's YEAR while keeping its month and
      // its rows. A one-off entry cannot do it — it belongs to one date and
      // leaves the row with it.
      //
      // `interact.js:onPointerDown` reads this attribute as the drag ORIGIN
      // while `dateUnderPointer` reads the row, so a stale one turns picking an
      // entry up and putting it back down into a move: an op in the log, a step
      // on the undo stack, and on a shared entry a `pub.date` published to the
      // whole circle for a day on which nothing happened. Principle 10 — the
      // board is not a messenger — and the guarded attribute write is the same
      // one `applyMore` makes for the same attribute two functions down.
      if (prev.el.dataset.date !== d.date) prev.el.dataset.date = d.date;
      keep.add(key); next.push(prev); continue;
    }
    next.push({ key, sig, el: renderNote(n, d) });
  }
  for (const r of old) if (!keep.has(r.key)) r.el.remove();

  // The same two-pointer placement `patchTail` uses, for the same reason: a
  // note already standing where it belongs must not be moved.
  let ptr = rec.holEl ? rec.holEl.nextSibling : rec.body.firstChild;
  for (const r of next) {
    if (ptr === r.el) ptr = r.el.nextSibling;
    else rec.body.insertBefore(r.el, ptr);
  }
  rec.notes = next;
}

/**
 * The „+n" badge's content, applied to a fresh node or to the one already
 * standing in that row's gutter.
 *
 * ═══ 17.5 — THE BADGE SAYS WHETHER IT IS HIDING A CHANGE ═════════════════════
 * „Jede Änderung ist bemerkbar." A peer change the row had no line for gets no
 * „neu" dot of its own, because there is no note element to hang one on: the
 * „+n" badge is the only mark left on that row. Without this class the badge
 * looks IDENTICAL whether it hides a change or four unchanged entries, and
 * `e8-density-crowding.dom.js` §B5 measured 32 of 219 peer changes arriving
 * that way on the 8-member fixture — noticeable nowhere.
 *
 * `layout.js` publishes the count as `day.overflowNew`, and it inherits §7.2's
 * two suppressions for free: it counts `foreign && isNew`, and
 * `materialize.js:isNewOf` is blind to a downgrade and has nothing to count for
 * a deletion. So a DOWNGRADE still leaves no marker and a DELETION still leaves
 * no marker — `family-legend.dom.js`'s tripwire row holds unchanged.
 *
 * The tell is a class and nothing else: `app.css` `.d-more.has-new` paints it
 * INSIDE the badge's existing 17 px box, so it costs the sentence zero pixels
 * on every board, screen and paper alike.
 */
function applyMore(more, d) {
  // Guarded, and through the text node, for the same reason `.d-num` is: the
  // overwhelmingly common badge change is the DIGIT, and rewriting the class,
  // the dataset and the whole child list to change it would invalidate three
  // more things than it needs to.
  const cls = d.overflowNew > 0 ? 'd-more has-new' : 'd-more';
  if (more.className !== cls) more.className = cls;
  const text = `+${d.overflow}`;
  if (more.firstChild) { if (more.firstChild.data !== text) more.firstChild.data = text; }
  else more.textContent = text;
  if (more.dataset.date !== d.date) more.dataset.date = d.date;
  const base =
    d.laneOverflow > 0 && d.overflow === d.laneOverflow
      ? `${d.laneOverflow} ${t('lanesFull')}`
      : `${d.overflow} ${t('more')}`;
  // The hover says HOW MANY are changes, because the mark itself can only say
  // „at least one" — and a number nobody can read is not an answer (2.5).
  const title = d.overflowNew > 0 ? `${base} · ${d.overflowNew} ${ft('overflowNew')}` : base;
  if (more.title !== title) more.title = title;
}

function buildMore(d) {
  if (!(d.overflow > 0)) return null;
  const more = document.createElement('div');
  applyMore(more, d);
  return more;
}

/** Builds one day row and the record that lets the next render patch it. */
function renderDay(d, claimed) {
  const row = document.createElement('div');
  applyDayChrome(row, d, claimed);
  const rec = {
    el: row, empty: !!d.empty, holdot: null, body: null, more: null,
    holEl: null, holSig: '', notes: [],
    sChrome: chromeSig(d, claimed), sNum: '', sBody: '', sMore: '',
  };
  if (d.empty) return rec;

  row.appendChild(el('span', 'd-num', d.n));
  row.appendChild(el('span', 'd-wd', d.wd));
  if (d.holidayDemoted) {
    rec.holdot = el('span', 'd-holdot');
    row.appendChild(rec.holdot);
  }
  rec.body = buildBody(d, rec);
  row.appendChild(rec.body);
  rec.more = buildMore(d);
  if (rec.more) row.appendChild(rec.more);

  rec.sNum = numSig(d);
  rec.sBody = bodySig(d);
  rec.sMore = moreSig(d);
  return rec;
}

/**
 * The four slots, each rebuilt only if its own signature moved.
 *
 * A row that flips between void and real changes structure rather than content
 * and is replaced whole — at most a handful of rows, on the month the window
 * rolls past a shorter one.
 */
function patchDay(rec, d, claimed) {
  if (rec.empty !== !!d.empty) {
    const fresh = renderDay(d, claimed);
    rec.el.replaceWith(fresh.el);
    Object.assign(rec, fresh);
    return;
  }

  const sc = chromeSig(d, claimed);
  if (sc !== rec.sChrome) { applyDayChrome(rec.el, d, claimed); rec.sChrome = sc; }
  if (rec.empty) return;

  const sn = numSig(d);
  if (sn !== rec.sNum) {
    // `.data` on the text node that is already there, never `textContent`:
    // `textContent` tears the node down and builds another for the same two
    // characters, and this runs on every row when the window rolls.
    const kids = rec.el.children;
    if (kids[0].firstChild.data !== d.n) kids[0].firstChild.data = d.n;
    if (kids[1].firstChild.data !== d.wd) kids[1].firstChild.data = d.wd;
    if (d.holidayDemoted && !rec.holdot) {
      rec.holdot = el('span', 'd-holdot');
      rec.el.insertBefore(rec.holdot, rec.body);
    } else if (!d.holidayDemoted && rec.holdot) {
      rec.holdot.remove();
      rec.holdot = null;
    }
    rec.sNum = sn;
  }

  const sb = bodySig(d);
  if (sb !== rec.sBody) {
    patchBody(rec, d);
    rec.sBody = sb;
  }

  const sm = moreSig(d);
  if (sm !== rec.sMore) {
    if (!sm) { rec.more.remove(); rec.more = null; }
    else if (rec.more) applyMore(rec.more, d);
    else { rec.more = buildMore(d); rec.el.appendChild(rec.more); }
    rec.sMore = sm;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The badge family (deliverable 17) — ONE contested slot, designed together
//
// Everything below lives in the same prefix slot as the ↻ marker, BEFORE the
// text node, for the reason 9.2 already gave: `.note` is `text-overflow:
// ellipsis`, so anything after the text is the first thing truncation eats.
//
// The slot is smaller than ADR 004 §6 feared, because two of the five markers
// can never co-occur. The exposure badge is MY disclosure of MY entry; the
// initial chip and the „neu" dot only ever appear on SOMEONE ELSE'S. The real
// worst cases are therefore `↻ + badge` on my board (17 px, measured) and
// `neu + chip + ↻` for a peer's repeating entry (23 px) — never all five.
// `layout.js:PREFIX_COST_PX` holds the numbers; the DOM test measures them.
//
// Fixed order, so a crowded day stays scannable down a column:
//   [neu dot] [initial chip] [exposure badge] [↻] text
//    who-is-new  whose         my-exposure     what-kind  what
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 16.6 — the exposure badge. `null` for Privat: the ABSENCE of a badge means
 * private, which is the default and the quiet state (Principle 8), and a glyph
 * for the quiet state would put ink on every row of a solo board.
 *
 * Level is coded by COVERAGE (half vs full) and pending by TEXTURE (hatched vs
 * solid), never both by fill — ADR 004 §6 asks for "distinct glyphs" AND for
 * "the same glyph, hollow" when pending, and a badge that signalled pending by
 * emptying itself would make a pending Belegt and a pending Geteilt identical.
 */
function exposureBadge(exposure) {
  if (!exposure) return null;
  const b = el('span', `exp ${exposure.level}${exposure.pending ? ' pending' : ''}`);
  b.setAttribute('aria-hidden', 'true');   // the state is in the note's title
  return b;
}

/**
 * 17.2 — whose is this, answered before what it is.
 * `color` is the member's tone for a chip on white; on a bar label the chip
 * inverts and the CSS owns both of its colours, so the caller passes nothing.
 */
function initialChip(initial, color) {
  const c = el('span', 'chip', initial);
  if (color) c.style.background = color;
  c.setAttribute('aria-hidden', 'true');
  return c;
}

/**
 * 17.5 — the quiet „neu" dot, in the board's only accent tone so it cannot be
 * confused with the 3 px demoted-holiday dot two elements to its left.
 * `layout.js` has already applied §7.2's two suppressions: a downgrade never
 * dots and a deletion never dots.
 */
const neuDot = () => {
  const n = el('span', 'neu-dot');
  n.setAttribute('aria-hidden', 'true');
  return n;
};

/**
 * The owner's hover text for a shared entry (ADR 002 §7.4, required strings).
 * It states what others can see in plain words rather than asking the user to
 * decode a 7 px badge, and it says "not synced yet" instead of implying a
 * privacy state that has not reached the server (ADR 004 §6).
 */
function exposureTitle(exposure) {
  if (!exposure) return '';
  const tip = ft(exposure.level === 'geteilt' ? 'geteiltOwnerTip' : 'belegtOwnerTip');
  return exposure.pending ? `${tip} (${ft('expPending')})` : tip;
}

function renderNote(n, d) {
  const node = el('div', 'note');
  node.dataset.noteId = n.note.id;
  node.dataset.date = d.date;
  node.style.color = n.color;
  if (n.foreign) node.dataset.foreign = '1';
  if (n.foreign) node.classList.add('foreign');
  if (n.redacted) node.classList.add('belegt');
  // 18.1 — a class, not only a model field, so `interact.js` and the CSS can ask
  // the one question `layout.js:canEditEntry` answers instead of each re-deriving it.
  if (!n.canEdit) node.classList.add('readonly');

  if (n.isNew) node.appendChild(neuDot());
  if (n.foreign) node.appendChild(initialChip(n.initial, n.color));
  const badge = exposureBadge(n.exposure);
  if (badge) node.appendChild(badge);
  if (n.note.repeatsYearly) {
    // 9.2 / design note — the marker goes *before* the text so truncation can
    // never eat it.
    node.appendChild(el('span', 'rep', '↻'));
  }

  // ═══ 16.7 — THE REDACTION SEAM ══════════════════════════════════════════════
  // Keyed on `redacted`, which `layout.js` derives from the LEVEL, and never on
  // the absence of a text. A `pub.text` that reaches a Belegt entry is a defect
  // three layers upstream (projection, seal, or the receiving fold's stage 3c);
  // painting whatever happens to be there would turn that defect into the leak
  // this whole epic exists to make impossible. A rendering bug may produce the
  // wrong pixels — it may not produce the wrong disclosure.
  const text = typeof n.note.text === 'string' ? n.note.text : '';
  if (n.redacted) {
    // The word is an ELEMENT, not a text node, for two reasons: it must not
    // inherit the member colour the way content does — a neutral word in a
    // person's ink would read as something they wrote — and a test that asserts
    // "this block contains nothing but the neutral word" needs a node to name.
    node.appendChild(el('span', 'redacted-word', ft('belegt')));
  } else {
    node.appendChild(document.createTextNode(text));
  }

  // 2.5 — full text on hover, and for a Belegt block the *only* thing there is
  // to say: who and what level. Never the text, and never a level history
  // („war geteilt" is forbidden by ADR 004 §7.1).
  node.title = n.redacted ? redactedTitle(n) : [text, exposureTitle(n.exposure)].filter(Boolean).join('\n');
  return node;
}

/**
 * A Belegt block's hover text: who, and the level. Never the text, and never a
 * level history — „war geteilt" is forbidden by ADR 004 §7.1, and there is
 * nothing in the model to build one from.
 *
 * The initial is the chip's only accessible equivalent, so it leads — EXCEPT
 * when it is the placeholder for a member record that has not arrived, where
 * „· · Belegt" would be a dot introducing itself. Then the level stands alone,
 * which is the whole of what is known.
 */
const redactedTitle = (n) =>
  (n.initial && n.initial !== UNKNOWN_MEMBER_INITIAL)
    ? `${n.initial} · ${ft('belegt')}`
    : ft('belegt');

/**
 * The hover string a segment's stripe and its label chip SHARE.
 *
 * 16.7 — the same rule as the note: the LABEL is what is withheld, the dates
 * are what is disclosed. `|| t('untitledBar')` is v1's own fallback and stays
 * exactly where it was, on the non-redacted branch only.
 */
const segLabelText = (seg) => (seg.redacted ? ft('belegt') : (seg.bar.label || t('untitledBar')));

function segTitle(seg) {
  const span = `${seg.bar.startDate} – ${seg.bar.endDate}`;
  return seg.redacted
    ? [redactedTitle(seg), span].join(' · ')
    : [`${segLabelText(seg)} · ${span}`, exposureTitle(seg.exposure)].filter(Boolean).join('\n');
}

/**
 * The stripe and its two horizon cues, into `rec.bar` and `rec.cues`.
 *
 * Split from the label because the two move for different reasons: a stripe
 * moves when its bar's lane or range moves, a label moves whenever the INK
 * under it changes — which a member toggle does on most rows of the board.
 * See the tail header above.
 */
function buildStripe(rec, seg) {
  const bar = el('div', 'bar');
  bar.dataset.barId = seg.bar.id;
  bar.dataset.lane = String(seg.lane);
  bar.style.top = `calc(var(--row-h) * ${seg.topRow} + 1px)`;
  bar.style.height = `calc(var(--row-h) * ${seg.rows} - 3px)`;
  bar.style.right = `calc(2px + var(--lane-gap) * ${seg.lane})`;
  bar.style.background = seg.color;
  if (seg.foreign) bar.dataset.foreign = '1';
  if (seg.foreign) bar.classList.add('foreign');
  // 16.7 — the stripe KEEPS the owner's colour and its full length: duration and
  // owner are deliberately visible. What the hatch says is "this range is taken,
  // and that is all you get" — the content is deliberately absent, not hidden
  // behind an affordance that suggests there is something to open.
  if (seg.redacted) bar.classList.add('belegt');
  if (!seg.canEdit) bar.classList.add('readonly');
  bar.title = segTitle(seg);

  // Resize grips only exist where the real end of the bar is, so dragging the
  // December half of a January bar can never silently reshape the wrong edge —
  // and, since 18.1, only where I am allowed to reshape it at all. A grip on a
  // bar I cannot edit is an affordance that lies.
  if (seg.canEdit) {
    if (!seg.contTop) bar.appendChild(el('div', 'bar-handle top'));
    if (!seg.contBot) bar.appendChild(el('div', 'bar-handle bottom'));
  }
  rec.bar = bar;

  // 3.6 — a bar that runs past the last visible column says so on the stripe
  // itself, not only in the column footer. Mirrored: one that began before the
  // first column gets the same glyph at its top, so "started earlier than you
  // can see" is distinguishable from an ordinary month split.
  if (seg.beyondEnd) {
    const cue = el('div', 'bar-cont-down', '↓');
    cue.style.color = seg.color;
    cue.style.right = `calc(1px + var(--lane-gap) * ${seg.lane})`;
    cue.style.top = `calc(var(--row-h) * ${seg.topRow + seg.rows} - 11px)`;
    rec.cues.push(cue);
  }
  if (seg.beyondStart) {
    const cue = el('div', 'bar-cont-up', '↑');
    cue.style.color = seg.color;
    cue.style.right = `calc(1px + var(--lane-gap) * ${seg.lane})`;
    cue.style.top = `calc(var(--row-h) * ${seg.topRow} + 1px)`;
    rec.cues.push(cue);
  }
}

/** 3.3 / 3.7 — one label per month segment, on a row that carries no ink. */
function buildLabel(seg, labelOnInk) {
  const lab = el('div', 'bar-label');
  lab.dataset.barId = seg.bar.id;
  lab.dataset.row = String(seg.labelRow);
  lab.style.top = `calc(var(--row-h) * ${seg.labelRow} + (var(--row-h) - 11px) / 2)`;
  // 3.7 — the promise is that the chip lands on empty space. `layout.js`'s scan
  // reaches for that first, but on a family board 99 % of day rows carry ink and
  // there is no empty row left to move to. Principle 3 decides what happens
  // then, and it is not close: the label retreats into the lane gutter — board
  // furniture, already reserved — and the user's sentence keeps every pixel it
  // had. The anchor moves to the column edge on the same branch, because a chip
  // capped to the gutter but hung one lane-gap inboard of lane 2 would still
  // have half of itself in the text column. `app.css` `.bar-label.on-ink` caps
  // the width; `usedLabelRows` in `layout.js` guarantees one label per row per
  // column, so two retreating chips can never land on each other.
  lab.style.right = labelOnInk ? '2px' : `calc(2px + var(--lane-gap) * ${seg.lane + 1})`;
  lab.style.background = seg.color;
  if (labelOnInk) lab.classList.add('on-ink');
  // The label chip is white-on-colour, so the initial chip inverts inside it:
  // a member-coloured chip on a member-coloured chip is invisible.
  lab.style.setProperty('--seg-ink', seg.color);
  if (seg.foreign) lab.classList.add('foreign');
  if (seg.redacted) lab.classList.add('belegt');
  if (!seg.canEdit) lab.classList.add('readonly');
  if (seg.contTop) {
    const cue = el('span', 'cue', '↑ ');
    lab.appendChild(cue);
  }
  if (seg.isNew) lab.appendChild(neuDot());
  if (seg.foreign) lab.appendChild(initialChip(seg.initial, null));
  const segBadge = exposureBadge(seg.exposure);
  if (segBadge) lab.appendChild(segBadge);
  lab.appendChild(document.createTextNode(segLabelText(seg)));
  lab.title = segTitle(seg);
  return lab;
}

/**
 * The scratchpad (F10). Returns the `<textarea>` alongside the block because
 * `patchPad` has to reconcile a PROPERTY (`value`) that no attribute comparison
 * would see, and a kept pad must not hold typing the model has not committed.
 */
function renderPad(col) {
  const pad = el('div', 'pad');
  pad.dataset.month = col.key;
  pad.appendChild(el('div', 'pad-label', t('scratchpad')));
  const ta = document.createElement('textarea');
  ta.value = col.pad;
  ta.spellcheck = false;
  ta.dataset.month = col.key;
  ta.rows = 5;
  ta.setAttribute('aria-label', `${t('scratchpad')} ${col.fullLabel}`);
  pad.appendChild(ta);
  padEmptyClass(pad, col.pad);
  return { el: pad, ta };
}


export { colorOf };
