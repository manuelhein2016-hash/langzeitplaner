// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION ATTACK — SHARED INVARIANTS AND FILE FORMATS AFTER THE FIX PASS
//
// Six agents changed seven modules in parallel, which is exactly when two fixes
// end up holding incompatible beliefs about one shared rule. Three families are
// attacked here:
//
//   A. TWO DOORS, TWO ANSWERS.  `migrate1to2.js` (launch) and `replace.js`
//      (import 11.3 / snapshot restore 11.5) both turn a v1 board into ops. The
//      ATT-82 fix landed on one of them. The SAME BYTES must not produce two
//      different boards depending on which door they came through.
//
//   B. FILE FORMATS.  `registers.js` made `op` mandatory and `oplog.js` grew
//      `splicedIds()` and a `seqs` map. A file written by the previous build has
//      to load, and a file this build writes has to survive a downgrade.
//
//   C. THE GATES THEMSELVES.  `ops()` reversed the meaning of its default, and
//      the property corpus has to be able to reach the paths that were fixed.
//
// Every test asserts CURRENT behaviour and says SUCCEEDED / FAILED in its title.
// A red test here means the behaviour changed — read the body before "fixing" it.
// ─────────────────────────────────────────────────────────────────────────────

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import '../helpers/env.js';
import { defaultState } from '../../src/js/store.js';
import { generateBoard, generateUglyBoard, uglyShapesIn } from '../helpers/gen.js';
import { seeds } from '../property/harness.js';

import { createOpLog, APPEND, OpLogError } from '../../src/js/core/oplog.js';
import {
  fold, foldAll, emptyRegisters, deserializeRegisters, RegisterError,
} from '../../src/js/core/registers.js';
import { migrateV1, MigrationLossyError } from '../../src/js/core/migrate1to2.js';
import { planReplaceAll } from '../../src/js/core/replace.js';
import { materialize, stripV2Fields } from '../../src/js/core/materialize.js';
import { foldAuthorized } from '../../src/js/core/authz.js';
import { makeOp, buildMutation, PERSONAL_PLACEHOLDER } from '../../src/js/core/ops.js';
import { createUndoStacks, captureImages, shadowContent } from '../../src/js/core/undo.js';
import { fmt, createClock } from '../../src/js/core/stamp.js';

// ── minting, all explicit ─────────────────────────────────────────────────────
const pad22 = (s) => (s + 'A'.repeat(22)).slice(0, 22);
const ME = `mem_${pad22('ME')}`;
const DEV = `dev_${pad22('MEDESK')}`;
const FSP = `fsp_${pad22('FAMILIE')}`;
const SHORT = '0123456789ABCDEF';
const BASE = 1787836800000;
const MIG = Object.freeze({ memberId: ME, deviceId: DEV, acceptLossy: true });

const MAT = (regs) => materialize(regs, {
  me: ME, familySpaceId: null, currentMembers: new Set([ME]), defaultSettings: defaultState().settings,
});

/** A fresh explicit-stamp op minter. */
function minting(startCtr = 0) {
  let ctr = startCtr;
  let n = 0;
  return {
    mint: () => fmt(BASE, ++ctr, SHORT),
    newOpId: () => pad22(`o${++n}`),
    op(kind, e, f, { id, gid = pad22('g1'), ms = BASE } = {}) {
      return makeOp({
        act: ME, dev: DEV, gid, familySpaceId: FSP,
        mint: () => fmt(ms, ++ctr, SHORT),
        newOpId: () => id ?? pad22(`o${++n}`),
      }, kind, e, f);
    },
  };
}

const CAT = { id: 'c1', name: 'Arbeit', nameEn: 'Work', paletteRef: 'blau', visible: true };
const board = (patch = {}) => ({
  schemaVersion: 1,
  notes: patch.notes ?? [],
  bars: patch.bars ?? [],
  categories: patch.categories ?? [CAT],
  scratchpads: patch.scratchpads ?? {},
  settings: { startMonth: '2026-01', mode: 'pinned', bundesland: 'BY', lastCategoryId: 'c1', ...(patch.settings || {}) },
});
const B = (id, s, e, label) => ({ id, startDate: s, endDate: e, label, categoryId: 'c1' });
const N = (id, date, text) => ({ id, date, text, categoryId: 'c1', repeatsYearly: false });

/** The `planReplaceAll` ctx a retrofitted store supplies. */
function replaceCtx(gid = pad22('gR')) {
  const m = minting(500);
  // `defaultSettings` and `acceptLossy` are what a retrofitted store passes: the first is REG-8's
  // fix (an omitted pref is reset to its v1 DEFAULT, not cleared — see `replace.js:buildPrefOp`),
  // the second is RECHECK-82-2's (`replaceAllOps` now refuses to lose data in silence). Both
  // doors are therefore configured the same way here, which is the point of the comparison.
  return {
    me: ME, deviceId: DEV, mint: m.mint, newOpId: m.newOpId, gid,
    defaultSettings: defaultState().settings, acceptLossy: true,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// A. TWO DOORS, TWO ANSWERS
// ═════════════════════════════════════════════════════════════════════════════

describe('migrate vs replaceAll — the same bytes through two doors', () => {
  /** Both doors, over the same v1 board, materialized. */
  function bothDoors(incoming, live = board()) {
    const base = migrateV1(structuredClone(live), MIG);
    const baseRegs = fold(base.ops);

    const viaMigrate = migrateV1(structuredClone(incoming), MIG);
    const viaReplace = planReplaceAll(baseRegs, structuredClone(incoming), replaceCtx());
    return {
      migrate: { ...viaMigrate, state: MAT(fold(viaMigrate.ops)) },
      replace: { ...viaReplace, state: MAT(fold(base.ops, viaReplace.ops)) },
    };
  }

  /**
   * The assertion all four of these tests are really making, and the one that cannot be satisfied
   * by a half-fix: the same bytes through both doors produce the SAME BOARD — every field of
   * every entry, in the same array order, plus the settings. `stripV2Fields` removes the
   * derivations that legitimately differ (op ids, `_born` stamps, `updatedBy`), because those are
   * re-derived from the registers and are not what the user has.
   */
  function sameBoard(r, why) {
    const m = stripV2Fields(r.migrate.state);
    const i = stripV2Fields(r.replace.state);
    for (const k of ['notes', 'bars', 'categories', 'scratchpads', 'settings']) {
      assert.deepEqual(i[k], m[k], `${why}: ${k} differs between the two doors`);
    }
    assert.equal(JSON.stringify(i), JSON.stringify(m), `${why}: the boards differ byte for byte`);
  }

  test('REG-20 CLOSED (inverted): both doors TRUNCATE, so the same bytes keep the same note', () => {
    // v1 has ONE door. `store.replaceAll(next)` is `this.state = migrate(next)` (`store.js:194`),
    // so the import path and the launch path are literally the same function, and every
    // divergence between `migrate1to2.js` and `replace.js` was a v2 regression with nothing in v1
    // behind it. That is the reason all four of these tests invert the same way: not "make
    // replace.js do what migration does", but "stop having two doors".
    //
    // `replace.js` now IMPORTS `truncateToFit` rather than reimplementing it, which is what makes
    // the agreement structural instead of coincidental — a second copy would be a second answer
    // to "how long is too long", free to drift on the next edit.
    const long = board({ notes: [N('n1', '2026-03-01', 'A'.repeat(140))] });
    const r = bothDoors(long);

    assert.equal(r.migrate.state.notes.length, 1, 'migration keeps the entry');
    assert.equal(r.migrate.state.notes[0].text.length, 80);
    assert.equal(r.replace.state.notes.length, 1, 'and so does the import — REG-20 CLOSED');
    assert.equal(r.replace.state.notes[0].text.length, 80);
    sameBoard(r, 'a 140-character note');

    assert.ok(r.replace.warnings.some((w) => /TRUNCATED, not dropped/.test(w)),
      r.replace.warnings.join(' | '));
    assert.equal(r.replace.lossy, true, 'still a loss — 60 characters really were cut');

    // Non-vacuity: an 80-character note goes through BOTH doors intact and losslessly.
    const ok = bothDoors(board({ notes: [N('n1', '2026-03-01', 'A'.repeat(80))] }));
    assert.equal(ok.migrate.state.notes.length, 1);
    assert.equal(ok.replace.state.notes.length, 1);
    assert.equal(ok.replace.lossy, false);
    sameBoard(ok, 'an 80-character note');
  });

  test('REG-21 CLOSED (inverted): both doors substitute v1\'s four default categories', () => {
    // v1's `migrate()` substitutes `defaultState().categories` for an empty list (`store.js:74`)
    // and v1 runs `migrate()` on every import, so v1 substitutes here too. The objection
    // `replace.js` used to record — "core/ may not read a CSPRNG (ADR 005 §2), and inventing ids
    // would give each device a different four" — was already answered by the sibling module in
    // the same directory: `defaultCategories()` DERIVES the four ids. It is now imported, not
    // re-derived, so the same file through either door gives the same four categories rather than
    // eight.
    const empty = { ...board({ notes: [N('n1', '2026-03-01', 'a')] }), categories: [] };
    empty.notes[0].categoryId = 'gone';
    empty.settings.lastCategoryId = 'gone';
    const r = bothDoors(empty);

    assert.equal(r.migrate.state.categories.length, 4, 'migration substitutes v1\'s four defaults');
    assert.equal(r.replace.state.categories.length, 4, 'and so does the import — REG-21 CLOSED');
    assert.deepEqual(r.replace.state.categories.map((c) => c.name),
      ['Arbeit', 'Familie', 'Reisen', 'Deadlines']);
    assert.deepEqual(r.replace.state.categories.map((c) => c.id),
      r.migrate.state.categories.map((c) => c.id),
      'the SAME four ids — a board migrated at launch and restored later must not end up with eight');

    // And the two repairs v1 performs on every load, which the import path did not perform at all.
    assert.equal(r.replace.state.notes[0].categoryId, r.replace.state.categories[0].id,
      'the dangling reference is repaired (ADR 001 §5 step 7)');
    assert.equal(r.replace.state.settings.lastCategoryId, r.replace.state.categories[0].id,
      'and so is the id the next „neue Notiz" will use (v1 store.js:86)');
    sameBoard(r, 'a board with no categories');
  });

  test('REG-22 CLOSED (inverted): a duplicate id is RE-KEYED on both doors, to the same id', () => {
    const dup = board({ notes: [N('n1', '2026-03-01', 'first'), N('n1', '2026-04-01', 'second')] });
    const r = bothDoors(dup);
    assert.equal(r.migrate.state.notes.length, 2, 'migration keeps both (re-keyed)');
    assert.equal(r.replace.state.notes.length, 2, 'and so does the import — REG-22 CLOSED');
    assert.deepEqual(r.replace.state.notes.map((n) => n.text), ['first', 'second']);
    assert.ok(r.replace.warnings.some((w) => /RE-KEYED/.test(w)), r.replace.warnings.join(' | '));

    // The half that a per-door reimplementation would have failed: `rekeyed` is DERIVED, and both
    // doors call the SAME one, so the duplicate gets the same replacement id either way. Two ids
    // here would mean the same file restored twice built two different boards.
    assert.deepEqual(r.replace.state.notes.map((n) => n.id), r.migrate.state.notes.map((n) => n.id));
    assert.notEqual(r.replace.state.notes[1].id, 'n1');
    sameBoard(r, 'two notes sharing an id');
  });

  test('REG-23 CLOSED (inverted): an EMPTY-STRING scratchpad is dropped on BOTH doors', () => {
    // The mirror of regression-v1-fidelity REG-13. Both modules documented their choice and the
    // two choices were opposite, so `''` in `board.json` survived a restore and not a relaunch.
    //
    // It resolves TOWARDS migration, i.e. towards ADR 001 §8.2 ("one `pad.set` per NON-EMPTY
    // scratchpad key"), because the reasoning `replace.js` gave for keeping it — "v1's replaceAll
    // installs the payload's scratchpads object verbatim" — is not what v1 does: it installs
    // `migrate(payload)`'s. And nothing the user can see moves: v1 paints a pad as
    // `state.scratchpads[key] || ''` (`layout.js:259`), so `''` and absent are the same empty
    // textarea, and v1's own editor DELETES the key when the text is blank (`interact.js:620`).
    const b = board({ scratchpads: { '2026-03': '' } });
    const r = bothDoors(b);
    assert.deepEqual(r.migrate.state.scratchpads, {}, 'migration drops the key');
    assert.deepEqual(r.replace.state.scratchpads, {}, 'and so does the import — REG-23 CLOSED');
    assert.equal(r.replace.lossy, false, 'and neither calls it a loss');
    sameBoard(r, 'an empty-string scratchpad');

    // Non-vacuity: a NON-empty pad survives both doors, so this is not "pads are dropped".
    const kept = bothDoors(board({ scratchpads: { '2026-03': 'Einkaufen' } }));
    assert.deepEqual(kept.replace.state.scratchpads, { '2026-03': 'Einkaufen' });
    sameBoard(kept, 'a non-empty scratchpad');
  });

  test('REG-20…23 CLOSED: the two doors agree over the whole property corpus, not just four cases', () => {
    // Four hand-written cases prove four fixes. This proves the PROPERTY the four fixes exist to
    // establish, over every board the generator can build, so a fifth divergence introduced later
    // fails here without anybody having to think of it.
    const d = defaultState();
    for (const seed of seeds(120)) {
      const b = generateBoard(seed, { defaults: d });
      sameBoard(bothDoors(b), `corpus seed ${seed}`);
    }
  });

  test('REG-24 FAILED (held): replaceAll bar order is the IMPORTED FILE order, through the authorized fold', () => {
    // `cmpBars` is now `(_born asc, id asc)` (ATT-50) and `replace.js` writes a fresh `_born` per
    // op in emission order, so the two fixes agree — but only because `_born` is NOT enforced
    // write-once. If a later pass enforces it in `authz.js`, an import can no longer re-order the
    // board and this test is the one that says so.
    const live = board({ bars: [B('b1', '2026-05-01', '2026-05-09', 'later'), B('b2', '2026-01-01', '2026-01-09', 'earlier')] });
    const base = migrateV1(structuredClone(live), MIG);
    const az = foldAuthorized(base.ops, { me: ME, nowMs: BASE + 1000, attestVerify: () => false });
    assert.equal(az.rejected.length + az.parked.length, 0);
    assert.deepEqual(MAT(az.regs).bars.map((b) => b.id), ['b1', 'b2'], 'v1 file order after migration');

    // the SAME two bars, in the opposite file order
    const incoming = board({ bars: [B('b2', '2026-01-01', '2026-01-09', 'earlier'), B('b1', '2026-05-01', '2026-05-09', 'later')] });
    const plan = planReplaceAll(az.regs, incoming, replaceCtx());
    const az2 = foldAuthorized([...base.ops, ...plan.ops], { me: ME, nowMs: BASE + 2000, attestVerify: () => false });
    assert.equal(az2.rejected.length, 0, `the import was refused: ${JSON.stringify(az2.rejected[0] ?? {})}`);
    assert.deepEqual(MAT(az2.regs).bars.map((b) => b.id), ['b2', 'b1'],
      'the import did not re-order the board — `_born` was not re-written');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// B. FILE FORMATS — forward and backward
// ═════════════════════════════════════════════════════════════════════════════

describe('serialization compatibility', () => {
  /** A log holding one migrated board, everything folded into the checkpoint. */
  function compacted(b = board({ notes: [N('n1', '2026-03-01', 'a')], bars: [B('b1', '2026-05-01', '2026-05-09', 'x')] })) {
    const l = createOpLog({ now: () => BASE });
    const ops = migrateV1(structuredClone(b), MIG).ops;
    // With a server `seq`, so the checkpoint carries the stamp→seq index this build persists.
    let seq = 0n;
    for (const op of ops) assert.equal(l.append(op, { seq: ++seq }).status, APPEND.APPENDED);
    l.compact({ horizon: ops[ops.length - 1].ts });
    return { log: l, file: JSON.parse(JSON.stringify({ checkpoint: l.checkpoint(), tail: l.ops() })) };
  }

  test('REG-25 FAILED (held): a checkpoint written BEFORE `seqs` existed still loads', () => {
    // `checkpoint()` grew a `seqs` map in this pass (tombstone GC condition 3 needs it across a
    // relaunch). A file from a build that predates it has no such key. `load()` must treat it as
    // absent, not as corrupt — otherwise the first launch after the update refuses the board.
    const { file } = compacted();
    assert.ok(file.checkpoint.seqs && Object.keys(file.checkpoint.seqs).length > 0,
      'this build no longer writes `seqs` — REG-25 is testing nothing');
    const old = structuredClone(file);
    delete old.checkpoint.seqs;
    const l = createOpLog({ now: () => BASE });
    const regs = l.load(old);
    assert.ok(regs.size > 0, 'a pre-`seqs` checkpoint was refused');
    assert.equal(MAT(regs).notes.length, 1, 'and the board is intact');
  });

  test('REG-26 CLOSED: one damaged register is REPAIRED and reported; the board still loads', () => {
    // INVERTED. This test used to assert the defect: the previous build's `deserializeRegisters`
    // read `const op = r.op === undefined ? '' : r.op` and wrote the `''` back, so a user who ran
    // last week's build can have an op-less register on disk today — and the fix pass before this
    // one made `op` mandatory, so THIS build refused the user's whole board.v2.json over it, with
    // no partial load and no repair path.
    //
    // The safety was never in the refusal; it is in `opKey`, which ranks an unattributed write
    // ABOVE every real one so a re-delivered op cannot un-blank an ADR 004 §5.3 retraction. So the
    // door repairs instead: value, stamp and author verbatim, `op` normalised to `null`, the event
    // reported. Losing one attribution beats losing eleven years of appointments.
    const { file } = compacted(board({
      notes: [N('n1', '2026-03-01', 'a'), N('n2', '2026-04-02', 'b'), N('n3', '2026-05-03', 'c')],
      bars: [B('b1', '2026-05-01', '2026-05-09', 'x')],
      scratchpads: { '2026-03': 'Zettel' },
    }));
    const intact = createOpLog({ now: () => BASE }).load(structuredClone(file));
    const before = MAT(intact);
    assert.ok(before.notes.length === 3 && before.bars.length === 1, 'the fixture is not a board');

    for (const damage of [(r) => { delete r.op; }, (r) => { r.op = ''; }, (r) => { r.op = 'nope'; }]) {
      // ONE damaged register among many good ones — the whole point of the complaint.
      const damaged = structuredClone(file);
      const first = Object.keys(damaged.checkpoint.regs.regs)[0];
      const field = Object.keys(damaged.checkpoint.regs.regs[first])[0];
      damage(damaged.checkpoint.regs.regs[first][field]);

      const seen = [];
      const regs = deserializeRegisters(damaged.checkpoint.regs, { onRepair: (rep) => seen.push(rep) });
      assert.deepEqual(seen.map((r) => `${r.entity}.${r.field}`), [`${first}.${field}`],
        'the repair was not reported, or repaired more than the one damaged cell');
      assert.equal(regs.get(first).get(field).op, null);
      assert.equal(regs.get(first).get(field).value,
        file.checkpoint.regs.regs[first][field].value, 'the damaged register lost its VALUE');

      // Through the real door the app uses, with every other register intact.
      const log = createOpLog({ now: () => BASE });
      const loaded = log.load(damaged);
      assert.equal(loaded.size, intact.size, 'the load dropped an entity');
      assert.deepEqual(MAT(loaded), before, 'the board is not identical to the undamaged one');
    }

    // Non-vacuity in the other direction: a corrupt STAMP still refuses the file, because that
    // one really does poison `≺` for every future merge. Repair is scoped to attribution.
    const poisoned = structuredClone(file);
    const key = Object.keys(poisoned.checkpoint.regs.regs)[0];
    poisoned.checkpoint.regs.regs[key][Object.keys(poisoned.checkpoint.regs.regs[key])[0]].stamp = 'x';
    assert.throws(() => createOpLog({ now: () => BASE }).load(poisoned),
      (e) => e instanceof RegisterError && /stamp/.test(e.message));
  });

  test('REG-27 FAILED (held): forget() blanks survive checkpoint → JSON → load', () => {
    // `oplog.js:forget` writes `value: null` AT THE EXISTING STAMP, and the blank must win its
    // own (stamp, opId) tie forever. That only works if the blank carries a real OpId — which is
    // exactly what REG-26's new strictness demands of every register in the file.
    const b = board({ notes: [N('n1', '2026-03-01', 'secret')] });
    const l = createOpLog({ now: () => BASE });
    for (const op of migrateV1(structuredClone(b), MIG).ops) l.append(op);
    const m = minting(900);
    l.append(m.op('note.set', 'note:n1', { _alive: false }, { gid: pad22('g2') }));
    assert.ok(l.forget('note:n1', PERSONAL_PLACEHOLDER) > 0, 'forget purged no lines');

    const file = JSON.parse(JSON.stringify({ checkpoint: l.checkpoint(), tail: l.ops() }));
    assert.equal(file.checkpoint.regs.regs['note:n1'].text.value, null, 'the plaintext is gone from the file');
    assert.match(file.checkpoint.regs.regs['note:n1'].text.op, /^[A-Za-z0-9_-]{22}$/,
      'the blank carries no OpId — REG-26 would refuse the file this build just wrote');

    const back = createOpLog({ now: () => BASE });
    const regs = back.load(file);
    assert.equal(regs.get('note:n1').get('text').value, null, 'the retraction did not survive the reload');
  });

  test('REG-28 CLOSED (inverted): splice evidence is persisted, because it cannot be re-derived', () => {
    // `splicedIds()` is the only report that an opId arrived under two DIFFERENT bodies — ADR 002
    // §5.1 tamper evidence. `load()` used to reset it, and the losing body is not a separate line,
    // so re-appending the persisted tail could never re-detect it: after one relaunch a tampered
    // log was indistinguishable from a clean one. It now rides in `checkpoint().spliced`.
    const l = createOpLog({ now: () => BASE });
    const m = minting();
    const a = m.op('note.set', 'note:n2', { text: 'alpha' }, { id: pad22('dup') });
    const b = { ...a, f: { text: 'beta' } };
    assert.equal(l.append(a).status, APPEND.APPENDED);
    assert.equal(l.append(b).status, APPEND.CONFLICT);
    assert.deepEqual(l.splicedIds(), [pad22('dup')], 'the splice was not detected at all');

    const file = JSON.parse(JSON.stringify({ checkpoint: l.checkpoint(), tail: l.ops() }));
    const after = createOpLog({ now: () => BASE });
    after.load(file);
    assert.deepEqual(after.splicedIds(), [pad22('dup')],
      'the splice did not survive the reload — REG-28 is open again');
    // …and the registers are identical, so nothing else carries the signal either.
    assert.equal(after.registers().get('note:n2').get('text').value,
      l.registers().get('note:n2').get('text').value);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// C. THE GATES
// ═════════════════════════════════════════════════════════════════════════════

describe('the gates themselves', () => {
  test('REG-29 CLOSED (inverted): ops() is the applied set, and fold(log.ops()) is safe again', () => {
    // The A2 fix made `ops()` mean "every LINE in ops.jsonl", parked ones included — right for
    // the `{checkpoint(), ops()}` persistence pair, and a silent reversal for every other reader.
    // `fold(log.ops())` — the obvious way to rebuild a register map — became a crash, and one
    // that fires only once a sibling on a newer build sends an op this build has to park, i.e.
    // never in a test and eventually in the field.
    //
    // The persist pair got its own carrier instead of the default: the parked lines ride in
    // `checkpoint()`, with their reasons (which A2 round 2 needed anyway, since `load()` cannot
    // re-derive `epoch`), and `lines()` is the explicit "every line on disk" accessor. So neither
    // reader can get the wrong set by accident, and REG-30 below still holds.
    const l = createOpLog({ now: () => BASE });
    const m = minting();
    const good = m.op('note.set', 'note:n1', { date: '2026-03-01', text: 'hi' });
    assert.equal(l.append(good).status, APPEND.APPENDED);
    const future = { ...good, id: pad22('o99'), f: { date: '2026-03-02', sparkle: 'yes' } };
    assert.equal(l.append(future).status, APPEND.PARKED);

    assert.equal(l.ops().length, 1, 'ops() defaults to every line again — REG-29 is open');
    assert.equal(l.ops({ liveOnly: true }).length, 1);
    assert.equal(l.ops({ includeParked: false }).length, 1);
    assert.equal(l.ops({ includeParked: true }).length, 2, 'the opt-in still yields every line');
    assert.equal(l.lines().length, 2, 'lines() is the explicit persistence accessor');
    assert.equal(l.lines().find((x) => x.op.id === pad22('o99')).park, 'unknownField',
      'and it carries the park reason a bare op cannot');

    assert.doesNotThrow(() => fold(l.ops()), 'fold(log.ops()) throws again — REG-29 is open');
    assert.doesNotThrow(() => foldAll(emptyRegisters(), l.ops()));
    // Non-vacuity: the parked op really is one `fold` refuses, so the default is what saved it.
    assert.throws(() => fold(l.ops({ includeParked: true })),
      (e) => e instanceof RegisterError && /an unknown field is PARKED, never applied/.test(e.message));

    // Non-vacuity: the intended spelling works, and so does the persistence pair.
    assert.equal(MAT(fold(l.ops({ liveOnly: true }))).notes.length, 1);
    assert.equal(MAT(fold(l.ops())).notes.length, 1);
  });

  test('REG-30 FAILED (held): {checkpoint(), ops()} round-trips a parked line — the reason the default changed', () => {
    const l = createOpLog({ now: () => BASE });
    const m = minting();
    const good = m.op('note.set', 'note:n1', { date: '2026-03-01', text: 'hi' });
    l.append(good);
    const future = { ...good, id: pad22('o99'), f: { date: '2026-03-02', sparkle: 'yes' } };
    l.append(future);
    const file = JSON.parse(JSON.stringify({ checkpoint: l.checkpoint(), tail: l.ops() }));
    const back = createOpLog({ now: () => BASE });
    back.load(file);
    // Still the reason the pair has to be complete — only the carrier moved (REG-29): the parked
    // line rides in `checkpoint().parked`, so `{checkpoint(), ops()}` round-trips it either way.
    assert.equal(back.lines().length, 2, 'the parked line was lost across a relaunch (A2)');
    assert.equal(back.ops({ includeParked: true }).length, 2);
    assert.equal(back.ops({ liveOnly: true }).length, 1);
    assert.equal(back.isParked(pad22('o99')), true);
  });

  test('REG-31 FAILED (held): deleting a bar and undoing restores its ARRAY POSITION', () => {
    // `cmpBars` now sorts by `_born`, so "where does a bar sit in the array" is decided by a
    // register that undo has to restore. v1 restores the whole array by snapshot and cannot get
    // this wrong; v2 has to write `_born` back.
    let ms = BASE;
    const wall = { now: () => ms };
    const clock = createClock('MEDESKT000000000', wall.now);
    let c = 0;
    const next = () => pad22(`z${++c}`);
    const log = createOpLog({ now: wall.now });
    const stacks = createUndoStacks({
      act: ME, dev: DEV, mint: () => clock.tick(), newOpId: next, newGid: next, space: PERSONAL_PLACEHOLDER,
    });
    const live = board({ bars: [B('b1', '2026-05-01', '2026-05-10', 'one'), B('b2', '2026-01-01', '2026-01-10', 'two'), B('b3', '2026-03-01', '2026-03-10', 'three')] });
    for (const op of migrateV1(structuredClone(live), MIG).ops) log.append(op);
    const order = () => MAT(log.registers()).bars.map((b) => b.id).join(',');
    assert.equal(order(), 'b1,b2,b3', 'v1 file order — and NOT date order, which is b2,b3,b1');

    ms += 60000;
    const ctx = {
      act: ME, dev: DEV, mint: () => clock.tick(), newOpId: next, newGid: next,
      space: PERSONAL_PLACEHOLDER, regs: log.registers(), gid: next(),
    };
    const before = MAT(log.registers());
    const del = buildMutation('deleteSelected', ctx, { type: 'bar', id: 'b1' });
    const { pre, post } = captureImages(log.registers(), del, { me: ME });
    for (const op of del) assert.equal(log.append(op).status, APPEND.APPENDED);
    assert.equal(order(), 'b2,b3', 'the FIRST bar was the one deleted — the position matters');
    stacks.push(del[0].gid, 'delete', pre, post, shadowContent(before));

    ms += 60000;
    for (const op of stacks.undo(MAT(log.registers()))) log.append(op);
    assert.equal(order(), 'b1,b2,b3', 'the bar came back at the END of the array');
  });

  test('REG-32 CLOSED (inverted): the property corpus reaches every path the fix pass repaired', () => {
    // REG-32 recorded that the property suite ran over a corpus sanitised of exactly the inputs
    // that were being fixed, and named the reason it could not simply be widened:
    // `migration.test.js`'s P8 asserts EXACT losslessness, which is false by construction for a
    // board v2 cannot represent, so one ugly shape in `generateBoard` turns P8 red instead of
    // exercising the new code.
    //
    // Closed with TWO corpora rather than one. `generateBoard` stays representable and P8 keeps
    // asserting exact losslessness over it; `generateUglyBoard` is the non-representable corpus,
    // under the properties that are true when a board CANNOT be carried intact (P13 two doors one
    // board, P15 no silent loss, P16 no silent completion — `tests/property/doors.test.js`).
    //
    // What is asserted here is that the new corpus is REAL. A generator quietly sanitised back
    // into `generateBoard` would keep every property in that file green and prove nothing, which
    // is REG-32 all over again one directory away.
    const d = defaultState();
    const counts = {};
    let n = 0;
    for (const seed of seeds()) {
      n += 1;
      for (const [shape, present] of Object.entries(uglyShapesIn(generateUglyBoard(seed, { defaults: d })))) {
        counts[shape] = (counts[shape] ?? 0) + (present ? 1 : 0);
      }
    }
    const table = Object.entries(counts)
      .map(([k, v]) => `${String(v).padStart(4)}/${n}  ${((v / n) * 100).toFixed(1).padStart(5)}%  ${k}`)
      .join('\n');

    // Each of the six shapes REG-32 listed by name, plus the three the round-2 pass added.
    for (const shape of [
      'duplicate ids', 'empty categories', 'null settings', 'non-string text',
      'over-length text/label', 'unknown keys',
      'dangling categoryId', 'empty scratchpad', 'unrenderable startMonth',
    ]) {
      assert.ok(counts[shape] > 0, `the corpus never generates "${shape}"\n${table}`);
    }

    // And the gate that catches a corpus which technically contains a shape but is dominated by
    // clean boards — the state REG-32 found it in.
    const maxText = Math.max(...seeds().flatMap((seed) => generateUglyBoard(seed, { defaults: d })
      .notes.map((x) => (typeof x.text === 'string' ? x.text.length : 0))));
    assert.ok(maxText > 80, `the corpus tops out at ${maxText} characters — it cannot reach ATT-82`);

    // The CONTROL half, unchanged and still true: `generateBoard` itself is still clean, because
    // P8's losslessness statement depends on it. Widening THAT one is the mistake this test
    // exists to keep visible.
    for (const seed of seeds(100)) {
      const b = generateBoard(seed, { defaults: d });
      assert.ok(!Object.values(uglyShapesIn(b)).some(Boolean),
        `seed ${seed}: the REPRESENTABLE corpus grew an ugly shape — P8 will go red, and relaxing `
        + 'P8 is not the fix; put the shape in generateUglyBoard');
    }
  });

  test('REG-33 OPEN (accepted, needs a decision): authz and oplog resolve a SPLICE differently', () => {
    // ── AN OPEN FINDING, ASSERTED AS IT IS. Red here means somebody changed one of the two rules;
    //    read this before "repairing" it. ────────────────────────────────────────────────────────
    //
    // Two DIFFERENT op bodies arriving under ONE opId is envelope splicing (ADR 002 §5.1). Both
    // modules resolve it content-addressably, both pick the SAME body as the canonical max, and
    // both are deterministic — so the two agree on which body is the LINE. They no longer agree on
    // what happens to the LOSER:
    //
    //   · `authz.js:foldAuthorized` DROPS the losing body whole (Pass A, `candidates`), so a field
    //     only the loser carried never reaches a register.
    //   · `oplog.js:append` FOLDS every admitted body and lets `≺` decide field by field, keeping
    //     the canonical max as the retained line. This was not a preference: a resolution that
    //     un-applies a body cannot survive compaction — once a body is folded into a checkpoint
    //     the value it displaced is gone — so the fold has to be monotone or a device that
    //     compacted between the two envelopes cannot reproduce one that did not (A1).
    //
    // WHY IT IS NOT FIXED HERE, AND WHY IT IS NOT `oplog.js` THAT SHOULD MOVE:
    //
    // `oplog.js`'s rule is forced by A1 and pinned by RECHECK-A1-8. Making `authz.js` monotone
    // means routing the losing body into the pipeline as well — and that pipeline is the
    // AUTHORITY model: attestations, the admin chain, the co-edit predicate. Two bodies under one
    // opId, one of them a `member.set` granting admin, is exactly the shape an attacker would
    // reach for, and `authz.js` drops the loser for that reason. Folding it "just into the
    // registers, after admissibility" needs admissibility decided per-BODY, and an opId is the
    // key the chain links (`adminPrev`), the dedupe and the undo grouping all use. That is a
    // design decision with a security surface, and it belongs to whoever owns `authz.js` together
    // with the PO — not to an integration pass.
    //
    // WHY IT IS SAFE TO CARRY MEANWHILE: in the real pipeline `foldAuthorized` runs UPSTREAM of
    // the log, so the log never sees a body authz refused, and the two rules cannot both apply to
    // one op set. WP-3 must GUARANTEE that ordering — this test is the reason it has to be
    // written down rather than assumed.
    const m = minting(900);
    const dup = pad22('DUPBODY');
    const a = m.op('note.set', `note:${pad22('nsp')}`, { text: 'alpha', date: '2026-03-01' }, { id: dup });
    const b = m.op('note.set', `note:${pad22('nsp')}`, { text: 'beta', categoryId: 'c1' }, { id: dup });
    assert.equal(a.id, b.id, 'non-vacuity: one opId, two bodies');

    const viaAuthz = foldAuthorized([a, b], { me: ME, nowMs: BASE + 60_000, attestVerify: () => false });
    const log = createOpLog({ now: () => BASE + 60_000 });
    log.append(a); log.append(b);

    const cells = (regs) => {
      const e = regs.get(`note:${pad22('nsp')}`);
      return [...e.keys()].filter((k) => !k.startsWith('_')).sort();
    };
    // They agree on the LINE — the canonical max — which is why nothing has broken yet.
    assert.equal(log.ops().filter((o) => o.id === dup).length, 1, 'the log retains ONE body');
    assert.equal(viaAuthz.splicedIds.includes(dup), true, 'and both report the splice');
    assert.equal(log.splicedIds().includes(dup), true);

    // …and they disagree about the loser's fields. THIS is the finding.
    assert.deepEqual(cells(viaAuthz.regs), ['date', 'text'],
      'authz drops the losing body whole');
    assert.deepEqual(cells(log.registers()), ['categoryId', 'date', 'text'],
      'the log folds it — if this now matches authz, REG-33 was closed: invert it');
    assert.notDeepEqual(cells(viaAuthz.regs), cells(log.registers()),
      'REG-33 is closed — the two rules agree again. Invert this test, do not delete it.');
  });
});
