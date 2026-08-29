// TIER 2 · the SAS comparison — LZP-503. ADR 002 §0 (T4), §6.2, §6.4. Story 19.5.
//
// ═════════════════════════════════════════════════════════════════════════════
// THIS FILE GUARDS THE ONLY MITM DEFENCE IN THE PRODUCT
// ═════════════════════════════════════════════════════════════════════════════
//
// ADR 002 §6.4 ends with a boxed warning, and it is addressed to whoever reads this next:
//
//   > 19.5's "both-ends confirmation" is load-bearing, not decorative. A downstream agent who
//   > "simplifies" pairing by auto-confirming when the boxes decrypt has removed the only MITM
//   > defence in the product. The SAS screen is not skippable and not defaulted to „Ja".
//
// `tests/tier1/crypto-pairing.test.js` guards the protocol half of that: `confirmSasMatch()`
// takes exactly `true`, and a forced auto-confirm hands the relay every key. What it cannot see
// is the screen — and the screen is where the defence actually is, because the defence is *a
// person looking at the other Mac*. So this file attacks the screen, and it attacks it in the
// only two ways that matter:
//
//   §1-§5  THE FIVE PROPERTIES `pairingui.js`'s header commits to, each asserted as the negative:
//          the affirmative is not the default, it restates the digits, it is inert before the
//          human can have looked, every other exit refuses, and `confirmMatch(true)` happens
//          exactly once and only from the one deliberate click.
//   §6     A REAL ACTIVE MITM. Not a mock: two more sessions, a relay that knows the code, and
//          four genuine ECDH agreements. The two screens are then rendered from the two real
//          sessions and the digits on them are compared — which is precisely what the human is
//          being asked to do, done by the test.
//
// §6 is the one that would have caught the failure §6.4 is warning about, because a screen that
// auto-confirms passes §1-§5 by accident and fails §6 by construction.

const ui = await importApp('family/pairingui.js');
const i18n = await importApp('i18n.js');
const pairing = await importApp('crypto/pairing.js');
const identity = await importApp('crypto/identity.js');
const spacekeys = await importApp('crypto/spacekeys.js');
const ids = await importApp('core/ids.js');
const { CROCKFORD_ALPHABET } = await importApp('core/b64.js');

const S = crypto.subtle;
const RANDOM = (n) => crypto.getRandomValues(new Uint8Array(n));

// ═════════════════════════════════════════════════════════════════════════════
// 0 · scaffolding
// ═════════════════════════════════════════════════════════════════════════════

function fakeClock(start = 1_800_000_000_000) {
  let t = start;
  const timers = [];
  return {
    now: () => t,
    schedule: (ms, fn) => { const h = { at: t + ms, fn, dead: false }; timers.push(h); return h; },
    unschedule: (h) => { if (h) h.dead = true; },
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

async function makeIdentity() {
  const dev = await identity.generateDeviceKeys();
  const rec = await identity.generateRecoveryKeys();
  const sigRaw = await identity.exportRawPublic(dev.devSig.publicKey);
  return {
    memberId: ids.memberId(RANDOM), deviceId: ids.deviceId(RANDOM),
    deviceShort: identity.deviceShortOf(sigRaw),
    devSig: dev.devSig, devKex: dev.devKex, recSig: rec.recSig, recKex: rec.recKex,
  };
}

async function makeKeyring() {
  return {
    personal: {
      spaceId: ids.spaceId('personal', RANDOM),
      epochs: { 1: await spacekeys.createSpaceKey({ subtle: S, random: RANDOM }) },
    },
    family: null,
  };
}

/**
 * A random port whose FIRST 12-byte draw is a chosen pairing code.
 *
 * `generatePairingCode` masks each byte to five bits and indexes the Crockford alphabet, so the
 * byte that produces a character is that character's index. Everything after the first draw is
 * real randomness, so the attacker's IV and its own ephemeral key are genuinely random — the only
 * thing being forced is the one thing §6.4 assumes the attacker already has: the code.
 */
function randomForcingCode(code) {
  let spent = false;
  return (n) => {
    if (!spent && n === pairing.PAIRING.codeChars) {
      spent = true;
      return Uint8Array.from([...code].map((ch) => CROCKFORD_ALPHABET.indexOf(ch)));
    }
    return RANDOM(n);
  };
}

/**
 * The thinnest possible flow over an ALREADY-DRIVEN session: it renders what the session says and
 * records every `confirmMatch` argument. The protocol steps are taken by the test, so the screen
 * under test is looking at real session state and nothing else.
 */
function viewOf(session, over = {}) {
  const calls = [];
  const subs = new Set();
  let extra = { selfShort: null, peerShort: null, ...over };
  const snapshot = () => Object.freeze({
    role: session.role(), state: session.state(), display: null, sas: session.sas(),
    selfShort: extra.selfShort, peerShort: extra.peerShort ?? session.peer()?.deviceShort ?? null,
    attemptsRemaining: session.attemptsRemaining(), expiresAt: null, busy: false, errorCode: null,
  });
  const notify = () => { for (const f of [...subs]) f(snapshot()); };
  return {
    calls,
    snapshot,
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
    async start() { notify(); },
    async submitCode() { notify(); },
    async confirmMatch(ok) { calls.push(ok); session.confirmSasMatch(ok); notify(); },
    async cancel() { calls.push('cancel'); notify(); },
  };
}

/** Two honest sessions, driven as far as the SAS on both sides. */
async function honestPair(clock) {
  const ports = { subtle: S, random: RANDOM, now: clock.now };
  const idA = await makeIdentity();
  const A = pairing.createPairingSession(idA, await makeKeyring(), ports);
  const B = pairing.createPairingSession(null, null, ports);
  const offer = await A.beginAsExisting();
  const answer = await B.answerAsNew(offer.code, offer.boxA);
  await A.confirmExisting(answer.boxB);
  await B.confirmNew();
  return { A, B, idA, code: offer.code, ports };
}

const screen = () => $('.pair');
const btn = (sel) => $(sel, screen());

function mount(flow, clock) {
  ui.initPairingUI({ port: flow, now: clock.now, schedule: clock.schedule, unschedule: clock.unschedule });
}
function unmount() {
  ui.initPairingUI({});
  i18n.setLang('de');
}

/** Open the SAS screen for one already-SAS session and arm the affirmative. */
async function showSas(session, clock, over) {
  const flow = viewOf(session, over);
  mount(flow, clock);
  ui.openPairingScreen({ role: session.role() });
  await waitFor(() => $('#pair-sas'), { what: 'the SAS screen' });
  return flow;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1 · PROPERTY 1 — the affirmative is not the default
// ═════════════════════════════════════════════════════════════════════════════

test('the refusal comes first, holds focus, and Enter cannot confirm', async () => {
  const clock = fakeClock();
  const { B } = await honestPair(clock);
  const flow = await showSas(B, clock);

  const buttons = $$('.pair-sas-acts button', screen());
  assert.equal(buttons.length, 2, 'the SAS screen must offer exactly two answers');
  // DOM order is tab order. Mashing Tab-then-Space, or Shift-Tab into the last control, must land
  // on the refusal — the safe direction.
  assert.equal(buttons[0].className, 'pair-sas-no', 'the refusal must be the first control');
  assert.equal(buttons[1].className, 'pair-sas-yes', 'the affirmative must be the last control');
  assert.equal(document.activeElement, buttons[0], 'focus must land on the refusal');
  assert.equal(buttons[1].hasAttribute('autofocus'), false);

  // Enter, with focus where the screen put it, must not confirm. (WebKit clicks a focused button
  // on Enter — which is exactly why WHICH button holds focus is a security property here.)
  buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(flow.calls.includes(true), false, 'Enter confirmed the pairing');

  // The affirmative carries no accent styling: the board's „Heute" gradient and the primary fill
  // both say "this is the way forward", and this is not a way forward — it is a claim about a
  // number. A future restyle that reaches for `btn-primary` here trips this.
  for (const cls of ['btn-primary', 'btn-today', 'quiet-dot', 'ub-act']) {
    assert.equal(buttons[1].classList.contains(cls), false, `the affirmative styled as ${cls}`);
  }
  assert.equal($$('.pair-body-sas .btn-primary', screen()).length, 0);

  ui.closePairingScreen({ silent: true });
  unmount();
});

test('nothing on the SAS screen moves — a pulsing number is a spinner with a smaller footprint', async () => {
  const clock = fakeClock();
  const { B } = await honestPair(clock);
  await showSas(B, clock);

  for (const sel of ['#pair-sas', '.pair-sas-yes', '.pair-sas-no', '.pair-body-sas']) {
    const cs = getComputedStyle($(sel, screen()));
    assert.equal(cs.animationName, 'none', `${sel} animates`);
  }
  // And nothing was drawn on the board. 19.3's "never a spinner on the board" is a rule about
  // where this product is allowed to put motion, and pairing does not get an exception.
  assert.equal($('.board .pair, .board [class*="pair-"]'), null, 'the pairing screen reached the board');

  ui.closePairingScreen({ silent: true });
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 2 · PROPERTY 2 — the label restates the digits
// ═════════════════════════════════════════════════════════════════════════════

test('the Ja button names the number, so agreeing to it is a claim about that number', async () => {
  const clock = fakeClock();
  const { B } = await honestPair(clock);
  await showSas(B, clock);
  clock.advance(ui.PAIR_UI.sasMinLookMs);
  await waitFor(() => !btn('.pair-sas-yes').disabled, { what: 'the armed Ja' });

  const digits = B.sas();
  assert.match(digits, /^\d{6}$/);
  assert.equal($('#pair-sas').textContent, ui.formatSas(digits), 'the digits are shown 3 + 3');
  assert.includes(btn('.pair-sas-yes').textContent, ui.formatSas(digits),
    'the affirmative does not name the number it is agreeing to');
  // „OK" / „Weiter" / „Ja" alone would be a generic dismissal. It must be a sentence.
  assert.ok(btn('.pair-sas-yes').textContent.length > 10);
  // The refusal is plain and unambiguous, and it is not phrased as "cancel" — the user is
  // reporting an observation, not giving up.
  assert.equal(btn('.pair-sas-no').textContent, i18n.t('pairSasNo'));

  // A screen reader hears six digits, not one six-digit number.
  assert.equal($('#pair-sas').getAttribute('aria-label'), digits.split('').join(' '));

  ui.closePairingScreen({ silent: true });
  unmount();
});

test('the honest sentence is on the screen, in both languages', async () => {
  const clock = fakeClock();
  const { B } = await honestPair(clock);
  await showSas(B, clock);
  // §6.4 in one paragraph, where the person is. Not a warning box and not red: the screen states
  // what this click is for.
  assert.includes(screen().textContent, i18n.t('pairSasWhy'));
  assert.includes(screen().textContent, i18n.t('pairSasUnsure'));
  btn('.pair-lang').click();
  await waitFor(() => btn('.pair-lang')?.textContent === 'Deutsch', { what: 'the language swap' });
  assert.includes(screen().textContent, 'These six digits are the only thing');
  assert.includes(screen().textContent, i18n.t('pairSasWhy'));
  // The digits do not change with the language.
  assert.equal($('#pair-sas').textContent, ui.formatSas(B.sas()));
  ui.closePairingScreen({ silent: true });
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 3 · PROPERTY 3 — inert before the human can have looked
// ═════════════════════════════════════════════════════════════════════════════

test('the affirmative is dead for the first two seconds, and says so instead of doing nothing', async () => {
  const clock = fakeClock();
  const { B } = await honestPair(clock);
  const flow = await showSas(B, clock);

  const yes = btn('.pair-sas-yes');
  assert.equal(yes.disabled, true, 'the affirmative is live the instant the digits appear');
  assert.equal(yes.getAttribute('aria-disabled'), 'true');
  // It is not a dead button: it reads as unavailable and says why in three words. A button that
  // looks live and swallows the click is the thing this must not be.
  assert.equal(yes.textContent, i18n.t('pairSasWait'));

  // A reflex click, twice, changes nothing at all.
  yes.click();
  yes.click();
  assert.deepEqual(flow.calls, [], 'a click before the look-delay confirmed the pairing');
  assert.equal(B.state(), 'sas', 'the session advanced without a human');

  // One millisecond short is still short.
  clock.advance(ui.PAIR_UI.sasMinLookMs - 1);
  assert.equal(btn('.pair-sas-yes').disabled, true);

  clock.advance(1);
  await waitFor(() => !btn('.pair-sas-yes').disabled, { what: 'the armed Ja' });
  assert.includes(btn('.pair-sas-yes').textContent, ui.formatSas(B.sas()));

  // And the REFUSAL was never delayed. Making it harder to say no would be the wrong friction.
  assert.equal(btn('.pair-sas-no').disabled, false);

  ui.closePairingScreen({ silent: true });
  unmount();
});

test('a re-render during the wait does not restart the two seconds — and does not shorten them', async () => {
  const clock = fakeClock();
  const { B } = await honestPair(clock);
  await showSas(B, clock);

  clock.advance(1500);
  // A language toggle is a full re-render. If it reset the clock the user would be made to wait
  // again for no reason; if it armed the button early the property would be defeated by a click
  // on a toggle. Neither.
  btn('.pair-lang').click();
  await waitFor(() => btn('.pair-lang')?.textContent === 'Deutsch', { what: 'the language swap' });
  assert.equal(btn('.pair-sas-yes').disabled, true, 'a re-render armed the affirmative early');

  clock.advance(500);
  await waitFor(() => !btn('.pair-sas-yes').disabled, { what: 'the armed Ja' });

  ui.closePairingScreen({ silent: true });
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 4 · PROPERTY 4 — every other exit refuses
// ═════════════════════════════════════════════════════════════════════════════

test('Escape, the ✕ and closing the screen all REFUSE — never „later", never silence', async () => {
  for (const [how, act] of [
    ['Escape', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))],
    ['the ✕', () => btn('.pair-x').click()],
    ['closePairingScreen()', () => ui.closePairingScreen()],
  ]) {
    const clock = fakeClock();
    const { B } = await honestPair(clock);
    const flow = await showSas(B, clock);
    // Arm the affirmative first, so the refusal cannot be an artefact of the button being dead.
    clock.advance(ui.PAIR_UI.sasMinLookMs);
    await waitFor(() => !btn('.pair-sas-yes').disabled, { what: 'the armed Ja' });

    act();
    await waitFor(() => B.state() !== 'sas', { what: `${how} to end the session` });
    assert.deepEqual(flow.calls, [false], `${how}: the exit did not refuse`);
    // Refusal is TERMINAL in the protocol. A pairing somebody walked away from must not be
    // resumable, because "walked away" and "the numbers differed" are the same evidence.
    assert.equal(B.state(), 'refused', `${how}: left the session alive`);
    ui.closePairingScreen({ silent: true });
    unmount();
  }
});

test('the „different" button refuses, stays on screen, and says nothing was transferred', async () => {
  const clock = fakeClock();
  const { A, B } = await honestPair(clock);
  const flow = await showSas(B, clock);

  btn('.pair-sas-no').click();
  await waitFor(() => $('.pair-title')?.textContent === i18n.t('pairStoppedTitle'),
    { what: 'the stopped screen' });

  assert.deepEqual(flow.calls, [false]);
  assert.equal(B.state(), 'refused');
  // The user has just been told something alarming happened. Closing the screen out from under
  // them would leave them wondering what moved. Nothing did, and the screen says so.
  assert.includes(screen().textContent, i18n.t('pairStoppedRefused'));
  assert.includes(screen().textContent, i18n.t('pairStoppedNothing'));
  // The advice that follows from a genuine MITM: try again somewhere else.
  assert.includes(screen().textContent, 'Netz');

  // The other side has NOT delivered anything, and now cannot: `deliver()` refuses unless a human
  // confirmed on THAT device, which is the half of the defence that lives in the protocol.
  let threw = null;
  try { await A.deliver(); } catch (e) { threw = e.code; }
  assert.equal(threw, 'state', 'the existing Mac delivered keys without its own confirmation');

  ui.closePairingScreen({ silent: true });
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 5 · PROPERTY 5 — one call site, one `true`
// ═════════════════════════════════════════════════════════════════════════════

test('across a whole session, confirmMatch(true) happens once and only from the one click', async () => {
  const clock = fakeClock();
  const { B } = await honestPair(clock);
  const flow = await showSas(B, clock);

  // Everything a user can touch before the affirmative arms.
  btn('.pair-lang').click();
  await waitFor(() => btn('.pair-lang')?.textContent === 'Deutsch', { what: 'the swap' });
  btn('.pair-lang').click();
  await waitFor(() => btn('.pair-lang')?.textContent === 'English', { what: 'the swap back' });
  btn('.pair-sas-yes').click();
  $('#pair-sas').click();
  screen().click();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  assert.deepEqual(flow.calls, [], 'something other than the deliberate click confirmed');

  clock.advance(ui.PAIR_UI.sasMinLookMs);
  await waitFor(() => !btn('.pair-sas-yes').disabled, { what: 'the armed Ja' });
  const yes = btn('.pair-sas-yes');
  yes.click();
  await waitFor(() => B.state() === 'confirmed', { what: 'the confirmation' });
  // A double click must not be two confirmations — the second would throw inside the protocol,
  // and a screen that produces a throw for an ordinary double click is a screen nobody trusts.
  yes.click();
  assert.deepEqual(flow.calls, [true], 'the affirmative fired more than once');

  ui.closePairingScreen({ silent: true });
  unmount();
});

test('reaching the SAS state does NOT advance anything — decryption is not confirmation', async () => {
  // The exact "simplification" ADR 002 §6.4 warns about, seen from the screen: both boxes opened,
  // both sides have a shared secret, both have six digits. If that were enough, the state would
  // move on its own. It must not.
  const clock = fakeClock();
  const { A, B } = await honestPair(clock);
  const flow = await showSas(B, clock);
  assert.equal(B.state(), 'sas');
  assert.equal(A.state(), 'sas');

  clock.advance(60 * 1000);   // a minute of nobody doing anything
  assert.equal(B.state(), 'sas', 'the session confirmed itself');
  assert.equal(A.state(), 'sas');
  assert.deepEqual(flow.calls, []);
  // And the screen is still asking.
  assert.ok($('#pair-sas'), 'the SAS screen went away on its own');
  assert.equal($('.pair-title').textContent, i18n.t('pairSasTitle'));

  ui.closePairingScreen({ silent: true });
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 6 · A REAL ACTIVE MITM — the two screens show two different numbers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * ADR 002 §6.4's real threat, built rather than mocked.
 *
 * The attacker is assumed to KNOW THE CODE — shoulder-surfed, or read off whatever channel the
 * code travelled on. That is the assumption under which the code's 60 bits buy nothing, and it is
 * the assumption under which the SAS is the entire defence. So the attacker here runs two honest
 * halves of the protocol: it answers Mac 1 as if it were the new device, and it offers Mac 2 the
 * same code as if it were the existing one. Four ECDH agreements happen, all real. Mac 1 agrees
 * a secret with the attacker; Mac 2 agrees a different secret with the attacker; and the two
 * six-digit strings that fall out of `HKDF(S ‖ A_eph ‖ B_eph, …)` therefore differ.
 */
async function mitmPair(clock) {
  const ports = { subtle: S, random: RANDOM, now: clock.now };
  const idA = await makeIdentity();
  const idM = await makeIdentity();          // the attacker has its own perfectly valid device

  const A = pairing.createPairingSession(idA, await makeKeyring(), ports);
  const offer = await A.beginAsExisting();

  // The attacker, toward Mac 1: an ordinary new device.
  const Mnew = pairing.createPairingSession(null, null, ports);
  const mAnswer = await Mnew.answerAsNew(offer.code, offer.boxA);
  await A.confirmExisting(mAnswer.boxB);

  // The attacker, toward Mac 2: an ordinary existing device — using the code it stole.
  const Mex = pairing.createPairingSession(idM, await makeKeyring(), {
    ...ports, random: randomForcingCode(offer.code),
  });
  const mOffer = await Mex.beginAsExisting();
  assert.equal(mOffer.code, offer.code, 'the attacker did not manage to reuse the code');

  const B = pairing.createPairingSession(null, null, ports);
  const bAnswer = await B.answerAsNew(offer.code, mOffer.boxA);
  await Mex.confirmExisting(bAnswer.boxB);
  await B.confirmNew();

  return { A, B, idA, idM };
}

test('with an attacker in the middle the two Macs show DIFFERENT digits, and refusing is one click', async () => {
  const clock = fakeClock();
  let run = await mitmPair(clock);
  // A collision is §6.4's stated 10^-6 — the attacker's whole remaining chance — so it is not a
  // bug when it happens, but it would be a flaky assertion. Two extra draws take the probability
  // of a spurious red to 10^-18 without weakening anything: a real attacker gets ONE attempt
  // against a human, and burning the rendezvous is what a second attempt costs it.
  for (let i = 0; i < 2 && run.A.sas() === run.B.sas(); i++) {
    diag(`SAS collision — the 10^-6 case; redrawing (attempt ${i + 2})`);
    run = await mitmPair(clock);
  }
  const { A, B } = run;
  assert.notEqual(A.sas(), B.sas(), 'the MITM produced matching SAS values');

  // Mac 1's screen.
  await showSas(A, clock, { selfShort: run.idA.deviceShort });
  const shownA = $('#pair-sas').textContent;
  assert.equal(shownA, ui.formatSas(A.sas()));
  ui.closePairingScreen({ silent: true });

  // Mac 2's screen.
  const flowB = await showSas(B, clock);
  const shownB = $('#pair-sas').textContent;
  assert.equal(shownB, ui.formatSas(B.sas()));

  // THE ASSERTION THE ENTIRE SCREEN EXISTS FOR. A person looking at both Macs sees two different
  // numbers. Nothing else in this product detects the attacker; this does.
  assert.notEqual(shownA, shownB, 'both screens showed the same number under an active MITM');

  // Mac 2 is showing the ATTACKER's device short, not Mac 1's — a second, quieter tell.
  assert.includes($('.pair-who').textContent, B.peer().deviceShort);
  assert.equal($('.pair-who').textContent.includes(run.idA.deviceShort), false,
    "Mac 2 believes it is talking to Mac 1 — the peer short is the attacker's");

  // And the human's answer is one click away, first in the tab order, never delayed.
  btn('.pair-sas-no').click();
  await waitFor(() => B.state() === 'refused', { what: 'the refusal' });
  assert.deepEqual(flowB.calls, [false]);
  assert.equal(B.state(), 'refused');
  // Terminal: the attacker gets no second bite at this rendezvous.
  let threw = null;
  try { await B.receive('AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBB'); } catch (e) { threw = e.code; }
  assert.equal(threw, 'refused', 'a refused session still accepts a key transfer');

  ui.closePairingScreen({ silent: true });
  unmount();
});

test('the digits the screen renders are the session\'s, character for character', async () => {
  // A screen that formatted, truncated, re-ordered or localised the SAS would break the
  // comparison in the one way a human could not see: both screens would look plausible.
  const clock = fakeClock();
  const { B } = await honestPair(clock);
  await showSas(B, clock);
  const raw = B.sas();
  assert.equal($('#pair-sas').textContent.split(' ').join(''), raw);
  assert.equal(ui.formatSas(raw), `${raw.slice(0, 3)} ${raw.slice(3)}`);
  // Six digits is six digits: no thousands separator, no locale, no leading-zero trimming.
  assert.equal(ui.formatSas('000042'), '000 042');
  assert.equal(ui.formatSas('123456'), '123 456');
  // Anything that is not six digits is passed through untouched rather than silently padded —
  // a wrong-length SAS is a bug that must be visible, not one that renders plausibly.
  assert.equal(ui.formatSas('12345'), '12345');
  assert.equal(ui.formatSas(null), '');
  ui.closePairingScreen({ silent: true });
  unmount();
});
