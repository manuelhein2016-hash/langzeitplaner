// TIER 2 · CHARACTERIZATION — "dom-rendering".
//
// Stories in scope: 1.2, 1.4, 2.1–2.4, 3.2, 3.6, 8.1, 12.1–12.4 (+ 15.4).
//
// What this file locks in is what v1 PUTS ON SCREEN, in a real WebKit engine:
// the grid skeleton, the ambient shading stack and how it resolves where the
// layers overlap, the holiday line and its demotion, the Today marker winning
// on specificity, sticky headers under scroll, and the print stylesheet
// re-metricking the identical DOM.
//
// Everything is asserted through OBSERVABLE state — classes, computed styles,
// measured boxes, and entries created through the app's own gestures — so the
// LZP-402 op-log retrofit can replace store internals without touching a line
// here. Nothing below reads store.undoStack, store._persisted, or any other
// private of the store; where board state has to be arranged, it is arranged
// through store.mutate()/setSettings(), the same doors the UI uses.
//
// Plain script, not a module: no `import` statements, no top-level `return`.
// Globals from the runner: test, assert, $, $$, waitFor, sleep, importApp, diag.

const { store } = await importApp('store.js');
const { buildBoard } = await importApp('layout.js');
const { renderBoard, currentModel } = await importApp('board.js');
const { ferienIndex, FERIEN_META } = await importApp('ferien.js');
const { holidayIndex } = await importApp('holidays.js');
const { applySettingsToBody } = await importApp('settings.js');
const { applyPageRule } = await importApp('print.js');
const interact = await importApp('interact.js');
const { daysInMonth, parseISO, addDays, iso, p2, dowISO } = await importApp('dates.js');

// ── plumbing ─────────────────────────────────────────────────────────────────

const boardEl = () => $('#board');
const wrapEl = () => $('#board-wrap');
const model = () => buildBoard(store.state);

// The real redraw path: main.js subscribed to the store at boot and re-renders
// the board, the legend, the toolbar and the find state on every emit that is
// not 'pad'/'select'. Calling it this way (rather than renderBoard directly)
// keeps these tests honest about the pipeline the app actually runs.
const redraw = () => { store.emit('dom-rendering:redraw'); };

const dayNode = (date) => $(`.board .day[data-date="${date}"]`);
const bg = (node, pseudo = null) => getComputedStyle(node, pseudo).backgroundColor;
const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// The four ambient shades, spelled out here so a silent token edit in app.css
// shows up as a failure rather than as a board that quietly stopped separating
// its layers (DESIGN-DECISIONS · D, option 1j).
const SHADE = {
  none: 'rgba(0, 0, 0, 0)',
  weekend: 'rgb(242, 238, 252)',        // --bg-weekend        #F2EEFC
  ferien: 'rgb(250, 248, 254)',         // --bg-ferien         #FAF8FE
  weekendFerien: 'rgb(230, 222, 248)',  // --bg-weekend-ferien #E6DEF8
  today: 'rgb(255, 230, 241)',          // --bg-today          #FFE6F1
  void: 'rgb(250, 249, 254)',           // --bg-void           #FAF9FE
};

const cloneSettings = () => JSON.parse(JSON.stringify(store.state.settings));

/** Arrange settings, run, then put the board back exactly as it was. */
async function withSettings(patch, fn) {
  const before = cloneSettings();
  const { layers, ...rest } = patch;
  try {
    store.setSettings(rest);
    if (layers) store.setLayer(layers);
    applySettingsToBody();
    applyPageRule();
    redraw();
    return await fn();
  } finally {
    store.state.settings = before;
    applySettingsToBody();
    applyPageRule();
    redraw();
  }
}

/** Empty board — no notes, no bars, no pads, nothing selected. */
function reset() {
  store.mutate('dom-rendering:reset', (s) => {
    s.notes = [];
    s.bars = [];
    s.scratchpads = {};
    for (const c of s.categories) c.visible = true;
  });
  interact.clearSelection();
  const find = $('#find-input');
  if (find.value) {
    find.value = '';
    find.dispatchEvent(new Event('input', { bubbles: true }));
  }
  redraw();
}

const addNote = (n) => store.mutate('dom-rendering:add-note', (s) => { s.notes.push(n); });
const addBar = (b) => store.mutate('dom-rendering:add-bar', (s) => { s.bars.push(b); });

// ── gesture helpers (the real entry points) ──────────────────────────────────

const at = (node, dx = 6, dy = 4) => {
  const r = node.getBoundingClientRect();
  return { clientX: r.left + dx, clientY: r.top + dy };
};
const ptr = (type, target, pos) =>
  target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    pointerId: 1, isPrimary: true, ...pos,
  }));

/** press + release without moving — v1's pointer state machine reads a click. */
function click(node, dx, dy) {
  const pos = at(node, dx, dy);
  ptr('pointerdown', node, pos);
  ptr('pointerup', window, pos);
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...pos }));
}

/** press, cross the 4 px threshold, release over `to` — v1 reads a drag. */
function drag(from, to) {
  const a = at(from);
  const b = at(to);
  ptr('pointerdown', from, a);
  ptr('pointermove', window, { clientX: a.clientX, clientY: a.clientY + 12 });
  ptr('pointermove', window, b);
  ptr('pointerup', window, b);
}

/** Type into the open inline editor and commit it the way a user would. */
function typeAndEnter(text) {
  const inp = $('.board .inline-edit');
  assert.ok(inp, 'no inline editor is open');
  inp.value = text;
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  return inp;
}

// ── stylesheet access ────────────────────────────────────────────────────────
// Rules are read from the live CSSOM when the app: scheme lets us; otherwise
// the file is re-parsed into a `media="not all"` <style> that never applies.
// Either way what we inspect is the shipped text of the shipped stylesheet.

const __sheetCache = new Map();
async function rulesOf(name) {
  if (__sheetCache.has(name)) return __sheetCache.get(name);
  let rules = null;
  for (const ss of document.styleSheets) {
    if (!ss.href || !ss.href.endsWith('/' + name)) continue;
    try { if (ss.cssRules && ss.cssRules.length) { rules = [...ss.cssRules]; break; } } catch { /* opaque */ }
  }
  if (!rules) {
    const txt = await (await fetch(new URL('./src/css/' + name, location.href))).text();
    const st = document.createElement('style');
    st.media = 'not all';
    st.textContent = txt;
    document.head.appendChild(st);
    rules = [...st.sheet.cssRules];
  }
  __sheetCache.set(name, rules);
  return rules;
}

/** Flatten every rule that sits inside an `@media print` block of print.css. */
async function printRules() {
  const out = [];
  for (const r of await rulesOf('print.css')) {
    if (r.type !== CSSRule.MEDIA_RULE) continue;
    if (!/print/.test(r.media.mediaText)) continue;
    for (const inner of r.cssRules) out.push(inner);
  }
  return out;
}

const findRule = (rules, sel) => rules.find((r) => r.selectorText === sel);

/**
 * Apply the print stylesheet to the LIVE board and measure it.
 *
 * There is no way to make WKWebView evaluate `@media print` headlessly, so the
 * rules are lifted out of their media block verbatim and injected after both
 * stylesheets — the same position print.css already occupies in the cascade.
 * This is exactly how the README says the A4 metrics were verified ("only the
 * print *stylesheet* was verified, by applying it on screen"). No declaration
 * is retyped here; the text comes from the shipped file.
 */
async function withPrintCSS(fn) {
  const rules = await printRules();
  const st = document.createElement('style');
  st.id = 'lzp-print-sim';
  st.textContent = rules.map((r) => r.cssText).join('\n');
  const wrap = wrapEl();
  const sl = wrap.scrollLeft;
  const stp = wrap.scrollTop;
  document.head.appendChild(st);
  try {
    void document.body.offsetHeight; // force layout at print metrics
    return await fn();
  } finally {
    st.remove();
    void document.body.offsetHeight;
    wrap.scrollLeft = sl;
    wrap.scrollTop = stp;
  }
}

// ── window-relative fixtures (the visible window depends on the wall clock) ──

const M = model();
const WINDOW_DATES = M.cols.flatMap((c) => c.days.filter((d) => !d.empty).map((d) => d.date));
const IN_WINDOW = (d) => d >= M.firstISO && d <= M.lastISO;

/**
 * Holidays as the BOARD sees them. holidayIndex() also returns other states'
 * days so the dimmed union (6.6) can render them; layout.js only shows one
 * when `own` is true or the otherStates layer is on. The fixtures below have
 * to apply the same filter or they pick a date the board deliberately leaves
 * blank — e.g. Buß- und Bettag, which only SN observes.
 */
function ownHolidays(stateCode = '') {
  const idx = holidayIndex([...new Set(M.cols.map((c) => c.y))], stateCode, 'de');
  return new Map([...idx].filter(([, h]) => h.own));
}

/** A day inside the window that carries no ambient layer at all. */
function plainDate() {
  const hol = holidayIndex([...new Set(M.cols.map((c) => c.y))], '', 'de');
  const d = WINDOW_DATES.find((x) => {
    const w = dowISO(x);
    return w !== 0 && w !== 6 && x !== M.today && !hol.has(x);
  });
  assert.ok(d, 'no plain day in the visible window');
  return d;
}

/** Nationwide holiday inside the window that is not today and not a weekend. */
function holidayDate() {
  const hol = ownHolidays('');
  for (const d of WINDOW_DATES) {
    const w = dowISO(d);
    if (hol.has(d) && d !== M.today && w !== 0 && w !== 6) return { date: d, holiday: hol.get(d) };
  }
  assert.fail('no weekday nationwide holiday in the visible window');
}

/**
 * The Ferien table is BUNDLED placeholder data with a stated horizon
 * (FERIEN_META.horizon, currently 2028-08-31) — unlike Feiertage it cannot be
 * computed. Once the rolling window walks past that horizon there are no Ferien
 * to shade and these characterizations have nothing to observe. That is the
 * data expiring, not the renderer regressing, so they say so and stand down
 * rather than reporting a false failure. Replacing FERIEN with the real KMK
 * tables (see README) makes them run again with no edit here.
 */
/** Non-throwing form, for a test that still has plenty to assert without
 *  Ferien and should therefore weaken rather than stand down entirely. */
function ferienAvailable(s) { return !!(s.all.length && s.weekday && s.weekend); }

function requireFerien(s) {
  if (s.all.length && s.weekday && s.weekend) return true;
  // skip() reports a TAP `# SKIP` directive rather than a bare `ok`. A stood-
  // down test must be VISIBLE in the output — a suite that quietly stops
  // testing something is the exact failure mode this suite exists to prevent.
  skip(`bundled Schulferien table (horizon ${FERIEN_META.horizon}, verified=${FERIEN_META.verified}) no longer covers ${M.firstISO}…${M.lastISO}`);
}

/** Ferien days for a Bundesland, split by weekend, restricted to the window.
 *
 *  `weekday`/`weekend` must EXCLUDE today, on the same rule `plainDate()` and
 *  `holidayDate()` above already apply. The window begins on today, so the
 *  first Ferien weekday in it *is* today whenever the run happens to fall
 *  inside a Sommerferien — and Today's own tint deliberately outranks `.fer`
 *  (that rule has its own test, 8.1 · "Today beats a weekend inside Ferien").
 *  Sampling today here characterised the Today rule a second time under the
 *  wrong name, and turned 7.2 into a test whose answer depends on the date it
 *  is run. `all` stays complete: every Ferien day, today included, must shade. */
function ferienSample(stateCode) {
  const idx = ferienIndex(stateCode, 'de');
  const inWin = WINDOW_DATES.filter((d) => idx.has(d));
  const plain = inWin.filter((d) => d !== M.today);
  const weekday = plain.find((d) => { const w = dowISO(d); return w !== 0 && w !== 6; });
  const weekend = plain.find((d) => { const w = dowISO(d); return w === 0 || w === 6; });
  return { idx, all: inWin, weekday, weekend };
}

diag(`window ${M.firstISO} … ${M.lastISO} · today ${M.today} · rowH ${M.rowH} · capacity ${M.capacity}`);

// ═════════════════════════════════════════════════════════════════════════════
// 1.2 / 1.4 — the grid: columns, headers, day rows
// ═════════════════════════════════════════════════════════════════════════════

test('1.1/1.2 · twelve columns, each headed by its own month, in order', () => {
  reset();
  const cols = $$('.board .col');
  assert.equal(cols.length, 12, 'the board is always twelve columns wide');
  const m = model();
  cols.forEach((col, i) => {
    const head = $('.col-head', col);
    assert.ok(head, 'column ' + i + ' has no header');
    assert.equal(head.textContent, m.cols[i].label, 'header label of column ' + i);
    assert.equal(head.title, m.cols[i].fullLabel, 'the unabbreviated month is one hover away');
    assert.equal(col.dataset.month, m.cols[i].key);
    assert.equal(col.dataset.index, String(i));
  });
  // 1.A — labels are "Monat ’YY": the FULL month name (the reference format the story names,
  // e.g. „August ’26") plus a two-digit year carried by every column, so a window that straddles
  // New Year never leaves the reader guessing. Was `{3}` — the three-letter abbreviation v1 used.
  for (const c of cols) assert.match($('.col-head', c).textContent, /^[A-Za-zÄÖÜäöü]{3,10} ’\d\d$/);
  // Chronological, with no gaps: each key is exactly one month after the last.
  const keys = cols.map((c) => c.dataset.month);
  for (let i = 1; i < keys.length; i++) {
    const prev = parseISO(keys[i - 1] + '-01');
    const cur = parseISO(keys[i] + '-01');
    assert.equal(cur.y * 12 + cur.m, prev.y * 12 + prev.m + 1, 'gap before ' + keys[i]);
  }
});

test('1.2 · 372 day rows: one per calendar day, the rest padded as .void', () => {
  reset();
  assert.equal($$('.board .day').length, 372, '12 × 31 rows are always laid out');
  const m = model();
  let dated = 0;
  m.cols.forEach((c, i) => {
    const col = $$('.board .col')[i];
    const rows = $$('.day', col);
    assert.equal(rows.length, 31, c.key + ': every column is 31 rows tall');
    const len = daysInMonth(c.y, c.m);
    assert.equal(len, c.len);
    dated += len;
    assert.equal($$('.day[data-date]', col).length, len, c.key + ' dated rows');
    assert.equal($$('.day.void', col).length, 31 - len, c.key + ' padded rows');
    // Padding is always at the BOTTOM — day alignment across columns (1.6) is
    // the whole reason the board reads as a grid.
    rows.forEach((r, ri) => {
      if (ri < len) {
        assert.equal(r.dataset.date, iso(c.y, c.m, ri + 1), c.key + ' row ' + ri);
        assert.ok(!r.classList.contains('void'));
      } else {
        assert.ok(r.classList.contains('void'), c.key + ' row ' + ri + ' should be void');
        assert.equal(r.dataset.date, undefined, 'a void row is not addressable');
      }
    });
  });
  assert.equal($$('.board .day[data-date]').length, dated);
  assert.ok(dated === 365 || dated === 366, 'a rolling year is 365 or 366 days, got ' + dated);
});

test('1.2 · February obeys the leap rule, in the DOM', () => {
  reset();
  const febs = model().cols.filter((c) => c.m === 2);
  assert.ok(febs.length >= 1, 'a 12-month window always contains a February');
  for (const f of febs) {
    const col = $(`.board .col[data-month="${f.key}"]`);
    const leap = (f.y % 4 === 0 && f.y % 100 !== 0) || f.y % 400 === 0;
    assert.equal($$('.day[data-date]', col).length, leap ? 29 : 28, f.key);
    assert.equal($$('.day.void', col).length, leap ? 2 : 3, f.key + ' padding');
    assert.equal(!!$(`.day[data-date="${f.y}-02-29"]`), leap, f.y + ' Feb 29');
  }
});

test('1.2 · every row carries a zero-padded number and a weekday abbreviation', () => {
  reset();
  const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  for (const row of $$('.board .day[data-date]')) {
    const date = row.dataset.date;
    const num = $('.d-num', row);
    const wd = $('.d-wd', row);
    assert.ok(num && wd, 'missing number/weekday on ' + date);
    assert.equal(num.textContent, p2(parseISO(date).d), date + ' day number');
    assert.equal(num.textContent.length, 2, 'zero-padded, so the column stays aligned');
    assert.equal(wd.textContent, WD[dowISO(date)], date + ' weekday');
  }
  // The number sits before the weekday, which sits before the entry body —
  // the printed-Jahresplaner reading order (1.2).
  const sample = dayNode(plainDate());
  const order = [...sample.children].map((n) => n.className);
  assert.equal(order[0], 'd-num');
  assert.equal(order[1], 'd-wd');
  assert.includes(order, 'd-body');
  assert.equal($$('.board .day.void .d-num').length, 0, 'void rows carry no number');
});

test('1.2 · weekends are shaded, plain weekdays are not, void rows have their own tone', () => {
  reset();
  const m = model();
  const weekend = m.cols.flatMap((c) => c.days.filter((d) => !d.empty && d.weekend).map((d) => d.date));
  assert.ok(weekend.length > 100, 'a year has ~104 weekend days, got ' + weekend.length);
  assert.equal($$('.board .day.we').length, weekend.length);
  for (const d of weekend) {
    assert.ok(dayNode(d).classList.contains('we'), d + ' is Sat/Sun but not shaded');
  }
  // and nothing else is marked as a weekend
  for (const node of $$('.board .day.we')) {
    const w = dowISO(node.dataset.date);
    assert.ok(w === 0 || w === 6, node.dataset.date + ' is shaded but is not a weekend');
  }
  // `x !== M.today` — WITHOUT IT THIS ROW FAILS EVERY SATURDAY AND SUNDAY.
  //
  // The window is rolling, so it STARTS at today: on a Saturday the first Saturday it finds is
  // today, and `app.css:265` gives `.day.day.today` its own `--bg-today` which correctly wins over
  // the weekend shade. The row then reports "Saturday" and looks like a rendering regression.
  // Caught on 2026-09-05, a Saturday, on CI and locally at the same moment — the second row in
  // this suite to read the wall clock without saying so (the first was fixed earlier the same
  // week). `plainDate()` above has always had this exclusion; these two lines did not, and the
  // asymmetry is the entire defect.
  //
  // The non-vacuity assertions matter as much as the exclusion: a `find` that returns undefined
  // would make `dayNode(undefined)` throw somewhere unhelpful instead of saying what is missing.
  const notToday = (d) => d !== m.today;
  const sat = weekend.filter(notToday).find((d) => dowISO(d) === 6);
  const sun = weekend.filter(notToday).find((d) => dowISO(d) === 0);
  assert.ok(sat, 'no Saturday other than today in the visible window');
  assert.ok(sun, 'no Sunday other than today in the visible window');
  assert.equal(bg(dayNode(sat)), SHADE.weekend, 'Saturday');
  assert.equal(bg(dayNode(sun)), SHADE.weekend, 'Sunday');
  assert.equal(bg(dayNode(plainDate())), SHADE.none, 'a plain weekday carries no fill');
  assert.equal(bg($('.board .day.void')), SHADE.void, 'void rows are their own, quieter tone');
});

test('1.4 · month headers are sticky and stay pinned while the board scrolls', async () => {
  reset();
  const head = $('.board .col .col-head');
  const pos = getComputedStyle(head).position;
  assert.ok(pos === 'sticky' || pos === '-webkit-sticky', 'header position: ' + pos);
  assert.equal(getComputedStyle(head).top, '0px');
  // z-index above the day rows, or a scrolled row would slide over the label.
  assert.equal(getComputedStyle(head).zIndex, '3');
  assert.ok(Number(getComputedStyle($('.board .bar, .board .day')).zIndex || 0) < 3 ||
            getComputedStyle($('.board .day')).zIndex === 'auto');

  const wrap = wrapEl();
  if (wrap.scrollHeight > wrap.clientHeight + 20) {
    const wrapTop = wrap.getBoundingClientRect().top;
    const before = head.getBoundingClientRect().top;
    wrap.scrollTop = 60;
    await sleep(0);
    void document.body.offsetHeight;
    const after = head.getBoundingClientRect().top;
    assert.ok(Math.abs(after - wrapTop) <= 1.5,
      `header should pin to the scroller top (${after} vs ${wrapTop})`);
    assert.ok(after >= before - 1.5, 'the header did not scroll away with the rows');
    wrap.scrollTop = 0;
    await sleep(0);
  } else {
    diag('1.4: viewport is tall enough to show all 31 rows — vertical pin asserted from CSS only');
  }
});

test('1.4 · the board scrolls horizontally instead of shrinking its columns', async () => {
  reset();
  const wrap = wrapEl();
  const board = boardEl();
  assert.equal(getComputedStyle(wrap).overflowX, 'auto');
  // getComputedStyle resolves `width` to pixels, so the intrinsic sizing has to
  // be read off the rule itself: the board is `max-content`, i.e. columns keep
  // their width and the board grows past the window rather than compressing.
  const boardRule = (await rulesOf('app.css')).find((r) => r.selectorText === '.board');
  assert.ok(boardRule, '.board rule missing from app.css');
  assert.equal(boardRule.style.getPropertyValue('width').trim(), 'max-content');
  assert.equal(boardRule.style.getPropertyValue('min-width').trim(), '100%');
  assert.equal(getComputedStyle($('.board .col')).flexShrink, '0', 'columns never flex-shrink');
  const colW = Number(cssVar('--col-w').replace('px', ''));
  assert.equal(colW, store.state.settings.colWidth || 118);
  for (const c of $$('.board .col')) {
    assert.equal(Math.round(c.getBoundingClientRect().width), colW, c.dataset.month + ' column width');
  }
  // 12 columns + the board's 8px side padding — never less, whatever the window.
  assert.ok(board.scrollWidth >= colW * 12, `board ${board.scrollWidth} < ${colW * 12}`);

  const headTop = $('.board .col-head').getBoundingClientRect().top;
  wrap.scrollLeft = 200;
  await sleep(0);
  assert.ok(wrap.scrollLeft > 0 || wrap.scrollWidth <= wrap.clientWidth,
    'the wrapper is the horizontal scroller');
  assert.ok(Math.abs($('.board .col-head').getBoundingClientRect().top - headTop) <= 1,
    'headers stay pinned vertically while the board pans sideways');
  wrap.scrollLeft = 0;
  await sleep(0);
});

test('1.2 · row height is a variable, honoured live at both extremes', async () => {
  reset();
  assert.equal(cssVar('--row-h'), `${model().rowH}px`);
  assert.match($('.board .rows').style.height, /^calc\(var\(--row-h\) \* 31\)$/,
    'row geometry is calc() against the variable — never resolved pixels');
  for (const h of [18, 22, 32]) {
    await withSettings({ rowHeight: h }, () => {
      assert.equal(cssVar('--row-h'), `${h}px`);
      assert.equal(Math.round(dayNode(plainDate()).getBoundingClientRect().height), h,
        'day row height at rowHeight ' + h);
      assert.equal(Math.round($('.board .rows').getBoundingClientRect().height), h * 31,
        'the 31-row block at rowHeight ' + h);
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 7.x — Ferien shading and the overlap with weekends (challenge 4 / option 1j)
// ═════════════════════════════════════════════════════════════════════════════

test('7.2 · Schulferien shade their days and name themselves on hover', async () => {
  reset();
  const s = ferienSample('BY');
  requireFerien(s);
  await withSettings({ bundesland: 'BY', layers: { schulferien: true, feiertage: false } }, () => {
    assert.equal($$('.board .day.fer').length, s.all.length, 'one .fer row per Ferien day');
    for (const d of s.all) {
      const node = dayNode(d);
      assert.ok(node.classList.contains('fer'), d + ' should be shaded');
      assert.equal(node.title, s.idx.get(d), d + ': the period name is one hover away (7.2)');
    }
    assert.equal(bg(dayNode(s.weekday)), SHADE.ferien, 'a weekday in Ferien');
  });
  // The layer is a toggle, not a permanent tint.
  assert.equal($$('.board .day.fer').length, 0, 'layer off → no shading at all');
});

test('7.5 · Schulferien without a Bundesland shade nothing, even when switched on', async () => {
  reset();
  await withSettings({ bundesland: '', layers: { schulferien: true } }, () => {
    assert.equal($$('.board .day.fer').length, 0,
      'a Ferien layer with no state cannot mean anything');
  });
});

test('challenge 4 · weekend, Ferien and their overlap are three separable shades', async () => {
  reset();
  const s = ferienSample('BY');
  requireFerien(s);
  await withSettings({ bundesland: 'BY', layers: { schulferien: true, feiertage: false } }, () => {
    const both = dayNode(s.weekend);
    assert.ok(both.classList.contains('we') && both.classList.contains('fer'));
    assert.equal(bg(both), SHADE.weekendFerien, 'the overlap gets its OWN value…');
    assert.notEqual(SHADE.weekendFerien, SHADE.weekend);
    assert.notEqual(SHADE.weekendFerien, SHADE.ferien);
    // …and it is the darkest of the three, so "weekend inside Ferien" reads as
    // more, not as a third unrelated colour.
    const lum = (rgb) => rgb.match(/\d+/g).slice(0, 3).reduce((a, b) => a + Number(b), 0);
    assert.ok(lum(SHADE.weekendFerien) < lum(SHADE.weekend));
    assert.ok(lum(SHADE.weekend) < lum(SHADE.ferien));
  });
});

test('option 1k · the Ferien hatch is a second channel, off by default', async () => {
  reset();
  const s = ferienSample('BY');
  requireFerien(s);
  await withSettings({ bundesland: 'BY', layers: { schulferien: true, feiertage: false } }, () => {
    assert.equal(getComputedStyle(dayNode(s.weekday)).backgroundImage, 'none',
      'hatch off by default — it adds noise behind 9px text');
  });
  await withSettings(
    { bundesland: 'BY', layers: { schulferien: true, feiertage: false, ferienPattern: true } },
    () => {
      assert.ok(document.body.classList.contains('ferien-hatch'));
      assert.match(getComputedStyle(dayNode(s.weekday)).backgroundImage, /repeating-linear-gradient/,
        'texture next to brightness (challenge 4)');
      // A weekend in Ferien keeps the weekend VALUE and adds the texture, so
      // the two channels do not collapse into one.
      assert.equal(getComputedStyle(dayNode(s.weekend)).backgroundColor, SHADE.weekend);
      assert.match(getComputedStyle(dayNode(s.weekend)).backgroundImage, /repeating-linear-gradient/);
    }
  );
  assert.ok(!document.body.classList.contains('ferien-hatch'), 'setting restored');
});

// ═════════════════════════════════════════════════════════════════════════════
// 6.x — holidays inline, and the capacity-1 demotion (challenge 2)
// ═════════════════════════════════════════════════════════════════════════════

test('6.1 · a holiday writes its name into the day row and tints the number', () => {
  reset();
  const { date, holiday } = holidayDate();
  const row = dayNode(date);
  assert.ok(row.classList.contains('hol'), date + ' should be marked as a holiday');
  const chip = $('.d-hol', row);
  assert.ok(chip, 'the poster writes its holidays out (6.1)');
  assert.equal(chip.textContent, holiday.short);
  assert.equal(chip.title, holiday.name, 'the full name is one hover away');
  assert.ok(!chip.classList.contains('foreign'), 'a nationwide holiday is not dimmed');
  assert.equal($('.d-holdot', row), null, 'no gutter dot while the chip is there');
  assert.equal(row.title, '', 'no tooltip is needed while the text is visible');
  // The chip lives in the entry body, above where notes go — it is content on
  // the row, not a badge in the gutter.
  assert.equal($('.d-body', row).firstChild, chip);
  assert.equal(getComputedStyle($('.d-num', row)).fontWeight, '700', 'holiday numbers are bolder');
});

test('challenge 2 · at capacity ≥ 2 the holiday keeps line 1 and the note takes line 2', async () => {
  reset();
  const { date, holiday } = holidayDate();
  addNote({ id: 'dr-share', date, text: 'Brunch bei Oma', categoryId: store.state.categories[0].id, repeatsYearly: false });
  await withSettings({ rowHeight: 22 }, () => {
    assert.equal(model().capacity, 2, 'rowHeight 22 → two lines');
    const row = dayNode(date);
    const body = $('.d-body', row);
    assert.equal(body.children.length, 2);
    assert.equal(body.children[0].className, 'd-hol', 'holiday first…');
    assert.equal(body.children[0].title, holiday.name);
    assert.equal(body.children[1].dataset.noteId, 'dr-share', '…note second');
    assert.equal($('.d-holdot', row), null, 'no demotion at capacity 2');
    assert.equal($('.d-more', row), null, 'nothing overflowed');
  });
  reset();
});

test('challenge 2 · at capacity 1 the note wins and the holiday demotes — it never vanishes', async () => {
  reset();
  const { date, holiday } = holidayDate();
  addNote({ id: 'dr-demote', date, text: 'Zahnarzt', categoryId: store.state.categories[0].id, repeatsYearly: false });
  await withSettings({ rowHeight: 18 }, () => {
    assert.equal(model().capacity, 1, 'rowHeight 18 → one line');
    const row = dayNode(date);
    assert.equal($('.d-hol', row), null, 'the chip yields to the user');
    assert.equal($$('.note', row).length, 1, 'the user always wins the line');
    assert.equal($('.note', row).textContent, 'Zahnarzt');
    // …but all three demotion tells are present:
    assert.ok($('.d-holdot', row), '(1) a 3px gutter dot before the text');
    assert.ok(row.classList.contains('hol'), '(2) the row is still a holiday row…');
    assert.equal(getComputedStyle($('.d-num', row)).fontWeight, '700', '    …with a bolder number');
    assert.equal(row.title, holiday.name, '(3) the name survives as a tooltip');
    assert.equal($('.d-more', row), null, 'a demoted holiday is not counted as overflow');
    // Order: the dot sits before the body, so it reads as a prefix to the text.
    const kids = [...row.children].map((n) => n.className);
    assert.ok(kids.indexOf('d-holdot') < kids.indexOf('d-body'));
  });
  reset();
});

test('challenge 2 · at capacity 1 with no note the holiday still takes the line', async () => {
  reset();
  const { date, holiday } = holidayDate();
  await withSettings({ rowHeight: 18 }, () => {
    const row = dayNode(date);
    assert.equal(model().capacity, 1);
    assert.ok($('.d-hol', row), 'nobody claimed the row, so the holiday keeps it');
    assert.equal($('.d-hol', row).textContent, holiday.short);
    assert.equal($('.d-holdot', row), null);
  });
});

test('7.2 · a demoted holiday inside Ferien joins both names in one tooltip', async () => {
  reset();
  const s = ferienSample('BY');
  const hol = ownHolidays('BY');
  const date = s.all.find((d) => hol.has(d));
  if (!date) skip('no BY holiday falls inside BY Ferien in this window');
  addNote({ id: 'dr-both', date, text: 'x', categoryId: store.state.categories[0].id, repeatsYearly: false });
  await withSettings({ rowHeight: 18, bundesland: 'BY', layers: { schulferien: true, feiertage: true } }, () => {
    const row = dayNode(date);
    assert.equal(row.title, `${s.idx.get(date)} · ${hol.get(date).name}`,
      'Ferien period first, demoted holiday second, one separator');
  });
  reset();
});

// ═════════════════════════════════════════════════════════════════════════════
// 8.1 — Today wins, by specificity (the audit fix)
// ═════════════════════════════════════════════════════════════════════════════

test('8.1 · exactly one row is today, and it owns a 3px ink rule in the gutter', () => {
  reset();
  const rows = $$('.board .day.today');
  assert.equal(rows.length, 1, 'exactly one Today row');
  assert.equal(rows[0].dataset.date, model().today);
  assert.equal(bg(rows[0]), SHADE.today);
  // The marker is a pseudo-element on the gutter edge, not a competing fill —
  // that is what lets it survive on top of every ambient shade.
  const before = getComputedStyle(rows[0], '::before');
  assert.equal(before.content, '""', 'the ::before marker exists');
  assert.equal(before.width, '3px');
  assert.equal(before.backgroundColor, 'rgb(61, 33, 133)', '--ink-1, the strongest ink');
  // …and its month is flagged, so Today is findable while scrolled away.
  const cols = $$('.board .col.is-today-month');
  assert.equal(cols.length, 1);
  assert.equal(cols[0].dataset.month, model().today.slice(0, 7));
  assert.equal(getComputedStyle($('.col-head', cols[0]), '::after').content, '""',
    'the today-month header carries the accent dot');
  assert.equal($$('.board .col:not(.is-today-month) .col-head')
    .filter((h) => getComputedStyle(h, '::after').content === '""').length, 0);
});

test('8.1 · Today beats a weekend inside Ferien — the `.day.day.today` fix', async () => {
  reset();
  // Proof the rule is needed: without .today, .we.fer wins on specificity.
  const s = ferienSample('BY');
  await withSettings({ bundesland: 'BY', layers: { schulferien: true } }, () => {
    if (s.weekend) assert.equal(bg(dayNode(s.weekend)), SHADE.weekendFerien);
  });

  // The launch-day case: force the ambient classes onto the real Today row.
  // (buildBoard's `today` is the wall clock; the shading question is pure CSS.)
  const row = $('.board .day.today');
  const had = { we: row.classList.contains('we'), fer: row.classList.contains('fer') };
  try {
    row.classList.add('we', 'fer');
    assert.equal(bg(row), SHADE.today, 'Today must outrank .day.we.fer');
    row.classList.remove('fer');
    assert.equal(bg(row), SHADE.today, 'Today must outrank .day.we');
    row.classList.remove('we');
    row.classList.add('fer', 'hol');
    assert.equal(bg(row), SHADE.today, 'Today must outrank .day.fer');
  } finally {
    row.classList.remove('we', 'fer', 'hol');
    if (had.we) row.classList.add('we');
    if (had.fer) row.classList.add('fer');
    redraw();
  }
});

test('8.1 · the doubled-class rule is in the stylesheet, hover included', async () => {
  const rules = await rulesOf('app.css');
  const sels = rules.filter((r) => r.type === CSSRule.STYLE_RULE).map((r) => r.selectorText);
  const todayRule = sels.find((s) => s.includes('.day.day.today'));
  assert.ok(todayRule, 'the audit fix `.day.day.today` is gone from app.css');
  assert.includes(todayRule, '.day.day.today:hover',
    'hover must be doubled too, or pointing at Today un-highlights it');
  const r = rules.find((x) => x.selectorText === todayRule);
  assert.equal(r.style.getPropertyValue('background').trim(), 'var(--bg-today)');
  // The weaker single-class variants still exist and are what it has to beat.
  assert.ok(sels.includes('.day.we.fer'));
  assert.ok(sels.includes('.day.we'));
});

// ═════════════════════════════════════════════════════════════════════════════
// 2.1 – 2.4 — notes: created by the real gesture, shown in their day row
// ═════════════════════════════════════════════════════════════════════════════

test('2.1 · clicking a day and typing puts the note in that day row and nowhere else', () => {
  reset();
  const date = plainDate();
  const row = dayNode(date);
  assert.equal($$('.note', row).length, 0, 'the board starts bare');

  click(row);
  const inp = $('.board .inline-edit');
  assert.ok(inp, 'no dialog, an editor on the row itself (2.1)');
  assert.equal(inp.closest('.rows').dataset.month, date.slice(0, 7), 'editor is in the right column');
  assert.equal(inp.style.top, `calc(var(--row-h) * ${parseISO(date).d - 1} + 1px)`,
    'and on the right row, expressed in row units');
  typeAndEnter('Kickoff Nordwind');

  const notes = $$(`.board .day[data-date="${date}"] .note`);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].textContent, 'Kickoff Nordwind');
  assert.equal(notes[0].dataset.date, date);
  assert.equal(notes[0].title, 'Kickoff Nordwind', 'full text on hover (2.5)');
  assert.equal($$('.board .note').length, 1, 'it appears exactly once on the whole board');
  assert.equal($('.board .inline-edit'), null, 'Enter closed the editor');
  reset();
});

test('2.1 · Escape leaves no note and no editor behind', () => {
  reset();
  const date = plainDate();
  click(dayNode(date));
  const inp = $('.board .inline-edit');
  inp.value = 'verworfen';
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal($('.board .inline-edit'), null);
  assert.equal($$('.board .note').length, 0, 'Escape cancels (2.1)');
  assert.equal($('.board .cat-strip'), null, 'the swatch strip goes with it');
});

test('2.3 · a day holds several notes, stacked in the row, truncating rather than wrapping', () => {
  reset();
  const date = plainDate();
  const cat = store.state.categories[2]; // Reisen / orange
  addNote({ id: 'dr-n1', date, text: 'Kanufahrt auf der Lahn mit dem ganzen Verein', categoryId: cat.id, repeatsYearly: false });
  addNote({ id: 'dr-n2', date, text: 'Rückfahrt', categoryId: store.state.categories[0].id, repeatsYearly: false });
  const row = dayNode(date);
  const notes = $$('.note', row);
  assert.equal(notes.length, 2, 'capacity 2 at the default row height');
  assert.equal(notes[0].dataset.noteId, 'dr-n1');
  assert.equal(notes[1].dataset.noteId, 'dr-n2');
  assert.equal(notes[0].style.color, 'rgb(217, 130, 15)', 'notes render in their category tone (2.5)');
  assert.equal(notes[1].style.color, 'rgb(42, 124, 192)');
  // Graceful truncation, not wrapping: the row height must not move.
  const cs = getComputedStyle(notes[0]);
  assert.equal(cs.whiteSpace, 'nowrap');
  assert.equal(cs.textOverflow, 'ellipsis');
  assert.equal(cs.overflow, 'hidden');
  assert.ok(notes[0].scrollWidth > notes[0].clientWidth, 'the long text really is clipped');
  assert.equal(Math.round(row.getBoundingClientRect().height), model().rowH,
    'a full day row is exactly as tall as an empty one (1.6)');
  assert.equal($('.d-more', row), null, 'two notes at capacity 2 is not overflow');
  reset();
});

test('2.4 · a crowded day shows capacity notes plus a +n chip — never a silent drop', async () => {
  reset();
  const date = plainDate();
  const cat = store.state.categories[0].id;
  for (let i = 1; i <= 5; i++) {
    addNote({ id: 'dr-c' + i, date, text: 'Termin ' + i, categoryId: cat, repeatsYearly: false });
  }
  for (const h of [18, 22, 32]) {
    await withSettings({ rowHeight: h }, () => {
      const cap = model().capacity;
      const row = dayNode(date);
      const shown = $$('.note', row);
      assert.equal(shown.length, cap, `rowHeight ${h} → ${cap} visible notes`);
      const chip = $('.d-more', row);
      assert.ok(chip, 'the remainder is announced');
      assert.equal(chip.textContent, `+${5 - cap}`);
      assert.equal(chip.dataset.date, date);
      assert.equal(chip.title, `${5 - cap} weitere`);
      // The first `cap` notes in store order are the ones that stay.
      assert.deepEqual(shown.map((n) => n.dataset.noteId),
        [1, 2, 3, 4, 5].slice(0, cap).map((i) => 'dr-c' + i));
      assert.equal(getComputedStyle(chip).cursor, 'pointer', 'the chip is a control');
    });
  }
  reset();
});

test('2.4 · clicking the +n chip opens the popover with the FULL stack', () => {
  reset();
  const date = plainDate();
  const cat = store.state.categories[0].id;
  for (let i = 1; i <= 4; i++) {
    addNote({ id: 'dr-p' + i, date, text: 'Eintrag ' + i, categoryId: cat, repeatsYearly: false });
  }
  const chip = $(`.board .day[data-date="${date}"] .d-more`);
  assert.equal(chip.textContent, '+2');
  click(chip);
  const pop = $('.popover');
  assert.ok(pop, 'no popover opened');
  const texts = $$('.pop-row .txt', pop).map((n) => n.textContent);
  for (let i = 1; i <= 4; i++) {
    assert.includes(texts, 'Eintrag ' + i, 'the popover must list every note, incl. the hidden ones');
  }
  assert.equal($$('.pop-row .dot', pop).length, 4, 'each row carries its category dot (2.4)');
  document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 2, clientY: 2 }));
  reset();
  assert.equal($('.popover'), null, 'popover closed on outside press');
});

test('2.x · a hidden category takes its notes off the board entirely (4.6 / 12.3)', () => {
  reset();
  const date = plainDate();
  const cat = store.state.categories[1];
  addNote({ id: 'dr-hid', date, text: 'versteckt', categoryId: cat.id, repeatsYearly: false });
  assert.ok($('.board .note[data-note-id="dr-hid"]'));
  store.mutate('dom-rendering:hide', () => { cat.visible = false; });
  redraw();
  assert.equal($('.board .note[data-note-id="dr-hid"]'), null, 'not rendered, not merely dimmed');
  assert.equal($(`.board .day[data-date="${date}"] .d-more`), null,
    'a hidden entry does not inflate the +n count either');
  reset();
  assert.ok($('.board .note[data-note-id="dr-hid"]') === null);
});

// ═════════════════════════════════════════════════════════════════════════════
// 3.2 / 3.6 — bars: the month split and the horizon
// ═════════════════════════════════════════════════════════════════════════════

test('3.1/3.2 · dragging down a column lays a bar; crossing a month splits it', () => {
  reset();
  const m = model();
  const c0 = m.cols[0];
  const c1 = m.cols[1];
  const from = iso(c0.y, c0.m, Math.max(1, c0.len - 3));
  const to = iso(c1.y, c1.m, 4);
  const fromNode = dayNode(from);
  const toNode = dayNode(to);
  fromNode.scrollIntoView({ block: 'center' });
  drag(fromNode, toNode);

  // A fresh bar goes straight into naming (3.3) — give it a label.
  typeAndEnter('Umbau Küche');

  const bars = store.state.bars;
  assert.equal(bars.length, 1, 'the drag created exactly one entry');
  const b = bars[0];
  assert.equal(b.startDate, from, 'start anchored where the press began');
  assert.equal(b.endDate, to, 'end where the pointer was released');
  assert.equal(b.label, 'Umbau Küche');

  // 3.2 — one entry, two columns.
  const stripes = $$(`.board .bar[data-bar-id="${b.id}"]`);
  const labels = $$(`.board .bar-label[data-bar-id="${b.id}"]`);
  assert.equal(stripes.length, 2, 'one stripe per column crossed');
  assert.equal(labels.length, 2, 'the label repeats once per segment (3.7)');
  assert.equal(stripes[0].closest('.col').dataset.month, c0.key);
  assert.equal(stripes[1].closest('.col').dataset.month, c1.key);
  // Same colour, same lane, same title on both halves — one entry, not two.
  assert.equal(stripes[0].style.background, stripes[1].style.background);
  assert.equal(stripes[0].dataset.lane, stripes[1].dataset.lane);
  assert.equal(stripes[0].title, stripes[1].title);
  assert.includes(stripes[0].title, 'Umbau Küche');
  assert.includes(stripes[0].title, `${from} – ${to}`);

  // The continuation prefix: only the entered-from-above half wears "↑ ".
  assert.equal($('.cue', labels[0]), null, 'the starting month has no cue');
  assert.ok($('.cue', labels[1]), 'the continuation month is marked');
  assert.equal($('.cue', labels[1]).textContent, '↑ ');
  assert.match(labels[1].textContent, /^↑\s*Umbau Küche$/);
  assert.equal(labels[0].textContent, 'Umbau Küche');

  // Grips live only at the real ends, so dragging the September half can never
  // reshape the August edge.
  assert.equal($$(`.board .bar[data-bar-id="${b.id}"] .bar-handle.top`).length, 1);
  assert.equal($$(`.board .bar[data-bar-id="${b.id}"] .bar-handle.bottom`).length, 1);
  assert.ok($('.bar-handle.top', stripes[0]), 'top grip on the first segment');
  assert.equal($('.bar-handle.bottom', stripes[0]), null);
  assert.equal($('.bar-handle.top', stripes[1]), null);
  assert.ok($('.bar-handle.bottom', stripes[1]), 'bottom grip on the last segment');

  // Segment geometry is stated in row units against the same variables the day
  // rows use — which is what keeps a stripe aligned with its dates (and lets
  // print re-metric it).
  assert.equal(stripes[0].style.top, `calc(var(--row-h) * ${parseISO(from).d - 1} + 1px)`);
  assert.equal(stripes[0].style.height, `calc(var(--row-h) * ${c0.len - parseISO(from).d + 1} - 3px)`);
  assert.equal(stripes[1].style.top, 'calc(var(--row-h) * 0 + 1px)');
  assert.equal(stripes[1].style.height, `calc(var(--row-h) * ${parseISO(to).d} - 3px)`);
  reset();
});

test('3.2 · a bar spanning three months wears one stripe and one label per month', () => {
  reset();
  const m = model();
  const start = `${m.cols[1].key}-20`;
  const end = `${m.cols[3].key}-10`;
  addBar({ id: 'dr-three', startDate: start, endDate: end, label: 'Projekt Nordwind', categoryId: store.state.categories[0].id });
  const stripes = $$('.board .bar[data-bar-id="dr-three"]');
  const labels = $$('.board .bar-label[data-bar-id="dr-three"]');
  assert.equal(stripes.length, 3);
  assert.equal(labels.length, 3);
  assert.deepEqual(stripes.map((s) => s.closest('.col').dataset.month),
    [m.cols[1].key, m.cols[2].key, m.cols[3].key]);
  // The middle month is a continuation at BOTH ends: no grips, but it still
  // gets the ↑ prefix, because "this started earlier" is the reader's question.
  assert.equal($('.bar-handle.top', stripes[1]), null);
  assert.equal($('.bar-handle.bottom', stripes[1]), null);
  assert.equal($('.cue', labels[0]), null);
  assert.equal($('.cue', labels[1]).textContent, '↑ ');
  assert.equal($('.cue', labels[2]).textContent, '↑ ');
  // The full month in the middle covers all 31 slots of its column.
  assert.equal(stripes[1].style.top, 'calc(var(--row-h) * 0 + 1px)');
  assert.equal(stripes[1].style.height, `calc(var(--row-h) * ${m.cols[2].len} - 3px)`);
  // One lane for the whole life of the bar — no sideways jump at the split.
  assert.equal(new Set(stripes.map((s) => s.dataset.lane)).size, 1);
  reset();
});

test('3.7 · each segment label sits on a row that carries no ink of its own', () => {
  reset();
  const m = model();
  const key = m.cols[2].key;
  const cat = store.state.categories[0].id;
  addBar({ id: 'dr-lab', startDate: `${key}-05`, endDate: `${key}-20`, label: 'Sprint', categoryId: cat });
  addNote({ id: 'dr-lab-n', date: `${key}-05`, text: 'belegt', categoryId: cat, repeatsYearly: false });
  const lab = $('.board .bar-label[data-bar-id="dr-lab"]');
  const row = Number(lab.dataset.row);
  assert.ok(row >= 4, 'the label stays inside its segment');
  assert.notEqual(row, 4, 'row 5 (index 4) carries a note, so the chip moved off it');
  const landed = $$('.board .col')[2].querySelectorAll('.day')[row];
  assert.equal($$('.note', landed).length, 0, 'the chip never covers the user’s own ink');
  assert.equal($('.d-hol', landed), null);
  assert.equal(lab.style.top,
    `calc(var(--row-h) * ${row} + (var(--row-h) - 11px) / 2)`);
  reset();
});

test('3.6 · a bar running past the last column says so twice: on the stripe and under it', () => {
  reset();
  const m = model();
  addBar({ id: 'dr-far', startDate: `${m.cols[10].key}-01`, endDate: '2099-01-01', label: 'Endlos', categoryId: store.state.categories[0].id });
  const last = $$('.board .col')[11];
  const cue = $('.bar-cont-down', last);
  assert.ok(cue, 'the ↓ lives on the stripe, where the eye already is');
  assert.equal(cue.textContent, '↓');
  assert.equal(cue.style.color, 'rgb(42, 124, 192)', 'it carries the bar’s own colour');
  const foot = $('.horizon-cue', last);
  assert.ok(foot, 'and the column footer spells it out');
  assert.equal(foot.textContent, 'läuft weiter →');
  assert.equal($$('.board .horizon-cue').length, 1, 'only the column that actually runs out');
  assert.equal($$('.board .bar-cont-down').length, 1);
  assert.equal($('.bar-cont-up', last), null, 'this one did not start before the view');
  // It is a cue, not a control.
  assert.equal(getComputedStyle(cue).pointerEvents, 'none');
  reset();
  assert.equal($('.board .horizon-cue'), null, 'the cue goes when the bar goes');
});

test('3.6 · mirrored — a bar that began before the window gets a ↑ on the first column', () => {
  reset();
  const m = model();
  addBar({ id: 'dr-past', startDate: '2000-01-01', endDate: `${m.cols[0].key}-15`, label: 'Altlast', categoryId: store.state.categories[1].id });
  const first = $$('.board .col')[0];
  const cue = $('.bar-cont-up', first);
  assert.ok(cue, 'the mirrored cue (DESIGN-DECISIONS · C)');
  assert.equal(cue.textContent, '↑');
  assert.equal(cue.style.color, 'rgb(93, 158, 51)', 'the category’s own tone');
  assert.equal(cue.style.top, 'calc(var(--row-h) * 0 + 1px)', 'at the top of the segment');
  assert.equal($('.horizon-cue', first), null, '"läuft weiter →" is the forward case only');
  assert.equal($$('.board .bar-cont-up').length, 1);
  // It has no top grip — the real start is off-board, so it must not be draggable.
  assert.equal($('.bar[data-bar-id="dr-past"] .bar-handle.top', first), null);
  assert.ok($('.bar[data-bar-id="dr-past"] .bar-handle.bottom', first));
  reset();
});

test('3.6 · a bar that swallows the entire window is cued at both ends at once', () => {
  reset();
  addBar({ id: 'dr-both', startDate: '2000-01-01', endDate: '2099-01-01', label: 'Ewig', categoryId: store.state.categories[0].id });
  assert.equal($$('.board .bar[data-bar-id="dr-both"]').length, 12, 'a stripe in every column');
  assert.equal($$('.board .bar-cont-up').length, 1, 'one ↑, on the first column');
  assert.equal($$('.board .bar-cont-down').length, 1, 'one ↓, on the last');
  assert.equal($('.bar-cont-up', $$('.board .col')[0]) !== null, true);
  assert.equal($('.bar-cont-down', $$('.board .col')[11]) !== null, true);
  assert.equal($$('.board .bar-handle').length, 0, 'neither real end is on the board');
  assert.equal($$('.board .horizon-cue').length, 1);
  reset();
});

test('3.8 · the fourth overlapping bar becomes a +n, and only where three coincide', () => {
  reset();
  const m = model();
  const key = m.cols[2].key;
  const cat = store.state.categories[0].id;
  for (let i = 0; i < 3; i++) {
    addBar({ id: 'dr-lane' + i, startDate: `${key}-05`, endDate: `${key}-25`, label: 'L' + i, categoryId: cat });
  }
  addBar({ id: 'dr-lane3', startDate: `${key}-10`, endDate: `${key}-12`, label: 'L3', categoryId: cat });
  const col = $$('.board .col')[2];
  assert.equal($$('.bar', col).length, 3, 'only three lanes are ever drawn');
  const chip = $(`.day[data-date="${key}-11"] .d-more`, col);
  assert.ok(chip, 'the hidden bar is announced on the days it covers');
  assert.equal(chip.textContent, '+1');
  assert.equal(chip.title, '1 weitere Balken', 'lane overflow names itself as bars, not notes');
  assert.equal($(`.day[data-date="${key}-13"] .d-more`, col), null,
    'and nowhere else — the cap is per DAY, not per bar lifetime');
  reset();
});

// ═════════════════════════════════════════════════════════════════════════════
// 12.1 – 12.4 (+ 15.4) — print: the same DOM, re-metricked for paper
// ═════════════════════════════════════════════════════════════════════════════

test('12.1/12.4 · the @page rule is injected and follows the paper setting', async () => {
  reset();
  applyPageRule();
  const st = document.getElementById('page-rule');
  assert.ok(st, 'print.js injects the rule @page cannot be selector-scoped into');
  assert.equal(st.textContent, '@page { size: A4 landscape; margin: 8mm; }');
  assert.ok(document.body.classList.contains('paper-a4'));
  await withSettings({ paper: 'a3' }, () => {
    assert.equal(document.getElementById('page-rule').textContent,
      '@page { size: A3 landscape; margin: 10mm; }');
    assert.ok(document.body.classList.contains('paper-a3'));
    assert.ok(!document.body.classList.contains('paper-a4'), 'the two paper classes are exclusive');
  });
  assert.equal(document.getElementById('page-rule').textContent,
    '@page { size: A4 landscape; margin: 8mm; }');
});

test('12.1 · A4 metrics re-metric the LIVE board and fit the 1062 × 733 content box', async () => {
  reset();
  await withPrintCSS(() => {
    assert.equal(cssVar('--col-w'), '118px', 'the :root screen value is untouched…');
    const colW = parseFloat(getComputedStyle(document.body).getPropertyValue('--col-w'));
    const rowH = parseFloat(getComputedStyle(document.body).getPropertyValue('--row-h'));
    assert.equal(colW, 88, '…and body.paper-a4 overrides it, between :root and the board');
    assert.equal(rowH, 20);

    const cols = $$('.board .col');
    assert.equal(cols.length, 12, 'all twelve columns print (12.1)');
    for (const c of cols) {
      assert.equal(Math.round(c.getBoundingClientRect().width), 88, c.dataset.month);
    }
    const rows = $$('.board .day');
    assert.equal(rows.length, 372);
    assert.equal(Math.round(rows[0].getBoundingClientRect().height), 20);

    // A4 landscape 297 × 210 mm, 8 mm margins → 1062.0 × 733.1 px @96dpi.
    const usedW = 88 * 12;
    assert.equal(usedW, 1056);
    assert.ok(usedW <= 1062, `${usedW}px of columns must fit 1062px`);
    const colH = cols[0].getBoundingClientRect().height;
    diag(`A4: colW 88 · rowH 20 · column height ${colH} · app height ${$('.app').getBoundingClientRect().height}`);
    // 16 (head) + 620 (31 × 20) + 14 (pad margin) + 34 (pad) = 684.
    // NOTE — body.paper-a4 declares `--head-h: 18px`, but print.css also sets
    // `.col-head { height: 16px }` for print unconditionally and that wins, so
    // the header is 16px and the token is dead on paper. Characterised as-is.
    assert.equal(Math.round($('.board .col-head').getBoundingClientRect().height), 16);
    assert.equal(Math.round(colH), 684, 'header + 31 rows + scratchpad');
    assert.ok(Math.round($('.board .rows').getBoundingClientRect().height) === 620);
    const appH = $('.app').getBoundingClientRect().height;
    // README records 731px measured with Ubuntu installed; the print header and
    // legend are set in pt against a font stack, so the exact total moves with
    // the available face. The invariant that matters is that it fits.
    assert.ok(appH <= 733, `the whole sheet is ${appH}px, budget is 733px`);
    assert.ok(appH > 640, 'and it is not collapsed: ' + appH);
  });
  assert.equal(Math.round($('.board .col').getBoundingClientRect().width), 118,
    'screen metrics come straight back');
});

test('12.1 · A3 is the same DOM at wall-poster metrics', async () => {
  reset();
  await withSettings({ paper: 'a3' }, () => withPrintCSS(() => {
    const colW = parseFloat(getComputedStyle(document.body).getPropertyValue('--col-w'));
    const rowH = parseFloat(getComputedStyle(document.body).getPropertyValue('--row-h'));
    assert.equal(colW, 126);
    assert.equal(rowH, 29);
    assert.equal($$('.board .col').length, 12, 'no second renderer — the same twelve columns');
    assert.equal(Math.round($('.board .col').getBoundingClientRect().width), 126);
    assert.equal(Math.round($('.board .day').getBoundingClientRect().height), 29);
    // A3 landscape 420 × 297 mm, 10 mm margins → 1512.0 × 1046.2 px @96dpi.
    assert.ok(126 * 12 <= 1512, 'columns fit the A3 content box');
    const colH = $('.board .col').getBoundingClientRect().height;
    diag(`A3: column height ${colH} · app height ${$('.app').getBoundingClientRect().height}`);
    // NOTE — `--head-h: 22px` is declared for body.paper-a3, but print.css also
    // sets `.col-head { height: 16px }` unconditionally inside @media print, and
    // that wins over the variable. So A3 headers are 16px, not 22px: the token
    // is dead on paper. Characterised, not corrected.
    assert.equal(Math.round(colH), 16 + 29 * 31 + 14 + 46, 'head 16 (not --head-h) + rows + pad 46');
    assert.equal(Math.round($('.board .col-head').getBoundingClientRect().height), 16);
    assert.ok($('.app').getBoundingClientRect().height <= 1046);
  }));
});

test('12.2 · every piece of UI leaves the sheet; the +n badge stays, because it is content', async () => {
  reset();
  const date = plainDate();
  const cat = store.state.categories[0].id;
  for (let i = 1; i <= 4; i++) {
    addNote({ id: 'dr-pr' + i, date, text: 'Termin ' + i, categoryId: cat, repeatsYearly: false });
  }
  addBar({ id: 'dr-pr-bar', startDate: date, endDate: addDays(date, 5), label: 'Balken', categoryId: cat });
  const chip = $(`.board .day[data-date="${date}"] .d-more`);
  assert.ok(chip);
  assert.equal(getComputedStyle($('.toolbar')).display, 'flex', 'chrome is there on screen');

  await withPrintCSS(() => {
    for (const sel of ['.titlebar', '.toolbar']) {
      assert.equal(getComputedStyle($(sel)).display, 'none', sel + ' must not print');
    }
    assert.equal(getComputedStyle($('.board .bar-handle')).display, 'none',
      'resize grips are an affordance paper cannot offer');
    // …but the entry colours stay (12.2).
    assert.equal($('.board .note').style.color, 'rgb(42, 124, 192)');
    assert.equal(getComputedStyle($('.board .bar')).backgroundColor, 'rgb(42, 124, 192)');
    // …and so does the count, because paper has no hover.
    assert.notEqual(getComputedStyle(chip).display, 'none', 'the +n badge prints (design note)');
    assert.equal(getComputedStyle(chip).cursor, 'default', 'it just loses its button affordance');
    assert.equal(getComputedStyle(chip).backgroundColor, 'rgba(0, 0, 0, 0)');
  });
  reset();
});

test('12.3/15.4 · the Today highlight is suppressed on paper, quiet tells included', async () => {
  reset();
  const today = $('.board .day.today');
  // This row asks what print does to a PLAIN today. Today is a real date, so on a
  // Saturday, a Sunday or a Ferien day the row also carries .we/.fer and print.css
  // rightly keeps it at that shade — which is the NEXT test's subject, and made this
  // one fail every weekend and every school holiday (E3-10). A suite that is red for
  // calendar reasons teaches everyone to ignore red, so the row states its own
  // premise instead of inheriting the wall clock.
  const ambient = { we: today.classList.contains('we'), fer: today.classList.contains('fer') };
  today.classList.remove('we', 'fer');
  try {
  assert.equal(bg(today), SHADE.today, 'on screen it is unmistakable (8.1)');
  await withPrintCSS(() => {
    assert.equal(bg(today), SHADE.none, 'a pink band would date the sheet on the wall');
    assert.equal(getComputedStyle(today, '::before').display, 'none', 'the gutter rule goes too');
    assert.equal(getComputedStyle($('.d-num', today)).fontWeight, '500',
      'and the bolder day number — the quieter tell');
    assert.equal(getComputedStyle($('.d-num', today)).color, 'rgb(138, 124, 184)', '--ink-3');
    assert.equal(getComputedStyle($('.col.is-today-month .col-head'), '::after').display, 'none',
      'the accent dot on the today-month header goes as well');
  });
  assert.equal(bg(today), SHADE.today, 'and comes straight back on screen');
  } finally {
    if (ambient.we) today.classList.add('we');
    if (ambient.fer) today.classList.add('fer');
  }
});

test('12.3/15.4 · a Today that falls on a weekend or in Ferien prints as that, not as blank', async () => {
  reset();
  const row = $('.board .day.today');
  const had = { we: row.classList.contains('we'), fer: row.classList.contains('fer') };
  try {
    await withPrintCSS(() => {
      row.classList.remove('we', 'fer');
      row.classList.add('we');
      assert.equal(bg(row), SHADE.weekend, 'a weekend today still prints as a weekend');
      row.classList.add('fer');
      assert.equal(bg(row), SHADE.weekendFerien, 'and a weekend in Ferien as the overlap');
      row.classList.remove('we');
      assert.equal(bg(row), SHADE.ferien);
    });
  } finally {
    row.classList.remove('we', 'fer');
    if (had.we) row.classList.add('we');
    if (had.fer) row.classList.add('fer');
    redraw();
  }
});

test('12.3 · find dimming is a view state and is dropped; hidden categories were never rendered', async () => {
  reset();
  const date = plainDate();
  const cat = store.state.categories[0].id;
  addNote({ id: 'dr-hit', date, text: 'Zahnarzt', categoryId: cat, repeatsYearly: false });
  addNote({ id: 'dr-miss', date: addDays(date, 1), text: 'Baumarkt', categoryId: cat, repeatsYearly: false });

  const find = $('#find-input');
  find.value = 'Zahnarzt';
  find.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => document.body.classList.contains('finding'), { what: 'find to engage' });
  const hit = $('.note[data-note-id="dr-hit"]');
  const miss = $('.note[data-note-id="dr-miss"]');
  assert.ok(hit.classList.contains('hit'));
  assert.equal(getComputedStyle(miss).opacity, '0.3', 'non-hits are dimmed on screen (14.1)');

  await withPrintCSS(() => {
    assert.equal(getComputedStyle(miss).opacity, '1', 'what you see is what prints — minus view state');
    assert.equal(getComputedStyle(hit).backgroundColor, 'rgba(0, 0, 0, 0)', 'the yellow wash is view state too');
  });

  find.value = '';
  find.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !document.body.classList.contains('finding'), { what: 'find to clear' });
  reset();
});

test('12.3 · empty scratchpads are hidden on paper, written ones are not', async () => {
  reset();
  const m = model();
  store.mutate('dom-rendering:pad', (s) => { s.scratchpads[m.cols[0].key] = 'Material bestellen'; });
  redraw();
  const pads = $$('.board .pad');
  assert.equal(pads.length, 12);
  assert.ok(!pads[0].classList.contains('empty'));
  assert.ok(pads[1].classList.contains('empty'));
  await withPrintCSS(() => {
    assert.equal(getComputedStyle(pads[0]).visibility, 'visible');
    assert.equal(getComputedStyle(pads[1]).visibility, 'hidden', '10.5 — only non-empty pads print');
    assert.equal($('textarea', pads[0]).value, 'Material bestellen');
  });
  reset();
});

test('12.2/12.4 · the print furniture is built on beforeprint and names what the sheet is', () => {
  reset();
  const m = model();
  window.dispatchEvent(new Event('beforeprint'));

  const head = $('#print-head');
  assert.equal($('.t', head).textContent, 'LangzeitPlaner');
  assert.equal($('.r', head).textContent, `${m.cols[0].fullLabel} – ${m.cols[11].fullLabel}`,
    'the sheet states its own range');
  assert.includes($('.meta', head).textContent, 'Feiertage');

  const legend = $('#print-legend');
  const names = $$('.item .nm', legend).map((n) => n.textContent);
  assert.deepEqual(names, store.state.categories.map((c) => c.name),
    'a printed stripe with no key is just a coloured line (12.2 design note)');
  assert.equal($$('.item .sw', legend)[0].style.background, 'rgb(42, 124, 192)');
  assert.includes($('.layers', legend).textContent, 'Feiertage');

  // 12.3 — a hidden category is absent from the key, exactly as it is absent
  // from the board.
  const cat = store.state.categories[1];
  store.mutate('dom-rendering:hide2', () => { cat.visible = false; });
  redraw();
  window.dispatchEvent(new Event('beforeprint'));
  const after = $$('#print-legend .item .nm').map((n) => n.textContent);
  assert.equal(after.length, names.length - 1);
  assert.ok(!after.includes(cat.name), 'what you see is what prints (12.3)');
  reset();
});

test('12.3 · switching a layer off changes both the board and the printed key', async () => {
  reset();
  const hasFerien = ferienAvailable(ferienSample('BY'));
  if (!hasFerien) diag('note: no Ferien in this window — the .fer half of this test is inert, the rest still runs');
  await withSettings({ bundesland: 'BY', layers: { feiertage: true, schulferien: true } }, () => {
    window.dispatchEvent(new Event('beforeprint'));
    assert.ok($$('.board .d-hol').length > 0);
    if (hasFerien) assert.ok($$('.board .day.fer').length > 0);
    const layers = $('#print-legend .layers').textContent;
    assert.includes(layers, 'Feiertage');
    assert.includes(layers, 'Schulferien');
    assert.includes($('#print-head .meta').textContent, 'Bayern');
  });
  await withSettings({ bundesland: 'BY', layers: { feiertage: false, schulferien: false } }, () => {
    window.dispatchEvent(new Event('beforeprint'));
    assert.equal($$('.board .d-hol').length, 0, 'nothing was rendered, so nothing can print');
    assert.equal($$('.board .day.fer').length, 0);
    assert.equal($('#print-legend .layers').textContent, '');
    assert.equal($('#print-head .meta').textContent, '');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// the empty board — the state the app opens in
// ═════════════════════════════════════════════════════════════════════════════

test('an empty board is a complete board: grid, headers, pads, and nothing else', () => {
  reset();
  assert.equal($$('.board .col').length, 12);
  assert.equal($$('.board .day').length, 372);
  assert.equal($$('.board .note').length, 0);
  assert.equal($$('.board .bar').length, 0);
  assert.equal($$('.board .bar-label').length, 0);
  assert.equal($$('.board .d-more').length, 0);
  assert.equal($$('.board .horizon-cue').length, 0);
  assert.equal($$('.board .bar-cont-up, .board .bar-cont-down').length, 0);
  assert.equal($$('.board .pad textarea').length, 12, 'every month gets a scratchpad (10.1)');
  assert.equal($$('.board .pad.empty').length, 12, 'all dimmed while untouched');
  assert.equal($$('.board .day.today').length, 1, 'Today is there before any content is');
  assert.equal($('.board .inline-edit'), null);
  assert.equal($('.popover'), null);
});
