// tests/tier1/core-ops.test.js — the op vocabulary and the entity layer.
// ADR 001 §2, §3, §4.4, §5, §7.4, §10 · ADR 004 §2.1, §9 · ADR 005 §1.1, §3 · ops.contract.js.
//
// WHAT THIS FILE IS PROTECTING, in the order it matters.
//
//  1. THE 22-SITE COVERAGE TEST. Every `store.mutate()` call site in the v1 tree is enumerated
//     here as a literal `file:line` list, read out of the v1 source by hand and cross-checked
//     against `grep -rn 'store.mutate('`. A v1 mutation with no op kind is a SILENT DATA-LOSS BUG
//     in the retrofit: the gesture keeps working, the board looks right, and the change never
//     reaches the log or any other device. The list is literal on purpose — a test that
//     re-derived it from the same table it is checking would prove nothing.
//
//  2. THE FIELDS TABLE, TRANSCRIBED AND PINNED. `FIELDS` is the one table every downstream agent
//     reads (ADR 001 §3.1). Its field NAMES and its truth-vs-`pub.*` split are asserted against
//     literal expected sets rather than against themselves, so a field silently added to `fnote`
//     next year fails a test instead of shipping. A3 — `categoryId` is never published, at any
//     level — is enforced by the ABSENCE of a field, so the test asserts an absence.
//
//  3. PARKING, NOT DROPPING. An unknown kind, an unknown field name, an unknown space and an
//     unknown op version are PARKED; a type violation is REJECTED. That difference is what makes
//     an old client in a family with a newer sibling degrade to "does not show the new thing"
//     rather than "loses the new thing" (ADR 001 §7.4, §12.5).
//
//  4. THE ONE SHARED DAY-SELECTOR. `entities.notesOnDate` / `barsOnDate` must reproduce v1's
//     selection semantics EXACTLY, or WP-5 changes the board while claiming to refactor it. It is
//     checked twice: against the REAL `layout.js` through `buildBoard()`, and against the
//     `popover.js:47-61` predicate lifted verbatim (the popover itself is DOM-coupled and cannot
//     be imported in tier 1 — that is what tier 2 is for).
//
// NO TEST READS THE WALL CLOCK (ADR 005 §5). Every stamp comes from a fake clock, every id from a
// counter, and `boardState()` pins the board to `pinned` mode so `buildBoard()` is deterministic.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FIELDS, OP_KINDS, OP_KIND_NAMES, OP_VERSION, PARK_REASONS, LOCAL_SPACE, PERSONAL_PLACEHOLDER,
  MUTATIONS, V1_MUTATE_SITES,
  fieldSpec, fieldsOf, coEditableFields, governingFields,
  isPubField, isTruthField, isReservedField, seriesIdOf, opKindForEntity, spaceClassOf,
  validateOp, classifyOp, isParkReason, makeOp, buildMutation, mutation, OpError,
  noteSet, barSet, catSet, padSet, prefSet, pubSet, memberSet, spaceSet,
  settingsSet, layerSet, flattenPref,
} from '../../src/js/core/ops.js';

import {
  ENTITY_KINDS, TRUTH_KINDS, FAMILY_KINDS, OWNED_FAMILY_KINDS, FAMILY_OF, TRUTH_OF,
  VISIBILITY_LEVELS, PREF_KEY, EntityKeyError,
  localKey, noteKey, barKey, catKey, padKey, familyKey, familyKeyFor, memberKey, spaceKey,
  parseEntityKey, kindOfEntity, ownerOfEntity, idOfEntity, isEntityKey,
  isMemberId, isDeviceId, isSpaceId, isOpId, isEntityUuid, isMonthKey, isDateString,
  DATE_RE, EARLIEST_DATE, LATEST_DATE,
  p2, iso, parseISO, isLeap, daysInMonth, addDays, diffDays, projectYearly, reanchorRepeat,
  categoryVisibilityOf, visibleNotes, visibleBars,
  noteOccurrences, noteOccurrencesInRange, notesOnDate, barsOnDate, barsInRange,
  renderableNote, renderableBar, renderable, projectable,
  cmpNotes, cmpBars, cmpCategories, sortNotes, sortBars, sortCategories, sortScratchpads,
} from '../../src/js/core/entities.js';

// The REAL v1 modules the selector and the comparators must agree with.
import * as v1dates from '../../src/js/dates.js';
import { buildBoard, assignLanes } from '../../src/js/layout.js';
import { boardState, note, bar, CAT, dayOf } from '../helpers/fixtures.js';

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic helpers. Seeded, injected, wall-clock-free.
// ─────────────────────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(rnd, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const DEV_SHORT = '7QAR2MZ9XKPNC0GV';
const ME = `mem_${'A'.repeat(22)}`;
const MAMA = `mem_${'M'.repeat(22)}`;
const DEVICE = `dev_${'B'.repeat(22)}`;
const GID = 'C'.repeat(22);
const PSP = `psp_${'E'.repeat(22)}`;
const FSP = `fsp_${'F'.repeat(22)}`;

/** A clock and an id source under the test's control. Nothing here reads the real ones. */
function makeCtx(over = {}) {
  let ms = 1787836800000;
  let ctr = 0;
  let n = 0;
  return {
    act: ME,
    dev: DEVICE,
    gid: GID,
    space: PSP,
    familySpaceId: FSP,
    mint: () => `${String(ms).padStart(13, '0')}.${String(ctr++).padStart(6, '0')}.${DEV_SHORT}`,
    newOpId: () => String(++n).padStart(22, 'z'),
    ...over,
  };
}

const stampAt = (ms, ctr = 0, dev = DEV_SHORT) =>
  `${String(ms).padStart(13, '0')}.${String(ctr).padStart(6, '0')}.${dev}`;

/** A minimal legal op of any kind, so a test can mutate exactly one thing about it. */
function legalOp(over = {}) {
  return {
    v: OP_VERSION,
    id: 'q'.repeat(22),
    ts: stampAt(1787836800000, 3),
    space: PSP,
    act: ME,
    dev: DEVICE,
    gid: GID,
    k: 'note.set',
    e: 'note:5e1a-9c',
    f: { text: 'Zahnarzt' },
    ...over,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// A. The FIELDS table (ADR 001 §3.1)
// ═════════════════════════════════════════════════════════════════════════════

test('FIELDS has exactly one row per entity kind, and no extras', () => {
  assert.deepEqual(Object.keys(FIELDS).sort(), [...ENTITY_KINDS].sort());
  assert.deepEqual([...TRUTH_KINDS, ...FAMILY_KINDS].sort(), [...ENTITY_KINDS].sort());
});

test('FIELDS field names are exactly ADR 001 §3.1, transcribed', () => {
  // Literal expectations. If a field is added, removed or renamed anywhere in the product this
  // test fails first — which is the point of "nobody invents a field".
  const expected = {
    note: ['date', 'text', 'categoryId', 'repeatsYearly', 'visibility', 'coEdit', '_alive', '_born'],
    bar: ['startDate', 'endDate', 'label', 'categoryId', 'visibility', 'coEdit', '_alive', '_born'],
    cat: ['name', 'nameEn', 'paletteRef', 'visible', 'defaultVisibility', '_alive', '_born'],
    pad: ['text', '_alive', '_born'],
    pref: [],                                  // one wildcard row, no named fields
    fnote: ['pub.level', 'pub.coEdit', 'pub.alive', 'pub.date', 'pub.text', 'pub.repeatsYearly', '_born'],
    fbar: ['pub.level', 'pub.coEdit', 'pub.alive', 'pub.startDate', 'pub.endDate', 'pub.label', '_born'],
    member: ['displayName', 'colorRef', '_alive', '_born'],
    space: ['name', 'admin', 'adminPrev', 'epoch'],
  };
  for (const kind of ENTITY_KINDS) {
    assert.deepEqual(fieldsOf(kind).sort(), expected[kind].sort(), `FIELDS.${kind}`);
  }
});

test('every FieldSpec matches the ADR, attribute by attribute', () => {
  const spec = (kind, name) => {
    const s = fieldSpec(kind, name);
    const out = { t: s.t };
    for (const flag of ['coEdit', 'gov', 'writeOnce', 'geteiltOnly', 'local']) {
      if (flag in s) out[flag] = s[flag];
    }
    if (s.values) out.values = s.values;
    return out;
  };
  const V = ['privat', 'belegt', 'geteilt'];
  assert.deepEqual(spec('note', 'date'), { t: 'date', coEdit: true });
  assert.deepEqual(spec('note', 'text'), { t: 'str80', coEdit: true });
  assert.deepEqual(spec('note', 'categoryId'), { t: 'id', coEdit: false });
  assert.deepEqual(spec('note', 'repeatsYearly'), { t: 'bool', coEdit: true });
  assert.deepEqual(spec('note', 'visibility'), { t: 'enum', gov: true, values: V });
  assert.deepEqual(spec('note', 'coEdit'), { t: 'bool', gov: true });
  assert.deepEqual(spec('note', '_alive'), { t: 'bool', gov: true });
  assert.deepEqual(spec('note', '_born'), { t: 'stamp', writeOnce: true });
  assert.deepEqual(spec('bar', 'label'), { t: 'str40', coEdit: true });
  assert.deepEqual(spec('cat', 'defaultVisibility'), { t: 'enum', values: V });
  assert.deepEqual(spec('pad', 'text'), { t: 'str' });
  assert.deepEqual(spec('fnote', 'pub.text'), { t: 'str80', coEdit: true, geteiltOnly: true });
  assert.deepEqual(spec('fbar', 'pub.label'), { t: 'str40', coEdit: true, geteiltOnly: true });
  assert.deepEqual(spec('fnote', 'pub.level'), { t: 'enum', gov: true, values: V });
  assert.deepEqual(spec('space', 'admin'), { t: 'id' });
  assert.deepEqual(spec('space', 'adminPrev'), { t: 'opId' });
  assert.deepEqual(spec('space', 'epoch'), { t: 'int' });
  assert.deepEqual(spec('member', `dev.${DEV_SHORT}`), { t: 'str', writeOnce: true });
  assert.deepEqual(spec('pref', 'anythingAtAll'), { t: 'any', local: true });
});

test('the truth / pub split is total: no pub.* on a truth kind, nothing but pub.* + _born on a family entry', () => {
  for (const kind of ['note', 'bar', 'cat', 'pad']) {
    assert.deepEqual(fieldsOf(kind).filter(isPubField), [], `${kind} must carry no pub.* field`);
  }
  for (const kind of ['fnote', 'fbar']) {
    const named = fieldsOf(kind).filter((f) => !isPubField(f));
    assert.deepEqual(named, ['_born'], `${kind} carries only pub.* fields plus _born`);
  }
  assert.ok(isTruthField('date') && isTruthField('categoryId'));
  assert.ok(!isTruthField('pub.text') && !isTruthField('_alive'));
  assert.ok(isReservedField('_born') && !isReservedField('date'));
});

test('A3 — categoryId has NO pub counterpart at ANY level, in ANY family kind', () => {
  // ADR 004 §1: enforced by the ABSENCE of a field, not by a filter someone can forget to apply.
  for (const kind of FAMILY_KINDS) {
    for (const f of fieldsOf(kind)) {
      assert.ok(
        !/categor/i.test(f),
        `${kind}.${f} looks like a category field — A3 forbids one at any level`,
      );
    }
  }
  assert.equal(fieldSpec('fnote', 'pub.categoryId'), null);
  assert.equal(fieldSpec('fbar', 'categoryId'), null);
});

test('there is no owner field and no seriesId field, anywhere', () => {
  // ADR 001 §12.6. Ownership is the <memberId> segment of the family key (§4.4); seriesId is an
  // alias of the entity uuid (§3.1). A register for either would be a way to backdate identity.
  for (const kind of ENTITY_KINDS) {
    for (const f of fieldsOf(kind)) {
      assert.notEqual(f, 'owner', `${kind}.owner must not exist`);
      assert.notEqual(f, 'ownerId', `${kind}.ownerId must not exist`);
      assert.notEqual(f, 'seriesId', `${kind}.seriesId must not exist`);
    }
  }
  assert.equal(seriesIdOf('note:5e1a-9c'), '5e1a-9c');
  assert.equal(seriesIdOf(familyKey('fnote', MAMA, '5e1a-9c')), '5e1a-9c');
  assert.equal(seriesIdOf('bar:5e1a-9c'), null);
});

test('every enum in the table is exactly the three visibility levels', () => {
  assert.deepEqual([...VISIBILITY_LEVELS], ['privat', 'belegt', 'geteilt']);
  let found = 0;
  for (const kind of ENTITY_KINDS) {
    for (const f of fieldsOf(kind)) {
      const s = FIELDS[kind][f];
      if (s.t !== 'enum') continue;
      found++;
      assert.deepEqual([...s.values], ['privat', 'belegt', 'geteilt'], `${kind}.${f}`);
    }
  }
  assert.equal(found, 5, 'note.visibility, bar.visibility, cat.defaultVisibility, fnote/fbar pub.level');
});

test('coEditable and governing fields are exactly what ADR 001 §4.3 admits', () => {
  assert.deepEqual(coEditableFields('note').sort(), ['date', 'repeatsYearly', 'text']);
  assert.deepEqual(coEditableFields('bar').sort(), ['endDate', 'label', 'startDate']);
  assert.deepEqual(coEditableFields('fnote').sort(), ['pub.date', 'pub.repeatsYearly', 'pub.text']);
  assert.deepEqual(coEditableFields('fbar').sort(), ['pub.endDate', 'pub.label', 'pub.startDate']);
  // categoryId is explicitly NOT co-editable, and it is not published either (A3).
  assert.equal(FIELDS.note.categoryId.coEdit, false);
  // Stage 3a: a co-editor can never grant themselves co-edit.
  assert.deepEqual(governingFields('fnote').sort(), ['_born', 'pub.alive', 'pub.coEdit', 'pub.level']);
  assert.deepEqual(governingFields('fbar').sort(), ['_born', 'pub.alive', 'pub.coEdit', 'pub.level']);
  assert.deepEqual(governingFields('note').sort(), ['_alive', 'coEdit', 'visibility']);
});

test('geteiltOnly marks exactly the two content fields Belegt withholds', () => {
  const flagged = [];
  for (const kind of ENTITY_KINDS) {
    for (const f of fieldsOf(kind)) if (FIELDS[kind][f].geteiltOnly) flagged.push(`${kind}.${f}`);
  }
  assert.deepEqual(flagged.sort(), ['fbar.pub.label', 'fnote.pub.text']);
});

test('_born is write-once wherever it exists, and it is a stamp', () => {
  for (const kind of ENTITY_KINDS) {
    const s = fieldSpec(kind, '_born');
    if (!s || kind === 'pref') continue;
    assert.equal(s.t, 'stamp', `${kind}._born`);
    assert.equal(s.writeOnce, true, `${kind}._born must be write-once`);
  }
  assert.equal(FIELDS.member['dev.*'].writeOnce, true, 'dev.* registers are write-once');
});

test('FIELDS and OP_KINDS are deeply frozen — nobody patches the vocabulary at runtime', () => {
  assert.ok(Object.isFrozen(FIELDS));
  assert.ok(Object.isFrozen(FIELDS.note));
  assert.ok(Object.isFrozen(FIELDS.note.date));
  assert.ok(Object.isFrozen(OP_KINDS));
  assert.throws(() => { FIELDS.note.smuggled = { t: 'str' }; }, TypeError);
  assert.equal(fieldSpec('note', 'smuggled'), null);
});

test('fieldSpec resolves the two wildcard rows and nothing else', () => {
  assert.equal(fieldSpec('pref', 'rowHeight').t, 'any');
  assert.equal(fieldSpec('pref', 'layers.feiertage').t, 'any');
  assert.equal(fieldSpec('member', `dev.${DEV_SHORT}`).t, 'str');
  assert.equal(fieldSpec('member', 'dev.lowercase12345'), null);
  assert.equal(fieldSpec('note', '*'), null, 'the pref wildcard must not leak to other kinds');
  assert.equal(fieldSpec('nosuchkind', 'date'), null);
});

// ═════════════════════════════════════════════════════════════════════════════
// B. The eight op kinds (ADR 001 §3)
// ═════════════════════════════════════════════════════════════════════════════

test('there are exactly eight op kinds, and they are ADR 001 §3s table', () => {
  assert.deepEqual([...OP_KIND_NAMES].sort(), [
    'bar.set', 'cat.set', 'member.set', 'note.set', 'pad.set', 'pref.set', 'pub.set', 'space.set',
  ]);
  assert.equal(OP_KIND_NAMES.length, 8);
});

test('each op kind addresses the entity kinds and the space ADR 001 §3 assigns it', () => {
  assert.deepEqual(OP_KINDS['note.set'], { entities: ['note'], space: 'personal' });
  assert.deepEqual(OP_KINDS['bar.set'], { entities: ['bar'], space: 'personal' });
  assert.deepEqual(OP_KINDS['cat.set'], { entities: ['cat'], space: 'personal' });
  assert.deepEqual(OP_KINDS['pad.set'], { entities: ['pad'], space: 'personal' });
  assert.deepEqual(OP_KINDS['pref.set'], { entities: ['pref'], space: 'local' });
  assert.deepEqual(OP_KINDS['pub.set'], { entities: ['fnote', 'fbar'], space: 'family' });
  assert.deepEqual(OP_KINDS['member.set'], { entities: ['member'], space: 'family' });
  assert.deepEqual(OP_KINDS['space.set'], { entities: ['space'], space: 'family' });
  for (const kind of ENTITY_KINDS) assert.ok(opKindForEntity(kind), `${kind} has no op kind`);
  assert.equal(opKindForEntity('nosuchkind'), null);
});

test('there is no op kind for a read receipt, a presence signal or a notification', () => {
  // ADR 004 §7: Principle 9 is enforced by the ABSENCE of a mechanism, not by a policy.
  for (const k of OP_KIND_NAMES) {
    assert.ok(
      !/(read|seen|presence|notify|notification|typing|receipt|reset)/i.test(k),
      `${k} is a surveillance-shaped op kind`,
    );
  }
  assert.equal(OP_KINDS['board.reset'], undefined, 'ADR 001 §8.5 rejected board.reset');
});

test('spaceClassOf recognises the four space forms and nothing else', () => {
  assert.equal(spaceClassOf(LOCAL_SPACE), 'local');
  assert.equal(spaceClassOf(PERSONAL_PLACEHOLDER), 'personal');
  assert.equal(spaceClassOf(PSP), 'personal');
  assert.equal(spaceClassOf(FSP), 'family');
  assert.equal(spaceClassOf('wibble'), null);
  assert.equal(spaceClassOf(''), null);
  assert.equal(spaceClassOf(42), null);
});

// ═════════════════════════════════════════════════════════════════════════════
// C. Entity keys — structural ownership (ADR 001 §1.1, §4.4, §12.3)
// ═════════════════════════════════════════════════════════════════════════════

test('the key builders produce exactly the ADR 001 §1.1 shapes', () => {
  assert.equal(noteKey('5e1a-9c'), 'note:5e1a-9c');
  assert.equal(barKey('5e1a-9c'), 'bar:5e1a-9c');
  assert.equal(catKey('5e1a-9c'), 'cat:5e1a-9c');
  assert.equal(padKey('2026-09'), 'pad:2026-09');
  assert.equal(localKey('pref'), 'pref:app');
  assert.equal(PREF_KEY, 'pref:app');
  assert.equal(familyKey('fnote', MAMA, '5e1a-9c'), `fnote:${MAMA}/5e1a-9c`);
  assert.equal(familyKey('fbar', MAMA, '5e1a-9c'), `fbar:${MAMA}/5e1a-9c`);
  assert.equal(memberKey(MAMA), `member:${MAMA}`);
  assert.equal(spaceKey(FSP), `space:${FSP}`);
});

test('ownership is a substring of the key, and it is the ONLY place ownership lives', () => {
  const k = familyKey('fnote', MAMA, '5e1a-9c');
  assert.equal(ownerOfEntity(k), MAMA);
  assert.equal(kindOfEntity(k), 'fnote');
  assert.equal(idOfEntity(k), '5e1a-9c');
  // A personal-space entity has no owner segment — the space has exactly one writing human.
  assert.equal(ownerOfEntity('note:5e1a-9c'), null);
  // member: and space: are family entities but are not OWNED in the <mem>/<uuid> sense.
  assert.deepEqual([...OWNED_FAMILY_KINDS], ['fnote', 'fbar']);
  assert.equal(ownerOfEntity(memberKey(MAMA)), null);
  assert.equal(ownerOfEntity(spaceKey(FSP)), null);
});

test('an entity uuid can never contain a separator, so a family key can never be ambiguous', () => {
  // This is what makes ownership unforgeable rather than merely conventional: if a uuid could
  // contain "/" then `fnote:mem_A/mem_B/uuid` would parse two ways and a member could mint a key
  // that reads as somebody else's.
  assert.throws(() => familyKey('fnote', MAMA, `x/${ME}/y`), EntityKeyError);
  assert.throws(() => familyKey('fnote', MAMA, 'a:b'), EntityKeyError);
  assert.throws(() => noteKey('a/b'), EntityKeyError);
  assert.throws(() => noteKey(''), EntityKeyError);
  assert.equal(parseEntityKey(`fnote:${MAMA}/a/b`), null, 'a second slash is not a legal key');
  // Only a well-formed MemberId may occupy the owner segment.
  assert.throws(() => familyKey('fnote', 'mama', '5e1a-9c'), EntityKeyError);
  assert.equal(parseEntityKey('fnote:mama/5e1a-9c'), null);
});

test('parseEntityKey never throws, whatever arrives from a peer', () => {
  const junk = [null, undefined, 42, {}, [], '', ':', 'note:', ':x', 'note', 'wibble:x',
    'note:'.padEnd(400, 'x'), 'pad:2026-13', 'pad:2026-1', 'pref:other', `space:${ME}`,
    'fnote:/x', `fnote:${MAMA}/`, '__proto__:x'];
  for (const j of junk) {
    assert.equal(parseEntityKey(j), null, `parseEntityKey(${JSON.stringify(j)})`);
    assert.equal(isEntityKey(j), false);
    assert.equal(kindOfEntity(j), null);
    assert.equal(ownerOfEntity(j), null);
  }
});

test('familyKeyFor carries the uuid across unchanged (ADR 004 §9)', () => {
  // The family record is uuid-addressed, so moving a repeat's anchor cannot change what it
  // points at — which is what makes series-level visibility (A4) free.
  assert.equal(familyKeyFor('note:5e1a-9c', MAMA), `fnote:${MAMA}/5e1a-9c`);
  assert.equal(familyKeyFor('bar:5e1a-9c', MAMA), `fbar:${MAMA}/5e1a-9c`);
  assert.deepEqual(FAMILY_OF, { note: 'fnote', bar: 'fbar' });
  assert.deepEqual(TRUTH_OF, { fnote: 'note', fbar: 'bar' });
  assert.throws(() => familyKeyFor('cat:5e1a-9c', MAMA), EntityKeyError);
});

test('the id shape predicates accept v1 ids and reject near-misses', () => {
  assert.ok(isMemberId(ME) && isDeviceId(DEVICE) && isSpaceId(PSP) && isSpaceId(FSP));
  assert.ok(isOpId('q'.repeat(22)));
  assert.ok(!isOpId('q'.repeat(21)) && !isOpId('q'.repeat(23)) && !isOpId('q'.repeat(21) + '+'));
  assert.ok(!isMemberId(`mem_${'A'.repeat(21)}`) && !isMemberId(MAMA.slice(4)));
  assert.ok(!isSpaceId(`xsp_${'E'.repeat(22)}`));
  // v1 entity ids: crypto.randomUUID AND the store.js:14-16 fallback, both kept verbatim.
  assert.ok(isEntityUuid('7f2c1a3b-4d5e-4f60-8a91-bc2d3e4f5061'));
  assert.ok(isEntityUuid('id-l3k2j1-ab12cd34'));
  assert.ok(isMonthKey('2026-01') && isMonthKey('2026-12'));
  assert.ok(!isMonthKey('2026-13') && !isMonthKey('2026-00') && !isMonthKey('2026-1'));
});

// ═════════════════════════════════════════════════════════════════════════════
// D. validateOp / classifyOp — PARK vs REJECT (ADR 001 §7.4, §10)
// ═════════════════════════════════════════════════════════════════════════════

test('a well-formed op of every kind validates', () => {
  const ctx = makeCtx();
  const ops = [
    noteSet(ctx, 'n1', { date: '2026-09-10', text: 'Zahnarzt' }),
    barSet(ctx, 'b1', { startDate: '2026-09-01', endDate: '2026-09-08', label: 'Urlaub' }),
    catSet(ctx, 'c1', { name: 'Arbeit', visible: true }),
    padSet(ctx, '2026-09', { text: 'Einkaufen' }),
    prefSet(ctx, { rowHeight: 22, 'layers.feiertage': true }),
    pubSet(ctx, 'fnote', MAMA, 'n1', { 'pub.level': 'belegt', 'pub.date': '2026-09-10' }),
    memberSet(ctx, MAMA, { displayName: 'Mama', [`dev.${DEV_SHORT}`]: 'YXR0ZXN0' }),
    spaceSet(ctx, FSP, { name: 'Familie Hein', admin: ME, adminPrev: null, epoch: 1 }),
  ];
  assert.equal(ops.length, 8);
  for (const op of ops) assert.deepEqual(validateOp(op), { ok: true }, `${op.k} ${op.e}`);
  assert.deepEqual([...new Set(ops.map((o) => o.k))].sort(), [...OP_KIND_NAMES].sort());
});

test('an unknown op KIND is parked, never rejected', () => {
  const r = validateOp(legalOp({ k: 'gift.set' }));
  assert.equal(r.ok, false);
  assert.equal(r.park, true);
  assert.equal(r.parkReason, PARK_REASONS.UNKNOWN_KIND);
  assert.ok(isParkReason(r.parkReason));
  assert.deepEqual(classifyOp(legalOp({ k: 'gift.set' })), {
    status: 'park', reason: r.reason, parkReason: PARK_REASONS.UNKNOWN_KIND,
  });
});

test('an unknown FIELD parks the whole op — it is never partly applied', () => {
  // ADR 001 §7.4/§10: parked WITH its op. Applying the half we understand is how "does not show
  // the new thing" turns into "loses the new thing".
  const r = validateOp(legalOp({ f: { text: 'Zahnarzt', mood: 'sonnig', pinned: true } }));
  assert.equal(r.park, true);
  assert.equal(r.parkReason, PARK_REASONS.UNKNOWN_FIELD);
  assert.deepEqual(r.fields, ['mood', 'pinned']);
  // and the known half is NOT reported as applicable
  assert.equal(r.ok, false);
});

test('an unknown SPACE and an unknown VERSION are parked', () => {
  const s = validateOp(legalOp({ space: 'xsp_something' }));
  assert.equal(s.park, true);
  assert.equal(s.parkReason, PARK_REASONS.UNKNOWN_SPACE);
  const v = validateOp(legalOp({ v: 2 }));
  assert.equal(v.park, true);
  assert.equal(v.parkReason, PARK_REASONS.VERSION);
  // but a nonsense version is a malformed op, not a future one
  assert.equal(validateOp(legalOp({ v: 'one' })).park, false);
  assert.equal(validateOp(legalOp({ v: 0 })).park, false);
});

test('a TYPE violation is rejected, not parked — that is a protocol violation, not version skew', () => {
  const bad = [
    [{ date: '10.09.2026' }, 'date format'],
    [{ date: 20260910 }, 'date not a string'],
    [{ text: 'x'.repeat(81) }, 'str80 overflow'],
    [{ repeatsYearly: 'yes' }, 'bool'],
    [{ visibility: 'oeffentlich' }, 'enum'],
    [{ _born: 'not-a-stamp' }, 'stamp'],
    [{ categoryId: '' }, 'empty id'],
  ];
  for (const [f, why] of bad) {
    const r = validateOp(legalOp({ f }));
    assert.equal(r.ok, false, why);
    assert.equal(r.park, false, `${why} must be rejected, not parked`);
  }
  assert.equal(validateOp(legalOp({ k: 'space.set', space: FSP, e: spaceKey(FSP), f: { epoch: 1.5 } })).park, false);
  assert.equal(validateOp(legalOp({ k: 'space.set', space: FSP, e: spaceKey(FSP), f: { adminPrev: 'short' } })).park, false);
  assert.equal(validateOp(legalOp({ k: 'bar.set', e: 'bar:b1', f: { label: 'x'.repeat(41) } })).park, false);
});

test('f is JSON SCALARS OR null ONLY — no nested objects, no arrays', () => {
  for (const v of [{ a: 1 }, [1, 2], new Date(0), NaN, Infinity, undefined, () => 1]) {
    const r = validateOp(legalOp({ f: { text: v } }));
    assert.equal(r.ok, false, `f.text = ${String(v)} must be refused`);
    assert.equal(r.park, false);
  }
  // `null` is a FIRST-CLASS value on every field: it clears the register (ADR 004 §5.1).
  for (const name of ['text', 'date', 'categoryId', 'repeatsYearly', 'visibility', '_alive', '_born']) {
    assert.deepEqual(validateOp(legalOp({ f: { [name]: null } })), { ok: true }, `${name}: null`);
  }
});

test('an op that writes nothing is malformed', () => {
  assert.equal(validateOp(legalOp({ f: {} })).ok, false);
  assert.equal(validateOp(legalOp({ f: {} })).park, false);
  assert.equal(validateOp(legalOp({ f: null })).ok, false);
  assert.equal(validateOp(legalOp({ f: [] })).ok, false);
});

test('kind, entity and space must agree', () => {
  assert.equal(validateOp(legalOp({ k: 'bar.set', e: 'note:n1' })).ok, false);
  assert.equal(validateOp(legalOp({ k: 'note.set', e: `fnote:${MAMA}/n1` })).ok, false);
  assert.equal(validateOp(legalOp({ k: 'pub.set', e: 'note:n1' })).ok, false);
  // right entity, wrong space class
  assert.equal(validateOp(legalOp({ k: 'note.set', space: FSP })).ok, false);
  assert.equal(validateOp(legalOp({ k: 'note.set', space: LOCAL_SPACE })).ok, false);
  const pref = legalOp({ k: 'pref.set', e: PREF_KEY, space: PSP, gid: null, f: { rowHeight: 22 } });
  assert.equal(validateOp(pref).ok, false, 'pref.set belongs in the local space');
  // the solo-mode placeholder personal space is legal (ADR 001 §8.2)
  assert.deepEqual(validateOp(legalOp({ space: PERSONAL_PLACEHOLDER })), { ok: true });
});

test('the envelope header fields are all required and all shape-checked', () => {
  for (const over of [{ id: 'short' }, { ts: 'nope' }, { act: 'me' }, { dev: 'laptop' },
    { act: DEVICE }, { dev: ME }, { e: 42 }]) {
    const r = validateOp(legalOp(over));
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(r.park, false, JSON.stringify(over));
  }
  assert.equal(validateOp('not an op').ok, false);
  assert.equal(validateOp(null).ok, false);
  assert.equal(validateOp([legalOp()]).ok, false);
});

test('gid is required everywhere except pref.set, which carries none (rule U6)', () => {
  assert.equal(validateOp(legalOp({ gid: null })).ok, false);
  assert.equal(validateOp(legalOp({ gid: 'short' })).ok, false);
  const pref = { k: 'pref.set', e: PREF_KEY, space: LOCAL_SPACE, f: { rowHeight: 22 } };
  assert.deepEqual(validateOp(legalOp({ ...pref, gid: null })), { ok: true });
  assert.deepEqual(validateOp(legalOp({ ...pref, gid: GID })), { ok: true });
  assert.equal(prefSet(makeCtx(), { rowHeight: 22 }).gid, null);
});

test('prototype-polluting field names are rejected outright', () => {
  for (const name of ['__proto__', 'constructor', 'prototype']) {
    const f = {};
    Object.defineProperty(f, name, { value: 'x', enumerable: true, configurable: true, writable: true });
    const r = validateOp(legalOp({ f }));
    assert.equal(r.ok, false, name);
    assert.equal(r.park, false, `${name} is a defect, not version skew`);
  }
});

test('a dev.* register name must be dev.<deviceShort16> exactly', () => {
  const base = { k: 'member.set', e: memberKey(MAMA), space: FSP };
  assert.deepEqual(validateOp(legalOp({ ...base, f: { [`dev.${DEV_SHORT}`]: 'YXR0' } })), { ok: true });
  for (const name of ['dev.short', 'dev.7qar2mz9xkpnc0gv', `dev.${DEV_SHORT}X`, 'dev.']) {
    const r = validateOp(legalOp({ ...base, f: { [name]: 'YXR0' } }));
    assert.equal(r.ok, false, name);
    assert.equal(r.park, false, `${name} is a malformed register name, not an unknown field`);
  }
});

test('dates are checked for FORMAT, not for calendar validity — the interact.js:330-334 quirk', () => {
  // v1 legally produces "2025-02-29" when a repeat anchored in a non-leap year is dragged onto
  // 29 February, and renders it correctly through projectYearly. A calendar check here would
  // make an existing, working gesture emit an invalid op. Pinned so nobody "fixes" it silently.
  assert.equal(reanchorRepeat('2025-06-01', '2028-02-29'), '2025-02-29');
  assert.ok(isDateString('2025-02-29'));
  assert.deepEqual(validateOp(legalOp({ f: { date: '2025-02-29' } })), { ok: true });
  assert.equal(projectYearly('2025-02-29', 2026), '2026-02-28');
  assert.equal(projectYearly('2025-02-29', 2028), '2028-02-29');
  // but structurally impossible strings are still refused
  for (const d of ['2026-13-01', '2026-00-01', '2026-01-00', '2026-01-32', '2026-1-01', '26-01-01']) {
    assert.equal(validateOp(legalOp({ f: { date: d } })).ok, false, d);
  }
});

test('classifyOp is the ONE triage: admit, park or reject', () => {
  const ctx = makeCtx();
  const op = noteSet(ctx, 'n1', { date: '2026-09-10', text: 'x' });
  const ms = Number(op.ts.slice(0, 13));
  assert.deepEqual(classifyOp(op), { status: 'admit' });
  assert.deepEqual(classifyOp(op, { nowMs: ms }), { status: 'admit' });
  // exactly +24 h is still admitted; one ms beyond is parked (ADR 001 §1.3)
  assert.equal(classifyOp(op, { nowMs: ms - 24 * 3600 * 1000 }).status, 'admit');
  const parked = classifyOp(op, { nowMs: ms - 24 * 3600 * 1000 - 1 });
  assert.equal(parked.status, 'park');
  assert.equal(parked.parkReason, PARK_REASONS.FUTURE);
  // an op we cannot open yet is parked too, and the shape check runs first
  assert.equal(classifyOp(op, { haveEpochKey: false }).parkReason, PARK_REASONS.EPOCH);
  assert.equal(classifyOp(legalOp({ f: { text: 1 } }), { haveEpochKey: false }).status, 'reject');
  // AN OP IS NEVER DISCARDED FOR BEING OLD (ADR 001 §1.3, §12.5) — no lower bound anywhere.
  assert.deepEqual(classifyOp(legalOp({ ts: stampAt(0, 0, '0'.repeat(16)) }), { nowMs: ms }), { status: 'admit' });
});

test('every park reason is declared, and only declared reasons are parkable', () => {
  assert.deepEqual(Object.values(PARK_REASONS).sort(),
    ['attestation', 'epoch', 'future', 'unknownField', 'unknownKind', 'unknownSpace', 'unshareShape', 'version']);
  for (const r of Object.values(PARK_REASONS)) assert.ok(isParkReason(r), r);
  assert.equal(isParkReason('typeViolation'), false);
  assert.equal(isParkReason(undefined), false);
});

// ═════════════════════════════════════════════════════════════════════════════
// E. THE COVERAGE TEST — every v1 store.mutate() site has an op kind
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Read out of the v1 tree by hand and cross-checked against
 *     grep -rn 'store.mutate(' src/js/
 * on the "v1 baseline" commit. 22 sites, which is what ADR 001 §3.2 claims and what the recon
 * found. THIS LIST IS LITERAL ON PURPOSE. Deriving it from `MUTATIONS` would make the test check
 * the table against itself and prove exactly nothing.
 */
const V1_MUTATE_SITES_IN_SOURCE = [
  ['interact.js:72', 'delete'],
  ['interact.js:307', 'create-bar'],
  ['interact.js:324', 'move-note'],
  ['interact.js:341', 'move-bar'],
  ['interact.js:352', 'resize-bar'],
  ['interact.js:543', 'create-note'],
  ['interact.js:565', 'edit-note'],
  ['interact.js:592', 'edit-bar'],
  ['interact.js:618', 'pad'],
  ['interact.js:631', 'pad'],
  ['popover.js:159', 'create-note'],
  ['popover.js:183', 'recategorise'],
  ['popover.js:202', 'toggle-repeat'],
  ['popover.js:217', 'delete-note'],
  ['popover.js:236', 'recategorise-bar'],
  ['popover.js:266', 'edit-note'],
  ['legend.js:35', 'toggle-category'],
  ['legend.js:76', 'add-category'],
  ['legend.js:114', 'rename-category'],
  ['legend.js:129', 'recolor-category'],
  ['legend.js:152', 'delete-category'],
  ['legend.js:197', 'delete-category'],
];

test('EVERY v1 store.mutate() site has an op constructor — all 22, none missing, none invented', () => {
  // A v1 mutation with no op kind is a silent data-loss bug in the retrofit: the gesture keeps
  // working, the board looks right, and the change never reaches the log or any other device.
  assert.equal(V1_MUTATE_SITES_IN_SOURCE.length, 22, 'the v1 recon found 22 mutate sites');
  const expected = V1_MUTATE_SITES_IN_SOURCE.map(([s]) => s).sort();
  assert.deepEqual([...V1_MUTATE_SITES].sort(), expected);
  // and the table still contains exactly 22 RETROFIT rows. `MUTATIONS` also carries the family
  // vocabulary (E6-1), which has no v1 site to name, so this is the count of rows that DO name
  // one — the claim „all 22, none missing, none invented" said with the number as well as with
  // the list, because a v1 row that lost its `sites` entry would slip past the list unnoticed.
  const retrofit = Object.keys(MUTATIONS).filter((n) => MUTATIONS[n].sites.length > 0);
  assert.equal(retrofit.length, 22, 'exactly 22 rows are v1 retrofits');
  // and each site's v1 label survives verbatim, so undo-stack labels do not change
  const labelBySite = new Map();
  for (const m of Object.values(MUTATIONS)) for (const s of m.sites) labelBySite.set(s, m.label);
  for (const [site, label] of V1_MUTATE_SITES_IN_SOURCE) {
    assert.equal(labelBySite.get(site), label, `${site} must keep the v1 label ${label}`);
  }
});

test('every mutation entry is complete and every op it can build is valid', () => {
  const ctx = makeCtx();
  const args = {
    deleteSelected: { type: 'note', id: 'n1' },
    createBar: { id: 'b1', startDate: '2026-09-01', endDate: '2026-09-08', categoryId: CAT[0], unhideCategoryId: CAT[0] },
    moveNote: { id: 'n1', date: '2026-09-11' },
    moveBar: { id: 'b1', startDate: '2026-09-02', endDate: '2026-09-09' },
    resizeBar: { id: 'b1', startDate: '2026-09-02', endDate: '2026-09-09' },
    createNoteInline: { id: 'n1', date: '2026-09-10', text: 'Zahnarzt', categoryId: CAT[0], unhideCategoryId: CAT[0], lastCategoryId: CAT[0] },
    editNoteInline: { id: 'n1', text: 'Zahnarzt 9h', categoryId: CAT[1], lastCategoryId: CAT[1] },
    editBarLabel: { id: 'b1', label: 'Urlaub', categoryId: CAT[1], lastCategoryId: CAT[1] },
    padTyping: { month: '2026-09', text: 'Einkaufen', born: true },
    padBlur: { month: '2026-09', text: 'Einkaufen' },
    createNotePopover: { id: 'n2', date: '2026-09-10', text: 'Oma', categoryId: CAT[0] },
    recategoriseNote: { id: 'n1', categoryId: CAT[2] },
    toggleRepeat: { id: 'n1', repeatsYearly: true, date: '2026-09-10' },
    deleteNotePopover: { id: 'n1' },
    recategoriseBar: { id: 'b1', categoryId: CAT[2] },
    editNotePopover: { id: 'n1', text: 'Oma 80.' },
    toggleCategory: { id: CAT[0], visible: false },
    addCategory: { id: CAT[3], name: 'Neue Kategorie', nameEn: 'New category', paletteRef: 'blau' },
    renameCategory: { id: CAT[0], lang: 'de', name: 'Arbeit' },
    recolorCategory: { id: CAT[0], paletteRef: 'gruen' },
    // 16.4 — the one setter `defaultVisibility` never had. The register existed and
    // `addCategory` accepted it; nothing could change it afterwards.
    setCategoryDefault: { id: CAT[0], defaultVisibility: 'geteilt' },
    deleteCategory: { id: CAT[0], lastCategoryId: CAT[1] },
    deleteCategoryReassign: { id: CAT[0], targetId: CAT[1], noteIds: ['n1', 'n2'], barIds: ['b1'], lastCategoryId: CAT[1] },
    // rows 23-28 — the family vocabulary (E6-1, plus 20.2's removal). `makeCtx()` carries
    // `familySpaceId`, so these build here exactly as they build in `store.apply()`.
    setMyProfile: { displayName: 'Papa', colorRef: 'blau' },
    attestMyDevice: { deviceShort: DEV_SHORT, blob: 'aGVhZGVy.c2ln' },
    renameSpace: { name: 'Familie Weber' },
    claimAdmin: {},
    transferAdmin: { admin: MAMA, adminPrev: 'p'.repeat(22) },
    removeMember: { memberId: MAMA },
  };
  assert.deepEqual(Object.keys(args).sort(), Object.keys(MUTATIONS).sort());
  for (const [name, a] of Object.entries(args)) {
    const ops = buildMutation(name, ctx, a);
    assert.ok(ops.length > 0, `${name} built no ops`);
    for (const op of ops) assert.deepEqual(validateOp(op), { ok: true }, `${name} → ${op.k}`);
    // the declared kinds must be a superset of what it actually built
    for (const op of ops) assert.ok(mutation(name).kinds.includes(op.k), `${name} builds an undeclared ${op.k}`);
  }
});

test('ADR 001 §3.2 rows 1-8 — interact.js, field by field', () => {
  const ctx = makeCtx();
  const f = (ops, k) => ops.find((o) => o.k === k).f;

  const del = buildMutation('deleteSelected', ctx, { type: 'note', id: 'n1' });
  assert.deepEqual(del.map((o) => [o.k, o.e, o.f]), [['note.set', 'note:n1', { _alive: false }]]);
  const delBar = buildMutation('deleteSelected', ctx, { type: 'bar', id: 'b1' });
  assert.deepEqual(delBar.map((o) => [o.k, o.e, o.f]), [['bar.set', 'bar:b1', { _alive: false }]]);
  assert.throws(() => buildMutation('deleteSelected', ctx, { type: 'pad', id: 'x' }), OpError);

  const cb = buildMutation('createBar', ctx, { id: 'b1', startDate: '2026-09-01', endDate: '2026-09-08', categoryId: CAT[0], unhideCategoryId: CAT[0] });
  assert.deepEqual(Object.keys(f(cb, 'bar.set')).sort(),
    ['_alive', '_born', 'categoryId', 'coEdit', 'endDate', 'label', 'startDate', 'visibility']);
  assert.equal(f(cb, 'bar.set').label, '', 'v1 creates a bar with an empty label');
  assert.equal(f(cb, 'bar.set').coEdit, false);
  assert.equal(f(cb, 'bar.set').visibility, 'privat', '16.1 — private by default');
  assert.deepEqual(f(cb, 'cat.set'), { visible: true }, 'story 4.6 ensureVisible, same gid');
  assert.equal(buildMutation('createBar', ctx, { id: 'b2', startDate: '2026-09-01', endDate: '2026-09-08', categoryId: CAT[0] }).length, 1);

  assert.deepEqual(buildMutation('moveNote', ctx, { id: 'n1', date: '2026-09-11' })[0].f, { date: '2026-09-11' });
  assert.deepEqual(buildMutation('moveBar', ctx, { id: 'b1', startDate: '2026-09-02', endDate: '2026-09-09' })[0].f,
    { startDate: '2026-09-02', endDate: '2026-09-09' });
  assert.deepEqual(buildMutation('resizeBar', ctx, { id: 'b1', startDate: '2026-09-02' })[0].f, { startDate: '2026-09-02' });
  assert.deepEqual(buildMutation('resizeBar', ctx, { id: 'b1', endDate: '2026-09-09' })[0].f, { endDate: '2026-09-09' });
  assert.throws(() => buildMutation('resizeBar', ctx, { id: 'b1' }), OpError);

  const cn = buildMutation('createNoteInline', ctx, { id: 'n1', date: '2026-09-10', text: 'Zahnarzt', categoryId: CAT[0], lastCategoryId: CAT[0] });
  assert.deepEqual(Object.keys(f(cn, 'note.set')).sort(),
    ['_alive', '_born', 'categoryId', 'coEdit', 'date', 'repeatsYearly', 'text', 'visibility']);
  assert.equal(f(cn, 'note.set').repeatsYearly, false);
  assert.deepEqual(f(cn, 'pref.set'), { lastCategoryId: CAT[0] });

  // 2.2 — clearing the text is how you delete without a dialog.
  assert.deepEqual(buildMutation('editNoteInline', ctx, { id: 'n1', text: '' }).map((o) => o.f), [{ _alive: false }]);
  assert.deepEqual(buildMutation('editNoteInline', ctx, { id: 'n1', text: 'x' }).map((o) => o.f), [{ text: 'x' }]);
  assert.deepEqual(buildMutation('editNoteInline', ctx, { id: 'n1', text: 'x', categoryId: CAT[1], lastCategoryId: CAT[1] }).map((o) => o.f),
    [{ text: 'x', categoryId: CAT[1] }, { lastCategoryId: CAT[1] }]);

  // a bar label may legally be empty — v1 has no empty-means-delete branch for bars
  assert.deepEqual(buildMutation('editBarLabel', ctx, { id: 'b1', label: '' }).map((o) => o.f), [{ label: '' }]);
});

test('ADR 001 §3.2 rows 9-10 — the scratchpad, whose 600 ms debounce is the op boundary', () => {
  const ctx = makeCtx();
  for (const site of ['padTyping', 'padBlur']) {
    // v1 stores the UNTRIMMED value when trim() is non-empty (interact.js:621)
    assert.deepEqual(buildMutation(site, ctx, { month: '2026-09', text: '  Einkaufen  ' }).map((o) => [o.e, o.f]),
      [['pad:2026-09', { text: '  Einkaufen  ', _alive: true }]], site);
    // whitespace-only is a delete, exactly as `delete s.scratchpads[key]`
    assert.deepEqual(buildMutation(site, ctx, { month: '2026-09', text: '   ' }).map((o) => o.f),
      [{ _alive: false }], site);
    assert.deepEqual(buildMutation(site, ctx, { month: '2026-09', text: '' }).map((o) => o.f), [{ _alive: false }], site);
  }
  const born = buildMutation('padTyping', ctx, { month: '2026-09', text: 'x', born: true })[0];
  assert.equal(born.f._born, born.ts, 'a create writes _born = its own stamp');
  assert.throws(() => buildMutation('padTyping', ctx, { month: '2026-9', text: 'x' }), EntityKeyError);
});

test('ADR 001 §3.2 rows 11-16 — popover.js', () => {
  const ctx = makeCtx();
  const cn = buildMutation('createNotePopover', ctx, { id: 'n2', date: '2026-09-10', text: 'Oma', categoryId: CAT[0] });
  // v1's popover.js:159 only READS lastCategoryId; ADR 001 §3.2 marks the row [L] and the source
  // does not support it. Default: no pref op.
  assert.deepEqual(cn.map((o) => o.k), ['note.set']);
  assert.equal(cn[0].f.repeatsYearly, false);

  assert.deepEqual(buildMutation('recategoriseNote', ctx, { id: 'n1', categoryId: CAT[2] }).map((o) => [o.k, o.f]),
    [['note.set', { categoryId: CAT[2] }], ['pref.set', { lastCategoryId: CAT[2] }]]);
  assert.deepEqual(buildMutation('recategoriseBar', ctx, { id: 'b1', categoryId: CAT[2] }).map((o) => [o.k, o.f]),
    [['bar.set', { categoryId: CAT[2] }], ['pref.set', { lastCategoryId: CAT[2] }]]);

  // ONE OP, TWO FIELDS, ONE STAMP
  const tr = buildMutation('toggleRepeat', ctx, { id: 'n1', repeatsYearly: true, date: '2026-09-10' });
  assert.equal(tr.length, 1);
  assert.deepEqual(tr[0].f, { repeatsYearly: true, date: '2026-09-10' });
  // 9.5 — switching a series ON must anchor it to the occurrence the user was looking at
  assert.throws(() => buildMutation('toggleRepeat', ctx, { id: 'n1', repeatsYearly: true }), OpError);
  assert.deepEqual(buildMutation('toggleRepeat', ctx, { id: 'n1', repeatsYearly: false })[0].f, { repeatsYearly: false });

  assert.deepEqual(buildMutation('deleteNotePopover', ctx, { id: 'n1' }).map((o) => o.f), [{ _alive: false }]);
  // popover's edit row has no category picker, so no categoryId and no pref op
  assert.deepEqual(buildMutation('editNotePopover', ctx, { id: 'n1', text: 'Oma 80.' }).map((o) => [o.k, o.f]),
    [['note.set', { text: 'Oma 80.' }]]);
  assert.deepEqual(buildMutation('editNotePopover', ctx, { id: 'n1', text: '' }).map((o) => o.f), [{ _alive: false }]);
});

test('ADR 001 §3.2 rows 17-22 — legend.js, including the DE-rename explicit null', () => {
  const ctx = makeCtx();
  // 4.3 — absolute, not a toggle: two devices toggling concurrently converge instead of cancelling
  assert.deepEqual(buildMutation('toggleCategory', ctx, { id: CAT[0], visible: false })[0].f, { visible: false });
  assert.throws(() => buildMutation('toggleCategory', ctx, { id: CAT[0] }), OpError);

  const add = buildMutation('addCategory', ctx, { id: CAT[3], name: 'Neue Kategorie', nameEn: 'New category', paletteRef: 'blau' })[0];
  assert.deepEqual(Object.keys(add.f).sort(), ['_alive', '_born', 'defaultVisibility', 'name', 'nameEn', 'paletteRef', 'visible']);
  assert.equal(add.f.defaultVisibility, 'privat', '16.4 defaults to Privat');
  assert.equal(add.f.visible, true);
  assert.equal(add.f._born, add.ts);

  // legend.js:116 does `delete x.nameEn`. In a register log there is no delete: emit null.
  assert.deepEqual(buildMutation('renameCategory', ctx, { id: CAT[0], lang: 'de', name: 'Arbeit' })[0].f,
    { name: 'Arbeit', nameEn: null });
  assert.deepEqual(buildMutation('renameCategory', ctx, { id: CAT[0], lang: 'en', name: 'Work' })[0].f,
    { nameEn: 'Work' });
  assert.throws(() => buildMutation('renameCategory', ctx, { id: CAT[0], lang: 'fr', name: 'x' }), OpError);

  assert.deepEqual(buildMutation('recolorCategory', ctx, { id: CAT[0], paletteRef: 'gruen' })[0].f, { paletteRef: 'gruen' });
  assert.deepEqual(buildMutation('deleteCategory', ctx, { id: CAT[0] }).map((o) => o.f), [{ _alive: false }]);
  assert.deepEqual(buildMutation('deleteCategory', ctx, { id: CAT[0], lastCategoryId: CAT[1] }).map((o) => [o.k, o.f]),
    [['cat.set', { _alive: false }], ['pref.set', { lastCategoryId: CAT[1] }]]);
});

test('the fan-out at legend.js:197 is N+M+1 independent absolute writes under ONE gid', () => {
  // recon B1/B6: one ⌘Z. A single "reassign everything pointing at X" op would be
  // non-commutative — its effect would depend on which entities the folding device had already
  // seen — and would break ADR 001 §6.
  const ctx = makeCtx();
  const ops = buildMutation('deleteCategoryReassign', ctx, {
    id: CAT[0], targetId: CAT[1], noteIds: ['n1', 'n2', 'n3'], barIds: ['b1', 'b2'], lastCategoryId: CAT[1],
  });
  assert.equal(ops.length, 3 + 2 + 1 + 1);
  assert.deepEqual(ops.map((o) => o.k),
    ['note.set', 'note.set', 'note.set', 'bar.set', 'bar.set', 'cat.set', 'pref.set']);
  for (const o of ops.slice(0, 5)) assert.deepEqual(o.f, { categoryId: CAT[1] }, 'absolute target, by id');
  assert.deepEqual(ops[5].f, { _alive: false });
  const gids = new Set(ops.filter((o) => o.k !== 'pref.set').map((o) => o.gid));
  assert.deepEqual([...gids], [GID], 'one user action, one gid (rule U1)');
  assert.equal(ops[6].gid, null, 'the [L] pref write is outside the transaction (rule U6, recon B5)');
  assert.throws(() => buildMutation('deleteCategoryReassign', ctx, { id: CAT[0], targetId: CAT[0] }), OpError);
});

test('NOT ONE RELATIVE OP EXISTS — every emitted value is absolute', () => {
  // ADR 001 §3.2/§6: a delta applied twice moves twice, and duplicate delivery is not an error
  // condition here. Scanning every field name every constructor can emit is the cheap way to
  // notice a `delta`, `by`, `offset` or `shift` field arriving in a later work package.
  const ctx = makeCtx();
  const emitted = new Set();
  const args = {
    deleteSelected: { type: 'bar', id: 'b1' },
    createBar: { id: 'b1', startDate: '2026-09-01', endDate: '2026-09-08', categoryId: CAT[0] },
    moveNote: { id: 'n1', date: '2026-09-11' },
    moveBar: { id: 'b1', startDate: '2026-09-02', endDate: '2026-09-09' },
    resizeBar: { id: 'b1', startDate: '2026-09-02', endDate: '2026-09-09' },
    createNoteInline: { id: 'n1', date: '2026-09-10', text: 'x', categoryId: CAT[0], lastCategoryId: CAT[0] },
    editNoteInline: { id: 'n1', text: 'x', categoryId: CAT[1], lastCategoryId: CAT[1] },
    editBarLabel: { id: 'b1', label: 'x', categoryId: CAT[1], lastCategoryId: CAT[1] },
    padTyping: { month: '2026-09', text: 'x' },
    padBlur: { month: '2026-09', text: 'x' },
    createNotePopover: { id: 'n2', date: '2026-09-10', text: 'x', categoryId: CAT[0] },
    recategoriseNote: { id: 'n1', categoryId: CAT[2] },
    toggleRepeat: { id: 'n1', repeatsYearly: true, date: '2026-09-10' },
    deleteNotePopover: { id: 'n1' },
    recategoriseBar: { id: 'b1', categoryId: CAT[2] },
    editNotePopover: { id: 'n1', text: 'x' },
    toggleCategory: { id: CAT[0], visible: false },
    addCategory: { id: CAT[3], name: 'a', nameEn: 'b', paletteRef: 'blau' },
    renameCategory: { id: CAT[0], lang: 'de', name: 'a' },
    recolorCategory: { id: CAT[0], paletteRef: 'gruen' },
    deleteCategory: { id: CAT[0], lastCategoryId: CAT[1] },
    deleteCategoryReassign: { id: CAT[0], targetId: CAT[1], noteIds: ['n1'], barIds: ['b1'], lastCategoryId: CAT[1] },
  };
  for (const [name, a] of Object.entries(args)) {
    for (const op of buildMutation(name, ctx, a)) for (const k of Object.keys(op.f)) emitted.add(k);
  }
  assert.ok(emitted.size > 10, `only ${emitted.size} distinct fields emitted — the sweep stopped working`);
  for (const f of emitted) {
    assert.ok(!/(delta|offset|shift|^by$|increment|adjust)/i.test(f), `${f} looks like a relative op`);
  }
});

test('one op = one stamp, stamps are unique within a group, and _born is the op own stamp', () => {
  const ctx = makeCtx();
  const ops = buildMutation('deleteCategoryReassign', ctx, {
    id: CAT[0], targetId: CAT[1], noteIds: ['n1', 'n2'], barIds: ['b1'], lastCategoryId: CAT[1],
  });
  const stamps = ops.map((o) => o.ts);
  assert.equal(new Set(stamps).size, stamps.length, 'each op gets its own stamp');
  assert.deepEqual([...stamps].sort(), stamps, 'and they are minted in emission order');
  assert.equal(new Set(ops.map((o) => o.id)).size, ops.length, 'and its own opId');
  const born = buildMutation('addCategory', ctx, { id: CAT[3], name: 'a', nameEn: 'b', paletteRef: 'blau' })[0];
  assert.equal(born.f._born, born.ts);
});

test('makeOp validates and freezes; an op that fails its own contract never reaches the log', () => {
  const ctx = makeCtx();
  const op = noteSet(ctx, 'n1', { text: 'x' });
  assert.ok(Object.isFrozen(op) && Object.isFrozen(op.f));
  assert.throws(() => { op.f.text = 'y'; }, TypeError);
  assert.throws(() => makeOp(ctx, 'note.set', 'note:n1', { text: 'x'.repeat(81) }), OpError);
  assert.throws(() => makeOp(ctx, 'nope.set', 'note:n1', { text: 'x' }), OpError);
  assert.throws(() => makeOp({ ...ctx, act: 'me' }, 'note.set', 'note:n1', { text: 'x' }), OpError);
  assert.throws(() => makeOp({ ...ctx, mint: undefined }, 'note.set', 'note:n1', { text: 'x' }), OpError);
  // solo mode has no family space, so a family op cannot be built by accident
  assert.throws(() => pubSet({ ...ctx, familySpaceId: null }, 'fnote', MAMA, 'n1', { 'pub.level': 'belegt' }), OpError);
});

test('settings and layers become pref.set ops in the LOCAL space, and never anything else', () => {
  // ADR 001 §3.3: all 14 setSettings and 7 setLayer sites keep v1 semantics exactly — persisted,
  // not undoable, NEVER SYNCED. 19.4's "my entire board syncs" means board = CONTENT.
  const ctx = makeCtx();
  const s = settingsSet(ctx, { mode: 'pinned', startMonth: '2026-01', pageYears: 0 });
  assert.equal(s.k, 'pref.set');
  assert.equal(s.space, LOCAL_SPACE);
  assert.equal(s.gid, null);
  assert.deepEqual(s.f, { mode: 'pinned', startMonth: '2026-01', pageYears: 0 });
  const l = layerSet(ctx, { schulferien: true, otherStates: false });
  assert.deepEqual(l.f, { 'layers.schulferien': true, 'layers.otherStates': false });
  assert.equal(l.space, LOCAL_SPACE);
  // nested v1 settings flatten to dotted register names, because `f` is scalars-only
  assert.deepEqual(flattenPref({ settings: { layers: { feiertage: true } }, rowHeight: 22 }),
    { 'settings.layers.feiertage': true, rowHeight: 22 });
  // an array would smuggle a non-scalar into `f`; carry set membership as `<name>.<id>: true`
  assert.throws(() => flattenPref({ hiddenMembers: [MAMA] }), OpError);
});

// ═════════════════════════════════════════════════════════════════════════════
// F. Date primitives — the copies in core/ must equal the v1 originals
// ═════════════════════════════════════════════════════════════════════════════

test('the date primitives in core/entities.js agree with src/js/dates.js, exhaustively', () => {
  // core/ may not import a v1 module (ADR 005 §2), so these are copies. This is the pin.
  let checked = 0;
  for (let y = 1998; y <= 2042; y++) {
    assert.equal(isLeap(y), v1dates.isLeap(y), `isLeap(${y})`);
    for (let m = 1; m <= 12; m++) {
      assert.equal(daysInMonth(y, m), v1dates.daysInMonth(y, m), `daysInMonth(${y},${m})`);
      const len = daysInMonth(y, m);
      for (let d = 1; d <= len; d++) {
        const s = iso(y, m, d);
        assert.equal(s, v1dates.iso(y, m, d));
        assert.deepEqual(parseISO(s), v1dates.parseISO(s));
        checked++;
      }
    }
  }
  assert.ok(checked > 16000, `only ${checked} dates checked`);
  assert.equal(p2(3), v1dates.p2(3));
});

test('EARLIEST_DATE and LATEST_DATE really are the two ends of DATE_RE (R5-11)', () => {
  // `migrate1to2.js:coerceToV1BarEdge` carries a bar edge that names no day across as the end of
  // the alphabet it SORTED against, because `layout.js:133` compares a bar edge and never parses
  // it. The whole argument rests on these two strings being the extremes of the accepted set: if
  // some accepted date sorted below EARLIEST_DATE, an edge mapped there would still be painted in
  // that month, and R5-11 would be half closed. This is that pin.
  assert.equal(isDateString(EARLIEST_DATE), true, 'the floor is itself a legal date');
  assert.equal(isDateString(LATEST_DATE), true, 'and so is the ceiling');

  // The proof is lexicographic and it is complete, in two parts, because every accepted string is
  // exactly ten characters of the fixed shape `dddd-dd-dd` — so string order IS field order.
  //   1. the YEAR field, exhaustively: every four-digit prefix sits between '0000' and '9999'.
  for (let y = 0; y <= 9999; y++) {
    const yyyy = String(y).padStart(4, '0');
    assert.ok(yyyy >= '0000' && yyyy <= '9999', `year ${yyyy} escapes the field`);
  }
  //   2. the MONTH and DAY fields, exhaustively, at both year extremes — the only years where the
  //      year field cannot decide the comparison on its own.
  let checked = 0;
  for (const yyyy of ['0000', '9999']) {
    for (let m = 0; m <= 99; m++) {
      for (let d = 0; d <= 99; d++) {
        const s = `${yyyy}-${p2(m)}-${p2(d)}`;
        if (!DATE_RE.test(s)) continue;              // not an accepted date; it may sort anywhere
        assert.ok(s >= EARLIEST_DATE, `${s} sorts below the floor`);
        assert.ok(s <= LATEST_DATE, `${s} sorts above the ceiling`);
        checked++;
      }
    }
  }
  assert.equal(checked, 2 * 12 * 31, 'both extreme years, every month, every day the regex allows');

  // …and the falsifier: the strings one step outside on each side are REFUSED, which is what
  // makes these the ends of the ACCEPTED set rather than merely two dates in it.
  for (const outside of ['0000-00-01', '0000-01-00', '9999-13-01', '9999-12-32', '999-12-31']) {
    assert.equal(isDateString(outside), false, `${outside} must not be an accepted date`);
  }
  // The two shapes the class is about, on either side, so the constants are not vacuous:
  assert.ok('' < EARLIEST_DATE && ' ' < EARLIEST_DATE && '0' < EARLIEST_DATE);
  assert.ok('zzz' > LATEST_DATE && 'irgendwann' > LATEST_DATE && 'unbekannt' > LATEST_DATE);
});

test('projectYearly agrees with v1 across every leap boundary (story 9.4)', () => {
  const anchors = ['2024-02-29', '2024-02-28', '2024-03-01', '2023-12-31', '2020-01-01', '2025-02-29'];
  for (const a of anchors) {
    for (let y = 2020; y <= 2036; y++) {
      assert.equal(projectYearly(a, y), v1dates.projectYearly(a, y), `projectYearly(${a},${y})`);
    }
  }
  assert.equal(projectYearly('2024-02-29', 2025), '2025-02-28', 'Feb 29 shows on Feb 28 in non-leap years');
  assert.equal(projectYearly('2024-02-29', 2028), '2028-02-29');
});

test('addDays and diffDays agree with v1 across month and year rolls', () => {
  const seeds = ['2026-01-01', '2026-02-28', '2024-02-28', '2026-12-31', '2026-06-15'];
  for (const s of seeds) {
    for (let n = -400; n <= 400; n += 7) {
      assert.equal(addDays(s, n), v1dates.addDays(s, n), `addDays(${s},${n})`);
      assert.equal(diffDays(s, addDays(s, n)), n, `diffDays round trip ${s}+${n}`);
      assert.equal(diffDays(s, addDays(s, n)), v1dates.diffDays(s, v1dates.addDays(s, n)));
    }
  }
});

test('reanchorRepeat is interact.js:330-334, verbatim (story 9.3, one object per series)', () => {
  // "keep the series' first year, move the month/day the whole series lands on"
  assert.equal(reanchorRepeat('2020-06-01', '2026-09-10'), '2020-09-10');
  assert.equal(reanchorRepeat('2020-06-01', '2020-06-01'), '2020-06-01');
  assert.equal(reanchorRepeat('1999-12-31', '2026-01-01'), '1999-01-01');
  // the v1 quirk, pinned: a non-existent day can result, and projectYearly copes with it
  assert.equal(reanchorRepeat('2025-06-01', '2024-02-29'), '2025-02-29');
});

// ═════════════════════════════════════════════════════════════════════════════
// G. THE ONE SHARED DAY-SELECTOR (ADR 005 §3)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `popover.js:47-61`, lifted verbatim. The popover module itself is DOM-coupled (it reaches for
 * `document` at import time) and therefore cannot be imported in tier 1 — that is exactly the
 * boundary ADR 005 §4.1 draws, and it is why this duplicate exists in the tree at all. The point
 * of extracting the selector is to delete this code from `popover.js`; the point of copying it
 * here is to prove the extraction changed nothing first.
 */
function v1NotesOn(state, date) {
  const categoryVisible = (id) => {
    const c = state.categories.find((x) => x.id === id);
    return c ? c.visible !== false : true;
  };
  const y = Number(date.slice(0, 4));
  return state.notes.filter((n) => {
    if (!categoryVisible(n.categoryId)) return false;
    if (!n.repeatsYearly) return n.date === date;
    if (Number(n.date.slice(0, 4)) > y) return false;
    return v1dates.projectYearly(n.date, y) === date;
  });
}

function v1BarsOn(state, date) {
  const categoryVisible = (id) => {
    const c = state.categories.find((x) => x.id === id);
    return c ? c.visible !== false : true;
  };
  return state.bars.filter(
    (b) => categoryVisible(b.categoryId) && b.startDate <= date && b.endDate >= date,
  );
}

/** A board with repeats, hidden categories, a dangling reference and a Feb-29 series. */
function selectorBoard() {
  const cats = [
    { id: CAT[0], name: 'Arbeit', paletteRef: 'blau', visible: true },
    { id: CAT[1], name: 'Familie', paletteRef: 'gruen', visible: false },   // hidden
    { id: CAT[2], name: 'Reisen', paletteRef: 'orange' },                   // visible: undefined
  ];
  return boardState({
    categories: cats,
    notes: [
      note('n1', '2026-03-14', 'Zahnarzt'),
      note('n2', '2026-03-14', 'Elternabend', { categoryId: CAT[1] }),       // hidden category
      note('n3', '2020-03-14', 'Oma Geburtstag', { repeatsYearly: true }),
      note('n4', '2030-03-14', 'Spaeter', { repeatsYearly: true }),          // 9.5 — not yet
      note('n5', '2024-02-29', 'Schalttag', { repeatsYearly: true }),
      note('n6', '2026-03-14', 'Dangling', { categoryId: 'cat-gone' }),      // unknown category
      note('n7', '2026-03-15', 'Nachbar'),
      note('n8', '2026-03-14', 'Reise', { categoryId: CAT[2] }),             // visible undefined
    ],
    bars: [
      bar('b1', '2026-03-10', '2026-03-20', 'Projekt'),
      bar('b2', '2026-03-14', '2026-03-14', 'Eintagsbalken'),
      bar('b3', '2026-03-01', '2026-03-13', 'Davor'),
      bar('b4', '2026-03-15', '2026-03-30', 'Danach'),
      bar('b5', '2026-03-10', '2026-03-20', 'Versteckt', { categoryId: CAT[1] }),
      bar('b6', '2026-03-10', '2026-03-20', 'Dangling', { categoryId: 'cat-gone' }),
    ],
    settings: { startMonth: '2026-01' },
  });
}

test('notesOnDate reproduces popover.js:47-55 exactly, over every day of a year', () => {
  const state = selectorBoard();
  let days = 0;
  for (let m = 1; m <= 12; m++) {
    for (let d = 1; d <= daysInMonth(2026, m); d++) {
      const date = iso(2026, m, d);
      assert.deepEqual(
        notesOnDate(state, date).map((o) => o.note.id),
        v1NotesOn(state, date).map((n) => n.id),
        `notesOnDate ${date}`,
      );
      days++;
    }
  }
  assert.equal(days, 365);
  // and the interesting day itself, spelled out
  assert.deepEqual(notesOnDate(state, '2026-03-14').map((o) => o.note.id), ['n1', 'n3', 'n6', 'n8']);
});

test('barsOnDate reproduces popover.js:57-61 exactly, over every day of a year', () => {
  const state = selectorBoard();
  for (let m = 1; m <= 12; m++) {
    for (let d = 1; d <= daysInMonth(2026, m); d++) {
      const date = iso(2026, m, d);
      assert.deepEqual(barsOnDate(state, date).map((b) => b.id), v1BarsOn(state, date).map((b) => b.id), date);
    }
  }
  assert.deepEqual(barsOnDate(state, '2026-03-14').map((b) => b.id), ['b1', 'b2', 'b6']);
  assert.deepEqual(barsOnDate(state, '2026-03-13').map((b) => b.id), ['b1', 'b3', 'b6']);
  assert.deepEqual(barsInRange(state, '2026-03-14', '2026-03-14').map((b) => b.id), ['b1', 'b2', 'b6']);
});

test('the selector agrees with the REAL layout.js, day row by day row', () => {
  // The other half of ADR 005 §3: the popover and the board must not disagree about what is on a
  // day. This one runs against buildBoard() itself, not against a copy of it.
  const state = selectorBoard();
  const model = buildBoard(state, { today: '2026-03-14' });
  let compared = 0;
  for (const col of model.cols) {
    for (const day of col.days) {
      if (day.empty) continue;
      assert.deepEqual(
        notesOnDate(state, day.date).map((o) => o.note.id),
        day.allNotes.map((o) => o.note.id),
        `layout day ${day.date}`,
      );
      compared++;
    }
  }
  assert.equal(compared, 365, 'twelve columns of 2026');
  // and the range form is the same map layout builds internally
  const occ = noteOccurrencesInRange(state, model.firstISO, model.lastISO);
  assert.deepEqual(occ.get('2026-03-14').map((o) => o.note.id), ['n1', 'n3', 'n6', 'n8']);
});

test('story 9.5 — a series exists from its FIRST year onward, never before', () => {
  const state = selectorBoard();
  assert.deepEqual(notesOnDate(state, '2019-03-14').map((o) => o.note.id), [], 'before the anchor year');
  assert.deepEqual(notesOnDate(state, '2020-03-14').map((o) => o.note.id), ['n3']);
  assert.deepEqual(notesOnDate(state, '2029-03-14').map((o) => o.note.id), ['n3']);
  assert.deepEqual(notesOnDate(state, '2030-03-14').map((o) => o.note.id), ['n3', 'n4'], 'n4 joins in 2030');
  // and a non-repeating note appears on exactly one day
  assert.deepEqual(notesOnDate(state, '2027-03-14').map((o) => o.note.id), ['n3']);
});

test('a Feb-29 series crosses a leap boundary the way story 9.4 says', () => {
  const state = selectorBoard();
  assert.deepEqual(notesOnDate(state, '2024-02-29').map((o) => o.note.id), ['n5']);
  assert.deepEqual(notesOnDate(state, '2025-02-28').map((o) => o.note.id), ['n5'], 'demoted to Feb 28');
  assert.deepEqual(notesOnDate(state, '2028-02-29').map((o) => o.note.id), ['n5'], 'back on Feb 29');
  assert.deepEqual(notesOnDate(state, '2025-03-01').map((o) => o.note.id), []);
  // exactly one occurrence per year — never two
  for (let y = 2024; y <= 2032; y++) {
    const hits = [];
    for (let d = 26; d <= 29; d++) {
      if (d > daysInMonth(y, 2)) continue;
      hits.push(...notesOnDate(state, iso(y, 2, d)).map((o) => o.note.id));
    }
    assert.deepEqual(hits.filter((x) => x === 'n5'), ['n5'], `year ${y}`);
  }
});

test('hidden-category filtering is the v1 tri-state, and an unknown category is VISIBLE', () => {
  const state = selectorBoard();
  const vis = categoryVisibilityOf(state);
  assert.equal(vis(CAT[0]), true, 'visible: true');
  assert.equal(vis(CAT[1]), false, 'visible: false');
  assert.equal(vis(CAT[2]), true, 'visible: undefined is visible');
  assert.equal(vis('cat-gone'), true, 'a dangling reference is visible — store.js:264-267');
  assert.deepEqual(visibleNotes(state).map((n) => n.id), ['n1', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8']);
  assert.deepEqual(visibleBars(state).map((b) => b.id), ['b1', 'b2', 'b3', 'b4', 'b6']);
  // an injected override wins, so layout can pass its own map
  assert.deepEqual(visibleNotes(state, { categoryVisible: () => false }), []);
});

test('occurrence order inside a day is state.notes order — which is what makes "+n" deterministic', () => {
  const rnd = mulberry32(0xB0A2D);
  const base = selectorBoard();
  const ids = notesOnDate(base, '2026-03-14').map((o) => o.note.id);
  assert.deepEqual(ids, ['n1', 'n3', 'n6', 'n8']);
  for (let i = 0; i < 20; i++) {
    const shuffled = { ...base, notes: shuffle(rnd, base.notes) };
    const got = notesOnDate(shuffled, '2026-03-14').map((o) => o.note.id);
    assert.deepEqual(got, shuffled.notes.filter((n) => ids.includes(n.id)).map((n) => n.id),
      'the selector never reorders; array order is the caller\'s to fix (ADR 001 §5 step 5)');
  }
});

test('a foreign entry is gated by the MEMBER toggle, never by a category it does not have', () => {
  // A3 means a foreign entry has no categoryId at all. Routing it through the category check
  // would ask categoryVisible(undefined), which answers "visible" by the dangling-reference rule
  // — correct by accident is not good enough for a privacy control (17.3).
  const state = boardState({
    categories: [{ id: CAT[0], name: 'Arbeit', paletteRef: 'blau', visible: false }],
    notes: [
      note('mine', '2026-03-14', 'Zahnarzt'),
      { id: 'hers', date: '2026-03-14', text: 'Chor', isForeign: true, ownerId: MAMA, level: 'geteilt' },
    ],
    bars: [{ id: 'herbar', startDate: '2026-03-10', endDate: '2026-03-20', isForeign: true, ownerId: MAMA, level: 'belegt' }],
  });
  // my own note is hidden by its hidden category; hers is not, because she has none
  assert.deepEqual(notesOnDate(state, '2026-03-14').map((o) => o.note.id), ['hers']);
  assert.deepEqual(barsOnDate(state, '2026-03-14').map((b) => b.id), ['herbar']);
  // 17.3 — hide the member and both of hers go
  const hidden = { hiddenMembers: new Set([MAMA]) };
  assert.deepEqual(notesOnDate(state, '2026-03-14', hidden), []);
  assert.deepEqual(barsOnDate(state, '2026-03-14', hidden), []);
  // an explicit memberVisible wins over hiddenMembers
  assert.deepEqual(notesOnDate(state, '2026-03-14', { memberVisible: () => true }).map((o) => o.note.id), ['hers']);
});

test('solo mode is structurally untouched: with no family ctx the member branch is inert', () => {
  // WP-5's exit criterion, asserted at the selector rather than at the pixels.
  const state = selectorBoard();
  for (let m = 1; m <= 12; m++) {
    for (let d = 1; d <= daysInMonth(2026, m); d++) {
      const date = iso(2026, m, d);
      assert.deepEqual(
        notesOnDate(state, date, {}).map((o) => o.note.id),
        notesOnDate(state, date, { memberVisible: () => true }).map((o) => o.note.id),
        date,
      );
    }
  }
  assert.deepEqual(notesOnDate(state, '2026-03-14', { hiddenMembers: new Set([MAMA]) }).map((o) => o.note.id),
    ['n1', 'n3', 'n6', 'n8'], 'hiding a member changes nothing about my own entries');
});

test('the empty board and the empty day are not special cases', () => {
  const empty = boardState();
  assert.deepEqual(notesOnDate(empty, '2026-03-14'), []);
  assert.deepEqual(barsOnDate(empty, '2026-03-14'), []);
  assert.deepEqual(noteOccurrences([], '2026-01-01', '2026-12-31').size, 0);
  assert.deepEqual([...noteOccurrencesInRange(empty, '2026-01-01', '2026-12-31').keys()], []);
  assert.deepEqual(visibleNotes({}), []);
  assert.deepEqual(visibleBars({}), []);
});

// ═════════════════════════════════════════════════════════════════════════════
// H. Renderability and the sort comparators (ADR 001 §5 steps 3 and 5)
// ═════════════════════════════════════════════════════════════════════════════

test('renderable(note) — an own note needs text; a foreign one needs Belegt or a pub.text', () => {
  assert.equal(renderableNote({ date: '2026-03-14', text: 'Zahnarzt' }), true);
  assert.equal(renderableNote({ date: '2026-03-14' }), false, 'own note without text');
  assert.equal(renderableNote({ date: '2026-03-14', text: '' }), true, 'empty string is a VALUE');
  // A Geteilt note whose pub.text op has not arrived yet is INVISIBLE, not "Belegt". Meaning is
  // never inferred from a missing field — that is the bug class ADR 004 exists to prevent.
  assert.equal(renderableNote({ date: '2026-03-14', isForeign: true, level: 'geteilt' }), false);
  assert.equal(renderableNote({ date: '2026-03-14', isForeign: true, level: 'geteilt', text: 'Chor' }), true);
  assert.equal(renderableNote({ date: '2026-03-14', isForeign: true, level: 'belegt' }), true);
  // a WITHDRAWN text (explicit null, ADR 004 §5.1) is absent, not empty
  assert.equal(renderableNote({ date: '2026-03-14', isForeign: true, level: 'geteilt', text: null }), false);
  assert.equal(renderableNote(null), false);
  assert.equal(renderable('note', { date: '2026-03-14', text: 'x' }), true);
});

// INVERTED — A3-H2. These four rows asserted that a note with no usable DATE is not on the board,
// which is where the retrofit lost five boards v1 keeps: `board.json` is the checkpoint in solo
// mode, so the projection's refusal was rewritten into the user's file on the first autosave.
// v1's `state.notes` is the ARRAY; the date decides which day row draws it, not whether it exists.
test('renderable(note) — an OWN note with no date is still on the board (v1 kept it too)', () => {
  assert.equal(renderableNote({ text: 'Zahnarzt' }), true, 'no date, but v1 keeps it in state.notes');
  assert.equal(renderableNote({ date: null, text: 'x' }), true, 'a cleared date is the same case');
  // …and it is a GRID question: no day row can hold it, which is exactly what v1 did with it.
  assert.deepEqual(notesOnDate({ notes: [{ id: 'n', text: 'x' }], categories: [] }, '2026-03-14'), []);
  // The one own-note exception: `layout.js:72` expands a repeat with `n.date.slice(0, 4)` and
  // THROWS on a note with no date, taking the whole board with it. There is no v1 rendering of
  // that shape to preserve, so it stays out of the array — and both doors refuse to mint it.
  assert.equal(renderableNote({ text: 'x', repeatsYearly: true }), false, 'a repeat with no anchor');
  assert.equal(renderableNote({ text: 'x', repeatsYearly: true, date: '2026-03-14' }), true);
  // A FOREIGN entry is untouched: absence still means absence on the redaction path.
  assert.equal(renderableNote({ text: 'Chor', isForeign: true, level: 'geteilt' }), false, 'no date');
});

test('renderable(bar) — a FOREIGN bar needs both ends; an OWN bar is v1\'s array (A3-H2)', () => {
  assert.equal(renderableBar({ startDate: '2026-03-10', endDate: '2026-03-20' }), true);
  assert.equal(renderableBar({ startDate: '2026-03-10', endDate: '2026-03-20', label: null }), true, 'a label is not required');
  assert.equal(renderableBar(undefined), false);
  assert.throws(() => renderable('cat', {}), EntityKeyError);

  // INVERTED — a one-ended own bar used to leave the board, and (solo mode, `board.json` is the
  // checkpoint) leave the file with it. v1 draws it to the far edge of the visible window
  // (`layout.js:133-135`), so it belongs in the array; both doors additionally anchor a missing
  // edge to the one the file carries, so this shape reaches the projection only from a fragment
  // or from a co-editor's withdrawal.
  assert.equal(renderableBar({ startDate: '2026-03-10' }), true);
  assert.equal(renderableBar({ endDate: '2026-03-20' }), true);
  assert.equal(renderableBar({ startDate: '2026-03-10', endDate: null }), true);
  assert.equal(renderableBar({ label: 'x' }), true, 'v1 paints even this — as a stripe down every column');
  // …and the foreign path is untouched: absence stays absence on the redaction path.
  assert.equal(renderableBar({ startDate: '2026-03-10', isForeign: true, level: 'geteilt' }), false);
  assert.equal(renderableBar({ startDate: '2026-03-10', endDate: '2026-03-20', isForeign: true, level: 'geteilt' }), true);
});

test('projectable applies ADR 001 §5 step 3 in full, in its stated order', () => {
  const own = { date: '2026-03-14', text: 'Zahnarzt' };
  const foreign = { date: '2026-03-14', text: 'Chor', isForeign: true, ownerId: MAMA, level: 'geteilt' };
  const members = new Set([MAMA]);
  assert.equal(projectable('note', own), true);
  assert.equal(projectable('note', { ...own, alive: false }), false, 'tombstone');
  assert.equal(projectable('note', foreign, { currentMembers: members }), true);
  assert.equal(projectable('note', { ...foreign, alive: false }, { currentMembers: members }), false);
  assert.equal(projectable('note', { ...foreign, level: 'privat' }, { currentMembers: members }), false);
  assert.equal(projectable('note', { ...foreign, level: undefined }, { currentMembers: members }), false, 'absent level is not shared');
  // 20.2 — a removed member's entries vanish instantly, with no crypto and no purge op
  assert.equal(projectable('note', foreign, { currentMembers: new Set() }), false);
  // 17.3 — the device-local per-member toggle
  assert.equal(projectable('note', foreign, { currentMembers: members, hiddenMembers: new Set([MAMA]) }), false);
  // my own entries are never gated by membership or by the member toggle
  assert.equal(projectable('note', own, { currentMembers: new Set(), hiddenMembers: new Set([MAMA]) }), true);
  assert.equal(projectable('bar', { startDate: '2026-03-10', endDate: '2026-03-20' }), true);
});

test('cmpBars is (_born asc, id asc) — v1 file order, NOT the date comparator (ATT-50/ATT-52)', () => {
  // WAS `(startDate asc, endDate desc, id asc)` — `layout.js:43`'s comparator. That was a real
  // defect: ADR 001 §8.3's acceptance criterion says a migrated board deep-equals the v1 board
  // "for every field INCLUDING array order", and `_born` (which carries the v1 array index,
  // §8.1) is the only thing that can deliver it. Notes and categories did; bars threw it away.
  //
  // Nothing about LANE assignment depended on the old comparator, and this test proves it:
  // `assignLanes` sorts its input by the date comparator ITSELF (`layout.js:38-44`), so it is
  // order-independent whatever order the array arrives in. What array order still decides is
  // `seg.labelRow`, and there the user's own file order is the answer that moves nothing.
  //
  // The `_born` stamps below run OPPOSITE to the date order on purpose, so this test reads
  // ['b2','b1','b4','b3','b5'] under the old rule and fails.
  const rnd = mulberry32(0x1A7E5);
  const born = (i) => stampAt(1000 + i, 0);
  const bars = [
    { ...bar('b1', '2026-03-01', '2026-03-10', 'a'), _born: born(0) },
    { ...bar('b2', '2026-03-01', '2026-03-20', 'b'), _born: born(1) },  // same start, longer
    { ...bar('b3', '2026-03-05', '2026-03-06', 'c'), _born: born(2) },
    { ...bar('b4', '2026-03-01', '2026-03-10', 'd'), _born: born(3) },  // identical range to b1
    { ...bar('b5', '2026-04-01', '2026-04-02', 'e'), _born: born(4) },
  ];
  assert.deepEqual(sortBars(bars).map((b) => b.id), ['b1', 'b2', 'b3', 'b4', 'b5'], 'file order');
  const reference = assignLanes(bars);
  for (let i = 0; i < 30; i++) {
    const shuffled = shuffle(rnd, bars);
    assert.deepEqual([...assignLanes(shuffled).entries()].sort(), [...reference.entries()].sort(),
      'assignLanes is order-independent because it sorts by the date comparator itself');
    assert.deepEqual(sortBars(shuffled).map((b) => b.id), ['b1', 'b2', 'b3', 'b4', 'b5'], 'and so is sortBars');
  }
  // Two bars born in the same instant fall through to `id`, and a bar with no `_born` at all —
  // a fragment of an entity whose create op has not arrived — sorts LAST, exactly like a note.
  const tie = [
    { ...bar('zz', '2026-01-01', '2026-01-02', 'z'), _born: born(9) },
    { ...bar('aa', '2026-12-01', '2026-12-02', 'a'), _born: born(9) },
    bar('mm', '2026-01-01', '2026-01-02', 'm'),
  ];
  assert.deepEqual(sortBars(tie).map((b) => b.id), ['aa', 'zz', 'mm']);
  assert.equal(cmpBars(bars[0], bars[0]), 0, 'a proper comparator returns 0 for identity');
  assert.equal(cmpBars(tie[2], tie[2]), 0, 'including for two fragments that are the same object');
});

test('notes and categories sort by (_born asc, id asc), with a fragment sorting last', () => {
  const s = (ms) => stampAt(ms, 0);
  const items = [
    { id: 'z', _born: s(1000) },
    { id: 'a', _born: s(2000) },
    { id: 'm', _born: s(1000) },
    { id: 'q' },                      // no _born yet — a fragment of an entity mid-delivery
    { id: 'b' },
  ];
  assert.deepEqual(sortNotes(items).map((x) => x.id), ['m', 'z', 'a', 'b', 'q']);
  assert.deepEqual(sortCategories(items).map((x) => x.id), ['m', 'z', 'a', 'b', 'q']);
  assert.equal(cmpNotes(items[0], items[0]), 0);
  assert.equal(cmpCategories({ id: 'a', _born: s(1) }, { id: 'a', _born: s(1) }), 0);
  // deterministic under any input order — array order is user-visible (stories 2.4, 2.5, 3.8)
  const rnd = mulberry32(0xC0FFEE);
  for (let i = 0; i < 30; i++) {
    assert.deepEqual(sortNotes(shuffle(rnd, items)).map((x) => x.id), ['m', 'z', 'a', 'b', 'q']);
  }
});

test('scratchpad keys are sorted, so board.json stays byte-stable (11.4)', () => {
  const pads = { '2026-12': 'z', '2026-01': 'a', '2025-06': 'm', '2026-02': 'b' };
  assert.deepEqual(Object.keys(sortScratchpads(pads)), ['2025-06', '2026-01', '2026-02', '2026-12']);
  assert.deepEqual(sortScratchpads(pads), pads, 'same content, only the key order differs');
  assert.equal(JSON.stringify(sortScratchpads(pads)),
    JSON.stringify(sortScratchpads({ '2026-02': 'b', '2025-06': 'm', '2026-12': 'z', '2026-01': 'a' })));
  assert.deepEqual(sortScratchpads(undefined), {});
  assert.deepEqual(sortScratchpads({}), {});
});
