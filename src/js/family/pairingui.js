// src/js/family/pairingui.js — LZP-503. Story 19.5, deliverable 21: both ends of device pairing.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE IS, AND — MORE IMPORTANTLY — WHAT IT IS NOT
// ═════════════════════════════════════════════════════════════════════════════
//
// `src/js/crypto/pairing.js` is the protocol: the code, `rid`, `ck`, the two ephemeral ECDH
// pairs, the six-digit SAS, the key transfer, and the five terminal states. It is built,
// red-teamed and pure. This file owns the PIXELS and the GERMAN, and nothing else. It never
// derives a key, never opens a box, never compares two SAS values, never decides what a state
// means — and it must never import `src/js/crypto/`.
//
// That last clause is not style. `tests/tier1/crypto-identity.test.js`'s PRINCIPLE 7 gate fails
// if anything under `src/js/crypto/` becomes reachable from `boot.js` / `firstrun.js` /
// `main.js`, and the import walker follows dynamic `import()` too. The day
// `family/familysettings.js` is wired into the settings sheet, THIS file joins the boot graph.
// A convenience `import { PAIR_STATE } from '../crypto/pairing.js'` here would then mint device
// keys on a solo first run — ADR 002 §2.4's "NO KEYGEN, NO PROBE, NO NETWORK" — and the symptom
// would be a red gate in a file nobody was editing. So the protocol arrives through a PORT, the
// way `update-ui.js` takes `platform/updater.js`, and the only thing this module imports outside
// the DOM layer is `core/b64.js`'s Crockford normaliser (dependency-free, DOM-free, and the very
// function the derivation uses — see §2).
//
// ═════════════════════════════════════════════════════════════════════════════
// THE SAS SCREEN IS THE PRODUCT'S ONLY MITM DEFENCE. IT LIVES IN THIS FILE.
// ═════════════════════════════════════════════════════════════════════════════
//
// ADR 002 §0's T4 row and §6.4's boxed warning say it in one line: the pairing code's 60 bits
// buy the online-guessing margin; the **SAS buys everything else**. A relay that knows the code
// — shoulder-surfed, or read off the channel the code travelled on — can run the protocol with
// both sides and hand each of them its own keys. It fails for exactly one reason: A and B then
// derive different shared secrets, so their six digits differ, and a human looking at two
// screens on one desk sees two different numbers.
//
// Which means the defence is not `confirmSasMatch()`. The defence is **a person looking at the
// other screen**, and this file's entire job on that screen is to make looking the easy path and
// an unconsidered „Ja" awkward. No API can tell whether someone actually looked (§6.4 says so).
// What a screen can do is spend its whole design budget on the five properties below, each of
// which is asserted in `tests/tier2/pairing-sas.dom.js`:
//
//   1. THE AFFIRMATIVE IS NOT THE DEFAULT.  It is last in DOM order and last in the tab order;
//      focus lands on the refusal; Enter does not confirm; nothing is `autofocus`ed onto it; it
//      carries no accent styling. Mashing Space/Enter refuses. The board's accent gradient — the
//      one permanent highlight in the product — is deliberately NOT used here: this is not the
//      way forward, it is a claim about a number.
//   2. THE AFFIRMATIVE RESTATES THE DIGITS.  Its label is „Ja — auf beiden steht 472 913", not
//      „OK". The sentence a user agrees to is about a specific number, so agreeing to it while
//      looking at a different number on the other Mac is a visible contradiction rather than a
//      generic dismissal.
//   3. THE AFFIRMATIVE IS INERT FOR THE FIRST `SAS_MIN_LOOK_MS`.  Two seconds. This is the one
//      piece of enforced friction in the flow and it is aimed precisely at the reflex-clicker
//      §6.4 is worried about; it is below the threshold where a person who IS comparing notices
//      it at all, and far above a reflex. It is not a dead button: it renders visibly disabled
//      and reads „Zuerst vergleichen", then swaps to the real label. No countdown ticks at the
//      user, nothing animates. **This is a judgement call, not a quotation of the ADR** — see
//      §4's note, and deleting it is one constant.
//   4. EVERY OTHER EXIT REFUSES.  Escape, the ✕, a click on the backdrop, closing the screen —
//      all of them call `confirmMatch(false)`, which is terminal. A pairing somebody walked away
//      from must never be resumable into a confirmed state, and „später" is not an option the
//      protocol has.
//   5. `confirmMatch(true)` HAS EXACTLY ONE CALL SITE.  One `addEventListener` on one button.
//      Grep for it: it appears once in this file. ADR 002 §6.4's warning is about a downstream
//      agent who "simplifies" pairing by confirming when the boxes decrypt; the shape that makes
//      that easy is a `confirm()` helper called from three places. There is none.
//
// The screen also shows BOTH device short ids next to the digits. A relay cannot forge them
// (they are `deviceShortOf(sigPubRaw)` from inside the sealed boxes), and a user pairing with a
// machine whose id they do not recognise has learned something the digits alone would not tell
// them.
//
// ═════════════════════════════════════════════════════════════════════════════
// NOT A SHEET — A SURFACE
// ═════════════════════════════════════════════════════════════════════════════
//
// `ui.js`'s `openSheet()` is the product's dialog, and it is the wrong container here for a
// concrete reason: `closeTopSheet()` (which `main.js` binds to Escape) removes the scrim WITHOUT
// calling `spec.onClose`. A pairing screen in a sheet would therefore vanish on Escape while the
// protocol session stayed in `sas` for ever — property 4 above silently broken by a file this
// package does not own. So pairing borrows LZP-106's unlock-screen shape instead: an opaque
// surface that replaces the view, with its own captured key handler. That is also the right
// register for the content — deliverable 21 says "screens", plural, and this is the one moment
// in the product where a person is asked to do something exactly right.
//
// ═════════════════════════════════════════════════════════════════════════════
// CSS OWNERSHIP — READ THIS BEFORE MOVING THE STYLES
// ═════════════════════════════════════════════════════════════════════════════
//
// `src/css/app.css` belongs to the v1 DOM layer and this package does not own it (one owner per
// file). The styles this screen needs are therefore injected once, as a `<style>` element with a
// stable id, exported below as `PAIR_CSS` so a test can assert it is present exactly once. The
// document CSP already permits this (`style-src 'self' 'unsafe-inline'`, index.html:14) and no
// value in it is interpolated from anything. **This is a temporary home.** When the CSS owner
// next opens `app.css`, `PAIR_CSS` should move there verbatim and `ensureCss()` should be
// deleted; nothing else changes. Every token used is one `app.css` already defines.

import { t, getLang, setLang } from '../i18n.js';
import { el } from '../ui.js';
import { crockNormalize, CROCKFORD_ALPHABET } from '../core/b64.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Parameters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The numbers this screen enforces. They MIRROR `crypto/pairing.js`'s `PAIRING` rather than
 * importing it — see the header on why nothing here may reach into `crypto/`. They are display
 * parameters only: not one of them is an input to a derivation, and the authoritative TTL is the
 * relay's (`crypto/pairing.js` §6, "the two clocks are independent"). If they ever disagree with
 * `PAIRING`, the visible symptom is a countdown that is wrong by a second, never a failed pairing.
 */
export const PAIR_UI = Object.freeze({
  /** ADR 002 §6.2 — 12 Crockford characters, displayed XXXX-XXXX-XXXX. */
  codeChars: 12,
  codeGroup: 4,
  /** §6.2 — six decimal digits, shown 3 + 3 so the eye can carry them across a desk. */
  sasDigits: 6,
  sasGroup: 3,
  /** §6.2 — 180 s. Shown as a plain countdown, because the code really does stop working. */
  ttlSeconds: 180,
  /**
   * Property 3 in the header. The affirmative on the SAS screen is inert for this long.
   *
   * WHY A NUMBER AT ALL, AND WHY THIS ONE. The thing being defended against is a reflex — the
   * click that happens before the eye has left this screen. Two seconds is roughly the time it
   * takes to look at another monitor and back, so a person who is genuinely comparing has never
   * met this delay; a person who is not has met the only cost this flow can honestly impose.
   * Nothing in ADR 002 asks for it. It is the one place this screen goes past the letter of §6.4
   * in service of its stated intent, and it is one constant and one `if` if the PO disagrees.
   */
  sasMinLookMs: 2000,
  /** The countdown redraw. One second; nothing on this screen animates. */
  tickMs: 1000,
});

/** The two ends. Locked for the life of a screen, exactly as the session locks its role. */
export const PAIR_ROLE = Object.freeze({ existing: 'existing', new: 'new' });

/**
 * The protocol states this screen renders, mirrored from `crypto/pairing.js`'s `PAIR_STATE`.
 * Kept as a local frozen table for the header's import reason. `renderFor()` fails LOUDLY on a
 * state it does not know rather than rendering a blank surface: an unrecognised state in a key
 * transfer is a bug, and a blank screen is the worst way to report one.
 */
export const PAIR_PHASE = Object.freeze({
  init: 'init',
  offered: 'offered',
  answered: 'answered',
  sas: 'sas',
  confirmed: 'confirmed',
  delivered: 'delivered',
  received: 'received',
  refused: 'refused',
  expired: 'expired',
  burned: 'burned',
  failed: 'failed',
});

/** The five terminal states. Nothing continues from here; the screen offers a restart. */
const STOPPED = Object.freeze(['refused', 'expired', 'burned', 'failed']);
/** The two terminal states that mean the key transfer happened. */
const FINISHED = Object.freeze(['delivered', 'received']);

// ─────────────────────────────────────────────────────────────────────────────
// 2. The port — what the flow owner must hand this screen
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PairingView  what `port.snapshot()` returns. A frozen plain object; every
 *   field is either a primitive or null, so a screen can never hold a key by accident.
 * @property {'existing'|'new'|null} role     locked by the session's first call
 * @property {string} state                   one of PAIR_PHASE
 * @property {string|null} display            the code as `XXXX-XXXX-XXXX` (existing device only)
 * @property {string|null} sas                the six digits, undecorated: `'472913'`
 * @property {string|null} selfShort          this Mac's deviceShort
 * @property {string|null} peerShort          the other Mac's deviceShort, once a box has opened
 * @property {number} attemptsRemaining       ADR 002 §6.2's five
 * @property {number|null} expiresAt          epoch ms; the relay's TTL as this side measures it
 * @property {boolean} busy                   a call is in flight — disables the controls, and
 *                                            NEVER draws a spinner (19.3's rule is not scoped
 *                                            to sync; `update-ui.js` makes the same call)
 * @property {string|null} errorCode          a `PairingError.code`, or null
 */

/**
 * @typedef {Object} PairingPort  LZP-505's flow: the relay round trips, the polling, and the
 *   `crypto/pairing.js` session. This screen calls it and renders what it reports; it holds no
 *   protocol state of its own beyond "which surface is open".
 * @property {() => PairingView} snapshot          synchronous; the flow caches its own view
 * @property {(fn:(v:PairingView) => void) => (() => void)} subscribe  returns an unsubscribe
 * @property {(role:'existing'|'new') => Promise<void>} start
 * @property {(typedCode:string) => Promise<void>} submitCode          normalised, 12 chars
 * @property {(humanSaidTheDigitsMatch:boolean) => Promise<void>} confirmMatch
 * @property {() => Promise<void>} cancel          idempotent; safe to call on a finished session
 */

/** @type {PairingPort|null} */
let port = null;
let unsubscribe = null;
let nowFn = () => Date.now();
let scheduleFn = (ms, fn) => setTimeout(fn, ms);
let unscheduleFn = (h) => clearTimeout(h);

/**
 * Mount the screen over a flow. Called by `familysettings.js` (A10) at the family opt-in moment,
 * and by `tests/tier2/pairing-*.dom.js` over a flow driven by the REAL `crypto/pairing.js`.
 *
 * Calling it with no arguments unmounts — which is what a test's teardown wants and what a
 * family-mode exit will want.
 *
 * @param {{port?:PairingPort|null, now?:() => number,
 *          schedule?:(ms:number, fn:Function) => any, unschedule?:(h:any) => void}} deps
 */
export function initPairingUI({ port: p = null, now = null, schedule = null, unschedule = null } = {}) {
  closePairingScreen({ silent: true });
  if (unsubscribe) { try { unsubscribe(); } catch { /* a dead flow is not an error */ } }
  unsubscribe = null;
  port = p;
  nowFn = typeof now === 'function' ? now : () => Date.now();
  scheduleFn = typeof schedule === 'function' ? schedule : (ms, fn) => setTimeout(fn, ms);
  unscheduleFn = typeof unschedule === 'function' ? unschedule : (h) => clearTimeout(h);
}

/** Present only where a flow has been mounted. In solo mode the whole feature is absent. */
export const pairingSupported = () => !!port;

/** The empty view a screen renders when there is no flow at all. */
const EMPTY_VIEW = Object.freeze({
  role: null, state: PAIR_PHASE.init, display: null, sas: null,
  selfShort: null, peerShort: null, attemptsRemaining: 5, expiresAt: null,
  busy: false, errorCode: null,
});

/** The current view, normalised. Exported so a test can assert what the screen believes. */
export function pairingUIState() {
  if (!port) return EMPTY_VIEW;
  const v = port.snapshot() || {};
  return Object.freeze({
    role: v.role ?? null,
    state: typeof v.state === 'string' ? v.state : PAIR_PHASE.init,
    display: v.display ?? null,
    sas: v.sas ?? null,
    selfShort: v.selfShort ?? null,
    peerShort: v.peerShort ?? null,
    attemptsRemaining: Number.isFinite(v.attemptsRemaining) ? v.attemptsRemaining : 5,
    expiresAt: Number.isFinite(v.expiresAt) ? v.expiresAt : null,
    busy: v.busy === true,
    errorCode: v.errorCode ?? null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Formatting — display only, never an input to a derivation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `XXXX-XXXX-XXXX` from anything a human has typed so far, for the input field as it fills.
 *
 * `crockNormalize` is imported rather than re-implemented, and that is deliberate: it folds case
 * and maps I/L → 1 and O → 0, and it does NOT map `U` (Crockford reserves it, so a `U` is an
 * error and not a typo we may guess at — `crypto/pairing.js` §2 spends a paragraph on why a wrong
 * guess here presents as "the code is wrong" on a correctly typed code). Two spellings of that
 * function would be two answers to "what did the user type", and the derivation only accepts one.
 *
 * Characters outside the alphabet are dropped as they are typed, which is what makes a pasted
 * `xxxx-xxxx-xxxx` and a typed `xxxxxxxxxxxx` the same twelve characters.
 *
 * @param {string} raw @returns {string} at most 12 characters plus its two separators
 */
export function formatCodeInput(raw) {
  let norm;
  try {
    norm = crockNormalize(String(raw ?? ''));
  } catch {
    return '';
  }
  let kept = '';
  for (const ch of norm) {
    if (CROCKFORD_ALPHABET.includes(ch)) kept += ch;
    if (kept.length === PAIR_UI.codeChars) break;
  }
  const g = PAIR_UI.codeGroup;
  const parts = [];
  for (let i = 0; i < kept.length; i += g) parts.push(kept.slice(i, i + g));
  return parts.join('-');
}

/** The 12 characters with the separators removed — what `submitCode` is given. */
export const codeChars = (formatted) => String(formatted ?? '').split('-').join('');

/** `'472913'` → `'472 913'`. Display only; the port is never handed the spaced form. */
export function formatSas(sas) {
  const s = String(sas ?? '');
  if (s.length !== PAIR_UI.sasDigits) return s;
  return `${s.slice(0, PAIR_UI.sasGroup)} ${s.slice(PAIR_UI.sasGroup)}`;
}

/** „4 7 2 9 1 3" — what a screen reader says. Six digits read as one number would be wrong. */
const spellSas = (sas) => String(sas ?? '').split('').join(' ');

/** `mm:ss`, floored at zero. The code stops working; saying so is honest, not alarming. */
export function formatCountdown(msLeft) {
  const total = Math.max(0, Math.ceil((Number(msLeft) || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The surface
// ─────────────────────────────────────────────────────────────────────────────

let layer = null;
let keyHandler = null;
let lastFocus = null;
let tick = null;
/** When the SAS digits first went on screen — property 3's clock. Null off the SAS screen. */
let sasShownAt = null;
let sasArmTimer = null;
/** What the human has typed into the code field so far, so a re-render does not erase it. */
let typedCode = '';

export const pairingScreenOpen = () => !!layer;

/**
 * Open the screen for one end of the protocol.
 *
 * Opening does NOT start the protocol: `port.start(role)` does, and this calls it, so the code
 * on screen is always a code the session actually minted. A screen that rendered a code it had
 * generated itself would be a screen that can display a code no session will accept.
 *
 * @param {{role:'existing'|'new'}} spec
 */
export function openPairingScreen({ role } = {}) {
  if (layer) return layer;
  if (role !== PAIR_ROLE.existing && role !== PAIR_ROLE.new) {
    throw new Error(`openPairingScreen: role must be 'existing' or 'new', got ${JSON.stringify(role)}`);
  }
  ensureCss();
  lastFocus = document.activeElement;
  typedCode = '';
  sasShownAt = null;

  layer = el('div', 'pair');
  layer.setAttribute('role', 'dialog');
  layer.setAttribute('aria-modal', 'true');
  layer.dataset.role = role;

  // Escape refuses. So does everything else that ends this screen — property 4.
  keyHandler = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      closePairingScreen();
      return;
    }
    if (e.key === 'Tab') {
      const f = focusables();
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i === f.length - 1 ? 0 : i + 1);
      f[next].focus();
      e.preventDefault();
    }
  };
  window.addEventListener('keydown', keyHandler, true);

  if (port && typeof port.subscribe === 'function') {
    try { unsubscribe = port.subscribe(() => renderPairingScreen()); } catch { unsubscribe = null; }
  }

  document.body.appendChild(layer);
  document.body.classList.add('pair-on');
  renderPairingScreen();
  startTick();

  // Starting is fire-and-forget: a rejection lands in the flow's own view as an `errorCode`,
  // which is what the screen renders. Swallowing it here would hide a state the screen shows.
  if (port && typeof port.start === 'function') {
    Promise.resolve(port.start(role)).catch(() => {}).then(() => renderPairingScreen());
  }
  return layer;
}

/**
 * Take the screen down. **Refuses first**, unless the session already ended.
 *
 * `{silent:true}` skips the refusal and is for teardown only — `initPairingUI()` re-mounting over
 * a different flow, where there is no human and no session to refuse. It is deliberately not
 * reachable from any control on the screen.
 *
 * @param {{silent?:boolean}} [opts]
 */
export function closePairingScreen(opts = {}) {
  if (!layer) return false;
  const view = pairingUIState();
  const live = !STOPPED.includes(view.state) && !FINISHED.includes(view.state);
  stopTick();
  if (sasArmTimer != null) { try { unscheduleFn(sasArmTimer); } catch { /* already fired */ } }
  sasArmTimer = null;
  sasShownAt = null;
  typedCode = '';
  if (keyHandler) window.removeEventListener('keydown', keyHandler, true);
  keyHandler = null;
  if (unsubscribe) { try { unsubscribe(); } catch { /* a dead flow is not an error */ } }
  unsubscribe = null;
  layer.remove();
  layer = null;
  document.body.classList.remove('pair-on');
  if (!opts.silent && live && port) {
    // Walking away is not consent. `cancel()` is what a session in `offered`/`answered` needs;
    // a session already showing the digits gets the explicit refusal, because `sas` is the one
    // state where "no answer" and "the digits differed" must land in the same terminal place.
    const bail = view.state === PAIR_PHASE.sas && typeof port.confirmMatch === 'function'
      ? () => port.confirmMatch(false)
      : () => (typeof port.cancel === 'function' ? port.cancel() : undefined);
    try { Promise.resolve(bail()).catch(() => {}); } catch { /* a terminal session refuses again */ }
  }
  try { lastFocus?.focus?.(); } catch { /* the node may be gone */ }
  lastFocus = null;
  return true;
}

const focusables = () =>
  (layer ? [...layer.querySelectorAll('button:not([disabled]), input:not([disabled])')] : []);

function startTick() {
  stopTick();
  // One second, and only while a countdown is on screen. `setInterval` is legitimate in the DOM
  // layer (ADR 005 §2's hard rule covers core/crypto/sync/server-core); it is injectable so a
  // test can drive the countdown without waiting three real minutes.
  tick = scheduleFn(PAIR_UI.tickMs, function again() {
    if (!layer) return;
    renderCountdown();
    tick = scheduleFn(PAIR_UI.tickMs, again);
  });
}
function stopTick() {
  if (tick != null) { try { unscheduleFn(tick); } catch { /* already fired */ } }
  tick = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Rendering
// ─────────────────────────────────────────────────────────────────────────────

/** Re-render in place. Cheap and idempotent; every state change calls it. */
export function renderPairingScreen() {
  if (!layer) return null;
  const view = pairingUIState();
  const role = layer.dataset.role;

  // Leaving the SAS screen releases property 3's clock, so re-entering (which the protocol
  // cannot do, but a re-mount can) starts the two seconds again rather than inheriting them.
  if (view.state !== PAIR_PHASE.sas) {
    sasShownAt = null;
    if (sasArmTimer != null) { try { unscheduleFn(sasArmTimer); } catch { /* fired */ } }
    sasArmTimer = null;
  }

  layer.textContent = '';
  const card = el('div', 'pair-card');
  card.appendChild(head());
  card.appendChild(renderFor(view, role));
  layer.appendChild(card);
  layer.setAttribute('aria-label', titleFor(view, role));
  focusFirst(view);
  return layer;
}

function focusFirst(view) {
  // On the SAS screen focus lands on the REFUSAL — property 1. Everywhere else it lands on the
  // first control, which is the ordinary thing to do.
  const target = view.state === PAIR_PHASE.sas
    ? layer.querySelector('.pair-sas-no')
    : focusables()[0];
  try { target?.focus?.(); } catch { /* a disabled control is not focusable; that is fine */ }
}

function titleFor(view, role) {
  if (STOPPED.includes(view.state)) return t('pairStoppedTitle');
  if (FINISHED.includes(view.state)) return t('pairDoneTitle');
  if (view.state === PAIR_PHASE.sas) return t('pairSasTitle');
  if (role === PAIR_ROLE.new) return t('pairEnterTitle');
  return t('pairCodeTitle');
}

function head() {
  const top = el('header', 'pair-top');
  top.appendChild(el('p', 'pair-kicker', t('pairKicker')));

  const acts = el('div', 'pair-top-acts');
  // 13.7 — the language toggle travels with the screen, exactly as it does on LZP-106's unlock
  // screen and for the same reason: a reader who cannot read this screen cannot reach Settings.
  const lang = el('button', 'pair-lang');
  lang.type = 'button';
  lang.textContent = getLang() === 'de' ? 'English' : 'Deutsch';
  lang.addEventListener('click', () => { setLang(getLang() === 'de' ? 'en' : 'de'); renderPairingScreen(); });
  acts.appendChild(lang);

  const x = el('button', 'pair-x', '✕');
  x.type = 'button';
  x.title = t('close');
  x.setAttribute('aria-label', t('close'));
  // Property 4: the ✕ is an exit, and every exit refuses.
  x.addEventListener('click', () => closePairingScreen());
  acts.appendChild(x);

  top.appendChild(acts);
  return top;
}

function renderFor(view, role) {
  if (STOPPED.includes(view.state)) return screenStopped(view);
  if (FINISHED.includes(view.state)) return screenDone(view, role);
  if (view.state === PAIR_PHASE.sas) return screenSas(view);
  if (view.state === PAIR_PHASE.confirmed) return screenWorking();
  if (role === PAIR_ROLE.existing) return screenCode(view);
  if (role === PAIR_ROLE.new) return screenEnter(view);
  // Unreachable while `openPairingScreen` validates the role — kept because a blank surface is
  // the worst possible report of a bug in a key transfer.
  throw new Error(`pairingui: no screen for role=${JSON.stringify(role)} state=${JSON.stringify(view.state)}`);
}

// ── 5.1 the existing Mac: here is the code ───────────────────────────────────

function screenCode(view) {
  const b = el('div', 'pair-body');
  b.appendChild(el('h1', 'pair-title', t('pairCodeTitle')));
  b.appendChild(el('p', 'pair-lead', t('pairCodeLead')));

  const code = el('div', 'pair-code');
  code.id = 'pair-code';
  if (view.display) {
    code.textContent = view.display;
    // Read out as characters. „X4B2-…" as a word is not something a person can type back.
    code.setAttribute('aria-label', String(view.display).split('').join(' '));
  } else {
    code.classList.add('pending');
    code.textContent = '····-····-····';
  }
  b.appendChild(code);

  const cd = el('p', 'pair-countdown');
  cd.id = 'pair-countdown';
  b.appendChild(cd);

  b.appendChild(el('p', 'pair-note', t('pairCodeWaiting')));
  b.appendChild(el('p', 'pair-why', t('pairCodeWhy')));
  b.appendChild(acts([{ cls: 'pair-cancel', label: t('pairCancel'), run: () => closePairingScreen() }]));
  return b;
}

// ── 5.2 the new Mac: type the code ───────────────────────────────────────────

function screenEnter(view) {
  const b = el('div', 'pair-body');
  b.appendChild(el('h1', 'pair-title', t('pairEnterTitle')));
  b.appendChild(el('p', 'pair-lead', t('pairEnterLead')));

  const wrap = el('div', 'pair-entry');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'pair-input';
  input.id = 'pair-input';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', t('pairEnterLabel'));
  input.placeholder = 'XXXX-XXXX-XXXX';
  // `maxLength` is on the FORMATTED string: 12 characters plus two separators.
  input.maxLength = PAIR_UI.codeChars + 2;
  input.disabled = view.busy;
  // Survives a re-render. A code that was mistyped by one character is a code the user should
  // be able to FIX, not retype — there are five attempts in total (ADR 002 §6.2) and making the
  // user re-enter twelve random characters after each one would burn them on typing, not on
  // guessing. The buffer is cleared when the screen closes, never held longer.
  input.value = formatCodeInput(typedCode);

  const go = el('button', 'pair-go', t('pairEnterSubmit'));
  go.type = 'button';
  go.disabled = true;

  const sync = () => {
    const before = input.value;
    const after = formatCodeInput(before);
    if (after !== before) {
      // Rewriting the value moves the caret to the end. That is right here — the field fills
      // strictly left to right and there is nothing to edit in the middle of a random code.
      input.value = after;
    }
    typedCode = after;
    go.disabled = codeChars(after).length !== PAIR_UI.codeChars || view.busy;
  };
  input.addEventListener('input', sync);
  sync();

  const submit = () => {
    if (go.disabled || !port) return;
    const typed = codeChars(input.value);
    if (typed.length !== PAIR_UI.codeChars) return;
    go.disabled = true;
    input.disabled = true;
    Promise.resolve(port.submitCode(typed)).catch(() => {}).then(() => renderPairingScreen());
  };
  go.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    // Enter submits a 12-character code. This is the one place in the flow where Enter advances,
    // and it is safe: submitting a wrong code costs one of five attempts and confirms nothing.
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });

  wrap.appendChild(input);
  wrap.appendChild(go);
  b.appendChild(wrap);

  if (view.errorCode === 'open_failed' || view.errorCode === 'code_invalid') {
    const w = el('p', 'pair-wrong', t('pairEnterWrong'));
    w.setAttribute('role', 'status');
    w.appendChild(document.createTextNode(' '));
    w.appendChild(el('span', 'pair-attempts', t('pairAttemptsLeft', view.attemptsRemaining)));
    b.appendChild(w);
  }

  b.appendChild(el('p', 'pair-why', t('pairEnterWhy')));
  b.appendChild(acts([{ cls: 'pair-cancel', label: t('pairCancel'), run: () => closePairingScreen() }]));
  return b;
}

// ── 5.3 THE SAS SCREEN ───────────────────────────────────────────────────────

function screenSas(view) {
  const b = el('div', 'pair-body pair-body-sas');
  b.appendChild(el('h1', 'pair-title', t('pairSasTitle')));
  b.appendChild(el('p', 'pair-lead', t('pairSasLead')));

  const digits = el('div', 'pair-sas');
  digits.id = 'pair-sas';
  digits.textContent = formatSas(view.sas);
  digits.setAttribute('role', 'status');
  digits.setAttribute('aria-label', spellSas(view.sas));
  b.appendChild(digits);

  // The two machine ids, under the digits. A relay cannot forge either — both come out of a
  // sealed box — and a Mac the user does not recognise is worth seeing before, not after.
  //
  // A HALF THAT IS UNKNOWN IS OMITTED, not rendered as „—". The new Mac has no `deviceShort` of
  // its own until `adoptPairedDevice()` has run, and a dash next to „Dieser Mac:" reads as "this
  // one has no identity", which is both alarming and not what it means. An absent line says
  // nothing, which is the truth.
  const who = el('p', 'pair-who');
  if (view.selfShort) who.appendChild(el('span', 'pair-who-self', t('pairSasSelf', view.selfShort)));
  if (view.selfShort && view.peerShort) who.appendChild(el('span', 'pair-who-sep', '·'));
  if (view.peerShort) who.appendChild(el('span', 'pair-who-peer', t('pairSasPeer', view.peerShort)));
  if (who.childNodes.length) b.appendChild(who);

  // The honest sentence. Not a warning box, not red: a statement of what this click is for.
  b.appendChild(el('p', 'pair-why pair-why-sas', t('pairSasWhy')));

  // ── the two answers ───────────────────────────────────────────────────────
  // ORDER IS LOAD-BEARING (property 1). The refusal is FIRST in the DOM, therefore first in the
  // tab order, and `focusFirst` puts the caret on it. The affirmative is last and is not the
  // page's default action.
  const row = el('div', 'pair-sas-acts');

  const no = el('button', 'pair-sas-no', t('pairSasNo'));
  no.type = 'button';
  no.addEventListener('click', () => {
    // A refusal is terminal in the protocol. Say so and stay on screen — closing here would
    // leave the user wondering whether anything was transferred. Nothing was.
    if (port) Promise.resolve(port.confirmMatch(false)).catch(() => {}).then(() => renderPairingScreen());
  });
  row.appendChild(no);

  const yes = el('button', 'pair-sas-yes');
  yes.type = 'button';
  // Property 2: the label restates the digits, so the claim being agreed to is about a number.
  const armedLabel = t('pairSasYes', formatSas(view.sas));
  const armed = sasArmedNow();
  yes.textContent = armed ? armedLabel : t('pairSasWait');
  yes.disabled = !armed || view.busy;
  yes.setAttribute('aria-disabled', String(yes.disabled));
  // ───────────────────────────────────────────────────────────────────────────
  // THE ONLY PLACE IN THE PRODUCT THAT SAYS `true` TO A SAS COMPARISON.
  // ADR 002 §6.4: „not skippable, not defaulted to Ja". If you are adding a second call site,
  // you are removing the only MITM defence in the product. Read the file header first.
  // ───────────────────────────────────────────────────────────────────────────
  yes.addEventListener('click', () => {
    if (yes.disabled || !sasArmedNow() || !port) return;
    yes.disabled = true;
    Promise.resolve(port.confirmMatch(true)).catch(() => {}).then(() => renderPairingScreen());
  });
  row.appendChild(yes);
  b.appendChild(row);

  b.appendChild(el('p', 'pair-unsure', t('pairSasUnsure')));

  // Arm the affirmative once, `sasMinLookMs` after the digits first appeared. Re-renders during
  // the wait (a language toggle, a countdown tick) must not restart the clock, which is why
  // `sasShownAt` lives outside this function.
  if (sasShownAt === null) sasShownAt = nowFn();
  if (!armed && sasArmTimer === null) {
    const left = Math.max(0, PAIR_UI.sasMinLookMs - (nowFn() - sasShownAt));
    sasArmTimer = scheduleFn(left, () => {
      sasArmTimer = null;
      if (layer && pairingUIState().state === PAIR_PHASE.sas) renderPairingScreen();
    });
  }
  return b;
}

/** Property 3's predicate, as one function so the button and its label cannot disagree. */
function sasArmedNow() {
  if (sasShownAt === null) return false;
  return nowFn() - sasShownAt >= PAIR_UI.sasMinLookMs;
}

// ── 5.4 working / done / stopped ─────────────────────────────────────────────

function screenWorking() {
  const b = el('div', 'pair-body');
  b.appendChild(el('h1', 'pair-title', t('pairWorkingTitle')));
  // A sentence, not a spinner. 19.3's rule ("never a spinner on the board") is about the board;
  // this screen is not the board, but the reason is the same and the answer is the same.
  b.appendChild(el('p', 'pair-lead', t('pairWorking')));
  return b;
}

function screenDone(view, role) {
  const b = el('div', 'pair-body');
  b.appendChild(el('h1', 'pair-title', t('pairDoneTitle')));
  b.appendChild(el('p', 'pair-lead', role === PAIR_ROLE.new ? t('pairDoneNew') : t('pairDoneExisting')));
  if (view.peerShort) b.appendChild(el('p', 'pair-note', t('pairDonePeer', view.peerShort)));
  b.appendChild(acts([{ cls: 'pair-ok', label: t('pairClose'), run: () => closePairingScreen() }]));
  return b;
}

const STOPPED_KEY = Object.freeze({
  refused: 'pairStoppedRefused',
  expired: 'pairStoppedExpired',
  burned: 'pairStoppedBurned',
  failed: 'pairStoppedFailed',
});

function screenStopped(view) {
  const b = el('div', 'pair-body');
  b.appendChild(el('h1', 'pair-title', t('pairStoppedTitle')));
  b.appendChild(el('p', 'pair-lead', t(STOPPED_KEY[view.state] || 'pairStoppedFailed')));
  // The sentence that matters most, and it is the same in all four cases: nothing moved.
  b.appendChild(el('p', 'pair-note', t('pairStoppedNothing')));
  b.appendChild(acts([
    { cls: 'pair-cancel', label: t('pairClose'), run: () => closePairingScreen() },
    {
      cls: 'pair-ok',
      label: t('pairRestart'),
      // A restart is a NEW session, so the screen closes and the flow is started again from the
      // beginning. Reusing a terminal session is exactly what `crypto/pairing.js` refuses.
      run: () => {
        const role = layer?.dataset.role;
        closePairingScreen({ silent: true });
        if (role) openPairingScreen({ role });
      },
    },
  ]));
  return b;
}

function acts(specs) {
  const row = el('div', 'pair-acts');
  for (const s of specs) {
    const b = el('button', s.cls, s.label);
    b.type = 'button';
    b.addEventListener('click', s.run);
    row.appendChild(b);
  }
  return row;
}

/** The countdown, redrawn in place once a second so a full re-render does not steal focus. */
function renderCountdown() {
  if (!layer) return;
  const node = layer.querySelector('#pair-countdown');
  if (!node) return;
  const view = pairingUIState();
  if (view.expiresAt === null) { node.textContent = ''; return; }
  const left = view.expiresAt - nowFn();
  node.textContent = left > 0
    ? t('pairCodeExpiresIn', formatCountdown(left))
    : t('pairCodeExpiredNow');
  node.classList.toggle('spent', left <= 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. The settings entry point (A10 — `familysettings.js` mounts this)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * „Meine Geräte" — two buttons and the sentence that explains what pairing is.
 *
 * Deliberately NOT a member list: LZP-503 owns the pairing screens, and the device roster is
 * `familysettings.js`'s (A10). This is the doorway and nothing more.
 *
 * @param {HTMLElement} body the sheet body
 * @param {{rebuild:Function, close:Function}} api
 */
export function buildPairingSection(body, api) {
  body.appendChild(el('div', 'section-title', t('pairSectionTitle')));
  if (!pairingSupported()) {
    body.appendChild(el('p', 'hint', t('pairUnsupported')));
    return;
  }
  const row = el('div', 'pair-row');
  const open = (role) => {
    // The sheet must go: this screen replaces the view, and a scrim behind it would be visible
    // through nothing at all. `api.close()` is the settings sheet's own exit.
    try { api?.close?.(); } catch { /* an already-closed sheet is fine */ }
    openPairingScreen({ role });
  };
  const a = el('button', 'btn-primary', t('pairAddDevice'));
  a.type = 'button';
  a.addEventListener('click', () => open(PAIR_ROLE.existing));
  const bnew = el('button', 'btn-ghost', t('pairHaveCode'));
  bnew.type = 'button';
  bnew.addEventListener('click', () => open(PAIR_ROLE.new));
  row.appendChild(a);
  row.appendChild(bnew);
  body.appendChild(row);
  body.appendChild(el('p', 'hint pair-section-hint', t('pairSectionHint')));
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. The styles — see the file header on why they live here for now
// ─────────────────────────────────────────────────────────────────────────────

/** The `<style>` id, exported so a test can assert exactly one of them exists. */
export const PAIR_CSS_ID = 'lzp-pairing-css';

/**
 * Every token here is one `app.css` already defines. The screen borrows LZP-106's unlock-screen
 * material — `--chrome` ground, `--surface` cards, ink hierarchy, no shadow, no motion — because
 * it is the same kind of moment: a rare, consequential thing met once.
 *
 * The SAS digits are the largest type in the product. That is the point: they have to be legible
 * across a desk, from the other Mac's screen, at a glance.
 */
export const PAIR_CSS = `
.pair {
  position: fixed; inset: 0; z-index: 86; overflow-y: auto;
  background: var(--chrome); padding: 40px 24px 56px;
  -webkit-font-smoothing: antialiased;
}
body.pair-on { overflow: hidden; }
.pair-card { width: 100%; max-width: 640px; margin: 0 auto; }

.pair-top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 24px; }
.pair-kicker { margin: 0; font: 500 10px var(--font); letter-spacing: .8px; text-transform: uppercase; color: var(--ink-4); }
.pair-top-acts { display: flex; align-items: center; gap: 8px; }
.pair-lang {
  font: 500 11px var(--font); color: var(--ink-2); border: 1px solid var(--field-border);
  border-radius: 5px; background: var(--surface); height: 22px; padding: 0 9px;
}
.pair-lang:hover { background: var(--hover); color: var(--ink-1); }
.pair-x { font: 400 13px var(--font); color: var(--ink-3); height: 22px; width: 22px; border-radius: 5px; }
.pair-x:hover { background: var(--hover); color: var(--ink-1); }

.pair-title { margin: 0 0 8px; font: 600 21px/1.3 var(--font); color: var(--ink-1); letter-spacing: -.2px; }
.pair-lead { margin: 0 0 24px; font: 400 13.5px/1.65 var(--font); color: var(--ink-2); max-width: 58ch; }
.pair-note { margin: 0 0 10px; font: 400 12px/1.6 var(--font); color: var(--ink-2); max-width: 58ch; }
.pair-why { margin: 0; font: 400 11.5px/1.6 var(--font); color: var(--ink-3); max-width: 58ch; }

/* the pairing code — read across a desk, typed on the other Mac */
.pair-code {
  font: 600 34px/1.2 var(--mono); letter-spacing: 3px; color: var(--ink-1);
  background: var(--surface); border: 1px solid var(--line-1); border-radius: 9px;
  padding: 18px 20px; text-align: center; margin: 0 0 10px; user-select: all;
}
.pair-code.pending { color: var(--ink-4); letter-spacing: 6px; }
.pair-countdown { margin: 0 0 18px; font: 400 11.5px var(--mono); color: var(--ink-3); text-align: center; }
.pair-countdown.spent { color: #A03A12; }

/* the code entry field */
.pair-entry { display: flex; gap: 9px; align-items: center; margin: 0 0 12px; }
.pair-input {
  flex: 1; min-width: 0; height: 46px; padding: 0 14px;
  border: 1px solid var(--field-border); border-radius: 8px; background: var(--surface);
  font: 600 22px/1 var(--mono); letter-spacing: 2px; color: var(--ink-1); text-align: center;
}
.pair-input::placeholder { color: var(--ink-4); font-weight: 400; letter-spacing: 2px; }
.pair-input:focus { outline: 2px solid var(--ink-1); outline-offset: 1px; border-color: var(--ink-1); }
.pair-go { height: 46px; padding: 0 20px; border-radius: 8px; border: 0; background: var(--ink-1); color: #fff; font: 600 13px var(--font); }
.pair-go:disabled { background: var(--ink-4); cursor: default; }
.pair-wrong { margin: 0 0 14px; font: 400 12px/1.6 var(--font); color: #A03A12; }
.pair-attempts { color: var(--ink-3); }

/* ── the SAS screen ──────────────────────────────────────────────────────────
   The digits are the largest type in the product, deliberately: the comparison
   has to be a glance across a desk, not a squint. Nothing here is coloured as
   an alert — this is not an error, it is the one moment the protocol asks a
   person to do something. */
.pair-sas {
  font: 700 64px/1.05 var(--mono); letter-spacing: 8px; color: var(--ink-1);
  background: var(--surface); border: 1px solid var(--line-1); border-radius: 11px;
  padding: 26px 16px; text-align: center; margin: 0 0 12px; user-select: all;
  font-variant-numeric: tabular-nums;
}
.pair-who {
  margin: 0 0 20px; display: flex; gap: 10px; justify-content: center;
  font: 400 11px var(--mono); color: var(--ink-3);
}
.pair-who-sep { color: var(--ink-4); }
.pair-why-sas {
  margin: 0 0 22px; padding-left: 11px; border-left: 2px solid var(--line-1);
  color: var(--ink-2); font-size: 12px;
}

/* The two answers carry the SAME visual weight. The affirmative is deliberately
   not the accent gradient and not a filled primary: it is a claim about a
   number, not "the way forward". Refusal comes first in the DOM, so it is also
   first in the tab order and is where focus lands. */
.pair-sas-acts { display: flex; gap: 10px; flex-wrap: wrap; margin: 0 0 12px; }
.pair-sas-no, .pair-sas-yes {
  height: 40px; padding: 0 18px; border-radius: 8px;
  border: 1px solid var(--field-border); background: var(--surface);
  font: 500 13px var(--font); color: var(--ink-1);
}
.pair-sas-no { color: #A03A12; border-color: #E7C6BC; }
.pair-sas-no:hover { background: #FDEEEC; }
.pair-sas-yes { font-weight: 600; }
.pair-sas-yes:hover:not(:disabled) { background: var(--hover); border-color: var(--ink-4); }
.pair-sas-yes:disabled { color: var(--ink-4); border-color: var(--line-1); background: var(--chrome); cursor: default; }
.pair-unsure { margin: 0; font: 400 11.5px/1.6 var(--font); color: var(--ink-3); }

.pair-acts { margin-top: 26px; display: flex; gap: 10px; }
.pair-cancel {
  height: 32px; padding: 0 16px; border-radius: 6px;
  border: 1px solid var(--field-border); background: var(--surface); font: 500 12px var(--font); color: var(--ink-2);
}
.pair-cancel:hover { background: var(--hover); color: var(--ink-1); }
.pair-ok { height: 32px; padding: 0 20px; border-radius: 6px; border: 0; background: var(--ink-1); color: #fff; font: 600 12px var(--font); }
.pair-ok:hover { background: #4C2AA3; }
.pair button:focus-visible { outline: 2px solid var(--ink-1); outline-offset: 2px; }

/* the settings doorway */
.pair-row { display: flex; gap: 8px; margin: 0 0 11px; }
.pair-section-hint { margin-left: 0; }

@media (max-width: 700px) {
  .pair { padding: 26px 16px 40px; }
  .pair-sas { font-size: 44px; letter-spacing: 5px; }
  .pair-code { font-size: 26px; letter-spacing: 2px; }
}

/* §10's motion budget is spent on the board's roll. A key-transfer screen that
   slides or fades reads as an alarm, and a pulsing SAS would be the worst of
   all: motion where a person is supposed to read six digits carefully. */
@media (prefers-reduced-motion: reduce) {
  .pair, .pair * { animation: none !important; transition: none !important; }
}
`;

/** Idempotent. One `<style>`, injected on first open, never rebuilt. */
function ensureCss() {
  if (document.getElementById(PAIR_CSS_ID)) return;
  const s = document.createElement('style');
  s.id = PAIR_CSS_ID;
  s.textContent = PAIR_CSS;
  document.head.appendChild(s);
}
