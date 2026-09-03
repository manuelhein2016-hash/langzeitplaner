// tests/audit/pass4-conformance.test.js — PASS 4 CONFORMANCE AUDIT, evidence rows.
//
// AUDIT ARTEFACT. Written by the conformance auditor; NOT wired into any npm script and NOT a
// gate. Nothing in src/, server/, shell-macos/, src-tauri/, docs/ or any existing test was
// touched to produce it. Each row asserts the CURRENT behaviour of HEAD (92545df) so that a
// reader can re-run the finding rather than take it on trust.
//
//   node --test --import ./tests/helpers/dev-flag.mjs "tests/audit/pass4-*.test.js"
//
// EVERY ROW HERE IS GREEN WHILE ITS FINDING IS OPEN. If one goes red, the finding was probably
// fixed — invert the row, do not repair it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE FINDINGS, AND WHICH SECTION MEASURES EACH
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
//   §1  A-1 · story 21.5 (as amended by D10) is FALSE on a shipped solo install: the exception
//            is TWO, and the second one is automatic. `main.js` boot arms an update check on
//            every launch and a 30-minute poll, neither of which a human asked for.
//   §2  A-2 · story 21.3: the Datenschutz screen contradicts itself, in both languages, on one
//            screen — „Genau eine Ausnahme … Von allein sendet dieses Programm nichts" sits
//            thirteen blocks above „Die zweite Gegenstelle … Etwa einmal täglich".
//   §3  A-3 · D10's originator gate cannot see the updater. `network-scope.test.js` §5b measures
//            callers of `.send(` — the feedback port — and nothing else.
//   §4  A-4 · story 17.5 (the quiet „neu" dot) does not work on any real Mac: `store.js#_project`
//            supplies none of materialize's isNew hooks, so `isNewOf` returns false always.
//            Confirms open finding E10-1 still stands at HEAD.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · A-1 — the solo exception is two, and one of them is a timer
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · A-1 · 21.5 as amended by D10 — "the only request a solo copy can originate is the one a human asks for"', () => {
  test('§1a · boot arms an update check and a poll, and no gesture is involved', () => {
    // D10: "the only request a solo copy can ORIGINATE is the one a human asks for, by pressing
    // „Senden" on the Rückmeldung screen". These two lines are in `start()`, run on every launch
    // of every install, solo included. Neither is behind a listener, a button or a family gate.
    const main = read('src/js/main.js');
    const lines = main.split('\n');
    const launch = lines.findIndex((l) => /^\s*runLaunchCheck\(\);\s*$/.test(l));
    const daily = lines.findIndex((l) => /^\s*startDailyTimer\(\);\s*$/.test(l));
    assert.ok(launch >= 0, 'main.js no longer calls runLaunchCheck() at boot — re-price A-1');
    assert.ok(daily >= 0, 'main.js no longer calls startDailyTimer() at boot — re-price A-1');

    // The enclosing function is the boot path, not a handler.
    let fn = null;
    for (let i = launch; i >= 0; i -= 1) {
      const m = lines[i].match(/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
      if (m) { fn = m[1]; break; }
    }
    assert.equal(fn, 'boot', `the launch check moved out of boot() into ${fn}()`);

    // …and nothing between the top of boot() and those two calls asks a person anything.
    const startAt = main.indexOf('export async function boot()');
    const region = main.slice(startAt, main.indexOf('startFamilyMode();', startAt));
    assert.equal(/addEventListener\s*\(\s*['"]click['"]/.test(region), false,
      'a click gate appeared around the launch check');
  });

  test('§1b · the poll is a bare setInterval — the shape D10 names as the regression to expect', () => {
    // D10, verbatim: "The shapes to expect are all courtesies: a retry timer, an `online`
    // listener … §5b is the row that goes red". A retry timer is exactly what ships, on the
    // OTHER remote, and no row goes red.
    const ui = read('src/js/update-ui.js');
    assert.match(ui, /dailyTimer\s*=\s*setInterval\(/,
      'startDailyTimer no longer uses setInterval — re-measure A-1');
    assert.match(ui, /updater\.checkDaily\(\)/,
      'the timer no longer dispatches checkDaily — re-measure A-1');
    assert.match(ui, /startDailyTimer\(intervalMs = 30 \* 60 \* 1000\)/,
      'the poll interval moved; A-1 quotes 30 minutes');
  });

  test('§1c · with both gates open the real updater fires ONE manifest request per launch check, from no gesture', async () => {
    // The behaviour, run rather than read. `createUpdater` is the shipped decision logic; the
    // port is the only thing stubbed, because the port IS the socket. Nothing here clicks.
    const { createUpdater } = await import('../../src/js/platform/updater.js');
    const calls = [];
    const port = {
      async status() {
        calls.push('status');
        // The state a real Mac is in one dismissal of the first-run card later:
        // shell default `enabled = true` (shell-macos/main.swift:267) and `disclosed` set by
        // `main.js#dismiss` → `discloseUpdateCheck()` (src/js/main.js:588).
        return {
          currentVersion: '2.0.0', enabled: true, disclosed: true,
          lastCheckAt: null, stagedVersion: null,
        };
      },
      async noteCheck() { calls.push('noteCheck'); },
      async fetchManifest() { calls.push('fetchManifest'); return { ok: false, error: 'no-release-host' }; },
      async download() { calls.push('download'); return { ok: false }; },
    };
    const u = createUpdater({ port, now: () => 1_800_000_000_000 });

    const r = await u.checkOnLaunch();
    assert.equal(calls.filter((c) => c === 'fetchManifest').length, 1,
      'a launch check made no manifest request — A-1 no longer reproduces');
    assert.equal(r.ran, true, 'the launch check declined; both gates should have been open');

    // And the daily one, from the timer's entry point, is a second.
    const u2 = createUpdater({ port, now: () => 1_800_000_000_000 });
    await u2.checkDaily();
    assert.equal(calls.filter((c) => c === 'fetchManifest').length, 2,
      'the timer path made no request');
  });

  test('§1d · the shell defaults `enabled` to TRUE, so dismissing one card arms it forever', () => {
    // The only thing between a fresh install and a daily request is one dismissal of the
    // first-run card. `disclosed` defaults false — and `main.js#dismiss` sets it, unconditionally,
    // for every install that is running inside a real shell.
    const swift = read('shell-macos/main.swift');
    assert.match(swift, /struct UpdaterPrefs \{[\s\S]*?var enabled = true/,
      'the shell no longer defaults enabled=true — re-measure A-1');
    const main = read('src/js/main.js');
    assert.match(main, /if \(discloses\) discloseUpdateCheck\(\)\.catch/,
      'the first-run dismissal no longer discloses — re-measure A-1');
  });

  test('§1e · today the request is stopped only by an unconfigured host, not by a gate', () => {
    // WHY THIS MATTERS FOR A SHIP DECISION. The measured request count on this machine is zero,
    // and it is zero for a reason that disappears the day F22 works at all: the release URL is
    // still a placeholder, so the SHELL short-circuits after both 21.5 gates have already been
    // passed. 21.5 is therefore vacuously true today and false on the first tagged release.
    const swift = read('shell-macos/main.swift');
    const fn = swift.slice(swift.indexOf('func updaterFetchManifest'), swift.indexOf('func updaterDownload'));
    const gateAt = fn.indexOf('prefs.disclosed, prefs.enabled');
    const placeholderAt = fn.indexOf('OWNER-PLACEHOLDER');
    assert.ok(gateAt >= 0 && placeholderAt >= 0, 'the shell fetch path changed shape — re-measure');
    assert.ok(gateAt < placeholderAt,
      'the 21.5 gates are passed BEFORE the placeholder check: nothing but a missing host is '
      + 'stopping the request today');
    assert.match(swift, /"https:\/\/github\.com\/OWNER-PLACEHOLDER\/langzeitplaner\/releases/,
      'the release host was configured — A-1 is now live traffic, not a latent path');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · A-2 — the Datenschutz screen contradicts itself
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · A-2 · story 21.3 — "trust is informed, not marketed"', () => {
  test('§2a · „genau eine Ausnahme" and „die zweite Gegenstelle" are on the same screen, in German', () => {
    const s = read('src/js/settings.js');
    assert.match(s, /soloBody: 'Solange du keinen Familienkreis nutzt/,
      'the solo paragraph moved — re-locate A-2');
    assert.match(s, /Genau eine Ausnahme gibt es/, 'the „genau eine Ausnahme" claim is gone');
    assert.match(s, /Von allein sendet dieses Programm nichts\./, 'the „von allein" claim is gone');
    assert.match(s, /updateTitle: 'Die zweite Gegenstelle: die Update-Prüfung'/,
      'the update paragraph moved — re-locate A-2');
    assert.match(s, /Etwa einmal täglich fragt die App-Hülle/, 'the daily-check sentence is gone');

    // Both are rendered, by the same function, into the same sheet.
    const draw = s.slice(s.indexOf("block('soloTitle', 'soloBody')"));
    assert.match(draw, /block\('updateTitle', 'updateBody'\)/,
      'the two paragraphs are no longer drawn into the same section');
  });

  test('§2b · the same contradiction survives the English translation', () => {
    const s = read('src/js/settings.js');
    assert.match(s, /There is\s*'\s*\+\s*'exactly one exception, and it happens only when you trigger it/,
      'the EN „exactly one exception" claim moved');
    assert.match(s, /On its own this program sends nothing\./, 'the EN „on its own" claim is gone');
    assert.match(s, /updateTitle: 'The second counterpart: the update check'/,
      'the EN update paragraph moved');
    assert.match(s, /About once a day the app shell/, 'the EN daily-check sentence is gone');
  });

  test('§2c · the contradiction is visible on a SOLO Mac, which is the reader D11 wrote it for', () => {
    // D11's whole argument for hoisting Datenschutz out of `family/mount.js` is that the solo
    // tester must see these three paragraphs. The solo paragraph is one of them. So is the one
    // that contradicts it.
    const s = read('src/js/settings.js');
    assert.equal(/import .*family\/mount\.js/.test(s), false,
      'settings.js now imports the family door — D11 was reverted, re-audit');
    assert.match(s, /block\('soloTitle', 'soloBody'\)/);
    assert.match(s, /block\('updateTitle', 'updateBody'\)/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · A-3 — the originator gate is scoped to the feedback port and cannot see the updater
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · A-3 · D10 says the exception is checkable by construction; the check has one subsystem in scope', () => {
  test('§3a · the scanner matches `.send(` — the feedback port — and nothing the updater does', () => {
    const scanner = read('tests/tier1/network-scope.test.js');
    const fn = scanner.slice(scanner.indexOf('function sendOriginators'),
      scanner.indexOf('describe(\'the amendment'));
    assert.ok(fn.length > 200, 'sendOriginators moved — re-locate A-3');
    assert.match(fn, /\/\\\.\\s\*send\\s\*\\\(\//,
      'the detection regex changed; A-3 quotes /\\.\\s*send\\s*\\(/');
    assert.equal(/fetchManifest|checkOnLaunch|checkDaily|update/i.test(fn), false,
      'the scanner now knows about the updater — A-3 may be closed, re-verify');
  });

  test('§3b · and the whole §5 section only ever reads the two feedback files', () => {
    const scanner = read('tests/tier1/network-scope.test.js');
    assert.match(scanner, /const FEEDBACK_PORT = 'src\/js\/feedback\/port\.js'/);
    assert.match(scanner, /const THE_SCREEN = 'src\/js\/feedback\/ui\.js'/);
    const section = scanner.slice(scanner.indexOf("describe('the amendment"));
    assert.equal(/platform\/updater\.js|update-ui\.js/.test(section), false,
      'the amendment section now covers the updater — A-3 may be closed');
  });

  test('§3c · the project already knows: an existing attack row calls it a SECOND host', () => {
    // Not a new discovery — finding P-2, MEDIUM, open. What is new is that D10 (2026-09-03)
    // re-stated 21.5 as a SINGLE human exception AFTER P-2 was written, and named the count
    // "exactly one" in the story text a reader will treat as the shipped guarantee.
    const p2 = read('tests/attack/privacy-e5-silence.test.js');
    assert.match(p2, /SUCCEEDED — a solo install contacts a SECOND host on every launch: the release manifest/);
    assert.match(p2, /FINDING P-2 · MEDIUM · stories 21\.5 and 21\.3 · not new, and still open/);
    const d10 = read('DESIGN-DECISIONS.md');
    assert.match(d10, /the only request a solo copy can originate is the one a human asks for/,
      'D10 was reworded — re-read A-1 against the new text');
    assert.match(d10, /native-socket exception count is still \*\*two\*\*\n\(sync, update\)/,
      'D10 no longer admits the second socket — the contradiction moved');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · A-4 — story 17.5 does not work on a real Mac (confirms E10-1 at HEAD)
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · A-4 · 17.5 — the quiet „neu" dot', () => {
  test('§4a · `_project()` hands materialize none of the four isNew inputs', () => {
    const s = read('src/js/store.js');
    const proj = s.slice(s.indexOf('  _project({ settings = false } = {}) {'));
    const call = proj.slice(0, proj.indexOf('});'));
    assert.ok(call.includes('materialize(regs, {'), '_project changed shape — re-locate A-4');
    for (const hook of ['seqOf', 'isNew', 'lastSeenSeq', 'levelDecreased']) {
      assert.equal(call.includes(hook), false,
        `_project now passes ${hook} — 17.5 may be wired, re-verify E10-1`);
    }
  });

  test('§4b · so `isNewOf` returns false for every entry, by the shape of the function', async () => {
    const mat = read('src/js/core/materialize.js');
    const fn = mat.slice(mat.indexOf('function isNewOf(ctx, fkey, alive)'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    // With ctx.seqOf and ctx.isNew both undefined the only reachable exit is `return false`.
    assert.match(body, /if \(ctx\.seqOf\) \{/);
    assert.match(body, /if \(ctx\.isNew\) return !!ctx\.isNew\(fkey\);/);
    assert.match(body, /return false;\s*$/m);
  });

  test('§4c · the renderer IS wired, so nothing downstream is at fault', () => {
    // Named so nobody re-derives the wrong owner: board.js draws the dot, layout.js gates it on
    // `foreign`, the CSS exists. Exactly one line of plumbing is missing, in store.js.
    const board = read('src/js/board.js');
    assert.match(board, /if \(n\.isNew\) node\.appendChild\(neuDot\(\)\);/);
    assert.match(board, /if \(seg\.isNew\) lab\.appendChild\(neuDot\(\)\);/);
    const layout = read('src/js/layout.js');
    assert.match(layout, /isNew: foreign && !!entry\.isNew,/);
    const css = read('src/css/app.css');
    assert.match(css, /\.note \.neu-dot,/);
  });

  test('§4d · and the traceability record still carries E10-1 as open', () => {
    const t = JSON.parse(read('docs/v2/traceability.json'));
    const open = t.verification.openFindings.find((f) => f.id === 'E10-1');
    assert.ok(open, 'E10-1 left the open list — re-verify 17.5 against the code, not the record');
    assert.equal(open.story, '17.5');
  });
});
