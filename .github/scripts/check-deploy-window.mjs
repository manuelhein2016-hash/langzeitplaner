#!/usr/bin/env node
// R-9.2 — the deploy that does not happen, and that nobody knows did not happen.
//
// ⚠ THIS FILE IS WHERE THE REASONING LIVES, BECAUSE `server/vercel.json` CANNOT HOLD IT.
// It used to carry an 822-character `_comment_ignoreCommand` key. Vercel's config schema is
// `additionalProperties: false`, so that key made the project impossible to redeploy by hand:
// "Invalid request: should NOT have additional property `_comment_ignoreCommand`". Git-triggered
// builds tolerated it; the Redeploy button did not — which is the worst kind of difference,
// because it only appears when someone is trying to recover. Removed 2026-09-05. Do not
// reintroduce a comment key: JSON has no comments, and the enforcement is here anyway.
//
// `server/vercel.json` decides whether to build with an `ignoreCommand`: exit 0
// SKIPS the deployment, any non-zero builds. It USED to be
//
//     "ignoreCommand": "git diff --quiet HEAD^ HEAD -- ."
//
// which is ONE commit: the tip and its parent, scoped to the Vercel root
// directory (`server/`).
//
// GitHub does not work that way. A push carries a RANGE — `github.event.before`
// to `github.event.after` — and both the path filter on this workflow and the
// diff a reviewer reads are computed over the whole range. So:
//
//     commit 1   server/prisma/migrations/…/migration.sql   ← the schema moves
//     commit 2   docs/v2/RELEASE.md                          ← a note about it
//     commit 3   README.md                                   ← a typo
//     git push
//
// is one push, three commits. This workflow runs (the range touches `server/`),
// the config pre-flight passes, the server suite passes, the merge is green —
// and Vercel diffed commit 3 against commit 2, saw nothing under `server/`, and
// skipped the deployment. No `deployment_status` is emitted, so the smoke job
// never ran either. The migration is in `main` and Frankfurt is still on the old
// schema.
//
// ── WHAT CHANGED, AND WHY THIS SCRIPT DID NOT SIMPLY GO AWAY ────────────────
//
// `server/vercel.json` now reads
//
//     [ -n "$VERCEL_GIT_PREVIOUS_SHA" ] \
//       && git cat-file -e "$VERCEL_GIT_PREVIOUS_SHA^{commit}" 2>/dev/null \
//       && git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- .
//
// so the window is the whole range Vercel has not yet deployed, and BOTH guards
// fail open: an unset variable and a SHA a shallow checkout cannot resolve each
// exit non-zero, which builds.
//
// This script therefore no longer assumes the window — it READS it out of
// `server/vercel.json` and behaves accordingly:
//
//   · a single-commit window (`HEAD^`) → the old comparison, red on exactly the
//     pushes Vercel will drop. That is the state this script was written for and
//     it is kept working, because a revert of that one line must not be silent.
//   · a `VERCEL_GIT_PREVIOUS_SHA` window → the range can no longer be missed, so
//     what is checked instead is the FAIL-SAFE: an unset or unresolvable SHA must
//     BUILD. A window that skips on an unknown range is worse than the defect it
//     replaced, because it fails quiet in the case nobody can reproduce.
//   · anything else → red, naming what it found. An `ignoreCommand` this script
//     does not understand is not a passing grade.
//
// Zero dependencies, like everything else in this repository.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = 'server/';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ZERO = /^0{40}$/;

/** `git` with the repository's own working directory, trimmed, never throwing on empty output. */
function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A commit-ish that git can actually resolve — the range is untrustworthy input. */
function resolvable(rev) {
  if (!rev || ZERO.test(rev)) return false;
  try { git('rev-parse', '--verify', `${rev}^{commit}`); return true; } catch { return false; }
}

const changed = (a, b) => git('diff', '--name-only', a, b, '--', ROOT).split('\n').filter(Boolean);

// ── 1. WHICH WINDOW DOES THE SHIPPED CONFIG ACTUALLY USE? ────────────────────

const IGNORE = (() => {
  const file = path.join(REPO, 'server', 'vercel.json');
  let cfg;
  try { cfg = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    console.error(`::error title=vercel.json unreadable::${file}: ${e.message}`);
    process.exit(1);
  }
  const cmd = typeof cfg.ignoreCommand === 'string' ? cfg.ignoreCommand : '';
  if (!cmd) {
    console.error('::error title=No ignoreCommand::server/vercel.json carries no ignoreCommand, so EVERY '
      + 'push to any path deploys. That is not this script\'s defect to fix, but it is not a pass either.');
    process.exit(1);
  }
  return cmd;
})();

const USES_RANGE = IGNORE.includes('VERCEL_GIT_PREVIOUS_SHA');
const USES_TIP = /\bHEAD\^/.test(IGNORE);

if (USES_RANGE) {
  // The range is covered. What is left to check is the half a range does not fix:
  // an UNKNOWN range must build, not skip. Both guards are asserted by running the
  // real string, not by reading it — a comment cannot exit 0.
  const run = (sha) => {
    try {
      execFileSync('sh', ['-c', IGNORE], {
        cwd: path.join(REPO, 'server'),
        env: { ...process.env, VERCEL_GIT_PREVIOUS_SHA: sha },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return 0;
    } catch (e) { return typeof e.status === 'number' ? e.status : 1; }
  };
  const unset = run('');
  const unknown = run('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  let bad = false;
  if (unset === 0) {
    console.error('::error title=ignoreCommand skips on an unset SHA::with VERCEL_GIT_PREVIOUS_SHA unset the '
      + 'ignoreCommand exits 0, which SKIPS the deployment. An unknown range must BUILD.');
    bad = true;
  }
  if (unknown === 0) {
    console.error('::error title=ignoreCommand skips on an unresolvable SHA::with a SHA this checkout does not '
      + 'carry (a shallow clone, a force-push, a rewritten history) the ignoreCommand exits 0 and SKIPS. '
      + 'An unresolvable range must BUILD.');
    bad = true;
  }
  if (bad) process.exit(1);
  console.log(`ignoreCommand window: the whole VERCEL_GIT_PREVIOUS_SHA..HEAD range — a push's earlier commits `
    + 'can no longer be missed.');
  console.log(`fail-safe: unset SHA → exit ${unset} (BUILD) · unresolvable SHA → exit ${unknown} (BUILD).`);
  process.exit(0);
}

if (!USES_TIP) {
  console.error('::error title=Unrecognised ignoreCommand::this guard understands a single-commit window '
    + `(HEAD^) and a VERCEL_GIT_PREVIOUS_SHA range, and server/vercel.json carries neither:\n  ${IGNORE}\n`
    + 'Teach this script the new shape rather than deleting the check.');
  process.exit(1);
}

console.log('ignoreCommand window: HEAD^..HEAD — a single commit. Comparing it with the push range.');

// ── 2. THE SINGLE-COMMIT WINDOW, AGAINST THE PUSH RANGE ──────────────────────

const before = process.env.PUSH_BEFORE || '';
const after = process.env.PUSH_AFTER || process.env.GITHUB_SHA || 'HEAD';

if (!resolvable(after)) {
  console.log(`::notice title=No push tip::"${after}" is not a commit in this checkout; nothing to compare.`);
  process.exit(0);
}

// A brand-new branch pushes `before = 000…0`. There is no range, Vercel builds
// the whole thing, and there is nothing to warn about.
if (!resolvable(before)) {
  console.log('::notice title=New branch::the push carries no before-SHA, so there is no range to compare. Vercel builds the tip.');
  process.exit(0);
}

// The tip's own parent — literally what the ignoreCommand will diff.
let parent = null;
try { parent = git('rev-parse', '--verify', `${after}^`); } catch { /* root commit */ }
if (!parent) {
  console.log('::notice title=Root commit::the push tip has no parent, so `HEAD^ HEAD` does not apply.');
  process.exit(0);
}

const inPush = changed(before, after);
const inTip = changed(parent, after);

console.log(`push range ${before.slice(0, 8)}..${after.slice(0, 8)} — ${inPush.length} file(s) under ${ROOT}`);
console.log(`ignoreCommand window ${parent.slice(0, 8)}..${after.slice(0, 8)} — ${inTip.length} file(s) under ${ROOT}`);

if (inPush.length === 0) {
  console.log(`ok — this push changes nothing under ${ROOT}; skipping the deployment is correct.`);
  process.exit(0);
}
if (inTip.length > 0) {
  console.log(`ok — the last commit of the push carries a ${ROOT} change, so the ignoreCommand will build.`);
  process.exit(0);
}

const list = inPush.slice(0, 20).map((f) => `  ${f}`).join('\n');
console.error(
  '::error title=Vercel will skip this deployment::'
  + `${inPush.length} file(s) under ${ROOT} changed in this push, but NOT in its last commit `
  + `(${parent.slice(0, 8)}..${after.slice(0, 8)}). server/vercel.json's ignoreCommand looks only at `
  + 'HEAD^..HEAD, so it will exit 0 and no deployment will be created — and with no deployment there '
  + 'is no deployment_status, so the smoke job will not run either. Push an empty commit that touches '
  + `${ROOT}, or redeploy from the Vercel dashboard. The permanent fix is residual R-9.2: give the `
  + 'ignoreCommand the whole range (VERCEL_GIT_PREVIOUS_SHA) and make an unknown range BUILD.',
);
console.error(`the ${ROOT} files this push moves and this deployment would not carry:\n${list}`);
process.exit(1);
