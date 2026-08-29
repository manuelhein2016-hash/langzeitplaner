// Minimal static server for local development — ES modules need an origin.
// Nothing in the app talks to it beyond fetching its own files; the shipped
// Tauri build serves the same tree from the app bundle.
//
// ─────────────────────────────────────────────────────────────────────────────
// `--relay <origin>` — THE M1 DEMONSTRATION LANE, and why it is a PROXY
// ─────────────────────────────────────────────────────────────────────────────
// Milestone M1 has to show two real app windows in real sync over real HTTP.
// A browser window is subject to the same-origin policy and `index.html` ships
// `connect-src 'self'` — deliberately, and E5 decided NOT to widen it: a <meta>
// CSP is one static string and cannot be conditional on a space existing, so
// naming a sync host there would relax every SOLO install's policy for a
// request solo mode must never make (ADR 003 §7 gate 4, and net.js's header).
//
// The shipping answer is the native shell's `sync_request` bridge (gate 3),
// which survives a JS bug. The DEV answer is this: put the relay on the app's
// own origin, so `connect-src 'self'` is satisfied by construction and the page
// under test is byte-for-byte the page that ships. Nothing about the app
// changes; one dev host forwards `/api/v1/*` to the other.
//
//   node server/dev-server.mjs --port 8787          # the relay, file adapter
//   node dev-server.mjs --relay http://127.0.0.1:8787
//
// Off unless the flag is given, so an ordinary `npm run dev` is exactly what it
// always was: a static file server that forwards nothing.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 4173);

const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
};
const RELAY = argValue('--relay') || process.env.LZP_RELAY || null;

/** Forward one `/api/v1/…` request to the relay, headers and body unchanged. */
async function proxy(req, res) {
  const target = new URL(req.url, RELAY);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const headers = { ...req.headers };
  // The relay's per-IP limiters key on `x-real-ip`; without it every window on
  // this Mac shares the `'?'` bucket, which is not what the demonstration is
  // about. `host` must be the relay's own or its URL parsing sees ours.
  delete headers.host;
  delete headers.connection;
  headers['x-real-ip'] = req.socket.remoteAddress || '127.0.0.1';
  try {
    const up = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      redirect: 'manual',
    });
    const text = await up.text();
    const out = {};
    up.headers.forEach((v, k) => { if (k !== 'content-encoding' && k !== 'transfer-encoding') out[k] = v; });
    res.writeHead(up.status, out).end(text);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: 'relay_unreachable', detail: String(e && e.message) }));
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  if (RELAY && (req.url || '').startsWith('/api/v1/')) { await proxy(req, res); return; }
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const buf = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}).listen(PORT, () => {
  console.log(`LangzeitPlaner dev server → http://localhost:${PORT}`);
  if (RELAY) console.log(`  /api/v1/* → ${RELAY}   (M1 demonstration lane; same-origin by design)`);
});
