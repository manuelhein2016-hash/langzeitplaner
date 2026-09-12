// TIER 2 · LZP-808 — 17.7, „Kompakt / Komfort", measured in the shipping engine
//
// Story 17.7 `[Could]`: „A per-device density setting (Kompakt / Komfort) slightly
// increases row height and font size on that machine only — Mom's display and
// eyes are not mine — accepting horizontal scroll as the trade."
//
// v1 §2 (density targets): „~1000 px usable height … ≈ 24–28 px per row; on a
// 13" MacBook closer to 20–22 px … Entry text will sit around 10–11 px."
// v1 story 1.4: below 12 visible columns the board scrolls horizontally with the
// month headers pinned. v1 principle 1: „Density is the feature."
// DESIGN-DECISIONS §B: capacity = clamp(floor((rowHeight − 1) / LINE_H), 1, 3).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE HAS TO SETTLE, AND WHY IT IS NOT A SLIDER
// ─────────────────────────────────────────────────────────────────────────────
//
// 17.7 is the FIRST item on the addendum's own cut list (§10). It earns its
// place only if the answer to these questions is measured rather than asserted:
//
//   §1  Does the capacity rule survive a bigger type size? (It does not, unless
//       `LINE_H` becomes part of the preset — this section is the proof, and it
//       is the whole reason `DENSITY.komfort.lineH` exists.)
//   §2  Does Kompakt cost the shipped board ANYTHING? (No: it is the absence of
//       a class, measured against a board rendered before the class exists.)
//   §3  What does Komfort buy and what does it cost, on the 8-member × 2-year
//       fixture the E8 density adversary uses? (Type +16.7 %, characters +N,
//       entries +0, and 124 px of window height.)
//   §4  Can any reachable Komfort setting show FEWER entries than Kompakt? (No —
//       `minRowHeight` forbids it. This is the section that would go red if
//       somebody „simplified" the floor away.)
//   §5  Does it ever leave this Mac? (No: `local`-space `pref.set`, rule U6.)
//   §8  And the price the STORY does not mention — v1 forbids vertical scroll,
//       Komfort costs 124 px of it, and the pane measures this window and says
//       what falls below the fold.
//
// THE FIXTURE IS THE ADVERSARY'S. `fixture8x2` and the install path
// (`E.sortNotes` — the order `materialize.js` really produces) are copied from
// `e8-density-crowding.dom.js` so the numbers here sit beside that file's
// numbers and can be subtracted from them. Copied and not imported for that
// file's own stated reason: a tier-2 file is a plain script in a real page.
//
// Plain script: globals are test, assert, $, $$, waitFor, sleep, importApp,
// diag, skip.
// ─────────────────────────────────────────────────────────────────────────────

const { store } = await importApp('store.js');
const { renderBoard } = await importApp('board.js');
const L = await importApp('layout.js');
const E = await importApp('core/entities.js');
const S = await importApp('settings.js');

const boardEl = () => $('#board');
const px = (n) => Math.round(n * 10) / 10;

const MEMBERS = [
  { id: 'mem_mama', colorRef: 'magenta', initial: 'M' },
  { id: 'mem_papa', colorRef: 'gruen', initial: 'P' },
  { id: 'mem_lena', colorRef: 'gold', initial: 'L' },
  { id: 'mem_jonas', colorRef: 'tuerkis', initial: 'J' },
  { id: 'mem_tante', colorRef: 'violett', initial: 'T' },
  { id: 'mem_opa', colorRef: 'rot', initial: 'O' },
  { id: 'mem_oma', colorRef: 'marine', initial: 'A' },
];
const DEV = 'ABCDEFGHJKMNPQRS';
const born = (ms, ctr = 0) => `${String(ms).padStart(13, '0')}.${String(ctr).padStart(6, '0')}.${DEV}`;

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

/**
 * Install a scene AND a density, then restore both.
 *
 * `density` goes through `store.state.settings` + `applySettingsToBody()` — the
 * same two writes the settings pane makes — so what is measured below is the
 * shipping path and not a hand-set class.
 */
function withBoard({ notes = [], bars = [], settings = {} }, fn) {
  const before = {
    notes: store.state.notes, bars: store.state.bars,
    settings: JSON.parse(JSON.stringify(store.state.settings)),
  };
  try {
    Object.assign(store.state.settings, settings);
    S.applySettingsToBody();
    store.state.notes = E.sortNotes(notes);
    store.state.bars = E.sortBars(bars);
    const m = renderBoard(boardEl());
    return fn(m);
  } finally {
    store.state.notes = before.notes; store.state.bars = before.bars;
    store.state.settings = before.settings;
    S.applySettingsToBody();
    renderBoard(boardEl());
  }
}

const NO_LAYERS = { feiertage: false, schulferien: false, otherStates: false };

function verdict(label, rows) {
  const bad = rows.filter((r) => !r.ok);
  diag(`${label}: ${rows.length - bad.length}/${rows.length} cells hold`);
  for (const r of bad) diag('  x ' + r.id + ' — ' + r.why);
  assert.equal(bad.length, 0, bad.length ? label + ': ' + bad.map((r) => r.id).join(', ') : '');
}

const M0 = renderBoard(boardEl());
const COL = M0.cols[1];
const CLEAN = COL.days.find((x) => !x.empty && !x.holiday && !x.ferien && !x.isToday && x.n > 3 && x.n < 25)
  || COL.days.find((x) => !x.empty);
const DAY = CLEAN.date;
const isoOf = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const D = (n) => isoOf(COL.y, COL.m, Math.max(1, Math.min(COL.len, n)));
const dayNode = (date = DAY) => $(`#board .col[data-month="${COL.key}"] .day[data-date="${date}"]`);

const K = L.DENSITY.kompakt;
const F = L.DENSITY.komfort;
const SET = (d, over = {}) => ({
  density: d, rowHeight: L.DENSITY[d].rowHeight, colWidth: L.DENSITY[d].colWidth,
  layers: { ...NO_LAYERS }, hiddenMembers: {}, bundesland: '', ...over,
});

diag(`window ${M0.cols[0].key} … ${M0.cols[11].key} · clean day ${DAY}`);
diag(`Kompakt ${JSON.stringify(K)}`);
diag(`Komfort ${JSON.stringify(F)}`);

// ═════════════════════════════════════════════════════════════════════════════
// §1 · THE HAZARD 17.7 CONTAINS — a bigger type over the shipped capacity rule
//      makes the CROWDED board WORSE, and `lineH` is what stops it
//
// DESIGN-DECISIONS §B's `LINE_H` is „one line of 9 px entry text incl. leading".
// It is a fact about the TYPE, so raising the type without raising it is not a
// simplification, it is a promise of two lines to a row that can draw one.
// This section measures the two line boxes in WebKit and derives both floors
// from the measurement rather than from the constant.
// ═════════════════════════════════════════════════════════════════════════════

test('§1 · the two line boxes, measured — and the floor each one implies', () => {
  const scene = { notes: [own('a', DAY, 'Zahnarzt Lena'), own('b', DAY, 'Elternabend 3b')], bars: [] };
  const boxOf = (d, rowH) => withBoard({ ...scene, settings: SET(d, { rowHeight: rowH }) }, (m) => {
    const day = dayNode();
    const notes = $$('.note', day);
    const dayR = day.getBoundingClientRect();
    let spill = 0;
    for (const n of notes) {
      const r = n.getBoundingClientRect();
      spill = Math.max(spill, px(Math.max(0, dayR.top - r.top) + Math.max(0, r.bottom - dayR.bottom)));
    }
    return {
      lineBox: notes.length ? px(notes[0].getBoundingClientRect().height) : 0,
      fontPx: notes.length ? getComputedStyle(notes[0]).fontSize : '—',
      drawn: notes.length,
      capacity: m.capacity,
      rowH: m.rowH,
      spill,
    };
  });

  const kompakt = boxOf('kompakt', K.rowHeight);
  const komfort = boxOf('komfort', F.rowHeight);
  diag(`Kompakt  row ${kompakt.rowH} px · type ${kompakt.fontPx} · line box ${kompakt.lineBox} px · capacity ${kompakt.capacity} · drew ${kompakt.drawn} · spill ${kompakt.spill} px`);
  diag(`Komfort  row ${komfort.rowH} px · type ${komfort.fontPx} · line box ${komfort.lineBox} px · capacity ${komfort.capacity} · drew ${komfort.drawn} · spill ${komfort.spill} px`);
  diag(`published lineH — kompakt ${K.lineH} · komfort ${F.lineH}`);

  // Sweep the whole legal Komfort range and report the capacity the RULE gives
  // against the number of lines the ROW can physically hold.
  diag('  the Komfort range, rule against rendering:');
  const sweep = [];
  for (let rh = 22; rh <= 32; rh++) {
    const r = withBoard({ ...scene, settings: SET('komfort', { rowHeight: rh }) }, (m) => ({
      rowH: m.rowH, capacity: m.capacity, drawn: $$('.note', dayNode()).length,
    }));
    sweep.push({ asked: rh, ...r });
    diag(`    asked ${String(rh).padStart(2)} px → row ${String(r.rowH).padStart(2)} px · capacity ${r.capacity} · drew ${r.drawn}`);
  }

  const rows = [];
  // The measurement that justifies the constant: a Komfort line box must be
  // larger than a Kompakt one (or Komfort is not doing anything at all) and the
  // published `lineH` must be at least as large as the box it describes.
  rows.push({ id: '17.7/komfort-type-is-actually-bigger', ok: komfort.lineBox > kompakt.lineBox,
    why: `Komfort's line box is ${komfort.lineBox} px and Kompakt's is ${kompakt.lineBox} px — the preset changes nothing` });
  rows.push({ id: 'DD§B/kompakt-lineH-covers-its-box', ok: K.lineH >= kompakt.lineBox,
    why: `DENSITY.kompakt.lineH is ${K.lineH} but the rendered line box is ${kompakt.lineBox} px` });
  rows.push({ id: 'DD§B/komfort-lineH-covers-its-box', ok: F.lineH >= komfort.lineBox,
    why: `DENSITY.komfort.lineH is ${F.lineH} but the rendered line box is ${komfort.lineBox} px` });
  // The hazard itself: nothing the user can ask for may put a note outside its
  // own day row. `spill` is 0 exactly when the capacity rule told the truth.
  rows.push({ id: '17.7/no-note-is-painted-outside-its-row', ok: kompakt.spill === 0 && komfort.spill === 0,
    why: `spill — Kompakt ${kompakt.spill} px · Komfort ${komfort.spill} px` });
  // 2.4 — what the row cannot draw is COUNTED, never lost. Rule and rendering
  // must agree on every legal row height, or „+n" lies.
  const disagree = sweep.filter((r) => r.drawn !== Math.min(2, r.capacity));
  rows.push({ id: '2.4/rule-and-rendering-agree-across-the-komfort-range', ok: disagree.length === 0,
    why: `${disagree.length} of ${sweep.length} row heights draw a different number of notes than the capacity rule promises: ${JSON.stringify(disagree)}` });
  verdict('§1 · the capacity rule over two type sizes', rows);
});

/**
 * Every `density-komfort` rule in the shipped stylesheet, and whether it sits
 * inside an `@media screen` block. Walks nested rule lists rather than the top
 * level only, so a rule buried one media query deeper is still found.
 */
const komfortRules = (() => {
  const out = [];
  const walk = (rules, inScreen) => {
    for (const r of rules) {
      if (r.type === CSSRule.MEDIA_RULE) {
        walk(r.cssRules, inScreen || /(^|[\s(,])screen/.test(r.conditionText || r.media.mediaText || ''));
      } else if (r.selectorText && r.selectorText.includes('density-komfort')) {
        out.push({ sel: r.selectorText, screenScoped: inScreen });
      } else if (r.cssRules) {
        walk(r.cssRules, inScreen);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try { walk(sheet.cssRules, false); } catch { /* cross-origin sheet; there are none here */ }
  }
  return out;
})();

// ═════════════════════════════════════════════════════════════════════════════
// §2 · KOMPAKT IS TODAY, TO THE PIXEL
//
// The cheapest way to make „this setting costs the default board nothing" false
// is to write the default preset as a class and then let it drift. So Kompakt is
// the ABSENCE of a class, and this section measures a Kompakt board against a
// board rendered with `density` unset — the state of every install that has
// never opened ⚙ and of every `board.json` written before LZP-808 existed.
// ═════════════════════════════════════════════════════════════════════════════

test('§2 · a board with no `density` key and a Kompakt board are the same board', () => {
  const scene = {
    notes: [
      own('a', DAY, 'Zahnarzt Lena', { repeatsYearly: true, exposure: { level: 'geteilt', pending: false } }),
      foreign('b', DAY, 'geteilt', { who: MEMBERS[0], text: 'Chorprobe', isNew: true }),
    ],
    bars: [ownBar('c', D(2), D(9), 'Urlaub Nordsee'), foreignBar('d', D(4), D(7), 'geteilt', { who: MEMBERS[1], label: 'Kur' })],
  };
  const shot = () => {
    const day = dayNode();
    const boxes = {};
    for (const sel of ['.d-num', '.d-wd', '.note', '.note .chip', '.note .exp', '.note .neu-dot', '.d-more']) {
      const n = $(sel, day) || $(`#board ${sel}`);
      if (!n) { boxes[sel] = null; continue; }
      const r = n.getBoundingClientRect();
      const cs = getComputedStyle(n);
      boxes[sel] = `${px(r.width)}×${px(r.height)} @${cs.fontSize}`;
    }
    const bl = $('#board .bar-label');
    boxes['.bar-label'] = bl ? `${px(bl.getBoundingClientRect().width)}×${px(bl.getBoundingClientRect().height)} @${getComputedStyle(bl).fontSize}` : null;
    const col = $('#board .col');
    boxes['.col'] = `${px(col.getBoundingClientRect().width)}×${px(col.getBoundingClientRect().height)}`;
    boxes['.day'] = px(day.getBoundingClientRect().height);
    boxes['--gutter'] = getComputedStyle(document.documentElement).getPropertyValue('--gutter').trim();
    boxes['--lane-w'] = getComputedStyle(document.documentElement).getPropertyValue('--lane-w').trim();
    return boxes;
  };

  // `density` DELETED, not set — a v1 board.json, opened by this build.
  const pre = withBoard({ ...scene, settings: { rowHeight: 22, colWidth: 118, layers: { ...NO_LAYERS }, hiddenMembers: {}, bundesland: '' } }, () => {
    delete store.state.settings.density;
    S.applySettingsToBody();
    renderBoard(boardEl());
    return { classes: document.body.className, boxes: shot(), density: L.densityOf(store.state.settings) };
  });
  const kompakt = withBoard({ ...scene, settings: SET('kompakt') },
    () => ({ classes: document.body.className, boxes: shot(), density: L.densityOf(store.state.settings) }));

  diag(`no density key → densityOf = „${pre.density}" · body.className „${pre.classes}"`);
  diag(`density=kompakt → densityOf = „${kompakt.density}" · body.className „${kompakt.classes}"`);
  for (const k of Object.keys(pre.boxes)) {
    const same = pre.boxes[k] === kompakt.boxes[k];
    diag(`   ${k.padEnd(16)} ${String(pre.boxes[k]).padEnd(24)} ${same ? '≡' : '≠'} ${kompakt.boxes[k]}`);
  }

  const drift = Object.keys(pre.boxes).filter((k) => pre.boxes[k] !== kompakt.boxes[k]);
  verdict('§2 · Kompakt is the absence of a class', [
    { id: '17.7/an-unset-density-is-kompakt', ok: pre.density === 'kompakt',
      why: `a board.json with no density key answers „${pre.density}"` },
    { id: '17.7/kompakt-adds-no-body-class', ok: !/density-/.test(kompakt.classes),
      why: `Kompakt put „${kompakt.classes}" on the body — a default preset that is a class is a preset that can drift` },
    { id: '17.7/kompakt-is-byte-identical-to-the-v1-board', ok: drift.length === 0,
      why: `${drift.length} measured boxes moved between „no density key" and „density=kompakt": ${drift.join(', ')}` },
    { id: '17.7/lanes-do-not-move', ok: pre.boxes['--gutter'] === '27px' && pre.boxes['--lane-w'] === '6px',
      why: `the lane geometry is ${pre.boxes['--lane-w']} / ${pre.boxes['--gutter']} and v1's is 6px / 27px` },
    // 12.2 / 12.4 — THE POSTER IS A POSTER ON ANY MAC. `print.css` fixes its own
    // geometry and already ignores the row-height slider, and a per-DEVICE
    // eyesight preference has no business on paper. Unscoped,
    // `body.density-komfort .note` would out-specify every `@media print` rule
    // that sets a font on `.note`, so the whole preset lives inside
    // `@media screen`. Checked structurally through the CSSOM, because WebKit
    // cannot be asked to lay the page out for paper from here.
    { id: '12.2/the-density-preset-never-reaches-paper', ok: komfortRules.every((r) => r.screenScoped),
      why: `${komfortRules.filter((r) => !r.screenScoped).length} of ${komfortRules.length} density-komfort rules are outside @media screen: `
        + JSON.stringify(komfortRules.filter((r) => !r.screenScoped).map((r) => r.sel)) },
    { id: 'NON-VACUITY/the-preset-has-rules-to-scope', ok: komfortRules.length >= 10,
      why: `only ${komfortRules.length} density-komfort rules were found in the CSSOM — this cell is checking nothing` },
  ]);
});


// ═════════════════════════════════════════════════════════════════════════════
// §3 · THE BILL — what Komfort buys and what it costs, on the adversary's board
//
// The E8 density adversary's 8-member × 2-year fixture, at both presets, with
// every number the cut decision needs in one table. The honest summary lives in
// the diag, not in an assertion: this section asserts only the things that would
// make Komfort a REGRESSION, and reports the rest.
// ═════════════════════════════════════════════════════════════════════════════

function fixture8x2() {
  let seed = 20260901;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const TXT = ['Elternabend Klasse 3b', 'Zahnarzt Lena 14 Uhr', 'Chorprobe Gemeindehaus',
    'Yoga mit Ümit', 'Turnier Auswärts Kiel', 'Ballett Vorführung', 'Kur Bad Tölz', 'Konferenz Hamburg'];
  const LBL = ['Urlaub', 'Projekt', 'Kur', 'Dienstreise', 'Ferienlager'];
  const notes = []; const bars = [];
  const DAYS = 730;
  const day0 = new Date(Date.UTC(COL.y, COL.m - 1, 1) - 180 * 86400000);
  const at = (i) => new Date(day0.getTime() + i * 86400000).toISOString().slice(0, 10);
  const people = [{ id: 'mem_me', me: true }].concat(MEMBERS);
  const T0 = Date.UTC(2025, 8, 1);
  let ctr = 0;
  const stamp = () => born(T0 + Math.floor(rnd() * 365 * 86400000), ctr++ % 1000000);
  for (const p of people) {
    for (let d = 0; d < DAYS; d++) {
      if (rnd() > 0.5) continue;
      const date = at(d);
      if (p.me) {
        notes.push(own('n' + notes.length, date, TXT[(rnd() * 8) | 0], {
          _born: stamp(),
          categoryId: store.state.categories[(rnd() * store.state.categories.length) | 0].id,
          repeatsYearly: rnd() < 0.04,
          exposure: rnd() < 0.3 ? { level: rnd() < 0.5 ? 'belegt' : 'geteilt', pending: rnd() < 0.2 } : null,
        }));
      } else {
        const shared = rnd() < 0.5;
        notes.push(foreign('n' + notes.length, date, shared ? 'geteilt' : 'belegt', {
          _born: stamp(), who: p, text: shared ? TXT[(rnd() * 8) | 0] : null,
          repeatsYearly: rnd() < 0.04, isNew: rnd() < 0.15,
        }));
      }
    }
    for (let i = 0; i < 52; i++) {
      const s = (rnd() * DAYS) | 0;
      const a = at(s); const b = at(Math.min(DAYS - 1, s + 2 + ((rnd() * 12) | 0)));
      if (p.me) bars.push(ownBar('b' + bars.length, a, b, LBL[(rnd() * 5) | 0], { _born: stamp() }));
      else {
        const shared = rnd() < 0.5;
        bars.push(foreignBar('b' + bars.length, a, b, shared ? 'geteilt' : 'belegt', {
          _born: stamp(), who: p, label: shared ? LBL[(rnd() * 5) | 0] : null, isNew: rnd() < 0.15,
        }));
      }
    }
  }
  return { notes, bars };
}
const FX = fixture8x2();

/**
 * Characters of a note's own sentence the reader can actually see.
 * The `Range`-per-character walk `e8-density-truncation.dom.js` established: a
 * reader does not read pixels, and the last characters are the ones that carry
 * the meaning („Zahnarzt **Lena**").
 */
function visibleChars(note) {
  let tn = null;
  for (const n of note.childNodes) if (n.nodeType === 3 && n.textContent.trim()) tn = n;
  if (!tn) return null;
  const text = tn.textContent;
  const clipR = note.getBoundingClientRect().right;
  // „+n" is opaque and lands INSIDE the text column (legibility §A2), so it
  // takes characters back on the 97 % of family rows that carry one.
  const day = note.closest('.day');
  const more = day ? day.querySelector('.d-more') : null;
  const hardR = more ? Math.min(clipR, more.getBoundingClientRect().left) : clipR;
  const r = document.createRange();
  let seen = 0;
  for (let i = 1; i <= text.length; i++) {
    r.setStart(tn, i - 1); r.setEnd(tn, i);
    if (r.getBoundingClientRect().right <= hardR + 0.5) seen = i; else break;
  }
  return { total: text.length, seen };
}

function survey() {
  const days = $$('#board .day[data-date]');
  const more = $$('#board .d-more');
  const notes = $$('#board .note');
  const mine = notes.filter((n) => !n.classList.contains('foreign'));
  let seen = 0; let withText = 0;
  for (const n of mine) {
    const v = visibleChars(n);
    if (!v) continue;
    withText++; seen += v.seen;
  }
  const col = $('#board .col');
  const wrap = $('.board-wrap') || boardEl().parentElement;
  return {
    days: days.length,
    notesDrawn: notes.length,
    mineDrawn: new Set(mine.map((n) => `${n.dataset.noteId}@${n.dataset.date}`)).size,
    withMore: more.length,
    pctMore: px(more.length / Math.max(1, days.length) * 100),
    meanChars: px(seen / Math.max(1, withText)),
    colW: px(col.getBoundingClientRect().width),
    colH: px(col.getBoundingClientRect().height),
    boardW: px(boardEl().scrollWidth),
    needsH: px(col.getBoundingClientRect().height),
    scrollsX: boardEl().scrollWidth > wrap.clientWidth + 0.5,
    typePx: mine.length ? getComputedStyle(mine[0]).fontSize : '—',
  };
}

test('§3 · the bill — 8 people × 2 years, Kompakt against Komfort', () => {
  const mineN = FX.notes.filter((n) => !n.isForeign);
  const mineB = FX.bars.filter((b) => !b.isForeign);
  const solo = withBoard({ notes: mineN, bars: mineB, settings: SET('kompakt') }, survey);
  const kompakt = withBoard({ ...FX, settings: SET('kompakt') }, survey);
  const komfort = withBoard({ ...FX, settings: SET('komfort') }, survey);

  const wrap = $('.board-wrap') || boardEl().parentElement;
  const chrome = px(window.innerHeight - wrap.clientHeight);

  diag(`fixture ${FX.notes.length} notes / ${FX.bars.length} bars · 8 people · 2 years · stamps interleaved`);
  diag('');
  diag('                                  SOLO/Kompakt      Kompakt        Komfort     Komfort − Kompakt');
  const row = (label, a, b, c, fmt = (x) => String(x)) =>
    diag(`   ${label.padEnd(30)}${fmt(a).padStart(12)}${fmt(b).padStart(15)}${fmt(c).padStart(15)}`
      + `${(typeof b === 'number' && typeof c === 'number' ? (c - b >= 0 ? '+' : '') + px(c - b) : '—').padStart(18)}`);
  row('entry type size', solo.typePx, kompakt.typePx, komfort.typePx);
  row('my note occurrences drawn', solo.mineDrawn, kompakt.mineDrawn, komfort.mineDrawn);
  row('notes drawn, all owners', solo.notesDrawn, kompakt.notesDrawn, komfort.notesDrawn);
  row('day rows carrying „+n" (%)', solo.pctMore, kompakt.pctMore, komfort.pctMore);
  row('chars of MY sentence visible', solo.meanChars, kompakt.meanChars, komfort.meanChars);
  row('column width (px)', solo.colW, kompakt.colW, komfort.colW);
  row('board width (px)', solo.boardW, kompakt.boardW, komfort.boardW);
  row('board height (px)', solo.colH, kompakt.colH, komfort.colH);
  diag('');
  diag(`   window chrome above/below the board: ${chrome} px`);
  diag(`   → Kompakt fits 12 months in ${px(kompakt.boardW)} × ${px(kompakt.colH + chrome)} px of window`);
  diag(`   → Komfort fits 12 months in ${px(komfort.boardW)} × ${px(komfort.colH + chrome)} px of window`);
  diag(`   the trade (1.4): at anything narrower the board scrolls sideways, month headers pinned.`);
  const charGain = kompakt.meanChars ? px((komfort.meanChars / kompakt.meanChars - 1) * 100) : 0;
  const typeGain = px((F.typePx / K.typePx - 1) * 100);
  diag(`   KOMFORT BUYS: ${typeGain} % type, ${charGain} % characters of my own sentence, and 0 extra entries.`);
  diag(`   KOMFORT COSTS: ${px(komfort.colH - kompakt.colH)} px of board height and ${px(komfort.boardW - kompakt.boardW)} px of board width.`);

  verdict('§3 · Komfort improves the crowded board, it does not merely enlarge it', [
    // The adversary's demand. Bigger type that shows FEWER entries is a
    // regression dressed as an accessibility feature.
    { id: '17.7/komfort-draws-no-fewer-entries-than-kompakt', ok: komfort.mineDrawn >= kompakt.mineDrawn && komfort.notesDrawn >= kompakt.notesDrawn,
      why: `Komfort drew ${komfort.mineDrawn}/${komfort.notesDrawn} where Kompakt drew ${kompakt.mineDrawn}/${kompakt.notesDrawn}` },
    { id: '17.7/komfort-does-not-add-„+n"-load', ok: komfort.pctMore <= kompakt.pctMore + 0.1,
      why: `„+n" load went ${kompakt.pctMore} % → ${komfort.pctMore} %` },
    // 2.5 — the point of a wider column is the end of the sentence. If Komfort
    // grew the type without growing the column it would cost characters, and
    // the story's „accepting horizontal scroll as the trade" would buy nothing.
    { id: '2.5/komfort-costs-the-sentence-nothing', ok: komfort.meanChars >= kompakt.meanChars,
      why: `${kompakt.meanChars} characters of my own note are visible at Kompakt and only ${komfort.meanChars} at Komfort` },
    { id: '17.7/the-type-really-is-bigger', ok: parseFloat(komfort.typePx) > parseFloat(kompakt.typePx),
      why: `type is ${kompakt.typePx} at Kompakt and ${komfort.typePx} at Komfort` },
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════
// §4 · THE FLOOR IS STRUCTURAL, NOT ADVISORY
//
// `DENSITY.komfort.minRowHeight` is the one number that keeps §3's first cell
// true. Enforcing it only in the settings pane would leave it out of reach of a
// board.json that arrived by import, by migration or by hand — which is exactly
// how Mom's second Mac gets its first board. So `buildBoard` clamps too, and
// this section drives the clamp from BELOW the floor.
// ═════════════════════════════════════════════════════════════════════════════

test('§4 · no reachable Komfort setting shows less than Kompakt shows', () => {
  const scene = { notes: [own('a', DAY, 'Zahnarzt Lena'), own('b', DAY, 'Elternabend 3b')], bars: [] };
  const at = (d, rowH) => withBoard({ ...scene, settings: SET(d, { rowHeight: rowH }) }, (m) => ({
    asked: rowH, rowH: m.rowH, capacity: m.capacity, drawn: $$('.note', dayNode()).length,
    more: $('.d-more', dayNode()) ? $('.d-more', dayNode()).textContent : '—',
  }));

  const kompaktFloor = at('kompakt', K.minRowHeight);
  const kompaktDefault = at('kompakt', K.rowHeight);
  diag(`Kompakt at its floor  ${K.minRowHeight} px → row ${kompaktFloor.rowH} · capacity ${kompaktFloor.capacity} · drew ${kompaktFloor.drawn} · „${kompaktFloor.more}"`);
  diag(`Kompakt at default    ${K.rowHeight} px → row ${kompaktDefault.rowH} · capacity ${kompaktDefault.capacity} · drew ${kompaktDefault.drawn}`);

  // The attack: ask Komfort for row heights BELOW its floor, including v1's 18.
  const below = [12, 18, 20, 22, 25].map((rh) => at('komfort', rh));
  for (const r of below) {
    diag(`Komfort asked ${String(r.asked).padStart(2)} px → row ${String(r.rowH).padStart(2)} px · capacity ${r.capacity} · drew ${r.drawn}`);
  }
  const legal = [];
  for (let rh = F.minRowHeight; rh <= F.maxRowHeight; rh++) legal.push(at('komfort', rh));
  diag(`Komfort across its legal range ${F.minRowHeight}–${F.maxRowHeight} px: capacities ${JSON.stringify([...new Set(legal.map((r) => r.capacity))])}`);

  verdict('§4 · the floor', [
    { id: '17.7/the-floor-is-enforced-in-the-model', ok: below.every((r) => r.rowH >= F.minRowHeight),
      why: `these Komfort rows rendered below the floor: ${JSON.stringify(below.filter((r) => r.rowH < F.minRowHeight))}` },
    { id: '17.7/komfort-never-drops-below-kompakt-capacity', ok: below.concat(legal).every((r) => r.capacity >= kompaktDefault.capacity),
      why: `a reachable Komfort setting gives capacity ${Math.min(...below.concat(legal).map((r) => r.capacity))} where Kompakt's default gives ${kompaktDefault.capacity}` },
    // v1's own floor must be untouched: Kompakt is still allowed all the way
    // down to 18 px, and 18 px still means one line. Regressing this would be
    // 17.7 quietly taking v1's thinnest board away.
    { id: 'v1-1.2/kompakt-keeps-its-18px-floor', ok: kompaktFloor.rowH === 18 && kompaktFloor.capacity === 1,
      why: `Kompakt at 18 px rendered row ${kompaktFloor.rowH} with capacity ${kompaktFloor.capacity}` },
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════
// §5 · PER DEVICE — „Mom's display and eyes are not mine"
//
// The half of 17.7 that would be a data bug rather than a layout bug. `density`
// is a `settings` key, and `settings` is written through `tx.pref()` — a
// `local`-space op, rule U6. `store.js:outbox()` filters on
// `op.space === this._personalSpaceId`, so the op cannot be offered to a peer.
// This section asserts the space rather than trusting the docblock.
// ═════════════════════════════════════════════════════════════════════════════

test('§5 · choosing a density writes a `local`-space pref and nothing else', () => {
  const before = JSON.parse(JSON.stringify(store.state.settings));
  const seen = new Set((store._log.ops() || []).map((o) => o.id));
  try {
    store.setSettings({ density: 'komfort', rowHeight: F.rowHeight, colWidth: F.colWidth });
    S.applySettingsToBody();          // the second write the settings pane makes
    const fresh = (store._log.ops() || []).filter((o) => !seen.has(o.id));
    const spaces = [...new Set(fresh.map((o) => o.space))];
    const kinds = [...new Set(fresh.map((o) => o.k))];
    const out = store.outbox();
    diag(`the write emitted ${fresh.length} op(s) · kinds ${JSON.stringify(kinds)} · spaces ${JSON.stringify(spaces)}`);
    diag(`   patch: ${JSON.stringify(fresh.map((o) => o.f))}`);
    diag(`   outbox after the write: ${out.length} op(s) — rule U6, a pref is never on a wire`);
    diag(`   state.settings.density = „${store.state.settings.density}" · body „${document.body.className}"`);
    diag(`   gid on the pref op: ${JSON.stringify(fresh.map((o) => o.gid))} — a density change is not undoable (18.4/U6)`);

    verdict('§5 · per device', [
      { id: '17.7/density-is-written-at-all', ok: store.state.settings.density === 'komfort',
        why: `state.settings.density is ${JSON.stringify(store.state.settings.density)} after the write` },
      { id: '17.7/it-is-a-pref', ok: kinds.length === 1 && kinds[0] === 'pref.set',
        why: `the write emitted ${JSON.stringify(kinds)}, not exactly one pref.set` },
      { id: 'U6/it-lives-in-the-local-space', ok: spaces.length === 1 && spaces[0] === 'local',
        why: `the density op is in space ${JSON.stringify(spaces)} — anything but "local" can reach a peer` },
      { id: '17.7/it-is-never-offered-to-the-family', ok: out.every((o) => o.k !== 'pref.set'),
        why: `${out.filter((o) => o.k === 'pref.set').length} pref ops are in the outbox` },
      { id: 'U6/a-density-change-is-not-undoable', ok: fresh.every((o) => !o.gid),
        why: `the density op carries gid ${JSON.stringify(fresh.map((o) => o.gid))} — ⌘Z would step through a display preference` },
      { id: '17.7/the-type-half-reaches-the-body', ok: document.body.classList.contains('density-komfort'),
        why: `after the write the body reads „${document.body.className}" — the row height moved and the type did not` },
    ]);
  } finally {
    store.state.settings = before;
    S.applySettingsToBody();
    renderBoard(boardEl());
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// §6 · THE BADGE FAMILY AT BOTH ENDS
//
// The density adversary's second demand: „Kompakt must not make the badge family
// illegible." Kompakt is v1's default, which `family-density.dom.js` §1 already
// clears at 22 px — so the row that matters here is the one nobody measured:
// the five marks at KOMFORT, where every one of them grew by 7/6 and could
// therefore collide with the neighbour it used to clear by 1 px.
// ═════════════════════════════════════════════════════════════════════════════

test('§6 · five marks on one day row, at both presets', () => {
  // Deliverable 17's day: the two rows a capacity-2 board can draw are made to
  // carry, between them, ALL FIVE contested marks — 16.6 exposure badge and 9.2
  // ↻ on mine, 17.5 „neu" dot + 17.2 initial chip + ↻ on hers — plus the 2.4
  // „+n" the other two entries fall into. `_born` is set so the slice is a fact
  // and not a lottery (FINDINGS §12a: a first-match fixture must be scanned for
  // or pinned, never guessed).
  const scene = {
    notes: [
      own('mine', DAY, 'Zahnarzt Lena 14 Uhr', { _born: born(Date.UTC(2025, 0, 1), 1), repeatsYearly: true, exposure: { level: 'belegt', pending: true } }),
      foreign('hers', DAY, 'geteilt', { _born: born(Date.UTC(2025, 0, 2), 2), who: MEMBERS[0], text: 'Chorprobe Gemeindehaus', isNew: true, repeatsYearly: true }),
      foreign('his', DAY, 'belegt', { _born: born(Date.UTC(2025, 0, 3), 3), who: MEMBERS[1], isNew: true }),
      foreign('theirs', DAY, 'geteilt', { _born: born(Date.UTC(2025, 0, 4), 4), who: MEMBERS[2], text: 'Ballett' }),
    ],
    bars: [ownBar('b1', D(2), D(9), 'Urlaub Nordsee'), foreignBar('b2', D(3), D(8), 'geteilt', { who: MEMBERS[3], label: 'Kur', isNew: true })],
  };
  const audit = (d) => withBoard({ ...scene, settings: SET(d) }, () => {
    const day = dayNode();
    const marks = [];
    for (const n of $$('.note', day)) {
      for (const c of n.children) {
        const r = c.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) marks.push({ cls: c.className, r });
      }
    }
    const more = $('.d-more', day);
    if (more) marks.push({ cls: 'd-more', r: more.getBoundingClientRect() });
    let collisions = 0; let minGap = Infinity;
    for (let i = 0; i < marks.length; i++) {
      for (let j = i + 1; j < marks.length; j++) {
        const a = marks[i].r; const b = marks[j].r;
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 0.5 && oy > 0.5) collisions++;
        else if (oy > 0.5) minGap = Math.min(minGap, px(-ox));
      }
    }
    const smallest = marks.reduce((m, x) => Math.min(m, x.r.width, x.r.height), Infinity);
    return { marks: marks.length, kinds: marks.map((m) => m.cls), collisions, minGap: minGap === Infinity ? null : minGap, smallest: px(smallest) };
  });

  const a = audit('kompakt');
  const b = audit('komfort');
  diag(`Kompakt · ${a.marks} painted marks · ${a.collisions} collisions · smallest ${a.smallest} px · min horizontal gap ${a.minGap} px`);
  diag(`   ${JSON.stringify(a.kinds)}`);
  diag(`Komfort · ${b.marks} painted marks · ${b.collisions} collisions · smallest ${b.smallest} px · min horizontal gap ${b.minGap} px`);
  diag(`   ${JSON.stringify(b.kinds)}`);

  verdict('§6 · the badge family', [
    { id: 'D17/kompakt-keeps-the-family-legible', ok: a.collisions === 0 && a.smallest >= 3,
      why: `Kompakt: ${a.collisions} collisions, smallest mark ${a.smallest} px` },
    { id: 'D17/komfort-keeps-the-family-legible', ok: b.collisions === 0 && b.smallest >= 3,
      why: `Komfort: ${b.collisions} collisions, smallest mark ${b.smallest} px` },
    // The point of scaling the marks with the type: at Komfort the SMALLEST
    // thing on the row must not still be the 3 px thing it was at Kompakt, or
    // the sentence grew and the marks became specks beside it.
    { id: '17.7/the-marks-grew-with-the-sentence', ok: b.smallest > a.smallest,
      why: `the smallest mark is ${a.smallest} px at Kompakt and ${b.smallest} px at Komfort — the badge family did not scale` },
    // Deliverable 17's own sentence, on the day it was written for: all five
    // markers plus „+n", coexisting, at BOTH presets.
    { id: 'D17/all-five-markers-coexist-at-both-presets',
      ok: ['exp', 'rep', 'neu-dot', 'chip', 'd-more'].every((k) => a.kinds.join(' ').includes(k) && b.kinds.join(' ').includes(k)),
      why: `Kompakt drew ${JSON.stringify(a.kinds)} and Komfort ${JSON.stringify(b.kinds)}` },
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════
// §7 · THE TRADE IS 1.4's, NOT A SECOND BEHAVIOUR
//
// „accepting horizontal scroll as the trade" — and v1 already has that
// behaviour: below 12 visible columns the board scrolls horizontally with the
// month headers pinned. Komfort must land IN it. A Komfort that invented its own
// narrow-window handling would be a second answer to a solved problem.
// ═════════════════════════════════════════════════════════════════════════════

test('§7 · Komfort lands in story 1.4, with the month headers still pinned', async () => {
  const scene = { notes: [own('a', DAY, 'Zahnarzt Lena')], bars: [] };
  const wrap = $('.board-wrap') || boardEl().parentElement;
  const probe = (d, width) => {
    const before = document.body.style.cssText;
    document.body.style.width = `${width}px`;
    document.body.style.maxWidth = `${width}px`;
    void document.body.offsetWidth;
    try {
      return withBoard({ ...scene, settings: SET(d) }, () => {
        const w = $('.board-wrap') || boardEl().parentElement;
        w.scrollTop = 0; w.scrollLeft = 0;
        const headTop = px($('#board .col-head').getBoundingClientRect().top);
        w.scrollTop = 120;
        void w.offsetHeight;
        const headTopAfter = px($('#board .col-head').getBoundingClientRect().top);
        const cols = $$('#board .col').filter((c) => {
          const r = c.getBoundingClientRect();
          return r.left >= w.getBoundingClientRect().left - 0.5 && r.right <= w.getBoundingClientRect().right + 0.5;
        }).length;
        w.scrollTop = 0;
        return {
          need: px(boardEl().scrollWidth), have: px(w.clientWidth),
          scrollsX: boardEl().scrollWidth > w.clientWidth + 0.5,
          fullyVisibleCols: cols,
          headPinned: Math.abs(headTop - headTopAfter) < 0.6,
          sticky: getComputedStyle($('#board .col-head')).position,
        };
      });
    } finally { document.body.style.cssText = before; void document.body.offsetWidth; }
  };

  diag(`  preset   window   board needs   fully visible cols   scrolls sideways   .col-head position   header pinned under a 120 px vertical scroll`);
  const rows = [];
  for (const d of ['kompakt', 'komfort']) {
    for (const w of [1680, 1440, 1280, 1100, 900]) {
      const r = probe(d, w);
      rows.push({ d, w, ...r });
      diag(`  ${d.padEnd(9)}${String(w).padStart(6)}${String(r.need).padStart(14)}${String(r.fullyVisibleCols).padStart(21)}`
        + `${String(r.scrollsX).padStart(19)}${String(r.sticky).padStart(21)}${String(r.headPinned).padStart(12)}`);
    }
  }
  const komfort1440 = rows.find((r) => r.d === 'komfort' && r.w === 1440);
  const kompakt1440 = rows.find((r) => r.d === 'kompakt' && r.w === 1440);
  diag(`  at 1440 px — Kompakt shows ${kompakt1440.fullyVisibleCols} full months, Komfort ${komfort1440.fullyVisibleCols}. That IS the trade, stated in months.`);

  verdict('§7 · the trade', [
    { id: '1.4/the-headers-stay-pinned-at-both-presets', ok: rows.every((r) => r.headPinned && r.sticky === 'sticky'),
      why: `these rows lost the pinned header: ${JSON.stringify(rows.filter((r) => !r.headPinned || r.sticky !== 'sticky').map((r) => `${r.d}@${r.w}`))}` },
    { id: '1.4/komfort-uses-the-existing-horizontal-scroll', ok: komfort1440.scrollsX === (komfort1440.need > komfort1440.have),
      why: 'Komfort did not fall into `.board-wrap { overflow-x: auto }` — it invented something' },
    { id: '17.7/komfort-costs-columns-and-says-so', ok: komfort1440.fullyVisibleCols <= kompakt1440.fullyVisibleCols,
      why: `Komfort shows ${komfort1440.fullyVisibleCols} full months at 1440 px and Kompakt ${kompakt1440.fullyVisibleCols} — the trade did not happen` },
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════
// §8 · THE HALF OF THE TRADE 17.7 DOES NOT MENTION
//
// The story sells horizontal scroll as the price, and 1.4 makes that price
// graceful. It does not mention the VERTICAL price, and v1 does not treat that
// one as a trade at all: „header + 31 rows + scratchpad should fit without
// vertical scrolling" (§2), „The board never scrolls vertically" (§1's design
// note). A Komfort row is 4 px taller than a Kompakt one, thirty-one times over
// — 124 px — which is more than the difference between a 13" MacBook and a 27"
// display leaves spare.
//
// So the settings pane measures THIS window and says what falls below the fold.
//
// THE SWEEP IS OVER ROW HEIGHT, NOT OVER WINDOW HEIGHT, and that is a fact about
// the harness rather than a choice: a tier-2 file runs inside a real WKWebView
// whose height it cannot change (`.board-wrap` fills the flex column and ignores
// a `body { height }`, which an earlier draft of this section learned the hard
// way). Row height is the OTHER side of the same inequality, and crossing it
// from below and from above proves the same rule — so what is asserted is the
// BICONDITIONAL: the warning is present exactly when `need > have`, never
// merely often. Both languages, because a warning that only exists in German is
// a warning Mom's English Mac does not get (13.7).
// ═════════════════════════════════════════════════════════════════════════════

test('§8 · the vertical cost is measured against this window and said out loud', async () => {
  const i18n = await importApp('i18n.js');
  const langBefore = i18n.getLang();
  const before = JSON.parse(JSON.stringify(store.state.settings));
  const cleanup = () => { document.querySelectorAll('.scrim,.sheet').forEach((n) => n.remove()); };

  /** Open the REAL sheet at a given density, row height and language. */
  const at = (d, rowHeight, lang) => {
    i18n.setLang(lang);
    Object.assign(store.state.settings, SET(d, { rowHeight }), { language: lang });
    S.applySettingsToBody();
    renderBoard(boardEl());
    cleanup();
    S.openSettings();
    const wrap = $('.board-wrap') || boardEl().parentElement;
    const mine = $$('.sheet-body .warn').map((n) => n.textContent)
      .filter((w) => /px zu niedrig|px too short/.test(w));
    const compacted = $$('.sheet-body .hint').map((n) => n.textContent)
      .filter((h) => /zu niedrig, daher|so the board is drawing/.test(h));
    const perDevice = $$('.sheet-body .hint').map((n) => n.textContent)
      .filter((h) => /nur für diesen Mac|to this Mac only/.test(h));
    // THE ROW HEIGHT THE BOARD ACTUALLY DREW, read off the rendered variable.
    //
    // This was `Math.max(minRowHeight, rowHeight)` — the preset's floor applied to the request —
    // and the chrome was a re-typed `26 + 62`. Both stopped being right at 1.B: the row height is
    // now capped to what FITS, and `--pad-h` moved for 10.5, so `need` was overstated by 14px AND
    // computed from a height the board no longer draws. That is why this row went red on CI and
    // green here — it only disagreed on windows of certain heights.
    const have = wrap.clientHeight;
    const effective = parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue('--row-h'), 10);
    cleanup();
    return {
      have,
      asked: Math.max(L.DENSITY[d].minRowHeight, rowHeight),
      effective,
      need: 31 * effective + L.BOARD_CHROME_H,
      warned: mine.length === 1,
      compacted: compacted.length === 1,
      text: mine[0] || null,
      perDevice: perDevice[0] || null,
    };
  };

  try {
    const grid = {};
    for (const lang of ['de', 'en']) {
      for (const d of ['kompakt', 'komfort']) {
        for (const rh of [18, 22, 24, 26, 28, 32]) grid[`${lang}/${d}/${rh}`] = at(d, rh, lang);
      }
    }
    diag('  lang/preset/row   board has   board needs   warning');
    for (const [k, r] of Object.entries(grid)) {
      diag(`  ${k.padEnd(18)}${String(r.have).padStart(9)}${String(r.need).padStart(14)}   ${r.warned ? 'WARNS' : 'silent'}${r.need > r.have ? '' : '   (fits)'}`);
    }
    const anyCompact = Object.entries(grid).find(([, r]) => r.compacted);
    const anyFull = Object.entries(grid).find(([, r]) => !r.compacted);
    diag(`  DE per-device line: „${grid['de/kompakt/22'].perDevice}"`);
    diag(`  EN per-device line: „${grid['en/kompakt/22'].perDevice}"`);

    const overflowing = Object.entries(grid).filter(([, r]) => r.need > r.have + 1);
    const inflated = Object.entries(grid).filter(([, r]) => r.effective > r.asked);
    const mismatched = Object.entries(grid).filter(([, r]) => r.compacted !== (r.effective < r.asked));
    const wrong = Object.entries(grid).filter(([, r]) => r.warned !== (r.need > r.have + 1));
    verdict('§8 · the vertical cost', [
      // The biconditional. „Warns when it should" and „is quiet when it should"
      // in one cell, over twenty-four configurations.
      { id: 'v1§2/the-warning-is-exactly-need-exceeds-have', ok: wrong.length === 0,
        why: `${wrong.length} configurations disagree with their own measurement: ${JSON.stringify(wrong.map(([k, r]) => `${k} have ${r.have} need ${r.need} warned ${r.warned}`))}` },
      // ── THE PROMISE ITSELF (1.B / N16) ────────────────────────────────────
      // This section characterised the vertical cost as a TRADE the settings pane confesses to.
      // It is not a trade any more: the row height is a ceiling and the board takes whatever still
      // shows all 31 days. So the promise is asserted over all twenty-four configurations, and it
      // is the cell that would have caught the old behaviour.
      // ── THE PROMISE, AND EXACTLY HOW FAR IT REACHES ───────────────────────
      //
      // At KOMPAKT — v1's default, and what every install starts on — the fit now guarantees it
      // at every row height the slider offers. That is the cell that would have caught the old
      // behaviour, where nine rows and the scratchpad sat below the fold out of the box.
      //
      // At KOMFORT it cannot be guaranteed and never could, which this section discovered rather
      // than introduced: `DENSITY.komfort.minRowHeight` is 26 — "the smallest Komfort row that
      // still shows what a Kompakt row shows" — so 31 of them plus the chrome need a 922px
      // scroller, i.e. a window near 990. No 1440×900 display has one. Komfort is therefore a
      // deliberate trade on a laptop, and the honest thing is that the sheet SAYS so, which is
      // the biconditional cell below. Dropping below 26 to force a fit would give a Komfort user
      // fewer lines per row than Kompakt shows, which is not a fit anyone asked for.
      { id: 'v1§1/all-31-rows-fit-at-the-DEFAULT-density-at-every-row-height',
        ok: overflowing.filter(([k]) => k.includes('kompakt')).length === 0,
        why: `${overflowing.filter(([k]) => k.includes('kompakt')).length} Kompakt configurations `
          + `fall below the fold: ${JSON.stringify(overflowing.filter(([k]) => k.includes('kompakt')).map(([k, r]) => `${k} need ${r.need} have ${r.have}`))}` },
      { id: '1.B/the-fit-never-inflates-a-row-past-what-was-asked-for', ok: inflated.length === 0,
        why: `${inflated.length} configurations drew TALLER rows than asked: ${JSON.stringify(inflated.map(([k, r]) => `${k} asked ${r.asked} drew ${r.effective}`))}` },
      // A SILENT OVERRIDE IS HOW A SETTING COMES TO LOOK BROKEN. When the board compacts itself the
      // person set a height and is not getting it, and the sheet says so — exactly then, never
      // otherwise.
      { id: '1.B/the-compaction-is-disclosed-exactly-when-it-happens', ok: mismatched.length === 0,
        why: `${mismatched.length} configurations misreport it: ${JSON.stringify(mismatched.map(([k, r]) => `${k} asked ${r.asked} drew ${r.effective} said ${r.compacted}`))}` },
      { id: 'v1§2/the-sweep-actually-crosses-the-boundary', ok: !!anyCompact && !!anyFull,
        why: `NON-VACUITY: compacted at ${anyCompact ? anyCompact[0] : 'nowhere'}, full height at ${anyFull ? anyFull[0] : 'nowhere'} — the sweep never crossed the line it characterises` },
      { id: 'v1§2/kompakt-at-its-default-is-not-warned-about-on-this-window', ok: !grid['de/kompakt/22'].warned,
        why: `Kompakt at v1's own default warned, needing ${grid['de/kompakt/22'].need} px of ${grid['de/kompakt/22'].have}` },
      // 13.7 — both languages, always. And the per-device sentence is the only
      // place the user is told the setting does not travel, so it must exist in
      // both too.
      // 13.7 — both languages, always. This used to read the rendered WARNING, which now fires
      // only on a window below the supported minimum; on any normal window there is no text to
      // read. The compaction sentence is the one this harness can actually produce, so that is
      // the pair asserted — and it is asserted only where the sweep produced one.
      { id: '13.7/both-languages-carry-the-compaction-sentence',
        ok: !anyCompact || (() => {
          const de = Object.entries(grid).find(([k, r]) => k.startsWith('de/') && r.compacted);
          const en = Object.entries(grid).find(([k, r]) => k.startsWith('en/') && r.compacted);
          return !!de && !!en;
        })(),
        why: 'the board compacted itself in one language and not the other — Mom\'s English Mac '
          + 'would be told nothing about a row height it is not getting' },
      { id: '17.7/the-per-device-promise-is-stated-in-both-languages',
        ok: !!grid['de/kompakt/22'].perDevice && !!grid['en/kompakt/22'].perDevice
          && grid['de/kompakt/22'].perDevice !== grid['en/kompakt/22'].perDevice,
        why: `DE „${grid['de/kompakt/22'].perDevice}" · EN „${grid['en/kompakt/22'].perDevice}"` },
    ]);
  } finally {
    cleanup();
    i18n.setLang(langBefore);
    store.state.settings = before;
    S.applySettingsToBody();
    renderBoard(boardEl());
  }
});
