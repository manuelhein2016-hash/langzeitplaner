#!/usr/bin/env node
// scripts/hostile-relay.mjs — A RELAY THAT MISBEHAVES ON PURPOSE.  LZP-1002.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `shell-macos/main.swift`'s `sync_request` makes four promises that only a HOSTILE SERVER can
// test, because they are all about what the shell does when the far end lies:
//
//   · it follows NO redirect — not to another origin, and not to another path on the same one
//     (FINDING P-5: a signed request replayed at a destination the RELAY chose);
//   · it caps the response as the bytes arrive, so a broken or malicious relay does not decide
//     how much memory this process allocates;
//   · it times out rather than hanging;
//   · it carries nothing ambient — no cookie it is handed comes back on the next request, and no
//     header the page did not put on the allowlist reaches the wire.
//
// A well-behaved relay cannot demonstrate any of those. `server/dev-server.mjs` is the honest
// one; this is its adversary, and it lives in the repository rather than in a scratch directory
// so the red team is a fixture the suite can re-run and not a thing somebody once ran.
//
// It is under `scripts/` and not next to the dev server because `server/` has another owner. The
// hand-off note is in `docs/v2/SHELL-VERIFICATION.md`: whoever owns `server/` may want it as
// `server/dev/hostile-relay.mjs`, and moving it costs one path in
// `scripts/shell-ssrf.mjs`.
//
// **It binds loopback only and it speaks no part of the real protocol.** Nothing here imports
// `server/core/`; it is 150 lines of `node:http` that answers a handful of paths badly on
// purpose. It is not a relay you could sync with, and that is deliberate — a fixture that half
// worked would be a fixture somebody pointed a real client at.
//
//   node scripts/hostile-relay.mjs [--port 8792]
//
// Every path is under `/api/v1/` because `syncPreflight` refuses anything else before it opens a
// socket, and a fixture the shell refuses locally tests nothing about the shell's behaviour ON
// THE WIRE. Zero dependencies.

import http from 'node:http';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg('port', '8792'));

/** Everything the fixture has seen, so a test can ask what actually reached the wire. */
const seen = [];

const json = (res, code, body, extra = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...extra,
  });
  res.end(text);
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  seen.push({
    path,
    method: req.method,
    headers: { ...req.headers },
    at: Date.now(),
  });

  switch (path) {
    // ── the honest answer, so every refusal below has a control ─────────────────────────────
    //
    // It ECHOES the request headers. That is this fixture's second job: `URLSession` adds
    // headers of its own accord (it was measured adding `User-Agent: LangzeitPlaner/1.0.0
    // CFNetwork/… Darwin/25.6.0` and `Accept-Language: en-US,en;q=0.9` — this Mac's OS build and
    // the user's language preferences, on every sync), and the only way to know what a native
    // HTTP client really sent is to have the far end read it back.
    case '/api/v1/meta':
      json(res, 200, { ok: true, sawHeaders: req.headers, sawCookie: req.headers.cookie || null });
      return;

    // ── redirects ───────────────────────────────────────────────────────────────────────────
    // Off-origin: the classic replay. Same-origin: the same attack with a smaller blast radius —
    // the relay choosing WHICH ENDPOINT answered a signed request is still the relay choosing.
    case '/api/v1/rediroff':
      res.writeHead(302, { location: 'https://evil.example/api/v1/meta' });
      res.end();
      return;
    case '/api/v1/redirsame':
      res.writeHead(302, { location: `http://127.0.0.1:${PORT}/api/v1/meta` });
      res.end();
      return;
    case '/api/v1/redir307':
      // 307 preserves the METHOD and the BODY, so a followed one would replay a signed POST
      // verbatim. Worth its own path.
      res.writeHead(307, { location: 'https://evil.example/api/v1/ops' });
      res.end();
      return;

    // ── an oversized body, announced and unannounced ────────────────────────────────────────
    // `didReceive response:` can refuse on `expectedContentLength`; `didReceive data:` has to
    // count as it goes. A chunked flood exercises the second, which is the one that matters —
    // a relay that lies about its length is the case the first cannot catch.
    case '/api/v1/huge': {
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      res.writeHead(200, { 'content-type': 'application/json' });
      let n = 0;
      const pump = () => {
        while (n < 12) { n += 1; if (!res.write(chunk)) { res.once('drain', pump); return; } }
        res.end();
      };
      pump();
      return;
    }
    case '/api/v1/hugesaid': {
      // Announces 64 MiB up front and then sends it. The response-header check should refuse
      // before a single body byte is buffered.
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(64 * 1024 * 1024) });
      const chunk = Buffer.alloc(1024 * 1024, 0x62);
      for (let i = 0; i < 8; i += 1) res.write(chunk);
      // Deliberately never ended: the client must not wait for 64 MiB that will not arrive.
      return;
    }

    // ── a relay that never answers ──────────────────────────────────────────────────────────
    case '/api/v1/stall':
      // No write, no end. The socket stays open until the client's own timeout fires.
      return;

    // ── ambient state ───────────────────────────────────────────────────────────────────────
    // Hands out a cookie and reports whether it got one back. A transport with a cookie jar
    // would show `sawCookie` non-null on the second call.
    case '/api/v1/setscookie':
      json(res, 200, { ok: true, sawCookie: req.headers.cookie || null },
        { 'set-cookie': 'lzp_hostile=1; Path=/; Max-Age=600' });
      return;

    // ── what did you actually see? ──────────────────────────────────────────────────────────
    // Read by the DRIVER over plain `fetch`, never by the page. It is on `/api/v1/` only so the
    // shell would be allowed to ask for it too; nothing in the page does.
    case '/api/v1/seen':
      json(res, 200, { seen });
      return;

    default:
      json(res, 404, { error: 'not_a_path_this_fixture_answers', path });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`hostile relay on http://127.0.0.1:${PORT} — loopback only, speaks no real protocol\n`);
});
