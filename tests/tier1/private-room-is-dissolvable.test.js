// tests/tier1/private-room-is-dissolvable.test.js — 19.4, and finding P-1.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE SAME SHAPE OF BUG TWICE, AND WHAT IT COST THE SECOND TIME
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `key-backup-is-reachable.test.js` exists because `family/mount.js` declared a hook in a
// docblock and never passed it, so „Schlüssel sichern" returned at its guard on every launch of
// every build and the only export carrying the space keys had no reachable UI.
//
// This is the same shape, one section further down the same sheet, and it reached a person.
// „Server & eigene Geräte" could ARM the private room and nothing in the product could give it
// back: `buildAdminSection` draws „verlassen"/„löschen" only for an `fsp_` circle, and
// `forgetCircle()` clears only `CIRCLE_PREFS`. `privacy-e5-silence.test.js` had that filed as
// finding P-1 — „there is NO WAY BACK to silence" — and graded it a privacy defect.
//
// It was also a TRAP, which nobody had noticed. One Mac mints ONE device identity for life
// (`crypto/identity.js#ensureDeviceIdentity` returns the stored deviceId/deviceShort/memberId on
// every later call), and the relay's `getDevice(deviceId)` check is GLOBAL
// (`handlers/invites.js`). So a Mac that had armed the private room was refused when it later
// tried to redeem a Familienkreis invite — and nothing in the product could clear the row that
// was refusing it. The product owner met exactly that on his second Mac:
//
//     „When adding another Mac to Familienkreis, it said 'Dieser Mac ist auf diesem Server schon
//      eingetragen …' probably as I had added a private sync on this other app installation."
//
// So the property is not „a button exists". It is that the hook is WIRED, that it answers the
// truth about this Mac, and that what it asks the relay for is a DELETE — because revoking would
// leave the row in place and the global check does not care whether a row is revoked.
//
// Mutation-checked: unwiring the hook in `mount.js` survives every other tier-1 and attack row in
// the repository. That is why this file exists rather than a comment.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { shippedFiles } from '../helpers/netscope.js';
import { dissolvePersonal } from '../../src/js/family/mount.js';

const src = (rel) => (shippedFiles().find((f) => f.rel.endsWith(rel)) || {}).src || '';
const MOUNT = src('family/mount.js');
const SETTINGS = src('family/familysettings.js');
const ENGINE = src('family/engine.js');

/** A handle in the shape `arm()` returns, armed to a personal space. */
function handle({ spaceId = 'psp_mine', short = 'AAAABBBBCCCCDDDD' } = {}) {
  return {
    cfg: { spaceId, origin: 'https://relay.invalid' },
    armed: { forStore: { deviceShort: short, deviceId: 'dev_x', memberId: 'mem_x' } },
    parts: { transport: { request: async () => ({ status: 200, json: {} }) } },
  };
}

describe('19.4 · the private room can be given back', () => {
  test('§1 — mount.js supplies `dissolvePersonal` to the settings sections', () => {
    // THE STRUCTURAL HALF, and the one that is invisible at runtime. `buildOptInSection` draws
    // the button only when the hook is on the object, so its ABSENCE is a section that silently
    // goes back to being two facts and no controls — exactly the state finding P-1 described.
    assert.ok(MOUNT.length > 0, 'could not read family/mount.js through the file walk');
    const call = /buildFamilySections\(body, api, \{([\s\S]{0,1200}?)\}\)/.exec(MOUNT);
    assert.ok(call, 'installSections no longer calls buildFamilySections with a hooks literal');
    assert.match(call[1], /dissolvePersonal\s*:/,
      'mount.js stopped passing `dissolvePersonal`, so „Privaten Raum auflösen" is unreachable '
      + 'again — and with it the only way a Mac with a private room can ever join a Familienkreis');
  });

  test('§2 — it answers null for every Mac that has no private room to dissolve', () => {
    // A circle-only Mac and a solo Mac must draw nothing. `psp_` is the discriminator, not the
    // presence of a config: a Mac in a Familienkreis has a `cfg.spaceId` too, and offering to
    // dissolve THAT would delete the family's circle from a settings row about own devices.
    assert.equal(dissolvePersonal(null, {}), null, 'a solo Mac was offered a room to dissolve');
    assert.equal(dissolvePersonal({ cfg: null, armed: null, parts: null }, {}), null);
    assert.equal(dissolvePersonal({ ...handle(), parts: null }, {}), null,
      'a Mac whose engine never started has no transport to ask with');
    assert.equal(dissolvePersonal(handle({ spaceId: 'fsp_family' }), {}), null,
      'THE CIRCLE MUST NOT BE OFFERED HERE — this row would delete a family circle from the '
      + '„eigene Geräte" section, which is 20.4\'s action behind 19.4\'s label');
  });

  test('§3 — and an armed Mac gets the space, the short it will be asked to type, and the port', () => {
    const port = dissolvePersonal(handle(), {});
    assert.ok(port, 'an armed Mac was offered nothing');
    assert.equal(port.spaceId, 'psp_mine');
    assert.equal(port.deviceShort, 'AAAABBBBCCCCDDDD',
      'the typed confirmation asks for this, and a blank one would make the sheet unconfirmable');
    assert.equal(typeof port.dissolvePersonal, 'function');
    assert.equal(typeof port.paired, 'boolean',
      'the confirmation says a second sentence when another Mac is paired; it must be a fact');
  });

  test('§4 — what it asks the relay for is a DELETE, not a revoke', () => {
    // THE LOAD-BEARING CHOICE. `POST /devices/revoke` sets `revokedAt` and LEAVES the row, and
    // the relay's global deviceId check does not care whether a row is revoked — so revoking
    // would satisfy „turn sync off" and leave the Mac exactly as unable to join a circle as
    // before. Only deleting the space cascades the Member and Device rows away.
    assert.match(ENGINE, /spaces\/\$\{spaceId\}\/delete/,
      'engine.js no longer asks the relay to delete the personal space — if this became a revoke, '
      + 'the button would appear to work and the Mac would still be refused by the Familienkreis');
    assert.match(ENGINE, /confirm:\s*spaceId/,
      'the relay refuses a destructive call whose body does not name the space');
  });

  test('§5 — dissolving clears the arming keys but keeps the relay address', () => {
    // `readFamilyConfig` arms on three keys; clearing the flag without the space id leaves a
    // half-armed board. And the origin is deliberately KEPT: it is shared with the Familienkreis
    // and in the shipped shell it is the build's own pin, so clearing it would unpair somebody's
    // circle as a side effect of giving up their private room. `forgetCircle` made the same call.
    const from = MOUNT.indexOf('async function forgetPersonal');
    assert.ok(from > 0, 'forgetPersonal is gone — dissolving no longer disarms this Mac at all');
    const body = MOUNT.slice(from, MOUNT.indexOf('\n// ', from));
    assert.match(body, /FAMILY_PREFS\.enabled\]:\s*false/, 'the enabled flag is not cleared');
    assert.match(body, /FAMILY_PREFS\.space\]:\s*''/, 'the space id is not cleared');
    assert.equal(/FAMILY_PREFS\.origin\]:/.test(body), false,
      'the relay address is being cleared — that unpairs the Familienkreis as a side effect');
  });

  test('§7 — a Mac whose room was dissolved by ANOTHER Mac can still free itself', async () => {
    // THE SECOND MAC. Dissolving from Mac A cascades every device row in the space, including
    // the paired Mac B's — so B is not id-stuck, but it is still ARMED to a space that no longer
    // exists: `readFamilyConfig` finds three keys, the engine starts, and every request earns
    // 403 `not_a_member` for ever. That is finding P-1 again, one Mac over, and shipping only the
    // acting Mac's half would have traded one trap for another.
    //
    // It does not, because the relay's „this space is not yours / not there" is treated as a
    // SUCCESS: B presses the same button, the call answers `not_a_member`, and B forgets the room
    // locally. The same carve-out `adminpanel.js` makes for a circle, for the same reason.
    let asked = null;
    const gone = handle();
    gone.parts.transport = {
      request: async (method, path) => {
        asked = `${method} ${path}`;
        return { status: 403, json: { error: 'not_a_member' } };
      },
    };
    const port = dissolvePersonal(gone, {});
    const res = await port.dissolvePersonal();
    assert.equal(asked, 'POST /api/v1/spaces/psp_mine/delete');
    assert.equal(res.alreadyGone, true,
      'a room the relay has already forgotten must not throw — a Mac that cannot complete the '
      + 'call stays armed to a space that does not exist, with no second way out');
    assert.equal(res.localBoardsUnaffected, true,
      'the sheet reads this before saying „kein einziger Eintrag geht verloren"');
  });

  test('§8 — and a real refusal is NOT swallowed', () => {
    // The carve-out is exactly `not_a_member`. If it widened, a relay that refused for any other
    // reason would leave the Mac believing it had disarmed while the rows survive on the server.
    const from = ENGINE.indexOf('export async function deletePersonalSpaceOnRelay');
    const body = ENGINE.slice(from, ENGINE.indexOf('\n/**', from + 10));
    assert.match(body, /error === 'not_a_member'/, 'the carve-out is no longer pinned to one code');
    assert.match(body, /res\.status !== 200/,
      'every other non-200 must still throw — a silent failure here is a Mac that thinks it is '
      + 'solo while the relay still holds its rows');
  });

  test('§6 — the settings section draws the button only when the hook is there', () => {
    // A button drawn without a working port is worse than no button: it is a promise that fails
    // under the finger. `familysettings.js` must test the hook before rendering.
    assert.match(SETTINGS, /hooks\.dissolvePersonal/,
      'familysettings.js no longer reads the hook, so the button is drawn unconditionally or '
      + 'not at all');
    assert.match(SETTINGS, /confirmDissolvePersonal\(/,
      'the button no longer opens the confirmation — an irreversible relay call must not fire '
      + 'from a single click');
  });
});
