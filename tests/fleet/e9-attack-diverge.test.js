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
// Both sentences were true of `foldAuthorized` and FALSE of the shipped store, because
// `store.applyRemote` used the fold as an ARRIVAL GATE and never re-applied it:
//
//     · it folded `[everything in my log] + [this batch]` and got a verdict;
//     · it dropped/parked the ops OF THIS BATCH that the verdict rejected;
//     · ops ALREADY IN THE LOG that the verdict now rejected were left in the log; and
//     · `registers()` was the log's plain LWW fold — `store.js` called it "the authorized
//       fold" on the strength of the gate, and that identity is what broke.
//
// A retroactive withdrawal was therefore applied only to ops that had not landed yet. Which ops
// those were was a function of WHEN EACH MAC HAPPENED TO PULL — Oma syncing every 30 s and Opa
// opening his laptop after the weekend saw different final states from the same six ops.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// DISPOSITION — CLOSED, AND THESE ROWS NOW ASSERT THE FIX
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// §2a, §2b, §2c and §2e were `SUCCEEDED` rows pinned to the defect. THE DEFECT IS CLOSED and
// every one of them has been INVERTED: each now asserts that the withdrawal reaches the whole
// log on every Mac, which is what the two sentences above claim. They are ordinary rows again —
// red means broken.
//
// WHAT CLOSED IT (`store.js`): `registers()` is no longer `this._log.registers()`. It is the
// log's fold with the FOLD'S OWN RETROACTIVE VERDICT SUBTRACTED — the ops `foldAuthorized`
// withdrew removed by id, the fields stage 3c redacted removed by name — memoised against the
// log's own memo, and re-derived only when an op that could change a predicate's answer
// (`member.set`, `space.set`, or a `pub.set` carrying a governing field) enters the log.
// `applyRemote` hands its verdict straight to that pass, so a remote batch pays for no extra
// fold at all. The essay on `store.registers()` carries the cost measurement (75 ms for one
// `foldAuthorized` over the LZP-1007 fixture, against ADR 001 §5.1's 40 ms budget) and the
// argument for why the STORE was the wrong side rather than the prose.
//
// §2d is unchanged and is still the control: it says `foldAuthorized` was always right.
// §2f is unchanged and is STILL AN OPEN FINDING — 18.5 cannot report a withdrawal even now that
// the two boards agree. A fix for the divergence is not a fix for the silence.
//
// ── WHAT IS STILL OWED, AND IT IS NOT IN THESE FILES ─────────────────────────────────────────
//
// A retroactively-refused ARRIVAL is still DROPPED at the gate rather than held. So the two Macs
// converge on the withdrawn state (that is §2a), and if the owner later RE-TICKS the box the Mac
// that had already folded the write restores it while the Mac that never got to fold it cannot —
// its line is gone. Closing that is F-6's shape exactly: `applyRemote` must PARK such an arrival,
// which needs a `PARK_REASONS.WITHDRAWN` in `core/ops.js` (another owner's file this round).
// Measured by §2g, which is an OPEN row and green while that gap exists.
//
// AND ONE MORE, BOUNDED AND PRE-EXISTING: a withdrawal cannot reach an op that has already been
// COMPACTED, because a compacted op is no longer a line and is not in the set the fold is given.
// `oplog.js:park()` refuses the same case in the same words; the bound is ADR 001 §7.2's own
// compaction policy, not anything this pass introduced. See `store._repairWithdrawn`.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE MUTANTS — one run each, scratch copy, baseline restored between
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   M-B1  `store.js:registers()` — `return base;` unconditionally, i.e. hand back the log's own
//         LWW fold and never subtract the verdict. That is the defect restored in one line.
//         MEASURED in a scratch copy (`--test-concurrency=1`, baseline 32/32):
//           dies  §2a §2b §2c §2e §2f §2g §2h  — every row in this file that reads a converged
//                 board, the two OPEN ones included: they assert what BOTH Macs now show.
//           dies  `e9-attack-coedit` §1h's last assertion, which is this file's §2b seen from
//                 the co-editor's own board.
//           lives §2d (the control), and every row of the other three files.
//
//   M-B2  `store.js:_armAuthz()` — `return;` at the top, i.e. never raise the flag for a
//         governing op. The REMOTE path still repairs, because `applyRemote` hands its verdict
//         over directly, so this isolates the LOCAL half exactly.
//           dies  §2h, alone. (§2h runs on a circle of its own for this reason: the rows above
//                 leave withdrawals in every log, and a store holding one is armed already.)
//
//   M-B3  `store.js:_withdrawalsOf` — the `contentAboveLevel` loop iterates `[]`, i.e. stage 3c's
//         FIELD-level redaction is not applied while everything else is.
//           dies  §2c, alone. That is what makes §2c a claim about stage 3c rather than a second
//                 copy of §2a — and it also shows that `RETROACTIVE_REFUSALS`' own
//                 `CONTENT_ABOVE_LEVEL` entry is the BACKSTOP and this loop is the mechanism: an
//                 op redacted to nothing is named by both.
//
//   M-B4  `store.js:applyRemote` — delete the `this._noteAuthzVerdict(verdict)` call, i.e. keep
//         the whole repair and never hand it the verdict the door already computed.
//           dies  the same eight rows as M-B1. The two together say the repair needs BOTH ends:
//                 the map that subtracts, and the door that says what to subtract.
//
//   HONEST-PATH CONTROL, run against the fix and green throughout:
//     npm test 2117 · npm run test:attack 920 · npm run test:server 903 · npm run test:fleet 396
//     · npm run test:property 100/101 (the one failure is `S5b`, an unenumerated
//       `src/js/family/unshare.js` from a parallel workflow — not this pass)
//     and inside these files the three non-vacuity rows that prove the rig still works are green
//     under every mutant above: §2d here, §3a and §3f in `e9-attack-moderation`.

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

  test('§2a · CLOSED · a co-edit and its revocation: two honest Macs, one op set, ONE board', async () => {
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
    assert.equal(eve['pub.text'], 'Herbstferien',
      'EVE folded both in one batch, so stage 3b withdrew the co-edit — the fold\'s documented behaviour');
    assert.equal(oma['pub.text'], 'Herbstferien',
      'AND SO DOES OMA, who had ALREADY FOLDED that write before the revocation arrived. This is '
      + 'the assertion the finding was: the withdrawal reaches the whole log, not only the ops '
      + 'that had not landed yet.');
    assert.deepEqual({ ...oma, mac: null }, { ...eve, mac: null },
      'TWO HONEST CLIENTS, THE SAME OP SET, THE SAME BOARD — every register, not only the text.');

    // And it is stable: another pull changes nothing on either Mac.
    await converge(C, [C.oma, C.eve, C.oma, C.eve]);
    assert.equal((await regsOf(C.oma, e.key))['pub.text'], 'Herbstferien');
    assert.equal((await regsOf(C.eve, e.key))['pub.text'], 'Herbstferien');

    // ⚠ THE TWO MACS DO NOT HOLD THE SAME LOG, and that is deliberate rather than fixed. Oma
    //   still HOLDS Mama's op — it is history, ADR 006 §1 — and WITHHOLDS it from her register
    //   map; Eve's gate refused the arrival outright and kept nothing. The register maps agree,
    //   which is what convergence means; §2g measures what the difference still costs.
    assert.equal((await opsOn(C.oma, e.key)).length, 3, 'Oma keeps the line and withholds the register');
    assert.equal((await opsOn(C.eve, e.key)).length, 2, 'Eve\'s gate refused the arrival');
    let held = [];
    await on(C.oma, () => { held = C.oma.store.withdrawnOps().map((w) => w.fields); });
    assert.deepEqual(held, [null], 'and Oma can say so: one op withheld whole, reported by id');
    // ── CONFIRMED IN A REAL BROWSER, on the shipped board at http://localhost:4173, in exactly
    //    this shape: Papa's co-editable bar „Herbstferien Nordsee", MAMA co-edits the label
    //    through `store.applyCoEdit` (`pub.label: 'Nordsee, 2 Wochen'`) and it renders; then
    //    Papa's `pub.coEdit: false` arrives in a SEPARATE `applyRemote` batch —
    //      registers().get(key).get('pub.label').value   'Nordsee, 2 Wochen' → 'Herbstferien Nordsee'
    //      state.bars[…].label                           'Nordsee, 2 Wochen' → 'Herbstferien Nordsee'
    //      .bar[title]                       'Nordsee, 2 Wochen · …' → 'Herbstferien Nordsee · …'
    //      document.body.innerText.includes('Nordsee, 2 Wochen')          true → false
    //      store._log.lines() for the entity        2 → 3 — the line is KEPT, not deleted
    //      store.withdrawnOps()                []  →  [{id: <her op>, fields: null}]
    //      store.familyCoEditLevelOf(key)      'geteilt' → null
    //    Screenshotted before and after: the Okt '26 stripe's label changes in place.
  });

  test('§2b · CLOSED · the co-editor loses her own withdrawn write, on her own Mac', async () => {
    // The half that needed no luck at all: my own op enters my own log through `_commit`, so by
    // the time the revocation arrives it is already there and no arrival gate will ever see it
    // again. The repair is not at the gate, so it reaches this op too — and the revocation
    // reaches Mama through `applyRemote`, which hands its verdict straight to the pass.
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
    assert.equal((await regsOf(C.mama, e.key))['pub.text'], 'Ferienhaus',
      'AND MINE. The write the family withdrew is no longer the one my board draws.');
    let row = null;
    await on(C.mama, () => { [row] = boardOf(C, C.mama).filter((n) => n.entityKey === e.key); });
    assert.equal(row.text, 'Ferienhaus', '…in pixels, not only in registers');
    // Her own op is still in her log — it is history, and a re-grant would restore it — but it
    // is withheld from the map by id, which is what she can be shown.
    await on(C.mama, () => {
      const w = C.mama.store.warnings.join('\n');
      assert.match(w, /refused: noCoEdit/, 'her own op comes back from the relay and is refused');
      const mine = [...C.mama.store._log.ops({ includeParked: true })]
        .filter((o) => o.e === e.key && o.act === C.mama.forStore.memberId).map((o) => o.id);
      assert.equal(mine.length, 1, 'NON-VACUITY: her own co-edit op really is still in her log');
      assert.ok(C.mama.store.withdrawnOps().some((w) => w.id === mine[0] && w.fields === null),
        'and the copy that says „nothing here was changed" is now TRUE of her Mac as well as '
        + 'of the family — her own write is withheld whole, and the store names it by id');
    });
  });

  test('§2c · CLOSED · the redaction boundary: no geteiltOnly register stands at Belegt', async () => {
    // Stage 3c: "No non-null `geteiltOnly` value can survive in the register map while the level
    // says otherwise, whatever order the ops arrived in." This is that sentence, driven with two
    // honest clients and no patched seal, in the arrival order that used to falsify it.
    //
    // The ORDER is the only trick, and it is an ordinary one: Papa is offline when he sets the
    // entry to Belegt, so his downgrade carries an OLDER stamp than Mama's co-edit and is pushed
    // AFTER it. Per-field LWW then keeps her text over his null — which is correct at the JOIN,
    // and is exactly why the redaction has to be a property of the fold rather than of the race.
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
    assert.equal(oma['pub.text'], null,
      'AND OMA, who had already folded that text at Geteilt. Stage 3c is retroactive on the '
      + 'RECEIVING device too, which is the whole of the sentence quoted above.');
    assert.deepEqual(oma, eve, 'every register, not only the text');

    let row = null;
    await on(C.oma, () => { [row] = boardOf(C, C.oma).filter((n) => n.entityKey === e.key); });
    assert.equal(row.redacted, true, 'the board still redacts, as it always did');
    assert.equal(row.text ?? null, null,
      '…and the value behind the pixel defence is gone too: not in the materialized entry, not '
      + 'in `registers()`, and not in what the next autosave writes to disk. The pixel defence '
      + 'was the LAST one; the invariant that makes it redundant is back.');
    // The op itself is NOT deleted — ADR 006 §1, the log is history — it is WITHHELD by field.
    let withheld = [];
    await on(C.oma, () => { withheld = C.oma.store.withdrawnOps(); });
    assert.ok(withheld.some((w) => Array.isArray(w.fields) && w.fields.includes('pub.text')),
      'and it is a FIELD-level withholding, not a dropped op: `pub.date` on a Belegt entry is '
      + 'the entire legitimate Belegt payload and must survive the same pass');
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

  test('§2e · CLOSED · convergence is durable: it is a property of the LOG, not of a session', async () => {
    // `registers()` is re-derived from the log on every launch, and the log is what applyRemote
    // wrote — so a relaunch reproduces whatever the fold says, and the fold now says one thing.
    // Measured as the serialized register map, the same byte-comparison the fleet harness uses
    // for "did these two devices converge?".
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
    assert.equal(a, b, 'the two devices\' serialized maps are byte-identical — this is what '
      + '"converged" means, and it is the measurement the fleet harness makes');
    assert.doesNotMatch(a, /Mamas Fassung/,
      'NON-VACUITY: they agree on the WITHDRAWN answer, not on the withdrawn write surviving');
    assert.match(a, /Dauerhaft/, '…and on the owner\'s own value, which is what is left standing');
  });

  test('§2f · 18.5 cannot report this at all: the co-editor is told nothing, on either fold', async () => {
    // ⚠ STILL OPEN, AND NOT FIXED BY THE CONVERGENCE REPAIR. GREEN WHILE THE DEFECT EXISTS.
    //
    // The notice is `displacedBy(store.registers(), …)`, and its third refusal is
    // `cmpWrites(standing, mine) <= 0 → not displaced`. A retroactive WITHDRAWAL does not put a
    // newer write in the cell — it removes mine and leaves the owner's OLDER one standing. Both
    // Macs now agree that it was withdrawn (that is §2a and §2b), and NEITHER can say so: on
    // both folds the co-editor's edit has ceased to exist and the older value is what
    // `displacedBy` compares against, which refusal 3 reads as „my write is the one standing".
    // The only conflict UI in the product is still structurally incapable of naming the one
    // event in E9 that removes somebody's work — it can only name a write that LOST a race, and
    // a withdrawal is not a race. The fix is a notice `displacedBy` cannot express and belongs
    // with `core/registers.js` / `family/conflict.js`, not here.
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
      'Oma\'s fold: the write is gone and the OLDER value stands, which refusal 3 reads as '
      + '„my write is the one standing" — so no notice');
    assert.equal(await ask(C.eve), null, 'Eve\'s fold: identical, and identically silent');
    assert.equal((await regsOf(C.eve, e.key))['pub.text'], 'Anzeige',
      'NON-VACUITY: the edit really did disappear…');
    assert.equal((await regsOf(C.oma, e.key))['pub.text'], 'Anzeige',
      '…on BOTH boards now, which is the fix — and nobody is told on either.');
  });
  test('§2h · CLOSED · an owner\'s own revocation converges, and does not un-say what he already accepted', async () => {
    // THE LOCAL HALF. §2a–§2c all reach the withdrawal through `applyRemote`, which hands its
    // verdict to the repair for free. Here the revocation is a `_commit` on PAPA's own Mac —
    // `txn` → truth register → `derivePublication` → `pub.coEdit: false` — while MAMA's co-edit
    // is already folded into HIS log, pulled minutes earlier. Nothing arrives, so nothing gates.
    //
    // ⚠ WHAT THIS ROW PINS, AND WHY IT IS NOT "his board loses her text". 18.2's promotion
    // (`registers.js:promoteEntity`, ADR 001 §5 step 2) has ALREADY moved her accepted co-edit
    // into his own `note:` truth register — that is what "the family write is promoted over my
    // truth" means — so by the time he can revoke anything, the text is HIS. His revocation
    // therefore re-publishes it under his own name at a NEW stamp, her op is withdrawn on every
    // device including his, and the family converges on a value nobody has to guess at. A
    // withdrawal takes back the PERMISSION; it does not retroactively un-say a sentence the
    // owner's own board has already adopted, and 17.6 attributes the standing write to him.
    // A CIRCLE OF ITS OWN, deliberately: the rows above leave withdrawals in every Mac's log,
    // and `_authzArmed` stays raised while one is in force. A row about NOTICING A NEW ONE has to
    // start from a store that is holding none, or it measures the arming of the previous row.
    const F = await circle(['papa', 'mama', 'oma']);
    const uuid = newUuid();
    let key = '';
    await on(F.papa, async () => {
      assert.equal(F.papa.store.apply('createNoteInline', {
        id: uuid, date: '2026-10-14', text: 'Ferienwohnung', categoryId: 'c1',
      }), true);
      F.papa.store.txn('share', (tx) => { tx.note(uuid).set({ visibility: 'geteilt', coEdit: true }); });
      key = familyKey('fnote', F.papa.forStore.memberId, uuid);
      await F.papa.engine.syncNow();
    });
    await converge(C, [F.mama, F.oma]);

    let herOp = '';
    await on(F.mama, async () => {
      assert.equal(F.mama.store.familyCoEditLevelOf(key), 'geteilt', 'NON-VACUITY: the grant is real');
      assert.equal(F.mama.store.applyCoEdit(key, { 'pub.text': 'Mamas Fassung' }), true);
      herOp = [...F.mama.store._log.ops()].filter((o) => o.e === key
        && o.act === F.mama.forStore.memberId)[0].id;
      await F.mama.engine.syncNow();
    });
    await converge(C, [F.papa, F.oma]);          // PAPA PULLS IT. It is in his log, folded.
    assert.equal((await regsOf(F.papa, key))['pub.text'], 'Mamas Fassung', 'and on his board');
    await laterMs();

    await on(F.papa, () => {
      assert.equal(F.papa.store._authzArmed, false,
        'NON-VACUITY: his store is holding no withdrawal, so nothing is armed. Without '
        + '`_armAuthz` the local commit below would not be looked at.');
    });
    await on(F.papa, async () => {
      F.papa.store.txn('unshare co-edit', (tx) => { tx.note(uuid).set({ coEdit: false }); });
      assert.equal(F.papa.store.registers().get(key).get('pub.coEdit').value, false,
        'the shipped door really did emit the revocation');
      // HER OP IS WITHDRAWN ON HIS OWN MAC, with no pull involved: this is the local half.
      assert.ok(F.papa.store.withdrawnOps().some((w) => w.id === herOp && w.fields === null),
        'her write is withheld from his register map by id — `noCoEdit` on the FINAL registers');
      const cell = F.papa.store.registers().get(key).get('pub.text');
      assert.equal(cell.author, F.papa.forStore.memberId,
        'and what stands in the cell is HIS republication, not her withdrawn op (17.6)');
      assert.notEqual(cell.op, herOp);
      await F.papa.engine.syncNow();
    });
    await converge(C, [F.oma, F.mama]);
    const seen = [];
    for (const m of [F.papa, F.oma, F.mama]) seen.push((await regsOf(m, key))['pub.text']);
    assert.deepEqual(seen, [seen[0], seen[0], seen[0]],
      'THREE MACS, ONE ANSWER — which is the property, whatever the answer turns out to be');
    for (const m of [F.oma, F.mama]) {
      await on(m, () => {
        assert.ok(m.store.withdrawnOps().some((w) => w.id === herOp),
          `${m.tag} is standing on the same withdrawal, not on a coincidence of values`);
      });
    }
  });

  test('§2g · OPEN · a re-grant reaches the Mac that HELD the write and not the one that dropped it', async () => {
    // THE RESIDUAL, and it is at the GATE rather than in the fold. A retroactively-refused
    // ARRIVAL is still dropped instead of parked, so the two Macs converge on the withdrawn state
    // (§2a) and then part company if the owner changes his mind: Oma, who folded the write before
    // the revocation, still HOLDS the line and re-admits it; Eve, whose gate refused the arrival,
    // has nothing left to re-admit.
    //
    // Closing it is F-6's shape exactly — `applyRemote` must PARK such an arrival — and that
    // needs a `PARK_REASONS.WITHDRAWN` in `core/ops.js`, which `oplog.js:park()` validates
    // against and which belongs to another owner this round. GREEN WHILE THE GAP EXISTS: if this
    // row goes red the gap was probably closed, so invert it.
    const e = await share(C, { 'pub.coEdit': true, 'pub.text': 'Rueckgabe' });
    await converge(C, [C.mama, C.oma, C.eve]);
    await on(C.mama, async () => {
      C.mama.store.applyCoEdit(e.key, { 'pub.text': 'Mamas Fassung' });
      await C.mama.engine.syncNow();
    });
    await converge(C, [C.oma]);                      // Oma folds it; Eve has not pulled at all
    await laterMs();
    await on(C.papa, async () => {
      await C.papa.engine.syncNow();
      await patchedOp(C, C.papa, mkPubSet(C, C.papa, e.key, { 'pub.coEdit': false }));
    });
    await converge(C, [C.oma, C.eve]);
    assert.equal((await regsOf(C.oma, e.key))['pub.text'], 'Rueckgabe', 'converged (that is §2a)');
    assert.equal((await regsOf(C.eve, e.key))['pub.text'], 'Rueckgabe');

    await laterMs();
    await on(C.papa, async () => {
      await patchedOp(C, C.papa, mkPubSet(C, C.papa, e.key, { 'pub.coEdit': true }));
    });                                              // he changes his mind
    await converge(C, [C.oma, C.eve]);
    assert.equal((await regsOf(C.oma, e.key))['pub.text'], 'Mamas Fassung',
      'OMA: she kept the line, so the fold re-admits it — which is what `foldAuthorized` says '
      + 'should happen on EVERY device');
    assert.equal((await regsOf(C.eve, e.key))['pub.text'], 'Rueckgabe',
      'EVE: her gate dropped the arrival, so there is nothing to re-admit. The register maps '
      + 'differ again, and the cause is the GATE\'s drop, not the fold.');
  });
});
