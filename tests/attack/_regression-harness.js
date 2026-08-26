// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION ATTACK HARNESS
//
// Shared machinery for `regression-*.test.js`. Deliberately NOT named `*.test.js`
// so `npm run test:attack` does not execute it on its own.
//
// The one thing this file exists for: `oracle(board)` — run the SHIPPING core over
// a v1 board and run the ACTUAL v1 store over the same bytes, and hand both answers
// back so a test can diff them. It is the ATT-50 / §8.3 comparison, generalised so
// the fixture can be as ugly as a real `board.json`.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import { after } from 'node:test';

import { resetStorage, seedBoard } from '../helpers/env.js';
// THE ORACLE IS v1, AND v1 IS FROZEN (WP-3). This harness compares the v2 core against the v1
// store; after LZP-402 `src/js/store.js` IS v2, so importing it here would compare v2 against
// itself. `tests/fixtures/v1-store-frozen.js` is the baseline commit's bytes, guarded against
// drift by `tests/tier1/v1-frozen-store.test.js`.
import { store, defaultState } from '../fixtures/v1-store-frozen.js';

import { migrateV1 } from '../../src/js/core/migrate1to2.js';
import { materialize, stripV2Fields } from '../../src/js/core/materialize.js';
import { fold } from '../../src/js/core/registers.js';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export const pad22 = (s) => {
  let out = '';
  for (const ch of String(s)) out += B64.includes(ch) ? ch : B64[ch.charCodeAt(0) % 64];
  return (out + 'A'.repeat(22)).slice(0, 22);
};

export const ME = `mem_${pad22('ME')}`;
export const DEV = `dev_${pad22('MEDESKTOP')}`;
export const MIG_CTX = Object.freeze({ memberId: ME, deviceId: DEV, acceptLossy: true });

/** Kill v1's 700 ms autosave timer so node --test can exit. */
after(() => { clearTimeout(store._saveTimer); });

/** Put the v1 singleton back to a known world (the lever the char suite uses). */
export async function freshV1(board) {
  resetStorage();
  if (board) seedBoard(board);
  store.undoStack.length = 0;
  store.redoStack.length = 0;
  store.snapshots.length = 0;
  store._lastSnapshotDay = null;
  store.ready = false;
  store.listeners.clear();
  await store.init();
  return store;
}

export const CATS = () => [
  { id: 'cat-1', name: 'Arbeit', nameEn: 'Work', paletteRef: 'blau', visible: true },
  { id: 'cat-2', name: 'Familie', nameEn: 'Family', paletteRef: 'gruen', visible: true },
];

/** The fixture shape the v1-fidelity suite uses, so a divergence cannot be blamed on the board. */
export function v1board(patch = {}) {
  const d = defaultState();
  const b = {
    schemaVersion: 1,
    notes: patch.notes ?? [],
    bars: patch.bars ?? [],
    categories: patch.categories ?? CATS(),
    scratchpads: patch.scratchpads ?? {},
    settings: { ...d.settings, startMonth: '2026-01', mode: 'pinned', lastCategoryId: 'cat-1', ...(patch.settings || {}) },
  };
  if (patch.categories === null) b.categories = [];
  return b;
}

export const note = (id, date, text, extra = {}) =>
  ({ id, date, text, categoryId: 'cat-1', repeatsYearly: false, ...extra });
export const bar = (id, s, e, label, extra = {}) =>
  ({ id, startDate: s, endDate: e, label, categoryId: 'cat-1', ...extra });

/**
 * Both answers for one board.
 *
 *   v1   — `store.state` after a real `store.init()` over these bytes, at schemaVersion 1
 *   core — `stripV2Fields(materialize(fold(migrateV1(board).ops)))`
 *
 * That pair IS ADR 001 §8.3's acceptance criterion. `defaultSettings` is v1's own
 * `defaultState().settings`, as `materialize`'s ATT-97 guard requires.
 */
export async function oracle(board, migCtx = MIG_CTX) {
  const bytes = JSON.stringify(board);
  await freshV1(JSON.parse(bytes));
  const v1 = { ...structuredClone(store.state), schemaVersion: 1 };

  const res = migrateV1(JSON.parse(bytes), migCtx);
  const regs = fold(res.ops);
  const st = materialize(regs, {
    me: ME,
    familySpaceId: null,
    currentMembers: new Set([ME]),
    defaultSettings: defaultState().settings,
  });
  return { v1, core: stripV2Fields(st), full: st, regs, ...res };
}

/** Canonical JSON — key order removed, so a diff reports VALUES and not insertion order. */
const canon = (v) => {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'undefined';
};

/**
 * The top-level board keys whose VALUES differ — the message a bare deepEqual will not give you.
 * Key order is normalised away; `boardDiffBytes` is the one that keeps it.
 */
export function boardDiff(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (canon(a[k]) !== canon(b[k])) out.push(k);
  }
  return out.sort();
}

/** The same, but byte-wise — so a re-ordered object counts as a difference (11.4 is about bytes). */
export function boardDiffBytes(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
  }
  return out.sort();
}
