// TIER 2 · E8 DENSITY ADVERSARY — §B · WHO GETS THE ROW
//
// 17.2: „my entries always render in my category colours — MY BOARD STAYS MINE."
// v1 principle 3: „the user's own entries always win visual priority."
// 17.4: family entries obey the lane cap (3.8), „+n" overflow (2.4), truncation.
// 3.8 / 2.4: what a row cannot draw is counted and reachable, never lost.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ASYMMETRY THIS FILE IS ABOUT
// ─────────────────────────────────────────────────────────────────────────────
//
// `layout.js` contains a comparator prefix called `ownFirst`, with a comment
// that states the problem exactly:
//
//     „three of Mama's long stripes take lanes 0–2 for six months and MY OWN
//      vacation bar becomes a '+n' badge on MY OWN board. Measured … 41 % of my
//      own bar segments were pushed out of the lanes."
//
// `ownFirst` is applied in `assignLanes`. `assignLanes` is for BARS.
//
// The capacity slice for NOTES is `layout.js`: `notesHere.slice(0, noteSlots)`,
// fed by `core/entities.js:noteOccurrences`, whose own docstring says
// „occurrence order within a day is `state.notes` order" — and `state.notes` is
// `sortNotes` = `(_born asc, id asc)`, i.e. CREATION TIME ACROSS THE WHOLE
// FAMILY. No `ownFirst` anywhere on that path.
//
// The fixture has 3 059 notes and 416 bars. The protected entity is the rare
// one. §B1 shows the mechanism on two notes; §B2 measures it on the fixture,
// against the SOLO board, exactly the way §6 measures it for bars.
//
// Plain script: globals are test, assert, $, $$, waitFor, sleep, importApp,
// diag, skip.
// ─────────────────────────────────────────────────────────────────────────────

const { store } = await importApp('store.js');
const { renderBoard } = await importApp('board.js');
const L = await importApp('layout.js');
const E = await importApp('core/entities.js');

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

// ── real stamps, so the real comparator decides, not this file ───────────────
// `_born` is `core/stamp.js`'s 37-character fixed-width stamp. Building them by
// hand and running `core/entities.js:sortNotes` over the result is exactly what
// `materialize.js` does at line 854, so the order under test is the SHIPPED one.
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

function withBoard({ notes = [], bars = [], settings = {} }, fn) {
  const before = { notes: store.state.notes, bars: store.state.bars, settings: JSON.parse(JSON.stringify(store.state.settings)) };
  try {
    Object.assign(store.state.settings, settings);
    // THE SHIPPED ORDER. `materialize.js:854` — `notes: sortNotes(notes)`.
    store.state.notes = E.sortNotes(notes);
    store.state.bars = E.sortBars(bars);
    const m = renderBoard(boardEl());
    return fn(m);
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
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const D = (n) => iso(COL.y, COL.m, Math.max(1, Math.min(COL.len, n)));
const dayNode = (date = DAY) => $(`#board .col[data-month="${COL.key}"] .day[data-date="${date}"]`);
diag(`window ${M0.cols[0].key} … ${M0.cols[11].key} · clean day ${DAY}`);

// ═════════════════════════════════════════════════════════════════════════════
// §B1 · THE MECHANISM — two notes, one slot, and the family wins
//
// The 22 px row has capacity 2. Give the day a Feiertag, or set the row to
// v1's 18 px minimum, and it has ONE note slot. Mama entered hers in March; I
// entered mine this morning. `sortNotes` is `(_born asc, id asc)` and there is
// no owner term, so the slice takes hers.
// ═════════════════════════════════════════════════════════════════════════════

test('§B1 · at one note slot, an older FOREIGN note takes the row and MINE goes into „+n"', () => {
  const MARCH = Date.UTC(2026, 2, 1);
  const TODAY = Date.UTC(2026, 8, 1);
  const scene = {
    notes: [
      own('mine', DAY, 'Zahnarzt', { _born: born(TODAY) }),
      foreign('hers', DAY, 'geteilt', { who: MEMBERS[0], text: 'Chorprobe', _born: born(MARCH) }),
    ],
    bars: [],
  };
  const r = withBoard({ ...scene, settings: { rowHeight: 18, layers: NO_LAYERS, hiddenMembers: {} } }, () => {
    const day = dayNode();
    const drawn = $$('.note', day).map((n) => ({ text: n.textContent.trim(), foreign: n.classList.contains('foreign') }));
    return { capacity: L.rowCapacity(18), drawn, more: $('.d-more', day) ? $('.d-more', day).textContent : '—' };
  });
  const soloR = withBoard({ notes: [scene.notes[0]], bars: [], settings: { rowHeight: 18, layers: NO_LAYERS, hiddenMembers: {} } },
    () => $$('.note', dayNode()).map((n) => n.textContent.trim()));

  diag(`18 px · capacity ${r.capacity} · drawn ${JSON.stringify(r.drawn)} · overflow ${r.more}`);
  diag(`   the same day on a SOLO board: ${JSON.stringify(soloR)}`);
  diag('   `sortNotes` = (_born asc, id asc). Mama\'s note is older, so it takes the one slot.');
  diag('   `layout.js:ownFirst` — the exact fix for this — is applied in `assignLanes` (BARS) only.');

  verdict('§B1 · the capacity slice', [
    { id: '17.2/my-board-stays-mine', ok: r.drawn.some((d) => !d.foreign),
      why: `the only entry drawn on my own board is ${JSON.stringify(r.drawn)} — my note is in „${r.more}"` },
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════
// §B2 · THE SAME MEASUREMENT `layout.js` MADE FOR BARS, MADE FOR NOTES
//
// The bar version, in `layout.js`'s own words: „every segment of mine that a
// SOLO board draws is still drawn once seven other people are on the board."
// Below, both entity kinds, on one fixture, at 22 px with a real Bundesland and
// the real layers — i.e. the shipping board.
// ═════════════════════════════════════════════════════════════════════════════

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
  // CREATION TIME IS INDEPENDENT OF WHO. Eight people entering things over a
  // year is not a fixture bias: it is the only honest model of a family, and it
  // is what makes `_born` a fair lottery rather than a rigged one.
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
const MINE_N = FX.notes.filter((n) => !n.isForeign);
const MINE_B = FX.bars.filter((b) => !b.isForeign);

/** The set of MY occurrences the board actually drew — `noteId@date` / `barId@month`. */
const drawnOwnNotes = () => new Set($$('#board .note').filter((n) => !n.classList.contains('foreign'))
  .map((n) => `${n.dataset.noteId}@${n.dataset.date}`));
const drawnOwnBars = () => new Set($$('#board .bar').filter((b) => !b.classList.contains('foreign'))
  .map((b) => `${b.dataset.barId}@${b.closest('.col').dataset.month}`));

test('§B2 · what seven other people take from MY OWN board — notes against bars', () => {
  const settings = { rowHeight: 22, layers: NO_LAYERS, hiddenMembers: {}, colWidth: 118, bundesland: '' };
  const solo = withBoard({ notes: MINE_N, bars: MINE_B, settings },
    () => ({ notes: drawnOwnNotes(), bars: drawnOwnBars(), more: $$('#board .d-more').length }));
  const family = withBoard({ ...FX, settings },
    () => ({ notes: drawnOwnNotes(), bars: drawnOwnBars(), more: $$('#board .d-more').length }));

  const lostNotes = [...solo.notes].filter((k) => !family.notes.has(k));
  const lostBars = [...solo.bars].filter((k) => !family.bars.has(k));

  diag(`fixture ${FX.notes.length} notes / ${FX.bars.length} bars · 8 people · 2 years · `
    + `creation stamps interleaved across the family`);
  diag(`MY NOTE occurrences drawn — solo ${solo.notes.size} · with the family ${family.notes.size} · `
    + `LOST ${lostNotes.length} (${(lostNotes.length / Math.max(1, solo.notes.size) * 100).toFixed(1)} %)`);
  diag(`MY BAR segments drawn    — solo ${solo.bars.size} · with the family ${family.bars.size} · `
    + `LOST ${lostBars.length} (${(lostBars.length / Math.max(1, solo.bars.size) * 100).toFixed(1)} %)`);
  diag(`days carrying a „+n" badge — solo ${solo.more} · with the family ${family.more}`);
  for (const k of lostNotes.slice(0, 8)) diag(`   ! my note ${k} is on the solo board and NOT on the family board`);
  diag('   `ownFirst` protects the 416 bars. Nothing protects the 3 059 notes.');

  verdict('§B2 · 17.2 across both entity kinds', [
    { id: '17.2/bars-are-protected', ok: lostBars.length === 0,
      why: `${lostBars.length} of my own bar segments vanished when the family arrived` },
    { id: '17.2/notes-are-protected-too', ok: lostNotes.length === 0,
      why: `${lostNotes.length} of ${solo.notes.size} of my own note occurrences (${(lostNotes.length / Math.max(1, solo.notes.size) * 100).toFixed(1)} %) `
        + 'vanished from MY OWN board when seven other people joined — pushed out of the capacity slice by an OLDER foreign entry' },
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════
// §B2b · IS §B2's NUMBER A PROPERTY OF THE FIXTURE, OR OF THE RULE?
//
// The one honest objection to §B2 is that the loss depends on WHEN things were
// created, and this fixture interleaves the eight people's stamps. So the same
// board is measured under the three orderings that bracket every real case:
// I joined an established circle and enter last (worst), everyone enters
// together (§B2's model), and I was there first (best). If the range has a bad
// end, the rule has a bad end — a fixture cannot manufacture that.
// ═════════════════════════════════════════════════════════════════════════════

test('§B2b · the loss under the three creation orders that bracket every real family', () => {
  const settings = { rowHeight: 22, layers: NO_LAYERS, hiddenMembers: {}, colWidth: 118, bundesland: '' };
  const shift = (notes, mineMs, theirsMs) => notes.map((n, i) => ({
    ...n, _born: born((n.isForeign ? theirsMs : mineMs) + i, i % 1000000),
  }));
  const solo = withBoard({ notes: MINE_N, bars: MINE_B, settings }, () => drawnOwnNotes());
  const ORDERS = {
    'I entered mine FIRST (I founded the circle)': [Date.UTC(2024, 0, 1), Date.UTC(2026, 0, 1)],
    'interleaved (§B2\'s model)': null,
    'I entered mine LAST (I joined an established circle)': [Date.UTC(2026, 0, 1), Date.UTC(2024, 0, 1)],
  };
  const out = {};
  for (const [label, ms] of Object.entries(ORDERS)) {
    const notes = ms ? shift(FX.notes, ms[0], ms[1]) : FX.notes;
    const got = withBoard({ notes, bars: FX.bars, settings }, () => drawnOwnNotes());
    const lost = [...solo].filter((k) => !got.has(k)).length;
    out[label] = lost;
    diag(`   ${label.padEnd(52)} → ${String(got.size).padStart(4)} of my ${solo.size} occurrences drawn · LOST ${String(lost).padStart(4)} (${(lost / solo.size * 100).toFixed(1)} %)`);
  }
  const worst = Math.max(...Object.values(out));
  const best = Math.min(...Object.values(out));
  diag(`   THE RANGE: ${(best / solo.size * 100).toFixed(1)} % … ${(worst / solo.size * 100).toFixed(1)} % of my own entries lost from my own board.`);
  diag('   The best end is not zero either: at capacity 2 the second slot is decided by the same lottery.');
  verdict('§B2b · the range', [
    { id: '17.2/no-creation-order-costs-me-my-board', ok: worst === 0,
      why: `in the worst of the three orders ${worst} of ${solo.size} of my own note occurrences (${(worst / solo.size * 100).toFixed(1)} %) are not drawn on my own board` },
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════
// §B3 · THE LANE CAP, ATTACKED DIRECTLY — can a family take a lane from me?
// ═════════════════════════════════════════════════════════════════════════════

test('§B3 · three long foreign stripes cannot displace my own bar from the lanes', () => {
  const settings = { rowHeight: 22, layers: NO_LAYERS, hiddenMembers: {}, bundesland: '' };
  const long = (i, who) => foreignBar('fl' + i, D(1), D(COL.len), 'geteilt', { who, label: 'Kur', _born: born(Date.UTC(2025, 0, 1) + i) });
  const scene = {
    notes: [],
    bars: [long(0, MEMBERS[0]), long(1, MEMBERS[1]), long(2, MEMBERS[2]),
      ownBar('mine', D(10), D(14), 'Urlaub', { _born: born(Date.UTC(2026, 8, 1)) })],
  };
  const r = withBoard({ ...scene, settings }, () => {
    const col = $(`#board .col[data-month="${COL.key}"]`);
    const mine = $$('.bar', col).filter((b) => !b.classList.contains('foreign'));
    const day = dayNode(D(12));
    return {
      mineDrawn: mine.length, mineLane: mine[0] ? mine[0].dataset.lane : null,
      foreignDrawn: $$('.bar', col).filter((b) => b.classList.contains('foreign')).length,
      more: $('.d-more', day) ? $('.d-more', day).textContent : '—',
      moreTitle: $('.d-more', day) ? $('.d-more', day).title : '',
    };
  });
  diag(`3 month-long foreign stripes + 1 of my own · my bar drawn ${r.mineDrawn} in lane ${r.mineLane} · foreign drawn ${r.foreignDrawn} of 3`);
  diag(`   the day my bar covers reads „${r.more}" — title „${r.moreTitle}"`);
  verdict('§B3 · the lane cap', [
    { id: '3.8+17.2/my-bar-keeps-a-lane', ok: r.mineDrawn === 1, why: 'my own bar was pushed out of the lanes by the family' },
    // …and the honest consequence, which IS by design and is reported, not asserted against.
    { id: '3.8/what-drops-is-counted', ok: r.more !== '—', why: 'a foreign bar was dropped without a „+n"' },
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════
// §B4 · WHAT „+n" BECOMES AT FAMILY SCALE
//
// 2.4's „+n" is v1's honesty mechanism, and E8 leans on it for everything the
// row cannot hold. This is the load it now carries: how many rows have one, how
// big n gets, and how wide the badge grows — the badge being an OPAQUE box
// inside the note's own text column (§A2).
// ═════════════════════════════════════════════════════════════════════════════

test('§B4 · the „+n" load, solo against family, and the widest badge on the board', () => {
  const settings = { rowHeight: 22, layers: NO_LAYERS, hiddenMembers: {}, colWidth: 118, bundesland: '' };
  const survey = () => {
    const days = $$('#board .day[data-date]');
    const more = $$('#board .d-more');
    const ns = more.map((m) => Number(m.textContent.replace('+', '')));
    const widths = more.map((m) => m.getBoundingClientRect().width);
    return {
      days: days.length, withMore: more.length,
      pct: px(more.length / Math.max(1, days.length) * 100),
      maxN: ns.length ? Math.max(...ns) : 0,
      meanN: ns.length ? px(ns.reduce((a, b) => a + b, 0) / ns.length) : 0,
      maxBadgeW: widths.length ? px(Math.max(...widths)) : 0,
      twoDigit: ns.filter((n) => n >= 10).length,
    };
  };
  const solo = withBoard({ notes: MINE_N, bars: MINE_B, settings }, survey);
  const family = withBoard({ ...FX, settings }, survey);

  diag(`solo   ${solo.withMore} of ${solo.days} visible day rows carry a „+n" (${solo.pct} %) · max +${solo.maxN} · mean +${solo.meanN} · widest badge ${solo.maxBadgeW} px`);
  diag(`family ${family.withMore} of ${family.days} visible day rows carry a „+n" (${family.pct} %) · max +${family.maxN} · mean +${family.meanN} · widest badge ${family.maxBadgeW} px`);
  diag(`   two-digit badges: solo ${solo.twoDigit} · family ${family.twoDigit}`);
  diag(`   every one of them is an opaque box inside the note's own text column (§A2), ${family.maxBadgeW} px at the widest,`);
  diag(`   against a ${61} px text column at the 118 px default.`);
  // Reported, not asserted: this is the load, and the load is the finding.
  assert.ok(family.withMore >= solo.withMore, 'the family board carries fewer overflow badges than the solo board');
});

// ═════════════════════════════════════════════════════════════════════════════
// §B5 · 17.5 — the „neu" dot a crowded row never draws
//
// „Entries added or changed by others since my last session carry a quiet „neu"
// dot … so I NOTICE CHANGE the way I'd notice new ink on a wall calendar."
//
// The dot is a child of the `.note`. A note that lost the capacity slice draws
// no dot, and `membersui.js` states — deliberately, and with an argument — that
// the family half of the legend carries NO marker. So on a crowded day a peer's
// change can arrive with no visible signal anywhere on the board.
// ═════════════════════════════════════════════════════════════════════════════

test('§B5 · how many of the family\'s „neu" markers the board actually draws', () => {
  const settings = { rowHeight: 22, layers: NO_LAYERS, hiddenMembers: {}, bundesland: '' };
  const r = withBoard({ ...FX, settings }, (m) => {
    // every isNew occurrence inside the visible window, from the MODEL
    let inWindow = 0; let drawn = 0;
    for (const c of m.cols) {
      for (const d of c.days) {
        if (d.empty) continue;
        inWindow += (d.allNotes || []).filter((x) => x.isNew).length;
        drawn += (d.notes || []).filter((x) => x.isNew).length;
      }
    }
    return { inWindow, drawn, dots: $$('#board .note .neu-dot').length, labelDots: $$('#board .bar-label .neu-dot').length };
  });
  const lost = r.inWindow - r.drawn;
  diag(`17.5 · foreign notes marked „neu" inside the 12-month window: ${r.inWindow}`);
  diag(`      drawn with their dot: ${r.drawn} (${r.dots} „neu" dots were in the DOM at render time)`);
  diag(`      SWALLOWED BY „+n": ${lost} (${(lost / Math.max(1, r.inWindow) * 100).toFixed(1)} %) — no dot, and the legend has no marker by design`);
  diag(`      bar labels carrying a dot: ${r.labelDots}`);
  verdict('§B5 · 17.5 reachability', [
    { id: '17.5/every-change-is-noticeable', ok: lost === 0,
      why: `${lost} of ${r.inWindow} peer changes inside the visible window render NO „neu" dot anywhere — `
        + 'they are inside a „+n" badge that looks identical whether it hides a change or not' },
  ]);
});
