// TIER 2 · the member list, my own name and colour, and the legend's „Familie" half.
// LZP-603 + the legend half of A3/17.3. Stories 15.4, 15.6, 17.3, 20.5. PO decision D9.
//
// LZP-604 (invite management) is NOT here. It landed in `family/adminpanel.js` in the same round
// — that file's own header draws the seam („this file owns 20.1's four verbs (invite, revoke,
// rename, transfer)"), and `createjoin.js` owns the ONE definition of an invite code. A second
// panel and a second HKDF spelling were withdrawn rather than shipped; see this package's report.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE IS FOR, AND WHY IT HAS TO BE A REAL BROWSER
// ═════════════════════════════════════════════════════════════════════════════
//
// Two of the three claims in this package are claims about LAYOUT, and neither survives a
// simulated DOM:
//
//   · finding R14 — „`.legend` is a single flex row inside a 40 px toolbar with `overflow:
//     hidden`. It clips, it does not wrap." The answer this package ships is measured, not
//     argued, so §5 measures it in the SAME WebKit the app ships in, at the family scale target's
//     two ends: excellent at 2, acceptable at 8 (addendum §9).
//   · the chip is 16 px and the toolbar is 40 px. A chip that renders at 16 px in jsdom and at 19
//     in WebKit is the difference between a legend that fits and one that silently loses its last
//     category, because `overflow: hidden` reports nothing to anybody.
//
// The port is a fake, and it has to be: `member.set` has no entry in `core/ops.js`'s `MUTATIONS`
// (that table is exactly v1's 22 mutate sites) and `family/mount.js` is not this ticket's file.
// It is injected the way every collaborator in this app is injected — `initMembersUI({port})`,
// the same call the family opt-in moment will make — so there is no seam code in the shipped
// product and no `window.__lzpMembers` for a page script to reach. Test 0 keeps that true.
//
// WHAT TIER 1 WILL OWN AND THIS FILE DOES NOT: what makes a `member.set` op admissible, the
// authorization fold, and the relay round trips. This file owns what a person sees.

const members = await importApp('family/membersui.js');
const i18n = await importApp('i18n.js');
const palette = await importApp('palette.js');
const { store } = await importApp('store.js');

// ═════════════════════════════════════════════════════════════════════════════
// 0 · scaffolding
// ═════════════════════════════════════════════════════════════════════════════

/** A MemberId the real `isMemberId` would accept: `mem_` + 22 b64url characters. */
const B22 = 'ABCDEFGHJKMNPQRSTUVWXY';
const memId = (n) => `mem_${B22.slice(0, 21)}${String(n)}`;

/**
 * A RegisterMap by hand: `Map<entityKey, Map<field, {value, stamp}>>`.
 *
 * The shape is `core/registers.js`'s and the stamps are ignored by `readMembers` — it reads
 * values, never orderings — so a fixed stamp keeps the fixture honest about what is being tested.
 */
function regs(rows) {
  const m = new Map();
  for (const r of rows) {
    const cells = new Map();
    if ('displayName' in r) cells.set('displayName', { value: r.displayName, stamp: 'S' });
    if ('colorRef' in r) cells.set('colorRef', { value: r.colorRef, stamp: 'S' });
    if ('alive' in r) cells.set('_alive', { value: r.alive, stamp: 'S' });
    if (r.dev) cells.set(`dev.${r.dev}`, { value: 'blob', stamp: 'S' });
    m.set(`member:${r.id}`, cells);
  }
  // A category and a pref sit in the same map in the real product. They are here so a reader that
  // walked every key instead of the `member:` ones would be caught.
  m.set('cat:00000000-0000-4000-8000-000000000001', new Map([['name', { value: 'Reisen', stamp: 'S' }]]));
  m.set('pref:app', new Map([['rowHeight', { value: 22, stamp: 'S' }]]));
  return m;
}

const ME = memId(0);
const MAMA = memId(1);
const PAPA = memId(2);

/** The eight-member fixture — addendum §9's upper bound, with the names a family really uses. */
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

let calls = [];
function mount(rows, over = {}) {
  calls = [];
  const map = regs(rows);
  members.initMembersUI({
    port: {
      me: () => ME,
      adminId: () => ME,
      registers: () => map,
      keysPending: () => false,
      setProfile: async (p) => { calls.push(p); },
      ...over,
    },
    legendHost: '.legend',
  });
  return map;
}
function unmount() {
  members.initMembersUI();
  members.renderFamilyLegend();
  i18n.setLang('de');
  document.querySelectorAll('.scrim').forEach((n) => n.remove());
}

/** Build one section into a detached body, with the `{rebuild, close}` every section takes. */
function build(fn) {
  const body = document.createElement('div');
  const api = { rebuild: () => { body.textContent = ''; fn(body, api); }, close: () => {} };
  fn(body, api);
  return body;
}

const legendHost = () => document.querySelector('.legend');
const famSection = () => document.getElementById(members.FAMILY_LEGEND_ID);
const chips = () => $$(`#${members.FAMILY_LEGEND_ID} .member-chip`);

/** Every word of visible copy in a subtree, lower-cased. */
const words = (node) => `${node.textContent} ${$$('[title]', node).map((n) => n.title).join(' ')}`.toLowerCase();

// ═════════════════════════════════════════════════════════════════════════════
// 0 · the seam is a seam, and solo mode is silent
// ═════════════════════════════════════════════════════════════════════════════

test('the shipped page exposes no member hook, and solo mode draws nothing at all', () => {
  for (const k of ['__lzpMembers', '__lzpFamily', '__lzpInvites', 'members', 'familyMembers']) {
    assert.equal(window[k], undefined, `window.${k} must not exist`);
  }
  // PRINCIPLE 7, asserted against the real toolbar of a real solo launch. Nothing is mounted, so
  // there is no family section, no chip, no divider and no „Familie" anywhere in the chrome.
  assert.equal(members.membersSupported(), false, 'nothing is mounted until someone mounts it');
  members.renderFamilyLegend();
  assert.equal(famSection(), null, 'solo mode drew a family section');
  assert.equal(members.membersUIState().members.length, 0);
  // …and the sections themselves decline rather than draw an empty heading.
  assert.equal(build(members.buildMembersSection).textContent, '');
  // Asserted over the SECTION and not over the word: one of v1's default categories is called
  // „Familie", and a test that looked for the string would pass on a broken build the day
  // somebody renamed that category.
  assert.equal($$('.legend .member-chip').length, 0);
  assert.equal($$('.legend .legend-fam-label').length, 0);
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 1 · the reader — 15.4 over the register map, not over the relay
// ═════════════════════════════════════════════════════════════════════════════

test('readMembers reads member: registers and nothing else, and keeps a member with no name', () => {
  const rows = members.readMembers(regs([
    { id: ME, displayName: 'Manuel', colorRef: 'blau' },
    { id: MAMA, colorRef: 'magenta', dev: 'ABCDEFGHJKMNPQRS' },   // joined, profile not folded yet
    { id: PAPA, displayName: 'Papa', colorRef: 'gruen', alive: false },
  ]), { me: ME, adminId: ME });

  assert.equal(rows.length, 3, 'a category or a pref leaked into the member list');
  const by = Object.fromEntries(rows.map((r) => [r.memberId, r]));

  assert.equal(by[ME].displayName, 'Manuel');
  assert.equal(by[ME].isMe, true);
  assert.equal(by[ME].isAdmin, true);
  assert.equal(by[ME].initial, 'M');

  // D9's joiner, seen from an established Mac: a member whose `member.set{displayName}` has not
  // been folded yet is IN THE LIST. Dropping her would make the person who just joined invisible
  // to the circle she just joined, which is 15.4's whole point.
  assert.equal(by[MAMA].displayName, null);
  assert.equal(by[MAMA].initial, '·', 'a nameless member must not be given a guessed initial');
  assert.equal(by[MAMA].alive, true, '_alive absent means alive, not deleted');
  assert.equal(by[MAMA].colorRef, 'magenta');

  assert.equal(by[PAPA].alive, false, '_alive:false must survive to the row');
  // Order is by memberId: stable, and it never moves when somebody renames themselves (15.6).
  assert.deepEqual(rows.map((r) => r.memberId), [ME, MAMA, PAPA]);
});

test('the roster fills a missing colour and adds an undecrypted member — and never overrides', () => {
  // The relay publishes `colorRef` in the clear and `displayName` NEVER
  // (`invites.js:FORBIDDEN_RESPONSE_FIELDS`). That asymmetry is what makes D9's pre-wrap list
  // colours-with-no-names rather than an empty panel.
  const rows = members.readMembers(regs([{ id: ME, displayName: 'Manuel', colorRef: 'blau' }]), {
    me: ME,
    roster: [
      { memberId: ME, colorRef: 'rot' },                      // disagrees with the log
      { memberId: MAMA, colorRef: 'magenta' },                // not in the log at all
      { memberId: PAPA, colorRef: 'gruen', removedAt: '2026-08-01T00:00:00.000Z' },
    ],
  });
  const by = Object.fromEntries(rows.map((r) => [r.memberId, r]));
  assert.equal(by[ME].colorRef, 'blau', 'the relay overrode the log — the board would disagree');
  assert.equal(by[MAMA].colorRef, 'magenta');
  assert.equal(by[MAMA].displayName, null, 'a name may never come off the relay');
  assert.equal(by[PAPA].alive, false, 'removedAt must mark the row');
});

test('initialOf takes one GRAPHEME, so an astral first character is not cut in half', () => {
  assert.equal(members.initialOf('Mama'), 'M');
  assert.equal(members.initialOf('ümit'), 'Ü');
  assert.equal(members.initialOf('  lena '), 'L');
  assert.equal(members.initialOf(''), '·');
  assert.equal(members.initialOf(null), '·');
  // `name[0]` would return a lone surrogate here and render as a replacement glyph on every
  // member's board — invisible to the author, permanent, and undiagnosable from the outside.
  assert.equal([...members.initialOf('𝔐ama')].length, 1);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2 · the member list in ⚙ — 15.4, and 20.5's sentence
// ═════════════════════════════════════════════════════════════════════════════

test('every member has a colour, an initial and a name, and exactly one row says „du"', () => {
  mount(EIGHT);
  const body = build(members.buildMembersSection);
  const rows = $$('.member-row', body);
  assert.equal(rows.length, 8);
  for (const r of rows) {
    const chip = $('.member-chip', r);
    assert.ok(chip, 'a member row with no chip');
    assert.equal(chip.textContent.length > 0, true);
    assert.ok($('.member-name', r).textContent.trim().length > 0);
  }
  const you = $$('.member-tag', body).filter((n) => n.textContent === 'du');
  assert.equal(you.length, 1, 'exactly one row is mine');
  assert.equal($$('.member-tag', body).filter((n) => n.textContent === 'Verwaltung').length, 1);
  // Me first (a list is read, not scanned), then by name.
  assert.deepEqual($$('.member-name', body).map((n) => n.textContent).slice(0, 3),
    ['Manuel', 'Jonas', 'Lena']);
  unmount();
});

test('20.5 — no copy anywhere implies the admin can see more, and one line says the opposite', () => {
  mount(EIGHT);
  const body = build(members.buildMembersSection);
  assert.includes(body.textContent, 'Die Verwaltung pflegt den Kreis');
  assert.includes(body.textContent, 'das verhindert die Verschlüsselung, keine Regel');
  // The negative half. A panel that grew a sentence like „als Verwalter siehst du …" would break
  // 20.5 without breaking a single behavioural test, so the words are asserted absent.
  const w = words(body);
  for (const bad of ['einsehen', 'einblick', 'überwach', 'kontrollier', 'alle einträge sehen',
    'private einträge sehen', 'zugriff auf']) {
    assert.equal(w.includes(bad), false, `the panel says „${bad}"`);
  }
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 3 · my own name and colour — 15.6, and the collision rule
// ═════════════════════════════════════════════════════════════════════════════

test('my name is editable, propagates without an approval step, and an empty name is refused', () => {
  mount(EIGHT);
  const body = build(members.buildMembersSection);
  const input = $('input.txt', body);
  assert.equal(input.value, 'Manuel');
  assert.equal(input.disabled, false);

  input.value = 'Manu';
  input.dispatchEvent(new Event('change'));
  assert.deepEqual(calls, [{ displayName: 'Manu', colorRef: 'blau' }]);
  // 15.6 — "without admin involvement": nothing in the write asks anyone for anything, and the
  // copy says so rather than leaving it to be discovered.
  assert.includes(body.textContent, 'Niemand muss sie freigeben');

  calls = [];
  input.value = '   ';
  input.dispatchEvent(new Event('change'));
  assert.deepEqual(calls, [], 'an empty name was written');
  assert.equal(input.value, 'Manuel', 'the field must snap back to the real name');
  unmount();
});

test('a colour another member holds cannot be picked, and says whose it is', () => {
  mount(EIGHT);
  const body = build(members.buildMembersSection);
  const sws = $$('.member-swatches .sw', body);
  assert.equal(sws.length, 10, 'the same ten tones as categories (4.5)');

  const magenta = sws.find((n) => n.dataset.ref === 'magenta');
  assert.equal(magenta.disabled, true, 'Mama’s tone was pickable');
  assert.includes(magenta.title, 'Mama');

  // MY OWN current tone is not a collision with myself.
  const blau = sws.find((n) => n.dataset.ref === 'blau');
  assert.equal(blau.disabled, false);
  assert.equal(blau.getAttribute('aria-pressed'), 'true');

  // Two members exist in `TWO`, so eight tones are free there — the rule is about members, never
  // about my categories: they are separate namespaces (addendum §9).
  const schiefer = sws.find((n) => n.dataset.ref === 'schiefer');
  assert.equal(schiefer.disabled, false);
  schiefer.click();
  assert.deepEqual(calls, [{ displayName: 'Manuel', colorRef: 'schiefer' }]);

  // And clicking the tone I already have is not an edit — v1's decline protocol, verbatim.
  calls = [];
  blau.click();
  assert.deepEqual(calls, []);
  unmount();
});

test('freeMemberColorRef — the value the join flow (15.3) must pre-select', () => {
  const eight = members.readMembers(regs(EIGHT), { me: ME });
  const free = members.freeMemberColorRef(eight);
  assert.equal(members.takenColorRefs(eight).has(free), false);
  assert.ok(palette.PALETTE.some((p) => p.ref === free));
  // A removed member's tone is free again — otherwise a family that has seen ten people through
  // it would run out of colours for ever.
  const gone = members.readMembers(regs(EIGHT.map((r) => ({ ...r, alive: false }))), { me: ME });
  assert.equal(members.takenColorRefs(gone).size, 0);
  assert.equal(members.freeMemberColorRef(gone), palette.PALETTE[0].ref);
});

test('with no write port the two fields are disabled and SAY so, rather than pretending', () => {
  mount(EIGHT, { setProfile: undefined });
  assert.equal(members.selfEditSupported(), false);
  const body = build(members.buildMembersSection);
  assert.equal($('input.txt', body).disabled, true);
  assert.equal($$('.member-swatches .sw', body).every((n) => n.disabled), true);
  assert.includes(body.textContent, 'lassen sich hier gerade nicht ändern');
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 4 · D9's waiting state — a designed screen, never an error
// ═════════════════════════════════════════════════════════════════════════════

test('D9 — the waiting line is calm, has no spinner, and never sends anyone to a laptop', () => {
  // Mom, one second after redeeming: she is a member, the roster gives her colours, and every
  // `member.set` in the space is still ciphertext to her.
  members.initMembersUI({
    port: {
      me: () => MAMA,
      adminId: () => ME,
      keysPending: () => true,
      registers: () => regs([{ id: MAMA, displayName: 'Mama', colorRef: 'magenta' }]),
      roster: () => EIGHT.map((r) => ({ memberId: r.id, colorRef: r.colorRef })),
    },
    legendHost: '.legend',
  });

  const body = build(members.buildMembersSection);
  const line = $('.member-waiting', body);
  assert.ok(line, 'the waiting state drew nothing at all');
  assert.includes(line.textContent, 'Du bist im Kreis');
  assert.includes(line.textContent, 'von selbst');

  // D9's three not-negotiables, asserted as absences on the rendered text.
  const w = words(body);
  for (const bad of ['fehler', 'fehlgeschlagen', 'erneut versuchen', 'wiederholen',
    'bitte warte', 'aufklappen', 'öffnen lassen', 'bitte jemanden']) {
    assert.equal(w.includes(bad), false, `the waiting state says „${bad}"`);
  }
  // 19.3 — no spinner, and specifically not on the board.
  assert.equal($$('.spinner, .loading, [class*="spin"]', body).length, 0);
  assert.equal($$('.board .spinner, .board .member-waiting').length, 0);

  // The other members are THERE, in their colours, with no names. That is the state, rendered as
  // itself rather than as an empty panel.
  const rows = $$('.member-row', body);
  assert.equal(rows.length, 8);
  const dashes = $$('.member-name-pending', body);
  assert.equal(dashes.length, 7, 'only my own name is known before the wrap arrives');
  assert.equal($('.member-chip', rows[1]).textContent, '·');
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 5 · THE LEGEND — A3 / 17.3, and finding R14 measured in the real toolbar
// ═════════════════════════════════════════════════════════════════════════════

test('the legend gains a second section: a rule, a „Familie" label, and one chip per member', () => {
  mount(TWO);
  members.renderFamilyLegend();
  const sec = famSection();
  assert.ok(sec, 'no family section in the legend');
  assert.equal(sec.parentElement.className, 'legend', 'the section is not in the legend');
  assert.ok($('.legend-fam-rule', sec), 'A3’s two sections need a visible divider');
  assert.equal($('.legend-fam-label', sec).textContent, 'Familie');

  // ME IS NOT IN THE LEGEND. 17.2: my entries render in MY CATEGORY COLOURS, so a chip for
  // myself would be a toggle for something the board never draws that way.
  assert.equal(chips().length, 1);
  assert.equal(chips()[0].textContent, 'M');
  assert.equal(chips()[0].dataset.memberId, MAMA);

  // The categories are untouched — A3: „Meine Kategorien (unchanged, personal, local)".
  assert.ok($$('.legend .legend-item').length >= 1, 'the category half went missing');
  assert.ok($('.legend .legend-edit'), 'the „bearbeiten" affordance went missing');
  unmount();
  assert.equal(famSection(), null, 'unmounting left the section behind');
});

test('R14 — eight members fit the 40 px toolbar, measured, and cost ZERO vertical pixels', () => {
  const before = document.querySelector('.toolbar').getBoundingClientRect().height;
  mount(EIGHT);
  members.renderFamilyLegend();

  const sec = famSection();
  const cs = getComputedStyle(chips()[0]);
  assert.equal(cs.width, '16px', `the chip is ${cs.width} wide`);
  assert.equal(cs.height, '16px');
  assert.equal(cs.borderRadius, '50%');

  assert.equal(chips().length, 7, 'seven others plus me is eight');
  const width8 = sec.getBoundingClientRect().width;
  diag(`R14: the family section is ${Math.round(width8)} px at 8 members`);

  // THE HEADLINE. R14 prices a second row at ~22 px of the vertical budget; this costs none.
  const after = document.querySelector('.toolbar').getBoundingClientRect().height;
  assert.equal(after, before, `the toolbar grew from ${before} to ${after} px`);
  assert.equal(after, 40, 'the toolbar is not 40 px any more');

  // THE COMPARISON THE DECISION RESTS ON, measured rather than asserted from the header: the same
  // eight members as NAME chips, in the same row, at the same type scale.
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;display:inline-flex;gap:10px';
  for (const r of EIGHT.slice(1)) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const sw = document.createElement('span');
    sw.className = 'sw';
    item.appendChild(sw);
    item.appendChild(document.createTextNode(r.displayName));
    probe.appendChild(item);
  }
  document.body.appendChild(probe);
  const asNames = probe.getBoundingClientRect().width;
  probe.remove();
  diag(`R14: the same eight as name chips would be ${Math.round(asNames)} px`);
  assert.ok(width8 < asNames * 0.6,
    `chips (${Math.round(width8)}px) must cost well under half of names (${Math.round(asNames)}px)`);

  // And at 2 — „excellent at 2, acceptable at 8" (addendum §9).
  mount(TWO);
  members.renderFamilyLegend();
  const width2 = famSection().getBoundingClientRect().width;
  diag(`R14: the family section is ${Math.round(width2)} px at 2 members`);
  assert.ok(width2 < width8, 'two members must cost less than eight');
  unmount();
});

test('R14’s overflow — a legend that still cannot fit collapses to a disclosure, not a clip', () => {
  // `.legend` is `overflow:hidden`, so an overflowing row loses its tail SILENTLY. This is the
  // one condition that has to be detected rather than styled around.
  const host = legendHost();
  const restore = host.style.cssText;
  host.style.cssText = 'flex:none;width:60px;max-width:60px';
  mount(EIGHT);
  members.renderFamilyLegend();

  const more = document.getElementById(`${members.FAMILY_LEGEND_ID}-more`);
  assert.ok(more, 'the family section clipped instead of collapsing');
  assert.includes(more.textContent, '7');
  // THE PROPERTY IS NOT THE PIXEL. `.legend-fam-chips { display: inline-flex }` is a class rule
  // and it beats the UA stylesheet's `[hidden] { display: none }`, so `node.hidden === true` was
  // true while the collapsed chips still occupied 140 px of the row this test is about. Assert
  // the computed box, and the section's real width against the uncollapsed one.
  assert.equal($('.legend-fam-chips').hidden, true);
  assert.equal(getComputedStyle($('.legend-fam-chips')).display, 'none',
    'the chips are hidden in the DOM and still taking room on screen');
  assert.ok(famSection().getBoundingClientRect().width < 100,
    `the collapsed section is ${Math.round(famSection().getBoundingClientRect().width)} px wide`);

  // The disclosure is not a dead end: it opens the same list, read-only.
  more.click();
  const sheet = $('.scrim .sheet');
  assert.ok(sheet, 'the disclosure opened nothing');
  assert.equal($$('.member-row', sheet).length, 8);
  $('.pop-x', sheet).click();

  host.style.cssText = restore;
  unmount();
});

test('17.3 — a member chip hides that member the way a category swatch hides a category', () => {
  mount(EIGHT);
  members.renderFamilyLegend();
  const mama = chips().find((c) => c.dataset.memberId === MAMA);
  assert.equal(mama.dataset.visible, 'true');
  assert.equal(mama.getAttribute('aria-pressed'), 'true');
  assert.includes(mama.title, 'ausblenden');

  const filled = getComputedStyle(mama).backgroundColor;
  assert.notEqual(filled, 'rgba(0, 0, 0, 0)', 'a visible member chip must be filled');

  mama.click();
  const off = chips().find((c) => c.dataset.memberId === MAMA);
  assert.equal(off.dataset.visible, 'false');
  assert.equal(off.getAttribute('aria-pressed'), 'false');
  // HOLLOW, exactly as `app.css:139` makes a hidden category swatch hollow. Somebody who has
  // learnt one has learnt the other, which is what 17.3's „the same way" asks for.
  assert.equal(getComputedStyle(off).backgroundColor, 'rgba(0, 0, 0, 0)');
  assert.includes(off.title, 'wieder einblenden');

  // Device-local (Principle 9, and `ops.js`'s `hiddenMembers.<memberId>` shape).
  assert.equal(members.hiddenMemberIds().has(MAMA), true);
  assert.equal(store.state.settings.hiddenMembers[MAMA], true);

  off.click();
  assert.equal(members.hiddenMemberIds().has(MAMA), false);
  assert.equal(chips().find((c) => c.dataset.memberId === MAMA).dataset.visible, 'true');
  unmount();
});

test('the legend survives legend.js rebuilding itself, which is what the observer is for', async () => {
  const legend = await importApp('legend.js');
  mount(EIGHT);
  members.initFamilyLegend({ host: '.legend' });
  assert.ok(famSection());

  // `renderLegend()` opens with `legendEl.textContent = ''`. Without the bridge the family half
  // disappears on the next category toggle and never comes back.
  legend.renderLegend();
  await waitFor(() => famSection(), { what: 'the family section to be restored', timeout: 2000 });
  assert.equal(chips().length, 7);
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 6 · the contract `adminpanel.js` consumes — one source, two views
// ═════════════════════════════════════════════════════════════════════════════

test('membersUIState() is the ONE membership reader, in the shape the admin panel lays out', async () => {
  // `family/adminpanel.js:124` imports `membersUIState` and its `manageRows()` reads exactly
  // `memberId`, `displayName`, `colorRef`, `initial`, `isMe`, `isAdmin` and `alive === false`.
  // Its own header says why there must not be a second reader: "two lists that could disagree
  // about who is in the circle would be worse than one list in the wrong place". This test is
  // that agreement, pinned from THIS side, so a field rename here fails here.
  mount(EIGHT);
  const view = members.membersUIState();
  assert.equal(view.supported, true);
  assert.deepEqual(Object.keys(view).sort(),
    ['adminId', 'keysPending', 'me', 'members', 'supported']);
  assert.deepEqual(Object.keys(view.members[0]).sort(),
    ['alive', 'colorRef', 'displayName', 'hidden', 'initial', 'isAdmin', 'isMe', 'memberId']);

  const admin = await importApp('family/adminpanel.js');
  const rows = admin.manageRows(view.members, 'de');
  assert.equal(rows.length, 8);
  assert.equal(rows[0].isAdmin, true, 'the admin panel could not find the admin in my rows');
  assert.equal(rows.filter((r) => r.isMe).length, 1);
  assert.equal(rows.every((r) => r.initial.length >= 1), true);
  unmount();
});

test('19.2 — nothing in this panel offers to sync, refresh or retry', () => {
  mount(EIGHT);
  const body = build(members.buildMembersSection);
  const labels = $$('button', body).map((n) => `${n.textContent} ${n.title || ''}`.toLowerCase());
  for (const word of ['sync', 'abgleich', 'aktualisieren', 'neu laden', 'erneut', 'refresh']) {
    const hit = labels.find((l) => l.includes(word));
    assert.equal(hit, undefined, `a control offers to ${word}: ${hit}`);
  }
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 6 · 13.7 — German first, English complete
// ═════════════════════════════════════════════════════════════════════════════

test('every string in both panels and in the legend has an English half', () => {
  // The property, checked over the tables rather than over one rendering: a `{de}` with no `en`
  // is what actually ships broken, and it ships as the German string appearing in an English UI
  // where nobody who reads the diff would notice.
  const walk = (obj, path = '') => {
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object' && ('de' in v || 'en' in v)) {
        assert.ok(v.de, `${path}${k}.de is missing`);
        assert.ok(v.en, `${path}${k}.en is missing`);
        assert.equal(typeof v.de, typeof v.en, `${path}${k}: de and en are different shapes`);
        // Identical halves are allowed ONLY where German and English really are the same word.
        // The list is short and explicit, because "it happens to be the same" is exactly how an
        // untranslated string ships without anybody noticing.
        const same = ['MEMBERS_COPY.nameLabel', 'MEMBERS_COPY.waitingNoName'];
        if (typeof v.de === 'string' && !same.includes(`${path}${k}`)) {
          assert.notEqual(v.de, v.en, `${path}${k} is untranslated`);
        }
      } else if (v && typeof v === 'object') {
        walk(v, `${path}${k}.`);
      }
    }
  };
  walk({ ...members.MEMBERS_COPY }, 'MEMBERS_COPY.');
});

test('the English UI is English — no German leaks into the panels or the legend', () => {
  i18n.setLang('en');
  mount(EIGHT);
  members.renderFamilyLegend();

  const body = document.createElement('div');
  members.buildMembersSection(body, { rebuild: () => {}, close: () => {} });
  const text = `${body.textContent} ${famSection().textContent} ${words(body)}`;

  assert.includes(text, 'Family');
  assert.includes(text, 'the encryption prevents that, not a rule');
  assert.includes(text, 'My name and my colour');
  assert.equal($('.legend-fam-label').textContent, 'Family');
  for (const german of ['Familienkreis', 'Verwaltung', 'Schlüssel', 'Verschlüsselung',
    'ausblenden', 'Farbe', 'du bist im kreis']) {
    assert.equal(text.includes(german), false, `German leaked into the English UI: „${german}"`);
  }
  unmount();
});
