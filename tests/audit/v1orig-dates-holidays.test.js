// ─────────────────────────────────────────────────────────────────────────────
// CHARACTERIZATION SUITE — area "dates-holidays"
//
// Spec stories in scope: 1.6, 6.1–6.6, 7.1–7.5, 9.4.
//
// This file locks in what v1 DOES TODAY. It is a gate for the LZP-402 op-log
// retrofit: none of these assertions may change when the store becomes an
// append-only log, because none of them touch the store's internals — they
// exercise pure date/holiday/Ferien math and the render model built from a
// plain state object.
//
// Rules followed here:
//   • Where code and spec agree, the behaviour is asserted.
//   • Where they differ, the CODE is asserted and the difference is flagged in
//     an UPPERCASE comment (there are two: FINDING 1 and FINDING 2 below).
//   • Nothing under src/ was modified.
//
// Tier 1 (node --test). No dependencies, no DOM.
// Run: node --test tests/dates-holidays.test.js
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import * as D from '../../src/js/dates.js';
import * as H from '../../src/js/holidays.js';
import * as F from '../../src/js/ferien.js';
import { buildBoard, rowCapacity } from '../../src/js/layout.js';
import { boardState, note, CAT, dayOf, colOf } from '../helpers/fixtures.js';

// ── independent oracles ──────────────────────────────────────────────────────
// Cross-checking a computation against a re-statement of itself proves nothing.
// These two are DIFFERENT formulations of the same calendar facts, written from
// the mathematical definition rather than copied from src/.

/** Gauss's Easter algorithm — a different derivation than the Meeus/Jones/
 *  Butcher "anonymous Gregorian" one used in holidays.js. */
function gaussEaster(Y) {
  const a = Y % 19, b = Y % 4, c = Y % 7;
  const k = Math.floor(Y / 100);
  const p = Math.floor((13 + 8 * k) / 25);
  const q = Math.floor(k / 4);
  const M = (15 - p + k - q) % 30;
  const N = (4 + k - q) % 7;
  const d = (19 * a + M) % 30;
  const e = (2 * b + 4 * c + 6 * d + N) % 7;
  let day = 22 + d + e, month = 3;
  if (day > 31) { day = d + e - 9; month = 4; }
  if (d === 29 && e === 6) { day = 19; month = 4; }
  if (d === 28 && e === 6 && a > 10) { day = 18; month = 4; }
  return `${Y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Sakamoto's day-of-week — pure integer arithmetic, no Date object at all. */
function sakamotoDow(y, m, d) {
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const yy = m < 3 ? y - 1 : y;
  return (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + t[m - 1] + d) % 7;
}

/** Gregorian leap rule, stated directly. */
const leapRule = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Easter falls on 23 March in these years; see the collision test below. */
const EASTER_MAR_23_YEARS = [1913, 2008, 2160, 2228];

// ═════════════════════════════════════════════════════════════════════════════
// dates.js — plain YYYY-MM-DD arithmetic (spec §13: no times, no timezones)
// ═════════════════════════════════════════════════════════════════════════════

describe('dates.js — string date arithmetic', () => {
  test('iso() zero-pads both month and day; parseISO() is its exact inverse', () => {
    assert.equal(D.iso(2026, 1, 1), '2026-01-01');
    assert.equal(D.iso(2026, 9, 30), '2026-09-30');
    assert.equal(D.iso(2026, 10, 3), '2026-10-03');
    assert.equal(D.iso(2026, 12, 31), '2026-12-31');
    // Round-trip every day of a leap year — 366 assertions, no exceptions.
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= D.daysInMonth(2028, m); d++) {
        const s = D.iso(2028, m, d);
        assert.match(s, /^\d{4}-\d{2}-\d{2}$/);
        assert.deepEqual(D.parseISO(s), { y: 2028, m, d });
      }
    }
  });

  test('p2 pads to two digits and leaves wider numbers alone', () => {
    assert.equal(D.p2(0), '00');
    assert.equal(D.p2(9), '09');
    assert.equal(D.p2(10), '10');
    assert.equal(D.p2(2026), '2026');
  });

  test('dow matches an independent (Date-free) weekday computation, 1900–2200', () => {
    for (let y = 1900; y <= 2200; y += 7) {
      for (const [m, d] of [[1, 1], [2, 28], [3, 1], [6, 15], [12, 31]]) {
        assert.equal(D.dow(y, m, d), sakamotoDow(y, m, d), `${y}-${m}-${d}`);
      }
    }
    // 0 = Sunday … 6 = Saturday, spelled out on one known week.
    assert.equal(D.dowISO('2026-08-23'), 0);
    assert.equal(D.dowISO('2026-08-24'), 1);
    assert.equal(D.dowISO('2026-08-25'), 2);
    assert.equal(D.dowISO('2026-08-26'), 3);
    assert.equal(D.dowISO('2026-08-27'), 4);
    assert.equal(D.dowISO('2026-08-28'), 5);
    assert.equal(D.dowISO('2026-08-29'), 6);
  });

  test('isWeekend is exactly Saturday and Sunday, over a full year sweep', () => {
    let weekendDays = 0;
    let d = '2026-01-01';
    while (d <= '2026-12-31') {
      const w = D.dowISO(d);
      assert.equal(D.isWeekend(d), w === 0 || w === 6, d);
      if (D.isWeekend(d)) weekendDays++;
      d = D.addDays(d, 1);
    }
    assert.equal(weekendDays, 104); // 2026 has 52 Saturdays + 52 Sundays
  });

  test('daysInMonth agrees with the Gregorian rule for every month, 1600–2400', () => {
    const plain = [31, null, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for (let y = 1600; y <= 2400; y += 3) {
      for (let m = 1; m <= 12; m++) {
        const expected = m === 2 ? (leapRule(y) ? 29 : 28) : plain[m - 1];
        assert.equal(D.daysInMonth(y, m), expected, `${y}-${m}`);
      }
      assert.equal(D.isLeap(y), leapRule(y), String(y));
    }
    // The century cases that trip naive implementations.
    assert.equal(D.isLeap(1900), false);
    assert.equal(D.isLeap(2000), true);
    assert.equal(D.isLeap(2100), false);
    assert.equal(D.isLeap(2400), true);
  });

  test('addDays walks a leap year one day at a time and closes the loop at 366', () => {
    let d = '2028-01-01';
    const seen = new Set();
    for (let i = 0; i < 366; i++) {
      assert.ok(!seen.has(d), `repeated ${d}`);
      seen.add(d);
      d = D.addDays(d, 1);
    }
    assert.equal(d, '2029-01-01');
    assert.equal(seen.size, 366);
    assert.ok(seen.has('2028-02-29'));
  });

  test('addDays crosses month, year and century boundaries in both directions', () => {
    assert.equal(D.addDays('2026-01-31', 1), '2026-02-01');
    assert.equal(D.addDays('2026-02-28', 1), '2026-03-01');   // not a leap year
    assert.equal(D.addDays('2028-02-28', 1), '2028-02-29');   // leap year
    assert.equal(D.addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(D.addDays('2027-01-01', -1), '2026-12-31');
    assert.equal(D.addDays('2099-12-31', 1), '2100-01-01');
    assert.equal(D.addDays('2100-02-28', 1), '2100-03-01');   // 2100 is NOT leap
    assert.equal(D.addDays('2026-01-01', 0), '2026-01-01');
    assert.equal(D.addDays('2026-01-01', 10000), '2053-05-19');
    assert.equal(D.addDays('2026-01-01', -10000), '1998-08-16');
  });

  test('addDays and diffDays are mutual inverses across a 5-year span', () => {
    const base = '2024-02-29'; // a leap day, on purpose
    for (const n of [-2000, -365, -60, -1, 0, 1, 60, 365, 731, 2000]) {
      const moved = D.addDays(base, n);
      assert.equal(D.diffDays(base, moved), n, `offset ${n}`);
      assert.equal(D.addDays(moved, -n), base, `offset ${n} back`);
    }
  });

  test('diffDays counts whole days, signed, and knows leap years', () => {
    assert.equal(D.diffDays('2026-01-01', '2026-01-01'), 0);
    assert.equal(D.diffDays('2026-01-01', '2027-01-01'), 365);
    assert.equal(D.diffDays('2028-01-01', '2029-01-01'), 366); // leap
    assert.equal(D.diffDays('2027-01-01', '2026-01-01'), -365);
    assert.equal(D.diffDays('2026-02-28', '2026-03-01'), 1);
    assert.equal(D.diffDays('2028-02-28', '2028-03-01'), 2);   // via Feb 29
  });

  test('cmpDate / minDate / maxDate order lexicographically, which is chronological', () => {
    assert.equal(D.cmpDate('2026-01-01', '2026-01-02'), -1);
    assert.equal(D.cmpDate('2026-02-01', '2026-01-31'), 1);
    assert.equal(D.cmpDate('2026-12-31', '2027-01-01'), -1);
    assert.equal(D.cmpDate('2026-06-15', '2026-06-15'), 0);
    assert.equal(D.minDate('2027-01-01', '2026-12-31'), '2026-12-31');
    assert.equal(D.maxDate('2027-01-01', '2026-12-31'), '2027-01-01');
    // ties return the first argument for min and for max alike
    assert.equal(D.minDate('2026-01-01', '2026-01-01'), '2026-01-01');
    assert.equal(D.maxDate('2026-01-01', '2026-01-01'), '2026-01-01');
    // sorting an array with cmpDate is chronological
    const shuffled = ['2027-01-01', '2026-12-31', '2026-01-05', '2026-01-15'];
    assert.deepEqual([...shuffled].sort(D.cmpDate),
      ['2026-01-05', '2026-01-15', '2026-12-31', '2027-01-01']);
  });

  test('month keys: monthKey pads, monthKeyOf slices the first seven characters', () => {
    assert.equal(D.monthKey(2026, 1), '2026-01');
    assert.equal(D.monthKey(2026, 12), '2026-12');
    assert.equal(D.monthKeyOf('2026-08-25'), '2026-08');
    assert.equal(D.monthKeyOf('2026-08-01'), D.monthKeyOf('2026-08-31'));
    assert.notEqual(D.monthKeyOf('2026-08-31'), D.monthKeyOf('2026-09-01'));
  });

  test('monthOrdinal is a single comparable number across year boundaries', () => {
    assert.equal(D.monthOrdinal(2026, 12) + 1, D.monthOrdinal(2027, 1));
    assert.equal(D.monthOrdinalOf('2027-01-31') - D.monthOrdinalOf('2026-02-01'), 11);
    assert.equal(D.monthOrdinalOf('2026-08-25'), D.monthOrdinal(2026, 8));
    // twelve consecutive months are twelve consecutive ordinals — the property
    // buildBoard relies on for its 12-column window.
    const ords = [];
    for (let i = 0; i < 12; i++) {
      const { y, m } = D.addMonths(2026, 8, i);
      ords.push(D.monthOrdinal(y, m));
    }
    assert.deepEqual(ords, ords.map((_, i) => ords[0] + i));
  });

  test('addMonths wraps years in both directions and never yields month 0 or 13', () => {
    assert.deepEqual(D.addMonths(2026, 12, 1), { y: 2027, m: 1 });
    assert.deepEqual(D.addMonths(2026, 1, -1), { y: 2025, m: 12 });
    assert.deepEqual(D.addMonths(2026, 8, 11), { y: 2027, m: 7 }); // the board window
    assert.deepEqual(D.addMonths(2026, 1, -13), { y: 2024, m: 12 });
    assert.deepEqual(D.addMonths(2026, 6, 120), { y: 2036, m: 6 });
    for (let n = -60; n <= 60; n++) {
      const { y, m } = D.addMonths(2026, 6, n);
      assert.ok(m >= 1 && m <= 12, `month ${m} out of range at n=${n}`);
      assert.equal(D.monthOrdinal(y, m), D.monthOrdinal(2026, 6) + n);
    }
  });

  test('weekday and month tables are indexed by dow / month-1 and are language pairs', () => {
    assert.equal(D.WD_DE.length, 7);
    assert.equal(D.WD_EN.length, 7);
    assert.equal(D.MONTH_DE.length, 12);
    assert.equal(D.MONTH_EN.length, 12);
    // Index 0 is Sunday, matching dow()'s convention — the board depends on it.
    assert.equal(D.WD_DE[D.dowISO('2026-08-23')], 'So');
    assert.equal(D.WD_EN[D.dowISO('2026-08-23')], 'Su');
    assert.equal(D.WD_DE[D.dowISO('2026-10-03')], 'Sa'); // spec §5's "03 Sa"
    assert.deepEqual(D.WD_DE, ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']);
    assert.deepEqual(D.WD_EN, ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']);
    assert.equal(D.MONTH_DE[2], 'März');
    assert.equal(D.MONTH_EN[2], 'March');
    assert.equal(D.MONTH_DE[11], 'Dezember');
    assert.equal(D.MONTH_EN[11], 'December');
    // German and English weekday abbreviations differ exactly where the spec's
    // i18n note says they do (Di/Tu, Mi/We, Do/Th, Sa stays, So/Su).
    assert.deepEqual(
      D.WD_DE.map((w, i) => (w === D.WD_EN[i] ? i : null)).filter((x) => x !== null),
      [1, 5, 6]
    );
  });
});

describe('dates.js — no timezone leakage (spec §13)', () => {
  test('every string function is byte-identical under UTC+14, UTC-11 and UTC', () => {
    const probe = () => ({
      add: D.addDays('2026-03-28', 1),          // European DST spring-forward
      addBack: D.addDays('2026-10-25', -1),     // European DST fall-back
      addYear: D.addDays('2026-12-31', 1),
      dow: D.dowISO('2026-01-01'),
      weekend: D.isWeekend('2026-08-23'),
      dim: D.daysInMonth(2028, 2),
      leap: D.isLeap(2028),
      diff: D.diffDays('2026-01-01', '2027-01-01'),
      key: D.monthKeyOf('2026-08-25'),
      ord: D.monthOrdinalOf('2026-08-25'),
      months: D.addMonths(2026, 12, 1),
      project: D.projectYearly('2024-02-29', 2027),
      iso: D.iso(2026, 1, 1),
    });
    const original = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const utc = probe();
      process.env.TZ = 'Pacific/Kiritimati'; // UTC+14, furthest ahead on earth
      assert.deepEqual(probe(), utc);
      process.env.TZ = 'Pacific/Midway';     // UTC-11, furthest behind
      assert.deepEqual(probe(), utc);
      process.env.TZ = 'Australia/Lord_Howe'; // a :30 offset with DST
      assert.deepEqual(probe(), utc);
      process.env.TZ = 'America/Santiago';    // southern-hemisphere DST
      assert.deepEqual(probe(), utc);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  test('todayISO is the ONE deliberate reader of the local clock', () => {
    // Characterization, not a complaint: todayISO() uses getFullYear/getMonth/
    // getDate (local), so "today" is the user's wall-clock day — which is what
    // a wall calendar must show. Everything else above is UTC-only.
    assert.match(D.todayISO(), /^\d{4}-\d{2}-\d{2}$/);
    const n = new Date();
    assert.equal(D.todayISO(), D.iso(n.getFullYear(), n.getMonth() + 1, n.getDate()));
    // It never emits a bare single-digit component.
    const [y, m, d] = D.todayISO().split('-');
    assert.equal(y.length, 4);
    assert.equal(m.length, 2);
    assert.equal(d.length, 2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Story 1.6 — rows align by day number, 01 always at the top
// ═════════════════════════════════════════════════════════════════════════════

describe('1.6 — day-number row alignment', () => {
  const model = (patch) => buildBoard(boardState(patch), { today: '2026-08-25' });

  test('every column is 31 slots; slot i is always day i+1 or a void row', () => {
    const m = model({ settings: { startMonth: '2026-08' } });
    assert.equal(m.cols.length, 12);
    for (const col of m.cols) {
      assert.equal(col.days.length, 31);
      col.days.forEach((day, i) => {
        assert.equal(day.row, i, `${col.key} row index`);
        if (day.empty) {
          assert.ok(i + 1 > col.len, `${col.key}: void row inside the month`);
          assert.equal(day.date, undefined);
        } else {
          assert.equal(day.n, D.p2(i + 1));
          assert.equal(day.date, D.iso(col.y, col.m, i + 1));
        }
      });
    }
  });

  test('short months pad their BOTTOM rows, never their top', () => {
    const m = model({ settings: { startMonth: '2026-01' } });
    const feb = colOf(m, '2026-02');
    assert.equal(feb.len, 28);
    assert.equal(feb.days[0].empty, false);
    assert.equal(feb.days[0].n, '01');
    assert.equal(feb.days[27].date, '2026-02-28');
    assert.deepEqual(feb.days.slice(28).map((d) => d.empty), [true, true, true]);
    const apr = colOf(m, '2026-04');
    assert.equal(apr.len, 30);
    assert.deepEqual(apr.days.slice(30).map((d) => d.empty), [true]);
    const jan = colOf(m, '2026-01');
    assert.equal(jan.days.filter((d) => d.empty).length, 0);
  });

  test('a rolling 12-month board is 372 slots: 365 dated + 7 void (non-leap span)', () => {
    const m = model({ settings: { startMonth: '2026-08' } }); // Aug 26 – Jul 27
    const all = m.cols.flatMap((c) => c.days);
    assert.equal(all.length, 372);
    assert.equal(all.filter((d) => !d.empty).length, 365);
    assert.equal(all.filter((d) => d.empty).length, 7);
  });

  test('a window containing a leap February has 366 dated rows and 6 void ones', () => {
    const m = model({ settings: { startMonth: '2027-09' } }); // Sep 27 – Aug 28
    const all = m.cols.flatMap((c) => c.days);
    assert.equal(all.filter((d) => !d.empty).length, 366);
    assert.equal(all.filter((d) => d.empty).length, 6);
    assert.equal(colOf(m, '2028-02').len, 29);
    assert.equal(colOf(m, '2028-02').days[28].date, '2028-02-29');
  });

  test('the weekday shifts across columns while the day number does not (the whole point)', () => {
    const m = model({ settings: { startMonth: '2026-08' } });
    const firstRow = m.cols.map((c) => c.days[0]);
    assert.deepEqual(firstRow.map((d) => d.n), Array(12).fill('01'));
    // …and their weekday labels genuinely differ, so alignment is doing work.
    const wds = firstRow.map((d) => d.wd);
    assert.ok(new Set(wds).size >= 5, `expected shifting weekdays, got ${wds}`);
    assert.deepEqual(
      wds,
      firstRow.map((d) => D.WD_DE[D.dowISO(d.date)])
    );
  });

  test('English boards relabel weekdays and months without moving any row', () => {
    const de = model({ settings: { startMonth: '2026-08' } });
    const en = model({ settings: { startMonth: '2026-08', language: 'en' } });
    assert.deepEqual(
      de.cols.flatMap((c) => c.days.map((d) => d.date ?? null)),
      en.cols.flatMap((c) => c.days.map((d) => d.date ?? null))
    );
    assert.equal(colOf(de, '2026-08').days[0].wd, 'Sa');
    assert.equal(colOf(en, '2026-08').days[0].wd, 'Sa');
    assert.equal(colOf(de, '2026-09').days[0].wd, 'Di');
    assert.equal(colOf(en, '2026-09').days[0].wd, 'Tu');
    assert.equal(colOf(de, '2026-08').fullLabel, 'August 2026');
    assert.equal(colOf(en, '2026-12').fullLabel, 'December 2026');
    assert.equal(colOf(de, '2026-12').label, 'Dez ’26');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// F6 — Feiertage: computed, never looked up (6.1–6.6)
// ═════════════════════════════════════════════════════════════════════════════

describe('6.5 — Easter arithmetic', () => {
  test('easterSunday matches Gauss\'s independent algorithm for 1900–2200', () => {
    for (let y = 1900; y <= 2200; y++) {
      assert.equal(H.easterSunday(y), gaussEaster(y), `Easter ${y}`);
    }
  });

  test('Easter is always a Sunday inside the canonical 22 Mar – 25 Apr window', () => {
    for (let y = 1900; y <= 2400; y++) {
      const e = H.easterSunday(y);
      assert.equal(D.dowISO(e), 0, `${e} is not a Sunday`);
      assert.ok(e >= `${y}-03-22` && e <= `${y}-04-25`, `${e} outside the window`);
    }
  });

  test('the named far-future years still compute (6.5: never runs out of data)', () => {
    assert.equal(H.easterSunday(2027), '2027-03-28');
    assert.equal(H.easterSunday(2038), '2038-04-25'); // the latest possible date
    assert.equal(H.easterSunday(2087), '2087-04-20');
    assert.equal(H.easterSunday(2100), '2100-03-28');
    assert.equal(H.easterSunday(3000), gaussEaster(3000));
  });
});

describe('6.5 — Buß- und Bettag rule', () => {
  test('always the Wednesday in the 16–22 November window, for 1900–2400', () => {
    for (let y = 1900; y <= 2400; y++) {
      const b = H.bussUndBettag(y);
      assert.equal(D.dowISO(b), 3, `${b} is not a Wednesday`);
      assert.ok(b >= `${y}-11-16` && b <= `${y}-11-22`, `${b} outside the window`);
      // "the last Wednesday BEFORE 23 November": the next Wednesday is on or
      // after the 23rd.
      assert.ok(D.addDays(b, 7) >= `${y}-11-23`, `${b} is not the LAST one`);
    }
  });

  test('the named far-future years', () => {
    assert.equal(H.bussUndBettag(2026), '2026-11-18');
    assert.equal(H.bussUndBettag(2027), '2027-11-17');
    assert.equal(H.bussUndBettag(2038), '2038-11-17');
    assert.equal(H.bussUndBettag(2087), '2087-11-19');
    assert.equal(H.bussUndBettag(2100), '2100-11-17');
  });
});

describe('6.2 / 6.3 — Bundesland selection', () => {
  test('17 entries: the 16 states plus the empty "nationwide only" sentinel', () => {
    assert.equal(H.BUNDESLAENDER.length, 17);
    assert.equal(H.BUNDESLAENDER[0].code, '');
    assert.equal(H.BUNDESLAENDER[0].de, 'Nur bundesweite Feiertage');
    assert.equal(H.BUNDESLAENDER[0].en, 'Nationwide holidays only');
    assert.equal(H.ALL_STATE_CODES.length, 16);
    assert.equal(new Set(H.ALL_STATE_CODES).size, 16);
    assert.deepEqual(H.ALL_STATE_CODES, [
      'BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV',
      'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH',
    ]);
    for (const b of H.BUNDESLAENDER) {
      assert.equal(typeof b.de, 'string');
      assert.equal(typeof b.en, 'string');
      assert.ok(b.de.length > 0 && b.en.length > 0);
    }
  });

  test('stateName localises and passes unknown codes straight through', () => {
    assert.equal(H.stateName('BY', 'de'), 'Bayern');
    assert.equal(H.stateName('BY', 'en'), 'Bavaria');
    assert.equal(H.stateName('SN', 'de'), 'Sachsen');
    assert.equal(H.stateName('SN', 'en'), 'Saxony');
    assert.equal(H.stateName('NW', 'de'), 'Nordrhein-Westfalen');
    assert.equal(H.stateName('BY'), 'Bayern');       // default language is German
    assert.equal(H.stateName('BY', 'fr'), 'Bayern'); // anything not 'en' is German
    assert.equal(H.stateName('', 'de'), 'Nur bundesweite Feiertage');
    assert.equal(H.stateName('ZZ', 'de'), 'ZZ');     // unknown code, not a throw
  });
});

describe('6.5 — the computed set never runs out (distant years)', () => {
  const YEARS = [2027, 2038, 2087, 2100];

  test('Bayern\'s full observed set, 2027 — the exact twelve', () => {
    const by = H.holidaysForYear(2027, 'BY', 'de');
    const own = [...by.entries()].filter(([, h]) => h.own)
      .map(([d, h]) => [d, h.name]).sort();
    assert.deepEqual(own, [
      ['2027-01-01', 'Neujahr'],
      ['2027-01-06', 'Heilige Drei Könige'],
      ['2027-03-26', 'Karfreitag'],
      ['2027-03-29', 'Ostermontag'],
      ['2027-05-01', 'Tag der Arbeit'],
      ['2027-05-06', 'Christi Himmelfahrt'],
      ['2027-05-17', 'Pfingstmontag'],
      ['2027-05-27', 'Fronleichnam'],
      ['2027-10-03', 'Tag der Deutschen Einheit'],
      ['2027-11-01', 'Allerheiligen'],
      ['2027-12-25', '1. Weihnachtstag'],
      ['2027-12-26', '2. Weihnachtstag'],
    ]);
    // Bavaria does NOT observe Reformationstag or Buß- und Bettag…
    assert.equal(by.get('2027-10-31').own, false);
    assert.equal(by.get('2027-11-17').own, false);
    // …but they are still present in the map for the dimmed union view (6.6).
    assert.equal(by.get('2027-10-31').name, 'Reformationstag');
    assert.equal(by.get('2027-11-17').name, 'Buß- und Bettag');
  });

  test('Bayern\'s full observed set, 2087 — same twelve, sixty years out', () => {
    const own = [...H.holidaysForYear(2087, 'BY', 'de').entries()]
      .filter(([, h]) => h.own).map(([d, h]) => [d, h.name]).sort();
    assert.deepEqual(own, [
      ['2087-01-01', 'Neujahr'],
      ['2087-01-06', 'Heilige Drei Könige'],
      ['2087-04-18', 'Karfreitag'],
      ['2087-04-21', 'Ostermontag'],
      ['2087-05-01', 'Tag der Arbeit'],
      ['2087-05-29', 'Christi Himmelfahrt'],
      ['2087-06-09', 'Pfingstmontag'],
      ['2087-06-19', 'Fronleichnam'],
      ['2087-10-03', 'Tag der Deutschen Einheit'],
      ['2087-11-01', 'Allerheiligen'],
      ['2087-12-25', '1. Weihnachtstag'],
      ['2087-12-26', '2. Weihnachtstag'],
    ]);
  });

  test('Sachsen\'s full observed set, 2027 — eleven, including Buß- und Bettag', () => {
    const sn = H.holidaysForYear(2027, 'SN', 'de');
    const own = [...sn.entries()].filter(([, h]) => h.own)
      .map(([d, h]) => [d, h.name]).sort();
    assert.deepEqual(own, [
      ['2027-01-01', 'Neujahr'],
      ['2027-03-26', 'Karfreitag'],
      ['2027-03-29', 'Ostermontag'],
      ['2027-05-01', 'Tag der Arbeit'],
      ['2027-05-06', 'Christi Himmelfahrt'],
      ['2027-05-17', 'Pfingstmontag'],
      ['2027-10-03', 'Tag der Deutschen Einheit'],
      ['2027-10-31', 'Reformationstag'],
      ['2027-11-17', 'Buß- und Bettag'],
      ['2027-12-25', '1. Weihnachtstag'],
      ['2027-12-26', '2. Weihnachtstag'],
    ]);
    // Saxony is the only state that observes Buß- und Bettag.
    assert.deepEqual(sn.get('2027-11-17').states, ['SN']);
    // …and it does not observe the Catholic pair.
    assert.equal(sn.get('2027-05-27').own, false); // Fronleichnam
    assert.equal(sn.get('2027-11-01').own, false); // Allerheiligen
  });

  test('Sachsen\'s full observed set, 2100 — same eleven, past a non-leap century', () => {
    const own = [...H.holidaysForYear(2100, 'SN', 'de').entries()]
      .filter(([, h]) => h.own).map(([d, h]) => [d, h.name]).sort();
    assert.deepEqual(own, [
      ['2100-01-01', 'Neujahr'],
      ['2100-03-26', 'Karfreitag'],
      ['2100-03-29', 'Ostermontag'],
      ['2100-05-01', 'Tag der Arbeit'],
      ['2100-05-06', 'Christi Himmelfahrt'],
      ['2100-05-17', 'Pfingstmontag'],
      ['2100-10-03', 'Tag der Deutschen Einheit'],
      ['2100-10-31', 'Reformationstag'],
      ['2100-11-17', 'Buß- und Bettag'],
      ['2100-12-25', '1. Weihnachtstag'],
      ['2100-12-26', '2. Weihnachtstag'],
    ]);
  });

  test('the nationwide-only selection is exactly nine days, in every distant year', () => {
    for (const y of YEARS) {
      const e = H.easterSunday(y);
      const own = [...H.holidaysForYear(y, '', 'de').entries()]
        .filter(([, h]) => h.own).map(([d]) => d).sort();
      assert.deepEqual(own, [
        `${y}-01-01`,             // Neujahr
        D.addDays(e, -2),         // Karfreitag
        D.addDays(e, 1),          // Ostermontag
        `${y}-05-01`,             // Tag der Arbeit
        D.addDays(e, 39),         // Christi Himmelfahrt
        D.addDays(e, 50),         // Pfingstmontag
        `${y}-10-03`,             // Tag der Deutschen Einheit
        `${y}-12-25`,
        `${y}-12-26`,
      ].sort(), `nationwide set for ${y}`);
    }
  });

  test('for any state and any year, entries are complete and inside their year', () => {
    for (const y of [...YEARS, 2026, 2200, 2500, 3000]) {
      for (const code of ['', ...H.ALL_STATE_CODES]) {
        const m = H.holidaysForYear(y, code, 'de');
        assert.ok(m.size >= 18, `${code} ${y}: only ${m.size} entries`);
        for (const [date, h] of m) {
          assert.equal(date.slice(0, 4), String(y), `${date} leaked out of ${y}`);
          assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
          assert.equal(typeof h.name, 'string');
          assert.ok(h.name.length > 0, `${date} has no name`);
          assert.equal(typeof h.short, 'string');
          assert.ok(h.short.length > 0);
          assert.equal(typeof h.own, 'boolean');
          assert.ok(Array.isArray(h.states) && h.states.length > 0);
          for (const s of h.states) assert.ok(H.ALL_STATE_CODES.includes(s), s);
          // `own` is derivable from `states` alone: nationwide (the full list)
          // is always own; anything else only for the selected state, and never
          // when no state is selected.
          const nationwide = h.states.length === H.ALL_STATE_CODES.length;
          assert.equal(h.own, nationwide || (code !== '' && h.states.includes(code)),
            `${date} own for "${code}"`);
        }
      }
    }
  });

  test('the per-state count of observed holidays is stable for 1900–2300…', () => {
    const expected = {
      '': 9, BW: 12, BY: 12, BE: 10, BB: 12, HB: 10, HH: 10, HE: 10,
      MV: 11, NI: 10, NW: 11, RP: 11, SL: 12, SN: 11, ST: 11, SH: 10, TH: 11,
    };
    for (let y = 1900; y <= 2300; y++) {
      if (EASTER_MAR_23_YEARS.includes(y)) continue; // see the collision test
      for (const [code, n] of Object.entries(expected)) {
        const own = [...H.holidaysForYear(y, code, 'de').values()].filter((h) => h.own);
        assert.equal(own.length, n, `${code || '(nationwide)'} in ${y}`);
      }
    }
  });

  test('…except in the years where Christi Himmelfahrt lands on 1 May', () => {
    // CHARACTERIZED BEHAVIOUR (see FINDING 1 in the report). When Easter falls
    // on 23 March, Easter+39 = 1 May, and Tag der Arbeit occupies that date
    // first. holidaysForYear's put() keeps the entry already present when it is
    // `own`, so Christi Himmelfahrt is DROPPED from the map for that year: the
    // day is still shown as a holiday, but under one name only, and the year's
    // map has 18 entries instead of 19. The spec does not legislate the
    // collision case, so this is not a story violation — but it is a real,
    // silent data loss that the op-log retrofit must not accidentally "fix"
    // without a decision.
    for (const y of EASTER_MAR_23_YEARS) {
      assert.equal(H.easterSunday(y), `${y}-03-23`);
      assert.equal(D.addDays(H.easterSunday(y), 39), `${y}-05-01`);
      const m = H.holidaysForYear(y, 'BY', 'de');
      assert.equal(m.size, 18, `${y} should have one entry fewer`);
      assert.equal(m.get(`${y}-05-01`).name, 'Tag der Arbeit');
      assert.equal(m.get(`${y}-05-01`).own, true);
      assert.equal(
        [...m.values()].some((h) => h.name === 'Christi Himmelfahrt'), false,
        `${y}: Christi Himmelfahrt should have been swallowed`
      );
    }
    // 2008 is the one inside living memory — a real past calendar year.
    assert.equal(H.holidaysForYear(2008, 'NI', 'de').get('2008-05-01').name, 'Tag der Arbeit');
  });
});

describe('6.2 / 6.6 — the `own` flag and the union view', () => {
  test('regional holidays are `own` for exactly the listed states', () => {
    const cases = [
      ['2027-01-06', 'Heilige Drei Könige', ['BW', 'BY', 'ST']],
      ['2027-03-08', 'Internationaler Frauentag', ['BE', 'MV']],
      ['2027-08-15', 'Mariä Himmelfahrt', ['SL']],
      ['2027-09-20', 'Weltkindertag', ['TH']],
      ['2027-10-31', 'Reformationstag',
        ['BB', 'HB', 'HH', 'MV', 'NI', 'SN', 'ST', 'SH', 'TH']],
      ['2027-11-01', 'Allerheiligen', ['BW', 'BY', 'NW', 'RP', 'SL']],
      ['2027-05-27', 'Fronleichnam', ['BW', 'BY', 'HE', 'NW', 'RP', 'SL']],
    ];
    for (const [date, name, states] of cases) {
      for (const code of H.ALL_STATE_CODES) {
        const h = H.holidaysForYear(2027, code, 'de').get(date);
        assert.equal(h.name, name, `${date} in ${code}`);
        assert.deepEqual(h.states, states, `${date} states`);
        assert.equal(h.own, states.includes(code), `${date} own for ${code}`);
      }
      // With no Bundesland chosen, a regional holiday is never `own`.
      assert.equal(H.holidaysForYear(2027, '', 'de').get(date).own, false);
    }
  });

  test('Ostersonntag and Pfingstsonntag are Brandenburg-only', () => {
    const e = H.easterSunday(2027);
    for (const code of H.ALL_STATE_CODES) {
      const m = H.holidaysForYear(2027, code, 'de');
      assert.equal(m.get(e).name, 'Ostersonntag');
      assert.equal(m.get(e).own, code === 'BB');
      assert.equal(m.get(D.addDays(e, 49)).name, 'Pfingstsonntag');
      assert.equal(m.get(D.addDays(e, 49)).own, code === 'BB');
    }
  });

  test('nationwide holidays carry the complete 16-state list and are always own', () => {
    for (const code of ['', ...H.ALL_STATE_CODES]) {
      const h = H.holidaysForYear(2027, code, 'de').get('2027-10-03');
      assert.equal(h.name, 'Tag der Deutschen Einheit');
      assert.equal(h.own, true, `nationwide not own for "${code}"`);
      assert.deepEqual(h.states, H.ALL_STATE_CODES);
    }
  });

  test('6.6 — the union is identical regardless of the selected state', () => {
    // Only `own` differs between states; the key set never does. That is what
    // lets the "other Bundesländer dimmed" toggle render without a second pass.
    const keys = (code) => [...H.holidaysForYear(2027, code, 'de').keys()].sort();
    const reference = keys('');
    assert.equal(reference.length, 19);
    for (const code of H.ALL_STATE_CODES) assert.deepEqual(keys(code), reference);
  });
});

describe('6.1 — inline names, and their short forms', () => {
  test('short forms replace exactly the names that do not fit a 118px column', () => {
    const de = H.holidaysForYear(2027, 'SN', 'de');
    assert.equal(de.get('2027-10-03').short, 'Dt. Einheit');
    assert.equal(de.get('2027-05-06').short, 'Christi Himmelf.');
    assert.equal(de.get('2027-11-17').short, 'Buß- u. Bettag');
    assert.equal(de.get('2027-12-25').short, '1. Weihn.');
    assert.equal(de.get('2027-12-26').short, '2. Weihn.');
    assert.equal(H.holidaysForYear(2027, 'BY', 'de').get('2027-01-06').short, 'Hl. Drei Könige');
    assert.equal(H.holidaysForYear(2027, 'BE', 'de').get('2027-03-08').short, 'Frauentag');
    assert.equal(H.holidaysForYear(2027, 'SL', 'de').get('2027-08-15').short, 'Mariä Himmelf.');
    // Names that already fit are their own short form.
    for (const d of ['2027-01-01', '2027-03-26', '2027-05-01', '2027-10-31', '2027-11-01']) {
      assert.equal(de.get(d).short, de.get(d).name, d);
    }
  });

  test('no short form is longer than the name it abbreviates', () => {
    for (const lang of ['de', 'en']) {
      for (const [, h] of H.holidaysForYear(2027, 'BY', lang)) {
        assert.ok(h.short.length <= h.name.length, `${h.short} vs ${h.name}`);
      }
    }
  });

  test('English is the same computation with the other name column', () => {
    const de = H.holidaysForYear(2038, 'BY', 'de');
    const en = H.holidaysForYear(2038, 'BY', 'en');
    assert.deepEqual([...en.keys()].sort(), [...de.keys()].sort());
    for (const [d, h] of en) {
      assert.equal(h.own, de.get(d).own, d);
      assert.deepEqual(h.states, de.get(d).states, d);
    }
    assert.equal(en.get('2038-01-01').name, "New Year's Day");
    assert.equal(en.get('2038-10-03').name, 'German Unity Day');
    assert.equal(en.get('2038-10-03').short, 'Unity Day');
    assert.equal(en.get('2038-11-01').name, "All Saints' Day");
    assert.equal(en.get('2038-11-01').short, 'All Saints');
    assert.equal(en.get(H.bussUndBettag(2038)).name, 'Repentance and Prayer Day');
    assert.equal(en.get(H.bussUndBettag(2038)).short, 'Repentance Day');
    // Any language string that is not 'en' means German.
    assert.equal(H.holidaysForYear(2038, 'BY').get('2038-01-01').name, 'Neujahr');
    assert.equal(H.holidaysForYear(2038, 'BY', 'fr').get('2038-01-01').name, 'Neujahr');
  });
});

describe('holidayIndex — the board\'s multi-year window', () => {
  test('unions the years a rolling board touches, keyed by date', () => {
    const idx = H.holidayIndex([2026, 2027], 'BY', 'de');
    assert.equal(idx.get('2026-12-25').name, '1. Weihnachtstag');
    assert.equal(idx.get('2027-01-01').name, 'Neujahr');
    assert.equal(idx.get('2027-06-04'), undefined);      // Fronleichnam 2026, not 2027
    assert.equal(idx.get('2027-05-27').name, 'Fronleichnam');
    assert.equal(idx.has('2025-12-25'), false);
    assert.equal(idx.has('2028-01-01'), false);
    assert.equal(idx.size, 38); // two complete, non-overlapping years
  });

  test('a single-year window and an empty window both behave', () => {
    assert.equal(H.holidayIndex([2027], 'BY', 'de').size, 19);
    assert.equal(H.holidayIndex([], 'BY', 'de').size, 0);
  });

  test('a 100-year window still produces one entry per date, no collisions', () => {
    const years = Array.from({ length: 100 }, (_, i) => 2027 + i);
    const idx = H.holidayIndex(years, 'SN', 'de');
    // 19 per year, minus one for each Easter-on-23-March collision in range.
    const collisions = years.filter((y) => H.easterSunday(y) === `${y}-03-23`).length;
    assert.equal(idx.size, 100 * 19 - collisions);
    assert.equal(idx.get('2126-01-01').name, 'Neujahr');
  });

  test('the year cache returns the same Map instance — callers must not mutate it', () => {
    const a = H.holidaysForYear(2087, 'TH', 'de');
    const b = H.holidaysForYear(2087, 'TH', 'de');
    assert.equal(a, b);
    assert.notEqual(a, H.holidaysForYear(2087, 'TH', 'en'));
    assert.notEqual(a, H.holidaysForYear(2087, 'SN', 'de'));
    assert.notEqual(a, H.holidaysForYear(2088, 'TH', 'de'));
  });
});

describe('6.1 / 6.4 / 6.6 — holidays on the board', () => {
  const model = (patch) => buildBoard(boardState(patch), { today: '2026-08-25' });

  test('6.1 — a holiday is written inline on its own row, with its short form', () => {
    const m = model({ settings: { startMonth: '2026-08', bundesland: 'BY' } });
    const unity = dayOf(m, '2026-10-03');
    assert.equal(unity.holiday.name, 'Tag der Deutschen Einheit');
    assert.equal(unity.holiday.short, 'Dt. Einheit');
    assert.equal(unity.holidayShown, true);
    assert.equal(unity.holidayDemoted, false);
    // …and an ordinary day carries nothing.
    assert.equal(dayOf(m, '2026-10-02').holiday, null);
    assert.equal(dayOf(m, '2026-10-02').holidayShown, false);
  });

  test('6.4 — switching the Feiertage layer off empties the whole layer', () => {
    const on = model({ settings: { bundesland: 'BY' }, layers: { feiertage: true } });
    const off = model({ settings: { bundesland: 'BY' }, layers: { feiertage: false } });
    assert.ok(dayOf(on, '2026-01-01').holiday);
    assert.equal(dayOf(off, '2026-01-01').holiday, null);
    assert.equal(dayOf(off, '2026-01-01').holidayShown, false);
    assert.equal(dayOf(off, '2026-01-01').holidayDemoted, false);
    // Rows and day numbers are untouched — only the ink goes away.
    assert.equal(off.cols.flatMap((c) => c.days).length, 372);
    assert.equal(
      off.cols.flatMap((c) => c.days).filter((d) => d.holiday).length, 0
    );
  });

  test('6.6 — another state\'s holiday appears only with the otherStates layer', () => {
    const plain = model({ settings: { startMonth: '2026-08', bundesland: 'BY' } });
    const union = model({
      settings: { startMonth: '2026-08', bundesland: 'BY' },
      layers: { otherStates: true },
    });
    // Reformationstag: not observed in Bavaria.
    assert.equal(dayOf(plain, '2026-10-31').holiday, null);
    assert.equal(dayOf(union, '2026-10-31').holiday.name, 'Reformationstag');
    assert.equal(dayOf(union, '2026-10-31').holiday.own, false);
    // Bavaria's own holidays are unaffected by the toggle.
    for (const d of ['2026-11-01', '2026-12-25']) {
      assert.equal(dayOf(plain, d).holiday.own, true);
      assert.equal(dayOf(union, d).holiday.own, true);
    }
  });

  test('with no Bundesland only the nationwide days are drawn', () => {
    const m = model({ settings: { startMonth: '2026-08' } });
    assert.equal(dayOf(m, '2026-10-03').holidayShown, true); // nationwide
    assert.equal(dayOf(m, '2026-11-01').holiday, null);      // Allerheiligen: regional
    const shown = m.cols.flatMap((c) => c.days).filter((d) => d.holidayShown);
    assert.equal(shown.length, 9); // exactly one nationwide year's worth
  });

  test('holiday text survives a note as a demotion, never as a deletion (challenge 2)', () => {
    // capacity 1 (18px rows) + a note on the same day → the holiday demotes.
    const dense = model({
      settings: { startMonth: '2026-08', bundesland: 'BY', rowHeight: 18 },
      notes: [note('n1', '2026-10-03', 'Werkstatttermin')],
    });
    assert.equal(rowCapacity(18), 1);
    const d1 = dayOf(dense, '2026-10-03');
    assert.equal(d1.holiday.name, 'Tag der Deutschen Einheit'); // still there
    assert.equal(d1.holidayShown, false);
    assert.equal(d1.holidayDemoted, true);
    assert.equal(d1.notes.length, 1);

    // capacity 2 (22px, the default) → both fit, holiday keeps line 1.
    const roomy = model({
      settings: { startMonth: '2026-08', bundesland: 'BY', rowHeight: 22 },
      notes: [note('n1', '2026-10-03', 'Werkstatttermin')],
    });
    assert.equal(rowCapacity(22), 2);
    const d2 = dayOf(roomy, '2026-10-03');
    assert.equal(d2.holidayShown, true);
    assert.equal(d2.holidayDemoted, false);
    assert.equal(d2.notes.length, 1);
    assert.equal(d2.overflow, 0);

    // capacity 1 with NO note → the holiday keeps the line.
    const bare = model({ settings: { startMonth: '2026-08', bundesland: 'BY', rowHeight: 18 } });
    assert.equal(dayOf(bare, '2026-10-03').holidayShown, true);
    assert.equal(dayOf(bare, '2026-10-03').holidayDemoted, false);
  });

  test('a hidden category frees the row again, so the holiday is written out', () => {
    const s = boardState({
      settings: { startMonth: '2026-08', bundesland: 'BY', rowHeight: 18 },
      notes: [note('n1', '2026-10-03', 'Werkstatttermin')],
    });
    s.categories[0].visible = false;
    const m = buildBoard(s, { today: '2026-08-25' });
    const day = dayOf(m, '2026-10-03');
    assert.equal(day.notes.length, 0);
    assert.equal(day.holidayShown, true);
    assert.equal(day.holidayDemoted, false);
  });

  test('a holiday row still counts note overflow correctly at capacity 3', () => {
    // rowHeight 33, not 32: floor((32-1)/10.5) is 2, so 32px only holds two
    // lines. (DESIGN-DECISIONS §B's table says 32 → 3; the formula it prints
    // says 2, and the code follows the formula. Pinned in layout.test.js.)
    const m = model({
      settings: { startMonth: '2026-08', bundesland: 'BY', rowHeight: 33 },
      notes: [
        note('n1', '2026-12-25', 'A'),
        note('n2', '2026-12-25', 'B'),
        note('n3', '2026-12-25', 'C'),
      ],
    });
    assert.equal(rowCapacity(33), 3);
    const day = dayOf(m, '2026-12-25');
    assert.equal(day.holidayShown, true);   // holiday takes line 1
    assert.equal(day.notes.length, 2);      // two note slots left
    assert.equal(day.allNotes.length, 3);   // nothing is lost from the model
    assert.equal(day.overflow, 1);          // the third becomes "+1"
  });

  test('an empty board is still a full holiday layer — nothing depends on content', () => {
    const m = model({ settings: { startMonth: '2026-08', bundesland: 'SN' } });
    // Void rows carry only { empty, row } — no notes array — so dated rows are
    // selected first. That shape is itself part of v1's contract.
    const dated = m.cols.flatMap((c) => c.days).filter((d) => !d.empty);
    assert.equal(dated.filter((d) => d.notes.length).length, 0);
    // Aug 2026 – Jul 2027 catches Saxony's eleven observed days across the
    // seam of two calendar years — five in 2026, six in 2027.
    const shown = dated.filter((d) => d.holidayShown);
    assert.deepEqual(shown.map((d) => d.date), [
      '2026-10-03', '2026-10-31', '2026-11-18', '2026-12-25', '2026-12-26',
      '2027-01-01', '2027-03-26', '2027-03-29', '2027-05-01', '2027-05-06',
      '2027-05-17',
    ]);
    for (const d of shown) assert.equal(d.holiday.own, true);
    assert.equal(dayOf(m, '2026-11-18').holiday.name, 'Buß- und Bettag');
    assert.equal(dayOf(m, '2026-11-18').holiday.own, true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// F7 — Schulferien: bundled data with a horizon (7.1–7.5)
// ═════════════════════════════════════════════════════════════════════════════

describe('7.1 / 7.4 — the bundled dataset', () => {
  test('all sixteen Bundesländer carry data; there is no nationwide bucket', () => {
    assert.deepEqual(Object.keys(F.FERIEN).sort(), [...H.ALL_STATE_CODES].sort());
    assert.equal(F.FERIEN[''], undefined);
    for (const code of H.ALL_STATE_CODES) {
      assert.ok(F.FERIEN[code].length >= 9, `${code}: ${F.FERIEN[code].length} periods`);
    }
  });

  test('every row is a well-formed [name, first, last] triple, both ends inclusive', () => {
    for (const [code, rows] of Object.entries(F.FERIEN)) {
      for (const row of rows) {
        assert.equal(row.length, 3, `${code} ${row}`);
        const [name, start, end] = row;
        assert.equal(typeof name, 'string');
        assert.match(start, /^\d{4}-\d{2}-\d{2}$/, `${code} ${name}`);
        assert.match(end, /^\d{4}-\d{2}-\d{2}$/, `${code} ${name}`);
        assert.ok(start <= end, `${code} ${name} ends before it starts`);
      }
    }
  });

  test('no period is longer than ferienIndex\'s 400-day walk guard', () => {
    // ferienIndex walks a period day by day behind `guard++ < 400`. A longer
    // period would be silently truncated; the bundled data stays far below it.
    let longest = 0;
    for (const rows of Object.values(F.FERIEN)) {
      for (const [, s, e] of rows) longest = Math.max(longest, D.diffDays(s, e) + 1);
    }
    assert.equal(longest, 45); // BW Sommerferien 2026-07-30 … 2026-09-12
    assert.ok(longest < 400);
  });

  test('periods within a state never overlap', () => {
    for (const code of H.ALL_STATE_CODES) {
      const rows = F.ferienFor(code, 'de');
      for (let i = 1; i < rows.length; i++) {
        assert.ok(rows[i].start > rows[i - 1].end,
          `${code}: ${rows[i - 1].name} overlaps ${rows[i].name}`);
      }
    }
  });

  test('7.4 — FERIEN_META declares the data unverified, with a stated horizon', () => {
    assert.deepEqual(F.FERIEN_META, {
      verified: false,
      horizon: '2028-08-31',
      updated: '2026-08-01',
      source: 'KMK (Platzhalterdaten / placeholder data)',
    });
    // settings.js renders t('ferienUnverified') off `verified === false`. This
    // assertion is the reminder to flip it when real KMK tables land.
  });

  test('7.4 — the data does not extend indefinitely: it starts and stops', () => {
    let earliest = '9999-99-99';
    let latest = '0000-00-00';
    for (const rows of Object.values(F.FERIEN)) {
      for (const [, s, e] of rows) {
        if (s < earliest) earliest = s;
        if (e > latest) latest = e;
      }
    }
    assert.equal(earliest, '2026-06-22'); // NW Sommerferien 2026
    assert.equal(latest, '2028-09-09');   // BW Sommerferien 2028
    // Beyond the data there is simply nothing — no throw, no extrapolation.
    for (const code of H.ALL_STATE_CODES) {
      const idx = F.ferienIndex(code, 'de');
      assert.equal(idx.has('2029-01-01'), false, code);
      assert.equal(idx.has('2025-12-24'), false, code);
      assert.equal(idx.get('2030-07-01'), undefined, code);
    }
  });

  test('7.4 — FINDING 2: seventeen shaded days lie BEYOND the declared horizon', () => {
    // Story 7.4: "the bundled dataset has a visible horizon … beyond which
    // shading is simply absent." FERIEN_META.horizon says 2028-08-31, but two
    // states' 2028 Sommerferien run past it, so the board shades days the
    // settings sheet has told the user are uncovered. The label undersells the
    // data rather than overselling it, so no user is misled into trusting
    // missing shading — but the two numbers disagree, and this test pins the
    // disagreement so the retrofit cannot quietly change which one is right.
    const beyond = {};
    for (const code of H.ALL_STATE_CODES) {
      const days = [...F.ferienIndex(code, 'de').keys()]
        .filter((d) => d > F.FERIEN_META.horizon).sort();
      if (days.length) beyond[code] = days;
    }
    assert.deepEqual(Object.keys(beyond), ['BW', 'BY']);
    assert.equal(beyond.BW.length, 9);
    assert.equal(beyond.BY.length, 8);
    assert.equal(beyond.BW.at(0), '2028-09-01');
    assert.equal(beyond.BW.at(-1), '2028-09-09');
    assert.equal(beyond.BY.at(-1), '2028-09-08');
    assert.equal(
      Object.values(beyond).reduce((n, ds) => n + ds.length, 0), 17
    );
  });
});

describe('7.2 — naming the shaded period', () => {
  test('ferienIndex maps every day of a period to its name, inclusive at both ends', () => {
    const idx = F.ferienIndex('BY', 'de');
    const [name, start, end] = F.FERIEN.BY.find(([n]) => n === 'Weihnachtsferien');
    assert.equal(start, '2026-12-24');
    assert.equal(end, '2027-01-05');
    let d = start;
    while (d <= end) {
      assert.equal(idx.get(d), name, d);
      d = D.addDays(d, 1);
    }
    // The days either side are not in the index at all.
    assert.equal(idx.has(D.addDays(start, -1)), false);
    assert.equal(idx.has(D.addDays(end, 1)), false);
  });

  test('the index size equals the summed period lengths, for every state', () => {
    for (const code of H.ALL_STATE_CODES) {
      const expected = F.FERIEN[code]
        .reduce((n, [, s, e]) => n + D.diffDays(s, e) + 1, 0);
      assert.equal(F.ferienIndex(code, 'de').size, expected, code);
    }
  });

  test('all six bundled period names appear, and each has an English label', () => {
    const used = new Set();
    for (const rows of Object.values(F.FERIEN)) for (const [n] of rows) used.add(n);
    assert.deepEqual([...used].sort(), [
      'Herbstferien', 'Osterferien', 'Pfingstferien',
      'Sommerferien', 'Weihnachtsferien', 'Winterferien',
    ]);
    for (const n of used) {
      assert.equal(typeof F.FERIEN_NAMES_EN[n], 'string', `${n} has no English name`);
    }
    // The table is a superset: 'Frühjahrsferien' is translated but unused by
    // the placeholder data. Real KMK tables use it, so the entry is not dead.
    assert.equal(F.FERIEN_NAMES_EN['Frühjahrsferien'], 'Spring break');
    assert.equal(used.has('Frühjahrsferien'), false);
  });

  test('German is the default; only lang === "en" translates', () => {
    assert.equal(F.ferienFor('BY', 'de')[0].name, 'Sommerferien');
    assert.equal(F.ferienFor('BY')[0].name, 'Sommerferien');
    assert.equal(F.ferienFor('BY', 'fr')[0].name, 'Sommerferien');
    assert.equal(F.ferienFor('BY', 'en')[0].name, 'Summer break');
    assert.equal(F.ferienIndex('BY', 'en').get('2026-08-05'), 'Summer break');
    assert.equal(F.ferienIndex('BY', 'de').get('2026-08-05'), 'Sommerferien');
    // Same days, different labels — translation never moves a date.
    assert.deepEqual(
      [...F.ferienIndex('BY', 'en').keys()],
      [...F.ferienIndex('BY', 'de').keys()]
    );
  });

  test('ferienFor sorts by start date and returns [] for anything unknown', () => {
    for (const code of H.ALL_STATE_CODES) {
      const rows = F.ferienFor(code, 'de');
      for (let i = 1; i < rows.length; i++) {
        assert.ok(rows[i - 1].start <= rows[i].start, `${code} unsorted`);
      }
      assert.equal(rows.length, F.FERIEN[code].length);
    }
    assert.deepEqual(F.ferienFor(''), []);
    assert.deepEqual(F.ferienFor('XX'), []);
    assert.deepEqual(F.ferienFor(undefined), []);
    assert.deepEqual(F.ferienFor(null), []);
  });

  test('ferienFor hands back fresh objects, not references into FERIEN', () => {
    const a = F.ferienFor('BY', 'de');
    const b = F.ferienFor('BY', 'de');
    assert.notEqual(a, b);
    assert.notEqual(a[0], b[0]);
    a[0].name = 'mutated';
    assert.equal(F.ferienFor('BY', 'de')[0].name, 'Sommerferien');
    assert.equal(F.FERIEN.BY[0][0], 'Sommerferien');
  });
});

describe('7.1 / 7.3 / 7.5 — the Ferien layer on the board', () => {
  const model = (patch) => buildBoard(boardState(patch), { today: '2026-08-25' });

  test('7.1 — shading marks the bundled days and names them per day', () => {
    const m = model({
      settings: { startMonth: '2026-08', bundesland: 'BY' },
      layers: { schulferien: true },
    });
    const inside = dayOf(m, '2026-08-05'); // BY Sommerferien 2026-08-01…09-14
    assert.equal(inside.ferien, true);
    assert.equal(inside.ferienName, 'Sommerferien');
    const outside = dayOf(m, '2026-09-15');
    assert.equal(outside.ferien, false);
    assert.equal(outside.ferienName, '');
    // Boundaries are inclusive on the board too.
    assert.equal(dayOf(m, '2026-08-01').ferien, true);
    assert.equal(dayOf(m, '2026-09-14').ferien, true);
    assert.equal(dayOf(m, '2026-07-31'), null); // outside the window entirely
  });

  test('7.5 — without a Bundesland the layer shades nothing, even when switched on', () => {
    const m = model({ settings: { startMonth: '2026-08' }, layers: { schulferien: true } });
    assert.equal(m.cols.flatMap((c) => c.days).filter((d) => d.ferien).length, 0);
    for (const d of m.cols.flatMap((c) => c.days)) {
      if (d.empty) continue; // void rows have no layer fields at all
      assert.equal(d.ferienName, '');
    }
  });

  test('7.3 — the two layers are independent in all four combinations', () => {
    const base = { startMonth: '2026-08', bundesland: 'BY' };
    const combos = [
      [true, true], [true, false], [false, true], [false, false],
    ];
    for (const [feiertage, schulferien] of combos) {
      const m = model({ settings: base, layers: { feiertage, schulferien } });
      const hol = dayOf(m, '2026-10-03').holiday; // Tag der Deutschen Einheit
      const fer = dayOf(m, '2026-08-05').ferien;  // BY Sommerferien
      assert.equal(!!hol, feiertage, `feiertage=${feiertage} schulferien=${schulferien}`);
      assert.equal(fer, schulferien, `feiertage=${feiertage} schulferien=${schulferien}`);
    }
  });

  test('a holiday inside a Ferien period keeps both signals on the same row', () => {
    const m = model({
      settings: { startMonth: '2026-08', bundesland: 'BY' },
      layers: { schulferien: true },
    });
    const xmas = dayOf(m, '2026-12-25'); // 1. Weihnachtstag, inside Weihnachtsferien
    assert.equal(xmas.holiday.name, '1. Weihnachtstag');
    assert.equal(xmas.holidayShown, true);
    assert.equal(xmas.ferien, true);
    assert.equal(xmas.ferienName, 'Weihnachtsferien');
    assert.equal(xmas.weekend, false); // 2026-12-25 is a Friday
  });

  test('7.4 — a board past the data horizon simply has no shading', () => {
    const m = model({
      settings: { startMonth: '2029-01', bundesland: 'BY' },
      layers: { schulferien: true },
    });
    assert.equal(m.cols.flatMap((c) => c.days).filter((d) => d.ferien).length, 0);
    // …while Feiertage, being computed, are fully present in the same window.
    assert.equal(dayOf(m, '2029-10-03').holiday.name, 'Tag der Deutschen Einheit');
    assert.equal(dayOf(m, '2029-04-02').holiday.name, 'Ostermontag'); // Easter 2029-04-01
  });

  test('English board labels the shading in English', () => {
    const m = model({
      settings: { startMonth: '2026-08', bundesland: 'BY', language: 'en' },
      layers: { schulferien: true },
    });
    assert.equal(dayOf(m, '2026-08-05').ferienName, 'Summer break');
    assert.equal(dayOf(m, '2026-12-28').ferienName, 'Christmas break');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9.4 — leap-day handling
// ═════════════════════════════════════════════════════════════════════════════

describe('9.4 — a Feb-29 repeat shows on Feb 28 in non-leap years', () => {
  test('projectYearly moves ONLY the leap day, and only when it has to', () => {
    assert.equal(D.projectYearly('2024-02-29', 2024), '2024-02-29');
    assert.equal(D.projectYearly('2024-02-29', 2025), '2025-02-28');
    assert.equal(D.projectYearly('2024-02-29', 2026), '2026-02-28');
    assert.equal(D.projectYearly('2024-02-29', 2027), '2027-02-28');
    assert.equal(D.projectYearly('2024-02-29', 2028), '2028-02-29');
    // The century that is not a leap year, and the one that is.
    assert.equal(D.projectYearly('2024-02-29', 2100), '2100-02-28');
    assert.equal(D.projectYearly('2024-02-29', 2400), '2400-02-29');
    // A Feb-28 anchor never becomes Feb 29, not even in a leap year.
    assert.equal(D.projectYearly('2026-02-28', 2028), '2028-02-28');
    // Every other date keeps its month and day exactly.
    assert.equal(D.projectYearly('2026-03-01', 2028), '2028-03-01');
    assert.equal(D.projectYearly('2026-12-31', 2030), '2030-12-31');
    assert.equal(D.projectYearly('2026-01-01', 2099), '2099-01-01');
  });

  test('projectYearly is a pure function of (month, day, targetYear)', () => {
    // The anchor's own year is irrelevant — only its month/day matter.
    assert.equal(D.projectYearly('1904-02-29', 2027), D.projectYearly('2024-02-29', 2027));
    assert.equal(D.projectYearly('2000-07-04', 2033), '2033-07-04');
    const anchor = '2024-02-29';
    D.projectYearly(anchor, 2027);
    assert.equal(anchor, '2024-02-29'); // strings, so no aliasing is possible
  });

  test('over a 40-year sweep a leap-day series lands on Feb 28 or Feb 29, never Mar 1', () => {
    for (let y = 2024; y <= 2064; y++) {
      const d = D.projectYearly('2024-02-29', y);
      assert.equal(d.slice(0, 7), `${y}-02`, d);
      assert.equal(d.slice(8), D.isLeap(y) ? '29' : '28', d);
      // The projected date always exists in that year.
      assert.ok(Number(d.slice(8)) <= D.daysInMonth(y, 2), d);
    }
  });

  test('on the board: the same note renders on Feb 28 in 2027 and Feb 29 in 2028', () => {
    const birthday = note('n-leap', '2024-02-29', 'Geburtstag', { repeatsYearly: true });
    const nonLeap = buildBoard(
      boardState({ settings: { startMonth: '2027-01' }, notes: [birthday] }),
      { today: '2027-01-15' }
    );
    assert.equal(dayOf(nonLeap, '2027-02-28').notes.length, 1);
    assert.equal(dayOf(nonLeap, '2027-02-28').notes[0].note.text, 'Geburtstag');
    assert.equal(dayOf(nonLeap, '2027-03-01').notes.length, 0);
    // February 2027 has no 29th row at all — the slot is a void row.
    assert.equal(colOf(nonLeap, '2027-02').days[28].empty, true);

    const leap = buildBoard(
      boardState({ settings: { startMonth: '2028-01' }, notes: [birthday] }),
      { today: '2028-01-15' }
    );
    assert.equal(dayOf(leap, '2028-02-29').notes.length, 1);
    assert.equal(dayOf(leap, '2028-02-28').notes.length, 0);
    assert.equal(colOf(leap, '2028-02').days[28].empty, false);
    assert.equal(colOf(leap, '2028-02').days[28].date, '2028-02-29');

    // The stored note is never rewritten — projection happens at render time.
    assert.equal(birthday.date, '2024-02-29');
  });

  test('a leap-day series appears exactly once per visible year, never twice', () => {
    // A window spanning two Februaries must not double-book the projection.
    const m = buildBoard(
      boardState({
        settings: { startMonth: '2026-12' }, // Dec 26 – Nov 27: one February
        notes: [note('n-leap', '2024-02-29', 'Geburtstag', { repeatsYearly: true })],
      }),
      { today: '2026-12-01' }
    );
    const hits = m.cols.flatMap((c) => c.days)
      .filter((d) => !d.empty && d.notes.some((n) => n.note.id === 'n-leap'));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].date, '2027-02-28');
  });

  test('a leap-day series does not render before its anchor year (9.5 interaction)', () => {
    const m = buildBoard(
      boardState({
        settings: { startMonth: '2026-01' },
        notes: [note('n-future', '2028-02-29', 'Erst ab 2028', { repeatsYearly: true })],
      }),
      { today: '2026-01-15' }
    );
    assert.equal(dayOf(m, '2026-02-28').notes.length, 0);
    assert.equal(m.cols.flatMap((c) => c.days)
      .filter((d) => !d.empty && d.notes.length).length, 0);
  });

  test('a leap-day series shares its row with a holiday under the usual rules', () => {
    // 2028-02-28 is an ordinary Monday; 2027-02-28 is a Sunday. Neither is a
    // Feiertag, so the projection never competes with holiday text — this test
    // pins that the projected note behaves like any other note in the row model.
    const m = buildBoard(
      boardState({
        settings: { startMonth: '2027-01', bundesland: 'BY', rowHeight: 18 },
        notes: [
          note('n-leap', '2024-02-29', 'Geburtstag', { repeatsYearly: true }),
          note('n-other', '2027-02-28', 'Zweiter Eintrag'),
        ],
      }),
      { today: '2027-01-15' }
    );
    const day = dayOf(m, '2027-02-28');
    assert.equal(rowCapacity(18), 1);
    assert.equal(day.allNotes.length, 2);
    assert.equal(day.notes.length, 1);
    assert.equal(day.overflow, 1);
    assert.equal(day.holiday, null);
    assert.equal(day.weekend, true); // 2027-02-28 is a Sunday
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Cross-area invariants the retrofit must not break
// ═════════════════════════════════════════════════════════════════════════════

describe('cross-area invariants', () => {
  test('an empty board still produces the complete ambient layers', () => {
    const s = boardState({
      settings: { startMonth: '2026-08', bundesland: 'BY' },
      layers: { schulferien: true },
    });
    s.categories = [];              // no categories at all
    const m = buildBoard(s, { today: '2026-08-25' });
    const days = m.cols.flatMap((c) => c.days).filter((d) => !d.empty);
    assert.equal(days.length, 365);
    assert.equal(days.every((d) => d.notes.length === 0), true);
    assert.ok(days.filter((d) => d.holidayShown).length > 0);
    assert.ok(days.filter((d) => d.ferien).length > 0);
  });

  test('holiday and Ferien lookups are keyed by the same date strings the rows use', () => {
    // The one string-format bug class that would silently blank a whole layer.
    const m = buildBoard(
      boardState({
        settings: { startMonth: '2026-08', bundesland: 'BY' },
        layers: { schulferien: true, otherStates: true },
      }),
      { today: '2026-08-25' }
    );
    const holIdx = H.holidayIndex([2026, 2027], 'BY', 'de');
    const ferIdx = F.ferienIndex('BY', 'de');
    for (const col of m.cols) {
      for (const d of col.days) {
        if (d.empty) continue;
        assert.equal(!!d.holiday, holIdx.has(d.date), `holiday ${d.date}`);
        assert.equal(d.ferien, ferIdx.has(d.date), `ferien ${d.date}`);
        if (d.ferien) assert.equal(d.ferienName, ferIdx.get(d.date));
      }
    }
  });

  test('row-height extremes do not change which dates exist or which are holidays', () => {
    const dates = (rowHeight) => {
      const m = buildBoard(
        boardState({ settings: { startMonth: '2026-08', bundesland: 'BY', rowHeight } }),
        { today: '2026-08-25' }
      );
      return {
        all: m.cols.flatMap((c) => c.days.map((d) => d.date ?? null)),
        holidays: m.cols.flatMap((c) => c.days)
          .filter((d) => d.holiday).map((d) => d.date),
        capacity: m.capacity,
      };
    };
    const small = dates(18);   // capacity 1
    const large = dates(33);   // capacity 3 (32 still gives 2 — see above)
    assert.deepEqual(small.all, large.all);
    assert.deepEqual(small.holidays, large.holidays);
    assert.equal(small.capacity, 1);
    assert.equal(large.capacity, 3);
    assert.equal(dates(32).capacity, 2); // the slider's real maximum
  });

  test('buildBoard never mutates the state it was handed', () => {
    const s = boardState({
      settings: { startMonth: '2026-08', bundesland: 'BY' },
      layers: { schulferien: true },
      notes: [note('n1', '2026-10-03', 'x', { repeatsYearly: true })],
    });
    const before = JSON.stringify(s);
    buildBoard(s, { today: '2026-08-25' });
    buildBoard(s, { today: '2026-08-25' });
    assert.equal(JSON.stringify(s), before);
  });

  test('two builds of the same state are deeply identical (no clock, no randomness)', () => {
    const s = boardState({
      settings: { startMonth: '2026-08', bundesland: 'SN' },
      layers: { schulferien: true, otherStates: true },
      notes: [note('n1', '2026-11-18', 'Termin', { categoryId: CAT[1] })],
    });
    const a = buildBoard(s, { today: '2026-08-25' });
    const b = buildBoard(s, { today: '2026-08-25' });
    assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  });
});
