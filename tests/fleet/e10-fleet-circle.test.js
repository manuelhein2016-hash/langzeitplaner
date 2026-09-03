// FLEET · E10 / LZP-1005 — F15 (Familienkreis) AND F16 (visibility), STORY BY STORY.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE IS FOR
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// LZP-1005's acceptance criterion is the traceability table, not a row count. The 346 fleet rows
// that existed before this ticket were written by ADVERSARIES: each one starts from a threat and
// ends at a verdict, and the stories they touch are the stories those threats happened to cross.
// That leaves whole stories with no scenario at all: on 2026-09-03, EIGHT of F15's and F16's
// thirteen stories — 15.1, 15.2, 15.5, 15.6, 16.3, 16.4, 16.5, 16.6 — were named by no fleet row
// anywhere, and a traceability table that lists their tickets as done is making a claim nobody
// checked on more than one Mac.
//
// So this file walks F15 and F16 story by story and gives each one a scenario that would fail if
// the story regressed. Where a story is already proven by an existing row, it is CITED in the
// section header and not duplicated.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE RIG — reused, not rebuilt (`e6-attack-circle.js` via `e9-attack-kit.js`)
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   THE RELAY      every handler, through `server/core/router.js`, over `adapters/memory.js`.
//   THE TRANSPORT  `platform/net.js#buildRequest` — the shipping client's canonical bytes.
//   THE ENGINE     `sync/family.js#createFamilySync`, one per simulated Mac, driven by `syncNow()`.
//   THE CRYPTO     `crypto/spacekeys.js`, `crypto/envelope.js`, `sync/keys.js`, unmodified.
//   THE DISKS      one `localStorage` image and one `store.js` MODULE EVALUATION per Mac.
//
// ⚠ TRANSPORT DEPENDENCY, STATED RATHER THAN WAITED FOR. `platform/net.js` ships two transports:
// `createFetchTransport` (a real `fetch`) and `createBridgeTransport` (the shell command
// `sync_request`). Neither shell implements `sync_request` yet — `shell-macos/` and `src-tauri/`
// are a parallel workflow's files and that command is being written right now. Every scenario in
// this file therefore runs on the FETCH shape of the transport: `buildRequest` produces the bytes
// and a loopback socket carries them. What that costs is precisely one hop — the shell's
// marshalling of `{url, method, headers, body}` — and nothing else in the chain. These rows are
// assertions about PROPERTIES of the request (its canonical query, its signature, its answer),
// never about lines of `net.js`, so the file that is being edited underneath them can move.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE MUTANTS — one run each, on a scratch copy, naming the row that dies
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   M-C1  `server/core/handlers/invites.js` — BOTH single-use guards removed (the `usedAt`
//         pre-check AND `if (!(await tx.consumeInvite(...)))`)         → §15.5a goes RED
//         ⚠ REMOVING EITHER ONE ALONE LEAVES THE ROW GREEN, and that is a fact about the
//         product rather than about the row: single-use is enforced twice, once as a read and
//         once as an atomic consume inside the transaction. Both mutants were run.
//   M-C2  `server/core/handlers/invites.js` — `INVITE_TTL_MS` multiplied by 5000
//                                                                       → §15.5b goes RED
//   M-C3  `core/materialize.js:foreignCandidate` — `redacted` hard-coded `false`
//                                              → §16.2, §16.3 and §16.7 go RED
//   M-C4  `core/visibility.js:visibilityForNewEntry` — always answers `DEFAULT_VISIBILITY`
//                                                                       → §16.4 goes RED
//   M-C5  `store.js:_exposureCtx` — returns `{}` (no `lastAckedPubLevel`, no `pendingPub`), so
//         the badge reports the FOLDED level                            → §16.6 goes RED
//   M-C6  `core/materialize.js:foreignCandidate` — `memberColorRef` hard-coded `null`
//                                              → §15.6 and §16.7 go RED
//
// The honest-path control is this file green at `28f2a35` with no mutant applied.

import '../helpers/env.js';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { entityUuid as newUuid } from '../../src/js/core/ids.js';
import { familyKey } from '../../src/js/core/ops.js';
import { b64u } from '../../src/js/core/b64.js';
import { visibilityForNewEntry, DEFAULT_VISIBILITY } from '../../src/js/core/visibility.js';
import { planVisibilityChange, exposedLevel, exposurePending } from '../../src/js/family/sharing.js';
import { readMembers, freeMemberColorRef, takenColorRefs } from '../../src/js/family/membersui.js';

import {
  circle, converge, on, buildCircle, found, bring, join, refreshRoster, bootMac,
} from './e9-attack-kit.js';

const S = globalThis.crypto.subtle;

/**
 * `circle()` with SPARE Macs — minted on the SAME relay, with the same real transport, and never
 * joined. §15.5 needs strangers holding a code, and a Mac minted by a second `buildCircle()` call
 * is a Mac on a second relay: its redemption would 403 for a reason that has nothing to do with
 * the invite. This is `e9-attack-kit.js#circle` with two extra lines and no second harness.
 */
async function circleWithSpares(joined, spares) {
  const C = await buildCircle([...joined, ...spares]);
  for (const [i, tag] of spares.entries()) C.colors[tag] = SPARE_TONES[i % SPARE_TONES.length];
  await refreshRoster(C);
  await found(C);
  for (const n of joined.slice(1)) assert.equal((await join(C, C[n])).status, 200, `join ${n}`);
  await refreshRoster(C);
  await on(C.papa, () => C.papa.engine.syncNow());
  for (const n of joined.slice(1)) await bring(C, C[n]);
  await refreshRoster(C);
  for (const n of joined) await on(C[n], () => C[n].engine.syncNow());
  return C;
}

/** Tones no member of a spare-bearing circle holds, so a refusal is never about a colour. */
const SPARE_TONES = ['orange', 'violett', 'tuerkis', 'gold', 'marine', 'schiefer'];

/** One Mac's OWN rendered board — `store.state`, which is what `layout.js` is handed. */
const notesOn = (mac) => mac.store.state.notes;

/** What `mac` can see of the entity `fk`, or `null` when it is not on their board at all. */
const seen = (mac, fk) => notesOn(mac).find((n) => n.entityKey === fk) ?? null;

/** Create one note on `mac` through the shipped mutation, and push it. */
async function makeNote(C, mac, { text, visibility, date = '2026-10-14', categoryId = 'c1' }) {
  const id = newUuid();
  await on(mac, async () => {
    assert.equal(mac.store.apply('createNoteInline', {
      id, date, text, categoryId, visibility,
    }), true, `createNoteInline on ${mac.tag}`);
    await mac.engine.syncNow();
  });
  return { id, fk: familyKey('fnote', mac.forStore.memberId, id) };
}

/** The member's own profile op — story 15.6's only door. */
async function setProfile(C, mac, patch) {
  await on(mac, async () => {
    assert.equal(mac.store.apply('setMyProfile', patch), true, `setMyProfile on ${mac.tag}`);
    await mac.engine.syncNow();
  });
}

/** A fresh invite, minted by `by`, through the real endpoint. */
async function mintInvite(C, by) {
  const proof = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const verifier = new Uint8Array(await S.digest('SHA-256', proof));
  const inviteId = b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const res = await by.transport.request('POST', '/api/v1/invites', undefined, {
    spaceId: C.spaceId, inviteId, verifier: b64u(verifier),
  });
  return { inviteId, proof, res };
}

const redeemBody = async (C, mac, inviteId, proof) => ({
  inviteId,
  proof: b64u(proof),
  colorRef: C.colors[mac.tag] || 'gelb',
  member: {
    memberId: mac.forStore.memberId,
    recoveryPubSig: b64u(new Uint8Array(
      await S.exportKey('raw', mac.recovery.recSig.publicKey))),
    recoveryPubKex: b64u(new Uint8Array(
      await S.exportKey('raw', mac.recovery.recKex.publicKey))),
  },
  device: {
    deviceId: mac.forStore.deviceId,
    deviceShort: mac.forStore.deviceShort,
    sigPubRaw: b64u(new Uint8Array(await S.exportKey('raw', mac.identity.devSig.publicKey))),
    kexPubRaw: b64u(new Uint8Array(await S.exportKey('raw', mac.identity.devKex.publicKey))),
    attestation: mac.myBlob,
  },
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// F15 — FAMILIENKREIS
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('F15 · Familienkreis — the circle, on three Macs', () => {
  let C;

  before(async () => {
    C = await circle(['papa', 'mama', 'oma']);
    await setProfile(C, C.papa, { displayName: 'Papa', colorRef: 'gruen' });
    await setProfile(C, C.mama, { displayName: 'Mama', colorRef: 'blau' });
    await setProfile(C, C.oma, { displayName: 'Oma', colorRef: 'magenta' });
    await converge(C, [C.papa, C.mama, C.oma]);
    await converge(C, [C.papa, C.mama, C.oma]);
  });

  // 15.2 ────────────────────────────────────────────────────────────────────
  // "I create a Familienkreis …, automatically become its admin, and receive a shareable
  //  invite code/link."
  test('§15.2 · the founder is admin in EVERY Mac\'s own fold, not in a server column', async () => {
    for (const m of [C.papa, C.mama, C.oma]) {
      let seat = null;
      await on(m, () => { seat = m.store.familyAdmin(); });
      assert.equal(seat.spaceId, C.spaceId, `${m.tag} adopted the space`);
      assert.equal(seat.admin, C.papa.forStore.memberId,
        `${m.tag} resolves the admin seat to the founder`);
      assert.equal(seat.isMe, m === C.papa, `${m.tag}'s own badge`);
      // ADR 001 §4.1 — the seat is a register the fold wrote, so it names the op that made it.
      assert.equal(typeof seat.headOpId, 'string');
    }
  });

  // 15.3 ────────────────────────────────────────────────────────────────────
  // "Mom joins by pasting the invite code … no email, no password, no registration form."
  // The KEY-DELIVERY half of 15.3 (D9's waiting state) is already proven by
  // `tests/fleet/e6-attack-keydelivery.test.js`; this row is the JOIN REQUEST itself.
  test('§15.3 · the redeem request carries a name, a colour and a device — and no key material', async () => {
    const { inviteId, proof } = await mintInvite(C, C.papa);
    const body = await redeemBody(C, C.mama, inviteId, proof);      // the shape, not a second join

    // What a join is ALLOWED to carry, exhaustively. A field appearing here that is not in this
    // list is a new fact about Mom travelling to the relay, and it has to be argued for.
    assert.deepEqual(Object.keys(body).sort(), ['colorRef', 'device', 'inviteId', 'member', 'proof']);
    assert.deepEqual(Object.keys(body.member).sort(),
      ['memberId', 'recoveryPubSig', 'recoveryPubKex'].sort());
    assert.deepEqual(Object.keys(body.device).sort(),
      ['attestation', 'deviceId', 'deviceShort', 'kexPubRaw', 'sigPubRaw'].sort());

    // D9 — nothing in a join is a WRAP. Every key named above is a PUBLIC key.
    const text = JSON.stringify(body);
    assert.equal(/wrap/i.test(text), false, 'a redeem body never carries a wrap');
    assert.equal(/passw|passphrase|pkcs8/i.test(text), false, 'and never a secret');
    // The invite itself is a code and a proof, and it is the ONLY thing Mom has to type.
    assert.equal(typeof body.inviteId, 'string');
    assert.equal(typeof body.proof, 'string');
  });

  // 15.4 ────────────────────────────────────────────────────────────────────
  // "All members see the member list (name, color, initial)."
  test('§15.4 · all three Macs read the SAME member list — name, colour, initial', async () => {
    const lists = [];
    for (const m of [C.papa, C.mama, C.oma]) {
      await on(m, () => {
        lists.push(readMembers(m.store.registers(), {
          me: m.forStore.memberId,
          adminId: m.store.familyAdmin().admin,
          roster: C.roster,
        }).map((r) => ({
          memberId: r.memberId, displayName: r.displayName, colorRef: r.colorRef,
          initial: r.initial, alive: r.alive, isAdmin: r.isAdmin,
        })));
      });
    }
    // Every Mac agrees about everybody. `isMe` is deliberately excluded — it is the one field
    // that MUST differ, and it is checked in §15.2.
    assert.deepEqual(lists[1], lists[0], 'Mama sees what Papa sees');
    assert.deepEqual(lists[2], lists[0], 'Oma sees what Papa sees');

    const byId = new Map(lists[0].map((r) => [r.memberId, r]));
    assert.equal(byId.size, 3, 'three members');
    assert.deepEqual(
      [...byId.values()].map((r) => `${r.displayName}/${r.colorRef}/${r.initial}`).sort(),
      ['Mama/blau/M', 'Oma/magenta/O', 'Papa/gruen/P']);

    // F15's design note: no two members share a colour, and the join flow's pre-selection is
    // computed from THIS list rather than from a second copy of the rule.
    assert.equal(takenColorRefs(lists[0]).size, 3, 'three distinct tones');
    const free = freeMemberColorRef(lists[0]);
    assert.ok(free && !['gruen', 'blau', 'magenta'].includes(free),
      'the next joiner is offered a tone nobody holds');
  });

  // 15.6 ────────────────────────────────────────────────────────────────────
  // "I can change my display name and color anytime and it propagates to everyone's boards, so
  //  identity stays current without admin involvement."
  test('§15.6 · a rename and a recolour reach every board, with no admin act anywhere', async () => {
    const { fk } = await makeNote(C, C.papa, { text: 'Papas Eintrag', visibility: 'geteilt' });
    await converge(C, [C.mama, C.oma]);
    for (const m of [C.mama, C.oma]) {
      await on(m, () => {
        const e = seen(m, fk);
        assert.equal(e.memberColorRef, 'gruen');
        assert.equal(e.initial, 'P');
      });
    }

    // Papa renames HIMSELF. Nothing the admin does, and Papa is the admin here — so the row is
    // run from Mama as well, who is not.
    await setProfile(C, C.papa, { displayName: 'Vati', colorRef: 'gelb' });
    await setProfile(C, C.mama, { displayName: 'Mami', colorRef: 'rot' });
    await converge(C, [C.papa, C.mama, C.oma]);

    for (const m of [C.mama, C.oma]) {
      await on(m, () => {
        const e = seen(m, fk);
        assert.equal(e.memberColorRef, 'gelb', `${m.tag} sees Papa's new tone`);
        assert.equal(e.initial, 'V', `${m.tag} sees Papa's new initial`);
      });
    }
    // Mama's own rename — a non-admin — reached Oma too.
    await on(C.oma, () => {
      const rows = readMembers(C.oma.store.registers(), { me: C.oma.forStore.memberId });
      const mama = rows.find((r) => r.memberId === C.mama.forStore.memberId);
      assert.equal(mama.displayName, 'Mami');
      assert.equal(mama.colorRef, 'rot');
    });
    // …and put the names back, so the F16 sections read the way their assertions say.
    await setProfile(C, C.papa, { displayName: 'Papa', colorRef: 'gruen' });
    await setProfile(C, C.mama, { displayName: 'Mama', colorRef: 'blau' });
    await converge(C, [C.papa, C.mama, C.oma]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15.5 — the invite's three properties. Its own circle, because §15.5a's redemption really does
// admit a fourth member, and a row that changes the fixture other rows read is a row that will
// be blamed for their failure.
// ─────────────────────────────────────────────────────────────────────────────

describe('F15 · 15.5 — a leaked link cannot haunt the family', () => {
  let C;
  before(async () => { C = await circleWithSpares(['papa', 'mama'], ['s1', 's2', 's3']); });

  test('§15.5a · single-use — the second redemption of a spent code is refused', async () => {
    const { inviteId, proof, res } = await mintInvite(C, C.papa);
    assert.equal(res.status, 200);

    const first = await C.s1.transport.request('POST', '/api/v1/invites/redeem', undefined,
      await redeemBody(C, C.s1, inviteId, proof));
    assert.equal(first.status, 200, 'the first redemption lands');

    const second = await C.s2.transport.request('POST', '/api/v1/invites/redeem', undefined,
      await redeemBody(C, C.s2, inviteId, proof));
    assert.notEqual(second.status, 200, 'the same code cannot admit a second person');
    assert.equal(second.json.error, 'invite_used');
  });

  test('§15.5b · seven days — a code that has aged past its TTL is refused', async () => {
    const { inviteId, proof, res } = await mintInvite(C, C.papa);
    assert.equal(res.status, 200);
    const expiresAt = Date.parse(res.json.expiresAt);
    // 7 days, and the number is the SERVER's — a client does not choose its own TTL.
    assert.equal(expiresAt - res.json.serverTime, 7 * 24 * 60 * 60 * 1000);
    // The relay ages, and so does the client: `cfgFor` reads `relay.ctx.now()`, so this is a week
    // passing for everybody rather than a client lying about the time.
    C.relay.tick((expiresAt - res.json.serverTime) + 1);

    const out = await C.s2.transport.request('POST', '/api/v1/invites/redeem', undefined,
      await redeemBody(C, C.s2, inviteId, proof));
    assert.notEqual(out.status, 200, 'a week-old code is not a door');
    assert.equal(out.json.error, 'invite_invalid');
  });

  test('§15.5c · revocable — the admin can un-make a leaked link before anyone uses it', async () => {
    const { inviteId, proof } = await mintInvite(C, C.papa);
    const openBefore = await C.papa.transport.request(
      'GET', '/api/v1/invites/open', { spaceId: C.spaceId }, undefined);
    assert.equal(openBefore.status, 200);
    assert.equal(openBefore.json.invites.some((i) => i.inviteId === inviteId), true,
      'the admin panel can see it while it is open');

    const rev = await C.papa.transport.request('POST', '/api/v1/invites/revoke', undefined, {
      spaceId: C.spaceId, inviteId,
    });
    assert.equal(rev.status, 200);
    assert.equal(rev.json.state, 'revoked');

    const out = await C.s3.transport.request('POST', '/api/v1/invites/redeem', undefined,
      await redeemBody(C, C.s3, inviteId, proof));
    assert.notEqual(out.status, 200, 'a revoked code admits nobody');

    const open = await C.papa.transport.request(
      'GET', '/api/v1/invites/open', { spaceId: C.spaceId }, undefined);
    assert.equal(open.status, 200);
    assert.equal(open.json.invites.some((i) => i.inviteId === inviteId), false,
      'and it has left the open list');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15.1 — solo mode. Its own rig, because the point is a Mac that never joins.
// ─────────────────────────────────────────────────────────────────────────────

describe('F15 · 15.1 — solo mode is still solo', () => {
  test('§15.1 · a Mac that never joins makes ZERO requests across a whole session', async () => {
    // Two Macs are minted with real transports onto the real relay; only one of them founds
    // anything. `solo` is the product as Mom first meets it.
    const C = await buildCircle(['papa', 'solo']);
    await refreshRoster(C);
    await found(C);
    const solo = C.solo;

    await bootMac(C, solo, false);                    // adopt: false — no `useFamilySpace`
    await on(solo, async () => {
      const s = solo.store;
      assert.equal(s.familySpaceId(), null, 'no Familienkreis');
      assert.equal(s.apply('createNoteInline', {
        id: newUuid(), date: '2026-10-01', text: 'Zahnarzt', categoryId: 'c1',
      }), true);
      assert.equal(s.apply('addCategory', {
        id: 'c2', name: 'Reisen', nameEn: 'Travel', paletteRef: 'blau',
      }), true);
      s.setSettings({ rowHeight: 26 });
      await s.persistNow();
    });

    // And a relaunch over the same disk — the path that would arm a sync engine if anything did.
    await on(solo, async () => {
      const s = solo.store;
      s.listeners.clear();
      s.ready = false;
      s.warnings.length = 0;
      await s.init();
      assert.equal(s.familySpaceId(), null);
      assert.ok(s.state.notes.length >= 2, 'the board came back');
    });

    assert.deepEqual(solo.calls, [],
      '21.5 / 15.1 — in solo mode the app makes zero network requests');
    // The control: the founder on the same relay, in the same process, DID talk.
    assert.ok(C.papa.calls.length > 0, 'the rig can record a request when one happens');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// F16 — VISIBILITY (Privat / Belegt / Geteilt)
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('F16 · visibility — private by default, exposure always visible', () => {
  let C;

  before(async () => {
    C = await circle(['papa', 'mama', 'oma']);
    await setProfile(C, C.papa, { displayName: 'Papa', colorRef: 'gruen' });
    await setProfile(C, C.mama, { displayName: 'Mama', colorRef: 'blau' });
    await converge(C, [C.papa, C.mama, C.oma]);
  });

  // 16.1 ────────────────────────────────────────────────────────────────────
  test('§16.1 · private by default — an entry created with no level reaches nobody', async () => {
    const id = newUuid();
    const fk = familyKey('fnote', C.papa.forStore.memberId, id);
    await on(C.papa, async () => {
      // No `visibility` argument at all: the mutation's own default is the product's answer.
      assert.equal(C.papa.store.apply('createNoteInline', {
        id, date: '2026-10-05', text: 'Bewerbungsgespräch', categoryId: 'c1',
      }), true);
      assert.equal(C.papa.store.state.notes.find((n) => n.id === id).visibility, 'privat');
      await C.papa.engine.syncNow();
    });
    await converge(C, [C.mama, C.oma]);

    for (const m of [C.mama, C.oma]) {
      await on(m, () => {
        assert.equal(seen(m, fk), null, `${m.tag}'s board has no such entry`);
        // and not merely absent from the projection — absent from the LOG.
        assert.equal(m.store.registers().has(fk), false, `${m.tag} holds no register for it`);
        const text = JSON.stringify([...m.store.registers()].map(([k, v]) => [k, [...v]]));
        assert.equal(text.includes('Bewerbungsgespräch'), false,
          `${m.tag} never received the words`);
      });
    }
    // 16.1's second half: the entry pre-dates nothing here, but `n-own` does — it was on the
    // board before any of this and it is still Privat and still nobody else's.
    for (const m of [C.mama, C.oma]) {
      await on(m, () => {
        assert.equal(m.store.state.notes.some((n) => n.text === 'Mein eigener Eintrag' && n.isForeign), false);
      });
    }
  });

  // 16.2 / 16.7 ─────────────────────────────────────────────────────────────
  test('§16.2 · the three levels, end to end, on somebody else\'s Mac', async () => {
    const priv = await makeNote(C, C.papa, { text: 'Therapie', visibility: 'privat', date: '2026-11-03' });
    const bel = await makeNote(C, C.papa, { text: 'Therapie', visibility: 'belegt', date: '2026-11-04' });
    const get = await makeNote(C, C.papa, { text: 'Omas Geburtstag', visibility: 'geteilt', date: '2026-11-05' });
    await converge(C, [C.mama, C.oma]);

    await on(C.mama, () => {
      assert.equal(seen(C.mama, priv.fk), null, 'Privat — only me');

      const b = seen(C.mama, bel.fk);
      assert.ok(b, 'Belegt — the day is visibly taken');
      assert.equal(b.redacted, true);
      assert.equal(b.level, 'belegt');
      assert.equal(b.date, '2026-11-04', 'the duration is deliberately visible');
      assert.equal(b.ownerId, C.papa.forStore.memberId, 'and by whom');
      // 16.7 — "the content deliberately not". Not "empty string": ABSENT.
      assert.equal(Object.hasOwn(b, 'text'), false, 'a Belegt entry has no text field at all');
      assert.equal(JSON.stringify(b).includes('Therapie'), false);

      const g = seen(C.mama, get.fk);
      assert.equal(g.redacted, false);
      assert.equal(g.level, 'geteilt');
      assert.equal(g.text, 'Omas Geburtstag');
    });

    // …and on the BYTES, not only on the projection: the word never entered Mama's log.
    await on(C.mama, () => {
      const all = JSON.stringify([...C.mama.store.registers()].map(([k, v]) => [k, [...v]]));
      assert.equal(all.includes('Therapie'), false,
        'ADR 004 — the redaction happens at the author, so the word is not on the wire');
    });
  });

  // 16.3 ────────────────────────────────────────────────────────────────────
  test('§16.3 · the three-state control, driven through `planVisibilityChange`, lands each time', async () => {
    const { id, fk } = await makeNote(C, C.papa, { text: 'Wanderung', visibility: 'privat', date: '2026-11-10' });
    await converge(C, [C.mama]);
    await on(C.mama, () => assert.equal(seen(C.mama, fk), null));

    const step = async (level, expect) => {
      await on(C.papa, async () => {
        const mine = C.papa.store.state.notes.find((n) => n.id === id);
        const plan = planVisibilityChange(mine, level);
        assert.ok(plan, `the control offers ${mine.visibility} → ${level}`);
        C.papa.store.txn('sichtbarkeit', (tx) => { tx.note(id).set(plan.patch); });
        await C.papa.engine.syncNow();
      });
      await converge(C, [C.mama]);
      await on(C.mama, () => {
        const e = seen(C.mama, fk);
        if (expect === null) { assert.equal(e, null, `${level} → gone from Mama's board`); return; }
        assert.equal(e.level, expect);
        assert.equal(e.redacted, expect === 'belegt');
      });
    };

    await step('belegt', 'belegt');
    await step('geteilt', 'geteilt');
    await step('belegt', 'belegt');          // 16.5 — a downgrade takes the details away again
    await step('privat', null);              // …and the whole entry

    // The decline protocol: asking for the level it already has is not a click.
    await on(C.papa, () => {
      const mine = C.papa.store.state.notes.find((n) => n.id === id);
      assert.equal(planVisibilityChange(mine, 'privat'), null);
    });
  });

  // 16.4 ────────────────────────────────────────────────────────────────────
  // The WIRING of this rule into the create gesture is `interact.js`'s one line
  // (`defaultVisibilityOf`) and is a DOM concern — `tests/tier2/sharing-control.dom.js`. What a
  // fleet row can prove is the CONSEQUENCE: a note created under a Geteilt-default category is on
  // Mama's board without anybody having touched a visibility control.
  test('§16.4 · a category default carries a new entry to the family with zero extra clicks', async () => {
    await on(C.papa, async () => {
      assert.equal(C.papa.store.apply('addCategory', {
        id: 'c-fam', name: 'Familie', nameEn: 'Family', paletteRef: 'gelb',
        defaultVisibility: 'geteilt',
      }), true);
      assert.equal(C.papa.store.apply('addCategory', {
        id: 'c-arzt', name: 'Arzt', nameEn: 'Doctor', paletteRef: 'rot',
      }), true);
      await C.papa.engine.syncNow();
    });

    let famLevel = null; let arztLevel = null;
    await on(C.papa, () => {
      famLevel = visibilityForNewEntry(C.papa.store.category('c-fam'));
      arztLevel = visibilityForNewEntry(C.papa.store.category('c-arzt'));
    });
    assert.equal(famLevel, 'geteilt', 'the category states the default');
    assert.equal(arztLevel, DEFAULT_VISIBILITY, 'and the global default stays private');
    assert.equal(DEFAULT_VISIBILITY, 'privat');

    const shared = await makeNote(C, C.papa, {
      text: 'Sommerfest', visibility: famLevel, categoryId: 'c-fam', date: '2026-12-01',
    });
    const quiet = await makeNote(C, C.papa, {
      text: 'MRT', visibility: arztLevel, categoryId: 'c-arzt', date: '2026-12-02',
    });
    await converge(C, [C.mama]);

    await on(C.mama, () => {
      assert.equal(seen(C.mama, shared.fk).text, 'Sommerfest');
      assert.equal(seen(C.mama, quiet.fk), null);
    });

    // A3 — the category itself is NEVER synced. Mama has no `c-fam`.
    await on(C.mama, () => {
      assert.equal(C.mama.store.state.categories.some((c) => c.id === 'c-fam'), false,
        'A3 — categories remain a private organisational system');
    });
  });

  // 16.6 ────────────────────────────────────────────────────────────────────
  // "My shared and busy entries carry a small badge ON MY OWN BOARD, so I always see my exposure
  //  at a glance." ADR 004 §6: the badge must never promise a privacy state that has not yet
  //  reached the server.
  test('§16.6 · the exposure badge reports what the family CAN see, never my local intent', async () => {
    const { id, fk } = await makeNote(C, C.papa, {
      text: 'Elternabend', visibility: 'geteilt', date: '2026-12-10',
    });
    await converge(C, [C.mama]);

    await on(C.papa, () => {
      const mine = C.papa.store.state.notes.find((n) => n.id === id);
      assert.deepEqual(mine.exposure, { level: 'geteilt', pending: false },
        'settled: the badge says Geteilt and nothing is in flight');
      assert.equal(exposedLevel(mine), 'geteilt');
      assert.equal(exposurePending(mine), false);
    });

    // A downgrade the user has made and the network has NOT yet carried.
    await on(C.papa, () => {
      const mine = C.papa.store.state.notes.find((n) => n.id === id);
      const plan = planVisibilityChange(mine, 'privat');
      assert.equal(plan.downgrade, true);
      C.papa.store.txn('sichtbarkeit', (tx) => { tx.note(id).set(plan.patch); });

      const after = C.papa.store.state.notes.find((n) => n.id === id);
      assert.equal(after.visibility, 'privat', 'my intent is recorded');
      assert.equal(after.exposure.pending, true, 'and the badge says it has not landed');
      assert.equal(after.exposure.level, 'geteilt',
        'the badge still reports the HIGHER level — it never under-reports what Mama can see');
      assert.equal(exposedLevel(after), 'geteilt');
    });
    // And Mama, who has not synced, does still see it. The badge was telling the truth.
    await on(C.mama, () => assert.equal(seen(C.mama, fk).text, 'Elternabend'));

    await on(C.papa, () => C.papa.engine.syncNow());
    await converge(C, [C.mama]);
    await on(C.papa, () => {
      const settled = C.papa.store.state.notes.find((n) => n.id === id);
      assert.deepEqual(settled.exposure, { level: 'privat', pending: false });
    });
    await on(C.mama, () => assert.equal(seen(C.mama, fk), null, '16.5 — and it is gone'));
  });

  // 16.7 ────────────────────────────────────────────────────────────────────
  test('§16.7 · Belegt leaks existence, owner and duration BY CHOICE — and nothing else', async () => {
    const id = newUuid();
    const fk = familyKey('fbar', C.papa.forStore.memberId, id);
    await on(C.papa, async () => {
      assert.equal(C.papa.store.apply('createBar', {
        id, startDate: '2027-02-08', endDate: '2027-02-19', categoryId: 'c1', visibility: 'belegt',
      }), true);
      C.papa.store.txn('label', (tx) => { tx.bar(id).set({ label: 'Kur Bad Ems' }); });
      await C.papa.engine.syncNow();
    });
    await converge(C, [C.mama]);

    await on(C.mama, () => {
      const b = C.mama.store.state.bars.find((x) => x.entityKey === fk);
      assert.ok(b, '"I am away, do not plan with me" works without explanation');
      assert.equal(b.redacted, true);
      assert.equal(b.startDate, '2027-02-08');
      assert.equal(b.endDate, '2027-02-19');           // the duration, deliberately
      assert.equal(b.ownerId, C.papa.forStore.memberId);
      assert.equal(b.memberColorRef, 'gruen');          // whose, deliberately
      assert.equal(b.initial, 'P');
      assert.equal(Object.hasOwn(b, 'label'), false, 'the content, deliberately not');
      assert.equal(Object.hasOwn(b, 'categoryId'), false,
        'and not the category either — that would leak a shape of the content');
      assert.equal(JSON.stringify(b).includes('Bad Ems'), false);
    });
  });
});
