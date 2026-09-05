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
// — bytes in, bytes out — plus the `ctx` construction. There is no protocol logic here; the 23
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
 * Build the `ctx` the 23 handlers need. Enumerated by `REQUIRED_CTX` in
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
  assertCtx(ctx);
  return ctx;
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
 * The Vercel function body. `server/api/v1/[...path].js` is a one-line re-export of this.
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
