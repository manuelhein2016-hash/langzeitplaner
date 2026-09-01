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
        paperCapacity: L.rowCapacity(rowH),
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
    diag(`   this row draws ${r.notesInThisRow} note(s); its body wants ${r.bodyNeeds} px and has ${r.bodyHas} px`);
    diag(`   the note's own text column on A4: ${r.textColumnPx} px`);
    diag(`   the badges do NOT scale with the paper (app.css: „Text scales, marks do not"):`
      + ` chip ${r.chipPx} px · exposure ${r.expPx} px · neu ${r.neuPx} px`);
    diag(`   the „+n" badge on A4: ${r.morePx} px at ${r.moreFont} — an opaque box inside that same text column`);
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

    const rows = [];
    rows.push({ id: 'F12/the-screen-setting-does-not-clip-the-paper', ok: clip[32].clipped === 0,
      why: `at the screen's maximum row height (32 px, capacity 3) ${clip[32].clipped} day rows overflow the A4 row by up to ${clip[32].worstPx} px — clipped by \`.day { overflow: hidden }\`, on paper, with no „+n" to account for it` });
    // The one that decides whether a family poster is a poster.
    rows.push({ id: 'F12/the-paper-row-holds-what-the-model-drew', ok: r.bodyNeeds <= r.bodyHas + 0.5,
      why: `the A4 day row is ${r.bodyHas} px and the entries the model put in it need ${r.bodyNeeds} px — the surplus is clipped by \`.day { overflow: hidden }\`, on paper, with no „+n" to say so` });
    rows.push({ id: 'F12/model-and-paper-agree-on-capacity', ok: r.modelCapacity === r.paperCapacity,
      why: `the model sliced the day to ${r.modelCapacity} entries for a 22 px screen row; A4 re-metrics the same DOM to a ${r.rowH} px row whose own capacity is ${r.paperCapacity}` });
    rows.push({ id: 'A8/a-peer-entry-is-legible-on-A4', ok: r.textColumnPx - (r.neuPx + r.chipPx + 4) > 20,
      why: `a peer's note on A4 has ${r.textColumnPx} px of text column, of which the fixed-size badges take `
        + `${px((r.neuPx || 0) + (r.chipPx || 0) + 4)} px — leaving ${px(r.textColumnPx - ((r.neuPx || 0) + (r.chipPx || 0) + 4))} px at ${r.noteFontPx}` });
    verdict('§E2 · A4 parity', rows);
  } finally { restore(before); }
});

test('§E3 · how much of the family reaches the paper at all', () => {
  const before = snapshot();
  try {
    const count = (fx) => {
      install({ ...fx, settings: SET });
      const m = L.buildBoard(store.state);
      let inWindow = 0; let drawn = 0; let overflow = 0;
      for (const c of m.cols) for (const d of c.days) {
        if (d.empty) continue;
        inWindow += (d.allNotes || []).length;
        drawn += (d.notes || []).length;
        overflow += d.overflow || 0;
      }
      return { inWindow, drawn, overflow, badges: $$('#board .d-more').length };
    };
    const solo = count({ notes: MINE_N, bars: MINE_B });
    const family = count(FX);
    diag(`   solo   — ${solo.inWindow} note occurrences in the 12-month window, ${solo.drawn} printed, ${solo.overflow} folded into ${solo.badges} „+n" badges`);
    diag(`   family — ${family.inWindow} note occurrences in the 12-month window, ${family.drawn} printed (${(family.drawn / family.inWindow * 100).toFixed(0)} %), ${family.overflow} folded into ${family.badges} „+n" badges`);
    diag('   Paper has no popover. Everything inside a „+n" on an A4 sheet is a NUMBER and nothing else —');
    diag('   which is DESIGN-DECISIONS\' own reason for printing the badge, and also the ceiling on what');
    diag('   „a family wall poster is now a two-click product" (A8) can mean at eight members.');
    verdict('§E3 · the poster', [
      { id: 'A8/most-of-the-family-reaches-the-paper', ok: family.drawn / family.inWindow >= 0.75,
        why: `${(family.drawn / family.inWindow * 100).toFixed(0)} % of the entries in the printed window are drawn; the other ${(100 - family.drawn / family.inWindow * 100).toFixed(0)} % are a digit in a badge` },
    ]);
  } finally { restore(before); }
});
