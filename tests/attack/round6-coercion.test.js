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

import { oracle, v1board, note, bar, pad22, ME as MEM, DEV } from './_regression-harness.js';
import { buildBoard } from '../../src/js/layout.js';
import { EARLIEST_DATE, LATEST_DATE, isDateString } from '../../src/js/core/entities.js';
// R6-10f drives the OTHER door — the one 11.3 (import) and 11.5 (snapshot restore) go through.
import { planReplaceAll } from '../../src/js/core/replace.js';
import { fold } from '../../src/js/core/registers.js';
import { materialize, stripV2Fields } from '../../src/js/core/materialize.js';
import { fmt } from '../../src/js/core/stamp.js';
import { defaultState } from '../fixtures/v1-store-frozen.js';

const TODAY = '2026-06-15';

/** The ctx a retrofitted store supplies to the import door — `replace.js:checkCtx`. */
const IMPORT_CTX = () => {
  let n = 0;
  return {
    me: MEM, deviceId: DEV, gid: pad22('gR'),
    mint: () => fmt(1787836800000 + (++n), n % 1000, '0123456789ABCDEF'),
    newOpId: () => pad22(`o6x${++n}`),
    defaultSettings: defaultState().settings,
    acceptLossy: true,
  };
};

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
// 2. THE SIDE OF THE BOUNDARY THE REGISTER DID NOT DESCRIBE — CLOSED
//
// These rows were written as `SUCCEEDED (defect)`. They are inverted here, and what closed them
// is not a fourth branch: it is that the three-branch split (below / above / inside) was replaced
// by one question asked of the whole alphabet. `DATE_RE` accepts a finite, totally ordered set of
// strings, so EVERY text has a floor and a ceiling in it, and
//
//     floor(t) reproduces every `<` comparison v1 makes   ceil(t) reproduces every `>`
//
// exactly. v1 makes `<` against `mFirst` and `>` against `mLast` (`layout.js:133-135,148,151`),
// so `floor(t)` is exact unless it IS an `mLast` and `ceil(t)` is exact unless it IS an `mFirst`.
// Take the first of the two that is exact. See `migrate1to2.js:coerceToV1BarEdge`.
//
// §2.4 is the class where NEITHER is exact, and it is nameable rather than residual: a text
// sorting strictly between `YYYY-MM-31` of a 31-day month and the next month's `01`, where the
// alphabet has no member at all. There the tie goes to the comparison that decides WHETHER THE
// BAR IS IN A COLUMN, and the one continuation chevron that moves is measured, not waved at.
// ─────────────────────────────────────────────────────────────────────────────

describe('R6-10 · a bar edge is COMPARED, over the whole alphabet and not only at its two ends', () => {
  const ACCEPTED = ['2026-3-1', '4.3.2026', '2026/03/04', '20260304'];

  test('R6-10a INVERTED · startDate: the bar v1 drew NOWHERE is drawn nowhere', async () => {
    for (const v of ACCEPTED) {
      assert.ok(v > EARLIEST_DATE && v < LATEST_DATE, `${JSON.stringify(v)} sorts INSIDE the alphabet…`);
      assert.ok(!isDateString(v), '…and is not a date, so it used to fall through to `coerceToV1Date`');
      const r = await edge('startDate', v);
      assert.deepEqual(r.v1, [], `v1 painted ${JSON.stringify(v)} on NO day of the year`);
      assert.deepEqual(r.v2, r.v1, `and neither does v2 (${JSON.stringify(v)})`);
      assert.ok(isDateString(r.wrote), 'the edge is KEPT, at a date that sorts where the text sorted');
      assert.notEqual(r.wrote, '2026-03-04', 'and it is NOT the day the text "means" — that was the defect');
    }
  });

  test('R6-10b INVERTED · endDate: the bar v1 ran across the whole year still runs across it', async () => {
    for (const v of ACCEPTED) {
      const r = await edge('endDate', v);
      assert.equal(r.v1.length, 12, `v1 ran ${JSON.stringify(v)} across all twelve columns`);
      assert.equal(r.v2.length, 12, `and so does v2 (${JSON.stringify(v)}) — it was three`);
      assert.deepEqual(r.v2.map((x) => x.split(':')[0]), r.v1.map((x) => x.split(':')[0]),
        'the same twelve columns, in the same order');
    }
  });

  test('R6-10c INVERTED · it takes a lane from nobody, in any column', async () => {
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
    assert.equal(v2lanes.filter((c) => /erfunden/.test(c)).length, 0, 'and now v2 gives it none either');
    assert.deepEqual(v2lanes, v1lanes, 'so the real bars keep the lanes v1 gave them, column for column');
    assert.equal(o.core.bars.length, 3, 'and nothing was dropped to tidy the picture');
  });

  test('R6-10d FAILED (held) · on a NOTE the same coercion is still the fix M10 says it is', async () => {
    // THE CLASS CONTRAST, AND THE CONTROL THAT STOPS "REFUSE EVERYWHERE" PASSING AS THE FIX.
    // `layout.js:61-79` places a note by MAP EQUALITY, so „what day does this name" is the right
    // question for a note date and the wrong one for a bar edge. The fix is a rule about the
    // FIELD (`isV1BarEdge`), so this row must not move — and it does not.
    for (const v of ACCEPTED) {
      const o = await oracle(v1board({ notes: [{ id: 'n', date: v, text: 'X', categoryId: 'cat-1', repeatsYearly: false }] }));
      assert.equal(o.v1.notes.length, 1, `v1 keeps the note (${v})`);
      assert.equal(o.core.notes.length, 1, `and so does v2 (${v})`);
      assert.ok(isDateString(o.core.notes[0].date), 'v2 gives it a day it can be found on');
    }
    assert.equal((await oracle(v1board({ notes: [{ id: 'n', date: '4.3.2026', text: 'X', categoryId: 'cat-1', repeatsYearly: false }] })))
      .core.notes[0].date, '2026-03-04', 'and it is still read as 4 March, the German reading (M10)');
  });

  test('R6-10e SUCCEEDED→CLOSED · a NUMERIC bar edge is not a day either — the axis nobody crossed', async () => {
    // FOUND WHILE FIXING R6-10, BY CROSSING THE TYPE AXIS THE ENUMERATION LEFT AT `string`.
    // `coerceToV1Date` accepts the INTEGER `20260304` (its `YYYYMMDD` branch), and `20260304` is
    // a perfectly ordinary thing for a hand-edited or generated `board.json` to hold. In
    // `layout.js` every comparison a number makes against a date STRING is `NaN`-false, so v1
    // treats it exactly like an absent edge and paints the bar across all twelve columns.
    // Measured before the fix: v1 12 / v2 10 as a `startDate`, v1 12 / v2 3 as an `endDate`, and
    // `"2026-03-04"` written into `board.json` both times.
    for (const field of ['startDate', 'endDate']) {
      const r = await edge(field, 20260304);
      assert.equal(r.v1.length, 12, `v1 paints a numeric ${field} in every column (an absent edge)`);
      assert.deepEqual(r.v2, r.v1, `and so does v2 (${field})`);
      assert.equal(r.wrote, undefined, 'the field is DROPPED, which is what an absent edge is');
    }
    // The note contrast again: on a note the same integer still reads as a day.
    const o = await oracle(v1board({ notes: [{ id: 'n', date: 20260304, text: 'X', categoryId: 'cat-1', repeatsYearly: false }] }));
    assert.equal(o.core.notes[0].date, '2026-03-04', 'a NOTE date still takes the numeric reading');
  });

  test('R6-10f FAILED (held) · the two doors answer the same bytes the same way', async () => {
    // `replace.js` is the import / snapshot-restore door and `migrate1to2.js` the launch door.
    // R6-10's fix touched the cascade on BOTH, and a fix applied to one of them would build two
    // different boards from the same file — RECHECK-82-6's defect class.
    for (const v of [...ACCEPTED, '1.3', '2026-03', '2026-13-01', 20260304]) {
      for (const field of ['startDate', 'endDate']) {
        const board = v1board({ bars: [B({ [field]: v })] });
        const o = await oracle(board);
        const plan = planReplaceAll(new Map(), structuredClone(board), IMPORT_CTX());
        const imported = stripV2Fields(materialize(fold(plan.ops), {
          me: MEM, familySpaceId: null, currentMembers: new Set([MEM]),
          defaultSettings: defaultState().settings,
        }));
        assert.deepEqual(imported.bars[0][field], o.core.bars[0][field],
          `${field} = ${JSON.stringify(v)}: the migration door and the import door agree`);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE RESIDUAL THE REGISTER *DID* DESCRIBE — also closed, and what is left of it
// ─────────────────────────────────────────────────────────────────────────────

describe('R6-11 · the drop-class residual (R5-11g), closed', () => {
  test('R6-11a INVERTED · a value that sorts inside and names no day is KEPT, and the bar stays where v1 put it', async () => {
    for (const [field, v, n1] of [
      ['endDate', '2', 0],
      ['endDate', '2026', 0],
      ['startDate', '9', 0],
      ['startDate', '2026-03', 10],
      ['endDate', '2026-03', 2],
    ]) {
      const r = await edge(field, v);
      assert.ok(isDateString(r.wrote), `${field} = ${JSON.stringify(v)} is KEPT, not dropped`);
      assert.equal(r.v1.length, n1, `v1: ${n1} segment(s)`);
      assert.deepEqual(r.v2, r.v1, `${field} = ${JSON.stringify(v)}: v2 paints exactly that`);
    }
    // `'2026-03-04 bis 2026-03-09'` is the ONE member of this list where v1 itself rendered a day
    // as `NaN` — it sorts strictly inside March, so `layout.js:136` clamped nothing and parsed the
    // raw text. The columns are reproduced; the `NaN` is not, and it cannot be (R5-12d's ruling).
    const nan = await edge('endDate', '2026-03-04 bis 2026-03-09');
    assert.equal(nan.wrote, '2026-03-04', 'kept at the floor');
    assert.equal(nan.v1.length, 3);
    assert.deepEqual(nan.v2.map((x) => x.split(':')[0]), nan.v1.map((x) => x.split(':')[0]),
      'the same three columns — it was twelve');
    assert.match(nan.v1[2], /NaN/, 'and the only difference is the day v1 rendered as NaN');
    assert.doesNotMatch(nan.v2[2], /NaN/);
  });

  test('R6-11b INVERTED · §4.6\'s zoned datetime: the floor IS taken, and it IS exact', async () => {
    // THE PER-FIELD RULING §4.6 ASKED FOR, MADE. Finding 6 refuses `'2026-04-01T23:00:00-05:00'`
    // as a DAY, and that refusal stands: honouring the offset would smuggle a timezone into a
    // format that has none, and the question „which day is this" genuinely has two answers. For a
    // BAR EDGE the question is never asked. v1 did not read the value; it compared it, and the
    // floor compares identically. Reading it and positioning it are different acts, and only the
    // first of them picks a timezone.
    const r = await edge('startDate', '2026-04-01T23:00:00-05:00');
    assert.equal(r.wrote, '2026-04-01', 'the FLOOR is kept — a position, not a reading');
    assert.equal(r.v1.length, 9, 'v1 painted nine columns …');
    assert.equal(r.v2.length, 9, '… and so does v2 (it was twelve)');
    const e = await edge('endDate', '2026-04-01T23:00:00-05:00');
    assert.equal(e.v1.length, 4);
    assert.equal(e.v2.length, 4, 'four, not twelve');
    // And the refusal it must NOT undo: on a NOTE the zoned value still names no day.
    const o = await oracle(v1board({ notes: [{ id: 'n', date: '2026-04-01T23:00:00-05:00', text: 'X', categoryId: 'cat-1', repeatsYearly: false }] }));
    assert.equal(o.core.notes[0].date, undefined,
      'finding 6 stands where it was made: a NOTE date with a zone is still refused');
  });

  test('R6-11c · the one class where NO member of the alphabet is exact, named and measured', async () => {
    // `'2026-3-1'` sorts strictly between `'2026-12-31'` and `'2027-01-01'`, and `DATE_RE` has no
    // member between them. v1 wants a value that is AFTER December 2026's last day (so the
    // `contBot` chevron is drawn) and BEFORE January 2027's first day (so the bar is skipped
    // there). No date is both. The tie goes to the test that decides whether the bar is in the
    // column at all; the chevron is what moves, and this row is where that is written down.
    const r = await edge('endDate', '2026-3-1');
    assert.equal(r.wrote, '2026-12-31', 'the floor — its skip test (`<`) is the one that must stay exact');
    assert.deepEqual(r.v2.map((x) => x.split(':')[0]), r.v1.map((x) => x.split(':')[0]),
      'every column v1 painted, and no other');
    assert.ok(r.v1[11].endsWith('v') && !r.v2[11].endsWith('v'),
      'and exactly one thing differs: the continuation chevron on the outermost column');
    assert.equal(r.v1.length, r.v2.length);
    // The mirror, on a startDate: the CEILING is taken there, for the mirror reason.
    const s = await edge('startDate', '2026');
    assert.equal(s.wrote, '2026-01-01', 'the ceiling — its skip test is `>`');
    assert.deepEqual(s.v2.map((x) => x.split(':')[0]), s.v1.map((x) => x.split(':')[0]));
    assert.ok(s.v1[0].endsWith('^') && !s.v2[0].endsWith('^'), 'one chevron, on the innermost column');
  });

  test('R6-11d · the whole boundary, swept: the COLUMN SET is never wrong', async () => {
    // THE PROPERTY THE FIX IS ACTUALLY MAKING, over both sides of every month boundary rather
    // than over the four values a finding happened to name. `startDay`/`endDay`/`contTop`/
    // `contBot` may differ where v1 rendered a `NaN` day or where §2.4's class has no member;
    // WHICH COLUMNS THE BAR OCCUPIES may not, ever. Before the fix this failed on 2 414 of 9 104
    // (text × field × grid) cases.
    const texts = [];
    for (let y = 2025; y <= 2027; y++) {
      for (let m = 1; m <= 12; m++) {
        const mm = String(m).padStart(2, '0');
        texts.push(`${y}-${mm}`, `${y}-${m}-1`, `${y}-${mm}-`, `${y}/${mm}/04`, `${y}${mm}04`,
          `${y}-${mm}-04T09:00`, `${y}-${mm}-31 bis morgen`, `${y}-${mm}-01T23:00:00-05:00`,
          `${y}-${mm}-32`, `${y}-13-01`, `${y}`, `4.${m}.${y}`);
      }
    }
    let checked = 0;
    for (const t of texts) {
      if (isDateString(t)) continue;
      for (const field of ['startDate', 'endDate']) {
        const r = await edge(field, t);
        assert.deepEqual(r.v2.map((x) => x.split(':')[0]), r.v1.map((x) => x.split(':')[0]),
          `${field} = ${JSON.stringify(t)} lands in the columns v1 drew it in`);
        checked += 1;
      }
    }
    assert.ok(checked >= 800, `the sweep really ran (${checked} text × field pairs)`);
  });
});
