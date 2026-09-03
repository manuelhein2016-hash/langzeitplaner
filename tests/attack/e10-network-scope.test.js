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
// LZP-1009's client half, imported so §2 and §3 assert against the SHIPPED feature rather than
// against a description of it.
import { FEEDBACK_PATH } from '../../src/js/feedback/port.js';
import { Raster, encodePng, EMITTED_CHUNKS } from '../../src/js/feedback/png.js';
import { collectPrimitives, assertNumericOnly } from '../../src/js/feedback/geometry.js';
import { renderRedactedBoard } from '../../src/js/feedback/redact.js';

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
// §2 · LZP-1009 — THE FEEDBACK PATH, NOW THAT IT EXISTS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// ██ INVERTED 2026-09-03, WHEN LZP-1009 LANDED. ██
//
// This section used to measure the ABSENCE of a feedback path in five places, each written so
// that "the day 1009 lands the suite goes red at the exact place where the exception count
// widens". The feature has landed, so the rows have been INVERTED — the file's own instruction,
// in its own capitals — rather than repaired, deleted, or relaxed. Each one now asserts the
// BOUND that the delivered feature must stay inside, and each is still the row that reddens if
// the exception count widens again.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ⚠ TWO OF THESE ROWS DID NOT GO RED ON THEIR OWN, AND THAT IS A FINDING ABOUT THE ROWS
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// §2a and §3a were both still GREEN after the whole feature shipped. Neither was green because
// its claim still held:
//
//   · **§2a** matched `/\bfeedback\b/i` against code with comments and strings blanked. A
//     subsystem of seven modules under `src/js/feedback/` spells itself `openFeedback`,
//     `setFeedbackPort`, `feedbackPort`, `initFeedback` — and **`\bfeedback\b` matches none of
//     them**, because there is no word boundary inside `setFeedbackPort`. The import specifier
//     that names the directory is a string, and strings are blanked. Measured: **0 hits** over
//     the shipped tree with the sender in it.
//   · **§3a** looked for `canvas`, `getContext`, `toDataURL`, `toBlob`, `getImageData`,
//     `OffscreenCanvas`, `createImageBitmap`, `getDisplayMedia`, `html2canvas`. The delivered
//     renderer uses **none of them** — it is a hand-written indexed-PNG encoder over a byte
//     array (`src/js/feedback/png.js`), which is the whole point of it — so the scanner had
//     nothing to find while the product had gained the ability to draw.
//
// Both are the exact failure mode this file warns about in its own header: *"it goes green the
// day its regex stops matching anything, and nobody notices, because green is what it looked
// like when it worked."* The gates did not rot; they were **never able** to see the shape the
// feature actually took. Recorded as finding **E10-1009-B**, and the inverted rows below are
// written to be checkable by CONSTRUCTION — an allowlist of files and an enumeration of call
// sites — rather than by a word that a future author's naming may or may not contain.

describe('§2 · the outbound path LZP-1009 adds — bounded, not absent', () => {
  test('§2a · the feedback sender is CONFINED to src/js/feedback/ plus TWO named seams', () => {
    // INVERTED. The old row said "no shipped module is a feedback sender" and it could not see
    // the one that landed (see this section's header). The property that replaces it is one a
    // regex cannot miss: **which FILES may participate at all**.
    //
    // `src/js/feedback/*` is the subsystem. `src/js/settings.js` is the ONE other file allowed to
    // mention it, and only to draw the Hilfe section — Principle 10's "it is never a floating
    // button on the board" is exactly a claim about the set of files that may open this screen,
    // so a set is what is asserted. A mention in `board.js`, `main.js` or `boot.js` reddens here.
    //
    // ██ THE SET GREW BY EXACTLY ONE FILE THIS PASS, AND THE ROW SAYS WHICH AND WHY. ██
    //
    // `family/mount.js` is the BINDER (LZP-1009 / E10-1009-A). It had to be that file and no
    // other: `feedback/port.js` holds a port precisely so nothing in the feedback tree imports a
    // transport, and the module that already owns one is the single dynamic door ADR 003 §7 gate
    // 2 allows. So the allowlist is now TWO seams with two different jobs, and each is asserted
    // to do only its own below — the drawer may not bind, and the binder may not open the screen.
    // A third file, or either seam taking the other's job, still reddens here.
    const ALLOWED_DIR = 'src/js/feedback/';
    const DRAWS = 'src/js/settings.js';        // opens the screen; holds no transport, ever
    const BINDS = 'src/js/family/mount.js';    // holds the transport; never opens the screen
    const SEAMS = [BINDS, DRAWS].sort();
    const mentions = /feedback/i;
    const outside = [];
    for (const f of shippedFiles()) {
      if (f.rel.startsWith(ALLOWED_DIR)) continue;
      // Comments and strings INCLUDED this time, deliberately: an import specifier is a string,
      // and "which file imports the feedback tree" is the whole question. The old row blanked
      // them and that is half of why it saw nothing.
      f.src.split('\n').forEach((line, i) => {
        if (mentions.test(line)) outside.push(`${f.rel}:${i + 1} ${line.trim().slice(0, 90)}`);
      });
    }
    const files = [...new Set(outside.map((h) => h.split(':')[0]))].sort();
    assert.deepEqual(files, SEAMS,
      'the feedback path is referenced outside its own directory and the two named seams.\n'
      + 'Principle 10: it lives in Einstellungen/Hilfe and is NEVER a button on the board:\n'
      + outside.join('\n'));

    // THE BINDER MAY NOT OPEN THE SCREEN. `openFeedback` is `ui.js`'s only exported way in, and
    // Principle 10 is a claim about who may call it: Einstellungen/Hilfe, and nothing else. A
    // `mount.js` that could open it would be a floating button one refactor away.
    const bindCode = stripCommentsAndStrings(shippedFiles().find((f) => f.rel === BINDS).src);
    assert.equal(/openFeedback|buildHelpSection|initFeedback/.test(bindCode), false,
      'family/mount.js reaches the feedback SCREEN — it may bind the sender and nothing else');
    assert.match(bindCode, /setFeedbackPort\s*\(/, 'family/mount.js no longer binds the sender at all');
    // and the seam really is a seam: it draws a section and binds an environment, and it does
    // not send anything, because settings.js has no transport and must never acquire one.
    const seamSrc = shippedFiles().find((f) => f.rel === DRAWS).src;
    assert.match(seamSrc, /buildHelpSection\(body, api\)/, 'the seam does not draw the Hilfe section');
    // CODE ONLY for this half. The seam's own comment EXPLAINS that the sender is a port bound by
    // whoever holds a transport, and a scanner that counted that sentence would be a scanner
    // nobody could write an explanation past. (It tripped on its own docblock the first time.)
    const seamCode = stripCommentsAndStrings(seamSrc);
    assert.equal(/setFeedbackPort|chooseTransport|createBridgeTransport|createFetchTransport/.test(seamCode), false,
      'settings.js binds or builds a sender — the boot graph must not touch a transport');
  });

  test('§2a2 · NON-VACUITY — the subsystem exists, and the old scanner could not see it', () => {
    // The row that keeps §2a honest, and that records WHY the old one failed silently. Without
    // it, §2a is satisfiable by deleting the feature.
    const mods = shippedFiles().filter((f) => f.rel.startsWith('src/js/feedback/'));
    assert.ok(mods.length >= 6, `only ${mods.length} feedback modules — the walker read nothing`);
    for (const must of ['png.js', 'geometry.js', 'redact.js', 'report.js', 'ui.js', 'port.js', 'events.js']) {
      assert.ok(mods.some((m) => m.rel.endsWith(must)), `src/js/feedback/${must} is missing`);
    }
    // ██ THE MEASUREMENT THAT IS THE FINDING. ██ The OLD scanner, run verbatim over the tree that
    // now contains the whole subsystem, finds nothing. Kept as a row so nobody re-adopts it.
    const oldScanner = /\b(feedback|rueckmeldung|telemetry|analytics|crashReport|sentry|bugsnag|sendBeacon)\b/i;
    const oldHits = [];
    for (const f of shippedFiles()) {
      stripCommentsAndStrings(f.src).split('\n').forEach((line) => {
        if (oldScanner.test(line)) oldHits.push(f.rel);
      });
    }
    assert.deepEqual(oldHits, [],
      'the old word-boundary scanner now DOES match something — if the naming changed, §2a is '
      + 'still the row that matters, but this note about E10-1009-B can be simplified');
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

  test('§2c · the relay speaks EXACTLY ONE receiving route, and it is write-only', () => {
    // INVERTED. The relay has grown a route, which is what the old row was watching for. What
    // replaces "there is none" is the bound: ONE route, POST, and no way to read a report back.
    // A `GET /feedback` would make this a store of reports addressable by whoever asks, which is
    // a different product with a different privacy story.
    const names = ROUTES.map((r) => `${r.method} ${API_PREFIX}${r.pattern}`);
    assert.ok(names.length >= 15, `only ${names.length} routes — the table was not read`);
    const receiving = ROUTES.filter((r) => /feedback|report|telemetry|analytics|crash/i.test(r.pattern));
    assert.deepEqual(receiving.map((r) => `${r.method} ${r.pattern}`), ['POST /feedback'],
      'the relay\'s reporting surface is no longer exactly one write-only route: '
      + receiving.map((r) => `${r.method} ${r.pattern}`).join(', '));
    assert.equal(receiving[0].spaceParam, undefined,
      'the feedback route names a space — a report could then be joined to a family');
    // and no OTHER route grew a reporting shape while nobody was looking.
    const others = names.filter((n) => /log|diagnos/i.test(n));
    assert.deepEqual(others, [], 'a second reporting route appeared: ' + others.join(', '));
  });

  test('§2e · no shipped module names a resolvable remote host', () => {
    // The compensating claim for the `diagnostics` exclusion above, and a check on §1f from the
    // page's side: every `http(s)://` literal in the whole shipped tree is a scheme fragment, the
    // SVG XML namespace, a documented placeholder, or loopback. Not one of them is a host this
    // product could resolve. A feedback endpoint would have to appear here first.
    const named = [];
    for (const f of shippedFiles()) {
      // ⚠ BLOCK COMMENTS ARE STRIPPED TOO, which they were not until 2026-09-03.
      //
      // The row already stripped `//` comments, for the reason its own header gives: a host named
      // in PROSE is not a host this product can reach, and a gate that cannot be explained past
      // is a gate that gets deleted. It did not strip `/* … */`, so a design note in a JSDoc block
      // counted — and one duly appeared: `src/js/family/createjoin.js` gained a docblock quoting
      // `https://github.com/OWNER/REPO/releases/…` as an EXAMPLE OF WHAT A RELAY ADDRESS IS NOT,
      // which is the opposite of a leak and reddened this row anyway.
      //
      // Completing the strip is faithful to the row's intent rather than a relaxation of it: the
      // claim is and remains "no shipped module NAMES a resolvable remote host **in code**", and
      // §2e2 below is the control that proves a real literal is still caught.
      const noBlocks = f.src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
      noBlocks.split('\n').forEach((line, i) => {
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

  test('§2e2 · ARMED — a real remote literal in CODE is still caught', () => {
    // The control §2e's comment-stripping owes. Without it, "no module names a remote host" is
    // satisfiable by a stripper that blanks the whole file. Each of these is shown to the SAME
    // matcher §2e runs, and each must be seen; the last two must not, because prose is not code.
    const scan = (src) => {
      const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
      const out = [];
      noBlocks.split('\n').forEach((line) => {
        const code = line.replace(/(^|[^:])\/\/.*$/, '$1');
        for (const m of code.matchAll(/['"`](https?:\/\/[^'"`\s]*)/g)) {
          const host = m[1].replace(/^https?:\/\//, '').split(/[/?#]/)[0];
          const benign = host === '' || host === 'www.w3.org' || /[<>…]/.test(host)
            || /^(?:127\.|localhost|\[::1\]|user:pass@host)/.test(host);
          if (!benign) out.push(m[1]);
        }
      });
      return out;
    };
    assert.deepEqual(scan('const SINK = "https://feedback.example.com/v1/report";'),
      ['https://feedback.example.com/v1/report'], 'a real feedback host in code was NOT caught');
    assert.deepEqual(scan('await post(`https://telemetry.example.net/collect`);'),
      ['https://telemetry.example.net/collect'], 'a template literal host was not caught');
    assert.deepEqual(scan('/* the release link is https://github.com/OWNER/REPO/releases/… */'), [],
      'a host named in a BLOCK comment is counted — the strip did not happen');
    assert.deepEqual(scan('// see https://vercel.com/docs for the region'), [],
      'a host named in a line comment is counted');
  });

  test('§2d · the ONE new path is reachable and every look-alike is still refused', () => {
    // INVERTED, and this is the row that shows how narrowly the surface widened. The transport's
    // one call site now accepts exactly one more path than it did — `/api/v1/feedback` — and
    // every neighbouring spelling that an attacker or a bug would produce is refused by name,
    // before a byte leaves the process.
    assert.equal(PATH_RE.test(FEEDBACK_PATH), true,
      'the shipped feedback path is refused by the transport — the feature cannot work');
    assert.equal(FEEDBACK_PATH, `${API_PREFIX}/feedback`, 'the client and the router disagree');
    assert.doesNotThrow(() => assertReachable('https://relay.example.com', FEEDBACK_PATH, ''));
    for (const p of ['/feedback', '/api/v1/../feedback', '/api/feedback', '/api/v2/feedback',
      '/api/v1/feedback/../ops', '/api/v1/./feedback', 'https://elsewhere.example/api/v1/feedback']) {
      assert.throws(() => assertReachable('https://relay.example.com', p, ''),
        (e) => e instanceof NetError, `${p} was not refused by the one call site`);
    }
    // The path widened by ONE. `PATH_RE` itself did not change: it always admitted any
    // `/api/v1/<word>`, and what bounds the surface is the ROUTE TABLE, which §2c counts.
    assert.equal(ROUTES.filter((r) => r.pattern === '/feedback').length, 1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · THE ONE IMAGE PATH, AND THE GLYPH CAPABILITY IT DOES NOT HAVE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// ██ INVERTED 2026-09-03, WHEN LZP-1009 LANDED. ██
//
// This section used to say: *"the claim cannot be verified, because the product cannot draw."*
// That was the strongest available form of the answer while the product had no image primitive
// at all, and it came with its own instruction — *"the row to INVERT the day the screenshot half
// of 1009 arrives, at which point 'produced by not drawing' becomes a claim with something to be
// false about, and this row becomes: the only image-producing call site is the redacted
// renderer."* This is that day, and that is the row §3a now is.
//
// ⚠ §3a DID NOT GO RED WHEN THE FEATURE LANDED. Its scanner looks for `canvas`, `getContext`,
// `toDataURL`, `toBlob`, `getImageData`, `OffscreenCanvas`, `createImageBitmap`,
// `getDisplayMedia` and `html2canvas`, and the delivered renderer uses **not one of them**: it is
// a hand-written indexed-PNG encoder over a `Uint8Array` (`src/js/feedback/png.js`). So the
// product learned to draw and the row that was watching for it stayed green. Finding
// **E10-1009-B**; the same shape as §2a's, and the reason both inverted rows below are written
// as enumerations of CALL SITES rather than as searches for a vocabulary.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// AND THE CLAIM ITSELF IS NOW STRONGER THAN "WE REDACTED IT"
// ─────────────────────────────────────────────────────────────────────────────────────────────
// "Redact by not drawing, never by obscuring" is verifiable here because the encoder **has no
// glyph path to disable**. Its only mutators are `fillRect` and `strokeRect`; it has no font, no
// text measurement, no image input and no compositing source. A full-fidelity board image does
// not exist on this path — not for a moment, not before a blur — because the widest thing that
// ever exists is a list of rectangles.

describe('§3 · the redacted image: one producer, and it cannot draw a letter', () => {
  const IMAGE_PRIMITIVES = [
    { name: 'canvas element', re: /createElement\s*\(\s*canvas|OffscreenCanvas|getContext\s*\(/i },
    { name: 'toDataURL', re: /\btoDataURL\b/ },
    { name: 'toBlob', re: /\btoBlob\b/ },
    { name: 'getImageData', re: /\bgetImageData\b|\bputImageData\b|\bImageData\b/ },
    { name: 'createImageBitmap', re: /\bcreateImageBitmap\b/ },
    { name: 'screen capture', re: /\bgetDisplayMedia\b|\bcaptureStream\b|\bgetUserMedia\b/ },
    { name: 'html2canvas', re: /\bhtml2canvas\b|\bdomToImage\b/ },
  ];

  /** Every way a glyph could reach a pixel. None of these exists anywhere in the product. */
  const GLYPH_PRIMITIVES = [
    { name: 'fillText', re: /\bfillText\b/ },
    { name: 'strokeText', re: /\bstrokeText\b/ },
    { name: 'measureText', re: /\bmeasureText\b/ },
    { name: 'drawImage', re: /\bdrawImage\b/ },
    { name: 'FontFace', re: /\bFontFace\b|\bloadFont\b/ },
    { name: 'SVG foreignObject', re: /\bforeignObject\b/ },
    { name: 'XMLSerializer', re: /\bXMLSerializer\b|\bserializeToString\b/ },
  ];

  test('§3a · the product STILL has no capture primitive — the browser image APIs are unused', () => {
    // Half of the old row survives verbatim and is worth keeping: the delivered renderer did NOT
    // reach for a canvas, and it must never. A canvas is one `fillText` and one `drawImage` away
    // from a full-fidelity board, which is the thing that must not exist even for a moment.
    const hits = [];
    for (const f of shippedFiles()) {
      const code = stripCommentsAndStrings(f.src);
      code.split('\n').forEach((line, i) => {
        for (const pr of IMAGE_PRIMITIVES) if (pr.re.test(line)) hits.push(`${f.rel}:${i + 1} ${pr.name}`);
      });
    }
    assert.deepEqual(hits, [],
      'the product reached for a browser image API. LZP-1009 renders by rasterising rectangles '
      + 'precisely so that no surface exists which could also draw text or composite a capture:\n'
      + hits.join('\n'));
  });

  test('§3b · neither shell can take a screenshot — unchanged, and now load-bearing', () => {
    // This row never was about LZP-1009's absence; it is about the shells. It stays green, and
    // the feature makes it MORE important rather than less: the picture in a report is produced
    // by re-rendering geometry, and a shell that could capture the screen would offer a second,
    // unredacted way to make one.
    const CAPTURE = /CGWindowListCreateImage|CGDisplayCreateImage|CGDisplayStream|SCScreenshotManager|SCStream|ScreenCaptureKit|NSBitmapImageRep|screencapture|takeSnapshot|WKSnapshotConfiguration|screenshots?::/;
    const hits = [];
    for (const shell of SHELLS) {
      shellSource(shell.name).split('\n').forEach((line, i) => {
        const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '');
        if (CAPTURE.test(code)) hits.push(`${shell.name}:${i + 1} ${code.trim().slice(0, 80)}`);
      });
    }
    assert.deepEqual(hits, [], 'a shell can capture the screen:\n' + hits.join('\n'));
  });

  test('§3c · ██ THE ONLY IMAGE-PRODUCING CALL SITE IS THE REDACTED RENDERER ██', () => {
    // The row the old §3a asked to become. `encodePng` is the one function in the product that
    // can produce image bytes, and this enumerates every file that calls it. Two: the encoder's
    // own module, and `redact.js` — which runs `assertNumericOnly` over its input first, so the
    // only thing that can reach the encoder is a list of numbers.
    const callers = [];
    for (const f of shippedFiles()) {
      // The DEFINITION is not a call site. `png.js` declares `export function encodePng(` and
      // would otherwise report itself, which would make the row read "two producers" over a
      // product that has one — and a row that is wrong in the safe direction gets relaxed by the
      // next person rather than read.
      const code = stripCommentsAndStrings(f.src).replace(/\bfunction\s+encodePng\s*\(/g, '');
      if (/\bencodePng\s*\(/.test(code)) callers.push(f.rel);
    }
    assert.deepEqual(callers.sort(), ['src/js/feedback/redact.js'],
      'something other than the redacted renderer produces an image: ' + callers.join(', '));
    // and the ONE caller guards its input before a pixel is written.
    const redact = shippedFiles().find((f) => f.rel === 'src/js/feedback/redact.js').src;
    const guardAt = redact.indexOf('assertNumericOnly(prims)');
    const drawAt = redact.indexOf('new Raster(');
    assert.ok(guardAt > 0 && drawAt > guardAt,
      'the numeric guard does not run BEFORE the raster is built — a text field could be drawn');
  });

  test('§3d · ██ THERE IS NO GLYPH PATH ANYWHERE IN THE PRODUCT ██', () => {
    // "Produced by not drawing" as a claim about a CAPABILITY rather than about a filter. The
    // encoder has no way to put a letter on a pixel, and neither does anything else that ships.
    const hits = [];
    for (const f of shippedFiles()) {
      const code = stripCommentsAndStrings(f.src);
      code.split('\n').forEach((line, i) => {
        for (const pr of GLYPH_PRIMITIVES) if (pr.re.test(line)) hits.push(`${f.rel}:${i + 1} ${pr.name}`);
      });
    }
    assert.deepEqual(hits, [],
      'the product can now rasterise text. "The redacted image was produced by not drawing" is no '
      + 'longer a claim about a capability the code lacks:\n' + hits.join('\n'));
    // and the raster's whole mutator surface is two rectangle calls.
    const mutators = Object.getOwnPropertyNames(Raster.prototype).filter((n) => n !== 'constructor');
    assert.deepEqual(mutators.sort(), ['fillRect', 'strokeRect'],
      'the raster grew a third primitive: ' + mutators.join(', '));
  });

  test('§3e · the walker hands the encoder NUMBERS, and the guard refuses anything else', () => {
    // The join between §3c and §3d: the encoder cannot draw text, and the thing that feeds it
    // cannot supply any. A primitive carrying a label stops the report rather than encoding it.
    assert.throws(
      () => assertNumericOnly([{ role: 'bar', x: 0, y: 0, w: 1, h: 1, fill: 0, stroke: 0, label: 'Kur in Bad Wörishofen' }]),
      /only role and six numbers/,
      'the production guard accepts a primitive carrying text');
    const src = collectPrimitives.toString();
    for (const forbidden of ['textContent', 'innerText', 'innerHTML', 'nodeValue', 'getAttribute']) {
      assert.equal(new RegExp(`\\b${forbidden}\\b`).test(src), false,
        `the geometry walker calls ${forbidden} — it can read the board's text`);
    }
  });

  test('§3f · the encoder emits no text-bearing chunk, so a caption cannot be added later', () => {
    assert.deepEqual([...EMITTED_CHUNKS], ['IHDR', 'PLTE', 'IDAT', 'IEND']);
    for (const t of ['tEXt', 'iTXt', 'zTXt']) assert.equal(EMITTED_CHUNKS.includes(t), false);
    const png = encodePng(new Raster(4, 4, 0), [[255, 255, 255]]);
    const asText = Array.from(png, (b) => String.fromCharCode(b)).join('');
    for (const t of ['tEXt', 'iTXt', 'zTXt', 'tIME']) {
      assert.equal(asText.includes(t), false, `the encoder emitted a ${t} chunk`);
    }
  });

  test('§3g · ARMED — every scanner in this section catches what it claims to', () => {
    // Shown a positive of each shape, so a green §3a/§3b/§3d is a fact about the product and not
    // about a regex that stopped matching. This is the row whose ABSENCE let the old §3a sit
    // green over a shipped renderer — it armed the image scanner and never armed a glyph one.
    assert.ok(IMAGE_PRIMITIVES.some((pr) => pr.re.test('board.getContext("2d").canvas.toDataURL("image/png")')));
    assert.ok(GLYPH_PRIMITIVES.some((pr) => pr.re.test('ctx.fillText(entry.label, x, y);')),
      'the glyph scanner would not see a fillText');
    assert.ok(GLYPH_PRIMITIVES.some((pr) => pr.re.test('new XMLSerializer().serializeToString(svg)')),
      'the glyph scanner would not see the SVG-to-image trick');
    assert.ok(/CGWindowListCreateImage/.test('let img = CGWindowListCreateImage(rect, .optionAll, 0, [])'));
    const files = shippedFiles();
    assert.ok(files.length > 40, `only ${files.length} shipped files scanned`);
    assert.ok(files.some((f) => f.rel === 'src/js/print.js'), 'print.js was not scanned');
    assert.ok(files.some((f) => f.rel === 'src/js/feedback/png.js'), 'the ENCODER itself was not scanned');
  });

  test('§3h · and the real renderer, end to end, produces a bounded PNG from a real walk', () => {
    // Non-vacuity for the whole section: the rows above are all "it cannot", and the feature has
    // to also work. A tiny board is walked through the SHIPPED collector and the SHIPPED encoder.
    const box = { left: 0, top: 0, width: 200, height: 100 };
    const node = { box: { left: 10, top: 10, width: 80, height: 12 } };
    const root = { box, querySelectorAll: (sel) => (sel === '.bar' ? [node] : []) };
    const out = renderRedactedBoard(root, {
      rects: (n) => (n === root ? box : n.box),
      style: () => ({ backgroundColor: 'rgb(255,255,255)', borderTopColor: 'rgb(0,0,0)', color: 'rgb(0,0,0)' }),
      lineBoxes: () => [],
    });
    assert.equal(out.w, 200);
    assert.ok(out.bytes.length > 50 && out.bytes.length < 262144);
    assert.deepEqual([...out.bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
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
