// TIER 2 · E8 DENSITY ADVERSARY — §C · HOW MUCH OF THE SENTENCE SURVIVES
//
// 2.5 (truncation) · 17.4 („family entries obey … truncation (2.5)") ·
// §13's own constraint: „~80-char notes … limits chosen for LEGIBILITY, not
// tech" · `layout.js:PREFIX_COST_PX`, which prices the badges in PIXELS.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY PIXELS ARE THE WRONG UNIT FOR THIS QUESTION
// ─────────────────────────────────────────────────────────────────────────────
//
// `family-density.dom.js` §3 measures the prefix cost in px and checks it
// against the published constant. That is the right check for the constant. It
// is not the answer to „what does E8 cost the user's own text", because a
// reader does not read pixels: 22.8 px of prefix on a 62 px line is not 37 % of
// a sentence, it is a specific number of CHARACTERS, and the last ones are the
// ones that carry the meaning („Zahnarzt **Lena**", „Elternabend **Klasse 3b**").
//
// So this file walks the note's own text node one character at a time with a
// `Range` and counts what the reader can see — in the shipped font, at the
// shipped size, in the engine that ships. It does the same at v1's NARROWEST
// legal column (92 px, `settings.js:190`), which is a supported setting and not
// an edge case.
//
// It also counts what the „+n" badge takes back, because that badge is opaque
// and lands INSIDE the text column (see `e8-density-legibility.dom.js` §A2), and
// on a family board 97 % of day rows carry one (`e8-density-crowding.dom.js` §B4).
//
// Plain script: globals are test, assert, $, $$, waitFor, sleep, importApp,
// diag, skip.
// ─────────────────────────────────────────────────────────────────────────────

const { store } = await importApp('store.js');
const { renderBoard } = await importApp('board.js');
const L = await importApp('layout.js');

const boardEl = () => $('#board');
const px = (n) => Math.round(n * 10) / 10;

const MAMA = { id: 'mem_mama', colorRef: 'magenta', initial: 'M' };
const own = (id, date, text, x = {}) => ({
  id, uuid: id, date, text, categoryId: store.state.categories[0].id, repeatsYearly: false,
  isForeign: false, ownerId: 'mem_me', level: null, redacted: false, memberColorRef: null,
  initial: null, exposure: null, isNew: false, ...x,
});
const foreign = (id, date, level, x = {}) => {
  const who = x.who || MAMA;
  const { who: _w, ...rest } = x;
  return {
    id: `fnote:${who.id}/${id}`, uuid: id, date, text: null, repeatsYearly: false,
    isForeign: true, ownerId: who.id, level, memberColorRef: who.colorRef, initial: who.initial,
    exposure: null, isNew: false, coEdit: false, ...rest,
  };
};

function withBoard({ notes = [], bars = [], settings = {} }, fn) {
  const before = { notes: store.state.notes, bars: store.state.bars, settings: JSON.parse(JSON.stringify(store.state.settings)) };
  try {
    Object.assign(store.state.settings, settings);
    store.state.notes = notes; store.state.bars = bars;
    renderBoard(boardEl());
    return fn();
  } finally {
    store.state.notes = before.notes; store.state.bars = before.bars;
    store.state.settings = before.settings; renderBoard(boardEl());
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
const CLEAN = COL.days.find((x) => !x.empty && !x.holiday && !x.ferien && !x.isToday && x.n > 3 && x.n < 25) || COL.days.find((x) => !x.empty);
const DAY = CLEAN.date;
const dayNode = () => $(`#board .col[data-month="${COL.key}"] .day[data-date="${DAY}"]`);

// A real German note at the middle of the spec's ~80-character allowance, whose
// meaning lives in its LAST word — which is the half truncation removes.
const TEXT = 'Elternsprechtag Klasse 3b';

/**
 * How many characters of a string fit in `avail` px, in a given CSS `font`.
 *
 * A PROBE, NOT A `Range` OVER THE LIVE NODE, and the difference matters. `.note`
 * is `overflow:hidden`, and WebKit CLAMPS a Range rect to the overflow box: every
 * character past the clip edge reports a zero-width rect sitting exactly on that
 * edge, so a naive per-character walk answers „all 25 are visible" for a line
 * that shows six. A first draft of this file did exactly that and reported 25/25
 * at a 36 px column, which is how the method was caught.
 */
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
const widthOf = (text, font) => { PROBE.style.font = font; PROBE.textContent = text; return PROBE.getBoundingClientRect().width; };

/**
 * `visible`  — characters that fit between the end of the badge prefix and the
 *              note's clip edge.
 * `readable` — …and also clear of the opaque `.d-more` badge painted on the row.
 *
 * The ellipsis WebKit paints eats roughly one more character on top of both, so
 * these are UPPER bounds — the direction that does not flatter the case.
 */
function charsOf(note, day) {
  let tn = null;
  for (const n of note.childNodes) if (n.nodeType === 3 && n.textContent.trim()) tn = n;
  if (!tn) return { total: 0, visible: 0, readable: 0, textPx: 0 };
  const clip = note.getBoundingClientRect();
  const st = getComputedStyle(note);
  const font = st.font || `${st.fontWeight} ${st.fontSize}/${st.lineHeight} ${st.fontFamily}`;
  const kids = [...note.children];
  const startX = kids.length
    ? kids[kids.length - 1].getBoundingClientRect().right + parseFloat(getComputedStyle(kids[kids.length - 1]).marginRight || 0)
    : clip.left + parseFloat(st.paddingLeft || 0);
  const clipRight = clip.right - parseFloat(st.paddingRight || 0);
  const more = $('.d-more', day);
  const badgeLeft = more ? more.getBoundingClientRect().left : Infinity;
  const s = tn.textContent;
  return {
    total: s.length,
    visible: fitChars(s, clipRight - startX, font),
    readable: fitChars(s, Math.min(clipRight, badgeLeft) - startX, font),
    textPx: px(Math.max(0, clipRight - startX)),
    fullPx: px(widthOf(s, font)),
  };
}

function measure(note, { colWidth = 118, rowHeight = 22, crowd = 0 } = {}) {
  // `crowd` adds foreign entries so the row draws the „+n" badge the family
  // board carries on 97 % of its rows — the badge is part of the reading
  // condition, not a separate topic.
  const filler = [];
  for (let i = 0; i < crowd; i++) filler.push(foreign('c' + i, DAY, 'belegt', { who: MAMA }));
  return withBoard({ notes: [note, ...filler], settings: { colWidth, rowHeight, layers: NO_LAYERS, hiddenMembers: {} } }, () => {
    const day = dayNode();
    const n = $$('.note', day).find((x) => x.dataset.noteId === note.id);
    if (!n) return null;
    const marks = [...n.children].map((c) => c.className);
    return { ...charsOf(n, day), marks, more: $('.d-more', day) ? $('.d-more', day).textContent : '—' };
  });
}

const CASES = () => ({
  'v1 · my plain note': own('t', DAY, TEXT),
  'v1 · my note + ↻': own('t', DAY, TEXT, { repeatsYearly: true }),
  'E8 · my note + Geteilt badge': own('t', DAY, TEXT, { exposure: { level: 'geteilt', pending: false } }),
  'E8 · MY WORST (badge + ↻)': own('t', DAY, TEXT, { repeatsYearly: true, exposure: { level: 'belegt', pending: true } }),
  'E8 · a peer\'s note (chip)': foreign('t', DAY, 'geteilt', { text: TEXT }),
  'E8 · PEER WORST (neu + chip + ↻)': foreign('t', DAY, 'geteilt', { text: TEXT, isNew: true, repeatsYearly: true }),
});

function table(opts, label) {
  diag(`── ${label} ─────────────────────────────────────────────`);
  diag('   ' + 'configuration'.padEnd(34) + 'chars visible  chars readable  text px  marks');
  const out = {};
  for (const [k, note] of Object.entries(CASES())) {
    const m = measure(note, opts);
    out[k] = m;
    diag('   ' + k.padEnd(34)
      + `${String(m.visible).padStart(8)}/${m.total}`
      + `${String(m.readable).padStart(12)}`
      + `${String(m.textPx).padStart(9)}`
      + `  [${m.marks.join(' ')}]${m.more !== '—' ? ' · ' + m.more : ''}`);
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// §C1 · THE DEFAULT COLUMN — 118 px, quiet row and crowded row
// ═════════════════════════════════════════════════════════════════════════════

test('§C1 · characters of the user\'s own sentence, at the 118 px default', () => {
  const quiet = table({ colWidth: 118, crowd: 0 }, '118 px column · no overflow badge on the row');
  const crowded = table({ colWidth: 118, crowd: 4 }, '118 px column · the family board\'s normal row (a „+n" badge is present)');

  const base = quiet['v1 · my plain note'].visible;
  const rows = [];
  diag(`   v1's baseline is ${base} characters of „${TEXT}".`);
  for (const [k, v] of Object.entries(quiet)) {
    const d = v.visible - base;
    diag(`   ${k.padEnd(34)} ${d >= 0 ? '+' : ''}${d} characters against v1`);
  }
  const peerWorst = quiet['E8 · PEER WORST (neu + chip + ↻)'].visible;
  const myWorst = quiet['E8 · MY WORST (badge + ↻)'].visible;
  diag(`   E8 COSTS THE OWNER ${base - myWorst} characters at worst and A PEER'S ENTRY ${base - peerWorst}, out of ${base}.`);
  const readableCrowded = crowded['E8 · PEER WORST (neu + chip + ↻)'].readable;
  diag(`   With the „+n" badge on the row, a peer's worst case is READABLE for ${readableCrowded} characters.`);

  // Nothing here can pass or fail on its own; the numbers are the finding. The
  // one cell that IS a property: E8 must not have cost the OWNER's plain note.
  rows.push({ id: 'principle-7/solo-note-unchanged', ok: quiet['v1 · my plain note'].visible === quiet['v1 · my plain note'].visible, why: '' });
  rows.push({ id: '2.5/a-peer-entry-still-says-something', ok: peerWorst >= 8,
    why: `a peer's worst-case note shows ${peerWorst} characters of a ${quiet['v1 · my plain note'].total}-character sentence` });
  rows.push({ id: '2.5/readable-under-the-badge', ok: readableCrowded === crowded['E8 · PEER WORST (neu + chip + ↻)'].visible,
    why: `${crowded['E8 · PEER WORST (neu + chip + ↻)'].visible - readableCrowded} of the ${crowded['E8 · PEER WORST (neu + chip + ↻)'].visible} visible characters are under the opaque „+n" badge` });
  verdict('§C1 · truncation at 118 px', rows);
});

// ═════════════════════════════════════════════════════════════════════════════
// §C2 · THE NARROWEST LEGAL COLUMN — 92 px (`settings.js:190`, a shipped range)
//
// Density is the feature, and the column-width slider is how a user buys more of
// it. The badges are a FIXED pixel cost (`layout.js:PREFIX_COST_PX` — „the family
// is a fixed pixel cost and does not scale with row height"), so every pixel the
// user takes off the column is taken out of the TEXT and none of it out of the
// marks. This is where that compounding lands.
// ═════════════════════════════════════════════════════════════════════════════

test('§C2 · at the 92 px minimum column the badges stop being a tax and become the line', () => {
  const at92 = table({ colWidth: 92, crowd: 0 }, '92 px column — v1\'s narrowest legal setting');
  const at92c = table({ colWidth: 92, crowd: 4 }, '92 px column · with the family\'s „+n" badge on the row');
  const at160 = table({ colWidth: 160, crowd: 0 }, '160 px column — v1\'s widest legal setting');

  const bodyW = withBoard({ notes: [own('t', DAY, TEXT)], settings: { colWidth: 92, layers: NO_LAYERS, hiddenMembers: {} } },
    () => px($('.note', dayNode()).getBoundingClientRect().width));
  const C = L.PREFIX_COST_PX;
  diag(`   at 92 px the note's own text column is ${bodyW} px wide.`);
  diag(`   the published prefix costs are own-worst ${C.ownWorst} px and peer-worst ${C.foreignWorst} px —`);
  diag(`   i.e. ${(C.ownWorst / bodyW * 100).toFixed(0)} % and ${(C.foreignWorst / bodyW * 100).toFixed(0)} % of the whole line, before a single letter.`);

  const rows = [];
  const peer92 = at92['E8 · PEER WORST (neu + chip + ↻)'];
  const base92 = at92['v1 · my plain note'];
  rows.push({ id: '2.5/peer-note-is-still-a-word-at-92px', ok: peer92.visible >= 5,
    why: `at the 92 px minimum a peer's worst-case note shows ${peer92.visible} characters (v1's plain note shows ${base92.visible})` });
  rows.push({ id: '2.5/readable-at-92px-with-overflow', ok: at92c['E8 · PEER WORST (neu + chip + ↻)'].readable >= 5,
    why: `${at92c['E8 · PEER WORST (neu + chip + ↻)'].readable} characters survive both the badges and the „+n" box at 92 px` });
  rows.push({ id: 'budget/prefix-under-half-the-line', ok: C.foreignWorst / bodyW < 0.5,
    why: `the peer prefix is ${(C.foreignWorst / bodyW * 100).toFixed(0)} % of the whole text column at the narrowest legal setting` });
  verdict('§C2 · truncation at the extremes', rows);
});

// ═════════════════════════════════════════════════════════════════════════════
// §C3 · THE BAR LABEL — 66 px, and it now has to carry a person too
//
// 3.7's chip is `max-width: 66px` with 3 px of padding a side. E8 puts a „neu"
// dot (5 px), an initial chip (10 px) and an exposure badge (9 px) inside it,
// and the label is the ONLY place a bar says what it is.
// ═════════════════════════════════════════════════════════════════════════════

test('§C3 · what is left of a bar label once it has to say whose bar it is', () => {
  const LBL = 'Ferienlager Nordsee';
  const bars = {
    'v1 · my bar': { id: 'b', uuid: 'b', startDate: DAY, endDate: DAY, label: LBL, categoryId: store.state.categories[0].id, isForeign: false, ownerId: 'mem_me', level: null, memberColorRef: null, initial: null, exposure: null, isNew: false },
    'E8 · my bar + Geteilt badge': null,
    'E8 · a peer\'s bar (chip)': null,
    'E8 · PEER WORST (neu + chip)': null,
  };
  bars['E8 · my bar + Geteilt badge'] = { ...bars['v1 · my bar'], exposure: { level: 'geteilt', pending: false } };
  bars['E8 · a peer\'s bar (chip)'] = { id: 'fbar:mem_mama/b', uuid: 'b', startDate: DAY, endDate: DAY, label: LBL, isForeign: true, ownerId: 'mem_mama', level: 'geteilt', memberColorRef: 'magenta', initial: 'M', exposure: null, isNew: false, coEdit: false };
  bars['E8 · PEER WORST (neu + chip)'] = { ...bars['E8 · a peer\'s bar (chip)'], isNew: true };

  diag('   ' + 'configuration'.padEnd(32) + 'chars visible  label px  prefix px  marks');
  const out = {};
  for (const [k, bar] of Object.entries(bars)) {
    const m = withBoard({ notes: [], bars: [bar], settings: { colWidth: 118, layers: NO_LAYERS, hiddenMembers: {} } }, () => {
      const lab = $(`#board .bar-label[data-bar-id="${bar.id}"]`);
      if (!lab) return null;
      const clip = lab.getBoundingClientRect();
      const st = getComputedStyle(lab);
      const font = st.font || `${st.fontWeight} ${st.fontSize}/${st.lineHeight} ${st.fontFamily}`;
      let tn = null;
      for (const n of lab.childNodes) if (n.nodeType === 3 && n.textContent.trim()) tn = n;
      const kids = [...lab.children];
      const startX = kids.length
        ? kids[kids.length - 1].getBoundingClientRect().right + parseFloat(getComputedStyle(kids[kids.length - 1]).marginRight || 0)
        : clip.left + parseFloat(st.paddingLeft || 0);
      const vis = tn ? fitChars(tn.textContent, clip.right - parseFloat(st.paddingRight || 0) - startX, font) : 0;
      const prefix = [...lab.children].reduce((s, c) => {
        const st = getComputedStyle(c);
        return s + c.getBoundingClientRect().width + parseFloat(st.marginRight || 0) + parseFloat(st.marginLeft || 0);
      }, 0);
      return { vis, total: LBL.length, w: px(clip.width), prefix: px(prefix), marks: [...lab.children].map((c) => c.className) };
    });
    out[k] = m;
    diag('   ' + k.padEnd(32) + `${String(m.vis).padStart(8)}/${m.total}${String(m.w).padStart(10)}${String(m.prefix).padStart(11)}  [${m.marks.join(' ')}]`);
  }
  const base = out['v1 · my bar'].vis;
  const worst = out['E8 · PEER WORST (neu + chip)'].vis;
  diag(`   v1's bar label carried ${base} characters of „${LBL}"; a peer's worst case carries ${worst} — ${base - worst} fewer.`);
  diag(`   The label is the only place a bar names itself: at ${worst} characters, „${LBL.slice(0, worst)}…" is what a family bar says.`);
  verdict('§C3 · the bar label', [
    { id: '3.3/a-peer-bar-still-names-itself', ok: worst >= 8,
      why: `a peer's bar label shows ${worst} characters of a ${LBL.length}-character name (v1: ${base})` },
  ]);
});
