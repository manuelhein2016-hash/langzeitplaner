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
//   §4c  make the entry converge to a state neither author wrote → **SUCCEEDED**, with no
//        patched client anywhere: two honest co-editors, two ordinary drags, and 18.5 has no
//        loser to tell because per-field LWW gave each of them the field they asked for.
//   §4d  the standing bar: zero bytes of a Privat entry, through every write path E9 opened
//                                                              → FAILED (the boundary held)
//
// §1i of `e9-attack-coedit.test.js` is 18.6's other half — a restore that resurrects a version
// its author never wrote — and is not repeated here.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// DISPOSITION — §4c is an OPEN FINDING, GREEN while the defect exists. IF IT GOES RED THE DEFECT
// WAS PROBABLY FIXED: invert it, do not repair it. It is emphatically not covered by D7 — there
// is no patched client, no forged op and no adversary in it at all. It is what the product does
// when two people who were invited to co-edit both use the feature.
//
// THE MUTANT — one run, scratch copy:
//   M-D1  `core/project.js:projectCoEditPatch` refuses a `pub.startDate` / `pub.endDate` write
//         that would invert the bar against the entity's OTHER folded date register (the
//         cheapest shape of a fix; not proposed as the fix — the honest one is an ordering
//         invariant in `materialize.js`, which is where a bar's two dates finally meet).
//                                                                         → §4c goes RED.
// ═════════════════════════════════════════════════════════════════════════════════════════════

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
  test('§4c · SUCCEEDED · two honest drags converge to an inverted bar, and the bar leaves every board', async () => {
    // MAMA and OMA are both invited co-editors of Papa's family holiday bar. Mama drags the
    // RIGHT edge out; Oma, whose Mac has not seen that yet, drags the LEFT edge out. Each writes
    // exactly one field, through `store.applyCoEdit` — the shipped door, no patch, no forgery.
    //
    // Per-field LWW then does precisely what 18.5 promises: each of them keeps the field they
    // wrote. Nobody's write was displaced, so nobody lost, so — correctly, by the rule as
    // written — nobody is told anything. The result is a bar that starts after it ends.
    const e = await papaBar(C, { startDate: '2026-10-05', endDate: '2026-10-19', label: 'Herbstferien' });
    // The earlier rows left refusals in his warning list; this row's claim is about what THIS
    // event tells him, so the slate is cleared here rather than asserted empty by luck.
    await on(C.papa, () => { C.papa.store.warnings.length = 0; });

    await on(C.mama, async () => {
      assert.equal(C.mama.store.familyCoEditLevelOf(e.key), 'geteilt');
      assert.equal(C.mama.store.applyCoEdit(e.key, { 'pub.endDate': '2026-12-20' }), true,
        'she drags the right edge into December');
      await C.mama.engine.syncNow();
    });
    await on(C.oma, async () => {
      assert.equal(C.oma.store.applyCoEdit(e.key, { 'pub.startDate': '2027-03-01' }), true,
        'he drags the left edge into next March');
      await C.oma.engine.syncNow();
    });
    await converge(C, [C.papa, C.mama, C.oma]);

    const regs = await regsOf(C.papa, e.key);
    assert.equal(regs['pub.endDate'], '2026-12-20', 'Mama kept her field');
    assert.equal(regs['pub.startDate'], '2027-03-01', 'Oma kept his');
    assert.ok(regs['pub.startDate'] > regs['pub.endDate'],
      'AND THE BAR NOW STARTS AFTER IT ENDS — a state neither of them wrote, and neither can see');

    // What that costs, measured on the owner's own board.
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
        for (const s of (col.segments || col.segs || [])) {
          if (s.bar && (s.bar.entityKey === e.key || s.bar.id === e.uuid)) segs++;
        }
      }
    });
    assert.equal(bars.length, 1, 'the entry still exists');
    assert.equal(bars[0].startDate, '2027-03-01');
    assert.equal(bars[0].endDate, '2026-12-20',
      'and the OWNER\'s own board reads the inverted pair too — `promoteEntity` promotes the '
      + 'family write over his truth register, which is 18.2 working exactly as designed');
    assert.equal(segs, 0,
      'and it draws NOTHING: zero segments in twelve months. The family holiday bar both of them '
      + 'were invited to drag is gone from the calendar, silently, for everybody.');
    // ── CONFIRMED IN A REAL BROWSER, on the shipped board at http://localhost:4173 ──────────
    //   a 6 × 327 px stripe labelled „Herbstferien Nordsee" in Okt '26, then two writes — one
    //   `startDate`, one `endDate`, neither of them a pair —
    //     #board .bar          2 → 1
    //     #board .bar-label    ['Herbstferien Nordsee', 'Sommerferien'] → ['Sommerferien']
    //     store.state.bars     the entry is STILL THERE
    //     document.body.innerText.includes('Herbstferien Nordsee')   → false
    //     #board .col          12, unchanged — the board does not even reflow
    //   and it survives a reload. Screenshotted before and after, in transcript.

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
