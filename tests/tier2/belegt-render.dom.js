// TIER 2 · LZP-705 + LZP-706 — the badge family and the two-sided Belegt, in WebKit.
//
// Stories in scope: 16.6, 16.7, 17.2, 17.4, 17.5 · 18.1, 18.2 · A4 · deliverables 17 and 19.
// Normative sources: ADR 004 §4.1, §4.2, §4.3, §6, §7.1 · ADR 002 §7.4 (the copy contract).
//
// ─────────────────────────────────────────────────────────────────────────────
// THE METHOD, AND WHY IT IS THE METHOD HERE
//
// Everything below enumerates the INPUT DOMAIN AS DATA before choosing a branch,
// the way `tests/helpers/domains.js`, `crypto-domains.js`, `sync-domains.js` and
// `project-domains.js` do. Five markers compete for one microspace — the
// exposure badge (16.6), the initial chip (17.2), the „neu" dot (17.5), the ↻
// repeat marker (9.2) and the Belegt block (16.7) — and ADR 004 §6 says in so
// many words that they are "a single design problem, not four". A design problem
// is not tested one marker at a time: the domain is the CROSS PRODUCT, and the
// cells that matter are the ones where two markers meet.
//
// The domains live in this file rather than in `tests/helpers/` because every
// one of them is a RENDERING input and nothing outside tier 2 can consume them.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS ASSERTED ON THE DOM AND WHAT IS NOT
//
// ADR 004's invariant is asserted on emitted ops and on sealed bytes, never on
// the rendering, and that division is kept: nothing here claims a leak is
// impossible. §5 asserts the weaker, renderer-shaped claim that is this file's
// to make — GIVEN a hostile entry that already carries content it should not
// have, no pixel and no attribute of the board reproduces it. That is the last
// line of a defence whose first three lines are `project.js`, `envelope.js` and
// `authz.js` stage 3c, and it is the only one that can be checked here.
//
// Plain script, not a module: globals are test, assert, $, $$, waitFor, sleep,
// importApp, diag, skip.
// ─────────────────────────────────────────────────────────────────────────────

const { store } = await importApp('store.js');
const { renderBoard } = await importApp('board.js');
const L = await importApp('layout.js');
const { setLang, getLang } = await importApp('i18n.js');
const { iso, parseISO } = await importApp('dates.js');
const { PALETTE } = await importApp('palette.js');

const boardEl = () => $('#board');

// ── the fixture window ───────────────────────────────────────────────────────
// Every entry is placed in the SECOND visible column, so nothing collides with
// today's row shading and the column exists in both rolling and pinned mode.
const COL = (() => {
  const m = renderBoard(boardEl());
  return m.cols[1];
})();
const D = (day) => iso(COL.y, COL.m, day);

const MEMBERS = {
  mama: { id: 'mem_mama', colorRef: 'magenta', initial: 'M', hex: '#C41A6E' },
  papa: { id: 'mem_papa', colorRef: 'gruen', initial: 'P', hex: '#5D9E33' },
};

/** One of MY entries, in the shape `materialize.js` hands `layout.js`. */
const own = (id, day, text, x = {}) => ({
  id, uuid: id, date: D(day), text, categoryId: store.state.categories[0].id,
  repeatsYearly: false, isForeign: false, ownerId: 'mem_me', level: null,
  redacted: false, memberColorRef: null, initial: null, exposure: null, isNew: false, ...x,
});

/** SOMEONE ELSE'S entry. `id` is the entity key, which is what `materialize.js`
 *  puts there for a foreign entry and what makes it collision-proof. */
const foreign = (id, day, level, x = {}) => {
  const who = x.who || MEMBERS.mama;
  const { who: _w, ...rest } = x;
  return {
    id: `fnote:${who.id}/${id}`, uuid: id, date: D(day), text: null,
    repeatsYearly: false, isForeign: true, ownerId: who.id, level,
    memberColorRef: who.colorRef, initial: who.initial,
    exposure: null, isNew: false, coEdit: false, ...rest,
  };
};

const ownBar = (id, from, to, label, x = {}) => ({
  id, uuid: id, startDate: D(from), endDate: D(to), label,
  categoryId: store.state.categories[0].id, isForeign: false, ownerId: 'mem_me',
  level: null, memberColorRef: null, initial: null, exposure: null, isNew: false, ...x,
});

const foreignBar = (id, from, to, level, x = {}) => {
  const who = x.who || MEMBERS.mama;
  const { who: _w, ...rest } = x;
  return {
    id: `fbar:${who.id}/${id}`, uuid: id, startDate: D(from), endDate: D(to), label: null,
    isForeign: true, ownerId: who.id, level, memberColorRef: who.colorRef,
    initial: who.initial, exposure: null, isNew: false, coEdit: false, ...rest,
  };
};

/**
 * Render a board made of exactly these entries and give the DOM to `fn`.
 *
 * The arrays are assigned rather than minted through `store.mutate`, and that
 * is deliberate: `store._project` still passes `currentMembers: new Set([me])`
 * and `members: new Map()` to `materialize`, so THE STORE CANNOT YET PRODUCE A
 * FOREIGN ENTRY — wiring those two is E6's, and it is reported as a cross-file
 * need. What this file owns is `layout.js` → `board.js`, and its input is the
 * materialized entry. Everything upstream of that seam is asserted in tier 1.
 */
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

const noteAt = (day) => $(`#board .col[data-month="${COL.key}"] .day[data-date="${D(day)}"] .note`);
const notesAt = (day) => $$(`#board .col[data-month="${COL.key}"] .day[data-date="${D(day)}"] .note`);
const barFor = (id) => $(`#board .col[data-month="${COL.key}"] .bar[data-bar-id="${CSS.escape(id)}"]`);
const labelFor = (id) => $(`#board .col[data-month="${COL.key}"] .bar-label[data-bar-id="${CSS.escape(id)}"]`);

/** The prefix a note actually rendered, as a stable list of marker names.
 *  `.redacted-word` is the BODY, not a marker — see `bodyTextOf`. */
const prefixOf = (node) => [...node.children]
  .filter((c) => c.className !== 'redacted-word').map((c) => c.className);
const bodyTextOf = (node) => {
  const word = $('.redacted-word', node);
  if (word) return word.textContent;
  return [...node.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
};

/** The three-bucket reporter the property suites use, so a red cell names itself. */
function verdict(label, rows) {
  const bad = rows.filter((r) => !r.ok);
  diag(`${label}: ${rows.length - bad.length}/${rows.length} cells hold`);
  for (const r of bad) diag(`  ✗ ${r.id} — ${r.why}`);
  assert.equal(bad.length, 0, bad.length ? `${label}: ${bad.map((r) => r.id).join(', ')}` : '');
}

// ═════════════════════════════════════════════════════════════════════════════
// §1 · DOMAIN B1 — one note row, enumerated
//
// The cross product of everything that decides a `.note`'s prefix and body.
// `side` is the axis that makes the microspace fit at all: the exposure badge
// only ever appears on MINE, the chip and the dot only ever on SOMEONE ELSE'S,
// so the five markers are really two disjoint families of at most three.
// ═════════════════════════════════════════════════════════════════════════════

/** [id, entry, { prefix, body, classes }] — the whole expectation, as data. */
const B1 = [
  // ── mine ────────────────────────────────────────────────────────────────────
  ['own/privat', own('b1a', 2, 'Zahnarzt'),
    { prefix: [], body: 'Zahnarzt', classes: [] }],
  ['own/privat+repeat', own('b1b', 3, 'Oma', { repeatsYearly: true }),
    { prefix: ['rep'], body: 'Oma', classes: [] }],
  ['own/belegt', own('b1c', 4, 'Zahnarzt', { exposure: { level: 'belegt', pending: false } }),
    { prefix: ['exp belegt'], body: 'Zahnarzt', classes: [] }],
  ['own/geteilt', own('b1d', 5, 'Zahnarzt', { exposure: { level: 'geteilt', pending: false } }),
    { prefix: ['exp geteilt'], body: 'Zahnarzt', classes: [] }],
  ['own/belegt+pending', own('b1e', 6, 'Zahnarzt', { exposure: { level: 'belegt', pending: true } }),
    { prefix: ['exp belegt pending'], body: 'Zahnarzt', classes: [] }],
  ['own/geteilt+pending', own('b1f', 7, 'Zahnarzt', { exposure: { level: 'geteilt', pending: true } }),
    { prefix: ['exp geteilt pending'], body: 'Zahnarzt', classes: [] }],
  // THE OWN WORST CASE — badge + ↻, and nothing else can join them.
  ['own/geteilt+repeat', own('b1g', 8, 'Oma', { repeatsYearly: true, exposure: { level: 'geteilt', pending: false } }),
    { prefix: ['exp geteilt', 'rep'], body: 'Oma', classes: [] }],
  // 16.6 — Privat gets NO glyph. The absence of a badge is the quiet state.
  ['own/exposure=privat', own('b1h', 9, 'Zahnarzt', { exposure: { level: 'privat', pending: false } }),
    { prefix: [], body: 'Zahnarzt', classes: [] }],
  // A peer's level can never appear on my own entry, whatever a materializer says.
  ['own/exposure=foreign-shaped', own('b1i', 10, 'Zahnarzt', { exposure: { level: 'geteilt' }, isNew: true }),
    { prefix: ['exp geteilt'], body: 'Zahnarzt', classes: [] }],

  // ── someone else's ──────────────────────────────────────────────────────────
  ['foreign/belegt', foreign('b1j', 11, 'belegt'),
    { prefix: ['chip'], body: 'Belegt', classes: ['foreign', 'belegt', 'readonly'] }],
  ['foreign/geteilt', foreign('b1k', 12, 'geteilt', { text: 'Chorprobe' }),
    { prefix: ['chip'], body: 'Chorprobe', classes: ['foreign', 'readonly'] }],
  ['foreign/geteilt+coEdit', foreign('b1l', 13, 'geteilt', { text: 'Urlaub', coEdit: true }),
    { prefix: ['chip'], body: 'Urlaub', classes: ['foreign'] }],
  ['foreign/belegt+new', foreign('b1m', 14, 'belegt', { isNew: true }),
    { prefix: ['neu-dot', 'chip'], body: 'Belegt', classes: ['foreign', 'belegt', 'readonly'] }],
  // THE FOREIGN WORST CASE — dot + chip + ↻ (A4: a shared yearly repeat).
  ['foreign/geteilt+new+repeat', foreign('b1n', 15, 'geteilt', { text: 'Opas Geburtstag', isNew: true, repeatsYearly: true }),
    { prefix: ['neu-dot', 'chip', 'rep'], body: 'Opas Geburtstag', classes: ['foreign', 'readonly'] }],
  // The member record has not arrived. The chip still exists — otherwise a
  // foreign entry would be indistinguishable from one of mine — but it says
  // "somebody", which is all that is known.
  ['foreign/unknown-member', foreign('b1o', 16, 'belegt', { who: { id: 'mem_x', colorRef: null, initial: null } }),
    { prefix: ['chip'], body: 'Belegt', classes: ['foreign', 'belegt', 'readonly'] }],
  // FAIL CLOSED. A level from a future protocol version is not the most
  // permissive one this build knows; it renders as a block. See §4.
  ['foreign/unknown-level', foreign('b1p', 17, 'zwischenstufe', { text: 'geheim' }),
    { prefix: ['chip'], body: 'Belegt', classes: ['foreign', 'belegt', 'readonly'] }],
  // `exposure` is MY disclosure state and means nothing on someone else's
  // entry. `materialize.js` answers `null` there today; this row is what makes
  // that a guarantee of the RENDERER rather than a habit of the materializer,
  // and it is the difference between a peer's level being unreadable and a
  // peer's level being drawn on my board as if it were mine.
  ['foreign/carries-exposure', foreign('b1q', 18, 'geteilt', { text: 'Chor', exposure: { level: 'belegt', pending: false } }),
    { prefix: ['chip'], body: 'Chor', classes: ['foreign', 'readonly'] }],
];

test('§1 · B1 — every note row renders exactly the markers its inputs earn', () => {
  const notes = B1.map(([, e]) => e);
  withBoard({ notes }, () => {
    const rows = B1.map(([id, e, want]) => {
      const day = parseISO(e.date).d;
      const node = noteAt(day);
      if (!node) return { id, ok: false, why: 'no .note rendered at all' };
      const gotPrefix = prefixOf(node);
      const gotBody = bodyTextOf(node);
      const cls = [...node.classList].filter((c) => c !== 'note');
      if (JSON.stringify(gotPrefix) !== JSON.stringify(want.prefix)) {
        return { id, ok: false, why: `prefix ${JSON.stringify(gotPrefix)} !== ${JSON.stringify(want.prefix)}` };
      }
      if (gotBody !== want.body) return { id, ok: false, why: `body ${JSON.stringify(gotBody)} !== ${JSON.stringify(want.body)}` };
      if (JSON.stringify(cls.sort()) !== JSON.stringify([...want.classes].sort())) {
        return { id, ok: false, why: `classes ${JSON.stringify(cls)} !== ${JSON.stringify(want.classes)}` };
      }
      return { id, ok: true };
    });
    verdict('B1 · note rows', rows);
  });
});

test('§1 · B1 — the badge and the chip are two disjoint families, by construction', () => {
  // The whole reason five markers fit in one slot. If a future edit ever puts
  // an exposure badge on a foreign entry or a chip on one of mine, the
  // microspace budget in `PREFIX_COST_PX` stops being true and this row is how
  // that is found out.
  const notes = B1.map(([, e]) => e);
  withBoard({ notes }, () => {
    const rows = $$('#board .note').map((n, i) => {
      const foreignSide = n.classList.contains('foreign');
      const hasExp = !!$('.exp', n);
      const hasWho = !!$('.chip', n) || !!$('.neu-dot', n);
      const ok = foreignSide ? !hasExp : !hasWho;
      return { id: `${i}:${foreignSide ? 'foreign' : 'own'}`, ok,
        why: foreignSide ? 'a foreign note carries an exposure badge' : 'an own note carries a chip or a „neu" dot' };
    });
    verdict('B1 · disjoint families', rows);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §2 · DOMAIN B2 — one bar segment
//
// 16.7 on the bar is where the asymmetry is loudest: the stripe keeps its FULL
// LENGTH and the owner's colour, because duration and owner are the disclosure.
// Only the label is withheld, and only the grips follow the edit right.
// ═════════════════════════════════════════════════════════════════════════════

const B2 = [
  ['bar/own', ownBar('b2a', 2, 5, 'Projekt'),
    { label: 'Projekt', classes: [], handles: 2, chip: false, exp: null }],
  ['bar/own+geteilt', ownBar('b2b', 7, 10, 'Projekt', { exposure: { level: 'geteilt', pending: false } }),
    { label: 'Projekt', classes: [], handles: 2, chip: false, exp: 'exp geteilt' }],
  ['bar/own+belegt+pending', ownBar('b2c', 12, 14, 'Projekt', { exposure: { level: 'belegt', pending: true } }),
    { label: 'Projekt', classes: [], handles: 2, chip: false, exp: 'exp belegt pending' }],
  // v1's own fallback survives, on the non-redacted branch only.
  ['bar/own+no-label', ownBar('b2d', 16, 17, ''),
    { label: null, classes: [], handles: 2, chip: false, exp: null }],
  ['bar/foreign+belegt', foreignBar('b2e', 19, 22, 'belegt'),
    { label: 'Belegt', classes: ['foreign', 'belegt', 'readonly'], handles: 0, chip: true, exp: null }],
  ['bar/foreign+geteilt', foreignBar('b2f', 24, 26, 'geteilt', { label: 'Urlaub', who: MEMBERS.papa }),
    { label: 'Urlaub', classes: ['foreign', 'readonly'], handles: 0, chip: true, exp: null }],
  ['bar/foreign+geteilt+coEdit', foreignBar('b2g', 27, 28, 'geteilt', { label: 'Urlaub', coEdit: true, who: MEMBERS.papa }),
    { label: 'Urlaub', classes: ['foreign'], handles: 2, chip: true, exp: null }],
];

test('§2 · B2 — every bar segment renders its label, its grips and its chip', () => {
  const bars = B2.map(([, b]) => b);
  withBoard({ bars, settings: { layers: { feiertage: false, schulferien: false, otherStates: false, ferienPattern: false } } }, () => {
    const rows = B2.map(([id, b, want]) => {
      const bar = barFor(b.id);
      const lab = labelFor(b.id);
      if (!bar || !lab) return { id, ok: false, why: 'no .bar / .bar-label rendered' };
      const cls = [...bar.classList].filter((c) => c !== 'bar');
      if (JSON.stringify(cls.sort()) !== JSON.stringify([...want.classes].sort())) {
        return { id, ok: false, why: `classes ${JSON.stringify(cls)} !== ${JSON.stringify(want.classes)}` };
      }
      const handles = $$('.bar-handle', bar).length;
      if (handles !== want.handles) return { id, ok: false, why: `${handles} grips, expected ${want.handles}` };
      if (!!$('.chip', lab) !== want.chip) return { id, ok: false, why: `chip ${!$('.chip', lab) ? 'missing' : 'unexpected'}` };
      const exp = $('.exp', lab);
      if ((exp ? exp.className : null) !== want.exp) {
        return { id, ok: false, why: `badge ${exp ? exp.className : 'absent'} !== ${want.exp}` };
      }
      const text = [...lab.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
      if (want.label !== null && text !== want.label) {
        return { id, ok: false, why: `label ${JSON.stringify(text)} !== ${JSON.stringify(want.label)}` };
      }
      return { id, ok: true };
    });
    verdict('B2 · bar segments', rows);
  });
});

test('§2 · 16.7 — a Belegt stripe keeps its full length and the owner\'s colour', () => {
  // The deliberate leak, asserted as a leak: existence, owner and duration are
  // VISIBLE, and a renderer that quietly shortened or greyed the stripe would
  // be telling a comforting lie about a disclosure the user chose.
  const b = foreignBar('b2h', 5, 20, 'belegt');
  withBoard({ bars: [b] }, () => {
    const bar = barFor(b.id);
    assert.ok(bar, 'the Belegt bar is on the board at all');
    assert.equal(bar.style.background, 'rgb(196, 26, 110)', 'the owner\'s member colour, unmodified');
    const rows = Math.round(bar.getBoundingClientRect().height / store.state.settings.rowHeight);
    assert.equal(rows, 16, '5th to 20th inclusive — the whole range, not a token mark');
    const hatch = getComputedStyle(bar, '::before').backgroundImage;
    assert.match(hatch, /repeating-linear-gradient/, 'and it is hatched, so "taken" is not read as "described"');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §3 · DELIVERABLE 19 — the pairing: what I see of mine vs what Mama sees of it
//
// ONE entry, two renderings. This is the deliverable, and it is a single
// assertion pair rather than two unrelated tests, because the whole point is
// that the two disagree in exactly the ways ADR 004 §4.1/§4.2 specify and in no
// other way.
// ═════════════════════════════════════════════════════════════════════════════

test('§3 · deliverable 19 — the owner keeps the text, the viewer gets the block', () => {
  const SECRET = 'Zahnarzt 9:30';
  // The SAME entry, seen from the two sides. The owner's row reads truth
  // registers (INV-R3 — a redaction can never make my own board lie to me); the
  // viewer's reads `pub.*` only, and there is no `pub.text` to read.
  const mine = own('d19a', 4, SECRET, { exposure: { level: 'belegt', pending: false } });
  const theirs = foreign('d19b', 4, 'belegt');

  withBoard({ notes: [mine, theirs] }, () => {
    const [ownNode, viewNode] = notesAt(4);
    assert.ok(ownNode && viewNode, 'both sides render on the same day');

    // ── the owner's side ──────────────────────────────────────────────────
    assert.equal(bodyTextOf(ownNode), SECRET, 'I see my own text, in full');
    assert.equal(ownNode.style.color, 'rgb(42, 124, 192)', 'in MY category colour — my board stays mine (17.2)');
    assert.ok(!ownNode.classList.contains('readonly'), 'and it is mine to edit');
    assert.equal($('.exp', ownNode).className, 'exp belegt', 'plus the exposure badge (16.6)');
    // ADR 002 §7.4's REQUIRED string, verbatim. LZP-1003 audits it as a string.
    assert.includes(ownNode.title, 'Andere sehen: Datum, deinen Namen, deine Farbe — keinen Text.');

    // ── the viewer's side ─────────────────────────────────────────────────
    assert.equal(bodyTextOf(viewNode), 'Belegt', 'Mama sees the word, never the text');
    assert.equal($('.chip', viewNode).textContent, 'M', 'with my initial (17.2)');
    assert.equal($('.chip', viewNode).style.background, 'rgb(196, 26, 110)', 'in my MEMBER colour, never a category colour (A3)');
    assert.ok(viewNode.classList.contains('readonly'), 'and it is not hers to edit (18.1)');
    assert.equal($('.exp', viewNode), null, 'exposure is MY disclosure state, not something she is shown');
    assert.equal(viewNode.title, 'M · Belegt', 'the hover says who and what level — never what');

    // ── and the one thing that must be true of the pair ────────────────────
    assert.ok(!viewNode.outerHTML.includes('Zahnarzt'), 'the viewer-side node reproduces no part of the text');
  });
});

test('§3 · the neutral word is NEUTRAL — it is not set in the owner\'s ink', () => {
  // The word „Belegt" is not content and must not look like content. The note
  // carries the member colour as an inline style, so a bare text node would
  // inherit it and a word nobody wrote would appear in a person's own ink —
  // the one place on this board where "who wrote this" is answered by colour.
  // That is why the word is an ELEMENT with its own colour, and this is the row
  // that fails when a refactor turns it back into a text node.
  const theirs = foreign('d19e', 9, 'belegt');
  withBoard({ notes: [theirs] }, () => {
    const node = noteAt(9);
    const word = $('.redacted-word', node);
    assert.ok(word, 'the neutral word is a tagged element, not a loose text node');
    assert.equal(getComputedStyle(word).color, 'rgb(138, 124, 184)', '--ink-3, the board\'s neutral tone');
    assert.notEqual(getComputedStyle(word).color, getComputedStyle(node).color,
      'and never the member colour the chip beside it is painted in');
    assert.equal(getComputedStyle(word).fontStyle, 'italic', 'and it is set apart from every text on the board');
  });
});

test('§3 · ADR 004 §7.1 — a block downgraded from Geteilt is identical to one always Belegt', () => {
  // No history, no „war geteilt", no strikethrough, no animation. The strongest
  // form of that claim available to a renderer: two entries whose ONLY
  // difference is a leftover `text` from a Geteilt past produce byte-identical
  // markup once the ids are normalised. If a future edit reads `text` on the
  // Belegt path — to dim it, to mark it, to anything — this row dies.
  const wasShared = foreign('d19c', 6, 'belegt', { text: 'Therapie' });
  const alwaysBusy = foreign('d19d', 7, 'belegt');
  withBoard({ notes: [wasShared, alwaysBusy] }, () => {
    const strip = (n) => n.outerHTML
      .replace(/data-note-id="[^"]*"/, 'data-note-id="—"')
      .replace(/data-date="[^"]*"/, 'data-date="—"');
    assert.equal(strip(noteAt(6)), strip(noteAt(7)));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §4 · DOMAIN B3 — the leak surface, adversarially
//
// The claim is renderer-shaped and deliberately weaker than ADR 004's: GIVEN an
// entry that already carries content it should not have — because a peer ran a
// patched build, because a future protocol version added a level between Belegt
// and Geteilt, because a fold ran without `foldAuthorized` — the board
// reproduces none of it. Three upstream barriers make that entry unreachable;
// this is what happens if they ever do not.
// ═════════════════════════════════════════════════════════════════════════════

const SECRETS = ['Onkologie', 'Scheidungsanwalt', 'Bewerbungsgespräch'];

const B3 = [
  ['smuggled-text/belegt', foreign('b3a', 2, 'belegt', { text: SECRETS[0] })],
  ['smuggled-text/unknown-level', foreign('b3b', 3, 'halbgeteilt', { text: SECRETS[1] })],
  ['smuggled-text/level-null', foreign('b3c', 4, 'belegt', { text: SECRETS[2], level: 'belegt' })],
  ['smuggled-category/belegt', foreign('b3d', 5, 'belegt', { categoryId: 'cat-geheim', text: SECRETS[0] })],
];

test('§4 · B3 — no smuggled content reaches a pixel, an attribute or the markup', () => {
  const notes = B3.map(([, e]) => e);
  withBoard({ notes }, () => {
    const html = boardEl().outerHTML;
    const rows = [];
    for (const s of SECRETS) {
      rows.push({ id: `markup/${s}`, ok: !html.includes(s), why: 'the string appears somewhere in the board markup' });
    }
    for (const [id, e] of B3) {
      const node = noteAt(parseISO(e.date).d);
      rows.push({ id: `${id}/body`, ok: !!node && bodyTextOf(node) === 'Belegt', why: 'the body is not the neutral word' });
      rows.push({ id: `${id}/title`, ok: !!node && !SECRETS.some((s) => node.title.includes(s)), why: 'the title carries the text' });
      rows.push({ id: `${id}/redacted`, ok: !!node && node.classList.contains('belegt'), why: 'not marked as a Belegt block' });
    }
    // A3 — `categoryId` has no `pub.` counterpart at any level, so a foreign
    // entry carrying one is already impossible; if one arrives, no colour on
    // the board may be derived from it.
    const catNode = noteAt(5);
    rows.push({ id: 'A3/colour', ok: catNode.style.color === 'rgb(196, 26, 110)',
      why: `a foreign entry took a colour from ${JSON.stringify(catNode.style.color)}, not from its member record` });
    verdict('B3 · leak surface', rows);
  });
});

test('§4 · a foreign entry never falls through to PALETTE[0] (ADR 004 §4.3)', () => {
  // `colorOf(undefined)` and `colorOf('nonsense')` both answer #2A7CC0 — blue,
  // `palette.js:28` — so a foreign entry with a missing OR malformed member
  // colour would render as one of MINE. Both inputs, both surfaces.
  const rows = [];
  const bad = [null, undefined, '', 'blau-ish', 42, {}];
  const notes = bad.map((ref, i) => foreign(`b3e${i}`, 8 + i, 'belegt', { who: { id: `mem_${i}`, colorRef: ref, initial: 'X' } }));
  withBoard({ notes }, () => {
    notes.forEach((e, i) => {
      const node = noteAt(8 + i);
      rows.push({ id: `colorRef=${JSON.stringify(bad[i])}`,
        ok: node.style.color === 'rgb(138, 124, 184)',
        why: `answered ${node.style.color}, and PALETTE[0] is rgb(42, 124, 192)` });
    });
    // and the tone that is used is NOT one of the ten a member can choose, so
    // "I do not know whose this is" stays distinguishable from "this is Papa's".
    const hexes = PALETTE.map((c) => c.hex.toUpperCase());
    rows.push({ id: 'fallback∉PALETTE', ok: !hexes.includes(L.UNKNOWN_MEMBER_COLOR.toUpperCase()),
      why: `${L.UNKNOWN_MEMBER_COLOR} is a palette tone, so an unknown member is indistinguishable from a real one` });
    verdict('B3 · foreign colour fallback', rows);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §5 · DENSITY — what the badge family costs a row
//
// "Every pixel you spend competes with the twelve-months-on-one-screen that is
// the entire point of the product." So it is measured, in the engine, against
// the table `layout.js` publishes — not estimated from the CSS.
// ═════════════════════════════════════════════════════════════════════════════

test('§5 · the family is HORIZONTAL only — no marker changes a row\'s line count', () => {
  // The single most important density claim: `rowCapacity` is a function of row
  // height alone, and a `.note` carrying every marker occupies the same line box
  // as a bare one. A family board therefore hosts exactly as many entries per
  // day as a solo one.
  const plain = own('b5a', 2, 'x');
  const loaded = foreign('b5b', 3, 'geteilt', { text: 'x', isNew: true, repeatsYearly: true });
  const ownLoaded = own('b5c', 4, 'x', { repeatsYearly: true, exposure: { level: 'geteilt', pending: true } });
  withBoard({ notes: [plain, loaded, ownLoaded] }, () => {
    const h = (d) => Math.round(noteAt(d).getBoundingClientRect().height * 10) / 10;
    assert.equal(h(3), h(2), 'a foreign note with dot + chip + ↻ is the same height as a bare one');
    assert.equal(h(4), h(2), 'and so is one of mine with a badge and a ↻');
    // `rowCapacity` takes ONE argument and it is the row height. That is the
    // whole vertical claim: there is no family input it could take.
    assert.equal(L.rowCapacity.length, 1, 'rowCapacity still reads nothing but the row height');
    // The same table `tests/tier1/layout.test.js` pins, including its recorded
    // DISCREPANCY at 32 px — unchanged by this epic, which is the point.
    assert.deepEqual(
      [18, 20, 22, 24, 31, 32, 33].map((r) => L.rowCapacity(r)), [1, 1, 2, 2, 2, 2, 3],
      'v1\'s capacity table, untouched',
    );
  });
});

test('§1 · 16.6 — the four exposure badges are pairwise distinguishable', () => {
  // ADR 004 §6 asks for distinct glyphs per LEVEL **and** for "the same glyph,
  // hollow" when pending. Two requirements, therefore two independent channels:
  // COVERAGE (background-size) says how much is out there, TEXTURE
  // (background-image) says whether it got there. A badge that signalled
  // pending by changing only the fill would collapse a pending Belegt and a
  // pending Geteilt into one mark — which a first draft of this CSS did, and
  // which was found by measuring these four boxes rather than by looking.
  const notes = [
    own('b1r', 2, 'x', { exposure: { level: 'belegt', pending: false } }),
    own('b1s', 3, 'x', { exposure: { level: 'geteilt', pending: false } }),
    own('b1t', 4, 'x', { exposure: { level: 'belegt', pending: true } }),
    own('b1u', 5, 'x', { exposure: { level: 'geteilt', pending: true } }),
  ];
  withBoard({ notes }, () => {
    const sig = (d) => {
      const cs = getComputedStyle($('.exp', noteAt(d)));
      // Plain concatenation, not a template literal: a `${/regex/...}`
      // interpolation in a spliced tier-2 file bails the whole run out in
      // WKWebView's `callAsyncJavaScript`, with no line number. Bisected.
      return cs.backgroundSize + ' | ' + (/repeating/.test(cs.backgroundImage) ? 'hatch' : 'solid');
    };
    const sigs = [2, 3, 4, 5].map(sig);
    diag('exposure badge signatures: ' + JSON.stringify(sigs));
    assert.equal(new Set(sigs).size, 4, 'four inputs, four distinguishable marks: ' + JSON.stringify(sigs));
    // and the two channels are the ones that carry the two meanings
    assert.notEqual(sigs[0].split('|')[0], sigs[1].split('|')[0], 'Belegt and Geteilt differ in COVERAGE');
    assert.notEqual(sigs[0].split('|')[1], sigs[2].split('|')[1], 'acked and pending differ in TEXTURE');
    assert.equal(sigs[0].split('|')[0], sigs[2].split('|')[0], 'and pending does NOT disturb the coverage');
    assert.equal(sigs[1].split('|')[0], sigs[3].split('|')[0]);
  });
});

test('§5 · every marker costs what PREFIX_COST_PX says it costs', () => {
  // The table in `layout.js` is a published measurement. Here it is measured.
  const cases = [
    ['neu', foreign('b5d', 6, 'geteilt', { text: 'x', isNew: true }), '.neu-dot'],
    ['chip', foreign('b5e', 7, 'geteilt', { text: 'x' }), '.chip'],
    ['exposure', own('b5f', 8, 'x', { exposure: { level: 'geteilt', pending: false } }), '.exp'],
    ['rep', own('b5g', 9, 'x', { repeatsYearly: true }), '.rep'],
  ];
  withBoard({ notes: cases.map(([, e]) => e) }, () => {
    const rows = cases.map(([name, e, sel]) => {
      const node = $(sel, noteAt(parseISO(e.date).d));
      const cs = getComputedStyle(node);
      const cost = Math.round(
        node.getBoundingClientRect().width + parseFloat(cs.marginLeft || 0) + parseFloat(cs.marginRight || 0),
      );
      // Within a pixel, not exactly: `rep` is a GLYPH and its advance width
      // depends on whether Ubuntu loaded. Everything else is a fixed box, and a
      // 1 px band still kills any real widening.
      return { id: `${name}=${cost}px`, ok: Math.abs(cost - L.PREFIX_COST_PX[name]) <= 1,
        why: `measured ${cost}px, PREFIX_COST_PX says ${L.PREFIX_COST_PX[name]}px` };
    });
    verdict('B4 · marker costs', rows);
  });
});

test('§5 · the two worst cases, measured, at 22 px and at 18 px', () => {
  // What a crowded family day actually spends. The numbers are reported so a
  // reviewer can price the next marker somebody proposes.
  const ownWorst = own('b5h', 11, 'Elternabend in der Schule', { repeatsYearly: true, exposure: { level: 'geteilt', pending: false } });
  const foreignWorst = foreign('b5i', 12, 'geteilt', { text: 'Opas Geburtstag', isNew: true, repeatsYearly: true });
  for (const rowHeight of [22, 18]) {
    withBoard({ notes: [ownWorst, foreignWorst], settings: { rowHeight } }, () => {
      const spend = (d) => [...noteAt(d).children].reduce((n, c) => {
        const cs = getComputedStyle(c);
        return n + c.getBoundingClientRect().width + parseFloat(cs.marginLeft || 0) + parseFloat(cs.marginRight || 0);
      }, 0);
      // The TEXT budget, not the box: `.d-body` reserves `--gutter` on the right
      // for the bar lanes, and a note may not paint into it.
      const body = $(`#board .col[data-month="${COL.key}"] .day[data-date="${D(11)}"] .d-body`);
      const budget = body.clientWidth - parseFloat(getComputedStyle(body).paddingRight);
      const mine = Math.round(spend(11));
      const theirs = Math.round(spend(12));
      diag(`@${rowHeight}px · text budget ${Math.round(budget)}px · own worst ${mine}px (${Math.round(mine / budget * 100)}%) · foreign worst ${theirs}px (${Math.round(theirs / budget * 100)}%)`);
      assert.ok(Math.abs(mine - L.PREFIX_COST_PX.ownWorst) <= 1,
        `own worst case measured ${mine}px, table says ${L.PREFIX_COST_PX.ownWorst}px`);
      assert.ok(Math.abs(theirs - L.PREFIX_COST_PX.foreignWorst) <= 1,
        `foreign worst case measured ${theirs}px, table says ${L.PREFIX_COST_PX.foreignWorst}px`);
      // AND THE COST DOES NOT MOVE WITH DENSITY. The badges are fixed boxes, so
      // the squeeze is worst at the narrowest column, never at the shortest row.
      assert.ok(Math.abs(mine - 17) <= 1, 'the family costs the same at 18 px as at 22 px');
      assert.ok(theirs < budget / 2, 'and the worst case still leaves the majority of the row to the text');
    });
  }
});

test('§5 · 17.4 — foreign entries obey the capacity slice and the "+n" chip', () => {
  // The mandatory injection point. Foreign notes reach the day through the same
  // occurrence map as mine, so they are sliced and counted identically; there is
  // no second path on which a family entry could bypass the density rules.
  const notes = [
    own('b5j', 14, 'meins 1'), own('b5k', 14, 'meins 2'),
    foreign('b5l', 14, 'belegt'), foreign('b5m', 14, 'geteilt', { text: 'ihres' }),
  ];
  withBoard({ notes, settings: { rowHeight: 22, layers: { feiertage: false, schulferien: false, otherStates: false, ferienPattern: false } } }, () => {
    assert.equal(notesAt(14).length, 2, 'capacity 2 at 22 px, whoever the entries belong to');
    const more = $(`#board .col[data-month="${COL.key}"] .day[data-date="${D(14)}"] .d-more`);
    assert.ok(more, 'the two that did not fit are counted');
    assert.equal(more.textContent, '+2');
  });
  withBoard({ notes, settings: { rowHeight: 18, layers: { feiertage: false, schulferien: false, otherStates: false, ferienPattern: false } } }, () => {
    assert.equal(notesAt(14).length, 1, 'capacity 1 at 18 px');
    assert.equal($(`#board .col[data-month="${COL.key}"] .day[data-date="${D(14)}"] .d-more`).textContent, '+3');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §6 · THE COPY, IN BOTH LANGUAGES, AND WHAT IT MAY NOT SAY
//
// ADR 002 §7.4 is a copy CONTRACT: three required strings and four forbidden
// claims, audited by LZP-1003 as strings. Two of the three live on this board.
// ═════════════════════════════════════════════════════════════════════════════

const REQUIRED = {
  de: {
    belegt: 'Belegt',
    ownerTip: 'Andere sehen: Datum, deinen Namen, deine Farbe — keinen Text.',
  },
  en: {
    belegt: 'Busy',
    ownerTip: 'Others see: the date, your name, your colour — no text.',
  },
};

// ADR 002 §7.4: "Never". The crypto cannot make these true, so no pixel may say
// them. Checked over the whole rendered board, not over a string table, because
// a forbidden claim assembled from two halves is still a forbidden claim.
const FORBIDDEN = ['gelöscht bei allen', 'zurückgezogen', 'niemand kann es mehr sehen', 'live'];

test('§6 · the required strings, both languages, on the board itself', () => {
  const rows = [];
  for (const lang of ['de', 'en']) {
    const mine = own('b6a', 3, 'Zahnarzt', { exposure: { level: 'belegt', pending: false } });
    const theirs = foreign('b6b', 4, 'belegt');
    withBoard({ notes: [mine, theirs], settings: { language: lang } }, () => {
      rows.push({ id: `${lang}/belegt-word`, ok: bodyTextOf(noteAt(4)) === REQUIRED[lang].belegt,
        why: `the block says ${JSON.stringify(bodyTextOf(noteAt(4)))}, not ${JSON.stringify(REQUIRED[lang].belegt)}` });
      rows.push({ id: `${lang}/owner-tip`, ok: noteAt(3).title.includes(REQUIRED[lang].ownerTip),
        why: `ADR 002 §7.4's required Belegt tooltip is missing: ${JSON.stringify(noteAt(3).title)}` });
    });
  }
  verdict('B5 · required copy', rows);
});

test('§6 · the pending badge says "not yet", and never says "live"', () => {
  const mine = own('b6c', 5, 'Zahnarzt', { exposure: { level: 'geteilt', pending: true } });
  const rows = [];
  for (const lang of ['de', 'en']) {
    withBoard({ notes: [mine], settings: { language: lang } }, () => {
      const title = noteAt(5).title;
      rows.push({ id: `${lang}/says-pending`, ok: /noch nicht abgeglichen|not synced yet/.test(title),
        why: `a pending exposure said nothing about being pending: ${JSON.stringify(title)}` });
      const html = boardEl().outerHTML.toLowerCase();
      for (const f of FORBIDDEN) {
        rows.push({ id: `${lang}/forbidden:${f}`, ok: !html.includes(f), why: 'ADR 002 §7.4 forbids this claim' });
      }
    });
  }
  verdict('B5 · forbidden claims', rows);
});

// ═════════════════════════════════════════════════════════════════════════════
// §7 · 17.3 — the per-member toggle, and the prototype chain it must not read
// ═════════════════════════════════════════════════════════════════════════════

test('§7 · hiding a member takes their entries off the board and repacks the lanes', () => {
  const notes = [own('b7a', 3, 'meins'), foreign('b7b', 3, 'geteilt', { text: 'ihres' })];
  const bars = [foreignBar('b7c', 5, 9, 'geteilt', { label: 'Urlaub' }), ownBar('b7d', 5, 9, 'Projekt')];
  withBoard({ notes, bars }, () => {
    assert.equal(notesAt(3).length, 2);
    assert.equal($$(`#board .col[data-month="${COL.key}"] .bar`).length, 2);
  });
  withBoard({ notes, bars, settings: { hiddenMembers: { mem_mama: true } } }, () => {
    assert.equal(notesAt(3).length, 1, 'only mine is left');
    assert.equal(bodyTextOf(notesAt(3)[0]), 'meins');
    assert.equal($$(`#board .col[data-month="${COL.key}"] .bar`).length, 1);
    assert.equal(barFor('b7d').dataset.lane, '0', 'and the surviving bar was pulled into lane 0');
  });
});

test('§7 · `hiddenMembers` is read with Object.hasOwn, not with `in`', () => {
  // `hidden['toString']` is a truthy INHERITED function, and reading the toggle
  // with `in` or a bare index would hide a member on the strength of
  // Object.prototype. It is the same prototype-chain hole WP-10 found in
  // ADR 004 §2.2's own printed barrier, one layer up.
  const vis = L.memberVisibilityOf({ hiddenMembers: {} });
  assert.equal(vis('toString'), true, 'an inherited key is not a hidden member');
  assert.equal(vis('constructor'), true);
  assert.equal(vis('mem_mama'), true);
  assert.equal(L.memberVisibilityOf({ hiddenMembers: { mem_mama: true } })('mem_mama'), false);
  assert.equal(L.memberVisibilityOf({ hiddenMembers: { mem_mama: false } })('mem_mama'), true, 'a cleared toggle is not hidden');
  assert.equal(L.memberVisibilityOf({})('mem_mama'), true, 'no pref at all is everybody visible');
  assert.equal(L.memberVisibilityOf({ hiddenMembers: 'nope' })('mem_mama'), true, 'and a malformed pref hides nobody');
});

// ═════════════════════════════════════════════════════════════════════════════
// §8 · 18.1 / 18.2 — the edit right, and the affordance that must follow it
// ═════════════════════════════════════════════════════════════════════════════

const B6 = [
  ['own', own('b8a', 2, 'x'), true],
  ['foreign/belegt', foreign('b8b', 3, 'belegt'), false],
  ['foreign/belegt+coEdit', foreign('b8c', 4, 'belegt', { coEdit: true }), false],
  ['foreign/geteilt', foreign('b8d', 5, 'geteilt', { text: 'x' }), false],
  ['foreign/geteilt+coEdit', foreign('b8e', 6, 'geteilt', { text: 'x', coEdit: true }), true],
  ['foreign/geteilt+coEdit=truthy', foreign('b8f', 7, 'geteilt', { text: 'x', coEdit: 1 }), false],
  ['foreign/unknown-level+coEdit', foreign('b8g', 8, 'halbgeteilt', { text: 'x', coEdit: true }), false],
];

test('§8 · B6 — `.readonly` follows the edit right exactly, coEdit included', () => {
  // `foreign/belegt+coEdit` is the row that matters and it is not hypothetical:
  // a Geteilt → Belegt downgrade nulls `pub.coEdit`, but `pub.coEdit` is a
  // GOVERNING field and `authz.js` stage 3c never drops governing fields — so
  // between the arrival of the new level and the arrival of the null beside it,
  // a register map legitimately holds `belegt` next to `coEdit: true`. Reading
  // the flag alone would put live grips on someone else's Belegt block for
  // exactly that window.
  withBoard({ notes: B6.map(([, e]) => e) }, () => {
    const rows = B6.map(([id, e, canEdit]) => {
      const node = noteAt(parseISO(e.date).d);
      const ro = node.classList.contains('readonly');
      return { id, ok: ro === !canEdit, why: `readonly=${ro}, expected ${!canEdit}` };
    });
    verdict('B6 · edit right', rows);
  });
});

test('§8 · the same question, asked once — `canEditEntry` is the only source', () => {
  const rows = B6.map(([id, e, canEdit]) => ({
    id, ok: L.canEditEntry(e) === canEdit, why: `canEditEntry answered ${L.canEditEntry(e)}` }));
  verdict('B6 · canEditEntry', rows);
});
