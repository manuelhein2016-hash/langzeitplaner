// FLEET · E9-D — DELETE, RESTORE, AND THE STATE NEITHER AUTHOR WROTE.
// Stories 18.5, 18.6, 16.1/16.2 (the standing bar) · ADR 001 §5 (per-field LWW), §7.1 (undo) ·
// ADR 004 §2.2, §4.2 · `family/conflict.js` · `core/registers.js:displacedBy`.
//
// 18.6: "Deletions propagate to all boards; my undo of my own deletion restores the entry as a
// new shared operation, so even destructive acts stay reversible FOR THEIR AUTHOR."
// 18.5: "the later change wins PER FIELD … and ONLY the person whose in-flight edit lost sees a
// quiet inline notice."
//
// The four asks, one section each:
//
//   §4a  restore somebody else's deletion                       → FAILED
//   §4b  make a delete unrecoverable for its author             → FAILED
//   §4c  make the entry converge to a state neither author wrote → **HALF CLOSED**
//   §4d  the standing bar: zero bytes of a Privat entry, through every write path E9 opened
//                                                              → FAILED (the boundary held)
//
// §1i of `e9-attack-coedit.test.js` is 18.6's other half — a restore that resurrects a version
// its author never wrote — and is not repeated here.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// DISPOSITION — §4c IS SPLIT, AND ONLY ONE HALF IS CLOSED. READ THIS BEFORE TRUSTING A GREEN RUN
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// A `fbar` has a value NO SINGLE FIELD OWNS: `pub.startDate` and `pub.endDate` are each a
// register with its own stamp and its own per-field LWW winner, and between the two of them sits
// an ordering nothing in the register model enforces. Two invited co-editors, one edge each, and
// the bar converges to `start 2027-03-01 / end 2026-12-20`. `buildBoard` emits ZERO segments and
// the entry leaves every board in the family — silently, because per-field LWW gave each of them
// the field they asked for, so nobody lost and 18.5 correctly tells nobody anything.
//
//   §4c   CLOSED (inverted). `store.applyCoEdit` — the ONE door `interact.js` may use — now
//         declines a co-edit that would invert the bar AS THIS MAC FOLDS IT. That is the half a
//         door can honestly promise, and it is the half the original row exercised: Oma's drag
//         was already inverted where she made it.
//
//   §4c-b OPEN (`SUCCEEDED`, green while the defect exists — IF IT GOES RED, INVERT IT). Two
//         writes that are each ordered where they were MADE still converge to an inverted pair,
//         and no author-side predicate anywhere can see that, because neither author holds the
//         other's write. Emphatically not covered by D7: no patched client, no forged op, no
//         adversary — it is what the product does when two invited people use the feature.
//
// WHERE THE REMAINING HALF BELONGS, and why it is not in this pass: `core/materialize.js`,
// beside ADR 001 §5 step 7's dangling-category repair, as a PROJECTION INVARIANT rather than a
// mutation — "a bar whose folded `startDate` is after its folded `endDate` projects with its
// interval repaired from the later-stamped of the two registers". It has to live there for the
// same reason the category repair does: it is a pure function of the register map, so every
// device computes the same answer with nothing to synchronise, and an unrenderable entry is
// repaired rather than dropped. That file belongs to another owner this round.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE MUTANTS — one run each, scratch copy
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   M-D1  `store.js:_intervalStaysOrdered` — `return true;` at the top.
//           dies  §4c, ALONE (scratch copy, `--test-concurrency=1`, baseline 33/33).
//                 §4c-b unmoved, which is the point: the guard is not the fix.
//
//   M-D2  the same function, comparing only the CALLER'S OWN patch and never the folded other
//         edge (`const start = changes['pub.startDate']` with no fallback) — a guard that cannot
//         see the edge the gesture did not touch.
//           dies  §4c, ALONE. So the row measures the READ of the other register, not merely the
//                 presence of a comparison.
//
//   M-D3  the same function, without the "already inverted ⇒ allow" clause — a guard that judges
//         the RESULT rather than the CHANGE.
//           dies  §4c-c, ALONE, and in the real engine `tests/tier2/e9-demonstration.dom.js`
//                 row 2d ("ONLY the loser") goes red with it, because a whole-bar drag over a
//                 bar a peer's single-field write has just inverted is exactly that gesture.
//                 Without the clause the fix is WORSE than the defect: the entry that draws
//                 nothing becomes the entry nobody can move.
//
//   HONEST-PATH CONTROL: §4a, §4b and §4d are green under all three mutants and under the fix,
//   and `npm test` (2117) / `npm run test:attack` (920) are unmoved.

import '../helpers/env.js';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { entityUuid as newUuid } from '../../src/js/core/ids.js';
import { familyKey } from '../../src/js/core/ops.js';
import { materialize } from '../../src/js/core/materialize.js';
import { buildBoard } from '../../src/js/layout.js';
import { displacedBy } from '../../src/js/core/registers.js';

import {
  circle, converge, on, mkPubSet, patchedOp, regsOf, boardOf,
} from './e9-attack-kit.js';

/** PAPA creates a real bar through the shipped mutations and opens it for co-editing. */
async function papaBar(C, { startDate, endDate, label }) {
  const id = newUuid();
  await on(C.papa, async () => {
    assert.equal(C.papa.store.apply('createBar', {
      id, startDate, endDate, categoryId: 'c1', visibility: 'geteilt',
    }), true);
    C.papa.store.txn('label', (tx) => { tx.bar(id).set({ label, coEdit: true }); });
    await C.papa.engine.syncNow();
  });
  await converge(C, [C.mama, C.oma]);
  return { uuid: id, key: familyKey('fbar', C.papa.forStore.memberId, id) };
}

async function papaNote(C, { text, level = 'geteilt', coEdit = true }) {
  const id = newUuid();
  await on(C.papa, async () => {
    assert.equal(C.papa.store.apply('createNoteInline', {
      id, date: '2026-10-14', text, categoryId: 'c1',
    }), true);
    if (level !== 'privat') {
      C.papa.store.txn('share', (tx) => {
        tx.note(id).set(level === 'geteilt' ? { visibility: level, coEdit } : { visibility: level });
      });
    }
    await C.papa.engine.syncNow();
  });
  await converge(C, [C.mama, C.oma]);
  return { uuid: id, key: familyKey('fnote', C.papa.forStore.memberId, id) };
}

describe('E9-D · 18.6, 18.5, and the redaction boundary through the new write paths', () => {
  let C = null;
  before(async () => { C = await circle(['papa', 'mama', 'oma']); });

  test('§4a · FAILED · 18.6 · a co-editor cannot restore somebody else\'s deletion', async () => {
    const e = await papaNote(C, { text: 'Skiwoche' });
    await on(C.papa, async () => {
      C.papa.store.apply('deleteNotePopover', { id: e.uuid });
      await C.papa.engine.syncNow();
    });
    await converge(C, [C.mama, C.oma]);
    assert.equal((await regsOf(C.oma, e.key))['pub.alive'], false, 'the deletion propagated');

    await on(C.mama, () => {
      assert.equal(C.mama.store.applyCoEdit(e.key, { 'pub.alive': true }), false,
        'the shipped door has no field that could carry it');
    });
    await on(C.mama, () => patchedOp(C, C.mama, mkPubSet(C, C.mama, e.key, { 'pub.alive': true })));
    await converge(C, [C.papa, C.oma]);
    for (const m of [C.papa, C.oma]) {
      assert.equal((await regsOf(m, e.key))['pub.alive'], false,
        `${m.tag} let a co-editor un-delete the owner's entry`);
    }
  });

  test('§4b · FAILED · 18.6 · the author can still recover their own deletion', async () => {
    // Three ways to try to take that away: a co-editor writing while it is dead (§1i's op, whose
    // damage is to the CONTENT and not to the recoverability), an admin moderating the corpse,
    // and a co-editor's own delete. None of them costs the owner the restore.
    const e = await papaNote(C, { text: 'Zeugniskonferenz' });
    await on(C.papa, async () => {
      C.papa.store.apply('deleteNotePopover', { id: e.uuid });
      await C.papa.engine.syncNow();
    });
    await converge(C, [C.mama, C.oma]);
    await on(C.mama, () => patchedOp(C, C.mama, mkPubSet(C, C.mama, e.key, { 'pub.alive': false })));
    await converge(C, [C.papa]);

    await on(C.papa, async () => {
      assert.notEqual(C.papa.store.undo(), false, 'his ⌘Z is his own and it works');
      await C.papa.engine.syncNow();
      const [row] = C.papa.store.state.notes.filter((n) => n.id === e.uuid);
      assert.ok(row, 'the entry is back on his board');
      assert.equal(row.text, 'Zeugniskonferenz');
    });
    await converge(C, [C.oma]);
    assert.equal((await regsOf(C.oma, e.key))['pub.alive'], true,
      '…and 18.6\'s "restores it as a NEW shared operation" reached the family');
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  test('§4c · CLOSED · the shipped door declines a drag that would invert the bar it can see', async () => {
    // MAMA and OMA are both invited co-editors of Papa's family holiday bar. Mama drags the
    // RIGHT edge out; Oma, whose Mac has not seen that yet, drags the LEFT edge out — past the
    // right edge SHE CAN SEE. Each write goes through `store.applyCoEdit`, the shipped door, no
    // patch and no forgery.
    //
    // The second gesture is now DECLINED, the same way a withdrawn grant is declined: `false`,
    // no op, a warning in the store's own list. A bar that starts after it ends draws nothing at
    // all, so refusing is strictly better than folding it.
    const e = await papaBar(C, { startDate: '2026-10-05', endDate: '2026-10-19', label: 'Herbstferien' });
    await on(C.papa, () => { C.papa.store.warnings.length = 0; });

    await on(C.mama, async () => {
      assert.equal(C.mama.store.familyCoEditLevelOf(e.key), 'geteilt');
      assert.equal(C.mama.store.applyCoEdit(e.key, { 'pub.endDate': '2026-12-20' }), true,
        'she drags the right edge into December — ordered, and folded');
      await C.mama.engine.syncNow();
    });
    let ops = 0;
    await on(C.oma, async () => {
      ops = [...C.oma.store._log.ops({ includeParked: true })].length;
      assert.equal(C.oma.store.applyCoEdit(e.key, { 'pub.startDate': '2027-03-01' }), false,
        'his drag of the LEFT edge into next March would start the bar after it ends — declined');
      assert.equal([...C.oma.store._log.ops({ includeParked: true })].length, ops,
        '0 ops authored: a declined gesture is not a folded one');
      assert.match(C.oma.store.warnings.join('\n'), /co-edit declined/,
        '…and he is told, rather than left wondering why the bar did not move');
      await C.oma.engine.syncNow();
    });
    await converge(C, [C.papa, C.mama, C.oma]);

    const regs = await regsOf(C.papa, e.key);
    assert.equal(regs['pub.endDate'], '2026-12-20', 'Mama kept her field');
    assert.equal(regs['pub.startDate'], '2026-10-05', 'and the start is still Papa\'s');
    assert.ok(regs['pub.startDate'] <= regs['pub.endDate'], 'the bar is ordered');

    // …and it still draws. This is the measurement the finding was: it used to be 0.
    let segs = 0;
    let bars = null;
    await on(C.papa, () => {
      const r = C.papa.store.registers();
      const st = materialize(r, {
        me: C.papa.forStore.memberId, familySpaceId: C.spaceId,
        ...C.papa.store._memberCtx(r), defaultSettings: C.papa.store.state.settings,
      });
      bars = st.bars.filter((b) => b.entityKey === e.key || b.id === e.uuid);
      const board = buildBoard(st, { today: '2026-10-01' });
      for (const col of (board.columns || board.cols || [])) {
        for (const seg of (col.segments || col.segs || [])) {
          if (seg.bar && (seg.bar.entityKey === e.key || seg.bar.id === e.uuid)) segs++;
        }
      }
    });
    assert.equal(bars.length, 1, 'the entry exists');
    assert.ok(segs > 0, `and it DRAWS: ${segs} segment(s), where the finding measured 0`);
  });

  test('§4c-b · SUCCEEDED · two drags that are each ordered where they were made still invert the bar', async () => {
    // THE RESIDUAL, and it is why `_intervalStaysOrdered` is not the fix. The bar runs from Okt
    // '26 to Jun '27. Mama pulls the right edge IN to 1 Nov (ordered: 10-05 ≤ 11-01). Oma, who
    // has not seen that, pushes the left edge OUT to 1 Mrz (ordered against the 2027-06-30 end
    // HE can still see). Both gestures are legal where they are made
    // and no author-side predicate anywhere can see otherwise, because neither author holds the
    // other's write. Per-field LWW then gives each of them the field they asked for — correctly,
    // and 18.5 correctly tells nobody anything — and the bar starts after it ends.
    //
    // OPEN. The convergent half belongs in `core/materialize.js` as a projection invariant; see
    // the DISPOSITION at the top of this file. GREEN WHILE THE DEFECT EXISTS — if this row goes
    // red the defect was probably fixed, so INVERT IT, do not repair it.
    const e = await papaBar(C, { startDate: '2026-10-05', endDate: '2027-06-30', label: 'Sommerferien' });
    await on(C.papa, () => { C.papa.store.warnings.length = 0; });

    await on(C.mama, async () => {
      assert.equal(C.mama.store.applyCoEdit(e.key, { 'pub.endDate': '2026-11-01' }), true,
        'ordered against the 10-05 start she can see');
      await C.mama.engine.syncNow();
    });
    await on(C.oma, async () => {
      assert.equal(C.oma.store.applyCoEdit(e.key, { 'pub.startDate': '2027-03-01' }), true,
        'ordered against the 2027-06-30 end HE can see — he has not pulled hers');
      await C.oma.engine.syncNow();
    });
    await converge(C, [C.papa, C.mama, C.oma]);

    const regs = await regsOf(C.papa, e.key);
    assert.equal(regs['pub.endDate'], '2026-11-01', 'Mama kept her field');
    assert.equal(regs['pub.startDate'], '2027-03-01', 'Oma kept his');
    assert.ok(regs['pub.startDate'] > regs['pub.endDate'],
      'AND THE BAR STARTS AFTER IT ENDS — a state neither of them wrote, and neither can see');

    let bars = null;
    let segs = 0;
    await on(C.papa, () => {
      const r = C.papa.store.registers();
      const st = materialize(r, {
        me: C.papa.forStore.memberId, familySpaceId: C.spaceId,
        ...C.papa.store._memberCtx(r), defaultSettings: C.papa.store.state.settings,
      });
      bars = st.bars.filter((b) => b.entityKey === e.key || b.id === e.uuid);
      const board = buildBoard(st, { today: '2026-10-01' });
      for (const col of (board.columns || board.cols || [])) {
        for (const seg of (col.segments || col.segs || [])) {
          if (seg.bar && (seg.bar.entityKey === e.key || seg.bar.id === e.uuid)) segs++;
        }
      }
    });
    assert.equal(bars.length, 1, 'the entry still exists');
    assert.equal(bars[0].startDate, '2027-03-01');
    assert.equal(bars[0].endDate, '2026-11-01',
      'and the OWNER\'s own board reads the inverted pair too — `promoteEntity` promotes the '
      + 'family write over his truth register, which is 18.2 working exactly as designed');
    assert.equal(segs, 0,
      'and it draws NOTHING: zero segments in twelve months. The family holiday bar both of them '
      + 'were invited to drag is gone from the calendar, silently, for everybody.');
    // ── RE-CONFIRMED IN A REAL BROWSER, on the shipped board at http://localhost:4173, after
    //    the §4c door guard landed — because the guard does NOT close this and must not be read
    //    as if it had. Papa's bar 2026-10-05 → 2027-06-30, then two OWNER-side single-field
    //    writes (`pub.endDate: 2026-11-01`, then `pub.startDate: 2027-03-01`), each ordered
    //    against the pair its author could see, delivered in two batches:
    //      .bar[data-bar-id=<key>]                                  9 → 0
    //      store.state.bars                                the entry is STILL THERE
    //      state.bars[…] span                     ['2027-03-01', '2026-11-01'] — inverted
    //      document.body.innerText.includes('Herbstferien Nordsee')     true → false
    //      .col                                    12, unchanged — the board does not reflow
    //    and the shipped door still repairs it (`applyCoEdit({'pub.endDate':'2027-05-01'})`
    //    → true, 0 → 3 segments), which is §4c-c. Screenshotted before and after, in transcript.

    // 18.5 has nothing to say about it, and that is the rule working as written.
    const ask = async (mac, field) => {
      let d = null;
      await on(mac, () => {
        const cell = mac.store.registers().get(e.key).get(field);
        d = displacedBy(mac.store.registers(), e.key, field,
          { stamp: cell.stamp, op: cell.op, value: cell.value }, mac.forStore.memberId);
      });
      return d;
    };
    assert.equal(await ask(C.mama, 'pub.endDate'), null, 'Mama was not displaced: no notice');
    assert.equal(await ask(C.oma, 'pub.startDate'), null, 'Oma was not displaced: no notice');
    await on(C.papa, () => {
      assert.deepEqual(C.papa.store.warnings, [],
        'and the OWNER — whose bar it is, and who wrote neither field — is told nothing at all');
    });
  });

  test('§4c-c · the guard refuses to CREATE an inversion, never to live with one', async () => {
    // The clause that stops §4c's guard from being worse than the defect. Once §4c-b has
    // happened — or once a peer's single-field write lands between the pointer going down and
    // coming up — the bar this Mac folds is already inverted. Refusing every further write there
    // would WEDGE the entry: the gesture that could repair it would be declined by the state it
    // is trying to repair, and the bar that draws nothing would also be the bar nobody can move.
    // Measured in the real engine too, by `tests/tier2/e9-demonstration.dom.js` row 2d.
    const e = await papaBar(C, { startDate: '2026-10-05', endDate: '2027-06-30', label: 'Verklemmt' });
    await on(C.mama, async () => {
      assert.equal(C.mama.store.applyCoEdit(e.key, { 'pub.endDate': '2026-11-01' }), true);
      await C.mama.engine.syncNow();
    });
    await on(C.oma, async () => {
      assert.equal(C.oma.store.applyCoEdit(e.key, { 'pub.startDate': '2027-03-01' }), true);
      await C.oma.engine.syncNow();
    });
    await converge(C, [C.papa, C.mama, C.oma]);
    const broken = await regsOf(C.papa, e.key);
    assert.ok(broken['pub.startDate'] > broken['pub.endDate'], 'precondition: it is inverted');

    // …and it can still be MOVED, which is the gesture that would otherwise be impossible: a
    // whole-bar drag writes both edges and preserves the (now negative) duration, so the result
    // is still inverted and every predicate that only looked at the RESULT would decline it.
    await on(C.mama, async () => {
      assert.equal(C.mama.store.applyCoEdit(e.key, {
        'pub.startDate': '2027-04-01', 'pub.endDate': '2027-02-01',
      }), true, 'a move of an already-inverted bar is not the gesture that broke it');
      await C.mama.engine.syncNow();
    });
    await converge(C, [C.papa]);
    const moved = await regsOf(C.papa, e.key);
    assert.equal(moved['pub.startDate'], '2027-04-01', 'and it really moved');
    // …and it can still be repaired, by either edge, through the same door.
    await on(C.mama, async () => {
      assert.equal(C.mama.store.applyCoEdit(e.key, { 'pub.endDate': '2027-05-01' }), true,
        'pushing the END back past the start is allowed — it REPAIRS the interval');
      await C.mama.engine.syncNow();
    });
    await converge(C, [C.papa, C.oma]);
    const fixed = await regsOf(C.papa, e.key);
    assert.equal(fixed['pub.startDate'], '2027-04-01');
    assert.equal(fixed['pub.endDate'], '2027-05-01');
    assert.ok(fixed['pub.startDate'] <= fixed['pub.endDate'], 'and the bar is ordered again');
  });

  test('§4d · FAILED · the standing bar: not one byte of a Privat entry, after all of the above', async () => {
    const SECRET = 'Vorstellungsgespraech 14 Uhr';
    let privatKey = '';
    await on(C.papa, async () => {
      const id = newUuid();
      assert.equal(C.papa.store.apply('createNoteInline', {
        id, date: '2026-11-03', text: SECRET, categoryId: 'c1',
      }), true);
      privatKey = familyKey('fnote', C.papa.forStore.memberId, id);
      assert.equal(C.papa.store.familyLevelOf(privatKey), 'privat', 'NON-VACUITY: it really is Privat');
      await C.papa.engine.syncNow();
    });
    await converge(C, [C.mama, C.oma]);

    // Every peer's whole world.
    for (const m of [C.mama, C.oma]) {
      await on(m, () => {
        const seen = [];
        for (const [key, cells] of m.store.registers()) {
          for (const [f, cell] of cells) {
            if (typeof cell.value === 'string' && cell.value.includes(SECRET)) seen.push(`${key}.${f}`);
          }
        }
        assert.deepEqual(seen, [], `${m.tag}'s register map`);
        for (const op of m.store._log.ops({ includeParked: true })) {
          assert.ok(!JSON.stringify(op.f).includes(SECRET), `${m.tag} holds an op carrying it`);
        }
        assert.equal(m.store.registers().has(privatKey), false,
          `${m.tag} does not even hold the entity KEY of a Privat entry`);
      });
    }
    // THE WIRE — every op the relay will hand anybody who asks, read back through the real route.
    const served = await C.oma.transport.request(
      'GET', '/api/v1/ops', { space: C.spaceId, since: '0', limit: '500' }, null, {});
    assert.equal(served.status, 200);
    const wire = JSON.stringify(served.json);
    assert.ok(wire.length > 500, `NON-VACUITY: the relay really is serving ops (${wire.length} B)`);
    assert.ok(!wire.includes(SECRET), 'the relay serves the Privat text to nobody');
    assert.ok(!wire.includes('Zeugniskonferenz'),
      '…and not the SHARED text either: every body is an opaque envelope');
    // The author's own outbox: the entry must never even be offered.
    await on(C.papa, () => {
      const offered = JSON.stringify(C.papa.store.familyOutbox());
      assert.ok(!offered.includes(SECRET), 'the author\'s family outbox');
      assert.equal(C.papa.store.redactionHalt, null, 'and no barrier had to fire to keep it out');
    });
  });
});
