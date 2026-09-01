// tests/fleet/e6-gate-privat.test.js — THE FRESH MEMBER-ADVERSARY, ROUND 2: the redaction
// boundary, re-attacked from the states THIS round created.
//
// The previous round's result was **zero bytes of a Privat entry** across five routes, and
// `e6-attack-privat.test.js` §1a–§1g still assert each of those, unchanged and green. This file
// does not repeat them. It asks whether the two new positions an adversary can now reach —
//
//   · a SECOND membership of the same circle, held by the same human on the same Mac
//     (`e6-gate-removal.test.js` §1d), and
//   · the circle AFTER she has purged the founder and every other member
//     (`e6-gate-removal.test.js` §1f)
//
// — are worth one byte of `visibility: 'privat'` to her. Every response body her client receives
// across the whole attack is recorded and searched.
//
// SUCCEEDED / FAILED are from the ADVERSARY's side.

import '../helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { entityUuid as newUuid } from '../../src/js/core/ids.js';
import { familyKey } from '../../src/js/core/ops.js';
import { adminProofString } from '../../server/core/auth.js';
import { b64u } from '../../src/js/core/b64.js';

import {
  buildCircle, join, refreshRoster, bootMac, engineFor, on,
  publishAttestation, publishSharedEntry, boardOf, S,
} from './e6-attack-circle.js';

const TE = new TextEncoder();

/** The sentence that must never leave Papa's Mac. */
const SECRET = 'Vorstellungsgespraech-Onkologie';
/** The one he DID choose to share — the control, so "zero bytes" is not vacuous. */
const SHARED = 'Omas Geburtstag';

async function mintProof(signer, terms) {
  const sig = new Uint8Array(await S.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signer.recovery.recSig.privateKey, TE.encode(adminProofString(terms))));
  return { by: signer.forStore.memberId, sig: b64u(sig) };
}

/** Wrap a Mac's transport so every byte it receives is kept. */
function recording(mac) {
  const inner = mac.transport;
  const seen = [];
  mac.transport = {
    origin: inner.origin,
    async request(method, path, query, body, headers) {
      const res = await inner.request(method, path, query, body, headers);
      seen.push({ method, path, status: res.status, json: res.json });
      return res;
    },
  };
  return seen;
}

async function found(C) {
  await bootMac(C, C.papa);
  await on(C.papa, async () => {
    assert.equal(C.papa.store.apply('attestMyDevice', {
      deviceShort: C.papa.forStore.deviceShort, blob: C.papa.myBlob,
    }), true);
    assert.equal(C.papa.store.apply('claimAdmin', {}), true);
    C.papa.engine = engineFor(C, C.papa);
    assert.equal((await C.papa.engine.pushNow()).pushed, 2);
  });
}

async function bring(C, mac) {
  await bootMac(C, mac);
  await on(mac, async () => {
    mac.engine = engineFor(C, mac);
    await mac.engine.syncNow();
    await publishAttestation(C, mac);
  });
}

test('§1 · the redaction boundary, from the new positions', async (t) => {
  const C = await buildCircle(['papa', 'mama', 'eve', 'eve2']);
  C.colors.eve2 = 'rot';
  await refreshRoster(C);
  await found(C);
  assert.equal((await join(C, C.mama)).status, 200);
  assert.equal((await join(C, C.eve)).status, 200);
  await refreshRoster(C);
  await on(C.papa, () => C.papa.engine.syncNow());
  await bring(C, C.mama);
  await bring(C, C.eve);
  await refreshRoster(C);
  await on(C.papa, () => C.papa.engine.syncNow());

  let privatKey = '';
  let sharedUuid = '';
  await on(C.papa, async () => {
    const id = newUuid();
    assert.equal(C.papa.store.apply('createNoteInline', {
      id, date: '2026-11-03', text: SECRET, categoryId: 'c1',
    }), true);
    privatKey = familyKey('fnote', C.papa.forStore.memberId, id);
    assert.equal(C.papa.store.familyLevelOf(privatKey), 'privat',
      'NON-VACUITY: the entry really is Privat, in its own truth register');
    sharedUuid = newUuid();
    await publishSharedEntry(C, C.papa, sharedUuid, { 'pub.text': SHARED });
    await C.papa.engine.syncNow();
  });

  // From here on, every byte Eve's client receives is kept.
  const heard = recording(C.eve);
  const heard2 = recording(C.eve2);

  await t.test('§1a · the control — Eve really can read what Papa SHARED', async () => {
    await on(C.eve, async () => {
      await C.eve.engine.syncNow();
      const board = boardOf(C, C.eve);
      assert.ok(board.some((nn) => nn.text === SHARED),
        `NON-VACUITY: the shared entry is on Eve's board, so "zero bytes" below is a fact about `
        + `the boundary and not about a broken rig: ${JSON.stringify(board.map((x) => x.text))}`);
      assert.equal(board.some((nn) => nn.text === SECRET), false);
    });
  });

  await t.test(
    '§1b · FAILED — a SECOND membership of the same circle is worth zero bytes',
    async () => {
      assert.equal((await join(C, C.eve2, { inviter: C.eve })).status, 200);
      await refreshRoster(C);
      // D9's waiting state is real: the sybil holds no key until a member device delivers one.
      // Eve delivers to herself, through the shipped path — which is the whole point of "any
      // existing member device, not only the admin's".
      await on(C.eve, async () => {
        const d = await C.eve.engine.keys.deliver({ reason: 'sybil' });
        assert.equal(d.verdict, 'delivered', JSON.stringify(d));
      });
      await refreshRoster(C);
      await bring(C, C.eve2);
      await on(C.eve2, async () => {
        await C.eve2.engine.syncNow();
        const board = boardOf(C, C.eve2);
        assert.equal(board.some((nn) => nn.text === SECRET), false,
          'the sybil sees exactly what one member sees, because the space key is the space key');
      });
      // And the relay never had it to give: pull the WHOLE family stream, raw.
      const raw = await C.eve2.transport.request(
        'GET', '/api/v1/ops', { space: C.spaceId, since: '0', limit: '500' }, undefined, {});
      assert.equal(raw.status, 200);
      assert.equal(JSON.stringify(raw.json).includes(SECRET), false,
        'zero bytes of the Privat entry in the entire ciphertext stream');
    });

  await t.test(
    '§1c · FAILED — purging the founder yields ciphertext and a member list, and nothing else',
    async () => {
      const seen = await C.eve.transport.request(
        'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined, {});
      const proof = await mintProof(C.eve2, {
        act: 'member.remove', spaceId: C.spaceId,
        target: C.papa.forStore.memberId, epoch: seen.json.currentEpoch,
      });
      const res = await C.eve.transport.request('POST', '/api/v1/members/remove', undefined, {
        spaceId: C.spaceId, memberId: C.papa.forStore.memberId, adminProof: proof,
      }, {});
      assert.equal(res.status, 200, 'the DENIAL half succeeds — see e6-gate-removal §1d');
      assert.ok(res.json.purgedOps > 0, `${res.json.purgedOps} of Papa's ops destroyed`);
      // Destroyed, not disclosed. The response says HOW MANY and never WHAT.
      assert.equal(JSON.stringify(res.json).includes(SECRET), false);
      assert.equal(JSON.stringify(res.json).includes(SHARED), false,
        'not even the entry she could already read is echoed back in plaintext');
    });

  await t.test(
    '§1d · FAILED — and after the whole circle is emptied, every byte she ever heard is clean',
    async () => {
      await C.eve.transport.request('POST', '/api/v1/members/remove', undefined, {
        spaceId: C.spaceId, memberId: C.mama.forStore.memberId,
      }, {});
      await C.eve.transport.request('POST', '/api/v1/members/remove', undefined, {
        spaceId: C.spaceId, memberId: C.eve2.forStore.memberId,
      }, {});
      const out = await C.eve.transport.request('POST', '/api/v1/members/leave', undefined, {
        spaceId: C.spaceId,
      }, {});
      assert.equal(out.json.spaceDeleted, true);

      const all = JSON.stringify([...heard, ...heard2]);
      assert.ok(all.length > 4000, `NON-VACUITY: ${all.length} bytes were actually recorded`);
      assert.equal(all.includes(SECRET), false,
        'ZERO BYTES of the Privat entry across every response two identities ever received');
      assert.ok(all.includes(SHARED) === false,
        'and the SHARED entry is only ever on the wire as ciphertext, never as text');
      // The relay held the shared entry the whole time and never rendered it, which is the
      // difference between "Eve cannot read it" (false — she is a member) and "the RELAY cannot".
      const anyText = /Vorstellungsgespraech|Arzttermin|Omas /.test(all);
      assert.equal(anyText, false);
    });
});
