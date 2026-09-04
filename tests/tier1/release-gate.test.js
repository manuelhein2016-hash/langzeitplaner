// tests/tier1/release-gate.test.js — AUDIT F1 and F13, as rows instead of reminders.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
//  WHAT THIS FILE IS FOR
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The audit's F1 was not "`SYNC_ORIGIN_BUILTIN` is empty". Empty is the CORRECT value for a
// build with nowhere to sync to, and the solo product ships on it. F1 was that **no release gate
// named it**, while `docs/v2/RELEASE-CHECKLIST.md` §A *did* force the releaser to substitute a
// relay address into four invitation mails that nothing reads:
//
//   measured at 2d092a6 — `SYNC_ORIGIN_BUILTIN` appeared 0 times in RELEASE-CHECKLIST.md
//                         and 0 times in V2-FINAL.md
//
// So the sheet could be worked top to bottom and ticked honestly, and the result was a build in
// which every family request is refused locally (`no_origin_configured`, before a socket or a
// DNS lookup exists) while the releaser believed they had configured sync. The page cannot fall
// back: `chooseTransport` returns `bridge` inside the shell and `index.html:14` is
// `connect-src 'self'`.
//
// A checklist item is a reminder. This file is the gate. It runs inside `npm test`, which §B of
// that same sheet already requires green before a tag, and it refuses every state except the two
// that are coherent:
//
//   UNSET  · both shells `""`, all four invitations carrying the reserved `.invalid` slot.
//            Nothing syncs, nobody is misdirected. **A shippable solo build** — which is exactly
//            the audit's recommendation, so this file must be GREEN today.
//   SET    · both shells pinned to one https origin, all four invitations naming that same one.
//
// Every other state is a half-done release, and §2 below kills each of them by name.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE MUTANTS GO THROUGH A SUBPROCESS
// ─────────────────────────────────────────────────────────────────────────────────────────────
// `suite-integrity.test.js` allows a tier-1 file to import only `node:*`, `../../src/js/**` and
// `../helpers/**`, and bans `node:fs` here outright so the suite can never touch the user's real
// board. The predicate this file gates on therefore lives in `scripts/mom-test-probe.mjs`
// (`couplingRows`), which is the release instrument that already reads those artefacts, and this
// file reaches it through `--simulate`. The point is that the mutants exercise the **shipped**
// predicate rather than a copy of it living in the test — a copy would go green against itself.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT A QUIT-AND-OPEN DOES TO THIS FINDING — §4, and it is not rhetorical
// ─────────────────────────────────────────────────────────────────────────────────────────────
// The audit's central defect class is that a relaunch turns ops into registers. F1 is not in
// that class and this file must not pretend it is. But the relaunch question still has a real
// answer here and §4 measures it: the pinned origin is a compile-time constant read fresh on
// every request with no cache, so no number of launches can turn an unset origin into a working
// one — while `sync_enabled` IS persisted to `sync.json`, so the refusal a family sees CHANGES
// on the second launch, from `sync_disabled` to `no_origin_configured`. The operator who turns
// the switch on, sees `sync_disabled` explained away as "I haven't enabled it yet", quits, and
// opens again is the person F1 was written for.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { shellSource, rustSource } from '../helpers/helper-hygiene.js';
// The real join parser — the same module the shipped screen and the probe use. Imported so this
// file's claim about "the address in the mail" is a claim about what the app would actually lift
// out of it, and so `suite-integrity`'s "every tier-1 file reaches the real src/" rule is met by
// a module this file genuinely depends on rather than by an ornament.
import { parseInvitePaste } from '../../src/js/family/createjoin.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROBE = path.join(ROOT, 'scripts', 'mom-test-probe.mjs');

/** The reserved slot, spelled here so a silent change to it is a failing row and not a diff. */
const SLOT = 'https://serveradresse-fehlt.invalid';

/** `SYNC_ORIGIN_BUILTIN` as each shell declares it. `null` means the declaration moved. */
function pinnedOrigins() {
  const swift = shellSource().match(/^let SYNC_ORIGIN_BUILTIN = "([^"]*)"/m);
  const rust = rustSource().match(/^const SYNC_ORIGIN_BUILTIN: &str = "([^"]*)";/m);
  return { swift: swift ? swift[1] : null, rust: rust ? rust[1] : null };
}

/** Run the probe and return its rows. Exit code is ignored — the rows are the evidence. */
function probeRows(args = ['--json']) {
  let out;
  try {
    out = execFileSync('node', [PROBE, ...args], { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    // A FAIL row makes the probe exit 1; that is data, not a crash. Exit 2 is a crash.
    if (e.status === 2 || !e.stdout) throw e;
    out = e.stdout;
  }
  return JSON.parse(out).rows;
}

/** `couplingRows` over a supplied state, through the shipped predicate. */
function simulate(state) {
  return probeRows(['--simulate', JSON.stringify(state)]);
}

/**
 * The body of one declaration, from its signature to the first close at column 0.
 *
 * Deliberately at MODULE level rather than inline in the rows that use it:
 * `suite-integrity.test.js` extracts a test body by counting braces, and a `}` inside a STRING
 * inside a test body closes that body early — the test then reads as asserting nothing and the
 * integrity row fails. Found the hard way; kept here so it cannot recur one row at a time.
 */
const declBody = (src, signature) => {
  const at = src.indexOf(signature);
  if (at < 0) return '';
  const rest = src.slice(at);
  const end = rest.search(/\n\}/);
  return end < 0 ? rest : rest.slice(0, end);
};

const rowById = (rows, id) => rows.find((r) => r.id === id);
const FOUR = ['de.txt', 'en.txt', 'de.html', 'en.html'];
/** All four mails naming one origin — the shape `couplingRows` takes. */
const mails = (origin) => Object.fromEntries(FOUR.map((l) => [l, origin]));

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · THE TREE, AS IT STANDS — the honest path
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · the shipped tree is in one of the two coherent states', () => {
  test('§1a · both shells declare SYNC_ORIGIN_BUILTIN, and declare the same one', () => {
    const { swift, rust } = pinnedOrigins();
    assert.notEqual(swift, null,
      'shell-macos/main.swift no longer declares `let SYNC_ORIGIN_BUILTIN = "…"` on one line — '
      + 'this gate reads it by that shape, and a gate that cannot find the value is not a gate');
    assert.notEqual(rust, null,
      'src-tauri/src/lib.rs no longer declares `const SYNC_ORIGIN_BUILTIN: &str = "…";`');
    assert.equal(swift, rust,
      `main.swift pins ${JSON.stringify(swift)} and lib.rs pins ${JSON.stringify(rust)}. `
      + '`sync_request` is one contract with two implementations (net.js §6): two different pins '
      + 'means a build on the other shell talks to a host the demonstrated one does not, and '
      + 'docs/v2/SHELL-VERIFICATION.md\'s SSRF table stops describing it.');
  });

  test('§1b · all four invitations name one address, and the shipped parser can lift it', () => {
    // Through the probe, because reading the four files is its job and tier-1 may not use fs.
    //
    // ⚠ ONE HAZARD MEASURED WHILE INTEGRATING (2026-09-04), worth knowing before the substitution.
    // `createjoin.js#ORIGIN_LABEL_RE` scans the raw paste for „serveradresse" / „server" / „relay"
    // and anchors the address that follows within `LABEL_WINDOW`. The reserved slot's own hostname
    // — `serveradresse-fehlt.invalid` — CONTAINS one of those words. It is harmless in the shipped
    // mails, and this row is why: they carry exactly one bare origin (the release URL has a path
    // and is excluded a step earlier), so there is nothing for a stray anchor to pick between.
    // A mail that ever names two bare origins would be a different matter, and M2a is where that
    // would show up first.
    const rows = probeRows();
    const shapes = FOUR.map((l) => rowById(rows, `M2-${l}`));
    for (const [i, r] of shapes.entries()) {
      assert.ok(r, `the probe no longer reports M2-${FOUR[i]} — the four mails moved`);
      assert.equal(r.status, 'PASS',
        `M2-${FOUR[i]} is ${r.status}: ${r.detail}`);
    }
    const agree = rowById(rows, 'M2a');
    assert.ok(agree, 'the probe no longer reports M2a (the four mails agree)');
    assert.equal(agree.status, 'PASS', agree.detail);
  });

  test('§1c · ██ THE ONE ACT ██ the pinned origin and the invitation address are in step', () => {
    // The row F1 is about. It is what fails when a releaser does one half of the substitution.
    const rows = probeRows();
    const s1 = rowById(rows, 'S1');
    const s2 = rowById(rows, 'S2');
    assert.ok(s1 && s2, 'the probe no longer reports the coupling rows S1/S2');
    assert.equal(s1.status, 'PASS', s1.detail);
    assert.equal(s2.status, 'PASS', s2.detail);
  });

  test('§1d · the release sheet names BOTH halves, in one checklist item', () => {
    // AUDIT F1's measurement, inverted: `SYNC_ORIGIN_BUILTIN` appeared 0 times in
    // RELEASE-CHECKLIST.md at 2d092a6. Two separate items would not close it — the whole failure
    // is one being done and the other not — so the row asserts they are in the SAME item.
    const s3 = rowById(probeRows(), 'S3');
    assert.ok(s3, 'the probe no longer reports S3 (the release sheet names both halves)');
    assert.equal(s3.status, 'PASS', s3.detail);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · THE MUTANTS — each one names the row that dies
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Driven through `mom-test-probe.mjs --simulate`, so these kill the SHIPPED predicate. Each case
// is a state a releaser can actually reach by doing part of §A's ⛔ item, and each is a state the
// old sheet would have ticked green.

describe('§2 · every half-done substitution is refused, and the honest paths are not', () => {
  const REAL = 'https://relay.example.org';

  test('§2a · CONTROL · both unset, coherently — the solo build, and it must pass', () => {
    const rows = simulate({ swift: '', rust: '', mails: mails(SLOT) });
    assert.deepEqual(rows.map((r) => r.status), ['PASS', 'PASS'],
      `the coherent UNSET state was refused — this gate would block the solo release:\n`
      + rows.map((r) => `  ${r.id} ${r.status}: ${r.detail}`).join('\n'));
  });

  test('§2b · CONTROL · both set to the same host — the family build, and it must pass', () => {
    const rows = simulate({ swift: REAL, rust: REAL, mails: mails(REAL) });
    assert.deepEqual(rows.map((r) => r.status), ['PASS', 'PASS'],
      `the coherent SET state was refused — this gate would block the family release:\n`
      + rows.map((r) => `  ${r.id} ${r.status}: ${r.detail}`).join('\n'));
  });

  test('§2c · MUTANT · the mail was substituted and the shells were not — S2 dies', () => {
    // ██ THIS IS F1 ██. It is what the old sheet produced: the ⛔ item made the releaser write a
    // relay address into four mails, and nothing made them write it anywhere the app reads.
    const rows = simulate({ swift: '', rust: '', mails: mails(REAL) });
    const s2 = rowById(rows, 'S2');
    assert.equal(s2.status, 'FAIL',
      'the exact state AUDIT F1 describes — mail substituted, SYNC_ORIGIN_BUILTIN still "" — is '
      + 'accepted by this gate. Every sync_request in that build is refused locally.');
    assert.match(s2.detail, /HALF DONE/);
  });

  test('§2d · MUTANT · the shells were substituted and the mail was not — S2 dies', () => {
    const rows = simulate({ swift: REAL, rust: REAL, mails: mails(SLOT) });
    const s2 = rowById(rows, 'S2');
    assert.equal(s2.status, 'FAIL',
      'a build that syncs to a host no invitation names is accepted. The joiner is handed an '
      + 'address that cannot resolve and meets circleErrOffline — the sentence for a server that '
      + 'is down, not for one that was never written in.');
    assert.match(s2.detail, /HALF DONE the other way/);
  });

  test('§2e · MUTANT · the two halves name DIFFERENT hosts — S2 dies', () => {
    const rows = simulate({
      swift: REAL, rust: REAL, mails: mails('https://someone-elses-relay.example.net'),
    });
    const s2 = rowById(rows, 'S2');
    assert.equal(s2.status, 'FAIL',
      'the worst state of the three is accepted: the app refuses every request as '
      + '`url_is_not_the_pinned_origin`, and a stranger was sent an address belonging to '
      + 'somebody else.');
    assert.match(s2.detail, /TWO DIFFERENT HOSTS/);
  });

  test('§2f · MUTANT · one shell substituted and not the other — S1 dies', () => {
    const rows = simulate({ swift: REAL, rust: '', mails: mails(REAL) });
    const s1 = rowById(rows, 'S1');
    assert.equal(s1.status, 'FAIL',
      'the two shells may pin different origins. The Rust half has never been compiled '
      + '(PLAN.md R8), so a source row is the only thing holding it to the Swift one.');
  });

  test('§2g · MUTANT · the four mails disagree with each other — S2 dies', () => {
    const split = { 'de.txt': REAL, 'en.txt': REAL, 'de.html': SLOT, 'en.html': SLOT };
    const rows = simulate({ swift: REAL, rust: REAL, mails: split });
    const s2 = rowById(rows, 'S2');
    assert.equal(s2.status, 'FAIL',
      'a de/en split is accepted — half a family would be sent to a host the other half never '
      + 'heard of. The `sed` in the HTML head comments is written over `invitation.*` precisely '
      + 'so this cannot happen by hand.');
  });

  test('§2h · MUTANT · the declaration is gone from a shell — S1 dies rather than passing', () => {
    // A gate that silently reads `null` as "unset" would go green the day somebody renames the
    // constant. This is the row that stops this file from becoming decorative.
    const rows = simulate({ swift: null, rust: '', mails: mails(SLOT) });
    const s1 = rowById(rows, 'S1');
    assert.equal(s1.status, 'FAIL', 'a missing declaration reads as "unset" and passes');
    assert.match(s1.detail, /main\.swift/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · AUDIT F13 — the placeholder is unregistrable, and the probe fails ON it
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The old placeholder was `https://lzp-sync-po.vercel.app`, in all four shipped invitations.
// Measured live on 2026-09-03 and again here from the audit's record: HTTP **404** with
// `x-vercel-error: DEPLOYMENT_NOT_FOUND` — the name belonged to nobody and a `*.vercel.app`
// project name is claimable by anyone. And `scripts/mom-test-probe.mjs:67` hardcoded and
// ASSERTED that string, while RELEASE-CHECKLIST §B lists the probe as a per-release gate: green
// meant "nobody has substituted it yet", and doing the correct thing turned the gate red.

describe('§3 · the slot cannot be claimed, and the gate fails while it stands', () => {
  test('§3a · the four invitations name a host in a TLD no registry can delegate', () => {
    const rows = probeRows();
    const u = rowById(rows, 'M2u');
    assert.ok(u, 'the probe no longer reports M2u (the placeholder is unregistrable)');
    assert.equal(u.status, 'PASS', u.detail);
    // Independently of the probe's own verdict: the address the shipped parser lifts out of a
    // paste of the slot is in `.invalid`, RFC 2606 §2 — "sure to be invalid", never delegated.
    const lifted = parseInvitePaste(`Serveradresse:\n    ${SLOT}\n`).origin;
    assert.equal(lifted, SLOT, 'the parser no longer lifts the slot out of a paste');
    assert.match(new URL(lifted).host, /\.invalid$/,
      'the invitation placeholder is a REGISTRABLE name again. Whoever claims it receives, in '
      + 'the clear, a redeemable invite token from every reader of an unsubstituted invitation — '
      + 'AUDIT F13, and the reason `lzp-sync-po.vercel.app` was replaced rather than kept.');
  });

  test('§3b · ██ the substitution row FAILS on the slot and PASSES on a claimed host ██', () => {
    // ██ THE INVERSION, AND IT IS ASSERTED AS A FUNCTION, NOT AS A TREE STATE ██
    //
    // The trap F13 names is a gate that goes red when the correct thing is done. Pinning "M2s is
    // FAIL" here would rebuild exactly that: the day the PO claims a host and substitutes it in
    // all six places, `npm test` would go red for bookkeeping. So this row drives the shipped
    // verdict function over both branches instead, and stays green in either state of the tree.
    const rows = simulate({
      swift: '', rust: '', mails: mails(SLOT),
      // `https://github.com` — the ORIGIN `parseInvitePaste` would yield if it took the DMG
      // download link instead of the relay line. The full link carries a path, which is refused
      // one rule earlier as `not_an_origin`; this is the interesting case.
      relay: [SLOT, 'https://relay.example.org', null, 'https://github.com'],
    });
    const v = (i) => rowById(rows, `V${i}`);

    assert.equal(v(0).status, 'FAIL',
      'the reserved slot is accepted as a relay address. Green would then mean "nobody has '
      + 'substituted the address yet" — which is exactly what scripts/mom-test-probe.mjs:67 '
      + 'meant before AUDIT F13, when it hardcoded and ASSERTED the placeholder.');
    assert.match(v(0).detail, /^placeholder/);

    assert.equal(v(1).status, 'PASS',
      'a claimed https host is refused, so doing the work would turn this gate red — the failure '
      + 'F13 named, rebuilt one row over.');

    assert.equal(v(2).status, 'FAIL',
      'a mail carrying NO address passes. submitJoin refuses with circleNeedRelayForJoin — „In '
      + 'der Einladung stand auch eine Serveradresse" — a sentence that would not be true of it.');
    assert.match(v(2).detail, /^none/);

    assert.equal(v(3).status, 'FAIL',
      'the DMG download host passes as a relay. The screen would say „Server aus der Einladung '
      + 'übernommen" and name a host that does not speak the protocol.');
    assert.match(v(3).detail, /^download_host/);
  });

  test('§3b2 · the tree\'s own M2s row agrees with that function — a report, not a blocker', () => {
    // Consistency only: whichever state the tree is in, the reported row must match the verdict.
    // It cannot block the correct act, because both branches are legal.
    const rows = probeRows();
    const m2s = rowById(rows, 'M2s');
    assert.ok(m2s, 'the probe no longer reports M2s (the substitution row)');
    const stillSlot = /reserved SLOT/.test(m2s.detail);
    assert.equal(m2s.status, stillSlot ? 'FAIL' : 'PASS',
      `M2s says ${m2s.status} while its own detail reads ${JSON.stringify(m2s.detail.slice(0, 120))}`);
    // Said plainly for whoever reads the run: a red M2s means the Familienkreis is not
    // shippable, and it is the only thing standing between this tree and a family release.
    assert.ok(typeof m2s.detail === 'string' && m2s.detail.length > 0, 'M2s reports nothing');
  });

  test('§3c · the old placeholder is gone from every invitation file', () => {
    // Through the probe's own report rather than a grep, so this row moves with the artefacts.
    const rows = probeRows();
    for (const l of FOUR) {
      const r = rowById(rows, `M2-${l}`);
      assert.ok(!/lzp-sync-po/.test(r.detail),
        `${l} still names the unclaimed vercel placeholder: ${r.detail}`);
    }
  });

  test('§3d · both shells refuse a `.invalid` pin BY NAME, in the same words', () => {
    // Defence in depth for the same finding: if the slot is ever pasted into
    // SYNC_ORIGIN_BUILTIN by mistake, the refusal should say what happened rather than let a
    // DNS failure be blamed on the connection ("Keine Verbindung zum Server").
    const swift = shellSource();
    const rust = rustSource();
    assert.match(swift, /func isReservedSyncHost\(/, 'the Swift shell dropped the reserved-name rule');
    assert.match(rust, /fn is_reserved_sync_host\(/, 'the Rust shell dropped the reserved-name rule');
    for (const [name, src] of [['swift', swift], ['rust', rust]]) {
      assert.match(src, /origin_host_is_a_reserved_name_that_cannot_resolve/,
        `the ${name} shell no longer names the reserved-origin refusal`);
      assert.match(src, /\.invalid/, `the ${name} shell no longer matches the .invalid suffix`);
    }
    // Narrow on purpose: `https://relay.example.org` is the origin the tier-2 SSRF table drives
    // a SUCCESSFUL request against, so widening this rule to every reserved name would break a
    // working demonstration in order to make a point.
    for (const [name, src] of [['swift', swift], ['rust', rust]]) {
      const body = declBody(src, name === 'swift' ? 'func isReservedSyncHost(' : 'fn is_reserved_sync_host(');
      assert.ok(!/example\.org|"\.test"|'\.test'/.test(body),
        `the ${name} reserved-name rule grew past .invalid and now refuses an origin the tier-2 `
        + 'SSRF table expects to succeed');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · A QUIT-AND-OPEN CANNOT REPAIR THIS, AND IT CHANGES WHICH REFUSAL IS SEEN
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The audit's headline defect class is a relaunch turning ops into registers. F1 is not in that
// class — there is no fold and no register here — but "does it survive a quit-and-open" still
// has a measurable answer, and stating it is cheaper than implying it.

describe('§4 · the refusal is launch-invariant; the switch that precedes it is not', () => {
  test('§4a · the pinned origin is read fresh on every request — nothing caches it', () => {
    // If either shell memoised `pinnedSyncOrigin()` into a lazily-initialised global, a build
    // could behave differently on its second launch for reasons no test could see. Neither does.
    const swift = shellSource();
    assert.match(swift, /func syncOriginSetting\(\) -> String \{/,
      'syncOriginSetting moved; this row reads its body');
    const fn = declBody(swift, 'func syncOriginSetting() -> String ');
    assert.match(fn, /return SYNC_ORIGIN_BUILTIN/,
      'the Swift shell no longer falls back to the compiled-in constant');
    assert.ok(!/static |lazy var |cached/.test(fn),
      'syncOriginSetting caches — the origin could then differ between the first launch and '
      + 'every one after it, for reasons no suite in this project can see');

    const rust = rustSource();
    const rfn = declBody(rust, 'fn sync_origin_setting() -> String ');
    assert.match(rfn, /SYNC_ORIGIN_BUILTIN/, 'the Rust shell dropped the compiled-in constant');
    assert.ok(!/OnceLock|lazy_static|static /.test(rfn), 'sync_origin_setting caches');
  });

  test('§4b · the switch IS persisted, so the second launch shows a different refusal', () => {
    // This is the human shape of F1 and it is why "it said sync was off" is not reassurance.
    // `SyncPrefs` is a FILE (`sync.json`), loaded inside the preflight on every request, and the
    // switch is checked BEFORE the origin. So: launch 1, switch off → `sync_disabled`, which an
    // operator explains away. Turn it on. Quit. Launch 2 → the switch is still on, and the
    // refusal every family request now gets is `no_origin_configured` — the real one, which no
    // number of further launches will change.
    const swift = shellSource();
    assert.match(swift, /let SYNC_PREFS_FILE = "sync\.json"/, 'the switch is no longer a file');
    const preBody = declBody(swift, 'func syncPreflight(');
    const switchAt = preBody.indexOf('SyncPrefs.load()');
    const originAt = preBody.indexOf('pinnedSyncOrigin()');
    assert.ok(switchAt >= 0, 'syncPreflight no longer loads the switch from disk on each request');
    assert.ok(originAt >= 0, 'syncPreflight no longer consults the pinned origin');
    assert.ok(switchAt < originAt,
      'the origin is now consulted before the switch. Solo mode makes zero requests BECAUSE the '
      + 'switch is first and both checks are pure — reordering them is how a solo Mac starts '
      + 'resolving a name.');

    const rust = rustSource();
    const rpre = rust.slice(rust.indexOf('    // 1 — the switch. ADR 003 §7 gate 3.'));
    const rbody = rpre.slice(0, 900);
    assert.ok(rbody.indexOf('SyncPrefs::load(') < rbody.indexOf('pinned_sync_origin()'),
      'the Rust shell consults the origin before the switch');
  });

  test('§4c · an unset origin refuses locally — no socket, no DNS, however many launches', () => {
    // The mechanism, named: `normalizeSyncOrigin("")` returns `no_origin_configured` and
    // `syncPreflight` is pure up to that point — no URLSession is allocated, so there is no
    // request to succeed on a later launch.
    const swift = shellSource();
    const body = declBody(swift, 'func normalizeSyncOrigin(');
    assert.match(body, /if trimmed\.isEmpty \{ return \.failure\(\.noOriginConfigured\) \}/,
      'the empty pinned origin no longer refuses first — an empty string that reached URL '
      + 'parsing would be a shape error, and the reason a release cannot sync would stop being '
      + 'legible in the refusal ledger');
    assert.ok(!/URLSession|dataTask/.test(body),
      'normalizeSyncOrigin allocates a session — "solo mode makes zero requests" is supposed to '
      + 'be a property of the order these checks run in');
  });
});
