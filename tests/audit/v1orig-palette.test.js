// CHARACTERIZATION — palette.js: the fixed ten-tone palette (spec 4.5).
//
// SCOPE NOTE (dedup, phase 3): this file used to be `ferien-palette-i18n.test.js`
// and also covered ferien.js and i18n.js. Both of those areas are now covered
// far more deeply elsewhere and the duplicates were removed rather than left to
// rot into two sources of truth:
//
//   ferien.js  → tests/tier1/dates-holidays.test.js  (7.1–7.5: the index built
//                day-by-day, per-state period counts, the 400-day walk guard,
//                FERIEN_META pinned field-by-field, the horizon discrepancy)
//   i18n.js    → tests/tier1/repeats-find-i18n.test.js (13.7: the DE/EN tables,
//                the overlay/fall-through rule, function-valued entries, the
//                unknown-key and unknown-language fallbacks, and the fact that
//                buildBoard reads settings.language rather than the i18n module)
//
// palette.js has no other home, so it keeps this file.

import '../helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../src/js/palette.js';

test('the palette is exactly ten fixed tones, no free picker (4.5)', () => {
  assert.equal(P.PALETTE.length, 10);
  assert.deepEqual(
    P.PALETTE.map((p) => p.ref),
    ['blau', 'gruen', 'orange', 'magenta', 'violett', 'tuerkis', 'rot', 'gold', 'marine', 'schiefer']
  );
  for (const p of P.PALETTE) assert.match(p.hex, /^#[0-9A-F]{6}$/);
  // refs and hexes are both distinct — the palette is a set, not a list with
  // accidental repeats. nextFreeRef's "never repeat a colour" only means
  // anything if the tones really are different.
  assert.equal(new Set(P.PALETTE.map((p) => p.ref)).size, 10);
  assert.equal(new Set(P.PALETTE.map((p) => p.hex)).size, 10);
});

test('colorOf resolves a ref and falls back to the first tone for anything unknown', () => {
  assert.equal(P.colorOf('blau'), '#2A7CC0');
  assert.equal(P.colorOf('schiefer'), P.PALETTE.at(-1).hex);
  for (const p of P.PALETTE) assert.equal(P.colorOf(p.ref), p.hex);
  // the fallback branch — this is why an entry whose category was deleted or
  // whose paletteRef went missing still renders in ink rather than vanishing
  for (const bad of ['nope', '', undefined, null, 0, {}]) {
    assert.equal(P.colorOf(bad), '#2A7CC0', `colorOf(${JSON.stringify(bad)})`);
  }
});

test('paletteName is localised, defaulting to German', () => {
  assert.equal(P.paletteName('gruen', 'de'), 'Grün');
  assert.equal(P.paletteName('gruen', 'en'), 'Green');
  assert.equal(P.paletteName('gruen'), 'Grün');
  assert.equal(P.paletteName('gruen', 'fr'), 'Grün');
  assert.equal(P.paletteName('nope', 'en'), 'Blue', 'unknown ref names the fallback tone');

  // The whole table, pinned — not a "does a name exist" check, which a broken
  // lookup returning the German name for both languages would also pass.
  // Orange / Magenta / Gold are deliberately identical in both languages;
  // the other seven genuinely differ.
  const table = [
    ['blau', 'Blau', 'Blue'],
    ['gruen', 'Grün', 'Green'],
    ['orange', 'Orange', 'Orange'],
    ['magenta', 'Magenta', 'Magenta'],
    ['violett', 'Violett', 'Violet'],
    ['tuerkis', 'Türkis', 'Teal'],
    ['rot', 'Rot', 'Red'],
    ['gold', 'Gold', 'Gold'],
    ['marine', 'Marine', 'Navy'],
    ['schiefer', 'Schiefer', 'Slate'],
  ];
  assert.equal(table.length, P.PALETTE.length);
  for (const [ref, de, en] of table) {
    assert.equal(P.paletteName(ref, 'de'), de, `${ref} DE`);
    assert.equal(P.paletteName(ref, 'en'), en, `${ref} EN`);
  }
  assert.equal(table.filter(([, de, en]) => de !== en).length, 7,
    'seven of the ten tones have a distinct English name');
});

test('nextFreeRef walks the palette in order, wrapping to blau when full', () => {
  assert.equal(P.nextFreeRef([]), 'blau');
  assert.equal(P.nextFreeRef(['blau']), 'gruen');
  assert.equal(P.nextFreeRef(['blau', 'gruen', 'orange']), 'magenta');
  // order of the used-list does not matter; it is a membership test
  assert.equal(P.nextFreeRef(['orange', 'blau', 'gruen']), 'magenta');
  // a gap is filled before the tail is reached
  assert.equal(P.nextFreeRef(['blau', 'orange', 'magenta']), 'gruen');
  // full palette wraps rather than returning undefined
  assert.equal(P.nextFreeRef(P.PALETTE.map((p) => p.ref)), 'blau');
  // unknown refs in the used-list do not consume a tone
  assert.equal(P.nextFreeRef(['not-a-tone']), 'blau');
});

test('nextFreeRef never repeats while free tones remain — ten distinct categories', () => {
  // The property store.js relies on when a user adds categories one by one.
  const used = [];
  for (let i = 0; i < 10; i++) used.push(P.nextFreeRef(used));
  assert.equal(new Set(used).size, 10, `repeated a tone: ${used.join()}`);
  assert.deepEqual(used, P.PALETTE.map((p) => p.ref));
});

test('tintOf is a 12%-alpha wash appended as hex alpha', () => {
  assert.equal(P.tintOf('blau'), '#2A7CC01F');
  // it is exactly colorOf + the same two-hex-digit alpha for every tone
  for (const p of P.PALETTE) {
    assert.equal(P.tintOf(p.ref), `${P.colorOf(p.ref)}1F`);
  }
  assert.equal(P.tintOf('nope'), '#2A7CC01F', 'unknown ref tints the fallback tone');
});
