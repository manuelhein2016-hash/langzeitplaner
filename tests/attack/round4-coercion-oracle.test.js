// ─────────────────────────────────────────────────────────────────────────────
// ROUND 4 — ADVERSARY, ATTACK 3: A3-H2's COERCION, AGAINST THE ONLY ORACLE THAT COUNTS
//
// The PO's ruling is `COERCE … to v1's MEANING`. `migrate1to2.js` §4b implements that by probing
// the v1 EXPRESSIONS this tree still carries — which is the right discipline, and it is exactly
// right for the two booleans and for the ids. It is not what happens to the two DATE cases,
// because the probe was never extended to the renderer.
//
// THE ORACLE HERE IS `src/js/layout.js`. That file has not been touched since the v1 baseline
// `66126e9` (`git log -- src/js/layout.js` is one commit) and `buildBoard(state, {today})` is
// pure and DOM-free, so it answers the question the field probes could not: WHERE ON THE BOARD
// did v1 actually paint this entry? Every row below runs the frozen v1 store and the shipping v2
// core over the same bytes (`_regression-harness.js:oracle`) and paints both with the same
// renderer at the same fixed `today`.
//
// The results split cleanly:
//
//   · booleans and ids — v1's meaning, reproduced exactly. §1. The `visible: 0` probe earns its
//     keep and the `Boolean(v)` shortcut really would have been wrong.
//   · dates — the coercion moves a note from NOWHERE onto a specific day, and rewrites the field
//     in the user's file. §2. That is the PO's ruling working as ruled, and the cost is measured
//     here rather than argued about. TWO of the date rows were not that: an offset datetime was
//     read as the wrong day and a typed RANGE was read as its first day, both silently. Findings
//     6 — closed below; the tail of the ISO branch is a TIME now, and a designated zone is
//     refused rather than guessed at.
//   · BARS — §3, and this was the one that was not a cost of the ruling but a defect in it. A bar
//     with one end painted NINE column-segments in v1 and paints ONE DAY in v2, with an `endDate`
//     written into the user's file that the file never held; a bar with NO ends was not coerced
//     at all, so v2 painted it exactly as v1 did — twelve stripes — while the warning said it
//     „will not be DRAWN on any day". Finding 5 — closed below by DELETING `missingBarEdge` from
//     both doors: the horizon is not data, it is what `layout.js` does with an absent edge, and
//     `layout.js` is the same file in both builds.
//
// §4 was a residual the ruling requires and did not get: a loss with no warning. Finding 7 —
// closed below; the drop stands (§8.2), the silence does not.
//
// Rows tagged `SUCCEEDED (defect)` are green BECAUSE the defect is there. Rows tagged `INVERTED`
// are the same probe, re-pointed at the behaviour that replaced it.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { oracle, v1board, note } from './_regression-harness.js';
import { buildBoard } from '../../src/js/layout.js';
import { LS, LS_BOARD, v2store, bootV2, v1board as ub, note as un } from './_upgrade-harness.js';

/** A fixed day, so nothing here reads a clock (R12). */
const TODAY = '2026-06-15';

/**
 * Where the v1 renderer puts every entry of a board — the answer the field probes cannot give.
 * A throw is an answer too: v1 has shapes that take the whole board down.
 */
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

/** v1's paint and v2's paint of the same bytes. */
async function both(board) {
  const o = await oracle(board);
  return { o, v1: paint(o.v1), v2: paint(o.core) };
}

const catsOnly = (visible) => [{ id: 'cat-1', name: 'A', nameEn: 'A', paletteRef: 'blau', visible }];

// ─────────────────────────────────────────────────────────────────────────────
// 1. WHAT THE PROBE GOT RIGHT — booleans and ids paint identically
// ─────────────────────────────────────────────────────────────────────────────

describe('R4-8 · booleans and ids: coerced to v1\'s meaning, and the renderer agrees', () => {
  const BOOLS = {
    'repeatsYearly: "yes"': v1board({ notes: [note('n', '2026-03-04', 'Geb', { repeatsYearly: 'yes' })] }),
    'repeatsYearly: "false"': v1board({ notes: [note('n', '2026-03-04', 'Geb', { repeatsYearly: 'false' })] }),
    'repeatsYearly: "nein"': v1board({ notes: [note('n', '2026-03-04', 'Geb', { repeatsYearly: 'nein' })] }),
    'repeatsYearly: 0': v1board({ notes: [note('n', '2026-03-04', 'Geb', { repeatsYearly: 0 })] }),
    'repeatsYearly: ""': v1board({ notes: [note('n', '2026-03-04', 'Geb', { repeatsYearly: '' })] }),
    'repeatsYearly: NaN': v1board({ notes: [note('n', '2026-03-04', 'Geb', { repeatsYearly: NaN })] }),
    'visible: 0': v1board({ notes: [note('n', '2026-03-04', 'Geb')], categories: catsOnly(0) }),
    'visible: "false"': v1board({ notes: [note('n', '2026-03-04', 'Geb')], categories: catsOnly('false') }),
    'visible: ""': v1board({ notes: [note('n', '2026-03-04', 'Geb')], categories: catsOnly('') }),
    'visible: NaN': v1board({ notes: [note('n', '2026-03-04', 'Geb')], categories: catsOnly(NaN) }),
    'visible: false (the literal — must still hide)': v1board({ notes: [note('n', '2026-03-04', 'Geb')], categories: catsOnly(false) }),
  };
  for (const [what, board] of Object.entries(BOOLS)) {
    test(`R4-8 HELD · ${what} — v1 and v2 paint the same board`, async () => {
      const { v1, v2 } = await both(board);
      assert.equal(v1.ok && v2.ok, true, 'neither renderer throws');
      assert.deepEqual(v2.marks, v1.marks, what);
    });
  }

  test('R4-8x HELD · a numeric id, and the categoryId pointing at it, move together', async () => {
    const { o, v1, v2 } = await both(v1board({
      categories: [{ id: 0, name: 'Null', nameEn: 'Null', paletteRef: 'blau', visible: true }],
      notes: [{ id: 'n', date: '2026-03-04', text: 'x', categoryId: 0, repeatsYearly: false }],
    }));
    assert.deepEqual(v2.marks, v1.marks, 'the note is still in its category, so it is still painted');
    assert.equal(o.core.categories[0].id, '0');
    assert.equal(o.core.notes[0].categoryId, '0', 'coercing only one of the two would re-parent the note');
  });

  test('R4-8y HELD · the guard against a repeat with no anchor holds on every route into it', async () => {
    // v1's `layout.js:72` does `Number(n.date.slice(0,4))` and takes the WHOLE board down on a
    // repeating note with no date. A3-H2 now keeps date-less notes, so this is the shape that
    // had to be refused; four ways of arriving at it are pinned.
    const SHAPES = {
      'no date key at all': { id: 'n', text: 'x', categoryId: 'cat-1', repeatsYearly: true },
      'date: ""': { id: 'n', date: '', text: 'x', categoryId: 'cat-1', repeatsYearly: true },
      'date: an object': { id: 'n', date: {}, text: 'x', categoryId: 'cat-1', repeatsYearly: true },
      'unreadable date + truthy repeat': { id: 'n', date: 'garbage', text: 'x', categoryId: 'cat-1', repeatsYearly: 'yes' },
      'five-digit year + truthy repeat': { id: 'n', date: '12026-04-01', text: 'x', categoryId: 'cat-1', repeatsYearly: 'ja' },
    };
    for (const [what, n] of Object.entries(SHAPES)) {
      const { o, v2 } = await both(v1board({ notes: [n] }));
      assert.equal(v2.ok, true, `${what}: v2 still renders`);
      assert.equal(o.core.notes.length, 1, `${what}: and the entry survives (principle 6)`);
      assert.equal(o.core.notes[0].repeatsYearly, false, `${what}: with the repeat coerced off`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. DATES — the measured cost of the ruling: a note moves from nowhere onto a day
// ─────────────────────────────────────────────────────────────────────────────

describe('R4-9 · every coerced date paints somewhere v1 painted nothing', () => {
  const DATES = {
    '4.3.2026 (German)': ['4.3.2026', '2026-03-04'],
    '3.4.2026 (German — read as 3 April, not 4 March)': ['3.4.2026', '2026-04-03'],
    '2026-3-1 (unpadded ISO)': ['2026-3-1', '2026-03-01'],
    '2026/03/04': ['2026/03/04', '2026-03-04'],
    '2026-04-01T09:00 (ISO datetime)': ['2026-04-01T09:00', '2026-04-01'],
    '20260401 (numeric YYYYMMDD)': [20260401, '2026-04-01'],
  };
  for (const [what, [given, expected]] of Object.entries(DATES)) {
    test(`R4-9 SUCCEEDED (cost) · ${what} — v1 drew nothing, v2 draws it on ${expected}`, async () => {
      const { o, v1, v2 } = await both(v1board({ notes: [note('n', given, 'Zahnarzt')] }));
      assert.deepEqual(v1.marks, [], 'v1 painted this note on no day at all');
      assert.deepEqual(v2.marks, [`note:n@${expected}`], 'v2 puts it on a day');
      assert.equal(o.v1.notes[0].date, given, 'and the field in the user\'s file');
      assert.equal(o.core.notes[0].date, expected, '…is rewritten');
    });
  }

  test('R4-9g INVERTED (finding 6 closed) · a DESIGNATED offset is refused, not read as somebody else\'s day', async () => {
    // `2026-04-01T23:00:00-05:00` is 2026-04-02 05:00 in Germany — the calendar day a German user
    // would name, and this is a German Jahresplaner. The old tail `(?:[T ].*)?$` matched the
    // offset with `.*` and threw it away, so the migration wrote 1 April into the user's file and
    // said nothing.
    //
    // THE FIX IS REFUSAL, NOT ARITHMETIC, and the product's own constraint is why: a date here is
    // a plain `YYYY-MM-DD`, no time and no zone, ever. Honouring the offset would mean choosing a
    // timezone for a file format that has none. A FLOATING time (`T09:00`) still reads — it names
    // the same day wherever you stand — and that row is two describes above.
    const { o, v2 } = await both(v1board({ notes: [note('n', '2026-04-01T23:00:00-05:00', 'Flug')] }));
    assert.equal(o.core.notes[0].date, undefined, 'the FIELD is refused …');
    assert.equal(o.core.notes.length, 1, '… the ENTRY is kept (§4b rule 3) …');
    assert.equal(o.core.notes[0].text, 'Flug');
    assert.deepEqual(v2.marks, [], '… and no day is invented on the grid');
    assert.ok(
      o.warnings.some((w) => w.includes('2026-04-01T23:00:00-05:00') && /DROPPED/.test(w)),
      '… and the drop is on the warnings channel, with the value quoted back',
    );
    // Non-vacuity: the ZONE is what did it, not the time.
    const floating = await oracle(v1board({ notes: [note('n', '2026-04-01T23:00:00', 'Flug')] }));
    assert.equal(floating.core.notes[0].date, '2026-04-01', 'a floating time still names one day');
    for (const z of ['2026-04-01T09:00Z', '2026-04-01T09:00+02:00', '2026-04-01T09:00:00-05:00']) {
      const r = await oracle(v1board({ notes: [note('n', z, 'x')] }));
      assert.equal(r.core.notes[0].date, undefined, `${z}: every designated zone is refused`);
    }
  });

  test('R4-9h INVERTED (finding 6 closed) · the ISO tail is a TIME now, so a range is refused whole', async () => {
    // The tail was `(?:[T ].*)?$` — not "a time" but "anything at all" — so a date field a user
    // typed a RANGE into resolved to its first day with no hint that the rest of what they wrote
    // had been thrown away. It is now `[T ]hh:mm(:ss)?(.fff)?` and nothing else, so the whole
    // value is unreadable rather than a prefix of one.
    const { o, v2 } = await both(v1board({ notes: [note('n', '2026-03-04 bis 2026-03-09', 'Urlaub')] }));
    assert.equal(o.core.notes[0].date, undefined, 'no half-field');
    assert.equal(o.core.notes.length, 1, 'and the entry survives, as §4b rule 3 requires');
    assert.deepEqual(v2.marks, [], 'nothing is placed on 4 March that the user did not ask for');
    assert.ok(
      o.warnings.some((w) => w.includes('2026-03-04 bis 2026-03-09') && /DROPPED/.test(w)),
      'and the whole value the user typed is quoted back at them',
    );
    // Non-vacuity: the shapes the tail is allowed to carry still read.
    for (const [given, expected] of [['2026-03-04 09:00', '2026-03-04'], ['2026-03-04T09:00:00', '2026-03-04'],
      ['2026-03-04T09:00:00.500', '2026-03-04']]) {
      const r = await oracle(v1board({ notes: [note('n', given, 'x')] }));
      assert.equal(r.core.notes[0].date, expected, `${given}: a real time is still a day`);
    }
  });

  test('R4-9i HELD · the genuinely ambiguous shapes are still refused, and cost the field, not the entry', async () => {
    for (const given of ['3/4/2026', '04.03.26', '2026-13-45', '32.13.2026', 'März', '']) {
      const { o, v2 } = await both(v1board({ notes: [note('n', given, 'x')] }));
      assert.equal(o.core.notes.length, 1, `${given}: the entry survives`);
      assert.equal(o.core.notes[0].date, undefined, `${given}: the field does not`);
      assert.deepEqual(v2.marks, [], `${given}: and nothing is invented on the grid`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. BARS — one policy now, and it is v1's: the horizon is the RENDERER's, not the file's
// ─────────────────────────────────────────────────────────────────────────────

describe('R4-10 · a one-ended bar against what v1 actually painted', () => {
  test('R4-10a INVERTED (finding 5 closed) · only a startDate: v1 paints 9 segments, and so does v2', async () => {
    // THE DEFECT: `missingBarEdge` anchored the missing end to the end the file DID carry, so a
    // bar v1 runs from 10 April to the far edge of the window was painted on ONE DAY — and an
    // `endDate` the file never held was written into the user's `board.json`, which in solo mode
    // (where `board.json` IS the checkpoint) is permanent at the first autosave.
    //
    // THE FIX: write nothing. The premise of the anchor was sound — "to the horizon" is a
    // function of TODAY and a migration that read the clock would differ between my two Macs
    // (R12) — but the conclusion did not follow, because the horizon is not DATA. It is what
    // `layout.js` does with an absent edge, and `layout.js` is the same file in both builds.
    const { o, v1, v2 } = await both(v1board({
      bars: [{ id: 'b', startDate: '2026-04-10', label: 'Sommerprojekt', categoryId: 'cat-1' }],
    }));
    assert.equal(v1.marks.length, 9, 'v1 runs it from 10 April to the far edge of the window');
    assert.deepEqual(v1.marks.slice(0, 2), ['bar:b@10-30', 'bar:b@1-31']);
    assert.deepEqual(v2.marks, v1.marks, 'and v2 paints exactly the same nine segments');
    assert.equal(o.v1.bars[0].endDate, undefined, 'the file carried no endDate …');
    assert.equal(o.core.bars[0].endDate, undefined, '… and v2 does not invent one');
    assert.equal(o.lossy, false, 'nothing was lost: nothing was ever there');
  });

  test('R4-10b INVERTED (finding 5 closed) · only an endDate: v1 paints 4 segments, and so does v2', async () => {
    const { o, v1, v2 } = await both(v1board({
      bars: [{ id: 'b', endDate: '2026-04-10', label: 'Sommerprojekt', categoryId: 'cat-1' }],
    }));
    assert.equal(v1.marks.length, 4);
    assert.deepEqual(v2.marks, v1.marks, 'the mirror of R4-10a, and the mirror image holds');
    assert.equal(o.core.bars[0].startDate, undefined, 'nothing invented at the other end either');
  });

  test('R4-10c HELD · a bar with NO dates stripes all twelve columns in v1, and in v2', async () => {
    // This row was tagged `SUCCEEDED (defect)` in round 4 — not because the PAINT was wrong (it
    // was already faithful) but because it was faithful by OMISSION while its two neighbours were
    // coerced the other way. One policy now covers all three, so this is the shape that did not
    // have to move: it is the anchor's absence, generalised.
    const { v1, v2 } = await both(v1board({
      notes: [note('n1', '2026-03-04', 'Zahnarzt')],
      bars: [{ id: 'b', label: 'Projekt', categoryId: 'cat-1' }],
    }));
    const stripes = v2.marks.filter((m) => m.startsWith('bar:b@'));
    assert.equal(stripes.length, 12, 'every column, top to bottom');
    assert.deepEqual(stripes.slice(0, 3), ['bar:b@1-31', 'bar:b@1-28', 'bar:b@1-31']);
    assert.deepEqual(v2.marks, v1.marks, 'faithful to v1 — and now it is the SAME policy as R4-10a/b');
  });

  test('R4-10d INVERTED (finding 5 closed) · and every word the user is told about it is true of v2', async () => {
    LS.clear();
    LS.setItem(LS_BOARD, JSON.stringify(ub({
      notes: [un('n1', '2026-03-04', 'Zahnarzt')],
      bars: [{ id: 'b', label: 'Projekt', categoryId: 'cat-arbeit' }],
    })));
    await bootV2();
    const w = v2store.warnings.find((x) => x.includes('"b"'));
    assert.ok(w, 'there is still a warning — the shape does need explaining');
    assert.doesNotMatch(w, /will not be DRAWN/, 'THE FALSE SENTENCE IS GONE');
    const segs = buildBoard(v2store.state, { today: TODAY }).cols.flatMap((c) => c.segs ?? []);
    assert.equal(segs.length, 12, 'the shipping renderer draws it in all twelve columns …');
    assert.match(w, /IS DRAWN, and it is drawn EVERYWHERE/, '… and that is what the warning says');
    assert.match(w, /all twelve columns/, '… with the number in it');
    assert.match(w, /taking a lane from every other bar/, '… and the consequence that actually bites');
  });

  test('R4-10e · the warning for each one-ended shape names the edge the file DID carry', async () => {
    // The three bar shapes get three different sentences, because the user sees three different
    // things. A single generic message is how R4-10d happened.
    for (const [bar, expected, segs] of [
      [{ id: 'b', startDate: '2026-04-10', label: 'x', categoryId: 'cat-arbeit' }, /IS DRAWN from "2026-04-10" to the FAR EDGE/, 9],
      [{ id: 'b', endDate: '2026-04-10', label: 'x', categoryId: 'cat-arbeit' }, /IS DRAWN from the NEAR EDGE of the visible year to "2026-04-10"/, 4],
    ]) {
      LS.clear();
      LS.setItem(LS_BOARD, JSON.stringify(ub({ bars: [bar] })));
      await bootV2();
      const w = v2store.warnings.find((x) => x.includes('"b"'));
      assert.ok(w, `${JSON.stringify(bar)}: warned`);
      assert.match(w, expected);
      assert.equal(
        buildBoard(v2store.state, { today: TODAY }).cols.flatMap((c) => c.segs ?? []).length, segs,
        'and the count the sentence implies is the count the renderer produces',
      );
    }
  });

  test('R4-10f · board.json is now a FIXED POINT for a one-ended bar — it used to be rewritten', async () => {
    // The half of R4-10a that outlives the paint. The anchor wrote an `endDate` the file never
    // held; in solo mode `board.json` IS the checkpoint (ADR 001 §9), so the first autosave
    // committed it and the second launch read it back as though the user had typed it.
    LS.clear();
    const given = ub({ bars: [{ id: 'b', startDate: '2026-04-10', label: 'Sommerprojekt', categoryId: 'cat-arbeit' }] });
    LS.setItem(LS_BOARD, JSON.stringify(given));
    await bootV2();
    await v2store.persistNow();
    const gen0 = JSON.parse(LS.getItem(LS_BOARD));
    assert.equal(gen0.bars[0].endDate, undefined, 'the autosave does not add an end the user never gave');
    assert.equal(gen0.bars[0].startDate, '2026-04-10');
    await bootV2();
    await v2store.persistNow();
    assert.deepEqual(JSON.parse(LS.getItem(LS_BOARD)).bars, gen0.bars, 'and the second launch changes nothing');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE RESIDUAL THE RULING FORBIDS — a loss the warnings channel never hears about
// ─────────────────────────────────────────────────────────────────────────────

describe('R4-11 · "every coercion must be logged so it is auditable" (§4.2)', () => {
  test('R4-11a INVERTED (finding 7 closed) · the one silent drop in the door now says its name', async () => {
    // v1 KEEPS the key — `store.js`\'s own migrate does not delete it, and a v1 board.json with
    // `{"2026-05": ""}` still has it after a restart (checked against the frozen store below).
    // The DROP stays: ADR 001 §8.2 is "one `pad.set` per NON-EMPTY scratchpad key", nothing the
    // user can SEE moves (`layout.js:259` paints a pad as `pads[key] || ''`), and v1's own editor
    // deletes a blank key too (`interact.js:620`). What was wrong was the SILENCE — the same drop
    // was reported when the value had to be COERCED to `''` and hidden when the file already held
    // `''`, which made §4b rule 2 ("every coercion is reported so it is auditable") a rule with
    // one exception nobody had decided on.
    const { o } = await both(v1board({ scratchpads: { '2026-05': '', '2026-06': 'Text' } }));
    assert.deepEqual(Object.keys(o.v1.scratchpads).sort(), ['2026-05', '2026-06'], 'v1 keeps both keys');
    assert.deepEqual(Object.keys(o.core.scratchpads), ['2026-06'], 'v2 keeps one (§8.2) …');
    assert.equal(o.lossy, false, '… does not call it a loss, because nothing on screen moves …');
    const said = o.warnings.filter((w) => w.includes('2026-05'));
    assert.equal(said.length, 1, '… and says so out loud');
    assert.match(said[0], /empty string in the file/);
    assert.match(said[0], /the KEY is not carried into v2/);
    // Non-vacuity: a pad with real text is not warned about at all.
    const kept = await oracle(v1board({ scratchpads: { '2026-06': 'Text' } }));
    assert.deepEqual(kept.warnings.filter((w) => w.includes('2026-06')), []);
  });

  test('R4-11b SUCCEEDED (defect, RESIDUAL) · board.json still stops being a fixed point after "clear a scratchpad"', async () => {
    // STILL OPEN after finding 7. Finding 7 was the SILENCE and that is closed above; this row is
    // the other half, and closing it is not this door's call: it needs either ADR 001 §8.2 to
    // change ("one `pad.set` per non-empty scratchpad key" — the line both doors and three
    // existing rows obey), or the v2 STORE to stop writing a `''` into `board.json` in the first
    // place, the way v1's own editor does (`interact.js:620,634` deletes the key). Both are
    // outside migrate1to2/replace. Nothing the user can SEE moves either way — this is a key in
    // an export, not a month of typing — which is why it is LOW and why it is still here.
    LS.clear();
    LS.setItem(LS_BOARD, JSON.stringify(ub({ scratchpads: { '2026-05': 'Milch' } })));
    await bootV2();
    v2store.mutate('pad', (s) => { s.scratchpads['2026-05'] = ''; });
    await v2store.persistNow();
    const gen0 = LS.getItem(LS_BOARD);
    await bootV2();
    await v2store.persistNow();
    const gen1 = LS.getItem(LS_BOARD);
    assert.deepEqual(JSON.parse(gen0).scratchpads, { '2026-05': '' });
    assert.deepEqual(JSON.parse(gen1).scratchpads, {}, 'DEFECT: the next launch rewrites the file with no gesture behind it');
    assert.notEqual(gen0, gen1, 'DEFECT: F-1\'s fixed point does not hold for this shape');
  });
});
