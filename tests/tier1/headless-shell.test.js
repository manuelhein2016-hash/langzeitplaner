// tests/tier1/headless-shell.test.js
//
// A headless run must not present UI.
//
// `tests/run-dom-tests.sh` launches the shell once per tier-2 file — 26 launches per
// `npm run test:dom`, and the agents run it constantly. Until 2026-08-29 the shell called
// `makeKeyAndOrderFront` and `NSApp.activate(ignoringOtherApps:)` unconditionally, so every
// run stole focus and flashed a window per file.
//
// The subtlety worth keeping: the activation policy must be `.accessory`, NOT `.prohibited`.
// `.prohibited` looks more correct and is wrong — it denies the process the GUI session context
// WebKit needs to reach the WebCrypto master key in the login Keychain, which took
// `crypto-keystore-phase1` from 4/4 to 1/4 with `KeyStoreUnavailableError`. That is ADR 002 §1's
// engine-difference #8 arriving from an unexpected direction, so it is asserted here rather than
// left to be rediscovered by whoever next tries to tidy this up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presentationSites, shellSource } from '../helpers/helper-hygiene.js';

test('every UI-presenting call in the shell is guarded by isHeadless', () => {
  const unguarded = presentationSites()
    .filter((s) => !s.guarded)
    .map((s) => `main.swift:${s.n}  ${s.line}`);

  assert.deepEqual(
    unguarded,
    [],
    'A headless run would present UI. `npm run test:dom` launches the shell once per test ' +
      'file, so an unguarded call here flashes a window — or steals focus — 26 times per run:\n  ' +
      unguarded.join('\n  '),
  );
});

test('the headless activation policy is .accessory, never .prohibited', () => {
  const src = shellSource();
  assert.match(
    src,
    /isHeadless\s*\?\s*\.accessory\s*:\s*\.regular/,
    'headless runs must use .accessory',
  );
  assert.ok(
    !/isHeadless\s*\?\s*\.prohibited/.test(src),
    '.prohibited denies WebKit the session context it needs for the WebCrypto master key in the ' +
      'login Keychain — measured: crypto-keystore-phase1 goes 4/4 -> 1/4 with ' +
      'KeyStoreUnavailableError. Use .accessory.',
  );
});
