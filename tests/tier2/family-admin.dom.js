// TIER 2 · the admin panel and F20's four irreversible moments — LZP-605/606/607.
// Stories 20.1–20.5, addendum deliverable 22, ADR 002 §7.1 (D9) and §7.4.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE IS ACTUALLY GUARDING
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Most of the panel is buttons, and buttons are cheap to test and cheap to get right. The two
// things that are neither are the reason this file exists:
//
//   1. **THE SENTENCES.** The addendum's F20 note is "removal/leave confirmations must state the
//      consequences of 20.2/20.3 in one plain sentence", and §6 adds the honesty the design
//      demands — *unsharing is not unremembering*. A confirmation that has quietly lost its
//      second clause still opens, still looks right, and is a promise the product cannot keep.
//      §3 and §5 assert the actual clauses, in BOTH languages, out of `consequencesOf()` — which
//      is pure precisely so this can be asserted rather than eyeballed.
//
//   2. **20.5, WHICH IS A CLAIM ABOUT WHAT IS *NOT* ON SCREEN.** "Even as admin I structurally
//      cannot see other members' private entries." No test can prove a negative about copy that
//      does not exist yet, so §4 does the two things that are checkable: the sentence that says so
//      IS rendered (in both languages), and every string the module can render is swept for the
//      words that would contradict it.
//
// The relay is a fake, injected through `initAdminPanel({ arm })` — the same port the shipped
// panel uses — so there is no seam code in the product and no `window.__lzpAdmin` for a page
// script to reach. §0 keeps that true. What is REAL here is the engine, the DOM, `ui.js`'s sheet,
// `app.css` and `i18n.js`'s language switch.

const admin = await importApp('family/adminpanel.js');
const lifecycle = await importApp('family/leavedelete.js');
const ui = await importApp('ui.js');
const i18n = await importApp('i18n.js');
const createjoin = await importApp('family/createjoin.js');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 0 · scaffolding
// ═════════════════════════════════════════════════════════════════════════════════════════════

const SPACE = 'fsp_0123456789abcdefghijkm';
const ME = 'mem_me00000000000000000000';
const MAMA = 'mem_mama0000000000000000000';
const PAPA = 'mem_papa0000000000000000000';

function circleOf(over = {}) {
  return {
    spaceId: SPACE,
    name: 'Familie Weber',
    role: 'admin',
    memberId: ME,
    displayName: 'Manuel',
    colorRef: 'violett',
    keysPending: false,
    origin: 'https://relay.example',
    joinedAt: '2026-08-01',
    ...over,
  };
}

function membersOf(rows) {
  return {
    supported: true,
    me: ME,
    adminId: ME,
    keysPending: false,
    members: rows || [
      { memberId: ME, displayName: 'Manuel', colorRef: 'violett', initial: 'M', alive: true, isMe: true, isAdmin: true, hidden: false },
      { memberId: MAMA, displayName: 'Mama', colorRef: 'magenta', initial: 'M', alive: true, isMe: false, isAdmin: false, hidden: false },
      { memberId: PAPA, displayName: 'Papa', colorRef: 'gruen', initial: 'P', alive: true, isMe: false, isAdmin: false, hidden: false },
    ],
  };
}

/**
 * The relay, as a log of what was asked of it. Every reply is a `{status, json}`, which is
 * `platform/net.js`'s Transport shape and the only thing the panel knows about a network.
 */
function fakeRelay(over = {}) {
  const calls = [];
  const replies = {
    'GET /api/v1/invites/open': () => ({ status: 200, json: { spaceId: SPACE, invites: [
      { inviteId: 'aaaaaaaaaaaaaaaaaaaaaa', epoch: 1, createdBy: ME, expiresAt: new Date(Date.now() + 3 * 86400000).toISOString() },
    ] } }),
    'POST /api/v1/invites': () => ({ status: 200, json: { inviteId: 'x', spaceId: SPACE, epoch: 1, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() } }),
    'POST /api/v1/invites/revoke': () => ({ status: 200, json: { state: 'revoked' } }),
    'POST /api/v1/members/remove': () => ({ status: 200, json: {
      spaceId: SPACE, removed: true, alreadyRemoved: false, purgedOps: 12, purgedWraps: 3,
      revokedDevices: 1, revokedInvites: 0, currentEpoch: 1,
      rotateRequired: true, alreadyDeliveredIsIrrevocable: true,
    } }),
    'POST /api/v1/members/leave': () => ({ status: 200, json: {
      spaceId: SPACE, left: true, alreadyLeft: false, spaceDeleted: false,
      rotateRequired: true, alreadyDeliveredIsIrrevocable: true,
    } }),
    'POST /api/v1/members/transfer': () => ({ status: 200, json: {
      spaceId: SPACE, authoritative: false, stored: 'nothing', rotateRequired: false,
    } }),
    [`POST /api/v1/spaces/${SPACE}/rename`]: () => ({ status: 200, json: { renamed: false, stored: 'nothing' } }),
    [`POST /api/v1/spaces/${SPACE}/delete`]: () => ({ status: 200, json: {
      spaceId: SPACE, deleted: true, purged: { members: 3, devices: 3, openInvites: 1, headSeq: '42' },
      localBoardsUnaffected: true,
    } }),
    ...over,
  };
  return {
    calls,
    transport: {
      async request(method, path, query, body) {
        calls.push({ method, path, query, body });
        const fn = replies[`${method} ${path}`];
        if (!fn) return { status: 404, json: { error: 'not_found' } };
        return fn(body);
      },
    },
  };
}

let sheet = null;
let clipped = [];
let settingsWrites = [];
let reloaded = 0;

/** Mount the panel in a real settings sheet over a fake relay. Returns the relay. */
function mount({ circle = circleOf(), members = membersOf(), relay = fakeRelay(), lang = 'de' } = {}) {
  i18n.setLang(lang);
  clipped = [];
  settingsWrites = [];
  reloaded = 0;
  admin.initAdminPanel({
    circle: () => circle,
    members: () => members,
    arm: async () => relay.transport,
    clipboard: (text) => { clipped.push(text); return Promise.resolve(); },
    setSettings: (patch) => { settingsWrites.push(patch); },
    persist: () => Promise.resolve(),
    reload: () => { reloaded += 1; },
    now: () => Date.now(),
  });
  sheet = ui.openSheet({
    title: 'Einstellungen',
    build: (body, api) => admin.buildAdminSection(body, api),
  });
  return relay;
}

function unmount() {
  while (ui.anySheetOpen()) ui.closeTopSheet();
  for (const s of $$('.scrim')) s.remove();
  admin.initAdminPanel();
  sheet = null;
}

const sheetText = () => ($('.sheet-body') ? $('.sheet-body').textContent : '');
const titles = () => $$('.sheet .section-title').map((n) => n.textContent);
const buttons = () => $$('.sheet button').map((b) => b.textContent);
const memberRows = () => $$('.sheet [data-member]');

/** The topmost sheet — a confirmation opens on top of the settings sheet. */
const topSheet = () => $$('.scrim').slice(-1)[0];
const topText = () => (topSheet() ? topSheet().querySelector('.sheet-body').textContent : '');
const topButtons = () => (topSheet() ? [...topSheet().querySelectorAll('.sheet-foot button')] : []);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §0 · no back door
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the module exposes nothing on window — the relay arrives through the port or not at all', () => {
  const leaked = Object.keys(globalThis).filter((k) => /admin|lifecycle|leavedelete/i.test(k));
  assert.deepEqual(leaked, [], `a global leaked: ${leaked.join(', ')}`);
  assert.equal(typeof admin.buildAdminSection, 'function');
  assert.equal(typeof admin.initAdminPanel, 'function');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · Principle 7 / story 15.1 — a Mac in no circle sees nothing
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('solo silence — with no Familienkreis the section draws not one node', () => {
  // The paired PRESENCE is the next test: an absence asserted alone passes on a module that
  // does nothing at all.
  admin.initAdminPanel({ circle: () => null, members: () => ({ supported: false, members: [] }) });
  const api = ui.openSheet({ title: 'x', build: (b, a) => admin.buildAdminSection(b, a) });
  assert.equal($('.sheet-body').childElementCount, 0, 'a solo Mac was shown an admin panel');
  assert.equal(sheetText().trim(), '');
  api.close();
  unmount();
});

test('…and with a circle the same call draws the four headings', () => {
  mount();
  const t = titles();
  assert.equal(t.length, 4, `expected four sections, got ${JSON.stringify(t)}`);
  assert.includes(t[0], 'Kreis verwalten');
  assert.includes(t[1], 'Mitglieder');
  assert.includes(t[2], 'Einladungen');
  assert.includes(t[3], 'Nicht rückgängig');
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · the member list carries ROLES, and the remove button is never on my own row (20.1/20.2)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('three members, three rows, admin first, and every row names its role', () => {
  mount();
  const rows = memberRows();
  assert.equal(rows.length, 3);
  assert.equal(rows[0].dataset.member, ME, 'the admin is not first');
  assert.includes(rows[0].textContent, 'Verwalter');
  assert.includes(rows[0].textContent, 'du');
  assert.includes(rows[1].textContent, 'Mitglied');
  unmount();
});

test('„Entfernen" appears on the OTHER rows and never on mine — 20.2 is not 20.3', () => {
  mount();
  const rows = memberRows();
  const has = (r) => [...r.querySelectorAll('button')].some((b) => b.textContent === 'Entfernen');
  assert.equal(has(rows[0]), false, 'the admin was offered a remove button on their own row');
  assert.equal(has(rows[1]), true);
  assert.equal(has(rows[2]), true);
  // …and the way out for yourself exists, once, under the danger heading.
  assert.equal(buttons().filter((b) => b === 'Kreis verlassen').length, 1);
  unmount();
});

test('a member whose name has not folded yet is SHOWN, not hidden — D9 seen from an old Mac', () => {
  mount({ members: membersOf([
    { memberId: ME, displayName: 'Manuel', colorRef: 'violett', initial: 'M', alive: true, isMe: true, isAdmin: true },
    { memberId: MAMA, displayName: null, colorRef: 'magenta', initial: '·', alive: true, isMe: false, isAdmin: false },
  ]) });
  assert.equal(memberRows().length, 2, 'the newest arrival was hidden from the circle she just joined');
  assert.includes(sheetText(), 'Name noch nicht angekommen');
  unmount();
});

test('a non-admin gets the list and the way out, and none of the four admin verbs', () => {
  mount({ circle: circleOf({ role: 'member' }) });
  const b = buttons();
  assert.equal(b.includes('Entfernen'), false);
  assert.equal(b.includes('Kreis löschen'), false);
  assert.equal(b.includes('Rolle übergeben'), false);
  assert.equal($('.sheet input[type="text"]'), null, 'a non-admin could rename the circle');
  assert.equal(b.includes('Kreis verlassen'), true, '20.3 is everybody’s');
  assert.equal(titles().includes('EINLADUNGEN') || titles().includes('Einladungen'), false,
    'a non-admin was shown invite management');
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · invites — D9 on the wire (15.2, 15.5, ADR 002 §7.1)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('minting sends an inviteId and a verifier and NO key material, and copies the invitation', async () => {
  const relay = mount();
  await waitFor(() => $$('.sheet [data-invite]').length > 0, { what: 'the open invites to load' });

  $$('.sheet button').find((b) => b.textContent === 'Einladung erstellen').click();
  await waitFor(() => relay.calls.some((c) => c.path === '/api/v1/invites' && c.method === 'POST'),
    { what: 'the mint call' });

  const mint = relay.calls.find((c) => c.path === '/api/v1/invites' && c.method === 'POST');
  assert.deepEqual(Object.keys(mint.body).sort(), ['inviteId', 'spaceId', 'verifier']);
  // PO decision D9, asserted on the WIRE rather than in a comment: nothing on this request could
  // decrypt anything, and the raw code is not on it either.
  for (const forbidden of ['wrappedKeys', 'wrapped', 'wrapSalt', 'code', 'proof', 'key']) {
    assert.equal(forbidden in mint.body, false, `an invite carried ${forbidden}`);
  }
  assert.match(mint.body.inviteId, /^[A-Za-z0-9_-]{22}$/);

  await waitFor(() => clipped.length > 0, { what: 'the invitation on the clipboard' });
  // The code on the clipboard must be the code the derivation was made from — the failure this
  // guards is „der Code passt nicht" on a correctly typed code.
  const code = clipped[0].split('\n').find((line) => /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(line));
  assert.ok(code, `no XXXX-XXXX-XXXX line in the invitation:\n${clipped[0]}`);
  const derived = await createjoin.deriveInvite(code);
  assert.equal(derived.inviteId, mint.body.inviteId, 'the pasted code derives a different invite');
  assert.equal(derived.verifier, mint.body.verifier);
  unmount();
});

test('the invite section states D9 — no keys, and it resolves itself — and never asks for an action', () => {
  mount();
  const text = sheetText();
  assert.includes(text, 'Der Code allein öffnet nichts');
  assert.includes(text, 'Schlüssel trägt er keine');
  assert.includes(text, 'Das geschieht von selbst.');
  // The forbidden shape: a button that implies somebody is stranded until it is pressed.
  for (const b of buttons()) {
    assert.equal(/schlüssel senden|send keys|freischalten|unlock/i.test(b), false,
      `a "hand the keys over" button appeared: ${b}`);
  }
  // …and nothing tells the admin to go and open somebody's laptop.
  assert.equal(/laptop|aufklappen|bitte .* öffnen/i.test(text), false);
  unmount();
});

test('an open invite can be revoked, and the list reloads from the relay afterwards', async () => {
  const relay = mount();
  await waitFor(() => $$('.sheet [data-invite]').length > 0, { what: 'the invite list' });
  const row = $('.sheet [data-invite]');
  assert.includes(row.textContent, 'läuft in 3 Tagen ab');
  assert.includes(row.textContent, 'von dir');
  [...row.querySelectorAll('button')].find((b) => b.textContent === 'Zurückziehen').click();
  await waitFor(() => relay.calls.some((c) => c.path === '/api/v1/invites/revoke'), { what: 'the revoke call' });
  const rv = relay.calls.find((c) => c.path === '/api/v1/invites/revoke');
  assert.deepEqual(Object.keys(rv.body).sort(), ['inviteId', 'spaceId']);
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · 20.5 — the admin role is not a viewing seat, and the panel says so
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the panel states 20.5 and F20’s first line, in German AND in English', () => {
  mount();
  assert.includes(sheetText(), 'Der Verwalter verwaltet den Kreis, nicht die Menschen darin.');
  assert.includes(sheetText(), 'Das verhindert die Verschlüsselung, keine Regel.');
  unmount();

  mount({ lang: 'en' });
  assert.includes(sheetText(), 'The admin manages the circle, never the people in it.');
  assert.includes(sheetText(), 'Encryption prevents that, not a rule.');
  unmount();
  i18n.setLang('de');
});

test('no string this module can render implies the admin can see what was not shared', () => {
  // The sweep is over the COPY rather than over one render, because a sentence that only appears
  // in a rare branch is exactly the one nobody screenshots. Both languages, every leaf.
  const leaves = [];
  const walk = (v) => {
    if (typeof v === 'string') leaves.push(v);
    else if (typeof v === 'function') { try { leaves.push(String(v('X'))); } catch { /* arity */ } }
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k]);
  };
  walk(admin.ADMIN_COPY);
  walk(lifecycle.LIFECYCLE_COPY);
  assert.ok(leaves.length > 60, `the walker stopped working: ${leaves.length} strings`);

  const forbidden = [
    /alle einträge (der|von) (anderen|allen)/i,
    /einsehen|einsicht in .* einträge/i,
    /see (all|everyone'?s) entries/i,
    /read (their|everyone'?s) private/i,
    /überwach|monitor|surveil/i,
  ];
  for (const s of leaves) {
    for (const re of forbidden) {
      assert.equal(re.test(s), false, `20.5 contradicted by: ${JSON.stringify(s)}`);
    }
  }
});

test('handing the role over says out loud that it changes nobody’s visibility', () => {
  for (const l of ['de', 'en']) {
    const lines = lifecycle.consequencesOf('transfer', l, { name: 'Papa' });
    assert.ok(lines.length >= 2);
    assert.match(lines[1], l === 'de' ? /wer was sehen kann/ : /who can see what/);
    assert.match(lines[1], l === 'de' ? /liest ihn nicht/ : /does not read it/);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · THE CONFIRMATIONS — the deliverable (20.2, 20.3, 20.4)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('20.2 — the removal sentence says both halves, in both languages', () => {
  const de = lifecycle.consequencesOf('remove', 'de', { name: 'Mama' });
  assert.includes(de[0], 'Mama');
  assert.includes(de[0], 'verschwinden von allen Familien-Boards');
  assert.includes(de[0], 'Zugang zum Kreis endet sofort');
  // The clause the story ends on, and the reason it is true.
  assert.includes(de[0], 'bleiben unberührt');
  assert.includes(de[0], 'denn sie waren nie bei uns');

  const en = lifecycle.consequencesOf('remove', 'en', { name: 'Mom' });
  assert.includes(en[0], 'leave every family board');
  assert.includes(en[0], 'access to the circle ends immediately');
  assert.includes(en[0], 'because they were never ours');
});

test('20.3 — the leave sentence promises that nobody loses their OWN data', () => {
  const de = lifecycle.consequencesOf('leave', 'de', {});
  assert.includes(de[0], 'wieder privat');
  assert.includes(de[0], 'bleiben bei dir');
  assert.includes(de[0], 'verliert niemand seine eigenen Daten');
  const en = lifecycle.consequencesOf('leave', 'en', {});
  assert.includes(en[0], 'revert to private and stay with you');
  assert.includes(en[0], 'nobody ever loses their own data by leaving');
});

test('20.4 — the delete sentence promises a fully intact solo board for everybody', () => {
  const de = lifecycle.consequencesOf('delete', 'de', { space: 'Familie Weber' });
  assert.includes(de[0], 'vollständig intaktes Board');
  assert.includes(de[0], 'niemand verliert einen einzigen eigenen Eintrag');
  const en = lifecycle.consequencesOf('delete', 'en', { space: 'Weber' });
  assert.includes(en[0], 'fully intact');
  assert.includes(en[0], 'nobody loses a single entry of their own');
});

test('addendum §6 — EVERY confirmation carries "unsharing is not unremembering"', () => {
  // The one line the design specifically demands and the easiest one to lose in an edit.
  for (const kind of ['remove', 'leave', 'delete', 'transfer']) {
    for (const l of ['de', 'en']) {
      const lines = lifecycle.consequencesOf(kind, l, { name: 'Mama', space: 'Familie Weber' });
      assert.ok(lines.length >= 2, `${kind}/${l} lost its second line`);
    }
  }
  for (const kind of ['remove', 'leave']) {
    assert.includes(lifecycle.consequencesOf(kind, 'de', { name: 'Mama' })[1],
      'Geteiltes lässt sich zurücknehmen, Gesehenes nicht.');
    assert.includes(lifecycle.consequencesOf(kind, 'en', { name: 'Mom' })[1],
      'having been seen cannot');
  }
  // And nothing anywhere claims the removal reaches into the other Mac.
  for (const kind of ['remove', 'leave']) {
    for (const l of ['de', 'en']) {
      for (const line of lifecycle.consequencesOf(kind, l, { name: 'Mama' })) {
        assert.equal(/gelöscht von ihrem mac|wiped from their mac|deleted from their mac/i.test(line), false,
          `${kind}/${l} promises more than the system does: ${line}`);
      }
    }
  }
});

test('leaving as the last one out, and leaving as the admin, each add their own line', () => {
  const plain = lifecycle.consequencesOf('leave', 'de', {});
  const asAdmin = lifecycle.consequencesOf('leave', 'de', { isAdmin: true });
  const lastOut = lifecycle.consequencesOf('leave', 'de', { isAdmin: true, lastOneOut: true });
  assert.equal(plain.length, 2);
  assert.equal(asAdmin.length, 3);
  assert.includes(asAdmin[2], 'Übergib die Rolle vorher');
  assert.equal(lastOut.length, 3);
  assert.includes(lastOut[2], 'Mit dir wird auch der Kreis auf dem Server gelöscht.');
});

test('the removal confirmation OPENS on the sentence and only then calls the relay', async () => {
  const relay = mount();
  const rows = memberRows();
  [...rows[1].querySelectorAll('button')].find((b) => b.textContent === 'Entfernen').click();

  assert.includes(topText(), 'verschwinden von allen Familien-Boards');
  assert.includes(topText(), 'Geteiltes lässt sich zurücknehmen');
  assert.equal(relay.calls.some((c) => c.path === '/api/v1/members/remove'), false,
    'the relay was called before anybody confirmed');

  const confirm = topButtons().find((b) => b.textContent === 'Entfernen');
  assert.ok(confirm, `no confirm button: ${topButtons().map((b) => b.textContent)}`);
  confirm.click();
  await waitFor(() => relay.calls.some((c) => c.path === '/api/v1/members/remove'), { what: 'the removal' });
  const rm = relay.calls.find((c) => c.path === '/api/v1/members/remove');
  assert.deepEqual(rm.body, { spaceId: SPACE, memberId: MAMA });
  unmount();
});

test('cancelling a removal calls nothing at all', () => {
  const relay = mount();
  [...memberRows()[1].querySelectorAll('button')].find((b) => b.textContent === 'Entfernen').click();
  topButtons().find((b) => b.textContent === i18n.t('cancel')).click();
  assert.equal(relay.calls.some((c) => c.path === '/api/v1/members/remove'), false);
  unmount();
});

test('20.4 — the delete is gated on typing the circle’s NAME, and the wire carries the ID', async () => {
  const relay = mount();
  $$('.sheet button').find((b) => b.textContent === 'Kreis löschen').click();
  assert.includes(topText(), 'Tippe den Namen des Kreises');

  const go = topButtons().find((b) => b.textContent === 'Endgültig löschen');
  go.click();                                    // empty field
  assert.equal(relay.calls.some((c) => /delete/.test(c.path)), false, 'an empty field deleted the circle');

  const input = topSheet().querySelector('input[type="text"]');
  input.value = 'familie weber';                 // right letters, wrong circle
  go.click();
  assert.equal(relay.calls.some((c) => /delete/.test(c.path)), false, 'a case-folded name deleted the circle');

  input.value = 'Familie Weber';
  go.click();
  await waitFor(() => relay.calls.some((c) => /delete/.test(c.path)), { what: 'the delete' });
  const del = relay.calls.find((c) => /delete/.test(c.path));
  // The human types the name; the relay is told the id, which is what `handlers/lifecycle.js`
  // requires (`confirm === spaceId`).
  assert.deepEqual(del.body, { confirm: SPACE });
  unmount();
});

test('20.3 — leaving clears the circle from THIS Mac and touches nothing else', async () => {
  const relay = mount();
  $$('.sheet button').find((b) => b.textContent === 'Kreis verlassen').click();
  assert.includes(topText(), 'verliert niemand seine eigenen Daten');
  topButtons().find((b) => b.textContent === 'Verlassen').click();
  await waitFor(() => relay.calls.some((c) => c.path === '/api/v1/members/leave'), { what: 'the leave' });
  await waitFor(() => reloaded > 0, { what: 'the reload' });

  const patch = Object.assign({}, ...settingsWrites);
  assert.equal(patch[createjoin.CIRCLE_PREFS.space], '', 'the circle survived the leave');
  assert.equal(patch[createjoin.CIRCLE_PREFS.pending], false, 'a Mac that left is still waiting for keys');
  // The origin is SHARED with the personal space (19.4). Clearing it here would unpair somebody's
  // second Mac as a side effect of leaving a family circle.
  assert.equal(createjoin.CIRCLE_PREFS.origin in patch, false, 'leaving the circle unpaired my own Macs');
  unmount();
});

test('the transfer is OFF while it cannot reach the successor — and says why, not nothing', async () => {
  // ⚠ THIS TEST WAS INVERTED AT THE E6 INTEGRATION, and the reason is in `adminpanel.js`'s
  // `TRANSFER_PROPAGATES`. Driving the handover across two real Macs against the real relay
  // showed it is a ONE-WAY DEMOTION: `POST /members/transfer` answers `{authoritative:false,
  // stored:'nothing'}` by design, the authoritative record is a `space.set{admin}` op, and that
  // op has no client mutation. Observed end state: the outgoing admin demotes himself, the
  // successor is never told, and the circle is left with NO ADMIN and no route back.
  //
  // So the control is disabled with its reason. What is asserted here is the honest surface;
  // the CONSEQUENCE SENTENCE is still guarded below at the pure-function level, so the copy
  // cannot rot while the button is off and re-enabling is one constant plus this test.
  const relay = mount();
  const pick = $('.sheet select.admin-transfer');
  const go = $$('.sheet button').find((b) => b.textContent === 'Rolle übergeben');
  assert.ok(pick && go, 'the transfer control vanished instead of being disabled');
  assert.equal(admin.TRANSFER_PROPAGATES, false, 'this test describes the un-propagating state');
  assert.equal(go.disabled, true, 'the handover is offered while it cannot arrive');
  assert.equal(pick.disabled, true);
  assert.includes(sheetText(), 'ohne beim anderen anzukommen');

  // Pressing it anyway opens nothing and tells the relay nothing. The baseline is not zero:
  // the settings sheet this section is drawn into carries a scrim of its own.
  const scrimsBefore = $$('.scrim').length;
  go.click();
  await sleep(60);
  assert.equal($$('.scrim').length, scrimsBefore, 'a disabled handover still opened a confirmation');
  assert.equal(relay.calls.filter((c) => c.path === '/api/v1/members/transfer').length, 0,
    'a disabled handover still called the relay');
  unmount();
});

test('20.1 — the transfer consequence sentence is intact, for the day the op can be emitted', () => {
  // The copy the disabled button will use again. Asserted on `consequencesOf` directly so it is
  // guarded independently of whether any control currently renders it.
  for (const [lang, needle] of [['de', 'wer was sehen kann'], ['en', 'who can see what']]) {
    const text = lifecycle.consequencesOf('transfer', lang, { name: 'Papa' }).join(' ');
    assert.includes(text, needle, `the ${lang} transfer consequence lost its 20.5 half`);
  }
  assert.includes(lifecycle.titleOf('transfer', 'de', { name: 'Papa' }), 'Papa');
});

test('a relay that refuses leaves the sheet open and the circle untouched', async () => {
  const relay = mount({ relay: fakeRelay({
    'POST /api/v1/members/remove': () => ({ status: 403, json: { error: 'not_a_member' } }),
  }) });
  [...memberRows()[1].querySelectorAll('button')].find((b) => b.textContent === 'Entfernen').click();
  const before = $$('.scrim').length;
  topButtons().find((b) => b.textContent === 'Entfernen').click();
  await waitFor(() => relay.calls.some((c) => c.path === '/api/v1/members/remove'), { what: 'the attempt' });
  await sleep(60);
  assert.equal($$('.scrim').length, before, 'a failed removal closed the confirmation anyway');
  assert.includes(document.querySelector('.toast').textContent, 'Am Kreis hat sich nichts geändert');
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 · 20.1 — the rename, and what the relay is told about it
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('renaming writes the name locally and pings a relay that stores nothing', async () => {
  const relay = mount();
  const input = $('.sheet input[type="text"]');
  input.value = 'Familie Hein';
  input.dispatchEvent(new Event('change'));
  await waitFor(() => settingsWrites.length > 0, { what: 'the local write' });
  assert.equal(Object.assign({}, ...settingsWrites)[createjoin.CIRCLE_PREFS.name], 'Familie Hein');
  await waitFor(() => relay.calls.some((c) => /rename/.test(c.path)), { what: 'the rename ping' });
  // `handlers/lifecycle.js` answers 400 on any readable field. The body must be empty.
  assert.deepEqual(relay.calls.find((c) => /rename/.test(c.path)).body, {});
  unmount();
});

test('the panel says where the name lives, and does not claim the server holds it', () => {
  mount();
  assert.includes(sheetText(), 'Auf dem Server steht er nirgends.');
  unmount();
  mount({ lang: 'en' });
  assert.includes(sheetText(), 'It is stored nowhere on the server.');
  unmount();
  i18n.setLang('de');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7 · the pure helpers
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('expiryLabel counts CALENDAR days — a fresh 7-day invite says seven, not six', () => {
  const now = Date.parse('2026-08-29T12:00:00Z');
  assert.equal(admin.expiryLabel('2026-08-29T16:00:00Z', now, 'de'), 'läuft heute ab');
  assert.equal(admin.expiryLabel('2026-08-30T13:00:00Z', now, 'de'), 'läuft morgen ab');
  // The one that matters: the sheet says „der Code gilt sieben Tage" one line above this label,
  // and elapsed-hours arithmetic would answer „in 6 Tagen" the second the code was minted.
  assert.equal(admin.expiryLabel('2026-09-05T12:00:00Z', now, 'de'), 'läuft in 7 Tagen ab');
  assert.equal(admin.expiryLabel('2026-09-05T12:00:00Z', now, 'en'), 'expires in 7 days');
  assert.equal(admin.expiryLabel('not a date', now, 'de'), '');
});

test('manageRows puts the admin first, the departed last, and keeps the nameless', () => {
  const rows = admin.manageRows([
    { memberId: 'c', displayName: 'Zoe', colorRef: 'blau', initial: 'Z', alive: true, isMe: false, isAdmin: false },
    { memberId: 'd', displayName: 'Alt', colorRef: 'rot', initial: 'A', alive: false, isMe: false, isAdmin: false },
    { memberId: 'a', displayName: 'Papa', colorRef: 'gruen', initial: 'P', alive: true, isMe: false, isAdmin: true },
    { memberId: 'b', displayName: null, colorRef: null, initial: '·', alive: true, isMe: true, isAdmin: false },
  ], 'de');
  assert.deepEqual(rows.map((r) => r.memberId), ['a', 'b', 'c', 'd']);
  assert.equal(rows[1].hasName, false);
  assert.equal(rows[1].colorRef, 'schiefer', 'a member with no colour yet got no swatch at all');
  assert.equal(rows[3].removed, true);
});

test('consequencesOf refuses a kind it does not have copy for, rather than rendering nothing', () => {
  let threw = null;
  try { lifecycle.consequencesOf('purge', 'de', {}); } catch (e) { threw = e; }
  assert.ok(threw, 'an unknown confirmation kind rendered an empty dialog');
  assert.match(String(threw.message), /unknown kind/);
});
