// TIER 2 · THE CO-SIGNATURE SCREEN — ADR 003 §3.7, `handlers/lifecycle.js`, findings T5-M2/M3/M4.
// Stories 20.2 / 20.4, addendum F20 and Principle 9. Owner: `src/js/family/leavedelete.js` +
// `src/js/family/adminpanel.js`.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS, AND WHAT IT IS ALLOWED TO CLAIM
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The relay has required a second member row's recovery signature since round 3, and until this
// screen landed **no member could be removed by anybody through the UI in a founder-less circle,
// and no Familienkreis could be deleted at all** — `POST /spaces/:id/delete` requires the proof
// whenever the space has ever had more than one member row, which is every real circle. The gate
// worked and the product could not use it. `tests/tier2/family-admin.dom.js` stubs a relay that
// answers 200 and is structurally blind to all of that.
//
// So the rows here are about four things, and each of them was written after a mutant proved it
// could go red:
//
//   1. **THE BYTES.** `leavedelete.js#adminProofString` is a MIRROR of
//      `server/core/auth.js#adminProofString`, and a mirror can drift. §1 pins the exact string
//      as a literal, character for character, including the `lzp/admin/2` version and the
//      presenter binding (T5-M4/N-3). A tier-2 test cannot import `server/`, so the literal is
//      the pin — and the end-to-end control is the real relay, driven outside this file.
//   2. **A SECOND KEY, ON A SECOND MAC.** §6 mints a real recovery pair in WebKit's own
//      WebCrypto, drives the co-signing sheet, and VERIFIES the resulting signature against the
//      public key over the exact bytes. It also asserts the four refusals — above all the one
//      that matters: a request whose presenter is this Mac is refused before anything is signed.
//   3. **PRINCIPLE 9.** §7 pins the property that makes this not a surveillance surface: the
//      whole co-signature round trip makes **zero** network calls and writes **zero** settings.
//      No notification, no broadcast, no vote count, no pending-request list. One person asks,
//      one person signs.
//   4. **THE COPY.** §8 walks every leaf of `COSIGN_COPY` in both languages and asserts it never
//      claims two PEOPLE — the exact claim `handlers/lifecycle.js` exports `PROVES_NOT` to stop
//      a screen from making.
//
// **WHAT THIS FILE DOES NOT PROVE, stated rather than implied.** It does not prove that two
// humans were involved. Nothing can: finding T5-M2 — one person who invites herself and keeps
// both recovery keys in her own Keychain satisfies the two-row rule alone, and no screen closes
// that. The rows below prove that this screen does not make it worse and never says otherwise.

const admin = await importApp('family/adminpanel.js');
const cosign = await importApp('family/leavedelete.js');
const ui = await importApp('ui.js');
const i18n = await importApp('i18n.js');
const identity = await importApp('crypto/identity.js');
const b64 = await importApp('core/b64.js');

const TE = new TextEncoder();

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §0 · scaffolding
// ═════════════════════════════════════════════════════════════════════════════════════════════

const SPACE = 'fsp_0123456789abcdefghijkm';
const ME = 'mem_me00000000000000000000';
const MAMA = 'mem_mama0000000000000000000';
const PAPA = 'mem_papa0000000000000000000';
const EPOCH = 7;

/** The exact refusal `handlers/lifecycle.js` throws, field for field. Nothing here is invented. */
const proofRequired = (over = {}) => ({
  status: 403,
  json: {
    error: 'admin_proof_required',
    field: 'adminProof',
    reason: 'founder_gone_every_removal_needs_second_key',
    signedString: 'lzp/admin/2 | act | spaceId | target | epoch | presenter',
    act: 'member.remove',
    epoch: EPOCH,
    checks: 'two distinct live Member rows of this space put a recovery key behind this act',
    doesNotCheck: 'that two distinct PEOPLE are behind two Member rows, or that either row is '
      + 'the admin — the relay cannot see either (T5-M2, ADR 003 §3.7)',
    ...over,
  },
});

const removed200 = {
  status: 200,
  json: {
    spaceId: SPACE, memberId: MAMA, removed: true, alreadyRemoved: false,
    purgedOps: 12, purgedWraps: 3, revokedDevices: 1, revokedInvites: 0, currentEpoch: EPOCH,
    authorizedBy: 'admin_proof',
    proves: 'two distinct live Member rows of this space put a recovery key behind this act',
    provesNot: 'that two distinct PEOPLE are behind two Member rows, or that either row is the admin',
    rotateRequired: true, alreadyDeliveredIsIrrevocable: true,
  },
};

function circleOf(over = {}) {
  return {
    spaceId: SPACE, name: 'Familie Weber', role: 'admin', memberId: ME,
    displayName: 'Manuel', colorRef: 'violett', keysPending: false,
    origin: 'https://relay.example', joinedAt: '2026-08-01', ...over,
  };
}

function membersOf(rows) {
  return {
    supported: true, me: ME, adminId: ME, keysPending: false,
    members: rows || [
      { memberId: ME, displayName: 'Manuel', colorRef: 'violett', initial: 'M', alive: true, isMe: true, isAdmin: true, hidden: false },
      { memberId: MAMA, displayName: 'Mama', colorRef: 'magenta', initial: 'M', alive: true, isMe: false, isAdmin: false, hidden: false },
      { memberId: PAPA, displayName: 'Papa', colorRef: 'gruen', initial: 'P', alive: true, isMe: false, isAdmin: false, hidden: false },
    ],
  };
}

function fakeRelay(over = {}) {
  const calls = [];
  const replies = {
    'GET /api/v1/invites/open': () => ({ status: 200, json: { spaceId: SPACE, invites: [] } }),
    'POST /api/v1/members/remove': () => proofRequired(),
    'POST /api/v1/members/leave': () => ({ status: 200, json: { spaceId: SPACE, left: true, alreadyDeliveredIsIrrevocable: true } }),
    [`POST /api/v1/spaces/${SPACE}/delete`]: () => proofRequired({
      act: 'space.delete', reason: 'second_member_signature_required',
    }),
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
let applied = [];
let recoveryPort = null;

function mount({ circle = circleOf(), members = membersOf(), relay = fakeRelay(), lang = 'de',
  openRecovery = null } = {}) {
  i18n.setLang(lang);
  clipped = [];
  settingsWrites = [];
  applied = [];
  recoveryPort = openRecovery;
  admin.initAdminPanel({
    circle: () => circle,
    members: () => members,
    arm: async () => relay.transport,
    clipboard: (text) => { clipped.push(text); return Promise.resolve(); },
    setSettings: (patch) => { settingsWrites.push(patch); },
    persist: () => Promise.resolve(),
    reload: () => {},
    now: () => Date.now(),
    apply: (name, args) => { applied.push({ name, args }); return true; },
    adminSeat: () => ({ admin: circle.memberId, headOpId: 'AAAAAAAAAAAAAAAAAAAAAA', isMe: true }),
    afterRemove: null,
    // The one port the co-signature needs, and it is the one this file swaps for a REAL key pair
    // in §6. `null` here means „dieser Mac hat keinen Schlüssel", which is itself a tested state.
    openRecovery: async () => (recoveryPort ? recoveryPort() : null),
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

const topSheet = () => $$('.scrim').slice(-1)[0];
const topText = () => (topSheet() ? topSheet().querySelector('.sheet-body').textContent : '');
const topButtons = () => (topSheet() ? [...topSheet().querySelectorAll('.sheet-foot button')] : []);
const topBodyButtons = () => (topSheet() ? [...topSheet().querySelectorAll('.sheet-body button')] : []);
const memberRows = () => $$('.sheet [data-member]');
const byText = (list, s) => list.find((b) => b.textContent === s);
/** A `<textarea>`'s text is its VALUE — `topText()` cannot see the block, so this does. */
const topBlock = () => {
  const ta = topSheet() && topSheet().querySelector('.cosign-block');
  return ta ? ta.value : '';
};
/**
 * The toast, waited for rather than read.
 *
 * `ui.toast` reuses one node and schedules its own removal; under WebKit's headless timer
 * throttling a previous toast's 250 ms removal timer can fire across a new one. Reading the node
 * synchronously is therefore a race, and a test that reads a race is a test that goes red for
 * the wrong reason.
 */
const clearToast = () => { const n = document.querySelector('.toast'); if (n) n.remove(); };
const toastSays = (re) => waitFor(
  () => { const n = document.querySelector('.toast'); return n && re.test(n.textContent) ? n.textContent : null; },
  { timeout: 6000, what: `a toast matching ${re}` },
);

/** Drive „Entfernen" on one member row down to the confirmation's own confirm button. */
async function askToRemove(name = 'Mama', label = 'Entfernen') {
  clearToast();
  const row = memberRows().find((r) => r.textContent.includes(name));
  byText([...row.querySelectorAll('button')], label).click();
  await sleep(10);
  byText(topButtons(), label).click();
  await sleep(40);
}

/** A real P-256 recovery pair, in WebKit's own WebCrypto. */
async function realRecovery(memberId) {
  const pairs = await identity.generateRecoveryKeys();
  return {
    memberId,
    pub: pairs.recSig.publicKey,
    port: () => Promise.resolve({
      forStore: { memberId, deviceId: 'dev_x', deviceShort: 'shortshortshort1' },
      recovery: { recSig: pairs.recSig, recKex: pairs.recKex },
      minted: false,
    }),
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · THE BYTES — the mirror of `server/core/auth.js#adminProofString`
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§1a the signed string is exactly lzp/admin/2 + five newline-separated components', () => {
  // ⚠ THE LITERAL IS THE POINT. A tier-2 test cannot import `server/core/auth.js`, so this row
  // is the client's only structural pin on the relay's format. Edit the mirror and this dies
  // naming the exact string it must produce. The end-to-end control is the real relay: a wrong
  // byte here is a `401 bad_signature` and nothing happens.
  const s = cosign.adminProofString({
    act: 'member.remove', spaceId: 'fsp_x', target: 'mem_t', epoch: 7, presenter: 'mem_p',
  });
  assert.equal(s, 'lzp/admin/2\nmember.remove\nfsp_x\nmem_t\n7\nmem_p');
  assert.equal(s.split('\n').length, 6, 'six components, five separators');
  assert.equal(cosign.adminProofString({
    act: 'space.delete', spaceId: 'fsp_x', target: 'fsp_x', epoch: 1, presenter: 'mem_p',
  }), 'lzp/admin/2\nspace.delete\nfsp_x\nfsp_x\n1\nmem_p');
});

test('§1b the PRESENTER is in the bytes — T5-M4/N-3, a proof minted for one caller is bytes to another', () => {
  const base = { act: 'member.remove', spaceId: 'fsp_x', target: 'mem_t', epoch: 7 };
  const forPapa = cosign.adminProofString({ ...base, presenter: 'mem_papa' });
  const forEve = cosign.adminProofString({ ...base, presenter: 'mem_eve' });
  assert.notEqual(forPapa, forEve, 'the presenter binding was dropped — a bearer proof is back');
  assert.includes(forPapa, '\nmem_papa');
});

test('§1c a missing presenter THROWS rather than stringifying `undefined` into the bytes', () => {
  // The server's own version throws for exactly this reason: `undefined` in the string is an
  // unbound proof that verifies for anybody, which is the lzp/admin/1 hole the /2 bump closed.
  let threw = null;
  try {
    cosign.adminProofString({ act: 'member.remove', spaceId: 'fsp_x', target: 'mem_t', epoch: 7 });
  } catch (e) { threw = e; }
  assert.ok(threw, 'a proof was minted with no presenter');
  assert.match(String(threw.message), /presenter/);
  for (const k of ['act', 'spaceId', 'target']) {
    const bad = { act: 'member.remove', spaceId: 'fsp_x', target: 'mem_t', epoch: 7, presenter: 'mem_p' };
    delete bad[k];
    let t2 = null;
    try { cosign.adminProofString(bad); } catch (e) { t2 = e; }
    assert.ok(t2, `a proof was minted with no ${k}`);
  }
});

test('§1d the epoch is stringified as a number, never as whatever was passed', () => {
  assert.equal(cosign.adminProofString({
    act: 'member.remove', spaceId: 'fsp_x', target: 'mem_t', epoch: '7', presenter: 'mem_p',
  }), 'lzp/admin/2\nmember.remove\nfsp_x\nmem_t\n7\nmem_p');
  let threw = null;
  try {
    cosign.adminProofString({ act: 'member.remove', spaceId: 'f', target: 't', epoch: 1.5, presenter: 'p' });
  } catch (e) { threw = e; }
  assert.ok(threw, 'a fractional epoch was signed');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · THE TWO BLOCKS — readable on purpose, strict on paste
// ═════════════════════════════════════════════════════════════════════════════════════════════

const TERMS = Object.freeze({
  act: 'member.remove', spaceId: SPACE, target: MAMA, epoch: EPOCH, presenter: ME,
});
const SIG86 = 'A'.repeat(86);

test('§2a a request block is READABLE — the co-signer can see the circle and the person', () => {
  const text = cosign.encodeCosignRequest(TERMS);
  // Not base64. A blob would make her signature an act of trust in the asker, which is the one
  // thing a second signature exists to replace.
  assert.includes(text, 'LZP-COSIGN/2');
  assert.includes(text, `target ${MAMA}`);
  assert.includes(text, `space ${SPACE}`);
  assert.includes(text, `presenter ${ME}`);
  assert.includes(text, 'epoch 7');
  assert.deepEqual(cosign.parseCosignRequest(text), TERMS);
});

test('§2b the answer carries the terms back, so a mis-paste is a sentence and not a 401', () => {
  const text = cosign.encodeCosignature(TERMS, PAPA, SIG86);
  const parsed = cosign.parseCosignature(text);
  assert.ok(parsed, 'a well-formed co-signature did not parse');
  assert.equal(parsed.by, PAPA);
  assert.equal(parsed.sig, SIG86);
  assert.equal(cosign.sameTerms(parsed.terms, TERMS), true);
  assert.equal(cosign.sameTerms(parsed.terms, { ...TERMS, epoch: 8 }), false, 'a neighbouring epoch matched');
  assert.equal(cosign.sameTerms(parsed.terms, { ...TERMS, target: PAPA }), false, 'another target matched');
  assert.equal(cosign.sameTerms(parsed.terms, { ...TERMS, presenter: PAPA }), false, 'another presenter matched');
});

test('§2c the parser refuses everything that is not exactly one block', () => {
  const good = cosign.encodeCosignRequest(TERMS);
  const cases = {
    'empty': '',
    'prose': 'kannst du das bitte mitunterschreiben?',
    'wrong tag': good.replace('LZP-COSIGN/2', 'LZP-COSIGN/1'),
    'the answer tag': good.replace('LZP-COSIGN/2', 'LZP-COSIGNED/2'),
    'a missing term': good.split('\n').filter((l) => !l.startsWith('epoch')).join('\n'),
    'a duplicated term': `${good}\ntarget ${PAPA}`,
    'an extra key': `${good}\nrole admin`,
    'an unknown act': good.replace('member.remove', 'member.silence'),
    'a non-numeric epoch': good.replace('epoch 7', 'epoch sieben'),
    'a valueless line': `${good}\npresenter`,
    'an oversized id': good.replace(MAMA, 'm'.repeat(65)),
  };
  for (const [what, text] of Object.entries(cases)) {
    assert.equal(cosign.parseCosignRequest(text), null, `the parser accepted ${what}`);
  }
  // …and the honest-path control, so the row above cannot pass on a parser that returns null.
  assert.deepEqual(cosign.parseCosignRequest(`\n  ${good.split('\n').join('\n  ')}  \n`), TERMS,
    'the parser choked on the whitespace a mail client adds');
});

test('§2d a co-signature whose signer IS the presenter is refused at the paste', () => {
  // `verifyAdminProof` refuses `by === callerMemberId` before it spends a verification. Refusing
  // it here too is how the two people learn it from a sentence instead of from a 400.
  const selfSigned = cosign.encodeCosignature(TERMS, ME, SIG86);
  assert.equal(cosign.parseCosignature(selfSigned), null, 'a self-signed proof parsed');
  assert.ok(cosign.parseCosignature(cosign.encodeCosignature(TERMS, PAPA, SIG86)),
    'the control: a proof by somebody else still parses');
});

test('§2e a signature that is not 64 raw P-256 bytes never leaves this Mac', () => {
  for (const bad of ['', 'AAAA', 'A'.repeat(85), 'A'.repeat(87), `${'A'.repeat(85)}+`]) {
    let threw = null;
    try { cosign.encodeCosignature(TERMS, PAPA, bad); } catch (e) { threw = e; }
    assert.ok(threw, `a ${bad.length}-char signature was encoded`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · WHO MAY SIGN — the four refusals, without a key store
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§3a a request from THIS Mac is refused — one person on one Mac is the shape that must fail', () => {
  const me = { spaceId: SPACE, memberId: ME };
  assert.equal(cosign.cosignRefusal(TERMS, me), 'fromThisMac');
  // The control: the same request on the OTHER person's Mac is signable.
  assert.equal(cosign.cosignRefusal(TERMS, { spaceId: SPACE, memberId: PAPA }), null);
});

test('§3b the target is not asked to co-sign her own removal — F20, Principle 9', () => {
  // The relay WOULD take it: she is a live row and is not the caller. Refusing it is a UI
  // decision and the module says so; what it protects is the rule that a removal must not become
  // a place where members lobby one another.
  assert.equal(cosign.cosignRefusal(TERMS, { spaceId: SPACE, memberId: MAMA }), 'youAreMeant');
});

test('§3c a request for another circle, and a Mac with no key, are each their own sentence', () => {
  assert.equal(cosign.cosignRefusal(TERMS, { spaceId: 'fsp_other', memberId: PAPA }), 'otherCircle');
  assert.equal(cosign.cosignRefusal(TERMS, { spaceId: SPACE, memberId: '' }), 'noKeyHere');
  assert.equal(cosign.cosignRefusal(null, { spaceId: SPACE, memberId: PAPA }), 'unreadable');
  // Every reason names a `COSIGN_COPY` key in both languages, or the sheet renders `undefined`.
  for (const why of ['fromThisMac', 'youAreMeant', 'otherCircle', 'noKeyHere', 'unreadable']) {
    assert.equal(typeof cosign.COSIGN_COPY[why].de, 'string', `${why} has no German`);
    assert.equal(typeof cosign.COSIGN_COPY[why].en, 'string', `${why} has no English`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · THE ASKING SHEET — opened by the relay's own 403, on the relay's own terms
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4a a 403 admin_proof_required is not a failure — it opens the co-signature sheet', async () => {
  const relay = mount();
  await askToRemove();
  // The failure this replaces: „Das hat nicht geklappt" and a dead end, which is what a
  // founder-less circle met on every single removal before this screen existed.
  assert.equal(/Das hat nicht geklappt/.test(topText()), false, 'the gate was reported as a breakage');
  assert.includes(topText(), 'Die Person, die diesen Kreis angelegt hat, ist nicht mehr dabei');
  assert.includes(topBlock(), 'LZP-COSIGN/2');
  assert.equal(relay.calls.filter((c) => c.path === '/api/v1/members/remove').length, 1,
    'the un-proofed attempt was repeated');
  unmount();
});

test('§4b the sheet reads the ACT and the EPOCH out of the refusal, and never guesses them', async () => {
  mount({ relay: fakeRelay({
    'POST /api/v1/members/remove': () => proofRequired({ epoch: 41, reason: 'founder_removal_needs_second_key' }),
  }) });
  await askToRemove();
  const block = topBlock();
  assert.includes(block, 'epoch 41', 'the epoch was invented instead of read from the relay');
  assert.includes(block, 'act member.remove');
  // …and the reason it names is the one the relay gave, not the other one.
  assert.includes(topText(), 'die Person entfernen, die diesen Kreis angelegt hat');
  assert.equal(/nicht mehr dabei/.test(topText()), false, 'the wrong reason was explained');
  unmount();
});

test('§4c an unknown reason gets an honest fallback sentence, never silence and never a guess', async () => {
  mount({ relay: fakeRelay({
    'POST /api/v1/members/remove': () => proofRequired({ reason: 'some_future_rule' }),
  }) });
  await askToRemove();
  assert.includes(topText(), 'verlangt der Server die Unterschrift eines zweiten Mitglieds');
  assert.includes(topBlock(), 'LZP-COSIGN/2');
  unmount();
});

test('§4d the request block names THIS Mac as presenter and this member as target', async () => {
  mount();
  await askToRemove();
  const terms = cosign.parseCosignRequest(topBlock());
  assert.deepEqual(terms, { act: 'member.remove', spaceId: SPACE, target: MAMA, epoch: EPOCH, presenter: ME });
  unmount();
});

test('§4e a co-signature for ANOTHER step is refused locally and the relay is never called', async () => {
  const relay = mount();
  await askToRemove();
  const before = relay.calls.length;
  const paste = topSheet().querySelector('.cosign-paste');
  // Right shape, right signer, wrong target — the shape a second removal would produce if a
  // person tried to spend one co-signature twice (T5-M4).
  paste.value = cosign.encodeCosignature({ ...TERMS, target: PAPA }, PAPA, SIG86);
  clearToast();
  byText(topButtons(), 'Entfernen').click();
  await sleep(40);
  assert.equal(relay.calls.length, before, 'a proof for another act was sent to the relay');
  assert.includes(await toastSays(/anderen Schritt/), 'gehört zu einem anderen Schritt');
  assert.ok(topSheet().querySelector('.cosign-paste'), 'the sheet closed on a refusal');
  unmount();
});

test('§4f garbage in the paste field is a sentence, not a request', async () => {
  const relay = mount();
  await askToRemove();
  const before = relay.calls.length;
  topSheet().querySelector('.cosign-paste').value = 'ja mach mal';
  clearToast();
  byText(topButtons(), 'Entfernen').click();
  await sleep(40);
  assert.equal(relay.calls.length, before);
  assert.includes(await toastSays(/ganzen Text/), 'Bitte den ganzen Text einfügen');
  unmount();
});

test('§4g the accepted proof reaches the wire as {by, sig} — and the PRESENTER is not in the body', async () => {
  const relay = mount({ relay: fakeRelay({
    'POST /api/v1/members/remove': (body) => (body && body.adminProof ? removed200 : proofRequired()),
  }) });
  await askToRemove();
  topSheet().querySelector('.cosign-paste').value = cosign.encodeCosignature(TERMS, PAPA, SIG86);
  clearToast();
  byText(topButtons(), 'Entfernen').click();
  await waitFor(() => relay.calls.filter((c) => c.path === '/api/v1/members/remove').length === 2,
    { what: 'the proofed removal' });

  const sent = relay.calls.filter((c) => c.path === '/api/v1/members/remove')[1].body;
  assert.deepEqual(Object.keys(sent).sort(), ['adminProof', 'memberId', 'spaceId']);
  assert.deepEqual(Object.keys(sent.adminProof).sort(), ['by', 'sig']);
  assert.equal(sent.adminProof.by, PAPA);
  // ⚠ THE ONE THE CONTRACT IS EXPLICIT ABOUT. The relay assembles act/space/target/epoch/presenter
  // from values it already holds; a presenter in a body field would be a claim it had to trust.
  for (const forbidden of ['presenter', 'act', 'epoch', 'target', 'by', 'sig', 'proof', 'role', 'admin']) {
    assert.equal(forbidden in sent, false, `the body carried ${forbidden}`);
  }
  assert.includes(await toastSays(/Mama ist nicht mehr im Kreis/), 'Mama ist nicht mehr im Kreis');
  unmount();
});

test('§4h THE HONEST-PATH CONTROL — a removal the relay allows never opens the sheet', async () => {
  // Without this row every assertion above would also pass on a screen that demanded a
  // co-signature for everything, which would be a worse product and a passing suite.
  const relay = mount({ relay: fakeRelay({
    'POST /api/v1/members/remove': () => removed200,
  }) });
  await askToRemove();
  assert.equal($$('.scrim').length, 1, 'an ordinary removal opened a co-signature sheet');
  const sent = relay.calls.find((c) => c.path === '/api/v1/members/remove').body;
  assert.deepEqual(sent, { spaceId: SPACE, memberId: MAMA }, 'an un-proofed removal grew a field');
  unmount();
});

test('§4i a 403 that is NOT admin_proof_required is still the calm sentence', async () => {
  mount({ relay: fakeRelay({
    'POST /api/v1/members/remove': () => ({ status: 403, json: { error: 'not_a_member' } }),
  }) });
  await askToRemove();
  assert.equal(/LZP-COSIGN/.test(topText() + topBlock()), false, 'a not_a_member 403 asked for a co-signature');
  assert.includes(await toastSays(/nichts geändert/), 'Am Kreis hat sich nichts geändert');
  unmount();

  // ⚠ ASSERTED ON THE PURE FUNCTION TOO, and this row exists because a MUTANT survived without
  // it. Dropping the `error` check let a `not_a_member` 403 through, and nothing visible broke:
  // the sheet threw out of its own builder before `openSheet` appended a scrim, so the screen
  // refused BY ACCIDENT. A refusal by accident is not a refusal.
  assert.equal(cosign.proofDemand({ body: { error: 'not_a_member' } }), null);
  assert.equal(cosign.proofDemand({ body: { error: 'bad_signature', epoch: 7 } }), null);
  assert.equal(cosign.proofDemand({ status: 403 }), null);
  // …and a demand with no usable epoch is not one either: the epoch is a SIGNED component, so a
  // proof over bytes the relay never named could not verify on any relay.
  assert.equal(cosign.proofDemand({ body: { error: 'admin_proof_required' } }), null);
  assert.equal(cosign.proofDemand({ body: { error: 'admin_proof_required', epoch: 'bald' } }), null);
  // The control, so the four absences above cannot pass on a function that always answers null.
  assert.ok(cosign.proofDemand({ body: { error: 'admin_proof_required', epoch: 7, reason: 'x' } }));
});

test('§4j the already-removed 400 is a SUCCESS synonym — never „das hat nicht geklappt"', async () => {
  // T5-M4's stated cost: a proofed removal whose response was lost and is retried gets this 400
  // instead of the 200 no-op, and `handlers/lifecycle.js` carries the contract that a client
  // renders it as „ist bereits entfernt".
  const relay = mount({ relay: fakeRelay({
    'POST /api/v1/members/remove': (body) => (body && body.adminProof
      ? { status: 400, json: { error: 'bad_request', field: 'adminProof', reason: 'admin_proof_target_already_removed', alreadyRemoved: true } }
      : proofRequired()),
  }) });
  await askToRemove();
  topSheet().querySelector('.cosign-paste').value = cosign.encodeCosignature(TERMS, PAPA, SIG86);
  clearToast();
  byText(topButtons(), 'Entfernen').click();
  await waitFor(() => relay.calls.filter((c) => c.path === '/api/v1/members/remove').length === 2,
    { what: 'the proofed retry' });
  const said = await toastSays(/Mama war schon|nicht geklappt/);
  assert.includes(said, 'Mama war schon nicht mehr im Kreis');
  assert.equal(/nicht geklappt/.test(said), false, 'a finished removal was reported as a failure');
  unmount();
});

test('§4k a 401 on the proof is its own named outcome, and the sheet stays open', async () => {
  const relay = mount({ relay: fakeRelay({
    'POST /api/v1/members/remove': (body) => (body && body.adminProof
      ? { status: 401, json: { error: 'bad_signature', check: 'admin_proof' } }
      : proofRequired()),
  }) });
  await askToRemove();
  const scrims = $$('.scrim').length;
  topSheet().querySelector('.cosign-paste').value = cosign.encodeCosignature(TERMS, PAPA, SIG86);
  clearToast();
  byText(topButtons(), 'Entfernen').click();
  await waitFor(() => relay.calls.filter((c) => c.path === '/api/v1/members/remove').length === 2,
    { what: 'the refused proof' });
  await sleep(30);
  assert.equal($$('.scrim').length, scrims, 'a refused co-signature closed the sheet anyway');
  assert.includes(await toastSays(/anerkannt/), 'nicht anerkannt');
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · THE UNSATISFIABLE CIRCLE — the caveat, met as a sentence and never as a 403
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§5a in a two-member circle the sheet says so plainly and offers no request to copy', async () => {
  // T5-M3's stated cost: once the founder is gone, a two-member circle cannot remove anybody —
  // the only possible co-signer is the target. The person must meet that as a sentence.
  mount({ members: membersOf([
    { memberId: ME, displayName: 'Manuel', colorRef: 'violett', initial: 'M', alive: true, isMe: true, isAdmin: true },
    { memberId: MAMA, displayName: 'Mama', colorRef: 'magenta', initial: 'M', alive: true, isMe: false, isAdmin: false },
  ]) });
  await askToRemove();
  assert.includes(topText(), 'ist niemand, der mitunterschreiben könnte');
  assert.includes(topText(), 'Gehen kann jede und jeder von euch weiterhin');
  assert.equal(topBlock(), '', 'a request nobody can answer was offered');
  assert.equal(byText(topButtons(), 'Entfernen'), undefined, 'a button that cannot succeed was offered');
  unmount();
});

test('§5b …and the same circle carries the caveat STANDING, before anybody is stuck in it', () => {
  mount({ members: membersOf([
    { memberId: ME, displayName: 'Manuel', colorRef: 'violett', initial: 'M', alive: true, isMe: true, isAdmin: true },
    { memberId: MAMA, displayName: 'Mama', colorRef: 'magenta', initial: 'M', alive: true, isMe: false, isAdmin: false },
  ]) });
  const text = $('.sheet-body').textContent;
  assert.includes(text, 'kann niemand mehr jemanden entfernen');
  assert.includes(text, 'Die Boards bleiben dabei vollständig.');
  unmount();
  // The control: a circle of three is NOT nagged about a state it is two departures away from.
  mount();
  assert.equal(/kann niemand mehr jemanden entfernen/.test($('.sheet-body').textContent), false,
    'a healthy circle was warned about the two-member rule');
  unmount();
});

test('§5c leaving a circle of three warns the two who stay — the shipped path into the state', () => {
  const three = cosign.consequencesOf('leave', 'de', { leavesTwoBehind: true });
  assert.equal(three.length, 3);
  assert.includes(three[2], 'Danach sind noch zwei Menschen im Kreis');
  assert.includes(three[2], 'nicht mehr gegenseitig entfernen');
  assert.includes(cosign.consequencesOf('leave', 'en', { leavesTwoBehind: true })[2],
    'can no longer remove each other');
  // It is a CONDITION, never a claim: this Mac cannot know whether the founder is still here,
  // because the relay does not publish `founderMemberId`.
  assert.match(three[2], /Falls/);
  // And it stays conditional on the count — the existing two- and three-line shapes are untouched.
  assert.equal(cosign.consequencesOf('leave', 'de', {}).length, 2);
  assert.equal(cosign.consequencesOf('leave', 'de', { isAdmin: true }).length, 3);
});

test('§5d an UNKNOWN co-signer count is NOT zero — an unmounted member view must not strand a family', () => {
  // `eligibleCosigners` answers `null` when this Mac's member view is not mounted. Rendering that
  // as „niemand kann mitunterschreiben" would tell a five-person family it was stuck, so the
  // sheet is driven directly here: through the panel this state has no removable row to click.
  const port = Object.freeze({ spaceId: SPACE, copy: () => Promise.resolve(), myMemberId: () => ME, nameOf: () => '' });
  const spec = { port, kind: 'remove', demand: { reason: 'founder_gone_every_removal_needs_second_key' },
    terms: TERMS, onConfirm: () => {} };

  const unknown = cosign.openCosignRequest({ ...spec, eligible: null });
  assert.includes(unknown.body.querySelector('.cosign-block').value, 'LZP-COSIGN/2',
    'an unknown count was rendered as „nobody"');
  assert.equal(/ist niemand, der mitunterschreiben könnte/.test(unknown.body.textContent), false);
  unknown.close();

  // …and the paired presence: a real zero DOES produce the sentence and no block.
  const zero = cosign.openCosignRequest({ ...spec, eligible: 0 });
  assert.includes(zero.body.textContent, 'ist niemand, der mitunterschreiben könnte');
  assert.equal(zero.body.querySelector('.cosign-block'), null);
  zero.close();
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 · THE SIGNING SHEET — a real key, on the other Mac
// ═════════════════════════════════════════════════════════════════════════════════════════════

function openSigner() {
  byText($$('.sheet button'), 'Mitunterschrift geben').click();
}

test('§6a a real recovery key signs the real bytes, and the signature VERIFIES', async () => {
  // The strongest row in this file. WebKit's own WebCrypto mints a P-256 pair, the sheet signs a
  // pasted request with it, and the signature is verified against the public key over the exact
  // string §1a pins — which is the string `verifyAdminProof` recomputes on the relay.
  const rec = await realRecovery(PAPA);
  mount({ circle: circleOf({ memberId: PAPA, role: 'member' }), openRecovery: rec.port });
  openSigner();
  await sleep(10);
  const paste = topSheet().querySelector('.cosign-paste');
  paste.value = cosign.encodeCosignRequest(TERMS);
  paste.dispatchEvent(new Event('input'));
  // What am I signing? Answered before the button, from THIS Mac's member list.
  assert.includes(topText(), 'Manuel bittet darum, Mama aus dem Familienkreis zu entfernen.');

  byText(topButtons(), 'Mitunterschreiben').click();
  await waitFor(() => topSheet().querySelector('.cosign-block'), { what: 'the co-signature' });

  const answer = cosign.parseCosignature(topBlock());
  assert.ok(answer, 'the minted co-signature does not parse');
  assert.equal(answer.by, PAPA, 'the signer is not this Mac’s own member');
  assert.equal(cosign.sameTerms(answer.terms, TERMS), true);
  const ok = await identity.verifyBytes(
    rec.pub, b64.ub64(answer.sig), TE.encode(cosign.adminProofString(TERMS)),
  );
  assert.equal(ok, true, 'the co-signature does not verify over lzp/admin/2 — the relay would 401');
  // …and it does NOT verify over neighbouring bytes: the binding is real, not decorative.
  const wrong = await identity.verifyBytes(
    rec.pub, b64.ub64(answer.sig), TE.encode(cosign.adminProofString({ ...TERMS, presenter: PAPA })),
  );
  assert.equal(wrong, false, 'the signature covers bytes it should not — the presenter is unbound');
  unmount();
});

test('§6b the signing sheet REFUSES a request that came from this Mac — before anything is signed', async () => {
  const rec = await realRecovery(ME);
  mount({ openRecovery: rec.port });
  openSigner();
  await sleep(10);
  const paste = topSheet().querySelector('.cosign-paste');
  paste.value = cosign.encodeCosignRequest(TERMS);           // presenter === ME
  paste.dispatchEvent(new Event('input'));
  assert.includes(topText(), 'Diese Anfrage kommt von diesem Mac');
  clearToast();
  byText(topButtons(), 'Mitunterschreiben').click();
  await sleep(40);
  assert.equal(topSheet().querySelector('.cosign-block'), null,
    'one person on one Mac produced a co-signature for herself');
  assert.includes(await toastSays(/eigenen/), 'nur seinen eigenen');
  unmount();
});

test('§6c …and refuses when the pasted request is about ME, and when it is another circle', async () => {
  const rec = await realRecovery(MAMA);
  mount({ circle: circleOf({ memberId: MAMA, role: 'member' }), openRecovery: rec.port });
  openSigner();
  await sleep(10);
  const paste = topSheet().querySelector('.cosign-paste');
  paste.value = cosign.encodeCosignRequest(TERMS);           // target === MAMA
  paste.dispatchEvent(new Event('input'));
  assert.includes(topText(), 'Hier geht es um dich');
  assert.includes(topText(), 'Kreis verlassen');

  paste.value = cosign.encodeCosignRequest({ ...TERMS, spaceId: 'fsp_somewhere_else', target: PAPA });
  paste.dispatchEvent(new Event('input'));
  assert.includes(topText(), 'gehört zu einem anderen Kreis');
  byText(topButtons(), 'Mitunterschreiben').click();
  await sleep(40);
  assert.equal(topSheet().querySelector('.cosign-block'), null, 'a foreign circle was co-signed');
  unmount();
});

test('§6d a Mac with no recovery key says so, and mints nothing', async () => {
  mount({ circle: circleOf({ memberId: PAPA, role: 'member' }), openRecovery: null });
  openSigner();
  await sleep(10);
  const paste = topSheet().querySelector('.cosign-paste');
  paste.value = cosign.encodeCosignRequest(TERMS);
  paste.dispatchEvent(new Event('input'));
  clearToast();
  byText(topButtons(), 'Mitunterschreiben').click();
  await sleep(60);
  assert.equal(topSheet().querySelector('.cosign-block'), null, 'a keyless Mac produced a signature');
  assert.includes(await toastSays(/keinen Schlüssel/), 'keinen Schlüssel für einen Familienkreis');
  unmount();
});

test('§6e the entry point is EVERY member’s, not the admin’s — the gate does not know about roles', () => {
  // The relay has no role column and the rule is a two-ROW rule. Hiding the one control that
  // makes it satisfiable behind an `isAdmin` flag would leave a founder-less circle unable to
  // co-sign at all.
  mount({ circle: circleOf({ role: 'member' }) });
  assert.ok(byText($$('.sheet button'), 'Mitunterschrift geben'), 'a plain member cannot co-sign');
  assert.equal(byText($$('.sheet button'), 'Entfernen'), undefined, 'a plain member got the admin verbs');
  // …and it opens a SHEET rather than growing a field, so a non-admin section still draws no input.
  assert.equal($('.sheet input[type="text"]'), null);
  unmount();
});

test('§6f the co-signer reads the names from her OWN member list, never from the pasted text', async () => {
  // A name in text somebody else wrote is a name somebody else chose for the person you are
  // about to act against. An id she cannot resolve is shown as the id — information, not fiction.
  const rec = await realRecovery(PAPA);
  mount({ circle: circleOf({ memberId: PAPA, role: 'member' }), openRecovery: rec.port,
    members: membersOf([
      { memberId: PAPA, displayName: 'Papa', colorRef: 'gruen', initial: 'P', alive: true, isMe: true, isAdmin: false },
      { memberId: ME, displayName: 'Manuel', colorRef: 'violett', initial: 'M', alive: true, isMe: false, isAdmin: true },
    ]) });
  openSigner();
  await sleep(10);
  const paste = topSheet().querySelector('.cosign-paste');
  paste.value = `${cosign.encodeCosignRequest(TERMS)}`;
  paste.dispatchEvent(new Event('input'));
  // MAMA is not on this Mac's list, so her id is shown rather than a name from the block.
  assert.includes(topText(), `Manuel bittet darum, ${MAMA} aus dem Familienkreis zu entfernen.`);
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7 · PRINCIPLE 9 — one person asks, one person signs, and nothing else happens
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§7a the whole co-signature round trip makes ZERO network calls and writes ZERO settings', async () => {
  // This is the property that makes the flow not a surveillance surface AND the property that
  // stops one person scripting the second half: there is nothing to script. The only request in
  // the flow is the act itself.
  const rec = await realRecovery(PAPA);
  const relay = mount({ circle: circleOf({ memberId: PAPA, role: 'member' }), openRecovery: rec.port });
  const before = relay.calls.length;
  openSigner();
  await sleep(10);
  const paste = topSheet().querySelector('.cosign-paste');
  paste.value = cosign.encodeCosignRequest(TERMS);
  paste.dispatchEvent(new Event('input'));
  byText(topButtons(), 'Mitunterschreiben').click();
  await waitFor(() => topSheet().querySelector('.cosign-block'), { what: 'the co-signature' });
  byText(topBodyButtons(), 'Mitunterschrift kopieren').click();
  await sleep(20);

  assert.equal(relay.calls.length, before, 'the co-signature flow talked to the relay');
  assert.deepEqual(settingsWrites, [], 'the co-signature flow wrote settings');
  assert.deepEqual(applied, [], 'the co-signature flow authored an op');
  assert.equal(clipped.length, 1, 'the control: the copy button did work');
  assert.includes(clipped[0], 'LZP-COSIGNED/2');
  unmount();
});

test('§7b nothing in the flow notifies, broadcasts, counts votes or lists pending requests', () => {
  const leaves = [];
  const walk = (v) => {
    if (typeof v === 'string') leaves.push(v);
    else if (typeof v === 'function') { try { leaves.push(String(v('X', 'Y'))); } catch { /* arity */ } }
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k]);
  };
  walk(cosign.COSIGN_COPY);
  assert.ok(leaves.length > 40, `the walker stopped working: ${leaves.length} strings`);
  const forbidden = [
    // Careful: „benachrichtigt niemanden" is the sentence we WANT, so the pattern matches only
    // affirmative promises of a notification.
    /(wir|wird|werden) (sie |ihn |das mitglied )?benachrichtig/i,
    /(will be|are|gets?) notified|we notify|notifies (them|the member)/i,
    /abstimm|vote|stimme[nt]? ab|mehrheit|majority/i,
    /alle mitglieder sehen|everyone (will )?sees? (that|this request)/i,
    /offene anfragen|pending requests/i,
    /überwach|monitor|surveil/i,
  ];
  for (const s of leaves) {
    for (const re of forbidden) {
      assert.equal(re.test(s), false, `Principle 9 contradicted by: ${JSON.stringify(s)}`);
    }
  }
  // The paired PRESENCE — an absence asserted alone passes on an empty constant.
  assert.ok(leaves.some((s) => /geht über keinen Server und benachrichtigt niemanden/.test(s)));
  assert.ok(leaves.some((s) => /goes over no server and notifies nobody/.test(s)));
});

test('§7c the asking sheet never names anybody but the two people already on screen', async () => {
  mount();
  await askToRemove();
  // Papa is a live third member and is not mentioned: the sheet does not tell the asker whom to
  // lobby, and the request block names only the space, the target and the asker.
  assert.equal(topText().includes(PAPA), false, 'the sheet suggested who to ask');
  assert.equal(topText().includes('Papa'), false);
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §8 · THE COPY — PROVES / PROVES_NOT, in the relay's own words, in both languages
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§8a the screen says what is proven — ROWS — and never claims two PEOPLE', () => {
  // `handlers/lifecycle.js` exports PROVES / PROVES_NOT for exactly this reason: "so no screen is
  // ever built on „von zwei Personen bestätigt" when the relay only counted rows".
  const leaves = [];
  const walk = (v) => {
    if (typeof v === 'string') leaves.push(v);
    else if (typeof v === 'function') { try { leaves.push(String(v('X', 'Y'))); } catch { /* arity */ } }
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k]);
  };
  walk(cosign.COSIGN_COPY);
  const overclaims = [
    /von zwei (Personen|Menschen) (bestätigt|unterschrieben|freigegeben)/i,
    /zwei Menschen haben (unterschrieben|bestätigt)/i,
    /(confirmed|approved|signed) by two (people|humans|persons)/i,
    /beweist,? dass zwei/i,
    /proves that two (people|humans)/i,
    /der Verwalter hat (zugestimmt|unterschrieben)/i,
    /the admin (approved|signed)/i,
  ];
  for (const s of leaves) {
    for (const re of overclaims) {
      assert.equal(re.test(s), false, `the screen claims more than the relay checks: ${JSON.stringify(s)}`);
    }
  }
  // The strong sentence is about member RECORDS…
  assert.match(cosign.COSIGN_COPY.proves.de, /Mitglieds-Einträge/);
  assert.match(cosign.COSIGN_COPY.proves.en, /member records/);
  // …and the honest half is never dropped, in either language.
  assert.match(cosign.COSIGN_COPY.provesNot.de, /nicht sehen, ob hinter zwei Mitglieds-Einträgen auch zwei Menschen/);
  assert.match(cosign.COSIGN_COPY.provesNot.de, /wer den Kreis verwaltet/);
  assert.match(cosign.COSIGN_COPY.provesNot.en, /whether two member records mean two humans/);
  assert.match(cosign.COSIGN_COPY.provesNot.en, /who manages the circle/);
});

test('§8b both sentences are ON BOTH SHEETS — the strong one is never shown alone', async () => {
  const rec = await realRecovery(PAPA);
  mount({ circle: circleOf({ memberId: PAPA, role: 'member' }), openRecovery: rec.port });
  openSigner();
  await sleep(10);
  assert.includes(topText(), 'Der Server kann nicht sehen, ob hinter zwei Mitglieds-Einträgen');
  assert.includes(topText(), 'er zählt Einträge, er kennt euch nicht');
  unmount();

  mount();
  await askToRemove();
  assert.includes(topText(), 'zwei verschiedene Mitglieds-Einträge dieses Kreises');
  assert.includes(topText(), 'Der Server kann nicht sehen, ob hinter zwei Mitglieds-Einträgen');
  assert.includes(topText(), 'gilt für genau diesen einen Schritt und ist danach verbraucht');
  unmount();
});

test('§8c every leaf of COSIGN_COPY exists in BOTH languages — 13.7', () => {
  let pairs = 0;
  const walk = (v, path) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.includes('de') || keys.includes('en')) {
        pairs++;
        assert.deepEqual(keys.sort(), ['de', 'en'], `${path} is not a complete {de,en} pair`);
        assert.equal(typeof v.de, typeof v.en, `${path}: de and en are different shapes`);
        return;
      }
      for (const k of keys) walk(v[k], `${path}.${k}`);
    }
  };
  walk(cosign.COSIGN_COPY, 'COSIGN_COPY');
  assert.ok(pairs > 20, `the walker stopped working: ${pairs} pairs`);
});

test('§8d the English sheet is complete — no German leaks through', async () => {
  mount({ lang: 'en' });
  await askToRemove('Mama', 'Remove');
  assert.includes(topText(), 'The person who created this circle is no longer in it');
  assert.includes(topText(), 'Pass this text to another member');
  assert.includes(topText(), 'This Mac cannot do that for somebody else');
  assert.includes(topText(), 'it counts records; it does not know you');
  assert.ok(byText(topButtons(), 'Remove'), 'the English sheet kept a German button');
  unmount();
  i18n.setLang('de');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §9 · 20.4 — deleting a circle, which has NEVER been possible through this UI
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§9a the delete asks for a second key, and the body keeps `confirm` beside the proof', async () => {
  // `POST /spaces/:id/delete` requires the proof whenever the space has ever had more than one
  // member row — every real Familienkreis, always. The typed confirmation was never enough.
  const relay = mount({ relay: fakeRelay({
    [`POST /api/v1/spaces/${SPACE}/delete`]: (body) => (body && body.adminProof
      ? { status: 200, json: { spaceId: SPACE, deleted: true, localBoardsUnaffected: true, authorizedBy: 'admin_proof' } }
      : proofRequired({ act: 'space.delete', reason: 'second_member_signature_required' })),
  }) });
  byText($$('.sheet button'), 'Kreis löschen').click();
  await sleep(10);
  topSheet().querySelector('input[type="text"]').value = 'Familie Weber';
  byText(topButtons(), 'Endgültig löschen').click();
  await sleep(60);

  assert.includes(topText(), 'Ein Familienkreis gehört der Familie');
  const terms = cosign.parseCosignRequest(topBlock());
  // The target of a `space.delete` proof is the SPACE — `handlers/lifecycle.js`: `target: spaceId`.
  assert.deepEqual(terms, { act: 'space.delete', spaceId: SPACE, target: SPACE, epoch: EPOCH, presenter: ME });

  topSheet().querySelector('.cosign-paste').value = cosign.encodeCosignature(terms, PAPA, SIG86);
  byText(topButtons(), 'Endgültig löschen').click();
  await waitFor(() => relay.calls.filter((c) => /delete/.test(c.path)).length === 2, { what: 'the proofed delete' });
  const sent = relay.calls.filter((c) => /delete/.test(c.path))[1].body;
  assert.deepEqual(Object.keys(sent).sort(), ['adminProof', 'confirm']);
  assert.equal(sent.confirm, SPACE);
  assert.deepEqual(Object.keys(sent.adminProof).sort(), ['by', 'sig']);
  unmount();
});

test('§9b a co-signature minted for the DELETE cannot be spent on a removal — T5-M4', () => {
  const del = { act: 'space.delete', spaceId: SPACE, target: SPACE, epoch: EPOCH, presenter: ME };
  const rm = { act: 'member.remove', spaceId: SPACE, target: MAMA, epoch: EPOCH, presenter: ME };
  assert.equal(cosign.sameTerms(del, rm), false);
  assert.notEqual(cosign.adminProofString(del), cosign.adminProofString(rm));
  // …and the asking sheet checks all five before it sends, which §4e drives end to end.
  assert.equal(cosign.sameTerms(cosign.parseCosignature(cosign.encodeCosignature(del, PAPA, SIG86)).terms, rm), false);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §10 · no back door
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§10a the co-signature reaches nothing on window, and no module leaks a signer', () => {
  const leaked = Object.keys(globalThis).filter((k) => /cosign|adminproof|recovery/i.test(k));
  assert.deepEqual(leaked, [], `a global leaked: ${leaked.join(', ')}`);
  assert.equal(typeof cosign.openCosignRequest, 'function');
  assert.equal(typeof cosign.openCosignSign, 'function');
  // The signing capability is a PORT on the admin panel, not an export anybody can call: the
  // only private key reachable from this flow is the one in this Mac's own key store.
  assert.equal(typeof cosign.coSign, 'undefined');
  assert.equal(typeof admin.coSign, 'undefined');
});
