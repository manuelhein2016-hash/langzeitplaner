// ─────────────────────────────────────────────────────────────────────────────
// v1 CHARACTERIZATION SUITE — area "repeats-find-i18n"
//
// Stories in scope:
//   F9   9.1–9.6  yearly repeats
//   F14  14.1     find over notes / bar labels / scratchpads, hit stepping
//        14.2     [Could] store-wide hits outside the visible window
//   F13  13.7     German default, English toggle
//
// This file locks in what v1 does TODAY so that LZP-402 (append-only op-log)
// can be judged a refactor rather than a rewrite. Everything here is asserted
// against OBSERVABLE behaviour of exported functions — `buildBoard()`'s render
// model, `historyHits()`, `projectYearly()`, `t()/setLang()/getLang()`,
// `catName()` — never against private internals the retrofit may replace.
//
// TIER: 1 (node --test, no DOM). What genuinely needs tier 2 is listed in the
// "TIER 2 GAPS" block at the bottom of this file, one line per behaviour, so
// the gap is recorded rather than silently missing.
//
// The store is seeded through its public `replaceAll()` rather than by writing
// `store.state` directly — `replaceAll` is the same door `import` uses, so the
// seeding stays valid once the store becomes an op-log.
// ─────────────────────────────────────────────────────────────────────────────

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import '../helpers/env.js';
import { boardState, note, bar, dayOf, colOf, CAT } from '../helpers/fixtures.js';

import { buildBoard, rowCapacity } from '../../src/js/layout.js';
import { projectYearly, isLeap, WD_DE, WD_EN, MONTH_DE, MONTH_EN } from '../../src/js/dates.js';
import { store, defaultState } from '../../src/js/store.js';
import { historyHits, findActive, refreshFind } from '../../src/js/find.js';
import { catName } from '../../src/js/legend.js';
import { t, setLang, getLang } from '../../src/js/i18n.js';
import { holidaysForYear, stateName } from '../../src/js/holidays.js';

// ── local helpers ────────────────────────────────────────────────────────────

/**
 * Build a render model from a pinned window, so nothing depends on the wall
 * clock. `startMonth` is the first visible column.
 */
function model(patch = {}, startMonth = '2026-01', today = '2026-01-15') {
  const st = boardState(patch);
  st.settings.startMonth = startMonth;
  return buildBoard(st, { today });
}

/** Every occurrence of `text` in the model, as `YYYY-MM-DD` strings. */
function occurrenceDates(m, text) {
  const out = [];
  for (const col of m.cols) {
    for (const d of col.days) {
      if (d.empty) continue;
      for (const o of d.allNotes) if (o.note.text === text) out.push(d.date);
    }
  }
  return out;
}

/** Total number of note occurrences rendered anywhere in the model. */
const totalOccurrences = (m) =>
  m.cols.reduce(
    (a, c) => a + c.days.reduce((x, d) => x + (d.empty ? 0 : d.allNotes.length), 0),
    0
  );

/** Seed the singleton store through its public import door. */
function seed(patch = {}) {
  store.replaceAll(boardState(patch));
  return store.state;
}

// ═════════════════════════════════════════════════════════════════════════════
// F9 · YEARLY REPEATS (9.1 – 9.6)
// ═════════════════════════════════════════════════════════════════════════════

describe('F9 · projectYearly — the date rule behind a repeat (9.4)', () => {
  test('an ordinary anchor keeps its month and day in every target year', () => {
    assert.equal(projectYearly('2026-03-14', 2026), '2026-03-14');
    assert.equal(projectYearly('2026-03-14', 2027), '2027-03-14');
    assert.equal(projectYearly('2026-03-14', 2099), '2099-03-14');
  });

  test('Feb 29 lands on Feb 28 in a non-leap year and stays Feb 29 in a leap year', () => {
    assert.equal(projectYearly('2024-02-29', 2024), '2024-02-29');
    assert.equal(projectYearly('2024-02-29', 2025), '2025-02-28');
    assert.equal(projectYearly('2024-02-29', 2026), '2026-02-28');
    assert.equal(projectYearly('2024-02-29', 2027), '2027-02-28');
    assert.equal(projectYearly('2024-02-29', 2028), '2028-02-29');
  });

  test('the century rule is honoured, not approximated by "year % 4"', () => {
    assert.equal(isLeap(1900), false);
    assert.equal(isLeap(2000), true);
    assert.equal(isLeap(2100), false);
    assert.equal(projectYearly('2024-02-29', 1900), '1900-02-28');
    assert.equal(projectYearly('2024-02-29', 2000), '2000-02-29');
    assert.equal(projectYearly('2024-02-29', 2100), '2100-02-28');
  });

  test('Feb 28 is NOT rewritten — only a Feb-29 anchor is special', () => {
    assert.equal(projectYearly('2026-02-28', 2028), '2028-02-28');
    assert.equal(projectYearly('2026-02-28', 2024), '2024-02-28');
  });

  test('Jan 31 / Dec 31 anchors need no fixup — every year has those days', () => {
    assert.equal(projectYearly('2026-01-31', 2027), '2027-01-31');
    assert.equal(projectYearly('2026-12-31', 2030), '2030-12-31');
    assert.equal(projectYearly('2026-03-31', 2031), '2031-03-31');
  });

  test('projectYearly itself is UNGUARDED — the 9.5 "from the anchor year on" rule lives in its caller', () => {
    // Characterization, not a bug: dates.js is pure arithmetic. layout.js is
    // what refuses to walk backwards (see the noteOccurrences tests below).
    assert.equal(projectYearly('2026-06-01', 2000), '2000-06-01');
  });
});

describe('F9 · occurrence generation — 9.1 birthdays survive the roll', () => {
  test('a non-repeating note exists on exactly its own date', () => {
    const m = model({ notes: [note('n1', '2026-03-14', 'Einmal')] });
    assert.deepEqual(occurrenceDates(m, 'Einmal'), ['2026-03-14']);
  });

  test('a repeating note reappears in the next year after the window rolls past it (9.1)', () => {
    // Window Jul 2026 – Jun 2027: the anchor month (Mar 2026) has rolled off
    // the left edge. The one-off is gone; the birthday came back in 2027.
    const m = model(
      {
        notes: [
          note('g', '2026-03-14', 'Geburtstag', { repeatsYearly: true }),
          note('o', '2026-03-14', 'Einmal'),
        ],
      },
      '2026-07'
    );
    assert.equal(m.firstISO, '2026-07-01');
    assert.equal(m.lastISO, '2027-06-30');
    assert.deepEqual(occurrenceDates(m, 'Geburtstag'), ['2027-03-14']);
    assert.deepEqual(occurrenceDates(m, 'Einmal'), []);
  });

  test('a repeat shows in its anchor year too, not only in later years', () => {
    const m = model({ notes: [note('g', '2026-03-14', 'Geburtstag', { repeatsYearly: true })] });
    assert.deepEqual(occurrenceDates(m, 'Geburtstag'), ['2026-03-14']);
  });

  test('a repeat anchored decades back still lands in the current window', () => {
    const m = model({ notes: [note('g', '1974-08-09', 'Papa', { repeatsYearly: true })] });
    assert.deepEqual(occurrenceDates(m, 'Papa'), ['2026-08-09']);
  });

  test('a 12-month window ever contains EXACTLY ONE occurrence of a given series', () => {
    // Structural property of a rolling 12-column board: each (month, day) pair
    // occurs once. This is why find reports "1" for a repeat inside one window.
    for (const start of ['2026-01', '2026-02', '2026-07', '2026-12', '2027-03']) {
      const m = model({ notes: [note('g', '2020-05-20', 'Serie', { repeatsYearly: true })] }, start);
      assert.equal(occurrenceDates(m, 'Serie').length, 1, `window starting ${start}`);
    }
  });

  test('a repeat anchored on the very first / very last day of the window renders', () => {
    const first = model({ notes: [note('a', '2020-01-01', 'Rand', { repeatsYearly: true })] });
    assert.deepEqual(occurrenceDates(first, 'Rand'), ['2026-01-01']);
    const last = model({ notes: [note('b', '2020-12-31', 'Rand', { repeatsYearly: true })] });
    assert.deepEqual(occurrenceDates(last, 'Rand'), ['2026-12-31']);
  });

  test('several series coexist and each keeps its own month/day', () => {
    const m = model({
      notes: [
        note('a', '2019-01-06', 'A', { repeatsYearly: true }),
        note('b', '2021-06-30', 'B', { repeatsYearly: true }),
        note('c', '2024-11-02', 'C', { repeatsYearly: true }),
      ],
    });
    assert.deepEqual(occurrenceDates(m, 'A'), ['2026-01-06']);
    assert.deepEqual(occurrenceDates(m, 'B'), ['2026-06-30']);
    assert.deepEqual(occurrenceDates(m, 'C'), ['2026-11-02']);
  });

  test('an empty board produces no occurrences at all', () => {
    const m = model();
    assert.equal(totalOccurrences(m), 0);
    assert.ok(m.cols.every((c) => c.days.every((d) => d.empty || d.overflow === 0)));
  });
});

describe('F9 · 9.5 — a series exists from its first year onward, never before', () => {
  test('a series anchored after the whole window renders nothing', () => {
    const m = model({ notes: [note('l', '2028-03-01', 'Später', { repeatsYearly: true })] });
    assert.equal(totalOccurrences(m), 0);
  });

  test('paging back before the creation year shows nothing (9.5)', () => {
    const notes = [note('g', '2026-03-14', 'Geburtstag', { repeatsYearly: true })];
    const past = model({ notes }, '2024-01');
    assert.deepEqual(occurrenceDates(past, 'Geburtstag'), []);
    const present = model({ notes }, '2026-01');
    assert.deepEqual(occurrenceDates(present, 'Geburtstag'), ['2026-03-14']);
  });

  test('a window straddling the anchor year clips the pre-anchor half', () => {
    // Anchor Feb 2027; window Jul 2026 – Jun 2027 spans both 2026 and 2027.
    // The 2026 projection is never generated (max(y0, anchorYear)); the 2027
    // one is.
    const m = model({ notes: [note('g', '2027-02-10', 'Neu', { repeatsYearly: true })] }, '2026-07');
    assert.deepEqual(occurrenceDates(m, 'Neu'), ['2027-02-10']);
  });

  test('an anchor whose own occurrence is outside the window is dropped, later years are kept', () => {
    // Anchor Mar 2026; window Jul 2026 – Jun 2027. Year 2026 IS generated but
    // falls outside [firstISO, lastISO] and is filtered; 2027 survives.
    const m = model({ notes: [note('g', '2026-03-14', 'Roll', { repeatsYearly: true })] }, '2026-07');
    assert.deepEqual(occurrenceDates(m, 'Roll'), ['2027-03-14']);
  });

  test('a one-off note is never projected forward, however far the board rolls', () => {
    const notes = [note('o', '2026-03-14', 'Einmal')];
    assert.deepEqual(occurrenceDates(model({ notes }, '2027-01'), 'Einmal'), []);
    assert.deepEqual(occurrenceDates(model({ notes }, '2025-01'), 'Einmal'), []);
  });
});

describe('F9 · 9.4 — Feb-29 series through the real render model', () => {
  test('a leap-day series shows on Feb 28 in a non-leap year', () => {
    const m = model({ notes: [note('f', '2024-02-29', 'Schalttag', { repeatsYearly: true })] });
    assert.equal(isLeap(2026), false);
    assert.deepEqual(occurrenceDates(m, 'Schalttag'), ['2026-02-28']);
    assert.equal(colOf(m, '2026-02').len, 28);
  });

  test('the same series shows on Feb 29 in a leap year', () => {
    const m = model({ notes: [note('f', '2024-02-29', 'Schalttag', { repeatsYearly: true })] }, '2028-01');
    assert.equal(isLeap(2028), true);
    assert.deepEqual(occurrenceDates(m, 'Schalttag'), ['2028-02-29']);
    assert.equal(dayOf(m, '2028-02-28').allNotes.length, 0);
  });

  test('a leap-day series still shows on Feb 29 of its own anchor year', () => {
    const m = model({ notes: [note('f', '2024-02-29', 'Schalttag', { repeatsYearly: true })] }, '2024-01');
    assert.deepEqual(occurrenceDates(m, 'Schalttag'), ['2024-02-29']);
  });

  test('leap-day birthdays never skip a year across a four-year run', () => {
    const notes = [note('f', '2024-02-29', 'Schalttag', { repeatsYearly: true })];
    const seen = ['2024-01', '2025-01', '2026-01', '2027-01', '2028-01'].map(
      (s) => occurrenceDates(model({ notes }, s), 'Schalttag')[0]
    );
    assert.deepEqual(seen, [
      '2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29',
    ]);
  });

  test('a demoted leap-day occurrence shares Feb 28 with a note already sitting there', () => {
    const m = model({
      notes: [
        note('a', '2026-02-28', 'Fix'),
        note('f', '2024-02-29', 'Schalttag', { repeatsYearly: true }),
      ],
    });
    const d = dayOf(m, '2026-02-28');
    assert.deepEqual(d.allNotes.map((o) => o.note.text), ['Fix', 'Schalttag']);
  });

  test('a Feb-29 anchor is NOT rewritten in the store when it is only displayed elsewhere', () => {
    // 9.3: one object per series. Rendering on Feb 28 must not mutate the anchor.
    const notes = [note('f', '2024-02-29', 'Schalttag', { repeatsYearly: true })];
    const m = model({ notes });
    assert.equal(dayOf(m, '2026-02-28').allNotes[0].note.date, '2024-02-29');
    assert.equal(notes[0].date, '2024-02-29');
  });
});

describe('F9 · 9.3 — one object per series, edits and deletes hit the whole series', () => {
  test('every occurrence is the SAME note object, not a copy', () => {
    const st = boardState({ notes: [note('i', '2020-09-10', 'Ident', { repeatsYearly: true })] });
    st.settings.startMonth = '2026-01';
    const m1 = buildBoard(st, { today: '2026-01-01' });
    st.settings.startMonth = '2027-01';
    const m2 = buildBoard(st, { today: '2027-01-01' });

    const a = dayOf(m1, '2026-09-10').allNotes[0].note;
    const b = dayOf(m2, '2027-09-10').allNotes[0].note;
    assert.equal(a, b, 'occurrences must share one identity — there is no per-year object');
    assert.equal(a, st.notes[0], 'and that identity is the stored note itself');
  });

  test('editing the text once changes every year (no exception logic)', () => {
    const st = boardState({ notes: [note('i', '2020-09-10', 'Alt', { repeatsYearly: true })] });
    st.settings.startMonth = '2026-01';
    assert.deepEqual(occurrenceDates(buildBoard(st, { today: '2026-01-01' }), 'Alt'), ['2026-09-10']);

    st.notes[0].text = 'Neu';
    for (const start of ['2026-01', '2027-01', '2030-01']) {
      st.settings.startMonth = start;
      const m = buildBoard(st, { today: `${start}-01` });
      assert.deepEqual(occurrenceDates(m, 'Alt'), [], `stale text survived in ${start}`);
      assert.equal(occurrenceDates(m, 'Neu').length, 1);
    }
  });

  test('deleting the single object deletes every year of the series', () => {
    const st = boardState({ notes: [note('i', '2020-09-10', 'Weg', { repeatsYearly: true })] });
    st.settings.startMonth = '2026-01';
    st.notes = st.notes.filter((n) => n.id !== 'i');
    for (const start of ['2026-01', '2027-01', '2035-01']) {
      st.settings.startMonth = start;
      assert.equal(totalOccurrences(buildBoard(st, { today: `${start}-01` })), 0);
    }
  });

  test('re-anchoring the series moves every year at once', () => {
    const st = boardState({ notes: [note('i', '2020-09-10', 'Umzug', { repeatsYearly: true })] });
    st.settings.startMonth = '2026-01';
    assert.deepEqual(occurrenceDates(buildBoard(st, { today: '2026-01-01' }), 'Umzug'), ['2026-09-10']);
    // 9.3 as interact.js implements it for a dragged repeat: the anchor YEAR is
    // kept, only month/day move.
    st.notes[0].date = '2020-11-03';
    assert.deepEqual(occurrenceDates(buildBoard(st, { today: '2026-01-01' }), 'Umzug'), ['2026-11-03']);
  });

  test('switching a one-off into a series makes it recur from its anchor year on', () => {
    const st = boardState({ notes: [note('i', '2026-04-20', 'Zahnarzt')] });
    st.settings.startMonth = '2027-01';
    assert.deepEqual(occurrenceDates(buildBoard(st, { today: '2027-01-01' }), 'Zahnarzt'), []);
    st.notes[0].repeatsYearly = true;
    assert.deepEqual(occurrenceDates(buildBoard(st, { today: '2027-01-01' }), 'Zahnarzt'), ['2027-04-20']);
  });

  test('switching a series back off leaves only the anchor occurrence', () => {
    const st = boardState({ notes: [note('i', '2026-04-20', 'Zahnarzt', { repeatsYearly: true })] });
    st.settings.startMonth = '2027-01';
    assert.equal(occurrenceDates(buildBoard(st, { today: '2027-01-01' }), 'Zahnarzt').length, 1);
    st.notes[0].repeatsYearly = false;
    assert.deepEqual(occurrenceDates(buildBoard(st, { today: '2027-01-01' }), 'Zahnarzt'), []);
    st.settings.startMonth = '2026-01';
    assert.deepEqual(occurrenceDates(buildBoard(st, { today: '2026-01-01' }), 'Zahnarzt'), ['2026-04-20']);
  });

  test('recolouring the series recolours every occurrence (one categoryId)', () => {
    const st = boardState({ notes: [note('i', '2020-07-07', 'Farbe', { repeatsYearly: true })] });
    st.settings.startMonth = '2026-01';
    const before = dayOf(buildBoard(st, { today: '2026-01-01' }), '2026-07-07').allNotes[0].color;
    st.notes[0].categoryId = CAT[2];
    const after = dayOf(buildBoard(st, { today: '2026-01-01' }), '2026-07-07').allNotes[0].color;
    assert.notEqual(before, after);
    assert.match(after, /^#[0-9a-fA-F]{6}$/);
  });
});

describe('F9 · 9.6 — repeats apply to NOTES ONLY, bars stay one-off', () => {
  test('a bar carrying repeatsYearly is never projected forward', () => {
    const m = model({ bars: [bar('bx', '2024-06-01', '2024-06-05', 'Messe', { repeatsYearly: true })] });
    assert.equal(m.cols.reduce((a, c) => a + c.segs.length, 0), 0);
  });

  test('a bar renders only inside its literal start/end range', () => {
    const m = model({ bars: [bar('b1', '2026-06-01', '2026-06-05', 'Messe', { repeatsYearly: true })] });
    const segs = m.cols.flatMap((c) => c.segs);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].startDay, 1);
    assert.equal(segs[0].endDay, 5);
    const next = model(
      { bars: [bar('b1', '2026-06-01', '2026-06-05', 'Messe', { repeatsYearly: true })] },
      '2027-01'
    );
    assert.equal(next.cols.reduce((a, c) => a + c.segs.length, 0), 0);
  });

  test('the flag on a bar does not leak into the note occurrence machinery either', () => {
    const m = model({
      bars: [bar('bx', '2024-06-01', '2024-06-05', 'Messe', { repeatsYearly: true })],
      notes: [note('n', '2026-06-01', 'Notiz')],
    });
    assert.equal(totalOccurrences(m), 1);
  });
});

describe('F9 · 9.2 — the ↻ marker has data to render from', () => {
  test('the occurrence carries the repeatsYearly flag through to the day cell', () => {
    const m = model({
      notes: [
        note('r', '2020-05-05', 'Wiederkehrend', { repeatsYearly: true }),
        note('o', '2026-05-06', 'Einmalig'),
      ],
    });
    assert.equal(dayOf(m, '2026-05-05').allNotes[0].note.repeatsYearly, true);
    assert.equal(dayOf(m, '2026-05-06').allNotes[0].note.repeatsYearly, false);
  });

  test('a note created by v1 always has an explicit repeatsYearly:false, never undefined', () => {
    // Both creation paths (interact.js startNoteCreate, popover.js addRow) push
    // `repeatsYearly: false`. defaultState ships no notes, so this pins the
    // shape the renderer's `if (n.note.repeatsYearly)` relies on.
    const n = note('x', '2026-01-01', 'x');
    assert.equal(Object.prototype.hasOwnProperty.call(n, 'repeatsYearly'), true);
    assert.equal(n.repeatsYearly, false);
  });
});

describe('F9 · repeats meet the rest of the board', () => {
  test('a repeat in a hidden category disappears entirely, every year', () => {
    const st = boardState({ notes: [note('r', '2020-03-03', 'Versteckt', { repeatsYearly: true })] });
    st.settings.startMonth = '2026-01';
    st.categories[0].visible = false;
    assert.equal(totalOccurrences(buildBoard(st, { today: '2026-01-01' })), 0);
    st.categories[0].visible = true;
    assert.equal(totalOccurrences(buildBoard(st, { today: '2026-01-01' })), 1);
  });

  test('occurrences count against the row capacity like any other note (2.4)', () => {
    const notes = [
      note('a', '2026-08-12', 'Eins'),
      note('b', '2020-08-12', 'Zwei', { repeatsYearly: true }),
      note('c', '2019-08-12', 'Drei', { repeatsYearly: true }),
    ];
    const m = model({ notes, settings: { rowHeight: 22 } });
    assert.equal(m.capacity, 2);
    const d = dayOf(m, '2026-08-12');
    assert.equal(d.allNotes.length, 3);
    assert.equal(d.notes.length, 2);
    assert.equal(d.overflow, 1, 'the third occurrence must become +1, never vanish');
  });

  test('at capacity 3 all three occurrences are shown and nothing overflows', () => {
    const notes = [
      note('a', '2026-08-12', 'Eins'),
      note('b', '2020-08-12', 'Zwei', { repeatsYearly: true }),
      note('c', '2019-08-12', 'Drei', { repeatsYearly: true }),
    ];
    // NOTE: 33, not 32. See the rowCapacity test just below — the settings
    // slider's own maximum cannot actually reach three lines.
    const m = model({ notes, settings: { rowHeight: 33 } });
    assert.equal(rowCapacity(33), 3);
    const d = dayOf(m, '2026-08-12');
    assert.equal(d.notes.length, 3);
    assert.equal(d.overflow, 0);
  });

  test('DISCREPANCY (docs, not spec): the 32 px slider maximum yields TWO lines, not three', () => {
    // DESIGN-DECISIONS §B states "18–20 px → 1 line · 22–31 px → 2 lines ·
    // 32 → 3", but capacity = clamp(floor((rowHeight - 1) / 10.5), 1, 3) gives
    // floor(31 / 10.5) = 2 at rowHeight 32, and settings.js:142 caps the slider
    // at 32. Three lines are therefore unreachable through the UI. The CODE is
    // what is pinned here; no numbered story mentions the line count, so this
    // is a documentation defect, not a spec violation.
    assert.equal(rowCapacity(18), 1);
    assert.equal(rowCapacity(21), 1);
    assert.equal(rowCapacity(22), 2);
    assert.equal(rowCapacity(31), 2);
    assert.equal(rowCapacity(32), 2, 'DESIGN-DECISIONS says 3 here; the code says 2');
    assert.equal(rowCapacity(33), 3);
    const m = model({ notes: [note('a', '2026-08-12', 'x')], settings: { rowHeight: 32 } });
    assert.equal(m.capacity, 2);
  });

  test('at capacity 1 a repeating occurrence demotes the holiday, exactly like a one-off', () => {
    // DESIGN-DECISIONS challenge 2: the user always wins the single line.
    const m = model({
      notes: [note('r', '2020-12-25', 'Weihnachten bei Oma', { repeatsYearly: true })],
      settings: { rowHeight: 18, bundesland: 'BY' },
    });
    assert.equal(m.capacity, 1);
    const d = dayOf(m, '2026-12-25');
    assert.equal(d.notes.length, 1);
    assert.equal(d.holidayShown, false);
    assert.equal(d.holidayDemoted, true);
    assert.ok(d.holiday, 'the holiday still exists for the tinted day number + tooltip');
    assert.equal(d.overflow, 0);
  });

  test('at capacity 2 the holiday keeps line 1 and the occurrence takes line 2', () => {
    const m = model({
      notes: [note('r', '2020-12-25', 'Weihnachten bei Oma', { repeatsYearly: true })],
      settings: { rowHeight: 22, bundesland: 'BY' },
    });
    const d = dayOf(m, '2026-12-25');
    assert.equal(d.holidayShown, true);
    assert.equal(d.holidayDemoted, false);
    assert.equal(d.notes.length, 1);
    assert.equal(d.overflow, 0);
  });

  test('a repeating occurrence on a holiday row pushes a second note into +n at capacity 2', () => {
    const m = model({
      notes: [
        note('r', '2020-12-25', 'Oma', { repeatsYearly: true }),
        note('s', '2026-12-25', 'Opa'),
      ],
      settings: { rowHeight: 22, bundesland: 'BY' },
    });
    const d = dayOf(m, '2026-12-25');
    assert.equal(d.holidayShown, true);
    assert.equal(d.notes.length, 1);
    assert.equal(d.overflow, 1);
    assert.equal(d.allNotes.length, 2, 'allNotes is the popover payload — nothing is lost');
  });

  test('occurrence order follows the order of notes in the store, one-offs and repeats interleaved', () => {
    const m = model({
      notes: [
        note('a', '2026-05-01', 'Erste'),
        note('b', '2020-05-01', 'Zweite', { repeatsYearly: true }),
        note('c', '2026-05-01', 'Dritte'),
      ],
      settings: { rowHeight: 32 },
    });
    assert.deepEqual(
      dayOf(m, '2026-05-01').allNotes.map((o) => o.note.text),
      ['Erste', 'Zweite', 'Dritte']
    );
  });

  test('an occurrence lands on a void row of a short month only if the month has that day', () => {
    // A 30-day month has a void row 31; a Feb-29 series never renders there.
    const m = model({ notes: [note('f', '2024-02-29', 'S', { repeatsYearly: true })] });
    const feb = colOf(m, '2026-02');
    assert.equal(feb.days.length, 31);
    assert.equal(feb.days.filter((d) => d.empty).length, 3);
    assert.ok(feb.days.filter((d) => d.empty).every((d) => d.allNotes === undefined));
  });

  test('a label chip avoids a row occupied by a repeating occurrence (3.7)', () => {
    const m = model({
      notes: [note('r', '2020-06-01', 'Tinte', { repeatsYearly: true })],
      bars: [bar('b1', '2026-06-01', '2026-06-10', 'Projekt')],
      settings: { rowHeight: 22 },
    });
    const seg = colOf(m, '2026-06').segs[0];
    assert.equal(seg.topRow, 0);
    assert.notEqual(seg.labelRow, 0, 'the chip must not sit on the note row');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// F14 · FIND (14.1, 14.2)
// ═════════════════════════════════════════════════════════════════════════════

describe('F14 · historyHits — the store-wide search behind 14.2', () => {
  beforeEach(() => { seed(); });

  test('an empty or whitespace-only query returns no hits', () => {
    seed({ notes: [note('n', '2026-01-05', 'Etwas')] });
    assert.deepEqual(historyHits(''), []);
    assert.deepEqual(historyHits('   '), []);
    assert.deepEqual(historyHits('\t\n '), []);
  });

  test('note text matches case-insensitively, on a substring', () => {
    seed({ notes: [note('n', '2026-01-05', 'Steuererklärung')] });
    for (const q of ['steuer', 'STEUER', 'Erklär', 'ung', 'Steuererklärung']) {
      assert.equal(historyHits(q).length, 1, `query ${q}`);
    }
    assert.deepEqual(historyHits('bilanz'), []);
  });

  test('a hit is trimmed before matching, so a pasted query still works', () => {
    seed({ notes: [note('n', '2026-01-05', 'Steuer')] });
    assert.equal(historyHits('  steuer  ').length, 1);
  });

  test('a note hit reports kind "note", the note date and the raw text', () => {
    seed({ notes: [note('n', '2026-01-05', 'Steuererklärung')] });
    assert.deepEqual(historyHits('steuer'), [
      { kind: 'note', date: '2026-01-05', text: 'Steuererklärung' },
    ]);
  });

  test('a bar hit reports kind "bar" and the bar START date, not its range', () => {
    seed({ bars: [bar('b', '2026-04-02', '2026-09-30', 'Umzug Hamburg')] });
    assert.deepEqual(historyHits('umzug'), [
      { kind: 'bar', date: '2026-04-02', text: 'Umzug Hamburg' },
    ]);
  });

  test('ENTRIES, NOT SEGMENTS: a six-month bar is one hit (DESIGN-DECISIONS)', () => {
    // The same bar wears one label chip per month segment (3.7). Counting the
    // chips would misreport the result count, so the store-wide list keys on
    // the entry.
    const st = boardState({ bars: [bar('b', '2026-02-10', '2026-07-20', 'Projekt')] });
    st.settings.startMonth = '2026-01';
    const m = buildBoard(st, { today: '2026-01-01' });
    const segs = m.cols.flatMap((c) => c.segs);
    assert.equal(segs.length, 6, 'the bar really does render six segments');
    assert.equal(new Set(segs.map((s) => s.bar.id)).size, 1, 'all six share one entry id');

    store.replaceAll(st);
    assert.equal(historyHits('projekt').length, 1, 'but find reports one hit');
  });

  test('a bar with an empty or missing label never matches and never throws', () => {
    seed({
      bars: [
        { id: 'b1', startDate: '2026-02-01', endDate: '2026-02-03', label: '', categoryId: CAT[0] },
        { id: 'b2', startDate: '2026-03-01', endDate: '2026-03-03', categoryId: CAT[0] },
        { id: 'b3', startDate: '2026-04-01', endDate: '2026-04-03', label: null, categoryId: CAT[0] },
      ],
    });
    assert.deepEqual(historyHits('x'), []);
    assert.deepEqual(historyHits('b'), []);
  });

  test('notes and bars are searched together in one result list', () => {
    seed({
      notes: [note('n', '2026-05-04', 'Team Offsite')],
      bars: [bar('b', '2026-08-01', '2026-08-14', 'Team Urlaub')],
    });
    const hits = historyHits('team');
    assert.equal(hits.length, 2);
    assert.deepEqual(hits.map((h) => h.kind), ['note', 'bar']);
  });

  test('results are ordered by date ascending, notes and bars interleaved', () => {
    seed({
      notes: [
        note('n1', '2026-11-01', 'Ziel spät'),
        note('n2', '2024-01-01', 'Ziel früh'),
      ],
      bars: [bar('b1', '2025-06-01', '2025-06-10', 'Ziel mitte')],
    });
    const dates = historyHits('ziel').map((h) => h.date);
    assert.deepEqual(dates, ['2024-01-01', '2025-06-01', '2026-11-01']);
    for (let i = 1; i < dates.length; i++) assert.ok(dates[i - 1] <= dates[i]);
  });

  test('hits on the SAME date all survive; their relative order is not contractual', () => {
    // The comparator is `a.date < b.date ? -1 : 1` — it never returns 0, so the
    // order of equal-dated hits is decided by the engine's sort, not by v1.
    // Pin the SET, not the sequence.
    seed({
      notes: [note('n1', '2026-05-01', 'Alpha eins'), note('n2', '2026-05-01', 'Alpha zwei')],
      bars: [bar('b1', '2026-05-01', '2026-05-02', 'Alpha Balken')],
    });
    const hits = historyHits('alpha');
    assert.equal(hits.length, 3);
    assert.deepEqual(
      hits.map((h) => h.text).sort(),
      ['Alpha Balken', 'Alpha eins', 'Alpha zwei']
    );
    assert.ok(hits.every((h) => h.date === '2026-05-01'));
  });

  test('14.2 — the search is store-wide: hits far outside any 12-month window are returned', () => {
    const st = boardState({
      notes: [
        note('past', '2019-02-02', 'Archiv Umzug'),
        note('now', '2026-02-02', 'Archiv aktuell'),
        note('future', '2031-02-02', 'Archiv später'),
      ],
    });
    st.settings.startMonth = '2026-01';
    const m = buildBoard(st, { today: '2026-01-01' });
    assert.equal(m.firstISO, '2026-01-01');
    assert.equal(m.lastISO, '2026-12-31');

    store.replaceAll(st);
    const hits = historyHits('archiv');
    assert.equal(hits.length, 3);
    // This is exactly the raw material find.js filters with
    // `h.date < m.firstISO || h.date > m.lastISO` to build the off-screen list.
    const offscreen = hits.filter((h) => h.date < m.firstISO || h.date > m.lastISO);
    assert.deepEqual(offscreen.map((h) => h.date), ['2019-02-02', '2031-02-02']);
  });

  test('14.2 — a bar that merely REACHES into the past is keyed to its start date', () => {
    const st = boardState({ bars: [bar('b', '2025-11-01', '2026-03-01', 'Langläufer')] });
    st.settings.startMonth = '2026-01';
    const m = buildBoard(st, { today: '2026-01-01' });
    store.replaceAll(st);
    const h = historyHits('lang')[0];
    assert.equal(h.date, '2025-11-01');
    assert.ok(h.date < m.firstISO, 'so a visible bar can also appear in the off-screen list');
  });

  test('a REPEATING note is one hit, reported at its ANCHOR date — not per occurrence', () => {
    // Asymmetry worth pinning: the on-board hit list (find.js `run`) walks
    // rendered .note nodes, so a repeat contributes one hit per rendered
    // occurrence there. historyHits walks the STORE, where the series is a
    // single object, so it contributes exactly one entry at its anchor.
    seed({ notes: [note('r', '2020-06-06', 'Geburtstag Oma', { repeatsYearly: true })] });
    assert.deepEqual(historyHits('geburtstag'), [
      { kind: 'note', date: '2020-06-06', text: 'Geburtstag Oma' },
    ]);
  });

  test('scratchpads are NOT part of historyHits, although the on-board find does search them', () => {
    // find.js `run()` queries `.board .pad textarea`; historyHits() only walks
    // notes and bars. So a scratchpad match in a rolled-out month cannot appear
    // in the 14.2 off-screen list. Characterized, not judged.
    seed({ scratchpads: { '2026-03': 'Zettelkram und Ideen' } });
    assert.deepEqual(historyHits('zettel'), []);
  });

  test('historyHits does NOT filter by category visibility, unlike the on-board hits', () => {
    // The on-board list can only mark nodes that exist, and a hidden category
    // renders nothing. The store-wide list sees everything.
    const st = boardState({ notes: [note('h', '2026-06-06', 'Versteckt')] });
    st.categories[0].visible = false;
    store.replaceAll(st);
    assert.equal(historyHits('versteckt').length, 1);

    const m = buildBoard(st, { today: '2026-01-01' });
    assert.equal(totalOccurrences(m), 0, 'while the board itself shows nothing');
  });

  test('an empty board yields no hits for any query', () => {
    seed();
    for (const q of ['a', 'e', 'the', '2026']) assert.deepEqual(historyHits(q), []);
  });

  test('the query is matched against text only — dates are not searchable', () => {
    seed({ notes: [note('n', '2026-01-05', 'Termin')] });
    assert.deepEqual(historyHits('2026'), []);
    assert.deepEqual(historyHits('2026-01-05'), []);
  });

  test('a query containing a regex metacharacter is treated as a literal substring', () => {
    seed({ notes: [note('n', '2026-01-05', 'Kosten (netto) +19%')] });
    assert.equal(historyHits('(netto)').length, 1);
    assert.equal(historyHits('+19%').length, 1);
    assert.deepEqual(historyHits('.*'), []);
  });

  test('historyHits returns a fresh array each call — callers may sort or slice it', () => {
    seed({ notes: [note('n', '2026-01-05', 'Etwas')] });
    const a = historyHits('etwas');
    const b = historyHits('etwas');
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
  });

  test('many hits are all returned; the 8-row cap lives in the renderer, not here', () => {
    // renderHistory() slices to 8 and appends a "+n" line. historyHits itself
    // is uncapped — the retrofit must keep it that way or the "+n" lies.
    const notes = Array.from({ length: 20 }, (_, i) =>
      note(`n${i}`, `2026-01-${String(i + 1).padStart(2, '0')}`, `Serie ${i}`)
    );
    seed({ notes });
    assert.equal(historyHits('serie').length, 20);
  });

  test('find is an OVERLAY state, not a screen: it starts inactive (14.1 design note)', () => {
    // findActive() is the flag board.js/main.js consult to decide whether to
    // re-apply hits after a re-render. With no DOM and no ⌘F it must be false,
    // and reading it must not require the module to have been initialised.
    assert.equal(findActive(), false);
    assert.equal(typeof historyHits, 'function');
    assert.equal(typeof refreshFind, 'function');
  });

  test('refreshFind is inert while find is inactive — it never touches the DOM', () => {
    // `if (active) run(...)`. This is what lets board.js call it after every
    // re-render unconditionally. Under Node there is no `document`, so a
    // regression that dropped the guard would throw here.
    assert.doesNotThrow(() => refreshFind());
    assert.equal(findActive(), false);
  });
});

describe('F14 · model-level facts the on-board hit list depends on', () => {
  test('one bar produces many labelled segments — the reason find dedupes by bar id', () => {
    const m = model({ bars: [bar('b', '2026-01-15', '2026-12-15', 'Elternzeit')] });
    const segs = m.cols.flatMap((c) => c.segs);
    assert.equal(segs.length, 12);
    assert.equal(new Set(segs.map((s) => s.bar.id)).size, 1);
    assert.ok(segs.every((s) => typeof s.labelRow === 'number'));
  });

  test('two different bars sharing a label are two entries, not one', () => {
    seed({
      bars: [
        bar('b1', '2026-01-05', '2026-01-10', 'Urlaub'),
        bar('b2', '2026-07-05', '2026-07-20', 'Urlaub'),
      ],
    });
    assert.equal(historyHits('urlaub').length, 2);
  });

  test('two notes with the same text on the same day are two separate places', () => {
    const m = model({ notes: [note('a', '2026-05-01', 'Doppelt'), note('b', '2026-05-01', 'Doppelt')] });
    assert.equal(dayOf(m, '2026-05-01').allNotes.length, 2);
    seed({ notes: [note('a', '2026-05-01', 'Doppelt'), note('b', '2026-05-01', 'Doppelt')] });
    assert.equal(historyHits('doppelt').length, 2);
  });

  test('each occurrence of a series is a distinct dated place on the board', () => {
    const st = boardState({ notes: [note('r', '2020-03-03', 'Serie', { repeatsYearly: true })] });
    const dates = ['2026-01', '2027-01', '2028-01'].map((s) => {
      st.settings.startMonth = s;
      return occurrenceDates(buildBoard(st, { today: `${s}-01` }), 'Serie')[0];
    });
    assert.deepEqual(dates, ['2026-03-03', '2027-03-03', '2028-03-03']);
    assert.equal(new Set(dates).size, 3);
  });

  test('scratchpad text lives on the column, which is what the on-board find reads', () => {
    const m = model({ scratchpads: { '2026-03': 'Zettelkram', '2026-09': '' } });
    assert.equal(colOf(m, '2026-03').pad, 'Zettelkram');
    assert.equal(colOf(m, '2026-09').pad, '');
    assert.equal(colOf(m, '2026-04').pad, '', 'a month with no pad defaults to empty string');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// F13.7 · LANGUAGE — German default, English toggle
// ═════════════════════════════════════════════════════════════════════════════

describe('F13.7 · i18n table and language switch', () => {
  beforeEach(() => { setLang('de'); });

  test('German is the default language before anything is set', () => {
    assert.equal(getLang(), 'de');
    assert.equal(t('today'), 'Heute');
    assert.equal(t('feiertage'), 'Feiertage');
    assert.equal(t('schulferien'), 'Schulferien');
    assert.equal(t('settings'), 'Einstellungen');
  });

  test('defaultState ships language "de" — the store agrees with the module', () => {
    assert.equal(defaultState().settings.language, 'de');
  });

  test('setLang("en") switches the whole table', () => {
    setLang('en');
    assert.equal(getLang(), 'en');
    assert.equal(t('today'), 'Today');
    assert.equal(t('feiertage'), 'Public holidays');
    assert.equal(t('schulferien'), 'School holidays');
    assert.equal(t('settings'), 'Settings');
  });

  test('setLang back to "de" restores the German table (the toggle is symmetric)', () => {
    setLang('en');
    setLang('de');
    assert.equal(getLang(), 'de');
    assert.equal(t('today'), 'Heute');
  });

  test('an unknown, empty or nullish language falls back to German', () => {
    for (const bad of ['fr', '', null, undefined, 'DE', 'EN', 0, {}]) {
      setLang('en');
      setLang(bad);
      assert.equal(getLang(), 'de', `setLang(${JSON.stringify(bad)})`);
      assert.equal(t('today'), 'Heute');
    }
  });

  test('English is an OVERLAY of German — keys it does not restate fall through', () => {
    setLang('en');
    assert.equal(t('appName'), 'LangzeitPlaner');
    assert.equal(t('print_generated'), 'LangzeitPlaner');
    setLang('de');
    assert.equal(t('appName'), 'LangzeitPlaner');
    assert.equal(t('print_generated'), 'LangzeitPlaner');
  });

  test('an unknown key returns the key itself, in both languages', () => {
    assert.equal(t('nope_not_a_key'), 'nope_not_a_key');
    setLang('en');
    assert.equal(t('nope_not_a_key'), 'nope_not_a_key');
  });

  test('function-valued entries are invoked with their arguments, per language', () => {
    assert.equal(t('reassignBody', 1, 'Arbeit'), '„Arbeit“ hat 1 Eintrag. Wohin damit?');
    assert.equal(t('reassignBody', 3, 'Arbeit'), '„Arbeit“ hat 3 Einträge. Wohin damit?');
    assert.equal(t('reassignBody', 0, 'Arbeit'), '„Arbeit“ hat 0 Einträge. Wohin damit?');
    setLang('en');
    assert.equal(t('reassignBody', 1, 'Work'), '“Work” has 1 entry. Move them where?');
    assert.equal(t('reassignBody', 3, 'Work'), '“Work” has 3 entries. Move them where?');
  });

  test('restoreBody interpolates the day in both languages', () => {
    assert.match(t('restoreBody', '2026-08-01'), /^Das Board wird auf den Stand von 2026-08-01/);
    setLang('en');
    assert.match(t('restoreBody', '2026-08-01'), /state from 2026-08-01\.$/);
  });

  test('the find-specific strings are localised (14.1 counter, 14.2 heading)', () => {
    assert.equal(t('find'), 'Suchen');
    assert.equal(t('noResults'), 'keine Treffer');
    assert.equal(t('historyHitsLabel'), 'Außerhalb des Zeitraums');
    setLang('en');
    assert.equal(t('find'), 'Find');
    assert.equal(t('noResults'), 'no matches');
    assert.equal(t('historyHitsLabel'), 'Outside the visible range');
  });

  test('the repeat toggle label is localised (9.1 popover control)', () => {
    assert.equal(t('repeatsYearly'), 'Jährlich wiederholen');
    setLang('en');
    assert.equal(t('repeatsYearly'), 'Repeats yearly');
  });

  test('the overflow words used by "+n" tooltips are localised (2.4 / 3.8)', () => {
    assert.equal(t('more'), 'weitere');
    assert.equal(t('lanesFull'), 'weitere Balken');
    setLang('en');
    assert.equal(t('more'), 'more');
    assert.equal(t('lanesFull'), 'more bars');
  });

  test('every key probed here resolves to a non-empty string in both languages', () => {
    const keys = [
      'appName', 'today', 'feiertage', 'schulferien', 'categories', 'find', 'print',
      'settings', 'export', 'import', 'scratchpad', 'edit', 'done', 'cancel', 'save',
      'delete', 'close', 'addNote', 'entries', 'entry', 'barsHere', 'continues',
      'layers', 'mode', 'rolling', 'pinned', 'repeatsYearly', 'noResults', 'ofHits',
      'language', 'bundesland', 'bundeslandNone', 'pickBundesland', 'ferienHorizon',
      'ferienUnverified', 'launchAtLogin', 'menuBarIcon', 'rowHeight', 'colWidth',
      'paper', 'snapshots', 'restore', 'noSnapshots', 'newCategory', 'renameCategory',
      'deleteCategory', 'reassignTitle', 'reassignTo', 'importConfirm', 'importBody',
      'restoreConfirm', 'replace', 'firstRunTitle', 'firstRunBody', 'firstRunState',
      'emptyHint', 'showOtherStates', 'ferienPattern', 'ferienPatternHint',
      'gatekeeper', 'more', 'lanesFull', 'historyHitsLabel', 'pinnedToHistory',
      'print_generated', 'yearBack', 'yearFwd', 'density', 'appearance', 'data',
      'window', 'shortcutHint', 'untitledBar', 'hidden',
    ];
    // Five English labels are legitimately spelled exactly like their key, so
    // they cannot take part in the "did not fall through to the key" check.
    // (In German none of them are — checked below.)
    const spellsItsOwnKey = new Set(['edit', 'entries', 'entry', 'more', 'hidden']);
    for (const lang of ['de', 'en']) {
      setLang(lang);
      for (const k of keys) {
        const v = t(k);
        assert.equal(typeof v, 'string', `${lang}.${k} is not a string`);
        assert.ok(v.length > 0, `${lang}.${k} is empty`);
        if (!spellsItsOwnKey.has(k)) {
          assert.notEqual(v, k, `${lang}.${k} fell through to the key name`);
        }
      }
    }
    setLang('en');
    assert.deepEqual(
      [...spellsItsOwnKey].map((k) => t(k)),
      ['edit', 'entries', 'entry', 'more', 'hidden'],
      'these English labels really are their own key names'
    );
    setLang('de');
    assert.deepEqual(
      [...spellsItsOwnKey].map((k) => t(k)),
      ['bearbeiten', 'Einträge', 'Eintrag', 'weitere', 'ausgeblendet'],
      'and none of them collide with a key name in German'
    );
  });

  test('the two tables genuinely differ where they should — no untranslated leftovers', () => {
    const mustDiffer = [
      'today', 'feiertage', 'schulferien', 'categories', 'find', 'settings',
      'scratchpad', 'done', 'cancel', 'save', 'delete', 'close', 'entries', 'entry',
      'rolling', 'pinned', 'repeatsYearly', 'noResults', 'language', 'bundesland',
      'more', 'lanesFull', 'historyHitsLabel', 'density', 'appearance', 'window',
    ];
    const de = {};
    setLang('de');
    for (const k of mustDiffer) de[k] = t(k);
    setLang('en');
    for (const k of mustDiffer) assert.notEqual(t(k), de[k], `${k} is identical in DE and EN`);
  });

  test('a few strings are deliberately identical in both tables', () => {
    for (const k of ['appName', 'print_generated']) {
      setLang('de');
      const d = t(k);
      setLang('en');
      assert.equal(t(k), d, `${k} should be the same in both languages`);
    }
    // 'import'/'export' are cognates but are still restated in EN.
    setLang('en');
    assert.equal(t('print'), 'Print');
  });
});

describe('F13.7 · weekday abbreviations stay language-specific', () => {
  beforeEach(() => { setLang('de'); });

  test('the tables are Sunday-first and seven long', () => {
    assert.equal(WD_DE.length, 7);
    assert.equal(WD_EN.length, 7);
    assert.equal(WD_DE[0], 'So');
    assert.equal(WD_EN[0], 'Su');
    assert.deepEqual(WD_DE, ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']);
    assert.deepEqual(WD_EN, ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']);
  });

  test('the three abbreviations a German reader would stumble over are different', () => {
    // Su/So, Tu/Di, We/Mi, Th/Do — Mo, Fr and Sa are shared.
    assert.notEqual(WD_DE[0], WD_EN[0]);
    assert.notEqual(WD_DE[2], WD_EN[2]);
    assert.notEqual(WD_DE[3], WD_EN[3]);
    assert.notEqual(WD_DE[4], WD_EN[4]);
    assert.equal(WD_DE[1], WD_EN[1]);
    assert.equal(WD_DE[5], WD_EN[5]);
    assert.equal(WD_DE[6], WD_EN[6]);
  });

  test('the board renders German abbreviations when settings.language is de', () => {
    const m = model({ settings: { language: 'de' } });
    assert.equal(dayOf(m, '2026-01-01').wd, 'Do'); // a Thursday
    assert.equal(dayOf(m, '2026-01-04').wd, 'So');
    assert.equal(dayOf(m, '2026-01-07').wd, 'Mi');
  });

  test('the board renders English abbreviations when settings.language is en', () => {
    const m = model({ settings: { language: 'en' } });
    assert.equal(dayOf(m, '2026-01-01').wd, 'Th');
    assert.equal(dayOf(m, '2026-01-04').wd, 'Su');
    assert.equal(dayOf(m, '2026-01-07').wd, 'We');
  });

  test('an unknown settings.language falls back to German in the model too', () => {
    const m = model({ settings: { language: 'fr' } });
    assert.equal(dayOf(m, '2026-01-07').wd, 'Mi');
    assert.equal(colOf(m, '2026-03').fullLabel, 'März 2026');
  });

  test('THE MODEL READS settings.language, NOT the i18n module state', () => {
    // Characterization of a real coupling: buildBoard() never calls getLang().
    // main.js keeps the two in sync (setLang(store.state.settings.language)).
    // A retrofit that only flips the i18n module would silently leave the board
    // in the old language — this test is the alarm.
    setLang('en');
    const m = model({ settings: { language: 'de' } });
    assert.equal(dayOf(m, '2026-01-07').wd, 'Mi');
    assert.equal(colOf(m, '2026-03').label, 'März ’26');
    setLang('de');
  });
});

describe('F13.7 · month labels', () => {
  test('the month tables are twelve long and January-first', () => {
    assert.equal(MONTH_DE.length, 12);
    assert.equal(MONTH_EN.length, 12);
    assert.equal(MONTH_DE[0], 'Januar');
    assert.equal(MONTH_EN[0], 'January');
    assert.equal(MONTH_DE[11], 'Dezember');
    assert.equal(MONTH_EN[11], 'December');
  });

  test('German column heads are the first three letters, umlaut included', () => {
    const m = model({ settings: { language: 'de' } });
    assert.deepEqual(
      m.cols.map((c) => c.label),
      ['Januar ’26', 'Februar ’26', 'März ’26', 'April ’26', 'Mai ’26', 'Juni ’26',
       'Juli ’26', 'August ’26', 'September ’26', 'Oktober ’26', 'November ’26', 'Dezember ’26']
    );
  });

  test('English column heads use the English three-letter forms', () => {
    const m = model({ settings: { language: 'en' } });
    assert.deepEqual(
      m.cols.map((c) => c.label),
      ['January ’26', 'February ’26', 'March ’26', 'April ’26', 'May ’26', 'June ’26',
       'July ’26', 'August ’26', 'September ’26', 'October ’26', 'November ’26', 'December ’26']
    );
  });

  test('the tooltip label is the full month name plus the four-digit year', () => {
    assert.equal(colOf(model({ settings: { language: 'de' } }), '2026-03').fullLabel, 'März 2026');
    assert.equal(colOf(model({ settings: { language: 'en' } }), '2026-03').fullLabel, 'March 2026');
  });

  test('the year suffix is the last two digits and survives a year boundary', () => {
    const m = model({ settings: { language: 'de' } }, '2026-07');
    assert.equal(m.cols[0].label, 'Juli ’26');
    assert.equal(m.cols[6].label, 'Januar ’27');
    assert.equal(m.cols[11].label, 'Juni ’27');
  });
});

describe('F13.7 · holiday and Bundesland names follow the language', () => {
  test('holidaysForYear returns German names by default and English on request', () => {
    const de = holidaysForYear(2026, 'BY', 'de');
    const en = holidaysForYear(2026, 'BY', 'en');
    assert.equal(de.get('2026-01-01').name, 'Neujahr');
    assert.equal(en.get('2026-01-01').name, "New Year's Day");
    assert.equal(de.get('2026-01-06').name, 'Heilige Drei Könige');
    assert.equal(en.get('2026-01-06').name, 'Epiphany');
    assert.equal(de.get('2026-12-26').name, '2. Weihnachtstag');
    assert.equal(en.get('2026-12-26').name, 'Boxing Day');
  });

  test('an omitted or unknown lang argument yields German', () => {
    assert.equal(holidaysForYear(2026, '').get('2026-10-03').name, 'Tag der Deutschen Einheit');
    assert.equal(holidaysForYear(2026, '', 'fr').get('2026-10-03').name, 'Tag der Deutschen Einheit');
  });

  test('the short forms are localised too, and only where the full name is long', () => {
    assert.equal(holidaysForYear(2026, '', 'de').get('2026-10-03').short, 'Dt. Einheit');
    assert.equal(holidaysForYear(2026, '', 'en').get('2026-10-03').short, 'Unity Day');
    assert.equal(holidaysForYear(2026, '', 'de').get('2026-01-01').short, 'Neujahr');
    assert.equal(holidaysForYear(2026, '', 'en').get('2026-01-01').short, "New Year's Day");
  });

  test('Buß- und Bettag has both a localised name and a localised short form', () => {
    const de = holidaysForYear(2026, 'SN', 'de');
    const en = holidaysForYear(2026, 'SN', 'en');
    const day = '2026-11-18';
    assert.equal(de.get(day).name, 'Buß- und Bettag');
    assert.equal(de.get(day).short, 'Buß- u. Bettag');
    assert.equal(en.get(day).name, 'Repentance and Prayer Day');
    assert.equal(en.get(day).short, 'Repentance Day');
  });

  test('the language does not change WHICH dates are holidays, only their names', () => {
    const de = [...holidaysForYear(2026, 'BY', 'de').keys()].sort();
    const en = [...holidaysForYear(2026, 'BY', 'en').keys()].sort();
    assert.deepEqual(de, en);
    const ownDe = [...holidaysForYear(2026, 'BY', 'de').values()].filter((h) => h.own).length;
    const ownEn = [...holidaysForYear(2026, 'BY', 'en').values()].filter((h) => h.own).length;
    assert.equal(ownDe, ownEn);
  });

  test('the board picks the holiday language from settings.language', () => {
    const de = model({ settings: { language: 'de', bundesland: 'BY' } });
    const en = model({ settings: { language: 'en', bundesland: 'BY' } });
    assert.equal(dayOf(de, '2026-01-06').holiday.name, 'Heilige Drei Könige');
    assert.equal(dayOf(en, '2026-01-06').holiday.name, 'Epiphany');
  });

  test('Bundesland names are localised where the English form differs', () => {
    assert.equal(stateName('BY', 'de'), 'Bayern');
    assert.equal(stateName('BY', 'en'), 'Bavaria');
    assert.equal(stateName('NI', 'en'), 'Lower Saxony');
    assert.equal(stateName('NW', 'en'), 'North Rhine-Westphalia');
    assert.equal(stateName('HE', 'en'), 'Hesse');
    assert.equal(stateName('TH', 'en'), 'Thuringia');
  });

  test('Bundesland names that need no translation are identical', () => {
    for (const code of ['BE', 'BB', 'HB', 'HH', 'SL', 'SH', 'MV', 'BW']) {
      assert.equal(stateName(code, 'de'), stateName(code, 'en'), code);
    }
  });

  test('an unknown Bundesland code passes through unchanged', () => {
    assert.equal(stateName('XX', 'de'), 'XX');
    assert.equal(stateName('XX', 'en'), 'XX');
  });

  test('the empty code names the nationwide-only option in both languages', () => {
    assert.equal(stateName('', 'de'), 'Nur bundesweite Feiertage');
    assert.equal(stateName('', 'en'), 'Nationwide holidays only');
  });
});

describe('F13.7 · category names are per language (DESIGN-DECISIONS)', () => {
  beforeEach(() => { setLang('de'); });

  test('the four shipped categories carry both a German and an English label', () => {
    const cats = defaultState().categories;
    assert.deepEqual(cats.map((c) => c.name), ['Arbeit', 'Familie', 'Reisen', 'Deadlines']);
    assert.deepEqual(cats.map((c) => c.nameEn), ['Work', 'Family', 'Travel', 'Deadlines']);
  });

  test('catName picks the English label only in English', () => {
    const c = { name: 'Arbeit', nameEn: 'Work' };
    assert.equal(catName(c, 'de'), 'Arbeit');
    assert.equal(catName(c, 'en'), 'Work');
  });

  test('catName falls back to the German label for any non-English language', () => {
    const c = { name: 'Arbeit', nameEn: 'Work' };
    for (const lang of [undefined, null, '', 'de', 'fr', 'EN']) {
      assert.equal(catName(c, lang), 'Arbeit', `lang ${JSON.stringify(lang)}`);
    }
  });

  test('a category with no English label shows its German name in English too', () => {
    // This is the observable consequence of legend.js:116 — renaming in the
    // German UI does `delete x.nameEn`, so the English side follows the German
    // name from then on. See the DISCREPANCY note at the bottom of this file.
    assert.equal(catName({ name: 'Garten' }, 'en'), 'Garten');
    assert.equal(catName({ name: 'Garten', nameEn: '' }, 'en'), 'Garten');
    assert.equal(catName({ name: 'Garten', nameEn: null }, 'en'), 'Garten');
    assert.equal(catName({ name: 'Garten', nameEn: undefined }, 'en'), 'Garten');
  });

  test('renaming in ENGLISH leaves the German label untouched', () => {
    // The direction DESIGN-DECISIONS promises, expressed as state: the EN
    // rename writes nameEn only.
    const c = { name: 'Arbeit', nameEn: 'Work' };
    c.nameEn = 'Day job';
    assert.equal(catName(c, 'en'), 'Day job');
    assert.equal(catName(c, 'de'), 'Arbeit');
  });

  test('renaming in GERMAN drops the English label — both sides then read the German name', () => {
    // Characterizing legend.js:116, which does `{ x.name = v; delete x.nameEn }`.
    const c = { name: 'Arbeit', nameEn: 'Work' };
    c.name = 'Büro';
    delete c.nameEn;
    assert.equal(catName(c, 'de'), 'Büro');
    assert.equal(catName(c, 'en'), 'Büro');
  });

  test('the language of a category label never affects which entries belong to it', () => {
    const st = boardState({ notes: [note('n', '2026-05-05', 'Notiz')] });
    st.categories[0].nameEn = 'Day job';
    st.settings.startMonth = '2026-01';
    for (const lang of ['de', 'en']) {
      st.settings.language = lang;
      const m = buildBoard(st, { today: '2026-01-01' });
      assert.equal(dayOf(m, '2026-05-05').allNotes.length, 1, lang);
    }
  });

  test('a category id, not its name, is what an entry references', () => {
    const st = boardState({ notes: [note('n', '2026-05-05', 'Notiz')] });
    assert.equal(st.notes[0].categoryId, CAT[0]);
    st.categories[0].name = 'Ganz anders';
    st.settings.startMonth = '2026-01';
    assert.equal(totalOccurrences(buildBoard(st, { today: '2026-01-01' })), 1);
  });
});

describe('F13.7 · language never changes board geometry or content', () => {
  test('the same board renders the same day count and the same notes in either language', () => {
    const notes = [
      note('a', '2026-03-14', 'Geburtstag', { repeatsYearly: true }),
      note('b', '2026-07-01', 'Einmal'),
    ];
    const bars = [bar('b1', '2026-02-10', '2026-05-20', 'Projekt')];
    const de = model({ notes, bars, settings: { language: 'de', bundesland: 'BY' } });
    const en = model({ notes, bars, settings: { language: 'en', bundesland: 'BY' } });

    assert.equal(de.firstISO, en.firstISO);
    assert.equal(de.lastISO, en.lastISO);
    assert.equal(de.capacity, en.capacity);
    assert.equal(totalOccurrences(de), totalOccurrences(en));
    assert.deepEqual(
      de.cols.map((c) => c.segs.length),
      en.cols.map((c) => c.segs.length)
    );
    assert.deepEqual(
      de.cols.map((c) => c.days.filter((d) => !d.empty).length),
      en.cols.map((c) => c.days.filter((d) => !d.empty).length)
    );
  });

  test('switching language does not move a Feb-29 series', () => {
    const notes = [note('f', '2024-02-29', 'Schalttag', { repeatsYearly: true })];
    assert.deepEqual(
      occurrenceDates(model({ notes, settings: { language: 'de' } }), 'Schalttag'),
      occurrenceDates(model({ notes, settings: { language: 'en' } }), 'Schalttag')
    );
  });

  test('switching language does not change what find matches', () => {
    const st = boardState({ notes: [note('n', '2026-05-05', 'Steuer')] });
    st.settings.language = 'de';
    store.replaceAll(st);
    const de = historyHits('steuer');
    st.settings.language = 'en';
    store.replaceAll(st);
    assert.deepEqual(historyHits('steuer'), de);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TIER 2 GAPS — behaviour in scope for these stories that a real WKWebView must
// cover, because it only exists once there is a DOM. Nothing below is asserted
// here; it is recorded so the gap is visible rather than assumed away.
//
//  9.1  Right-click a day opens the popover, which is the only path to the ↻
//       toggle on an uncrowded day (DESIGN-DECISIONS, story audit).
//  9.2  board.js renderNote() prepends <span class="rep">↻</span> BEFORE the
//       text so truncation cannot eat it.
//  9.3  popover.js toggle-repeat re-anchors `x.date = date` — the series starts
//       in the year the user switched it on, at the occurrence they clicked.
//  9.3  interact.js move-note for a repeat keeps the anchor YEAR and moves only
//       month/day (`iso(anchorY, tgt.m, tgt.d)`).
//  9.3  popover.js notesOn() is a second, independent implementation of the
//       occurrence rule (`Number(n.date.slice(0,4)) > y` + projectYearly); it
//       must keep agreeing with layout.js noteOccurrences().
//  14.1 The overlay itself: body.finding, .hit / .current classes, ⌘F focus,
//       Enter / ⇧Enter stepping with wraparound, the "n/m" counter, Esc.
//  14.1 The dedupe that makes find count ENTRIES not SEGMENTS: run() skips a
//       second .bar-label with the same data-bar-id, then lights every .bar
//       stripe sharing that id. Notes are never deduped (no note-id check), so
//       each rendered occurrence is its own hit.
//  14.1 Scratchpad matching reads textarea.value, not textContent.
//  14.2 offscreenHits() filters historyHits() by the live model's
//       firstISO/lastISO; renderHistory() caps the list at 8 with a "+n" row
//       and mousedown-preventDefault to keep input focus; clicking a row pins
//       the board to that month.
//  13.7 settings.js writes settings.language AND calls setLang() — the two
//       stores of language state are only kept in sync there and in main.js.
//  13.7 legend.js catRow rename: `lang === 'en' ? nameEn = v : (name = v,
//       delete nameEn)`, and the new-category default that writes both slots.
// ─────────────────────────────────────────────────────────────────────────────
