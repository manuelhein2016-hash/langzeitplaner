// tests/helpers/netscope.js — the source scan behind ADR 003 §7 gate 1 / ADR 005 §5 rule 4.
//
// WHY THIS IS A HELPER AND NOT PART OF THE TEST FILE.
// `tests/tier1/suite-integrity.test.js` forbids `node:fs` inside any tier-1 *test* file, so the
// reading lives here — confined to paths inside the repository — exactly as `purity.js` and
// `importgraph.js` do.
//
// WHY IT IS SEPARATE FROM `purity.js`.
// `purity.js` answers a different question over a different set of files: "are the four DOM-free,
// I/O-free directories still pure?", scanning `PURE_DIRS` = core / crypto / sync / server-core.
// This one answers "is `net.js` still the ONLY network call site?", and its scope is **all of
// `src/js/`** — every module the product ships, `platform/` and the DOM layer included. That
// difference is the whole finding: `PURE_DIRS` never scanned `src/js/platform/`, which is how
// `src/js/platform/updater.js` arrived unscanned (finding **F-9**), and a gate written as "one
// more directory in PURE_DIRS" would have been the same gate with the same blind spot, since
// `platform/` is legitimately allowed `window`, `setTimeout` and `Date.now`.
//
// The comment/string blanking is `purity.js`'s — imported, not re-implemented, so the two gates
// cannot disagree about what counts as code. A `fetch` named only in prose must never trip this,
// and a real one must never hide behind a template literal.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO, stripCommentsAndStrings } from './purity.js';

/** Everything the product ships to a WebView. Walked, never listed. */
export const SCAN_ROOT = 'src/js';

/**
 * The ONE file allowed to name any of these. ADR 005 §5 rule 4; ADR 003 §7 gate 1.
 * A second entry here is a design change and needs an ADR, not a test edit.
 */
export const ALLOWED = Object.freeze(['src/js/platform/net.js']);

/**
 * Every way a page can open a socket.
 *
 * `fetch` is matched as a WHOLE WORD rather than as `fetch\s*\(`, because the call is what has
 * to be impossible, not the syntax: `const f = globalThis.fetch; await f(url)` is a call site
 * and `fetch(` does not appear in it. The word boundary is what keeps that strictness honest —
 * `fetchManifest`, `fetchImpl` and `prefetch` do not match, which matters because
 * `src/js/platform/updater.js` has a port method named `fetchManifest` and it is emphatically
 * NOT a call site (the native shell makes that request; see that file's 21.5 ↔ 22.3 note).
 */
export const NETWORK_IDENTIFIERS = Object.freeze([
  { name: 'fetch', re: /\bfetch\b/ },
  { name: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
  { name: 'WebSocket', re: /\bWebSocket\b/ },
  { name: 'EventSource', re: /\bEventSource\b/ },
  { name: 'sendBeacon', re: /\bsendBeacon\b/ },
  { name: 'importScripts', re: /\bimportScripts\s*\(/ },
]);

function walk(absDir, relDir, out) {
  for (const e of fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(absDir, e.name);
    const rel = `${relDir}/${e.name}`;
    if (e.isDirectory()) walk(abs, rel, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push({ abs, rel });
  }
}

/** Every shipped `.js` file under `src/js/`, discovered by reading the tree. */
export function shippedFiles() {
  const out = [];
  const absDir = path.join(REPO, SCAN_ROOT);
  if (fs.existsSync(absDir)) walk(absDir, SCAN_ROOT, out);
  return out.map((f) => ({ ...f, src: fs.readFileSync(f.abs, 'utf8') }));
}

/**
 * Scan one source string. Exported separately from the file walk so a test can prove the scanner
 * FINDS things — a gate whose finder has never been shown a positive is a gate nobody has tested.
 * @param {string} rel @param {string} src
 * @returns {Array<{file:string, line:number, ident:string, text:string}>}
 */
export function scanSource(rel, src) {
  const cleaned = stripCommentsAndStrings(src);
  const raw = src.split('\n');
  const hits = [];
  cleaned.split('\n').forEach((line, i) => {
    for (const id of NETWORK_IDENTIFIERS) {
      if (id.re.test(line)) hits.push({ file: rel, line: i + 1, ident: id.name, text: raw[i].trim() });
    }
  });
  return hits;
}

/**
 * THE GATE. Every network identifier found anywhere under `src/js/` outside `ALLOWED`.
 * @returns {Array<{file:string, line:number, ident:string, text:string}>}
 */
export function networkCallSites() {
  const hits = [];
  for (const f of shippedFiles()) {
    if (ALLOWED.includes(f.rel)) continue;
    hits.push(...scanSource(f.rel, f.src));
  }
  hits.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return hits;
}

/** What the allowed file itself contains — so the gate can prove it is not vacuous. */
export function allowedCallSites() {
  const out = [];
  for (const f of shippedFiles()) {
    if (!ALLOWED.includes(f.rel)) continue;
    out.push(...scanSource(f.rel, f.src));
  }
  return out;
}

/** The shipped CSP strings, read rather than remembered (ADR 003 §7 gate 4). */
export function shippedCsp() {
  const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i)
    || html.match(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]*)"/i);
  const tauri = JSON.parse(fs.readFileSync(path.join(REPO, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  return {
    meta: m ? m[1].replace(/\s+/g, ' ').trim() : null,
    tauri: tauri?.app?.security?.csp ?? tauri?.tauri?.security?.csp ?? null,
  };
}

export const HERE = path.dirname(fileURLToPath(import.meta.url));
