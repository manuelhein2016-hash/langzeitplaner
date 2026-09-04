// TIER 1 · `store.js#withoutForeignEntries` — THE GUARD, AND THE BLIND SPOT AUDIT F15 NAMED.
// F-SHELL-3(b) · ADR 004 §4.1 · ADR 006 R1 · `core/materialize.js#stripV2Fields`.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE FINDING, VERBATIM (AUDIT §3 F15, first item)
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   "`withoutForeignEntries` is blind to the file format solo mode writes. It recognises a
//    foreign entry by `isForeign` or an `f…` entity key; `stripV2Fields` removes both markers and
//    keeps `id`, which still spells `fnote:<memberId>/<uuid>`. Not live — a family Mac persists
//    the full v2 board, where the markers are present — but it is a defence-in-depth guard with a
//    blind spot."
//
// It is exact. Verified in the source before this file was written:
//
//   · `materialize.js#foreignCandidate` sets `id: key` — a foreign entry's id IS its entity key.
//   · `materialize.js` `DECORATIONS` lists `entityKey` and `isForeign`; `V1_ENTRY_FIELDS.note`
//     lists `id`. So `stripV2Fields` removes both markers and keeps the tell-tale id.
//   · `store.js#_buildSpine` calls `withoutForeignEntries` on whatever `migrate()` produced, and
//     `migrateV1` MINTS a fresh id for anything it cannot use as one and authors it as one of MY
//     OWN `note.set` ops at `visibility: 'privat'` — the F-SHELL-3(b) defect, measured on the
//     shipped binary as SEVEN copies of one peer's entry after seven launches.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY IT IS WORTH A ROW THOUGH THE AUDIT RANKED IT LOW
//
// The path is not live TODAY for one reason only — a family Mac persists the full v2 board — and
// that reason is a single ternary (`this._familySpaceId ? full : stripV2Fields(full)`). The guard
// exists precisely because the consequence of it being wrong is silent and permanent: another
// member's revocable view becomes a private copy on my own board that nobody can take back. A
// guard with a documented hole is one import, one restored backup or one hand-edited file away
// from being reached, and closing it is one predicate.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// DISPOSITION
//   §1  NON-VACUITY  the guard really does drop the two SHAPES IT ALREADY KNEW, so §2's red
//                    cannot be "the guard never ran".
//   §2  ✅ CLOSED    a stripped foreign entry — `id: 'fnote:…'`, NO `isForeign`, NO `entityKey` —
//                    is not authored as mine. RED before the `id` predicate landed.
//   §3  CONTROL      an ordinary v1 board is untouched: same entries, same count, no warning.
//                    This is the row that dies if the predicate is widened carelessly.
//
// MUTANTS — measured at source, then reverted
//   M-1  `store.js#withoutForeignEntries`: drop the `typeof e.id === 'string' && foreignKey.test(
//        e.id)` clause, i.e. the build before this fix. **§2 dies alone; §1 and §3 stand.**
//   M-2  the same predicate widened to `/^f/` (an id that merely starts with `f`). **§3 dies
//        alone** — a v1 note may legitimately be called anything, and the guard may not eat one.
// ═════════════════════════════════════════════════════════════════════════════════════════════

import { localStorage as LS, resetStorage, seedBoard } from '../helpers/env.js';
import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const MEMBER = 'mem_re63V1_DVAeh_cu3gYGsnw';
const UUID = '6f1b2c34-5d6e-4a7b-8c9d-0e1f2a3b4c5d';
const MINE = '11111111-2222-4333-8444-555555555555';

/** A board as `stripV2Fields` would leave it: v1 fields only, and the id still names the owner. */
const strippedBoard = () => ({
  schemaVersion: 1,
  notes: [
    { id: MINE, date: '2026-10-01', text: 'Mein Eintrag', categoryId: 'c1', repeatsYearly: false },
    // THE BLIND SPOT. No `isForeign`, no `entityKey` — `stripV2Fields` removed both — and an
    // `id` that is still Papa's entity key.
    { id: `fnote:${MEMBER}/${UUID}`, date: '2026-10-14', text: 'Omas Geburtstag', categoryId: 'c1', repeatsYearly: false },
  ],
  bars: [
    { id: `fbar:${MEMBER}/${UUID}`, startDate: '2026-07-01', endDate: '2026-08-31', label: 'Sommerferien', categoryId: 'c1' },
  ],
  categories: [{ id: 'c1', name: 'Familie', nameEn: 'Family', paletteRef: 'violett', visible: true }],
  scratchpads: {},
  settings: {},
});

/** The same board with the markers still on, which is what a family Mac actually persists. */
const markedBoard = () => {
  const b = strippedBoard();
  b.notes[1].isForeign = true;
  b.notes[1].entityKey = `fnote:${MEMBER}/${UUID}`;
  b.bars[0].entityKey = `fbar:${MEMBER}/${UUID}`;
  return b;
};

/** An ordinary v1 board — no family anything, and an id that merely begins with `f`. */
const v1Board = () => ({
  schemaVersion: 1,
  notes: [
    { id: MINE, date: '2026-10-01', text: 'Mein Eintrag', categoryId: 'c1', repeatsYearly: false },
    { id: 'f0000000-1111-4222-8333-444444444444', date: '2026-10-02', text: 'Ferien planen', categoryId: 'c1', repeatsYearly: false },
  ],
  bars: [{ id: 'fb111111-2222-4333-8444-555555555555', startDate: '2026-07-01', endDate: '2026-08-31', label: 'Sommer', categoryId: 'c1' }],
  categories: [{ id: 'c1', name: 'Familie', nameEn: 'Family', paletteRef: 'violett', visible: true }],
  scratchpads: {},
  settings: {},
});

async function bootOn(board) {
  resetStorage();
  seedBoard(board);
  const mod = await import(`../../src/js/store.js?spine-foreign-${Math.random()}`);
  const { store } = mod;
  await store.init();
  return store;
}

const textsOf = (store) => (store.state.notes || []).map((n) => n.text).sort();
const labelsOf = (store) => (store.state.bars || []).map((b) => b.label).sort();
const droppedWarning = (store) => (store.warnings || [])
  .filter((w) => /belong[s]? to\s+another member of the Familienkreis/.test(String(w)));

describe('the spine may not author another member\'s entry as mine', () => {
  beforeEach(() => { resetStorage(); });

  test('§1 · NON-VACUITY · the two shapes the guard ALREADY knew are still dropped', async () => {
    const store = await bootOn(markedBoard());
    assert.deepEqual(textsOf(store), ['Mein Eintrag'],
      'a MARKED foreign note reached the board — the guard is not running at all, and §2 would '
      + 'then be measuring nothing');
    assert.deepEqual(labelsOf(store), [], 'a marked foreign bar reached the board');
    assert.equal(droppedWarning(store).length, 1,
      'the guard dropped entries and said nothing — the operator sentence is part of the fix');
  });

  test('§2 · ✅ AUDIT F15 · a STRIPPED foreign entry is not authored as mine either', async () => {
    const store = await bootOn(strippedBoard());
    assert.deepEqual(textsOf(store), ['Mein Eintrag'],
      'AUDIT F15. `stripV2Fields` removes `isForeign` and `entityKey` and keeps `id`, and a '
      + 'foreign entry\'s id IS its entity key — so this board carries `fnote:<member>/<uuid>` '
      + 'with no marker beside it, `migrateV1` mints a fresh id for it, and it is authored as one '
      + 'of MY OWN privat notes. Board reads: ' + JSON.stringify(textsOf(store)));
    assert.deepEqual(labelsOf(store), [],
      'the same, one entity kind over: a stripped foreign BAR was authored as mine. Board reads: '
      + JSON.stringify(labelsOf(store)));
    assert.equal(droppedWarning(store).length, 1,
      'they were dropped silently — an operator who never sees the sentence cannot tell this '
      + 'apart from a board that lost entries');
  });

  test('§3 · CONTROL · an ordinary v1 board is untouched, including ids that start with f', async () => {
    const store = await bootOn(v1Board());
    assert.deepEqual(textsOf(store), ['Ferien planen', 'Mein Eintrag'],
      'the guard ate a v1 note. The predicate must match `fnote:` / `fbar:` and NOT "starts with '
      + 'f" — a colon is outside the uuid alphabet and that is the whole safety of it');
    assert.deepEqual(labelsOf(store), ['Sommer'], 'the guard ate a v1 bar');
    assert.deepEqual(droppedWarning(store), [],
      'a v1 board produced the Familienkreis warning: ' + JSON.stringify(droppedWarning(store)));
  });
});
