// Pre-flight for a release — `node .github/scripts/check-release-config.mjs [--tag vX.Y.Z] [--strict]`
//
// Everything here is checkable without Rust, without a network and without a
// GitHub account, so it runs both in CI (first job, fails in seconds) and on a
// laptop before anyone types `git tag`.
//
// It answers six questions:
//   1. Do the three version numbers agree, and do they agree with the tag?
//   2. Is the updater actually configured — real public key, real endpoint?
//   3. Does the app still have zero runtime npm dependencies?
//   4. Is the release-critical shape of tauri.conf.json intact?
//   5. Are the Swift shell's two HAND-substituted placeholders real? (added
//      2026-09-05 — nothing rewrites them and nothing read them, so a shell with
//      an empty updater key had a dead update path and no row said so)
//   6. Does the pipeline still ASSERT notarization? (added the same day: Tauri
//      notarizes, the read-me injection then rewrites the image, and until this
//      section existed nothing in the tree could tell a stapled DMG from an
//      unstapled one)
//
// --strict adds the checks that only make sense on a real release (a tag, a
// resolved endpoint). Without it the script is a lint you can run any day.
//
// Two extra modes exist for `tests/tier1/release-gate.test.js`, which may not
// touch the filesystem (suite-integrity bans node:fs in tier 1) and must kill
// the SHIPPED predicate rather than a copy of it:
//
//   --json                 print every §5/§6 row as JSON and exit 0
//   --simulate '<json>'    run those same rows over supplied sources instead of
//                          the tree — {workflow, dmgScript, swift, endpoints} —
//                          and exit 0. Any key left out falls back to the tree.
//   --dump                 print those four sources as JSON and exit 0, so a
//                          test that may not open a file can still mutate ONE
//                          LINE of the real workflow and feed it back through
//                          --simulate. A mutant built from a hand-written
//                          fragment would only ever prove that the fragment is
//                          wrong.
//
// Both exit 0 on purpose: they are reporting modes, and the rows are the
// evidence. Only the default text mode decides whether a release may proceed.

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const tagArg = args.includes('--tag') ? args[args.indexOf('--tag') + 1] : null;
const jsonMode = args.includes('--json');
const dumpMode = args.includes('--dump');
const simulateArg = args.includes('--simulate') ? args[args.indexOf('--simulate') + 1] : null;

const problems = [];
const notes = [];
const fail = (m) => problems.push(m);
const note = (m) => notes.push(m);

// ── inputs ───────────────────────────────────────────────────────────────────
const pkg = JSON.parse(read('package.json'));
const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
const cargo = read('src-tauri/Cargo.toml');

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// ── 1. version agreement ─────────────────────────────────────────────────────
// package.json is the single source of truth. tauri.conf.json is expected to
// point at it rather than restate it, because a restated number is a number
// that will one day disagree.
const version = pkg.version;
if (!SEMVER.test(version)) fail(`package.json version "${version}" is not semver`);

if (conf.version !== '../package.json') {
  fail(
    `src-tauri/tauri.conf.json "version" is "${conf.version}"; it must be the literal ` +
      '"../package.json" so the bundle can never disagree with package.json',
  );
}

const cargoVersion = (cargo.match(/^\s*version\s*=\s*"([^"]+)"/m) || [])[1];
if (!cargoVersion) fail('could not read version from src-tauri/Cargo.toml');
else if (cargoVersion !== version) {
  fail(`src-tauri/Cargo.toml version ${cargoVersion} != package.json version ${version}`);
}

if (tagArg) {
  const tagVersion = tagArg.replace(/^v/, '');
  if (tagVersion !== version) {
    fail(
      `tag ${tagArg} does not match package.json version ${version}. ` +
        'Bump package.json and Cargo.toml first, commit, then tag that commit.',
    );
  }
}

// ── 2. the updater must be real ──────────────────────────────────────────────
// Story 22.6: an email-distributed app must not grow a hijackable update path.
// The two ways that goes wrong silently are a placeholder key and an endpoint
// pointing at somewhere that is not this repository.
const updater = (conf.plugins && conf.plugins.updater) || null;
if (!updater) {
  fail('src-tauri/tauri.conf.json has no plugins.updater block — story 22.3/22.6 has no vehicle');
} else {
  const pub = String(updater.pubkey || '');
  if (!pub || /REPLACE|PLACEHOLDER|CHANGEME/i.test(pub)) {
    // A note on ordinary days, a hard failure on a release. The key is a
    // one-time PO action (docs/v2/RELEASE.md § "The updater key"); until it
    // happens, everyday CI should stay green and no release may go out.
    const msg =
      'plugins.updater.pubkey is still a placeholder. Run `cargo tauri signer generate` ' +
      '(see docs/v2/RELEASE.md § "The updater key") and paste the PUBLIC half here. ' +
      'The private half becomes the TAURI_SIGNING_PRIVATE_KEY secret and is never committed.';
    if (strict) fail(msg);
    else note(`${msg} — releases are blocked until then.`);
  } else {
    // A valid Tauri pubkey is base64 of a minisign public key file.
    try {
      const decoded = Buffer.from(pub, 'base64').toString('utf8');
      if (!decoded.includes('untrusted comment:')) {
        fail('plugins.updater.pubkey does not decode to a minisign public key file');
      }
    } catch {
      fail('plugins.updater.pubkey is not valid base64');
    }
    if (/[A-Za-z0-9+/=]{40,}/.test(pub) === false) fail('plugins.updater.pubkey looks too short to be a real key');
  }

  const endpoints = updater.endpoints || [];
  if (endpoints.length === 0) fail('plugins.updater.endpoints is empty');
  for (const e of endpoints) {
    if (!/^https:\/\//.test(e)) fail(`updater endpoint "${e}" is not https — an update path must not be downgradable`);
    if (strict && /\b(OWNER|REPO)\b/.test(e)) {
      fail(
        `updater endpoint "${e}" still contains the OWNER/REPO placeholder. ` +
          'The release workflow rewrites it from github.repository; if you see this, that step did not run.',
      );
    }
  }
  if (!strict && endpoints.some((e) => /\b(OWNER|REPO)\b/.test(e))) {
    note('updater endpoint still holds the OWNER/REPO placeholder — the release workflow fills it in.');
  }
}

// ── 3. zero runtime npm dependencies ─────────────────────────────────────────
// A standing project value (PLAN.md Gate 5+), not an accident. Checked at
// release time because this is the last moment it is cheap to fix.
const runtimeDeps = Object.keys(pkg.dependencies || {});
if (runtimeDeps.length > 0) {
  fail(`package.json gained runtime dependencies: ${runtimeDeps.join(', ')}. This needs PO sign-off (PLAN.md §7).`);
}

// ── 4. release-critical config shape ─────────────────────────────────────────
const bundle = conf.bundle || {};
if (bundle.active !== true) fail('bundle.active is not true — nothing would be produced');
if (!Array.isArray(bundle.targets) || !bundle.targets.includes('dmg')) {
  fail('bundle.targets must include "dmg" — story 22.1 ships a DMG');
}
if (bundle.createUpdaterArtifacts !== true) {
  fail('bundle.createUpdaterArtifacts must be true, or no update artifacts are produced (22.3)');
}
const minSystem = (bundle.macOS || {}).minimumSystemVersion;
if (!minSystem) fail('bundle.macOS.minimumSystemVersion is unset');

// The web payload must be an assembled directory, never the repository root.
// "../" here means the bundle carries .git, tests/, docs/ and src-tauri/target
// onto the user's Mac — several times the story-22.1 size budget, and the
// project's whole history on a family member's laptop.
const build = conf.build || {};
if (build.frontendDist !== '../dist') {
  fail(
    `build.frontendDist is "${build.frontendDist}"; it must be "../dist", the allowlisted payload ` +
      'assembled by scripts/build-frontend.mjs. Pointing it at the repository root ships the repository.',
  );
}
if (!/build-frontend\.mjs/.test(String(build.beforeBuildCommand || ''))) {
  fail('build.beforeBuildCommand does not run scripts/build-frontend.mjs, so ../dist would be stale or missing');
}

// ── THE PAGE MUST BE ABLE TO REACH THE SHELL — measured the hard way, 2026-09-11 ─────────────
//
// `app.withGlobalTauri` defaults to FALSE in Tauri v2, and it was absent. So `window.__TAURI__`
// did not exist in the page, and every `window.__TAURI__?.core?.invoke` in the product silently
// evaluated to `undefined`. Nothing failed loudly. The crate compiled, all six suites passed, the
// universal bundle built, the DMG notarized, and the app LAUNCHED — and it was a browser tab with
// no shell underneath it:
//
//   · `chooseTransport` found no `invoke`, fell back to `fetch`, and `connect-src 'self'` blocked
//     it — surfacing to the user as "net: the request did not complete (TypeError)" when he tried
//     to create a Familienkreis;
//   · worse and quieter, `storage.js` could not reach `save_board` either, so the app ran on
//     localStorage and never opened ~/Library/Application Support/LangzeitPlaner at all. Installed
//     over a real board, it would have shown an EMPTY one — looking exactly like data loss while
//     the file sat untouched beside it.
//
// The Swift shell hid this for the whole project: `main.swift` installs its own `__TAURI__` shim,
// so every measurement ever taken on that shell had a working bridge. Tier 2 runs on the Swift
// shell too. There was no test anywhere that could have caught it, because the defect is in the
// one file no suite executes and the one runtime nobody had run.
//
// This row is cheap and it is the only thing standing between here and that happening again.
const appCfg = conf.app || {};
const readsGlobal = (() => {
  try {
    return readdirSync(resolve(ROOT, "src/js"), { recursive: true })
      .filter((f) => String(f).endsWith('.js'))
      .some((f) => /window\.__TAURI__/.test(readFileSync(resolve(ROOT, "src/js", String(f)), "utf8")));
  } catch { return true; }
})();
if (readsGlobal && appCfg.withGlobalTauri !== true) {
  fail(
    'src/js reads `window.__TAURI__`, but app.withGlobalTauri is not true in tauri.conf.json. '
      + 'Tauri v2 defaults it to false, so the global would not exist: every invoke() resolves to '
      + 'undefined, the network transport falls back to fetch and is refused by CSP, and — silently '
      + '— storage falls back to localStorage so the app never reads the user\'s real board. It '
      + 'launches and looks fine. Nothing else in this repository can catch this: the Swift shell '
      + 'installs its own __TAURI__ shim, so every suite passes either way.',
  );
}

// D1: signing is off, and the way it is off must stay "no identity in the file".
// If an identity ever appears here, turning signing on stops being a variable
// flip and starts being a code change — which is exactly what D1 forbids.
if ((bundle.macOS || {}).signingIdentity) {
  fail(
    'bundle.macOS.signingIdentity is set in the config. Signing identity belongs in the ' +
      'APPLE_SIGNING_IDENTITY environment variable so that enabling signing (D1, reversible) ' +
      'needs no file change.',
  );
}

const csp = ((conf.app || {}).security || {}).csp;
if (!csp) fail('app.security.csp is unset — story 13.4/21.5 requires a CSP');
else if (/script-src/.test(csp) && /'unsafe-inline'/.test(csp.match(/script-src[^;]*/)[0])) {
  fail("app.security.csp allows inline scripts — story 21.5 forbids it");
}

// ═════════════════════════════════════════════════════════════════════════════
// ROWS — §5 and §6, as functions over source text
// ═════════════════════════════════════════════════════════════════════════════
//
// Written as pure functions of strings, not of the tree, for one reason: the
// mutants in tests/tier1/release-gate.test.js §5/§6 must be able to hand this
// file a workflow with one line changed and watch the named row die. A predicate
// that can only read the real files can only ever assert that today is fine.
//
// Status vocabulary: PASS · FAIL · SKIP. SKIP is for a row that genuinely cannot
// be decided here (one case, and it is named). It reports as a note; it never
// blocks and it never passes silently.

const PASS = (id, detail, extra = {}) => ({ id, status: 'PASS', detail, ...extra });
const FAIL = (id, detail, extra = {}) => ({ id, status: 'FAIL', detail, ...extra });
const SKIP = (id, detail) => ({ id, status: 'SKIP', detail });

/** A line of shell, without the `|| true` question begged. */
const swallowed = (line) => /\|\|\s*true\b/.test(line);

/**
 * A comment line — YAML `#` or shell `#`, which are the same character at the
 * same place inside a `run: |` block.
 *
 * ██ THIS EXISTS BECAUSE THE FIRST VERSION OF THIS SECTION WAS SATISFIED BY ITS
 * OWN PROSE. ██ The inverted comment in release.yml quotes the old
 * `spctl … || true` line verbatim, and the step's header comment names
 * `--type open --context context:primary-signature` while explaining it — so
 * N-SPCTL-APP reported "2 hard, 2 informational" over a step that runs two
 * commands, and N-SPCTL-DMG anchored on a comment. Measured, not feared: the
 * counts were wrong on the first run of this file. A gate a comment can satisfy
 * is a gate that survives having its command deleted.
 */
const isComment = (l) => /^\s*#/.test(l);

/** Only the lines that DO something. */
const codeLines = (text) => text.split('\n').filter((l) => !isComment(l));

/**
 * ...and of those, only the ones that RUN something.
 *
 * ██ THE SECOND WAY THIS SECTION WAS SATISFIED BY ITS OWN PROSE. ██ Every gate
 * below carries a `::error` message that names the command it just ran — good
 * messages, and they are `echo` lines containing the exact strings these rows
 * search for. Measured on the first mutant run: deleting the DMG's
 * `spctl --assess --type open` INVOCATION left N-SPCTL-DMG green, because it
 * anchored on the echo that explains the failure. Deleting both
 * `grep -q 'source=Notarized Developer ID'` lines left N-NOTARIZED green for the
 * same reason. An `echo` is not an assessment.
 */
const commandLines = (text) => codeLines(text).filter((l) => !/^\s*echo\b/.test(l));
const codeOf = (text) => commandLines(text).join('\n');

/** Command lines of `text`, and the first index whose content matches `re`. */
function lineWith(text, re) {
  const lines = commandLines(text);
  const at = lines.findIndex((l) => re.test(l));
  return { lines, at, line: at < 0 ? null : lines[at] };
}

/** Does a hard failure follow within `window` lines? `exit 1` is the only one that counts. */
function failsHardAfter(lines, at, window = 10) {
  return lines.slice(at, at + window).some((l) => /\bexit 1\b/.test(l));
}

/**
 * The workflow's steps, in file order, as {name, text, index}.
 *
 * Split on a `- name:`/`- uses:` at exactly six spaces of indentation, which is
 * the step level in this file. A `- name:` inside a `run: |` block is indented
 * further and is therefore not a step boundary — checked against the real file,
 * which contains several.
 */
function workflowSteps(wf) {
  const starts = [];
  const re = /\n {6}- (?=name:|uses:)/g;
  let m;
  while ((m = re.exec(wf)) !== null) starts.push(m.index + 1);
  return starts.map((s, i) => {
    const text = wf.slice(s, i + 1 < starts.length ? starts[i + 1] : wf.length);
    const named = text.match(/^ {6}- name: (.*)$/m) || text.match(/^ {6}- uses: (.*)$/m);
    return { name: (named ? named[1] : '(unnamed)').trim(), text, index: s, order: i };
  });
}

const stepWith = (steps, re) => steps.find((s) => re.test(codeOf(s.text))) || null;

// ── §5 · the two placeholders in shell-macos/main.swift ──────────────────────
//
// `release.yml:122-132` rewrites tauri.conf.json's OWNER/REPO from
// github.repository at build time. THE SWIFT SHELL IS NOT BUILT BY THAT
// WORKFLOW, so both of its constants have to be correct in the file, by hand,
// and until 2026-09-05 this script read neither: it looked only at package.json
// and Cargo.toml. A Swift shell with `UPDATER_PUBLIC_KEY_B64 = ""` has a dead
// updater — `checkForUpdate` refuses before it fetches — and every gate in the
// project was green over it.
function shellRows(swift, endpoints) {
  const rows = [];

  const urlDecl = swift.match(/let UPDATE_MANIFEST_URL\s*=\s*"([^"]*)"/);
  if (!urlDecl) {
    rows.push(FAIL('SH-URL',
      'shell-macos/main.swift no longer declares `let UPDATE_MANIFEST_URL = "…"`. This row reads it '
      + 'by that shape, and a gate that cannot find the value it guards is not a gate.'));
  } else {
    const url = urlDecl[1];
    let parsed = null;
    try { parsed = new URL(url); } catch { /* reported below */ }
    if (!url) {
      rows.push(FAIL('SH-URL',
        'UPDATE_MANIFEST_URL is empty. The Swift shell never fetches a manifest, so 22.3/22.5 are '
        + 'dead in it and no installed copy is ever offered a fix.'));
    } else if (/OWNER-PLACEHOLDER|OWNER\/REPO/.test(url)) {
      rows.push(FAIL('SH-URL',
        `UPDATE_MANIFEST_URL still carries a placeholder (${url}). NOTHING REWRITES THIS ONE — `
        + 'release.yml only rewrites tauri.conf.json. The shell would refuse every update check.'));
    } else if (!parsed || parsed.protocol !== 'https:') {
      rows.push(FAIL('SH-URL', `UPDATE_MANIFEST_URL "${url}" is not an https URL — an update path must not be downgradable.`));
    } else if (!/\/releases\/latest\/download\/latest\.json$/.test(parsed.pathname)) {
      rows.push(FAIL('SH-URL',
        `UPDATE_MANIFEST_URL path is "${parsed.pathname}"; it must end in /releases/latest/download/latest.json, `
        + 'the only URL that resolves to the newest NON-prerelease asset. A path that names a tag pins the '
        + 'fleet to that tag for ever.'));
    } else {
      rows.push(PASS('SH-URL', `UPDATE_MANIFEST_URL resolves: ${url}`));
    }
  }

  const keyDecl = swift.match(/let UPDATER_PUBLIC_KEY_B64\s*=\s*"([^"]*)"/);
  if (!keyDecl) {
    rows.push(FAIL('SH-KEY',
      'shell-macos/main.swift no longer declares `let UPDATER_PUBLIC_KEY_B64 = "…"`. Same reason as '
      + 'SH-URL: a missing declaration must be a failure and not read as "unset, fine".'));
  } else {
    const key = keyDecl[1].trim();
    if (!key) {
      // strictOnly, exactly like plugins.updater.pubkey above and for the same reason: it is a
      // one-time PO action, everyday CI stays green, and NO RELEASE MAY GO OUT until it is done.
      rows.push(FAIL('SH-KEY',
        'UPDATER_PUBLIC_KEY_B64 is empty. The Swift shell refuses to download any update at all — the '
        + 'correct failure mode, and a DEAD UPDATER: a copy installed from this build can never be fixed '
        + 'remotely. Paste the base64 of the 32-byte Ed25519 public key (a minisign .pub line is also '
        + 'accepted) — the same keypair as plugins.updater.pubkey, generated by `cargo tauri signer generate`.',
        { strictOnly: true }));
    } else {
      let bytes = null;
      let text = '';
      let buf = null;
      try {
        buf = Buffer.from(key, 'base64');
        bytes = buf.length;
        text = buf.toString('utf8');
      } catch { /* handled below */ }
      // ── THIS ROW MUST MIRROR `parseUpdaterPublicKey`, NOT ITS OWN IDEA OF A KEY ───────────────
      //
      // It used to accept exactly two shapes: a whole `.pub` FILE (base64 whose plaintext carries
      // `untrusted comment:`), or a bare 32-byte raw key. It rejected the THIRD shape the shell
      // actually accepts — a single minisign `.pub` LINE, which decodes to 42 bytes: 2-byte
      // algorithm (`Ed`) + 8-byte key id + the 32-byte key.
      //
      // That is the shape `cargo tauri signer generate` puts on your screen, so the first real key
      // anyone pasted failed this gate, with a message stating the opposite of the truth: "neither
      // a 32-byte Ed25519 key nor a minisign public key file". Measured 2026-09-11 on the PO's own
      // keypair. The row's own remediation text three lines above already said "a minisign .pub
      // line is also accepted" — the prose was right and the code was wrong.
      //
      // Note the whole-FILE form is accepted here but would NOT work in the shell: the parser
      // splits the raw string on newlines and base64-decodes each line, so a file-blob arrives as
      // one 152-byte candidate and matches neither 32 nor 42. Kept as a pass because it is the
      // Tauri-side spelling and a paste-swap between the two fields is a real mistake worth
      // catching downstream rather than here — SH-PAIR below is what compares the two.
      const isMinisignLine = bytes === 42 && buf && buf.subarray(0, 2).toString('latin1') === 'Ed';
      if (text.includes('untrusted comment:')) {
        rows.push(PASS('SH-KEY', 'UPDATER_PUBLIC_KEY_B64 decodes to a minisign public key file.'));
      } else if (isMinisignLine) {
        rows.push(PASS('SH-KEY',
          'UPDATER_PUBLIC_KEY_B64 decodes to 42 bytes beginning `Ed` — a minisign public key line, '
          + 'the shape `parseUpdaterPublicKey` (main.swift:353-356) reads as algorithm + key id + key.'));
      } else if (bytes === 32) {
        rows.push(PASS('SH-KEY', 'UPDATER_PUBLIC_KEY_B64 decodes to 32 bytes — a raw Ed25519 public key.'));
      } else {
        rows.push(FAIL('SH-KEY',
          `UPDATER_PUBLIC_KEY_B64 is set but decodes to ${bytes === null ? 'nothing readable' : `${bytes} bytes`}, `
          + 'which is none of the three shapes main.swift:342 accepts: a 32-byte raw Ed25519 key, a '
          + '42-byte minisign line beginning `Ed`, or a whole minisign .pub file. Every signature check '
          + 'against it fails, so the updater downloads and then discards each release — silently, for ever.'));
      }
    }
  }

  // The two shells must poll the SAME repository. Only decidable once the Tauri endpoint is
  // resolved, which happens in release.yml step 3; before that there is nothing to compare, and
  // this row says so rather than passing.
  const slugOf = (u) => {
    try { return (new URL(u).pathname.match(/^\/([^/]+)\/([^/]+)\//) || []).slice(1, 3).join('/') || null; }
    catch { return null; }
  };
  const shellSlug = urlDecl ? slugOf(urlDecl[1]) : null;
  const resolved = (endpoints || []).filter((e) => !/\b(OWNER|REPO)\b/.test(e));
  const envSlug = process.env.GITHUB_REPOSITORY || null;
  const other = resolved.length ? slugOf(resolved[0]) : envSlug;
  if (!shellSlug) {
    rows.push(SKIP('SH-SLUG', 'the shell manifest URL has no owner/repo path — SH-URL is the row that says so.'));
  } else if (!other) {
    rows.push(SKIP('SH-SLUG',
      `the shell polls ${shellSlug}; tauri.conf.json still holds the OWNER/REPO placeholder and `
      + 'GITHUB_REPOSITORY is unset, so there is nothing to compare it against here. In CI the '
      + 'endpoint is rewritten first and this row decides.'));
  } else if (shellSlug.toLowerCase() !== other.toLowerCase()) {
    rows.push(FAIL('SH-SLUG',
      `the Swift shell polls ${shellSlug} and the Tauri updater polls ${other}. One contract, two `
      + 'implementations (net.js §6): a release published to one repository would update half the '
      + 'fleet and strand the other half, with nothing to see in either log.'));
  } else {
    rows.push(PASS('SH-SLUG', `both shells poll ${shellSlug}.`));
  }

  return rows;
}

// ── §6 · the notarization chain, as rows over release.yml ────────────────────
//
// ██ WHY THIS SECTION EXISTS ██  Tauri's bundler DOES set the hardened runtime
// and DOES call notarytool when APPLE_API_* are present. That was never the
// problem. The problem was that nothing asserted it worked — the only Gatekeeper
// check ended in `|| true` — while `dmg-add-readme.sh` rewrites the image after
// the bundler built it and re-signs it. `codesign --force --sign` puts a
// signature back; it cannot put a staple back. The failure mode is a green
// pipeline publishing a DMG that presents to a non-technical family member
// exactly as the unsigned build did.
function pipelineRows(workflow, dmgScript) {
  const rows = [];
  const steps = workflowSteps(workflow);

  // Every `stepWith` below matches on CODE, never on a comment — see isComment.
  const notarize = stepWith(steps, /xcrun notarytool submit/);
  const inject = stepWith(steps, /dmg-add-readme\.sh/);
  const mount = stepWith(steps, /hdiutil attach/);

  // N-SUBMIT — the submission exists, waits, and only runs on the signed branch.
  if (!notarize) {
    rows.push(FAIL('N-SUBMIT',
      'no step in release.yml runs `xcrun notarytool submit`. The bundler may still notarize the .app, '
      + 'but the DMG that ships is REWRITTEN afterwards by dmg-add-readme.sh and would go out with no '
      + 'ticket of its own — indistinguishable, on the recipient\'s Mac, from the unsigned build.'));
  } else if (!/--wait\b/.test(codeOf(notarize.text))) {
    rows.push(FAIL('N-SUBMIT',
      `"${notarize.name}" submits to notarytool without --wait, so the build continues while Apple is still `
      + 'deciding. The staple two lines later then has nothing to fetch, and the failure is a race rather '
      + 'than a verdict.'));
  } else if (!/if:\s*vars\.ENABLE_APPLE_SIGNING == 'true'/.test(codeOf(notarize.text))) {
    rows.push(FAIL('N-SUBMIT',
      `"${notarize.name}" is not gated on vars.ENABLE_APPLE_SIGNING == 'true'. Every ad-hoc build would `
      + 'then fail at notarytool, and the fallback branch that exists for the day the certificate expires '
      + 'would stop producing anything at all.'));
  } else {
    rows.push(PASS('N-SUBMIT', `"${notarize.name}" submits the DMG with --wait, on the signed branch only.`));
  }

  // N-ORDER — after the rewrite, before every gate that inspects the image.
  if (!notarize || !inject || !mount) {
    rows.push(FAIL('N-ORDER',
      'one of the three steps this ordering is about is missing: the read-me injection '
      + `(${inject ? 'present' : 'MISSING'}), the notarization (${notarize ? 'present' : 'MISSING'}), `
      + `the mount gate (${mount ? 'present' : 'MISSING'}).`));
  } else if (!(inject.order < notarize.order && notarize.order < mount.order)) {
    rows.push(FAIL('N-ORDER',
      `the order is injection #${inject.order}, notarization #${notarize.order}, mount gate #${mount.order}. `
      + 'It must be injection → notarization → gates. Notarizing BEFORE the injection staples an image that '
      + 'the `mv` at dmg-add-readme.sh:123 then throws away; notarizing AFTER the gates means every gate, '
      + 'the size budget and the checksum measured a different file from the one that is published.'));
  } else {
    rows.push(PASS('N-ORDER', `injection #${inject.order} → notarization #${notarize.order} → gates #${mount.order}.`));
  }

  // N-STAPLE — the ticket goes ON the file, so a first launch works offline.
  if (notarize && /xcrun stapler staple/.test(codeOf(notarize.text))) {
    rows.push(PASS('N-STAPLE', 'the notarized DMG is stapled.'));
  } else {
    rows.push(FAIL('N-STAPLE',
      'nothing runs `xcrun stapler staple` on the DMG. Notarization without a staple works only while '
      + 'Gatekeeper can reach Apple: the first person to open it on a captive-portal wifi meets the same '
      + 'wall the ticket was bought to remove.'));
  }

  // N-STAPLE-LOUD — and the staple's own failure is NAMED.
  //
  // ██ ADDED 2026-09-05, integration pass, by measurement. ██ `xcrun stapler
  // staple "$DMG"` shipped as the one bare command in a step where every other
  // failure carries an ::error. Run for real against a DMG Apple has no record
  // of, it prints `CloudKit query … "Record not found"` and exits 65; `set -e`
  // then ends the step with GitHub showing only "Process completed with exit
  // code 65". That is the difference between a release that says "re-run in
  // five minutes, the ticket has not propagated" and one that says nothing.
  //
  // The predicate anchors on the STAPLE LINE ITSELF, not on a nearby `exit 1`.
  // Measured: the first version used `failsHardAfter(lines, at, 4)`, and mutant
  // M-C — making the staple bare again, the exact defect — left the row GREEN,
  // because the very next command is `if ! xcrun stapler validate …` and its
  // `exit 1` is two lines below. A row that reads the next gate's guard is not
  // reading this one's.
  if (!notarize) {
    rows.push(FAIL('N-STAPLE-LOUD', 'no notarization step, so there is no staple whose failure could be named.'));
  } else {
    const { lines, at } = lineWith(notarize.text, /xcrun stapler staple/);
    const stapleLine = at < 0 ? '' : lines[at];
    const guarded = /^\s*if\s+!/.test(stapleLine) && !swallowed(stapleLine) && failsHardAfter(lines, at, 3);
    if (at < 0) {
      rows.push(FAIL('N-STAPLE-LOUD', 'nothing staples the DMG — see N-STAPLE.'));
    } else if (!guarded) {
      rows.push(FAIL('N-STAPLE-LOUD',
        '`xcrun stapler staple` is not guarded by an `if !` with its own `exit 1`. It still stops the step, because '
        + 'GitHub runs `run:` blocks under `bash -e` — but it stops them with a raw exit 65 and no ::error, '
        + 'so the log says "Process completed with exit code 65" and the actual cause is four lines up in a '
        + 'collapsed section. Apple\'s own most likely failure here is CDN propagation lag AFTER an Accepted '
        + 'verdict, which is a re-run and not a rebuild; nobody can act on that unless the step says so.'));
    } else {
      rows.push(PASS('N-STAPLE-LOUD', 'a failed staple exits 1 under a named ::error, not a bare 65.'));
    }
  }

  // N-SIGPIPE — no assertion in the notarization step reads a command through
  // `| grep -q`, because under `pipefail` that construction FAILS ON SUCCESS.
  //
  // ██ ADDED 2026-09-05, integration pass, by measurement. ██ The step shipped
  // with `if ! codesign -d --verbose=2 "$APP" 2>&1 | grep -q 'flags=.*runtime'`.
  // Measured against the real notarized /Applications/LangzeitPlaner.app:
  // codesign prints sixteen lines, the flags line is the fourth, `grep -q` exits
  // the instant it matches and closes the read end, and codesign takes SIGPIPE
  // on the fifth —
  //
  //     pipeline rc=141   PIPESTATUS=(141 0)
  //
  // The step runs `set -euo pipefail`, so the pipeline's status is 141 and the
  // `if !` fires. This gate would have hard-failed the FIRST signed release,
  // printing "carries no hardened-runtime flag" directly above a dump reading
  // `flags=0x10000(runtime)`. It passed review because a stubbed `codesign`
  // writes little and exits before the reader does, and never raises SIGPIPE:
  // the defect is invisible to any harness that does not use the real tool.
  //
  // The rule is narrow on purpose — `| grep -q` inside a pipefail step, in an
  // assertion. `| sed`, `| grep` without -q and `| grep -c` all drain the pipe
  // and are unaffected; a `grep -q` on a FILE has no pipe at all and is the fix.
  if (notarize) {
    const pipefail = /set -[a-z]*o pipefail|set -euo pipefail/.test(codeOf(notarize.text));
    const offenders = commandLines(notarize.text).filter((l) => /\|\s*grep\s+(-[a-zA-Z]*q|--quiet)/.test(l));
    if (pipefail && offenders.length) {
      rows.push(FAIL('N-SIGPIPE',
        `"${notarize.name}" runs under pipefail and pipes a command into \`grep -q\` (${offenders.length} `
        + `line(s), first: \`${offenders[0].trim().slice(0, 90)}\`). \`grep -q\` exits at the first match and `
        + 'closes the pipe; a writer with more to say then takes SIGPIPE and the pipeline reports 141, so the '
        + 'assertion FAILS EXACTLY WHEN IT SHOULD PASS. Redirect the command to a file and grep the file — '
        + 'which is what step 10 already does with spctl, for this reason.'));
    } else if (!pipefail) {
      rows.push(FAIL('N-SIGPIPE',
        `"${notarize.name}" does not set pipefail. Every \`cmd | sed\` assertion in it then reports sed's `
        + 'exit status, so `stapler validate` failing is invisible — N-VALIDATE reads as satisfied and is not.'));
    } else {
      rows.push(PASS('N-SIGPIPE', 'pipefail is on and no assertion reads a command through `grep -q`.'));
    }
  } else {
    // Never silently omit the row: a section of comments must produce a FAIL
    // here like every other N row, or §5k reads "no PASS" as satisfaction.
    rows.push(FAIL('N-SIGPIPE', 'no notarization step, so there is no assertion whose plumbing could be checked.'));
  }

  // N-VALIDATE — both artifacts, and a hard failure on either.
  const validateRows = [];
  for (const [label, target] of [['the DMG', '"$DMG"'], ['the .app', '"$APP"']]) {
    if (!notarize) { validateRows.push(`${label}: no notarization step at all`); continue; }
    const { lines, at, line } = lineWith(notarize.text, new RegExp(`stapler validate ${target.replace('$', '\\$')}`));
    if (at < 0) validateRows.push(`${label}: no \`stapler validate ${target}\``);
    else if (swallowed(line)) validateRows.push(`${label}: validated, then swallowed by \`|| true\``);
    else if (!failsHardAfter(lines, at)) validateRows.push(`${label}: validated with no \`exit 1\` on failure`);
  }
  if (validateRows.length) {
    rows.push(FAIL('N-VALIDATE',
      `the staple is not proved on both artifacts — ${validateRows.join('; ')}. A ticket that did not take is `
      + 'exactly the state this whole section exists to make visible, and it is invisible unless both are '
      + 'validated and either failure stops the release.'));
  } else {
    rows.push(PASS('N-VALIDATE', 'stapler validate runs on the DMG and the .app, and either failure is fatal.'));
  }

  // N-RUNTIME — the hardened runtime, which notarization refuses to issue a ticket without.
  const assertsRuntime = notarize && /flags=.*runtime/.test(codeOf(notarize.text)) && /exit 1/.test(codeOf(notarize.text));
  const signLine = lineWith(dmgScript, /codesign --force/).line || '';
  const dmgHardened = /--options runtime/.test(signLine) && /--timestamp/.test(signLine);
  if (assertsRuntime && dmgHardened) {
    rows.push(PASS('N-RUNTIME', 'the .app\'s runtime flag is asserted, and the DMG re-sign carries --options runtime --timestamp.'));
  } else {
    rows.push(FAIL('N-RUNTIME',
      `the hardened runtime is not held: release.yml ${assertsRuntime ? 'asserts it' : 'does NOT assert it on the .app'}, `
      + `dmg-add-readme.sh's re-sign ${dmgHardened ? 'carries' : 'is MISSING'} --options runtime --timestamp. `
      + 'Apple will not notarize a submission without a secure timestamp, and will not issue a ticket for a '
      + 'bundle with no runtime flag. Without both, the file is validly signed and unnotarizable — which looks '
      + 'like success everywhere except on the recipient\'s Mac.'));
  }

  // N-SPCTL-APP — a hard gate on the signed branch, `|| true` on the ad-hoc one.
  if (!mount) {
    rows.push(FAIL('N-SPCTL-APP', 'there is no step that mounts the DMG, so there is nowhere the assessment could run.'));
  } else {
    const assessments = commandLines(mount.text).filter((l) => /spctl --assess --type execute/.test(l));
    const hard = assessments.filter((l) => !swallowed(l));
    const soft = assessments.filter((l) => swallowed(l));
    const branches = /ENABLE_APPLE_SIGNING/.test(codeOf(mount.text));
    if (!branches || hard.length === 0 || soft.length === 0) {
      rows.push(FAIL('N-SPCTL-APP',
        `the Gatekeeper assessment is not branch-correct: ${assessments.length} assessment(s), ${hard.length} hard, `
        + `${soft.length} informational, ENABLE_APPLE_SIGNING ${branches ? 'is' : 'is NOT'} consulted. It must be BOTH: `
        + 'a hard gate when signing is on (`|| true` there is the pipeline\'s licence to publish an unnotarized '
        + 'DMG under a green tick) and `|| true` when it is off (ad hoc, `rejected` is the correct answer and '
        + 'failing on it would mean no fallback build the day the certificate expires).'));
    } else {
      rows.push(PASS('N-SPCTL-APP', `hard when signing is on (${hard.length}), informational when it is off (${soft.length}).`));
    }
  }

  // N-SPCTL-DMG — the assessment a downloaded image actually receives.
  if (mount) {
    const { lines, at, line } = lineWith(mount.text, /spctl --assess --type open --context context:primary-signature/);
    if (at < 0 || swallowed(line) || !failsHardAfter(lines, at, 14)) {
      rows.push(FAIL('N-SPCTL-DMG',
        'the DMG itself is never assessed as `--type open --context context:primary-signature`, or the result is '
        + 'not fatal. That is the assessment a file which arrived by download or e-mail receives, and it is the '
        + 'only one that sees the read-me injection\'s rewrite: the .app inside can be perfectly notarized while '
        + 'the image around it is not.'));
    } else {
      rows.push(PASS('N-SPCTL-DMG', 'the image is assessed as a downloaded file, and a rejection is fatal.'));
    }
  } else {
    rows.push(FAIL('N-SPCTL-DMG', 'no step mounts or assesses the DMG.'));
  }

  // N-NOTARIZED — "accepted" is not the claim; "accepted because Apple notarized it" is.
  if (mount && /source=Notarized Developer ID/.test(codeOf(mount.text))) {
    rows.push(PASS('N-NOTARIZED', 'the assessment must say source=Notarized Developer ID, not merely accepted.'));
  } else {
    rows.push(FAIL('N-NOTARIZED',
      'nothing requires the string `source=Notarized Developer ID` in the spctl output. A build machine can '
      + 'answer `accepted` for reasons that do not transfer to a stranger\'s Mac — a locally trusted '
      + 'certificate, a developer-tools exemption. The source line is what distinguishes the two, and it is '
      + 'the exact verdict the PO measured by hand on 2026-09-05.'));
  }

  return rows;
}

// ── run the rows, over the tree or over a simulation ─────────────────────────
// `--simulate -` reads the JSON from stdin. The sources are tens of kilobytes
// each and a mutant that carries all four would be a 200 KB argv entry; stdin
// has no such ceiling, and a test that hit one would fail for a reason that has
// nothing to do with what it is measuring.
const simText = simulateArg === '-' ? readFileSync(0, 'utf8') : simulateArg;
const sim = simText ? JSON.parse(simText) : null;
const srcSwift = sim && 'swift' in sim ? (sim.swift ?? '') : read('shell-macos/main.swift');
const srcWorkflow = sim && 'workflow' in sim ? (sim.workflow ?? '') : read('.github/workflows/release.yml');
const srcDmg = sim && 'dmgScript' in sim ? (sim.dmgScript ?? '') : read('.github/scripts/dmg-add-readme.sh');
const srcEndpoints = sim && 'endpoints' in sim ? sim.endpoints : ((conf.plugins && conf.plugins.updater && conf.plugins.updater.endpoints) || []);

const rows = [...shellRows(srcSwift, srcEndpoints), ...pipelineRows(srcWorkflow, srcDmg)];

// ⚠ `process.exit()` TRUNCATES A PIPE. Measured here, not remembered: the first
// version of --dump ended in `console.log(json); process.exit(0)` and the reader
// got 63 311 of ~200 000 characters and a JSON parse error, because stdout to a
// pipe is asynchronous and exit does not wait for it. Everything below therefore
// writes and then sets `process.exitCode`, which lets node drain and leave on its
// own. The exit CODES are unchanged — 0 for the reporting modes and for a clean
// pre-flight, 1 when there is a problem — because release.yml gates on them.
if (dumpMode) {
  // The four sources the rows above read, verbatim. See the header for why.
  process.stdout.write(`${JSON.stringify({ workflow: srcWorkflow, dmgScript: srcDmg, swift: srcSwift, endpoints: srcEndpoints })}\n`);
} else if (jsonMode || simulateArg) {
  // Reporting modes. Exit 0 always — see the header. The rows are the evidence.
  process.stdout.write(`${JSON.stringify({ rows }, null, 2)}\n`);
} else {
  for (const r of rows) {
    if (r.status === 'PASS') continue;
    if (r.status === 'SKIP') { note(`${r.id} skipped — ${r.detail}`); continue; }
    if (r.strictOnly && !strict) note(`${r.id}: ${r.detail} — releases are blocked until then.`);
    else fail(`${r.id}: ${r.detail}`);
  }

  // ── report ─────────────────────────────────────────────────────────────────
  const out = [`LangzeitPlaner release pre-flight  (version ${version}${tagArg ? `, tag ${tagArg}` : ''}${strict ? ', strict' : ''})`];
  for (const n of notes) out.push(`  note  ${n}`);
  if (problems.length === 0) {
    out.push(`  ok    every check passed (${rows.filter((r) => r.status === 'PASS').length} shell/pipeline rows green)`);
  } else {
    for (const p of problems) out.push(`  FAIL  ${p}`);
    out.push(`\n${problems.length} problem(s). See docs/v2/RELEASE.md.`);
    process.exitCode = 1;
  }
  process.stdout.write(`${out.join('\n')}\n`);
}
