// server/core/version.js — protocol versioning and the N−1 rule.  LZP-206.
// ADR 003 §4 · addendum §3 and §9 (fixed constraint) · story 22.7 · LZP-104.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE SENTENCE THIS FILE EXISTS TO MAKE UNBREAKABLE
// ─────────────────────────────────────────────────────────────────────────────
//
//   addendum §9: "The server always supports the current and the previous client protocol
//   version."
//
// That is a fixed constraint, not a guideline, and it exists for a structural reason: the server
// redeploys on every push to main (RELEASE §7.1) while desktops update on their own schedule
// (F22, 22.5). Between a server deploy and the last Mac in the family running the updater there
// is a window — sometimes days — in which the newest server must still speak to the previous
// client. A server that only ever speaks its own newest protocol turns every protocol bump into
// a family-wide outage that the family cannot fix, because the thing that would fix it is the
// updater that is not due to run until tomorrow.
//
// The obvious way to honour that constraint is a comment saying "remember to keep PROTO_MIN one
// behind PROTO_MAX". Comments do not hold. So:
//
//   **PROTO_MIN IS DERIVED, NOT DECLARED.** There is no assignment anywhere in this file that
//   can set the supported window narrower than {PROTO_MAX − 1, PROTO_MAX}. `PROTO_FLOOR` exists
//   so a future release can serve a *wider* window (say 1..3 during a long migration), and it is
//   folded in with `Math.min`, so raising it can never narrow the window past N−1. The rule is
//   unexpressible in the wrong direction — which is the only kind of rule that survives.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE THREE INDEPENDENT VERSION NUMBERS (ADR 003 §4) — DO NOT CONFLATE THEM
// ─────────────────────────────────────────────────────────────────────────────
//
//   X-LZP-Protocol  an integer   the HTTP surface        ← this file
//   Envelope.v      an integer   the ciphertext format   ← ADR 002 §5, src/js/crypto/envelope.js
//   Op.v            an integer   the op format           ← ADR 001 §2, src/js/core/ops.js
//   X-LZP-Client    semver       the application build   ← this file's SECOND gate (22.7)
//
// They will usually move together and must be allowed not to.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FIELD-NAME TRAP — READ BEFORE TOUCHING THE 426 BODY
// ─────────────────────────────────────────────────────────────────────────────
//
// The minimum *client* version is carried on two entirely different transports, and they spell
// it differently ON PURPOSE:
//
//   · the static update manifest (latest.json, .github/scripts/make-update-manifest.mjs)
//     spells it `minimum_version` — because that is what `src/js/platform/updater.js`
//     `parseManifest()` reads, and nothing else;
//   · the server's 426 body (ADR 003 §4, docs/v2/contracts/sync.contract.js §5)
//     spells it `minClientVersion` — because that is what the sync client's `checkProtocol()`
//     reads, and nothing else.
//
// During E1 integration the manifest generator was found writing `minClientVersion`, which no
// client reads, so 22.7's gate was silently dead (docs/v2/E1-VERIFICATION.md § "Three
// integration defects", RELEASE §9). That defect is FIXED. Both spellings are exported below as
// named constants and `tests/server/version.test.js` asserts each one lands on the correct side,
// so re-introducing the swap fails a test rather than shipping a dead gate a second time.
//
// PURITY (ADR 003 §9, ADR 005 §2). No clock, no randomness, no I/O, no globals, no imports
// outside `server/core/`. The wall clock reaches a handler only as `ctx.now()`.

import { fail } from './errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Header names
// ─────────────────────────────────────────────────────────────────────────────

/** Request headers, lower-cased: `ServerReq.headers` is normalised to lower case by every host. */
export const PROTOCOL_HEADER = 'x-lzp-protocol';
export const CLIENT_HEADER = 'x-lzp-client';

/** Response headers, in their canonical casing. Every response carries both (ADR 003 §1, §4). */
export const RESPONSE_PROTOCOL_HEADER = 'X-LZP-Protocol';
export const RESPONSE_MIN_PROTOCOL_HEADER = 'X-LZP-Min-Protocol';

/**
 * The key the minimum client version travels under, per transport. See the trap note above.
 * These are exported rather than inlined so that a grep for either spelling lands here first.
 */
export const WIRE_MIN_CLIENT_KEY = 'minClientVersion';   // the 426 body — sync.contract.js §5
export const MANIFEST_MIN_VERSION_KEY = 'minimum_version'; // latest.json — updater.js parseManifest

// ─────────────────────────────────────────────────────────────────────────────
// 2. The numbers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The newest protocol this build speaks. **v2.0 GA ships protocol 1** (ADR 003 §4).
 * A breaking change to the HTTP surface bumps this by one, in the same commit that raises
 * `LZP_MIN_CLIENT_VERSION` if — and only if — old clients genuinely cannot continue.
 */
export const PROTO_MAX = 1;

/**
 * The oldest protocol this build is WILLING to serve. It may only ever WIDEN the window:
 * `PROTO_MIN` folds it with `Math.min(PROTO_FLOOR, PROTO_MAX - 1)`, so setting this equal to
 * `PROTO_MAX` in an attempt to drop the previous version has no effect. Dropping N−1 requires
 * bumping `PROTO_MAX` again, which is exactly the discipline addendum §9 asks for.
 */
export const PROTO_FLOOR = 1;

/**
 * DERIVED. Never assign to this directly and never replace the expression with a literal —
 * `tests/server/version.test.js` asserts the derivation, not the value.
 */
export const PROTO_MIN = Math.max(1, Math.min(PROTO_FLOOR, PROTO_MAX - 1));

/** Every protocol integer this build accepts, ascending. */
export const PROTO_SUPPORTED = Object.freeze(
  Array.from({ length: PROTO_MAX - PROTO_MIN + 1 }, (_, i) => PROTO_MIN + i),
);

/**
 * The minimum *client build* the server insists on (22.7 / LZP-104). `'0.0.0'` means **no gate**,
 * which is the correct default and the value that must ship unless a protocol change genuinely
 * strands old builds.
 *
 * This is the BACKSTOP, not the primary gate (RELEASE §9): the update manifest's
 * `minimum_version` should already have moved the device. Raise the two together, in the same
 * release, and never retroactively.
 */
export const MIN_CLIENT_VERSION = '0.0.0';

/**
 * Routes that are NOT subject to the version gate.
 *
 * `meta` is exempt for a reason that is easy to get wrong: it is how a client *discovers*
 * `minProto`. Gating it would mean a client too old to sync is also too old to be told why, and
 * the plain-language outdated screen (22.7 — "instead of failing quietly") would have nothing to
 * put in its one sentence. It is also what RELEASE §7.4's post-deploy smoke test reads, before
 * any client exists at all.
 */
export const VERSION_EXEMPT = Object.freeze(['meta']);

/** @param {string} routeName @returns {boolean} */
export function isVersionExempt(routeName) {
  return VERSION_EXEMPT.includes(routeName);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. A semver subset — deliberately re-implemented, deliberately strict
// ─────────────────────────────────────────────────────────────────────────────
//
// `src/js/platform/updater.js` already has a full, well-tested semver. It is NOT imported here
// and must not be: ADR 005 §2's import-direction gate allows `server/core` to import from
// `server/core` and nowhere else, and reaching into the desktop tree from a Vercel function
// would drag client code into the server bundle for the sake of forty lines.
//
// Instead the two are cross-checked: `tests/server/version.test.js` runs a shared corpus of
// version pairs through BOTH comparators and asserts they agree on every one, so the two
// implementations cannot drift into disagreeing about which client is too old.
//
// Strict on purpose. A loose parser that shrugs at "1.2" turns a typo in a release variable into
// a gate that silently never fires — or, worse, one that fires on everybody.

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const NUMERIC_RE = /^(0|[1-9]\d*)$/;

/** A version longer than this is not a version; it is a payload. */
const MAX_VERSION_CHARS = 64;

/**
 * @param {unknown} input a version string, with or without the git-tag `v` prefix
 * @returns {{major:number, minor:number, patch:number, pre:string[], raw:string}|null}
 *          null on anything that is not exactly MAJOR.MINOR.PATCH[-pre][+build]. NEVER throws:
 *          every caller here is parsing a header an attacker chose.
 */
export function parseVersion(input) {
  if (typeof input !== 'string') return null;
  if (input.length === 0 || input.length > MAX_VERSION_CHARS) return null;
  const s = input.startsWith('v') ? input.slice(1) : input;
  const m = SEMVER_RE.exec(s);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
    raw: s,
  };
}

/** Semver §11 pre-release ordering, in full. A pre-release sorts BEFORE its release. */
function comparePre(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    const xn = NUMERIC_RE.test(x);
    const yn = NUMERIC_RE.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn) return -1;
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/**
 * Total order over versions. Build metadata is ignored (semver §10): two builds of the same
 * version are the same version.
 * @param {string|Object} a @param {string|Object} b
 * @returns {-1|0|1|null} null when either side is unparsable — the caller decides, and every
 *          caller in this file decides "fail closed".
 */
export function compareVersions(a, b) {
  const x = typeof a === 'string' ? parseVersion(a) : a;
  const y = typeof b === 'string' ? parseVersion(b) : b;
  if (!x || !y) return null;
  if (x.major !== y.major) return x.major < y.major ? -1 : 1;
  if (x.minor !== y.minor) return x.minor < y.minor ? -1 : 1;
  if (x.patch !== y.patch) return x.patch < y.patch ? -1 : 1;
  return comparePre(x.pre, y.pre);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The gate
// ─────────────────────────────────────────────────────────────────────────────

/** A protocol header is at most nine digits. Anything longer is not a number a client sent. */
const PROTO_RE = /^[0-9]{1,9}$/;

/**
 * Build a version gate.
 *
 * **Why this is a factory and not just the four module constants.** Today `PROTO_MAX` is 1, so
 * `PROTO_MIN` is also 1 and there IS no previous version — which means a compat test written
 * against the module constants passes vacuously and would keep passing after someone broke the
 * rule. `createVersionGate` lets `tests/server/version.test.js` instantiate the server as it
 * will exist at protocol 2 and 3 and drive a real N−1 client through a real push/pull cycle
 * against it. The rule becomes a property that is exercised now, on a machine where protocol 2
 * does not exist yet, instead of a sentence someone re-reads in a year.
 *
 * @param {{protoMax?:number, protoFloor?:number, minClientVersion?:string}} [opts]
 * @returns {{protoMax:number, protoMin:number, supported:number[], minClientVersion:string,
 *            headers:() => Object<string,string>,
 *            readProtocol:(req:Object) => number|null,
 *            readClientVersion:(req:Object) => string|null,
 *            check:(req:Object) => {proto:number, clientVersion:string|null}}}
 */
export function createVersionGate(opts) {
  const o = opts || {};
  const protoMax = Number.isInteger(o.protoMax) ? o.protoMax : PROTO_MAX;
  const protoFloor = Number.isInteger(o.protoFloor) ? o.protoFloor : PROTO_FLOOR;
  const minClientVersion = typeof o.minClientVersion === 'string' ? o.minClientVersion : MIN_CLIENT_VERSION;

  if (protoMax < 1) throw new Error('protoMax must be >= 1');
  if (!parseVersion(minClientVersion)) throw new Error(`minClientVersion ${JSON.stringify(minClientVersion)} is not semver`);

  // THE N−1 RULE, in one expression that cannot be widened the wrong way. See the header.
  const protoMin = Math.max(1, Math.min(protoFloor, protoMax - 1));
  const supported = Object.freeze(Array.from({ length: protoMax - protoMin + 1 }, (_, i) => protoMin + i));

  /** A gate is "armed" only when a minimum client build was actually demanded. */
  const clientGateArmed = compareVersions(minClientVersion, '0.0.0') === 1;

  const headers = () => ({
    [RESPONSE_PROTOCOL_HEADER]: String(protoMax),
    [RESPONSE_MIN_PROTOCOL_HEADER]: String(protoMin),
  });

  /**
   * The extras every version failure carries. `sync.contract.js` §5's `checkProtocol` promises
   * the client BOTH `minProto` and `minClientVersion` on either failure kind, so both rides on
   * both — a client with one parser is not asked to grow a second branch. `maxProto` is added
   * so a downgraded client can log what it was talking to.
   *
   * All four are coordination data: two integers and two version strings. Nothing derived from
   * a request body ever reaches an error body (errors.js `toResponse`).
   */
  const failureExtra = () => ({
    minProto: protoMin,
    maxProto: protoMax,
    [WIRE_MIN_CLIENT_KEY]: minClientVersion,
  });

  const readProtocol = (req) => {
    const h = (req && req.headers) || {};
    const raw = h[PROTOCOL_HEADER];
    if (typeof raw !== 'string' || !PROTO_RE.test(raw)) return null;
    return Number(raw);
  };

  const readClientVersion = (req) => {
    const h = (req && req.headers) || {};
    const raw = h[CLIENT_HEADER];
    const v = parseVersion(raw);
    return v ? v.raw : null;
  };

  /**
   * The whole gate, fail-closed at every step.
   *
   *   header absent            → 426 protocol_too_old
   *   header malformed         → 400 bad_request
   *   proto <  protoMin        → 426 protocol_too_old   (ADR 003 §4)
   *   proto >  protoMax        → 400 protocol_unknown   (ADR 003 §4)
   *   client build < minimum   → 426 protocol_too_old   (22.7 / LZP-104)
   *
   * **Absent is treated as too old, not as malformed.** Every client that has ever existed sends
   * the header (ADR 003 §1), so an absent one means either a build older than the protocol
   * itself or something that is not a client. 426 is the outcome that produces an actionable
   * sentence on a real client and an equally clear code for anything else; 400 would produce the
   * quiet failure 22.7 exists to forbid.
   *
   * **A malformed header is 400, not 426.** `"abc"` is not a protocol older than ours; it is not
   * a protocol. Telling that caller to upgrade would be a lie, and `protocol_unknown` is
   * reserved by ADR 003 §4 for a value strictly ABOVE `PROTO_MAX`.
   *
   * @param {Object} req a ServerReq
   * @returns {{proto:number, clientVersion:string|null}}
   * @throws {import('./errors.js').HttpError}
   */
  const check = (req) => {
    const h = (req && req.headers) || {};
    const raw = h[PROTOCOL_HEADER];
    if (raw === undefined || raw === null || raw === '') throw fail('protocol_too_old', failureExtra());
    if (typeof raw !== 'string' || !PROTO_RE.test(raw)) throw fail('bad_request');

    const proto = Number(raw);
    if (proto < protoMin) throw fail('protocol_too_old', failureExtra());
    if (proto > protoMax) throw fail('protocol_unknown', failureExtra());

    const clientVersion = readClientVersion(req);
    if (clientGateArmed) {
      // Fail closed: an armed gate with no readable client version is a client we cannot
      // vouch for, and 22.7's whole point is that such a client is told rather than left to
      // fail in some other way later.
      if (clientVersion === null) throw fail('protocol_too_old', failureExtra());
      if (compareVersions(clientVersion, minClientVersion) === -1) throw fail('protocol_too_old', failureExtra());
    }
    return { proto, clientVersion };
  };

  return Object.freeze({
    protoMax, protoMin, supported, minClientVersion, clientGateArmed,
    headers, readProtocol, readClientVersion, check,
  });
}

/** The gate this build actually runs. */
export const GATE = createVersionGate({});

/** `{'X-LZP-Protocol': …, 'X-LZP-Min-Protocol': …}` — merge into EVERY response, errors included. */
export function versionHeaders() {
  return GATE.headers();
}

/**
 * @param {Object} req @returns {{proto:number, clientVersion:string|null}}
 * @throws {import('./errors.js').HttpError} 426 protocol_too_old · 400 protocol_unknown · 400 bad_request
 */
export function checkVersion(req) {
  return GATE.check(req);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. The registry wrapper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap a handler registry so the version gate runs before every non-exempt handler and
 * `X-LZP-Protocol` / `X-LZP-Min-Protocol` ride on every response the handlers produce.
 *
 * This is a registry → registry function on purpose. Putting the gate in `router.js` would make
 * the route table depend on the version constants; putting it in each handler would make it
 * twenty-two chances to forget. One line at the composition site —
 *
 *     createRouter(withVersionGate(withLimits(handlers)))
 *
 * — covers every route that will ever exist, including ones written after this file was last
 * read, because a route with no handler cannot be reached and a handler in the registry is
 * always wrapped.
 *
 * Error responses do NOT pass through here: a throw becomes a body in `errors.js:toResponse`,
 * which is called by the host. The host must merge `versionHeaders()` into that response too —
 * ADR 003 §4 says *every* response carries them, and a 426 that does not tell the client the
 * window is a 426 the client cannot act on. `server/dev-server.mjs` already writes both headers
 * unconditionally in `writeHead`, which is the shape to copy.
 *
 * @param {Object<string, Function>} handlers
 * @param {{gate?:Object}} [opts]
 * @returns {Object<string, Function>}
 */
export function withVersionGate(handlers, opts) {
  const gate = (opts && opts.gate) || GATE;
  const out = {};
  for (const name of Object.keys(handlers || {})) {
    const inner = handlers[name];
    if (typeof inner !== 'function') { out[name] = inner; continue; }
    const exempt = isVersionExempt(name);
    out[name] = async function versionGated(req, ctx) {
      if (!exempt) gate.check(req);
      const res = await inner(req, ctx);
      if (!res || typeof res !== 'object') return res;
      return { ...res, headers: { ...gate.headers(), ...(res.headers || {}) } };
    };
  }
  return out;
}
