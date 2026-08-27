// Pre-flight for a release — `node .github/scripts/check-release-config.mjs [--tag vX.Y.Z] [--strict]`
//
// Everything here is checkable without Rust, without a network and without a
// GitHub account, so it runs both in CI (first job, fails in seconds) and on a
// laptop before anyone types `git tag`.
//
// It answers four questions:
//   1. Do the three version numbers agree, and do they agree with the tag?
//   2. Is the updater actually configured — real public key, real endpoint?
//   3. Does the app still have zero runtime npm dependencies?
//   4. Is the release-critical shape of tauri.conf.json intact?
//
// --strict adds the checks that only make sense on a real release (a tag, a
// resolved endpoint). Without it the script is a lint you can run any day.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const tagArg = args.includes('--tag') ? args[args.indexOf('--tag') + 1] : null;

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

// ── report ───────────────────────────────────────────────────────────────────
console.log(`LangzeitPlaner release pre-flight  (version ${version}${tagArg ? `, tag ${tagArg}` : ''}${strict ? ', strict' : ''})`);
for (const n of notes) console.log(`  note  ${n}`);
if (problems.length === 0) {
  console.log('  ok    every check passed');
  process.exit(0);
}
for (const p of problems) console.log(`  FAIL  ${p}`);
console.log(`\n${problems.length} problem(s). See docs/v2/RELEASE.md.`);
process.exit(1);
