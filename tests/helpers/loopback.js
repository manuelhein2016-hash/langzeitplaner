// tests/helpers/loopback.js — the REAL relay, in-process, with no sockets.  LZP-505.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS IS, AND WHAT IT REFUSES TO BE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `docs/v2/contracts/server.contract.js §3` names this file:
//
//   > `route(ctx, req)` … SHARED by api/v1/[[...path]].js and by tests/helpers/loopback.js, so
//   > the fleet suite exercises the real handlers with no sockets.
//
// and ADR 003 §8 says the same from the client side: "`transport` is a PORT, not fetch. In tests
// it is bound directly to the real server handlers over the memory adapter, so the fleet suite
// exercises the real client and the real server logic with no sockets."
//
// **NOTHING HERE ANSWERS A REQUEST.** The chain a request walks is, end to end:
//
//     the client under test  (src/js/sync/personal.js, or a test driving it by hand)
//       → src/js/platform/net.js `createFetchTransport`   the SHIPPING transport: real canonical
//         │                                               query, real signed string, real ECDSA,
//         │                                               real origin and path assertions
//         → `wire.deliver`                                partition / heal, and the T1 adversary
//           → server/core/handlers/index.js               the REAL router + version gate
//             → server/core/auth.js                       the REAL ADR 003 §2 ladder
//               → server/adapters/memory.js               the REAL memory adapter
//
// The only thing replaced is the socket, and the adapter between them is `fetchImplFor` — about
// thirty lines that build the same `ServerReq` `server/dev-server.mjs` builds from a real
// `node:http` request, field for field, with the same lower-casing and the same `JSON.parse` of
// the raw bytes. A test that passes here is a test about the product.
//
// **AND IT IS NOT A HELPFUL SERVER.** `wire.hostile.onResponse` lets a test become the relay of
// ADR 002 §5.4 — withholding, reordering, duplicating, rewinding a cursor, relabelling an epoch,
// re-attributing a device, splicing an op id. Every `MUTATORS` entry is a MUTATION OF THE HONEST
// ANSWER rather than an invention, so an adversary can never accidentally be tested against a
// fake: if the honest response would have been a 403, the hostile one is a 403 too.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// PROVENANCE — because this file was destroyed once and the record belongs with it
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// On 2026-08-29 a parallel agent wrote a different helper to this path without checking whether
// it was taken; the file was untracked, so git held no copy. The exports and the behaviour were
// restored from the owning ticket's own working copy and its two call sites, and the behaviour is
// now pinned rather than asserted: `tests/tier1/sync-convergence.test.js` (21 tests) and
// `tests/fleet/*.test.js` (60 tests) drive every export in this file end to end against the real
// handlers, including `wire.partition`/`heal`, every `MUTATORS` entry, and the seeded shuffle over
// 24 seeds. `tests/tier1/no-reconstruction.test.js` states the rule that made that necessary, and
// it is the right rule: a helper whose partition heals one tick early turns a torn network into a
// green test. The other agent's own helper now lives at `tests/helpers/sync-loopback.js`.
//
// Zero dependencies; no wall clock and no `Math.random` in anything a test asserts on.

import { createHandlers } from '../../server/core/handlers/index.js';
import { authenticate, assertMember } from '../../server/core/auth.js';
import { LIMITS, createLog, LOG_FIELD_NAMES } from '../../server/core/limits.js';
import { toResponse } from '../../server/core/errors.js';
import { memoryStore } from '../../server/adapters/memory.js';

import { createFetchTransport, NetError } from '../../src/js/platform/net.js';

const S = globalThis.crypto.subtle;
const rnd = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** The one origin every transport in the suite addresses. `net.js` refuses any other. */
export const ORIGIN = 'https://relay.test';

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

export { LOG_FIELD_NAMES };

/**
 * The relay's own limit table, re-exported.
 *
 * `tests/tier1/suite-integrity.test.js` allows a tier-1 test file to import only `node:`,
 * `../../src/js/…` or a helper — the rule that keeps a characterization from going green against
 * a stand-in. `server/` is real code but it is not `src/js/`, so a tier-1 test that wants to pin a
 * client constant against the SERVER's constant has to come through here. That is the right shape
 * anyway: this file is already the sanctioned door to the relay (`server.contract.js §3`), and one
 * door is easier to keep honest than five.
 */
export { LIMITS as SERVER_LIMITS };

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. A clock a test drives by hand
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * No wall clock reaches any assertion in this tree. `today()` is the ISO date the store's
 * `todayISO()` would produce for the simulated instant, which is what the fleet needs to mint a
 * spine that does not depend on when the suite happens to run.
 */
export function simClock(startMs = Date.UTC(2026, 7, 29, 9, 0, 0)) {
  let t = startMs;
  return {
    now: () => t,
    today: () => new Date(t).toISOString().slice(0, 10),
    advance(ms) { t += ms; return t; },
    set(ms) { t = ms; return t; },
  };
}

/** A deterministic float source, for a test that needs jitter it can predict. */
export function seededRandom(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. The relay
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * @param {{clock?:Object, limits?:Object, clientIp?:string}} opts
 * @returns {{dispatch:(req:Object)=>Promise<Object>, store:Object, ctx:Object, route:Function,
 *            logLines:string[], limits:Object, clock:Object, LOG_FIELD_NAMES:string[]}}
 */
export function createRelay(opts = {}) {
  const clock = opts.clock || simClock();
  const limits = opts.limits || LIMITS;
  const store = memoryStore({ now: () => clock.now() });
  const route = createHandlers();
  /** Serialised, because a test asserts on the FIELD NAMES that reached the serialiser. */
  const logLines = [];
  const ctx = {
    store,
    now: () => clock.now(),
    random: (n) => rnd(n),
    sha256: async (b) => new Uint8Array(await S.digest('SHA-256', b)),
    auth: (req) => authenticate(req, ctx),
    assertMember: (memberId, spaceId) => assertMember(memberId, spaceId, ctx),
    log: createLog((e) => logLines.push(JSON.stringify(e))),
    limits,
  };

  /** One `ServerReq` in, one `ServerRes` out. A throw becomes the shaped body `errors.js` builds. */
  async function dispatch(req) {
    try {
      return await route(ctx, req);
    } catch (e) {
      return toResponse(e);
    }
  }

  return { dispatch, store, ctx, route, logLines, limits, clock, LOG_FIELD_NAMES };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. The wire — partitions, and the T1 adversary
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * @param {Object} relay
 * @returns {{deliver:Function, partition:Function, heal:Function, isolated:Function,
 *            honest:Function, hostile:{onResponse:Function|null}, seenBodies:Array,
 *            calls:Array, relay:Object}}
 */
export function createWire(relay) {
  const isolatedShorts = new Set();
  const wire = {
    relay,
    /** Every request BODY the relay was handed. The blindness assertion reads this. */
    seenBodies: [],
    calls: [],
    /** Set to `(res, req) => res` to become the relay of ADR 002 §5.4. */
    hostile: { onResponse: null },
    honest() { wire.hostile.onResponse = null; return wire; },
    partition(deviceShort) { isolatedShorts.add(deviceShort); return wire; },
    heal(deviceShort) { isolatedShorts.delete(deviceShort); return wire; },
    isolated(deviceShort) { return isolatedShorts.has(deviceShort); },

    /**
     * The transport-facing entry point. `deviceShort` is the transport's own, so a partition is a
     * property of THAT MAC and not of the relay — which is what "offline" actually means, and why
     * a partitioned device raises `NetError('offline')` rather than receiving a 5xx.
     *
     * @param {string} deviceShort
     * @param {Object} req a ServerReq
     * @returns {Promise<{status:number, headers:Object, body:any}>}
     */
    async deliver(deviceShort, req) {
      if (isolatedShorts.has(deviceShort)) {
        throw new NetError('offline', `wire: ${deviceShort} is partitioned from the relay`);
      }
      wire.calls.push({ method: req.method, path: req.path, query: req.query, deviceShort });
      if (req.body !== null && req.body !== undefined) wire.seenBodies.push(req.body);
      const res = await relay.dispatch(req);
      const shaped = {
        status: res.status,
        headers: { 'X-LZP-Protocol': '1', 'X-LZP-Min-Protocol': '1', ...(res.headers || {}) },
        body: res.body === undefined ? null : res.body,
      };
      if (typeof wire.hostile.onResponse === 'function') {
        // `deviceShort` is the third argument on purpose: a relay that lies to ONE Mac and tells
        // the other the truth is the interesting adversary — it is the only one that can produce
        // a DIVERGENCE rather than a shared error, and it is what a `withholdOps` test needs to
        // aim at a single victim.
        const out = wire.hostile.onResponse(shaped, req, deviceShort);
        return out === undefined ? shaped : out;
      }
      return shaped;
    },
  };
  return wire;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4. The transport — `platform/net.js` with the socket swapped
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The `fetchImpl` `net.js` is handed. It is the whole of the socket replacement: a URL and the
 * exact bytes `net.js` signed, turned into a `ServerReq` the way `api/v1/[[...path]].js` does.
 */
export function fetchImplFor(wire, deviceShort, opts = {}) {
  return async function loopbackImpl(url, init) {
    const u = new URL(url);
    const query = {};
    for (const [k, v] of u.searchParams) query[k] = v;
    const rawBody = init && init.body ? new Uint8Array(init.body) : new Uint8Array(0);
    const headers = {};
    for (const k of Object.keys((init && init.headers) || {})) headers[k.toLowerCase()] = init.headers[k];
    let body = null;
    if (rawBody.length) {
      try { body = JSON.parse(new TextDecoder().decode(rawBody)); } catch { body = null; }
    }
    const res = await wire.deliver(deviceShort, {
      method: (init && init.method) || 'GET',
      path: u.pathname,
      query,
      headers,
      body,
      rawBody,
      clientIp: opts.clientIp || '198.51.100.9',
    });
    return responseLike(res.status, res.headers, res.body === null ? '' : JSON.stringify(res.body));
  };
}

/** The three members of a `Response` that `platform/net.js` actually reads. */
export function responseLike(status, headers, text) {
  const map = new Map(Object.entries(headers || {}));
  return {
    status,
    headers: { forEach: (fn) => map.forEach((v, k) => fn(v, k)) },
    async text() { return text; },
  };
}

/**
 * A `Transport` for one device, built out of the SHIPPING transport.
 *
 * This is the strongest binding available: `createFetchTransport` does the canonical query, the
 * signed string, the ECDSA signature, the header set, the 4 MB refusal and the origin/path
 * assertions exactly as it will in the app. A test that drives this drives `net.js`.
 *
 * @param {{wire:Object, deviceShort:string, sign:Function, now?:Function,
 *          clientVersion?:string, clientIp?:string}} p
 */
export function deviceTransport(p) {
  const wire = p.wire;
  return createFetchTransport({
    origin: ORIGIN,
    deviceShort: p.deviceShort,
    sign: p.sign,
    clientVersion: p.clientVersion || '2.0.0',
    now: typeof p.now === 'function' ? p.now : () => (wire.relay && wire.relay.clock ? wire.relay.clock.now() : 0),
    random: (n) => rnd(n),
    subtle: S,
    schedule: (ms, fn) => globalThis.setTimeout(fn, ms),
    unschedule: (h) => globalThis.clearTimeout(h),
    fetchImpl: fetchImplFor(wire, p.deviceShort, { clientIp: p.clientIp }),
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5. MUTATORS — the four lies ADR 002 §5.4 says are worth detecting, and nothing else
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Each returns an `onResponse` of the shape `(res, req) => res`, and each is COMPOSABLE, because
// the interesting adversary is "shuffled AND doubled" rather than either alone. They mutate only
// a 200 answer to `GET /api/v1/ops`; everything else passes through untouched, so a mutator can
// never accidentally break the auth ladder it is not testing.

const isPull = (res, req) => res.status === 200 && req.method === 'GET'
  && req.path === '/api/v1/ops' && res.body && Array.isArray(res.body.ops);

const withOps = (res, ops) => ({ ...res, body: { ...res.body, ops } });

export const MUTATORS = Object.freeze({
  /** Serve the page backwards. `seq` is a transport cursor and never a merge input (§3.3). */
  reverseOps: () => (res, req) => (isPull(res, req) ? withOps(res, res.body.ops.slice().reverse()) : res),

  /** Serve every op twice. At-least-once delivery is sufficient (ADR 003 §3.1, ADR 001 §6). */
  duplicateOps: () => (res, req) => {
    if (!isPull(res, req)) return res;
    const out = [];
    for (const o of res.body.ops) { out.push(o); out.push({ ...o }); }
    return withOps(res, out);
  },

  /** Deterministic shuffle. A seed, so a failure is reproducible. */
  shuffleOps: (seed = 1) => (res, req) => {
    if (!isPull(res, req)) return res;
    const rand = seededRandom(seed);
    const a = res.body.ops.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return withOps(res, a);
  },

  /**
   * Rewind the cursor so the client is served the same page for ever.
   *
   * The adversary is not obliged to terminate; the CLIENT is obliged to bound its own pull loop
   * and to lose nothing when it stops. That is what the test asserts.
   */
  rewindCursor: () => (res, req) => {
    if (!isPull(res, req)) return res;
    const since = (req.query && req.query.since) || '0';
    return { ...res, body: { ...res.body, nextCursor: String(since), hasMore: true } };
  },

  /** Withhold every op a predicate names — the censorship the chain witness exists to catch. */
  withholdOps: (pred) => (res, req) => (isPull(res, req)
    ? withOps(res, res.body.ops.filter((o) => !pred(o)))
    : res),

  /** Rewrite the chain values, so the recomputation fails at a row a test chooses. */
  rewriteChain: (fn) => (res, req) => (isPull(res, req)
    ? withOps(res, res.body.ops.map((o, i) => ({ ...o, chain: fn(o, i) || o.chain })))
    : res),

  // ── the AAD half ──────────────────────────────────────────────────────────
  //
  // The five above attack ADR 003 §3.3's claim that `seq` is a transport cursor and never a merge
  // input. The five below attack ADR 002 §5.1's AAD binding instead — `v, sp, ep, dv, oid, wit`
  // are all authenticated, so each of these must fail CLOSED inside `openOp`, costing exactly the
  // op it touched and never the batch, the log or the board.

  /** Flip one ciphertext character. AES-GCM's tag must catch it: `openOp` throws `aead`. */
  tamperCiphertext: (which = 0) => (res, req) => {
    if (!isPull(res, req) || !res.body.ops.length) return res;
    const ops = res.body.ops.slice();
    const i = which % ops.length;
    ops[i] = { ...ops[i], ct: flipB64uChar(ops[i].ct) };
    return withOps(res, ops);
  },

  /** Re-attribute every op to another device. The AAD binds `dv`; `openOp` throws `P3`. */
  reattribute: (toShort) => (res, req) => (isPull(res, req)
    ? withOps(res, res.body.ops.map((o) => ({ ...o, dv: toShort })))
    : res),

  /** Relabel the epoch. The AAD binds `ep`, so a wrong label can only park or fail, never merge. */
  relabelEpoch: (ep = 99) => (res, req) => (isPull(res, req)
    ? withOps(res, res.body.ops.map((o) => ({ ...o, ep })))
    : res),

  /** Splice: serve op A's bytes under op B's id. The AAD binds `oid` (ADR 002 §5.1). */
  spliceOid: () => (res, req) => {
    if (!isPull(res, req) || res.body.ops.length < 2) return res;
    const ops = res.body.ops.slice();
    ops[0] = { ...ops[0], oid: res.body.ops[1].oid };
    ops[1] = { ...ops[1], oid: res.body.ops[0].oid };
    return withOps(res, ops);
  },

  /** Cross-space replay: relabel a personal envelope into another space id (story 21.2). */
  relabelSpace: (sp) => (res, req) => (isPull(res, req)
    ? withOps(res, res.body.ops.map((o) => ({ ...o, sp })))
    : res),

  /**
   * Forge a device row on the pull piggyback. `handlers/members.js` states the rule this attacks:
   * "a malicious relay cannot fabricate a device row for an existing member … the relay's device
   * rows are a hint about who to wrap to; the log is the authority."
   */
  forgeDeviceRow: (row) => (res, req) => {
    if (!isPull(res, req)) return res;
    const members = (res.body.members || []).map((m) => ({ ...m, devices: [...(m.devices || [])] }));
    if (members[0]) members[0].devices.push(row);
    return { ...res, body: { ...res.body, members } };
  },

  /** Force a status on every request a predicate names. For 429 / 5xx / 426 behaviour. */
  forceStatus: (status, body, headers) => (res, req) => (
    typeof status === 'function'
      ? (Number.isInteger(status(req)) ? { status: status(req), headers: { ...res.headers, ...headers }, body: body || { error: 'internal' } } : res)
      : { status, headers: { ...res.headers, ...headers }, body: body || { error: 'internal' } }
  ),
});

/** Change exactly one base64url character, so the bytes differ and the length does not. */
function flipB64uChar(str) {
  if (typeof str !== 'string' || str.length === 0) return str;
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const i = Math.floor(str.length / 2);
  return str.slice(0, i) + A[(A.indexOf(str[i]) + 1) % A.length] + str.slice(i + 1);
}

/**
 * Compose mutators, left to right. The interesting adversary is "shuffled AND doubled" rather
 * than either alone, and an `onResponse` that had to be hand-written per combination would be a
 * different adversary each time.
 */
export const chainMutators = (...fns) => (res, req, who) => fns.reduce((r, f) => f(r, req, who), res);
