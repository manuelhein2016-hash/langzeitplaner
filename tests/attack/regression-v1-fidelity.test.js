// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION ATTACK — v1 FIDELITY AFTER THE WP-1 FIX PASS
//
// Six agents changed seven core modules in parallel. Three of those changes are
// in the materialization path — `cmpBars` (ATT-50), `projectCells`'s `{id}` seed
// and `buildSettings`'s two new invariants (ATT-30 / ATT-97), plus `migrate1to2`'s
// truncation (ATT-82) — and every one of them was proven against the WP-1 fixture
// board. This file runs the SAME v1 oracle comparison against a board that is
// ugly in the ways a real eleven-year-old `board.json` is ugly.
//
// The oracle is ADR 001 §8.3's acceptance criterion, unchanged:
//     stripV2Fields(materialize(fold(migrateV1(b).ops)))  ==  v1 store.state
//
// Every test asserts the CURRENT behaviour and says in its title whether the
// attack SUCCEEDED (a divergence a user can see) or FAILED (the defence held).
// A test that goes red here means the behaviour changed — read the body before
// "fixing" it.
// ─────────────────────────────────────────────────────────────────────────────

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { oracle, v1board, note, bar, boardDiff, boardDiffBytes, freshV1, ME, MIG_CTX } from './_regression-harness.js';
import { store, defaultState } from '../../src/js/store.js';
import { buildBoard, visibleStart } from '../../src/js/layout.js';
import { migrateV1, MigrationLossyError } from '../../src/js/core/migrate1to2.js';
import { materialize, stripV2Fields, exportV1JSON, MaterializeError } from '../../src/js/core/materialize.js';
import { fold } from '../../src/js/core/registers.js';

const MAT = (regs) => materialize(regs, {
  me: ME, familySpaceId: null, currentMembers: new Set([ME]), defaultSettings: defaultState().settings,
});

/** Every note line and every bar segment the REAL layout draws — "what the user sees". */
function drawn(state, today = '2026-03-04') {
  const m = buildBoard(state, { today });
  return {
    notes: m.cols.flatMap((c) => c.days).filter((d) => !d.empty).flatMap((d) => (d.allNotes || []).map((n) => n.id)).sort(),
    segs: m.cols.flatMap((c) => c.segs.map((s) => s.id ?? s.barId)).sort(),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// REG-1 … REG-3 — the richer board, in the shapes that stay LOSSLESS
//
// These are the real regression gate: everything here is a board v1 accepts and
// v2 claims to convert exactly, so any divergence is a defect and not a policy.
// ═════════════════════════════════════════════════════════════════════════════

describe('the richer board', () => {
  const RICH = () => v1board({
    // unsorted bars — file order disagrees with date order in BOTH directions
    bars: [
      bar('b1', '2026-05-01', '2026-05-10', 'later'),
      bar('b2', '2026-01-01', '2026-01-10', 'earlier', { categoryId: 'cat-2' }),
      bar('b3', '2026-03-01', '2026-03-02', 'mid'),
      bar('b4', '2026-02-01', '2027-01-31', 'long'),
    ],
    notes: [
      note('n1', '2026-03-04', 'Zahnarzt'),
      note('n2', '2028-02-29', 'Schalttag', { repeatsYearly: true }),   // Feb-29 repeat
      note('n3', '2026-05-01', 'Yoga', { categoryId: 'cat-2' }),
      note('n4', '2026-03-04', 'x'.repeat(80)),                          // exactly at the str80 limit
    ],
    categories: [
      { id: 'cat-1', name: 'Arbeit', nameEn: 'Work', paletteRef: 'blau', visible: true },
      { id: 'cat-2', name: 'Familie', nameEn: 'Family', paletteRef: 'gruen', visible: false },  // hidden
    ],
    scratchpads: { '2026-12': 'Weihnachten', '2026-03': 'y'.repeat(5000) },  // 5000-char pad
    settings: {
      bundesland: '',                     // no Bundesland — 7.5's normalisation must fire
      layers: { feiertage: true, schulferien: true, otherStates: false, ferienPattern: false },
      pageYears: 1, rowHeight: 30, lastCategoryId: 'cat-2',
    },
  });

  test('REG-1 FAILED (held): the whole richer board deep-equals v1, array order included', async () => {
    const board = RICH();
    // Non-vacuity: the fixture must be capable of failing every sort it exercises.
    assert.ok(board.bars[0].startDate > board.bars[1].startDate, 'bar file order == date order — REG-1 proves nothing');
    assert.ok(board.bars.map((b) => b.id).join() !== [...board.bars].sort((x, y) => (x.startDate < y.startDate ? -1 : 1)).map((b) => b.id).join(),
      'the bars are already in date order');
    assert.equal(board.notes[3].text.length, 80, 'the boundary note is no longer at the str80 limit');
    assert.equal(board.scratchpads['2026-03'].length, 5000);

    const r = await oracle(board);
    assert.equal(r.lossy, false, `a board this shape must convert losslessly: ${r.warnings.join(' | ')}`);
    assert.deepEqual(boardDiff(r.v1, r.core), [], 'the richer board diverged');
    assert.deepEqual(r.core, r.v1);
    assert.deepEqual(r.core.bars.map((b) => b.id), ['b1', 'b2', 'b3', 'b4'], 'v1 file order, preserved');
    // The ONE thing that is not byte-identical is the scratchpads object's KEY ORDER — REG-3.
    assert.deepEqual(boardDiffBytes(r.v1, r.core), ['scratchpads'],
      'something other than scratchpad key order became byte-unstable');
  });

  test('REG-2 FAILED (held): the richer board renders identically through the REAL layout.js', async () => {
    const r = await oracle(RICH());
    for (const today of ['2026-03-04', '2028-02-29', '2027-01-01']) {
      const a = buildBoard(r.v1, { today });
      const b = buildBoard(r.core, { today });
      assert.equal(JSON.stringify(a.cols), JSON.stringify(b.cols), `the board moved at today=${today}`);
    }
  });

  test('REG-3 ACCEPTED (open, WP-3): exportJSON is NOT byte-identical — scratchpad keys are re-sorted', async () => {
    // ATT-51 fixed entry KEY order and asserted byte-identity over `notes` and `bars` only.
    // `entities.js:sortScratchpads` sorts the scratchpads OBJECT, and v1 keeps file order, so
    // 11.4's "board.json stays diffable" is still false for the pads: the first export after
    // upgrade re-orders every month key. Not a render change — a diff-noise change in the file
    // 11.2 mails to somebody.
    //
    // ACCEPTED FOR WP-1, OPEN FOR WP-3 — the PO-visible reason:
    //
    // Nothing on the board moves and no value is lost (both asserted below). The sort is not
    // gratuitous either: a v2 pad is a `pad:<month>` ENTITY, and entity order in a projection has
    // to be a function of the data rather than of Map insertion order, or two devices holding the
    // same registers would export different bytes — which is a worse diffability failure than a
    // one-time re-order, and a convergence smell besides.
    //
    // What is owed is a decision, not code: 11.4 asks for a diffable file, and the choice is
    // between "the first export after upgrade has a large diff, and every export after it is
    // stable" (today) and teaching the EXPORTER to preserve the incoming key order. That belongs
    // with whoever owns export in WP-3, and it is one function either way.
    const board = v1board({ scratchpads: { '2026-12': 'z', '2026-01': 'a' } });
    assert.deepEqual(Object.keys(board.scratchpads), ['2026-12', '2026-01'], 'the fixture is pre-sorted — vacuous');

    await freshV1(board);
    const v1json = store.exportJSON();
    const st = MAT(fold(migrateV1(structuredClone(board), MIG_CTX).ops));
    const corejson = exportV1JSON(st);

    assert.notEqual(corejson, v1json, 'the bytes are identical — REG-3 has been closed, invert it');
    assert.deepEqual(Object.keys(JSON.parse(v1json).scratchpads), ['2026-12', '2026-01']);
    assert.deepEqual(Object.keys(JSON.parse(corejson).scratchpads), ['2026-01', '2026-12']);
    // …and the VALUES are all there. This is ordering, not loss.
    assert.deepEqual(JSON.parse(corejson).scratchpads, JSON.parse(v1json).scratchpads);
    // The rest of the file IS byte-identical, which is what makes the pads the whole finding.
    const strip = (s) => { const o = JSON.parse(s); delete o.scratchpads; return JSON.stringify(o, null, 2); };
    assert.equal(strip(corejson), strip(v1json), 'something OTHER than the pads also diverged');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// REG-4 … REG-7 — the ATT-82 fix, at its edges
// ═════════════════════════════════════════════════════════════════════════════

describe('ATT-82 at its edges', () => {
  test('REG-4 FAILED (held): a 140-character note is TRUNCATED, and the note stays on the board', async () => {
    const LONG = 'A'.repeat(140);
    const r = await oracle(v1board({ notes: [note('n1', '2026-03-01', LONG)] }));
    assert.equal(r.lossy, true, 'a truncation is a loss and must be reported as one');
    assert.equal(r.core.notes.length, 1, 'the ENTRY survives — that is the whole ATT-82 argument');
    assert.equal(r.core.notes[0].text, 'A'.repeat(80));
    assert.equal(r.v1.notes[0].text, LONG, 'v1 keeps all 140 — the divergence is the accepted loss');
    assert.ok(r.report.losses.some((l) => l.reason === 'truncated' && l.dropped === 'A'.repeat(60)),
      'the cut characters are not recoverable from the report');
    // and it is still drawn, on the same day
    assert.deepEqual(drawn(r.core).notes, drawn(r.v1).notes);
  });

  test('REG-5 CLOSED (inverted): a NON-STRING note text is KEPT as v1 paints it, and the note stays', async () => {
    // The ATT-82 fix covered the LENGTH failure only: `truncateToFit` returns null for a
    // non-string, so `text: 12345` took the "drop the field" path, `text` was then absent,
    // `renderable()` (§5 step 3) failed, and the entry was gone — from the board AND from the
    // next export. Verbatim the disaster ATT-82's own comment says it exists to prevent.
    //
    // v1 renders it, through one expression: `popover.js:193` is `n.text || '…'`, and `12345` is
    // truthy. `coerceToV1Text` is that expression — falsy → `''` (v1's „…", and what ATT-53
    // already gives an ABSENT text), truthy non-string → `String(value)`, which is the string v1
    // actually paints into the cell.
    const r = await oracle(v1board({ notes: [{ id: 'n1', date: '2026-03-01', text: 12345, categoryId: 'cat-1', repeatsYearly: false }] }));
    assert.equal(r.v1.notes.length, 1, 'v1 keeps the note');
    assert.equal(r.core.notes.length, 1, 'and so does core — REG-5 CLOSED');
    assert.equal(r.core.notes[0].text, '12345', 'as the string v1 paints');
    assert.equal(r.core.notes[0].date, '2026-03-01', 'on the day the user put it on');

    // The assertion that makes it fidelity rather than survival: the REAL layout.js draws the
    // same note in the same place from both boards.
    assert.equal(drawn(r.v1).notes.length, 1, 'v1 draws it');
    assert.deepEqual(drawn(r.core).notes, drawn(r.v1).notes, 'and core draws the same note');

    // Still reported, and the ORIGINAL value is recoverable — the register cannot hold a number,
    // and „nichts geht verloren" is satisfied by the report, not by pretending it could.
    assert.equal(r.lossy, true);
    const cut = r.report.losses.find((l) => l.field === 'text');
    assert.equal(cut.reason, 'coerced');
    assert.equal(cut.value, 12345, 'the number the user actually had');
    assert.equal(cut.kept, '12345');
  });


  test('REG-6 CLOSED (inverted): null, absent and "" are ONE outcome — as they are one outcome in v1', async () => {
    // Three spellings of "this note has no usable text", identical in v1 (`n.text || '…'`), used
    // to have three different outcomes in core. The inconsistency sat inside the ATT-53 / ATT-82
    // pair: ATT-53 already decided that an ABSENT text migrates as `''` and stays on the board,
    // and a NULL one — which passes validation, because `null` is the legal "cleared" register
    // value — was written as a cleared register, skipped by `materialize`, and took the note off
    // the board.
    //
    // The narrowness matters and is asserted below: `null` is still a first-class value
    // everywhere it does not cost the entry. `cat.nameEn: null` is carried verbatim (ADR 001 §2).
    const absent = await oracle(v1board({ notes: [{ id: 'n1', date: '2026-03-04', categoryId: 'cat-1', repeatsYearly: false }] }));
    assert.equal(absent.core.notes.length, 1, 'ATT-53: an absent text migrates as "" and stays');
    assert.equal(absent.core.notes[0].text, '');
    assert.equal(absent.lossy, false);

    const nulled = await oracle(v1board({ notes: [{ id: 'n1', date: '2026-03-04', text: null, categoryId: 'cat-1', repeatsYearly: false }] }));
    assert.equal(nulled.v1.notes.length, 1, 'v1 keeps it and draws "…"');
    assert.equal(drawn(nulled.v1).notes.length, 1);
    assert.equal(nulled.core.notes.length, 1, 'and so does core — REG-6 CLOSED');
    assert.equal(nulled.core.notes[0].text, '', 'the same outcome as ABSENT, which is v1\'s outcome');
    assert.equal(drawn(nulled.core).notes.length, 1, 'and the real layout.js draws it');

    const empty = await oracle(v1board({ notes: [{ id: 'n1', date: '2026-03-04', text: '', categoryId: 'cat-1', repeatsYearly: false }] }));
    assert.equal(empty.core.notes[0].text, '', 'and so does the third spelling');

    // THE LINE. `null` keeps its meaning everywhere it does not cost the entry — which is
    // everywhere except the fields `renderable()` requires, and that set is PROBED from the real
    // predicate rather than listed. A fix that turned every null into `''` would pass the three
    // assertions above and be wrong.
    const cat = await oracle({
      ...v1board({ notes: [] }),
      categories: [{ id: 'cat-1', name: 'Arbeit', nameEn: null, paletteRef: 'blau', visible: true }],
    });
    assert.equal(Object.prototype.hasOwnProperty.call(cat.core.categories[0], 'nameEn'), false,
      'a null nameEn is still a CLEARED register, not an empty string — ADR 001 §2 stands');
    assert.equal(cat.lossy, false, 'and it is not a loss');
  });

  test('REG-7 FAILED (held) + REG-5 CLOSED: a bar LABEL is truncated or coerced, never dropped', async () => {
    const r = await oracle(v1board({ bars: [bar('b1', '2026-03-01', '2026-03-10', 'B'.repeat(60))] }));
    assert.equal(r.core.bars.length, 1, 'a label is not part of a bar\'s renderability, so the bar was never at risk');
    assert.equal(r.core.bars[0].label, 'B'.repeat(40));
    assert.equal(r.lossy, true);
    // …and a NUMERIC label is now kept as v1 paints it too (REG-5's rule, same function). The
    // bar was never at risk of vanishing — `label` is not part of renderability — but it was
    // landing on the board unnamed, which is the outcome `migrate1to2.js` gives as its reason for
    // truncating rather than dropping in the first place.
    const n = await oracle(v1board({ bars: [{ id: 'b1', startDate: '2026-03-01', endDate: '2026-03-05', label: 7, categoryId: 'cat-1' }] }));
    assert.equal(n.core.bars.length, 1, 'the bar survives — `label` is not renderability');
    assert.equal(n.core.bars[0].label, '7', 'and it keeps its name, where v1 draws "7"');
    assert.equal(n.v1.bars[0].label, 7);
    assert.equal(n.lossy, true, 'still reported: the register cannot hold a number');

    // A NULL label, by contrast, is still a null register: a bar renders without one, so there is
    // nothing to protect and ADR 001 §2 applies unchanged. This is the REG-6 line, on this door.
    const z = await oracle(v1board({ bars: [{ id: 'b1', startDate: '2026-03-01', endDate: '2026-03-05', label: null, categoryId: 'cat-1' }] }));
    assert.equal(z.core.bars.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(z.core.bars[0], 'label'), false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// REG-8 … REG-10 — settings, where three fixes met
// ═════════════════════════════════════════════════════════════════════════════

describe('settings', () => {
  // Every holiday cell the REAL layout.js paints, for the "is the Feiertage layer on?" question.
  const holidays = (state) => buildBoard(state, { today: '2026-03-04' })
    .cols.flatMap((c) => c.days.filter((d) => !d.empty && d.holiday).map((d) => `${d.date}:${d.holiday.name}`));

  /** The whole render model, as bytes — the strongest "these two boards look the same". */
  const model = (state) => JSON.stringify(buildBoard(state, { today: '2026-03-04' }));

  test('REG-8 CLOSED: a NULL setting takes v1\'s reading of null — the layer stays OFF', async () => {
    // WAS: "REG-8 SUCCEEDED — a NULL setting reverts to the v2 default, a LAYER TOGGLE FLIPS ON".
    //
    // `store.js:76-80` is a SPREAD, so an explicit `layers.feiertage: null` survives v1's
    // `migrate()` unchanged and `layout.js:104` reads it as FALSE. The board the user's file
    // describes has the Feiertage layer OFF. `prefsFromRegisters` skipped the null register and
    // `buildSettings` supplied `defaultState()`'s `true`, so on upgrade day the layer came back
    // ON — silently, with `lossy: false`, and the next export wrote `true` into the file.
    //
    // `applyClearedPrefs` now reproduces v1's reading field by field: `false` for a pref v1 reads
    // as a boolean, the default for everything else (`rowHeight || 22`, `paper || 'a4'`, …),
    // which is what v1's consuming call sites actually do with a null.
    const board = v1board({
      settings: { bundesland: 'BY', layers: { feiertage: null, schulferien: false, otherStates: false, ferienPattern: false } },
    });
    const r = await oracle(board);
    assert.equal(r.lossy, false, 'nothing was reported, so silence is all the user would get');
    assert.equal(r.v1.settings.layers.feiertage, null, 'v1: null, i.e. the layer is off');
    assert.equal(r.core.settings.layers.feiertage, false, 'core: OFF, as every v1 reader reads it');
    assert.equal(!!r.v1.settings.layers.feiertage, !!r.core.settings.layers.feiertage,
      'THE USER-VISIBLE CLAIM: v1 and core agree on whether the layer is on');

    // …and on the board itself, through the REAL layout.js. Not vacuous: the same board with the
    // layer authored `true` paints 20 Feiertage in Bayern, and this one paints none.
    assert.deepEqual(holidays(r.core), [], 'core still painted Feiertage');
    assert.deepEqual(holidays(r.v1), [], 'v1 painted Feiertage — the fixture is wrong');
    const on = await oracle(v1board({ settings: { bundesland: 'BY', layers: { feiertage: true } } }));
    assert.ok(holidays(on.core).length > 10, 'the control board paints no holidays — test is vacuous');
    assert.deepEqual(holidays(on.core), holidays(on.v1));

    // THE GENERIC FORM — every pref in the settings table, explicitly null, against the v1 oracle.
    // The expectation is derived from the DEFAULT'S TYPE, exactly as `applyClearedPrefs` derives
    // it, and the v1 call site that produces it is named per row.
    const d = defaultState().settings;
    const V1_READS_NULL_AS = {
      bundesland: '',                     // layout.js:105 — holidayIndex treats null exactly as ''
      'layers.feiertage': false,          // layout.js:104 — `s.layers.feiertage ?`
      'layers.schulferien': false,        // layout.js:107
      'layers.otherStates': false,        // layout.js:191 — `h.own || s.layers.otherStates`
      'layers.ferienPattern': false,      // board.js
      mode: 'rolling',                    // layout.js:24 — `=== 'pinned'` is false for null
      pageYears: 0,                       // layout.js:26 — `(settings.pageYears || 0)`
      language: 'de',                     // layout.js:89 — `=== 'en' ? 'en' : 'de'`
      launchAtLogin: false,               // main.js:321 — `!!s.launchAtLogin`
      menuBarIcon: false,                 // main.js:320 — `!!s.menuBarIcon`
      rowHeight: 22,                      // layout.js:92 — `s.rowHeight || 22`
      colWidth: 118,                      // layout.js:268 — `s.colWidth || 118`
      paper: 'a4',                        // print.js:25 — `s.paper || 'a4'`
      seenFirstRun: false,                // main.js:334 — `if (settings.seenFirstRun) return;`
      lastCategoryId: 'cat-1',            // store.js:87 — the dangling-reference repair, both sides
    };
    // The table is COMPLETE — a pref added to defaultState() without a row here fails the suite
    // rather than going untested. `startMonth` is the one exclusion and it is checked below.
    const flatDefaults = Object.keys(d).flatMap((k) => (k === 'layers' ? Object.keys(d.layers).map((l) => `layers.${l}`) : [k]));
    assert.deepEqual(flatDefaults.filter((k) => k !== 'startMonth').sort(),
      Object.keys(V1_READS_NULL_AS).sort(), 'the null-pref table has drifted from defaultState()');

    for (const [name, want] of Object.entries(V1_READS_NULL_AS)) {
      const [head, leaf] = name.split('.');
      const settings = leaf ? { [head]: { [leaf]: null } } : { [name]: null };
      const q = await oracle(v1board({ settings }));
      const got = leaf ? q.core.settings[head][leaf] : q.core.settings[name];
      const v1v = leaf ? q.v1.settings[head][leaf] : q.v1.settings[name];
      // v1 REPAIRS exactly two of these on load and keeps the null on every other one:
      // `store.js:87` (lastCategoryId → categories[0]) and `store.js:91` (7.5 — no Bundesland
      // means schulferien off). Everything else reaches `state.settings` as the literal null,
      // which is what makes "v1's reading of null" a question with an answer.
      const V1_REPAIRS = { lastCategoryId: 'cat-1', 'layers.schulferien': false };
      assert.equal(v1v, Object.prototype.hasOwnProperty.call(V1_REPAIRS, name) ? V1_REPAIRS[name] : null,
        `v1's own value for a null ${name} is not what this table says`);
      assert.equal(got, want, `core read a null ${name} as ${JSON.stringify(got)}, v1 reads it as ${JSON.stringify(want)}`);
      // The claim that matters: the two boards RENDER the same. `model()` is the whole layout
      // model, bytes and all, so a divergence anywhere in it fails here.
      assert.equal(model(q.core), model(q.v1), `a null ${name} renders differently in v1 and core`);
    }

    // `startMonth` is the one pref with NO v1 reading of null: `layout.js:25` turns it into a NaN
    // year and `holidays.js:51` never returns, so on a pinned board v1 does not render it — it
    // freezes. There is nothing to reproduce, and the fallback stays the caller's clock read.
    const cleared = await oracle(v1board({ settings: { startMonth: null } }));
    assert.equal(cleared.v1.settings.startMonth, null, 'v1 keeps the null and hangs on it');
    assert.equal(cleared.core.settings.startMonth, defaultState().settings.startMonth,
      'core falls back to ctx.defaultSettings — the one place a clock read is allowed');
    const started = visibleStart(cleared.core.settings, '2026-03-04');
    assert.ok(Number.isInteger(started.y) && Number.isInteger(started.m),
      'the fallback must not be another NaN year');
    // With no ctx.defaultSettings there IS no fallback, and REG-9's guard refuses the board
    // rather than handing layout.js a NaN.
    assert.throws(
      () => materialize(cleared.regs, { me: ME, familySpaceId: null, currentMembers: new Set([ME]) }),
      MaterializeError);
  });

  test('REG-9 CLOSED: the guard now fires on a NaN year, and the four boards v1 opens project as v1 opens them', async () => {
    // WAS: "REG-9 SUCCEEDED — ATT-97's month guard REFUSES four boards v1 opens without hanging".
    // The hang (`holidays.js:51`) needs a year `Date` cannot express. `MONTH_KEY_RE` was much
    // stricter than that, so the guard converted four perfectly openable boards into an
    // unopenable app. `'2026-1'` was the sharpest: v1 renders it with its first column at 2026-01
    // — exactly right — while core threw MaterializeError and the board could not be projected
    // AT ALL. The guard is now `pinnedMonthsRenderable` (entities.js §2b), which runs v1's own
    // `visibleStart` + `addMonths` + `layout.js:103` year set and asks only whether
    // `holidays.js:51` terminates.
    //
    // BOTH HALVES ARE ASSERTED HERE, because either one alone is satisfiable by a wrong guard:
    // a guard that refuses nothing passes the second half, and the regex passed the first.
    const FIRST = { '2026-1': '2026-01', '2026-13': '2027-01', '2026-00': '2025-12', '26-01': '26-01' };
    for (const [startMonth, first] of Object.entries(FIRST)) {
      const board = v1board({ settings: { startMonth } });

      // v1, measured and not assumed — reaching this line at all is the proof it does not hang.
      await freshV1(board);
      const v1m = buildBoard(store.state, { today: '2026-03-04' });
      assert.equal(v1m.cols.length, 12, `v1 hung or failed on ${startMonth}`);
      assert.equal(v1m.cols[0].key, first, `v1's first column for ${startMonth}`);

      // core: projects, and projects to the same board — settings bytes and all.
      const r = await oracle(board);
      assert.equal(r.core.settings.startMonth, startMonth, 'the value is carried, not repaired');
      assert.deepEqual(boardDiff(r.v1, r.core), [], `${startMonth}: core diverged from v1`);

      // …and the same twelve columns come out of the REAL layout.js from core's own state.
      const cm = buildBoard(r.core, { today: '2026-03-04' });
      assert.deepEqual(cm.cols.map((c) => c.key), v1m.cols.map((c) => c.key),
        `${startMonth}: core's board is not v1's board`);
    }

    // THE HANG IS STILL IMPOSSIBLE. `'nope'` is a genuinely NaN-producing startMonth: v1's own
    // `visibleStart` returns `{y: NaN}` for it, and `holidays.js:51`'s
    // `while (dow(NaN, 11, d) !== 3) d -= 1;` then never returns. `visibleStart` is called here
    // rather than `buildBoard` for the obvious reason — `buildBoard` would never come back.
    for (const hangs of ['nope', 'null', '20x6-01']) {
      const v = visibleStart({ mode: 'pinned', startMonth: hangs, pageYears: 0 }, '2026-03-04');
      assert.ok(Number.isNaN(v.y), `${hangs} does not actually produce a NaN year`);
      const regs = fold(migrateV1(v1board({ settings: { startMonth: hangs } }), MIG_CTX).ops);
      assert.throws(() => MAT(regs), MaterializeError, `core projected ${hangs} — the hang is back`);
    }
    // The original ATT-97 shape — a pinned board whose startMonth never reached a register at all
    // — is still refused, with the ctx key that fixes it in the message.
    const bare = fold(migrateV1(v1board({ settings: { startMonth: undefined } }), MIG_CTX).ops);
    assert.throws(() => materialize(bare, { me: ME, familySpaceId: null, currentMembers: new Set([ME]) }),
      /ctx\.defaultSettings/);

    // `pageYears` walks the same loop off the end of Date from a well-formed startMonth. The
    // regex could not see this field; the new guard runs `visibleStart`, so it does.
    const paged = fold(migrateV1(v1board({ settings: { startMonth: '2026-01', pageYears: 1e9 } }), MIG_CTX).ops);
    assert.throws(() => MAT(paged), MaterializeError);

    // Non-vacuity: a well-formed month is NOT refused.
    const ok = fold(migrateV1(v1board({ settings: { startMonth: '2026-01' } }), MIG_CTX).ops);
    assert.equal(MAT(ok).settings.startMonth, '2026-01');
  });

  test('REG-10 FAILED (held): 7.5 and the lastCategoryId repair both still fire on the richer board', async () => {
    const r = await oracle(v1board({
      categories: [{ id: 'c9', name: 'Alt', nameEn: 'Old', paletteRef: 'blau', visible: true }],
      settings: { bundesland: '', layers: { feiertage: true, schulferien: true, otherStates: false, ferienPattern: false }, lastCategoryId: 'gone' },
    }));
    assert.equal(r.core.settings.layers.schulferien, false, 'ATT-30 / 7.5');
    assert.equal(r.core.settings.lastCategoryId, 'c9', 'store.js:86');
    assert.deepEqual(boardDiff(r.v1, r.core), []);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// REG-11 … REG-13 — the shapes migration handles by POLICY, checked against v1
// ═════════════════════════════════════════════════════════════════════════════

describe('policy divergences, measured', () => {
  test('REG-11 ACCEPTED (by policy, both doors): duplicate ids are RE-KEYED, so the id v1 shows is not the id core shows', async () => {
    // ACCEPTED DIVERGENCE FROM v1 — the PO-visible reason: v1 tolerates two entries sharing an id
    // because its state is arrays; v2 cannot, because one entity key is one register set and the
    // second entry would LWW over the first. Re-keying is the only option that keeps BOTH entries
    // — which is the half the user can see — and a v1 entity id is opaque: nothing outside the
    // entry refers to a note or bar id. The id itself is never shown in the UI.
    //
    // ROUND 2: `replace.js` used to DROP the second copy instead (REG-22). Both doors re-key now,
    // through the same derived `rekeyed`, so the same file gives the duplicate the same new id
    // whichever door it comes through — asserted in regression-shared-invariants.test.js REG-22.
    const dup = v1board({ notes: [note('n1', '2026-03-01', 'first'), note('n1', '2026-04-01', 'second')] });
    const r = await oracle(dup);
    assert.deepEqual(r.v1.notes.map((n) => n.id), ['n1', 'n1'], 'v1 tolerates the collision');
    assert.equal(r.core.notes.length, 2, 'BOTH survive — the important half');
    assert.equal(r.core.notes[0].id, 'n1');
    assert.notEqual(r.core.notes[1].id, 'n1', 'the second was re-keyed');
    assert.equal(r.lossy, false, 'and it is not reported as a LOSS, only as a warning');
    assert.ok(r.warnings.some((w) => /RE-KEYED/.test(w)));
    // Deterministic: the same file re-keys to the same id on the other Mac (R12).
    const again = migrateV1(structuredClone(dup), MIG_CTX);
    assert.equal(MAT(fold(again.ops)).notes[1].id, r.core.notes[1].id);
  });

  test('REG-12 FAILED (held): an empty category list is substituted DETERMINISTICALLY, as v1 does', async () => {
    const board = { schemaVersion: 1, notes: [note('n1', '2026-03-01', 'a')], bars: [], categories: [], scratchpads: {},
      settings: { ...v1board().settings, lastCategoryId: 'cat-1' } };
    const r = await oracle(board);
    assert.deepEqual(r.core.categories.map((c) => c.name), ['Arbeit', 'Familie', 'Reisen', 'Deadlines'],
      'v1 store.js:73 substitutes four defaults; core must too');
    assert.deepEqual(r.core.categories.map((c) => c.name), r.v1.categories.map((c) => c.name));
    assert.equal(r.core.notes[0].categoryId, r.core.categories[0].id, 'the dangling reference was repaired');
    assert.equal(r.core.settings.lastCategoryId, r.core.categories[0].id);
    // The ONLY divergence is the id itself: v1 mints crypto.randomUUID, core derives (R12).
    assert.notEqual(r.core.categories[0].id, r.v1.categories[0].id);
    const again = migrateV1(structuredClone(board), MIG_CTX);
    assert.deepEqual(MAT(fold(again.ops)).categories.map((c) => c.id), r.core.categories.map((c) => c.id),
      'two Macs must derive the same four ids');
  });

  test('REG-13 ACCEPTED (by policy, both doors): an EMPTY-STRING scratchpad key is dropped', async () => {
    const r = await oracle(v1board({ scratchpads: { '2026-03': '' } }));
    assert.deepEqual(r.v1.scratchpads, { '2026-03': '' }, 'v1 keeps the key');
    assert.deepEqual(r.core.scratchpads, {}, 'migration takes non-empty keys only (§8.2)');
    assert.equal(r.lossy, false, 'and does not call it a loss');
    // ACCEPTED DIVERGENCE FROM v1 — the PO-visible reason:
    //
    // ADR 001 §8.2 says "one `pad.set` per NON-EMPTY scratchpad key", and NOTHING THE USER CAN
    // SEE MOVES: v1 paints a pad as `state.scratchpads[key] || ''` (`layout.js:259`), so `''` and
    // absent are the same empty textarea, and v1's own editor DELETES the key when the text is
    // blank (`interact.js:620,634`) — a `''` only ever reaches us from a hand-edited file. The
    // divergence is a key in an export, not a pad on a board.
    //
    // ROUND 2: `replace.js` used to do the OPPOSITE for the same bytes, which was the real
    // defect — the same file kept the key through a restore and dropped it through a relaunch
    // (REG-23). Both doors drop it now; see regression-shared-invariants.test.js REG-23.
  });
});
