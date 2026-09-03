// TIER 2 · AUDIT — PASS 3, THE TWO THINGS THAT RE-READ THE BOARD
//
// „print (12.2, F12) and the redacted feedback PNG — both read the board; does either
// read the CACHED board?"
//
// The answer is yes, both of them, and this file measures what that costs.
//
//   · `feedback/redact.js:renderRedactedBoard(root)` is called from
//     `feedback/ui.js:113` with `boardEl()` — the live board element, which is
//     whatever `board.js`'s incremental path last left standing. There is no second
//     render and no snapshot; `geometry.js:collectPrimitives` walks THAT DOM.
//   · `print.js:buildPrintFurniture` is registered on `beforeprint` and called by
//     `printBoard()`. It builds the head and the legend from `currentModel()` and
//     leaves the BOARD itself alone: `print.css` re-metrics the identical DOM (F12),
//     so the sheet is a photograph of the cached board too.
//
// So both artefacts inherit whatever the incremental path gets wrong. The rows below
// are the two halves of that: does the ONE divergence this pass found (§D1 in
// `display-integrity.dom.js` — a repeating note keeping last year's `data-date` after
// the „›" year pager) reach either artefact, and is `currentModel()` itself ever stale?
//
// Both come out GREEN, and both were worth asking. A negative nobody can re-run is not
// a negative.
//
// Plain script: globals are test, assert, $, $$, waitFor, sleep, importApp, diag, skip.
// ─────────────────────────────────────────────────────────────────────────────────

const { store } = await importApp('store.js');
const { renderBoard, invalidateBoardCache, currentModel } = await importApp('board.js');
const { renderRedactedBoard } = await importApp('feedback/redact.js');
const { collectPrimitives, assertNumericOnly, ROLES } = await importApp('feedback/geometry.js');

const boardEl = () => $('#board');
const S = () => store.state.settings;

const BASE_SETTINGS = JSON.parse(JSON.stringify(store.state.settings));
const BASE_NOTES = store.state.notes;
const BASE_BARS = store.state.bars;

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
const MAMA = { id: 'mem_mama', colorRef: 'magenta', initial: 'M' };

function install(notes, bars, extra = {}) {
  store.state.notes = notes;
  store.state.bars = bars;
  store.state.scratchpads = {};
  Object.assign(S(), {
    mode: 'pinned', startMonth: '2026-01', pageYears: 0,
    rowHeight: 22, colWidth: 118, density: 'kompakt',
    hiddenMembers: {}, bundesland: 'BY', language: 'de',
    layers: { feiertage: true, schulferien: false, otherStates: false },
    ...extra,
  });
  invalidateBoardCache();
  renderBoard(boardEl());
}
function restore() {
  store.state.notes = BASE_NOTES;
  store.state.bars = BASE_BARS;
  store.state.settings = JSON.parse(JSON.stringify(BASE_SETTINGS));
  invalidateBoardCache();
  renderBoard(boardEl());
}
const hex = (u8) => Array.from(u8.slice(0, 24)).map((b) => b.toString(16).padStart(2, '0')).join('');
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ═════════════════════════════════════════════════════════════════════════════════
// §P1 · THE REDACTED PNG IS BUILT FROM THE CACHED BOARD — AND IT DOES NOT CARE
//
// The image is geometry: seven numbers and one token from a frozen enum, per rectangle.
// `data-date` is an attribute nobody paints — there is no `attr()` and no `content:`
// bound to it in `app.css` or `print.css` — so the one divergence §D1 found has no
// pixels. This row proves that by building the picture BOTH ways over the exact state
// §D1 leaves behind and comparing the bytes.
// ═════════════════════════════════════════════════════════════════════════════════

test('§P1 · the picture of the incremental board is byte-identical to the picture of a rebuilt one', () => {
  try {
    install([
      own('rep1', '2020-03-12', 'Omas Geburtstag', { repeatsYearly: true }),
      own('n1', '2026-03-04', 'Elternabend'),
      foreign('f1', '2026-03-04', MAMA, 'geteilt', 'Chorprobe'),
      foreign('f2', '2026-03-18', MAMA, 'belegt', null, { isNew: true }),
    ], []);

    // The §D1 state: one year forward, incremental path only.
    S().pageYears = 1;
    renderBoard(boardEl());
    const noteEl = $('#board .note[data-note-id="rep1"]');
    diag(`  precondition — the stale attribute is present: .note says ${noteEl.dataset.date}, `
      + `its row says ${noteEl.closest('.day').dataset.date}`);
    assert.notEqual(noteEl.dataset.date, noteEl.closest('.day').dataset.date,
      'precondition: this row only means something while §D1 is unrepaired');

    const a = renderRedactedBoard(boardEl());
    diag(`  incremental board → ${a.bytes.length} bytes, ${a.w}×${a.h}, scale ${a.scale}, `
      + `${a.counts.rects} rectangles (${a.counts.redactions} redactions)`);

    invalidateBoardCache();
    renderBoard(boardEl());
    const b = renderRedactedBoard(boardEl());
    diag(`  rebuilt board     → ${b.bytes.length} bytes, ${b.w}×${b.h}, scale ${b.scale}, `
      + `${b.counts.rects} rectangles (${b.counts.redactions} redactions)`);
    diag(`  first 24 bytes: ${hex(a.bytes)} / ${hex(b.bytes)}`);

    assert.deepEqual(a.counts, b.counts, 'the two boards produced different rectangle counts');
    assert.ok(same(a.bytes, b.bytes),
      `the redacted PNG differs between the incremental and the rebuilt board `
      + `(${a.bytes.length} vs ${b.bytes.length} bytes)`);
  } finally { restore(); }
});

test('§P1b · nothing but numbers and a role leaves the board, on the cached board too', () => {
  try {
    install([
      own('n1', '2026-03-04', 'Elternabend'),
      foreign('f1', '2026-03-04', MAMA, 'geteilt', 'Chorprobe bei Frau Kessler'),
      foreign('f2', '2026-03-18', MAMA, 'belegt', null),
    ], []);
    store.state.scratchpads['2026-03'] = 'Steuerunterlagen sortieren';
    // Reach the state through the incremental path, never a rebuild.
    S().rowHeight = 32; renderBoard(boardEl());
    S().hiddenMembers = { [MAMA.id]: true }; renderBoard(boardEl());
    S().hiddenMembers = {}; renderBoard(boardEl());

    const { prims } = collectPrimitives(boardEl());
    assertNumericOnly(prims);                     // the guard that also runs in production
    const roleSet = new Set(ROLES);
    let strings = 0, badRole = 0, values = 0;
    for (const p of prims) {
      for (const [k, v] of Object.entries(p)) {
        values++;
        if (k === 'role') { if (!roleSet.has(v)) badRole++; continue; }
        if (typeof v === 'string') strings++;
      }
    }
    diag(`  ${prims.length} primitives, ${values} values, ${strings} strings outside \`role\`, `
      + `${badRole} roles outside the frozen enum`);
    // The board's own strings, checked against the emitted list rather than assumed.
    const flat = JSON.stringify(prims);
    for (const s of ['Elternabend', 'Chorprobe', 'Kessler', 'Steuerunterlagen', 'Belegt', 'M']) {
      assert.ok(!flat.includes(s), `the primitive list carries the board string ${JSON.stringify(s)}`);
    }
    assert.equal(strings, 0, 'a primitive carried a string that is not its role');
    assert.equal(badRole, 0, 'a primitive carried a role outside the frozen enum');
  } finally { restore(); }
});

// ═════════════════════════════════════════════════════════════════════════════════
// §P2 · PRINT READS `currentModel()`, AND `currentModel()` CANNOT BE STALE
//
// `board.js:renderBoard` reassigns the module-level `model` from `buildBoard(state)` on
// EVERY call, BEFORE it decides whether to patch or rebuild:
//
//     export function renderBoard(root) {
//       const state = store.state;
//       model = buildBoard(state);          ◀── unconditional
//       …
//       if (canPatch(root, epoch)) { … return model; }
//
// So the incremental path saves DOM work, never model work, and every reader of
// `currentModel()` — `print.js:76`, `find.js:298`, `interact.js:644`/`:694` — is looking
// at the board that was just computed. This row measures that through the real
// `beforeprint` handler `main.js:78` installed: the sheet's head and its legend follow a
// board reached only incrementally.
// ═════════════════════════════════════════════════════════════════════════════════

test('§P2 · the print head and legend follow a board reached only incrementally', () => {
  try {
    install([own('n1', '2026-03-04', 'Elternabend')], []);
    const head = () => $('#print-head').textContent.replace(/\s+/g, ' ').trim();
    const legend = () => $$('#print-legend .item .nm').map((n) => n.textContent);

    window.dispatchEvent(new Event('beforeprint'));
    const h0 = head();
    const l0 = legend();
    diag(`  page 0 head   : ${JSON.stringify(h0)}`);
    diag(`  page 0 legend : ${JSON.stringify(l0)}`);
    assert.includes(h0, 'Januar 2026', 'precondition: the sheet names the window it is printing');

    // Three changes, all through the incremental path, none of them a rebuild.
    S().pageYears = 2;
    renderBoard(boardEl());
    window.dispatchEvent(new Event('beforeprint'));
    const h1 = head();
    diag(`  page +2y head : ${JSON.stringify(h1)}`);
    assert.includes(h1, 'Januar 2028',
      'the printed head named a window the board is no longer showing');
    assert.equal(currentModel().cols[0].fullLabel, 'Januar 2028',
      'currentModel() is behind the board an incremental render just drew');

    // 12.3 — what you see is what prints. A hidden category leaves the sheet's key.
    store.state.categories[0].visible = false;
    renderBoard(boardEl());
    window.dispatchEvent(new Event('beforeprint'));
    const l1 = legend();
    diag(`  after hiding ${JSON.stringify(l0[0])}: legend = ${JSON.stringify(l1)}`);
    assert.equal(l1.length, l0.length - 1,
      'a category hidden on the incremental path still printed its key');
    assert.ok(!l1.includes(l0[0]), `the hidden category ${JSON.stringify(l0[0])} is still on the sheet`);
  } finally {
    store.state.categories[0].visible = true;
    restore();
  }
});

// ═════════════════════════════════════════════════════════════════════════════════
// §P3 · AND THE SHEET IS THE CACHED BOARD, WHICH IS THE REAL EXPOSURE
//
// `print.css` re-metrics the identical DOM. So there is no third renderer between the
// incremental path and the paper: whatever the cache leaves standing is printed. That
// makes the identity claim of LZP-1007 the print correctness proof as well, and it is
// worth one row that says so out loud rather than leaving it as an inference.
//
// This asserts the property that makes §D1 harmless on paper — `data-date` is carried
// by no painted node — over the whole board rather than over the one attribute.
// ═════════════════════════════════════════════════════════════════════════════════

test('§P3 · the sheet is the live board, and no stylesheet paints an entry’s data-date', () => {
  try {
    install([
      own('rep1', '2020-03-12', 'Omas Geburtstag', { repeatsYearly: true }),
      own('n1', '2026-03-04', 'Elternabend'),
    ], []);
    S().pageYears = 1;
    renderBoard(boardEl());                       // §D1's state, incremental only

    const noteEl = $('#board .note[data-note-id="rep1"]');
    assert.notEqual(noteEl.dataset.date, noteEl.closest('.day').dataset.date,
      'precondition: this row only means something while §D1 is unrepaired');

    // Nothing in the cascade turns the attribute into ink, in either metric.
    const before = getComputedStyle(noteEl, '::before').content;
    const after = getComputedStyle(noteEl, '::after').content;
    diag(`  .note::before content = ${before}, ::after = ${after}`);
    diag(`  the drawn text of the stale note is ${JSON.stringify(noteEl.textContent)}`);
    assert.ok(!String(before).includes('2026') && !String(after).includes('2026'),
      'a pseudo-element paints the stale date');
    assert.ok(!noteEl.textContent.includes('2026-03-12'),
      'the stale date reached the note’s own text');

    // And the sheet's board IS this element — `print.js` never re-renders it.
    const printed = boardEl();
    assert.equal(printed, $('#board'), 'print prints the same element the cache owns');
    assert.ok($('#print-head') && $('#print-legend'),
      'the only nodes print builds of its own are the head and the legend');
  } finally { restore(); }
});
