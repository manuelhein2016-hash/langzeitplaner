#!/usr/bin/env node
// server/dev-server.mjs — a zero-dependency node:http host for the sync API.  ADR 005 §1.6.
//
//   node server/dev-server.mjs [--port 8787] [--dir .lzp-dev-store]
//
// WHY THIS EXISTS. There is no Vercel account, no Postgres and no GitHub remote on this machine,
// and the client work packages still have to be developed and demonstrated against a REAL wire:
// real HTTP, real headers, real signatures, real cursors, real 409s. This runs the same
// `server/core/router.js`, the same `server/core/handlers/index.js` composition and the same 23
// handlers that will run in Frankfurt, over `server/adapters/file.js`, so **two real app windows
// on this Mac can sync with each other**.
//
// It is a development host. It is not hardened, it binds loopback only, and it says so on
// startup. Nothing in `server/core/` knows it exists.
//
// AS OF LZP-207 EVERY ROUTE IS WIRED. The startup banner prints `23 of 23`; if it ever prints
// fewer, `handlers/index.js` has been edited and `assertComposition` should have refused to
// build — read the error rather than the 501.
//
// WHAT CHANGED AT INTEGRATION, and why each one is not cosmetic:
//   · `LIMITS` is imported from `limits.js` instead of a local `FALLBACK_LIMITS`. A dev host
//     running different numbers from production is a dev host that cannot reproduce a 429.
//   · `versionHeaders()` replaces a hardcoded `{min:1,max:1}`. The N−1 window is derived
//     (`version.js`), and two copies of a derived value is how it stops being derived.
//   · `createLog(console.log)` replaces a hand-written destructure that logged
//     `route: url.pathname` — a RAW PATH, which for `/api/v1/pair/<rid>` is HKDF output of the
//     pairing code, on stdout. That was the one real leak in this file.
//   · `x-real-ip` is set from the socket, so per-IP limiters have something to key on other than
//     the shared `'?'` bucket. `req.clientIp` carries the same value and outranks every header.
//   · `ctx.sha256` is supplied (CTX_EXTENSIONS E2-C1) — without it `POST /invites/redeem` 500s.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// `--demo` — WHY A JSON API HOST SERVES TWO STATIC FILES, AND WHY IT IS NOT CORS
// ─────────────────────────────────────────────────────────────────────────────────────────────
// The E2 verification has to show TWO REAL BROWSER CLIENTS syncing through this API. A browser
// client is subject to the same-origin policy, and this server deliberately sends **no**
// `Access-Control-Allow-Origin` — story 21.5, and `.github/scripts/check-server-config.mjs`
// FAILS the deploy if one ever appears in `vercel.json`. So a page served by the app host on
// :4173 cannot read a response from :8787, and the honest fix is not to weaken the control: it
// is to serve the demonstration page from the SAME ORIGIN as the API it drives.
//
// `--demo` therefore adds one read-only static lane, off by default:
//
//   GET /_dev/two-client.html   `server/dev/two-client.html`
//   GET /_dev/two-client.js     `server/dev/two-client.js`
//   GET /src/js/**.js           the repository's REAL client modules, unmodified
//
// The last one is the point. The page imports `src/js/crypto/envelope.js`,
// `src/js/crypto/spacekeys.js` and `src/js/crypto/identity.js` as they ship — no copy, no shim —
// so what the demonstration proves is the shipped crypto against the shipped handlers over real
// HTTP. `docs/v2/E2-VERIFICATION.md` §2 records the run.
//
// The lane is GET-only, extension-allowlisted, resolved with `path.resolve` and refused unless
// the result is inside the repository, and it is not reachable at all without the flag. It shares
// nothing with `server/core/`, which still knows nothing about this file.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTE_NAMES, matchRoute } from './core/router.js';
import { toResponse, fail } from './core/errors.js';
import { LIMITS, createLog } from './core/limits.js';
import { versionHeaders } from './core/version.js';
import { handlers, createHandlers, assertCtx } from './core/handlers/index.js';
import { authenticate, assertMember } from './core/auth.js';
import { fileStore, STORE_FILENAME } from './adapters/file.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** IPv4/IPv6 text — the same alphabet `limits.js` accepts, so nothing else reaches a bucket key. */
const IP_TEXT_RE = /^[0-9A-Fa-f:.[\]]{1,45}$/;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// The `--demo` static lane. See the header for why it exists at all.
// ─────────────────────────────────────────────────────────────────────────────

const REPO = path.resolve(HERE, '..');
const DEMO_TYPES = Object.freeze({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' });

/**
 * Resolve a demo URL path to a file inside the repository, or null.
 *
 * Two allowlists, both closed: the URL prefix and the file extension. `path.resolve` collapses
 * every `..` before the containment check, so the check is on the RESOLVED path and cannot be
 * walked past — which is the same rule `router.js:segmentsOf` applies to API paths, applied here
 * because this lane does not go through the router.
 *
 * @param {string} urlPath @returns {string|null}
 */
function demoFile(urlPath) {
  let rel;
  if (urlPath === '/_dev/two-client.html') rel = 'server/dev/two-client.html';
  else if (urlPath === '/_dev/two-client.js') rel = 'server/dev/two-client.js';
  else if (urlPath.startsWith('/src/js/')) rel = urlPath.slice(1);
  else return null;
  if (!Object.prototype.hasOwnProperty.call(DEMO_TYPES, path.extname(rel))) return null;
  const abs = path.resolve(REPO, rel);
  if (abs !== REPO && !abs.startsWith(REPO + path.sep)) return null;
  return abs;
}

async function main() {
  const port = Number(arg('port', '8787'));
  const dir = path.resolve(arg('dir', path.join(HERE, '..', '.lzp-dev-store')));
  const demo = process.argv.includes('--demo');

  const limits = LIMITS;
  const store = fileStore(dir);
  const route = createHandlers();

  const ctx = {
    store,
    now: () => Date.now(),
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    // CTX_EXTENSIONS E2-C1 — ADR 002 §7.1's invite verifier is SHA-256(HKDF(code,…)) and the
    // server has to do the hashing. Injected, never imported, so ADR 003 §9's purity rule holds.
    sha256: async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b)),
    auth: (req) => authenticate(req, ctx),
    assertMember: (memberId, spaceId) => assertMember(memberId, spaceId, ctx),
    // ADR 003 §6.2 — the sanitiser iterates the SEVEN-FIELD ALLOWLIST and never the caller's
    // object, so `route` here is a ROUTE NAME (`pairGet`), never `req.path`. That distinction is
    // the difference between a log line and a copy of the pairing rendezvous id.
    log: createLog((line) => console.log(line)),
    limits,
  };

  // `REQUIRED_CTX`'s own docblock names this file as one of the two deployment checklists it
  // exists for, and `adapters/vercel.js` was calling it while this host was not — so the dev host
  // could boot with a `ctx` the production host would have refused, and the difference would
  // surface as a 500 on one endpoint months later. `ctx.sha256` is the sharp case: only
  // `redeemInvite` reads it, so every smoke test passes and the first joining family member 500s.
  assertCtx(ctx);

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= limits.bytesPerRequest) chunks.push(c);
    });
    req.on('end', async () => {
      let out;
      let routeName = 'unmatched';
      try {
        if (size > limits.bytesPerRequest) throw fail('payload_too_large');
        const rawBody = new Uint8Array(Buffer.concat(chunks));
        // The `--demo` lane, before anything else, and only ever for GET. It writes its own
        // response and returns, so a static file never enters the JSON envelope below.
        const file = demo && req.method === 'GET' ? demoFile(url.pathname) : null;
        if (file !== null) {
          let body;
          try { body = fs.readFileSync(file); } catch { body = null; }
          if (body === null) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); }
          else {
            res.writeHead(200, {
              'Content-Type': DEMO_TYPES[path.extname(file)],
              'Content-Length': body.length,
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            });
            res.end(body);
          }
          // Deliberately NOT written through `ctx.log`. `LOG_ROUTES` is a closed allowlist of the
          // 23 route names plus `unmatched` and `health` (ADR 003 §6.2), and widening a security
          // allowlist so a dev-only file server can announce itself is the wrong direction. The
          // API calls this page then makes are logged like any other, which is what matters.
          return;
        }
        if (url.pathname === '/_dev/health') {
          routeName = 'health';
          out = {
            status: 200,
            headers: {},
            body: {
              ok: true, adapter: 'file', dir, file: STORE_FILENAME,
              routes: ROUTE_NAMES.length, wired: Object.keys(handlers).length,
            },
          };
        } else {
          const query = {};
          for (const [k, v] of url.searchParams) query[k] = v;
          const headers = {};
          for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = String(v);
          // The socket's own peer address. On this host it really IS the client, so it outranks
          // every header (limits.js `clientIp`). `x-real-ip` is set from the same value so that a
          // handler reading headers directly sees the same answer.
          const peer = req.socket && req.socket.remoteAddress;
          const clientIp = typeof peer === 'string' && IP_TEXT_RE.test(peer) ? peer : undefined;
          if (clientIp) headers['x-real-ip'] = clientIp;

          let body = null;
          if (rawBody.length > 0) {
            try { body = JSON.parse(Buffer.from(rawBody).toString('utf8')); } catch { throw fail('bad_request'); }
          }
          const sreq = {
            method: req.method, path: url.pathname, query, headers, body, rawBody,
            ...(clientIp === undefined ? {} : { clientIp }),
          };
          // Resolve the NAME before dispatching, so the one log line this host writes carries a
          // ROUTE_NAME even when the handler throws. `matchRoute` is pure and is the same
          // function the router uses, so the name cannot disagree with the handler that ran; a
          // path that matches nothing stays 'unmatched', which is a LOG_ROUTES value.
          try { const m = matchRoute(sreq.method, sreq.path); if (m) routeName = m.route.name; }
          catch { /* 405: the path matched under another method; 'unmatched' is the honest name */ }
          const result = await route(ctx, sreq);
          out = { status: result.status, headers: result.headers || {}, body: result.body };
        }
      } catch (err) {
        out = toResponse(err);
      }
      const payload = Buffer.from(JSON.stringify(out.body ?? null), 'utf8');
      res.writeHead(out.status, {
        ...out.headers,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': payload.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        // ADR 003 §4 — on EVERY response, errors included, and derived rather than hardcoded.
        ...versionHeaders(),
        // Deliberately NO Access-Control-Allow-Origin. The client is a desktop app, not a
        // browser origin; a CORS header here could only ever help a web page that should not be
        // talking to this server (21.5, and the LZP-109 pre-flight fails on one). A browser-based
        // demonstration must therefore be served SAME-ORIGIN — see docs/v2/E2-VERIFICATION.md.
      });
      res.end(payload);
      // `status`, `ms` and `byteCount` only, plus the route NAME when the router produced one.
      // A path never reaches this call. See ADR 003 §6.2 and limits.js §6.
      ctx.log({ route: routeName, status: out.status, byteCount: size, ms: Date.now() - started });
    });
  });

  server.listen(port, '127.0.0.1', () => {
    const wired = Object.keys(handlers).length;
    console.log(`LangzeitPlaner dev sync host`);
    console.log(`  http://127.0.0.1:${port}/api/v1   (loopback only)`);
    console.log(`  store: ${path.join(dir, STORE_FILENAME)}  (file adapter, single writer)`);
    console.log(`  routes: ${wired} of ${ROUTE_NAMES.length} wired`);
    const v = versionHeaders();
    console.log(`  protocol: ${v['X-LZP-Min-Protocol']}..${v['X-LZP-Protocol']}  (N-1 rule, version.js)`);
    if (demo) {
      console.log(`  demo:   http://127.0.0.1:${port}/_dev/two-client.html?role=A   (and ?role=B in a second tab)`);
      console.log('          SAME-ORIGIN on purpose: this API sends no Access-Control-Allow-Origin (21.5).');
    }
    if (wired < ROUTE_NAMES.length) {
      console.log(`  WARNING: ${ROUTE_NAMES.length - wired} route(s) unwired — handlers/index.js should have refused to build.`);
    }
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
