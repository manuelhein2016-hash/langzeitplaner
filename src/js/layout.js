// The board model. Everything geometric is decided here; board.js only turns
// this into DOM. Keeping them apart is what makes print, find and drag previews
// able to reuse the same numbers.

import {
  addMonths, daysInMonth, dow, iso, monthKey, monthOrdinal, monthOrdinalOf,
  parseISO, p2, todayISO, WD_DE, WD_EN, MONTH_DE, MONTH_EN,
} from './dates.js';
import { holidayIndex } from './holidays.js';
import { ferienIndex } from './ferien.js';
import { colorOf, PALETTE } from './palette.js';
import { noteOccurrencesInRange, visibleBars as selectBars } from './core/entities.js';
import { showsContent, allowsCoEdit } from './core/visibility.js';

export const MAX_LANES = 3;        // spec 3.8
export const MONTHS_VISIBLE = 12;  // spec 1.1
const LINE_H = 10.5;               // one line of 9px entry text incl. leading

// ─────────────────────────────────────────────────────────────────────────────
// THE DENSITY SEAM — story 17.7 / LZP-808, „Kompakt / Komfort"
//
// „A per-device density setting slightly increases row height and font size on
//  that machine only — Mom's display and eyes are not mine — accepting
//  horizontal scroll as the trade."
//
// THE TWO PRESETS ARE NOT INVENTED. v1 §2's own density targets name two display
// classes and give each a row band and a type size:
//
//   „~1000 px usable height … ≈ 24–28 px per row; on a 13" MacBook closer to
//    20–22 px. Column width at 1440 px window ≈ 110–120 px. Entry text will sit
//    around 10–11 px."
//
// v1 shipped ONE of those two rows (22 px) and the smaller of the two type sizes
// (9 px), for every machine. 17.7 is v1's *other* display class, made
// selectable — and it is v1 open question 4 („exact row metrics per display
// class, 13" / 14" / 27"") answered with a control instead of a constant.
//
// ── WHY `lineH` IS PART OF A PRESET AND NOT A CONSTANT ───────────────────────
// DESIGN-DECISIONS §B derives the number of text lines a row can host:
//
//     capacity = clamp(floor((rowHeight - 1) / LINE_H), 1, 3)
//
// `LINE_H` is „one line of 9 px entry text incl. leading" — it is a fact about
// the TYPE SIZE, not about the app. Raise the type to 10.5 px and the rendered
// line box goes 10 px → 12 px (measured in WebKit, `density-808.dom.js` §1), so
// a `LINE_H` left at 10.5 would promise two lines to a row that can draw one and
// the second note would be painted into the row below it.
//
// THIS IS THE WHOLE HAZARD OF 17.7 AND IT POINTS THE WRONG WAY. A naive Komfort
// — bigger type over the shipped capacity rule — makes the CROWDED board WORSE,
// not better: at 22 px, one line box of 12 px fits where two of 10 px did, so
// Komfort would silently halve what a busy day shows. `minRowHeight` is what
// forbids it: Komfort's floor is the smallest row that still hosts TWO Komfort
// lines, so no reachable Komfort setting draws fewer entries than Kompakt does.
//
// ── WHAT IS *NOT* HERE, AND WHY ──────────────────────────────────────────────
// Nothing about lanes. `--lane-w`, `--lane-gap` and the 27 px `--gutter` are
// identical in both presets: a lane is a 6 px colour stripe, not type, and
// `family-render.dom.js` §7's „a family board is exactly as wide as a solo one"
// measurement is taken against those three numbers. Density moves TEXT.
//
// ── PER DEVICE, AND IT IS FREE ───────────────────────────────────────────────
// `density` is a `settings` key, and `settings` is written through `tx.pref()` —
// a `local`-space op that `store.js:outbox()` filters out by construction (rule
// U6; the comment there cites *this story* by number). So „it must never sync"
// needed no new machinery: it is the same local space that already holds the
// Bundesland and the window frame. `density-808.dom.js` §5 asserts it rather
// than trusting this paragraph.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two presets. `lineH`, `rowHeight`, `colWidth` and `minRowHeight` are the
 * geometry; `typePx` is published so a reviewer can check the CSS against the
 * `lineH` that was derived from it without opening a browser.
 *
 * KOMPAKT IS TODAY, TO THE PIXEL. Its four numbers are v1's shipped defaults and
 * its `lineH` is v1's `LINE_H`, so a board that never touches this setting is
 * byte-identical to the one before LZP-808 — which is why every v1
 * characterization row for `rowCapacity` still reads the same answer.
 */
export const DENSITY = Object.freeze({
  kompakt: Object.freeze({
    lineH: LINE_H,      // 9 px text → 10 px line box (measured) + .5 slack
    typePx: 9,
    rowHeight: 22,      // v1 default
    colWidth: 118,      // v1 default
    minRowHeight: 18,   // v1 slider floor
    maxRowHeight: 32,   // v1 slider ceiling
  }),
  komfort: Object.freeze({
    lineH: 12.5,        // 10.5 px text → 12 px line box (measured) + .5 slack
    typePx: 10.5,       // v1 §2: „entry text will sit around 10–11 px"
    rowHeight: 26,      // v1 §2's other band: „≈ 24–28 px per row"
    colWidth: 138,
    // floor(( 26 - 1) / 12.5) === 2 · floor((25 - 1) / 12.5) === 1.
    // 26 is therefore the smallest Komfort row that still shows what a Kompakt
    // row shows, and the slider may not go below it. See the hazard above.
    minRowHeight: 26,
    maxRowHeight: 32,
  }),
});

/** The names, in the order the settings pane offers them. */
export const DENSITIES = Object.freeze(['kompakt', 'komfort']);

/**
 * Which preset a settings object selects — Kompakt for anything unrecognised.
 *
 * An UNKNOWN value answers `kompakt` rather than throwing, for the same reason
 * `migrate()` keeps unknown settings keys: a board written by a future build
 * that grows a third preset must still open here, and the safe fallback is the
 * one that fits every display.
 */
export function densityOf(settings) {
  const d = settings && settings.density;
  return d === 'komfort' ? 'komfort' : 'kompakt';
}

// ─────────────────────────────────────────────────────────────────────────────
// The family decorations (ADR 004 §4.2, §4.3, §6 — LZP-705, LZP-706)
//
// EVERY ONE OF THEM IS A HORIZONTAL COST AND NONE OF THEM IS A VERTICAL ONE.
// `rowCapacity` is untouched below and the line box of a `.note` is unchanged, so
// a family board hosts exactly the same number of lines per day as a solo one —
// twelve months on one screen survives intact. What the badges spend is the
// ~60 px of TEXT width a day row has at the default 118 px column
// (118 − 17 day number − 13 weekday − 27 lane gutter − 1 for the note's own
// padding), and the brief's "measure what your additions cost a row" is answered
// in `PREFIX_COST_PX`, which `tests/tier2/belegt-render.dom.js` §5 measures the
// real rendered boxes against in WebKit at 22 px AND at 18 px.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What each prefix element costs a `.note`'s text width, in px.
 *
 * MEASURED, not estimated: these are the rendered box widths of the `app.css`
 * rules including their margins, taken in WebKit. The family is a fixed pixel
 * cost and does not scale with row height, which is exactly why it has to be
 * priced once and then held.
 *
 * Nothing here is read by the renderer. It is a published measurement, so a
 * reviewer can price the next marker somebody proposes without opening a
 * browser, and so a CSS edit that quietly widens one of them goes red.
 *
 * `rep` is the one font-dependent entry — the ↻ glyph at 8 px in Ubuntu plus
 * 1 px — so the test compares it within a pixel rather than exactly.
 */
export const PREFIX_COST_PX = Object.freeze({
  neu: 5,        // 17.5 — 3 px dot + 1 px bearing + 1 px margin
  chip: 10,      // 17.2 — 8 px initial chip + 2 px margin
  exposure: 9,   // 16.6 — 7 px badge + 2 px margin
  rep: 8,        // 9.2  — the existing ↻, unchanged by this epic
  // The two EXCLUSIVE worlds, and the reason the badge family fits at all.
  // `exposure` is MY disclosure of MY entry; `chip` and `neu` only ever appear
  // on SOMEONE ELSE'S. No note can carry both. ADR 004 §6 treats all five
  // markers as one contested slot — measured, the contest never has more than
  // three entrants, and the Belegt block costs ZERO extra width because it is a
  // fill on a note that was already there.
  ownWorst: 17,      // exposure + rep    — 28 % of the 60 px text budget
  foreignWorst: 23,  // neu + chip + rep  — 38 %
});

/**
 * What E8 (LZP-801 / LZP-803) adds to the bill. **Zero, on every axis.**
 *
 * The brief's rule is "measure what your additions cost a row and say so", and
 * the honest answer for this epic is that all three additions are re-orderings
 * and overlays inside geometry that already existed:
 *
 *   ownership rail (17.2, `.bar.foreign::after`)   0 px — `inset: 0` on the
 *       6 px stripe that was already drawn. It converts 1 px of the stripe's
 *       own ink into a light rail; the lane, the gutter and the column keep
 *       every pixel they had.
 *   mine-before-theirs lanes (17.4)                0 px — a comparator prefix.
 *   the label scan's two fallbacks (3.7)           0 px — the same one chip per
 *       month segment, on a different row.
 *
 * So a family board is EXACTLY as tall and EXACTLY as wide as a solo one, and
 * `rowCapacity` still takes one argument. `tests/tier2/family-render.dom.js`
 * §7 measures the board's full geometry with and without the family and
 * asserts the difference is nil rather than trusting this comment.
 */
export const FAMILY_LAYOUT_COST_PX = Object.freeze({
  rowHeight: 0, laneWidth: 0, gutter: 0, columnWidth: 0, noteTextWidth: 0,
});

/**
 * A foreign entry whose member record has not arrived yet.
 *
 * ADR 004 §4.3: a foreign entry must NEVER fall through to `colorOf(undefined)`,
 * which silently answers `PALETTE[0]` (blue) and would paint someone else's
 * entry as one of mine. `colorOf` answers `PALETTE[0]` for an UNKNOWN ref too,
 * so guarding only against `null` would leave the same hole one typo wide.
 * This tone is deliberately not in `PALETTE`, so it can never collide with a
 * member's real colour and "I do not know whose this is" stays distinguishable
 * from "this is Papa's".
 */
export const UNKNOWN_MEMBER_COLOR = '#8A7CB8';   // --ink-3

/** The chip glyph for a foreign entry whose member record has not arrived. */
export const UNKNOWN_MEMBER_INITIAL = '·';

const PALETTE_REFS = new Set(PALETTE.map((p) => p.ref));

/**
 * The one colour decision, for notes and bars alike (ADR 004 §17.2 / §4.3).
 * Mine → my category colour, so my board stays mine. Someone else's → their
 * member colour, and never a category colour anywhere, because A3 means a
 * foreign entry HAS no category to read.
 */
export function entryColor(entry, catOf) {
  if (entry && entry.isForeign) {
    const ref = entry.memberColorRef;
    return typeof ref === 'string' && PALETTE_REFS.has(ref) ? colorOf(ref) : UNKNOWN_MEMBER_COLOR;
  }
  return colorOf((catOf.get(entry.categoryId) || {}).paletteRef);
}

/**
 * 18.1 / 18.2 — only the owner edits, unless the owner opted this one entry in.
 * Read by `board.js` to withhold the resize grips and by `interact.js` to
 * withhold the gestures; both must ask the same question, so it is asked here.
 *
 * `allowsCoEdit(level)` IS PART OF THE QUESTION, not decoration. ADR 004 §8:
 * `pub.coEdit` exists only at Geteilt. A Geteilt → Belegt downgrade nulls it
 * (§5's table), but `pub.coEdit` is a GOVERNING field and `authz.js` stage 3c
 * never drops governing fields — so between the arrival of the new `pub.level`
 * and the arrival of the `pub.coEdit: null` beside it, a register map can hold
 * `level: 'belegt'` next to `coEdit: true`. Reading the flag alone would put
 * live resize grips on someone else's Belegt block for exactly that window.
 */
export const canEditEntry = (entry) =>
  !entry.isForeign || (entry.coEdit === true && allowsCoEdit(entry.level));

/**
 * The exposure badge's input (16.6, ADR 004 §6), narrowed at the model seam.
 *
 * `exposure` is MY disclosure state and is meaningless for someone else's entry
 * — `materialize.js` already answers `null` there, and this re-states it so a
 * future materializer change cannot put a peer's level on my board. `privat`
 * yields no badge at all: the ABSENCE of a badge means private, which is the
 * default and the quiet state (Principle 8).
 */
export function exposureOf(entry) {
  if (!entry || entry.isForeign) return null;
  const e = entry.exposure;
  if (!e || typeof e !== 'object') return null;
  if (e.level !== 'belegt' && e.level !== 'geteilt') return null;
  return { level: e.level, pending: !!e.pending };
}

/**
 * The per-member toggle (17.3), from the device-local `hiddenMembers` pref.
 *
 * `Object.hasOwn`, not `in` and not a bare index: `hidden['toString']` is a
 * truthy inherited function and would hide a member. That is the same
 * prototype-chain hole WP-10 found in ADR 004 §2.2's own printed barrier, one
 * layer up, and it costs one call to close.
 *
 * The same rule is spelled in `family/membersui.js:hiddenMemberIds()`, which
 * builds a Set for the legend. Both read one register shape; if a third reader
 * appears the predicate belongs in `core/entities.js`.
 */
export function memberVisibilityOf(settings) {
  const hidden = settings && settings.hiddenMembers;
  if (!hidden || typeof hidden !== 'object') return () => true;
  return (memberId) => !(Object.hasOwn(hidden, memberId) && hidden[memberId]);
}

/** The family decorations one model row carries, for a note or a bar segment. */
function decorate(entry, catOf) {
  const foreign = !!entry.isForeign;
  return {
    color: entryColor(entry, catOf),
    foreign,
    // ═══ 16.7 — WHAT THE BOARD MAY PAINT ═════════════════════════════════════
    // Keyed on the LEVEL, never on the absence of a text. A text that reaches a
    // Belegt entry is a defect upstream; deciding "redacted" by asking whether
    // one is present would turn that defect into the leak.
    //
    // `!showsContent(level)`, NOT `isRedacted(level)`, and the difference is the
    // one input class `visibility.js:projectedToPeers` flags and declines to
    // decide: a level OUTSIDE the enum. `entities.js:projectable` admits such an
    // entry (dropping a family member's entry is data loss on the viewer's
    // board) and `materialize.js` leaves `entry.redacted` false, so an old
    // client that folded a stale `pub.text` beside a level added between Belegt
    // and Geteilt by a future protocol version WOULD PRINT THE TEXT. That leak
    // happens here, in the renderer, so it is closed here — and it is closed
    // without paying the data-loss price the other half of the trade would:
    // the entry still appears, with its date, its owner and its duration. Only
    // the content is withheld, which is what an unknown level is entitled to.
    //
    // On every level THIS build can produce the two agree exactly; the row is
    // `X4` in `core/visibility.js`'s terms and `belegt-render.dom.js` §4 here.
    redacted: foreign && !showsContent(entry.level),
    initial: foreign ? (entry.initial || UNKNOWN_MEMBER_INITIAL) : null,
    isNew: foreign && !!entry.isNew,            // 17.5 dots a PEER's change, never my own
    exposure: exposureOf(entry),                // 16.6, own entries only
    canEdit: canEditEntry(entry),               // 18.1 / 18.2
  };
}

/**
 * How many text lines a day row can host at the current density.
 *
 * DESIGN-DECISIONS §B, generalised over the type size instead of over one
 * hard-coded line box. `density` is OPTIONAL and defaults to `kompakt`, whose
 * `lineH` IS v1's `LINE_H` — so every existing caller, and every v1
 * characterization row (`rowCapacity(18) === 1`, `(22) === 2`, `(32) === 2`,
 * `(33) === 3`), gets the identical answer it got before this seam existed.
 *
 * The clamp to 3 is 3.8's, not arithmetic: neither preset can reach it inside
 * the 18–32 px slider (Kompakt needs 33 px, Komfort 39), which is the same
 * ceiling `tests/COVERAGE.md` records as „rowCapacity(32) is 2, not 3".
 */
export function rowCapacity(rowH, density = 'kompakt') {
  const lineH = (DENSITY[density] || DENSITY.kompakt).lineH;
  return Math.max(1, Math.min(3, Math.floor((rowH - 1) / lineH)));
}

/** First visible month, honouring rolling vs. pinned + paging (1.3, 1.5). */
export function visibleStart(settings, today = todayISO()) {
  if (settings.mode === 'pinned') {
    const { y, m } = parseISO(`${settings.startMonth}-01`);
    return addMonths(y, m, (settings.pageYears || 0) * 12);
  }
  const { y, m } = parseISO(today);
  return { y, m };
}

/**
 * Mine before theirs — the ONE ordering rule the family layer adds (LZP-803).
 *
 * v1's principle 3 says the user's own entries always win visual priority, and
 * D4 accepted 17.2's "my board stays mine". Neither survives a first-fit sweep
 * ordered by date alone: `assignLanes` hands lanes out in start-date order, so
 * three of Mama's long stripes take lanes 0–2 for six months and MY OWN
 * vacation bar becomes a "+n" badge on MY OWN board. Measured on the 8-member
 * × 2-year fixture `tests/tier2/family-render.dom.js` §6 builds, with this term
 * removed: **41 % of my own bar segments were pushed out of the lanes.** §6
 * now asserts the exact property instead of the percentage — every segment of
 * mine that a SOLO board draws is still drawn once seven other people are on
 * the board — and prints the lottery numbers as `diag`.
 *
 * It is a PREFIX of the existing comparator, not a replacement, so the rest of
 * v1's order (start asc, end desc, id asc) decides everything below it. On a
 * solo board every bar answers 0 and the term is provably inert — which is why
 * `core-materialize.test.js`'s lane snapshots and `migration.test.js`'s
 * ordering rows do not move.
 *
 * It does NOT rescue me from the cap: four of my own overlapping bars still
 * cost the fourth one its lane (3.8 is about the board's legibility, not about
 * ownership). It only stops someone else's plan from outranking mine.
 */
const ownFirst = (a, b) => (a.isForeign ? 1 : 0) - (b.isForeign ? 1 : 0);

/**
 * Global lane assignment (3.4/3.8).
 * Lanes are decided once across the whole timeline, not per column, so a bar
 * keeps the same lane when it crosses a month boundary — otherwise a six-month
 * stripe would visibly jump sideways every January.
 */
export function assignLanes(bars) {
  const sorted = [...bars].sort(
    (a, b) =>
      ownFirst(a, b) ||
      (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0) ||
      (b.endDate < a.endDate ? -1 : b.endDate > a.endDate ? 1 : 0) ||
      (a.id < b.id ? -1 : 1)
  );
  const lanes = []; // lane index → list of [start, end]
  const out = new Map();
  for (const b of sorted) {
    let placed = -1;
    for (let i = 0; i < lanes.length; i++) {
      const clash = lanes[i].some(([s, e]) => !(b.endDate < s || b.startDate > e));
      if (!clash) { placed = i; break; }
    }
    if (placed === -1) { lanes.push([]); placed = lanes.length - 1; }
    lanes[placed].push([b.startDate, b.endDate]);
    out.set(b.id, placed);
  }
  return out;
}

/**
 * Build the full render model.
 * @param {object} state store.state
 * @param {object} opts  { today }
 */
export function buildBoard(state, opts = {}) {
  const today = opts.today || todayISO();
  const s = state.settings;
  const lang = s.language === 'en' ? 'en' : 'de';
  const WD = lang === 'en' ? WD_EN : WD_DE;
  const MN = lang === 'en' ? MONTH_EN : MONTH_DE;
  // 17.7 — the one place the density seam is consumed. Everything else it
  // changes is type, and type is `app.css`'s half.
  const density = densityOf(s);
  // The floor is enforced HERE and not only in the settings pane, so it holds
  // for a `board.json` that arrived by import, by migration or by hand. Every
  // other geometry in the app (`--row-h`, `rowAt`, the drag preview, print)
  // derives from `model.rowH`, so clamping once here clamps all of them.
  const dp = DENSITY[density];
  const rowH = Math.max(dp.minRowHeight, s.rowHeight || dp.rowHeight);
  const capacity = rowCapacity(rowH, density);

  const start = visibleStart(s, today);
  const months = [];
  for (let i = 0; i < MONTHS_VISIBLE; i++) months.push(addMonths(start.y, start.m, i));

  const firstISO = iso(months[0].y, months[0].m, 1);
  const lastMonth = months[MONTHS_VISIBLE - 1];
  const lastISO = iso(lastMonth.y, lastMonth.m, daysInMonth(lastMonth.y, lastMonth.m));

  const years = [...new Set(months.map((m) => m.y))];
  const hol = s.layers.feiertage
    ? holidayIndex(years, s.bundesland, lang)
    : new Map();
  const fer = s.layers.schulferien && s.bundesland
    ? ferienIndex(s.bundesland, lang)
    : new Map();

  const catOf = new Map(state.categories.map((c) => [c.id, c]));

  // ADR 004 §4.3 / ADR 005 §3 — ONE selector, shared with the popover. The two
  // used to be separate filters that had to be kept in lockstep by hand, and a
  // foreign entry would have been silently omitted from whichever one was
  // updated second. `entities.js` routes MINE through the category gate (4.3)
  // and SOMEONE ELSE'S through the member gate (17.3), because a foreign entry
  // has no `categoryId` at all (A3) and `categoryVisible(undefined)` answers
  // "visible" by v1's dangling-reference rule — correct by accident is not good
  // enough for a privacy control.
  const sel = { memberVisible: opts.memberVisible || memberVisibilityOf(s) };
  const occ = noteOccurrencesInRange(state, firstISO, lastISO, sel);

  const visibleBars = selectBars(state, sel);
  const laneOf = assignLanes(visibleBars);

  // ── columns ────────────────────────────────────────────────────────────────
  const cols = months.map((mo, mi) => {
    const len = daysInMonth(mo.y, mo.m);
    const mFirst = iso(mo.y, mo.m, 1);
    const mLast = iso(mo.y, mo.m, len);
    const laneOverflow = new Array(32).fill(0);

    // segments first — day rows need to know where labels want to sit
    const segs = [];
    const overflowSegs = [];
    for (const b of visibleBars) {
      if (b.endDate < mFirst || b.startDate > mLast) continue;
      const segStart = b.startDate > mFirst ? b.startDate : mFirst;
      const segEnd = b.endDate < mLast ? b.endDate : mLast;
      const sd = parseISO(segStart).d;
      const ed = parseISO(segEnd).d;
      const lane = laneOf.get(b.id) ?? 0;
      const seg = {
        bar: b,
        lane,
        ...decorate(b, catOf),
        startDay: sd,
        endDay: ed,
        topRow: sd - 1,
        rows: ed - sd + 1,
        contTop: b.startDate < mFirst,
        contBot: b.endDate > mLast,
        // 3.6 — the two horizon cases, mirrored
        beyondStart: mi === 0 && b.startDate < firstISO,
        beyondEnd: mi === MONTHS_VISIBLE - 1 && b.endDate > lastISO,
      };
      if (lane >= MAX_LANES) overflowSegs.push(seg);
      else segs.push(seg);
    }

    // 3.8 — the cap is per DAY, not per bar lifetime. A bar that lost the
    // global lane lottery only stays hidden where three bars actually coincide;
    // in any month where a base lane is free across its whole segment it is
    // rescued into that lane. The rescue is per-column, so such a bar may sit
    // in different lanes in different months — visible beats stable here.
    //
    // ═══ AND THE ONE PLACE THE FAMILY COULD STILL TAKE A LANE FROM ME ════════
    // Ordering the GLOBAL sweep mine-first is not enough on its own, and the
    // 8-member fixture found the hole: my bars get their solo lanes there, but
    // the RESCUE is a second, per-column allocation, and a foreign bar that won
    // a base lane in the global sweep sits in `segs` and blocks it. Measured:
    // one of my segments per ~40 vanished from a month it is drawn in on the
    // solo board — for no reason the user could see, and with no way to get it
    // back except leaving the family.
    //
    // So the rescue runs in three passes and the invariant becomes exact:
    // **the lanes my bars occupy are the lanes they occupy on a solo board.**
    //
    //   (1) my overflow segs are rescued against MY segs only — which IS the
    //       solo answer, because a solo board has no others to consider;
    //   (2) any foreign seg now sitting under one of mine yields its lane and
    //       goes back into the pool. Only an OWN seg can evict, and an evicted
    //       seg can never evict in turn, so this terminates in one round;
    //   (3) the family fills what is left, by start day, exactly as before.
    //
    // On a solo board pass 1 IS v1's loop, pass 2 finds nothing and pass 3 is
    // empty — so `layout.test.js`'s rescue rows, `laneMap` orders and
    // `core-materialize.test.js`'s segment snapshots are untouched.
    // ═════════════════════════════════════════════════════════════════════════
    const hits = (a, b) => !(a.endDay < b.startDay || a.startDay > b.endDay);
    const freeLane = (seg, pool) => {
      for (let l = 0; l < MAX_LANES; l++) {
        if (!pool.some((s) => s.lane === l && hits(s, seg))) return l;
      }
      return -1;
    };

    overflowSegs.sort((a, b) => ownFirst(a.bar, b.bar) || a.startDay - b.startDay);
    const dropped = [];

    // (1) mine, against mine
    for (const seg of overflowSegs) {
      if (seg.foreign) continue;
      const placed = freeLane(seg, segs.filter((s) => !s.foreign));
      if (placed >= 0) { seg.lane = placed; segs.push(seg); }
      else dropped.push(seg);
    }
    // (2) foreign segs yield to mine
    const evicted = [];
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i];
      if (!s.foreign) continue;
      if (segs.some((o) => !o.foreign && o.lane === s.lane && hits(o, s))) {
        segs.splice(i, 1);
        evicted.push(s);
      }
    }
    // (3) theirs, against everything that is left
    const theirs = overflowSegs.filter((s) => s.foreign).concat(evicted)
      .sort((a, b) => a.startDay - b.startDay);
    for (const seg of theirs) {
      const placed = freeLane(seg, segs);
      if (placed >= 0) { seg.lane = placed; segs.push(seg); }
      else dropped.push(seg);
    }
    for (const seg of dropped) {
      for (let d = seg.startDay; d <= seg.endDay; d++) laneOverflow[d] += 1;
    }

    // ── day rows ─────────────────────────────────────────────────────────────
    const days = [];
    for (let d = 1; d <= 31; d++) {
      if (d > len) {
        days.push({ empty: true, row: d - 1 });
        continue;
      }
      const date = iso(mo.y, mo.m, d);
      const w = dow(mo.y, mo.m, d);
      const weekend = w === 0 || w === 6;
      const ferName = fer.get(date) || '';
      const h = hol.get(date) || null;
      const showHol = h && (h.own || s.layers.otherStates);

      // 17.4 — foreign notes arrive through THIS map, so they hit the capacity
      // slice below and are counted into `overflow` exactly like mine. A family
      // entry can never break the board's density rules, because there is no
      // second path on which it could bypass them.
      const notesHere = (occ.get(date) || []).map((o) => ({
        note: o.note,
        date,
        ...decorate(o.note, catOf),
      }));

      // Challenge 2 resolved: a holiday keeps the row only while the user has
      // not claimed it. Once a note is there the holiday demotes to a tinted
      // day number + gutter dot and survives as a tooltip (spec F6 notes).
      let holidayLines = 0;
      let holidayDemoted = false;
      if (showHol) {
        if (capacity >= 2 || notesHere.length === 0) holidayLines = 1;
        else holidayDemoted = true;
      }
      const noteSlots = Math.max(0, capacity - holidayLines);
      const shown = notesHere.slice(0, noteSlots);
      const hiddenCount = notesHere.length - shown.length + laneOverflow[d];

      days.push({
        empty: false,
        row: d - 1,
        date,
        n: p2(d),
        wd: WD[w],
        weekend,
        ferien: !!ferName,
        ferienName: ferName,
        holiday: showHol ? h : null,
        holidayShown: holidayLines === 1,
        holidayDemoted,
        isToday: date === today,
        notes: shown,
        allNotes: notesHere,
        overflow: hiddenCount > 0 ? hiddenCount : 0,
        laneOverflow: laneOverflow[d],
      });
    }

    // ── label rows ───────────────────────────────────────────────────────────
    // 3.7 — one label per month segment. Prefer a row inside the segment that
    // has no ink of its own, so the chip never covers a note.
    //
    // ═══ WHY THIS GREW TWO FALLBACKS (LZP-803) ═══════════════════════════════
    // v1's scan is a single loop with ONE fallback: `dy = 0`. That fallback is
    // reached when no ink-free row exists in the first six — rare on a solo
    // board, and MEASURED AT 100 % ON THE 8-MEMBER FIXTURE, where 99 % of day
    // rows carry ink. Two things then went wrong at once, and only the second
    // is a real defect:
    //
    //   1. every label sits on its segment's top row. Unavoidable: when every
    //      row is inked there is no uninked row to move to. v1 already accepted
    //      this trade and it stands.
    //   2. `dy = 0` IGNORES `usedLabelRows`, so two or three segments in the
    //      same column land on the SAME row — and `.bar-label` is opaque, 66 px
    //      wide and right-anchored per lane, so the higher lane paints over the
    //      lower one and one bar's label becomes UNREADABLE. Measured: 21 % of
    //      the fixture's 135 labels. That is information destroyed, not density
    //      spent, and it is what the two passes below close.
    //
    // Pass A is v1's loop, unchanged, and it decides every case v1's tests pin.
    // Pass B fires only where v1 fell through to `dy = 0`, and prefers the
    // LEAST-inked unclaimed row — a generalisation of pass A's binary test
    // (ink 0 IS pass A's `free`), tie-broken to the earliest row, so a board on
    // which pass A already answered cannot reach a different answer here.
    // Pass C fires only when the whole six-row window is claimed, and looks
    // down the rest of the segment for any unclaimed row: overprinting is the
    // one outcome worth walking away from the segment top to avoid.
    // Pass D is v1's `dy = 0`, still the last word when a short segment has
    // nowhere left to go — three 1-day bars in one column cannot have three
    // distinct label rows.
    // ═════════════════════════════════════════════════════════════════════════

    /** How much ink a row already carries. 0 is exactly v1's `free`. */
    const inkOf = (day) =>
      (day.holidayShown ? 1 : 0) + day.notes.length + (day.overflow > 0 ? 1 : 0);

    const usedLabelRows = new Set();
    for (const seg of segs) {
      const win = Math.min(seg.rows, 6);
      let dy = -1;
      let best = -1, bestInk = Infinity;
      for (let i = 0; i < win; i++) {                                  // pass A + B
        const day = days[seg.topRow + i];
        if (!day || day.empty || usedLabelRows.has(seg.topRow + i)) continue;
        const ink = inkOf(day);
        if (ink === 0) { dy = i; break; }                              // pass A — v1
        if (ink < bestInk) { best = i; bestInk = ink; }                // pass B
      }
      if (dy === -1) dy = best;
      if (dy === -1) {                                                 // pass C
        for (let i = Math.max(0, win); i < seg.rows; i++) {
          const day = days[seg.topRow + i];
          if (!day || day.empty || usedLabelRows.has(seg.topRow + i)) continue;
          dy = i; break;
        }
      }
      if (dy === -1) dy = 0;                                           // pass D — v1
      seg.labelRow = seg.topRow + dy;
      usedLabelRows.add(seg.labelRow);
    }
    segs.sort((a, b) => a.lane - b.lane || a.topRow - b.topRow);

    return {
      key: monthKey(mo.y, mo.m),
      y: mo.y,
      m: mo.m,
      index: mi,
      label: `${MN[mo.m - 1].slice(0, 3)} ’${String(mo.y).slice(2)}`,
      fullLabel: `${MN[mo.m - 1]} ${mo.y}`,
      len,
      days,
      segs,
      pad: state.scratchpads[monthKey(mo.y, mo.m)] || '',
      horizon: segs.some((x) => x.beyondEnd),
      isTodayMonth: monthOrdinal(mo.y, mo.m) === monthOrdinalOf(today),
    };
  });

  return {
    cols, today, rowH, capacity,
    density,                       // 17.7 — so a reader of the model can see which rule ran
    firstISO, lastISO,
    colW: s.colWidth || DENSITY[density].colWidth,
    laneCount: MAX_LANES,
  };
}

/** Inverse of the row geometry — which day row does a y offset land on? */
export function rowAt(y, rowH) {
  return Math.max(0, Math.min(30, Math.floor(y / rowH)));
}
