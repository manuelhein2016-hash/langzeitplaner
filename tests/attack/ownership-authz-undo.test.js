// tests/attack/ownership-authz-undo.test.js
//
// ATTACK SURFACE: story 18.4 — "⌘Z undoes MY last action, never a family member's" — and the
// promotion path that makes a co-editor's write part of what ⌘Z is looking at.
//
// ADR 001 §0.8 / rule U2 state 18.4 STRUCTURALLY: `applyRemote()` cannot reach the stacks. That
// is true and it is tested below. The attack here is the other half nobody wrote down: my ⌘Z
// does not have to *contain* your op to *erase* it.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// DISPOSITION OF THE `SUCCEEDED` ROWS IN THIS FILE — READ THIS BEFORE TRUSTING A GREEN RUN
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Every row below titled `… SUCCEEDED …` is an OPEN FINDING. It is pinned to the behaviour the
// code has TODAY, so the row is green while the defect exists. That is deliberate and it is the
// only honest way to keep a known hole visible in a passing suite — but it inverts the usual
// reading of red and green, so:
//
//     IF ONE OF THESE ROWS GOES RED, THE DEFECT WAS PROBABLY FIXED.
//     Do not "repair" the test. Invert it to assert the new, correct behaviour, and move its
//     entry in the list below from OPEN to CLOSED.
//
// THESE ARE NOT ACCEPTED BEHAVIOUR. In particular they are NOT covered by decision D7
// (DESIGN-DECISIONS.md, "ownership is structural, not server-validated"). D7's guarantee is:
//
//     "a member who patches their own client can still emit an op the others will reject —
//      but not one they will accept."
//
// Every row below emits an op the others DO accept: each honest device folds it identically and
// agrees with the attacker. So these findings BREAK D7's stated guarantee rather than falling
// under its accepted trade, and they should be read as work owed, not as a documented limit.
//
// WHY THEY ARE NOT FIXED IN THIS PASS. They are all membership-and-authority lifecycle, which is
// PLAN.md's WP-9 (Familienkreis and lifecycle: create → invite → join → member list → remove with
// rotation → leave → delete space) and, for the device-identity half, WP-6/WP-8. WP-1 is the pure
// core and has no invite, no server-validated membership and no key rotation, so there is nothing
// in this work package that could refuse them: "an outsider joins the Kreis unassisted" is not a
// regression against a join flow, it is the absence of one. Closing them inside `authz.js` alone
// would mean inventing that design without the PO, and the WP-1 fix pass was scoped to the
// convergence and v1-fidelity defects, all of which ARE closed (see the `CLOSED` rows).
//
// THE ONE CHEAP LEVER THAT ALREADY EXISTS, and the shape of the eventual answer: several of these
// are defeated by a ctx field that exists but DEFAULTS TO OFF — `ctx.genesisOpId` pins the root
// and defeats the whole A2 family (see `A2e`), `ctx.myDevices` closes B6 (see `B6b`), `opts.me`
// closes C1b, `ctx.nowMs` closes B4c. WP-1's own fix pass adopted the opposite house rule
// everywhere it touched — `tombstoneCollectable` THROWS on a missing `minPushedSeq` rather than
// defaulting to something permissive, `forget` refuses rather than assuming, `migrateV1` throws
// rather than losing data quietly. Applying that same rule to these four ctx fields is the
// obvious first move for WP-3/WP-9, and it is a wiring decision (who supplies them, and what
// solo mode does before any genesis exists) rather than a core algorithm change.
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// OPEN in this file (4 rows):
//   C1b                — WP-3 wiring. `captureImages(regs, ops, {me})` refuses a foreign op, but
//                        `me` is optional and the guard is silent when it is missing (`C1`
//                        proves it bites when supplied). Story 18.4's structural guarantee is
//                        therefore a parameter a call site can forget.
//   C2, C2b            — DESIGN, needs the PO. My ⌘Z restores a pre-image captured before a
//                        co-editor's concurrent write landed, so undoing MY action silently
//                        discards THEIRS. Story 18.4 says "⌘Z undoes MY last action, never a
//                        family member's"; it is satisfied for what the undo CONTAINS and not for
//                        what it OVERWRITES. Fixing it means per-field undo (restore only the
//                        fields this group wrote, at a fresh stamp, skipping any register a newer
//                        author has since touched) — a real change to rule U-something and to
//                        what the user is promised, not a patch.
//   C3                 — same family, from the other side: a co-editor's clear at +23 h outranks
//                        my restore, so the text is unrecoverable until the clock passes it.

import test from 'node:test';
import assert from 'node:assert/strict';

import '../helpers/env.js';
import {
  preamble, authzCtx, mctxFromFold, actor, D,
  ME, MAMA, ZORRO, FSP, PSP, T, U1, HOUR,
  reasonOf, wasAdmitted, noteById, oid22,
} from './_harness.js';

import { foldAuthorized } from '../../src/js/core/authz.js';
import { materialize } from '../../src/js/core/materialize.js';
import {
  captureImages, opsFromImage, createUndoStacks, UndoError,
} from '../../src/js/core/undo.js';
import { familyKey, noteKey } from '../../src/js/core/entities.js';
import { fmt } from '../../src/js/core/stamp.js';
import { defaultState } from '../../src/js/store.js';

const mat = (r, over) => materialize(r.regs, {
  ...mctxFromFold(r, over), defaultSettings: defaultState().settings,
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// C1 — THE STRUCTURAL GUARD. Rule U2, and the one place it is optional.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('C1 FAILED (defence holds): captureImages refuses a foreign op when `me` is supplied', () => {
  const w = preamble();
  const r = foldAuthorized(w.ops, authzCtx());
  const foreign = w.A.mama.op('note.set', noteKey(U1), { text: 'von Mama' }, { space: PSP, ms: T.now });
  assert.throws(() => captureImages(r.regs, [foreign], { me: ME }), UndoError);
});

test('C1b SUCCEEDED (latent): the same guard is OFF by default — `me` is optional', () => {
  const w = preamble();
  const r = foldAuthorized(w.ops, authzCtx());
  const foreign = w.A.mama.op('note.set', noteKey(U1), { text: 'von Mama' }, { space: PSP, ms: T.now });
  // No `opts.me` ⇒ `if (me !== undefined && …)` never fires. Another member's op is captured
  // into this device's undo images without complaint (undo.js:243).
  const img = captureImages(r.regs, [foreign]);
  assert.deepEqual(img.post, [[noteKey(U1), 'text', 'von Mama']],
    'EXPECTED FAILURE: story 18.4\'s guard is a parameter a caller can forget');
  assert.deepEqual(img.pre, [[noteKey(U1), 'text', 'Zahnarzt']]);
});

test('C1c FAILED (defence holds): family/member/space registers can never enter the stacks', () => {
  const w = preamble();
  const stacks = createUndoStacks({
    mint: () => fmt(T.now, 0, D.me.short), act: ME, dev: D.me.id, space: PSP,
    familySpaceId: FSP, shadow: false, newOpId: () => 'undoOPidxxxxxxxxxxxxxx',
    newGid: () => 'undoGIDxxxxxxxxxxxxxxx',
  });
  const famKey = familyKey('fnote', MAMA, U1);
  // Hand `push()` an image that names another member's family entity directly.
  assert.equal(stacks.push('g1', 'evil', [[famKey, 'pub.text', 'x']], [[famKey, 'pub.text', 'y']]), false,
    'undoableTriples drops every non-(note|bar|cat|pad) key, so the group is not a history event');
  assert.equal(stacks.canUndo(), false);
  assert.throws(() => opsFromImage(
    { act: ME, dev: D.me.id, gid: oid22('g'), mint: () => fmt(T.now, 0, D.me.short), newOpId: () => oid22('o'), space: PSP, familySpaceId: FSP },
    [[famKey, 'pub.text', 'x']],
  ), UndoError);
});

test('C1d FAILED (defence holds): remoteApplied() writes neither stack and never drops the redo branch', () => {
  const w = preamble();
  const r = foldAuthorized(w.ops, authzCtx());
  let n = 0;
  const stacks = createUndoStacks({
    mint: () => fmt(T.now + (n++), 0, D.me.short), act: ME, dev: D.me.id, space: PSP,
    familySpaceId: FSP, shadow: false,
    newOpId: () => oid22(`undoOP${n}`), newGid: () => oid22(`undoGID${n}`),
  });
  stacks.push(oid22('g1'), 'edit-note', [[noteKey(U1), 'text', 'Zahnarzt']], [[noteKey(U1), 'text', 'B']], null);
  stacks.undo(null);
  assert.deepEqual(stacks.size(), { undo: 0, redo: 1 });
  stacks.remoteApplied();
  stacks.remoteApplied();
  assert.deepEqual(stacks.size(), { undo: 0, redo: 1 },
    'a remote op does not clear my redo branch — rule U2');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// C2 — ⌘Z EATS A CO-EDITOR'S WRITE.
//
// The stacks never held MAMA's op, so rule U2 is satisfied to the letter. But the undo restores
// the PRE-IMAGE of MY truth register at a FRESH stamp (rule U4), and promotion is max-by-stamp
// between my truth and the co-editor's `pub.*`. A fresh stamp beats everything. So the co-editor's
// write is not undone — it is OUTVOTED, silently, by a keystroke that means "undo MY typo".
//
// I do not even have to be the one who presses it. As the attacker I only have to co-edit right
// after my victim edits: their next routine ⌘Z destroys my text with no notice and no trace.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('C2 SUCCEEDED: my ⌘Z silently discards a co-editor\'s newer write to the same field', () => {
  const w = preamble();

  // 1. I edit my own note. This is the transaction that lands on the undo stack.
  const myEdit = w.A.me.op('note.set', noteKey(U1), { text: 'Zahnarzt 9:00' },
    { space: PSP, ms: T.coedit });

  // Capture the images the way store.txn() will: from the PRE-transaction registers.
  const pre = foldAuthorized(w.ops, authzCtx());
  const img = captureImages(pre.regs, [myEdit], { me: ME });
  assert.deepEqual(img.pre, [[noteKey(U1), 'text', 'Zahnarzt']]);

  // 2. MAMA co-edits, legally, one second later. Her write is promoted onto my entry.
  const mamaEdit = w.A.mama.op('pub.set', familyKey('fnote', ME, U1),
    { 'pub.text': 'Zahnarzt 10:30 verschoben' }, { space: FSP, ms: T.coedit + 1000 });

  const mid = foldAuthorized([...w.ops, myEdit, mamaEdit], authzCtx());
  assert.equal(wasAdmitted(mid, mamaEdit), true, 'her co-edit is admissible…');
  assert.equal(noteById(mat(mid), U1).text, 'Zahnarzt 10:30 verschoben',
    '…and it is what my board shows');

  // 3. I press ⌘Z, meaning "undo my 9:00".
  let n = 0;
  const stacks = createUndoStacks({
    mint: () => fmt(T.now + (n++), 0, D.me.short), act: ME, dev: D.me.id, space: PSP,
    familySpaceId: FSP, shadow: false,
    newOpId: () => oid22(`undoOP${++n}`), newGid: () => oid22(`undoGID${n}`),
  });
  stacks.push(oid22('g1'), 'edit-note', img.pre, img.post, null);
  const inverse = stacks.undo(null);
  assert.equal(inverse.length, 1);
  assert.equal(inverse[0].act, ME, 'the inverse op is authored by me — 18.4 to the letter');

  const after = foldAuthorized([...w.ops, myEdit, mamaEdit, ...inverse], authzCtx());
  assert.equal(wasAdmitted(after, mamaEdit), true,
    'her op is still admitted — nothing rejected it…');
  assert.equal(noteById(mat(after), U1).text, 'Zahnarzt',
    'EXPECTED FAILURE: …but her text is gone from the board. One ⌘Z, one family member\'s edit erased.');
});

test('C2b SUCCEEDED: the same ⌘Z also erases the co-editor\'s move of my appointment', () => {
  const w = preamble();
  const myEdit = w.A.me.op('note.set', noteKey(U1), { date: '2026-09-11' }, { space: PSP, ms: T.coedit });
  const pre = foldAuthorized(w.ops, authzCtx());
  const img = captureImages(pre.regs, [myEdit], { me: ME });

  const mamaMove = w.A.mama.op('pub.set', familyKey('fnote', ME, U1),
    { 'pub.date': '2026-09-24' }, { space: FSP, ms: T.coedit + 1000 });
  assert.equal(noteById(mat(foldAuthorized([...w.ops, myEdit, mamaMove], authzCtx())), U1).date,
    '2026-09-24');

  let n = 0;
  const stacks = createUndoStacks({
    mint: () => fmt(T.now + (n++), 0, D.me.short), act: ME, dev: D.me.id, space: PSP,
    familySpaceId: FSP, shadow: false,
    newOpId: () => oid22(`undoOP${++n}`), newGid: () => oid22(`undoGID${n}`),
  });
  stacks.push(oid22('g1'), 'move-note', img.pre, img.post, null);
  const inverse = stacks.undo(null);
  const after = foldAuthorized([...w.ops, myEdit, mamaMove, ...inverse], authzCtx());
  assert.equal(noteById(mat(after), U1).date, '2026-09-10',
    'EXPECTED FAILURE: MAMA moved the appointment; my ⌘Z moved it back and told nobody');
});

test('C2c — the mirror case: MY undo cannot be eaten by a co-editor, because fresh stamps always win', () => {
  // Stated as the counterpart, because rule U4 claims an undo "can legitimately LOSE to a newer
  // remote change". It cannot lose to a change that already exists: `mint()` is monotone.
  const w = preamble();
  const myEdit = w.A.me.op('note.set', noteKey(U1), { text: 'A' }, { space: PSP, ms: T.coedit });
  const img = captureImages(foldAuthorized(w.ops, authzCtx()).regs, [myEdit], { me: ME });
  const mamaEdit = w.A.mama.op('pub.set', familyKey('fnote', ME, U1),
    { 'pub.text': 'B' }, { space: FSP, ms: T.coedit + 1 });
  let n = 0;
  const stacks = createUndoStacks({
    mint: () => fmt(T.now, n++, D.me.short), act: ME, dev: D.me.id, space: PSP,
    familySpaceId: FSP, shadow: false,
    newOpId: () => oid22(`undoOP${++n}`), newGid: () => oid22(`undoGID${n}`),
  });
  stacks.push(oid22('g1'), 'edit-note', img.pre, img.post, null);
  const inverse = stacks.undo(null);
  const after = foldAuthorized([...w.ops, myEdit, mamaEdit, ...inverse], authzCtx());
  assert.equal(noteById(mat(after), U1).text, 'Zahnarzt');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// C3 — THE COMPOSITE. A co-editor makes my own entry disappear from my own board, permanently.
//
// Three ingredients, each individually sanctioned:
//   · R9 / ADR 004 §5.1 — a co-editor may clear my field with an explicit `pub.text: null`
//   · ADR 001 §5 step 3 — `renderable(note)` needs a text, and a cleared one is not a text
//   · ADR 001 §1.3     — a stamp up to 24 h in the future is ADMITTED, not parked
// Together: the entry vanishes from MY board and no edit I make brings it back for a day.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('C3 SUCCEEDED: a co-editor clears my note at +23 h and I cannot get it back', () => {
  const w = preamble();
  const key = familyKey('fnote', ME, U1);
  const wipe = w.A.zorro.op('pub.set', key, { 'pub.text': null },
    { space: FSP, ms: T.now + 23 * HOUR });

  const r0 = foldAuthorized([...w.ops, wipe], authzCtx());
  assert.equal(wasAdmitted(r0, wipe), true);
  assert.equal(noteById(mat(r0), U1), null,
    'EXPECTED FAILURE: my own entry is off my own board — it is not renderable without a text');

  // I retype it. Repeatedly. At real wall time, which is 23 hours behind his stamp.
  const retype = [1, 2, 3, 4, 5].map((i) => w.A.me.op('note.set', noteKey(U1),
    { text: `Zahnarzt (Versuch ${i})` }, { space: PSP, ms: T.now + i * 60_000 }));
  const r1 = foldAuthorized([...w.ops, wipe, ...retype], authzCtx());
  assert.equal(noteById(mat(r1), U1), null,
    'EXPECTED FAILURE: five attempts to restore my own note, all outranked by one future stamp');

  // THE ONLY RECOVERY, and it is not one any UI will suggest: take the entry PRIVATE. That
  // moves the final `pub.level` off 'geteilt', which retroactively makes his clear inadmissible
  // (stage 3b reads the FINAL gov registers), and the null leaves the register map entirely.
  const retract = w.A.me.op('pub.set', key,
    { 'pub.level': 'privat', 'pub.coEdit': false }, { space: FSP, ms: T.now + 6 * 60_000 });
  const r2 = foldAuthorized([...w.ops, wipe, ...retype, retract], authzCtx());
  assert.equal(reasonOf(r2, wipe), 'noCoEdit');
  assert.equal(noteById(mat(r2), U1).text, 'Zahnarzt (Versuch 5)',
    'un-sharing is the escape hatch — the damage is bounded, but nothing tells the user that');
});

test('C3b FAILED (defence holds): an ADMIN unshare does NOT blank my note (INV-R3, withdrawnByOther)', () => {
  const w = preamble();
  // The narrow deviation the implementer documented in registers.js:withdrawnByOther. Confirm it.
  const key = familyKey('fnote', ME, U1);
  const unshare = w.A.papa.op('pub.set', key, {
    'pub.level': 'privat', 'pub.coEdit': null, 'pub.alive': null,
    'pub.date': null, 'pub.text': null, 'pub.repeatsYearly': null,
  }, { space: FSP, ms: T.now });
  const r = foldAuthorized([...w.ops, unshare], authzCtx());
  assert.equal(wasAdmitted(r, unshare), true, 'PAPA is the admin, so the unshare is admissible');
  assert.equal(noteById(mat(r), U1).text, 'Zahnarzt',
    'my own board still tells me the truth — the entry is unshared, not blanked');
});
