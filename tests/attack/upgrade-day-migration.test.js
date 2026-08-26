// ─────────────────────────────────────────────────────────────────────────────
// UPGRADE DAY — WHAT THE FILE HOLDS vs WHAT SURVIVES  (WP-3 adversary)
//
// THE EVENT: the first launch of v2 on top of a real v1 `board.json`. It happens exactly once
// per user and it cannot be retried — `init()` migrates, and the first autosave 700 ms later
// writes the migrated board back over the file it came from.
//
// THE CORPUS: values the v1 UI could never PRODUCE but a v1 FILE can legally CONTAIN. Every one
// of these is reachable by hand-editing `board.json`, by importing a JSON someone generated with
// a script, or by a board that passed through a tool that is not this app. The migration was
// built and tested against boards the app wrote; this file asks what happens to the others.
//
// THE ORACLE is the frozen v1 store (`tests/fixtures/v1-store-frozen.js`) plus the REAL
// `layout.js`, so a row does not say "a field changed" — it says what the user could see on the
// board before the upgrade and cannot see after it.
//
// HOW TO READ A ROW. Every assertion here is PINNED TO CURRENT BEHAVIOUR, the convention
// `docs/v2/STATUS.md` §5 sets: a row titled `DEFECT` is green while the defect exists. **If a
// DEFECT row goes RED, the defect was fixed — invert the row, do not "repair" it.** A row titled
// `HELD` is a real guarantee and going red means a regression.
//
// SCRATCH ONLY: everything runs through `tests/helpers/env.js`'s in-memory localStorage.
// No file on this machine is read or written.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { upgrade, diffDeep, v1board, note, bar, CATS } from './_upgrade-harness.js';
import { buildBoard } from '../../src/js/layout.js';

/** A fixed "today" so a row cannot pass or fail depending on the day it is run. */
const TODAY = '2026-03-15';

/**
 * Everything the user can SEE, as a flat list of facts, through the REAL render model.
 * A note that is not in here is not on the board.
 */
function visible(state) {
  const model = buildBoard(state, { today: TODAY });
  const out = [];
  for (const col of model.cols) {
    for (const d of col.days) {
      if (!d || d.empty) continue;
      for (const occ of (d.notes || [])) out.push(`note ${d.date} ${JSON.stringify(occ.note ? occ.note.text : occ.text)}`);
    }
    for (const seg of col.segs) out.push(`bar ${col.key} ${JSON.stringify(seg.label ?? seg.bar?.label)}`);
    if (col.pad !== '') out.push(`pad ${col.key} ${JSON.stringify(col.pad)}`);
  }
  return out;
}

const lost = (a, b) => a.filter((x) => !b.includes(x));

/** Boot both stores over the same bytes and report what the board lost. */
async function board(fixture) {
  const r = await upgrade(fixture);
  const before = visible(r.v1);
  const after = visible(r.v2);
  return { ...r, before, after, lost: lost(before, after), gained: lost(after, before) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. AN ENTRY WHOSE `id` IS NOT A NON-EMPTY STRING IS DELETED
//
// `ops.js` types an entity key as `id`: a non-empty string. `migrateV1` drops any entry whose id
// fails that. v1 has no such rule — it renders the entry and keeps it in the file forever.
// ─────────────────────────────────────────────────────────────────────────────

const BAD_IDS = {
  'a number': 7,
  'an empty string': '',
  'null': null,
  'a boolean': true,
  'an object': { toString: () => 'n1' },
};

for (const [what, id] of Object.entries(BAD_IDS)) {
  test(`DEFECT · a note whose id is ${what} is on the v1 board and gone from the v2 board`, async () => {
    const r = await board(v1board({
      notes: [{ id, date: '2026-04-02', text: 'Zahnarzt', categoryId: 'cat-arbeit', repeatsYearly: false }],
    }));
    assert.deepEqual(r.before, ['note 2026-04-02 "Zahnarzt"'], 'v1 renders it — that is the point');
    assert.deepEqual(r.after, [], 'v2 renders nothing');
    assert.equal(r.v2.notes.length, 0, 'and it is not in state either, so the next autosave erases it from the file');
  });
}

test('DEFECT · a bar with no id vanishes; v1 draws it across nine columns', async () => {
  const r = await board(v1board({
    bars: [{ startDate: '2026-04-01', endDate: '2026-12-24', label: 'Urlaub', categoryId: 'cat-arbeit' }],
  }));
  assert.ok(r.before.filter((x) => x.startsWith('bar ')).length >= 8, `v1 drew it: ${r.before.filter((x) => x.startsWith('bar ')).length} segments`);
  assert.equal(r.after.filter((x) => x.startsWith('bar ')).length, 0, 'v2 draws none');
  assert.equal(r.v2.bars.length, 0);
});

test('DEFECT · a category with no id is dropped, taking its legend row with it', async () => {
  const r = await upgrade(v1board({
    categories: [{ name: 'Arbeit', nameEn: 'Work', paletteRef: 'blau', visible: true }, CATS()[1]],
  }));
  assert.equal(r.v1.categories.length, 2);
  assert.equal(r.v2.categories.length, 1, 'v2 keeps only the one that had an id');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. A TRUTHY NON-BOOLEAN `repeatsYearly` LOSES THE SERIES
//
// `layout.js:71` reads it as `if (!n.repeatsYearly)`, so `'yes'` / `1` / `'true'` ARE a yearly
// repeat to v1. `FIELDS.note.repeatsYearly` is `bool`, so `fitValue`/`migrateV1` drop the field
// entirely — and a dropped field is `false`, which silently ends a birthday series.
// ─────────────────────────────────────────────────────────────────────────────

for (const truthy of ['yes', 1, 'true', {}]) {
  test(`DEFECT · repeatsYearly ${JSON.stringify(truthy)} repeats yearly in v1 and not at all in v2`, async () => {
    const r = await board(v1board({
      notes: [note('n1', '2024-06-10', 'Geburtstag', { repeatsYearly: truthy })],
    }));
    assert.deepEqual(r.before, ['note 2026-06-10 "Geburtstag"'], 'v1 projects the 2024 anchor into the visible window');
    assert.deepEqual(r.after, [], 'v2 shows nothing: the anchor year is outside the window and the repeat is gone');
    assert.ok(!r.v2.notes[0].repeatsYearly, 'the field is dropped entirely — falsy, so the series is over');
    assert.equal('repeatsYearly' in r.v2.notes[0], false, 'and unlike every v1 note, the key is not even there');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. A SCRATCHPAD WHOSE VALUE IS NOT A STRING IS ERASED
// ─────────────────────────────────────────────────────────────────────────────

test('DEFECT · a numeric scratchpad renders in v1 and is erased by the migration', async () => {
  const r = await board(v1board({ scratchpads: { '2026-04': 12345 } }));
  assert.deepEqual(r.before, ['pad 2026-04 12345'], 'v1: layout.js:259 hands the raw value to the textarea, which shows "12345"');
  assert.deepEqual(r.after, [], 'v2: the pad is gone');
  assert.deepEqual(Object.keys(r.v2.scratchpads), []);
});

test('HELD · a whitespace-only scratchpad survives byte-for-byte', async () => {
  const r = await upgrade(v1board({ scratchpads: { '2026-04': '   \n\t  ' } }));
  assert.equal(r.v2.scratchpads['2026-04'], '   \n\t  ');
  assert.deepEqual(diffDeep(r.v1, r.v2), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. A NOTE WHOSE `date` IS NOT A STRING IS DELETED FROM THE FILE
//
// Not visible in either build — neither renders it — but v1 KEEPS it, so the day the date is
// repaired the note comes back. v2 erases it on the first autosave and it never can.
// ─────────────────────────────────────────────────────────────────────────────

for (const [what, date] of Object.entries({ 'null': null, 'a number': 20260402, 'US format': '04/02/2026', 'out of range': '2026-13-45', 'empty': '' })) {
  test(`DEFECT · a note dated ${what} is preserved by v1 and erased by v2`, async () => {
    const r = await upgrade(v1board({ notes: [note('n1', date, 'Zahnarzt')] }));
    assert.equal(r.v1.notes.length, 1, 'v1 keeps it in the file');
    assert.equal(r.v2.notes.length, 0, 'v2 does not');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. LENGTH — the one loss the retrofit already decided and warned about (ATT-82)
// ─────────────────────────────────────────────────────────────────────────────

test('DEFECT (decided, ATT-82) · a 111-character note is truncated to 80', async () => {
  const r = await board(v1board({ notes: [note('n1', '2026-04-02', 'x'.repeat(111))] }));
  assert.equal(r.v1.notes[0].text.length, 111);
  assert.equal(r.v2.notes[0].text.length, 80);
});

test('DEFECT · the 80-character cap counts UTF-16 units, so 50 emoji become 40', async () => {
  const r = await upgrade(v1board({ notes: [note('n1', '2026-04-02', '😀'.repeat(50))] }));
  assert.equal([...r.v1.notes[0].text].length, 50);
  assert.equal([...r.v2.notes[0].text].length, 40, 'ten emoji cut — and the surrogate pair is not split, at least');
});

test('DEFECT · a 55-character bar label is truncated to 40', async () => {
  const r = await upgrade(v1board({ bars: [bar('b1', '2026-04-01', '2026-04-10', 'y'.repeat(55))] }));
  assert.equal(r.v1.bars[0].label.length, 55);
  assert.equal(r.v2.bars[0].label.length, 40);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. NOBODY IS EVER TOLD
//
// `migrateV1` produces a `warnings[]` and `store.init()` stores it on `store.warnings`. The
// ATT-82 warning text even promises the cut characters "are in the migration report".
// **No file outside `store.js` reads `store.warnings`.** Every loss above is silent.
// ─────────────────────────────────────────────────────────────────────────────

test('DEFECT · the migration reports every loss and no UI reads the report', async () => {
  const r = await upgrade(v1board({
    notes: [
      { id: 7, date: '2026-04-02', text: 'Zahnarzt', categoryId: 'cat-arbeit', repeatsYearly: false },
      note('n2', '2026-06-10', 'Geburtstag', { repeatsYearly: 'yes' }),
      note('n3', '2026-05-01', 'x'.repeat(111)),
    ],
    scratchpads: { '2026-04': 12345 },
  }));
  assert.ok(r.v2warnings.length >= 3, `the migration knew: ${r.v2warnings.length} warnings`);

  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../../src/js/', import.meta.url);
  const readers = readdirSync(dir)
    .filter((f) => f.endsWith('.js') && f !== 'store.js')
    .filter((f) => /\bwarnings\b/.test(readFileSync(new URL(f, dir), 'utf8')));
  assert.deepEqual(readers, [], 'nothing outside store.js so much as mentions warnings');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. WHAT HELD — the rows that would have been the easy wins
// ─────────────────────────────────────────────────────────────────────────────

test('HELD · two notes sharing an id both survive, re-keyed, and both render', async () => {
  const r = await board(v1board({
    notes: [note('dup', '2026-04-01', 'Erste'), note('dup', '2026-04-02', 'Zweite')],
  }));
  assert.deepEqual(r.lost, [], 'nothing left the board');
  assert.equal(r.v2.notes.length, 2);
  assert.notEqual(r.v2.notes[0].id, r.v2.notes[1].id, 'the second was re-keyed (ATT-90)');
});

test('HELD · a dangling categoryId is repaired to categories[0], exactly as v1 does', async () => {
  const r = await upgrade(v1board({ notes: [note('n1', '2026-04-02', 'Zahnarzt', { categoryId: 'gone' })] }));
  assert.deepEqual(diffDeep(r.v1, r.v2), []);
  assert.equal(r.v2.notes[0].categoryId, 'cat-arbeit');
});

test('HELD · an empty category list becomes v1\'s four defaults on both sides', async () => {
  const r = await upgrade(v1board({ categories: [] }));
  assert.equal(r.v1.categories.length, 4);
  assert.equal(r.v2.categories.length, 4);
  assert.deepEqual(r.v1.categories.map((c) => c.name), r.v2.categories.map((c) => c.name));
});

test('HELD · a Feb-29 yearly repeat lands on the same days in both builds', async () => {
  const r = await board(v1board({ notes: [note('n1', '2024-02-29', 'Schalttag', { repeatsYearly: true })] }));
  assert.deepEqual(r.lost, []);
  assert.deepEqual(r.gained, []);
});

test('HELD · a v0 board (no schemaVersion, no scratchpads, no layers) migrates identically', async () => {
  const r = await upgrade({
    notes: [note('n1', '2026-04-02', 'Zahnarzt')],
    bars: [bar('b1', '2026-04-10', '2026-06-20', 'Projekt')],
    categories: CATS(),
    settings: { bundesland: 'HH', mode: 'pinned', startMonth: '2026-01', lastCategoryId: 'cat-arbeit' },
  });
  assert.deepEqual(diffDeep(r.v1, r.v2), []);
  assert.equal(r.v2.schemaVersion, 1);
});

test('HELD · unknown top-level keys are dropped by BOTH builds — no new loss', async () => {
  const r = await upgrade({ ...v1board({ notes: [note('n1', '2026-04-02', 'A')] }), zzz: { deep: 1 }, notesBackup: [1, 2] });
  assert.deepEqual(diffDeep(r.v1, r.v2), []);
  assert.equal(r.v1.zzz, undefined, 'v1 dropped it too — this is v1 behaviour, not a retrofit loss');
});

test('HELD · settings with a null layers object is repaired to the defaults on both sides', async () => {
  const r = await upgrade(v1board({ settings: { layers: null } }));
  assert.deepEqual(diffDeep(r.v1, r.v2), []);
});

test('HELD · an unknown settings key is kept by both (v1 quirk, preserved)', async () => {
  const r = await upgrade(v1board({ settings: { weirdKey: 'kept' } }));
  assert.equal(r.v1.settings.weirdKey, 'kept');
  assert.equal(r.v2.settings.weirdKey, 'kept');
});

test('HELD · a JSON `__proto__` key in settings does not survive into v2 (a hardening, not a loss)', async () => {
  const r = await upgrade(v1board({ settings: JSON.parse('{"__proto__":{"polluted":true},"mode":"pinned"}') }));
  assert.equal(Object.prototype.polluted, undefined, 'no prototype was touched by either build');
  assert.equal(Object.prototype.hasOwnProperty.call(r.v2.settings, '__proto__'), false);
});

test('DEFECT (minor) · an unknown FIELD on a note is preserved by v1 and stripped by v2', async () => {
  const r = await upgrade(v1board({ notes: [note('n1', '2026-04-02', 'A', { mystery: 'keep me' })] }));
  assert.equal(r.v1.notes[0].mystery, 'keep me');
  assert.equal(r.v2.notes[0].mystery, undefined, 'the entity is the register set; there is no room for a field nobody declared');
});
