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

// ── LZP-1002 · the OTHER shell ───────────────────────────────────────────────
//
// `sync_request` is one contract with two implementations (`src/js/platform/net.js` §6). The
// Swift half is verified end to end in the shipped `.app`; the Rust half has never been compiled
// — there is no `cargo` on this machine (PLAN.md risk R8) — so the only thing that can hold the
// two together is a source-level row, and a source-level row needs the source.
//
// Exported HERE rather than read ad hoc in a test for the reason every other path in this file is
// exported: one definition of where the file is, so a move breaks one line instead of six.
export const SHELL_RUST = fileURLToPath(new URL('../../src-tauri/src/lib.rs', import.meta.url));

export function rustSource() {
  return readFileSync(SHELL_RUST, 'utf8');
}

/**
 * The Tauri crate manifest. Here rather than read ad hoc in a test because `suite-integrity.js`
 * forbids a tier-1 file from importing `node:fs` at all — reading repo files is a HELPER's job,
 * and that rule is what keeps "no test reaches outside the repo" checkable by grep.
 */
export const CARGO_TOML = fileURLToPath(new URL('../../src-tauri/Cargo.toml', import.meta.url));

export function cargoManifest() {
  return readFileSync(CARGO_TOML, 'utf8');
}

/**
 * Every `SyncRefusal` name the Swift shell can answer with. The refusal vocabulary is the ONE
 * thing a test cannot tell the two shells apart by — that is the design (`net.js` §6: one
 * contract, two shells) — so it is the right thing to hold them to.
 * @param {string} src
 * @returns {string[]} sorted, deduplicated
 */
export function swiftRefusalNames(src = shellSource()) {
  const block = src.slice(src.indexOf('enum SyncRefusal'));
  const body = block.slice(0, block.indexOf('\n}'));
  return [...new Set([...body.matchAll(/=\s*"([a-z0-9_]+)"/g)].map((m) => m[1]))].sort();
}

/**
 * The same vocabulary as the Rust shell spells it — `pub const NAME: &str = "…";` inside
 * `mod sync_refusal`.
 * @param {string} src
 * @returns {string[]} sorted, deduplicated
 */
export function rustRefusalNames(src = rustSource()) {
  const i = src.indexOf('mod sync_refusal');
  if (i < 0) return [];
  const body = src.slice(i, src.indexOf('\n}', i));
  return [...new Set([...body.matchAll(/&str\s*=\s*"([a-z0-9_]+)"/g)].map((m) => m[1]))].sort();
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
