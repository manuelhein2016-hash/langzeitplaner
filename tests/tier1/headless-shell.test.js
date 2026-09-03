// tests/tier1/headless-shell.test.js
//
// A headless run must not present UI.
//
// `tests/run-dom-tests.sh` launches the shell once per tier-2 file — 26 launches per
// `npm run test:dom`, and the agents run it constantly. Until 2026-08-29 the shell called
// `makeKeyAndOrderFront` and `NSApp.activate(ignoringOtherApps:)` unconditionally, so every
// run stole focus and flashed a window per file.
//
// The subtlety worth keeping: the activation policy must be `.accessory`, NOT `.prohibited`.
// `.prohibited` looks more correct and is wrong — it denies the process the GUI session context
// WebKit needs to reach the WebCrypto master key in the login Keychain, which took
// `crypto-keystore-phase1` from 4/4 to 1/4 with `KeyStoreUnavailableError`. That is ADR 002 §1's
// engine-difference #8 arriving from an unexpected direction, so it is asserted here rather than
// left to be rediscovered by whoever next tries to tidy this up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  presentationSites, shellSource, rustSource, swiftRefusalNames, rustRefusalNames,
  cargoManifest,
} from '../helpers/helper-hygiene.js';

test('every UI-presenting call in the shell is guarded by isHeadless', () => {
  const unguarded = presentationSites()
    .filter((s) => !s.guarded)
    .map((s) => `main.swift:${s.n}  ${s.line}`);

  assert.deepEqual(
    unguarded,
    [],
    'A headless run would present UI. `npm run test:dom` launches the shell once per test ' +
      'file, so an unguarded call here flashes a window — or steals focus — 26 times per run:\n  ' +
      unguarded.join('\n  '),
  );
});

test('the headless activation policy is .accessory, never .prohibited', () => {
  const src = shellSource();
  assert.match(
    src,
    /isHeadless\s*\?\s*\.accessory\s*:\s*\.regular/,
    'headless runs must use .accessory',
  );
  assert.ok(
    !/isHeadless\s*\?\s*\.prohibited/.test(src),
    '.prohibited denies WebKit the session context it needs for the WebCrypto master key in the ' +
      'login Keychain — measured: crypto-keystore-phase1 goes 4/4 -> 1/4 with ' +
      'KeyStoreUnavailableError. Use .accessory.',
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// LZP-1002 — `sync_request`, and the shape that keeps it from being an SSRF primitive
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// WHY THESE ROWS ARE STATIC, AND WHAT THEY ARE NOT. The BEHAVIOUR of the sync transport is
// characterized in a real WKWebView by `tests/tier2/shell-transport.dom.js` — that is where the
// refusals, the red-team sweep and the real round trip live, because only a running shell can
// answer them. What node can do, and what the tier-2 suite cannot, is fail the day somebody
// deletes a rule from the source while every behavioural test keeps passing for a smaller reason.
//
// So each row below pins one INVARIANT OF THE SOURCE that has a specific way of being lost:
// a pinned origin that becomes a parameter, a delegate that starts following redirects, a
// session that grows a cookie jar, a gate that moves below the socket. Every one of them is a
// change somebody could make in good faith while `npm run test:dom` stayed green, because the
// tier-2 run that would catch it is the one that needs a relay.
//
// ADR 003 §7 gate 3, as AMENDED by this pass: the navigation delegate does NOT open for the sync
// origin — the page never opens the socket, so opening it would be a loosening that buys nothing
// — and the pinned-origin bridge command is the gate. The reasoning is written out above
// `sync_request` in main.swift; these rows are what holds it.

/**
 * main.swift with every whole-line `//` comment blanked, so PROSE ABOUT A RULE can never satisfy
 * a check for the rule. That is not hypothetical here: the note above the origin pin says, in
 * words, "there is no `args["origin"]` in this file" — read against the raw source, the row that
 * forbids `args["origin"]` would fail on its own explanation.
 *
 * Trailing comments are deliberately LEFT: stripping from the first `//` on a line would cut
 * `"\(scheme)://\(host)"` in half and quietly break every check downstream of it.
 */
function shellCode() {
  return shellSource()
    .split('\n')
    .map((l) => (l.trim().startsWith('//') ? '' : l))
    .join('\n');
}

/** The body of the Swift declaration whose header contains `needle`, by brace matching. */
function swiftBlock(needle, src = shellCode()) {
  const at = src.indexOf(needle);
  assert.notEqual(at, -1, `main.swift contains no ${needle}`);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  assert.fail(`${needle} never closes`);
  return '';
}

/** The body of one Swift function, by name. */
const swiftFunc = (name, src = shellCode()) => swiftBlock(`func ${name}(`, src);

test('the shell implements sync_request — the command net.js has been calling into nothing', () => {
  const code = shellCode();
  assert.match(code, /case "sync_request":/,
    'net.js chooseTransport() picks the bridge whenever an invoke exists, which in this shell is '
      + 'always. Without this case every family feature runs on a command the host rejects.');
  assert.match(code, /case "sync_status":/, 'the settings sheet has no way to ask what is configured');
  assert.match(code, /case "sync_enabled":/,
    'ADR 003 §7 gate 3 names a `sync_enabled` shell pref; without it the gate is a comment');
});

test('the web view may name a path, never a host: the origin is configuration, not a parameter', () => {
  const code = shellCode();
  // THE defect this whole design exists to prevent. If `origin`, `host`, `scheme` or `port` ever
  // becomes an argument of the bridge command, the shell is an open proxy from a native process:
  // the page could reach the LAN, the router, localhost and the link-local metadata endpoint,
  // outside every rule the WebView applies to itself.
  for (const key of ['origin', 'host', 'scheme', 'port', 'base', 'endpoint']) {
    assert.ok(
      !new RegExp(`args\\[\\s*"${key}"\\s*\\]`).test(code),
      `main.swift reads args["${key}"] — the page can name where a request goes`,
    );
  }
  // The four arguments the contract actually has (net.js §6), and no fifth.
  const preflight = swiftFunc('syncPreflight');
  const argKeys = [...preflight.matchAll(/args\[\s*"([^"]+)"\s*\]/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(argKeys)], ['body', 'headers', 'method', 'url'],
    'syncPreflight reads an argument the sync_request contract does not have');
});

test('the origin comes from build configuration, and the headless override is isHeadless-gated', () => {
  const body = swiftFunc('syncOriginSetting');
  assert.match(body, /isHeadless,\s*let\s+o\s*=\s*argValue\("--sync-origin"\)/,
    '--sync-origin must be honoured only in a headless run, exactly like --updater-manifest-url');
  assert.match(body, /isHeadless,\s*let\s+e\s*=\s*ProcessInfo/,
    'the LZP_SYNC_ORIGIN override must be isHeadless-gated too');
  // A production build that honoured either would have a trivially redirectable sync path.
  const lines = body.split('\n').filter((l) => /argValue|ProcessInfo/.test(l) && !l.trim().startsWith('//'));
  assert.equal(lines.length, 2, `unexpected override sites in syncOriginSetting: ${lines.join(' | ')}`);
  for (const l of lines) assert.match(l, /isHeadless/, `an ungated override: ${l.trim()}`);
});

test('the gate runs before the socket: no URLSession exists until every check has passed', () => {
  // Story 21.5 — "in solo mode the app makes zero network requests". That is a property of the
  // ORDER: `syncPreflight` is pure and local, `syncPerform` is where a session is allocated, and
  // the only path from one to the other is a `.success`. A refactor that inlined the request into
  // the command would keep every tier-2 refusal green while resolving a name on every call.
  const preflight = swiftFunc('syncPreflight');
  assert.ok(!/URLSession/.test(preflight), 'syncPreflight allocates a session — it must stay pure');
  assert.ok(!/dataTask|resume\(\)/.test(preflight), 'syncPreflight starts a request');

  const cmd = swiftFunc('syncRequest');
  assert.match(cmd, /syncPreflight\(args\)/, 'sync_request no longer goes through the preflight');
  assert.ok(!/URLSession/.test(cmd), 'sync_request builds a session outside syncPerform');
  assert.ok(cmd.indexOf('case .failure') < cmd.indexOf('syncPerform'),
    'the refusal branch must come before the performing one, so a reader cannot miss it');

  // The switch is the FIRST thing the preflight asks. ADR 003 §7 gate 3.
  const firstCheck = preflight.indexOf('SyncPrefs.load().enabled');
  assert.notEqual(firstCheck, -1, 'syncPreflight does not consult the sync_enabled pref at all');
  assert.ok(firstCheck < preflight.indexOf('pinnedSyncOrigin'),
    'the enabled gate must run before anything else — it is the one story 21.5 names');
});

test('https only, and no loopback, link-local, private range or IP literal — even from config', () => {
  const norm = swiftFunc('normalizeSyncOrigin');
  assert.match(norm, /scheme == "https"/, 'the origin scheme is no longer pinned to https');
  assert.match(norm, /isPrivateOrLocalSyncHost\(host\)/,
    'the origin host is no longer checked against the local/private rule');
  // The one carve-out, and it must stay headless-only: `node server/dev-server.mjs` binds loopback.
  assert.match(norm, /isHeadless && scheme == "http" && isLoopbackSyncHost\(host\)/,
    'the http-to-loopback dev exception must be spelled out and isHeadless-gated');

  const host = swiftFunc('isPrivateOrLocalSyncHost');
  assert.match(host, /isLoopbackSyncHost/, 'loopback is not refused');
  assert.match(host, /h\.contains\(":"\)/, 'IPv6 literals — ::1, fe80::, fd00:: — are not refused');
  assert.match(host, /parts\.count == 4/, 'IPv4 literals are not refused');
  for (const suffix of ['.local', '.lan', '.internal', '.home.arpa']) {
    assert.ok(host.includes(`"${suffix}"`), `${suffix} is no longer treated as a LAN name`);
  }
  assert.match(host, /!h\.contains\("\."\)/, 'a single-label LAN name like `router` is not refused');
});

test('the URL is REBUILT from the pin and required to equal the argument, byte for byte', () => {
  // Defence in depth, and it is the layer with no behavioural test of its own: with the origin,
  // path and query rules all in place I could not construct an input that this check refuses and
  // they accept, so a mutant that removes it SURVIVES the tier-2 suite. That is exactly the case
  // a static row is for. The rule is `assertReachable`'s discipline on the far side of the
  // bridge — build the URL from the pinned origin, then require the argument to BE it — and it is
  // what keeps a future relaxation of the path or query rule from silently becoming an origin
  // relaxation as well.
  const fn = swiftFunc('syncCanonicalURL');
  assert.match(fn, /let rebuilt = pinned \+ path/,
    'the URL is no longer rebuilt from the pinned origin');
  assert.match(fn, /rebuilt == raw/,
    'the rebuild is no longer compared to the argument — "normalise, then use" is where the '
      + 'parser-differential bugs live');
  assert.ok(fn.indexOf('origin == pinned') < fn.indexOf('rebuilt == raw'),
    'the origin comparison must come first, so a mismatch is reported as off-origin');
});

test('no redirect is followed, and the reply names the URL the bytes came from (FINDING P-5)', () => {
  const code = shellCode();
  assert.match(code, /willPerformHTTPRedirection/,
    'URLSession follows redirects by default; refusing one takes this delegate method');
  const del = swiftBlock('final class SyncRequestDelegate');
  const at = del.indexOf('willPerformHTTPRedirection');
  assert.notEqual(at, -1, 'the redirect refusal is not in the delegate that performs the request');
  assert.match(del.slice(at, at + 600), /completionHandler\(nil\)/,
    'the redirect delegate must answer nil — anything else follows the redirect');
  assert.match(code, /"reason": "redirect_refused"/, 'a followed redirect is not reported as blocked');
  // The checkable half: net.js refuses a reply whose url is not the one it asked for.
  assert.match(code, /"url": finalURL/, 'the reply no longer names its final URL');
  assert.match(code, /"redirected": false/, 'the reply no longer states that it did not redirect');
});

test('nothing ambient rides along: no cookie jar, no credential store, no cache', () => {
  const perform = swiftFunc('syncPerform');
  assert.match(perform, /URLSessionConfiguration\.ephemeral/, 'the session is no longer ephemeral');
  assert.match(perform, /httpCookieAcceptPolicy = \.never/, 'the session accepts cookies');
  assert.match(perform, /httpCookieStorage = nil/, 'the session has a cookie jar');
  assert.match(perform, /urlCredentialStorage = nil/, 'the session can hold credentials');
  assert.match(perform, /urlCache = nil/, 'the session has a cache an intermediary could read');
  assert.match(perform, /timeoutIntervalForRequest/, 'a request without a timeout never fails, it hangs');
  const pre = swiftFunc('syncPreflight');
  assert.match(pre, /httpShouldHandleCookies = false/, 'the request itself may still carry cookies');
});

test('the header surface is an allowlist, and Cookie/Host are not on it', () => {
  const src = shellCode();
  const at = src.indexOf('let SYNC_HEADER_ALLOWLIST');
  assert.notEqual(at, -1, 'there is no header allowlist — the page can set any header it likes');
  const decl = src.slice(at, src.indexOf(']', at) + 1);
  for (const name of ['x-lzp-protocol', 'x-lzp-client', 'authorization', 'content-type']) {
    assert.ok(decl.includes(`"${name}"`), `${name} is missing — buildRequest emits it`);
  }
  for (const name of ['cookie', 'host', 'origin', 'referer', 'x-forwarded-for']) {
    assert.ok(!decl.includes(`"${name}"`), `${name} is on the allowlist — that is ambient authority`);
  }
  const pre = swiftFunc('syncPreflight');
  assert.match(pre, /SYNC_HEADER_ALLOWLIST\.contains\(name\)/, 'the allowlist is declared but not used');
  assert.match(pre, /0x20 && \$0\.value < 0x7F/,
    'a header value must be printable ASCII — a CR/LF is header injection');
});

test('the headers URLSession adds for free are pinned — no OS build, no locale', () => {
  // MEASURED, not assumed. Against a loopback relay that echoes what it receives, an unpinned
  // URLSession sent `User-Agent: LangzeitPlaner/1.0.0 CFNetwork/3860.700.1 Darwin/25.6.0` and
  // `Accept-Language: en-US,en;q=0.9` — this Mac's macOS build and the user's language
  // preferences, on every sync, in a transport whose claim is that it carries a signed request
  // and nothing ambient. Neither header is in ADR 003 §2 and neither is in
  // `docs/v2/server-metadata.md`'s inventory, so both were metadata the inventory did not know
  // about.
  const pre = swiftFunc('syncPreflight');
  assert.match(pre, /setValue\("LangzeitPlaner", forHTTPHeaderField: "User-Agent"\)/,
    'the agent is no longer a constant — the OS build and the CFNetwork version travel again');
  assert.match(pre, /setValue\("\*", forHTTPHeaderField: "Accept-Language"\)/,
    'the locale travels again');
  assert.match(pre, /forHTTPHeaderField: "Accept"\)/, 'Accept is unpinned');
  // The version belongs in X-LZP-Client, once, where the protocol puts it.
  assert.ok(!/User-Agent.*\\\(/.test(pre), 'the agent interpolates something — keep it a constant');
});

test('both caps are real, and they are the numbers net.js and ADR 003 §6.1 already use', () => {
  const src = shellSource();
  assert.match(src, /SYNC_MAX_REQUEST_BYTES = 4 \* 1024 \* 1024/, 'the 4 MiB request cap moved');
  assert.match(src, /SYNC_MAX_RESPONSE_BYTES = \d/, 'there is no response cap at all');
  assert.match(src, /SYNC_TIMEOUT_SECONDS: TimeInterval = 15/, 'the 15 s timeout moved');
  const pre = swiftFunc('syncPreflight');
  assert.match(pre, /bodyData\.count > SYNC_MAX_REQUEST_BYTES/, 'the request cap is declared but not enforced');
  const del = swiftBlock('final class SyncRequestDelegate');
  assert.match(del, /buffer\.count \+ data\.count > SYNC_MAX_RESPONSE_BYTES/,
    'the response cap must be enforced as the bytes arrive, not after they are all in memory');
});

test('the shipped build names no relay: SYNC_ORIGIN_BUILTIN is empty, so solo refuses locally', () => {
  // The same discipline as the updater's OWNER-PLACEHOLDER. There is no relay yet (ADR 003 §1
  // names a host that does not exist), and a placeholder host baked into a shipped binary is a
  // lie that resolves. Empty means every sync_request is refused before a socket exists.
  assert.match(shellSource(), /let SYNC_ORIGIN_BUILTIN = ""/,
    'a relay host has been baked into the shipping shell — say so in the release notes, and check '
      + 'that ADR 003 §1 and the Datenschutz copy name the same host');
});

test('gate 3 is the bridge command, not the navigation delegate — the ADR amendment, held', () => {
  // ADR 003 §7 gate 3 asks the navigation delegate to "permit exactly the one sync origin" once
  // sync_enabled is set. That is a loosening and it is deliberately not built: the page never
  // opens the socket, so it would buy nothing and would let page script navigate to and pull
  // subresources from a remote host in the one state where this machine has something to leak.
  const decide = swiftBlock('decidePolicyFor navigationAction');
  assert.match(decide, /scheme == APP_SCHEME/, 'the navigation gate no longer pins the app scheme');
  assert.match(decide, /scheme == "about"/, 'about: is no longer allowed — about:blank is used');
  assert.ok(!/sync|SYNC|origin/.test(decide),
    'the navigation delegate now consults the sync origin — ADR 003 §7 gate 3 was built as '
      + 'written instead of as amended, and that is a loosening');
  assert.match(decide, /host\?\.lowercased\(\) \?\? APP_HOST\) == APP_HOST/,
    'app:// with any host reaches the same bundle files under a second origin');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// LZP-1002 · ONE CONTRACT, TWO SHELLS — held by a row rather than by hand
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `sync_request` is published once (`src/js/platform/net.js` §6) and implemented twice. The
// Swift half is verified end to end in the shipped `.app` (`docs/v2/SHELL-VERIFICATION.md`); the
// Rust half **has never been compiled** — there is no `cargo` on this machine (PLAN.md risk R8)
// — so nothing but source-level rows can hold it to the contract at all.
//
// The refusal VOCABULARY is the right thing to hold, because it is the one thing a test cannot
// use to tell the two shells apart. If Swift grows a rule Rust does not have, a build on the
// other shell is quietly more permissive than the one that was demonstrated, and the SSRF table
// in SHELL-VERIFICATION.md stops describing it. Until `cargo` exists, this row is the only thing
// standing between the two.

test('both shells refuse in the same words — the Rust half is reviewed, so hold it to the Swift', () => {
  const swift = swiftRefusalNames();
  const rust = rustRefusalNames();
  assert.ok(swift.length >= 16, `only ${swift.length} Swift refusals — the enum moved`);
  assert.deepEqual(rust, swift,
    'the two shells no longer refuse in the same words. `createBridgeTransport` maps every one of '
      + 'them to `blocked`, so a name that exists in one shell and not the other is a rule that '
      + 'exists in one shell and not the other — which is exactly the drift the demonstration in '
      + 'docs/v2/SHELL-VERIFICATION.md would not catch, because it only ever ran the Swift.');
});

test('the Rust half mirrors the Swift half rule for rule — the seven checks, by name', () => {
  const rust = rustSource();
  // 1 · the switch, first, before anything is built.
  assert.match(rust, /SyncPrefs::load\([^)]*\)/, 'the Rust shell no longer reads sync_enabled');
  assert.match(rust, /sync_refusal::SYNC_DISABLED/, 'the Rust shell no longer refuses when sync is off');
  // 2 · the pin is configuration, never a parameter. If `args` ever grows an origin, this fails.
  assert.equal(/"origin"\s*\]/.test(rust), false, 'the Rust shell reads an origin off the args');
  assert.match(rust, /SYNC_ORIGIN_BUILTIN/, 'the Rust shell no longer has a pinned origin');
  // 3 · the canonical rebuild, and byte equality with what the page sent.
  assert.match(rust, /sync_refusal::URL_NOT_CANONICAL/, 'the Rust shell dropped the byte-equality check');
  // 4 · method + header allowlist.
  assert.match(rust, /sync_refusal::HEADER_NOT_ALLOWED/, 'the Rust shell dropped the header allowlist');
  assert.equal(/"cookie"/.test(rust.toLowerCase().split('sync_header_allowlist')[1]?.slice(0, 400) ?? ''),
    false, 'Cookie reached the Rust allowlist');
  // 5 · both caps.
  assert.match(rust, /SYNC_MAX_REQUEST_BYTES/, 'the Rust shell dropped the request cap');
  assert.match(rust, /SYNC_MAX_RESPONSE_BYTES/, 'the Rust shell dropped the response cap');
  // 6 · no redirect followed, and the reply names the URL.
  assert.match(rust, /redirect::Policy::none\(\)/, 'the Rust shell follows redirects again');
  assert.match(rust, /"redirect_refused"/, 'the Rust shell no longer reports a refused redirect');
  assert.match(rust, /"url"/, 'the Rust shell no longer names the URL the bytes came from');
  // 7 · nothing ambient. reqwest's cookie store lives behind its `cookies` cargo feature, so on
  // this shell "no cookie jar" is a DEPENDENCY fact rather than a builder call — asserted where
  // it actually lives, in Cargo.toml, by the row below. Here: nothing constructs one.
  assert.equal(/cookie_store\(true\)|Jar::default|cookie_provider/.test(rust), false,
    'the Rust shell grew a cookie jar');
  assert.match(rust, /https_only\(true\)/, 'the Rust shell will now speak plaintext http');
});

test('the Rust half declares its own dependency, and the Cargo line is actually there', () => {
  // The hand-off that would otherwise be a sentence in a report: the Rust `sync_request` cannot
  // compile without `reqwest`, and `src-tauri/Cargo.toml` is a different owner's file. A row is
  // cheaper than remembering.
  const cargo = cargoManifest();
  assert.match(cargo, /^reqwest = \{ version = "0\.12"/m,
    'src-tauri/src/lib.rs uses reqwest and Cargo.toml does not declare it — the Tauri build '
      + 'cannot compile. See docs/v2/SHELL-VERIFICATION.md §"what is still unproven".');
  assert.match(cargo, /rustls-tls/, 'reqwest without rustls-tls pulls in the system OpenSSL');
  // `default-features = false` is what keeps the `cookies` feature — and therefore any cookie
  // store at all — out of the Rust shell. It is the Rust spelling of the Swift shell's
  // `cfg.httpCookieStorage = nil`, and it is load-bearing rather than tidy.
  assert.match(cargo, /reqwest = \{[^}]*default-features = false/,
    'reqwest default features are on — the cookie store is back in the Rust shell');
  assert.equal(/reqwest = \{[^}]*"cookies"/.test(cargo), false,
    'the reqwest `cookies` feature is enabled — this transport carries nothing ambient');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// LZP-1002 · THE REDACTION BOUNDARY'S NEWEST EDGE — a native process that now speaks HTTP
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// "Zero bytes of a Privat entry leave this Mac" has held four rounds against the JS layer, the
// projection, the seal and the relay. `sync_request` opens a FIFTH surface, and it is a different
// kind: a native process, outside the WebView, that holds the request in memory, can write to
// stdout, and hands a reply back to the page. Three new places bytes could surface:
//
//   1. **stdout / a log file.** A `print()` of the URL would put the space id in whatever
//      captures the process's output; a `print()` of the body would put a sealed envelope batch
//      there. The body is ciphertext, so the second is a smaller leak than the first — but ADR
//      003 §6.2 and `server-metadata.md` both treat the space id as metadata worth protecting,
//      and the shell is not exempt from a rule the server keeps.
//   2. **the reply's `detail` field.** `URLError.localizedDescription` is written by the OS and
//      routinely embeds the failing URL. It reaches page script. That is acceptable — the page
//      built the URL — but it must never be the BODY, which the page did not.
//   3. **the pref file.** `sync.json` is written on every `set_shell_pref`; anything the shell
//      chose to remember about a request would land on disk beside the board.
//
// These rows are cheap and they are the only thing standing between "we thought about it" and a
// grep. `docs/v2/SHELL-VERIFICATION.md` §7 records the whole boundary re-run.

test('the sync section writes nothing to stdout — no URL, no body, no space id in a log', () => {
  const src = shellSource();
  const start = src.indexOf('// ── LZP-1002 · `sync_request`');
  const end = src.indexOf('// ── serving the web bundle over a custom scheme');
  assert.ok(start > 0 && end > start, 'the sync section moved — this row cannot find it');
  const section = src.slice(start, end);
  const lines = section.split('\n')
    .map((l, i) => ({ n: i + 1, l: l.trim() }))
    .filter(({ l }) => !l.startsWith('//') && !l.startsWith('///'))
    .filter(({ l }) => /\b(print|NSLog|os_log|debugPrint|dump)\s*\(/.test(l));
  assert.deepEqual(lines.map((x) => x.l), [],
    'the sync section prints. A URL on stdout is the space id on stdout (ADR 003 §6.2); a body '
      + 'on stdout is a sealed envelope batch on stdout. Neither belongs in a log.');
});

test('the request body is never interpolated into a string the shell keeps or returns', () => {
  const src = shellSource();
  const start = src.indexOf('// ── LZP-1002 · `sync_request`');
  const end = src.indexOf('// ── serving the web bundle over a custom scheme');
  const section = src.slice(start, end);
  // `bodyText` and `bodyData` are the only names the body ever has in this file. They may be
  // measured (`.count`), compared and assigned to `httpBody`; they may not be put in a message.
  for (const m of section.matchAll(/\\\(([^)]*)\)/g)) {
    assert.equal(/bodyText|bodyData|plan\.request\.httpBody/.test(m[1]), false,
      `the request body is interpolated into a string: \\(${m[1]})`);
  }
  // …and the reply's `detail` is only ever an OS error description.
  for (const m of section.matchAll(/"detail":\s*([^,\]]+)/g)) {
    assert.match(m[1].trim(), /localizedDescription/,
      `the reply's \`detail\` carries something other than an OS error description: ${m[1].trim()}`);
  }
});

test('the sync pref file holds one boolean and nothing about any request', () => {
  // `swiftBlock` rather than an index search, because a literal brace in a test BODY confuses
  // `suite-integrity.test.js`'s brace matcher and makes this row look like it asserts nothing.
  const body = swiftBlock('struct SyncPrefs');
  assert.match(body, /var enabled = false/, 'the sync pref no longer defaults to off');
  // The dictionary that is actually written. One key.
  const written = body.match(/let o: \[String: Any\] = (\[[^\]]*\])/);
  assert.ok(written, 'sync.json is no longer written from a literal — check what it now holds');
  assert.equal(written[1].replace(/\s/g, ''), '["enabled":enabled]',
    `sync.json now carries ${written[1]} — a request must leave nothing on disk`);
});

test('sync_status discloses the pin and the switch, and nothing about any request', () => {
  const body = swiftBlock('func syncStatus()');
  // The origin IS disclosed on purpose (the settings sheet shows the one address this Mac may
  // talk to, and the page could already name any URL it liked). Everything else must be absent.
  const keys = [...body.matchAll(/o\["([a-zA-Z]+)"\]|"([a-z]+)":/g)]
    .map((m) => m[1] || m[2]).filter(Boolean);
  const allowed = new Set(['enabled', 'configured', 'origin', 'originConfigured', 'reason',
    'message', 'de', 'en']);
  for (const k of keys) {
    assert.ok(allowed.has(k), `sync_status now reports \`${k}\` — is it about a REQUEST?`);
  }
});
