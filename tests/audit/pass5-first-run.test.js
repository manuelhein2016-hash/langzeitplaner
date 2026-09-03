// tests/audit/pass5-first-run.test.js — PASS 5, the audit half of the Mom test.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE IS. It is not a suite. It is an AUDITOR'S EVIDENCE FILE: every row asserts a
// FINDING — a thing that is true today and costs a person something. Each row therefore goes
// RED on the day the finding is fixed, which is the point: a fixed finding should be noticed,
// not silently forgotten. Nothing in `src/`, `server/`, `docs/` or any existing test is
// touched by this file.
//
//   run:  node --test --import ./tests/helpers/dev-flag.mjs "tests/audit/*.test.js"
//
// The rows are ordered BY WHAT THEY COST A PERSON, not by how interesting they are.
//
//   §1  the disk image she receives carries no window and no unlock page   (install, blocking)
//   §2  the relay address in the shipped e-mail belongs to nobody          (join, blocking)
//   §3  the only automated check on that address PINS THE PLACEHOLDER      (why nobody notices)
//   §4  what a wrong host is handed on the very first request              (what it costs)
//   §5  the e-mail's picture is a picture of a window that will not open   (step 1, cosmetic-
//                                                                          looking, is not)
// ═══════════════════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const MAILS = [
  'docs/v2/email/invitation.de.txt',
  'docs/v2/email/invitation.en.txt',
  'docs/v2/email/invitation.de.html',
  'docs/v2/email/invitation.en.html',
];
const PLACEHOLDER_ORIGIN = 'https://lzp-sync-po.vercel.app';

// ── §1 · THE DISK IMAGE ────────────────────────────────────────────────────────────────────
// Everything here happens before the app has drawn one pixel, so nothing inside the app can
// mitigate any of it.

test('§1a · make-dmg.sh stages exactly two visible items — the unlock page is not one of them',
  () => {
    const sh = read('scripts/make-dmg.sh');
    // The staging block, verbatim. Three `cp`/`ln` lines land in $STAGE, and one of them is
    // the hidden background art.
    const staged = [...sh.matchAll(/^\s*(?:cp|ln|mkdir)[^\n]*\$STAGE[^\n]*$/gm)].map((m) => m[0].trim());
    assert.ok(staged.length > 0, 'the staging lines moved; re-read the script');
    const visible = staged.filter((l) => !l.includes('.background'));
    assert.equal(visible.length, 2, `expected app + Applications, got:\n  ${staged.join('\n  ')}`);
    assert.ok(visible.some((l) => l.includes('$VOLNAME.app')), 'the app is staged');
    assert.ok(visible.some((l) => l.includes('/Applications')), 'the drop target is staged');

    // FINDING. `Bitte zuerst lesen.html` is built by scripts/build-unlock-page.sh and never
    // staged by anything. `firstrun.js`'s own header calls the disk image the surface that
    // "Mom actually reads"; it is not on the disk image.
    assert.ok(!sh.includes('lesen'),
      'FIXED: make-dmg.sh now stages the unlock page — delete this row and MOM-TEST §3.3.');
  });

test('§1b · build-unlock-page.sh says outright that nothing consumes what it builds', () => {
  const sh = read('scripts/build-unlock-page.sh');
  assert.match(sh, /this script produces the file and nothing consumes it/);
  // And the file it produces is real, so this is a wiring gap and not a missing artefact.
  assert.match(sh, /build\/dmg\/Bitte zuerst lesen\.html/);
});

test('§1c · so exactly ONE surface reaches her before macOS refuses the app: step 3 of the mail',
  () => {
    // Surface 1 — the disk image: covered by §1a.
    // Surface 2 — the in-app screen. It asks the host `gatekeeper_status` and shows nothing
    // without a documented yes. Neither shell answers.
    assert.match(read('src/js/firstrun.js'), /invoke\('gatekeeper_status'/);
    assert.ok(!read('shell-macos/main.swift').includes('gatekeeper_status'),
      'FIXED: the Swift shell answers the probe now.');
    assert.ok(!read('src-tauri/src/lib.rs').includes('gatekeeper_status'),
      'FIXED: the Tauri shell answers the probe now.');
    // Surface 3 — the e-mail. It is the only one left, and it is the one she can skim.
    for (const f of MAILS) {
      const t = read(f).toLowerCase();
      assert.ok(t.includes('dennoch öffnen') || t.includes('open anyway'),
        `${f}: the unlock route is the last surface standing and must be in every file`);
    }
  });

// ── §2 · THE RELAY ADDRESS ─────────────────────────────────────────────────────────────────

test('§2a · all four shipped invitations name a host that is a placeholder, not a deployment',
  () => {
    for (const f of MAILS) {
      assert.ok(read(f).includes(PLACEHOLDER_ORIGIN), `${f}: no relay origin`);
    }
    // Measured out of band on 2026-09-03 and reproducible with one command:
    //
    //   $ curl -si https://lzp-sync-po.vercel.app/api/v1/meta
    //   HTTP/2 404
    //   x-vercel-error: DEPLOYMENT_NOT_FOUND
    //   server: Vercel
    //
    // A *.vercel.app project name is first-come. Until the PO claims it, the address in a
    // family invitation is registrable by a stranger.
  });

test('§2b · the join screen sends the invite to whatever origin the mail named — no pinning',
  async () => {
    const src = read('src/js/family/createjoin.js');
    // `armForRelay(origin)` builds the transport from the string that came out of the paste.
    assert.match(src, /async function armForRelay\(origin\)/);
    assert.match(src, /ports\.transport\(\s*origin,/);
    // FINDING: nothing anywhere binds the relay's identity to the invitation. There is no
    // pinned key, no fingerprint in the code, no expected host. `normalizeOrigin` checks the
    // SHAPE of the address (https, no path, no credentials) and nothing about WHO answers.
    assert.ok(!/pinnedRelay|relayFingerprint|expectedRelayKey/.test(src),
      'FIXED: the client now binds the relay identity — re-read §2 and §4.');
  });

// ── §3 · WHY NOTHING GOES RED ──────────────────────────────────────────────────────────────

test('§3a · no CI gate refuses the placeholder host — check-email-copy.mjs never looks at it',
  () => {
    const gate = read('.github/scripts/check-email-copy.mjs');
    assert.ok(!gate.includes('vercel'),
      'FIXED: the copy gate now checks the relay origin.');
    assert.ok(!/RELAY|relay/.test(gate),
      'FIXED: the copy gate now knows about the relay address at all.');
  });

test('§3b · and the ONE automated check that reads the address ASSERTS THE PLACEHOLDER IS THERE',
  () => {
    const probe = read('scripts/mom-test-probe.mjs');
    assert.match(probe, new RegExp(`const RELAY_ORIGIN = '${PLACEHOLDER_ORIGIN.replace(/[.]/g, '\\.')}'`));
    // Row M2 passes when the parsed origin EQUALS that constant. So:
    //   · placeholder left in all four mails + probe untouched  → GREEN   (ships the wrong host)
    //   · real origin substituted in the mails, probe untouched → RED     (looks like a regression)
    // Green therefore means "nobody has substituted the address yet", which is the opposite of
    // what a green probe reads as. RELEASE-CHECKLIST §B lists `mom-test-probe.mjs → exit 0` as
    // a per-release gate.
    assert.match(probe, /parsed\.origin === RELAY_ORIGIN/);
  });

test('§3c · the probe is green TODAY, and green is the state that ships the placeholder', () => {
  const out = execFileSync('node', [join(ROOT, 'scripts/mom-test-probe.mjs')],
    { cwd: ROOT, encoding: 'utf8' });
  const m = out.match(/(\d+) rows · (\d+) pass · (\d+) note · (\d+) FAIL/);
  assert.ok(m, `probe output changed shape:\n${out}`);
  const [, rows, pass, note, fail] = m.map(Number);
  assert.equal(fail, 0, 'the probe reports FAILs again');
  assert.deepEqual([rows, pass, note], [35, 33, 2],
    'measured 2026-09-04: 35 rows · 33 pass · 2 note · 0 FAIL');
});

// ── §4 · WHAT A WRONG HOST IS HANDED ───────────────────────────────────────────────────────

test('§4a · the redemption body is a pure function of the code — the proof is replayable',
  async () => {
    const cj = await import('../../src/js/family/createjoin.js');
    const a = await cj.deriveInvite('J17Z-XSXN-7CSQ');
    const b = await cj.deriveInvite('j17z xsxn 7csq');   // same code, different typing
    assert.equal(a.inviteId, b.inviteId);
    assert.equal(a.proof, b.proof);
    // FINDING, and this is the cost of §2a. `proof` is HKDF(code) with no salt, no nonce, no
    // origin and no timestamp mixed in, and `SHA-256(proof) === verifier` is the WHOLE of what
    // the relay checks (server/core/handlers/invites.js). So the first request a joiner makes
    // to a host she got out of an e-mail hands that host a token that redeems the invite
    // against the REAL relay, unchanged. A stranger holding `lzp-sync-po.vercel.app` does not
    // have to break anything; he is handed the seat.
    assert.equal(a.verifier.length > 0, true);
    // ...and it is not bound to the request either: no HMAC over the URL, no channel binding.
    const src = read('src/js/family/createjoin.js');
    assert.match(src, /'POST', '\/api\/v1\/invites\/redeem', undefined, \{/);
    assert.match(src, /inviteId: invite\.inviteId,\s*\n\s*proof: invite\.proof,/);
  });

test('§4b · and the screen believes the answer: spaceId, member count and "keys are coming"',
  () => {
    const src = read('src/js/family/createjoin.js');
    // Every one of these is read straight off the reply body.
    assert.match(src, /spaceId: body\.spaceId/);
    assert.match(src, /members: Array\.isArray\(body\.members\) \? body\.members : \[\]/);
    assert.match(src, /keysPending: body\.pendingKeys !== false/);
    // FINDING: a host that answers 200 with any object puts her on the „du bist dabei" screen
    // with a fabricated member count. D9 still holds — a fake relay mints no epoch key and can
    // read nothing — so the damage is a burnt invite, a wasted afternoon, and a person who has
    // been told she joined a family that does not exist. That is a Mom-test failure that is
    // not about her.
  });

// ── §5 · THE PICTURE IN THE E-MAIL ─────────────────────────────────────────────────────────

test('§5a · step 1 of both mails describes a window that only exists if Finder was driven', () => {
  assert.match(read('docs/v2/email/invitation.de.txt'),
    /links das Kalender-Symbol, rechts ein blauer\s+Ordner, dazwischen ein Pfeil/);
  assert.match(read('docs/v2/email/invitation.en.txt'),
    /the calendar icon on the left, a blue folder on the\s+right, an arrow in between/);
  // The arrow is painted INTO the background art (assets/dmg/background.svg); it is not a
  // Finder decoration. No .DS_Store ⇒ no background ⇒ no arrow, and the icons sit wherever
  // Finder defaults put them.
  assert.match(read('scripts/make-dmg.sh'), /background picture of viewOptions/);
  assert.match(read('scripts/make-dmg.sh'),
    /::warning:: Finder layout could not be applied/);
  // Measured 2026-09-04 on this machine, and it is the state the docs record for CI too:
  //   ./scripts/make-dmg.sh …/LangzeitPlaner.app
  //     ::warning:: Finder layout could not be applied (no GUI session or Automation not permitted).
  //   hdiutil attach → the mounted image holds .background/, Applications, LangzeitPlaner.app
  //   and NO .DS_Store.
});

test('§5b · and the HTML mail ships a photograph of that window as its only image', () => {
  for (const f of ['docs/v2/email/invitation.de.html', 'docs/v2/email/invitation.en.html']) {
    const html = read(f).replace(/<!--[\s\S]*?-->/g, '');
    const imgs = [...html.matchAll(/<img\b[^>]*>/gi)];
    assert.equal(imgs.length, 1, `${f}: exactly one image`);
    assert.match(imgs[0][0], /LangzeitPlaner-Installation\.png/);
    // The alt text is the whole of step 1 when images are blocked, and it names the arrow too.
    assert.match(imgs[0][0], /Pfeil|arrow/i);
  }
  // FINDING: if the release DMG ever ships unstyled, the e-mail's picture and its alt text both
  // describe a window she will not see, at the exact moment she is deciding whether she did it
  // right. release.yml gates on `.DS_Store` and exits 1 without it — see §6 of the report — so
  // today the two states are "no release at all" or "a release whose window nobody has seen".
});

test('§5c · the built email illustration exists and is the one the mail references', () => {
  const png = join(ROOT, 'build/email/LangzeitPlaner-Installation.png');
  if (!existsSync(png)) {
    // Built by scripts/build-release-assets.sh; skipped rather than failed so this file runs
    // on a clean checkout.
    return;
  }
  assert.ok(readFileSync(png).length > 50_000, 'the illustration is a real render');
});
