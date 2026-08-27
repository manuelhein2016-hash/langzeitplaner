// ─────────────────────────────────────────────────────────────────────────────
// ROUND 6 — ADVERSARY, ATTACK 4: THE COERCION CLASS BOUNDARY, RE-MEASURED
//
// R5-11's rule is exactly right and this file does not dispute it:
//
//   > v1 does not PARSE a bar edge, it COMPARES it (`layout.js:133`). So the faithful v2 value is
//   > not "the day this text means" (it means none) but "a date that sorts where this text
//   > sorted".
//
// `coerceToV1BarEdge` implements that rule for the two classes where such a date exists — text
// BELOW `'0000-01-01'` and text ABOVE `'9999-12-31'` — and §1 confirms, against `buildBoard`, that
// both ends are now byte-faithful. R5-9, R5-10 and R5-12a/b/c all still hold.
//
// §2 is the boundary itself. The register records the residual as one class:
//
//   > "A VALUE THAT SORTS INSIDE THE RANGE … keeps today's behaviour (the field is dropped, the
//   >  bar runs to the horizon)."
//
// That is only half of what is inside the range. `coerceToV1BarEdge` runs FIRST and answers null
// for an inside-range string; the value then falls through to `coerceToV1Date`, which is the
// M10 / R4-9 fix, and which READS IT AS A DAY. Every non-ISO shape `coerceToV1Date` accepts —
// `2026-3-1`, `4.3.2026`, `2026/03/04`, `20260304` — sorts inside the range. So on a bar edge
// they are not dropped: a date the file never held is WRITTEN INTO `board.json`, at a position v1
// never painted, and in both directions at once. `startDate: '4.3.2026'` is a bar v1 drew NOWHERE
// and v2 draws across ten columns — R5-11's own headline sentence, on the shapes R5-11 did not
// look at, produced by the OTHER coercer.
//
// §3 re-measures the class the register does describe, so the two are not confused.
//
// The oracle throughout is `src/js/layout.js`, unchanged since the v1 baseline `66126e9`.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { oracle, v1board, note, bar } from './_regression-harness.js';
import { buildBoard } from '../../src/js/layout.js';
import { EARLIEST_DATE, LATEST_DATE, isDateString } from '../../src/js/core/entities.js';

const TODAY = '2026-06-15';

/** Every segment the v1 renderer paints, with its column and its continuation chevrons. */
function segs(state) {
  const b = buildBoard(state, { today: TODAY });
  const out = [];
  for (const col of b.cols) {
    for (const s of col.segs ?? []) out.push(`${col.key ?? col.month}:${s.startDay}-${s.endDay}${s.contTop ? '^' : ''}${s.contBot ? 'v' : ''}`);
  }
  return out;
}
const B = (extra) => ({ id: 'b', label: 'Projekt', categoryId: 'cat-1', ...extra });

/** Paint one bar with one edge, in v1 and in v2, from the same bytes. */
async function edge(field, value) {
  const o = await oracle(v1board({ bars: [B({ [field]: value })] }));
  return { v1: segs(o.v1), v2: segs(o.core), wrote: o.core.bars[0] ? o.core.bars[0][field] : undefined };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. BOTH ENDS OF THE ALPHABET ARE STILL FAITHFUL — R5-9/10/11 as controls
// ─────────────────────────────────────────────────────────────────────────────

describe('R6-9 · the R5-11 fix still holds on both sides', () => {
  const BELOW = ['', ' ', '-', '.', '!', '/', '(offen)', '0', '00', '000', '0000-01-00', ' 2026-03-04'];
  const ABOVE = [':', ';', 'A', 'a', 'ä', 'zzz', 'irgendwann', 'unbekannt', '9999-12-32'];

  test('R6-9a FAILED (held) · every string BELOW the alphabet paints exactly what v1 painted', async () => {
    for (const v of BELOW) {
      assert.ok(v < EARLIEST_DATE && !isDateString(v), `${JSON.stringify(v)} really is below the alphabet`);
      for (const field of ['startDate', 'endDate']) {
        const r = await edge(field, v);
        assert.deepEqual(r.v2, r.v1, `${field} = ${JSON.stringify(v)}`);
        assert.equal(r.wrote, EARLIEST_DATE, `${field} = ${JSON.stringify(v)} is kept as the earliest date`);
      }
    }
  });

  test('R6-9b FAILED (held) · every string ABOVE the alphabet paints exactly what v1 painted', async () => {
    for (const v of ABOVE) {
      assert.ok(v > LATEST_DATE && !isDateString(v), `${JSON.stringify(v)} really is above the alphabet`);
      for (const field of ['startDate', 'endDate']) {
        const r = await edge(field, v);
        assert.deepEqual(r.v2, r.v1, `${field} = ${JSON.stringify(v)}`);
        assert.equal(r.wrote, LATEST_DATE, `${field} = ${JSON.stringify(v)} is kept as the latest date`);
      }
    }
  });

  test('R6-9c FAILED (held) · R5-9\'s eight ordinary shapes still paint identically', async () => {
    const SHAPES = [
      [{ startDate: '2026-03-01', endDate: '2026-03-20' }, 1],
      [{ startDate: '2026-03-20', endDate: '2026-03-01' }, 1],
      [{ startDate: '2026-03-04', endDate: '2026-03-04' }, 1],
      [{ startDate: '2026-03-01' }, 10],
      [{ endDate: '2026-03-20' }, 3],
      [{}, 12],
      [{ startDate: '2019-01-01' }, 12],
      [{ endDate: '2099-01-01' }, 12],
    ];
    for (const [b, n] of SHAPES) {
      const o = await oracle(v1board({ bars: [B(b)] }));
      assert.deepEqual(segs(o.core), segs(o.v1), JSON.stringify(b));
      assert.equal(segs(o.v1).length, n, `${JSON.stringify(b)} really is ${n} segment(s)`);
    }
  });

  test('R6-9d FAILED (held) · R5-12: an ISO TAIL still names the same day, and the columns are identical', async () => {
    // R5-12d's accepted claim is "the tail is a SHAPE, and nothing in it may change which day the
    // value names". Measured on a bar edge, where v1 does not parse at all: the COLUMN SET is
    // identical in both builds, and v2 differs only by naming the day v1 rendered as `NaN`.
    for (const [field, v] of [['startDate', '2026-03-04T09:00'], ['endDate', '2026-03-04T09:00'],
      ['startDate', '2026-01-01T09:00'], ['endDate', '2026-01-01T09:00']]) {
      const r = await edge(field, v);
      assert.equal(r.v2.length, r.v1.length, `${field} = ${v}: the same number of columns`);
      assert.deepEqual(r.v2.map((x) => x.split(':')[0]), r.v1.map((x) => x.split(':')[0]),
        `${field} = ${v}: the same columns`);
      assert.ok(r.v1.some((x) => /NaN/.test(x)), 'and the only difference is a day v1 rendered as NaN');
      assert.ok(!r.v2.some((x) => /NaN/.test(x)));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE SIDE OF THE BOUNDARY THE REGISTER DOES NOT DESCRIBE
//
// Inside the range, R5-11's rule says "no faithful value exists". `coerceToV1Date` does not agree
// — it supplies one, from a different question ("what day does this name?"), which is the one
// question v1 never asks about a bar edge.
// ─────────────────────────────────────────────────────────────────────────────

describe('R6-10 · `coerceToV1Date` is applied to a value v1 never parsed', () => {
  const ACCEPTED = ['2026-3-1', '4.3.2026', '2026/03/04', '20260304'];

  test('R6-10a SUCCEEDED (defect) · startDate: a bar v1 drew NOWHERE, drawn across ten columns', async () => {
    for (const v of ACCEPTED) {
      assert.ok(v > EARLIEST_DATE && v < LATEST_DATE, `${JSON.stringify(v)} sorts INSIDE the alphabet…`);
      assert.ok(!isDateString(v), '…and is not a date, so `coerceToV1BarEdge` answers null');
      const r = await edge('startDate', v);
      assert.deepEqual(r.v1, [], `v1 painted ${JSON.stringify(v)} on NO day of the year`);
      assert.equal(r.v2.length, 10, `v2 paints it across ten columns (${JSON.stringify(v)})`);
      assert.ok(isDateString(r.wrote), `and WRITES ${JSON.stringify(r.wrote)} into board.json — a date the file never held`);
    }
  });

  test('R6-10b SUCCEEDED (defect) · endDate: a bar v1 ran across the whole year, cut to three columns', async () => {
    for (const v of ACCEPTED) {
      const r = await edge('endDate', v);
      assert.equal(r.v1.length, 12, `v1 ran ${JSON.stringify(v)} across all twelve columns`);
      assert.ok(r.v1.every((x) => /v$/.test(x)), 'with the "continues past" chevron on every one');
      assert.equal(r.v2.length, 3, `v2 stops it after three (${JSON.stringify(v)})`);
    }
  });

  test('R6-10c SUCCEEDED (defect) · it takes a lane from every real bar, in ten of the twelve columns', async () => {
    // R5-11's cost sentence, in the direction nobody measured: the invented bar is not merely
    // wrong, it competes for lanes with the bars the user actually made.
    const board = v1board({
      bars: [
        bar('ok1', '2026-07-01', '2026-07-20', 'A'),
        bar('ok2', '2026-07-05', '2026-07-25', 'B'),
        B({ id: 'erfunden', startDate: '4.3.2026' }),
      ],
    });
    const o = await oracle(board);
    const lanes = (s) => buildBoard(s, { today: TODAY }).cols
      .map((c) => `${c.key ?? c.month}[${(c.segs ?? []).map((x) => `${x.bar.id}:${x.lane}`).join(' ')}]`);
    const v1lanes = lanes(o.v1);
    const v2lanes = lanes(o.core);
    assert.equal(v1lanes.filter((c) => /erfunden/.test(c)).length, 0, 'v1 gives it no column at all');
    assert.equal(v2lanes.filter((c) => /erfunden/.test(c)).length, 10, 'v2 gives it ten');
    assert.match(v1lanes.find((c) => /ok1/.test(c)), /ok1:0 ok2:1/, 'in v1 the real bars are in lanes 0 and 1');
    assert.match(v2lanes.find((c) => /ok1/.test(c)), /erfunden:0 ok1:1 ok2:2/,
      'in v2 the invented bar takes lane 0 and pushes both real bars down one');
  });

  test('R6-10d FAILED (held) · on a NOTE the same coercion is the fix M10 says it is — the class contrast', async () => {
    // `layout.js:61-79` places a note by MAP EQUALITY, so v1 draws none of these on any day
    // either. The difference is that a note that lands on no day is still in the file and still
    // in the list; a bar edge that sorts wrong REPOSITIONS a bar that is on the board. This row
    // exists so the two are never conflated: the coercion is not wrong, its APPLICATION to a bar
    // edge is.
    for (const v of ACCEPTED) {
      const o = await oracle(v1board({ notes: [{ id: 'n', date: v, text: 'X', categoryId: 'cat-1', repeatsYearly: false }] }));
      assert.equal(o.v1.notes.length, 1, `v1 keeps the note (${v})`);
      assert.equal(o.core.notes.length, 1, `and so does v2 (${v})`);
      assert.ok(isDateString(o.core.notes[0].date), 'v2 gives it a day it can be found on');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE RESIDUAL THE REGISTER *DOES* DESCRIBE — measured, so the two are distinct
// ─────────────────────────────────────────────────────────────────────────────

describe('R6-11 · the drop-class residual (R5-11g), for the record', () => {
  test('R6-11a SUCCEEDED (defect) · a value that sorts inside and names no day is dropped, and the bar runs to the horizon', async () => {
    for (const [field, v, n1, n2] of [
      ['endDate', '2', 0, 12],
      ['endDate', '2026', 0, 12],
      ['startDate', '9', 0, 12],
      ['startDate', '2026-03', 10, 12],
      ['endDate', '2026-03', 2, 12],
      ['endDate', '2026-03-04 bis 2026-03-09', 3, 12],
    ]) {
      const r = await edge(field, v);
      assert.equal(r.wrote, undefined, `${field} = ${JSON.stringify(v)} is DROPPED`);
      assert.equal(r.v1.length, n1, `v1: ${n1} segment(s)`);
      assert.equal(r.v2.length, n2, `v2: ${n2} segment(s)`);
    }
  });

  test('R6-11b SUCCEEDED (defect) · §4.6\'s zoned datetime, measured: the FLOOR would be exact and the drop is not', async () => {
    // ADR/FINDINGS §4.6 tables the floor against finding 6's refusal of a zoned datetime. The
    // measurement the decision needs: today's behaviour on that value is not neutral. v1 paints
    // nine columns from a startDate of '2026-04-01T23:00:00-05:00'; v2 paints twelve.
    const r = await edge('startDate', '2026-04-01T23:00:00-05:00');
    assert.equal(r.wrote, undefined);
    assert.equal(r.v1.length, 9);
    assert.equal(r.v2.length, 12);
    const e = await edge('endDate', '2026-04-01T23:00:00-05:00');
    assert.equal(e.v1.length, 4);
    assert.equal(e.v2.length, 12);
  });
});
