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

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // ██ REVERSED 2026-09-05 · LZP-1009 SECOND PASS · PO decision 1 ██
    // ─────────────────────────────────────────────────────────────────────────────────────────
    //
    // WHAT THIS ASSERTION SAID, VERBATIM:
    //
    //   > assert.ok(switchAt < originAt,
    //   >   'the origin is now consulted before the switch. Solo mode makes zero requests
    //   >    BECAUSE the switch is first and both checks are pure — reordering them is how a
    //   >    solo Mac starts resolving a name.')
    //
    // THE STATED MECHANISM WAS WRONG, AND THAT IS THE INTERESTING PART. Solo mode made zero
    // requests because BOTH checks are pure, not because of their order. `pinnedSyncOrigin()` is
    // a compiled-in constant plus a trimmed string; `syncCanonicalURL` is `URLComponents` and
    // string comparison. Neither resolves a name, allocates a `URLSession` or opens a socket.
    // The order was load-bearing for the REASON STRING an operator sees — F1's human shape,
    // which the rest of this row still asserts — and this row had quietly promoted it into the
    // reason no packet leaves. Nothing in this project ever measured that claim; the row said it,
    // and being green is what a claim like that looks like when nobody has checked it.
    //
    // The carve-out (`syncSoloSendIsAllowed`) forced the question, because it must decide on a
    // CANONICAL url — `/api/v1/%66eedback` and `/api/v1/feedback/../feedback` are the same path
    // to a server and different strings to a comparison. Deciding it before the rebuild would
    // mean deciding it on the string the page sent, which is the whole class of bug the pin and
    // the rebuild exist to close. So the switch moved to step 4, after the pin, the rebuild and
    // the method, and before the body and the headers.
    //
    // WHAT IS ASSERTED NOW is the property that actually holds and that actually matters: the
    // switch is read AFTER the pin and the canonical rebuild, and BEFORE anything that could
    // originate traffic. `tests/tier1/headless-shell.test.js:208-247` carries the full argument
    // and the six mutants that prove the carve-out is exact-equality rather than a prefix;
    // `scripts/shell-ssrf.mjs`'s `carveout` mode observes the order from outside the process.
    assert.ok(originAt < switchAt,
      'the switch is now read BEFORE the canonical rebuild. The carve-out would then be decided '
      + 'on the string the page sent rather than on a canonical URL, which is exactly the class '
      + 'of bug the pin and the rebuild exist to close.');
    // …and still before a socket can exist. This is the half the old row was reaching for.
    const sessionAt = preBody.indexOf('URLRequest(url: url)');
    assert.ok(sessionAt >= 0, 'syncPreflight no longer builds a request — this row reads its body');
    assert.ok(switchAt < sessionAt,
      'the switch is now read after the request object is built — solo mode would be constructing '
      + 'a request it then throws away, and the next edit is the one that sends it');

    const rust = rustSource();
    const rpre = rust.slice(rust.indexOf('    // 1 — the pin. Configuration, never a parameter'));
    const rbody = rpre.slice(0, 1400);
    assert.ok(rbody.indexOf('pinned_sync_origin()') < rbody.indexOf('SyncPrefs::load('),
      'the Rust shell reads the switch before the pin — the two shells now disagree about the '
      + 'order, which is the one thing this pair of assertions exists to prevent');
    const rCanon = rbody.indexOf('sync_canonical_url(');
    assert.ok(rCanon >= 0, 'the Rust preflight no longer canonicalises at all');
    assert.ok(rCanon < rbody.indexOf('SyncPrefs::load('),
      'the Rust shell reads the switch before the canonical rebuild');
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

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · THE PIPELINE CANNOT LIE ABOUT NOTARIZATION — LZP-1010, 2026-09-05
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT WAS ACTUALLY WRONG, STATED PRECISELY, BECAUSE THE OBVIOUS VERSION IS WRONG
// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tauri's bundler DOES set the hardened runtime and DOES invoke `notarytool` when the
// `APPLE_API_*` variables are present. Nobody needed to teach the pipeline to notarize. Two
// other things were true and neither had a row:
//
//   1. NOTHING IN THIS REPOSITORY ASSERTED IT WORKED. The only Gatekeeper check was
//      `release.yml`'s `spctl --assess --type execute … || true` — seven characters that turn
//      the one command able to tell a notarized build from an unsigned one into a comment. A
//      notarization that silently failed would publish a DMG that presents to the PO's mother
//      exactly as the D1 build did: „Apple konnte nicht überprüfen…". The 99 € would have
//      bought a green tick and nothing else.
//
//   2. `dmg-add-readme.sh:122-136` REWRITES THE IMAGE AFTER TAURI BUILT IT — `hdiutil convert`
//      to UDZO and then `mv` over the original — and re-signs it. `codesign --force --sign`
//      puts a signature back. It cannot put a staple back. That branch had never run: it was
//      dead under D1 because the identity was the ad-hoc "-", and it stopped being dead the
//      moment `ENABLE_APPLE_SIGNING` became `true`. Its own warning said the staple must be
//      produced after it, addressed to nobody.
//
// The fix is three steps of shell (`release.yml` step 9b, and the branch in step 10) and it is
// not testable from here: no runner, no certificate, no notarytool. What IS testable — and what
// this section does — is that the steps exist, in the one order that works, with no `|| true`
// on the branch where a rejection is a lie, and with the `|| true` intact on the branch where
// `rejected` is the honest answer.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THESE ROWS GO THROUGH `check-release-config.mjs`
// ─────────────────────────────────────────────────────────────────────────────────────────────
// Same reason §2 goes through `mom-test-probe.mjs`: tier 1 may not touch the filesystem, and a
// predicate written twice goes green against itself. The pre-flight is the instrument that
// already runs in `ci.yml:209` and in `release.yml`'s step 4, so putting the rows there means
// the mutants below kill the thing that actually gates a release. `--dump` hands this file the
// real sources; `--simulate -` runs the shipped rows over a mutated copy.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// TWO WAYS THIS SECTION WAS ALREADY WRONG ONCE, BOTH FOUND BY RUNNING THE MUTANTS
// ─────────────────────────────────────────────────────────────────────────────────────────────
//  · The first predicate counted `spctl --assess` occurrences in the whole step and reported
//    "2 hard, 2 informational" over a step that runs two commands: it was counting the
//    `::error` messages that NAME the command, and the comment block that quotes the old line
//    verbatim. Deleting the real invocation left the row green. `commandLines()` in the
//    pre-flight is that fix, and §5k below is the row that keeps it.
//  · The first mutants were no-ops. `src.replace('--options runtime ', '')` hit the sentence in
//    a COMMENT that explains why the flag is there, left the command untouched, and reported a
//    dead mutant as a live one. `mutate()` below only edits lines that run.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const PREFLIGHT = path.join(ROOT, '.github', 'scripts', 'check-release-config.mjs');

/** The four sources the pre-flight reads, verbatim, without this file opening a file. */
function sources() {
  return JSON.parse(execFileSync('node', [PREFLIGHT, '--dump'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }));
}

/** The shipped §5/§6 rows over supplied sources. Anything omitted falls back to the real tree. */
/**
 * @param {object} [state] sources to substitute; anything omitted falls back to the real tree
 * @param {{GITHUB_REPOSITORY?: string|null}} [envOverride]
 *   `SH-SLUG` reads `process.env.GITHUB_REPOSITORY` as its fallback comparand, so a test that
 *   INHERITS the environment asserts a different thing on a laptop than it does on a runner.
 *   Pass `null` to unset it. Every SH-SLUG case names the value it means; see §6e.
 */
function preflightRows(state = {}, envOverride = {}) {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(envOverride)) {
    if (v === null || v === undefined) delete env[k]; else env[k] = v;
  }
  const out = execFileSync('node', [PREFLIGHT, '--simulate', '-'], {
    cwd: ROOT, encoding: 'utf8', input: JSON.stringify(state), maxBuffer: 64 * 1024 * 1024, env,
  });
  return JSON.parse(out).rows;
}

/**
 * Replace `find` with `replace`, but ONLY on lines that run — never inside a comment.
 *
 * Both files quote their own commands in their comments (the inverted `|| true` line, the
 * sentence explaining `--options runtime`), so a plain `String.replace` edits the prose and
 * leaves the command alone: a mutant that changes nothing and reports success.
 */
const mutate = (src, find, replace) =>
  src.split('\n').map((l) => (/^\s*#/.test(l) ? l : l.split(find).join(replace))).join('\n');

const nRow = (rows, id) => rows.find((r) => r.id === id);

describe('§5 · the notarization chain exists, in order, and nothing swallows its verdict', () => {
  test('§5a · CONTROL · every notarization row is green on the tree as it stands', () => {
    const rows = preflightRows().filter((r) => r.id.startsWith('N-'));
    assert.ok(rows.length >= 7, `only ${rows.length} pipeline rows — the section moved or shrank`);
    assert.deepEqual(rows.filter((r) => r.status !== 'PASS'), [],
      'the honest path is refused. Whatever else these mutants prove, a gate that cannot go green '
      + 'over the shipping tree blocks the release it exists to protect:\n'
      + rows.map((r) => `  ${r.id} ${r.status}: ${r.detail}`).join('\n'));
  });

  test('§5b · MUTANT · the notarytool submission is gone — N-SUBMIT dies', () => {
    const wf = mutate(sources().workflow, 'xcrun notarytool submit', 'true # submit');
    const rows = preflightRows({ workflow: wf });
    assert.equal(nRow(rows, 'N-SUBMIT').status, 'FAIL',
      'a release.yml with no notarytool submission passes. That is the state this file was written '
      + 'in: the bundler may still notarize the .app, and the DMG that ships is a DIFFERENT FILE, '
      + 'rewritten afterwards, with no ticket of its own.');
    assert.match(nRow(rows, 'N-SUBMIT').detail, /notarytool submit/);
  });

  test('§5c · MUTANT · notarization moved BEFORE the read-me injection — N-ORDER dies', () => {
    // ██ THE SUBTLE ONE ██ Every command is still present and every other row stays green. The
    // image is notarized, stapled, validated — and then `dmg-add-readme.sh` rewrites it and the
    // `mv` at line 123 drops the stapled copy in $TMPDIR. Order is the whole content of the fix.
    const wf = sources().workflow;
    const nStart = wf.indexOf('      # ── 9b.');
    const nEnd = wf.indexOf('      # ── 10. Gate:');
    const iStart = wf.indexOf('      # ── 8b.');
    assert.ok(nStart > 0 && nEnd > nStart && iStart > 0 && iStart < nStart,
      'the 8b / 9b / 10 section markers moved; this mutant slices on them');
    const step = wf.slice(nStart, nEnd);
    const moved = wf.slice(0, iStart) + step + wf.slice(iStart, nStart) + wf.slice(nEnd);
    const rows = preflightRows({ workflow: moved });
    assert.equal(nRow(rows, 'N-ORDER').status, 'FAIL',
      'notarizing before the step that rewrites the image is accepted. The published DMG would '
      + 'carry a valid signature, no ticket, and a workflow log full of green notarization output.');
    assert.equal(nRow(rows, 'N-SUBMIT').status, 'PASS',
      'the ordering mutant also killed N-SUBMIT, so this row is not measuring what it claims to');
  });

  test('§5d · MUTANT · the DMG staple is validated and swallowed by `|| true` — N-VALIDATE dies', () => {
    const wf = mutate(sources().workflow, 'if ! xcrun stapler validate "$DMG"', 'xcrun stapler validate "$DMG" || true #');
    const rows = preflightRows({ workflow: wf });
    assert.equal(nRow(rows, 'N-VALIDATE').status, 'FAIL',
      'the release continues after `stapler validate` says the ticket did not take. A validation '
      + 'whose result is discarded is a slower way of not checking.');
    assert.match(nRow(rows, 'N-VALIDATE').detail, /swallowed/);
  });

  test('§5e · MUTANT · only the DMG is validated, not the .app — N-VALIDATE dies', () => {
    const wf = mutate(sources().workflow, 'xcrun stapler validate "$APP"', 'true');
    const rows = preflightRows({ workflow: wf });
    assert.equal(nRow(rows, 'N-VALIDATE').status, 'FAIL',
      'validating the image alone is accepted. The .app is what she actually launches after the '
      + 'drag to Programme, and it carries its own ticket — stapled by the bundler, before the '
      + 'image existed. The two can disagree and only one of them was checked.');
    assert.match(nRow(rows, 'N-VALIDATE').detail, /the \.app/);
  });

  test('§5f · MUTANT · the hard Gatekeeper gate gets its `|| true` back — N-SPCTL-APP dies', () => {
    // Literally the diff this ticket reverses, applied one branch over.
    const wf = mutate(sources().workflow,
      'spctl --assess --type execute --verbose=4 "$INNER" > "$APP_OUT" 2>&1 || RC=$?',
      'spctl --assess --type execute --verbose=4 "$INNER" > "$APP_OUT" 2>&1 || true');
    const rows = preflightRows({ workflow: wf });
    assert.equal(nRow(rows, 'N-SPCTL-APP').status, 'FAIL',
      'a signed release whose Gatekeeper assessment cannot fail the build is accepted — which is '
      + 'exactly the state the tree was in before 2026-09-05, and the reason a notarization that '
      + 'silently failed would have shipped.');
    assert.match(nRow(rows, 'N-SPCTL-APP').detail, /0 hard/);
  });

  test('§5g · MUTANT · the ad-hoc branch is made hard too — N-SPCTL-APP dies', () => {
    // ██ THE INVERSION ██ `rejected` is the CORRECT answer without a Developer ID. A gate that
    // fails on it would mean no build at all on the fallback branch — the one that exists for the
    // day the certificate expires, which is a certainty rather than a risk. So this row refuses
    // over-correction in the same breath as it refuses the original defect.
    const src = sources().workflow;
    const adhoc = 'spctl --assess --type execute --verbose=4 "$INNER" 2>&1 | sed \'s/^/  /\' || true';
    assert.ok(mutate(src, adhoc, adhoc) === src && src.includes(adhoc),
      'the ad-hoc assessment line moved; this mutant edits it by exact text');
    const wf = mutate(src, adhoc, adhoc.replace(' || true', ''));
    const rows = preflightRows({ workflow: wf });
    assert.equal(nRow(rows, 'N-SPCTL-APP').status, 'FAIL',
      'making the unsigned branch fail on `rejected` is accepted. Every ad-hoc build would stop '
      + 'producing a DMG, and LZP-106 exists precisely because that DMG is still shippable.');
    assert.match(nRow(rows, 'N-SPCTL-APP').detail, /0 informational/);
  });

  test('§5h · MUTANT · the image itself is never assessed — N-SPCTL-DMG dies', () => {
    const wf = mutate(sources().workflow, 'spctl --assess --type open --context context:primary-signature', 'true #');
    const rows = preflightRows({ workflow: wf });
    assert.equal(nRow(rows, 'N-SPCTL-DMG').status, 'FAIL',
      'assessing only the .app is accepted. `--type open --context context:primary-signature` is '
      + 'what a downloaded file receives, and it is the ONLY assessment that sees the read-me '
      + 'injection: the app inside can be perfectly notarized while the image around it is not.');
    assert.equal(nRow(rows, 'N-SPCTL-APP').status, 'PASS',
      'the mutant also broke the app assessment, so this row is not isolating the DMG one');
  });

  test('§5i · MUTANT · `accepted` is taken at face value — N-NOTARIZED dies', () => {
    const wf = mutate(sources().workflow, "grep -q 'source=Notarized Developer ID'", 'true');
    const rows = preflightRows({ workflow: wf });
    assert.equal(nRow(rows, 'N-NOTARIZED').status, 'FAIL',
      'a bare `accepted` is accepted. AUDIT already measured why that is not enough: on the build '
      + 'machine an assessment can pass for reasons that do not travel — a locally trusted '
      + 'certificate, a Developer Tools exemption. `source=Notarized Developer ID` is the line the '
      + 'PO actually saw by hand, and the only one that means anything on a stranger\'s Mac.');
  });

  test('§5j · MUTANT · the DMG re-sign drops `--options runtime` — N-RUNTIME dies', () => {
    const rows = preflightRows({ dmgScript: mutate(sources().dmgScript, '--options runtime ', '') });
    assert.equal(nRow(rows, 'N-RUNTIME').status, 'FAIL',
      'the rewritten image is re-signed without the hardened runtime and without a secure '
      + 'timestamp. Apple issues no ticket for either, so the next step fails — loudly now, which '
      + 'is the point, but the flag is one word and the failure costs a 40-minute build.');
    assert.match(nRow(rows, 'N-RUNTIME').detail, /MISSING/);
  });

  // ── the two rows added by the integration pass, both from MEASUREMENT ───────────────────────
  //
  // ██ WHY THESE TWO EXIST AND THE EIGHT ABOVE DID NOT CATCH THEM ██
  // §5a-§5k all ask "is the command there, and is its verdict unswallowed?". Both defects below
  // answered YES to that and were still fatal, because the question they fail is "does the
  // command's PLUMBING carry its verdict?". They were found by running the shipped step text
  // against the real, really-notarized /Applications/LangzeitPlaner.app instead of a stub — a
  // stub `codesign` exits before its reader does and never raises SIGPIPE, which is precisely
  // why a stub harness reported twelve of twelve green over a step that could not ship.

  test('§5l · MUTANT · the runtime assertion goes back to `| grep -q` — N-SIGPIPE dies', () => {
    // The shipped defect, restored. `codesign -d --verbose=2` prints sixteen lines, the flags
    // line is the fourth, `grep -q` exits on the match and closes the pipe, codesign takes
    // SIGPIPE on the fifth: PIPESTATUS=(141 0). Under this step's `set -euo pipefail` the
    // pipeline is 141 and `if !` fires — so the gate hard-fails a CORRECTLY hardened bundle,
    // printing "carries no hardened-runtime flag" above a dump reading flags=0x10000(runtime).
    const src = sources();
    const wf = mutate(src.workflow,
      'codesign -d --verbose=2 "$APP" > "$SIGINFO" 2>&1 || true',
      'codesign -d --verbose=2 "$APP" 2>&1 | grep -q \'flags=.*runtime\' || true');
    assert.notEqual(wf, src.workflow, 'the mutation did not apply — the assertion was rewritten again');
    const rows = preflightRows({ workflow: wf });
    assert.equal(nRow(rows, 'N-SIGPIPE').status, 'FAIL',
      'a pipefail step may pipe an assertion into `grep -q`. That construction fails when it '
      + 'succeeds, and it would have stopped the first signed release with the opposite of the truth.');
    assert.match(nRow(rows, 'N-SIGPIPE').detail, /SIGPIPE|141/);
  });

  test('§5m · MUTANT · the notarization step drops pipefail — N-SIGPIPE dies', () => {
    // The other half. Without pipefail, `xcrun stapler validate "$DMG" | sed` reports SED's
    // status, so N-VALIDATE reads as satisfied over a staple that did not take.
    const wf = mutate(sources().workflow, 'set -euo pipefail', 'set -eu');
    const rows = preflightRows({ workflow: wf });
    assert.equal(nRow(rows, 'N-SIGPIPE').status, 'FAIL');
    assert.match(nRow(rows, 'N-SIGPIPE').detail, /pipefail/);
  });

  test('§5n · MUTANT · the staple runs bare again — N-STAPLE-LOUD dies', () => {
    // Measured, not imagined: `xcrun stapler staple` against a DMG Apple has no record of prints
    //   CloudKit query … failed due to "Record not found".
    //   The staple and validate action failed! Error 65.
    // and `bash -e` — GitHub's default shell for a `run:` block with no `shell:` key — ends the
    // step at 65 with no ::error. The likeliest real cause after an Accepted verdict is CDN
    // propagation lag, which is a RE-RUN and not a rebuild. Nobody re-runs a raw 65.
    const src = sources();
    const wf = src.workflow.split('\n').map((l) => (/^\s*#/.test(l) ? l : l))
      .join('\n')
      .replace(/ +if ! xcrun stapler staple "\$DMG" 2>&1 \| sed 's\/\^\/  \/'; then\n[\s\S]*?\n {10}fi\n/,
        '          xcrun stapler staple "$DMG"\n');
    assert.notEqual(wf, src.workflow, 'the mutation did not apply — the staple guard was rewritten');
    const rows = preflightRows({ workflow: wf });
    assert.equal(nRow(rows, 'N-STAPLE-LOUD').status, 'FAIL',
      'the staple may fail with no named error. N-STAPLE still passes — the command is there — '
      + 'which is exactly why this is a second row and not a clause of that one.');
    assert.equal(nRow(rows, 'N-STAPLE').status, 'PASS',
      'N-STAPLE should be unmoved: the staple is still present, it is only its failure that is mute');
  });

  test('§5o · MUTANT · the staple is guarded and then swallowed by `|| true` — N-STAPLE-LOUD dies', () => {
    const wf = mutate(sources().workflow,
      'if ! xcrun stapler staple "$DMG" 2>&1 | sed \'s/^/  /\'; then',
      'if ! xcrun stapler staple "$DMG" 2>&1 | sed \'s/^/  /\' || true; then');
    const rows = preflightRows({ workflow: wf });
    assert.equal(nRow(rows, 'N-STAPLE-LOUD').status, 'FAIL',
      'an `|| true` on the staple reads as guarded. The row must anchor on the staple line ITSELF: '
      + 'its first version used a 4-line `exit 1` window and passed the bare-staple mutant, because '
      + 'the very next command is `if ! xcrun stapler validate` and that gate\'s exit is two lines down.');
  });

  test('§5p · NEGATIVE CONTROL · a COMMENT naming `| grep -q` does not kill N-SIGPIPE', () => {
    // Without this, the fix could not explain itself: the corrected step quotes the defective
    // line verbatim in its inversion comment, and that comment must stay legal.
    const src = sources();
    const wf = src.workflow.replace(
      '          # ── submit the image that will actually ship ────────────────────────',
      '          # never write this: codesign -d --verbose=2 "$APP" 2>&1 | grep -q \'flags\'\n'
      + '          # ── submit the image that will actually ship ────────────────────────');
    assert.notEqual(wf, src.workflow, 'the mutation did not apply');
    const rows = preflightRows({ workflow: wf });
    assert.equal(nRow(rows, 'N-SIGPIPE').status, 'PASS',
      'the row reads comments. The corrected step QUOTES the defective line to explain itself, so '
      + 'a comment-blind row would forbid the file from documenting its own repair.');
  });

  test('§5k · MUTANT · the commands are deleted and every comment kept — every N row dies', () => {
    // ██ THE ROW THAT KEEPS THIS SECTION FROM BEING SATISFIED BY ITS OWN PROSE ██
    // This is not hypothetical: the first version of the pre-flight's §6 passed this mutant,
    // because release.yml quotes its old `spctl … || true` line verbatim in an inversion comment
    // and every `::error` message names the command it guards. A workflow of nothing but
    // comments describes a perfect notarization chain and performs none of it.
    const src = sources();
    const commentsOnly = src.workflow.split('\n').map((l) => (/^\s*#/.test(l) ? l : '')).join('\n');
    const rows = preflightRows({ workflow: commentsOnly, dmgScript: src.dmgScript }).filter((r) => r.id.startsWith('N-'));
    assert.ok(rows.length > 0, 'no pipeline rows came back at all');
    assert.deepEqual(rows.filter((r) => r.status === 'PASS'), [],
      'a workflow that only TALKS about notarizing satisfies these rows:\n'
      + rows.map((r) => `  ${r.id} ${r.status}: ${r.detail}`).join('\n'));
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 · THE TWO PLACEHOLDERS NOTHING REWRITES — main.swift, and the gate that never read it
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `release.yml:122-132` rewrites `tauri.conf.json`'s OWNER/REPO from `github.repository`. THE
// SWIFT SHELL IS NOT BUILT BY THAT WORKFLOW, so its two constants have to be right in the file:
//
//   UPDATE_MANIFEST_URL     substituted by hand on 2026-09-05 when the repo was made public
//   UPDATER_PUBLIC_KEY_B64  still ""
//
// `check-release-config.mjs` read NEITHER — it looked only at package.json, Cargo.toml and
// tauri.conf.json — which is the same shape of hole `shell-macos/build.sh:18` records for the
// version number. An empty key is the correct FAILURE MODE (no key, no installs: the shell
// refuses before it fetches) and a DEAD UPDATER: a Swift-shell copy installed from this build
// can never be fixed remotely, and nothing anywhere said so.
describe('§6 · the Swift shell\'s hand-substituted constants are gated', () => {
  test('§6a · ██ ASSERTED AS A FUNCTION, NOT AS A TREE STATE ██ empty key FAILS, real key PASSES', () => {
    // The F13 trap, one file over: pinning "SH-KEY is FAIL" would make `npm test` go red on the
    // day the PO generates the keypair and does the right thing. So both branches are driven
    // through the shipped predicate and this row is green in either state of the tree.
    // ── AND THIS ROW ITSELF ASSUMED A TREE STATE, which is the joke its own title makes ────────
    //
    // It built the "real key" variant by replacing the LITERAL `let UPDATER_PUBLIC_KEY_B64 = ""`.
    // On 2026-09-11 the PO generated the keypair and pasted the key in, the literal stopped
    // existing, the replace became a no-op, and the row died on its own guard — *"the empty-key
    // declaration moved; this row edits it by exact text"*. Exactly the F13 trap it was written to
    // avoid, rebuilt inside the row that avoids it: doing the right thing turned the suite red.
    //
    // Both variants are now derived from whatever the declaration currently says, so the row is
    // genuinely a function of the predicate and green before the key exists, after it exists, and
    // after it is rotated.
    const swift = sources().swift;
    const DECL = /let UPDATER_PUBLIC_KEY_B64 = "[^"]*"/;
    assert.match(swift, DECL, 'the UPDATER_PUBLIC_KEY_B64 declaration moved; SH-KEY reads it by this shape');
    const real = Buffer.alloc(32, 7).toString('base64');
    const withKey = swift.replace(DECL, `let UPDATER_PUBLIC_KEY_B64 = "${real}"`);

    const empty = nRow(preflightRows({ swift: swift.replace(DECL, 'let UPDATER_PUBLIC_KEY_B64 = ""') }), 'SH-KEY');
    assert.equal(empty.status, 'FAIL',
      'an empty UPDATER_PUBLIC_KEY_B64 passes the release pre-flight. The Swift shell then ships '
      + 'with an updater that refuses every download, and 22.3/22.5 are dead in it.');
    assert.equal(empty.strictOnly, true,
      'the empty key is a HARD failure on ordinary days too. It must block a release and not an '
      + 'afternoon: ci.yml:209 runs this pre-flight lenient on every push, and a one-time PO '
      + 'action that turns the whole suite red gets worked around rather than done.');

    const filled = nRow(preflightRows({ swift: withKey }), 'SH-KEY');
    assert.equal(filled.status, 'PASS',
      'a real 32-byte key is refused, so doing the work would turn this gate red — the F13 failure '
      + 'rebuilt one row over.');
  });

  test('§6b · a set-but-unusable key is refused, and the tree\'s own row agrees with the function', () => {
    const swift = sources().swift;
    // Same literal-vs-shape defect as §6a, and it was worse here: with the key filled in, the
    // replace was a no-op, `junk` became the REAL tree, and the row asserting "a junk key is
    // refused" would have been asserting the opposite of what it read.
    const junk = nRow(preflightRows({ swift: swift.replace(/let UPDATER_PUBLIC_KEY_B64 = "[^"]*"/, 'let UPDATER_PUBLIC_KEY_B64 = "not-a-key"') }), 'SH-KEY');
    assert.equal(junk.status, 'FAIL',
      'a non-empty string that is not a key passes. That is worse than the empty case: the updater '
      + 'would fetch, download, verify against nonsense and discard every release in silence.');
    assert.equal(junk.strictOnly, undefined,
      'a junk key is treated as the one-time-PO-action case and demoted to a note in lenient CI. '
      + 'Empty is "not done yet"; junk is a mistake, and it should be red every day.');

    // Consistency with the tree, both branches legal — the same shape as §3b2.
    const tree = nRow(preflightRows(), 'SH-KEY');
    const isEmpty = /is empty/.test(tree.detail);
    assert.equal(tree.status, isEmpty ? 'FAIL' : 'PASS',
      `SH-KEY says ${tree.status} while its own detail reads ${JSON.stringify(tree.detail.slice(0, 90))}`);
  });

  test('§6c · MUTANT · the manifest URL goes back to OWNER-PLACEHOLDER — SH-URL dies', () => {
    const swift = sources().swift.replace(
      /"https:\/\/github\.com\/[^"]*latest\.json"/,
      '"https://github.com/OWNER-PLACEHOLDER/langzeitplaner/releases/latest/download/latest.json"');
    const row = nRow(preflightRows({ swift }), 'SH-URL');
    assert.equal(row.status, 'FAIL',
      'the state this constant was in until 2026-09-05 passes the release pre-flight. Nothing '
      + 'rewrites it — the workflow only rewrites tauri.conf.json — so a Swift shell built '
      + 'from that tree checks for updates against a host that does not exist, for ever. '
      + '(The line break in this message is deliberate: suite-integrity scans every tier-1 file '
      + 'for `from \'…\'` to catch a test importing a double, and a sentence ending in the word '
      + '"from" at a line break reads as an import of a newline.)');
    assert.match(row.detail, /NOTHING REWRITES THIS ONE/);
  });

  test('§6d · MUTANT · either declaration is renamed — the row FAILS rather than reading "unset"', () => {
    // The §2h lesson: a gate that silently reads `null` as "fine" goes green the day somebody
    // renames a constant, and nobody finds out until an update is needed and does not arrive.
    const src = sources().swift;
    const noUrl = nRow(preflightRows({ swift: src.replace('let UPDATE_MANIFEST_URL', 'let UPDATE_MANIFEST_URL_V2') }), 'SH-URL');
    assert.equal(noUrl.status, 'FAIL', 'a missing UPDATE_MANIFEST_URL declaration reads as absent-and-fine');
    assert.match(noUrl.detail, /no longer declares/);
    const noKey = nRow(preflightRows({ swift: src.replace('let UPDATER_PUBLIC_KEY_B64', 'let UPDATER_KEY') }), 'SH-KEY');
    assert.equal(noKey.status, 'FAIL', 'a missing UPDATER_PUBLIC_KEY_B64 declaration reads as absent-and-fine');
    assert.equal(noKey.strictOnly, undefined,
      'a vanished declaration is demoted to a note in lenient CI, exactly like a key nobody has '
      + 'generated yet. The two are not the same thing: one is a task, the other is a broken gate.');
  });

  test('§6e · the two shells must poll ONE repository — SH-SLUG dies when they do not', () => {
    const mismatch = nRow(preflightRows({
      endpoints: ['https://github.com/someone-else/other/releases/latest/download/latest.json'],
    }), 'SH-SLUG');
    assert.equal(mismatch.status, 'FAIL',
      'the Swift shell and the Tauri updater may poll different repositories. One release would '
      + 'then update half the fleet and strand the other half, with nothing to see in either log.');

    const agree = nRow(preflightRows({
      endpoints: ['https://github.com/manuelhein2016-hash/langzeitplaner/releases/latest/download/latest.json'],
    }), 'SH-SLUG');
    assert.equal(agree.status, 'PASS',
      'the shipped pair of slugs is refused — this row would block the release it is meant to guard');

    // ── the unresolved endpoint, and the environment it is read in ────────────────────────────
    //
    // ██ CORRECTED 2026-09-05, integration pass. What stood here, verbatim: ██
    //
    //   > const unresolved = nRow(preflightRows({ endpoints: ['…/OWNER/REPO/…'] }), 'SH-SLUG');
    //   > assert.equal(unresolved.status, 'SKIP',
    //   >   'an unresolved endpoint is silently compared to nothing and reported as a pass');
    //
    // That INHERITED the environment, so it asserted a different thing on a laptop than on a
    // runner — and it went red on its first CI run, because `ci.yml` sets `GITHUB_REPOSITORY`
    // while leaving tauri.conf.json's OWNER/REPO placeholder in place. The row was right and the
    // test was wrong: with the endpoint unresolved the pre-flight falls back to that variable,
    // which is the whole point of the fallback, and PASS is the correct verdict there.
    //
    // The contract is three cases, and each one now NAMES the environment it means.
    const OURS = 'manuelhein2016-hash/langzeitplaner';
    const PLACEHOLDER = { endpoints: ['https://github.com/OWNER/REPO/releases/latest/download/latest.json'] };

    // (a) nothing to compare against at all — reported, never passed.
    assert.equal(nRow(preflightRows(PLACEHOLDER, { GITHUB_REPOSITORY: null }), 'SH-SLUG').status, 'SKIP',
      'with the endpoint unresolved AND no GITHUB_REPOSITORY there is nothing to compare the '
      + 'shell against, and a row that answers PASS there is answering about nothing');

    // (b) the runner's own repository is the fallback comparand — this is ordinary CI.
    assert.equal(nRow(preflightRows(PLACEHOLDER, { GITHUB_REPOSITORY: OURS }), 'SH-SLUG').status, 'PASS',
      'on a runner the placeholder endpoint falls back to GITHUB_REPOSITORY, and that is what '
      + 'release.yml will rewrite the endpoint to. Refusing here would fail every ordinary CI run.');

    // (c) and the fallback still DECIDES — it is a comparand, not a waiver.
    const wrongRunner = nRow(preflightRows(PLACEHOLDER, { GITHUB_REPOSITORY: 'someone-else/other' }), 'SH-SLUG');
    assert.equal(wrongRunner.status, 'FAIL',
      'a fork or a renamed repository builds a Tauri app pointing at ITSELF while the Swift shell '
      + 'still polls the original. That is the half-updated fleet this row exists for, and the '
      + 'placeholder branch must not be the way around it.');
    assert.match(wrongRunner.detail, /someone-else\/other/);
  });

  test('§6f · the pre-flight blocks a release on this, and does NOT block ordinary CI', () => {
    // Two exit codes, measured through the real CLI rather than the row list, because they are
    // what ci.yml:209 and release.yml step 4 actually consult.
    //
    // ██ THE ENVIRONMENT IS PINNED, ADDED 2026-09-05 ██ `SH-SLUG` falls back to
    // `GITHUB_REPOSITORY` when the Tauri endpoint still holds OWNER/REPO — which is the state of
    // the tree — so an inherited variable decides these two exit codes. Unpinned, this test asks
    // "does the pre-flight block CI *here*", and "here" is a laptop, our runner, or a fork,
    // depending on who is running it. This assertion is about THIS repository's pipeline, which
    // is what `ci.yml:209` and `release.yml` step 4 consult, so it says which repository it means.
    // A fork's disagreeing slug is a real finding and it has its own case, §6e(c).
    const CI_ENV = { ...process.env, GITHUB_REPOSITORY: 'manuelhein2016-hash/langzeitplaner' };
    const runCli = (extra) => {
      try {
        return { code: 0, out: execFileSync('node', [PREFLIGHT, ...extra], { cwd: ROOT, encoding: 'utf8', env: CI_ENV }) };
      } catch (e) {
        if (e.status === undefined) throw e;
        return { code: e.status, out: e.stdout || '' };
      }
    };
    const lenient = runCli([]);
    assert.equal(lenient.code, 0,
      'the lenient pre-flight fails, so ci.yml:209 is red on every push. A one-time PO action must '
      + 'not turn everyday CI red — that is how a gate gets commented out:\n' + lenient.out);

    const strictRun = runCli(['--strict']);
    const treeKeyIsEmpty = /is empty/.test(nRow(preflightRows(), 'SH-KEY').detail);
    if (treeKeyIsEmpty) {
      assert.equal(strictRun.code, 1,
        'UPDATER_PUBLIC_KEY_B64 is empty and the strict pre-flight still exits 0, so a tag would '
        + 'cut a release whose Swift shell can never be updated');
      assert.match(strictRun.out, /SH-KEY/,
        'the strict run fails without naming the row, so the releaser is told a release is blocked '
        + 'and not which one thing to do');
    } else {
      assert.ok(!/SH-KEY/.test(strictRun.out),
        'the key is real now and the strict pre-flight still reports SH-KEY as a problem');
    }
  });
});
