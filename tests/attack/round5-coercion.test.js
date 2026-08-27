// ─────────────────────────────────────────────────────────────────────────────
// ROUND 5 — ADVERSARY, ATTACK 3: THE COERCION FIXES, AGAINST THE V1 RENDERER
//
// Round 4 closed findings 5, 6 and 7. Finding 5's closure was a DELETION — `missingBarEdge` was
// removed from both doors on the argument that "the horizon is not data, it is what `layout.js`
// does with an absent edge, and `layout.js` is the same file in both builds". That argument is
// correct, and §1 and §2 confirm the shapes it was aimed at: the two-ended bar, the no-ended bar
// and the two one-ended bars all paint identically in v1 and v2 now, and the new
// `gridPlacementWarning` says something true about each of them.
//
// §3 is where it breaks, and it breaks on the premise rather than on the mechanism.
//
//   "absent in v1 stays absent in v2"
//
// is only half of what the migration does. It also turns UNREADABLE into absent — a field the
// user typed, that the type table cannot represent, is DROPPED, and a dropped field is absent.
// And in `layout.js:133`, absent and unreadable are NOT the same bar:
//
//     if (b.endDate < mFirst || b.startDate > mLast) continue;
//
// `undefined < '2026-03-01'` is `false` (NaN), so an ABSENT edge is never skipped and the bar
// runs to the horizon. `'' < '2026-03-01'` is `true`, so an unreadable edge that sorts BELOW the
// ISO range skips EVERY column and the bar is invisible. v1 drew nothing. v2 drops the field and
// draws the bar across ten months, taking a lane from every other bar in each of them — and then
// prints "That is exactly what v1 painted for it (layout.js:133-135), so nothing on your board
// moves", which is false for exactly this class.
//
// The mirror image is `startDate` sorting ABOVE the range. Both classes are reachable from the
// keyboard: v1's bar-label editor writes whatever is typed, and `''` is what an emptied field is.
//
// §4 re-checks finding 6: the tightened ISO tail refuses `2026-04-01T09:00Z` and
// `2026-03-04 bis 2026-03-09`. It did NOT refuse a shape v1 accepted — v1 painted nothing for
// every refused shape — so that fix is clean.
//
// The oracle throughout is `src/js/layout.js`, unchanged since the v1 baseline `66126e9`.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { oracle, v1board, note, bar } from './_regression-harness.js';
import { buildBoard } from '../../src/js/layout.js';
// §5 measures the CORPUS, not a board: the generator and the gate that says what it built.
import { generateUglyBoard, uglyShapesIn } from '../helpers/gen.js';
import { defaultState } from '../fixtures/v1-store-frozen.js';

/** A fixed day, so nothing here reads a clock (R12). */
const TODAY = '2026-06-15';

/** Where the v1 renderer puts every entry of a board. A throw is an answer too. */
function paint(state) {
  try {
    const b = buildBoard(state, { today: TODAY });
    const marks = [];
    for (const col of b.cols) {
      for (const d of col.days ?? []) for (const o of d.notes ?? []) marks.push(`note:${o.note.id}@${d.iso ?? d.date}`);
      for (const s of col.segs ?? []) marks.push(`bar:${s.bar.id}@${s.startDay}-${s.endDay}`);
    }
    return { ok: true, marks };
  } catch (e) { return { ok: false, err: `${e.constructor.name}: ${e.message}` }; }
}

async function both(board) {
  const o = await oracle(board);
  return { o, v1: paint(o.v1), v2: paint(o.core) };
}

const withBar = (b) => v1board({ bars: [b] });
const B = (extra) => ({ id: 'b', label: 'Projekt', categoryId: 'cat-1', ...extra });
// The placement sentence, whichever of the four it is. `NOT DRAWN` is R5-11's new branch:
// a bar with both edges present that the grid still paints in no column.
const drawnWarn = (o) => o.warnings.filter((w) => /IS DRAWN|is NOT DRAWN/.test(w));

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE THREE SHAPES FINDING 5 WAS ABOUT — ALL FOUR PAINT IDENTICALLY
// ─────────────────────────────────────────────────────────────────────────────

describe('R5-9 · finding 5\'s deletion did not break the shapes it was aimed at', () => {
  const SHAPES = {
    'two ends (the ordinary bar — the control)': [B({ startDate: '2026-03-01', endDate: '2026-03-20' }), 1],
    'two ends, reversed (a v1 quirk that must survive)': [B({ startDate: '2026-03-20', endDate: '2026-03-01' }), 1],
    'two ends, one day': [B({ startDate: '2026-03-04', endDate: '2026-03-04' }), 1],
    'start only': [B({ startDate: '2026-03-01' }), 10],
    'end only': [B({ endDate: '2026-03-20' }), 3],
    'no ends': [B({}), 12],
    'start only, before the visible year': [B({ startDate: '2019-01-01' }), 12],
    'end only, after the visible year': [B({ endDate: '2099-01-01' }), 12],
  };
  for (const [what, [b, segs]] of Object.entries(SHAPES)) {
    test(`R5-9 FAILED (held) · ${what} — v1 and v2 paint the same board`, async () => {
      const { v1, v2 } = await both(withBar(b));
      assert.equal(v1.ok && v2.ok, true, 'neither renderer throws');
      assert.deepEqual(v2.marks, v1.marks, what);
      assert.equal(v1.marks.length, segs, `and it really is ${segs} segment(s), so the row is not vacuous`);
    });
  }

  test('R5-9x FAILED (held) · and the ANCHOR is really gone: no endDate is written into the file', async () => {
    const { o } = await both(withBar(B({ startDate: '2026-03-01' })));
    assert.equal('endDate' in o.core.bars[0], false, 'absent in v1 stays absent in v2 (R4-10a)');
    assert.deepEqual(o.core.bars[0], { id: 'b', startDate: '2026-03-01', label: 'Projekt', categoryId: 'cat-1' });
  });

  test('R5-9y FAILED (held) · each of the four shapes gets a DIFFERENT, TRUE sentence', async () => {
    const say = async (b) => drawnWarn((await oracle(withBar(b))))[0] ?? '';
    assert.equal(await say(B({ startDate: '2026-03-01', endDate: '2026-03-20' })), '', 'a complete bar is not warned about');
    assert.match(await say(B({ startDate: '2026-03-01' })), /FAR EDGE of the visible year/);
    assert.match(await say(B({ endDate: '2026-03-20' })), /NEAR EDGE of the visible year/);
    assert.match(await say(B({})), /drawn EVERYWHERE[\s\S]*all twelve columns/);
    // and the twelve-column claim is measurable
    const { v2 } = await both(withBar(B({})));
    assert.equal(v2.marks.length, 12, 'the sentence says twelve columns and the renderer paints twelve');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE NEIGHBOURS — TWO-ENDED AND NO-ENDED BARS ARE UNCHANGED IN A CROWD
// ─────────────────────────────────────────────────────────────────────────────

describe('R5-10 · a one-ended bar next to ordinary ones', () => {
  test('R5-10a FAILED (held) · lanes: the dateless bar takes a lane in v1 and takes the SAME lane in v2', async () => {
    const board = v1board({
      bars: [
        bar('ok1', '2026-03-01', '2026-03-20', 'A'),
        { id: 'nodates', label: 'B', categoryId: 'cat-1' },
        bar('ok2', '2026-03-05', '2026-03-25', 'C'),
      ],
    });
    const { o, v1, v2 } = await both(board);
    assert.deepEqual(v2.marks, v1.marks, 'every segment, in every column, in the same place');
    const lanes = (s) => buildBoard(s, { today: TODAY }).cols[2].segs.map((x) => `${x.bar.id}:${x.lane}`);
    assert.deepEqual(lanes(o.core), lanes(o.v1), 'and the lane ASSIGNMENT is identical, which is what 2.5 is about');
    assert.equal(o.core.bars.length, 3, 'nothing was dropped to tidy the picture');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE CLASS FINDING 5's PREMISE MISSED — UNREADABLE ≠ ABSENT IN `layout.js`
//
// INVERTED. Every row below was green BECAUSE the defect was there; each one now measures the
// fix. The fix is `migrate1to2.js:coerceToV1BarEdge`, and it is one sentence: v1 does not PARSE a
// bar edge, it COMPARES it, so an edge that names no day is carried across as the end of the
// date alphabet it sorted against (`entities.js:EARLIEST_DATE` / `LATEST_DATE`) instead of being
// dropped. `layout.js` — the same file in both builds — then paints what it always painted.
//
// The rows kept their numbers and their fixtures so the two states are diffable.
// ─────────────────────────────────────────────────────────────────────────────

/** The continuation markers `paint()` cannot see: the chevrons and the horizon flag. */
function chevrons(state) {
  const b = buildBoard(state, { today: TODAY });
  return b.cols.map((c) => `${c.key}[${c.segs.map((x) => `${x.bar.id}${x.contTop ? '^' : ''}`
    + `${x.contBot ? 'v' : ''}${x.beyondStart ? '<' : ''}${x.beyondEnd ? '>' : ''}`).join(',')}]`
    + (c.horizon ? 'H' : ''));
}

describe('R5-11 · a bar v1 drew NOWHERE is drawn nowhere by v2 as well', () => {
  // Every value here is refused by the type table AND sorts below every date v2 can hold, so
  // `b.endDate < mFirst` was TRUE in every column and v1's segment loop `continue`d past it
  // twelve times. (`'?'` is 0x3F and therefore ABOVE `'2'`; the class is the characters that sort
  // below the digit `2` — every space, every punctuation mark before `(`…`/`, and `0` and `1`.)
  // `' 2026-03-04'` is in the set on purpose and it is the row that pins the ORDER of the
  // cascade: `coerceToV1Date` TRIMS, so it reads that value as a perfectly good 4 March — and v1
  // painted the bar on no day at all, because it compared the leading space. The edge rule has to
  // run first or a readable-looking date silently re-opens the whole class.
  const BELOW = {
    'the empty string': '', 'a space': ' ', 'a dash': '-', 'a parenthesis': '(offen)',
    'a zero': '0', 'a LEADING space on a real date': ' 2026-03-04',
  };
  for (const [what, value] of Object.entries(BELOW)) {
    test(`R5-11a INVERTED · endDate = ${JSON.stringify(value)} (${what}): v1 painted NOTHING and now so does v2`, async () => {
      const { o, v1, v2 } = await both(withBar(B({ startDate: '2026-03-01', endDate: value })));
      assert.deepEqual(v1.marks, [], 'v1 drew this bar on no day of the year (the fixture is not vacuous)');
      assert.deepEqual(v2.marks, v1.marks, 'and v2 draws it on no day either — the board stopped moving');
      assert.equal(o.core.bars[0].endDate, '0000-01-01',
        'because the unreadable value became the earliest date v2 can hold, not an ABSENT one');
      assert.equal(o.core.bars.length, 1, 'the ENTRY is still on the board and in every export');
      assert.equal(o.core.bars[0].label, 'Projekt', 'with everything else the user typed');
    });
  }

  test('R5-11b INVERTED · and the warning now says what the user will actually see', async () => {
    const { o } = await both(withBar(B({ startDate: '2026-03-01', endDate: '' })));
    const w = drawnWarn(o);
    assert.equal(w.length, 1, 'exactly one placement sentence');
    assert.match(w[0], /is NOT DRAWN on any day/, 'which is what the renderer does with it');
    assert.doesNotMatch(o.warnings.join('\n'), /nothing on your board moves/,
      'the sentence finding 5 introduced is not printed for this class any more');
    // …and the value itself is reported, with the reason it became a date rather than nothing.
    assert.ok(o.warnings.some((x) => /field "endDate" = "" names no day at all/.test(x)),
      'the original text is quoted back');
    assert.ok(o.warnings.some((x) => /sorts BEFORE every date v2 can hold/.test(x)));
    assert.ok(o.warnings.some((x) => /skipped this bar in EVERY column/.test(x)),
      'and the warning names what v1 did with it, which is now what v2 does');
  });

  test('R5-11c INVERTED · the mirror image: a startDate that sorts ABOVE the year', async () => {
    // `b.startDate > mLast` is the other half of the same `continue`. Anything sorting above
    // `'2026-12-31'` — a lower-case word is the everyday case, because 'i' > '2' — hid the bar
    // in v1 and let it run from the near edge in v2.
    for (const value of ['zzz', 'unbekannt', 'ab wann?']) {
      const { o, v1, v2 } = await both(withBar(B({ startDate: value, endDate: '2026-03-20' })));
      assert.deepEqual(v1.marks, [], `startDate ${JSON.stringify(value)}: v1 drew nothing`);
      assert.deepEqual(v2.marks, v1.marks, '… and neither does v2');
      assert.equal(o.core.bars[0].startDate, '9999-12-31', 'the LATEST date v2 can hold');
      assert.equal(o.core.bars.length, 1);
    }
  });

  test('R5-11d INVERTED · both ends unreadable ⇒ invisible in v1, invisible in v2', async () => {
    const { o, v1, v2 } = await both(withBar(B({ startDate: 'irgendwann', endDate: '' })));
    assert.deepEqual(v1.marks, []);
    assert.deepEqual(v2.marks, [], 'the loudest shape there is, and it is silent again');
    assert.deepEqual([o.core.bars[0].startDate, o.core.bars[0].endDate], ['9999-12-31', '0000-01-01'],
      'each end went to the end of the alphabet IT sorted against — the two are independent');
  });

  test('R5-11e INVERTED · the other half of the class: an unreadable end ABOVE the range, chevrons included', async () => {
    // `'irgendwann'` starts with `i`, which is above `'2'`, so `b.endDate < mFirst` is false and
    // v1's own renderer already ran the bar to the horizon. THIS is the shape finding 5's premise
    // describes, and for the SEGMENTS the premise was right — which is why the defect above was
    // not caught: the value everybody tests with is on the safe side of `'2'`.
    //
    // It was not right for the CHEVRONS. `'irgendwann' > mLast` is true, so v1 marked every
    // segment as continuing past the month and raised `col.horizon` in December (`layout.js:148,
    // 151,260`); an ABSENT edge compares NaN and raises neither. The same fix closes both halves,
    // which is why this row is now an INVERTED one and not a control.
    const { o, v1, v2 } = await both(withBar(B({ startDate: '2026-03-01', endDate: 'irgendwann' })));
    assert.equal(v1.marks.length, 10);
    assert.deepEqual(v2.marks, v1.marks, 'identical segments — that half never moved');
    assert.deepEqual(chevrons(o.core), chevrons(o.v1),
      'and identical continuation markers, which is the half the deletion lost');
    assert.ok(chevrons(o.v1).some((c) => /H$/.test(c)), 'the fixture really does reach the horizon flag');
    assert.equal(o.core.bars[0].endDate, '9999-12-31');
  });

  test('R5-11f INVERTED · and it costs no LANE from any other bar, in any column', async () => {
    const board = v1board({
      bars: [
        bar('ok1', '2026-03-01', '2026-03-20', 'A'),
        B({ id: 'ghost', startDate: '2026-03-01', endDate: '' }),
        bar('ok2', '2026-03-05', '2026-03-25', 'C'),
      ],
    });
    const { o, v1, v2 } = await both(board);
    const lanes = (s) => new Map(buildBoard(s, { today: TODAY }).cols[2].segs.map((x) => [x.bar.id, x.lane]));
    const l1 = lanes(o.v1);
    const l2 = lanes(o.core);
    assert.equal(l1.has('ghost'), false, 'v1 gave the ghost no lane at all');
    assert.equal(l2.has('ghost'), false, '… and neither does v2 …');
    assert.deepEqual([...l2.entries()].sort(), [...l1.entries()].sort(),
      '… so the bars the user actually made keep theirs');
    assert.deepEqual(v2.marks, v1.marks, 'and the whole board is identical');
    assert.equal(o.core.bars.length, 3, 'nothing was dropped to tidy the picture');
  });

  test('R5-11g INVERTED (R6-10) · a value that sorts INSIDE the range has a faithful date after all', async () => {
    // THIS ROW USED TO PIN THE RESIDUAL: "`coerceToV1BarEdge` can only reproduce v1's comparison
    // where a date v2 can hold sorts on the same side of every month — i.e. outside the alphabet."
    // The word that was wrong is *outside*. `DATE_RE`'s alphabet is a finite TOTALLY ORDERED set,
    // so `'1.3'` has a floor in it (`'0999-12-31'`) and a ceiling (`'1000-01-01'`) with no member
    // between — and the floor compares against every `mFirst` exactly as `'1.3'` did. v1 skipped
    // this bar in every 2026 column; so does `'0999-12-31'`. Nothing here is a new decision about
    // what to invent: it is the same R5-11 sentence, applied to the whole alphabet instead of to
    // its two ends. See `coerceToV1BarEdge` and R6-10.
    const { o, v1, v2 } = await both(withBar(B({ startDate: '2026-03-01', endDate: '1.3' })));
    assert.deepEqual(v1.marks, [], "v1 drew nothing: '1' sorts below '2'");
    assert.deepEqual(v2.marks, v1.marks, '… and now v2 draws nothing either');
    assert.equal(o.core.bars[0].endDate, '0999-12-31',
      'the field is KEPT, at the last date v2 can hold that still sorts at or before "1.3"');
    // The half R5-11 already closed stays closed: no false v1-fidelity claim on a coerced edge.
    const w = drawnWarn(o);
    assert.equal(w.length, 1);
    assert.match(w[0], /is NOT DRAWN on any day/,
      'and the warning describes the bar the user will see, which is no bar at all');
  });

  test('R5-11h INVERTED · an ABSENT edge is still absent — R4-10 is untouched by the fix', async () => {
    // The control that stops "position everything" passing as a fix. An edge the file never
    // carried is a NaN comparison in v1 and must stay one: writing `0000-01-01` into a bar the
    // user simply never gave an end to would be R4-10's anchor with a different constant.
    const { o, v1, v2 } = await both(withBar(B({ startDate: '2026-03-01' })));
    assert.equal('endDate' in o.core.bars[0], false, 'absent in v1 stays absent in v2 (R4-10a)');
    assert.deepEqual(v2.marks, v1.marks);
    assert.equal(v1.marks.length, 10, 'and v1 really did run it to the far edge');
    const w = drawnWarn(o);
    assert.match(w[0], /FAR EDGE of the visible year/);
    assert.match(w[0], /That is exactly what v1 painted for it/,
      'the sentence is TRUE for this shape, so it is still printed for this shape');
  });

  test('R5-11i INVERTED · the positioned edge is a FIXED POINT: migrating the result again changes nothing', async () => {
    // `0000-01-01` is a legal `date`, so the second pass accepts it verbatim: the file the user
    // is left with does not keep being rewritten, and nothing is re-reported as a loss.
    const { o } = await both(withBar(B({ startDate: '2026-03-01', endDate: '' })));
    const second = await oracle(v1board({ bars: o.core.bars, categories: o.core.categories }));
    assert.deepEqual(second.core.bars, o.core.bars, 'byte for byte, through the door a second time');
    assert.equal(second.warnings.filter((w) => /names no day at all/.test(w)).length, 0,
      'and nothing is coerced twice');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. FINDING 6 — THE TIGHTENED DATE TAIL REFUSES NOTHING v1 ACCEPTED
// ─────────────────────────────────────────────────────────────────────────────

describe('R5-12 · the ISO tail, measured against the renderer rather than against the regex', () => {
  const REFUSED = [
    '2026-04-01T23:00:00-05:00', '2026-04-01T09:00Z', '2026-04-01T09:00+02:00',
    '2026-03-04 bis 2026-03-09', '2026-03-04 - 2026-03-09', '2026-03-04, Zahnarzt',
    '2026-03-04T',
  ];
  for (const given of REFUSED) {
    test(`R5-12a FAILED (held) · ${JSON.stringify(given)} — v1 painted nothing either`, async () => {
      const { o, v1, v2 } = await both(v1board({ notes: [note('n', given, 'Termin')] }));
      assert.deepEqual(v1.marks, [], 'v1 put this note on no day …');
      assert.deepEqual(v2.marks, [], '… and neither does v2, so the tightening costs the user no mark');
      assert.equal(o.core.notes.length, 1, 'the entry survives (§4b rule 3)');
      assert.equal(o.core.notes[0].date, undefined);
    });
  }

  test('R5-12b INVERTED (R6-10) · a bar edge takes the same tightened tail and now lands where v1 put it', async () => {
    // This row pinned the COST of the tightened tail on a bar edge: v1 painted the bar in one
    // column, the tail was refused, the edge was dropped, and v2 ran the bar across ten. The tail
    // is still refused as a DAY (that is finding 6, and `R5-12a` above still holds it for notes),
    // and the edge is no longer dropped for it: `coerceToV1BarEdge` answers every string now, so
    // the value keeps the POSITION it had even though v2 refuses to read it as a date.
    for (const given of ['2026-04-01T09:00Z', '2026-03-04 bis 2026-03-09']) {
      const { o, v1, v2 } = await both(withBar(B({ startDate: '2026-03-01', endDate: given })));
      assert.ok(v1.marks.length > 0, `${given}: v1 drew something`);
      assert.equal(v2.marks.length, v1.marks.length,
        `${given}: v2 draws it in the same number of columns — the drop no longer happens`);
      assert.ok(o.core.bars[0].endDate !== undefined, `${given}: the edge is kept, not dropped`);
    }
  });

  test('R5-12d INVERTED · the tail is a wall-clock time BY SHAPE, and the docblock now says so', async () => {
    // The tail is `(?:[T ]\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)?$`, which the docblock called
    // "a floating wall-clock time and nothing else". It matches 25:00 and 99:99:99, so the claim
    // was wider than the regex. Round 5 offered two closes — tighten the regex, or correct the
    // claim — and the CLAIM was corrected, for a reason the next row measures rather than asserts.
    for (const given of ['2026-03-04T25:00', '2026-03-04T99:99:99', '2026-03-04 0:00']) {
      const o = await oracle(v1board({ notes: [note('n', given, 'x')] }));
      assert.equal(o.core.notes[0].date, '2026-03-04', `${given} is read as a day, not refused`);
    }
    // The trailing space is the same shape: it is not a time at all, and the value still reads.
    const t = await oracle(v1board({ notes: [note('n', '2026-03-04 ', 'x')] }));
    assert.equal(t.core.notes[0].date, '2026-03-04', 'a trailing space is trimmed by the fallback branch');
    // What the tail may NEVER do is change WHICH DAY the value names — that is the invariant the
    // corrected words keep, and the zone designators are still refused by it (R5-12a above).
    for (const zoned of ['2026-04-01T09:00Z', '2026-04-01T23:00:00-05:00']) {
      const o = await oracle(v1board({ notes: [note('n', zoned, 'x')] }));
      assert.equal(o.core.notes[0].date, undefined, `${zoned} still names two days and is still refused`);
    }
  });

  test('R5-12e FAILED (held) · and TIGHTENING it would have moved a bar from ONE column to TEN', async () => {
    // The measurement behind that choice, so it is not a matter of taste. An hour of `25` cannot
    // move a day: the tail is discarded and only `y-m-d` survives, which `isDateString` then
    // validates. Refusing the value would DROP the edge — and R5-11 is the register entry for
    // what a dropped bar edge costs.
    const { o, v1, v2 } = await both(withBar(B({ startDate: '2026-03-01', endDate: '2026-03-04T25:00' })));
    assert.equal(v1.marks.length, 1, 'v1 painted this bar in exactly ONE column …');
    assert.match(v1.marks[0], /^bar:b@1-NaN$/,
      '… with a NaN end day of its own, because parseISO splits on "-" and Number("04T25:00") is NaN');
    assert.equal(v2.marks.length, 1, 'and v2 paints it in that one column too');
    assert.equal(o.core.bars[0].endDate, '2026-03-04', 'the tail is discarded, the day is not');
    // WHAT A REFUSAL USED TO COST, and no longer does — R6-10. This half of the row measured a
    // tail that IS refused (finding 6 tightened this one): the same shape of value, dropped
    // instead of read, and the bar crossing the whole year. The refusal is unchanged — v2 still
    // will not read `'2026-03-04 bis 2026-03-09'` as a DAY — but a refused bar edge is no longer
    // a dropped one, so the price it used to carry is zero. The argument for reading `25:00` as a
    // day therefore no longer rests on this measurement; it rests on the first half of this row,
    // which is untouched: a tail that cannot move the day must not lose it.
    const refused = await both(withBar(B({ startDate: '2026-03-01', endDate: '2026-03-04 bis 2026-03-09' })));
    assert.equal(refused.v1.marks.length, 1, 'v1 painted THAT bar in one column as well …');
    assert.equal(refused.v2.marks.length, 1,
      '… and so does v2 now: the refusal costs the position no longer, only the day name');
    assert.equal(refused.o.core.bars[0].endDate, '2026-03-04',
      'kept at the floor of the alphabet, which is where the text sorted');
  });

  test('R5-12c FAILED (held) · the floating time, the German date and the numeric date all still read', async () => {
    for (const [given, expected] of [['2026-04-01T09:00', '2026-04-01'], ['4.3.2026', '2026-03-04'],
      [20260401, '2026-04-01'], ['2026-3-1', '2026-03-01'], ['2026-03-04T09:00:00.500', '2026-03-04']]) {
      const o = await oracle(v1board({ notes: [note('n', given, 'x')] }));
      assert.equal(o.core.notes[0].date, expected, `${given} still reads as ${expected}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE CORPUS — the reason this class survived four rounds
//
// R5-11 was not missed for want of attention: it was missed because every corpus that could have
// found it generated only the HARMLESS side of the boundary. `generateUglyBoard` put `''` on a
// `startDate` (below the range, where below is the half the old code got right) and put nothing
// at all above it, so P13's 500 seeds ran past the class 500 times.
//
// The generator now straddles the boundary on both edges, and `uglyShapesIn` reports the two
// sides SEPARATELY — a merged count would go green on a corpus that had quietly become one-sided
// again, which is the exact failure being closed. This row prints the observed frequency of each
// side so the number is in the transcript and not only in a doc.
// ─────────────────────────────────────────────────────────────────────────────

describe('R5-13 · the ugly corpus reaches both sides of the boundary', () => {
  test('R5-13a FAILED (held) · both sides are generated, and the frequency of each is printed', () => {
    const D = defaultState();
    const SIDES = ['a bar edge sorting BELOW every date v2 can hold',
      'a bar edge sorting ABOVE every date v2 can hold'];
    const counts = Object.fromEntries(SIDES.map((k) => [k, 0]));
    const N = 500;
    for (let seed = 0; seed < N; seed++) {
      const shapes = uglyShapesIn(generateUglyBoard(seed, { defaults: D }));
      for (const k of SIDES) counts[k] += shapes[k] ? 1 : 0;
    }
    const table = SIDES.map((k) => `    ${String(counts[k]).padStart(4)}/${N}  `
      + `${((counts[k] / N) * 100).toFixed(1).padStart(5)}%  ${k}`).join('\n');
    console.log(`R5-13a — the boundary, both sides, over ${N} ugly seeds:\n${table}`);
    for (const k of SIDES) {
      // The same 1% floor P14 uses: five boards out of 500 is enough to reproduce from a printed
      // seed, and a side at ZERO is a corpus that cannot see the class it was widened for.
      assert.ok(counts[k] >= N * 0.01,
        `the corpus reaches "${k}" in only ${counts[k]}/${N} boards — it is being sanitised\n${table}`);
    }
    assert.ok(counts[SIDES[0]] > 0 && counts[SIDES[1]] > 0, 'both sides, not one');
  });
});
