// TIER 2 · LZP-802 + LZP-804 — the legend's two sections, ADR 002 §8.5's device count, and the
// badge family checked ON A CROWDED DAY rather than one marker at a time.
//
// Stories in scope: 17.3, 17.4, 17.5 · 15.4 · 20.5 · amendment A3 · deliverables 16 and 17.
// Normative sources: addendum F17 · ADR 002 §2.3 (revocation), §8.5 (no key transparency) ·
// ADR 004 §4.3 (the render seams), §6 (the badge family), §7.2 (the dot's two suppressions) ·
// v1 design principle 1 („density is the feature… when in doubt, thinner") and challenge 1.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS BESIDE THE TWO THAT ALREADY COVER THESE SURFACES
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   `family-members.dom.js`  the member list, the chips, R14's 186-px measurement, the seam.
//   `belegt-render.dom.js`   the five markers ON ONE NOTE, enumerated as a cross product.
//
// Neither of them ever has the toolbar and the board on screen at the same time under load, and
// that is precisely where E8 lives: v1 promises twelve months on one screen at a 22 px row, v2
// adds a second legend section and up to three markers per entry, and **the two budgets are
// spent in different directions from the same window.** So §1 and §4 below measure the LEGEND
// and the ROW in one rendering, at both ends of the density range, with eight members mounted.
//
// §3 is the one that matters most. ADR 004 §7.2's suppressions are enforced in `materialize.js`
// and tier 1 pins them there — but a rule enforced in a pure function is worth what the RENDERER
// does with it, and „no dot" is not the claim. The claim is **no marker, no gap, no signal**: a
// person who makes an entry less visible must leave no trace anywhere on my screen, including in
// the chrome, including in the space where something used to be. That is asserted here on the
// actual pixels of the actual board, driven from the actual register map through the actual
// `materialize`.
//
// Plain script, not a module: globals are test, assert, $, $$, waitFor, sleep, importApp, diag,
// skip.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const members = await importApp('family/membersui.js');
const legend = await importApp('legend.js');
const { store } = await importApp('store.js');
const { renderBoard } = await importApp('board.js');
const { materialize } = await importApp('core/materialize.js');
const L = await importApp('layout.js');
const i18n = await importApp('i18n.js');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 0 · scaffolding
// ═════════════════════════════════════════════════════════════════════════════════════════════

const B21 = 'ABCDEFGHJKMNPQRSTUVWX';
const memId = (n) => `mem_${B21}${String(n)}`;
const ME = memId(0);
const MAMA = memId(1);
const PAPA = memId(2);
const FSP = 'fsp_0000000000000000000000';

/** A stamp of the right shape. `derivedTimes` compares stamps as strings and never parses one. */
const S = (n) => `${String(1700000000000 + n).padStart(13, '0')}.000001.ABCDEFGHJKMNPQRS`;

/** The eight-member fixture — addendum §9's upper bound, matching `family-members.dom.js`. */
const EIGHT = [
  { id: ME, displayName: 'Manuel', colorRef: 'blau' },
  { id: MAMA, displayName: 'Mama', colorRef: 'magenta' },
  { id: PAPA, displayName: 'Papa', colorRef: 'gruen' },
  { id: memId(3), displayName: 'Oma', colorRef: 'orange' },
  { id: memId(4), displayName: 'Opa', colorRef: 'violett' },
  { id: memId(5), displayName: 'Lena', colorRef: 'tuerkis' },
  { id: memId(6), displayName: 'Jonas', colorRef: 'rot' },
  { id: memId(7), displayName: 'Ümit', colorRef: 'gold' },
];
const TWO = EIGHT.slice(0, 2);

/** `Map<entityKey, Map<field, {value, stamp}>>` — `core/registers.js`'s shape, by hand. */
function memberRegs(rows) {
  const m = new Map();
  for (const r of rows) {
    const cells = new Map();
    if ('displayName' in r) cells.set('displayName', { value: r.displayName, stamp: S(1) });
    if ('colorRef' in r) cells.set('colorRef', { value: r.colorRef, stamp: S(1) });
    if ('alive' in r) cells.set('_alive', { value: r.alive, stamp: S(1) });
    m.set(`member:${r.id}`, cells);
  }
  return m;
}

let mountedRegs = null;
function mount(rows, over = {}) {
  mountedRegs = memberRegs(rows);
  members.initMembersUI({
    port: {
      me: () => ME,
      adminId: () => ME,
      registers: () => mountedRegs,
      keysPending: () => false,
      ...over,
    },
    legendHost: '.legend',
  });
  return mountedRegs;
}
function unmount() {
  members.initMembersUI();
  members.renderFamilyLegend();
  i18n.setLang('de');
  store.setSettings({ hiddenMembers: {} });
  document.querySelectorAll('.scrim').forEach((n) => n.remove());
}

/** Build one settings section into a detached body, with the `{rebuild, close}` it expects. */
function build(fn) {
  const body = document.createElement('div');
  const api = { rebuild: () => { body.textContent = ''; fn(body, api); }, close: () => {} };
  fn(body, api);
  return body;
}

const toolbar = () => $('.toolbar');
const legendHost = () => $('.legend');
const famSection = () => document.getElementById(members.FAMILY_LEGEND_ID);
const boardEl = () => $('#board');
const px = (n) => Math.round(n * 100) / 100;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · A3 — two sections in one 40 px row, and what the second one costs
//
// R14 is answered in `family-members.dom.js` §5 (chips, not names: 186 px vs 380 px). What is
// NOT answered there is the question the brief asks of every addition: what does it cost the
// thing the product exists to do? The toolbar is horizontal budget; the board is vertical
// budget; principle 1 is about the vertical one. This section measures BOTH in one rendering,
// which is the only way to show that spending the first did not touch the second.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('A3 · the family half is drawn INSIDE the category rebuild, last, behind one divider', () => {
  mount(EIGHT);
  members.initFamilyLegend({ host: '.legend' });

  // The two sections, in A3's order, separated by the toolbar's own rule and by nothing else —
  // no second heading, because v1 already ships a CATEGORY called „Familie" and one 40 px row
  // may not carry that word twice meaning two different things.
  const kids = [...legendHost().children];
  assert.equal(kids[kids.length - 1].id, members.FAMILY_LEGEND_ID, 'the family half is not last');
  assert.ok(kids.some((n) => n.className === 'legend-item'), 'the categories are gone');
  assert.ok(kids.some((n) => n.className === 'legend-edit'), '„bearbeiten" is gone');
  assert.equal($$('.legend-fam-rule', famSection()).length, 1, 'one divider, no heading');

  // A3 says the FIRST section is „unchanged". Asserted as: every category still renders its NAME,
  // which is the thing R14's rejected alternatives (swatch-only categories) would have taken.
  const names = $$('.legend-item').map((n) => n.textContent.trim());
  assert.equal(names.length, store.state.categories.length);
  assert.equal(names.every((n) => n.length > 0), true, 'a category lost its name to the family half');

  legend.renderLegend();
  assert.equal($$(`#${members.FAMILY_LEGEND_ID}`).length, 1, 'the rebuild produced two sections');
  unmount();
});

test('deliverable 16 · the second section costs 0 px of the vertical budget, at 2 and at 8', () => {
  const bare = toolbar().getBoundingClientRect().height;
  const boardBare = boardEl().getBoundingClientRect().height;
  assert.equal(bare, 40, `v1's toolbar is not 40 px any more (${bare})`);

  mount(TWO);
  members.initFamilyLegend({ host: '.legend' });
  const at2 = famSection().getBoundingClientRect().width;

  mount(EIGHT);
  members.initFamilyLegend({ host: '.legend' });
  const at8 = famSection().getBoundingClientRect().width;
  const loaded = toolbar().getBoundingClientRect().height;
  const boardLoaded = boardEl().getBoundingClientRect().height;

  diag(`legend · family section: ${px(at2)} px at 2 members · ${px(at8)} px at 8`);
  diag(`legend · toolbar height: ${px(bare)} px bare → ${px(loaded)} px with 8 members`);
  diag(`legend · board height:   ${px(boardBare)} px bare → ${px(boardLoaded)} px with 8 members`);

  // THE HEADLINE, and the one principle-1 claim this ticket is allowed to make: the family half
  // is bought entirely out of horizontal space. Not „it fits" — the same two numbers.
  assert.equal(loaded, bare, `the toolbar grew from ${bare} to ${loaded} px`);
  assert.equal(boardLoaded, boardBare, `the board lost ${px(boardBare - boardLoaded)} px`);
  assert.ok(at8 > at2, 'eight members must cost more room than two');
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · ADR 002 §8.5 — the per-member device count
//
// „The member list shows per-member device counts, so an extra device is visible to a curious
// member." It is the ONE mitigation the ADR names against a fabricated member device, and until
// this ticket it reached no screen: the relay publishes `devices` in `MEMBER_PROJECTION`, and
// `MemberRow` had nowhere to put it.
//
// The domain is enumerated as data because the interesting rows are the ones a naive `!== 1`
// would get wrong: `null` (nobody has told me) must not render as `0` (the relay says nobody).
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** [id, the roster's `devices` field, expected count, expected tag text or null] */
const DEV_DOMAIN = [
  ['absent', undefined, null, null],
  ['null', null, null, null],
  ['one', [{ deviceId: 'a' }], 1, null],
  ['two', [{ deviceId: 'a' }, { deviceId: 'b' }], 2, '2 Geräte'],
  ['three', [{ deviceId: 'a' }, { deviceId: 'b' }, { deviceId: 'c' }], 3, '3 Geräte'],
  ['empty', [], 0, '0 Geräte'],
  ['one live, one revoked', [{ deviceId: 'a' }, { deviceId: 'b', revokedAt: '2026-01-01' }], 1, null],
  ['two live, one revoked',
    [{ deviceId: 'a' }, { deviceId: 'b' }, { deviceId: 'c', revokedAt: '2026-01-01' }], 2, '2 Geräte'],
  // Hostile shapes. `devices` arrives from the network; a relay that answers a number, a
  // string-with-a-length or an object-with-a-length must produce „unknown", never a scare.
  ['a number', 9999, null, null],
  ['a fake array', { length: 9999 }, null, null],
  ['a string', 'aaa', null, null],
  ['junk rows', [null, 'x', 7], 0, '0 Geräte'],
];

test('§8.5 · the count is read from the relay roster, revoked rows excluded, junk refused', () => {
  const rows = [];
  for (const [id, devices, expect] of DEV_DOMAIN) {
    const got = members.readMembers(memberRegs(TWO), {
      me: ME,
      roster: [{ memberId: MAMA, colorRef: 'magenta', removedAt: null, devices }],
    }).find((r) => r.memberId === MAMA).deviceCount;
    rows.push({ id, ok: got === expect, why: `deviceCount ${JSON.stringify(got)}, expected ${JSON.stringify(expect)}` });
  }
  const bad = rows.filter((r) => !r.ok);
  diag(`§8.5 · device counts: ${rows.length - bad.length}/${rows.length} cells hold`);
  for (const r of bad) diag(`  ✗ ${r.id} — ${r.why}`);
  assert.equal(bad.length, 0, bad.map((r) => r.id).join(', '));

  // A member the roster does not describe at all keeps `null`, even while a sibling row has a
  // count — the field is per member and is not filled in from the neighbours.
  const mixed = members.readMembers(memberRegs(TWO), {
    me: ME, roster: [{ memberId: MAMA, devices: [{ deviceId: 'a' }, { deviceId: 'b' }] }],
  });
  assert.equal(mixed.find((r) => r.memberId === MAMA).deviceCount, 2);
  assert.equal(mixed.find((r) => r.memberId === ME).deviceCount, null);
});

test('§8.5 · `1` is silent, everything else speaks — and the number never appears alone', () => {
  const sheetFor = (devices) => {
    mount(TWO, { roster: () => [{ memberId: MAMA, colorRef: 'magenta', removedAt: null, devices }] });
    return build(members.buildMembersSection);
  };

  // The quiet state. One device per person is the normal case and a badge on every row of a
  // healthy circle is a statistic, not a control — the exposure badge's argument verbatim
  // (ADR 004 §6: „a glyph for the quiet state would put ink on every row").
  let body = sheetFor([{ deviceId: 'a' }]);
  assert.equal($$('.member-tag-dev', body).length, 0, '1 device drew a tag');
  assert.equal(body.textContent.includes('Geräte'), false, 'the sentence appeared with no number');

  // Unknown is silent too, and for a different reason: the roster fetch failing is not eight
  // rows' worth of news (19.3 — „an unreachable relay is not a sentence").
  body = sheetFor(undefined);
  assert.equal($$('.member-tag-dev', body).length, 0, 'an unfetched roster drew a tag');

  // The fact worth seeing.
  body = sheetFor([{ deviceId: 'a' }, { deviceId: 'b' }]);
  const tags = $$('.member-tag-dev', body);
  assert.equal(tags.length, 1, 'exactly the member with two devices is tagged');
  assert.equal(tags[0].textContent, '2 Geräte');
  assert.equal(tags[0].dataset.devices, '2');
  assert.equal(tags[0].closest('.member-row').dataset.memberId, MAMA);
  // It explains itself where it stands: the tag is two characters wide.
  assert.includes(tags[0].title, 'Mama');
  assert.includes(tags[0].title, '2 Geräte');

  // AND THE SENTENCE. A number with no explanation is trivia; this is what makes it a control.
  // Both halves are required — what is normal, and what to do about a number that is not.
  const prose = $$('.hint.member-prose', body).map((n) => n.textContent).join(' ');
  assert.includes(prose, 'Ein Mac pro Person ist der Normalfall');
  assert.includes(prose, 'frag nach');
  // …and it is not there when there is nothing to explain: the explanation follows the number
  // out of the panel, so a healthy circle carries no paragraph about a threat it is not showing.
  assert.equal(sheetFor([{ deviceId: 'a' }]).textContent.includes('Normalfall'), false,
    'the sentence outlived the number it explains');
  unmount();
});

test('§8.5 · the tag is not an alarm, is not a control, and does not move', () => {
  mount(TWO, {
    roster: () => [{ memberId: MAMA, devices: [{ deviceId: 'a' }, { deviceId: 'b' }] }],
  });
  const body = build(members.buildMembersSection);
  document.body.appendChild(body);
  try {
    const tag = $('.member-tag-dev', body);
    const you = $$('.member-tag', body).find((n) => n.textContent === 'du');
    const cs = getComputedStyle(tag);

    // THE FIRST COUNT ANYBODY EVER SEES IS THEIR OWN 2, after pairing a laptop (19.4) — the
    // intended state. Painting it as a warning would teach „this number means trouble" on the one
    // instance where it means nothing at all, so it is styled EXACTLY as „du" and „Verwaltung".
    assert.equal(cs.color, getComputedStyle(you).color, 'the device tag is in a different ink');
    assert.equal(cs.backgroundColor, getComputedStyle(you).backgroundColor);
    assert.equal(cs.fontSize, getComputedStyle(you).fontSize);
    assert.equal(cs.fontVariantNumeric, 'tabular-nums', 'a column of counts will shimmer');

    // Not a button, not a link, nothing to press: it reports, it does not act. Removal lives in
    // the admin panel (20.1) and this row may not grow a second door to it.
    assert.equal(tag.tagName, 'SPAN');
    assert.equal($$('button', tag).length, 0);

    // Nothing here animates. A count that pulsed on arrival would turn a quiet fact about
    // another member's Mac into an event (Principle 10, 19.3).
    assert.equal(cs.animationName, 'none');
    assert.equal(cs.transitionDuration, '0s');
  } finally { body.remove(); unmount(); }
});

test('§8.5 · both languages, and the count is not in the legend', () => {
  const roster = () => [{ memberId: MAMA, devices: [{ deviceId: 'a' }, { deviceId: 'b' }] }];
  i18n.setLang('en');
  mount(TWO, { roster });
  let body = build(members.buildMembersSection);
  assert.equal($('.member-tag-dev', body).textContent, '2 devices');
  assert.includes(body.textContent, 'One Mac per person is the normal case');
  assert.equal(body.textContent.includes('Geräte'), false, 'German leaked into the English panel');

  i18n.setLang('de');
  mount(TWO, { roster });
  body = build(members.buildMembersSection);
  assert.equal($('.member-tag-dev', body).textContent, '2 Geräte');

  // THE LEGEND DOES NOT CARRY IT, and that is deliberate: the toolbar is R14's contested 40 px
  // row, and „how many Macs has Mama got" is a question you ask of a list, not one you answer at
  // a glance while planning. It belongs where 15.4 already put the member list.
  members.initFamilyLegend({ host: '.legend' });
  assert.ok(famSection(), 'the legend did not draw');
  assert.equal($$('.member-tag-dev', famSection()).length, 0);
  assert.equal(famSection().textContent.includes('Geräte'), false);
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · 17.5 / ADR 004 §7.2 — the „neu" dot, and the one way this ticket could violate the ethics
//
//   > „A „neu" dot on a downgrade is the surveillance mechanic Principle 9 forbids."
//
// The rule lives in `materialize.js:isNewOf` and tier 1 pins it there. What is asserted HERE is
// the claim a pure function cannot make: that the RENDERED BOARD and the RENDERED CHROME are
// indistinguishable — not merely dot-free — between a member who downgraded an entry and a
// member who never had it any higher. Driven through the real `materialize` from a real register
// map, so the two layers are shown to be connected and not merely each correct alone.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** One `fnote:<owner>/<uuid>` register row. */
function fnote(owner, uuid, fields, stamp = S(1)) {
  const cells = new Map();
  for (const [k, v] of Object.entries(fields)) cells.set(k, { value: v, stamp, author: owner });
  return [`fnote:${owner}/${uuid}`, cells];
}

/** The `MaterializeCtx` the app builds, plus whatever hooks a row wants to inject. */
const mctx = (over = {}) => ({
  me: ME,
  familySpaceId: FSP,
  members: new Map(EIGHT.slice(1).map((r) => [
    r.id, { displayName: r.displayName, colorRef: r.colorRef, initial: r.displayName[0] },
  ])),
  currentMembers: new Set(EIGHT.map((r) => r.id)),
  defaultSettings: structuredClone(store.state.settings),
  ...over,
});

/** A column and a day with no holiday and no Ferien, found rather than guessed. */
const CLEAN = (() => {
  const model = renderBoard(boardEl());
  const col = model.cols[1];
  const day = col.days.find((d) => !d.empty && !d.holiday && !d.ferien);
  return { col, day, date: day.date };
})();

/** Render exactly these notes/bars, hand the DOM to `fn`, then put the board back. */
function withBoard({ notes = [], bars = [], settings = {} }, fn) {
  const before = {
    notes: store.state.notes, bars: store.state.bars,
    settings: structuredClone(store.state.settings),
  };
  try {
    Object.assign(store.state.settings, settings);
    store.state.notes = notes;
    store.state.bars = bars;
    renderBoard(boardEl());
    return fn();
  } finally {
    store.state.notes = before.notes;
    store.state.bars = before.bars;
    store.state.settings = before.settings;
    renderBoard(boardEl());
  }
}

const dayNode = (date = CLEAN.date) => $(`#board .col[data-month="${CLEAN.col.key}"] .day[data-date="${date}"]`);

test('17.5 · the dot fires for added ink, so the silence below is a result and not a broken test', () => {
  // THE CONTROL. Without it every assertion in the next test passes on a renderer that has
  // simply forgotten how to draw a dot, which is the failure mode a silence test invites.
  const regs = new Map([fnote(MAMA, 'add', {
    _born: S(0), 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': CLEAN.date, 'pub.text': 'Zahnarzt',
  })]);
  const notes = materialize(regs, mctx({ seqOf: () => '412', lastSeenSeq: { [FSP]: '400' } })).notes;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].isNew, true, 'materialize did not consider added ink new');
  withBoard({ notes }, () => {
    assert.equal($$('.neu-dot', dayNode()).length, 1, 'an added entry drew no dot');
  });
});

test('17.5 · Principle 9 — a DOWNGRADE leaves no marker, no gap and no signal, anywhere', () => {
  // Mama's entry, and the loudest possible seq evidence that it changed: seq 9999 against a
  // last-seen of 1. The only thing standing between that and a dot is §7.2's suppression, which
  // is exactly the point — this is the hostile case, not a quiet one.
  const loud = { seqOf: () => '9999', lastSeenSeq: { [FSP]: '1' } };
  const regs = new Map([fnote(MAMA, 'down', {
    _born: S(0), 'pub.level': 'belegt', 'pub.alive': true, 'pub.date': CLEAN.date,
  })]);

  // Two histories, one present state: she downgraded Geteilt → Belegt just now, or it has been
  // Belegt since the day she made it and nothing has happened at all.
  const downgraded = materialize(regs, mctx({ ...loud, levelDecreased: () => true })).notes;
  const untouched = materialize(regs, mctx()).notes;
  assert.equal(downgraded.length, 1);
  assert.equal(downgraded[0].isNew, false, 'a downgrade was reported as new');

  const shot = (notes) => withBoard({ notes }, () => ({
    day: dayNode().innerHTML,
    dayBox: px(dayNode().getBoundingClientRect().height),
    noteBox: px($('.note', dayNode()).getBoundingClientRect().width),
    dots: $$('.neu-dot', dayNode()).length,
    toolbar: legendHost().innerHTML,
    title: $('.note', dayNode()).title,
    aria: $('.note', dayNode()).outerHTML.match(/aria-[a-z]+="[^"]*"/g) || [],
  }));

  mount(EIGHT);
  members.initFamilyLegend({ host: '.legend' });
  const after = shot(downgraded);
  const never = shot(untouched);

  // NO DOT — the assertion everybody writes.
  assert.equal(after.dots, 0, 'a downgrade drew a „neu" dot');

  // NO GAP. A suppressed marker that still reserved its 5 px would be a downgrade detector made
  // of whitespace: the entry would sit one dot-width to the right of an untouched one, on every
  // board in the circle, for ever. Measured, because `PREFIX_COST_PX.neu` is 5 px and a 5 px
  // shift is perfectly legible when the same day carries a second, untouched entry beside it.
  assert.equal(after.noteBox, never.noteBox, 'the suppressed dot left its space behind');
  assert.equal(after.dayBox, never.dayBox);

  // NO SIGNAL. Not „no dot" — no difference of any kind that a client could read back out: the
  // markup, the hover text, and every ARIA attribute on the entry.
  assert.equal(after.day, never.day, 'the downgraded day renders differently from the untouched one');
  assert.equal(after.title, never.title, 'the hover text betrays the downgrade');
  assert.deepEqual(after.aria, never.aria);

  // AND NOT IN THE CHROME EITHER. This is the assertion that belongs to THIS file: the legend is
  // the one surface that survives every scroll position, and an aggregate „Mama has been active"
  // there is a presence indicator — the first thing on Principle 9's forbidden list.
  assert.equal(after.toolbar, never.toolbar, 'the toolbar changed when a member downgraded');
  assert.equal($$('.legend .neu-dot').length, 0);
  unmount();
});

test('17.5 · a DELETION leaves no marker either — there is nothing left to dot', () => {
  const loud = { seqOf: () => '9999', lastSeenSeq: { [FSP]: '1' } };
  const regs = new Map([fnote(MAMA, 'gone', {
    _born: S(0), 'pub.level': 'geteilt', 'pub.alive': false, 'pub.date': CLEAN.date, 'pub.text': 'Zahnarzt',
  })]);
  const notes = materialize(regs, mctx(loud)).notes;
  assert.deepEqual(notes, [], 'a deleted entry still materialized');
  withBoard({ notes }, () => {
    assert.equal($$('.neu-dot', dayNode()).length, 0);
    assert.equal($$('.note', dayNode()).length, 0);
  });
});

test('17.5 · the two suppressions can never be wired apart — the tripwire', async () => {
  // ⚠ `isNewOf` FAILS OPEN, and this is the guard against the day that matters.
  //
  //     if (ctx.levelDecreased && ctx.levelDecreased(fkey)) return false;
  //     if (ctx.seqOf) { …compare against lastSeenSeq… }
  //
  // Both hooks are OPTIONAL and INDEPENDENT. A caller that supplies `seqOf` and forgets
  // `levelDecreased` gets a dot on every downgrade — the exact mechanic Principle 9 forbids —
  // with no error, no warning and nothing on screen that looks wrong. Today `store.js:_project`
  // supplies NEITHER, so 17.5 renders nothing at all in the shipped app; the day somebody
  // finishes the wiring is the day this can go wrong, and it will be one line in a file this
  // test's author does not own.
  //
  // Asserted over the SOURCE because there is no other way to observe it: a ctx builder that
  // omits a hook looks exactly like one that does not need it.
  const src = await fetch(new URL('./src/js/store.js', location.href)).then((r) => r.text());
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const wiresSeq = /(^|[^\w.])(seqOf|lastSeenSeq)\s*:/m.test(code);
  const wiresSuppression = /(^|[^\w.])levelDecreased\s*:/m.test(code);
  assert.equal(wiresSeq, wiresSuppression,
    wiresSeq
      ? 'store.js feeds materialize a seq source WITHOUT `levelDecreased` — every downgrade will '
        + 'now draw a „neu" dot (ADR 004 §7.2, Principle 9). Wire both or neither.'
      : 'store.js grew `levelDecreased` with no seq source; harmless, but say why.');

  // And the rule itself, at the seam, so this file fails if the suppression is ever removed from
  // `materialize.js` rather than merely bypassed by a caller.
  const regs = new Map([fnote(PAPA, 'x', {
    _born: S(0), 'pub.level': 'belegt', 'pub.alive': true, 'pub.date': CLEAN.date,
  })]);
  const loud = { seqOf: () => '9999', lastSeenSeq: { [FSP]: '1' } };
  assert.equal(materialize(regs, mctx(loud)).notes[0].isNew, true, 'the control lost its meaning');
  assert.equal(materialize(regs, mctx({ ...loud, levelDecreased: () => true })).notes[0].isNew, false);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · deliverable 17 — the whole badge family on ONE CROWDED DAY, with the legend mounted
//
// „The „neu" dot competes with the repeat marker ↻ and visibility badges for microspace — design
// the full badge system as one family." `belegt-render.dom.js` prices the markers on a note in
// isolation and measures the two worst cases. What is checked here is the case a real family
// board actually produces: a day at capacity, with the overflow chip, three bar lanes and the
// lane overflow, mixed own and foreign, WHILE the toolbar is carrying eight members — at 22 px,
// which is the default, and at 18 px, which is the floor.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const CAT = () => store.state.categories[0].id;
const own = (id, text, x = {}) => ({
  id, uuid: id, date: CLEAN.date, text, categoryId: CAT(), repeatsYearly: false,
  isForeign: false, ownerId: ME, level: null, redacted: false, memberColorRef: null,
  initial: null, exposure: null, isNew: false, ...x,
});
const theirs = (id, who, x = {}) => ({
  id: `fnote:${who.id}/${id}`, uuid: id, date: CLEAN.date, text: null, repeatsYearly: false,
  isForeign: true, ownerId: who.id, level: 'geteilt', memberColorRef: who.colorRef,
  initial: who.displayName[0], exposure: null, isNew: false, coEdit: false, ...x,
});
const theirBar = (id, who, from, to, x = {}) => ({
  id: `fbar:${who.id}/${id}`, uuid: id,
  startDate: CLEAN.col.days[from - 1].date, endDate: CLEAN.col.days[to - 1].date,
  label: null, isForeign: true, ownerId: who.id, level: 'geteilt',
  memberColorRef: who.colorRef, initial: who.displayName[0], exposure: null,
  isNew: false, coEdit: false, ...x,
});

/**
 * The crowded day: every marker in the family present at once, from four different people.
 *
 * THE FOREIGN WORST CASE HAS TO BE ON THE ROW, and arranging that is what makes the 18 px run
 * worth running. `rowCapacity(18)` is 1, so the floor shows exactly ONE note — and if that one were
 * mine, the density floor would be tested against the two markers that were already in v1. The
 * heaviest prefix the family layer can produce (dot + chip + ↻ = 23 px of a ~60 px text budget) is
 * the one that has to survive there.
 *
 * ═══ HOW IT IS ARRANGED CHANGED WITH `orderForCapacity` (17.2) ══════════════════════════════════
 * It used to be arranged by ARRAY ORDER — the foreign worst case was simply the first note, and
 * the capacity slice took whatever came first. `layout.js:orderForCapacity` now runs mine, then
 * the family's changes, then the family, ahead of v1's array order, because store order was
 * costing the owner up to 93.5 % of their own notes depending on nothing but creation order
 * (`e8-density-crowding.dom.js` §B2b). An index in this array no longer decides anything.
 *
 * So the scene takes a parameter instead. `CROWD()` is the mixed day — one note of mine, which
 * takes slot 1 and carries the OWN worst case, and the peer change behind it, which carries the
 * FOREIGN worst case; that is the only shape in which both halves of the badge family are on
 * screen at once, and at 22 px they are. `CROWD({ mine: false })` is the day I have not written
 * on, which is the only shape in which a peer can hold a capacity-1 row — so the 18 px floor is
 * still asked of the heaviest family prefix, and asked of it at BOTH densities.
 *
 * The cost of the rule is asserted rather than avoided: on the mixed day at 18 px the one line is
 * mine, and the family reaches the note line as a digit. See `17.2/the-floor-line-is-mine`.
 */
const CROWD = ({ mine = true } = {}) => ({
  notes: [
    // theirs: the foreign worst case — „neu" dot + initial chip + ↻ (23 px).
    // A CHANGE, so 17.5's tier puts it ahead of the peers that did not change.
    theirs('c2', EIGHT[1], { text: 'Zahnarzt', isNew: true, repeatsYearly: true }),
    // mine: the own worst case — exposure badge + ↻ (17 px of the ~60 px text budget)
    ...(mine ? [own('c1', 'Omas Geburtstag', { repeatsYearly: true, exposure: { level: 'geteilt', pending: false } })] : []),
    // theirs, Belegt: the block, which costs no extra width because it is a fill
    theirs('c3', EIGHT[2], { level: 'belegt', redacted: true, isNew: true }),
    // and two more, so the capacity slice and the „+n" chip are both exercised
    theirs('c4', EIGHT[3], { text: 'Chor' }),
    theirs('c5', EIGHT[4], { text: 'Einkaufen' }),
  ],
  bars: [
    theirBar('c6', EIGHT[1], 1, 20, { isNew: true }),
    theirBar('c7', EIGHT[2], 2, 21, { level: 'belegt', redacted: true }),
    theirBar('c8', EIGHT[3], 3, 22),
    theirBar('c9', EIGHT[4], 4, 23),        // the fourth lane — 3.8's cap plus the rescue
  ],
});

for (const rowH of [22, 18]) {
  test(`deliverable 17 · a crowded day at ${rowH} px carries the whole badge family, horizontally`, () => {
    mount(EIGHT);
    members.initFamilyLegend({ host: '.legend' });
    const { notes, bars } = CROWD();

    withBoard({ notes, bars, settings: { rowHeight: rowH } }, () => {
      const d = dayNode();
      const shown = $$('.note', d);
      const cap = L.rowCapacity(rowH);
      assert.equal(shown.length, cap, `the row shows ${shown.length} notes at capacity ${cap}`);

      // 17.4 — THE DENSITY RULES ARE NOT NEGOTIABLE FOR FAMILY ENTRIES. Five notes, `cap` of them
      // drawn, the rest counted into the one overflow chip v1 already had; four bars, three lanes.
      const more = $('.n-more', d) || $('.more', d) || $('[class*="more"]', d);
      assert.ok(more, 'five notes at capacity 1–2 produced no „+n" chip');
      assert.match(more.textContent, /\d/, `the overflow chip says "${more.textContent}"`);

      // THE ROW IS EXACTLY AS TALL AS IT WOULD BE ON A SOLO BOARD. This is principle 1's whole
      // claim and the reason the badge family is horizontal: not one marker changes a line box.
      const h = px(d.getBoundingClientRect().height);
      assert.equal(h, rowH, `the crowded day is ${h} px at rowHeight ${rowH}`);

      // …and neither does the chrome, with eight members in it.
      assert.equal(toolbar().getBoundingClientRect().height, 40);
      assert.ok(famSection(), 'the family legend went missing under load');

      // The markers really are all there — a height assertion over an empty row proves nothing,
      // and „it fits" is only a claim about the row that was actually drawn.
      const seen = new Set(shown.flatMap((n) => [...n.children].map((c) => c.className.split(' ')[0])));
      const widest = px(Math.max(...shown.map((n) => {
        const kids = [...n.children].filter((c) => c.className !== 'redacted-word');
        return kids.reduce((w, c) => w + c.getBoundingClientRect().width, 0);
      })));
      diag(`crowd@${rowH}px · row ${h} px · ${shown.length}/${notes.length} notes · `
        + `markers ${[...seen].sort().join(',')} · widest prefix ${widest} px · `
        + `overflow "${more.textContent}"`);
      // 17.2 — MY OWN INK TAKES THE ROW. `orderForCapacity` runs mine first, so on this mixed
      // day the line at the 18 px floor is mine and at 22 px mine leads. That is the rule's
      // price and it is asserted, not implied: at capacity 1 the family reaches the note line
      // only as a digit in the „+n" (the lanes still carry it — §17.2 in family-render.dom.js).
      assert.equal(shown[0].dataset.foreign === '1', false,
        `17.2/the-floor-line-is-mine — the first line at ${rowH} px went to a peer`);
      // …and the own worst case's own markers are whole wherever it stands.
      assert.equal(seen.has('exp'), true, `the exposure badge went missing at ${rowH} px`);
      assert.equal(seen.has('rep'), true, `the ↻ went missing at ${rowH} px`);
      // At 22 px the peer CHANGE takes slot 2, which is the only row where the two disjoint
      // halves of the badge family are on screen at the same time (17.5 orders it there).
      assert.equal(seen.has('chip'), cap >= 2, `the initial chip at ${rowH} px with ${cap} slots`);
      assert.equal(seen.has('neu-dot'), cap >= 2, `the „neu" dot at ${rowH} px with ${cap} slots`);
      assert.ok(widest <= L.PREFIX_COST_PX.foreignWorst + 1,
        `the prefix costs ${widest} px, over PREFIX_COST_PX.foreignWorst (${L.PREFIX_COST_PX.foreignWorst})`);

      // Every marker is inside ITS OWN note's box: the family is horizontal, so nothing may
      // stick out above or below the line it was drawn on. Compared per note, not against the
      // first one — two notes on a 22 px row are two different lines, and a check against the
      // wrong line reports the second row's markers as escaping when they are exactly where they
      // belong. (Which it did, on the first run of this file.)
      for (const n of shown) {
        const line = n.getBoundingClientRect();
        for (const c of n.children) {
          const b = c.getBoundingClientRect();
          if (b.width === 0 && b.height === 0) continue;
          assert.ok(b.top >= line.top - 1 && b.bottom <= line.bottom + 1,
            `${c.className} escapes its line box at ${rowH} px `
            + `(marker ${px(b.top)}–${px(b.bottom)}, line ${px(line.top)}–${px(line.bottom)})`);
        }
      }
    });

    // ── THE SAME DENSITY, ON THE DAY I HAVE NOT WRITTEN ON ────────────────────
    // This is what the file used to get from putting the foreign worst case at
    // array index 0, and it is the half `orderForCapacity` moved rather than
    // removed: at BOTH densities, the heaviest prefix the family layer can
    // produce — dot + chip + ↻, 23 px of a ~60 px budget — has to survive on a
    // row it actually holds. At 18 px this is the ONLY shape in which it can.
    const peersOnly = CROWD({ mine: false });
    withBoard({ ...peersOnly, settings: { rowHeight: rowH } }, () => {
      const d = dayNode();
      const shown = $$('.note', d);
      assert.equal(shown.length, L.rowCapacity(rowH), `peers-only: ${shown.length} notes at capacity ${L.rowCapacity(rowH)}`);
      assert.equal(shown[0].dataset.foreign === '1', true,
        `17.1 — with no ink of mine, a peer must hold the line at ${rowH} px`);
      const seen = new Set(shown.flatMap((n) => [...n.children].map((c) => c.className.split(' ')[0])));
      for (const cls of ['neu-dot', 'chip', 'rep']) {
        assert.equal(seen.has(cls), true, `the foreign worst case lost its .${cls} at ${rowH} px`);
      }
      // 17.5 — and the entry that leads is the one that CHANGED, not an index.
      assert.equal(!!$('.neu-dot', shown[0]), true,
        `17.5 — the peer change did not take the first line at ${rowH} px`);
      const widest = px(Math.max(...shown.map((n) => {
        const kids = [...n.children].filter((c) => c.className !== 'redacted-word');
        return kids.reduce((w, c) => w + c.getBoundingClientRect().width, 0);
      })));
      assert.ok(widest <= L.PREFIX_COST_PX.foreignWorst + 1,
        `peers-only: the prefix costs ${widest} px, over PREFIX_COST_PX.foreignWorst (${L.PREFIX_COST_PX.foreignWorst})`);
      assert.equal(px(d.getBoundingClientRect().height), rowH,
        `peers-only: the crowded day grew at rowHeight ${rowH}`);
      diag(`crowd@${rowH}px · peers only · ${shown.length}/${peersOnly.notes.length} notes · `
        + `markers ${[...seen].sort().join(',')} · widest prefix ${widest} px`);
    });
    unmount();
  });
}

test('deliverable 17 · twelve months still fit: the family layer costs the board no height', () => {
  const { notes, bars } = CROWD();
  const bare = withBoard({}, () => px(boardEl().scrollHeight));
  mount(EIGHT);
  members.initFamilyLegend({ host: '.legend' });
  const loaded = withBoard({ notes, bars }, () => px(boardEl().scrollHeight));
  diag(`board scrollHeight: ${bare} px empty → ${loaded} px with the crowd and 8 members`);
  assert.equal(loaded, bare, `the family layer cost the board ${px(loaded - bare)} px`);
  assert.equal($$('#board .col').length, 12, 'twelve months on one screen is the entire point');
  unmount();
});
