// TIER 2 · E8 DENSITY ADVERSARY — §A · LEGIBILITY ON A LEGAL BOARD
//
// v1 design principle 1: „Density is the feature. Twelve months on one screen is
// the entire point. Every design decision competes against row height. When in
// doubt, thinner." v1 principle 3: „the user's own entries always win visual
// priority over ambient information." Story 17.4: family entries obey every v1
// density rule. Deliverable 17: the five badges coexist at 24-px rows.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS NEXT TO `family-density.dom.js`
// ─────────────────────────────────────────────────────────────────────────────
//
// That file builds ONE hand-ordered day, turns the ambient layers OFF
// (`NO_LAYERS`, for a good reason of its own — a holiday changes the capacity
// and it wanted a known note count), and audits collisions between the CHILD
// ELEMENTS of the notes. Three things fall outside that audit, and all three are
// where a family board actually becomes unreadable:
//
//   1. THE TEXT IS NOT A CHILD ELEMENT. `board.js` appends the note's text as a
//      TEXT NODE (`document.createTextNode(text)`), so `[...note.children]` —
//      the audit's own input — cannot see it. Everything the user came to read
//      is invisible to the collision audit that clears the row.
//   2. `.d-more` AND `.bar-label` WERE ABSOLUTELY POSITIONED OVER THE TEXT
//      COLUMN, with opaque backgrounds, and neither was checked against the
//      text. §A2 and §A3 closed both — both now stand in the LANE GUTTER, which
//      the row had already reserved — and these are the rows that hold them
//      closed, including the one collision the new arrangement could have:
//      27 px does not hold a badge and a label side by side.
//   3. THE BOARD IS LEGAL WITH THE LAYERS ON. A Feiertag, Schulferien and a
//      weekend are not exotic; they are three of v1's five hard problems, and
//      the brief asks for the day where all of it lands at once.
//
// So this file asks the same question about the marks the other one skipped, on
// a day the product will really produce, and it measures the OWNER'S OWN TEXT —
// which is what principle 3 promises wins.
//
// Plain script: globals are test, assert, $, $$, waitFor, sleep, importApp,
// diag, skip.
// ─────────────────────────────────────────────────────────────────────────────

const { store } = await importApp('store.js');
const { renderBoard } = await importApp('board.js');
const L = await importApp('layout.js');
const { colorOf, PALETTE } = await importApp('palette.js');
const { setLang, getLang } = await importApp('i18n.js');

const boardEl = () => $('#board');
const px = (n) => Math.round(n * 10) / 10;
const area = (r) => px(r.width * r.height);

// ── fixture scaffolding, shared with `family-density.dom.js` by copy ──────────
// Deliberately copied and not imported: a tier-2 file is a plain script in a
// real page, there is no module to share, and a helper that two suites mutate is
// how one suite starts characterising the other's fixture.
const MEMBERS = [
  { id: 'mem_mama', colorRef: 'magenta', initial: 'M' },
  { id: 'mem_papa', colorRef: 'gruen', initial: 'P' },
  { id: 'mem_lena', colorRef: 'gold', initial: 'L' },
  { id: 'mem_jonas', colorRef: 'tuerkis', initial: 'J' },
  { id: 'mem_tante', colorRef: 'lila', initial: 'T' },     // NOT in PALETTE — see §A4
  { id: 'mem_opa', colorRef: 'rot', initial: 'O' },
  { id: 'mem_oma', colorRef: 'braun', initial: 'A' },      // NOT in PALETTE — see §A4
];
const REAL = [
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
  const who = x.who || REAL[0];
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
  const who = x.who || REAL[0];
  const { who: _w, ...rest } = x;
  return {
    id: `fbar:${who.id}/${id}`, uuid: id, startDate: a, endDate: b, label: null, isForeign: true,
    ownerId: who.id, level, memberColorRef: who.colorRef, initial: who.initial, exposure: null,
    isNew: false, coEdit: false, ...rest,
  };
};

function withBoard({ notes = [], bars = [], settings = {} }, fn) {
  const before = {
    notes: store.state.notes, bars: store.state.bars,
    settings: JSON.parse(JSON.stringify(store.state.settings)), lang: getLang(),
  };
  try {
    Object.assign(store.state.settings, settings);
    if (settings.language) setLang(settings.language);
    store.state.notes = notes;
    store.state.bars = bars;
    const m = renderBoard(boardEl());
    return fn(m);
  } finally {
    store.state.notes = before.notes;
    store.state.bars = before.bars;
    store.state.settings = before.settings;
    setLang(before.lang);
    renderBoard(boardEl());
  }
}

/** ALL layers on and a Bundesland — the board the product actually ships. */
const LEGAL = { feiertage: true, schulferien: true, otherStates: false };

/** The three-bucket reporter the sibling suites use, so a red cell names itself. */
function verdict(label, rows) {
  const bad = rows.filter((r) => !r.ok);
  diag(`${label}: ${rows.length - bad.length}/${rows.length} cells hold`);
  for (const r of bad) diag('  x ' + r.id + ' — ' + r.why);
  assert.equal(bad.length, 0, bad.length ? label + ': ' + bad.map((r) => r.id).join(', ') : '');
}

// ═════════════════════════════════════════════════════════════════════════════
// THE DAY IS SCANNED FOR, NEVER GUESSED (the calendar hazard FINDINGS §12a names)
// ═════════════════════════════════════════════════════════════════════════════
store.state.settings.bundesland = 'BY';
store.state.settings.layers = { ...LEGAL };
const M0 = renderBoard(boardEl());

/** A day carrying a Feiertag AND Schulferien AND, ideally, a weekend. */
function findLegalDay(model) {
  const rank = (d) => (d.holiday ? 4 : 0) + (d.ferien ? 2 : 0) + (d.weekend ? 1 : 0);
  let best = null;
  for (const c of model.cols) {
    for (const d of c.days) {
      if (d.empty || d.isToday) continue;
      if (!best || rank(d) > rank(best.d)) best = { c, d };
      if (rank(d) === 7) return best;
    }
  }
  return best;
}
const SCENE_AT = findLegalDay(M0);
const COL = SCENE_AT.c;
const DAY = SCENE_AT.d.date;
const DN = SCENE_AT.d;
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const D = (n) => iso(COL.y, COL.m, Math.max(1, Math.min(COL.len, n)));
const dayNode = (date = DAY) => $(`#board .col[data-month="${COL.key}"] .day[data-date="${date}"]`);

diag(`window ${M0.cols[0].key} … ${M0.cols[11].key} · Bundesland BY, ALL LAYERS ON`);
diag(`the legal crowded day: ${DAY} — holiday ${DN.holiday ? DN.holiday.short : '—'} · ferien ${DN.ferienName || '—'} · weekend ${DN.weekend}`);

// ═════════════════════════════════════════════════════════════════════════════
// THE SCENE — every one of eight people has an entry on the SAME legal day,
// my own three bars run through it, one entry repeats, and the ambient layers
// are on. Nothing here is exotic: it is a family with a school holiday.
// ═════════════════════════════════════════════════════════════════════════════
const SCENE = () => ({
  notes: [
    own('own1', DAY, 'Zahnarzt Kinder', { repeatsYearly: true, exposure: { level: 'geteilt', pending: false } }),
    ...REAL.map((p, i) => foreign('f' + i, DAY, i % 2 ? 'belegt' : 'geteilt', {
      who: p, text: i % 2 ? null : ['Chorprobe', 'Elternabend', 'Ballett', 'Konferenz'][i % 4],
      isNew: i < 3, repeatsYearly: i === 0,
    })),
  ],
  bars: [
    ownBar('ob1', D(DN.n - 5), D(DN.n + 5), 'Projektwoche'),
    ownBar('ob2', D(DN.n - 1), D(DN.n + 3), 'Urlaub Nordsee'),
    ownBar('ob3', D(DN.n), D(DN.n + 2), 'Umzug'),
    foreignBar('fb1', D(DN.n - 3), D(DN.n + 4), 'geteilt', { who: REAL[0], label: 'Kur Bad Tölz', isNew: true }),
    foreignBar('fb2', D(DN.n - 1), D(DN.n + 1), 'belegt', { who: REAL[1] }),
  ],
});

// ─────────────────────────────────────────────────────────────────────────────
// THE MEASUREMENT THE SIBLING SUITE COULD NOT MAKE: the note's TEXT.
//
// `board.js` appends the text with `document.createTextNode`, so it is not in
// `node.children`. A `Range` over the note's child NODES gives the real laid-out
// inline box; intersecting it with the note's own (clipped) box gives what the
// reader can actually see, and that is the rectangle every opaque overlay on the
// row has to be checked against.
// ─────────────────────────────────────────────────────────────────────────────
function textBox(note) {
  let tn = null;
  for (const n of note.childNodes) if (n.nodeType === 3 && n.textContent.trim()) tn = n;
  if (!tn) return null;
  const r = document.createRange();
  r.selectNodeContents(tn);
  const full = r.getBoundingClientRect();
  const clip = note.getBoundingClientRect();
  const left = Math.max(full.left, clip.left);
  const right = Math.min(full.right, clip.right);
  if (right - left <= 0.5) return null;
  return {
    visible: { left, right, top: Math.max(full.top, clip.top), bottom: Math.min(full.bottom, clip.bottom), width: right - left, height: Math.min(full.bottom, clip.bottom) - Math.max(full.top, clip.top) },
    full,
    clipped: full.width > clip.width + 0.5,
  };
}

const isect = (a, b) => {
  const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return ox > 0.5 && oy > 0.5 ? { width: ox, height: oy, left: Math.max(a.left, b.left), right: Math.min(a.right, b.right), top: Math.max(a.top, b.top), bottom: Math.min(a.bottom, b.bottom) } : null;
};

/** Every opaque thing painted on top of one day row's body. */
function overlaysOn(day) {
  const out = [];
  const more = $('.d-more', day);
  if (more) out.push({ name: '.d-more "' + more.textContent + '"', r: more.getBoundingClientRect() });
  const rows = day.parentElement;
  const dr = day.getBoundingClientRect();
  for (const lab of $$('.bar-label', rows)) {
    const lr = lab.getBoundingClientRect();
    if (isect(dr, lr)) out.push({ name: '.bar-label "' + lab.textContent.trim() + '"', r: lr });
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// §A1 · THE LEGAL CROWDED DAY — what eight people plus a Feiertag leave standing
// ═════════════════════════════════════════════════════════════════════════════

function auditRow(rowHeight) {
  return withBoard({ ...SCENE(), settings: { rowHeight, layers: { ...LEGAL }, hiddenMembers: {}, colWidth: 118 } }, (m) => {
    const day = dayNode();
    const notes = $$('.note', day);
    const hol = $('.d-hol', day);
    const more = $('.d-more', day);
    const ov = overlaysOn(day);
    const hits = [];
    let coveredPx = 0; let ownCoveredPx = 0; let ownVisible = 0;
    for (const n of notes) {
      const tb = textBox(n);
      const isOwn = !n.classList.contains('foreign');
      if (tb && isOwn) ownVisible += tb.visible.width;
      if (!tb) continue;
      for (const o of ov) {
        const i = isect(tb.visible, o.r);
        if (!i) continue;
        coveredPx += i.width;
        if (isOwn) ownCoveredPx += i.width;
        hits.push(`${isOwn ? 'MY' : 'their'} note "${n.textContent.trim()}" — ${px(i.width)} px of ${px(tb.visible.width)} px of text under ${o.name}`);
      }
    }
    // the holiday line is v1's own ink and is covered by the same overlays
    if (hol) {
      const hr = hol.getBoundingClientRect();
      for (const o of ov) {
        const i = isect(hr, o.r);
        if (i) hits.push(`Feiertag "${hol.textContent}" — ${px(i.width)} px under ${o.name}`);
      }
    }
    const model = m.cols.find((c) => c.key === COL.key).days.find((d) => d.date === DAY);
    return {
      rowHeight, capacity: L.rowCapacity(rowHeight),
      entriesOnTheDay: SCENE().notes.length,
      drawn: notes.length,
      holidayLine: !!hol, holidayDemoted: model.holidayDemoted,
      overflow: more ? more.textContent : '—',
      overflowCount: model.overflow,
      laneOverflow: model.laneOverflow,
      barsThroughTheDay: SCENE().bars.length,
      lanesDrawn: $$('.bar', day.parentElement).filter((b) => isect(day.getBoundingClientRect(), b.getBoundingClientRect())).length,
      overlays: ov.map((o) => o.name),
      hits, coveredPx: px(coveredPx), ownCoveredPx: px(ownCoveredPx), ownVisible: px(ownVisible),
    };
  });
}

test('§A1 · eight people + Feiertag + Ferien on one legal day, at 22 px and 18 px', () => {
  const a = auditRow(22);
  const b = auditRow(18);
  for (const r of [a, b]) {
    diag(`── ${r.rowHeight} px · capacity ${r.capacity} ────────────────────────────────`);
    diag(`   entries on the day ${r.entriesOnTheDay} (8 people) · DRAWN ${r.drawn} · „+n" ${r.overflow} (${r.overflowCount}, of which ${r.laneOverflow} are lanes)`);
    diag(`   Feiertag line drawn ${r.holidayLine} · demoted to a dot ${r.holidayDemoted}`);
    diag(`   bars through the day ${r.barsThroughTheDay} · stripes drawn ${r.lanesDrawn} of ${L.MAX_LANES} lanes`);
    diag(`   opaque overlays on the row: ${r.overlays.length ? r.overlays.join(' · ') : 'none'}`);
    diag(`   TEXT COVERED BY THEM: ${r.coveredPx} px total, ${r.ownCoveredPx} px of it MINE (my visible text on the row: ${r.ownVisible} px)`);
    for (const h of r.hits) diag(`     ! ${h}`);
  }

  const rows = [];
  // The row still IS the row. That much E8 delivered and it is re-checked here
  // with the layers ON, which the sibling suite could not do.
  rows.push({ id: 'principle-1/22px-row', ok: a.rowHeight === 22, why: 'row height moved' });
  // ⚠ What the brief asks: what silently disappears.
  rows.push({ id: 'A1/nothing-vanishes-uncounted', ok: a.overflowCount === a.entriesOnTheDay - a.drawn + a.laneOverflow,
    why: `${a.entriesOnTheDay - a.drawn} entries not drawn, „+n" accounts for ${a.overflowCount - a.laneOverflow}` });
  rows.push({ id: 'A1/18px-nothing-vanishes-uncounted', ok: b.overflowCount === b.entriesOnTheDay - b.drawn + b.laneOverflow,
    why: `${b.entriesOnTheDay - b.drawn} entries not drawn, „+n" accounts for ${b.overflowCount - b.laneOverflow}` });
  // ⚠ THE ADVERSARY'S CENTRAL CLAIM, AND THE PROPERTY THAT NOW HOLDS.
  // Principle 3: the user's own entries win. On this day — eight people, a
  // Feiertag, Schulferien, a weekend, three lanes full and „+9" on the row —
  // 15.1 px of her „Zahnarzt Kinder" used to be under the overflow badge, and
  // 15.1 px of the Feiertag line with it. Both are 0 px now: the badge and the
  // labels stand in the lane gutter the row had already reserved, and on the one
  // kind of row where both need it the badge takes width and the line truncates
  // in the open. Nothing is covered at either row height.
  rows.push({ id: 'principle-3/my-own-text-is-not-overprinted', ok: a.ownCoveredPx === 0,
    why: `${a.ownCoveredPx} px of MY OWN note text is painted over by an opaque overlay on this row` });
  rows.push({ id: '3.7/no-overlay-covers-any-entry-text', ok: a.coveredPx === 0,
    why: `${a.coveredPx} px of entry text is painted over: ${a.hits.join(' · ')}` });
  // The 18 px row is the harder half and had the same defect, so it is a cell of
  // its own rather than a line of diagnostics: at capacity 1 the one entry the
  // row can draw is the ONLY entry, and covering it covers the whole day.
  rows.push({ id: 'principle-3/18px-my-own-text-is-not-overprinted', ok: b.ownCoveredPx === 0,
    why: `${b.ownCoveredPx} px of MY OWN note text is painted over at 18 px: ${b.hits.join(' · ')}` });
  // And she still has a sentence left to read afterwards. A fix that reserved so
  // much width that the line went to nothing would satisfy every „covered === 0"
  // cell above and be a worse board than the one it replaced.
  rows.push({ id: 'principle-3/and-there-is-still-a-line-to-read', ok: a.ownVisible >= 20,
    why: `after the badge and the labels take their width, MY OWN text on the worst legal day is ${a.ownVisible} px` });
  verdict('§A1 · the legal crowded day', rows);
});

// ═════════════════════════════════════════════════════════════════════════════
// §A2 · THE „+n" BADGE STANDS BESIDE THE TEXT IT IS COUNTING — CLOSED
//
// WHAT THIS ROW FOUND. `app.css` drew the badge
// `position:absolute; right: calc(var(--gutter) + 1px); background: var(--chip)`
// — an OPAQUE box whose right edge sat 1 px INSIDE the `.d-body` content edge,
// i.e. inside the note's own text column. Measured on the fixture below: a
// 15.1 px lid over a 61 px line, 25 % of the reader's own sentence, INCLUDING
// the position WebKit puts the ellipsis in — so the characters went and the
// only cue that characters were missing went with them. v1 CSS, close to
// harmless on a solo board because most days never overflow; E8 made overflow
// the normal case (§A1: 8 entries into 2 slots) and the number two digits.
// Stories 2.4 and 2.5 both failed on it.
//
// WHAT CLOSED IT. The badge is still an overlay — that was never the defect —
// but it is parked in the LANE GUTTER instead of over the sentence:
// `right: calc(var(--gutter) - 2px - var(--more-w))`. The gutter is board
// furniture every row already reserves for the three bar lanes, so this costs
// `.d-body` nothing at all and `layout.js:FAMILY_LAYOUT_COST_PX`'s published
// `noteTextWidth: 0` stays true — a first pass made the badge a flex sibling
// instead, and `family-density.dom.js` §4 caught the family board's `.d-body`
// dropping 60 px → 42 px against exactly that claim. What the badge crosses now
// is lanes 1 and 2 where they carry a stripe: a stripe reads above and below a
// 10 px chip, a sentence does not, and this badge is what announces lane
// overflow in the first place.
//
// The audit in `family-density.dom.js` §1 could not have caught this: the thing
// being covered is a text node and its input is `note.children`.
// ═════════════════════════════════════════════════════════════════════════════

test('§A2 · „+n" is opaque, so it stands outside the text column and keeps the ellipsis', () => {
  const long = 'Elternsprechtag Grundschule';
  const scene = {
    notes: [
      own('own1', DAY, long),
      ...REAL.map((p, i) => foreign('g' + i, DAY, 'geteilt', { who: p, text: long })),
    ],
    bars: [],
  };
  const r = withBoard({ ...scene, settings: { rowHeight: 22, layers: { feiertage: false, schulferien: false, otherStates: false }, hiddenMembers: {}, colWidth: 118 } }, () => {
    const day = dayNode();
    const more = $('.d-more', day);
    const mr = more.getBoundingClientRect();
    const st = getComputedStyle(more);
    const out = [];
    for (const n of $$('.note', day)) {
      const tb = textBox(n);
      const i = tb && isect(tb.visible, mr);
      out.push({
        text: n.textContent.trim(),
        visibleTextPx: tb ? px(tb.visible.width) : 0,
        clipped: tb ? tb.clipped : false,
        coveredPx: i ? px(i.width) : 0,
      });
    }
    return {
      badge: more.textContent, badgeW: px(mr.width), badgeBg: st.backgroundColor,
      bodyRight: px($('.d-body', day).getBoundingClientRect().right),
      badgeLeft: px(mr.left),
      badgeRight: px(mr.right),
      // The row has no bar through it, so every one of the three lanes is free
      // and the badge should be leaning into the gutter rather than into the
      // sentence. `dayRight − badgeRight` is how much gutter it left unused.
      dayRight: px(day.getBoundingClientRect().right),
      notes: out,
    };
  });

  diag(`„+n" badge ${r.badge} · ${r.badgeW} px wide · background ${r.badgeBg} (still opaque — that is not the fix)`);
  diag(`   the badge's LEFT edge ${r.badgeLeft} px, the note text column's right edge ${r.bodyRight} px`);
  diag(`   → the badge starts ${px(r.badgeLeft - r.bodyRight)} px OUTSIDE the text column, and is ${r.badgeW} px wide`);
  diag(`   → it sits in the lane gutter: ${px(r.dayRight - r.badgeRight)} px short of the column edge, no stripe on this row`);
  for (const n of r.notes) {
    diag(`   "${n.text}" — ${n.visibleTextPx} px visible, ellipsised ${n.clipped}, ${n.coveredPx} px painted over by the badge`);
  }
  const worst = Math.max(...r.notes.map((n) => n.coveredPx));
  const pct = r.notes[0].visibleTextPx ? (worst / r.notes[0].visibleTextPx * 100).toFixed(0) : '0';
  diag(`   WORST: ${worst} px of a ${r.notes[0].visibleTextPx} px text column — ${pct} % of the reader's own line.`);
  diag('   Every note on the row is still ellipsised: the sentence is TRUNCATED in the open (2.5),');
  diag('   which is v1\'s own trade, and not hidden under a lid, which was never anybody\'s trade.');

  verdict('§A2 · the „+n" badge and the sentence', [
    // The row this file opened with. It is a property now, not a finding.
    { id: '2.4+2.5/badge-does-not-cover-text', ok: worst === 0,
      why: `the „+n" badge paints an opaque ${r.badgeW} px box over ${worst} px (${pct} %) of the note text it is counting` },
    // …and the MECHANISM, so a fix that merely moved the badge a few pixels — or
    // one that let a later edit put it back over the column — cannot pass by
    // accident on a fixture whose text happens to be short.
    { id: '2.4/badge-stands-outside-the-text-column', ok: r.badgeLeft >= r.bodyRight,
      why: `the badge's left edge is ${px(r.bodyRight - r.badgeLeft)} px inside the text column's right edge` },
    // It pays for itself out of the empty gutter, not out of her line: with no
    // stripe on the row the badge must sit entirely right of `.d-body`.
    { id: '2.4/an-unused-lane-pays-for-the-badge', ok: r.badgeRight > r.bodyRight && r.badgeRight <= r.dayRight + 0.5,
      why: `badge ${r.badgeLeft}…${r.badgeRight} px against a text column ending at ${r.bodyRight} px and a row ending at ${r.dayRight} px` },
    // The ellipsis is the other half of 2.5: the reader must be able to SEE that
    // the sentence continues. It was the first thing the old lid ate.
    { id: '2.5/the-ellipsis-survives', ok: r.notes.every((n) => n.clipped),
      why: `${r.notes.filter((n) => !n.clipped).length} of ${r.notes.length} over-long notes are not reported as clipped` },
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════
// §A3 · 3.7's LABEL PLACEMENT — the guarantee, and how it now survives a family
//
// DESIGN-DECISIONS §C: „Label placement (3.7) scans the first six rows of each
// month segment for one carrying NO holiday text, NO note and NO `+n` badge, and
// puts the chip there. So the chip lands on empty space rather than covering the
// user's own ink."
//
// WHAT THIS ROW FOUND. `layout.js`'s own E8 comment concedes pass A („no ink at
// all") is reached at 0 % on the 8-member fixture, and adds passes B/C/D — which
// choose the LEAST INKED row and, failing that, ANY row. Passes B–D avoid
// label-on-LABEL. Nothing avoided label-on-NOTE, and `.bar-label` is opaque, up
// to 66 px wide and positioned across the note's whole text column. Measured:
// 98 of 142 family labels (69 %) were painted over an entry's text, 46 of them
// over the OWNER'S own, 955.7 px of her sentences buried under 18 356 px² of
// somebody else's chip. Solo was not clean either — 3 of 35.
//
// WHAT CLOSED IT, AND WHY NOT IN THE SCAN. When 99 % of day rows carry ink there
// is no ink-free row to move to; a better scan cannot exist. So the fix is a
// priority rule, not a search: `board.js` marks a label that landed on a written
// row `.on-ink`, and `app.css` caps it to a strip the row reserves for it
// (`.day.claimed`). The label gives width back and keeps its identity marks; the
// sentence truncates with its ellipsis, in the open, where the reader can see
// that there is more. Principle 3 — her ink wins — decides which of the two
// yields, and the answer is never her sentence.
//
// This measures the promise directly, solo against family, on the same fixture.
// ═════════════════════════════════════════════════════════════════════════════

/** The perf fixture LZP-1007 names, deterministic (no `Math.random`). */
function fixture8x2() {
  let seed = 20260901;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const TXT = ['Chorprobe', 'Zahnarzt', 'Elternabend', 'Yoga', 'Turnier', 'Ballett', 'Kur', 'Konferenz'];
  const LBL = ['Urlaub', 'Projekt', 'Kur', 'Dienstreise', 'Ferienlager'];
  const notes = []; const bars = [];
  const DAYS = 730;
  const day0 = new Date(Date.UTC(COL.y, COL.m - 1, 1) - 180 * 86400000);
  const at = (i) => new Date(day0.getTime() + i * 86400000).toISOString().slice(0, 10);
  const people = [{ id: 'mem_me', me: true }].concat(REAL);
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

/** Every `.bar-label` on the board, against every `.note`, `.d-hol` and `.d-more` it covers. */
function labelOverprint() {
  const labels = $$('#board .bar-label');
  let covered = 0; let coveredOwn = 0; let labelsThatCover = 0; let labelsThatCoverMine = 0;
  let coveredBadges = 0;
  let inkArea = 0;
  const examples = [];
  for (const lab of labels) {
    const lr = lab.getBoundingClientRect();
    const col = lab.closest('.col');
    let touchedAny = false; let touchedMine = false;
    for (const n of $$('.note', col)) {
      const tb = textBox(n);
      if (!tb) continue;
      const i = isect(tb.visible, lr);
      if (!i) continue;
      touchedAny = true;
      const mine = !n.classList.contains('foreign');
      if (mine) touchedMine = true;
      covered += i.width;
      inkArea += i.width * i.height;
      if (mine) coveredOwn += i.width;
      if (examples.length < 6) examples.push(`"${lab.textContent.trim()}" covers ${px(i.width)} px of ${mine ? 'MY' : 'their'} "${n.textContent.trim()}" (${px(tb.visible.width)} px visible)`);
    }
    for (const hl of $$('.d-hol', col)) {
      if (isect(hl.getBoundingClientRect(), lr)) { touchedAny = true; }
    }
    // The „+n" badge counts what the row could not draw (2.4 — „nothing
    // vanishes uncounted"), and a count nobody can read has vanished. Both the
    // label and the badge now live in the 27 px lane gutter, which does not hold
    // two of them side by side, so this is the collision the arrangement has to
    // keep impossible rather than the one it happens to avoid.
    for (const mo of $$('.d-more', col)) {
      if (isect(mo.getBoundingClientRect(), lr)) coveredBadges++;
    }
    if (touchedAny) labelsThatCover++;
    if (touchedMine) labelsThatCoverMine++;
  }
  // WHAT THE LABEL STILL SAYS. „Nothing overprints" is trivially satisfiable by
  // not drawing the label, or by shrinking it to a sliver, and either would be a
  // worse board than the one with the defect. So the audit also counts the
  // labels that survive as something a reader can use: a chip wide enough for
  // the 8 px initial (17.2) and a text node still in it.
  let narrowest = Infinity; let stillNamed = 0;
  for (const lab of labels) {
    const w = lab.getBoundingClientRect().width;
    if (w < narrowest) narrowest = w;
    for (const n of lab.childNodes) if (n.nodeType === 3 && n.textContent.trim()) { stillNamed++; break; }
  }
  return {
    labels: labels.length, labelsThatCover, labelsThatCoverMine,
    covered: px(covered), coveredOwn: px(coveredOwn), inkArea: px(inkArea), examples,
    narrowest: labels.length ? px(narrowest) : 0, stillNamed, coveredBadges,
  };
}

test('§A3 · at family density a bar label lands BESIDE the user\'s own note text, not on it', () => {
  const settings = { rowHeight: 22, layers: { ...LEGAL }, hiddenMembers: {}, colWidth: 118 };
  const solo = withBoard({ notes: FX.notes.filter((n) => !n.isForeign), bars: FX.bars.filter((b) => !b.isForeign), settings },
    () => ({ ...labelOverprint(), notes: $$('#board .note').length }));
  const family = withBoard({ ...FX, settings }, () => ({ ...labelOverprint(), notes: $$('#board .note').length }));

  diag(`fixture ${FX.notes.length} notes / ${FX.bars.length} bars · 8 people · 2 years · ALL LAYERS ON`);
  diag(`solo   ${solo.labels} bar labels · ${solo.labelsThatCover} overprint an entry (${(solo.labelsThatCover / Math.max(1, solo.labels) * 100).toFixed(0)} %) · ${solo.covered} px of text buried · ${solo.coveredOwn} px of it MINE`);
  diag(`family ${family.labels} bar labels · ${family.labelsThatCover} overprint an entry (${(family.labelsThatCover / Math.max(1, family.labels) * 100).toFixed(0)} %) · ${family.covered} px of text buried · ${family.coveredOwn} px of it MINE`);
  diag(`family: ${family.labelsThatCoverMine} of ${family.labels} labels bury MY OWN text (${(family.labelsThatCoverMine / Math.max(1, family.labels) * 100).toFixed(0)} %) · buried ink ${family.inkArea} px²`);
  for (const e of family.examples) diag('   ! ' + e);
  diag(`   labels that still name themselves: solo ${solo.stillNamed}/${solo.labels} · family ${family.stillNamed}/${family.labels}`);
  diag(`   narrowest label on the board: solo ${solo.narrowest} px · family ${family.narrowest} px (3.3 — a bar's only name on the board)`);
  diag(`   the ONE promise: DESIGN-DECISIONS §C — „the chip lands on empty space rather than covering the user's own ink".`);

  verdict('§A3 · 3.7 label placement', [
    { id: '3.7/labels-land-on-empty-space', ok: family.labelsThatCover === 0,
      why: `${family.labelsThatCover} of ${family.labels} bar labels are painted over an entry's text (solo: ${solo.labelsThatCover} of ${solo.labels})` },
    { id: 'principle-3/my-ink-wins', ok: family.coveredOwn === 0,
      why: `${family.coveredOwn} px of MY OWN note text is buried under a bar label on the family board (solo: ${solo.coveredOwn} px)` },
    // v1's OWN board had the defect too, at 9 %. A family-only fix would have
    // left it there, so the solo half is a cell and not a footnote.
    { id: '3.7/solo-labels-land-on-empty-space-too', ok: solo.labelsThatCover === 0,
      why: `${solo.labelsThatCover} of ${solo.labels} bar labels overprint an entry on a SOLO board — this was v1's own 9 %` },
    // ⚠ THE COUNTERWEIGHT. Every cell above is satisfied by a board that draws
    // no labels at all, or draws them as slivers. 3.3 says the label is where a
    // bar says what it is; it may yield width, it may not stop existing.
    { id: '3.3/every-bar-still-names-itself', ok: family.stillNamed === family.labels && family.labels > 0,
      why: `${family.labels - family.stillNamed} of ${family.labels} bar labels lost their text node` },
    { id: '3.3/no-label-is-narrower-than-its-own-initial-chip', ok: family.narrowest >= 14,
      why: `the narrowest label on the family board is ${family.narrowest} px — the 17.2 initial chip alone is 10 px` },
    // …and the retreat did not simply move the overprint onto the other thing
    // standing in the gutter. A „+n" nobody can read is an entry that vanished.
    { id: '2.4/a-retreating-label-does-not-bury-the-„+n"', ok: family.coveredBadges === 0,
      why: `${family.coveredBadges} „+n" badges are painted over by a bar label on the family board (solo: ${solo.coveredBadges})` },
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════
// §A4 · THE INK ITSELF — contrast at 9 px, on the four ambient backgrounds
//
// `palette.js`'s own header states the constraint every tone had to pass:
//   „≥ 4.5:1 against #FFFFFF so note text stays legible at 9px"
//   „readable on top of every ambient shade (#F2EEFC / #FAF8FE / #E6DEF8)"
//
// E8 introduces TWO inks that were never measured against it, because neither
// existed in v1: `UNKNOWN_MEMBER_COLOR` (the tone a foreign entry falls back to
// when the member record has not arrived — precisely the entry the reader
// understands least) and the „Belegt" word, which is `--ink-3` on `--chip`.
// Both are computed from what the engine actually resolved, not from the source.
// ═════════════════════════════════════════════════════════════════════════════

const rgb = (s) => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
const lin = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (fg, bg) => {
  const a = lum(rgb(fg)); const b = lum(rgb(bg));
  return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
};
const hexToRgb = (h) => `rgb(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)})`;

test('§A4 · every ink E8 puts on the board at 9 px, against every ambient shade', () => {
  const cs = getComputedStyle(document.documentElement);
  const BG = {
    'white': cs.getPropertyValue('--surface').trim(),
    'weekend': cs.getPropertyValue('--bg-weekend').trim(),
    'ferien': cs.getPropertyValue('--bg-ferien').trim(),
    'weekend+ferien': cs.getPropertyValue('--bg-weekend-ferien').trim(),
    'today': cs.getPropertyValue('--bg-today').trim(),
    'Belegt pill (--chip)': cs.getPropertyValue('--chip').trim(),
  };
  const INK = {};
  for (const p of PALETTE) INK[`member/category ${p.ref}`] = p.hex;
  INK['E8 UNKNOWN_MEMBER_COLOR'] = L.UNKNOWN_MEMBER_COLOR;
  INK['E8 „Belegt" word (--ink-3)'] = cs.getPropertyValue('--ink-3').trim();

  const FLOOR = 4.5;   // palette.js's OWN stated constraint, at 9 px
  const rows = [];
  const failures = [];
  diag('ink                            ' + Object.keys(BG).map((k) => k.padStart(11)).join(''));
  for (const [name, hex] of Object.entries(INK)) {
    const fg = hex.startsWith('#') ? hexToRgb(hex) : hex;
    const line = [];
    for (const [bn, bh] of Object.entries(BG)) {
      const bg = bh.startsWith('#') ? hexToRgb(bh) : bh;
      const r = ratio(fg, bg);
      line.push(String(r).padStart(11));
      if (bn === 'Belegt pill (--chip)' && !name.includes('Belegt')) continue;   // only the word sits on the pill
      if (r < FLOOR) failures.push(`${name} on ${bn}: ${r}:1`);
    }
    diag(name.padEnd(31) + line.join(''));
  }
  diag(`floor: ${FLOOR}:1 — palette.js's own constraint for 9 px note text.`);
  for (const f of failures) diag('   x ' + f);

  // Split so the report names v1's debt separately from E8's.
  const v1Fails = failures.filter((f) => !f.startsWith('E8'));
  const e8Fails = failures.filter((f) => f.startsWith('E8'));
  rows.push({ id: 'v1/palette-holds-its-own-floor', ok: v1Fails.length === 0, why: v1Fails.join(' · ') });
  rows.push({ id: 'E8/new-inks-hold-the-same-floor', ok: e8Fails.length === 0, why: e8Fails.join(' · ') });
  verdict('§A4 · 9 px ink contrast', rows);
});

// ═════════════════════════════════════════════════════════════════════════════
// §A5 · THE FERIEN HATCH BEHIND 9 px TYPE — v1's own „off by default" reason,
// and what a Belegt pill does on top of it.
//
// WHAT THIS ROW FOUND. 1k's hatch is a 1 px stroke every 5 px. v1's „neu" dot
// (17.5) was a 3 × 3 px disc — SMALLER THAN THE HATCH PERIOD — so the board's
// only signal that a peer changed something had to be told apart from the
// wallpaper it was drawn on. Two marks of the same order are a moiré, not a
// distinction, and „turn the hatch off again" is not an answer to a setting the
// product ships.
//
// WHAT CLOSED IT. The dot now carries its own ground: `app.css` draws it as a
// 5 px OPAQUE PLATE — one full hatch period across — with the 3 px accent disc
// and its hairline ring inside. The texture stops at the mark's edge instead of
// running through it, and the same plate makes the dot readable on every ambient
// shade, not only on the hatch. It costs the identical 5 px `PREFIX_COST_PX`
// already priced (v1 spent 3 px of disc plus 2 px of margin), so nothing was
// bought here with a character of anybody's sentence.
// ═════════════════════════════════════════════════════════════════════════════

// A Ferien day WITHOUT a Feiertag, so the capacity rule leaves room for a
// peer's entry and its „neu" dot — the mark this section is actually about.
const FERIEN_ONLY = (() => {
  for (const c of M0.cols) {
    for (const d of c.days) if (!d.empty && d.ferien && !d.holiday && !d.isToday) return { c, d };
  }
  return null;
})();

test('§A5 · with „Ferien schraffieren" on, the family marks still separate from the texture', () => {
  if (!FERIEN_ONLY) { skip('no Ferien day without a Feiertag in this window'); return; }
  const FCOL = FERIEN_ONLY.c; const FDAY = FERIEN_ONLY.d.date;
  diag(`   the hatched day: ${FDAY} — ${FERIEN_ONLY.d.ferienName}`);
  document.body.classList.add('ferien-hatch');
  try {
    const scene = {
      notes: [foreign('h1', FDAY, 'geteilt', { who: REAL[0], text: 'Chorprobe', isNew: true, repeatsYearly: true })],
      bars: [],
    };
    // The period is READ from the shipped token, never assumed: if somebody
    // retunes 1k's hatch, this row has to re-decide rather than keep quoting 5.
    const hatchDecl = getComputedStyle(document.documentElement).getPropertyValue('--ferien-hatch');
    const stops = (hatchDecl.match(/-?\d+(\.\d+)?px/g) || []).map(parseFloat);
    const PERIOD = stops.length ? Math.max(...stops) : 5;

    const r = withBoard({ ...scene, settings: { rowHeight: 22, layers: { ...LEGAL }, hiddenMembers: {}, colWidth: 118 } }, () => {
      const day = $(`#board .col[data-month="${FCOL.key}"] .day[data-date="${FDAY}"]`);
      const marks = [];
      for (const n of $$('.note', day)) for (const c of n.children) marks.push({ n: c.className, r: c.getBoundingClientRect(), el: c });
      const st = day ? getComputedStyle(day) : null;
      const dot = $('.neu-dot', day);
      const dst = dot ? getComputedStyle(dot) : null;
      return {
        ferien: day.classList.contains('fer'),
        bgImage: st ? st.backgroundImage.slice(0, 60) : '',
        smallest: marks.length ? px(Math.min(...marks.map((m) => Math.min(m.r.width, m.r.height)))) : 0,
        smallestName: marks.length ? marks.slice().sort((a, b) => area(a.r) - area(b.r))[0].n : '—',
        marks: marks.length,
        // What the 17.5 dot costs the line, box + margins, against the number
        // `layout.js` publishes. The plate may not be bought with characters.
        dotW: dot ? px(dot.getBoundingClientRect().width) : 0,
        dotCost: dot
          ? px(dot.getBoundingClientRect().width
              + parseFloat(dst.marginLeft || 0) + parseFloat(dst.marginRight || 0))
          : 0,
        // The plate is what makes the mark readable ON the texture: an opaque
        // ground drawn inside the mark's own box, not a colour laid over it.
        dotPlate: dst ? (dst.backgroundImage || '') : '',
      };
    });
    diag(`hatch on · day in Ferien: ${r.ferien} · background-image ${r.bgImage || 'none'}`);
    diag(`   the hatch token declares a ${PERIOD} px period; ${r.marks} marks on the row, smallest ${r.smallest} px (${r.smallestName})`);
    diag(`   the 17.5 „neu" dot: ${r.dotW} px of box, ${r.dotCost} px of line (PREFIX_COST_PX.neu = ${L.PREFIX_COST_PX.neu})`);
    diag(`   its ground: ${r.dotPlate.slice(0, 90)}`);
    diag('   The mark is one full hatch period across and paints its own opaque plate, so the texture');
    diag('   stops at its edge — and the same plate carries it on the weekend, Ferien and today shades.');
    verdict('§A5 · the hatch under the badges', [
      { id: '1k/hatch-period-vs-smallest-mark', ok: r.smallest >= PERIOD,
        why: `the smallest E8 mark is ${r.smallest} px against a ${PERIOD} px hatch period — the „neu" dot (17.5) is smaller than the texture it has to be seen against` },
      // ⚠ THE COUNTERWEIGHT, and the reason this was not fixed by enlarging.
      // A 7 px dot would clear the hatch and quietly take two more characters
      // off every peer entry on the board.
      { id: '1k/the-mark-did-not-buy-it-with-her-line', ok: r.dotCost <= L.PREFIX_COST_PX.neu,
        why: `the „neu" dot now costs ${r.dotCost} px of the text line, and PREFIX_COST_PX prices it at ${L.PREFIX_COST_PX.neu} px` },
      // And the mechanism: the mark has a ground of its own, so it does not
      // depend on the row it happens to land on.
      { id: '17.5/the-mark-carries-its-own-ground', ok: /gradient/.test(r.dotPlate),
        why: `the „neu" dot's background is ${JSON.stringify(r.dotPlate)} — a flat fill has no plate, so the texture runs through the mark` },
    ]);
  } finally {
    document.body.classList.remove('ferien-hatch');
  }
});
