// The board model. Everything geometric is decided here; board.js only turns
// this into DOM. Keeping them apart is what makes print, find and drag previews
// able to reuse the same numbers.

import {
  addMonths, daysInMonth, dow, iso, monthKey, monthOrdinal, monthOrdinalOf,
  parseISO, projectYearly, p2, todayISO, WD_DE, WD_EN, MONTH_DE, MONTH_EN,
} from './dates.js';
import { holidayIndex } from './holidays.js';
import { ferienIndex } from './ferien.js';
import { colorOf } from './palette.js';

export const MAX_LANES = 3;        // spec 3.8
export const MONTHS_VISIBLE = 12;  // spec 1.1
const LINE_H = 10.5;               // one line of 9px entry text incl. leading

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

/** Expand yearly repeats into concrete dates inside the visible window (F9). */
function noteOccurrences(notes, firstISO, lastISO) {
  const map = new Map(); // date → occurrences[]
  const push = (date, note) => {
    if (date < firstISO || date > lastISO) return;
    if (!map.has(date)) map.set(date, []);
    map.get(date).push({ note, date });
  };
  const y0 = Number(firstISO.slice(0, 4));
  const y1 = Number(lastISO.slice(0, 4));
  for (const n of notes) {
    if (!n.repeatsYearly) { push(n.date, n); continue; }
    const anchorYear = Number(n.date.slice(0, 4));
    for (let y = Math.max(y0, anchorYear); y <= y1; y++) {
      // 9.5 — a series exists from its first year onward, never before.
      push(projectYearly(n.date, y), n);
    }
  }
  return map;
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

  const visibleCat = new Map(state.categories.map((c) => [c.id, c.visible !== false]));
  const catOf = new Map(state.categories.map((c) => [c.id, c]));

  const occ = noteOccurrences(
    state.notes.filter((n) => visibleCat.get(n.categoryId) !== false),
    firstISO, lastISO
  );

  const visibleBars = state.bars.filter((b) => visibleCat.get(b.categoryId) !== false);
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
        color: colorOf((catOf.get(b.categoryId) || {}).paletteRef),
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

      const notesHere = (occ.get(date) || []).map((o) => ({
        note: o.note,
        date,
        color: colorOf((catOf.get(o.note.categoryId) || {}).paletteRef),
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
