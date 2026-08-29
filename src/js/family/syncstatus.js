// src/js/family/syncstatus.js — LZP-504. Story 19.3, deliverable 20: the three sync states.
//
// ═════════════════════════════════════════════════════════════════════════════
// TWO OF THE THREE STATES ARE NOTHING, AND THAT IS THE WHOLE FEATURE
// ═════════════════════════════════════════════════════════════════════════════
//
//   19.3  "Sync status is silent when healthy; only pending-offline or a real error produces a
//          small, unobtrusive indicator — v1's 'silence is the design' (F11) extends to the
//          network."
//
// So the design budget is:
//
//   healthy         NOTHING. Not a green tick, not a grey tick, not a tooltip, not an empty
//                   reserved slot that a curious eye can find. `refreshSyncChrome()` REMOVES the
//                   node. `document.querySelector('.sync-dot')` is `null`, and
//                   `tests/tier2/sync-status.dom.js` asserts exactly that. A green tick is a
//                   claim that has to be re-earned every second and re-read every time the eye
//                   passes it; nothing is a claim that costs the reader nothing.
//   pending         ONE 6 px HOLLOW RING in the toolbar. `sync.contract.js` §4 words it: "pending
//                   → one small still hollow glyph". Still, in both senses — it does not move and
//                   it does not speak. The user is offline and their work is safe; that is calm
//                   information, not a warning, so it takes the ink hierarchy's weakest colour
//                   and no alert hue at all.
//   error           THE SAME SLOT, FILLED. Same size, same position, same silence — the ring
//                   closes. Amber-brown, the tone `app.css` already uses for the 22.7 bar, never
//                   red: a stalled sync is not a broken board, and every note, bar and scratchpad
//                   still works, still saves, still prints.
//
// And three prohibitions, two of them stated twice in the addendum:
//
//   · NEVER A SPINNER ON THE BOARD. Nothing in this module writes inside `.board`, nothing here
//     animates, and `@media (prefers-reduced-motion)` is belt-and-braces over a feature that has
//     no motion to reduce. `tests/tier2/sync-status.dom.js` asserts both halves.
//   · NO SYNC BUTTON AND NO MANUAL REFRESH ANYWHERE (19.2 — an acceptance criterion, and
//     `sync.contract.js` §4 repeats it in capitals). There is no control in this file that
//     triggers a request. The settings section is read-only prose.
//   · NO BADGE COUNT. The addendum's design note files this feature with the „neu" dot (17.5) and
//     the update hint (22.4): *a dot, not a badge count*. The number of waiting changes is a
//     sentence inside settings, where somebody has gone looking; it is never a numeral in chrome.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE DOES **NOT** DECIDE
// ═════════════════════════════════════════════════════════════════════════════
//
// `sync.contract.js` §4 gives the engine `status()` → `{state, pendingOps, consecutiveFailures,
// lastPullAt, errorKind, detail}` and a `classify(raw)` that reduces it to one of three words.
// That is the ENGINE's judgement and this file never second-guesses it: it does not count
// failures, does not know what `pendingAfterMs` is for, does not decide that three 500s are an
// error, and does not look at the network. It renders, in one slot, the word the engine hands it.
//
// The one thing it adds is the DEBOUNCE, because that is a property of the eye rather than of the
// protocol — see §2. And it takes the engine through an injected port, the way `update-ui.js`
// takes `platform/updater.js`, so that solo mode reaches nothing: with no port there is no node,
// no timer and no module state.
//
// ═════════════════════════════════════════════════════════════════════════════
// CSS OWNERSHIP
// ═════════════════════════════════════════════════════════════════════════════
//
// `src/css/app.css` is the v1 DOM layer's file and this package does not own it. The two rules
// this feature needs are injected once as a `<style>` with a stable id (`SYNC_CSS`, below); the
// document CSP already permits it (`style-src 'self' 'unsafe-inline'`). This is a temporary home:
// when the CSS owner next opens `app.css`, `SYNC_CSS` moves there verbatim and `ensureCss()` is
// deleted. Every token used is one `app.css` already defines.

import { t, getLang } from '../i18n.js';
import { el } from '../ui.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. The three states, and the numbers
// ─────────────────────────────────────────────────────────────────────────────

/** `sync.contract.js` §4's `SyncState`, mirrored. Healthy is the absence of a glyph. */
export const SYNC_STATE = Object.freeze({ healthy: 'healthy', pending: 'pending', error: 'error' });

/**
 * `sync.contract.js` §4's `errorKind` domain. Mirrored rather than imported, because
 * `docs/v2/contracts/` is a contract document and not a shipped module — nothing under `src/`
 * may import from `docs/`. Every kind has a sentence in `i18n.js`; `SYNC_ERROR_KEY` below is the
 * mapping, and an unknown kind falls back to the generic sentence rather than to a blank line.
 */
export const SYNC_ERROR_KINDS = Object.freeze(
  ['offline', 'auth', 'protocol', 'quarantine', 'decrypt', 'clockSkew']
);

const SYNC_ERROR_KEY = Object.freeze({
  offline: 'syncErrOffline',
  auth: 'syncErrAuth',
  protocol: 'syncErrProtocol',
  quarantine: 'syncErrQuarantine',
  decrypt: 'syncErrDecrypt',
  clockSkew: 'syncErrClockSkew',
});

/**
 * `sync.contract.js`'s `CADENCE.statusDebounceMs`, mirrored for the same reason as above.
 *
 * THE ASYMMETRY IS THE POINT, and the contract only states half of it: "Transitions debounced by
 * CADENCE.statusDebounceMs so a normal push does not flicker it."
 *
 *   appearing  is debounced by 2 s — a push that takes three seconds to land makes `pendingOps`
 *              non-zero for three seconds, and a glyph that blinks on and off through every
 *              ordinary save is precisely the tray-icon fidgeting 19.3 exists to prevent.
 *   vanishing  is IMMEDIATE — good news is silent and instant. Waiting two seconds to remove a
 *              glyph would mean the indicator outlives the condition, which is the one way a
 *              quiet signal can lie.
 *
 * A consequence worth stating: a pending state that resolves in under two seconds is never seen
 * at all. That is not a missed notification — it is the definition of healthy.
 *
 * ⚠ THE ENGINE MAY ALREADY DEBOUNCE, AND THE TWO ENGINES DIFFER. `sync/client.js`'s
 * `touchStatus()` debounces its `onStatus` EMISSION by the same 2 s (ADR 003 §8.3); the M1
 * publisher `sync/personal.js`'s `emitStatus()` does not. Stacked, they would take four seconds
 * to show a glyph. So the window is injectable — `initSyncStatus({debounce: 0})` — and a host
 * wiring this to an engine that already debounces should pass 0. It defaults to the full window
 * because an UNdebounced engine is the case where getting it wrong is visible (a flickering
 * glyph on every save) rather than merely slow.
 */
export const SYNC_DEBOUNCE_MS = 2000;

/** The window actually in force. Set by `initSyncStatus`; never read before it. */
let debounceMs = SYNC_DEBOUNCE_MS;

/** What the debounce is set to right now — exported so a test asserts the wiring, not the intent. */
export const syncDebounceMs = () => debounceMs;

// ─────────────────────────────────────────────────────────────────────────────
// 2. The port and the module state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SyncStatusPort  a narrowing of `sync.contract.js`'s `SyncClient`. This module
 *   needs two of its five methods and is handed only those, so it structurally cannot start,
 *   stop, push or pull — the "no sync button anywhere" rule enforced by the shape of the port
 *   rather than by everyone remembering it.
 * @property {() => {state:string, pendingOps:number, consecutiveFailures:number,
 *                   lastPullAt:number|null, errorKind:string|null, detail:string|null}} status
 * @property {(fn:() => void) => (() => void)} [subscribe]  optional push notification; without it
 *   the host calls `refreshSyncChrome()` itself after a txn, exactly as `update-ui.js` is driven.
 */

/** @type {SyncStatusPort|null} */
let sync = null;
let unsubscribe = null;
let nowFn = () => Date.now();
let scheduleFn = (ms, fn) => setTimeout(fn, ms);
let unscheduleFn = (h) => clearTimeout(h);
let mountSelector = '.toolbar';

/** What is on screen right now. `healthy` means "no node". */
let shown = SYNC_STATE.healthy;
/** The raw state we last saw, and when it first differed from `shown`. */
let candidate = SYNC_STATE.healthy;
let candidateSince = null;
let debounceTimer = null;

/**
 * Mount over a sync engine. Called at the family opt-in moment, next to the `await import()` that
 * pulls in `sync/` (ADR 003 §7 gate 2). Called with no arguments it unmounts completely: the node
 * goes, the timer goes, the subscription goes — which is what a test teardown wants and what
 * leaving a Familienkreis (20.3) will want.
 *
 * @param {{sync?:SyncStatusPort|null, now?:() => number,
 *          schedule?:(ms:number, fn:Function) => any, unschedule?:(h:any) => void,
 *          mount?:string, debounce?:number}} deps
 */
export function initSyncStatus({
  sync: s = null, now = null, schedule = null, unschedule = null, mount = null, debounce = null,
} = {}) {
  if (unsubscribe) { try { unsubscribe(); } catch { /* a dead engine is not an error */ } }
  unsubscribe = null;
  if (debounceTimer != null) { try { unscheduleFn(debounceTimer); } catch { /* fired */ } }
  debounceTimer = null;
  sync = s;
  nowFn = typeof now === 'function' ? now : () => Date.now();
  scheduleFn = typeof schedule === 'function' ? schedule : (ms, fn) => setTimeout(fn, ms);
  unscheduleFn = typeof unschedule === 'function' ? unschedule : (h) => clearTimeout(h);
  mountSelector = typeof mount === 'string' && mount ? mount : '.toolbar';
  debounceMs = Number.isFinite(debounce) && debounce >= 0 ? debounce : SYNC_DEBOUNCE_MS;
  shown = SYNC_STATE.healthy;
  candidate = SYNC_STATE.healthy;
  candidateSince = null;
  removeGlyph();
  if (sync && typeof sync.subscribe === 'function') {
    try { unsubscribe = sync.subscribe(() => refreshSyncChrome()); } catch { unsubscribe = null; }
  }
}

/** Present only where an engine has been mounted. Solo mode: absent, not silent-because-broken. */
export const syncSupported = () => !!sync;

/** The raw reading, normalised, with an honest answer when there is no engine at all. */
export function syncStatusRaw() {
  if (!sync) {
    return Object.freeze({
      state: SYNC_STATE.healthy, pendingOps: 0, consecutiveFailures: 0,
      lastPullAt: null, errorKind: null, detail: null, supported: false,
    });
  }
  let r;
  try {
    r = sync.status() || {};
  } catch {
    // An engine that throws on `status()` is itself an error condition, and the honest reading is
    // the visible one. Swallowing it into `healthy` would be the quiet signal lying.
    r = { state: SYNC_STATE.error, errorKind: null, detail: null };
  }
  const state = r.state === SYNC_STATE.pending || r.state === SYNC_STATE.error
    ? r.state
    : SYNC_STATE.healthy;
  return Object.freeze({
    state,
    pendingOps: Number.isFinite(r.pendingOps) ? r.pendingOps : 0,
    consecutiveFailures: Number.isFinite(r.consecutiveFailures) ? r.consecutiveFailures : 0,
    lastPullAt: Number.isFinite(r.lastPullAt) ? r.lastPullAt : null,
    errorKind: SYNC_ERROR_KINDS.includes(r.errorKind) ? r.errorKind : null,
    detail: typeof r.detail === 'string' && r.detail ? r.detail : null,
    supported: true,
  });
}

/**
 * The DISPLAY state — the raw reading after §1's asymmetric debounce.
 *
 * Pure with respect to the DOM: it reads the clock and the module's own memory and returns a
 * word. `refreshSyncChrome()` is the only thing that draws. Split this way so a test can assert
 * the debounce without a node, and so the settings section and the glyph cannot disagree.
 */
export function syncDisplayState() {
  const raw = syncStatusRaw();
  const want = raw.state;

  if (want === shown) {
    candidate = want;
    candidateSince = null;
    return shown;
  }
  // Vanishing is immediate — see SYNC_DEBOUNCE_MS. `healthy` is the only state a glyph can leave
  // for without waiting, and it is the state where leaving means the node disappears entirely.
  if (want === SYNC_STATE.healthy) {
    shown = SYNC_STATE.healthy;
    candidate = SYNC_STATE.healthy;
    candidateSince = null;
    return shown;
  }
  // Appearing — or escalating pending → error — waits out the window.
  if (candidate !== want) {
    candidate = want;
    candidateSince = nowFn();
  }
  if (candidateSince !== null && nowFn() - candidateSince >= debounceMs) {
    shown = want;
    candidateSince = null;
  }
  return shown;
}

/** The whole view model, frozen. What the glyph, its tooltip and the settings section render. */
export function syncStatusState() {
  const raw = syncStatusRaw();
  const state = syncDisplayState();
  return Object.freeze({
    supported: raw.supported,
    state,                       // what is DRAWN, after the debounce
    rawState: raw.state,         // what the engine currently says
    pendingOps: raw.pendingOps,
    lastPullAt: raw.lastPullAt,
    errorKind: raw.errorKind,
    detail: raw.detail,
    /** The one sentence the tooltip and the settings section both use. */
    sentence: sentenceFor(state, raw),
  });
}

function sentenceFor(state, raw) {
  if (!raw.supported) return t('syncSolo');
  if (state === SYNC_STATE.error) {
    // The engine may supply its own `detail` — one plain sentence, per the contract. It is
    // preferred over the generic table because it can say something the table cannot; the table
    // is the fallback, never a second sentence stacked on top of it.
    if (raw.detail) return raw.detail;
    return t(SYNC_ERROR_KEY[raw.errorKind] || 'syncErrGeneric');
  }
  if (state === SYNC_STATE.pending) {
    return raw.pendingOps > 0 ? t('syncPendingDetail', raw.pendingOps) : t('syncPendingNone');
  }
  return t('syncHealthy');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The glyph
// ─────────────────────────────────────────────────────────────────────────────

/** The id of the one node this feature is allowed to put on screen. */
export const SYNC_GLYPH_ID = 'sync-dot';

/**
 * Draw, update or remove the glyph. Idempotent and cheap; safe to call from any redraw, and the
 * host should call it after every txn and on every engine notification.
 *
 * It also re-arms the debounce timer when a transition is pending, so the glyph appears two
 * seconds after the condition even if nothing else happens to trigger a redraw. That timer is
 * the only timer in this module and it exists for at most one window.
 */
export function refreshSyncChrome() {
  const s = syncStatusState();

  // Re-arm: if the engine wants a state we are not showing yet, come back when the window closes.
  if (s.rawState !== s.state && s.rawState !== SYNC_STATE.healthy) {
    if (debounceTimer == null) {
      const left = candidateSince === null
        ? debounceMs
        : Math.max(0, debounceMs - (nowFn() - candidateSince));
      debounceTimer = scheduleFn(left, () => { debounceTimer = null; refreshSyncChrome(); });
    }
  } else if (debounceTimer != null) {
    try { unscheduleFn(debounceTimer); } catch { /* fired */ }
    debounceTimer = null;
  }

  if (s.state === SYNC_STATE.healthy) { removeGlyph(); return null; }

  ensureCss();
  const host = document.querySelector(mountSelector);
  if (!host) return null;
  let node = document.getElementById(SYNC_GLYPH_ID);
  if (!node) {
    node = el('span', 'sync-dot');
    node.id = SYNC_GLYPH_ID;
    // `role="status"` and not `alert`: an alert interrupts, and neither of these states is an
    // interruption. `aria-live` is deliberately absent — polite live regions still speak, and a
    // screen reader announcing "offline" every time a save queues is the audible spinner.
    node.setAttribute('role', 'status');
    host.appendChild(node);
  }
  node.classList.toggle('pending', s.state === SYNC_STATE.pending);
  node.classList.toggle('error', s.state === SYNC_STATE.error);
  // The tooltip is the whole of the chrome's vocabulary. No text label, no count.
  node.title = s.sentence;
  node.setAttribute('aria-label', s.sentence);
  return node;
}

function removeGlyph() {
  const n = document.getElementById(SYNC_GLYPH_ID);
  if (n) n.remove();
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The settings section (A10 — `familysettings.js` mounts this)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * „Abgleich", inside the Familie section. Prose and a timestamp — no button, no switch, no
 * numeral in a badge. 19.2: there is no manual refresh anywhere, and this section is where a user
 * who went looking finds out what is happening and, crucially, that they need do nothing.
 *
 * @param {HTMLElement} body the sheet body
 * @param {{rebuild:Function, close:Function}} api unused; kept so every section has one signature
 */
export function buildSyncSection(body, api) {
  void api;
  ensureCss();
  body.appendChild(el('div', 'section-title', t('syncSectionTitle')));
  const s = syncStatusState();

  if (!s.supported) {
    // Solo. Not "sync is off" — there is nothing here to switch on, and 21.5 promises the board
    // stays on this Mac. Saying so plainly is the disclosure.
    body.appendChild(el('p', 'hint', t('syncSolo')));
    return;
  }

  const line = el('p', 'sync-line');
  const dot = el('span', 'sync-dot inline');
  dot.classList.toggle('pending', s.state === SYNC_STATE.pending);
  dot.classList.toggle('error', s.state === SYNC_STATE.error);
  dot.classList.toggle('ok', s.state === SYNC_STATE.healthy);
  line.appendChild(dot);
  line.appendChild(el('span', 'sync-sentence', s.sentence));
  body.appendChild(line);

  const when = el('p', 'hint sync-when',
    s.lastPullAt ? t('syncLastPull', formatWhen(s.lastPullAt, getLang())) : t('syncNever'));
  body.appendChild(when);

  // The half a user actually needs: nothing is expected of them. 19.2 in one sentence.
  body.appendChild(el('p', 'hint sync-no-button', t('syncNoButtonHint')));
}

function formatWhen(ms, lang) {
  try {
    return new Date(ms).toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return String(ms);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. The styles — see the file header on why they live here for now
// ─────────────────────────────────────────────────────────────────────────────

export const SYNC_CSS_ID = 'lzp-syncstatus-css';

/**
 * Six pixels, twice. The ring and the disc are the same circle with a different fill, so the two
 * states are the same object in two conditions rather than two different signals — which is what
 * `sync.contract.js` §4 means by "the same slot".
 *
 * Neither uses the accent gradient: that is the board's „Heute" highlight and the update hint's
 * dot, and it says "something good is available". Neither uses red. Pending is the ink
 * hierarchy's weakest tone, because being offline with your work safe is not news; error is the
 * amber-brown `app.css` already spends on the 22.7 bar, because a stalled sync and an outdated
 * client are the same register of "worth knowing, nothing is lost".
 */
export const SYNC_CSS = `
.sync-dot {
  flex: none; width: 6px; height: 6px; border-radius: 50%;
  box-sizing: border-box; display: inline-block;
  background: transparent; border: 1.5px solid transparent;
}
.sync-dot.pending { border-color: var(--ink-4); }
.sync-dot.error { border-color: #B8722A; background: #B8722A; }
.sync-dot.ok { border-color: var(--line-1); }
.sync-dot.inline { margin-right: 7px; vertical-align: 1px; }
#sync-dot { margin-left: 2px; }
.sync-line { margin: 0 0 4px; font: 400 12px/1.6 var(--font); color: var(--ink-1); display: flex; align-items: baseline; }
.sync-sentence { min-width: 0; }
.hint.sync-when, .hint.sync-no-button { margin-left: 0; }
.hint.sync-when { margin-bottom: 6px; }

/* There is no motion in this feature and there must not be: a pulsing dot is a
   spinner with a smaller footprint, and 19.3's "small, unobtrusive" is about
   the eye's attention, not the pixel count. This block exists so a later
   addition cannot forget the rule. */
@media (prefers-reduced-motion: reduce) {
  .sync-dot { animation: none !important; transition: none !important; }
}
`;

function ensureCss() {
  if (document.getElementById(SYNC_CSS_ID)) return;
  const s = document.createElement('style');
  s.id = SYNC_CSS_ID;
  s.textContent = SYNC_CSS;
  document.head.appendChild(s);
}
