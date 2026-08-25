// CHARACTERIZATION — storage.js, the persistence *substrate* (spec 11.4).
//
// SCOPE NOTE (dedup, phase 3): this file used to be `store-storage.test.js` and
// also covered the whole store.js contract — mutate/undo/redo, migration,
// snapshots, export. All of that is now covered far more deeply in
// tests/tier1/store-persistence.test.js (125 tests over 11.1–11.7, 5.4, 4.4,
// 4.6), so the duplicates were deleted rather than maintained in two places.
//
// What stays here is the part store-persistence.test.js does NOT exercise
// directly: storage.js's own four exports, called on their own rather than
// through the store. That matters for LZP-402 specifically — an op-log store
// still has to write through *something*, and this is the contract of the
// thing it writes through.

import '../helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as storage from '../../src/js/storage.js';
import { localStorage as LS, resetStorage } from '../helpers/env.js';

const BOARD_KEY = 'langzeitplaner.board';
const SNAP_KEY = 'langzeitplaner.snapshots';

test('storage takes its browser branch: no __TAURI__, localStorage keys', () => {
  // The env shim defines `window` WITHOUT __TAURI__ on purpose, so the branch
  // under test is a stated choice rather than an accident of running in Node.
  // If this ever goes red, tier 1 has silently started testing the native
  // branch and every persistence assertion below is about the wrong code path.
  assert.equal(typeof globalThis.window, 'object');
  assert.equal(globalThis.window.__TAURI__, undefined);
  assert.equal(storage.isTauri(), false);
  assert.equal(storage.storagePath(), `localStorage · ${BOARD_KEY}`);
});

test('saveBoard writes ONE pretty-printed JSON document under the v1 key (11.4)', async () => {
  resetStorage();
  await storage.saveBoard({ hello: 'world' });
  assert.equal(LS.getItem(BOARD_KEY), '{\n  "hello": "world"\n}');
  assert.deepEqual(await storage.loadBoard(), { hello: 'world' });
  // exactly one slot is touched — the snapshot slot is a separate concern
  assert.deepEqual(LS._keys(), [BOARD_KEY]);
  // 2-space indentation is the human-readable promise of 11.4, on real content
  await storage.saveBoard({ notes: [{ id: 'n1', text: 'Zahnarzt' }] });
  const raw = LS.getItem(BOARD_KEY);
  assert.ok(raw.includes('\n  "notes"'), 'top level is indented by two spaces');
  assert.ok(raw.includes('\n      "id"'), 'nested objects keep indenting');
  assert.equal(raw, JSON.stringify(JSON.parse(raw), null, 2));
});

test('loadBoard returns null for a missing key and for corrupt JSON', async () => {
  resetStorage();
  assert.equal(await storage.loadBoard(), null);
  // A truncated mid-write file must degrade, not throw — this is what makes
  // store.init() fall back to defaults instead of failing to boot.
  for (const junk of ['{not json', '', '[1,2', 'undefined', '{"a":']) {
    LS.setItem(BOARD_KEY, junk);
    assert.equal(await storage.loadBoard(), null, `loadBoard(${JSON.stringify(junk)})`);
  }
  // valid JSON that is merely not an object still comes back as-is; repairing
  // that is migrate()'s job, not storage's
  LS.setItem(BOARD_KEY, '42');
  assert.equal(await storage.loadBoard(), 42);
});

test('snapshots round-trip in their own slot and degrade to [] rather than null', async () => {
  resetStorage();
  assert.deepEqual(await storage.loadSnapshots(), [], 'missing key');
  for (const junk of ['nonsense', '', '{"not":"an array"', '[1,']) {
    LS.setItem(SNAP_KEY, junk);
    assert.deepEqual(await storage.loadSnapshots(), [], `loadSnapshots(${JSON.stringify(junk)})`);
  }
  resetStorage();
  const list = [{ day: '2026-08-25', at: 1, board: { notes: [] } }];
  await storage.saveSnapshots(list);
  assert.deepEqual(await storage.loadSnapshots(), list);
  // the snapshot slot is compact, unlike the board — 11.5 vs 11.4
  assert.equal(LS.getItem(SNAP_KEY), JSON.stringify(list));
  assert.ok(!LS.getItem(SNAP_KEY).includes('\n'), 'snapshots are not pretty-printed');
  // and it is a genuinely separate slot: writing snapshots leaves the board alone
  assert.equal(LS.getItem(BOARD_KEY), null);
});

test('saveBoardSync writes the same bytes as saveBoard, without awaiting', () => {
  resetStorage();
  const doc = { notes: [], bars: [], schemaVersion: 1 };
  storage.saveBoardSync(doc);
  // the point of the sync path (window close) is that the bytes are on disk
  // the instant the call returns — no microtask, no debounce
  assert.equal(LS.getItem(BOARD_KEY), JSON.stringify(doc, null, 2));
});
