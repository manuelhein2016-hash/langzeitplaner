// TIER 2 · the settings sheet's family half — which sections exist, in which order, and under
// which NAMES. `family/familysettings.js`. F15 · F19 · stories 15.1, 19.2, 19.3, 19.4.
//
// ═════════════════════════════════════════════════════════════════════════════
// THIS FILE IS ABOUT ONE WORD
// ═════════════════════════════════════════════════════════════════════════════
//
// „Familienkreis" is a glossary term. The addendum defines it, F15 builds it, and every screen in
// `createjoin.js`, `membersui.js` and `adminpanel.js` teaches it. A person who has read one of
// those screens knows what the word means, and the whole value of a glossary term is that the
// second time they meet it they do not have to work it out again.
//
// It was also, for one round, the title of the section that holds a RELAY ADDRESS and this Mac's
// own `psp_` space — story 19.4, own-device sync, which is not the Familienkreis and does not
// involve another person at all. Two sections in one sheet claimed one name.
//
// THAT IS NOT A COSMETIC DEFECT. Story 15.1 says the family features exist "only behind an
// explicit 'Familienkreis erstellen / beitreten' entry point in settings" — so a person looking
// for family sharing is looking for exactly that word, and the version of it that appeared over a
// server field taught them that the family feature IS an infrastructure setting. The section that
// was renamed is the one that is NOT F15's, because a glossary term belongs to the thing it
// defines.
//
// The rows below are the pin: no two sections share a title, in either language, and the word is
// where it belongs. A rename in `i18n.js` that re-collides fails here rather than in a user's ⚙.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY IT IS A REAL SHEET AND NOT A STRING COMPARISON
// ═════════════════════════════════════════════════════════════════════════════
//
// Comparing two `t()` values would pass on a build where `buildOptInSection` had stopped calling
// `t('familySectionTitle')` at all. What a person reads is the `.section-title` nodes in the
// order `buildFamilySections` appends them, so that is what is read here — over a solo Mac, which
// is also the state in which somebody goes looking for the entry point in the first place.

const settings = await importApp('family/familysettings.js');
const i18n = await importApp('i18n.js');
const createjoin = await importApp('family/createjoin.js');
const status = await importApp('family/syncstatus.js');

// ═════════════════════════════════════════════════════════════════════════════
// 0 · scaffolding
// ═════════════════════════════════════════════════════════════════════════════

/** The whole family half of ⚙, built into a detached body, on a Mac with no space and no circle. */
function sheet() {
  const body = document.createElement('div');
  const api = { rebuild: () => {}, close: () => {} };
  settings.buildFamilySections(body, api, { onOptIn: async () => {} });
  return body;
}

const titles = (body) => $$('.section-title', body).map((n) => n.textContent);

function bothLanguages(fn) {
  for (const lang of ['de', 'en']) {
    i18n.setLang(lang);
    fn(lang);
  }
  i18n.setLang('de');
}

// ═════════════════════════════════════════════════════════════════════════════
// 1 · no two sections share a name
// ═════════════════════════════════════════════════════════════════════════════

test('every section in the family half has a name of its own, in both languages', () => {
  bothLanguages((lang) => {
    const t = titles(sheet());
    assert.ok(t.length >= 3, `${lang}: the sheet drew ${t.length} sections`);
    const dupes = t.filter((x, i) => t.indexOf(x) !== i);
    assert.deepEqual(dupes, [],
      `${lang}: two sections claim one name — ${JSON.stringify(dupes)} in ${JSON.stringify(t)}`);
    for (const x of t) assert.ok(x.trim().length > 0, `${lang}: a section has no title at all`);
  });
});

test('„Familienkreis" is the title of exactly ONE section, and it is F15’s', () => {
  bothLanguages((lang) => {
    const term = i18n.t('circleSectionTitle');
    const t = titles(sheet());
    assert.equal(t.filter((x) => x === term).length, 1,
      `${lang}: „${term}" titles ${t.filter((x) => x === term).length} sections`);
    // AND IT IS FIRST. 15.1's entry point is what a person opening ⚙ is looking for; the relay
    // address is plumbing, and a sheet that opens with plumbing teaches that the feature IS
    // plumbing. `familysettings.js` says so at the call site and this is that claim, measured.
    assert.equal(t[0], term, `${lang}: the sheet opens with „${t[0]}" instead of the entry point`);
  });
});

test('the own-device section is named for what it contains, and never for the circle', () => {
  bothLanguages((lang) => {
    const own = i18n.t('familySectionTitle');
    const circle = i18n.t('circleSectionTitle');
    assert.notEqual(own, circle, `${lang}: the two sections are back to one name`);
    assert.includes(titles(sheet()), own, `${lang}: the own-device section lost its title`);
    // The glossary term may not appear inside it either — „Mein Familienkreis-Server" would be
    // the same confusion with a hyphen in it.
    assert.equal(own.toLowerCase().includes(circle.toLowerCase().split(' ')[0].toLowerCase()), false,
      `${lang}: „${own}" still carries „${circle}"`);
    // It says both of the things it actually holds: a server, and this Mac's own devices.
    assert.match(own, /server/i, `${lang}: „${own}" does not name the server it is about`);
    assert.match(own, /gerät|device/i, `${lang}: „${own}" does not say whose devices these are`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2 · the sheet is still the sheet — nothing here is a regression on 15.1 / 19.2
// ═════════════════════════════════════════════════════════════════════════════

test('a solo Mac meets the entry point and nothing else that reaches a network', () => {
  const body = sheet();
  // 15.1 — the entry point exists and is two buttons. `createjoin.js` owns them; this row is the
  // claim that `familysettings.js` actually calls it, which is the one line P-4 was about.
  assert.includes(body.textContent, i18n.t('circleSectionTitle'));
  assert.includes(body.textContent, i18n.t('circleCreateBtn'));
  assert.includes(body.textContent, i18n.t('circleJoinBtn'));

  // 15.1 again, from the other side: with no circle there is no member list and no admin panel,
  // so a solo ⚙ has no „Familie" heading, no roster and no invite control.
  assert.equal($$('.member-list', body).length, 0);
  assert.equal($$('.member-chip', body).length, 0);

  // 19.2 — NO SYNC BUTTON AND NO MANUAL REFRESH ANYWHERE. The sync section is prose.
  const syncTitle = $$('.section-title', body).find((n) => n.textContent === i18n.t('syncSectionTitle'));
  assert.ok(syncTitle, 'the „Abgleich" section went missing');
  for (const b of $$('button', body)) {
    assert.equal(/abgleich|sync|aktualis|refresh|retry|erneut/i.test(b.textContent), false,
      `a control offers to sync: „${b.textContent}"`);
  }

  // 19.3 — and drawing the sheet draws nothing on the board and starts no engine.
  assert.equal($$('.board .sync-dot').length, 0);
  assert.equal(status.syncSupported(), false);
  assert.equal(createjoin.familyCircle(), null, 'building the sheet joined a circle');
});

test('the English sheet is English, and the German term is not left in it', () => {
  i18n.setLang('en');
  const body = sheet();
  const text = body.textContent;
  assert.includes(text, i18n.t('circleSectionTitle'));
  for (const german of ['Familienkreis', 'Einrichten', 'Privater Raum', 'Abgleich']) {
    assert.equal(text.includes(german), false, `German leaked into the English sheet: „${german}"`);
  }
  i18n.setLang('de');
});
