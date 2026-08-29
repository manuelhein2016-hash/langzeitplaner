// TIER 2 · the pairing screens, both ends — LZP-503. Story 19.5, deliverable 21.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IS REAL IN THIS FILE
// ═════════════════════════════════════════════════════════════════════════════
//
// Everything except the network. The protocol below is `src/js/crypto/pairing.js` — the shipped
// module, in a real WKWebView, over the real WebCrypto: real 60-bit codes, real HKDF, real
// ephemeral P-256 ECDH, a real six-digit SAS, a real AES-GCM key transfer, and real recovery
// keys and space keys crossing between two sessions that share nothing but a relay.
//
// The relay is a `Map` (§1). That is not a shortcut: ADR 002 §6.1 makes the relay the ADVERSARY,
// so a `Map` the test writes into by hand is a *stronger* model than a mocked HTTP client — the
// test can drop a message, replay one, or hand a screen an answer that came from somewhere else,
// which is what `pairing-sas.dom.js` does next door.
//
// What is NOT under test here and is deliberately not duplicated: the protocol's own properties.
// `tests/tier1/crypto-pairing.test.js` owns the code space, the burn counter, the AAD binding and
// the payload rules. THIS file owns the half tier 1 structurally cannot see — what a person is
// looking at, in which language, which control is where, and, mostly, what is NOT on screen.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE FLOW PORT IS A REFERENCE IMPLEMENTATION, AND IT IS BUILT HERE ON PURPOSE
// ═════════════════════════════════════════════════════════════════════════════
//
// `pairingui.js` renders a `PairingView` handed to it by a flow (LZP-505 owns the real one: the
// relay round trips, the polling, the retry). §2 below is a complete, honest flow over the real
// session object — about sixty lines. Building it inside the test does two things: it proves the
// port is implementable rather than merely declared, and it means the screens in this file are
// driven by states the REAL state machine produced, never by a hand-written `{state:'sas'}`.
//
// There is no `window.__lzpPairing` and no query parameter. The UI is mounted the way the app
// will mount it — by calling its exported `initPairingUI`, from inside the page, which is a thing
// only code that is already part of the module graph can do. Test 0 keeps that true.

const ui = await importApp('family/pairingui.js');
const i18n = await importApp('i18n.js');
const pairing = await importApp('crypto/pairing.js');
const identity = await importApp('crypto/identity.js');
const spacekeys = await importApp('crypto/spacekeys.js');
const ids = await importApp('core/ids.js');

const S = crypto.subtle;
const RANDOM = (n) => crypto.getRandomValues(new Uint8Array(n));

// ═════════════════════════════════════════════════════════════════════════════
// 1 · a clock the test owns, and a relay the test owns
// ═════════════════════════════════════════════════════════════════════════════

/** Injected everywhere, so the 180 s TTL and the SAS look-delay are test time, not wall time. */
function fakeClock(start = 1_800_000_000_000) {
  let t = start;
  const timers = [];
  return {
    now: () => t,
    schedule: (ms, fn) => {
      const h = { at: t + ms, fn, dead: false };
      timers.push(h);
      return h;
    },
    unschedule: (h) => { if (h) h.dead = true; },
    /** Move time forward and fire what fell due, in order, allowing a timer to re-arm itself. */
    advance(ms) {
      t += ms;
      for (let guard = 0; guard < 64; guard++) {
        const due = timers.filter((x) => !x.dead && x.at <= t).sort((a, b) => a.at - b.at);
        if (!due.length) return;
        due[0].dead = true;
        due[0].fn();
      }
    },
  };
}

/** ADR 002 §6.1's untrusted rendezvous, as three slots per `rid`. Nothing here is authenticated. */
function makeRelay() {
  const slots = new Map();
  const at = (rid) => {
    if (!slots.has(rid)) slots.set(rid, { offer: null, answer: null, deliver: null });
    return slots.get(rid);
  };
  return {
    slots,
    putOffer: (rid, v) => { at(rid).offer = v; },
    getOffer: (rid) => at(rid).offer,
    putAnswer: (rid, v) => { at(rid).answer = v; },
    getAnswer: (rid) => at(rid).answer,
    putDeliver: (rid, v) => { at(rid).deliver = v; },
    getDeliver: (rid) => at(rid).deliver,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 2 · the reference flow — the port `pairingui.js` declares, implemented
// ═════════════════════════════════════════════════════════════════════════════

const EMPTY = Object.freeze({
  role: null, state: 'init', display: null, sas: null, selfShort: null, peerShort: null,
  attemptsRemaining: 5, expiresAt: null, busy: false, errorCode: null,
});

/**
 * A box that is well-formed and cannot open: 12 IV bytes, 18 ciphertext bytes, no valid tag.
 * A relay with no rendezvous at that `rid` must be INDISTINGUISHABLE from a relay handing back a
 * tampered box — ADR 002 §6.2 counts failed opens, and `openPairBox` is deliberately an oracle
 * for nothing. So the flow feeds the session a box rather than short-circuiting on a `null`
 * lookup, and the attempt counter comes down either way.
 */
const UNOPENABLE = 'AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBB';

/**
 * @param {object} relay
 * @param {{identity?:object, keyring?:object, selfShort?:string, ports:object}} deps
 */
function makeFlow(relay, deps) {
  let session = null;
  let rid = null;
  let restored = null;
  let view = EMPTY;
  const subs = new Set();
  const calls = [];

  const set = (patch) => {
    view = Object.freeze({ ...view, ...patch });
    for (const f of [...subs]) { try { f(view); } catch { /* a screen error is not a flow error */ } }
  };
  const sync = () => {
    if (!session) return;
    set({ state: session.state(), role: session.role(), sas: session.sas(),
          attemptsRemaining: session.attemptsRemaining(),
          peerShort: session.peer()?.deviceShort ?? view.peerShort });
  };
  const guard = async (fn) => {
    set({ busy: true, errorCode: null });
    try {
      await fn();
      set({ busy: false });
      sync();
    } catch (e) {
      set({ busy: false, errorCode: e && e.code ? e.code : 'unknown' });
      sync();
    }
  };

  return {
    calls,
    session: () => session,
    snapshot: () => view,
    subscribe(f) { subs.add(f); return () => subs.delete(f); },

    async start(role) {
      calls.push(`start:${role}`);
      // RE-OPENING A SCREEN MUST NOT RESTART THE PROTOCOL. `openPairingScreen()` calls `start()`
      // every time, deliberately — a screen that showed a code no session had minted would be a
      // screen showing a code that cannot work. So idempotence belongs on this side: a live
      // session is resumed, and only a terminal one (or none) mints a new rendezvous. Getting
      // this wrong is invisible in a single-screen test and fatal across two Macs, because the
      // second `beginAsExisting()` would publish a second offer under a second `rid`.
      if (session && !['delivered', 'received', 'refused', 'expired', 'burned', 'failed'].includes(session.state())) {
        sync();
        return;
      }
      session = pairing.createPairingSession(deps.identity ?? null, deps.keyring ?? null, deps.ports);
      set({ ...EMPTY, role, selfShort: deps.selfShort ?? null });
      if (role !== 'existing') { sync(); return; }
      await guard(async () => {
        const r = await session.beginAsExisting();
        rid = r.rid;
        relay.putOffer(rid, r.boxA);
        set({ display: r.display, expiresAt: deps.ports.now() + pairing.PAIRING.ttlMs });
      });
    },

    async submitCode(typed) {
      calls.push(`submitCode:${typed}`);
      await guard(async () => {
        const derived = await pairing.derivePairing(typed, deps.ports);
        const r = await session.answerAsNew(typed, relay.getOffer(derived.rid) ?? UNOPENABLE);
        rid = r.rid;
        relay.putAnswer(rid, r.boxB);
        set({ peerShort: r.peer.deviceShort });
        await session.confirmNew();
      });
    },

    async confirmMatch(ok) {
      calls.push(`confirmMatch:${ok}`);
      await guard(async () => {
        session.confirmSasMatch(ok);
        if (session.state() !== 'confirmed') return;
        // Only the existing device acts on its own confirmation. The new device has nothing to
        // open until the other Mac's human has confirmed too, which is what `pumpNew()` is for —
        // and it is why 'confirmed' is a state the screen has to be able to sit in.
        if (view.role === 'existing') relay.putDeliver(rid, await session.deliver());
      });
    },

    async cancel() {
      calls.push('cancel');
      // A session that has not started, or has already ended, has nothing to refuse — the port
      // contract says `cancel()` is idempotent, and this is what that means in practice.
      try { if (session && session.state() === 'sas') session.confirmSasMatch(false); } catch { /* terminal */ }
      set({ state: session ? session.state() : 'failed' });
    },

    // ── test affordances, outside the port ──────────────────────────────────
    /** The existing device polls for the answer. LZP-505 owns the real cadence. */
    async pumpExisting() {
      const boxB = relay.getAnswer(rid);
      if (!boxB) return false;
      await guard(async () => {
        const r = await session.confirmExisting(boxB);
        set({ peerShort: r.peer.deviceShort });
      });
      return true;
    },
    /** The new device polls for the transfer. */
    async pumpNew() {
      const blob = relay.getDeliver(rid);
      if (!blob) return false;
      await guard(async () => { restored = await session.receive(blob); });
      return true;
    },
    restored: () => restored,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 3 · two real identities, one real key ring
// ═════════════════════════════════════════════════════════════════════════════

async function makeExistingIdentity() {
  const dev = await identity.generateDeviceKeys();
  const rec = await identity.generateRecoveryKeys();
  const sigRaw = await identity.exportRawPublic(dev.devSig.publicKey);
  return {
    memberId: ids.memberId(RANDOM),
    deviceId: ids.deviceId(RANDOM),
    deviceShort: identity.deviceShortOf(sigRaw),
    devSig: dev.devSig,
    devKex: dev.devKex,
    recSig: rec.recSig,
    recKex: rec.recKex,
  };
}

/** Epoch 1 of a real personal space. 19.4: the second Mac must be able to read epoch 1. */
async function makeKeyring() {
  const sp = ids.spaceId('personal', RANDOM);
  const k1 = await spacekeys.createSpaceKey({ subtle: S, random: RANDOM });
  return { personal: { spaceId: sp, epochs: { 1: k1 } }, family: null };
}

// ═════════════════════════════════════════════════════════════════════════════
// 4 · the harness
// ═════════════════════════════════════════════════════════════════════════════

let clock = null;

/** Mount the UI over a flow, exactly the way `familysettings.js` will. */
function mount(flow, c) {
  clock = c;
  ui.initPairingUI({ port: flow, now: c.now, schedule: c.schedule, unschedule: c.unschedule });
}

function unmount() {
  ui.initPairingUI({});
  i18n.setLang('de');
}

const screen = () => $('.pair');
/** The code node exists from the first paint; it carries `.pending` until the session has one. */
const codeReady = () => {
  const n = $('#pair-code');
  return !!n && !n.classList.contains('pending');
};
const txt = () => (screen() ? screen().textContent : '');
const btn = (sel) => $(sel, screen());

// ═════════════════════════════════════════════════════════════════════════════
// 0 · the seam is a seam
// ═════════════════════════════════════════════════════════════════════════════

test('the shipped page exposes no pairing hook a page script could reach', () => {
  // A settable pairing flow is a settable "here are my private keys". The module is reachable
  // only from the module graph — i.e. from code we wrote — and nothing global may shortcut that.
  for (const k of ['__lzpPairing', '__lzpPairingUI', '__lzpPairFlow', 'pairing', 'pairingUI', 'pairFlow']) {
    assert.equal(window[k], undefined, `window.${k} must not exist`);
  }
  // A shape test, so no future name slips past: nothing on `window` may quack like the flow port.
  const quacks = Object.getOwnPropertyNames(window).filter((k) => {
    let v;
    try { v = window[k]; } catch { return false; }
    return v && typeof v === 'object'
      && typeof v.snapshot === 'function' && typeof v.confirmMatch === 'function';
  });
  assert.deepEqual(quacks, [], `these globals quack like a pairing flow: ${quacks.join(', ')}`);
  assert.equal(ui.pairingSupported(), false, 'nothing is mounted until someone mounts it');
});

// ═════════════════════════════════════════════════════════════════════════════
// 1 · the existing Mac shows a real code
// ═════════════════════════════════════════════════════════════════════════════

test('the code on screen is the code the session minted, formatted XXXX-XXXX-XXXX', async () => {
  const c = fakeClock();
  const relay = makeRelay();
  const idA = await makeExistingIdentity();
  const flow = makeFlow(relay, {
    identity: idA, keyring: await makeKeyring(), selfShort: idA.deviceShort,
    ports: { subtle: S, random: RANDOM, now: c.now },
  });
  mount(flow, c);
  ui.openPairingScreen({ role: 'existing' });
  await waitFor(codeReady, { what: 'the code' });

  const shown = $('#pair-code').textContent;
  assert.match(shown, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
    `not a Crockford code: ${shown}`);
  // The screen did not invent it. Deriving the rid from what is on screen must find the offer
  // the session actually published — which is only true if the two are the same twelve chars.
  const typed = shown.split('-').join('');
  const { rid } = await pairing.derivePairing(typed, { subtle: S, random: RANDOM, now: c.now });
  assert.ok(relay.getOffer(rid), 'the code on screen does not open the rendezvous it claims');
  // Crockford excludes I, L, O and U — a person reading this across a desk must not meet a 1/I.
  assert.equal(/[ILOU]/.test(typed), false, `the code contains an excluded letter: ${typed}`);

  ui.closePairingScreen({ silent: true });
  unmount();
});

test('the countdown counts the 180 s down and says so when it is spent', async () => {
  const c = fakeClock();
  const relay = makeRelay();
  const idA = await makeExistingIdentity();
  const flow = makeFlow(relay, {
    identity: idA, keyring: await makeKeyring(), selfShort: idA.deviceShort,
    ports: { subtle: S, random: RANDOM, now: c.now },
  });
  mount(flow, c);
  ui.openPairingScreen({ role: 'existing' });
  await waitFor(codeReady, { what: 'the code' });

  assert.equal(ui.formatCountdown(180000), '3:00');
  assert.equal(ui.formatCountdown(61000), '1:01');
  assert.equal(ui.formatCountdown(-5), '0:00');

  c.advance(1000);
  assert.match($('#pair-countdown').textContent, /2:5\d/, 'the countdown did not tick');
  assert.equal($('#pair-countdown').classList.contains('spent'), false);

  c.advance(180000);
  assert.equal($('#pair-countdown').classList.contains('spent'), true, 'a spent code must say so');
  assert.includes($('#pair-countdown').textContent, i18n.t('pairCodeExpiredNow'));

  ui.closePairingScreen({ silent: true });
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 2 · the new Mac types the code — and mistypes it
// ═════════════════════════════════════════════════════════════════════════════

test('the input folds what a human types onto the one canonical spelling', () => {
  // `crockNormalize`'s rules, seen from the field: separators go, case folds, I/L -> 1, O -> 0.
  // `U` is NOT folded — Crockford reserves it, so a `U` is an error and guessing at it would
  // derive a different rid and present as "the code is wrong" on a correctly typed code.
  assert.equal(ui.formatCodeInput('x4b2 q7km 9tzn'), 'X4B2-Q7KM-9TZN');
  assert.equal(ui.formatCodeInput('X4B2-Q7KM-9TZN'), 'X4B2-Q7KM-9TZN');
  assert.equal(ui.formatCodeInput('iIlLoO'), '1111-00');
  assert.equal(ui.formatCodeInput('x4b'), 'X4B');
  assert.equal(ui.formatCodeInput('x4b2q'), 'X4B2-Q');
  // Anything the alphabet does not contain is dropped rather than shown — including `U`.
  assert.equal(ui.formatCodeInput('X4B2-Q7KM-9TZ!'), 'X4B2-Q7KM-9TZ');
  assert.equal(ui.formatCodeInput('UUUU'), '');
  // Over-long input is truncated at twelve characters, never at fourteen with the separators.
  assert.equal(ui.codeChars(ui.formatCodeInput('X4B2Q7KM9TZNEXTRA')).length, 12);
  assert.equal(ui.formatCodeInput(null), '');
  assert.equal(ui.formatCodeInput(undefined), '');
});

test('the Weiter button is dead until twelve characters are in the field', async () => {
  const c = fakeClock();
  const relay = makeRelay();
  const flow = makeFlow(relay, { ports: { subtle: S, random: RANDOM, now: c.now } });
  mount(flow, c);
  ui.openPairingScreen({ role: 'new' });
  await waitFor(() => $('#pair-input'), { what: 'the code field' });

  const input = $('#pair-input');
  const go = btn('.pair-go');
  assert.equal(go.disabled, true, 'an empty field must not offer Weiter');

  input.value = 'X4B2Q7KM9TZ';           // eleven
  input.dispatchEvent(new Event('input'));
  assert.equal(go.disabled, true, 'eleven characters is not a pairing code');
  assert.equal(input.value, 'X4B2-Q7KM-9TZ', 'the field did not group as it filled');

  input.value = 'X4B2-Q7KM-9TZN';        // twelve
  input.dispatchEvent(new Event('input'));
  assert.equal(go.disabled, false, 'twelve characters must be submittable');
  // And the flow was told nothing at all yet — typing is not submitting.
  assert.deepEqual(flow.calls.filter((x) => x.startsWith('submitCode')), []);

  ui.closePairingScreen({ silent: true });
  unmount();
});

test('a wrong code reports the failure and counts the attempt down — and keeps what was typed', async () => {
  const c = fakeClock();
  const relay = makeRelay();
  const idA = await makeExistingIdentity();
  const ports = { subtle: S, random: RANDOM, now: c.now };
  const A = makeFlow(relay, { identity: idA, keyring: await makeKeyring(), selfShort: idA.deviceShort, ports });
  await A.start('existing');

  const B = makeFlow(relay, { ports });
  mount(B, c);
  ui.openPairingScreen({ role: 'new' });
  await waitFor(() => $('#pair-input'), { what: 'the code field' });

  // A code with the right SHAPE and the wrong VALUE. It cannot open the offer — and, by design,
  // a wrong code and a tampered box are the same GCM failure, so the screen must not pretend to
  // know which it was.
  const wrong = 'ZZZZ-ZZZZ-ZZZZ';
  $('#pair-input').value = wrong;
  $('#pair-input').dispatchEvent(new Event('input'));
  btn('.pair-go').click();
  await waitFor(() => $('.pair-wrong'), { what: 'the failure line' });

  assert.includes($('.pair-wrong').textContent, i18n.t('pairEnterWrong'));
  assert.includes($('.pair-wrong').textContent, i18n.t('pairAttemptsLeft', 4));
  // The screen does NOT say "wrong code" as a fact about the code — it says it does not match,
  // which is the only thing that is true.
  assert.equal(/falsch|invalid|error|Fehler/i.test($('.pair-wrong').textContent), false,
    'the failure line must not claim to know why');
  // Five characters of a twelve-character random code is a lot to retype for a typo.
  assert.equal($('#pair-input').value, wrong, 'the typed code was thrown away after one attempt');

  ui.closePairingScreen({ silent: true });
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 3 · the whole thing, end to end, with the real keys crossing
// ═════════════════════════════════════════════════════════════════════════════

test('a full pairing: both screens show the SAME six digits, and the keys actually arrive', async () => {
  const c = fakeClock();
  const relay = makeRelay();
  const ports = { subtle: S, random: RANDOM, now: c.now };
  const idA = await makeExistingIdentity();
  const ring = await makeKeyring();
  const A = makeFlow(relay, { identity: idA, keyring: ring, selfShort: idA.deviceShort, ports });
  const B = makeFlow(relay, { ports });

  // ── Mac 1 ────────────────────────────────────────────────────────────────
  mount(A, c);
  ui.openPairingScreen({ role: 'existing' });
  await waitFor(codeReady, { what: 'the code' });
  const code = $('#pair-code').textContent.split('-').join('');
  ui.closePairingScreen({ silent: true });

  // ── Mac 2 types it ───────────────────────────────────────────────────────
  mount(B, c);
  ui.openPairingScreen({ role: 'new' });
  await waitFor(() => $('#pair-input'), { what: 'the code field' });
  $('#pair-input').value = code;
  $('#pair-input').dispatchEvent(new Event('input'));
  btn('.pair-go').click();
  await waitFor(() => $('#pair-sas'), { what: "Mac 2's SAS screen" });

  const sasB = $('#pair-sas').textContent;
  assert.match(sasB, /^\d{3} \d{3}$/, `the SAS must be six digits, 3 + 3: ${sasB}`);
  // Both machine ids are on screen — a relay cannot forge either, and pairing with a Mac you do
  // not recognise is worth seeing before the keys move rather than after.
  assert.includes($('.pair-who').textContent, idA.deviceShort);

  // The affirmative is inert until the digits have been up for `sasMinLookMs`. §3 of
  // `pairing-sas.dom.js` is where that property is attacked; here it is only stepped over.
  c.advance(ui.PAIR_UI.sasMinLookMs);
  await waitFor(() => btn('.pair-sas-yes') && !btn('.pair-sas-yes').disabled, { what: 'the armed Ja' });
  btn('.pair-sas-yes').click();
  await waitFor(() => B.session().state() === 'confirmed', { what: "Mac 2's confirmation" });
  ui.closePairingScreen({ silent: true });

  // ── Mac 1 sees the answer and shows ITS digits ───────────────────────────
  mount(A, c);
  ui.openPairingScreen({ role: 'existing' });
  await waitFor(codeReady, { what: "Mac 1's code screen" });
  await A.pumpExisting();
  await waitFor(() => $('#pair-sas'), { what: "Mac 1's SAS screen" });

  const sasA = $('#pair-sas').textContent;
  // THE PROPERTY THE WHOLE SCREEN EXISTS FOR. No MITM: the two shared secrets agree, so the two
  // screens agree, and the human who compares them sees one number twice.
  assert.equal(sasA, sasB, 'an honest run must put the SAME digits on both screens');
  assert.includes($('.pair-who').textContent, B.session().newDeviceKeys().deviceShort);

  c.advance(ui.PAIR_UI.sasMinLookMs);
  await waitFor(() => btn('.pair-sas-yes') && !btn('.pair-sas-yes').disabled, { what: 'the armed Ja' });
  btn('.pair-sas-yes').click();
  await waitFor(() => A.session().state() === 'delivered', { what: 'the key transfer' });
  await waitFor(() => $('.pair-title')?.textContent === i18n.t('pairDoneTitle'), { what: "Mac 1's done screen" });
  ui.closePairingScreen({ silent: true });

  // ── Mac 2 opens the transfer ─────────────────────────────────────────────
  mount(B, c);
  assert.equal(B.session().state(), 'confirmed', 'Mac 2 has said yes and is waiting');
  await B.pumpNew();
  assert.equal(B.session().state(), 'received');

  const restored = B.restored();
  assert.equal(restored.memberId, idA.memberId,
    'the second Mac must join the SAME member — a device is a machine, not a person');
  assert.equal(restored.personal.spaceId, ring.personal.spaceId);
  // 19.4 — "my ENTIRE board, including private entries". Epoch 1 has to be in there, or the
  // second Mac shows a half-empty year in March.
  const epochs = restored.personal.epochs instanceof Map
    ? [...restored.personal.epochs.keys()]
    : Object.keys(restored.personal.epochs).map(Number);
  assert.deepEqual(epochs.sort(), [1]);
  // And the key that arrived is the key that left: encrypt on Mac 1, decrypt on Mac 2.
  const iv = RANDOM(12);
  const secret = new TextEncoder().encode('Omas Geburtstag');
  const ct = await S.encrypt({ name: 'AES-GCM', iv }, ring.personal.epochs[1], secret);
  const got = restored.personal.epochs instanceof Map
    ? restored.personal.epochs.get(1)
    : restored.personal.epochs[1];
  const back = new Uint8Array(await S.decrypt({ name: 'AES-GCM', iv }, got, ct));
  assert.equal(new TextDecoder().decode(back), 'Omas Geburtstag');

  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 4 · the four terminal states, and the one sentence they share
// ═════════════════════════════════════════════════════════════════════════════

test('every stopped state says the same load-bearing thing: nothing was transferred', async () => {
  for (const [state, key] of [
    ['refused', 'pairStoppedRefused'],
    ['expired', 'pairStoppedExpired'],
    ['burned', 'pairStoppedBurned'],
    ['failed', 'pairStoppedFailed'],
  ]) {
    const c = fakeClock();
    // A view straight from the flow. The four states come out of the real state machine in
    // `crypto-pairing.test.js`; what is under test here is what a person is told when they do.
    let view = Object.freeze({ ...EMPTY, role: 'new', state });
    const flow = {
      snapshot: () => view,
      subscribe: () => () => {},
      start: async () => {},
      submitCode: async () => {},
      confirmMatch: async () => {},
      cancel: async () => {},
    };
    mount(flow, c);
    ui.openPairingScreen({ role: 'new' });
    await waitFor(() => $('.pair-title'), { what: `the ${state} screen` });

    assert.equal($('.pair-title').textContent, i18n.t('pairStoppedTitle'), `${state}: wrong title`);
    assert.includes(txt(), i18n.t(key), `${state}: the specific sentence is missing`);
    // The one sentence that matters in all four cases, and the reason none of them is alarming.
    assert.includes(txt(), i18n.t('pairStoppedNothing'), `${state}: must say nothing moved`);
    // A dead end offers a way out. Reusing a terminal session is what the protocol refuses, so
    // the way out is a NEW one.
    assert.ok(btn('.pair-ok'), `${state}: no way to start again`);
    assert.equal(btn('.pair-ok').textContent, i18n.t('pairRestart'));
    ui.closePairingScreen({ silent: true });
    unmount();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 5 · both languages — 13.7
// ═════════════════════════════════════════════════════════════════════════════

test('every screen exists in German and English, and the toggle is on the screen itself', async () => {
  const c = fakeClock();
  const relay = makeRelay();
  const idA = await makeExistingIdentity();
  const flow = makeFlow(relay, {
    identity: idA, keyring: await makeKeyring(), selfShort: idA.deviceShort,
    ports: { subtle: S, random: RANDOM, now: c.now },
  });
  mount(flow, c);
  ui.openPairingScreen({ role: 'existing' });
  await waitFor(codeReady, { what: 'the code' });

  assert.includes(txt(), 'Diesen Code auf dem neuen Mac eintippen');
  // A reader who cannot read this screen cannot reach Settings to change the language — the same
  // argument LZP-106's unlock screen makes, and it is stronger here: this screen is modal.
  const toggle = btn('.pair-lang');
  assert.equal(toggle.textContent, 'English');
  toggle.click();
  await waitFor(() => btn('.pair-lang')?.textContent === 'Deutsch', { what: 'the language swap' });
  assert.includes(txt(), 'Type this code into the new Mac');
  // The code itself is not a string in a table — it must survive the swap unchanged.
  assert.match($('#pair-code').textContent, /^[0-9A-HJKMNP-TV-Z]{4}-/);

  // Every key this package added resolves in both languages and is genuinely translated.
  const keys = [
    'pairKicker', 'pairSectionTitle', 'pairAddDevice', 'pairHaveCode', 'pairSectionHint',
    'pairCodeTitle', 'pairCodeLead', 'pairCodeWaiting', 'pairCodeWhy', 'pairCodeExpiredNow',
    'pairEnterTitle', 'pairEnterLead', 'pairEnterLabel', 'pairEnterSubmit', 'pairEnterWrong',
    'pairEnterWhy', 'pairSasTitle', 'pairSasLead', 'pairSasWhy', 'pairSasWait', 'pairSasNo',
    'pairSasUnsure', 'pairWorkingTitle', 'pairWorking', 'pairDoneTitle', 'pairDoneExisting',
    'pairDoneNew', 'pairStoppedTitle', 'pairStoppedRefused', 'pairStoppedExpired',
    'pairStoppedBurned', 'pairStoppedFailed', 'pairStoppedNothing', 'pairRestart',
    'pairCancel', 'pairClose', 'pairUnsupported',
  ];
  const de = {};
  i18n.setLang('de');
  for (const k of keys) {
    de[k] = i18n.t(k);
    assert.notEqual(de[k], k, `de.${k} fell through to the key name`);
  }
  i18n.setLang('en');
  for (const k of keys) {
    const v = i18n.t(k);
    assert.notEqual(v, k, `en.${k} fell through to the key name`);
    assert.notEqual(v, de[k], `${k} is identical in both tables — an untranslated leftover`);
  }
  // The three sentences that take an argument, in both languages.
  for (const lang of ['de', 'en']) {
    i18n.setLang(lang);
    assert.includes(i18n.t('pairSasYes', '472 913'), '472 913');
    assert.includes(i18n.t('pairCodeExpiresIn', '2:59'), '2:59');
    assert.notEqual(i18n.t('pairAttemptsLeft', 1), i18n.t('pairAttemptsLeft', 4),
      `${lang}: one attempt and four attempts read the same`);
  }

  ui.closePairingScreen({ silent: true });
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 6 · the settings doorway (A10)
// ═════════════════════════════════════════════════════════════════════════════

test('the settings section is a doorway and nothing else — no code, no keys, no digits', async () => {
  const c = fakeClock();
  const relay = makeRelay();
  const idA = await makeExistingIdentity();
  const flow = makeFlow(relay, {
    identity: idA, keyring: await makeKeyring(), selfShort: idA.deviceShort,
    ports: { subtle: S, random: RANDOM, now: c.now },
  });
  mount(flow, c);

  const body = document.createElement('div');
  ui.buildPairingSection(body, { rebuild: () => {}, close: () => {} });
  assert.includes(body.textContent, i18n.t('pairSectionTitle'));
  assert.includes(body.textContent, i18n.t('pairAddDevice'));
  assert.includes(body.textContent, i18n.t('pairHaveCode'));
  // Both ends are reachable from one place: this Mac might be either of them.
  assert.equal($$('button', body).length, 2);
  // No code, no digits, no key material anywhere in the sheet.
  assert.equal(/\d{6}/.test(body.textContent), false, 'six digits in the settings sheet');
  assert.equal(body.querySelector('#pair-code'), null);

  // Unmounted, the whole feature is ABSENT rather than broken — the browser-preview case.
  unmount();
  const body2 = document.createElement('div');
  ui.buildPairingSection(body2, { rebuild: () => {}, close: () => {} });
  assert.includes(body2.textContent, i18n.t('pairUnsupported'));
  assert.equal($$('button', body2).length, 0, 'a doorway to nowhere must have no door');
});

// ═════════════════════════════════════════════════════════════════════════════
// 7 · the screen leaves nothing behind
// ═════════════════════════════════════════════════════════════════════════════

test('closing removes the surface, the key handler and the body class', async () => {
  const c = fakeClock();
  const relay = makeRelay();
  const idA = await makeExistingIdentity();
  const flow = makeFlow(relay, {
    identity: idA, keyring: await makeKeyring(), selfShort: idA.deviceShort,
    ports: { subtle: S, random: RANDOM, now: c.now },
  });
  mount(flow, c);
  ui.openPairingScreen({ role: 'existing' });
  await waitFor(codeReady, { what: 'the screen' });
  assert.equal(document.body.classList.contains('pair-on'), true);
  assert.equal(ui.pairingScreenOpen(), true);

  ui.closePairingScreen();
  assert.equal($('.pair'), null, 'the surface is still in the document');
  assert.equal(document.body.classList.contains('pair-on'), false);
  assert.equal(ui.pairingScreenOpen(), false);

  // Escape after closing must not reach a dead handler — a listener left on `window` in capture
  // phase would eat the board's own Escape chain (main.js:300) for the rest of the session.
  let boardSawIt = false;
  const spy = () => { boardSawIt = true; };
  window.addEventListener('keydown', spy);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  window.removeEventListener('keydown', spy);
  assert.equal(boardSawIt, true, 'a stale capture-phase handler is still swallowing Escape');

  unmount();
});

test('the styles are injected exactly once, whatever happens', async () => {
  const c = fakeClock();
  const relay = makeRelay();
  const idA = await makeExistingIdentity();
  const flow = makeFlow(relay, {
    identity: idA, keyring: await makeKeyring(), selfShort: idA.deviceShort,
    ports: { subtle: S, random: RANDOM, now: c.now },
  });
  mount(flow, c);
  for (let i = 0; i < 3; i++) {
    ui.openPairingScreen({ role: 'existing' });
    await waitFor(codeReady, { what: 'the screen' });
    ui.closePairingScreen({ silent: true });
  }
  assert.equal($$(`#${ui.PAIR_CSS_ID}`).length, 1, 'the stylesheet was injected more than once');
  // It is a temporary home for these rules (see the module header). If it ever moves into
  // app.css, this assertion is the thing that says so out loud.
  assert.ok(ui.PAIR_CSS.includes('.pair-sas'), 'PAIR_CSS no longer carries the SAS rules');
  unmount();
});
