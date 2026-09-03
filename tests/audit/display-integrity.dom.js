// TIER 2 · AUDIT — PASS 3, DISPLAY INTEGRITY
//
// What `tests/tier2/e1-incremental.dom.js` does not cover, and what is behind the gap.
//
// LZP-1007 states ONE invariant, in `src/js/board.js`'s own words:
//
//     **The incremental result is the full result.** Not "close enough": the same
//     DOM, node for node, attribute for attribute.
//
// `e1-incremental.dom.js` holds that claim over 89 cells, 25 mutation kinds and ten
// eight-step chains, comparing `#board.outerHTML` byte for byte. Its random walk runs
// from a FIXED seed (`let seed = 20260903`), so those 89 cells are a fixed 89 cells,
// and this file is about a transition that is not one of them.
//
// ── HOW TO READ THE VERDICTS ─────────────────────────────────────────────────────
//
//   §D1 · §D2 · §D3 · §D6 are RED ON ARRIVAL. Each asserts a property the app is
//         supposed to have and does not. They are the findings.
//   §D4 · §D5 · §D7 · §D8 are GREEN, deliberately. They are the negatives this pass
//         went looking for and did not find — the redaction boundary AT THE GLASS,
//         the „neu" tell's withdrawal, and 17.2's ordering on the incremental path.
//         A negative nobody can re-run is not a negative.
//   §D9 is a MEASUREMENT of why §D1 is not in e1's 89 cells.
//
// ── WHAT THIS FILE DRIVES, AND WHAT IT THEREFORE DOES NOT PROVE ──────────────────
//
// It writes `store.state` directly and calls `renderBoard`, exactly as
// `e1-incremental.dom.js` does, because the seam under audit is MODEL → DOM
// (`layout.js` + `board.js`). It therefore says nothing about whether `materialize.js`
// puts the right thing in `store.state` — `projectable()`'s Privat gate, the fold, the
// wire — all of which are covered upstream by tier 1, the attack suite and the fleet.
// Where a row's meaning depends on that, it says so.
//
// Plain script: globals are test, assert, $, $$, waitFor, sleep, importApp, diag, skip.
// ─────────────────────────────────────────────────────────────────────────────────

const { store } = await importApp('store.js');
const { renderBoard, invalidateBoardCache, currentModel } = await importApp('board.js');

const boardEl = () => $('#board');
const S = () => store.state.settings;

const BASE_SETTINGS = JSON.parse(JSON.stringify(store.state.settings));
const BASE_NOTES = store.state.notes;
const BASE_BARS = store.state.bars;
const BASE_PADS = JSON.parse(JSON.stringify(store.state.scratchpads));

const MAMA = { id: 'mem_mama', colorRef: 'magenta', initial: 'M' };
const PAPA = { id: 'mem_papa', colorRef: 'gruen', initial: 'P' };

const cat0 = () => store.state.categories[0].id;

const own = (id, date, text, x = {}) => ({
  id, uuid: id, date, text, categoryId: cat0(), repeatsYearly: false,
  isForeign: false, ownerId: 'mem_me', level: null, memberColorRef: null,
  initial: null, exposure: null, isNew: false, ...x,
});
const foreign = (id, date, who, level, text, x = {}) => ({
  id: `fnote:${who.id}/${id}`, uuid: id, date, text, repeatsYearly: false,
  isForeign: true, ownerId: who.id, level, memberColorRef: who.colorRef,
  initial: who.initial, exposure: null, isNew: false, coEdit: false, ...x,
});
const ownBar = (id, a, b, label, x = {}) => ({
  id, uuid: id, startDate: a, endDate: b, label, categoryId: cat0(),
  isForeign: false, ownerId: 'mem_me', level: null, memberColorRef: null,
  initial: null, exposure: null, isNew: false, ...x,
});
const foreignBar = (id, a, b, who, level, label, x = {}) => ({
  id: `fbar:${who.id}/${id}`, uuid: id, startDate: a, endDate: b, label,
  isForeign: true, ownerId: who.id, level, memberColorRef: who.colorRef,
  initial: who.initial, exposure: null, isNew: false, coEdit: false, ...x,
});

/** A quiet, deterministic board: no holidays, no Ferien, nothing but what a row puts on it. */
function install(notes, bars, extra = {}) {
  store.state.notes = notes;
  store.state.bars = bars;
  store.state.scratchpads = {};
  Object.assign(S(), {
    mode: 'pinned', startMonth: '2026-01', pageYears: 0,
    rowHeight: 22, colWidth: 118, density: 'kompakt',
    hiddenMembers: {}, bundesland: '', language: 'de',
    layers: { feiertage: false, schulferien: false, otherStates: false },
    ...extra,
  });
  invalidateBoardCache();
  renderBoard(boardEl());
}

function restore() {
  store.state.notes = BASE_NOTES;
  store.state.bars = BASE_BARS;
  store.state.scratchpads = JSON.parse(JSON.stringify(BASE_PADS));
  store.state.settings = JSON.parse(JSON.stringify(BASE_SETTINGS));
  invalidateBoardCache();
  renderBoard(boardEl());
}

/** Where two serialisations first differ, with enough of both sides to read. */
function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 100);
  return `at char ${i} of ${a.length}/${b.length}\n`
    + `        incremental: …${a.slice(from, i + 120)}\n`
    + `        full       : …${b.slice(from, i + 120)}`;
}

/** e1's comparison, reproduced: incremental board vs a from-scratch rebuild of the same model. */
function compare() {
  const inc = boardEl().outerHTML;
  invalidateBoardCache();
  renderBoard(boardEl());
  const full = boardEl().outerHTML;
  return { equal: inc === full, inc, full };
}

// ═════════════════════════════════════════════════════════════════════════════════
// §D1 · THE YEAR PAGE TURN — ONE CLICK OF A SHIPPED BUTTON BREAKS THE ONE INVARIANT
//
// `main.js:page(dir)` — the „‹ ›" year pager, wired to `pg-prev`/`pg-next` and reached
// again from `jumpToToday()` — does `pageYears += dir`, and `layout.js:visibleStart`
// turns that into `addMonths(start, pageYears * 12)`. So column i keeps its MONTH and
// changes its YEAR, and row r keeps its DAY OF MONTH.
//
// A yearly repeat (9.5, „Omas Geburtstag") is expanded by
// `entities.js:noteOccurrences`, which pushes THE SAME NOTE OBJECT once per year:
//
//     for (let y = …; y <= y1; y++) push(projectYearly(n.date, y), n);
//
// so the occurrence in 2027 and the occurrence in 2026 carry the same `note.id`.
// `board.js:patchBody` keys notes by `n.note.id` and keeps a node whose `noteSig` is
// unchanged — and `noteSig` is over id, colour, five flags, initial, exposure and
// text. It does NOT mention the day. `renderNote` does:
//
//     node.dataset.date = d.date;
//
// The signature and its builder are supposed to be a pair. Here they are not, and
// `board.js`'s own header names that as the only way the design can break: "a field
// added to one without the other is the only way this design can break."
// ═════════════════════════════════════════════════════════════════════════════════

test('§D1 · a year page turn leaves a repeating note carrying last year’s date', () => {
  try {
    const n = own('rep1', '2020-03-12', 'Omas Geburtstag', { repeatsYearly: true });
    install([n], []);

    const dateOf = () => {
      const el = $('#board .note[data-note-id="rep1"]');
      return el ? { note: el.dataset.date, row: el.closest('.day').dataset.date } : null;
    };
    const at0 = dateOf();
    diag(`  page 0: .note says ${at0.note}, the row it is in says ${at0.row}`);

    // The gesture: `main.js:page(+1)`.
    S().pageYears = 1;
    renderBoard(boardEl());                        // the incremental path, alone
    const at1 = dateOf();
    diag(`  page 1: .note says ${at1.note}, the row it is in says ${at1.row}`);

    const cmp = compare();
    if (!cmp.equal) diag('  ' + firstDiff(cmp.inc, cmp.full));

    // Two ways of saying the same thing. The first is the contract `interact.js`
    // reads (see §D2); the second is LZP-1007's stated invariant.
    assert.equal(at1.note, at1.row,
      `a .note's data-date must name the day it is drawn on: the element says ${at1.note}, `
      + `the day row it sits in says ${at1.row}`);
    assert.ok(cmp.equal,
      'the incremental board is not the board a full rebuild produces');
  } finally { restore(); }
});

test('§D1b · it persists, and it is only ever corrected by luck', () => {
  try {
    const n = own('rep1', '2020-03-12', 'Omas Geburtstag', { repeatsYearly: true });
    install([n], []);
    const read = () => {
      const el = $('#board .note[data-note-id="rep1"]');
      return el ? `${el.dataset.date} in ${el.closest('.day').dataset.date}` : '(absent)';
    };

    const seen = [];
    for (const y of [1, 2, 3, 2, 1, 0]) {
      S().pageYears = y;
      renderBoard(boardEl());
      seen.push(`+${y}y → ${read()}`);
    }
    for (const s of seen) diag('  ' + s);

    const el = $('#board .note[data-note-id="rep1"]');
    const wrong = seen.filter((s) => {
      const m = s.match(/→ (\S+) in (\S+)$/);
      return m && m[1] !== m[2];
    });
    diag(`  ${wrong.length} of ${seen.length} pages carried a stale date`);
    // The last step lands back on page 0, where the attribute happens to be right
    // again — it was written there. That is the "corrected by luck".
    assert.equal(el.dataset.date, el.closest('.day').dataset.date,
      'page 0 should be self-consistent again, by accident rather than by repair');
    assert.equal(wrong.length, 0,
      `${wrong.length} of ${seen.length} year pages drew the note with another year's date: `
      + JSON.stringify(seen));
  } finally { restore(); }
});

// ═════════════════════════════════════════════════════════════════════════════════
// §D2 · WHAT IT COSTS — `.note[data-date]` IS A GESTURE INPUT, NOT DECORATION
//
// `interact.js:371`   fromDate: noteNode.dataset.date
// `interact.js:469`   drag = { kind:'move-note', …, fromDate: p.fromDate, target: p.fromDate }
// `interact.js:567`   if (drag.target && drag.target !== drag.fromDate) → commitEntry('moveNote')
//
// `drag.target` comes from `dateUnderPointer`, which reads the DAY ROW and is therefore
// right. `drag.fromDate` comes from the NOTE and, after a year page turn, is a year out.
// So "picked the note up and put it back down on the same day" reads as a MOVE:
// `commitEntry(…, 'moveNote', …, { 'pub.date': moved })` — an op in the log, a step on
// the undo stack, and on a shared entry a `pub.date` published to the whole circle for
// a day nothing happened on. P10: the board is not a messenger.
//
// This row does not drive the pointer (that needs a synthesized drag with real
// hit-testing); it asserts the PRECONDITION those three lines rely on, which is the
// same defect stated where it is checkable.
// ═════════════════════════════════════════════════════════════════════════════════

test('§D2 · after a year page turn, a repeating note’s drag origin is a year out', () => {
  try {
    const n = own('rep1', '2020-06-24', 'Zahnarzt Lena', { repeatsYearly: true });
    install([n], []);
    S().pageYears = 1;
    renderBoard(boardEl());

    const el = $('#board .note[data-note-id="rep1"]');
    const fromDate = el.dataset.date;                       // interact.js:371
    const target = el.closest('.day').dataset.date;         // dateUnderPointer, interact.js:688
    diag(`  fromDate=${fromDate}  target=${target}  → interact.js:567 would commit a move: `
      + `${String(target !== fromDate)}`);
    assert.equal(target, fromDate,
      'a press-and-release on the note itself is read as a move to another day, because the '
      + 'element and the row it is in disagree about which day it is');
  } finally { restore(); }
});

// ═════════════════════════════════════════════════════════════════════════════════
// §D3 · THE SCRATCHPAD — A CHANGE SOMEBODY ELSE MADE DISCARDS HER SENTENCE
//
// `board.js:patchPad` reconciles the `<textarea>`'s `value` PROPERTY on every render:
//
//     if (rec.padTa.value !== col.pad) rec.padTa.value = col.pad;
//
// and `e1-incremental.dom.js` §I4 pins that as correct, on the grounds that "a full
// rebuild reset it; so does this one".
//
// That equivalence is true and the CONSEQUENCE is not the same, because v2 added a
// caller v1 did not have. `interact.js:908` commits a pad after a 600 ms pause (rule
// U9). `main.js:88` subscribes to the store and redraws for every reason except `pad`
// and `select` — and `store.js:4662`/`:4893` emit `'remote'` when a peer's ops fold in.
//
// In v1 every redraw was caused by a gesture of the user's own, and every one of those
// gestures moves focus out of the textarea first, so `focusout` → `onPadBlur` →
// `commitPad` had already saved the text. `'remote'` needs no gesture and no focus
// change. So: she is typing in the December pad, Mama's entry arrives, and up to
// 600 ms of her own writing is gone — not undoable, because it was never committed.
//
// P3: the user's own ink wins. This row is the ink losing to somebody else's.
// ═════════════════════════════════════════════════════════════════════════════════

test('§D3 · a peer’s op arriving mid-sentence discards uncommitted scratchpad typing', () => {
  try {
    install([], []);
    const ta = $('#board .pad[data-month="2026-01"] textarea');
    ta.focus();
    // `interact.js:onPadInput` writes the element and starts a 600 ms timer. This is
    // the state the board is in for those 600 ms.
    const typed = 'Zahnarzt Lena Di 15 Uhr\nSchulranzen kaufen\nOma anrufen';
    ta.value = typed;
    diag(`  typed ${typed.length} characters, still uncommitted; `
      + `store has ${JSON.stringify(store.state.scratchpads['2026-01'])}`);

    // A peer's op folds. `store.emit('remote')` → `main.js` redraw → renderBoard.
    // Nothing about the pad changed in the model.
    renderBoard(boardEl());

    const after = $('#board .pad[data-month="2026-01"] textarea');
    diag(`  after the redraw: same node=${after === ta}, still focused=`
      + `${document.activeElement === after}, value=${JSON.stringify(after.value)}`);
    assert.equal(after.value, typed,
      'a render the user did not cause discarded text she had typed and not yet committed');
  } finally { restore(); }
});

// ═════════════════════════════════════════════════════════════════════════════════
// §D4 · THE REDACTION BOUNDARY AT THE GLASS — GREEN
//
// ADR 004's boundary has held eight adversary rounds at the wire. This is the same
// question one layer later: when a downgrade, a hide or a removal arrives while the
// board is ON SCREEN and only the incremental path runs, does the text leave the DOM,
// or only the model?
//
// Every assertion here is over `#board.innerHTML`, which carries `title` attributes as
// well as text nodes — the two places `renderNote`/`buildLabel` can put content.
//
// SCOPE. This drives `store.state` directly, so it proves the RENDERER lets nothing
// through. Whether `store.state` itself is right after a fold is `materialize.js`'s
// `projectable()` gate, covered upstream (tier 1 `visibility.test.js`,
// `tests/attack/e7-leak-downgrade.test.js`, `tests/fleet/e6-attack-privat.test.js`).
// ═════════════════════════════════════════════════════════════════════════════════

test('§D4 · a downgrade, a hide and a removal that arrive incrementally take the text with them', () => {
  const NOTE_TEXT = 'Therapie Dr Wieland';
  const BAR_LABEL = 'Kur Bad Kissingen';
  try {
    const n = foreign('a1', '2026-02-10', MAMA, 'geteilt', NOTE_TEXT);
    const b = foreignBar('b1', '2026-02-14', '2026-02-20', MAMA, 'geteilt', BAR_LABEL);
    install([n], [b]);
    const has = (s) => boardEl().innerHTML.includes(s);
    assert.ok(has(NOTE_TEXT) && has(BAR_LABEL),
      'precondition: both are on the board at Geteilt, or this row proves nothing');

    // ── 1. Geteilt → Belegt, one incremental render, no rebuild.
    n.level = 'belegt'; n.text = null;
    b.level = 'belegt'; b.label = null;
    renderBoard(boardEl());
    diag('  after Geteilt→Belegt: note node = '
      + $('#board .note').outerHTML.replace(/\s+/g, ' ').slice(0, 150));
    assert.ok(!has(NOTE_TEXT), 'the note text survived a Belegt downgrade in the DOM');
    assert.ok(!has(BAR_LABEL), 'the bar label survived a Belegt downgrade in the DOM');
    assert.equal($('#board .note .redacted-word').textContent, 'Belegt',
      'the block should say the neutral word and nothing else');

    // ── 2. the member is hidden (17.3), one incremental render.
    n.level = 'geteilt'; n.text = NOTE_TEXT;
    b.level = 'geteilt'; b.label = BAR_LABEL;
    renderBoard(boardEl());
    assert.ok(has(NOTE_TEXT), 'precondition: back at Geteilt');
    S().hiddenMembers = { [MAMA.id]: true };
    renderBoard(boardEl());
    diag(`  after 17.3 hide: notes=${$$('#board .note').length} bars=${$$('#board .bar').length} `
      + `labels=${$$('#board .bar-label').length} chips=${$$('#board .chip').length}`);
    assert.ok(!has(NOTE_TEXT) && !has(BAR_LABEL), 'hiding the member left her text in the DOM');
    assert.equal($$('#board .chip').length, 0, 'her initial chip outlived her entries');

    // ── 3. the member is removed — her entries leave the projection entirely.
    S().hiddenMembers = {};
    renderBoard(boardEl());
    assert.ok(has(NOTE_TEXT), 'precondition: unhidden again');
    store.state.notes = []; store.state.bars = [];
    renderBoard(boardEl());
    diag(`  after removal: notes=${$$('#board .note').length} bars=${$$('#board .bar').length} `
      + `labels=${$$('#board .bar-label').length}`);
    assert.ok(!has(NOTE_TEXT) && !has(BAR_LABEL), 'a removed member left text on the board');
    assert.equal($$('#board .note').length + $$('#board .bar').length
      + $$('#board .bar-label').length, 0, 'a removed member left nodes on the board');
  } finally { restore(); }
});

test('§D4b · eight incremental renders of a downgrade chain leave no withdrawn string behind', () => {
  const STRINGS = ['Therapie Dr Wieland', 'MRT Termin', 'Anwalt Kanzlei Reuss',
    'Kur Bad Kissingen', 'Reha Woche', 'Gericht Termin'];
  try {
    const notes = [
      foreign('c1', '2026-02-03', MAMA, 'geteilt', STRINGS[0]),
      foreign('c2', '2026-02-03', PAPA, 'geteilt', STRINGS[1]),
      foreign('c3', '2026-02-17', MAMA, 'geteilt', STRINGS[2]),
    ];
    const bars = [
      foreignBar('d1', '2026-02-05', '2026-02-09', MAMA, 'geteilt', STRINGS[3]),
      foreignBar('d2', '2026-02-11', '2026-02-16', PAPA, 'geteilt', STRINGS[4]),
      foreignBar('d3', '2026-02-20', '2026-02-25', MAMA, 'geteilt', STRINGS[5]),
    ];
    install(notes, bars);
    for (const s of STRINGS) {
      assert.ok(boardEl().innerHTML.includes(s), `precondition: ${s} is on the board`);
    }

    // Eight renders, no rebuild between them — the cache carries state forward.
    const steps = [
      () => { notes[0].level = 'belegt'; notes[0].text = null; },
      () => { bars[0].level = 'belegt'; bars[0].label = null; },
      () => { S().hiddenMembers = { [PAPA.id]: true }; },
      () => { notes[2].level = 'belegt'; notes[2].text = null; },
      () => { bars[2].level = 'belegt'; bars[2].label = null; },
      () => { S().hiddenMembers = {}; },
      () => { notes[1].level = 'belegt'; notes[1].text = null;
              bars[1].level = 'belegt'; bars[1].label = null; },
      () => { S().rowHeight = 40; },
    ];
    for (const step of steps) { step(); renderBoard(boardEl()); }

    const html = boardEl().innerHTML;
    const left = STRINGS.filter((s) => html.includes(s));
    diag(`  after 8 incremental renders: ${STRINGS.length - left.length}/${STRINGS.length} `
      + 'withdrawn strings are gone from the DOM');
    assert.deepEqual(left, [], `these withdrawn strings are still in the DOM: ${JSON.stringify(left)}`);

    const cmp = compare();
    if (!cmp.equal) diag('  ' + firstDiff(cmp.inc, cmp.full));
    assert.ok(cmp.equal, 'the chain left an incremental board a rebuild would not produce');
  } finally { restore(); }
});

// ═════════════════════════════════════════════════════════════════════════════════
// §D5 · THE „neu" TELL, WITHDRAWN — GREEN
//
// „a dot that persists after the thing it marked was withdrawn is a lie in the
// direction P9 forbids." `e1-incremental.dom.js` §I5 covers the „+n" badge's tell for
// an entry the row had no line for. This is the other two carriers: the dot on a DRAWN
// note (`renderNote` → `neuDot()`) and the dot on a BAR LABEL (`buildLabel` → `neuDot()`).
// ═════════════════════════════════════════════════════════════════════════════════

test('§D5 · a „neu" dot on a drawn note and on a bar label goes when the change is withdrawn', () => {
  try {
    const n = foreign('e1', '2026-04-07', MAMA, 'geteilt', 'Elternabend', { isNew: true });
    const b = foreignBar('e2', '2026-04-10', '2026-04-16', MAMA, 'geteilt', 'Urlaub', { isNew: true });
    install([n], [b]);
    diag(`  arrived: dots=${$$('#board .neu-dot').length} `
      + `(note=${$$('#board .note .neu-dot').length}, label=${$$('#board .bar-label .neu-dot').length})`);
    assert.equal($$('#board .note .neu-dot').length, 1, 'precondition: the note carries a dot');
    assert.equal($$('#board .bar-label .neu-dot').length, 1, 'precondition: the label carries a dot');

    n.isNew = false; b.isNew = false;
    renderBoard(boardEl());                                 // incremental only
    diag(`  withdrawn: dots=${$$('#board .neu-dot').length}`);
    assert.equal($$('#board .neu-dot').length, 0,
      'a „neu" dot outlived the change it marked on the incremental path');

    n.isNew = true; b.isNew = true;
    renderBoard(boardEl());
    assert.equal($$('#board .neu-dot').length, 2, 'and the tell can be given back');

    store.state.notes = []; store.state.bars = [];
    renderBoard(boardEl());
    assert.equal($$('#board .neu-dot').length, 0, 'a deleted entry left its dot behind');
  } finally { restore(); }
});

// ═════════════════════════════════════════════════════════════════════════════════
// §D6 · 17.5's THIRD SUPPRESSION — A PEER'S NEW BAR THAT LOST THE LANE LOTTERY
//
// „Jede Änderung ist bemerkbar." `board.js:applyMore`'s header names the two
// suppressions that are deliberate and documented — a DOWNGRADE never dots and a
// DELETION never dots (§7.2) — and says the badge is "the only mark left on that row"
// for everything else.
//
// There is a third, and it is not documented anywhere. `layout.js`:
//
//     const hiddenNew = hidden.filter((x) => x.foreign && x.isNew).length;   // NOTES only
//     const hiddenCount = hidden.length + laneOverflow[d];                   // notes AND bars
//
// `laneOverflow[d]` is 3.8's per-day lane cap: a bar segment that could not be placed
// in one of the three lanes. It is counted into the badge's DIGIT and never into
// `overflowNew`. So a peer's BRAND-NEW shared bar that lost the lottery is drawn
// nowhere, dotted nowhere, and the „+n" badge that swallowed it looks exactly like a
// badge hiding three unchanged things.
//
// This is `e8-density-crowding.dom.js` §B5's own finding — "noticeable nowhere" —
// closed for notes and left open for bars.
// ═════════════════════════════════════════════════════════════════════════════════

test('§D6 · a peer’s new shared bar dropped by the lane cap leaves no mark of any kind', () => {
  try {
    // Three of my own bars take lanes 0–2 across 8.–22. May (ownFirst, 17.2's rescue
    // pass 1). Mama's brand-new shared bar has nowhere to go.
    const mine = [
      ownBar('m1', '2026-05-08', '2026-05-22', 'Urlaub'),
      ownBar('m2', '2026-05-08', '2026-05-22', 'Projekt'),
      ownBar('m3', '2026-05-08', '2026-05-22', 'Kurs'),
    ];
    const hers = foreignBar('h1', '2026-05-10', '2026-05-20', MAMA, 'geteilt', 'Mamas Kur',
      { isNew: true });

    // Control: with only TWO of mine, hers is drawn and it carries the tell.
    install([], [mine[0], mine[1], hers]);
    const drawnDots = $$('#board .neu-dot').length;
    diag(`  lane free  → bars drawn=${$$('#board .rows[data-month="2026-05"] .bar').length}, `
      + `„neu" dots=${drawnDots}`);
    assert.equal(drawnDots, 1, 'precondition: when it fits, the change is marked');

    // The finding: one more bar of mine, and hers is dropped.
    install([], [...mine, hers]);
    const day = $('#board .day[data-date="2026-05-12"]');
    const more = $('.d-more', day);
    diag(`  lane taken → bars drawn=${$$('#board .rows[data-month="2026-05"] .bar').length}, `
      + `„neu" dots on the whole board=${$$('#board .neu-dot').length}`);
    diag(`  the day’s only mark: ${more ? `class="${more.className}" text="${more.textContent}" `
      + `title="${more.title}"` : '(no badge at all)'}`);
    diag(`  model: overflow=${currentModel().cols[4].days[11].overflow} `
      + `overflowNew=${currentModel().cols[4].days[11].overflowNew} `
      + `laneOverflow=${currentModel().cols[4].days[11].laneOverflow}`);

    assert.ok(more, 'precondition: the day carries a „+n" badge');
    assert.ok(/has-new/.test(more.className),
      'a peer’s brand-new shared bar was folded into the „+n" badge and the badge does not say so '
      + `(class="${more.className}", title="${more.title}") — 17.5's „jede Änderung ist bemerkbar" `
      + 'holds for a hidden NOTE and not for a hidden BAR');
  } finally { restore(); }
});

// ═════════════════════════════════════════════════════════════════════════════════
// §D7 · 17.2's ORDER SURVIVES THE INCREMENTAL PATH — GREEN
//
// E8 guarantees the user loses NONE of her own notes. That is a `layout.js` property —
// `ownFirst`, `orderForCapacity`, the three-pass rescue — and the question here is
// whether the renderer can undo it: `patchBody` and `patchTail` both KEEP nodes and
// place them with a two-pointer reconcile, and a reconcile that drifts would put the
// right notes in the wrong order without changing a single one of them.
//
// So this walks a crowded day and a crowded month through a mutation chain with no
// rebuild, and asserts after every step that the DOM sequence IS the model sequence —
// `.note` by entry id, and `.bar`/`.bar-label` in the document order `find.js` walks.
// ═════════════════════════════════════════════════════════════════════════════════

test('§D7 · after every incremental step the DOM order is the model order', () => {
  try {
    const notes = [];
    for (let i = 0; i < 5; i++) notes.push(own(`o${i}`, '2026-07-14', `Meins ${i}`));
    for (let i = 0; i < 5; i++) {
      notes.push(foreign(`p${i}`, '2026-07-14', i % 2 ? MAMA : PAPA, 'geteilt', `Ihres ${i}`));
    }
    const bars = [];
    for (let i = 0; i < 3; i++) bars.push(ownBar(`ob${i}`, '2026-07-02', `2026-07-${20 + i}`, `Bar ${i}`));
    for (let i = 0; i < 3; i++) {
      bars.push(foreignBar(`fb${i}`, `2026-07-0${4 + i}`, '2026-07-25', MAMA, 'geteilt', `Ihrer ${i}`));
    }
    install(notes, bars, { rowHeight: 40 });

    const modelDay = () => currentModel().cols[6].days[13];
    const domNotes = () =>
      $$('#board .day[data-date="2026-07-14"] .note').map((n) => n.dataset.noteId);
    const domTail = () =>
      $$('#board .rows[data-month="2026-07"] .bar, #board .rows[data-month="2026-07"] .bar-label')
        .map((n) => `${n.className.split(' ')[0]}:${n.dataset.barId}`);
    const modelTail = () => currentModel().cols[6].segs
      .flatMap((s) => [`bar:${s.bar.id}`, `bar-label:${s.bar.id}`]);

    const steps = [
      ['rowHeight 26', () => { S().rowHeight = 26; }],
      ['hide Mama', () => { S().hiddenMembers = { [MAMA.id]: true }; }],
      ['reshape a foreign bar', () => { bars[3].endDate = '2026-07-12'; }],
      ['show Mama', () => { S().hiddenMembers = {}; }],
      ['rowHeight 40', () => { S().rowHeight = 40; }],
      ['downgrade two peers', () => {
        notes[6].level = 'belegt'; notes[6].text = null;
        notes[8].level = 'belegt'; notes[8].text = null;
      }],
      ['recolour a category', () => { store.state.categories[0].paletteRef = 'rot'; }],
      ['drop one of mine', () => { notes.splice(2, 1); store.state.notes = notes; }],
    ];

    let checked = 0;
    for (const [label, step] of steps) {
      step();
      renderBoard(boardEl());                         // incremental only
      const wantNotes = modelDay().notes.map((x) => x.note.id);
      assert.deepEqual(domNotes(), wantNotes, `${label}: the day's notes are out of model order`);
      assert.deepEqual(domTail(), modelTail(), `${label}: the month's tail is out of model order`);
      checked += 2;
    }
    diag(`  ${checked} order assertions over ${steps.length} incremental steps; `
      + `the day ended with ${domNotes().length} drawn notes and `
      + `${currentModel().cols[6].days[13].overflow} folded`);

    const cmp = compare();
    if (!cmp.equal) diag('  ' + firstDiff(cmp.inc, cmp.full));
    assert.ok(cmp.equal, 'the chain left an incremental board a rebuild would not produce');
  } finally { restore(); }
});

// ═════════════════════════════════════════════════════════════════════════════════
// §D8 · MY OWN EXPOSURE BADGE, WITHDRAWN — GREEN
//
// 16.6's badge is MY disclosure of MY entry, and unsharing must take it off the entry
// that stays. `noteSig` carries `exposure.level` and its `pending` bit, so the node is
// rebuilt — but a badge that outlived the disclosure would be the same class of lie as
// a „neu" dot that outlived its change, in the direction P9 forbids, about ME.
// ═════════════════════════════════════════════════════════════════════════════════

test('§D8 · unsharing my own entry takes its exposure badge and its hover with it', () => {
  try {
    const n = own('x1', '2026-08-05', 'Konferenz Berlin',
      { exposure: { level: 'geteilt', pending: false } });
    install([n], []);
    const el = () => $('#board .note[data-note-id="x1"]');
    diag(`  shared : badge=${!!$('.exp', el())} title=${JSON.stringify(el().title)}`);
    assert.equal($$('.exp.geteilt', el()).length, 1, 'precondition: the badge is there');

    n.exposure = { level: 'geteilt', pending: true };
    renderBoard(boardEl());
    assert.equal($$('.exp.geteilt.pending', el()).length, 1, 'a pending share is hatched, not hollow');

    n.exposure = { level: 'belegt', pending: false };
    renderBoard(boardEl());
    assert.equal($$('.exp.belegt', el()).length, 1, 'the badge follows the level down');
    assert.equal($$('.exp.geteilt', el()).length, 0, 'and the old level does not stay beside it');

    n.exposure = null;                                    // back to Privat
    renderBoard(boardEl());
    diag(`  private: badge=${!!$('.exp', el())} title=${JSON.stringify(el().title)}`);
    assert.equal($$('.exp', el()).length, 0, 'the exposure badge outlived the disclosure');
    assert.equal(el().title, 'Konferenz Berlin',
      'the owner hover still claims a disclosure that has been withdrawn');
  } finally { restore(); }
});

// ═════════════════════════════════════════════════════════════════════════════════
// §D9 · WHY §D1 IS NOT ONE OF e1's 89 CELLS — A MEASUREMENT, NOT AN OPINION
//
// `e1-incremental.dom.js` DOES have a window mutation, and it does reach `pageYears`:
//
//     function rollWindow() {
//       if (rnd() < 0.5) { S().mode = 'rolling'; S().pageYears = 0; return …; }
//       S().mode = 'pinned';
//       S().startMonth = `${COL.y + ((rnd()*2)|0)}-${String(1+((rnd()*12)|0)).padStart(2,'0')}`;
//       S().pageYears = (rnd()*3)|0;
//     }
//
// §D1 needs two CONSECUTIVE pinned windows that share a MONTH and differ in YEAR — the
// only transition on which a yearly repeat lands on the same column and the same row
// twice. This replays that draw with e1's own PRNG (`seed*1103515245+12345 & 0x7fffffff`)
// and counts how often the transition comes up.
//
// The point is not that the odds are long. It is that e1's seed is FIXED
// (`let seed = 20260903;`) and it draws `rollWindow` a handful of times, so its 89 cells
// are one fixed sample of this space — and a property that holds for 89 sampled points
// is not the same thing as an invariant.
// ═════════════════════════════════════════════════════════════════════════════════

test('§D9 · e1’s window mutation reaches the same-month-different-year transition rarely', () => {
  let seed = 20260903;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const Y = 2026;
  const draw = () => {
    if (rnd() < 0.5) return null;                             // rolling
    const y = Y + ((rnd() * 2) | 0);
    const m = 1 + ((rnd() * 12) | 0);
    const p = (rnd() * 3) | 0;
    return { m, y: y + p };                                   // the EFFECTIVE window start
  };

  const N = 20000;
  let prev = null, pairs = 0, hits = 0;
  for (let i = 0; i < N; i++) {
    const cur = draw();
    if (prev && cur) {
      pairs++;
      if (prev.m === cur.m && prev.y !== cur.y) hits++;
    }
    prev = cur;
  }
  const pct = (100 * hits / pairs).toFixed(2);
  diag(`  ${N} draws → ${pairs} consecutive pinned pairs, ${hits} of them same-month/different-year `
    + `(${pct} %)`);
  diag('  e1 draws rollWindow twice in §I1 (two passes over 25 kinds, shuffled) plus whatever the');
  diag('  16-step random tail adds, and ~3 times across §I2 — at ONE fixed seed, 20260903.');
  assert.ok(hits > 0, 'the transition is reachable at all — it is a sampling gap, not an impossibility');
  assert.ok(hits / pairs < 0.15,
    `the transition is rare enough that a fixed-seed walk can miss it: ${pct} % of pairs`);
});
