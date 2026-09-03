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
// ██ THE ONE LINE THIS TICKET DOES NOT OWN, STATED AS A FACT RATHER THAN A HOPE ██
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `src/js/family/mount.js` belongs to a parallel workflow and is not this ticket's to edit. The
// binding it owes is this, beside the `setFamilySections(...)` call it already makes:
//
//     import { setFeedbackPort } from '../feedback/port.js';
//     setFeedbackPort({
//       send: (body) => parts.transport.request('POST', '/api/v1/feedback', undefined, body),
//       appVersion: cfg.clientVersion,
//       spaceKind: armed.familySpaceId ? 'family' : 'personal',
//     });
//
// Until that line lands, a Mac that HAS a relay still cannot send from the app, and the honest
// consequence is on screen in `copy.js` → `noRelay`, not hidden behind a spinner. It is filed as
// **E10-1009-A** in FINDINGS.md. `tests/tier1/feedback.test.js` §6 pins the port's contract so
// that the line, when it lands, cannot land wrong.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY A PORT AND NOT A TRANSPORT
// ─────────────────────────────────────────────────────────────────────────────────────────────
// `send` is `(body) => Promise<{status, body}>` — the shape `net.js`'s transports already have,
// and the smallest thing that can be. It is NOT handed an origin, a path, or headers: the path is
// fixed by the binder, so nothing in this tree can be pointed at a second endpoint by a bug here,
// and `assertReachable` still refuses every path but `/api/v1/…` at the other end.

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
