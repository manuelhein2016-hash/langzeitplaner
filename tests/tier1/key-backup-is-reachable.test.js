// tests/tier1/key-backup-is-reachable.test.js — 21.B / ADR 002 §7.2.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE ONE MISSING PROPERTY, AND WHAT IT COST
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `familysettings.js#buildRecoverySection` draws „Schlüssel sichern" — the export sheet, its two
// buttons, the passphrase field, the D8 copy. It opens with:
//
//     const material = typeof hooks.recoveryMaterial === 'function' ? hooks.recoveryMaterial : null;
//     if (!material) return;          // not armed this launch
//
// and its own docblock said the hook "is supplied by `family/mount.js`". It was not.
// `installSections` passed `{ onOptIn }` and nothing else, so that guard returned on every
// launch of every build, and the section never drew.
//
// The consequence was not a missing button. `crypto/backup.js#exportBackup` is the ONLY export in
// the product that carries the identity and the space keys — the ⇧⌘E export is a v1-shaped board
// file and deliberately carries neither — and its single call site is inside that section. So
// there was **no reachable way to back up your keys at all**. With no account, no password and no
// reset, a dead Mac took the Familienkreis with it, permanently and silently, and story 21.B's
// honesty moment — the sentence that exists to warn about exactly that — was missing because the
// thing it warns about was unreachable.
//
// Nothing caught it. No test in the tree referenced `recoveryMaterial`; every `exportBackup` test
// calls the crypto module directly and never the UI. A reachability property that no test asserts
// is a feature that can be deleted by omission, which is what happened.
//
// So this file asserts the property itself: the hook exists, it answers the shape
// `crypto/backup.js#bundleFor` validates, and it answers `null` exactly when there is genuinely
// nothing to back up.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { shippedFiles } from '../helpers/netscope.js';
import { recoveryMaterial } from '../../src/js/family/mount.js';

// Read through the helper, never `node:fs` here: `suite-integrity.test.js` bans the import from
// tier-1 test files outright, so that no test can quietly reach the user's real board. The file
// walk lives in `helpers/netscope.js`, which is the same seam `shell-parity.test.js` uses.
const MOUNT = (shippedFiles().find((f) => f.rel.endsWith('family/mount.js')) || {}).src || '';

const IDENTITY = Object.freeze({ memberId: 'mem_me', sigPubRaw: new Uint8Array(32) });

/** A handle in the shape `arm()` returns: `{cfg, armed, parts}`. */
function handle({ spaceId = 'psp_mine', epochs = new Map([[1, new Uint8Array(32)]]) } = {}) {
  return {
    cfg: { spaceId, origin: 'https://relay.invalid' },
    armed: { identity: IDENTITY },
    parts: { keyring: { keysByEpoch: (id) => (id === spaceId ? epochs : new Map()) } },
  };
}

describe('21.B · the key backup is reachable at all', () => {
  test('§1 — mount.js supplies `recoveryMaterial` to the settings sections', () => {
    // THE STRUCTURAL HALF, and the one that was actually missing. `buildRecoverySection` returns
    // early unless this property is on the hooks object, so its ABSENCE is invisible at runtime —
    // no error, no warning, just a section that never appears. Asserting the wiring is the only
    // way to notice it going away again.
    assert.ok(MOUNT.length > 0, 'could not read family/mount.js through the file walk');
    const call = /buildFamilySections\(body, api, \{([\s\S]{0,400}?)\}\)/.exec(MOUNT);
    assert.ok(call, 'installSections no longer calls buildFamilySections with a hooks literal');
    assert.match(call[1], /recoveryMaterial\s*:/,
      'mount.js stopped passing `recoveryMaterial`, so „Schlüssel sichern" is unreachable again '
      + 'and with it every way to back up the identity and the space keys');
  });

  test('§2 — an armed Mac gets an identity and a personal bundle shaped the way backup.js wants', () => {
    const held = recoveryMaterial(handle())();
    assert.ok(held, 'an armed Mac answered null — there is material and it was not offered');
    assert.equal(held.identity, IDENTITY, 'the identity block is what exportBackup seals');
    // `crypto/backup.js#bundleFor` validates `bundle.id` with a per-slot PREFIX check and throws
    // on a mismatch. The pairing flow's contract next door uses `spaceId` for the same idea, so
    // this is exactly the field a plausible fix gets wrong — and it would fail loudly at export
    // time, under the button, rather than here.
    assert.equal(held.spaces.personal.id, 'psp_mine',
      'the personal slot must carry `id` (not `spaceId`) — bundleFor refuses anything else');
    assert.ok(held.spaces.personal.epochs.size > 0, 'a bundle with no epoch keys is refused by bundleFor');
  });

  test('§3 — a Mac with nothing to back up answers null, and the sheet draws nothing', () => {
    // `installSections(null, hooks)` is the solo and circle-only path, so the hook always EXISTS
    // and its answer is what says whether there is anything to recover. `null` is the honest
    // answer, and `buildRecoverySection` probes for it before drawing — a section offering to
    // export keys that are not there would be worse than no section.
    assert.equal(recoveryMaterial(null)(), null, 'a solo Mac claimed to have recovery material');
    assert.equal(recoveryMaterial({ cfg: null, armed: null, parts: null })(), null);
    assert.equal(recoveryMaterial({ ...handle(), parts: null })(), null,
      'a Mac whose engine has not started has no key ring to write');
  });

  test('§4 — the family slot is filled only when this Mac holds circle keys', () => {
    // D9's waiting state: a joiner is in a circle before the keys arrive. A backup naming a family
    // space it holds no key for would restore a member who cannot read anything — and `bundleFor`
    // refuses an empty `epochs` outright, so this would be a throw under the button rather than a
    // bad file. Either way the correct artifact for that Mac is `family: null`.
    const held = recoveryMaterial(handle())();
    assert.equal(held.spaces.family, null,
      'a Mac in no circle must produce family: null, not an empty bundle');
  });

  test('§5 — the material is read at the moment of the press, not when the sheet was drawn', () => {
    // A circle can be joined, or its epoch rotated, between drawing the sheet and pressing the
    // button. `buildRecoverySection` calls `material()` inside `run()` for that reason, so this
    // must be a function that re-reads — not a value captured once.
    let epochs = new Map([[1, new Uint8Array(32)]]);
    const h = handle();
    h.parts.keyring.keysByEpoch = () => epochs;
    const read = recoveryMaterial(h);
    assert.equal(read().spaces.personal.epochs.size, 1);
    epochs = new Map([[1, new Uint8Array(32)], [2, new Uint8Array(32)]]);
    assert.equal(read().spaces.personal.epochs.size, 2,
      'the hook captured the key ring once — a rotation between draw and press would be lost');
  });
});
