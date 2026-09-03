// tests/helpers/native-scope.js — the census of what the NATIVE side of the product can reach.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS, AND WHAT IT IS NOT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `tests/helpers/netscope.js` answers "is `src/js/platform/net.js` still the only network call
// site in the PAGE?" — ADR 003 §7 gate 1, ADR 005 §5 rule 4. It is a complete answer to the
// question it asks and a blind one to the question this file asks, because the page is no longer
// the only thing that can open a socket:
//
//   · `src/js/platform/updater.js`'s own header decides that the update request is made by the
//     NATIVE SHELL PROCESS, outside the WebView, precisely so that the page keeps its property.
//   · `createBridgeTransport` hands `{url, method, headers, body}` to a shell command named
//     `sync_request`, and the shell opens the socket.
//
// Both are deliberate and both are documented. Neither is visible to a grep over `src/js/`: a
// bridge `invoke` is not a `fetch`, and no gate in the product counts them. So "the app makes
// zero network requests in solo mode" is today a claim about two processes, and only one of them
// has a gate. This file is the other one.
//
// It is a SOURCE census, not a runtime one. `tests/tier2/network-audit.dom.js` measures a
// running page; this measures what the shells are *capable* of, which is the half that can
// widen without any page test noticing.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE ONE DESIGN RULE HERE: NAMES AND ORDER, NEVER LINE NUMBERS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `shell-macos/main.swift` and `src-tauri/src/lib.rs` are being written by another workflow
// while this file is being written. Every assertion built on top of this helper is therefore
// about a PROPERTY — "which function encloses this socket", "does the gate precede the socket
// inside that function" — and never about where in the file anything sits. A rename of a
// function is a fair red; a line moving is not.
//
// Zero npm dependencies.

import fs from 'node:fs';
import path from 'node:path';

import { REPO } from './purity.js';

/** The two shells. Both ship; both must answer the same census. */
export const SHELLS = Object.freeze([
  { name: 'shell-macos/main.swift', lang: 'swift' },
  { name: 'src-tauri/src/lib.rs', lang: 'rust' },
]);

/** What a function declaration looks like, per language. Group 1 is the name. */
const FUNC_RE = Object.freeze({
  swift: /^\s*(?:@\w+\s+)?(?:private\s+|fileprivate\s+|public\s+|internal\s+|final\s+|static\s+|override\s+|class\s+|open\s+)*func\s+(\w+)/,
  rust: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+(\w+)/,
});

/**
 * EVERY WAY EITHER SHELL CAN PUT A BYTE ON THE NETWORK.
 *
 * A second entry here is a design change and needs an ADR, exactly as `netscope.js`'s `ALLOWED`
 * does. The list is deliberately wider than what the shells use today — `NWConnection`,
 * `CFSocket`, a raw `Socket`, `ureq`, `hyper` — so that a new mechanism is a RED, not a silence.
 */
export const NATIVE_NETWORK = Object.freeze({
  swift: [
    { name: 'URLSession', re: /\bURLSession\s*\(/ },
    { name: 'dataTask', re: /\.\s*dataTask\s*\(/ },
    { name: 'downloadTask', re: /\.\s*downloadTask\s*\(/ },
    { name: 'uploadTask', re: /\.\s*uploadTask\s*\(/ },
    { name: 'URLSession.shared', re: /\bURLSession\s*\.\s*shared\b/ },
    { name: 'NWConnection', re: /\bNWConnection\s*\(/ },
    { name: 'CFSocket', re: /\bCFSocket\w*\s*\(/ },
  ],
  rust: [
    { name: 'reqwest::Client', re: /\breqwest\s*::\s*Client\s*::\s*(?:new|builder)\b/ },
    { name: 'reqwest::get', re: /\breqwest\s*::\s*(?:get|blocking)\b/ },
    { name: 'tauri_plugin_updater', re: /\btauri_plugin_updater\s*::|updater_builder\s*\(/ },
    { name: 'updater.check', re: /\bupdater\s*\.\s*check\s*\(/ },
    { name: 'download_and_install', re: /\bdownload_and_install\s*\(/ },
    { name: 'TcpStream', re: /\bTcpStream\s*::/ },
    { name: 'ureq/hyper', re: /\b(?:ureq|hyper)\s*::/ },
  ],
});

/**
 * The TWO SANCTIONED JOBS, as name shapes rather than as an enumerated list of functions.
 *
 * A list of function names would be a promise about someone else's file, and both shells are
 * mid-edit. A shape survives a rename that keeps the job the same (`syncPerform` →
 * `performSyncRequest`) and fails the one thing this census is for: a THIRD job appearing.
 *
 *   · `update`  — story 22.3 / 22.5. The shell fetches one static manifest and, when the user
 *                 acts, one signed archive. `updater.js`'s header prices this in full.
 *   · `sync`    — story 21.5's "exactly one sync endpoint". `createBridgeTransport`'s far side.
 */
export const SANCTIONED = Object.freeze([
  { job: 'update', re: /update/i },
  { job: 'sync', re: /sync/i },
]);

/**
 * THE SECOND CLASS: primitives that open a socket ONLY IF HANDED A REMOTE URL.
 *
 * `Data(contentsOf:)` fetches `https://` and reads `file://` with the same call. Treating every
 * one of them as a network site would make the census fire on the shell's own bundle reads and
 * on `tar`; ignoring them would leave the one primitive a leak could hide behind unwatched.
 *
 * So they are neither. They are reported, and the claim that closes them is made separately and
 * is much stronger than a per-site one: `remoteUrlLiterals()` below shows the shells contain
 * exactly ONE hard-coded remote URL between them. A `Data(contentsOf:)` can only go out if some
 * URL value is remote, and the only remote URL a shell can name is the update manifest.
 */
export const AMBIGUOUS = Object.freeze({
  swift: [{ name: 'contentsOf:', re: /\b(?:String|Data)\s*\(\s*contentsOf\s*:/ }],
  rust: [],
});

/** Read one shell's source. Confined to paths inside the repository. */
export function shellSource(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

/**
 * Every native network site in one source, tagged with the function that ENCLOSES it.
 *
 * Exported over a string as well as over a file so a test can show the scanner a positive — a
 * census whose finder has never been shown a hit is a census nobody has tested.
 *
 * @param {string} src @param {'swift'|'rust'} lang @param {string} [rel]
 * @returns {Array<{fn:string, ident:string, line:number, text:string, job:string|null}>}
 */
export function scanNative(src, lang, rel = '<string>', which = 'sockets') {
  const funcRe = FUNC_RE[lang];
  const idents = which === 'ambiguous' ? AMBIGUOUS[lang] : NATIVE_NETWORK[lang];
  if (!funcRe || !idents) throw new Error(`native-scope: unknown language ${lang}`);
  if (idents.length === 0) return [];
  const out = [];
  let fn = '<file scope>';
  src.split('\n').forEach((line, i) => {
    const m = line.match(funcRe);
    if (m) fn = m[1];
    // A commented-out socket is not a socket. The shells carry long design notes that name
    // `URLSession` in prose dozens of times, and treating those as sites would make the census
    // fire on documentation — the exact opposite of what it is for.
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '');
    // Registering a Tauri PLUGIN is not making a request. `run()` wires
    // `tauri_plugin_updater::Builder` into the app once at startup; the request is made later,
    // inside `update_fetch_manifest`. Counting the registration would put a socket in `run` and
    // make the census permanently red for a line that opens nothing.
    if (/\.\s*plugin\s*\(|Builder\s*::\s*new\s*\(\s*\)\s*\.?\s*build\s*\(/.test(code)) return;
    for (const id of idents) {
      if (id.re.test(code)) {
        const job = SANCTIONED.find((s) => s.re.test(fn));
        out.push({ file: rel, fn, ident: id.name, line: i + 1, text: line.trim().slice(0, 90), job: job ? job.job : null });
      }
    }
  });
  return out;
}

/** The whole census, both shells: everything that opens a socket by construction. */
export function nativeNetworkSites() {
  const out = [];
  for (const s of SHELLS) out.push(...scanNative(shellSource(s.name), s.lang, s.name, 'sockets'));
  return out;
}

/** The second class — reported, never sanctioned. See `AMBIGUOUS`. */
export function ambiguousSites() {
  const out = [];
  for (const s of SHELLS) out.push(...scanNative(shellSource(s.name), s.lang, s.name, 'ambiguous'));
  return out;
}

/**
 * EVERY HARD-CODED REMOTE URL IN EITHER SHELL.
 *
 * Comments are stripped first: both files carry long design notes that quote URLs, and a census
 * that counted prose would say nothing. What survives is what the compiled binary can actually
 * name.
 *
 * @returns {Array<{file:string, line:number, url:string}>}
 */
export function remoteUrlLiterals() {
  const out = [];
  for (const s of SHELLS) {
    const src = shellSource(s.name);
    src.split('\n').forEach((line, i) => {
      // Strip a trailing line comment WITHOUT eating the `//` inside `https://` — the bug this
      // census would otherwise have: the one real URL literal in the product lives on a line
      // that a naive comment stripper deletes entirely.
      const code = line.replace(/(^|[^:])\/\/.*$/, '$1').replace(/^\s*\*.*$/, '');
      for (const m of code.matchAll(/["'`](https?:\/\/[^"'`\s]*)/g)) {
        out.push({ file: s.name, line: i + 1, url: m[1] });
      }
    });
  }
  return out;
}

/**
 * Inside one function, does a guard mentioning `guardRe` appear BEFORE the first network site?
 *
 * Relative order within one function is the strongest statement that survives someone else
 * editing the file: it says "the gate is upstream of the socket", which is the claim, and it
 * says nothing about where either sits.
 *
 * @returns {{found:boolean, guardLine:number|null, netLine:number|null}}
 */
export function guardPrecedesSocket(src, lang, fnName, guardRe) {
  const funcRe = FUNC_RE[lang];
  const idents = NATIVE_NETWORK[lang];
  let fn = '<file scope>';
  let guardLine = null;
  let netLine = null;
  src.split('\n').forEach((line, i) => {
    const m = line.match(funcRe);
    if (m) fn = m[1];
    if (fn !== fnName) return;
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '');
    if (guardLine === null && guardRe.test(code)) guardLine = i + 1;
    if (netLine === null && idents.some((id) => id.re.test(code))) netLine = i + 1;
  });
  return { found: guardLine !== null && netLine !== null && guardLine < netLine, guardLine, netLine };
}

/**
 * Every bridge command name either shell answers to.
 *
 * Swift dispatches on `case "<name>":` inside one switch; so does Rust's `#[tauri::command]`
 * attribute, one per function. Both are read here, and the union is what a page can reach.
 * MIME-type switches and other unrelated `case "x":` are filtered by requiring the command to
 * be one the page actually invokes OR to look like a command (`snake_case`, ≥ 2 segments) —
 * stated rather than assumed, because a filter that is too loose makes this census noise.
 */
export function bridgeCommands(only = null) {
  const names = new Set();
  if (only === null || only === 'shell-macos/main.swift') {
    const swift = shellSource('shell-macos/main.swift');
    for (const m of swift.matchAll(/case\s+"([a-z][a-z0-9]*(?:_[a-z0-9]+)+)"\s*:/g)) names.add(m[1]);
  }
  if (only === null || only === 'src-tauri/src/lib.rs') {
    const rust = shellSource('src-tauri/src/lib.rs');
    for (const m of rust.matchAll(/#\[tauri::command\][\s\S]{0,200}?fn\s+(\w+)/g)) names.add(m[1]);
  }
  return [...names].sort();
}
