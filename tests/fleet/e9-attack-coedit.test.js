// FLEET · E9-A — EDITING AN ENTRY I DO NOT OWN AND WAS NOT INVITED TO.
// Stories 18.1, 18.2, 18.6 · ADR 001 §4.3 stage 3a/3b, §4.4 · ADR 004 §2.2 barrier 4, §8 ·
// decision D7.
//
// I am MAMA: an INVITED, ATTESTED member of a real Familienkreis, with a patched client. I forge
// no signature, no device, no attestation and no membership — every op below is authored by a
// member the family really admitted, on a device the family really attested, sealed under the
// real space key and pushed through the real relay. That is the threat model D7 names, and it is
// the only one that matters now that E9 has opened write paths into other people's entities.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// DISPOSITION OF THE `SUCCEEDED` ROW IN THIS FILE — READ THIS BEFORE TRUSTING A GREEN RUN
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `§1g … SUCCEEDED …` is an OPEN FINDING, pinned to the behaviour the code has TODAY, so it is
// GREEN while the defect exists. That inverts the usual reading of red and green:
//
//     IF §1g GOES RED, THE DEFECT WAS PROBABLY FIXED. Do not "repair" it — invert it.
//
// It is NOT covered by D7. D7's accepted trade is "a patched member can emit an op the others
// will REJECT — but not one they will ACCEPT". §1g's op is one every honest device ACCEPTS,
// folds identically, and agrees with. It therefore breaks D7's stated guarantee rather than
// falling under it, exactly as the `ownership-authz-*` headers already say of their own rows.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE MUTANT — one run each, in a scratch copy of the tree, baseline restored between
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   M-A1  `core/authz.js` stage 3b gains the ONE line the author side already has —
//         `registerValue(govRegs, op.e, 'pub.alive') === false → reject`.
//         MEASURED, twice, in a scratch copy: **§1i dies and NOTHING ELSE DOES** — all 28 other
//         rows in the four E9 attack files stay green. That is the mutant's whole point: §1i is
//         not vacuous, and the divergence between the author side and the receiving side is one
//         predicate in one place.
//
//   ⚠ §1h's LAST ASSERTION is the cross-reference to `e9-attack-diverge.test.js` §2b and dies
//     under THAT file's M-B1, not under M-A1. It is deliberately not a §1h claim about 18.1.

import '../helpers/env.js';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { entityUuid as newUuid } from '../../src/js/core/ids.js';
import { familyKey } from '../../src/js/core/ops.js';
import { RedactionError } from '../../src/js/crypto/envelope.js';

import {
  circle, converge, on, mkPubSet, patchedOp, regsOf, boardOf,
} from './e9-attack-kit.js';

/**
 * Papa publishes one entry. The patch is assembled here rather than through
 * `publishSharedEntry` because that helper brands and seals at `geteilt` unconditionally, and
 * one of the rows below needs a Belegt publication — which is a legitimate thing an owner
 * publishes and must therefore be buildable without a patched seal.
 */
async function papaShares(C, fields, level = 'geteilt') {
  const uuid = newUuid();
  let key = '';
  await on(C.papa, async () => {
    key = familyKey('fnote', C.papa.forStore.memberId, uuid);
    const op = mkPubSet(C, C.papa, key, {
      'pub.level': level, 'pub.alive': true, 'pub.date': '2026-10-14', ...fields,
    }, level);
    await patchedOp(C, C.papa, op, { levelOf: () => level });
    await C.papa.engine.syncNow();
  });
  await converge(C, [C.mama, C.oma]);
  return { uuid, key };
}

describe('E9-A · every route into somebody else\'s entry', () => {
  let C = null;
  let open = null;        // geteilt + coEdit — the one entry 18.2 really grants
  let closed = null;      // geteilt, no flag — 18.1's default
  let belegt = null;      // coEdit true, level belegt — the incoherent grant §4.3 refuses

  before(async () => {
    C = await circle(['papa', 'mama', 'oma']);
    open = await papaShares(C, { 'pub.coEdit': true, 'pub.text': 'Herbstferien' });
    closed = await papaShares(C, { 'pub.text': 'Zahnarzt' });
    belegt = await papaShares(C, { 'pub.coEdit': true, 'pub.text': null }, 'belegt');
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  test('§1a · NON-VACUITY · the grant really is exercisable on this rig', async () => {
    await on(C.mama, async () => {
      assert.equal(C.mama.store.familyCoEditLevelOf(open.key), 'geteilt');
      assert.equal(C.mama.store.applyCoEdit(open.key, { 'pub.text': 'Nordsee' }), true);
      await C.mama.engine.syncNow();
    });
    await converge(C, [C.papa, C.oma]);
    assert.equal((await regsOf(C.papa, open.key))['pub.text'], 'Nordsee');
    assert.equal((await regsOf(C.oma, open.key))['pub.text'], 'Nordsee',
      'a third member folds the co-edit the same way — if this fails, nothing else here means anything');
  });

  test('§1b · FAILED · 18.1 · the same gesture on an entry with no flag authors nothing', async () => {
    let before = null;
    await on(C.mama, () => {
      before = [...C.mama.store._log.ops()].length;
      assert.equal(C.mama.store.familyCoEditLevelOf(closed.key), null,
        'the fold answers `null`: the owner granted nothing');
      assert.equal(C.mama.store.applyCoEdit(closed.key, { 'pub.text': 'gekapert' }), false);
      assert.equal([...C.mama.store._log.ops()].length, before, '0 ops authored');
    });
    assert.equal((await regsOf(C.papa, closed.key))['pub.text'], 'Zahnarzt');
  });

  test('§1c · FAILED · a forged co-edit GRANT on somebody else\'s entity reaches no board', async () => {
    // The shortest route to unlimited write access: give myself the flag. `pub.coEdit` is a
    // GOVERNING register, so stage 3a admits it only from the owner or from an admin unshare.
    await on(C.mama, () => patchedOp(C, C.mama, mkPubSet(C, C.mama, closed.key, { 'pub.coEdit': true })));
    await converge(C, [C.papa, C.oma, C.mama]);
    for (const m of [C.papa, C.oma, C.mama]) {
      assert.notEqual((await regsOf(m, closed.key))['pub.coEdit'], true,
        `${m.tag} folded a co-edit grant authored by a non-owner`);
    }
    await on(C.mama, () => {
      assert.equal(C.mama.store.familyCoEditLevelOf(closed.key), null,
        'and my OWN Mac does not believe it either — the op never entered my log');
    });
  });

  test('§1d · FAILED · §4.4 · an entity key that claims another owner is a DIFFERENT entity', async () => {
    // "Ownership is structural" made executable. I mint a key with PAPA's uuid and MY memberId.
    // There is no register to steal: the key I wrote is mine, and his entry never moves.
    const mine = familyKey('fnote', C.mama.forStore.memberId, closed.uuid);
    assert.notEqual(mine, closed.key);
    await on(C.mama, () => patchedOp(C, C.mama, mkPubSet(C, C.mama, mine, {
      'pub.level': 'geteilt', 'pub.alive': true, 'pub.text': 'gekapert',
    })));
    await converge(C, [C.papa, C.oma]);
    assert.equal((await regsOf(C.papa, closed.key))['pub.text'], 'Zahnarzt',
      'his entry is untouched — the uuid collision buys nothing, because the owner segment is the key');
    assert.equal((await regsOf(C.oma, mine))['pub.text'], 'gekapert',
      'what I actually created is an entry of MY OWN, under my own name (non-vacuity)');
  });

  test('§1e · FAILED · a field outside the co-editable set, by both doors', async () => {
    // Door 1: the shipped one. `projectCoEditPatch` refuses a governing field before an op exists.
    await on(C.mama, () => {
      assert.equal(C.mama.store.applyCoEdit(open.key, { 'pub.level': 'privat' }), false);
      assert.equal(C.mama.store.applyCoEdit(open.key, { 'pub.coEdit': false }), false);
      assert.equal(C.mama.store.applyCoEdit(open.key, { _born: '0'.repeat(37) }), false);
    });
    // Door 2: the patched one. Stage 3b's `FIELDS[kind][f].coEdit` check is the backstop.
    await on(C.mama, () => patchedOp(C, C.mama,
      mkPubSet(C, C.mama, open.key, { 'pub.level': 'privat' }, 'privat'),
      { levelOf: () => 'privat' }));
    await converge(C, [C.papa, C.oma]);
    assert.equal((await regsOf(C.papa, open.key))['pub.level'], 'geteilt');
    assert.equal((await regsOf(C.oma, open.key))['pub.level'], 'geteilt');
  });

  test('§1f · FAILED · 18.6 · a co-editor may not delete the family vacation', async () => {
    // `pub.alive` is governing on purpose: a co-editor's deletion would leave the entry gone from
    // my board and present on everyone else's, which is a DIVERGENCE and worse than a refusal.
    await on(C.mama, () => {
      assert.equal(C.mama.store.applyCoEdit(open.key, { 'pub.alive': false }), false);
    });
    await on(C.mama, () => patchedOp(C, C.mama, mkPubSet(C, C.mama, open.key, { 'pub.alive': false })));
    await converge(C, [C.papa, C.oma]);
    for (const m of [C.papa, C.oma]) {
      assert.notEqual((await regsOf(m, open.key))['pub.alive'], false, `${m.tag} accepted a co-editor's delete`);
    }
  });

  test('§1g · FAILED · co-editing at Belegt — the flag exists at no other level', async () => {
    await on(C.mama, () => {
      assert.equal(C.mama.store.familyCoEditLevelOf(belegt.key), null,
        'coEdit true and level belegt: the author side answers null');
      assert.equal(C.mama.store.applyCoEdit(belegt.key, { 'pub.text': 'gekapert' }), false);
    });
    await on(C.mama, () => patchedOp(C, C.mama, mkPubSet(C, C.mama, belegt.key, { 'pub.text': 'gekapert' })));
    await converge(C, [C.papa, C.oma]);
    for (const m of [C.papa, C.oma]) {
      assert.equal((await regsOf(m, belegt.key))['pub.text'] ?? null, null,
        `${m.tag} folded a co-edit at Belegt — 16.7's promise is that the text is not readable there`);
    }
  });

  test('§1h · FAILED · a REVOKED flag withdraws every co-editor write, on every board', async () => {
    // The order-independence half of stage 3b, driven end to end: the owner revokes AFTER the
    // co-edit, and the co-edit is withdrawn because the predicate reads the FINAL register.
    // ⚠ This holds only when the two ops reach a device IN ONE BATCH. §2 of
    // `e9-attack-diverge.test.js` is the same op set delivered in two, and it does NOT hold.
    const e = await papaShares(C, { 'pub.coEdit': true, 'pub.text': 'Ferienhaus' });
    await on(C.mama, async () => {
      assert.equal(C.mama.store.applyCoEdit(e.key, { 'pub.text': 'Mamas Fassung' }), true);
      await C.mama.engine.syncNow();
    });
    await on(C.papa, async () => {
      await C.papa.engine.syncNow();
      await patchedOp(C, C.papa, mkPubSet(C, C.papa, e.key, { 'pub.coEdit': false }));
    });
    // OMA has seen NEITHER op yet: she folds both in one batch, which is the fold's own case.
    await converge(C, [C.oma]);
    const oma = await regsOf(C.oma, e.key);
    assert.equal(oma['pub.coEdit'], false);
    assert.equal(oma['pub.text'], 'Ferienhaus',
      'the withdrawn grant withdraws the write it granted');
    // …and once the revocation reaches ME, my own client offers no further write.
    await converge(C, [C.mama]);
    await on(C.mama, () => {
      assert.equal(C.mama.store.familyCoEditLevelOf(e.key), null, 'no further write is offered');
      assert.equal(C.mama.store.applyCoEdit(e.key, { 'pub.text': 'noch eine' }), false);
    });
    // ⚠ WHAT DOES *NOT* HOLD, AND IS THE SUBJECT OF `e9-attack-diverge.test.js` §2b: the write
    // she ALREADY made is still standing on her own board, because it entered her log through
    // `_commit` and `applyRemote` removes nothing. Asserted here so this row cannot be read as
    // "the withdrawal held everywhere".
    assert.equal((await regsOf(C.mama, e.key))['pub.text'], 'Mamas Fassung',
      'the co-editor keeps the write the family withdrew — see e9-attack-diverge §2b');
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // THE ONE THAT GOT THROUGH
  // ───────────────────────────────────────────────────────────────────────────────────────────
  test('§1i · SUCCEEDED · stage 3b never reads `pub.alive`: I write to a DELETED entry and every honest device agrees with me', async () => {
    // `store.familyCoEditLevelOf` reads three registers — `pub.level`, `pub.coEdit` AND
    // `pub.alive` — and refuses when the entry is dead. `authz.js` stage 3b reads only the first
    // two. The author side and the receiving side therefore disagree about one of the three
    // governing registers, and the receiving side is the one that decides.
    const e = await papaShares(C, { 'pub.coEdit': true, 'pub.text': 'Skiwoche' });
    await on(C.papa, async () => {
      await patchedOp(C, C.papa, mkPubSet(C, C.papa, e.key, { 'pub.alive': false }));   // 18.6
    });
    await converge(C, [C.mama, C.oma]);
    assert.equal((await regsOf(C.oma, e.key))['pub.alive'], false, 'it really is deleted');

    await on(C.mama, () => {
      assert.equal(C.mama.store.familyCoEditLevelOf(e.key), null,
        'MY OWN honest client refuses — it reads `pub.alive`');
      assert.equal(C.mama.store.applyCoEdit(e.key, { 'pub.text': 'GHOST' }), false);
    });
    // …and the patched one is not refused by anybody.
    await on(C.mama, () => patchedOp(C, C.mama, mkPubSet(C, C.mama, e.key, { 'pub.text': 'GHOST' })));
    await converge(C, [C.papa, C.oma]);
    for (const m of [C.papa, C.oma]) {
      assert.equal((await regsOf(m, e.key))['pub.text'], 'GHOST',
        `${m.tag} ACCEPTED a co-editor's write to a deleted entity`);
    }

    // 18.6: "my undo of my own deletion restores the entry as a new shared operation".
    await on(C.papa, () => patchedOp(C, C.papa, mkPubSet(C, C.papa, e.key, { 'pub.alive': true })));
    await converge(C, [C.oma]);
    let row = null;
    await on(C.oma, () => { [row] = boardOf(C, C.oma).filter((n) => n.entityKey === e.key); });
    assert.ok(row, 'the entry is back on the family board');
    assert.equal(row.text, 'GHOST',
      'PAPA\'S RESTORE RESURRECTED A VERSION HE NEVER WROTE — the text he deleted is gone and mine is standing');
    assert.equal(row.updatedBy, C.papa.forStore.memberId,
      '…and 17.6 attributes it to HIM: his `pub.alive` write is the newest register on the entity');
  });
});
