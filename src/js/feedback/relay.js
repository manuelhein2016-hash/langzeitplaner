// src/js/feedback/relay.js — the SECOND dynamic door, and the only one outside `family/mount.js`.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// ██ WHY A SECOND DOOR EXISTS AT ALL, AND WHAT IT COST ██
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `port.js`'s header is the honest record of the state this module replaces:
//
//   > A Mac with NO relay — solo — still binds nothing, and that is not a gap: `canSend()` is
//   > false, „Senden" is disabled …
//
// It was not a gap. It was the feature failing in exactly the case it was written for. The report
// that matters most is „ich komme nicht mehr rein" / „ich kann nicht mitmachen", and the person
// who writes it is by definition the person with no Familienkreis. A screen that collects that
// sentence and then greys out the one button is a screen that works for everyone except its
// reason for existing.
//
// So the PO amended story 21.5 on 2026-09-04/05: **a solo Mac may send**, and D10's amendment
// stops being vacuous. What survives unweakened is the half a person actually cares about —
// **this Mac originates nothing by itself.** There is no timer here, no retry, no poll, no
// launch check, no automatic caller of any kind; `tests/tier1/network-scope.test.js` §5b holds
// that from the page side and `shell-macos/main.swift#syncPreflight` holds it from the shell's.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS CHEAPER THAN THE OLD HEADER FEARED
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `platform/net.js#buildRequest` with `anonymous: true` skips `signRequest` **and** the
// `cfg.subtle` check. So a sender that signs nothing needs `platform/net.js` and `core/b64.js`
// and nothing else. The three things ADR 002 §2.4 and ADR 003 §7 gate 2 actually forbid a solo
// launch from evaluating — `src/js/crypto/`, `src/js/sync/`, `src/js/family/` — are not on the
// path from here and are not imported by this file in either form.
//
// That is why the door is `await import('../platform/net.js')` and not
// `await import('../family/mount.js')`: it opens onto ONE module, the module opens no socket by
// itself in the shell (the shell process performs the request), and the module it would
// otherwise have had to open onto is the whole of family mode.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ██ THE DOOR IS NEVER OPENED WHEN IT LEADS NOWHERE ██
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `probeRelay()` is NOT a door. It is one bridge command — `sync_status` — which is a read of a
// constant and a small JSON pref file in the shell process. No JS module is evaluated, no socket
// is opened, no DNS lookup is made, and in a browser the answer is `null`.
//
// Only if that answer names a configured origin does `bindSoloSender` evaluate `net.js`. A build
// with nothing pinned therefore never evaluates the network stack even once — the same
// observable property gate 2 had before this file existed, held by a different fact.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// PRECEDENCE — THE FAMILY BINDER STILL WINS
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `ui.js#openFeedback` calls `bindSoloSender` only when `canSend()` is ALREADY false. A Mac in a
// personal space or a Familienkreis has been bound by `family/mount.js#bindFeedback` at boot,
// with a `sign` and a `devicePub`, and `spaceKind` still reads `personal` / `family` there. This
// module binds the case that was previously unbindable and no other.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT AN UNSIGNED REPORT IS
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// A solo Mac has no device key — ADR 002 §2.4 mints one at the family opt-in moment and nowhere
// else — so the port is bound with no `sign` and no `devicePub`.
// `server/core/handlers/feedback.js` §5 already accepts that: `device` is optional, the record is
// written `signed: false`, and `PROVES.unsigned` says on the wire that it proves "nothing at all;
// the report was accepted without a credential, which is deliberate".
//
// That is the honest shape. The alternative — minting a keypair here so the report has a thread
// handle — would put `crypto/` behind this door, which is the one thing gate 2 is for.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// ██ THE OTHER HALF: THE OPERATOR'S READER ██
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `admin.js` draws a screen and holds no transport, for `settings.js`'s reason one directory up:
// the module that draws must not be the module that can reach a network. Every request the
// reports view makes is made HERE, in one function (`dispatch`), so "how many places in this
// product can reach the relay" stays a question with a countable answer.
//
// The credential is NOT built here either. `admin.js` holds a credential port and
// `family/mount.js` binds it, because the private half is his existing device signing key and
// that key lives behind gate 2's one door. This file is handed `(devicePub, sign)` and knows
// nothing about where they came from — the same injection discipline `net.js#signRequest` uses.

import { setFeedbackPort } from './port.js';
import { b64u } from '../core/b64.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. Constants
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The client version reported as `X-LZP-Client`. Mirrors `family/mount.js`'s `CLIENT_V`; the two
 * are separate because a solo Mac must not import that module to learn a string.
 */
export const CLIENT_V = '2.0.0';

/**
 * The scheme token for the OPERATOR credential. Deliberately not `LZP1`:
 * `server/core/auth.js#parseAuthorization` throws on any scheme it does not know, so a device
 * credential and an operator credential can never be confused for one another in either
 * direction — a family member's valid `LZP1` header is not an operator credential and does not
 * parse as one.
 */
export const ADMIN_SCHEME = 'LZPADMIN';

/**
 * The third domain prefix in this product, beside `net.js`'s `lzp/v2\n` and
 * `handlers/feedback.js`'s `lzp/feedback/v1\n`. One shared prefix and one field-order
 * coincidence is all a cross-protocol replay needs, so the reader's signatures live in their own
 * domain and verify as nothing else.
 */
export const ADMIN_PREFIX = 'lzp/reports/v1\n';

/** 16 bytes, the width `net.js#NONCE_BYTES` fixes. Replay is refused by the existing Nonce table. */
const NONCE_BYTES = 16;

/**
 * What a report id may look like, checked BEFORE it reaches a path.
 *
 * `net.js#assertReachable` would refuse a malformed one anyway — that is the structural gate and
 * it is not being replaced — but a value that came back over a network and is about to be
 * concatenated into a URL gets checked where it is read, not two modules later.
 *
 * It is the SAME shape as `server/core/handlers/reports.js#REPORT_ID_RE`, deliberately narrower
 * than the path grammar: a value the relay would refuse should not become a request.
 */
const ID_RE = /^rep_[A-Za-z0-9_-]{22}$/;

const TE = new TextEncoder();

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. The probe — a bridge read, not a door
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The shell bridge, or `null` in a browser. Never throws. */
function shellInvoke() {
  const fn = globalThis.window?.__TAURI__?.core?.invoke;
  return typeof fn === 'function' ? fn : null;
}

/**
 * Ask the shell what it is configured with. **No module is evaluated and no request is made** —
 * `sync_status` reads one constant and one small pref file in the shell process, and its whole
 * key set is `{configured, enabled, origin, originConfigured, reason, message}`
 * (`docs/v2/SHELL-VERIFICATION.md` §303-311).
 *
 * `null` means "not in a shell, or a shell too old to answer", which are the same thing to every
 * caller here: no origin, so no door.
 *
 * @param {(cmd:string, args?:object)=>Promise<any>} [invoke]
 * @returns {Promise<null|{origin:string|null, originConfigured:boolean, enabled:boolean}>}
 */
export async function probeRelay(invoke) {
  const call = typeof invoke === 'function' ? invoke : shellInvoke();
  if (!call) return null;
  try {
    const o = await call('sync_status', {});
    if (!o || typeof o !== 'object') return null;
    return {
      origin: typeof o.origin === 'string' && o.origin ? o.origin : null,
      originConfigured: o.originConfigured === true,
      enabled: o.enabled === true,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. The solo sender
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Bind the feedback port on a Mac that has no space and therefore no binder.
 *
 * Returns a WORD rather than a boolean, the way `familysettings.js#armShellSync` does and for the
 * same reason: four outcomes that a caller cannot act on differently but a test must be able to
 * tell apart. Nothing in the product reads the return value.
 *
 * @param {(cmd:string, args?:object)=>Promise<any>} [invoke]
 * @returns {Promise<'bound'|'no-origin'|'not-in-a-shell'|'failed'>}
 */
export async function bindSoloSender(invoke) {
  const call = typeof invoke === 'function' ? invoke : shellInvoke();
  if (!call) return 'not-in-a-shell';
  const st = await probeRelay(call);
  // ██ THE DOOR STAYS SHUT. ██ Not "opened and then unused" — the `await import` below is not
  // reached at all, so a build with nothing pinned never evaluates `net.js`, exactly as it did
  // not before this module existed.
  if (!st || !st.originConfigured || !st.origin) return 'no-origin';
  try {
    const transport = await anonymousBridge(call, st.origin);
    setFeedbackPort({
      send: async (body) => {
        const r = await transport.request('POST', FEEDBACK_PATH, undefined, body);
        return { status: r.status, body: r.json };
      },
      // NO `sign`, NO `devicePub`. See this file's header: a solo Mac has no device key, the
      // handler accepts that, and the record says `signed: false` rather than pretending.
      appVersion: CLIENT_V,
      spaceKind: 'solo',
    });
    return 'bound';
  } catch (e) {
    // A sender that cannot be bound is a disabled button with a sentence on screen — never a
    // thrown promise on a screen-open path. `copy.js#noRelay` is the honest rendering of this.
    console.warn('[feedback] the solo sender could not be bound:', e);
    return 'failed';
  }
}

/**
 * ██ THE DOOR. ██ The one `await import()` in this subsystem, and the only dynamic import in the
 * whole product outside `main.js -> family/mount.js`.
 *
 * `anonymous: true` is what makes it affordable: `buildRequest` then skips `signRequest` and the
 * `cfg.subtle` check, so nothing under `src/js/crypto/` is reachable from here and the module
 * graph behind this line is `platform/net.js` plus `core/b64.js`.
 *
 * @param {(cmd:string, args?:object)=>Promise<any>} invoke
 * @param {string} origin
 * @returns {Promise<{request:Function, origin:string}>}
 */
async function anonymousBridge(invoke, origin) {
  const net = await import('../platform/net.js');
  return net.createBridgeTransport({
    origin,
    anonymous: true,
    clientVersion: CLIENT_V,
    invoke,
  });
}

/**
 * The path the solo binder posts to. Spelled as a literal HERE and not imported from `port.js`,
 * because `tests/attack/privacy-e5-endpoint.test.js` enumerates the product's addressable path
 * set by reading source files for string literals — a constant reached by identifier is a path
 * that enumeration cannot see, which is the exact defect that row was written for.
 */
const FEEDBACK_PATH = '/api/v1/feedback';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4. The operator's reader
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {{ devicePub:string, sign:(b:Uint8Array)=>Promise<Uint8Array> }} AdminCredential
 *   `devicePub` is the raw uncompressed P-256 point, base64url — byte-identical to
 *   `Device.sigPubRaw`, which is a disclosure `docs/v2/server-metadata.md` §7 must carry.
 *   `sign` is the injected ECDSA operation; the private key is `extractable: false`, so this is
 *   the only shape it can take.
 */

/**
 * Build the operator's reader against the configured origin.
 *
 * `null` — never a throw — when this Mac is not a shell, has no origin pinned, or holds no
 * credential. The section renders the honest sentence for each of those; none of them is an
 * error, and two of them are the ordinary state of every Mac that is not his.
 *
 * @param {{invoke?:Function, credential?:AdminCredential|null}} [opts]
 * @returns {Promise<null|{origin:string, list:Function, one:Function, remove:Function}>}
 */
export async function openReportsClient(opts) {
  const o = opts || {};
  const call = typeof o.invoke === 'function' ? o.invoke : shellInvoke();
  if (!call) return null;
  const cred = o.credential;
  if (!cred || typeof cred.sign !== 'function' || typeof cred.devicePub !== 'string') return null;
  const st = await probeRelay(call);
  if (!st || !st.originConfigured || !st.origin) return null;

  const transport = await anonymousBridge(call, st.origin);

  return {
    origin: st.origin,
    /** Every report the relay still holds, newest first, WITHOUT the images. */
    list: () => dispatch(transport, cred, 'GET', '/api/v1/feedback'),
    /** One report's redacted image, asked for only when a person expanded that report. */
    one: (id) => dispatch(transport, cred, 'GET', `/api/v1/feedback/${assertId(id)}`),
    /** The manual half of retention; the 90-day sweep is the relay's. */
    remove: (id) => dispatch(transport, cred, 'POST', `/api/v1/feedback/${assertId(id)}/delete`),
  };
}

/** @param {string} id @returns {string} @throws {TypeError} */
function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new TypeError('relay: a report id is base64url-shaped and at most 64 characters');
  }
  return id;
}

/**
 * ██ EVERY REQUEST THE REPORTS VIEW MAKES GOES THROUGH HERE. ██
 *
 * One dispatcher, so the answer to "from how many places can this product reach the relay" is a
 * number a reader can count rather than a grep that has to be trusted. The three verbs above are
 * closures over it; `admin.js` calls them and holds no transport of its own.
 *
 * None of the three carries a body — the delete is a POST with zero bytes, which is why the body
 * hash below is over an empty `Uint8Array` in every case and cannot drift from what
 * `buildRequest` actually encodes.
 *
 * @returns {Promise<{status:number, body:any}>}
 */
async function dispatch(transport, cred, method, path) {
  const auth = await adminAuthorization(cred, method, path);
  const r = await transport.request(method, path, undefined, undefined, { Authorization: auth });
  return { status: r.status, body: r.json };
}

/**
 * `LZPADMIN ts=…, nonce=…, sig=…`.
 *
 * The header NAME is `Authorization`, reusing the one the shell's four-name allowlist already
 * passes, so the reader needs no shell change. The SCHEME is not `LZP1`, so
 * `auth.js#parseAuthorization` refuses to read one as the other.
 *
 * The signed string mirrors `net.js#signedString` under a different prefix, with ONE field
 * removed: **there is no body hash, because these three routes carry no body at all.**
 * `handlers/reports.js#requireOperator` step 3 refuses a non-empty `rawBody` outright, which is
 * what makes the omission safe rather than a hole — a field that cannot be present cannot be
 * unsigned. The delete names its subject in the PATH, which is inside the signature.
 *
 * Mirroring rather than inventing means the replay window and the `Nonce` table are the ones
 * that already exist.
 *
 * ⚠ An anonymous transport emits NO `Authorization` of its own (`buildRequest`: `if (auth !==
 * null)`), which is why this header can be passed as an extra one at all — `buildRequest` refuses
 * an extra header that would overwrite one it sets.
 *
 * @param {AdminCredential} cred
 * @returns {Promise<string>}
 */
async function adminAuthorization(cred, method, path) {
  const nonce = b64u(globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
  const ts = String(Date.now());
  const str = adminSignedString({ method, path, sortedQuery: '', ts, nonce });
  const sig = await cred.sign(TE.encode(str));
  if (!(sig instanceof Uint8Array)) {
    throw new TypeError('relay: the sign port must return a Uint8Array (P1363 r‖s, 64 bytes)');
  }
  return `${ADMIN_SCHEME} ts=${ts}, nonce=${nonce}, sig=${b64u(sig)}`;
}

/**
 * The signed string, exported so `server/core/handlers/reports.js#adminSignedString` and this
 * builder can be run against each other in one test rather than agreeing by inspection —
 * `handlers/feedback.js#signedBytesOf` and `report.js#signedBytes` learned that the hard way, and
 * the failure mode is total: every real request gets a 401 and nothing says why.
 *
 * @param {{method:string, path:string, sortedQuery:string, ts:string, nonce:string}} p
 * @returns {string}
 */
export function adminSignedString(p) {
  return ADMIN_PREFIX + p.method.toUpperCase() + '\n' + p.path + '?' + (p.sortedQuery || '')
    + '\n' + p.ts + '\n' + p.nonce;
}
