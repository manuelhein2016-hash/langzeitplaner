// TIER 2 · the join screen's paste surface, in the engine the shipping app uses.
// LZP-1006, story 15.3 · PO decision D9 · 13.7.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS IS A TIER-2 FILE AND NOT MORE ROWS IN THE TIER-1 ONE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `tests/tier1/createjoin.test.js` runs `parseInvitePaste` over the real bytes of the four
// shipped e-mail files. It is the right place for the parser and it cannot see the three things
// that actually decide what happens to a person:
//
//   1. **The field is an `<input>`, and an `<input>` DELETES newlines.** Not "turns them into
//      spaces" — the HTML value sanitization algorithm removes them. So the one gesture this
//      screen is designed around, ⌘A ⌘C ⌘V of a whole invitation, arrives at `input.value` as
//      „…diesen Code ein:J17Z-XSXN-7CSQManche Mail-Anbieter…", with the code welded to the next
//      word. That is engine behaviour, it is why the `paste` handler reads `clipboardData`
//      instead, and §1 asserts it against the real engine rather than trusting the comment.
//
//   2. **Whether her text is still on screen when the refusal appears.** `found` is the caller's
//      permission to rewrite the field, and a refusal that has BLANKED the evidence it is asking
//      her to look at is worse than no refusal. §3 and §4 read `input.value` after the refusal.
//
//   3. **Whether a request was made.** The dishonest class costs a redemption attempt and comes
//      back as „Vielleicht ist ein Zeichen vertippt" — a sentence blaming her for a character
//      she never typed. §3 counts the relay calls: a refused paste must make none.
//
// ── THE E-MAIL TEXT BELOW IS AN EXCERPT, AND THAT IS DELIBERATE ──────────────────────────────
//
// The byte-exact corpus — every word, every line and every consecutive pair of lines of all four
// files — is tier 1's §2, where `node:fs` can read them. This file cannot reach `docs/` from
// inside the page under `default-src 'self'`, so it carries the three paragraphs that matter:
// the fallback sentence with „Mail-Anbieter" in it, the Releases link, and the code block under
// its heading. If the shipped copy changes, tier 1 is what goes red; this file is about the DOM.

const cj = await importApp('family/createjoin.js');
const i18n = await importApp('i18n.js');
const identityMod = await importApp('crypto/identity.js');
const ids = await importApp('core/ids.js');
const { b64u, ub64 } = await importApp('core/b64.js');
const { store } = await importApp('store.js');

const RANDOM = (n) => crypto.getRandomValues(new Uint8Array(n));
const TODAY = '2026-09-03';
const RELEASE_URL = 'https://github.com/OWNER/REPO/releases/latest';
const RELAY = 'https://relay.example.test';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 0 · scaffolding — the same shapes `family-createjoin.dom.js` uses, so the two agree
// ═════════════════════════════════════════════════════════════════════════════════════════════

async function makeIdentity() {
  const dev = await identityMod.generateDeviceKeys();
  const rec = await identityMod.generateRecoveryKeys();
  const sigRaw = await identityMod.exportRawPublic(dev.devSig.publicKey);
  const memberId = ids.memberId(RANDOM);
  const deviceId = ids.deviceId(RANDOM);
  const att = await identityMod.buildDeviceAttestation(
    { memberId, deviceId, createdAt: TODAY }, dev.devSig.publicKey, dev.devKex.publicKey,
  );
  const blob = await identityMod.attestDevice(att, rec.recSig.privateKey);
  return {
    forStore: { memberId, deviceId, deviceShort: identityMod.deviceShortOf(sigRaw) },
    identity: dev, recovery: rec, attestation: att, blob,
  };
}

/** A relay that verifies `SHA-256(proof) === verifier`, and counts every call it is asked to make. */
function fakeRelay() {
  const state = { calls: [], spaces: new Map(), invites: new Map(), members: new Map() };
  const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const request = async (method, path, query, body) => {
    state.calls.push({ method, path, body });
    if (method === 'POST' && path === '/api/v1/invites/redeem') {
      const inv = state.invites.get(body.inviteId);
      if (!inv) return { status: 400, json: { error: 'invite_invalid' } };
      const back = b64u(await sha256(ub64(body.proof)));
      if (back !== inv.verifier) return { status: 400, json: { error: 'invite_invalid' } };
      if (inv.used) return { status: 400, json: { error: 'invite_used' } };
      inv.used = true;
      const roster = state.members.get(inv.spaceId) || [];
      roster.push({ memberId: body.member.memberId, colorRef: body.colorRef, removedAt: null });
      state.members.set(inv.spaceId, roster);
      return {
        status: 200,
        json: {
          spaceId: inv.spaceId, kind: 'FAMILY', memberId: body.member.memberId,
          deviceId: body.device.deviceId, colorRef: body.colorRef, currentEpoch: 1,
          pendingKeys: true, members: roster.map((m) => ({ ...m, devices: [] })),
        },
      };
    }
    return { status: 404, json: {} };
  };
  return { state, port: { request } };
}

function mount(relay, extra = {}) {
  const counters = { identities: 0, reloads: 0 };
  cj.initCreateJoin({
    today: () => TODAY,
    random: RANDOM,
    invoke: () => undefined,
    openIdentity: async () => { counters.identities++; return makeIdentity(); },
    transport: () => relay.port,
    reload: () => { counters.reloads++; },
    clipboard: () => Promise.resolve(),
    ...extra,
  });
  return counters;
}

async function seedInvite(relay) {
  const code = cj.newInviteCode();
  const d = await cj.deriveInvite(code);
  const spaceId = `fsp_${b64u(RANDOM(16))}`;
  relay.state.spaces.set(spaceId, { kind: 'FAMILY', currentEpoch: 1 });
  relay.state.members.set(spaceId, []);
  relay.state.invites.set(d.inviteId, { spaceId, verifier: d.verifier, used: false });
  return { code, spaceId };
}

/** No circle. `origin: ''` is the state a joiner is really in: she has an e-mail and nothing else. */
function resetCircle(origin = '') {
  store.setSettings({
    [cj.CIRCLE_PREFS.space]: '', [cj.CIRCLE_PREFS.name]: '', [cj.CIRCLE_PREFS.role]: '',
    [cj.CIRCLE_PREFS.member]: '', [cj.CIRCLE_PREFS.display]: '', [cj.CIRCLE_PREFS.color]: '',
    [cj.CIRCLE_PREFS.pending]: false, [cj.CIRCLE_PREFS.origin]: origin,
  });
}

const $c = (sel) => document.querySelector(`.circle ${sel}`);
const field = () => $c('#circle-code-in');
const problem = () => ($c('.circle-problem') || {}).textContent || '';

/** Typing. No newlines exist on this path, and no sentence is owed while somebody is mid-code. */
const typeInto = (node, value) => {
  node.value = value;
  node.dispatchEvent(new Event('input', { bubbles: true }));
};

/**
 * A real paste, as the handler sees one.
 *
 * `new ClipboardEvent(...)` cannot be given a populated `DataTransfer` portably, so the event
 * carries the ONE property the handler reads — `e.clipboardData.getData('text')` — and is
 * `cancelable` so that its `preventDefault()` is real. Everything downstream of that read is the
 * shipped code path, including the re-render and the focus restore.
 */
const pasteInto = (node, text) => {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: { getData: () => text } });
  node.dispatchEvent(ev);
  return ev.defaultPrevented;
};

const openJoin = (relay) => { mount(relay); resetCircle(); cj.openCircleScreen({ screen: 'join' }); };

// ── the shipped copy, excerpted (see the header) ─────────────────────────────────────────────

const MAIL_DE = (code) => `FALLS DER ANHANG FEHLT

Manche Mail-Anbieter filtern .dmg-Dateien heraus. Wenn oben also gar keine
Datei hängt, lade sie hier herunter — es ist genau dieselbe:

    ${RELEASE_URL}


DEIN EINLADUNGSCODE

    ${code}

In der App: Einstellungen -> „Familienkreis beitreten", den Code einsetzen,
Namen und eine Farbe aussuchen. Das war's, du bist dabei.
`;

/**
 * The two wrong pastes, and they are different bugs.
 *
 * `WRONG_WORD` is the one the shell pass measured: „Mail-Anbieter" ALONE in the field, which is
 * what a double-click-and-drag over the compound puts on the clipboard. It normalises to twelve
 * legal Crockford characters and it used to WIN outright — a complete code, an enabled button,
 * one spent redemption. `WRONG_LINE` is the whole sentence it stands in, which a triple-click
 * selects; that one has been refused since the grouping rule landed and is kept here as the
 * neighbouring case, so a regression in either is visible separately.
 */
const WRONG_WORD = 'Mail-Anbieter';
const WRONG_LINE = 'Manche Mail-Anbieter filtern .dmg-Dateien heraus.';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · THE ENGINE'S OWN BEHAVIOUR, WHICH IS WHY THE PASTE PATH EXISTS
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§1 — an <input> DELETES newlines, so the whole-mail gesture must read the clipboard', async () => {
  const relay = fakeRelay();
  openJoin(relay);
  const paste = field();

  // Not a claim about the spec: the real engine, right now.
  paste.value = 'a\nb\r\nc';
  assert.equal(paste.value, 'abc', 'this engine no longer strips newlines — the paste path can be simplified');

  // So the value path sees the code welded to the next word, and correctly refuses to go fishing
  // inside a 40-character token…
  const code = cj.newInviteCode();
  typeInto(paste, MAIL_DE(code));
  assert.notEqual(paste.value, code, 'the <input> path must not be what makes the gesture work');

  // …while the CLIPBOARD path, which still has the newlines, reads it.
  const prevented = pasteInto(paste, MAIL_DE(code));
  assert.equal(prevented, true, 'the handler must take the field over when it has the raw string');
  assert.equal(field().value, code, 'the whole invitation did not fill the field with the code');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · THE ONE GESTURE — select all, copy, paste
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§2 — the whole invitation fills the field with the code, and takes NO address from it', async () => {
  const relay = fakeRelay();
  openJoin(relay);
  const code = cj.newInviteCode();
  pasteInto(field(), MAIL_DE(code));

  assert.equal(field().value, code);
  assert.equal(cj.circleScreenState().code, code);

  // DEFECT E-2 on the glass. The only URL in this e-mail is the Releases fallback, and taking it
  // would put `github.com` in the Server field under „Server aus der Einladung übernommen" — a
  // join flow silently pointed at the wrong host, which looks like it worked.
  assert.equal(cj.circleScreenState().origin, '', 'an address was taken out of a download link');
  const screen = document.querySelector('.circle').textContent;
  assert.equal(screen.includes('github.com'), false, 'the download host is on the join screen');
  assert.equal(/https?:\/\//.test(field().value), false, 'a URL was left in the code field');

  // And she is told what the link she pasted actually was, rather than being left to guess.
  assert.ok(problem().length > 60, `no sentence about the missing address: ${problem()}`);
  assert.match(problem(), /Herunterladen|Serveradresse/);
});

test('§2b — an invitation that DOES carry a bare address hands both fields over', async () => {
  const relay = fakeRelay();
  openJoin(relay);
  const code = cj.newInviteCode();
  pasteInto(field(), `${MAIL_DE(code)}\nServer: ${RELAY}\n`);

  assert.equal(field().value, code);
  assert.equal(cj.circleScreenState().origin, RELAY, 'the labelled address did not win');
  assert.includes(document.querySelector('.circle').textContent, i18n.t('circleCodeFromPaste', RELAY));
  assert.equal(problem(), '', 'a complete paste was reported as a problem');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · ██ THE WRONG LINE ██
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§3 — ██ the wrong WORD is REFUSED, her text stays, and no request is made ██', async () => {
  const relay = fakeRelay();
  openJoin(relay);

  // „Mail-Anbieter" normalises to twelve legal Crockford characters and used to WIN: the field
  // filled with `MA11-ANB1-ETER`, „Beitreten" lit up, one redemption was spent, and the relay
  // came back with a sentence blaming her for a character she never typed.
  pasteInto(field(), WRONG_WORD);

  const s = cj.circleScreenState();
  assert.equal(s.code, '', `the wrong word still becomes the code ${JSON.stringify(s.code)}`);
  assert.equal(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(field().value), false,
    `the field shows a complete code after a refused paste: ${field().value}`);

  // HER TEXT IS STILL THERE. It is the evidence the sentence is asking her to look at.
  assert.equal(field().value, WRONG_WORD, 'the refusal blanked what she pasted');

  // The sentence names the LINE to copy, in German, and is not „Der Code ist noch nicht
  // vollständig" — which describes the field and not the next move.
  assert.ok(problem().length > 60, `no refusal sentence at all: ${JSON.stringify(problem())}`);
  assert.includes(problem(), 'Einladungscode');
  assert.notEqual(problem(), i18n.t('circleNeedCode'));

  // And pressing the button changes nothing but repeats the same sentence. Zero relay calls.
  typeInto($c('#circle-display'), 'Mama');
  $c('#circle-join-go').click();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(relay.state.calls, [], 'a refused paste reached the relay');
  assert.ok(problem().length > 60);
  assert.includes(problem(), 'Einladungscode');
});

test('§3b — the whole LINE it stands in, and a circle NAME on the wrong screen', async () => {
  const relay = fakeRelay();
  for (const [what, raw] of [
    ['the sentence a triple-click selects', WRONG_LINE],
    // „Familie Weber" is twelve legal characters across two words — the CREATE screen's field,
    // filled in on the JOIN screen by somebody who took the wrong branch.
    ['a circle name on the join screen', 'Familie Weber'],
    // The two words this module's own docblock names as decoys, both of them in the e-mail.
    ['a decoy the file names', 'Installation'],
    ['the other one', 'Applications'],
  ]) {
    openJoin(relay);
    pasteInto(field(), raw);
    assert.equal(cj.circleScreenState().code, '', `${what}: became a complete code`);
    assert.equal(field().value, raw, `${what}: the refusal blanked her text`);
    assert.ok(problem().length > 60, `${what}: no sentence`);
  }
  assert.deepEqual(relay.state.calls, []);
});

test('§3bb — a sentence with „Code" in it does not turn the next word into one', async () => {
  const relay = fakeRelay();
  // DEFECT E-1d. `CODE_LABEL_RE` matches the bare word „Code", which the shipped German copy
  // uses twice („den Code einsetzen"), and a label used to promote ANY twelve-legal-character
  // word standing after it. On this screen that reads as: she selects from the heading down into
  // the next paragraph, and gets a confident wrong answer.
  openJoin(relay);
  pasteInto(field(), 'Dein Einladungscode steht bei der Installation');
  assert.equal(cj.circleScreenState().code, '', 'a label made a word into a code');
  assert.ok(problem().length > 60);

  // And the worse direction: a decoy standing AFTER the real code made the CORRECT paste refuse
  // itself. On the glass that is a person who did everything right and is told she did not.
  const code = cj.newInviteCode();
  openJoin(relay);
  pasteInto(field(), `DEIN EINLADUNGSCODE\n\n    ${code}\n\nmusst Mail-Anbieter\n`);
  assert.equal(field().value, code, 'a decoy after the code destroyed the code');
  assert.equal(problem(), '');
});

test('§3c — the SERVER line is not a half-typed code, and its address is still taken', async () => {
  const relay = fakeRelay();
  openJoin(relay);
  // The paste held TWO things — a label and a URL — so it was never one unfinished code. The
  // screen used to answer it by replacing the line with `SERV-ER`.
  pasteInto(field(), `Server: „${RELAY}“`);
  assert.equal(cj.circleScreenState().code, '');
  assert.equal(field().value.includes('SERV'), false,
    `the server line was rewritten to ${JSON.stringify(field().value)}`);
  assert.equal(cj.circleScreenState().origin, RELAY, 'the address in it was thrown away');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · TYPING IS NOT SHOUTED AT
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4 — while she TYPES, an unfinished code gets its groups and never a red line', async () => {
  const relay = fakeRelay();
  openJoin(relay);
  const paste = field();
  for (const [typed, want] of [['j17z', 'J17Z'], ['j17zxs', 'J17Z-XS'], ['j17zxsxn7cs', 'J17Z-XSXN-7CS']]) {
    typeInto(paste, typed);
    assert.equal(field().value, want, `typing ${typed}`);
    assert.equal(problem(), '', 'a red line under a code that is simply not finished yet');
  }
  // A `paste` of the same unfinished code is a deliberate gesture and STILL not an error: it is
  // an unfinished code, not a wrong one.
  pasteInto(field(), 'J17Z-XSXN-7CS');
  assert.equal(problem(), '');
  assert.equal(field().value, 'J17Z-XSXN-7CS');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · BOTH LANGUAGES — 13.7
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§5 — the refusal exists in English too, and neither language is the other', async () => {
  const relay = fakeRelay();
  const was = i18n.getLang();
  try {
    i18n.setLang('de');
    openJoin(relay);
    pasteInto(field(), WRONG_LINE);
    const de = problem();

    i18n.setLang('en');
    openJoin(relay);
    pasteInto(field(), WRONG_LINE);
    const en = problem();

    assert.ok(de.length > 60 && en.length > 60, `de=${de.length} en=${en.length}`);
    assert.notEqual(de, en, 'one language is falling back to the other');
    assert.includes(de, 'Einladungscode');
    assert.includes(en, 'invitation code');
    // Not a key, and not a German sentence in an English screen.
    assert.equal(/circle[A-Z]/.test(en), false, `a translation key leaked: ${en}`);
    assert.equal(/[äöüß]|„/.test(en), false, `German characters in the English sentence: ${en}`);
  } finally {
    i18n.setLang(was);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 · D9 — THE SCREEN NEVER SAYS WHETHER A CODE EXISTS
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§6 — no refusal on this screen leaks whether a code was ever minted', async () => {
  const relay = fakeRelay();
  const banned = /gibt es nicht|existiert|abgelaufen|verfallen|unbekannt|nicht gefunden|schon eingelöst|expired|does not exist|no such|already used|not found/i;
  for (const raw of [WRONG_LINE, 'Familie Weber', RELEASE_URL, `Server: ${RELAY}`, MAIL_DE('')]) {
    openJoin(relay);
    pasteInto(field(), raw);
    const text = document.querySelector('.circle').textContent;
    assert.equal(banned.test(text), false,
      `the join screen talks about the invite table after pasting ${JSON.stringify(raw.slice(0, 40))}`);
  }
  assert.deepEqual(relay.state.calls, [], 'reading a refusal cost a request');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7 · ██ THE HONEST-PATH CONTROL ██
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§7 — ██ CONTROL ██ a real invitation still joins, through the whole screen', async () => {
  // Without this row every assertion above is satisfiable by a screen that refuses everything.
  const relay = fakeRelay();
  const seeded = await seedInvite(relay);
  mount(relay);
  resetCircle('');
  cj.openCircleScreen({ screen: 'join' });

  pasteInto(field(), `${MAIL_DE(seeded.code)}\nServer: ${RELAY}\n`);
  assert.equal(field().value, seeded.code);
  assert.equal(cj.circleScreenState().origin, RELAY);
  assert.equal(problem(), '');

  typeInto($c('#circle-display'), 'Mama');
  $c('#circle-color-gruen').click();
  $c('#circle-join-go').click();
  await waitFor(() => cj.circleScreenState()?.step === 'done'
    || cj.circleScreenState()?.problem, { what: 'the redemption' });

  assert.equal(cj.circleScreenState().problem, null,
    `the honest path was refused: ${cj.circleScreenState().problem}`);
  assert.equal(cj.circleScreenState().step, 'done');
  const redeem = relay.state.calls.find((c) => c.path === '/api/v1/invites/redeem');
  assert.ok(redeem, 'the honest path made no redemption call');
  assert.equal(cj.familyCircle().spaceId, seeded.spaceId);
});
