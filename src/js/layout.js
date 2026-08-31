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

/** How many text lines a day row can host at the current density. */
export function rowCapacity(rowH) {
  return Math.max(1, Math.min(3, Math.floor((rowH - 1) / LINE_H)));
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
 * Global lane assignment (3.4/3.8).
 * Lanes are decided once across the whole timeline, not per column, so a bar
 * keeps the same lane when it crosses a month boundary — otherwise a six-month
 * stripe would visibly jump sideways every January.
 */
export function assignLanes(bars) {
  const sorted = [...bars].sort(
    (a, b) =>
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
  const rowH = s.rowHeight || 22;
  const capacity = rowCapacity(rowH);

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
    overflowSegs.sort((a, b) => a.startDay - b.startDay);
    for (const seg of overflowSegs) {
      let placed = -1;
      for (let l = 0; l < MAX_LANES; l++) {
        const clash = segs.some(
          (s) => s.lane === l && !(seg.endDay < s.startDay || seg.startDay > s.endDay)
        );
        if (!clash) { placed = l; break; }
      }
      if (placed >= 0) {
        seg.lane = placed;
        segs.push(seg);
      } else {
        for (let d = seg.startDay; d <= seg.endDay; d++) laneOverflow[d] += 1;
      }
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
    const usedLabelRows = new Set();
    for (const seg of segs) {
      let dy = 0;
      for (let i = 0; i < Math.min(seg.rows, 6); i++) {
        const day = days[seg.topRow + i];
        if (!day || day.empty) continue;
        const free = !day.holidayShown && day.notes.length === 0 && day.overflow === 0;
        if (free && !usedLabelRows.has(seg.topRow + i)) { dy = i; break; }
      }
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
    firstISO, lastISO,
    colW: s.colWidth || 118,
    laneCount: MAX_LANES,
  };
}

/** Inverse of the row geometry — which day row does a y offset land on? */
export function rowAt(y, rowH) {
  return Math.max(0, Math.min(30, Math.floor(y / rowH)));
}
