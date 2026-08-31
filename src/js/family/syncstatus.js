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

// ═════════════════════════════════════════════════════════════════════════════
// WHAT THE CONVERGENCE ADVERSARY CHANGED HERE
// ═════════════════════════════════════════════════════════════════════════════
//
// Everything above still holds. What it rested on did not:
//
//   > In every finding this round, BOTH MACS REPORT `healthy`. Story 19.3's "silence is the
//   > design" is a promise that SILENCE MEANS HEALTH. At present silence means only that the
//   > engine's own two in-memory maps are empty.
//
// This file rendered, in one slot, the word the engine handed it — and the word was wrong, for a
// durably parked line (L-2), for a terminal refusal after the process ended (L-1), for a line a
// compaction folded away unacknowledged (E5-2) and for a forked relay (P-4). Rendering it
// faithfully made this module a faithful renderer of a false claim.
//
// The judgement still does not live here. It moved UP, into `sync/status.js`, which is a leaf and
// folds `tests/helpers/sync-domains.js`'s domain S4 — the ENUMERATION of what can be observed —
// over the engine's reading AND the durable evidence in `store.diagnostics()`. This file's
// contract is unchanged in shape: it renders, in one slot, the word it is handed. The word is now
// the honest one, and `judgeSyncStatus().silent` is the promise as a boolean, so the settings
// section can say "there is nothing to tell you" and mean it.
//
// THE THREE RULES ARE UNCHANGED AND ARE WHAT KEEPS THIS FROM BECOMING A WARNING TRIANGLE:
// healthy is still NOTHING, pending is still one 6 px hollow ring, error is still the same slot
// filled in amber-brown, and there is still no spinner, no badge count and no button. The new
// states are not new signals — they are new REASONS for the two signals that already existed.

// ═════════════════════════════════════════════════════════════════════════════
// D9's WAITING STATE IS THE THIRD REASON FOR THE SECOND SIGNAL
// ═════════════════════════════════════════════════════════════════════════════
//
// PO decision D9, and the joiner's half of ADR 002 §7.1 step 4: a member is IN the circle the
// moment she redeems and holds no epoch key until another member's Mac wraps to her. Between
// those two moments her board is correct and empty, and `E6-VERIFICATION.md` §5.2 measured what
// she was told about it — nothing, on the board, for ever.
//
// THAT STATE IS `pending`, AND THE THREE RULES DECIDE EVERYTHING ABOUT HOW IT LOOKS:
//
//   · IT IS NEVER `error`. Nothing has failed. The ring stays HOLLOW, in the ink hierarchy's
//     weakest tone — the same glyph an offline Mac gets, because it is the same register: your
//     work is safe, the app is fine, something arrives later. `§1` of `sync-status.dom.js`'s new
//     block asserts the class is `pending` and never `error`, in both the chrome and the sheet.
//   · IT IS NEVER A SPINNER, and it is not on the board. It is the one 6 px glyph in the
//     toolbar that this module has always drawn, with a different sentence behind it.
//   · IT IS NEVER A DEMAND. `createjoin.js`'s `circleWaiting` / `circleWaitingCalm` are the two
//     sentences, written for D9 and checked for tone there; this file renders them and does not
//     re-word them. Nothing in either asks her to fetch somebody or to press anything, and D9
//     part 4 is the promise they rest on: the keys arrive because the next Mac syncs.
//
// ⚠ IT MUST WORK WITH NO ENGINE AT ALL, and that is the finding rather than a nicety. `sync` is
// this module's PERSONAL engine port and `initSyncStatus` is called only from `mount.js#start()`
// — story 19.4's own-device sync. A Mac can be a full member of a Familienkreis and have opted
// into none of that, which is exactly the Mac §5.2 measured. So the waiting fact is read
// INDEPENDENTLY of `sync`: `syncStatusRaw()` reports it when `supported` is false, and
// `refreshSyncChrome()` — which `main.js` calls on every redraw the moment the family door has
// been opened — draws it. Gating D9's line on an engine nobody armed is how the line came to
// have no renderer in the first place.
//
// WHERE THE FACT COMES FROM. `familyWaitingState()` in `createjoin.js`, which owns
// `CIRCLE_PREFS.pending` and clears it (`mount.js#onKeys`). It is imported rather than
// re-derived — a second reading of "am I still waiting?" is how the board and the settings sheet
// come to disagree — and it is still injectable (`initSyncStatus({waiting})`) for the same
// reason the store is: a test must be able to take the durable half out. The import costs a solo
// Mac nothing: every module that imports THIS one already imports `createjoin.js`.

import { t, getLang } from '../i18n.js';
import { familyWaitingState } from './createjoin.js';
import { el } from '../ui.js';
import { store as appStore } from '../store.js';
import {
  SYNC_STATE as JUDGED_STATE, SYNC_ERROR_KINDS as JUDGED_ERROR_KINDS, judgeSyncStatus,
} from '../sync/status.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. The three states, and the numbers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `sync.contract.js` §4's `SyncState`. RE-EXPORTED from `sync/status.js` rather than declared
 * again: the two copies of this object were identical by inspection and by nothing else, and a
 * renderer whose state vocabulary can drift from the judge's is how a fourth state ends up
 * rendering as `healthy`.
 */
export const SYNC_STATE = JUDGED_STATE;

/**
 * `sync.contract.js` §4's `errorKind` domain, from the same single source. Every kind has a
 * sentence in `i18n.js`; `SYNC_ERROR_KEY` below is the mapping, and an unknown kind falls back to
 * the generic sentence rather than to a blank line.
 */
export const SYNC_ERROR_KINDS = JUDGED_ERROR_KINDS;

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

/**
 * @typedef {Object} SyncObservabilityPort  the DURABLE half of the reading. Two methods, both
 *   already on `store.js`: `diagnostics()` for the enumerated evidence and `subscribeWarnings()`
 *   for the push notification. It is a narrowing for the same reason the engine port is one —
 *   nothing here can write to the board, save, import or mutate a single op.
 * @property {() => Object} diagnostics
 * @property {(fn:(msg:string, all:string[]) => void) => (() => void)} [subscribeWarnings]
 */

/** @type {SyncStatusPort|null} */
let sync = null;
/**
 * @type {SyncObservabilityPort|null}
 *
 * WHY THIS DEFAULTS TO THE APP'S OWN STORE AND IS STILL INJECTABLE. `family/mount.js` builds the
 * engine and hands it over; the store is a singleton that is already loaded, already reachable
 * from every entry point and has no gate to cross (ADR 003 §7's gate 2 is about `sync/` and
 * `crypto/`, and `sync/status.js` is a leaf with no imports at all). Defaulting to it means
 * F-8's missing consumer exists in the SHIPPED app rather than only where a host remembers to
 * wire it — which is the exact failure mode F-8 is: a seam with no consumer.
 *
 * IT IS ONLY EVER READ WHILE AN ENGINE IS MOUNTED. Solo mode passes no engine, so solo mode
 * reads no diagnostics, subscribes to nothing and shows nothing — the module's original promise,
 * unchanged. A test that wants the store out of the way passes `store: null` and gets exactly
 * that.
 */
let observability = null;
/**
 * @type {(() => {pending:boolean, line:string, calm:string})|null}
 *
 * D9's fact. Defaults to `createjoin.js`'s reader for the reason `observability` defaults to the
 * app's own store: finding F-8 is a seam with no consumer, and a waiting state that only renders
 * where a host remembered to wire it is that finding again in a new file. `waiting: null` takes
 * it out, which is what a test asserting the engine half alone wants.
 */
let waitingFn = familyWaitingState;
let unsubscribe = null;
let unsubscribeWarnings = null;
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
export function initSyncStatus(deps = {}) {
  const {
    sync: s = null, now = null, schedule = null, unschedule = null, mount = null, debounce = null,
  } = deps;
  if (unsubscribe) { try { unsubscribe(); } catch { /* a dead engine is not an error */ } }
  unsubscribe = null;
  if (unsubscribeWarnings) { try { unsubscribeWarnings(); } catch { /* ditto */ } }
  unsubscribeWarnings = null;
  if (debounceTimer != null) { try { unscheduleFn(debounceTimer); } catch { /* fired */ } }
  debounceTimer = null;
  sync = s;
  // `'store' in deps` and not `deps.store ?? appStore`: passing `store: null` must MEAN null.
  // Without the `in` test there would be no way to mount an engine and deliberately keep the
  // durable half out, which is what the tier 2 fakes need and what a support tool wants.
  observability = 'store' in deps ? deps.store : appStore;
  // `'waiting' in deps` for the same reason as `'store'`: passing `waiting: null` must MEAN null.
  waitingFn = 'waiting' in deps
    ? (typeof deps.waiting === 'function' ? deps.waiting : null)
    : familyWaitingState;
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
  // ── F-8 · THE CONSUMER ─────────────────────────────────────────────────────────────────────
  //
  // `store.warnings` has held every sentence this app writes about what it lost, refused,
  // coerced or quarantined since LZP-30x, `subscribeWarnings()` has been the seam the whole time,
  // and NOTHING HAS EVER SUBSCRIBED. This line is the consumer. It does not read the sentences —
  // the fold in `sync/status.js` counts them and the settings section says so — it exists so that
  // a warning written between two redraws still moves the glyph, the way an engine notification
  // does. Without it the channel would be observable only by luck of timing.
  if (sync && observability && typeof observability.subscribeWarnings === 'function') {
    try { unsubscribeWarnings = observability.subscribeWarnings(() => refreshSyncChrome()); }
    catch { unsubscribeWarnings = null; }
  }
}

/** Present only where an engine has been mounted. Solo mode: absent, not silent-because-broken. */
export const syncSupported = () => !!sync;

/**
 * The DURABLE half of the reading — `store.diagnostics()`, or null when there is nothing to ask.
 *
 * Only consulted while an engine is mounted; see `observability`'s note. A store that throws on
 * `diagnostics()` is reported as `null`, which `sync/status.js` renders as SIX BLIND SPOTS and
 * therefore as `silent: false`. That is the intended reading: a build that cannot answer the
 * question has not earned silence.
 */
function diagnosticsRaw() {
  if (!sync || !observability || typeof observability.diagnostics !== 'function') return null;
  try { return observability.diagnostics(); } catch { return null; }
}

/** D9's fact, or the "nothing to wait for" answer — which is what solo mode must read. */
const NOT_WAITING = Object.freeze({ pending: false, line: '', calm: '' });
function waitingNow() {
  if (!waitingFn) return NOT_WAITING;
  let w;
  try { w = waitingFn(); } catch { return NOT_WAITING; }
  if (!w || w.pending !== true) return NOT_WAITING;
  return Object.freeze({
    pending: true,
    line: typeof w.line === 'string' ? w.line : '',
    calm: typeof w.calm === 'string' ? w.calm : '',
  });
}

/**
 * The raw reading, normalised, with an honest answer when there is no engine at all.
 *
 * SINCE THE CONVERGENCE ROUND THIS IS A MERGE, NOT A RELAY. `sync/status.js`'s `judgeSyncStatus`
 * folds domain S4 over the engine's word and the store's durable evidence and returns the louder
 * of the two — it can only ever RAISE the state, never lower one the engine reported. Every
 * failure this round is a case where the engine says `healthy` and the disk says otherwise.
 */
export function syncStatusRaw() {
  const waiting = waitingNow();
  if (!sync) {
    // NO PERSONAL ENGINE — and D9's Mac is exactly this Mac. `silent` is 19.3's promise as a
    // boolean and a member who is still waiting for her first key has not been told anything
    // yet, so silence has not been earned here either.
    return Object.freeze({
      state: waiting.pending ? SYNC_STATE.pending : SYNC_STATE.healthy,
      pendingOps: 0, consecutiveFailures: 0,
      lastPullAt: null, errorKind: null, detail: null, supported: false,
      observables: Object.freeze([]), blind: Object.freeze([]),
      silent: !waiting.pending, waiting,
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
  const engineState = r.state === SYNC_STATE.pending || r.state === SYNC_STATE.error
    ? r.state
    : SYNC_STATE.healthy;
  const j = judgeSyncStatus({
    engine: {
      state: engineState,
      pendingOps: r.pendingOps,
      consecutiveFailures: r.consecutiveFailures,
      lastPullAt: r.lastPullAt,
      errorKind: SYNC_ERROR_KINDS.includes(r.errorKind) ? r.errorKind : null,
      detail: typeof r.detail === 'string' && r.detail ? r.detail : null,
    },
    diagnostics: diagnosticsRaw(),
  });
  // THE WAITING FACT ONLY EVER RAISES, and it may raise ONLY as far as `pending` — never past a
  // state the judge already reached. An engine error is a louder truth than a wait and keeps the
  // filled ring; a wait is a louder truth than silence and takes the hollow one. That asymmetry
  // is the whole of "D9's calm line is the pending state, never error", written as one line.
  const state = waiting.pending && j.state !== SYNC_STATE.error ? SYNC_STATE.pending : j.state;
  return Object.freeze({
    state,
    pendingOps: j.pendingOps,
    consecutiveFailures: j.consecutiveFailures,
    lastPullAt: j.lastPullAt,
    errorKind: j.errorKind,
    detail: j.detail,
    supported: true,
    /** The rows of S4 that are PRESENT. Read by the settings section; never by the chrome. */
    observables: j.observables,
    /** The rows this build cannot answer. Non-empty means silence has not been earned. */
    blind: j.blind,
    /** 19.3's promise as a boolean, and the only thing allowed to mean "nothing to tell you". */
    silent: j.silent && !waiting.pending,
    /** D9's fact and its two sentences, so the chrome and the sheet cannot word it differently. */
    waiting,
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
    rawState: raw.state,         // what the engine AND the disk currently say, merged
    pendingOps: raw.pendingOps,
    lastPullAt: raw.lastPullAt,
    errorKind: raw.errorKind,
    detail: raw.detail,
    observables: raw.observables,
    blind: raw.blind,
    silent: raw.silent,
    waiting: raw.waiting,
    /** The one sentence the tooltip and the settings section both use. */
    sentence: sentenceFor(state, raw),
  });
}

/**
 * ── THE SENTENCE, AND WHY IT ADDS NO STRING ──────────────────────────────────────────────────
 *
 * Four new reasons reached this module and NOT ONE new key was added to `i18n.js`. That is not
 * frugality; `i18n.js` belongs to another owner this round and a UI that invents an untranslated
 * sentence is worse than one that reuses a true one. (D9's waiting state added none either, for
 * a second reason: its two sentences are `createjoin.js`'s, written and checked for tone there.
 * Where a family-mode string SHOULD live when one is genuinely new is settled once, in
 * `family/familysettings.js`'s header — a frozen `{de, en}` in the module, on Principle 7.) Each new reason is spoken with the existing
 * sentence that is ACTUALLY TRUE OF IT:
 *
 *   parked   → `syncErrGeneric` — „Der Abgleich steht gerade. Das Board auf diesem Mac
 *              funktioniert weiter." **NOT `syncPendingDetail`,** which was the first choice and
 *              was checked in a real browser before it was: it reads „Eine Änderung wartet auf
 *              die VERBINDUNG", and a held op is not waiting on the network — it is waiting on an
 *              attestation, a key or an app update. That sentence would name a cause the app has
 *              invented, and a person who reconnects and sees it again learns nothing. The
 *              generic sentence names no cause, is true of every park reason, and its second half
 *              is the half that matters: nothing on this Mac is lost.
 *   refused  → `syncErrQuarantine` — the sentence written for this case, word for word.
 *   lost     → `syncErrGeneric` — „Der Abgleich steht gerade. Das Board auf diesem Mac
 *              funktioniert weiter." Both halves are true and the second is the one that matters.
 *   chain    → `syncErrGeneric`, same reading.
 *   warnings → `syncErrGeneric`. The SENTENCES themselves are not rendered: `_warn` writes German
 *              prose and the English sheet must not carry it (`tests/tier2/sync-status.dom.js`
 *              asserts that). They remain in `diagnostics().warnings` for a support bundle.
 *
 * TWO PROPER SENTENCES ARE OWED and are reported rather than faked — one for a held op that is
 * not merely „pending", and one for a line that will not reach the other Mac.
 */
function sentenceFor(state, raw) {
  // D9 FIRST, AND BEFORE THE SOLO SENTENCE. A Mac with a circle and no own-device sync is not
  // solo — `t('syncSolo')` promises that the board talks to nothing, which is the one thing that
  // is no longer true of her. It comes after `error` by construction: `state` is only `pending`
  // here when the judge found nothing louder.
  if (state === SYNC_STATE.pending && raw.waiting.pending) return raw.waiting.line;
  if (!raw.supported) return t('syncSolo');
  if (state === SYNC_STATE.error) {
    // The engine may supply its own `detail` — one plain sentence, per the contract. It is
    // preferred over the generic table because it can say something the table cannot; the table
    // is the fallback, never a second sentence stacked on top of it.
    if (raw.detail) return raw.detail;
    return t(SYNC_ERROR_KEY[raw.errorKind] || 'syncErrGeneric');
  }
  if (state === SYNC_STATE.pending) {
    // THE OUTBOX SPEAKS FIRST, and only the outbox may use the connection sentence. `pendingOps`
    // is work waiting on the network and `syncPendingDetail` says so truthfully; a held op is not,
    // and is given the cause-free sentence instead. The number stays a SENTENCE and never a
    // numeral in the chrome — 19.3's design note files this feature with the „neu" dot and the
    // update hint: a dot, not a badge count.
    if (raw.pendingOps > 0) return t('syncPendingDetail', raw.pendingOps);
    if (observableCount(raw, 'parked') > 0) return t('syncErrGeneric');
    return t('syncPendingNone');
  }
  return t('syncHealthy');
}

/** How many of one enumerated observable are present, or 0. */
function observableCount(raw, id) {
  const o = (raw.observables || []).find((x) => x.id === id);
  return o ? o.count : 0;
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

  if (!s.supported && !s.waiting.pending) {
    // Solo. Not "sync is off" — there is nothing here to switch on, and 21.5 promises the board
    // stays on this Mac. Saying so plainly is the disclosure.
    //
    // `&& !s.waiting.pending`: a Mac that joined a Familienkreis without opting into own-device
    // sync reaches this branch with `supported === false` and must NOT be told its board talks to
    // nothing. It falls through to the line below, where `s.sentence` is D9's.
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

  // D9's SECOND sentence, and the sheet is the only place it fits. The chrome gets one sentence
  // in a tooltip; here there is room for the half that answers "and what am I supposed to do?" —
  // „Bis dahin bleibt dein Board genau so, wie es ist. Es gibt nichts zu tun und niemanden zu
  // fragen." It is the sentence that makes the first one a statement rather than an instruction.
  if (s.waiting.pending) body.appendChild(el('p', 'hint sync-waiting-calm', s.waiting.calm));

  // No engine, so no last-pull time, no enumerated reasons and no 19.2 sentence about a button
  // that only exists where there is something to press. D9's two lines are the whole section.
  if (!s.supported) return;

  const when = el('p', 'hint sync-when',
    s.lastPullAt ? t('syncLastPull', formatWhen(s.lastPullAt, getLang())) : t('syncNever'));
  body.appendChild(when);

  // ── THE REASONS · one line per PRESENT row of domain S4 ─────────────────────────────────────
  //
  // This is the only place in the app where more than one thing is said at once, and it is the
  // right place: the sheet is where somebody has gone looking. The chrome stays one dot with one
  // sentence; here, a Mac holding a parked line AND carrying a refusal says both, because
  // collapsing them would be the same lie in miniature that `status()` was telling.
  //
  // The `healthy` guard is REDUNDANT BY CONSTRUCTION and is kept as a statement of intent: every
  // row of the enumeration raises the state above `healthy`, so a healthy Mac has an empty
  // `observables` and this loop has nothing to print. A settled pair of Macs gets the three lines
  // it always got and not a fourth reassuring one — silence stays free in the sheet as well as in
  // the chrome. (A mutant that deletes the guard therefore kills no row; the emptiness does the
  // work. A mutant that deletes the `outbox` skip below does kill one.)
  if (s.state !== SYNC_STATE.healthy) {
    // DE-DUPLICATED BY SENTENCE, and that is not tidying — it is the same rule as the chrome's.
    // The line above already says one of these things (whichever reason supplied the errorKind),
    // and `lost` and `chain` currently share the generic sentence because `i18n.js` has no words
    // of their own for them yet. Printing a sentence twice reads as two separate faults and
    // inflates one problem into a list, which is precisely what 19.3 spends its budget avoiding.
    // When the two owed strings land, these stop colliding and each gets its own line for free.
    const said = new Set([s.sentence]);
    for (const o of s.observables) {
      // `outbox` is already the subject of the sentence above; repeating it would double-count
      // the one condition this section has always reported.
      if (o.id === 'outbox') continue;
      const sentence = reasonSentence(o);
      if (said.has(sentence)) continue;
      said.add(sentence);
      body.appendChild(el('p', `hint sync-reason sync-reason-${o.id}`, sentence));
    }
  }

  // The half a user actually needs: nothing is expected of them. 19.2 in one sentence.
  body.appendChild(el('p', 'hint sync-no-button', t('syncNoButtonHint')));
}

/** One row of S4, in the sentence that is true of it. See `sentenceFor`'s note on the mapping. */
function reasonSentence(o) {
  if (o.errorKind && SYNC_ERROR_KEY[o.errorKind]) return t(SYNC_ERROR_KEY[o.errorKind]);
  return t('syncErrGeneric');
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
.hint.sync-when, .hint.sync-no-button, .hint.sync-reason { margin-left: 0; }
/* D9's second line sits under the first, at the reasons' indent, in the ordinary hint tone. No
   amber, no rule, no panel: a member waiting for her first key is not in an error state and the
   one thing this line may never look like is a warning. */
.hint.sync-waiting-calm { margin: 0 0 6px 13px; }
.hint.sync-when { margin-bottom: 6px; }
/* The reasons sit under the sentence they explain, indented by exactly the width of the inline
   dot plus its margin, so the eye reads them as belonging to it rather than as a second list. No
   colour of their own: the dot above already carries the register, and repeating amber four times
   would turn a calm sheet into a warning panel. */
.hint.sync-reason { margin: 0 0 4px 13px; }

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
