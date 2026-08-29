// ATTACK · THE PRIVACY ADVERSARY, 1 of 5 — SILENCE.
//
// Stories 21.5 / 13.4 / A1 ("in solo mode the app makes zero network requests") and
// Principle 7 / story 15.1 ("solo mode is not one instruction heavier because family mode
// exists"). E5 is the moment this product first sends a byte anywhere; before E5 both promises
// were true because nothing called `fetch`. This file attacks them now that something does.
//
// Each test is named SUCCEEDED or FAILED **from the adversary's point of view**, the convention
// `crypto-relay-read.test.js` established: a row named SUCCEEDED is a capability the attacker
// really has today, asserted concretely so that it turns red the day the capability closes.
//
// FIVE ATTACKS:
//   §1  can any code path in solo mode EVALUATE net.js, resolve a hostname, or reach the CSP?
//   §2  does the FIRST RUN stay silent?
//   §3  does a user who creates a Familienkreis get back to silent by deleting it?
//   §4  is the board really the only remote — or is there a second one nobody documented?
//   §5  Principle 7: is solo mode heavier because family mode exists? Measured, not asserted.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  assetNetworkReferences, eagerClosure, poisonNetwork, nonDomModules, repoFile, repoHas,
} from '../helpers/privacy-audit.js';
import { dynamicDoorsFrom, reachableFrom } from '../helpers/importgraph.js';
import { readFamilyConfig, FAMILY_PREFS } from '../../src/js/family/engine.js';

const FORBIDDEN_IN_SOLO = ['src/js/platform/net.js', 'src/js/sync/', 'src/js/crypto/', 'src/js/family/'];

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 — CAN SOLO MODE REACH THE NETWORK AT ALL?
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · solo mode, attacked from every direction that is not a fetch( call site', () => {
  test('FAILED — no shipped ASSET opens a socket: no preconnect, no dns-prefetch, no webfont', () => {
    // THE ATTACK `tests/tier1/network-scope.test.js` CANNOT SEE. That gate greps `src/js/` for
    // `fetch(`, `XMLHttpRequest`, `WebSocket`, `EventSource` and `sendBeacon`. A page reaches the
    // network without any of them: `<link rel="preconnect">` opens a TCP+TLS connection to a
    // named host before one line of JS runs, `dns-prefetch` resolves a hostname, and an
    // `@import url(https://fonts…)` in a stylesheet fetches a font. Every one of those is a
    // request in solo mode, on the very first paint, and none is a call site.
    //
    // It is not hypothetical: a webfont is the single most common way a "makes no requests"
    // desktop app turns out to make one.
    const hits = assetNetworkReferences();
    assert.deepEqual(
      hits.map((h) => `${h.file}: ${h.marker} — ${h.text}`), [],
      'a shipped asset reaches off-origin without any JavaScript being involved',
    );
  });

  test('FAILED — evaluating every non-DOM module fires no network call, with all five globals armed', async () => {
    // "Never even evaluated" is the design (ADR 003 §7 gate 2). This attacks the WEAKER property
    // that has to hold anyway: even if every module behind the door WERE evaluated — which is
    // exactly what happens the moment a solo user opens the settings sheet, see §5 — module
    // evaluation itself must not open a socket. A module-scope `fetch(MANIFEST)`, a `new
    // WebSocket` at top level or a `navigator.sendBeacon` in an initialiser would all be invisible
    // to a reachability gate and fatal to 21.5.
    const poison = poisonNetwork();
    const failures = [];
    try {
      for (const rel of nonDomModules()) {
        // eslint-disable-next-line no-await-in-loop
        try { await import(`../../${rel}?privacy-silence`); }
        catch (e) { failures.push(`${rel}: ${e.message}`); }
      }
    } finally {
      poison.restore();
    }
    assert.deepEqual(failures, [], 'a module could not even be evaluated with the network poisoned');
    assert.deepEqual(poison.fired, [], 'a module opened a socket at EVALUATION time');
    assert.ok(nonDomModules().length > 25, 'the module walker stopped working');
  });

  test('FAILED — the boot graph statically reaches none of net.js, sync/, crypto/ or family/', () => {
    // Restated here from `network-scope.test.js` §2 for one reason: this file's other rows are
    // about what happens AFTER the door opens, and a reader has to know the door is still shut on
    // the launch path before any of that means anything. If this row ever goes red, every other
    // row in this file is moot.
    const eager = eagerClosure('src/js/boot.js');
    const leaked = eager.filter((f) => FORBIDDEN_IN_SOLO.some((p) => f.startsWith(p)));
    assert.deepEqual(leaked, [], 'a solo launch evaluates a family-mode module');
  });

  test('SUCCEEDED — the CSP is the LAST gate, not a gate solo mode ever reaches', () => {
    // Story 21.5's tier-2 row asserts an off-origin fetch is genuinely BLOCKED. That is gate 4,
    // and it is real — but it is worth naming what it does and does not prove. `connect-src
    // 'self'` blocks a request the page tries to make; it says nothing about a request the
    // SHELL makes (§4 below), and it is a document-level constant that cannot be conditional on
    // whether a space exists. So a solo install's silence rests on gates 1-3, and gate 4 is the
    // backstop for a JS bug — which is the adversary's opening: attack gates 1-3, not gate 4.
    const html = repoFile('index.html');
    assert.match(html, /connect-src 'self'(;|")/, "connect-src must be exactly 'self'");
    assert.equal(/connect-src[^;"]*https?:\/\//.test(html), false, 'the CSP names a remote host');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 — THE FIRST RUN
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · the first launch of a fresh install', () => {
  test('FAILED — first run has no door at all: firstrun.js reaches nothing dynamic', () => {
    // ADR 002 §2.4: "First run mints only a memberId and a deviceShort. NO KEYGEN, NO PROBE, NO
    // NETWORK." `main.js` holds the one door; `firstrun.js` must hold none, because the unlock
    // screen runs BEFORE the board and a door there would fire on an install that has never seen
    // the settings sheet.
    assert.deepEqual(dynamicDoorsFrom('src/js/firstrun.js'), [],
      'the first-run screen can open a door into family mode');
    const eager = eagerClosure('src/js/firstrun.js');
    assert.deepEqual(eager.filter((f) => FORBIDDEN_IN_SOLO.some((p) => f.startsWith(p))), []);
  });

  test('FAILED — a fresh board arms nothing: the config gate needs three fields, and has none', () => {
    // The runtime half. `main.js:152` returns before `openFamilyDoor()` unless all three settings
    // are present, and `readFamilyConfig` is the same decision one layer down. A fresh install has
    // none of them, so both halves say null — and the ATTACK is the near-misses: a half-configured
    // board (an origin typed into the field but no space, a stale flag with no origin) must also
    // stay silent, because that is the state a curious user leaves the app in.
    assert.equal(readFamilyConfig(undefined), null);
    assert.equal(readFamilyConfig({}), null);
    assert.equal(readFamilyConfig({ [FAMILY_PREFS.origin]: 'https://relay.example' }), null,
      'an address typed into the field must not arm sync on its own');
    assert.equal(readFamilyConfig({ [FAMILY_PREFS.enabled]: true }), null);
    assert.equal(readFamilyConfig({
      [FAMILY_PREFS.enabled]: true, [FAMILY_PREFS.origin]: 'https://relay.example',
    }), null, 'a flag with no space must not arm sync');
    assert.equal(readFamilyConfig({
      [FAMILY_PREFS.enabled]: true,
      [FAMILY_PREFS.origin]: 'https://relay.example',
      [FAMILY_PREFS.space]: 'fsp_AAAAAAAAAAAAAAAAAAAAAA',
    }), null, 'a FAMILY space id must not arm the personal engine (21.2)');

    // And the positive control, so the gate is not passing because it refuses everything.
    assert.deepEqual(readFamilyConfig({
      [FAMILY_PREFS.enabled]: true,
      [FAMILY_PREFS.origin]: 'https://relay.example',
      [FAMILY_PREFS.space]: 'psp_AAAAAAAAAAAAAAAAAAAAAA',
    }), { origin: 'https://relay.example', spaceId: 'psp_AAAAAAAAAAAAAAAAAAAAAA' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 — THE WAY BACK. THIS IS THE FINDING.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · a user creates a Familienkreis and then wants it gone', () => {
  test('SUCCEEDED — there is NO WAY BACK to silence: nothing in the product ever clears the flag', () => {
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // FINDING P-1 · HIGH · story 21.5, third clause.
    //
    // "Does a user who creates and then deletes a Familienkreis go back to silent?" — no,
    // because a Familienkreis cannot be deleted, left, disabled or paused from anywhere in the
    // shipped client.
    //
    // `familysettings.js` says so in its own words: "Turning sync back OFF is deliberately not
    // here: it is `POST /members/leave`, story 20.3, and it belongs with the rest of the
    // lifecycle." Story 20.3 is not built, and `/members/leave` has NO call site in `src/js/`.
    // So the settings sheet, once a space exists, degrades to two read-only facts and no
    // controls at all.
    //
    // What that costs, concretely: `readFamilyConfig` arms on three settings keys; once written,
    // every subsequent launch starts `driveCadence`, which pulls immediately and then every
    // 45 s ± 15 s for as long as the app is open, for ever. A person who tried the feature once
    // has no way to stop their Mac contacting the relay short of editing `board.json` by hand.
    // It is not a data leak — the relay learns only what §5 of `server-metadata.md` describes —
    // but 21.5's promise is about REQUESTS, and this is the state in which they cannot be
    // stopped.
    //
    // The fix is small and is not mine to make: one control that clears the three keys, plus
    // whatever 20.3 decides about telling the relay. Owner: WP-9 / story 20.3.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    const files = [
      'src/js/family/familysettings.js', 'src/js/family/mount.js', 'src/js/family/engine.js',
      'src/js/family/syncstatus.js', 'src/js/family/pairingui.js', 'src/js/family/pairflow.js',
      'src/js/settings.js', 'src/js/main.js', 'src/js/store.js',
    ];

    // (a) nothing calls the leave endpoint.
    const leaveCallSites = files.filter((f) => /members\/leave/.test(stripComments(repoFile(f))));
    assert.deepEqual(leaveCallSites, [], 'if this goes red, story 20.3 landed — reopen finding P-1');

    // (b) EVERY `setSettings` call in the product, read. `setSettings` is the only writer of a
    //     board setting, so the complete set of writes to the three arming keys is the complete
    //     set of `setSettings` arguments that name one of them — and not one of those writes a
    //     falsy value or deletes a key. `familysettings.js` writes only the origin, only while
    //     there is no space, and only the string a human typed.
    const writes = [];
    for (const f of files) {
      const src = stripComments(repoFile(f));
      for (const call of src.match(/setSettings\(\{[\s\S]*?\}\)/g) || []) {
        for (const key of Object.values(FAMILY_PREFS)) {
          if (!call.includes(key) && !call.includes(`FAMILY_PREFS.${keyName(key)}`)) continue;
          writes.push({ file: f, key, disables: /:\s*(false|null|undefined|''|"")/.test(call) });
        }
      }
      for (const key of Object.values(FAMILY_PREFS)) {
        if (new RegExp(`delete\\s+[\\w.\\[\\]'"]*${key}`).test(src)) {
          writes.push({ file: f, key, disables: true });
        }
      }
    }
    assert.ok(writes.length > 0, 'the setSettings scan matched nothing at all — the scan is vacuous');
    assert.deepEqual(
      writes.filter((w) => w.disables), [],
      'if this goes red an off switch exists — close finding P-1',
    );

    // (c) the positive control: the ON switch is right there, so the asymmetry is real and not
    //     an artefact of a regex that matches nothing.
    const optIn = stripComments(repoFile('src/js/family/mount.js'));
    assert.match(optIn, /FAMILY_PREFS\.enabled\]:\s*true/, 'the opt-in must be visible to this scan');
  });

  test('SUCCEEDED — and the arming decision is made before the human is ever asked again', () => {
    // The second half of P-1, and the reason it is HIGH rather than LOW: arming is not a
    // per-session choice a user could decline. `main.js`'s `armFamilyMode` reads the RAW board
    // file before `store.init()` and opens the door on the strength of three persisted booleans.
    // There is no prompt, no confirmation and no per-launch consent — by design (19.2 wants
    // silence), and that design has no counterpart that turns it off.
    const main = stripComments(repoFile('src/js/main.js'));
    assert.match(main, /if \(!settings \|\| !settings\.syncEnabled \|\| !settings\.personalSpaceId\) return;/);
    assert.match(main, /await import\('\.\/family\/mount\.js'\)/);
    // Nothing between the guard and the import asks anybody anything.
    const between = main.slice(main.indexOf('!settings.personalSpaceId'), main.indexOf("import('./family/mount.js')"));
    assert.equal(/confirm|prompt|dialog|ask/i.test(between), false, `a consent step appeared: ${between}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 — THE SECOND REMOTE
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · "zero network requests" is a claim about the APP, not about the page', () => {
  test('SUCCEEDED — a solo install contacts a SECOND host on every launch: the release manifest', () => {
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // FINDING P-2 · MEDIUM · stories 21.5 and 21.3 · not new, and still open.
    //
    // `platform/updater.js`'s own header states the tension in full: 21.5 says zero requests,
    // 22.3 says the app checks for updates on launch and roughly daily, "both cannot be
    // literally true". The resolution shipped is that the SHELL makes the request, not the page,
    // so `net.js` stays the only `fetch` and the CSP does not move.
    //
    // As an engineering answer that is right. As a PRIVACY answer it is incomplete in one
    // specific way, and that is what this row is: **the second remote is nowhere in the
    // documentation 21.3 rests on.** `docs/v2/server-metadata.md` is the only document in the
    // repository that enumerates what an operator can observe, it is explicitly the input to the
    // Datenschutz text, and it describes the RELAY only. It never names the release host, never
    // says a launch discloses "some Mac asked for latest.json", and its §5 says in so many words
    // that "a person who never joins a circle has no rows at all — not an empty account, no
    // account", which reads as *no traffic* and is true only of the relay.
    //
    // E1 recorded the same obligation (`E1-VERIFICATION.md` §7.2: "the Datenschutz text (21.3)
    // must name the release host as a second remote beside the sync endpoint"). It is still owed.
    // Owner: LZP-1001 / the PO.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    const updater = repoFile('src/js/platform/updater.js');
    assert.match(updater, /fetchManifest/, 'the updater no longer has a network port — re-price P-2');
    assert.match(updater, /ONE https GET/i);

    // The gate is real and is asserted, because the finding is about DISCLOSURE and not about
    // the request being unconditional: `check()` returns before touching the port unless the
    // first-run screen has said so and the switch is on.
    assert.match(updater, /st\.disclosed !== true/);
    assert.match(updater, /not-disclosed/);

    // And the documentation half, which is the finding.
    const md = repoFile('docs/v2/server-metadata.md');
    assert.ok(/release host/i.test(md) && /latest\.json/.test(md),
      'the second remote left §8 of server-metadata.md — re-open the documentation half of P-2');
    assert.equal(repoHas('docs/v2/datenschutz.md'), false,
      'a Datenschutz document appeared — re-audit P-2 against it, not against server-metadata.md');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 — PRINCIPLE 7 / 15.1, MEASURED
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§5 · is solo mode heavier because family mode exists?', () => {
  test('FAILED — a solo LAUNCH evaluates 0 of the 41 modules behind the door', () => {
    // The measurement, not the assertion. `boot.js`'s eager closure is what a launch executes.
    const solo = eagerClosure('src/js/boot.js');
    const behindTheDoor = reachableFrom('src/js/family/mount.js').reached;
    const overlap = behindTheDoor.filter((f) => solo.includes(f) && FORBIDDEN_IN_SOLO.some((p) => f.startsWith(p)));
    assert.deepEqual(overlap, []);
    assert.ok(behindTheDoor.length > 30, `only ${behindTheDoor.length} modules behind the door`);
    assert.ok(solo.length > 20, `only ${solo.length} modules in the solo launch`);
  });

  test('SUCCEEDED — but a solo user who opens ⚙ ONCE evaluates the whole crypto and sync stack', () => {
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // FINDING P-3 · LOW · story 15.1 / ADR 003 §7 gate 2, precision rather than defect.
    //
    // `main.js`'s ⚙ handler is `openSettingsWithFamily()`, which calls `ensureFamilySettings()`,
    // which opens the door and calls `mountSolo()` — on an install that has never opted in. Its
    // purpose is legitimate: the „Familienkreis" section IS the opt-in, and „Ich habe einen
    // Code" has to work on a Mac with no identity and no space.
    //
    // The consequence is that gate 2's plain-English form — "in solo mode the modules are never
    // evaluated" — is true of every launch and false of every launch in which somebody opens the
    // settings sheet. From that moment the process holds `crypto/`, `sync/` and `net.js`
    // evaluated in memory. §1 above is what makes that acceptable: evaluation costs no request.
    // But the sentence in ADR 003 §7 and in `mount.js`'s header should say "never evaluated
    // before the settings sheet is opened", because as written it is a promise the ⚙ button
    // breaks, and a reader auditing 21.5 would not find it out from the ADR.
    //
    // Cost measured below, so a future change that makes it larger is visible.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    const door = reachableFrom('src/js/family/mount.js').reached;
    const crypto = door.filter((f) => f.startsWith('src/js/crypto/'));
    // The exact set, so a change to it is a decision rather than a drift.
    //
    // **IT GREW BY TWO IN WP-9, AND THAT IS THE PRICE OF CLOSING TWO THIRDS OF P-4.**
    // `probe.js` and `backup.js` used to be absent from this list, and the next row is what that
    // absence turned out to mean: they were absent from EVERY list, reachable from nothing.
    // Wiring them into `family/familysettings.js` — the family entry point, which is what both
    // of them are for — puts them behind the same one door as the rest, so a solo LAUNCH still
    // evaluates neither (the row above) and a solo ⚙ now evaluates seven crypto modules instead
    // of five. The cost is module evaluation: no request, no keygen, no probe. `probeCrypto()`
    // runs on a click and `exportBackup()` runs on a click, which is the whole of Principle 7's
    // requirement and is asserted in the last row of this section.
    assert.deepEqual(crypto, [
      'src/js/crypto/backup.js', 'src/js/crypto/envelope.js', 'src/js/crypto/identity.js',
      'src/js/crypto/pairing.js', 'src/js/crypto/probe.js', 'src/js/crypto/spacekeys.js',
      'src/js/crypto/suite.js',
    ]);
    assert.ok(door.includes('src/js/platform/net.js'));

    // The `sync/` side, asserted for the two things that matter rather than as a frozen list:
    // the engine is behind the door, and `chain.js` did NOT arrive here. The second half is the
    // load-bearing one — see the next row. `chain.js` becomes reachable by being CALLED from
    // `pullNow`, and an import from this side of the door would close the S5 row while leaving a
    // withholding relay exactly as undetectable as it is today.
    const sync = door.filter((f) => f.startsWith('src/js/sync/'));
    assert.ok(sync.includes('src/js/sync/personal.js'), 'the engine is behind the door');
    // INVERTED. `chain.js` is behind the door BECAUSE `pullNow` imports and calls it — which was
    // always the condition, and the reason this row read `false` before was that reachability
    // achieved any other way (an import from the sheet, say) would have closed the S5 row and
    // left a withholding relay exactly as undetectable. The two halves are asserted separately,
    // so an import that nothing calls still fails here.
    assert.ok(sync.includes('src/js/sync/chain.js'),
      'chain.js left the door — a solo ⚙ no longer carries the chain witness, so `pullNow` has '
      + 'stopped importing it (finding P-4)');

    // The door is opened from the ⚙ handler, on an install with no space. This is the line.
    const main = stripComments(repoFile('src/js/main.js'));
    assert.match(main, /function openSettingsWithFamily\(\)\s*\{\s*ensureFamilySettings\(\)/);
    assert.match(main, /mod\.mountSolo\(/);
  });

  test('CLOSED — all seven orphans are gone: five wired, one deleted, and every defence CALLED', () => {
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // FINDING P-4 · HIGH · **CLOSED.** Inverted, not repaired — and not by deletion, which is the
    // outcome this row existed to make impossible.
    //
    // WHAT IT WAS. Walking every entry point — `boot.js`, `main.js`, `firstrun.js` — and
    // following DYNAMIC doors as well as static imports, seven shipped modules were reached by
    // nothing:
    //
    //     src/js/sync/chain.js      src/js/sync/client.js      src/js/sync/cursor.js
    //     src/js/sync/outbox.js     src/js/sync/protocol.js
    //     src/js/crypto/probe.js    src/js/crypto/backup.js
    //
    // Four of the five `sync/` modules are LZP-501's engine, superseded by `family/engine.js` +
    // `sync/personal.js`. Dead code, and only that. **The other three were defences the product
    // did not have**, which is why this row may never be closed by deletion.
    //
    // WHAT LANDED, AND WHERE. Both closures are in `family/familysettings.js`, because that file
    // IS the family entry point and both modules exist to be called from one:
    //
    //   · `crypto/probe.js` — `platform/net.js` said in so many words *"family features are
    //     gated on probeCrypto()"* and nothing called it. `assertSuiteAvailable()` is now the
    //     gate on „Familienkreis erstellen" and on the sealed recovery export, which are two of
    //     the three moments `probe.js`'s own header names. **The third — „Gerät koppeln" —
    //     is still ungated: `family/pairingui.js` is another owner's file. Pinned below.**
    //   · `crypto/backup.js` — ADR 002 §7's recovery file, the artifact the onboarding tells a
    //     person to keep, had no route to it in the UI. „Schlüssel sichern" is that route, and
    //     it renders the module's own `EXPORT_SHEET_COPY` rather than paraphrasing it, so D8's
    //     two arguments stay the sheet's two buttons.
    //
    // WHAT LANDED SINCE, AND WHY THE `sync/` FOUR WERE NOT SIMPLY DELETED.
    //
    //   · `sync/chain.js` implements ADR 002 §5.4's chain-witness verification — the ONE
    //     mechanism the design names for detecting a relay that withholds, reorders or renumbers
    //     ops. `pullNow` now imports it and runs it over every page, together with the page-claim
    //     check that catches the withhold at the END of a page (where there is no hole to find).
    //     `sync-domains.js`'s `S4-diverged` is closed by it and could have been closed by nothing
    //     else. `tests/fleet/fleet-harness.test.js` still imports `verifyChain` directly — that
    //     minimises the WITNESS; `attack-converge-relay.test.js` §2/§4 measures it through the
    //     product's own pull path, which is the difference this row was about.
    //   · `sync/outbox.js` was called dead because `createOutbox` IS superseded by
    //     `store.outbox()`. `createParkingLot` in the same file was superseded by nothing: it is
    //     the durable, capped retention of SEALED envelopes that `core/oplog.js` cannot provide
    //     (P1, P4 and the version gate all refuse before the decrypt, so there is no op to park).
    //     Wired behind a `parkStore` port; it closed all four of finding P-8's park rows.
    //   · `sync/cursor.js` holds the chain HEAD beside the sync position, which is its own
    //     header's argument. Wired behind a `chainStore` port. It is NOT the transport cursor —
    //     ADR 006 §9.1 W1 keeps that in the log, and `store.cursor()` is still the only value
    //     read as `since`.
    //   · `sync/protocol.js` is reached through `chain.js`, which needs its seq helpers.
    //   · `sync/client.js` was LZP-501's superseded ENGINE and nothing else. DELETED — the one
    //     row of the seven where deletion was the right close, and the reason the other four
    //     looked dead: it was their only importer.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    const reached = new Set(
      ['src/js/boot.js', 'src/js/main.js', 'src/js/firstrun.js']
        .flatMap((e) => reachableFrom(e).reached),
    );

    // Measured over P-4's OWN seven modules rather than over `nonDomModules()`, deliberately: a
    // frozen whole-tree list turns red the day any unrelated module is added, and a row that
    // goes red for the wrong reason is a row that gets loosened. This is the finding's domain.
    const P4 = [
      'src/js/crypto/backup.js', 'src/js/crypto/probe.js',
      'src/js/sync/chain.js', 'src/js/sync/cursor.js',
      'src/js/sync/outbox.js', 'src/js/sync/protocol.js',
    ];
    assert.deepEqual(P4.filter((f) => !reached.has(f)), [],
      'P-4 moved — if it grew, a wiring was reverted; name which one');

    // The whole-tree walk is still made, because P-4 was FOUND by it and a new orphan is news.
    // It is reported rather than frozen: the set of modules is another owner's to grow.
    const orphans = nonDomModules().filter((f) => !reached.has(f) && f !== 'src/js/store.js');
    assert.deepEqual(orphans.filter((f) => !P4.includes(f)).filter((f) => !/^src\/js\/sync\//.test(f)), [],
      'a NEW orphan appeared outside sync/ — either wire it or say why it ships');

    // The sharp half, named on its own so it cannot be closed by deleting the dead engine and
    // calling the finding fixed.
    const personal = repoFile('src/js/sync/personal.js');
    assert.match(personal, /from '\.\/chain\.js'/, 'the engine imports the chain witness …');
    // ROUND 9, ONE TOKEN: the call site moved from the LEAF to the WRAPPER in the same module.
    // `pullNow` called `verifyChain` — a pure function over one contiguous run — and had to fake
    // the memory it lacks; findings R8-1 and R8-2 are what that cost on an honest relay. It now
    // calls `createChainWitness().observe()`, which is the stateful thing `chain.js` always
    // shipped. The CLAIM this line makes is unchanged and is the whole point of the row: an
    // import nothing calls is this finding. Both spellings are accepted so that neither the leaf
    // nor the wrapper can be reverted to an unused import without this going red.
    assert.match(personal, /await (verifyChain|witness\.observe)\(/,
      '… and CALLS it — an import nothing calls is this finding');
    assert.match(personal, /from '\.\/outbox\.js'/, 'and the durable parking lot (P-8) the same way …');
    assert.match(personal, /await lot\.park\(/, '… called, not merely imported');

    // …and the two that DID land, asserted as call sites and not as import lines: an import that
    // nothing calls is the exact condition this finding is about.
    const sheet = repoFile('src/js/family/familysettings.js');
    assert.match(sheet, /import \{[^}]*probeCrypto[^}]*\} from '\.\.\/crypto\/probe\.js'/);
    assert.match(sheet, /probePromise = probeCrypto\(\)/, 'probe.js is imported and never called');
    assert.match(sheet, /await assertSuiteAvailable\(\)/, 'the probe is never awaited at an entry point');
    assert.match(sheet, /import \{[^}]*exportBackup[^}]*\} from '\.\.\/crypto\/backup\.js'/);
    assert.match(sheet, /await exportBackup\(/, 'backup.js is imported and never called');

    // The one moment `probe.js` names that is STILL ungated, pinned so it is a work item rather
    // than a discovery. Owner: `family/pairingui.js`.
    assert.equal(/probeCrypto/.test(repoFile('src/js/family/pairingui.js')), false,
      '„Gerät koppeln" is gated now — close the last third of P-4 and invert this line');
  });

  test('FAILED — mounting family settings on a SOLO Mac arms no timer and mints no key', () => {
    // The other half of Principle 7, and the one that would actually cost something: if
    // `mountSolo` armed the 45 s cadence, or probed WebCrypto, or minted an identity "so the
    // section can show the device short", a solo install would be paying for family mode in
    // battery and in entropy. It does none of those, and this is the structural proof:
    // `driveCadence` — the only thing in the product that arms a repeating timer for sync — is
    // called from `startEngine` and from nowhere else, and `startEngine` is reached only from
    // `mount.start()`, which `mountSolo` is not.
    const mount = stripComments(repoFile('src/js/family/mount.js'));
    const engine = stripComments(repoFile('src/js/family/engine.js'));
    const soloBody = mount.slice(mount.indexOf('export function mountSolo'), mount.indexOf('const timerPorts'));
    assert.equal(/startEngine|armStore|driveCadence|generateDeviceKeys|createSpaceKey/.test(soloBody), false,
      `mountSolo starts something: ${soloBody}`);
    assert.equal((engine.match(/driveCadence\(/g) || []).length, 2,
      'driveCadence must have exactly its definition and its one call site');
    assert.match(engine, /const cadence = driveCadence\(sync, p\);/);
  });
});

/** `'syncEnabled'` → `'enabled'`, so a `[FAMILY_PREFS.enabled]:` spelling is matched too. */
function keyName(value) {
  return Object.keys(FAMILY_PREFS).find((k) => FAMILY_PREFS[k] === value);
}

/** Comments are prose; a specifier or a key named only in prose is not a call site. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
