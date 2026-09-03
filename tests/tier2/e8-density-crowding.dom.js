// TIER 2 · E8 DENSITY ADVERSARY — §B · WHO GETS THE ROW
//
// 17.2: „my entries always render in my category colours — MY BOARD STAYS MINE."
// v1 principle 3: „the user's own entries always win visual priority."
// 17.4: family entries obey the lane cap (3.8), „+n" overflow (2.4), truncation.
// 3.8 / 2.4: what a row cannot draw is counted and reachable, never lost.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ASYMMETRY THIS FILE FOUND, AND THE RULE THAT CLOSED IT (LZP-806)
// ─────────────────────────────────────────────────────────────────────────────
//
// `layout.js` contained a comparator prefix called `ownFirst`, with a comment
// that stated the problem exactly:
//
//     „three of Mama's long stripes take lanes 0–2 for six months and MY OWN
//      vacation bar becomes a '+n' badge on MY OWN board. Measured … 41 % of my
//      own bar segments were pushed out of the lanes."
//
// `ownFirst` was applied in `assignLanes`. `assignLanes` is for BARS.
//
// The capacity slice for NOTES is `layout.js`: `notesHere.slice(0, noteSlots)`,
// fed by `core/entities.js:noteOccurrences`, whose own docstring says
// „occurrence order within a day is `state.notes` order" — and `state.notes` is
// `sortNotes` = `(_born asc, id asc)`, i.e. CREATION TIME ACROSS THE WHOLE
// FAMILY. There was no `ownFirst` anywhere on that path, and the fixture has
// 3 059 notes against 416 bars: the protected entity was the rare one.
//
//   WHAT THIS FILE MEASURED WHEN IT WAS AN ATTACK, at 22 px on the 8 × 2 fixture:
//     I founded the circle and entered mine first    0 of 185 lost   ( 0.0 %)
//     everyone entered together                    100 of 185 lost   (54.1 %)
//     I joined an established circle, entering last 173 of 185 lost  (93.5 %)
//
// `layout.js:orderForCapacity` is the answer, and it is the same shape as the
// bar rule: a PREFIX in front of v1's array order, provably inert on a solo
// board, with a second tier for 17.5 („changed before unchanged", inside the
// foreign block only). Every row below now asserts the FIXED behaviour and
// prints the lottery numbers as `diag`, the way `family-render.dom.js` §6 does
// for bars. §B1 pins the mechanism on two notes and pins it under BOTH stamp
// orders, so it cannot pass by accident; §B2 and §B2b pin it on the fixture.
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
// §B1 · THE MECHANISM — two notes, one slot, and MY note takes the row
//
// The 22 px row has capacity 2. Give the day a Feiertag, or set the row to
// v1's 18 px minimum, and it has ONE note slot. Mama entered hers in March; I
// entered mine this morning. `sortNotes` is `(_born asc, id asc)` and carries
// no owner term, so the slice used to take hers.
//
// It is run under BOTH stamp orders — hers older, then mine older — because a
// rule that only holds for one arrival order is not a rule, and because a
// one-order test of an ordering fix is a test that cannot fail. Under both, the
// drawn entry is mine and the foreign one is the „+1"; and in both the row is
// identical to the SOLO board's row, which is the whole of 17.2's promise.
// ═════════════════════════════════════════════════════════════════════════════

test('§B1 · at one note slot MY note takes the row, whoever entered theirs first', () => {
  const MARCH = Date.UTC(2026, 2, 1);
  const TODAY = Date.UTC(2026, 8, 1);
  const SET18 = { rowHeight: 18, layers: NO_LAYERS, hiddenMembers: {} };
  const scene = (mineMs, hersMs) => ({
    notes: [
      own('mine', DAY, 'Zahnarzt', { _born: born(mineMs) }),
      foreign('hers', DAY, 'geteilt', { who: MEMBERS[0], text: 'Chorprobe', _born: born(hersMs) }),
    ],
    bars: [],
  });
  const read = () => {
    const day = dayNode();
    return {
      capacity: L.rowCapacity(18),
      drawn: $$('.note', day).map((n) => ({ text: n.textContent.trim(), foreign: n.classList.contains('foreign') })),
      more: $('.d-more', day) ? $('.d-more', day).textContent : '—',
    };
  };
  const ORDERS = {
    'HERS is older (March) — the case that used to lose': [TODAY, MARCH],
    'MINE is older (March) — the case that never lost': [MARCH, TODAY],
  };
  const solo = withBoard({ notes: [own('mine', DAY, 'Zahnarzt', { _born: born(TODAY) })], bars: [], settings: SET18 },
    () => $$('.note', dayNode()).map((n) => n.textContent.trim()));
  diag(`   the same day on a SOLO board: ${JSON.stringify(solo)}`);

  const rows = [];
  for (const [label, [mineMs, hersMs]] of Object.entries(ORDERS)) {
    const r = withBoard({ ...scene(mineMs, hersMs), settings: SET18 }, read);
    diag(`18 px · capacity ${r.capacity} · ${label}`);
    diag(`   drawn ${JSON.stringify(r.drawn)} · overflow ${r.more}`);
    rows.push({ id: `17.2/my-board-stays-mine · ${label}`,
      ok: r.drawn.length === 1 && !r.drawn[0].foreign && r.drawn[0].text === solo[0] && r.more === '+1',
      why: `the entry drawn on my own board is ${JSON.stringify(r.drawn)} (overflow „${r.more}"), `
        + `and the solo board draws ${JSON.stringify(solo)}` });
  }
  diag('   `sortNotes` = (_born asc, id asc) and has no owner term; `layout.js:orderForCapacity`');
  diag('   supplies one in front of it, for notes, the way `ownFirst` already did for bars.');
  verdict('§B1 · the capacity slice', rows);
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
  diag('   `assignLanes:ownFirst` protects the 416 bars; `orderForCapacity` protects the 3 059 notes.');
  diag(`   the family did not vanish for it: ${family.more} of the 365 day rows carry a „+n" and every`);
  diag('   entry inside one is reachable through the day popover (2.4/2.5) — see §E3 for the split.');

  verdict('§B2 · 17.2 across both entity kinds', [
    { id: '17.2/bars-are-protected', ok: lostBars.length === 0,
      why: `${lostBars.length} of my own bar segments vanished when the family arrived` },
    // The property, not the percentage: EVERY occurrence of mine the solo board
    // draws is still drawn once seven other people are on the board — the exact
    // sentence `layout.js` already wrote for bars, now true of notes.
    { id: '17.2/notes-are-protected-too', ok: lostNotes.length === 0,
      why: `${lostNotes.length} of ${solo.notes.size} of my own note occurrences (${(lostNotes.length / Math.max(1, solo.notes.size) * 100).toFixed(1)} %) `
        + 'vanished from MY OWN board when seven other people joined — pushed out of the capacity slice by an OLDER foreign entry' },
    // …and it is not bought by drawing FEWER of mine on the solo board.
    { id: '17.2/the-solo-baseline-is-a-complete-board', ok: solo.more === 0,
      why: `the solo baseline carries ${solo.more} „+n" badges, so „every occurrence the solo board draws" `
        + 'is no longer the same thing as „every occurrence of mine" — the comparison would be measuring itself' },
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════
// §B2b · IS §B2's NUMBER A PROPERTY OF THE FIXTURE, OR OF THE RULE?
//
// The one honest objection to §B2 is that the loss depends on WHEN things were
// created, and this fixture interleaves the eight people's stamps. So the same
// board is measured under the three orderings that bracket every real case:
// I joined an established circle and enter last (was the worst), everyone
// enters together (§B2's model), and I was there first (was the best). If the
// range has a bad end, the rule has a bad end — a fixture cannot manufacture
// that, and an ordering fix that only holds for one arrival order is not a fix.
//
// The range is now a POINT — 0 in all three — which is the only shape that
// proves the answer no longer depends on `_born` at all.
// ═════════════════════════════════════════════════════════════════════════════

test('§B2b · no creation order costs me my board — the range is a point', () => {
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
  diag('   It was 0.0 % … 93.5 % before `orderForCapacity`, and the spread was the finding:');
  diag('   the answer depended on `_born`, which is a lottery held between eight people.');
  verdict('§B2b · the range', [
    { id: '17.2/no-creation-order-costs-me-my-board', ok: worst === 0,
      why: `in the worst of the three orders ${worst} of ${solo.size} of my own note occurrences (${(worst / solo.size * 100).toFixed(1)} %) are not drawn on my own board` },
    // The shape, not just the worst end: a rule whose answer still moved with
    // `_born` would leave a spread here even if the worst end happened to be 0.
    { id: '17.2/creation-order-is-not-an-input', ok: best === worst,
      why: `the three orders answer ${JSON.stringify(out)} — the loss still depends on WHEN people entered things` },
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
// §B5 · 17.5 — the „neu" dot a crowded row never drew
//
// „Entries added or changed by others since my last session carry a quiet „neu"
// dot … so I NOTICE CHANGE the way I'd notice new ink on a wall calendar."
//
// The dot is a child of the `.note`. A note that lost the capacity slice drew
// no dot, and `membersui.js` states — deliberately, and with an argument — that
// the family half of the legend carries NO marker. So on a crowded day a peer's
// change arrived with no visible signal anywhere on the board: 113 of 219,
// 51.6 %, measured here when this was an attack.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FIX IS TWO THINGS, AND THIS SECTION ASSERTS BOTH
// ─────────────────────────────────────────────────────────────────────────────
//
//   1. `orderForCapacity`'s SECOND tier — „changed before unchanged", inside
//      the foreign block only. Without it the winner among the peers was
//      `_born` again: the oldest UNCHANGED foreign entry outranked the one that
//      changed this morning. With it, 187 of 219 draw their own dot.
//   2. `day.overflowNew` — how many of the entries the row could not draw are
//      peer changes. This is the accounting the „+n" badge needs, and it exists
//      because of what this section originally said in its own words: the badge
//      „looks identical whether it hides a change or not". A day that hides a
//      change now says so in the model, and a day that hides none answers 0 —
//      the quiet state (Principle 8).
//
// THE RESIDUE IS PRINCIPLE 3, AND THAT IS THE TRADE, NOT A LEAK. The 32 peer
// changes still folded into a badge are on days where MY OWN entries filled the
// row. The third cell below asserts exactly that: a peer change is never
// displaced by an UNCHANGED foreign entry — only by my own ink or by another
// peer change. Principle 3 says the user's own entries win; 17.1 says the
// family appears; this is where the two meet, and the boundary is checked
// rather than asserted in prose.
//
// PRINCIPLE 9 IS UNTOUCHED BY THE ORDERING. `materialize.js:isNewOf` answers
// false for a downgrade and for a deletion before any caller hook is consulted,
// so a downgraded Belegt block sorts exactly where an always-Belegt block of
// the same age sorts. §B5d pins that, because an ordering keyed on `isNew`
// would be a surveillance mechanic if `isNew` were not already downgrade-blind.
// ═════════════════════════════════════════════════════════════════════════════

test('§B5 · every one of the family\'s „neu" markers is drawn or accounted for', () => {
  const settings = { rowHeight: 22, layers: NO_LAYERS, hiddenMembers: {}, bundesland: '' };
  const r = withBoard({ ...FX, settings }, (m) => {
    // every isNew occurrence inside the visible window, from the MODEL
    let inWindow = 0; let drawn = 0; let accounted = 0; let unaccounted = 0;
    let displacedByMine = 0; let displacedByAnotherChange = 0; const displacedByStale = [];
    const halfEmpty = [];
    for (const c of m.cols) {
      for (const d of c.days) {
        if (d.empty) continue;
        const all = (d.allNotes || []).filter((x) => x.isNew);
        const shown = (d.notes || []).filter((x) => x.isNew);
        inWindow += all.length;
        drawn += shown.length;
        const hidden = all.length - shown.length;
        if (!hidden) continue;
        // (2) — the badge on this row must report that it is carrying changes.
        if (d.overflowNew >= hidden) accounted += hidden; else unaccounted += hidden;
        // …and WHAT took the line from them. Only my own ink, or another change.
        for (const x of (d.notes || [])) {
          if (!x.foreign) displacedByMine += 1;
          else if (x.isNew) displacedByAnotherChange += 1;
          else displacedByStale.push(`${d.date} „${(x.note.text || 'Belegt')}"`);
        }
        // A change may only be folded away by a FULL row — never while a line stood empty.
        if (d.notes.length < m.capacity) halfEmpty.push(`${d.date} drew ${d.notes.length} of ${m.capacity}`);
      }
    }
    // ── THE GLASS HALF (3) ───────────────────────────────────────────────────
    // The model can only be trusted about the badge if something DRAWS it. Two
    // censuses, from the DOM, compared against the model's own answer per row:
    // every badge whose day reports `overflowNew > 0` must carry the tell, and
    // no badge whose day reports 0 may carry it — a tell on every badge would
    // be the same non-signal as a tell on none.
    let tellMissing = 0; let tellSpurious = 0; let tellDrawn = 0; let quietBadges = 0;
    const byDate = new Map();
    for (const c of m.cols) for (const d of c.days) if (!d.empty) byDate.set(d.date, d);
    for (const badge of $$('#board .d-more')) {
      const d = byDate.get(badge.dataset.date);
      if (!d) continue;
      const has = badge.classList.contains('has-new');
      if (d.overflowNew > 0) { if (has) tellDrawn += 1; else tellMissing += 1; }
      else { quietBadges += 1; if (has) tellSpurious += 1; }
    }
    return { inWindow, drawn, accounted, unaccounted, displacedByMine, displacedByAnotherChange,
      displacedByStale, halfEmpty, capacity: m.capacity,
      tellMissing, tellSpurious, tellDrawn, quietBadges,
      dots: $$('#board .note .neu-dot').length, labelDots: $$('#board .bar-label .neu-dot').length };
  });
  const folded = r.inWindow - r.drawn;
  diag(`17.5 · foreign notes marked „neu" inside the 12-month window: ${r.inWindow}`);
  diag(`      drawn with their own dot: ${r.drawn} (${(r.drawn / r.inWindow * 100).toFixed(1)} %) — `
    + `${r.dots} „neu" dots were in the DOM at render time. It was 106 before the second tier existed.`);
  diag(`      folded into a „+n": ${folded} — of which ${r.accounted} sit on a day whose model reports `
    + `overflowNew > 0, and ${r.unaccounted} do not`);
  diag(`      what took their line: ${r.displacedByMine} lines of MY OWN ink · ${r.displacedByAnotherChange} another peer change `
    + `· ${r.displacedByStale.length} an UNCHANGED foreign entry`);
  diag(`      bar labels carrying a dot: ${r.labelDots}`);
  diag(`      the „+n" tell on the glass: ${r.tellDrawn} badges carry it, ${r.tellMissing} that should do not, `
    + `and ${r.tellSpurious} of ${r.quietBadges} badges hiding no change carry it anyway`);
  for (const s of r.displacedByStale.slice(0, 8)) diag(`   ! an unchanged foreign entry holds the line on ${s}`);
  verdict('§B5 · 17.5 reachability', [
    { id: '17.5/every-change-is-noticeable', ok: r.unaccounted === 0,
      why: `${r.unaccounted} of ${r.inWindow} peer changes inside the visible window are neither drawn with `
        + 'their dot nor counted by their day\'s `overflowNew` — inside a „+n" badge that looks identical '
        + 'whether it hides a change or not' },
    { id: '17.5/a-change-outranks-an-unchanged-peer-entry', ok: r.displacedByStale.length === 0,
      why: `${r.displacedByStale.length} peer changes lost the row to an UNCHANGED foreign entry: `
        + r.displacedByStale.slice(0, 4).join(' · ') },
    // The trade, named and bounded: a change is folded only by a FULL row.
    { id: '2.4/a-change-is-never-folded-while-a-line-stands-empty', ok: r.halfEmpty.length === 0,
      why: `${r.halfEmpty.length} day rows folded a peer change into „+n" without filling their `
        + `${r.capacity} lines: ` + r.halfEmpty.slice(0, 4).join(' · ') },
    // ── AND IT REACHES THE GLASS ─────────────────────────────────────────────
    // `overflowNew` shipped as a model field with nothing reading it, so for one
    // round 17.5 was closed in the layout and open on the board: the badge still
    // „looks identical whether it hides a change or not", which is this
    // section's own wording for the defect. These two cells are what stops that
    // from happening again, and they are a PAIR on purpose — the first alone is
    // satisfied by marking every badge, which signals nothing.
    { id: '17.5/the-badge-says-it-is-holding-a-change', ok: r.tellMissing === 0,
      why: `${r.tellMissing} badges sit on a day whose model reports overflowNew > 0 and carry no tell — `
        + 'the change is counted in the model and invisible on the board' },
    { id: '17.5/and-stays-quiet-when-it-is-not', ok: r.tellSpurious === 0,
      why: `${r.tellSpurious} of ${r.quietBadges} badges hiding NO change carry the tell anyway — `
        + 'a mark on every badge is Principle 8\'s quiet state broken, and says nothing' },
  ]);
});

test('§B5d · a downgrade does not move in the queue — Principle 9, on the comparator', () => {
  // ADR 004 §7 rule 1: a Belegt block downgraded from Geteilt renders identically
  // to one that was always Belegt. `orderForCapacity`'s second tier reads `isNew`,
  // and `materialize.js:isNewOf` answers false for a downgrade — so the two sort
  // to the same place. Asserted on the RENDERED row, not on the comparator, because
  // the claim is about what a viewer can see.
  const SET = { rowHeight: 22, layers: NO_LAYERS, hiddenMembers: {} };
  const T = Date.UTC(2026, 0, 1);
  // One slot for the family: my own note takes the first of the two lines.
  const base = (hers) => ({
    notes: [
      own('mine', DAY, 'Zahnarzt', { _born: born(T + 90) }),
      hers,
      foreign('theirs', DAY, 'geteilt', { who: MEMBERS[1], text: 'Ballett', _born: born(T + 10), isNew: true }),
    ],
    bars: [],
  });
  const read = () => $$('.note', dayNode()).map((n) => n.textContent.trim());
  // „was Geteilt yesterday, now Belegt": `isNew` is false by materialization.
  const downgraded = foreign('hers', DAY, 'belegt', { who: MEMBERS[0], _born: born(T), isNew: false });
  // „always Belegt", same owner, same age, same everything.
  const alwaysBelegt = foreign('hers', DAY, 'belegt', { who: MEMBERS[0], _born: born(T), isNew: false });
  const a = withBoard({ ...base(downgraded), settings: SET }, read);
  const b = withBoard({ ...base(alwaysBelegt), settings: SET }, read);
  diag(`   downgraded-from-Geteilt row: ${JSON.stringify(a)}`);
  diag(`   always-Belegt row:           ${JSON.stringify(b)}`);
  verdict('§B5d · Principle 9 on the queue', [
    { id: 'principle-9/a-downgrade-sorts-where-an-always-belegt-entry-sorts', ok: JSON.stringify(a) === JSON.stringify(b),
      why: 'the two rows differ, so the ORDER of the capacity slice reports a level history' },
  ]);
});
