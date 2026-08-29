// tests/helpers/privacy-audit.js — the filesystem and wire-capture half of the E5 privacy attack.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `tests/attack/privacy-e5-*.test.js` attacks four promises that are only testable now that the
// product sends a byte anywhere:
//
//   21.5 / 13.4 / A1   solo mode makes ZERO network requests
//   21.2 / 19.4        my private board reaches my own devices and nothing else
//   21.1               nothing readable leaves this machine
//   21.3               the app documents plainly what the server side can see
//
// Three of those four are claims about FILES — the shipped page, the shipped CSS, the module
// graph, and `docs/v2/server-metadata.md`, which is the document 21.3's promise rests on. The
// house rule (`tests/tier1/suite-integrity.test.js`, and `netscope.js` / `helper-hygiene.js` for
// precedent) is that the `node:fs` read lives in a helper and never in a test file, so that no
// suite can ever be pointed at the user's real `board.json`. This is that helper.
//
// The fourth — 21.1 — is a claim about BYTES, and the honest way to test it is to record every
// byte the shipped transport actually hands to `fetch`, rather than to inspect the objects that
// went in. `recordWire()` is that recorder, and it is deliberately placed at the socket: it sees
// the URL `net.js` built, the headers it set and the exact `rawBody` it signed, which is the
// same triple `server/core/auth.js` verifies from the other end.
//
// NOTHING HERE ASSERTS. Every judgement is in the test files, so a reader can see which
// observable was tolerated and which was a finding without reading a helper first.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { reachableFrom } from './importgraph.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');

/** Read one repo-relative file. Confined to the repository, like `importgraph.js`'s walk. */
export function repoFile(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

/** Does a repo-relative path exist? Used to say "no Datenschutz copy exists yet" out loud. */
export function repoHas(rel) {
  return fs.existsSync(path.join(REPO, rel));
}

/** Every `*.css` the shipped page links, as `{rel, src}`. */
export function shippedStyles() {
  const dir = path.join(REPO, 'src/css');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.css'))
    .map((f) => ({ rel: `src/css/${f}`, src: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Off-origin references in the shipped ASSETS — the half `netscope.js` does not scan
// ─────────────────────────────────────────────────────────────────────────────
//
// `netscope.js` greps `src/js/` for call sites. A page can reach the network without any of
// them: a `<link rel="preconnect">`, a `dns-prefetch`, a webfont `@import`, a remote favicon or
// an `<img src="https://…">` all open a socket from markup, before one line of JS runs, and none
// of them is a `fetch(`. That is precisely the shape of leak "solo mode makes zero network
// requests" dies of in other products, so it is scanned separately here.

/** The markup/CSS constructs that open a socket without any JavaScript. */
export const ASSET_NETWORK_MARKERS = Object.freeze([
  { name: 'preconnect', re: /rel\s*=\s*["'][^"']*\bpreconnect\b/gi },
  { name: 'dns-prefetch', re: /rel\s*=\s*["'][^"']*\bdns-prefetch\b/gi },
  { name: 'prefetch', re: /rel\s*=\s*["'][^"']*\bprefetch\b/gi },
  { name: 'preload', re: /rel\s*=\s*["'][^"']*\bpreload\b/gi },
  { name: 'prerender', re: /rel\s*=\s*["'][^"']*\bprerender\b/gi },
  { name: 'absolute-url', re: /\b(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/gi },
  { name: 'css-import', re: /@import\s+(?:url\()?["']?[^"');]+/gi },
]);

/**
 * Every off-origin construct in one shipped asset. The CSP `<meta>` itself is skipped — it NAMES
 * schemes in order to forbid them, and a scanner that flagged `default-src 'self'` would be a
 * scanner nobody could keep green.
 *
 * @param {string} rel @param {string} src
 * @returns {Array<{file:string, marker:string, text:string}>}
 */
export function scanAsset(rel, src) {
  const withoutCsp = src.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][\s\S]*?>/gi, ' ');
  const withoutComments = withoutCsp
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  const hits = [];
  for (const { name, re } of ASSET_NETWORK_MARKERS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(withoutComments))) hits.push({ file: rel, marker: name, text: m[0] });
  }
  return hits;
}

/** `index.html` + every shipped stylesheet, scanned. */
export function assetNetworkReferences() {
  const out = scanAsset('index.html', repoFile('index.html'));
  for (const s of shippedStyles()) out.push(...scanAsset(s.rel, s.src));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. The EAGER module graph — what a launch really evaluates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every module `entryRel` evaluates by STATIC import alone, transitively — i.e. the set that is
 * executed on every launch, whether or not anybody calls anything in it.
 *
 * `importgraph.js`'s `reachableFrom` follows dynamic edges too (it must: `dynamicDoorsFrom`
 * needs them), so this walks its edge list a second time keeping only `kind === 'static'`.
 * Principle 7 / story 15.1 — "solo mode is not one instruction heavier because family mode
 * exists" — is a statement about exactly this set.
 *
 * @param {string} entryRel @returns {string[]} sorted, including the entry
 */
export function eagerClosure(entryRel) {
  const { edges } = reachableFrom(entryRel);
  const out = new Map();
  for (const e of edges) {
    if (e.kind !== 'static') continue;
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from).push(e.to);
  }
  const seen = new Set([entryRel]);
  const queue = [entryRel];
  while (queue.length) {
    const node = queue.shift();
    for (const next of out.get(node) || []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return [...seen].sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The wire recorder — every byte, at the socket
// ─────────────────────────────────────────────────────────────────────────────

const TD = new TextDecoder();

/**
 * Wrap a fleet's `wire.deliver` so every request is recorded before it reaches the relay.
 *
 * The recording is taken at the point `platform/net.js` hands the request over, so what is
 * captured is the URL it built, the headers it set and the exact bytes it signed — not a
 * hopeful re-derivation of them. `restore()` puts the wire back.
 *
 * @param {{deliver:Function}} wire a `tests/helpers/loopback.js` wire
 * @returns {{calls:Array, restore:Function, bytes:() => string}}
 */
export function recordWire(wire) {
  const original = wire.deliver.bind(wire);
  const calls = [];
  wire.deliver = async (deviceShort, req) => {
    calls.push({
      deviceShort,
      method: req.method,
      path: req.path,
      query: { ...(req.query || {}) },
      headers: { ...(req.headers || {}) },
      rawBody: req.rawBody ? new Uint8Array(req.rawBody) : new Uint8Array(0),
      body: req.body,
    });
    return original(deviceShort, req);
  };
  return {
    calls,
    restore() { wire.deliver = original; },
    /** Every byte of every request, as one searchable string: URL, query, headers and body. */
    bytes() {
      return calls.map((c) => [
        c.method, c.path, JSON.stringify(c.query), JSON.stringify(c.headers),
        c.rawBody.length ? TD.decode(c.rawBody) : '',
      ].join(' ')).join(' ');
    },
  };
}

/** `iv ‖ ct ‖ sig` in bytes, for one envelope as it appears in a push body. */
export function envelopeBytes(env) {
  const len = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').length;
  return len(env.iv) + len(env.ct) + len(env.sig);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Poisoned network globals — "could this module reach the network at all?"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replace every network global with a trap that RECORDS AND THROWS, and return the record plus
 * a restore.
 *
 * Recording is not enough on its own: a module that swallows the throw would leave a silent
 * entry. So the trap throws as well, which turns an evaluation-time request into a failed
 * `import()` the caller can see. `navigator` is redefined rather than assigned — under Node it
 * is an accessor-only global.
 */
export function poisonNetwork() {
  const fired = [];
  const trap = (name) => new Proxy(function poisoned() {}, {
    apply() { fired.push(`${name}()`); throw new Error(`privacy-audit: ${name}() was called`); },
    construct() { fired.push(`new ${name}`); throw new Error(`privacy-audit: new ${name}`); },
  });

  const saved = new Map();
  const put = (name, value) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  for (const n of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts']) put(n, trap(n));
  put('navigator', { sendBeacon: trap('sendBeacon'), onLine: true, userAgent: 'privacy-audit' });

  return {
    fired,
    restore() {
      for (const [name, desc] of saved) {
        if (desc) Object.defineProperty(globalThis, name, desc);
        else delete globalThis[name];
      }
    },
  };
}

/** Every non-DOM module under `src/js/` — the set that lives behind the one dynamic door. */
export function nonDomModules() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${dir}/${e.name}`);
      else if (e.name.endsWith('.js')) out.push(`${dir}/${e.name}`);
    }
  };
  for (const d of ['src/js/core', 'src/js/crypto', 'src/js/sync', 'src/js/platform']) walk(d);
  out.push('src/js/store.js');
  return out.sort();
}
