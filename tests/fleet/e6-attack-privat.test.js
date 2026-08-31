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
// §2 — WHAT DID NOT HOLD: TWO ENGINES, ONE DISK
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The rings, the outboxes and the transport cursors are correctly per space. **Three durable
// slots are not.** `src/js/family/engine.js`:
//
//     const LS_RING   = (spaceId) => `langzeitplaner.ring.${spaceId}`;     ← per space
//     const LS_PEERS  = (spaceId) => `langzeitplaner.peers.${spaceId}`;    ← per space
//     const LS_SEALED = 'langzeitplaner.sealed';                           ← keyed per space by
//     const LS_PARKED = 'langzeitplaner.parked';                           ← ONE KEY
//     const LS_CHAIN  = 'langzeitplaner.chainheads';                       ← ONE KEY
//
// and BOTH `startEngine` (personal, line ~206) and `startFamilyEngine` (family, line ~717)
// construct `parkedEnvelopeStore()` and `chainHeadStore()` over them. Each engine builds its own
// `createParkingLot` / `createCursors`, each loads the WHOLE slot, and each writes the WHOLE slot
// back from its own in-memory copy. Two writers, one file, no merge.
//
// §2 drives that with the product's own `sync/outbox.js` and `sync/cursor.js` over a store that
// is the one `family/engine.js` gives them.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE MUTANTS — one run each, in a scratch copy of the tree
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   M-E  `sync/outbox.js` — `persist()` re-reads the slot and carries FOREIGN-space rows
//        through instead of overwriting them.                                        → §2b
//   M-F  `sync/outbox.js` — the cap counts `rows` for THIS space, not the whole slot.  → §2c
//   M-G  `sync/cursor.js` — `advance()` merges its snapshot into what the slot already
//        holds instead of replacing it.                                              → §2d
//
// §1's rows are all FAILED (the barriers held), so they have no mutant: there is nothing to
// prove can fail. Their non-vacuity control is §1g, which shares an entry successfully on the
// same rig and asserts the Privat one is still absent.
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

/** The `parkStore` port, exactly as `family/engine.js#parkedEnvelopeStore()` builds it. */
function parkedEnvelopeStore() {
  const KEY = 'langzeitplaner.parked';
  return {
    durable: true,
    async loadRecords() {
      try { const raw = LS.getItem(KEY); return raw ? JSON.parse(raw) : []; } catch { return []; }
    },
    async saveRecords(rows) {
      try { LS.setItem(KEY, JSON.stringify(rows)); } catch { /* a full disk is not a crash */ }
    },
  };
}

/** The `chainStore` port, exactly as `family/engine.js#chainHeadStore()` builds it. */
function chainHeadStore() {
  const KEY = 'langzeitplaner.chainheads';
  return {
    async loadCursors() {
      try { const raw = LS.getItem(KEY); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
    },
    async saveCursors(all) {
      try { LS.setItem(KEY, JSON.stringify(all)); } catch { /* as above */ }
    },
  };
}

const envFor = (space, ep = 1) => ({
  v: 1, sp: space, ep, dv: 'AAAAAAAAAAA', oid: mkOpId(),
  wit: '', iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAA', sig: 'AAAA',
});

describe('§2 · the durable slots the two engines share, and what sharing them costs', () => {
  const PSP = mkSpaceId('personal');
  const FSP = mkSpaceId('family');

  test('§2a · the two slots really are one key each, and BOTH engines are wired to them', () => {
    // This is the shape the rest of §2 is about, pinned as source so a fix is a visible change.
    assert.match(ENGINE_SRC, /const LS_PARKED = 'langzeitplaner\.parked';/);
    assert.match(ENGINE_SRC, /const LS_CHAIN = 'langzeitplaner\.chainheads';/);
    assert.match(ENGINE_SRC, /const LS_RING = \(spaceId\) =>/, 'the ring IS per space — for contrast');
    // `parkStore: parkedEnvelopeStore()` and `chainStore: chainHeadStore()` appear twice each:
    // once in `startEngine` (personal) and once in `startFamilyEngine` (family).
    assert.equal((ENGINE_SRC.match(/parkStore: parkedEnvelopeStore\(\)/g) || []).length, 2,
      'both engines write the same parked-envelope slot');
    assert.equal((ENGINE_SRC.match(/chainStore: chainHeadStore\(\)/g) || []).length, 2,
      'both engines write the same chain-head slot');
    // And the file already says the seam is owed — to `storage.js`, for a different reason.
    assert.match(ENGINE_SRC, /OWED to `storage\.js`'s owner/);
  });

  test('§2b · SUCCEEDED · the family lot DESTROYS the personal engine\'s shelved envelopes', async () => {
    LS.clear();
    // The personal engine's lot, with one envelope it gave up on. R8-4: "not replayed is not
    // destroyed" — the bytes are SHELVED, out of the replay set, retained for ever, and a
    // relaunch gives them `PARK_REVIVALS` more chances. The shelf is the only copy on this Mac.
    const personal = createParkingLot({ storage: parkedEnvelopeStore(), now: () => 1 });
    await personal.load();
    const shelved = envFor(PSP);
    assert.equal(await personal.park(PSP, shelved, '7', 'attestation'), true);
    await personal.refuse(PSP, [shelved.oid]);
    assert.equal(personal.shelved(PSP).length, 1, 'NON-VACUITY: the bytes really are on the shelf');

    // The family engine's lot loaded BEFORE that happened — an ordinary interleaving: the two
    // engines start together at launch.
    const family = createParkingLot({ storage: parkedEnvelopeStore(), now: () => 1 });
    // Its `load()` runs at launch, when the slot was empty.
    LS.setItem('langzeitplaner.parked', '[]');
    await family.load();
    LS.removeItem('langzeitplaner.parked');
    await personal.load();                      // re-read: the personal side is intact on disk
    assert.equal(personal.shelved(PSP).length + personal.parked(PSP).length, 0);

    // Do it in the honest order instead: personal shelves, THEN family parks one of its own.
    LS.clear();
    const p2 = createParkingLot({ storage: parkedEnvelopeStore(), now: () => 1 });
    const f2 = createParkingLot({ storage: parkedEnvelopeStore(), now: () => 1 });
    await p2.load();
    await f2.load();                            // both loaded at launch, both hold []
    const ghost = envFor(PSP);
    await p2.park(PSP, ghost, '7', 'attestation');
    await p2.refuse(PSP, [ghost.oid]);          // ← retained for ever, says R8-4
    assert.equal(p2.shelved(PSP).length, 1);

    await f2.park(FSP, envFor(FSP), '3', 'epoch');   // ← one ordinary family park

    // A relaunch: whatever is on disk is what this Mac has.
    const after = createParkingLot({ storage: parkedEnvelopeStore(), now: () => 1 });
    await after.load();
    assert.equal(after.parked(FSP).length, 1, 'the family envelope survived');
    assert.equal(after.parked(PSP).length + after.shelved(PSP).length, 0,
      'THE BREAK: the personal engine\'s retained envelope is gone from the disk. `persist()` '
      + 'writes `rows + shelf` — ITS OWN — into a slot the other engine also owns, and there is '
      + 'no merge. R8-4\'s "not replayed is not destroyed" holds per lot and not per disk.');
  });

  test('§2c · SUCCEEDED · the park CAP is shared, so family traffic can stall the personal cursor', async () => {
    LS.clear();
    // A small cap, because the shape is the finding and 10 000 rows is the same shape. The
    // product's cap is `PARK_CAP` and it is counted over `rows`, which after `load()` contains
    // EVERY space's rows — including the ones this engine can never cure.
    assert.equal(PARK_CAP, 10000, 'the product\'s cap, for the record');
    const cap = 4;
    const family = createParkingLot({ storage: parkedEnvelopeStore(), now: () => 1, cap });
    await family.load();
    for (let i = 0; i < cap; i++) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal(await family.park(FSP, envFor(FSP), String(i + 1), 'epoch'), true);
    }
    // The personal engine starts (or relaunches) and reads the same slot.
    const personal = createParkingLot({ storage: parkedEnvelopeStore(), now: () => 1, cap });
    await personal.load();
    assert.equal(personal.parked(FSP).length, cap,
      'it loaded the OTHER engine\'s rows — the lot is per PROCESS, the slot is per DISK');
    const mine = await personal.park(PSP, envFor(PSP), '1', 'attestation');
    assert.equal(mine, false,
      'THE BREAK: `park()` returns false, which its own contract says means "the caller MUST NOT '
      + 'advance the cursor past it". A family space nobody can decrypt has stalled the PERSONAL '
      + 'space\'s sync, and the sentence the user is shown names the family space.');
  });

  test('§2d · SUCCEEDED · the family engine rolls the personal space\'s chain anchor backwards', async () => {
    LS.clear();
    // Both engines start. Each `createCursors` loads the whole map and writes the whole map.
    const personal = createCursors({ storage: chainHeadStore() });
    const family = createCursors({ storage: chainHeadStore() });
    await personal.load();
    await family.load();

    // The personal engine verifies its way up to seq 100 and earns `fromGenesis`.
    await personal.advance(PSP, '100', { seq: '100', chain: 'AAAA' }, async () => {}, { fromGenesis: true });
    assert.deepEqual(personal.head(PSP), { seq: '100', chain: 'AAAA' });
    assert.equal(personal.fromGenesis(PSP), true);

    // The family engine then advances its OWN cursor — an ordinary pull, nothing hostile.
    await family.advance(FSP, '5', { seq: '5', chain: 'BBBB' }, async () => {});

    // Relaunch.
    const after = createCursors({ storage: chainHeadStore() });
    await after.load();
    assert.deepEqual(after.head(FSP), { seq: '5', chain: 'BBBB' }, 'the family anchor is there');
    assert.equal(after.head(PSP), null,
      'THE BREAK: the personal space\'s verified chain head is gone. `saveCursors(snapshot())` '
      + 'writes the writer\'s OWN map, and the family engine\'s map never had the personal row.');
    assert.equal(after.fromGenesis(PSP), false,
      'and `fromGenesis` — the right to call an unknown witness a fork — went with it');
  });

  test('§2e · the transport cursor itself is NOT affected, and that is the line that holds', async () => {
    // ADR 006 §9.1 W1's cursor lives in `checkpoint().cursors`, written by `store.js` below the
    // board, and it is per space there. What §2d loses is `chain.js`'s verification anchor, which
    // is a DIAGNOSTIC (ADR 002 §5.4, round 9). Naming the boundary is what keeps the finding
    // honestly ranked: this is a loss of fork DETECTION on the personal space, not a lost op.
    const C = await buildCircle(['papa']);
    await refreshRoster(C);
    await found(C);
    await on(C.papa, () => {
      assert.equal(typeof C.papa.store.cursor(C.spaceId), 'string');
      assert.equal(C.papa.store.cursor(mkSpaceId('personal')), '0');
    });
  });
});
