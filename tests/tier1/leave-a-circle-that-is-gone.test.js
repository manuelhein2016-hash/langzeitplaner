// tests/tier1/leave-a-circle-that-is-gone.test.js — 20.3 / 20.4, THE WAY OUT.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE TRAP THIS CLOSES
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// 20.4 says that when the admin deletes the Familienkreis, "every member reverts to a fully
// intact solo board". The board part was always true — every device holds a complete replica and
// nothing on the server can reach it. The TRANSITION was not.
//
// A remaining member's Mac learns nothing when a space disappears. It keeps every `CIRCLE_PREFS`
// key, keeps syncing, and earns `not_a_member` on every request. And `leaveSpace()` — the one
// control in the product for getting out of a circle — was written as:
//
//     const res = await call(origin, 'POST', '/api/v1/members/leave', …);   // ← throws
//     await forgetCircle();                                                 // ← never runs
//
// So pressing „Kreis verlassen" to clean up threw before it cleaned anything up. The member was
// stuck in a circle that no longer existed, with no in-app way out short of a reinstall or
// hand-editing `board.json`.
//
// WHY THE CLIENT CANNOT JUST ASK WHICH IT IS. The relay answers `not_a_member` for BOTH "you were
// removed" and "that space does not exist" — `server/core/handlers/lifecycle.js:198`, in its own
// words: *"an unknown space and a space you are not in: one answer"*. That is deliberate and
// correct: telling them apart would turn a space id into an existence oracle for anyone holding
// one. So the fix cannot be "detect deletion"; it has to be "in either case, this Mac is not in
// that circle, so let it out".
//
// WHAT MUST NOT HAPPEN is forgetting the circle on any OTHER failure. Offline, a 500, a protocol
// refusal — the membership may be perfectly good and the request simply did not arrive. §3 is
// that half, and it is the row that would catch a fix written as a bare `finally`.

import '../helpers/env.js';
import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createAdminPort, initAdminPanel } from '../../src/js/family/adminpanel.js';

const CIRCLE = Object.freeze({
  spaceId: 'fsp_gone',
  origin: 'https://relay.invalid',
  memberId: 'mem_me',
  role: 'member',
});

/** The shape `call()` throws for a non-200 — status, and the relay's body. */
function relayError(status, error) {
  const e = new Error(`relay → ${status} ${error}`);
  e.status = status;
  e.body = { error };
  return e;
}

/**
 * A rig that records what the local half did. `setSettings`/`persist`/`reload` are the three
 * things `forgetCircle()` performs, so observing them IS observing whether the Mac got out.
 */
function rig({ answer }) {
  const seen = { settings: [], persisted: 0, reloaded: 0, requests: [] };
  initAdminPanel({
    arm: async () => ({
      request: async (method, path, query, body) => {
        seen.requests.push(`${method} ${path}`);
        const r = answer(method, path, body);
        if (r instanceof Error) throw r;
        return r;
      },
    }),
    setSettings: (patch) => { seen.settings.push(patch); },
    persist: async () => { seen.persisted += 1; },
    reload: () => { seen.reloaded += 1; },
    members: () => ({ members: [], me: null }),
    roster: () => [],
  });
  return seen;
}

/** Did `forgetCircle()` run? It clears every CIRCLE_PREFS key, persists, and reloads. */
function gotOut(seen) {
  const patch = seen.settings.at(-1) || {};
  const cleared = Object.values(patch).filter((v) => v === '' || v === false).length;
  return seen.persisted >= 1 && seen.reloaded >= 1 && cleared >= 6;
}

beforeEach(() => { initAdminPanel(); });

describe('20.4 · a member can leave a circle that no longer exists', () => {
  test('§1 — the relay says `not_a_member`, and this Mac still gets out', async () => {
    const seen = rig({ answer: () => relayError(403, 'not_a_member') });
    const res = await createAdminPort(CIRCLE).leaveSpace();
    assert.equal(res.alreadyGone, true, 'leaveSpace hid the fact that the relay refused');
    assert.ok(gotOut(seen),
      'the relay refused and the local half never ran — this is the trap: the member stays in a '
      + 'circle that does not exist, and „Kreis verlassen" is the control that was supposed to '
      + 'get them out');
    assert.deepEqual(seen.requests, ['POST /api/v1/members/leave'],
      'the leave was not attempted — it must still be TRIED before falling back to local cleanup');
  });

  test('§2 — the happy path is unchanged: relay first, then forget', async () => {
    const seen = rig({ answer: () => ({ status: 200, json: { ok: true, rotateRequired: true } }) });
    const res = await createAdminPort(CIRCLE).leaveSpace();
    assert.equal(res.ok, true);
    assert.equal(res.alreadyGone, undefined, 'a successful leave must not claim the circle was gone');
    assert.ok(gotOut(seen), 'a successful leave did not clear the circle locally');
  });

  test('§3 — and EVERY other failure still throws, with the circle intact', async () => {
    // The row that would catch a fix written as a bare `finally`. An offline Mac, a 500 or a
    // protocol refusal means the request did not arrive — the membership may be perfectly good,
    // and silently forgetting a circle the user is still in would be data loss dressed as
    // tidiness. Each of these must throw AND leave the local state untouched.
    for (const [status, code] of [[503, 'offline'], [500, 'server_error'], [426, 'protocol']]) {
      const seen = rig({ answer: () => relayError(status, code) });
      await assert.rejects(() => createAdminPort(CIRCLE).leaveSpace(), /relay/,
        `a ${status} ${code} was swallowed — only not_a_member may forget the circle`);
      assert.equal(seen.settings.length, 0, `a ${code} failure cleared the circle anyway`);
      assert.equal(seen.reloaded, 0, `a ${code} failure reloaded the board`);
    }
  });

  test('§4 — deleteSpace gets the same way out, without swallowing the proof demand', async () => {
    // `deleteSpace()` without a proof is DESIGNED to earn a 403 that names the co-signature terms
    // (`handlers/lifecycle.js:732-741`, `second_member_signature_required`). That 403 must still
    // reach `leavedelete.js`, or the admin would be told the circle was deleted when it was not.
    const demand = rig({ answer: () => relayError(403, 'second_member_signature_required') });
    await assert.rejects(() => createAdminPort(CIRCLE).deleteSpace(null), /second_member/,
      'the co-signature demand was swallowed — the admin would think the delete succeeded');
    assert.equal(demand.settings.length, 0, 'the proof demand cleared the circle locally');

    // …and a space that is already gone still lets this Mac out.
    const gone = rig({ answer: () => relayError(403, 'not_a_member') });
    const res = await createAdminPort(CIRCLE).deleteSpace(null);
    assert.equal(res.alreadyGone, true);
    assert.ok(gotOut(gone), 'deleting an already-deleted space left this Mac stuck in it');
  });
});
