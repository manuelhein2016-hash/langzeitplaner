// FLEET · E9-B — MAKING TWO HONEST CLIENTS DISAGREE ABOUT WHO MAY EDIT.
// Decision D7 · ADR 001 §4 ("Authorization must not depend on fold order, or convergence dies"),
// §4.3 stage 3b/3c, §6 · ADR 004 §2.2, §5.1 · stories 18.1, 18.2, 18.5 · properties P4/P9.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE ATTACKS, AND WHY IT IS THE ONLY ATTACK THAT MATTERS UNDER D7
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// D7 gave up the gatekeeper and bought convergence instead:
//
//     "Every honest client applies the same deterministic authorization fold … a malicious
//      member's ops are rejected by every peer, not by the relay. Enforcement is by
//      CONVERGENCE, not by gatekeeper."
//
// So the question is not "can I write something the fold rejects" — §1 of
// `e9-attack-coedit.test.js` says no, eight ways. The question is whether TWO HONEST,
// UNPATCHED CLIENTS, given THE SAME OP SET, reach the same answer. If they do not, D7 has
// bought nothing: there is no gatekeeper AND no agreement.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE SHAPE, IN ONE PARAGRAPH
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `authz.js` stage 3b decides a co-edit against the FINAL value of `pub.coEdit` / `pub.level`,
// and says so at length — "an owner who revokes co-edit RETROACTIVELY withdraws every co-editor
// write to that entity, at every stamp, on every device … the alternative makes admissibility
// depend on which op the folding device saw first, which is precisely the divergence this fold
// exists to prevent." Stage 3c makes the same promise for content above a level: "No non-null
// `geteiltOnly` value can survive in the register map while the level says otherwise, WHATEVER
// ORDER THE OPS ARRIVED IN."
//
// Both sentences are true of `foldAuthorized`. Neither is true of the shipped store, because
// `store.applyRemote` uses the fold as an ARRIVAL GATE and never re-applies it:
//
//     · it folds `[everything in my log] + [this batch]` and gets a verdict;
//     · it drops/parks the ops OF THIS BATCH that the verdict rejects;
//     · ops ALREADY IN THE LOG that the verdict now rejects are left in the log; and
//     · `registers()` is the log's plain LWW fold — `store.js:3499` calls it "the authorized
//       fold" on the strength of the gate, and that identity is what breaks.
//
// A retroactive withdrawal is therefore applied only to ops that have not landed yet. Which ops
// those are is a function of WHEN EACH MAC HAPPENED TO PULL — Oma syncing every 30 s and Opa
// opening his laptop after the weekend see different final states from the same six ops.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// DISPOSITION — READ BEFORE TRUSTING A GREEN RUN
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// §2a, §2b and §2c are `SUCCEEDED` rows: OPEN FINDINGS pinned to today's behaviour, GREEN while
// the defect exists. IF ONE GOES RED THE DEFECT WAS PROBABLY FIXED — invert it, do not repair it.
//
// None is covered by D7. Every op involved is one every honest device ACCEPTS; there is no
// patched client anywhere in §2a or §2c, and the only thing the "attacker" controls is when she
// presses ⌘S. §2d is the control that puts the defect in the STORE and not in `authz.js`.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE MUTANTS — one run each, scratch copy, baseline restored between
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   M-B1  `store.js` — `registers()` RE-DERIVES the map from
//         `foldAuthorized([...this._log.ops()], this._authzCtx())` instead of returning the
//         log's own LWW fold. That is the minimal shape of "make the sentence at `store.js:3499`
//         true"; it is not proposed as the fix (it re-folds the whole log on every read).
//
//         MEASURED, twice, in a scratch copy of `src/` + `tests/` + `server/`:
//
//           dies   §2a  §2b  §2c  §2e                        ← the four findings
//           dies   §1h  (`e9-attack-coedit`) — its last line, which asserts the co-editor keeps
//                  the withdrawn write. That assertion exists to cross-reference §2b and it is
//                  correct for it to die with it.
//           dies   §3b-b (`e9-attack-moderation`) — the fold parks that op, so re-deriving from
//                  the fold also stops it folding. ONE fix closes both findings, and that is
//                  worth knowing before either is scheduled separately.
//           lives  all 23 other rows in the four E9 attack files, §2d and §2f included.
//
//         §2d and §2f surviving is the load-bearing half: §2d says `foldAuthorized` was already
//         right, and §2f says 18.5 still cannot report a withdrawal even once the two boards
//         agree — a fix for the divergence is not a fix for the silence.

import '../helpers/env.js';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { entityUuid as newUuid } from '../../src/js/core/ids.js';
import { familyKey } from '../../src/js/core/ops.js';
import { foldAuthorized, registerValue } from '../../src/js/core/authz.js';
import { serializeRegisters } from '../../src/js/core/registers.js';

import {
  circle, converge, on, mkPubSet, patchedOp, regsOf, opsOn, parkedOn, boardOf,
} from './e9-attack-kit.js';

/**
 * PAPA publishes one Geteilt, co-editable entry. Not a patched write: `levelOf` is answered
 * `geteilt` because that is what his own truth register says — the helper only spells the patch
 * `derivePublication` would build.
 */
async function share(C, fields, level = 'geteilt') {
  const uuid = newUuid();
  let key = '';
  await on(C.papa, async () => {
    key = familyKey('fnote', C.papa.forStore.memberId, uuid);
    await patchedOp(C, C.papa, mkPubSet(C, C.papa, key, {
      'pub.level': level, 'pub.alive': true, 'pub.date': '2026-10-14', ...fields,
    }, level), { levelOf: () => level });
    await C.papa.engine.syncNow();
  });
  return { uuid, key };
}

/** The two observers' whole view of one entity, as comparable data. */
const viewOf = async (mac, key) => ({ mac: mac.tag, ...(await regsOf(mac, key)) });

/**
 * Let the wall clock move on before the next mint.
 *
 * Every Mac's HLC is seeded from `Date.now()`, so two ops minted inside the same millisecond tie
 * on `ms` AND on `ctr` (the counters are per device, both at 0) and `≺` falls through to the
 * device short — which is random per run. The rows below are about WHICH WRITE IS LATER, so the
 * order has to be a fact rather than a coin flip. Five milliseconds of real time is the cheapest
 * honest way to make it one; nothing here depends on the exact value.
 */
const laterMs = () => new Promise((r) => { setTimeout(r, 5); });

describe('E9-B · convergence, which is the whole of D7', () => {
  let C = null;

  before(async () => {
    // OMA syncs often (a Mac that is open). EVE syncs rarely (a laptop opened after the
    // weekend). Both are honest, unpatched, fully attested members running the shipped engine;
    // the ONLY difference between them anywhere in this file is when `syncNow()` is called.
    C = await circle(['papa', 'mama', 'oma', 'eve']);
  });

  test('§2a · SUCCEEDED · a co-edit and its revocation: two honest Macs, one op set, two boards', async () => {
    const e = await share(C, { 'pub.coEdit': true, 'pub.text': 'Herbstferien' });
    await converge(C, [C.mama, C.oma, C.eve]);

    await on(C.mama, async () => {
      assert.equal(C.mama.store.applyCoEdit(e.key, { 'pub.text': 'Nordsee' }), true,
        'an ordinary, granted, honest co-edit — the shipped door, no patch');
      await C.mama.engine.syncNow();
    });
    await converge(C, [C.oma]);                     // ← OMA's Mac is open. She pulls.
    await laterMs();
    await on(C.papa, async () => {
      await C.papa.engine.syncNow();
      await patchedOp(C, C.papa, mkPubSet(C, C.papa, e.key, { 'pub.coEdit': false }));
    });                                             //   Papa unticks the box.
    await converge(C, [C.oma, C.eve]);              // ← EVE opens her laptop for the first time.

    const oma = await viewOf(C.oma, e.key);
    const eve = await viewOf(C.eve, e.key);
    assert.equal(oma['pub.coEdit'], false, 'both agree the grant is gone');
    assert.equal(eve['pub.coEdit'], false);
    assert.equal(oma['pub.text'], 'Nordsee',
      'OMA kept the withdrawn co-edit: it was already in her log when the revocation arrived');
    assert.equal(eve['pub.text'], 'Herbstferien',
      'EVE folded both in one batch, so stage 3b withdrew it — the fold\'s own documented behaviour');
    assert.notDeepEqual(oma, eve,
      'TWO HONEST CLIENTS, THE SAME OP SET, TWO DIFFERENT BOARDS. This is the property D7 traded '
      + 'the server-side check away for.');

    // And it is not a transient: another pull cures nothing, because there is nothing left to pull.
    await converge(C, [C.oma, C.eve, C.oma, C.eve]);
    assert.equal((await regsOf(C.oma, e.key))['pub.text'], 'Nordsee');
    assert.equal((await regsOf(C.eve, e.key))['pub.text'], 'Herbstferien');
    // The relay delivered the same three ops to both. What differs is what each store DID with
    // them — and the shape of the difference is that Eve's store DROPPED the op outright.
    assert.equal((await opsOn(C.oma, e.key)).length, 3);
    assert.equal((await opsOn(C.eve, e.key)).length, 2,
      'Eve\'s store refused Mama\'s op at the gate; Oma\'s had already folded it');
    assert.deepEqual(await parkedOn(C.eve), [],
      'and it is DROPPED, not parked — there is no state left on Eve\'s Mac from which the two '
      + 'boards could ever be reconciled');
  });

  test('§2b · SUCCEEDED · the co-editor herself can never lose a withdrawn write', async () => {
    // §2a's divergence needs an unlucky pull. THIS one needs nothing: my own op enters my own log
    // through `_commit`, so by the time the revocation arrives it is already there. There is no
    // schedule on which the author of a retroactively-withdrawn write loses it, and no warning
    // that her board no longer says what the family's does.
    const e = await share(C, { 'pub.coEdit': true, 'pub.text': 'Ferienhaus' });
    await converge(C, [C.mama, C.eve]);
    await on(C.mama, async () => {
      assert.equal(C.mama.store.applyCoEdit(e.key, { 'pub.text': 'Mamas Fassung' }), true);
      await C.mama.engine.syncNow();
    });
    await laterMs();
    await on(C.papa, async () => {
      await C.papa.engine.syncNow();
      await patchedOp(C, C.papa, mkPubSet(C, C.papa, e.key, { 'pub.coEdit': false }));
    });
    await converge(C, [C.mama, C.eve]);

    assert.equal((await regsOf(C.eve, e.key))['pub.text'], 'Ferienhaus', 'the family\'s answer');
    assert.equal((await regsOf(C.mama, e.key))['pub.text'], 'Mamas Fassung',
      'MINE. The write the family withdrew is still the one my board draws.');
    let row = null;
    await on(C.mama, () => { [row] = boardOf(C, C.mama).filter((n) => n.entityKey === e.key); });
    assert.equal(row.text, 'Mamas Fassung', '…in pixels, not only in registers');
    // She is not silently ignored — she is told the opposite of what happened. Her own op comes
    // back from the relay, is refused by her own gate, and the sentence the family engine hands
    // her is „nothing here was changed": true of the FAMILY, false of the Mac she is reading.
    await on(C.mama, () => {
      const w = C.mama.store.warnings.join('\n');
      assert.match(w, /refused: noCoEdit/);
      assert.match(w, /nothing here was changed|nichts wurde/i,
        'the copy asserts the write survives where it was made — which is exactly the divergence');
    });
  });

  test('§2c · SUCCEEDED · the redaction boundary: a geteiltOnly register standing at Belegt', async () => {
    // Stage 3c: "No non-null `geteiltOnly` value can survive in the register map while the level
    // says otherwise, whatever order the ops arrived in." This is that sentence, falsified with
    // two honest clients and no patched seal.
    //
    // The ORDER is the only trick, and it is an ordinary one: Papa is offline when he sets the
    // entry to Belegt, so his downgrade carries an OLDER stamp than Mama's co-edit and is pushed
    // AFTER it. Per-field LWW then keeps her text over his null — which is correct, and would be
    // harmless if the entry were still Geteilt.
    const e = await share(C, { 'pub.coEdit': true, 'pub.text': 'Herbstferien Nordsee' });
    await converge(C, [C.mama, C.oma, C.eve]);

    let downgrade = null;
    await on(C.papa, () => {
      downgrade = mkPubSet(C, C.papa, e.key, { 'pub.level': 'belegt', 'pub.text': null }, 'belegt');
    });                                              // minted now → the older stamp
    await laterMs();                                 // …and Mama's is strictly newer
    await on(C.mama, async () => {
      assert.equal(C.mama.store.applyCoEdit(e.key, { 'pub.text': 'Nordsee, 2 Wochen' }), true);
      await C.mama.engine.syncNow();                 // …pushed first
    });
    await converge(C, [C.oma]);
    await on(C.papa, () => patchedOp(C, C.papa, downgrade, { levelOf: () => 'belegt' }));
    await converge(C, [C.oma, C.eve]);

    const oma = await regsOf(C.oma, e.key);
    const eve = await regsOf(C.eve, e.key);
    assert.equal(oma['pub.level'], 'belegt');
    assert.equal(eve['pub.level'], 'belegt');
    assert.equal(eve['pub.text'], null, 'EVE: stage 3c did its job — nothing above the level');
    assert.equal(oma['pub.text'], 'Nordsee, 2 Wochen',
      'OMA: a `geteiltOnly` value standing on an entity the family agreed to see as BELEGT');

    let row = null;
    await on(C.oma, () => { [row] = boardOf(C, C.oma).filter((n) => n.entityKey === e.key); });
    assert.equal(row.redacted, true,
      'the BOARD still redacts — `board.js` keys the „belegt" word on `redacted`, which is derived '
      + 'from the LEVEL and not from the presence of a text, so this does not reach the pixels');
    assert.equal(row.text, 'Nordsee, 2 Wochen',
      '…but the text is in the materialized entry, in `registers()`, and on disk. The pixel '
      + 'defence is the LAST one; the invariant that was supposed to make it unnecessary is gone.');
  });

  test('§2d · CONTROL · `foldAuthorized` itself is order-independent — the defect is the STORE\'s', async () => {
    // If this row ever fails, the finding above is misattributed and `authz.js` is the bug.
    const e = await share(C, { 'pub.coEdit': true, 'pub.text': 'Kontrolle' });
    await converge(C, [C.mama, C.eve]);
    await on(C.mama, async () => {
      C.mama.store.applyCoEdit(e.key, { 'pub.text': 'Mamas Fassung' });
      await C.mama.engine.syncNow();
    });
    await laterMs();
    await on(C.papa, async () => {
      await C.papa.engine.syncNow();
      await patchedOp(C, C.papa, mkPubSet(C, C.papa, e.key, { 'pub.coEdit': false }));
    });
    await converge(C, [C.oma, C.eve]);

    // Every op either Mac holds, folded from scratch, in eight shuffles.
    let ops = [];
    await on(C.oma, () => { ops = [...C.oma.store._log.ops({ includeParked: true })]; });
    let extra = [];
    await on(C.eve, () => { extra = [...C.eve.store._log.ops({ includeParked: true })]; });
    const byId = new Map();
    for (const o of [...ops, ...extra]) byId.set(o.id, o);
    const all = [...byId.values()];
    let ctx = null;
    await on(C.oma, () => { ctx = C.oma.store._authzCtx(); });
    const first = registerValue(foldAuthorized(all, ctx).regs, e.key, 'pub.text');
    for (let i = 0; i < 8; i++) {
      const shuffled = all.slice().sort(() => (Math.random() < 0.5 ? -1 : 1));
      assert.equal(registerValue(foldAuthorized(shuffled, ctx).regs, e.key, 'pub.text'), first,
        'foldAuthorized disagreed with itself across an arrival order — that would be a DIFFERENT bug');
    }
    assert.equal(first, 'Kontrolle',
      'and the fold\'s answer is the WITHDRAWN one, which is the answer only Eve\'s board shows');
  });

  test('§2e · the divergence is durable: it is a property of the LOG, not of a session', async () => {
    // `registers()` is re-derived from the log on every launch, and the log is what applyRemote
    // wrote. So a relaunch reproduces the divergence rather than curing it. Measured as the
    // serialized register map — the same byte-comparison the fleet harness uses for "did these
    // two devices converge?".
    const e = await share(C, { 'pub.coEdit': true, 'pub.text': 'Dauerhaft' });
    await converge(C, [C.mama, C.oma, C.eve]);
    await on(C.mama, async () => {
      C.mama.store.applyCoEdit(e.key, { 'pub.text': 'Mamas Fassung' });
      await C.mama.engine.syncNow();
    });
    await converge(C, [C.oma]);
    await laterMs();
    await on(C.papa, async () => {
      await C.papa.engine.syncNow();
      await patchedOp(C, C.papa, mkPubSet(C, C.papa, e.key, { 'pub.coEdit': false }));
    });
    await converge(C, [C.oma, C.eve]);

    const snap = async (mac) => {
      let s = '';
      await on(mac, () => {
        const regs = mac.store.registers();
        const one = new Map([[e.key, regs.get(e.key)]]);
        s = JSON.stringify(serializeRegisters(one));
      });
      return s;
    };
    const a = await snap(C.oma);
    const b = await snap(C.eve);
    assert.notEqual(a, b, 'the two devices\' serialized maps differ — this is what "diverged" means');
    assert.match(a, /Mamas Fassung/);
    assert.doesNotMatch(b, /Mamas Fassung/);
  });

  test('§2f · 18.5 cannot report this at all: the co-editor is told nothing, on either fold', async () => {
    // The notice is `displacedBy(store.registers(), …)`, and its third refusal is
    // `cmpWrites(standing, mine) <= 0 → not displaced`. A retroactive WITHDRAWAL does not put a
    // newer write in the cell — it removes mine and leaves the owner's OLDER one standing. So on
    // Eve's (correct) fold the co-editor's edit has silently ceased to exist and `displacedBy`
    // returns `null`; on Oma's fold it is still standing and returns `null` for the opposite
    // reason. The only conflict UI in the product is structurally incapable of naming the one
    // event in E9 that can make two boards disagree.
    const e = await share(C, { 'pub.coEdit': true, 'pub.text': 'Anzeige' });
    await converge(C, [C.mama, C.oma, C.eve]);
    await on(C.mama, async () => {
      C.mama.store.applyCoEdit(e.key, { 'pub.text': 'Mamas Fassung' });
      await C.mama.engine.syncNow();
    });
    await converge(C, [C.oma]);
    await laterMs();
    await on(C.papa, async () => {
      await C.papa.engine.syncNow();
      await patchedOp(C, C.papa, mkPubSet(C, C.papa, e.key, { 'pub.coEdit': false }));
    });
    await converge(C, [C.oma, C.eve]);

    const { displacedBy } = await import('../../src/js/core/registers.js');
    let mine = null;
    await on(C.mama, () => {
      const cell = C.mama.store.registers().get(e.key).get('pub.text');
      mine = { stamp: cell.stamp, op: cell.op, value: cell.value };
    });
    const ask = async (mac) => {
      let d = null;
      await on(mac, () => {
        d = displacedBy(mac.store.registers(), e.key, 'pub.text', mine, C.mama.forStore.memberId);
      });
      return d;
    };
    assert.equal(await ask(C.oma), null,
      'Oma\'s fold: her write is still standing — nothing displaced it, so no notice');
    assert.equal(await ask(C.eve), null,
      'Eve\'s fold: her write is GONE and the OLDER value is standing, which refusal 3 reads as '
      + '„my write is the one standing" — so no notice there either');
    assert.equal((await regsOf(C.eve, e.key))['pub.text'], 'Anzeige',
      'NON-VACUITY: on Eve\'s board the edit really did disappear');
  });
});
