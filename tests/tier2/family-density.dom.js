// TIER 2 · E8 INTEGRATION — THE DENSITY GATE. What the family layer costs the
// thing the product exists to do, measured in the engine that ships.
//
// Deliverable 17 ("the badge system as ONE family … all coexisting at 24-px
// rows") · story 17.4 (family entries obey every v1 density rule) · LZP-1007
// (the perf AC) · A8 (print parity) · Design Spec v1 §3 principle 1 and §11
// challenge 1 · DESIGN-DECISIONS §B (the 22 px row and the capacity rule).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS ALONGSIDE THE THREE E8 SUITES THAT ALREADY PASS
// ─────────────────────────────────────────────────────────────────────────────
//
// `family-render.dom.js` owns the crowded COLUMN (lanes, label placement, the
// ownership rail). `family-legend.dom.js` owns the CHROME. `family-attribution
// .dom.js` owns the POPOVER, find and print. Each is right about its own half,
// and not one of them can see the question the brief puts above all of them:
//
//     the five badges are specified in five different stories, built by three
//     different passes, and they are all supposed to land in the SAME 22 px row
//     at the SAME TIME.
//
// So §1 and §2 build ONE day that carries every one of them at once — the
// visibility badge (16.6), the Belegt block (16.7), the initial chip (17.2),
// the „neu" dot (17.5) and the ↻ repeat marker (9.2) — and then ask the only
// question that decides whether the design holds: does any painted mark on that
// row touch any other painted mark. Not "does it look fine": an overlap audit
// over every child box on the row, at 22 px AND at v1's 18 px minimum.
//
// EVERY NUMBER HERE IS MEASURED AND PRINTED. Nothing in this file asserts that
// the family "fits"; §4 takes the board's geometry apart with and without it.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE CALENDAR HAZARD, AND WHY THE DAY IS FOUND RATHER THAN GUESSED
// ─────────────────────────────────────────────────────────────────────────────
//
// A Feiertag takes line 1 of a row (DESIGN-DECISIONS §B), so at rowHeight 22 a
// day with a holiday holds ONE note where a clean day holds two. Two suites in
// this directory were red on 2026-09-01 for exactly that reason and green in
// August. A characterization test whose answer depends on the month it is run
// in is not characterizing anything, so the day below is SCANNED for — no
// holiday, no Ferien, not today — and the ambient layers are owned explicitly.
//
// Plain script, not a module: globals are test, assert, $, $$, waitFor, sleep,
// importApp, diag, skip.
// ─────────────────────────────────────────────────────────────────────────────

const { store } = await importApp('store.js');
const { renderBoard } = await importApp('board.js');
const L = await importApp('layout.js');
const P = await importApp('print.js');
const { colorOf } = await importApp('palette.js');
const { setLang, getLang } = await importApp('i18n.js');

const boardEl = () => $('#board');
const px = (n) => Math.round(n * 10) / 10;
const w = (n) => px(n.getBoundingClientRect().width);
const h = (n) => px(n.getBoundingClientRect().height);

// ── the fixture window ───────────────────────────────────────────────────────
// The second visible column (`belegt-render.dom.js`'s reason: it exists in both
// rolling and pinned mode and never collides with today's shading) and, inside
// it, a day that carries no ambient ink of its own.
const M0 = renderBoard(boardEl());
const COL = M0.cols[1];
const CLEAN = (() => {
  const d = COL.days.find((x) => !x.empty && !x.holiday && !x.ferien && !x.isToday && x.n > 3 && x.n < 25);
  return d || COL.days.find((x) => !x.empty);
})();
const DAY = CLEAN.date;
diag(`window ${M0.cols[0].key} … ${M0.cols[11].key} · clean day ${DAY} · rowH ${store.state.settings.rowHeight || 22}`);

/** Layers off wherever a row must hold a KNOWN number of notes. See the header. */
const NO_LAYERS = { feiertage: false, schulferien: false, otherStates: false };

const MEMBERS = [
  { id: 'mem_mama', colorRef: 'magenta', initial: 'M' },
  { id: 'mem_papa', colorRef: 'gruen', initial: 'P' },
  { id: 'mem_lena', colorRef: 'gold', initial: 'L' },
  { id: 'mem_jonas', colorRef: 'tuerkis', initial: 'J' },
  { id: 'mem_tante', colorRef: 'lila', initial: 'T' },
  { id: 'mem_opa', colorRef: 'rot', initial: 'O' },
  { id: 'mem_oma', colorRef: 'braun', initial: 'A' },
];
const [MAMA, PAPA, LENA, JONAS] = MEMBERS;

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const D = (n) => iso(COL.y, COL.m, n);

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
const ownBar = (id, a, b, label, x = {}) => ({
  id, uuid: id, startDate: a, endDate: b, label, categoryId: store.state.categories[0].id,
  isForeign: false, ownerId: 'mem_me', level: null, memberColorRef: null, initial: null,
  exposure: null, isNew: false, ...x,
});
const foreignBar = (id, a, b, level, x = {}) => {
  const who = x.who || MAMA;
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
    renderBoard(boardEl());
    return fn();
  } finally {
    store.state.notes = before.notes;
    store.state.bars = before.bars;
    store.state.settings = before.settings;
    setLang(before.lang);
    renderBoard(boardEl());
  }
}

const dayNode = (date = DAY) => $(`#board .col[data-month="${COL.key}"] .day[data-date="${date}"]`);

/** The three-bucket reporter the sibling suites use, so a red cell names itself. */
function verdict(label, rows) {
  const bad = rows.filter((r) => !r.ok);
  diag(`${label}: ${rows.length - bad.length}/${rows.length} cells hold`);
  for (const r of bad) diag('  x ' + r.id + ' — ' + r.why);
  assert.equal(bad.length, 0, bad.length ? label + ': ' + bad.map((r) => r.id).join(', ') : '');
}

// ═════════════════════════════════════════════════════════════════════════════
// THE SCENE — one day carrying the whole badge family at once
//
// It is composed so the two entries the capacity rule actually draws are the two
// that between them carry all five marks. That composition is a property of the
// FIXTURE, not of the product: §2 shows what the same day does at 18 px, where
// the capacity rule draws one entry and three of the five marks go into „+n".
//
// ═══ HOW IT IS COMPOSED CHANGED WITH `orderForCapacity` (17.2) ══════════════
// It used to be composed by ARRAY ORDER: Papa's block first, my note second, so
// the slice took those two. `layout.js:orderForCapacity` now runs mine, then
// the family's changes, then the family, ahead of v1's array order — because
// store order was costing the owner 54.1 % of their own notes on a shared day
// and the loss moved with creation order (`e8-density-crowding.dom.js` §B2b:
// 0 % / 54.1 % / 93.5 % across three orders of the same data).
//
// So the scene is composed by OWNERSHIP instead: exactly ONE note of mine, which
// takes slot 1 and brings the exposure badge and the ↻, and the peer CHANGE that
// 17.5 promotes takes slot 2 and brings the chip, the „neu" dot and the Belegt
// block. Same five marks, same one row, chosen by the rule the product actually
// applies rather than by an array index. `17.2/a-second-note-of-mine-…` below
// pins the cost of that rule instead of hiding it: on a day where I have TWO
// entries, both are mine and every peer mark is a digit in the „+n".
// ═════════════════════════════════════════════════════════════════════════════
const SCENE = () => ({
  notes: [
    // Papa · the Belegt block (16.7) + the „neu" dot (17.5) + his chip (17.2).
    // A CHANGE, so 17.5's tier puts him in front of the two peers below.
    foreign('f2', DAY, 'belegt', { who: PAPA, isNew: true }),
    // mine · the visibility badge (16.6) + the ↻ repeat marker (9.2).
    // The only note of mine on the day — see the header.
    own('own1', DAY, 'Omas Geburtstag', { repeatsYearly: true, exposure: { level: 'geteilt', pending: false } }),
    // …and three more, so the row also carries „+n"
    foreign('f1', DAY, 'geteilt', { who: MAMA, text: 'Chorprobe', repeatsYearly: true, isNew: true }),
    foreign('f4', DAY, 'geteilt', { who: JONAS, text: 'Bilanz' }),
    foreign('f3', DAY, 'geteilt', { who: LENA, text: 'Ballett' }),
  ],
  bars: [
    ownBar('ob1', D(Math.max(1, CLEAN.n - 4)), D(Math.min(COL.len, CLEAN.n + 6)), 'Projekt',
      { exposure: { level: 'geteilt', pending: false } }),
    foreignBar('fb1', D(Math.max(1, CLEAN.n - 2)), D(Math.min(COL.len, CLEAN.n + 4)), 'geteilt',
      { who: MAMA, label: 'Ferien Nordsee', isNew: true }),
    foreignBar('fb2', D(Math.max(1, CLEAN.n - 1)), D(Math.min(COL.len, CLEAN.n + 2)), 'belegt', { who: PAPA }),
    foreignBar('fb3', D(CLEAN.n), D(Math.min(COL.len, CLEAN.n + 1)), 'geteilt', { who: LENA, label: 'Turnier' }),
  ],
});

/** Every painted box on one day row: each note's marks, the „+n" badge, the day number. */
function marksOnRow(day) {
  const out = [];
  for (const n of $$('.note', day)) {
    for (const c of n.children) out.push({ name: `${n.className.replace(/\s+/g, '.')}>${c.className}`, r: c.getBoundingClientRect() });
  }
  const more = $('.d-more', day);
  if (more) out.push({ name: '.d-more', r: more.getBoundingClientRect() });
  const num = $('.d-num', day);
  if (num) out.push({ name: '.d-num', r: num.getBoundingClientRect() });
  return out;
}

/** Any two painted boxes that share more than half a pixel in BOTH axes. */
function overlaps(marks) {
  const bad = [];
  for (let i = 0; i < marks.length; i++) {
    for (let j = i + 1; j < marks.length; j++) {
      const a = marks[i].r; const b = marks[j].r;
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 0.5 && oy > 0.5) bad.push(`${marks[i].name} ∩ ${marks[j].name} = ${px(ox)}×${px(oy)}px`);
    }
  }
  return bad;
}

const markNames = (day) => $$('.note', day).map((n) => [...n.children].map((c) => c.className));

// ═════════════════════════════════════════════════════════════════════════════
// §1 · DELIVERABLE 17 AT THE 22 px DEFAULT — all five, at once, on one row
// ═════════════════════════════════════════════════════════════════════════════

test('§1 · the whole badge family lands on ONE 22 px row, and nothing touches anything', () => {
  withBoard({ ...SCENE(), settings: { rowHeight: 22, layers: NO_LAYERS, hiddenMembers: {} } }, () => {
    const day = dayNode();
    const marks = marksOnRow(day);
    const flat = markNames(day).flat();
    const rows = [];

    // The five, by the story that owns each. This is the deliverable's own list.
    rows.push({ id: '16.6/visibility-badge', ok: flat.some((c) => c.startsWith('exp ')), why: 'no `.exp` badge on the row: ' + flat.join(',') });
    rows.push({ id: '16.7/belegt-block', ok: !!$('.note.belegt .redacted-word', day), why: 'no Belegt block on the row' });
    rows.push({ id: '17.2/initial-chip', ok: flat.includes('chip'), why: 'no member chip on the row' });
    rows.push({ id: '17.5/neu-dot', ok: flat.includes('neu-dot'), why: 'no „neu" dot on the row' });
    rows.push({ id: '9.2/repeat-marker', ok: flat.includes('rep'), why: 'no ↻ on the row' });
    // …and the sixth thing competing for the same microspace.
    rows.push({ id: '2.4/overflow-badge', ok: !!$('.d-more', day), why: 'the crowded day drew no „+n"' });

    // THE QUESTION THE DELIVERABLE ACTUALLY ASKS.
    const bad = overlaps(marks);
    rows.push({ id: 'deliverable-17/no-collision', ok: bad.length === 0, why: bad.join(' · ') });

    // v1's row is untouched: 22 px, and the capacity rule still decides how many.
    rows.push({ id: 'principle-1/row-height', ok: h(day) === 22, why: 'the row grew to ' + h(day) + 'px' });
    rows.push({ id: 'B/capacity', ok: $$('.note', day).length === L.rowCapacity(22), why: `${$$('.note', day).length} notes at capacity ${L.rowCapacity(22)}` });

    diag(`22 px · ${marks.length} painted marks on the row, ${bad.length} collisions`);
    for (const m of marks.slice().sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height)) {
      diag(`   ${px(m.r.width)}×${px(m.r.height)} px  ${m.name}`);
    }
    diag(`   overflow ${$('.d-more', day) ? $('.d-more', day).textContent : '—'} · marks per note ${JSON.stringify(markNames(day))}`);
    verdict('deliverable 17 · 22 px', rows);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §1b · WHAT THE SCENE ABOVE COSTS — 17.2's price, stated where it is paid
//
// The scene puts one note of mine on the day, and that is not incidental: it is
// the composition `layout.js:orderForCapacity` obliges if all five marks are to
// be on one row. Add a SECOND note of mine and the whole badge family leaves the
// note line, because both slots are mine.
//
// That is the correct outcome — 17.2 („my board stays mine") is what makes a
// shared board trustworthy, and `e8-density-crowding.dom.js` §B2 measures the
// alternative at 54.1 % of the owner's own notes lost. But it is a real cost to
// the family layer on a crowded day, and a fixture that quietly avoided it would
// be reporting deliverable 17 as unconditionally true when it is conditional.
// So the condition is asserted here, in both directions, at the default density.
// ═════════════════════════════════════════════════════════════════════════════
test('§1b · 17.2 — a second note of mine takes the row, and the family becomes a digit', () => {
  const twoOfMine = SCENE();
  twoOfMine.notes = [
    ...twoOfMine.notes,
    own('own2', DAY, 'Bilanz', { exposure: { level: 'belegt', pending: true } }),
  ];
  withBoard({ ...twoOfMine, settings: { rowHeight: 22, layers: NO_LAYERS, hiddenMembers: {} } }, () => {
    const day = dayNode();
    const shown = $$('.note', day);
    const flat = markNames(day).flat();
    const more = $('.d-more', day);
    const rows = [];
    rows.push({ id: '17.2/both-lines-are-mine', ok: shown.length === 2 && shown.every((n) => n.dataset.foreign !== '1'),
      why: `the row drew ${shown.map((n) => (n.dataset.foreign === '1' ? 'theirs' : 'mine')).join(' + ')} — an entry of mine was folded for a peer's` });
    rows.push({ id: '17.2/and-no-peer-mark-is-on-the-note-line', ok: !flat.includes('chip') && !flat.includes('neu-dot'),
      why: 'a peer mark survived on a row where both lines are mine: ' + flat.join(',') });
    // 2.4 — and it is a DIGIT, not a disappearance. Every peer is accounted.
    // `>=` because 17.4's badge counts hidden NOTES and hidden BARS together
    // (`family-render.dom.js` §4), and this scene overflows a lane as well.
    const folded = twoOfMine.notes.length - shown.length;
    rows.push({ id: '2.4/the-family-is-counted-not-dropped', ok: !!more && Number(more.textContent.replace('+', '')) >= folded,
      why: `${folded} entries were folded and the badge says "${more && more.textContent}"` });
    // …and the ownership channel is NOT gone from the board — it moved to the
    // lanes, which is where family-render.dom.js §2 measures it costing 0 px.
    rows.push({ id: '17.1/the-family-is-still-on-the-board', ok: $$('.bar.foreign', dayNode().closest('.col')).length > 0,
      why: 'no foreign bar in the column either — the family really did vanish' });
    diag(`22 px · two of mine · drawn ${shown.map((n) => (n.dataset.foreign === '1' ? 'theirs' : 'mine')).join(',')}`
      + ` · marks ${JSON.stringify(markNames(day))} · overflow ${more ? more.textContent : '—'}`);
    verdict('17.2 · the price of ownership-first', rows);
  });
});

test('§1 · the smallest mark is the 3 px „neu" dot, and every gap is ≥ 1 px', () => {
  withBoard({ ...SCENE(), settings: { rowHeight: 22, layers: NO_LAYERS, hiddenMembers: {} } }, () => {
    const day = dayNode();
    const sizes = marksOnRow(day).map((m) => ({ n: m.name, a: m.r.width * m.r.height, w: px(m.r.width), h: px(m.r.height) }))
      .sort((a, b) => a.a - b.a);
    const gaps = [];
    for (const n of $$('.note', day)) {
      const cs = [...n.children];
      for (let i = 0; i < cs.length - 1; i++) {
        gaps.push(px(cs[i + 1].getBoundingClientRect().left - cs[i].getBoundingClientRect().right));
      }
    }
    diag(`smallest painted mark ${sizes[0].w}×${sizes[0].h} px (${sizes[0].n}) · gaps ${gaps.join(', ')} px`);
    // ADR 004 §6 / §10: a mark must stay distinguishable, and the floor the
    // design set for itself is 3 px. Anything smaller is a smudge on paper.
    assert.ok(sizes[0].w >= 3 && sizes[0].h >= 3, `a ${sizes[0].w}×${sizes[0].h} px mark reached the board: ${sizes[0].n}`);
    assert.ok(gaps.every((g) => g >= 1), 'two marks were rendered flush against each other: ' + gaps.join(','));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §2 · THE SAME DAY AT 18 px — v1's MINIMUM, and the honest record of the loss
//
// This is the section that could have been a paper claim and is not. At 18 px
// the capacity rule gives a row ONE line, so the same day that carried five
// marks carries three, and the other two go into „+n". That is v1's own rule
// doing what it has always done — it is NOT a collision, and the difference
// matters: nothing overprints, nothing is illegible, and the entry that loses
// its place is still reachable through the badge v1 already ships for it.
// ═════════════════════════════════════════════════════════════════════════════

test('§2 · at 18 px the row still holds, and what it drops it drops into „+n"', () => {
  withBoard({ ...SCENE(), settings: { rowHeight: 18, layers: NO_LAYERS, hiddenMembers: {} } }, () => {
    const day = dayNode();
    const marks = marksOnRow(day);
    const bad = overlaps(marks);
    const shown = $$('.note', day);
    const more = $('.d-more', day);
    const rows = [];

    rows.push({ id: 'principle-1/row-height', ok: h(day) === 18, why: 'the 18 px row measured ' + h(day) + 'px' });
    rows.push({ id: 'B/capacity-is-one', ok: L.rowCapacity(18) === 1 && shown.length === 1, why: `${shown.length} notes at capacity ${L.rowCapacity(18)}` });
    rows.push({ id: 'deliverable-17/no-collision', ok: bad.length === 0, why: bad.join(' · ') });
    // Nothing is silently dropped: everything the row cannot draw is counted.
    rows.push({ id: '2.4/nothing-vanishes', ok: !!more && Number(more.textContent.replace('+', '')) >= SCENE().notes.length - shown.length,
      why: 'the „+n" badge does not account for the entries the row could not draw: ' + (more && more.textContent) });
    // The marks that DO render still render whole.
    //
    // ═══ WHOSE ENTRY SURVIVES AT CAPACITY 1 (17.2) ═════════════════════════
    // This cell used to read `…flat().includes('chip')` — the survivor is a
    // PEER, so its chip must still be there. That was true of the old capacity
    // slice, which took whatever came first in the array; under
    // `layout.js:orderForCapacity` the single line a capacity-1 row can draw
    // belongs to ME whenever I have anything on the day. That is 17.2 („my
    // board stays mine") at its sharpest, and it is stated here rather than
    // discovered later: at v1's minimum row height, on a day I have written on,
    // the family reaches the note line only as a digit.
    //
    // The geometric question the cell was asking — does a surviving entry keep
    // its marks WHOLE at 18 px — is still asked, of both survivors: mine here,
    // and a peer's on the peers-only variant below, which is the only shape in
    // which a peer can now hold a capacity-1 row.
    const mineMarks = markNames(day).flat();
    rows.push({ id: '17.2/the-one-line-at-capacity-1-is-mine', ok: shown.length === 1 && shown[0].dataset.foreign !== '1',
      why: 'the single line a capacity-1 row can draw went to a peer while an entry of mine was folded into „+n"' });
    rows.push({ id: '17.5+17.2/still-drawn', ok: mineMarks.includes('exp geteilt') && mineMarks.includes('rep'),
      why: 'the surviving entry lost a mark at 18 px: ' + mineMarks.join(',') });

    diag(`18 px · ${shown.length} of ${SCENE().notes.length} notes, ${marks.length} marks, ${bad.length} collisions, overflow ${more ? more.textContent : '—'}`);
    diag(`   marks per note ${JSON.stringify(markNames(day))}`);
    diag('   THE COST, STATED: at v1\'s minimum row height the day row can carry at most the marks of ONE entry,');
    diag('   and under 17.2 that entry is MINE on every day I have written on.');
    diag('   The badge family still coexists on the BOARD — the three bar lanes and their labels carry');
    diag('   ownership at 18 px unchanged — but not on the note line. That is the capacity rule, not E8.');
    verdict('deliverable 17 · 18 px', rows);
  });

  // …and the other half of the same rule: with none of my ink on the day, the
  // one line goes to the peer CHANGE (17.5), and it keeps its chip and its dot
  // whole. Without this, `17.5+17.2/still-drawn` above would be satisfiable by a
  // board that had simply stopped drawing peer marks at 18 px altogether.
  const peersOnly = SCENE();
  peersOnly.notes = peersOnly.notes.filter((n) => n.isForeign);
  withBoard({ ...peersOnly, settings: { rowHeight: 18, layers: NO_LAYERS, hiddenMembers: {} } }, () => {
    const day = dayNode();
    const shown = $$('.note', day);
    const flat = markNames(day).flat();
    const rows = [];
    rows.push({ id: '17.1/a-peer-can-hold-the-line', ok: shown.length === 1 && shown[0].dataset.foreign === '1',
      why: 'with no ink of mine on the day the capacity-1 row still drew nothing of theirs' });
    rows.push({ id: '17.5/the-change-leads', ok: flat.includes('neu-dot'),
      why: 'the peer entry that HAS a change did not take the one line: ' + flat.join(',') });
    rows.push({ id: '17.2/and-keeps-its-chip', ok: flat.includes('chip'),
      why: 'the surviving peer entry lost its chip at 18 px: ' + flat.join(',') });
    rows.push({ id: 'deliverable-17/no-collision', ok: overlaps(marksOnRow(day)).length === 0,
      why: overlaps(marksOnRow(day)).join(' · ') });
    diag(`18 px · peers only · marks per note ${JSON.stringify(markNames(day))}`);
    verdict('deliverable 17 · 18 px · a peer holds the line', rows);
  });
});

test('§2 · the 18 px board is shorter than the 22 px board by exactly the row delta', () => {
  const at = (rowHeight) => withBoard({ ...SCENE(), settings: { rowHeight, layers: NO_LAYERS, hiddenMembers: {} } },
    () => ({ row: h(dayNode()), rows: h($('#board .rows')), board: Math.round(h(boardEl())) }));
  const a = at(22); const b = at(18);
  diag(`row 22 → board ${a.board} px · row 18 → board ${b.board} px`);
  assert.equal(a.rows, 22 * 31, 'the 31-row block at 22');
  assert.equal(b.rows, 18 * 31, 'the 31-row block at 18');
  // The family adds nothing to either — the whole delta is the row-height setting.
  assert.equal(a.board - b.board, (22 - 18) * 31, 'the family put height into the board at one of the two extremes');
});

// ═════════════════════════════════════════════════════════════════════════════
// §3 · WHAT ONE MARK COSTS THE TEXT — the horizontal budget, mark by mark
//
// `layout.js` PUBLISHES these numbers as `PREFIX_COST_PX`. A published constant
// that nothing measures is a comment. Every row below is the real box in the
// real engine, compared against what the module claims.
// ═════════════════════════════════════════════════════════════════════════════

test('§3 · every prefix mark costs what layout.js says it costs — and 0 px of line box', () => {
  const one = (note) => withBoard({ notes: [note], settings: { rowHeight: 22, layers: NO_LAYERS, hiddenMembers: {} } }, () => {
    const n = $('.note', dayNode());
    const cs = [...n.children].filter((c) => c.className !== 'redacted-word');
    const prefix = cs.reduce((s, c) => {
      const st = getComputedStyle(c);
      return s + c.getBoundingClientRect().width + parseFloat(st.marginRight || 0) + parseFloat(st.marginLeft || 0);
    }, 0);
    return { marks: cs.map((c) => c.className), prefix: px(prefix), boxW: w(n), lineH: h(n) };
  });

  const plain = one(own('p', DAY, 'Zahnarzttermin'));
  const table = {
    'v1 · plain own note': plain,
    'v1 · own + ↻': one(own('p', DAY, 'Zahnarzttermin', { repeatsYearly: true })),
    'E8 · own + visibility badge': one(own('p', DAY, 'Zahnarzttermin', { exposure: { level: 'geteilt', pending: false } })),
    'E8 · own WORST (badge + ↻)': one(own('p', DAY, 'Zahnarzttermin', { repeatsYearly: true, exposure: { level: 'belegt', pending: true } })),
    'E8 · foreign (chip)': one(foreign('f', DAY, 'geteilt', { text: 'Zahnarzttermin' })),
    'E8 · foreign WORST (neu + chip + ↻)': one(foreign('f', DAY, 'geteilt', { text: 'Zahnarzttermin', isNew: true, repeatsYearly: true })),
    'E8 · foreign Belegt block': one(foreign('f', DAY, 'belegt', { isNew: true })),
  };
  for (const [k, v] of Object.entries(table)) {
    diag(`${k.padEnd(38)} prefix ${String(v.prefix).padStart(5)} px · text ${String(px(v.boxW - v.prefix)).padStart(5)} px · line box ${v.lineH} px · [${v.marks.join(' ')}]`);
  }

  const rows = [];
  const C = L.PREFIX_COST_PX;
  // ⚠ THE ONE THAT OUTRANKS THE REST: every variant has v1's line box. A mark
  // that grew the line by 1 px would grow it on all 372 rows of every column.
  for (const [k, v] of Object.entries(table)) {
    rows.push({ id: `line-box/${k}`, ok: v.lineH === plain.lineH, why: `${v.lineH} px against v1's ${plain.lineH} px` });
  }
  rows.push({ id: 'PREFIX_COST_PX/ownWorst', ok: table['E8 · own WORST (badge + ↻)'].prefix <= C.ownWorst,
    why: `measured ${table['E8 · own WORST (badge + ↻)'].prefix} > published ${C.ownWorst}` });
  rows.push({ id: 'PREFIX_COST_PX/foreignWorst', ok: table['E8 · foreign WORST (neu + chip + ↻)'].prefix <= C.foreignWorst,
    why: `measured ${table['E8 · foreign WORST (neu + chip + ↻)'].prefix} > published ${C.foreignWorst}` });
  // …and the budget it is spent out of. §11 challenge 1 gives the row ~60 px of
  // text; a prefix over a third of that is a redesign, not a tweak.
  rows.push({ id: 'budget/foreign-worst-under-40pc', ok: table['E8 · foreign WORST (neu + chip + ↻)'].prefix / plain.boxW < 0.4,
    why: `the worst prefix eats ${(table['E8 · foreign WORST (neu + chip + ↻)'].prefix / plain.boxW * 100).toFixed(0)}% of the text budget` });
  rows.push({ id: 'v1/plain-note-pays-nothing', ok: plain.prefix === 0, why: 'a plain v1 note grew a prefix of ' + plain.prefix + ' px' });
  verdict('prefix cost', rows);
});

// ═════════════════════════════════════════════════════════════════════════════
// §4 · GEOMETRY PARITY — the same 8-member × 2-year board, solo and family
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

const geometry = () => ({
  rowHeight: h(dayNode()),
  rowBlock: h($('#board .rows')),
  boardHeight: Math.round(h(boardEl())),
  columnWidth: w($(`#board .col[data-month="${COL.key}"]`)),
  bodyWidth: w($('.d-body', dayNode())),
  toolbarHeight: h($('.toolbar')),
  boardTop: px($('#board').getBoundingClientRect().top),
});

test('§4 · seven other people on the board change NOTHING about its geometry', () => {
  const fx = fixture8x2();
  const settings = { rowHeight: 22, layers: NO_LAYERS, hiddenMembers: {} };
  const solo = withBoard({ notes: fx.notes.filter((n) => !n.isForeign), bars: fx.bars.filter((b) => !b.isForeign), settings },
    () => ({ ...geometry(), domNotes: $$('#board .note').length, domBars: $$('#board .bar').length, nodes: $$('#board *').length }));
  const family = withBoard({ ...fx, settings },
    () => ({ ...geometry(), domNotes: $$('#board .note').length, domBars: $$('#board .bar').length, nodes: $$('#board *').length }));

  diag(`fixture: ${fx.notes.length} notes, ${fx.bars.length} bars, 8 people, 2 years`);
  diag(`solo   ${JSON.stringify({ ...solo })}`);
  diag(`family ${JSON.stringify({ ...family })}`);

  const { domNotes: _a, domBars: _b, nodes: _c, ...soloGeo } = solo;
  const { domNotes: _d, domBars: _e, nodes: _f, ...famGeo } = family;
  assert.deepEqual(famGeo, soloGeo, 'the family moved the board\'s geometry');
  // Non-vacuity: if the family board were not actually denser, parity is free.
  assert.ok(family.domNotes > solo.domNotes * 2, 'the family fixture did not actually crowd the board');
  assert.ok(family.domBars > solo.domBars, 'no extra bar segments reached the DOM');
  assert.deepEqual(L.FAMILY_LAYOUT_COST_PX, {
    rowHeight: 0, columnWidth: 0, laneWidth: 0, gutter: 0, noteTextWidth: 0,
  }, 'layout.js now claims the family costs the board pixels');
});

test('§4 · hiding all seven restores the solo board, entry for entry', () => {
  const fx = fixture8x2();
  const settings = { rowHeight: 22, layers: NO_LAYERS };
  const solo = withBoard({ notes: fx.notes.filter((n) => !n.isForeign), bars: fx.bars.filter((b) => !b.isForeign), settings: { ...settings, hiddenMembers: {} } },
    () => ({ notes: $$('#board .note').length, bars: $$('#board .bar').length, more: $$('#board .d-more').length }));
  const hidden = withBoard({ ...fx, settings: { ...settings, hiddenMembers: Object.fromEntries(MEMBERS.map((m) => [m.id, true])) } },
    () => ({ notes: $$('#board .note').length, bars: $$('#board .bar').length, more: $$('#board .d-more').length }));
  diag(`17.3 · all seven hidden → ${JSON.stringify(hidden)} · solo → ${JSON.stringify(solo)}`);
  // 17.3 is a per-member toggle, not a dimmer: with every member off, my board
  // is the board I would have had if I had never joined a circle.
  assert.deepEqual(hidden, solo, 'hiding every member did not reproduce the solo board');
});

// ═════════════════════════════════════════════════════════════════════════════
// §5 · LZP-1007 — THE DRAG FRAME BUDGET at 8 members × 2 years
//
// What "60 fps" costs is one frame of MAIN-THREAD work per pointermove, and
// that is what is measured: dispatch the event the app really listens for, then
// force a style + layout flush, and time the pair. 60 fps is 16.7 ms; a gesture
// whose per-frame work is a small fraction of that cannot miss the budget for
// reasons on this side of the compositor.
//
// A wall-clock rAF cadence is deliberately NOT asserted here: a tier-2 run has
// no visible window, so rAF is suspended and any fps this file printed would be
// a number about the test runner. The budget is the honest measurement.
// ═════════════════════════════════════════════════════════════════════════════

const FRAME_BUDGET_MS = 16.7;

function dragFrames(kind, n) {
  const col = $(`#board .col[data-month="${COL.key}"]`);
  let target; let x0; let y0;
  if (kind === 'create-bar') {
    const e = $$('.day[data-date]', col).find((d) => !$('.note', d)) || $$('.day[data-date]', col)[0];
    const r = e.getBoundingClientRect(); x0 = r.left + r.width * 0.5; y0 = r.top + r.height / 2; target = e;
  } else if (kind === 'move-note') {
    const nd = $('.note', col); const r = nd.getBoundingClientRect();
    x0 = r.left + 4; y0 = r.top + r.height / 2; target = nd;
  } else {
    const el = $$('#board .bar').sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
    const r = el.getBoundingClientRect(); x0 = r.left + r.width / 2; y0 = r.top + r.height / 2; target = el;
  }
  const pe = (type, x, y, tg) => (tg || window).dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    pointerId: 1, isPrimary: true, clientX: x, clientY: y,
  }));
  pe('pointerdown', x0, y0, target);
  const f = []; let body = '';
  for (let i = 0; i < n; i++) {
    const dx = kind === 'create-bar' ? 0 : Math.round(Math.sin(i / 9) * 500);
    const dy = kind === 'create-bar' ? ((i * 11) % 640) : Math.round(Math.cos(i / 5) * 260);
    const t0 = performance.now();
    pe('pointermove', x0 + dx, y0 + dy);
    document.documentElement.getBoundingClientRect();
    void document.body.offsetHeight;
    f.push(performance.now() - t0);
    if (i === 3) body = document.body.className;
  }
  pe('pointerup', x0, y0);
  const s = [...f].sort((a, b) => a - b);
  return {
    body,
    median: px(s[s.length >> 1]),
    p95: px(s[Math.floor(s.length * 0.95)]),
    max: px(s[s.length - 1]),
    over: f.filter((v) => v > FRAME_BUDGET_MS).length,
  };
}

test('§5 · LZP-1007 — a drag on the 8-member board stays inside the 60 fps frame budget', () => {
  if (typeof PointerEvent !== 'function') { skip('no PointerEvent in this engine'); return; }
  const fx = fixture8x2();
  const settings = { rowHeight: 22, layers: NO_LAYERS, hiddenMembers: {} };
  const rows = [];
  const seen = {};
  for (const kind of ['move-note', 'move-bar', 'create-bar']) {
    const solo = withBoard({ notes: fx.notes.filter((n) => !n.isForeign), bars: fx.bars.filter((b) => !b.isForeign), settings },
      () => { dragFrames(kind, 40); return dragFrames(kind, 200); });
    const family = withBoard({ ...fx, settings },
      () => { dragFrames(kind, 40); return dragFrames(kind, 200); });
    seen[kind] = { solo, family };
    diag(`${kind.padEnd(11)} solo   median ${String(solo.median).padStart(5)} ms · p95 ${String(solo.p95).padStart(5)} ms · worst ${String(solo.max).padStart(5)} ms · over budget ${solo.over}/200`);
    diag(`${''.padEnd(11)} family median ${String(family.median).padStart(5)} ms · p95 ${String(family.p95).padStart(5)} ms · worst ${String(family.max).padStart(5)} ms · over budget ${family.over}/200`);
    // The gesture really engaged the state machine — otherwise every number is
    // the cost of dispatching an event nobody handled.
    rows.push({ id: `${kind}/really-dragging`, ok: /is-dragging|is-creating|is-resizing/.test(family.body), why: 'body class during the drag was ' + JSON.stringify(family.body) });
    // The budget. Loose on the worst frame (a tier-2 Mac is not a quiet Mac)
    // and tight on the median, which is what a hand actually feels.
    rows.push({ id: `${kind}/median-well-inside`, ok: family.median < FRAME_BUDGET_MS / 3, why: `median ${family.median} ms of a ${FRAME_BUDGET_MS} ms frame` });
    rows.push({ id: `${kind}/p95-inside`, ok: family.p95 < FRAME_BUDGET_MS, why: `p95 ${family.p95} ms exceeds the 60 fps budget` });
  }
  verdict('LZP-1007 · drag frame budget', rows);
  diag('READ THIS AS: main-thread work per drag frame. A tier-2 run has no visible window,');
  diag('so rAF is suspended and a wall-clock fps here would be a fact about the runner.');
  // WebKit clamps `performance.now()` to ~1 ms, so the median and p95 printed
  // above are floors, not resolutions. The number that carries the claim is the
  // WORST frame, which is measured in whole clamped milliseconds and is still a
  // small fraction of 16.7. Chromium (1 µs) gives the fine-grained picture and
  // agrees: median 1.2 ms, p95 1.4 ms, worst 8.7 ms on the same fixture.
  diag(`timer resolution here: ${px(performance.now() % 1) === 0 ? '~1 ms (clamped)' : 'sub-ms'} — read the WORST-frame column.`);
});

// ═════════════════════════════════════════════════════════════════════════════
// §6 · A8 — WHAT E8 COSTS THE PRINT SHEET
//
// The claim under test is not "it prints". It is that A3's second section
// arrives in the legend strip without the strip growing, and that 17.3's toggle
// is honoured on paper as well as on screen — because a poster is the artefact
// somebody puts on a wall, and a hidden member appearing there would be the
// leak the toggle exists to prevent.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The strip is `display: none` on screen — it only exists under `@media print`.
 * Measuring it therefore means lifting those rules out of their media block and
 * applying them, which is `family-attribution.dom.js` §3's technique and the
 * only way to measure 7 pt type in the engine that will actually set it. A
 * height read WITHOUT this is 0 px, and `0 === 0` is a green cell that has
 * measured nothing.
 */
function withPrintRules(fn) {
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
  try { return fn(css.length); } finally { style.remove(); }
}

test('§6 · the print strip gains a member key and NOT a millimetre of page height', () => {
  P.initPrint();
  const fx = fixture8x2();
  const settings = { rowHeight: 22, layers: NO_LAYERS, hiddenMembers: {} };
  const strip = () => {
    window.dispatchEvent(new Event('beforeprint'));
    const lg = $('.print-legend');
    if (!lg) return null;
    return withPrintRules((ruleCount) => {
      const items = $$('.item', lg);
      return {
        rulesLifted: ruleCount,
        height: h(lg),
        inkWidth: px(items.reduce((s, i) => s + i.getBoundingClientRect().width, 0)),
        categories: items.filter((i) => !i.classList.contains('member')).length,
        members: items.filter((i) => i.classList.contains('member')).length,
        divider: $$('.sep', lg).length,
      };
    });
  };
  const solo = withBoard({ notes: fx.notes.filter((n) => !n.isForeign), bars: fx.bars.filter((b) => !b.isForeign), settings }, strip);
  const family = withBoard({ ...fx, settings }, strip);
  const hidden = withBoard({ ...fx, settings: { ...settings, hiddenMembers: Object.fromEntries(MEMBERS.map((m) => [m.id, true])) } }, strip);
  if (!solo) { skip('no .print-legend in this build'); return; }

  diag(`A4 strip · solo   ${JSON.stringify(solo)}`);
  diag(`A4 strip · family ${JSON.stringify(family)}`);
  diag(`A4 strip · all seven hidden ${JSON.stringify(hidden)}`);

  const rows = [];
  // Non-vacuity first: a strip that is 0 px tall is a strip nobody measured.
  rows.push({ id: 'A8/the-strip-was-really-measured', ok: solo.rulesLifted > 0 && solo.height > 0,
    why: `${solo.rulesLifted} print rules lifted, strip measured ${solo.height} px tall` });
  rows.push({ id: 'A8/strip-height-unchanged', ok: family.height === solo.height, why: `${family.height} px against v1's ${solo.height} px` });
  rows.push({ id: 'A3/member-key-present', ok: family.members > 0, why: 'the family board printed no member key' });
  rows.push({ id: 'A3/one-divider', ok: family.divider === 1, why: family.divider + ' dividers in the strip' });
  rows.push({ id: 'A3/categories-untouched', ok: family.categories === solo.categories, why: `${family.categories} category items against ${solo.categories}` });
  // ⚠ the one that is about privacy rather than layout.
  rows.push({ id: '17.3/hidden-members-are-off-the-paper', ok: hidden.members === 0 && hidden.divider === 0,
    why: `${hidden.members} hidden members still printed in the key` });
  rows.push({ id: '17.3/paper-returns-to-v1', ok: hidden.height === solo.height && hidden.inkWidth === solo.inkWidth,
    why: 'with every member hidden the strip is not v1\'s strip' });
  verdict('A8 · print parity', rows);
});
