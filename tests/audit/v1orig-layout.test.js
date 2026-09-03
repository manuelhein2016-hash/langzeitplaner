// CHARACTERIZATION — area "layout-board".
//
// layout.js is the whole render model: 12 columns × 31 rows, global lane
// assignment + per-column lane rescue, holiday demotion, overflow counts,
// label placement, horizon cues. board.js only turns this into DOM, so every
// geometric decision v1 makes is observable here, in tier 1, with no browser.
//
// This is the densest logic in v1 and the highest risk for LZP-402 (op-log
// retrofit). Everything below asserts what the CODE DOES TODAY, cross-read
// against the numbered stories in LangzeitPlaner_Design_Spec_v1.md and against
// DESIGN-DECISIONS.md. Where doc and code disagree the CODE wins and the
// disagreement is called out in a `DISCREPANCY` comment.
//
// Stories in scope: 1.1–1.6, 2.3–2.5, 3.1–3.8.
//
// Deliberately NOT here (they are not layout.js's job, and pretending otherwise
// would make this suite fail for the wrong reasons after the retrofit):
//   · 2.1/2.2/3.1/5.x gestures        → tests/tier2/interaction.dom.js
//   · the rendered "+n" chip, ↑/↓ cue glyphs, ellipsis CSS → tier 2 / CSS
//   · 1.4 horizontal scrolling         → CSS, no model input
// The seams between them are pinned below where layout.js defines the contract
// the DOM layer consumes.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../../src/js/layout.js';
import { boardState, note, bar, dayOf, colOf } from '../helpers/fixtures.js';

const TODAY = '2026-01-15';
const build = (patch, today = TODAY) => L.buildBoard(boardState(patch), { today });
/** labels of the segments a column draws, with their lane — the observable
 *  result of lane assignment + rescue. */
const laneMap = (col) => col.segs.map((s) => `${s.bar.label}:${s.lane}`);

// ═══════════════════════════════════════════════════════════════════════════
// F1 — the board skeleton (1.1, 1.2, 1.6)
// ═══════════════════════════════════════════════════════════════════════════

describe('F1 · board skeleton', () => {
  test('1.1 — twelve month columns, always, in one model', () => {
    const m = build({});
    assert.equal(L.MONTHS_VISIBLE, 12);
    assert.equal(m.cols.length, 12);
    assert.deepEqual(
      m.cols.map((c) => c.key),
      ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
       '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12']
    );
    m.cols.forEach((c, i) => assert.equal(c.index, i, 'index echoes position'));
    assert.equal(m.firstISO, '2026-01-01');
    assert.equal(m.lastISO, '2026-12-31');
  });

  test('1.1 — the twelve columns may span two calendar years', () => {
    const m = build({ settings: { startMonth: '2026-08' } }, '2026-08-25');
    assert.deepEqual(
      m.cols.map((c) => c.key),
      ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01',
       '2027-02', '2027-03', '2027-04', '2027-05', '2027-06', '2027-07']
    );
    assert.equal(m.firstISO, '2026-08-01');
    assert.equal(m.lastISO, '2027-07-31');
    assert.deepEqual([m.cols[4].y, m.cols[5].y], [2026, 2027]);
  });

  test('1.6 — every column is exactly 31 rows; short months pad at the BOTTOM', () => {
    const m = build({});
    assert.equal(m.cols.reduce((n, c) => n + c.days.length, 0), 372, '12 × 31');
    for (const c of m.cols) {
      assert.equal(c.days.length, 31, `${c.key} row count`);
      assert.equal(c.days.filter((d) => !d.empty).length, c.len, `${c.key} populated`);
      // the void rows are a contiguous tail — never a gap in the middle
      const firstVoid = c.days.findIndex((d) => d.empty);
      if (firstVoid !== -1) {
        assert.equal(firstVoid, c.len, `${c.key} first void row`);
        assert.ok(c.days.slice(firstVoid).every((d) => d.empty), `${c.key} tail is all void`);
      }
    }
    assert.equal(colOf(m, '2026-02').len, 28);
    assert.equal(colOf(m, '2026-02').days.filter((d) => d.empty).length, 3);
    assert.equal(colOf(m, '2026-04').days.filter((d) => d.empty).length, 1);
    assert.equal(colOf(m, '2026-01').days.filter((d) => d.empty).length, 0);
    assert.equal(m.cols.reduce((n, c) => n + c.days.filter((d) => !d.empty).length, 0), 365);
  });

  test('1.6 — row N is day N+1 in EVERY column, which is what makes columns compare', () => {
    const m = build({});
    for (const c of m.cols) {
      c.days.forEach((d, i) => {
        assert.equal(d.row, i, `${c.key} row field`);
        if (!d.empty) {
          assert.equal(d.date.slice(8), String(i + 1).padStart(2, '0'), `${c.key} day-of-month`);
          assert.equal(d.n, String(i + 1).padStart(2, '0'), '2-digit day number');
        }
      });
    }
    // "01 is always the top row" — spec §5
    for (const c of m.cols) assert.equal(c.days[0].date, `${c.key}-01`);
  });

  test('1.6 — a void row carries NOTHING but its row index (no date to click)', () => {
    const feb = colOf(build({}), '2026-02');
    assert.deepEqual(feb.days[28], { empty: true, row: 28 });
    assert.deepEqual(Object.keys(feb.days[30]), ['empty', 'row']);
  });

  test('1.2 — each row carries its weekday abbreviation and weekend flag', () => {
    const m = build({});
    assert.equal(dayOf(m, '2026-01-01').wd, 'Do');
    assert.equal(dayOf(m, '2026-01-03').weekend, true);   // Sa
    assert.equal(dayOf(m, '2026-01-04').weekend, true);   // So
    assert.equal(dayOf(m, '2026-01-05').weekend, false);  // Mo
    const weekendCount = m.cols.reduce(
      (n, c) => n + c.days.filter((d) => !d.empty && d.weekend).length, 0);
    assert.equal(weekendCount, 104, '2026 has 104 weekend days');
  });

  test('1.2 — weekday abbreviations follow the language setting', () => {
    const de = build({});
    const en = build({ settings: { language: 'en' } });
    assert.equal(dayOf(de, '2026-01-07').wd, 'Mi');
    assert.equal(dayOf(en, '2026-01-07').wd, 'We');
    // anything not literally 'en' is German (layout.js:89)
    const junk = build({ settings: { language: 'fr' } });
    assert.equal(dayOf(junk, '2026-01-07').wd, 'Mi');
  });

  test('column labels: short in the head, full for the tooltip', () => {
    const m = build({});
    assert.equal(m.cols[0].label, 'Jan ’26');
    assert.equal(m.cols[0].fullLabel, 'Januar 2026');
    assert.equal(m.cols[2].label, 'Mär ’26');
    const en = build({ settings: { language: 'en' } });
    assert.equal(en.cols[0].label, 'Jan ’26');
    assert.equal(en.cols[0].fullLabel, 'January 2026');
    assert.equal(en.cols[2].fullLabel, 'March 2026');
  });

  test('a leap year contributes 366 populated day rows and a 29-row February', () => {
    const m = build({ settings: { startMonth: '2028-01' } }, '2028-01-15');
    assert.equal(m.cols.reduce((n, c) => n + c.days.filter((d) => !d.empty).length, 0), 366);
    assert.equal(colOf(m, '2028-02').len, 29);
    assert.equal(colOf(m, '2028-02').days.filter((d) => d.empty).length, 2);
    assert.equal(colOf(m, '2028-02').days[28].date, '2028-02-29');
    // …and 2100 is not a leap year, so the arithmetic is Gregorian, not %4.
    const c2100 = build({ settings: { startMonth: '2100-01' } }, '2100-01-15');
    assert.equal(colOf(c2100, '2100-02').len, 28);
  });

  test('the model echoes its inputs: today, row/column metrics, lane count', () => {
    const m = build({});
    assert.equal(m.today, TODAY);
    assert.equal(m.rowH, 22);
    assert.equal(m.colW, 118);
    assert.equal(m.capacity, 2);
    assert.equal(m.laneCount, L.MAX_LANES);
    const big = build({ settings: { rowHeight: 30, colWidth: 160 } });
    assert.deepEqual([big.rowH, big.colW], [30, 160]);
    // falsy metrics fall back to the shipped defaults (layout.js:92, :268)
    const zero = build({ settings: { rowHeight: 0, colWidth: 0 } });
    assert.deepEqual([zero.rowH, zero.colW, zero.capacity], [22, 118, 2]);
  });

  test('F8 — the today marker is a per-day flag plus a per-column one', () => {
    const m = build({});
    assert.equal(dayOf(m, TODAY).isToday, true);
    assert.equal(dayOf(m, '2026-01-16').isToday, false);
    assert.equal(
      m.cols.reduce((n, c) => n + c.days.filter((d) => !d.empty && d.isToday).length, 0), 1);
    assert.equal(colOf(m, '2026-01').isTodayMonth, true);
    assert.equal(colOf(m, '2026-02').isTodayMonth, false);
    // today outside the visible window: no marker anywhere, board still builds
    const away = build({ settings: { startMonth: '2030-01' } }, '2026-01-15');
    assert.equal(away.cols.some((c) => c.isTodayMonth), false);
    assert.equal(
      away.cols.reduce((n, c) => n + c.days.filter((d) => !d.empty && d.isToday).length, 0), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1.3 / 1.5 — rolling vs pinned, and the year pager
// ═══════════════════════════════════════════════════════════════════════════

describe('1.3 / 1.5 · rolling, pinned, pageYears', () => {
  test('1.1/1.3 — rolling mode starts at TODAY\'s month, ignoring startMonth', () => {
    assert.deepEqual(L.visibleStart({ mode: 'rolling' }, '2026-08-25'), { y: 2026, m: 8 });
    assert.deepEqual(
      L.visibleStart({ mode: 'rolling', startMonth: '1999-03' }, '2026-08-25'),
      { y: 2026, m: 8 }, 'startMonth is dead state in rolling mode');
    const m = L.buildBoard(
      boardState({ settings: { mode: 'rolling', startMonth: '2020-05' } }),
      { today: '2026-08-25' });
    assert.equal(m.cols[0].key, '2026-08');
    assert.equal(m.firstISO, '2026-08-01');
  });

  test('1.5 — pageYears is a PINNED-mode control only; rolling ignores it', () => {
    // Matches the spec design note: "Paging controls only appear in pinned mode".
    assert.deepEqual(
      L.visibleStart({ mode: 'rolling', pageYears: 3 }, '2026-08-25'), { y: 2026, m: 8 });
    assert.deepEqual(
      L.visibleStart({ mode: 'rolling', pageYears: -3 }, '2026-08-25'), { y: 2026, m: 8 });
  });

  test('1.3 — pinned mode starts at settings.startMonth, wall clock irrelevant', () => {
    assert.deepEqual(
      L.visibleStart({ mode: 'pinned', startMonth: '2026-01', pageYears: 0 }, '2031-06-06'),
      { y: 2026, m: 1 });
    const m = build({ settings: { startMonth: '2026-01' } }, '2029-12-31');
    assert.equal(m.cols[0].key, '2026-01');
  });

  test('1.5 — paging shifts the window by whole YEARS, keeping the pinned month', () => {
    const at = (pageYears) =>
      L.visibleStart({ mode: 'pinned', startMonth: '2026-11', pageYears });
    assert.deepEqual(at(0), { y: 2026, m: 11 });
    assert.deepEqual(at(1), { y: 2027, m: 11 }, 'forward keeps November');
    assert.deepEqual(at(-1), { y: 2025, m: 11 }, 'back keeps November');
    assert.deepEqual(at(-2), { y: 2024, m: 11 });
    assert.deepEqual(at(10), { y: 2036, m: 11 });
    // a missing pageYears is 0, not NaN (layout.js:26)
    assert.deepEqual(
      L.visibleStart({ mode: 'pinned', startMonth: '2026-01' }), { y: 2026, m: 1 });
  });

  test('1.5 — paging back is how retained history (8.4) is reached', () => {
    const back = build({ settings: { pageYears: -2 } });
    assert.equal(back.cols[0].key, '2024-01');
    assert.equal(back.cols[11].key, '2024-12');
    assert.equal(back.firstISO, '2024-01-01');
    assert.equal(back.lastISO, '2024-12-31');
    // entries in the past are rendered, not dropped
    const withPast = build({
      settings: { pageYears: -2 },
      notes: [note('old', '2024-06-01', 'Rückblick')],
      layers: { feiertage: false },
    });
    assert.equal(dayOf(withPast, '2024-06-01').notes[0].note.text, 'Rückblick');
  });

  test('any mode string other than "pinned" is rolling (layout.js:24)', () => {
    assert.deepEqual(L.visibleStart({ mode: 'rollend' }, '2026-08-25'), { y: 2026, m: 8 });
    assert.deepEqual(L.visibleStart({}, '2026-08-25'), { y: 2026, m: 8 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Row capacity — the derived rule from DESIGN-DECISIONS §B
// ═══════════════════════════════════════════════════════════════════════════

describe('row capacity · clamp(floor((rowH-1)/10.5), 1, 3)', () => {
  test('the formula itself, sampled across the settings slider (18…32)', () => {
    const table = {
      18: 1, 19: 1, 20: 1, 21: 1,   // 21 is 1 line too — floor(20/10.5) = 1
      22: 2, 23: 2, 26: 2, 30: 2, 31: 2, 32: 2,
    };
    for (const [h, want] of Object.entries(table)) {
      assert.equal(L.rowCapacity(Number(h)), want, `rowCapacity(${h})`);
    }
  });

  test('DISCREPANCY — capacity 3 needs rowH ≥ 33, and the slider stops at 32', () => {
    // DESIGN-DECISIONS.md §B states "18–20 px → 1 line · 22–31 px → 2 lines ·
    // 32 px → 3". The FORMULA it prints is the one the code implements
    // (layout.js:19), but the derived table is off by one at the top:
    //   floor((32 - 1) / 10.5) = floor(2.95) = 2, not 3.
    // settings.js:142 caps the row-height slider at 32, so the 3-line row is
    // unreachable through the UI in shipped v1. That is a documentation bug,
    // not a spec-story violation (no numbered story mentions three lines), so
    // the CODE is what gets pinned here.
    assert.equal(L.rowCapacity(32), 2, 'DESIGN-DECISIONS says 3; the code says 2');
    assert.equal(L.rowCapacity(33), 3, 'first row height that actually holds 3 lines');
    assert.equal(L.rowCapacity(34), 3);
  });

  test('the clamp holds at both ends', () => {
    assert.equal(L.rowCapacity(0), 1);
    assert.equal(L.rowCapacity(-100), 1);
    assert.equal(L.rowCapacity(11), 1);
    assert.equal(L.rowCapacity(200), 3);
    assert.equal(L.rowCapacity(Number.MAX_SAFE_INTEGER), 3);
  });

  test('capacity reaches the model and drives how many notes a row shows', () => {
    const notes = [1, 2, 3, 4].map((i) => note(`n${i}`, '2026-03-10', `note ${i}`));
    for (const [rowHeight, cap] of [[18, 1], [20, 1], [22, 2], [26, 2], [32, 2]]) {
      const m = build({ notes, settings: { rowHeight }, layers: { feiertage: false } });
      assert.equal(m.capacity, cap, `rowHeight ${rowHeight}`);
      const d = dayOf(m, '2026-03-10');
      assert.equal(d.notes.length, cap, `rowHeight ${rowHeight} shown`);
      assert.equal(d.allNotes.length, 4, 'the full stack is always carried');
      assert.equal(d.overflow, 4 - cap, `rowHeight ${rowHeight} +n`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F2 — notes: multiplicity, overflow, truncation (2.3, 2.4, 2.5)
// ═══════════════════════════════════════════════════════════════════════════

describe('F2 · notes on a day', () => {
  test('2.3 — a day holds as many notes as you give it, in store order', () => {
    const notes = ['a', 'b', 'c'].map((x, i) => note(`n${i}`, '2026-03-10', x));
    const m = build({ notes, layers: { feiertage: false } });
    const d = dayOf(m, '2026-03-10');
    assert.deepEqual(d.allNotes.map((o) => o.note.text), ['a', 'b', 'c']);
    assert.deepEqual(d.notes.map((o) => o.note.text), ['a', 'b'], 'the first `capacity` win');
    // each entry carries the date it is rendered ON and its category colour,
    // so a repeat occurrence is addressable without re-deriving it.
    assert.ok(d.allNotes.every((o) => o.date === '2026-03-10'));
    assert.equal(d.notes[0].color, '#2A7CC0', 'cat-1 → blau');
  });

  test('2.4 — hidden notes become a "+n" count; nothing is silently dropped', () => {
    const notes = [1, 2, 3, 4, 5].map((i) => note(`n${i}`, '2026-03-10', `note ${i}`));
    const m = build({ notes, layers: { feiertage: false } });
    const d = dayOf(m, '2026-03-10');
    assert.equal(m.capacity, 2);
    assert.equal(d.notes.length, 2);
    assert.equal(d.allNotes.length, 5, 'the popover source is complete');
    assert.equal(d.overflow, 3);
    assert.equal(d.laneOverflow, 0, 'note overflow is not lane overflow');
    // and the identity survives: allNotes[i] is the same object shown or not
    assert.equal(d.notes[0].note, d.allNotes[0].note);
  });

  test('2.4 — a day that fits shows no badge at all', () => {
    const m = build({ notes: [note('n1', '2026-03-10', 'einer')], layers: { feiertage: false } });
    const d = dayOf(m, '2026-03-10');
    assert.equal(d.overflow, 0);
    assert.equal(d.notes.length, 1);
    // an untouched board never produces a badge anywhere
    const empty = build({ layers: { feiertage: false } });
    assert.ok(empty.cols.every((c) => c.days.every((x) => x.empty || x.overflow === 0)));
  });

  test('2.4 — note overflow and lane overflow ADD UP into one badge', () => {
    // This is the number board.js prints as "+n" (board.js:102). It is the sum
    // of "notes I could not show" and "bars I could not draw", which is why the
    // tooltip only says "lanes full" when the badge is PURELY lane overflow.
    const m = build({
      notes: [1, 2, 3].map((i) => note(`n${i}`, '2026-01-10', `n${i}`)),
      bars: ['A', 'B', 'C', 'D'].map((l, i) =>
        bar(`b${i}`, '2026-01-05', '2026-01-20', l)),
      layers: { feiertage: false },
    });
    const d = dayOf(m, '2026-01-10');
    assert.equal(d.notes.length, 2);
    assert.equal(d.allNotes.length, 3);
    assert.equal(d.laneOverflow, 1, 'the 4th bar');
    assert.equal(d.overflow, 2, '1 hidden note + 1 hidden bar');
  });

  test('2.5 — layout.js does NOT truncate; length is a presentation concern', () => {
    // The ~80-char cap is enforced where text is ENTERED (interact.js:466,
    // popover.js:146/:259 set maxLength = 80; bar labels 40 at interact.js:589)
    // and the visual ellipsis is CSS (app.css text-overflow). The model carries
    // the string verbatim so board.js can put the full text in `title`
    // (board.js:124) — "full text on hover" is only possible because of this.
    // A longer string can therefore reach the model via import/hand-edited JSON,
    // and v1 renders it rather than cutting it.
    const long = 'x'.repeat(300);
    const m = build({ notes: [note('n1', '2026-04-01', long)], layers: { feiertage: false } });
    assert.equal(dayOf(m, '2026-04-01').notes[0].note.text.length, 300);
    assert.equal(dayOf(m, '2026-04-01').notes[0].note.text, long);
  });

  test('an empty-text note still occupies a slot (it is a real entry)', () => {
    const m = build({
      notes: [note('n1', '2026-04-01', ''), note('n2', '2026-04-01', 'zwei'),
              note('n3', '2026-04-01', 'drei')],
      layers: { feiertage: false },
    });
    const d = dayOf(m, '2026-04-01');
    assert.equal(d.notes.length, 2);
    assert.equal(d.notes[0].note.text, '');
    assert.equal(d.overflow, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F3 — bars: lanes, month split, horizon, labels (3.2, 3.4, 3.6, 3.7, 3.8)
// ═══════════════════════════════════════════════════════════════════════════

describe('F3 · lane assignment is GLOBAL (3.4)', () => {
  test('first fit: the lowest lane whose occupants do not overlap', () => {
    const lanes = L.assignLanes([
      bar('b1', '2026-01-05', '2026-01-10', 'A'),
      bar('b2', '2026-01-20', '2026-01-25', 'B'), // no clash with A → lane 0
      bar('b3', '2026-01-07', '2026-01-09', 'C'), // clashes with A → lane 1
    ]);
    assert.equal(lanes.get('b1'), 0);
    assert.equal(lanes.get('b2'), 0);
    assert.equal(lanes.get('b3'), 1);
  });

  test('overlap is INCLUSIVE — sharing one day is a clash, touching-by-a-day is not', () => {
    const shared = L.assignLanes([
      bar('a', '2026-01-01', '2026-01-10', 'x'),
      bar('b', '2026-01-10', '2026-01-20', 'y'), // same day 10 → clash
    ]);
    assert.deepEqual([shared.get('a'), shared.get('b')], [0, 1]);
    const abut = L.assignLanes([
      bar('a', '2026-01-01', '2026-01-10', 'x'),
      bar('b', '2026-01-11', '2026-01-20', 'y'), // next day → no clash
    ]);
    assert.deepEqual([abut.get('a'), abut.get('b')], [0, 0]);
  });

  test('the sweep order is start asc, then LONGER first, then id asc', () => {
    // Deterministic tie-breaks are what make lanes reproducible across a
    // rebuild — the property the op-log retrofit must not lose.
    const longer = L.assignLanes([
      bar('zz', '2026-01-01', '2026-01-05', 'short'),
      bar('aa', '2026-01-01', '2026-01-20', 'long'),
    ]);
    assert.deepEqual([longer.get('aa'), longer.get('zz')], [0, 1], 'longer takes lane 0');
    const byId = L.assignLanes([
      bar('zz', '2026-01-01', '2026-01-05', 'z'),
      bar('aa', '2026-01-01', '2026-01-05', 'a'),
    ]);
    assert.deepEqual([byId.get('aa'), byId.get('zz')], [0, 1], 'identical ranges → id order');
    // …and the result does not depend on the order the bars arrive in
    const shuffled = L.assignLanes([
      bar('aa', '2026-01-01', '2026-01-05', 'a'),
      bar('zz', '2026-01-01', '2026-01-05', 'z'),
    ]);
    assert.deepEqual([...shuffled.entries()].sort(), [...byId.entries()].sort());
  });

  test('assignLanes itself is UNBOUNDED — the cap of 3 is applied later', () => {
    const lanes = L.assignLanes(
      [1, 2, 3, 4, 5].map((i) => bar(`b${i}`, '2026-01-01', '2026-01-31', `B${i}`)));
    assert.deepEqual([...lanes.values()], [0, 1, 2, 3, 4]);
    assert.equal(L.MAX_LANES, 3);
  });

  test('assignLanes does not mutate or reorder its input', () => {
    const bars = [
      bar('b2', '2026-02-01', '2026-02-05', 'B'),
      bar('b1', '2026-01-01', '2026-01-05', 'A'),
    ];
    const before = JSON.parse(JSON.stringify(bars));
    L.assignLanes(bars);
    assert.deepEqual(bars, before);
    assert.equal(bars[0].id, 'b2', 'the caller\'s array keeps its order');
  });

  test('an empty timeline yields an empty lane map', () => {
    assert.equal(L.assignLanes([]).size, 0);
  });

  test('3.4 — overlapping bars land in DIFFERENT lanes on the shared days', () => {
    const m = build({ bars: [
      bar('b1', '2026-03-01', '2026-03-20', 'Projekt'),
      bar('b2', '2026-03-10', '2026-03-25', 'Urlaub'),
    ] });
    const segs = colOf(m, '2026-03').segs;
    assert.equal(segs.length, 2);
    assert.notEqual(segs[0].lane, segs[1].lane);
    assert.deepEqual(laneMap(colOf(m, '2026-03')), ['Projekt:0', 'Urlaub:1']);
  });

  test('3.4 — a lane is REUSED once it is free again', () => {
    const m = build({ bars: [
      bar('b1', '2026-03-01', '2026-03-10', 'erst'),
      bar('b2', '2026-03-15', '2026-03-25', 'dann'),
    ] });
    assert.deepEqual(laneMap(colOf(m, '2026-03')), ['erst:0', 'dann:0']);
  });

  test('lanes are global, so a bar keeps its lane across month boundaries (3.2)', () => {
    const m = build({ bars: [
      bar('b1', '2026-01-20', '2026-03-10', 'A'),
      bar('b2', '2026-01-05', '2026-02-05', 'B'),
    ] });
    const laneIn = (k, id) => colOf(m, k).segs.find((s) => s.bar.id === id).lane;
    assert.equal(laneIn('2026-01', 'b1'), laneIn('2026-02', 'b1'));
    assert.equal(laneIn('2026-02', 'b1'), laneIn('2026-03', 'b1'));
    // even though B disappears after February, A does not slide into lane 0
    assert.equal(laneIn('2026-03', 'b1'), laneIn('2026-01', 'b1'));
  });

  test('segments come out sorted by lane, then by start row', () => {
    const m = build({ bars: [
      bar('b1', '2026-05-20', '2026-05-25', 'late-lane0'),
      bar('b2', '2026-05-01', '2026-05-10', 'early-lane0'),
      bar('b3', '2026-05-05', '2026-05-08', 'lane1'),
    ] });
    const segs = colOf(m, '2026-05').segs;
    assert.deepEqual(laneMap(colOf(m, '2026-05')),
      ['early-lane0:0', 'late-lane0:0', 'lane1:1']);
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1]; const b = segs[i];
      assert.ok(a.lane < b.lane || (a.lane === b.lane && a.topRow <= b.topRow));
    }
  });
});

describe('F3 · month-segment geometry (3.2)', () => {
  test('a bar is clipped to each month and flags its continuations', () => {
    const m = build({ bars: [bar('b1', '2026-01-20', '2026-03-10', 'Q1')] });
    const jan = colOf(m, '2026-01').segs[0];
    const feb = colOf(m, '2026-02').segs[0];
    const mar = colOf(m, '2026-03').segs[0];
    assert.deepEqual([jan.startDay, jan.endDay, jan.rows, jan.contTop, jan.contBot],
      [20, 31, 12, false, true]);
    assert.deepEqual([feb.startDay, feb.endDay, feb.rows, feb.contTop, feb.contBot],
      [1, 28, 28, true, true]);
    assert.deepEqual([mar.startDay, mar.endDay, mar.rows, mar.contTop, mar.contBot],
      [1, 10, 10, true, false]);
    assert.equal(jan.topRow, 19, 'topRow is 0-based: day 20 → row 19');
    assert.equal(feb.topRow, 0);
    // no segment in the months it does not touch
    assert.equal(colOf(m, '2026-04').segs.length, 0);
    assert.equal(colOf(m, '2025-12'), undefined);
  });

  test('3.2 — the split segments are ONE entry: same object, not copies', () => {
    // "edit either part edits the whole" is only true because every segment
    // points at the identical bar record. The op-log retrofit must preserve
    // this or F5 edits will silently apply to one month only.
    const src = bar('b1', '2026-02-10', '2026-05-20', 'Projekt');
    const m = build({ bars: [src] });
    const touched = m.cols.filter((c) => c.segs.length);
    assert.deepEqual(touched.map((c) => c.key),
      ['2026-02', '2026-03', '2026-04', '2026-05']);
    for (const c of touched) {
      assert.equal(c.segs[0].bar, src, `${c.key} shares the record`);
      assert.equal(c.segs[0].bar.label, 'Projekt');
      assert.equal(c.segs[0].color, '#2A7CC0', 'and the same colour');
    }
  });

  test('3.2 — an interior month is a full-height segment continued at both ends', () => {
    const m = build({ bars: [bar('b1', '2026-02-10', '2026-05-20', 'Projekt')] });
    const mar = colOf(m, '2026-03').segs[0];
    assert.deepEqual([mar.startDay, mar.endDay, mar.rows, mar.topRow], [1, 31, 31, 0]);
    assert.deepEqual([mar.contTop, mar.contBot], [true, true]);
    const apr = colOf(m, '2026-04').segs[0];
    assert.equal(apr.rows, 30, 'April is 30 rows, not 31 — clipped to the month');
  });

  test('a single-day bar is one row, not continued anywhere', () => {
    const m = build({ bars: [bar('b1', '2026-03-10', '2026-03-10', 'ein Tag')] });
    const segs = m.cols.filter((c) => c.segs.length);
    assert.equal(segs.length, 1);
    const s = segs[0].segs[0];
    assert.deepEqual([s.startDay, s.endDay, s.rows, s.topRow], [10, 10, 1, 9]);
    assert.deepEqual([s.contTop, s.contBot], [false, false]);
  });

  test('a bar ending on the last day of a short month is not continued', () => {
    const m = build({ bars: [bar('b1', '2026-02-20', '2026-02-28', 'Feb')] });
    const s = colOf(m, '2026-02').segs[0];
    assert.deepEqual([s.endDay, s.rows, s.contBot], [28, 9, false]);
    assert.equal(colOf(m, '2026-03').segs.length, 0);
  });

  test('a bar entirely outside the window produces no segments at all', () => {
    const m = build({ bars: [
      bar('past', '2020-01-01', '2020-02-01', 'alt'),
      bar('future', '2031-01-01', '2031-02-01', 'später'),
    ] });
    assert.equal(m.cols.reduce((n, c) => n + c.segs.length, 0), 0);
    assert.ok(m.cols.every((c) => c.days.every((d) => d.empty || d.laneOverflow === 0)));
  });

  test('a bar covering the whole window appears in all twelve columns', () => {
    const m = build({ bars: [bar('b', '2020-01-01', '2030-01-01', 'ewig')] });
    assert.equal(m.cols.filter((c) => c.segs.length === 1).length, 12);
    assert.deepEqual(
      m.cols.map((c) => c.segs[0].rows),
      [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31], 'each clipped to its month');
  });
});

describe('F3 · horizon cues, both directions (3.6)', () => {
  test('a bar past the far horizon is flagged on the LAST column only', () => {
    const m = build({ bars: [bar('b1', '2026-06-01', '2027-03-01', 'lang')] });
    assert.equal(colOf(m, '2026-12').segs[0].beyondEnd, true);
    assert.equal(colOf(m, '2026-12').segs[0].contBot, true);
    assert.equal(colOf(m, '2026-12').horizon, true, 'the column footer cue');
    for (const k of ['2026-06', '2026-07', '2026-11']) {
      assert.equal(colOf(m, k).segs[0].beyondEnd, false, `${k} beyondEnd`);
      assert.equal(colOf(m, k).horizon, false, `${k} horizon`);
    }
  });

  test('MIRRORED — a bar that began before the window is flagged on the FIRST column', () => {
    const m = build({ bars: [bar('b1', '2025-11-01', '2026-04-10', 'begann früher')] });
    const jan = colOf(m, '2026-01').segs[0];
    assert.equal(jan.beyondStart, true);
    assert.equal(jan.contTop, true, 'and it reads as a continuation too');
    assert.equal(jan.startDay, 1);
    assert.equal(jan.topRow, 0);
    for (const k of ['2026-02', '2026-03', '2026-04']) {
      assert.equal(colOf(m, k).segs[0].beyondStart, false, `${k}`);
    }
  });

  test('both cues at once on a bar that outlives the window in both directions', () => {
    const m = build({ bars: [bar('b1', '2025-11-01', '2027-03-01', 'Dauerläufer')] });
    const first = colOf(m, '2026-01').segs[0];
    const last = colOf(m, '2026-12').segs[0];
    assert.deepEqual([first.beyondStart, first.beyondEnd], [true, false]);
    assert.deepEqual([last.beyondStart, last.beyondEnd], [false, true]);
    assert.equal(colOf(m, '2026-06').segs[0].beyondStart, false);
    assert.equal(colOf(m, '2026-06').segs[0].beyondEnd, false);
    assert.deepEqual(m.cols.map((c) => c.horizon),
      [...Array(11).fill(false), true]);
  });

  test('the horizon test is STRICT — starting/ending exactly at the edge is not "beyond"', () => {
    const m = build({ bars: [bar('b1', '2026-01-01', '2026-12-31', 'genau')] });
    const first = colOf(m, '2026-01').segs[0];
    const last = colOf(m, '2026-12').segs[0];
    assert.equal(first.beyondStart, false, 'starts ON firstISO');
    assert.equal(first.contTop, false);
    assert.equal(last.beyondEnd, false, 'ends ON lastISO');
    assert.equal(last.contBot, false);
    assert.equal(colOf(m, '2026-12').horizon, false);
  });

  test('the cue rides with the window — the same bar loses it after paging', () => {
    // "grows back into view as the board rolls" (3.6): the flag is a property of
    // the VIEW, not of the bar.
    const bars = [bar('b1', '2026-06-01', '2027-03-01', 'lang')];
    const now = build({ bars });
    assert.equal(colOf(now, '2026-12').horizon, true);
    const paged = build({ bars, settings: { pageYears: 1 } });
    assert.equal(paged.cols[0].key, '2027-01');
    assert.equal(colOf(paged, '2027-01').segs[0].beyondStart, true, 'now it began earlier');
    assert.equal(paged.cols.some((c) => c.horizon), false, 'and no longer runs off the end');
  });

  test('col.horizon reports the far end only; the near end lives on the segment', () => {
    // DESIGN-DECISIONS §C promises the ↑ cue is mirrored — board.js:171 draws it
    // from seg.beyondStart. There is deliberately no `col.horizonStart`: the
    // "läuft weiter →" footer only exists at the right-hand edge of time.
    const m = build({ bars: [bar('b1', '2025-06-01', '2026-04-01', 'nur früh')] });
    assert.equal(m.cols.some((c) => c.horizon), false);
    assert.equal(colOf(m, '2026-01').segs[0].beyondStart, true);
    assert.equal(Object.prototype.hasOwnProperty.call(colOf(m, '2026-01'), 'horizonStart'),
      false);
  });
});

describe('F3 · label placement (3.3, 3.7)', () => {
  test('3.7 — one label row per MONTH SEGMENT, so a long stripe stays labelled', () => {
    const m = build({ bars: [bar('b1', '2026-02-10', '2026-05-20', 'Projekt')] });
    const touched = m.cols.filter((c) => c.segs.length);
    assert.equal(touched.length, 4);
    for (const c of touched) {
      assert.equal(typeof c.segs[0].labelRow, 'number', `${c.key} has exactly one label row`);
      assert.ok(c.segs[0].labelRow >= c.segs[0].topRow, `${c.key} label inside the segment`);
      assert.ok(c.segs[0].labelRow < c.segs[0].topRow + c.segs[0].rows, `${c.key} label in range`);
    }
    assert.equal(colOf(m, '2026-02').segs[0].labelRow, 9, 'first row of the segment: 10 Feb');
  });

  test('3.7 — the label scans for a row with NO ink and skips notes', () => {
    const m = build({
      bars: [bar('b1', '2026-03-02', '2026-03-20', 'Sprint')],
      notes: [note('n1', '2026-03-02', 'belegt')],
      layers: { feiertage: false },
    });
    const seg = colOf(m, '2026-03').segs[0];
    assert.equal(seg.topRow, 1);     // 2 March
    assert.equal(seg.labelRow, 2);   // pushed off the row that carries the note
  });

  test('3.7 — a holiday row counts as ink and is skipped too', () => {
    // 1 May 2026 (Tag der Arbeit) is nationwide, so it is shown by default.
    const m = build({ bars: [bar('b1', '2026-05-01', '2026-05-20', 'Mai')] });
    const seg = colOf(m, '2026-05').segs[0];
    assert.equal(dayOf(m, '2026-05-01').holidayShown, true);
    assert.equal(seg.topRow, 0);
    assert.equal(seg.labelRow, 1, 'skipped past the holiday text');
  });

  test('3.7 — an existing "+n" badge also counts as ink', () => {
    const m = build({
      bars: [bar('b1', '2026-03-01', '2026-03-20', 'Sprint')],
      notes: [1, 2, 3].map((i) => note(`n${i}`, '2026-03-01', `n${i}`)),
      layers: { feiertage: false },
    });
    assert.equal(dayOf(m, '2026-03-01').overflow, 1);
    assert.equal(colOf(m, '2026-03').segs[0].labelRow, 1);
  });

  test('3.7 — the scan gives up after SIX rows and falls back to the segment top', () => {
    const m = build({
      bars: [bar('b1', '2026-03-01', '2026-03-20', 'Sprint')],
      notes: [1, 2, 3, 4, 5, 6, 7].map((i) => note(`n${i}`, `2026-03-0${i}`, 'x')),
      layers: { feiertage: false },
    });
    // rows 0–5 (1–6 March) all carry a note; the 7th free row is out of scan range
    assert.equal(colOf(m, '2026-03').segs[0].labelRow, 0, 'falls back to topRow');
  });

  test('3.7 — the scan window is min(segment length, 6): a short segment cannot escape', () => {
    const m = build({
      bars: [bar('b1', '2026-03-05', '2026-03-06', 'kurz')],
      notes: [note('n1', '2026-03-05', 'a'), note('n2', '2026-03-06', 'b')],
      layers: { feiertage: false },
    });
    const seg = colOf(m, '2026-03').segs[0];
    assert.equal(seg.topRow, 4);
    assert.equal(seg.labelRow, 4, 'both its rows are inked → back to topRow');
  });

  test('3.7 — two segments in the same column never share a label row, even across lanes', () => {
    // usedLabelRows is per COLUMN, not per lane (layout.js:235), because the
    // chips are laid out horizontally next to each other and would collide.
    const m = build({
      bars: [
        bar('b1', '2026-03-01', '2026-03-20', 'A'),
        bar('b2', '2026-03-01', '2026-03-20', 'B'),
        bar('b3', '2026-03-01', '2026-03-20', 'C'),
      ],
      layers: { feiertage: false },
    });
    const segs = colOf(m, '2026-03').segs;
    assert.deepEqual(segs.map((s) => `${s.bar.label}:${s.lane}:${s.labelRow}`),
      ['A:0:0', 'B:1:1', 'C:2:2']);
    assert.equal(new Set(segs.map((s) => s.labelRow)).size, 3);
  });

  test('3.3 — the label text itself is never touched by layout (empty stays empty)', () => {
    // board.js:156 substitutes the i18n "untitledBar" placeholder at render
    // time; the model keeps the truth.
    const m = build({ bars: [bar('b1', '2026-03-01', '2026-03-05', '')] });
    assert.equal(colOf(m, '2026-03').segs[0].bar.label, '');
  });
});

describe('F3 · the lane cap and its rescue (3.8)', () => {
  test('a fourth overlapping bar is counted, not drawn', () => {
    const bars = [
      bar('b1', '2026-01-05', '2026-06-30', 'A'),
      bar('b2', '2026-01-05', '2026-06-30', 'B'),
      bar('b3', '2026-01-05', '2026-06-30', 'C'),
      bar('b4', '2026-01-10', '2026-07-20', 'D'),
    ];
    assert.equal(L.assignLanes(bars).get('b4'), 3, 'globally it lost the lottery');
    const m = build({ bars, layers: { feiertage: false } });
    const jan = colOf(m, '2026-01');
    assert.deepEqual(jan.segs.map((s) => s.bar.label), ['A', 'B', 'C']);
    assert.equal(jan.days[11].laneOverflow, 1, '12 Jan: D is hidden here');
    assert.equal(jan.days[11].overflow, 1, 'and it shows as +1');
    assert.equal(jan.days[4].laneOverflow, 0, '5 Jan: D has not started yet');
    assert.equal(jan.days[8].laneOverflow, 0, '9 Jan: still before D');
    assert.equal(jan.days[9].laneOverflow, 1, '10 Jan: D starts');
  });

  test('3.8 — the cap counts PER DAY: only the covered days carry the badge', () => {
    const m = build({
      bars: [
        bar('b1', '2026-03-01', '2026-03-31', 'A'),
        bar('b2', '2026-03-01', '2026-03-31', 'B'),
        bar('b3', '2026-03-01', '2026-03-31', 'C'),
        bar('b4', '2026-03-10', '2026-03-12', 'D'),
      ],
      layers: { feiertage: false },
    });
    const mar = colOf(m, '2026-03');
    assert.equal(mar.segs.length, 3);
    assert.deepEqual(
      mar.days.filter((d) => d.laneOverflow > 0).map((d) => d.date),
      ['2026-03-10', '2026-03-11', '2026-03-12']);
    assert.ok(mar.days.filter((d) => d.laneOverflow > 0).every((d) => d.laneOverflow === 1));
  });

  test('3.8 — two hidden bars on the same day make it "+2"', () => {
    const m = build({
      bars: [1, 2, 3, 4, 5].map((i) => bar(`b${i}`, '2026-03-01', '2026-03-31', `B${i}`)),
      layers: { feiertage: false },
    });
    const mar = colOf(m, '2026-03');
    assert.equal(mar.segs.length, 3, 'only three lanes are ever drawn');
    assert.ok(mar.days.filter((d) => !d.empty).every((d) => d.laneOverflow === 2));
    assert.ok(mar.days.filter((d) => !d.empty).every((d) => d.overflow === 2));
  });

  test('LANE RESCUE (DESIGN-DECISIONS §C) — an overflowed bar reclaims a free base lane', () => {
    const m = build({ bars: [
      bar('b1', '2026-01-05', '2026-06-30', 'A'),
      bar('b2', '2026-01-05', '2026-06-30', 'B'),
      bar('b3', '2026-01-05', '2026-06-30', 'C'),
      bar('b4', '2026-01-10', '2026-07-20', 'D'),
    ] });
    // June: all three base lanes are still occupied → D stays hidden.
    assert.equal(colOf(m, '2026-06').segs.some((s) => s.bar.id === 'b4'), false);
    assert.equal(colOf(m, '2026-06').days[10].laneOverflow, 1);
    // July: A/B/C have ended → D is rescued into lane 0 and drawn.
    const jul = colOf(m, '2026-07');
    assert.deepEqual(laneMap(jul), ['D:0']);
    assert.equal(jul.days[10].laneOverflow, 0);
  });

  test('RESCUE — a rescued bar may sit in DIFFERENT lanes in different months', () => {
    // "visible beats stable" — the explicit trade in DESIGN-DECISIONS §C /
    // the 2026-08-01 audit. This is the one place lanes are NOT stable, and it
    // is on purpose.
    const bars = [
      bar('a1', '2026-01-01', '2026-02-28', 'A'),
      bar('a2', '2026-01-01', '2026-02-28', 'B'),
      bar('a3', '2026-01-01', '2026-01-31', 'C'),
      bar('a4', '2026-01-05', '2026-03-31', 'D'),
    ];
    assert.equal(L.assignLanes(bars).get('a4'), 3, 'D is globally over the cap');
    const m = build({ bars });
    assert.deepEqual(laneMap(colOf(m, '2026-01')), ['A:0', 'B:1', 'C:2'], 'D hidden');
    assert.deepEqual(laneMap(colOf(m, '2026-02')), ['A:0', 'B:1', 'D:2'], 'C gone → D rescued');
    assert.deepEqual(laneMap(colOf(m, '2026-03')), ['D:0'], 'alone → lane 0');
  });

  test('RESCUE — the free lane must be free across the WHOLE segment, not part of it', () => {
    const m = build({ bars: [
      bar('b1', '2026-01-01', '2026-01-31', 'A'),
      bar('b2', '2026-01-01', '2026-01-31', 'B'),
      bar('b3', '2026-01-01', '2026-01-15', 'C'),  // lane 2 frees up after 15 Jan
      bar('b4', '2026-01-10', '2026-01-25', 'D'),  // overlaps C → no rescue
    ], layers: { feiertage: false } });
    const jan = colOf(m, '2026-01');
    assert.deepEqual(laneMap(jan), ['A:0', 'B:1', 'C:2'], 'D is not drawn at all');
    // …and it is counted on every one of its own days, including the ones where
    // lane 2 would have been free (16–25 Jan). The cap is evaluated for the
    // segment, so the badge covers the segment.
    assert.deepEqual(
      jan.days.filter((d) => d.laneOverflow > 0).map((d) => d.row),
      Array.from({ length: 16 }, (_, i) => 9 + i), '10–25 Jan');
  });

  test('RESCUE — only ONE of two competitors takes the freed lane', () => {
    // A bar can never be rescued in the column where it STARTS: every lane-0..2
    // interval that pushed it over the cap starts no later than it does (the
    // sweep is start-ordered), so that interval necessarily also covers its
    // segment in its own starting month. Rescue therefore only happens in
    // later columns — where every candidate segment begins on day 1. The
    // `overflowSegs.sort(by startDay)` at layout.js:162 is consequently a
    // no-op for real candidates, and the winner is decided by the order the
    // bars sit in `state.bars`.
    const mk = (bars) => L.buildBoard(
      boardState({ bars, layers: { feiertage: false } }), { today: TODAY });
    const A = bar('a', '2026-01-01', '2026-12-31', 'A');
    const B = bar('b', '2026-01-01', '2026-12-31', 'B');
    const C = bar('c', '2026-01-01', '2026-02-28', 'C'); // frees lane 2 in March
    const D = bar('d', '2026-01-05', '2026-03-31', 'D');
    const E = bar('e', '2026-01-06', '2026-03-31', 'E');
    assert.deepEqual([...L.assignLanes([A, B, C, D, E]).values()], [0, 1, 2, 3, 4]);

    const de = colOf(mk([A, B, C, D, E]), '2026-03');
    assert.deepEqual(laneMap(de), ['A:0', 'B:1', 'D:2'], 'first in store order wins');
    assert.equal(de.days[0].laneOverflow, 1, 'the loser is still counted, all month');
    assert.equal(de.days[30].laneOverflow, 1);

    // ORDER-SENSITIVE (flagged for LZP-402): reordering the store swaps the
    // winner. Nothing is lost either way — exactly one is drawn, the other is
    // one "+n" — but the identity of the drawn bar is not order-independent.
    const ed = colOf(mk([A, B, C, E, D]), '2026-03');
    assert.deepEqual(laneMap(ed), ['A:0', 'B:1', 'E:2']);
    assert.equal(ed.days[0].laneOverflow, 1);
  });

  test('RESCUE — nothing happens where the base lanes stay full', () => {
    const m = build({ bars: [
      bar('a', '2026-01-01', '2026-12-31', 'A'),
      bar('b', '2026-01-01', '2026-12-31', 'B'),
      bar('c', '2026-01-01', '2026-02-28', 'C'),
      bar('d', '2026-01-05', '2026-03-31', 'D'),
    ], layers: { feiertage: false } });
    for (const k of ['2026-01', '2026-02']) {
      assert.deepEqual(laneMap(colOf(m, k)), ['A:0', 'B:1', 'C:2'], k);
      assert.equal(colOf(m, k).days[5].laneOverflow, 1, `${k} D is counted`);
    }
    assert.deepEqual(laneMap(colOf(m, '2026-03')), ['A:0', 'B:1', 'D:2'], 'rescued');
    assert.equal(colOf(m, '2026-03').days[5].laneOverflow, 0);
  });

  test('3.8 — a bar hidden in one column is still a first-class entry elsewhere', () => {
    const src = bar('b4', '2026-01-10', '2026-07-20', 'D');
    const m = build({ bars: [
      bar('b1', '2026-01-05', '2026-06-30', 'A'),
      bar('b2', '2026-01-05', '2026-06-30', 'B'),
      bar('b3', '2026-01-05', '2026-06-30', 'C'),
      src,
    ] });
    assert.equal(colOf(m, '2026-07').segs[0].bar, src, 'same record, not a copy');
    assert.equal(colOf(m, '2026-07').segs[0].beyondEnd, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3.5 — up-drag normalization: where it lives, and what layout assumes
// ═══════════════════════════════════════════════════════════════════════════

describe('3.5 · normalization is a GESTURE concern, not a layout one', () => {
  test('the normalizing swap lives in interact.js, and layout trusts its output', () => {
    // interact.js:263 — `const [a, b] = drag.anchor <= date ? [drag.anchor, date]
    //                                                      : [date, drag.anchor]`
    // and the resize path clamps each edge past the other (interact.js:288-289).
    // Both are pointer-driven and are exercised in tests/tier2/interaction.dom.js.
    // layout.js has no equivalent guard, so this pins the CONTRACT: v1 only ever
    // stores startDate <= endDate. A bar built the normal way round is ordinary.
    const m = build({ bars: [bar('b', '2026-03-10', '2026-03-20', 'normal')] });
    const s = colOf(m, '2026-03').segs[0];
    assert.deepEqual([s.startDay, s.endDay, s.rows], [10, 20, 11]);
    assert.ok(s.bar.startDate <= s.bar.endDate);
  });

  test('an INVERTED bar (end before start) is rendered degenerately, not rejected', () => {
    // Defensive characterization. v1's UI cannot produce this, but a
    // hand-edited or imported board can, and store.migrate() does not repair
    // date order (store.js:82-88 only repairs category references). Pinning the
    // current shape means the op-log retrofit cannot start emitting inverted
    // ranges without this test noticing.
    const m = build({ bars: [bar('x', '2026-03-20', '2026-03-10', 'rückwärts')] });
    const s = colOf(m, '2026-03').segs[0];
    assert.equal(s.startDay, 20);
    assert.equal(s.endDay, 10);
    assert.equal(s.rows, -9, 'a negative height — v1 does NOT clamp this');
    assert.equal(s.topRow, 19);
    assert.equal(s.labelRow, 19, 'the label scan collapses to topRow');
    assert.equal(s.contTop, false);
    assert.equal(s.contBot, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F6/F7 layers as they reach the layout model — the capacity interaction
// ═══════════════════════════════════════════════════════════════════════════

describe('layers × capacity', () => {
  test('HOLIDAY DEMOTION (DESIGN-DECISIONS §B challenge 2): the note wins a 1-line row', () => {
    const notes = [note('n1', '2026-01-01', 'Silvesterkater')];
    const cramped = build({ notes, settings: { rowHeight: 18, bundesland: 'BY' } });
    const d1 = dayOf(cramped, '2026-01-01');
    assert.equal(cramped.capacity, 1);
    assert.equal(d1.holidayShown, false);
    assert.equal(d1.holidayDemoted, true);
    assert.equal(d1.notes.length, 1);
    assert.equal(d1.overflow, 0, 'demotion is not overflow — nothing was dropped');
    assert.equal(d1.holiday.short, 'Neujahr', 'still present for the tooltip + dot');

    // With two lines both fit and the holiday keeps its line.
    const roomy = build({ notes, settings: { rowHeight: 22, bundesland: 'BY' } });
    const d2 = dayOf(roomy, '2026-01-01');
    assert.equal(d2.holidayShown, true);
    assert.equal(d2.holidayDemoted, false);
    assert.equal(d2.notes.length, 1);

    // A 1-line row with no note keeps the holiday.
    const alone = build({ settings: { rowHeight: 18, bundesland: 'BY' } });
    const d3 = dayOf(alone, '2026-01-01');
    assert.equal(d3.holidayShown, true);
    assert.equal(d3.holidayDemoted, false);
  });

  test('demotion never costs a note slot: capacity 1 + holiday + 3 notes shows 1, +2', () => {
    const m = build({
      notes: [1, 2, 3].map((i) => note(`n${i}`, '2026-01-01', `n${i}`)),
      settings: { rowHeight: 18, bundesland: 'BY' },
    });
    const d = dayOf(m, '2026-01-01');
    assert.equal(d.holidayDemoted, true);
    assert.equal(d.notes.length, 1);
    assert.equal(d.overflow, 2);
  });

  test('a shown holiday DOES cost a note slot at capacity 2', () => {
    const m = build({
      notes: [1, 2, 3].map((i) => note(`n${i}`, '2026-01-01', `n${i}`)),
      settings: { rowHeight: 22, bundesland: 'BY' },
    });
    const d = dayOf(m, '2026-01-01');
    assert.equal(d.holidayShown, true);
    assert.equal(d.notes.length, 1, 'line 1 is the holiday, line 2 the first note');
    assert.equal(d.overflow, 2);
  });

  test('the Feiertage layer gates the holiday index entirely', () => {
    const on = build({ settings: { bundesland: 'BY' } });
    assert.notEqual(dayOf(on, '2026-01-01').holiday, null);
    const off = build({ settings: { bundesland: 'BY' }, layers: { feiertage: false } });
    assert.equal(dayOf(off, '2026-01-01').holiday, null);
    assert.equal(dayOf(off, '2026-01-01').holidayShown, false);
    assert.equal(dayOf(off, '2026-01-01').holidayDemoted, false);
    // and with it off, that row is free for a bar label again
    const labelled = build({
      bars: [bar('b1', '2026-05-01', '2026-05-20', 'Mai')],
      layers: { feiertage: false },
    });
    assert.equal(colOf(labelled, '2026-05').segs[0].labelRow, 0);
  });

  test('another state\'s holiday shows only with the otherStates layer (6.6)', () => {
    const plain = build({ settings: { bundesland: 'BY' } });
    assert.equal(dayOf(plain, '2026-10-31').holiday, null); // Reformationstag, not BY
    const dimmed = build({ settings: { bundesland: 'BY' }, layers: { otherStates: true } });
    const d = dayOf(dimmed, '2026-10-31');
    assert.equal(d.holiday.name, 'Reformationstag');
    assert.equal(d.holiday.own, false);
    assert.equal(d.holidayShown, true);
  });

  test('Schulferien need both the layer AND a Bundesland (7.5)', () => {
    const neither = build({ settings: { bundesland: 'BY' } });
    assert.equal(dayOf(neither, '2026-08-10').ferien, false);
    const noState = build({ settings: { bundesland: '' }, layers: { schulferien: true } });
    assert.equal(dayOf(noState, '2026-08-10').ferien, false);
    const both = build({ settings: { bundesland: 'BY' }, layers: { schulferien: true } });
    const d = dayOf(both, '2026-08-10');
    assert.equal(d.ferien, true);
    assert.equal(d.ferienName, 'Sommerferien');
  });

  test('Ferien shading is ambient only — it never consumes a text line', () => {
    const m = build({
      notes: [note('n1', '2026-08-10', 'Strand'), note('n2', '2026-08-10', 'Buch')],
      settings: { bundesland: 'BY' },
      layers: { schulferien: true, feiertage: false },
    });
    const d = dayOf(m, '2026-08-10');
    assert.equal(d.ferien, true);
    assert.equal(d.notes.length, 2, 'full capacity still available');
    assert.equal(d.overflow, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F9 yearly repeats, F4 category visibility, F10 scratchpads — the remaining
// inputs the board model consumes.
// ═══════════════════════════════════════════════════════════════════════════

describe('F9 · yearly repeats inside the window', () => {
  test('a yearly note projects into every visible year from its anchor onward', () => {
    const m = L.buildBoard(
      boardState({ notes: [note('r1', '2026-05-04', 'Jahrestag', { repeatsYearly: true })],
                   settings: { startMonth: '2026-09' } }),
      { today: '2026-09-15' });
    assert.equal(dayOf(m, '2027-05-04').allNotes.length, 1);
    assert.equal(dayOf(m, '2027-05-04').allNotes[0].note.id, 'r1');
  });

  test('a yearly note never appears before its anchor year (9.5)', () => {
    const m = L.buildBoard(
      boardState({ notes: [note('r2', '2026-05-04', 'Anker', { repeatsYearly: true })],
                   settings: { startMonth: '2025-01' } }),
      { today: '2025-06-01' });
    assert.equal(dayOf(m, '2025-05-04').allNotes.length, 0);
  });

  test('a Feb-29 yearly series shows on Feb 28 in non-leap years (9.4)', () => {
    const m = L.buildBoard(
      boardState({ notes: [note('r3', '2024-02-29', 'Schalttag', { repeatsYearly: true })],
                   settings: { startMonth: '2026-09' } }),
      { today: '2026-09-15' });
    assert.equal(dayOf(m, '2027-02-28').allNotes.length, 1);
    assert.equal(dayOf(m, '2027-02-29'), null, 'no such row exists at all');
  });

  test('occurrences outside the window are dropped, not clamped to the edge', () => {
    const m = build({
      notes: [note('r', '2026-05-04', 'Jahrestag', { repeatsYearly: true })],
      layers: { feiertage: false },
    });
    // window is 2026-01..2026-12 → exactly one occurrence
    const hits = m.cols.flatMap((c) => c.days).filter((d) => !d.empty && d.allNotes.length);
    assert.deepEqual(hits.map((d) => d.date), ['2026-05-04']);
  });

  test('a repeat occurrence counts against capacity like any other note', () => {
    const m = build({
      notes: [
        note('r', '2020-03-10', 'Geburtstag', { repeatsYearly: true }),
        note('a', '2026-03-10', 'Termin'),
        note('b', '2026-03-10', 'noch einer'),
      ],
      layers: { feiertage: false },
    });
    const d = dayOf(m, '2026-03-10');
    assert.equal(d.allNotes.length, 3);
    assert.equal(d.notes.length, 2);
    assert.equal(d.overflow, 1);
    assert.equal(d.allNotes[0].note.id, 'r', 'store order, repeats included');
  });
});

describe('F4 · category visibility (4.3)', () => {
  test('hidden categories drop out of both notes and bars', () => {
    const s = boardState({
      notes: [note('n1', '2026-03-10', 'x')],
      bars: [bar('b1', '2026-03-01', '2026-03-05', 'y')],
    });
    s.categories[0].visible = false;
    const m = L.buildBoard(s, { today: TODAY });
    assert.equal(dayOf(m, '2026-03-10').allNotes.length, 0);
    assert.equal(dayOf(m, '2026-03-10').overflow, 0);
    assert.equal(colOf(m, '2026-03').segs.length, 0);
  });

  test('hiding a category REPACKS the lanes of what is left', () => {
    // Lane assignment runs on the visible set (layout.js:119-120), so isolating
    // "Work" pulls the surviving bars down into lane 0. Worth pinning: it means
    // the model is a pure function of (state, today) with no memo of hidden ones.
    const s = boardState({ bars: [
      bar('h1', '2026-01-01', '2026-01-31', 'versteckt'),
      bar('h2', '2026-01-01', '2026-01-31', 'sichtbar'),
    ] });
    s.bars[0].categoryId = s.categories[1].id;
    const all = L.buildBoard(s, { today: TODAY });
    assert.deepEqual(laneMap(colOf(all, '2026-01')), ['versteckt:0', 'sichtbar:1']);
    s.categories[1].visible = false;
    const some = L.buildBoard(s, { today: TODAY });
    assert.deepEqual(laneMap(colOf(some, '2026-01')), ['sichtbar:0'], 'pulled into lane 0');
  });

  test('hiding a category can clear a "+n" badge it was causing', () => {
    const s = boardState({ bars: [
      bar('b1', '2026-03-01', '2026-03-31', 'A'),
      bar('b2', '2026-03-01', '2026-03-31', 'B'),
      bar('b3', '2026-03-01', '2026-03-31', 'C'),
      bar('b4', '2026-03-01', '2026-03-31', 'D'),
    ], layers: { feiertage: false } });
    s.bars[3].categoryId = s.categories[2].id;
    const before = L.buildBoard(s, { today: TODAY });
    assert.equal(colOf(before, '2026-03').days[0].laneOverflow, 1);
    s.categories[2].visible = false;
    const after = L.buildBoard(s, { today: TODAY });
    assert.equal(colOf(after, '2026-03').days[0].laneOverflow, 0);
    assert.equal(colOf(after, '2026-03').days[0].overflow, 0);
  });

  test('`visible` is only respected when it is exactly false (layout.js:111,115,119)', () => {
    const s = boardState({ notes: [note('n1', '2026-03-10', 'x')] });
    delete s.categories[0].visible;
    const m = L.buildBoard(s, { today: TODAY });
    assert.equal(dayOf(m, '2026-03-10').allNotes.length, 1, 'undefined means visible');
    // an entry whose category no longer exists is NOT hidden — it renders in the
    // default palette tone. store.migrate() repairs the reference on load;
    // layout stays lenient so a mid-session orphan cannot make ink vanish.
    const orphan = boardState({ notes: [note('n2', '2026-03-11', 'waise', { categoryId: 'nope' })] });
    const om = L.buildBoard(orphan, { today: TODAY });
    assert.equal(dayOf(om, '2026-03-11').allNotes.length, 1);
    assert.equal(dayOf(om, '2026-03-11').notes[0].color, '#2A7CC0', 'palette fallback');
  });
});

describe('F10 · month scratchpads', () => {
  test('each column carries its month scratchpad, defaulting to empty string', () => {
    const m = build({ scratchpads: { '2026-04': 'Steuern!' } });
    assert.equal(colOf(m, '2026-04').pad, 'Steuern!');
    assert.equal(colOf(m, '2026-05').pad, '');
    assert.ok(m.cols.every((c) => typeof c.pad === 'string'));
  });

  test('a pad for a month outside the window is simply not surfaced', () => {
    const m = build({ scratchpads: { '2029-04': 'weit weg' } });
    assert.ok(m.cols.every((c) => c.pad === ''));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Purity + the row-geometry inverse — the two properties the retrofit leans on
// ═══════════════════════════════════════════════════════════════════════════

describe('model invariants', () => {
  test('rowAt inverts the row geometry and clamps to 0..30', () => {
    assert.equal(L.rowAt(0, 22), 0);
    assert.equal(L.rowAt(21, 22), 0);
    assert.equal(L.rowAt(22, 22), 1);
    assert.equal(L.rowAt(21.9, 22), 0);
    assert.equal(L.rowAt(-5, 22), 0);
    assert.equal(L.rowAt(99999, 22), 30, 'never past the 31st row');
    assert.equal(L.rowAt(30 * 22, 22), 30);
    assert.equal(L.rowAt(31 * 22, 22), 30, 'the void tail clamps too');
    // and it tracks the row-height setting
    assert.equal(L.rowAt(36, 18), 2);
    assert.equal(L.rowAt(36, 32), 1);
  });

  test('rowAt round-trips with the topRow layout puts on a segment', () => {
    const m = build({ bars: [bar('b', '2026-03-10', '2026-03-20', 'x')] });
    const seg = colOf(m, '2026-03').segs[0];
    assert.equal(L.rowAt(seg.topRow * m.rowH, m.rowH), seg.topRow);
    assert.equal(L.rowAt(seg.topRow * m.rowH + m.rowH - 1, m.rowH), seg.topRow);
  });

  test('buildBoard does not mutate the state it is given', () => {
    // The retrofit turns the store into an op-log; a renderer with side effects
    // on state would be a landmine there.
    const s = boardState({
      notes: [note('n1', '2026-03-10', 'a'), note('n2', '2026-03-10', 'b'),
              note('r', '2020-03-10', 'jährlich', { repeatsYearly: true })],
      bars: [bar('b2', '2026-04-01', '2026-04-10', 'B'),
             bar('b1', '2026-03-01', '2026-05-10', 'A')],
      scratchpads: { '2026-04': 'x' },
    });
    const before = structuredClone(s);
    L.buildBoard(s, { today: TODAY });
    assert.deepEqual(s, before);
  });

  test('buildBoard is deterministic — same input, same model', () => {
    const s = boardState({
      notes: [note('n1', '2026-03-10', 'a')],
      bars: [bar('b1', '2026-03-01', '2026-05-10', 'A'),
             bar('b2', '2026-03-05', '2026-03-20', 'B')],
    });
    const a = L.buildBoard(s, { today: TODAY });
    const b = L.buildBoard(s, { today: TODAY });
    assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  });

  test('an empty board still produces the full 12 × 31 skeleton', () => {
    const m = build({ layers: { feiertage: false } });
    assert.equal(m.cols.length, 12);
    assert.ok(m.cols.every((c) => c.days.length === 31));
    assert.ok(m.cols.every((c) => c.segs.length === 0));
    assert.ok(m.cols.every((c) => c.horizon === false));
    assert.ok(m.cols.every((c) => c.days.every((d) =>
      d.empty || (d.notes.length === 0 && d.allNotes.length === 0
                  && d.overflow === 0 && d.laneOverflow === 0
                  && d.holiday === null && d.ferien === false))));
  });

  test('buildBoard falls back to the wall clock when no `today` is passed', () => {
    const m = L.buildBoard(boardState({}));
    assert.match(m.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(m.cols[0].key, '2026-01', 'pinned mode is unaffected by it');
  });
});
