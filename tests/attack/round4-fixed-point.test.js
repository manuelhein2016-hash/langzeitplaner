// ─────────────────────────────────────────────────────────────────────────────
// ROUND 4 — ADVERSARY, ATTACK 5: F-1's REORDERING
//
// The PO ruled FIX and accepted a one-time rewrite of every existing user's `board.json`.
// `reconcileMap` now deletes and re-inserts every scratchpad key so the live map carries the
// projection's key order. This file tries to break the claim it bought — `board.json` IS a fixed
// point — with the gestures a real session makes, and to prove the fix cost nothing else its
// order.
//
// It holds, and the interesting part is WHERE the boundary is. §1 and §2 are the ropes: two
// restarts, pads written in reverse-sorted order, entries created out of order, an import, an
// undo, a category delete with its reassignment fan-out. Nothing moves. §3 pins the two shapes
// where `board.json` still is not a fixed point and separates them honestly:
//
//   · `setLayer` with no Bundesland, and `setSettings({layers})`'s wholesale replace — NOT F-1's
//     doing. The FROZEN v1 store is not a fixed point for either of them either, at exactly the
//     same two bytes, so this is parity and F-1's ruling never claimed it.
//   · a scratchpad the file holds as `''` — v1 IS a fixed point here and v2 is not. That one is
//     v2's, and it is the same `migrate1to2.js:1204` line as `round4-coercion-oracle.js` R4-11.
//
// §4 is the control that stops "reorder everything on every projection" passing as a fix: the
// scratchpad MAP keeps its object identity, and so does every entry object, which is note 3 of
// `store.js`'s header and what `dom-rendering.dom.js:816` depends on.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { LS, LS_BOARD, v1store, v2store, bootV1, bootV2, v1board, note, bar } from './_upgrade-harness.js';

const J = (v) => JSON.stringify(v);
const BASE = () => v1board({
  notes: [note('n1', '2026-03-04', 'Zahnarzt'), note('n2', '2026-01-02', 'Steuer')],
  bars: [bar('b1', '2026-02-01', '2026-02-10', 'Urlaub')],
  scratchpads: { '2026-05': 'Milch' },
});

/** Run `work` on a freshly booted store, then persist across three generations of the file. */
async function generations(work, { board = BASE(), boot = bootV2, store = () => v2store } = {}) {
  LS.clear();
  LS.setItem(LS_BOARD, J(board));
  await boot();
  await work(store());
  await store().persistNow();
  const g0 = LS.getItem(LS_BOARD);
  await boot(); await store().persistNow();
  const g1 = LS.getItem(LS_BOARD);
  await boot(); await store().persistNow();
  const g2 = LS.getItem(LS_BOARD);
  return { g0, g1, g2 };
}

const firstDiff = (a, b) => {
  const A = JSON.parse(a); const B = JSON.parse(b);
  return Object.keys(A).filter((k) => J(A[k]) !== J(B[k]));
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE CLAIM — two restarts, pads written in the worst order available
// ─────────────────────────────────────────────────────────────────────────────

describe('R4-17 · board.json across two restarts', () => {
  test('R4-17a HELD · pads added in reverse-sorted order land sorted and stay sorted', async () => {
    const { g0, g1, g2 } = await generations(async (s) => {
      for (const m of ['2026-12', '2026-01', '2026-07', '2025-11', '2026-03']) {
        s.mutate('pad', (st) => { st.scratchpads[m] = `Text ${m}`; });
      }
    });
    assert.equal(g0, g1, `gen0 !== gen1 at ${firstDiff(g0, g1)}`);
    assert.equal(g1, g2, `gen1 !== gen2 at ${firstDiff(g1, g2)}`);
    assert.deepEqual(Object.keys(JSON.parse(g0).scratchpads),
      ['2025-11', '2026-01', '2026-03', '2026-05', '2026-07', '2026-12'],
      'the LIVE map already carries the projection\'s key order — that is the fix');
  });

  test('R4-17b HELD · a pad added AFTER a restart still lands in sort order, not at the end', async () => {
    LS.clear();
    LS.setItem(LS_BOARD, J(BASE()));
    await bootV2();
    for (const m of ['2026-12', '2026-03']) v2store.mutate('pad', (s) => { s.scratchpads[m] = m; });
    await v2store.persistNow();
    await bootV2();
    v2store.mutate('pad', (s) => { s.scratchpads['2025-01'] = 'ganz früh'; });
    await v2store.persistNow();
    const live = LS.getItem(LS_BOARD);
    assert.deepEqual(Object.keys(JSON.parse(live).scratchpads), ['2025-01', '2026-03', '2026-05', '2026-12']);
    await bootV2(); await v2store.persistNow();
    assert.equal(LS.getItem(LS_BOARD), live, 'and the restart changes nothing');
  });

  const GESTURES = {
    'nothing at all': async () => {},
    'a note and a bar created through apply()': async (s) => {
      s.apply('createNoteInline', { id: 'nx', date: '2026-04-04', text: 'neu', categoryId: s.state.categories[0].id });
      s.apply('createBar', { id: 'bx', startDate: '2026-07-01', endDate: '2026-07-05', label: 'L', categoryId: s.state.categories[0].id });
    },
    'a note created BEFORE an existing one in date order': async (s) => {
      s.apply('createNoteInline', { id: 'n0', date: '2025-12-24', text: 'früher', categoryId: s.state.categories[0].id });
    },
    'an edit and its undo': async (s) => { s.mutate('e', (st) => { st.notes[0].text = 'geändert'; }); s.undo(); },
    'an edit, its undo and its redo': async (s) => { s.mutate('e', (st) => { st.notes[0].text = 'geändert'; }); s.undo(); s.redo(); },
    'a pad deleted and re-added': async (s) => {
      s.mutate('a', (st) => { delete st.scratchpads['2026-05']; });
      s.mutate('b', (st) => { st.scratchpads['2026-05'] = 'wieder da'; });
    },
    'a category deleted with its reassignment fan-out': async (s) => {
      const gone = s.state.categories[1].id;
      s.apply('deleteCategory', { id: gone, reassignTo: s.state.categories[0].id, lastCategoryId: s.state.categories[0].id });
    },
    'an import over the top': async (s) => {
      s.replaceAll(v1board({ notes: [note('m1', '2026-06-06', 'Import')], scratchpads: { '2026-09': 'z', '2026-02': 'y' } }));
    },
    'a settings write that is not about layers': async (s) => { s.setSettings({ rowHeight: 30, bundesland: 'BY' }); },
  };
  for (const [what, work] of Object.entries(GESTURES)) {
    test(`R4-17 HELD · ${what}`, async () => {
      const { g0, g1, g2 } = await generations(work);
      assert.equal(g0, g1, `gen0 !== gen1 at ${firstDiff(g0, g1)}`);
      assert.equal(g1, g2, `gen1 !== gen2 at ${firstDiff(g1, g2)}`);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. AND NOTHING ELSE'S ORDER MOVED
// ─────────────────────────────────────────────────────────────────────────────

describe('R4-18 · the fix reordered the pads and nothing else', () => {
  test('R4-18a HELD · array order and per-entry key order are the same before and after a restart', async () => {
    const { g0, g1 } = await generations(async (s) => {
      s.apply('createNoteInline', { id: 'n0', date: '2025-12-24', text: 'früher', categoryId: s.state.categories[0].id });
      s.apply('createBar', { id: 'b0', startDate: '2026-01-05', endDate: '2026-01-09', label: 'Y', categoryId: s.state.categories[0].id });
      s.mutate('pad', (st) => { st.scratchpads['2025-11'] = 'x'; });
    });
    const A = JSON.parse(g0); const B = JSON.parse(g1);
    assert.deepEqual(B.notes.map((n) => n.id), A.notes.map((n) => n.id), 'note array order');
    assert.deepEqual(B.bars.map((b) => b.id), A.bars.map((b) => b.id), 'bar array order');
    assert.deepEqual(B.categories.map((c) => c.id), A.categories.map((c) => c.id), 'category array order');
    assert.deepEqual(Object.keys(B.notes[0]), Object.keys(A.notes[0]), 'per-entry key order');
    assert.deepEqual(Object.keys(B.bars[0]), Object.keys(A.bars[0]));
    assert.deepEqual(Object.keys(B.settings), Object.keys(A.settings), 'settings key order');
    assert.deepEqual(Object.keys(B), Object.keys(A), 'top-level key order (11.4)');
  });

  test('R4-18b HELD · a note created out of date order keeps its ARRAY position, it is not re-sorted', async () => {
    const { g0 } = await generations(async (s) => {
      s.apply('createNoteInline', { id: 'zz', date: '2025-01-01', text: 'ganz früh', categoryId: s.state.categories[0].id });
    });
    assert.deepEqual(JSON.parse(g0).notes.map((n) => n.id), ['n1', 'n2', 'zz'],
      'creation order, not date order — the pads are the one collection the projection sorts');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. WHERE IT STILL IS NOT A FIXED POINT, AND WHOSE FAULT THAT IS
// ─────────────────────────────────────────────────────────────────────────────

describe('R4-19 · the residue', () => {
  const V1_PARITY = {
    'setLayer({schulferien}) with no Bundesland (7.5 normalises it back off)': (s) => s.setLayer({ schulferien: true }),
    'setSettings({layers}) replacing the object wholesale': (s) => s.setSettings({ layers: { feiertage: false } }),
  };
  for (const [what, work] of Object.entries(V1_PARITY)) {
    test(`R4-19 · ${what} — not a fixed point, in BOTH builds, at the same bytes`, async () => {
      const v2 = await generations(async (s) => work(s));
      const v1 = await generations(async (s) => work(s), { boot: bootV1, store: () => v1store });
      assert.notEqual(v2.g0, v2.g1, 'v2 rewrites the file on the next launch');
      assert.notEqual(v1.g0, v1.g1, 'and so does the FROZEN v1 store');
      assert.deepEqual(firstDiff(v2.g0, v2.g1), firstDiff(v1.g0, v1.g1), 'the same key moves in both');
      assert.deepEqual(JSON.parse(v2.g1).settings.layers, JSON.parse(v1.g1).settings.layers,
        'and it settles on the same value — this is parity, not a regression F-1 introduced');
    });
  }

  test('R4-19c SUCCEEDED (defect) · a scratchpad held as "" — v1 IS a fixed point here and v2 is not', async () => {
    const board = v1board({ scratchpads: { '2026-05': '', '2026-06': 'Text' } });
    const v2 = await generations(async () => {}, { board });
    const v1 = await generations(async () => {}, { board, boot: bootV1, store: () => v1store });
    assert.equal(v1.g0, v1.g1, 'the frozen v1 store keeps the key across the restart');
    assert.deepEqual(JSON.parse(v1.g0).scratchpads, { '2026-05': '', '2026-06': 'Text' });
    assert.deepEqual(JSON.parse(v2.g0).scratchpads, { '2026-06': 'Text' },
      'DEFECT: v2 drops it at the migration door (migrate1to2.js:1204, ADR 001 §8.2) …');
    assert.equal(v2.g0, v2.g1, '…which at least it does consistently, so it settles after one rewrite');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE CONTROL — identity, which delete-and-re-insert could have broken
// ─────────────────────────────────────────────────────────────────────────────

describe('R4-20 · the fix did not buy the order with an identity', () => {
  test('R4-20a HELD · a caller holding state.scratchpads still holds it after a reorder', async () => {
    LS.clear();
    LS.setItem(LS_BOARD, J(BASE()));
    await bootV2();
    const held = v2store.state.scratchpads;
    v2store.mutate('pad', (s) => { s.scratchpads['2025-01'] = 'vor allem anderen'; });
    assert.equal(v2store.state.scratchpads, held, 'the MAP object is the same object');
    assert.equal(held['2025-01'], 'vor allem anderen', 'and the reference sees the new key');
    assert.deepEqual(Object.keys(held), ['2025-01', '2026-05'], 'in the projection\'s order');
  });

  test('R4-20b HELD · a caller holding an ENTRY object still holds it (store.js header, note 3)', async () => {
    LS.clear();
    LS.setItem(LS_BOARD, J(BASE()));
    await bootV2();
    const cat = v2store.state.categories[1];
    v2store.apply('createNoteInline', { id: 'nx', date: '2026-04-04', text: 'neu', categoryId: v2store.state.categories[0].id });
    assert.equal(v2store.state.categories[1], cat, 'still the same object across an unrelated mutation');
    cat.visible = false;
    assert.equal(v2store.state.categories[1].visible, false, 'and a write through it lands');
  });
});
