// src/js/feedback/port.js — the ONE seam through which a report can leave.  LZP-1009.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THE SENDER IS INJECTED AND NOT IMPORTED
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// ADR 003 §7 gate 2, measured by `tests/tier1/network-scope.test.js` §2:
//
//   > there is EXACTLY ONE dynamic door out of the boot graph, and it is `family/mount.js`
//
// The Rückmeldung screen lives in Einstellungen (Principle 10 — it is not a floating button on
// the board), and Einstellungen is in the boot graph of every solo launch. So if this module
// imported `platform/net.js` — statically or with an `await import()` — a solo Mac would either
// evaluate the network stack at boot or grow a SECOND dynamic door, and 21.5's "in solo mode the
// app makes zero network requests" would stop being a structural fact and become a promise about
// an `if`.
//
// So the feedback tree imports nothing that can open a socket. **It holds a port.** Whoever
// already owns a transport binds it; until somebody does, `send` is null and the Rückmeldung
// screen is a preview screen with two fallbacks, which is a real feature and not a stub.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ██ THE BINDING — LANDED, AND CORRECTED ON ONE FIELD ██
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `src/js/family/mount.js#bindFeedback` binds this port, from `start()` on a personal-space Mac
// and from `startCircleEngine()` on one in a Familienkreis. E10-1009-A is CLOSED.
//
// The line this header used to publish was one field wrong, and the correction is worth keeping
// because it is the kind of mistake a hand-off makes:
//
//     send: (body) => parts.transport.request('POST', '/api/v1/feedback', undefined, body)
//
// A transport answers `{status, headers, json}` (`platform/net.js`), and this port promises
// `{status, body}` — `ui.js#doSend` reads `res.body.error` to name a refusal. Unmapped, every
// named server answer (`payload_too_large`, `rate_limited`, `not_implemented`) would have reached
// the person as the generic failure sentence. The binder maps it.
//
// A Mac with NO relay — solo — still binds nothing, and that is not a gap: `canSend()` is false,
// „Senden" is disabled, `copy.js#noRelay` says why, and „Kopieren" / „Als Datei sichern" are on
// the preview screen from the start. `tests/tier1/feedback.test.js` §6 pins this contract.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY A PORT AND NOT A TRANSPORT
// ─────────────────────────────────────────────────────────────────────────────────────────────
// `send` is `(body) => Promise<{status, body}>` — the shape `net.js`'s transports already have,
// and the smallest thing that can be. It is NOT handed an origin, a path, or headers: the path is
// fixed by the binder, so nothing in this tree can be pointed at a second endpoint by a bug here,
// and `assertReachable` still refuses every path outside the one prefix at the other end.
// (Spelled without a quoted path literal: `tests/attack/privacy-e5-endpoint.test.js` §5 now
// reads this file's raw bytes to enumerate every path the product can build, and a path in a
// comment would join that set as though it were addressable.)

/** @typedef {{ send:(body:Object)=>Promise<{status:number, body:any}>,
 *              sign?:(bytes:Uint8Array)=>Promise<Uint8Array>,
 *              devicePub?:string, appVersion?:string, build?:string,
 *              spaceKind?:'solo'|'personal'|'family' }} FeedbackPort */

/** @type {FeedbackPort|null} */
let port = null;

/**
 * Bind the sender. Idempotent; the last binder wins, which is what a re-arm after „Beitreten"
 * needs.
 * @param {FeedbackPort|null} p
 */
export function setFeedbackPort(p) {
  if (p == null) { port = null; return; }
  if (typeof p.send !== 'function') {
    throw new TypeError('feedback: a port must carry send(body) -> Promise<{status, body}>');
  }
  port = p;
}

/** @returns {FeedbackPort|null} */
export function feedbackPort() { return port; }

/** Whether pressing „Senden" can do anything at all. Drives the screen, not a hidden branch. */
export function canSend() { return !!(port && typeof port.send === 'function'); }

/** The path the binder must use. Exported so the binding and the server agree in one place. */
export const FEEDBACK_PATH = '/api/v1/feedback';
