// FLEET · T5 — READING ANOTHER MEMBER'S PRIVAT ENTRY, AND THE TWO ENGINES OVER ONE DISK.
// Story 21.2 · 20.5 · ADR 002 §0 T5 · §3 barrier 2 · §11 rule 10 · ADR 004 §2.2 barriers 2–4 ·
// ADR 003 §8.2 · ADR 006 §9.1 · findings R8-4, P-8.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE PROMISE, AND THE FIVE ROUTES THE NEW ENGINE OPENED
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// 21.2: no family key may ever apply to a personal entry, and no Privat entry may ever leave the
// Mac that authored it. Until this epic there was one engine and one space, so the promise was
// kept by there being nothing to mix up. There are now two engines, two rings, two outboxes and
// two cursors in one process, and every one of them is a place a scope could slip.
//
// The five routes named, and driven, one row each:
//
//   a  a MIS-SCOPED PUBLISH        — a `pub.set` for an entity whose truth register says `privat`
//   b  a FOREIGN PUBLISH           — a `pub.set` for somebody else's entity key
//   c  a PERSONAL ENVELOPE in a FAMILY BATCH
//   d  a CURSOR CROSSING SPACES
//   e  a FAMILY KEY on a PERSONAL ENVELOPE (and the mirror)
//
// Every one of them is **FAILED** below, and each row says which barrier said no, because "it
// held" is only worth reading if it names the thing that held.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 — WHAT DID NOT HOLD, AND WHAT NOW DOES: TWO ENGINES, ONE DISK
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The rings, the outboxes and the transport cursors are correctly per space. **Two durable slots
// are not, and cannot be** — they are one list and one map for the DEVICE:
//
//     const LS_RING   = (spaceId) => `langzeitplaner.ring.${spaceId}`;     ← per space
//     const LS_PEERS  = (spaceId) => `langzeitplaner.peers.${spaceId}`;    ← per space
//     const LS_SEALED = 'langzeitplaner.sealed';                           ← keyed per space by
//     const LS_PARKED = 'langzeitplaner.parked';                           ← ONE KEY
//     const LS_CHAIN  = 'langzeitplaner.chainheads';                       ← ONE KEY
//
// and BOTH `startEngine` (personal) and `startFamilyEngine` (family) construct
// `parkedEnvelopeStore()` and `chainHeadStore()` over them. Each engine builds its own
// `createParkingLot` / `createCursors`. **Before the fix each loaded the WHOLE slot and wrote the
// WHOLE slot back from its own in-memory copy** — two writers, one file, no merge — and the three
// rows below measured what that cost: a shelved personal envelope destroyed by an ordinary family
// park (§2b), the personal engine's cursor stalled by a family backlog it can never cure (§2c),
// and the personal space's chain anchor deleted by an ordinary family pull (§2d).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE FIX, AND WHERE IT DELIBERATELY DOES NOT LIVE
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// The slots stay device-wide. What changed is that **each port now DECLARES the space it is a
// slice of** (`space: spaceId`, `family/engine.js`), and the two modules that own the data act on
// it — which is the half a test can hold, because it is the half that holds for every caller and
// not only for the two ports this one file happens to build:
//
//   · `sync/outbox.js#createParkingLot` — `load()` adopts only its own space's rows and holds the
//     rest ASIDE verbatim; `persist()` RE-READS the slot and writes the other engine's rows back
//     untouched; and the cap is counted PER SPACE, because `park()`'s `false` stalls a cursor.
//   · `sync/cursor.js#createCursors` — `load()` adopts only its own space's record; every write
//     re-reads the map and replaces only its own key. `forget()` still deletes.
//
// Fixing it in the PORT instead would have been shorter and would have been vacuous here: this
// file builds its own copies of the two ports (below), so a mutation of `family/engine.js` would
// not have reached a single assertion. The rows drive the product's own `createParkingLot` and
// `createCursors` through ports shaped exactly like the shipped ones, and §2a pins by source that
// the shipped ones declare a space at both call sites.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE MUTANTS — one run each, in a scratch copy of the tree
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   M-E   `sync/outbox.js` — `persist()` writes its own rows over the slot instead of re-reading
//         it and carrying the FOREIGN-space rows through.                             → §2b
//   M-E2  `sync/outbox.js` — `load()` ignores `storage.space` and adopts every space's rows. → §2c
//   M-F   `sync/outbox.js` — the cap counts every row in the lot, not this space's.    → §2f
//   M-G   `sync/cursor.js` — the write path replaces the stored map with its own snapshot
//         instead of merging its key into it.                                         → §2d
//   M-G2  `sync/cursor.js` — `load()` ignores `storage.space` and adopts every space's record,
//         so a launch-time copy of the other engine's anchor is written back over it. → §2g
//   M-E3  `sync/outbox.js` — `persist()` `await`s the re-read unconditionally, re-opening the
//         microtask window between the read and the write of the merge.               → §2i
//   M-S   `family/engine.js` — all four call sites build the ports BARE again, so nothing
//         declares a space and every module below silently reverts.                   → §2a
//   M-S2  `family/engine.js` — the two ports are `async` again, so `localStorage`'s synchronous
//         read-modify-write grows a suspension point in the middle of it.              → §2a
//
// §1's rows are all FAILED (the barriers held), so they have no mutant: there is nothing to
// prove can fail. Their non-vacuity control is §1g, which shares an entry successfully on the
// same rig and asserts the Privat one is still absent. §2's own non-vacuity control is §2h: the
// scoping must not have been bought by making a lot or a cursor set stop working for one space,
// which is exactly what every one of these fixes can be faked with.
//

import '../helpers/env.js';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { localStorage as LS } from '../helpers/env.js';
import { entityUuid as newUuid, spaceId as mkSpaceId, opId as mkOpId } from '../../src/js/core/ids.js';
import { openOp, sealOp, brandFamilyPatch, RedactionError } from '../../src/js/crypto/envelope.js';
import { createKeyRing, createSpaceKey, admitWraps, familyRecipients } from '../../src/js/crypto/spacekeys.js';
import { createParkingLot, PARK_CAP } from '../../src/js/sync/outbox.js';
import { createCursors } from '../../src/js/sync/cursor.js';
import { createPersonalSync } from '../../src/js/sync/personal.js';
import { createFamilySync } from '../../src/js/sync/family.js';
import { familyKey } from '../../src/js/core/ops.js';

import {
  buildCircle, join, refreshRoster, bootMac, engineFor, on,
  publishAttestation, publishSharedEntry, boardOf, S,
} from './e6-attack-circle.js';

const ENGINE_SRC = readFileSync(new URL('../../src/js/family/engine.js', import.meta.url), 'utf8');

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

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · CAN EVE READ PAPA'S PRIVAT ENTRY?
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · 21.2 · five routes into a Privat entry, and the barrier that closes each', () => {
  let C = null;
  let privatKey = '';
  let sharedUuid = '';

  before(async () => {
    C = await buildCircle(['papa', 'eve']);
    await refreshRoster(C);
    await found(C);
    assert.equal((await join(C, C.eve)).status, 200);
    await refreshRoster(C);
    await on(C.papa, () => C.papa.engine.syncNow());
    await bring(C, C.eve);
    await refreshRoster(C);

    // Papa has a PRIVAT note. `core/ops.js#createNoteInline` mints `visibility: 'privat'` by default
    // and that register — not a flag, not a filter — is what barrier 4 reads.
    await on(C.papa, async () => {
      const id = newUuid();
      assert.equal(C.papa.store.apply('createNoteInline', {
        id, date: '2026-11-03', text: 'Vorstellungsgespraech', categoryId: 'c1',
      }), true);
      privatKey = familyKey('fnote', C.papa.forStore.memberId, id);
      assert.equal(C.papa.store.familyLevelOf(privatKey), 'privat',
        'NON-VACUITY: the entry really is Privat, in its own truth register');
      sharedUuid = newUuid();
      await C.papa.engine.syncNow();
    });
  });

  test('§1a · FAILED · a mis-scoped publish: Papa\'s own Mac refuses to seal his Privat entry', async () => {
    // The attacker here is any caller — a bug, a future module, a hostile patch — that hands the
    // engine a `pub.set` for an entity the register map calls `privat`.
    const ctx = C.papa.store._ctx();
    const op = Object.freeze({
      v: 1, id: ctx.newOpId(), ts: ctx.mint(), space: C.spaceId,
      act: C.papa.forStore.memberId, dev: C.papa.forStore.deviceId, gid: ctx.gid,
      k: 'pub.set', e: privatKey,
      f: brandFamilyPatch({
        'pub.level': 'geteilt', 'pub.alive': true,
        'pub.date': '2026-11-03', 'pub.text': 'Vorstellungsgespraech',
      }, { kind: 'fnote', level: 'geteilt' }),
    });
    await assert.rejects(
      () => sealOp(op, C.papa.ring, C.papa.identity.devSig.privateKey, {
        v: 1, sp: C.spaceId, ep: C.papa.ring.currentEpoch(C.spaceId),
        dv: C.papa.forStore.deviceShort, oid: op.id, wit: '',
      }, {
        attestation: C.papa.myAttestation,
        assertFamilyPatch: () => {},
        levelOf: (k) => C.papa.store.familyLevelOf(k),   // the engine's own wiring
      }),
      (e) => e instanceof RedactionError && e.barrier === 'barrier4',
      'ADR 004 §2.2 barrier 4 — the level is the register\'s, and a patch may not supply one');
  });

  test('§1b · FAILED · a foreign publish: Eve cannot seal a pub.set for Papa\'s entity', async () => {
    const ctx = C.eve.store._ctx();
    const op = Object.freeze({
      v: 1, id: ctx.newOpId(), ts: ctx.mint(), space: C.spaceId,
      act: C.eve.forStore.memberId, dev: C.eve.forStore.deviceId, gid: ctx.gid,
      k: 'pub.set', e: privatKey,                       // ← PAPA's key, on EVE's Mac
      f: brandFamilyPatch({
        'pub.level': 'geteilt', 'pub.alive': true, 'pub.text': 'Vorstellungsgespraech',
      }, { kind: 'fnote', level: 'geteilt' }),
    });
    assert.equal(C.eve.store.familyLevelOf(privatKey), null,
      'a foreign key has no truth register on this Mac — the honest answer is `null`');
    await assert.rejects(
      () => sealOp(op, C.eve.ring, C.eve.identity.devSig.privateKey, {
        v: 1, sp: C.spaceId, ep: C.eve.ring.currentEpoch(C.spaceId),
        dv: C.eve.forStore.deviceShort, oid: op.id, wit: '',
      }, {
        attestation: C.eve.myAttestation,
        assertFamilyPatch: () => {},
        levelOf: (k) => C.eve.store.familyLevelOf(k),
      }),
      (e) => e instanceof RedactionError && e.barrier === 'barrier4');
  });

  test('§1c · FAILED · a personal envelope offered into the family batch is refused at the wire', async () => {
    const psp = mkSpaceId('personal');
    const bogus = {
      v: 1, sp: psp, ep: 1, dv: C.eve.forStore.deviceShort, oid: mkOpId(),
      wit: '', iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAA', sig: 'AAAA',
    };
    const res = await C.eve.transport.request('POST', '/api/v1/ops', {}, {
      space: C.spaceId, ackSeq: '0', ops: [bogus], drained: true,
    }, {});
    assert.notEqual(res.status, 200, `the relay took it: ${JSON.stringify(res.json)}`);
  });

  test('§1d · FAILED · the two cursors and the two witnesses are per space and refuse each other', () => {
    const psp = mkSpaceId('personal');
    assert.notEqual(C.papa.store.cursor(C.spaceId), undefined);
    assert.equal(C.papa.store.cursor(psp), '0',
      'a space this store never pulled reads 0 — a cursor cannot be read across spaces');
    assert.throws(() => C.papa.engine.witness(psp),
      /family sync: spaceId must be an fsp_/,
      'the family engine will not answer a chain question about a personal space');
    assert.throws(() => createFamilySync({ ...{}, spaceId: psp }), /family sync/);
    assert.throws(() => createPersonalSync({ spaceId: C.spaceId }), /psp_|personal/i);
  });

  test('§1e · FAILED · a family key never reaches a personal envelope, in either direction', async () => {
    const psp = mkSpaceId('personal');
    const personalRing = createKeyRing([[psp, 1, await createSpaceKey()]]);
    const ctx = C.papa.store._ctx();
    // A real, correctly sealed PERSONAL envelope.
    const personalOp = Object.freeze({
      v: 1, id: ctx.newOpId(), ts: ctx.mint(), space: psp,
      act: C.papa.forStore.memberId, dev: C.papa.forStore.deviceId, gid: ctx.gid,
      k: 'note.set', e: `note:${newUuid()}`, f: { text: 'Vorstellungsgespraech' },
    });
    const env = await sealOp(personalOp, personalRing, C.papa.identity.devSig.privateKey, {
      v: 1, sp: psp, ep: 1, dv: C.papa.forStore.deviceShort, oid: personalOp.id, wit: '',
    }, { attestation: C.papa.myAttestation });

    // The FAMILY ring, handed the personal envelope. `KeyRing` is keyed by the FULL space id.
    const withFamilyRing = await openOp(env, C.papa.ring, (dv) => C.attestations.get(dv) ?? null);
    assert.equal(withFamilyRing.status, 'park');
    assert.equal(withFamilyRing.parkReason, 'epoch',
      'there is no key under that space id and there is no fallback to fall back to');
    // NON-VACUITY: the personal ring opens the same bytes.
    const ok = await openOp(env, personalRing, (dv) => C.attestations.get(dv) ?? null);
    assert.equal(ok.status, 'opened');
    assert.equal(ok.op.f.text, 'Vorstellungsgespraech');

    // And the family SENDER SET cannot authorize an admission into a personal space.
    const senders = familyRecipients(C.roster.map((m) => ({
      memberId: m.memberId, recoveryPubSig: m.recoveryPubSig, devices: m.devices,
    })));
    await assert.rejects(
      () => admitWraps(createKeyRing(), [], {
        spaceId: psp, myKexPriv: C.papa.identity.devKex.privateKey, senders,
      }),
      /disjoint by construction|cannot.*authorize/i,
      'ADR 002 §3 barrier 2, on the way IN (finding S1)');
  });

  test('§1f · FAILED · the family outbox never offers a personal op, and vice versa', async () => {
    await on(C.papa, async () => {
      const fam = C.papa.store.familyOutbox({ limit: Infinity });
      for (const line of fam) {
        assert.equal(line.op.space, C.spaceId,
          `a ${line.op.space} op was offered to the family engine`);
      }
      // The personal reader answers for a store that never adopted a personal space.
      assert.deepEqual(C.papa.store.outbox({ limit: Infinity }), [],
        'no personal space adopted, so the personal outbox is empty — the filter is the space id');
    });
  });

  test('§1g · the shared entry Papa DID choose to share is on Eve\'s board — the control', async () => {
    await on(C.papa, async () => {
      await publishSharedEntry(C, C.papa, sharedUuid,
        { 'pub.text': 'Omas Geburtstag', 'pub.date': '2026-11-14' });
    });
    await on(C.eve, () => C.eve.engine.syncNow());
    await on(C.eve, () => {
      const board = boardOf(C, C.eve);
      assert.ok(board.some((n) => n.text === 'Omas Geburtstag'),
        'NON-VACUITY: sharing works on this rig, so "Privat did not arrive" means something');
      assert.equal(board.some((n) => n.text === 'Vorstellungsgespraech'), false,
        'and the Privat entry is not on it');
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · TWO ENGINES, ONE DISK
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The `parkStore` port, exactly as `family/engine.js#parkedEnvelopeStore(spaceId)` builds it —
 * ONE device-wide key, read whole and written whole, plus the one declaration it now carries.
 *
 * It is deliberately as DUMB as the shipped one. Everything the fix does happens on the other
 * side of this port, in `sync/outbox.js`, which is what makes the mutants below reach it.
 */
function parkedEnvelopeStore(spaceId) {
  const KEY = 'langzeitplaner.parked';
  return {
    durable: true,
    space: spaceId,
    // SYNCHRONOUS, exactly as the shipped one is, and §2i is the row that is about it.
    loadRecords() {
      try { const raw = LS.getItem(KEY); return raw ? JSON.parse(raw) : []; } catch { return []; }
    },
    saveRecords(rows) {
      try { LS.setItem(KEY, JSON.stringify(rows)); } catch { /* a full disk is not a crash */ }
    },
  };
}

/** The `chainStore` port, exactly as `family/engine.js#chainHeadStore(spaceId)` builds it. */
function chainHeadStore(spaceId) {
  const KEY = 'langzeitplaner.chainheads';
  return {
    space: spaceId,
    loadCursors() {
      try { const raw = LS.getItem(KEY); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
    },
    saveCursors(all) {
      try { LS.setItem(KEY, JSON.stringify(all)); } catch { /* as above */ }
    },
  };
}

const envFor = (space, ep = 1) => ({
  v: 1, sp: space, ep, dv: 'AAAAAAAAAAA', oid: mkOpId(),
  wit: '', iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAA', sig: 'AAAA',
});

describe('§2 · the durable slots the two engines share, and how they now share them', () => {
  const PSP = mkSpaceId('personal');
  const FSP = mkSpaceId('family');

  test('§2a · the two slots are still one key each, and BOTH engines now DECLARE their space', () => {
    // The slots stay device-wide — that is a fact about the disk, not the defect. What must be
    // true is that neither engine builds a port that does not say which space it is a slice of,
    // because an omitted argument silently restores every one of §2b/§2c/§2d at once.
    assert.match(ENGINE_SRC, /const LS_PARKED = 'langzeitplaner\.parked';/);
    assert.match(ENGINE_SRC, /const LS_CHAIN = 'langzeitplaner\.chainheads';/);
    assert.match(ENGINE_SRC, /const LS_RING = \(spaceId\) =>/, 'the ring IS per space — for contrast');

    // The factories take a space and publish it. `space:` is what `sync/outbox.js` and
    // `sync/cursor.js` read; a factory that took the id and did not publish it would be a no-op.
    assert.match(ENGINE_SRC, /function parkedEnvelopeStore\(spaceId\) \{[\s\S]*?space: spaceId,/);
    assert.match(ENGINE_SRC, /function chainHeadStore\(spaceId\) \{[\s\S]*?space: spaceId,/);

    // INVERTED. Both call sites — `startEngine` (personal) and `startFamilyEngine` (family) —
    // pass a space id, and NEITHER calls the factory bare. The zero-argument spelling is the
    // whole of the old behaviour, so it is asserted absent rather than merely outnumbered.
    assert.equal((ENGINE_SRC.match(/parkedEnvelopeStore\(\s*\)/g) || []).length, 0,
      'no engine may build an unscoped parked-envelope store');
    assert.equal((ENGINE_SRC.match(/chainHeadStore\(\s*\)/g) || []).length, 0,
      'no engine may build an unscoped chain-head store');
    assert.equal((ENGINE_SRC.match(/parkStore: parkedEnvelopeStore\([A-Za-z][\w.]*\)/g) || []).length, 2,
      'both engines scope the parked-envelope slot');
    assert.equal((ENGINE_SRC.match(/chainStore: chainHeadStore\([A-Za-z][\w.]*\)/g) || []).length, 2,
      'both engines scope the chain-head slot');
    assert.match(ENGINE_SRC, /parkStore: parkedEnvelopeStore\(armed\.cfg\.spaceId\)/, 'the personal one');
    assert.match(ENGINE_SRC, /parkStore: parkedEnvelopeStore\(circle\.spaceId\)/, 'the family one');
    assert.match(ENGINE_SRC, /chainStore: chainHeadStore\(armed\.cfg\.spaceId\)/, 'the personal one');
    assert.match(ENGINE_SRC, /chainStore: chainHeadStore\(circle\.spaceId\)/, 'the family one');

    // INVERTED, second half — see §2i. A merge is a read-modify-write, and an `async` port puts
    // a microtask boundary in the middle of one. `localStorage` is synchronous; these two ports
    // must not pretend otherwise, or the certain data loss is traded for an intermittent one.
    const parkBody = ENGINE_SRC.slice(ENGINE_SRC.indexOf('function parkedEnvelopeStore('));
    const chainBody = ENGINE_SRC.slice(ENGINE_SRC.indexOf('function chainHeadStore('));
    assert.match(parkBody.slice(0, 900), /\n    loadRecords\(\) \{/,
      'the parked-envelope read is synchronous');
    assert.match(parkBody.slice(0, 900), /\n    saveRecords\(rows\) \{/,
      'and so is the write — the two must be one uninterruptible step');
    assert.match(chainBody.slice(0, 900), /\n    loadCursors\(\) \{/);
    assert.match(chainBody.slice(0, 900), /\n    saveCursors\(all\) \{/);
    assert.equal(/async (loadRecords|saveRecords)\(/.test(parkBody.slice(0, 900)), false,
      'no `async` on the parked-envelope port');
    assert.equal(/async (loadCursors|saveCursors)\(/.test(chainBody.slice(0, 900)), false,
      'no `async` on the chain-head port');

    // And the file still says the seam is owed — to `storage.js`, for a different reason.
    assert.match(ENGINE_SRC, /OWED to `storage\.js`'s owner/);
  });

  test('§2b · FAILED · the family lot cannot destroy the personal engine\'s shelved envelopes', async () => {
    LS.clear();
    // The personal engine's lot, with one envelope it gave up on. R8-4: "not replayed is not
    // destroyed" — the bytes are SHELVED, out of the replay set, retained for ever, and a
    // relaunch gives them `PARK_REVIVALS` more chances. The shelf is the only copy on this Mac.
    // R8-4 held per lot; the question here is whether it holds per DISK.
    const p2 = createParkingLot({ storage: parkedEnvelopeStore(PSP), now: () => 1 });
    const f2 = createParkingLot({ storage: parkedEnvelopeStore(FSP), now: () => 1 });
    await p2.load();
    await f2.load();                            // both loaded at launch, both hold []
    const ghost = envFor(PSP);
    assert.equal(await p2.park(PSP, ghost, '7', 'attestation'), true);
    await p2.refuse(PSP, [ghost.oid]);          // ← retained for ever, says R8-4
    assert.equal(p2.shelved(PSP).length, 1, 'NON-VACUITY: the bytes really are on the shelf');

    await f2.park(FSP, envFor(FSP), '3', 'epoch');   // ← one ordinary family park

    // A relaunch: whatever is on disk is what this Mac has.
    const after = createParkingLot({ storage: parkedEnvelopeStore(PSP), now: () => 1 });
    await after.load();
    assert.equal(after.shelved(PSP).length + after.parked(PSP).length, 1,
      'THE FIX: the personal engine\'s retained envelope survived a family park. `persist()` '
      + 're-reads the slot and writes the OTHER space\'s rows back untouched, so R8-4\'s '
      + '"not replayed is not destroyed" now holds per DISK and not only per lot.');
    // On the RELAUNCH the shelf row is revived into the replay set — that is R8-4's cure
    // condition doing exactly what it exists to do — so look in both lists for it.
    assert.deepEqual(
      [...after.parked(PSP), ...after.shelved(PSP)].map((r) => r.oid), [ghost.oid],
      'and it is the same envelope, byte for byte');
    assert.equal(after.diagnostics().revived, 1, 'revived by the relaunch, as R8-4 promises');

    // The family row is not collateral of the fix: BOTH survive, which is the whole point of a
    // merge as against either engine simply winning.
    const alsoAfter = createParkingLot({ storage: parkedEnvelopeStore(FSP), now: () => 1 });
    await alsoAfter.load();
    assert.equal(alsoAfter.parked(FSP).length, 1, 'the family envelope survived too');

    // And the reverse direction, because a merge that only works one way is a coin toss that
    // happened to land: the PERSONAL engine's write must not destroy the family engine's shelf.
    const fGhost = envFor(FSP);
    await f2.park(FSP, fGhost, '9', 'attestation');
    await f2.refuse(FSP, [fGhost.oid]);
    await p2.park(PSP, envFor(PSP), '8', 'epoch');
    const back = createParkingLot({ storage: parkedEnvelopeStore(FSP), now: () => 1 });
    await back.load();
    assert.equal([...back.parked(FSP), ...back.shelved(FSP)].some((r) => r.oid === fGhost.oid), true,
      'the family engine\'s shelf survives a personal park — the merge is symmetric');
  });

  test('§2c · FAILED · the personal lot does not adopt the family space\'s undecryptable backlog', async () => {
    LS.clear();
    // A small cap, because the shape is the finding and 10 000 rows is the same shape. The
    // product's cap is `PARK_CAP`; what matters is what it is counted OVER.
    assert.equal(PARK_CAP, 10000, 'the product\'s cap, for the record');
    const cap = 4;
    const family = createParkingLot({ storage: parkedEnvelopeStore(FSP), now: () => 1, cap });
    await family.load();
    for (let i = 0; i < cap; i++) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal(await family.park(FSP, envFor(FSP), String(i + 1), 'epoch'), true);
    }
    assert.equal(family.parked(FSP).length, cap, 'NON-VACUITY: the family lot really is full');

    // The personal engine starts (or relaunches) and reads the same slot.
    const personal = createParkingLot({ storage: parkedEnvelopeStore(PSP), now: () => 1, cap });
    await personal.load();
    assert.equal(personal.parked(FSP).length, 0,
      'THE FIX: it did NOT adopt the other engine\'s rows. The lot is per PROCESS and the slot is '
      + 'per DISK, so a lot that adopts everything counts somebody else\'s undecryptable backlog '
      + 'against its own cap, offers it to its own replay, and names the wrong space when it stalls.');
    assert.equal(personal.diagnostics().scope, PSP, 'and it says which space it owns');
    assert.equal(personal.diagnostics().foreign, cap, 'and how many rows it is carrying for the other');

    const mine = await personal.park(PSP, envFor(PSP), '1', 'attestation');
    assert.equal(mine, true,
      '`park()` returns true, so the caller may advance the cursor. A family space nobody can '
      + 'decrypt no longer stalls the PERSONAL space\'s sync.');

    // And the family lot's rows are still there afterwards — the personal park merged, it did not
    // win. Without this the row would pass by having destroyed the thing it was protecting.
    const after = createParkingLot({ storage: parkedEnvelopeStore(FSP), now: () => 1, cap });
    await after.load();
    assert.equal(after.parked(FSP).length, cap, 'all four family envelopes are still on disk');
  });

  test('§2d · FAILED · the family engine cannot delete the personal space\'s chain anchor', async () => {
    LS.clear();
    // Both engines start. Each `createCursors` now loads only its own record and merges its own
    // key on write.
    const personal = createCursors({ storage: chainHeadStore(PSP) });
    const family = createCursors({ storage: chainHeadStore(FSP) });
    await personal.load();
    await family.load();

    // The personal engine verifies its way up to seq 100 and earns `fromGenesis`.
    await personal.advance(PSP, '100', { seq: '100', chain: 'AAAA' }, async () => {}, { fromGenesis: true });
    assert.deepEqual(personal.head(PSP), { seq: '100', chain: 'AAAA' });
    assert.equal(personal.fromGenesis(PSP), true);

    // The family engine then advances its OWN cursor — an ordinary pull, nothing hostile.
    await family.advance(FSP, '5', { seq: '5', chain: 'BBBB' }, async () => {});

    // Relaunch.
    const after = createCursors({ storage: chainHeadStore(PSP) });
    await after.load();
    assert.deepEqual(after.head(PSP), { seq: '100', chain: 'AAAA' },
      'THE FIX: the personal space\'s verified chain head survived an ordinary family pull. The '
      + 'write merges this space\'s key into the stored map instead of replacing the map with a '
      + 'snapshot that never had the other engine\'s row in it.');
    assert.equal(after.fromGenesis(PSP), true,
      'and `fromGenesis` — the right to call an unknown witness a fork — survived with it');

    const alsoAfter = createCursors({ storage: chainHeadStore(FSP) });
    await alsoAfter.load();
    assert.deepEqual(alsoAfter.head(FSP), { seq: '5', chain: 'BBBB' }, 'the family anchor is there too');

    // `forget()` must still DELETE through the merge — 20.3/20.4, a space this Mac has left. A
    // merge that could not delete would be the opposite defect and would look exactly like a fix.
    await family.forget(FSP);
    const gone = createCursors({ storage: chainHeadStore(FSP) });
    await gone.load();
    assert.equal(gone.head(FSP), null, 'a forgotten space is gone from the slot');
    const survived = createCursors({ storage: chainHeadStore(PSP) });
    await survived.load();
    assert.deepEqual(survived.head(PSP), { seq: '100', chain: 'AAAA' },
      'and forgetting the family space did not take the personal anchor with it');
  });

  test('§2f · the cap is counted PER SPACE, so one space can never stall another', async () => {
    // The second line of defence, and the only one an UNSCOPED lot has. `sync/outbox.js` is used
    // by callers that build their own ports — `tests/helpers/fleet.js` does — and a lot that
    // holds two spaces because nobody told it otherwise must still bound them separately.
    // `park()` returning `false` means "do not advance the cursor", i.e. it stalls a SPACE; a cap
    // counted over every row lets a backlog in one space stop sync in another.
    const cap = 4;
    const lot = createParkingLot({ now: () => 1, cap });   // no storage, no scope declared
    await lot.load();
    assert.equal(lot.diagnostics().scope, null, 'NON-VACUITY: this lot is deliberately unscoped');
    for (let i = 0; i < cap; i++) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal(await lot.park(FSP, envFor(FSP), String(i + 1), 'epoch'), true);
    }
    assert.equal(await lot.park(FSP, envFor(FSP), '5', 'epoch'), false,
      'the family space is at its cap and stalls — that half is unchanged (F-6)');
    assert.equal(await lot.park(PSP, envFor(PSP), '1', 'attestation'), true,
      'THE FIX: the personal space has its own bound and is not stalled by somebody else\'s '
      + 'backlog. The disk cost is unchanged in kind: `cap` per space, and a Mac belongs to two.');
    assert.equal(lot.overflowed, 1, 'and exactly one refusal was counted, for the space that earned it');
  });

  test('§2g · a launch-time copy of the other engine\'s anchor cannot be written back over it', async () => {
    LS.clear();
    // The failure a merge INTRODUCES if it is bolted on without the read-side scope: an instance
    // that adopted every record at launch would carry a stale copy of the other engine's anchor
    // and write it back on its next advance — a ROLLBACK, which is strictly worse than the
    // deletion §2d measured, because a rolled-back head looks like a valid one.
    const personal = createCursors({ storage: chainHeadStore(PSP) });
    await personal.load();
    await personal.advance(PSP, '100', { seq: '100', chain: 'AAAA' }, async () => {}, { fromGenesis: true });

    // The family engine launches now — after the personal anchor already exists on disk.
    const family = createCursors({ storage: chainHeadStore(FSP) });
    await family.load();
    assert.equal(family.head(PSP), null,
      'it did not adopt the personal record; `spaces()` holds only what this engine owns');
    assert.deepEqual(family.spaces(), [], 'nothing at all, in fact — the slot held no family row');
    assert.equal(family.diagnostics().scope, FSP);
    assert.equal(family.diagnostics().foreign, 1, 'the personal record is held aside, not adopted');

    // The personal engine keeps working while the family engine is up.
    await personal.advance(PSP, '200', { seq: '200', chain: 'CCCC' }, async () => {});
    // …and only THEN does the family engine write.
    await family.advance(FSP, '5', { seq: '5', chain: 'BBBB' }, async () => {});

    const after = createCursors({ storage: chainHeadStore(PSP) });
    await after.load();
    assert.deepEqual(after.head(PSP), { seq: '200', chain: 'CCCC' },
      'THE FIX: the newer personal anchor stands. The family engine re-reads the map at write '
      + 'time and never held a copy of the personal record to write back in the first place.');
  });

  test('§2h · NON-VACUITY · a scoped lot and a scoped cursor set still do their own job', async () => {
    LS.clear();
    // Every fix in §2 can be faked by making the scoped side stop working: a lot that adopts
    // nothing, a cursor set that persists nothing, and §2b/§2c/§2d/§2g all go green. This row is
    // the control. It uses ONE space, so the sharing is not in the picture at all.
    const lot = createParkingLot({ storage: parkedEnvelopeStore(PSP), now: () => 1 });
    await lot.load();
    const e = envFor(PSP);
    assert.equal(await lot.park(PSP, e, '3', 'attestation'), true);
    assert.equal(lot.parked(PSP).length, 1, 'it parks');
    const relaunch = createParkingLot({ storage: parkedEnvelopeStore(PSP), now: () => 1 });
    await relaunch.load();
    assert.deepEqual(relaunch.parked(PSP).map((r) => r.oid), [e.oid], 'and the park is DURABLE');
    assert.equal(await relaunch.release(PSP, [e.oid]), 1, 'and an op that opened is released');
    const third = createParkingLot({ storage: parkedEnvelopeStore(PSP), now: () => 1 });
    await third.load();
    assert.equal(third.parked(PSP).length + third.shelved(PSP).length, 0,
      'and the release is durable too — the merge did not resurrect it');

    const cur = createCursors({ storage: chainHeadStore(PSP) });
    await cur.load();
    let committed = false;
    assert.equal(await cur.advance(PSP, '42', { seq: '42', chain: 'DDDD' },
      async () => { committed = true; }), true);
    assert.equal(committed, true, 'the commit still runs FIRST (ADR 003 §3.3)');
    const reread = createCursors({ storage: chainHeadStore(PSP) });
    await reread.load();
    assert.deepEqual(reread.head(PSP), { seq: '42', chain: 'DDDD' }, 'and the anchor is DURABLE');
    assert.equal(await reread.advance(PSP, '7', null, async () => {}), false,
      'and it still refuses to go backwards');
  });

  test('§2i · the two engines writing AT THE SAME TIME still both land', async () => {
    LS.clear();
    // The failure a merge INTRODUCES if it is bolted on carelessly, and the reason the ports are
    // synchronous. A merge is a read-modify-write; a read-modify-write with a suspension point in
    // the middle is a lost update whenever both engines write in the same cadence tick, which is
    // the ORDINARY case and not the rare one:
    //
    //   A reads (suspends) · B reads (suspends) · A writes its rows + the empty set it read ·
    //   B writes its rows + the empty set IT read · A's row is gone.
    //
    // That trades a certain data loss for an intermittent one, which is strictly worse — an
    // intermittent one survives a suite. Neither call below is awaited until both have been
    // issued, so if there is a window between the read and the write, this row falls into it.
    const p = createParkingLot({ storage: parkedEnvelopeStore(PSP), now: () => 1 });
    const f = createParkingLot({ storage: parkedEnvelopeStore(FSP), now: () => 1 });
    await p.load();
    await f.load();
    const pe = envFor(PSP);
    const fe = envFor(FSP);
    const both = await Promise.all([
      p.park(PSP, pe, '1', 'attestation'),
      f.park(FSP, fe, '1', 'epoch'),
    ]);
    assert.deepEqual(both, [true, true], 'both parks reported success…');

    const after = createParkingLot({ storage: parkedEnvelopeStore(PSP), now: () => 1 });
    const afterF = createParkingLot({ storage: parkedEnvelopeStore(FSP), now: () => 1 });
    await after.load();
    await afterF.load();
    assert.deepEqual(after.parked(PSP).map((r) => r.oid), [pe.oid],
      '…and BOTH are on the disk. `park()` returning true while the bytes are not there is R8-5, '
      + 'and a merge with a suspension point in it is R8-5 by another road.');
    assert.deepEqual(afterF.parked(FSP).map((r) => r.oid), [fe.oid]);

    // The same shape for the chain anchors, which advance once per pull and therefore collide on
    // exactly the cadence tick where both engines pull.
    LS.clear();
    const cp = createCursors({ storage: chainHeadStore(PSP) });
    const cf = createCursors({ storage: chainHeadStore(FSP) });
    await cp.load();
    await cf.load();
    await Promise.all([
      cp.advance(PSP, '100', { seq: '100', chain: 'AAAA' }, async () => {}, { fromGenesis: true }),
      cf.advance(FSP, '5', { seq: '5', chain: 'BBBB' }, async () => {}),
    ]);
    const back = createCursors({ storage: chainHeadStore(PSP) });
    const backF = createCursors({ storage: chainHeadStore(FSP) });
    await back.load();
    await backF.load();
    assert.deepEqual(back.head(PSP), { seq: '100', chain: 'AAAA' }, 'the personal anchor landed');
    assert.deepEqual(backF.head(FSP), { seq: '5', chain: 'BBBB' }, 'and so did the family one');
  });

  test('§2e · the transport cursor itself is NOT affected, and that is the line that holds', async () => {
    // ADR 006 §9.1 W1's cursor lives in `checkpoint().cursors`, written by `store.js` below the
    // board, and it is per space there. What §2d USED to lose is `chain.js`'s verification anchor,
    // which is a DIAGNOSTIC (ADR 002 §5.4, round 9). Naming the boundary is what kept the finding
    // honestly ranked — it was a loss of fork DETECTION on the personal space, not a lost op — and
    // the boundary is worth keeping asserted now that the anchor survives, because it is the
    // reason this row is a MEDIUM that shipped rather than a CRITICAL that stopped E7.
    const C = await buildCircle(['papa']);
    await refreshRoster(C);
    await found(C);
    await on(C.papa, () => {
      assert.equal(typeof C.papa.store.cursor(C.spaceId), 'string');
      assert.equal(C.papa.store.cursor(mkSpaceId('personal')), '0');
    });
  });
});
