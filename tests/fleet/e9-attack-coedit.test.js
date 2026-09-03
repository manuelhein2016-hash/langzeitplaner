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
// DISPOSITION — §1i IS CLOSED AND HAS BEEN INVERTED
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `§1i` used to be the one that got through: `authz.js` stage 3b read `pub.level` and
// `pub.coEdit` and NOT `pub.alive`, while `store.familyCoEditLevelOf` — the author side, the
// predicate `interact.js` asks before it offers the gesture — read all three. So the honest
// client refused a co-edit of a deleted entry and the RECEIVING side, which is the only side
// that decides anything, refused nobody.
//
// IT IS CLOSED: stage 3b now reads all three governing registers, in the order the author side
// reads them, under `REJECT_REASONS.NOT_ALIVE`. The row asserts the refusal and the two 18.6 /
// 17.6 consequences that used to follow from its absence.
//
// §1h's LAST ASSERTION has been inverted with it, for the reason that assertion existed: it was
// the cross-reference to `e9-attack-diverge` §2b, and §2b is closed.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE MUTANTS — one run each, in a scratch copy of the tree, baseline restored between
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   M-A1  `core/authz.js` stage 3b — delete the one line the author side already had,
//         `registerValue(govRegs, op.e, 'pub.alive') === false → reject`.
//         MEASURED, twice, in a scratch copy (`--test-concurrency=1`, baseline 32/32):
//           dies  §1i, and NOTHING ELSE in the four E9 attack files.
//           dies  the `notAlive` row of `tests/tier1/core-authz.test.js`'s reason-code census,
//                 which is where the enum is proved reachable rather than merely declared.
//         That is the mutant's whole point: §1i is not vacuous, and the divergence between the
//         author side (`store.familyCoEditLevelOf`, three registers) and the receiving side
//         (stage 3b, two) was one predicate in one place.
//
//   ⚠ §1h's last assertion dies under `e9-attack-diverge`'s M-B1 and M-B4, not under M-A1. It is
//     deliberately not a §1h claim about 18.1.
//
//   HONEST-PATH CONTROL: §1a is the non-vacuity row — the grant really is exercisable on this
//   rig — and it is green under M-A1 and under the fix.

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
    // ⚠ AND IT HOLDS ON HER OWN BOARD TOO, which is `e9-attack-diverge.test.js` §2b: the write
    // she ALREADY made entered her log through `_commit` and never passed an arrival gate, so
    // the withdrawal has to reach the LOG rather than the door. Asserted here so this row cannot
    // be read as "the withdrawal held everywhere except where it was made".
    assert.equal((await regsOf(C.mama, e.key))['pub.text'], 'Ferienhaus',
      'the co-editor loses the write the family withdrew — see e9-attack-diverge §2b');
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // THE ONE THAT USED TO GET THROUGH
  // ───────────────────────────────────────────────────────────────────────────────────────────
  test('§1i · CLOSED · stage 3b reads `pub.alive`: a co-edit of a DELETED entry is refused by every honest device', async () => {
    // `store.familyCoEditLevelOf` reads three registers — `pub.level`, `pub.coEdit` AND
    // `pub.alive` — and refuses when the entry is dead. Stage 3b used to read only the first two,
    // so the author side and the receiving side disagreed about one of the three governing
    // registers, and the receiving side is the one that decides.
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
    // …and the patched one is now refused by everybody, by name.
    await on(C.mama, () => patchedOp(C, C.mama, mkPubSet(C, C.mama, e.key, { 'pub.text': 'GHOST' })));
    await converge(C, [C.papa, C.oma]);
    for (const m of [C.papa, C.oma]) {
      assert.equal((await regsOf(m, e.key))['pub.text'], 'Skiwoche',
        `${m.tag} folded a co-editor's write to a deleted entity`);
      await on(m, () => {
        assert.match(m.store.warnings.join('\n'), /refused: notAlive/,
          `${m.tag} refused it for the right reason, not by accident`);
      });
    }

    // 18.6: "my undo of my own deletion restores the entry as a new shared operation" — and what
    // it restores is HIS text, because nothing of hers was ever admitted.
    await on(C.papa, () => patchedOp(C, C.papa, mkPubSet(C, C.papa, e.key, { 'pub.alive': true })));
    await converge(C, [C.oma]);
    let row = null;
    await on(C.oma, () => { [row] = boardOf(C, C.oma).filter((n) => n.entityKey === e.key); });
    assert.ok(row, 'the entry is back on the family board');
    assert.equal(row.text, 'Skiwoche',
      'PAPA\'S RESTORE RESTORED THE VERSION HE WROTE — 18.6 is about HIS destructive act being '
      + 'reversible for HIM, and a post-mortem write from somebody else has no place in it');
    assert.equal(row.updatedBy, C.papa.forStore.memberId,
      '…and 17.6 attributes it to him, which is now true rather than merely stated');

    // AND THE REFUSAL IS RETROACTIVE, exactly as `pub.coEdit`'s is: the restore re-admits nothing,
    // because her op was never in anybody's log to re-admit — it was refused at the gate on
    // arrival, and refused again by the fold on every device that had already pulled it.
    await on(C.oma, () => {
      const ghosts = [...C.oma.store._log.ops({ includeParked: true })]
        .filter((o) => JSON.stringify(o.f).includes('GHOST'));
      assert.deepEqual(ghosts, [], 'no line of it survives anywhere on a peer\'s Mac');
    });
  });
});
