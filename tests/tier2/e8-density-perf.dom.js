// TIER 2 · E8 DENSITY ADVERSARY — §E · THE FRAME-RATE FLOOR, AND THE PAPER
//
// LZP-1007's 60 fps AC (16.7 ms per frame) · A8 („print renders what's visible —
// including family entries") · 12.3 · F12 („the same board, minus interactivity,
// at A4/A3 — LEGIBLE, and looking intentional") · 17.4.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT `family-density.dom.js` §5 MEASURED, AND WHAT IT LEFT
// ─────────────────────────────────────────────────────────────────────────────
//
// It measures DRAG, on three gestures, and finds 0/200 frames over budget. That
// is real and it holds. But a drag is the cheapest thing the board does per
// frame: it moves one absolutely-positioned preview. The operations that rebuild
// the board — the member toggle 17.3 puts one click away, a find keystroke A6
// widened to the whole family, a horizontal scroll across twelve columns, and
// the print path — were not timed, and E8-VERIFICATION names two of them as
// „unmeasured and named".
//
// This file times them, on the same 8 × 2 fixture, against the same 16.7 ms
// frame, and says which one is the floor.
//
// A wall-clock fps is deliberately NOT claimed: a tier-2 run has no visible
// window, so rAF is suspended and any fps printed here would be a fact about the
// harness. What is measured is MAIN-THREAD WORK, which is the half of the budget
// the product controls. WebKit clamps `performance.now()` to ~1 ms, so every
// figure below is the mean of a repeated batch rather than a single reading.
//
// Plain script: globals are test, assert, $, $$, waitFor, sleep, importApp,
// diag, skip.
// ─────────────────────────────────────────────────────────────────────────────

const { store } = await importApp('store.js');
const { renderBoard } = await importApp('board.js');
const L = await importApp('layout.js');
const P = await importApp('print.js');
const { renderLegend } = await importApp('legend.js');

const boardEl = () => $('#board');
const px = (n) => Math.round(n * 10) / 10;
const FRAME = 16.7;

const MEMBERS = [
  { id: 'mem_mama', colorRef: 'magenta', initial: 'M' },
  { id: 'mem_papa', colorRef: 'gruen', initial: 'P' },
  { id: 'mem_lena', colorRef: 'gold', initial: 'L' },
  { id: 'mem_jonas', colorRef: 'tuerkis', initial: 'J' },
  { id: 'mem_tante', colorRef: 'violett', initial: 'T' },
  { id: 'mem_opa', colorRef: 'rot', initial: 'O' },
  { id: 'mem_oma', colorRef: 'marine', initial: 'A' },
];
const own = (id, date, text, x = {}) => ({
  id, uuid: id, date, text, categoryId: store.state.categories[0].id, repeatsYearly: false,
  isForeign: false, ownerId: 'mem_me', level: null, redacted: false, memberColorRef: null,
  initial: null, exposure: null, isNew: false, ...x,
});
const foreign = (id, date, level, x = {}) => {
  const who = x.who || MEMBERS[0];
  const { who: _w, ...rest } = x;
  return {
    id: `fnote:${who.id}/${id}`, uuid: id, date, text: null, repeatsYearly: false,
    isForeign: true, ownerId: who.id, level, memberColorRef: who.colorRef, initial: who.initial,
    exposure: null, isNew: false, coEdit: false, ...rest,
  };
};
const ownBar = (id, a, b, label, x = {}) => ({
  id, uuid: id, startDate: a, endDate: b, label, categoryId: store.state.categories[0].id,
  isForeign: false, ownerId: 'mem_me', level: null, memberColorRef: null, initial: null,
  exposure: null, isNew: false, ...x,
});
const foreignBar = (id, a, b, level, x = {}) => {
  const who = x.who || MEMBERS[0];
  const { who: _w, ...rest } = x;
  return {
    id: `fbar:${who.id}/${id}`, uuid: id, startDate: a, endDate: b, label: null, isForeign: true,
    ownerId: who.id, level, memberColorRef: who.colorRef, initial: who.initial, exposure: null,
    isNew: false, coEdit: false, ...rest,
  };
};

function verdict(label, rows) {
  const bad = rows.filter((r) => !r.ok);
  diag(`${label}: ${rows.length - bad.length}/${rows.length} cells hold`);
  for (const r of bad) diag('  x ' + r.id + ' — ' + r.why);
  assert.equal(bad.length, 0, bad.length ? label + ': ' + bad.map((r) => r.id).join(', ') : '');
}

const M0 = renderBoard(boardEl());
const COL = M0.cols[1];

function fixture8x2() {
  let seed = 20260901;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const TXT = ['Chorprobe', 'Zahnarzt', 'Elternabend', 'Yoga', 'Turnier', 'Ballett', 'Kur', 'Konferenz'];
  const LBL = ['Urlaub', 'Projekt', 'Kur', 'Dienstreise', 'Ferienlager'];
  const notes = []; const bars = [];
  const DAYS = 730;
  const day0 = new Date(Date.UTC(COL.y, COL.m - 1, 1) - 180 * 86400000);
  const at = (i) => new Date(day0.getTime() + i * 86400000).toISOString().slice(0, 10);
  const people = [{ id: 'mem_me', me: true }].concat(MEMBERS);
  for (const p of people) {
    for (let d = 0; d < DAYS; d++) {
      if (rnd() > 0.5) continue;
      const date = at(d);
      if (p.me) {
        notes.push(own('n' + notes.length, date, TXT[(rnd() * 8) | 0], {
          categoryId: store.state.categories[(rnd() * store.state.categories.length) | 0].id,
          repeatsYearly: rnd() < 0.04,
          exposure: rnd() < 0.3 ? { level: rnd() < 0.5 ? 'belegt' : 'geteilt', pending: rnd() < 0.2 } : null,
        }));
      } else {
        const shared = rnd() < 0.5;
        notes.push(foreign('n' + notes.length, date, shared ? 'geteilt' : 'belegt', {
          who: p, text: shared ? TXT[(rnd() * 8) | 0] : null, repeatsYearly: rnd() < 0.04, isNew: rnd() < 0.15,
        }));
      }
    }
    for (let i = 0; i < 52; i++) {
      const s = (rnd() * DAYS) | 0;
      const a = at(s); const b = at(Math.min(DAYS - 1, s + 2 + ((rnd() * 12) | 0)));
      if (p.me) bars.push(ownBar('b' + bars.length, a, b, LBL[(rnd() * 5) | 0]));
      else {
        const shared = rnd() < 0.5;
        bars.push(foreignBar('b' + bars.length, a, b, shared ? 'geteilt' : 'belegt', {
          who: p, label: shared ? LBL[(rnd() * 5) | 0] : null, isNew: rnd() < 0.15,
        }));
      }
    }
  }
  return { notes, bars };
}
const FX = fixture8x2();
const MINE_N = FX.notes.filter((n) => !n.isForeign);
const MINE_B = FX.bars.filter((b) => !b.isForeign);

function install({ notes, bars, settings = {} }) {
  Object.assign(store.state.settings, settings);
  store.state.notes = notes;
  store.state.bars = bars;
  renderBoard(boardEl());
}
function restore(before) {
  store.state.notes = before.notes; store.state.bars = before.bars;
  store.state.settings = before.settings; renderBoard(boardEl());
}
const snapshot = () => ({ notes: store.state.notes, bars: store.state.bars, settings: JSON.parse(JSON.stringify(store.state.settings)) });

const NO_LAYERS = { feiertage: false, schulferien: false, otherStates: false };
const SET = { rowHeight: 22, layers: NO_LAYERS, hiddenMembers: {}, colWidth: 118, bundesland: '' };

/** Mean ms per operation over `reps`, forcing a real style + layout flush each time. */
function timed(reps, fn) {
  for (let i = 0; i < 5; i++) fn(i);                     // warm-up
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) {
    fn(i);
    document.documentElement.getBoundingClientRect();
    void document.body.offsetHeight;
  }
  return px((performance.now() - t0) / reps);
}

// ═════════════════════════════════════════════════════════════════════════════
// §E1 · THE OPERATIONS THAT REBUILD THE BOARD
// ═════════════════════════════════════════════════════════════════════════════

test('§E1 · build, render, member toggle, scroll and find — against one 16.7 ms frame', () => {
  const before = snapshot();
  const results = {};
  try {
    for (const mode of ['solo', 'family']) {
      const fx = mode === 'solo' ? { notes: MINE_N, bars: MINE_B } : FX;
      install({ ...fx, settings: SET });
      const r = {};
      r.buildBoard = timed(20, () => L.buildBoard(store.state));
      r.renderBoard = timed(20, () => renderBoard(boardEl()));
      // 17.3 — the RENDER half of a member toggle. The projection half (the op,
      // the fold and `materialize`) is upstream of this file and is NOT included;
      // it is named as unmeasured rather than folded in silently.
      let flip = false;
      r.memberToggle = timed(10, () => {
        flip = !flip;
        store.state.settings.hiddenMembers = flip ? { [MEMBERS[1].id]: true } : {};
        renderBoard(boardEl());
        renderLegend();
      });
      store.state.settings.hiddenMembers = {};
      renderBoard(boardEl());
      // 1.4 — horizontal scroll across the twelve columns.
      const wrap = $('#board-wrap');
      r.scroll = timed(60, (i) => { wrap.scrollLeft = (i * 97) % Math.max(1, wrap.scrollWidth - wrap.clientWidth); });
      wrap.scrollLeft = 0;
      // 14.1 / A6 — a find keystroke over everything on the board, family included.
      const input = $('#find-input');
      if (input) {
        const q = 'Elternabend';
        r.findKeystroke = timed(8, (i) => {
          input.value = q.slice(0, 1 + (i % q.length));
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        // ONE `run()` per repetition, each with a one-letter query and therefore
        // the widest possible hit set. Cycling the letter is what makes each
        // repetition a fresh full search instead of a re-run of a cached one.
        const LETTERS = 'enarstlo';
        r.findWorst = timed(8, (i) => {
          input.value = LETTERS[i % LETTERS.length];
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      // What EVERY cell above pays before it does any work of its own: `timed`
      // forces a real style + layout flush of the whole document after each
      // repetition, and this is that flush with nothing to flush. Reported, not
      // subtracted — the flush is work the frame really does — so that a reader
      // can tell 3.9 ms of rendering from 3.9 ms of harness.
      r.flushFloor = timed(20, () => {});
      r.domNodes = $$('#board *').length;
      results[mode] = r;
    }
  } finally { restore(before); }

  const keys = ['buildBoard', 'renderBoard', 'memberToggle', 'scroll', 'findKeystroke', 'findWorst'];
  diag('   operation           solo (ms)   family (ms)   ×      frames of 16.7 ms');
  for (const k of keys) {
    const s = results.solo[k]; const f = results.family[k];
    if (s == null || f == null) continue;
    diag(`   ${k.padEnd(18)}${String(s).padStart(10)}${String(f).padStart(14)}`
      + `${String(s ? px(f / s) : '—').padStart(6)}      ${px(f / FRAME)}`);
  }
  diag(`   DOM nodes on the board: solo ${results.solo.domNodes} · family ${results.family.domNodes}`);
  diag(`   the harness's own floor — one forced style+layout flush, nothing changed: `
    + `solo ${results.solo.flushFloor} ms · family ${results.family.flushFloor} ms. Every cell above includes it.`);

  const over = keys.filter((k) => results.family[k] != null && results.family[k] > FRAME);
  const worst = keys.filter((k) => results.family[k] != null).sort((a, b) => results.family[b] - results.family[a])[0];
  diag(`   THE FLOOR: ${worst} at ${results.family[worst]} ms = ${px(results.family[worst] / FRAME)} frames of a 60 fps budget`);
  diag(`   over budget: ${over.length ? over.map((k) => `${k} ${results.family[k]} ms`).join(' · ') : 'none'}`);
  diag('   NOT INCLUDED, and named: the projection half of a member toggle (op → fold → materialize),');
  diag('   and raster/composite — a tier-2 run has no visible window, so neither is measurable here.');

  const rows = [];
  for (const k of keys) {
    if (results.family[k] == null) continue;
    rows.push({ id: `LZP-1007/${k}-inside-one-frame`, ok: results.family[k] <= FRAME,
      why: `${k} costs ${results.family[k]} ms of main-thread work — ${px(results.family[k] / FRAME)} frames of the 60 fps budget (solo: ${results.solo[k]} ms)` });
  }
  verdict('§E1 · the frame budget beyond the drag', rows);
});

// ═════════════════════════════════════════════════════════════════════════════
// §E1b · THE RENDER IS INCREMENTAL, AND THAT IS A STRUCTURAL FACT (LZP-1007)
//
// §E1 above is a stopwatch, and a stopwatch cannot say WHY a number moved: a
// faster machine, a warmer JIT and a genuinely different algorithm all read the
// same on it. These cells assert the thing the timings are a CONSEQUENCE of —
// that `renderBoard` no longer destroys the board — in terms no machine can
// fake, and they are what goes red if anyone puts `root.textContent = ''` back.
//
// WHAT LZP-1007 DID. `renderBoard` was `textContent = ''` plus a twelve-month
// rebuild of 4 195 boxes, every call. It is now a signature-gated patch: four
// slots per day row, a keyed reconcile for the notes inside a row and for the
// bar segments after it, and a full rebuild kept as the fallback for anything
// the cache cannot prove (see the header block in `board.js`). Measured in
// WebKit on this file's own 8 × 2 fixture, RUN ALONE so the numbers are not
// contention — two runs of the code this replaced, seven of what replaced it,
// on the same machine in the same sitting:
//
//                     before (2 runs)       after (7 runs)
//     renderBoard     60.8 · 54.1 ms        3.7 – 5.0 ms
//     memberToggle    58.2 · 62.4 ms       20.7 – 23.5 ms
//     scroll           2.5 ·  2.9 ms        2.4 –  3.9 ms
//     findKeystroke    8.9 · 11.6 ms        8.6 – 11.1 ms
//     buildBoard       2.7 ·  3.0 ms        4.8 –  6.6 ms
//
// The 46-file run reads higher for identical code — this file's own §E1 cells
// read 28.1 ms for the toggle inside `npm run test:dom` — and that number is
// contention, not the product. It is never the one to quote.
//
// `buildBoard` is `layout.js` and was not touched; it builds the same model. It
// is the first cell measured in each mode and `timed`'s warm-up does not flush,
// so it also carries the layout the fixture's own install left pending. The
// harness's own floor is printed above it and every cell includes it.
//
// WHAT IS STILL OVER BUDGET, AND WHY — the member toggle, at ~21 ms, is 1.3
// frames. It is not a rendering inefficiency left on the table. Hiding one
// member of eight changes 287 of the board's 372 day rows, 117 of its 708
// notes and 70 of its 268 bar-segment nodes, because the capacity rule
// re-slices every row that member had an entry on and the three-pass lane
// rescue hands the freed lanes to bars that were previously dropped. The cells
// below prove the renderer touches ONLY those; laying them out is ~13 ms of the
// ~21, on top of ~3.4 ms of model and ~3 ms of signatures and construction, and
// ~1.5 ms of the harness's own flush. Getting under one frame from here means
// changing what the board SHOWS, not how it is written, so this cell stays red
// and says so rather than being widened to fit.
//
// `findWorst` is `find.js`'s cell, not this one's, and it was already red before
// this ticket at 19.8 / 18.1 ms on the same two baseline runs.
//
// R-5 WENT AT IT AND CAME BACK WITH A NUMBER THAT IS NOT 16.7. This file run
// ALONE, seven times on an idle machine: **15.4 – 17.0 ms**, against 21.4 ms for
// the same file and fixture at 78016e8. Interleaved A/B on a BUSY machine, eight
// pairs, the two `find.js` versions alternating in one tree: 16.0 – 18.6 after,
// 18.9 – 63.8 before, and the after arm is lower in all eight. So: about one
// frame, median just either side of it, and the row is NOT closed — it goes
// green in most runs and red in some, which is what „1.0 frames" means and why
// it is reported as a range rather than as a pass. §E1c below says what changed
// and pins it. What is left is not code
// shape: 13 of those milliseconds are the browser recalculating style for the
// ~516 board nodes whose appearance genuinely changes when the hit set moves,
// at ~25 µs each, and the marking is already down to the difference between two
// hit sets. The next millisecond is in `app.css` — neutralising the three rules
// find writes (`.note.hit`'s border, `body.finding`'s `opacity: .3` dimming and
// `.bar.hit`'s box-shadow) TOGETHER takes the same measurement to 8.6 ms, while
// removing any ONE of them buys ~0.4 ms. That is a change to what find LOOKS
// like, in a file the tier-1 oracle pins, and it is not made here.
//
// The equality of the two paths — that the patched board IS the rebuilt board,
// node for node — is not asserted here but in `tests/tier2/e1-incremental.dom.js`,
// over 66 single mutations across 25 kinds and 10 chains of 8.
// ═════════════════════════════════════════════════════════════════════════════

/** Key every day row by column and row index, so void rows are addressable too. */
function dayIndex() {
  const m = new Map();
  for (const col of $$('#board .col')) {
    for (const d of $$('.day', col)) m.set(`${col.dataset.month}/${d.dataset.row}`, d);
  }
  return m;
}
/** Key every tail node by column, kind and bar id. */
function tailIndex() {
  const m = new Map();
  for (const col of $$('#board .col')) {
    for (const n of $$('.rows > .bar, .rows > .bar-label, .rows > .bar-cont-up, .rows > .bar-cont-down', col)) {
      m.set(`${col.dataset.month}/${n.className}/${n.dataset.barId}`, n);
    }
  }
  return m;
}
/** Key every note by column, row and entry id. */
function noteIndex() {
  const m = new Map();
  for (const col of $$('#board .col')) {
    for (const n of $$('.note', col)) m.set(`${col.dataset.month}/${n.dataset.date}/${n.dataset.noteId}`, n);
  }
  return m;
}

test('§E1b · an unchanged board is not rebuilt, and a changed one is not rebuilt either', () => {
  const before = snapshot();
  const rows = [];
  try {
    install({ ...FX, settings: SET });
    store.state.settings.hiddenMembers = {};
    renderBoard(boardEl());

    // ── b1 · nothing changed: every element on the board survives ────────────
    const all0 = $$('#board *');
    renderBoard(boardEl());
    const all1 = $$('#board *');
    let same = 0;
    for (let i = 0; i < Math.min(all0.length, all1.length); i++) if (all0[i] === all1[i]) same++;
    rows.push({ id: 'LZP-1007/idle-render-keeps-every-node', ok: same === all0.length && all0.length === all1.length,
      why: `a render with nothing changed kept ${same} of ${all0.length} elements (${all1.length} after) — a rebuild keeps 0` });

    // ── b2 · a member toggle: what did not change is not touched ─────────────
    const d0 = dayIndex(); const n0 = noteIndex(); const t0 = tailIndex();
    const dh0 = new Map([...d0].map(([k, v]) => [k, v.outerHTML]));
    const nh0 = new Map([...n0].map(([k, v]) => [k, v.outerHTML]));
    const th0 = new Map([...t0].map(([k, v]) => [k, v.outerHTML]));

    store.state.settings.hiddenMembers = { [MEMBERS[1].id]: true };
    renderBoard(boardEl());

    const d1 = dayIndex(); const n1 = noteIndex(); const t1 = tailIndex();
    const survivors = (i0, h0, i1) => {
      let unchanged = 0; let kept = 0; let lost = 0;
      for (const [k, html] of h0) {
        const now = i1.get(k);
        if (!now || now.outerHTML !== html) continue;
        unchanged++;
        if (now === i0.get(k)) kept++; else lost++;
      }
      return { unchanged, kept, lost };
    };
    const D = survivors(d0, dh0, d1);
    const N = survivors(n0, nh0, n1);
    const T = survivors(t0, th0, t1);

    diag(`   a member toggle: ${d1.size} day rows, ${D.unchanged} of them unchanged — ${D.kept} are the SAME element`);
    diag(`   a member toggle: ${n1.size} notes,    ${N.unchanged} of them unchanged — ${N.kept} are the SAME element`);
    diag(`   a member toggle: ${t1.size} bar nodes, ${T.unchanged} of them unchanged — ${T.kept} are the SAME element`);
    diag(`   so ${d1.size - D.unchanged} day rows, ${n1.size - N.unchanged} notes and ${t1.size - T.unchanged} bar nodes genuinely change,`);
    diag('   and the ~15 ms of layout they cost is what keeps the toggle above one frame.');

    rows.push({ id: 'LZP-1007/toggle-keeps-every-unchanged-day-row', ok: D.lost === 0 && D.unchanged > 0,
      why: `${D.lost} of ${D.unchanged} unchanged day rows were replaced by an identical new element` });
    rows.push({ id: 'LZP-1007/toggle-keeps-every-unchanged-note', ok: N.lost === 0 && N.unchanged > 0,
      why: `${N.lost} of ${N.unchanged} unchanged notes were replaced by an identical new element` });
    rows.push({ id: 'LZP-1007/toggle-keeps-every-unchanged-bar-node', ok: T.lost === 0 && T.unchanged > 0,
      why: `${T.lost} of ${T.unchanged} unchanged bar/label nodes were replaced by an identical new element` });

    // ── b3 · the idle render, on the clock ───────────────────────────────────
    store.state.settings.hiddenMembers = {};
    renderBoard(boardEl());
    const idle = timed(20, () => renderBoard(boardEl()));
    diag(`   a render with nothing changed: ${idle} ms — ${px(idle / FRAME)} frames`);
    rows.push({ id: 'LZP-1007/idle-render-inside-one-frame', ok: idle <= FRAME,
      why: `re-rendering an unchanged family board costs ${idle} ms` });
  } finally { restore(before); }
  verdict('§E1b · the render is incremental', rows);
});

// ═════════════════════════════════════════════════════════════════════════════
// §E1c · THE MARKING IS A DIFFERENCE, AND IT IS STILL EXACT (R-5)
//
// §E1's `findWorst` came down because `find.js#run` stopped clearing every
// `.hit` on the board and putting most of them straight back: it now brings the
// marked set to exactly the matching set and writes only the difference.
//
// A stopwatch cannot tell that apart from a search that has quietly stopped
// marking things. These cells can.
//
// The hazard a difference brings with it is `board.js#renderBoard`, which scrubs
// `hit` and `current` off the board on every render: an implementation that
// believed its own record of what is marked would put nothing back, and the
// hits would vanish on the next redraw. Two things stop that, and only one of
// them is testable from here. `applyMarks` adds the class only when the node is
// not already wearing it — a `contains` test, which is what makes the additions
// idempotent and therefore correct after a scrub; MEASURED: swapping the live
// collection for a cached Set does NOT break these cells, because that guard
// carries the case on its own. The live `getElementsByClassName` read is the
// belt to that pair of braces — it can also drop a mark this file never put on
// — and it is not what c3 proves. c3 proves the visible requirement: after a
// re-render the marks are back on exactly the matching nodes.
// ═════════════════════════════════════════════════════════════════════════════

const { refreshFind } = await importApp('find.js');

/** Type `q` into the find field the way a keystroke does. */
function type(q) {
  const input = $('#find-input');
  input.value = q;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
/** The notes whose own ink contains `q` — what `.hit` must be on, and on nothing else. */
const notesMatching = (q) => $$('#board .note').filter((n) => n.textContent.toLowerCase().includes(q.toLowerCase()));
const markedNotes = () => $$('#board .note.hit');
const sameSet = (a, b) => a.length === b.length && a.every((n) => b.includes(n));

test('§E1c · find marks the difference, and the difference is the whole matching set', () => {
  const before = snapshot();
  const rows = [];
  try {
    install({ ...FX, settings: SET });

    // ── c1 · a first query marks exactly what matches ────────────────────────
    type('Chorprobe');
    const want1 = notesMatching('Chorprobe');
    const got1 = markedNotes();
    diag(`   „Chorprobe": ${want1.length} notes carry the text, ${got1.length} carry .hit`);
    rows.push({ id: 'R-5/first-query-marks-exactly-the-matches', ok: want1.length > 0 && sameSet(got1, want1),
      why: `${got1.length} nodes marked, ${want1.length} match the text` });

    // ── c2 · the SECOND query is where a difference can lie ──────────────────
    // Every node that matched „Chorprobe" and does not match „Zahnarzt" has to
    // lose its mark, and every node that matches „Zahnarzt" has to gain one.
    // A clear-all/mark-all implementation passes this too — that is the point:
    // the difference must be indistinguishable from the whole.
    type('Zahnarzt');
    const want2 = notesMatching('Zahnarzt');
    const got2 = markedNotes();
    const stale = want1.filter((n) => n.classList.contains('hit') && !want2.includes(n));
    diag(`   „Zahnarzt": ${want2.length} match, ${got2.length} marked, ${stale.length} of the previous query's marks survived`);
    rows.push({ id: 'R-5/second-query-marks-exactly-the-matches', ok: want2.length > 0 && sameSet(got2, want2),
      why: `${got2.length} nodes marked, ${want2.length} match the text` });
    rows.push({ id: 'R-5/no-mark-outlives-its-query', ok: stale.length === 0,
      why: `${stale.length} node(s) still wear .hit from the previous query` });

    // ── c3 · a re-render scrubs the board; refreshFind must put them back ────
    // `main.js#redraw` is renderBoard → … → refreshFind, and renderBoard's
    // `scrubMarks` takes every `hit` and `current` off the board first. This is
    // the cell that goes red if the marked set is ever remembered instead of
    // read back from the DOM.
    renderBoard(boardEl());
    const scrubbed = markedNotes().length;
    refreshFind();
    const restored = markedNotes();
    const want3 = notesMatching('Zahnarzt');
    diag(`   after a re-render: ${scrubbed} marks on the bare board, ${restored.length} after refreshFind (${want3.length} match)`);
    rows.push({ id: 'R-5/a-render-scrubs-the-marks', ok: scrubbed === 0,
      why: `renderBoard left ${scrubbed} .hit nodes on the board — this cell's premise is gone` });
    rows.push({ id: 'R-5/refreshFind-restores-every-mark-after-a-render', ok: want3.length > 0 && sameSet(restored, want3),
      why: `${restored.length} of ${want3.length} matching notes carry .hit after a re-render` });

    // ── c4 · a query with no results leaves NOTHING behind ───────────────────
    // `.current` is the one that used to be cleared by the `clearMarks()` at the
    // top of every run. It is not any more, so the no-results path has to clear
    // it itself, and this is the cell that says so.
    type('Zahnarzt');
    const hadCurrent = $$('#board .current').length;
    type('xyzzykeintreffer');
    const leftHit = $$('#board .hit').length;
    const leftCurrent = $$('#board .current').length;
    diag(`   „keine Treffer": ${hadCurrent} .current before, ${leftHit} .hit and ${leftCurrent} .current after`);
    rows.push({ id: 'R-5/no-results-clears-every-hit', ok: leftHit === 0,
      why: `${leftHit} .hit node(s) survived a query that matches nothing` });
    rows.push({ id: 'R-5/no-results-clears-the-current-outline', ok: hadCurrent > 0 && leftCurrent === 0,
      why: `${leftCurrent} .current node(s) survived a query that matches nothing (${hadCurrent} before)` });

    // ── c5 · leaving find takes every mark with it ───────────────────────────
    type('Chorprobe');
    type('');
    const afterExit = $$('#board .hit, #board .current').length;
    rows.push({ id: 'R-5/an-empty-query-unmarks-the-board', ok: afterExit === 0,
      why: `${afterExit} mark(s) left on the board after the query was cleared` });
    rows.push({ id: 'R-5/an-empty-query-leaves-find-mode', ok: !document.body.classList.contains('finding'),
      why: 'body.finding survived an empty query' });

    // ── c6 · a bar's STRIPES light up with its label ─────────────────────────
    // The stripe index is the part of `run()` R-5 rewrote from a full-document
    // attribute selector to the live `.bar` collection filtered by the ids that
    // matched. A six-month bar wears one label per month but many stripes, and
    // all of them are supposed to light.
    type('Ferienlager');
    const litLabels = $$('#board .bar-label.hit');
    const litStripes = $$('#board .bar.hit');
    const litIds = new Set(litLabels.map((n) => n.dataset.barId));
    const wantStripes = $$('#board .bar[data-bar-id]').filter((b) => litIds.has(b.dataset.barId));
    diag(`   „Ferienlager": ${litLabels.length} labels lit over ${litIds.size} bar(s), `
      + `${litStripes.length} stripes lit of ${wantStripes.length} that belong to them`);
    rows.push({ id: 'R-5/a-hit-bar-lights-every-one-of-its-stripes', ok: wantStripes.length > 0 && sameSet(litStripes, wantStripes),
      why: `${litStripes.length} stripes carry .hit, ${wantStripes.length} belong to a matching bar` });

    // ── c7 · the off-window list is still the off-window list ────────────────
    // `offscreenHits` used to be `historyHits(q).filter(...)`: it scanned and
    // sorted the whole store and then discarded the on-screen half. The date
    // test is now first, which is only allowed if the list is byte-identical.
    // The fixture runs 180 days before the visible window, so „Chorprobe" has
    // matches on both sides of it.
    type('Chorprobe');
    const m = L.buildBoard(store.state);
    const listed = $$('#find-history .fh-row .fh-date').map((n) => n.textContent);
    const iso = (d) => `${d.slice(6, 10)}-${d.slice(3, 5)}-${d.slice(0, 2)}`;
    const inWindow = listed.filter((d) => iso(d) >= m.firstISO && iso(d) <= m.lastISO);
    const allOff = store.state.notes
      .filter((n) => typeof n.text === 'string' && n.text.toLowerCase().includes('chorprobe'))
      .filter((n) => n.date < m.firstISO || n.date > m.lastISO).length;
    // The list itself only ever draws 8 rows, and the fixture's off-window half
    // runs BEFORE the window — so eight ascending dates would look right even if
    // the filter were gone entirely. The „+n" cap is the row that counts: it is
    // the size of the whole list minus the eight that are drawn.
    const caps = $$('#find-history .fh-cap').map((n) => n.textContent);
    const plusN = Number((caps.find((c) => /^\+\d+$/.test(c)) || '').slice(1));
    diag(`   „Chorprobe": ${allOff} matching note(s) outside ${m.firstISO}..${m.lastISO}; `
      + `the list shows ${listed.length} row(s), ${inWindow.length} of them inside the window, and a „+${plusN}" cap`);
    rows.push({ id: 'R-5/the-off-window-list-holds-only-off-window-dates', ok: allOff > 0 && listed.length > 0 && inWindow.length === 0,
      why: `${inWindow.length} of ${listed.length} listed rows are inside the visible window` });
    rows.push({ id: 'R-5/the-off-window-list-counts-only-off-window-matches', ok: plusN === allOff - listed.length,
      why: `the list says +${plusN} beyond its ${listed.length} rows, so it holds ${plusN + listed.length} matches where ${allOff} are outside the window` });
    rows.push({ id: 'R-5/the-off-window-list-is-sorted', ok: listed.every((d, i) => i === 0 || iso(listed[i - 1]) <= iso(d)),
      why: `the listed dates are not ascending: ${listed.join(' ')}` });
  } finally {
    type('');
    restore(before);
  }
  verdict('§E1c · the marking is a difference, and it is exact', rows);
});

// ═════════════════════════════════════════════════════════════════════════════
// §E2 · THE PRINT PATH
// ═════════════════════════════════════════════════════════════════════════════

/** Lift the `@media print` rules out of their media block so they apply on screen. */
function withPrintRules(paper, fn) {
  const css = [];
  for (const sheetObj of document.styleSheets) {
    let rules; try { rules = sheetObj.cssRules; } catch { continue; }
    for (const r of rules) {
      if (!r.media || ![...r.media].includes('print')) continue;
      for (const inner of r.cssRules) css.push(inner.cssText);
    }
  }
  const style = document.createElement('style');
  style.textContent = css.join('\n');
  document.head.appendChild(style);
  const had = document.body.className;
  document.body.classList.add(`paper-${paper}`);
  void document.body.offsetHeight;
  try { return fn(css.length); } finally { style.remove(); document.body.className = had; void document.body.offsetHeight; }
}

/** Characters of `text` that fit in `avail` px at a given CSS font. See the truncation suite. */
const PROBE = document.createElement('span');
PROBE.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0';
document.body.appendChild(PROBE);
function fitChars(text, avail, font) {
  PROBE.style.font = font;
  let n = 0;
  for (let i = 1; i <= text.length; i++) {
    PROBE.textContent = text.slice(0, i);
    if (PROBE.getBoundingClientRect().width <= avail + 0.5) n = i; else break;
  }
  return n;
}

test('§E2 · A4 — what a family board actually puts on paper at ~6 pt', () => {
  const before = snapshot();
  try {
    P.initPrint();
    install({ ...FX, settings: SET });
    window.dispatchEvent(new Event('beforeprint'));

    const r = withPrintRules('a4', (ruleCount) => {
      const day = $$('#board .day[data-date]').find((d) => $$('.note', d).length >= 1);
      const col = $('#board .col');
      const note = $('.note', day);
      const body = $('.d-body', day);
      const more = $$('#board .d-more')[0];
      const lab = $$('#board .bar-label')[0];
      const cs = getComputedStyle(note);
      const kids = [...note.children];
      const startX = kids.length
        ? kids[kids.length - 1].getBoundingClientRect().right + parseFloat(getComputedStyle(kids[kids.length - 1]).marginRight || 0)
        : note.getBoundingClientRect().left;
      // A model built at settings.rowHeight = 22 has capacity 2; the A4 sheet
      // re-metrics the SAME DOM to a 20 px row. The two do not have to agree,
      // and this is where they meet.
      const rowH = px(day.getBoundingClientRect().height);
      return {
        rulesLifted: ruleCount,
        colW: px(col.getBoundingClientRect().width),
        rowH,
        modelCapacity: L.rowCapacity(store.state.settings.rowHeight || 22),
        paperCapacity: L.rowCapacity(rowH, 'a4'),   // the PAPER's own line box — see PAPER in layout.js
        notesInThisRow: $$('.note', day).length,
        bodyNeeds: px(body.scrollHeight),
        bodyHas: px(body.getBoundingClientRect().height),
        noteFontPx: cs.fontSize,
        textColumnPx: px(note.getBoundingClientRect().right - startX),
        chipPx: (() => { const c = $('.chip', note) || $('#board .note .chip'); return c ? px(c.getBoundingClientRect().width) : null; })(),
        expPx: (() => { const c = $('#board .note .exp'); return c ? px(c.getBoundingClientRect().width) : null; })(),
        neuPx: (() => { const c = $('#board .note .neu-dot'); return c ? px(c.getBoundingClientRect().width) : null; })(),
        morePx: more ? px(more.getBoundingClientRect().width) : null,
        moreFont: more ? getComputedStyle(more).fontSize : null,
        morePos: more ? getComputedStyle(more).position : null,
        // Does the printed badge overlap the printed sentence? Asked of the two
        // boxes rather than of the stylesheet, so it survives any re-metric.
        moreOverText: (() => {
          const d = $$('#board .day[data-date]').find((x) => $('.d-more', x) && $('.note', x));
          if (!d) return null;
          const mb = $('.d-more', d).getBoundingClientRect();
          const nb = $('.note', d).getBoundingClientRect();
          return px(Math.max(0, Math.min(mb.right, nb.right) - Math.max(mb.left, nb.left)));
        })(),
        labelMax: lab ? getComputedStyle(lab).maxWidth : null,
        labelFont: lab ? getComputedStyle(lab).fontSize : null,
        // Characters of a real German note that survive on paper, own vs peer.
        charsOwn: fitChars('Elternsprechtag Klasse 3b', px(note.getBoundingClientRect().right - startX), cs.font || `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`),
        charsPeer: (() => {
          const f = $$('#board .note.foreign').find((n) => [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()));
          if (!f) return null;
          const fk = [...f.children];
          const fs = getComputedStyle(f);
          const sx = fk.length ? fk[fk.length - 1].getBoundingClientRect().right + parseFloat(getComputedStyle(fk[fk.length - 1]).marginRight || 0) : f.getBoundingClientRect().left;
          return { marks: fk.map((c) => c.className), chars: fitChars('Elternsprechtag Klasse 3b', f.getBoundingClientRect().right - sx, fs.font || `${fs.fontWeight} ${fs.fontSize} ${fs.fontFamily}`), textPx: px(f.getBoundingClientRect().right - sx) };
        })(),
      };
    });

    diag(`A4 · ${r.rulesLifted} print rules lifted · column ${r.colW} px · row ${r.rowH} px · note type ${r.noteFontPx}`);
    diag(`   the MODEL was built at capacity ${r.modelCapacity} (settings.rowHeight ${store.state.settings.rowHeight || 22}); the PAPER's own row is capacity ${r.paperCapacity}`);
    diag('   — and „the paper\'s own" now means asked in the paper\'s own line box. Asked in Kompakt\'s,'
      + ` the same row answers ${L.rowCapacity(r.rowH)}, which is the disagreement this section used to report.`);
    diag(`   this row draws ${r.notesInThisRow} note(s); its body wants ${r.bodyNeeds} px and has ${r.bodyHas} px`);
    diag(`   the note's own text column on A4: ${r.textColumnPx} px`);
    diag(`   the badges do NOT scale with the paper (app.css: „Text scales, marks do not"):`
      + ` chip ${r.chipPx} px · exposure ${r.expPx} px · neu ${r.neuPx} px`);
    diag(`   the „+n" badge on A4: ${r.morePx} px at ${r.moreFont}, ${r.morePos} — it overlaps the note's own box by ${r.moreOverText} px`);
    diag(`   the bar label on A4: max-width ${r.labelMax} at ${r.labelFont}, and it still carries a chip and a dot`);
    diag(`   „Elternsprechtag Klasse 3b" on A4 — MY note: ${r.charsOwn} characters`
      + (r.charsPeer ? ` · A PEER'S note [${r.charsPeer.marks.join(' ')}]: ${r.charsPeer.chars} characters in ${r.charsPeer.textPx} px` : ''));

    // ── the row-height setting, carried onto paper ──────────────────────────
    // `buildBoard` takes its capacity from `settings.rowHeight`; `print.css`
    // re-metrics the SAME DOM to a 20 px A4 row. At the screen setting's maximum
    // the model puts three lines into a body that has room for two.
    const clip = {};
    for (const rh of [18, 22, 32]) {
      store.state.settings.rowHeight = rh;
      renderBoard(boardEl());
      clip[rh] = withPrintRules('a4', () => {
        let worst = 0; let worstShown = 0; let clipped = 0;
        for (const d of $$('#board .day[data-date]')) {
          const b = $('.d-body', d);
          if (!b) continue;
          const need = b.scrollHeight; const has = b.getBoundingClientRect().height;
          if (need > has + 0.5) { clipped++; if (need - has > worst) { worst = need - has; worstShown = $$('.note', d).length; } }
        }
        return { capacity: L.rowCapacity(rh), clipped, worstPx: px(worst), worstShown };
      });
      diag(`   screen rowHeight ${rh} (capacity ${clip[rh].capacity}) → on A4: ${clip[rh].clipped} day rows whose entries do not fit the 20 px paper row`
        + (clip[rh].worstPx ? ` · worst overflow ${clip[rh].worstPx} px in a row drawing ${clip[rh].worstShown} entries` : ''));
    }
    store.state.settings.rowHeight = 22;
    renderBoard(boardEl());

    // ── THE THIRD METRIC (LZP-806) ──────────────────────────────────────────
    // „The model sliced the day to 2 entries; the paper's own capacity is 1" was
    // not a print bug. It was `rowCapacity` answering a question about PAPER in
    // the units of GLASS: it took one argument and priced 9 px screen type into
    // a 6.5 pt sheet. `layout.js:PAPER` names the paper line boxes the way
    // `DENSITY` names the screen ones, and the two capacities can now be
    // asserted equal instead of hoped equal.
    //
    // The metrics are MEASURED here, under the real `@media print` rules, and
    // the published `lineH` has to be the smallest half-pixel above the line box
    // WebKit actually lays out — so a type change in `print.css` moves the box,
    // misses the window, and goes red rather than silently re-cutting the sheet.
    const paper = {};
    for (const size of L.PAPERS) {
      paper[size] = withPrintRules(size, () => {
        const day = $$('#board .day[data-date]').find((d) => $$('.note', d).length >= 1);
        const note = $('.note', day);
        return {
          rowH: px(day.getBoundingClientRect().height),
          lineBox: px(note.getBoundingClientRect().height),
          notePx: getComputedStyle(note).fontSize,
        };
      });
      const p = L.PAPER[size];
      const m = paper[size];
      diag(`   ${size.toUpperCase()} — print.css row ${m.rowH} px at ${m.notePx}; one line box measures ${m.lineBox} px`);
      diag(`      layout.js PAPER.${size}: rowHeight ${p.rowHeight} · lineH ${p.lineH} · typePt ${p.typePt}`
        + ` → rowCapacity(${m.rowH}, '${size}') = ${L.rowCapacity(m.rowH, size)}`);
    }

    const rows = [];
    for (const size of L.PAPERS) {
      const p = L.PAPER[size];
      const m = paper[size];
      rows.push({ id: `F12/${size}-metric-is-the-stylesheet's-own`, ok: p.rowHeight === m.rowH,
        why: `layout.js publishes PAPER.${size}.rowHeight ${p.rowHeight} and print.css draws a ${m.rowH} px row` });
      rows.push({ id: `F12/${size}-lineH-is-the-measured-line-box`, ok: p.lineH >= m.lineBox && p.lineH < m.lineBox + 1,
        why: `PAPER.${size}.lineH is ${p.lineH} and WebKit lays out a ${m.lineBox} px line box under print.css — `
          + 'the published metric no longer describes the type that is on the paper' });
    }
    rows.push({ id: 'F12/model-and-paper-agree-on-capacity', ok: r.modelCapacity === L.rowCapacity(paper.a4.rowH, 'a4'),
      why: `the model sliced the day to ${r.modelCapacity} entries for a 22 px screen row; A4 re-metrics the same DOM to a ${paper.a4.rowH} px row whose own capacity is ${L.rowCapacity(paper.a4.rowH, 'a4')}` });
    rows.push({ id: 'F12/a3-agrees-too', ok: r.modelCapacity === L.rowCapacity(paper.a3.rowH, 'a3'),
      why: `A3 — the recommended wall format — re-metrics the same DOM to a ${paper.a3.rowH} px row whose own capacity is ${L.rowCapacity(paper.a3.rowH, 'a3')}, against the model's ${r.modelCapacity}` });
    rows.push({ id: 'F12/the-screen-setting-does-not-clip-the-paper', ok: clip[32].clipped === 0,
      why: `at the screen's maximum row height (32 px, capacity 3) ${clip[32].clipped} day rows overflow the A4 row by up to ${clip[32].worstPx} px — clipped by \`.day { overflow: hidden }\`, on paper, with no „+n" to account for it` });
    // The one that decides whether a family poster is a poster.
    rows.push({ id: 'F12/the-paper-row-holds-what-the-model-drew', ok: r.bodyNeeds <= r.bodyHas + 0.5,
      why: `the A4 day row is ${r.bodyHas} px and the entries the model put in it need ${r.bodyNeeds} px — the surplus is clipped by \`.day { overflow: hidden }\`, on paper, with no „+n" to say so` });
    rows.push({ id: 'A8/a-peer-entry-is-legible-on-A4', ok: r.textColumnPx - (r.neuPx + r.chipPx + 4) > 20,
      why: `a peer's note on A4 has ${r.textColumnPx} px of text column, of which the fixed-size badges take `
        + `${px((r.neuPx || 0) + (r.chipPx || 0) + 4)} px — leaving ${px(r.textColumnPx - ((r.neuPx || 0) + (r.chipPx || 0) + 4))} px at ${r.noteFontPx}` });
    // ── THE COUNTERWEIGHTS ──────────────────────────────────────────────────
    // The row above was closed by taking the „+n" badge back OUT of the printed
    // line (`print.css`: `.day.claimed .d-more` stays an overlay on paper — the
    // retreat it pays for cannot happen there, because `body.paper-a4
    // .bar-label` out-specifies `.bar-label.on-ink`). These two rows are what
    // stops that from being re-spent: one says the badge is not in flow, the
    // other says it is not sitting on the sentence either. Without them the
    // A8 row could be met again by widening the column instead of by moving the
    // badge, and the defect would come back the next time a paper is re-metricked.
    rows.push({ id: 'A8/the-printed-badge-takes-no-width-from-the-sentence', ok: r.morePos === 'absolute',
      why: `the „+n" badge is \`position: ${r.morePos}\` on A4, so it is a flex sibling of \`.d-body\` and takes `
        + 'its box out of the note text — 20 px of a 39.5 px line, on the one surface with no hover to recover it' });
    rows.push({ id: 'A8/and-does-not-sit-on-it-either', ok: r.moreOverText === 0,
      why: `the „+n" badge overlaps the note's own box by ${r.moreOverText} px on A4 — v1 printed it at `
        + '`--gutter + 1px`, one pixel inside the text column; it belongs in the lane gutter the row already reserved' });

    verdict('§E2 · A4 parity', rows);
  } finally { restore(before); }
});

test('§E3 · how much of the family reaches the paper at all', () => {
  const before = snapshot();
  try {
    const count = (fx) => {
      install({ ...fx, settings: SET });
      const m = L.buildBoard(store.state);
      let inWindow = 0; let drawn = 0; let overflow = 0; let rows = 0;
      const byOwner = new Map();      // ownerId → [inWindow, drawn]
      for (const c of m.cols) for (const d of c.days) {
        if (d.empty) continue;
        rows += 1;
        inWindow += (d.allNotes || []).length;
        drawn += (d.notes || []).length;
        overflow += d.overflow || 0;
        for (const x of (d.allNotes || [])) {
          const k = x.note.ownerId || 'mem_me';
          if (!byOwner.has(k)) byOwner.set(k, [0, 0]);
          byOwner.get(k)[0] += 1;
        }
        for (const x of (d.notes || [])) {
          const k = x.note.ownerId || 'mem_me';
          if (!byOwner.has(k)) byOwner.set(k, [0, 0]);
          byOwner.get(k)[1] += 1;
        }
      }
      return { inWindow, drawn, overflow, rows, byOwner, badges: $$('#board .d-more').length };
    };
    const solo = count({ notes: MINE_N, bars: MINE_B });
    const family = count(FX);
    const ceiling = family.rows * L.rowCapacity(SET.rowHeight);
    diag(`   solo   — ${solo.inWindow} note occurrences in the 12-month window, ${solo.drawn} printed, ${solo.overflow} folded into ${solo.badges} „+n" badges`);
    diag(`   family — ${family.inWindow} note occurrences in the 12-month window, ${family.drawn} printed (${(family.drawn / family.inWindow * 100).toFixed(0)} %), ${family.overflow} folded into ${family.badges} „+n" badges`);
    diag('   Paper has no popover. Everything inside a „+n" on an A4 sheet is a NUMBER and nothing else —');
    diag('   which is DESIGN-DECISIONS\' own reason for printing the badge, and also the ceiling on what');
    diag('   „a family wall poster is now a two-click product" (A8) can mean at eight members.');

    // ── WHO reaches the paper, which is the half A8 is actually about ────────
    // 17.2 puts my own entries at the front of the capacity slice. The obvious
    // way to get that wrong is to buy it by making the family invisible — and
    // 17.1's whole point is that the family APPEARS. So the split is measured
    // per member, in both directions, and both ends are asserted.
    const shareOf = (k) => {
      const v = family.byOwner.get(k) || [0, 0];
      return { inWindow: v[0], drawn: v[1], pct: v[0] ? v[1] / v[0] : 1 };
    };
    const me = shareOf('mem_me');
    const peers = MEMBERS.map((p) => ({ id: p.id, ...shareOf(p.id) }));
    diag(`   WHO reaches the paper — mine ${me.drawn}/${me.inWindow} (${(me.pct * 100).toFixed(0)} %)`);
    for (const p of peers) diag(`      ${p.id.padEnd(10)} ${String(p.drawn).padStart(4)}/${String(p.inWindow).padStart(4)} (${(p.pct * 100).toFixed(0)} %)`);
    const quietest = peers.slice().sort((a, b) => a.pct - b.pct)[0];
    diag(`   the quietest member on the sheet is ${quietest.id} at ${(quietest.pct * 100).toFixed(0)} % — `
      + 'every one of them still has ink on the poster, which is what 17.1 asks for.');

    // ── THE ARITHMETIC CEILING, so the next reader does not re-derive it ─────
    // A 22 px row has capacity 2 (DESIGN-DECISIONS §B) and the window has 365
    // day rows, so at most 730 occurrences can be drawn at all — 48 % of this
    // fixture's 1 527. Capacity 3 is the clamp's own ceiling and reaches 72 %.
    // No reachable row height and no paper metric makes 75 % true here; closing
    // this cell needs a spec decision about what a saturated poster should do,
    // not a layout change. It is left RED, with the number, deliberately.
    diag(`   THE CEILING: ${family.rows} day rows × capacity ${L.rowCapacity(SET.rowHeight)} = ${ceiling} drawable `
      + `occurrences, against ${family.inWindow} in the window — ${(ceiling / family.inWindow * 100).toFixed(0)} % is `
      + `the most ANY ordering can print at this row height, and the model draws ${family.drawn} of those ${ceiling}.`);
    diag(`   At the clamp's own ceiling (capacity 3, DESIGN-DECISIONS §B) it would be `
      + `${(family.rows * 3 / family.inWindow * 100).toFixed(0)} % — still under the 75 % this cell asks for.`);

    verdict('§E3 · the poster', [
      // Not yet closable by layout: see THE CEILING above. Left at its original
      // strictness rather than re-cut to a number the product happens to hit.
      { id: 'A8/most-of-the-family-reaches-the-paper', ok: family.drawn / family.inWindow >= 0.75,
        why: `${(family.drawn / family.inWindow * 100).toFixed(0)} % of the entries in the printed window are drawn; the other ${(100 - family.drawn / family.inWindow * 100).toFixed(0)} % are a digit in a badge` },
      // …and the two properties that ARE the ownership rule's job, both ends.
      { id: '17.2/all-of-mine-reaches-the-paper', ok: me.pct === 1,
        why: `${me.inWindow - me.drawn} of my own ${me.inWindow} occurrences are a digit in a badge on my own poster` },
      { id: '17.1/no-member-is-erased-from-the-poster', ok: peers.every((p) => p.drawn > 0),
        why: `${peers.filter((p) => !p.drawn).map((p) => p.id).join(', ')} has no ink at all on the printed sheet — `
          + 'the ownership rule was bought by making the family invisible' },
      { id: '17.1/the-page-does-not-fill-with-one-page', ok: family.drawn - me.drawn > me.drawn,
        why: `of ${family.drawn} printed entries ${me.drawn} are mine and only ${family.drawn - me.drawn} are the other seven people's — `
          + 'a „family wall poster" that is mostly one person is not one' },
    ]);
  } finally { restore(before); }
});
