// TIER 2 · STORY 18.3 GETS A CALLER — the admin unshare, on screen, and what the OWNER sees.
// `family/familysettings.js`'s moderation section · `family/membersui.js`'s borrowed chip ·
// `family/unshare.js` (unchanged, and until this round dead code).
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT WAS WRONG, AND WHAT THIS FILE IS THE PROOF OF
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// E9 shipped the whole admin unshare — the producer (`core/project.js:adminUnshareOp`), the
// barrier-4 retraction clause that made it sealable at all, the driver (`family/unshare.js`), the
// owner's reconciliation (`adminUnshareFollowUp`, wired into `store.applyRemote`) and 105 tier-1
// cells over the lot — **and no button**. `docs/v2/FINDINGS.md` §15f item 2 records it:
//
//   > "An admin-unshare button. `family/unshare.js` is complete and tested and no UI calls it;
//   >  the demonstration drives `adminUnshareOp` directly."
//
// A moderation capability nobody can invoke is not a shipped capability, and 18.3's PASS meant
// „the bytes are right" rather than „the admin can do this". This file is the other half.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE FOUR CLAIMS, AND WHICH SECTION HOLDS EACH
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   §1  the control exists, and ONLY for the Mac that holds the seat
//   §2  the list can show only what the circle was told — structurally, not by being careful
//   §3  the button reaches `unshare.js` with an ENTITY KEY and nothing else
//   §4  the copy: three claims, both languages, and none of ADR 002 §7.4's four forbidden phrases
//   §5  ⚠ WHAT THE OWNER SEES — the byte-identity property, on screen. ADR 004 §5.1 makes the
//       owner's own „→ Privat" and the admin's unshare byte-identical on the wire *so that a peer
//       cannot tell which happened*; a UI that labelled the outcome differently on the owner's
//       board would destroy that property in the one place it is actually visible to a person.
//       So both paths are driven, on a REAL store, through the REAL ops, and the results are
//       diffed — the entry, the DOM node, and the whole document's words.
//   §6  and the owner's next keystroke still does not re-share it
//
// §5 and §6 run the real store and real peers, `e9-demonstration.dom.js`'s fixture; §1–§4 run the
// section over an injected register map and an injected driver, because a settings section must
// be testable without a relay and because the driver's own verdicts are tier 1's 105 cells.
//
// Plain script: globals are test, assert, $, $$, waitFor, sleep, importApp, diag, skip.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const settings = await importApp('family/familysettings.js');
const members = await importApp('family/membersui.js');
const sharing = await importApp('family/sharing.js');
const unshare = await importApp('family/unshare.js');
const i18n = await importApp('i18n.js');
const { store } = await importApp('store.js');
const { makeOp } = await importApp('core/ops.js');
const { createClock } = await importApp('core/stamp.js');
const { familyKey } = await importApp('core/entities.js');
const { parseAttestationBlob } = await importApp('core/authz.js');
const { adminUnshareOp } = await importApp('core/project.js');
const { canonicalJSON } = await importApp('core/canon.js');
const { b64u } = await importApp('core/b64.js');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §0 · scaffolding
// ═════════════════════════════════════════════════════════════════════════════════════════════

const B22 = 'ABCDEFGHJKMNPQRSTUVWXY';
const memId = (n) => `mem_${B22.slice(0, 21)}${String(n)}`;
const ADMIN = memId(0);            // me, in §1–§4
const MAMA = memId(1);
const OMA = memId(2);

const uuidN = (n) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, '0')}`;

/** A RegisterMap by hand — `Map<entityKey, Map<field, {value, stamp}>>` (`core/registers.js`). */
function regs(members_, entries) {
  const m = new Map();
  for (const r of members_) {
    const cells = new Map();
    cells.set('displayName', { value: r.name, stamp: 'S' });
    cells.set('colorRef', { value: r.colorRef, stamp: 'S' });
    m.set(`member:${r.id}`, cells);
  }
  for (const e of entries) {
    const cells = new Map();
    for (const [k, v] of Object.entries(e.fields)) cells.set(k, { value: v, stamp: 'S' });
    m.set(e.key, cells);
  }
  // A category and a personal note sit in the same map on a real Mac. They are here so a reader
  // that walked every key instead of the two family kinds would be caught.
  m.set('cat:00000000-0000-4000-8000-000000000001', new Map([['name', { value: 'Reisen', stamp: 'S' }]]));
  m.set(`note:${uuidN(90)}`, new Map([['text', { value: 'Meins, privat', stamp: 'S' }]]));
  return m;
}

/** A Geteilt note in the circle, as `core/project.js` would have published it. */
const geteiltNote = (owner, n, { date, text }) => ({
  key: familyKey('fnote', owner, uuidN(n)),
  fields: {
    'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': date,
    'pub.repeatsYearly': false, 'pub.coEdit': false, 'pub.text': text, _born: 'S',
  },
});
/** A Belegt note: the SAME allowlist, with the text row explicitly null (INV-R4). */
const belegtNote = (owner, n, { date }) => ({
  key: familyKey('fnote', owner, uuidN(n)),
  fields: {
    'pub.level': 'belegt', 'pub.alive': true, 'pub.date': date,
    'pub.repeatsYearly': false, 'pub.coEdit': null, 'pub.text': null, _born: 'S',
  },
});
const geteiltBar = (owner, n, { from, to, label }) => ({
  key: familyKey('fbar', owner, uuidN(n)),
  fields: {
    'pub.level': 'geteilt', 'pub.alive': true, 'pub.startDate': from, 'pub.endDate': to,
    'pub.coEdit': false, 'pub.label': label, _born: 'S',
  },
});

const PEOPLE = [
  { id: ADMIN, name: 'Papa', colorRef: 'blau' },
  { id: MAMA, name: 'Mama', colorRef: 'magenta' },
  { id: OMA, name: 'Oma', colorRef: 'gruen' },
];

/** The fixture the copy and list rows are read from. */
const ENTRIES = [
  geteiltNote(MAMA, 1, { date: '2026-05-14', text: 'Zahnarzt 9:00' }),
  belegtNote(MAMA, 2, { date: '2026-03-02' }),
  geteiltBar(OMA, 3, { from: '2026-06-01', to: '2026-06-08', label: 'Kur' }),
  geteiltNote(ADMIN, 4, { date: '2026-04-01', text: 'Mein eigener Eintrag' }),
];

let RUNS = [];
/** A driver with `unshare.js`'s exact answer shape, recording what the screen asked it. */
function fakeDriver(verdict = unshare.UNSHARE.DONE, lang = 'de') {
  return {
    run: (...args) => {
      RUNS.push(args);
      const say = verdict === unshare.UNSHARE.DONE
        ? [unshare.UNSHARE_COPY.done[lang], unshare.UNSHARE_COPY.honesty[lang]]
        : [unshare.UNSHARE_COPY.nothingShared[lang]];
      return Promise.resolve(Object.freeze({ verdict, entityKey: args[0], blockers: [], say }));
    },
  };
}

function mount({ me = ADMIN, adminId = ADMIN, entries = ENTRIES } = {}) {
  RUNS = [];
  const map = regs(PEOPLE, entries);
  members.initMembersUI({ port: { me: () => me, adminId: () => adminId, registers: () => map } });
  return map;
}
const unmount = () => { members.initMembersUI(); i18n.setLang('de'); scrims().forEach((n) => n.remove()); };

const scrims = () => $$('.scrim');

/** Build the moderation section into a detached body, with a rebuildable `api`. */
function build(hooks = {}) {
  const body = document.createElement('div');
  const api = {
    rebuild: () => { body.textContent = ''; settings.buildModerationSection(body, api, hooks); },
    close: () => {},
  };
  settings.buildModerationSection(body, api, hooks);
  return body;
}

/** Open the disclosure, whatever state the module-level flag happens to be in. */
function open(body) {
  const t = $('.mod-toggle', body);
  const list = $('.mod-list', body);
  if (t && list && list.hidden) t.click();
  return body;
}

const rowFor = (body, key) => $(`.mod-row[data-entity-key="${CSS.escape(key)}"]`, body);
const rowKeys = (body) => $$('.mod-row', body).map((n) => n.dataset.entityKey);
const titles = (body) => $$('.section-title', body).map((n) => n.textContent);
const say = (pair) => (i18n.getLang() === 'en' ? pair.en : pair.de);
const de = () => i18n.setLang('de');
const en = () => i18n.setLang('en');
const settle = () => new Promise((r) => setTimeout(r, 2));

/** The last toast's words, or `''`. */
const toastText = () => ($('.toast') ? $('.toast').textContent : '');

/** The confirm sheet's own footer button — `leavedelete.js`'s "last child of the foot". */
const confirmButton = () => {
  const foot = $('.scrim .sheet-foot');
  return foot ? foot.lastElementChild : null;
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · THE CONTROL EXISTS — and only on the Mac that holds the seat
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('1a · solo mode draws nothing at all, and there is no window hook', () => {
  unmount();
  for (const k of ['__lzpUnshare', '__lzpModeration', 'unshare']) {
    assert.equal(window[k], undefined, `window.${k} must not exist`);
  }
  assert.equal(build().textContent, '', 'Principle 7: a Mac in no circle drew a moderation section');
});

test('1b · the ADMIN gets the section, the list and one button per foreign entry', () => {
  de();
  mount();
  const body = open(build({ unshare: fakeDriver() }));
  assert.includes(titles(body), say(settings.MODERATION_COPY.title), 'no „Einträge im Familienkreis"');
  assert.equal($$('.mod-row', body).length, 3, 'one row per FOREIGN published entry');
  assert.equal($$('.mod-take', body).length, 3, 'a row without a button is not a control');
  unmount();
});

test('1f · the rows are not BUILT until the disclosure is pressed (Principle 7, in ⚙)', () => {
  // `hidden` alone would leave two hundred rows, chips and listeners in the DOM of every settings
  // open on a busy circle. The deferral is `fill()`, and this is the row that keeps it one.
  de();
  mount();
  // Close it first (the disclosure is remembered across sheet opens), then build a FRESH section
  // — which is what a settings open on a Mac that last left the list closed actually does.
  const warm = build({ unshare: fakeDriver() });
  if (!$('.mod-list', warm).hidden) $('.mod-toggle', warm).click();
  const body = build({ unshare: fakeDriver() });
  assert.equal($('.mod-list', body).hidden, true, 'precondition: the list is closed');
  assert.equal($$('.mod-row', body).length, 0, 'a closed list still built every row');
  $('.mod-toggle', body).click();
  assert.equal($$('.mod-row', body).length, 3, 'and pressing it builds them');
  assert.equal($('.mod-list', body).hidden, false);
  unmount();
});

test('1c · a member who does not hold the seat gets NO section — not a disabled button', () => {
  // ADR 001 §4.3 stage 3a rejects a non-admin's identical op on every honest device including her
  // own, so there is nothing here for her to be prevented from. A greyed control would teach that
  // the capability is one permission away and invite the conversation about somebody's entry.
  de();
  mount({ me: MAMA, adminId: ADMIN });
  const body = build({ unshare: fakeDriver() });
  assert.equal(body.textContent, '', 'a non-admin was shown the moderation console');
  assert.equal($$('.mod-take', body).length, 0);
  unmount();
});

test('1d · a circle with no admin chain in its log draws nothing', () => {
  // `UNSHARE_BLOCKERS.NO_ADMIN_CHAIN`. `createjoin.js` still owes the genesis link; until it
  // lands, `store.familyAdmin().admin` is null on a circle created by this build, and a button
  // that could only ever report a blocker is not a button.
  de();
  mount({ me: ADMIN, adminId: null });
  assert.equal(build({ unshare: fakeDriver() }).textContent, '');
  unmount();
});

test('1e · the section is mounted in the real sheet, and its name collides with nobody', () => {
  de();
  mount();
  const body = document.createElement('div');
  settings.buildFamilySections(body, { rebuild: () => {}, close: () => {} }, {
    onOptIn: async () => {}, unshare: fakeDriver(),
  });
  const all = titles(body);
  assert.includes(all, say(settings.MODERATION_COPY.title), 'the whole sheet never draws 18.3');
  assert.deepEqual(all.filter((x, i) => all.indexOf(x) !== i), [], `two sections share a name: ${all}`);
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · THE LIST CAN ONLY SHOW WHAT THE CIRCLE WAS TOLD
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('2a · a Geteilt row carries its text; a Belegt row carries the day and NO text node', () => {
  de();
  mount();
  const body = open(build({ unshare: fakeDriver() }));

  const shared = rowFor(body, ENTRIES[0].key);
  assert.equal($('.mod-what', shared).textContent, 'Zahnarzt 9:00', 'Geteilt shows what was shared');
  assert.equal(shared.dataset.level, 'geteilt');

  const busy = rowFor(body, ENTRIES[1].key);
  assert.equal(busy.dataset.level, 'belegt');
  assert.equal($('.mod-belegt', busy).textContent, say(sharing.TXT.belegt),
    'the glossary word, by identity from `sharing.js`');
  assert.equal($('.mod-what', busy).textContent, say(sharing.TXT.belegt),
    'a Belegt row must carry the tag and no second text cell');
  assert.equal(busy.textContent.includes('—'), false,
    'a placeholder for the missing text is a sentence about a private entry');
  // The day IS published at Belegt and is the whole point of the level.
  assert.includes(busy.textContent, '2. März 2026');
  unmount();
});

test('2b · a hostile `pub.text` at Belegt CANNOT reach the screen — the reader never asks', () => {
  // The structural half of "I still can't read what was never shared". `core/project.js` publishes
  // `pub.text: null` at Belegt by construction, so this state is unreachable through the product;
  // a peer that hand-built the op could still put the string in this Mac's register map. The list
  // does not depend on the producer being careful: at Belegt it never reads the field.
  de();
  const poisoned = {
    key: familyKey('fnote', MAMA, uuidN(7)),
    fields: {
      'pub.level': 'belegt', 'pub.alive': true, 'pub.date': '2026-07-07',
      'pub.repeatsYearly': false, 'pub.coEdit': null, 'pub.text': 'Scheidungsanwalt 14:30',
      _born: 'S',
    },
  };
  mount({ entries: [poisoned] });
  const body = open(build({ unshare: fakeDriver() }));
  assert.equal($$('.mod-row', body).length, 1, 'precondition: the row is listed');
  assert.equal(body.textContent.includes('Scheidungsanwalt'), false,
    'a Belegt row rendered a text the level does not disclose');
  assert.equal(JSON.stringify(settings.sharedEntries(regs(PEOPLE, [poisoned]), { me: ADMIN }))
    .includes('Scheidungsanwalt'), false, 'and the reader did not even carry it out of the map');
  unmount();
});

test('2c · MY OWN entries are not in the list, and the copy says where their control is', () => {
  de();
  mount();
  const body = open(build({ unshare: fakeDriver() }));
  assert.equal(rowFor(body, ENTRIES[3].key), null, 'my own entry is in the moderation list');
  assert.equal(rowKeys(body).some((k) => k.includes(ADMIN)), false);
  assert.includes(body.textContent, say(sharing.TXT.visibility),
    'the list must name where own entries ARE changed — „Sichtbarkeit", by identity');
  unmount();
});

test('2d · nothing that is not on a board is listed: privat, absent, and tombstoned', () => {
  de();
  const privat = {
    key: familyKey('fnote', MAMA, uuidN(11)),
    fields: { 'pub.level': 'privat', 'pub.alive': null, 'pub.date': null, 'pub.text': null },
  };
  const dead = {
    key: familyKey('fnote', MAMA, uuidN(12)),
    fields: {
      'pub.level': 'geteilt', 'pub.alive': false, 'pub.date': '2026-08-08',
      'pub.text': 'Gelöschter Eintrag', _born: 'S',
    },
  };
  const nothing = { key: familyKey('fbar', OMA, uuidN(13)), fields: { _born: 'S' } };
  mount({ entries: [privat, dead, nothing, ENTRIES[0]] });
  const body = open(build({ unshare: fakeDriver() }));
  assert.deepEqual(rowKeys(body), [ENTRIES[0].key],
    'only a live publication is on a board, and only a board entry can be taken off one');
  assert.equal(body.textContent.includes('Gelöschter Eintrag'), false);
  unmount();
});

test('2e · with nothing in the circle it says so about the CIRCLE, and asks no list to open', () => {
  de();
  mount({ entries: [ENTRIES[3]] });                  // only my own — nothing to moderate
  const body = build({ unshare: fakeDriver() });
  assert.includes(body.textContent, say(settings.MODERATION_COPY.empty));
  assert.equal($('.mod-list', body), null, 'an empty list is not a list');
  assert.equal($('.mod-toggle', body), null, 'nor a disclosure over nothing');
  // Principle 9: it may not report on anybody's private board.
  for (const w of ['niemand', 'keine Einträge', 'nobody', 'no entries']) {
    assert.equal(body.textContent.toLowerCase().includes(w.toLowerCase()), false,
      `the empty state made a claim about somebody's own board („${w}")`);
  }
  unmount();
});

test('2f · the rows are in BOARD order — by the day, never by when somebody published', () => {
  // An ordering by publication time is an activity feed with the timestamps filed off, which is
  // Principle 9's own „no presence indicators" one surface over (`membersui.js`'s 17.5 refusal).
  de();
  mount();
  const rows = settings.sharedEntries(regs(PEOPLE, ENTRIES), { me: ADMIN });
  assert.deepEqual(rows.map((r) => r.from), ['2026-03-02', '2026-05-14', '2026-06-01']);
  unmount();
});

test('2g · the owner is drawn with membersui.js’s OWN chip — one vocabulary, not two', () => {
  de();
  mount();
  const body = open(build({ unshare: fakeDriver() }));
  const chip = $('.member-chip', rowFor(body, ENTRIES[0].key));
  assert.ok(chip, 'the row does not say whose entry it is');
  assert.equal(chip.textContent, 'M', 'the initial is 17.2’s initial');
  assert.equal(chip.dataset.memberId, MAMA);
  assert.includes(rowFor(body, ENTRIES[0].key).textContent, 'Mama');
  // …and an owner the circle has never named still draws, neutrally, rather than throwing.
  const orphan = geteiltNote(memId(9), 21, { date: '2026-09-09', text: 'Von wem?' });
  unmount();
  mount({ entries: [orphan] });
  const b2 = open(build({ unshare: fakeDriver() }));
  assert.equal($('.member-chip', b2).textContent, '·', 'a nameless owner must not be guessed at');
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · THE BUTTON REACHES `unshare.js` WITH AN ENTITY KEY AND NOTHING ELSE
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('3a · press → confirm → `run(entityKey)`, one argument, and it is the row’s key', async () => {
  de();
  mount();
  const body = open(build({ unshare: fakeDriver() }));
  $('.mod-take', rowFor(body, ENTRIES[0].key)).click();
  assert.equal(scrims().length, 1, 'the confirmation did not open');
  confirmButton().click();
  await settle();

  assert.equal(RUNS.length, 1, `the driver was called ${RUNS.length} times`);
  assert.equal(RUNS[0].length, 1, 'the screen passed the driver more than the entity');
  assert.equal(RUNS[0][0], ENTRIES[0].key, 'and it must be exactly this row’s entity key');
  // There is no parameter through which content could enter — the arity IS the property
  // (`core/project.js:adminUnshareOp` is arity 2 and content-blind).
  assert.equal(typeof RUNS[0][0], 'string');
  unmount();
});

test('3b · cancelling calls nothing at all', async () => {
  de();
  mount();
  const body = open(build({ unshare: fakeDriver() }));
  $('.mod-take', rowFor(body, ENTRIES[1].key)).click();
  const foot = $('.scrim .sheet-foot');
  foot.firstElementChild.click();                    // „Abbrechen"
  await settle();
  assert.deepEqual(RUNS, [], 'a cancelled confirmation moderated something');
  assert.equal(scrims().length, 0, 'and „Abbrechen" left the sheet open');
  unmount();
});

test('3c · the result is reported in the DRIVER’s own words, honesty line included', async () => {
  de();
  mount();
  const body = open(build({ unshare: fakeDriver() }));
  $('.mod-take', rowFor(body, ENTRIES[0].key)).click();
  confirmButton().click();
  await settle();
  const said = toastText();
  assert.includes(said, unshare.UNSHARE_COPY.done.de, 'the screen summarised instead of reporting');
  // ⚠ ADR 002 §7.4's required downgrade sentence, on every landed outcome. It is
  // `sharing.js:TXT.downgradeNote` BY IDENTITY, through `unshare.js` — three surfaces, one string.
  assert.includes(said, unshare.UNSHARE_COPY.honesty.de);
  assert.equal(unshare.UNSHARE_COPY.honesty, sharing.TXT.downgradeNote,
    'the honesty sentence stopped being the same object as the owner’s own downgrade note');
  unmount();
});

test('3d · a driver that throws leaves one calm line and nothing half-done', async () => {
  de();
  mount();
  const body = open(build({ unshare: { run: () => Promise.reject(new Error('relay on fire')) } }));
  $('.mod-take', rowFor(body, ENTRIES[0].key)).click();
  confirmButton().click();
  await settle();
  assert.equal(toastText(), say(settings.MODERATION_COPY.failed));
  assert.equal(toastText().includes('relay on fire'), false, 'a stack trace reached the user');
  assert.equal(scrims().length, 1, 'the sheet closed over a failure the person must still see');
  scrims().forEach((n) => n.remove());
  unmount();
});

test('3e · THE SHIPPED DEFAULT IS WIRED — no injected driver reaches the real `createUnshare`', async () => {
  // The honest-path control for the whole file: every row above injects a driver, so every row
  // above would pass over a section whose default was `() => {}`. With no hook the section builds
  // `createUnshare()` — the real one, over the real store and the real (unmounted) engine — and it
  // answers with `unshare.js`'s own copy for a Mac with no engine, rather than throwing.
  de();
  mount();
  const body = open(build());                        // ← no hooks at all
  $('.mod-take', rowFor(body, ENTRIES[0].key)).click();
  confirmButton().click();
  await settle();
  const said = toastText();
  assert.ok(said.length > 0, 'the shipped default said nothing at all');
  const known = [
    unshare.UNSHARE_COPY.unreachable.de, unshare.UNSHARE_COPY.nothingShared.de,
    unshare.UNSHARE_COPY.noAdminChain.de, unshare.UNSHARE_COPY.notTheAdmin.de,
    unshare.UNSHARE_COPY.noKey.de, unshare.UNSHARE_COPY.done.de, unshare.UNSHARE_COPY.partial.de,
  ];
  assert.ok(known.some((k) => said.includes(k)),
    `the default driver answered outside UNSHARE_COPY: ${JSON.stringify(said)}`);
  scrims().forEach((n) => n.remove());
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · THE COPY — three claims, both languages, none of §7.4's four phrases
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Every string this section can produce, in one language, flattened. */
function everyString(lang) {
  const out = [];
  const walk = (v, name) => {
    if (typeof v === 'string') { out.push(v); return; }
    if (typeof v === 'function') { out.push(String(v('Mama', 'Privat'))); out.push(String(v(2))); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${name}.${k}`);
  };
  for (const [k, v] of Object.entries(settings.MODERATION_COPY)) walk(v[lang] ?? v, k);
  return out;
}

test('4a · every string exists in BOTH languages and the two differ', () => {
  for (const [key, pair] of Object.entries(settings.MODERATION_COPY)) {
    assert.ok(pair.de !== undefined && pair.en !== undefined, `${key} is missing a language`);
    const de_ = typeof pair.de === 'function' ? pair.de('Mama', 'Privat') : pair.de;
    const en_ = typeof pair.en === 'function' ? pair.en('Mama', 'Private') : pair.en;
    assert.ok(String(de_).trim().length > 0, `${key}.de is empty`);
    assert.ok(String(en_).trim().length > 0, `${key}.en is empty`);
    if (key !== 'noText') {
      assert.notEqual(String(de_), String(en_), `${key} was never translated`);
    }
  }
});

test('4b · none of ADR 002 §7.4’s four forbidden phrases, in either language, anywhere', () => {
  // `family/sharing.js:FORBIDDEN_CLAIMS`, and the sweep is over the COPY TABLE and over the
  // rendered section — a phrase that only appears once a row is drawn is still a phrase.
  de();
  mount();
  const rendered = [];
  for (const lang of ['de', 'en']) {
    i18n.setLang(lang);
    const body = open(build({ unshare: fakeDriver() }));
    rendered.push(body.textContent);
    rendered.push($$('[title]', body).map((n) => n.title).join(' '));
    // the confirmation's words too
    $('.mod-take', rowFor(body, ENTRIES[0].key)).click();
    rendered.push($('.scrim').textContent);
    scrims().forEach((n) => n.remove());
    rendered.push(...everyString(lang));
  }
  for (const claim of sharing.FORBIDDEN_CLAIMS) {
    for (const s of rendered) {
      assert.equal(String(s).toLowerCase().includes(claim.toLowerCase()), false,
        `ADR 002 §7.4 forbids „${claim}" and it is on this screen: ${JSON.stringify(String(s).slice(0, 120))}`);
    }
  }
  unmount();
});

test('4c · the confirmation carries all three claims before the button, in both languages', () => {
  mount();
  for (const [lang, words] of [
    ['de', { privat: 'Privat', keeps: 'behält', notice: 'keine Nachricht' }],
    ['en', { privat: 'Private', keeps: 'keeps', notice: 'no message' }],
  ]) {
    i18n.setLang(lang);
    const body = open(build({ unshare: fakeDriver() }));
    $('.mod-take', rowFor(body, ENTRIES[0].key)).click();
    const sheet = $('.scrim');
    const text = sheet.textContent;
    // 1 · IT REVERTS — and it names the level word the owner will see, from the glossary.
    assert.includes(text, words.privat);
    assert.includes(text, 'Mama');
    // 2 · IT IS NEVER DELETED
    assert.includes(text, words.keeps);
    // 3 · NOBODY IS NOTIFIED
    assert.includes(text, words.notice);
    // …and §7.4's honesty, last.
    assert.includes(text, unshare.UNSHARE_COPY.honesty[lang]);
    // The confirm button is NOT the danger button: this is the one family act that reverses.
    assert.equal(confirmButton().classList.contains('btn-danger'), false,
      'a red button says „this cannot be undone" about the one act that can be');
    scrims().forEach((n) => n.remove());
  }
  unmount();
});

test('4d · the screen never says a word that would shame the owner or claim more than happened', () => {
  de();
  mount();
  const body = open(build({ unshare: fakeDriver() }));
  $('.mod-take', rowFor(body, ENTRIES[0].key)).click();
  const all = `${body.textContent} ${$('.scrim').textContent} `
    + `${$$('[title]', body).map((n) => n.title).join(' ')}`;
  for (const w of ['Verstoß', 'unangemessen', 'melden', 'Warnung', 'sperren', 'gelöscht bei', 'für immer']) {
    assert.equal(all.includes(w), false, `moderation vocabulary („${w}") reached the screen`);
  }
  scrims().forEach((n) => n.remove());
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · WHAT THE OWNER SEES — the byte-identity property, on screen
//
// ⚠ THIS MAC IS NOW THE OWNER. ADR 004 §5.1: the owner's own „→ Privat" and the admin's unshare
// produce byte-identical wire bytes, "so a peer cannot tell which happened — Principle 9 by the
// absence of a distinguishing byte" (finding E7-6). The place that property is actually AT RISK
// is not the wire, which tier 1 pins over 23 rows; it is a board that draws a moderated entry
// differently from one its owner made private. So both paths are driven here, on this Mac, and
// the two results are diffed as a person would see them.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const SPACE = 'fsp_0123456789abcdefghijkl';
const PAPA = 'mem_PPPPPPPPPPPPPPPPPPPPPP';
const PAPA_DEV = 'dev_PPPPPPPPPPPPPPPPPPPPPP';
const PAPA_SHORT = 'PPPPPPPPPPPPPPPP';

const utf8 = (s) => new TextEncoder().encode(s);
const blobFor = (att) => `${b64u(utf8(canonicalJSON(att)))}.${b64u(utf8('signature'))}`;

store.useFamilySpace(SPACE);
const ME = store.diagnostics().identity.memberId;
const MY = store.diagnostics().identity;

store.setAttestOpen((_m, b) => parseAttestationBlob(b));
store.apply('attestMyDevice', {
  deviceShort: MY.deviceShort,
  blob: blobFor({
    memberId: ME, deviceId: MY.deviceId, deviceShort: MY.deviceShort,
    sigPubRaw: b64u(utf8('mamasig')), kexPubRaw: b64u(utf8('mamakex')), createdAt: '2026-08-25',
  }),
});
store.apply('setMyProfile', { displayName: 'Mama', colorRef: 'palette-3' });

/** Papa: his own HLC, his own device, his ops through the real `makeOp` and `applyRemote`. */
const papa = (() => {
  let n = 0;
  const clock = createClock(PAPA_SHORT, () => Date.now() + 60_000);
  const ctx = {
    act: PAPA, dev: PAPA_DEV, gid: 'D'.repeat(22), space: 'personal', familySpaceId: SPACE,
    mint: () => clock.tick(), newOpId: () => `us${String(++n).padStart(20, '0')}`,
  };
  return { ctx: () => ({ ...ctx }), op: (k, e, f) => makeOp(ctx, k, e, f, {}) };
})();

{
  const att = blobFor({
    memberId: PAPA, deviceId: PAPA_DEV, deviceShort: PAPA_SHORT,
    sigPubRaw: b64u(utf8('sigP')), kexPubRaw: b64u(utf8('kexP')), createdAt: '2026-08-25',
  });
  const r = store.applyRemote([
    papa.op('member.set', `member:${PAPA}`, { [`dev.${PAPA_SHORT}`]: att }),
    papa.op('member.set', `member:${PAPA}`, { displayName: 'Papa', colorRef: 'palette-1' }),
    papa.op('space.set', `space:${SPACE}`, { admin: PAPA, adminPrev: null, name: 'Familie' }),
  ]);
  if (r.applied.length !== 3) throw new Error(`the circle did not form: ${JSON.stringify(r)}`);
}

let seq = 0;
const mkId = () => `un53${String(++seq).padStart(4, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`;
const opMark = () => store._log.lines().length;
const opsSince = (m) => store._log.lines().slice(m).map((l) => l.op);
const noteNode = (id) => $(`.board .note[data-note-id="${CSS.escape(id)}"]`);

/** Create a note, share it, and hand back its uuid + family key. */
async function shared(date, text) {
  const uuid = mkId();
  store.apply('createNoteInline', {
    id: uuid, date, text, categoryId: store.state.categories[0].id,
  });
  store.txn('share', (tx) => tx.note(uuid).set({ visibility: 'geteilt' }));
  await settle();
  return { uuid, key: familyKey('fnote', ME, uuid) };
}

/**
 * EVERYTHING THE OWNER CAN PERCEIVE ABOUT ONE OF HER OWN NOTES — the projected entry, the node's
 * classes, its tooltip, its children's classes, its data attributes.
 *
 * Nothing is filtered here. The two entries in §5b are written on the SAME DAY with the SAME TEXT
 * in the SAME CATEGORY, so they differ in exactly six fields — `id`, `uuid`, `entityKey`, `_born`,
 * `createdAt`, `updatedAt` — three names and three clock readings. Every one of them differs
 * between ANY two entries in the product, including two nobody has ever shared, so none of them
 * can tell a reader which route made this entry private. The test asserts the difference is
 * exactly that set rather than excluding fields quietly: a SEVENTH differing key is a
 * distinguishing mark and must fail here.
 */
function asSeen(uuid) {
  const e = store.state.notes.find((n) => n.id === uuid) || null;
  const node = noteNode(uuid);
  return {
    entry: e ? { ...e } : null,
    onBoard: !!node,
    className: node ? node.className : null,
    marks: node ? $$('*', node).map((n) => n.className).join('|') : null,
    title: node ? node.getAttribute('title') : null,
    data: node ? JSON.stringify(Object.fromEntries(Object.entries(node.dataset)
      .filter(([k]) => !['noteId', 'date', 'id'].includes(k)))) : null,
  };
}

/** Which keys of two entry projections hold different values. */
function differingKeys(a, b) {
  const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])];
  return keys.filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])).sort();
}

test('5a · the two paths produce the same wire bytes — restated where the screen can see it', async () => {
  de();
  const a = await shared('2027-02-10', 'Gleicher Text');
  const mark = opMark();
  store.txn('privat', (tx) => tx.note(a.uuid).set({ visibility: 'privat' }));
  await settle();
  const mine = opsSince(mark).filter((o) => o.space === SPACE && o.k === 'pub.set' && o.e === a.key);
  assert.equal(mine.length, 1, `the owner's own downgrade emitted ${mine.length} family ops`);

  const b = await shared('2027-02-17', 'Gleicher Text');
  const theirs = adminUnshareOp(papa.ctx(), { kind: 'fnote', owner: ME, uuid: b.uuid });

  assert.deepEqual(mine[0].f, theirs.f,
    'ADR 004 §5.1: the owner’s „→ Privat" and the admin’s unshare must be the same bytes');
  assert.equal(canonicalJSON(mine[0].f), canonicalJSON(theirs.f));
});

test('5b · ⚠ THE OWNER’S BOARD CANNOT TELL WHICH HAPPENED', async () => {
  de();
  // One entry the owner made private herself, one an admin took out of the circle. Same text,
  // same category, same level afterwards; only the ROUTE differs.
  // THE SAME DAY, deliberately: two notes on one square, identical in every authored field, so
  // the only thing that can possibly differ between them afterwards is the route each one took.
  const a = await shared('2027-03-03', 'Identischer Eintrag');
  store.txn('privat', (tx) => tx.note(a.uuid).set({ visibility: 'privat' }));
  await settle();

  const b = await shared('2027-03-03', 'Identischer Eintrag');
  const r = store.applyRemote([adminUnshareOp(papa.ctx(), { kind: 'fnote', owner: ME, uuid: b.uuid })]);
  assert.equal(r.refused.length, 0, `the moderation was refused: ${JSON.stringify(r.refused)}`);
  await settle();

  // Both are back to owner-private, and both are still THERE — 18.3's "never deleted".
  assert.equal(store.registers().get(`note:${b.uuid}`).get('visibility').value, 'privat',
    'ADR 004 §5: the owner’s own visibility must follow the moderation');
  const A = asSeen(a.uuid);
  const B = asSeen(b.uuid);
  diag('DIFF', differingKeys(A.entry, B.entry));

  // ── THE PROJECTION: identical in every field but the entry's own identity ────────────────
  assert.deepEqual(differingKeys(A.entry, B.entry),
    ['_born', 'createdAt', 'entityKey', 'id', 'updatedAt', 'uuid'],
    'the owner’s entry carries a field that says WHICH ROUTE made it private');
  // Named individually, because these are the ones somebody would reach for if they wanted to
  // build the „von der Verwaltung entfernt" label this product must not have.
  for (const k of ['visibility', 'level', 'exposure', 'redacted', 'text', 'coEdit',
    'isForeign', 'memberColorRef', 'initial', 'isNew', 'updatedBy']) {
    assert.equal(JSON.stringify(A.entry[k]), JSON.stringify(B.entry[k]),
      `the moderated entry differs from the self-made-private one at \`${k}\``);
  }
  // ── AND THE PIXELS: same classes, same tooltip, same children, same data attributes ──────
  for (const k of ['onBoard', 'className', 'marks', 'title', 'data']) {
    assert.equal(A[k], B[k], `the moderated entry's node differs at \`${k}\``);
  }
  assert.equal(asSeen(b.uuid).onBoard, true, 'and the moderated entry is still on her board');
  assert.equal(store.state.notes.find((n) => n.id === b.uuid).text, 'Identischer Eintrag',
    'in full, and unchanged');
});

test('5c · and the document says nothing about it — no marker, no notice, no name', () => {
  // Principle 9 / ADR 004 §7: there is no op kind that could carry a notification, and there must
  // be no pixel that carries one either. This is the sweep on the OWNER's side of the moderation
  // this file just performed.
  const doc = `${document.body.textContent} ${$$('[title]').map((n) => n.title).join(' ')}`;
  for (const w of ['entfernt', 'Verwaltung hat', 'Verwalter hat', 'moderiert', 'removed by',
    'Papa hat', 'zurückgenommen']) {
    assert.equal(doc.includes(w), false, `Principle 9: „${w}" appeared on the owner’s screen`);
  }
  assert.equal($('.lzp-conflict'), null, '18.5’s lost-edit notice must never fire for a moderation');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 · AND THE OWNER'S NEXT KEYSTROKE STILL DOES NOT RE-SHARE IT
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('6 · after the button’s op lands, an ordinary edit does not put the text back on the wire', async () => {
  // E9 closed this (`adminUnshareFollowUp`, called from `store.applyRemote`) and it is the half
  // that had no caller. The button must not reopen it: re-asserted here because THIS package is
  // the one that made the op reachable from a screen.
  de();
  const b = await shared('2027-04-04', 'Konzert');
  store.applyRemote([adminUnshareOp(papa.ctx(), { kind: 'fnote', owner: ME, uuid: b.uuid })]);
  await settle();
  assert.equal(store.registers().get(b.key).get('pub.level').value, 'privat', 'precondition');

  const mark = opMark();
  store.apply('editNoteInline', { id: b.uuid, text: 'Konzert — verschoben' });
  await settle();

  assert.equal(store.registers().get(b.key).get('pub.level').value, 'privat',
    'the owner’s next keystroke re-shared a moderated entry');
  assert.equal(store.registers().get(b.key).get('pub.text').value, null,
    'and it put the withdrawn text back on the wire');
  const republished = opsSince(mark)
    .filter((o) => o.space === SPACE && o.e === b.key && o.f && o.f['pub.level'] === 'geteilt');
  assert.deepEqual(republished, [], 'a Geteilt patch was re-derived after the moderation');
  assert.equal(store.state.notes.find((n) => n.id === b.uuid).text, 'Konzert — verschoben',
    'and the owner’s own edit went through on her own board, as it must');
});
