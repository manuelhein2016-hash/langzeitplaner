// tests/attack/_round6-kit.js — the shared rig for the round-6 suites.
//
// Deliberately NOT named `*.test.js` so the runner does not execute it alone. Everything here is
// the round-5 authority harness, lifted verbatim, so that a round-6 row and a round-5 row that
// disagree are disagreeing about the STORE and not about two different fixtures.

import { LS, LS_BOARD, LS_SNAP, LS_OPS, LS_CHECKPOINT, v2store, bootV2, v1board, note, bar } from './_upgrade-harness.js';

export { LS, LS_BOARD, LS_SNAP, LS_OPS, LS_CHECKPOINT, v2store, bootV2, v1board, note, bar };

export const J = (v) => JSON.stringify(v);
export const jsonl = (ops) => ops.map((o) => JSON.stringify(o)).join('\n');

export const slots = () => ({
  board: LS.getItem(LS_BOARD), ops: LS.getItem(LS_OPS),
  checkpoint: LS.getItem(LS_CHECKPOINT), snapshots: LS.getItem(LS_SNAP),
});

export const cpOf = () => JSON.parse(LS.getItem(LS_CHECKPOINT) || 'null');
export const tailLines = () => (LS.getItem(LS_OPS) || '').split('\n').filter(Boolean).length;
export const texts = (s) => s.state.notes.map((n) => n.text);

/** One full session: boot, arm the WP-8 flag (the only way to make the store write the two files
 *  solo mode does not write), do `fn`, persist. Identical to round 5's `session`. */
export async function session(fn) {
  await bootV2();
  v2store._opsPersisted = true;
  if (fn) await fn(v2store);
  await v2store.persistNow();
  return v2store;
}

/** A board plus the LEGITIMATE lineage-bearing pair this build writes over it. */
export async function bound(board) {
  LS.clear();
  LS.setItem(LS_BOARD, J(board));
  await session();
  return slots();
}

/** Boot over exactly these slots. `undefined`/`null` means "this file is not there". */
export async function bootWith({ board, ops, checkpoint, snapshots }) {
  LS.clear();
  if (board !== undefined && board !== null) LS.setItem(LS_BOARD, typeof board === 'string' ? board : J(board));
  if (ops !== undefined && ops !== null) LS.setItem(LS_OPS, typeof ops === 'string' ? ops : jsonl(ops));
  if (checkpoint !== undefined && checkpoint !== null) LS.setItem(LS_CHECKPOINT, typeof checkpoint === 'string' ? checkpoint : J(checkpoint));
  if (snapshots !== undefined && snapshots !== null) LS.setItem(LS_SNAP, typeof snapshots === 'string' ? snapshots : J(snapshots));
  await bootV2();
  return v2store;
}

export const SNAP_DAY = '2026-08-01';
export const SNAPSHOT = () => [{
  day: SNAP_DAY,
  at: '2026-08-01T00:00:00Z',
  state: v1board({ notes: [note('sn1', '2026-01-01', 'AUS DEM SCHNAPPSCHUSS')] }),
}];

export const addNote = (id, text, date = '2026-09-09') => (s) => s.mutate('add', (st) => {
  st.notes.push({ id, date, text, categoryId: st.categories[0].id, repeatsYearly: false });
});
export const delNote = (id) => (s) => s.mutate('del', (st) => {
  st.notes = st.notes.filter((n) => n.id !== id);
});
export const editNote = (id, text) => (s) => s.mutate('edit', (st) => {
  for (const n of st.notes) if (n.id === id) n.text = text;
});

/** The `_born` stamp a projected entry actually carries — the thing ADR 001 §5 step 5 sorts on. */
export const bornOf = (s, key) => {
  const cells = s.registers().get(key);
  return cells ? cells.get('_born')?.stamp ?? null : null;
};
