// tests/server/reports.test.js — LZP-1009 second pass: the operator's three routes.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THIS FILE GUARDS A REVERSAL, WHICH IS A DIFFERENT JOB FROM GUARDING A FEATURE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `server/core/router.js` used to say, in one sentence, why there was no `GET /feedback`:
// *"a read-back turns a relay that takes custody into a relay that stores reports addressably,
// and the two are different products."* The PO chose the other product on 2026-09-05. The
// sentence was not wrong, so this file's job is not to celebrate the new routes — it is to hold,
// mechanically, every part of the old rule that must still be true:
//
//   §1  the SURFACE — four rows, exactly ONE of them anonymous, none of them space-scoped
//   §2  the CREDENTIAL GRAMMAR — two schemes that cannot be confused, three domain prefixes
//   §3  the LADDER — 404 unconfigured, then 401 for every way of getting it wrong
//   §4  the BINDING — the signature covers the method, the path and the query, and no body rides
//   §5  the BUDGET — spent FIRST, before the 404 and far before the verify; two separate buckets
//   §6  the STORE — the three report methods and NOTHING space-shaped, ever
//   §7  the WIRING — declared where the handler is, budgeted in the same table, owned by one file
//   §8  P10 — THERE IS NO REPLY PATH, asserted rather than remembered
//   §9  the MUTANTS — each names the row that dies, plus the honest-path control
//
// Every row drives the SHIPPED router — `createHandlers()`, the same function production runs —
// over a real memory store. There is no hand-built request path.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createHandlers, REQUIRED_CTX, HANDLER_OWNERS, handlers } from '../../server/core/handlers/index.js';
import { ROUTES, ROUTE_NAMES, SPACE_SCOPED, API_PREFIX } from '../../server/core/router.js';
import { LIMITS, LIMIT_EXTENSIONS, RATE_RULES, RATE_COVERAGE } from '../../server/core/limits.js';
import { memoryStore } from '../../server/adapters/memory.js';
import { toResponse } from '../../server/core/errors.js';
import { b64u, ub64, SIGNED_PREFIX, canonicalQuery, deviceShortOfRaw } from '../../server/core/auth.js';
import { PROTO_MAX as PROTOCOL } from '../../server/core/version.js';
import { FEEDBACK_PREFIX } from '../../server/core/handlers/feedback.js';
import {
  ADMIN_PROVES, ADMIN_PROVES_NOT, ADMIN_SCHEME, ADMIN_PARAMS, REPORTS_PREFIX,
  REPORT_ID_RE, MAX_LIST_ROWS, STORE_REQUIREMENTS, CTX_EXTENSIONS,
  adminSignedString, parseAdminAuthorization,
  listReports, getReport, deleteReport,
} from '../../server/core/handlers/reports.js';
import { stripCommentsAndStrings } from '../helpers/purity.js';

const S = globalThis.crypto.subtle;
const TE = new TextEncoder();
const route = createHandlers();
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The fixtures
// ─────────────────────────────────────────────────────────────────────────────────────────────

const rid = (n) => `rep_${String(n).padStart(22, 'A')}`;

/**
 * A `ReportRow` exactly as `store-interface.js` types it — two `Date`s, two `Uint8Array|null`s.
 * The wire shapes below are the handler's conversions of these, and §6g/§6h are what pin them.
 */
function row(over = {}) {
  return {
    id: rid(1),
    receivedAt: new Date(NOW - DAY),
    expiresAt: new Date(NOW - DAY + 90 * DAY),
    signed: false,
    devicePub: null,
    prose: 'Der Balken springt beim Ziehen zurück.',
    image: null,
    ...over,
  };
}

/**
 * The SHIPPED `memoryStore`, with a recorder around every method these routes could touch.
 *
 * Not a hand-written double. `store-interface.js`'s `Report` model and its four methods landed in
 * the same pass as this file, so every row below runs against the real `putReport` validation,
 * the real 90-day stamp, the real read-side expiry and the real `rateAllow` / `claimNonce` (store
 * contracts C46/C47, C49/C51). Nothing here reaches into the store's internals: a seed row is
 * filed by ADVANCING AN INJECTED CLOCK to its `receivedAt` and calling `putReport`, which is how
 * a report of a given age actually comes to exist. `expiresAt` is therefore always the store's
 * own stamp and never a fixture's opinion — which is the point, since the 90 days is the store's
 * to enforce and a fixture that could set it would be testing itself.
 *
 * @param {Array} [seed] @returns {Promise<Object>}
 */
async function reportStore(seed = []) {
  let clock = NOW;
  const base = memoryStore({ now: () => clock });
  for (const r of seed) {
    clock = r.receivedAt instanceof Date ? r.receivedAt.getTime() : r.receivedAt;
    await base.putReport({
      id: r.id, prose: r.prose, image: r.image, signed: r.signed, devicePub: r.devicePub,
    });
  }
  clock = NOW;
  const touched = [];
  const store = {};
  for (const name of Object.keys(base)) {
    const real = base[name];
    store[name] = (...a) => { touched.push(name); return real(...a); };
  }
  store._touched = touched;
  return store;
}

/** The ids the store would show the operator right now, through its own read path. */
async function liveIds(store) {
  const rows = await store.listReports(1000);
  store._touched.pop();                       // this probe is not part of what a route touched
  return rows.map((r) => r.id);
}

/** A real, self-minted P-256 keypair — exactly what the PO's Mac holds. */
async function keypair() {
  const kp = await S.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await S.exportKey('raw', kp.publicKey));
  return { kp, raw, pub: b64u(raw) };
}

/**
 * @param {Object} [over]
 * @param {Array} [seed] report rows the store starts with
 */
async function makeCtx(over = {}, seed = []) {
  const store = over.store === undefined ? await reportStore(seed) : over.store;
  const logged = [];
  const ctx = {
    store,
    now: () => NOW,
    random: (n) => new Uint8Array(n),
    sha256: async (b) => new Uint8Array(await S.digest('SHA-256', b)),
    auth: async () => { throw new Error('an admin route must never call ctx.auth'); },
    assertMember: async () => { throw new Error('an admin route must never call ctx.assertMember'); },
    limits: LIMITS,
    subtle: S,
    log: (e) => logged.push(e),
    ...over,
    store,
  };
  return { ctx, store, logged };
}

/** Build a request, optionally signed by `kp` for the operator key `raw`. */
async function req(method, path, opts = {}) {
  const query = opts.query || {};
  const headers = {
    'x-lzp-protocol': String(PROTOCOL),
    'x-real-ip': opts.ip || '203.0.113.9',
  };
  if (opts.authorization !== undefined) headers.authorization = opts.authorization;
  else if (opts.kp) {
    const ts = String(opts.ts === undefined ? NOW : opts.ts);
    const nonce = opts.nonce || b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    const signOver = opts.signOver || { method, path, sortedQuery: canonicalQuery(query), ts, nonce };
    const bytes = TE.encode(adminSignedString(signOver));
    const sig = b64u(new Uint8Array(await S.sign({ name: 'ECDSA', hash: 'SHA-256' }, opts.kp.privateKey, bytes)));
    headers.authorization = `${ADMIN_SCHEME} ts=${ts}, nonce=${nonce}, sig=${sig}`;
  }
  return {
    method,
    path,
    query,
    headers,
    body: opts.body === undefined ? null : opts.body,
    rawBody: opts.rawBody === undefined ? new Uint8Array(0) : opts.rawBody,
  };
}

/** Drive the shipped router, normalising a throw into the response it would become. */
async function call(ctx, r) {
  try { return await route(ctx, r); } catch (e) { return toResponse(e); }
}

/** The whole happy path in one line: a configured relay and a signed request. */
async function operatorCall(method, path, opts = {}) {
  const { kp, pub } = opts.identity || await keypair();
  const made = opts.ctx || await makeCtx({ reportsAdminPub: pub }, opts.seed || []);
  const r = await req(method, path, { ...opts, kp });
  return { ...made, res: await call(made.ctx, r), pub, kp };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · THE SURFACE
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · four rows, one of them anonymous, none of them space-scoped', () => {
  test('§1a · the table grew exactly the three routes the PO approved', () => {
    assert.equal(ROUTES.length, 27, 'ADR 003 §3\'s 23, plus LZP-1009\'s four');
    const rows = ROUTES.filter((r) => r.pattern.startsWith('/feedback'));
    assert.deepEqual(rows.map((r) => `${r.method} ${r.pattern} ${r.name}`).sort(), [
      'GET /feedback listReports',
      'GET /feedback/:id getReport',
      'POST /feedback feedback',
      'POST /feedback/:id/delete deleteReport',
    ]);
  });

  test('§1b · NONE of the three names a space, so a report still cannot reach a board', () => {
    // The half of the write-only rule that never depended on write-only. A `Report` has no
    // `spaceId` and no relation to `Space`, so these handlers are handed no space id and have no
    // way to obtain one — which is what keeps „eine Rückmeldung kann niemals auf dem Board der
    // Familie erscheinen" a fact about the schema rather than about anybody's care.
    for (const name of ['listReports', 'getReport', 'deleteReport']) {
      assert.equal(name in SPACE_SCOPED, false, `${name} is space-scoped`);
      assert.equal(ROUTES.find((r) => r.name === name).spaceParam, undefined);
    }
    // CODE ONLY — the file's comments discuss spaces at length, which is the point of them.
    for (const fn of [listReports, getReport, deleteReport]) {
      const src = stripCommentsAndStrings(fn.toString());
      for (const forbidden of ['spaceId', 'appendOps', 'getMember', 'assertMember', 'auth']) {
        assert.equal(new RegExp(`\\b${forbidden}\\b`).test(src), false,
          `${fn.name} names \`${forbidden}\``);
      }
    }
  });

  test('§1c · exactly one row on this surface is reachable without a credential', () => {
    // The inverted form of the old §1a. The reversal was about the AUTHENTICATED read-back; a
    // second anonymous row would be a different and much larger decision.
    const anonymous = ROUTES
      .filter((r) => r.pattern.startsWith('/feedback'))
      .filter((r) => !['listReports', 'getReport', 'deleteReport'].includes(r.name));
    assert.deepEqual(anonymous.map((r) => r.name), ['feedback']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · THE CREDENTIAL GRAMMAR — two schemes that cannot be confused
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · LZPADMIN and LZP1 reject each other, in both directions', () => {
  test('§2a · `auth.js#parseAuthorization` throws on an LZPADMIN header', async () => {
    // The claim the design leans on, MEASURED. It is what lets both schemes share one
    // `Authorization` header — and therefore what keeps the shell's four-name outbound header
    // allowlist unchanged, which is a much larger blast radius than a scheme token.
    const { parseAuthorization } = await import('../../server/core/auth.js');
    assert.throws(
      () => parseAuthorization(`${ADMIN_SCHEME} ts=${NOW}, nonce=${b64u(new Uint8Array(16))}, sig=${b64u(new Uint8Array(64))}`),
      (e) => e.status === 401 && e.code === 'bad_auth');
  });

  test('§2b · `parseAdminAuthorization` throws on an LZP1 header', () => {
    assert.throws(
      () => parseAdminAuthorization(`LZP1 device=ABCDEFGHJKMNPQRS, ts=${NOW}, nonce=${b64u(new Uint8Array(16))}, sig=${b64u(new Uint8Array(64))}`),
      (e) => e.status === 401 && e.code === 'bad_auth');
    // and it is the SCHEME that refuses it, not the extra parameter: the same header with the
    // `device=` removed is still refused, because the scheme token is checked first.
    assert.throws(
      () => parseAdminAuthorization(`LZP1 ts=${NOW}, nonce=${b64u(new Uint8Array(16))}, sig=${b64u(new Uint8Array(64))}`),
      (e) => e.code === 'bad_auth');
  });

  test('§2c · strictly three parameters — no extras, no duplicates, no omissions', () => {
    const n = b64u(new Uint8Array(16));
    const g = b64u(new Uint8Array(64));
    const ok = `${ADMIN_SCHEME} ts=${NOW}, nonce=${n}, sig=${g}`;
    assert.deepEqual([...ADMIN_PARAMS], ['ts', 'nonce', 'sig']);
    assert.doesNotThrow(() => parseAdminAuthorization(ok));
    for (const bad of [
      `${ADMIN_SCHEME} ts=${NOW}, nonce=${n}, sig=${g}, device=ABCDEFGHJKMNPQRS`,  // an extra
      `${ADMIN_SCHEME} ts=${NOW}, nonce=${n}, sig=${g}, alg=none`,                  // the classic
      `${ADMIN_SCHEME} ts=${NOW}, ts=${NOW}, nonce=${n}, sig=${g}`,                 // a duplicate
      `${ADMIN_SCHEME} ts=${NOW}, nonce=${n}`,                                      // an omission
      `${ADMIN_SCHEME} ts=${NOW}, nonce=${n}, sig=${g},`,                           // a trailing comma
      `${ADMIN_SCHEME} ts=nicht-eine-zahl, nonce=${n}, sig=${g}`,
      `${ADMIN_SCHEME} ts=${NOW}, nonce=${b64u(new Uint8Array(8))}, sig=${g}`,      // 8-byte nonce
      `${ADMIN_SCHEME} ts=${NOW}, nonce=${n}, sig=${b64u(new Uint8Array(63))}`,     // short sig
      `${ADMIN_SCHEME} ts=${NOW}, nonce=nicht base64url!, sig=${g}`,
      ADMIN_SCHEME,
      undefined,
      42,
    ]) {
      assert.throws(() => parseAdminAuthorization(bad), (e) => e.code === 'bad_auth',
        `accepted: ${String(bad)}`);
    }
  });

  test('§2d · three domain prefixes, pairwise distinct and pairwise non-prefixing', () => {
    // A signature made to DELETE a report must not verify as a sync request or as a report, and
    // vice versa. Prefix-freedom is the property, not mere inequality: one string being a prefix
    // of another is exactly the truncation confusion a length-free format invites.
    const all = [SIGNED_PREFIX, FEEDBACK_PREFIX, REPORTS_PREFIX];
    assert.equal(new Set(all).size, 3);
    assert.equal(REPORTS_PREFIX, 'lzp/reports/v1\n');
    for (const a of all) {
      for (const b of all) {
        if (a === b) continue;
        assert.equal(a.startsWith(b), false, `${JSON.stringify(a)} extends ${JSON.stringify(b)}`);
      }
    }
  });

  test('§2e · the signed string names the METHOD, the PATH and the QUERY, and nothing else', () => {
    const s = adminSignedString({ method: 'get', path: '/api/v1/feedback', sortedQuery: 'a=1', ts: '7', nonce: 'n' });
    assert.equal(s, 'lzp/reports/v1\nGET\n/api/v1/feedback?a=1\n7\nn');
    assert.equal(s.startsWith(REPORTS_PREFIX), true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · THE LADDER
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · 404 with no operator, then 401 for every way of getting it wrong', () => {
  const PATHS = [
    ['GET', `${API_PREFIX}/feedback`],
    ['GET', `${API_PREFIX}/feedback/${rid(1)}`],
    ['POST', `${API_PREFIX}/feedback/${rid(1)}/delete`],
  ];

  test('§3a · AN UNCONFIGURED RELAY ANSWERS 404 — it does not advertise an operator surface', async () => {
    // The state every relay but the PO's is in, including the one deployed today. A 401 here
    // would tell a stranger that the surface was specified; 404 is the same answer `/api/v1/nope`
    // gets, and it is what makes the feature opt-in per deployment.
    const { ctx } = await makeCtx();                            // no reportsAdminPub
    const { kp } = await keypair();
    for (const [method, path] of PATHS) {
      // …and it 404s even for a PERFECTLY SIGNED request, because the key it would be checked
      // against does not exist. There is no credential that opens an unconfigured relay.
      const res = await call(ctx, await req(method, path, { kp }));
      assert.equal(res.status, 404, `${method} ${path} answered ${res.status}`);
      assert.deepEqual(res.body, { error: 'not_found' });
    }
  });

  test('§3b · a configured relay answers 401 to no credential at all', async () => {
    const { pub } = await keypair();
    const { ctx } = await makeCtx({ reportsAdminPub: pub });
    for (const [method, path] of PATHS) {
      const res = await call(ctx, await req(method, path));
      assert.equal(res.status, 401, `${method} ${path} answered ${res.status}`);
      assert.equal(res.body.error, 'bad_auth');
    }
  });

  test('§3c · A FAMILY DEVICE CREDENTIAL IS NOT AN OPERATOR CREDENTIAL', async () => {
    // The row `ADMIN_PROVES_NOT` clause 2 is about. A valid `LZP1` header — any member, any
    // device, any circle — is refused, because these routes never call `ctx.auth` and the scheme
    // token is checked before anything else. `makeCtx`'s `auth` THROWS, so a handler that
    // reached for it would fail loudly rather than quietly succeed.
    const { pub } = await keypair();
    const { ctx } = await makeCtx({ reportsAdminPub: pub });
    const lzp1 = `LZP1 device=ABCDEFGHJKMNPQRS, ts=${NOW}, nonce=${b64u(new Uint8Array(16))}, sig=${b64u(new Uint8Array(64))}`;
    for (const [method, path] of PATHS) {
      const res = await call(ctx, await req(method, path, { authorization: lzp1 }));
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'bad_auth');
    }
  });

  test('§3d · a signature by the WRONG key is 401 bad_signature', async () => {
    const { pub } = await keypair();
    const stranger = await keypair();
    const { ctx, store } = await makeCtx({ reportsAdminPub: pub }, [row()]);
    const res = await call(ctx, await req('GET', `${API_PREFIX}/feedback`, { kp: stranger.kp }));
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'bad_signature');
    assert.equal(store._touched.includes('listReports'), false, 'the store was read anyway');
  });

  test('§3e · a stale timestamp is refused in BOTH directions', async () => {
    const { kp, pub } = await keypair();
    const { ctx } = await makeCtx({ reportsAdminPub: pub });
    const w = LIMITS.authWindowMs;
    for (const [ts, expected] of [
      [NOW + w, 200], [NOW - w, 200],
      [NOW + w + 1, 401], [NOW - w - 1, 401],
    ]) {
      const res = await call(ctx, await req('GET', `${API_PREFIX}/feedback`, { kp, ts }));
      assert.equal(res.status, expected, `ts=${ts - NOW}ms answered ${res.status}`);
      if (expected === 401) assert.equal(res.body.error, 'stale_request');
    }
  });

  test('§3f · a REPLAYED request is refused, on the existing Nonce table', async () => {
    const { kp, pub, raw } = await keypair();
    const { ctx, store } = await makeCtx({ reportsAdminPub: pub }, [row()]);
    const nonce = b64u(new Uint8Array(16).fill(7));
    const first = await req('GET', `${API_PREFIX}/feedback`, { kp, nonce });
    assert.equal((await call(ctx, first)).status, 200);
    const again = await call(ctx, first);            // byte-identical request, replayed
    assert.equal(again.status, 401);
    assert.equal(again.body.error, 'replay');
    // NO SCHEMA CHANGE: the namespace key is the operator key's own deviceShort — the same
    // sixteen Crockford characters `Device.deviceShort` already holds, so nothing new enters the
    // table's alphabet. Asserted rather than assumed, because "no schema change" is the claim.
    const short = await deviceShortOfRaw(raw, ctx);
    assert.match(short, /^[0-9A-HJKMNP-TV-Z]{16}$/);
    assert.equal(store._touched.includes('claimNonce'), true);
  });

  test('§3g · the honest path — a configured relay and a correct signature answers 200', async () => {
    // THE CONTROL. Every row above asserts a refusal; without this one, a handler that refused
    // everything would pass the entire section.
    const { res, store } = await operatorCall('GET', `${API_PREFIX}/feedback`, { seed: [row()] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.reports.length, 1);
    assert.equal(store._touched.includes('listReports'), true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · WHAT THE SIGNATURE BINDS
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · method, path and query are inside the signature; a body cannot exist', () => {
  test('§4a · a signature for one path does not open another', async () => {
    // Without the path in the signed bytes, one intercepted `GET /feedback` would be a licence to
    // DELETE every report in the table — the two requests would carry identical credentials.
    const { kp, pub } = await keypair();
    const { ctx, store } = await makeCtx({ reportsAdminPub: pub }, [row()]);
    const nonce = b64u(new Uint8Array(16).fill(3));
    const forged = await req('POST', `${API_PREFIX}/feedback/${rid(1)}/delete`, {
      kp,
      nonce,
      signOver: { method: 'GET', path: `${API_PREFIX}/feedback`, sortedQuery: '', ts: String(NOW), nonce },
    });
    const res = await call(ctx, forged);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'bad_signature');
    assert.deepEqual(await liveIds(store), [rid(1)], 'THE REPORT WAS DELETED BY A SIGNATURE MADE FOR A READ');
  });

  test('§4b · the METHOD is inside it too', async () => {
    const { kp, pub } = await keypair();
    const { ctx } = await makeCtx({ reportsAdminPub: pub }, [row()]);
    const nonce = b64u(new Uint8Array(16).fill(4));
    const path = `${API_PREFIX}/feedback`;
    const res = await call(ctx, await req('GET', path, {
      kp, nonce, signOver: { method: 'POST', path, sortedQuery: '', ts: String(NOW), nonce },
    }));
    assert.equal(res.status, 401);
  });

  test('§4c · the QUERY is inside it — appending one invalidates the signature', async () => {
    const { kp, pub } = await keypair();
    const { ctx } = await makeCtx({ reportsAdminPub: pub }, [row()]);
    const nonce = b64u(new Uint8Array(16).fill(5));
    const path = `${API_PREFIX}/feedback`;
    const res = await call(ctx, await req('GET', path, {
      kp, nonce, query: { since: '0' },
      signOver: { method: 'GET', path, sortedQuery: '', ts: String(NOW), nonce },
    }));
    assert.equal(res.status, 401, 'a query parameter rode outside the signature');
  });

  test('§4d · NO BODY MAY RIDE ALONG, because there is no body hash to bind it', async () => {
    // `adminSignedString` has no body-hash field. That is safe only because a body is refused
    // outright — a field that cannot be present cannot be unsigned. This is the row that makes
    // the omission a decision rather than a hole.
    const { kp, pub } = await keypair();
    const { ctx, store } = await makeCtx({ reportsAdminPub: pub }, [row()]);
    const res = await call(ctx, await req('POST', `${API_PREFIX}/feedback/${rid(1)}/delete`, {
      kp,
      body: { alsoDelete: 'everything' },
      rawBody: TE.encode(JSON.stringify({ alsoDelete: 'everything' })),
    }));
    assert.equal(res.status, 400);
    assert.equal(res.body.unexpectedField, 'body');
    assert.deepEqual(await liveIds(store), [rid(1)]);
  });

  test('§4e · a malformed report id never becomes a store key', async () => {
    // `router.js#segmentsOf` stops traversal and separators; the SHAPE is this handler's job,
    // because this handler is what turns the segment into a key. Same reasoning as
    // `auth.js#parseAuthorization`'s value checks.
    const { kp, pub } = await keypair();
    const { ctx, store } = await makeCtx({ reportsAdminPub: pub }, [row()]);
    assert.equal(REPORT_ID_RE.test(rid(1)), true, 'the fixture does not match the shipped shape');
    for (const bad of ['x', 'rep_', 'rep_short', `rep_${'A'.repeat(23)}`, 'mem_AAAAAAAAAAAAAAAAAAAAAA', '%2e%2e']) {
      const res = await call(ctx, await req('GET', `${API_PREFIX}/feedback/${bad}`, { kp }));
      assert.ok(res.status === 400 || res.status === 404, `${bad} answered ${res.status}`);
    }
    assert.equal(store._touched.includes('getReport'), false, 'a malformed id reached the store');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · THE BUDGET
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§5 · metered on the commit that adds the routes, and spent FIRST', () => {
  test('§5a · both rules exist, are IP-keyed and PRE-AUTH, and cover all three routes', () => {
    for (const name of ['reportsRead', 'reportsDelete']) {
      const rule = RATE_RULES[name];
      assert.ok(rule, `${name} has no rate rule at all`);
      assert.equal(rule.identity, 'ip');
      assert.equal(rule.phase, 'pre-auth');
      assert.equal(rule.windowMs, 3600000);
    }
    assert.deepEqual([...RATE_COVERAGE.listReports.pre], ['reportsRead']);
    assert.deepEqual([...RATE_COVERAGE.getReport.pre], ['reportsRead']);
    assert.deepEqual([...RATE_COVERAGE.deleteReport.pre], ['reportsDelete']);
    for (const n of ['listReports', 'getReport', 'deleteReport']) {
      assert.equal(RATE_COVERAGE[n].why, null, `${n} carries a \`why\` instead of a rule`);
    }
  });

  test('§5b · RATE_COVERAGE enumerates ROUTE_NAMES in BOTH directions', () => {
    // `limits.js`'s RATE_COVERAGE docblock claims this gate exists. When the second pass looked,
    // NOTHING RAN IT — `limits.test.js` does not import RATE_COVERAGE at all, and the bidirectional
    // enumeration was a sentence about a test rather than a test. It runs here now, which is what
    // makes "a new route cannot compile past the suite without an answer to 'what stops someone
    // calling it a million times'" true for the first time.
    assert.deepEqual(Object.keys(RATE_COVERAGE).sort(), [...ROUTE_NAMES].sort(),
      'RATE_COVERAGE and the route table disagree about which routes exist');
    for (const [name, cov] of Object.entries(RATE_COVERAGE)) {
      for (const r of [...cov.pre, ...cov.post]) {
        assert.ok(RATE_RULES[r], `${name} names the rule \`${r}\`, which is not in RATE_RULES`);
      }
      assert.ok(cov.pre.length + cov.post.length > 0 || typeof cov.why === 'string',
        `${name} has neither a limiter nor a stated reason for not having one`);
    }
  });

  test('§5c · THE BUDGET IS SPENT ABOVE THE 404, WHICH IS ABOVE THE VERIFY', async () => {
    // The ordering IS the control, and this is the sharpest way to see it: drive a relay with NO
    // operator configured, where every request 404s and no signature is ever checked. If the
    // budget were charged after the 404 gate, an anonymous flood against an unconfigured relay
    // would be free — and it would still be a database round trip per request.
    const { ctx } = await makeCtx();                            // unconfigured on purpose
    for (let i = 0; i < LIMITS.reportsReadPerIpHour; i++) {
      assert.equal((await call(ctx, await req('GET', `${API_PREFIX}/feedback`))).status, 404);
    }
    const over = await call(ctx, await req('GET', `${API_PREFIX}/feedback`));
    assert.equal(over.status, 429, 'the 404 is answered before the budget is charged — a probe is free');
    assert.equal(over.headers['Retry-After'], '3600');
  });

  test('§5d · the READ budget and the DELETE budget are separate buckets', async () => {
    // Two rules and not one, so a flood of unauthenticated reads cannot spend the budget the one
    // honest caller needs to CLEAR a report. A refused read is a screen he reloads; a refused
    // delete is a report he cannot get rid of, and 90-day expiry gives that failure a floor
    // measured in months.
    const { kp, pub } = await keypair();
    const { ctx, store } = await makeCtx({ reportsAdminPub: pub }, [row()]);
    for (let i = 0; i < LIMITS.reportsReadPerIpHour; i++) {
      await call(ctx, await req('GET', `${API_PREFIX}/feedback`, { kp }));
    }
    assert.equal((await call(ctx, await req('GET', `${API_PREFIX}/feedback`, { kp }))).status, 429);
    const del = await call(ctx, await req('POST', `${API_PREFIX}/feedback/${rid(1)}/delete`, { kp }));
    assert.equal(del.status, 200, 'the read flood spent the delete budget');
    assert.deepEqual(await liveIds(store), []);
  });

  test('§5e · two IPs have two budgets', async () => {
    const { ctx } = await makeCtx();
    for (let i = 0; i < LIMITS.reportsReadPerIpHour; i++) {
      await call(ctx, await req('GET', `${API_PREFIX}/feedback`, { ip: '203.0.113.9' }));
    }
    assert.equal((await call(ctx, await req('GET', `${API_PREFIX}/feedback`, { ip: '203.0.113.9' }))).status, 429);
    assert.equal((await call(ctx, await req('GET', `${API_PREFIX}/feedback`, { ip: '198.51.100.4' }))).status, 404,
      'the bucket is not keyed on the IP at all');
  });

  test('§5f · both numbers are recorded in LIMIT_EXTENSIONS with a stated reason', () => {
    for (const name of ['reportsReadPerIpHour', 'reportsDeletePerIpHour']) {
      const e = LIMIT_EXTENSIONS.find((x) => x.name === name);
      assert.ok(e, `${name} is a limit with no recorded reason`);
      assert.match(e.tag, /^E10-L\d+$/);
      assert.ok(e.reason.length > 400, `${e.tag}'s reason is a label, not a reason`);
      assert.equal(LIMITS[name], e.value);
      assert.equal(RATE_RULES[name === 'reportsReadPerIpHour' ? 'reportsRead' : 'reportsDelete'].limit, name);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 · THE STORE
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§6 · three report methods, the limiter, the nonce — and nothing space-shaped', () => {
  /** A store that throws the moment anything outside the allowlist is READ. */
  async function hostileStore(allow, record, seed = []) {
    const real = await reportStore(seed);
    return new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        const name = String(prop);
        if (allow.includes(name)) {
          return (...a) => { record.push(name); return real[name](...a); };
        }
        throw new Error(`an admin route reached ctx.store.${name} — that is not on its contract`);
      },
    });
  }

  const ALLOWED = ['rateAllow', 'claimNonce', 'listReports', 'getReport', 'deleteReport'];

  test('§6a · a full admin session touches ONLY the five allowed members', async () => {
    const seen = [];
    const { kp, pub } = await keypair();
    const ctx = (await makeCtx({ reportsAdminPub: pub, store: await hostileStore(ALLOWED, seen, [row()]) })).ctx;
    assert.equal((await call(ctx, await req('GET', `${API_PREFIX}/feedback`, { kp }))).status, 200);
    assert.equal((await call(ctx, await req('GET', `${API_PREFIX}/feedback/${rid(1)}`, { kp }))).status, 200);
    assert.equal((await call(ctx, await req('POST', `${API_PREFIX}/feedback/${rid(1)}/delete`, { kp }))).status, 200);
    assert.deepEqual([...new Set(seen)].sort(),
      ['claimNonce', 'deleteReport', 'getReport', 'listReports', 'rateAllow']);
  });

  test('§6b · ARMED — the hostile store really does throw on anything else', async () => {
    const store = await hostileStore(ALLOWED, []);
    assert.throws(() => store.appendOps, /not on its contract/);
    assert.throws(() => store.getMember, /not on its contract/);
    assert.throws(() => store.putReport, /not on its contract/, 'a HANDLER may never write a report');
    assert.doesNotThrow(() => store.listReports);
  });

  test('§6c · a store that cannot keep reports answers 501, AFTER the credential', async () => {
    // Honest rather than 500, and the ORDER matters: an unauthenticated caller must not learn how
    // this relay is provisioned, so the 501 sits below the verify.
    const { kp, pub } = await keypair();
    // The shipped store with the four report methods REMOVED — a relay whose adapter predates
    // the `Report` model, which is the state every deployment is in until the migration runs.
    const full = memoryStore({ now: () => NOW });
    const bare = {};
    for (const name of Object.keys(full)) {
      if (['putReport', 'listReports', 'getReport', 'deleteReport'].includes(name)) continue;
      bare[name] = full[name];
    }
    const { ctx } = await makeCtx({ reportsAdminPub: pub, store: bare });
    const good = await call(ctx, await req('GET', `${API_PREFIX}/feedback`, { kp }));
    assert.equal(good.status, 501);
    assert.equal(good.body.error, 'not_implemented');
    assert.equal(good.body.route, 'listReports');
    const anon = await call(ctx, await req('GET', `${API_PREFIX}/feedback`));
    assert.equal(anon.status, 401, 'an unauthenticated caller was told how the relay is provisioned');
  });

  test('§6d · every method the handlers call is DECLARED in STORE_REQUIREMENTS, and vice versa', () => {
    // `server/core/store-interface.js` is not this ticket's file. The contract is therefore
    // published here and checked against the call sites, so the store agent has an exact list and
    // a later handler cannot start calling a sixth method without declaring it.
    const declared = STORE_REQUIREMENTS.map((r) => r.name).sort();
    assert.deepEqual(declared, ['deleteReport', 'getReport', 'listReports']);
    for (const r of STORE_REQUIREMENTS) {
      assert.ok(r.shape.length > 20 && r.contract.length > 40 && r.absent.length > 20, r.name);
    }
    const raw = [listReports, getReport, deleteReport].map((f) => f.toString()).join('\n');
    const code = stripCommentsAndStrings(raw);
    const called = new Set();
    // Two call shapes, and the second one has to be read off the RAW source because the method
    // name is a STRING LITERAL that `stripCommentsAndStrings` blanks — which is the correct
    // behaviour for a gate about code and the wrong input for a gate about a name.
    for (const m of code.matchAll(/store\.([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[1]);
    for (const m of raw.matchAll(/requireStore\s*\(\s*ctx\s*,\s*'([^']+)'/g)) called.add(m[1]);
    assert.deepEqual([...called].sort(), declared,
      'a handler calls a store method it does not declare, or declares one it does not call');
    // and `putReport` is NOT among them: a report is written by the SINK, never by a handler.
    assert.equal(called.has('putReport'), false);
    assert.equal(/putReport/.test(raw), false);
  });

  test('§6e · expiry is enforced at READ, not only by the sweep', async () => {
    // The 90-day half of the PO's retention decision, from the side this file owns. Vercel Hobby
    // has no cron, so the sweep is lazy — which means a row can be past its `expiresAt` and still
    // present when a request arrives. `getPairSession` and `consumeInvite` already treat theirs
    // this way; the store contract in STORE_REQUIREMENTS says so, and this row is what would go
    // red if an adapter shipped a sweep without the read check.
    const fresh = row({ id: rid(1), receivedAt: new Date(NOW - DAY) });
    // 91 days old, so the store's own stamp puts `expiresAt` a day in the past. The fixture
    // cannot set `expiresAt` — `putReport` refuses it — which is exactly the property being
    // relied on: the 90 days belongs to the store.
    const stale = row({ id: rid(2), receivedAt: new Date(NOW - 91 * DAY) });
    const { res, store } = await operatorCall('GET', `${API_PREFIX}/feedback`, { seed: [fresh, stale] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.reports.map((r) => r.id), [rid(1)]);
    assert.deepEqual(await liveIds(store), [rid(1)], 'the expired row survived the list');
  });

  test('§6f · a delete is IDEMPOTENT — the second press is a 200, not an error', async () => {
    const { kp, pub } = await keypair();
    const { ctx, store } = await makeCtx({ reportsAdminPub: pub }, [row()]);
    const first = await call(ctx, await req('POST', `${API_PREFIX}/feedback/${rid(1)}/delete`, { kp }));
    assert.equal(first.status, 200);
    assert.equal(first.body.deleted, true);
    const second = await call(ctx, await req('POST', `${API_PREFIX}/feedback/${rid(1)}/delete`, { kp }));
    assert.equal(second.status, 200);
    assert.equal(second.body.deleted, false, 'a second delete errors — there is nothing for him to do differently');
    assert.deepEqual(await liveIds(store), []);
  });

  test('§6g · the list carries no image bytes, and one report does', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const pubRaw = globalThis.crypto.getRandomValues(new Uint8Array(65));
    const seed = [row({ image: png, signed: true, devicePub: pubRaw })];
    const { ctx, kp } = await operatorCall('GET', `${API_PREFIX}/feedback`, { seed });
    const list = await call(ctx, await req('GET', `${API_PREFIX}/feedback`, { kp }));
    assert.equal(list.body.reports[0].hasImage, true);
    assert.equal('image' in list.body.reports[0], false, 'the LIST carried image bytes');
    const one = await call(ctx, await req('GET', `${API_PREFIX}/feedback/${rid(1)}`, { kp }));
    assert.equal(one.status, 200);
    assert.deepEqual([...ub64(one.body.report.image)], [...png]);
    assert.equal(one.body.report.signed, true);
    assert.equal(one.body.report.devicePub, b64u(pubRaw),
      'the thread handle is not the 65 raw bytes the column holds, base64url-encoded');
    assert.equal(one.body.report.prose, seed[0].prose, 'her sentence is not returned verbatim');
  });

  test('§6h · an unsigned report reports NO devicePub, on both routes', async () => {
    // An unsigned report has no thread handle, and inventing one — echoing a null as an empty
    // string, say — would put a "device" beside a report nobody signed.
    // The column filled while `signed` is false — the shape a second writer could produce.
    const seed = [row({ signed: false, devicePub: new Uint8Array(65).fill(9) })];
    const { ctx, kp } = await operatorCall('GET', `${API_PREFIX}/feedback`, { seed });
    const list = await call(ctx, await req('GET', `${API_PREFIX}/feedback`, { kp }));
    assert.equal(list.body.reports[0].devicePub, null);
    const one = await call(ctx, await req('GET', `${API_PREFIX}/feedback/${rid(1)}`, { kp }));
    assert.equal(one.body.report.devicePub, null);
  });

  test('§6i · a missing report is 404 and says nothing else', async () => {
    const { res } = await operatorCall('GET', `${API_PREFIX}/feedback/${rid(9)}`, { seed: [row()] });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'not_found' });
  });

  test('§6j · the list is capped and says so', async () => {
    const many = Array.from({ length: MAX_LIST_ROWS + 5 },
      (_, i) => row({ id: `rep_${String(i).padStart(22, 'B')}`, receivedAt: NOW - i * 1000 }));
    const { res } = await operatorCall('GET', `${API_PREFIX}/feedback`, { seed: many });
    assert.equal(res.body.reports.length, MAX_LIST_ROWS);
    assert.equal(res.body.more, true);
    // newest first, so the cap drops the OLDEST rather than the ones he has not read.
    assert.equal(res.body.reports[0].receivedAt > res.body.reports[1].receivedAt, true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7 · THE WIRING, AND THE SENTENCES ON THE WIRE
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§7 · declared where the handler is, and honest on the wire', () => {
  test('§7a · the ctx member is declared by the handler and spread into REQUIRED_CTX', () => {
    const local = CTX_EXTENSIONS.find((c) => c.name === 'reportsAdminPub');
    const wired = REQUIRED_CTX.find((c) => c.name === 'reportsAdminPub');
    assert.ok(local && wired, 'the operator key is not declared where a host can find it');
    assert.equal(wired, local, 'REQUIRED_CTX carries a HAND-COPIED entry, which can drift');
    assert.equal(wired.optional, true, 'a relay without an operator would stop booting');
    assert.match(wired.absent, /404/);
  });

  test('§7b · HANDLER_OWNERS names one file, and the bindings really are its exports', async () => {
    const mod = await import('../../server/core/handlers/reports.js');
    for (const name of ['listReports', 'getReport', 'deleteReport']) {
      assert.equal(HANDLER_OWNERS[name], 'handlers/reports.js');
      assert.equal(handlers[name], mod[name], `${name} is bound to a different file's function`);
      assert.ok(ROUTE_NAMES.includes(name));
    }
    // …and `feedback` still comes from the OTHER file. The split is what keeps
    // `tests/server/feedback.test.js` §4 meaningful: the write path and the read path have
    // different imports, so storage cannot leak into the handler that must not have it.
    assert.equal(HANDLER_OWNERS.feedback, 'handlers/feedback.js');
  });

  test('§7c · ADMIN_PROVES and ADMIN_PROVES_NOT ride on every successful answer', async () => {
    const { ctx, kp } = await operatorCall('GET', `${API_PREFIX}/feedback`, { seed: [row()] });
    for (const [method, path] of [
      ['GET', `${API_PREFIX}/feedback`],
      ['GET', `${API_PREFIX}/feedback/${rid(1)}`],
      ['POST', `${API_PREFIX}/feedback/${rid(1)}/delete`],
    ]) {
      const res = await call(ctx, await req(method, path, { kp }));
      assert.equal(res.status, 200, `${method} ${path}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.proves, ADMIN_PROVES.operator);
      assert.deepEqual(res.body.provesNot, ADMIN_PROVES_NOT);
    }
  });

  test('§7d · THE PLATFORM CLAUSE IS ON THE WIRE, FIRST, AND IN THOSE WORDS', () => {
    // The PO asked for this by name. The credential does NOT defend against whoever can set the
    // relay's environment variables — they can read the database directly, and they can replace
    // the operator key with one of their own. A control that pretends otherwise is worse than no
    // control, because somebody plans around it.
    assert.ok(ADMIN_PROVES_NOT.length >= 5, 'the demotions were trimmed');
    assert.match(ADMIN_PROVES_NOT[0], /PLATFORM/);
    assert.match(ADMIN_PROVES_NOT[0], /read its database directly/);
    assert.match(ADMIN_PROVES_NOT[0], /not against Vercel/);
    const joined = ADMIN_PROVES_NOT.join(' ');
    assert.match(joined, /never call ctx\.auth/, 'the family-credential demotion is missing');
    assert.match(joined, /Member\.role/, 'the "this is not a role" demotion is missing');
    assert.match(joined, /devicePub is byte-identical/, 'the joinability disclosure is missing');
    assert.match(joined, /404/, 'the "a configured relay is distinguishable" demotion is missing');
  });

  test('§7e · the log line names the ROUTE and the status, and never her prose', () => {
    // ADR 003 §6.2's seven-field allowlist, on the one surface that carries a person's sentences
    // in a response body. Asserted over the SOURCE as well as over a run, because the failure is
    // a debug statement somebody adds later.
    const src = [listReports, getReport, deleteReport].map((f) => f.toString()).join('\n');
    for (const bad of ['prose', 'devicePub', 'r.image', 'row.image']) {
      assert.equal(new RegExp(`ctx\\.log\\([^)]*${bad.replace('.', '\\.')}`).test(src), false,
        `a log call names \`${bad}\``);
    }
  });

  test('§7f · a run really produces only allowlisted log fields', async () => {
    const { logged } = await operatorCall('GET', `${API_PREFIX}/feedback`, { seed: [row()] });
    assert.equal(logged.length, 1);
    assert.deepEqual(Object.keys(logged[0]).sort(), ['route', 'status']);
    assert.equal(JSON.stringify(logged[0]).includes('Balken'), false,
      'her sentence reached a log line — story 21.3 is defeated by a debug statement');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §8 · PRINCIPLE 10 — THE BOARD IS NOT A MESSENGER, AND NEITHER IS THIS
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§8 · there is no reply path, and there is no way to grow one quietly', () => {
  test('§8a · the operator surface is READ and DELETE. There is no route that writes prose', () => {
    // The one thing a reader would expect an inbox to have and this one must never have. A reply
    // route would make the relay a messenger and the report path a conversation — Principle 10,
    // and the reason `charsPerFeedbackText`'s own extension entry says a longer report "is a
    // conversation, and this endpoint deliberately has no reply channel for one".
    const writes = ROUTES.filter((r) => r.method === 'POST' && r.pattern.startsWith('/feedback'));
    assert.deepEqual(writes.map((r) => r.pattern).sort(), ['/feedback', '/feedback/:id/delete'],
      'a POST appeared on the feedback surface that is neither the report nor the deletion');
  });

  test('§8b · no admin handler reads a body at all', () => {
    // Structural, not careful: `requireOperator` refuses a non-empty `rawBody` (§4d), and none of
    // the three handlers so much as names `req.body`. A reply would need one of the two.
    const src = [listReports, getReport, deleteReport].map((f) => stripCommentsAndStrings(f.toString())).join('\n');
    for (const forbidden of ['req.body', 'readSignedBody', 'reply', 'message', 'notify', 'sendTo']) {
      assert.equal(src.includes(forbidden), false, `an admin handler names \`${forbidden}\``);
    }
  });

  test('§8c · nothing in this module makes an outbound call', () => {
    const src = stripCommentsAndStrings([listReports, getReport, deleteReport]
      .map((f) => f.toString()).join('\n'));
    for (const re of [/\bfetch\s*\(/, /XMLHttpRequest/, /\bimport\s*\(/]) {
      assert.equal(re.test(src), false, `an admin handler reaches out: ${re}`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §9 · THE MUTANTS — each names the row that dies, plus the honest-path control
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// This project's standing method: a one-line edit to the shipped source, and the row that must go
// red when it is made.
//
// ██ EVERY KILL SET BELOW WAS MEASURED, NOT REASONED. ██ Each mutation was applied to
// `server/core/handlers/reports.js`, this file was run, the failing rows were recorded, and the
// source was restored. Two labels were CORRECTED by doing that (§9a's first draft mutated the
// budget into the 404 branch, which is behaviour-preserving and killed nothing; §9g's first draft
// predicted §6b, which does not depend on the handler at all), and two rows were added because a
// mutation of the wire conversion had no named home (§9i, §9j). Sets are stated in full so a
// reader can see how much of the file each defect actually reaches.

describe('§9 · what each defect would kill', () => {
  test('§9a · M1 — charge the budget below the 404 gate ⇒ §5c, §5e, §9a (MEASURED)', async () => {
    // §5c is the row that distinguishes "there is a limiter" from "the limiter runs first". §5d
    // stays GREEN under both M1 and M1b — a configured relay still 429s on the 121st read — which
    // is exactly why the ordering needs its own row on an UNCONFIGURED relay.
    //
    // M1b (charge the budget below the VERIFY instead) kills the same three, which is the honest
    // reading: on this route "before the 404" and "before the verify" are one decision, because
    // the 404 sits above the verify.
    const src = listReports.toString();
    const enforceAt = src.indexOf('enforceFor') >= 0 ? src.indexOf('enforceFor') : src.indexOf('requireOperator');
    assert.ok(enforceAt >= 0);
    const { ctx } = await makeCtx();
    for (let i = 0; i < LIMITS.reportsReadPerIpHour; i++) await call(ctx, await req('GET', `${API_PREFIX}/feedback`));
    assert.equal((await call(ctx, await req('GET', `${API_PREFIX}/feedback`))).status, 429);
  });

  test('§9b · M2 — answer 401 instead of 404 with no operator ⇒ §3a, §5c, §5e, §9b (MEASURED)', async () => {
    // A 401 would tell every prober on the internet that this relay has an operator surface at
    // all. §3b stays green — a CONFIGURED relay still 401s — which is why the two are separate
    // rows and why §3a signs its probe request properly.
    const { ctx } = await makeCtx();
    const { kp } = await keypair();
    assert.equal((await call(ctx, await req('GET', `${API_PREFIX}/feedback`, { kp }))).status, 404);
  });

  test('§9c · M3 — drop the path from the signed bytes ⇒ §2e, §4a, §4b, §4c, §9c (MEASURED)', async () => {
    // The most dangerous mutation here: without the path, one intercepted read credential deletes
    // the inbox. §3g (the honest path) stays green under it, which is exactly why §4a exists.
    const s = adminSignedString({ method: 'GET', path: '/api/v1/feedback', sortedQuery: '', ts: '1', nonce: 'n' });
    assert.ok(s.includes('/api/v1/feedback'), 'the path is no longer inside the signature');
    assert.ok(s.includes('GET'), 'the method is no longer inside the signature');
  });

  test('§9d · M4 — accept a body on an admin route ⇒ §4d, §9d (MEASURED)', async () => {
    const { kp, pub } = await keypair();
    const { ctx, store } = await makeCtx({ reportsAdminPub: pub }, [row()]);
    const res = await call(ctx, await req('POST', `${API_PREFIX}/feedback/${rid(1)}/delete`, {
      kp, rawBody: TE.encode('{"x":1}'),
    }));
    assert.equal(res.status, 400);
    assert.deepEqual(await liveIds(store), [rid(1)]);
  });

  test('§9e · M5 — skip claimNonce ⇒ §3f, §6a, §9e (MEASURED)', async () => {
    const { kp, pub } = await keypair();
    const { ctx } = await makeCtx({ reportsAdminPub: pub }, [row()]);
    const r = await req('GET', `${API_PREFIX}/feedback`, { kp, nonce: b64u(new Uint8Array(16).fill(9)) });
    assert.equal((await call(ctx, r)).status, 200);
    assert.equal((await call(ctx, r)).status, 401);
  });

  test('§9f · M6 — treat a verify failure as anonymous-but-allowed ⇒ §3d, §4a, §4b, §4c, §9f (MEASURED)', async () => {
    const { pub } = await keypair();
    const stranger = await keypair();
    const { ctx, store } = await makeCtx({ reportsAdminPub: pub }, [row()]);
    const res = await call(ctx, await req('POST', `${API_PREFIX}/feedback/${rid(1)}/delete`, { kp: stranger.kp }));
    assert.equal(res.status, 401);
    assert.deepEqual(await liveIds(store), [rid(1)], 'A STRANGER DELETED A REPORT');
  });

  test('§9g · M7 — let a handler write a report ⇒ §5d, §6a, §6d, §6e, §6g, §9g, §9h (MEASURED)', () => {
    // "Let us keep a copy" is the well-meaning edit; here it would be `store.putReport` inside a
    // handler, which is how storage migrates out of the sink and back into the request path — and
    // `feedback.test.js` §4's hostile store would still be green, because it guards the OTHER
    // file. This is the widest kill set in the section, which is the right shape: a handler that
    // writes is visible from seven directions.
    //
    // ⚠ THE FIRST DRAFT OF THIS LABEL SAID "§6b", AND RUNNING IT SAID OTHERWISE. §6b is the
    // arming row for the hostile store and does not touch a handler at all, so it cannot die to a
    // handler mutation. `§6a` is the row that does.
    const src = [listReports, getReport, deleteReport].map((f) => f.toString()).join('\n');
    assert.equal(/putReport/.test(src), false);
  });

  test('§9i · M8 — echo devicePub on an UNSIGNED report ⇒ §6h (MEASURED)', () => {
    // The narrowest mutant here and the one most likely to be written by accident: passing the
    // column through instead of gating it on `signed`. It would put a "device" beside a report
    // nobody signed, against `PROVES.unsigned` ("nothing at all").
    const src = stripCommentsAndStrings([listReports, getReport, deleteReport]
      .map((f) => f.toString()).join('\n'));
    assert.equal(/devicePub/.test(src), false,
      'the conversion moved into a handler — §6h now guards a different function');
  });

  test('§9j · M9 — put the image bytes in the LIST ⇒ §6g (MEASURED)', () => {
    // Not a security defect and still a real one: opening the screen would pull up to 256 KB per
    // report over whatever connection he is on, which is the reason the picture is lazy.
    assert.equal(MAX_LIST_ROWS, 200, 'the page size changed without its reasoning being revisited');
  });

  test('§9h · THE HONEST-PATH CONTROL — the whole feature works end to end', async () => {
    // Without this row, a handler that answered 401 to everything would pass every mutant above.
    // One relay, one operator, one report: list it, read it with its picture, delete it, and see
    // the inbox empty — through the SHIPPED router, over the SHIPPED limiter and nonce table.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 42]);
    const { kp, pub } = await keypair();
    const { ctx, store } = await makeCtx({ reportsAdminPub: pub }, [
      row({ id: rid(1), image: png, prose: 'Ich komme nicht mehr rein.' }),
      row({ id: rid(2), receivedAt: NOW - 2 * DAY, prose: 'Der Balken springt zurück.' }),
    ]);

    const list = await call(ctx, await req('GET', `${API_PREFIX}/feedback`, { kp }));
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.reports.map((r) => r.id), [rid(1), rid(2)]);
    assert.equal(list.body.more, false);
    assert.equal(list.body.reports[0].prose, 'Ich komme nicht mehr rein.');

    const one = await call(ctx, await req('GET', `${API_PREFIX}/feedback/${rid(1)}`, { kp }));
    assert.equal(one.status, 200);
    assert.deepEqual([...ub64(one.body.report.image)], [...png]);

    const del = await call(ctx, await req('POST', `${API_PREFIX}/feedback/${rid(1)}/delete`, { kp }));
    assert.equal(del.status, 200);
    assert.equal(del.body.deleted, true);

    const after = await call(ctx, await req('GET', `${API_PREFIX}/feedback`, { kp }));
    assert.deepEqual(after.body.reports.map((r) => r.id), [rid(2)]);
    assert.deepEqual(await liveIds(store), [rid(2)]);
  });
});
