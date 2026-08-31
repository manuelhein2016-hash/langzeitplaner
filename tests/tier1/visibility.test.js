// tests/tier1/visibility.test.js — LZP-701 · 703 · 704, and the entities.js visibility seam.
//
// SUBJECTS: `src/js/core/visibility.js` (new), the two lines of `src/js/core/entities.js` that
// used to spell a level as a string literal, and — where the guarantee is about LEAKAGE rather
// than about policy — the REAL `src/js/core/project.js` and the REAL fold/materialize stack.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE METHOD: ENUMERATE THE INPUT DOMAIN AS DATA, EXHAUSTIVELY, BEFORE CHOOSING A BRANCH.
//
// Every table in section 0 was written from ADR 004's PROSE — §2.1's table, §3, §5's transition
// table, §7, §9 — and never from `visibility.js`. A domain read off the implementation proves the
// implementation equals itself. The cell counts are asserted, so a row that silently disappears
// is a failure rather than a smaller run.
//
//   D1  every LEVEL-SHAPED input a predicate can be handed        16 values × 6 predicates =  96
//   D2  every category a create path can read                     14 categories             =  14
//   D3  every transition                        3 from × 3 to × 4 lastPublished × 2 alive  =  72
//   D4  the seam inputs `entities.js` must classify               18 entries                =  18
//                                                                                    total  120
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT IS ASSERTED WHERE, AND WHY IT IS NOT ALL IN ONE PLACE
//
//   X1  `DISCLOSURE` vs `project.js`'s FIELD LISTS. Two independent statements of ADR 004 §2.1 —
//       one as claims, one as allowlists — checked against each other. Neither is derived from
//       the other, which is the only reason the duplication is worth having.
//   X2  `planTransition` vs the REAL `projectForFamily`/`retractPatch`, over all 72 D3 cells,
//       twice — once per family kind.
//       This is the row that keeps a PREDICTION from becoming a SECOND PATH.
//   X3  the predicates, over all 96 D1 cells, including the fail-closed half.
//   X4  the `entities.js` seam, over all 18 D4 entries, byte-compared against the predicate the
//       two lines used to spell inline.
//   X5  Principle 9 — the absences. Asserted on ARITY and on BYTES, never on a message.
//   A4  series-level visibility, asserted through the real `noteOccurrences`.
//   P7d LZP-704's acceptance criterion, end to end: random transition sequences ending in
//       `privat`, driven through the real projection into real ops, folded by the real
//       `foldAuthorized` and materialized on a real PEER. Asserted on the peer's board and on the
//       peer's registers — never on the owner's, because the owner's board is right either way
//       and that is exactly what makes the bug in ADR 004 §5.1 dangerous.
//
// NO TEST HERE READS THE WALL CLOCK OR THE CSPRNG (ADR 005 §5). Every stamp is minted from a
// counter and every "random" sequence comes from a seeded PRNG whose seed is in the failure
// message.

import test from 'node:test';
import assert from 'node:assert/strict';

import '../helpers/env.js';
import { pcg32, short16, attestationBlob, attestVerify } from '../helpers/gen.js';

import {
  VisibilityError, VISIBILITY_LEVELS, DEFAULT_VISIBILITY, LEVEL_RANK,
  isLevel, rankOf, cmpLevels, isDowngrade, isUpgrade,
  DISCLOSURE, showsExistence, showsContent, allowsCoEdit, isRedacted,
  projectedToPeers, publishesAnything, wasPublished,
  visibilityForNewEntry, CATEGORY_DEFAULT_CONTRACT,
  classifyTransition, planTransition, TRANSITION_PLAN_KEYS, NO_SNITCH_CONTRACT,
  seriesVisibility,
} from '../../src/js/core/visibility.js';

import {
  VISIBILITY_LEVELS as LEVELS_FROM_ENTITIES, projectable, renderableNote, renderableBar,
  noteOccurrences, familyKey, noteKey, memberKey, spaceKey,
} from '../../src/js/core/entities.js';

import {
  projectForFamily, retractPatch, GETEILT_FIELDS, BELEGT_FIELDS, RedactionError,
} from '../../src/js/core/project.js';

import { foldAuthorized } from '../../src/js/core/authz.js';
import { materialize } from '../../src/js/core/materialize.js';
import { getRegister } from '../../src/js/core/registers.js';
import { makeOp, PERSONAL_PLACEHOLDER } from '../../src/js/core/ops.js';
import { fmt } from '../../src/js/core/stamp.js';
import { defaultState } from '../../src/js/store.js';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 0. THE INPUT DOMAINS — transcribed from ADR 004's prose, never from the implementation
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * D1 — every level-shaped input a PREDICATE can be handed.
 *
 * The three real levels, then eleven things that are not levels and that a register map, a
 * malformed import, a future protocol version or a caller bug can genuinely produce. `expect` is
 * the DISCLOSURE claim from ADR 004 §2.1, written out per row rather than computed, so a mutant
 * that changes the table changes what these rows measure against and cannot hide.
 *
 * The `''`, `0` and `false` rows exist because the predicate they replaced was `!entry.level`,
 * which is FALSY-based; `'Privat'` exists because that is the glossary spelling and the register
 * holds the lowercase id; `'PRIVAT'` and `' privat'` because a hand-edited file produces them;
 * `'oeffentlich'` and `'nurTermine'` because a future protocol version might.
 */
const D1 = [
  // id                 value          level? existence content coEdit  projected?
  ['privat', 'privat', true, false, false, false, false],
  ['belegt', 'belegt', true, true, false, false, true],
  ['geteilt', 'geteilt', true, true, true, true, true],
  ['undefined', undefined, false, false, false, false, false],
  ['null', null, false, false, false, false, false],
  ['empty', '', false, false, false, false, false],
  ['zero', 0, false, false, false, false, false],
  ['false', false, false, false, false, false, false],
  ['true', true, false, false, false, false, true],
  ['Privat-cased', 'Privat', false, false, false, false, true],
  ['PRIVAT', 'PRIVAT', false, false, false, false, true],
  ['padded', ' privat', false, false, false, false, true],
  ['alien-future', 'nurTermine', false, false, false, false, true],
  ['alien', 'oeffentlich', false, false, false, false, true],
  ['number', 2, false, false, false, false, true],
  ['object', { toString: () => 'geteilt' }, false, false, false, false, true],
].map(([id, value, level, existence, content, coEdit, projected]) => ({
  id: `D1-${id}`, value, level, existence, content, coEdit, projected,
}));

/**
 * D2 — every category a create path can read, and the level a NEW entry in it must start at
 * (16.4, ADR 004 §3). The floor is `privat` and only a well-formed enum value raises it.
 *
 * `dangling` is not hypothetical: v1's tri-state category rule treats an unknown category id as
 * VISIBLE, so `store.category(catId)` returning `undefined` is a shape the board really produces.
 * `getter` is the read-once defence — it answers `'privat'` the first time and `'geteilt'` after.
 */
function twoFacedCategory() {
  let n = 0;
  return { id: 'twoFaced', get defaultVisibility() { return n++ === 0 ? 'privat' : 'geteilt'; } };
}
const D2 = [
  ['privat', { defaultVisibility: 'privat' }, 'privat'],
  ['belegt', { defaultVisibility: 'belegt' }, 'belegt'],
  ['geteilt-familie', { name: 'Familie', defaultVisibility: 'geteilt' }, 'geteilt'],
  ['absent-field', { name: 'Arbeit' }, 'privat'],
  ['undefined-field', { defaultVisibility: undefined }, 'privat'],
  ['null-field', { defaultVisibility: null }, 'privat'],
  ['empty-field', { defaultVisibility: '' }, 'privat'],
  ['alien-field', { defaultVisibility: 'oeffentlich' }, 'privat'],
  ['cased-field', { defaultVisibility: 'Geteilt' }, 'privat'],
  ['boolean-field', { defaultVisibility: true }, 'privat'],
  ['dangling', undefined, 'privat'],
  ['null-category', null, 'privat'],
  ['array', [], 'privat'],
  ['string', 'geteilt', 'privat'],
].map(([id, category, expect]) => ({ id: `D2-${id}`, category, expect }));

/**
 * D3 — EVERY TRANSITION. 3 `from` × 3 `to` × 4 `lastPublished` × 2 `alive` = 72 cells, built as
 * a cross product rather than listed, because ADR 004 §5's transition TABLE has seven rows and
 * the seven are a sample of this space, not a partition of it. The four `lastPublished` values
 * are the three levels plus `null` (never published); the two `alive` values are §5's
 * "delete while published" row and its complement.
 *
 * The expected `family` action is stated here, from §5's prose, as three independent clauses —
 * NOT as a copy of `planTransition`'s branch order:
 *   · to `privat`      ⇒ `retract` if some peer holds registers for it, else `none` (16.1)
 *   · dead and unknown ⇒ `none` (a tombstone for something nobody saw announces it existed)
 *   · otherwise        ⇒ `publish`
 */
const D3 = [];
for (const from of VISIBILITY_LEVELS) {
  for (const to of VISIBILITY_LEVELS) {
    for (const lastPublished of [null, 'privat', 'belegt', 'geteilt']) {
      for (const alive of [true, false]) {
        const known = lastPublished !== null && lastPublished !== 'privat';
        const family = to === 'privat' ? (known ? 'retract' : 'none')
          : (!alive && !known) ? 'none' : 'publish';
        D3.push({
          id: `D3-${from}->${to}/last=${lastPublished}/alive=${alive}`,
          from,
          to,
          lastPublished,
          alive,
          known,
          family,
        });
      }
    }
  }
}

/**
 * D4 — the seam. Every entry shape `entities.js:projectable` and `renderableNote` must classify,
 * with the answer written from ADR 004 §4.2's rendering table rather than from either function.
 *
 * The `own` rows matter as much as the foreign ones: the seam edit must be a NO-OP on a solo
 * board, and a solo board is nothing but own rows (ADR 001 §11).
 */
const FOREIGN = { isForeign: true, ownerId: 'mem_' + 'x'.repeat(22), date: '2026-05-01' };
const D4 = [
  ['own-plain', { text: 'Zahnarzt', date: '2026-05-01' }, true],
  ['own-no-text', { date: '2026-05-01' }, false],
  ['own-privat', { text: 'x', date: '2026-05-01', visibility: 'privat' }, true],
  ['own-geteilt', { text: 'x', date: '2026-05-01', visibility: 'geteilt' }, true],
  ['own-dead', { text: 'x', date: '2026-05-01', alive: false }, false],
  ['foreign-geteilt', { ...FOREIGN, level: 'geteilt', text: 'Bescherung' }, true],
  ['foreign-geteilt-no-text', { ...FOREIGN, level: 'geteilt' }, false],
  ['foreign-belegt', { ...FOREIGN, level: 'belegt' }, true],
  ['foreign-belegt-no-date', { ...FOREIGN, level: 'belegt', date: undefined }, false],
  ['foreign-privat', { ...FOREIGN, level: 'privat', text: 'leak' }, false],
  ['foreign-no-level', { ...FOREIGN, text: 'leak' }, false],
  ['foreign-null-level', { ...FOREIGN, level: null, text: 'leak' }, false],
  ['foreign-empty-level', { ...FOREIGN, level: '', text: 'leak' }, false],
  ['foreign-dead', { ...FOREIGN, level: 'geteilt', text: 'x', alive: false }, false],
  // The forward-compatibility rows. `core-materialize.test.js:757` characterizes these ON
  // PURPOSE: an unknown level is rendered rather than dropped, and never as Belegt.
  ['foreign-alien-with-text', { ...FOREIGN, level: 'oeffentlich', text: 'x' }, true],
  ['foreign-alien-no-text', { ...FOREIGN, level: 'oeffentlich' }, false],
  ['foreign-cased-with-text', { ...FOREIGN, level: 'Geteilt', text: 'x' }, true],
  ['nothing', null, false],
].map(([id, entry, expect]) => ({ id: `D4-${id}`, entry, expect }));

const DOMAIN_SIZES = { D1: 16, D2: 14, D3: 72, D4: 18 };

test('§0 · the domains are the size they claim, and no id repeats', () => {
  assert.equal(D1.length, DOMAIN_SIZES.D1);
  assert.equal(D2.length, DOMAIN_SIZES.D2);
  assert.equal(D3.length, DOMAIN_SIZES.D3, '3 from × 3 to × 4 lastPublished × 2 alive');
  assert.equal(D4.length, DOMAIN_SIZES.D4);
  const ids = [...D1, ...D2, ...D3, ...D4].map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'a duplicate row id means a cell is measured twice');
  assert.equal(ids.length, 120, 'the enumerated cells; the predicate CROSS PRODUCT adds 96 more, and\n'
    + '    X2 walks D3 twice (once per family kind) for 144 projection measurements');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// X1 — `DISCLOSURE` vs `project.js`'s allowlists: two statements of ADR 004 §2.1
// ═════════════════════════════════════════════════════════════════════════════════════════════

const CONTENT_FIELD = { fnote: 'pub.text', fbar: 'pub.label' };
const COEDIT_FIELD = 'pub.coEdit';

test('X1 · the disclosure CLAIMS and the field ALLOWLISTS are the same table, said twice', () => {
  for (const kind of ['fnote', 'fbar']) {
    const geteilt = new Set(GETEILT_FIELDS[kind]);
    const belegt = new Set(BELEGT_FIELDS[kind]);

    // `showsContent` ⇔ the content field is on that level's allowlist.
    assert.equal(geteilt.has(CONTENT_FIELD[kind]), showsContent('geteilt'), `${kind}/geteilt content`);
    assert.equal(belegt.has(CONTENT_FIELD[kind]), showsContent('belegt'), `${kind}/belegt content`);

    // `allowsCoEdit` ⇔ `pub.coEdit` is on that level's allowlist (ADR 004 §8).
    assert.equal(geteilt.has(COEDIT_FIELD), allowsCoEdit('geteilt'), `${kind}/geteilt coEdit`);
    assert.equal(belegt.has(COEDIT_FIELD), allowsCoEdit('belegt'), `${kind}/belegt coEdit`);

    // BELEGT ⊂ GETEILT, and the difference is exactly {content, coEdit} — INV-R1 and §8 as a
    // set difference. If a third field ever joins the difference, this names it.
    const diff = [...geteilt].filter((f) => !belegt.has(f)).sort();
    assert.deepEqual(diff, [COEDIT_FIELD, CONTENT_FIELD[kind]].sort(),
      `${kind}: the Geteilt-only fields are exactly the ones DISCLOSURE calls content and coEdit`);
    assert.deepEqual([...belegt].filter((f) => !geteilt.has(f)), [],
      `${kind}: BELEGT must stay a strict subset of GETEILT`);

    // Belegt discloses EXISTENCE, and the allowlist is how: the tombstone and the dates survive.
    assert.equal(belegt.has('pub.level') && belegt.has('pub.alive'), showsExistence('belegt'));
    // A3 — no spelling of a category is on either list, at any level.
    for (const f of [...geteilt, ...belegt]) {
      assert.equal(/cat/i.test(f), false, `${kind}: ${f} names a category (A3)`);
    }
  }
});

test('X1b · a Privat entry has no allowlist at all — 16.1 is the absence of a table', () => {
  // There is no `PRIVAT_FIELDS`, and that is the enforcement: `projectForFamily` does not index a
  // table for `privat`, it returns `null` (or a retraction). A mutant that added one would have
  // to add it to `project.js` AND make `DISCLOSURE.privat` disclose something.
  assert.deepEqual(DISCLOSURE.privat, { existence: false, content: false, coEdit: false });
  assert.equal(publishesAnything('privat'), false);
  for (const kind of ['fnote', 'fbar']) {
    assert.equal(projectForFamily(kind, { visibility: 'privat' }, 'privat', null), null,
      '16.1 — a Privat entry that was never published produces NO family op at all');
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// X2 — `planTransition` predicts the REAL projection, over all 72 D3 cells × 2 kinds
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** A truth object at `level`, carrying a real value in every field the level could publish. */
const truthAt = (kind, level, alive) => (kind === 'fnote'
  ? { visibility: level, date: '2026-12-24', text: 'Bescherung', repeatsYearly: true, coEdit: true, categoryId: 'cat-1', _alive: alive }
  : { visibility: level, startDate: '2026-07-01', endDate: '2026-07-14', label: 'Urlaub', coEdit: true, categoryId: 'cat-1', _alive: alive });

test('X2 · the plan and the projection agree on all 72 cells, for both kinds', () => {
  const disagreements = [];
  let publishes = 0;
  let retracts = 0;
  let silent = 0;
  for (const row of D3) {
    for (const kind of ['fnote', 'fbar']) {
      const plan = planTransition({
        from: row.from, to: row.to, lastPublished: row.lastPublished, alive: row.alive,
      });
      if (plan.family !== row.family) {
        disagreements.push(`${row.id}/${kind}: plan says ${plan.family}, ADR 004 §5 says ${row.family}`);
        continue;
      }
      // …and now the REAL projection, on the SAME inputs. `to` is the authenticated level, so
      // the truth object carries it — that is what the store must pass (barrier 4's S5 rule).
      const patch = projectForFamily(kind, truthAt(kind, row.to, row.alive), row.to, row.lastPublished);
      if (plan.family === 'none') {
        silent++;
        if (patch !== null) disagreements.push(`${row.id}/${kind}: predicted silence, got a patch`);
      } else if (plan.family === 'retract') {
        retracts++;
        assert.ok(patch, `${row.id}/${kind}: predicted a retraction, got null`);
        assert.deepEqual({ ...patch }, { ...retractPatch(kind) },
          `${row.id}/${kind}: a retraction must be retractPatch(kind), byte for byte`);
      } else {
        publishes++;
        assert.ok(patch, `${row.id}/${kind}: predicted a publish, got null`);
        assert.notDeepEqual({ ...patch }, { ...retractPatch(kind) },
          `${row.id}/${kind}: a publish must not be a retraction in disguise`);
        assert.equal(patch['pub.level'], row.to, `${row.id}/${kind}: pub.level restates the level`);
      }
    }
  }
  assert.deepEqual(disagreements, [],
    'the PREDICTION drifted from the PRODUCER. `planTransition` must never become a second path:\n  '
    + disagreements.join('\n  '));
  // The census, pinned. A branch that collapses two buckets into one still "agrees" cell by cell.
  assert.deepEqual({ publishes, retracts, silent }, { publishes: 72, retracts: 24, silent: 48 },
    'the three buckets moved — a branch collapsed, or the domain changed shape');
});

test('X2b · INV-R1 on the emitted ops — no content field above the level, on any cell (P7b)', () => {
  for (const row of D3) {
    for (const kind of ['fnote', 'fbar']) {
      const patch = projectForFamily(kind, truthAt(kind, row.to, row.alive), row.to, row.lastPublished);
      if (!patch) continue;
      if (!showsContent(row.to)) {
        assert.equal(patch[CONTENT_FIELD[kind]], null,
          `${row.id}/${kind}: a non-Geteilt op carried content — INV-R1`);
      }
      if (!allowsCoEdit(row.to)) {
        assert.equal(patch[COEDIT_FIELD], null, `${row.id}/${kind}: pub.coEdit exists only at Geteilt`);
      }
      // P7g — the category, at every level, ever. Checked on the KEYS and on the serialized bytes.
      assert.equal(Object.keys(patch).some((k) => /cat/i.test(k)), false, `${row.id}/${kind}: A3`);
      assert.equal(JSON.stringify(patch).includes('cat-1'), false, `${row.id}/${kind}: A3, by value`);
    }
  }
});

test('X2c · INV-R4 is structural — every withdrawable row is PRESENT on every published patch', () => {
  // "Omission is not withdrawal" (ADR 004 §5.1) tested as a claim about KEYS, not about values:
  // a patch that omits `pub.text` performs no register write and the peer keeps rendering it.
  for (const row of D3) {
    for (const kind of ['fnote', 'fbar']) {
      const patch = projectForFamily(kind, truthAt(kind, row.to, row.alive), row.to, row.lastPublished);
      if (!patch) continue;
      for (const field of GETEILT_FIELDS[kind]) {
        assert.equal(field in patch, true,
          `${row.id}/${kind}: "${field}" is ABSENT. Omission is not withdrawal — the peer's LWW `
          + 'fold keeps its old value and its stamp, and Mama\'s board keeps rendering it.');
      }
    }
  }
});

test('X2d · `withdraws` is true exactly when a peer LOSES something', () => {
  for (const row of D3) {
    const plan = planTransition({
      from: row.from, to: row.to, lastPublished: row.lastPublished, alive: row.alive,
    });
    // Stated independently of the implementation: a peer holds registers (`known`), and either
    // the entry died or the new level discloses strictly less than what the peer was given.
    const lost = row.known
      && (!row.alive || rankOf(row.to) < rankOf(row.lastPublished));
    assert.equal(plan.withdraws, lost, `${row.id}: withdraws`);
    // Nothing is withdrawn from a peer that holds nothing — 16.1's other half.
    if (!row.known) assert.equal(plan.withdraws, false, `${row.id}: nothing to withdraw`);
  }
});

test('X2e · the plan refuses every shape that is not a transition', () => {
  const bad = [
    ['no argument', undefined],
    ['null', null],
    ['an array', []],
    ['a string', 'geteilt'],
  ];
  for (const [why, arg] of bad) {
    assert.throws(() => planTransition(arg), (e) => e.name === 'VisibilityError', why);
  }
  const base = { from: 'privat', to: 'geteilt', lastPublished: null };
  // `undefined` is not "never published" — say `null`. The same rule `projectForFamily` applies.
  assert.throws(() => planTransition({ from: 'privat', to: 'geteilt' }),
    (e) => e.name === 'VisibilityError', 'a missing lastPublished must refuse, not publish first');
  for (const alien of ['oeffentlich', 'Privat', '', null, undefined, 2]) {
    assert.throws(() => planTransition({ ...base, from: alien }), (e) => e.name === 'VisibilityError');
    assert.throws(() => planTransition({ ...base, to: alien }), (e) => e.name === 'VisibilityError');
  }
  assert.throws(() => planTransition({ ...base, lastPublished: 'oeffentlich' }),
    (e) => e.name === 'VisibilityError');
  // …and the errors are NOT RedactionError. Two classes, two meanings: ADR 004 §2.3's loud path
  // stops the sync loop for a RedactionError, and a caller bug on this device must not.
  try { planTransition(null); } catch (e) {
    assert.equal(e.name, 'VisibilityError');
    assert.equal(e instanceof RedactionError, false,
      'a planner bug must not be mistaken for a prevented leak');
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// X3 — the predicates over all 96 (16 inputs × 6 predicates) cells
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('X3 · every predicate answers every level-shaped input, and none of them throws', () => {
  const wrong = [];
  let cells = 0;
  for (const row of D1) {
    const got = {
      isLevel: isLevel(row.value),
      showsExistence: showsExistence(row.value),
      showsContent: showsContent(row.value),
      allowsCoEdit: allowsCoEdit(row.value),
      isRedacted: isRedacted(row.value),
      projectedToPeers: projectedToPeers(row.value),
    };
    cells += 6;
    const want = {
      isLevel: row.level,
      showsExistence: row.existence,
      showsContent: row.content,
      allowsCoEdit: row.coEdit,
      isRedacted: row.existence && !row.content,
      projectedToPeers: row.projected,
    };
    for (const k of Object.keys(want)) {
      if (got[k] !== want[k]) wrong.push(`${row.id}: ${k} answered ${got[k]}, expected ${want[k]}`);
    }
  }
  assert.equal(cells, 96, 'the predicate cross product');
  assert.deepEqual(wrong, [], wrong.join('\n  '));
});

test('X3b · the predicates FAIL CLOSED — an unknown level discloses nothing', () => {
  // The half of X3 that is the privacy claim rather than the table. Stated on its own so a mutant
  // that makes `disclosureOf` fall through to `geteilt` dies here with a sentence, not a diff.
  for (const row of D1.filter((r) => !r.level)) {
    assert.equal(showsExistence(row.value), false, `${row.id}: an unknown level claimed existence`);
    assert.equal(showsContent(row.value), false, `${row.id}: an unknown level claimed CONTENT`);
    assert.equal(allowsCoEdit(row.value), false, `${row.id}: an unknown level allowed co-edit`);
    assert.equal(isRedacted(row.value), false, `${row.id}: an unknown level rendered as Belegt`);
  }
  // …and the orderings REFUSE rather than guess. Ranking an unknown level below `privat` invents
  // a withdrawal; ranking it above `geteilt` invents a disclosure.
  for (const row of D1.filter((r) => !r.level)) {
    assert.throws(() => rankOf(row.value), (e) => e.name === 'VisibilityError', row.id);
    assert.throws(() => cmpLevels('privat', row.value), (e) => e.name === 'VisibilityError', row.id);
    assert.throws(() => isDowngrade('geteilt', row.value), (e) => e.name === 'VisibilityError', row.id);
  }
});

test('X3c · the ranks come from the ORDER of the array, and the table has no prototype', () => {
  assert.deepEqual([...VISIBILITY_LEVELS], ['privat', 'belegt', 'geteilt'],
    'increasing disclosure — every rank in the product is indexOf into this');
  assert.deepEqual(VISIBILITY_LEVELS, LEVELS_FROM_ENTITIES,
    'entities.js re-exports the same array; two definitions would be two orders');
  assert.equal(VISIBILITY_LEVELS, LEVELS_FROM_ENTITIES, 'and the SAME object, not a copy');
  for (const [i, l] of VISIBILITY_LEVELS.entries()) assert.equal(rankOf(l), i);
  assert.equal(cmpLevels('privat', 'geteilt') < 0, true);
  assert.equal(isDowngrade('geteilt', 'belegt'), true);
  assert.equal(isDowngrade('belegt', 'belegt'), false);
  assert.equal(isUpgrade('privat', 'belegt'), true);
  assert.equal(classifyTransition('belegt', 'belegt'), 'unchanged');
  // ADR 004 §2.2's own printed barrier had this bug: `'toString' in FIELDS[kind]` is TRUE. A rank
  // table built with `Object.fromEntries` inherits `Object.prototype` the same way.
  assert.equal(Object.getPrototypeOf(LEVEL_RANK), null, 'LEVEL_RANK rides the prototype chain');
  assert.equal(Object.getPrototypeOf(DISCLOSURE), null, 'DISCLOSURE rides the prototype chain');
  assert.equal(LEVEL_RANK.toString, undefined);
  assert.equal(DISCLOSURE.constructor, undefined);
  // Frozen all the way down: a widened allowlist is a silent, process-wide privacy change.
  assert.equal(Object.isFrozen(VISIBILITY_LEVELS), true);
  assert.equal(Object.isFrozen(DISCLOSURE.geteilt), true);
  assert.throws(() => { DISCLOSURE.belegt.content = true; }, TypeError,
    'DISCLOSURE.belegt.content = true would make every Belegt entry publish its text');
});

test('X3d · `wasPublished` — `privat` is "never", `undefined` is a refusal', () => {
  assert.equal(wasPublished(null), false, 'never published');
  assert.equal(wasPublished('privat'), false, 'a completed retraction leaves nothing to withdraw');
  assert.equal(wasPublished('belegt'), true);
  assert.equal(wasPublished('geteilt'), true);
  for (const bad of [undefined, '', 'oeffentlich', 0, false, {}]) {
    assert.throws(() => wasPublished(bad), (e) => e.name === 'VisibilityError',
      '`undefined` must not read as "never published" — that is a silent first publication');
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// X4 — the `entities.js` seam, over all 18 D4 entries
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** EXACTLY what the two lines of `entities.js` said before the seam edit. The oracle. */
const beforeSeamProjectable = (entry) => {
  if (!entry) return false;
  if (entry.alive === false) return false;
  if (entry.isForeign) {
    if (!entry.level || entry.level === 'privat') return false;
  }
  return beforeSeamRenderable(entry);
};
const has = (v) => v !== undefined && v !== null;
const beforeSeamRenderable = (note) => {
  if (!note) return false;
  if (note.isForeign) return has(note.date) && (note.level === 'belegt' || has(note.text));
  if (note.repeatsYearly && typeof note.date !== 'string') return false;
  return has(note.text);
};

test('X4 · the seam is a BYTE-FOR-BYTE no-op on all 18 entries — solo mode is untouched', () => {
  const drift = [];
  for (const row of D4) {
    const got = projectable('note', row.entry);
    if (got !== row.expect) drift.push(`${row.id}: projectable answered ${got}, ADR 004 §4.2 says ${row.expect}`);
    const oracle = beforeSeamProjectable(row.entry);
    if (got !== oracle) drift.push(`${row.id}: the seam CHANGED behaviour (was ${oracle}, now ${got})`);
    if (row.entry) {
      assert.equal(renderableNote(row.entry), beforeSeamRenderable(row.entry), `${row.id}: renderableNote`);
    }
  }
  assert.deepEqual(drift, [], drift.join('\n  '));
  // The solo half, named: no own row can reach the level branch at all.
  for (const row of D4.filter((r) => r.entry && !r.entry.isForeign)) {
    assert.equal(projectable('note', { ...row.entry, level: 'oeffentlich' }), row.expect,
      `${row.id}: an own entry's rendering must not depend on a family level`);
  }
});

test('X4b · the viewer gate and the policy predicate DISAGREE on exactly one input class', () => {
  // Pinned so that the day somebody chooses between them, they choose once and knowingly.
  // `projectedToPeers` is what ships (`entities.js:projectable`); `showsExistence` is what a
  // fail-closed reading would use. They agree on every real level and on every falsy value.
  const disagree = D1.filter((r) => showsExistence(r.value) !== projectedToPeers(r.value));
  assert.deepEqual(disagree.map((r) => r.id).sort(), [
    'D1-PRIVAT', 'D1-Privat-cased', 'D1-alien', 'D1-alien-future',
    'D1-number', 'D1-object', 'D1-padded', 'D1-true',
  ], 'the disagreement is EXACTLY the truthy non-levels — an unknown future level, and nothing '
   + 'else. `visibility.js:projectedToPeers` documents why the shipped answer is the wider one, '
   + 'and why the narrowing is `materialize.js`\'s owner to make, not this work package\'s.');
  for (const r of D1.filter((x) => x.level || !x.value)) {
    assert.equal(showsExistence(r.value), projectedToPeers(r.value), `${r.id} must not differ`);
  }
});

test('X4c · a foreign Belegt entry is renderable WITHOUT a text, and a Geteilt one is not', () => {
  // 16.7 and ADR 001 §5 step 3 in one row: meaning is never inferred from a missing field. A
  // Geteilt entry whose `pub.text` op has not arrived yet is INVISIBLE, not "Belegt".
  assert.equal(renderableNote({ ...FOREIGN, level: 'belegt' }), true);
  assert.equal(renderableNote({ ...FOREIGN, level: 'geteilt' }), false);
  assert.equal(renderableNote({ ...FOREIGN, level: 'geteilt', text: null }), false,
    'null is how a downgrade WITHDRAWS — it must not keep the entry renderable');
  assert.equal(renderableNote({ ...FOREIGN, level: 'geteilt', text: '' }), true,
    'an empty string is a VALUE (v1 renders an empty note as …), and that is why null had to mean redacted');
  assert.equal(renderableBar({ isForeign: true, startDate: '2026-01-01', endDate: '2026-01-05' }), true);
  assert.equal(renderableBar({ isForeign: true, startDate: '2026-01-01' }), false);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// X5 — Principle 9: the absences, asserted on ARITY and on BYTES
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('X5 · a retraction cannot carry what the entry was downgraded FROM', () => {
  // The strongest form of the no-snitch rule available: the function that builds the withdrawal
  // bytes takes the KIND AND NOTHING ELSE, so there is no argument through which a previous
  // level could reach the wire. A mutant that adds `retractPatch(kind, from)` dies here.
  assert.equal(retractPatch.length, 1,
    'retractPatch grew a parameter — the only thing it may be told is the kind (ADR 004 §7)');

  for (const kind of ['fnote', 'fbar']) {
    const fromGeteilt = projectForFamily(kind, truthAt(kind, 'privat', true), 'privat', 'geteilt');
    const fromBelegt = projectForFamily(kind, truthAt(kind, 'privat', true), 'privat', 'belegt');
    assert.deepEqual({ ...fromGeteilt }, { ...fromBelegt },
      `${kind}: a Geteilt→Privat and a Belegt→Privat retraction must be the SAME BYTES. A peer `
      + 'that can tell them apart can tell what an entry used to be — Principle 9.');
    assert.deepEqual({ ...fromGeteilt }, { ...retractPatch(kind) });
    // …and it says nothing about the level it came from, by value either.
    assert.equal(JSON.stringify(fromGeteilt).includes('geteilt'), false);
    assert.equal(JSON.stringify(fromGeteilt).includes('belegt'), false);
  }
});

test('X5b · the plan has an exactly-pinned key set, and there is nowhere to put a notification', () => {
  const plan = planTransition({ from: 'geteilt', to: 'privat', lastPublished: 'geteilt' });
  assert.deepEqual(Object.keys(plan).sort(), [...TRANSITION_PLAN_KEYS].sort(),
    'a key appeared or vanished — Principle 9 is enforced by this shape being small');
  assert.deepEqual([...TRANSITION_PLAN_KEYS].sort(),
    ['direction', 'family', 'from', 'notifies', 'to', 'truth', 'withdraws']);
  assert.equal(plan.notifies, false, 'the literal a future notification mechanism has to change');
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.truth), true);
  assert.throws(() => { plan.notifies = true; }, TypeError);
  // The truth write is the ONLY personal-space field a transition touches. `coEdit` clearing is
  // `family/sharing.js:planVisibilityChange`'s (18.2/A7); the LEVEL is this module's.
  assert.deepEqual(Object.keys(plan.truth), ['visibility']);
  // No string this module produces names a previous level or a notification.
  // The only key in the whole plan that names a notification is the one whose value is `false`.
  assert.deepEqual(Object.keys(plan).filter((k) => /notif|announce|tell|report/i.test(k)), ['notifies']);
  // …and no VALUE anywhere in the plan names one, or names the previous level to a peer. `from`
  // is local — the popover needs it to draw the control — and it never reaches a family patch,
  // which X5 asserts on the bytes.
  assert.equal(Object.values(plan).some((v) => typeof v === 'string' && /notif|announce|war geteilt/i.test(v)),
    false, JSON.stringify(plan));
});

test('X5c · the no-snitch contract says what the absences are, for the agent who adds a ninth op kind', () => {
  for (const clause of Object.keys(NO_SNITCH_CONTRACT)) {
    assert.equal(typeof NO_SNITCH_CONTRACT[clause], 'string');
    assert.ok(NO_SNITCH_CONTRACT[clause].length > 60, `${clause} is a stub`);
  }
  assert.deepEqual(Object.keys(NO_SNITCH_CONTRACT).sort(),
    ['dotNeverFiresOnLoss', 'noHistory', 'noNotification', 'retractionIsAnonymous']);
  assert.equal(Object.isFrozen(NO_SNITCH_CONTRACT), true);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 16.4 / LZP-703 — the category default
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('C4 · the category default over all 14 categories — the floor is Privat', () => {
  const wrong = [];
  for (const row of D2) {
    const got = visibilityForNewEntry(row.category);
    if (got !== row.expect) wrong.push(`${row.id}: got ${JSON.stringify(got)}, expected ${row.expect}`);
  }
  assert.deepEqual(wrong, [], wrong.join('\n  '));
  assert.equal(DEFAULT_VISIBILITY, 'privat', '16.1 — the GLOBAL default, and it is not configurable');
});

test('C4-arity · the signature is the enforcement of "read once, at creation"', () => {
  // ADR 004 §3: "read EXACTLY ONCE, at entry creation… It is not a live rule." A function that
  // takes only a category has nothing to re-evaluate against. A mutant adding `(category, entry)`
  // — the shape a live rule needs — dies here before it can be written.
  assert.equal(visibilityForNewEntry.length, 1);
  assert.equal(seriesVisibility.length, 1);
});

test('C4-once · a two-faced category cannot answer one thing to the check and another to the caller', () => {
  // The getter defence `project.js:readOnce` documents, at the one other seam where a
  // caller-owned object decides a level. Read twice, this returns 'geteilt' for a category whose
  // first answer was 'privat'.
  const cat = twoFacedCategory();
  assert.equal(visibilityForNewEntry(cat), 'privat', 'the field was read more than once');
});

test('C4-notLive · nothing here can re-publish an existing entry when a default changes', () => {
  // Stated as a claim about the SURFACE, because that is what makes it true: this module has no
  // function that takes a category and an existing entry, so a settings click cannot become a
  // bulk disclosure (16.1). If one ever appears, this row is where the argument was.
  for (const clause of Object.keys(CATEGORY_DEFAULT_CONTRACT)) {
    assert.equal(typeof CATEGORY_DEFAULT_CONTRACT[clause], 'string');
  }
  assert.deepEqual(Object.keys(CATEGORY_DEFAULT_CONTRACT).sort(),
    ['floorIsPrivat', 'neverSynced', 'notLive', 'orthogonalToHiding', 'readOnce']);
  // A3, by construction: the default decides a LEVEL and never a field, so it cannot be published.
  assert.equal(VISIBILITY_LEVELS.includes(visibilityForNewEntry({ defaultVisibility: 'geteilt' })), true);
  // Changing the category object afterwards changes nothing that was already decided.
  const cat = { defaultVisibility: 'privat' };
  const decided = visibilityForNewEntry(cat);
  cat.defaultVisibility = 'geteilt';
  assert.equal(decided, 'privat', 'the level was decided at create and is a value, not a reference');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// A4 — series-level visibility (ADR 004 §9)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('A4 · a repeating note has ONE level for twelve years — the same object, twelve times', () => {
  // "Oma's birthday entered once, visible to everyone, forever." A repeating note IS its series
  // (9.3, one object), so there is one `visibility` register and a per-year exception is not
  // refused — it is inexpressible. `noteOccurrences` is the real expansion `layout.js` uses.
  const oma = { id: 'oma', date: '1948-03-14', text: 'Oma Geburtstag', repeatsYearly: true, visibility: 'geteilt' };
  const map = noteOccurrences([oma], '2026-01-01', '2037-12-31');
  const occ = [...map.values()].flat();
  assert.equal(occ.length, 12, 'twelve years in the window');
  assert.equal(new Set(occ.map((o) => o.note)).size, 1,
    'twelve occurrences, ONE object — there is no per-occurrence entity to hang a level on');
  assert.equal(new Set(occ.map((o) => seriesVisibility(o.note))).size, 1);
  assert.equal(seriesVisibility(oma), 'geteilt');
  // 9.4's Feb-29 rule rides along untouched, and every occurrence is still the one series.
  const feb29 = { id: 'f', date: '2024-02-29', text: 'x', repeatsYearly: true, visibility: 'belegt' };
  const f = [...noteOccurrences([feb29], '2026-01-01', '2027-12-31').values()].flat();
  assert.deepEqual(f.map((o) => o.date), ['2026-02-28', '2027-02-28']);
  assert.equal(new Set(f.map((o) => seriesVisibility(o.note))).size, 1);
});

test('A4b · one series, one projection — the family record is uuid-addressed', () => {
  // A shared yearly repeat publishes the ANCHOR and the flag; no occurrence op ever crosses the
  // wire, so a peer expands locally and a three-weeks-offline device converges with no special
  // handling (ADR 003 §3.4).
  const oma = { visibility: 'geteilt', date: '1948-03-14', text: 'Oma Geburtstag', repeatsYearly: true, coEdit: false };
  const patch = projectForFamily('fnote', oma, 'geteilt', null);
  assert.equal(patch['pub.date'], '1948-03-14', 'the anchor, not an occurrence');
  assert.equal(patch['pub.repeatsYearly'], true);
  // `pub.repeatsYearly` is the FLAG and is on the allowlist; what may not exist is a per-YEAR or
  // per-OCCURRENCE row — a field naming a concrete year, or an occurrence/series identifier.
  assert.deepEqual(Object.keys(patch).filter((k) => /occurrence|seriesid|\d{4}/i.test(k)), [],
    'a per-year or per-occurrence field would be A4 broken at the wire');
  assert.equal(Object.keys(patch).filter((k) => /year/i.test(k)).length, 1,
    'exactly one repeat field: the FLAG, never an expansion');
  // Fails closed on a garbage register, like every other READ in this module.
  assert.equal(seriesVisibility({ visibility: 'oeffentlich' }), 'privat');
  assert.equal(seriesVisibility(null), 'privat');
  assert.equal(seriesVisibility(undefined), 'privat');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// P7d — LZP-704's ACCEPTANCE CRITERION, end to end, on the PEER
//
// "For any random sequence of visibility transitions ending in `privat`, a peer's family
// materialization contains no field of that entity other than a tombstone." (ADR 004 §5,
// property test P7d.)
//
// Driven through the REAL stack — `planTransition` → `projectForFamily`/`retractPatch` → real
// `pub.set` ops → `foldAuthorized` → `materialize` — because every layer of it is a place the
// guarantee could be lost, and because the owner's own board is RIGHT in the failing case. That
// asymmetry is the whole reason §5.1 calls this "the single highest-value defect in the whole v2
// surface": no owner-side smoke test can see it.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const pad22 = (s) => (s + 'x'.repeat(22)).slice(0, 22);
const ME = `mem_${pad22('PME')}`;
const MAMA = `mem_${pad22('PMAMA')}`;
const ADMIN = `mem_${pad22('PPAPA')}`;
const FSP = `fsp_${pad22('PFAMILIE')}`;
const UUID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const BASE_MS = 1787836800000;
const DEVS = {
  [ME]: { id: `dev_${pad22('DPME')}`, short: short16('DPME') },
  [MAMA]: { id: `dev_${pad22('DPMAMA')}`, short: short16('DPMAMA') },
  [ADMIN]: { id: `dev_${pad22('DPPAPA')}`, short: short16('DPPAPA') },
};

function famOp(who, kind, e, f, ms, opts = {}) {
  let n = 0;
  return makeOp({
    act: who,
    dev: DEVS[who].id,
    gid: opts.gid ?? pad22(`gp${ms}`),
    space: opts.space ?? FSP,
    familySpaceId: FSP,
    mint: () => fmt(ms, opts.ctr ?? 0, DEVS[who].short),
    newOpId: () => pad22(`op${ms}_${opts.tag ?? ''}${++n}`),
  }, kind, e, f, opts);
}

/** Three attested members, PAPA the genesis admin — the authz preamble, for real. */
function kreis() {
  const ops = [];
  let ms = BASE_MS;
  for (const m of [ME, MAMA, ADMIN]) {
    ops.push(famOp(m, 'member.set', memberKey(m),
      { [`dev.${DEVS[m].short}`]: attestationBlob(m, DEVS[m]) }, (ms += 1000), { tag: 'a' }));
    ops.push(famOp(m, 'member.set', memberKey(m),
      { displayName: m.slice(4, 8), colorRef: 'p1', _alive: true }, (ms += 1000), { tag: 'm' }));
  }
  ops.push(famOp(ADMIN, 'space.set', spaceKey(FSP),
    { admin: ADMIN, adminPrev: null, name: 'Familie' }, (ms += 1000), { tag: 'g' }));
  return { ops, at: ms };
}

const MCTX = (me) => ({
  me,
  familySpaceId: FSP,
  members: new Map([ME, MAMA, ADMIN].map((m) => [m, { displayName: m.slice(4, 8), colorRef: 'p1', initial: m[4] }])),
  currentMembers: new Set([ME, MAMA, ADMIN]),
  hiddenMembers: new Set(),
  prefs: {},
  lastSeenSeq: {},
  defaultSettings: defaultState().settings,
});

/**
 * Drive one sequence of transitions through the REAL projection and return every op.
 * The truth write and the publication write ride under ONE gid, exactly as ADR 004 §5 requires.
 */
function driveSequence(kind, levels, at) {
  const truthKind = kind === 'fnote' ? 'note' : 'bar';
  const fk = familyKey(kind, ME, UUID);
  const tk = truthKind === 'note' ? noteKey(UUID) : `bar:${UUID}`;
  const ops = [];
  let ms = at;
  let level = 'privat';
  let lastPublished = null;
  let born = true;
  const secret = kind === 'fnote' ? 'Scheidungsanwalt 14:30' : 'Kur Bad Wörishofen';
  for (const to of levels) {
    const plan = planTransition({ from: level, to, lastPublished });
    const truth = kind === 'fnote'
      ? { visibility: to, date: '2026-12-24', text: secret, repeatsYearly: false, coEdit: false, categoryId: 'cat-secret', _alive: true, _born: fmt(BASE_MS, 0, DEVS[ME].short) }
      : { visibility: to, startDate: '2026-07-01', endDate: '2026-07-14', label: secret, coEdit: false, categoryId: 'cat-secret', _alive: true, _born: fmt(BASE_MS, 0, DEVS[ME].short) };
    const gid = pad22(`gt${ms}`);
    ms += 1000;
    // The truth write. Always — the owner's `visibility` register is the authenticated level.
    ops.push(famOp(ME, `${truthKind}.set`, tk,
      born ? { ...(kind === 'fnote'
        ? { date: truth.date, text: truth.text, categoryId: 'cat-secret', repeatsYearly: false }
        : { startDate: truth.startDate, endDate: truth.endDate, label: truth.label, categoryId: 'cat-secret' }),
      visibility: to, coEdit: false, _alive: true }
        : { visibility: to },
      ms, { space: PERSONAL_PLACEHOLDER, gid, born, tag: 't' }));
    // …and AT MOST ONE `pub.set`, whose bytes come only from `projectForFamily`.
    if (plan.family !== 'none') {
      const patch = projectForFamily(kind, truth, to, lastPublished);
      assert.ok(patch, `${plan.family} predicted, projection returned null`);
      ops.push(famOp(ME, 'pub.set', fk, { ...patch }, ms,
        { gid, ctr: 1, born: !!patch._born, tag: 'p' }));
      lastPublished = to;
    }
    born = false;
    level = to;
  }
  return { ops, fk, tk, secret, published: lastPublished !== null };
}

test('P7d · any sequence of transitions ending in `privat` leaves the peer nothing (LZP-704 AC)', () => {
  const rnd = pcg32(704);
  const k = kreis();
  let sequences = 0;
  for (const kind of ['fnote', 'fbar']) {
    for (let i = 0; i < 40; i++) {
      const n = 1 + Math.floor(rnd() * 5);
      const levels = [];
      for (let j = 0; j < n; j++) levels.push(VISIBILITY_LEVELS[Math.floor(rnd() * 3)]);
      levels.push('privat');                                   // …ending in privat
      const drive = driveSequence(kind, levels, k.at);
      const all = [...k.ops, ...drive.ops];
      sequences++;

      // THE PEER. Mama folds the identical op set on her machine and materializes it.
      const peerRegs = foldAuthorized(all, { me: MAMA, nowMs: BASE_MS + 3600000, attestVerify }).regs;
      const peer = materialize(peerRegs, MCTX(MAMA));
      const seen = [...peer.notes, ...peer.bars].filter((e) => e.isForeign);
      assert.deepEqual(seen, [],
        `${kind} [${levels.join('→')}]: the peer still holds the entity after a retraction`);

      // …and on the REGISTERS, which is the sharper claim: materialization could hide a value
      // that is still on Mama's disk. Two shapes are correct and they are different claims:
      //
      //   · NEVER PUBLISHED (every level in the sequence was `privat`) — the peer holds NO
      //     REGISTER FOR THE ENTITY AT ALL. 16.1: zero bytes on the wire, so there is nothing to
      //     null out and a `pub.level: 'privat'` cell would itself be a disclosure that the
      //     entity exists.
      //   · PUBLISHED THEN RETRACTED — `pub.level` is `'privat'` and every other withdrawable
      //     register holds an EXPLICIT null.
      if (!drive.published) {
        for (const field of GETEILT_FIELDS[kind]) {
          assert.equal(getRegister(peerRegs, drive.fk, field) ?? null, null,
            `${kind} [${levels.join('→')}]: a never-published entry left "${field}" on a peer's disk`);
        }
        continue;
      }
      for (const field of GETEILT_FIELDS[kind]) {
        const cell = getRegister(peerRegs, drive.fk, field);
        if (field === 'pub.level') {
          assert.equal(cell && cell.value, 'privat', `${kind} [${levels.join('→')}]: pub.level`);
          continue;
        }
        assert.equal(cell ? cell.value : null, null,
          `${kind} [${levels.join('→')}]: "${field}" survived the retraction with `
          + `${JSON.stringify(cell && cell.value)}. OMISSION IS NOT WITHDRAWAL (ADR 004 §5.1) — `
          + 'the peer\'s LWW fold keeps the old value AND its stamp, and Mama\'s board keeps '
          + 'rendering it while mine looks correctly downgraded.');
      }

      // The secret appears in NO family op at all, at any point in the sequence, and neither
      // does the category (P7g). Asserted on the emitted ops, per ADR 004's headline.
      for (const op of drive.ops) {
        if (op.k !== 'pub.set') continue;
        const bytes = JSON.stringify(op.f);
        const geteiltHere = op.f['pub.level'] === 'geteilt';
        if (!geteiltHere) {
          assert.equal(bytes.includes(drive.secret), false,
            `${kind} [${levels.join('→')}]: a non-Geteilt op carried the content — INV-R1`);
        }
        assert.equal(bytes.includes('cat-secret'), false, 'A3 — the category reached a family op');
      }

      // INV-R3 — and my OWN board still has everything. A redaction may never make my board lie.
      const ownRegs = foldAuthorized(all, { me: ME, nowMs: BASE_MS + 3600000, attestVerify }).regs;
      const own = materialize(ownRegs, MCTX(ME));
      const mine = [...own.notes, ...own.bars].find((e) => e.id === UUID && !e.isForeign);
      assert.ok(mine, `${kind} [${levels.join('→')}]: the downgrade deleted my own entry`);
      assert.equal(kind === 'fnote' ? mine.text : mine.label, drive.secret,
        `${kind} [${levels.join('→')}]: the downgrade BLANKED MY OWN ENTRY — INV-R3 / P7c`);
      assert.equal(mine.visibility, 'privat');
    }
  }
  assert.equal(sequences, 80, 'seed 704 — 40 sequences per kind');
});

test('P7d-b · a peer that never saw the intermediate ops lands on the same nothing', () => {
  // ADR 004 §5.3 mechanism 1: the argmax fold ignores intermediates, so a device that was offline
  // for the whole Geteilt period and receives only the LAST op is in the same state as one that
  // watched every step. If this needed the intermediates, retraction would depend on delivery.
  const k = kreis();
  const drive = driveSequence('fnote', ['geteilt', 'belegt', 'geteilt', 'privat'], k.at);
  const pubs = drive.ops.filter((o) => o.k === 'pub.set');
  const onlyLast = [...k.ops, pubs[pubs.length - 1]];
  const regs = foldAuthorized(onlyLast, { me: MAMA, nowMs: BASE_MS + 3600000, attestVerify }).regs;
  assert.deepEqual(materialize(regs, MCTX(MAMA)).notes.filter((n) => n.isForeign), []);
  for (const field of GETEILT_FIELDS.fnote) {
    if (field === 'pub.level') continue;
    const cell = getRegister(regs, drive.fk, field);
    assert.equal(cell ? cell.value : null, null, `${field} survived a retraction-only delivery`);
  }
});

test('P7d-c · 16.1 is structural — a Privat entry produces ZERO family ops, not a redacted one', () => {
  // The claim the whole epic rests on, measured as a COUNT of ops rather than as a shape.
  for (const kind of ['fnote', 'fbar']) {
    const k = kreis();
    const drive = driveSequence(kind, ['privat', 'privat'], k.at);
    const pubs = drive.ops.filter((o) => o.k === 'pub.set');
    assert.deepEqual(pubs, [],
      `${kind}: a Privat entry emitted a family op. "Private by default costs zero bytes on the wire."`);
    // …and every op it DID emit is a personal-space truth write.
    for (const op of drive.ops) {
      assert.equal(op.k, kind === 'fnote' ? 'note.set' : 'bar.set');
      assert.equal(op.space, PERSONAL_PLACEHOLDER);
    }
  }
});

test('P7d-d · a downgrade is one transaction: the truth write and the publication share a gid', () => {
  // ADR 004 §5: "Every transition is ONE transaction carrying the truth write plus the
  // publication write." One ⌘Z (18.4), and no window in which the two disagree.
  const k = kreis();
  const drive = driveSequence('fnote', ['geteilt', 'privat'], k.at);
  const byGid = new Map();
  for (const op of drive.ops) {
    if (!byGid.has(op.gid)) byGid.set(op.gid, []);
    byGid.get(op.gid).push(op);
  }
  for (const [gid, ops] of byGid) {
    assert.equal(ops.length, 2, `gid ${gid}: a transition must carry exactly the two writes`);
    assert.deepEqual(ops.map((o) => o.k).sort(), ['note.set', 'pub.set']);
    assert.equal(new Set(ops.map((o) => o.e)).size, 2, 'two entities, one transaction');
  }
});
