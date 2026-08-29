// TIER 2 · Familienkreis — create and join. LZP-601 / LZP-602, deliverables 14 and 15.
// Stories 15.1, 15.2, 15.3, 15.4, 20.5, 20.6 · ADR 002 §7.1 · PO decision D9 · 13.7.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE IS FOR
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Two of the claims in this epic cannot be checked by reading the code, and both of them are
// about a person rather than about a function:
//
//   · D9's WAITING STATE. `DESIGN-DECISIONS.md` § D9 lists four required behaviours and ends
//     with a not-negotiable: *"nothing in the waiting state may be phrased as an error, and it
//     must never tell Mom to 'ask Dad to open his laptop' as a requirement — it resolves
//     itself."* That is a claim about the rendered DOM in both languages, so §5 asserts it
//     against the rendered DOM in both languages, as NEGATIVES — the words that must not be on
//     the screen, and the controls that must not exist.
//   · 15.1's SOLO SILENCE. The entry point may cost a solo user nothing at render time. §1
//     counts what drawing the section actually does: zero requests, zero probes, zero keys.
//
// Everything else here is the ordinary characterization: the code round-trips, the create body
// is the one the relay reads, the colour collision is handled the way `invites.js` says it can
// be, and 20.6 is enforced.
//
// THE RELAY IS FAKE AND IT VERIFIES. It is not a stub that returns 200: it checks the
// attestation's shape, the space kind against the id prefix, and — the row that matters —
// `SHA-256(proof) === verifier`, over the real WebCrypto in this engine. That is what proves the
// admin's derivation and the joiner's derivation are the same derivation, which is the one bug
// in this feature that would present to a user as „der Code passt nicht" on a correct code.

const cj = await importApp('family/createjoin.js');
const i18n = await importApp('i18n.js');
const identityMod = await importApp('crypto/identity.js');
const ids = await importApp('core/ids.js');
const { b64u, ub64 } = await importApp('core/b64.js');
const { PALETTE, paletteName } = await importApp('palette.js');
const { store } = await importApp('store.js');

const RANDOM = (n) => crypto.getRandomValues(new Uint8Array(n));
const TODAY = '2026-08-29';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 0 · scaffolding
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** A real device identity, minus the key store — the bodies it produces are genuine. */
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
    identity: dev,
    recovery: rec,
    attestation: att,
    blob,
  };
}

/**
 * A relay with a memory of its own. Only the four routes these two flows touch.
 *
 * `refuseColor` makes the next redemption answer 400 `colorRef/taken`, which is exactly what
 * `server/core/handlers/invites.js` does inside its transaction — and, crucially, it does NOT
 * consume the invite, because that handler rolls the whole redemption back. §6 depends on that.
 */
function fakeRelay(opts = {}) {
  const state = {
    calls: [], spaces: new Map(), invites: new Map(), members: new Map(),
    refuseColor: opts.refuseColor || null,
    failRedeem: null,
  };
  const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const request = async (method, path, query, body) => {
    state.calls.push({ method, path, body });
    if (method === 'POST' && path === '/api/v1/spaces') {
      if (body.kind !== 'FAMILY') return { status: 400, json: { field: 'kind', reason: 'bad_shape' } };
      if (!String(body.spaceId).startsWith('fsp_')) {
        return { status: 400, json: { field: 'spaceId', reason: 'kind_mismatch' } };
      }
      // `readAttestedDevice` (finding E2E3-7) reads the RAW blob, `b64u(payload).b64u(sig)`.
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(body.device.attestation)) {
        return { status: 400, json: { field: 'device.attestation', reason: 'bad_shape' } };
      }
      if (!Array.isArray(body.wraps) || body.wraps.length === 0) {
        return { status: 400, json: { field: 'wraps', reason: 'empty' } };
      }
      state.spaces.set(body.spaceId, { kind: 'FAMILY', currentEpoch: 1 });
      state.members.set(body.spaceId, [{
        memberId: body.member.memberId, colorRef: body.colorRef, removedAt: null,
      }]);
      return { status: 200, json: { spaceId: body.spaceId, kind: 'FAMILY', currentEpoch: 1 } };
    }
    if (method === 'POST' && path === '/api/v1/invites') {
      if (!/^[A-Za-z0-9_-]{22}$/.test(body.inviteId)) {
        return { status: 400, json: { field: 'inviteId', reason: 'bad_shape' } };
      }
      if (ub64(body.verifier).length !== 32) {
        return { status: 400, json: { field: 'verifier', reason: 'wrong_length' } };
      }
      state.invites.set(body.inviteId, { spaceId: body.spaceId, verifier: body.verifier, used: false });
      return { status: 200, json: { inviteId: body.inviteId, spaceId: body.spaceId, epoch: 1 } };
    }
    if (method === 'POST' && path === '/api/v1/invites/redeem') {
      if (state.failRedeem) return { status: 400, json: state.failRedeem };
      const inv = state.invites.get(body.inviteId);
      if (!inv) return { status: 400, json: { error: 'invite_invalid' } };
      // THE ROW THAT MATTERS. The admin stored `SHA-256(proof)`; the joiner presents `proof`.
      const back = b64u(await sha256(ub64(body.proof)));
      if (back !== inv.verifier) return { status: 400, json: { error: 'invite_invalid' } };
      if (inv.used) return { status: 400, json: { error: 'invite_used' } };
      const roster = state.members.get(inv.spaceId) || [];
      if (state.refuseColor && body.colorRef === state.refuseColor) {
        // Rolled back: the invite is NOT consumed, exactly as the real handler leaves it.
        return { status: 400, json: { field: 'colorRef', reason: 'taken' } };
      }
      inv.used = true;
      roster.push({ memberId: body.member.memberId, colorRef: body.colorRef, removedAt: null });
      state.members.set(inv.spaceId, roster);
      return {
        status: 200,
        json: {
          spaceId: inv.spaceId, kind: 'FAMILY', memberId: body.member.memberId,
          deviceId: body.device.deviceId, colorRef: body.colorRef, currentEpoch: 1,
          // D9 — computed by the real handler, constant here, and always true for a device that
          // did not exist a millisecond ago.
          pendingKeys: true,
          members: roster.map((m) => ({ ...m, devices: [] })),
        },
      };
    }
    return { status: 404, json: {} };
  };
  return { state, port: { request } };
}

/** Everything the module reaches for that is not a pixel, counted. */
function mount(relay, extra = {}) {
  const counters = { identities: 0, reloads: 0, clips: [] };
  cj.initCreateJoin({
    today: () => TODAY,
    random: RANDOM,
    invoke: () => undefined,
    openIdentity: async () => { counters.identities++; return makeIdentity(); },
    transport: () => relay.port,
    reload: () => { counters.reloads++; },
    clipboard: (text) => { counters.clips.push(text); return Promise.resolve(); },
    ...extra,
  });
  return counters;
}

/**
 * A family space with an open invite on the fake relay, exactly as an admin's Mac would have
 * left it: the verifier is `SHA-256(proof)` of a code this module generated and derived.
 */
async function seedInvite(relay, roster = []) {
  const code = cj.newInviteCode();
  const d = await cj.deriveInvite(code);
  const spaceId = `fsp_${b64u(RANDOM(16))}`;
  relay.state.spaces.set(spaceId, { kind: 'FAMILY', currentEpoch: 1 });
  relay.state.members.set(spaceId, roster);
  relay.state.invites.set(d.inviteId, { spaceId, verifier: d.verifier, used: false });
  return { code, spaceId, invite: d };
}

/** No circle, and a relay address already known — the ordinary starting point. */
function resetCircle(origin = 'https://relay.example.test') {
  store.setSettings({
    [cj.CIRCLE_PREFS.space]: '',
    [cj.CIRCLE_PREFS.name]: '',
    [cj.CIRCLE_PREFS.role]: '',
    [cj.CIRCLE_PREFS.member]: '',
    [cj.CIRCLE_PREFS.display]: '',
    [cj.CIRCLE_PREFS.color]: '',
    [cj.CIRCLE_PREFS.pending]: false,
    [cj.CIRCLE_PREFS.origin]: origin,
  });
}

const $c = (sel) => document.querySelector(`.circle ${sel}`);
const typeInto = (node, value) => {
  node.value = value;
  node.dispatchEvent(new Event('input', { bubbles: true }));
};
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Walk to the done panel of a join, with the given colour. */
async function joinWith(color, code) {
  cj.openCircleScreen({ screen: 'join' });
  typeInto($c('#circle-code-in'), code);
  typeInto($c('#circle-display'), 'Mama');
  $c(`#circle-color-${color}`).click();
  $c('#circle-join-go').click();
  await waitFor(() => cj.circleScreenState()?.step === 'done'
    || cj.circleScreenState()?.problem || cj.circleScreenState()?.notice,
  { what: 'the join to settle' });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · STORY 15.1 — the entry point is the only door, and drawing it costs nothing
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('15.1 — the settings section is two buttons and a sentence, and drawing it makes no request', async () => {
  const relay = fakeRelay();
  const counters = mount(relay);
  resetCircle();

  const body = document.createElement('div');
  cj.buildFamilyCircleSection(body, { close() {}, rebuild() {} });

  const buttons = [...body.querySelectorAll('button')];
  assert.equal(buttons.length, 2, 'the opt-in is exactly „erstellen" and „beitreten"');
  assert.equal(buttons[0].textContent, i18n.t('circleCreateBtn'));
  assert.equal(buttons[1].textContent, i18n.t('circleJoinBtn'));
  assert.includes(body.textContent, i18n.t('circleSectionTitle'));

  // Principle 7, measured rather than asserted: no relay round trip, no identity, no key.
  assert.deepEqual(relay.state.calls, [], 'drawing the family section talked to the relay');
  assert.equal(counters.identities, 0, 'drawing the family section minted a device identity');
  // And no screen exists until somebody presses one of the two buttons.
  assert.equal(cj.circleScreenOpen(), null);
  assert.equal(document.querySelector('.circle'), null);
});

test('15.1 — nothing family-shaped is on the board before the entry point is used', () => {
  resetCircle();
  // The screens are a fixed layer with a stable class; the board must carry none of it, and no
  // stylesheet of ours may have been injected by merely importing the module.
  assert.equal(document.querySelector('.circle'), null);
  assert.equal(document.body.classList.contains('circle-on'), false);
  // `familyWaitingState()` is what `syncstatus.js` will ask. On a Mac with no circle it is the
  // silence 19.3 requires — there is nothing to wait for.
  assert.equal(cj.familyWaitingState().pending, false);
  assert.equal(cj.familyCircle(), null);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · THE CODE — ADR 002 §7.1, and the derivation both sides must agree on
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the code is 12 Crockford characters, shown in three groups, and normalises one way', async () => {
  const code = cj.newInviteCode();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(cj.inviteCodeChars(code).length, 12);
  // I/L → 1 and O → 0, exactly once, because two spellings of "what was typed" would be two keys.
  assert.equal(cj.formatInviteCode('abcdefghjkmn'), 'ABCD-EFGH-JKMN');
  assert.equal(cj.formatInviteCode('ILO123456789'), '1101-2345-6789');
  const a = await cj.deriveInvite('abcd-efgh-jkmn');
  const b = await cj.deriveInvite('  ABCD EFGH JKMN ');
  assert.equal(a.inviteId, b.inviteId, 'two spellings of one code derive two different invites');
  assert.equal(a.proof, b.proof);
});

test('the derived values are the shapes the relay reads, and the verifier is the hash of the proof', async () => {
  const d = await cj.deriveInvite(cj.newInviteCode());
  assert.match(d.inviteId, /^[A-Za-z0-9_-]{22}$/, 'inviteId must satisfy INVITE_ID_RE');
  assert.equal(ub64(d.proof).length, 32);
  assert.equal(ub64(d.verifier).length, 32);
  const hashed = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', ub64(d.proof))));
  assert.equal(d.verifier, hashed, 'the stored verifier is not SHA-256 of the presented proof');
  // D9's structural guarantee, said as a property of this function's output: nothing here is
  // key material, and there is no third derivation to be tempted by.
  assert.deepEqual(Object.keys(d).sort(), ['code', 'inviteId', 'proof', 'verifier']);
});

test('the paste field reads a whole invitation, and never eats what somebody is typing', () => {
  const invitation = 'Du bist zu „Familie Weber“ eingeladen.\n\nABCD-EFGH-JKMN\n'
    + 'https://relay.example.test\n\nIn LangzeitPlaner: Einstellungen → Familienkreis.';
  const parsed = cj.parseInvitePaste(invitation);
  assert.equal(parsed.code, 'ABCD-EFGH-JKMN');
  assert.equal(parsed.origin, 'https://relay.example.test');
  assert.equal(parsed.found, 'code');
  // Prose alone is prose. A filter over the whole text would have read „Du bist eingeladen" as
  // twelve valid Crockford characters and produced a code nobody minted.
  assert.equal(cj.parseInvitePaste('Du bist eingeladen.').code, '');
  assert.equal(cj.parseInvitePaste('Du bist eingeladen.').found, 'none');
  // A code being typed keeps its characters and gains its groups.
  assert.equal(cj.parseInvitePaste('ABCDEF').found, 'partial');
  assert.equal(cj.parseInvitePaste('ABCDEF').code, 'ABCD-EF');
  // A path segment in the URL is not the code.
  assert.equal(cj.parseInvitePaste('https://r.example.test/x/ABCDEFGHJKMN').code, '');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · LZP-601 — create (15.2, 20.5, 20.6)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('15.2 — one screen: name, my name, my colour, and a code comes back', async () => {
  const relay = fakeRelay();
  const counters = mount(relay);
  resetCircle();

  cj.openCircleScreen({ screen: 'create' });
  assert.equal(cj.circleScreenOpen(), 'create');
  // Everything the founder is asked for is on ONE screen — no wizard, no second step.
  assert.ok($c('#circle-name'), 'the circle name field');
  assert.ok($c('#circle-display'), 'the display name field');
  assert.equal(document.querySelectorAll('.circle .circle-color').length, PALETTE.length);

  typeInto($c('#circle-name'), 'Familie Weber');
  typeInto($c('#circle-display'), 'Papa');
  $c('#circle-color-violett').click();
  $c('#circle-create-go').click();
  await waitFor(() => cj.circleScreenState()?.step === 'done', { what: 'the circle to be created' });

  const code = $c('#circle-code').textContent;
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.includes($c('.circle-title').textContent, 'Familie Weber');

  // The relay saw a FAMILY space with an epoch-1 wrap, then the invite. Nothing else.
  const paths = relay.state.calls.map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(paths, ['POST /api/v1/spaces', 'POST /api/v1/invites']);
  const create = relay.state.calls[0].body;
  assert.equal(create.kind, 'FAMILY');
  assert.ok(create.spaceId.startsWith('fsp_'));
  assert.equal(create.colorRef, 'violett');
  assert.equal(create.wraps.length, 1, 'exactly the founder\'s own device, per requiredRecipients');
  assert.equal(create.wraps[0].epoch, 1);
  assert.equal(create.wraps[0].recipientId, create.device.deviceId);
  // The invite carries the derived id and the verifier — and NEVER the code.
  const minted = relay.state.calls[1].body;
  assert.deepEqual(Object.keys(minted).sort(), ['inviteId', 'spaceId', 'verifier']);
  assert.equal(JSON.stringify(minted).includes(cj.inviteCodeChars(code)), false,
    'the invite body carries the code the relay must never see');

  // 20.6, persisted: this Mac is now in exactly one circle, and it is the admin's.
  const circle = cj.familyCircle();
  assert.equal(circle.name, 'Familie Weber');
  assert.equal(circle.role, cj.CIRCLE_ROLE.admin);
  assert.equal(circle.colorRef, 'violett');
  // The founder holds epoch 1 already: there is nothing to wait for on this side.
  assert.equal(circle.keysPending, false);
  assert.equal(cj.familyWaitingState().pending, false);
  assert.equal(counters.identities, 1, 'the identity is minted once, on the click');

  cj.closeCircleScreen({ silent: true });
  resetCircle();
});

test('20.5 — the admin framing says what an admin cannot do, and no copy contradicts it', () => {
  mount(fakeRelay());
  resetCircle();
  cj.openCircleScreen({ screen: 'create' });
  const framing = $c('.circle-framing').textContent;
  // The claim 20.5 requires: structural, not a setting.
  assert.includes(framing, 'Verschlüsselung');
  assert.includes(framing, 'nicht');
  // Nothing anywhere on the admin's screen, in either language, may suggest an x-ray.
  const BANNED = ['alle Einträge sehen', 'see everything', 'see all entries', 'alles sehen'];
  for (const lang of ['de', 'en']) {
    cj.closeCircleScreen({ silent: true });
    i18n.setLang(lang);
    cj.openCircleScreen({ screen: 'create' });
    const all = document.querySelector('.circle').textContent;
    for (const phrase of BANNED) {
      assert.equal(all.includes(phrase), false, `the admin copy claims: ${phrase}`);
    }
  }
  i18n.setLang('de');
  cj.closeCircleScreen({ silent: true });
  resetCircle();
});

test('20.6 — one Familienkreis per user: both doors close once there is one', () => {
  mount(fakeRelay());
  resetCircle();
  store.setSettings({
    [cj.CIRCLE_PREFS.space]: 'fsp_AAAAAAAAAAAAAAAAAAAAAA',
    [cj.CIRCLE_PREFS.name]: 'Familie Weber',
    [cj.CIRCLE_PREFS.role]: cj.CIRCLE_ROLE.member,
  });
  // The section no longer offers either button — gone, not disabled: there is no second circle
  // to create and none to join, and a disabled control invites a question with no answer.
  const body = document.createElement('div');
  cj.buildFamilyCircleSection(body, { close() {}, rebuild() {} });
  const labels = [...body.querySelectorAll('button')].map((b) => b.textContent);
  assert.equal(labels.includes(i18n.t('circleCreateBtn')), false);
  assert.equal(labels.includes(i18n.t('circleJoinBtn')), false);
  assert.includes(body.textContent, 'Familie Weber');
  // And the screen itself refuses, so a second call site cannot reopen the question.
  assert.equal(cj.openCircleScreen({ screen: 'join' }), null);
  assert.equal(document.querySelector('.circle'), null);
  resetCircle();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · LZP-602 — join (15.3, 15.4)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('15.3 — code paste, name, colour, done: no email, no password, no registration form', async () => {
  const relay = fakeRelay();
  mount(relay);
  resetCircle('');            // she has no server address yet — it comes out of the invitation

  // The admin's half, so the code the joiner presents is a code that was really minted and the
  // verifier the relay holds is really `SHA-256(proof)`.
  const admin = await seedInvite(relay, [{ memberId: ids.memberId(RANDOM), colorRef: 'blau', removedAt: null }]);

  cj.openCircleScreen({ screen: 'join' });
  const paste = $c('#circle-code-in');
  assert.ok(paste, 'the huge paste field');
  // It is the largest input on the screen — the one thing she has to do.
  const other = $c('#circle-display');
  assert.ok(paste.getBoundingClientRect().height > other.getBoundingClientRect().height,
    'the paste field is not visibly the primary input');
  // Nothing on this screen asks for a password, an account or an e-mail address. 15.3 says so
  // in words and this is the mechanical half: there is no field for any of them.
  assert.equal(document.querySelectorAll('.circle input[type="password"]').length, 0);
  assert.equal(document.querySelectorAll('.circle input[type="email"]').length, 0);

  // She pastes the whole invitation. The address comes with it — that is the difference between
  // "one screen" and "one screen plus a URL she has to find".
  typeInto(paste, `Du bist eingeladen.\n${admin.code}\nhttps://relay.example.test\n`);
  assert.equal(paste.value, admin.code, 'the field normalises the pasted invitation to the code');
  assert.equal(cj.circleScreenState().origin, 'https://relay.example.test');
  assert.includes(document.querySelector('.circle').textContent,
    i18n.t('circleCodeFromPaste', 'https://relay.example.test'));

  typeInto($c('#circle-display'), 'Mama');
  $c('#circle-color-gruen').click();
  $c('#circle-join-go').click();
  await waitFor(() => cj.circleScreenState()?.step === 'done', { what: 'the redemption' });

  const redeem = relay.state.calls.find((c) => c.path === '/api/v1/invites/redeem').body;
  assert.deepEqual(Object.keys(redeem).sort(), ['colorRef', 'device', 'inviteId', 'member', 'proof']);
  assert.equal(redeem.colorRef, 'gruen');
  // 15.4 — she is in the list, and so is the person who was already there.
  assert.equal(document.querySelectorAll('.circle .circle-member').length, 2);
  assert.includes($c('#circle-members').textContent, 'Mama');

  const circle = cj.familyCircle();
  assert.equal(circle.role, cj.CIRCLE_ROLE.member);
  assert.equal(circle.displayName, 'Mama');
  assert.equal(circle.colorRef, 'gruen');
  cj.closeCircleScreen({ silent: true });
  resetCircle();
});

test('15.4 — the member chip is colour, initial and name, and the initial survives an umlaut', () => {
  assert.equal(cj.memberInitial('mama'), 'M');
  assert.equal(cj.memberInitial('Über'), 'Ü');
  assert.equal(cj.memberInitial('   '), '·');
  // A removed member does not hold a colour: 20.2 frees it, and `colorFree` on the relay agrees.
  assert.deepEqual(cj.takenColorRefs([
    { colorRef: 'blau' }, { colorRef: 'rot', removedAt: '2026-01-01' }, { colorRef: 'gruen' },
  ]), ['blau', 'gruen']);
  assert.equal(cj.firstFreeColorRef(['blau', 'gruen']), 'orange');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · PO DECISION D9 — the waiting state, asserted as the four behaviours it owes
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('D9 — the waiting state is an arrival, in both languages, with nothing to do and nobody to ask', async () => {
  const relay = fakeRelay();
  mount(relay);
  resetCircle();
  const { code, invite } = await seedInvite(relay,
    [{ memberId: ids.memberId(RANDOM), colorRef: 'blau', removedAt: null }]);

  await joinWith('gruen', code);
  assert.equal(cj.circleScreenState().step, 'done');
  assert.equal(cj.circleScreenState().keysPending, true);

  // The panel is inspected in BOTH languages, because D9's "never phrased as an error" is a
  // claim about what a reader sees and the English is a second chance to break it. The join is
  // re-run rather than the toggle pressed, so each pass renders the real end of a real flow.
  for (const lang of ['de', 'en']) {
    cj.closeCircleScreen({ silent: true });
    i18n.setLang(lang);
    resetCircle();
    relay.state.invites.get(invite.inviteId).used = false;
    await joinWith('gruen', code);

    const panel = document.querySelector('.circle');
    const text = panel.textContent;

    // D9-1 — she is a member, and the screen says so before it says anything about waiting.
    assert.equal(panel.querySelector('.circle-title').textContent, i18n.t('circleJoinedTitle'));
    assert.ok(panel.querySelector('#circle-members'), 'the member list is on the waiting screen');

    // D9-2 — ONE line, and no spinner. Nothing on this panel spins, pulses or counts.
    assert.equal($c('#circle-waiting').textContent, i18n.t('circleWaiting'));
    assert.equal(panel.querySelectorAll('progress, .spinner, [aria-busy="true"]').length, 0);
    for (const node of panel.querySelectorAll('*')) {
      const anim = getComputedStyle(node).animationName;
      assert.equal(anim === 'none' || anim === '', true, `something animates on the waiting screen: ${anim}`);
    }

    // D9-3 — it resolves itself. The sentence names ANOTHER MAC, never a person, because ADR
    // 002 §7.1 step 4 is any member device and not the admin's.
    const wait = $c('#circle-waiting').textContent;
    assert.equal(/\b(Papa|Dad|Mama|Mom|admin|Verwalter)\b/.test(wait), false,
      'the waiting line names a person somebody would have to go and ask');
    for (const phrase of ['aufklappen', 'öffnen lassen', 'bitte warte', 'frag ', 'ask ', 'open their', 'wait for']) {
      assert.equal(text.toLowerCase().includes(phrase.toLowerCase()), false,
        `the waiting state asks for human action: ${phrase}`);
    }
    assert.includes(text, i18n.t('circleWaitingCalm'));

    // D9-4 — never an error, and never a retry. One control, and it says „Fertig".
    assert.equal(panel.querySelectorAll('.circle-problem').length, 0);
    assert.equal(panel.querySelectorAll('[role="alert"]').length, 0);
    for (const phrase of ['Fehler', 'fehlgeschlagen', 'error', 'failed', 'noch einmal versuchen', 'try again']) {
      assert.equal(text.toLowerCase().includes(phrase.toLowerCase()), false,
        `the waiting state is phrased as a failure: ${phrase}`);
    }
    const buttons = [...panel.querySelectorAll('.circle-body button')];
    assert.deepEqual(buttons.map((b) => b.textContent), [i18n.t('circleDone')]);
  }
  i18n.setLang('de');
  cj.closeCircleScreen({ silent: true });
  resetCircle();
});

test('D9 — the same calm line is what the board chrome will be handed, and only while pending', async () => {
  const relay = fakeRelay();
  mount(relay);
  resetCircle();
  const { code } = await seedInvite(relay);
  await joinWith('blau', code);

  const w = cj.familyWaitingState();
  assert.equal(w.pending, true);
  assert.equal(w.line, i18n.t('circleWaiting'));
  assert.equal(w.calm, i18n.t('circleWaitingCalm'));
  // `syncstatus.js` renders this as PENDING and never as ERROR (19.3). The fact is one boolean,
  // so a caller cannot accidentally treat it as a failure state.
  assert.equal(typeof w.pending, 'boolean');

  cj.closeCircleScreen({ silent: true });
  resetCircle();
  assert.equal(cj.familyWaitingState().pending, false, 'the board waits on a Mac with no circle');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6 · THE COLOUR COLLISION — F15's design note, and why it is not an error
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the join flow prevents a colour collision, and a collision reads as an offer not a failure', async () => {
  const relay = fakeRelay({ refuseColor: 'gruen' });
  mount(relay);
  resetCircle();
  const { code } = await seedInvite(relay,
    [{ memberId: ids.memberId(RANDOM), colorRef: 'gruen', removedAt: null }]);

  cj.openCircleScreen({ screen: 'join' });
  typeInto($c('#circle-code-in'), code);
  typeInto($c('#circle-display'), 'Mama');
  $c('#circle-color-gruen').click();
  $c('#circle-join-go').click();
  await waitFor(() => cj.circleScreenState()?.notice, { what: 'the colour to come back taken' });

  const s = cj.circleScreenState();
  // NOT a failure: a notice, and the offer names the tone it is offering.
  assert.equal(s.problem, null, 'a colour somebody else has was reported as a problem');
  assert.equal(document.querySelectorAll('.circle .circle-problem').length, 0);
  assert.includes(s.notice, paletteName(s.colorRef, 'de'));
  assert.notEqual(s.colorRef, 'gruen');
  // The tone is now PREVENTED, which is what the design note asks for: disabled, not merely
  // marked, so it cannot be chosen again.
  assert.equal($c('#circle-color-gruen').disabled, true);
  assert.includes($c('#circle-color-gruen').getAttribute('aria-label'), i18n.t('circleColorTaken'));
  // The code survived, because `invites.js` rolls the redemption back — so the retry is one click.
  assert.equal($c('#circle-code-in').value, code);

  $c('#circle-join-go').click();
  await waitFor(() => cj.circleScreenState()?.step === 'done', { what: 'the retry to land' });
  assert.equal(cj.familyCircle().colorRef, s.colorRef);
  cj.closeCircleScreen({ silent: true });
  resetCircle();
});

test('a refusal that IS a refusal gets one whole sentence, never a status code', async () => {
  const relay = fakeRelay();
  mount(relay);
  resetCircle();
  relay.state.failRedeem = { error: 'invite_used' };
  cj.openCircleScreen({ screen: 'join' });
  typeInto($c('#circle-code-in'), cj.newInviteCode());
  typeInto($c('#circle-display'), 'Mama');
  $c('#circle-join-go').click();
  await waitFor(() => cj.circleScreenState()?.problem, { what: 'the refusal' });
  assert.equal(cj.circleScreenState().problem, i18n.t('circleErrInviteUsed'));
  assert.equal(/\b400\b|\b429\b|http_/.test($c('.circle-problem').textContent), false,
    'a status code reached the screen');
  // Story 15.5's distinction is kept: "you were too late" is not "you typed it wrong".
  assert.notEqual(i18n.t('circleErrInviteUsed'), i18n.t('circleErrInviteInvalid'));

  // Server finding E2-203-1, the one a real family will actually meet — said in plain German.
  relay.state.failRedeem = { field: 'device.deviceShort', reason: 'registered' };
  $c('#circle-join-go').click();
  await waitFor(() => cj.circleScreenState()?.problem === i18n.t('circleErrDeviceRegistered'),
    { what: 'the deviceShort refusal' });
  cj.closeCircleScreen({ silent: true });
  resetCircle();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 7 · 13.7 — German first, English a toggle, both complete
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('13.7 — every string these screens use exists in both languages, and neither falls back to a key', () => {
  const KEYS = [
    'circleKicker', 'circleSectionTitle', 'circleCreateBtn', 'circleJoinBtn', 'circleSectionHint',
    'circleOneOnly', 'circleMemberOfUnnamed', 'circleYouAdmin', 'circleYouMember', 'circleNewInvite',
    'circleErrAlready', 'circleCreateTitle', 'circleCreateLead', 'circleAdminFraming',
    'circleRelayLabel', 'circleRelayHint', 'circleNameLabel', 'circleNamePlaceholder',
    'circleYourNameLabel', 'circleYourNamePlaceholder', 'circleColorLabel', 'circleColorTaken',
    'circleCreateSubmit', 'circleCreateFoot', 'circleNeedName', 'circleNeedYourName',
    'circleCreatedLead', 'circleCodeLabel', 'circleCodeShare', 'circleCopyInvite', 'circleCopied',
    'circleCopyFailed', 'circleNoCodeYet', 'circleCreatedD9', 'circleDone', 'circleWorking',
    'circleInviteLine2', 'circleJoinTitle', 'circleJoinLead', 'circleCodeInputLabel',
    'circleCodePlaceholder', 'circleJoinNamePlaceholder', 'circleJoinSubmit', 'circleJoinFoot',
    'circleNeedCode', 'circleNeedRelayForJoin', 'circleJoinedTitle', 'circleJoinedLead',
    'circleMemberUnnamed', 'circleYou', 'circleWaiting', 'circleWaitingCalm', 'circleKeysHere',
    'circleJoinedPrivacy', 'circleErrInviteInvalid', 'circleErrInviteUsed', 'circleErrTooMany',
    'circleErrDeviceRegistered', 'circleErrMemberExists', 'circleErrOffline', 'circleErrNoKeystore',
  ];
  const FNS = [
    ['circleMemberOf', ['Familie Weber']], ['circleNewInviteCopied', ['ABCD-EFGH-JKMN']],
    ['circleCreatedTitle', ['Familie Weber']], ['circleCodeTtl', [7]],
    ['circleCodeFromPaste', ['https://x.test']], ['circleColorTakenSwap', ['Grün']],
    ['circleJoinedMembers', [3]], ['circleInviteLine1', ['Familie Weber']],
  ];
  const seen = { de: new Map(), en: new Map() };
  for (const lang of ['de', 'en']) {
    i18n.setLang(lang);
    for (const k of KEYS) {
      const v = i18n.t(k);
      assert.notEqual(v, k, `${k} is missing in ${lang} — t() fell back to the key`);
      seen[lang].set(k, v);
    }
    for (const [k, args] of FNS) {
      const v = i18n.t(k, ...args);
      assert.notEqual(v, k, `${k} is missing in ${lang}`);
      seen[lang].set(k, v);
    }
  }
  // German is not English. A key whose two languages are identical is almost always an
  // untranslated string that was pasted rather than written — allowed only where the word
  // really is the same in both.
  const SAME_ON_PURPOSE = new Set(['circleCodePlaceholder', 'circleRelayLabel']);
  const identical = [...seen.de.keys()]
    .filter((k) => seen.de.get(k) === seen.en.get(k) && !SAME_ON_PURPOSE.has(k));
  assert.deepEqual(identical, [], 'these strings were never translated');
  i18n.setLang('de');
});

test('13.7 — the toggle travels with the screen, because the reader cannot reach Settings', () => {
  mount(fakeRelay());
  resetCircle();
  i18n.setLang('de');
  cj.openCircleScreen({ screen: 'join' });
  assert.equal($c('.circle-title').textContent, i18n.t('circleJoinTitle'));
  const toggle = $c('#circle-lang');
  assert.equal(toggle.textContent, 'English');
  toggle.click();
  assert.equal(i18n.getLang(), 'en');
  assert.equal($c('.circle-title').textContent, 'Join a family circle');
  assert.equal($c('#circle-lang').textContent, 'Deutsch');
  $c('#circle-lang').click();
  assert.equal(i18n.getLang(), 'de');
  cj.closeCircleScreen({ silent: true });
  resetCircle();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 8 · the surface itself
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the screen is a surface with one stylesheet, Escape closes it, and closing is not a reload', () => {
  const counters = mount(fakeRelay());
  resetCircle();
  cj.openCircleScreen({ screen: 'create' });
  assert.equal(document.querySelectorAll(`#${cj.CIRCLE_CSS_ID}`).length, 1);
  cj.openCircleScreen({ screen: 'join' });
  assert.equal(document.querySelectorAll(`#${cj.CIRCLE_CSS_ID}`).length, 1, 'the stylesheet was injected twice');
  // A second open while one screen is up is IGNORED, not stacked and not swapped. Two of these
  // surfaces on top of each other would leave the lower one's key handler bound.
  assert.equal(cj.circleScreenOpen(), 'create', 'a second open replaced the screen already up');
  assert.equal(document.body.classList.contains('circle-on'), true);

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(document.querySelector('.circle'), null);
  assert.equal(document.body.classList.contains('circle-on'), false);
  // Walking away from a form is exactly as consequential as not having opened it. The reload is
  // reserved for the one case that changed what space this store belongs to.
  assert.equal(counters.reloads, 0);
  resetCircle();
});

test('a finished join reloads once, because the store must be re-derived into its new space', async () => {
  const relay = fakeRelay();
  const counters = mount(relay);
  resetCircle();
  const { code } = await seedInvite(relay);
  await joinWith('rot', code);
  assert.equal(counters.reloads, 0, 'the reload happened before the screen was dismissed');
  $c('#circle-done').click();
  await settle();
  assert.equal(counters.reloads, 1);
  resetCircle();
});
