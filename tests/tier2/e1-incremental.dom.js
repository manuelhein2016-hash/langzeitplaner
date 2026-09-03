// TIER 2 · §E1' — THE INCREMENTAL RENDER IS THE FULL RENDER
//
// LZP-1007. `board.js` stopped rebuilding twelve months of DOM on every call
// (see the header block there for the measurements that forced it). Everything
// that buys is worthless — worse than worthless — if the incremental board can
// differ from the one a full rebuild would have produced, so this file is the
// row that says it cannot.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS PROVEN, AND HOW
// ─────────────────────────────────────────────────────────────────────────────
//
// The claim is not "the visible result looks right". It is DOM EQUALITY:
// `#board.outerHTML` after N incremental renders is byte-for-byte the string a
// from-scratch rebuild of the same model produces — every element, every
// attribute, in order — plus the one piece of state no serialisation carries,
// the scratchpad `<textarea>`'s `value` PROPERTY.
//
// It is checked two ways, because they fail differently:
//
//   §I1  DEPTH 1 — every mutation kind, applied to a board that was just built
//        from scratch. This is the one that catches a signature that does not
//        mention a field its builder reads: the model moved, the sig did not,
//        the slot was kept, the board is wrong.
//   §I2  DEPTH 8 — chains of mutations with NO full render in between, so the
//        cache carries state forward eight times. This is the one that catches
//        a patch that leaves a node or a record subtly out of step with the DOM
//        — a stale `rec.body`, a `.d-more` removed but still recorded, a tail
//        node that was detached but not forgotten.
//
// §I3 then does to the board what the rest of the app does between renders:
// `find.js`'s `.hit`, `interact.js`'s `.selected` and its inline editor, which
// a `textContent = ''` used to sweep away for free.
//
// The mutation set is deliberately wider than the gestures LZP-1007 is about.
// It reaches every input `buildBoard` has — the density seam and the row height
// (which changes CAPACITY, and therefore what is drawn versus folded into „+n"),
// the language, the rolling/pinned window, the Feiertage and Schulferien layers,
// the Bundesland, category colours and visibility, per-member visibility, entry
// text, dates, repeats, exposure levels, „neu" flags, bars and their labels, and
// the scratchpads.
//
// Plain script: globals are test, assert, $, $$, waitFor, sleep, importApp,
// diag, skip.
// ─────────────────────────────────────────────────────────────────────────────

const { store } = await importApp('store.js');
const { renderBoard, invalidateBoardCache } = await importApp('board.js');
const I18N = await importApp('i18n.js');

const boardEl = () => $('#board');

// ── the fixture: eight people, two years, the same shape §E1 measures ────────

const MEMBERS = [
  { id: 'mem_mama', colorRef: 'magenta', initial: 'M' },
  { id: 'mem_papa', colorRef: 'gruen', initial: 'P' },
  { id: 'mem_lena', colorRef: 'gold', initial: 'L' },
  { id: 'mem_jonas', colorRef: 'tuerkis', initial: 'J' },
  { id: 'mem_tante', colorRef: 'violett', initial: 'T' },
  { id: 'mem_opa', colorRef: 'rot', initial: 'O' },
  { id: 'mem_oma', colorRef: 'marine', initial: 'A' },
];
const TXT = ['Chorprobe', 'Zahnarzt', 'Elternabend', 'Yoga', 'Turnier', 'Ballett', 'Kur', 'Konferenz'];
const LBL = ['Urlaub', 'Projekt', 'Kur', 'Dienstreise', 'Ferienlager'];

const M0 = renderBoard(boardEl());
const COL = M0.cols[1];

let seed = 20260903;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (a) => a[(rnd() * a.length) | 0];

const DAYS = 730;
const day0 = new Date(Date.UTC(COL.y, COL.m - 1, 1) - 180 * 86400000);
const at = (i) => new Date(day0.getTime() + i * 86400000).toISOString().slice(0, 10);
const anyDate = () => at((rnd() * DAYS) | 0);

let uid = 0;
const own = (date, text, x = {}) => ({
  id: `n${uid++}`, uuid: `n${uid}`, date, text,
  categoryId: pick(store.state.categories).id, repeatsYearly: false,
  isForeign: false, ownerId: 'mem_me', level: null, redacted: false,
  memberColorRef: null, initial: null, exposure: null, isNew: false, ...x,
});
const foreign = (date, who, level, x = {}) => ({
  id: `fnote:${who.id}/f${uid++}`, uuid: `f${uid}`, date,
  text: level === 'geteilt' ? pick(TXT) : null, repeatsYearly: false,
  isForeign: true, ownerId: who.id, level, memberColorRef: who.colorRef,
  initial: who.initial, exposure: null, isNew: false, coEdit: false, ...x,
});
const ownBar = (a, b, label, x = {}) => ({
  id: `b${uid++}`, uuid: `b${uid}`, startDate: a, endDate: b, label,
  categoryId: pick(store.state.categories).id, isForeign: false, ownerId: 'mem_me',
  level: null, memberColorRef: null, initial: null, exposure: null, isNew: false, ...x,
});
const foreignBar = (a, b, who, level, x = {}) => ({
  id: `fbar:${who.id}/fb${uid++}`, uuid: `fb${uid}`, startDate: a, endDate: b,
  label: level === 'geteilt' ? pick(LBL) : null, isForeign: true, ownerId: who.id,
  level, memberColorRef: who.colorRef, initial: who.initial, exposure: null,
  isNew: false, coEdit: false, ...x,
});

function fixture() {
  const notes = []; const bars = [];
  const people = [{ id: 'mem_me', me: true }].concat(MEMBERS);
  for (const p of people) {
    for (let d = 0; d < DAYS; d++) {
      if (rnd() > 0.5) continue;
      const date = at(d);
      if (p.me) {
        notes.push(own(date, pick(TXT), {
          repeatsYearly: rnd() < 0.04,
          exposure: rnd() < 0.3 ? { level: rnd() < 0.5 ? 'belegt' : 'geteilt', pending: rnd() < 0.2 } : null,
        }));
      } else {
        notes.push(foreign(date, p, rnd() < 0.5 ? 'geteilt' : 'belegt', {
          repeatsYearly: rnd() < 0.04, isNew: rnd() < 0.15,
        }));
      }
    }
    for (let i = 0; i < 52; i++) {
      const s = (rnd() * DAYS) | 0;
      const a = at(s); const b = at(Math.min(DAYS - 1, s + 2 + ((rnd() * 12) | 0)));
      if (p.me) bars.push(ownBar(a, b, pick(LBL)));
      else bars.push(foreignBar(a, b, p, rnd() < 0.5 ? 'geteilt' : 'belegt', { isNew: rnd() < 0.15 }));
    }
  }
  return { notes, bars };
}

// ── the comparison ───────────────────────────────────────────────────────────

/** The one piece of board state `outerHTML` does not carry. */
const padValues = () => $$('#board .pad textarea').map((t) => t.value).join('');

/**
 * Where two serialisations first differ, with enough of both sides to read.
 * A 400 000-character inequality is not a test result; this is.
 */
function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 90);
  return `at char ${i} of ${a.length}/${b.length}\n`
    + `      incremental: …${a.slice(from, i + 110)}\n`
    + `      full       : …${b.slice(from, i + 110)}`;
}

/**
 * Render incrementally, snapshot; drop the cache, render from scratch,
 * snapshot; the two snapshots must be the same string.
 *
 * The full render is what leaves the board in place afterwards, so the caller's
 * next incremental step starts from a board this function has just proven.
 */
function agrees(label) {
  renderBoard(boardEl());
  const incHTML = boardEl().outerHTML;
  const incPads = padValues();
  const incNodes = $$('#board *').length;

  invalidateBoardCache();
  renderBoard(boardEl());
  const fullHTML = boardEl().outerHTML;
  const fullPads = padValues();
  const fullNodes = $$('#board *').length;

  if (incHTML === fullHTML && incPads === fullPads) return { ok: true, nodes: fullNodes };
  return {
    ok: false,
    why: incPads !== fullPads
      ? `${label}: the scratchpad values differ`
      : `${label}: the DOM differs — ${firstDiff(incHTML, fullHTML)}`
        + (incNodes !== fullNodes ? `\n      node count ${incNodes} vs ${fullNodes}` : ''),
  };
}

function verdict(label, rows) {
  const bad = rows.filter((r) => !r.ok);
  diag(`${label}: ${rows.length - bad.length}/${rows.length} cells hold`);
  for (const r of bad) diag('  x ' + r.why);
  assert.equal(bad.length, 0, bad.length ? `${label}: ${bad.length} of ${rows.length} disagree` : '');
}

// ── the mutations ────────────────────────────────────────────────────────────
//
// Every input `buildBoard` has. Each returns the name of what it did, so a
// failing cell says which gesture produced the disagreement.

const S = () => store.state.settings;
const ownNotes = () => store.state.notes.filter((n) => !n.isForeign);
const foreignNotes = () => store.state.notes.filter((n) => n.isForeign);

const MUTATIONS = [
  function hideMember() {
    const m = pick(MEMBERS).id;
    const h = { ...(S().hiddenMembers || {}) };
    if (h[m]) delete h[m]; else h[m] = true;
    S().hiddenMembers = h;
    return `hideMember ${m}`;
  },
  function hideCategory() {
    const c = pick(store.state.categories);
    c.visible = c.visible === false;
    return `category.visible ${c.id}=${c.visible}`;
  },
  function recolourCategory() {
    const c = pick(store.state.categories);
    c.paletteRef = pick(['magenta', 'gruen', 'gold', 'tuerkis', 'violett', 'rot', 'marine']);
    return `category.paletteRef ${c.id}`;
  },
  function editNoteText() {
    const list = ownNotes(); if (!list.length) return 'editNoteText (none)';
    const n = pick(list); n.text = `${pick(TXT)} ${(rnd() * 99) | 0}`;
    return `note.text ${n.id}`;
  },
  function moveNote() {
    const n = pick(store.state.notes); if (!n) return 'moveNote (none)';
    n.date = anyDate();
    return `note.date ${n.id}`;
  },
  function addNote() {
    store.state.notes.push(rnd() < 0.5
      ? own(anyDate(), pick(TXT), { repeatsYearly: rnd() < 0.1 })
      : foreign(anyDate(), pick(MEMBERS), rnd() < 0.5 ? 'geteilt' : 'belegt', { isNew: rnd() < 0.5 }));
    return 'addNote';
  },
  function removeNote() {
    if (!store.state.notes.length) return 'removeNote (none)';
    store.state.notes.splice((rnd() * store.state.notes.length) | 0, 1);
    return 'removeNote';
  },
  function toggleRepeat() {
    const n = pick(store.state.notes); if (!n) return 'toggleRepeat (none)';
    n.repeatsYearly = !n.repeatsYearly;
    return `note.repeatsYearly ${n.id}`;
  },
  function changeExposure() {
    const list = ownNotes(); if (!list.length) return 'changeExposure (none)';
    const n = pick(list);
    n.exposure = rnd() < 0.25 ? null
      : { level: rnd() < 0.5 ? 'belegt' : 'geteilt', pending: rnd() < 0.5 };
    return `note.exposure ${n.id}`;
  },
  function changeLevel() {
    const list = foreignNotes(); if (!list.length) return 'changeLevel (none)';
    const n = pick(list);
    n.level = n.level === 'geteilt' ? 'belegt' : 'geteilt';
    n.text = n.level === 'geteilt' ? pick(TXT) : null;
    return `foreign level ${n.id}=${n.level}`;
  },
  function toggleIsNew() {
    const list = foreignNotes(); if (!list.length) return 'toggleIsNew (none)';
    const n = pick(list); n.isNew = !n.isNew;
    return `foreign isNew ${n.id}`;
  },
  function toggleCoEdit() {
    const list = foreignNotes(); if (!list.length) return 'toggleCoEdit (none)';
    const n = pick(list); n.coEdit = !n.coEdit;
    return `foreign coEdit ${n.id}`;
  },
  function recategorise() {
    const list = ownNotes(); if (!list.length) return 'recategorise (none)';
    const n = pick(list); n.categoryId = pick(store.state.categories).id;
    return `note.categoryId ${n.id}`;
  },
  function addBar() {
    const s = (rnd() * DAYS) | 0;
    const a = at(s); const b = at(Math.min(DAYS - 1, s + 1 + ((rnd() * 40) | 0)));
    store.state.bars.push(rnd() < 0.5
      ? ownBar(a, b, pick(LBL))
      : foreignBar(a, b, pick(MEMBERS), rnd() < 0.5 ? 'geteilt' : 'belegt', { isNew: rnd() < 0.5 }));
    return 'addBar';
  },
  function removeBar() {
    if (!store.state.bars.length) return 'removeBar (none)';
    store.state.bars.splice((rnd() * store.state.bars.length) | 0, 1);
    return 'removeBar';
  },
  function reshapeBar() {
    const b = pick(store.state.bars); if (!b) return 'reshapeBar (none)';
    const s = (rnd() * DAYS) | 0;
    b.startDate = at(s);
    b.endDate = at(Math.min(DAYS - 1, s + 1 + ((rnd() * 60) | 0)));
    return `bar dates ${b.id}`;
  },
  function relabelBar() {
    const b = pick(store.state.bars); if (!b) return 'relabelBar (none)';
    b.label = rnd() < 0.2 ? '' : `${pick(LBL)} ${(rnd() * 9) | 0}`;
    return `bar.label ${b.id}`;
  },
  function rowHeight() {
    S().rowHeight = pick([18, 20, 22, 26, 32, 40]);
    return `rowHeight ${S().rowHeight}`;
  },
  function density() {
    S().density = pick(['kompakt', 'komfort']);
    return `density ${S().density}`;
  },
  function colWidth() {
    S().colWidth = pick([92, 110, 118, 140]);
    return `colWidth ${S().colWidth}`;
  },
  function layers() {
    const k = pick(['feiertage', 'schulferien', 'otherStates']);
    S().layers = { ...S().layers, [k]: !S().layers[k] };
    return `layers.${k}=${S().layers[k]}`;
  },
  function bundesland() {
    S().bundesland = pick(['', 'BY', 'NW', 'BE', 'HH']);
    return `bundesland ${S().bundesland || '(none)'}`;
  },
  function scratchpad() {
    // The months on the board right now — which the window mutations move.
    const keys = $$('#board .col').map((c) => c.dataset.month);
    if (!keys.length) return 'scratchpad (no board)';
    const key = pick(keys);
    store.state.scratchpads[key] = rnd() < 0.25 ? '' : `Notiz ${(rnd() * 999) | 0}\nZeile zwei`;
    return `scratchpad ${key}`;
  },
  function language() {
    const l = I18N.getLang() === 'de' ? 'en' : 'de';
    I18N.setLang(l);
    S().language = l;
    return `language ${l}`;
  },
  function rollWindow() {
    if (rnd() < 0.5) { S().mode = 'rolling'; S().pageYears = 0; return 'window rolling'; }
    S().mode = 'pinned';
    S().startMonth = `${COL.y + ((rnd() * 2) | 0)}-${String(1 + ((rnd() * 12) | 0)).padStart(2, '0')}`;
    S().pageYears = (rnd() * 3) | 0;
    return `window pinned ${S().startMonth}+${S().pageYears}y`;
  },
];


// ── the base state, restored before each section ─────────────────────────────

const BASE_SETTINGS = JSON.parse(JSON.stringify(store.state.settings));
const BASE_CATS = JSON.parse(JSON.stringify(store.state.categories));
const BASE_NOTES = store.state.notes;
const BASE_BARS = store.state.bars;
const BASE_PADS = JSON.parse(JSON.stringify(store.state.scratchpads));

function installFixture() {
  const fx = fixture();
  store.state.settings = JSON.parse(JSON.stringify(BASE_SETTINGS));
  store.state.categories = JSON.parse(JSON.stringify(BASE_CATS));
  store.state.scratchpads = {};
  Object.assign(store.state.settings, {
    rowHeight: 22, colWidth: 118, hiddenMembers: {}, bundesland: 'BY',
    layers: { feiertage: true, schulferien: true, otherStates: false },
    mode: 'rolling', pageYears: 0, language: 'de', density: 'kompakt',
  });
  I18N.setLang('de');
  store.state.notes = fx.notes;
  store.state.bars = fx.bars;
  invalidateBoardCache();
  renderBoard(boardEl());
}
function restoreBase() {
  store.state.settings = JSON.parse(JSON.stringify(BASE_SETTINGS));
  store.state.categories = JSON.parse(JSON.stringify(BASE_CATS));
  store.state.scratchpads = JSON.parse(JSON.stringify(BASE_PADS));
  store.state.notes = BASE_NOTES;
  store.state.bars = BASE_BARS;
  I18N.setLang(BASE_SETTINGS.language === 'en' ? 'en' : 'de');
  invalidateBoardCache();
  renderBoard(boardEl());
}

// ═════════════════════════════════════════════════════════════════════════════
// §I1 · ONE MUTATION, FROM A BOARD THAT WAS JUST BUILT FROM SCRATCH
// ═════════════════════════════════════════════════════════════════════════════

test("§I1 · every mutation kind — one incremental step equals a full rebuild", () => {
  installFixture();
  const rows = [];
  const seen = new Set();
  try {
    // Every kind at least twice, in a shuffled order, plus a random tail.
    const plan = [];
    for (let pass = 0; pass < 2; pass++) for (const m of MUTATIONS) plan.push(m);
    for (let i = 0; i < 16; i++) plan.push(pick(MUTATIONS));
    for (let i = plan.length - 1; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      [plan[i], plan[j]] = [plan[j], plan[i]];
    }
    for (const m of plan) {
      const what = m();
      seen.add(m.name);
      const r = agrees(what);
      rows.push(r.ok ? { ok: true } : r);
    }
    diag(`   ${rows.length} single mutations across ${seen.size} kinds; `
      + `board carries ${$$('#board *').length} nodes`);
  } finally { restoreBase(); }
  verdict('§I1 · depth 1', rows);
});

// ═════════════════════════════════════════════════════════════════════════════
// §I2 · EIGHT MUTATIONS DEEP, WITH NO FULL RENDER IN BETWEEN
// ═════════════════════════════════════════════════════════════════════════════

test("§I2 · eight incremental renders in a row equal one full rebuild", () => {
  installFixture();
  const rows = [];
  try {
    for (let chain = 0; chain < 10; chain++) {
      const steps = [];
      for (let k = 0; k < 8; k++) {
        steps.push(MUTATIONS[(rnd() * MUTATIONS.length) | 0]());
        renderBoard(boardEl());          // incremental, cache carried forward
      }
      const r = agrees(`chain ${chain}: ${steps.join(' → ')}`);
      rows.push(r.ok ? { ok: true } : r);
    }
    diag(`   10 chains × 8 mutations = 80 incremental renders, `
      + `compared at 10 points against a from-scratch board`);
  } finally { restoreBase(); }
  verdict('§I2 · depth 8', rows);
});

// ═════════════════════════════════════════════════════════════════════════════
// §I3 · WHAT THE REST OF THE APP DOES TO THE BOARD BETWEEN RENDERS
//
// A full rebuild swept all of this away by destroying the DOM. The incremental
// path has to do it on purpose, and these are the four ways it could fail to.
// ═════════════════════════════════════════════════════════════════════════════

test("§I3 · marks and foreign nodes left on the board do not survive a render", () => {
  installFixture();
  const rows = [];
  try {
    // 1 — find.js's `.hit` on a wide match, and its `.current` on one of them.
    const notes = $$('#board .note');
    for (let i = 0; i < notes.length; i += 3) notes[i].classList.add('hit');
    notes[1]?.classList.add('current');
    $$('#board .bar').slice(0, 20).forEach((b) => b.classList.add('hit'));
    rows.push(agrees('after find.js marked 1/3 of the notes'));

    // 2 — interact.js's selection, on a note and on a bar.
    $$('#board .note')[5]?.classList.add('selected');
    $$('#board .bar-label')[2]?.classList.add('selected');
    $$('#board .bar')[2]?.classList.add('selected');
    rows.push(agrees('after interact.js selected an entry'));

    // 3 — interact.js's inline editor and drop row, appended into `.rows`.
    const rowsEl = $('#board .rows');
    const inp = document.createElement('input');
    inp.className = 'inline-edit';
    rowsEl.appendChild(inp);
    const drop = document.createElement('div');
    drop.className = 'drop-row';
    $$('#board .rows')[4].appendChild(drop);
    rows.push(agrees('after an inline editor and a drop row were appended'));

    // 4 — a drag preview inside a column, outside `.rows`.
    const prev = document.createElement('div');
    prev.className = 'bar-preview';
    $$('#board .col')[3].appendChild(prev);
    rows.push(agrees('after a drag preview was appended to a column'));

    // 5 — the whole board wiped by someone else. The cache must not resurrect it.
    boardEl().textContent = '';
    renderBoard(boardEl());
    rows.push({ ok: $$('#board .day').length === 12 * 31,
      why: `a wiped board rebuilt to ${$$('#board .day').length} day rows, not ${12 * 31}` });
    rows.push(agrees('after the board was wiped from outside'));
  } finally { restoreBase(); }
  verdict('§I3 · the board between renders', rows);
});

// ═════════════════════════════════════════════════════════════════════════════
// §I4 · THE SCRATCHPAD KEEPS THE MODEL'S TEXT, NOT THE ELEMENT'S
//
// The one place a kept node can hold state no attribute carries: `interact.js`
// commits typing to the store only after a 600 ms pause (rule U9), so between
// renders the live `<textarea>` can hold text the model does not. A full
// rebuild discarded it. So does this one.
// ═════════════════════════════════════════════════════════════════════════════

test('§I4 · a scratchpad holding uncommitted typing is reset exactly as a rebuild resets it', () => {
  installFixture();
  const rows = [];
  try {
    const ta = $('#board .pad textarea');
    const key = ta.dataset.month;

    store.state.scratchpads[key] = 'committed';
    renderBoard(boardEl());
    rows.push({ ok: $(`#board .pad[data-month="${key}"] textarea`).value === 'committed',
      why: 'a committed pad text did not reach the textarea' });

    // Typing that never reached the store.
    $(`#board .pad[data-month="${key}"] textarea`).value = 'uncommitted typing';
    $(`#board .pad[data-month="${key}"]`).classList.remove('empty');
    rows.push(agrees('after uncommitted typing in a scratchpad'));

    store.state.scratchpads[key] = '';
    rows.push(agrees('after the pad was blanked in the model'));
  } finally { restoreBase(); }
  verdict('§I4 · the scratchpad', rows);
});

// ═════════════════════════════════════════════════════════════════════════════
// §I5 · 17.5 — THE ONE MODEL FIELD THE RANDOM WALK COULD NOT REACH
//
// Mutation testing found this hole rather than a reviewer: removing
// `day.overflowNew` from the „+n" badge's signature SURVIVED §I1 and §I2. The
// random walk changes `isNew` on a random peer entry, and an entry whose flag
// matters here has to be one the capacity rule folded away on a day whose
// visible slots are all MINE — otherwise `orderForCapacity`'s `changedFirst`
// promotes it into view and the row's body changes too, which every signature
// already catches.
//
// That state is 17.5's whole point (`e8-density-crowding.dom.js` §B5: 32 of 219
// peer changes arrived with no note element to hang a dot on, so the badge is
// the only mark left on the row), and „do not regress the „neu" dots and the
// „+n" tell" is a standing constraint. So it gets a cell of its own, built
// deliberately instead of stumbled into.
// ═════════════════════════════════════════════════════════════════════════════

test('§I5 · a peer change folded into a „+n" badge reaches the badge on the incremental path too', () => {
  installFixture();
  const rows = [];
  try {
    // A row that carries a badge, whose drawn notes are all mine — so nothing
    // can be promoted — and which hides at least one peer entry.
    let found = null;
    for (const more of $$('#board .d-more')) {
      const day = more.closest('.day');
      const drawn = $$('.note', day);
      if (!drawn.length || drawn.some((n) => n.dataset.foreign === '1')) continue;
      const shown = new Set(drawn.map((n) => n.dataset.noteId));
      const date = more.dataset.date;
      const hidden = store.state.notes.filter(
        (n) => n.isForeign && n.date === date && !n.repeatsYearly && !shown.has(n.id));
      if (hidden.length) { found = { date, note: hidden[0] }; break; }
    }
    assert.ok(found, 'the fixture produced no row with a „+n" badge hiding a peer entry');

    const badgeOf = () => $(`#board .day[data-date="${found.date}"] .d-more`);
    const readBadge = () => {
      const b = badgeOf();
      return b ? `${b.className}|${b.textContent}|${b.title}` : '(no badge)';
    };

    for (const n of store.state.notes) {
      if (n.isForeign && n.date === found.date) n.isNew = false;
    }
    invalidateBoardCache();
    renderBoard(boardEl());
    const quiet = readBadge();

    // The flag flips on an entry the row had no line for. Nothing else moves:
    // the drawn notes are mine and `ownFirst` keeps them there.
    found.note.isNew = true;
    const r = agrees(`17.5 — a peer change folded into the badge on ${found.date}`);
    rows.push(r.ok ? { ok: true } : r);
    const loud = readBadge();

    diag(`   ${found.date}: badge quiet "${quiet}"`);
    diag(`   ${found.date}: badge loud  "${loud}"`);
    rows.push({ ok: loud !== quiet && /has-new/.test(loud),
      why: `the badge did not change when a folded peer entry became a change: "${quiet}" → "${loud}"` });

    // …and back, because a tell that cannot be taken away is not a tell.
    found.note.isNew = false;
    const back = agrees(`17.5 — the same peer change, withdrawn, on ${found.date}`);
    rows.push(back.ok ? { ok: true } : back);
    rows.push({ ok: readBadge() === quiet,
      why: `the badge did not go quiet again: "${readBadge()}" vs "${quiet}"` });
  } finally { restoreBase(); }
  verdict('§I5 · the „+n" badge and 17.5', rows);
});
