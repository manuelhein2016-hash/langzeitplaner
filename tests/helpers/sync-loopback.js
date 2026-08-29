// tests/helpers/sync-loopback.js — the REAL relay, in-process, with no sockets (LZP-501).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS HELPER EXISTS, AND WHAT IT REFUSES TO BE
// ─────────────────────────────────────────────────────────────────────────────────────────────
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
// `tests/tier1/suite-integrity.test.js` requires every tier-1 TEST file to import only `node:`,
// `../../src/js/…` or a helper — the rule that stops the suite quietly testing a stand-in. So the
// server import lives here, exactly as `relay-auth.js` does for the auth verifier.
//
// **IT IS NOT A FAKE SERVER.** Nothing in this file answers a request. The chain a request walks
// is, end to end:
//
//     sync/client.js
//       → platform/net.js `createFetchTransport`      the SHIPPING transport, real signing
//         → this file's `handlerImpl`                  a URL→ServerReq adapter, ~30 lines
//           → server/core/handlers/index.js            the REAL router + version gate
//             → server/core/auth.js                    the REAL ADR 003 §2 ladder
//               → server/adapters/memory.js            the REAL memory adapter
//
// The only thing replaced is the socket. A test that passes here is a test about the product.
//
// **AND IT IS NOT A HELPFUL SERVER.** `hostile()` lets a test wrap the same stack with a relay
// that withholds, reorders, forks or lies about a cursor — the T1 adversary of ADR 002 §5.4. The
// point of binding the real one is that the hostile one is a DIFFERENCE from it rather than an
// invention.

import { createHandlers } from '../../server/core/handlers/index.js';
import { authenticate, assertMember } from '../../server/core/auth.js';
import { LIMITS, createLog } from '../../server/core/limits.js';
import { memoryStore } from '../../server/adapters/memory.js';

import { createFetchTransport } from '../../src/js/platform/net.js';
import {
  generateDeviceKeys, generateRecoveryKeys, exportRawPublic, signBytes,
  buildDeviceAttestation, attestDevice, deviceShortOfB64u,
} from '../../src/js/crypto/identity.js';
import { b64u } from '../../src/js/core/b64.js';

const S = globalThis.crypto.subtle;
const TE = new TextEncoder();
const rnd = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export const ORIGIN = 'https://relay.test';

/** A clock a test drives by hand. No wall clock reaches any assertion in this tree. */
export function fakeClock(startMs = 1787836800000) {
  let t = startMs;
  return {
    now: () => t,
    advance(ms) { t += ms; return t; },
    set(ms) { t = ms; return t; },
  };
}

/**
 * A scheduler a test drives by hand: `schedule(ms, fn)` records, `run(ms)` fires everything due.
 * `src/js/sync/` may not call `setTimeout` (the purity gate), so this is the shape the client is
 * written against and the shape the shell will inject.
 */
export function fakeScheduler(clock) {
  let next = 1;
  const timers = new Map();
  /**
   * A fired timer usually starts async work (`void pullNow()`), so "run the timers" has to mean
   * "run the timers AND let what they started settle" — otherwise every cadence assertion races
   * the request it is about and fails intermittently, which is worse than failing always.
   */
  const flush = async () => {
    for (let i = 0; i < 50; i++) await new Promise((r) => globalThis.setImmediate(r));
  };
  return {
    flush,
    pending: () => timers.size,
    schedule(ms, fn) {
      const id = next++;
      timers.set(id, { at: clock.now() + Math.max(0, ms), fn });
      return id;
    },
    unschedule(id) { timers.delete(id); },
    /** Advance the clock and run everything that comes due, in time order. Returns how many ran. */
    async run(ms) {
      clock.advance(ms);
      let ran = 0;
      // A timer may schedule another; loop until nothing more is due at this instant.
      for (let guard = 0; guard < 1000; guard++) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= clock.now())
          .sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        for (const [id, t] of due) {
          timers.delete(id);
          ran++;
          await t.fn();
          await flush();
        }
      }
      await flush();
      return ran;
    },
    /** Run every pending timer regardless of its deadline. For "settle everything" in a test. */
    async drain() {
      let ran = 0;
      for (let guard = 0; guard < 1000 && timers.size; guard++) {
        const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at);
        for (const [id, t] of due) {
          timers.delete(id);
          ran++;
          await t.fn();
          await flush();
        }
      }
      await flush();
      return ran;
    },
  };
}

/** A deterministic float source. `src/js/sync/` may not call `Math.random`. */
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
// Identities — real P-256 keys, real attestations
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** One person: a member id and a recovery key pair, which is what attests their devices. */
export async function makeMember(colorRef = 'gruen') {
  const rec = await generateRecoveryKeys({});
  return {
    memberId: `mem_${b64u(rnd(16))}`,
    colorRef,
    recSigPriv: rec.recSig.privateKey,
    recSigPubRaw: b64u(await exportRawPublic(rec.recSig.publicKey, {})),
    recKexPubRaw: b64u(await exportRawPublic(rec.recKex.publicKey, {})),
  };
}

/**
 * One Mac of that person: a device key pair, the key-derived `deviceShort` (ADR 001 §1.2), and a
 * DeviceAttestation signed by the member's recovery key — the real one, so `verifyDeviceClaim`'s
 * S1/S2 checks on the relay are genuinely exercised.
 */
export async function makeDevice(member, label = 'mac', createdAt = '2026-08-29') {
  const keys = await generateDeviceKeys({});
  const sigPubRaw = b64u(await exportRawPublic(keys.devSig.publicKey, {}));
  const kexPubRaw = b64u(await exportRawPublic(keys.devKex.publicKey, {}));
  const deviceId = `dev_${b64u(rnd(16))}`;
  const deviceShort = deviceShortOfB64u(sigPubRaw);
  const att = await buildDeviceAttestation(
    { memberId: member.memberId, deviceId, createdAt },
    keys.devSig.publicKey, keys.devKex.publicKey, {},
  );
  const blob = await attestDevice(att, member.recSigPriv, {});
  return {
    label,
    member,
    deviceId,
    deviceShort,
    sigPubRaw,
    kexPubRaw,
    attestation: blob,
    sigPriv: keys.devSig.privateKey,
    sign: (bytes) => signBytes(keys.devSig.privateKey, bytes, {}),
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The relay
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * @param {{clock:{now:()=>number}}} opts
 * @returns {{store:Object, ctx:Object, route:Function, logLines:Array,
 *            handler:(url:string, init:Object)=>Promise<Object>, calls:Array}}
 */
export function createRelay(opts = {}) {
  const clock = opts.clock || fakeClock();
  const store = memoryStore({ now: () => clock.now() });
  const route = createHandlers();
  const logLines = [];
  const calls = [];
  const ctx = {
    store,
    now: () => clock.now(),
    random: (n) => rnd(n),
    sha256: async (b) => new Uint8Array(await S.digest('SHA-256', b)),
    auth: (req) => authenticate(req, ctx),
    assertMember: (memberId, spaceId) => assertMember(memberId, spaceId, ctx),
    log: createLog((e) => logLines.push(e)),
    limits: LIMITS,
  };

  /**
   * The socket replacement, and the whole of it. `platform/net.js` hands us the URL it built and
   * the exact bytes it signed; this turns them into a `ServerReq` the way `api/v1/[[...path]].js`
   * does and hands back something with the three members `net.js` reads off a Response.
   */
  async function handler(url, init) {
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
    const req = {
      method: (init && init.method) || 'GET',
      path: u.pathname,
      query,
      headers,
      body,
      rawBody,
      clientIp: (opts.clientIp) || '198.51.100.9',
    };
    calls.push({ method: req.method, path: req.path, query, at: clock.now() });
    let res;
    try {
      res = await route(ctx, req);
    } catch (e) {
      const { toResponse } = await import('../../server/core/errors.js');
      res = toResponse(e);
    }
    const text = res.body === undefined || res.body === null ? '' : JSON.stringify(res.body);
    const outHeaders = { ...(res.headers || {}) };
    // Every response carries the two version headers (ADR 003 §4) — `dev-server.mjs` writes them
    // unconditionally in `writeHead` and this mirrors that, error responses included.
    if (!Object.keys(outHeaders).some((k) => k.toLowerCase() === 'x-lzp-protocol')) {
      outHeaders['X-LZP-Protocol'] = '1';
      outHeaders['X-LZP-Min-Protocol'] = '1';
    }
    return responseLike(res.status, outHeaders, text);
  }

  return { store, ctx, route, logLines, calls, handler, clock };
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
 * A `Transport` for one device, built out of the SHIPPING transport with the socket swapped.
 *
 * This is the strongest binding available: `createFetchTransport` does the canonical query, the
 * signed string, the ECDSA signature, the header set, the 4 MB refusal and the origin/path
 * assertions, exactly as it will in the app. Only `fetchImpl` is ours.
 */
export function transportFor(relay, device, opts = {}) {
  const impl = opts.handler || relay.handler;
  const t = createFetchTransport({
    origin: ORIGIN,
    deviceShort: device.deviceShort,
    sign: device.sign,
    clientVersion: opts.clientVersion || '2.0.0',
    now: () => relay.clock.now(),
    random: (n) => rnd(n),
    subtle: S,
    schedule: (ms, fn) => globalThis.setTimeout(fn, ms),
    unschedule: (h) => globalThis.clearTimeout(h),
    fetchImpl: (url, init) => impl(url, init),
  });
  return t;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Bootstrapping a space, through the real endpoints
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** An opaque key wrap. Its CONTENT is irrelevant to a transport test; its PRESENCE is not. */
const wrap = (recipientId, epoch) => ({ recipientId, epoch, wrapped: b64u(rnd(156)) });

/**
 * `POST /api/v1/spaces` through the real handler: Space + Epoch 1 + Member + Device + the epoch-1
 * wraps, in one transaction, with the coverage check armed.
 */
export async function createSpace(relay, device, kind = 'PERSONAL') {
  const m = device.member;
  const spaceId = `${kind === 'FAMILY' ? 'fsp_' : 'psp_'}${b64u(rnd(16))}`;
  const t = transportFor(relay, device);
  const res = await t.request('POST', '/api/v1/spaces', undefined, {
    spaceId,
    kind,
    colorRef: m.colorRef,
    member: { memberId: m.memberId, recoveryPubSig: m.recSigPubRaw, recoveryPubKex: m.recKexPubRaw },
    device: {
      deviceId: device.deviceId, deviceShort: device.deviceShort,
      sigPubRaw: device.sigPubRaw, kexPubRaw: device.kexPubRaw,
      // RECONCILED 2026-08-29 — finding E2E3-7, and this comment used to be the workaround:
      //   "`createSpace` reads the attestation as OPAQUE BYTES (`readBytes`), while
      //    `registerDevice` reads it as the `payload.sig` STRING blob and verifies it. Two
      //    spellings of one field on two endpoints — reported to the server owner as an
      //    inconsistency, encoded here."
      // The server owner took the report. Both endpoints now take the blob STRING and both
      // verify it, so the encoding step is gone rather than moved.
      attestation: device.attestation,
    },
    wraps: [wrap(device.deviceId, 1), wrap(`rec_${m.memberId}`, 1)],
  });
  if (res.status !== 200) {
    throw new Error(`loopback.createSpace: the relay answered ${res.status} ${JSON.stringify(res.json)}`);
  }
  return spaceId;
}

/** `POST /api/v1/devices` — the second Mac of the same person. M1's whole configuration. */
export async function registerDevice(relay, spaceId, device) {
  const t = transportFor(relay, device);
  const res = await t.request('POST', '/api/v1/devices', undefined, {
    spaceId,
    memberId: device.member.memberId,
    deviceId: device.deviceId,
    deviceShort: device.deviceShort,
    sigPubRaw: device.sigPubRaw,
    kexPubRaw: device.kexPubRaw,
    attestation: device.attestation,
  });
  if (res.status !== 200) {
    throw new Error(`loopback.registerDevice: the relay answered ${res.status} ${JSON.stringify(res.json)}`);
  }
  return res.json;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The T1 adversary — a relay that lies, built as a DIFFERENCE from the real one
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Wrap a relay's handler so a test can withhold, reorder, fork or mis-cursor a pull page — the
 * four things ADR 002 §5.4 says the chain witness exists to detect, and the only four.
 *
 * Every mutation is applied to the REAL answer, so nothing here can accidentally test a fake:
 * if the honest response would have been a 403, the hostile one is a 403 too.
 *
 * @param {Object} relay
 * @param {{withhold?:(op)=>boolean, reorder?:boolean, cursorAhead?:boolean, renumber?:boolean,
 *          rewriteChain?:(op,i)=>string, status?:(req)=>number|null,
 *          retryAfter?:string, dropAck?:boolean}} plan
 */
export function hostile(relay, plan = {}) {
  return async function hostileHandler(url, init) {
    const res = await relay.handler(url, init);
    const u = new URL(url);
    const method = (init && init.method) || 'GET';

    if (typeof plan.status === 'function') {
      const forced = plan.status({ method, path: u.pathname });
      if (Number.isInteger(forced)) {
        const h = { 'X-LZP-Protocol': '1', 'X-LZP-Min-Protocol': '1' };
        if (plan.retryAfter) h['Retry-After'] = plan.retryAfter;
        return responseLike(forced, h, JSON.stringify(plan.body || { error: plan.code || 'internal' }));
      }
    }

    if (!(method === 'GET' && u.pathname === '/api/v1/ops')) return res;

    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { return responseLike(res.status, {}, text); }
    if (res.status !== 200 || !Array.isArray(body.ops)) return responseLike(res.status, hdrs(res), text);

    let ops = body.ops.slice();
    if (typeof plan.withhold === 'function') ops = ops.filter((o) => !plan.withhold(o));
    let truncated = false;
    if (Number.isInteger(plan.pageSize) && ops.length > plan.pageSize) {
      // A smaller page than the relay would send, so a test can exercise the multi-page loop
      // without re-signing a query (the signature covers `limit`).
      ops = ops.slice(0, plan.pageSize);
      truncated = true;
    }
    if (plan.reorder && ops.length >= 2) { const a = ops[0]; ops[0] = ops[1]; ops[1] = a; }
    if (plan.renumber) {
      // Withhold a row AND close the hole in `seq`, so the client cannot see a gap. `seq` is not
      // in the AAD (ADR 002 §5.1), so the relay is free to do this — and it is the attack where
      // the chain RECOMPUTATION, rather than the contiguity check, is the only thing that catches it.
      const start = BigInt(u.searchParams.get('since') || '0');
      ops = ops.map((o, i) => ({ ...o, seq: String(start + BigInt(i) + 1n) }));
    }
    if (typeof plan.rewriteChain === 'function') {
      ops = ops.map((o, i) => ({ ...o, chain: plan.rewriteChain(o, i) || o.chain }));
    }
    const out = { ...body, ops };
    if (ops.length) out.nextCursor = ops[ops.length - 1].seq;
    if (truncated) out.hasMore = true;
    if (plan.cursorAhead) out.nextCursor = String(BigInt(out.nextCursor) + 5n);
    return responseLike(200, hdrs(res), JSON.stringify(out));
  };
}

function hdrs(res) {
  const out = {};
  res.headers.forEach((v, k) => { out[k] = v; });
  return out;
}
