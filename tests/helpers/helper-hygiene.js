// tests/helpers/helper-hygiene.js — the filesystem half of the reconstruction guard.
//
// `tests/tier1/suite-integrity.test.js` bans `node:fs` from tier-1 TEST files (so the suite can
// never touch the user's real board) and requires every tier-1 test to import an app module or a
// helper (so it can never go green against a stand-in). Both rules are right, so the fs read lives
// here — the same shape `purity.js` and `netscope.js` already use.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const HELPERS_DIR = fileURLToPath(new URL('./', import.meta.url));

/**
 * Phrases a rebuilt helper uses to describe itself. Matched against the leading comment block
 * only, so ordinary prose about reconstruction further down a file is not caught.
 */
export const RECONSTRUCTION_MARKERS = Object.freeze([
  /this file is a reconstruction/i,
  /best-effort (rebuild|reconstruction)/i,
  /rebuil[td] from the surviving call sites/i,
  /rebuil[td] from (the )?call sites/i,
  /the original was better/i,
]);

/** The first `lines` lines of a source string — a file's self-description lives at the top. */
export const headOf = (src, lines = 60) => src.split('\n').slice(0, lines).join('\n');

/** Which marker, if any, a source's head matches. `null` when it is clean. */
export function reconstructionMarkerIn(src) {
  const head = headOf(src);
  return RECONSTRUCTION_MARKERS.find((re) => re.test(head)) ?? null;
}

/**
 * This file, excluded from its own scan — the one exception, named rather than clever.
 *
 * `RECONSTRUCTION_MARKERS` is a list of the phrases, so this file's own head CONTAINS every
 * phrase the detector looks for and matches itself on the first pass. Three ways out were
 * available and this is the least bad of them: hiding the table below line 60 makes the guard
 * depend on where in the file it happens to sit; splicing the phrases out of string fragments
 * (`'this file is a ' + 'reconstruction'`) defeats the match by making the source unreadable.
 * A named self-exclusion is greppable, and the positive control in
 * `tests/tier1/no-reconstruction.test.js` — a planted banner the detector MUST match — is what
 * keeps it from quietly becoming an exclusion of everything.
 */
export const SELF = 'helper-hygiene.js';

/** Every `.js`/`.mjs` helper except this one, as `{name, marker}`; `marker` is null when clean. */
export function helperSelfDescriptions() {
  return readdirSync(HELPERS_DIR)
    .filter((n) => (n.endsWith('.js') || n.endsWith('.mjs')) && n !== SELF)
    .map((name) => ({
      name,
      marker: reconstructionMarkerIn(readFileSync(path.join(HELPERS_DIR, name), 'utf8')),
    }));
}

// ── the headless-shell guard ────────────────────────────────────────────────
// `npm run test:dom` launches the shell once per test file. If those launches
// present a window or take focus, a full run flashes 26 windows across whatever
// the human is doing — and a suite that is unpleasant to run gets run less,
// which is a correctness problem and not only an ergonomic one.

export const SHELL_SWIFT = fileURLToPath(new URL('../../shell-macos/main.swift', import.meta.url));

export function shellSource() {
  return readFileSync(SHELL_SWIFT, 'utf8');
}

/** Lines that present UI, with whether each is guarded by `isHeadless`. */
export function presentationSites(src = shellSource()) {
  const lines = src.split('\n');
  return lines
    .map((line, i) => ({ n: i + 1, line: line.trim() }))
    .filter(({ line }) =>
      !line.startsWith('//') &&
      (/\bmakeKeyAndOrderFront\b/.test(line) ||
        /NSApp\.activate\(/.test(line) ||
        /setActivationPolicy\(/.test(line)))
    .map((row) => ({
      ...row,
      // Guarded on the line itself, or by an `isHeadless` early-return within the
      // preceding few lines — `guard !isHeadless else { return }` at the top of a
      // function protects every call in it, and reading only the call's own line
      // would report those as unguarded.
      guarded:
        /isHeadless/.test(row.line) ||
        lines
          .slice(Math.max(0, row.n - 7), row.n - 1)
          .some((l) => /isHeadless/.test(l) && /\breturn\b|\bguard\b/.test(l)),
    }));
}
