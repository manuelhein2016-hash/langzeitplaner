// tests/attack/recheck-att82-silent-loss.test.js
//
// SECOND ADVERSARY PASS against the ATT-82 fix (a v1 board carrying more than a v2 register can
// hold must not lose the user's entry, and must not do it silently).
//
// The fix is real where it was applied. `migrateV1` truncates `str40`/`str80` instead of dropping
// them, discovers the limit from the real constructor, reports the exact characters it cut, and
// REFUSES TO RETURN AT ALL unless the caller acknowledged the loss. The `CONTROL` tests pin that.
//
// It was applied to one of the two doors. `replace.js` — which shipped in the same pass — is the
// other door into the same registers (story 11.3 import and story 11.5 snapshot restore), it
// reads the same v1 file shape, and on the same input it does the opposite of everything above:
//
//   · a 209-character note text is DROPPED, not truncated, so the note loses its `text`,
//     fails ADR 001 §5 step 3's renderability check and VANISHES FROM THE BOARD — which is the
//     exact sentence `migrate1to2.js` uses to justify the truncation it does: "the user's note
//     did not get shorter on upgrade day, it disappeared. That is the single worst thing in this
//     file's blast radius";
//   · `replaceAllOps()` — the entry point `ops.contract.js` §9 declares — returns `.ops` and
//     discards `warnings` and `lossy`, so nothing is obliged to read them. That is verbatim the
//     defect MigrationLossyError was created to eliminate, one file away: "a boolean nobody is
//     obliged to read is not a safety mechanism."
//
// And one gap in `migrateV1` itself: it has no unknown-top-level-key check, while `replace.js`
// has `KNOWN_BOARD_KEYS`. A v1 board with a section v2 does not know is discarded by migration
// with `lossy: false` and no warning — on the one path where the original file is gone afterwards.
//
// ROUND 2 — EVERY HOLE IN THIS FILE IS CLOSED, and each test below is inverted rather than
// deleted, so the closure is what is asserted.
//
// The fix is not "truncate in replace.js too". It is that the two doors were never two doors:
// v1's `store.replaceAll(next)` is `this.state = migrate(next)` (`store.js:194`), one function,
// so every place where `migrate1to2.js` and `replace.js` answered the same bytes differently was
// a v2 regression with no v1 behind it. `truncateToFit` is now IMPORTED by `replace.js` rather
// than reimplemented, `replaceAllOps` refuses to complete silently exactly as `migrateV1` does,
// and `migrateV1` reports unknown top-level sections exactly as `replace.js` does. Shared code
// is the only form of "the two doors agree" that cannot drift.

import test from 'node:test';
import assert from 'node:assert/strict';

import { migrateV1, MigrationLossyError } from '../../src/js/core/migrate1to2.js';
import { planReplaceAll, replaceAllOps, ReplaceLossyError } from '../../src/js/core/replace.js';
import { materialize } from '../../src/js/core/materialize.js';
import { foldAll } from '../../src/js/core/registers.js';
import { fmt } from '../../src/js/core/stamp.js';
import { BASE_MS, DEV, ME, PSP, pad22 } from './_kit.js';

const CAT = Object.freeze({ id: 'cat-1', name: 'Arbeit', nameEn: 'Work', paletteRef: 'blau', visible: true });
const board = (o) => ({ schemaVersion: 1, categories: [CAT], notes: [], bars: [], scratchpads: {}, settings: {}, ...o });

const migCtx = { memberId: ME, deviceId: DEV.meDesk.id, personalSpaceId: PSP };
const replaceCtx = () => {
  let n = 0;
  return {
    mint: () => fmt(BASE_MS + (++n), 0, DEV.meDesk.short),
    me: ME, deviceId: DEV.meDesk.id, personalSpaceId: PSP,
    gid: pad22('G'), newOpId: () => pad22(`R${n}`),
  };
};
const mctx = { me: ME, familySpaceId: null, members: new Map(), currentMembers: new Set(), prefs: {}, lastSeenSeq: {} };
const boardFrom = (ops) => materialize(foldAll(new Map(), ops), mctx);

// v1's 80 is a DOM `maxLength` (interact.js:466, popover.js:146). A file has never been bound by
// it, and a board that predates the attribute, or was hand-edited, or came through an import,
// legitimately holds this.
const LONG = `Zahnarzt Dr. Weber ${'x'.repeat(190)}`;      // 209 characters
const LONG_BAR = `Sommerferien ${'y'.repeat(80)}`;         // 93 characters
const EMOJI = '\u{1F600}'.repeat(60);                      // 60 emoji = 120 UTF-16 units

// ─────────────────────────────────────────────────────────────────────────────
// RECHECK-82-1 — HOLE. The import door loses the note the migration door saves.
// ─────────────────────────────────────────────────────────────────────────────

test('RECHECK-82-1 — CLOSED: an imported note with a long text is truncated, exactly as migration truncates it', () => {
  const b = board({ notes: [{ id: 'n1', date: '2026-09-10', text: LONG, categoryId: 'cat-1', repeatsYearly: false }] });

  // The migration door: truncated, in place, on the right day.
  const migrated = migrateV1(b, { ...migCtx, acceptLossy: true });
  const migNote = boardFrom(migrated.ops).notes;
  assert.equal(migNote.length, 1, 'non-vacuity: migration keeps the note');
  assert.equal(migNote[0].text.length, 80);
  assert.equal(migNote[0].date, '2026-09-10');

  // The import door: the same file, the same registers, and now the same note.
  const ops = replaceAllOps(new Map(), b, { ...replaceCtx(), acceptLossy: true });
  const noteOp = ops.find((o) => o.e === 'note:n1');
  assert.equal(noteOp.f.text.length, 80, 'CLOSED: truncated, not dropped');
  assert.equal(noteOp.f.text, migNote[0].text, 'and cut at exactly the same character');
  const imported = boardFrom(ops).notes;
  assert.equal(imported.length, 1, 'CLOSED: the note is on the board');
  assert.equal(imported[0].date, '2026-09-10', 'on the right day');
  assert.deepEqual(
    { text: imported[0].text, date: imported[0].date },
    { text: migNote[0].text, date: migNote[0].date },
    'the two doors produce the same entry for the same bytes',
  );
});

test('RECHECK-82-2 — CLOSED: replaceAllOps() refuses to complete silently, exactly as migrateV1 does', () => {
  const b = board({ notes: [{ id: 'n1', date: '2026-09-10', text: LONG, categoryId: 'cat-1', repeatsYearly: false }] });

  const plan = planReplaceAll(new Map(), b, replaceCtx());
  assert.equal(plan.lossy, true, 'non-vacuity: the plan DOES know');
  assert.match(plan.warnings.join('\n'), /TRUNCATED, not dropped/s);

  // The contract-declared entry point. It can no longer lose 129 characters in silence.
  let err = null;
  try { replaceAllOps(new Map(), b, replaceCtx()); } catch (e) { err = e; }
  assert.ok(err instanceof ReplaceLossyError, 'CLOSED: it throws rather than returning a flag');
  assert.ok(err.plan.ops.length > 0, 'and nothing is discarded — the whole plan is on the error');
  assert.match(err.message, /TRUNCATED, not dropped/, 'the message says what was lost');

  // The symmetry that was the point: the SAME loss, one file away, is the same refusal.
  assert.throws(() => migrateV1(b, migCtx), MigrationLossyError);

  // And both doors have the same two ways to say "I know, proceed".
  assert.ok(replaceAllOps(new Map(), b, { ...replaceCtx(), acceptLossy: true }).length > 0);
  let seen = null;
  assert.ok(replaceAllOps(new Map(), b, { ...replaceCtx(), onLossy: (p) => { seen = p; } }).length > 0);
  assert.equal(seen.lossy, true, 'onLossy receives the plan, not a boolean');
});

test('RECHECK-82-3 — CLOSED: an imported bar keeps its dates AND its name', () => {
  const b = board({ bars: [{ id: 'b1', startDate: '2026-07-01', endDate: '2026-08-31', label: LONG_BAR, categoryId: 'cat-1' }] });
  const migrated = boardFrom(migrateV1(b, { ...migCtx, acceptLossy: true }).ops).bars;
  assert.equal(migrated[0].label.length, 40, 'non-vacuity: migration truncates to 40');

  const imported = boardFrom(replaceAllOps(new Map(), b, { ...replaceCtx(), acceptLossy: true })).bars;
  assert.equal(imported.length, 1);
  assert.equal(imported[0].label.length, 40, 'CLOSED: the bar keeps its name, shortened');
  assert.equal(imported[0].label, migrated[0].label, 'the same 40 characters as the other door');
});

test('RECHECK-82-4 — CLOSED: 60 emoji survives BOTH doors, cut at the same character', () => {
  const b = board({ notes: [{ id: 'n2', date: '2026-09-10', text: EMOJI, categoryId: 'cat-1', repeatsYearly: false }] });
  const mig = boardFrom(migrateV1(b, { ...migCtx, acceptLossy: true }).ops).notes;
  assert.equal(mig.length, 1);
  assert.equal([...mig[0].text].length, 40, 'migration cuts on a character, not through a surrogate pair');
  const imp = boardFrom(replaceAllOps(new Map(), b, { ...replaceCtx(), acceptLossy: true })).notes;
  assert.equal(imp.length, 1, 'CLOSED: the imported emoji note is on the board');
  assert.equal([...imp[0].text].length, 40, 'and import cuts on a character, not through a surrogate pair');
  assert.equal(imp[0].text, mig[0].text, 'byte-identical to the migration door');
});

test('RECHECK-82-5 — CLOSED: a SNAPSHOT RESTORE no longer clears what it cannot represent', () => {
  // Story 11.5. The user restores yesterday's snapshot; `replaceAllOps` builds the transaction.
  // The board it replaces is overwritten by the result, so the note is unrecoverable.
  const existing = replaceAllOps(new Map(), board({
    notes: [{ id: 'n1', date: '2026-09-10', text: 'Zahnarzt', categoryId: 'cat-1', repeatsYearly: false }],
  }), replaceCtx());
  const regs = foldAll(new Map(), existing);
  assert.equal(boardFrom(existing).notes.length, 1, 'non-vacuity: there is a board to lose');

  const snapshot = board({ notes: [{ id: 'n1', date: '2026-09-10', text: LONG, categoryId: 'cat-1', repeatsYearly: false }] });
  const restore = replaceAllOps(regs, snapshot, { ...replaceCtx(), acceptLossy: true });
  const noteOp = restore.find((o) => o.e === 'note:n1');
  assert.equal(noteOp.f.text.length, 80,
    'CLOSED: the restore writes 80 characters, it does not CLEAR the register');
  const after = boardFrom([...existing, ...restore]).notes;
  assert.equal(after.length, 1, 'CLOSED: after the restore the note is still on the board');
  assert.equal(after[0].text, LONG.slice(0, 80));
});

// ─────────────────────────────────────────────────────────────────────────────
// RECHECK-82-6 — HOLE in migrateV1 itself: a whole top-level section, discarded in silence.
// ─────────────────────────────────────────────────────────────────────────────

test('RECHECK-82-6 — CLOSED: migrateV1 reports unknown top-level keys, and refuses to finish quietly', () => {
  const b = board({ holidays: { '2026-12-25': 'Weihnachten' }, customLayers: [{ name: 'Urlaub' }] });

  // No acceptLossy, no onLossy: it no longer returns. Two whole sections are about to be
  // discarded on the one path where the original file stops being the board afterwards.
  let err = null;
  try { migrateV1(b, { ...migCtx }); } catch (e) { err = e; }
  assert.ok(err instanceof MigrationLossyError, 'CLOSED: it refuses to complete silently');
  const r = err.result;
  assert.equal(r.lossy, true);
  assert.deepEqual(
    r.report.losses.filter((l) => l.reason === 'unknown-section').map((l) => l.field).sort(),
    ['customLayers', 'holidays'],
    'both sections are in the structured report, with the value the user had',
  );
  assert.equal(r.report.losses.find((l) => l.field === 'holidays').value['2026-12-25'], 'Weihnachten',
    'and the discarded content itself is recoverable from the report');
  assert.ok(r.warnings.some((w) => /holidays/.test(w)), r.warnings.join(' | '));

  // The symmetry that was the point: the other door says the same thing about the same bytes.
  const plan = planReplaceAll(new Map(), b, replaceCtx());
  assert.equal(plan.lossy, true);
  assert.match(plan.warnings.join('\n'), /unknown top-level key "holidays"/);
  assert.match(r.warnings.join('\n'), /unknown top-level key "holidays"/);

  // Non-vacuity: a board with only the SEVEN known keys is not lossy on either door.
  assert.doesNotThrow(() => migrateV1(board({}), { ...migCtx }));
  assert.equal(planReplaceAll(new Map(), board({}), replaceCtx()).lossy, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLS — the ATT-82 fix, where it was applied. Each fails against the pre-fix module.
// ─────────────────────────────────────────────────────────────────────────────

test('RECHECK-82-7 — CONTROL: migrateV1 will not complete silently on a lossy board', () => {
  const b = board({ notes: [{ id: 'n1', date: '2026-09-10', text: LONG, categoryId: 'cat-1', repeatsYearly: false }] });
  let err = null;
  try { migrateV1(b, migCtx); } catch (e) { err = e; }
  assert.ok(err instanceof MigrationLossyError, 'it throws rather than returning a flag');
  assert.ok(err.result.ops.length > 0, 'and nothing is discarded — the ops are on the error');
  const cut = err.report.losses.find((l) => l.field === 'text');
  assert.equal(cut.reason, 'truncated');
  assert.equal(cut.kept + cut.dropped, LONG, 'the exact characters cut are recoverable');
});

test('RECHECK-82-8 — CONTROL: unlimited `str` fields lose nothing on either door', () => {
  // `cat.name`, `cat.nameEn`, `pad.text` are `t:"str"` — no length bound, so a v1 board that
  // holds a 5 000-character scratchpad or a 500-character category name loses nothing.
  const b = board({
    categories: [CAT, { id: 'c2', name: 'z'.repeat(500), nameEn: 'z', paletteRef: 'gruen', visible: true }],
    scratchpads: { '2026-09': 'p'.repeat(5000) },
  });
  const mig = migrateV1(b, { ...migCtx, acceptLossy: true });
  assert.equal(mig.lossy, false);
  const st = boardFrom(replaceAllOps(new Map(), b, replaceCtx()));
  assert.equal(st.categories.find((c) => c.id === 'c2').name.length, 500);
  assert.equal(st.scratchpads['2026-09'].length, 5000);
});
