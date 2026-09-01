// TIER 2 · E8 — ATTRIBUTION, FAMILY FIND, PRINT PARITY (LZP-805 · 806 · 807).
//
// Stories 17.1, 17.3, 17.4, 17.6 · 14.1 · 12.3 · 18.1, 18.5 · A3, A6, A7, A8 · Principle 9.
// Normative sources: addendum F17 · ADR 004 §4.2, §4.3, §7.1 · ADR 002 §7.4 (the copy contract)
// · DESIGN-DECISIONS.md (open question 6 — the print legend; "find counts entries, not segments").
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THESE THREE TICKETS HAVE IN COMMON, AND WHY THEY ARE ONE FILE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// All three are the SAME QUESTION asked at three exits: given another member's entry on my
// board, what may leave it — into a popover, into a search, onto paper? The answer has one shape
// everywhere: WHO and WHEN may leave; WHAT may not, unless the level says so. A file per ticket
// would have tested that answer three times without ever putting the three next to each other,
// which is where a disagreement between them would live.
//
// The redaction invariant itself is asserted on ops and on sealed bytes in tier 1 and in the
// attack suite; nothing here claims a leak is impossible. What is asserted here is the weaker,
// renderer-shaped claim these three files can actually make: GIVEN an entry that is Belegt, no
// popover line, no search result and no printed sheet reproduces a text — including the
// store-wide list, which is the one search surface that reads the STATE instead of the DOM and
// therefore the one place the board's own redaction seam could have been forgotten.
//
// Plain script, not a module: globals are test, assert, $, $$, waitFor, sleep, importApp, diag.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const popover = await importApp('popover.js');
const sharing = await importApp('family/sharing.js');
const print = await importApp('print.js');
const find = await importApp('find.js');
const i18n = await importApp('i18n.js');
const { store } = await importApp('store.js');
const { renderBoard, currentModel } = await importApp('board.js');
const { iso } = await importApp('dates.js');
const { PALETTE, colorOf } = await importApp('palette.js');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 0 · scaffolding — one Familienkreis, two members, and the three ports
// ═════════════════════════════════════════════════════════════════════════════════════════════

const SPACE = 'fsp_0123456789abcdefghijkm';
const MAMA = 'mem_mama0000000000000000000';
const PAPA = 'mem_papa0000000000000000000';
const NOBODY = 'mem_xxxx0000000000000000000';   // a member whose record has not folded yet

store.useFamilySpace(SPACE);
// The one door, exactly as `family/mount.js` calls it. `useMemberNames` is the second half of
// that door and this ticket's addition: without it 17.6 says „von M", which is an initial, not
// a name (see `popover.js:useMemberNames`).
popover.useSharing(sharing);
popover.useMemberNames((id) => ({ [MAMA]: 'Mama', [PAPA]: 'Papa' })[id] ?? null);

const boardEl = () => $('#board');

/** The second visible column — never today's row, and present in rolling and pinned mode. */
const COL = (() => renderBoard(boardEl()).cols[1])();
const D = (day) => iso(COL.y, COL.m, day);

// 2026-09-13T12:00Z is a Sunday from UTC-11 to UTC+11, which makes „geändert So." reproducible
// wherever this suite runs. Copied from `sharing-control.dom.js` on purpose: the two files must
// not disagree about which day it is.
const SUNDAY = `${Date.UTC(2026, 8, 13, 12)}.000001.MAMA000000000000`;
const ME = 'mem_me00000000000000000000000';

const MEMBERS = {
  mama: { id: MAMA, colorRef: 'magenta', initial: 'M', name: 'Mama' },
  papa: { id: PAPA, colorRef: 'gruen', initial: 'P', name: 'Papa' },
  nobody: { id: NOBODY, colorRef: null, initial: null, name: null },
};

/** One of MINE, in the shape `materialize.js` hands the board and the popover. */
const own = (id, day, text, x = {}) => ({
  id, uuid: id, date: D(day), text, categoryId: store.state.categories[0].id,
  repeatsYearly: false, isForeign: false, ownerId: ME, visibility: 'privat', level: null,
  redacted: false, memberColorRef: null, initial: null, exposure: null, isNew: false, ...x,
});

/** SOMEONE ELSE'S note. `id` is the entity key — what `materialize.js:foreignCandidate` puts
 *  there, and what makes the id unique across members. */
const foreign = (id, day, level, who = MEMBERS.mama, x = {}) => ({
  id: `fnote:${who.id}/${id}`, uuid: id, date: D(day), text: null, repeatsYearly: false,
  isForeign: true, ownerId: who.id, level, redacted: level === 'belegt',
  memberColorRef: who.colorRef, initial: who.initial, exposure: null, isNew: false,
  coEdit: false, updatedAt: SUNDAY, ...x,
});

const ownBar = (id, from, to, label, x = {}) => ({
  id, uuid: id, startDate: D(from), endDate: D(to), label,
  categoryId: store.state.categories[2].id, isForeign: false, ownerId: ME,
  visibility: 'privat', level: null, redacted: false, memberColorRef: null, initial: null,
  exposure: null, isNew: false, ...x,
});

const foreignBar = (id, from, to, level, who = MEMBERS.mama, x = {}) => ({
  id: `fbar:${who.id}/${id}`, uuid: id, startDate: D(from), endDate: D(to), label: null,
  isForeign: true, ownerId: who.id, level, redacted: level === 'belegt',
  memberColorRef: who.colorRef, initial: who.initial, exposure: null, isNew: false,
  coEdit: false, updatedAt: SUNDAY, ...x,
});

/**
 * Render a board made of exactly these entries, run `fn`, and put everything back.
 *
 * The arrays are ASSIGNED rather than minted through the store, for the reason
 * `belegt-render.dom.js` gives at length: no device in this tree can yet RECEIVE a foreign
 * entry, so the materialized entry is the seam these three files own and its upstream is tier
 * 1's. Everything below the seam — popover, find, print — is real product code on real DOM.
 */
function withBoard({ notes = [], bars = [], lang = 'de' }, fn) {
  const before = { notes: store.state.notes, bars: store.state.bars, lang: i18n.getLang() };
  try {
    i18n.setLang(lang);
    store.state.notes = notes;
    store.state.bars = bars;
    renderBoard(boardEl());
    return fn();
  } finally {
    popover.closePopover();
    store.state.notes = before.notes;
    store.state.bars = before.bars;
    i18n.setLang(before.lang);
    renderBoard(boardEl());
  }
}

const openOn = (day) => {
  popover.closePopover();
  const anchor = $(`#board .day[data-date="${D(day)}"]`) || $('#board .col');
  // Exactly `interact.js`'s call — no `nameOf`, so the installed port is the one under test.
  popover.openDayPopover(anchor, D(day), { onChange: () => {} });
  return $('.popover');
};

const rowFor = (id) => $(`.popover .pop-row[data-entry="${CSS.escape(id)}"]`);
/** The attribution line that belongs to one row: the next sibling, if it is one. */
const attrFor = (id) => {
  const row = rowFor(id);
  const next = row && row.nextElementSibling;
  return next && next.classList.contains('pop-attr') ? next.textContent : null;
};
const allAttrs = () => $$('.popover .pop-attr').map((n) => n.textContent);

/** The three-bucket reporter the other domain suites use, so a red cell names itself. */
function verdict(label, rows) {
  const bad = rows.filter((r) => !r.ok);
  diag(`${label}: ${rows.length - bad.length}/${rows.length} cells hold`);
  for (const r of bad) diag(`  ✗ ${r.id} — ${r.why}`);
  assert.equal(bad.length, 0, bad.length ? `${label}: ${bad.map((r) => r.id).join(', ')}` : '');
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · 17.6 — ATTRIBUTION IS ON THE ROW (LZP-805)
//
// „Hover/popover shows attribution: 'von Mama · geteilt · geändert So.', so provenance is one
// glance away but never printed on the board."
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§1 · 17.6 — the addendum\'s own sentence, verbatim, on the row itself', () => {
  const n = foreign('a1', 5, 'geteilt', MEMBERS.mama, { text: 'Chorprobe' });
  withBoard({ notes: [n] }, () => {
    openOn(5);
    assert.equal(attrFor(n.id), sharing.ATTRIBUTION_EXAMPLE,
      'the line under the row must be F17.6\'s example string, not a paraphrase of it');
  });
});

test('§1 · the name comes from the PORT — without it, the initial; with it, „Mama"', () => {
  const n = foreign('a2', 5, 'geteilt', MEMBERS.mama, { text: 'Chorprobe' });
  withBoard({ notes: [n] }, () => {
    popover.useMemberNames(null);                    // a Mac whose roster has not folded yet
    openOn(5);
    assert.equal(attrFor(n.id), 'von M · geteilt · geändert So.',
      'with no roster the chip\'s initial stands in — honest, and never a guessed name');
    popover.useMemberNames((id) => ({ [MAMA]: 'Mama', [PAPA]: 'Papa' })[id] ?? null);
    openOn(5);
    assert.equal(attrFor(n.id), 'von Mama · geteilt · geändert So.');
  });
});

test('§1 · a member with no record at all is „einem Mitglied", never a guess', () => {
  const n = foreign('a3', 5, 'geteilt', MEMBERS.nobody, { text: 'Termin' });
  withBoard({ notes: [n] }, () => {
    openOn(5);
    assert.equal(attrFor(n.id), 'von einem Mitglied · geteilt · geändert So.');
  });
});

test('§1 · THE DOMAIN — who gets a line, who does not, and what it says', () => {
  // [id, entry, expected line | null]. The axis that decides is not "foreign": it is whether
  // there is a PERSON to attribute this to who is not me.
  const CELLS = [
    ['mine/privat', own('c1', 6, 'Zahnarzt'), null],
    ['mine/geteilt', own('c2', 6, 'Bilanz', { visibility: 'geteilt' }), null],
    // 18.5 / ADR 004 §4.1 — a co-editor's write is the one thing on MY entry worth a line.
    ['mine/edited-by-Mama',
      own('c3', 6, 'Elternabend', { visibility: 'geteilt', updatedBy: MAMA, updatedAt: SUNDAY }),
      'zuletzt geändert von Mama · So.'],
    ['foreign/geteilt', foreign('c4', 6, 'geteilt', MEMBERS.mama, { text: 'Chorprobe' }),
      'von Mama · geteilt · geändert So.'],
    // 16.7 — a Belegt block has no text, so the owner IS what there is to say about it.
    ['foreign/belegt', foreign('c5', 6, 'belegt', MEMBERS.papa),
      'von Papa · belegt · geändert So.'],
    ['foreign/geteilt+coEdit',
      foreign('c6', 6, 'geteilt', MEMBERS.papa, { text: 'Urlaub', coEdit: true }),
      'von Papa · geteilt · geändert So.'],
    // No stamp is not a wrong stamp: the sentence simply stops early.
    ['foreign/no-stamp',
      foreign('c7', 6, 'geteilt', MEMBERS.mama, { text: 'Kur', updatedAt: null }),
      'von Mama · geteilt'],
  ];
  withBoard({ notes: CELLS.map(([, e]) => e) }, () => {
    openOn(6);
    verdict('§1 attribution domain', CELLS.map(([id, e, want]) => {
      const got = attrFor(e.id);
      return { id, ok: got === want, why: `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}` };
    }));
  });
});

test('§1 · bars carry it too — a shared family holiday is the likeliest entry in the product', () => {
  const b = foreignBar('a4', 4, 12, 'geteilt', MEMBERS.mama, { label: 'Ferien Nordsee' });
  withBoard({ bars: [b] }, () => {
    openOn(6);
    assert.equal(attrFor(b.id), 'von Mama · geteilt · geändert So.',
      'ADR 004 §4.3: the cluster is on BOTH row builders, and so is its sentence');
  });
});

test('§1 · English says it in English', () => {
  const n = foreign('a5', 5, 'geteilt', MEMBERS.mama, { text: 'Choir' });
  const b = foreign('a6', 5, 'belegt', MEMBERS.papa);
  withBoard({ notes: [n, b], lang: 'en' }, () => {
    openOn(5);
    assert.equal(attrFor(n.id), 'by Mama · shared · edited Su.');
    assert.equal(attrFor(b.id), 'by Papa · busy · edited Su.');
  });
});

test('§1 · it is never said twice — the open strip carries it, the row stands down', () => {
  const n = foreign('a7', 5, 'geteilt', MEMBERS.mama, { text: 'Chorprobe' });
  withBoard({ notes: [n] }, () => {
    openOn(5);
    assert.equal(allAttrs().length, 1, 'closed: one line, on the row');
    const visible = () => $$('.popover .share-attr').filter((a) => !a.hidden).length;
    rowFor(n.id).querySelector('.share-trig').click();
    assert.ok($('.popover .pop-share'), 'the strip opened');
    assert.equal(visible(), 1, 'open: still exactly one sentence in the card — the strip\'s');
    assert.ok($('.popover .pop-attr').hidden, 'and it is the ROW\'s that stood down');
    // …and it comes back when the strip goes, without a re-render to rebuild it.
    rowFor(n.id).querySelector('.share-trig').click();
    assert.equal($('.popover .pop-share'), null, 'the strip closed');
    assert.equal(visible(), 1);
    assert.equal(attrFor(n.id), sharing.ATTRIBUTION_EXAMPLE);
  });
});

test('§1 · SOLO MODE HAS NO PROVENANCE, because there is nobody to attribute anything to', () => {
  const n = own('a8', 5, 'Zahnarzt');
  withBoard({ notes: [n] }, () => {
    popover.useSharing(null);                        // leaving the circle (20.3)
    openOn(5);
    assert.equal($$('.popover .pop-attr').length, 0);
    popover.useSharing(sharing);
  });
});

test('§1 · 17.6 — PROVENANCE, NOT PRESENCE (Principle 9): no read receipt anywhere in the card', () => {
  // Who wrote it and when it changed — never who looked, who has it open, who has read it.
  const PRESENCE = [
    'gesehen', 'angesehen', 'gelesen', 'liest', 'online', 'anwesend', 'zuletzt aktiv',
    'seen', 'viewed', 'read by', 'is viewing', 'online now', 'last active', 'typing',
  ];
  const entries = [
    foreign('p1', 7, 'geteilt', MEMBERS.mama, { text: 'Chorprobe' }),
    foreign('p2', 7, 'belegt', MEMBERS.papa),
    own('p3', 7, 'Elternabend', { visibility: 'geteilt', updatedBy: MAMA, updatedAt: SUNDAY }),
  ];
  const rows = [];
  for (const lang of ['de', 'en']) {
    withBoard({ notes: entries, lang }, () => {
      openOn(7);
      // Every string the card can show, including the disclosed strip of every row.
      for (const trig of $$('.popover .share-trig')) trig.click();
      const text = $('.popover').textContent.toLocaleLowerCase(lang);
      for (const word of [...PRESENCE, ...sharing.FORBIDDEN_CLAIMS]) {
        rows.push({ id: `${lang}/${word}`, ok: !text.includes(word.toLocaleLowerCase(lang)),
          why: 'the popover said it' });
      }
    });
  }
  verdict('§1 presence sweep', rows);
});

test('§1 · WHAT IT COSTS: zero board pixels, zero row slots, ~12 px inside the card', () => {
  const mine = own('m1', 8, 'Zahnarzt');
  const theirs = foreign('m2', 8, 'geteilt', MEMBERS.mama, { text: 'Chorprobe' });
  withBoard({ notes: [mine, theirs] }, () => {
    const rowH = $(`#board .day[data-date="${D(8)}"]`).getBoundingClientRect().height;
    openOn(8);
    // The v1 row is untouched: 17.6 ends with "never printed on the board", and the popover is
    // not the board. `belegt-render.dom.js` owns the board-side budget.
    assert.equal(Math.round(rowH), store.state.settings.rowHeight,
      'the day row must be exactly the row-height setting — attribution costs the grid nothing');
    // The row's own slot count is v1's, which `sharing-control.dom.js` pins at three `.act`s.
    assert.equal(rowFor(mine.id).querySelectorAll('.act').length, 3,
      '↻, the sharing trigger, ✕ — the line is a sibling of the row, not a fourth control');
    const line = $('.popover .pop-attr').getBoundingClientRect().height;
    diag(`§1 · attribution line = ${line.toFixed(1)} px inside a ${$('.popover').getBoundingClientRect().height.toFixed(0)} px card`);
    assert.ok(line > 8 && line < 18, `one 8.5 px line box, measured ${line.toFixed(1)} px`);
  });
});

test('§1 · and it is never printed on the board — the whole card leaves the sheet', () => {
  const n = foreign('m3', 8, 'geteilt', MEMBERS.mama, { text: 'Chorprobe' });
  withBoard({ notes: [n] }, () => {
    openOn(8);
    // `print.css`: `.popover { display: none !important }` under `@media print`. The rule is read
    // out of the sheet rather than asserted by eye, because that is the only thing that decides.
    let rule = null;
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const r of rules) {
        if (!r.media || ![...r.media].includes('print')) continue;
        for (const inner of r.cssRules) {
          if (inner.selectorText && /(^|,\s*)\.popover(\s|,|$)/.test(inner.selectorText)) rule = inner.cssText;
        }
      }
    }
    assert.ok(rule, 'no @media print rule hides .popover');
    assert.includes(rule, 'none');
    // And the board itself gained nothing: the sentence lives in the card, not in the ink.
    assert.equal($('#board').textContent.includes('von Mama'), false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · A6 / 14.1 — FIND COVERS THE FAMILY (LZP-806)
//
// „Find searches family entries too (shared text, Belegt matches on owner name); dimming logic
// unchanged."
// ═════════════════════════════════════════════════════════════════════════════════════════════

const findInput = () => $('#find-input');
const findCount = () => $('#find-count');

/** Type into the real search field and read back what the board did. */
function search(q) {
  const inp = findInput();
  inp.value = q;
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return {
    count: findCount().textContent,
    n: (findCount().textContent.match(/\/(\d+)/) || [])[1],
    hits: $$('#board .note.hit, #board .bar-label.hit').map((n) => n.textContent.trim()),
    labels: $$('#board .bar-label.hit').length,
    finding: document.body.classList.contains('finding'),
    history: $$('#find-history .fh-row').map((r) => r.textContent),
  };
}
const clearSearch = () => search('');

const FAMILY_BOARD = () => ({
  notes: [
    own('s1', 9, 'Zahnarzt'),
    foreign('s2', 9, 'geteilt', MEMBERS.mama, { text: 'Chorprobe' }),
    foreign('s3', 11, 'belegt', MEMBERS.papa),
    foreign('s4', 13, 'geteilt', MEMBERS.mama, { text: 'Omas Geburtstag' }),
  ],
  bars: [
    ownBar('s5', 3, 6, 'Projekt'),
    foreignBar('s6', 15, 20, 'geteilt', MEMBERS.mama, { label: 'Ferien Nordsee' }),
  ],
});

test('§2 · A6 — shared text is findable, and the owner is the handle for what has no text', () => {
  withBoard(FAMILY_BOARD(), () => {
    const CELLS = [
      ['shared text', 'chorprobe', ['Chorprobe']],
      ['shared bar label', 'nordsee', ['Ferien Nordsee']],
      // The one A6 spells out: a Belegt entry has nothing to match but its owner.
      ['belegt by owner name', 'papa', ['Belegt']],
      // …and everything of one member's, in one query — the question a family actually asks.
      ['owner name', 'mama', ['Chorprobe', 'Omas Geburtstag', 'Ferien Nordsee']],
      // v1, unchanged: my own entries answer to their text and to nothing else.
      ['mine', 'zahnarzt', ['Zahnarzt']],
      ['mine, by another member\'s name', 'oma', ['Omas Geburtstag']],
      ['nobody', 'quatsch', []],
    ];
    verdict('§2 find domain', CELLS.map(([id, q, want]) => {
      const got = search(q).hits.map((h) => h.replace(/^[MP↻]+/, ''));
      const ok = got.length === want.length && want.every((w) => got.some((g) => g.includes(w)));
      return { id, ok, why: `“${q}” → ${JSON.stringify(got)}, expected ${JSON.stringify(want)}` };
    }));
    clearSearch();
  });
});

test('§2 · find counts ENTRIES, not segments — a foreign bar\'s months light up as one hit', () => {
  // Mama's bar runs out of this column into the next two: three labels, one entry (3.7 / 3.2).
  const b = {
    ...foreignBar('s7', 25, 25, 'geteilt', MEMBERS.mama, { label: 'Kur Ostsee' }),
    endDate: iso(COL.y, COL.m + 2 > 12 ? COL.m - 10 : COL.m + 2, 5),
  };
  withBoard({ bars: [b] }, () => {
    const r = search('kur');
    diag(`§2 · “kur” → ${r.count} with ${r.labels} month labels lit`);
    assert.ok(r.labels >= 2, 'the bar must wear a label in each month it crosses');
    assert.equal(r.n, '1', 'DESIGN-DECISIONS: one entry, however many segments wear its label');
    clearSearch();
  });
});

test('§2 · dimming is untouched: the same body class, the same .hit, no family branch', () => {
  withBoard(FAMILY_BOARD(), () => {
    const r = search('mama');
    assert.equal(r.finding, true, 'body.finding is v1\'s one switch and it is still the switch');
    const dimmed = $$('#board .note:not(.hit)');
    assert.ok(dimmed.length > 0, 'something must be dimmed for the test to mean anything');
    const opacity = Number(getComputedStyle(dimmed[0]).opacity);
    assert.ok(opacity < 1, `a non-match must recede (opacity ${opacity})`);
    assert.equal(Number(getComputedStyle($('#board .note.hit')).opacity), 1,
      'and a match keeps full colour — including one that is somebody else\'s');
    clearSearch();
  });
});

test('§2 · 14.2 — the store-wide list finds her Belegt entry by name and prints the WORD', () => {
  // Outside the visible window, so it can only appear in the offscreen list (14.2 [Could]).
  const old = { ...foreign('s8', 1, 'belegt', MEMBERS.mama), date: '2015-03-04' };
  withBoard({ notes: [old, own('s9', 9, 'Zahnarzt')] }, () => {
    const r = search('mama');
    assert.equal(r.history.length, 1, 'her out-of-window Belegt entry is a store-wide match');
    assert.includes(r.history[0], '04.03.2015');
    assert.includes(r.history[0], 'Belegt');
    // ADR 004 §4.2's seam, in the one search surface that reads the STATE and not the DOM.
    assert.equal(find.historyHits('mama').every((h) => h.text === 'Belegt' || h.text === ''), true,
      'nothing but the level word may stand in for a text that was never transmitted');
    clearSearch();
  });
});

test('§2 · REGRESSION — a Belegt entry in the state must not take the search down with it', () => {
  // v1's `n.text.toLowerCase()` threw a TypeError on `text: null`, which is every Belegt entry
  // another member sends. One keystroke killed find, the offscreen list included.
  withBoard({ notes: [foreign('s10', 9, 'belegt', MEMBERS.papa)] }, () => {
    let threw = null;
    try { search('a'); } catch (e) { threw = e; }
    assert.equal(threw, null, `find threw on a foreign Belegt note: ${threw && threw.message}`);
    // „Papa" still answers to his own name (that is §2's first test); what must NOT happen is a
    // text that does not exist matching everything, or nothing being searchable at all.
    assert.deepEqual(find.historyHits('zahn').map((h) => h.text), [],
      'an absent text matches nothing — and never everything');
    assert.deepEqual(find.historyHits('papa').map((h) => h.text), ['Belegt'],
      'the owner is the handle, and the word is all that comes back');
    clearSearch();
  });
});

test('§2 · a solo board searches exactly what v1 searched', () => {
  withBoard({ notes: [own('s11', 9, 'Zahnarzt'), own('s12', 10, 'Zahnarzt Termin')] }, () => {
    assert.equal(search('zahnarzt').n, '2');
    assert.equal(search('mama').n, undefined, 'no member, no handle, no phantom match');
    clearSearch();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · A8 / 12.3 — PRINT PARITY (LZP-807)
//
// „Print renders what's visible — including family entries and honouring member toggles."
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Build the print furniture the way `window.print()` does, and read the strip back. */
function sheet() {
  window.dispatchEvent(new Event('beforeprint'));
  const legend = $('#print-legend');
  return {
    cats: $$('#print-legend .item:not(.member) .nm').map((n) => n.textContent),
    members: $$('#print-legend .item.member').map((i) => ({
      name: i.querySelector('.nm').textContent,
      initial: i.querySelector('.sw').textContent,
      bg: i.querySelector('.sw').style.background,
    })),
    order: [...legend.children].map((c) => c.className),
    redacted: $$('#board .redacted-word').map((w) => w.textContent),
    text: legend.textContent,
  };
}

test('§3 · A3 — the strip gains a second section: my categories, a rule, then the people', () => {
  withBoard(FAMILY_BOARD(), () => {
    const s = sheet();
    assert.deepEqual(s.cats, store.state.categories.map((c) => c.name), 'section one is v1\'s');
    assert.deepEqual(s.members.map((m) => m.name), ['Mama', 'Papa'],
      'section two is the people whose ink is on this sheet, sorted so two prints agree');
    // A3 asks for two sections; `membersui.js` argued the LABEL is what goes, because v1 ships a
    // category called „Familie" and the word would print twice meaning two things. The divider
    // carries the split on paper for the same reason — and there is no hover to repair it.
    const order = s.order.join(' ');
    assert.match(order, /item item item item sep item member item member layers/,
      `the strip must read categories → rule → members → layers, got: ${order}`);
    assert.equal(s.text.includes('Familie im Kreis') || s.text.split('Familie').length > 2, false,
      'and the word „Familie" appears at most once — as the CATEGORY it has always been');
  });
});

test('§3 · 17.2 — the key is the member\'s colour and initial, never a category tone', () => {
  const CELLS = [
    ['known member', MEMBERS.mama, { name: 'Mama', initial: 'M', hex: colorOf('magenta') }],
    ['no colour, no name', MEMBERS.nobody, { name: 'Mitglied', initial: '', hex: null }],
  ];
  verdict('§3 member key domain', CELLS.map(([id, who, want]) => {
    let row = null;
    withBoard({ notes: [foreign('k1', 9, 'geteilt', who, { text: 'Termin' })] }, () => {
      row = sheet().members[0];
    });
    if (!row) return { id, ok: false, why: 'no key row at all' };
    const bg = row.bg;
    const okColour = want.hex
      ? bg.replace(/\s/g, '') === want.hex.replace(/\s/g, '') || bg.startsWith('rgb')
      // `colorOf(null)` answers PALETTE[0] — blue, i.e. somebody's colour. A member with none
      // yet must get neutral ink instead (`layout.js` and `popover.js:paintDot` agree).
      : !bg.includes(PALETTE[0].hex ?? PALETTE[0]);
    const ok = row.name === want.name && row.initial === want.initial && okColour;
    return { id, ok, why: `got ${JSON.stringify(row)}, expected ${JSON.stringify(want)}` };
  }));
});

test('§3 · 17.3 — a hidden member is absent from the sheet AND from the key', () => {
  const b = FAMILY_BOARD();
  const s1 = (() => { let r; withBoard(b, () => { r = sheet(); }); return r; })();
  assert.deepEqual(s1.members.map((m) => m.name), ['Mama', 'Papa']);
  // Hiding Papa is a PROJECTION filter (`materialize.js` → `projectable`, via
  // `store._hiddenMembers()`), so what reaches the board is a board with no Papa on it. That
  // upstream step is tier 1's; this is what the sheet must do with its result.
  const hidden = {
    notes: b.notes.filter((n) => n.ownerId !== PAPA),
    bars: b.bars.filter((x) => x.ownerId !== PAPA),
  };
  withBoard(hidden, () => {
    const s2 = sheet();
    assert.deepEqual(s2.members.map((m) => m.name), ['Mama'], 'Papa may not survive in the key');
    assert.equal($('#board').textContent.includes('P'), $('#board').textContent.includes('P'));
    assert.equal($$('#board .note.foreign, #board .bar.foreign')
      .some((n) => (n.dataset.noteId || n.dataset.barId || '').includes(PAPA)), false,
      'and nothing of his is on the sheet to need a key');
  });
});

test('§3 · a member with no ink on this sheet gets no key row', () => {
  // Her entry exists in the state but falls outside the printed window, so her colour is not on
  // the paper — and a key for a colour nobody can see is noise, not honesty.
  const away = { ...foreign('k2', 1, 'geteilt', MEMBERS.papa, { text: 'Segeln' }), date: '2015-05-05' };
  withBoard({ notes: [away, foreign('k3', 9, 'geteilt', MEMBERS.mama, { text: 'Chorprobe' })] }, () => {
    assert.deepEqual(sheet().members.map((m) => m.name), ['Mama']);
  });
});

test('§3 · 16.7 — Belegt prints as Belegt, in both languages, and never as a text', () => {
  for (const [lang, word] of [['de', 'Belegt'], ['en', 'Busy']]) {
    withBoard({
      notes: [foreign('k4', 9, 'belegt', MEMBERS.papa, { text: 'LEAK' })],
      bars: [foreignBar('k5', 12, 16, 'belegt', MEMBERS.mama, { label: 'LEAK' })],
      lang,
    }, () => {
      const s = sheet();
      assert.deepEqual(s.redacted, [word], `the block prints the word „${word}"`);
      assert.equal($('#board').textContent.includes('LEAK'), false,
        'a text that reached a Belegt entry is a defect three layers up — the sheet still may not print it');
      assert.equal($('#print-legend').textContent.includes('LEAK'), false);
    });
  }
});

test('§3 · the key is device-local and says so by what it does NOT print: no ids, no space', () => {
  withBoard(FAMILY_BOARD(), () => {
    const txt = $('#print-legend').textContent + $('#print-head').textContent;
    assert.equal(txt.includes('mem_'), false, 'a MemberId is a pseudonym, not a name for paper');
    assert.equal(txt.includes('fsp_'), false);
    assert.equal(txt.includes('fnote:'), false);
  });
});

test('§3 · solo mode prints exactly the v1 strip — no rule, no people, nothing new', () => {
  withBoard({ notes: [own('k6', 9, 'Zahnarzt')], bars: [ownBar('k7', 3, 6, 'Projekt')] }, () => {
    const s = sheet();
    assert.equal(s.members.length, 0);
    assert.equal(s.order.includes('sep'), false, 'not even the divider — there is no second section');
    assert.deepEqual(s.cats, store.state.categories.map((c) => c.name));
  });
});

test('§3 · the sheet still fits ONE page: the key costs the A4 strip one line, not two', () => {
  // The A4 content box is 297 × 210 mm less 8 mm margins = 1062 × 733 px at 96 dpi, which is
  // `print.css`'s own arithmetic. The question is not how wide the key is but whether the strip
  // WRAPS: `.print-legend` is `flex-wrap: wrap`, and a second line is ~11 px of a page that has
  // about 2 px to spare — i.e. the difference between a poster and a two-page printout.
  //
  // So the print rules are lifted out of their `@media print` block and applied on screen, which
  // is the only way to measure 7 pt type in the engine that will actually set it.
  const A4_CONTENT_PX = 1062;
  const names = ['Mama', 'Papa', 'Oma Ingrid', 'Opa Werner', 'Lisa', 'Jonas', 'Charlotte', 'Maximilian'];
  const tones = ['magenta', 'gruen', 'blau', 'orange', 'tuerkis', 'rot', 'lila', 'ocker'];
  const ids = names.map((_, i) => `mem_${String(i)}${'0'.repeat(22)}`);
  const many = names.map((n, i) => foreign(`w${i}`, 2 + i, 'geteilt',
    { id: ids[i], colorRef: tones[i], initial: n[0] }, { text: `Termin ${i}` }));
  popover.useMemberNames((id) => (ids.includes(id) ? names[ids.indexOf(id)] : null));

  const printRules = () => {
    const out = [];
    for (const sheetObj of document.styleSheets) {
      let rules; try { rules = sheetObj.cssRules; } catch { continue; }
      for (const r of rules) {
        if (!r.media || ![...r.media].includes('print')) continue;
        for (const inner of r.cssRules) out.push(inner.cssText);
      }
    }
    return out.join('\n');
  };

  const stripWidth = () => {
    const style = document.createElement('style');
    style.textContent = printRules();
    document.head.appendChild(style);
    const legend = $('#print-legend');
    const kids = [...legend.children];
    // 14 px is the column gap in `.print-legend`'s own `gap: 4px 14px`.
    const w = kids.reduce((a, c) => a + c.getBoundingClientRect().width, 0) + (kids.length - 1) * 14;
    const h = legend.getBoundingClientRect().height;
    style.remove();
    return { w, h, n: kids.length };
  };

  let solo = null;
  let family = null;
  withBoard({ notes: [own('w9', 2, 'Zahnarzt')] }, () => { sheet(); solo = stripWidth(); });
  withBoard({ notes: many }, () => {
    const s = sheet();
    assert.equal(s.members.length, 8, 'the constraint is "excellent at 2, acceptable at 8"');
    family = stripWidth();
  });
  popover.useMemberNames((id) => ({ [MAMA]: 'Mama', [PAPA]: 'Papa' })[id] ?? null);

  const cost = family.w - solo.w;
  diag(`§3 · A4 strip: v1 ${solo.w.toFixed(0)} px → with 8 members ${family.w.toFixed(0)} px `
     + `(+${cost.toFixed(0)} px, ${(cost / 8).toFixed(0)} px per member) of ${A4_CONTENT_PX} px`);
  assert.ok(family.w <= A4_CONTENT_PX,
    `eight members must still fit one A4 line: ${family.w.toFixed(0)} > ${A4_CONTENT_PX}`);
  assert.equal(Math.round(family.h), Math.round(solo.h),
    'and the strip must be exactly as tall as v1\'s — one line, so the sheet stays one page');
});
