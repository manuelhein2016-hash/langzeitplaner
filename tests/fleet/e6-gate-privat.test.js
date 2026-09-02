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

async function mintProof(signer, presenter, terms) {
  const sig = new Uint8Array(await S.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signer.recovery.recSig.privateKey,
    TE.encode(adminProofString({ ...terms, presenter: presenter.forStore.memberId }))));
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
      const proof = await mintProof(C.eve2, C.eve, {
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
      // T5-M3 (round 2): the founder is a tombstone by now — §1c purged Papa — so the anchor no
      // longer names a live member and EVERY removal here takes a second member row. Eve is
      // holding one: `C.eve2` is the sybil identity §1b redeemed and §1c already co-signed with.
      // That is the finding, not a fix to it, and this row is not where it gets closed; what
      // this row asserts is unchanged and is about BYTES, not about who may remove whom.
      const ep = (await C.eve.transport.request(
        'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined, {})).json.currentEpoch;
      const pf = (target) => mintProof(C.eve2, C.eve, {
        act: 'member.remove', spaceId: C.spaceId, target, epoch: ep,
      });
      await C.eve.transport.request('POST', '/api/v1/members/remove', undefined, {
        spaceId: C.spaceId,
        memberId: C.mama.forStore.memberId,
        adminProof: await pf(C.mama.forStore.memberId),
      }, {});
      await C.eve.transport.request('POST', '/api/v1/members/remove', undefined, {
        spaceId: C.spaceId,
        memberId: C.eve2.forStore.memberId,
        adminProof: await pf(C.eve2.forStore.memberId),
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

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · ROUND 3 — THE BOUNDARY, RE-ATTACKED FROM THE REFUSALS THIS ROUND INVENTED
//
// Every round that answers a finding adds error paths, and an error path is a disclosure
// surface: a refusal is a response body, assembled by a handler that is holding the roster, the
// space and the caller's own request. Rounds 1 and 2 measured the boundary across the routes
// that SUCCEED. This measures it across the four refusals that did not exist before this round,
// because "zero bytes" is a claim about what the relay can emit and not about its happy path.
//
//   · `401 bad_signature`   — the presenter binding, T5-M4/N-3 (a proof minted for somebody else)
//   · `400 admin_proof_target_already_removed` — T5-M4/N-4 (a spent proof)
//   · `400 space_full`      — T5-M2's MAX_LIVE_MEMBERS (the sybil ceiling)
//   · `403 admin_proof_required` — T5-M3 (the founder-less anchor), which now carries TWO new
//     prose fields, `checks` and `doesNotCheck` — the demotion strings. Those are the most
//     likely place for a leak in this whole round: they are the only free ENGLISH the gate
//     emits, and free prose next to a roster is how content ends up in an error body.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§2 · the boundary holds across the refusals round 3 invented', async (t) => {
  // Six spare identities, so the sybil ceiling can be reached with real REDEMPTIONS rather than
  // asserted from the constant: `MAX_LIVE_MEMBERS` is authoritative at redeem time.
  const spares = ['s1', 's2', 's3', 's4', 's5', 's6'];
  const C = await buildCircle(['papa', 'mama', 'eve', 'eve2', ...spares]);
  C.colors.eve2 = 'rot';
  spares.forEach((n, i) => { C.colors[n] = `sybil-${i}`; });
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

  await on(C.papa, async () => {
    const id = newUuid();
    assert.equal(C.papa.store.apply('createNoteInline', {
      id, date: '2026-11-03', text: SECRET, categoryId: 'c1',
    }), true);
    assert.equal(C.papa.store.familyLevelOf(familyKey('fnote', C.papa.forStore.memberId, id)),
      'privat', 'NON-VACUITY: the entry really is Privat');
    await publishSharedEntry(C, C.papa, newUuid(), { 'pub.text': SHARED });
    await C.papa.engine.syncNow();
  });

  const heard = recording(C.eve);

  await t.test('§2a · FAILED — four brand-new refusal bodies, and not one byte of the entry',
    async () => {
      assert.equal((await join(C, C.eve2, { inviter: C.eve })).status, 200);
      await refreshRoster(C);

      // 0. THE SYBIL CEILING (T5-M2's MAX_LIVE_MEMBERS). Driven FIRST, while every row is still
      //    live: the ceiling is authoritative at REDEEM time, so it has to be reached by real
      //    redemptions and not asserted off the constant. Eve invites and redeems as fast as she
      //    can; the seat that is refused is the ninth.
      let full = null;
      for (const n of spares) {
        try {
          const r = await join(C, C[n], { inviter: C.eve });
          if (r.status !== 200) { full = r; break; }
        } catch (e) {
          // `join` throws when the COURTESY check at createInvite fires first — also a
          // `space_full` body, also new this round, and equally a thing that must not leak.
          full = { status: 400, json: { reason: 'space_full', viaCreateInvite: String(e.message) } };
          break;
        }
      }
      assert.notEqual(full, null, 'NON-VACUITY: the ceiling was actually reached');
      assert.match(JSON.stringify(full.json), /space_full/,
        `the ninth seat is refused, not sold: ${JSON.stringify(full.json).slice(0, 200)}`);
      const liveNow = (await C.relay.store.listMembers(C.spaceId))
        .filter((m) => (m.removedAt ?? null) === null).length;
      assert.equal(liveNow, 8, 'and the circle stopped at ADR 003 §3.2\'s eight seats');

      const ep = (await C.eve.transport.request(
        'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined, {})).json.currentEpoch;

      // 1. THE PRESENTER BINDING (N-3). A proof Eve's second row minted FOR PAPA, spent by Eve.
      const forPapa = await mintProof(C.eve2, C.papa, {
        act: 'member.remove', spaceId: C.spaceId, target: C.mama.forStore.memberId, epoch: ep,
      });
      const wrongPresenter = await C.eve.transport.request(
        'POST', '/api/v1/members/remove', undefined,
        { spaceId: C.spaceId, memberId: C.mama.forStore.memberId, adminProof: forPapa }, {});
      assert.equal(wrongPresenter.status, 401, JSON.stringify(wrongPresenter.json));

      // 2. THE FOUNDER-LESS ANCHOR (T5-M3) — the 403 that carries `checks`/`doesNotCheck`.
      const forEve = (target) => mintProof(C.eve2, C.eve, {
        act: 'member.remove', spaceId: C.spaceId, target, epoch: ep,
      });
      assert.equal((await C.eve.transport.request('POST', '/api/v1/members/remove', undefined, {
        spaceId: C.spaceId, memberId: C.papa.forStore.memberId,
        adminProof: await forEve(C.papa.forStore.memberId),
      }, {})).status, 200, 'the founder goes, so the anchor stops naming a live member');
      const anchored = await C.eve.transport.request('POST', '/api/v1/members/remove', undefined,
        { spaceId: C.spaceId, memberId: C.mama.forStore.memberId }, {});
      assert.equal(anchored.status, 403, JSON.stringify(anchored.json));
      assert.equal(anchored.json.reason, 'founder_gone_every_removal_needs_second_key');
      assert.ok(typeof anchored.json.checks === 'string' && anchored.json.checks.length > 0,
        'NON-VACUITY: the refusal really does carry free English next to a roster');

      // 3. A SPENT PROOF (N-4) — the same bytes, against a target already removed.
      const spent = await forEve(C.papa.forStore.memberId);
      const replay = await C.eve.transport.request('POST', '/api/v1/members/remove', undefined,
        { spaceId: C.spaceId, memberId: C.papa.forStore.memberId, adminProof: spent }, {});
      assert.equal(replay.status, 400, JSON.stringify(replay.json));
      assert.equal(replay.json.reason, 'admin_proof_target_already_removed');


      // ── AND THE MEASUREMENT ──────────────────────────────────────────────────────────────
      // Every byte Eve's client heard, across the whole of the above.
      const all = JSON.stringify(heard);
      assert.ok(all.length > 2000, `NON-VACUITY: ${all.length} bytes were recorded`);

      // THE POSITIVE CONTROL, and it is the row's own load-bearing half. "Zero bytes of X" is a
      // claim about the boundary only if the same search WOULD have found X. So search the same
      // recorded bytes, the same way, for things the relay really does emit — and require hits.
      // Without this, a recorder that captured nothing and a boundary that leaks nothing are the
      // same green.
      for (const needle of ['space_full', 'admin_proof_target_already_removed',
                            'founder_gone_every_removal_needs_second_key', C.spaceId]) {
        assert.equal(all.includes(needle), true,
          `the search machinery is live: it finds "${needle}", which the relay DID emit`);
      }

      assert.equal(all.includes(SECRET), false,
        'ZERO BYTES of the Privat entry across four refusal bodies that did not exist last round');
      assert.equal(all.includes(SHARED), false,
        'and none of them renders the SHARED entry as text either — the relay never could');
      assert.equal(/Vorstellungsgespraech|Arzttermin|Omas /.test(all), false);

      // The refusals are still refusals: none of them is an oracle that answers a question
      // `GET /spaces/:id/members` does not already answer for this caller, who is a member.
      const bodies = [wrongPresenter.json, anchored.json, replay.json, full.json];
      for (const b of bodies) {
        assert.equal(JSON.stringify(b).includes(SECRET), false);
        assert.equal(JSON.stringify(b).includes('Vorstellungsgespraech'), false);
      }
    });
});
