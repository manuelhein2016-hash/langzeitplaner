// tests/tier1/coedit-write.test.js — 18.2's WRITE, and the three seams the E9 integration added.
// LZP-902 (the flag) → the co-editor's actual commit · ADR 004 §2.2 barrier 4, §4.1, §8 ·
// ADR 001 §4.3 stage 3b, §4.4 (structural ownership) · PO decision D7.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE IS FOR
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// LZP-902 shipped „Familie darf bearbeiten" as a GRANT with no way to exercise it. The flag was
// written, folded, rendered and enforced; and every path a co-editor's write could take ended in
// `store.familyLevelOf` answering `null` for a foreign key, which barrier 4 turns into a
// `RedactionError`, which sets `store.redactionHalt` and stops ALL family sync from that Mac.
// `interact.js` therefore refused the gesture outright (`authorable`), so 18.2 rendered a
// checkbox that granted nothing. Three seams close it, and this file is their oracle:
//
//   §1  `store.familyCoEditLevelOf`  — barrier 4's level for SOMEBODY ELSE'S entity, read from
//       the AUTHENTICATED fold (`pub.level`/`pub.coEdit`/`pub.alive`) and from nothing else.
//   §2  `core/project.js:coEditOp`   — the branded-op door, `adminUnshareOp`'s sibling.
//   §3  `store.applyCoEdit`          — the commit, through the REAL store and the REAL fold.
//   §4  `applyRemote`'s follow-up    — 18.3's owner-side half, which had no caller.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE METHOD: THE ORACLE IS WRITTEN FROM THE PROSE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// §1's `granted()` is computed from ADR 001 §4.3's stage-3b predicate as the ADR states it —
// „`pub.coEdit` is true AND `pub.level` is geteilt" — plus liveness, and it consults nothing under
// test. A domain read off the implementation proves the implementation equals itself, and barrier
// 4 has already shipped one hole (finding S5) that every test of the day agreed with.
//
// ⚠ THE ONE PROPERTY THAT OUTRANKS ALL THE OTHERS, and §1 is where it is asserted: NOTHING THE
// CALLER SUPPLIES REACHES THE ANSWER. `familyCoEditLevelOf` takes an entity key and reads three
// folded registers. There is no argument through which a level could be declared, which is the
// whole difference between this and the S5 defect it is modelled to avoid.
//
// NO TEST HERE MINTS A STAMP FROM THE WALL CLOCK.

import '../helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { resetStorage, seedBoard } from '../helpers/env.js';
import { short16, attestationBlob, attestVerify } from '../helpers/gen.js';

import {
  coEditOp, projectCoEditPatch, adminUnshareOp, adminUnshareFollowUp,
  retractPatch, projectForFamily, COEDIT_FIELDS, RedactionError,
} from '../../src/js/core/project.js';
import { makeOp, PERSONAL_PLACEHOLDER, FIELDS } from '../../src/js/core/ops.js';
import { classifyUnsharePatch, parseAttestationBlob } from '../../src/js/core/authz.js';
import { FAMILY_PATCH_BRAND } from '../../src/js/crypto/envelope.js';
import { familyKey, noteKey, barKey, memberKey, spaceKey } from '../../src/js/core/entities.js';
import { fmt, msOf } from '../../src/js/core/stamp.js';
import { store } from '../../src/js/store.js';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 0. THE CIRCLE — PAPA the admin and owner of the vacation bar, MAMA (me) the co-editor
// ═════════════════════════════════════════════════════════════════════════════════════════════

const pad22 = (s) => (s + 'x'.repeat(22)).slice(0, 22);
const PAPA = `mem_${pad22('WPAPA')}`;
const MAMA = `mem_${pad22('WMAMA')}`;          // this store's identity
const FSP = `fsp_${pad22('WFAMILIE')}`;
const PSP = `psp_${pad22('WPERSONAL')}`;
const BASE_MS = 1787836800000;

const DEVS = {
  [PAPA]: { id: `dev_${pad22('DWPAPA')}`, short: short16('DWPAPA') },
  [MAMA]: { id: `dev_${pad22('DWMAMA')}`, short: short16('DWMAMA') },
};

let opN = 0;
function op(who, kind, e, f, ms, opts = {}) {
  return makeOp({
    act: who,
    dev: DEVS[who].id,
    gid: opts.gid ?? pad22(`gw${ms}`),
    space: opts.space ?? FSP,
    familySpaceId: FSP,
    mint: () => fmt(ms, opts.ctr ?? 0, DEVS[who].short),
    newOpId: () => pad22(`ow${++opN}`),
  }, kind, e, f, opts);
}

/** The authz preamble: two attested members and the genesis admin link. */
function kreis() {
  const ops = [];
  let ms = BASE_MS;
  for (const m of [PAPA, MAMA]) {
    ops.push(op(m, 'member.set', memberKey(m),
      { [`dev.${DEVS[m].short}`]: attestationBlob(m, DEVS[m]) }, (ms += 1000)));
    ops.push(op(m, 'member.set', memberKey(m),
      { displayName: m.slice(4, 9), colorRef: 'p1', _alive: true }, (ms += 1000)));
  }
  ops.push(op(PAPA, 'space.set', spaceKey(FSP), { admin: PAPA, adminPrev: null, name: 'Familie' },
    (ms += 1000)));
  return { ops, at: ms };
}

/** Papa's truth for the shared vacation bar, materialized-shaped. */
const papaBarTruth = (level, coEdit) => ({
  visibility: level,
  startDate: '2026-10-05',
  endDate: '2026-10-19',
  label: 'Herbstferien Nordsee',
  coEdit,
  categoryId: 'cat-familie',
  _alive: true,
  _born: fmt(BASE_MS, 0, DEVS[PAPA].short),
});

/** Papa publishes his bar at `level`, optionally opting it into co-editing (18.2). */
function papaShares(uuid, { level = 'geteilt', coEdit = true, at }) {
  const truth = papaBarTruth(level, coEdit);
  const patch = projectForFamily('fbar', truth, level, null);
  return op(PAPA, 'pub.set', familyKey('fbar', PAPA, uuid), { ...patch }, at,
    { gid: pad22(`gp${at}`), ctr: 1 });
}

/**
 * The REAL store, armed as MAMA, in a Familienkreis.
 *
 * ⚠ ONE STORE PER PROCESS — `src/js/store.js` exports a singleton and `useIdentity` /
 * `usePersonalSpace` may only be called before `init()`. So this arms it ONCE and each row uses
 * its own entry uuid rather than its own store.
 */
let storeArmed = false;
function mamaStore() {
  resetStorage();
  seedBoard({
    schemaVersion: 1, notes: [], bars: [],
    categories: [{ id: 'c1', name: 'Familie', colorRef: 'blau', visible: true }],
    scratchpads: {}, settings: null,
  });
  store.listeners.clear();
  store.warnings.length = 0;
  store.redactionHalt = null;
  if (!storeArmed) {
    store.useIdentity({
      memberId: MAMA, deviceId: DEVS[MAMA].id, deviceShort: DEVS[MAMA].short,
      peerDeviceIds: [],
      // The REAL stage-0a port: parse, then verify under the housing member's own key. The
      // `() => null` a copy-paste would leave here fails every device closed, and stage 0b then
      // rejects every family op as `unattestedDevice` — which is correct behaviour and a useless
      // fixture.
      attestOpen: (memberId, blob) => (attestVerify(memberId, blob) ? parseAttestationBlob(blob) : null),
    });
    store.usePersonalSpace(PSP);
    storeArmed = true;
  }
  store.init();
  if (store.familySpaceId() === null) store.useFamilySpace(FSP);
}

/**
 * The newest millisecond anywhere in the store's log, plus a minute.
 *
 * ⚠ A CONSTANT WOULD MAKE THESE ROWS GREEN FOR THE WRONG REASON, and it did once while this file
 * was being written: the store stamps its OWN ops from its real HLC, so a peer op minted at a
 * fixed `BASE_MS` is older than every local write and silently LOSES the per-field LWW contest.
 * `pub.level` then stayed `geteilt`, the follow-up correctly emitted nothing, and the row failed
 * for a reason that had nothing to do with the code under test. Peer ops are stamped RELATIVE to
 * the log they are extending — the same rule `tests/tier1/unshare.test.js` states in its header.
 */
function aboveTheLog() {
  let top = BASE_MS;
  for (const cells of store.registers().values()) {
    for (const cell of cells.values()) {
      if (cell && typeof cell.stamp === 'string') top = Math.max(top, msOf(cell.stamp));
    }
  }
  return top + 60000;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. `familyCoEditLevelOf` — BARRIER 4's LEVEL FOR SOMEBODY ELSE'S ENTITY
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * THE ORACLE, from ADR 001 §4.3 stage 3b and ADR 004 §2.1 — not from the code.
 *
 * Stage 3b admits a co-editor's `pub.set` when the entity's FOLDED governing registers say
 * `pub.coEdit === true` and `pub.level === 'geteilt'`. ADR 004 §2.1: co-edit exists at no other
 * level. A withdrawn or deleted entity (`pub.alive === false`) has nothing to edit. And the
 * entity must be SOMEBODY ELSE'S — my own publish through `derivePublication` from the truth
 * register, one entity one producer (ADR 004 §5.1).
 */
const granted = (row) => (
  row.mine !== true
  && row.alive !== false
  && row.coEdit === true
  && row.level === 'geteilt'
);

test('§1 · the fold reader answers `geteilt` on exactly the invited entities, and `null` elsewhere', () => {
  mamaStore();
  const pre = kreis();
  store.applyRemote(pre.ops);

  // The whole cross product of what the three governing registers can hold, plus ownership.
  const LEVELS = ['geteilt', 'belegt', 'privat', undefined];
  const COEDIT = [true, false, undefined];
  const ALIVE = [true, false, undefined];
  const rows = [];
  let at = pre.at;
  let n = 0;
  for (const mine of [false, true]) {
    for (const level of LEVELS) {
      for (const coEdit of COEDIT) {
        for (const alive of ALIVE) {
          rows.push({ mine, level, coEdit, alive, uuid: `w${String(++n).padStart(8, '0')}-1111-4111-8111-cccccccccccc` });
        }
      }
    }
  }

  // Each row's registers are written by their OWNER — which is what makes this a test of the
  // fold and not of a hand-built map. `pub.level` is a governing field, so `authz.js` stage 3a
  // folds it from the entity's structural owner alone; an op Mama authored onto Papa's key would
  // simply be rejected and the row would read `undefined`, which is a different test.
  const ops = [];
  for (const r of rows) {
    const owner = r.mine ? MAMA : PAPA;
    const f = {};
    if (r.level !== undefined) f['pub.level'] = r.level;
    if (r.coEdit !== undefined) f['pub.coEdit'] = r.coEdit;
    if (r.alive !== undefined) f['pub.alive'] = r.alive;
    if (!Object.keys(f).length) continue;
    ops.push(op(owner, 'pub.set', familyKey('fbar', owner, r.uuid), f, (at += 10), { born: true }));
  }
  const res = store.applyRemote(ops);
  assert.equal(res.refused.length, 0,
    `precondition: every governing write is the owner's own and must be admitted — ${
      JSON.stringify(res.refused.slice(0, 3))}`);

  const wrong = [];
  for (const r of rows) {
    const key = familyKey('fbar', r.mine ? MAMA : PAPA, r.uuid);
    const got = store.familyCoEditLevelOf(key);
    const want = granted(r) ? 'geteilt' : null;
    if (got !== want) wrong.push({ ...r, got, want });
  }
  assert.deepEqual(wrong, [], `${wrong.length} of ${rows.length} cells disagree with stage 3b`);

  // NON-VACUITY, both ways: the domain really does contain grants and refusals.
  const yes = rows.filter(granted).length;
  // not-mine × geteilt × coEdit:true × alive ∈ {true, absent} — absence is alive (ADR 001 §5
  // step 3 drops only `_alive === false`), which is why it is two cells and not one.
  assert.equal(yes, 2, 'exactly the live × geteilt × coEdit × not-mine cells are grants');
  assert.ok(rows.length - yes > 60, 'and the refusing majority is not a rounding error');
});

test('§1b · my OWN key is never answered for — one entity, one producer (ADR 004 §5.1)', () => {
  // This is not a tidiness rule. `familyLevelOf` reads the `visibility` TRUTH register precisely
  // because `pub.level` is „the level a transition is moving AWAY from" (finding S5). If this
  // function answered for my own keys it would become a SECOND producer reading exactly that
  // register, and a downgrade would re-publish at the level it was leaving.
  mamaStore();
  const pre = kreis();
  store.applyRemote(pre.ops);
  const uuid = 'aaaaaaaa-9999-4999-8999-aaaaaaaaaaaa';
  const mineKey = familyKey('fbar', MAMA, uuid);
  store.applyRemote([op(MAMA, 'pub.set', mineKey,
    { 'pub.level': 'geteilt', 'pub.coEdit': true, 'pub.alive': true, 'pub.label': 'meins' },
    pre.at + 10, { born: true })]);

  assert.equal(store.familyCoEditLevelOf(mineKey), null,
    'my own co-editable entry must NOT be answerable through the co-editor\'s reader');
  // …and the row is genuinely there, so the `null` is a refusal rather than an empty map.
  assert.equal(store.registers().get(mineKey).get('pub.coEdit').value, true);
});

test('§1c · nothing the caller supplies can reach the answer', () => {
  // The S5 shape, asserted as an ABSENCE: the function's whole input is an entity key. There is
  // no level parameter, no options bag, and no second argument that is read.
  assert.equal(store.familyCoEditLevelOf.length, 1, 'it takes exactly one argument');
  for (const junk of [null, undefined, 42, {}, [], 'note:x', 'fbar:', 'nonsense', '']) {
    assert.equal(store.familyCoEditLevelOf(junk), null, `a malformed key must be null, not a guess: ${junk}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. `coEditOp` — THE DOOR
// ═════════════════════════════════════════════════════════════════════════════════════════════

const CTX = (me) => ({
  act: me,
  dev: DEVS[me].id,
  gid: pad22('gdoor'),
  space: PSP,
  familySpaceId: FSP,
  mint: () => fmt(BASE_MS + 90000, 0, DEVS[me].short),
  newOpId: () => pad22(`od${++opN}`),
});

test('§2a · it emits ONE branded `pub.set` on the owner-segmented key, carrying only the edit', () => {
  const uuid = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  const o = coEditOp(CTX(MAMA), { kind: 'fbar', owner: PAPA, uuid }, 'geteilt',
    { 'pub.startDate': '2026-10-07', 'pub.endDate': '2026-10-21' });

  assert.equal(o.k, 'pub.set');
  assert.equal(o.e, familyKey('fbar', PAPA, uuid), 'the key names PAPA — ownership is structural');
  assert.equal(o.act, MAMA, 'and the AUTHOR is me, which is what stage 3b judges');
  assert.equal(o.space, FSP, 'a co-edit is a family-space op');
  assert.deepEqual(o.f, { 'pub.startDate': '2026-10-07', 'pub.endDate': '2026-10-21' });
  assert.ok(o.f[FAMILY_PATCH_BRAND], 'unbranded, barrier 3 would refuse it before barrier 4 ran');
  // NOT a full re-publication: the fields the co-editor did not touch are absent, so the owner's
  // newer values are not overwritten at my stamp (the §5.1 failure, one register over).
  assert.equal('pub.label' in o.f, false);
  assert.equal('pub.level' in o.f, false);
});

test('§2b · every governing field is refused, by name', () => {
  const uuid = 'cccccccc-3333-4333-8333-cccccccccccc';
  const governing = Object.keys(FIELDS.fbar).filter((f) => FIELDS.fbar[f].coEdit !== true);
  assert.ok(governing.length >= 4, 'precondition: there are governing fields to refuse');
  for (const f of governing) {
    assert.throws(
      () => coEditOp(CTX(MAMA), { kind: 'fbar', owner: PAPA, uuid }, 'geteilt', { [f]: 'x' }),
      (e) => e instanceof RedactionError,
      `a co-editor must not be able to write ${f} — stage 3a folds it from the owner alone`);
  }
  // The one that matters most, said out loud: a co-editor cannot grant themselves co-edit.
  assert.throws(() => coEditOp(CTX(MAMA), { kind: 'fbar', owner: PAPA, uuid }, 'geteilt',
    { 'pub.coEdit': true }), RedactionError);
});

test('§2c · it refuses MY OWN entity — the second producer that would undo a downgrade', () => {
  const uuid = 'dddddddd-4444-4444-8444-dddddddddddd';
  assert.throws(
    () => coEditOp(CTX(MAMA), { kind: 'fbar', owner: MAMA, uuid }, 'geteilt', { 'pub.label': 'x' }),
    (e) => e instanceof RedactionError && /one entity, one producer|MINE/.test(e.message));
});

test('§2d · an unknown `spec` key is a refusal, never an ignored argument', () => {
  const uuid = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
  for (const extra of ['f', 'patch', 'truth', 'level', 'coEdit']) {
    assert.throws(
      () => coEditOp(CTX(MAMA), { kind: 'fbar', owner: PAPA, uuid, [extra]: 'x' }, 'geteilt',
        { 'pub.label': 'y' }),
      RedactionError, `\`${extra}\` must not be silently dropped`);
  }
});

test('§2e · below geteilt there is no co-edit at all, at any level', () => {
  const uuid = 'ffffffff-6666-4666-8666-ffffffffffff';
  for (const level of ['privat', 'belegt']) {
    assert.throws(
      () => coEditOp(CTX(MAMA), { kind: 'fbar', owner: PAPA, uuid }, level, { 'pub.label': 'x' }),
      RedactionError, `co-editing at ${level} is incoherent (ADR 004 §2.1)`);
  }
});

test('§2f · an empty edit is `null`, not an op that says nothing', () => {
  const uuid = '11111111-7777-4777-8777-111111111111';
  assert.equal(coEditOp(CTX(MAMA), { kind: 'fbar', owner: PAPA, uuid }, 'geteilt', {}), null);
});

test('§2g · the door is exactly `projectCoEditPatch`\'s field set — derived, never restated', () => {
  // If this file listed the co-editable fields it would be a second table, and the two would
  // drift. `COEDIT_FIELDS` is itself derived from `ops.js:FIELDS`' own `coEdit` marks.
  for (const kind of ['fnote', 'fbar']) {
    for (const f of COEDIT_FIELDS[kind]) {
      const patch = projectCoEditPatch(kind, 'geteilt', { [f]: 'x' });
      assert.ok(patch && f in patch, `${kind}.${f} must pass the projection`);
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. `store.applyCoEdit` — THE COMMIT, through the real store and the real fold
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§3a · a granted co-edit is committed as ONE family op, and lands in the family outbox', () => {
  mamaStore();
  const pre = kreis();
  store.applyRemote(pre.ops);
  const uuid = '22222222-8888-4888-8888-222222222222';
  store.applyRemote([papaShares(uuid, { at: pre.at + 10 })]);
  const key = familyKey('fbar', PAPA, uuid);
  assert.equal(store.familyCoEditLevelOf(key), 'geteilt', 'precondition: 18.2 grants it');

  const before = store.familyOutbox().length;
  const ok = store.applyCoEdit(key, { 'pub.startDate': '2026-10-07', 'pub.endDate': '2026-10-21' });

  assert.equal(ok, true, 'the co-edit was declined');
  const out = store.familyOutbox();
  assert.equal(out.length, before + 1, 'exactly one op reached the family outbox');
  const line = out[out.length - 1];
  assert.equal(line.op.k, 'pub.set');
  assert.equal(line.op.e, key);
  assert.equal(line.op.act, MAMA);
  assert.deepEqual(line.op.f, { 'pub.startDate': '2026-10-07', 'pub.endDate': '2026-10-21' });
  // ⚠ NO TRUTH OP. There is no `bar:<uuid>` register to move — the entry is not mine.
  assert.equal(store.registers().has(barKey(uuid)), false,
    'a co-edit must not mint a TRUTH register for somebody else\'s entity');
  assert.equal(store.redactionHalt, null, 'and nothing halted publication');
});

// ── §3b · A CO-EDIT IS NOT UNDOABLE, AND THAT IS RULE U6 RATHER THAN AN OVERSIGHT ───────────
//
// This row was written expecting `depth + 1` and went red, which is the useful direction: it
// MEASURED a rule instead of restating one. `core/undo.js:captureImages` filters every entity
// kind outside `UNDOABLE_KINDS` (note/bar/cat/pad) out of the images — rule U6, and it is v1's
// `CONTENT_KEYS` snapshot stated in op terms. A family `pub.set` is therefore never on anybody's
// undo stack.
//
// For MY OWN entry that is exactly right and the ADR says why: the publication is DERIVED, so
// „undoing the truth and letting the publisher re-derive is the only path that cannot leave the
// family space describing a state the owner's board no longer holds" (`store.js:_commit`).
//
// FOR A CO-EDIT THERE IS NO TRUTH TO UNDO, so the consequence is different in kind: the
// co-editor cannot take their own co-edit back with ⌘Z. That is a GAP, it is recorded as owed in
// `docs/v2/E9-VERIFICATION.md`, and it is deliberately not closed by widening `UNDOABLE_KINDS` —
// an undo that minted a `pub.set` would re-write the pre-value AT A FRESH STAMP, which would beat
// the owner's concurrent newer write and silently resurrect a value they had already replaced.
// That is the §5.1 failure, arriving through the undo stack. Failing closed costs a keystroke;
// failing open costs somebody else's edit.
//
// What 18.4 actually requires is asserted here and holds: the stack is not touched, in either
// direction, by anybody.
test('§3b · a co-edit touches NO undo stack — rule U6, and 18.4 in the direction that matters', () => {
  mamaStore();
  const pre = kreis();
  store.applyRemote(pre.ops);
  const uuid = '33333333-9999-4999-8999-333333333333';
  store.applyRemote([papaShares(uuid, { at: pre.at + 10 })]);
  const key = familyKey('fbar', PAPA, uuid);

  const depth = store.undoStack.length;
  const redo = store.redoStack.length;
  assert.equal(store.applyCoEdit(key, { 'pub.label': 'Nordsee — verlängert' }), true);
  assert.equal(store.undoStack.length, depth,
    'a family pub.set reached the undo stack — rule U6 says no entity outside note/bar/cat/pad does');
  assert.equal(store.redoStack.length, redo, 'and it did not clear redo either');

  // …and the write really happened, so this is a statement about UNDO and not about a no-op.
  assert.equal(store.registers().get(key).get('pub.label').value, 'Nordsee — verlängert');
});

test('§3c · a co-edit the fold does not grant is DECLINED — never halted, never thrown', () => {
  // The failure mode this whole seam exists to prevent: a `RedactionError` on the publish path
  // sets `redactionHalt`, which stops ALL family sync from this Mac. A withdrawn grant must cost
  // the gesture and nothing else.
  mamaStore();
  const pre = kreis();
  store.applyRemote(pre.ops);
  let at = pre.at;

  // ⚠ NOT `papaShares` for all three. A PRIVAT entry produces ZERO family ops by construction
  // (16.1, ADR 004 §1) — `projectForFamily` returns an empty patch and `makeOp` refuses it — so
  // asking the projection for a Privat publication is asking for the one thing the redaction
  // boundary exists to make impossible. The governing registers are written directly instead,
  // which is the state a DOWNGRADE legitimately leaves behind.
  const cases = [
    ['no co-edit flag', { 'pub.level': 'geteilt', 'pub.coEdit': false, 'pub.alive': true }],
    ['belegt', { 'pub.level': 'belegt', 'pub.coEdit': true, 'pub.alive': true }],
    ['privat', { 'pub.level': 'privat', 'pub.coEdit': true, 'pub.alive': true }],
  ];
  let n = 0;
  for (const [why, gov] of cases) {
    const uuid = `4444444${++n}-aaaa-4aaa-8aaa-444444444444`;
    const key = familyKey('fbar', PAPA, uuid);
    store.applyRemote([op(PAPA, 'pub.set', key, gov, (at += 10), { born: true })]);
    const before = store.familyOutbox().length;
    assert.equal(store.applyCoEdit(key, { 'pub.label': 'x' }), false, `${why}: must decline`);
    assert.equal(store.familyOutbox().length, before, `${why}: and emit no op`);
    assert.equal(store.redactionHalt, null, `${why}: and never halt family sync`);
  }
  // An entity that does not exist at all is the same answer.
  assert.equal(store.applyCoEdit(familyKey('fbar', PAPA, '55555555-bbbb-4bbb-8bbb-555555555555'),
    { 'pub.label': 'x' }), false);
  assert.equal(store.redactionHalt, null);
});

test('§3d · the OWNER withdrawing the grant closes the door immediately', () => {
  // 18.2's grant is revocable, and the revocation is a governing write only the owner can make.
  mamaStore();
  const pre = kreis();
  store.applyRemote(pre.ops);
  const uuid = '66666666-cccc-4ccc-8ccc-666666666666';
  store.applyRemote([papaShares(uuid, { at: pre.at + 10 })]);
  const key = familyKey('fbar', PAPA, uuid);
  assert.equal(store.applyCoEdit(key, { 'pub.label': 'erste' }), true);

  // Papa unticks „Familie darf bearbeiten".
  store.applyRemote([op(PAPA, 'pub.set', key, { 'pub.coEdit': false }, aboveTheLog(), { ctr: 2 })]);
  assert.equal(store.familyCoEditLevelOf(key), null);
  const before = store.familyOutbox().length;
  assert.equal(store.applyCoEdit(key, { 'pub.label': 'zweite' }), false,
    'the grant was withdrawn and the next edit must not author anything');
  assert.equal(store.familyOutbox().length, before);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4. `applyRemote`'s ADMIN-UNSHARE FOLLOW-UP — 18.3's owner-side half, which had no caller
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4a · a moderation of MY entry reconciles my truth register, so my next edit cannot undo it', () => {
  // The defect, measured: `derivePublication` reads the level from `visibility` and
  // `lastPublished` from the folded `pub.level`. After a moderation those disagree, so the
  // owner's very next keystroke re-publishes the whole Geteilt patch and silently undoes it.
  mamaStore();
  const pre = kreis();
  store.applyRemote(pre.ops);

  // Mama shares a note of her own, through the real store, so the truth register is real.
  const uuid = 'e1e1e1e1-1212-4212-8212-e1e1e1e1e1e1';
  assert.equal(store.apply('createNoteInline',
    { id: uuid, date: '2026-12-24', text: 'Bescherung 18:00', categoryId: 'c1' }), true,
  'precondition: the note was created');
  store.txn('share', (tx) => tx.note(uuid).set({ visibility: 'geteilt' }));
  assert.equal(store.registers().get(noteKey(uuid)).get('visibility').value, 'geteilt');
  const fkey = familyKey('fnote', MAMA, uuid);
  assert.equal(store.registers().get(fkey).get('pub.level').value, 'geteilt',
    'precondition: it really is published');

  // PAPA, the admin, unshares it. This is the op the relay carries back to Mama's own Mac.
  const mod = adminUnshareOp({
    act: PAPA, dev: DEVS[PAPA].id, gid: pad22('gmod'), space: FSP, familySpaceId: FSP,
    mint: () => fmt(aboveTheLog(), 0, DEVS[PAPA].short),
    newOpId: () => pad22('omod'),
  }, { kind: 'fnote', owner: MAMA, uuid });
  const res = store.applyRemote([mod]);
  assert.deepEqual(res.refused, [], 'precondition: the admin\'s retraction is admissible');

  // THE FOLLOW-UP: the truth register now agrees with what the family actually holds.
  assert.equal(store.registers().get(noteKey(uuid)).get('visibility').value, 'privat',
    'ADR 004 §5: the owner\'s client sets its local visibility to privat');
  // 18.3 — IT IS NOT DELETED. The entry is still on Mama's board, in full.
  const still = store.state.notes.find((n) => n.id === uuid);
  assert.ok(still, 'the entry was deleted — 18.3 says moderation is non-destructive');
  assert.equal(still.text, 'Bescherung 18:00', 'and its text is untouched');

  // …and now the owner's next edit does NOT re-publish it.
  store.apply('editNoteInline', { id: uuid, text: 'Bescherung 18:30' });
  assert.equal(store.registers().get(fkey).get('pub.level').value, 'privat',
    'the owner\'s next keystroke silently undid the moderation');
});

test('§4b · the follow-up is not on the undo stack — 18.4, and it is not my action', () => {
  // If it were committed rather than appended, Mama's ⌘Z would "undo" Papa's moderation of her
  // own entry — an undo of something she never did.
  mamaStore();
  const pre = kreis();
  store.applyRemote(pre.ops);
  const uuid = 'e2e2e2e2-1313-4313-8313-e2e2e2e2e2e2';
  store.apply('createNoteInline', { id: uuid, date: '2026-11-11', text: 'Elternabend', categoryId: 'c1' });
  store.txn('share', (tx) => tx.note(uuid).set({ visibility: 'geteilt' }));

  const depth = store.undoStack.length;
  const mod = adminUnshareOp({
    act: PAPA, dev: DEVS[PAPA].id, gid: pad22('gmo2'), space: FSP, familySpaceId: FSP,
    mint: () => fmt(aboveTheLog(), 0, DEVS[PAPA].short),
    newOpId: () => pad22('omo2'),
  }, { kind: 'fnote', owner: MAMA, uuid });
  store.applyRemote([mod]);

  assert.equal(store.registers().get(noteKey(uuid)).get('visibility').value, 'privat',
    'precondition: the follow-up ran');
  assert.equal(store.undoStack.length, depth,
    'a peer\'s moderation must not put anything on MY undo stack (18.4)');
});

test('§4c · it notifies nobody — Principle 9, asserted as an absence', () => {
  mamaStore();
  const pre = kreis();
  store.applyRemote(pre.ops);
  const uuid = 'e3e3e3e3-1414-4414-8414-e3e3e3e3e3e3';
  store.apply('createNoteInline', { id: uuid, date: '2026-09-09', text: 'Zahnarzt', categoryId: 'c1' });
  store.txn('share', (tx) => tx.note(uuid).set({ visibility: 'geteilt' }));
  store.warnings.length = 0;

  const mod = adminUnshareOp({
    act: PAPA, dev: DEVS[PAPA].id, gid: pad22('gmo3'), space: FSP, familySpaceId: FSP,
    mint: () => fmt(aboveTheLog(), 0, DEVS[PAPA].short),
    newOpId: () => pad22('omo3'),
  }, { kind: 'fnote', owner: MAMA, uuid });
  store.applyRemote([mod]);

  // No warning, no marker, no „Papa hat deinen Eintrag entfernt". ADR 004 §7 forbids the
  // notification BY NAME and there is no op kind that could carry one.
  const said = store.warnings.join(' ');
  for (const word of ['entfernt', 'Papa', 'Verwalter', 'unshare', 'moderat', 'removed']) {
    assert.equal(said.includes(word), false, `the reconciliation announced itself: "${word}"`);
  }
});

test('§4d · it is idempotent, and a second pull emits nothing new', () => {
  mamaStore();
  const pre = kreis();
  store.applyRemote(pre.ops);
  const uuid = 'e4e4e4e4-1515-4515-8515-e4e4e4e4e4e4';
  store.apply('createNoteInline', { id: uuid, date: '2026-10-10', text: 'Konzert', categoryId: 'c1' });
  store.txn('share', (tx) => tx.note(uuid).set({ visibility: 'geteilt' }));
  const mkMod = (n) => adminUnshareOp({
    act: PAPA, dev: DEVS[PAPA].id, gid: pad22(`gmo${n}`), space: FSP, familySpaceId: FSP,
    mint: () => fmt(aboveTheLog(), 0, DEVS[PAPA].short),
    newOpId: () => pad22(`omo${n}`),
  }, { kind: 'fnote', owner: MAMA, uuid });

  store.applyRemote([mkMod(7)]);
  const after1 = store.registers().get(noteKey(uuid)).get('visibility').op;
  // A second batch that changes nothing about this entity must not re-write the register.
  store.applyRemote([op(PAPA, 'member.set', memberKey(PAPA), { colorRef: 'p2' }, aboveTheLog())]);
  const after2 = store.registers().get(noteKey(uuid)).get('visibility').op;
  assert.equal(after2, after1, 'the reconciliation re-wrote a register it had already reconciled');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5. THE RETRACTION SPLIT — why the co-edit level must NOT be offered to an admin unshare
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§5 · a retraction and a co-edit are distinguishable by SHAPE, on the same key', () => {
  // `sync/family.js:sealLevelFor` splits barrier 4's level source on exactly this predicate, and
  // it must: an admin unshare is also a `pub.set` on a foreign key, and if the co-edit reader
  // answered `geteilt` for it, barrier 4 would refuse the op for declaring `privat` against a
  // map that says `geteilt` — 18.3 would stop working. The split cannot drift, because this is
  // the SAME function `authz.js` stage 3a admits an unshare by.
  const uuid = '77777777-dddd-4ddd-8ddd-777777777777';
  const retraction = retractPatch('fbar');
  assert.equal(classifyUnsharePatch('fbar', retraction), 'unshare');

  const coedit = coEditOp(CTX(MAMA), { kind: 'fbar', owner: PAPA, uuid }, 'geteilt',
    { 'pub.startDate': '2026-10-07' });
  assert.notEqual(classifyUnsharePatch('fbar', coedit.f), 'unshare',
    'a co-editor\'s write must never be read as a withdrawal');

  // And the converse: a co-editor cannot BUILD a retraction through their own door, because
  // `pub.level` and `pub.alive` are governing fields.
  assert.throws(() => coEditOp(CTX(MAMA), { kind: 'fbar', owner: PAPA, uuid }, 'geteilt',
    { ...retraction }), RedactionError);
});
