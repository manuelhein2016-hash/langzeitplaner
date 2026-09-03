// tests/attack/e10-network-scope.test.js — E10 · story 21.5, MEASURED AS A COUNT OF EXCEPTIONS.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE PROPERTY, OLD AND AMENDED
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   v1, story 13.4 (SUPERSEDED, amendment A1):
//     "Zero network by architecture."
//
//   v2, story 21.5 (the amendment):
//     "Network scope, replacing 13.4: in solo mode the app makes zero network requests; with a
//      Familienkreis it talks to exactly one sync endpoint and nothing else. The v1 property
//      survives as a scoped guarantee."
//
// A1 adds: *"v1's wording may remain true for solo mode and should be quoted that way in
// about/marketing copy."*
//
// Two suites already measure halves of this and neither is duplicated here:
//
//   · `tests/tier1/network-scope.test.js` — the SOURCE claim about the page. One call site in
//     all of `src/js/`, no static path to it from the boot graph, exactly one dynamic door, a
//     CSP naming no remote host.
//   · `tests/tier2/network-audit.dom.js` — the RUNTIME claim about the page. A real WKWebView
//     launch loads no family module; a full session with spies on all five socket APIs makes
//     zero calls; the family transport is confined to one origin and `/api/v1/…`.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT IS MISSING FROM BOTH, AND WHY E10 IS WHERE IT BITES
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// **Both measure the PAGE, and the page is no longer the only process that can open a socket.**
//
//   1. `src/js/platform/updater.js`'s header decides — deliberately, and with the tension
//      written out in full — that the update request is made by the NATIVE SHELL, outside the
//      WebView, *so that* the page keeps its zero. The request still leaves the Mac.
//   2. `createBridgeTransport` hands `{url, method, headers, body}` to a shell command called
//      `sync_request` and the shell opens the socket. A bridge `invoke` is not a `fetch`, is not
//      an `XMLHttpRequest`, and is invisible to every gate the product has.
//
// So as built, 21.5's "zero" is a claim about two processes and only one of them was counted.
// This file counts the other one — and it is E10's job because E10 is the epic that adds an
// outbound path (`sync_request`, being implemented in both shells while this file is written).
// A new outbound path is exactly where a zero-request promise breaks.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE THREE THINGS THIS FILE ASSERTS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   §1  THE EXCEPTIONS ARE COUNTED AND EACH ONE IS GATED BY A HUMAN. Every socket either shell
//       can open belongs to one of exactly two sanctioned jobs; each job's gate sits upstream of
//       its socket; the whole product names exactly ONE remote URL.
//   §2  LZP-1009's FEEDBACK PATH DOES NOT EXIST. E10's new ticket was not delivered. Rather than
//       leave that as a sentence in a report, it is a set of rows that go RED the day it lands —
//       so the exception count cannot widen silently, which is the only property that matters.
//   §3  NO IMAGE EXISTS ANYWHERE ON ANY PATH. "The redacted screenshot was produced by not
//       drawing" cannot be verified, because the product cannot draw: it contains no image
//       primitive at all, and neither shell can take a screenshot.
//
// EVERY ASSERTION ABOUT A SHELL IS ABOUT A PROPERTY — which function encloses a socket, whether
// a gate precedes it — and never about a line number. Both shells and `src/js/platform/net.js`
// are being edited by parallel workflows as this runs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { shippedFiles } from '../helpers/netscope.js';
import { stripCommentsAndStrings } from '../helpers/purity.js';
import {
  SHELLS, SANCTIONED, NATIVE_NETWORK,
  nativeNetworkSites, ambiguousSites, remoteUrlLiterals,
  bridgeCommands, shellSource, scanNative, guardPrecedesSocket,
} from '../helpers/native-scope.js';
import { PATH_RE, assertReachable, NetError } from '../../src/js/platform/net.js';
import { createUpdater, DAILY_MS } from '../../src/js/platform/updater.js';
import { ROUTES, API_PREFIX } from '../../server/core/router.js';

const swift = () => shellSource('shell-macos/main.swift');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · THE EXCEPTIONS, COUNTED
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · 21.5 — every socket in the product, and who is allowed to open it', () => {
  test('§1a · every native socket belongs to one of exactly TWO sanctioned jobs', () => {
    // THE MEASUREMENT. Not "we believe the shells only sync and update" but: here is every
    // primitive in either shell that puts a byte on a wire, tagged with the function around it.
    const sites = nativeNetworkSites();
    const unsanctioned = sites.filter((s) => s.job === null);
    assert.deepEqual(
      unsanctioned.map((s) => `${s.file}:${s.fn}:${s.ident}`), [],
      'a native socket sits outside the update and sync jobs — 21.5 has a third exception:\n'
      + unsanctioned.map((s) => `  ${s.file} · ${s.fn}() · ${s.ident} · ${s.text}`).join('\n'));

    // And the count of JOBS, which is the number 21.5 is really about. AT MOST two: the sync
    // endpoint (21.5's own exception) and the update check (22.3's, priced in updater.js's
    // header). "At most" rather than "exactly", because the sync half is landing in both shells
    // right now and a shell that has not grown it yet has ONE job, not a defect — §1c is the row
    // that refuses to let that be a hiding place, by making socket and door a biconditional.
    const jobs = [...new Set(sites.map((s) => s.job))].sort();
    for (const j of jobs) {
      assert.ok(['sync', 'update'].includes(j), `the product has a third network job: ${j}`);
    }
    assert.ok(jobs.includes('update'), 'no update job at all — the census read nothing');
  });

  test('§1b · NON-VACUITY — the census read both shells, and every site was placed', () => {
    // Without this row §1a is green the day a path typo makes `shellSource` return an empty
    // string, or the day `FUNC_RE` stops matching and every site lands in `<file scope>`.
    const sites = nativeNetworkSites();
    assert.ok(sites.length >= 4, `only ${sites.length} native sockets found — the census read nothing`);
    for (const shell of SHELLS) {
      const mine = sites.filter((s) => s.file === shell.name);
      assert.ok(mine.length > 0, `${shell.name} contributed no sockets — it was not read`);
      assert.ok(mine.some((s) => s.job === 'update'),
        `${shell.name} has no update socket at all — the two shells do not ship the same product`);
      assert.equal(mine.some((s) => s.fn === '<file scope>'), false,
        `${shell.name} has a socket the function scanner could not place — the census is guessing`);
    }
  });

  test('§1c · a shell has a SYNC socket exactly when it exposes the sync DOOR — neither, or both', () => {
    // WHY THIS IS AN IF-AND-ONLY-IF AND NOT "both shells sync".
    //
    // `sync_request` is being written into both shells by a parallel workflow as this file is
    // committed; at HEAD neither shell has it. "Both shells have a sync socket" would therefore be
    // a row that is red for reasons that are nobody's defect, and a row like that gets deleted.
    //
    // The biconditional is the stronger claim anyway, and it is the one 21.5 needs: a shell that
    // opens a sync socket WITHOUT exposing the bridge command has a socket no gate covers, and a
    // shell that exposes the command WITHOUT a socket is answering the page with a lie. Both are
    // failures; "the feature has not landed yet" is not.
    const sites = nativeNetworkSites();
    for (const shell of SHELLS) {
      // The door is read from the shell's OWN dispatch — the `case "…"` labels Swift answers to
      // and the `#[tauri::command]` functions Rust exports — never from a text match on the file.
      // A text match would count `sync_request` appearing in a comment, or in a case label that
      // has been renamed out of service, and this row would then be green over a live socket
      // behind a dead door. (Mutant M11: rename the case label, keep the socket.)
      const doors = bridgeCommands(shell.name);
      const hasDoor = doors.includes('sync_request');
      const hasSocket = sites.some((s) => s.file === shell.name && s.job === 'sync');
      assert.equal(hasSocket, hasDoor,
        hasDoor
          ? `${shell.name} exposes sync_request and opens no sync socket — it answers the page with a lie`
          : `${shell.name} opens a sync socket with no sync_request door — a socket no gate covers`);
    }
  });

  test('§1d · ARMED — a feedback sender planted in a shell WOULD be reported', () => {
    // The row that makes §1a a fact rather than a matcher that has stopped matching. This is the
    // shape LZP-1009 would most plausibly take in the shell, written out and shown to the census.
    const planted = [
      'func sendFeedbackNow(_ payload: Data, _ done: @escaping (String) -> Void) {',
      '    var req = URLRequest(url: URL(string: "https://feedback.example.com/v1/report")!)',
      '    req.httpMethod = "POST"',
      '    let session = URLSession(configuration: .ephemeral)',
      '    session.dataTask(with: req).resume()',
      '}',
    ].join('\n');
    const hits = scanNative(planted, 'swift', '<planted>');
    assert.ok(hits.length >= 2, 'the census did not see a URLSession planted in front of it');
    assert.deepEqual([...new Set(hits.map((h) => h.fn))], ['sendFeedbackNow']);
    assert.deepEqual([...new Set(hits.map((h) => h.job))], [null],
      'a function called sendFeedbackNow was accepted as an update or a sync job');
  });

  test('§1e · the update exception is gated on a HUMAN, upstream of the socket', () => {
    // 21.5 ↔ 22.3, as `updater.js`'s header resolves it: the request does not happen silently or
    // before the user has been told. `disclosed` is the first-run screen having said so in one
    // line; `enabled` is the settings switch. The assertion is about ORDER inside the function —
    // the gate is upstream of the session — which survives the file being edited around it.
    const g = guardPrecedesSocket(swift(), 'swift', 'updaterFetchManifest', /prefs\s*\.\s*disclosed/);
    assert.ok(g.found,
      `the manifest request is not gated on \`disclosed\` before it opens a session (${JSON.stringify(g)})`);
    const g2 = guardPrecedesSocket(swift(), 'swift', 'updaterFetchManifest', /prefs\s*\.\s*enabled/);
    assert.ok(g2.found, 'the manifest request is not gated on the settings switch');
  });

  test('§1f · the sync exception is gated on a pref, and the gate is the FIRST thing it does', () => {
    // `syncPerform` is deliberately past every gate — its own doc comment says so. The gate lives
    // in `syncPreflight`, and the property that matters is that a refusal happens before a
    // session exists: "no socket, no DNS lookup, no session".
    const src = swift();
    if (!/func syncPreflight/.test(src)) {
      // The biconditional in §1c owns this case: no door, no socket, nothing to gate. Asserted
      // rather than silently returned, so this branch cannot hide a shell that grew the socket.
      assert.equal(nativeNetworkSites().some((x) => x.file === 'shell-macos/main.swift' && x.job === 'sync'), false,
        'the Swift shell has a sync socket but no syncPreflight to gate it');
      return;
    }
    const pre = src.slice(src.indexOf('func syncPreflight'));
    const body = pre.slice(0, pre.indexOf('\nfunc ', 1));
    assert.ok(/SyncPrefs\.load\(\)\s*\.\s*enabled/.test(body),
      'syncPreflight does not read the sync-enabled pref at all');
    assert.equal(
      scanNative(body, 'swift', '<syncPreflight>').length, 0,
      'syncPreflight — the function whose whole job is to refuse — can itself open a socket');
    // And the pref defaults to OFF, so a Mac that has never joined a Familienkreis cannot sync
    // even if the page asked it to. That is 21.5's solo half, enforced below the JavaScript.
    assert.match(src, /struct\s+SyncPrefs\s*\{[\s\S]{0,400}?\benabled\b[^\n]*=\s*false/,
      'the shell sync pref does not default to false');
  });

  test('§1g · the WHOLE PRODUCT names exactly ONE remote URL, and it is the update manifest', () => {
    // The strongest single sentence available about 21.5, and the one that closes the
    // `Data(contentsOf:)` class: a primitive that can fetch only if handed a remote URL is safe
    // when there is no remote URL to hand it. The sync URL is not here because it is not a
    // literal — it is built by `assertReachable` from the origin the user typed at „Beitreten".
    const urls = remoteUrlLiterals();
    assert.equal(urls.length, 1,
      'the shells name more than one remote host:\n' + urls.map((u) => `  ${u.file}:${u.line} ${u.url}`).join('\n'));
    assert.match(urls[0].url, /^https:\/\//, 'the one remote URL is not https');
    assert.match(urls[0].url, /latest\.json$/, 'the one remote URL is not the update manifest');
    // And it is still a placeholder — LZP-1008's RUNBOOK and RELEASE-CHECKLIST both say so, and
    // the shell refuses rather than resolving some unrelated host that happens to answer.
    assert.match(urls[0].url, /OWNER-PLACEHOLDER/,
      'the release host is now real — check that RELEASE-CHECKLIST §A and the Datenschutz text (21.3) name it');
  });

  test('§1h · the second class is reported, not ignored: contentsOf: sites are enumerated', () => {
    // A census that silently dropped `Data(contentsOf:)` would be hiding the one Swift primitive
    // that reads a file and fetches a URL with the same call. It is not dropped; it is counted,
    // and §1f is the reason it is not a finding.
    const amb = ambiguousSites();
    assert.ok(amb.length > 0, 'no contentsOf: sites at all — the second-class scanner is broken');
    assert.equal(amb.every((a) => a.file === 'shell-macos/main.swift'), true,
      'the Rust shell grew a contentsOf:-shaped primitive and nothing here classifies it');
  });

  test('§1i · the page can still address exactly one origin and one path prefix', () => {
    // Not a re-run of `network-scope.test.js` — a statement about NEW paths. The one call site
    // in the page cannot be pointed at a second endpoint by adding a feature: every path that is
    // not `/api/v1/…` is refused by name, before a byte leaves the process.
    const origin = 'https://relay.example.com';
    for (const p of ['/feedback', '/api/v1/../feedback', '/api/feedback', '/api/v2/ops', '/']) {
      assert.throws(() => assertReachable(origin, p, ''), (e) => e instanceof NetError,
        `${p} was not refused by the one call site`);
    }
    assert.equal(PATH_RE.test('/api/v1/ops'), true, 'the real path is refused — the matcher is inverted');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · LZP-1009 — THE FEEDBACK PATH DOES NOT EXIST
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// E10's new ticket asked for a feedback button that sends a report — text plus a redacted
// screenshot — to a remote. It was not delivered: no module, no bridge command, no route, no
// copy, no Datenschutz sentence naming a third processor (21.3 / LZP-1001, also not delivered).
//
// A report saying "it is missing" rots in a week. These rows do not: each one asserts the
// ABSENCE, so the day 1009 lands the suite goes red at the exact place where the exception count
// widens, and the person landing it has to come here and INVERT the row rather than discover
// later that 21.5 quietly became "two endpoints and a screenshot".
//
// ⚠ INVERT, DO NOT REPAIR. If a row in §2 or §3 goes red, the feature arrived. Every one of them
// is written so that its inverted form is the assertion the feature needs.

describe('§2 · the outbound path LZP-1009 would add — measured as absent', () => {
  test('§2a · no shipped module is a feedback sender', () => {
    // `diagnostics` is DELIBERATELY NOT in this list. It is the name of a local introspection
    // method on nine shipped modules (`store.diagnostics()`, `lot.diagnostics()`, …), it is read
    // by the settings sheet and by `sync/status.js`, and none of it leaves the Mac. Including it
    // would give this row thirty permanent hits and it would be deleted within a week — which is
    // the failure mode a gate like this actually dies of. §2e is the compensating claim: whatever
    // any of them returns, there is no remote host in the shipped tree to send it to.
    const suspicious = /\b(feedback|rueckmeldung|telemetry|analytics|crashReport|sentry|bugsnag|sendBeacon)\b/i;
    const hits = [];
    for (const f of shippedFiles()) {
      // Code only. The word may appear in a design note — this file's own subject is discussed in
      // `net.js`'s header — and prose is not a sender.
      const code = stripCommentsAndStrings(f.src);
      code.split('\n').forEach((line, i) => { if (suspicious.test(line)) hits.push(`${f.rel}:${i + 1} ${line.trim()}`); });
    }
    assert.deepEqual(hits, [],
      'INVERT ME — a feedback/telemetry path exists in src/js/ and 21.5 now has a third exception:\n'
      + hits.join('\n'));
  });

  test('§2b · no bridge command in either shell can send a report', () => {
    // The door a feedback button would most naturally take, because it is the door `sync_request`
    // takes: the page hands the shell a payload and the shell opens the socket. Counting the
    // command names is the only way to see it — no grep over `src/js/` ever would.
    const cmds = bridgeCommands();
    assert.ok(cmds.length > 10, `only ${cmds.length} bridge commands found — the enumerator is broken`);
    // `update_fetch_manifest` is in both shells at every commit; `sync_request` is landing now, so
    // it is checked by §1c's biconditional rather than asserted present here.
    assert.ok(cmds.includes('update_fetch_manifest') && cmds.includes('load_board'),
      'the enumerator missed commands that certainly exist: ' + cmds.join(' '));
    const reporting = cmds.filter((c) => /feedback|report|telemetry|analytics|diagnos|crash/i.test(c));
    assert.deepEqual(reporting, [],
      'INVERT ME — a reporting bridge command exists: ' + reporting.join(', '));
  });

  test('§2c · the server speaks no route that would receive one', () => {
    const names = ROUTES.map((r) => `${r.method} ${API_PREFIX}${r.pattern}`);
    assert.ok(names.length >= 15, `only ${names.length} routes — the table was not read`);
    const receiving = names.filter((n) => /feedback|report|telemetry|analytics|log|crash/i.test(n));
    assert.deepEqual(receiving, [],
      'INVERT ME — the relay grew a route that receives reports: ' + receiving.join(', '));
  });

  test('§2e · no shipped module names a resolvable remote host', () => {
    // The compensating claim for the `diagnostics` exclusion above, and a check on §1f from the
    // page's side: every `http(s)://` literal in the whole shipped tree is a scheme fragment, the
    // SVG XML namespace, a documented placeholder, or loopback. Not one of them is a host this
    // product could resolve. A feedback endpoint would have to appear here first.
    const named = [];
    for (const f of shippedFiles()) {
      f.src.split('\n').forEach((line, i) => {
        const code = line.replace(/(^|[^:])\/\/.*$/, '$1');
        for (const m of code.matchAll(/['"`](https?:\/\/[^'"`\s]*)/g)) {
          const rest = m[1].replace(/^https?:\/\//, '');
          const host = rest.split(/[/?#]/)[0];
          const benign = host === ''                       // a bare scheme, e.g. `startsWith('https://')`
            || host === 'www.w3.org'                       // the SVG XML NAMESPACE — an identifier, never fetched
            || /[<>…]/.test(host)                          // a documented placeholder: `https://<vercel-app>…`
            || /^(?:127\.|localhost|\[::1\]|user:pass@host)/.test(host);
          if (!benign) named.push(`${f.rel}:${i + 1} ${m[1]}`);
        }
      });
    }
    assert.deepEqual(named, [],
      'INVERT ME — a shipped module names a remote host. If this is the relay, the CSP note in '
      + 'net.js\'s header applies; if it is anything else, 21.5 has a new exception:\n' + named.join('\n'));
  });

  test('§2d · and the page could not reach one if it existed — the path is refused', () => {
    // The three doors are shut independently: no sender, no command, no route. This is the
    // fourth: even a sender that existed could not use the product's one call site, because
    // `/api/v1/feedback` is a path the relay does not route and `/feedback` is a path the
    // transport refuses. LZP-1009 cannot land as a one-line change anywhere.
    assert.throws(() => assertReachable('https://relay.example.com', '/feedback', ''),
      (e) => e instanceof NetError && e.kind === 'blocked');
    assert.equal(ROUTES.some((r) => r.pattern === '/feedback'), false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · NO IMAGE EXISTS ANYWHERE ON ANY PATH
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// E10 was asked to prove that a feedback screenshot is redacted *by not drawing* — that a
// full-fidelity image of the board never exists anywhere on the path, not even for a moment in
// memory before being blurred.
//
// That claim cannot be verified, and the reason is the strongest possible form of it: **the
// product cannot draw an image at all.** There is no canvas, no `toDataURL`, no `toBlob`, no
// `OffscreenCanvas`, no `getDisplayMedia`, and neither shell can take a screenshot. A
// full-fidelity image does not exist on the path because no image does.
//
// That is a real measurement and it is the one to INVERT the day the screenshot half of 1009
// arrives — at which point "produced by not drawing" becomes a claim with something to be false
// about, and this row becomes "the only image-producing call site is the redacted renderer".

describe('§3 · the redacted-screenshot claim, measured from the other end', () => {
  const IMAGE_PRIMITIVES = [
    { name: 'canvas element', re: /createElement\s*\(\s*canvas|OffscreenCanvas|getContext\s*\(/i },
    { name: 'toDataURL', re: /\btoDataURL\b/ },
    { name: 'toBlob', re: /\btoBlob\b/ },
    { name: 'getImageData', re: /\bgetImageData\b|\bputImageData\b|\bImageData\b/ },
    { name: 'createImageBitmap', re: /\bcreateImageBitmap\b/ },
    { name: 'screen capture', re: /\bgetDisplayMedia\b|\bcaptureStream\b|\bgetUserMedia\b/ },
    { name: 'html2canvas', re: /\bhtml2canvas\b|\bdomToImage\b/ },
  ];

  test('§3a · src/js/ contains no image-producing primitive of any kind', () => {
    const hits = [];
    for (const f of shippedFiles()) {
      const code = stripCommentsAndStrings(f.src);
      code.split('\n').forEach((line, i) => {
        for (const p of IMAGE_PRIMITIVES) if (p.re.test(line)) hits.push(`${f.rel}:${i + 1} ${p.name}`);
      });
    }
    assert.deepEqual(hits, [],
      'INVERT ME — the product can now produce an image. The claim "the redacted PNG was produced '
      + 'by not drawing" is now falsifiable and must be tested rather than reported as vacuous:\n'
      + hits.join('\n'));
  });

  test('§3b · neither shell can take a screenshot', () => {
    const CAPTURE = /CGWindowListCreateImage|CGDisplayCreateImage|CGDisplayStream|SCScreenshotManager|SCStream|ScreenCaptureKit|NSBitmapImageRep|screencapture|takeSnapshot|WKSnapshotConfiguration|screenshots?::/;
    const hits = [];
    for (const shell of SHELLS) {
      shellSource(shell.name).split('\n').forEach((line, i) => {
        const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '');
        if (CAPTURE.test(code)) hits.push(`${shell.name}:${i + 1} ${code.trim().slice(0, 80)}`);
      });
    }
    assert.deepEqual(hits, [], 'INVERT ME — a shell can capture the screen:\n' + hits.join('\n'));
  });

  test('§3c · ARMED — both scanners catch what they claim to catch', () => {
    // Shown a positive of each shape, so a green §3a/§3b is a fact about the product and not
    // about a regex that stopped matching.
    const planted = 'const png = board.getContext("2d").canvas.toDataURL("image/png");';
    assert.ok(IMAGE_PRIMITIVES.some((p) => p.re.test(planted)), 'the image scanner missed a canvas');
    assert.ok(/CGWindowListCreateImage/.test('let img = CGWindowListCreateImage(rect, .optionAll, 0, [])'),
      'the capture scanner is not a matcher');
    // and the file walk really walks: the scanners above ran over the whole shipped tree.
    const files = shippedFiles();
    assert.ok(files.length > 40, `only ${files.length} shipped files scanned`);
    assert.ok(files.some((f) => f.rel === 'src/js/print.js'), 'print.js — the one renderer that COULD have drawn — was not scanned');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · THE CENSUS ITSELF, AND WHAT IT DOES NOT SAY
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · what a green §1–§3 does not claim', () => {
  test('§4a · the sanctioned-job test is a NAME test, and says so', () => {
    // A function called `syncSendEverything` would pass §1a. The census bounds the number of
    // JOBS, not the behaviour of either — `tests/tier2/network-audit.dom.js` §3 bounds the sync
    // job's behaviour, and `e10-outbound-payload.test.js` greps what it actually carries.
    // Asserting the shape here is what keeps the limitation visible rather than assumed.
    assert.equal(SANCTIONED.length, 2);
    assert.ok(SANCTIONED.every((s) => s.re.test('syncSendEverythingToEverybody') || s.job !== 'sync'));
  });

  test('§4b · a native mechanism nobody has thought of is a RED, not a silence', () => {
    // The reason `NATIVE_NETWORK` lists `NWConnection`, `CFSocket`, `TcpStream`, `ureq` and
    // `hyper` when the product uses none of them: an unlisted mechanism would make the census
    // green by not being looked for, which is how gates rot. Shown a positive of each.
    for (const [lang, planted] of [
      ['swift', 'let c = NWConnection(host: "h", port: 443, using: .tls)'],
      ['rust', 'let s = TcpStream::connect("h:443")?;'],
    ]) {
      assert.ok(NATIVE_NETWORK[lang].some((id) => id.re.test(planted)),
        `${lang}: an unlisted socket mechanism would pass unseen`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · THE COUNT — boot a solo copy, count requests; press the button, count again
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// §1 says every socket is in a sanctioned job and every job is gated. This section is the other
// half of the same question and it is the one 21.5 is actually phrased as: **a number**.
//
// The subject is `createUpdater` over a COUNTING PORT — the same four-method port
// `shell-macos/main.swift` implements — because the update manifest is the ONE request a SOLO
// Mac can make. The sync job cannot appear in this count: a solo Mac has no Familienkreis, and
// the shell's `sync_enabled` pref defaults to false (§1e).
//
// The commissioned measurement was "boot a solo copy and count; press the feedback button and
// count again". There is no feedback button (§2). So the button that IS pressed here is the one
// that exists — „Jetzt suchen" — and the shape of the answer is the shape 21.5 needs either way:
// a long stretch of zero, and then exactly one, only because a person acted.

describe('§5 · 21.5 counted: a solo launch, a whole day, and then a person', () => {
  /** The four-method port, with every call recorded. Nothing here can reach a board. */
  function countingPort(over = {}) {
    const calls = [];
    const st = { currentVersion: '2.0.0', enabled: false, disclosed: false, lastCheckAt: null, stagedVersion: null, ...over };
    return {
      calls,
      state: st,
      port: {
        status: async () => { calls.push('status'); return { ...st }; },
        noteCheck: async (at) => { calls.push('noteCheck'); st.lastCheckAt = at; },
        fetchManifest: async () => {
          calls.push('fetchManifest');            // ← THE REQUEST. This is what is being counted.
          return { ok: true, manifest: JSON.stringify({ channel: 'stable', version: '2.0.0', platforms: {} }) };
        },
        download: async () => { calls.push('download'); return { ok: true, staged: true }; },
      },
    };
  }

  const requests = (p) => p.calls.filter((c) => c === 'fetchManifest' || c === 'download').length;

  test('§5a · a FRESH INSTALL, launched and left alone for a day: ZERO requests', async () => {
    // The measurement: a Mac that has just been installed and has never been told anything. It
    // is launched, it is launched again, and a day of daily timers fires. Nothing goes out.
    const p = countingPort();                      // disclosed:false, enabled:false — a fresh install
    let t = 1_800_000_000_000;
    const u = createUpdater({ port: p.port, now: () => t });
    await u.check('launch');
    await u.check('launch');
    for (let i = 0; i < 7; i++) { t += DAILY_MS; await u.check('timer'); }
    await u.check('manual');                       // even pressing the button, before disclosure
    assert.equal(requests(p), 0,
      `a fresh solo install made ${requests(p)} requests over a week: ${p.calls.join(', ')}`);
  });

  test('§5b · disclosed but switched OFF is still ZERO — the switch turns the REQUEST off', async () => {
    // 21.5's second gate. A user who read the first-run sentence and then said no is a user who
    // makes no requests — not one who makes them silently while the hint is hidden.
    const p = countingPort({ disclosed: true, enabled: false });
    let t = 1_800_000_000_000;
    const u = createUpdater({ port: p.port, now: () => t });
    await u.check('launch');
    for (let i = 0; i < 3; i++) { t += DAILY_MS; await u.check('timer'); }
    assert.equal(requests(p), 0, `${requests(p)} requests with the switch off: ${p.calls.join(', ')}`);
  });

  test('§5c · AND THEN A PERSON ACTS — the count goes to exactly ONE', async () => {
    // The exception, measured. One press, one request. Not a session, not a stream, not a
    // heartbeat: one GET of one static file, and the count returns to being flat afterwards.
    const p = countingPort({ disclosed: true, enabled: true });
    let t = 1_800_000_000_000;
    const u = createUpdater({ port: p.port, now: () => t });
    const before = requests(p);
    await u.check('manual');                       // „Jetzt suchen"
    assert.equal(requests(p) - before, 1,
      `one press produced ${requests(p) - before} requests: ${p.calls.join(', ')}`);
    // and nothing was downloaded, because nothing was newer — a check is a check.
    assert.equal(p.calls.includes('download'), false, 'a mere check downloaded something');
  });

  test('§5d · the exception is ONE PER DAY at most, not one per launch', async () => {
    // "Roughly daily" (22.3) with `LAUNCH_GAP_MS` collapsing a burst. A Mac opened and closed six
    // times in an afternoon must not produce six requests — which is the difference between an
    // exception and a beacon.
    const p = countingPort({ disclosed: true, enabled: true });
    let t = 1_800_000_000_000;
    const u = createUpdater({ port: p.port, now: () => t });
    for (let i = 0; i < 6; i++) { t += 20 * 60 * 1000; await u.check('launch'); }
    assert.equal(requests(p), 1, `six launches in two hours produced ${requests(p)} requests`);
  });

  test('§5f · the DISCLOSURE gate alone, isolated — a switch that is on but was never explained', async () => {
    // WRITTEN BECAUSE A MUTANT SURVIVED. Deleting `disclosed` from `updater.js` left §5a and §5b
    // green, because in both of those the OTHER gate is also shut: §5a has `enabled:false` too,
    // and §5b is the enabled gate's own row. The two gates are redundant in the ordinary cases,
    // which is good design and bad testing — so this row is the one case where only `disclosed`
    // stands: the switch is ON and the first-run screen has never said what it does.
    //
    // It is not hypothetical. `enabled` lives in the shell's own pref file; a restored machine,
    // a copied Application Support directory, or a shell default flipped in a later release all
    // produce exactly this state, and in every one of them 21.5's promise is the disclosure.
    const p = countingPort({ disclosed: false, enabled: true });
    let t = 1_800_000_000_000;
    const u = createUpdater({ port: p.port, now: () => t });
    await u.check('launch');
    await u.check('manual');
    for (let i = 0; i < 3; i++) { t += DAILY_MS; await u.check('timer'); }
    assert.equal(requests(p), 0,
      `${requests(p)} requests were made by a Mac that has never been told: ${p.calls.join(', ')}`);
  });

  test('§5e · ARMED — the counter counts, and the port surface cannot reach a board', async () => {
    // Non-vacuity on the count itself: shown a run that DOES make requests. And the standing
    // claim from 22.7, re-measured here because this file is the one that counts: across every
    // run above, the updater called four methods and no others, and not one of them can read or
    // write a board, an op log, a checkpoint or a snapshot.
    const p = countingPort({ disclosed: true, enabled: true });
    let t = 1_800_000_000_000;
    const u = createUpdater({ port: p.port, now: () => t });
    for (let i = 0; i < 3; i++) { t += DAILY_MS; await u.check('timer'); }
    assert.equal(requests(p), 3, 'the counter is not counting');
    assert.deepEqual([...new Set(p.calls)].sort(), ['fetchManifest', 'noteCheck', 'status'],
      'the updater called a port method outside the four it is allowed');
  });
});
