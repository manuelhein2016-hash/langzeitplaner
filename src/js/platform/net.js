// src/js/platform/net.js — THE ONLY `fetch` IN THE PRODUCT.  LZP-501 / LZP-1002 · story 21.5.
// ADR 003 §1, §2, §4, §7 gate 1 · ADR 005 §5 rule 4.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE IS
// ─────────────────────────────────────────────────────────────────────────────
//
// Story 21.5 (superseding 13.4): "in solo mode the app makes zero network requests; with a
// Familienkreis it talks to exactly one sync endpoint and nothing else." This module is the
// *and nothing else* half. It is the single place in `src/js/` where a request can be made, it
// can address exactly one origin, and every other module reaches the network by being handed a
// `Transport` — never by calling anything itself.
//
// The rule is mechanically enforced, not remembered: `tests/tier1/network-scope.test.js` greps
// every `.js` file under `src/js/` for `fetch(`, `XMLHttpRequest`, `WebSocket`, `EventSource`
// and `navigator.sendBeacon`, with comments and string literals blanked, and fails on any hit
// outside this file. That gate is ADR 003 §7's gate 1, which was recorded as **OWED** on
// 2026-08-27 (finding **F-9**): the property was true only because nothing called `fetch` at
// all, and `tests/helpers/purity.js`'s `PURE_DIRS` never scanned `src/js/platform/` — which is
// exactly how `src/js/platform/updater.js` arrived unscanned. It is owed no longer.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FOUR GATES, AND WHICH ONE THIS FILE IS
// ─────────────────────────────────────────────────────────────────────────────
//
//   1. ONE CALL SITE      — this file. Enforced by the grep gate above.
//   2. NEVER LOADED       — nothing in the boot graph imports this module. It is reached only
//                           through a dynamic `await import()` at the family/pairing opt-in
//                           moment, so in solo mode it is never even evaluated. Enforced by
//                           `tests/tier1/network-scope.test.js`'s import-graph assertion, which
//                           walks `boot.js`, `firstrun.js` and `main.js`.
//   3. THE SHELL ENFORCES — `shell-macos/main.swift`'s navigation gate. Survives a JS bug, which
//                           no test-only assertion does.
//   4. CSP                — `default-src 'self'`. See the CSP note below: it does not change.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE CSP, AND WHY NOTHING IN IT CHANGES — READ THIS BEFORE "JUST ADDING THE HOST"
// ─────────────────────────────────────────────────────────────────────────────
//
// `index.html` ships `default-src 'self'; … connect-src 'self'`, mirrored in
// `src-tauri/tauri.conf.json` with `ipc:` and `http://ipc.localhost` for Tauri's own bridge.
// ADR 003 §7 gate 4 sketches `connect-src 'self' ipc: http://ipc.localhost https://<sync-host>`.
// Implementing that sketch literally is wrong today, for three independent reasons:
//
//   1. **A `<meta>` CSP cannot be conditional.** It is one static string in one shipped file.
//      Naming the sync host there relaxes the policy for every SOLO install — for a request solo
//      mode must never make. Story 21.5 says solo makes zero requests; a solo document whose
//      policy *permits* one is a weaker promise than the one we make in the Datenschutz copy,
//      and `tests/tier2/shell-bridge.dom.js`'s "an outbound fetch is actually blocked" assertion
//      would be passing for a smaller reason than it does now.
//   2. **There is no host to allowlist.** ADR 003 §1 says `https://<vercel-app>.vercel.app`. No
//      such app exists; hard-coding a placeholder into the shipped CSP is a lie in a security
//      header, and a CSP that is edited every time a deployment moves is a CSP nobody reads.
//   3. **The request does not need to leave the WebView, and E1 already reached this answer.**
//      `src/js/platform/updater.js`'s header works the 21.5 ↔ 22.3 tension out in full and lands
//      on: the *native shell process* performs the request; the page does not. The same answer
//      holds here, and for sync it is stronger, because the objection that usually defeats it
//      does not apply — the ECDSA signing key is `extractable: false` and lives in the WebView's
//      IndexedDB (ADR 002 §2.2), so the *signature* must be computed in the page no matter who
//      opens the socket. Signing and transporting are separable, and this file separates them:
//      `signRequest()` produces the exact bytes; `createFetchTransport` and `createBridgeTransport`
//      are two ways of moving them.
//
// **So the CSP diff for family mode is empty**, and that is the finding, not an omission. What
// changes instead is one bridge command in the shell (`sync_request`, §6 below), gated on the
// shell's own `sync_enabled` pref — gate 3, which survives a JS bug, doing the work gate 4 was
// being asked to do. `createFetchTransport` still exists and is still the only `fetch`: it is
// what `node dev-server.mjs` + `node server/dev-server.mjs` use, where the relay is mounted on
// the app's OWN origin and `connect-src 'self'` therefore already covers it.
//
// If the PO ever decides the WebView should open the socket directly, the change is exactly two
// lines — `connect-src 'self' https://<host>` in `index.html` and in `src-tauri/tauri.conf.json`
// — and it costs the "solo mode's policy names no remote" property above. That is a PO call and
// it is written here so it is priced rather than discovered.
//
// ─────────────────────────────────────────────────────────────────────────────
// PURITY
// ─────────────────────────────────────────────────────────────────────────────
//
// This file lives under `platform/` because it does I/O; `src/js/sync/` stays DOM-free and
// I/O-free (ADR 005 §2) and receives a `Transport` port. It imports NOTHING from
// `src/js/crypto/`: the private-key operation is an injected `sign(bytes)` port, one line to
// bind (`(b) => signBytes(identity.devSig.privateKey, b)` — `src/js/crypto/identity.js`). That
// is not fastidiousness. `tests/tier1/crypto-identity.test.js`'s PRINCIPLE 7 gate walks the
// import graph — dynamic `import()` included — from `boot.js`/`firstrun.js`/`main.js` and fails
// if anything under `src/js/crypto/` is reachable. The day gate 2's `await import()` is wired
// into `main.js`, a static crypto import here would redden that gate. Keeping the port injected
// means this module can be reached from the boot graph without dragging keygen in behind it.

import { b64u } from '../core/b64.js';
import { isDeviceShort } from '../core/ids.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Protocol constants (ADR 003 §1, §4 · docs/v2/contracts/sync.contract.js §0)
// ─────────────────────────────────────────────────────────────────────────────

/** v2.0 GA ships protocol 1. Mirrors `sync.contract.js`'s `PROTOCOL`. */
export const PROTOCOL = 1;

export const HDR = Object.freeze({
  protocol: 'X-LZP-Protocol',
  client: 'X-LZP-Client',
  minProtocol: 'X-LZP-Min-Protocol',
  auth: 'Authorization',
});

/** ADR 003 §2 — `signedString` is NEVER empty, because it always begins with this. */
export const SIGNED_PREFIX = 'lzp/v2\n';

/** The scheme token of the one Authorization form this product speaks. */
export const AUTH_SCHEME = 'LZP1';

/** 16 bytes of client randomness, `nonce=<b64u16>`. Fixed width (ADR 003 §2). */
export const NONCE_BYTES = 16;

/**
 * EVERY path this product may address. Not a convention — `assertReachable` refuses anything
 * else, so a bug that builds a path from user data cannot reach a second endpoint.
 */
export const PATH_PREFIX = '/api/v1/';

/**
 * The shape a path segment may have. Deliberately narrow: base64url ids (`fsp_…`), the fixed
 * route words, and nothing that can carry a scheme, a host, a `..`, a query or a fragment.
 */
export const PATH_RE = /^\/api\/v1(?:\/(?!\.)[A-Za-z0-9._~-]+)+$/;

/**
 * A request that has not answered in this long is a failure, not a hang. ADR 003 §8.2's backoff
 * counts a timeout as a transport error; without a timeout the loop would simply stop.
 */
export const DEFAULT_TIMEOUT_MS = 15000;

/** ADR 003 §6.1 — the server refuses a larger body, so the client refuses to build one. */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/**
 * Everything that can go wrong, named. Never branch on a message.
 * @typedef {'config'|'blocked'|'timeout'|'offline'|'transport'|'too_large'|'bad_response'} NetErrorKind
 */
export class NetError extends Error {
  /** @param {NetErrorKind} kind @param {string} message @param {any} [detail] */
  constructor(kind, message, detail) {
    super(message);
    this.name = 'NetError';
    this.kind = kind;
    this.detail = detail ?? null;
  }
}

const TE = new TextEncoder();

// ─────────────────────────────────────────────────────────────────────────────
// 2. The one allowlisted origin
//
// "Exactly one sync endpoint and nothing else" is enforced HERE rather than by discipline at the
// call sites. An origin is normalised once, at construction; every request is then rebuilt from
// (origin, path, canonical query) and RE-PARSED, and the re-parse must agree with the origin and
// the path it was built from. A `path` carrying `https://evil/`, `//evil/`, `../../`, a `?` or a
// `#` therefore cannot survive, whatever produced it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is this host THIS MACHINE? The only place `http://` survives (see `normalizeOrigin`).
 *
 * Written over the hostname `URL` produced, never over the raw string: `URL` has already
 * lower-cased it, resolved `http://127.1` to `127.0.0.1`, punycoded any unicode and put an IPv6
 * literal back in brackets — so an attacker cannot dress a remote host as a loopback one by
 * spelling it differently. `*.localhost` is included because RFC 6761 §6.3 reserves the whole
 * name for the local host and both shells' dev serves use it.
 *
 * `127.0.0.0/8` and not `127.0.0.1` alone: the whole /8 is loopback, `node dev-server.mjs` may
 * bind anywhere in it, and a rule that named one address would be worked around with the next.
 *
 * @param {string} hostname a `URL.hostname`, not a raw user string
 * @returns {boolean}
 */
export function isLoopbackHost(hostname) {
  const h = String(hostname || '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '[::1]') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

/**
 * FINDING P-7 · the one sentence a person is shown when they type `http://` at a real host.
 *
 * It lives here rather than in `i18n.js` for the reason `crypto/probe.js`'s `unavailableMessage`
 * does: the module that owns the RULE owns the sentence that explains it, so the two cannot
 * drift, and the UI picks the language. It does not say "invalid": the address is perfectly
 * valid and the user has not made a typo they can see. It says what is lost, because that is the
 * only thing they can act on.
 */
export function insecureOriginMessage() {
  return Object.freeze({
    de:
      'Diese Adresse beginnt mit „http://" statt „https://". Deine Einträge blieben zwar '
      + 'verschlüsselt, aber alles drumherum — welcher Mac gerade schreibt, wann, und wie oft — '
      + 'wäre in jedem fremden WLAN mitlesbar. Nimm dieselbe Adresse mit „https://".',
    en:
      'This address starts with "http://" instead of "https://". Your entries would stay '
      + 'encrypted, but everything around them — which Mac is writing, when, and how often — '
      + 'would be readable to anyone on the same wifi. Use the same address with "https://".',
  });
}

/**
 * Normalise an origin to `scheme://host[:port]`, or throw. `URL.origin` is not used: it is
 * `"null"` for non-special schemes, and `app://localhost` — the scheme the shipping shell serves
 * the page from — is exactly such a scheme.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY `http://` IS REFUSED TO ANYTHING BUT THIS MACHINE — FINDING P-7, CLOSED HERE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * There is no default relay (ADR 003 §1 names a host that does not exist yet), so this origin is
 * a FREE-TEXT FIELD in the settings sheet, saved on every keystroke, and it alone decides where
 * the whole personal board is sent. Until now `http:` was accepted for every host, because
 * `node dev-server.mjs` needs it — and nothing above this function narrowed it back down.
 *
 * The content would survive: every op is sealed before it reaches a transport (ADR 002 §5), so
 * `http://` costs no plaintext. What it costs is everything `server-metadata.md` §2 and §5
 * enumerate — the personal space id, the deviceShort, the read cursor, the op and byte counts,
 * the timing of every single edit — plus the `Authorization` header and its nonce, in the clear,
 * to anyone on the same café wifi. `server-metadata.md` §8 states "TLS in transit" as a FACT
 * about this product, and the Datenschutz copy inherits it; for one mistyped scheme it was false.
 *
 * `platform/updater.js`'s `checkUrl` — a far smaller exposure, one signed manifest — has refused
 * anything but `https:` by name since E1. This is the same rule at the larger exposure, with the
 * one carve-out the updater does not need: a loopback host is this Mac talking to itself, there
 * is no wire to tap, and `node dev-server.mjs` + `node server/dev-server.mjs` live there.
 *
 * `app:` is untouched — it is the shell's own scheme for the page itself and never leaves the
 * process. The *user-facing* half of this rule is `insecureOriginMessage()`, shown by
 * `family/familysettings.js` before the field is ever used; this is the half that holds even if
 * that sheet is bypassed, which is why both exist.
 *
 * @param {unknown} origin @returns {string}
 */
export function normalizeOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0) {
    throw new NetError('config', 'net: an origin is required — there is exactly one, and it is explicit');
  }
  let u;
  try {
    u = new URL(origin);
  } catch {
    throw new NetError('config', `net: ${JSON.stringify(origin)} is not a URL`);
  }
  if (u.pathname !== '/' && u.pathname !== '') {
    throw new NetError('config', 'net: the origin carries a path; it must be scheme://host[:port] only');
  }
  if (u.search || u.hash || u.username || u.password) {
    throw new NetError('config', 'net: the origin carries a query, fragment or credentials');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:' && u.protocol !== 'app:') {
    throw new NetError('config', `net: refusing the scheme ${u.protocol}`);
  }
  if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) {
    throw new NetError('config',
      `net: refusing http:// to ${u.host} — the board's metadata would cross the wire in the clear `
      + '(server-metadata.md §2/§5/§8, finding P-7). Use https://, or a loopback host for a dev serve.');
  }
  return `${u.protocol}//${u.host}`;
}

/**
 * The URL a request is allowed to have, or a throw. This is the "nothing else may be reachable"
 * check and it is deliberately paranoid: it builds the URL, parses it back, and requires the
 * parse to agree on origin, path and query with what went in.
 *
 * @param {string} origin already through `normalizeOrigin`
 * @param {string} path   must match `PATH_RE`
 * @param {string} sortedQuery `canonicalQuery(...)` output — "" for none
 * @returns {string} the exact URL to request
 */
export function assertReachable(origin, path, sortedQuery) {
  if (typeof path !== 'string' || !PATH_RE.test(path)) {
    throw new NetError('blocked', `net: ${JSON.stringify(path)} is not a ${PATH_PREFIX}… path`);
  }
  if (path.includes('..')) throw new NetError('blocked', 'net: a path may not contain ".."');
  const url = origin + path + (sortedQuery ? '?' + sortedQuery : '');
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new NetError('blocked', `net: ${JSON.stringify(url)} did not parse`);
  }
  const back = `${u.protocol}//${u.host}`;
  if (back !== origin) {
    throw new NetError('blocked', `net: ${JSON.stringify(url)} resolves to ${back}, not the one allowed origin`);
  }
  if (u.pathname !== path) {
    throw new NetError('blocked', `net: the path normalised to ${u.pathname}, which is not what was signed`);
  }
  const wantSearch = sortedQuery ? '?' + sortedQuery : '';
  if (u.search !== wantSearch) {
    throw new NetError('blocked', 'net: the query normalised to something other than what was signed');
  }
  if (u.hash !== '') throw new NetError('blocked', 'net: a fragment may not be sent');
  return url;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Request authentication (ADR 003 §2)
//
// These three functions must produce, byte for byte, what `server/core/auth.js` recomputes.
// They are written out here rather than imported because ADR 005 §2's dependency direction
// forbids the client reaching into `server/`; `tests/tier1/platform-net.test.js` asserts the two
// agree by running the server's own verifier over this client's header.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `sortedQuery`. `encodeURIComponent` per component, sorted over the ENCODED forms in code-unit
 * order, key then value; a repeated key is an array and its occurrences sort by value. Identical
 * to `server/core/auth.js`'s `canonicalQuery`, which documents why each half is the way it is.
 * @param {Object<string, string|number|string[]>} [query] @returns {string}
 */
export function canonicalQuery(query) {
  if (!query || typeof query !== 'object') return '';
  const pairs = [];
  for (const k of Object.keys(query)) {
    const v = query[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const one of v) pairs.push([encodeURIComponent(k), encodeURIComponent(String(one))]);
    else pairs.push([encodeURIComponent(k), encodeURIComponent(String(v))]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map((p) => `${p[0]}=${p[1]}`).join('&');
}

/**
 * ADR 003 §2, assembled from parts that are already canonical. The `"?"` is unconditional — it
 * is a separator, not a query marker.
 * @param {{method:string, path:string, sortedQuery:string, bodyHashB64u:string,
 *          ts:string, nonce:string}} p
 * @returns {string}
 */
export function signedString(p) {
  return SIGNED_PREFIX + p.method.toUpperCase() + '\n' + p.path + '?' + p.sortedQuery + '\n' +
         p.bodyHashB64u + '\n' + p.ts + '\n' + p.nonce;
}

/**
 * Sign one request. The ECDSA operation is the injected `sign` port; everything the port is
 * handed is built here, so the bytes that are signed and the bytes that are sent cannot drift.
 *
 * `rawBody` is hashed, never a parsed object — the server verifies over `req.rawBody` for the
 * same reason (`server/core/auth.js`'s `readSignedBody`), and a client that signed a re-encoding
 * of its own body would be the same parse-twice defect seen from the other end.
 *
 * @param {{method:string, path:string, sortedQuery:string, rawBody:Uint8Array,
 *          deviceShort:string, ts:number, nonce:Uint8Array,
 *          sign:(b:Uint8Array)=>Promise<Uint8Array>, subtle:SubtleCrypto}} p
 * @returns {Promise<string>} the `Authorization` header value
 */
export async function signRequest(p) {
  if (!isDeviceShort(p.deviceShort)) {
    throw new NetError('config', 'net: signRequest needs the durable deviceShort (ADR 002 §5.2.0)');
  }
  if (typeof p.sign !== 'function') {
    throw new NetError('config', 'net: signRequest needs a sign(bytes) port — bind it to identity.signBytes');
  }
  const nonceB64 = b64u(p.nonce);
  const ts = String(Math.floor(p.ts));
  const hash = new Uint8Array(await p.subtle.digest('SHA-256', p.rawBody));
  const str = signedString({
    method: p.method,
    path: p.path,
    sortedQuery: p.sortedQuery,
    bodyHashB64u: b64u(hash),
    ts,
    nonce: nonceB64,
  });
  const sig = await p.sign(TE.encode(str));
  if (!(sig instanceof Uint8Array)) {
    throw new NetError('config', 'net: the sign port must return a Uint8Array (P1363 r‖s, 64 bytes)');
  }
  return `${AUTH_SCHEME} device=${p.deviceShort}, ts=${ts}, nonce=${nonceB64}, sig=${b64u(sig)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The shared half of both transports
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} TransportDeps
 * @property {string} origin                the ONE allowlisted origin
 * @property {string} deviceShort           the durable, key-derived short (ADR 002 §5.2.0)
 * @property {(b:Uint8Array) => Promise<Uint8Array>} sign
 *           bind to `identity.signBytes(id.devSig.privateKey, b)` — the private key is
 *           `extractable: false`, so this is the only shape the signature can take
 * @property {string} clientVersion         `X-LZP-Client`, e.g. "2.0.3"
 * @property {() => number} [now]
 * @property {(n:number) => Uint8Array} [random]
 * @property {SubtleCrypto} [subtle]
 * @property {number} [timeoutMs]
 * @property {(ms:number, fn:Function) => any} [schedule]
 * @property {(h:any) => void} [unschedule]
 */

const REQUIRED = ['origin', 'deviceShort', 'sign', 'clientVersion'];

/**
 * The two fields an ANONYMOUS transport does not have, and cannot be given.
 *
 * ADR 002 §6.3 steps 4-6 are performed by a Mac that HAS NO IDENTITY YET — it mints its device
 * keys at step 8 — so `GET /pair/:rid` and `POST /pair/answer` must be reachable without an
 * `Authorization` header at all. `server/core/handlers/pair.js`'s `optionalAuth` says the same
 * thing from the other end, and says the sharp half too: *"an absent header is anonymous and a
 * present-but-invalid header is the error `ctx.auth` raised"*. A joiner that signed with the
 * fresh, unregistered identity it happens to hold would therefore get a 401 rather than the
 * anonymous path — which is why this is a MODE and not an omission.
 *
 * It is a separate transport rather than a per-call flag on purpose: an anonymous request must
 * be impossible to make by accident from the transport the sync engine holds, and a boolean
 * argument at one of five call sites is exactly how that accident happens. An anonymous
 * transport has no `sign` port and no `deviceShort`, so it could not sign if it wanted to.
 */
const ANONYMOUS_REQUIRED = ['origin', 'clientVersion'];

function prepare(deps) {
  const anonymous = deps != null && deps.anonymous === true;
  for (const k of (anonymous ? ANONYMOUS_REQUIRED : REQUIRED)) {
    if (deps == null || deps[k] === undefined || deps[k] === null) {
      throw new NetError('config', `net: createTransport needs \`${k}\``);
    }
  }
  const origin = normalizeOrigin(deps.origin);
  if (typeof deps.clientVersion !== 'string' || deps.clientVersion.length === 0) {
    throw new NetError('config', 'net: clientVersion must be a non-empty string');
  }
  if (anonymous && (deps.sign !== undefined || deps.deviceShort !== undefined)) {
    throw new NetError('config',
      'net: an anonymous transport may not be handed `sign` or `deviceShort` — it exists so that '
      + 'signing is impossible, not merely skipped');
  }
  return {
    anonymous,
    origin,
    deviceShort: deps.deviceShort,
    sign: deps.sign,
    clientVersion: deps.clientVersion,
    now: typeof deps.now === 'function' ? deps.now : () => Date.now(),
    random: typeof deps.random === 'function'
      ? deps.random
      : (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
    subtle: deps.subtle || globalThis.crypto?.subtle,
    timeoutMs: Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : DEFAULT_TIMEOUT_MS,
    schedule: typeof deps.schedule === 'function' ? deps.schedule : ((ms, fn) => setTimeout(fn, ms)),
    unschedule: typeof deps.unschedule === 'function' ? deps.unschedule : ((h) => clearTimeout(h)),
  };
}

/**
 * Everything a request is, decided before anything leaves the process: the URL, the exact body
 * bytes, and every header. Exported so the two transports and the tests all read one function.
 * @returns {Promise<{url:string, method:string, path:string, sortedQuery:string,
 *                    rawBody:Uint8Array, headers:Object<string,string>}>}
 */
export async function buildRequest(cfg, method, path, query, body, extraHeaders) {
  const M = String(method || '').toUpperCase();
  if (M !== 'GET' && M !== 'POST') {
    throw new NetError('blocked', `net: ${JSON.stringify(method)} is not a method this protocol uses`);
  }
  const sortedQuery = canonicalQuery(query);
  const url = assertReachable(cfg.origin, path, sortedQuery);

  let rawBody = new Uint8Array(0);
  if (body !== undefined && body !== null) {
    if (M === 'GET') throw new NetError('blocked', 'net: a GET carries no body (ADR 003 §2 hashes zero bytes)');
    rawBody = TE.encode(JSON.stringify(body));
    if (rawBody.length > MAX_REQUEST_BYTES) {
      throw new NetError('too_large', `net: ${rawBody.length} bytes exceeds the ${MAX_REQUEST_BYTES} cap (ADR 003 §6.1)`);
    }
  }
  if (!cfg.anonymous && !cfg.subtle) {
    // The sentence used to end here and it was not true: NOTHING called `probeCrypto()` (finding
    // P-4). It is true now — `family/familysettings.js`'s `assertSuiteAvailable()` runs the probe
    // at „Familienkreis erstellen" and refuses the section's actions with one plain sentence when
    // the suite is not there — so this throw is the belt to that braces rather than the only
    // check, and it names the gate so a reader can go and find it.
    throw new NetError('config',
      'net: no SubtleCrypto — family features are gated on probeCrypto() in family/familysettings.js');
  }

  const auth = cfg.anonymous ? null : await signRequest({
    method: M,
    path,
    sortedQuery,
    rawBody,
    deviceShort: cfg.deviceShort,
    ts: cfg.now(),
    nonce: cfg.random(NONCE_BYTES),
    sign: cfg.sign,
    subtle: cfg.subtle,
  });

  /** No cookies, no sessions, no bearer tokens (ADR 003 §1). These five headers are the whole
   *  request surface, and `extraHeaders` may not overwrite one of them. */
  const headers = {
    [HDR.protocol]: String(PROTOCOL),
    [HDR.client]: cfg.clientVersion,
  };
  // An anonymous transport emits NO `Authorization` at all — not an empty one. `optionalAuth`
  // treats a present-but-invalid header as an error, so a blank string would be a 401.
  if (auth !== null) headers[HDR.auth] = auth;
  if (rawBody.length > 0) headers['Content-Type'] = 'application/json';
  for (const k of Object.keys(extraHeaders || {})) {
    if (Object.keys(headers).some((h) => h.toLowerCase() === k.toLowerCase())) {
      throw new NetError('config', `net: ${k} is set by the transport and may not be overridden`);
    }
    headers[k] = String(extraHeaders[k]);
  }
  return { url, method: M, path, sortedQuery, rawBody, headers };
}

/** Header list → a plain lower-cased object, whatever shape the platform handed us. */
function readHeaders(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.forEach === 'function') {
    h.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
    return out;
  }
  for (const k of Object.keys(h)) out[String(k).toLowerCase()] = String(h[k]);
  return out;
}

/** A response body is JSON or it is nothing. An empty body is `null`, never a throw. */
function parseBody(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new NetError('bad_response', 'net: the response body was not JSON');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. The fetch transport — THE ONE CALL SITE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {TransportDeps & {fetchImpl?:Function}} deps
 * @returns {{request:(method:string, path:string, query?:Object, body?:any,
 *                     headers?:Object) => Promise<{status:number, headers:Object, json:any}>,
 *            origin:string}}
 */
export function createFetchTransport(deps) {
  const cfg = prepare(deps);
  const fetchImpl = deps.fetchImpl || null;

  return {
    origin: cfg.origin,
    async request(method, path, query, body, headers) {
      const req = await buildRequest(cfg, method, path, query, body, headers);

      // Resolved per call, not at module load: a module-load read would freeze whichever
      // `fetch` happened to exist at import time, which in the shell is before the page is
      // fully set up and in a test is the wrong one.
      const f = fetchImpl || globalThis.fetch;
      if (typeof f !== 'function') {
        throw new NetError('config', 'net: this runtime has no fetch');
      }

      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      let timedOut = false;
      const timer = cfg.schedule(cfg.timeoutMs, () => { timedOut = true; if (ac) ac.abort(); });

      let res;
      try {
        // ────────────────────────────────────────────────────────────────────
        // THE ONLY `fetch` IN THE PRODUCT (story 21.5, ADR 003 §7 gate 1).
        //
        // `redirect: 'error'` is load-bearing, not hygiene: a 302 to another host would move
        // the request off the one allowed origin AFTER `assertReachable` had approved it, and a
        // signed request replayed at a destination of the relay's choosing is exactly the thing
        // "nothing else may be reachable" has to prevent. `credentials: 'omit'` because there
        // are no cookies and none may be built (ADR 003 §1).
        // ────────────────────────────────────────────────────────────────────
        res = await f(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.method === 'POST' && req.rawBody.length > 0 ? req.rawBody : undefined,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: ac ? ac.signal : undefined,
        });
      } catch (e) {
        if (timedOut) throw new NetError('timeout', `net: no answer within ${cfg.timeoutMs} ms`, e);
        throw new NetError('transport', `net: the request did not complete (${e && e.name})`, e);
      } finally {
        cfg.unschedule(timer);
      }

      let text;
      try {
        text = await res.text();
      } catch (e) {
        throw new NetError('bad_response', 'net: the response body could not be read', e);
      }
      return { status: res.status, headers: readHeaders(res.headers), json: parseBody(text) };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. The bridge transport — the SHIPPING path, and the reason the CSP does not move
//
// One command, `sync_request`, implemented by `shell-macos/main.swift` and `src-tauri/src/lib.rs`
// exactly as the updater's four are (`platform/updater.js`'s `bridgePort`). The page signs; the
// shell transports. The shell's contract, in full:
//
//   sync_request({ url, method, headers, body })
//       → { status: Int, headers: { …lower-cased… }, body: String, url: String }
//                                                                      on any HTTP answer
//       → { error: "offline" | "timeout" | "blocked" | "transport" }    otherwise
//
//   · `url` (in) has already been through `assertReachable`; the shell MUST check it again
//     against its own pinned origin and MUST refuse unless `set_shell_pref: "sync_enabled"` is
//     set — that is ADR 003 §7 gate 3, and it is the gate that survives a JS bug.
//   · the shell follows NO redirects and sends no cookies.
//   · **`url` (out) is the URL the returned bytes actually came from** — see below.
//   · the shell never inspects `body`; it is a padded, end-to-end-encrypted envelope batch.
//
// ─────────────────────────────────────────────────────────────────────────────
// FINDING P-5, THE SHIPPING HALF — WHY THE REPLY CARRIES A URL
// ─────────────────────────────────────────────────────────────────────────────
//
// On the `fetch` path "no redirects" is a fact the PLATFORM enforces: `redirect: 'error'` makes
// a 302 a rejected promise, so the signed request is never replayed at a destination the relay
// chose. On the bridge path it was a SENTENCE IN A COMMENT — the reply carried a status and a
// body and not the URL they came from, so a shell that followed a redirect (`URLSession` follows
// them by default; refusing takes a delegate) would be undetectable from JS, and the page would
// treat another host's answer as the relay's.
//
// So the reply carries the FINAL url and this factory refuses one that is not the url it asked
// for. It is four lines and it turns an unverifiable promise into a checked one. `redirected:
// true` is refused the same way, for a shell that reports the fact without the address.
//
// **`reply.url` IS REQUIRED, and the deadline that made it optional has passed.** It was
// optional for exactly one reason — no shell implemented `sync_request`, so no build in the
// world could send the field, and requiring it would have refused every reply in
// `tests/tier1/platform-net.test.js` rather than any real one. That is no longer true. Both
// shells implement the command (`shell-macos/main.swift`'s `SyncRequestDelegate`, which puts
// `http.url?.absoluteString` on every answer; `src-tauri/src/lib.rs`'s mirror of it), both send
// the field on every reply, and a reply that OMITS it is now refused the same way a reply that
// names a stranger is. An omission silently disabling the check is the shape of defence this
// codebase distrusts, and it no longer exists here.
//
// **LANDED, and demonstrated rather than assumed:** `docs/v2/SHELL-VERIFICATION.md` records the
// round trip through the shipped `.app` — `chooseTransport()` returning `'bridge'` inside
// WKWebView, a real sealed op pushed and pulled through `invoke('sync_request')`, and zero
// `fetch` calls on the wire. The two shells are owned elsewhere; the command is no longer a
// hand-off.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {TransportDeps & {invoke:(cmd:string, args?:object) => Promise<any>}} deps
 * @returns {{request:Function, origin:string}}
 */
export function createBridgeTransport(deps) {
  const cfg = prepare(deps);
  if (typeof deps.invoke !== 'function') {
    throw new NetError('config', 'net: createBridgeTransport needs the shell `invoke`');
  }
  const TD = new TextDecoder();

  return {
    origin: cfg.origin,
    async request(method, path, query, body, headers) {
      const req = await buildRequest(cfg, method, path, query, body, headers);
      let reply;
      try {
        reply = await deps.invoke('sync_request', {
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: req.rawBody.length > 0 ? TD.decode(req.rawBody) : '',
        });
      } catch (e) {
        throw new NetError('transport', 'net: the shell refused the request', e);
      }
      if (reply === null || typeof reply !== 'object') {
        throw new NetError('bad_response', 'net: the shell answered nothing');
      }
      if (typeof reply.error === 'string') {
        const kind = ['offline', 'timeout', 'blocked', 'transport'].includes(reply.error)
          ? /** @type {NetErrorKind} */ (reply.error)
          : 'transport';
        // THE REASON IS CARRIED, and it used to be dropped. The shell distinguishes eight local
        // refusals by name (`sync_refusal` in `src-tauri/src/lib.rs`, and the same vocabulary in
        // `main.swift`) and puts the one that fired in `reply.reason`. Collapsing all eight to the
        // single word „blocked" cost a real diagnosis: „Das hat nicht geklappt: net: the shell
        // reported blocked" is the same sentence for a stale origin, a disabled switch, a bad
        // method and a header that is not on the allowlist — four different things to do about it.
        //
        // It is not a disclosure. Every one of these is a decision this Mac made about its own
        // configuration, before any socket existed; none of them names anything the page did not
        // already hand the shell.
        const why = typeof reply.reason === 'string' && reply.reason ? ` (${reply.reason})` : '';
        throw new NetError(kind, `net: the shell reported ${reply.error}${why}`);
      }
      if (!Number.isInteger(reply.status)) {
        throw new NetError('bad_response', 'net: the shell answered without a status');
      }
      // FINDING P-5 — where did these bytes come from? See §6's header. A reply that names a
      // different URL, or admits to a redirect without naming one, is not an answer from the one
      // allowed origin and is refused BEFORE the body is parsed.
      if (reply.redirected === true) {
        throw new NetError('blocked', 'net: the shell followed a redirect — the signed request was replayed elsewhere');
      }
      // REQUIRED, not merely checked-if-present. A shell that omits the field cannot be told
      // apart from one that followed a redirect and did not say so, so the omission is refused.
      if (typeof reply.url !== 'string' || reply.url === '') {
        throw new NetError('blocked',
          'net: the shell answered without naming the URL the bytes came from');
      }
      if (reply.url !== req.url) {
        throw new NetError('blocked',
          `net: the answer came from ${JSON.stringify(String(reply.url))}, not from ${JSON.stringify(req.url)}`);
      }
      return { status: reply.status, headers: readHeaders(reply.headers), json: parseBody(reply.body) };
    },
  };
}

/**
 * Pick the transport this runtime can offer, and SAY WHICH — the same discipline
 * `chooseKeyStore` uses, for the same reason: `'fetch'` means the WebView opened the socket, and
 * a caller that reads `'fetch'` in the shipped shell has found a bug in gate 3.
 * @param {TransportDeps & {invoke?:Function, fetchImpl?:Function}} deps
 * @returns {{kind:'bridge'|'fetch', transport:{request:Function, origin:string}}}
 */
export function chooseTransport(deps) {
  if (typeof deps?.invoke === 'function') {
    return { kind: 'bridge', transport: createBridgeTransport(deps) };
  }
  return { kind: 'fetch', transport: createFetchTransport(deps) };
}
