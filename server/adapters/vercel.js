// server/adapters/vercel.js — the ONLY Vercel-aware file.  ADR 005 §1.6 · ADR 003 §9 · LZP-207.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
//  THIS FILE CANNOT BE FULLY EXERCISED ON THIS MACHINE. There is no Vercel account here.
// ─────────────────────────────────────────────────────────────────────────────────────────────
// It follows the discipline `server/adapters/prisma.js` established for the same situation: the
// pure parts are exported and tested, the platform-dependent parts are named in
// `UNVERIFIED_CLAIMS` with the consequence of each being wrong, and nothing pretends to be
// verified that is not. `tests/server/blindness.test.js` asserts that every `U-` tag used in a
// comment here appears in that list and vice versa, so the list cannot rot.
//
// ADR 003 §9: **"A bug in it cannot be a bug in a handler."** Everything below is normalisation
// — bytes in, bytes out — plus the `ctx` construction. There is no protocol logic here; the 27
// handlers are reached through `server/core/handlers/index.js`, which is the same entry point
// `server/dev-server.mjs` and `tests/server/version.test.js`'s compat harness use.
//
// WHY THE RAW BODY IS READ FROM THE STREAM AND `req.body` IS NEVER TOUCHED (U-RAWBODY).
// ADR 003 §2 signs `SHA-256(rawBody)`. `auth.js`'s `readSignedBody` therefore parses the bytes
// that were signed and refuses a request that arrives with a parsed body and no bytes
// (`bad_auth { detail: 'body_without_rawbody' }`). A host that handed the handler a body its
// own parser produced — a duplicate JSON key, a `__proto__`, a number that does not round-trip —
// would be handing a handler data nobody signed. So this file buffers the stream itself and
// leaves `req.body` alone. If the platform has already consumed the stream, the result is an
// empty `rawBody`, every authenticated request answers 401, and the failure is loud on the first
// request rather than exploitable on some later one. That is the fail-closed direction.

import { fail, toResponse } from '../core/errors.js';
import { versionHeaders } from '../core/version.js';
import { LIMITS, createLog } from '../core/limits.js';
import { createHandlers, assertCtx } from '../core/handlers/index.js';
import { prismaStore, createPrismaClient } from './prisma.js';

/**
 * What this file asserts about a platform nobody here can run, and what breaks if each is wrong.
 * The PO closes these by deploying once and reading `docs/v2/E2-VERIFICATION.md` §"Owed to the PO".
 */
export const UNVERIFIED_CLAIMS = Object.freeze([
  Object.freeze({
    tag: 'U-RAWBODY',
    claim:
      'The Node request reaching this handler is an unconsumed stream, so buffering it here '
      + 'yields the exact bytes the client signed.',
    breaks:
      'If the platform buffered and parsed the body first, `rawBody` is empty, `signedBytes` '
      + 'hashes nothing, and EVERY authenticated request answers 401 bad_signature. Loud, '
      + 'immediate, and safe — but a total outage until `export const config` below is honoured.',
    closedBy: 'one authenticated POST /api/v1/ops against the deployed function returning 200',
  }),
  Object.freeze({
    tag: 'U-VERCELIP',
    claim:
      'Vercel\'s edge sets `x-vercel-forwarded-for` to the real client address and overwrites a '
      + 'client-supplied copy of it.',
    breaks:
      'Every per-IP limiter (spaceCreate, inviteRedeem, pairGet, pairRidMiss, deviceRegister, '
      + 'deviceAdopt) becomes bypassable by sending your own header. `limits.js`\'s trust order '
      + 'degrades header by header and then to the shared `?` bucket, so a MISSING header can '
      + 'only put a caller in the most contended bucket — but a FORGED and trusted one gives '
      + 'them a private budget per request.',
    closedBy: 'curl with a forged `x-vercel-forwarded-for` against the deployed function, then reading the RateBucket rows',
  }),
  Object.freeze({
    tag: 'U-HEADERS',
    claim:
      '`vercel.json`\'s `headers` block and the headers written by `res.writeHead` here are '
      + 'merged rather than one replacing the other.',
    breaks:
      'Either Cache-Control: no-store or X-LZP-Protocol goes missing. The first puts encrypted '
      + 'op batches in an intermediary cache; the second makes a 426 a wall instead of a signpost '
      + '(ADR 003 §4 requires the window on EVERY response, errors included).',
    closedBy: 'RELEASE §7.4\'s smoke test reading the response headers of GET /api/v1/meta and of a deliberate 404',
  }),
  Object.freeze({
    tag: 'U-COLD',
    claim:
      'A warm invocation reuses the module scope, so `createPrismaClient()`\'s globalThis '
      + 'singleton really is one client per instance rather than one per request.',
    breaks:
      'Connection exhaustion on a free-tier Postgres — risk R3. `prisma.js` carries the same '
      + 'claim as U-* of its own; this entry exists because THIS file is where the client is '
      + 'built, and a per-request `new PrismaClient()` written here would defeat it.',
    closedBy: 'watching the connection count in the Prisma console during RELEASE §7.4\'s smoke test',
  }),
  Object.freeze({
    tag: 'U-ADMINENV',
    claim:
      'An environment variable set in the Vercel project dashboard (LZP_REPORTS_ADMIN_PUB) is '
      + 'present in `process.env` inside this function, on every invocation, warm or cold.',
    breaks:
      'All three LZP-1009 admin routes answer 404 not_found — `handlers/reports.js` treats an '
      + 'absent key as "this relay has no operator" and refuses to advertise the surface. The '
      + 'admin screen on the PO\'s Mac then shows an empty inbox forever while reports keep '
      + 'arriving and expiring after 90 days unread. Silent in the wrong direction, which is why '
      + 'it is listed: nothing in CI can distinguish "no operator configured" from "the platform '
      + 'did not hand us the variable".',
    closedBy: 'one signed GET /api/v1/feedback against the deployed function answering 200 rather than 404',
  }),
]);

/**
 * Vercel's Node.js runtime, and body parsing OFF.
 *
 * The runtime must be Node and not Edge: `@prisma/client` needs it. The body parser must be off
 * for U-RAWBODY. Both are stated here rather than in `vercel.json` so they sit next to the code
 * whose correctness depends on them.
 */
export const config = {
  runtime: 'nodejs',
  api: { bodyParser: false },
};

/** Max bytes buffered from the request stream before the connection is refused. ADR 003 §6.1. */
const MAX_BODY = LIMITS.bytesPerRequest;

/** IPv4/IPv6 text, same alphabet `limits.js` accepts. A host must not widen it. */
const IP_TEXT_RE = /^[0-9A-Fa-f:.[\]]{1,45}$/;

/**
 * Buffer the request body, refusing early rather than allocating and then complaining.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Uint8Array>}
 */
export function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let refused = false;
    req.on('data', (c) => {
      size += c.length;
      // Stop BUFFERING at the cap; keep draining, because destroying the socket mid-request
      // turns a clean 413 into a connection reset the client cannot tell from a network fault.
      if (size <= MAX_BODY) chunks.push(c);
      else refused = true;
    });
    req.on('end', () => {
      if (refused) { reject(fail('payload_too_large')); return; }
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });
    req.on('error', () => reject(fail('bad_request')));
  });
}

/**
 * Normalise a Node request into the `ServerReq` every handler and every test sees.
 *
 * `req.body` is NEVER read (U-RAWBODY). The JSON parse here is a convenience for handlers that
 * take `req.body` directly (`devices.js`, `pair.js`, `lifecycle.js`, `spaces.js`, `invites.js`);
 * `ops.js` re-parses `rawBody` through `readSignedBody`, which is the authoritative path, and
 * both parses run over the same bytes so they cannot disagree.
 *
 * @param {import('node:http').IncomingMessage} nodeReq
 * @param {Uint8Array} rawBody
 * @returns {Object} ServerReq
 */
export function toServerReq(nodeReq, rawBody) {
  const url = new URL(nodeReq.url || '/', 'http://localhost');
  const query = {};
  for (const [k, v] of url.searchParams) {
    // A repeated key becomes an array, which is what `canonicalQuery` signs over.
    if (Object.prototype.hasOwnProperty.call(query, k)) {
      query[k] = Array.isArray(query[k]) ? [...query[k], v] : [query[k], v];
    } else query[k] = v;
  }
  const headers = {};
  for (const [k, v] of Object.entries(nodeReq.headers || {})) {
    headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : String(v);
  }

  let body = null;
  if (rawBody.length > 0) {
    try { body = JSON.parse(Buffer.from(rawBody).toString('utf8')); }
    catch { throw fail('bad_request'); }
  }

  // The connection's own peer address — the ONE value this host actually knows, as opposed to
  // one a client could have written. `limits.js`'s `clientIp` prefers it over every header for
  // exactly that reason. Behind Vercel's edge the socket peer is the edge, not the client, so
  // this is normally absent and the header order (U-VERCELIP) applies; on any host where it IS
  // the client, no header can override it. This is LZP-204's owed item 7.
  const peer = nodeReq.socket && nodeReq.socket.remoteAddress;
  const clientIp = typeof peer === 'string' && IP_TEXT_RE.test(peer) ? peer : undefined;

  return {
    method: String(nodeReq.method || 'GET').toUpperCase(),
    path: url.pathname,
    query,
    headers,
    body,
    rawBody,
    ...(clientIp === undefined ? {} : { clientIp }),
  };
}

/**
 * Build the `ctx` the 27 handlers need. Enumerated by `REQUIRED_CTX` in
 * `server/core/handlers/index.js`, and checked against it — a host that forgets `ctx.sha256`
 * fails here at build time, not months later on the one request a joining family member makes.
 *
 * @param {Object} store a SyncStore
 * @param {(line:string) => void} [sink] where log lines go; `console.log` in production
 * @returns {Object} ServerCtx
 */
export function buildCtx(store, sink) {
  const ctx = {
    store,
    now: () => Date.now(),
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    // CTX_EXTENSIONS E2-C1 (handlers/spaces.js). ADR 002 §7.1 stores SHA-256(HKDF(code,…)) and
    // redemption presents the HKDF output, so the server must hash to check it. Injected rather
    // than imported so ADR 003 §9's purity rule holds and a test can drive it.
    sha256: async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b)),
    limits: LIMITS,
    // `createLog` iterates ADR 003 §6.2's seven-field allowlist and never the caller's object,
    // so no handler — present or future — can put an envelope, a header or a body into a log
    // line that Vercel retains. See limits.js §6.
    log: createLog(sink || ((line) => console.log(line))),
  };
  ctx.auth = async (req) => (await import('../core/auth.js')).authenticate(req, ctx);
  ctx.assertMember = async (memberId, spaceId) => (await import('../core/auth.js')).assertMember(memberId, spaceId, ctx);

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // LZP-1009 · THE SINK, AND THE ONLY TWO `process.env` READS IN THE WHOLE SERVER
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  //
  // `server/core/` is env-free and a test enforces it (`blindness.test.js` §8 bans
  // `process.env` under `server/core` outright). Configuration therefore arrives on `ctx`, and
  // the reading happens in an ADAPTER — here, beside `DATABASE_URL`'s home in `prisma.js`.
  //
  // ── the sink ───────────────────────────────────────────────────────────────────────────────
  // `handlers/feedback.js` has no `to:` field and refuses a body that carries one, because a
  // payload-specified recipient is an open relay for spam. WHERE a report goes is decided here,
  // by the host, and on this deployment the answer is the `Report` table.
  //
  // ⚠ THE REPORT TABLE IS NOT A SPACE STORE, and the distinction is what keeps promise 1 alive:
  // `Report` has NO `spaceId` and NO relation to `Space`, so it cannot sync and cannot reach a
  // family's board (Principle 10). The handler still never touches it — it is handed this
  // function and nothing else, and `tests/server/feedback.test.js` §4 still runs that handler
  // against a store whose every other property THROWS. Storage moved; promise 1 did not.
  //
  // Bound only when the store can actually keep a report. Absent, the route answers 501 —
  // HONESTLY, rather than accepting a report and dropping it, which is the one place a helpful
  // 202 would be a lie: the preview screen told her exactly what would be sent.
  //
  // ⚠ THE SINK IS ALSO AN ADAPTER, and this is the one place the two vocabularies meet.
  // `handlers/feedback.js` hands over `{at, report, image, signed, devicePub, proves, provesNot}`
  // — a message. `store.putReport` accepts `{id, prose, image, signed, devicePub}` — a row, and
  // it REFUSES any other key rather than ignoring it (`normalizeReportInput`). Three of the four
  // differences are deliberate on the store's side and the fourth is deliberate on this one:
  //
  //   · `report` → `prose`. `store-interface.js` chose `prose` over text/body/message so the
  //     column name clears `FORBIDDEN_COLUMN_TOKENS`; the handler's field is older than that.
  //   · `devicePub` base64url → the 65 raw bytes the column holds, byte-identical to
  //     `Device.sigPubRaw`. A malformed one is dropped to null rather than throwing: it can only
  //     be malformed if it never verified, and a report is never refused for the shape of a
  //     credential it did not have to present.
  //   · `at`, `proves` and `provesNot` are NOT stored. The first is the store's to stamp
  //     (`receivedAt`/`expiresAt`, and with them the 90 days); the other two are constants of the
  //     handler, and a copy of a constant in every row is a copy that goes stale.
  //   · THE ID IS MINTED HERE, from `ctx.random`. The handler cannot mint one — an id in the
  //     answer would be a read-back handle, which `handlers/feedback.js` promise 2 refuses, and
  //     it still refuses it: the 202 carries no id and the reporter never learns one.
  if (typeof store.putReport === 'function') {
    ctx.feedbackSink = async (record) => {
      await store.putReport({
        id: `rep_${b64uOf(ctx.random(16))}`,
        prose: record.report,
        image: record.image === undefined ? null : record.image,
        signed: record.signed === true,
        devicePub: record.signed === true ? rawPubOf(record.devicePub) : null,
      });
    };
  }

  // ── the operator ───────────────────────────────────────────────────────────────────────────
  // U-ADMINENV. A base64url raw P-256 public key; `handlers/reports.js` decodes and length-checks
  // it, so a typo here is a 404 (no operator) rather than a crash. THIS IS NOT A ROLE: there is
  // no column, no row and nothing a client can claim — ADR 003 §5.1's removal of `Member.role`
  // is untouched, and `'role'` stays in `FORBIDDEN_COLUMN_TOKENS`. It is server configuration in
  // exactly the sense `feedbackSink` above is.
  const adminPub = process.env.LZP_REPORTS_ADMIN_PUB;
  if (typeof adminPub === 'string' && adminPub.trim() !== '') ctx.reportsAdminPub = adminPub.trim();

  assertCtx(ctx);
  return ctx;
}

/**
 * base64url, no padding — `auth.js#b64u`'s output, spelled here so this adapter does not import a
 * core module for four lines. Only ever applied to 16 bytes of entropy.
 * @param {Uint8Array} b @returns {string}
 */
function b64uOf(b) {
  return Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The 65 raw bytes behind a base64url device key, or null.
 *
 * `null` rather than a throw for anything that does not decode to exactly 65 bytes: this runs
 * AFTER `handlers/feedback.js` verified a signature under that key, so a value that fails here
 * cannot be one a caller got past the verifier — and a report is never lost over the shape of a
 * credential it was not required to present in the first place.
 * @param {unknown} v @returns {Uint8Array|null}
 */
function rawPubOf(v) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]+$/.test(v)) return null;
  const b = new Uint8Array(Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  return b.length === 65 ? b : null;
}

/**
 * The response headers written on EVERY response, success and failure alike.
 *
 * ADR 003 §4 requires the protocol window on every response: a 426 without it tells a stranded
 * client it is too old and not what to be. `toResponse` returns `{}` headers for errors, which
 * is why this merge happens here and not there. `vercel.json` also sets Cache-Control,
 * X-Content-Type-Options, Referrer-Policy and HSTS on `/api/(.*)`; they are repeated here so the
 * dev host and the deployed function agree even if the platform header block does not apply
 * (U-HEADERS).
 *
 * Deliberately NO `Access-Control-Allow-Origin`. The client is a desktop app, not a browser
 * origin (21.5), and `.github/scripts/check-server-config.mjs` fails the build on one.
 */
export function responseHeaders(extra) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...versionHeaders(),
    ...(extra || {}),
  };
}

/** The shared router. Built once per module scope, i.e. once per warm instance (U-COLD). */
const route = createHandlers();

/**
 * The Vercel function body. `server/api/v1/index.js` is a one-line re-export of this.
 *
 * @param {import('node:http').IncomingMessage} nodeReq
 * @param {import('node:http').ServerResponse} nodeRes
 * @param {Object} [inject] test seam: `{ store, sink }`
 */
export async function handleRequest(nodeReq, nodeRes, inject) {
  let out;
  try {
    const rawBody = await readRawBody(nodeReq);
    const req = toServerReq(nodeReq, rawBody);
    const store = (inject && inject.store) || prismaStore(await createPrismaClient());
    const ctx = buildCtx(store, inject && inject.sink);
    const res = await route(ctx, req);
    out = { status: res.status, headers: res.headers || {}, body: res.body };
  } catch (err) {
    out = toResponse(err);
  }
  const payload = Buffer.from(JSON.stringify(out.body ?? null), 'utf8');
  nodeRes.writeHead(out.status, responseHeaders({ ...out.headers, 'Content-Length': payload.length }));
  nodeRes.end(payload);
}

export default handleRequest;
