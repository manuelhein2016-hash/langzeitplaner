// ─────────────────────────────────────────────────────────────────────────────
// UPGRADE-DAY HARNESS  (WP-3 adversary)
//
// The one event that happens exactly once to every real user and cannot be retried:
// the FIRST LAUNCH of v2 on top of a real v1 board.js on disk.
//
// `upgrade(board)` writes `board` into the storage slots exactly as v1 wrote them,
// then boots BOTH stores over the SAME BYTES:
//
//   v1  — `tests/fixtures/v1-store-frozen.js`, the baseline commit `66126e9`
//   v2  — `src/js/store.js`, the SHIPPING retrofitted store
//
// and hands back both `state`s plus what each one left on disk. Anything the user
// could see that differs is a defect on a path with no second chance.
//
// SCRATCH ONLY. Everything goes through `tests/helpers/env.js`'s in-memory
// localStorage stand-in; no file on this machine is read or written. The one test
// that touches a real directory uses the scratchpad path it creates itself.
//
// Deliberately NOT named `*.test.js` so the runner does not execute it alone.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import { after } from 'node:test';

import { localStorage as LS, resetStorage, seedBoard } from '../helpers/env.js';

import { store as v1store, defaultState as v1default } from '../fixtures/v1-store-frozen.js';
import { store as v2store, defaultState as v2default, migrate as v2migrate } from '../../src/js/store.js';

const LS_BOARD = 'langzeitplaner.board';
const LS_SNAP = 'langzeitplaner.snapshots';
const LS_OPS = 'langzeitplaner.ops';
const LS_CHECKPOINT = 'langzeitplaner.checkpoint';

export { LS, LS_BOARD, LS_SNAP, LS_OPS, LS_CHECKPOINT, v1store, v2store, v1default, v2default, v2migrate };

after(() => { clearTimeout(v1store._saveTimer); clearTimeout(v2store._saveTimer); });

/** Boot the FROZEN v1 store over whatever is in storage right now. */
export async function bootV1() {
  v1store.undoStack.length = 0;
  v1store.redoStack.length = 0;
  v1store.snapshots.length = 0;
  v1store._lastSnapshotDay = null;
  v1store.ready = false;
  v1store.listeners.clear();
  await v1store.init();
  return v1store;
}

/** Boot the SHIPPING v2 store over whatever is in storage right now. */
export async function bootV2() {
  v2store.undoStack.length = 0;
  v2store.redoStack.length = 0;
  v2store.snapshots.length = 0;
  v2store._lastSnapshotDay = null;
  v2store.ready = false;
  v2store.listeners.clear();
  v2store.warnings = [];
  await v2store.init();
  return v2store;
}

/** Everything in the four storage slots, as raw strings. */
export function slots() {
  return {
    board: LS.getItem(LS_BOARD),
    snapshots: LS.getItem(LS_SNAP),
    ops: LS.getItem(LS_OPS),
    checkpoint: LS.getItem(LS_CHECKPOINT),
    keys: LS._keys().slice().sort(),
  };
}

/**
 * Upgrade day, both halves.
 * @param {Object} board      the v1 `board.json` bytes on disk before the upgrade
 * @param {Object} [opts]
 * @param {Array}  [opts.snapshots]  the v1 `snapshots.json` beside it
 * @param {boolean}[opts.persist]    also run `persistNow()` on each side (what the first
 *                                   autosave after the upgrade writes back)
 */
export async function upgrade(board, { snapshots, persist = false } = {}) {
  const bytes = board === undefined ? undefined : JSON.stringify(board);
  const snapBytes = snapshots === undefined ? undefined : JSON.stringify(snapshots);

  const seed = () => {
    resetStorage();
    if (bytes !== undefined) LS.setItem(LS_BOARD, bytes);
    if (snapBytes !== undefined) LS.setItem(LS_SNAP, snapBytes);
  };

  seed();
  await bootV1();
  const v1 = structuredClone(v1store.state);
  const v1snaps = structuredClone(v1store.snapshots);
  if (persist) await v1store.persistNow();
  const v1disk = slots();

  seed();
  await bootV2();
  const v2 = structuredClone(v2store.state);
  const v2snaps = structuredClone(v2store.snapshots);
  const v2warnings = [...v2store.warnings];
  if (persist) await v2store.persistNow();
  const v2disk = slots();

  return { v1, v2, v1snaps, v2snaps, v1disk, v2disk, v2warnings, seed };
}

/** Canonical JSON — key order removed, so a diff reports VALUES, not insertion order. */
export const canon = (v) => {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'undefined';
};

/**
 * Every difference between two boards, one line per divergent leaf, with a path.
 * A bare deepEqual on a 400-entry board tells you nothing; this tells you which note.
 */
export function diffDeep(a, b, path = '', out = []) {
  if (canon(a) === canon(b)) return out;
  const aObj = a && typeof a === 'object';
  const bObj = b && typeof b === 'object';
  if (!aObj || !bObj || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path || '<root>'}: v1=${JSON.stringify(a)} v2=${JSON.stringify(b)}`);
    return out;
  }
  if (Array.isArray(a)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) diffDeep(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    diffDeep(a[k], b[k], path ? `${path}.${k}` : k, out);
  }
  return out;
}

/** The v1 fixture cast, chosen so an assertion message names the entry it is about. */
export const CATS = () => ([
  { id: 'cat-arbeit', name: 'Arbeit', nameEn: 'Work', paletteRef: 'blau', visible: true },
  { id: 'cat-familie', name: 'Familie', nameEn: 'Family', paletteRef: 'gruen', visible: true },
]);

export const note = (id, date, text, extra = {}) =>
  ({ id, date, text, categoryId: 'cat-arbeit', repeatsYearly: false, ...extra });
export const bar = (id, s, e, label, extra = {}) =>
  ({ id, startDate: s, endDate: e, label, categoryId: 'cat-arbeit', ...extra });

/** A v1 board with the shape v1 actually wrote. */
export function v1board(patch = {}) {
  const d = v1default();
  const b = {
    schemaVersion: 1,
    notes: patch.notes ?? [],
    bars: patch.bars ?? [],
    categories: patch.categories === undefined ? CATS() : patch.categories,
    scratchpads: patch.scratchpads ?? {},
    settings: {
      ...d.settings, startMonth: '2026-01', mode: 'pinned',
      lastCategoryId: 'cat-arbeit', ...(patch.settings || {}),
    },
  };
  for (const k of Object.keys(patch)) if (!(k in b)) b[k] = patch[k];
  return b;
}
